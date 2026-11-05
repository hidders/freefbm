// Which face a relational schema shows (RM schemas first-class, step 2).
//
// A relational schema shows its relational face (tables, columns, keys, CHECKs:
// relationalView.js) in the schema browser, the Inspector, the tool panel and
// its diagrams (drawn as ERDs), unless its logical view is on: its stored
// ORM2 form (encoding B), which only Advanced mode shows (store.logicalViews,
// a session setting per schema id: store.setSchemaLogicalView). Mapping
// diagrams are always drawn in ORM2.

import { activeSchemaIdOf } from '../store/storeHelpers.js'

export function isRelationalFace(state, schemaId) {
  const s = state.schemas?.find(x => x.id === schemaId)
  return s?.profile === 'relational' && !(state.advancedMode && state.logicalViews?.[schemaId])
}

// The face of the active schema, unless the active diagram draws a mapping.
export function activeRelationalFace(state) {
  const d = state.diagrams?.find(x => x.id === state.activeDiagramId)
  if (d?.mappingId) return false
  return isRelationalFace(state, activeSchemaIdOf(state))
}

// A relational schema is read-only in both faces: only transformations (and
// the other operations that run as one undo step, store.historyBatch) change
// it. Diagrams may still show or hide its tables, whole (tableUnits.js).
export function isReadOnlySchema(state, schemaId) {
  return state.schemas?.find(x => x.id === schemaId)?.profile === 'relational'
}

// The active diagram shows a read-only schema (mapping diagrams excepted).
export function activeReadOnly(state) {
  const d = state.diagrams?.find(x => x.id === state.activeDiagramId)
  if (d?.mappingId) return false
  return isReadOnlySchema(state, activeSchemaIdOf(state))
}

// Whether an update (prev → next, next possibly partial) changes an element of
// a relational schema other than in its position. Element positions (x, y at
// any depth: schema-level fallbacks, frequency markers, implied links) are
// layout and stay free.
const ELEMENT_KEYS = ['objectTypes', 'facts', 'subtypes', 'constraints']
const unplaced = (v) => JSON.stringify(v, (k, val) => ((k === 'x' || k === 'y') && typeof val === 'number' ? undefined : val))
export function editsRelationalSchema(prev, next) {
  const rel = new Set((next.schemas ?? prev.schemas ?? []).filter(s => s.profile === 'relational').map(s => s.id))
  if (!rel.size) return false
  const counts = (x) => x && !x._implicit && rel.has(x.schemaId)
  for (const key of ELEMENT_KEYS) {
    const a = prev[key] ?? [], b = next[key]
    if (!Array.isArray(b) || a === b) continue
    const before = new Map(a.map(x => [x.id, x]))
    const kept = new Set()
    for (const x of b) {
      const o = before.get(x.id)
      kept.add(x.id)
      if (o === x || !(counts(x) || counts(o))) continue
      if (!o || unplaced(o) !== unplaced(x)) return true
    }
    for (const o of a) if (!kept.has(o.id) && counts(o)) return true
  }
  return false
}
