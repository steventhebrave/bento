// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
/**
 * Step badges — a numbered chip at the top-left corner of every element that
 * has a reveal step (`fx.step`), so the order a slide will build in is visible
 * on the canvas instead of buried in the Presenting section. EDITOR-ONLY: the
 * layer sits beside the rendered slide, not inside it, so thumbnails, present,
 * print and the file-manager preview (all built from render.ts) never carry a
 * badge — scripts/test-slides-reveal-ui.ts holds render.ts to that.
 *
 * Shown only while the slide has a step at all (reveal.ts hasSteps): a slide
 * that does not use reveals carries no chrome for them. Clicking a badge
 * selects the element and walks it to the next step (reveal.ts cycleStep);
 * the number is also editable in the panel's Presenting section.
 */

import type { Store } from '../store'
import { stepOf } from '../steps'
import { cycleStep, hasSteps } from './reveal'
import { t } from '../i18n'
import { clicksByElement, planAnim, usesAnim } from '../animseq'
import type { AnimUI } from './animui'

export class StepBadges {
  private layer: HTMLElement
  private anim: { ui: AnimUI; onBadge: (elId: string) => void } | null = null

  constructor(
    private store: Store,
    stageParent: HTMLElement,
    private scaleOf: () => number,
  ) {
    this.layer = document.createElement('div')
    this.layer.className = 'ed-step-layer'
    stageParent.appendChild(this.layer)
  }

  /** On a slide with an animation sequence the badges show ITS clicks. */
  setAnim(ui: AnimUI, onBadge: (elId: string) => void) {
    this.anim = { ui, onBadge }
    ui.on(() => this.refresh())
    this.refresh()
  }

  /**
   * Sequence badges: one per animated element, reading the clicks it moves on
   * ("1·3"; "▸" for the arrival group). A click selects the element and opens
   * the Animate tab on its effects.
   */
  private refreshAnim() {
    const slide = this.store.slide
    const scale = this.scaleOf()
    const selected = new Set(this.store.selection)
    const lit = new Set(this.anim?.ui.selected ?? [])
    const plan = planAnim(slide.anim)
    const litEls = new Set(plan.effects.filter((p) => lit.has(p.fx.id)).map((p) => p.fx.el))
    for (const [id, clicks] of clicksByElement(plan)) {
      const el = slide.elements.find((e) => e.id === id)
      if (!el) continue
      const badge = document.createElement('button')
      badge.className = 'ed-step-badge ed-anim-badge' + (selected.has(el.id) || litEls.has(el.id) ? ' sel' : '')
      badge.textContent = clicks.map((c) => (c === 0 ? '▸' : String(c))).join('·')
      badge.title = t('Animates on {clicks} — click to edit in the Animate tab', {
        clicks: clicks.map((c) => (c === 0 ? t('arrival') : t('click {n}', { n: String(c) }))).join(', '),
      })
      badge.style.left = `${el.x * scale - 9}px`
      badge.style.top = `${el.y * scale - 9}px`
      badge.addEventListener('mousedown', (ev) => ev.stopPropagation()) // not a marquee start
      badge.addEventListener('click', (ev) => {
        ev.stopPropagation()
        this.anim?.onBadge(el.id)
      })
      this.layer.appendChild(badge)
    }
  }

  /** Rebuild the badges for the current slide (after render/relayout/selection). */
  refresh() {
    this.layer.innerHTML = ''
    const slide = this.store.slide
    if (slide && usesAnim(slide)) { this.refreshAnim(); return }
    if (!slide || !hasSteps(slide.elements)) return
    const scale = this.scaleOf()
    const selected = new Set(this.store.selection)
    for (const el of slide.elements) {
      const step = stepOf(el)
      if (!step) continue
      const badge = document.createElement('button')
      badge.className = 'ed-step-badge' + (selected.has(el.id) ? ' sel' : '')
      badge.textContent = String(step)
      badge.title = t('Reveal step {n} — click for the next step; set the number in Presenting', { n: String(step) })
      badge.style.left = `${el.x * scale - 9}px`
      badge.style.top = `${el.y * scale - 9}px`
      badge.addEventListener('mousedown', (ev) => ev.stopPropagation()) // not a marquee start
      badge.addEventListener('click', (ev) => {
        ev.stopPropagation()
        const cur = this.store.element(el.id)
        if (!cur) return
        const next = cycleStep(this.store.slide.elements, cur)
        this.store.select([el.id])
        this.store.commit(() => { cur.fx = { ...(cur.fx ?? {}), step: next } })
      })
      this.layer.appendChild(badge)
    }
  }
}
