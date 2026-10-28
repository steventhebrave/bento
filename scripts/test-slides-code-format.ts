#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// The code layer's DOM-free half (FORK): format, gate, bake plan, sampler.
//
//   node scripts/test-slides-code-format.ts
//
// WHAT THIS PROVES.
//   1. Format — `doc.scripts` and the `canvas` element survive the load gate
//      as data: bad script names and oversized sources are dropped one by one,
//      a canvas keeps its script NAME, params and poster moment; the schema
//      and compact form know them; a canvas's poster asset survives save-time
//      pruning (it would otherwise be deleted on every save).
//   2. The bake plan — a script effect's samples carry `base` = the frame from
//      every effect BEFORE it (a move running alongside shows through), the
//      job key changes exactly when an input does, and a missing script or
//      element makes no job.
//   3. The sampler — interpolates between baked samples, files tracks per
//      slide AND effect (a duplicated slide's effect ids repeat), names an
//      id-less effect by its position, and layers on the UI effects:
//      stateAt(x from a move, y from a script).
//   4. validate() reports a script effect or canvas whose script is missing.

import { register } from 'node:module'
import type { BentoDoc, Slide } from '../slides/src/model.ts'
register('./lib/ts-resolve-hooks.mjs', import.meta.url)
const { sanitizeDoc } = await import('../slides/src/restoregate.ts')
const { sanitizeScripts, LIMITS } = await import('../slides/src/untrusted.ts')
const { buildSchema } = await import('../slides/src/schema.ts')
const { validateDoc } = await import('../slides/src/validate.ts')
const { pruneUnusedAssets } = await import('../slides/src/assets.ts')
const { expandDoc, compactDoc } = await import('../slides/src/compact.ts')
const { stateAt, planAnim } = await import('../slides/src/animseq.ts')
const { bakeJobs, sampleCount, trackKey, trackSampler, MAX_SAMPLES } = await import('../slides/src/code/bake.ts')
const { freshScriptName, CANVAS_TEMPLATE, EFFECT_TEMPLATE } = await import('../slides/src/code/templates.ts')

const FAILS: string[] = []
const ok = (cond: boolean, name: string, detail?: unknown) => {
  if (!cond) FAILS.push(name)
  console.log(`${cond ? '  ok  ' : ' FAIL '} ${name}${!cond && detail !== undefined ? '  → ' + JSON.stringify(detail) : ''}`)
}
const near = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) <= eps

const rect = (id: string, x: number, y: number) => ({ id, type: 'shape', shape: 'rect', x, y, w: 80, h: 80, rotation: 0, opacity: 1, fill: '#ff0000' })
const baseDoc = (extra: Partial<BentoDoc> = {}, slides: unknown[] = []): Record<string, unknown> => ({
  format: 'bento/slides', version: 1, title: 'code', size: { width: 1280, height: 720 },
  theme: { background: '#fff', color: '#111', accent: '#f90', fontFamily: 'system-ui' },
  slides, ...extra,
})

console.log('the format, through the load gate')
{
  const scripts = {
    hop: { src: 'export default (p, b) => ({ y: b.y - 10 * p })' },
    'bad name': { src: 'x' },
    '../escape': { src: 'x' },
    big: { src: 'x'.repeat(LIMITS.scriptSrc + 1) },
    nosrc: { code: 'x' },
    ok_2: { src: 'export default () => ({})', extra: 1 },
  }
  const out = sanitizeScripts(scripts)!
  ok(JSON.stringify(Object.keys(out).sort()) === '["hop","ok_2"]', `good scripts kept, bad names / oversized / src-less dropped (${Object.keys(out)})`)
  ok(!('extra' in out.ok_2), 'a script entry carries only src')
  ok(sanitizeScripts('nope') === undefined && JSON.stringify(sanitizeScripts({ __proto__: { src: 'x' } } as unknown)) === '{}', 'a non-object, or a __proto__ key, yields nothing')
  const doc = baseDoc({ scripts: { pend: { src: CANVAS_TEMPLATE } } as BentoDoc['scripts'] }, [{
    id: 's1', background: '#fff', transition: 'none', notes: '', elements: [
      { id: 'cv', type: 'canvas', x: 10, y: 20, w: 300, h: 200, rotation: 0, opacity: 1, script: 'pend', params: { length: 1.2, bob: '#00ff00', on: true, junk: { a: 1 } }, posterAt: { click: 1, t: 0.5, z: 9 }, poster: 'asset:p1', fill: '#000000', onclick: 'alert(1)' },
    ],
  }])
  ;(doc as Record<string, unknown>).assets = { p1: 'data:image/png;base64,iVBORw0KGgo=' }
  const { doc: g } = sanitizeDoc(doc)
  const cv = g.slides[0].elements[0] as unknown as Record<string, unknown>
  ok(g.scripts?.pend?.src === CANVAS_TEMPLATE, 'doc.scripts survives the gate verbatim (it is data)')
  ok(cv?.type === 'canvas' && cv.script === 'pend' && cv.poster === 'asset:p1' && cv.fill === '#000000', 'a canvas element survives with its script name, poster and fill', cv)
  ok(JSON.stringify(cv.params) === '{"length":1.2,"bob":"#00ff00","on":true}', `params keep scalars only (${JSON.stringify(cv.params)})`)
  ok(JSON.stringify(cv.posterAt) === '{"click":1,"t":0.5}', `posterAt keeps click and t only (${JSON.stringify(cv.posterAt)})`)
  ok(!('onclick' in cv), 'an unknown key on a canvas is dropped')
  const pruned = pruneUnusedAssets(g)
  ok(pruned.assets?.p1 !== undefined, 'the poster asset survives save-time pruning')
  const round = expandDoc(compactDoc(g) as never) as BentoDoc
  ok(round.scripts?.pend?.src === CANVAS_TEMPLATE && round.slides[0].elements[0].type === 'canvas', 'the compact form round-trips scripts and a canvas')
  const schema = buildSchema('test') as unknown as Record<string, any>
  const dprops = schema.$defs?.doc?.properties ?? {}
  const canvasDef = schema.$defs?.canvas?.properties ?? {}
  ok(!!dprops.scripts && !!canvasDef.script && !!canvasDef.posterAt, 'the schema knows doc.scripts and the canvas element (script, posterAt)', Object.keys(canvasDef))
}

