// Auto layout of a mapping diagram: the source side on the left, the rule
// nodes in a column in the middle, the target side on the right, each rule's
// node level with the elements it links, so the dashed links run across
// rather than up and down.
//
//   1. each ORM2 side is laid out on its own by the ORM2 auto layout
//      (ormLayout.js), as if it were a diagram of its own;
//   2. the anchor side (the ORM2 side with the most occurrences, else the
//      source) stays as laid out; the other side follows it: ERD tables in a
//      column in the order of where their rules' elements are on the anchor
//      side (barycentres, then spread so they don't overlap), an ORM2 side
//      turned upside down when that puts related elements level;
//   3. the rule nodes sit between the two sides, each at the mean height of
//      the elements it links (a column's row in an ERD table), spread
//      apart; a long column of nodes is split into two staggered ones.
//
// layoutMappingDiagram(state, diagramId) → { diagram, internalFrequency } for
// store.applyDiagramLayout, or null.

import { layoutOrmDiagram } from './ormLayout'
import { factBox } from './layoutScore'
import { getDiagramElements } from '../hooks/useDiagramElements'
import { entityBounds } from '../components/ObjectTypeNode'
import { mappingOfDiagram, diagramRuleIds, isViewMapping } from '../store/storeHelpers'
import { ruleWantedElements } from '../mapping/diagramRules.js'
import { erdSchemasOfDiagram } from '../relational/face.js'
import { relationalModel } from '../relational/relationalModel.js'
import { erdLayout, HEAD_H, ROW_H } from '../relational/erdBoxes.js'
import { spread1D } from '../relational/erdDirect.js'

const SIDE_GAP = 110      // between a side's drawing and the rule column
const TABLE_GAP = 28      // between ERD tables in a column
const NODE_H = 22, NODE_GAP = 10
const SIDES = ['source', 'target']

const nodeWidth = (label) => Math.max(58, 26 + label.length * 6.6)

