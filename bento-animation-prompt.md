# Task: in-slide animations, an animation pane and a code layer for my fork of bento/slides

## Context

I'm a science presenter. I use slides in live shows to explain physical concepts, and I've been doing it in PowerPoint, whose animation tools fight me. This repo is my fork of bento/slides (upstream: github.com/nyblnet/bento). I chose it because a deck is a single offline HTML file, the document is JSON that agents can edit, and its morph transitions are good. I want to add what's missing for my use. The fork is for my own shows; I don't plan to upstream it, but keep it clean enough that I could.

Before starting, read: `CLAUDE.md`, `AGENTS.md`, `docs/PLATFORM.md`, `docs/DECISIONS.md` (long — search it), `docs/format.md` and `docs/agents.md`. Follow their hard rules and testing gotchas; each one exists because it broke something.

## What already exists (read from upstream commit 9d1281c — verify)

- **Click reveals:** `fx.step` in `slides/src/model.ts`, decisions in `slides/src/steps.ts`. A reveal runs the element's `fx.enter`; ← hides the last step. Step-number badges on the canvas (`editor/stepbadges.ts`, `editor/reveal.ts`).
- **Entrance effects:** `fx.enter` (fades and slides) with `enterDur` and a stagger `order`, run when a slide appears.
- **Motion paths:** only as looping ambient motion (`fx.loop` type `motion-path`), with a good bezier path editor (`editor/patheditor.ts`).
- **Animation engine:** `kernel/src/anim.ts` — in-house, no GSAP. Named eases only (power1–3, sine). Manual clock for tests.
- **Morph:** in `slides/src/present.ts`. Model-driven (no DOM measuring). Duration is deck-wide (`doc.present.morphSeconds`); easing is hard-coded (`MORPH_EASE = 'power2.inOut'`).
- **Missing:** exit animations, spin, click-triggered motion, an animation pane, per-slide morph timing, any morph easing control.
- **Format rule:** docs/format.md says "a document can never carry executable code". Part 4 below deliberately changes that for this fork, so handle it carefully.

## What I want

### 1. In-slide animation sequence

A per-slide ordered list of effects, like PowerPoint's animation pane, but with only these effect types for now:

- Appear and Disappear (instant)
- Fade in and Fade out
- Spin (rotate by any number of degrees, either direction, including several turns)
- Move in a straight line (relative offset dx, dy)

Each effect has: target element, trigger (On click / With previous / After previous), delay, duration and easing.

Do not copy PowerPoint's whole effect catalogue. Build an effect registry so that adding a new effect type later is one small module plus a panel entry.

Behaviour rules:

- An element whose first effect is an entrance (Appear or Fade in) starts hidden, as in PowerPoint.
- Effects accumulate: after a move or spin, the element stays at its new position or angle for later clicks.
- The state at any click must be a pure function of (slide, click number), computed from the effect list, never from whatever the DOM currently looks like. This makes ← exact, lets reduced-motion jump straight to end states, lets the speaker view preview the next click if we want that later, and is what the code layer (part 4) hooks into.
- ← goes back one click and restores that click's state exactly (snapping is fine; reverse-animating is optional).
- → after the last click goes to the next slide. If the transition is morph, the morph must start from each element's end-of-slide state (after its moves, spins and fades), not from its model rest position, otherwise it jumps. Morph is model-driven today; extend it so the "from" frame is the model frame plus this slide's effects at their final click.
- Existing decks must play exactly as before, and `fx.step` / `fx.enter` must keep working. Decide how they relate to the new list (my expectation: the new list is the source of truth when present; otherwise the old fields are read as an implicit list). Never remove or repurpose existing fields (format additivity). Record the decision in DECISIONS.md.
- Clicks must work from a presentation clicker (they send arrow/PageUp/PageDown keys) and from the speaker window.

### 2. Animation pane

An editor panel (beside or inside the right-hand properties panel — your call, follow existing panel conventions) that:

