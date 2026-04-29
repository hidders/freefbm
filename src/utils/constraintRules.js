// Constraint type classification — shared by Canvas.jsx, ormStore.js, and hooks.

/** Maximum number of role sequences allowed for a constraint type. */
export function constraintMaxSequences(type) {
  if (type === 'equality' || type === 'subset' || type === 'valueComparison') return 2
  if (type === 'ring' || type === 'uniqueness' || type === 'frequency') return 1
  return Infinity
}

/** True for types whose sequences contain exactly one role (inclusiveOr, exclusiveOr). */
export function isSingletonSequence(type) {
  return type === 'inclusiveOr' || type === 'exclusiveOr'
}

/** True for types that use open-ended construction (keep adding roles until Enter). */
export function isOpenEndedConstruction(type) {
  return type === 'equality' || type === 'subset' || type === 'exclusion' ||
    type === 'uniqueness' || type === 'frequency'
}

/** True for types that have a "Set target object type" action. */
export function hasTargetObjectType(type) {
  return type === 'inclusiveOr' || type === 'exclusiveOr' ||
    type === 'uniqueness' || type === 'frequency' || type === 'valueComparison'
}

/** True for types where "Add role position" should be suppressed. */
export function suppressRolePosition(type) {
  return type === 'inclusiveOr' || type === 'exclusiveOr' || type === 'valueComparison' || type === 'ring'
}
