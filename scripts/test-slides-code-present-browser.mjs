// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// The code layer in a real slideshow, in the built shell (FORK).
//
//   npm run build:single --prefix slides && node scripts/test-slides-code-present-browser.mjs
//
// WHAT THIS PROVES — measured (bounding boxes, screenshot pixels), on the
// anim engine's manual clock:
//   1. a SCRIPT EFFECT layers on a UI effect: a move (x) runs with a script
//      that drives y; mid-click the element sits at the move's x and the
//      script's y; ← lands back exactly; the script's own parameter is used
//   2. a CODE CANVAS draws live in its sandbox frame, on the show's clock:
//      what it paints moves with (click, t), holds at its declared duration,
//      and a click changes what it draws
//   3. the viewer switch (speaker window "ƒ") turns code off mid-show: the
//      canvas shows its poster, the script effect plays as its base (UI
//      effects only); on again, both come back
//   4. reduced motion shows the poster too
//   5. the morph out of a slide starts from the script's end state
//   6. a live canvas is see-through in the app's DARK theme: where the script
//      draws nothing, the slide shows (the frame once got an opaque white
//      backdrop there — its color-scheme differed from the sandbox page's)
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')
import { deflateSync, crc32 } from 'node:zlib'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { boxes, pixel, tick, openDeck, present } from './lib/present-probe.mjs'

