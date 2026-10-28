// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
/**
 * A legacy slide's reveal fields read as an animation sequence.
 *
 * A slide with no `anim` plays through the legacy runtime (present.ts
 * runEnterFx + steps.ts): `fx.enter` entrances on arrival, staggered by
 * `fx.order` (or list position), and `fx.step` reveals on clicks. The
 * animation pane shows that as an IMPLICIT list, and its first edit converts
 * the slide to an explicit `anim` built here — so this reproduces the legacy
 * runtime's timing number for number:
 *
 *  - arrival: every element with an entrance/count-up/typewriter, not stepped,
 *    not hover-revealed, sorted by `order ?? 0` (stable); position i in that
 *    list; an entrance becomes a fade-in (with its fly-in offset, duration and
 *    ease from enterSpec) on `with`, delayed 0.12 + min(order ?? i, 24) × 0.05
 *  - step s (ascending; gaps collapse, as → presses through them): its
 *    elements, sorted the same way, the first on `click`, the rest `with`;
 *    an entrance kind (or a plain fade when it has none) delayed
 *    min(order ?? i, 24) × 0.05 — no 0.12 lead, as a reveal has none
 *  - a stepped element the legacy runtime shows WITHOUT an entrance (it owns a
 *    motion-path loop, or it is hover-revealed) becomes an instant `appear`
 *
 * The one deliberate difference: on a MORPH arrival the legacy runtime starts
 * entrances at 40% of the morph; a sequence's arrival group starts when the
 * morph has landed. Equivalent, not identical — which is why conversion is an
 * explicit act (the first edit), never automatic.
 *
 * `fx.countUp` and `fx.typeWriter` stay where they are: a sequence runs them
 * when the element's entrance starts. DOM-free (scripts/test-slides-anim-legacy.ts).
 */

import type { AnimEffect, Slide, SlideElement } from './model'

type EnterKind = NonNullable<NonNullable<SlideElement['fx']>['enter']>

/** The legacy runtime's enterSpec (present.ts), as fade-in fields. */
export function enterAsFadeIn(kind: EnterKind, enterDur?: number): Pick<AnimEffect, 'fromDx' | 'fromDy' | 'duration' | 'ease'> {
  const D = 120
  const out: Pick<AnimEffect, 'fromDx' | 'fromDy' | 'duration' | 'ease'> = {}
  if (kind === 'fade-up') out.fromDy = 16
  else if (kind === 'fade-down') out.fromDy = -16
  else if (kind === 'slide-left') out.fromDx = D
  else if (kind === 'slide-right') out.fromDx = -D
  else if (kind === 'slide-up') out.fromDy = D
  else if (kind === 'slide-down') out.fromDy = -D
  const sliding = kind.startsWith('slide-')
  out.duration = enterDur ?? (sliding ? 0.75 : 0.55)
  out.ease = sliding ? 'power3.out' : 'power2.out'
  return out
}

/** steps.ts stepOf, restated so this module stays dependency-light. */
const stepOf = (el: SlideElement): number => {
  const s = el.fx?.step
  return typeof s === 'number' && Number.isFinite(s) && s > 0 ? Math.floor(s) : 0
}

/** Does the slide carry any legacy reveal behaviour worth listing? */
export const hasLegacyAnim = (slide: Pick<Slide, 'elements'>): boolean =>
  slide.elements.some((el) => !!el.fx && (!!el.fx.enter || stepOf(el) > 0))

/**
 * The legacy fields as an effect list. Ids are deterministic
 * (`<slideId>-legacy-<n>`), so the implicit list the pane shows and the list a
 * conversion writes are the same objects by value.
 */
export function legacyAnim(slide: Pick<Slide, 'id' | 'elements'>): AnimEffect[] {
  const out: AnimEffect[] = []
  const id = () => `${slide.id}-legacy-${out.length + 1}`
  const order = (els: SlideElement[]) =>
    els.map((el, i) => ({ el, i })).sort((a, b) => (a.el.fx!.order ?? 0) - (b.el.fx!.order ?? 0) || a.i - b.i).map((x) => x.el)
  const withFx = slide.elements.filter((el) => !!el.fx)

  // arrival: runEnterFx(slide, section, undefined, false, 0)
  const arriving = order(withFx.filter((el) =>
    (el.fx!.enter || el.fx!.countUp || el.fx!.typeWriter) && !el.showOnHover && stepOf(el) === 0))
  arriving.forEach((el, i) => {
    const fx = el.fx!
    if (fx.loop?.type === 'motion-path' || !fx.enter) return
    out.push({
      id: id(), el: el.id, type: 'fade-in', trigger: 'with',
      delay: round(0.12 + Math.min(fx.order ?? i, 24) * 0.05),
      ...enterAsFadeIn(fx.enter, fx.enterDur),
    })
  })

  // reveal steps: runEnterFx(slide, section, ids, true) per step
  const steps = [...new Set(withFx.map(stepOf).filter((s) => s > 0))].sort((a, b) => a - b)
  for (const s of steps) {
    const inStep = withFx.filter((el) => stepOf(el) === s)
    // the legacy runtime animates these (fxNodes filter with revealing=true)…
    const animated = order(inStep.filter((el) => !el.showOnHover))
    let first = true
    const trigger = (): AnimEffect['trigger'] => (first ? ((first = false), 'click') : 'with')
    animated.forEach((el, i) => {
      const fx = el.fx!
      if (fx.loop?.type === 'motion-path') { out.push({ id: id(), el: el.id, type: 'appear', trigger: trigger() }); return }
      out.push({
        id: id(), el: el.id, type: 'fade-in', trigger: trigger(),
        delay: round(Math.min(fx.order ?? i, 24) * 0.05),
        ...enterAsFadeIn(fx.enter ?? 'fade', fx.enterDur),
      })
    })
    // …and simply shows the rest (the step class comes off)
    for (const el of inStep.filter((e) => e.showOnHover)) out.push({ id: id(), el: el.id, type: 'appear', trigger: trigger() })
  }
  // tidy: drop zero delays and offsets so the JSON reads as an author would write it
  for (const fx of out) {
    if (!fx.delay) delete fx.delay
    if (!fx.fromDx) delete fx.fromDx
    if (!fx.fromDy) delete fx.fromDy
  }
  return out
}

const round = (n: number) => Math.round(n * 1000) / 1000
