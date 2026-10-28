#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// The animation sequence's FORMAT: additive, gated, round-tripped.
//
//   node scripts/test-slides-anim-format.ts
//
// WHAT THIS PROVES.
//   1. Additivity — the real decks (the starter deck, the gallery fixtures, the
//      agent-deck corpus) carry none of the new fields, so they take the legacy
//      runtime on every slide, and the morph reads exactly their model frames.
//      (That they then PLAY identically is measured by scripts/ab-present-legacy.mjs
//      against an upstream shell.)
//   2. The paste/load gate keeps a well-formed `anim`, drops a bad effect on its
//      own (not the whole list), refuses unknown effect types and malformed
//      eases, and leaves a slide without `anim` exactly as it was.
//   3. The compact form and the schema both know the fields.
//   4. validate() reports what would silently do nothing.

import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { register } from 'node:module'
import type { BentoDoc, Slide } from '../slides/src/model.ts'
register('./lib/ts-resolve-hooks.mjs', import.meta.url)
const { starterDoc } = await import('../slides/src/starterdeck.ts')
const { expandDoc, compactDoc } = await import('../slides/src/compact.ts')
const { sanitizeSlide, EASE_CHECK } = await import('../slides/src/untrusted.ts')
const { morphFrames, usesAnim } = await import('../slides/src/animseq.ts')
const { buildSchema } = await import('../slides/src/schema.ts')
const { validateDoc: validate } = await import('../slides/src/validate.ts')

const FAILS: string[] = []
const ok = (cond: boolean, name: string, detail?: unknown) => {
  if (!cond) FAILS.push(name)
  console.log(`${cond ? '  ok  ' : ' FAIL '} ${name}${!cond && detail !== undefined ? '  → ' + JSON.stringify(detail) : ''}`)
}
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const canon = (v: unknown): string => JSON.stringify(v, (_k, x) => (x && typeof x === 'object' && !Array.isArray(x)) ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, (x as Record<string, unknown>)[k]])) : x)

// --- 1. additivity ------------------------------------------------------------
console.log('real decks carry none of it\n')
const decks: Array<[string, BentoDoc]> = [['starter deck', starterDoc()]]
for (const dir of ['scripts/fixtures/compact-decks', 'scripts/fixtures/agent-decks']) {
  for (const f of readdirSync(join(root, dir)).filter((f) => f.endsWith('.json')).sort()) {
    const raw = JSON.parse(readFileSync(join(root, dir, f), 'utf8'))
    decks.push([f, raw.compact ? expandDoc(raw) : raw])
  }
}
for (const [name, doc] of decks) {
  const slides = doc.slides as Slide[]
  ok(slides.every((s) => !('anim' in s) && !('morphSeconds' in s) && !('morphEase' in s)) && !doc.present?.morphEase, `${name}: no anim / morphSeconds / morphEase anywhere`)
  ok(slides.every((s) => !usesAnim(s)), `${name}: every slide takes the legacy runtime`)
  let model = true
  for (const s of slides) {
    const f = morphFrames(s, 99, Infinity)
    for (const el of s.elements) {
      const x = f.get(el.morphId || el.id)!
      if (x.x !== el.x || x.y !== el.y || x.w !== el.w || x.h !== el.h || x.rotation !== (el.rotation ?? 0) || x.opacity !== (el.opacity ?? 1) || x.scale !== 1) model = false
    }
  }
  ok(model, `${name}: the morph reads exactly the model frames`)
  let unchanged = true
  for (const s of slides) {
    const before = canon(sanitizeSlide(JSON.parse(JSON.stringify(s))))
    const again = sanitizeSlide(JSON.parse(before))
    if (canon(again) !== before || (again && 'anim' in again)) unchanged = false
  }
  ok(unchanged, `${name}: the gate adds nothing to a slide without anim`)
}

