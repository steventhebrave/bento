// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
/**
 * Fade in: opacity 0 → 1 over the effect. Optional `fromDx/fromDy` start the
 * element that far away and bring it home while it fades — a fly-in, and the
 * shape every legacy `fx.enter` kind converts to exactly (fade-up = fromDy 16,
 * slide-left = fromDx 120, …). `keys` with `opacity` replace the straight ramp.
 */
import type { EffectDef } from './types.ts'
import { keyValue, num } from './types.ts'

export const fadeIn: EffectDef = {
  type: 'fade-in',
  label: 'Fade in',
  kind: 'entrance',
  duration: 0.5,
  ease: 'power1.out',
  owns: ['fromDx', 'fromDy', 'keys'],
  apply(s, p, fx) {
    const o = keyValue(fx.keys, 'opacity', p) ?? p
    const back = 1 - p
    return { ...s, o, dx: s.dx + num(fx.fromDx) * back, dy: s.dy + num(fx.fromDy) * back }
  },
  summary: (fx) => (fx.fromDx || fx.fromDy ? `from ${num(fx.fromDx)}, ${num(fx.fromDy)}` : ''),
}
