#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// The animation sequence engine (slides/src/animseq.ts + effects/), in node.
//
//   node scripts/test-slides-animseq.ts
//
// WHAT THIS PROVES. The state of every element at (click, time) is a pure
// function of the slide's effect list, with PowerPoint's timing:
//   - click/with/after anchors and delays; the arrival group; click count
//   - entrance-first elements start hidden; others start visible
//   - effects accumulate (moves chain, spins add up) and compose when
//     concurrent (a spin WITH a move does both)
//   - continuity: the end of click c is the start of click c+1, so stepping
//     forward never jumps; and computing click c after any other click gives
//     the same answer as computing it fresh (← is exact)
//   - keyframes, fly-in offsets, unknown types (keep their click slot, do
//     nothing), dangling targets, the script hook
//   - morph frames: a legacy slide's are exactly its model frames
//   - the computation never mutates the slide

import { planAnim, stateAt, frameAt, morphFrames, wrapTurns, usesAnim, groupDuration, clicksByElement, entrancesStarted } from '../slides/src/animseq.ts'
import type { AnimEffect, Slide } from '../slides/src/model.ts'

const FAILS: string[] = []
const check = (name: string, cond: boolean, detail?: unknown) => {
  if (!cond) FAILS.push(name)
  console.log(`${cond ? '  ok  ' : ' FAIL '} ${name}${!cond && detail !== undefined ? '  → ' + JSON.stringify(detail) : ''}`)
}
const near = (a: number, b: number, eps = 1e-9) => Math.abs(a - b) <= eps

const box = (id: string, extra: Record<string, unknown> = {}) =>
  ({ id, type: 'shape', shape: 'rect', fill: '#f00', x: 100, y: 200, w: 50, h: 40, rotation: 0, opacity: 1, ...extra })
const slideOf = (anim: Partial<AnimEffect>[], elements = [box('a'), box('b'), box('c')]): Slide =>
  ({ id: 's', background: '#fff', transition: 'none', notes: '', elements, anim: anim as AnimEffect[] }) as unknown as Slide

// --- timing -----------------------------------------------------------------
{
  const s = slideOf([
    { id: '1', el: 'a', type: 'fade-in', trigger: 'with', duration: 0.5 },          // group 0, on arrival
    { id: '2', el: 'b', type: 'move', dx: 100, duration: 1, delay: 1 },             // click 1, starts at 1
    { id: '3', el: 'c', type: 'spin', trigger: 'with', duration: 2 },               // with #2 → anchor 0, start 0
    { id: '4', el: 'a', type: 'move', trigger: 'after', dy: 10, duration: 0.5 },    // after #3 → start 2
    { id: '5', el: 'b', type: 'fade-out', trigger: 'with', delay: 0.25 },           // with #4 → anchor 2 → start 2.25
    { id: '6', el: 'c', type: 'appear' },                                           // click 2, instant
  ])
  const p = planAnim(s.anim)
  const at = (id: string) => p.effects.find((e) => e.fx.id === id)!
  check('two clicks (two click-triggered effects)', p.clicks === 2, p.clicks)
  check('a leading with-effect forms the arrival group 0', at('1').group === 0 && at('2').group === 1 && at('6').group === 2)
  check('click effect: start = its delay', at('2').start === 1 && at('2').end === 2)
  check('with: shares the previous anchor (its trigger point, not its delayed start)', at('3').start === 0 && at('3').end === 2)
  check('after: starts when the previous ends', at('4').start === 2 && at('4').end === 2.5)
  check('with after an after: same anchor + own delay', at('5').start === 2.25 && near(at('5').end, 2.75))
  check('instant types have no duration, whatever the field says', at('6').duration === 0)
  check('group durations', p.groups[0] === 0.5 && p.groups[1] === 2.75 && p.groups[2] === 0, p.groups)
  check('groupDuration clamps the click', groupDuration(p, 99) === 0 && groupDuration(p, -3) === 0.5)
  check('usesAnim: present (even empty) vs absent', usesAnim(s) && usesAnim({ anim: [] }) && !usesAnim({}) && !usesAnim(undefined))
  const badges = clicksByElement(p)
  check('clicksByElement lists each click an element animates on', JSON.stringify(badges.get('b')) === '[1]' && JSON.stringify(badges.get('c')) === '[1,2]' && JSON.stringify(badges.get('a')) === '[0,1]')
}

