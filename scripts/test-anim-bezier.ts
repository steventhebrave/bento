#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Easing curves: the named presets the engine always had, and CSS-style
// cubic-bezier arrays (kernel/src/ease.ts).
//
//   node scripts/test-anim-bezier.ts
//
// WHAT THIS PROVES.
//   1. Every name that existed before cubic-bezier support returns exactly the
//      same values — a deck's existing animation must not change pace.
//   2. A bezier lands where a browser lands the same numbers. The reference
//      values are the y a CSS engine computes for `cubic-bezier()` at the
//      given x (derived independently by dense sampling of the parametric
//      curve here, not by the solver under test).
//   3. Endpoints are exact, overshoot survives (y outside 0..1), x control
//      points outside 0..1 are clamped rather than producing a non-function,
//      and an unknown name or a malformed array degrades to linear.
//   4. A tween given an array eases with it (the engine accepts the new type).

import { cubicBezier, easeFn, EASES, isBezier, anim } from '../kernel/src/anim.ts'

const FAILS: string[] = []
const check = (name: string, cond: boolean) => {
  if (!cond) FAILS.push(name)
  console.log(`${cond ? '  ok  ' : ' FAIL '} ${name}`)
}
const near = (a: number, b: number, eps = 1e-4) => Math.abs(a - b) <= eps

// --- 1. the old names, unchanged ---------------------------------------------
const pow = (n: number) => ({
  in: (t: number) => t ** n,
  out: (t: number) => 1 - (1 - t) ** n,
  inOut: (t: number) => (t < 0.5 ? (2 * t) ** n / 2 : 1 - (2 - 2 * t) ** n / 2),
})
const OLD: Record<string, (t: number) => number> = {
  none: (t) => t, linear: (t) => t,
  'power1.in': pow(2).in, 'power1.out': pow(2).out, 'power1.inOut': pow(2).inOut,
  'power2.in': pow(3).in, 'power2.out': pow(3).out, 'power2.inOut': pow(3).inOut,
  'power3.in': pow(4).in, 'power3.out': pow(4).out, 'power3.inOut': pow(4).inOut,
  'sine.in': (t) => 1 - Math.cos((t * Math.PI) / 2),
  'sine.out': (t) => Math.sin((t * Math.PI) / 2),
  'sine.inOut': (t) => -(Math.cos(Math.PI * t) - 1) / 2,
}
for (const [name, fn] of Object.entries(OLD)) {
  let same = true
  for (let i = 0; i <= 100; i++) if (EASES[name](i / 100) !== fn(i / 100)) same = false
  check(`old preset ${name} is unchanged`, same && easeFn(name)(0.37) === fn(0.37))
}
check('absent ease is the engine default (power1.out)', easeFn(undefined)(0.3) === OLD['power1.out'](0.3))

// --- 2. bezier against an independent reference --------------------------------
/** y at x by brute-force sampling of the parametric curve (no Newton). */
function reference(x1: number, y1: number, x2: number, y2: number, x: number): number {
  const bx = (t: number) => 3 * (1 - t) ** 2 * t * x1 + 3 * (1 - t) * t * t * x2 + t ** 3
  const by = (t: number) => 3 * (1 - t) ** 2 * t * y1 + 3 * (1 - t) * t * t * y2 + t ** 3
  let lo = 0, hi = 1
  for (let i = 0; i < 200; i++) { const m = (lo + hi) / 2; if (bx(m) < x) lo = m; else hi = m }
  return by((lo + hi) / 2)
}
const curves: Array<[number, number, number, number]> = [
  [0.25, 0.1, 0.25, 1],   // CSS `ease`
  [0.42, 0, 1, 1],        // ease-in
  [0, 0, 0.58, 1],        // ease-out
  [0.42, 0, 0.58, 1],     // ease-in-out
  [0.7, 0, 0.2, 1],       // a steep in-out like a morph wants
  [0.34, 1.56, 0.64, 1],  // overshoot
  [0.9, 0.05, 0.1, 0.95], // nearly flat slope in the middle (Newton struggles)
  [0, 0, 1, 1],           // linear
]
for (const c of curves) {
  const fn = cubicBezier(...c)
  let worst = 0
  for (let i = 0; i <= 200; i++) {
    const x = i / 200
    worst = Math.max(worst, Math.abs(fn(x) - reference(...c, x)))
  }
  check(`cubic-bezier(${c.join(', ')}) matches the reference (worst ${worst.toExponential(1)})`, worst < 2e-4)
}
// A known value a browser reports: CSS `ease` at 50% time is ~0.8024.
check('CSS ease at x=0.5 ≈ 0.8024 (browser value)', near(cubicBezier(0.25, 0.1, 0.25, 1)(0.5), 0.8024, 5e-4))
check('ease-in-out is symmetric', near(cubicBezier(0.42, 0, 0.58, 1)(0.3) + cubicBezier(0.42, 0, 0.58, 1)(0.7), 1, 1e-5))

// --- 3. edges ---------------------------------------------------------------
const back = cubicBezier(0.34, 1.56, 0.64, 1)
check('endpoints exact: f(0)=0, f(1)=1', back(0) === 0 && back(1) === 1 && back(-1) === 0 && back(2) === 1)
let peak = 0
for (let i = 0; i <= 100; i++) peak = Math.max(peak, back(i / 100))
check(`overshoot survives (peak ${peak.toFixed(3)} > 1)`, peak > 1.05)
const wild = cubicBezier(-2, 0.3, 3, 0.7)
let monotone = true
for (let i = 1; i <= 100; i++) if (!Number.isFinite(wild(i / 100))) monotone = false
check('x control points outside 0..1 are clamped (finite everywhere)', monotone && near(wild(0.5), cubicBezier(0, 0.3, 1, 0.7)(0.5)))
check('unknown name degrades to linear', easeFn('bounce.out')(0.3) === 0.3)
check('malformed array degrades to linear', easeFn([0.1, 0.2] as unknown as number[])(0.3) === 0.3)
check('isBezier accepts four finite numbers only', isBezier([0, 0, 1, 1]) && !isBezier([0, 0, 1]) && !isBezier([0, NaN, 1, 1]) && !isBezier('ease'))
check('CSS keyword presets are names too', near(easeFn('ease')(0.5), 0.8024, 5e-4) && near(easeFn('ease-in-out')(0.5), 0.5, 1e-6))

// --- 4. a tween eases with an array -----------------------------------------
const g: any = globalThis
g.requestAnimationFrame = () => 0
g.Element ??= class {}
anim.setManual(true)
const state = { v: 0 }
anim.to(state, { v: 1, duration: 1, ease: [0.42, 0, 1, 1] })
anim.tick(0.5)
check(`tween with a bezier array eases with it (v=${state.v.toFixed(4)})`, near(state.v, cubicBezier(0.42, 0, 1, 1)(0.5), 1e-9))
anim.tick(0.6)
check('tween lands on 1', state.v === 1)

if (FAILS.length) {
  console.log(`\n${FAILS.length} check(s) FAILED`)
  process.exit(1)
}
console.log('\nall bezier checks passed')
