// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
/**
 * The animation pane — the Animate tab of the right-hand panel. PowerPoint's
 * animation pane, reduced to what the format holds (slide.anim, see
 * animseq.ts): the slide's effects grouped by click, each a bar on a small
 * timeline (drag the bar = delay, its end = duration), reordered by dragging
 * the grip, multi-selected with shift/⌘, previewed and scrubbed on the canvas.
 *
 * The edits themselves are animedit.ts (DOM-free, rig-tested): the first edit
 * on a legacy slide converts its reveal fields, and edits merge so keys the
 * pane does not know survive. Selection is shared with the canvas both ways:
 * a row selects its element; selecting elements selects their effects.
 */

import type { Store } from '../store'
import type { AnimEffect, Ease, Slide } from '../model'
import { t } from '../i18n'
import { EFFECTS, effectDef } from '../effects/index.ts'
import { planAnim, triggerOf, type AnimPlan } from '../animseq'
import { labelFor } from './layerrows'
import type { AnimUI } from './animui'
import type { AnimPreview, PreviewMode } from './animpreview'
import { FIELDS, type FieldKit } from './animfields'
import type { EditorCode } from './codeui'
import {
  addEffects, changeType, clampSecs, isCustom, moveEffects, paneList, removeEffects, replaceEffect, resetToEditable, setFields, setTiming, slideTimeline,
  type TimingPatch,
} from './animedit'
import { sanitizeEffect } from '../untrusted'
import { COMMON_KEYS } from '../effects/index.ts'
import { isBezier } from '../../../kernel/src/ease.ts'
import { easeControl } from './easecurve'

const TRIGGERS: Array<[NonNullable<AnimEffect['trigger']>, string]> = [
  ['click', 'On click'], ['with', 'With previous'], ['after', 'After previous'],
]

const div = (cls: string, text?: string) => {
  const d = document.createElement('div')
  d.className = cls
  if (text !== undefined) d.textContent = text
  return d
}
const button = (label: string, title: string, onClick: () => void, cls = 'ed-btn') => {
  const b = document.createElement('button')
  b.type = 'button'
  b.className = cls
  b.textContent = label
  b.title = title
  b.addEventListener('click', onClick)
  return b
}
const fmt = (s: number) => `${Number((Math.round(s * 100) / 100).toFixed(2))} s`

export class AnimPane {
  readonly root: HTMLElement
  /** the effect a shift-click extends from */
  private anchor: string | null = null
  /** a bar drag in progress: the pane does not rebuild under it */
  private dragging = false
  private dragId: string | null = null
  private scrubMode: PreviewMode = 'slide'
  private scrubClick = 0
  /** the curve editor stays open across the rebuild every edit causes */
  private easeOpen = false
  /** the JSON box likewise, and the last message it showed */
  private jsonOpen = false
  private jsonMsg: { id: string; text: string; error: boolean } | null = null
  private scrub: HTMLInputElement | null = null
  private scrubOut: HTMLElement | null = null
  private playBtn: HTMLButtonElement | null = null

  /** a pointer is down inside the pane (see refresh) */
  private pressing = false
  /** the Add animation menu stays open across a rebuild */
  private addOpen = false

  constructor(private store: Store, private ui: AnimUI, private preview: AnimPreview, signal?: AbortSignal, private code?: EditorCode) {
    this.root = div('ed-anim')
    this.root.addEventListener('pointerdown', () => { this.pressing = true }, { capture: true })
    document.addEventListener('pointerup', () => { this.pressing = false }, { capture: true, signal })
    document.addEventListener('pointercancel', () => { this.pressing = false }, { capture: true, signal })
    const offs = [
      // a doc edit respects a focused field; a slide or selection switch always
      // rebuilds — whatever was focused belongs to what is no longer shown
      store.on('doc', () => this.refresh()),
      store.on('current', () => { this.preview.stop(); this.anchor = null; this.addOpen = false; this.ui.select([]); this.refresh(true) }),
      store.on('selection', () => this.followCanvasSelection()),
      ui.on(() => this.refresh(true)),
    ]
    signal?.addEventListener('abort', () => { for (const off of offs) off(); this.preview.stop() })
    preview.onFrame = (T, total) => this.showScrub(T, total)
    // one listener for the pane's life (the header is rebuilt on every refresh)
    document.addEventListener('pointerdown', (ev) => {
      for (const w of this.root.querySelectorAll('.ed-anim-add.open')) if (!w.contains(ev.target as Node)) { w.classList.remove('open'); this.addOpen = false }
    }, { signal })
    preview.onStop = () => this.syncPlayButton()
  }

