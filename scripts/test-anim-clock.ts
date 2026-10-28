#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// The animation clock never runs backwards (kernel/src/anim.ts).
//
//   node scripts/test-anim-clock.ts
//
// THE BUG THIS GUARDS. When no tween is running, starting one records
// `last = performance.now()` and asks for an animation frame. The frame's
// callback is handed the time the FRAME began — which, for a keypress handled
// after the frame started (Chrome dispatches discrete input inside the frame),
// is EARLIER than `last`. The first tick's dt was therefore negative; elapsed
// went below zero, floor(elapsed / duration) was −1, and the wrapped progress
// came out ≈ 0.99: the first painted frame of an animation showed its END
// state, and the next frame jumped back to the start. Measured in a real
// show: a move to x = 700 painted 671 on one frame, then 101.
//
// WHAT THIS PROVES, with requestAnimationFrame and performance.now stubbed:
//   1. a frame timestamped BEFORE the tween started leaves it at its start
//   2. the clock then advances normally from there
//   3. a negative manual tick is a no-op, not a wrap to the end
//   4. a tween with a delay is unaffected either way

const FAILS: string[] = []
const check = (name: string, cond: boolean, detail?: unknown) => {
  if (!cond) FAILS.push(name)
  console.log(`${cond ? '  ok  ' : ' FAIL '} ${name}${!cond && detail !== undefined ? '  → ' + JSON.stringify(detail) : ''}`)
}
const near = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) <= eps

// a controllable clock: performance.now() reads `clock`; frames are queued and run by hand
let clock = 1000
const frames: Array<(now: number) => void> = []
Object.defineProperty(globalThis.performance, 'now', { value: () => clock, configurable: true })
;(globalThis as Record<string, unknown>).Element ??= class {} // node has no DOM; these tweens animate plain objects
;(globalThis as Record<string, unknown>).requestAnimationFrame = (cb: (now: number) => void) => { frames.push(cb); return frames.length }
const frame = (now: number) => { const q = frames.splice(0); for (const cb of q) cb(now) }

const { anim } = await import('../kernel/src/anim.ts')

console.log('a frame stamped before the tween started')
{
  const s = { p: 0 }
  const seen: number[] = []
  clock = 1000.004 // the keypress is handled 4 ms into a frame…
  anim.to(s, { p: 1, duration: 1, ease: 'linear', onUpdate: () => seen.push(s.p) })
  frame(1000) // …whose callback is stamped with the frame's start
  check(`the first frame paints the start, not the end (p = ${seen[0]?.toFixed(4)})`, seen.length === 1 && near(seen[0], 0))
  frame(1016)
  frame(1032)
  check(`then it advances from there (p = ${seen.at(-1)?.toFixed(4)} after two 16 ms frames)`, near(seen.at(-1)!, 0.032, 1e-3))
  for (let t = 1048; t <= 2200; t += 16) frame(t)
  check('and it completes', near(s.p, 1))
}

console.log('\nmanual ticks')
{
  anim.setManual(true)
  const s = { p: 0 }
  const tw = anim.to(s, { p: 1, duration: 1, ease: 'linear' })
  anim.tick(-0.01)
  check(`a negative tick leaves a fresh tween at its start (p = ${s.p.toFixed(4)})`, near(s.p, 0))
  anim.tick(0.25)
  check('a positive one advances it', near(s.p, 0.25))
  anim.tick(-0.1)
  check(`a negative tick never runs it backwards or wraps it (p = ${s.p.toFixed(4)})`, near(s.p, 0.25))
  tw.kill()
  const d = { p: 0 }
  anim.to(d, { p: 1, duration: 1, delay: 0.5, ease: 'linear' })
  anim.tick(-0.01)
  anim.tick(0.75)
  check(`a delayed tween still waits its delay (p = ${d.p.toFixed(4)} at 0.75 s of 0.5 + 1)`, near(d.p, 0.25))
  anim.setManual(false)
}

console.log(`\n${FAILS.length ? `${FAILS.length} FAILED` : 'all checks passed'}`)
process.exit(FAILS.length ? 1 : 0)
