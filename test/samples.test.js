'use strict';
// The sample files: real ones from W3C, Wikimedia Commons and Google, and the made-up hostile ones.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const C = require('../src/core/svgcore.js');
const P = require('../src/core/protocol.js');

const S = path.join(__dirname, '..', 'samples');
const read = (f) => fs.readFileSync(path.join(S, f), 'utf8');

test('real files: root size, viewBox and symbols', () => {
  const w3c = C.rootInfo(read('real/w3c-coords-viewattr-01-b.svg')); // DOCTYPE with entities before the root
  assert.deepEqual(C.intrinsicSize(w3c), { w: 480, h: 360, assumed: false });
  const flag = C.intrinsicSize(C.rootInfo(read('real/flag-of-brazil.svg')));
  assert.ok(flag.w > 0 && flag.h > 0 && !flag.assumed);
  const sprite = read('real/material-sprite-action-symbol.svg');
  assert.equal(C.listSymbols(sprite).length, 215);
  assert.equal(C.intrinsicSize(C.rootInfo(sprite)).assumed, true);
  assert.equal(C.listSymbols(read('real/material-sprite-navigation-symbol.svg')).length, 27);
});

test('made-up files: no viewBox, offset viewBox, one pixel, colour scheme', () => {
  assert.equal(C.rootInfo(read('no-viewbox.svg')).viewBox, null);
  const off = C.rootInfo(read('viewbox-offset.svg'));
  assert.deepEqual(C.viewBoxRect(400, 300, off.viewBox, off.par), { x: 0, y: 0, w: 400, h: 300 });
  assert.deepEqual(C.intrinsicSize(C.rootInfo(read('one-pixel.svg'))), { w: 1, h: 1, assumed: false });
  assert.ok(C.hasColorScheme(read('color-scheme.svg')));
});

test('hostile files are recognised, and nothing in them is expanded or run', async () => {
  const r = C.riskScan(read('hostile-script.svg'));
  assert.deepEqual(r, { scripts: 2, handlers: 4, foreignObject: 1, external: 6, entities: 0 });
  const ent = read('hostile-entities.svg');
  assert.equal(C.riskScan(ent).entities, 10);
  const t0 = Date.now();
  assert.equal(C.rootInfo(ent).width, 200); // the root is found without expanding any entity
  assert.ok(C.countElements(ent) < 5);
  assert.ok(Date.now() - t0 < 200);
  assert.equal(C.intrinsicSize(C.rootInfo(read('hostile-huge-size.svg'))).w, 1e8);
  const bomb = fs.readFileSync(path.join(S, 'hostile-bomb.svgz'));
  assert.ok(bomb.length < 2 * 1024 * 1024);
  const out = await P.gunzipCapped(bomb, 50 * 1024 * 1024);
  assert.ok(out.tooLarge);
  const badge = await P.gunzipCapped(fs.readFileSync(path.join(S, 'badge.svgz')), 1024 * 1024);
  assert.equal(C.rootInfo(Buffer.from(badge.bytes).toString()).width, 160);
  assert.ok(zlib.gunzipSync(fs.readFileSync(path.join(S, 'badge.svgz'))).length > 200);
});
