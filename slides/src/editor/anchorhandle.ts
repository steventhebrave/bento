// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
/**
 * The on-canvas anchor handle (FORK; anchor.ts). Whenever one element has
 * Moveable's selection box, a small crosshair marks the point it pivots on —
 * spin effects turn about it, and rotating or resizing it on the canvas holds
 * it still. Drag the crosshair to move the anchor; it snaps to the box's
 * corners, edge midpoints and centre (Alt drags freely). One undo step per
 * drag. The panel's Anchor picker (its middle point) puts it back.
 *
 * It sits on top of the element, mostly at its centre, which is where people
 * grab and double-click things. So:
 *  - only its RING takes the pointer: the middle is open, so a press, drag or
 *    double-click at the exact centre goes to the element as if the crosshair
 *    were not there (and on a corner anchor, to Moveable's corner control);
 *  - on the ring, only a press that MOVES is an anchor drag; a click stays a
 *    click, and a double-click is handed to whatever is beneath it, so text,
 *    code, table cells and image crops open exactly as without it;
 *  - an element too small on screen to hold both a crosshair and somewhere
 *    else to grab shows none unless it has an anchor of its own.
 * Lives in the scaled stage like the move handle (animmove.ts): slide px,
 * counter-scaled chrome, editor-only — nothing here reaches render.ts.
 */

import type { Store } from '../store'
import type { SlideElement } from '../model'
import { anchorAt, anchorOf, anchorPoint, hasAnchor, type Anchor } from '../anchor'
import { t } from '../i18n'

/** Screen px within which a drag snaps to one of the box's nine points. */
const SNAP_PX = 9
/** Screen px a press must travel before it is an anchor drag rather than a click. */
const DRAG_PX = 3
/** Below this on screen (either side), an element without an anchor shows no crosshair. */
const MIN_PX = 44
const SVG_NS = 'http://www.w3.org/2000/svg'
const NINE: Anchor[] = [0, 0.5, 1].flatMap((y) => [0, 0.5, 1].map((x): Anchor => [x, y]))

export class AnchorHandle {
  private layer: HTMLElement
  private draft: { id: string; a: Anchor } | null = null
  private hidden = false

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
    if (!el) return
    const scale = this.scaleOf() || 1
    const own = hasAnchor(el) || this.draft?.id === el.id
    if (!own && (el.w * scale < MIN_PX || el.h * scale < MIN_PX)) return
    const a = this.draft?.id === el.id ? this.draft.a : anchorOf(el)
    const p = anchorPoint(el, el.rotation, a)
    const inv = 1 / scale
    // an svg so the hit area can be a RING (pointer-events: stroke): the
    // middle stays open to the element beneath
    const h = document.createElementNS(SVG_NS, 'svg')
    h.setAttribute('class', 'ed-anchor-handle' + (own ? '' : ' centre'))
    h.setAttribute('viewBox', '-12 -12 24 24')
    h.setAttribute('width', '24')
    h.setAttribute('height', '24')
    h.innerHTML = '<circle class="halo" r="6.5"/><path class="cross" d="M0 -11V-4M0 4V11M-11 0H-4M4 0H11"/>'
      + '<circle class="ring" r="6.5"/><circle class="hit" r="7"/>'
    h.style.left = `${p.x}px`
    h.style.top = `${p.y}px`
    h.style.transform = `translate(-50%, -50%) scale(${inv})`
    const tip = document.createElementNS(SVG_NS, 'title')
    tip.textContent = t('Anchor — spins turn about it, and rotating or resizing holds it still. Drag its ring to move it (snaps to corners, edges and centre; Alt for free).')
    h.prepend(tip)
    h.setAttribute('aria-label', t('Anchor point'))
    h.addEventListener('pointerdown', (ev) => this.drag(ev, el))
    h.addEventListener('mousedown', (ev) => ev.stopPropagation()) // not a marquee, not a Moveable drag
    h.addEventListener('dblclick', (ev) => this.passThrough(ev))
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
      if (!moved && Math.hypot(e.clientX - ev.clientX, e.clientY - ev.clientY) < DRAG_PX) return
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
      if (moved && d && (d.a[0] !== start[0] || d.a[1] !== start[1])) this.commit(el.id, d.a)
      else if (moved) this.refresh()
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  /**
   * A double-click on the crosshair belongs to what is beneath it: the
   * canvas opens text, code, cells and crops from the double-click's target,
   * so re-send it there.
   */
  private passThrough(ev: MouseEvent) {
    ev.preventDefault()
    ev.stopPropagation()
    const under = document.elementsFromPoint(ev.clientX, ev.clientY)
      .find((n) => !this.layer.contains(n) && !!n.closest('.ed-stage-scale .bento-slide [data-el-id]'))
    under?.dispatchEvent(new MouseEvent('dblclick', {
      bubbles: true, cancelable: true, composed: true, view: window, detail: 2,
      clientX: ev.clientX, clientY: ev.clientY, screenX: ev.screenX, screenY: ev.screenY,
      altKey: ev.altKey, shiftKey: ev.shiftKey, metaKey: ev.metaKey, ctrlKey: ev.ctrlKey,
    }))
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
