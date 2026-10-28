// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
/**
 * The editor's side of the deck's code (FORK, the code layer).
 *
 *  - keeps script effects BAKED for the slide being edited, so the canvas
 *    preview, the pane's scrubber and the show all read real motion;
 *  - keeps code canvases' POSTERS current: a canvas whose script, parameters,
 *    size or poster moment changed this session gets a fresh still, captured
 *    in the sandbox and written in place (no undo step — it is derived, like
 *    a linked chart's data). A poster that arrived with the file is trusted;
 *  - shows the "this deck runs code" chip (one switch for this browser, and
 *    the way into the code);
 *  - the Deck code dialog: edit, create, rename and delete scripts;
 *  - live canvases while the animation pane previews a slide;
 *  - parameter controls generated from a script's `meta.params`.
 *
 * Nothing here runs a deck's code: code/host.ts talks to the sandbox.
 */

import type { Store } from '../store'
import type { AnimEffect, BentoDoc, CanvasElement, Slide } from '../model'
import { internAsset, uid } from '../model'
import { t } from '../i18n'
import { CanvasRunner, CodeHost, canvasDuration, codeEnabled, deckHasCode, onCodeSwitch, setCodeEnabled, type ParamDecl, type ScriptMeta } from '../code/host'
import { CANVAS_TEMPLATE, EFFECT_TEMPLATE, freshScriptName } from '../code/templates'
import { SCRIPT_NAME } from '../untrusted'

export interface CodeUIHost {
  toast(msg: string): void
  /** the editing canvas's slide surface (`.ed-stage-scale .bento-slide`) */
  surface(): HTMLElement | null
  /** something the panels draw from changed (a script's metadata loaded, an error) */
  codeChanged(): void
}

type Kind = 'effect' | 'canvas'

const hashOf = (s: string) => {
  let h = 2166136261 >>> 0
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0 }
  return h.toString(36)
}

/** A canvas's poster inputs: when these change, the still is stale. */
const posterInputs = (doc: BentoDoc, el: CanvasElement): string =>
  hashOf(JSON.stringify([el.script, doc.scripts?.[el.script]?.src ?? '', el.params ?? {}, Math.round(el.w), Math.round(el.h), el.posterAt ?? null]))

/** The script names an effect / canvas references, deck-wide. */
export function scriptUses(doc: BentoDoc, name: string): { effects: number; canvases: number } {
  let effects = 0
  let canvases = 0
  for (const s of [...doc.slides, ...(doc.layouts ?? [])]) {
    for (const fx of s.anim ?? []) if (fx?.type === 'script' && fx.script === name) effects++
    for (const el of s.elements) if (el.type === 'canvas' && el.script === name) canvases++
  }
  return { effects, canvases }
}

export class EditorCode {
  readonly host: CodeHost
  private timer: ReturnType<typeof setTimeout> | undefined
  /** `${slideId}\u001f${elId}` → the poster inputs its still was made from */
  private posterKeys = new Map<string, string>()
  private capturing = new Set<string>()
  /** captures run one at a time: each is a sandbox frame of its own */
  private captureQueue: Promise<unknown> = Promise.resolve()
  /** the document whose stills have been taken as given (see refreshPosters) */
  private seededFor: BentoDoc | null = null
  private posterMount: HTMLElement | null = null
  private previewRunners = new Map<string, { node: HTMLElement; runner: CanvasRunner }>()
  private metaSig = ''
  readonly chip: HTMLButtonElement

  constructor(private store: Store, private ui: CodeUIHost, signal: AbortSignal) {
    this.host = new CodeHost(() => store.doc)
    this.chip = document.createElement('button')
    this.chip.className = 'ed-btn ed-codechip'
    this.chip.addEventListener('click', () => this.openChipMenu())
    const offs = [
      store.on('doc', () => this.schedule()),
      store.on('current', () => { this.stopPreview(); this.schedule(0) }),
      this.host.on(() => this.onHost()),
      onCodeSwitch((on) => {
        // off means NOTHING runs: no live canvas, no bake frame left idling
        if (!on) { this.stopPreview(); this.host.clear() }
        this.syncChip()
        this.schedule(0)
        this.ui.codeChanged()
      }),
    ]
    signal.addEventListener('abort', () => {
      for (const off of offs) off()
      clearTimeout(this.timer)
      this.stopPreview()
      this.posterMount?.remove()
      this.host.clear()
    })
    this.syncChip()
    this.schedule(0)
  }

