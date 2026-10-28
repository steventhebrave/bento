// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
/**
 * The page's side of the code sandbox (FORK, the code layer). Everything that
 * touches a deck's code goes through here, and nothing here runs it: code runs
 * only inside sandbox frames (runtime.ts says what that frame can and cannot
 * do). This file starts frames, talks to them, times them out, and caches what
 * they answer.
 *
 *  - SCRIPT EFFECTS (Tier 2) are baked: `bakeSlide` evaluates every script
 *    effect of a slide at fixed samples, in list order, in ONE hidden frame,
 *    and `sampler` hands the engine the frames back synchronously (bake.ts).
 *  - CODE CANVASES (Tier 3) each get a VISIBLE frame laid over the element
 *    (CanvasRunner): the host says "click c, t seconds", the frame draws.
 *  - METADATA (`meta.params`, `meta.drives`, `meta.kind`) is read by loading
 *    the module in the hidden frame — the page never parses the code.
 *
 * Every request carries a deadline. A script that does not answer in time has
 * its worker terminated from outside its thread (the frame's `reset`) and is
 * reported; the effect then plays as its base and the canvas shows its poster.
 *
 * VIEWER SWITCH: `bento-code` in localStorage ('off' = never start a frame) —
 * a preference of whoever is looking, like reduced motion, never in the file.
 */

import type { BentoDoc, CanvasElement, Slide } from '../model'
import { lsGet, lsSet } from '../../../kernel/src/storage.ts'
import { sandboxSrcdoc } from './runtime'
import { bakeJobs, trackSampler, type Track } from './bake'
import type { ScriptSampler } from '../effects/index.ts'
import { planAnim } from '../animseq'

export const CODE_PREF = 'bento-code'
let codePref: boolean | null = null
const codeWatchers = new Set<(on: boolean) => void>()
/** Does this viewer let decks run their (sandboxed) code? Default yes. */
export const codeEnabled = (): boolean => {
  if (codePref === null) { try { codePref = lsGet(CODE_PREF) !== 'off' } catch { codePref = true } }
  return codePref
}
/** Flip the viewer switch (persisted); everything watching it re-evaluates. */
export const setCodeEnabled = (on: boolean) => {
  codePref = on
  try { lsSet(CODE_PREF, on ? 'on' : 'off') } catch { /* storage refused: this session only */ }
  for (const fn of [...codeWatchers]) fn(on)
}
export const onCodeSwitch = (fn: (on: boolean) => void): (() => void) => {
  codeWatchers.add(fn)
  return () => { codeWatchers.delete(fn) }
}
/** Does this deck carry code at all? (what the "runs code" chip shows for) */
export const deckHasCode = (doc: Pick<BentoDoc, 'scripts'>): boolean => !!doc.scripts && Object.keys(doc.scripts).length > 0

export interface ParamDecl {
  type?: 'number' | 'select' | 'boolean' | 'color' | 'text'
  min?: number
  max?: number
  step?: number
  default?: number | string | boolean
  options?: string[]
  label?: string
  unit?: string
}
export interface ScriptMeta {
  kind?: 'effect' | 'canvas'
  label?: string
  drives?: string[]
  params?: Record<string, ParamDecl>
  /** canvas: seconds of motion per click — a number for every click, or { "<click>": seconds } */
  duration?: number | Record<string, number>
}

/** Seconds of motion a canvas declares for a click (undefined = runs while shown). */
export function canvasDuration(meta: ScriptMeta | undefined, click: number): number | undefined {
  const d = meta?.duration
  if (typeof d === 'number' && Number.isFinite(d)) return d
  if (d && typeof d === 'object') { const v = (d as Record<string, number>)[String(click)]; if (typeof v === 'number' && Number.isFinite(v)) return v }
  return undefined
}

const DEADLINE = { load: 4000, bake: 3000, draw: 1500, poster: 3000, init: 4000 }

type Reply = Record<string, unknown> & { type: string; req?: number }

const frames = new Map<Window, SandboxFrame>()
let listening = false
function listen() {
  if (listening) return
  listening = true
  window.addEventListener('message', (ev) => {
    const f = ev.source ? frames.get(ev.source as Window) : undefined
    if (f) f.receive(ev.data as Reply)
  })
}

