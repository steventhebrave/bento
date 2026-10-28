// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// The code sandbox's boundary, attacked from inside, in the built shell (FORK).
//
//   npm run build:single --prefix slides && node scripts/test-slides-code-sandbox-browser.mjs
//
// A deck's code is hostile until proven otherwise. Each probe below is a
// deck script trying to get out; the rig MEASURES the outcome from outside:
//   1. NETWORK — fetch, XHR, WebSocket, EventSource, dynamic import(),
//      importScripts and a nested worker all aim at a local HTTP server that
//      counts requests. Control: the same server answers the page itself.
//      Expected: zero requests from the sandbox.
//   2. REACH — no document, window, parent, top, localStorage; IndexedDB
//      refused; the clock frozen (Date.now and performance.now read 0). Each
//      result is painted as a stripe and read back as screenshot pixels.
//   3. A RUNAWAY — `while (true) {}` in a canvas: the page stays responsive
//      (the loop is in a worker), the watchdog terminates it, the poster
//      stays up, and the other canvases on the slide keep drawing.
//   4. DETERMINISM — a script effect that uses Math.random bakes to the same
//      frames on every show (seeded per effect), so a deck replays exactly.
//   5. THE SWITCH — code off: not one sandbox frame exists, in the editor or
//      in the show.
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')
import { createServer } from 'node:http'
import { boxes, pixel, tick, openDeck, present } from './lib/present-probe.mjs'

let checks = 0
let failures = 0
function ok(cond, msg, detail) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}${detail !== undefined ? '  → ' + JSON.stringify(detail) : ''}`) } else console.log(`  ok    ${msg}`)
}
const SHELL = new URL('../slides/dist-single/Bento_Slides.bento.html', import.meta.url).href

// the listener the sandbox must never reach
const hits = []
const server = createServer((req, res) => {
  hits.push(req.url)
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Content-Type', 'text/javascript')
  res.end('export default 1')
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const PORT = server.address().port
const URL_ = `http://127.0.0.1:${PORT}`

const NET = `const U = ${JSON.stringify(URL_)}
try { fetch(U + '/fetch').catch(() => {}) } catch (e) {}
try { const x = new XMLHttpRequest(); x.open('GET', U + '/xhr'); x.send() } catch (e) {}
try { new WebSocket(U.replace('http', 'ws') + '/ws') } catch (e) {}
try { new EventSource(U + '/sse') } catch (e) {}
try { import(U + '/import.js').catch(() => {}) } catch (e) {}
try { importScripts(U + '/importScripts.js') } catch (e) {}
try { const w = new Worker(URL.createObjectURL(new Blob(['fetch(' + JSON.stringify(U + '/nested') + ').catch(()=>{})']))) } catch (e) {}
try { navigator.sendBeacon && navigator.sendBeacon(U + '/beacon', 'x') } catch (e) {}
export const meta = { kind: 'canvas' }
export default function draw(g, ctx) {
  try { fetch(U + '/fetch-in-draw').catch(() => {}) } catch (e) {}
  g.fillStyle = '#00ff00'; g.fillRect(0, 0, ctx.width, ctx.height)
}`

// one stripe per probe: green = contained, red = escaped
const REACH = `export const meta = { kind: 'canvas' }
export default function draw(g, ctx) {
  const probes = [
    typeof document === 'undefined',
    typeof window === 'undefined',
    typeof parent === 'undefined' && typeof top === 'undefined',
    typeof localStorage === 'undefined' && typeof sessionStorage === 'undefined',
    (() => { try { indexedDB.open('bento-probe'); return false } catch (e) { return true } })(),
    Date.now() === 0 && performance.now() === 0,
  ]
  const w = ctx.width / probes.length
  probes.forEach((p, i) => { g.fillStyle = p ? '#00ff00' : '#ff0000'; g.fillRect(i * w, 0, w, ctx.height) })
}`

const RUNAWAY = `export const meta = { kind: 'canvas' }
export default function draw(g, ctx) { while (true) {} }`

const LIVE = `export const meta = { kind: 'canvas' }
export default function draw(g, ctx) {
  g.fillStyle = '#0000ff'; g.fillRect(0, 0, ctx.width, ctx.height)
  g.fillStyle = '#ffffff'; g.fillRect((ctx.t * 100) % ctx.width, 0, 10, ctx.height)
}`

const JITTER = `export const meta = { kind: 'effect', drives: ['x', 'y'] }
export default function jitter(p, base) { return { x: base.x + Math.random() * 100 * p, y: base.y + Math.random() * 100 * p } }`

const canvas = (id, x, y, w, h, script) => ({ id, type: 'canvas', x, y, w, h, rotation: 0, opacity: 1, script })
const slide = (id, elements, extra = {}) => ({ id, background: '#ffffff', transition: 'none', notes: '', elements, ...extra })
const DOC = {
  format: 'bento/slides', version: 1, title: 'sandbox rig',
  size: { width: 1280, height: 720 },
  theme: { background: '#ffffff', color: '#111111', accent: '#ff9e8a', fontFamily: 'system-ui, sans-serif' },
  scripts: { net: { src: NET }, reach: { src: REACH }, runaway: { src: RUNAWAY }, live: { src: LIVE }, jitter: { src: JITTER } },
  slides: [
    slide('p1', [
      canvas('cnet', 50, 50, 200, 100, 'net'),
      canvas('creach', 300, 50, 600, 100, 'reach'),
      { id: 'dot', type: 'shape', shape: 'rect', x: 100, y: 400, w: 40, h: 40, fill: '#ff00ff', stroke: 'none', strokeWidth: 0, radius: 0, rotation: 0, opacity: 1 },
    ], { anim: [{ id: 'j1', el: 'dot', type: 'script', trigger: 'click', script: 'jitter', duration: 1 }] }),
    slide('p2', [
      canvas('crun', 50, 50, 300, 200, 'runaway'),
      canvas('clive', 500, 50, 300, 200, 'live'),
    ]),
  ],
}

