// Engines floor check: the packaged .vsix in an old VS Code (VSC_APP=<path to 1.90.2 app>).
// usage: VSC_APP=... node scripts/smoke-old.mjs <shortWork> <port> <vsix> <workspaceDir> <outJson>
import { launch, installVsix, sleep } from './vsc.mjs';
import fs from 'node:fs';
import path from 'node:path';
const [work0, port, vsix, ws0, outJson] = process.argv.slice(2);
const work = path.resolve(work0), ws = path.resolve(ws0);
fs.rmSync(path.join(work, 'ud'), { recursive: true, force: true });
const R = { install: installVsix(work, vsix), steps: [] };
const vs = await launch(work, Number(port), ws, { 'workbench.editor.enablePreview': false });
R.version = await vs.wbEval(`navigator.userAgent.match(/Code\\/[\\d.]+/)?.[0] || ''`);
let wv;
const probe = async () => JSON.parse(await vs.wvEval(wv, 'JSON.stringify(window.svgViewerProbe())'));
try {
  await sleep(3000);
  for (const f of ['flag-of-brazil.svg', 'material-sprite-action-symbol.svg', 'physical-world-map-2021.svg', 'hostile-script.svg', 'viewbox-offset.svg']) {
    const t0 = Date.now();
    try {
      await vs.command('View: Close All Editors').catch(() => {});
      vs.open(path.join(ws, f)); await vs.waitFor(async () => (await vs.wbEval('document.title')).includes(f), 15000); await sleep(1500);
      // the editor title button (the user path); the palette check of the newer driver does not fit 1.90's DOM
      const clicked = await vs.waitFor(() => vs.wbEval(`(() => { const a = [...document.querySelectorAll('.editor-actions .action-label')].find(x => /Open Preview to the Side/.test(x.getAttribute('aria-label') || x.title || '')); if (a) a.click(); return !!a; })()`), 10000);
      if (!clicked) throw new Error('no editor title button');
      wv = await vs.waitFor(async () => (await vs.webviews()).find(w => w.title === f && w.w > 0), 20000);
      if (!wv) throw new Error('no preview');
      const p = await vs.waitFor(async () => { const q = await probe(); return (q.loaded || q.tiles > 0) && q; }, 60000);
      if (!p || p.notice) throw new Error(JSON.stringify(p));
      R.steps.push({ file: f, ok: true, ms: Date.now() - t0, status: p.status.split('\n').slice(0, 5).join(' | '), tiles: p.tiles });
    } catch (e) { R.steps.push({ file: f, ok: false, error: String(e.message).slice(0, 300) }); }
  }
  try {
    vs.open(path.join(ws, 'badge.svgz'));
    wv = await vs.waitFor(async () => (await vs.webviews()).find(w => w.title === 'badge.svgz' && w.w > 0), 20000);
    const p = wv && await vs.waitFor(async () => (await probe()).loaded && probe(), 20000);
    R.steps.push({ file: 'badge.svgz (default editor)', ok: !!p, status: p ? p.status.split('\n')[0] : '' });
  } catch (e) { R.steps.push({ file: 'badge.svgz', ok: false, error: String(e.message).slice(0, 300) }); }
  await vs.shot(path.join(work, 'old-engine.png'));
} finally {
  R.console = vs.console.filter(c => /svg|zovo/i.test(c.text) && !/media-preview|imagePreview/.test(c.text));
  await vs.close();
  fs.writeFileSync(outJson, JSON.stringify(R, null, 1));
  console.log(JSON.stringify({ version: R.version, install: R.install.code, pass: R.steps.filter(s => s.ok).length, of: R.steps.length, steps: R.steps, console: R.console.slice(0, 5) }, null, 1));
}
