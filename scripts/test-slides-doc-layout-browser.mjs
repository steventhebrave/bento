// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// The saved document's layout through the real slides app (kernel docText).
//
//   npm run build:single --prefix slides && node scripts/test-slides-doc-layout-browser.mjs
//
// A deck with a picture saves (window.bento.serialize — the same path as ⌘S)
// as the document on one line and the picture data on the LAST line, starting
// "assets":; it parses back to the same document; once the picture is gone the
// save is a single line again (the asset is pruned).
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')

let checks = 0
let failures = 0
function ok(cond, msg, detail) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}${detail !== undefined ? '  → ' + JSON.stringify(detail) : ''}`) } else console.log(`  ok    ${msg}`)
}
const SHELL = new URL('../slides/dist-single/Bento_Slides.bento.html', import.meta.url).href
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
const DOC = {
  format: 'bento/slides', version: 1, title: 'layout rig', size: { width: 1280, height: 720 },
  theme: { background: '#ffffff', color: '#111111', accent: '#ff9e8a', fontFamily: 'system-ui, sans-serif' },
  assets: { pic: PNG },
  slides: [{ id: 's1', background: '#ffffff', transition: 'none', notes: '', elements: [
    { id: 'img', type: 'image', x: 100, y: 100, w: 200, h: 200, rotation: 0, opacity: 1, src: 'asset:pic', fit: 'cover', radius: 0 },
  ] }],
}
const block = (html) => html.match(/<script type="application\/bento\+json" id="bento-doc">([\s\S]*?)<\/script>/)[1].trim()

const browser = await chromium.launch()
const page = await browser.newPage()
const errors = []
page.on('pageerror', (e) => errors.push(String(e)))
await page.goto(SHELL)
await page.waitForFunction(() => !!window.bento?.loadDoc)
await page.evaluate((j) => window.bento.loadDoc(j), JSON.stringify(DOC))

const withPic = block(await page.evaluate(() => window.bento.serialize()))
const lines = withPic.split('\n')
ok(lines.length === 2 && lines[1].startsWith('"assets":') && lines[1].includes(PNG.slice(30)), `a deck with a picture: the picture data is its own LAST line (${lines.map((l) => l.length).join(' + ')} chars)`)
ok(!lines[0].includes(PNG.slice(30)) && lines[0].includes('"slides"'), 'line 1 is the document, with no picture data in it')
const parsed = JSON.parse(withPic)
ok(parsed.assets?.pic === PNG && parsed.slides?.[0]?.elements?.[0]?.src === 'asset:pic' && Object.keys(parsed).pop() === 'assets', 'it parses back to the document, assets last')

await page.evaluate(() => { window.bento.doc.slides[0].elements = [] })
const without = block(await page.evaluate(() => window.bento.serialize()))
ok(without.split('\n').length === 1 && !('assets' in JSON.parse(without)), 'with the picture gone, the save is one line again')

ok(errors.length === 0, 'no page errors', errors)
await browser.close()
console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures ? 1 : 0)