- Lists the slide's effects grouped by click, showing element name, effect type and trigger.
- Shows each effect as a bar on a small timeline within its click group (delay plus duration). Dragging the bar changes the delay; dragging its end changes the duration. Exact numbers are also editable in fields.
- Reorders by drag; supports multi-select to set trigger, duration or easing on several effects at once.
- Keeps selection in sync both ways: selecting a row selects the element on the canvas and vice versa.
- Previews one click group or the whole slide in the editor, with scrubbing.
- Has "Add animation" for the selected element(s).
- For straight-line moves: when the effect is selected, shows the path on the canvas with a draggable end handle and a ghost of the element at the end position. Shift snaps the angle (match the editor's existing Shift conventions).
- Updates the existing canvas step badges to show click numbers from the new system.

### 3. Morph timing and easing

- Per-slide morph duration and easing, overriding the deck default (which also stays editable).
- Easing everywhere (effects and morph) is either a named preset or a custom cubic-bezier curve, edited with a small curve editor (two draggable handles, live preview). Add cubic-bezier support to `kernel/src/anim.ts`, stored as `[x1, y1, x2, y2]` with the same meaning as CSS `cubic-bezier()`. PowerPoint doesn't let you edit morph easing and it's one of my main frustrations, so get this one right.
- Nice to have, ask before building: per-element morph delay and duration, so morphs can stagger.

### 4. Code layer: tweak animations with code without fighting the UI

This is the part I most want you to think about rather than just implement. The goal: an agent (or I) can make an animation more complex with code, the UI can't break that animation, and the code doesn't make the UI janky. My naive idea was "lock the UI for anything code has touched". Treat that as a last resort. Below is the direction I'd like, based on tools that do this well (After Effects expressions; Framer and Unity components with exposed properties; Bento's own chart editor with its "Advanced (JSON)" escape hatch and its "custom" shadow state). Push back if you see a better design.

**Tier 1 — JSON escape hatch (no code).** Every effect can be opened as JSON. If someone writes values the UI can't represent (keyframe arrays, say), the row shows as "custom". The UI never rewrites or drops those values, but still lets you edit what it can (usually the timing). A "Reset to UI-editable" action converts it back, after a confirm. Many "complex" needs should be solvable here without code.

