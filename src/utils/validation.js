// ORM2 schema validation rules, organised by category (matching NORMA's grouping).

import { findIdentifierCycles, canBeExternalUniquenessPI, findCompositePI, findRefMode, findInheritedPI, findAllInheritedPIs } from './refMode.js'
import { datatypeAssignmentToKind } from './datatypeMapping.js'
import { EXTERNAL_CONSTRAINT_TYPES } from '../constants.js'

export const VALIDATION_CATEGORIES = {
  factTypeDefinition: {
    label: 'Fact Type Definition',
    description: 'Missing role players, missing or redundant internal uniqueness constraints',
  },
  constraintStructure: {
    label: 'Constraint Structure',
    description: 'Role sequence arity mismatches, insufficient role sequences, missing queries on external constraints',
  },
  identification: {
    label: 'Identification',
    description: 'Missing preferred identifiers, multiple PI sources on one entity, cycles in the identifier graph',
  },
  naming: {
    label: 'Naming',
    description: 'Duplicate object type names, duplicate predicate readings',
  },
  redundantConcepts: {
    label: 'Redundant Concepts',
    description: 'Cycles in the subtype graph, mandatory unary fact types',
  },
  subtypeHierarchy: {
    label: 'Subtype Hierarchy',
    description: 'Each entity type must belong to exactly one root type hierarchy (no multiple inheritance from different roots)',
  },
  rangeSequences: {
    label: 'Range Sequences',
    description: 'Issues in value and frequency range specifications',
  },
}

export const DEFAULT_VALIDATION_CATEGORIES = Object.fromEntries(
  Object.keys(VALIDATION_CATEGORIES).map(k => [k, k !== 'subtypeHierarchy'])
)

// Human-readable constraint type labels for error messages
const CONSTRAINT_LABELS = {
  exclusion:    'Exclusion',
  equality:     'Equality',
  subset:       'Subset',
  inclusiveOr:  'Inclusive Or',
  exclusiveOr:  'Exclusive Or',
  uniqueness:   'External Uniqueness',
  frequency:    'Frequency',
  ring:         'Ring',
  valueComparison: 'Value Comparison',
}

const MULTI_SEQUENCE_TYPES = new Set(['exclusion', 'equality', 'subset', 'inclusiveOr', 'exclusiveOr'])

// Sentinels for unbounded interval sides. Using Symbols (instead of ±Infinity)
// lets the same comparator handle numeric, string, date, and boolean ranges.
const NEG_INF = Symbol('-∞')
const POS_INF = Symbol('+∞')

// Three-way compare for values returned by parseTypedValue (or for the ±∞
// sentinels). Works for Number, String, and the sentinels — i.e. lexicographic
// for strings, numeric for everything else.
function cmpVals(a, b) {
  if (a === NEG_INF) return b === NEG_INF ? 0 : -1
  if (a === POS_INF) return b === POS_INF ? 0 : 1
  if (b === NEG_INF) return 1
  if (b === POS_INF) return -1
  if (a < b) return -1
  if (a > b) return 1
  return 0
}

// Parse a single literal value according to the datatype kind. Returns one of:
//   { value: <comparable> }  — parsed successfully
//   { empty: true }          — blank field
//   { invalid: true }        — present but doesn't match the type
//
// "Comparable" means: integers/decimals → Number, date/datetime → timestamp ms,
// boolean → 0/1 (false<true), text → the trimmed string. Unknown / missing
// typeKind falls back to numeric parsing for backward compatibility with
// cardinality/frequency ranges (which are always integer in practice).
function parseTypedValue(raw, typeKind) {
  const s = typeof raw === 'string' ? raw.trim() : raw
  if (s === '' || s == null) return { empty: true }
  const str = String(s)
  switch (typeKind) {
    case 'integer':
      return /^-?\d+$/.test(str) ? { value: Number(str) } : { invalid: true }
    case 'decimal':
      return /^-?\d+(\.\d+)?$/.test(str) ? { value: Number(str) } : { invalid: true }
    case 'boolean': {
      const lo = str.toLowerCase()
      if (lo === 'true')  return { value: 1 }
      if (lo === 'false') return { value: 0 }
      return { invalid: true }
    }
    case 'date': {
      // Reuse the strict ISO date check (YYYY-MM-DD) via Date.parse + length test.
      if (!/^\d{4}-\d{2}-\d{2}$/.test(str)) return { invalid: true }
      const t = Date.parse(str)
      return Number.isNaN(t) ? { invalid: true } : { value: t }
    }
    case 'datetime': {
      const t = Date.parse(str)
      return Number.isNaN(t) ? { invalid: true } : { value: t }
    }
    case 'text':
      return { value: str }
    default: {
      const n = Number(str)
      return Number.isNaN(n) ? { invalid: true } : { value: n }
    }
  }
}

