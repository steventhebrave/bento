// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
/** Appear: the element is simply there from this moment — an instant entrance. */
import type { EffectDef } from './types.ts'

export const appear: EffectDef = {
  type: 'appear',
  label: 'Appear',
  kind: 'entrance',
  duration: 0,
  instant: true,
  ease: 'linear',
  owns: [],
  apply: (s) => ({ ...s, o: 1 }),
}
