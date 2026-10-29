#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// The text of a saved deck's #bento-doc (FORK): picture data LAST, on its own line.
//
//   node scripts/test-slides-doc-layout.ts
//
// WHY. A deck's document is one JSON line, and with a 4K picture that line is
// megabytes of base64 — an agent reading line by line cannot stop partway, so
// the slides and the pictures came as one unreadable unit. Now the picture data,
// `assets`, is always the last key and starts its own line; the note at the
// top of every deck tells agents to stop before it.
//
// WHAT THIS PROVES
//   1. doclayout.docText: no assets → exactly JSON.stringify (one line); with
//      assets → two lines, the second starting "assets":, parsing back to the
//      same document with assets moved last and every other key in its order;
//      a nested "assets" key (an embedded document) stays on line 1
//   2. deck-code.mjs carries an identical copy (packed decks read like saved
//      ones), and writes deck.json with assets last
//   3. the kernel: encodeDocBody is compact JSON until an app registers a
//      layout (vanilla's other apps, byte for byte), then uses it; both plain
//      save paths go through the hook, and slides' save.ts registers it

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { docText } from '../slides/src/doclayout.ts'
import { configureApp } from '../kernel/src/app.ts'
import { encodeDocBody, registerDocText } from '../kernel/src/save.ts'

const FAILS: string[] = []
const ok = (cond: boolean, name: string, detail?: unknown) => {
  if (!cond) FAILS.push(name)
  console.log(`${cond ? '  ok  ' : ' FAIL '} ${name}${!cond && detail !== undefined ? '  → ' + JSON.stringify(detail).slice(0, 200) : ''}`)
}
const read = (p: string) => readFileSync(fileURLToPath(new URL(`../${p}`, import.meta.url)), 'utf8')
const deckCode = await import('./deck-code.mjs') as { docText: (d: object) => string; assetsLast: (d: object) => object }

const PNG = 'data:image/png;base64,' + 'A'.repeat(5000)
const base = () => ({ $schema: 'x', format: 'bento/slides', version: 1, title: 't', slides: [{ id: 's', elements: [] }], scripts: { a: { src: 'x' } } })

console.log('the layout')
{
  const plain = base()
  ok(docText(plain) === JSON.stringify(plain), 'no pictures: exactly the compact JSON, one line')
  const withPics = { ...base(), assets: { a1: PNG }, collab: { on: false } }
  const text = docText(withPics)
  const lines = text.split('\n')
  ok(lines.length === 2 && lines[1].startsWith('"assets":'), `with pictures: two lines, the second starting "assets": (${lines.length} lines)`)
  ok(!lines[0].includes(PNG.slice(0, 40)) && lines[0].length < 300, `line 1 carries no picture data (${lines[0].length} chars against ${text.length})`)
  const back = JSON.parse(text)
  ok(JSON.stringify(back) === JSON.stringify({ ...base(), collab: { on: false }, assets: { a1: PNG } }), 'it parses back to the same document, assets moved last, every other key in its order')
  const early = { assets: { a1: PNG }, ...base() }
  const e = docText(early)
  ok(e.split('\n')[1].startsWith('"assets":') && Object.keys(JSON.parse(e)).pop() === 'assets', 'a document whose assets came FIRST still writes them last')
  ok(JSON.stringify(JSON.parse(docText({ assets: {} }))) === '{"assets":{}}', 'a document of nothing but assets is still valid JSON')
  const nested = { ...base(), slides: [{ id: 's', elements: [{ id: 'e', type: 'embed', doc: { assets: { n: 'inner' } } }] }], assets: { a1: PNG } }
  const nl = docText(nested).split('\n')
  ok(nl.length === 2 && nl[0].includes('"assets":{"n":"inner"}'), 'an embedded document\'s own "assets" stays on line 1')
}

console.log('\ndeck-code carries the same layout')
{
  const cases = [base(), { ...base(), assets: { a1: PNG } }, { assets: { a1: PNG }, ...base() }, { assets: {} }]
  ok(cases.every((c) => deckCode.docText(c) === docText(c)), 'deck-code.mjs docText is identical on every case')
  ok(Object.keys(deckCode.assetsLast({ assets: {}, ...base() })).pop() === 'assets', 'deck.json order: assets last')
  const src = read('scripts/deck-code.mjs')
  ok(/const json = docText\(doc\)\.replace\(/.test(src) && (src.match(/JSON\.stringify\(assetsLast\(doc\), null, 2\)/g) ?? []).length === 2,
    'pack splices docText; both deck.json writers put assets last')
}

console.log('\nthe kernel hook')
{
  configureApp({ appName: 'Bento Slides', format: 'bento/slides', shellName: 'Bento_Slides.bento.html' } as never)
  const d = { ...base(), assets: { a1: PNG } }
  ok(await encodeDocBody(d as never) === JSON.stringify(d), 'unregistered: compact JSON, byte for byte (vanilla\'s other apps)')
  registerDocText(docText)
  ok(await encodeDocBody(d as never) === docText(d), 'registered: the app\'s layout')
  const k = read('kernel/src/save.ts')
  ok(/return serializeBody\(shell, docText\(doc\), doc\)/.test(k) && /\n {2}return docText\(doc\)\n\}/.test(k) && !/serializeBody\(shell, JSON\.stringify\(/.test(k),
    'both plain save paths (serializeWith, encodeDocBody) go through the hook, and no other does a plain stringify into the block')
  ok(/registerDocText\(docText\)/.test(read('slides/src/save.ts')), 'slides\' save.ts registers it')
}

console.log(FAILS.length ? `\n${FAILS.length} FAILED` : '\nall checks passed')
process.exit(FAILS.length ? 1 : 0)
