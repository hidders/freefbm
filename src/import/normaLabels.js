// Where NORMA draws the labels of a shape: the reading of a fact type, value
// and cardinality ranges, the name of an objectified fact type. NORMA keeps
// each as a shape of its own (a RelativeShape) with its bounds in the diagram,
// placed freely by the user. FreeFBM keeps them as free offsets too, but its
// boxes and fonts have other sizes, so a label is placed by its relation to
// the shape: the side it is on, its gap from that side and how it lines up
// along it (left, centre, right; top, middle, bottom), measured from
// FreeFBM's own box and label size. A label that overlaps its shape keeps
// its centre's offset.

import { nestedFactBounds, factBounds, getDisplayReading, roleCenter } from '../components/FactTypeNode.jsx'
import { formatValueRange, formatCardinalityRange } from '../components/ObjectTypeNode.jsx'

const FONT = "'Segoe UI', Helvetica, Arial, sans-serif"
let canvas = null
function textWidth(text, size) {
  try {
    if (!canvas && typeof document !== 'undefined') canvas = document.createElement('canvas')
    const ctx = canvas?.getContext('2d')
    if (ctx) { ctx.font = `${size}px ${FONT}`; return ctx.measureText(text).width }
  } catch { /* no canvas: estimate */ }
  return text.length * size * 0.55
}

const TOUCH = 6   // px a label may reach into its shape and still count as beside it

// L, S: NORMA label and shape rectangles { l, t, r, b } in px. box: FreeFBM's
// drawn box { l, t, r, b } relative to the shape's centre point, which both
// drawings share. size: FreeFBM's label { w, h }. Gives the label's centre
// relative to that point, and the side it is on (null when it overlaps).
export function placeLabel(L, S, box, size) {
  const cx = (S.l + S.r) / 2, cy = (S.t + S.b) / 2
  const l = { l: L.l - cx, r: L.r - cx, t: L.t - cy, b: L.b - cy }
  const s = { l: S.l - cx, r: S.r - cx, t: S.t - cy, b: S.b - cy }
  const gaps = { below: l.t - s.b, above: s.t - l.b, right: l.l - s.r, left: s.l - l.r }
  const side = Object.keys(gaps).reduce((a, k) => gaps[k] > gaps[a] ? k : a, 'below')
  if (gaps[side] < -TOUCH) return { x: (l.l + l.r) / 2, y: (l.t + l.b) / 2, side: null }
  const gap = Math.max(gaps[side], 0)
  // alignment along the side: the edge (or centre) the label is closest to lining up with
  const align = (lo, hi, slo, shi, blo, bhi, len) => {
    const devs = [[lo - slo, d => blo + d + len / 2], [(lo + hi) / 2 - (slo + shi) / 2, d => (blo + bhi) / 2 + d],
      [hi - shi, d => bhi + d - len / 2]]
    const [d, at] = devs.reduce((a, x) => Math.abs(x[0]) < Math.abs(a[0]) ? x : a)
    return at(d)
  }
  if (side === 'below' || side === 'above') {
    const x = align(l.l, l.r, s.l, s.r, box.l, box.r, size.w)
    return { x, y: side === 'below' ? box.b + gap + size.h / 2 : box.t - gap - size.h / 2, side }
  }
  const y = align(l.t, l.b, s.t, s.b, box.t, box.b, size.h)
  return { x: side === 'right' ? box.r + gap + size.w / 2 : box.l - gap - size.w / 2, y, side }
}

const relative = (b, x, y) => ({ l: b.left - x, r: b.right - x, t: b.top - y, b: b.bottom - y })

// FreeFBM's box of a fact type occurrence (roles and uniqueness bars; for an
// objectified one the box around it), relative to the occurrence's point.
export function factLabelBox(fact) {
  const f = { ...fact, x: 0, y: 0 }
  if (f.objectified) return relative(nestedFactBounds(f), 0, 0)
  const b = relative(factBounds(f), 0, 0)
  // factBounds leaves room for a reading below a horizontal fact type
  if (f.orientation !== 'vertical') b.b -= 18
  return b
}

export function readingLabelSize(fact) {
  return { w: textWidth(getDisplayReading(fact) || '', 14), h: 16 }
}

export function rangeLabelSize(range, cardinality = false) {
  const text = (cardinality ? formatCardinalityRange(range) : formatValueRange(range)) ?? ''
  return { w: textWidth(text, 13) + 6, h: 19 }
}

export function nameLabelSize(name) {
  return { w: textWidth(`“${name}”`, 18), h: 22 }
}

// FreeFBM's object type box (ObjectTypeNode's computeOtSize without the store).
export function objectTypeLabelBox(ot, refShown) {
  const w = Math.max(60, textWidth((ot.name ?? '') + (ot.isIndependent ? ' !' : ''), 18) + 16)
  const h = refShown ? 48 : 32
  return { l: -w / 2, r: w / 2, t: -h / 2, b: h / 2 }
}

// The point a fact type's labels are offset from, relative to the occurrence's point.
export function roleAnchor(fact, roleIndex) {
  const c = roleCenter({ ...fact, x: 0, y: 0 }, roleIndex)
  return { x: c.x, y: c.y }
}

export function nameAnchor(fact, refShown) {
  const b = nestedFactBounds({ ...fact, x: 0, y: 0 })
  return { x: 0, y: b.top - (refShown ? 22 : 10) }
}
