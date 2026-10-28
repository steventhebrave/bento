// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Easing curves, shared by the tween engine (anim.ts) and by anything that
// has to evaluate an ease WITHOUT running a tween — bento/slides' animation
// sequence (animseq.ts) computes the state at any click and time as a pure
// function, so it needs the same curves the player animates with, in node,
// with no DOM.
//
// An ease is either a NAME from the table below or a CSS-style cubic-bezier
// `[x1, y1, x2, y2]`, with exactly the meaning of CSS `cubic-bezier()`: the
// curve runs from (0,0) to (1,1) through the two control points, x is time
// and y is progress. x1 and x2 are clamped to 0..1 (outside that the curve
// is not a function of time); y is free, so a curve can overshoot and settle.

export type EaseFn = (t: number) => number
export type Ease = string | readonly [number, number, number, number] | readonly number[]

const pow = (n: number) => ({
  in: (t: number) => t ** n,
  out: (t: number) => 1 - (1 - t) ** n,
  inOut: (t: number) => (t < 0.5 ? (2 * t) ** n / 2 : 1 - (2 - 2 * t) ** n / 2),
})

/**
 * Solve a CSS cubic-bezier for y at time x. The x polynomial is inverted by
 * Newton's method, falling back to bisection where the slope is too flat for
 * Newton to converge — the same strategy as WebKit's UnitBezier, which is what
 * makes a curve here land where the same numbers land in a stylesheet.
 */
export function cubicBezier(x1: number, y1: number, x2: number, y2: number): EaseFn {
  x1 = Math.min(1, Math.max(0, x1))
  x2 = Math.min(1, Math.max(0, x2))
  if (x1 === y1 && x2 === y2) return (t) => Math.min(1, Math.max(0, t))
  const cx = 3 * x1
  const bx = 3 * (x2 - x1) - cx
  const ax = 1 - cx - bx
  const cy = 3 * y1
  const by = 3 * (y2 - y1) - cy
  const ay = 1 - cy - by
  const sampleX = (t: number) => ((ax * t + bx) * t + cx) * t
  const sampleY = (t: number) => ((ay * t + by) * t + cy) * t
  const slopeX = (t: number) => (3 * ax * t + 2 * bx) * t + cx
  const solveX = (x: number): number => {
    let t = x
    for (let i = 0; i < 8; i++) {
      const err = sampleX(t) - x
      if (Math.abs(err) < 1e-7) return t
      const d = slopeX(t)
      if (Math.abs(d) < 1e-6) break
      t -= err / d
    }
    let lo = 0
    let hi = 1
    t = x
    for (let i = 0; i < 64; i++) {
      const v = sampleX(t)
      if (Math.abs(v - x) < 1e-7) return t
      if (x > v) lo = t
      else hi = t
      t = (lo + hi) / 2
    }
    return t
  }
  return (x) => (x <= 0 ? 0 : x >= 1 ? 1 : sampleY(solveX(x)))
}

/** The CSS keyword curves and a few overshooting ones, as bezier points. */
export const BEZIER_PRESETS: Readonly<Record<string, readonly [number, number, number, number]>> = {
  ease: [0.25, 0.1, 0.25, 1],
  'ease-in': [0.42, 0, 1, 1],
  'ease-out': [0, 0, 0.58, 1],
  'ease-in-out': [0.42, 0, 0.58, 1],
  'back.in': [0.36, 0, 0.66, -0.56],
  'back.out': [0.34, 1.56, 0.64, 1],
  'back.inOut': [0.68, -0.6, 0.32, 1.6],
}

export const EASES: Readonly<Record<string, EaseFn>> = {
  none: (t) => t,
  linear: (t) => t,
  'power1.in': pow(2).in, 'power1.out': pow(2).out, 'power1.inOut': pow(2).inOut,
  'power2.in': pow(3).in, 'power2.out': pow(3).out, 'power2.inOut': pow(3).inOut,
  'power3.in': pow(4).in, 'power3.out': pow(4).out, 'power3.inOut': pow(4).inOut,
  'sine.in': (t) => 1 - Math.cos((t * Math.PI) / 2),
  'sine.out': (t) => Math.sin((t * Math.PI) / 2),
  'sine.inOut': (t) => -(Math.cos(Math.PI * t) - 1) / 2,
  ...Object.fromEntries(Object.entries(BEZIER_PRESETS).map(([k, b]) => [k, cubicBezier(b[0], b[1], b[2], b[3])])),
}

/** Is this a cubic-bezier array (four finite numbers)? */
export const isBezier = (e: unknown): e is readonly [number, number, number, number] =>
  Array.isArray(e) && e.length === 4 && e.every((n) => typeof n === 'number' && Number.isFinite(n))

const bezierCache = new Map<string, EaseFn>()

/**
 * The curve for an ease value. An unknown NAME is linear — the engine's rule
 * since before cubic-bezier existed, so a newer file's preset degrades to an
 * even pace rather than to an error. Absent is `fallback`.
 */
export function easeFn(e: Ease | undefined | null, fallback = 'power1.out'): EaseFn {
  if (e === undefined || e === null) return EASES[fallback] ?? EASES.linear
  if (typeof e === 'string') return EASES[e] ?? EASES.linear
  if (isBezier(e)) {
    const key = e.join(',')
    let fn = bezierCache.get(key)
    if (!fn) {
      fn = cubicBezier(e[0], e[1], e[2], e[3])
      if (bezierCache.size > 256) bezierCache.clear()
      bezierCache.set(key, fn)
    }
    return fn
  }
  return EASES.linear
}
