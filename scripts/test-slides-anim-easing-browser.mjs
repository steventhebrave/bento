// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Easing and the JSON escape hatch in the built editor (phases 3 and 4 of the
// animation work), with trusted mouse input.
//
//   npm run build:single --prefix slides && node scripts/test-slides-anim-easing-browser.mjs
//
// WHAT THIS PROVES
//   1. the curve editor: dragging a control point makes the effect's ease a
//      cubic-bezier array (one undo step, committed on release, x kept in
//      0..1), a number field sets one coordinate exactly, a preset sets a name
//      and "Default" removes the key
//   2. morph timing per slide and per deck, from the panel: duration and
//      easing land in slide.morphSeconds/morphEase and present.morphSeconds/
//      morphEase, blank inherits; and the SHOW uses the deck curve set in the
//      panel (measured mid-morph against the same bezier)
//   3. the JSON box: keyframes applied → the row reads "custom"; a timing edit
//      in the panel leaves the keyframes alone; a key this build does not know
//      survives an edit when it was already there, while a NEW unknown key is
//      dropped and reported; "Reset to UI-editable" (after its confirm) drops
//      exactly the keyframes and unknown keys
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')
import { cubicBezier } from '../kernel/src/ease.ts'

let checks = 0
let failures = 0
function ok(cond, msg, detail) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}${detail !== undefined ? '  → ' + JSON.stringify(detail) : ''}`) } else console.log(`  ok    ${msg}`)
}
const SHELL = new URL('../slides/dist-single/Bento_Slides.bento.html', import.meta.url).href
const rect = (id, x, y, w, h, fill) => ({ id, type: 'shape', shape: 'rect', x, y, w, h, fill, stroke: 'none', strokeWidth: 0, radius: 0, rotation: 0, opacity: 1 })
const DOC = {
  format: 'bento/slides', version: 1, title: 'easing rig',
  size: { width: 1280, height: 720 },
  theme: { background: '#ffffff', color: '#111111', accent: '#ff9e8a', fontFamily: 'system-ui, sans-serif' },
  slides: [
    { id: 's1', background: '#ffffff', transition: 'none', notes: '', elements: [rect('a', 100, 300, 120, 60, '#ff0000')],
      anim: [{ id: 'm', el: 'a', type: 'move', dx: 300, dy: 0, duration: 1 }] },
    { id: 's2', background: '#ffffff', transition: 'morph', notes: '', elements: [rect('a', 700, 300, 120, 60, '#ff0000')] },
  ],
}

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
const errors = []
page.on('pageerror', (e) => errors.push(String(e)))
page.on('dialog', (d) => d.accept())
await page.goto(SHELL)
await page.waitForFunction(() => !!window.bento?.loadDoc)
await page.evaluate((j) => window.bento.loadDoc(j), JSON.stringify(DOC))
await page.evaluate(() => window.bento.anim.setManual(true))
const doc = () => page.evaluate(() => JSON.parse(JSON.stringify(window.bento.doc)))
const fx0 = async () => (await doc()).slides[0].anim[0]

console.log('\nthe curve editor in the pane')
await page.click('.ed-props-tab:nth-child(2)')
await page.click('.ed-anim-row[data-id="m"]')
await page.click('.ed-anim-inspector .ed-ease-toggle')
const plot = await (await page.$('.ed-anim-inspector .ed-ease-plot')).boundingBox()
const h2 = await (await page.$('.ed-anim-inspector .ed-ease-handle[data-h="2"]')).boundingBox()
const undoBefore = await page.evaluate(() => window.bento.doc.slides[0].anim[0].ease)
await page.mouse.move(h2.x + h2.width / 2, h2.y + h2.height / 2)
await page.mouse.down()
await page.mouse.move(plot.x + plot.width * 0.3, plot.y + plot.height * 0.2, { steps: 6 })
await page.mouse.move(plot.x + plot.width * 0.3 + 2, plot.y + plot.height * 0.2, { steps: 2 })
let f = await fx0()
ok(f.ease === undoBefore, 'while dragging nothing is committed')
await page.mouse.up()
f = await fx0()
ok(Array.isArray(f.ease) && f.ease.length === 4 && f.ease[2] >= 0 && f.ease[2] <= 1, `releasing the handle commits a cubic-bezier (${JSON.stringify(f.ease)})`)
await page.mouse.move(plot.x - 400, plot.y + plot.height * 0.5) // far outside: x must clamp
await page.evaluate(() => window.bento.undo())
f = await fx0()
ok(f.ease === undefined, 'one undo returns the default ease')
await page.click('.ed-anim-row[data-id="m"]')
if (!(await page.$('.ed-anim-inspector .ed-ease-panel:not([hidden])'))) await page.click('.ed-anim-inspector .ed-ease-toggle')
const x1 = await page.$('.ed-anim-inspector .ed-ease-nums input[aria-label="x1"]')
await x1.fill('0.9')
await x1.press('Enter')
f = await fx0()
ok(Array.isArray(f.ease) && f.ease[0] === 0.9, `a number field sets one coordinate exactly (${JSON.stringify(f.ease)})`)
await page.selectOption('.ed-anim-inspector .ed-ease-top select', 'sine.inOut')
ok((await fx0()).ease === 'sine.inOut', 'a preset stores its name')
await page.selectOption('.ed-anim-inspector .ed-ease-top select', '')
ok(!('ease' in (await fx0())), '"Default" removes the key')

console.log('\nmorph timing per slide and per deck')
await page.click('.ed-props-tab:nth-child(1)')
await page.evaluate(() => document.querySelectorAll('.ed-sidebar .ed-thumb')[1].click())
await page.waitForTimeout(150)
const fmt = '.ed-props-scroll:not([hidden])'
// Locators, not handles: every committed edit rebuilds the panel (a frame
// later), so a handle taken before an edit can be detached by the time it is used.
const durIn = page.locator(`${fmt} .ed-row:has-text("Morph duration") input`)
const easeSel = page.locator(`${fmt} .ed-row:has-text("Morph easing") .ed-ease-top select`)
const settle = () => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))
ok(await durIn.count() === 2, `a morph slide offers its own Morph duration and the deck's (${await durIn.count()})`)
await durIn.first().fill('1.5')
await durIn.first().press('Enter')
await settle()
let d = await doc()
ok(d.slides[1].morphSeconds === 1.5, 'the slide row sets slide.morphSeconds')
await easeSel.first().selectOption('back.out')
await settle()
d = await doc()
ok(d.slides[1].morphEase === 'back.out', 'the slide row sets slide.morphEase')
// blank inherits again
await durIn.first().fill('')
await durIn.first().press('Enter')
await settle()
await easeSel.first().selectOption('')
await settle()
d = await doc()
ok(!('morphSeconds' in d.slides[1]) && !('morphEase' in d.slides[1]), 'blank / Default removes the slide override')
// the deck's (Slideshow section; open it)
const show = page.locator(`${fmt} h3.ed-section:has-text("Slideshow")`)
if (await show.evaluate((h) => h.classList.contains('closed'))) await show.click()
await settle()
await durIn.last().fill('1')
await durIn.last().press('Enter')
await settle()
await page.locator(`${fmt} .ed-row:has-text("Morph easing") .ed-ease-toggle`).last().click()
const nums = page.locator(`${fmt} .ed-row:has-text("Morph easing") .ed-ease-nums`).last()
for (const [name, v] of [['x1', '0.8'], ['y1', '0'], ['x2', '0.2'], ['y2', '1']]) {
  await nums.locator(`input[aria-label="${name}"]`).fill(v)
  await nums.locator(`input[aria-label="${name}"]`).press('Enter')
  await settle()
}
d = await doc()
ok(d.present?.morphSeconds === 1 && JSON.stringify(d.present?.morphEase) === '[0.8,0,0.2,1]', `the deck rows set present.morphSeconds/morphEase (${JSON.stringify(d.present)})`)

