#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// A slide's background picture (FORK): the format, the deck-wide rule, the clipboard.
//
//   slides/node_modules/.bin/esbuild scripts/test-slides-bgimage.ts --bundle --platform=node \
//     --format=esm --outfile=/tmp/test-slides-bgimage.mjs && node /tmp/test-slides-bgimage.mjs
//
// BUNDLED, not run directly, like test-clipboard.ts: clipboard.ts imports
// '../model' without an extension.
//
// WHAT THIS PROVES
//   1. the gate keeps `asset:<key>` and a `data:image/…` URI, and drops a web
//      URL, a non-image data: URI, junk and a CSS breakout — nothing that
//      would make a pasted slide reach the network
//   2. the save keeps the picture's asset (and drops it once no slide uses it)
//   3. deckBackgroundImage: the shared picture when EVERY slide has the same
//      one, otherwise none — the rule a new slide follows
//   4. a copied slide carries its picture; pasted into a deck whose same key
//      holds something else, the slide follows the re-keyed asset

import { insertSlides, parseClip, serializeSlides } from '../slides/src/editor/clipboard.ts'
import { deckBackgroundImage, type BentoDoc, type Slide } from '../slides/src/model.ts'
import { pruneUnusedAssets } from '../slides/src/assets.ts'
import { sanitizeSlide } from '../slides/src/untrusted.ts'

const FAILS: string[] = []
const ok = (cond: boolean, name: string, detail?: unknown) => {
  if (!cond) FAILS.push(name)
  console.log(`${cond ? '  ok  ' : ' FAIL '} ${name}${!cond && detail !== undefined ? '  → ' + JSON.stringify(detail) : ''}`)
}

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
const slide = (id: string, extra: Partial<Slide> = {}): Slide =>
  ({ id, background: '#ffffff', transition: 'none', notes: '', elements: [], ...extra }) as Slide
const doc = (slides: Slide[], assets?: Record<string, string>): BentoDoc =>
  ({ format: 'bento/slides', version: 1, title: 't', size: { width: 1280, height: 720 },
     theme: { background: '#fff', color: '#111', accent: '#f80', fontFamily: 'sans-serif' }, slides, ...(assets ? { assets } : {}) }) as BentoDoc

console.log('the gate')
{
  const bg = (v: unknown) => (sanitizeSlide({ ...slide('s'), backgroundImage: v }) as Slide).backgroundImage
  ok(bg('asset:a1') === 'asset:a1', 'an asset reference is kept')
  ok(bg(PNG) === PNG, 'an embedded picture is kept')
  ok(bg('data:image/svg+xml;base64,PHN2Zy8+') !== undefined, 'an embedded svg picture is kept (an <img> never runs its script)')
  ok(bg('https://example.com/a.png') === undefined, 'a web URL is dropped: a pasted slide must not make the page fetch')
  ok(bg('//example.com/a.png') === undefined && bg('a.png') === undefined, 'a protocol-relative URL and a bare path are dropped too')
  ok(bg('data:text/html,<b>hi</b>') === undefined, 'a non-image data: URI is dropped')
  ok(bg('javascript:alert(1)') === undefined, 'a script URL is dropped')
  ok(bg('asset:a");x:url(//e') === undefined && bg('asset:') === undefined, 'an asset "key" carrying a CSS breakout, or none, is dropped')
  ok(bg(42) === undefined, 'a non-string is dropped')
  ok((sanitizeSlide({ ...slide('s'), backgroundImage: 'https://e/x' }) as Slide).id === 's', 'the slide itself survives a bad picture')
}

console.log('\nthe save keeps the picture')
{
  const d = doc([slide('a', { backgroundImage: 'asset:bg' }), slide('b')], { bg: PNG, stray: PNG })
  const out = pruneUnusedAssets(d)
  ok(!!out.assets && out.assets.bg === PNG && !('stray' in out.assets), 'its asset survives a save; an unreferenced one does not')
  const gone = pruneUnusedAssets(doc([slide('a'), slide('b')], { bg: PNG }))
  ok(gone.assets === undefined, 'with no slide using it, it is pruned like any asset')
}

console.log('\nthe deck-wide picture (what a new slide takes)')
{
  ok(deckBackgroundImage(doc([slide('a', { backgroundImage: 'asset:x' }), slide('b', { backgroundImage: 'asset:x' })])) === 'asset:x',
    'every slide has the same picture: that is the deck\'s')
  ok(deckBackgroundImage(doc([slide('a', { backgroundImage: 'asset:x' }), slide('b')])) === undefined,
    'a picture on the title slide alone is not the deck\'s')
  ok(deckBackgroundImage(doc([slide('a', { backgroundImage: 'asset:x' }), slide('b', { backgroundImage: 'asset:y' })])) === undefined,
    'two different pictures: none')
  ok(deckBackgroundImage(doc([slide('a'), slide('b')])) === undefined && deckBackgroundImage(doc([])) === undefined, 'no pictures, or no slides: none')
}

console.log('\ncopy and paste')
{
  const src = doc([slide('a', { backgroundImage: 'asset:bg' })], { bg: PNG })
  const clip = parseClip(serializeSlides(src.slides, src))
  ok(!!clip && clip.assets?.bg === PNG, 'a copied slide carries its picture\'s bytes')
  ok(clip?.slides?.[0].backgroundImage === 'asset:bg', 'and the reference, through the paste gate')
  // the target deck already uses the key "bg" for a different picture
  const OTHER = 'data:image/gif;base64,R0lGODlhAQABAAAAACw='
  const target = doc([slide('t', { backgroundImage: 'asset:bg' })], { bg: OTHER })
  const [pasted] = insertSlides(clip!, target, 1)
  const key = pasted.backgroundImage?.slice(6) ?? ''
  ok(pasted.backgroundImage !== 'asset:bg' && target.assets?.[key] === PNG, `the pasted slide follows its re-keyed picture (${pasted.backgroundImage})`)
  ok(target.slides[0].backgroundImage === 'asset:bg' && target.assets?.bg === OTHER, 'the target\'s own picture is untouched')
  const same = doc([slide('t')], { bg: PNG })
  const [again] = insertSlides(clip!, same, 1)
  ok(again.backgroundImage === 'asset:bg' && Object.keys(same.assets ?? {}).length === 1, 'pasted where the same bytes already sit under that key: shared, not duplicated')
}

console.log(FAILS.length ? `\n${FAILS.length} FAILED` : '\nall checks passed')
process.exit(FAILS.length ? 1 : 0)
