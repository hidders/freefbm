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

  const expandedRefModes = new Set(diagram?.expandedRefModes ?? [])

  const withPos = (el) => {
    const p = positions[el.id]
    const merged = p ? { ...el, x: p.x, y: p.y } : { ...el }
    // Per-diagram layout overrides for facts
    if (el.kind === 'fact') {
      if (p?.readingAbove        !== undefined) merged.readingAbove        = p.readingAbove
      if (p?.readingOffsetAbove  !== undefined) merged.readingOffsetAbove  = p.readingOffsetAbove
      if (p?.readingOffsetBelow  !== undefined) merged.readingOffsetBelow  = p.readingOffsetBelow
      if (p?.uniquenessBelow     !== undefined) merged.uniquenessBelow     = p.uniquenessBelow
      if (p?.nestedReading       !== undefined) merged.nestedReading       = p.nestedReading
      if (p?.roleNameOffsets     !== undefined) merged.roleNameOffsets     = p.roleNameOffsets
      if (p?.valueRangeOffsets   !== undefined) merged.valueRangeOffsets   = p.valueRangeOffsets
      if (p?.cardinalityRangeOffsets !== undefined) merged.cardinalityRangeOffsets = p.cardinalityRangeOffsets
      if (p?.nameOffset          !== undefined) merged.nameOffset          = p.nameOffset
      // Per-diagram presentation overrides
      if (p?.roleOrder       !== undefined) merged.roleOrder       = p.roleOrder
      if (p?.readingOrder    !== undefined) merged.readingOrder    = p.readingOrder
      if (p?.orientation     !== undefined) merged.orientation     = p.orientation
      if (p?.readingDisplay  !== undefined) merged.readingDisplay  = p.readingDisplay
    }
    // For entities: refModeExpanded reflects per-diagram state (expanded in THIS diagram)
    if (el.kind === 'entity' && el.refModeExpanded) {
      merged.refModeExpanded = expandedRefModes.has(el.id)
    }
    return merged
  }

  // For ref-expansion FTs: only shown when the entity is in expandedRefModes.
  // For ref-expansion VTs: shown whenever they are in elementIds (filtered diagram),
  // whether via full expansion, independent addition, or independent use.
  // In a show-all diagram they are shown when expanded OR independently used.
  const inDiagram = (el) => {
    if (el._refExpansion) {
      if (el.kind === 'fact') {
        return expandedRefModes.has(el._refExpansion) && (!hasFilter || elementIds.has(el.id))
      }
      // VT path
      if (hasFilter && !elementIds.has(el.id)) return false
      if (expandedRefModes.has(el._refExpansion)) return true
      if (hasFilter) return true  // in elementIds of a filtered diagram → show
      // Show-all diagram, not expanded: show only if independently used
      return facts.some(f =>
        !f._refExpansion &&
        f.roles.some(r => r.objectTypeId === el.id)
      )
    }
    return !hasFilter || elementIds.has(el.id)
  }

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
