// Assertions as constraint nodes in an ERD (ErdView.jsx, behind the
// Assertions switch, diagram.erdAssertions).
//
// An assertion of a relational schema (relationalView's kind 'assertion': a
// constraint with no table form) is drawn as a circle, like an ORM2 external
// constraint, with a glyph that says what kind of rule it is, and linked to
// the tables it reads. Both are read from its formula, not from where it came
// from, so a constraint carried from ORM2, one added by hand and one read
// from SQL are drawn alike:
//
// - the kind: the graphical constraint the formula has the shape of
//   (asGraphical in mapping/recognise.js: subset, equality, exclusion,
//   inclusive-/exclusive-or, uniqueness, frequency, value comparison), else
//   the constraint's own type when it is graphical (a ring constraint, …),
//   else what the formula uses (a transitive closure: recursion; an
//   aggregate: aggregate; a count: frequency), else a general formula (φ).
// - each table's part, by the polarity of its atoms: a table is constrained
//   when adding rows to it can break the assertion (its atoms occur
//   negatively: under ∀, in an antecedent, under ¬, counted with an upper
//   bound), and referenced when only removing rows can (its atoms occur
//   positively only: under ∃, in a consequent). An FK-like rule constrains
//   the referencing table and references the other; an exclusion constrains
//   both.
//
// assertionShapes(view) → [{ rmId, obj, kind, glyph, operator?, frequency?,
//   tables: [{ id (entity id), role: 'constrained'|'referenced' }],
//   columns: Set(factId) }]. Cached per view.
//
// placeAssertions(shapes, boxes, stored) → Map(rmId → { x, y }): stored
// positions (diagram.erdAssertionPositions), else a free spot near the
// tables, clear of the boxes and of the nodes placed before.

import { asGraphical } from '../mapping/recognise.js'
import { formulaToRule } from '../logic/formulaToRule.js'

export const NODE_R = 10

// The kinds, with how a panel names them.
export const ASSERTION_KINDS = {
  subset: 'Inclusion', equality: 'Equality', exclusion: 'Exclusion',
  inclusiveOr: 'Covering (inclusive-or)', exclusiveOr: 'Partition (exclusive-or)',
  uniqueness: 'Uniqueness', frequency: 'Frequency', valueComparison: 'Value comparison',
  ring: 'Recursion (ring)', aggregate: 'Aggregate condition', formula: 'Formula',
}
const GRAPHICAL = new Set(['subset', 'equality', 'exclusion', 'inclusiveOr', 'exclusiveOr', 'uniqueness', 'frequency', 'valueComparison', 'ring'])

// What a formula (formula.js syntax) uses: tc, agg, count.
function uses(n, out = new Set(), seen = new Set()) {
  if (!n || typeof n !== 'object' || seen.has(n)) return out
  seen.add(n)
  if (n.t === 'tc' || n.t === 'agg' || n.t === 'count') out.add(n.t)
  for (const v of Object.values(n)) {
    if (Array.isArray(v)) v.forEach(x => uses(x, out, seen))
    else if (v && typeof v === 'object') uses(v, out, seen)
  }
  return out
}

// The kind of an assertion object, with what its glyph shows.
export function assertionKind(obj) {
  let g = null
  if (obj.tree) { try { g = asGraphical(formulaToRule(obj.tree)) } catch { g = null } }
  if (g) return { kind: g.constraintType, operator: g.operator ?? null, frequency: g.frequency ?? null }
  if (GRAPHICAL.has(obj.constraintType)) return { kind: obj.constraintType, operator: null, frequency: null }
  const u = uses(obj.tree)
  if (u.has('tc')) return { kind: 'ring', operator: null, frequency: null }
  if (u.has('agg')) return { kind: 'aggregate', operator: null, frequency: null }
  if (u.has('count')) return { kind: 'frequency', operator: null, frequency: null }
  return { kind: 'formula', operator: null, frequency: null }
}

// The tables an assertion's formula reads, each constrained or referenced,
// and the columns it reads. model: relationalModel.
export function assertionTables(tree, model) {
  const parts = new Map()   // entity id → Set of polarities (1, -1)
  const columns = new Set()
  const tableIds = new Set(model.tables.map(t => t.id))
  const mark = (id, p) => {
    if (!tableIds.has(id)) return
    if (!parts.has(id)) parts.set(id, new Set())
    if (p === 0) { parts.get(id).add(1); parts.get(id).add(-1) } else parts.get(id).add(p)
  }
  const typesOf = (v) => (v?.typeIds ?? (v?.typeId ? [v.typeId] : []))
  const go = (n, p) => {
    if (!n || typeof n !== 'object') return
    switch (n.t) {
      case 'fact': {
        const col = model.columnByFact.get(n.factId)
        if (col) { columns.add(n.factId); mark(col.table.id, p) }
        for (const a of n.args ?? []) if (a?.t) go(a, 0)
        return
      }
      case 'type': mark(n.typeId, p); return
      // ∀x φ is ∀x (T(x) → φ): T negative; ∃x φ is ∃x (T(x) ∧ φ): T positive.
      case 'forall': for (const v of n.vars ?? []) for (const id of typesOf(v)) mark(id, -p); go(n.body, p); return
      case 'exists': for (const v of n.vars ?? []) for (const id of typesOf(v)) mark(id, p); go(n.body, p); return
      case 'not': go(n.arg, -p); return
      case 'implies': go(n.left, -p); go(n.right, p); return
      case 'iff': go(n.left, 0); go(n.right, 0); return
      case 'and': case 'or': (n.args ?? []).forEach(a => go(a, p)); return
      case 'obligatory': go(n.arg, p); return
      case 'tc': go(n.body, p); return
      case 'count': {
        // At most n: more rows can break it; at least n: fewer can.
        const q = n.op === '≤' || n.op === '<' ? -p : n.op === '≥' || n.op === '>' ? p : 0
        for (const v of n.vars ?? []) for (const id of typesOf(v)) mark(id, q)
        go(n.body, q)
        return
      }
      default:
        // Comparisons, terms, aggregates: both ways.
        for (const v of Object.values(n)) {
          if (Array.isArray(v)) v.forEach(x => go(x, 0))
          else if (v && typeof v === 'object') go(v, 0)
        }
    }
  }
  go(tree, 1)
  const tables = model.tables.filter(t => parts.has(t.id))
    .map(t => ({ id: t.id, role: parts.get(t.id).has(-1) ? 'constrained' : 'referenced' }))
  return { tables, columns }
}

