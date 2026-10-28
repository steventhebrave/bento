// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
/**
 * Spin: rotate by `deg` (signed; clockwise is positive; any size — 720 is two
 * turns) about the element's anchor — its centre unless it has one (FORK,
 * anchor.ts): the anchor stays put and the centre swings round it, so the
 * state gains an offset as well as an angle. The angle accumulates: a later
 * click starts from where this one left the element. `keys` with `deg` give
 * a keyframed angle relative to the start.
 */
import type { EffectDef } from './types.ts'
import { keyValue, num } from './types.ts'
import { anchorOf, pivotOffset } from '../anchor.ts'

export const spin: EffectDef = {
  type: 'spin',
  label: 'Spin',
  kind: 'emphasis',
  duration: 1,
  ease: 'power2.inOut',
  owns: ['deg', 'keys'],
  apply(s, p, fx, ctx) {
    const d = keyValue(fx.keys, 'deg', p) ?? num(fx.deg, 360) * p
    const off = pivotOffset(ctx.el.w, ctx.el.h, anchorOf(ctx.el), (ctx.el.rotation ?? 0) + s.rot, s.scale, d)
    return { ...s, rot: s.rot + d, dx: s.dx + off.x, dy: s.dy + off.y }
  },
  summary: (fx) => `${num(fx.deg, 360)}°`,
}