let checks = 0
let failures = 0
function ok(cond, msg, detail) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}${detail !== undefined ? '  → ' + JSON.stringify(detail) : ''}`) } else console.log(`  ok    ${msg}`)
}
const near = (a, b, eps = 1.5) => Math.abs(a - b) <= eps
const SHELL = new URL('../slides/dist-single/Bento_Slides.bento.html', import.meta.url).href

/** A solid-colour PNG as a data URI (the canvas poster). */
function solidPng(w, h, [r, g, b]) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td) >>> 0)
    return Buffer.concat([len, td, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2
  const raw = Buffer.alloc((w * 3 + 1) * h)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) raw.set([r, g, b], y * (w * 3 + 1) + 1 + x * 3)
  const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
  return 'data:image/png;base64,' + png.toString('base64')
}

const WOBBLE = `export const meta = { kind: 'effect', label: 'Hop', drives: ['y'], params: { amp: { type: 'number', default: 20, min: 0, max: 400 } } }
export default function hop(p, base, params) { return { y: base.y - params.amp * Math.sin(p * Math.PI) } }`
// the bar's left edge is at 100 px per second, held at 2 s; click 0 paints green, click 1 blue
const BAR = `export const meta = { kind: 'canvas', duration: 2 }
export default function draw(g, ctx) {
  g.fillStyle = ctx.click === 0 ? '#00ff00' : '#0000ff'
  g.fillRect(0, 0, ctx.width, ctx.height)
  g.fillStyle = '#ff0000'
  g.fillRect(Math.min(ctx.t, 2) * 100, 0, 20, ctx.height)
}`

const rect = (id, x, y, w, h, fill, extra = {}) => ({
  id, type: 'shape', shape: 'rect', x, y, w, h, fill, stroke: 'none', strokeWidth: 0, radius: 0, rotation: 0, opacity: 1, ...extra,
})
const slide = (id, transition, elements, extra = {}) => ({ id, background: '#ffffff', transition, notes: '', elements, ...extra })
const DOC = {
  format: 'bento/slides', version: 1, title: 'code rig',
  size: { width: 1280, height: 720 },
  theme: { background: '#ffffff', color: '#111111', accent: '#ff9e8a', fontFamily: 'system-ui, sans-serif' },
  scripts: { hop: { src: WOBBLE }, bar: { src: BAR } },
  slides: [
    slide('c1', 'none', [
      rect('bob', 100, 300, 80, 80, '#ff00ff'),
      { id: 'cv', type: 'canvas', x: 700, y: 100, w: 300, h: 200, rotation: 0, opacity: 1, script: 'bar', poster: solidPng(30, 20, [255, 255, 0]) },
    ], {
      anim: [
        { id: 'm1', el: 'bob', type: 'move', trigger: 'click', dx: 400, dy: 0, duration: 1, ease: 'linear' },
        { id: 'w1', el: 'bob', type: 'script', trigger: 'with', script: 'hop', params: { amp: 120 }, duration: 1, ease: 'linear' },
      ],
    }),
    slide('c2', 'morph', [rect('bob', 500, 300, 80, 80, '#ff00ff')], { morphSeconds: 1, morphEase: 'linear' }),
  ],
}

// The shell itself. The sandbox's document is built from tag-shaped text,
// and the build's compressor finds the shell's real <body by searching for
// it — the module script sits above it, so a literal in the bundle was
// matched first and the splash's few CSS rules were taken from the wrong
// place: 718 KB of JavaScript shipped as a plaintext <style> block, doubling
// every file (the app still worked, and the conformance gate passed it).
{
  const shell = readFileSync(process.env.SHELL_FILE || fileURLToPath(SHELL), 'utf8')
  const styles = [...shell.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1].length)
  ok(styles.length > 0 && styles.every((n) => n < 16 * 1024),
    `the shell's plaintext <style> blocks are the splash's few rules (${styles.join(', ')} chars; shell ${Math.round(shell.length / 1024)} KB)`)
}

const browser = await chromium.launch()
const page = await (await browser.newContext({ viewport: { width: 1280, height: 720 } })).newPage()
const errors = []
page.on('pageerror', (e) => errors.push(String(e)))
await openDeck(page, SHELL, DOC)
await page.evaluate(() => window.bento.code.setEnabled(true))
await present(page)
const key = (k) => page.keyboard.press(k)
const bx = async () => (await boxes(page)).boxes
/** wait (real time) until the sandbox has answered: frames drawn, bakes landed */
const settle = async (ms = 400) => { await page.waitForTimeout(ms); await tick(page, 0) }
const isRed = ([r, g, b]) => r > 200 && g < 60 && b < 60
const isGreen = ([r, g, b]) => g > 200 && r < 60 && b < 60
const isBlue = ([r, g, b]) => b > 200 && r < 60 && g < 60
const isYellow = ([r, g, b]) => r > 200 && g > 200 && b < 60
await settle(800)

console.log('a code canvas draws on the show clock')
let px0 = await pixel(page, 710, 200)
let px150 = await pixel(page, 850, 200)
ok(isRed(px0) && isGreen(px150), `at click 0, t=0 the bar is at the left edge on green (${px0} / ${px150})`)
ok(await page.evaluate(() => !!document.querySelector('.bento-present-overlay section.present [data-el-id="cv"] iframe[sandbox="allow-scripts"]')),
  'the drawing lives in a sandboxed frame (sandbox="allow-scripts", nothing more)')
await tick(page, 1); await settle(200)
px0 = await pixel(page, 710, 200)
const px110 = await pixel(page, 810, 200)
ok(isGreen(px0) && isRed(px110), `one second later the bar has moved 100 px (${px0} / ${px110})`)
await tick(page, 5); await settle(200)
ok(isRed(await pixel(page, 910, 200)) && isGreen(await pixel(page, 990, 200)), 'it holds at its declared 2 s duration')

console.log('\na script effect layered on a move')
let b = await bx()
ok(near(b.bob.x, 100) && near(b.bob.y, 300), `click 0: the element at rest (${b.bob.x.toFixed(1)}, ${b.bob.y.toFixed(1)})`)
await key('ArrowRight'); await tick(page, 0.5)
b = await bx()
// move: x = 100 + 400·0.5; script: y = 300 − 120·sin(π/2)
ok(near(b.bob.x, 300) && near(b.bob.y, 180, 2), `mid-click: x from the move, y from the script (${b.bob.x.toFixed(1)}, ${b.bob.y.toFixed(1)}; want 300, 180)`)
await tick(page, 0.25)
b = await bx()
const want75 = 300 - 120 * Math.sin(0.75 * Math.PI)
ok(near(b.bob.x, 400) && near(b.bob.y, want75, 2), `at 0.75 s: (${b.bob.x.toFixed(1)}, ${b.bob.y.toFixed(1)}; want 400, ${want75.toFixed(1)})`)
await settle(200)
ok(isBlue(await pixel(page, 850, 200)), 'the click changed what the canvas draws (blue at click 1)')
await tick(page, 1)
b = await bx()
ok(near(b.bob.x, 500) && near(b.bob.y, 300, 2), `end of the click: (${b.bob.x.toFixed(1)}, ${b.bob.y.toFixed(1)})`)
await key('ArrowLeft'); await tick(page, 0)
b = await bx()
ok(near(b.bob.x, 100) && near(b.bob.y, 300), '← restores click 0 exactly')
await settle(200)
ok(isGreen(await pixel(page, 850, 200)), '…and the canvas is back on click 0')

console.log('\nthe viewer switch: code off in the speaker window')
const popupP = page.waitForEvent('popup')
await key('s')
const sv = await popupP
await sv.waitForLoadState()
const codeBtn = await sv.$('.sv-btn[data-nav="code"]')
ok(!!codeBtn && (await codeBtn.getAttribute('aria-pressed')) === 'true', 'the speaker window shows the "runs code" switch, on')
await codeBtn.click()
await settle(200)
ok(isYellow(await pixel(page, 850, 200)), 'code off: the canvas shows its poster')
ok(await page.evaluate(() => !document.querySelector('.bento-present-overlay iframe[sandbox]')), 'and no sandbox frame is left on the slide')
ok((await codeBtn.getAttribute('aria-pressed')) === 'false', 'the switch reads off')
await page.bringToFront()
await key('ArrowRight'); await tick(page, 0.5)
b = await bx()
ok(near(b.bob.x, 300) && near(b.bob.y, 300), `code off: the script effect plays as its base — the move alone (${b.bob.x.toFixed(1)}, ${b.bob.y.toFixed(1)})`)
await key('ArrowLeft'); await tick(page, 0)
await codeBtn.click()
await settle(800)
ok(isGreen(await pixel(page, 850, 200)), 'code on again: the canvas draws live')
await page.bringToFront()
await key('ArrowRight'); await tick(page, 0.5)
b = await bx()
ok(near(b.bob.y, 180, 2), `…and the script effect is back (y ${b.bob.y.toFixed(1)})`)
await tick(page, 1)

console.log('\nreduced motion')
await key('ArrowLeft'); await tick(page, 0)
await key('m'); await settle(200)
ok(isYellow(await pixel(page, 850, 200)), 'reduced motion: the canvas shows its poster')
await key('m'); await settle(800)
ok(isGreen(await pixel(page, 850, 200)), 'motion back: live again')

console.log('\nthe morph out starts from the script end state')
await key('ArrowRight'); await tick(page, 0.5)
// leave mid-click: the script has the element at its peak
await key('ArrowRight'); await tick(page, 0)
b = await boxes(page)
ok(b.slide === 'c2' && near(b.boxes.bob.x, 300, 2) && near(b.boxes.bob.y, 180, 3), `the morph starts where the script left it (${b.slide}: ${b.boxes.bob.x.toFixed(1)}, ${b.boxes.bob.y.toFixed(1)})`)
await tick(page, 1.2)
b = await boxes(page)
ok(near(b.boxes.bob.x, 500) && near(b.boxes.bob.y, 300), 'and lands on the next slide\'s frame')

console.log('\na live canvas is see-through in the dark theme too')
{
  // only a corner square is drawn: the rest of the canvas must show the slide behind it
  const DOT = `export const meta = { kind: 'canvas' }
