# In-slide animation, animation pane, code layer — design (fork)

Status: **proposal, awaiting the maintainer's OK.** Nothing here is built yet.
Read against upstream 9d1281c (verified: `fx.step` in model.ts + steps.ts,
`fx.enter`/`enterDur`/`order`, `fx.loop` motion paths, kernel `anim.ts` with
named eases only, `MORPH_EASE = 'power2.inOut'` hard-coded, deck-wide
`present.morphSeconds` with no UI).

## 1. Data model

Everything is additive and optional. A deck that uses none of it serialises
byte-identically.

```jsonc
// doc-level
"present": { "morphSeconds": 0.65, "morphEase": "power2.inOut" },   // morphEase is new
"scripts": {                                                          // new: the code store
  "damped-wobble": { "src": "export const meta = {…}\nexport default function (p, base, params, ctx) {…}" },
  "pendulum":      { "src": "export const meta = {…}\nexport default function draw(g, ctx) {…}" }
},

// one slide
{
  "id": "s-forces", "transition": "morph",
  "morphSeconds": 1.2,                    // new: per-slide override of the INCOMING morph
  "morphEase": [0.7, 0, 0.2, 1],          // new: named preset or CSS-style cubic-bezier
  "elements": [
    { "id": "label-f", "type": "text", … },
    { "id": "arrow",   "type": "shape", "shape": "arrow", … },
    { "id": "gear",    "type": "svg", … },
    { "id": "pend", "type": "canvas", "x": 760, "y": 140, "w": 400, "h": 420,   // new element type
      "script": "pendulum", "params": { "length": 1.2, "startDeg": 30 },
      "poster": "asset:poster-pend", "posterAt": { "click": 2, "t": 1.5 } }
  ],
  "anim": [                               // new: the ordered effect list (source of truth when present)
    { "id": "a1", "el": "label-f", "type": "fade-in",  "trigger": "click", "duration": 0.4 },
    { "id": "a2", "el": "arrow",   "type": "move",     "trigger": "with",  "dx": 320, "dy": 0, "duration": 0.8, "ease": "power2.out" },
    { "id": "a3", "el": "arrow",   "type": "script",   "trigger": "after", "script": "damped-wobble",
      "duration": 1.6, "params": { "amplitude": 30, "frequency": 3 } },
    { "id": "a4", "el": "gear",    "type": "spin",     "trigger": "click", "deg": 720, "duration": 2, "ease": [0.3, 0, 0.2, 1] },
    { "id": "a5", "el": "label-f", "type": "fade-out", "trigger": "with",  "delay": 0.5, "duration": 0.4 }
  ]
}
```

**Effect** = `{ id, el, type, trigger?, delay?, duration?, ease?, …type keys }`.
Defaults: trigger `click`, delay 0, duration/ease per type (appear/disappear are
instant). Type keys: `spin.deg` (signed, any size: 720 = two turns clockwise),
`move.dx/dy` (relative, slide px), `script.script/params`.

