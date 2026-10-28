// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
/**
 * The on-canvas anchor handle (FORK; anchor.ts). With one element selected, a
 * small crosshair marks the point it pivots on — spin effects turn about it,
 * and rotating or resizing it on the canvas holds it still. Drag the crosshair
 * to move the anchor; it snaps to the box's corners, edge midpoints and centre
 * (Alt drags freely); double-click it to put it back in the centre. One undo
 * step per drag.
 *
 * Shown only for an element that HAS an anchor: every element pivots on its
 * centre by default, and a crosshair there would sit exactly where people
 * double-click to edit text. The panel's Anchor picker gives an element one;
 * from then on it is dragged here. Lives in the scaled stage like the move
 * handle (animmove.ts): slide px, counter-scaled chrome, editor-only —
 * nothing here reaches render.ts.
 */

import type { Store } from '../store'
import type { SlideElement } from '../model'
import { anchorAt, anchorOf, anchorPoint, hasAnchor, type Anchor } from '../anchor'
import { t } from '../i18n'

/** Screen px within which a drag snaps to one of the box's nine points. */
const SNAP_PX = 9
const NINE: Anchor[] = [0, 0.5, 1].flatMap((y) => [0, 0.5, 1].map((x): Anchor => [x, y]))

export class AnchorHandle {
  private layer: HTMLElement
  private draft: { id: string; a: Anchor } | null = null
  private hidden = false
  /** when the last press-without-a-drag ended (a second one soon after = double-click) */
  private lastTap = 0

  constructor(
    private host: HTMLElement,
    private store: Store,
    private scaleOf: () => number,
    /** the one element the handle is for, or null (nothing / several / editing) */
    private subject: () => SlideElement | null,
    private slidePointAt: (x: number, y: number) => { x: number; y: number },
  ) {
    this.layer = document.createElement('div')
    this.layer.className = 'ed-anchor-layer'
    host.appendChild(this.layer)
  }

  /** Hide while Moveable drags, turns or sizes the element (the model catches up at the end). */
  setGesture(on: boolean) {
    this.hidden = on
    this.layer.style.display = on ? 'none' : ''
    if (!on) this.refresh()
  }

  refresh() {
    if (this.layer.parentElement !== this.host || this.layer.nextSibling) this.host.appendChild(this.layer) // stay on top
    this.layer.innerHTML = ''
    if (this.hidden) return
    const el = this.subject()
    if (!el || (!hasAnchor(el) && this.draft?.id !== el.id)) return
    const a = this.draft?.id === el.id ? this.draft.a : anchorOf(el)
    const p = anchorPoint(el, el.rotation, a)
    const inv = 1 / (this.scaleOf() || 1)
    const h = document.createElement('div')
    h.className = 'ed-anchor-handle'
    h.style.left = `${p.x}px`
    h.style.top = `${p.y}px`
    h.style.transform = `translate(-50%, -50%) scale(${inv})`
    h.title = t('Anchor — spins turn about it, and rotating or resizing holds it still. Drag to move (snaps to corners, edges and centre; Alt for free); double-click for the centre.')
    h.setAttribute('aria-label', t('Anchor point'))
    h.addEventListener('pointerdown', (ev) => this.drag(ev, el))
    h.addEventListener('mousedown', (ev) => ev.stopPropagation()) // not a marquee, not a Moveable drag
    // double-click is detected from the presses themselves: a press repaints
    // the handle, so the second click of a pair lands on a NEW node and the
    // browser's dblclick never reaches a listener
    this.layer.appendChild(h)
  }

  private drag(ev: PointerEvent, el: SlideElement) {
    if (ev.button !== 0) return
    ev.preventDefault()
    ev.stopPropagation()
    const target = ev.currentTarget as HTMLElement
    target.setPointerCapture?.(ev.pointerId)
    const start = anchorOf(el)
    const p0 = this.slidePointAt(ev.clientX, ev.clientY)
    const a0 = anchorPoint(el, el.rotation, start)
    const grab = { x: a0.x - p0.x, y: a0.y - p0.y } // so the handle does not jump to the pointer
    let moved = false
    const move = (e: PointerEvent) => {
      const p = this.slidePointAt(e.clientX, e.clientY)
      const at = { x: p.x + grab.x, y: p.y + grab.y }
      let a = anchorAt(el, el.rotation, at)
      if (!e.altKey) {
        const tol = SNAP_PX / (this.scaleOf() || 1)
        for (const s of NINE) {
          const q = anchorPoint(el, el.rotation, s)
          if (Math.hypot(q.x - at.x, q.y - at.y) <= tol) { a = s; break }
        }
      }
      moved = true
      this.draft = { id: el.id, a }
      this.refresh()
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      const d = this.draft
      this.draft = null
      if (moved && d && (d.a[0] !== start[0] || d.a[1] !== start[1])) { this.lastTap = 0; this.commit(el.id, d.a); return }
      const now = performance.now()
      if (!moved && now - this.lastTap < 450) { this.lastTap = 0; this.commit(el.id, [0.5, 0.5]); return }
      this.lastTap = moved ? 0 : now
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  /** One undo step. The centre is stored as no anchor at all. */
  private commit(id: string, a: Anchor) {
    const round = (v: number) => Math.round(v * 10000) / 10000
    const next: Anchor = [round(Math.min(10, Math.max(-10, a[0]))), round(Math.min(10, Math.max(-10, a[1])))]
    const el = this.store.element(id)
    if (!el) return
    const centre = next[0] === 0.5 && next[1] === 0.5
    if (centre && !el.anchor) { this.refresh(); return }
    this.store.commit(() => {
      const e = this.store.element(id)
      if (!e) return
      if (centre) delete e.anchor
      else e.anchor = next
    })
  }
}
