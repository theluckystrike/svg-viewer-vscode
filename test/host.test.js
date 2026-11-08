'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const P = require('../src/core/protocol.js');
const { buildHtml } = require('../src/html.js');
const pkg = require('../package.json');

const ROOT = path.join(__dirname, '..');

test('webview messages: only known types with checked fields pass', () => {
  assert.equal(P.validateWebviewMessage(null).ok, false);
  assert.equal(P.validateWebviewMessage({ type: 'eval', code: 'x' }).ok, false);
  assert.deepEqual(P.validateWebviewMessage({ type: 'ready', extra: 1 }).msg, { type: 'ready' });
  assert.deepEqual(P.validateWebviewMessage({ type: 'background', mode: 'custom', color: '#12abef' }).msg, { type: 'background', mode: 'custom', color: '#12abef' });
  assert.equal(P.validateWebviewMessage({ type: 'background', mode: 'url(x)' }).ok, false);
  assert.equal(P.validateWebviewMessage({ type: 'background', mode: 'white', color: 'red;x' }).msg.color, '');
  assert.equal(P.validateWebviewMessage({ type: 'copyText', text: 'x'.repeat(100001) }).ok, false);
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
  assert.equal(P.validateWebviewMessage({ type: 'savePng', data: png, name: 'a@2x.png' }).msg.name, 'a@2x.png');
  assert.equal(P.validateWebviewMessage({ type: 'savePng', data: png, name: '../../etc/passwd' }).msg.name, 'image.png');
  assert.equal(P.validateWebviewMessage({ type: 'savePng', data: new Uint8Array(10), name: 'a.png' }).ok, false);
  assert.deepEqual(P.validateWebviewMessage({ type: 'copyPng', data: png, w: '12', h: 3.7 }).msg, { type: 'copyPng', data: png, w: 12, h: 3 });
  assert.equal(P.validateWebviewMessage({ type: 'copyPng', data: 'x' }).ok, false);
});

test('.svgz: unpacks, and stops a small file that unpacks to more than the cap', async () => {
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"/>');
  const gz = zlib.gzipSync(svg);
  assert.ok(P.isGzip(gz));
  assert.ok(!P.isGzip(svg));
  const ok = await P.gunzipCapped(gz, 1024 * 1024);
  assert.equal(Buffer.from(ok.bytes).toString(), svg.toString());
  const bomb = zlib.gzipSync(Buffer.alloc(8 * 1024 * 1024, 0x20)); // 8 MB of spaces, about 8 KB packed
  assert.ok(bomb.length < 20000);
  const r = await P.gunzipCapped(bomb, 1024 * 1024);
  assert.ok(r.tooLarge, JSON.stringify(r));
  const bad = await P.gunzipCapped(Buffer.from([0x1f, 0x8b, 1, 2, 3]), 1024);
  assert.ok(bad.error && !bad.tooLarge);
});

test('webview HTML: strict CSP, nonce scripts, no remote origin anywhere', () => {
  const html = buildHtml({ cspSource: 'vscode-webview://abc', coreUri: 'vscode-webview://abc/core.js', scriptUri: 'vscode-webview://abc/main.js', styleUri: 'vscode-webview://abc/a.css', title: 'x"<y>.svg', nonce: 'NONCE' });
  const csp = /content="([^"]+)"/.exec(html)[1];
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /script-src 'nonce-NONCE'(;|$)/);
  assert.match(csp, /img-src vscode-webview:\/\/abc blob: data:/);
  assert.doesNotMatch(csp, /connect-src|unsafe-inline|unsafe-eval|https?:/);
  assert.equal((html.match(/<script nonce="NONCE"/g) || []).length, 2);
  assert.ok(html.includes('<title>x&quot;&lt;y&gt;.svg</title>'));
});

test('no network code in the shipped sources', () => {
  const files = ['src/extension.js', 'src/html.js', 'src/core/svgcore.js', 'src/core/protocol.js', 'media/main.js'];
  for (const f of files) {
    const s = fs.readFileSync(path.join(ROOT, f), 'utf8');
    assert.doesNotMatch(s, /\bfetch\(|XMLHttpRequest|WebSocket|require\(['"](https?|net|tls|dgram|dns)['"]\)|innerHTML|insertAdjacentHTML|document\.write|eval\(|new Function/, f);
  }
});

test('child processes: only the clipboard tools, with execFile (no shell)', () => {
  const s = fs.readFileSync(path.join(ROOT, 'src/extension.js'), 'utf8');
  assert.doesNotMatch(s, /\bexec\(|execSync|spawn\(|shell:\s*true/);
  const cmds = [...s.matchAll(/run\('([^']+)'/g)].map((m) => m[1]).sort();
  assert.deepEqual(cmds, ['osascript', 'powershell.exe', 'wl-copy', 'xclip']);
  for (const f of ['src/html.js', 'src/core/svgcore.js', 'src/core/protocol.js', 'media/main.js']) {
    assert.doesNotMatch(fs.readFileSync(path.join(ROOT, f), 'utf8'), /child_process/, f);
  }
});

test('package: phrase words in the name, .svg opens as text by default, .svgz in the viewer, engines floor', () => {
  const name = pkg.displayName.toLowerCase();
  for (const phrase of ['svg viewer', 'svg preview', 'svg']) for (const w of phrase.split(' ')) assert.ok(name.includes(w), w);
  const eds = pkg.contributes.customEditors;
  assert.equal(eds.find((e) => e.viewType === 'svgViewer.editor').priority, 'option');
  assert.equal(eds.find((e) => e.viewType === 'svgViewer.svgz').priority, 'default');
  // OVX1 floor (out/OVX1-engine.txt): ^1.90.0, never above ^1.109.0
  assert.equal(pkg.engines.vscode, '^1.90.0');
  assert.equal(pkg.main, './src/extension.js');
  for (const c of pkg.contributes.commands) assert.match(c.command, /^svgViewer\./);
  assert.ok(pkg.contributes.configuration.properties['svgViewer.askForRating']);
  assert.ok(pkg.contributes.configuration.properties['svgViewer.showSupportLinks']);
  assert.ok(fs.existsSync(path.join(ROOT, pkg.icon)));
  for (const s of pkg.contributes.walkthroughs[0].steps) {
    const m = s.media.image || s.media.markdown;
    assert.ok(fs.existsSync(path.join(ROOT, m)), m);
  }
});

test('the .vsix keeps src and media, and leaves out tests, samples and scripts', () => {
  const ign = fs.readFileSync(path.join(ROOT, '.vscodeignore'), 'utf8').split('\n').map((l) => l.trim());
  for (const x of ['test/**', 'samples/**', 'scripts/**']) assert.ok(ign.includes(x), x);
  assert.ok(!ign.includes('src/**') && !ign.includes('media/**'));
});
