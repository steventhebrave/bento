# In-slide animations, the animation pane and the code layer — design

Fork-only feature set for bento/slides (brief: `bento-animation-prompt.md`).
Status: **proposal, awaiting the maintainer's OK.** Nothing here is built yet.

Read against upstream `9d1281c`. What the brief says exists does exist:
`fx.step` (`steps.ts`, `StepState`), `fx.enter` + `enterDur` + `order`
(`present.ts runEnterFx/enterSpec`), motion-path loops, the in-house `anim.ts`
(named eases only, manual clock), model-driven morph with a deck-wide
`present.morphSeconds` (clamped 0.1–6 on read, no UI today) and a hard-coded
`MORPH_EASE = 'power2.inOut'`. Also relevant and not in the brief: `anim.ts` has
**no rotation channel** (spin needs one), and a **`code` element type already
exists** (syntax-highlighted snippets), so "code element" cannot be the
format name for Tier 3.

---

## 1. Data model

All additions are optional fields; nothing is removed or repurposed.

```ts
// Slide
animations?: Effect[]          // present = source of truth for this slide's clicks
morph?: { duration?: number; ease?: Ease }   // per-slide; overrides the deck default

// doc.present
morphEase?: Ease               // deck default easing (morphSeconds stays the deck default duration)

// doc (top level)
scripts?: Record<string, Script>   // Tier 2/3 code, the ONLY place a document carries code

type Ease = string                                // preset: 'none', 'power1..3.in|out|inOut', 'sine.*'
          | [number, number, number, number]      // cubic-bezier, same meaning as CSS

interface Effect {
  id: string                    // stable: selection, undo, badges
  el: string                    // target element id on this slide
  type: 'appear' | 'disappear' | 'fade-in' | 'fade-out' | 'spin' | 'move'
      | 'enter'                 // legacy fx.enter kinds (see §2); not in the Add menu
      | 'script'                // Tier 2
  trigger?: 'click' | 'with' | 'after'   // default 'click' (PowerPoint's default)
  delay?: number                // s, default 0 — may be negative (no guard rails)
  duration?: number             // s, default per type; ignored by appear/disappear
  ease?: Ease
  params?: Record<string, unknown>   // per type, declared by the registry (or the script)
  script?: string               // type 'script': key into doc.scripts
}
```

Per-type `params`: `move {dx, dy}` (slide px, relative), `spin {degrees}`
(any sign, any size: −720 = two turns anticlockwise), `enter {kind}`,
`script` → whatever the script declares. Built-in effects and scripts use
**one param-spec format**, so the pane generates controls for both the same
way.

### Example slide

```json
{
  "id": "s3", "transition": "morph", "background": "#0E1116", "notes": "",
  "morph": { "duration": 1.4, "ease": [0.7, 0, 0.2, 1] },
  "elements": [ "…label-force, arrow, gear…" ],
  "animations": [
    { "id": "a1", "el": "label-force", "type": "fade-in", "duration": 0.4 },
    { "id": "a2", "el": "arrow", "type": "move", "trigger": "with", "duration": 1.2,
      "ease": "power2.inOut", "params": { "dx": 320, "dy": 0 } },
    { "id": "a3", "el": "arrow", "type": "script", "script": "damped", "trigger": "after",
      "duration": 2.5, "params": { "amplitude": 30, "frequency": 3 } },
    { "id": "a4", "el": "gear", "type": "spin", "duration": 2, "ease": "none",
      "params": { "degrees": -720 } },
    { "id": "a5", "el": "label-force", "type": "fade-out", "duration": 0.4 }
  ]
}
```

Click 1 fades the label in while the arrow moves, then the arrow wobbles (a
damped oscillation layered on the move); click 2 spins the gear twice;
click 3 fades the label out. `label-force` starts hidden because its first
effect is an entrance.

### Timeline semantics (PowerPoint's)

- Effects before the first `click` effect form **group 0** — they run when the
  slide arrives. Each `click` effect opens the next group.
- In a group: `click` and `with` start at the group start (+delay); `after`
  starts when everything so far in the group has finished (+delay).
- Frame properties: `x, y` (box top-left, slide px), `rotation` (deg, about the
  centre), `scale`, `opacity` (model opacity × visibility). Moves and spins
  **accumulate**; fades set visibility; appear/disappear set it instantly.