// Parse a range spec into an interval { lo, hi, parseable, emptyFields,
// invalidFields }, where lo/hi may be NEG_INF / POS_INF for unbounded sides.
// `parseable` is true only when every required bound parsed cleanly.
function specInterval(spec, typeKind) {
  const p = (v) => parseTypedValue(v, typeKind)
  if (spec.type === 'single') {
    const v = p(spec.value)
    return {
      lo: v.value !== undefined ? v.value : null,
      hi: v.value !== undefined ? v.value : null,
      parseable: v.value !== undefined,
      emptyFields:   v.empty   ? ['value'] : [],
      invalidFields: v.invalid ? ['value'] : [],
    }
  }
  if (spec.type === 'lower') {
    const v = p(spec.lower)
    return {
      lo: v.value !== undefined ? v.value : null,
      hi: POS_INF,
      parseable: v.value !== undefined,
      emptyFields:   v.empty   ? ['lower'] : [],
      invalidFields: v.invalid ? ['lower'] : [],
    }
  }
  if (spec.type === 'upper') {
    const v = p(spec.upper)
    return {
      lo: NEG_INF,
      hi: v.value !== undefined ? v.value : null,
      parseable: v.value !== undefined,
      emptyFields:   v.empty   ? ['upper'] : [],
      invalidFields: v.invalid ? ['upper'] : [],
    }
  }
  if (spec.type === 'range') {
    const a = p(spec.lower)
    const b = p(spec.upper)
    const emptyFields = []
    const invalidFields = []
    if (a.empty)   emptyFields.push('lower')
    if (b.empty)   emptyFields.push('upper')
    if (a.invalid) invalidFields.push('lower')
    if (b.invalid) invalidFields.push('upper')
    return {
      lo: a.value !== undefined ? a.value : null,
      hi: b.value !== undefined ? b.value : null,
      parseable: a.value !== undefined && b.value !== undefined,
      emptyFields,
      invalidFields,
    }
  }
  return { lo: null, hi: null, parseable: false, emptyFields: [], invalidFields: [] }
}

// Push all Range Sequences errors for one (range, context) pair into `errors`.
// ctx = { elementId, elementKind, label, idSuffix, typeKind, typeName }
//   typeKind: 'integer' | 'decimal' | 'text' | 'date' | 'datetime' | 'boolean' | null
//   typeName: human label for type-mismatch messages (e.g. "integer")
function validateRangeSequence(range, ctx, errors) {
  const specs = range || []
  if (specs.length === 0) return
  const ivs = specs.map(s => specInterval(s, ctx.typeKind))

  // (1) Empty bounds
  for (let i = 0; i < ivs.length; i++) {
    if (ivs[i].emptyFields.length > 0) {
      errors.push({
        id: `range-empty-${ctx.idSuffix}-${i}`,
        category: 'rangeSequences',
        elementId: ctx.elementId,
        elementKind: ctx.elementKind,
        message: `${ctx.label}: spec ${i + 1} has empty ${ivs[i].emptyFields.join(' and ')} field`,
        severity: 'error',
      })
    }
  }

  // (2) Type mismatch — value present but doesn't match the declared datatype.
  // We only emit this when we actually know the type; otherwise parsing falls
  // back to numeric and any non-numeric string would falsely flag.
  if (ctx.typeKind) {
    for (let i = 0; i < ivs.length; i++) {
      if (ivs[i].invalidFields.length > 0) {
        const tn = ctx.typeName || ctx.typeKind
        errors.push({
          id: `range-typemismatch-${ctx.idSuffix}-${i}`,
          category: 'rangeSequences',
          elementId: ctx.elementId,
          elementKind: ctx.elementKind,
          message: `${ctx.label}: spec ${i + 1} has ${ivs[i].invalidFields.join(' and ')} value that is not a valid ${tn}`,
          severity: 'error',
        })
      }
    }
  }

  // (3) Lower > upper inside a {type: 'range'} spec
  for (let i = 0; i < ivs.length; i++) {
    if (specs[i].type === 'range' && ivs[i].parseable && cmpVals(ivs[i].lo, ivs[i].hi) > 0) {
      errors.push({
        id: `range-lo-gt-hi-${ctx.idSuffix}-${i}`,
        category: 'rangeSequences',
        elementId: ctx.elementId,
        elementKind: ctx.elementKind,
        message: `${ctx.label}: spec ${i + 1} has lower bound greater than upper bound`,
        severity: 'error',
      })
    }
  }

  // Sequence-level checks below only run if every spec parsed cleanly.
  if (!ivs.every(iv => iv.parseable)) return

  // (4) Overlap — intervals [A.lo, A.hi] and [B.lo, B.hi] overlap iff
  // max(A.lo, B.lo) <= min(A.hi, B.hi), using the type-aware comparator.
  for (let i = 0; i < ivs.length; i++) {
    for (let j = i + 1; j < ivs.length; j++) {
      const A = ivs[i], B = ivs[j]
      const maxLo = cmpVals(A.lo, B.lo) >= 0 ? A.lo : B.lo
      const minHi = cmpVals(A.hi, B.hi) <= 0 ? A.hi : B.hi
      if (cmpVals(maxLo, minHi) <= 0) {
        errors.push({
          id: `range-overlap-${ctx.idSuffix}-${i}-${j}`,
          category: 'rangeSequences',
          elementId: ctx.elementId,
          elementKind: ctx.elementKind,
          message: `${ctx.label}: spec ${i + 1} and spec ${j + 1} overlap`,
          severity: 'warning',
        })
      }
    }
  }

  // (5) Adjacent/mergeable — only meaningful when there's a discrete successor.
  // We enable it for integer-typed ranges (cardinality, frequency, and value
  // ranges declared as integer). For text/decimal/date/datetime/boolean there's
  // no natural "next" value, so we skip.
  if (ctx.typeKind === 'integer') {
    for (let i = 0; i < ivs.length; i++) {
      for (let j = i + 1; j < ivs.length; j++) {
        const A = ivs[i], B = ivs[j]
        const maxLo = cmpVals(A.lo, B.lo) >= 0 ? A.lo : B.lo
        const minHi = cmpVals(A.hi, B.hi) <= 0 ? A.hi : B.hi
        // Already overlap → mergeable warning would be redundant
        if (cmpVals(maxLo, minHi) <= 0) continue
        // Both endpoints must be finite to talk about a "+1 gap"
        if (typeof minHi !== 'number' || typeof maxLo !== 'number') continue
        if (minHi + 1 === maxLo) {
          errors.push({
            id: `range-mergeable-${ctx.idSuffix}-${i}-${j}`,
            category: 'rangeSequences',
            elementId: ctx.elementId,
            elementKind: ctx.elementKind,
            message: `${ctx.label}: spec ${i + 1} and spec ${j + 1} are adjacent and could be merged`,
            severity: 'warning',
          })
        }
      }
    }
  }

  // (6) Out of ascending order — adjacent pairs in the user's original sequence
  for (let i = 1; i < ivs.length; i++) {
    if (cmpVals(ivs[i].lo, ivs[i - 1].lo) < 0) {
      errors.push({
        id: `range-out-of-order-${ctx.idSuffix}-${i}`,
        category: 'rangeSequences',
        elementId: ctx.elementId,
        elementKind: ctx.elementKind,
        message: `${ctx.label}: spec ${i + 1} starts before spec ${i} (sequence is not in ascending order)`,
        severity: 'warning',
      })
    }
  }
}