/** One sandboxed frame and its worker. */
export class SandboxFrame {
  readonly iframe: HTMLIFrameElement
  private ready: Promise<void>
  private markReady!: () => void
  private seq = 0
  private pending = new Map<number, { resolve: (r: Reply) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>()
  /** an unrequested failure (the worker died) */
  onFatal: ((message: string) => void) | null = null
  private dead = false

  constructor(mount: HTMLElement, visible: boolean) {
    listen()
    const f = document.createElement('iframe')
    // the boundary: scripts, nothing else — no same-origin, no forms, no popups, no navigation of the top
    f.setAttribute('sandbox', 'allow-scripts')
    f.setAttribute('referrerpolicy', 'no-referrer')
    f.setAttribute('aria-hidden', 'true')
    f.tabIndex = -1
    f.className = visible ? 'bento-code-frame' : 'bento-code-frame bento-code-hidden'
    // color-scheme:light matches the sandbox's own page, which declares none
    // (= light). The app's theme sets color-scheme on <html> (kernel
    // theme.ts) and the frame would inherit it; a frame whose scheme differs
    // from its page's gets an OPAQUE backdrop in the page's scheme (CSS Color
    // Adjust), so in the dark theme every live canvas sat on solid white.
    f.style.cssText = visible
      ? 'position:absolute;inset:0;width:100%;height:100%;border:0;background:transparent;color-scheme:light;pointer-events:none;display:block'
      : 'position:fixed;left:-10px;top:-10px;width:1px;height:1px;border:0;opacity:0;color-scheme:light;pointer-events:none'
    f.srcdoc = sandboxSrcdoc()
    this.iframe = f
    this.ready = new Promise((res) => { this.markReady = res })
    mount.appendChild(f)
    if (f.contentWindow) frames.set(f.contentWindow, this)
  }

  receive(m: Reply) {
    if (!m || typeof m !== 'object') return
    if (m.type === 'ready') { this.booted = true; this.markReady(); return }
    if (m.type === 'fatal') { this.onFatal?.(String(m.message ?? 'the script crashed')); return }
    const p = typeof m.req === 'number' ? this.pending.get(m.req) : undefined
    if (!p) return
    this.pending.delete(m.req!)
    clearTimeout(p.timer)
    if (m.type === 'error') p.reject(Object.assign(new Error(String(m.message ?? 'error')), { stack: String(m.stack ?? '') }))
    else p.resolve(m)
  }

  /** Send a request; resolves with the reply, rejects on error or deadline (which resets the worker). */
  async request(msg: Record<string, unknown>, deadline: number): Promise<Reply> {
    if (this.dead) throw new Error('sandbox closed')
    const req = ++this.seq
    // The deadline runs from NOW, not from "ready": a frame that never boots
    // (a host page whose CSP refuses the frame's own script — a srcdoc frame
    // inherits it) must fail the request, never leave it waiting forever.
    return new Promise<Reply>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(req)
        reject(new Error(this.booted ? `took longer than ${deadline / 1000}s — stopped` : 'the code sandbox could not start here'))
        if (this.booted) void this.reset()
      }, deadline)
      this.pending.set(req, { resolve, reject, timer })
      void this.ready.then(() => {
        if (this.pending.has(req)) this.iframe.contentWindow?.postMessage({ ...msg, req }, '*')
      })
    })
  }
  private booted = false

  /** Kill the worker and start a fresh one (the watchdog). Pending requests fail. */
  async reset() {
    for (const [, p] of this.pending) { clearTimeout(p.timer); p.reject(new Error('reset')) }
    this.pending.clear()
    await this.ready
    this.iframe.contentWindow?.postMessage({ type: 'reset', req: ++this.seq }, '*')
    this.onReset?.()
  }
  onReset: (() => void) | null = null

  destroy() {
    this.dead = true
    for (const [, p] of this.pending) { clearTimeout(p.timer); p.reject(new Error('sandbox closed')) }
    this.pending.clear()
    if (this.iframe.contentWindow) frames.delete(this.iframe.contentWindow)
    this.iframe.remove()
  }
}

/** Where an error in a module lands: "line N" from a blob stack, when there is one. */
export function errorLine(stack: string): number | null {
  const m = stack.match(/blob:[^\s)]*?:(\d+):(\d+)/)
  return m ? Number(m[1]) : null
}

const hashOf = (s: string) => {
  let h = 2166136261 >>> 0
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0 }
  return `${h.toString(36)}:${s.length}`
}

