// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// An element's anchor in the editor and the show, in the built shell (FORK).
//
//   npm run build:single --prefix slides && node scripts/test-slides-anchor-browser.mjs
//
// WHAT THIS PROVES — trusted mouse input on Moveable's own controls, the model
// read back after each gesture, boxes measured in the show:
//   1. the crosshair sits on the anchor and is what the pointer hits there
//   2. rotating with Moveable's rotation control turns about the anchor (its
//      point on the slide does not move); resizing does too; Alt-resize hands
//      back Moveable's own (the anchor's point moves)
//   3. an element WITHOUT an anchor still rotates about its centre
//   4. dragging the crosshair moves the anchor and snaps to the box's nine
//      points; double-click puts it back in the centre (no anchor at all);
//      each is one undo step
//   5. the panel's nine-point picker sets it
//   6. in the show a spin turns about the anchor: mid-spin and at the end the
//      box's measured bounds are where a turn about that corner puts them
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')
import { boxes, tick } from './lib/present-probe.mjs'

let checks = 0
let failures = 0
function ok(cond, msg, detail) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}${detail !== undefined ? '  → ' + JSON.stringify(detail) : ''}`) } else console.log(`  ok    ${msg}`)
}
const near = (a, b, eps = 0.5) => Math.abs(a - b) <= eps
const SHELL = new URL('../slides/dist-single/Bento_Slides.bento.html', import.meta.url).href

const rect = (id, x, y, w, h, fill, extra = {}) => ({ id, type: 'shape', shape: 'rect', x, y, w, h, fill, stroke: 'none', strokeWidth: 0, radius: 0, rotation: 0, opacity: 1, ...extra })
const DOC = {
  format: 'bento/slides', version: 1, title: 'anchor rig', size: { width: 1280, height: 720 },
  theme: { background: '#ffffff', color: '#111111', accent: '#ff9e8a', fontFamily: 'system-ui, sans-serif' },
  slides: [
    { id: 'e1', background: '#ffffff', transition: 'none', notes: '', elements: [
      rect('r', 500, 300, 200, 100, '#3355ff', { anchor: [0, 0] }),
      rect('c', 900, 300, 200, 100, '#22aa55'),
    ] },
    { id: 'p1', background: '#ffffff', transition: 'none', notes: '', elements: [rect('g', 500, 300, 100, 100, '#000000', { anchor: [0, 0] })],
      anim: [{ id: 'sp', el: 'g', type: 'spin', deg: 90, duration: 1, ease: 'linear' }] },
  ],
}
/** the anchor's point on the slide for a model element (the rig's own maths, not anchor.ts) */
const pointOf = (e) => {
  const a = e.anchor ?? [0.5, 0.5]
  const lx = (a[0] - 0.5) * e.w, ly = (a[1] - 0.5) * e.h, r = (e.rotation * Math.PI) / 180
  return { x: e.x + e.w / 2 + lx * Math.cos(r) - ly * Math.sin(r), y: e.y + e.h / 2 + lx * Math.sin(r) + ly * Math.cos(r) }
}

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
const errors = []
page.on('pageerror', (e) => errors.push(String(e)))
await page.goto(SHELL)
await page.waitForFunction(() => !!window.bento?.loadDoc)
await page.evaluate((j) => window.bento.loadDoc(j), JSON.stringify(DOC))
await page.waitForTimeout(300)
const el = (id) => page.evaluate((i) => window.bento.doc.slides.flatMap((s) => s.elements).find((e) => e.id === i), id)
const toScreen = (x, y) => page.evaluate(([x, y]) => {
  const s = document.querySelector('.ed-stage-scale .bento-slide'); const r = s.getBoundingClientRect(); const k = r.width / s.offsetWidth
  return { x: r.left + x * k, y: r.top + y * k }
}, [x, y])
const centreOf = (sel) => page.evaluate((q) => { const r = document.querySelector(q)?.getBoundingClientRect(); return r && { x: r.left + r.width / 2, y: r.top + r.height / 2 } }, sel)
const select = async (id) => {
  await page.click(`.ed-stage-scale .bento-slide [data-el-id="${id}"]`, { position: { x: 120, y: 60 } })
  await page.waitForTimeout(200)
}
const drag = async (from, steps, opts = {}) => {
  await page.mouse.move(from.x, from.y)
  if (opts.alt) await page.keyboard.down('Alt')
  await page.mouse.down()
  for (const [dx, dy] of steps) await page.mouse.move(from.x + dx, from.y + dy)
  await page.mouse.up()
  if (opts.alt) await page.keyboard.up('Alt')
  await page.waitForTimeout(250)
}
const arc = (n, sx, sy) => Array.from({ length: n }, (_, i) => [(i + 1) * sx, (i + 1) * sy])

console.log('the crosshair')
await select('r')
const h = await centreOf('.ed-anchor-handle')
const want = await toScreen(500, 300)
ok(!!h && near(h.x, want.x, 1) && near(h.y, want.y, 1), `it sits on the anchor (the top-left corner) — ${h && `${h.x.toFixed(1)},${h.y.toFixed(1)}`}`)
ok(await page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.classList.contains('ed-anchor-handle'), [h.x, h.y]), 'and the pointer hits it there, above Moveable\'s corner control')

console.log('\nrotate and resize hold the anchor')
let before = pointOf(await el('r'))
await drag(await centreOf('.moveable-rotation-control'), arc(10, 12, 6))
let after = await el('r')
ok(Math.abs(after.rotation) > 20 && near(pointOf(after).x, before.x) && near(pointOf(after).y, before.y),
  `rotating turned it ${after.rotation}° and the anchor stayed at ${pointOf(after).x.toFixed(2)},${pointOf(after).y.toFixed(2)}`)
before = pointOf(after)
const w0 = after.w
await drag(await centreOf('.moveable-control.moveable-se'), arc(8, 6, 6))
after = await el('r')
ok(after.w !== w0 && near(pointOf(after).x, before.x) && near(pointOf(after).y, before.y),
  `resizing changed the size (${w0}→${after.w} × ${after.h}) and the anchor stayed at ${pointOf(after).x.toFixed(2)},${pointOf(after).y.toFixed(2)}`)
before = pointOf(after)
// the nw control: Moveable's own resize holds the OPPOSITE corner, so the
// anchor (the top-left corner here) moves — unless the anchor is held
await drag(await centreOf('.moveable-control.moveable-nw'), arc(5, 4, 4), { alt: true })
after = await el('r')
ok(!(near(pointOf(after).x, before.x, 2) && near(pointOf(after).y, before.y, 2)), `Alt-resize is Moveable's own again: the anchor's point moves with the box (to ${pointOf(after).x.toFixed(1)},${pointOf(after).y.toFixed(1)})`)

console.log('\nno anchor: about the centre, as before')
await select('c')
const c0 = await el('c')
await drag(await centreOf('.moveable-rotation-control'), arc(10, 12, 6))
const c1 = await el('c')
ok(c1.rotation !== 0 && near(c1.x, c0.x, 0.15) && near(c1.y, c0.y, 0.15) && !('anchor' in c1), `turned ${c1.rotation}° with the box where it was (${c1.x}, ${c1.y})`)
ok(!(await page.$('.ed-anchor-handle')), 'and no crosshair: the centre is everyone\'s default, and a target there would sit where people double-click')

console.log('\nthe crosshair moves the anchor')
await page.evaluate(() => window.bento.undo())
await select('c')
// give it one with the panel (top-left), then drag the crosshair to near the
// right edge's midpoint: it snaps there
await page.click('.ed-props-scroll:not([hidden]) .ed-anchor-pt >> nth=0')
await page.waitForTimeout(150)
ok(JSON.stringify((await el('c')).anchor) === '[0,0]' && !!(await page.$('.ed-anchor-handle')), 'the panel gives it an anchor, and the crosshair appears')
const hc = await centreOf('.ed-anchor-handle')
const right = await toScreen(1100 - 3, 350 + 2)
await drag(hc, [[(right.x - hc.x) / 2, (right.y - hc.y) / 2], [right.x - hc.x, right.y - hc.y]])
let c = await el('c')
ok(JSON.stringify(c.anchor) === '[1,0.5]', `dragged near the right edge's middle, it snaps there (${JSON.stringify(c.anchor)})`)
await page.evaluate(() => window.bento.undo())
c = await el('c')
ok(JSON.stringify(c.anchor) === '[0,0]', 'one undo takes it back')
await page.evaluate(() => window.bento.redo())
await page.waitForTimeout(150)
await select('c')
await page.dblclick('.ed-anchor-handle')
await page.waitForTimeout(150)
c = await el('c')
ok(!('anchor' in c) && !(await page.$('.ed-anchor-handle')), 'double-click puts it back in the centre: no anchor at all, and the crosshair goes')

