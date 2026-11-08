'use strict';
const vscode = require('vscode');
const path = require('path');
const fsp = require('fs/promises');
const os = require('os');
const { execFile } = require('child_process');
const { buildHtml } = require('./html');
const core = require('./core/svgcore');
const { validateWebviewMessage, isGzip, gunzipCapped } = require('./core/protocol');
const { createRatingPrompt } = require('./rate');
const { registerSupport, commandUris, showLinks } = require('./support');

const EDITOR_VIEW = 'svgViewer.editor'; // .svg, "Reopen With" (text stays the default)
const SVGZ_VIEW = 'svgViewer.svgz'; // .svgz, the default editor (it is gzip, not text)
const PREVIEW_VIEW = 'svgViewer.preview'; // side preview next to the text editor
const EXT_ID = 'zovo.svg-viewer';
const BG_KEY = 'svgViewer.background.v1';
const HEAD_BYTES = 64 * 1024;
const SVG_EXT = /\.svgz?$/i;

let rating = { success() {}, failure() {} };
const previews = new Map(); // uri string -> Viewer (side previews only)

function settings() {
  const c = vscode.workspace.getConfiguration('svgViewer');
  return {
    maxFileMB: c.get('maxFileMB', 50),
    defaultBackground: c.get('defaultBackground', 'checker'),
    mouseWheel: c.get('mouseWheel', 'zoom'),
    autoOpen: c.get('preview.autoOpen', false),
  };
}

function isSvgUri(uri) { return !!uri && SVG_EXT.test(uri.path); }
const isSvgz = (uri) => /\.svgz$/i.test(uri.path);

function openTextDocument(uri) {
  const key = uri.toString();
  return vscode.workspace.textDocuments.find((d) => d.uri.toString() === key);
}

/** Read up to n bytes from the start of a local file without reading the rest. */
async function readHead(uri, n) {
  if (uri.scheme !== 'file') return null;
  let fh;
  try {
    fh = await fsp.open(uri.fsPath, 'r');
    const buf = Buffer.alloc(n);
    const { bytesRead } = await fh.read(buf, 0, n, 0);
    return buf.subarray(0, bytesRead);
  } catch { return null; } finally { if (fh) await fh.close().catch(() => {}); }
}

/** Put a PNG on the system clipboard with the operating system's own tool. Used when the webview clipboard
 * API is refused. Local only: a temp file, one local process, then the temp file is deleted. */
async function copyPngToClipboard(data) {
  const file = path.join(os.tmpdir(), `svg-viewer-clip-${process.pid}-${Date.now()}.png`);
  await fsp.writeFile(file, data);
  const run = (cmd, args, input) => new Promise((resolve, reject) => {
    const p = execFile(cmd, args, { timeout: 20000, windowsHide: true }, (err) => (err ? reject(err) : resolve()));
    if (input) { p.stdin.end(input); }
  });
  try {
    if (process.platform === 'darwin') {
      await run('osascript', ['-e', `set the clipboard to (read (POSIX file ${JSON.stringify(file)}) as «class PNGf»)`]);
    } else if (process.platform === 'win32') {
      const ps = `Add-Type -AssemblyName System.Windows.Forms; Add-Type -AssemblyName System.Drawing; $i = [System.Drawing.Image]::FromFile('${file.replace(/'/g, "''")}'); [System.Windows.Forms.Clipboard]::SetImage($i); $i.Dispose()`;
      await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-Command', ps]);
    } else {
      try { await run('wl-copy', ['--type', 'image/png'], data); } catch { await run('xclip', ['-selection', 'clipboard', '-t', 'image/png', '-i', file]); }
    }
  } finally { await fsp.rm(file, { force: true }).catch(() => {}); }
}

/** One webview showing one SVG: a custom editor tab or a side preview. */
class Viewer {
  constructor(context, panel, uri, kind) {
    this.context = context; this.panel = panel; this.uri = uri; this.kind = kind;
    this.disposed = false; this.ready = false; this.allowLarge = false; this.counted = false; this.failed = false;
    this.lastBytes = null; this.timer = null; this.version = 0; this.subs = [];
    this.name = path.posix.basename(uri.path);
    this.setup();
  }

  post(m) { return this.disposed ? Promise.resolve(false) : this.panel.webview.postMessage(m); }

