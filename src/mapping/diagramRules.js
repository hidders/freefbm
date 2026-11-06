// Which rules a mapping diagram draws (diagram.mappingRuleIds) and the
// elements that come with them. A rule on a mapping diagram brings every
// element its two patterns name (store.showMappingRules), so a diagram is a
// subset of the rules plus their schema fragments.

import { ruleElements } from './mapping.js'
import { viewRuleElements } from './views.js'
import { findRefMode } from '../utils/refMode.js'
import { isViewMapping } from '../store/storeHelpers.js'

// The elements a mapping diagram shows for the given rules, by side: the
// types, fact types and tables their patterns name, a table's named columns
// (but its reference mode), and an entity for its reference-mode fact type.
export function ruleWantedElements(s0, m, rules) {
  const view = isViewMapping(s0, m)
  const wanted = { source: new Set(), target: new Set() }
  for (const r of rules) {
    const els = view ? viewRuleElements(s0, m, r) : ruleElements(r)
    for (const side of ['source', 'target']) {
      const e = els[side]
      for (const id of [...e.typeIds, ...e.factIds, ...e.tableIds]) wanted[side].add(id)
      for (const tableId of e.tableIds) {
        const t = s0.objectTypes.find(o => o.id === tableId)
        const rm = t ? findRefMode(t, s0.facts, s0.objectTypes) : null
        for (const colId of e.columnFactIds) {
          const f = s0.facts.find(x => x.id === colId)
          if (f && f.id !== rm?.factId && f.roles.some(r => r.objectTypeId === tableId)) wanted[side].add(colId)
        }
      }
    }
  }
  for (const side of ['source', 'target']) for (const id of [...wanted[side]]) {
    const f = s0.facts.find(x => x.id === id)
    if (!f) continue
    for (const r of f.roles) {
      const e = s0.objectTypes.find(o => o.id === r.objectTypeId && o.kind === 'entity')
      if (e && findRefMode(e, s0.facts, s0.objectTypes)?.factId === id) { wanted[side].delete(id); wanted[side].add(e.id) }
    }
  }
  return wanted
}

// Older mapping diagrams have no rule list and drew every rule; they get the
// rules whose elements they all show, so a rule node never stands without
// its elements.
export function withExplicitRuleIds(state, diagrams) {
  return diagrams.map(d => {
    if (!d.mappingId || Array.isArray(d.mappingRuleIds)) return d
    const m = state.mappings?.find(x => x.id === d.mappingId) ?? state.views?.find(x => x.id === d.mappingId)
    if (!m) return d
    const shown = new Set((d.occurrences ?? []).map(o => o.schemaElementId))
    const ids = m.rules.filter(r => {
      const w = ruleWantedElements(state, m, [r])
      return [...w.source, ...w.target].every(id => shown.has(id))
    }).map(r => r.id)
    return { ...d, mappingRuleIds: ids }
  })
}

