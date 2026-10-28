// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
/**
 * The bento/slides document schema, as JSON Schema (draft 2020-12), built
 * from the SAME tables that gate a document on the way in: untrusted.ts's
 * checks describe what they accept, modelkeys.generated.ts says which keys
 * each type has, and this file assembles the two. There is no hand-written
 * copy of the format to drift: scripts/build-schema.mjs prints this into
 * schema/slides.json (published at https://bento.page/schema/slides.json)
 * and CI fails when the file and the function disagree.
 *
 * Reachable four ways: the URL above (and a version-pinned twin), the
 * `$schema` key every saved deck carries (save.ts), `window.bento.schema()`
 * in a running file, and https://bento.page/llms.txt. The first, second and
 * fourth serve a model that READS the file; the third serves one driving a
 * browser — the shell is deflated, so a text reader never sees this code.
 *
 * What the schema says and what the gate does are the same thing by
 * construction, with one honest gap: the gate REPAIRS a numeric string
 * ("12" → 12) and DROPS a bad value rather than rejecting the document; a
 * validator following this schema reports the same values as errors. A deck
 * that validates here loads with nothing dropped.
 */

import { FORMAT, FORMAT_VERSION } from './model'
import { MODEL_KEYS } from './modelkeys.generated'
import { ELEMENT_CHECKS, SLIDE_CHECKS, REQUIRED_KEYS, LIMITS, EASE_CHECK, objectSchema, type JsonSchema } from './untrusted'

/**
 * FORK: this build's schema, as published from the fork's repository (the
 * generated schema/slides.json there). Upstream's, at
 * https://bento.page/schema/slides.json, closes slides and elements
 * (additionalProperties: false) without the fork's fields — `anim`,
 * `backgroundImage`, `anchor`, `canvas` — so a fork deck pointing there would
 * fail any validator that followed its own `$schema`.
 */
export const SCHEMA_URL = 'https://raw.githubusercontent.com/steventhebrave/bento/ccr-6ab0e2f2-nxmnan/schema/slides.json'

/**
 * The saved JSON names its schema as its FIRST key, so a reader with only
 * the file in hand knows the format (50 bytes). A new object — the live
 * document is never touched — and parseDoc strips the key on load, so it
 * exists only in the bytes on disk: not in the store, the CRDT, a recovery
 * snapshot or a clip. Older shells keep the key and write it back; nothing
 * anywhere fetches it.
 */
export const stampSchema = <T extends object>(doc: T): T & { $schema: string } => ({ $schema: SCHEMA_URL, ...doc })

const str = (max: number, description?: string): JsonSchema =>
  description ? { type: 'string', maxLength: max, description } : { type: 'string', maxLength: max }
const color = (description: string): JsonSchema => ({ type: 'string', maxLength: LIMITS.color, description })
const obj = (keys: readonly string[], props: Record<string, JsonSchema>, required: string[] = []): JsonSchema => {
  const properties: Record<string, JsonSchema> = {}
  for (const k of keys) properties[k] = props[k] ?? {}
  const out: JsonSchema = { type: 'object', properties, additionalProperties: false }
  if (required.length) out.required = required
  return out
}

/**
 * Element properties whose schema is a structure (fx, gradients, shadows,
 * table rows…) are hoisted into $defs once and referenced from every element
 * type that carries them — the file is a third the size and a reader sees
 * one definition of `fx`, not eight.
 */
const HOISTED = ['fx', 'shadow', 'colorGradient', 'fillGradient', 'themeRefs', 'from', 'to', 'style', 'rows', 'columns', 'crop', 'textStroke', 'source', 'link', 'option', 'doc'] as const

/** The schema for one element type: exactly that type's keys, each as the gate checks it. */
function elementSchema(type: string, $defs: Record<string, JsonSchema>): JsonSchema {
  const keys = (MODEL_KEYS.element as Record<string, readonly string[]>)[type]
  const s = objectSchema(keys, ELEMENT_CHECKS, ['type', 'id', ...(REQUIRED_KEYS[type] ?? [])])
  const props = s.properties as Record<string, JsonSchema>
  props.type = { const: type }
  for (const key of HOISTED) {
    if (!(key in props)) continue
    const name = `prop-${key}`
    $defs[name] ??= props[key]
    props[key] = { $ref: `#/$defs/${name}` }
  }
  s.description = `${type} element; x/y/w/h in slide px (1280×720 default); a stable id pairs morphs`
  return s
}