  setup() {
    const { panel, context } = this;
    const media = vscode.Uri.joinPath(context.extensionUri, 'media');
    const src = vscode.Uri.joinPath(context.extensionUri, 'src', 'core');
    panel.webview.options = { enableScripts: true, localResourceRoots: [media, src], enableCommandUris: commandUris('svgViewer') };
    panel.webview.html = buildHtml({
      cspSource: panel.webview.cspSource,
      coreUri: panel.webview.asWebviewUri(vscode.Uri.joinPath(src, 'svgcore.js')).toString(),
      scriptUri: panel.webview.asWebviewUri(vscode.Uri.joinPath(media, 'main.js')).toString(),
      styleUri: panel.webview.asWebviewUri(vscode.Uri.joinPath(media, 'webview.css')).toString(),
      title: this.name,
      showSupportLinks: showLinks(vscode, 'svgViewer'),
    });
    this.subs.push(panel.webview.onDidReceiveMessage((raw) => this.onMessage(raw)));
    // Disk changes: generated files that are rewritten, or deleted and written again, update the view.
    const dir = this.uri.with({ path: path.posix.dirname(this.uri.path) });
    try {
      const w = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(dir, this.name));
      this.subs.push(w, w.onDidChange(() => this.schedule(120)), w.onDidCreate(() => this.schedule(120)), w.onDidDelete(() => this.schedule(300)));
    } catch { /* virtual file systems without watching: edits in the editor still update */ }
    // Edits in an open text editor update the picture before you save.
    this.subs.push(vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document.uri.toString() === this.uri.toString() && e.contentChanges.length) this.schedule(200);
    }));
    this.subs.push(vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('svgViewer.mouseWheel')) this.post({ type: 'settings', mouseWheel: settings().mouseWheel });
    }));
    panel.onDidDispose(() => this.dispose());
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    clearTimeout(this.timer);
    for (const s of this.subs) { try { s.dispose(); } catch { /* ignore */ } }
    if (this.kind === 'preview' && previews.get(this.uri.toString()) === this) previews.delete(this.uri.toString());
  }

  schedule(ms) {
    if (!this.ready) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.load().catch((e) => this.post({ type: 'error', message: String(e && e.message || e) })); }, ms);
  }

  background() {
    const saved = this.context.workspaceState.get(BG_KEY);
    if (saved && typeof saved.mode === 'string') return saved;
    return { mode: settings().defaultBackground, color: '#ffffff' };
  }

  /** Get the bytes to draw: the open editor text (with unsaved edits) or the file on disk. */
  async load() {
    const v = ++this.version;
    const s = settings();
    const doc = !isSvgz(this.uri) ? openTextDocument(this.uri) : null;
    let bytes, size, source;
    if (doc && (doc.isDirty || doc.isUntitled)) {
      bytes = new TextEncoder().encode(doc.getText());
      size = bytes.length; source = 'editor';
    } else {
      let stat;
      try { stat = await vscode.workspace.fs.stat(this.uri); } catch {
        if (v === this.version) await this.post({ type: 'deleted', name: this.name });
        return;
      }
      size = stat.size; source = 'disk';
      const plan = core.sizePlan(size, s.maxFileMB);
      if (plan.mode === 'refuse' || (plan.mode === 'ask' && !this.allowLarge)) {
        const head = await readHead(this.uri, HEAD_BYTES);
        const info = head && !isGzip(head) ? core.rootInfo(Buffer.from(head).toString('utf8')) : null;
        if (v === this.version) await this.post({ type: 'tooLarge', name: this.name, size, sizeText: core.fmtSize(size), limitMB: plan.limitMB, refuse: plan.mode === 'refuse', info });
        return;
      }
      try { bytes = await vscode.workspace.fs.readFile(this.uri); } catch (e) {
        if (v === this.version) await this.post({ type: 'deleted', name: this.name, message: String(e && e.message || e) });
        return;
      }
    }
    if (isGzip(bytes)) {
      const capMB = this.allowLarge ? core.HARD_LIMIT_MB : Math.min(s.maxFileMB, core.HARD_LIMIT_MB);
      const r = await gunzipCapped(bytes, capMB * core.MB);
      if (r.error) {
        if (r.tooLarge && !this.allowLarge) {
          if (v === this.version) await this.post({ type: 'tooLarge', name: this.name, size, sizeText: `${core.fmtSize(size)} packed, over ${capMB} MB unpacked`, limitMB: capMB, refuse: false, info: null });
        } else if (v === this.version) await this.post({ type: 'error', message: r.error });
        return;
      }
      bytes = r.bytes;
    }
    if (v !== this.version) return; // a newer change is already on its way
    this.lastBytes = bytes;
    // A plain Uint8Array on its own ArrayBuffer (not a pooled Node Buffer), so the webview gets real bytes.
    const plain = new Uint8Array(bytes.byteLength);
    plain.set(bytes);
    await this.post({ type: 'content', bytes: plain, size, unpacked: bytes.length, source, version: v, svgz: isSvgz(this.uri) });
  }

  async onMessage(raw) {
    const r = validateWebviewMessage(raw);
    if (!r.ok) return;
    const msg = r.msg;
    try {
      switch (msg.type) {
        case 'ready': {
          this.ready = true;
          const s = settings();
          await this.post({ type: 'init', name: this.name, uri: this.uri.toString(), kind: this.kind, background: this.background(), mouseWheel: s.mouseWheel, maxFileMB: s.maxFileMB });
          await this.load();
          return;
        }
        case 'renderLarge': this.allowLarge = true; await this.load(); return;
        case 'rendered':
          if (msg.ok) { if (!this.counted) { this.counted = true; rating.success(); } }
          else if (!this.counted && !this.failed) { this.failed = true; rating.failure(); }
          return;
        case 'background':
          await this.context.workspaceState.update(BG_KEY, { mode: msg.mode, color: msg.color || '#ffffff' });
          for (const v of allViewers()) if (v !== this) v.post({ type: 'background', background: this.background() });
          return;
        case 'copyText':
          await vscode.env.clipboard.writeText(msg.text);
          await this.post({ type: 'notice', text: `Copied ${msg.what || 'to the clipboard'}.` });
          return;
        case 'copyDataUri': {
          if (!this.lastBytes) return;
          const uri = 'data:image/svg+xml;base64,' + Buffer.from(this.lastBytes).toString('base64');
          await vscode.env.clipboard.writeText(uri);
          await this.post({ type: 'notice', text: `Copied a data URI (${core.fmtSize(uri.length)}).` });
          return;
        }
        case 'openSource':
          if (isSvgz(this.uri)) { await this.post({ type: 'notice', text: '.svgz files are gzip data; there is no text to show.' }); return; }
          await vscode.window.showTextDocument(this.uri, { viewColumn: this.kind === 'preview' ? vscode.ViewColumn.One : vscode.ViewColumn.Active, preview: false });
          return;
        case 'copyPng':
          try {
            await copyPngToClipboard(msg.data);
            await this.post({ type: 'notice', text: `Copied a ${msg.w} \u00d7 ${msg.h} PNG to the clipboard.` });
          } catch (e) {
            await this.post({ type: 'notice', text: `Copy PNG did not work here (${e && e.message ? e.message.split('\n')[0] : e}). Use Save PNG instead.`, error: true });
          }
          return;
        case 'savePng': {
          const folder = this.uri.with({ path: path.posix.dirname(this.uri.path) });
          const target = await vscode.window.showSaveDialog({
            defaultUri: vscode.Uri.joinPath(folder, msg.name), filters: { 'PNG image': ['png'] }, saveLabel: 'Save PNG',
          });
          if (!target) { await this.post({ type: 'saved', cancelled: true }); return; }
          if (target.toString() === this.uri.toString() || !/\.png$/i.test(target.path)) {
            await this.post({ type: 'notice', text: 'Choose a file name that ends in .png. The SVG file is never overwritten.', error: true });
            return;
          }
          await vscode.workspace.fs.writeFile(target, msg.data);
          await this.post({ type: 'saved', path: target.scheme === 'file' ? target.fsPath : target.toString(), bytes: msg.data.length });
          return;
        }
        default:
      }
    } catch (e) {
      await this.post({ type: 'error', message: e && e.message ? e.message : String(e) });
    }
  }
}