// Reflexive transitive closure of the supertype relation upward from `otId`.
function ancestorSet(otId, subtypes) {
  const visited = new Set()
  const queue = [otId]
  while (queue.length) {
    const curr = queue.shift()
    if (visited.has(curr)) continue
    visited.add(curr)
    for (const st of subtypes) { if (st.subId === curr) queue.push(st.superId) }
  }
  return visited
}

// True iff ∃C that is a supertype of both ot0Id and ot1Id (reflexive transitive closure).
function areComparable(ot0Id, ot1Id, subtypes) {
  if (ot0Id === ot1Id) return true
  const ancs0 = ancestorSet(ot0Id, subtypes)
  const ancs1 = ancestorSet(ot1Id, subtypes)
  for (const id of ancs0) { if (ancs1.has(id)) return true }
  return false
}

// True iff ∃C that is a supertype of ALL otIds simultaneously (reflexive transitive closure).
function haveCommonSupertype(otIds, subtypes) {
  if (otIds.length <= 1) return true
  let common = ancestorSet(otIds[0], subtypes)
  for (let i = 1; i < otIds.length; i++) {
    const ancs = ancestorSet(otIds[i], subtypes)
    common = new Set([...common].filter(x => ancs.has(x)))
    if (common.size === 0) return false
  }
  return true
}

// Build the predicate reading signature: interleaved reading parts and [OT name] tokens.
// Returns null if any role in the reading's roleOrder lacks an object type (incomplete).
function readingSignature(parts, roleOrder, roles, otMap) {
  if (!parts || parts.length === 0) return null
  let sig = (parts[0] || '').trim()
  for (let i = 0; i < roleOrder.length; i++) {
    const ot = otMap[roles[roleOrder[i]]?.objectTypeId]
    if (!ot) return null
    sig += `[${ot.name}]${(parts[i + 1] || '').trim()}`
  }
  return sig.toLowerCase()
}

