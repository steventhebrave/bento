// rock — a script effect. It runs WITH the block's move (an ordinary UI
// effect): the move slides the block along, this tilts it back and forth as
// it goes, dying away so it lands square. Only `rotation` is touched; x and
// y come through `base` from the move.
export const meta = {
  kind: 'effect',
  label: 'Rock',
  drives: ['rotation'],
  params: {
    tilt: { type: 'number', default: 8, min: 0, max: 45, step: 1, unit: '°', label: 'Tilt' },
    swings: { type: 'number', default: 3, min: 1, max: 10, step: 1, label: 'Swings' },
    damping: { type: 'number', default: 3, min: 0, max: 10, step: 0.5, label: 'Damping' },
  },
}

export default function rock(p, base, params) {
  // a damped sine that is exactly zero at both ends, so the hand-over to the
  // next effect (and the morph out of the slide) never jumps
  const envelope = Math.exp(-params.damping * p) * (1 - p)
  return { rotation: base.rotation - params.tilt * envelope * Math.sin(p * params.swings * 2 * Math.PI) }
}