const browser = await chromium.launch()
const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } })
const page = await ctx.newPage()
const errors = []
page.on('pageerror', (e) => errors.push(String(e)))

// control: the server is reachable — from the page itself
await page.goto(SHELL)
await page.waitForFunction(() => !!window.bento?.loadDoc)
await page.evaluate((u) => fetch(u + '/control').then((r) => r.text()), URL_)
ok(hits.includes('/control'), `control: the page itself reaches the listener (${hits.join(', ')})`)
hits.length = 0

console.log('\ncode off: no sandbox at all')
await page.evaluate(() => window.bento.code.setEnabled(false))
await openDeck(page, SHELL, DOC)
await page.evaluate(() => window.bento.code.setEnabled(false))
await page.waitForTimeout(300)
ok(await page.evaluate(() => document.querySelectorAll('iframe[sandbox]').length) === 0, 'the editor starts no sandbox frame')
await present(page)
await page.waitForTimeout(500)
ok(await page.evaluate(() => document.querySelectorAll('iframe[sandbox]').length) === 0, 'the show starts no sandbox frame')
await page.keyboard.press('Escape')
await page.waitForFunction(() => !document.querySelector('.bento-present-overlay'))
await page.evaluate(() => window.bento.code.setEnabled(true))

console.log('\nnetwork and reach')
await openDeck(page, SHELL, DOC)
await present(page)
await page.waitForTimeout(1500); await tick(page, 0.1); await page.waitForTimeout(500)
ok(hits.length === 0, `no request left the sandbox (fetch, XHR, WebSocket, EventSource, import(), importScripts, nested worker, beacon) — ${hits.length ? hits.join(', ') : 'none'}`)
const [r, g, b] = await pixel(page, 150, 100)
ok(g > 200 && r < 60, `…and the network script still ran: it painted its canvas (${r},${g},${b})`)
const names = ['no document', 'no window', 'no parent/top', 'no local/session storage', 'IndexedDB refused', 'clock frozen at 0']
for (let i = 0; i < names.length; i++) {
  const [pr, pg] = await pixel(page, 300 + 100 * i + 50, 100)
  ok(pg > 200 && pr < 60, `inside the sandbox: ${names[i]}`, [pr, pg])
}
const frameAttrs = await page.evaluate(() => [...document.querySelectorAll('iframe[sandbox]')].map((f) => ({ sandbox: f.getAttribute('sandbox'), src: f.getAttribute('src'), csp: /default-src 'none'/.test(f.srcdoc) })))
ok(frameAttrs.length >= 3 && frameAttrs.every((f) => f.sandbox === 'allow-scripts' && !f.src && f.csp),
  `every frame is sandbox="allow-scripts" (no same-origin), srcdoc, with default-src 'none' (${frameAttrs.length} frames)`)

console.log('\ndeterminism')
const run = async () => {
  await page.keyboard.press('ArrowRight'); await tick(page, 0.5)
  const at = (await boxes(page)).boxes.dot
  await page.keyboard.press('ArrowLeft'); await tick(page, 0)
  return at
}
const a1 = await run()
await page.keyboard.press('Escape')
// the first show's fullscreen exit lands asynchronously, and a show that
// sees fullscreen end ends itself — let it land before starting the next
await page.waitForFunction(() => !document.querySelector('.bento-present-overlay') && !document.fullscreenElement)
await page.waitForTimeout(200)
await present(page)
await page.waitForTimeout(1200); await tick(page, 0)
const a2 = await run()
ok(Math.abs(a1.x - a2.x) < 0.01 && Math.abs(a1.y - a2.y) < 0.01 && (Math.abs(a1.x - 100) > 1 || Math.abs(a1.y - 400) > 1),
  `Math.random is seeded: two shows put the element at the same place (${a1.x.toFixed(2)},${a1.y.toFixed(2)} / ${a2.x.toFixed(2)},${a2.y.toFixed(2)})`)

console.log('\na runaway canvas')
await page.keyboard.press('ArrowRight'); await tick(page, 1.5) // p1's click
await page.keyboard.press('ArrowRight'); await tick(page, 0) // p2
ok((await boxes(page))?.slide === 'p2', 'on the runaway slide')
await page.waitForTimeout(300)
const t0 = Date.now()
await page.evaluate(() => 1)
const lag = Date.now() - t0
ok(lag < 250, `the page answers while the canvas spins forever (${lag} ms)`)
await page.waitForTimeout(600); await tick(page, 0.5); await page.waitForTimeout(300)
const [lr, lg, lb] = await pixel(page, 650, 150)
ok(lb > 200 && lr < 60 && lg < 60, `the canvas beside it keeps drawing (${lr},${lg},${lb})`)
await page.waitForTimeout(1800)
const stuck = await page.evaluate(() => document.querySelector('.bento-present-overlay section.present [data-el-id="crun"]')?.classList.contains('bento-canvas-live'))
ok(stuck === false, 'the runaway never drew, so its poster stays up')
const t1 = Date.now()
await page.evaluate(() => 1)
ok(Date.now() - t1 < 250, 'still responsive after the watchdog fired')

ok(errors.length === 0, 'no page errors', errors)
await browser.close()
server.close()
console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures ? 1 : 0)
