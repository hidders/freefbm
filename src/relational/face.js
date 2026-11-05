// Which face a relational schema shows (RM schemas first-class, step 2).
//
// A relational schema shows its relational face (tables, columns, keys, CHECKs:
// relationalView.js) in the schema browser, the Inspector, the tool panel and
// its diagrams (drawn as ERDs), unless its logical view is on: its stored
// ORM2 form (encoding B), which only Advanced mode shows (store.logicalViews,
// a session setting per schema id: store.setSchemaLogicalView). Mapping
// diagrams are always drawn in ORM2.

import { activeSchemaIdOf, mappingOfDiagram } from '../store/storeHelpers.js'
import { lockedSchemas } from '../mapping/pairLock.js'

export function isRelationalFace(state, schemaId) {
  const s = state.schemas?.find(x => x.id === schemaId)
  return s?.profile === 'relational' && !(state.advancedMode && state.logicalViews?.[schemaId])
}

// The schemas of a mapping diagram drawn as ERD tables: its relational ones
// that show their relational face (RM step 7). Their elements are left out of
// the ORM2 drawing (getDiagramElements), and ErdView draws their tables.
export function erdSchemasOfDiagram(state, diagram) {
  const m = mappingOfDiagram(state, diagram)
  if (!m) return []
  return [...new Set([m.sourceSchemaId, m.targetSchemaId])].filter(sid => isRelationalFace(state, sid))
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
// In its logical view, a relational schema that a mapping locks to
// constraints only (mapping/pairLock.js) takes new constraints, so it shows
// the usual tools there.
export function activeReadOnly(state) {
  const d = state.diagrams?.find(x => x.id === state.activeDiagramId)
  if (d?.mappingId) return false
  const sid = activeSchemaIdOf(state)
  if (!isReadOnlySchema(state, sid)) return false
  return isRelationalFace(state, sid) || !lockedSchemas(state).has(sid)
}
