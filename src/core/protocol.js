'use strict';
// Host-side checks: webview messages, .svgz decompression with a size cap, and the head of a large file.
// No vscode import, so the tests can call everything here.
const zlib = require('zlib');
const { MB, HARD_LIMIT_MB } = require('./svgcore');

const BACKGROUNDS = ['checker', 'white', 'black', 'theme', 'custom'];
const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const str = (v, max) => typeof v === 'string' && v.length <= max;

/** Only known webview messages pass, with checked fields. Everything else is dropped. */
function validateWebviewMessage(m) {
  if (!m || typeof m !== 'object' || typeof m.type !== 'string') return { ok: false };
  switch (m.type) {
    case 'ready':
    case 'renderLarge':
    case 'copyDataUri':
    case 'openSource':
      return { ok: true, msg: { type: m.type } };
    case 'rendered':
      return { ok: true, msg: { type: 'rendered', ok: m.ok === true } };
    case 'background': {
      if (!BACKGROUNDS.includes(m.mode)) return { ok: false };
      const color = typeof m.color === 'string' && /^#[0-9a-f]{6}$/i.test(m.color) ? m.color : '';
      return { ok: true, msg: { type: 'background', mode: m.mode, color } };
    }
    case 'copyText':
      if (!str(m.text, 100000) || !m.text) return { ok: false };
      return { ok: true, msg: { type: 'copyText', text: m.text, what: str(m.what, 80) ? m.what : '' } };
    case 'copyPng': {
      if (!(m.data instanceof Uint8Array) || m.data.length < 8 || m.data.length > 512 * MB) return { ok: false };
      if (!PNG_SIG.every((b, i) => m.data[i] === b)) return { ok: false };
      return { ok: true, msg: { type: 'copyPng', data: m.data, w: Number(m.w) | 0, h: Number(m.h) | 0 } };
    }
    case 'savePng': {
      if (!(m.data instanceof Uint8Array) || m.data.length < 8 || m.data.length > 512 * MB) return { ok: false };
      if (!PNG_SIG.every((b, i) => m.data[i] === b)) return { ok: false };
      const name = str(m.name, 200) && /^[^/\\:*?"<>|\x00-\x1f]+\.png$/i.test(m.name) ? m.name : 'image.png';
      return { ok: true, msg: { type: 'savePng', data: m.data, name } };
    }
    default:
      return { ok: false };
  }
}

/** True when the bytes start with the gzip magic number. */
function isGzip(bytes) {
  return !!bytes && bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
}

/**
 * Inflate .svgz bytes. Stops at limitBytes, so a small "zip bomb" cannot fill memory.
 * Resolves { bytes } or { error }.
 */
function gunzipCapped(bytes, limitBytes) {
  const limit = Math.max(1, Math.min(limitBytes || HARD_LIMIT_MB * MB, HARD_LIMIT_MB * MB));
  return new Promise((resolve) => {
    zlib.gunzip(bytes, { maxOutputLength: limit }, (err, out) => {
      if (!err) { resolve({ bytes: new Uint8Array(out.buffer, out.byteOffset, out.byteLength) }); return; }
      if (err.code === 'ERR_BUFFER_TOO_LARGE' || /Cannot create a Buffer larger|maxOutputLength|too large/i.test(err.message)) {
        resolve({ error: `The unpacked file is larger than ${Math.round(limit / MB)} MB, so it was not drawn.`, tooLarge: true });
      } else {
        resolve({ error: `This .svgz file could not be unpacked (${err.code || err.message}).` });
      }
    });
  });
}

/** The size of the decoded text in bytes, and whether it is UTF-16 (BOM). */
function decodeHint(bytes) {
  if (bytes.length >= 2 && ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff))) return 'utf-16';
  return 'utf-8';
}

module.exports = { BACKGROUNDS, validateWebviewMessage, isGzip, gunzipCapped, decodeHint };
