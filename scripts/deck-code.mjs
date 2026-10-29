#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// A deck as plain files, and back — for agents and people who would rather edit
// JSON and JavaScript in an editor than inside one HTML file.
//
//   node scripts/deck-code.mjs extract deck.bento.html [dir]
//       dir/deck.json          the document, pretty-printed; each script's
//                              source replaced by "@file scripts/<name>.js"
//       dir/scripts/<name>.js  one file per entry of doc.scripts
//
//   node scripts/deck-code.mjs pack dir [out.bento.html] [--shell shell.html]
//       reads dir/deck.json, inlines every "@file …" reference, checks each
//       script parses as a module, and writes the document into a shell:
//       --shell when given, else out.bento.html's own shell when it exists (an
//       update keeps the file's app), else slides/dist-single/Bento_Slides.bento.html.
//
//   node scripts/deck-code.mjs new <dir> <name> --kind effect|canvas
//       writes dir/scripts/<name>.js from a template and registers it in deck.json
//
// The splice is the platform's (docs/PLATFORM.md §2): the #bento-doc block is
// replaced whole, its JSON with every `<` written as < so the block can
// never close early. Nothing else in the file is touched. A password-protected
// deck (a bento/enc envelope) is refused — there is no plaintext to extract.

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs'
import { dirname, join, resolve, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const BLOCK = /<script type="application\/bento\+json" id="bento-doc">([\s\S]*?)<\/script>/
const FILE_REF = /^@file\s+(.+)$/
const NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/

const die = (msg) => { console.error(`deck-code: ${msg}`); process.exit(1) }

export function readDoc(html) {
  const m = html.match(BLOCK)
  if (!m) throw new Error('no #bento-doc block — is this a Bento file?')
  const text = m[1].trim()
  if (!text) throw new Error('the #bento-doc block is empty (a fresh app shell, not a deck)')
  const doc = JSON.parse(text)
  if (doc && doc.format === 'bento/enc') throw new Error('this deck is password-protected; open it, remove the password, save, then extract')
  return doc
}

/**
 * The text of #bento-doc: compact JSON with the picture data, `assets`, LAST
 * and on its own line — identical to the app's (slides/src/doclayout.ts;
 * scripts/test-slides-doc-layout.ts pins the two), so a packed deck reads like
 * a saved one: an agent can stop before the line that starts "assets".
 */
export function docText(doc) {
  const { assets, ...rest } = doc
  const head = JSON.stringify(rest)
  if (assets === undefined) return head
  return `${head.slice(0, -1)}${head === '{}' ? '' : ','}\n"assets":${JSON.stringify(assets)}}`
}

/** The document with `assets` moved to the end (deck.json's order: pictures last). */
export const assetsLast = (doc) => {
  const { assets, ...rest } = doc
  return assets === undefined ? rest : { ...rest, assets }
}

export function spliceDoc(shell, doc) {
  if (!BLOCK.test(shell)) throw new Error('the shell has no #bento-doc block')
  const json = docText(doc).replace(/</g, '\\u003c')
  // a replacer FUNCTION, so `$&` and friends in the JSON stay literal
  return shell.replace(BLOCK, () => `<script type="application/bento+json" id="bento-doc">\n${json}\n</scr` + 'ipt>')
}

/** Does `src` parse as an ES module? Uses node itself; returns an error string or null. */
export function checkModule(src) {
  const r = spawnSync(process.execPath, ['--input-type=module', '--check'], { input: src, encoding: 'utf8' })
  return r.status === 0 ? null : (r.stderr || 'does not parse').trim().split('\n').slice(0, 6).join('\n')
}

const TEMPLATES = {
  effect: (name) => `// ${name} — a bento script effect (Tier 2). The UI owns WHEN (trigger, delay,
// duration, easing); this owns WHAT happens during it. Pure: no timers, no
// requestAnimationFrame, no clock — use ctx.t and ctx.random.
export const meta = {
  kind: 'effect',
  label: '${name}',
  // the frame properties this script changes (x, y, rotation, scale, opacity, fill, color)
  drives: ['x'],
  params: {
    amplitude: { type: 'number', min: 0, max: 200, default: 40, unit: 'px', label: 'Amplitude' },
    frequency: { type: 'number', min: 0.1, max: 10, default: 3, unit: 'Hz', label: 'Frequency' },
  },
}

/**
 * @param p      the effect's eased progress, 0..1
 * @param base   { x, y, w, h, rotation, scale, opacity, fill?, color? } — what the
 *               UI-authored effects produce at this moment (slide px, degrees)
 * @param params this effect's parameter values (defaults filled in)
 * @param ctx    { t, duration, click, el: {w, h}, slide: {w, h}, random(), noise(x) }
 * @returns      a partial frame; only the keys in meta.drives are used
 */
export default function frame(p, base, params, ctx) {
  const wobble = params.amplitude * Math.sin(2 * Math.PI * params.frequency * ctx.t) * (1 - p)
  return { x: base.x + wobble }
}
`,
  canvas: (name) => `// ${name} — a bento code canvas (Tier 3). The element's frame, size and
// effects belong to the UI; what is drawn inside belongs to this. Pure: draw
// the picture for (click, t) — the host may seek anywhere, any time.
export const meta = {
  kind: 'canvas',
  label: '${name}',
  params: {
    speed: { type: 'number', min: 0, max: 5, default: 1, label: 'Speed' },
  },
  // optional: seconds of motion on each click (scrub range, poster, CPU)
  duration: { 1: 4 },
}

/**
 * @param g    CanvasRenderingContext2D, units = element px (device pixels handled)
 * @param ctx  { click, t, params, width, height, random(), noise(x) }
 */
export default function draw(g, ctx) {
  g.clearRect(0, 0, ctx.width, ctx.height)
  const a = ctx.click >= 1 ? ctx.t * ctx.params.speed : 0
  g.save()
  g.translate(ctx.width / 2, ctx.height / 2)
  g.rotate(a)
  g.fillStyle = '#ff9e8a'
  g.fillRect(-40, -40, 80, 80)
  g.restore()
}
`,
}

function extract(file, dir) {
  const doc = readDoc(readFileSync(file, 'utf8'))
  dir ??= file.replace(/\.bento\.html$|\.html$/i, '') + '-code'
  mkdirSync(join(dir, 'scripts'), { recursive: true })
  const scripts = doc.scripts && typeof doc.scripts === 'object' ? doc.scripts : {}
  let n = 0
  for (const [name, entry] of Object.entries(scripts)) {
    if (!NAME.test(name)) die(`script name "${name}" cannot be a file name`)
    if (!entry || typeof entry.src !== 'string') continue
    writeFileSync(join(dir, 'scripts', `${name}.js`), entry.src)
    entry.src = `@file scripts/${name}.js`
    n++
  }
  writeFileSync(join(dir, 'deck.json'), JSON.stringify(assetsLast(doc), null, 2) + '\n')
  console.log(`extracted ${relative(process.cwd(), join(dir, 'deck.json'))}${n ? ` and ${n} script(s) into ${relative(process.cwd(), join(dir, 'scripts'))}/` : ''}`)
}

async function pack(dir, out, shellPath) {
  const deckPath = join(dir, 'deck.json')
  if (!existsSync(deckPath)) die(`${deckPath} not found`)
  let doc = JSON.parse(readFileSync(deckPath, 'utf8'))
  if (doc.format !== 'bento/slides' && doc.compact !== true) die(`deck.json is not a bento/slides document (format: ${doc.format})`)
  let problems = 0
  for (const [name, entry] of Object.entries(doc.scripts ?? {})) {
    if (!NAME.test(name)) { console.error(`  ${name}: not a valid script name`); problems++; continue }
    const ref = typeof entry?.src === 'string' && entry.src.match(FILE_REF)
    if (ref) {
      const p = resolve(dir, ref[1].trim())
      if (!existsSync(p)) { console.error(`  ${name}: ${ref[1]} not found`); problems++; continue }
      entry.src = readFileSync(p, 'utf8')
    }
    if (typeof entry?.src !== 'string') { console.error(`  ${name}: no source`); problems++; continue }
    const err = checkModule(entry.src)
    if (err) { console.error(`  ${name}: does not parse as a module\n${err.replace(/^/gm, '      ')}`); problems++ }
    else if (!/export\s+const\s+meta\b/.test(entry.src) || !/export\s+default\b/.test(entry.src)) {
      console.error(`  ${name}: needs \`export const meta = {…}\` and \`export default function …\``); problems++
    }
  }
  // unreferenced script files are almost always a forgotten registration
  const sdir = join(dir, 'scripts')
  if (existsSync(sdir)) {
    for (const f of readdirSync(sdir).filter((f) => f.endsWith('.js'))) {
      const name = f.slice(0, -3)
      if (!doc.scripts?.[name]) console.warn(`  note: scripts/${f} is not in deck.json "scripts" — not packed (deck-code new registers it)`)
    }
  }
  if (problems) die(`${problems} problem(s); nothing written`)
  // an agent may write the COMPACT form (AGENTS.md); the file is always saved full
  if (doc.compact === true) {
    const { register } = await import('node:module')
    register('./lib/ts-resolve-hooks.mjs', import.meta.url)
    const { expandDoc } = await import('../slides/src/compact.ts')
    const scripts = doc.scripts
    const full = expandDoc(doc)
    if (scripts) full.scripts = scripts
    doc = full
  }
  out ??= dir.replace(/[\\/]$/, '').replace(/-code$/, '') + '.bento.html'
  // an explicit --shell wins; else the file's own shell (an update keeps its app); else the built one
  const shellFile = shellPath ?? (existsSync(out) ? out : join(root, 'slides/dist-single/Bento_Slides.bento.html'))
  if (!existsSync(shellFile)) die(`no shell at ${shellFile} — build one (cd slides && npm run build:single) or pass --shell`)
  writeFileSync(out, spliceDoc(readFileSync(shellFile, 'utf8'), doc))
  console.log(`packed ${relative(process.cwd(), out)} (shell: ${relative(process.cwd(), shellFile)})`)
}

function scaffold(dir, name, kind) {
  if (!NAME.test(name ?? '')) die('usage: deck-code.mjs new <dir> <name> --kind effect|canvas')
  if (!TEMPLATES[kind]) die('--kind must be effect or canvas')
  const deckPath = join(dir, 'deck.json')
  if (!existsSync(deckPath)) die(`${deckPath} not found — extract a deck first`)
  const doc = JSON.parse(readFileSync(deckPath, 'utf8'))
  mkdirSync(join(dir, 'scripts'), { recursive: true })
  const file = join(dir, 'scripts', `${name}.js`)
  if (existsSync(file)) die(`${file} already exists`)
  writeFileSync(file, TEMPLATES[kind](name))
  doc.scripts = { ...(doc.scripts ?? {}), [name]: { src: `@file scripts/${name}.js` } }
  writeFileSync(deckPath, JSON.stringify(assetsLast(doc), null, 2) + '\n')
  console.log(`wrote ${relative(process.cwd(), file)} and registered "${name}" in deck.json`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  const flag = (k) => { const i = args.indexOf(k); if (i < 0) return undefined; const v = args[i + 1]; args.splice(i, 2); return v }
  const shell = flag('--shell')
  const kind = flag('--kind')
  const [cmd, a, b] = args
  try {
    if (cmd === 'extract' && a) extract(a, b)
    else if (cmd === 'pack' && a) await pack(a, b, shell)
    else if (cmd === 'new' && a) scaffold(a, b, kind)
    else {
      console.log('usage:\n  deck-code.mjs extract deck.bento.html [dir]\n  deck-code.mjs pack dir [out.bento.html] [--shell shell.html]\n  deck-code.mjs new dir name --kind effect|canvas')
      process.exit(cmd ? 1 : 0)
    }
  } catch (e) {
    die(e.message)
  }
}
