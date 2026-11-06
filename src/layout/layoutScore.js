// Measures of how readable an ORM2 diagram's layout is, as drawn: overlapping
// boxes, role connectors that cross each other or run through a box, total
// connector length, and the size of the drawing. Used by the layout harness
// (scripts/orm-layout-check.mjs) to compare layouts.

import { getDiagramElements } from '../hooks/useDiagramElements'
import { entityBounds } from '../components/ObjectTypeNode'
import { nestedFactBounds, getDisplayReading, ROLE_W, ROLE_H, ROLE_GAP } from '../components/FactTypeNode'
import { roleAnchor } from '../utils/geometry'

// A fact type's box as drawn: its roles, the uniqueness bars on their side and a line
// of reading text (factBounds keeps room for more bars than are drawn). A reading
// moved by readingOffsetBelow (beside a unary, say) is where it was put.
export function factBox(f) {
  const n = Math.max(f.roles.length, 1), len = n * ROLE_W + (n - 1) * ROLE_GAP
  const u = f.uniqueness ?? []
  const levels = (u.some(x => x.roles.length === 1) ? 1 : 0) + u.filter(x => x.roles.length > 1).length
  const bars = levels ? 4 + 5 * levels : 0
  const below = !!f.uniquenessBelow
  if (f.orientation === 'vertical') {
    return { l: f.x - ROLE_H / 2 - (below ? bars : 0), r: f.x + ROLE_H / 2 + (below ? 0 : bars), t: f.y - len / 2, b: f.y + len / 2 }
  }
  const rw = (getDisplayReading(f) || '').length * 7 + 14
  const off = !f.readingAbove && f.readingOffsetBelow
  if (off) {
    const rx = f.x + off.dx, ry = f.y + off.dy
    return {
      l: Math.min(f.x - len / 2, rx - rw / 2), r: Math.max(f.x + len / 2, rx + rw / 2),
      t: Math.min(f.y - ROLE_H / 2 - (below ? 0 : bars), ry - 8), b: Math.max(f.y + ROLE_H / 2 + (below ? bars : 0), ry + 8),
    }
  }
  const w = Math.max(len, rw)
  return { l: f.x - w / 2, r: f.x + w / 2, t: f.y - ROLE_H / 2 - (below ? 0 : bars), b: f.y + ROLE_H / 2 + 14 + (below ? bars : 0) }
}

function border(b, tx, ty) {
  const cx = (b.l + b.r) / 2, cy = (b.t + b.b) / 2
  const dx = tx - cx, dy = ty - cy
  if (!dx && !dy) return { x: cx, y: cy }
  const hw = (b.r - b.l) / 2, hh = (b.b - b.t) / 2
  const t = Math.abs(dx) * hh > Math.abs(dy) * hw ? hw / Math.abs(dx) : hh / Math.abs(dy)
  return { x: cx + dx * t, y: cy + dy * t }
}

const orient = (a, b, c) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)
function cross(p, q, r, s) {
  const d1 = orient(p, q, r), d2 = orient(p, q, s), d3 = orient(r, s, p), d4 = orient(r, s, q)
  return d1 * d2 < 0 && d3 * d4 < 0
}
function segHitsBox(p, q, b) {
  const s = 2   // inset: touching a box edge is not running through it
  const l = b.l + s, r = b.r - s, t = b.t + s, bt = b.b - s
  if (Math.max(p.x, q.x) < l || Math.min(p.x, q.x) > r || Math.max(p.y, q.y) < t || Math.min(p.y, q.y) > bt) return false
  const inside = (z) => z.x > l && z.x < r && z.y > t && z.y < bt
  if (inside(p) || inside(q)) return true
  const c = [{ x: l, y: t }, { x: r, y: t }, { x: r, y: bt }, { x: l, y: bt }]
  return [0, 1, 2, 3].some(i => cross(p, q, c[i], c[(i + 1) % 4]))
}

