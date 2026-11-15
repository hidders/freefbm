// Default placement of internal frequency markers.
//
// Markers store absolute schema-level x/y, but a fact is drawn at its occurrence
// position in the diagram, which drifts away from the schema-level fact.x/fact.y
// as soon as the fact is moved. New markers must therefore be placed relative to
// the occurrence that carries them (the fact's first occurrence in the active
// diagram, matching moveOccurrence).

import { occOf } from '../store/storeHelpers'
import {
  ROLE_W, ROLE_H, ROLE_GAP, LABEL_SIZE, READING_GAP, READING_Y_ABOVE, READING_Y_BELOW,
  READING_CAP_ABOVE, READING_DESC_BELOW, IF_CIRCLE_R, barInkExtent, nestedFactBounds, ifShapeHalfW,
} from '../components/FactTypeNode.jsx'
import { OT_STROKE, formatFrequencyRange } from '../components/ObjectTypeNode.jsx'

// The stadium's padding around a marker's text (FactTypeNode's IF_PAD_X)
const IF_PAD_X = 5
// Half the height of a marker's text (drawn with dominant-baseline central)
const IF_HALF_H = LABEL_SIZE / 2

/** The fact as drawn in the active diagram: occurrence position and layout overrides. */
export function factAsDrawn(state, factId) {
  const fact = state.facts.find(f => f.id === factId)
  if (!fact) return null
  const diag = state.diagrams.find(d => d.id === state.activeDiagramId)
  const occ  = diag && occOf(diag, factId)
  if (!occ) return fact
  const merged = { ...fact, x: occ.x, y: occ.y }
  for (const k of ['orientation', 'uniquenessBelow', 'roleOrder', 'readingAbove', 'readingOffsetAbove', 'readingOffsetBelow', 'displayAsObjectType']) {
    if (occ[k] !== undefined) merged[k] = occ[k]
  }
  return merged
}

// Whether a reading is drawn in its default place on the bar side of a
// horizontal fact type (sign -1: above, 1: below).
function readingOnSide(fact, sign) {
  const drawn = [fact.readingParts, ...(fact.alternativeReadings ?? []).map(r => r.parts)]
    .some(parts => parts?.some(p => p?.trim()))
  if (!drawn || (fact.objectified && fact.nestedReading)) return false
  return sign < 0 ? !!fact.readingAbove && !fact.readingOffsetAbove : !fact.readingAbove && !fact.readingOffsetBelow
}

/**
 * Position READING_GAP beyond what is drawn on the side of the uniqueness
 * bars, centred on the given roles (or the whole fact): beyond the bars and a
 * reading in its default place there; for an objectified fact type beside
 * its outline (`range` gives the label's width).
 */
export function defaultFrequencyPos(fact, roleIndices = [], range = null) {
  const label = formatFrequencyRange(range)
  const halfW = label ? ifShapeHalfW(label) - IF_PAD_X : IF_CIRCLE_R   // the text's half width
  const n   = Math.max(fact.arity, 1)
  const dro = fact.roleOrder?.length === n ? fact.roleOrder : Array.from({ length: n }, (_, i) => i)
  const total = n * ROLE_W + (n - 1) * ROLE_GAP
  const positions = roleIndices.map(ri => dro.indexOf(ri)).filter(p => p >= 0)
  // Offset of the chosen roles' centre along the fact's axis, relative to the fact centre
  const along = positions.length
    ? positions.reduce((sum, p) => sum + p * (ROLE_W + ROLE_GAP) + ROLE_W / 2, 0) / positions.length - total / 2
    : 0
  const uniq   = (fact.uniqueness || []).map(u => u.roles)
  const covered = new Set((fact.preferredUniqueness || []).flat())
  const implied = (fact.preferredUniqueness || []).length > 0 && covered.size < n
  const levels = (uniq.some(u => u.length === 1) || implied ? 1 : 0) + uniq.filter(u => u.length > 1).length
  const preferred = (fact.preferredUniqueness || []).length > 0
  // Bars sit above (horizontal) or right (vertical) unless uniquenessBelow flips them
  const sign = fact.uniquenessBelow ? 1 : -1
  const vertical = fact.orientation === 'vertical'

  if (fact.objectified) {
    const b = nestedFactBounds(fact)
    if (vertical) {
      const edge = sign < 0 ? b.right + OT_STROKE / 2 : b.left - OT_STROKE / 2
      return { x: Math.round(edge - sign * (READING_GAP + IF_CIRCLE_R)), y: Math.round(fact.y + along) }
    }
    // Beside the outline, level with the roles, on the side nearer the chosen
    // roles: above and below are the name, the bars and the reading.
    const side = along > 0 ? 1 : -1
    const edge = side > 0 ? b.right + OT_STROKE / 2 : b.left - OT_STROKE / 2
    return { x: Math.round(edge + side * (READING_GAP + halfW)), y: Math.round(fact.y) }
  }

  let ink = ROLE_H / 2 + barInkExtent(levels, preferred)
  if (vertical) {
    return { x: Math.round(fact.x - sign * (ink + READING_GAP + IF_CIRCLE_R)), y: Math.round(fact.y + along) }
  }
  if (readingOnSide(fact, sign)) ink += sign < 0 ? READING_Y_ABOVE + READING_CAP_ABOVE : READING_Y_BELOW + READING_DESC_BELOW
  return { x: Math.round(fact.x + along), y: Math.round(fact.y + sign * (ink + READING_GAP + IF_HALF_H)) }
}