- `frameAt(slide, click, t)` is a **pure function** — the fold of every effect
  that has started by `start(group click) + t`, in start-time order, over the
  model frame. `stateAt(slide, click)` is the end of group `click`. Nothing
  reads the DOM. This lives in `slides/src/sequence.ts` (DOM-free, like
  `steps.ts`); each effect type is a small module in `slides/src/effects/`.

### Playback rules

- **→** plays the next group from t=0; after the last group, → leaves the slide.
- **←** snaps to `stateAt(click − 1)` (exact; no reverse animation for now).
- Arriving **backward** lands on `stateAt(last click)`, snapped (as today).
- **Reduced motion** snaps to `stateAt(click)` on every step; morphs are off as today.
- **Morph** uses effective frames at BOTH ends, not just the "from" end the brief
  names: from = `stateAt(fromSlide, its current click)`, to = the arrival state
  of the incoming slide (forward: before group 0, so entrance-hidden elements
  are hidden; backward: `stateAt(last click)`). Without the "to" half, going
  back into a slide whose arrow has moved would jump at the end of the morph.
- On a morph arrival, group 0 starts when the morph ends (PowerPoint's rule; a
  negative delay overlaps it). Effect frames compose on top of the morph
  interpolation, so an overlap cannot jump either.
- Rendering composes through `anim.ts`'s transform registry (a new "effect
  layer" beside the existing translate/rotate/scale), so effects sit on top of
  ken-burns and motion-path loops instead of fighting them. `anim.ts` gains a
  rotation channel and `cubic-bezier` eases.
- Clicker keys (→/PageDown/Space, ←/PageUp) and the speaker window already go
  through `goNext/goPrev`; the new engine plugs in where `StepState` does. The
  speaker view counter shows `click k/K`; a broadcast `nav` carries the click
  in its existing `step` field.

## 2. How the old fields map in

- **A slide with `animations`**: the list is the truth for that slide.
  `fx.step` and `fx.enter` on its elements are ignored by this shell. On every
  write the editor projects `fx.step` from the list (the click on which each
  element first appears), so an upstream shell still reveals in the right order
  — it just can't move, spin or exit. `fx.countUp` and `fx.typeWriter` are
  content effects, not list entries: they fire when their element first
  appears.
- **A slide without `animations`** plays through the **existing code path,
  untouched** — which is the only honest way to promise "exactly as before".
  The pane shows its *implicit* list, derived from `fx.step`/`fx.enter`/`order`/
  `enterDur` with the same delays and eases `runEnterFx` uses:
  `{type:'enter', params:{kind}}` per element, grouped by step. The first edit
  in the pane converts the slide to an explicit list (one undo step).
- Converted slides play the same entrances with the same offsets, durations
  and eases. One known difference: on a morph arrival, legacy entrances start
  at 40% of the morph; converted group-0 effects start when it ends (fix with a
  negative delay). Recorded in DECISIONS.md.

## 3. Animation pane

A third collapsible column docked at the right edge, beside the properties
panel — same resizer + chevron convention as the two existing panels, width
persisted, toggled from the topbar. (PowerPoint's place for it; inside the
236px properties panel a timeline is too cramped, and you will want element
properties and the pane open together.)

```
┌ Animations ──────────────────────────────────┐
│ [+ Add ▾]   [▶ Click]  [▶ Slide]   [{ } JSON]│
│ ─ Slide start ─────────────────────── 0.4s ──│
│ ⠿ Title        Fade in   ▸ with    ▕███      │
│ ─ Click 1 ─────────────────────────── 3.7s ──│
│ ⠿ Arrow        Move      ● click   ▕█████    │
│ ⠿ Arrow        ƒ damped  ↳ after   ░░░░▕████ │
│ ⠿ Force label  Fade in   ▸ with    ▕██       │
│ ─ Click 2 ─────────────────────────── 2.0s ──│
│ ⠿ Gear         Spin      ● click   ▕████████ │
│ ─────────────────────────────────────────────│
│ ◀ ━━━━━━━━━●━━━━━━━━━━━━━━━ ▶  click 1 · 0.8s│ ← scrubber
├ Arrow · Move ────────────────────────────────┤
│ Trigger  [On click ▾]                        │
│ Delay    [━●━━━━━] [0   ]  s                 │
│ Duration [━━━●━━━] [1.2 ]  s                 │
│ Easing   [power2.inOut ▾]  ┌──────┐          │
│                            │   ╭─ │ curve    │
│                            │ ╭─╯  │ editor   │
│                            └──────┘          │
│ dx [━━━━━●━] [320]   dy [━●━━━━━] [0]        │
└──────────────────────────────────────────────┘
```