  // ——— upkeep ———————————————————————————————————————————————————————————

  private schedule(ms = 250) {
    clearTimeout(this.timer)
    this.timer = setTimeout(() => this.upkeep(), ms)
  }

  private upkeep() {
    this.syncChip()
    if (!this.host.active) return
    for (const name of Object.keys(this.store.doc.scripts ?? {})) this.host.metaOf(name)
    void this.host.bakeSlide(this.store.slide)
    this.refreshPosters()
  }

  private onHost() {
    // repaint only what reads code: the pane and panel follow metadata
    // (labels, parameters, errors); a landed bake shows through the preview
    const doc = this.store.doc
    const sig = Object.keys(doc.scripts ?? {}).map((n) => `${n}:${JSON.stringify(this.host.metaOf(n) ?? null)}:${this.host.errors.get(n) ?? ''}`).join('|')
      + `|${this.host.errors.get('(sandbox)') ?? ''}`
    if (sig !== this.metaSig) {
      this.metaSig = sig
      this.ui.codeChanged()
    }
  }

  private syncChip() {
    const has = deckHasCode(this.store.doc)
    this.chip.hidden = !has
    if (!has) return
    const on = codeEnabled()
    this.chip.classList.toggle('off', !on)
    this.chip.textContent = on ? `ƒ ${t('Code')}` : `ƒ ${t('Code off')}`
    this.chip.title = on
      ? t('This deck runs code, in a sandbox: no network, no storage, no access to this page or your files. Click for the switch and the code.')
      : t('Deck code is off in this browser: canvases show their still pictures and script effects play without their scripted motion.')
  }

  // ——— posters ——————————————————————————————————————————————————————————

  /**
   * Every canvas in the deck whose still no longer matches its inputs gets a
   * new one. A document that ARRIVES (a load, an undo, a replace) brings stills
   * that match its own inputs, so those are taken as given — once, for every
   * slide, before anything is compared; after that an input change anywhere
   * (a script edited in the dialog, a parameter, a peer's edit) re-captures,
   * whether or not that slide has been looked at.
   */
  private refreshPosters() {
    if (this.store.readOnly) return
    const doc = this.store.doc
    const all = [...doc.slides, ...(doc.layouts ?? [])]
    if (this.seededFor !== doc) {
      this.seededFor = doc
      for (const slide of all) for (const el of slide.elements) {
        if (el.type === 'canvas' && el.poster) this.posterKeys.set(`${slide.id}\u001f${el.id}`, posterInputs(doc, el))
      }
    }
    // slides only: a layout's canvas gets its still when a slide is made from it
    for (const slide of doc.slides) for (const el of slide.elements) {
      if (el.type !== 'canvas' || !doc.scripts?.[el.script]) continue
      const key = `${slide.id}\u001f${el.id}`
      const inputs = posterInputs(doc, el)
      if (this.posterKeys.get(key) === inputs || this.capturing.has(key)) continue
      this.capturing.add(key)
      const slideId = slide.id
      const elId = el.id
      this.captureQueue = this.captureQueue.then(() => this.capture(slideId, elId, inputs)).catch(() => false)
    }
  }

