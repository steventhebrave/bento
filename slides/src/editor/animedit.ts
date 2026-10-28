// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
/**
 * The animation pane's edits, as plain functions over a slide — DOM-free so
 * scripts/test-slides-anim-pane.ts drives them in node. animpane.ts is the DOM.
 *
 * TWO RULES every edit here keeps:
 *
 *  1. The first edit on a legacy slide CONVERTS it (ensureAnim): the implicit
 *     list the pane was showing becomes the slide's explicit `anim`, so the
 *     edit lands on exactly the rows the author saw. One undo step, because it
 *     happens inside the same commit as the edit.
 *  2. Edits MERGE into an effect, they never rebuild it. A key the panel does
 *     not know (keyframes, a newer version's field, something an agent wrote)
 *     survives every timing change. Only an explicit type change drops the old
 *     type's own keys, and only those.
 */

import type { AnimEffect, Ease, Slide } from '../model'
import { uid } from '../model.ts'
import { legacyAnim } from '../animlegacy.ts'
import { planAnim, type AnimPlan } from '../animseq.ts'
import { effectDef, COMMON_KEYS } from '../effects/index.ts'

/** The list the pane shows: the slide's own, or the legacy fields read as one. */
export const paneList = (slide: Slide): { list: AnimEffect[]; implicit: boolean } =>
  Array.isArray(slide.anim) ? { list: slide.anim, implicit: false } : { list: legacyAnim(slide), implicit: true }

/** Make the slide's list explicit (converting legacy fields). Returns it. */
export function ensureAnim(slide: Slide): AnimEffect[] {
  if (!Array.isArray(slide.anim)) slide.anim = legacyAnim(slide)
  return slide.anim
}

/** The type-specific fields a new effect of `type` starts with. */
export function defaultsFor(type: string): Partial<AnimEffect> {
  if (type === 'spin') return { deg: 360 }
  if (type === 'move') return { dx: 200, dy: 0 }
  return {}
}

/**
 * Add one effect of `type` per element, appended in the given order: the first
 * on a click, the rest with it — "these animate together on the next click".
 * Returns the new effect ids.
 */
export function addEffects(slide: Slide, elIds: readonly string[], type: string, idOf: () => string = () => uid('fx')): string[] {
  const list = ensureAnim(slide)
  const ids: string[] = []
  elIds.forEach((el, i) => {
    const fx: AnimEffect = { id: idOf(), el, type, ...(i ? { trigger: 'with' as const } : {}), ...defaultsFor(type) }
    list.push(fx)
    ids.push(fx.id)
  })
  return ids
}

export function removeEffects(slide: Slide, ids: ReadonlySet<string>) {
  const list = ensureAnim(slide)
  slide.anim = list.filter((fx) => !ids.has(fx.id))
}

/** Move the effects `ids` (kept in their relative order) to sit before index `to` of the current list. */
export function moveEffects(slide: Slide, ids: readonly string[], to: number) {
  const list = ensureAnim(slide)
  const moving = list.filter((fx) => ids.includes(fx.id))
  if (!moving.length) return
  const before = list.slice(0, Math.max(0, Math.min(list.length, to))).filter((fx) => !ids.includes(fx.id))
  const after = list.slice(Math.max(0, Math.min(list.length, to))).filter((fx) => !ids.includes(fx.id))
  slide.anim = [...before, ...moving, ...after]
}

export interface TimingPatch {
  trigger?: AnimEffect['trigger']
  delay?: number
  duration?: number
  ease?: Ease | null
}

/** Set timing on several effects at once (multi-select). `ease: null` clears to the type's default. */
export function setTiming(slide: Slide, ids: ReadonlySet<string>, patch: TimingPatch) {
  for (const fx of ensureAnim(slide)) {
    if (!ids.has(fx.id)) continue
    if (patch.trigger !== undefined) {
      if (patch.trigger === 'click') delete fx.trigger
      else fx.trigger = patch.trigger
    }
    if (patch.delay !== undefined) {
      const d = clampSecs(patch.delay)
      if (d) fx.delay = d
      else delete fx.delay
    }
    if (patch.duration !== undefined && !effectDef(fx.type)?.instant) fx.duration = Math.max(0.01, clampSecs(patch.duration))
    if (patch.ease !== undefined) {
      if (patch.ease === null) delete fx.ease
      else fx.ease = patch.ease
    }
  }
}

