// Constraint types that use the sequences data structure (rather than roleSequences)
// and render using the external constraint mechanism.
export const EXTERNAL_CONSTRAINT_TYPES = new Set([
  'exclusiveOr', 'exclusion', 'inclusiveOr', 'uniqueness', 'equality', 'subset', 'ring', 'frequency', 'valueComparison',
])

// Rake geometry constants — shared between ConstraintNodes (rendering) and
// FactTypeNode (outer-box sizing for objectified facts).
export const RAKE_TOOTH     = 7   // gap from bar outer edge (or role edge) to first spine (= RAKE_STAGGER − RAKE_TOOTH_GAP, giving uniform tooth length across all stagger levels)
export const RAKE_STAGGER   = 9   // distance between successive same-side rake spines
export const RAKE_TOOTH_GAP = 2   // gap between a tooth tip and the spine below it
export const RAKE_COMFORT   = 5   // breathing room inside the outer box past the outermost spine
