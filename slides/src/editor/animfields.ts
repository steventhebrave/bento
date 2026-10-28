// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
/**
 * The animation pane's per-type fields: the panel half of the effect registry
 * (src/effects/ is the engine half). Adding an effect type = one module there
 * plus one entry here. An entry builds rows with the pane's own controls and
 * reports edits as a patch of the effect's own keys; the pane merges it.
 */

import type { AnimEffect } from '../model'
import { t } from '../i18n'
import type { EditorCode } from './codeui'
import { codeEnabled } from '../code/host'

/** The pane's controls, handed to each entry so every type looks the same. */
export interface FieldKit {
  row(label: string, input: HTMLElement, tip?: string): HTMLElement
  number(value: number, step: number, onChange: (v: number) => void, opts?: { min?: number; max?: number }): HTMLInputElement
  select(options: Array<[string, string]>, value: string, onChange: (v: string) => void): HTMLSelectElement
  chips(items: Array<[string, () => void]>): HTMLElement
  hint(text: string): HTMLElement
  /** the deck's code (FORK): absent where no code UI is wired (node rigs) */
  code?: EditorCode
  /** the deck's scripts, as data — enough to say "missing" without a sandbox */
  scripts?: Record<string, { src: string }>
}

export type FieldEntry = (fx: AnimEffect, kit: FieldKit, set: (patch: Partial<AnimEffect>) => void) => void

const num = (v: unknown, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d)

export const FIELDS: Record<string, FieldEntry> = {
  spin(fx, kit, set) {
    const deg = num(fx.deg, 360)
    kit.row(t('Angle'), kit.number(deg, 15, (v) => set({ deg: v })), t('Degrees, clockwise positive. Any size: 720 is two full turns.'))
    kit.chips([
      [t('¼ turn'), () => set({ deg: Math.sign(deg || 1) * 90 })],
      [t('½ turn'), () => set({ deg: Math.sign(deg || 1) * 180 })],
      [t('1 turn'), () => set({ deg: Math.sign(deg || 1) * 360 })],
      [t('2 turns'), () => set({ deg: Math.sign(deg || 1) * 720 })],
      [deg < 0 ? t('↻ clockwise') : t('↺ anticlockwise'), () => set({ deg: -deg })],
    ])
  },
  move(fx, kit, set) {
    kit.row('Δx', kit.number(num(fx.dx), 10, (v) => set({ dx: v })), t('Slide pixels, from wherever the element is when this move starts'))
    kit.row('Δy', kit.number(num(fx.dy), 10, (v) => set({ dy: v })))
    kit.hint(t('Drag the handle at the end of the dashed path on the slide. Shift snaps the angle.'))
  },
  'fade-in'(fx, kit, set) {
    const dx = num(fx.fromDx), dy = num(fx.fromDy)
    const dir = !dx && !dy ? 'none' : Math.abs(dx) >= Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : dy > 0 ? 'below' : 'above'
    const dist = Math.round(Math.max(Math.abs(dx), Math.abs(dy))) || 40
    const apply = (d: string, n: number) => {
      if (d === 'none') set({ fromDx: undefined, fromDy: undefined })
      else if (d === 'left') set({ fromDx: -n, fromDy: undefined })
      else if (d === 'right') set({ fromDx: n, fromDy: undefined })
      else if (d === 'above') set({ fromDy: -n, fromDx: undefined })
      else set({ fromDy: n, fromDx: undefined })
    }
    kit.row(t('Fly in from'), kit.select([
      ['none', t('Nowhere (fade only)')], ['left', t('The left')], ['right', t('The right')], ['above', t('Above')], ['below', t('Below')],
    ], dir, (v) => apply(v, dist)))
    if (dir !== 'none') kit.row(t('Distance'), kit.number(dist, 10, (v) => apply(dir, Math.max(0, v)), { min: 0 }))
  },
  script(fx, kit, set) {
    const code = kit.code
    const name = typeof fx.script === 'string' ? fx.script : ''
    if (!code) {
      kit.hint(name ? t('Script "{name}".', { name }) : t('A script effect runs code from the deck.'))
      return
    }
    const names = code.scripts('effect')
    if (name && !names.includes(name)) names.unshift(name)
    kit.row(t('Script'), kit.select([['', t('(choose a script)')], ...names.map((n): [string, string] => [n, n])], name,
      // another script has other parameters: the old values do not carry over
      (v) => set({ script: v || undefined, params: undefined })))
    kit.chips([
      [t('Edit code…'), () => code.openEditor(name || undefined)],
      [t('New script…'), () => code.openEditor(undefined, 'effect')],
    ])
    if (!name) { kit.hint(t('Pick a script, or write one: it decides what the element does; this row decides when.')); return }
    if (!kit.scripts?.[name]) { kit.hint(t('No script called “{name}” in this deck — the effect plays as nothing.', { name })); return }
    if (!codeEnabled()) { kit.hint(t('Deck code is off in this browser — the effect plays as nothing here.')); return }
    const err = code.error(name)
    if (err) { kit.hint(err).classList.add('ed-code-error'); return }
    const meta = code.meta(name)
    if (meta?.kind === 'canvas') { kit.hint(t('“{name}” is a canvas script, not an effect script.', { name })); return }
    code.paramRows(meta, fx.params, (label, input) => kit.row(label, input), (key, v) => {
      const params = { ...(fx.params ?? {}) }
      if (v === null) delete params[key]
      else params[key] = v
      set({ params: Object.keys(params).length ? params : undefined })
    })
    if (meta) kit.hint(Array.isArray(meta.drives) && meta.drives.length
      ? t('Drives {keys}; everything else follows the effects above it.', { keys: meta.drives.join(', ') })
      : t('Declares no drives: it may change position, angle, scale, opacity and colour.'))
  },
}