- Rows grouped by click; bars on a per-group timeline (delay + duration). Drag a
  bar = delay, drag its right end = duration; exact values in the fields below.
- Drag ⠿ to reorder (re-derives groups); shift/⌘-click multi-select edits
  trigger, duration and easing together.
- Selection syncs both ways with the canvas.
- ▶ Click / ▶ Slide preview on the canvas; the scrubber seeks (click, t).
  Preview writes frames onto the canvas nodes and is cleared by any re-render,
  so the model never sees a preview frame.
- A selected Move shows its path on the canvas with a draggable end handle and
  a ghost of the element at the end. Shift snaps the direction to 15° steps
  (the editor's rotate-snap, which includes the horizontal/vertical lock of a
  Shift-drag).
- Canvas step badges show click numbers from the list (`1`, `1·3` when an
  element acts on several clicks); legacy slides keep today's badges.
- Every numeric control is a slider plus a typed box; typed values may go past
  the slider and are not clamped. Odd values (non-finite, negative duration)
  are shown as a warning on the row, never refused.

## 4. Morph timing and easing

- Slide panel, when the transition is morph: Duration and Easing, each showing
  the deck default as a placeholder until overridden. Slideshow section: the
  deck default for both.
- `anim.ts` gains `cubic-bezier` (Newton–Raphson with a bisection fallback, the
  WebKit/Chromium solver), accepted wherever an ease name is today.
- Curve editor (shared by effects and morph): an SVG square with the two control
  handles, y free to overshoot, a live preview dot that loops along the curve,
  and quick picks (the named presets drawn as curves, plus CSS `ease`,
  `ease-in-out` and an overshoot). An x outside 0–1 is allowed and labelled
  ("curve folds back; CSS would reject this").
- The existing `morphSeconds` clamp stays as-is (removing it would change old
  decks); the new per-slide values are not clamped.

## 5. Code layer

### Tier 1 — JSON escape hatch

- Every row opens as JSON (`{ }`). Applying keeps unknown keys verbatim.
- The engine understands more than the UI edits. Initially: keyframed numeric
  params (`"degrees": [{"at":0,"v":0},{"at":0.3,"v":200,"ease":"sine.out"},{"at":1,"v":720}]`),
  a spin pivot (`"origin": [0.5, 0]` — a pendulum hung from its top edge), a
  curved move (`"path": "M0,0 C…"`, relative, sampled DOM-free), and
  `repeat`/`yoyo`.
- A row whose JSON the UI can't represent shows **custom**; the controls that
  still apply (usually trigger and timing) stay editable, the rest say "set in
  JSON". UI edits patch single keys, so they can never drop what they don't
  understand. "Reset to UI-editable" (after a confirm) strips the rest.

### Tier 2 — script effects

A script lives in `doc.scripts` and is referenced by effects. Extracted to a
file it looks like this — the manifest is JSON in a leading comment, so tools
read it without running anything:

```js
/* bento:script
{ "kind": "effect", "label": "Damped oscillation",
  "drives": { "y": "modify" },
  "params": {
    "amplitude": { "type": "number", "min": 0,   "max": 200, "default": 40,  "unit": "px" },
    "frequency": { "type": "number", "min": 0.1, "max": 10,  "default": 3,   "unit": "Hz" },
    "damping":   { "type": "number", "min": 0,   "max": 10,  "default": 2.5 } } }
*/
function frame(p, base, params, ctx) {
  const a = params.amplitude * Math.exp(-params.damping * ctx.t)
  return { y: base.y + a * Math.sin(2 * Math.PI * params.frequency * ctx.t) }
}
```

