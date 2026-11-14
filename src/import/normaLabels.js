// Where NORMA draws the labels of a shape: the reading of a fact type, value
// and cardinality ranges, the name of an objectified fact type. NORMA keeps
// each as a shape of its own (a RelativeShape) with its bounds in the diagram,
// placed freely by the user. FreeFBM keeps them as free offsets too, but its
// boxes and fonts have other sizes, so a label is placed by its relation to
// the shape: the side it is on, its gap from that side and how it lines up
// along it (left, centre, right; top, middle, bottom), measured from
// FreeFBM's own box and label size. A label that overlaps its shape keeps
// its centre's offset.

import { nestedFactBounds, getDisplayReading, buildDisplayReading, roleCenter, NAME_LINE, LABEL_SIZE } from '../components/FactTypeNode.jsx'
import { formatValueRange, formatCardinalityRange, otBoxSize, OT_SIZE_NAME } from '../components/ObjectTypeNode.jsx'
import { measureDiagramText } from '../diagram/diagramFont.js'

function textWidth(text, size, weight = 400) {
  try { return measureDiagramText(text, size, weight) } catch { return text.length * size * 0.55 }
}

const TOUCH = 6   // px a label may reach into its shape and still count as beside it

// L, S: NORMA label and shape rectangles { l, t, r, b } in px. box: FreeFBM's
// box { l, t, r, b } for the shape, relative to the occurrence's point (an
// object type's centre, a fact type's role middle). size: FreeFBM's label
// { w, h }. Gives the label's centre relative to that point, and the side it
// is on (null when it overlaps).
export function placeLabel(L, S, box, size) {
  const cx = (S.l + S.r) / 2, cy = (S.t + S.b) / 2
  const l = { l: L.l - cx, r: L.r - cx, t: L.t - cy, b: L.b - cy }
  const s = { l: S.l - cx, r: S.r - cx, t: S.t - cy, b: S.b - cy }
  const gaps = { below: l.t - s.b, above: s.t - l.b, right: l.l - s.r, left: s.l - l.r }
  const side = Object.keys(gaps).reduce((a, k) => gaps[k] > gaps[a] ? k : a, 'below')
  // overlapping: the same offset from the box's centre as from the shape's
  if (gaps[side] < -TOUCH) return { x: (l.l + l.r) / 2 + (box.l + box.r) / 2, y: (l.t + l.b) / 2 + (box.t + box.b) / 2, side: null }
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

// The box a fact type's labels are placed from, relative to the occurrence's
// point (the middle of its role boxes). An objectified fact type's is FreeFBM's
// outline. Otherwise it is NORMA's own shape S (px), roles plus a band per
// level of bars, around the same role boxes: FreeFBM draws the roles where
// NORMA does and its bars in those bands, so a label keeps NORMA's distance
// from the role boxes.
export function factLabelBox(fact, S) {
  if (fact.objectified) return relative(nestedFactBounds({ ...fact, x: 0, y: 0 }), 0, 0)
  return { l: S.l - fact.x, r: S.r - fact.x, t: S.t - fact.y, b: S.b - fact.y }
}

export function readingLabelSize(fact) {
  return { w: textWidth(shownReading(fact), LABEL_SIZE), h: NAME_LINE }
}

// The reading text FactTypeNode draws (without the store: a binary's readings
// whose outer parts are empty, as NORMA's mostly are, need no player names).
function shownReading(fact) {
  if (fact.arity !== 2) return getDisplayReading(fact) || ''
  const order = fact.roleOrder?.length === 2 ? fact.roleOrder : [0, 1]
  const all = [{ roleOrder: [0, 1], parts: fact.readingParts }, ...(fact.alternativeReadings ?? [])]
    .filter(r => r.parts?.some(p => p?.trim()))
  const text = o => {
    const r = all.find(r => r.roleOrder[0] === o[0] && r.roleOrder[1] === o[1])
    return r ? buildDisplayReading(r.parts, 2) : ''
  }
  const fwd = text(order), rev = text([order[1], order[0]])
  if (all.length === 1) return (fwd ? '' : '◀ ') + (fwd || rev)
  if (fact.readingDisplay === 'both') return [fwd, rev].filter(Boolean).join(' / ')
  if (fact.readingDisplay === 'reverse') return rev ? '◀ ' + rev : ''
  return fwd
}

export function rangeLabelSize(range, cardinality = false) {
  const text = (cardinality ? formatCardinalityRange(range) : formatValueRange(range)) ?? ''
  return { w: textWidth(text, LABEL_SIZE) + 6, h: NAME_LINE + 3 }
}

export function roleNameLabelSize(name) {
  return { w: textWidth(`[${name}]`, LABEL_SIZE), h: NAME_LINE }
}

export function nameLabelSize(name) {
  return { w: textWidth(`“${name}”`, OT_SIZE_NAME, 700), h: NAME_LINE }
}

// FreeFBM's object type box (ObjectTypeNode's computeOtSize without the store).
export function objectTypeLabelBox(ot, refShown) {
  const { w, h } = otBoxSize((ot.name ?? '') + (ot.isIndependent ? ' !' : ''), refShown ? ' ' : null)
  return { l: -w / 2, r: w / 2, t: -h / 2, b: h / 2 }
}

// The point a fact type's labels are offset from, relative to the occurrence's point.
export function roleAnchor(fact, roleIndex) {
  const c = roleCenter({ ...fact, x: 0, y: 0 }, roleIndex)
  return { x: c.x, y: c.y }
}

export function nameAnchor(fact, refShown) {
  const b = nestedFactBounds({ ...fact, x: 0, y: 0 })
  return { x: 0, y: b.top - NAME_LINE * (refShown ? 1.5 : 0.5) }
}
