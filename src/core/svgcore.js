'use strict';
// Pure SVG helpers shared by the extension host, the webview and the tests. No vscode import, no DOM.
// Loaded in the webview as a plain script (window.SvgCore) and in Node with require().
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SvgCore = api;
}(typeof self !== 'undefined' ? self : this, function () {
  const MB = 1024 * 1024;
  const DEFAULT_W = 300; // browsers draw an SVG with no size as 300 x 150
  const DEFAULT_H = 150;
  const HARD_LIMIT_MB = 400; // never decoded: a JavaScript string cannot hold much more
  const MAX_CANVAS_SIDE = 16384;
  const MAX_CANVAS_AREA = 16384 * 16384;

  const UNIT_PX = { px: 1, pt: 96 / 72, pc: 16, mm: 96 / 25.4, cm: 96 / 2.54, in: 96, q: 96 / 101.6, em: 16, ex: 8 };

  /** A length attribute in CSS px, or null for percentages, auto or junk. */
  function parseLength(v) {
    if (v == null) return null;
    const m = /^\s*([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)\s*([a-z]*)\s*$/i.exec(String(v));
    if (!m) return null;
    const n = Number(m[1]);
    const unit = (m[2] || 'px').toLowerCase();
    if (!Number.isFinite(n) || !(unit in UNIT_PX)) return null;
    const px = n * UNIT_PX[unit];
    return px > 0 && Number.isFinite(px) ? px : null;
  }

  function parseViewBox(v) {
    if (v == null) return null;
    const p = String(v).trim().split(/[\s,]+/).map(Number);
    if (p.length !== 4 || !p.every(Number.isFinite) || p[2] <= 0 || p[3] <= 0) return null;
    return { x: p[0], y: p[1], w: p[2], h: p[3] };
  }

  /** preserveAspectRatio: { align: 'none' | 'xMidYMid' | ..., slice, ax, ay } */
  function parsePar(v) {
    const s = String(v || '').trim().split(/\s+/);
    let align = s[0] || 'xMidYMid';
    if (s[0] === 'defer') align = s[1] || 'xMidYMid';
    const valid = /^(none|x(Min|Mid|Max)Y(Min|Mid|Max))$/.test(align);
    if (!valid) align = 'xMidYMid';
    const slice = s.includes('slice');
    const pos = { Min: 0, Mid: 0.5, Max: 1 };
    const m = /^x(Min|Mid|Max)Y(Min|Mid|Max)$/.exec(align);
    return { align, slice, ax: m ? pos[m[1]] : 0.5, ay: m ? pos[m[2]] : 0.5 };
  }

  /**
   * Find the root <svg ...> start tag. Skips the XML declaration, comments, a DOCTYPE (with an internal subset)
   * and processing instructions. Returns { start, end, attrs } with end just past '>', or null.
   */
  function findRootTag(text) {
    const t = String(text);
    let i = 0;
    const n = t.length;
    while (i < n) {
      const lt = t.indexOf('<', i);
      if (lt < 0) return null;
      if (t.startsWith('<!--', lt)) { const e = t.indexOf('-->', lt + 4); if (e < 0) return null; i = e + 3; continue; }
      if (t.startsWith('<?', lt)) { const e = t.indexOf('?>', lt + 2); if (e < 0) return null; i = e + 2; continue; }
      if (t.startsWith('<!', lt)) {
        // DOCTYPE, maybe with [ internal subset ]
        let j = lt + 2; let depth = 0;
        while (j < n) { const c = t[j]; if (c === '[') depth++; else if (c === ']') depth--; else if (c === '>' && depth <= 0) break; j++; }
        i = j + 1; continue;
      }
      const m = /^<([A-Za-z_][\w.-]*:)?svg(?=[\s/>])/.exec(t.slice(lt, lt + 16));
      if (!m) return null; // the first element is not <svg>
      // scan to the closing '>' outside quotes
      let j = lt + m[0].length; let q = '';
      while (j < n) { const c = t[j]; if (q) { if (c === q) q = ''; } else if (c === '"' || c === "'") q = c; else if (c === '>') break; j++; }
      if (j >= n) return null;
      const body = t.slice(lt + m[0].length, j).replace(/\/\s*$/, '');
      return { start: lt, end: j + 1, prefix: m[1] || '', attrs: parseAttrs(body) };
    }
    return null;
  }

  function parseAttrs(s) {
    const out = {};
    const re = /([^\s=/>]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
    let m;
    while ((m = re.exec(s))) out[m[1]] = m[3] !== undefined ? m[3] : m[4];
    return out;
  }

  /** Size facts of the root element. Works on a partial head of a large file. */
  function rootInfo(text) {
    const tag = findRootTag(text);
    if (!tag) return null;
    const a = tag.attrs;
    const width = parseLength(a.width);
    const height = parseLength(a.height);
    const viewBox = parseViewBox(a.viewBox);
    return {
      width, height, viewBox, par: parsePar(a.preserveAspectRatio),
      rawWidth: a.width == null ? null : a.width, rawHeight: a.height == null ? null : a.height,
      rawViewBox: a.viewBox == null ? null : a.viewBox,
    };
  }

  /** The size the picture is drawn at for zoom 1 (CSS px), like a browser does for <img>. */
  function intrinsicSize(info) {
    if (!info) return { w: DEFAULT_W, h: DEFAULT_H, assumed: true };
    const vb = info.viewBox;
    let w = info.width, h = info.height;
    if (w && h) return { w, h, assumed: false };
    if (vb) {
      if (w) return { w, h: w * vb.h / vb.w, assumed: false };
      if (h) return { w: h * vb.w / vb.h, h, assumed: false };
      return { w: vb.w, h: vb.h, assumed: false };
    }
    return { w: w || DEFAULT_W, h: h || DEFAULT_H, assumed: !(w || h) };
  }

  /** Where the viewBox lands in a W x H viewport: scale and offset per axis. */
  function viewBoxTransform(W, H, vb, par) {
    const p = par || parsePar('');
    if (!vb) return { sx: 1, sy: 1, tx: 0, ty: 0 };
    let sx = W / vb.w, sy = H / vb.h;
    if (p.align !== 'none') { const s = p.slice ? Math.max(sx, sy) : Math.min(sx, sy); sx = sy = s; }
    const tx = (W - vb.w * sx) * (p.align === 'none' ? 0 : p.ax) - vb.x * sx;
    const ty = (H - vb.h * sy) * (p.align === 'none' ? 0 : p.ay) - vb.y * sy;
    return { sx, sy, tx, ty };
  }

  /** The viewBox rectangle in viewport px (for the outline). */
  function viewBoxRect(W, H, vb, par) {
    if (!vb) return { x: 0, y: 0, w: W, h: H };
    const t = viewBoxTransform(W, H, vb, par);
    return { x: vb.x * t.sx + t.tx, y: vb.y * t.sy + t.ty, w: vb.w * t.sx, h: vb.h * t.sy };
  }

  /** A viewport point (px at zoom 1) in SVG user units. */
  function toUser(px, py, W, H, vb, par) {
    const t = viewBoxTransform(W, H, vb, par);
    return { x: (px - t.tx) / t.sx, y: (py - t.ty) / t.sy };
  }

  /**
   * Root attributes for drawing with a margin of m (fraction of the viewport) on each side, so content outside
   * the viewBox shows. The original viewport lands at (m*W, m*H) in the bigger picture, at the same scale.
   */
  function overflowAttrs(W, H, vb0, par, m) {
    const vb = vb0 || { x: 0, y: 0, w: W, h: H };
    const t = viewBoxTransform(W, H, vb, par);
    const mx = m * W / t.sx, my = m * H / t.sy;
    const r = (v) => Number(v.toPrecision(10));
    return {
      width: r(W * (1 + 2 * m)), height: r(H * (1 + 2 * m)),
      viewBox: [vb.x - mx, vb.y - my, vb.w + 2 * mx, vb.h + 2 * my].map(r).join(' '),
    };
  }

  function escAttr(v) {
    return String(v).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  }

  /** Replace or add attributes on the root <svg> tag. Returns the text unchanged when there is no root. */
  function setRootAttrs(text, attrs) {
    const tag = findRootTag(text);
    if (!tag) return text;
    let head = text.slice(tag.start, tag.end);
    const open = `<${tag.prefix}svg`;
    for (const k of Object.keys(attrs)) {
      const re = new RegExp(`(\\s)${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*=\\s*("[^"]*"|'[^']*')`, 'g');
      head = head.replace(re, '$1');
    }
    const add = Object.keys(attrs).filter((k) => attrs[k] != null).map((k) => ` ${k}="${escAttr(attrs[k])}"`).join('');
    head = open + add + head.slice(open.length);
    return text.slice(0, tag.start) + head + text.slice(tag.end);
  }

  const SCHEME_RE = /prefers-color-scheme\s*:\s*(dark|light)/gi;

  function hasColorScheme(text) {
    SCHEME_RE.lastIndex = 0;
    return SCHEME_RE.test(String(text));
  }

  /**
   * Force the prefers-color-scheme media queries of the file to one answer. A matching query becomes
   * (min-width: 0px), which is always true, and the other one (max-width: 0px), which is never true.
   */
  function applyColorScheme(text, scheme) {
    if (scheme !== 'dark' && scheme !== 'light') return text;
    return String(text).replace(SCHEME_RE, (_, v) => (v.toLowerCase() === scheme ? 'min-width: 0px' : 'max-width: 0px'));
  }

  /** Things in the file that the preview blocks. Counts only; nothing runs. */
  function riskScan(text) {
    const t = String(text);
    const count = (re) => { let n = 0; re.lastIndex = 0; while (re.exec(t)) n++; return n; };
    return {
      scripts: count(/<(?:[\w-]+:)?script[\s/>]/gi),
      handlers: count(/\son[a-z]+\s*=\s*["']/gi),
      foreignObject: count(/<(?:[\w-]+:)?foreignObject[\s/>]/gi),
      external: count(/(?:href|src)\s*=\s*["']\s*(?:https?:|\/\/|file:|ftp:)/gi) + count(/url\(\s*["']?\s*(?:https?:|\/\/)/gi),
      entities: count(/<!ENTITY/g),
    };
  }

  /** Element count without a parser: start tags only, outside comments and CDATA. */
  function countElements(text) {
    const t = String(text);
    let n = 0, i = 0;
    const len = t.length;
    while (i < len) {
      const lt = t.indexOf('<', i);
      if (lt < 0) break;
      const c = t.charCodeAt(lt + 1);
      if (c === 33) { // '!'
        if (t.startsWith('<!--', lt)) { const e = t.indexOf('-->', lt + 4); i = e < 0 ? len : e + 3; continue; }
        if (t.startsWith('<![CDATA[', lt)) { const e = t.indexOf(']]>', lt + 9); i = e < 0 ? len : e + 3; continue; }
        i = lt + 2; continue;
      }
      if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95) n++;
      i = lt + 1;
    }
    return n;
  }

  /** Symbol ids and viewBoxes without a parser (used for large files and as a check). */
  function listSymbols(text, max) {
    const out = [];
    const re = /<(?:[\w-]+:)?symbol\b([^>]*)>/g;
    let m;
    const lim = max || 100000;
    while ((m = re.exec(String(text))) && out.length < lim) {
      const a = parseAttrs(m[1]);
      out.push({ id: a.id || '', viewBox: a.viewBox || '' });
    }
    return out;
  }

  /** PNG export size: scale (1, 2, 4, 8) or a width in px. Kept inside the browser canvas limits. */
  function pngSize(w, h, mode, value) {
    let W, H;
    if (mode === 'width') { W = Math.max(1, Math.round(Number(value) || w)); H = Math.max(1, Math.round(W * h / w)); }
    else { const s = Number(value) > 0 ? Number(value) : 1; W = Math.max(1, Math.round(w * s)); H = Math.max(1, Math.round(h * s)); }
    let clamped = false;
    let k = Math.min(1, MAX_CANVAS_SIDE / W, MAX_CANVAS_SIDE / H, Math.sqrt(MAX_CANVAS_AREA / (W * H)));
    if (k < 1) { clamped = true; W = Math.max(1, Math.floor(W * k)); H = Math.max(1, Math.floor(H * k)); }
    return { w: W, h: H, clamped };
  }

  /** Zoom that fits w x h into the stage with a padding. */
  function fitZoom(stageW, stageH, w, h, pad) {
    const p = pad == null ? 16 : pad;
    const z = Math.min((stageW - 2 * p) / w, (stageH - 2 * p) / h);
    return Number.isFinite(z) && z > 0 ? z : 1;
  }

  /** Zoom limits for a picture: from 1/8 of fit (or 1 %) up to 64x (more for tiny pictures), capped so the
   * drawn picture stays under 200,000 px on its long side. */
  function zoomLimits(w, h, fit) {
    const long = Math.max(w, h);
    const max = Math.max(Math.min(Math.max(64, fit * 32), 200000 / long), fit);
    const min = Math.min(fit / 8, 0.01 * Math.max(1, fit));
    return { min: Math.min(min, max), max };
  }

  /** Zoom by factor around the stage point (cx, cy), keeping that point still. view: { zoom, x, y }. */
  function zoomAt(view, factor, cx, cy, lim) {
    const z = Math.min(lim.max, Math.max(lim.min, view.zoom * factor));
    const k = z / view.zoom;
    return { zoom: z, x: cx - (cx - view.x) * k, y: cy - (cy - view.y) * k };
  }

  function fmtSize(n) {
    if (!Number.isFinite(n) || n < 0) return '?';
    if (n < 1024) return `${n} B`;
    if (n < MB) return `${(n / 1024).toFixed(1)} KB`;
    if (n < 1024 * MB) return `${(n / MB).toFixed(1)} MB`;
    return `${(n / (1024 * MB)).toFixed(1)} GB`;
  }

  function fmtNum(n) {
    if (!Number.isFinite(n)) return '?';
    return n.toLocaleString('en-US', { maximumFractionDigits: Math.abs(n) >= 1000 ? 0 : Math.abs(n) >= 100 ? 1 : 2 });
  }

  /**
   * How many elements the renderer would draw once every <use> is expanded, without a DOM. A few kilobytes of
   * nested <use> (each group uses the one before it twice) expand to billions of shapes, and Chromium then takes
   * many GB and minutes for one image. Counts elements in each element with an id plus the <use> references
   * inside it, then resolves the references with memoization; a reference cycle counts as 0 (browsers skip it).
   * Stops early and returns a number over `cap` as soon as the total passes it.
   */
  function useExpansion(text, cap = 1e6) {
    const t = String(text);
    const len = t.length;
    const ids = new Map(); // id -> { elems, uses: Map(target -> count) }
    const root = { id: null, elems: 0, uses: new Map(), name: '' };
    const stack = [root];
    let nUses = 0, i = 0;
    const attr = (s, name) => { const m = new RegExp('(?:^|\\s)' + name + '\\s*=\\s*("([^"]*)"|\'([^\']*)\')').exec(s); return m ? (m[2] != null ? m[2] : m[3]) : null; };
    const addUse = (frame, target, n) => frame.uses.set(target, (frame.uses.get(target) || 0) + n);
    const close = () => {
      const f = stack.pop(); const parent = stack[stack.length - 1];
      if (f.id && !ids.has(f.id)) ids.set(f.id, { elems: f.elems, uses: new Map(f.uses) });
      if (parent) { parent.elems += f.elems; for (const [k, v] of f.uses) addUse(parent, k, v); }
    };
    while (i < len) {
      const lt = t.indexOf('<', i);
      if (lt < 0) break;
      const c = t.charCodeAt(lt + 1);
      if (c === 33) { // <! comment, CDATA, DOCTYPE
        if (t.startsWith('<!--', lt)) { const e = t.indexOf('-->', lt + 4); i = e < 0 ? len : e + 3; continue; }
        if (t.startsWith('<![CDATA[', lt)) { const e = t.indexOf(']]>', lt + 9); i = e < 0 ? len : e + 3; continue; }
        const e = t.indexOf('>', lt); i = e < 0 ? len : e + 1; continue;
      }
      if (c === 63) { const e = t.indexOf('?>', lt); i = e < 0 ? len : e + 2; continue; } // <? ... ?>
      const gt = t.indexOf('>', lt);
      if (gt < 0) break;
      i = gt + 1;
      if (c === 47) { if (stack.length > 1) close(); continue; } // </...>
      const body = t.slice(lt + 1, t.charCodeAt(gt - 1) === 47 ? gt - 1 : gt);
      const m = /^([\w:.-]+)/.exec(body);
      if (!m) continue;
      const name = m[1].replace(/^[\w-]+:/, '').toLowerCase();
      const frame = { id: attr(body, 'id'), elems: 1, uses: new Map(), name };
      if (name === 'use') {
        const href = attr(body, '(?:xlink:)?href');
        if (href && href.trim().startsWith('#')) { addUse(frame, href.trim().slice(1), 1); nUses++; }
      }
      stack.push(frame);
      if (t.charCodeAt(gt - 1) === 47) close();
      if (stack.length > 20000) break; // deeper than any renderer draws
    }
    while (stack.length > 1) close();
    if (!nUses) return root.elems;
    const memo = new Map(), busy = new Set();
    const count = (id) => {
      if (memo.has(id)) return memo.get(id);
      const e = ids.get(id);
      if (!e || busy.has(id)) return 0;
      busy.add(id);
      let n = e.elems;
      for (const [k, v] of e.uses) { n += v * count(k); if (n > cap) break; }
      busy.delete(id);
      memo.set(id, n);
      return n;
    };
    let total = root.elems;
    for (const [k, v] of root.uses) { total += v * count(k); if (total > cap) return total; }
    return total;
  }

  /** Whether to draw at once, ask first (over the setting), or refuse (over the hard limit). */
  function sizePlan(bytes, maxFileMB) {
    const limitMB = Number.isFinite(maxFileMB) && maxFileMB > 0 ? Math.min(maxFileMB, HARD_LIMIT_MB) : 50;
    if (bytes > HARD_LIMIT_MB * MB) return { mode: 'refuse', limitMB };
    if (bytes > limitMB * MB) return { mode: 'ask', limitMB };
    return { mode: 'load', limitMB };
  }

  return {
    MB, DEFAULT_W, DEFAULT_H, HARD_LIMIT_MB, MAX_CANVAS_SIDE, MAX_CANVAS_AREA,
    parseLength, parseViewBox, parsePar, findRootTag, parseAttrs, rootInfo, intrinsicSize,
    viewBoxTransform, viewBoxRect, toUser, overflowAttrs, setRootAttrs,
    hasColorScheme, applyColorScheme, riskScan, countElements, listSymbols, useExpansion,
    pngSize, fitZoom, zoomLimits, zoomAt, fmtSize, fmtNum, sizePlan,
  };
}));
