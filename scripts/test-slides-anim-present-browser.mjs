// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// The animation sequence in a real slideshow, in the built shell.
//
//   npm run build:single --prefix slides && node scripts/test-slides-anim-present-browser.mjs
//
// WHAT THIS PROVES — every number MEASURED (bounding boxes for geometry,
// screenshot pixels for opacity), on the anim engine's manual clock:
//   1. clicks: → plays one click; an entrance-first element starts hidden and
//      fades in; a move travels; a spin turns (its bounding box widens mid-turn
//      and is back to rest after 720°); an exit fades out
//   2. ← restores the previous click's end state exactly, and walks back to
//      the arrival state
//   3. → past the last click morphs into the next slide FROM the end state
//      (the moved arrow starts where it was left, not at its model position;
//      the gear's two turns do not unwind), with that slide's own morph
//      duration and cubic-bezier easing
//   4. ← from the next slide arrives fully played, morphing back to the end state
//   5. a legacy fx.step slide in the same deck still reveals on click
//   6. clicker keys (PageDown/PageUp) and the speaker window drive clicks
//   7. reduced motion lands each click on its end state at once
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')
import { boxes, pixel, tick, openDeck, present } from './lib/present-probe.mjs'
import { cubicBezier } from '../kernel/src/ease.ts'

