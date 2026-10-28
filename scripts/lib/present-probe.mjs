// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Measuring a slideshow in the built shell, for rigs that must not trust the
// styles the runtime wrote (CLAUDE.md "Testing gotcha"):
//   - GEOMETRY by getBoundingClientRect, converted to slide px through the
//     current section's own slide box (so Reveal's scale cancels out);
//   - OPACITY by reading screenshot pixels — what was actually painted.
// The animation clock is the shell's anim engine in manual mode
// (window.bento.anim.setManual(true) + tick(s)), so nothing depends on the
// page being visible or on how fast the machine is.

import { inflateSync } from 'node:zlib'

/** Decode an 8-bit, non-interlaced PNG (what Chromium screenshots are) to RGBA. */
export function decodePng(buf) {
  let pos = 8
  let width = 0, height = 0, colorType = 0
  const idat = []
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos)
    const type = buf.toString('ascii', pos + 4, pos + 8)
    const data = buf.subarray(pos + 8, pos + 8 + len)
    if (type === 'IHDR') { width = data.readUInt32BE(0); height = data.readUInt32BE(4); colorType = data[9] }
    else if (type === 'IDAT') idat.push(data)
    else if (type === 'IEND') break
    pos += 12 + len
  }
  const bpp = colorType === 6 ? 4 : 3
  const raw = inflateSync(Buffer.concat(idat))
  const stride = width * bpp
  const out = Buffer.alloc(width * height * 4)
  const prev = Buffer.alloc(stride)
  const cur = Buffer.alloc(stride)
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)]
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1))
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0
      const b = prev[i]
      const c = i >= bpp ? prev[i - bpp] : 0
      let v = line[i]
      if (f === 1) v += a
      else if (f === 2) v += b
      else if (f === 3) v += (a + b) >> 1
      else if (f === 4) { const p = a + b - c; const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c }
      cur[i] = v & 255
    }
    for (let x = 0; x < width; x++) {
      out[(y * width + x) * 4] = cur[x * bpp]
      out[(y * width + x) * 4 + 1] = cur[x * bpp + 1]
      out[(y * width + x) * 4 + 2] = cur[x * bpp + 2]
      out[(y * width + x) * 4 + 3] = bpp === 4 ? cur[x * bpp + 3] : 255
    }
    cur.copy(prev)
  }
  return { width, height, data: out }
}

/** Element boxes in slide px for the CURRENT section, keyed by element id. */
export async function boxes(page) {
  return page.evaluate(() => {
    const section = document.querySelector('.bento-present-overlay .reveal .slides section.present')
    const surface = section?.querySelector('.bento-slide')
    if (!surface) return null
    const sr = surface.getBoundingClientRect()
    const scale = sr.width / surface.offsetWidth
    const out = {}
    for (const n of surface.querySelectorAll('[data-el-id]')) {
      const r = n.getBoundingClientRect()
      out[n.dataset.elId] = {
        x: (r.left - sr.left) / scale, y: (r.top - sr.top) / scale,
        w: r.width / scale, h: r.height / scale,
        cx: (r.left + r.width / 2 - sr.left) / scale, cy: (r.top + r.height / 2 - sr.top) / scale,
      }
    }
    const index = [...section.parentElement.children].indexOf(section)
    return { slide: surface.dataset.slideId, index, scale, left: sr.left, top: sr.top, boxes: out }
  })
}

/** The painted colour at slide-px (x, y) of the current section: [r, g, b]. */
export async function pixel(page, x, y) {
  const geo = await page.evaluate(() => {
    const s = document.querySelector('.bento-present-overlay .reveal .slides section.present .bento-slide')
    const r = s.getBoundingClientRect()
    return { left: r.left, top: r.top, scale: r.width / s.offsetWidth }
  })
  const px = Math.round(geo.left + x * geo.scale)
  const py = Math.round(geo.top + y * geo.scale)
  const png = decodePng(await page.screenshot({ clip: { x: px, y: py, width: 1, height: 1 } }))
  return [png.data[0], png.data[1], png.data[2]]
}

export const tick = (page, s) => page.evaluate((x) => window.bento.anim.tick(x), s)

/** Open the built shell, load a document, put the clock in manual mode. */
export async function openDeck(page, shellUrl, doc) {
  await page.goto(shellUrl)
  await page.waitForFunction(() => !!window.bento?.loadDoc)
  if (doc) {
    const ok = await page.evaluate((j) => !!window.bento.loadDoc(j), JSON.stringify(doc))
    if (!ok) throw new Error('loadDoc refused the document')
  }
  await page.evaluate(() => window.bento.anim.setManual(true))
}

/** Start the slideshow from the first slide (tab-fill; headless refuses fullscreen anyway). */
export async function present(page) {
  await page.evaluate(() => {
    const b = [...document.querySelectorAll('.ed-pill-main')][0]
    b.click()
  })
  await page.waitForSelector('.bento-present-overlay .reveal .slides section.present .bento-slide')
  await tick(page, 0)
}