  // --- selection, both ways --------------------------------------------------------

  /** Elements were selected on the canvas: select their effects (unless the
   *  selected effects already belong to them — a row click got us here). */
  private followCanvasSelection() {
    const els = new Set(this.store.selection)
    const { list } = paneList(this.store.slide)
    const mine = this.ui.selected.filter((id) => list.find((f) => f.id === id && els.has(f.el)))
    if (els.size && mine.length && mine.length === this.ui.selected.length) return
    this.ui.select(els.size ? list.filter((f) => els.has(f.el)).map((f) => f.id) : [])
  }

  private clickRow(ev: MouseEvent, fx: AnimEffect, list: AnimEffect[]) {
    let ids: string[]
    if (ev.shiftKey && this.anchor) {
      const a = list.findIndex((f) => f.id === this.anchor)
      const b = list.findIndex((f) => f.id === fx.id)
      const [lo, hi] = a < b ? [a, b] : [b, a]
      ids = list.slice(lo, hi + 1).map((f) => f.id)
    } else if (ev.metaKey || ev.ctrlKey) {
      ids = this.ui.selected.includes(fx.id) ? this.ui.selected.filter((id) => id !== fx.id) : [...this.ui.selected, fx.id]
      this.anchor = fx.id
    } else {
      ids = [fx.id]
      this.anchor = fx.id
    }
    ids = list.filter((f) => ids.includes(f.id)).map((f) => f.id)
    this.ui.select(ids)
    const els = [...new Set(list.filter((f) => ids.includes(f.id)).map((f) => f.el))].filter((id) => this.store.element(id))
    this.store.select(els)
  }

  // --- edits ------------------------------------------------------------------------

  private edit(mutate: (slide: Slide) => void) {
    this.preview.stop()
    const slideId = this.store.slide.id
    this.store.commit(() => {
      const slide = this.store.doc.slides.find((s) => s.id === slideId)
      if (slide) mutate(slide)
    })
  }

  private timing(patch: TimingPatch) {
    const ids = new Set(this.ui.selected)
    this.edit((s) => setTiming(s, ids, patch))
  }

  add(type: string) {
    const els = this.store.selection.filter((id) => this.store.element(id))
    if (!els.length) return
    let added: string[] = []
    this.edit((s) => { added = addEffects(s, els, type) })
    this.ui.select(added)
    // play the click that was just authored, as PowerPoint does on add
    const plan = planAnim(paneList(this.store.slide).list)
    const pe = plan.effects.find((p) => p.fx.id === added[0])
    if (pe) { this.scrubMode = 'click'; this.scrubClick = pe.group; this.preview.play('click', pe.group); this.syncPlayButton() }
  }

  remove() {
    const ids = new Set(this.ui.selected)
    if (!ids.size) return
    this.edit((s) => removeEffects(s, ids))
    this.ui.select([])
  }

  // --- render -----------------------------------------------------------------------

