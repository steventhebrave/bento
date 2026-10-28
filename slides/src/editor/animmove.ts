// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
/**
 * The on-canvas handle for a straight-line move effect: when exactly one move
 * is selected in the animation pane, a dashed path runs from where the element
 * is when the move starts (after every earlier effect — moves chain) to where
 * it ends, a translucent ghost of the element sits at the end, and the end
 * handle drags the offset. Shift snaps the angle to 15° steps (the editor's
 * rotate-snap step) and keeps the length; release commits one undo step.
 *
 * Lives in the scaled stage (`.ed-stage-scale`), so it works in slide px and
 * counter-scales only its strokes and handle. Editor-only chrome: nothing here
 * is rendered by render.ts, so thumbnails, the show and print never carry it.
 */

import type { Store } from '../store'
import type { AnimEffect } from '../model'
import type { AnimUI } from './animui'
import { stateAt, planAnim } from '../animseq'
import { frameOfState } from '../effects/index.ts'
import { paintFrame } from '../animplayer'
import { paneList, ensureAnim, setFields } from './animedit'
import { t } from '../i18n'

const SVG_NS = 'http://www.w3.org/2000/svg'
const SNAP = 15

/** Snap a vector's angle to `step`° keeping its length (Shift). */
export function snapVector(dx: number, dy: number, step = SNAP): { dx: number; dy: number } {
  const len = Math.hypot(dx, dy)
  if (!len) return { dx: 0, dy: 0 }
  const a = (Math.round((Math.atan2(dy, dx) * 180) / Math.PI / step) * step * Math.PI) / 180
  return { dx: Math.round(Math.cos(a) * len), dy: Math.round(Math.sin(a) * len) }
}

export class AnimMoveHandle {
  private layer: HTMLElement
  private draft: { id: string; dx: number; dy: number } | null = null

  constructor(
    private host: HTMLElement,
    private store: Store,
    private ui: AnimUI,
    private scaleOf: () => number,
    private surfaceOf: () => HTMLElement | null,
    private slidePointAt: (x: number, y: number) => { x: number; y: number },
  ) {
    this.layer = document.createElement('div')
    this.layer.className = 'ed-anim-move-layer'
    host.appendChild(this.layer)
    ui.on(() => this.refresh())
  }

  /** The one selected move effect, if that is what is selected. */
  private target(): { fx: AnimEffect; list: AnimEffect[] } | null {
    if (!this.ui.open || this.ui.selected.length !== 1) return null
    const { list } = paneList(this.store.slide)
    const fx = list.find((f) => f.id === this.ui.selected[0])
    if (!fx || fx.type !== 'move' || (Array.isArray(fx.keys) && fx.keys.length)) return null
    return { fx, list }
  }