const editors = new Set();
function allViewers() { return [...editors, ...previews.values()]; }

class SvgEditorProvider {
  constructor(context) { this.context = context; }
  openCustomDocument(uri) { return { uri, dispose() {} }; }
  async resolveCustomEditor(document, panel) {
    const v = new Viewer(this.context, panel, document.uri, 'editor');
    editors.add(v);
    panel.onDidDispose(() => editors.delete(v));
  }
}

function targetUri(arg) {
  if (arg instanceof vscode.Uri) return arg;
  const ed = vscode.window.activeTextEditor;
  if (ed && isSvgUri(ed.document.uri)) return ed.document.uri;
  const tab = vscode.window.tabGroups && vscode.window.tabGroups.activeTabGroup.activeTab;
  const input = tab && tab.input;
  if (input && input.uri && isSvgUri(input.uri)) return input.uri;
  return null;
}

function showPreview(context, uri, column, preserveFocus) {
  const key = uri.toString();
  const existing = previews.get(key);
  if (existing) { existing.panel.reveal(column, preserveFocus); return existing; }
  const panel = vscode.window.createWebviewPanel(PREVIEW_VIEW, `Preview ${path.posix.basename(uri.path)}`, { viewColumn: column, preserveFocus },
    { enableScripts: true, retainContextWhenHidden: true });
  return attachPreview(context, panel, uri);
}

