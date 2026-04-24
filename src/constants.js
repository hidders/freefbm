// Constraint types that use the sequences data structure (rather than roleSequences)
// and render using the external constraint mechanism.
export const EXTERNAL_CONSTRAINT_TYPES = new Set([
  'exclusiveOr', 'exclusion', 'inclusiveOr', 'uniqueness', 'equality', 'subset', 'ring',
])
