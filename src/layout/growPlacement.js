// Where the elements added by Add neighbours… (store.addNeighbours) go: around
// the occurrence they were added to, in free space, without moving anything
// that was on the diagram before. Each unit (a fact type with its new players,
// a subtype, a table with the junction's far tables) is placed as a whole along
// a direction from the anchor, the nearest free spot first, spread over the
// directions so that units don't pile up on one side.

import { getDiagramElements } from '../hooks/useDiagramElements'
import { entityBounds } from '../components/ObjectTypeNode'
import { nestedFactBounds } from '../components/FactTypeNode'
import { factBox } from './layoutScore.js'
import { defaultFrequencyPos } from '../utils/frequencyPlacement.js'

const MARGIN = 16
const GAP = 46        // between the anchor and a unit's first shape, and inside a unit
const RINGS = 24      // how far out the search goes, one extra GAP each time
const LINE_RINGS = 3  // how far out a spot is first looked for with a clear line to the anchor

const overlaps = (a, b) => a.l < b.r + MARGIN && b.l < a.r + MARGIN && a.t < b.b + MARGIN && b.t < a.b + MARGIN
const rectAt = (cx, cy, w, h) => ({ l: cx - w / 2, r: cx + w / 2, t: cy - h / 2, b: cy + h / 2 })
// The distance from a box's centre to its border in direction (ux, uy).
const reach = (w, h, ux, uy) => Math.min(ux ? w / 2 / Math.abs(ux) : Infinity, uy ? h / 2 / Math.abs(uy) : Infinity)

// Directions in degrees (0 = right, 90 = down), the preferred ones first.
const PREFS = {
  attributes:    [0, 180, 30, 150, -30, -150, 60, 120, -60, -120, 90, -90],
  subtypes:      [90, 60, 120, 30, 150, 0, 180],
  supertypes:    [-90, -60, -120, -30, -150, 0, 180],
  relationships: [0, 180, 90, -90, 45, 135, -45, -135, 22, 158, -22, -158, 68, 112, -68, -112],
  references:    [180, 150, -150, 120, -120, 90, -90, 0],
  referencedBy:  [0, 30, -30, 60, -60, 90, -90, 180],
  manyToMany:    [0, 30, -30, 60, -60, 90, -90, 180],
}
const ORDER = ['subtypes', 'supertypes', 'attributes', 'references', 'referencedBy', 'relationships', 'manyToMany']
const byGroup = (a, b) => (a.step ?? 0) - (b.step ?? 0) || ORDER.indexOf(a.unit.group) - ORDER.indexOf(b.unit.group)

// Whether segment p–q runs through rect b (touching its border is fine).
function segHits(p, q, b) {
  const l = b.l + 2, r = b.r - 2, t = b.t + 2, bt = b.b - 2
  if (Math.max(p.x, q.x) < l || Math.min(p.x, q.x) > r || Math.max(p.y, q.y) < t || Math.min(p.y, q.y) > bt) return false
  // Liang–Barsky clipping.
  let t0 = 0, t1 = 1
  const dx = q.x - p.x, dy = q.y - p.y
  for (const [pp, qq] of [[-dx, p.x - l], [dx, r - p.x], [-dy, p.y - t], [dy, bt - p.y]]) {
    if (pp === 0) { if (qq < 0) return false; continue }
    const v = qq / pp
    if (pp < 0) { if (v > t1) return false; if (v > t0) t0 = v }
    else { if (v < t0) return false; if (v < t1) t1 = v }
  }
  return t0 < t1
}

// All directions in steps of 15 degrees, after a group's preferred ones.
const FINE = Array.from({ length: 24 }, (_, i) => (i * 15 > 180 ? i * 15 - 360 : i * 15))

