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
