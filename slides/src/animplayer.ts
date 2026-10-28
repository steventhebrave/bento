// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
/**
 * The DOM around the animation sequence (animseq.ts decides; this paints).
 *
 * One AnimPlayer per present session, bound to the slide on screen when that
 * slide carries an `anim` list. It holds a position — (click, t) — and every
 * paint is `stateAt(slide, click, t)` written to the nodes: nothing is
 * remembered in the DOM, so ← (a recompute at the previous click's end),
 * reduced motion (a recompute at the end), and a killed tween (a recompute
 * at wherever the clock stopped) are all exact by construction.
 *
 * The clock is the anim engine's — a plain-object tween on `p` — so the
 * manual clock drives it in tests, a hidden tab stalls it like every other
 * tween, and the wall-clock settle below lands it anyway.
 *
 * Geometry goes through ONE transform builder (`frameTransform`), shared with
 * the morph in present.ts: the frame a morph ends on and the frame the
 * sequence starts from are the same string, so the hand-over cannot jump.
 */

import { anim, resetXform, type Tween } from './anim'
import type { Slide, SlideElement } from './model'
import { applyElementFrame } from './render'
import { clampClick, entrancesStarted, groupDuration, planAnim, stateAt, type AnimPlan } from './animseq'
import { frameOfState, type Frame, type ScriptSampler } from './effects/index.ts'

/**
 * The CSS transform, with `transform-origin: 0 0`, that takes a node laid out
 * at its model box `L` to the frame `F`: translate the box, stretch it to F's
 * size (morphs interpolate size), then rotate and scale about its own centre.
 * At rest (F == L, scale 1) it is exactly `rotate(L.rotation)` about the
 * centre — what applyElementFrame writes with the default origin.
 */
export function frameTransform(L: { x: number; y: number; w: number; h: number }, F: Frame): string {
  const sx = F.w / Math.max(L.w, 0.01)
  const sy = F.h / Math.max(L.h, 0.01)
  const cx = L.w / 2
  const cy = L.h / 2
  let out = `translate(${F.x - L.x}px, ${F.y - L.y}px) scale(${sx}, ${sy})`
  if (F.rotation || F.scale !== 1) {
    out += ` translate(${cx}px, ${cy}px)`
    if (F.rotation) out += ` rotate(${F.rotation}deg)`
    if (F.scale !== 1) out += ` scale(${F.scale})`
    out += ` translate(${-cx}px, ${-cy}px)`
  }
  return out
}

/** Elements whose transform belongs to an ambient effect: the sequence paints only their opacity. */
export const ownsTransform = (el: SlideElement): boolean =>
  el.fx?.loop?.type === 'motion-path' || el.fx?.ambient === 'kenburns'

/** Write one element's frame. */
export function paintFrame(node: HTMLElement, el: SlideElement, F: Frame) {
  if (!ownsTransform(el)) {
    node.style.transformOrigin = '0 0'
    node.style.transform = frameTransform(el, F)
    resetXform(node)
  }
  node.style.opacity = String(Math.max(0, F.opacity))
  // a hidden element is not clickable (a link on it must not fire) and costs nothing to paint
  node.style.visibility = F.opacity <= 0 ? 'hidden' : ''
  paintColors(node, el, F)
}

/** A shape's painted part: lines paint with stroke, everything else with fill. */
const paintTarget = (node: HTMLElement): { target: SVGElement; attr: 'fill' | 'stroke' } | null => {
  const target = node.querySelector<SVGElement>('rect,ellipse,polygon,line,path')
  return target ? { target, attr: target.tagName === 'line' ? 'stroke' : 'fill' } : null
}

/**
 * Colours only a script effect changes (the UI-authored effects never do): a
 * shape's fill, a text's colour. Written only while the frame differs from the
 * model, and put back exactly — the renderer's own paint (a gradient, a theme
 * colour) is remembered on the node and restored, never re-derived.
 */