  refresh() {
    if (this.layer.parentElement !== this.host || this.layer.nextSibling) this.host.appendChild(this.layer) // stay on top
    this.layer.innerHTML = ''
    const hit = this.target()
    if (!hit) return
    const slide = this.store.slide
    const el = slide.elements.find((e) => e.id === hit.fx.el)
    if (!el) return
    const fx = this.draft?.id === hit.fx.id ? { ...hit.fx, dx: this.draft.dx, dy: this.draft.dy } : hit.fx
    const list = hit.list.map((f) => (f.id === fx.id ? fx : f))
    const plan = planAnim(list)
    const pe = plan.effects.find((p) => p.fx.id === fx.id)
    if (!pe) return
    const seqSlide = { ...slide, anim: list }
    const startState = stateAt(seqSlide, pe.group, pe.start, { plan }).get(el.id)
    const endState = stateAt(seqSlide, pe.group, pe.end, { plan }).get(el.id)
    if (!startState || !endState) return
    const start = frameOfState(el, startState)
    const sx = start.x + start.w / 2
    const sy = start.y + start.h / 2
    const ex = sx + (fx.dx ?? 0)
    const ey = sy + (fx.dy ?? 0)
    const inv = 1 / (this.scaleOf() || 1)

    // ghost of the element where this move leaves it
    const node = this.surfaceOf()?.querySelector<HTMLElement>(`[data-el-id="${CSS.escape(el.id)}"]`)
    if (node) {
      const ghost = node.cloneNode(true) as HTMLElement
      ghost.classList.add('ed-anim-ghost')
      ghost.removeAttribute('data-el-id')
      ghost.removeAttribute('data-flip-id')
      paintFrame(ghost, el, { ...frameOfState(el, endState), opacity: 0.38 })
      ghost.style.visibility = ''
      this.layer.appendChild(ghost)
    }

    // the path, with an arrowhead
    const svg = document.createElementNS(SVG_NS, 'svg')
    svg.setAttribute('class', 'ed-anim-path')
    const line = document.createElementNS(SVG_NS, 'line')
    line.setAttribute('x1', String(sx)); line.setAttribute('y1', String(sy))
    line.setAttribute('x2', String(ex)); line.setAttribute('y2', String(ey))
    line.setAttribute('stroke-width', String(2 * inv))
    line.setAttribute('stroke-dasharray', `${6 * inv} ${4 * inv}`)
    svg.appendChild(line)
    const dot = document.createElementNS(SVG_NS, 'circle')
    dot.setAttribute('cx', String(sx)); dot.setAttribute('cy', String(sy)); dot.setAttribute('r', String(4 * inv))
    svg.appendChild(dot)
    const len = Math.hypot(ex - sx, ey - sy)
    if (len > 12 * inv) {
      const ux = (ex - sx) / len, uy = (ey - sy) / len
      const h = 10 * inv
      const head = document.createElementNS(SVG_NS, 'path')
      head.setAttribute('d', `M${ex},${ey} L${ex - ux * h - uy * h * 0.6},${ey - uy * h + ux * h * 0.6} L${ex - ux * h + uy * h * 0.6},${ey - uy * h - ux * h * 0.6} Z`)
      svg.appendChild(head)
    }
    this.layer.appendChild(svg)

    // the end handle
    const handle = document.createElement('div')
    handle.className = 'ed-anim-handle'
    handle.style.left = `${ex}px`
    handle.style.top = `${ey}px`
    handle.style.transform = `translate(-50%, -50%) scale(${inv})`
    handle.title = t('Drag to set where the move ends — Shift snaps the angle')
    handle.addEventListener('pointerdown', (ev) => this.drag(ev, fx.id, sx, sy, fx.dx ?? 0, fx.dy ?? 0))
    handle.addEventListener('mousedown', (ev) => ev.stopPropagation()) // not a marquee start
    this.layer.appendChild(handle)
    const readout = document.createElement('div')
    readout.className = 'ed-anim-readout'
    readout.textContent = `${Math.round(fx.dx ?? 0)}, ${Math.round(fx.dy ?? 0)}`
    readout.style.left = `${ex}px`
    readout.style.top = `${ey}px`
    readout.style.transform = `translate(12px, 8px) scale(${inv})`
    readout.style.transformOrigin = '0 0'
    this.layer.appendChild(readout)
  }

  private drag(ev: PointerEvent, id: string, sx: number, sy: number, dx0: number, dy0: number) {
    ev.preventDefault()
    ev.stopPropagation()
    const target = ev.currentTarget as HTMLElement
    target.setPointerCapture?.(ev.pointerId)
    const p0 = this.slidePointAt(ev.clientX, ev.clientY)
    const off = { x: sx + dx0 - p0.x, y: sy + dy0 - p0.y } // grab offset, so the handle does not jump
    const move = (e: PointerEvent) => {
      const p = this.slidePointAt(e.clientX, e.clientY)
      let v = { dx: Math.round(p.x + off.x - sx), dy: Math.round(p.y + off.y - sy) }
      if (e.shiftKey) v = snapVector(v.dx, v.dy)
      this.draft = { id, ...v }
      this.refresh()
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      const d = this.draft
      this.draft = null
      if (d && (d.dx !== dx0 || d.dy !== dy0)) {
        this.store.commit(() => {
          ensureAnim(this.store.slide)
          setFields(this.store.slide, id, { dx: d.dx, dy: d.dy })
        })
      } else this.refresh()
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }
}
