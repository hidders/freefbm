import { valueKindOf } from './datatypeValues.js'

// Per-profile validation of literal values against a datatype.

/**
 * Validate a literal string against a datatypeAssignment.
 * Returns null when valid (or when no validation applies), or a short error message.
 *
 * Empty/whitespace-only values are treated as "not yet entered" and never produce
 * an error here — callers can decide whether emptiness is itself an issue.
 */
export function validateValueAgainstDatatype(value, assignment) {
  const kind = valueKindOf(assignment)
  if (!kind) return null
  const raw = typeof value === 'string' ? value.trim() : ''
  if (raw === '') return null
  return kind.parse(raw).invalid ? `not a valid ${kind.expect}` : null
}