// Searches directions and rings for a spot where `shapes(ux, uy, extra)` (a
// list of rects) hits none of `obstacles`, and the line from the anchor
// (`from`: its centre and box) to the first rect runs through none of them.
// Directions used less often come first.
function search(group, used, obstacles, shapes, from = null) {
  const base = PREFS[group] ?? PREFS.relationships
  const prefs = [...base, ...FINE.filter(a => !base.includes(a))]
  const order = prefs.map((a, i) => ({ a, i })).sort((x, y) => (used.get(x.a) ?? 0) - (used.get(y.a) ?? 0) || x.i - y.i)
  // Near spots with a clear line first, then any free spot further out.
  for (const [rings, line] of [[LINE_RINGS, true], [RINGS, false]]) {
    for (let ring = 0; ring < rings; ring++) {
      for (const { a } of order) {
        const rad = a * Math.PI / 180, ux = Math.cos(rad), uy = Math.sin(rad)
        const rects = shapes(ux, uy, ring * GAP)
        const c = { x: (rects[0].l + rects[0].r) / 2, y: (rects[0].t + rects[0].b) / 2 }
        const clearLine = !line || !from || !obstacles.some(o => o !== from.box && segHits(from, c, o))
        if (clearLine && rects.every(r => !obstacles.some(o => overlaps(r, o)))) {
          used.set(a, (used.get(a) ?? 0) + 1)
          return { ux, uy, extra: ring * GAP, rects }
        }
      }
    }
  }
  const a = order[0].a * Math.PI / 180
  return { ux: Math.cos(a), uy: Math.sin(a), extra: RINGS * GAP, rects: shapes(Math.cos(a), Math.sin(a), RINGS * GAP) }
}

// ── ORM2 diagrams ────────────────────────────────────────────────────────────

function boxOfOt(o) {
  const e = o.objectified ? nestedFactBounds({ ...o, arity: o.roles.length }) : entityBounds(o)
  return { l: e.left, r: e.right, t: e.top, b: e.bottom }
}
const boxOfFact = (f) => {
  const g = { ...f, arity: f.roles.length }
  if (f.objectified) { const e = nestedFactBounds(g); return { l: e.left, r: e.right, t: e.top, b: e.bottom } }
  return factBox(g)
}