const cache = new WeakMap()
export function assertionShapes(view) {
  if (cache.has(view)) return cache.get(view)
  const out = view.assertions.map(obj => {
    const k = assertionKind(obj)
    const { tables, columns } = obj.tree ? assertionTables(obj.tree, view.model) : { tables: [], columns: new Set() }
    return { rmId: obj.rmId, obj, ...k, tables, columns }
  })
  cache.set(view, out)
  return out
}

// The width of a node: a circle, or a pill with the name right of the glyph.
export function nodeWidth(shape, measure) {
  const name = shape.obj.name
  return name ? NODE_R * 2 + 4 + measure(name) + 8 : NODE_R * 2
}

// Whether the segment (x1, y1)–(x2, y2) crosses the rectangle r (grown by m).
function crosses(x1, y1, x2, y2, r, m = 0) {
  const L = r.x - m, R = r.x + r.w + m, T = r.y - m, B = r.y + r.h + m
  let t0 = 0, t1 = 1
  const dx = x2 - x1, dy = y2 - y1
  for (const [p, q] of [[-dx, x1 - L], [dx, R - x1], [-dy, y1 - T], [dy, B - y1]]) {
    if (p === 0) { if (q < 0) return false; continue }
    const t = q / p
    if (p < 0) { if (t > t1) return false; if (t > t0) t0 = t } else { if (t < t0) return false; if (t < t1) t1 = t }
  }
  return t0 < t1
}

// The point where the line from the centre of box b to (x, y) leaves it.
export function boxBorder(b, x, y) {
  const cx = b.x + b.w / 2, cy = b.y + b.h / 2
  const dx = x - cx, dy = y - cy
  if (!dx && !dy) return { x: cx, y: b.y }
  const s = Math.min(dx ? (b.w / 2) / Math.abs(dx) : Infinity, dy ? (b.h / 2) / Math.abs(dy) : Infinity)
  return { x: cx + dx * s, y: cy + dy * s }
}

export function placeAssertions(shapes, boxes, stored = {}, widthOf = () => NODE_R * 2) {
  const out = new Map()
  const rects = [...boxes.values()].map(b => ({ x: b.x, y: b.y, w: b.w, h: b.h }))
  const nodes = []   // placed node rectangles
  const nodeRect = (x, y, w) => ({ x: x - w / 2, y: y - NODE_R, w, h: NODE_R * 2 })
  const overlaps = (a, b, m) => a.x - m < b.x + b.w && b.x - m < a.x + a.w && a.y - m < b.y + b.h && b.y - m < a.y + a.h
  for (const s of shapes) {
    const w = widthOf(s)
    const at = stored?.[s.rmId]
    if (at) { out.set(s.rmId, { x: at.x, y: at.y }); nodes.push(nodeRect(at.x, at.y, w)); continue }
    const mine = s.tables.map(t => boxes.get(t.id)).filter(Boolean)
    if (!mine.length) continue
    // Start between the tables (one table: right of it, level with its middle).
    let sx, sy
    if (mine.length === 1) { sx = mine[0].x + mine[0].w + 40 + w / 2; sy = mine[0].y + Math.min(mine[0].h / 2, 60) }
    else {
      sx = mine.reduce((a, b) => a + b.x + b.w / 2, 0) / mine.length
      sy = mine.reduce((a, b) => a + b.y + b.h / 2, 0) / mine.length
    }
    const cost = (x, y) => {
      const r = nodeRect(x, y, w)
      if (rects.some(b => overlaps(r, b, 14)) || nodes.some(n => overlaps(r, n, 10))) return Infinity
      let c = Math.hypot(x - sx, y - sy) * 0.3
      for (const b of mine) {
        const e = boxBorder(b, x, y)
        c += Math.hypot(e.x - x, e.y - y)
        for (const o of rects) if (o !== b && !mine.includes(o) && crosses(x, y, e.x, e.y, o, 2)) c += 400
      }
      return c
    }
    let best = null
    const STEP = 24
    for (let ring = 0; ring <= 30; ring++) {
      const pts = ring === 0 ? [[0, 0]] : []
      for (let i = -ring; i <= ring; i++) pts.push([i, -ring], [i, ring], [-ring, i], [ring, i])
      for (const [i, j] of pts) {
        const x = sx + i * STEP, y = sy + j * STEP
        const c = cost(x, y)
        if (c < (best?.c ?? Infinity)) best = { x, y, c }
      }
      // Rings further out only get dearer once something is found.
      if (best && ring * STEP * 0.3 > best.c) break
    }
    if (!best) best = { x: sx, y: sy }
    const p = { x: Math.round(best.x), y: Math.round(best.y) }
    out.set(s.rmId, p)
    nodes.push(nodeRect(p.x, p.y, w))
  }
  return out
}