**Tier 2 — script effects.** An effect type whose motion is a JavaScript function. Ownership is split: the UI owns *when* (trigger, delay, duration — it's a normal bar in the pane); the code owns *what happens during it*. Refine this contract as needed:

- A pure function of progress: `(p, base, params, ctx) => frame`. `p` is 0–1 after easing; `base` is the frame the UI-authored effects would produce at that moment; it returns a modified frame (x, y, rotation, scale, opacity, colour…). Like an After Effects expression, code modifies rather than replaces, so UI animations still compose with it.
- The script declares its parameters with types, ranges and defaults (e.g. `amplitude: number 0–200, default 40`). The pane generates controls from them, so most tweaking happens in the UI without touching code.
- The script declares which properties it drives. Only those controls are disabled on that element, with a visible "driven by script <name>" label and a link to the script, like After Effects colouring an expression-driven property. Lock at the property level, never the whole element or slide.
- The host owns the clock: no timers, no `requestAnimationFrame`, no unseeded `Math.random` in scripts. That's what keeps scrubbing, ←, previews, reduced motion and the existing settle guarantee working. Provide a seeded `ctx.random` and whatever else scripts genuinely need.

**Tier 3 — code elements.** A new element type for things the effect model can't express (a physics simulation, a plotted function, a particle field). Position, size, rotation and effects are owned by the UI like any element; what's drawn inside is owned by code.

- The host tells it the current click, the time within that click and its params. It must be able to seek to any click and time (simulations may re-simulate from the start or cache — correctness over speed).
- Same rule as Tier 2: declared params become generated controls.
- It needs a static fallback (a poster frame, ideally captured automatically at a chosen click and time) for thumbnails, print/PDF, the file-manager preview and reduced motion, because those render without running code.

**Trust and safety.** Bento deliberately treats documents as data that can't carry code, and opening a deck someone sends me shouldn't run their code silently. My expectation (propose better if you have it):

- Code elements run in a sandboxed iframe (`srcdoc`, `allow-scripts` without `allow-same-origin`; render.ts already makes a sandboxed frame for web embeds), driven by postMessage, offline, no network.
- Script effects run in the page only for decks I've marked as trusted on this machine (trust stored per `docId` in localStorage, never in the document). Untrusted decks show a banner and play with scripts replaced by their base/static fallback.
- The paste gate (`untrusted.ts`, generated from the model key table) keeps stripping code from pasted content unless you design a safe path.
- Record the trust model in DECISIONS.md and update the "pure data" rule in docs/format.md to describe this fork's actual rule.

**Agent-friendliness.** Scripts must live inside the single `.bento.html` file (that's the point of Bento), but editing JavaScript inside a JSON string is miserable for agents and humans. Provide a round trip, for example `node scripts/deck-code.mjs extract deck.bento.html` to write plain `.js` files to a folder and `pack` to put them back (or a better design). Update docs/agents.md and the JSON schema (the schema build and `window.bento.schema()`) so an agent can author effects, scripts and code elements by editing files, with worked examples.

### 5. Fork housekeeping

- Disable the signed self-update in this fork (`kernel/src/update.ts`). Otherwise "update" would re-splice my decks into the upstream shell and silently drop everything above. Don't touch the release-signing scripts or keys.
- Live collaboration: leave it alone and don't break it, but don't spend effort on it — I won't use it.
- Bundle size: the repo deliberately avoids big libraries and has size budgets (`scripts/size-budgets.json`). Ask before adding any dependency.
- English-only UI strings are fine (`t()` falls back to English) unless a test enforces the catalogues.

## How to work

1. **Plan first and wait for my OK.** Read the docs and code paths above, then give me a short design: the data model (with an example slide in JSON), how the old `fx.step`/`fx.enter` fields map in, the pane layout (a rough sketch is fine), the Tier 2 and Tier 3 contracts, the trust model and the build order. Flag anything in this brief you think is wrong.
2. **Build in phases**, each ending in something I can try:
   1. Data model and playback engine (pure state-at-click functions, DOM-free like `steps.ts`) with tests.
   2. Animation pane and the on-canvas motion-path handle.
   3. Morph timing and easing, cubic-bezier support and the curve editor.
   4. Tier 1 JSON escape hatch.
   5. Tier 2 script effects, then Tier 3 code elements, then the extract/pack tool.
   6. Docs (format.md, agents.md, DECISIONS.md) and an example deck.
3. **Example deck:** a short science explainer that exercises everything — labels fading in and out on clicks, an arrow moving in a straight line, a gear spinning, a morph with a custom easing curve, a script effect (e.g. a damped oscillation layered on top of a UI-authored move) and a code element (e.g. a pendulum drawn on a canvas that swings during a click and can be scrubbed).
4. **Verify the way the repo says to:** measure motion (`getBoundingClientRect`, or anim's manual clock plus `tick()`), never by reading back styles you just wrote; watch for hidden tabs throttling animation frames. Run the existing test scripts, plus new ones for the state-at-click logic and for format additivity (old decks unchanged). Build with `npm run build:single` and check the result opens and presents offline from a local file.
5. **Small commits on a branch.** When a phase is ready, tell me what to open and what to click to try it.

## Done means

- I can build a slide in the UI where clicks make things appear, disappear, fade, spin and move; set timings and easing in a pane; and present it with a clicker forwards and backwards with no jumps, including into a morph.
- I can set morph duration and easing per slide with a curve editor.
- An agent can add a script effect or a code element by editing files; its parameters show up as controls in the pane; I can tweak them there; and nothing I do in the UI breaks it.
- Old decks open and play exactly as before, and the single-file build works offline.
