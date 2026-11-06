import { create } from 'zustand'
import { useStoreWithEqualityFn } from 'zustand/traditional'
import { EMPTY, stampSchemaIds, scopeToSchema } from './storeHelpers'
import { refusedEdit } from '../mapping/pairLock'
import { createModelSlice } from './slices/modelSlice'
import { createElementSlice } from './slices/elementSlice'
import { createPopulationSlice } from './slices/populationSlice'
import { createConstraintSlice } from './slices/constraintSlice'
import { createSelectionSlice } from './slices/selectionSlice'
import { createDiagramSlice } from './slices/diagramSlice'
import { createSchemaSlice } from './slices/schemaSlice'
import { createMappingSlice } from './slices/mappingSlice'
import { createViewSlice } from './slices/viewSlice'
export { subtypeKindOf } from './storeHelpers'

// Actions that may change a relational schema outside an undo batch: its table
// rules (derived tables and columns, which transformations derive through), a
// constraint carried over from the accounting report, and turning a formula
// constraint into the graphical constraint it says, populations (records
// are not read-only), and the view language (setViewLanguage swaps the names
// and readings shown with their translations, store/viewLanguage.js, which is
// not an edit of the model).
const RELATIONAL_EDITS = ['addTableRule', 'updateTableRules', 'updateTableRule', 'deleteTableRule', 'addTableRuleColumn',
  'setTablePrimaryKey', 'addDerivedTable', 'addCarriedConstraint', 'formulaToGraphical', 'applyMappingRun', 'loadSampleRows', 'addSimpleConstraint', 'applyView', 'applyExchangeRun',
  'setViewLanguage', 'addLanguage']

export const useOrmStore = create((rawSet, get) => {
  // Every update passes through here so that new elements and diagrams get
  // the active schema's id (stampSchemaIds), whichever action made them.
  // A relational schema is read-only (relational/face.js), and the schemas of
  // a locked mapping take only new constraints (mapping/pairLock.js): an
  // update that edits one otherwise is dropped, with a notice in the status bar, unless it runs as
  // part of one undo step (a transformation, an import, Fold…; historyBatch),
  // inside an action listed in RELATIONAL_EDITS, or replaces the schemas
  // (opening a file, deleting a schema).
  const set = (partial, replace) => {
    const prev = get()
    const next = stampSchemaIds(typeof partial === 'function' ? partial(prev) : partial, prev)
    const refused = next && !replace && !(prev.historyBatch > 0) && !(prev.relationalEdits > 0)
      && !(next.schemas && next.schemas !== prev.schemas) ? refusedEdit(prev, next) : null
    if (refused) {
      rawSet({ readOnlyNotice: { at: Date.now(), ...refused } })
      return
    }
    rawSet(next, replace)
  }
  const actions = {
    ...EMPTY(),
    ...createModelSlice(set, get),
    ...createElementSlice(set, get),
    ...createPopulationSlice(set, get),
    ...createConstraintSlice(set, get),
    ...createSelectionSlice(set, get),
    ...createDiagramSlice(set, get),
    ...createSchemaSlice(set, get),
    ...createMappingSlice(set, get),
    ...createViewSlice(set, get),
  }
  for (const name of RELATIONAL_EDITS) {
    const fn = actions[name]
    actions[name] = (...args) => {
      rawSet({ relationalEdits: (get().relationalEdits ?? 0) + 1 })
      try { return fn(...args) } finally { rawSet({ relationalEdits: Math.max(0, (get().relationalEdits ?? 1) - 1) }) }
    }
  }
  return actions
})


// The whole state, like useOrmStore(), but a change to only the given keys
// doesn't re-render. Panning sets `pan` on every wheel event, so components
// that don't draw the viewport ignore it (and mostly `zoom`): otherwise each
// pan step re-renders the whole app, which is slow in a large schema. Values
// of the ignored keys read from the result may be stale; read them with
// useOrmStore.getState() when needed.
export function useOrmStoreIgnoring(...keys) {
  return useStoreWithEqualityFn(useOrmStore, selectAll, (a, b) => {
    if (a === b) return true
    for (const k in b) if (a[k] !== b[k] && !keys.includes(k)) return false
    return true
  })
}
const selectAll = s => s

// useOrmStoreIgnoring('pan', 'zoom') seen from the active schema: the element
// collections and diagrams hold only that schema's (storeHelpers scopeToSchema).
export function useScopedStore() {
  return scopeToSchema(useOrmStoreIgnoring('pan', 'zoom'))
}