function attachPreview(context, panel, uri) {
  panel.iconPath = vscode.Uri.joinPath(context.extensionUri, 'media', 'preview-icon.svg');
  const v = new Viewer(context, panel, uri, 'preview');
  previews.set(uri.toString(), v);
  return v;
}

function activate(context) {
  rating = createRatingPrompt({ vscode, context, extensionId: EXT_ID, section: 'svgViewer', name: 'SVG Viewer' });
  registerSupport({ vscode, context, prefix: 'svgViewer', selfId: EXT_ID });
  const provider = new SvgEditorProvider(context);
  const opts = { supportsMultipleEditorsPerDocument: true, webviewOptions: { retainContextWhenHidden: true } };
  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(EDITOR_VIEW, provider, opts),
    vscode.window.registerCustomEditorProvider(SVGZ_VIEW, provider, opts),
    vscode.window.registerWebviewPanelSerializer(PREVIEW_VIEW, {
      async deserializeWebviewPanel(panel, state) {
        let uri = null;
        try { uri = state && typeof state.uri === 'string' ? vscode.Uri.parse(state.uri, true) : null; } catch { uri = null; }
        if (!uri || !isSvgUri(uri)) { panel.dispose(); return; }
        attachPreview(context, panel, uri);
      },
    }),
    vscode.commands.registerCommand('svgViewer.showPreviewToSide', (arg) => {
      const uri = targetUri(arg);
      if (!uri) { vscode.window.showInformationMessage('Open an .svg file first, then run "SVG Viewer: Open Preview to the Side".'); return; }
      showPreview(context, uri, vscode.ViewColumn.Beside, true);
    }),
    vscode.commands.registerCommand('svgViewer.showPreview', (arg) => {
      const uri = targetUri(arg);
      if (!uri) { vscode.window.showInformationMessage('Open an .svg file first, then run "SVG Viewer: Open Preview".'); return; }
      showPreview(context, uri, vscode.ViewColumn.Active, false);
    }),
    vscode.commands.registerCommand('svgViewer.openInViewer', async (arg) => {
      const uri = targetUri(arg);
      if (uri) await vscode.commands.executeCommand('vscode.openWith', uri, isSvgz(uri) ? SVGZ_VIEW : EDITOR_VIEW);
    }),
    vscode.commands.registerCommand('svgViewer.openSource', async (arg) => {
      const uri = targetUri(arg);
      if (uri && !isSvgz(uri)) await vscode.commands.executeCommand('vscode.openWith', uri, 'default');
    }),
    vscode.commands.registerCommand('svgViewer.openWalkthrough', () =>
      vscode.commands.executeCommand('workbench.action.openWalkthrough', `${EXT_ID}#svgViewer.start`, false)),
    vscode.window.onDidChangeActiveTextEditor((ed) => {
      if (!ed || !settings().autoOpen) return;
      const uri = ed.document.uri;
      if (/\.svg$/i.test(uri.path) && !previews.has(uri.toString())) showPreview(context, uri, vscode.ViewColumn.Beside, true);
    }),
  );
  const ed = vscode.window.activeTextEditor;
  if (ed && settings().autoOpen && /\.svg$/i.test(ed.document.uri.path)) showPreview(context, ed.document.uri, vscode.ViewColumn.Beside, true);
}

function deactivate() {}

module.exports = { activate, deactivate, EDITOR_VIEW, SVGZ_VIEW, PREVIEW_VIEW, EXT_ID };
