import { useOrmStore } from '../store/ormStore'
import { findRefMode } from '../utils/refMode'

/**
 * Returns schema elements filtered to the active diagram,
 * with positions merged from diagram.occurrences.
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

  // v2 format: diagram.occurrences array; v1 fallback: diagram.positions map
  const hasOccurrences = diagram?.occurrences != null
  const rawPositions = {}
  if (hasOccurrences) {
    for (const occ of (diagram?.occurrences ?? [])) {
      const { id, schemaElementId, ...posData } = occ
      rawPositions[schemaElementId] = posData
    }
  } else {
    Object.assign(rawPositions, diagram?.positions ?? {})
  }

  // Build constraint positions from constraintOccurrences
  const constraintPositions = {}
  for (const cocc of (diagram?.constraintOccurrences ?? [])) {
    constraintPositions[cocc.schemaConstraintId] = { x: cocc.x, y: cocc.y, constraintOccurrenceId: cocc.id }
  }

  // Non-constraint element IDs in occurrences
  const occurrencesList = diagram?.occurrences ?? []
  const occurrenceElementIds = new Set(occurrencesList.map(o => o.schemaElementId))

  // For backward compat with v1 (positions map, no occurrences)
  const hasFilter  = true
  const elementIds = hasOccurrences
    ? occurrenceElementIds
    : new Set(diagram?.elementIds ?? [])

  const expandedRefModeOccs = new Set(diagram?.expandedRefModeOccs ?? [])

  // v2 (occurrence-based): an occurrence is hidden if it was created as part of a ref-mode
  // expansion (refModeOwnerOccId set) but its owner occurrence is no longer expanded.
  // Independent occurrences (refModeOwnerOccId absent/null) are always visible.
  //
  // v1 fallback (positions map): use the old schema-level hiddenByShorthand logic.
  const hiddenOccurrenceIds = new Set()
  const hiddenByShorthand = new Set()   // only used for v1 fallback path
  if (hasOccurrences) {
    for (const occ of occurrencesList) {
      if (occ.refModeOwnerOccId != null && !expandedRefModeOccs.has(occ.refModeOwnerOccId)) {
        hiddenOccurrenceIds.add(occ.id)
      }
    }
  } else {
    // v1: build schema-level hiddenByShorthand (original logic)
    const expandedRefModes = new Set(diagram?.expandedRefModes ?? [])
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
        if (hiddenByShorthand.has(f.id)) return false
        if (hasFilter && !elementIds.has(f.id)) return false
        return f.roles?.some(r => r.objectTypeId === rm.vtId)
      })
      if (!vtUsedByOtherVisibleFact) hiddenByShorthand.add(rm.vtId)
    }
  }

  const withPos = (el) => {
    const p = rawPositions[el.id]
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

  const inDiagram = (el) => {
    if (hiddenByShorthand.has(el.id)) return false
    return !hasFilter || elementIds.has(el.id)
  }

  // Build per-occurrence lists for multi-occurrence support
  let visibleObjectTypes, visibleFacts

  if (hasOccurrences) {
    const otMap   = Object.fromEntries(objectTypes.map(o => [o.id, o]))
    const factMap = Object.fromEntries(facts.map(f => [f.id, f]))

    // One entry per occurrence (supports multiple occurrences of same element)
    visibleObjectTypes = occurrencesList
      .filter(occ => {
        const ot = otMap[occ.schemaElementId]
        if (!ot) return false
        if (hiddenOccurrenceIds.has(occ.id)) return false
        return true
      })
      .map(occ => {
        const { id: occurrenceId, schemaElementId, ...posData } = occ
        const ot = otMap[schemaElementId]
        const merged = { ...ot, ...posData, x: occ.x, y: occ.y, occurrenceId }
        return merged
      })

    visibleFacts = occurrencesList
      .filter(occ => {
        const f = factMap[occ.schemaElementId]
        if (!f) return false
        if (hiddenOccurrenceIds.has(occ.id)) return false
        return true
      })
      .map(occ => {
        const { id: occurrenceId, schemaElementId, ...posData } = occ
        const f = factMap[schemaElementId]
        const merged = { ...f, ...posData, x: occ.x, y: occ.y, occurrenceId }
        // Apply per-diagram layout overrides
        if (posData.readingAbove        !== undefined) merged.readingAbove        = posData.readingAbove
        if (posData.readingOffsetAbove  !== undefined) merged.readingOffsetAbove  = posData.readingOffsetAbove
        if (posData.readingOffsetBelow  !== undefined) merged.readingOffsetBelow  = posData.readingOffsetBelow
        if (posData.uniquenessBelow     !== undefined) merged.uniquenessBelow     = posData.uniquenessBelow
        if (posData.nestedReading       !== undefined) merged.nestedReading       = posData.nestedReading
        if (posData.roleNameOffsets     !== undefined) merged.roleNameOffsets     = posData.roleNameOffsets
        if (posData.valueRangeOffsets   !== undefined) merged.valueRangeOffsets   = posData.valueRangeOffsets
        if (posData.cardinalityRangeOffsets !== undefined) merged.cardinalityRangeOffsets = posData.cardinalityRangeOffsets
        if (posData.nameOffset          !== undefined) merged.nameOffset          = posData.nameOffset
        if (posData.roleOrder           !== undefined) merged.roleOrder           = posData.roleOrder
        if (posData.readingOrder        !== undefined) merged.readingOrder        = posData.readingOrder
        if (posData.orientation         !== undefined) merged.orientation         = posData.orientation
        if (posData.readingDisplay      !== undefined) merged.readingDisplay      = posData.readingDisplay
        return merged
      })
  } else {
    // v1 fallback: use positions map
    visibleObjectTypes = objectTypes.filter(inDiagram).map(ot => ({ ...withPos(ot), occurrenceId: null }))
    visibleFacts       = facts.filter(inDiagram).map(f => ({ ...withPos(f), occurrenceId: null }))
  }

  // visibleConstraints come from constraintOccurrences
  const constraintMap = Object.fromEntries(constraints.map(c => [c.id, c]))
  const visibleConstraints = (diagram?.constraintOccurrences ?? [])
    .map(cocc => {
      const c = constraintMap[cocc.schemaConstraintId]
      if (!c) return null
      return { ...c, x: cocc.x, y: cocc.y, constraintOccurrenceId: cocc.id, roleOccurrenceRefs: cocc.roleOccurrenceRefs ?? [] }
    })
    .filter(Boolean)

  const visibleOtIds   = new Set(visibleObjectTypes.map(o => o.id))
  const visibleFactIds = new Set(visibleFacts.map(f => f.id))
  const allVisibleIds  = new Set([...visibleOtIds, ...visibleFactIds])

  // Subtypes are shown only when explicitly added to the diagram (subtypeOccurrences)
  // and both their endpoints are currently visible.
  const subtypeOccurrenceSet  = new Set(diagram?.subtypeOccurrences ?? [])
  const subtypeEndpointOccs   = diagram?.subtypeEndpointOccs ?? {}
  const allVisibleSubtypes = subtypes
    .filter(st =>
      subtypeOccurrenceSet.has(st.id) &&
      allVisibleIds.has(st.subId) && allVisibleIds.has(st.superId)
    )
    .map(st => {
      const ep = subtypeEndpointOccs[st.id]
      return { ...st, subOccId: ep?.subOccId ?? null, superOccId: ep?.superOccId ?? null }
    })

  return {
    objectTypes:        visibleObjectTypes,
    facts:              visibleFacts,
    constraints:        visibleConstraints,
    subtypes:           allVisibleSubtypes,
    diagram,
    elementIds,
    occurrenceElementIds,
  }
}
