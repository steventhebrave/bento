// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// The animation pane (Animate tab) in the built editor, driven with trusted
// mouse input and measured in the document and on the canvas.
//
//   npm run build:single --prefix slides && node scripts/test-slides-anim-pane-browser.mjs
//
// WHAT THIS PROVES
//   1. the Animate tab lists the slide's effects grouped by click, with a bar
//      per timed effect and a marker per instant one; badges show click numbers
//   2. selection is shared both ways: a row selects its element on the canvas;
//      clicking an element on the canvas selects its rows
//   3. Add animation adds an effect for the selected element (one undo step)
//   4. dragging a bar changes the delay, dragging its end the duration; the
//      inspector sets several selected effects at once (shift-click range)
//   5. a row dragged by its grip reorders the list
//   6. the move effect's end handle drags its offset, Shift snapping the angle
//   7. scrubbing paints the canvas through the sequence (the element MOVES —
//      measured with its bounding box) and stopping restores the model
//   8. on a legacy slide the pane shows fx.step/fx.enter as an implicit list;
//      the first edit converts it (one undo step back to no list)
//   9. deleting an animated element takes its effects with it
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')

let checks = 0
let failures = 0
function ok(cond, msg, detail) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}${detail !== undefined ? '  → ' + JSON.stringify(detail) : ''}`) } else console.log(`  ok    ${msg}`)
}
const SHELL = new URL('../slides/dist-single/Bento_Slides.bento.html', import.meta.url).href
const rect = (id, x, y, w, h, fill, extra = {}) => ({ id, type: 'shape', shape: 'rect', x, y, w, h, fill, stroke: 'none', strokeWidth: 0, radius: 0, rotation: 0, opacity: 1, ...extra })
const DOC = {
  format: 'bento/slides', version: 1, title: 'pane rig',
  size: { width: 1280, height: 720 },
  theme: { background: '#ffffff', color: '#111111', accent: '#ff9e8a', fontFamily: 'system-ui, sans-serif' },
  slides: [
    { id: 's1', background: '#ffffff', transition: 'none', notes: '', elements: [
      rect('a', 100, 100, 160, 100, '#3355ff'),
      rect('b', 500, 100, 160, 100, '#ff5533'),
      rect('c', 900, 100, 160, 100, '#22aa55'),
      rect('d', 100, 400, 160, 100, '#aa22aa'),
    ], anim: [
      { id: 'f1', el: 'a', type: 'fade-in', trigger: 'click', duration: 1 },
      { id: 'f2', el: 'b', type: 'move', trigger: 'with', dx: 200, dy: 0, duration: 1, ease: 'linear' },
      { id: 'f3', el: 'c', type: 'spin', trigger: 'click', deg: 720, duration: 2 },
      { id: 'f4', el: 'a', type: 'appear', trigger: 'after' },
    ] },
    { id: 's2', background: '#ffffff', transition: 'none', notes: '', elements: [
      rect('x', 100, 100, 100, 100, '#000000', { fx: { enter: 'fade-up' } }),
      rect('y', 400, 100, 100, 100, '#000000', { fx: { step: 1 } }),
    ] },
  ],
}

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
const errors = []
page.on('pageerror', (e) => errors.push(String(e)))
await page.goto(SHELL)
await page.waitForFunction(() => !!window.bento?.loadDoc)
await page.evaluate((j) => window.bento.loadDoc(j), JSON.stringify(DOC))
await page.evaluate(() => window.bento.anim.setManual(true))
await page.click('.ed-props-tab:nth-child(2)')
const anim = () => page.evaluate(() => window.bento.doc.slides[window.bento.doc.slides.findIndex((s) => s.id === document.querySelector('.ed-stage-scale .bento-slide')?.dataset.slideId)].anim ?? null)
const rows = () => page.$$eval('.ed-anim-row', (rs) => rs.map((r) => ({ id: r.dataset.id, sel: r.classList.contains('sel'), text: r.textContent })))
const canvasBox = (id) => page.evaluate((i) => {
  const n = document.querySelector(`.ed-stage-scale .bento-slide [data-el-id="${i}"]`)
  const s = document.querySelector('.ed-stage-scale .bento-slide')
  const r = n.getBoundingClientRect(), sr = s.getBoundingClientRect(), k = sr.width / s.offsetWidth
  return { x: (r.left - sr.left) / k, y: (r.top - sr.top) / k, w: r.width / k, cx: r.left + r.width / 2, cy: r.top + r.height / 2 }
}, id)

console.log('\nthe list')
let r = await rows()
ok(r.length === 4, `four rows (${r.length})`)
ok((await page.$$eval('.ed-anim-ghead .ed-anim-gtitle', (h) => h.map((x) => x.textContent))).join() === 'Click 1,Click 2', 'grouped by click')
ok(await page.$$eval('.ed-anim-bar', (b) => b.length) === 3 && await page.$$eval('.ed-anim-dot', (b) => b.length) === 1, 'three bars and one instant marker')
const badges = await page.$$eval('.ed-anim-badge', (b) => b.map((x) => x.textContent).sort().join())
ok(badges === '1,1·2,2', `canvas badges show each element's clicks — a animates on 1 and 2 (${badges})`)