- `p` eased progress; `base` the frame UI effects produce at that moment
  (`{x, y, rotation, scale, opacity}`); `ctx = { t, u, duration, random,
  el: {w, h}, slide: {w, h} }` — `t` in seconds, because physics wants real
  time, not eased progress; `random()` seeded per (deck, effect). Returns a
  partial frame; omitted properties are `base`'s.
- The UI owns trigger, delay and duration (a normal bar); the code owns what
  happens during it. The script's change to the frame at p=1 **persists** after
  it ends, like a move's (a damped wobble ends at ~0, so nothing persists).
- `drives` declares the properties written, each `modify` (composes with base:
  those controls on that element stay editable and are coloured
  "ƒ modified by damped", like an After Effects expression) or `replace` (base
  is ignored: those controls are disabled with "driven by script damped" and a
  link to it). Property-level only; never the whole element or slide.
- Param types: number (slider range = min/max; typed values unlimited), boolean,
  enum, colour. The pane builds the controls from the manifest.
- **It runs in a sandbox, not in the page** (see trust model): the host bakes
  the function — sampled at 240/s over the effect window against the base
  frames, interpolated at playback — and re-bakes when the script, its params
  or the base change. The page only ever receives numbers. Before a bake
  arrives the base frame is used, so editing a move under a script never
  stutters. The host owns the clock: scripts are called, never scheduled.

### Tier 3 — code elements

An `embed` element with `app: "script"` (not a new type: `code` is taken, and
an embed already means "static `view` that always paints + data `doc` + an
opt-in sandboxed live frame", so every shell — including upstream's — shows the
poster):

```json
{ "id": "pendulum", "type": "embed", "app": "script", "x": 760, "y": 120, "w": 400, "h": 460,
  "rotation": 0, "opacity": 1,
  "doc": { "script": "pendulum", "params": { "length": 300, "angle": 35, "damping": 0.05 } },
  "view": "asset:poster-pendulum" }
```

```js
/* bento:script
{ "kind": "element", "label": "Pendulum",
  "params": { "length": { "type": "number", "min": 50, "max": 600, "default": 300, "unit": "px" },
              "angle":  { "type": "number", "min": -90, "max": 90, "default": 35, "unit": "°" },
              "damping": { "type": "number", "min": 0, "max": 1, "default": 0.05 } },
  "poster": { "click": 1, "t": 0.6 } }
*/
function draw(ctx, now) { /* render the moment (now.click, now.t) on ctx.g */ }
```

- `now = { click, t, clicks }`, `t` = seconds since that click began; it keeps
  running after the click's UI effects end, until the next click. `draw` must
  render any (click, t) on demand — re-simulate from the start or cache in
  `ctx.state`; correctness over speed.
- `ctx = { canvas, g (2D context), width, height, dpr, params, random, state }`;
  the backing store is sized to the on-screen pixels × dpr, so it is sharp at 4K.
- Position, size, rotation and effects are the UI's, as for any element.
- Poster: drawn at `poster.click/t`, captured at 3× as a PNG inside an SVG
  `view` (an asset). Recaptured on demand and after script/param edits.
  Thumbnails, print/PDF, the file-manager preview, untrusted decks and older
  shells all show it; reduced motion shows a still drawn at the current click.

### Trust and safety — where I'd change the brief

**Recommendation: no document code ever runs in the page — both tiers run in
sandboxed iframes, and Tier 2 is baked.**

- An in-page script has the page's whole authority: the deck, its saved file
  handle (it could rewrite the file, or plant itself in your other decks via
  paste), and — because every `file://` document shares one storage origin
  (DECISIONS 2026-09-19) — every other local deck's autosave. A trust prompt
  in front of that is a high-stakes prompt.
- Sandbox: `srcdoc`, `sandbox="allow-scripts"` (no same-origin → opaque origin,
  no storage, no access to the deck), a CSP meta of `default-src 'none'` (no
  fetch, images, sockets, frames), no popups, forms or top navigation. Code
  arrives by `postMessage`, never in markup, so `</script>` can't break out.
  Honest limits: Chrome does not put WebRTC under CSP, so a script could still
  reach a STUN server and learn your IP (an external image URL in a deck can do
  that today), but it has nothing of yours to send; and an infinite loop can
  hang the tab.