  refresh(force = false) {
    if (!this.ui.open || this.dragging) return
    const focus = document.activeElement
    if (force && focus instanceof HTMLElement && this.root.contains(focus)) focus.blur()
    else if (focus instanceof HTMLElement && this.root.contains(focus) && focus.matches('input, select, textarea')) {
      // never pull a field out from under the user; catch up when it blurs —
      // but not mid-press: a click on a pane button blurs the field on
      // pointerdown, and rebuilding then detaches the button before pointerup,
      // so the click never happens (Stop needed two clicks after a field edit)
      focus.addEventListener('blur', () => {
        if (!this.pressing) { this.refresh(); return }
        document.addEventListener('pointerup', () => setTimeout(() => this.refresh(), 0), { once: true, capture: true })
      }, { once: true })
      return
    }
    const scroll = this.root.querySelector('.ed-anim-list')?.scrollTop ?? 0
    this.root.innerHTML = ''
    const slide = this.store.slide
    if (!slide) return
    const { list, implicit } = paneList(slide)
    const plan = planAnim(list)
    // a selection that no longer exists (undo, delete) is dropped quietly
    const live = this.ui.selected.filter((id) => list.some((f) => f.id === id))
    if (live.length !== this.ui.selected.length) { this.ui.selected = live }

    this.root.appendChild(this.buildHead())
    if (implicit && list.length) {
      const note = div('ed-anim-note')
      note.textContent = t('These come from this slide’s reveal steps and entrances. Editing any of them turns the slide into an animation list (one undo step).')
      this.root.appendChild(note)
    }
    if (!list.length) {
      const empty = div('ed-anim-empty')
      empty.textContent = t('No animations on this slide. Select something on the slide, then Add animation.')
      this.root.appendChild(empty)
    } else {
      const listEl = this.buildList(slide, list, plan)
      this.root.appendChild(listEl)
      listEl.scrollTop = scroll
      this.root.appendChild(this.buildScrubber(plan))
    }
    const sel = list.filter((f) => this.ui.selected.includes(f.id))
    if (sel.length) this.root.appendChild(this.buildInspector(sel, plan))
  }

  private buildHead(): HTMLElement {
    const head = div('ed-anim-head')
    const wrap = div('ed-dropdown ed-anim-add')
    const can = this.store.selection.some((id) => this.store.element(id))
    const addB = button(t('＋ Add animation'), can ? t('Animate the selected element(s) on the next click') : t('Select an element on the slide first'), () => { this.addOpen = wrap.classList.toggle('open') }, 'ed-btn ed-btn-primary')
    addB.disabled = !can
    // open across the rebuild a just-blurred field triggers (see refresh)
    if (can && this.addOpen) wrap.classList.add('open')
    const menu = div('ed-menu')
    const groups: Array<[string, string[]]> = [
      [t('Entrance'), ['appear', 'fade-in']], [t('Exit'), ['disappear', 'fade-out']],
      [t('Emphasis'), ['spin']], [t('Motion'), ['move']], [t('Code'), ['script']],
    ]
    for (const [label, types] of groups) {
      menu.appendChild(div('ed-menu-label', label))
      for (const type of types) {
        const def = effectDef(type)!
        menu.appendChild(button(t(def.label), '', () => { wrap.classList.remove('open'); this.addOpen = false; this.add(type) }))
      }
    }
    wrap.append(addB, menu)
    head.appendChild(wrap)
    return head
  }

  private buildList(slide: Slide, list: AnimEffect[], plan: AnimPlan): HTMLElement {
    const listEl = div('ed-anim-list')
    listEl.tabIndex = 0
    listEl.setAttribute('role', 'listbox')
    listEl.setAttribute('aria-multiselectable', 'true')
    listEl.addEventListener('keydown', (ev) => {
      if ((ev.key === 'Delete' || ev.key === 'Backspace') && this.ui.selected.length) {
        ev.preventDefault()
        ev.stopPropagation() // not the editor's "delete the selected elements"
        this.remove()
      }
    })
    const scale = Math.max(1, ...plan.groups)
    const byEl = new Map(slide.elements.map((e) => [e.id, e]))
    plan.groups.forEach((dur, g) => {
      const members = plan.effects.filter((p) => p.group === g)
      if (!members.length) return
      const head = div('ed-anim-ghead')
      head.appendChild(div('ed-anim-gtitle', g === 0 ? t('On arrival') : t('Click {n}', { n: String(g) })))
      head.appendChild(div('ed-anim-gdur', fmt(dur)))
      head.appendChild(button('▶', t('Preview this click on the slide'), () => {
        this.scrubMode = 'click'; this.scrubClick = g
        this.preview.play('click', g); this.syncPlayButton()
      }, 'ed-btn ed-anim-gplay'))
      listEl.appendChild(head)
      for (const pe of members) listEl.appendChild(this.buildRow(pe.fx, list, byEl.get(pe.fx.el), pe.start, pe.duration, scale))
    })
    return listEl
  }

