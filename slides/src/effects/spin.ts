// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
/**
 * Spin: rotate about the element's centre by `deg` (signed; clockwise is
 * positive; any size — 720 is two turns). The angle accumulates: a later
 * click starts from where this one left the element. `keys` with `deg` give
 * a keyframed angle relative to the start.
 */
import type { EffectDef } from './types.ts'
import { keyValue, num } from './types.ts'

export const spin: EffectDef = {
  type: 'spin',
  label: 'Spin',
  kind: 'emphasis',
  duration: 1,
  ease: 'power2.inOut',
  owns: ['deg', 'keys'],
  apply(s, p, fx) {
    const d = keyValue(fx.keys, 'deg', p) ?? num(fx.deg, 360) * p
    return { ...s, rot: s.rot + d }
  },
  summary: (fx) => `${num(fx.deg, 360)}°`,
}
