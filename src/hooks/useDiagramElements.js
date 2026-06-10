import { useOrmStore } from '../store/ormStore'
import { findRefMode } from '../utils/refMode'

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

  // Identify VT/FT IDs that should be hidden because they are the ref-mode pair
  // for an entity that is *not* expanded in this diagram. The entity displays
  // the ref mode as shorthand inside its own rect instead.
  //
  // Two-pass:
  //  1. Collect the ref-mode facts that will be hidden (one per collapsed entity).
  //     These are always hidden — they only carry the entity/VT 1:1 relationship.
  //  2. For each such pair, hide the VT only if no OTHER visible fact uses it as
  //     a role player. Otherwise leave the VT visible in the diagram.
  const hiddenByShorthand = new Set()
  const collapsedRefModes = []
  for (const ot of objectTypes) {
    if (ot.kind !== 'entity') continue
    if (expandedRefModes.has(ot.id)) continue
    const rm = findRefMode(ot, facts, objectTypes)
    if (!rm) continue
    if (hasFilter && !elementIds.has(ot.id)) continue
    collapsedRefModes.push(rm)
    hiddenByShorthand.add(rm.factId)
  }
  for (const nf of facts) {
    if (!nf.objectified || nf.objectifiedKind === 'value') continue
    if (expandedRefModes.has(nf.id)) continue
    const rm = findRefMode(nf, facts, objectTypes)
    if (!rm) continue
    if (hasFilter && !elementIds.has(nf.id)) continue
    collapsedRefModes.push(rm)
    hiddenByShorthand.add(rm.factId)
  }
  for (const rm of collapsedRefModes) {
    const vtUsedByOtherVisibleFact = facts.some(f => {
      if (f.id === rm.factId) return false
      if (hiddenByShorthand.has(f.id)) return false   // hidden via another collapse
      if (hasFilter && !elementIds.has(f.id)) return false
      return f.roles?.some(r => r.objectTypeId === rm.vtId)
    })
    if (!vtUsedByOtherVisibleFact) hiddenByShorthand.add(rm.vtId)
  }

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
    return merged
  }

  // VT/FT IDs that must be visible because their entity's ref mode is expanded
  // in this diagram. Overrides the elementIds filter so they always show when
  // the user has chosen the expanded form.
  const expandedByRefMode = new Set()
  for (const entityId of expandedRefModes) {
    const entity = objectTypes.find(o => o.id === entityId)
      ?? facts.find(f => f.id === entityId && f.objectified && f.objectifiedKind !== 'value')
    if (!entity) continue
    const rm = findRefMode(entity, facts, objectTypes)
    if (!rm) continue
    expandedByRefMode.add(rm.vtId)
    expandedByRefMode.add(rm.factId)
  }

  const inDiagram = (el) => {
    if (hiddenByShorthand.has(el.id)) return false
    if (expandedByRefMode.has(el.id)) return true
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
