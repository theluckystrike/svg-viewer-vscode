'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../src/core/svgcore.js');

const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} != ${b}`);

test('lengths: px, pt, mm, in, em; percentages and junk give null', () => {
  near(C.parseLength('100'), 100);
  near(C.parseLength('72pt'), 96);
  near(C.parseLength('25.4mm'), 96);
  near(C.parseLength('1in'), 96);
  near(C.parseLength('2em'), 32);
  near(C.parseLength('1e2px'), 100);
  assert.equal(C.parseLength('100%'), null);
  assert.equal(C.parseLength('auto'), null);
  assert.equal(C.parseLength('-5'), null);
  assert.equal(C.parseLength(undefined), null);
});

test('viewBox parsing accepts commas and rejects zero or negative size', () => {
  assert.deepEqual(C.parseViewBox('0,0,24,24'), { x: 0, y: 0, w: 24, h: 24 });
  assert.deepEqual(C.parseViewBox(' -50 -25  100 50 '), { x: -50, y: -25, w: 100, h: 50 });
  assert.equal(C.parseViewBox('0 0 0 10'), null);
  assert.equal(C.parseViewBox('0 0 10'), null);
});

test('root tag is found after a declaration, comments and a DOCTYPE with an internal subset', () => {
  const t = '<?xml version="1.0"?>\n<!-- a > b -->\n<!DOCTYPE svg [ <!ENTITY a "x>y"> ]>\n<svg xmlns="http://www.w3.org/2000/svg" width="10" height=\'20\' viewBox="0 0 5 10" data-x="a>b"><rect/></svg>';
  const r = C.findRootTag(t);
  assert.equal(r.attrs.width, '10');
  assert.equal(r.attrs.height, '20');
  assert.equal(r.attrs['data-x'], 'a>b');
  assert.equal(t.slice(r.end, r.end + 6), '<rect/');
  assert.equal(C.findRootTag('<html><svg/></html>'), null);
  assert.equal(C.findRootTag('not xml'), null);
  assert.equal(C.findRootTag('<svg:svg xmlns:svg="http://www.w3.org/2000/svg" width="3"/>').attrs.width, '3');
});

test('intrinsic size follows the browser rules', () => {
  assert.deepEqual(C.intrinsicSize(C.rootInfo('<svg width="1440pt" height="729.45pt" viewBox="0 0 1440 729.45"/>')), { w: 1920, h: 972.6, assumed: false });
  assert.deepEqual(C.intrinsicSize(C.rootInfo('<svg viewBox="0 0 24 12"/>')), { w: 24, h: 12, assumed: false });
  assert.deepEqual(C.intrinsicSize(C.rootInfo('<svg width="48" viewBox="0 0 24 12"/>')), { w: 48, h: 24, assumed: false });
  assert.deepEqual(C.intrinsicSize(C.rootInfo('<svg width="100%" height="100%"/>')), { w: 300, h: 150, assumed: true });
  assert.deepEqual(C.intrinsicSize(C.rootInfo('<svg width="1" height="1"/>')), { w: 1, h: 1, assumed: false });
  const huge = C.intrinsicSize(C.rootInfo('<svg width="100000000" height="100000000"/>'));
  assert.equal(huge.w, 1e8);
});

test('viewBox rectangle for meet, slice, none and an offset origin', () => {
  const par = C.parsePar('');
  assert.deepEqual(C.viewBoxRect(200, 100, { x: -50, y: -50, w: 100, h: 100 }, par), { x: 50, y: 0, w: 100, h: 100 });
  const minMin = C.parsePar('xMinYMin meet');
  assert.deepEqual(C.viewBoxRect(200, 100, { x: 0, y: 0, w: 100, h: 100 }, minMin), { x: 0, y: 0, w: 100, h: 100 });
  const slice = C.parsePar('xMidYMid slice');
  assert.deepEqual(C.viewBoxRect(200, 100, { x: 0, y: 0, w: 100, h: 100 }, slice), { x: 0, y: -50, w: 200, h: 200 });
  assert.deepEqual(C.viewBoxRect(200, 100, { x: 0, y: 0, w: 100, h: 100 }, C.parsePar('none')), { x: 0, y: 0, w: 200, h: 100 });
  const u = C.toUser(50, 0, 200, 100, { x: -50, y: -50, w: 100, h: 100 }, par);
  near(u.x, -50); near(u.y, -50);
});

test('overflow margin keeps the original picture at the same scale and place', () => {
  for (const [W, H, vb, p] of [
    [200, 100, { x: -50, y: -50, w: 100, h: 100 }, 'xMinYMax meet'],
    [200, 100, { x: 10, y: 20, w: 100, h: 100 }, 'xMidYMid slice'],
    [300, 150, { x: 0, y: 0, w: 30, h: 10 }, 'none'],
    [120, 120, null, ''],
  ]) {
    const par = C.parsePar(p);
    const m = 0.25;
    const a = C.overflowAttrs(W, H, vb, par, m);
    const vb2 = C.parseViewBox(a.viewBox);
    const r1 = C.viewBoxRect(W, H, vb || { x: 0, y: 0, w: W, h: H }, par);
    // the original viewBox drawn in the bigger picture, shifted back by the margin
    const t2 = C.viewBoxTransform(a.width, a.height, vb2, par);
    const v = vb || { x: 0, y: 0, w: W, h: H };
    near(v.x * t2.sx + t2.tx - m * W, r1.x, 1e-6);
    near(v.y * t2.sy + t2.ty - m * H, r1.y, 1e-6);
    near(v.w * t2.sx, r1.w, 1e-6);
    near(v.h * t2.sy, r1.h, 1e-6);
  }
});

test('setRootAttrs replaces and adds attributes on the root only', () => {
  const t = '<?xml version="1.0"?><svg width="10" height="20" viewBox="0 0 1 2"><svg width="5"/></svg>';
  const out = C.setRootAttrs(t, { width: 30, height: 40 });
  assert.equal(C.rootInfo(out).width, 30);
  assert.equal(C.rootInfo(out).height, 40);
  assert.equal(C.rootInfo(out).rawViewBox, '0 0 1 2');
  assert.ok(out.endsWith('<svg width="5"/></svg>'));
  assert.equal((out.match(/width=/g) || []).length, 2);
  const nob = C.setRootAttrs('<svg>x</svg>', { viewBox: '0 0 3 4' });
  assert.equal(nob, '<svg viewBox="0 0 3 4">x</svg>');
  assert.equal(C.setRootAttrs('<p/>', { width: 1 }), '<p/>');
});

test('prefers-color-scheme is forced to the chosen scheme', () => {
  const css = '<svg><style>@media (prefers-color-scheme: dark){a{}} @media (prefers-color-scheme:light){b{}}</style></svg>';
  assert.ok(C.hasColorScheme(css));
  assert.ok(!C.hasColorScheme('<svg/>'));
  const d = C.applyColorScheme(css, 'dark');
  assert.match(d, /\(min-width: 0px\)\{a/);
  assert.match(d, /\(max-width: 0px\)\{b/);
  const l = C.applyColorScheme(css, 'light');
  assert.match(l, /\(max-width: 0px\)\{a/);
  assert.match(l, /\(min-width: 0px\)\{b/);
});

test('risk scan counts scripts, handlers, foreignObject, external links and entities', () => {
  const t = '<!DOCTYPE svg [<!ENTITY a "b">]><svg onload="alert(1)"><script>alert(1)</script><foreignObject/><image href="http://example.com/x.png"/><rect style="fill:url(https://e.com/a)"/><use href="#ok"/></svg>';
  assert.deepEqual(C.riskScan(t), { scripts: 1, handlers: 1, foreignObject: 1, external: 2, entities: 1 });
  assert.deepEqual(C.riskScan('<svg><rect/></svg>'), { scripts: 0, handlers: 0, foreignObject: 0, external: 0, entities: 0 });
});

test('element and symbol counts skip comments and CDATA', () => {
  assert.equal(C.countElements('<?xml?><!-- <a> --><svg><g><rect/></g><![CDATA[ <b> ]]></svg>'), 3);
  const s = C.listSymbols('<svg><symbol id="a" viewBox="0 0 24 24"/><defs><symbol id=\'b\'></symbol></defs></svg>');
  assert.deepEqual(s, [{ id: 'a', viewBox: '0 0 24 24' }, { id: 'b', viewBox: '' }]);
});

test('PNG size: scale, width and the canvas limits', () => {
  assert.deepEqual(C.pngSize(100, 50, 'scale', 2), { w: 200, h: 100, clamped: false });
  assert.deepEqual(C.pngSize(100, 50, 'width', 1000), { w: 1000, h: 500, clamped: false });
  const big = C.pngSize(1920, 972.6, 'scale', 16);
  assert.ok(big.clamped && big.w <= C.MAX_CANVAS_SIDE && big.h <= C.MAX_CANVAS_SIDE);
  const huge = C.pngSize(1e8, 1e8, 'scale', 1);
  assert.ok(huge.clamped && huge.w * huge.h <= C.MAX_CANVAS_AREA);
});

test('zoom at a point keeps that point still; limits hold for tiny and huge pictures', () => {
  const lim = C.zoomLimits(100, 100, 4);
  const v = C.zoomAt({ zoom: 1, x: 10, y: 20 }, 2, 60, 70, lim);
  near((60 - v.x) / v.zoom, (60 - 10) / 1);
  near((70 - v.y) / v.zoom, (70 - 20) / 1);
  const tiny = C.zoomLimits(1, 1, 500);
  assert.ok(tiny.max >= 500 * 32 - 1e-9 || tiny.max === 200000);
  const huge = C.zoomLimits(1e8, 1e8, 1e-5);
  assert.ok(huge.max * 1e8 <= 200000 + 1e-6);
  assert.ok(huge.min <= 1e-5 / 8 + 1e-12);
});

test('size plan: load, ask over the setting, refuse over the hard limit', () => {
  assert.equal(C.sizePlan(10 * C.MB, 50).mode, 'load');
  assert.equal(C.sizePlan(51 * C.MB, 50).mode, 'ask');
  assert.equal(C.sizePlan(401 * C.MB, 1000).mode, 'refuse');
  assert.equal(C.sizePlan(60 * C.MB, NaN).mode, 'ask');
  assert.equal(C.fmtSize(18029709), '17.2 MB');
  assert.equal(C.fmtNum(1920), '1,920');
  assert.equal(C.fmtNum(972.6), '972.6');
});
