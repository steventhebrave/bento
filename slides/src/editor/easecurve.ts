// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
/**
 * The easing control, used everywhere an ease is chosen — effect timing in the
 * animation pane, and morph easing per slide and per deck. A preset menu, and a
 * curve editor: the unit square with the curve, two draggable control points
 * (CSS cubic-bezier: x is time and stays within 0..1, y is progress and may
 * leave the square so a curve can overshoot), four exact number fields, and a
 * live preview — a chip that travels the curve at the real duration, looping.
 *
 * The value is what the format stores (model.ts Ease): a preset NAME, or
 * `[x1, y1, x2, y2]`. Dragging a handle from a named preset starts from that
 * preset's bezier equivalent (the easings.net fits for the power/sine family),
 * so the curve does not jump when it becomes custom.
 */

import type { Ease } from '../model'
import { BEZIER_PRESETS, easeFn, isBezier } from '../../../kernel/src/ease.ts'
import { t } from '../i18n'

/** Readable names, in menu order (translated at render). */
export const EASE_CHOICES: Array<[string, string]> = [
  ['linear', 'Linear'],
  ['power1.out', 'Ease out · gentle'], ['power2.out', 'Ease out'], ['power3.out', 'Ease out · strong'],
  ['power1.in', 'Ease in · gentle'], ['power2.in', 'Ease in'], ['power3.in', 'Ease in · strong'],
  ['power1.inOut', 'Ease in-out · gentle'], ['power2.inOut', 'Ease in-out'], ['power3.inOut', 'Ease in-out · strong'],
  ['sine.inOut', 'Sine in-out'], ['ease', 'CSS ease'],
  ['back.out', 'Overshoot'], ['back.in', 'Anticipate'], ['back.inOut', 'Anticipate + overshoot'],
]

/** Bezier equivalents of the non-bezier presets (easings.net fits), to start a custom curve from. */
const APPROX: Record<string, [number, number, number, number]> = {
  none: [0, 0, 1, 1], linear: [0, 0, 1, 1],
  'power1.in': [0.55, 0.085, 0.68, 0.53], 'power1.out': [0.25, 0.46, 0.45, 0.94], 'power1.inOut': [0.455, 0.03, 0.515, 0.955],
  'power2.in': [0.55, 0.055, 0.675, 0.19], 'power2.out': [0.215, 0.61, 0.355, 1], 'power2.inOut': [0.645, 0.045, 0.355, 1],
  'power3.in': [0.895, 0.03, 0.685, 0.22], 'power3.out': [0.165, 0.84, 0.44, 1], 'power3.inOut': [0.77, 0, 0.175, 1],
  'sine.in': [0.47, 0, 0.745, 0.715], 'sine.out': [0.39, 0.575, 0.565, 1], 'sine.inOut': [0.445, 0.05, 0.55, 0.95],
}

/** The control points that draw (or approximate) an ease. */
export function bezierOf(e: Ease | undefined | null): [number, number, number, number] {
  if (isBezier(e)) return [e[0], e[1], e[2], e[3]]
  if (typeof e === 'string') {
    const b = BEZIER_PRESETS[e] ?? APPROX[e]
    if (b) return [b[0], b[1], b[2], b[3]]
  }
  return [0, 0, 1, 1]
}

const round3 = (n: number) => Math.round(n * 1000) / 1000
const label = (e: Ease) => t(EASE_CHOICES.find(([k]) => k === e)?.[1] ?? String(e))

export interface EaseControlOpts {
  /** the stored value; undefined = inherit `fallback` */
  value: Ease | undefined
  /** what undefined means here (the type's default, the deck's morph ease…) */
  fallback: Ease
  /** how the "inherit" option reads, e.g. "Deck default" */
  inheritLabel?: string
  /** seconds the preview chip takes (the effect's or morph's duration) */
  seconds?: () => number
  /** a value was chosen; null = back to inherit. final=false while dragging */
  onChange: (e: Ease | null, final: boolean) => void
  /** start with the curve editor open */
  open?: boolean
}

