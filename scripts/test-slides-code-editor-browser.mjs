// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// The code layer in the EDITOR, in the built shell (FORK).
//
//   npm run build:single --prefix slides && node scripts/test-slides-code-editor-browser.mjs
//
// WHAT THIS PROVES — measured on the editing canvas (screenshot pixels,
// bounding boxes) and in the document:
//   1. the chip: shown only for a deck with code; its switch turns code off
//      (no sandbox frame anywhere) and back on
//   2. posters: a canvas loaded without a still gets one, captured in the
//      sandbox and stored as an asset; changing a parameter in the panel
//      re-captures it (the stage shows the new drawing)
//   3. the pane: a script effect's inspector offers the deck's effect
//      scripts and generated parameter rows; an edit lands in fx.params
//   4. preview: scrubbing paints the script's motion layered on the move,
//      and the canvas draws LIVE at the scrubbed click; stopping restores
//   5. "driven by": the Format panel marks the values a script drives
//   6. the Deck code dialog: a rename follows every reference, in one undo
//   7. Insert → Code → Code canvas reuses the deck's canvas script
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')
import { decodePng } from './lib/present-probe.mjs'

let checks = 0
let failures = 0
function ok(cond, msg, detail) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}${detail !== undefined ? '  → ' + JSON.stringify(detail) : ''}`) } else console.log(`  ok    ${msg}`)
}
const near = (a, b, eps = 2) => Math.abs(a - b) <= eps
const SHELL = new URL('../slides/dist-single/Bento_Slides.bento.html', import.meta.url).href

const HOP = `export const meta = { kind: 'effect', drives: ['y'], params: { amp: { type: 'number', default: 20, min: 0, max: 400, label: 'Height' } } }
export default function hop(p, base, params) { return { y: base.y - params.amp * Math.sin(p * Math.PI) } }`
const BAR = `export const meta = { kind: 'canvas', params: { bg: { type: 'color', default: '#00ff00', label: 'Ground' } } }
export default function draw(g, ctx) {
  g.fillStyle = ctx.click === 0 ? ctx.params.bg : '#0000ff'
  g.fillRect(0, 0, ctx.width, ctx.height)
  g.fillStyle = '#ff0000'
  g.fillRect(Math.min(ctx.t, 2) * 100, 0, 20, ctx.height)
}`
const rect = (id, x, y, w, h, fill) => ({ id, type: 'shape', shape: 'rect', x, y, w, h, fill, stroke: 'none', strokeWidth: 0, radius: 0, rotation: 0, opacity: 1 })
const DOC = {
  format: 'bento/slides', version: 1, title: 'code editor rig',
  size: { width: 1280, height: 720 },
  theme: { background: '#ffffff', color: '#111111', accent: '#ff9e8a', fontFamily: 'system-ui, sans-serif' },
  scripts: { hop: { src: HOP }, bar: { src: BAR } },
  slides: [
    { id: 'c1', background: '#ffffff', transition: 'none', notes: '', elements: [
      rect('bob', 100, 300, 80, 80, '#ff00ff'),
      { id: 'cv', type: 'canvas', x: 700, y: 100, w: 300, h: 200, rotation: 0, opacity: 1, script: 'bar' },
    ], anim: [
      { id: 'm1', el: 'bob', type: 'move', trigger: 'click', dx: 400, dy: 0, duration: 1, ease: 'linear' },
      { id: 'w1', el: 'bob', type: 'script', trigger: 'with', script: 'hop', params: { amp: 120 }, duration: 1, ease: 'linear' },
    ] },
    { id: 'c2', background: '#ffffff', transition: 'none', notes: '', elements: [] },
  ],
}

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
const errors = []
page.on('pageerror', (e) => errors.push(String(e)))
if (process.env.DBG) page.on('console', (m) => console.log('[console]', m.type(), m.text()))
await page.goto(SHELL)
await page.waitForFunction(() => !!window.bento?.loadDoc)
await page.evaluate(() => window.bento.code.setEnabled(true))
ok(await page.evaluate(() => document.querySelector('.ed-codechip')?.hidden === true), 'the starter deck has no code: no chip')
await page.evaluate((j) => window.bento.loadDoc(j), JSON.stringify(DOC))
await page.evaluate(() => window.bento.anim.setManual(true))
const doc = () => page.evaluate(() => window.bento.doc)
const stage = () => page.evaluate(() => {
  const s = document.querySelector('.ed-stage-scale .bento-slide')
  const r = s.getBoundingClientRect()
  return { left: r.left, top: r.top, k: r.width / s.offsetWidth }
})
const px = async (x, y) => {
  const g = await stage()
  const png = decodePng(await page.screenshot({ clip: { x: Math.round(g.left + x * g.k), y: Math.round(g.top + y * g.k), width: 1, height: 1 } }))
  return [png.data[0], png.data[1], png.data[2]]
}
const box = (id) => page.evaluate((i) => {
  const n = document.querySelector(`.ed-stage-scale .bento-slide [data-el-id="${i}"]`)
  const s = document.querySelector('.ed-stage-scale .bento-slide')
  const r = n.getBoundingClientRect(), sr = s.getBoundingClientRect(), k = sr.width / s.offsetWidth
  return { x: (r.left - sr.left) / k, y: (r.top - sr.top) / k }
}, id)
const isGreen = ([r, g, b]) => g > 200 && r < 60 && b < 60
const isBlue = ([r, g, b]) => b > 200 && r < 60 && g < 60
const isRed = ([r, g, b]) => r > 200 && g < 60 && b < 60
const frames = () => page.evaluate(() => document.querySelectorAll('.ed-stage-scale iframe[sandbox]').length)

console.log('the chip')
await page.waitForTimeout(300)
ok(await page.evaluate(() => { const c = document.querySelector('.ed-codechip'); return !!c && !c.hidden && /Code/.test(c.textContent) }), 'a deck with code shows the chip')

console.log('\nposters')
await page.waitForFunction(() => !!window.bento.doc.slides[0].elements.find((e) => e.id === 'cv')?.poster, null, { timeout: 8000 })
let d = await doc()
const poster1 = d.slides[0].elements[1].poster
ok(/^asset:/.test(poster1) && /^data:image\/png;base64,/.test(d.assets[poster1.slice(6)] ?? ''), `the canvas got a still, captured and stored as an asset (${poster1})`)
await page.waitForTimeout(200)
ok(isGreen(await px(850, 200)) && isRed(await px(710, 200)), 'the stage shows the still: the drawing at click 0, 0 s')
await page.click('.ed-stage-scale .bento-slide [data-el-id="cv"]', { position: { x: 150, y: 100 } })
await page.waitForSelector('.ed-props-scroll:not([hidden]) .ed-row:has-text("Script") select')
ok(await page.$eval('.ed-props-scroll:not([hidden]) .ed-row:has-text("Script") select', (s) => s.value) === 'bar', 'the canvas panel names its script')
const ground = page.locator('.ed-props-scroll:not([hidden]) input[data-param="bg"]')
ok(await ground.count() === 1, 'the script\'s declared parameter gets a control (a colour)')
await ground.evaluate((i) => { i.value = '#ffff00'; i.dispatchEvent(new Event('change', { bubbles: true })) })
await page.waitForFunction((p) => { const e = window.bento.doc.slides[0].elements[1]; return e.params?.bg === '#ffff00' && e.poster && e.poster !== p }, poster1, { timeout: 8000 })
await page.waitForTimeout(200)
const [yr, yg, yb] = await px(850, 200)
ok(yr > 200 && yg > 200 && yb < 60, `a parameter change re-captures the still (the stage now shows yellow: ${yr},${yg},${yb})`)

console.log('\nthe pane')
await page.click('.ed-stage-scale .bento-slide [data-el-id="bob"]')
await page.click('.ed-props-tab:nth-child(2)')
await page.click('.ed-anim-row[data-id="w1"]')
const sel = page.locator('.ed-anim-inspector .ed-row:has(> span:text-is("Script")) select')
ok(await sel.count() === 1 && await sel.inputValue() === 'hop', 'the script effect\'s inspector picks its script')
const opts = await sel.evaluate((s) => [...s.options].map((o) => o.value))
ok(opts.includes('hop') && !opts.includes('bar'), `it offers effect scripts, not canvas scripts (${opts.join(', ')})`)
const amp = page.locator('.ed-anim-inspector input[data-param="amp"]')
ok(await amp.count() === 1 && await amp.inputValue() === '120', 'the declared parameter shows its value')
await amp.fill('60')
await amp.press('Enter')
await page.waitForTimeout(100)
d = await doc()
ok(d.slides[0].anim[1].params?.amp === 60, 'an edit lands in fx.params')

await page.click('.ed-anim-add > .ed-btn')
await page.click('.ed-anim-add .ed-menu .ed-btn:has-text("Script")')
d = await doc()
const added = d.slides[0].anim.at(-1)
ok(added?.type === 'script' && added.el === 'bob' && !added.script, 'Add animation → Script adds a script effect with no script yet')
await page.locator('.ed-anim-inspector .ed-row:has(> span:text-is("Script")) select').selectOption('hop')
d = await doc()
ok(d.slides[0].anim.at(-1).script === 'hop', '…and its picker sets the script')
await page.evaluate(() => { window.bento.undo(); window.bento.undo() })
d = await doc()
ok(d.slides[0].anim.length === 2, 'two undos take both back')
await page.click('.ed-anim-row[data-id="w1"]')

console.log('\npreview: script motion and a live canvas')
await page.waitForTimeout(600) // the re-bake lands
await page.evaluate(() => window.bento.anim.tick(10))
await page.selectOption('.ed-anim-scrubber select', 'c1')
await page.evaluate(() => { const r = document.querySelector('.ed-anim-range'); r.value = '500'; r.dispatchEvent(new Event('input')) })
await page.waitForTimeout(500)
await page.evaluate(() => { const r = document.querySelector('.ed-anim-range'); r.value = '500'; r.dispatchEvent(new Event('input')) })
let b = await box('bob')
ok(near(b.x, 300) && near(b.y, 240), `half-way through click 1: x from the move, y from the script with amp 60 (${b.x.toFixed(1)}, ${b.y.toFixed(1)}; want 300, 240)`)
await page.waitForTimeout(500)
ok(await frames() === 1 && isBlue(await px(850, 200)), 'the canvas draws live at click 1 (blue), in a sandbox frame')
await page.click('.ed-anim-stop')
await page.waitForTimeout(200)
b = await box('bob')
ok(near(b.x, 100) && near(b.y, 300) && await frames() === 0, 'ONE click on Stop, right after a field edit, restores the slide and removes the frame')

console.log('\ndriven by')
await page.click('.ed-props-tab:nth-child(1)')
const driven = await page.$$eval('.ed-props-scroll:not([hidden]) .ed-mini', (ms) => ms.map((m) => m.classList.contains('ed-driven')))
ok(driven[1] === true && driven[0] === false, `Y is marked driven by the script; X is not (${driven.slice(0, 2)})`)

console.log('\nthe Deck code dialog')
await page.click('.ed-codechip')
await page.click('.ed-codepop button:has-text("Edit code")')
await page.click('dialog.ed-codedialog .ed-code-item:has-text("hop")')
await page.fill('dialog.ed-codedialog .ed-code-name input', 'hop2')
await page.press('dialog.ed-codedialog .ed-code-name input', 'Enter')
await page.click('dialog.ed-codedialog button.ok')
await page.waitForTimeout(300)
d = await doc()
ok(!!d.scripts.hop2 && !d.scripts.hop && d.slides[0].anim[1].script === 'hop2', 'a rename follows the effect that uses it')
await page.click('dialog.ed-codedialog button.cancel')
await page.evaluate(() => window.bento.undo())
d = await doc()
ok(!!d.scripts.hop && d.slides[0].anim[1].script === 'hop', 'one undo puts both back')

console.log('\ninsert a code canvas')
await page.evaluate(() => document.querySelectorAll('.ed-sidebar .ed-thumb')[1].click())
await page.waitForTimeout(150)
await page.click('.ed-insert .ed-dropdown:has(> button[title*="canvas"]) > button')
await page.click('.ed-menu button:has-text("Code canvas")')
d = await doc()
const ins = d.slides[1].elements.find((e) => e.type === 'canvas')
ok(!!ins && ins.script === 'bar' && Object.keys(d.scripts).length === 2, 'Insert → Code canvas uses the deck\'s canvas script (no new script)')

console.log('\nediting a script re-captures stills on every slide')
const before = (await doc()).slides[0].elements[1].poster
await page.click('.ed-codechip')
await page.click('.ed-codepop button:has-text("Edit code")')
await page.click('dialog.ed-codedialog .ed-code-item:has-text("bar")')
const src = await page.inputValue('dialog.ed-codedialog .ed-code-src')
await page.fill('dialog.ed-codedialog .ed-code-src', src.replace("'#ff0000'", "'#ff00ff'"))
await page.click('dialog.ed-codedialog button.ok')
await page.click('dialog.ed-codedialog button.cancel')
const fresh = await page.waitForFunction((b) => { const p = window.bento.doc.slides[0].elements[1].poster; return p && p !== b ? p : false }, before, { timeout: 8000 }).then((h) => h.jsonValue()).catch(() => null)
ok(!!fresh, `slide 1's canvas got a new still while slide 2 is open (${before} → ${fresh})`)

console.log('\nthe switch')
await page.click('.ed-codechip')
await page.click('.ed-codepop input[type="checkbox"]')
await page.waitForTimeout(300)
ok(await page.evaluate(() => document.querySelectorAll('iframe[sandbox]').length) === 0, 'code off: no sandbox frame anywhere in the editor')
ok(await page.evaluate(() => document.querySelector('.ed-codechip').classList.contains('off')), 'the chip says code is off')
await page.click('.ed-codepop input[type="checkbox"]')
await page.keyboard.press('Escape')

ok(errors.length === 0, 'no page errors', errors)
await browser.close()
console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures ? 1 : 0)