- That makes the gate a consent question, not the security boundary. A deck
  with code opens with a banner: *"This deck contains code (2 scripts). It runs
  sandboxed — no network, no access to your files. [Run] [Always run this
  deck's code] [Not now]"*. Untrusted: script effects play their base, code
  elements show their poster.
- **Trust binds to the code, not the docId.** `docId` is plain data any file can
  copy, so a copy of my deck sent back with edited code would inherit trust.
  The record (`localStorage bento-code-trust`, never in the document) is
  `{ [docId]: [sha256 of each approved script] }`. Code I type in this editor
  is trusted as I type it; code that arrives by paste, agent edit or a new copy
  asks once. An opt-in "trust any code in this deck" covers the agent dev loop.
  The record lives in the shared `file://` origin, so another local file could
  write it — but that file is already running code in the origin, and trusted
  code is still sandboxed, so the record grants nothing extra.
- Paste: clip payloads may carry the scripts their effects use; the gate checks
  them as bounded strings and they arrive **unapproved** (renamed on a name
  clash). Effects and params pass as bounded plain JSON.
- `docs/format.md`'s "a document can never carry executable code" becomes:
  *code lives only in `doc.scripts`; it never runs in the page, only in a
  sandboxed network-less frame, and only after the viewer approves it on their
  machine; everything else stays pure data.* Recorded in DECISIONS.md.

### Agent round trip

```
node scripts/deck-code.mjs extract deck.bento.html work/   # → work/deck.json + work/scripts/<id>.js
node scripts/deck-code.mjs pack    work/ deck.bento.html   # ← validates, escapes `<`, splices back
node scripts/deck-code.mjs check   deck.bento.html         # schema + effect/script findings
```

`deck.json` is the pretty-printed document with each script's code replaced by
`"code": "@file scripts/<id>.js"`; `pack` reads the manifest comment as JSON and
never executes anything, so it is safe on a deck someone sent you. The JSON
schema (`schema/slides.json`, `window.bento.schema()`) covers `animations`,
`morph`, `morphEase`, `scripts` and `app: "script"` embeds, and `validate()`
reports effects on missing elements, missing scripts and bad manifests.
docs/agents.md gets a worked example for each tier.

## 6. Housekeeping

- Self-update off: `checkForUpdates` returns a "disabled in this fork" result
  and the UI hides the check/auto-check. This is kernel code, so it is off for
  every app in the fork. Signing scripts and keys untouched. Language packs
  still download from bento.page (strings only); left alone.
- Collab: untouched; `crdt.ts` not modified. Whether `animations`/`scripts`
  sync is whatever the existing slide/doc key handling does.
- No new dependencies. Estimate +25–35 KB on the compressed shell.
- English-only strings (no rig enforces catalogue completeness for new keys).
- Present mode: Reveal already hides an idle cursor after 5 s; set it to 2 s
  for clean recordings (one line).

## 7. Build order

Each phase ends with something to try; small commits on `ccr-83071fd5-0qsalh`.

1. **Engine.** Model + key table + gate + schema; `sequence.ts` + effect
   registry; `anim.ts` rotation channel, effect layer, cubic-bezier; present.ts
   playback incl. ← , backward arrival, morph from/to effective states, reduced
   motion, speaker counter. Self-update off. Rigs: state-at-click,
   format additivity (old decks: legacy path, parse→serialize unchanged),
   bezier solver. *Try: a fixture deck with an authored list, presented with
   the clicker.*
2. **Pane** + canvas move handle + badges + preview/scrub.
3. **Morph timing/easing** per slide + deck default + curve editor.
4. **Tier 1** JSON rows, custom detection, keyframes/origin/path/repeat.
5. **Tier 2** sandbox + bake + generated params + drives labels; **Tier 3**
   code elements + posters; trust banner + paste path; `deck-code.mjs`.
6. **Docs** (format.md, agents.md, DECISIONS.md) and the example deck
   (labels fading on clicks, a moving arrow, a spinning gear, a morph with a
   custom curve, a damped wobble over a move, a scrubbable pendulum).

## Open questions for the maintainer

1. Per-element morph delay/duration (staggered morphs): build it, and in which
   phase? (The brief asks me to ask first.)
2. OK to run Tier 2 sandboxed and baked instead of in the page (§5)?