// --- 2. the gate ------------------------------------------------------------------
console.log('\nthe gate\n')
const base = { id: 's', background: '#fff', transition: 'morph', notes: '', elements: [{ id: 'a', type: 'shape', shape: 'rect', fill: '#f00', x: 0, y: 0, w: 10, h: 10, rotation: 0, opacity: 1 }] }
const gated = sanitizeSlide({
  ...base,
  morphSeconds: 1.2,
  morphEase: [0.7, 0, 0.2, 1],
  anim: [
    { id: '1', el: 'a', type: 'spin', deg: 720, trigger: 'click', duration: 2, ease: [0.3, 0, 0.2, 1] },
    { id: '2', el: 'a', type: 'move', dx: 10, dy: '5', trigger: 'after', ease: 'power2.out', keys: [{ at: 0, dx: 0 }, { at: 1, dx: 10, ease: 'sine.inOut' }] },
    { id: '3', el: 'a', type: 'teleport' },                     // unknown type: dropped at a paste
    { id: '4', type: 'fade-in' },                               // no target: dropped
    { id: '5', el: 'a', type: 'fade-in', ease: [2, 0, 0, 1] },  // x out of range: the ease is dropped, the effect kept
    { id: '6', el: 'a', type: 'script', script: 'wobble', params: { amp: 4, axis: 'x', on: true, bad: { x: 1 }, __proto__x: 1 } },
    { id: '7', el: 'a', type: 'appear', trigger: 'sometimes', delay: -1, wat: 1 },
  ],
} as unknown) as Slide
const fx = gated.anim ?? []
ok(gated.morphSeconds === 1.2 && canon(gated.morphEase) === canon([0.7, 0, 0.2, 1]), 'per-slide morph timing survives')
ok(fx.map((e) => e.id).join() === '1,2,5,6,7', 'bad effects are dropped one by one, the rest keep their order', fx.map((e) => e.id))
ok(canon(fx[0].ease) === canon([0.3, 0, 0.2, 1]) && fx[0].deg === 720, 'a bezier ease and a big spin survive')
ok(fx[1].dy === 5 && fx[1].keys?.length === 2 && fx[1].keys[1].ease === 'sine.inOut', 'numeric strings coerce; keyframes survive')
ok(fx[2].ease === undefined && fx[2].type === 'fade-in', 'an out-of-range bezier is dropped, its effect kept')
ok(canon(fx[3].params) === canon({ amp: 4, axis: 'x', on: true, __proto__x: 1 }), 'script params keep scalars only', fx[3].params)
ok(!('trigger' in fx[4]) && !('delay' in fx[4]) && !('wat' in fx[4]), 'a bad trigger, a negative delay and an unknown key are dropped')
ok(EASE_CHECK('power2.inOut') === 'power2.inOut' && EASE_CHECK('red;}') === undefined && EASE_CHECK([0, 0, 1]) === undefined && EASE_CHECK([0, NaN, 1, 1]) === undefined && EASE_CHECK([0, 20, 1, 1]) === undefined, 'the ease check')
ok(!('anim' in (sanitizeSlide({ ...base, anim: 'nope' }) as object)), 'a non-list anim is dropped')

// --- 3. compact + schema ------------------------------------------------------------
console.log('\ncompact form and schema\n')
const doc = { ...starterDoc(), present: { morphEase: 'ease-in-out' } } as BentoDoc
doc.slides[1] = { ...doc.slides[1], anim: [{ id: 'x', el: doc.slides[1].elements[0].id, type: 'fade-in' }], morphEase: [0.1, 0.2, 0.3, 0.4] } as Slide
const back = expandDoc(compactDoc(doc)) as BentoDoc
ok(canon(back.slides[1].anim) === canon(doc.slides[1].anim) && canon(back.slides[1].morphEase) === canon([0.1, 0.2, 0.3, 0.4]) && back.present?.morphEase === 'ease-in-out', 'compact round-trip keeps anim, morphEase')
const schema = buildSchema('test') as { $defs: Record<string, { properties: Record<string, unknown> }> }
const slideProps = schema.$defs.slide.properties
ok('anim' in slideProps && 'morphSeconds' in slideProps && 'morphEase' in slideProps, 'the schema describes slide.anim, morphSeconds, morphEase')
const fxSchema = JSON.stringify(slideProps.anim)
ok(['"trigger"', '"deg"', '"dx"', '"keys"', '"script"', '"params"', 'fade-in', 'spin'].every((k) => fxSchema.includes(k)), 'the effect schema lists its keys and types')
ok('morphEase' in (schema.$defs.doc.properties.present as { properties: Record<string, unknown> }).properties, 'the schema describes present.morphEase')

// --- 4. validate --------------------------------------------------------------------
console.log('\nvalidate\n')
const vdoc = starterDoc()
const s0 = vdoc.slides[0]
const target = s0.elements[0]
target.fx = { ...(target.fx ?? {}), enter: 'fade-up' }
s0.anim = [
  { id: 'v1', el: 'nope', type: 'fade-in' },
  { id: 'v2', el: target.id, type: 'teleport' },
  { id: 'v3', el: target.id, type: 'appear', bogus: 1 } as never,
]
const codes = validate(vdoc, { measure: false }).findings.filter((f) => f.slide === s0.id).map((f) => f.code)
ok(codes.includes('anim-dangling-target'), 'a dangling target is reported')
ok(codes.includes('anim-unknown-type'), 'an unknown type is reported')
ok(codes.includes('anim-legacy-ignored'), 'legacy fx ignored on a sequenced slide is reported')
ok(codes.includes('unknown-key'), 'an unknown effect key is reported')

if (FAILS.length) {
  console.log(`\n${FAILS.length} check(s) FAILED`)
  process.exit(1)
}
console.log('\nall anim format checks passed')
