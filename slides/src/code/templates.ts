// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
/**
 * Starting points for a deck's code (FORK, the code layer): what "New effect
 * script" and "New canvas script" put in the editor. Each is a complete,
 * working module and a short lesson in the contract — the comments are the
 * documentation an author sees first.
 */

export const EFFECT_TEMPLATE = `// A SCRIPT EFFECT. The animation pane owns WHEN (trigger, delay, duration,
// easing); this function owns WHAT happens during it.
//
//   p       progress, 0 → 1, already eased
//   base    the element's frame from every effect before this one:
//           { x, y, w, h, rotation, opacity, scale, fill?, color? }
//   params  the values set in the pane (declared in meta.params below)
//   ctx     { t, duration, click, el: {w, h}, slide: {w, h},
//             random(), noise(x), lerp(a, b, t), clamp(v, lo, hi) }
//
// Return only what you change. It must be a pure function of its inputs:
// the show can ask for any moment, in any order, as many times as it likes
// (scrubbing, ← and the morph all depend on that). Math.random is seeded.
export const meta = {
  kind: 'effect',
  label: 'Damped wobble',
  drives: ['rotation'],
  params: {
    angle: { type: 'number', default: 15, min: 0, max: 90, step: 1, unit: '°', label: 'Angle' },
    swings: { type: 'number', default: 4, min: 1, max: 20, step: 1, label: 'Swings' },
    decay: { type: 'number', default: 4, min: 0, max: 12, step: 0.5, label: 'Damping' },
  },
}

export default function wobble(p, base, params) {
  const envelope = Math.exp(-params.decay * p) * (1 - p)
  return { rotation: base.rotation + params.angle * envelope * Math.sin(p * params.swings * 2 * Math.PI) }
}
`

export const CANVAS_TEMPLATE = `// A CODE CANVAS. draw(g, ctx) paints ONE frame on a 2D canvas the size of
// the element.
//
//   g    a CanvasRenderingContext2D, in element pixels
//   ctx  { click, t, params, width, height, dpr,
//          random(), noise(x), lerp(a, b, t), clamp(v, lo, hi) }
//        click = the slide's current click (0 = arrival),
//        t     = seconds since that click began (it restarts at every click)
//
// Like an effect, it must be a pure function of (click, t, params): the
// show asks for whatever moment it needs. meta.duration (seconds per click)
// makes the drawing hold its last frame once reached; without it, it runs
// for as long as the slide is on screen.
export const meta = {
  kind: 'canvas',
  label: 'Pendulum',
  params: {
    length: { type: 'number', default: 0.8, min: 0.2, max: 2, step: 0.05, unit: 'm', label: 'Length' },
    angle: { type: 'number', default: 35, min: 0, max: 80, step: 1, unit: '°', label: 'Released from' },
    damping: { type: 'number', default: 0.12, min: 0, max: 2, step: 0.02, label: 'Damping' },
    bob: { type: 'color', default: '#ff9e8a', label: 'Bob' },
  },
}

export default function draw(g, ctx) {
  const { width: w, height: h, params } = ctx
  const theta0 = (params.angle * Math.PI) / 180
  // released from theta0 when the slide arrives (and again at every click);
  // try \`ctx.click === 0 ? theta0 : …\` to hold it until the first click
  const omega = Math.sqrt(9.81 / params.length)
  const theta = theta0 * Math.exp(-params.damping * ctx.t) * Math.cos(omega * ctx.t)
  const pivot = { x: w / 2, y: h * 0.08 }
  const L = h * 0.72
  const bob = { x: pivot.x + L * Math.sin(theta), y: pivot.y + L * Math.cos(theta) }
  const r = Math.max(8, h * 0.06)
  g.lineCap = 'round'
  g.strokeStyle = 'rgba(127, 127, 127, 0.9)'
  g.lineWidth = Math.max(2, h * 0.008)
  g.beginPath(); g.moveTo(pivot.x - w * 0.2, pivot.y); g.lineTo(pivot.x + w * 0.2, pivot.y); g.stroke()
  g.beginPath(); g.moveTo(pivot.x, pivot.y); g.lineTo(bob.x, bob.y); g.stroke()
  g.fillStyle = params.bob
  g.beginPath(); g.arc(bob.x, bob.y, r, 0, 2 * Math.PI); g.fill()
}
`

/** A fresh script name not yet in the deck: base, base2, base3, … */
export function freshScriptName(existing: Record<string, unknown> | undefined, base: string): string {
  const have = new Set(Object.keys(existing ?? {}))
  if (!have.has(base)) return base
  for (let i = 2; ; i++) if (!have.has(`${base}${i}`)) return `${base}${i}`
}
