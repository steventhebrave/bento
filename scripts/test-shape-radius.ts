#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// A rect's corner radius never stretches (kernel/src/shape.ts).
//
//   node scripts/test-shape-radius.ts
//
// THE BUG THIS GUARDS. A rect's radius was written straight to `rx`. SVG
// takes a missing ry to equal rx, then clamps each to half of ITS OWN side —
// so a radius bigger than half the shorter side came out as an ellipse: on a
// 4 px wide rod with the default radius 12, every corner was 2 px wide and
// 12 px tall, and the rod's rounded end was a stretched point.
//
// WHAT THIS PROVES, with a few lines of DOM stand-in (shapeSvg only creates
// nodes and sets attributes):
//   1. a radius bigger than half the shorter side is clamped to it, either way round
//   2. a radius that fits is written unchanged (most rects: nothing changes)
//   3. a stroke shrinks the rect, and the clamp follows it
//   4. no radius, zero or negative writes no rx at all

const FAILS: string[] = []
const check = (name: string, cond: boolean, detail?: unknown) => {
  if (!cond) FAILS.push(name)
  console.log(`${cond ? '  ok  ' : ' FAIL '} ${name}${!cond && detail !== undefined ? '  → ' + JSON.stringify(detail) : ''}`)
}

class Node {
  attrs: Record<string, string> = {}
  children: Node[] = []
  style = { cssText: '' }
  tag: string
  constructor(tag: string) { this.tag = tag }
  setAttribute(k: string, v: string) { this.attrs[k] = v }
  getAttribute(k: string) { return k in this.attrs ? this.attrs[k] : null }
  appendChild(c: Node) { this.children.push(c); return c }
  querySelector(tag: string): Node | null { return this.children.find((c) => c.tag === tag) ?? null }
}
;(globalThis as Record<string, unknown>).document = { createElementNS: (_ns: string, tag: string) => new Node(tag) }

const { shapeSvg } = await import('../kernel/src/shape.ts')
const rect = (w: number, h: number, radius: number | undefined, strokeWidth = 0) => {
  const svg = shapeSvg({ shape: 'rect', w, h, fill: '#000', stroke: strokeWidth ? '#f00' : 'transparent', strokeWidth, radius } as never) as unknown as Node
  return svg.children.find((c) => c.tag === 'rect')!
}
const rx = (w: number, h: number, radius: number | undefined, sw = 0) => rect(w, h, radius, sw).getAttribute('rx')

check('a 4 px wide rod with radius 12: 2, a round end (was 12 — a stretched point)', rx(4, 300, 12) === '2', rx(4, 300, 12))
check('the same rod lying down: 2', rx(300, 4, 12) === '2', rx(300, 4, 12))
check('a square with a huge radius: a circle (half its side)', rx(40, 40, 999) === '20', rx(40, 40, 999))
check('a radius that fits is written as it is', rx(104, 220, 12) === '12' && rx(372, 88, 12) === '12', [rx(104, 220, 12), rx(372, 88, 12)])
check('exactly half the shorter side is kept', rx(24, 100, 12) === '12', rx(24, 100, 12))
check('a stroke shrinks the rect, and the clamp follows (20 px, stroke 4 → 8)', rx(20, 20, 50, 4) === '8', rx(20, 20, 50, 4))
check('no radius, 0 or negative: no rx', rx(100, 100, undefined) === null && rx(100, 100, 0) === null && rx(100, 100, -5) === null,
  [rx(100, 100, undefined), rx(100, 100, 0), rx(100, 100, -5)])
check('ry is never written: SVG takes it equal to rx, so corners stay circular', rect(4, 300, 12).getAttribute('ry') === null)

console.log(FAILS.length ? `\n${FAILS.length} FAILED` : '\nall checks passed')
process.exit(FAILS.length ? 1 : 0)
