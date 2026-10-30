import { create } from 'zustand'
import { useStoreWithEqualityFn } from 'zustand/traditional'
import { EMPTY } from './storeHelpers'
import { createModelSlice } from './slices/modelSlice'
import { createElementSlice } from './slices/elementSlice'
import { createPopulationSlice } from './slices/populationSlice'
import { createConstraintSlice } from './slices/constraintSlice'
import { createSelectionSlice } from './slices/selectionSlice'
import { createDiagramSlice } from './slices/diagramSlice'
export { subtypeKindOf } from './storeHelpers'

export const useOrmStore = create((set, get) => ({
  ...EMPTY(),
  ...createModelSlice(set, get),
  ...createElementSlice(set, get),
  ...createPopulationSlice(set, get),
  ...createConstraintSlice(set, get),
  ...createSelectionSlice(set, get),
  ...createDiagramSlice(set, get),
}))

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
