// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
/** Disappear: the element is gone from this moment — an instant exit. */
import type { EffectDef } from './types.ts'

export const disappear: EffectDef = {
  type: 'disappear',
  label: 'Disappear',
  kind: 'exit',
  duration: 0,
  instant: true,
  ease: 'linear',
  owns: [],
  apply: (s) => ({ ...s, o: 0 }),
}