  private buildRow(fx: AnimEffect, list: AnimEffect[], el: Slide['elements'][number] | undefined, start: number, duration: number, scale: number): HTMLElement {
    const def = effectDef(fx.type)
    const row = div('ed-anim-row')
    row.dataset.id = fx.id
    row.setAttribute('role', 'option')
    const sel = this.ui.selected.includes(fx.id)
    row.classList.toggle('sel', sel)
    row.setAttribute('aria-selected', String(sel))
    if (el && this.store.selection.includes(el.id)) row.classList.add('el-sel')
    if (!el) row.classList.add('dangling')

    const grip = div('ed-anim-grip', '⋮⋮')
    grip.draggable = true
    grip.title = t('Drag to reorder')
    grip.addEventListener('dragstart', (ev) => {
      this.dragId = fx.id
      ev.dataTransfer?.setData('text/plain', fx.id)
      if (ev.dataTransfer) ev.dataTransfer.effectAllowed = 'move'
      row.classList.add('dragging')
    })
    grip.addEventListener('dragend', () => { this.dragId = null; this.clearDropMarks() })
    row.addEventListener('dragover', (ev) => {
      if (!this.dragId || this.dragId === fx.id) return
      ev.preventDefault()
      this.clearDropMarks()
      row.classList.add(this.dropAbove(ev, row) ? 'drop-above' : 'drop-below')
    })
    row.addEventListener('drop', (ev) => {
      ev.preventDefault()
      const id = this.dragId
      const above = this.dropAbove(ev, row)
      this.clearDropMarks()
      if (!id || id === fx.id) return
      const ids = this.ui.selected.includes(id) ? this.ui.selected : [id]
      const at = list.findIndex((f) => f.id === fx.id) + (above ? 0 : 1)
      this.edit((s) => moveEffects(s, ids, at))
    })

    const trig = triggerOf(fx)
    const tg = div(`ed-anim-trig ed-anim-trig-${trig}`, trig === 'click' ? '●' : trig === 'with' ? '═' : '↳')
    tg.title = t(TRIGGERS.find(([k]) => k === trig)![1])
    const label = div('ed-anim-label')
    const name = document.createElement('span')
    name.className = 'ed-anim-name'
    name.textContent = el ? labelFor(el, t) : t('(missing element)')
    const kind = document.createElement('span')
    kind.className = `ed-anim-kind ed-anim-kind-${def?.kind ?? 'unknown'}`
    const summary = def?.summary?.(fx)
    kind.textContent = (def ? t(def.label) : fx.type) + (summary ? ` ${summary}` : '')
    label.append(name, kind)
    if (isCustom(fx)) {
      const c = document.createElement('span')
      c.className = 'ed-anim-custom'
      c.textContent = t('custom')
      c.title = t('This effect has settings the panel cannot show (open Advanced JSON). Timing still edits here, and nothing else is changed.')
      label.appendChild(c)
    }
    row.title = `${name.textContent} — ${kind.textContent}`

    const lane = div('ed-anim-lane')
    if (duration > 0) {
      const bar = div('ed-anim-bar')
      bar.style.left = `${(start / scale) * 100}%`
      bar.style.width = `${(duration / scale) * 100}%`
      bar.title = t('{start} → {end} — drag to change the delay, drag the end to change the duration', { start: fmt(start), end: fmt(start + duration) })
      const end = div('ed-anim-bar-end')
      bar.appendChild(end)
      bar.addEventListener('pointerdown', (ev) => this.dragBar(ev, fx, lane, bar, scale, ev.target === end ? 'duration' : 'delay', start))
      lane.appendChild(bar)
    } else {
      const dot = div('ed-anim-dot')
      dot.style.left = `${(start / scale) * 100}%`
      dot.title = t('At {start} — drag to change the delay', { start: fmt(start) })
      dot.addEventListener('pointerdown', (ev) => this.dragBar(ev, fx, lane, dot, scale, 'delay', start))
      lane.appendChild(dot)
    }
    row.append(grip, tg, label, lane)
    row.addEventListener('click', (ev) => { if (!(ev.target as HTMLElement).closest('.ed-anim-bar, .ed-anim-dot')) this.clickRow(ev, fx, list) })
    return row
  }