console.log('\nthe panel')
await page.click('.ed-props-scroll:not([hidden]) .ed-anchor-pt >> nth=8')
await page.waitForTimeout(150)
c = await el('c')
ok(JSON.stringify(c.anchor) === '[1,1]', `the nine-point picker sets it (bottom-right: ${JSON.stringify(c.anchor)})`)
ok(await page.$eval('.ed-props-scroll:not([hidden]) .ed-anchor-pt >> nth=8', (b) => b.classList.contains('on')).catch(() => false) || await page.evaluate(() => document.querySelectorAll('.ed-props-scroll:not([hidden]) .ed-anchor-pt')[8]?.classList.contains('on')), 'and shows it')

console.log('\na spin turns about the anchor in the show')
await page.evaluate(() => window.bento.anim.setManual(true))
await page.evaluate(() => document.querySelectorAll('.ed-sidebar .ed-thumb')[1].click())
await page.waitForTimeout(150)
await page.evaluate(() => { const b = [...document.querySelectorAll('.ed-pill-main')][0]; b.click() })
await page.waitForSelector('.bento-present-overlay .reveal .slides section.present .bento-slide')
await tick(page, 0)
// the show starts from the current slide
await page.keyboard.press('ArrowRight'); await tick(page, 0.5)
let b = (await boxes(page)).boxes.g
const d = 100 / Math.SQRT2
ok(near(b.x, 500 - d, 1) && near(b.y, 300, 1) && near(b.w, 2 * d, 1) && near(b.h, 2 * d, 1),
  `45° about the top-left corner: bounds ${b.x.toFixed(1)},${b.y.toFixed(1)} ${b.w.toFixed(1)}×${b.h.toFixed(1)} (want ${(500 - d).toFixed(1)},300 ${(2 * d).toFixed(1)}×${(2 * d).toFixed(1)})`)
await tick(page, 0.6)
b = (await boxes(page)).boxes.g
ok(near(b.x, 400, 1) && near(b.y, 300, 1) && near(b.w, 100, 1), `90°: the square has swung round the corner to ${b.x.toFixed(1)},${b.y.toFixed(1)}`)
await page.keyboard.press('ArrowLeft'); await tick(page, 0)
b = (await boxes(page)).boxes.g
ok(near(b.x, 500, 1) && near(b.y, 300, 1), '← puts it back exactly')

ok(errors.length === 0, 'no page errors', errors)
await browser.close()
console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures ? 1 : 0)