export default function draw(g) { g.fillStyle = '#ff0000'; g.fillRect(0, 0, 40, 40) }`
  const DARK = {
    ...DOC, scripts: { dot: { src: DOT } },
    slides: [slide('d1', 'none', [{ id: 'cv', type: 'canvas', x: 700, y: 100, w: 300, h: 200, rotation: 0, opacity: 1, script: 'dot' }], { background: '#0f1420' })],
  }
  const dpage = await (await browser.newContext({ viewport: { width: 1280, height: 720 }, colorScheme: 'dark' })).newPage()
  dpage.on('pageerror', (e) => errors.push(String(e)))
  await openDeck(dpage, SHELL, DARK)
  await dpage.evaluate(() => window.bento.code.setEnabled(true))
  await present(dpage)
  await dpage.waitForTimeout(800); await tick(dpage, 0)
  const scheme = await dpage.evaluate(() => getComputedStyle(document.documentElement).colorScheme)
  const drawn = await pixel(dpage, 710, 110)
  const empty = await pixel(dpage, 900, 250)
  ok(scheme.includes('dark') && isRed(drawn), `the app is in its dark theme (color-scheme ${scheme}) and the canvas drew live (${drawn})`)
  ok(empty.every((v, i) => Math.abs(v - [15, 20, 32][i]) <= 3), `where it drew nothing the dark slide shows through, not white (${empty})`)
  await dpage.close()
}

ok(errors.length === 0, 'no page errors', errors)
await browser.close()
console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures ? 1 : 0)