  private dropAbove(ev: DragEvent, row: HTMLElement): boolean {
    const b = row.getBoundingClientRect()
    return ev.clientY < b.top + b.height / 2
  }

  private clearDropMarks() {
    for (const n of this.root.querySelectorAll('.drop-above, .drop-below, .dragging')) n.classList.remove('drop-above', 'drop-below', 'dragging')
  }

  /**
   * Drag a bar: its body moves the start (the delay changes — the anchor is
   * the trigger's), its end handle sets the duration. 0.05 s steps; Alt for
   * free. Live in the row only; one commit (one undo step) on release.
   */
  private dragBar(ev: PointerEvent, fx: AnimEffect, lane: HTMLElement, bar: HTMLElement, scale: number, what: 'delay' | 'duration', start: number) {
    if (ev.button !== 0) return
    ev.preventDefault()
    ev.stopPropagation()
    const width = lane.getBoundingClientRect().width || 1
    const secPerPx = scale / width
    const delay0 = fx.delay ?? 0
    const dur0 = fx.duration ?? effectDef(fx.type)?.duration ?? 0
    const anchor = start - delay0
    const x0 = ev.clientX
    let value = what === 'delay' ? delay0 : dur0
    let moved = false
    this.dragging = true
    bar.classList.add('dragging')
    const readout = div('ed-anim-tip')
    lane.appendChild(readout)
    const move = (e: PointerEvent) => {
      const dx = e.clientX - x0
      if (Math.abs(dx) > 2) moved = true
      const raw = (what === 'delay' ? delay0 : dur0) + dx * secPerPx
      const step = e.altKey ? 0.01 : 0.05
      value = Math.max(what === 'delay' ? 0 : 0.05, Math.round(raw / step) * step)
      value = clampSecs(value)
      if (what === 'delay') bar.style.left = `${((anchor + value) / scale) * 100}%`
      else bar.style.width = `${(value / scale) * 100}%`
      readout.textContent = what === 'delay' ? t('delay {s}', { s: fmt(value) }) : t('duration {s}', { s: fmt(value) })
      readout.style.left = bar.style.left
    }
    const up = (e: PointerEvent) => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      this.dragging = false
      bar.classList.remove('dragging')
      readout.remove()
      if (!moved) {
        // a click on a bar is a click on its row
        const list = paneList(this.store.slide).list
        this.clickRow(e, fx, list)
        return
      }
      const ids = this.ui.selected.includes(fx.id) ? new Set(this.ui.selected) : new Set([fx.id])
      this.edit((s) => setTiming(s, ids, what === 'delay' ? { delay: value } : { duration: value }))
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  // --- preview + scrubbing ----------------------------------------------------------

  private buildScrubber(plan: AnimPlan): HTMLElement {
    const box = div('ed-anim-scrubber')
    const mode = document.createElement('select')
    const clicks: Array<[string, string]> = [['slide', t('Whole slide')]]
    plan.groups.forEach((_d, g) => { if (plan.effects.some((p) => p.group === g)) clicks.push([`c${g}`, g === 0 ? t('On arrival') : t('Click {n}', { n: String(g) })]) })
    for (const [v, label] of clicks) {
      const o = document.createElement('option')
      o.value = v
      o.textContent = label
      mode.appendChild(o)
    }
    mode.value = this.scrubMode === 'slide' ? 'slide' : `c${this.scrubClick}`
    if (!clicks.some(([v]) => v === mode.value)) { this.scrubMode = 'slide'; mode.value = 'slide' }
    mode.addEventListener('change', () => {
      this.scrubMode = mode.value === 'slide' ? 'slide' : 'click'
      this.scrubClick = this.scrubMode === 'click' ? Number(mode.value.slice(1)) : 0
      this.preview.stop()
      this.showScrub(0, this.preview.total(this.scrubMode, this.scrubClick))
    })
    const play = button('▶', t('Play the preview on the slide'), () => {
      if (this.preview.playing) this.preview.stop()
      else this.preview.play(this.scrubMode, this.scrubClick)
      this.syncPlayButton()
    }, 'ed-btn ed-anim-play')
    this.playBtn = play
    const stop = button('■', t('Stop previewing — show the slide as authored'), () => { this.preview.stop(); this.showScrub(0, this.preview.total(this.scrubMode, this.scrubClick)) }, 'ed-btn ed-anim-stop')
    const range = document.createElement('input')
    range.type = 'range'
    range.min = '0'
    range.max = '1000'
    range.step = '1'
    range.className = 'ed-anim-range'
    range.setAttribute('aria-label', t('Scrub the preview'))
    range.addEventListener('input', () => {
      const total = this.preview.total(this.scrubMode, this.scrubClick)
      this.preview.show(this.scrubMode, this.scrubClick, (Number(range.value) / 1000) * total)
      this.syncPlayButton()
    })
    const out = div('ed-anim-time')
    this.scrub = range
    this.scrubOut = out
    const total = slideTimeline(plan).total
    this.showScrub(this.preview.active && this.preview.mode === this.scrubMode ? this.preview.T : 0, this.scrubMode === 'slide' ? total : plan.groups[this.scrubClick] ?? 0)
    const top = div('ed-anim-scrub-top')
    top.append(mode, play, stop)
    box.append(top, range, out)
    this.syncPlayButton()
    return box
  }

  private showScrub(T: number, total: number) {
    if (!this.scrub || !this.scrubOut) return
    this.scrub.value = String(total > 0 ? Math.round((T / total) * 1000) : 0)
    this.scrubOut.textContent = `${fmt(T)} / ${fmt(total)}`
  }

  private syncPlayButton() {
    if (!this.playBtn) return
    this.playBtn.textContent = this.preview.playing ? '❚❚' : '▶'
  }

  // --- the inspector -----------------------------------------------------------------

  private buildInspector(sel: AnimEffect[], plan: AnimPlan): HTMLElement {
    const box = div('ed-anim-inspector')
    const one = sel.length === 1 ? sel[0] : null
    const h = document.createElement('h3')
    h.className = 'ed-section'
    h.textContent = one ? t('Effect') : t('{n} effects', { n: String(sel.length) })
    box.appendChild(h)
    const kit = this.kit(box)

    if (one) {
      const types: Array<[string, string]> = EFFECTS.map((d) => [d.type, t(d.label)])
      if (!effectDef(one.type)) types.push([one.type, one.type])
      kit.row(t('Effect'), kit.select(types, one.type, (v) => this.edit((s) => changeType(s, one.id, v))))
    }
    const trig = sel.map(triggerOf)
    kit.row(t('Start'), kit.select(
      [...(trig.every((x) => x === trig[0]) ? [] : [['', t('(mixed)')] as [string, string]]), ...TRIGGERS.map(([k, l]) => [k, t(l)] as [string, string])],
      trig.every((x) => x === trig[0]) ? trig[0] : '',
      (v) => { if (v) this.timing({ trigger: v as AnimEffect['trigger'] }) }))
    const same = (vals: number[]) => vals.every((v) => v === vals[0])
    const delays = sel.map((f) => f.delay ?? 0)
    kit.row(t('Delay'), this.seconds(same(delays) ? delays[0] : null, (v) => this.timing({ delay: v })), t('Seconds after its start point (the click, or the previous effect).'))
    const timed = sel.filter((f) => !effectDef(f.type)?.instant)
    if (timed.length) {
      const durs = timed.map((f) => f.duration ?? effectDef(f.type)?.duration ?? 0.5)
      kit.row(t('Duration'), this.seconds(same(durs) ? durs[0] : null, (v) => this.timing({ duration: Math.max(0.01, v) }), 0.01))
      kit.row(t('Easing'), this.easeSelect(timed))
    }
    if (one) {
      const entry = FIELDS[one.type]
      if (entry) entry(one, kit, (patch) => this.edit((s) => setFields(s, one.id, patch)))
      const pe = plan.effects.find((p) => p.fx.id === one.id)
      if (pe) kit.hint(t('Plays {start}–{end} into {click}.', { start: fmt(pe.start), end: fmt(pe.end), click: pe.group ? t('click {n}', { n: String(pe.group) }) : t('the arrival') }))
    }
    if (one) this.buildJson(box, one)
    const actions = div('ed-anim-actions')
    actions.appendChild(button(sel.length > 1 ? t('Remove {n} effects', { n: String(sel.length) }) : t('Remove effect'), t('Delete (⌫) with the list focused does the same'), () => this.remove(), 'ed-btn ed-btn-danger'))
    box.appendChild(actions)
    return box
  }

  /**
   * Tier 1 of the code layer: the effect as JSON. Anything the format holds
   * can be written here — keyframes above all — and the row then shows as
   * "custom": its timing still edits in the panel, and nothing else is touched.
   * A key this build does not know survives an edit as long as it was already
   * there and is left as it was; a NEW unknown key or a bad value is dropped,
   * as at a paste, and the box says so.
   */
  private buildJson(box: HTMLElement, fx: AnimEffect) {
    const custom = isCustom(fx)
    const def = effectDef(fx.type)
    if (custom) {
      const known = new Set<string>([...COMMON_KEYS, ...(def?.owns ?? [])])
      const extra = Object.keys(fx).filter((k) => !known.has(k) || (k === 'keys' && Array.isArray(fx.keys) && fx.keys.length))
      const note = div('ed-anim-note ed-anim-customnote')
      note.textContent = def
        ? t('Custom: {keys} — the panel cannot show these, and leaves them exactly as they are. Timing still edits above.', { keys: extra.join(', ') })
        : t('This effect type ({type}) is not one this app plays; it keeps its place and its click. Edit it as JSON, or change its type.', { type: fx.type })
      if (def) {
        note.appendChild(button(t('Reset to UI-editable'), t('Drop what the panel cannot show (keyframes and unknown keys)'), () => {
          if (!confirm(t('Drop {keys} from this effect? Its timing and basic settings stay; ⌘Z undoes it.', { keys: extra.join(', ') }))) return
          this.edit((s) => resetToEditable(s, fx.id))
        }, 'ed-btn ed-anim-reset'))
      }
      box.insertBefore(note, box.children[1] ?? null)
    }
    const h = document.createElement('h3')
    h.className = 'ed-section ed-anim-jsonhead'
    h.textContent = t('Advanced (JSON)')
    h.classList.toggle('closed', !this.jsonOpen)
    h.addEventListener('click', () => { this.jsonOpen = !this.jsonOpen; this.refresh(true) })
    box.appendChild(h)
    if (!this.jsonOpen) return
    const ta = document.createElement('textarea')
    ta.className = 'ed-anim-json'
    ta.spellcheck = false
    ta.rows = Math.min(16, JSON.stringify(fx, null, 2).split('\n').length + 1)
    ta.value = JSON.stringify(fx, null, 2)
    box.appendChild(ta)
    const msg = div('ed-anim-jsonmsg')
    if (this.jsonMsg?.id === fx.id) { msg.textContent = this.jsonMsg.text; msg.classList.toggle('error', this.jsonMsg.error) }
    const row = div('ed-anim-actions')
    row.appendChild(button(t('Apply'), t('Replace this effect with the JSON above'), () => this.applyJson(fx, ta.value), 'ed-btn ed-btn-primary'))
    box.append(row, msg)
  }

  private applyJson(fx: AnimEffect, text: string) {
    let parsed: unknown
    try { parsed = JSON.parse(text) } catch (err) {
      this.jsonMsg = { id: fx.id, text: t('Not JSON: {m}', { m: (err as Error).message }), error: true }
      this.refresh(true)
      return
    }
    const { effect, dropped } = sanitizeEffect(parsed)
    if (!effect) {
      this.jsonMsg = { id: fx.id, text: t('Not an effect: it needs at least "el" and a known "type". {why}', { why: dropped.map((d) => `${d.path} ${d.reason}`).join('; ') }), error: true }
      this.refresh(true)
      return
    }
    // keep what was already there and is unchanged, even if this build does not know it
    const before = fx as unknown as Record<string, unknown>
    const after = parsed as Record<string, unknown>
    const kept: string[] = []
    for (const d of dropped) {
      const key = d.path.split('/').filter(Boolean)[0]
      if (key && key in before && JSON.stringify(before[key]) === JSON.stringify(after[key])) {
        ;(effect as unknown as Record<string, unknown>)[key] = before[key]
        kept.push(key)
      }
    }
    const lost = dropped.filter((d) => !kept.includes(d.path.split('/').filter(Boolean)[0]))
    if (!this.store.slide.elements.some((e) => e.id === effect.el)) {
      this.jsonMsg = { id: fx.id, text: t('"{el}" is not an element on this slide.', { el: effect.el }), error: true }
      this.refresh(true)
      return
    }
    this.jsonMsg = { id: fx.id, text: lost.length ? t('Applied. Not kept: {list}', { list: lost.map((d) => `${d.path} (${d.reason})`).join('; ') }) : t('Applied.'), error: lost.length > 0 }
    this.edit((s) => replaceEffect(s, fx.id, effect))
  }

  private easeSelect(sel: AnimEffect[]): HTMLElement {
    const key = (e: Ease | undefined) => (e === undefined ? '' : isBezier(e) ? e.join(',') : String(e))
    const keys = sel.map((f) => key(f.ease))
    const mixed = !keys.every((k) => k === keys[0])
    const def = effectDef(sel[0].type)
    const dur = sel[0].duration ?? def?.duration ?? 0.5
    const ctl = easeControl({
      value: mixed ? undefined : sel[0].ease,
      fallback: def?.ease ?? 'linear',
      inheritLabel: mixed ? t('(mixed)') : t('Default'),
      seconds: () => dur,
      open: this.easeOpen,
      // a drag previews in the control only; the curve is committed on release
      onChange: (e, final) => { if (final) this.timing({ ease: e }) },
    })
    ctl.querySelector('.ed-ease-toggle')?.addEventListener('click', () => { this.easeOpen = !this.easeOpen })
    return ctl
  }

  private seconds(value: number | null, onChange: (v: number) => void, min = 0): HTMLInputElement {
    const input = document.createElement('input')
    input.type = 'number'
    input.step = '0.05'
    input.min = String(min)
    input.value = value === null ? '' : String(Math.round(value * 100) / 100)
    if (value === null) input.placeholder = t('mixed')
    input.addEventListener('change', () => {
      const v = parseFloat(input.value)
      if (Number.isFinite(v)) onChange(Math.max(min, v))
    })
    return input
  }

  private kit(box: HTMLElement): FieldKit {
    return {
      code: this.code,
      scripts: this.store.doc.scripts,
      row(label, input, tip) {
        const row = document.createElement('label')
        row.className = 'ed-row'
        const span = document.createElement('span')
        span.textContent = label
        row.append(span, input)
        if (tip) row.title = tip
        box.appendChild(row)
        return row
      },
      number(value, step, onChange, opts = {}) {
        const input = document.createElement('input')
        input.type = 'number'
        input.step = String(step)
        if (opts.min !== undefined) input.min = String(opts.min)
        if (opts.max !== undefined) input.max = String(opts.max)
        input.value = String(Math.round(value * 100) / 100)
        input.addEventListener('change', () => {
          const v = parseFloat(input.value)
          if (Number.isFinite(v)) onChange(v)
        })
        return input
      },
      select(options, value, onChange) {
        const sel = document.createElement('select')
        for (const [v, label] of options) {
          const o = document.createElement('option')
          o.value = v
          o.textContent = label
          sel.appendChild(o)
        }
        sel.value = value
        sel.addEventListener('change', () => onChange(sel.value))
        return sel
      },
      chips(items) {
        const row = div('ed-anim-chips')
        for (const [label, fn] of items) row.appendChild(button(label, '', fn, 'ed-btn ed-anim-chip'))
        box.appendChild(row)
        return row
      },
      hint(text) {
        const p = document.createElement('p')
        p.className = 'ed-hint'
        p.textContent = text
        box.appendChild(p)
        return p
      },
    }
  }
}
