// Release check in a real VS Code: installs the .vsix into an isolated profile, opens the sample files, drives the
// webview with real mouse and key events through the debug port, records every network request and dialog, and
// saves screenshots and a JSON report.
// usage: node scripts/e2e-vscode.mjs <work> <port> <vsix> <workspaceDir> <shotDir> <outJson> [rewriteSeconds]
import { launch, installVsix, sleep } from './vsc.mjs';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execSync, spawn } from 'node:child_process';

const [work0, port, vsix, ws0, shotDir, outJson, rw = '60'] = process.argv.slice(2);
const work = path.resolve(work0), ws = path.resolve(ws0);
const here = path.dirname(new URL(import.meta.url).pathname);
const R = { install: null, steps: [], console: [], hashes: {}, unchanged: null, requests: [], dialogs: [] };
const hash = f => crypto.createHash('sha1').update(fs.readFileSync(f)).digest('hex');
for (const f of fs.readdirSync(ws)) if (/\.svgz?$/.test(f)) R.hashes[f] = hash(path.join(ws, f));
fs.rmSync(path.join(work, 'ud'), { recursive: true, force: true });
R.install = installVsix(work, vsix);
const clipBefore = (() => { try { return execSync('pbpaste', { encoding: 'utf8' }); } catch { return null; } })();
const vs = await launch(work, Number(port), ws, {
  'files.simpleDialog.enable': true, 'workbench.secondarySideBar.defaultVisibility': 'hidden', 'workbench.auxiliaryBar.visible': false,
  'window.titleBarStyle': 'custom', 'workbench.sideBar.location': 'left', 'editor.minimap.enabled': false, 'workbench.editor.enablePreview': false,
  'editor.fontSize': 13, 'files.autoSave': 'off',
});
const shots = [];
const shot = async name => { const f = path.join(shotDir, `svg-${String(shots.length + 1).padStart(2, '0')}-${name}.png`); await vs.shot(f); shots.push(f); return f; };
const step = async (name, fn) => {
  const t0 = Date.now();
  try { const v = await fn(); R.steps.push({ name, ok: v !== false, value: v, ms: Date.now() - t0 }); console.log('PASS', name); }
  catch (e) { R.steps.push({ name, ok: false, error: String(e.message || e).slice(0, 800), ms: Date.now() - t0 }); console.log('FAIL', name, String(e.message || e).slice(0, 300)); try { await shot('FAIL-' + name.replace(/\W+/g, '_').slice(0, 40)); } catch {} }
};
let wv;
const E = expr => vs.wvEval(wv, expr);
const probe = async () => JSON.parse(await E(`JSON.stringify(window.svgViewerProbe ? window.svgViewerProbe() : null)`));
const getWv = async title => vs.waitFor(async () => (await vs.webviews()).find(w => w.title === title && w.w > 0), 20000);
const loaded = async (ms = 30000) => {
  const ok = await vs.waitFor(async () => (await probe())?.loaded, ms, 200);
  if (!ok) throw new Error('not loaded: ' + JSON.stringify(await probe()));
  await sleep(250); return probe();
};
const btn = t => `[...document.querySelectorAll('button')].find(b => b.textContent === ${JSON.stringify(t)} || b.textContent.startsWith(${JSON.stringify(t + ' (')}))`;
const select = async (label, value) => { await E(`(() => { const s = document.querySelector('select[aria-label=${JSON.stringify(label)}]'); s.value = ${JSON.stringify(value)}; s.dispatchEvent(new Event('change')); return 1; })()`); await sleep(400); };
const stagePt = async (fx, fy) => { const off = await vs.wvOffset(); const b = JSON.parse(await E(`JSON.stringify(document.querySelector('.stage').getBoundingClientRect())`)); return { x: off.x + b.x + b.width * fx, y: off.y + b.y + b.height * fy, sx: b.width * fx, sy: b.height * fy }; };
const wheel = async (x, y, dy, modifiers = 0) => { await vs.s.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY: dy, modifiers }, vs.wb); await sleep(60); };
const mouse = (type, x, y, extra = {}) => vs.s.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1, ...extra }, vs.wb);
const activeEditorKind = () => vs.wbEval(`(() => { const g = document.querySelector('.editor-group-container.active'); if (!g) return 'none'; if (g.querySelector('.monaco-editor .view-lines')) return 'text'; if (g.querySelector('.webview, iframe')) return 'webview'; return 'other'; })()`);
const tabTitles = () => vs.wbEval(`[...document.querySelectorAll('.tabs-container .tab')].map(t => t.getAttribute('aria-label') || t.textContent.trim())`);
// VS Code opens .svg in its built-in Image Preview. openFile keeps that default; openText reopens the file as text.
const openFile = async (file) => { vs.open(path.join(ws, file)); await vs.waitFor(async () => (await vs.wbEval(`document.title`)).includes(file), 15000); await sleep(1000); };
const openText = async (file) => {
  await openFile(file);
  for (let i = 0; i < 3 && await activeEditorKind() !== 'text'; i++) {
    await vs.command('View: Reopen Editor With Text Editor');
    await vs.waitFor(async () => (await activeEditorKind()) === 'text', 6000); await sleep(400);
  }
};
const previewSide = async (file) => {
  for (let i = 0; i < 3; i++) {
    await vs.command('SVG Viewer: Open Preview to the Side');
    wv = await vs.waitFor(async () => (await vs.webviews()).find(w => w.title === file && w.w > 0), 10000);
    if (wv) return wv;
  }
  throw new Error('no preview webview for ' + file);
};
const closeAll = async () => {
  const dirty = await vs.wbEval(`document.querySelectorAll('.tabs-container .tab.dirty').length`);
  if (dirty) throw new Error('a file was changed by the test; stop before any save prompt');
  await vs.command('View: Close All Editors'); await sleep(600);
};
const userAt = (p, sx, sy) => ({ x: (sx - p.view.x) / p.view.zoom, y: (sy - p.view.y) / p.view.zoom });
const pngDims = f => { const h = fs.readFileSync(f).subarray(0, 24); return { w: h.readUInt32BE(16), h: h.readUInt32BE(20), bytes: fs.statSync(f).size }; };
const clip = () => { try { return execSync('pbpaste', { encoding: 'utf8' }); } catch { return ''; } };
const saveDialog = async (target) => {
  await vs.waitFor(() => vs.wbEval(`!!document.querySelector('.quick-input-widget input') && document.querySelector('.quick-input-widget').style.display !== 'none'`), 8000);
  const ib = JSON.parse(await vs.wbEval(`JSON.stringify(document.querySelector('.quick-input-widget input').getBoundingClientRect())`));
  await vs.click(ib.x + ib.width / 2, ib.y + ib.height / 2); await vs.key('a', 'KeyA', 4, 65); await vs.type(target);
  await sleep(300); await vs.key('Enter', 'Enter');
  return vs.waitFor(() => fs.existsSync(target) && fs.statSync(target).size > 100, 30000, 300);
};