export function layoutScore(state, diagramId, { details = false } = {}) {
  const els = getDiagramElements({ ...state, activeDiagramId: diagramId })
  const boxes = []     // { key, name, l, r, t, b }
  const why = details ? [] : null
  const boxName = (k) => boxes.find(b => b.key === k)?.name ?? k
  const otByOcc = new Map(), otFirst = new Map(), nestFirst = new Map()
  for (const o of els.objectTypes) {
    const e = entityBounds(o)
    const b = { key: `o:${o.occurrenceId}`, name: o.name, l: e.left, r: e.right, t: e.top, b: e.bottom }
    boxes.push(b)
    otByOcc.set(o.occurrenceId, b)
    if (!otFirst.has(o.id)) otFirst.set(o.id, b)
  }
  for (const f of els.facts) {
    const g = { ...f, arity: f.roles.length }
    const e = f.objectified ? nestedFactBounds(g) : null
    const b = { key: `f:${f.occurrenceId}`, name: `[${getDisplayReading({ ...f, arity: f.roles.length }) || f.roles.length + '-ary'}]`, ...(e ? { l: e.left, r: e.right, t: e.top, b: e.bottom } : factBox(g)) }
    boxes.push(b)
    if (f.objectified) { otByOcc.set(f.occurrenceId, b); if (!nestFirst.has(f.id)) nestFirst.set(f.id, b) }
  }
  // Role connectors.
  const segs = []
  let length = 0
  for (const f of els.facts) {
    const g = { ...f, arity: f.roles.length }
    f.roles.forEach((r, ri) => {
      if (!r.objectTypeId) return
      const occId = f.roleOccurrenceMap?.[String(ri)]
      const pb = (occId && otByOcc.get(occId)) || otFirst.get(r.objectTypeId) || nestFirst.get(r.objectTypeId)
      if (!pb) return
      const pc = { x: (pb.l + pb.r) / 2, y: (pb.t + pb.b) / 2 }
      const a = roleAnchor(g, ri, pc.x, pc.y)
      const e = border(pb, a.x, a.y)
      length += Math.hypot(a.x - e.x, a.y - e.y)
      segs.push({ p: a, q: e, own: new Set([`f:${f.occurrenceId}`, pb.key]), name: `role ${boxName(`f:${f.occurrenceId}`)}–${pb.name}` })
    })
  }
  // Subtype links, centre to centre between the boxes.
  for (const st of els.subtypes) {
    const a = (st.subOccId && otByOcc.get(st.subOccId)) || otFirst.get(st.subId)
    const b = (st.superOccId && otByOcc.get(st.superOccId)) || otFirst.get(st.superId)
    if (!a || !b) continue
    const ca = { x: (a.l + a.r) / 2, y: (a.t + a.b) / 2 }, cb = { x: (b.l + b.r) / 2, y: (b.t + b.b) / 2 }
    const p = border(a, cb.x, cb.y), q = border(b, ca.x, ca.y)
    length += Math.hypot(p.x - q.x, p.y - q.y)
    segs.push({ p, q, own: new Set([a.key, b.key]), name: `subtype ${a.name}→${b.name}` })
  }
  let crossings = 0, throughBoxes = 0, overlaps = 0
  for (let i = 0; i < segs.length; i++) for (let j = i + 1; j < segs.length; j++) {
    const A = segs[i], B = segs[j]
    if ([...A.own].some(k => B.own.has(k))) continue
    if (cross(A.p, A.q, B.p, B.q)) { crossings++; why?.push(`cross: ${A.name} × ${B.name}`) }
  }
  for (const s of segs) for (const b of boxes) if (!s.own.has(b.key) && segHitsBox(s.p, s.q, b)) { throughBoxes++; why?.push(`through: ${s.name} through ${b.name}`) }
  // Constraint connectors, centre to each member (a role's anchor facing the
  // constraint, a subtype link's midpoint, a collapsed reference mode's entity).
  const factByOcc = new Map(), factFirst = new Map()
  for (const f of els.facts) { const g = { ...f, arity: f.roles.length }; factByOcc.set(f.occurrenceId, g); if (!factFirst.has(f.id)) factFirst.set(f.id, g) }
  const subMid = new Map()
  for (const st of els.subtypes) {
    const a = (st.subOccId && otByOcc.get(st.subOccId)) || otFirst.get(st.subId)
    const b = (st.superOccId && otByOcc.get(st.superOccId)) || otFirst.get(st.superId)
    if (a && b && !subMid.has(st.id)) subMid.set(st.id, { x: (a.l + a.r + b.l + b.r) / 4, y: (a.t + a.b + b.t + b.b) / 4 })
  }
  const cSegs = []
  let cLength = 0
  for (const c of els.constraints) {
    const cc = { x: c.x, y: c.y }, key = `c:${c.constraintOccurrenceId}`
    const members = [...(c.sequences ?? []).flat(), ...(c.roleSequences ?? []).flat().map(r => ({ kind: 'role', ...r }))]
    for (const m of members) {
      let q = null, own = null
      if (m?.kind === 'role') {
        const f = factFirst.get(m.factId)
        if (f) { q = roleAnchor(f, m.roleIndex, c.x, c.y); own = `f:${f.occurrenceId}` }
        else {
          const owner = els.collapsedRefFacts?.[m.factId]?.owner
          const b = owner && (otByOcc.get(owner.occurrenceId) || otFirst.get(owner.id))
          if (b) { q = border(b, c.x, c.y); own = b.key }
        }
      } else if (m?.kind === 'subtype') q = subMid.get(m.subtypeId)
      if (!q) continue
      cLength += Math.hypot(q.x - c.x, q.y - c.y)
      cSegs.push({ p: cc, q, own: new Set([key, own].filter(Boolean)), name: `${c.constraintType} ${c.name ?? ''}` })
    }
  }
  let cCrossings = 0, cThrough = 0
  for (const A of cSegs) {
    for (const B of segs) if (![...A.own].some(k => B.own.has(k)) && cross(A.p, A.q, B.p, B.q)) { cCrossings++; why?.push(`c-cross: ${A.name} × ${B.name}`) }
    for (const b of boxes) if (!A.own.has(b.key) && segHitsBox(A.p, A.q, b)) { cThrough++; why?.push(`c-through: ${A.name} through ${b.name}`) }
  }
  for (let i = 0; i < cSegs.length; i++) for (let j = i + 1; j < cSegs.length; j++) {
    const A = cSegs[i], B = cSegs[j]
    if (![...A.own].some(k => B.own.has(k)) && cross(A.p, A.q, B.p, B.q)) { cCrossings++; why?.push(`c-cross: ${A.name} × ${B.name}`) }
  }
  // Constraint circles count as boxes for overlaps.
  for (const c of els.constraints) boxes.push({ key: `c:${c.constraintOccurrenceId}`, name: `(${c.constraintType})`, l: c.x - 12, r: c.x + 12, t: c.y - 12, b: c.y + 12 })
  for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
    const a = boxes[i], b = boxes[j]
    if (a.l < b.r && a.r > b.l && a.t < b.b && a.b > b.t) { overlaps++; why?.push(`overlap: ${a.name} × ${b.name}`) }
  }
  let l = Infinity, r = -Infinity, t = Infinity, b = -Infinity
  for (const x of boxes) { l = Math.min(l, x.l); r = Math.max(r, x.r); t = Math.min(t, x.t); b = Math.max(b, x.b) }
  return {
    shapes: boxes.length,
    overlaps, crossings, throughBoxes,
    length: Math.round(length),
    constraints: els.constraints.length,
    cCrossings, cThrough, cLength: Math.round(cLength),
    ...(why ? { why } : {}),
    width: Math.round(r - l), height: Math.round(b - t),
  }
}