**Ease** everywhere = a kernel preset name (`power2.out`, `sine.inOut`, … plus
CSS's `ease`, `ease-in`, `ease-out`, `ease-in-out`) or `[x1, y1, x2, y2]` with
CSS `cubic-bezier()` meaning (x clamped to 0–1, y free so overshoot works).

### Timing (PowerPoint semantics)

- Each `click` effect opens a new click group. Effects before the first `click`
  effect form group 0, which plays automatically on arrival.
- `with` starts on the same anchor as the previous effect; `after` starts when
  the previous effect ends; `delay` is added to the anchor.
- Clicks = number of `click` effects. → past the last click leaves the slide.
- → while a group is still playing snaps it to its end and starts the next
  (one press = one click, which is what a clicker needs).

### State is a pure function

`stateAt(slide, click, t) → Map<elementId, {o, dx, dy, rot, scale, fill?, color?}>`
is a left fold over the list: groups before `click` at p = 1, group `click` at
time `t`, later groups skipped; an effect that has not started is identity.
Each type is `apply(stateBefore, p, effect) → state`, so concurrent effects on
one element compose (spin *with* move works) and everything accumulates.
Rule: an element whose first effect is an entrance (appear, fade-in) starts
with o = 0. `frameOf(element, state)` = model frame + state. No DOM is read,
ever — the same function drives present, ←, reduced motion (jump to end),
editor preview/scrub, and the morph's from-frame.

DOM-free in `slides/src/animseq.ts`, rig `scripts/test-slides-animseq.ts`.

### Effect registry

`slides/src/effects/<type>.ts`, one module each: `{ type, label, kind:
entrance|exit|emphasis|motion|script, defaults, keys (gate checks), apply,
isCustom }`, plus one panel entry in `editor/animpane-fields.ts`. The gate,
the schema and the "custom" detection all read `keys` from the registry, so a
new type is one module + one panel entry.

### How `fx.step` / `fx.enter` relate

- **No `anim` on a slide → the legacy runtime runs, untouched.** I am keeping
  the old code path rather than re-expressing it through the new engine: the
  legacy behaviour has a dozen subtleties (stagger by `order`-or-index, the
  0.12 s lead, reveal-fade for steps with no `enter`, morph-arrival entrances
  at 40% of the morph, count-up and typewriter hooks, the settle guarantee),
  and "plays exactly as before" is only provable if that code doesn't change.
- The pane shows those fields as an **implicit list** (rows derived from
  `fx.enter`/`order`/`enterDur`/`step`, exact delays included). The first edit
  on such a slide converts it to an explicit `anim` list in one undo step,
  with a toast saying so. Conversion needs one extra key: `fade-in` takes
  optional `fromDx/fromDy` (travel in while fading), which expresses all seven
  `fx.enter` kinds exactly.
- With `anim` present, `fx.step`, `fx.enter`, `fx.order`, `fx.enterDur` are
  ignored *on that slide* and never deleted. `countUp`/`typeWriter` keep
  working and fire when the element's entrance starts. `fx.loop`/ken-burns
  are untouched (validate() warns on spin + motion-path loop: both want the
  transform).
- Decided in DECISIONS.md.

### Morph

- runMorph takes **frames, not model elements**: from = `frameAt(fromSlide,
  click we left at)`, to = `frameAt(toSlide, click we arrive at)` (forward:
  last → 0; backward: 0 → last). For a legacy slide these are exactly the
  model frames, so nothing changes there.
- One transform builder is shared by the morph and the player, so the morph's
  last frame is the player's first.
- Rotation morphs by the **shortest path** from the end-of-slide angle
  (a gear left at 720° must not unwind two turns into the next slide).
- Duration/ease = `slide.morphSeconds/morphEase` ?? `present.morphSeconds/
  morphEase` ?? 0.65 / power2.inOut. Group 0 of a morph-arrived slide starts
  when the morph ends.

## 2. Animation pane

A **Format | Animate** tab strip at the top of the right panel (existing
panel conventions: `.ed-section` accordion, localStorage-persisted state); the
Animate tab widens the panel to ≥ 320 px while it's open.

```
┌ Format │ Animate ───────────────────────────┐
│ [+ Add animation ▾]   ▶ Slide   ▶ Click      │
│ On arrival                                   │
│ ⋮ Title      Fade in        ▕▓▓▒▒▏           │
│ Click 1                                  ▶   │
│ ⋮ Label F    Fade in        ▕▓▓▏             │
│ ⋮ Arrow      Move →    with ▕▓▓▓▓▓▏          │
│ ⋮ Arrow      ƒ wobble after       ▕▓▓▓▓▓▓▏   │
│ Click 2                                  ▶   │
│ ⋮ Gear       Spin 720°      ▕▓▓▓▓▓▓▓▓▓▓▏     │
│ ⋮ Label F    Fade out  with   ▕▓▓▏           │
│ ├──────●───────────────────┤  1.2 / 2.0 s    │  ← scrubber (group or slide)
│ Effect · 2 selected                          │
│  Trigger  [With previous ▾]                  │
│  Delay [0.50] s    Duration [0.40] s         │
│  Easing   [power2.out ▾]  ⤷ curve editor     │
│  (type fields / script params here)          │
│  Advanced (JSON) ▸                           │
└──────────────────────────────────────────────┘
```

- Bars share one px-per-second scale; drag body = delay, drag right edge =
  duration; numbers editable below. Rows reorder by drag (trigger is kept,
  PowerPoint-style); shift/⌘-click multi-select edits trigger, delay,
  duration, easing together.
- Selection is two-way: a row selects its element on the canvas; selecting an
  element highlights its rows.
- Preview/scrub renders on the canvas through `stateAt` (no commits, Moveable
  hidden while previewing).
- Move effect selected → dashed path from the element's position *before* the
  effect to its end, a ghost at the end, a draggable end handle; Shift snaps
  to 15° (the editor's rotate-snap step).
- Step badges show the new click numbers (e.g. `1·3`) on `anim` slides and
  open the Animate tab on click; legacy slides keep today's badges.

## 3. Morph timing and easing

- Slide panel (transition = morph): Morph duration + Morph easing, blank =
  deck default. Slideshow section: the deck defaults (morphSeconds finally
  gets a UI).
- Curve editor (`editor/easecurve.ts`, shared by effects and morph): 2
  draggable handles on a unit square, numeric fields, preset dropdown, live
  preview dot; y may leave the square for overshoot.
- `kernel/src/anim.ts`: `ease` accepts `string | [x1,y1,x2,y2]`;
  cubic-bezier solved like WebKit's UnitBezier (Newton + bisection fallback).
  Own small kernel commit; rig `scripts/test-anim-bezier.ts`.

## 4. Code layer

### Tier 1 — JSON escape hatch

Every effect has an *Advanced (JSON)* box. The UI edits only the keys its
registry entry owns and merges, never rebuilds, so foreign keys survive. A
row is **custom** when it carries keys its type doesn't own or values the UI
can't show; custom rows still edit timing. *Reset to UI-editable* (confirm)
drops the unknown keys. The engine plays more than the UI edits:
`keys: [{ at, dx, dy } …]` on move, `[{ at, deg }]` on spin, `[{ at, opacity }]`
on fades, per-segment `ease` — keyframes without code.

### Tier 2 — script effects

```js
// scripts/damped-wobble.js
export const meta = {
  kind: 'effect',
  label: 'Damped wobble',
  drives: ['x', 'y'],                   // only these keys of the return value are used
  params: {
    amplitude: { type: 'number', min: 0, max: 200, default: 40, unit: 'px' },
    frequency: { type: 'number', min: 0.1, max: 10, default: 3, unit: 'Hz' },
    decay:     { type: 'number', min: 0, max: 10, default: 2.5 },
    axis:      { type: 'select', options: ['x', 'y'], default: 'x' },
  },
}
export default function wobble(p, base, params, ctx) {
  const a = params.amplitude * Math.exp(-params.decay * ctx.t) * Math.sin(2 * Math.PI * params.frequency * ctx.t)
  return { [params.axis]: base[params.axis] + a }
}
```

- `p`: the effect's eased progress 0–1. `base`: `{x, y, w, h, rotation,
  scale, opacity, fill?, color?}` in slide px/deg — what the UI-authored effects
  before it in the list produce at that instant. `ctx`: `{ t` (seconds since
  the effect started, *un-eased* — physics wants real time), `duration, click,
  el:{w,h}, slide:{w,h}, random()` (seeded per effect), `noise(x)` (seeded,
  smooth) `}`. Returns a partial frame; the end frame (p = 1) persists.
- UI owns trigger/delay/duration/ease (a normal bar); `meta.params` become
  controls in the effect inspector.
- **Driven properties are labelled, not disabled.** The script modifies
  `base`, so the element's own x/y/rotation and earlier UI effects still matter
  — exactly After Effects' rule (an expression-driven property stays editable
  and feeds `value`). The Format panel shows "driven by ƒ damped-wobble on
  click 1 →" on those rows, linking to the effect.
- **Host owns the clock, enforced rather than requested**: the script never
  runs in the page. The sandbox evaluates it at fixed samples (~120/s, capped)
  whenever its inputs change and playback interpolates the returned frames.
  Inside the sandbox `Math.random` is seeded and `Date`/`performance` are
  frozen, so even careless code is deterministic. A bake that doesn't return
  within ~250 ms has its worker terminated; the effect plays as base and the
  pane shows the error.

### Tier 3 — canvas elements (`type: "canvas"`; `code` is already the snippet element)

```js
// scripts/pendulum.js
export const meta = {
  kind: 'canvas',
  params: { length: { type: 'number', min: 0.2, max: 3, default: 1, unit: 'm' },
            startDeg: { type: 'number', min: -80, max: 80, default: 30 } },
  duration: { 2: 8 },        // optional: seconds of motion per click (scrub range, poster, CPU)
}
export default function draw(g, ctx) {
  // g: 2D context, units = element px. ctx: { click, t, params, width, height, random, noise }
}
```

- Frame, size, rotation and UI effects belong to the element like any other;
  the pixels belong to the code. The host sends `{click, t}` (t = seconds since
  that click began) each frame while visible, or on every scrub; seeking is
  random-access, so a simulation may re-simulate from 0 or memoise.
- Static fallback: `poster` is captured in the sandbox at `posterAt` and stored
  as an asset. Thumbnails, print/PDF, the file-manager preview and code-off use
  it; reduced motion draws one still per click (end of that click's motion),
  with no ticking.
- Editor canvas shows the poster; a live overlay frame (a separate layer,
  like the step badges, so canvas re-renders never reload it) runs while
  previewing, scrubbing, or with "Live" toggled on in the element's panel.

### Trust and safety — I'd change the brief here

**Proposal: document code never runs in the page — trusted or not.** Both
tiers run in `sandbox="allow-scripts"` srcdoc iframes (opaque origin: no
storage, no cookies, no host DOM) under a CSP of `default-src 'none'` (no
network), and the author's code itself runs in a Worker inside that (no DOM,
cannot navigate the frame, can be killed). Probed in this repo's Chromium
today: `fetch` is refused by CSP (violation event, not a CORS failure),
IndexedDB and localStorage throw SecurityError, an ES module loads from a blob
URL, and OffscreenCanvas → PNG works for posters. (Safari/Firefox to be
checked on your machine; the APIs are all baseline 2023.)

Why not "trusted per docId in localStorage": on `file://` every deck shares
one storage origin (DECISIONS 2026-09-19 — "no boot-time trust decision is
taken from one"), so any local file can set that flag; and the docId is the
deck's identity, shared by every copy and every collaborator, so trusting it
blesses future code rather than the code you looked at.

With the sandbox, trust stops being a security boundary and becomes a
preference. Options for what a viewer sees (your call, question 1):

- **(a) Recommended — run by default, visibly.** A "ƒ This deck runs code (3)"
  chip in the editor and the speaker view; one viewer-scoped switch, "Run deck
  code", next to reduce-motion (`bento-code`, localStorage, never in the
  document). Off = static fallbacks everywhere.
- **(b) Ask once per deck.** Same as (a) but code starts off on a deck this
  browser hasn't seen, with an Allow banner. Safer-feeling, but it can bite on
  show day: a venue laptop and a player file mean code stays off until
  someone finds the banner.

Paste gate: clipboard pastes keep dropping code (`doc.scripts` never rides a
clip). A pasted script effect keeps its `script` name and plays if the target
deck has a script by that name, otherwise as base, so copy/paste inside one
deck just works. Replace from JSON, `loadDoc`, file open and recovery carry
`doc.scripts` through the gate as bounded strings, because they're deliberate
and the code only ever runs sandboxed.

format.md's "a document can never carry executable code" becomes: *a
document may carry code in `doc.scripts`; every reader treats it as inert
data, and the reference runtime executes it only in a network-less,
storage-less sandbox, never with the document's privileges.*

### Agent round-trip

`node scripts/deck-code.mjs extract deck.bento.html [dir]` writes
`dir/deck.json` (the document, pretty-printed, each script's `src` replaced by
`"@file scripts/<name>.js"`) and `dir/scripts/<name>.js`.
`node scripts/deck-code.mjs pack dir [deck.bento.html]` re-inlines, parses
every script as a module, checks `meta`, escapes `<` as `<` and splices
the block back (splice contract untouched). `new <name> --kind effect|canvas`
writes a template. The JSON schema (`build-schema.mjs`, `window.bento.schema()`)
gains `anim`, `morphSeconds/morphEase`, `scripts` and the canvas element, and
docs/agents.md gets worked examples.

## 5. Fork housekeeping

- Self-update off: `SELF_UPDATE = false` in kernel/src/update.ts. Checks
  return a "disabled in this fork" result, apply/build refuse, the editor hides
  the update chip and the launch check. Signing scripts and keys untouched.
  Language packs still come from the signed channel; they never re-splice
  the deck.
- No new dependencies. Collab untouched; `scripts` is classed as content in
  docclass.ts so a live session wouldn't drop it, and `anim` rides as a
  whole-value register (last writer wins).
- English-only strings (nothing gates on catalogue completeness for keys
  that aren't in a catalogue yet).

## 6. Build order (each ends in something to try)

1. **Model + engine**: types, registry, `animseq.ts`, gate/schema/modelkeys,
   present-mode player (clicker, speaker window, ←, reduced motion, settle
   guarantee), morph from end-state, A/B rig against upstream's shell for old
   decks. *Try:* an example JSON deck, present it with arrows.
2. **Pane + canvas move handle** (+ badges, implicit list + conversion).
3. **Morph timing/easing**, cubic-bezier in the kernel, curve editor.
4. **Tier 1** JSON box, custom rows, keyframe values.
5. **Sandbox → Tier 2 → Tier 3 → deck-code.mjs.**
6. **Docs** (format.md, agents.md, DECISIONS.md) and the example deck
   (labels fading on clicks, a moving arrow, a spinning gear, a custom-eased
   morph, a damped wobble on top of a UI move, a scrubbable pendulum canvas).

Verification per the repo: motion measured with `getBoundingClientRect` on the
manual clock, never by reading back styles; tab visibility checked; existing
rigs + new ones (animseq, bezier, additivity/A-B, sandbox isolation);
`npm run build:single`, opened and presented offline from `file://`.
