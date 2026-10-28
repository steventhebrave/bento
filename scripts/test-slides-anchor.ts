#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// An element's anchor (FORK): the geometry, the spin, the format.
//
//   node scripts/test-slides-anchor.ts
//
// WHAT THIS PROVES.
//   1. anchor.ts — anchorPoint / boxForAnchor / anchorAt agree with each other
//      at any rotation, and pivotOffset keeps the anchor's point fixed
//   2. a spin turns about the anchor: after 90° about the top-left corner the
//      box has swung round that corner (and the corner has not moved); spins
//      chain about the anchor as it is carried along; 360° comes home; no
//      anchor (or the centre) is exactly the old centre spin
//   3. the morph reads those frames (the swung box, not the model)
//   4. the gate keeps a good anchor and drops a bad one; the schema knows it
//   5. an element with no `rotation` (compact decks leave it out) is unturned,
//      not NaN — the crosshair once landed on the slide's corner for these

import { register } from 'node:module'
import type { Slide } from '../slides/src/model.ts'
register('./lib/ts-resolve-hooks.mjs', import.meta.url)
const { anchorOf, anchorPoint, anchorAt, boxForAnchor, hasAnchor, pivotOffset } = await import('../slides/src/anchor.ts')
const { stateAt, frameAt, morphFrames } = await import('../slides/src/animseq.ts')
const { sanitizeSlide } = await import('../slides/src/untrusted.ts')
const { buildSchema } = await import('../slides/src/schema.ts')

const FAILS: string[] = []
const ok = (cond: boolean, name: string, detail?: unknown) => {
  if (!cond) FAILS.push(name)
  console.log(`${cond ? '  ok  ' : ' FAIL '} ${name}${!cond && detail !== undefined ? '  → ' + JSON.stringify(detail) : ''}`)
}
const near = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) <= eps

console.log('the geometry')
{
  const box = { x: 100, y: 200, w: 300, h: 100 }
  let worst = 0
  for (const rot of [0, 30, 90, 137, -45, 270]) {
    for (const a of [[0, 0], [1, 1], [0.25, 0.8], [0.5, -1.5]] as Array<[number, number]>) {
      const p = anchorPoint(box, rot, a)
      const b = boxForAnchor(p, box.w, box.h, rot, a)
      const back = anchorAt(box, rot, p)
      worst = Math.max(worst, Math.abs(b.x - box.x), Math.abs(b.y - box.y), Math.abs(back[0] - a[0]), Math.abs(back[1] - a[1]))
    }
  }
  ok(worst < 1e-9, `anchorPoint, boxForAnchor and anchorAt invert each other at any rotation (worst ${worst.toExponential(1)})`)
  ok(near(anchorPoint(box, 0, [0.5, 0.5]).x, 250) && near(anchorPoint(box, 90, [0.5, 0.5]).y, 250), 'the centre is the centre at any rotation')
  const tl = anchorPoint(box, 0, [0, 0])
  ok(near(tl.x, 100) && near(tl.y, 200), 'anchor [0, 0] is the top-left corner')
  // turning about the anchor: rotate the box about its centre by d and move it by pivotOffset — the anchor stays
  const a: [number, number] = [0.1, 0.9]
  const before = anchorPoint(box, 20, a)
  const off = pivotOffset(box.w, box.h, a, 20, 1, 75)
  const after = anchorPoint({ ...box, x: box.x + off.x, y: box.y + off.y }, 95, a)
  ok(near(after.x, before.x, 1e-9) && near(after.y, before.y, 1e-9), 'pivotOffset keeps the anchor\'s point fixed through a turn')
  // a file may leave `rotation` out (compact decks do; the renderer reads it as 0)
  const none = anchorPoint(box, undefined, [0, 0])
  const noneBox = boxForAnchor({ x: 100, y: 200 }, box.w, box.h, undefined, [0, 0])
  const noneAt = anchorAt(box, undefined, { x: 100, y: 200 })
  const noneOff = pivotOffset(box.w, box.h, [0, 0], undefined, 1, 90)
  ok(near(none.x, 100) && near(none.y, 200) && near(noneBox.x, 100) && near(noneBox.y, 200) && near(noneAt[0], 0) && near(noneAt[1], 0) && Number.isFinite(noneOff.x) && Number.isFinite(noneOff.y),
    'no rotation in the file is no turn, never NaN', { none, noneBox, noneAt, noneOff })
  ok(!hasAnchor({}) && !hasAnchor({ anchor: [0.5, 0.5] }) && hasAnchor({ anchor: [0, 0] }) && JSON.stringify(anchorOf({ anchor: [NaN, 1] })) === '[0.5,0.5]', 'hasAnchor / anchorOf: absent, centre and junk all mean the centre')
}

