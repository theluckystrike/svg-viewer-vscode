// README and walkthrough screenshots from a real VS Code with the packaged extension.
// usage: node scripts/readme-shots.mjs <work> <port> <vsix> <workspaceDir> <imagesDir>
import { launch, installVsix, sleep } from './vsc.mjs';
import fs from 'node:fs';
import path from 'node:path';

const [work0, port, vsix, ws0, out0] = process.argv.slice(2);
const work = path.resolve(work0), ws = path.resolve(ws0), out = path.resolve(out0);
fs.rmSync(path.join(work, 'ud'), { recursive: true, force: true });
const inst = installVsix(work, vsix); if (inst.code !== 0) throw new Error(inst.out);
const vs = await launch(work, Number(port), ws, { 'workbench.editor.enablePreview': false, 'editor.minimap.enabled': false, 'window.titleBarStyle': 'custom',
  'workbench.secondarySideBar.defaultVisibility': 'hidden', 'workbench.auxiliaryBar.visible': false, 'editor.fontSize': 13, 'workbench.statusBar.visible': true,
  'editor.largeFileOptimizations': true, 'workbench.editor.showTabs': 'multiple', 'breadcrumbs.enabled': false });
let wv;
const E = (x) => vs.wvEval(wv, x);
const probe = async () => JSON.parse(await E('JSON.stringify(window.svgViewerProbe())'));
const kind = () => vs.wbEval(`(() => { const g = document.querySelector('.editor-group-container.active'); return g && g.querySelector('.monaco-editor .view-lines') ? 'text' : 'other'; })()`);
const clean = async () => { await vs.command('Notifications: Clear All Notifications').catch(() => {}); await sleep(400); };
async function show(file, opts = {}) {
  await vs.command('View: Close All Editors'); await sleep(500);
  vs.open(path.join(ws, file)); await vs.waitFor(async () => (await vs.wbEval('document.title')).includes(file), 15000); await sleep(1500);
  for (let i = 0; i < 3 && await kind() !== 'text'; i++) { await vs.command('View: Reopen Editor With Text Editor'); await vs.waitFor(async () => (await kind()) === 'text', 6000); }
  await vs.command('SVG Viewer: Open Preview to the Side');
  wv = await vs.waitFor(async () => (await vs.webviews()).find(w => w.title === file && w.w > 0), 20000);
  await vs.waitFor(async () => { const p = await probe(); return (p.loaded || p.tiles > 0) && p; }, 90000);
  if (opts.wide) { await vs.command('View: Toggle Primary Side Bar Visibility').catch(() => {}); await sleep(800); }
  await sleep(800);
}
const stagePt = async (fx, fy) => { const off = await vs.wvOffset(); const b = JSON.parse(await E(`JSON.stringify(document.querySelector('.stage').getBoundingClientRect())`)); return { x: off.x + b.x + b.width * fx, y: off.y + b.y + b.height * fy }; };
const wheel = async (x, y, dy) => { await vs.s.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY: dy }, vs.wb); await sleep(80); };
const btn = t => `[...document.querySelectorAll('button')].find(b => b.textContent === ${JSON.stringify(t)})`;
try {
  await sleep(3000);
  await vs.command('View: Close Primary Side Bar').catch(() => {});
  // 1. hero: the 18 MB world map beside its source, zoomed on Europe with the pointer position in the status line
  await show('physical-world-map-2021.svg');
  await vs.wbEval(`(() => { const s = document.querySelector('.split-view-container .sash-container'); return 1; })()`);
  const a = await stagePt(0.52, 0.36);
  for (let i = 0; i < 4; i++) await wheel(a.x, a.y, -120);
  await sleep(3500);
  await vs.s.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: a.x + 20, y: a.y + 10 }, vs.wb);
  await clean(); await sleep(800);
  await vs.shot(path.join(out, 'world-map.png'));
  // 2. viewBox outline on the offset sample
  await show('viewbox-offset.svg');
  await vs.wvClick(wv, btn('viewBox')); await sleep(800);
  await clean(); await vs.shot(path.join(out, 'viewbox-outline.png'));
  await vs.wvClick(wv, btn('viewBox'));
  // 3. sprite grid
  await show('material-sprite-action-symbol.svg');
  await sleep(1500); await clean(); await vs.shot(path.join(out, 'sprite-grid.png'));
  // 4. hostile file, scripts listed as blocked
  await show('hostile-script.svg');
  await clean(); await vs.shot(path.join(out, 'hostile-blocked.png'));
  // 5. light theme, prefers-color-scheme set to dark
  await vs.setSetting('workbench.colorTheme', 'Default Light Modern');
  await show('color-scheme.svg');
  await E(`(() => { const s = document.querySelector('select[aria-label="Colour scheme"]'); s.value = 'dark'; s.dispatchEvent(new Event('change')); return 1; })()`); await sleep(800);
  await clean(); await vs.shot(path.join(out, 'light-theme-dark-scheme.png'));
  console.log('ok');
} finally { await vs.close(); }