// --- visibility and accumulation --------------------------------------------
{
  const s = slideOf([
    { id: 'f', el: 'a', type: 'fade-in', duration: 1, ease: 'linear' },
    { id: 'm1', el: 'b', type: 'move', dx: 100, dy: 0, duration: 1, ease: 'linear' },
    { id: 'm2', el: 'b', type: 'move', dx: 0, dy: 50, duration: 1, ease: 'linear' },
    { id: 'r1', el: 'c', type: 'spin', deg: 720, duration: 2, ease: 'linear' },
    { id: 'r2', el: 'c', type: 'spin', deg: -90, duration: 1, ease: 'linear' },
    { id: 'o', el: 'a', type: 'fade-out', duration: 1, ease: 'linear' },
  ])
  const st = (c: number, t: number) => stateAt(s, c, t)
  check('entrance-first element starts hidden', st(0, 0).get('a')!.o === 0)
  check('non-entrance-first elements start visible', st(0, 0).get('b')!.o === 1 && st(0, 0).get('c')!.o === 1)
  check('fade-in halfway is half opaque', near(st(1, 0.5).get('a')!.o, 0.5))
  check('fade-in done', st(1, Infinity).get('a')!.o === 1)
  check('first move halfway', near(st(2, 0.5).get('b')!.dx, 50))
  check('moves chain: second move starts where the first ended', st(3, 0).get('b')!.dx === 100 && near(st(3, 0.5).get('b')!.dy, 25) && st(3, Infinity).get('b')!.dy === 50)
  check('spin of any size: two turns', st(4, Infinity).get('c')!.rot === 720)
  check('spins accumulate, either direction', st(5, Infinity).get('c')!.rot === 630)
  check('fade-out from the current opacity', near(st(6, 0.25).get('a')!.o, 0.75) && st(6, Infinity).get('a')!.o === 0)
  check('later clicks keep earlier results (b still moved at the last click)', st(6, Infinity).get('b')!.dx === 100 && st(6, Infinity).get('b')!.dy === 50)
  check('an untargeted element is absent from the state', !st(0, 0).has('zzz'))

  // continuity: end of click c == start of click c+1 (no instant effects here)
  let continuous = true
  for (let c = 0; c < 6; c++) {
    const a = st(c, Infinity)
    const b = st(c + 1, 0)
    for (const [id, x] of a) {
      const y = b.get(id)!
      if (!near(x.o, y.o) || !near(x.dx, y.dx) || !near(x.dy, y.dy) || !near(x.rot, y.rot)) continuous = false
    }
  }
  check('continuity: the end of every click is the start of the next', continuous)

  // purity: any order of evaluation gives the same answers (← is exact)
  const fresh = JSON.stringify([...st(3, 0.4)])
  st(6, Infinity); st(1, 0.2); st(0, 0)
  check('pure: click 3 at 0.4s is the same after visiting other clicks', JSON.stringify([...st(3, 0.4)]) === fresh)
  const before = JSON.stringify(s)
  frameAt(s, 6, Infinity); morphFrames(s, 2, 0.3)
  check('the slide is never mutated', JSON.stringify(s) === before)
}

// --- concurrent effects compose ------------------------------------------------
{
  const s = slideOf([
    { id: 'm', el: 'a', type: 'move', dx: 200, duration: 2, ease: 'linear' },
    { id: 'r', el: 'a', type: 'spin', trigger: 'with', deg: 180, duration: 2, ease: 'linear' },
  ])
  const x = stateAt(s, 1, 1).get('a')!
  check('a spin WITH a move does both', near(x.dx, 100) && near(x.rot, 90))
  const f = frameAt(s, 1, Infinity).get('a')!
  check('frame = model + state', f.x === 300 && f.y === 200 && f.rotation === 180 && f.opacity === 1 && f.scale === 1)
}

// --- eases, keyframes, fly-in, unknown types, dangling ---------------------------
{
  const s = slideOf([
    { id: 'e', el: 'a', type: 'move', dx: 100, duration: 1, ease: [0.42, 0, 1, 1] },
    { id: 'k', el: 'b', type: 'move', duration: 1, ease: 'linear', keys: [{ at: 0, dx: 0 }, { at: 0.5, dx: 80 }, { at: 1, dx: 20 }] },
    { id: 'fly', el: 'c', type: 'fade-in', fromDx: 120, duration: 1, ease: 'linear' },
    { id: 'u', el: 'a', type: 'wobble-from-the-future', duration: 1 },
    { id: 'd', el: 'gone', type: 'spin', trigger: 'with' },
    { id: 'blink', el: 'b', type: 'fade-out', duration: 1, ease: 'linear', keys: [{ at: 0, opacity: 1 }, { at: 0.5, opacity: 0 }, { at: 1, opacity: 1 }] },
  ])
  const ein = stateAt(s, 1, 0.5).get('a')!.dx
  check(`a bezier ease shapes progress (ease-in at 50% < 50: ${ein.toFixed(2)})`, ein > 20 && ein < 40)
  check('keyframed move goes through its keys', near(stateAt(s, 2, 0.5).get('b')!.dx, 80) && near(stateAt(s, 2, 1).get('b')!.dx, 20) && near(stateAt(s, 2, 0.25).get('b')!.dx, 40))
  check('fly-in starts away and lands home', near(stateAt(s, 3, 0).get('c')!.dx, 120) && stateAt(s, 3, Infinity).get('c')!.dx === 0)
  const p = planAnim(s.anim)
  check('an unknown type keeps its click slot', p.clicks === 5 && p.effects.find((e) => e.fx.id === 'u')!.group === 4)
  check('an unknown type does nothing', JSON.stringify(stateAt(s, 4, Infinity).get('a')) === JSON.stringify(stateAt(s, 3, Infinity).get('a')))
  check('a dangling target is skipped quietly', !stateAt(s, 5, Infinity).has('gone'))
  check('keyframed fade blinks', near(stateAt(s, 5, 0.5).get('b')!.o, 0) && near(stateAt(s, 5, 1).get('b')!.o, 1))
}