console.log('\nthe bake plan')
{
  const slide = {
    id: 'sA', background: '#fff', transition: 'none', notes: '',
    elements: [rect('a', 100, 300), rect('b', 600, 300)],
    anim: [
      { id: 'm', el: 'a', type: 'move', trigger: 'click', dx: 400, dy: 0, duration: 1, ease: 'linear' },
      { id: 's', el: 'a', type: 'script', trigger: 'with', script: 'hop', params: { amp: 50 }, duration: 1, ease: 'linear' },
      { id: 's2', el: 'a', type: 'script', trigger: 'after', script: 'hop', duration: 0.5 },
      { id: 'x', el: 'nope', type: 'script', trigger: 'with', script: 'hop', duration: 1 },
      { id: 'y', el: 'b', type: 'script', trigger: 'with', script: 'absent', duration: 1 },
    ],
  } as unknown as Slide
  const doc = { size: { width: 1280, height: 720 }, scripts: { hop: { src: 'export default (p, b, q) => ({ y: b.y - (q.amp ?? 20) * Math.sin(p * Math.PI) })' } } } as unknown as BentoDoc
  const jobs = bakeJobs(slide, doc, new Map())
  ok(jobs.length === 2 && jobs[0].track === trackKey('sA', { id: 's' }, 1) && jobs[1].track === trackKey('sA', { id: 's2' }, 2),
    `one job per runnable script effect, in list order (no job for a missing element or script) — ${jobs.map((j) => j.track.replace('\u001f', '/'))}`)
  const j = jobs[0]
  ok(j.samples.length === sampleCount(1) + 1 && sampleCount(1) === 120 && sampleCount(0.01) === 8 && sampleCount(1e6) === MAX_SAMPLES, `120 samples a second, at least 8, at most ${MAX_SAMPLES}`)
  const mid = j.samples[60]
  ok(near(mid.t, 0.5) && near(mid.p, 0.5) && near(mid.base.x, 300) && near(mid.base.y, 300), `base carries the move running alongside: at 0.5 s x = ${mid.base.x}`, mid)
  ok(j.click === 1 && j.duration === 1 && JSON.stringify(j.params) === '{"amp":50}' && j.seed === 's', 'the job carries click, duration, params, and the effect id as seed')
  // the key: an input change changes it, nothing else does
  const key = (mut: (s: Slide, d: BentoDoc) => void) => {
    const s2 = JSON.parse(JSON.stringify(slide)) as Slide
    const d2 = JSON.parse(JSON.stringify(doc)) as BentoDoc
    mut(s2, d2)
    return bakeJobs(s2, d2, new Map())[0]?.key
  }
  ok(key(() => {}) === j.key, 'an identical slide bakes to the same key (nothing is re-baked)')
  ok(key((s) => { (s.anim![1] as { params: object }).params = { amp: 60 } }) !== j.key, 'a parameter change changes the key')
  ok(key((_s, d) => { d.scripts!.hop.src += ' ' }) !== j.key, 'a source change changes the key')
  ok(key((s) => { s.anim![1].duration = 2 }) !== j.key, 'a duration change changes the key')
  ok(key((s) => { (s.anim![0] as { dx: number }).dx = 100 }) !== j.key, 'a change to an EARLIER effect (its base) changes the key')
  ok(key((s) => { s.elements[1].x = 50 }) === j.key, 'an unrelated element moving does not')

  // a fake bake: what the sandbox would return for `hop`, evaluated here
  const evalHop = (job: (typeof jobs)[number]) => ({
    key: job.key, duration: job.duration,
    frames: job.samples.map((s) => ({ y: s.base.y - ((job.params.amp as number) ?? 20) * Math.sin(s.p * Math.PI) })),
  })
  const tracks = new Map([[j.track, evalHop(j)]])
  // the second job's base must include the first's motion: re-plan with the track known
  const later = bakeJobs(slide, doc, tracks)[1]
  ok(near(later.samples[0].base.y, 300) && near(later.samples[0].base.x, 500), `a later script's base includes the earlier ones at their end (${later.samples[0].base.x}, ${later.samples[0].base.y})`)

  console.log('\nthe sampler')
  const sampler = trackSampler(tracks, 'sA')
  const st = stateAt(slide, 1, 0.5, { script: sampler }).get('a')!
  ok(near(st.dx, 200) && near(st.dy, -50, 1e-3), `stateAt layers them: dx from the move (${st.dx}), dy from the script (${st.dy.toFixed(3)})`)
  const st2 = stateAt(slide, 1, 0.25 + 1 / 240, { script: sampler }).get('a')!
  const want = -50 * Math.sin((0.25 + 1 / 240) * Math.PI)
  ok(Math.abs(st2.dy - want) < 0.02, `between two samples it interpolates (${st2.dy.toFixed(4)} ≈ ${want.toFixed(4)})`)
  const other = trackSampler(tracks, 'sB')
  ok(near(stateAt(slide, 1, 0.5, { script: other }).get('a')!.dy, 0), 'another slide with the same effect ids reads no track: files are per slide')
  ok(near(stateAt(slide, 1, 0.5).get('a')!.dy, 0), 'without a sampler (code off) a script effect plays as its base')
  const noId = { ...slide, anim: slide.anim!.map((fx, i) => (i === 1 ? { ...fx, id: undefined } : fx)) } as Slide
  ok(bakeJobs(noId, doc, new Map())[0].track === trackKey('sA', {}, 1) && trackKey('sA', {}, 1).endsWith('#1'), 'an effect without an id is named by its position')
  const plan = planAnim(slide.anim)
  ok(plan.clicks === 1, 'script effects take part in the plan like any effect')
}