export function runValidation({ objectTypes, facts, constraints, subtypes = [] }, enabledCategories) {
  const errors = []

  // ── Fact Type Definition ─────────────────────────────────────────────────────
  if (enabledCategories.has('factTypeDefinition')) {
    for (const f of facts) {
      if (f._implicit) continue  // implied links are synthetic — skip

      // RolePlayerRequiredError: every role must have an object type assigned
      for (let ri = 0; ri < f.roles.length; ri++) {
        if (!f.roles[ri]?.objectTypeId) {
          errors.push({
            id: `role-player-${f.id}-${ri}`,
            category: 'factTypeDefinition',
            elementId: f.id,
            elementKind: 'fact',
            message: `Role ${ri + 1} has no object type assigned`,
            severity: 'error',
          })
        }
      }

      // FactTypeRequiresInternalUniquenessConstraintError: non-unary facts need at least one
      // internal UC. An implied UC from a cross-fact external uniqueness PI also satisfies this.
      if (f.arity >= 2 && (!f.uniqueness || f.uniqueness.length === 0)) {
        const hasImpliedUC = objectTypes.some(ot => {
          if (ot.kind !== 'entity') return false
          const cp = findCompositePI(ot, facts, objectTypes, constraints)
          return cp && cp.factIds?.includes(f.id)
        })
        if (!hasImpliedUC) {
          errors.push({
            id: `fact-needs-uniqueness-${f.id}`,
            category: 'factTypeDefinition',
            elementId: f.id,
            elementKind: 'fact',
            message: 'Non-unary fact type has no internal uniqueness constraint',
            severity: 'warning',
          })
        }
      }

      // RedundantInternalUniquenessConstraintWarning
      // A constraint on role set J is redundant if another constraint (explicit or implied)
      // covers a proper subset of J.
      const ucs = f.uniqueness || []
      // Compute implied unary UCs using the same logic as FactTypeNode / RoleConnectors.
      const valExistingUnary = new Set(ucs.filter(u => u.length === 1).map(u => u[0]))
      const valImpliedRoles = []
      ;(f.preferredUniqueness || []).forEach(pu => {
        const covered = new Set(pu)
        for (let ri = 0; ri < f.arity; ri++) {
          if (!covered.has(ri) && !valExistingUnary.has(ri) && !valImpliedRoles.includes(ri))
            valImpliedRoles.push(ri)
        }
      })
      for (const ot of objectTypes) {
        if (ot.kind !== 'entity') continue
        const cp = findCompositePI(ot, facts, objectTypes, constraints)
        if (!cp || !cp.factIds?.includes(f.id)) continue
        const ci = cp.factIds.indexOf(f.id)
        const entityRoleIdx = cp.entityRoleIndices?.[ci] ?? cp.entityRoleIndex
        if (entityRoleIdx != null && !valExistingUnary.has(entityRoleIdx) && !valImpliedRoles.includes(entityRoleIdx))
          valImpliedRoles.push(entityRoleIdx)
      }
      // Merge explicit + virtual implied UCs for the redundancy source check.
      const allUCsForRedundancy = [...ucs, ...valImpliedRoles.map(r => [r])]
      for (let j = 0; j < ucs.length; j++) {
        const rolesJ = new Set(ucs[j])
        for (let i = 0; i < allUCsForRedundancy.length; i++) {
          if (i === j) continue
          const rolesI = allUCsForRedundancy[i]
          if (rolesI.length < rolesJ.size && rolesI.every(r => rolesJ.has(r))) {
            const redundant = ucs[j].map(r => r + 1).sort((a, b) => a - b).join(', ')
            const covered   = rolesI.map(r => r + 1).sort((a, b) => a - b).join(', ')
            const fromImplied = i >= ucs.length
            errors.push({
              id: `redundant-uc-${f.id}-${j}`,
              category: 'factTypeDefinition',
              elementId: f.id,
              elementKind: 'fact',
              message: fromImplied
                ? `Uniqueness on role(s) ${redundant} is redundant: the preferred identifier implies a unary uniqueness on role(s) ${covered}`
                : `Uniqueness on role(s) ${redundant} is redundant: implied by constraint on role(s) ${covered}`,
              severity: 'warning',
            })
            break
          }
        }
      }
    }
  }

  // ── Constraint Structure ─────────────────────────────────────────────────────
  if (enabledCategories.has('constraintStructure')) {
    const ARITY_SENSITIVE = new Set(['equality', 'subset', 'exclusion', 'inclusiveOr', 'exclusiveOr'])
    const factById = new Map(facts.map(f => [f.id, f]))
    const otById   = new Map(objectTypes.map(o => [o.id, o]))
    for (const c of constraints) {
      const sequences = c.sequences || []
      const label = CONSTRAINT_LABELS[c.constraintType] ?? c.constraintType

      // TooFewRoleSequencesError: multi-sequence constraints need ≥ 2 sequences
      if (MULTI_SEQUENCE_TYPES.has(c.constraintType) && sequences.length < 2) {
        errors.push({
          id: `too-few-sequences-${c.id}`,
          category: 'constraintStructure',
          elementId: c.id,
          elementKind: 'constraint',
          message: `${label} constraint needs at least 2 role sequences (has ${sequences.length})`,
          severity: 'warning',
        })
      }

      // RoleSequenceArityMismatchError: all sequences of an arity-sensitive constraint must be the same length
      if (ARITY_SENSITIVE.has(c.constraintType) && sequences.length >= 2) {
        const lengths = sequences.map(s => s.length)
        const allSame = lengths.every(l => l === lengths[0])
        if (!allSame) {
          errors.push({
            id: `arity-mismatch-${c.id}`,
            category: 'constraintStructure',
            elementId: c.id,
            elementKind: 'constraint',
            message: `${label} constraint has role sequences of unequal length (${lengths.join(', ')})`,
            severity: 'warning',
          })
        }
      }

      // Exclusion / Equality / Subset: for each position, all sequence object types at that position must share a common supertype.
      if ((c.constraintType === 'exclusion' || c.constraintType === 'equality' || c.constraintType === 'subset') && sequences.length >= 2) {
        const anchorOtId = (m) => {
          if (!m) return null
          if (m.kind === 'subtype') return subtypes.find(s => s.id === m.subtypeId)?.superId ?? null
          if (m.kind === 'role')    return factById.get(m.factId)?.roles?.[m.roleIndex]?.objectTypeId ?? null
          return null
        }
        const seqLen = sequences[0]?.length ?? 0
        for (let p = 0; p < seqLen; p++) {
          const otIds = sequences.map(s => anchorOtId(s?.[p])).filter(Boolean)
          if (otIds.length < 2) continue
          if (!haveCommonSupertype(otIds, subtypes)) {
            errors.push({
              id: `seq-incomparable-${c.id}-${p}`,
              category: 'constraintStructure',
              elementId: c.id,
              elementKind: 'constraint',
              message: `${label} constraint: object types at position ${p + 1} across sequences do not all share a common supertype`,
              severity: 'warning',
            })
          }
        }
      }

      // Ring-specific structural checks
      if (c.constraintType === 'ring') {
        const seq = sequences[0]
        if (sequences.length === 0 || !seq || seq.length === 0) {
          errors.push({
            id: `ring-no-sequence-${c.id}`,
            category: 'constraintStructure',
            elementId: c.id, elementKind: 'constraint',
            message: `${label} constraint has no role sequence defined`,
            severity: 'warning',
          })
        } else {
          const roleMembers = seq.filter(m => m.kind === 'role')
          if (roleMembers.length !== 2) {
            errors.push({
              id: `ring-wrong-arity-${c.id}`,
              category: 'constraintStructure',
              elementId: c.id, elementKind: 'constraint',
              message: `${label} constraint requires exactly 2 roles in its sequence (has ${roleMembers.length})`,
              severity: 'warning',
            })
          } else {
            const playerOtId = (ref) => factById.get(ref.factId)?.roles?.[ref.roleIndex]?.objectTypeId ?? null
            const ot0 = playerOtId(roleMembers[0])
            const ot1 = playerOtId(roleMembers[1])
            if (ot0 && ot1 && !areComparable(ot0, ot1, subtypes)) {
              errors.push({
                id: `ring-different-players-${c.id}`,
                category: 'constraintStructure',
                elementId: c.id, elementKind: 'constraint',
                message: `${label} constraint: both roles must be played by comparable object types (sharing a common supertype)`,
                severity: 'warning',
              })
            }
          }
        }
      }

      // Value-comparison-specific structural checks (one sequence, two role members, same value type)
      if (c.constraintType === 'valueComparison') {
        const seq = sequences[0]
        if (sequences.length === 0 || !seq || seq.length === 0) {
          errors.push({
            id: `vc-no-sequence-${c.id}`,
            category: 'constraintStructure',
            elementId: c.id, elementKind: 'constraint',
            message: `${label} constraint has no role sequence defined`,
            severity: 'warning',
          })
        } else {
          const roleMembers = seq.filter(m => m.kind === 'role')
          if (roleMembers.length !== 2) {
            errors.push({
              id: `vc-wrong-arity-${c.id}`,
              category: 'constraintStructure',
              elementId: c.id, elementKind: 'constraint',
              message: `${label} constraint requires exactly 2 roles in its sequence (has ${roleMembers.length})`,
              severity: 'warning',
            })
          } else {
            const playerOtId = (ref) => factById.get(ref.factId)?.roles?.[ref.roleIndex]?.objectTypeId ?? null
            const ot0 = playerOtId(roleMembers[0])
            const ot1 = playerOtId(roleMembers[1])
            if (ot0 && ot1 && ot0 !== ot1) {
              errors.push({
                id: `vc-different-players-${c.id}`,
                category: 'constraintStructure',
                elementId: c.id, elementKind: 'constraint',
                message: `${label} constraint: both roles must be played by the same value type`,
                severity: 'warning',
              })
            } else if (ot0 && otById.get(ot0)?.kind !== 'value') {
              errors.push({
                id: `vc-not-value-type-${c.id}`,
                category: 'constraintStructure',
                elementId: c.id, elementKind: 'constraint',
                message: `${label} constraint: roles must be played by a value type`,
                severity: 'warning',
              })
            }
          }
        }
      }

      // Inclusive Or: target OT and all sequence anchor OTs must share a single common supertype.
      if (c.constraintType === 'inclusiveOr' && c.targetObjectTypeId) {
        const seqOtIds = sequences.map(seq => {
          if (!Array.isArray(seq) || seq.length !== 1) return null
          const m = seq[0]
          if (m.kind === 'subtype') return subtypes.find(s => s.id === m.subtypeId)?.superId ?? null
          if (m.kind === 'role') return factById.get(m.factId)?.roles?.[m.roleIndex]?.objectTypeId ?? null
          return null
        }).filter(Boolean)
        const allOtIds = [c.targetObjectTypeId, ...seqOtIds]
        if (allOtIds.length >= 2 && !haveCommonSupertype(allOtIds, subtypes)) {
          errors.push({
            id: `inclusive-or-incomparable-${c.id}`,
            category: 'constraintStructure',
            elementId: c.id,
            elementKind: 'constraint',
            message: `${label} constraint: target object type and sequence object types do not all share a common supertype`,
            severity: 'warning',
          })
        }
      }

      // Exclusive Or: target OT and all sequence anchor OTs must share a single common supertype.
      if (c.constraintType === 'exclusiveOr' && c.targetObjectTypeId) {
        const seqOtIds = sequences.map(seq => {
          if (!Array.isArray(seq) || seq.length !== 1) return null
          const m = seq[0]
          if (m.kind === 'subtype') return subtypes.find(s => s.id === m.subtypeId)?.superId ?? null
          if (m.kind === 'role') return factById.get(m.factId)?.roles?.[m.roleIndex]?.objectTypeId ?? null
          return null
        }).filter(Boolean)
        const allOtIds = [c.targetObjectTypeId, ...seqOtIds]
        if (allOtIds.length >= 2 && !haveCommonSupertype(allOtIds, subtypes)) {
          errors.push({
            id: `exclusive-or-incomparable-${c.id}`,
            category: 'constraintStructure',
            elementId: c.id, elementKind: 'constraint',
            message: `${label} constraint: target object type and sequence object types do not all share a common supertype`,
            severity: 'warning',
          })
        }
      }

      // MissingQueryError: every non-empty role sequence of an external constraint
      // must have a query (used for query-pattern visualisation and population checks).
      if (EXTERNAL_CONSTRAINT_TYPES.has(c.constraintType)) {
        const queries = c.queries ?? []
        for (let i = 0; i < sequences.length; i++) {
          if ((sequences[i] || []).length === 0) continue  // empty sequence — skip
          if (queries[i] != null) continue                  // query present — OK
          errors.push({
            id: `missing-query-${c.id}-${i}`,
            category: 'constraintStructure',
            elementId: c.id,
            elementKind: 'constraint',
            message: `${label} constraint: sequence ${i + 1} has no query defined`,
            severity: 'warning',
          })
        }
      }

      // InvalidPreferredIdentifierError: external uniqueness marked as PI must satisfy
      // the four structural conditions (binary facts, no duplicates, same uncovered OT).
      if (c.constraintType === 'uniqueness' && c.isPreferredIdentifier) {
        const piCheck = canBeExternalUniquenessPI(c, facts)
        if (!piCheck.ok) {
          errors.push({
            id: `invalid-pi-${c.id}`,
            category: 'constraintStructure',
            elementId: c.id,
            elementKind: 'constraint',
            message: `External Uniqueness constraint marked as Preferred Identifier: ${piCheck.reason}`,
            severity: 'error',
          })
        }
      }

    }
  }

  // ── Naming ───────────────────────────────────────────────────────────────────
  if (enabledCategories.has('naming')) {
    // ObjectTypeDuplicateNameError — all object type names (entity, value, nested entity) must be globally unique
    // name → [{ elementId, elementKind }]
    const globalNameMap = {}
    for (const ot of objectTypes) {
      const name = ot.name?.trim()
      if (!name) continue
      if (!globalNameMap[name]) globalNameMap[name] = []
      globalNameMap[name].push({ elementId: ot.id, elementKind: ot.kind === 'value' ? 'value' : 'entity' })
    }
    for (const f of facts) {
      if (!f.objectified) continue
      const name = f.objectifiedName?.trim()
      if (!name) continue
      if (!globalNameMap[name]) globalNameMap[name] = []
      globalNameMap[name].push({ elementId: f.id, elementKind: 'fact' })
    }
    for (const [name, entries] of Object.entries(globalNameMap)) {
      if (entries.length > 1) {
        for (const { elementId, elementKind } of entries) {
          errors.push({
            id: `dup-name-${elementId}`,
            category: 'naming',
            elementId,
            elementKind,
            message: `Duplicate object type name: "${name}"`,
            severity: 'error',
          })
        }
      }
    }

    // DuplicateReadingSignatureError — both within-fact and cross-fact duplicates
    const otMap = Object.fromEntries(objectTypes.map(o => [o.id, o]))
    const globalSigMap = {}  // sig → [factId, ...]

    for (const f of facts) {
      if (f._implicit) continue

      // Gather all readings for this fact type (main + alternatives)
      const n = Math.max(f.arity, 1)
      const defaultOrder = Array.from({ length: n }, (_, i) => i)
      const readings = []
      if (f.readingParts) readings.push({ parts: f.readingParts, roleOrder: defaultOrder })
      for (const alt of f.alternativeReadings || []) {
        if (alt.parts) readings.push({ parts: alt.parts, roleOrder: alt.roleOrder ?? defaultOrder })
      }

      // (b) Within-fact duplicates
      const localSigs = {}
      for (const r of readings) {
        const sig = readingSignature(r.parts, r.roleOrder, f.roles, otMap)
        if (sig === null) continue  // skip incomplete readings
        if (localSigs[sig]) {
          errors.push({
            id: `dup-reading-local-${f.id}-${sig}`,
            category: 'naming',
            elementId: f.id,
            elementKind: 'fact',
            message: `Duplicate predicate reading within fact type: "${sig}"`,
            severity: 'error',
          })
        } else {
          localSigs[sig] = true
        }
      }

      // Collect for cross-fact check (a)
      for (const sig of Object.keys(localSigs)) {
        if (!globalSigMap[sig]) globalSigMap[sig] = []
        globalSigMap[sig].push(f.id)
      }
    }

    // (a) Cross-fact duplicates: same signature appears in two or more fact types
    for (const [sig, factIds] of Object.entries(globalSigMap)) {
      if (factIds.length > 1) {
        for (const fid of factIds) {
          errors.push({
            id: `dup-reading-global-${fid}-${sig}`,
            category: 'naming',
            elementId: fid,
            elementKind: 'fact',
            message: `Predicate reading also used in another fact type: "${sig}"`,
            severity: 'error',
          })
        }
      }
    }
  }

  // ── Redundant Concepts ───────────────────────────────────────────────────────
  if (enabledCategories.has('redundantConcepts')) {
    // (1) Cycles in the subtype graph — any sub→super chain that returns to itself
    //     means the involved object types denote the same concept (mutually inclusive),
    //     so the cycle is redundant.
    if (subtypes?.length) {
      const adj = new Map()  // subId → [superId, ...]
      for (const st of subtypes) {
        if (!adj.has(st.subId)) adj.set(st.subId, [])
        adj.get(st.subId).push({ superId: st.superId, stId: st.id })
      }
      const WHITE = 0, GREY = 1, BLACK = 2
      const color = new Map()
      const onCycleSubtypeIds = new Set()
      const visit = (id, pathStack) => {
        color.set(id, GREY)
        for (const { superId, stId } of (adj.get(id) ?? [])) {
          const c = color.get(superId) ?? WHITE
          if (c === GREY) {
            // Cycle detected — collect all subtype edges on the back-path
            onCycleSubtypeIds.add(stId)
            for (let i = pathStack.length - 1; i >= 0; i--) {
              const frame = pathStack[i]
              onCycleSubtypeIds.add(frame.stId)
              if (frame.from === superId) break
            }
          } else if (c === WHITE) {
            pathStack.push({ from: id, stId })
            visit(superId, pathStack)
            pathStack.pop()
          }
        }
        color.set(id, BLACK)
      }
      for (const startId of adj.keys()) {
        if ((color.get(startId) ?? WHITE) === WHITE) visit(startId, [])
      }
      for (const stId of onCycleSubtypeIds) {
        errors.push({
          id: `subtype-cycle-${stId}`,
          category: 'redundantConcepts',
          elementId: stId,
          elementKind: 'subtype',
          message: 'Subtype edge participates in a cycle (mutually inclusive object types are redundant)',
          severity: 'warning',
        })
      }
    }

    // (2) Unary fact type with a mandatory role — the role is always played by every
    //     instance of its player, so the fact adds no information.
    for (const f of facts || []) {
      if (f._implicit) continue
      if (f.arity !== 1) continue
      const role = f.roles?.[0]
      if (!role?.mandatory) continue
      errors.push({
        id: `unary-mandatory-${f.id}`,
        category: 'redundantConcepts',
        elementId: f.id,
        elementKind: 'fact',
        message: 'Unary fact type with a mandatory role is redundant (true for every instance of the role player)',
        severity: 'warning',
      })
    }
  }

  // ── Subtype Hierarchy ────────────────────────────────────────────────────────
  if (enabledCategories.has('subtypeHierarchy')) {
    // Collect all entity types and nested entity types (objectified non-value facts).
    const allEntityIds = new Set([
      ...objectTypes.filter(o => o.kind === 'entity').map(o => o.id),
      ...facts.filter(f => f.objectified && f.objectifiedKind !== 'value' && !f._implicit).map(f => f.id),
    ])

    // Build direct supertype sets from subtype edges.
    const directSupers = new Map()
    for (const id of allEntityIds) directSupers.set(id, new Set())
    for (const st of subtypes) {
      if (directSupers.has(st.subId)) directSupers.get(st.subId).add(st.superId)
    }

    // Root type: a type reachable in BFS whose own supertype set is empty (or unknown).
    // Unknown types (not in directSupers, e.g. value types) are treated as leaves/roots
    // so that a dangling reference does not spuriously report 0 roots.
    const isRoot = (id) => {
      const s = directSupers.get(id)
      return s === undefined || s.size === 0
    }

    const nameById = new Map([
      ...objectTypes.map(o => [o.id, o.name || '(unnamed)']),
      ...facts.filter(f => f.objectified).map(f => [f.id, f.objectifiedName || '(unnamed)']),
    ])
    const kindOf = (id) => facts.some(f => f.id === id) ? 'fact' : 'entity'

    for (const id of allEntityIds) {
      // BFS over the reflexive transitive supertype closure.
      const visited = new Set()
      const queue = [id]
      while (queue.length > 0) {
        const curr = queue.shift()
        if (visited.has(curr)) continue
        visited.add(curr)
        for (const superId of (directSupers.get(curr) ?? [])) queue.push(superId)
      }

      const reachableRoots = [...visited].filter(isRoot)

      if (reachableRoots.length === 0) {
        errors.push({
          id: `no-root-type-${id}`,
          category: 'subtypeHierarchy',
          elementId: id,
          elementKind: kindOf(id),
          message: `${nameById.get(id) || '(unnamed)'} has no root type in its supertype chain (supertype cycle detected)`,
          severity: 'error',
        })
      } else if (reachableRoots.length > 1) {
        const rootNames = reachableRoots.map(rid => nameById.get(rid) || '(unnamed)').join(', ')
        errors.push({
          id: `multiple-root-types-${id}`,
          category: 'subtypeHierarchy',
          elementId: id,
          elementKind: kindOf(id),
          message: `${nameById.get(id) || '(unnamed)'} has ${reachableRoots.length} root types (${rootNames}); an entity type must belong to exactly one root type hierarchy`,
          severity: 'error',
        })
      }
    }
  }

  // ── Range Sequences ──────────────────────────────────────────────────────────
  if (enabledCategories.has('rangeSequences')) {
    // Map of OT id → OT, used to look up the datatype of a role's player.
    const otMap = Object.fromEntries(objectTypes.map(o => [o.id, o]))

    const kindFromAssignment = (a) => {
      const tk = datatypeAssignmentToKind(a)
      if (!tk) return { typeKind: null, typeName: null }
      return { typeKind: tk, typeName: a.datatypeId }
    }

    const intCtx = { typeKind: 'integer', typeName: 'integer' }

    // Object types: value range (typed from the OT's own datatypeAssignment)
    // and cardinality range (always integer).
    for (const ot of objectTypes) {
      const name = ot.name || '(unnamed)'
      if (ot.valueRange?.length) {
        const t = kindFromAssignment(ot.datatypeAssignment)
        validateRangeSequence(ot.valueRange,
          { elementId: ot.id, elementKind: 'objectType',
            label: `Value range on "${name}"`, idSuffix: `ot-vr-${ot.id}`,
            ...t }, errors)
      }
      if (ot.cardinalityRange?.length) {
        validateRangeSequence(ot.cardinalityRange,
          { elementId: ot.id, elementKind: 'objectType',
            label: `Cardinality range on "${name}"`, idSuffix: `ot-cr-${ot.id}`,
            ...intCtx }, errors)
      }
    }

    // Fact-level (nested fact's implicit value type) + role-level + internal frequency
    for (const f of facts) {
      if (f._implicit) continue
      if (f.valueRange?.length) {
        const t = kindFromAssignment(f.datatypeAssignment)
        validateRangeSequence(f.valueRange,
          { elementId: f.id, elementKind: 'fact',
            label: `Value range on nested fact type`, idSuffix: `f-vr-${f.id}`,
            ...t }, errors)
      }
      if (f.cardinalityRange?.length) {
        validateRangeSequence(f.cardinalityRange,
          { elementId: f.id, elementKind: 'fact',
            label: `Cardinality range on nested fact type`, idSuffix: `f-cr-${f.id}`,
            ...intCtx }, errors)
      }
      for (let ri = 0; ri < (f.roles?.length || 0); ri++) {
        const role = f.roles[ri]
        if (role.valueRange?.length) {
          const player = otMap[role.objectTypeId]
          const t = kindFromAssignment(player?.datatypeAssignment)
          validateRangeSequence(role.valueRange,
            { elementId: f.id, elementKind: 'fact',
              label: `Value range on role ${ri + 1}`, idSuffix: `f-r${ri}-vr-${f.id}`,
              ...t }, errors)
        }
        if (role.cardinalityRange?.length) {
          validateRangeSequence(role.cardinalityRange,
            { elementId: f.id, elementKind: 'fact',
              label: `Cardinality range on role ${ri + 1}`, idSuffix: `f-r${ri}-cr-${f.id}`,
              ...intCtx }, errors)
        }
      }
      for (const ifItem of (f.internalFrequency || [])) {
        if (ifItem.range?.length) {
          const rs = (ifItem.roles || []).map(r => r + 1).join(', ') || '?'
          validateRangeSequence(ifItem.range,
            { elementId: f.id, elementKind: 'fact',
              label: `Internal frequency on role(s) ${rs}`,
              idSuffix: `f-if-${f.id}-${ifItem.id}`,
              ...intCtx }, errors)
        }
      }
    }

    // External frequency constraints
    for (const c of constraints) {
      if (c.constraintType === 'frequency' && c.frequency?.length) {
        validateRangeSequence(c.frequency,
          { elementId: c.id, elementKind: 'constraint',
            label: `Frequency constraint`, idSuffix: `c-freq-${c.id}`,
            ...intCtx }, errors)
      }
    }
  }

  // ── Identification ──────────────────────────────────────────────────────────
  if (enabledCategories.has('identification')) {
    const { cycles, inCycle } = findIdentifierCycles(facts, objectTypes, subtypes, constraints)
    if (inCycle.size > 0) {
      const nameById = new Map([
        ...objectTypes.map(o => [o.id, o.name || '(unnamed)']),
        ...facts.filter(f => f.objectified).map(f => [f.id, f.objectifiedName || '(unnamed)']),
      ])
      const isNestedEntityId = (id) => {
        const f = facts.find(ff => ff.id === id)
        return !!(f && f.objectified && f.objectifiedKind !== 'value')
      }
      // Emit one error per entity in any cycle, with the cycle path in the message.
      const containingCycle = (id) => cycles.find(c => c.includes(id)) || []
      for (const id of inCycle) {
        const cycle = containingCycle(id)
        const path = [...cycle, cycle[0]].map(n => nameById.get(n) || '(unnamed)').join(' → ')
        errors.push({
          id: `identifier-cycle-${id}`,
          category: 'identification',
          elementId: id,
          elementKind: isNestedEntityId(id) ? 'fact' : 'entity',
          message: `${nameById.get(id) || '(unnamed)'} participates in an identifier cycle (${path}) — its preferred identifier transitively depends on itself`,
          severity: 'error',
        })
      }
    }

    // Multiple PI sources check — each entity type must have at most one PI source,
    // and at most one instance of each source type.
    const allIdentifiableEntities = [
      ...objectTypes.filter(o => o.kind === 'entity'),
      ...facts.filter(f => f.objectified && f.objectifiedKind !== 'value' && !f._implicit),
    ]
    for (const entity of allIdentifiableEntities) {
      const entityId   = entity.id
      const entityName = entity.name || entity.objectifiedName || '(unnamed)'
      const entityKind = entity.objectifiedName ? 'fact' : 'entity'

      // Case 1: inherited PI via the subtype chain
      const allInheritedPIs = findAllInheritedPIs(entity, facts, objectTypes, subtypes, constraints)
      const hasInheritedPI = allInheritedPIs.length > 0
      if (allInheritedPIs.length > 1) {
        const names = allInheritedPIs.map(p => p.supertype.name || p.supertype.objectifiedName || '(unnamed)').join(', ')
        errors.push({
          id: `ambiguous-inherited-pi-${entityId}`,
          category: 'identification',
          elementId: entityId,
          elementKind: entityKind,
          message: `${entityName} inherits a preferred identifier from multiple supertypes (${names}) — the PI is ambiguous`,
          severity: 'error',
        })
      }

      // Case 2: reference mode
      const refMode    = findRefMode(entity, facts, objectTypes)
      const hasRefMode = refMode !== null

      // Case 3: internal UC PIs — facts with a preferredUniqueness entry where
      // entity plays the uncovered role (the ref-mode fact is excluded to avoid
      // double-counting with case 2).
      const internalPIFactIds = new Set()
      for (const f of facts) {
        if (hasRefMode && f.id === refMode.factId) continue
        for (const pu of (f.preferredUniqueness || [])) {
          const covered = new Set(pu)
          if (f.roles.some((r, ri) => r?.objectTypeId === entityId && !covered.has(ri))) {
            internalPIFactIds.add(f.id)
            break
          }
        }
      }

      // Case 4: external uniqueness constraints declared as PI for this entity
      const externalPIConstraints = constraints.filter(c => {
        if (c.constraintType !== 'uniqueness' || !c.isPreferredIdentifier) return false
        if (c.targetObjectTypeId === entityId) return true
        if (!c.targetObjectTypeId) {
          const check = canBeExternalUniquenessPI(c, facts)
          return check.ok && check.entityOtId === entityId
        }
        return false
      })

      const activeSources = [
        hasInheritedPI           && 'inherited PI',
        hasRefMode               && 'reference mode',
        internalPIFactIds.size > 0 && 'internal uniqueness constraint',
        externalPIConstraints.length > 0 && 'external uniqueness constraint',
      ].filter(Boolean)

      if (activeSources.length > 1) {
        errors.push({
          id: `multiple-pi-sources-${entityId}`,
          category: 'identification',
          elementId: entityId,
          elementKind: entityKind,
          message: `${entityName} has multiple preferred identifier sources: ${activeSources.join(', ')}`,
          severity: 'error',
        })
      }
      if (internalPIFactIds.size > 1) {
        errors.push({
          id: `multiple-internal-pi-${entityId}`,
          category: 'identification',
          elementId: entityId,
          elementKind: entityKind,
          message: `${entityName} has ${internalPIFactIds.size} internal uniqueness constraints declared as preferred identifier (at most 1 allowed)`,
          severity: 'error',
        })
      }
      if (externalPIConstraints.length > 1) {
        errors.push({
          id: `multiple-external-pi-${entityId}`,
          category: 'identification',
          elementId: entityId,
          elementKind: entityKind,
          message: `${entityName} has ${externalPIConstraints.length} external uniqueness constraints declared as preferred identifier (at most 1 allowed)`,
          severity: 'error',
        })
      }

      // Missing PI check — only for non-nested entity types. Nested entity types
      // (objectified facts) are always implicitly identified by their role players.
      if (!entity.objectified) {
        const hasAnyPI = hasInheritedPI || hasRefMode || internalPIFactIds.size > 0 || externalPIConstraints.length > 0
        if (!hasAnyPI) {
          errors.push({
            id: `missing-pi-${entityId}`,
            category: 'identification',
            elementId: entityId,
            elementKind: entityKind,
            message: `${entityName} has no preferred identifier defined`,
            severity: 'warning',
          })
        }
      }
    }
  }

  return errors
}
