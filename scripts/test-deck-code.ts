#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// The agent round trip for a deck's code (FORK): scripts/deck-code.mjs.
//
//   node scripts/test-deck-code.ts
//
// WHAT THIS PROVES, on a synthetic shell (no build needed):
//   1. extract → pack is lossless: deck.json + one .js per script, back into
//      the same document; nothing outside #bento-doc changes
//   2. the splice is the platform's: a script whose source contains a literal
//      end-of-script tag still round-trips, and the block cannot close early
//   3. pack refuses a script that does not parse, or lacks meta / a default
//      export — and writes nothing
//   4. `new` scaffolds a script from a template and registers it
//   5. a password-protected deck is refused (there is no plaintext)

import { mkdtempSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const here = dirname(fileURLToPath(import.meta.url))
const TOOL = join(here, 'deck-code.mjs')
const { readDoc, spliceDoc } = await import('./deck-code.mjs')

const FAILS: string[] = []
const ok = (cond: boolean, name: string, detail?: unknown) => {
  if (!cond) FAILS.push(name)
  console.log(`${cond ? '  ok  ' : ' FAIL '} ${name}${!cond && detail !== undefined ? '  → ' + JSON.stringify(detail) : ''}`)
}
const run = (...args: string[]) => spawnSync(process.execPath, [TOOL, ...args], { encoding: 'utf8' })

const CLOSE = '</scr' + 'ipt>'
const SHELL = `<!doctype html><html><head><title>t</title></head><body><p>chrome</p>`
  + `<script type="application/bento+json" id="bento-doc">${CLOSE}<p>after</p></body></html>`
const HOP = `export const meta = { kind: 'effect', drives: ['y'] }
// a string that would close a script block if spliced raw: "${CLOSE}"
export default function hop(p, base) { return { y: base.y - 40 * Math.sin(p * Math.PI) } }
`
const DOC = {
  format: 'bento/slides', version: 1, title: 'round trip', size: { width: 1280, height: 720 },
  theme: { background: '#fff', color: '#111', accent: '#f90', fontFamily: 'system-ui' },
  scripts: { hop: { src: HOP } },
  slides: [{ id: 's1', background: '#fff', transition: 'none', notes: '', elements: [], anim: [] }],
}

const dir = mkdtempSync(join(tmpdir(), 'deck-code-'))
const deckFile = join(dir, 'talk.bento.html')
writeFileSync(join(dir, 'shell.html'), SHELL)
writeFileSync(deckFile, spliceDoc(SHELL, DOC))

console.log('the splice')
const spliced = readFileSync(deckFile, 'utf8')
ok(spliced.split(CLOSE).length - 1 === 1, 'the deck file has exactly one end-of-script tag: the block\'s own')
ok(JSON.stringify(readDoc(spliced)) === JSON.stringify(DOC), 'readDoc gives back the document, the dangerous string included')
ok(spliced.startsWith('<!doctype html><html><head><title>t</title></head><body><p>chrome</p>') && spliced.endsWith('<p>after</p></body></html>'), 'nothing outside the block changed')

console.log('\nextract → pack')
let r = run('extract', deckFile, join(dir, 'talk-code'))
ok(r.status === 0, 'extract runs', r.stderr)
const deckJson = JSON.parse(readFileSync(join(dir, 'talk-code', 'deck.json'), 'utf8'))
ok(deckJson.scripts.hop.src === '@file scripts/hop.js' && readFileSync(join(dir, 'talk-code', 'scripts', 'hop.js'), 'utf8') === HOP, 'deck.json points at scripts/hop.js, which holds the source')
r = run('pack', join(dir, 'talk-code'), join(dir, 'out.bento.html'), '--shell', join(dir, 'shell.html'))
ok(r.status === 0, 'pack runs', r.stderr)
ok(JSON.stringify(readDoc(readFileSync(join(dir, 'out.bento.html'), 'utf8'))) === JSON.stringify(DOC), 'the packed deck is the original document')

console.log('\npack refuses bad code, and writes nothing')
writeFileSync(join(dir, 'talk-code', 'scripts', 'hop.js'), 'export const meta = {\nexport default 1')
r = run('pack', join(dir, 'talk-code'), join(dir, 'bad.bento.html'), '--shell', join(dir, 'shell.html'))
ok(r.status !== 0 && /does not parse/.test(r.stderr) && !existsSync(join(dir, 'bad.bento.html')), 'a syntax error: refused, nothing written', r.stderr)
writeFileSync(join(dir, 'talk-code', 'scripts', 'hop.js'), 'export function f() {}')
r = run('pack', join(dir, 'talk-code'), join(dir, 'bad.bento.html'), '--shell', join(dir, 'shell.html'))
ok(r.status !== 0 && /meta/.test(r.stderr) && !existsSync(join(dir, 'bad.bento.html')), 'no meta / default export: refused', r.stderr)
writeFileSync(join(dir, 'talk-code', 'scripts', 'hop.js'), HOP)

console.log('\nnew')
r = run('new', join(dir, 'talk-code'), 'swing', '--kind', 'canvas')
const after = JSON.parse(readFileSync(join(dir, 'talk-code', 'deck.json'), 'utf8'))
ok(r.status === 0 && after.scripts.swing?.src === '@file scripts/swing.js' && readdirSync(join(dir, 'talk-code', 'scripts')).includes('swing.js'), 'new --kind canvas writes and registers a script', r.stderr)
r = run('pack', join(dir, 'talk-code'), join(dir, 'two.bento.html'), '--shell', join(dir, 'shell.html'))
const two = readDoc(readFileSync(join(dir, 'two.bento.html'), 'utf8'))
ok(r.status === 0 && /kind: 'canvas'/.test(two.scripts.swing.src), 'the scaffolded template packs (it parses, declares meta, exports draw)', r.stderr)
r = run('new', join(dir, 'talk-code'), '../evil', '--kind', 'canvas')
ok(r.status !== 0, 'a script name that is not a file name is refused')

console.log('\na password-protected deck')
writeFileSync(join(dir, 'enc.bento.html'), spliceDoc(SHELL, { format: 'bento/enc', v: 1, salt: 'x', iv: 'y', ct: 'z' }))
r = run('extract', join(dir, 'enc.bento.html'), join(dir, 'enc-code'))
ok(r.status !== 0 && /password/.test(r.stderr) && !existsSync(join(dir, 'enc-code', 'deck.json')), 'refused: there is no plaintext to extract', r.stderr)

console.log(`\n${FAILS.length ? `${FAILS.length} FAILED` : 'all checks passed'}`)
process.exit(FAILS.length ? 1 : 0)