console.log('\nselection both ways')
await page.click('.ed-anim-row[data-id="f3"]')
ok(JSON.stringify(await page.evaluate(() => window.bento.selection)) === '["c"]', 'a row selects its element on the canvas')
const bb = await canvasBox('b')
await page.mouse.click(bb.cx, bb.cy)
await page.waitForTimeout(100)
r = await rows()
ok(r.find((x) => x.id === 'f2').sel && !r.find((x) => x.id === 'f3').sel, 'clicking an element on the canvas selects its rows')

console.log('\nadd an animation')
const dd = await canvasBox('d')
await page.mouse.click(dd.cx, dd.cy)
await page.waitForTimeout(100)
await page.click('.ed-anim-add > .ed-btn')
await page.click('.ed-anim-add .ed-menu .ed-btn:has-text("Spin")')
let a = await anim()
ok(a.length === 5 && a[4].el === 'd' && a[4].type === 'spin' && a[4].deg === 360, 'Add animation → Spin appends a 360° spin for the selected element', a[4])
ok((await rows()).find((x) => x.id === a[4].id)?.sel, 'the new effect is selected')
await page.evaluate(() => window.bento.undo())
a = await anim()
ok(a.length === 4, 'one undo removes it')

console.log('\ntiming by dragging bars')
await page.click('.ed-anim-row[data-id="f3"]')
const bar = await page.$('.ed-anim-row[data-id="f3"] .ed-anim-bar')
const b1 = await bar.boundingBox()
const lane = await (await page.$('.ed-anim-row[data-id="f3"] .ed-anim-lane')).boundingBox()
const secPerPx = 2 / lane.width // the slide's longest group is 2s
await page.mouse.move(b1.x + 10, b1.y + b1.height / 2)
await page.mouse.down()
await page.mouse.move(b1.x + 10 + 0.5 / secPerPx, b1.y + b1.height / 2, { steps: 6 })
await page.mouse.up()
a = await anim()
ok(Math.abs((a[2].delay ?? 0) - 0.5) < 0.051, `dragging the bar body sets the delay (${a[2].delay})`)
const end = await (await page.$('.ed-anim-row[data-id="f1"] .ed-anim-bar-end')).boundingBox()
const lane1 = await (await page.$('.ed-anim-row[data-id="f1"] .ed-anim-lane')).boundingBox()
const spp1 = 2.5 / lane1.width // the slide's longest group is now 2.5s
await page.mouse.move(end.x + end.width / 2, end.y + end.height / 2)
await page.mouse.down()
await page.mouse.move(end.x + end.width / 2 + 0.5 / spp1, end.y + end.height / 2, { steps: 6 })
await page.mouse.up()
a = await anim()
ok(Math.abs(a[0].duration - 1.5) < 0.051, `dragging the bar's end sets the duration (${a[0].duration})`)

console.log('\nmulti-select + inspector')
await page.click('.ed-anim-row[data-id="f1"]')
await page.click('.ed-anim-row[data-id="f3"]', { modifiers: ['Shift'] })
ok((await rows()).filter((x) => x.sel).length === 3, 'shift-click selects the range (f1, f2, f3)')
const dur = await page.$('.ed-anim-inspector .ed-row:has-text("Duration") input')
await dur.fill('0.8')
await dur.press('Enter')
await page.waitForTimeout(50)
a = await anim()
ok(a[0].duration === 0.8 && a[1].duration === 0.8 && a[2].duration === 0.8 && a[3].duration === undefined, 'one Duration sets all three; the instant appear is untouched')

