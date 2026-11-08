// SVG Viewer webview. Plain browser script, no network. The SVG is drawn as an <img> from a blob: URL, so
// scripts inside the file never run and external images or fonts never load. DOMParser is used only to read
// <symbol> elements for the sprite grid, and parsed nodes are never put into this page.
(function () {
  'use strict';
  const vscode = acquireVsCodeApi();
  const C = window.SvgCore;
  const MARGIN = 0.25; // share of the picture shown around the viewBox when "viewBox" is on
  const SYMBOL_PARSE_LIMIT = 30 * 1024 * 1024;
  const SYMBOL_TILE_LIMIT = 3000;

  let st = vscode.getState() || {};
  const save = () => vscode.setState(st);
  let settings = { mouseWheel: 'zoom' };
  let doc = null; // { text, info, W, H, size, ... }
  let view = null; // { zoom, x, y }: x, y = top left of the viewport in stage px
  let lim = { min: 0.01, max: 64 };
  let pic = null; // the shown <img>
  let picUrl = '';
  let goodOnce = false;
  let renderSeq = 0;
  let pendingLarge = null;
  let name = 'image.svg';
  let renders = 0;

  // ---------- DOM ----------
  function h(tag, props, ...kids) {
    const e = document.createElement(tag);
    if (props) for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === 'class') e.className = v;
      else if (k === 'text') e.textContent = v;
      else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
      else e.setAttribute(k, v === true ? '' : v);
    }
    for (const c of kids) if (c != null) e.append(c);
    return e;
  }
  const btn = (label, title, on, extra) => h('button', { type: 'button', title, 'aria-label': title, onclick: on, ...(extra || {}) }, label);
  const sep = () => h('span', { class: 'sep', 'aria-hidden': 'true' });

  const app = document.getElementById('app');
  app.textContent = '';
  const zoomText = h('span', { class: 'zoomtext', title: 'Zoom. 100 % is one SVG pixel per screen pixel.' }, '');
  const bgSelect = h('select', { 'aria-label': 'Background', title: 'Background behind the picture. Kept for this workspace.' },
    h('option', { value: 'checker' }, 'Checkerboard'), h('option', { value: 'white' }, 'White'), h('option', { value: 'black' }, 'Black'),
    h('option', { value: 'theme' }, 'Theme'), h('option', { value: 'custom' }, 'Custom'));
  const bgColor = h('input', { type: 'color', value: '#ffffff', 'aria-label': 'Custom background colour', title: 'Custom background colour', hidden: true });
  const vbBtn = btn('viewBox', 'Show the viewBox outline and dim what lies outside it (V)', () => setOverflow(!st.overflow), { 'aria-pressed': 'false' });
  const schemeSelect = h('select', { 'aria-label': 'Colour scheme', title: 'This SVG has prefers-color-scheme styles. Pick the scheme to preview.', hidden: true },
    h('option', { value: 'auto' }, 'Scheme: auto'), h('option', { value: 'light' }, 'Scheme: light'), h('option', { value: 'dark' }, 'Scheme: dark'));
  const symBtn = btn('Symbols', 'Show every <symbol> in this sprite sheet', () => setSymbols(!st.symbols), { 'aria-pressed': 'false', hidden: true });
  const pngMode = h('select', { 'aria-label': 'PNG size', title: 'PNG export size' },
    h('option', { value: '1' }, 'PNG 1x'), h('option', { value: '2' }, 'PNG 2x'), h('option', { value: '4' }, 'PNG 4x'), h('option', { value: '8' }, 'PNG 8x'),
    h('option', { value: 'width' }, 'PNG width'));
  const pngWidth = h('input', { type: 'number', min: '1', max: String(C.MAX_CANVAS_SIDE), step: '1', value: '1024', class: 'pngwidth', 'aria-label': 'PNG width in pixels', title: 'PNG width in pixels', hidden: true });
  const toolbar = h('div', { class: 'toolbar', role: 'toolbar' },
    btn('Fit', 'Fit the picture to the view (0)', () => { fit(); }),
    btn('1:1', 'Actual size, one SVG pixel per screen pixel (1)', () => actual()),
    btn('−', 'Zoom out (-)', () => zoomCenter(1 / 1.25)),
    zoomText,
    btn('+', 'Zoom in (+)', () => zoomCenter(1.25)),
    sep(), bgSelect, bgColor, vbBtn, schemeSelect, symBtn,
    sep(), pngMode, pngWidth,
    btn('Save PNG', 'Save the picture as a PNG file', () => exportPng('save')),
    btn('Copy PNG', 'Copy the picture as a PNG image', () => exportPng('copy')),
    btn('Data URI', 'Copy the SVG as a data:image/svg+xml;base64 URI', () => vscode.postMessage({ type: 'copyDataUri' })),
    h('span', { class: 'grow' }),
    btn('Source', 'Open the SVG source as text', () => vscode.postMessage({ type: 'openSource' })));
  const bgPane = h('div', { class: 'bgpane' });
  const vbBox = h('div', { class: 'vbox', hidden: true }, h('span', { class: 'vblabel' }, 'viewBox'));
  const busy = h('div', { class: 'busy', hidden: true }, 'Drawing...');
  const notice = h('div', { class: 'notice', hidden: true, role: 'status' });
  const stage = h('div', { class: 'stage', tabindex: '0', 'aria-label': 'SVG picture. Scroll to zoom at the pointer, drag to pan.' }, bgPane, vbBox, busy, notice);
  const banner = h('div', { class: 'banner', hidden: true, role: 'status' });
  const toast = h('div', { class: 'toast', hidden: true, role: 'status', 'aria-live': 'polite' });
  const symFilter = h('input', { type: 'search', placeholder: 'Filter by id', 'aria-label': 'Filter symbols by id' });
  const symCount = h('span', { class: 'symcount' });
  const symGrid = h('div', { class: 'symgrid', role: 'list' });
  const symPanel = h('div', { class: 'symbols', hidden: true },
    h('div', { class: 'symhead' }, symFilter, symCount, h('span', { class: 'grow' }), h('span', { class: 'symhint' }, 'Click a symbol to copy its <use> line.')),
    symGrid);
  const sDims = h('span', { class: 'dims' }), sVb = h('span', { class: 'vb' }), sSize = h('span', { class: 'size' });
  const sElems = h('span', { class: 'elems' }), sRisk = h('span', { class: 'risk' }), sPos = h('span', { class: 'pos' });
  const status = h('div', { class: 'status' }, sDims, sVb, sSize, sElems, sRisk, h('span', { class: 'grow' }), sPos);
  const tpl = document.getElementById('support-template');
  if (tpl && tpl.content.firstElementChild) status.append(tpl.content.firstElementChild.cloneNode(true));
  app.append(toolbar, banner, h('div', { class: 'main' }, stage, symPanel), status, toast);

  // ---------- helpers ----------
  let toastTimer = 0;
  function showToast(text, error) {
    toast.textContent = text; toast.hidden = false; toast.classList.toggle('error', !!error);
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { toast.hidden = true; }, error ? 7000 : 3500);
  }
  function showNotice(text, kind, button) {
    notice.textContent = ''; notice.className = 'notice' + (kind ? ' ' + kind : '');
    notice.append(text);
    if (button) notice.append(h('div', { class: 'actions' }, button));
    notice.hidden = false;
  }
  const hideNotice = () => { notice.hidden = true; };
  function setBanner(text) { banner.textContent = text || ''; banner.hidden = !text; }
  const stageSize = () => ({ w: stage.clientWidth || 600, h: stage.clientHeight || 400 });
  function themeScheme() { return document.body.classList.contains('vscode-light') || document.body.classList.contains('vscode-high-contrast-light') ? 'light' : 'dark'; }
  const scheme = () => (st.scheme === 'light' || st.scheme === 'dark' ? st.scheme : themeScheme());

  // ---------- view ----------
  function fitView() {
    const s = stageSize();
    const z = C.fitZoom(s.w, s.h, doc.W, doc.H, 16);
    return { zoom: z, x: (s.w - doc.W * z) / 2, y: (s.h - doc.H * z) / 2 };
  }
  function updateLimits() { const s = stageSize(); lim = C.zoomLimits(doc.W, doc.H, C.fitZoom(s.w, s.h, doc.W, doc.H, 16)); }
  function fit() { if (!doc) return; view = fitView(); apply(); }
  function actual() {
    if (!doc) return; const s = stageSize();
    view = C.zoomAt(view, 1 / view.zoom, s.w / 2, s.h / 2, { min: 0, max: Infinity });
    view.zoom = Math.min(Math.max(view.zoom, lim.min), lim.max); apply();
  }
  function zoomCenter(f) { if (!doc) return; const s = stageSize(); view = C.zoomAt(view, f, s.w / 2, s.h / 2, lim); apply(); }

  function apply() {
    if (!doc || !view) return;
    const z = view.zoom;
    if (pic) {
      const m = st.overflow ? MARGIN : 0;
      pic.style.left = `${view.x - m * doc.W * z}px`; pic.style.top = `${view.y - m * doc.H * z}px`;
      pic.style.width = `${doc.W * (1 + 2 * m) * z}px`; pic.style.height = `${doc.H * (1 + 2 * m) * z}px`;
    }
    if (st.overflow) {
      const r = C.viewBoxRect(doc.W, doc.H, doc.info.viewBox, doc.info.par);
      vbBox.style.left = `${view.x + r.x * z}px`; vbBox.style.top = `${view.y + r.y * z}px`;
      vbBox.style.width = `${r.w * z}px`; vbBox.style.height = `${r.h * z}px`;
      vbBox.firstChild.textContent = doc.info.viewBox ? `viewBox ${doc.info.rawViewBox.trim()}` : 'No viewBox: the outline is the width and height';
      vbBox.hidden = false;
    } else vbBox.hidden = true;
    zoomText.textContent = `${z >= 10 ? Math.round(z * 100) : (z * 100).toPrecision(3).replace(/\.?0+$/, '')} %`;
    const s = stageSize();
    st.view = { zoom: z, cx: (s.w / 2 - view.x) / z, cy: (s.h / 2 - view.y) / z, W: doc.W, H: doc.H };
    save();
  }

  // ---------- background ----------
  function setBackground(bg, fromUser) {
    const mode = bg && ['checker', 'white', 'black', 'theme', 'custom'].includes(bg.mode) ? bg.mode : 'checker';
    const color = bg && /^#[0-9a-f]{6}$/i.test(bg.color || '') ? bg.color : '#ffffff';
    bgSelect.value = mode; bgColor.value = color; bgColor.hidden = mode !== 'custom';
    stage.dataset.bg = mode; symGrid.dataset.bg = mode;
    const fill = mode === 'custom' ? color : '';
    bgPane.style.background = fill; symGrid.style.setProperty('--tile-bg', fill || '');
    if (fromUser) vscode.postMessage({ type: 'background', mode, color });
  }
  bgSelect.addEventListener('change', () => setBackground({ mode: bgSelect.value, color: bgColor.value }, true));
  bgColor.addEventListener('input', () => setBackground({ mode: 'custom', color: bgColor.value }, true));

  function setOverflow(on) {
    st.overflow = !!on; save();
    vbBtn.setAttribute('aria-pressed', String(st.overflow));
    if (doc) render(true);
  }
  schemeSelect.addEventListener('change', () => { st.scheme = schemeSelect.value; save(); if (doc) render(true); });
  new MutationObserver(() => { if (doc && doc.hasScheme && (!st.scheme || st.scheme === 'auto')) render(true); })
    .observe(document.body, { attributes: true, attributeFilter: ['class'] });
  pngMode.addEventListener('change', () => { pngWidth.hidden = pngMode.value !== 'width'; st.png = { mode: pngMode.value, width: pngWidth.value }; save(); });
  pngWidth.addEventListener('change', () => { st.png = { mode: pngMode.value, width: pngWidth.value }; save(); });
  if (st.png) { pngMode.value = st.png.mode || '2'; pngWidth.value = st.png.width || '1024'; pngWidth.hidden = pngMode.value !== 'width'; } else pngMode.value = '2';
  vbBtn.setAttribute('aria-pressed', String(!!st.overflow));

  // ---------- drawing ----------
  /** The text that goes into the <img>: scheme forced, explicit size, and a margin when "viewBox" is on. */
  function drawText(forExport) {
    let t = doc.text;
    if (doc.hasScheme) t = C.applyColorScheme(t, scheme());
    const i = doc.info;
    if (forExport) return C.setRootAttrs(t, { width: forExport.w, height: forExport.h, ...(i.viewBox ? {} : { viewBox: `0 0 ${doc.W} ${doc.H}` }) });
    if (st.overflow) return C.setRootAttrs(t, C.overflowAttrs(doc.W, doc.H, i.viewBox, i.par, MARGIN));
    return C.setRootAttrs(t, { width: doc.W, height: doc.H, ...(i.viewBox ? {} : { viewBox: `0 0 ${doc.W} ${doc.H}` }) });
  }

  function render(keep) {
    const seq = ++renderSeq;
    const url = URL.createObjectURL(new Blob([drawText(null)], { type: 'image/svg+xml' }));
    const img = new Image();
    img.className = 'pic'; img.alt = name; img.draggable = false;
    const t0 = performance.now();
    busy.hidden = !!pic && doc.size < 2e6;
    img.onload = () => {
      if (seq !== renderSeq) { URL.revokeObjectURL(url); return; }
      busy.hidden = true; hideNotice(); setBanner(doc.deletedNote || '');
      if (pic) pic.replaceWith(img); else stage.insertBefore(img, vbBox);
      if (picUrl) URL.revokeObjectURL(picUrl);
      pic = img; picUrl = url;
      if (!keep || !view) view = restoreView() || fitView();
      apply();
      stage.dataset.ms = String(Math.round(performance.now() - t0));
      goodOnce = true; doc.drawn = true; renders++;
      vscode.postMessage({ type: 'rendered', ok: true });
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      if (seq !== renderSeq) return;
      busy.hidden = true;
      const why = doc.risk.entities ? ' The file declares XML entities in a DOCTYPE. The renderer stops when entities expand too far (a "billion laughs" file).' : '';
      if (pic) setBanner(`This version of the file could not be drawn, so the last good picture stays. Check the XML for an error.${why}`);
      else showNotice(`This SVG could not be drawn. The XML may be broken or not finished.${why}`, 'error');
      if (!goodOnce) vscode.postMessage({ type: 'rendered', ok: false });
    };
    img.src = url;
  }

  function restoreView() {
    const v = st.view;
    if (!v || !(v.zoom > 0) || Math.abs(v.W - doc.W) > 1e-6 || Math.abs(v.H - doc.H) > 1e-6) return null;
    const s = stageSize();
    const z = Math.min(Math.max(v.zoom, lim.min), lim.max);
    return { zoom: z, x: s.w / 2 - v.cx * z, y: s.h / 2 - v.cy * z };
  }

  /** Message bytes as a Uint8Array, whatever shape the message channel gave them. */
  function asBytes(b) {
    if (b instanceof Uint8Array) return b;
    if (b instanceof ArrayBuffer) return new Uint8Array(b);
    if (ArrayBuffer.isView(b)) return new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
    if (b && b.type === 'Buffer' && Array.isArray(b.data)) return Uint8Array.from(b.data);
    if (b && typeof b === 'object') { const n = Object.keys(b).length; const u = new Uint8Array(n); for (let i = 0; i < n; i++) u[i] = b[i] | 0; return u; }
    return new Uint8Array(0);
  }
  function decode(raw) {
    let bytes = asBytes(raw);
    // TextDecoder refuses views on a SharedArrayBuffer: copy those first
    if (typeof SharedArrayBuffer !== 'undefined' && bytes.buffer instanceof SharedArrayBuffer) bytes = bytes.slice();
    if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes);
    if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes);
    try { return new TextDecoder('utf-8').decode(bytes); } catch { return new TextDecoder('utf-8').decode(bytes.slice()); }
  }

  function onContent(m) {
    pendingLarge = null;
    const text = decode(m.bytes);
    const info = C.rootInfo(text);
    if (!info) {
      doc = doc && doc.drawn ? doc : null;
      if (pic) setBanner('This version has no <svg> root element yet, so the last good picture stays.');
      else showNotice('This file has no <svg> root element, so there is nothing to draw.', 'error');
      if (!goodOnce) vscode.postMessage({ type: 'rendered', ok: false });
      return;
    }
    const size = C.intrinsicSize(info);
    const old = doc;
    const symbols = C.listSymbols(text, 100000);
    doc = {
      text, info, W: size.w, H: size.h, assumed: size.assumed, size: m.size, unpacked: m.unpacked, svgz: m.svgz,
      hasScheme: C.hasColorScheme(text), risk: C.riskScan(text), elements: C.countElements(text), symbols, source: m.source,
      deletedNote: '',
    };
    updateLimits();
    // keep the view when the picture size is the same; otherwise keep the zoom and the centre
    let keep = !!(old && view && old.W === doc.W && old.H === doc.H);
    if (old && view && !keep) {
      const s = stageSize(); const z = Math.min(Math.max(view.zoom, lim.min), lim.max);
      const cx = (s.w / 2 - view.x) / view.zoom, cy = (s.h / 2 - view.y) / view.zoom;
      view = { zoom: z, x: s.w / 2 - cx * z, y: s.h / 2 - cy * z }; keep = true;
    }
    schemeSelect.hidden = !doc.hasScheme; schemeSelect.value = st.scheme || 'auto';
    symBtn.hidden = symbols.length === 0;
    symBtn.textContent = symbols.length ? `Symbols (${symbols.length})` : 'Symbols';
    status1();
    if (symbols.length && st.symbols == null && !info.viewBox && info.width == null && info.height == null) st.symbols = true; // a pure sprite sheet
    if (!symbols.length && st.symbols) st.symbols = false;
    setSymbols(!!st.symbols, true);
    render(keep);
  }

  function status1() {
    const i = doc.info;
    const dim = `${C.fmtNum(doc.W)} × ${C.fmtNum(doc.H)} px`;
    sDims.textContent = doc.assumed ? `${dim} (no size in the file, browser default)` : dim;
    sDims.title = `width ${i.rawWidth == null ? 'not set' : i.rawWidth}, height ${i.rawHeight == null ? 'not set' : i.rawHeight}`;
    sVb.textContent = i.viewBox ? `viewBox ${i.rawViewBox.trim()}` : 'no viewBox';
    sSize.textContent = doc.svgz ? `${C.fmtSize(doc.size)} (.svgz, ${C.fmtSize(doc.unpacked)} unpacked)` : C.fmtSize(doc.size);
    if (doc.source === 'editor') sSize.textContent += ', unsaved edits';
    sElems.textContent = `${C.fmtNum(doc.elements)} elements` + (doc.symbols.length ? `, ${C.fmtNum(doc.symbols.length)} symbols` : '');
    const r = doc.risk; const parts = [];
    if (r.scripts) parts.push(`${r.scripts} script${r.scripts > 1 ? 's' : ''}`);
    if (r.handlers) parts.push(`${r.handlers} event handler${r.handlers > 1 ? 's' : ''}`);
    if (r.foreignObject) parts.push(`${r.foreignObject} foreignObject`);
    if (r.external) parts.push(`${r.external} external link${r.external > 1 ? 's' : ''}`);
    sRisk.textContent = parts.length ? `Blocked: ${parts.join(', ')}` : '';
    sRisk.title = parts.length ? 'The preview draws the file as an image: scripts do not run and nothing is fetched from the network.' : '';
  }

  // ---------- large files ----------
  function onTooLarge(m) {
    pendingLarge = m;
    const i = m.info;
    const facts = i ? `\nThe file says: width ${i.rawWidth == null ? 'not set' : i.rawWidth}, height ${i.rawHeight == null ? 'not set' : i.rawHeight}, viewBox ${i.rawViewBox == null ? 'not set' : i.rawViewBox}.` : '';
    sSize.textContent = m.sizeText;
    if (m.refuse) {
      showNotice(`${m.name} is ${m.sizeText}. That is over the ${C.HARD_LIMIT_MB} MB that SVG Viewer can draw, so the file was not read.${facts}`, 'big');
      return;
    }
    const go = btn('Render it', 'Read and draw the whole file', () => { go.disabled = true; showNotice(`Reading and drawing ${m.sizeText}...`, 'big'); vscode.postMessage({ type: 'renderLarge' }); });
    showNotice(`${m.name} is ${m.sizeText}, over the ${m.limitMB} MB limit (setting svgViewer.maxFileMB). Large SVGs can take a while to draw, so only the first 64 KB was read.${facts}`, 'big', go);
    go.focus();
  }

  // ---------- pan and zoom ----------
  stage.addEventListener('wheel', (e) => {
    if (!doc || !view) return;
    e.preventDefault();
    const b = stage.getBoundingClientRect();
    const px = e.clientX - b.left, py = e.clientY - b.top;
    const dy = e.deltaMode === 1 ? e.deltaY * 33 : e.deltaMode === 2 ? e.deltaY * 400 : e.deltaY;
    const dx = e.deltaMode === 1 ? e.deltaX * 33 : e.deltaX;
    const zoomMode = e.ctrlKey || e.metaKey || (settings.mouseWheel !== 'scroll' && !e.shiftKey);
    if (zoomMode) view = C.zoomAt(view, Math.exp(-dy * (e.ctrlKey ? 0.01 : 0.002)), px, py, lim);
    else { view = { ...view, x: view.x - (e.shiftKey && !dx ? dy : dx), y: view.y - (e.shiftKey && !dx ? 0 : dy) }; }
    apply();
  }, { passive: false });

  let drag = null;
  stage.addEventListener('pointerdown', (e) => {
    if (!doc || !view || (e.button !== 0 && e.button !== 1)) return;
    if (e.target.closest && e.target.closest('.notice')) return;
    stage.focus({ preventScroll: true });
    drag = { id: e.pointerId, x: e.clientX, y: e.clientY, vx: view.x, vy: view.y };
    stage.setPointerCapture(e.pointerId); stage.classList.add('dragging'); e.preventDefault();
  });
  stage.addEventListener('pointermove', (e) => {
    if (drag && e.pointerId === drag.id) { view = { ...view, x: drag.vx + e.clientX - drag.x, y: drag.vy + e.clientY - drag.y }; apply(); }
    if (doc && view) {
      const b = stage.getBoundingClientRect();
      const px = (e.clientX - b.left - view.x) / view.zoom, py = (e.clientY - b.top - view.y) / view.zoom;
      const u = C.toUser(px, py, doc.W, doc.H, doc.info.viewBox, doc.info.par);
      sPos.textContent = `x ${C.fmtNum(u.x)}, y ${C.fmtNum(u.y)}`;
    }
  });
  const endDrag = (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    drag = null; stage.classList.remove('dragging');
    // a drag inside the picture is a pan, so the view is now "kept" (pan and zoom are restored on reload)
  };
  stage.addEventListener('pointerup', endDrag); stage.addEventListener('pointercancel', endDrag);
  stage.addEventListener('pointerleave', () => { sPos.textContent = ''; });
  stage.addEventListener('dblclick', (e) => {
    if (!doc || !view || (e.target.closest && e.target.closest('.notice'))) return;
    const b = stage.getBoundingClientRect();
    view = C.zoomAt(view, e.altKey ? 0.5 : 2, e.clientX - b.left, e.clientY - b.top, lim); apply();
  });
  document.addEventListener('keydown', (e) => {
    if (!doc || !view || e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const k = e.key;
    const pan = (dx, dy) => { view = { ...view, x: view.x + dx, y: view.y + dy }; apply(); };
    if (k === '+' || k === '=') zoomCenter(1.25);
    else if (k === '-' || k === '_') zoomCenter(1 / 1.25);
    else if (k === '0') fit();
    else if (k === '1') actual();
    else if (k === 'v' || k === 'V') setOverflow(!st.overflow);
    else if (k === 'ArrowLeft') pan(50, 0);
    else if (k === 'ArrowRight') pan(-50, 0);
    else if (k === 'ArrowUp') pan(0, 50);
    else if (k === 'ArrowDown') pan(0, -50);
    else return;
    e.preventDefault();
  });
  let lastStage = null;
  new ResizeObserver(() => {
    const s = stageSize();
    if (doc && view && lastStage) { // keep the picture centre in the centre
      view = { ...view, x: view.x + (s.w - lastStage.w) / 2, y: view.y + (s.h - lastStage.h) / 2 };
      updateLimits(); apply();
    }
    lastStage = s;
  }).observe(stage);

  // ---------- PNG ----------
  function loadImage(url) {
    return new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('The SVG could not be drawn for export.')); i.src = url; });
  }
  async function pngBlob() {
    const mode = pngMode.value === 'width' ? 'width' : 'scale';
    const size = C.pngSize(doc.W, doc.H, mode, mode === 'width' ? pngWidth.value : pngMode.value);
    const url = URL.createObjectURL(new Blob([drawText(size)], { type: 'image/svg+xml' }));
    try {
      const img = await loadImage(url);
      const c = document.createElement('canvas'); c.width = size.w; c.height = size.h;
      const ctx = c.getContext('2d');
      ctx.drawImage(img, 0, 0, size.w, size.h);
      const blob = await new Promise((res, rej) => {
        try { c.toBlob((b) => (b ? res(b) : rej(new Error('The browser could not make a PNG of this size.'))), 'image/png'); } catch (e) { rej(e); }
      });
      return { blob, size, mode };
    } finally { URL.revokeObjectURL(url); }
  }
  function exportError(e) {
    const msg = e && e.name === 'SecurityError'
      ? 'The browser blocks PNG export for this SVG (it has a <foreignObject>). Save PNG and Copy PNG work for SVGs without one.'
      : `PNG export failed: ${e && e.message ? e.message : e}`;
    showToast(msg, true);
  }
  async function exportPng(how) {
    if (!doc) return;
    if (how === 'copy') {
      // ClipboardItem with a promise keeps the click as the user gesture while the PNG is made. If the webview may
      // not write images to the clipboard, VS Code (the extension host) copies the PNG instead.
      const made = pngBlob();
      made.catch(() => {});
      let r;
      try { r = await made; } catch (e) { exportError(e); return; }
      try {
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': r.blob })]);
        showToast(`Copied a ${r.size.w} \u00d7 ${r.size.h} PNG to the clipboard.${r.size.clamped ? ' It was made smaller to fit the browser canvas limit.' : ''}`);
      } catch {
        const data = new Uint8Array(await r.blob.arrayBuffer());
        vscode.postMessage({ type: 'copyPng', data, w: r.size.w, h: r.size.h });
      }
      return;
    }
    try {
      const r = await pngBlob();
      const base = name.replace(/\.svgz?$/i, '');
      const fileName = r.mode === 'width' ? `${base}-${r.size.w}w.png` : `${base}@${pngMode.value}x.png`;
      const data = new Uint8Array(await r.blob.arrayBuffer());
      st.lastPng = { w: r.size.w, h: r.size.h, clamped: r.size.clamped }; save();
      vscode.postMessage({ type: 'savePng', data, name: fileName });
    } catch (e) { exportError(e); }
  }

  // ---------- sprite sheet ----------
  let symBuiltFor = null;
  function setSymbols(on, quiet) {
    st.symbols = !!on; save();
    symBtn.setAttribute('aria-pressed', String(!!on));
    symPanel.hidden = !on; stage.hidden = !!on;
    if (on && doc && symBuiltFor !== doc) buildSymbols();
    if (!on && !quiet && doc && view) requestAnimationFrame(apply);
  }
  function buildSymbols() {
    symBuiltFor = doc;
    symGrid.textContent = '';
    const list = doc.symbols;
    if (doc.risk.entities || doc.text.length > SYMBOL_PARSE_LIMIT) {
      symCount.textContent = `${list.length} symbols. The tiles are not drawn for this file (${doc.risk.entities ? 'it declares XML entities' : 'it is over 30 MB'}).`;
      for (const s of list.slice(0, SYMBOL_TILE_LIMIT)) symGrid.append(tile(s.id, '', ''));
      return;
    }
    const parsed = new DOMParser().parseFromString(doc.text, 'image/svg+xml');
    if (parsed.getElementsByTagName('parsererror').length) {
      symCount.textContent = `${list.length} symbols. The file has an XML error, so the tiles are not drawn.`;
      return;
    }
    const ser = new XMLSerializer();
    const root = parsed.documentElement;
    // shared <defs> and <style> (gradients, clip paths, classes), without the symbols themselves
    let shared = '';
    for (const c of Array.from(root.children)) {
      if (c.localName !== 'defs' && c.localName !== 'style') continue;
      const copy = c.cloneNode(true);
      for (const s of Array.from(copy.getElementsByTagNameNS('*', 'symbol'))) s.remove();
      shared += ser.serializeToString(copy);
    }
    if (shared.length > 300000) shared = '';
    const syms = Array.from(parsed.getElementsByTagNameNS('*', 'symbol'));
    symCount.textContent = `${syms.length} symbols` + (syms.length > SYMBOL_TILE_LIMIT ? `, showing the first ${SYMBOL_TILE_LIMIT}` : '');
    const io = new IntersectionObserver((entries) => {
      for (const en of entries) if (en.isIntersecting) { const img = en.target.querySelector('img'); if (img && img.dataset.src) { img.src = img.dataset.src; delete img.dataset.src; } io.unobserve(en.target); }
    }, { root: symPanel, rootMargin: '200px' });
    const ns = 'xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"';
    let src = doc.hasScheme ? scheme() : null;
    for (const s of syms.slice(0, SYMBOL_TILE_LIMIT)) {
      const vb = s.getAttribute('viewBox') || '';
      const inner = Array.from(s.childNodes).map((n) => ser.serializeToString(n)).join('');
      let svg = `<svg ${ns}${vb ? ` viewBox="${vb.replace(/"/g, '')}"` : ''} width="64" height="64">${shared}${inner}</svg>`;
      if (src) svg = C.applyColorScheme(svg, src);
      const t = tile(s.getAttribute('id') || '', vb, 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg));
      symGrid.append(t); io.observe(t);
    }
  }
  function tile(id, vb, src) {
    const label = id || '(no id)';
    const img = h('img', { alt: '', draggable: 'false' });
    if (src) img.dataset.src = src;
    const t = h('button', { type: 'button', class: 'tile', role: 'listitem', title: id ? `<use href="#${id}"/>${vb ? `\nviewBox ${vb}` : ''}` : 'This symbol has no id', 'data-id': id },
      h('span', { class: 'tilepic' }, img), h('span', { class: 'tileid' }, label));
    t.addEventListener('click', () => {
      if (!id) { showToast('This symbol has no id, so it cannot be used with <use>.', true); return; }
      vscode.postMessage({ type: 'copyText', text: `<use href="#${id}"/>`, what: `<use href="#${id}"/>` });
    });
    return t;
  }
  symFilter.addEventListener('input', () => {
    const q = symFilter.value.trim().toLowerCase();
    let shown = 0;
    for (const t of symGrid.children) { const ok = !q || t.dataset.id.toLowerCase().includes(q); t.hidden = !ok; if (ok) shown++; }
    if (doc) symCount.textContent = q ? `${shown} of ${doc.symbols.length} symbols` : `${doc.symbols.length} symbols`;
  });

  // ---------- messages ----------
  window.addEventListener('message', (ev) => {
    const m = ev.data;
    if (!m || typeof m.type !== 'string') return;
    switch (m.type) {
      case 'init':
        name = m.name; st.uri = m.uri; save();
        settings.mouseWheel = m.mouseWheel;
        setBackground(m.background, false);
        break;
      case 'settings': settings.mouseWheel = m.mouseWheel; break;
      case 'background': setBackground(m.background, false); break;
      case 'content': onContent(m); break;
      case 'tooLarge': onTooLarge(m); break;
      case 'deleted':
        if (doc) { doc.deletedNote = `${m.name} is not on disk right now. The last picture stays, and the view updates when the file is written again.`; setBanner(doc.deletedNote); }
        else showNotice(`${m.name} could not be read. ${m.message || 'It may have been deleted.'}`, 'error');
        break;
      case 'error':
        if (pic) setBanner(m.message); else showNotice(m.message, 'error');
        break;
      case 'notice': showToast(m.text, m.error); break;
      case 'saved':
        if (m.cancelled) break;
        showToast(`Saved ${m.path} (${st.lastPng ? `${st.lastPng.w} × ${st.lastPng.h} px, ` : ''}${C.fmtSize(m.bytes)}).${st.lastPng && st.lastPng.clamped ? ' It was made smaller to fit the browser canvas limit.' : ''}`);
        break;
      default:
    }
  });

  // Test probe for the release check (read-only).
  window.svgViewerProbe = () => ({
    loaded: !!(doc && pic && view), name, W: doc && doc.W, H: doc && doc.H, view, lim, overflow: !!st.overflow, scheme: doc && doc.hasScheme ? scheme() : null,
    bg: stage.dataset.bg, banner: banner.hidden ? '' : banner.textContent, notice: notice.hidden ? '' : notice.textContent,
    symbols: doc ? doc.symbols.length : 0, tiles: symGrid.children.length, symbolsOpen: !!st.symbols, ms: Number(stage.dataset.ms || 0),
    pic: pic ? { left: parseFloat(pic.style.left), top: parseFloat(pic.style.top), width: parseFloat(pic.style.width), height: parseFloat(pic.style.height), nw: pic.naturalWidth, nh: pic.naturalHeight } : null,
    vbox: vbBox.hidden ? null : { left: parseFloat(vbBox.style.left), top: parseFloat(vbBox.style.top), width: parseFloat(vbBox.style.width), height: parseFloat(vbBox.style.height) },
    status: status.innerText, risk: doc ? doc.risk : null, lastPng: st.lastPng || null, pending: !!pendingLarge, renders,
  });
  // Colour of the drawn picture at a point (fractions of the viewport), for the release check.
  window.svgViewerPixel = (fx, fy) => {
    if (!pic) return null;
    const k = st.overflow ? MARGIN : 0;
    const w = pic.naturalWidth || 1, hh = pic.naturalHeight || 1;
    const x = Math.min(w - 1, Math.floor(w * (k + fx) / (1 + 2 * k)));
    const y = Math.min(hh - 1, Math.floor(hh * (k + fy) / (1 + 2 * k)));
    const c = document.createElement('canvas'); c.width = 1; c.height = 1;
    const ctx = c.getContext('2d'); ctx.drawImage(pic, x, y, 1, 1, 0, 0, 1, 1);
    const d = ctx.getImageData(0, 0, 1, 1).data; return [d[0], d[1], d[2], d[3]];
  };


  vscode.postMessage({ type: 'ready' });
}());
