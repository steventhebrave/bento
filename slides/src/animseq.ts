// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
/**
 * The animation sequence engine: what every element of a slide looks like at
 * click `c`, time `t` — as a PURE function of the slide's effect list
 * (`slide.anim`, see model.ts AnimEffect). Never of the DOM.
 *
 * That one property is what everything else leans on: ← restores a click
 * exactly (it recomputes, nothing is undone), reduced motion jumps to the end
 * of a click, the morph into the next slide starts from the end of this one
 * (present.ts reads `morphFrames`), the editor previews and scrubs through the
 * same function, and the code layer's script effects slot into the same fold.
 *
 * THE FOLD. Each effect type is `apply(stateBefore, easedProgress) → state`
 * (effects/). For a given (c, t): effects of earlier clicks are applied at
 * their end, effects of click c at time t, effects not yet started (and later
 * clicks) are skipped — identity. Concurrent effects on one element compose
 * because each modifies the state the previous ones left, and everything
 * accumulates: a moved element stays moved for every later click.
 *
 * TIMING (PowerPoint's): each `click` effect opens a click group; effects
 * before the first one form group 0, which plays on arrival. `with` starts on
 * the previous effect's anchor (its trigger point, not its delayed start),
 * `after` when the previous effect ends, and `delay` is added to the anchor.
 * "Previous" means the previous effect in the same group.
 *
 * Legacy slides (no `anim`) never come through here for playback — present.ts
 * keeps their own runtime, untouched — but `morphFrames` answers for them too,
 * with their model frames, so the morph has one code path.
 *
 * DOM-free: scripts/test-slides-animseq.ts drives it in node.
 */

import type { AnimEffect, Slide } from './model'
import { effectDef, frameOfState, IDENTITY, type EffectDef, type ElState, type Frame, type ScriptSampler } from './effects/index.ts'
import { easeFn, type EaseFn } from '../../kernel/src/ease.ts'

/** Does this slide play through the new sequence (rather than legacy fx.step)? */
export const usesAnim = (slide: { anim?: unknown } | undefined | null): boolean => Array.isArray(slide?.anim)

export interface Planned {
  fx: AnimEffect
  /** undefined for a type this build does not know: it keeps its slot and timing, and plays as nothing */
  def: EffectDef | undefined
  /** position in slide.anim */
  index: number
  /** 0 = on arrival, n = the n-th click */
  group: number
  /** seconds from the group's start */
  anchor: number
  start: number
  duration: number
  end: number
  ease: EaseFn
}

export interface AnimPlan {
  effects: Planned[]
  /** each group's duration in seconds; [0] is the arrival group */
  groups: number[]
  /** the number of clicks the slide takes before → leaves it */
  clicks: number
  /** elements whose first effect is an entrance: hidden until it plays */
  startsHidden: Set<string>
  /** every element id an effect targets */
  targets: Set<string>
}

/** Seconds, bounded. A negative, NaN or absurd value is the default. */
const MAX_SECONDS = 3600
const secs = (v: unknown, dflt: number) =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.min(v, MAX_SECONDS) : dflt

export const triggerOf = (fx: Pick<AnimEffect, 'trigger'>): 'click' | 'with' | 'after' =>
  fx.trigger === 'with' || fx.trigger === 'after' ? fx.trigger : 'click'

/** Lay out the effect list on the timeline: groups, start and end times. */
export function planAnim(list: readonly AnimEffect[] | undefined | null): AnimPlan {
  const effects: Planned[] = []
  const groups: number[] = [0]
  const startsHidden = new Set<string>()
  const targets = new Set<string>()
  const firstSeen = new Set<string>()
  let group = 0
  let prev: Planned | null = null
  ;(Array.isArray(list) ? list : []).forEach((fx, index) => {
    if (!fx || typeof fx !== 'object') return
    const def = effectDef(fx.type)
    const trigger = triggerOf(fx)
    if (trigger === 'click') {
      group++
      groups.push(0)
      prev = null
    }
    const duration = def?.instant ? 0 : secs(fx.duration, def?.duration ?? 0.5)
    const anchor = !prev ? 0 : trigger === 'with' ? prev.anchor : prev.end
    const start = anchor + secs(fx.delay, 0)
    const end = start + duration
    const planned: Planned = {
      fx, def, index, group, anchor, start, duration, end,
      ease: easeFn(fx.ease ?? def?.ease, 'linear'),
    }
    effects.push(planned)
    groups[group] = Math.max(groups[group], end)
    prev = planned
    if (typeof fx.el === 'string' && fx.el) {
      targets.add(fx.el)
      if (def && !firstSeen.has(fx.el)) {
        firstSeen.add(fx.el)
        if (def.kind === 'entrance') startsHidden.add(fx.el)
      }
    }
  })
  return { effects, groups, clicks: group, startsHidden, targets }
}

export interface SeqOpts {
  /** a plan already computed for this slide's list (the player keeps one) */
  plan?: AnimPlan
  /** script effects' motion; absent = scripts play as their base */
  script?: ScriptSampler
  /** fold only effects BEFORE this list index — a script effect's `base` */
  beforeIndex?: number
}