let rewriter = null;
try {
  await sleep(2500);
  await step('the default editor for .svg is unchanged (VS Code\'s own); the editor title button opens the preview beside the text; fit on open', async () => {
    await openFile('w3c-shapes-rect-01-t.svg');
    const defaultTitle = await vs.wbEval(`(document.querySelector('.tabs-container .tab.active') || {}).title || ''`);
    const defaultKind = await activeEditorKind();
    const ourPreviewAsDefault = !!(await vs.webviews()).find(w => w.title === 'w3c-shapes-rect-01-t.svg');
    await openText('w3c-shapes-rect-01-t.svg');
    const kind = await activeEditorKind();
    const titleBtn = await vs.wbEval(`!![...document.querySelectorAll('.editor-actions .action-label')].find(a => /Open Preview to the Side/.test(a.getAttribute('aria-label') || a.title || ''))`);
    if (!titleBtn) throw new Error('no editor title button');
    await vs.wbEval(`[...document.querySelectorAll('.editor-actions .action-label')].find(a => /Open Preview to the Side/.test(a.getAttribute('aria-label') || a.title || '')).click() || 1`);
    wv = await getWv('w3c-shapes-rect-01-t.svg'); if (!wv) throw new Error('no preview after the title button');
    const p = await loaded();
    const s = await stagePt(1, 1);
    // fitted: the picture fills the stage on one axis with a 16 px padding, centred on the other
    const fitW = Math.abs(p.pic.width - (s.sx - 32)) < 2, fitH = Math.abs(p.pic.height - (s.sy - 32)) < 2;
    if (ourPreviewAsDefault || kind !== 'text' || !(fitW || fitH) || p.W !== 480 || p.H !== 360) throw new Error(JSON.stringify({ defaultKind, ourPreviewAsDefault, kind, p, s }));
    await shot('w3c-shapes-preview-beside');
    return { defaultEditorOnOpen: defaultKind + ' (VS Code built-in Image Preview, unchanged)', titleButton: titleBtn, afterReopenAsText: kind, size: `${p.W}x${p.H}`, zoom: +p.view.zoom.toFixed(3), status: p.status };
  });
  await step('wheel zooms at the pointer and drag pans, also together (wheel while dragging)', async () => {
    const p0 = await probe();
    const a = await stagePt(0.3, 0.4);
    const u0 = userAt(p0, a.sx, a.sy);
    for (let i = 0; i < 5; i++) await wheel(a.x, a.y, -120);
    await sleep(200);
    const p1 = await probe(); const u1 = userAt(p1, a.sx, a.sy);
    const driftPx = Math.hypot(u1.x - u0.x, u1.y - u0.y) * p1.view.zoom;
    if (!(p1.view.zoom > p0.view.zoom * 1.5) || driftPx > 3) throw new Error(JSON.stringify({ p0: p0.view, p1: p1.view, u0, u1 }));
    // press, move, wheel while the button is down, move, release
    await mouse('mouseMoved', a.x, a.y, { buttons: 0 }); await mouse('mousePressed', a.x, a.y);
    await mouse('mouseMoved', a.x + 60, a.y + 40); await sleep(80);
    await wheel(a.x + 60, a.y + 40, -120);
    await mouse('mouseMoved', a.x + 120, a.y + 80); await mouse('mouseReleased', a.x + 120, a.y + 80); await sleep(200);
    const p2 = await probe();
    const moved = p2.view.x !== p1.view.x && p2.view.y !== p1.view.y;
    if (!moved || !(p2.view.zoom > p1.view.zoom)) throw new Error(JSON.stringify({ p1: p1.view, p2: p2.view }));
    await vs.wvClick(wv, btn('Fit')); await sleep(200);
    const p3 = await probe();
    return { zoomBefore: +p0.view.zoom.toFixed(3), zoomAfterWheel: +p1.view.zoom.toFixed(3), pointUnderCursorDriftPx: +driftPx.toFixed(2), zoomWhileDragging: +p2.view.zoom.toFixed(3), panned: [Math.round(p2.view.x - p1.view.x), Math.round(p2.view.y - p1.view.y)], fitAgain: +p3.view.zoom.toFixed(3) };
  });
  await step('live edit: typing in the source updates the preview before saving', async () => {
    const p0 = await probe();
    const before = /([\d,]+) elements/.exec(p0.status)[1];
    // focus the text editor (left group), find </svg> and type a circle in front of it
    await vs.command('View: Focus First Editor Group');
    await vs.key('f', 'KeyF', 4, 70); await sleep(300); await vs.type('</svg>'); await sleep(300);
    await vs.key('Escape', 'Escape'); await sleep(200); await vs.key('ArrowLeft', 'ArrowLeft'); await sleep(200);
    const r0 = p0.renders;
    await vs.type('<circle cx="240" cy="180" r="40" fill="#ff00ff"/>');
    const ok = await vs.waitFor(async () => { const p = await probe(); return /unsaved edits/.test(p.status) && p.status; }, 8000);
    // the closing </svg> comes before our circle when End lands after it, so look for any change in the count
    await sleep(800);
    const p1 = await probe();
    const after = /([\d,]+) elements/.exec(p1.status)[1];
    const magenta = JSON.parse(await E(`JSON.stringify(window.svgViewerPixel(0.5, 0.5))`));
    await shot('live-edit-unsaved');
    await vs.command('File: Revert File'); await sleep(800);
    const p2 = await probe();
    if (!ok || Number(after) !== Number(before) + 1 || p1.banner || !(p1.renders > r0) || !(magenta[0] > 200 && magenta[1] < 60 && magenta[2] > 200)) throw new Error(JSON.stringify({ before, after, status: p1.status, banner: p1.banner, magenta }));
    return { elementsBefore: before, elementsWhileEditing: after, statusWhileEditing: p1.status.split('\n')[0], afterRevert: /([\d,]+) elements/.exec(p2.status)[1] };
  });
  await step('background: black is kept after a window reload, and so are zoom and position', async () => {
    await select('Background', 'black'); await sleep(500);
    const a = await stagePt(0.5, 0.5);
    for (let i = 0; i < 3; i++) await wheel(a.x - 40, a.y - 30, -120);
    await sleep(300);
    const p0 = await probe();
    await shot('background-black-before-reload');
    await vs.command('Developer: Reload Window');
    await sleep(6000);
    await vs.attachWorkbench();
    wv = await getWv('w3c-shapes-rect-01-t.svg');
    if (!wv) throw new Error('preview not restored after reload: ' + JSON.stringify((await vs.webviews()).map(w => w.title)));
    const p1 = await loaded();
    if (p1.bg !== 'black' || Math.abs(p1.view.zoom - p0.view.zoom) > 1e-6 || Math.abs(p1.view.x - p0.view.x) > 2 || Math.abs(p1.view.y - p0.view.y) > 2) throw new Error(JSON.stringify({ before: [p0.bg, p0.view], after: [p1.bg, p1.view] }));
    await shot('background-black-after-reload');
    return { bg: p1.bg, zoomBefore: p0.view.zoom, zoomAfter: p1.view.zoom, xy: [Math.round(p1.view.x), Math.round(p1.view.y)] };
  });
  await step('viewBox outline on the offset sample matches the viewBox; shapes outside it show dimmed', async () => {
    await select('Background', 'checker');
    await closeAll();
    await openText('viewbox-offset.svg'); await previewSide('viewbox-offset.svg'); await loaded();
    await vs.wvClick(wv, btn('viewBox')); await sleep(600);
    const p = await probe();
    // viewBox -200 -150 400 300 in a 400 x 300 viewport: the outline is the whole viewport
    const exp = { left: p.view.x, top: p.view.y, width: 400 * p.view.zoom, height: 300 * p.view.zoom };
    const okBox = ['left', 'top', 'width', 'height'].every(k => Math.abs(p.vbox[k] - exp[k]) < 1);
    const okPic = Math.abs(p.pic.width - 400 * 1.5 * p.view.zoom) < 1 && Math.abs(p.pic.left - (p.view.x - 100 * p.view.zoom)) < 1;
    // the blue rectangle runs from x 150 to 270, past the right edge (200): its outside part is drawn in the margin
    const outside = await E(`JSON.stringify(window.svgViewerPixel(1.1, 0.5))`);
    const inside = await E(`JSON.stringify(window.svgViewerPixel(0.5, 0.5))`);
    const label = await E(`document.querySelector('.vblabel').textContent`);
    await shot('viewbox-outline-offset');
    const o = JSON.parse(outside), i = JSON.parse(inside);
    if (!okBox || !okPic || !(o[2] > 150 && o[0] < 120) || !(i[0] > 200 && i[1] > 120 && i[2] < 100)) throw new Error(JSON.stringify({ p, exp, o, i }));
    return { vbox: p.vbox, expected: exp, label, pixelOutsideViewBox: o, pixelCentre: i };
  });
  await step(`rewritten every second for ${rw} s (deletes, torn writes): preview follows, no error`, async () => {
    await vs.wvClick(wv, btn('viewBox'));
    await closeAll();
    const f = path.join(ws, 'generated.svg');
    fs.writeFileSync(f, '<svg xmlns="http://www.w3.org/2000/svg" width="300" height="150"><rect width="300" height="150" fill="#ccc"/></svg>\n');
    await openText('generated.svg'); await previewSide('generated.svg'); await loaded();
    rewriter = spawn(process.execPath, [path.join(here, 'rewrite-loop.mjs'), f, rw], { stdio: 'ignore' });
    const samples = [];
    const t0 = Date.now();
    while (Date.now() - t0 < Number(rw) * 1000 + 1500) { await sleep(5000); const p = await probe(); samples.push({ t: Math.round((Date.now() - t0) / 1000), renders: p.renders, notice: p.notice, banner: p.banner.slice(0, 60) }); }
    await sleep(1500);
    const p = await probe();
    await shot('generated-file-followed');
    rewriter = null;
    const errors = vs.console.filter(c => c.type !== 'warning' && /svg|webview/i.test(c.where + c.text) && !/copilot/i.test(c.text));
    if (p.renders < Number(rw) * 0.6 || p.notice || /could not be drawn|not on disk/.test(p.banner)) throw new Error(JSON.stringify({ renders: p.renders, notice: p.notice, banner: p.banner, samples }));
    return { renders: p.renders, seconds: Number(rw), finalBanner: p.banner, errors: errors.length, samples };
  });
  await step('18 MB world map: opens, Save PNG 2x writes a 3840 px wide PNG, Copy PNG puts a PNG on the clipboard', async () => {
    await closeAll();
    await openText('physical-world-map-2021.svg');
    const t0 = Date.now(); await previewSide('physical-world-map-2021.svg'); const p = await loaded(90000); const openMs = Date.now() - t0;
    const a = await stagePt(0.52, 0.35);
    for (let i = 0; i < 6; i++) await wheel(a.x, a.y, -120);
    await sleep(2500);
    await shot('world-map-zoomed');
    await vs.wvClick(wv, btn('Fit')); await sleep(500);
    await select('PNG size', '2');
    // Copy PNG, then read the clipboard type and size with AppleScript
    execSync('pbcopy', { input: 'before-copy' });
    await vs.wvClick(wv, btn('Copy PNG'));
    let copyToast = '';
    const info = await vs.waitFor(async () => {
      const t = await E(`document.querySelector('.toast').hidden ? '' : document.querySelector('.toast').textContent`); if (/Copied|Copy PNG/.test(t)) copyToast = t;
      const c = execSync(`osascript -e 'clipboard info'`, { encoding: 'utf8' }); return /PNGf/.test(c) && c;
    }, 90000, 500);
    let clipPng = null;
    if (info) {
      const out = path.join(work, 'clipboard.png');
      execSync(`osascript -e 'set f to open for access POSIX file "${out}" with write permission' -e 'set eof f to 0' -e 'write (the clipboard as «class PNGf») to f' -e 'close access f'`);
      clipPng = pngDims(out);
    }
    const target = path.join(work, 'world-map@2x.png'); fs.rmSync(target, { force: true });
    await vs.wvClick(wv, btn('Save PNG'));
    const saved = await saveDialog(target);
    if (!saved) throw new Error('no PNG written');
    await sleep(1000);
    const dims = pngDims(target);
    if (dims.w !== 3840 || dims.h !== Math.round(972.6 * 2) || !clipPng || clipPng.w !== 3840) throw new Error(JSON.stringify({ dims, info, clipPng, copyToast }));
    return { openMs, drawMs: p.ms, size: p.status.split('\n')[0], savedPng: dims, clipboardPng: clipPng, copyToast, clipboardInfo: String(info).trim().slice(0, 120) };
  });
  await step('52.5 MB map: size message first (only 64 KB read), renders after Render it', async () => {
    await closeAll();
    vs.open(path.join(ws, 'cia-political-world-map-2021.svg'));
    await sleep(4000);
    await previewSide('cia-political-world-map-2021.svg');
    const n = await vs.waitFor(async () => { const p = await probe(); return p.notice && p; }, 20000);
    if (!n || !/over the 50 MB limit/.test(n.notice) || n.loaded) throw new Error(JSON.stringify(n));
    await shot('large-file-message');
    const t0 = Date.now();
    await vs.wvClick(wv, btn('Render it'));
    const p = await loaded(120000);
    await sleep(1500);
    await shot('large-file-rendered');
    return { notice: n.notice.slice(0, 200), renderMs: Date.now() - t0, status: p.status.split('\n')[0] };
  });
  await step('Material sprite: the symbol grid shows every symbol; a click copies the <use> line', async () => {
    await closeAll();
    await openText('material-sprite-action-symbol.svg'); await previewSide('material-sprite-action-symbol.svg');
    const p = await vs.waitFor(async () => { const q = await probe(); return q.tiles > 0 && q; }, 20000);
    await sleep(1500);
    const drawn = await E(`[...document.querySelectorAll('.tile img')].filter(i => i.complete && i.naturalWidth > 0).length`);
    await shot('sprite-grid');
    execSync('pbcopy', { input: 'x' });
    await vs.wvClick(wv, `document.querySelector('.tile[data-id="ic_3d_rotation_24px"]')`); await sleep(800);
    const c = clip();
    await E(`(() => { const i = document.querySelector('.symhead input'); i.value = 'delete'; i.dispatchEvent(new Event('input')); return 1; })()`);
    const filtered = await E(`document.querySelector('.symcount').textContent`);
    if (!p || p.symbols !== 215 || p.tiles !== 215 || c !== '<use href="#ic_3d_rotation_24px"/>' || !p.symbolsOpen) throw new Error(JSON.stringify({ p, c }));
    return { symbols: p.symbols, tiles: p.tiles, tilesDrawnInView: drawn, clipboard: c, filter: filtered };
  });
  await step('hostile-script.svg: no dialog, no network request, scripts listed as blocked', async () => {
    await closeAll();
    const req0 = vs.requests.length, dlg0 = vs.dialogs.length;
    await openText('hostile-script.svg'); await previewSide('hostile-script.svg'); const p = await loaded();
    const a = await stagePt(0.5, 0.5); await vs.click(a.x, a.y); await mouse('mouseMoved', a.x + 10, a.y + 10, { buttons: 0 });
    await sleep(2500);
    const reqs = vs.requests.slice(req0).filter(r => /example\.com/.test(r.url) || (/^(https?|wss?|ftp):/.test(r.url) && !/^https:\/\/[^/]*vscode-cdn\.net\//.test(r.url)));
    const dlgs = vs.dialogs.slice(dlg0);
    await shot('hostile-script-blocked');
    if (reqs.length || dlgs.length || !/Blocked: 2 scripts, 4 event handlers, 1 foreignObject/.test(p.status)) throw new Error(JSON.stringify({ reqs, dlgs, status: p.status }));
    return { status: p.status.split('\n')[0], requestsToRemote: reqs.length, dialogs: dlgs.length };
  });
  await step('hostile-entities.svg (billion laughs): no freeze, a plain message', async () => {
    await closeAll();
    await openText('hostile-entities.svg'); await previewSide('hostile-entities.svg');
    const t0 = Date.now();
    const p = await vs.waitFor(async () => { const q = await probe(); return (q.loaded || q.notice) && q; }, 20000);
    const t1 = Date.now(); await E('1+1'); const pingMs = Date.now() - t1;
    await shot('hostile-entities');
    if (!p || pingMs > 1000) throw new Error(JSON.stringify({ p, pingMs }));
    return { ms: Date.now() - t0, pingMs, drawn: p.loaded, notice: p.notice.slice(0, 160), banner: p.banner };
  });
  await step('hostile-huge-size.svg (100,000,000 px): fits, 1:1 is capped, no freeze', async () => {
    await closeAll();
    await openText('hostile-huge-size.svg'); await previewSide('hostile-huge-size.svg'); const p = await loaded();
    await vs.wvClick(wv, btn('1:1')); await sleep(800);
    const q = await probe();
    const t1 = Date.now(); await E('1+1'); const pingMs = Date.now() - t1;
    if (p.W !== 1e8 || !(q.view.zoom * 1e8 <= 200001) || pingMs > 1000) throw new Error(JSON.stringify({ p: p.view, q: q.view, pingMs }));
    return { fitZoom: p.view.zoom, zoomAfter1to1: q.view.zoom, drawnLongSidePx: Math.round(q.view.zoom * 1e8), pingMs };
  });
  await step('hostile-bomb.svgz (600 MB unpacked): stopped at the cap, plain message, no crash', async () => {
    await closeAll();
    vs.open(path.join(ws, 'hostile-bomb.svgz'));
    wv = await getWv('hostile-bomb.svgz');
    if (!wv) throw new Error('no viewer for the .svgz (should be the default editor)');
    const n = await vs.waitFor(async () => { const p = await probe(); return p.notice && p; }, 20000);
    await vs.wvClick(wv, btn('Render it'));
    const m = await vs.waitFor(async () => { const p = await probe(); return /larger than 400 MB/.test(p.notice) && p; }, 30000);
    await shot('hostile-bomb');
    if (!n || !m) throw new Error(JSON.stringify({ n, m }));
    return { first: n.notice.slice(0, 120), afterRender: m.notice };
  });
  await step('badge.svgz opens in the viewer by default (custom editor)', async () => {
    await closeAll();
    vs.open(path.join(ws, 'badge.svgz'));
    wv = await getWv('badge.svgz'); if (!wv) throw new Error('no viewer');
    const p = await loaded();
    return { size: `${p.W}x${p.H}`, status: p.status.split('\n')[0] };
  });
  await step('"Reopen Editor With..." > SVG Viewer works for .svg', async () => {
    await closeAll();
    await openFile('flag-of-brazil.svg'); wv = null;
    const k0 = await activeEditorKind();
    const isOurs = !!(await vs.webviews()).find(w => w.title === 'flag-of-brazil.svg');
    for (let i = 0; i < 4 && !wv; i++) {
      await vs.command('View: Reopen Editor With...'); await sleep(700);
      await vs.type('SVG Viewer'); await sleep(500);
      const ok = await vs.wbEval(`(() => { const w = document.querySelector('.quick-input-widget'); const r = w && w.style.display !== 'none' && [...w.querySelectorAll('.monaco-list-row')].map(x => x.getAttribute('aria-label') || '').join('|'); return !!r && /SVG Viewer/.test(r); })()`);
      if (!ok) { await vs.key('Escape', 'Escape'); await sleep(1000); continue; }
      await vs.key('Enter', 'Enter');
      wv = await vs.waitFor(async () => (await vs.webviews()).find(w => w.title === 'flag-of-brazil.svg' && w.w > 0), 10000);
    }
    if (!wv) throw new Error('no viewer');
    const p = await loaded();
    await shot('reopen-with-svg-viewer');
    if (isOurs) throw new Error('SVG Viewer took over the default editor');
    return { firstEditor: k0 + ' (VS Code default)', size: `${p.W}x${p.H}`, status: p.status.split('\n')[0] };
  });
  await step('prefers-color-scheme: Scheme dark and light change the drawn colours', async () => {
    await closeAll();
    await openText('color-scheme.svg'); await previewSide('color-scheme.svg'); await loaded();
    const visible = await E(`!document.querySelector('select[aria-label="Colour scheme"]').hidden`);
    await select('Colour scheme', 'dark'); await sleep(600);
    const d = JSON.parse(await E(`JSON.stringify(window.svgViewerPixel(0.9, 0.9))`));
    await shot('color-scheme-dark');
    await select('Colour scheme', 'light'); await sleep(600);
    const l = JSON.parse(await E(`JSON.stringify(window.svgViewerPixel(0.9, 0.9))`));
    if (!visible || !(d[0] < 60 && d[2] < 80) || !(l[0] > 240 && l[1] > 240)) throw new Error(JSON.stringify({ visible, d, l }));
    return { dark: d, light: l };
  });
  for (const f of ['w3c-painting-stroke-01-t.svg', 'w3c-struct-symbol-01-b.svg', 'w3c-pservers-grad-01-b.svg', 'w3c-coords-viewattr-01-b.svg', 'material-sprite-navigation-symbol.svg', 'no-viewbox.svg', 'one-pixel.svg']) {
    await step(`${f} opens and draws`, async () => {
      await closeAll();
      await openText(f); await previewSide(f);
      const p = f.startsWith('material') ? await vs.waitFor(async () => { const q = await probe(); return q.tiles > 0 && q; }, 20000) : await loaded();
      if (!p || p.notice) throw new Error(JSON.stringify(p));
      return { size: `${p.W}x${p.H}`, zoom: p.view ? +p.view.zoom.toFixed(3) : null, symbols: p.symbols, status: p.status.split('\n')[0] };
    });
  }
  await step('light theme: toolbar and status follow the VS Code theme', async () => {
    await closeAll();
    const colours = () => E(`JSON.stringify({ toolbar: getComputedStyle(document.querySelector('.toolbar')).backgroundColor, text: getComputedStyle(document.body).color, light: document.body.classList.contains('vscode-light') })`);
    await openText('w3c-pservers-grad-01-b.svg'); await previewSide('w3c-pservers-grad-01-b.svg'); await loaded();
    const dark = JSON.parse(await colours());
    await vs.setSetting('workbench.colorTheme', 'Default Light Modern');
    const light = JSON.parse(await vs.waitFor(async () => { const c = JSON.parse(await colours()); return c.light && JSON.stringify(c); }, 15000) || await colours());
    await shot('light-theme');
    await vs.setSetting('workbench.colorTheme', 'Default Dark Modern');
    const lum = (c) => { const m = c.match(/\d+/g).map(Number); return (m[0] + m[1] + m[2]) / 3; };
    if (dark.light || !light.light || !(lum(light.text) < 100 && lum(dark.text) > 150) || !(lum(light.toolbar) > lum(dark.toolbar))) throw new Error(JSON.stringify({ dark, light }));
    return { dark, light };
  });
} finally {
  if (rewriter) try { rewriter.kill(); } catch {}
  R.requests = vs.requests.filter(r => !/^(vscode-|data:|blob:|devtools:|chrome-extension:)/.test(r.url) && !/^https:\/\/[^/]*vscode-cdn\.net\//.test(r.url));
  R.webviewRemoteRequests = vs.requests.filter(r => /webview|vscode-cdn/.test(r.where) && /^https?:/.test(r.url) && !/vscode-cdn\.net|vscode-resource/.test(r.url));
  R.dialogs = vs.dialogs;
  R.console = vs.console.filter(c => !/copilot|CloudSandboxApi|LESS API|reading 'selection'|ERR_NAME_NOT_RESOLVED.*(update|marketplace)/i.test(c.text));
  R.logErrors = [];
  for (const f of vs.extHostLogs()) { const t = fs.readFileSync(f, 'utf8'); for (const l of t.split('\n')) if (/\[error\]/.test(l) && /svg|zovo/i.test(l)) R.logErrors.push(l.slice(0, 300)); }
  await vs.close();
  if (clipBefore !== null) try { execSync('pbcopy', { input: clipBefore }); } catch {}
  try { fs.rmSync(path.join(ws, 'generated.svg'), { force: true }); } catch {}
  R.unchanged = Object.entries(R.hashes).every(([f, h]) => hash(path.join(ws, f)) === h);
  R.shots = shots;
  fs.writeFileSync(outJson, JSON.stringify(R, null, 1));
  console.log(JSON.stringify({ pass: R.steps.filter(s => s.ok).length, of: R.steps.length, fails: R.steps.filter(s => !s.ok).map(s => [s.name, s.error]), webviewRemoteRequests: R.webviewRemoteRequests, dialogs: R.dialogs, console: R.console.slice(0, 15), logErrors: R.logErrors.slice(0, 10), unchanged: R.unchanged, install: R.install.code }, null, 1));
}
