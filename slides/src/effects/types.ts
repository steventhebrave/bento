// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
/**
 * The effect registry's contract. One module per effect type (appear.ts,
 * spin.ts, …) exports an EffectDef; index.ts lists them. Adding a type is one
 * such module plus its panel entry (editor/animfields.ts) — the gate, the
 * schema, the engine and the pane all read the registry.
 *
 * DOM-free: the engine (animseq.ts) folds these over a slide's effect list to
 * answer "what does every element look like at click c, time t" as a pure
 * function, in node as well as in the browser.
 */

import type { AnimEffect, AnimKeyframe, Ease } from '../model'
import { easeFn } from '../../../kernel/src/ease.ts'

/**
 * What the sequence has done to one element so far, relative to its model
 * frame: an opacity factor, an offset, extra rotation, a scale, and (scripts
 * only) colour overrides. Identity is { o: 1, dx: 0, dy: 0, rot: 0, scale: 1 }.
 */
export interface ElState {
  o: number
  dx: number
  dy: number
  rot: number
  scale: number
  fill?: string
  color?: string
}

/** An element's absolute presentation frame: model frame + state. Slide px, degrees. */
export interface Frame {
  x: number
  y: number
  w: number
  h: number
  rotation: number
  opacity: number
  scale: number
  fill?: string
  color?: string
}

/** The element fields a frame is built from. */
export interface FrameSource {
  id: string
  x: number
  y: number
  w: number
  h: number
  rotation?: number
  opacity?: number
  fill?: string
  color?: string
}

/**
 * A script effect's motion, supplied by the host for ONE slide (code/host.ts
 * bakes it in a sandbox; `index` is the effect's position in that slide's
 * list, which names it when it has no id). Returns the frame the script produced, or null when the script
 * cannot run (code off, not baked yet, an error) — the effect then plays as
 * its base, i.e. as nothing.
 */
export type ScriptSampler = (fx: AnimEffect, base: Frame, p: number, t: number, index: number) => Partial<Frame> | null

export interface ApplyCtx {
  /** the target element's model fields */
  el: FrameSource
  /** seconds since the effect started, clamped to its duration */
  t: number
  /** the effect's duration in seconds */
  duration: number
  /** the effect's position in slide.anim */
  index: number
  script?: ScriptSampler
}

export type EffectKind = 'entrance' | 'exit' | 'emphasis' | 'motion' | 'script'

export interface EffectDef {
  type: string
  /** English UI label; translated at render time, never at module scope */
  label: string
  kind: EffectKind
  /** default seconds; 0 = instant (the effect has no duration at all) */
  duration: number
  instant?: boolean
  ease: Ease
  /** the type-specific keys this type owns (beyond the common ones) */
  owns: readonly string[]
  /**
   * Fold one effect into the state. `p` is the EASED progress (0..1, may
   * overshoot); called only once the effect has started. Must not mutate `s`.
   */
  apply(s: ElState, p: number, fx: AnimEffect, ctx: ApplyCtx): ElState
  /** short description for the pane row, e.g. "720°" or "→ 320, 0" */
  summary?(fx: AnimEffect): string
}

/** The keys every effect may carry, whatever its type. */
export const COMMON_KEYS = ['id', 'el', 'type', 'trigger', 'delay', 'duration', 'ease'] as const

export const IDENTITY: Readonly<ElState> = { o: 1, dx: 0, dy: 0, rot: 0, scale: 1 }

export const num = (v: unknown, dflt = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : dflt)

/**
 * Interpolate one keyframed value at progress p. Only keyframes that carry
 * `prop` take part; before the first one its value holds, after the last one
 * likewise. Each segment eases by the ARRIVING keyframe's `ease` (absent =
 * linear — the effect's own ease already shaped p).
 */
export function keyValue(keys: readonly AnimKeyframe[] | undefined, prop: keyof AnimKeyframe, p: number): number | undefined {
  if (!Array.isArray(keys)) return undefined
  const pts = keys
    .filter((k) => k && typeof k.at === 'number' && typeof k[prop] === 'number' && Number.isFinite(k[prop] as number))
    .sort((a, b) => a.at - b.at)
  if (!pts.length) return undefined
  if (p <= pts[0].at) return pts[0][prop] as number
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1]
    const b = pts[i]
    if (p <= b.at) {
      const span = b.at - a.at
      const f = span > 0 ? (p - a.at) / span : 1
      const e = easeFn(b.ease ?? 'linear', 'linear')(f)
      return (a[prop] as number) + ((b[prop] as number) - (a[prop] as number)) * e
    }
  }
  return pts[pts.length - 1][prop] as number
}

/** Does the effect carry keyframes for this value? */
export const keyed = (fx: AnimEffect, prop: keyof AnimKeyframe): boolean =>
  Array.isArray(fx.keys) && fx.keys.some((k) => k && typeof k[prop] === 'number')
