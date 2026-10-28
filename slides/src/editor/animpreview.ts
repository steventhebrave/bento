// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
/**
 * Previewing a slide's animation sequence ON THE EDITOR CANVAS — one click
 * group or the whole slide, played or scrubbed. It paints the canvas's own
 * nodes through the same function the show uses (animplayer paintAt →
 * animseq stateAt), so what the author scrubs is what the audience gets.
 *
 * Nothing is committed and nothing is remembered: stopping re-renders the
 * canvas from the model. Any document edit ends a preview the same way (the
 * canvas re-renders on every `doc` event).
 */

import type { Store } from '../store'
import type { Slide } from '../model'
import type { ScriptSampler } from '../effects/index.ts'
import { anim, type Tween } from '../anim'
import { paintAt } from '../animplayer'
import { planAnim } from '../animseq'
import { locate, paneList, slideTimeline } from './animedit'

export interface PreviewHost {
  /** the canvas's rendered slide surface */
  surface(): HTMLElement | null
  /** hide the selection chrome while the canvas shows animation state */
  setPreviewing(on: boolean): void
  /** re-render the canvas from the model (ends the preview) */
  repaint(): void
  /** the deck's code (FORK): one slide's baked script-effect motion */
  scriptFor?(slide: Slide): ScriptSampler | undefined
  /** …and its code canvases drawn live at (click, t), then stopped */
  canvases?(slide: Slide, click: number, t: number): void
  stopCanvases?(): void
}

export type PreviewMode = 'click' | 'slide'

export class AnimPreview {
  active = false
  /** seconds along the current mode's timeline */
  T = 0
  mode: PreviewMode = 'slide'
  click = 0
  /** called on every painted frame with (T, total) — the scrubber follows */
  onFrame: ((T: number, total: number) => void) | null = null
  /** called when playback stops by itself or is stopped */
  onStop: (() => void) | null = null
  playing = false
  private tween: Tween | null = null

  constructor(private host: PreviewHost, private store: Store) {}

  /** The length of the timeline a mode spans. */
  total(mode: PreviewMode = this.mode, click = this.click): number {
    const plan = planAnim(paneList(this.store.slide).list)
    return mode === 'slide' ? slideTimeline(plan).total : plan.groups[click] ?? 0
  }

  /** Show the state at T on `mode`'s timeline (scrubbing). */
  show(mode: PreviewMode, click: number, T: number) {
    this.halt()
    this.mode = mode
    this.click = click
    this.paint(T)
  }

  /** Play `mode`'s timeline from its start. */
  play(mode: PreviewMode, click: number) {
    this.halt()
    this.mode = mode
    this.click = click
    const total = this.total()
    this.paint(0)
    this.playing = true
    const state = { T: 0 }
    this.tween = anim.to(state, {
      T: total,
      duration: Math.max(total, 0.0001),
      ease: 'none',
      onUpdate: () => this.paint(state.T),
      onComplete: () => {
        this.tween = null
        this.playing = false
        this.paint(total)
        this.onStop?.()
      },
    })
  }

  /** End the preview: the canvas shows the model again. */
  stop() {
    const was = this.active
    this.halt()
    this.active = false
    if (was) {
      this.host.stopCanvases?.()
      this.host.setPreviewing(false)
      this.host.repaint()
    }
    this.onStop?.()
  }

  private halt() {
    this.tween?.kill()
    this.tween = null
    this.playing = false
  }

  private paint(T: number) {
    const surface = this.host.surface()
    if (!surface) return
    const slide = this.store.slide
    const { list } = paneList(slide)
    const plan = planAnim(list)
    if (!this.active) {
      this.active = true
      this.host.setPreviewing(true)
    }
    this.T = T
    const pos = this.mode === 'slide' ? locate(plan, T) : { click: this.click, t: T }
    paintAt(surface, { ...slide, anim: list }, pos.click, pos.t, { plan, script: this.host.scriptFor?.(slide) })
    this.host.canvases?.(slide, pos.click, pos.t)
    this.onFrame?.(T, this.total())
  }
}
