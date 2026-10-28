// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
/**
 * The effect registry. To add an effect type: write one module beside these
 * (an EffectDef — see types.ts), list it here, and give it a panel entry in
 * editor/animfields.ts. The paste gate (untrusted.ts), the schema, the engine
 * (animseq.ts) and the pane all read this list.
 */
import type { EffectDef } from './types.ts'
import { appear } from './appear.ts'
import { disappear } from './disappear.ts'
import { fadeIn } from './fade-in.ts'
import { fadeOut } from './fade-out.ts'
import { spin } from './spin.ts'
import { move } from './move.ts'
import { script } from './script.ts'

export const EFFECTS: readonly EffectDef[] = [appear, fadeIn, disappear, fadeOut, spin, move, script]

const BY_TYPE = new Map(EFFECTS.map((d) => [d.type, d]))

/** The definition for a type, or undefined for one this build does not know. */
export const effectDef = (type: unknown): EffectDef | undefined =>
  typeof type === 'string' ? BY_TYPE.get(type) : undefined

export const EFFECT_TYPES: readonly string[] = EFFECTS.map((d) => d.type)

export type { EffectDef, ElState, Frame, FrameSource, ScriptSampler, ApplyCtx, EffectKind } from './types.ts'
export { COMMON_KEYS, IDENTITY } from './types.ts'
export { frameOfState } from './script.ts'