// state: after the units were added; beforeOccIds, beforeCoccIds: the
// occurrences and constraint occurrences that were there before; plans: [{ unit, anchorOccId }]. Returns the patches
// { [occId]: { x, y, orientation?, roleOrder?, roleOccurrenceMap? } } for
// the new occurrences, under `occ`; new constraint occurrences under `cocc`
// ({ [constraintOccId]: { x, y } }), and internal frequency markers of new fact
// types shown on no other diagram under `freq` ({ [factId]: markers }).
export function placeOrmUnits(state, diagramId, beforeOccIds, plans, beforeCoccIds = []) {
  const diagram = state.diagrams.find(d => d.id === diagramId)
  const els = getDiagramElements({ ...state, activeDiagramId: diagramId })
  const shapeOf = new Map()   // occId → { box, el }
  for (const o of els.objectTypes) shapeOf.set(o.occurrenceId, { box: boxOfOt(o), el: o })
  for (const f of els.facts) shapeOf.set(f.occurrenceId, { box: boxOfFact(f), el: f })
  const occs = diagram.occurrences ?? []
  const isNew = (o) => !beforeOccIds.has(o.id)
  const obstacles = [...shapeOf.entries()].filter(([id]) => beforeOccIds.has(id)).map(([, s]) => s.box)
  const out = {}
  const placedAt = new Map()  // occId → { x, y } of a new occurrence
  const used = new Map()
  const usedAnchors = new Map()
  const sizeOf = (occId) => { const b = shapeOf.get(occId)?.box; return b ? { w: b.r - b.l, h: b.b - b.t } : { w: 80, h: 40 } }
  const centreOf = (occId) => {
    if (placedAt.has(occId)) return placedAt.get(occId)
    const b = shapeOf.get(occId)?.box
    return b ? { x: (b.l + b.r) / 2, y: (b.t + b.b) / 2 } : null
  }

  for (const { unit, anchorOccId } of [...plans].sort(byGroup)) {
    const anchorOcc = occs.find(o => o.id === anchorOccId)
    const ac = centreOf(anchorOccId)
    if (!anchorOcc || !ac) continue
    const anchorId = anchorOcc.schemaElementId
    const { w: aw, h: ah } = sizeOf(anchorOccId)
    const anchorBox = obstacles.find(o => Math.abs((o.l + o.r) / 2 - ac.x) < 1 && Math.abs((o.t + o.b) / 2 - ac.y) < 1) ?? null
    const from = { x: ac.x, y: ac.y, box: anchorBox }
    const usedHere = usedAnchors.get(anchorOccId) ?? new Map()
    usedAnchors.set(anchorOccId, usedHere)
    const fact = state.facts.find(f => unit.ids.includes(f.id))
    const factOcc = fact ? occs.find(o => o.schemaElementId === fact.id && isNew(o) && !placedAt.has(o.id)) : null
    if (fact && !factOcc) continue   // shown already
    // The unit's new players (one occurrence each), and players shown already.
    const farNew = [], farOld = []
    for (const id of unit.far) {
      if (id === anchorId) continue
      const n = occs.find(o => o.schemaElementId === id && isNew(o) && !placedAt.has(o.id) && !o.refModeOwnerOccId)
      if (n) farNew.push(n)
      else { const old = occs.find(o => o.schemaElementId === id && !o.refModeOwnerOccId); if (old) farOld.push(old) }
    }

    if (factOcc && !farNew.length) {
      // Between the anchor and the nearest player that is shown already.
      const targets = farOld.map(o => centreOf(o.id)).filter(Boolean)
      const fs = sizeOf(factOcc.id)
      let at
      if (targets.length) {
        const t = targets.sort((p, q) => Math.hypot(p.x - ac.x, p.y - ac.y) - Math.hypot(q.x - ac.x, q.y - ac.y))[0]
        const d = Math.hypot(t.x - ac.x, t.y - ac.y) || 1
        const ux = (t.x - ac.x) / d, uy = (t.y - ac.y) / d
        const mid = { x: (ac.x + t.x) / 2, y: (ac.y + t.y) / 2 }
        const free = (p) => !obstacles.some(o => overlaps(rectAt(p.x, p.y, fs.w, fs.h), o))
        // Along the line first, then sideways.
        const tries = [0, 1, -1, 2, -2, 3, -3, 4, -4].flatMap(k => [0, 0.2, -0.2].map(s => ({
          x: mid.x + s * d * ux - k * 30 * uy, y: mid.y + s * d * uy + k * 30 * ux })))
        at = tries.find(free) ?? mid
      }
      if (!at) {
        const r = search(unit.group, usedHere, obstacles, (ux, uy, extra) => {
          const dd = reach(aw, ah, ux, uy) + GAP + extra + reach(fs.w, fs.h, ux, uy)
          return [rectAt(ac.x + ux * dd, ac.y + uy * dd, fs.w, fs.h)]
        }, from)
        at = { x: (r.rects[0].l + r.rects[0].r) / 2, y: (r.rects[0].t + r.rects[0].b) / 2 }
      }
      put(factOcc.id, at, fs, orient(fact, anchorId, at.x - ac.x, at.y - ac.y, anchorOccId, farOld))
      continue
    }

    // Along a direction: the fact type (if any), then its new players side by side.
    const fs = factOcc ? sizeOf(factOcc.id) : null
    const ps = farNew.map(o => sizeOf(o.id))
    const shapes = (ux, uy, extra) => {
      let d = reach(aw, ah, ux, uy) + GAP + extra
      const rects = []
      let fc = null
      if (fs) {
        d += reach(fs.w, fs.h, ux, uy)
        fc = { x: ac.x + ux * d, y: ac.y + uy * d }
        rects.push(rectAt(fc.x, fc.y, fs.w, fs.h))
        d += reach(fs.w, fs.h, ux, uy) + GAP
      }
      // Players across the direction, centred on it.
      const across = ps.map(p => Math.abs(uy) > Math.abs(ux) ? p.w : p.h)
      const span = across.reduce((s, x) => s + x, 0) + MARGIN * 2 * Math.max(0, ps.length - 1)
      let off = -span / 2
      ps.forEach((p, i) => {
        const dd = d + reach(p.w, p.h, ux, uy)
        const o = off + across[i] / 2
        rects.push(rectAt(ac.x + ux * dd - uy * o, ac.y + uy * dd + ux * o, p.w, p.h))
        off += across[i] + MARGIN * 2
      })
      return rects
    }
    const r = search(unit.group, usedHere, obstacles, shapes, from)
    let k = 0
    if (factOcc) {
      const c = r.rects[k++]
      const at = { x: (c.l + c.r) / 2, y: (c.t + c.b) / 2 }
      put(factOcc.id, at, fs, orient(fact, anchorId, r.ux, r.uy, anchorOccId, farNew))
    }
    for (const o of farNew) {
      const c = r.rects[k++]
      put(o.id, { x: (c.l + c.r) / 2, y: (c.t + c.b) / 2 }, ps[k - 1 - (factOcc ? 1 : 0)])
    }
  }

  // Other new occurrences (reference modes, a table's columns in the logical
  // view…) move with the placed occurrence that was nearest to them.
  const moved = [...placedAt.keys()].map(id => {
    const o = occs.find(x => x.id === id)
    return { from: { x: o.x, y: o.y }, to: placedAt.get(id) }
  })
  for (const o of occs) {
    if (!isNew(o) || placedAt.has(o.id) || !moved.length) continue
    const m = moved.reduce((best, c) => (Math.hypot(c.from.x - o.x, c.from.y - o.y) < Math.hypot(best.from.x - o.x, best.from.y - o.y) ? c : best))
    out[o.id] = { x: Math.round(o.x + m.to.x - m.from.x), y: Math.round(o.y + m.to.y - m.from.y) }
  }
  const at = (o) => out[o.id] ? { ...o, ...out[o.id] } : o
  const finalOcc = new Map(occs.map(o => [o.id, at(o)]))
  const byElement = new Map()
  for (const o of finalOcc.values()) if (!o.refModeOwnerOccId && !byElement.has(o.schemaElementId)) byElement.set(o.schemaElementId, o)

  // New constraint occurrences: near what they constrain, in free space.
  const cocc = {}
  const beforeC = new Set(beforeCoccIds)
  for (const co of diagram.constraintOccurrences ?? []) {
    if (beforeC.has(co.id)) continue
    const c = state.constraints.find(x => x.id === co.schemaConstraintId)
    if (!c) continue
    const ids = []
    for (const seq of c.sequences ?? []) for (const m of seq) {
      if (m.factId) ids.push(m.factId)
      if (m.subtypeId) { const st = state.subtypes.find(x => x.id === m.subtypeId); if (st) ids.push(st.subId) }
    }
    for (const seq of c.roleSequences ?? []) for (const m of seq) if (m.factId) ids.push(m.factId)
    if (c.targetObjectTypeId) ids.push(c.targetObjectTypeId)
    const pts = [...new Set(ids)].map(id => byElement.get(id)).filter(Boolean)
    if (!pts.length || !pts.some(o => out[o.id])) continue   // nothing of it moved
    const cx = pts.reduce((a, o) => a + o.x, 0) / pts.length
    const cy = pts.reduce((a, o) => a + o.y, 0) / pts.length - (pts.length === 1 ? 50 : 0)
    const R = 14
    const spots = [0, 1, 2, 3, 4, 5].flatMap(k => (k ? [0, 45, 90, 135, 180, 225, 270, 315] : [0]).map(a => ({
      x: cx + k * 26 * Math.cos(a * Math.PI / 180), y: cy + k * 26 * Math.sin(a * Math.PI / 180) })))
    const free = spots.find(p => !obstacles.some(o => overlaps(rectAt(p.x, p.y, R * 2, R * 2), o))) ?? spots[0]
    cocc[co.id] = { x: Math.round(free.x), y: Math.round(free.y) }
    obstacles.push(rectAt(free.x, free.y, R * 2, R * 2))
  }

  // Internal frequency markers are stored on the fact type: moved only for a
  // fact type that no other diagram shows.
  const freq = {}
  for (const f of state.facts) {
    if (!f.internalFrequency?.length) continue
    const o = byElement.get(f.id)
    if (!o || !out[o.id] || beforeOccIds.has(o.id)) continue
    if (state.diagrams.some(d => d.id !== diagramId && (d.occurrences ?? []).some(x => x.schemaElementId === f.id))) continue
    const drawn = { ...f, arity: f.roles.length, x: o.x, y: o.y, orientation: o.orientation ?? f.orientation, roleOrder: o.roleOrder ?? f.roleOrder,
      uniquenessBelow: o.uniquenessBelow ?? f.uniquenessBelow }
    freq[f.id] = f.internalFrequency.map(m => ({ ...m, ...defaultFrequencyPos(drawn, m.roles ?? []) }))
  }
  return { occ: out, cocc, freq }

  function put(occId, at, size, extra = {}) {
    placedAt.set(occId, at)
    out[occId] = { x: Math.round(at.x), y: Math.round(at.y), ...extra }
    obstacles.push(rectAt(at.x, at.y, size.w, size.h))
  }

  // A binary's orientation and role order, so its anchor role faces the anchor;
  // its roles connect to the anchor occurrence and the unit's players.
  function orient(f, anchorId, ux, uy, anchorOccId, farOccs) {
    const map = {}
    f.roles.forEach((r, i) => {
      if (r.objectTypeId === anchorId) map[String(i)] = anchorOccId
      else { const o = farOccs.find(x => x.schemaElementId === r.objectTypeId); if (o) map[String(i)] = o.id }
    })
    const extra = { roleOccurrenceMap: { ...(occs.find(o => o.schemaElementId === f.id && isNew(o))?.roleOccurrenceMap ?? {}), ...map } }
    if (f.objectified || f.roles.length !== 2) return extra
    const ai = f.roles.findIndex(r => r.objectTypeId === anchorId)
    if (ai < 0) return extra
    const vertical = Math.abs(uy) > Math.abs(ux) * 1.5
    const towards = vertical ? uy < 0 : ux < 0     // the fact type is above / left of the anchor
    return { ...extra, orientation: vertical ? 'vertical' : 'horizontal', roleOrder: towards ? [1 - ai, ai] : [ai, 1 - ai] }
  }
}