console.log('\nspin about the anchor')
{
  const el = (anchor?: [number, number]) => ({ id: 'g', type: 'shape', shape: 'rect', x: 500, y: 300, w: 100, h: 100, rotation: 0, opacity: 1, fill: '#000', ...(anchor ? { anchor } : {}) })
  const slide = (anchor?: [number, number], deg = 90, extra: object[] = []) => ({
    id: 's', background: '#fff', transition: 'none', notes: '', elements: [el(anchor)],
    anim: [{ id: 'sp', el: 'g', type: 'spin', deg, duration: 1, ease: 'linear' }, ...extra],
  }) as unknown as Slide
  // 90° clockwise about the top-left corner (500, 300): the centre (550, 350) swings to (450, 350)
  let f = frameAt(slide([0, 0]), 1, Infinity).get('g')!
  ok(near(f.x, 400) && near(f.y, 300) && near(f.rotation, 90), `90° about the top-left corner: the box swings round it (x ${f.x}, y ${f.y}, ${f.rotation}°)`)
  const corner = anchorPoint(f, f.rotation, [0, 0])
  ok(near(corner.x, 500) && near(corner.y, 300), 'and that corner has not moved')
  f = frameAt(slide([0, 0]), 1, 0.5).get('g')!
  const mid = anchorPoint(f, f.rotation, [0, 0])
  ok(near(mid.x, 500) && near(mid.y, 300) && near(f.rotation, 45), 'mid-spin too: the anchor holds at every instant')
  f = frameAt(slide([0, 0], 360), 1, Infinity).get('g')!
  ok(near(f.x, 500, 1e-9) && near(f.y, 300, 1e-9), 'a whole turn comes home')
  // two spins chain: the second turns about the anchor wherever the first left it
  const two = slide([1, 0.5], 90, [{ id: 'sp2', el: 'g', type: 'spin', deg: 90, trigger: 'after', duration: 1, ease: 'linear' }])
  const g = frameAt(two, 1, Infinity).get('g')!
  const pin = anchorPoint(g, g.rotation, [1, 0.5])
  ok(near(pin.x, 600) && near(pin.y, 350) && near(g.rotation, 180) && near(g.x, 600) && near(g.y, 300), `two spins chain about the same fixed anchor (box at ${g.x}, ${g.y}, ${g.rotation}°)`)
  // no anchor / the centre: exactly the centre spin it always was
  const plain = stateAt(slide(), 1, 0.3).get('g')!
  const centred = stateAt(slide([0.5, 0.5]), 1, 0.3).get('g')!
  ok(plain.dx === 0 && plain.dy === 0 && centred.dx === 0 && centred.dy === 0 && near(plain.rot, 27), 'no anchor, or the centre: a spin adds rotation and nothing else (as before)')
  // the morph reads the swung frame
  const m = morphFrames(slide([0, 0]), 1, Infinity).get('g')!
  ok(near(m.x, 400) && near(m.y, 300), 'the morph out of the slide starts from the swung box')
}

console.log('\nthe format')
{
  const base = { id: 's', background: '#fff', transition: 'none', notes: '' }
  const r = (anchor: unknown) => (sanitizeSlide({ ...base, elements: [{ id: 'e', type: 'shape', shape: 'rect', x: 0, y: 0, w: 10, h: 10, rotation: 0, opacity: 1, fill: '#000', stroke: 'none', strokeWidth: 0, radius: 0, anchor }] }) as Slide).elements[0]
  ok(JSON.stringify(r([0.25, 1.5]).anchor) === '[0.25,1.5]', 'the gate keeps a good anchor')
  ok(!('anchor' in r([0.2])) && !('anchor' in r(['a', 1])) && !('anchor' in r([0, 99])) && !('anchor' in r('0 0')), 'and drops a malformed or out-of-range one (the element stays)')
  const schema = buildSchema('t') as unknown as { $defs: Record<string, { properties?: Record<string, unknown> }> }
  ok(!!schema.$defs.shape?.properties?.anchor && !!schema.$defs.text?.properties?.anchor, 'every element type\'s schema has anchor')
}

console.log(`\n${FAILS.length ? `${FAILS.length} FAILED` : 'all checks passed'}`)
process.exit(FAILS.length ? 1 : 0)
