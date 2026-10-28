// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
/**
 * Move in a straight line by (`dx`, `dy`) slide px, relative to wherever the
 * element is when the effect starts — so moves chain. `keys` with dx/dy give
 * a keyframed offset (a curve through points) relative to the start.
 */
import type { EffectDef } from './types.ts'
import { keyValue, num } from './types.ts'

export const move: EffectDef = {
  type: 'move',
  label: 'Move',
  kind: 'motion',
  duration: 1,
  ease: 'power2.inOut',
  owns: ['dx', 'dy', 'keys'],
  apply(s, p, fx) {
    const kx = keyValue(fx.keys, 'dx', p)
    const ky = keyValue(fx.keys, 'dy', p)
    return { ...s, dx: s.dx + (kx ?? num(fx.dx) * p), dy: s.dy + (ky ?? num(fx.dy) * p) }
  },
  summary: (fx) => `${Math.round(num(fx.dx))}, ${Math.round(num(fx.dy))}`,
}