  /** Capture one canvas's still now (also the panel's "Capture again"). */
  async capture(slideId: string, elId: string, inputs?: string): Promise<boolean> {
    const key = `${slideId}\u001f${elId}`
    this.capturing.add(key)
    let box: HTMLElement | null = null
    let runner: CanvasRunner | null = null
    try {
      const find = () => this.store.slideById(slideId)?.elements.find((e) => e.id === elId) as CanvasElement | undefined
      const el = find()
      if (!el || el.type !== 'canvas' || !this.host.active || this.store.readOnly) return false
      const want = inputs ?? posterInputs(this.store.doc, el)
      if (!this.posterMount) {
        this.posterMount = document.createElement('div')
        this.posterMount.className = 'ed-code-postermount'
        this.posterMount.setAttribute('aria-hidden', 'true')
        this.posterMount.style.cssText = 'position:fixed;left:-10000px;top:0;pointer-events:none;opacity:0'
        document.body.appendChild(this.posterMount)
      }
      box = document.createElement('div')
      box.style.cssText = `position:relative;width:${Math.max(1, Math.round(el.w))}px;height:${Math.max(1, Math.round(el.h))}px`
      this.posterMount.appendChild(box)
      runner = new CanvasRunner(this.host, box, find, () => 1)
      const at = el.posterAt ?? { click: 0, t: 0 }
      const url = await runner.poster(at.click, at.t)
      const now = find()
      // the canvas changed while its still was being made: the next upkeep takes it
      if (!now || posterInputs(this.store.doc, now) !== want || this.store.readOnly) return false
      if (!this.host.active) return false // switched off meanwhile: retried when it is back on
      // a script that cannot draw is not retried until something about it changes
      this.posterKeys.set(key, want)
      if (!url) return false
      now.poster = internAsset(this.store.doc, url)
      this.store.touch()
      return true
    } finally {
      runner?.destroy()
      box?.remove()
      this.capturing.delete(key)
    }
  }

  // ——— live canvases in the editor preview ——————————————————————————————

  /** Draw every canvas on the editing surface at (click, t) — the pane's preview. */
  preview(slide: Slide, click: number, t: number) {
    const surface = this.ui.surface()
    if (!surface || !this.host.active) return
    for (const el of slide.elements) {
      if (el.type !== 'canvas') continue
      let live = this.previewRunners.get(el.id)
      const node = surface.querySelector<HTMLElement>(`[data-el-id="${CSS.escape(el.id)}"]`)
      if (!node) continue
      if (!live || live.node !== node) {
        live?.runner.destroy()
        const id = el.id
        const runner = new CanvasRunner(this.host, node, () => this.store.slide.elements.find((e) => e.id === id) as CanvasElement | undefined)
        runner.onDrawn = () => node.classList.add('bento-canvas-live')
        live = { node, runner }
        this.previewRunners.set(el.id, live)
      }
      const d = canvasDuration(this.meta(el.script), click)
      live.runner.draw(click, d === undefined ? t : Math.min(t, d))
    }
  }

  stopPreview() {
    for (const { node, runner } of this.previewRunners.values()) {
      runner.destroy()
      node.classList.remove('bento-canvas-live')
    }
    this.previewRunners.clear()
  }

  // ——— reading the deck's code ————————————————————————————————————————————

  meta(name: string | undefined): ScriptMeta | undefined {
    return name ? this.host.metaOf(name) : undefined
  }

  error(name: string | undefined): string | undefined {
    return name ? this.host.errors.get(name) : undefined
  }