console.log('\nvalidate()')
{
  const doc = baseDoc({ scripts: { hop: { src: EFFECT_TEMPLATE } } as BentoDoc['scripts'] }, [{
    id: 's1', background: '#fff', transition: 'none', notes: '',
    elements: [rect('a', 0, 0), { id: 'cv', type: 'canvas', x: 0, y: 0, w: 10, h: 10, rotation: 0, opacity: 1, script: 'gone' }],
    anim: [
      { id: 'e1', el: 'a', type: 'script', script: 'hop' },
      { id: 'e2', el: 'a', type: 'script', script: 'missing', trigger: 'with' },
      { id: 'e3', el: 'a', type: 'script', trigger: 'with' },
    ],
  }]) as unknown as BentoDoc
  const codes = validateDoc(doc, { measure: false }).findings.map((f: { code: string }) => f.code)
  ok(codes.filter((c: string) => c === 'anim-script-missing').length === 1, 'a script effect naming a missing script is reported once')
  ok(codes.includes('anim-script-unset'), 'a script effect naming no script is reported')
  ok(codes.includes('canvas-script-missing') && codes.includes('canvas-no-poster'), 'a canvas with a missing script, and without a still, are reported')
}

console.log('\ntemplates')
ok(freshScriptName({ wobble: 1, wobble2: 1 }, 'wobble') === 'wobble3' && freshScriptName(undefined, 'p') === 'p', 'fresh names never collide')
ok(/export const meta[\s\S]*kind: 'effect'/.test(EFFECT_TEMPLATE) && /export default function/.test(EFFECT_TEMPLATE), 'the effect template declares meta and a default export')
ok(/kind: 'canvas'/.test(CANVAS_TEMPLATE) && /export default function draw\(g, ctx\)/.test(CANVAS_TEMPLATE), 'the canvas template too')

console.log(`\n${FAILS.length ? `${FAILS.length} FAILED` : 'all checks passed'}`)
process.exit(FAILS.length ? 1 : 0)