// Positions for what a rule just brought to a mapping diagram, close
// together instead of where things are in their schemas' diagrams: the rule's
// node at a free spot (by the elements of the rule already shown, else below
// what the diagram shows), the source side to its left and the target side to
// its right: entity types (or tables) in a column, a value type beside the
// entity type it is an attribute of, fact types between their players. The
// group then moves down until it overlaps nothing shown before.
//   fresh: new occurrences (no reference-mode parts); before: the others;
//   sideOf(elementId) → 'source' | 'target'; ruleElementIds: what the rule names;
//   erd: { [side]: { sizes: Map(tableId → { w, h }), before: [{ x, y, w, h }] } }
//   for a side drawn as ERD tables (their boxes, new and shown);
//   nodes: where the other rules' nodes are ([{ x, y }]).
// Returns { node, at: Map(occId → { x, y }), tables: Map(tableId → top-left) }.
export function compactRulePlacement(state, fresh, before, sideOf, ruleElementIds, erd = {}, nodes = []) {
  const W = 130, H = 70, GAP = 30
  const factIds = new Set(state.facts.map(f => f.id))
  const otById = new Map(state.objectTypes.map(o => [o.id, o]))
  const centre = (ps) => ({ x: ps.reduce((a, o) => a + o.x, 0) / ps.length, y: ps.reduce((a, o) => a + o.y, 0) / ps.length })
  const rectOfOcc = (o) => ({ l: o.x - W / 2, r: o.x + W / 2, t: o.y - H / 2, b: o.y + H / 2 })
  const obstacles = [
    // A side drawn as ERD tables counts by its boxes, not its occurrences.
    ...before.filter(o => !erd[sideOf(o.schemaElementId)]).map(rectOfOcc),
    ...Object.values(erd).flatMap(e => e.before.map(b => ({ l: b.x - 20, r: b.x + b.w + 20, t: b.y - 20, b: b.y + b.h + 20 }))),
    ...nodes.map(p => ({ l: p.x - 90, r: p.x + 90, t: p.y - 20, b: p.y + 20 })),
  ]
  const related = before.filter(o => ruleElementIds.has(o.schemaElementId))
  let node
  if (related.length) node = centre(related)
  else if (obstacles.length) node = { x: (Math.min(...obstacles.map(r => r.l)) + Math.max(...obstacles.map(r => r.r))) / 2, y: Math.max(...obstacles.map(r => r.b)) + 2 * H }
  else node = { x: 0, y: 0 }
  const at = new Map(), tables = new Map(), rects = []
  const sign = { source: -1, target: 1 }
  const nodeRect = { l: node.x - 90, r: node.x + 90, t: node.y - 15, b: node.y + 15 }
  for (const side of ['source', 'target']) {
    const mine = fresh.filter(o => sideOf(o.schemaElementId) === side)
    if (erd[side]) {
      // Tables in a column, the other parts (columns, their types) at their table.
      const ts = mine.filter(o => erd[side].sizes.has(o.schemaElementId))
      const total = ts.reduce((a, o) => a + erd[side].sizes.get(o.schemaElementId).h + GAP, -GAP)
      let y = node.y - total / 2
      for (const o of ts) {
        const { w, h } = erd[side].sizes.get(o.schemaElementId)
        const x = side === 'source' ? node.x - 140 - w : node.x + 140
        tables.set(o.schemaElementId, { x, y })
        at.set(o.id, { x: x + w / 2, y: y + h / 2 })
        rects.push({ l: x, r: x + w, t: y, b: y + h })
        y += h + GAP
      }
      for (const o of mine) if (!at.has(o.id)) at.set(o.id, { x: node.x + sign[side] * 300, y: node.y })
      continue
    }
    const ots = mine.filter(o => !factIds.has(o.schemaElementId)).sort((a, b) => a.y - b.y || a.x - b.x)
    const freshFacts = mine.filter(o => factIds.has(o.schemaElementId)).map(o => state.facts.find(f => f.id === o.schemaElementId)).filter(Boolean)
    // A value type is an attribute of an entity type when a new fact type joins just those two.
    const ownerOf = (vt) => {
      for (const f of freshFacts) {
        const ps = f.roles.map(r => r.objectTypeId)
        if (ps.length === 2 && ps.includes(vt)) { const other = ps.find(p => p !== vt); if (otById.get(other)?.kind === 'entity') return other }
      }
      return null
    }
    const attrs = ots.filter(o => otById.get(o.schemaElementId)?.kind === 'value' && ownerOf(o.schemaElementId))
    const column = ots.filter(o => !attrs.includes(o))
    const colX = node.x + sign[side] * 260
    column.forEach((o, i) => at.set(o.id, { x: colX, y: node.y + (i - (column.length - 1) / 2) * 130 }))
    const posOfElement = (id) => {
      for (const o of fresh) if (o.schemaElementId === id && at.has(o.id)) return at.get(o.id)
      const b = before.find(o => o.schemaElementId === id && !o.refModeOwnerOccId)
      return b ? { x: b.x, y: b.y } : null
    }
    const taken = []
    for (const o of attrs) {
      const owner = posOfElement(ownerOf(o.schemaElementId)) ?? { x: colX, y: node.y }
      let p = { x: owner.x + sign[side] * 260, y: owner.y }
      while (taken.some(q => Math.abs(q.y - p.y) < H && Math.abs(q.x - p.x) < W)) p = { x: p.x, y: p.y + H }
      taken.push(p)
      at.set(o.id, p)
    }
    let k = 0
    for (const o of mine.filter(x => factIds.has(x.schemaElementId))) {
      const f = state.facts.find(x => x.id === o.schemaElementId)
      const ps = (f?.roles ?? []).map(r => posOfElement(r.objectTypeId)).filter(Boolean)
      let p = ps.length >= 2 ? centre(ps) : ps.length === 1 ? { x: ps[0].x - sign[side] * 130, y: ps[0].y + 50 } : { x: node.x + sign[side] * 130, y: node.y + k++ * H }
      while ([...at.entries()].some(([id, q]) => id !== o.id && Math.abs(q.x - p.x) < W && Math.abs(q.y - p.y) < 40)) p = { x: p.x, y: p.y + 40 }
      at.set(o.id, p)
    }
    for (const o of mine) if (at.has(o.id) && !tables.has(o.schemaElementId)) rects.push(rectOfOcc(at.get(o.id)))
  }
  rects.push(nodeRect)
  // Down until the group clears what was shown.
  const hit = (a, b, dy) => a.l < b.r && b.l < a.r && a.t + dy < b.b && b.t < a.b + dy
  let dy = 0
  for (let n = 0; n < 400 && rects.some(r => obstacles.some(o => hit(r, o, dy))); n++) dy += H / 2
  const move = (p) => ({ x: Math.round(p.x), y: Math.round(p.y + dy) })
  return { node: move(node), at: new Map([...at].map(([id, p]) => [id, move(p)])), tables: new Map([...tables].map(([id, p]) => [id, move(p)])) }
}