export function layoutMappingDiagram(state, diagramId) {
  const diag = state.diagrams.find(d => d.id === diagramId)
  const m = mappingOfDiagram(state, diag)
  if (!diag || !m) return null
  const view = isViewMapping(state, m)
  const schemaOf = new Map()
  for (const k of ['objectTypes', 'facts', 'constraints']) for (const x of state[k] ?? []) schemaOf.set(x.id, x.schemaId)
  const one = m.sourceSchemaId === m.targetSchemaId
  const sideSchema = { source: m.sourceSchemaId, target: m.targetSchemaId }
  const sides = one ? ['source'] : SIDES
  const sideOfId = (id) => (one ? 'source' : schemaOf.get(id) === m.targetSchemaId ? 'target' : schemaOf.get(id) === m.sourceSchemaId ? 'source' : null)
  const erdSides = new Set(view ? [] : erdSchemasOfDiagram(state, diag).flatMap(sid => sides.filter(s => sideSchema[s] === sid)))
  const on = diagramRuleIds(diag, m)
  const rules = m.rules.filter(r => on.has(r.id))

  // An ORM2 side's attributes in the order of the columns they map to on an
  // ERD side (row index of the first column a rule links them with).
  const satOrderFor = (side) => {
    const out = new Map()
    const otherSide = sides.find(x => x !== side)
    if (!otherSide || !erdSides.has(otherSide)) return out
    const rowOf = new Map()
    for (const t of relationalModel(state, sideSchema[otherSide]).tables) t.columns.forEach((c, i) => rowOf.set(c.fact.id, i))
    for (const r of rules) {
      const w = ruleWantedElements(state, m, [r])
      const rows = [...w[otherSide]].map(id => rowOf.get(id)).filter(i => i != null)
      if (!rows.length) continue
      const rk = Math.min(...rows)
      for (const id of w[side]) if (!out.has(id) || out.get(id) > rk) out.set(id, rk)
    }
    return out
  }

  // ── 1. each side on its own ─────────────────────────────────────────────
  const part = {}   // side → { kind: 'orm', diagram, internalFrequency, pos: Map(id → {x, y}), box } | { kind: 'erd', boxes, model }
  for (const side of sides) {
    if (erdSides.has(side)) {
      const model = relationalModel(state, sideSchema[side])
      // Fresh positions: layered by foreign key depth (erdLayout without stored ones).
      const boxes = erdLayout(model, { ...diag, erdPositions: {} }, { x: 0, y: 0 })
      part[side] = { kind: 'erd', model, boxes }
      continue
    }
    const mine = (id) => sideOfId(id) === side
    const temp = {
      ...diag, id: `${diag.id}::${side}`, mappingId: undefined, mappingRuleIds: undefined,
      occurrences: (diag.occurrences ?? []).filter(o => mine(o.schemaElementId)),
      constraintOccurrences: (diag.constraintOccurrences ?? []).filter(o => mine(o.schemaConstraintId)),
      notes: [],
    }
    if (!temp.occurrences.length) continue
    const st = { ...state, diagrams: [...state.diagrams.filter(d => d.id !== diag.id), temp], activeDiagramId: temp.id }
    const res = layoutOrmDiagram(st, temp.id, { satOrder: satOrderFor(side) })
    if (!res) continue
    // Where each element is drawn, and the side's bounding box.
    const drawn = getDiagramElements({ ...st, diagrams: st.diagrams.map(d => (d.id === temp.id ? res.diagram : d)) })
    const pos = new Map()
    let l = Infinity, r = -Infinity, t = Infinity, b = -Infinity
    const grow = (bx) => { l = Math.min(l, bx.l); r = Math.max(r, bx.r); t = Math.min(t, bx.t); b = Math.max(b, bx.b) }
    for (const o of drawn.objectTypes) {
      const eb = entityBounds(o)
      grow({ l: eb.left, r: eb.right, t: eb.top, b: eb.bottom })
      if (!pos.has(o.id) || o.kind === 'entity') pos.set(o.id, { x: o.x, y: o.y })
    }
    for (const f of drawn.facts) {
      if (f._implicit || String(f.id).includes('_il_')) continue
      grow(factBox(f))
      if (!pos.has(f.id)) pos.set(f.id, { x: f.x, y: f.y })
    }
    for (const c of res.diagram.constraintOccurrences ?? []) grow({ l: c.x - 14, r: c.x + 14, t: c.y - 14, b: c.y + 14 })
    if (!isFinite(l)) { l = r = t = b = 0 }
    part[side] = { kind: 'orm', diagram: res.diagram, internalFrequency: res.internalFrequency ?? {}, pos, box: { l, r, t, b } }
  }

  // The elements each rule links, by side.
  const wanted = new Map(rules.map(r => [r.id, ruleWantedElements(state, m, [r])]))
  // The ids that place a rule: its fact types (columns) when it names any,
  // else its types (tables); an attribute's rule thus sits level with the
  // attribute, not pulled to the entity type every such rule names.
  const factIds = new Set(state.facts.map(f => f.id))
  const ruleSideIds = (r, side) => {
    const w = wanted.get(r.id)
    const ids = one ? [...w.source, ...w.target] : [...w[side]]
    const fs = ids.filter(id => factIds.has(id))
    return fs.length ? fs : ids
  }

  // Where an element of an ERD side is: its table, or a column's row in it.
  const erdRef = (side, id) => {
    const p = part[side]
    if (p?.kind !== 'erd') return null
    if (p.boxes.has(id)) return { table: id, row: -1 }
    for (const [tid, bx] of p.boxes) {
      const i = bx.table.columns.findIndex(c => c.fact.id === id)
      if (i >= 0) return { table: tid, row: i }
    }
    return null
  }
  const erdY = (bx, row) => (row < 0 ? bx.y + bx.h / 2 : bx.y + HEAD_H + row * ROW_H + ROW_H / 2)

  // ── 2. the anchor side stays, the other follows ─────────────────────────
  const ormSides = sides.filter(s => part[s]?.kind === 'orm')
  const anchor = ormSides.length
    ? ormSides.reduce((a, s) => ((part[s].diagram.occurrences.length > part[a].diagram.occurrences.length) ? s : a))
    : sides[0]
  const other = sides.find(s => s !== anchor && part[s])
  // The anchor side's y of each rule (mean over its elements there).
  const anchorY = (r) => {
    const ys = []
    for (const id of ruleSideIds(r, anchor)) {
      if (part[anchor]?.kind === 'orm') { const p = part[anchor].pos.get(id); if (p) ys.push(p.y) }
      else { const e = erdRef(anchor, id); if (e) ys.push(erdY(part[anchor].boxes.get(e.table), e.row)) }
    }
    return ys.length ? ys.reduce((a, y) => a + y, 0) / ys.length : null
  }
  const anchorBox = () => {
    const p = part[anchor]
    if (!p) return { l: 0, r: 0, t: 0, b: 0 }
    if (p.kind === 'orm') return p.box
    const bs = [...p.boxes.values()]
    return bs.length ? { l: Math.min(...bs.map(b => b.x)), r: Math.max(...bs.map(b => b.x + b.w)), t: Math.min(...bs.map(b => b.y)), b: Math.max(...bs.map(b => b.y + b.h)) } : { l: 0, r: 0, t: 0, b: 0 }
  }
  const aBox = anchorBox()
  if (other && part[other].kind === 'erd') {
    // Tables in a column, each where its rules' anchor elements are on average.
    const p = part[other]
    const want = new Map()
    for (const r of rules) {
      const y = anchorY(r)
      if (y == null) continue
      for (const id of ruleSideIds(r, other)) {
        const e = erdRef(other, id)
        if (!e) continue
        const bx = p.boxes.get(e.table)
        // The table centre that puts this row level with y.
        const c = y - (erdY({ ...bx, y: 0 }, e.row) - bx.h / 2)
        ;(want.get(e.table) ?? want.set(e.table, []).get(e.table)).push(c)
      }
    }
    const mid = (aBox.t + aBox.b) / 2
    const items = [...p.boxes.entries()].map(([tid, bx]) => {
      const ws = want.get(tid)
      return { tid, bx, d: ws ? ws.reduce((a, v) => a + v, 0) / ws.length : mid, size: bx.h }
    }).sort((a, b) => a.d - b.d)
    // Two columns when one would be much taller than the anchor side.
    const total = items.reduce((a, it) => a + it.size + TABLE_GAP, 0)
    const cols = total > 1.6 * Math.max(300, aBox.b - aBox.t) && items.length > 3 ? 2 : 1
    const colW = Math.max(...items.map(it => it.bx.w), 0)
    for (let c = 0; c < cols; c++) {
      const mine = items.filter((_, i) => i % cols === c)
      const ys = spread1D(mine, TABLE_GAP)
      mine.forEach((it, i) => { it.bx.y = Math.round(ys[i] - it.size / 2); it.bx.x = c * (colW + 40) })
    }
  } else if (other && part[other].kind === 'orm' && anchor !== other) {
    // An ORM2 side follows the anchor's height; turned upside down when that
    // puts the elements of a rule nearer level.
    const p = part[other]
    const pairs = []
    for (const r of rules) {
      const y = anchorY(r)
      if (y == null) continue
      for (const id of ruleSideIds(r, other)) { const q = p.pos.get(id); if (q) pairs.push([y, q.y]) }
    }
    if (pairs.length > 2) {
      const n = pairs.length
      const ma = pairs.reduce((a, q) => a + q[0], 0) / n, mb = pairs.reduce((a, q) => a + q[1], 0) / n
      const cov = pairs.reduce((a, q) => a + (q[0] - ma) * (q[1] - mb), 0)
      // Not with subtype trees, which must stay the right way up.
      if (cov < 0 && !(p.diagram.subtypeOccurrences ?? []).length) mirror(p)
    }
  }

  // ── 3. horizontal places, and the rule column ───────────────────────────
  // Side boxes now.
  const boxOf = (side) => {
    const p = part[side]
    if (!p) return null
    if (p.kind === 'orm') return p.box
    const bs = [...p.boxes.values()]
    if (!bs.length) return null
    return { l: Math.min(...bs.map(b => b.x)), r: Math.max(...bs.map(b => b.x + b.w)), t: Math.min(...bs.map(b => b.y)), b: Math.max(...bs.map(b => b.y + b.h)) }
  }
  // Shifts per side: the source side's left edge at 0, both sides centred on
  // the anchor's middle.
  const labelOf = (r) => r.name || `Rule ${m.rules.indexOf(r) + 1}`
  const maxW = Math.max(80, ...rules.map(r => nodeWidth(labelOf(r))))
  const shift = {}
  const sb = boxOf('source')
  const anchorMid = (() => { const b = boxOf(anchor); return b ? (b.t + b.b) / 2 : 0 })()
  shift.source = sb ? { dx: -sb.l, dy: anchor === 'source' || part.source?.kind === 'erd' ? 0 : anchorMid - (sb.t + sb.b) / 2 } : { dx: 0, dy: 0 }
  const sourceRight = sb ? sb.r - sb.l : 0
  // Two staggered node columns need more room.
  const stackH = rules.length * (NODE_H + NODE_GAP)
  const sidesH = Math.max(...sides.map(s => { const b = boxOf(s); return b ? b.b - b.t : 0 }), 300)
  const nodeCols = stackH > 1.15 * sidesH && rules.length > 6 ? 2 : 1
  const colX = sourceRight + SIDE_GAP + maxW / 2
  const ruleRight = colX + (nodeCols === 2 ? maxW + 20 : 0) + maxW / 2
  if (!one && part.target) {
    const tb = boxOf('target')
    shift.target = { dx: ruleRight + SIDE_GAP - tb.l, dy: anchor === 'target' || part.target.kind === 'erd' ? 0 : anchorMid - (tb.t + tb.b) / 2 }
  }
  // An ERD side that follows the anchor already has its heights in the anchor's frame;
  // the anchor's frame is kept (dy 0) for the anchor itself.
  if (part[anchor]?.kind === 'orm') shift[anchor] = { ...shift[anchor], dy: 0 }

  // Element positions after the shifts, for the rule nodes.
  const yOf = (side, id) => {
    const p = part[side], s = shift[side]
    if (!p || !s) return null
    if (p.kind === 'orm') { const q = p.pos.get(id); return q ? q.y + s.dy : null }
    const e = erdRef(side, id)
    return e ? erdY(p.boxes.get(e.table), e.row) + s.dy : null
  }
  const nodeItems = rules.map(r => {
    const ys = []
    for (const side of sides) for (const id of ruleSideIds(r, side)) { const y = yOf(side, id); if (y != null) ys.push(y) }
    return { r, d: ys.length ? ys.reduce((a, y) => a + y, 0) / ys.length : anchorMid, size: NODE_H }
  }).sort((a, b) => a.d - b.d)
  const mappingRulePositions = {}
  for (let c = 0; c < nodeCols; c++) {
    const mine = nodeItems.filter((_, i) => i % nodeCols === c)
    const ys = spread1D(mine, NODE_GAP)
    mine.forEach((it, i) => { mappingRulePositions[it.r.id] = { x: Math.round(colX + c * (maxW + 20)), y: Math.round(ys[i]) } })
  }

  // ── the diagram ─────────────────────────────────────────────────────────
  const move = (o, s) => ({ ...o, x: Math.round(o.x + s.dx), y: Math.round(o.y + s.dy) })
  let occurrences = [], constraintOccurrences = []
  const erdPositions = { ...(diag.erdPositions ?? {}) }
  const internalFrequency = {}
  const merged = { subtypeOccurrences: new Set(), expandedRefModeOccs: new Set(), expandedRefModes: new Set(), shownImplicitLinks: new Set(), subtypeEndpointOccs: {} }
  for (const side of sides) {
    const p = part[side], s = shift[side] ?? { dx: 0, dy: 0 }
    const mine = (id) => sideOfId(id) === side
    if (!p || p.kind === 'erd') {
      // Occurrences of an ERD side aren't drawn; they go to their table (a
      // column's to its table, a value type's to the middle of the side), so
      // fitting the view and the minimap see the side where its tables are.
      const centre = new Map()
      let cx = 0, cy = 0
      if (p) {
        for (const [tid, bx] of p.boxes) centre.set(tid, { x: bx.x + s.dx + bx.w / 2, y: bx.y + s.dy + bx.h / 2 })
        const b = boxOf(side)
        if (b) { cx = (b.l + b.r) / 2 + s.dx; cy = (b.t + b.b) / 2 + s.dy }
      }
      occurrences.push(...(diag.occurrences ?? []).filter(o => mine(o.schemaElementId)).map(o => {
        if (!p) return o
        const e = erdRef(side, o.schemaElementId)
        const c = (e && centre.get(e.table)) ?? { x: cx, y: cy }
        return { ...o, x: Math.round(c.x), y: Math.round(c.y) }
      }))
      constraintOccurrences.push(...(diag.constraintOccurrences ?? []).filter(o => mine(o.schemaConstraintId)))
      for (const k of ['subtypeOccurrences', 'expandedRefModeOccs', 'expandedRefModes', 'shownImplicitLinks']) for (const v of diag[k] ?? []) merged[k].add(v)
      if (p) for (const [tid, bx] of p.boxes) erdPositions[tid] = { x: Math.round(bx.x + s.dx), y: Math.round(bx.y + s.dy) }
      continue
    }
    occurrences.push(...p.diagram.occurrences.map(o => move(o, s)))
    constraintOccurrences.push(...(p.diagram.constraintOccurrences ?? []).map(o => move(o, s)))
    for (const k of ['subtypeOccurrences', 'expandedRefModeOccs', 'expandedRefModes', 'shownImplicitLinks']) for (const v of p.diagram[k] ?? []) merged[k].add(v)
    Object.assign(merged.subtypeEndpointOccs, p.diagram.subtypeEndpointOccs ?? {})
    for (const [fid, ms] of Object.entries(p.internalFrequency)) internalFrequency[fid] = ms.map(x => (x.x != null ? move(x, s) : x))
  }
  // Occurrences of neither side (none expected) stay.
  occurrences.push(...(diag.occurrences ?? []).filter(o => !sideOfId(o.schemaElementId)))
  const next = {
    ...diag,
    occurrences,
    constraintOccurrences,
    subtypeOccurrences: [...merged.subtypeOccurrences],
    expandedRefModeOccs: [...merged.expandedRefModeOccs],
    expandedRefModes: [...merged.expandedRefModes],
    shownImplicitLinks: [...merged.shownImplicitLinks],
    subtypeEndpointOccs: merged.subtypeEndpointOccs,
    implicitLinkPositions: {},
    mappingRulePositions,
    ...(Object.keys(erdPositions).length ? { erdPositions } : {}),
  }
  return { diagram: next, internalFrequency }
}

// Turns an ORM2 side's layout upside down about its middle.
function mirror(p) {
  const c = p.box.t + p.box.b
  const flip = (o) => ({ ...o, y: c - o.y })
  p.diagram = {
    ...p.diagram,
    occurrences: p.diagram.occurrences.map(o => ({
      ...flip(o),
      // A reading below stays below; a satellite reading's offset turns too.
      ...(o.readingOffsetBelow ? { readingOffsetBelow: { ...o.readingOffsetBelow, dy: -o.readingOffsetBelow.dy } } : {}),
    })),
    constraintOccurrences: (p.diagram.constraintOccurrences ?? []).map(flip),
  }
  for (const [id, q] of p.pos) p.pos.set(id, { x: q.x, y: c - q.y })
  for (const [fid, ms] of Object.entries(p.internalFrequency)) p.internalFrequency[fid] = ms.map(x => (x.y != null ? { ...x, y: c - x.y } : x))
}
