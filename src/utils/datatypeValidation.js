import { datatypeAssignmentToKind } from './datatypeMapping.js'

// Per-profile validation of literal values against a datatype.

function isValidIsoDate(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false
  const [y, m, d] = s.split('-').map(Number)
  if (m < 1 || m > 12) return false
  const dim = new Date(y, m, 0).getDate()   // last day of month m
  return d >= 1 && d <= dim
}

function isValidIsoDatetime(s) {
  // Accept "YYYY-MM-DD[T| ]HH:MM[:SS[.fff]][Z|±HH:MM]"
  const m = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/.exec(s)
  if (!m) return false
  if (!isValidIsoDate(m[1])) return false
  const hh = +m[2], mm = +m[3], ss = m[4] ? +m[4] : 0
  return hh < 24 && mm < 60 && ss < 60
}

/**
 * Validate a literal string against a datatypeAssignment.
 * Returns null when valid (or when no validation applies), or a short error message.
 *
 * Empty/whitespace-only values are treated as "not yet entered" and never produce
 * an error here — callers can decide whether emptiness is itself an issue.
 */
export function validateValueAgainstDatatype(value, assignment) {
  const kind = datatypeAssignmentToKind(assignment)
  if (!kind) return null
  const raw = typeof value === 'string' ? value.trim() : ''
  if (raw === '') return null
  switch (kind) {
    case 'text':
      return null
    case 'integer':
      return /^-?\d+$/.test(raw) ? null : 'not a valid integer'
    case 'decimal':
      return /^-?\d+(\.\d+)?$/.test(raw) ? null : 'not a valid decimal'
    case 'boolean':
      return /^(true|false)$/i.test(raw) ? null : 'not a valid boolean (expected true/false)'
    case 'date':
      return isValidIsoDate(raw) ? null : 'not a valid date (expected YYYY-MM-DD)'
    case 'datetime':
      return isValidIsoDatetime(raw) ? null : 'not a valid datetime (expected YYYY-MM-DDTHH:MM[:SS][Z])'
    default:
      return null
  }
}