let checks = 0
let failures = 0
function ok(cond, msg, detail) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}${detail !== undefined ? '  → ' + JSON.stringify(detail) : ''}`) } else console.log(`  ok    ${msg}`)
}
const near = (a, b, eps = 1.5) => Math.abs(a - b) <= eps
const SHELL = new URL('../slides/dist-single/Bento_Slides.bento.html', import.meta.url).href

const rect = (id, x, y, w, h, fill, extra = {}) => ({
  id, type: 'shape', shape: 'rect', x, y, w, h, fill, stroke: 'none', strokeWidth: 0, radius: 0, rotation: 0, opacity: 1, ...extra,
})
const slide = (id, transition, elements, extra = {}) => ({ id, background: '#ffffff', transition, notes: '', elements, ...extra })
const DOC = {
  format: 'bento/slides', version: 1, title: 'anim rig',
  size: { width: 1280, height: 720 },
  theme: { background: '#ffffff', color: '#111111', accent: '#ff9e8a', fontFamily: 'system-ui, sans-serif' },
  slides: [
    slide('s1', 'none', [
      rect('lab', 100, 100, 100, 100, '#0000ff'),
      rect('arrow', 100, 300, 120, 60, '#ff0000'),
      rect('gear', 600, 300, 200, 100, '#00aa00'),
      rect('box', 900, 100, 100, 100, '#000000'),
    ], {
      anim: [
        { id: 'a1', el: 'lab', type: 'fade-in', trigger: 'click', duration: 1, ease: 'linear' },
        { id: 'a2', el: 'arrow', type: 'move', trigger: 'with', dx: 300, dy: 0, duration: 1, ease: 'linear' },
        { id: 'a3', el: 'gear', type: 'spin', trigger: 'click', deg: 720, duration: 2, ease: 'linear' },
        { id: 'a4', el: 'box', type: 'fade-out', trigger: 'with', duration: 1, ease: 'linear' },
      ],
    }),
    slide('s2', 'morph', [
      rect('lab', 100, 100, 100, 100, '#0000ff'),
      rect('arrow', 700, 500, 120, 60, '#ff0000'),
      rect('gear', 600, 300, 200, 100, '#00aa00'),
      rect('box', 900, 100, 100, 100, '#000000'),
    ], { morphSeconds: 1, morphEase: [0.7, 0, 0.2, 1] }),
    slide('s3', 'none', [
      rect('plain', 100, 100, 100, 100, '#888888'),
      rect('stepped', 400, 100, 100, 100, '#ff00ff', { fx: { step: 1 } }),
    ]),
  ],
}

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } })
const errors = []
page.on('pageerror', (e) => errors.push(String(e)))
await openDeck(page, SHELL, DOC)
await present(page)

const key = async (k) => { await page.keyboard.press(k); await tick(page, 0) }
const bx = async () => (await boxes(page)).boxes
const isWhite = (p) => p.every((c) => c > 245)
const opacityOf = (p, ink) => {
  // fraction of the way from white to the ink colour, by the channel that moves most
  const i = ink.reduce((best, c, k) => (Math.abs(255 - c) > Math.abs(255 - ink[best]) ? k : best), 0)
  return (255 - p[i]) / (255 - ink[i])
}

console.log('\nclick 0 — arrival')
let b = await bx()
ok((await boxes(page)).slide === 's1', 'the show starts on s1')
ok(isWhite(await pixel(page, 150, 150)), 'entrance-first label is hidden on arrival (white where it sits)')
ok(near(b.arrow.x, 100), 'arrow at its model position', b.arrow)
ok(!isWhite(await pixel(page, 950, 150)), 'the box (exits later) is visible on arrival')

console.log('\nclick 1 — fade in WITH a move')
await key('ArrowRight')
await tick(page, 0.5)
b = await bx()
ok(near(b.arrow.x, 250), `arrow halfway (x ${b.arrow.x.toFixed(1)} ≈ 250)`)
const midLab = opacityOf(await pixel(page, 150, 150), [0, 0, 255])
ok(midLab > 0.4 && midLab < 0.6, `label half faded in (${midLab.toFixed(2)})`)
await tick(page, 0.6)
b = await bx()
ok(near(b.arrow.x, 400), `arrow travelled 300px (x ${b.arrow.x.toFixed(1)})`)
ok(near(opacityOf(await pixel(page, 150, 150), [0, 0, 255]), 1, 0.03), 'label fully in')

console.log('\nclick 2 — a 720° spin WITH a fade-out')
await key('ArrowRight')
await tick(page, 0.125) // 45° into the spin
b = await bx()
ok(near(b.gear.w, 300 * Math.SQRT1_2, 2), `gear mid-turn: bounding box widens to ${b.gear.w.toFixed(1)} (45°)`)
ok(near(b.gear.cx, 700) && near(b.gear.cy, 350), 'the spin pivots about the centre')
await tick(page, 2)
b = await bx()
ok(near(b.gear.w, 200) && near(b.gear.h, 100), 'after 720° the gear is square to the slide again')
ok(isWhite(await pixel(page, 950, 150)), 'box faded out')
ok(near(b.arrow.x, 400), 'the arrow stays where click 1 left it (effects accumulate)')

console.log('\n← restores exactly')
await key('ArrowLeft')
b = await bx()
ok(!isWhite(await pixel(page, 950, 150)), '← : the box is back')
ok(near(b.arrow.x, 400) && near(b.gear.w, 200), '← : click 1 end state (arrow moved, gear square)')
await key('ArrowLeft')
b = await bx()
ok(near(b.arrow.x, 100) && isWhite(await pixel(page, 150, 150)), '← ← : arrival state (arrow home, label hidden)')
ok((await boxes(page)).slide === 's1', 'still on s1 — ← at click 1 did not leave')

console.log('\n→ past the last click morphs from the END state')
await key('ArrowRight'); await tick(page, 5)
await key('ArrowRight'); await tick(page, 5)
await key('ArrowRight') // leave s1 → s2 (morph, 1s, bezier)
await tick(page, 0.02)
let s = await boxes(page)
ok(s.slide === 's2', 'on s2')
ok(near(s.boxes.arrow.x, 400, 6) && near(s.boxes.arrow.y, 300, 6), `the morph starts where the move left the arrow (${s.boxes.arrow.x.toFixed(0)}, ${s.boxes.arrow.y.toFixed(0)}), not at 100,300`)
await tick(page, 0.48) // t = 0.5 of a 1s morph
s = await boxes(page)
const expect = cubicBezier(0.7, 0, 0.2, 1)(0.5)
const frac = (s.boxes.arrow.x - 400) / 300
ok(near(frac, expect, 0.03), `per-slide morph easing: progress ${frac.toFixed(3)} at half time ≈ bezier ${expect.toFixed(3)}`)
ok(near(s.boxes.gear.w, 200, 1), 'the gear does not unwind its two turns during the morph')
const midBox = opacityOf(await pixel(page, 950, 150), [0, 0, 0])
ok(midBox > 0.2 && midBox < 0.9, `the faded-out box fades back in during the morph (${midBox.toFixed(2)})`)
await tick(page, 0.6)
s = await boxes(page)
ok(near(s.boxes.arrow.x, 700) && near(s.boxes.arrow.y, 500), 'the morph lands at s2’s frame (its 1s duration, not the deck’s 0.65)')

console.log('\n← from s2 arrives at s1 fully played')
await key('ArrowLeft')
await tick(page, 2)
s = await boxes(page)
ok(s.slide === 's1', 'back on s1')
ok(near(s.boxes.arrow.x, 400) && near(s.boxes.arrow.y, 300), `arrow at the end state (${s.boxes.arrow.x.toFixed(0)}, ${s.boxes.arrow.y.toFixed(0)})`)
ok(!isWhite(await pixel(page, 150, 150)) && isWhite(await pixel(page, 950, 150)), 'label shown, box gone — the last click’s state')
await key('ArrowLeft')
s = await boxes(page)
ok(s.slide === 's1' && near(s.boxes.gear.w, 200) && !isWhite(await pixel(page, 950, 150)), '← then walks back through s1’s clicks')

console.log('\nclicker keys, legacy steps')
await key('PageDown'); await tick(page, 3) // click 2 again
await key('PageDown'); await tick(page, 2) // → s2
ok((await boxes(page)).slide === 's2', 'PageDown advances clicks and slides')
await key('PageDown'); await tick(page, 1) // → s3
ok((await boxes(page)).slide === 's3', 'on the legacy slide')
ok(isWhite(await pixel(page, 450, 150)), 'fx.step element hidden on arrival')
await key('PageDown'); await tick(page, 1)
ok(!isWhite(await pixel(page, 450, 150)) && (await boxes(page)).slide === 's3', 'fx.step reveals on the click, still on s3')
await key('PageUp')
ok(isWhite(await pixel(page, 450, 150)), 'PageUp hides it again')

console.log('\nthe speaker window drives clicks')
await key('PageUp'); await tick(page, 2) // back to s2
await key('PageUp'); await tick(page, 2) // s1, fully played
await key('ArrowLeft'); await key('ArrowLeft') // s1 click 0
const popupP = page.waitForEvent('popup')
await key('s')
const sv = await popupP
await sv.waitForLoadState()
await sv.keyboard.press('ArrowRight')
await tick(page, 1.2)
b = await bx()
ok(near(b.arrow.x, 400), 'an → in the speaker window plays the click on the audience screen')
const count = await sv.evaluate(() => document.querySelector('.sv-count')?.textContent ?? '')
ok(/·\s*1\/2/.test(count), `the speaker counter shows the click (“${count}”)`)
await sv.keyboard.press('ArrowLeft')
await tick(page, 0)
ok(near((await bx()).arrow.x, 100), '← in the speaker window walks back')

console.log('\nreduced motion')
await key('m')
await key('ArrowRight')
b = await bx()
ok(near(b.arrow.x, 400) && near(opacityOf(await pixel(page, 150, 150), [0, 0, 255]), 1, 0.03), 'with reduced motion a click lands on its end state with no time passing')
await key('m')

ok(errors.length === 0, 'no page errors', errors)
await browser.close()
console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures ? 1 : 0)