export class CodeHost {
  /** baked script-effect tracks, by bake.trackKey (slide + effect) */
  readonly tracks = new Map<string, Track>()
  private samplers = new Map<string, ScriptSampler>()
  /** script name → the last error it raised (load, bake or draw) */
  readonly errors = new Map<string, string>()
  private metas = new Map<string, { hash: string; meta: ScriptMeta | null }>()
  private loading = new Set<string>()
  private frame: SandboxFrame | null = null
  private listeners = new Set<() => void>()
  private baking: Promise<void> = Promise.resolve()

  constructor(readonly doc: () => BentoDoc) {}

  /** Is code to run at all (viewer switch on, and the deck has some)? */
  get active(): boolean {
    return codeEnabled() && deckHasCode(this.doc())
  }

  /** Load every script's metadata (durations, params) — a show calls this before it starts its clocks. */
  async preload(): Promise<void> {
    if (!this.active) return
    const names = Object.keys(this.doc().scripts ?? {})
    for (const n of names) this.metaOf(n)
    await Promise.all([...this.inflight.values()])
  }
  private inflight = new Map<string, Promise<void>>()

  /** The engine's view of one slide's baked motion; undefined while code is off. */
  scriptFor(slide: Pick<Slide, 'id'>): ScriptSampler | undefined {
    if (!this.active) return undefined
    let s = this.samplers.get(slide.id)
    if (!s) { s = trackSampler(this.tracks, slide.id); this.samplers.set(slide.id, s) }
    return s
  }

  on(fn: () => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }
  private emit() { for (const fn of [...this.listeners]) fn() }

  private hidden(): SandboxFrame {
    if (!this.frame) {
      this.frame = new SandboxFrame(document.body, false)
      this.frame.onFatal = (msg) => { this.errors.set('(sandbox)', msg); this.emit() }
    }
    return this.frame
  }

  /** The script's declared metadata, or undefined while it loads (an event follows). */
  metaOf(name: string): ScriptMeta | undefined {
    const src = this.doc().scripts?.[name]?.src
    if (!src) return undefined
    const hash = hashOf(src)
    const hit = this.metas.get(name)
    if (hit && hit.hash === hash) return hit.meta ?? undefined
    if (this.active && !this.loading.has(name + hash)) {
      this.loading.add(name + hash)
      const p = this.hidden().request({ type: 'load', name, src }, DEADLINE.load).then((r) => {
        this.metas.set(name, { hash, meta: (r.meta ?? {}) as ScriptMeta })
        if (!r.hasDefault) this.errors.set(name, 'needs `export default function …`')
        else this.errors.delete(name)
      }, (err: Error) => {
        this.metas.set(name, { hash, meta: null })
        const line = errorLine(err.stack ?? '')
        this.errors.set(name, line ? `line ${line}: ${err.message}` : err.message)
      }).finally(() => { this.loading.delete(name + hash); this.inflight.delete(name); this.emit() })
      this.inflight.set(name, p)
    }
    return undefined
  }

  /**
   * Load a source that is not (yet) in the deck, in the sandbox, and report
   * what it declares or where it fails — the script editor's Check.
   */
  async inspect(src: string): Promise<{ meta: ScriptMeta | null; error: string | null }> {
    if (!codeEnabled()) return { meta: null, error: 'deck code is switched off in this browser' }
    try {
      const r = await this.hidden().request({ type: 'load', name: '(check)', src }, DEADLINE.load)
      return { meta: (r.meta ?? {}) as ScriptMeta, error: r.hasDefault ? null : 'needs `export default function …`' }
    } catch (err) {
      const line = errorLine((err as Error).stack ?? '')
      return { meta: null, error: line ? `line ${line}: ${(err as Error).message}` : (err as Error).message }
    }
  }

  /**
   * Bake every script effect on a slide, in list order (an earlier script is
   * part of a later one's base). Skips effects whose inputs have not changed.
   * Serialized: bakes never overlap.
   */
  bakeSlide(slide: Pick<Slide, 'id' | 'anim' | 'elements'>): Promise<void> {
    this.baking = this.baking.then(() => this.bakeNow(slide)).catch(() => {})
    return this.baking
  }