/** Build the whole schema. `version` stamps which shell it describes. */
export function buildSchema(version: string): JsonSchema {
  const elementTypes = Object.keys(MODEL_KEYS.element)
  const $defs: Record<string, JsonSchema> = {}
  for (const type of elementTypes) $defs[type] = elementSchema(type, $defs)
  $defs.element = { oneOf: elementTypes.map((t) => ({ $ref: `#/$defs/${t}` })) }
  $defs.slide = objectSchema(MODEL_KEYS.slide, SLIDE_CHECKS, ['id'])
  $defs.slide.description = 'stateOf = hidden variant reached by a link; transition morph pairs same-id elements'
  // FORK — the animation sequence and the code layer, with worked examples
  // (the same ones docs/agents.md walks through)
  const slideProps = $defs.slide.properties as Record<string, JsonSchema>
  slideProps.anim = {
    ...slideProps.anim,
    description: 'FORK: the click order. Each effect: el (element id), type (appear|disappear|fade-in|fade-out|spin|move|script), trigger (click = a new click [default] | with = alongside the previous | after = when it ends), delay/duration in seconds, ease (preset name or [x1,y1,x2,y2]). Effects accumulate; an element whose first effect is an entrance starts hidden. Present = elements\' fx.step/enter are ignored on this slide.',
    examples: [[
      { id: 'a1', el: 'label', type: 'fade-in', trigger: 'click', duration: 0.6, fromDy: 20 },
      { id: 'a2', el: 'arrow', type: 'move', trigger: 'with', dx: 420, dy: 0, duration: 1.2, ease: [0.65, 0, 0.35, 1] },
      { id: 'a3', el: 'arrow', type: 'script', trigger: 'with', script: 'hop', params: { height: 120 }, duration: 1.2 },
      { id: 'a4', el: 'gear', type: 'spin', trigger: 'after', deg: -720, duration: 2 },
    ]],
  }
  $defs.canvas.description = 'FORK: a box drawn by doc.scripts[script] (kind canvas) on the show clock — draw(g, ctx) with ctx.click and ctx.t (seconds since that click began). poster is the still every surface that runs no code shows (thumbnails, print, code off); the editor captures it at posterAt.'
  $defs.canvas.examples = [{ id: 'pend', type: 'canvas', script: 'pendulum', params: { length: 1.2 }, x: 760, y: 120, w: 400, h: 480, rotation: 0, opacity: 1 }]
  $defs.tableStyle = ELEMENT_CHECKS.style.schema!
  $defs.theme = obj(MODEL_KEYS.theme, {
    background: color('slide background'), color: color('body text colour'), accent: color('accent colour'),
    fontFamily: { type: 'string', maxLength: LIMITS.fontStack, description: 'CSS font-family stack for body text' },
    headingFamily: { type: 'string', maxLength: LIMITS.fontStack, description: 'display face for headings; absent = fontFamily' },
    palette: obj(MODEL_KEYS.themePalette, Object.fromEntries(MODEL_KEYS.themePalette.map((k) => [k, color(`brand slot ${k}`)]))),
    chartPalette: { type: 'array', maxItems: 64, items: color('series colour') },
    table: { $ref: '#/$defs/tableStyle' },
    codePalette: obj(MODEL_KEYS.themeCodePalette, Object.fromEntries(MODEL_KEYS.themeCodePalette.map((k) => [k, color('token colour')]))),
  }, ['background', 'color', 'accent', 'fontFamily'])
  $defs.doc = obj(MODEL_KEYS.doc, {
    format: { const: FORMAT },
    version: { type: 'integer', minimum: 1, description: `format version; this shell writes ${FORMAT_VERSION}` },
    docId: str(LIMITS.scalar, 'runtime-minted uuid; omit'),
    title: str(LIMITS.prose),
    meta: obj(MODEL_KEYS.meta, Object.fromEntries(MODEL_KEYS.meta.map((k) => [k, str(LIMITS.prose)]))),
    size: obj(MODEL_KEYS.size, { width: { type: 'number', minimum: 1, maximum: 1e5 }, height: { type: 'number', minimum: 1, maximum: 1e5 } }, ['width', 'height']),
    theme: { $ref: '#/$defs/theme' },
    present: obj(MODEL_KEYS.present, {
      numberHidden: { type: 'boolean' }, slideNumber: { type: 'boolean' }, controls: { type: 'boolean' }, progress: { type: 'boolean' },
      morphSeconds: { type: 'number', minimum: 0, maximum: 60 },
      morphEase: EASE_CHECK.schema!,
      typeWriterSeconds: { type: 'number', minimum: 0.08, maximum: 1, description: 'typewriter: seconds per character (absent = 0.08)' },
    }),
    slides: { type: 'array', minItems: 1, maxItems: LIMITS.slides, items: { $ref: '#/$defs/slide' } },
    layouts: { type: 'array', maxItems: LIMITS.slides, items: { $ref: '#/$defs/slide' }, description: 'slide templates' },
    assets: { type: 'object', maxProperties: LIMITS.assets, additionalProperties: { type: 'string', maxLength: LIMITS.asset }, description: 'key → data: URI or svg, used as asset:<key>' },
    blobs: { type: 'object', description: 'runtime-written' },
    scripts: {
      type: 'object', maxProperties: LIMITS.scripts,
      propertyNames: { pattern: '^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$' },
      additionalProperties: obj(['src'], { src: str(LIMITS.scriptSrc, 'an ES module: export const meta = {kind, params, …}; export default function …') }, ['src']),
      description: 'FORK: the deck\'s code by name. kind "effect": export default (p, base, params, ctx) => partial frame (a script effect). kind "canvas": export default (g, ctx) => void (a code canvas). Runs only in a sandbox: no network, no storage, no DOM. Guide: docs/agents.md',
      examples: [{
        hop: { src: "export const meta = { kind: 'effect', drives: ['y'], params: { height: { type: 'number', default: 80, min: 0, max: 400, unit: 'px' } } }\nexport default function hop(p, base, params) { return { y: base.y - params.height * Math.sin(p * Math.PI) } }" },
        pendulum: { src: "export const meta = { kind: 'canvas', params: { length: { type: 'number', default: 0.8, min: 0.2, max: 2, unit: 'm' } } }\nexport default function draw(g, ctx) {\n  const th = ctx.click === 0 ? 0.6 : 0.6 * Math.exp(-0.15 * ctx.t) * Math.cos(Math.sqrt(9.81 / ctx.params.length) * ctx.t)\n  const L = ctx.height * 0.75, x = ctx.width / 2 + L * Math.sin(th), y = 20 + L * Math.cos(th)\n  g.strokeStyle = '#8a94a6'; g.lineWidth = 3; g.beginPath(); g.moveTo(ctx.width / 2, 20); g.lineTo(x, y); g.stroke()\n  g.fillStyle = '#ffb86b'; g.beginPath(); g.arc(x, y, 22, 0, 2 * Math.PI); g.fill()\n}" },
      }],
    },
    fonts: { type: 'array', maxItems: LIMITS.assets, items: obj(MODEL_KEYS.font, {
      family: { type: 'string', maxLength: LIMITS.fontStack }, asset: str(LIMITS.scalar, 'asset:<key> or builtin:<name>'),
      weight: str(64), style: str(64),
    }, ['family', 'asset']) },
    modified: str(LIMITS.scalar, 'runtime-written'),
    readonly: { type: 'boolean', description: 'presentation package' },
    template: { type: 'boolean' },
    collab: { type: 'object', description: 'runtime-written credentials; never author' },
  }, ['format', 'slides'])
  ;($defs.doc.properties as Record<string, JsonSchema>).$schema = { type: 'string' }
  ;($defs.doc.properties as Record<string, JsonSchema>).compact = { const: true, description: 'input only: omitted fields take editor defaults (AGENTS.md)' }
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: SCHEMA_URL,
    title: 'bento/slides document',
    description: `The #bento-doc JSON of a Bento Slides file, generated from the app's validation tables. Guide: https://bento.page/agents.md`,
    'x-bento-version': version,
    $ref: '#/$defs/doc',
    $defs,
  }
}
