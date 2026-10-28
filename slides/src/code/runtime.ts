// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
/**
 * The code sandbox's own source: what runs INSIDE the sandboxed frame.
 *
 * THE BOUNDARY (docs/DECISIONS.md, FORK code layer). A deck's code never runs
 * in this page. It runs in a Worker started inside an `<iframe sandbox=
 * "allow-scripts">` (no allow-same-origin: an OPAQUE origin — no cookies, no
 * localStorage, no IndexedDB, no reach into this document) whose srcdoc
 * carries a Content-Security-Policy of `default-src 'none'` (no fetch, no
 * WebSocket, no images, no fonts from anywhere — the worker inherits it). The
 * worker has no DOM, so it cannot navigate the frame either; the frame's own
 * bootstrap below is ours and only relays messages. Probed in Chromium:
 * fetch refused by CSP (a securitypolicyviolation, not a CORS failure),
 * storage throws SecurityError, an ES module imports from a blob, and an
 * OffscreenCanvas renders and encodes a PNG for the poster.
 *
 * Determinism, enforced rather than requested: inside the worker Math.random
 * is a seeded generator re-seeded for every call, and Date.now /
 * performance.now are frozen at 0. A script cannot own a clock.
 *
 * HARD RULE: no tag-shaped text may appear in the bundle (sandboxSrcdoc says
 * why). The srcdoc's tags are swapped in at runtime.
 */

/** The worker: loads scripts as ES modules from blobs, evaluates on request. */
const WORKER = `'use strict';
var rng = function () { return 0.5 };
Math.random = function () { return rng() };
try { Date.now = function () { return 0 } } catch (e) {}
try { Object.defineProperty(performance, 'now', { value: function () { return 0 } }) } catch (e) {}
function seedOf(s) { var h = 2166136261 >>> 0; for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0 } return h >>> 0 }
function mulberry(a) { return function () { a |= 0; a = (a + 0x6D2B79F5) | 0; var t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296 } }
function makeNoise(seed) { var r = mulberry(seed), v = new Float64Array(256); for (var i = 0; i < 256; i++) v[i] = r() * 2 - 1;
  return function (x) { var i = Math.floor(x), f = x - i, a = v[i & 255], b = v[(i + 1) & 255], u = f * f * (3 - 2 * f); return a + (b - a) * u } }
var lerp = function (a, b, t) { return a + (b - a) * t };
var clamp = function (v, a, b) { return Math.min(b, Math.max(a, v)) };
var mods = new Map();
async function load(name, src) {
  var key = seedOf(src) + ':' + src.length, have = mods.get(name);
  if (have && have.key === key) return have.mod;
  var url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
  try { var mod = await import(url); mods.set(name, { key: key, mod: mod }); return mod } finally { URL.revokeObjectURL(url) }
}
function cleanMeta(m) { try { return JSON.parse(JSON.stringify(m == null ? {} : m)) } catch (e) { return {} } }
function withParams(meta, params) {
  var out = {}, decl = (meta && meta.params) || {}, k;
  for (k in decl) { var d = decl[k] || {}; out[k] = params && params[k] !== undefined ? params[k] : d['default'] }
  for (k in (params || {})) if (!(k in out)) out[k] = params[k];
  return out;
}
var ALL = ['x', 'y', 'rotation', 'scale', 'opacity', 'fill', 'color'];
var canvas = null, g = null;
self.onmessage = async function (ev) {
  var m = ev.data || {};
  try {
    if (m.type === 'load') {
      var mod = await load(m.name, m.src);
      self.postMessage({ type: 'loaded', req: m.req, meta: cleanMeta(mod.meta), hasDefault: typeof mod['default'] === 'function' });
    } else if (m.type === 'bake') {
      var mod2 = await load(m.name, m.src), meta = cleanMeta(mod2.meta), params = withParams(meta, m.params);
      var drives = Array.isArray(meta.drives) ? meta.drives.filter(function (k) { return ALL.indexOf(k) >= 0 }) : ALL;
      var seed = seedOf(String(m.seed)), noise = makeNoise(seed ^ 0x9e3779b9), out = new Array(m.samples.length);
      for (var i = 0; i < m.samples.length; i++) {
        var s = m.samples[i];
        rng = mulberry(seed);
        var ctx = { t: s.t, p: s.p, duration: m.duration, click: m.click, el: m.el, slide: m.slide, random: function () { return rng() }, noise: noise, lerp: lerp, clamp: clamp };
        var r = mod2['default'](s.p, Object.freeze(Object.assign({}, s.base)), params, ctx), f = {};
        if (r && typeof r === 'object') for (var j = 0; j < drives.length; j++) {
          var key = drives[j], v = r[key];
          if (typeof v === 'number' ? isFinite(v) : (typeof v === 'string' && v.length < 64)) f[key] = v;
        }
        out[i] = f;
      }
      self.postMessage({ type: 'baked', req: m.req, frames: out });
    } else if (m.type === 'canvas-init') {
      canvas = m.canvas; g = canvas.getContext('2d');
      self.postMessage({ type: 'inited', req: m.req });
    } else if (m.type === 'draw' || m.type === 'poster') {
      var mod3 = await load(m.name, m.src), meta3 = cleanMeta(mod3.meta), dpr = m.dpr || 1;
      var W = Math.max(1, Math.round(m.width * dpr)), H = Math.max(1, Math.round(m.height * dpr));
      if (canvas.width !== W) canvas.width = W;
      if (canvas.height !== H) canvas.height = H;
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.clearRect(0, 0, m.width, m.height);
      var seed3 = seedOf(String(m.seed));
      rng = mulberry(seed3);
      var ctx3 = { click: m.click, t: m.t, params: withParams(meta3, m.params), width: m.width, height: m.height, dpr: dpr, random: function () { return rng() }, noise: makeNoise(seed3 ^ 0x9e3779b9), lerp: lerp, clamp: clamp };
      g.save(); mod3['default'](g, ctx3); g.restore();
      if (m.type === 'poster') {
        var blob = await canvas.convertToBlob({ type: 'image/png' });
        self.postMessage({ type: 'poster', req: m.req, url: new FileReaderSync().readAsDataURL(blob) });
      } else self.postMessage({ type: 'drawn', req: m.req });
    }
  } catch (err) {
    self.postMessage({ type: 'error', req: m.req, message: String((err && err.message) || err), stack: String((err && err.stack) || '') });
  }
};`