console.log('\n…and the show uses them')
await page.evaluate(() => document.querySelectorAll('.ed-sidebar .ed-thumb')[0].click())
await page.waitForTimeout(100)
await page.evaluate(() => [...document.querySelectorAll('.ed-pill-main')][0].click())
await page.waitForSelector('.bento-present-overlay section.present .bento-slide')
const box = () => page.evaluate(() => {
  const s = document.querySelector('.bento-present-overlay section.present .bento-slide')
  const n = s.querySelector('[data-el-id="a"]')
  const sr = s.getBoundingClientRect(), r = n.getBoundingClientRect(), k = sr.width / s.offsetWidth
  return { slide: s.dataset.slideId, x: (r.left - sr.left) / k }
})
await page.keyboard.press('ArrowRight'); await page.evaluate(() => window.bento.anim.tick(2))
await page.keyboard.press('ArrowRight'); await page.evaluate(() => window.bento.anim.tick(0.3))
const mid = await box()
// at 30% of the time (not 50%: this curve is symmetric, so half time reads 0.5 for linear and the default too)
const want = cubicBezier(0.8, 0, 0.2, 1)(0.3)
const dflt = 4 * 0.3 ** 3 // power2.inOut, the default
const got = (mid.x - 400) / 300
ok(mid.slide === 's2' && Math.abs(got - want) < 0.02 && Math.abs(got - dflt) > 0.02 && Math.abs(got - 0.3) > 0.1,
  `the morph follows the deck curve set in the panel (progress ${got.toFixed(3)} ≈ ${want.toFixed(3)} at 0.3 of 1s; the default would be ${dflt.toFixed(3)}, linear 0.300)`)