  /**
   * A script's kind: what its metadata declares, or — before it loads, or with
   * deck code off, when nothing loads — what its source plainly says. Never
   * run, only read: `kind: 'canvas'` in the text.
   */
  kindOf(name: string): Kind | undefined {
    const k = this.meta(name)?.kind
    if (k === 'effect' || k === 'canvas') return k
    const src = this.store.doc.scripts?.[name]?.src ?? ''
    const m = src.match(/\bkind\s*:\s*['"](effect|canvas)['"]/)
    return m ? (m[1] as Kind) : undefined
  }

  /** Script names suited to `kind`: of that kind, or of no kind we can tell. */
  scripts(kind: Kind): string[] {
    return Object.keys(this.store.doc.scripts ?? {}).filter((n) => {
      const k = this.kindOf(n)
      return !k || k === kind
    }).sort()
  }

  /** Add a script from the template; returns its name. One undo step. */
  createScript(kind: Kind, commit = true): string {
    const doc = this.store.doc
    const name = freshScriptName(doc.scripts, kind === 'canvas' ? 'pendulum' : 'wobble')
    const add = () => { doc.scripts = { ...(doc.scripts ?? {}), [name]: { src: kind === 'canvas' ? CANVAS_TEMPLATE : EFFECT_TEMPLATE } } }
    if (commit) this.store.commit(add)
    else add()
    return name
  }

  /** Insert a code canvas on the current slide (and a script for it when the deck has none). */
  insertCanvas(at?: { x: number; y: number }) {
    const size = this.store.doc.size ?? { width: 1280, height: 720 }
    const w = 480
    const h = 360
    const el: CanvasElement = {
      id: uid(), type: 'canvas', script: '',
      x: Math.round(at?.x ?? (size.width - w) / 2), y: Math.round(at?.y ?? (size.height - h) / 2), w, h, rotation: 0, opacity: 1,
    }
    this.store.commit(() => {
      el.script = this.scripts('canvas').find((n) => this.kindOf(n) === 'canvas') ?? this.createScript('canvas', false)
      this.store.slide.elements.push(el)
    })
    this.store.select([el.id])
  }

  // ——— generated parameter controls ——————————————————————————————————————

  /**
   * One row per declared parameter. `row` adds a labelled control to the
   * caller's panel; `set` receives the new value (null = back to the default).
   */
  paramRows(meta: ScriptMeta | undefined, values: Record<string, unknown> | undefined, row: (label: string, input: HTMLElement, tip?: string) => void, set: (key: string, v: number | string | boolean | null) => void) {
    const decl = meta?.params ?? {}
    for (const [key, d] of Object.entries(decl) as Array<[string, ParamDecl]>) {
      if (!d || typeof d !== 'object') continue
      const v = values?.[key] ?? d.default
      const label = (typeof d.label === 'string' && d.label ? d.label : key) + (typeof d.unit === 'string' && d.unit ? ` (${d.unit})` : '')
      const type = d.type ?? (typeof d.default === 'boolean' ? 'boolean' : typeof d.default === 'string' ? (/^#[0-9a-f]{3,8}$/i.test(d.default) ? 'color' : 'text') : 'number')
      let input: HTMLElement
      if (type === 'boolean') {
        const c = document.createElement('input')
        c.type = 'checkbox'
        c.className = 'ed-toggle'
        c.checked = !!v
        c.addEventListener('change', () => set(key, c.checked))
        input = c
      } else if (type === 'select' && Array.isArray(d.options)) {
        const s = document.createElement('select')
        for (const o of d.options) { const op = document.createElement('option'); op.value = String(o); op.textContent = String(o); s.appendChild(op) }
        s.value = String(v ?? '')
        s.addEventListener('change', () => set(key, s.value))
        input = s
      } else if (type === 'color') {
        const c = document.createElement('input')
        c.type = 'color'
        c.value = typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v) ? v : '#000000'
        c.addEventListener('change', () => set(key, c.value))
        input = c
      } else if (type === 'text') {
        const c = document.createElement('input')
        c.type = 'text'
        c.value = String(v ?? '')
        c.addEventListener('change', () => set(key, c.value))
        input = c
      } else {
        const c = document.createElement('input')
        c.type = 'number'
        if (typeof d.min === 'number') c.min = String(d.min)
        if (typeof d.max === 'number') c.max = String(d.max)
        c.step = typeof d.step === 'number' ? String(d.step) : 'any'
        c.value = typeof v === 'number' ? String(v) : ''
        c.placeholder = typeof d.default === 'number' ? String(d.default) : ''
        c.addEventListener('change', () => {
          if (c.value.trim() === '') { set(key, null); return }
          let n = parseFloat(c.value)
          if (!Number.isFinite(n)) return
          if (typeof d.min === 'number') n = Math.max(d.min, n)
          if (typeof d.max === 'number') n = Math.min(d.max, n)
          set(key, n)
        })
        input = c
      }
      input.dataset.param = key
      row(label, input)
    }
  }

  // ——— the chip ———————————————————————————————————————————————————————————

  private openChipMenu() {
    document.querySelector('.ed-codepop')?.remove()
    const pop = document.createElement('div')
    pop.className = 'ed-codepop'
    const r = this.chip.getBoundingClientRect()
    pop.style.left = `${Math.max(8, Math.min(window.innerWidth - 300, r.left))}px`
    pop.style.top = `${r.bottom + 6}px`
    const p = document.createElement('p')
    p.textContent = t('This deck contains code. It runs in a sandbox: no network, no storage, no access to this page, your files or other tabs. Thumbnails, print and PDF always use still pictures.')
    const sw = document.createElement('label')
    sw.className = 'ed-codepop-switch'
    const box = document.createElement('input')
    box.type = 'checkbox'
    box.className = 'ed-toggle'
    box.checked = codeEnabled()
    box.addEventListener('change', () => setCodeEnabled(box.checked))
    sw.append(box, document.createTextNode(' ' + t('Run deck code in this browser')))
    const edit = document.createElement('button')
    edit.className = 'ed-btn'
    edit.textContent = t('Edit code…')
    edit.addEventListener('click', () => { pop.remove(); this.openEditor() })
    pop.append(p, sw, edit)
    document.body.appendChild(pop)
    const close = (ev: Event) => {
      if (pop.contains(ev.target as Node) || this.chip.contains(ev.target as Node)) return
      pop.remove()
      document.removeEventListener('pointerdown', close, true)
    }
    setTimeout(() => document.addEventListener('pointerdown', close, true), 0)
  }

  // ——— the Deck code dialog ——————————————————————————————————————————————

  /** Open the code dialog, on `name` (or the first script). */
  openEditor(name?: string, create?: Kind) {
    document.querySelector('dialog.ed-codedialog')?.remove()
    const doc = this.store.doc
    // working copy: names → source, plus where each came from (renames)
    const drafts = new Map<string, { src: string; from: string | null }>()
    for (const [n, s] of Object.entries(doc.scripts ?? {})) drafts.set(n, { src: s.src, from: n })
    const fresh = (kind: Kind) => {
      const n = freshScriptName(Object.fromEntries(drafts), kind === 'canvas' ? 'pendulum' : 'wobble')
      drafts.set(n, { src: kind === 'canvas' ? CANVAS_TEMPLATE : EFFECT_TEMPLATE, from: null })
      return n
    }
    let current: string | null = create ? fresh(create) : name && drafts.has(name) ? name : [...drafts.keys()][0] ?? null

    const dlg = document.createElement('dialog')
    dlg.className = 'ed-dialog ed-codedialog'
    dlg.innerHTML =
      `<h2>${t('Deck code')}</h2>` +
      `<p class="ed-code-lede">${t('Scripts run only in a sandbox — no network, no storage, no access to this page. Effects are used from the Animate tab, canvases from Insert → Code.')}</p>` +
      `<div class="ed-code-body"><div class="ed-code-list"></div>` +
      `<div class="ed-code-main"><label class="ed-code-name">${t('Name')} <input type="text" spellcheck="false"></label>` +
      `<textarea class="ed-code-src" spellcheck="false" autocapitalize="off" autocomplete="off"></textarea>` +
      `<div class="ed-code-msg" role="status"></div></div></div>` +
      `<div class="ed-dialog-actions"><button class="del">${t('Delete')}</button><span class="ed-code-gap"></span>` +
      `<button class="check">${t('Check')}</button><button class="cancel">${t('Close')}</button><button class="ok ed-primary">${t('Apply')}</button></div>`
    document.body.appendChild(dlg)
    const list = dlg.querySelector<HTMLElement>('.ed-code-list')!
    const nameIn = dlg.querySelector<HTMLInputElement>('.ed-code-name input')!
    const src = dlg.querySelector<HTMLTextAreaElement>('.ed-code-src')!
    const msg = dlg.querySelector<HTMLElement>('.ed-code-msg')!
    const say = (text: string, bad = false) => { msg.textContent = text; msg.classList.toggle('error', bad) }

    const renderList = () => {
      list.textContent = ''
      for (const n of [...drafts.keys()].sort()) {
        const b = document.createElement('button')
        b.className = 'ed-code-item' + (n === current ? ' on' : '')
        const kind = this.kindOf(drafts.get(n)!.from ?? '')
        b.textContent = n
        if (kind) { const k = document.createElement('small'); k.textContent = ` ${t(kind)}`; b.appendChild(k) }
        b.addEventListener('click', () => { stash(); current = n; load() })
        list.appendChild(b)
      }
      for (const [kind, label] of [['effect', t('＋ Effect script')], ['canvas', t('＋ Canvas script')]] as const) {
        const b = document.createElement('button')
        b.className = 'ed-code-new'
        b.textContent = label
        b.addEventListener('click', () => { stash(); current = fresh(kind); load() })
        list.appendChild(b)
      }
    }
    const stash = () => {
      const d = current === null ? undefined : drafts.get(current)
      if (d) d.src = src.value
    }
    const load = () => {
      nameIn.disabled = src.disabled = current === null
      if (current === null) {
        nameIn.value = ''
        src.value = ''
        say(t('No scripts. Add one with ＋, then Apply.'))
        renderList()
        return
      }
      nameIn.value = current
      src.value = drafts.get(current)?.src ?? ''
      const err = this.error(drafts.get(current)?.from ?? undefined)
      if (err) say(err, true)
      else {
        const u = scriptUses(this.store.doc, drafts.get(current)?.from ?? '')
        say(drafts.get(current)?.from ? t('Used by {e} effect(s) and {c} canvas(es).', { e: String(u.effects), c: String(u.canvases) }) : t('New — not in the deck until you Apply.'))
      }
      renderList()
    }
    nameIn.addEventListener('change', () => {
      const next = nameIn.value.trim()
      if (current === null || next === current) return
      const was = current
      if (!SCRIPT_NAME.test(next)) { say(t('A name is letters, digits, - and _ (it is also a file name).'), true); nameIn.value = was; return }
      if (drafts.has(next)) { say(t('There is already a script called {name}.', { name: next }), true); nameIn.value = was; return }
      stash()
      const d = drafts.get(was)!
      drafts.delete(was)
      drafts.set(next, d)
      current = next
      load()
    })
    // Tab indents (two spaces) instead of leaving the editor; Shift+Tab leaves
    src.addEventListener('keydown', (ev) => {
      if (ev.key !== 'Tab' || ev.shiftKey) return
      ev.preventDefault()
      const a = src.selectionStart
      src.setRangeText('  ', a, src.selectionEnd, 'end')
    })
    const check = async () => {
      stash()
      say(t('Checking…'))
      const r = await this.host.inspect(src.value)
      if (r.error) say(r.error, true)
      else {
        const params = Object.keys(r.meta?.params ?? {})
        say(t('OK — a {kind} script', { kind: t(r.meta?.kind ?? 'effect') }) + (params.length ? ` · ${t('parameters')}: ${params.join(', ')}` : ''))
      }
      return !r.error
    }
    dlg.querySelector('.check')!.addEventListener('click', () => { void check() })
    dlg.querySelector('.del')!.addEventListener('click', () => {
      if (current === null) return
      const d = drafts.get(current)
      if (!d) return
      const u = d.from ? scriptUses(this.store.doc, d.from) : { effects: 0, canvases: 0 }
      if ((u.effects || u.canvases) && !confirm(t('{name} is used by {e} effect(s) and {c} canvas(es). Delete it anyway? Effects then play without it; canvases show their still.', { name: current, e: String(u.effects), c: String(u.canvases) }))) return
      drafts.delete(current)
      current = [...drafts.keys()].sort()[0] ?? null
      load()
    })
    const apply = () => {
      stash()
      const renames = new Map<string, string>()
      for (const [n, d] of drafts) if (d.from && d.from !== n) renames.set(d.from, n)
      this.store.commit(() => {
        const next: Record<string, { src: string }> = {}
        for (const [n, d] of drafts) next[n] = { src: d.src }
        if (Object.keys(next).length) this.store.doc.scripts = next
        else delete this.store.doc.scripts
        if (!renames.size) return
        // a rename follows every reference, deck-wide
        for (const s of [...this.store.doc.slides, ...(this.store.doc.layouts ?? [])]) {
          for (const fx of (s.anim ?? []) as AnimEffect[]) if (fx?.type === 'script' && typeof fx.script === 'string' && renames.has(fx.script)) fx.script = renames.get(fx.script)
          for (const el of s.elements) if (el.type === 'canvas' && renames.has(el.script)) el.script = renames.get(el.script)!
        }
      })
      for (const [n, d] of drafts) d.from = n
      if (current === null) say(t('Applied — the deck has no code now.'))
      else void check()
    }
    dlg.querySelector('.ok')!.addEventListener('click', apply)
    const close = () => { dlg.close(); dlg.remove() }
    dlg.querySelector('.cancel')!.addEventListener('click', close)
    dlg.addEventListener('cancel', close)
    load()
    dlg.showModal()
    src.focus()
    // the top of the module (its meta) is where an author starts reading
    src.setSelectionRange(0, 0)
    src.scrollTop = 0
  }
}
