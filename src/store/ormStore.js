import { create } from 'zustand'
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