type ElLike = Slide['elements'][number]

/** Clamp a click number to the slide's range. */
export const clampClick = (plan: AnimPlan, click: number): number =>
  Math.max(0, Math.min(plan.clicks, Math.floor(Number.isFinite(click) ? click : 0)))

/** The duration of click group `click` (0 = the arrival group). */
export const groupDuration = (plan: AnimPlan, click: number): number => plan.groups[clampClick(plan, click)] ?? 0

/**
 * The sequence's state for every TARGETED element at (click, t). Elements no
 * effect touches are absent — they sit at their model frame.
 * `t` is seconds into the click's group; Infinity means its end.
 */
export function stateAt(slide: Pick<Slide, 'anim' | 'elements'>, click: number, t: number, opts: SeqOpts = {}): Map<string, ElState> {
  const plan = opts.plan ?? planAnim(slide.anim)
  const byId = new Map<string, ElLike>()
  for (const el of slide.elements ?? []) byId.set(el.id, el)
  const out = new Map<string, ElState>()
  for (const id of plan.targets) {
    if (byId.has(id)) out.set(id, plan.startsHidden.has(id) ? { ...IDENTITY, o: 0 } : { ...IDENTITY })
  }
  const c = clampClick(plan, click)
  for (const pe of plan.effects) {
    if (pe.group > c) break // groups only grow along the list
    if (opts.beforeIndex !== undefined && pe.index >= opts.beforeIndex) break
    if (!pe.def) continue
    const el = byId.get(pe.fx.el)
    if (!el) continue
    const local = pe.group < c ? Infinity : t
    if (!(local >= pe.start)) continue // not started: identity (NaN lands here too)
    const elapsed = Math.min(pe.duration, Math.max(0, local - pe.start))
    const raw = pe.duration > 0 ? elapsed / pe.duration : 1
    const s = out.get(el.id)!
    out.set(el.id, pe.def.apply(s, pe.ease(raw), pe.fx, {
      el,
      t: elapsed,
      duration: pe.duration,
      index: pe.index,
      script: opts.script,
    }))
  }
  return out
}

/** Model frame of an element, as a Frame. */
export const modelFrame = (el: ElLike): Frame => frameOfState(el, IDENTITY)

/** Every element's frame at (click, t), keyed by element id. */
export function frameAt(slide: Pick<Slide, 'anim' | 'elements'>, click: number, t: number, opts: SeqOpts = {}): Map<string, Frame> {
  const states = stateAt(slide, click, t, opts)
  const out = new Map<string, Frame>()
  for (const el of slide.elements ?? []) {
    const s = states.get(el.id)
    out.set(el.id, s ? frameOfState(el, s) : modelFrame(el))
  }
  return out
}

/**
 * The frames a MORPH reads, keyed by morph key (`morphId || id`, what
 * `data-flip-id` carries). For a slide using the sequence, the state at
 * (click, t); for a legacy slide, exactly its model frames — the morph's
 * behaviour on every existing deck is unchanged by construction.
 */
export function morphFrames(slide: Pick<Slide, 'anim' | 'elements'>, click: number, t: number, opts: SeqOpts = {}): Map<string, Frame> {
  const out = new Map<string, Frame>()
  if (!usesAnim(slide)) {
    for (const el of slide.elements ?? []) out.set(el.morphId || el.id, modelFrame(el))
    return out
  }
  const states = stateAt(slide, click, t, opts)
  for (const el of slide.elements ?? []) {
    const s = states.get(el.id)
    out.set(el.morphId || el.id, s ? frameOfState(el, { ...s, rot: wrapTurns(s.rot) }) : modelFrame(el))
  }
  return out
}

/**
 * Drop the whole turns a spin added. A gear left at 720° looks exactly like
 * one at 0°; morphing it into the next slide must not unwind two turns, so the
 * morph sees the spin's angle reduced to −180..180. Only the SEQUENCE's
 * rotation is wrapped — an element's own model rotation morphs exactly as it
 * always has (350° → 10° still turns the long way, as it did before).
 */
export function wrapTurns(rot: number): number {
  if (!Number.isFinite(rot)) return 0
  return rot - 360 * Math.round(rot / 360)
}

/** The click numbers on which each element has an effect (for canvas badges). */
export function clicksByElement(plan: AnimPlan): Map<string, number[]> {
  const out = new Map<string, number[]>()
  for (const pe of plan.effects) {
    if (typeof pe.fx.el !== 'string') continue
    const list = out.get(pe.fx.el) ?? []
    if (!list.includes(pe.group)) list.push(pe.group)
    out.set(pe.fx.el, list)
  }
  return out
}

/** Effects in group `click` of kind 'entrance' that have started by `t`. */
export function entrancesStarted(plan: AnimPlan, click: number, t: number): Planned[] {
  return plan.effects.filter((pe) => pe.group === click && pe.def?.kind === 'entrance' && t >= pe.start)
}