/** Merge type fields into one effect (a spin's degrees, a move's offset). */
export function setFields(slide: Slide, id: string, fields: Partial<AnimEffect>) {
  const fx = ensureAnim(slide).find((f) => f.id === id)
  if (!fx) return
  for (const [k, v] of Object.entries(fields)) {
    if (k === 'id' || k === 'el') continue
    if (v === undefined || v === null || v === '') delete (fx as unknown as Record<string, unknown>)[k]
    else (fx as unknown as Record<string, unknown>)[k] = v
  }
}

/**
 * Change an effect's type. Timing (trigger, delay, duration, ease) and any key
 * no type owns are kept; the OLD type's own keys go (a move's offset means
 * nothing to a spin), and the new type's defaults come in. An instant type
 * drops the duration it cannot use.
 */
export function changeType(slide: Slide, id: string, type: string) {
  const fx = ensureAnim(slide).find((f) => f.id === id)
  const next = effectDef(type)
  if (!fx || !next || fx.type === type) return
  const old = effectDef(fx.type)
  const rec = fx as unknown as Record<string, unknown>
  for (const k of old?.owns ?? []) if (!next.owns.includes(k)) delete rec[k]
  fx.type = type
  if (next.instant) delete fx.duration
  for (const [k, v] of Object.entries(defaultsFor(type))) if (rec[k] === undefined) rec[k] = v
}

/** Drop effects whose element is no longer on the slide (after a delete). */
export function dropDangling(slide: Slide): boolean {
  if (!Array.isArray(slide.anim)) return false
  const ids = new Set(slide.elements.map((e) => e.id))
  const kept = slide.anim.filter((fx) => ids.has(fx.el))
  if (kept.length === slide.anim.length) return false
  slide.anim = kept
  return true
}

/**
 * A row the panel cannot fully represent: keys no type owns, keyframes, an
 * unknown type, or a value of the wrong shape. The pane shows it as "custom"
 * and still edits its timing; the JSON box edits the rest.
 */
export function isCustom(fx: AnimEffect): boolean {
  const def = effectDef(fx.type)
  if (!def) return true
  const known = new Set<string>([...COMMON_KEYS, ...def.owns])
  for (const k of Object.keys(fx)) if (!known.has(k)) return true
  if (Array.isArray(fx.keys) && fx.keys.length) return true
  return false
}

/**
 * "Reset to UI-editable": keep exactly what the panel can show — the common
 * timing keys and the type's own fields, minus keyframes. Everything else goes.
 * The pane asks first; this just does it.
 */
export function resetToEditable(slide: Slide, id: string) {
  const fx = ensureAnim(slide).find((f) => f.id === id)
  const def = fx && effectDef(fx.type)
  if (!fx || !def) return
  const keep = new Set<string>([...COMMON_KEYS, ...def.owns.filter((k) => k !== 'keys')])
  for (const k of Object.keys(fx)) if (!keep.has(k)) delete (fx as unknown as Record<string, unknown>)[k]
  for (const [k, v] of Object.entries(defaultsFor(fx.type))) {
    if ((fx as unknown as Record<string, unknown>)[k] === undefined) (fx as unknown as Record<string, unknown>)[k] = v
  }
}

/** Replace one effect wholesale (the JSON box), keeping its id and its place in the list. */
export function replaceEffect(slide: Slide, id: string, next: AnimEffect) {
  const list = ensureAnim(slide)
  const i = list.findIndex((f) => f.id === id)
  if (i < 0) return
  list[i] = { ...next, id }
}

/** Seconds, rounded to the pane's 0.01 resolution and bounded. */
export const clampSecs = (v: number): number =>
  Number.isFinite(v) ? Math.min(3600, Math.max(0, Math.round(v * 100) / 100)) : 0

// --- the preview timeline ---------------------------------------------------------

/** Gap between click groups when previewing the whole slide, standing in for the click. */
export const CLICK_GAP = 0.4

/** The whole slide laid end to end: where each click starts, and the total. */
export function slideTimeline(plan: AnimPlan): { starts: number[]; total: number } {
  const starts: number[] = []
  let t = 0
  plan.groups.forEach((d, i) => {
    if (i > 0) t += CLICK_GAP
    starts.push(t)
    t += d
  })
  return { starts, total: t }
}

/** A point on that timeline as (click, time into the click). */
export function locate(plan: AnimPlan, T: number): { click: number; t: number } {
  const { starts } = slideTimeline(plan)
  let click = 0
  for (let i = 0; i < starts.length; i++) if (T >= starts[i]) click = i
  return { click, t: Math.max(0, Math.min(T - starts[click], plan.groups[click] ?? 0)) }
}

export const planOf = (slide: Slide): AnimPlan => planAnim(paneList(slide).list)
