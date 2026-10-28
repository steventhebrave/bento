// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
/**
 * An element's anchor — the point it pivots on (FORK; model.ts ElementBase
 * `anchor`). Pure geometry, no DOM: the spin effect, the editor's rotate and
 * resize, and the on-canvas anchor handle all go through these.
 *
 * The model never changes meaning: an element is a box (x, y, w, h) rotated
 * by `rotation` about the box's CENTRE. Turning or resizing "about the
 * anchor" is therefore always the same rotation or size plus a move of the
 * box that keeps the anchor's point on the slide where it was.
 */

export type Anchor = [number, number]
export interface Pt { x: number; y: number }
interface Box { x: number; y: number; w: number; h: number }

const CENTRE: Anchor = [0.5, 0.5]
const RAD = Math.PI / 180

const valid = (a: unknown): a is Anchor =>
  Array.isArray(a) && a.length === 2 && a.every((v) => typeof v === 'number' && Number.isFinite(v))

/** The element's anchor as fractions of its box; the centre when it has none. */
export const anchorOf = (el: { anchor?: unknown }): Anchor => (valid(el.anchor) ? el.anchor : CENTRE)

/** Does the element pivot anywhere but its centre? */
export const hasAnchor = (el: { anchor?: unknown }): boolean => {
  const a = anchorOf(el)
  return a[0] !== 0.5 || a[1] !== 0.5
}

/**
 * Rotate (x, y) by `deg` degrees (clockwise on screen, y down). No angle is
 * no turn: `rotation` is optional in a file (compact decks leave it out, the
 * renderer reads it as 0), and cos(undefined) would put every point at NaN.
 */
const rot = (x: number, y: number, deg: number | undefined): Pt => {
  const r = Number.isFinite(deg) ? (deg as number) * RAD : 0
  const c = Math.cos(r)
  const s = Math.sin(r)
  return { x: x * c - y * s, y: x * s + y * c }
}

/** The anchor's offset from the box centre, in the element's own frame (unrotated, unscaled). */
const local = (w: number, h: number, a: Anchor): Pt => ({ x: (a[0] - 0.5) * w, y: (a[1] - 0.5) * h })

/** Where the anchor sits on the slide, for a box rotated by `rotation` (and scaled by `scale`) about its centre. */
export function anchorPoint(box: Box, rotation: number | undefined, a: Anchor, scale = 1): Pt {
  const o = rot(local(box.w, box.h, a).x * scale, local(box.w, box.h, a).y * scale, rotation)
  return { x: box.x + box.w / 2 + o.x, y: box.y + box.h / 2 + o.y }
}

/** The box's top-left that puts the anchor of a w×h box, rotated by `rotation`, on the point `p`. */
export function boxForAnchor(p: Pt, w: number, h: number, rotation: number | undefined, a: Anchor): Pt {
  const o = rot(local(w, h, a).x, local(w, h, a).y, rotation)
  return { x: p.x - o.x - w / 2, y: p.y - o.y - h / 2 }
}

/**
 * How far the box's centre moves when an element at `rotation` (scaled by
 * `scale`) turns a further `deg` degrees about its anchor instead of its
 * centre: the anchor stays put, so the centre swings around it.
 */
export function pivotOffset(w: number, h: number, a: Anchor, rotation: number | undefined, scale: number, deg: number): Pt {
  if (a[0] === 0.5 && a[1] === 0.5) return { x: 0, y: 0 }
  const l = local(w, h, a)
  const p = rot(l.x * scale, l.y * scale, rotation) // the anchor, from the centre, now
  const q = rot(p.x, p.y, deg) // …and after the turn, had the centre stayed put
  return { x: p.x - q.x, y: p.y - q.y }
}

/** The anchor (fractions of the box) of the slide point `p`, for a box rotated by `rotation` about its centre. */
export function anchorAt(box: Box, rotation: number | undefined, p: Pt): Anchor {
  const c = { x: box.x + box.w / 2, y: box.y + box.h / 2 }
  const l = rot(p.x - c.x, p.y - c.y, -(rotation ?? 0))
  return [0.5 + l.x / Math.max(box.w, 1e-6), 0.5 + l.y / Math.max(box.h, 1e-6)]
}