function paintColors(node: HTMLElement, el: SlideElement, F: Frame) {
  if (el.type === 'shape') {
    const want = typeof F.fill === 'string' && F.fill !== el.fill && /^(#[0-9a-fA-F]{3,8}|rgba?\([\d\s.,%/]+\)|hsla?\([\d\s.,%/deg]+\)|[a-z]{3,20})$/.test(F.fill) ? F.fill : null
    const pt = (want || node.dataset.animFill !== undefined) ? paintTarget(node) : null
    if (!pt) return
    if (want) {
      if (node.dataset.animFill === undefined) node.dataset.animFill = pt.target.getAttribute(pt.attr) ?? ''
      pt.target.setAttribute(pt.attr, want)
    } else {
      const was = node.dataset.animFill!
      if (was) pt.target.setAttribute(pt.attr, was)
      else pt.target.removeAttribute(pt.attr)
      delete node.dataset.animFill
    }
  } else if (el.type === 'text') {
    const want = typeof F.color === 'string' && F.color !== el.color ? F.color : null
    if (want) {
      if (node.dataset.animColor === undefined) node.dataset.animColor = node.style.color
      node.style.color = want
    } else if (node.dataset.animColor !== undefined) {
      node.style.color = node.dataset.animColor
      delete node.dataset.animColor
    }
  }
}

/** Put a node back exactly as the renderer left it. */
export function restNode(node: HTMLElement, el: SlideElement) {
  paintColors(node, el, { x: 0, y: 0, w: 0, h: 0, rotation: 0, opacity: 1, scale: 1 })
  applyElementFrame(node, el)
  node.style.transformOrigin = ''
  node.style.visibility = ''
  resetXform(node)
}

const nodesOf = (section: HTMLElement): Map<string, HTMLElement> => {
  const map = new Map<string, HTMLElement>()
  section.querySelectorAll<HTMLElement>('[data-el-id]').forEach((n) => map.set(n.dataset.elId!, n))
  return map
}

/** Paint a slide's sequence state at (click, t) once, without a player. */
export function paintAt(section: HTMLElement, slide: Slide, click: number, t: number, opts: { plan?: AnimPlan; script?: ScriptSampler; skip?: ReadonlySet<string> } = {}) {
  const nodes = nodesOf(section)
  const byId = new Map(slide.elements.map((el) => [el.id, el]))
  for (const [id, s] of stateAt(slide, click, t, opts)) {
    if (opts.skip?.has(id)) continue
    const node = nodes.get(id)
    const el = byId.get(id)
    if (node && el) paintFrame(node, el, frameOfState(el, s))
  }
}

/** Reset every element the sequence targets to its model frame (before a visit repaints it). */
export function restTargets(section: HTMLElement, slide: Slide) {
  const plan = planAnim(slide.anim)
  const nodes = nodesOf(section)
  for (const el of slide.elements) {
    if (!plan.targets.has(el.id)) continue
    const node = nodes.get(el.id)
    if (node) restNode(node, el)
  }
}

export interface PlayerHost {
  reduceMotion(): boolean
  /** entrance effects that just started while playing forward (count-up / typewriter hooks) */
  onEntrances?(ids: string[]): void
  /** one slide's script-effect motion (the code layer); absent = scripts play as their base */
  scriptFor?(slide: Slide): ScriptSampler | undefined
}

/** How long past a group's end the wall clock waits before landing it anyway. */
const SETTLE_GRACE = 1.5

export class AnimPlayer {
  slide: Slide | null = null
  plan: AnimPlan | null = null
  section: HTMLElement | null = null
  click = 0
  t = 0
  private tween: Tween | null = null
  private token = 0
  private nodes = new Map<string, HTMLElement>()
  private fired = new Set<string>()
  private held = new Set<string>()
  private settleTimer: ReturnType<typeof setTimeout> | undefined

  constructor(private host: PlayerHost) {}

  get bound(): boolean { return !!this.slide }
  get clicks(): number { return this.plan?.clicks ?? 0 }
  hasNext(): boolean { return !!this.plan && this.click < this.plan.clicks }
  hasPrev(): boolean { return !!this.plan && this.click > 0 }
  /** Where the sequence is right now — what a morph out of this slide starts from. */
  position(): { click: number; t: number } { return { click: this.click, t: this.t } }

  /**
   * Bind to the slide that just became current and paint (click, start or
   * end). `hold` names elements another animation (the morph) owns for now:
   * they are not painted until the clock next moves.
   */
  enter(section: HTMLElement, slide: Slide, click: number, atEnd: boolean, hold?: ReadonlySet<string>) {
    this.stop()
    this.section = section
    this.slide = slide
    this.plan = planAnim(slide.anim)
    this.nodes = nodesOf(section)
    this.click = clampClick(this.plan, click)
    this.t = atEnd ? groupDuration(this.plan, this.click) : 0
    this.held = new Set(hold ?? [])
    this.paint()
  }

  /** Unbind; the nodes keep whatever they show (the outgoing slide keeps its exit state). */
  stop() {
    this.token++
    this.tween?.kill()
    this.tween = null
    clearTimeout(this.settleTimer)
    this.held.clear()
    this.fired.clear()
    this.slide = null
    this.plan = null
    this.section = null
  }

  /** Play the current click's group from its start, after `delay` seconds. */
  play(delay = 0) {
    if (!this.plan) return
    const D = groupDuration(this.plan, this.click)
    const token = ++this.token
    this.tween?.kill()
    this.tween = null
    this.fired.clear()
    this.t = 0
    if (this.host.reduceMotion()) {
      this.held.clear()
      this.t = D
      this.paint()
      return
    }
    const state = { p: 0 }
    this.tween = anim.to(state, {
      p: 1,
      duration: Math.max(D, 0.0001),
      delay,
      ease: 'none',
      onUpdate: () => {
        if (token !== this.token) return
        this.held.clear()
        this.t = state.p * D
        this.paint()
        this.fireEntrances()
      },
      onComplete: () => {
        if (token !== this.token) return
        this.tween = null
        this.t = D
        this.paint()
      },
    })
    // Starved render loops (a hidden tab, a weak machine) crawl; the group
    // still lands on its end state. Stands down on the manual clock, where the
    // test owns time.
    clearTimeout(this.settleTimer)
    if (!anim.isManual) {
      this.settleTimer = setTimeout(() => {
        if (token === this.token && this.tween) this.settle()
      }, (delay + D + SETTLE_GRACE) * 1000)
    }
  }

  /** → inside the slide: finish this click and play the next. False = leave the slide. */
  next(): boolean {
    if (!this.hasNext()) return false
    this.click++
    this.play(0)
    return true
  }

  /** ← inside the slide: the previous click's end state, exactly. False = leave the slide. */
  prev(): boolean {
    if (!this.hasPrev()) return false
    this.halt()
    this.click--
    this.t = groupDuration(this.plan!, this.click)
    this.paint()
    return true
  }

  /** Jump to a click (an audience following the presenter): its end state. */
  seek(click: number) {
    if (!this.plan) return
    this.halt()
    this.click = clampClick(this.plan, click)
    this.t = groupDuration(this.plan, this.click)
    this.paint()
  }

  /** Land the running group on its end now. */
  settle() {
    if (!this.plan) return
    this.halt()
    this.t = groupDuration(this.plan, this.click)
    this.paint()
  }

  /** Repaint the current position (after something else touched the nodes). */
  paint() {
    if (!this.slide || !this.plan) return
    const byId = new Map(this.slide.elements.map((el) => [el.id, el]))
    for (const [id, s] of stateAt(this.slide, this.click, this.t, { plan: this.plan, script: this.host.scriptFor?.(this.slide) })) {
      if (this.held.has(id)) continue
      const node = this.nodes.get(id)
      const el = byId.get(id)
      if (node && el) paintFrame(node, el, frameOfState(el, s))
    }
  }

  private halt() {
    this.token++
    this.tween?.kill()
    this.tween = null
    clearTimeout(this.settleTimer)
    this.held.clear()
  }

  private fireEntrances() {
    if (!this.plan || !this.host.onEntrances) return
    const ids: string[] = []
    for (const pe of entrancesStarted(this.plan, this.click, this.t)) {
      const key = `${pe.index}`
      if (this.fired.has(key)) continue
      this.fired.add(key)
      ids.push(pe.fx.el)
    }
    if (ids.length) this.host.onEntrances(ids)
  }
}
