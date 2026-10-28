#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// A legacy slide's fx.enter / fx.step read as an animation sequence
// (slides/src/animlegacy.ts) — the implicit list the pane shows, and what its
// first edit converts to.
//
//   node scripts/test-slides-anim-legacy.ts
//
// WHAT THIS PROVES. The conversion reproduces the legacy runtime's timing
// number for number (present.ts runEnterFx + enterSpec): arrival entrances on
// `with` at 0.12 + min(order ?? i, 24) × 0.05 with each kind's offset, duration
// and ease; each reveal step a click whose first element is `click` and the rest
// `with` at min(order ?? i, 24) × 0.05, a plain fade when there is no kind;
// motion-path and hover-revealed elements that the legacy runtime shows without
// an entrance become `appear`; step gaps collapse; ids are deterministic; and
// the sequence engine then hides/reveals exactly what fx.step did.

import { legacyAnim, hasLegacyAnim, enterAsFadeIn } from '../slides/src/animlegacy.ts'
import { planAnim, stateAt } from '../slides/src/animseq.ts'
import type { Slide } from '../slides/src/model.ts'

const FAILS: string[] = []
const ok = (cond: boolean, name: string, detail?: unknown) => {
  if (!cond) FAILS.push(name)
  console.log(`${cond ? '  ok  ' : ' FAIL '} ${name}${!cond && detail !== undefined ? '  → ' + JSON.stringify(detail) : ''}`)
}
const el = (id: string, fx?: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  ({ id, type: 'shape', shape: 'rect', fill: '#000', x: 0, y: 0, w: 10, h: 10, rotation: 0, opacity: 1, ...(fx ? { fx } : {}), ...extra })
const slide = (elements: unknown[]): Slide => ({ id: 'S', background: '#fff', transition: 'none', notes: '', elements } as unknown as Slide)

// --- enterSpec parity ---------------------------------------------------------
ok(JSON.stringify(enterAsFadeIn('fade-up')) === JSON.stringify({ fromDy: 16, duration: 0.55, ease: 'power2.out' }), 'fade-up = 16px rise, 0.55s, power2.out')
ok(JSON.stringify(enterAsFadeIn('slide-left')) === JSON.stringify({ fromDx: 120, duration: 0.75, ease: 'power3.out' }), 'slide-left starts 120px to the right, 0.75s, power3.out')
ok(JSON.stringify(enterAsFadeIn('slide-down', 2)) === JSON.stringify({ fromDy: -120, duration: 2, ease: 'power3.out' }), 'enterDur wins')
ok(JSON.stringify(enterAsFadeIn('fade')) === JSON.stringify({ duration: 0.55, ease: 'power2.out' }), 'fade has no offset')

// --- arrival -------------------------------------------------------------------
{
  const s = slide([
    el('plain'),
    el('a', { enter: 'fade-up' }),
    el('cnt', { countUp: true }),                 // occupies a stagger slot, enters nothing
    el('b', { enter: 'slide-left', order: 3 }),
    el('c', { enter: 'fade', order: 3 }),         // equal order: together
    el('loop', { enter: 'fade', loop: { type: 'motion-path', path: 'M0,0 L10,0', duration: 2 } }),
    el('hover', { enter: 'fade' }, { showOnHover: 'g' }),
  ])
  const list = legacyAnim(s)
  const by = (id: string) => list.find((f) => f.el === id)
  ok(hasLegacyAnim(s), 'hasLegacyAnim sees the entrances')
  ok(list.every((f) => f.trigger === 'with'), 'arrival entrances all play on arrival (with)')
  ok(by('a')!.delay === 0.12 && by('a')!.fromDy === 16, 'first in order: 0.12s lead, fade-up offset', by('a'))
  ok(by('b')!.delay === 0.27 && by('c')!.delay === 0.27, 'equal order → the same delay (0.12 + 3×0.05)', [by('b'), by('c')])
  ok(!by('cnt') && !by('loop') && !by('hover'), 'count-up-only, motion-path and hover elements get no entrance')
  ok(!by('plain'), 'an element with no fx is not in the list')
  ok(list.map((f) => f.id).join() === 'S-legacy-1,S-legacy-2,S-legacy-3', 'ids are deterministic')
  const p = planAnim(list)
  ok(p.clicks === 0 && Math.abs(p.groups[0] - (0.27 + 0.75)) < 1e-9, 'no clicks; the arrival group lasts as long as the slowest entrance')
}

// --- steps -----------------------------------------------------------------------
{
  const s = slide([
    el('title'),
    el('s1a', { step: 1 }),                                   // no kind → plain fade
    el('s1b', { step: 1, enter: 'slide-up', order: 2 }),
    el('s5', { step: 5, enter: 'fade-down' }),                // a gap: 1, 5
    el('s5loop', { step: 5, loop: { type: 'motion-path', path: 'M0,0 L1,1', duration: 1 } }),
    el('s5hover', { step: 5 }, { showOnHover: 'x' }),
  ])
  const list = legacyAnim(s)
  const p = planAnim(list)
  ok(p.clicks === 2, 'steps 1 and 5 are two clicks (the gap collapses)', p.clicks)
  const g1 = p.effects.filter((e) => e.group === 1).map((e) => e.fx)
  ok(g1[0].el === 's1a' && g1[0].trigger === 'click' && g1[0].type === 'fade-in' && !g1[0].delay && g1[0].duration === 0.55,
    'first of step 1: on click, a plain fade, no lead', g1[0])
  ok(g1[1].el === 's1b' && g1[1].trigger === 'with' && g1[1].delay === 0.1 && g1[1].fromDy === 120, 'second of step 1: with, delayed by its order (2×0.05)', g1[1])
  const g2 = p.effects.filter((e) => e.group === 2).map((e) => e.fx)
  ok(g2.map((f) => `${f.el}:${f.type}:${f.trigger}`).join() === 's5:fade-in:click,s5loop:appear:with,s5hover:appear:with', 'step 5: fade, then motion-path and hover elements simply appear', g2)
  // and the engine hides/reveals exactly what fx.step did
  const vis = (c: number) => [...stateAt({ ...s, anim: list }, c, Infinity)].filter(([, st]) => st.o > 0).map(([id]) => id).sort().join()
  ok(vis(0) === '', 'click 0: every stepped element hidden (title is untouched, so not in the state)')
  ok(vis(1) === 's1a,s1b', 'click 1: step 1 shown')
  ok(vis(2) === 's1a,s1b,s5,s5hover,s5loop', 'click 2: all shown')
}

if (FAILS.length) {
  console.log(`\n${FAILS.length} check(s) FAILED`)
  process.exit(1)
}
console.log('\nall legacy-conversion checks passed')
