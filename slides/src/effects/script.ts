// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
/**
 * Script: the motion is a JavaScript function from `doc.scripts[fx.script]`
 * (Tier 2 of the code layer). The UI owns WHEN (trigger, delay, duration,
 * ease); the script owns WHAT, as `(p, base, params, ctx) => partial frame`.
 *
 * The function never runs here. The host supplies `ctx.script`, which reads
 * frames the sandbox evaluated ahead of time (see code/). Without one — code
 * switched off, not evaluated yet, an error — the effect is its base: the
 * element does exactly what the UI-authored effects say, nothing more.
 */
import type { EffectDef, ElState, Frame, FrameSource } from './types.ts'

export function frameOfState(el: Omit<FrameSource, 'id'>, s: ElState): Frame {
  return {
    x: el.x + s.dx,
    y: el.y + s.dy,
    w: el.w,
    h: el.h,
    rotation: (el.rotation ?? 0) + s.rot,
    opacity: (el.opacity ?? 1) * s.o,
    scale: s.scale,
    ...(s.fill !== undefined ? { fill: s.fill } : el.fill !== undefined ? { fill: el.fill } : {}),
    ...(s.color !== undefined ? { color: s.color } : el.color !== undefined ? { color: el.color } : {}),
  }
}

const fin = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

export const script: EffectDef = {
  type: 'script',
  label: 'Script',
  kind: 'script',
  duration: 1,
  ease: 'linear',
  owns: ['script', 'params'],
  apply(s, p, fx, ctx) {
    if (!ctx.script) return s
    const base = frameOfState(ctx.el, s)
    const out = ctx.script(fx, base, p, ctx.t, ctx.index)
    if (!out) return s
    const next = { ...s }
    const baseOpacity = ctx.el.opacity ?? 1
    if (fin(out.x)) next.dx = out.x - ctx.el.x
    if (fin(out.y)) next.dy = out.y - ctx.el.y
    if (fin(out.rotation)) next.rot = out.rotation - (ctx.el.rotation ?? 0)
    if (fin(out.scale)) next.scale = out.scale
    if (fin(out.opacity)) next.o = baseOpacity > 0 ? Math.max(0, out.opacity) / baseOpacity : 0
    if (typeof out.fill === 'string') next.fill = out.fill
    if (typeof out.color === 'string') next.color = out.color
    return next
  },
  summary: (fx) => (typeof fx.script === 'string' ? `ƒ ${fx.script}` : 'ƒ'),
}
