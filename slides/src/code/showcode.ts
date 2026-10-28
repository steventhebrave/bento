// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
/**
 * Code canvases in a running show (FORK, Tier 3 of the code layer).
 *
 * The slide on screen gets one live sandbox frame per canvas element
 * (host.ts CanvasRunner), laid over the element's node so the element's own
 * frame, transform and opacity — the UI's — carry the drawing. The SHOW owns
 * the clock: each canvas is asked for (click, t), where t is the seconds since
 * that click began, on the anim engine's clock (so the manual test clock
 * drives it, and a hidden tab stalls it like every other tween). A canvas
 * whose script declares `meta.duration` holds its last frame once that is
 * reached; one without runs while it is on screen.
 *
 * ← lands a click on its end, as the sequence does: the clock resumes at the
 * click's declared duration (or the slide's own group length when there is
 * none). Reduced motion and code switched off show the poster — the still the
 * editor captured — and start no frame at all.
 */

import { anim, type Tween } from '../anim'
import type { CanvasElement, Slide } from '../model'
import { canvasDuration, CanvasRunner, type CodeHost } from './host'

interface Live {
  el: CanvasElement
  node: HTMLElement
  runner: CanvasRunner
}

export class ShowCode {
  private live: Live[] = []
  private clock: Tween | null = null
  private section: HTMLElement | null = null
  private slide: Slide | null = null
  private click = 0
  private t0 = 0

  constructor(
    private host: CodeHost,
    private opts: { reduceMotion: () => boolean; scale: () => number; groupEnd: (slide: Slide, click: number) => number },
  ) {}

  /** Is anything going to run? (code on, motion allowed) */
  private get running(): boolean { return this.host.active && !this.opts.reduceMotion() }

  /** The slide that just became current, at `click` (its start, or its end when arriving backward). */
  enter(section: HTMLElement, slide: Slide, click: number, atEnd: boolean) {
    this.leave()
    this.section = section
    this.slide = slide
    if (!this.running) return
    for (const el of slide.elements) {
      if (el.type !== 'canvas') continue
      const node = section.querySelector<HTMLElement>(`[data-el-id="${CSS.escape(el.id)}"]`)
      if (!node) continue
      const id = el.id
      const runner = new CanvasRunner(this.host, node,
        () => (this.slide?.elements.find((e) => e.id === id) as CanvasElement | undefined),
        () => Math.min(3, (window.devicePixelRatio || 1) * Math.max(0.25, this.opts.scale())))
      runner.onDrawn = () => node.classList.add('bento-canvas-live')
      this.live.push({ el, node, runner })
    }
    if (this.live.length) this.at(click, atEnd)
  }

  /** The show moved to `click` on the same slide: forward plays it from 0, backward lands on its end. */
  at(click: number, atEnd: boolean) {
    this.click = click
    if (!this.live.length || !this.slide) return
    this.t0 = atEnd ? this.endOf(click) : 0
    this.run()
  }

  /** Where a click's motion ends: the longest declared duration, else the slide's own group. */
  private endOf(click: number): number {
    let end = this.slide ? this.opts.groupEnd(this.slide, click) : 0
    for (const l of this.live) {
      const d = canvasDuration(this.host.metaOf(l.el.script), click)
      if (d !== undefined) end = Math.max(end, d)
    }
    return end
  }

  private draw(t: number) {
    for (const l of this.live) {
      const d = canvasDuration(this.host.metaOf(l.el.script), this.click)
      l.runner.draw(this.click, d === undefined ? t : Math.min(t, d))
    }
  }

  private run() {
    this.clock?.kill()
    const state = { t: this.t0 }
    this.draw(state.t)
    // an hour of clock: past that a talk has bigger problems than a canvas
    this.clock = anim.to(state, { t: this.t0 + 3600, duration: 3600, ease: 'none', onUpdate: () => this.draw(state.t) })
  }

  /** Stop the clocks and frames; the nodes show their posters again. */
  leave() {
    this.clock?.kill()
    this.clock = null
    for (const l of this.live) {
      l.runner.destroy()
      l.node.classList.remove('bento-canvas-live')
    }
    this.live = []
    this.section = null
    this.slide = null
  }

  /** Re-evaluate after the viewer switched code or motion: restart (or stop) on the same slide and click. */
  refresh() {
    const { section, slide, click } = this
    if (!section || !slide) return
    this.enter(section, slide, click, true)
  }

  get size(): number { return this.live.length }
}