const SVG_NS = 'http://www.w3.org/2000/svg'
/** The plot: x 0..1 across, y from -0.5 to 1.5 so overshoot has room. */
const W = 180
const H = 180
const PAD = 14
const Y0 = -0.5
const Y1 = 1.5
const px = (x: number) => PAD + x * (W - 2 * PAD)
const py = (y: number) => H - PAD - ((y - Y0) / (Y1 - Y0)) * (H - 2 * PAD)
const ux = (X: number) => (X - PAD) / (W - 2 * PAD)
const uy = (Y: number) => Y0 + ((H - PAD - Y) / (H - 2 * PAD)) * (Y1 - Y0)

/** A preset menu + an expandable curve editor. */
export function easeControl(opts: EaseControlOpts): HTMLElement {
  let value: Ease | undefined = opts.value
  const root = document.createElement('div')
  root.className = 'ed-ease'
  const top = document.createElement('div')
  top.className = 'ed-ease-top'
  const sel = document.createElement('select')
  const toggle = document.createElement('button')
  toggle.type = 'button'
  toggle.className = 'ed-btn ed-ease-toggle'
  toggle.title = t('Edit the curve')
  toggle.textContent = '⌇'
  top.append(sel, toggle)
  root.appendChild(top)

  const fillMenu = () => {
    sel.innerHTML = ''
    const add = (v: string, text: string) => {
      const o = document.createElement('option')
      o.value = v
      o.textContent = text
      sel.appendChild(o)
    }
    add('', `${opts.inheritLabel ?? t('Default')} (${label(opts.fallback)})`)
    for (const [k, l] of EASE_CHOICES) add(k, t(l))
    if (isBezier(value)) add('custom', t('Custom curve {b}', { b: `(${value.map(round3).join(', ')})` }))
    else if (typeof value === 'string' && !EASE_CHOICES.some(([k]) => k === value)) add(value, value)
    sel.value = value === undefined ? '' : isBezier(value) ? 'custom' : String(value)
  }
  fillMenu()

  // --- the curve editor -----------------------------------------------------------
  const panel = document.createElement('div')
  panel.className = 'ed-ease-panel'
  panel.hidden = !opts.open
  const svg = document.createElementNS(SVG_NS, 'svg')
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`)
  svg.setAttribute('width', String(W))
  svg.setAttribute('height', String(H))
  svg.setAttribute('class', 'ed-ease-plot')
  const el = <K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>) => {
    const n = document.createElementNS(SVG_NS, tag)
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v))
    svg.appendChild(n)
    return n
  }
  el('rect', { x: px(0), y: py(1), width: px(1) - px(0), height: py(0) - py(1), class: 'ed-ease-square' })
  el('line', { x1: px(0), y1: py(0), x2: px(1), y2: py(1), class: 'ed-ease-diag' })
  const arm1 = el('line', { class: 'ed-ease-arm' })
  const arm2 = el('line', { class: 'ed-ease-arm' })
  const curve = el('path', { class: 'ed-ease-curve' })
  const h1 = el('circle', { r: 6, class: 'ed-ease-handle', 'data-h': 1 })
  const h2 = el('circle', { r: 6, class: 'ed-ease-handle', 'data-h': 2 })
  const nums = document.createElement('div')
  nums.className = 'ed-ease-nums'
  const fields = ['x1', 'y1', 'x2', 'y2'].map((name, i) => {
    const f = document.createElement('input')
    f.type = 'number'
    f.step = '0.01'
    if (i % 2 === 0) { f.min = '0'; f.max = '1' }
    f.title = name
    f.setAttribute('aria-label', name)
    f.addEventListener('change', () => {
      const b = bezierOf(value ?? opts.fallback)
      const v = parseFloat(f.value)
      if (!Number.isFinite(v)) return
      b[i] = i % 2 === 0 ? Math.min(1, Math.max(0, v)) : Math.min(10, Math.max(-10, v))
      set(b.map(round3) as [number, number, number, number], true)
    })
    nums.appendChild(f)
    return f
  })
  const track = document.createElement('div')
  track.className = 'ed-ease-track'
  const chip = document.createElement('div')
  chip.className = 'ed-ease-chip'
  track.appendChild(chip)
  panel.append(svg, nums, track)
  root.appendChild(panel)
  // panel rows are <label>s: a click on the plot must not activate the row's select
  for (const n of [svg, track]) n.addEventListener('click', (ev) => ev.preventDefault())

  const draw = () => {
    const shown = value ?? opts.fallback
    const b = bezierOf(shown)
    const exact = isBezier(shown) || (typeof shown === 'string' && !!BEZIER_PRESETS[shown]) || shown === 'linear' || shown === 'none'
    // draw the TRUE curve (sampled through the engine), so a named preset shows
    // what it really does even where its bezier is only an approximation
    const f = easeFn(shown, 'linear')
    let d = ''
    for (let i = 0; i <= 64; i++) d += `${i ? 'L' : 'M'}${px(i / 64).toFixed(1)},${py(f(i / 64)).toFixed(1)}`
    curve.setAttribute('d', d)
    const hs: Array<[SVGCircleElement, SVGLineElement, number, number, number, number]> = [
      [h1, arm1, b[0], b[1], 0, 0], [h2, arm2, b[2], b[3], 1, 1],
    ]
    for (const [h, arm, x, y, ax, ay] of hs) {
      h.setAttribute('cx', String(px(x))); h.setAttribute('cy', String(py(y)))
      arm.setAttribute('x1', String(px(ax))); arm.setAttribute('y1', String(py(ay)))
      arm.setAttribute('x2', String(px(x))); arm.setAttribute('y2', String(py(y)))
      h.classList.toggle('approx', !exact)
    }
    fields.forEach((fl, i) => { if (document.activeElement !== fl) fl.value = String(round3(b[i])) })
  }

  const set = (e: Ease | null, final: boolean) => {
    value = e === null ? undefined : e
    draw()
    if (final) fillMenu()
    opts.onChange(e, final)
  }

  sel.addEventListener('change', () => {
    if (sel.value === 'custom') return
    set(sel.value === '' ? null : sel.value, true)
  })
  toggle.addEventListener('click', () => {
    panel.hidden = !panel.hidden
    toggle.classList.toggle('on', !panel.hidden)
    if (!panel.hidden) { draw(); loop() }
  })
  toggle.classList.toggle('on', !panel.hidden)

  // drag a control point: x clamped to 0..1, y free within the plot (overshoot)
  for (const h of [h1, h2]) {
    h.addEventListener('pointerdown', (ev) => {
      ev.preventDefault()
      ev.stopPropagation()
      const which = h === h1 ? 0 : 2
      const b = bezierOf(value ?? opts.fallback)
      const rect = svg.getBoundingClientRect()
      const k = W / rect.width
      h.setPointerCapture?.(ev.pointerId)
      const move = (e: PointerEvent) => {
        const X = (e.clientX - rect.left) * k
        const Y = (e.clientY - rect.top) * k
        b[which] = round3(Math.min(1, Math.max(0, ux(X))))
        b[which + 1] = round3(Math.min(Y1, Math.max(Y0, uy(Y))))
        set([b[0], b[1], b[2], b[3]], false)
      }
      const up = () => {
        h.removeEventListener('pointermove', move)
        h.removeEventListener('pointerup', up)
        set([b[0], b[1], b[2], b[3]], true)
      }
      h.addEventListener('pointermove', move)
      h.addEventListener('pointerup', up)
    })
  }

  // the live preview: the chip crosses the track on the curve, pauses, repeats
  let raf = 0
  let t0 = 0
  const loop = () => {
    cancelAnimationFrame(raf)
    t0 = performance.now()
    const frame = (now: number) => {
      if (panel.hidden || !root.isConnected) return
      const secs = Math.max(0.1, opts.seconds?.() ?? 1)
      const cycle = secs + 0.6
      const tt = ((now - t0) / 1000) % cycle
      const p = easeFn(value ?? opts.fallback, 'linear')(Math.min(1, tt / secs))
      chip.style.left = `calc(${(p * 100).toFixed(2)}% - ${(p * 18).toFixed(2)}px)`
      raf = requestAnimationFrame(frame)
    }
    raf = requestAnimationFrame(frame)
  }
  draw()
  if (!panel.hidden) queueMicrotask(loop)
  return root
}
