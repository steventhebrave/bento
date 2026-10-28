// swing — a code canvas: a damped pendulum, drawn where the slide's static
// rod and bob are. On arrival (click 0) it hangs still; from click 1 it has
// been nudged and swings, `ctx.t` seconds after the click. The period comes
// from the length parameter alone — T = 2π√(L/g) — which is the slide's
// point: change Length in the panel and watch the rhythm change.
export const meta = {
  kind: 'canvas',
  label: 'Pendulum',
  params: {
    length: { type: 'number', default: 1, min: 0.25, max: 4, step: 0.05, unit: 'm', label: 'Length' },
    swing: { type: 'number', default: 26, min: 0, max: 60, step: 1, unit: '°', label: 'Swing' },
    damping: { type: 'number', default: 0.08, min: 0, max: 1, step: 0.01, label: 'Damping' },
  },
}

export default function draw(g, ctx) {
  const { width: w, params } = ctx
  // the same geometry as the slide's rod (x 638–642, y 180) and bob (⌀100)
  const pivot = { x: w / 2, y: 20 }
  const L = 330
  const omega = Math.sqrt(9.81 / params.length)
  const theta = ctx.click === 0
    ? 0
    : ((params.swing * Math.PI) / 180) * Math.exp(-params.damping * ctx.t) * Math.sin(omega * ctx.t)
  const bob = { x: pivot.x + L * Math.sin(theta), y: pivot.y + L * Math.cos(theta) }
  g.lineCap = 'round'
  g.strokeStyle = '#9aa7b8'
  g.lineWidth = 4
  g.beginPath()
  g.moveTo(pivot.x, pivot.y)
  g.lineTo(bob.x, bob.y)
  g.stroke()
  g.fillStyle = '#ffb86b'
  g.beginPath()
  g.arc(bob.x, bob.y, 50, 0, 2 * Math.PI)
  g.fill()
}
