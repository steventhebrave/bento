// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// A slide's background picture (FORK), in the built shell: chosen in the
// slide panel, measured on the canvas, in the show and in the saved file.
//
//   npm run build:single --prefix slides && node scripts/test-slides-bgimage-browser.mjs
//
// The picture is 4:1 — deliberately NOT the slide's shape — with its left
// quarter red and the rest green, on magenta slides. That tells the three fits
// apart by pixels alone: FILL (cover) zooms until no slide shows and crops the
// sides, so every edge reads green; a STRETCH would put red on the left edge;
// a LETTERBOX (contain) would leave magenta above and below.
//
// WHAT THIS PROVES
//   1. "Choose image…" stores the picture once in doc.assets and points the
//      slide at it; on the canvas it fills the slide (green at every edge —
//      cropped, not stretched, not letterboxed) beneath the slide's elements
//   2. it is not selectable and takes no clicks: a click on it selects
//      nothing, a click on an element above it selects that element
//   3. "Apply to all slides" points every slide at the SAME stored copy, in
//      one undo step; every sidebar thumbnail shows it
//   4. a new slide takes it while every slide shares it — not once they differ
//   5. the save keeps its asset, and the file's thumbnail preview carries it
//   6. the show paints it, filling the slide
//   5b. in the saved file the picture data is its own LAST line ("assets":…),
//      the line an agent stops before (doclayout.ts)
//   7. "Remove" takes it off one slide; "Remove from all slides" off every
//      one, and the next save drops its bytes
//   8. a picture bigger than 4K is stored at exactly 3840×2160 (the
//      background cap; picture elements keep 2560)
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')
import { deflateSync, crc32 } from 'node:zlib'
import { decodePng } from './lib/present-probe.mjs'

