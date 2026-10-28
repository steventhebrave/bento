// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
/** Fade out: from whatever opacity the element has to 0. `keys` with `opacity` replace the ramp. */
import type { EffectDef } from './types.ts'
import { keyValue } from './types.ts'

export const fadeOut: EffectDef = {
  type: 'fade-out',
  label: 'Fade out',
  kind: 'exit',
  duration: 0.5,
  ease: 'power1.in',
  owns: ['keys'],
  apply(s, p, fx) {
    const k = keyValue(fx.keys, 'opacity', p)
    return { ...s, o: k ?? s.o * (1 - p) }
  },
}
