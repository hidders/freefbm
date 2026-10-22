// Default placement of internal frequency markers.
//
// Markers store absolute schema-level x/y, but a fact is drawn at its occurrence
// position in the diagram, which drifts away from the schema-level fact.x/fact.y
// as soon as the fact is moved. New markers must therefore be placed relative to
// the occurrence that carries them (the fact's first occurrence in the active
// diagram, matching moveOccurrence).

import { occOf } from '../store/storeHelpers'

// Mirrors the role-box geometry in FactTypeNode (not imported to avoid a store → component cycle).
const ROLE_W      = 30
const ROLE_H      = 18
const ROLE_GAP    = 1
const BAR_MARGIN  = 4
const BAR_SPACING = 5
const IF_CIRCLE_R = 8
const CLEARANCE   = 8   // gap between the outermost uniqueness bar and the marker

/** The fact as drawn in the active diagram: occurrence position and layout overrides. */
export function factAsDrawn(state, factId) {
  const fact = state.facts.find(f => f.id === factId)
  if (!fact) return null
  const diag = state.diagrams.find(d => d.id === state.activeDiagramId)
  const occ  = diag && occOf(diag, factId)
  if (!occ) return fact
  const merged = { ...fact, x: occ.x, y: occ.y }
  for (const k of ['orientation', 'uniquenessBelow', 'roleOrder']) {
    if (occ[k] !== undefined) merged[k] = occ[k]
  }
  return merged
}

/** Position just beyond the uniqueness bars, centred on the given roles (or the whole fact). */
export function defaultFrequencyPos(fact, roleIndices = []) {
  const n   = Math.max(fact.arity, 1)
  const dro = fact.roleOrder?.length === n ? fact.roleOrder : Array.from({ length: n }, (_, i) => i)
  const total = n * ROLE_W + (n - 1) * ROLE_GAP
  const positions = roleIndices.map(ri => dro.indexOf(ri)).filter(p => p >= 0)
  // Offset of the chosen roles' centre along the fact's axis, relative to the fact centre
  const along = positions.length
    ? positions.reduce((sum, p) => sum + p * (ROLE_W + ROLE_GAP) + ROLE_W / 2, 0) / positions.length - total / 2
    : 0
  const uniq   = fact.uniqueness || []
  const levels = (uniq.some(u => u.length === 1) ? 1 : 0) + uniq.filter(u => u.length > 1).length
  const across = ROLE_H / 2 + (levels > 0 ? BAR_MARGIN + BAR_SPACING * levels : 0) + CLEARANCE + IF_CIRCLE_R
  // Bars sit above (horizontal) or right (vertical) unless uniquenessBelow flips them
  const sign = fact.uniquenessBelow ? 1 : -1
  if (fact.orientation === 'vertical') {
    return { x: Math.round(fact.x - sign * across), y: Math.round(fact.y + along) }
  }
  return { x: Math.round(fact.x + along), y: Math.round(fact.y + sign * across) }
}