/**
 * The frame's bootstrap: start the worker (again, on reset — the host's
 * watchdog kills a runaway script this way, from outside its thread), hand it
 * a canvas when asked, and relay messages. Accepts messages only from the
 * window that embedded it.
 */
const BOOT = `(function () {
  var SRC = ${JSON.stringify(WORKER)};
  var w = null;
  function start() {
    w = new Worker(URL.createObjectURL(new Blob([SRC], { type: 'text/javascript' })));
    w.onmessage = function (e) { parent.postMessage(e.data, '*') };
    w.onerror = function (e) { e.preventDefault(); parent.postMessage({ type: 'fatal', message: String(e.message || 'the script crashed') }, '*') };
  }
  start();
  addEventListener('message', function (e) {
    if (e.source !== parent) return;
    var m = e.data;
    if (!m || typeof m !== 'object') return;
    if (m.type === 'reset') { w.terminate(); document.body.textContent = ''; start(); parent.postMessage({ type: 'reset', req: m.req }, '*'); return }
    if (m.type === 'canvas-init') {
      document.body.textContent = '';
      var c = document.createElement('canvas');
      document.body.appendChild(c);
      var oc = c.transferControlToOffscreen();
      var msg = Object.assign({}, m, { canvas: oc });
      w.postMessage(msg, [oc]);
      return;
    }
    w.postMessage(m);
  });
  parent.postMessage({ type: 'ready' }, '*');
})();`

/** The sandbox's Content-Security-Policy: scripts only inline (ours) and from blobs (the worker, the deck's modules). */
export const SANDBOX_CSP = "default-src 'none'; script-src 'unsafe-inline' blob:; worker-src blob:; style-src 'unsafe-inline'"

/**
 * The frame's whole document.
 *
 * Written with `‹` for every `<` and swapped at runtime: no tag-shaped text
 * may sit in the bundle. Not just the end-of-script tag (the shell would close
 * early) — the build's compressor (scripts/postbuild-compress.mjs) finds the
 * shell's real `</head>` and `<body` by searching for them, and the module
 * script is inlined ABOVE both, so a literal here was matched first: the
 * shell shipped its runtime twice, half of it uncompressed. esbuild folds
 * `'<' + 'body'` straight back into a literal, so the swap has to be a call
 * it cannot evaluate.
 */
export function sandboxSrcdoc(): string {
  const LT = String.fromCharCode(60)
  return ('‹!doctype html>‹html>‹head>‹meta charset="utf-8">'
    + `‹meta http-equiv="Content-Security-Policy" content="${SANDBOX_CSP}">`
    + '‹style>html,body{margin:0;width:100%;height:100%;overflow:hidden;background:transparent}canvas{display:block;width:100%;height:100%}‹/style>'
    + '‹/head>‹body>‹script>' + BOOT + '‹/script>‹/body>‹/html>').replace(/‹/g, LT)
}

/** Exposed for the isolation rig. */
export const _WORKER_SOURCE = WORKER