await page.keyboard.press('Escape')
await page.waitForTimeout(100)

console.log('\nthe JSON box')
await page.evaluate(() => document.querySelectorAll('.ed-sidebar .ed-thumb')[0].click())
await page.click('.ed-props-tab:nth-child(2)')
await page.click('.ed-anim-row[data-id="m"]')
if (!(await page.$('.ed-anim-json'))) await page.click('.ed-anim-jsonhead')
const withKeys = { id: 'm', el: 'a', type: 'move', duration: 1, keys: [{ at: 0, dx: 0 }, { at: 0.5, dx: 200 }, { at: 1, dx: 100 }] }
await page.fill('.ed-anim-json', JSON.stringify(withKeys, null, 2))
await page.click('.ed-anim-inspector .ed-btn-primary:has-text("Apply")')
f = await fx0()
ok(Array.isArray(f.keys) && f.keys.length === 3, 'keyframes applied from JSON')
ok(await page.$('.ed-anim-row[data-id="m"] .ed-anim-custom') !== null, 'the row reads "custom"')
const dur = await page.$('.ed-anim-inspector .ed-row:has-text("Duration") input')
await dur.fill('2')
await dur.press('Enter')
f = await fx0()
ok(f.duration === 2 && f.keys?.length === 3, 'a panel timing edit leaves the keyframes untouched')
// a key from "a newer version": put it in the document directly, as a newer file would
await page.evaluate(() => { const fx = window.bento.doc.slides[0].anim[0]; fx.wobble = { hz: 3 } })
await page.click('.ed-anim-row[data-id="m"]')
const cur = JSON.parse(await page.inputValue('.ed-anim-json'))
ok(cur.wobble?.hz === 3, 'the JSON box shows a key this build does not know')
await page.fill('.ed-anim-json', JSON.stringify({ ...cur, delay: 0.25, sparkle: true }, null, 2))
await page.click('.ed-anim-inspector .ed-btn-primary:has-text("Apply")')
f = await fx0()
const msg = await page.textContent('.ed-anim-jsonmsg')
ok(f.delay === 0.25 && f.wobble?.hz === 3 && !('sparkle' in f), 'an existing unknown key survives the edit; a NEW unknown key is dropped', f)
ok(/sparkle/.test(msg), `…and the box says so ("${msg}")`)
await page.click('.ed-anim-reset')
f = await fx0()
ok(!('keys' in f) && !('wobble' in f) && f.type === 'move' && f.dx === 200 && f.duration === 2 && f.delay === 0.25, 'Reset to UI-editable drops keyframes and unknown keys, keeps timing, fills the type defaults', f)
ok(await page.$('.ed-anim-row[data-id="m"] .ed-anim-custom') === null, 'the row is no longer custom')

ok(errors.length === 0, 'no page errors', errors)
await browser.close()
console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures ? 1 : 0)