let checks = 0
let failures = 0
function ok(cond, msg, detail) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}${detail !== undefined ? '  → ' + JSON.stringify(detail) : ''}`) } else console.log(`  ok    ${msg}`)
}
const SHELL = new URL('../slides/dist-single/Bento_Slides.bento.html', import.meta.url).href

/** A PNG of w×h whose pixel at (x, y) is rgb(x, y). */
function png(w, h, rgb) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td) >>> 0)
    return Buffer.concat([len, td, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2
  const raw = Buffer.alloc((w * 3 + 1) * h)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) raw.set(rgb(x, y), y * (w * 3 + 1) + 1 + x * 3)
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}
const PICTURE = png(400, 100, (x) => (x < 100 ? [255, 0, 0] : [0, 200, 0]))

const MAGENTA = '#ff00ff'
const slide = (id, elements = []) => ({ id, background: MAGENTA, transition: 'none', notes: '', elements })
const DOC = {
  format: 'bento/slides', version: 1, title: 'background picture rig', size: { width: 1280, height: 720 },
  theme: { background: '#ffffff', color: '#111111', accent: '#ff9e8a', fontFamily: 'system-ui, sans-serif' },
  slides: [
    slide('s1', [{ id: 'r', type: 'shape', shape: 'rect', x: 900, y: 500, w: 100, h: 100, fill: '#0000ff', stroke: 'none', strokeWidth: 0, radius: 0, rotation: 0, opacity: 1 }]),
    slide('s2'),
    slide('s3'),
  ],
}

const isGreen = ([r, g, b]) => g > 150 && r < 60 && b < 60
const isBlue = ([r, g, b]) => b > 200 && r < 60 && g < 60

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
const errors = []
page.on('pageerror', (e) => errors.push(String(e)))
await page.goto(SHELL)
await page.waitForFunction(() => !!window.bento?.loadDoc)
await page.evaluate((j) => window.bento.loadDoc(j), JSON.stringify(DOC))
await page.waitForTimeout(300)
const model = () => page.evaluate(() => window.bento.doc)
/** one screen pixel at a slide coordinate on a surface */
const pixelOn = async (surface, x, y) => {
  const at = await page.evaluate(([q, x, y]) => {
    const s = document.querySelector(q); const r = s.getBoundingClientRect(); const k = r.width / s.offsetWidth
    return { x: Math.round(r.left + x * k), y: Math.round(r.top + y * k) }
  }, [surface, x, y])
  const { data } = decodePng(await page.screenshot({ clip: { x: at.x, y: at.y, width: 1, height: 1 } }))
  return [data[0], data[1], data[2]]
}
const CANVAS = '.ed-stage-scale .bento-slide'
const panelButton = (which) => page.$(`.ed-props-scroll:not([hidden]) [data-bgimg="${which}"]`)
const choose = async () => {
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), (await panelButton('choose')).click()])
  await chooser.setFiles({ name: 'bg.png', mimeType: 'image/png', buffer: PICTURE })
  await page.waitForFunction(() => !!window.bento.doc.slides.find((s) => s.id === document.querySelector('.ed-stage-scale .bento-slide')?.dataset.slideId)?.backgroundImage)
  await page.waitForTimeout(300)
}

console.log('choosing a picture')
await page.keyboard.press('Escape')
await choose()
let d = await model()
const ref = d.slides[0].backgroundImage
const key = ref?.slice(6)
ok(ref?.startsWith('asset:') && d.assets?.[key]?.startsWith('data:image/'), `the slide points at a stored picture (${ref})`)
ok(!d.slides[1].backgroundImage && !d.slides[2].backgroundImage, 'only this slide has it')
const geo = await page.evaluate((q) => {
  const s = document.querySelector(q), img = s.querySelector('img.bento-slide-bg')
  const a = s.getBoundingClientRect(), b = img?.getBoundingClientRect()
  return b && { dx: Math.abs(a.left - b.left) + Math.abs(a.top - b.top), dw: Math.abs(a.width - b.width) + Math.abs(a.height - b.height), first: s.firstElementChild === img }
}, CANVAS)
ok(!!geo && geo.dx < 1 && geo.dw < 1 && geo.first, 'on the canvas it covers the slide exactly, beneath every element', geo)
const edge = []
for (const [x, y] of [[4, 4], [4, 360], [1276, 4], [1276, 716], [640, 716]]) edge.push(await pixelOn(CANVAS, x, y))
ok(edge.every(isGreen), `it FILLS the slide: green at every edge — cropped, not stretched (no red), not letterboxed (no magenta) (${edge.map((p) => p?.join('/')).join('  ')})`)
ok(isBlue(await pixelOn(CANVAS, 950, 550)), 'the slide\'s element is drawn above it')
ok(!!(await page.$('.ed-props-scroll:not([hidden]) img.ed-bgimg-thumb')) && !!(await panelButton('remove')), 'the panel shows a thumbnail and Remove')

console.log('\nit takes no clicks')
const pt = await page.evaluate((q) => { const s = document.querySelector(q); const r = s.getBoundingClientRect(); const k = r.width / s.offsetWidth; return { k, x: r.left, y: r.top } }, CANVAS)
await page.mouse.click(pt.x + 300 * pt.k, pt.y + 300 * pt.k)
await page.waitForTimeout(150)
ok((await page.evaluate(() => window.bento.selection.length)) === 0, 'a click on the picture selects nothing')
await page.mouse.click(pt.x + 950 * pt.k, pt.y + 550 * pt.k)
await page.waitForTimeout(150)
ok((await page.evaluate(() => window.bento.selection.join())) === 'r', 'a click on an element above it selects the element')
await page.keyboard.press('Escape')
await page.waitForTimeout(150)

console.log('\napply to all slides')
await (await panelButton('all')).click()
await page.waitForTimeout(300)
d = await model()
ok(d.slides.every((s) => s.backgroundImage === ref), 'every slide points at it')
ok(Object.values(d.assets ?? {}).filter((v) => v.startsWith('data:image/')).length === 1, 'and the bytes are stored ONCE')
ok((await page.$$eval('.ed-sidebar .bento-thumb-surface img.bento-slide-bg', (n) => n.length)) >= 3, 'every sidebar thumbnail shows it')
ok(!(await panelButton('all')), 'with every slide matching, the button goes')
await page.evaluate(() => window.bento.undo())
await page.waitForTimeout(200)
d = await model()
ok(d.slides[0].backgroundImage === ref && !d.slides[1].backgroundImage && !d.slides[2].backgroundImage, 'one undo takes it back off the others')
await page.evaluate(() => window.bento.redo())
await page.waitForTimeout(200)

console.log('\na new slide')
const insertBlank = async () => {
  await page.evaluate(() => [...document.querySelectorAll('.ed-sidebar .ed-insertgap')].pop().click())
  await page.waitForSelector('.ed-layoutpick-item')
  await page.evaluate(() => [...document.querySelectorAll('.ed-layoutpick-item')].find((i) => /blank/i.test(i.textContent))?.click())
  await page.waitForTimeout(250)
}
await insertBlank()
d = await model()
ok(d.slides.length === 4 && d.slides[3].backgroundImage === ref, 'while every slide shares the picture, a new slide takes it')
// the new slide is current: take it off this one and the deck no longer shares one
await (await panelButton('remove')).click()
await page.waitForTimeout(200)
await insertBlank()
d = await model()
ok(d.slides.length === 5 && !d.slides[4].backgroundImage, 'once they differ, a new slide does not')

console.log('\nthe saved file')
const saved = await page.evaluate(() => window.bento.serialize())
const json = JSON.parse(saved.match(/<script[^>]*id="bento-doc"[^>]*>([\s\S]*?)<\/script>/)[1])
ok(json.slides[0].backgroundImage === ref && json.assets?.[key] === d.assets[key], 'the save keeps the picture and its bytes')
// the layout agents rely on (doclayout.ts): the document on one line, then the
// picture data on its own last line, starting "assets":
const blockLines = saved.match(/<script[^>]*id="bento-doc"[^>]*>([\s\S]*?)<\/script>/)[1].trim().split('\n')
ok(blockLines.length === 2 && blockLines[1].startsWith('"assets":') && !blockLines[0].includes(d.assets[key].slice(0, 60)),
  `in the file the picture data is its own LAST line, starting "assets": (${blockLines.map((l) => l.length).join(' + ')} chars)`)
const preview = saved.match(/<div[^>]*data-bento-preview[\s\S]*?<script data-bento-preview/)?.[0] ?? ''
ok(preview.includes('bento-slide-bg') && /background-size:\s*cover/.test(preview), 'the file\'s thumbnail preview carries it, filling the page', preview.length)

console.log('\nthe show')
await page.evaluate(() => document.querySelectorAll('.ed-sidebar .ed-thumb')[0].click())
await page.waitForTimeout(200)
await page.evaluate(() => [...document.querySelectorAll('.ed-pill-main')][0].click())
await page.waitForSelector('.bento-present-overlay .reveal .slides section.present .bento-slide')
await page.waitForTimeout(600)
const SHOW = '.bento-present-overlay section.present .bento-slide'
const showPx = []
for (const [x, y] of [[4, 4], [4, 360], [1276, 716]]) showPx.push(await pixelOn(SHOW, x, y))
ok(showPx.every(isGreen) && isBlue(await pixelOn(SHOW, 950, 550)), `the show paints it filling the slide, under the element (${showPx.map((p) => p?.join('/')).join('  ')})`)
await page.keyboard.press('Escape')
await page.waitForTimeout(400)

console.log('\nremoving it')
await page.evaluate(() => document.querySelectorAll('.ed-sidebar .ed-thumb')[0].click())
await page.waitForTimeout(200)
await (await panelButton('remove')).click()
await page.waitForTimeout(200)
const all = await panelButton('all')
ok(!!all && /remove from all/i.test(await all.textContent()), 'with none here and some elsewhere, the button offers "Remove from all slides"')
await all.click()
await page.waitForTimeout(200)
d = await model()
ok(d.slides.every((s) => !s.backgroundImage), 'and it takes the picture off every slide')
const afterBlock = (await page.evaluate(() => window.bento.serialize())).match(/<script[^>]*id="bento-doc"[^>]*>([\s\S]*?)<\/script>/)[1].trim()
const after = JSON.parse(afterBlock)
ok(!after.assets?.[key], 'the next save drops its bytes')
ok(!after.assets && afterBlock.split('\n').length === 1, 'and with no pictures left the document is a single line again')

console.log('\na picture bigger than 4K')
// 4800×2700, more than 4K: stored at 4K UHD exactly (the background cap), not
// at the 2560 that picture elements get — measured by decoding what is stored.
// It has to look like a PHOTO (noise): the shrink keeps the original whenever
// re-encoding saves under 20%, and a synthetic pattern compresses so well as
// PNG that its 4K version was not smaller.
let seed = 7
const noise = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648 * 60
const BIG = png(4800, 2700, (x, y) => [x / 20 + noise(), y / 12 + noise(), 120 + noise()])
await page.keyboard.press('Escape')
const [bigChooser] = await Promise.all([page.waitForEvent('filechooser'), (await panelButton('choose')).click()])
await bigChooser.setFiles({ name: 'big.png', mimeType: 'image/png', buffer: BIG })
await page.waitForFunction(() => !!window.bento.doc.slides[0].backgroundImage, null, { timeout: 60000 })
const stored = await page.evaluate(() => new Promise((res) => {
  const d = window.bento.doc, img = new Image()
  img.onload = () => res([img.naturalWidth, img.naturalHeight])
  img.onerror = () => res(null)
  img.src = d.assets[d.slides[0].backgroundImage.slice(6)]
}))
ok(JSON.stringify(stored) === '[3840,2160]', `stored at 4K UHD: ${stored?.join('×')}`)

ok(errors.length === 0, 'no page errors', errors)
await browser.close()
console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures ? 1 : 0)
