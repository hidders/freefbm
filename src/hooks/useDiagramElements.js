import { useOrmStore } from '../store/ormStore'

/**
 * Returns schema elements filtered to the active diagram,
 * with positions merged from diagram.positions (falling back to element x,y).
 * Also returns the active diagram object and the elementIds Set.
 */
export function useDiagramElements() {
  const store = useOrmStore()
  return getDiagramElements(store)
}

/**
 * Non-hook version — accepts a plain store state snapshot.
 * Safe to call outside React components (e.g. pdfExport.js).
 */
export function getDiagramElements(store) {
  const { objectTypes, facts, constraints, subtypes, diagrams, activeDiagramId } = store
  const diagram   = diagrams?.find(d => d.id === activeDiagramId) ?? diagrams?.[0]
  const positions = diagram?.positions ?? {}
  // elementIds: null  → no filter, show all (default/first diagram, old persisted state)
  // elementIds: array → filter to exactly those ids (including intentionally empty [])
  const hasFilter  = diagram?.elementIds != null
  const elementIds = new Set(diagram?.elementIds ?? [])

  const withPos = (el) => {
    const p = positions[el.id]
    if (!p) return el
    const merged = { ...el, x: p.x, y: p.y }
    // Per-diagram layout overrides for facts
    if (el.kind === 'fact') {
      if (p.readingAbove    !== undefined) merged.readingAbove    = p.readingAbove
      if (p.readingOffset   !== undefined) merged.readingOffset   = p.readingOffset
      if (p.uniquenessBelow !== undefined) merged.uniquenessBelow = p.uniquenessBelow
      if (p.nestedReading   !== undefined) merged.nestedReading   = p.nestedReading
      if (p.roleNameOffsets    !== undefined) merged.roleNameOffsets    = p.roleNameOffsets
      if (p.valueRangeOffsets !== undefined) merged.valueRangeOffsets = p.valueRangeOffsets
        if (p.nameOffset        !== undefined) merged.nameOffset        = p.nameOffset
    }
    return merged
  }

  const inDiagram = (el) => !hasFilter || elementIds.has(el.id)

  const visibleOts         = objectTypes.filter(inDiagram).map(withPos)
  const visibleFacts       = facts.filter(inDiagram).map(withPos)
  const visibleConstraints = constraints.filter(inDiagram).map(withPos)
  const visibleOtIds       = new Set(visibleOts.map(o => o.id))
  // Subtypes are shown automatically when both endpoints are visible
  const visibleSubtypes    = subtypes.filter(st => visibleOtIds.has(st.subId) && visibleOtIds.has(st.superId))
  // Also include subtypes where one endpoint is an objectified fact visible in the diagram
  const visibleFactIds = new Set(visibleFacts.map(f => f.id))
  const allVisibleIds  = new Set([...visibleOtIds, ...visibleFactIds])
  const allVisibleSubtypes = subtypes.filter(st => allVisibleIds.has(st.subId) && allVisibleIds.has(st.superId))

  return {
    objectTypes:  visibleOts,
    facts:        visibleFacts,
    constraints:  visibleConstraints,
    subtypes:     allVisibleSubtypes,
    diagram,
    elementIds,
  }
}
