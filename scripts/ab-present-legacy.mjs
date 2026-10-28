// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// A/B: does an existing deck PLAY exactly as it did? Two built shells, the
// same documents, the same keypresses, the same manual-clock instants; every
// element's measured box and the painted screen compared frame by frame.
//
//   node scripts/ab-present-legacy.mjs <baseline-shell.html> <candidate-shell.html> [deck.json | starter …]
//
// With no deck given, the shells' own starter deck (what a fresh build opens
// with — morphs, entrances, count-ups, reveal steps) plus every JSON under
// scripts/fixtures/agent-decks/. A tool, not a CI rig: the baseline is a shell
// built from the commit you compare against (git worktree + build:single), which
// CI does not have. Exit 1 on any difference.
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'
import { boxes, tick, openDeck, present } from './lib/present-probe.mjs'

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')
const [baseShell, candShell, ...deckArgs] = process.argv.slice(2)
if (!baseShell || !candShell) {
  console.error('usage: node scripts/ab-present-legacy.mjs <baseline-shell> <candidate-shell> [deck.json …]')
  process.exit(2)
}
const root = dirname(dirname(fileURLToPath(import.meta.url)))
const fixtures = join(root, 'scripts/fixtures/agent-decks')
const decks = deckArgs.length
  ? deckArgs.map((p) => (p === 'starter' ? { name: 'starter deck', doc: null } : { name: p, doc: JSON.parse(readFileSync(p, 'utf8')) }))
  : [{ name: 'starter deck', doc: null },
     ...readdirSync(fixtures).filter((f) => f.endsWith('.json')).map((f) => ({ name: f, doc: JSON.parse(readFileSync(join(fixtures, f), 'utf8')) }))]

const INSTANTS = [0, 0.05, 0.15, 0.3, 0.5, 0.8, 1.2, 2, 3.5]

/** Walk a deck: every → from the first slide to the end, sampled at fixed instants. */
async function walk(shell, doc) {
  const browser = await chromium.launch()
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } })
  // the legacy 2.8s wall-clock settle would fire at a different point in each
  // run; the manual clock is the only time here
  await page.addInitScript(() => {
    const st = window.setTimeout
    window.setTimeout = (fn, ms, ...a) => (ms === 2800 ? 0 : st(fn, ms, ...a))
  })
  await openDeck(page, pathToFileURL(resolve(shell)).href, doc)
  // CSS transitions (Reveal's section fade, the progress bar) run on the WALL
  // clock, so a screenshot would catch them at a different point each run.
  // Both shells get the same freeze; the animation engine is JS on the manual clock.
  await page.addStyleTag({ content: '*, *::before, *::after { transition: none !important; }' })
  await present(page)
  // as many presses as the deck has slides plus reveal steps, plus one past the
  // end (a deck with ambient loops never "stops changing", so the walk is
  // bounded by the deck itself, not by a fixed point)
  const presses = await page.evaluate(() => {
    const d = window.bento.doc
    const steps = d.slides.reduce((n, s) => n + new Set(s.elements.map((e) => e.fx?.step).filter((x) => x > 0)).size, 0)
    return d.slides.length + steps + 1
  })
  const frames = []
  for (let press = 0; press < presses; press++) {
    let elapsed = 0
    for (const at of INSTANTS) {
      await tick(page, at - elapsed)
      elapsed = at
      const b = await boxes(page)
      const png = await page.screenshot()
      const shot = createHash('sha1').update(png).digest('hex')
      // slides are compared by POSITION: a deck may mint fresh slide ids per load
      frames.push({ press, at, slide: b?.index, boxes: b?.boxes, shot, png })
    }
    await page.keyboard.press('ArrowRight')
    await tick(page, 0)
  }
  await browser.close()
  return frames
}

let failures = 0
for (const deck of decks) {
  const a = await walk(baseShell, deck.doc)
  const b = await walk(candShell, deck.doc)
  // Calibration: the baseline walked a SECOND time. A frame whose screenshot
  // differs between two runs of the same shell is noise in the baseline itself
  // (the formula/code symbol morph measures live layout), so it cannot count
  // against the candidate. Boxes get no such allowance.
  const a2 = await walk(baseShell, deck.doc)
  const noisy = new Set(a.map((f, i) => (a2[i] && a2[i].shot !== f.shot ? i : -1)).filter((i) => i >= 0))
  let worst = 0
  let where = ''
  let shotsDiffer = 0
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) {
    if (a[i].slide !== b[i].slide) { worst = Infinity; where = `press ${a[i].press} @${a[i].at}s: slide ${a[i].slide} vs ${b[i].slide}`; break }
    // elements are matched by PAINT ORDER: a deck (the starter) may mint fresh element ids per load
    const bl = Object.values(b[i].boxes ?? {})
    for (const [k, [id, ba]] of Object.entries(Object.entries(a[i].boxes ?? {}))) {
      const bb = bl[Number(k)]
      if (!bb) { worst = Infinity; where = `press ${a[i].press} @${a[i].at}s: ${id} missing`; break }
      for (const k of ['x', 'y', 'w', 'h']) {
        const d = Math.abs(ba[k] - bb[k])
        if (d > worst) { worst = d; where = `press ${a[i].press} @${a[i].at}s slide ${a[i].slide}: ${id}.${k} ${ba[k].toFixed(2)} vs ${bb[k].toFixed(2)}` }
      }
    }
    if (a[i].shot !== b[i].shot && !noisy.has(i)) {
      if (!shotsDiffer && process.env.AB_DUMP) {
        writeFileSync(join(process.env.AB_DUMP, `a-${deck.name.replace(/\W+/g, '_')}.png`), a[i].png)
        writeFileSync(join(process.env.AB_DUMP, `b-${deck.name.replace(/\W+/g, '_')}.png`), b[i].png)
        console.log(`    first differing frame: press ${a[i].press} @${a[i].at}s (dumped to ${process.env.AB_DUMP})`)
      }
      shotsDiffer++
    }
  }
  const same = a.length === b.length && worst <= 0.01 && shotsDiffer === 0
  if (!same) failures++
  console.log(`${same ? '  same ' : '  DIFF '} ${deck.name}: ${n} frames, worst box delta ${worst === Infinity ? '∞' : worst.toFixed(3)}px${where ? ` (${where})` : ''}, ${shotsDiffer} screenshot(s) differ (${noisy.size} noisy in the baseline itself, ignored)${a.length !== b.length ? `, frame counts ${a.length} vs ${b.length}` : ''}`)
}
console.log(failures ? `\n${failures} deck(s) play differently` : '\nevery deck plays identically')
process.exit(failures ? 1 : 0)
