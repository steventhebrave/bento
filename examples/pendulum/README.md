# Why a pendulum keeps time — an example deck

A three-slide science deck that exercises this fork's animation and code
layer. It is kept as source: `deck.json` (the document, compact form) and
`scripts/*.js` (its code). Pack it into a single `.bento.html` (the first
time, run `npm install` in `slides/` before building):

```sh
cd slides
npm run build:single
cd ..
node scripts/deck-code.mjs pack examples/pendulum examples/pendulum/pendulum.bento.html --shell slides/dist-single/Bento_Slides.bento.html
```

(The same commands work in PowerShell, cmd and any Unix shell.) Open
`examples/pendulum/pendulum.bento.html` in a current browser — it works
offline; packed decks under `examples/` are git-ignored.
The first open captures the code canvas's still picture; save (⌘S, or Ctrl+S
on Windows) to keep it in the file.

## What each slide shows

1. **Title.** The subtitle fades in on arrival. Click 1: the gear spins two
   full turns on a custom cubic-bezier while the caption fades in with it.
2. **Push.** The gear morphs into the corner on a slow-start curve (its two
   turns do not unwind). Click 1: the arrow pushes the block — an ordinary
   Move effect, with the `rock` script effect running alongside it (a damped
   tilt that dies away). Click 2: the displacement label. Click 3: the labels
   and arrow leave together; the block stays where it was pushed.
3. **Swing.** The block morphs into the pendulum's bob from where the push
   left it. Click 1: the `swing` code canvas takes over from the static rod
   and bob and swings, damped; then the labels.

## Things to try in the editor

- **Animate tab** (right panel): the click-by-click list. Drag bars to change
  delays and durations; click an easing to open the curve editor.
- On slide 3, set the scrubber to **Click 1** and drag it: the pendulum is a
  pure function of the click and the time, so it scrubs both ways.
- Select the pendulum and change **Length** in the Format panel: the period
  follows T = 2π√(L/g).
- On slide 2, select the `rock` effect: its Tilt and Swings are generated
  from the script's `meta.params`.
- **Code** in the top bar → **Deck code…** to read or edit both scripts.
  The **ƒ Code** chip turns deck code off for this browser: the canvas shows
  its still and the block slides without rocking.

## Editing the code as files

```sh
node scripts/deck-code.mjs extract examples/pendulum/pendulum.bento.html examples/pendulum
node scripts/deck-code.mjs pack examples/pendulum examples/pendulum/pendulum.bento.html
```

`extract` writes `deck.json` (the full form, replacing the compact one here)
and one `scripts/<name>.js` per script; `pack` checks each script parses as a
module before writing anything.