console.log('\nreorder by dragging the grip')
await page.locator('.ed-anim-row[data-id="f4"] .ed-anim-grip').dragTo(page.locator('.ed-anim-row[data-id="f1"]'), { targetPosition: { x: 20, y: 2 } })
a = await anim()
ok(a.map((f) => f.id).join() === 'f4,f1,f2,f3', `f4 dragged above f1 (${a.map((f) => f.id).join()})`)
await page.evaluate(() => window.bento.undo())

console.log('\nthe move handle')
await page.click('.ed-anim-row[data-id="f2"]')
await page.waitForSelector('.ed-anim-handle')
ok(await page.$$eval('.ed-anim-ghost', (g) => g.length) === 1, 'a ghost shows where the move ends')
const h = await (await page.$('.ed-anim-handle')).boundingBox()
const k = await page.evaluate(() => { const s = document.querySelector('.ed-stage-scale .bento-slide'); return s.getBoundingClientRect().width / s.offsetWidth })
await page.mouse.move(h.x + h.width / 2, h.y + h.height / 2)
await page.mouse.down()
await page.mouse.move(h.x + h.width / 2 - 100 * k, h.y + h.height / 2 + 150 * k, { steps: 8 })
await page.mouse.up()
a = await anim()
ok(Math.abs(a[1].dx - 100) <= 2 && Math.abs(a[1].dy - 150) <= 2, `dragging the handle sets the offset (${a[1].dx}, ${a[1].dy})`)
const h2 = await (await page.$('.ed-anim-handle')).boundingBox()
await page.keyboard.down('Shift')
await page.mouse.move(h2.x + h2.width / 2, h2.y + h2.height / 2)
await page.mouse.down()
await page.mouse.move(h2.x + h2.width / 2 + 7 * k, h2.y + h2.height / 2 + 40 * k, { steps: 8 })
await page.mouse.up()
await page.keyboard.up('Shift')
a = await anim()
const ang = (Math.atan2(a[1].dy, a[1].dx) * 180) / Math.PI
ok(Math.abs(ang / 15 - Math.round(ang / 15)) < 0.02, `Shift snaps the angle to 15° steps (${ang.toFixed(2)}°)`)

console.log('\nscrubbing the preview moves the element on the canvas')
await page.evaluate(() => window.bento.anim.tick(10)) // finish anything the add/preview started
const before = await canvasBox('b')
await page.selectOption('.ed-anim-scrubber select', 'c1')
await page.evaluate(() => { const r = document.querySelector('.ed-anim-range'); r.value = '1000'; r.dispatchEvent(new Event('input')) })
const moved = await canvasBox('b')
ok(Math.abs(moved.x - before.x - a[1].dx) < 2, `at the end of click 1, b sits ${Math.round(moved.x - before.x)}px along (dx ${a[1].dx})`)
await page.click('.ed-anim-stop')
const back = await canvasBox('b')
ok(Math.abs(back.x - before.x) < 1, 'stopping the preview restores the slide as authored')

console.log('\na legacy slide converts on the first edit')
await page.evaluate(() => document.querySelectorAll('.ed-sidebar .ed-thumb')[1].click())
await page.waitForTimeout(150)
ok(await anim() === null, 'the legacy slide has no list')
r = await rows()
ok(r.length === 2 && !!(await page.$('.ed-anim-note')), 'its entrance and reveal step show as an implicit list, with a note')
await page.click('.ed-anim-row >> nth=1')
const d2 = await page.$('.ed-anim-inspector .ed-row:has-text("Duration") input')
await d2.fill('2')
await d2.press('Enter')
a = await anim()
ok(Array.isArray(a) && a.length === 2 && a[1].duration === 2 && a[0].fromDy === 16 && a[1].trigger === 'click', 'the edit converted the slide (fade-up entrance + click reveal) and applied', a)
await page.evaluate(() => window.bento.undo())
ok(await anim() === null, 'one undo puts the legacy slide back')

console.log('\ndeleting an element takes its effects')
await page.evaluate(() => document.querySelectorAll('.ed-sidebar .ed-thumb')[0].click())
await page.waitForTimeout(100)
const ca = await canvasBox('c')
await page.mouse.click(ca.cx, ca.cy)
await page.keyboard.press('Delete')
a = await anim()
ok(a.every((f) => f.el !== 'c') && a.length === 3, 'the spin on the deleted element is gone', { anim: a, sel: await page.evaluate(() => window.bento.selection), els: await page.evaluate(() => window.bento.doc.slides[0].elements.map((e) => e.id)) })

ok(errors.length === 0, 'no page errors', errors)
await browser.close()
console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures ? 1 : 0)