// --- script hook ------------------------------------------------------------------
{
  const s = slideOf([
    { id: 'm', el: 'a', type: 'move', dx: 100, duration: 1, ease: 'linear' },
    { id: 'w', el: 'a', type: 'script', trigger: 'with', script: 'wobble', duration: 1, ease: 'linear', params: { amp: 10 } },
  ])
  const seen: number[] = []
  const script = (fx: AnimEffect, base: { x: number }, p: number, t: number) => {
    seen.push(base.x)
    return { x: base.x + Number(fx.params?.amp) * Math.sin(Math.PI * p), y: 999 }
  }
  const x = stateAt(s, 1, 0.5, { script: script as never }).get('a')!
  check('script modifies the base the UI effects produced', near(x.dx, 50 + 10) && near(seen[0], 150))
  check('script output for an undeclared key is still applied by the engine (drives filtering is the host’s job)', x.dy === 799)
  check('no sampler: a script effect is its base', near(stateAt(s, 1, 0.5).get('a')!.dx, 50) && stateAt(s, 1, 0.5).get('a')!.dy === 0)
}

// --- morph frames -------------------------------------------------------------------
{
  const legacy = { id: 'L', background: '#fff', transition: 'none', notes: '', elements: [box('a', { fx: { step: 2 }, morphId: 'm-a' }), box('b', { rotation: 30, opacity: 0.5 })] } as unknown as Slide
  const mf = morphFrames(legacy, 5, Infinity)
  check('legacy slide: morph frames are exactly the model frames (keyed by morph key)', mf.get('m-a')!.x === 100 && mf.get('b')!.rotation === 30 && mf.get('b')!.opacity === 0.5 && mf.get('m-a')!.opacity === 1)
  const s = slideOf([
    { id: 'r', el: 'a', type: 'spin', deg: 720, duration: 1 },
    { id: 'o', el: 'b', type: 'fade-out', trigger: 'with' },
  ])
  const end = morphFrames(s, 1, Infinity)
  check('anim slide: morph from-frames are the end-of-slide state', frameAt(s, 1, Infinity).get('a')!.rotation === 720 && end.get('b')!.opacity === 0 && end.get('c')!.opacity === 1)
  check('anim slide: a spin’s whole turns are dropped for the morph (720 → 0)', end.get('a')!.rotation === 0)
  check('wrapTurns keeps the orientation, drops the turns', wrapTurns(720) === 0 && wrapTurns(350) === -10 && wrapTurns(-450) === -90 && wrapTurns(90) === 90 && wrapTurns(NaN) === 0)
  const tilted = slideOf([{ id: 'r', el: 'a', type: 'spin', deg: 360, duration: 1 }], [box('a', { rotation: 350 }), box('b'), box('c')])
  check('the model rotation is never wrapped (350 + a full turn morphs from 350)', morphFrames(tilted, 1, Infinity).get('a')!.rotation === 350)
}

// --- entrances started (count-up / typewriter hooks) ----------------------------------
{
  const s = slideOf([
    { id: 'f1', el: 'a', type: 'fade-in', duration: 1 },
    { id: 'f2', el: 'b', type: 'appear', trigger: 'after' },
  ])
  const p = planAnim(s.anim)
  check('entrancesStarted reports entrances by time', entrancesStarted(p, 1, 0.5).map((e) => e.fx.id).join() === 'f1' && entrancesStarted(p, 1, 1).map((e) => e.fx.id).join() === 'f1,f2')
}

if (FAILS.length) {
  console.log(`\n${FAILS.length} check(s) FAILED`)
  process.exit(1)
}
console.log('\nall animseq checks passed')