// ── ERD diagrams ─────────────────────────────────────────────────────────────

// boxes: erdLayout's boxes after the units were added (top-left x, y, w, h);
// before: the table ids shown before; plans: [{ unit, anchorId }]. Returns
// { [tableId]: { x, y } } for the new tables.
export function placeErdUnits(boxes, before, plans) {
  const obstacles = []
  for (const [id, b] of boxes) if (before.has(id)) obstacles.push({ l: b.x, r: b.x + b.w, t: b.y, b: b.y + b.h })
  const out = {}
  const centre = (id) => {
    const b = boxes.get(id)
    if (!b) return null
    const p = out[id] ?? { x: b.x, y: b.y }
    return { x: p.x + b.w / 2, y: p.y + b.h / 2, w: b.w, h: b.h }
  }
  const usedAnchors = new Map()
  for (const { unit, anchorId } of [...plans].sort(byGroup)) {
    const a = centre(anchorId)
    if (!a) continue
    const fresh = unit.ids.filter(id => boxes.has(id) && !before.has(id) && !out[id])
    if (!fresh.length) continue
    const usedHere = usedAnchors.get(anchorId) ?? new Map()
    usedAnchors.set(anchorId, usedHere)
    const sizes = fresh.map(id => boxes.get(id))
    // In a row along the direction: a junction table first, then its far tables.
    const shapes = (ux, uy, extra) => {
      let d = reach(a.w, a.h, ux, uy) + GAP * 1.5 + extra
      return sizes.map(s => {
        d += reach(s.w, s.h, ux, uy)
        const r = rectAt(a.x + ux * d, a.y + uy * d, s.w, s.h)
        d += reach(s.w, s.h, ux, uy) + GAP * 1.5
        return r
      })
    }
    const anchorBox = obstacles.find(o => Math.abs((o.l + o.r) / 2 - a.x) < 1 && Math.abs((o.t + o.b) / 2 - a.y) < 1) ?? null
    const r = search(unit.group, usedHere, obstacles, shapes, { x: a.x, y: a.y, box: anchorBox })
    fresh.forEach((id, i) => {
      const c = r.rects[i]
      out[id] = { x: Math.round(c.l), y: Math.round(c.t) }
      obstacles.push(c)
    })
  }
  return out
}
