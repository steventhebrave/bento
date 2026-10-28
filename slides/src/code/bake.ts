// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
/**
 * Script effects, evaluated AHEAD of time (Tier 2 of the code layer).
 *
 * A script effect's motion is `(p, base, params, ctx) => partial frame`, and it
 * never runs in the page. The host asks the sandbox to evaluate it at fixed
 * samples across the effect (BAKE), and the sequence engine reads the frames
 * back through a ScriptSampler, interpolating between samples. That is what
 * keeps the host's clock in charge: scrubbing, ←, reduced motion, previews and
 * the morph's end state all read frames that already exist, at any time, in any
 * order, synchronously.
 *
 * This module is the DOM-free half: which samples, which `base` at each, and
 * the sampler over baked tracks. `base` is the element's frame at that instant
 * from every effect BEFORE the script in the list — including earlier scripts,
 * which is why a slide's scripts are baked in list order.
 */

import type { AnimEffect, BentoDoc, Slide } from '../model'
import { planAnim, stateAt, type AnimPlan, type Planned } from '../animseq.ts'
import { frameOfState, type Frame, type ScriptSampler } from '../effects/index.ts'
import { anchorOf } from '../anchor.ts'

/** Samples per second of effect; the cap keeps a 20 s effect affordable. */
export const SAMPLE_RATE = 120
export const MAX_SAMPLES = 2400

export const sampleCount = (duration: number): number =>
  Math.max(8, Math.min(MAX_SAMPLES, Math.ceil(duration * SAMPLE_RATE)))

export interface Sample { t: number; p: number; base: Frame }

/**
 * What a baked track is filed under: the slide and the effect. Effect ids
 * repeat across slides (duplicating a slide copies its list, the morph idiom),
 * so the slide is part of the name; an effect without an id is named by its
 * position in the list.
 */
export const trackKey = (slideId: string, fx: Pick<AnimEffect, 'id'>, index: number): string =>
  `${slideId}\u001f${typeof fx.id === 'string' && fx.id ? fx.id : `#${index}`}`

type BakeSlide = Pick<Slide, 'id' | 'anim' | 'elements'>

export interface BakeJob {
  /** trackKey(slide, effect) */
  track: string
  /** the script's name in doc.scripts, and its source */
  name: string
  src: string
  params: Record<string, number | string | boolean>
  duration: number
  click: number
  /** the element's size, and its anchor (fractions of the box; [0.5, 0.5] = centre) */
  el: { w: number; h: number; anchor: [number, number] }
  slide: { w: number; h: number }
  /** seed for ctx.random / ctx.noise: the effect's id, so a deck replays identically */
  seed: string
  samples: Sample[]
  /** identifies every input — an unchanged job is never re-baked */
  key: string
}

/** One baked track: the partial frames the script returned at each sample. */
export interface Track { key: string; duration: number; frames: Array<Partial<Frame>> }

const FNV = (s: string): string => {
  let h = 2166136261 >>> 0
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0 }
  return h.toString(36)
}

/**
 * The bake jobs for one slide, in list order. `tracks` holds what is already
 * baked: an earlier script's motion is part of a later script's base, so the
 * caller bakes in order and passes the growing map back in.
 */
export function bakeJobs(slide: BakeSlide, doc: Pick<BentoDoc, 'scripts' | 'size'>, tracks: ReadonlyMap<string, Track>, plan: AnimPlan = planAnim(slide.anim)): BakeJob[] {
  const jobs: BakeJob[] = []
  const sampler = trackSampler(tracks, slide.id)
  for (const pe of plan.effects) {
    if (pe.fx.type !== 'script') continue
    const job = bakeJob(slide, doc, plan, pe, sampler)
    if (job) jobs.push(job)
  }
  return jobs
}

/** The job for one script effect, or null when it cannot run (no script, no element, no time). */
export function bakeJob(slide: BakeSlide, doc: Pick<BentoDoc, 'scripts' | 'size'>, plan: AnimPlan, pe: Planned, sampler?: ScriptSampler): BakeJob | null {
  const fx: AnimEffect = pe.fx
  const name = typeof fx.script === 'string' ? fx.script : ''
  const src = name ? doc.scripts?.[name]?.src : undefined
  const el = slide.elements.find((e) => e.id === fx.el)
  if (!src || !el || !(pe.duration > 0)) return null
  const n = sampleCount(pe.duration)
  const samples: Sample[] = []
  for (let k = 0; k <= n; k++) {
    const t = (k / n) * pe.duration
    const s = stateAt(slide, pe.group, pe.start + t, { plan, beforeIndex: pe.index, script: sampler }).get(el.id)
    if (!s) return null
    samples.push({ t, p: pe.ease(k / n), base: frameOfState(el, s) })
  }
  const params = { ...(fx.params ?? {}) }
  const anchor = anchorOf(el)
  const head = JSON.stringify([name, FNV(src), src.length, params, pe.duration, pe.group, el.w, el.h, anchor, doc.size?.width, doc.size?.height, fx.id])
  const key = FNV(head + JSON.stringify(samples.map((x) => [x.p, x.base])))
  return {
    track: trackKey(slide.id, fx, pe.index), name, src, params, duration: pe.duration, click: pe.group,
    el: { w: el.w, h: el.h, anchor: [anchor[0], anchor[1]] }, slide: { w: doc.size?.width ?? 1280, h: doc.size?.height ?? 720 },
    seed: fx.id ?? String(pe.index), samples, key,
  }
}

const lerpNum = (a: unknown, b: unknown, f: number): unknown =>
  typeof a === 'number' && typeof b === 'number' ? a + (b - a) * f : f < 0.5 ? a : b

/**
 * Read baked tracks as the engine's ScriptSampler: the frame at time `t` into
 * the effect, interpolated between the two nearest samples (numbers linearly,
 * colours by the nearer sample — at 120 samples a second no eye can tell).
 * An effect with no track yet: null, so it plays as its base until its bake
 * lands (the host re-bakes whenever an input changes — the job key says when).
 */
export function trackSampler(tracks: ReadonlyMap<string, Track>, slideId: string): ScriptSampler {
  return (fx, _base, _p, t, index) => {
    const tr = tracks.get(trackKey(slideId, fx, index))
    if (!tr || !tr.frames.length) return null
    const n = tr.frames.length - 1
    const x = tr.duration > 0 ? Math.min(1, Math.max(0, t / tr.duration)) * n : n
    const i = Math.min(n - 1, Math.floor(x))
    if (n === 0) return tr.frames[0]
    const f = x - i
    const a = tr.frames[i]
    const b = tr.frames[i + 1]
    const out: Record<string, unknown> = {}
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
      const v = lerpNum((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], f)
      if (v !== undefined) out[k] = v
    }
    return out as Partial<Frame>
  }
}