  private async bakeNow(slide: Pick<Slide, 'id' | 'anim' | 'elements'>) {
    if (!this.active || !Array.isArray(slide.anim) || !slide.anim.some((f) => f.type === 'script')) return
    const doc = this.doc()
    const plan = planAnim(slide.anim)
    let changed = false
    // one job at a time: each later job's base needs the earlier tracks
    for (let guard = 0; guard < 256; guard++) {
      const next = bakeJobs(slide, doc, this.tracks, plan).find((j) => this.tracks.get(j.track)?.key !== j.key)
      if (!next) break
      try {
        const r = await this.hidden().request({
          type: 'bake', name: next.name, src: next.src, params: next.params, duration: next.duration,
          click: next.click, el: next.el, slide: next.slide, seed: next.seed, samples: next.samples,
        }, DEADLINE.bake)
        this.tracks.set(next.track, { key: next.key, duration: next.duration, frames: (r.frames ?? []) as Track['frames'] })
        this.errors.delete(next.name)
      } catch (err) {
        // remember the failure under this key so it is not retried until something changes
        this.tracks.set(next.track, { key: next.key, duration: next.duration, frames: [] })
        this.errors.set(next.name, (err as Error).message)
      }
      changed = true
    }
    if (changed) this.emit()
  }

  /** Bake a whole deck (a show starting). */
  async bakeDeck(doc: BentoDoc) {
    for (const s of doc.slides) await this.bakeSlide(s)
  }

  /** Forget everything baked (the switch went off, or the deck was replaced). */
  clear() {
    this.tracks.clear()
    this.metas.clear()
    this.errors.clear()
    this.frame?.destroy()
    this.frame = null
    this.emit()
  }
}

/**
 * A live code canvas: a visible sandbox frame over a canvas element's node.
 * Draw requests are coalesced — one in flight, the newest waiting — so a
 * scrub or a 60 fps clock never queues work the script cannot keep up with.
 */
export class CanvasRunner {
  private frame: SandboxFrame
  private inited: Promise<void> | null = null
  private busy = false
  private next: { click: number; t: number } | null = null
  /** fired after each frame is drawn (the poster underneath can hide) */
  onDrawn: (() => void) | null = null

  constructor(private host: CodeHost, node: HTMLElement, private el: () => CanvasElement | undefined, private dpr: () => number = () => Math.min(3, window.devicePixelRatio || 1)) {
    if (getComputedStyle(node).position === 'static') node.style.position = 'relative'
    this.frame = new SandboxFrame(node, true)
    this.frame.onReset = () => { this.inited = null }
    this.frame.onFatal = (msg) => { const e = this.el(); if (e) this.host.errors.set(e.script, msg) }
  }

  private init(): Promise<void> {
    if (!this.inited) this.inited = this.frame.request({ type: 'canvas-init' }, DEADLINE.init).then(() => undefined)
    return this.inited
  }

  private message(type: 'draw' | 'poster', click: number, t: number): Record<string, unknown> | null {
    const el = this.el()
    const doc = this.host.doc()
    const src = el ? doc.scripts?.[el.script]?.src : undefined
    if (!el || !src) return null
    return { type, name: el.script, src, params: el.params ?? {}, click, t, width: el.w, height: el.h, dpr: this.dpr(), seed: el.id }
  }

  /** Show the drawing at (click, t). */
  draw(click: number, t: number) {
    this.next = { click, t }
    if (!this.busy) void this.pump()
  }

  private async pump() {
    this.busy = true
    try {
      while (this.next) {
        const { click, t } = this.next
        this.next = null
        const msg = this.message('draw', click, t)
        if (!msg) break
        try {
          await this.init()
          await this.frame.request(msg, DEADLINE.draw)
          this.onDrawn?.()
        } catch (err) {
          const el = this.el()
          if (el && (err as Error).message !== 'reset') this.host.errors.set(el.script, (err as Error).message)
          break
        }
      }
    } finally { this.busy = false }
  }

  /** Draw at (click, t) and return the picture as a PNG data URI (null on failure). */
  async poster(click: number, t: number): Promise<string | null> {
    const msg = this.message('poster', click, t)
    if (!msg) return null
    try {
      await this.init()
      const r = await this.frame.request(msg, DEADLINE.poster)
      return typeof r.url === 'string' && r.url.startsWith('data:image/png') ? r.url : null
    } catch { return null }
  }

  destroy() { this.frame.destroy() }
}
