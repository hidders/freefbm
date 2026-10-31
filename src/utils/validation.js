// ORM2 schema validation rules, organised by category (matching NORMA's grouping).

import { findIdentifierCycles, canBeExternalUniquenessPI, findCompositePI, findRefMode, findInheritedPI, findAllInheritedPIs } from './refMode.js'
import { VALUE_KINDS, valueKindOf, parseLiteral } from './datatypeValues.js'
import { EXTERNAL_CONSTRAINT_TYPES } from '../constants.js'
import { derivationIssues } from '../logic/derivationRule.js'
import { factDerivationIssues, factLabel } from '../logic/factDerivation.js'
import { derivationGraph, derivationCycles } from '../logic/derivationDependencies.js'
import { makeContext } from '../logic/constraintFormulas.js'
import { isFormulaQuery, checkQuery, whyNoOuterJoin } from '../logic/query.js'
import { plainParts } from '../verbalisation/hyphenBinding.js'

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
  derivationRules: {
    label: 'Derivation Rules',
    description: 'Missing, ill-formed or circular derivation rules of derived and semi-derived subtypes and fact types',
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
// lets the same comparator handle every value kind.
const NEG_INF = Symbol('-∞')
const POS_INF = Symbol('+∞')

// Fallback for ranges whose datatype is unknown (e.g. a role played by an
// entity type): values are read as numbers, and non-numeric ones are not
// reported, since we can't tell whether they are wrong.
const UNTYPED = {
  order: 'total',
  parse(str) {
    const n = Number(str)
    return Number.isNaN(n) ? { invalid: true } : { value: n }
  },
  compare: (a, b) => (a < b ? -1 : a > b ? 1 : 0),
  equal: (a, b) => a === b,
}

// Three-way compare of parsed values (or the ±∞ sentinels) under `kind`.
// NaN means the two values are incomparable (partial orders) or the kind has
// no order at all.
function cmpVals(kind, a, b) {
  if (a === NEG_INF) return b === NEG_INF ? 0 : -1
  if (a === POS_INF) return b === POS_INF ? 0 : 1
  if (b === NEG_INF) return 1
  if (b === POS_INF) return -1
  return kind.compare(a, b)
}

// Parse a range spec into an interval { lo, hi, parseable, emptyFields,
// invalidFields }, where lo/hi may be NEG_INF / POS_INF for unbounded sides.
// `parseable` is true only when every required bound parsed cleanly.
function specInterval(spec, kind) {
  const fields = spec.type === 'single' ? ['value']
    : spec.type === 'lower' ? ['lower']
    : spec.type === 'upper' ? ['upper']
    : spec.type === 'range' ? ['lower', 'upper']
    : null
  if (!fields) return { lo: null, hi: null, parseable: false, emptyFields: [], invalidFields: [] }
  const parsed = Object.fromEntries(fields.map(f => [f, parseLiteral(spec[f], kind)]))
  const val = (f) => parsed[f].value
  const lo = spec.type === 'single' ? val('value') : spec.type === 'upper' ? NEG_INF : val('lower')
  const hi = spec.type === 'single' ? val('value') : spec.type === 'lower' ? POS_INF : val('upper')
  return {
    lo, hi,
    // Open (exclusive) bounds; an infinite side is never open.
    loOpen: spec.type !== 'single' && spec.type !== 'upper' && !!spec.lowerOpen,
    hiOpen: spec.type !== 'single' && spec.type !== 'lower' && !!spec.upperOpen,
    parseable: fields.every(f => 'value' in parsed[f]),
    emptyFields:   fields.filter(f => parsed[f].empty),
    invalidFields: fields.filter(f => parsed[f].invalid),
  }
}

// Push all Range Sequences errors for one (range, context) pair into `errors`.
// ctx = { elementId, elementKind, label, idSuffix, kind, typeName }
//   kind:     a VALUE_KINDS entry (see datatypeValues.js), or null if unknown
//   typeName: human label for type-mismatch messages (e.g. "xs:duration")
// All comparisons are on values, not on the strings that represent them.
function validateRangeSequence(range, ctx, errors) {
  const specs = range || []
  if (specs.length === 0) return
  const kind = ctx.kind || UNTYPED
  const cmp = (a, b) => cmpVals(kind, a, b)
  const ivs = specs.map(s => specInterval(s, kind))
  const tn = ctx.typeName || 'the datatype'
  const push = (id, message, severity) => errors.push({
    id: `${id}-${ctx.idSuffix}`, category: 'rangeSequences',
    elementId: ctx.elementId, elementKind: ctx.elementKind, message, severity,
  })

  // (1) Empty bounds
  for (let i = 0; i < ivs.length; i++) {
    if (ivs[i].emptyFields.length > 0) {
      push(`range-empty-${i}`, `${ctx.label}: spec ${i + 1} has empty ${ivs[i].emptyFields.join(' and ')} field`, 'error')
    }
  }

  // (2) Type mismatch — value present but doesn't denote a value of the
  // declared datatype. Only when we know the type; otherwise parsing falls
  // back to numeric and any non-numeric string would falsely flag.
  if (ctx.kind) {
    for (let i = 0; i < ivs.length; i++) {
      if (ivs[i].invalidFields.length > 0) {
        const ex = ctx.kind.expect ? ` (expected ${ctx.kind.expect})` : ''
        const what = specs[i].type === 'single' ? 'a value' : `${ivs[i].invalidFields.join(' and ')} bound`
        push(`range-typemismatch-${i}`, `${ctx.label}: spec ${i + 1} has ${what} that is not a valid ${tn}${ex}`, 'error')
      }
    }
  }

  // (3) Unordered datatype — only single values make sense.
  if (kind.order === 'none') {
    for (let i = 0; i < specs.length; i++) {
      if (specs[i].type !== 'single') {
        push(`range-unordered-${i}`, `${ctx.label}: spec ${i + 1} is an interval, but ${tn} has no ordering, so only single values are allowed`, 'error')
      }
    }
  }

  // (4) Lower > upper inside a {type: 'range'} spec. For a partial order the
  // bounds may also be incomparable, which makes the interval suspect.
  if (kind.order !== 'none') {
    for (let i = 0; i < ivs.length; i++) {
      if (specs[i].type !== 'range' || !ivs[i].parseable) continue
      const c = cmp(ivs[i].lo, ivs[i].hi)
      if (c > 0) {
        push(`range-lo-gt-hi-${i}`, `${ctx.label}: spec ${i + 1} has lower bound greater than upper bound`, 'error')
      } else if (c === 0 && (ivs[i].loOpen || ivs[i].hiOpen)) {
        push(`range-empty-interval-${i}`, `${ctx.label}: spec ${i + 1} has equal bounds and an open bound, so it contains no value`, 'error')
      } else if (Number.isNaN(c)) {
        push(`range-incomparable-${i}`, `${ctx.label}: spec ${i + 1} has bounds that cannot be compared in ${tn}`, 'warning')
      }
    }
  }

  // Sequence-level checks below only run if every spec parsed cleanly.
  if (!ivs.every(iv => iv.parseable)) return

  // (5) Duplicates and overlaps. Two single values are duplicates when they
  // are the same value (e.g. 'en-GB' and 'en-gb'). Intervals overlap iff
  // max(A.lo, B.lo) <= min(A.hi, B.hi). In a partial order that test needs
  // the bounds to be comparable; when they aren't, we only report a single
  // value that definitely lies inside the other interval.
  const inside = (v, iv) => (iv.loOpen ? cmp(iv.lo, v) < 0 : cmp(iv.lo, v) <= 0) &&
    (iv.hiOpen ? cmp(v, iv.hi) < 0 : cmp(v, iv.hi) <= 0)
  for (let i = 0; i < ivs.length; i++) {
    for (let j = i + 1; j < ivs.length; j++) {
      const A = ivs[i], B = ivs[j]
      const singleA = specs[i].type === 'single', singleB = specs[j].type === 'single'
      if (singleA && singleB) {
        if (kind.equal(A.lo, B.lo)) {
          push(`range-duplicate-${i}-${j}`, `${ctx.label}: spec ${i + 1} and spec ${j + 1} are the same value`, 'warning')
        }
        continue
      }
      const cLo = cmp(A.lo, B.lo), cHi = cmp(A.hi, B.hi)
      // The intersection runs from the larger lower bound to the smaller
      // upper one; a bound shared by both sides is open if either is.
      const lo = cLo > 0 ? A : cLo < 0 ? B : { lo: A.lo, loOpen: A.loOpen || B.loOpen }
      const hi = cHi < 0 ? A : cHi > 0 ? B : { hi: A.hi, hiOpen: A.hiOpen || B.hiOpen }
      const meet = cmp(lo.lo, hi.hi)
      const overlap = !Number.isNaN(cLo) && !Number.isNaN(cHi)
        ? meet < 0 || (meet === 0 && !lo.loOpen && !hi.hiOpen)
        : (singleA && inside(A.lo, B)) || (singleB && inside(B.lo, A))
      if (overlap) {
        push(`range-overlap-${i}-${j}`, `${ctx.label}: spec ${i + 1} and spec ${j + 1} overlap`, 'warning')
      }
    }
  }

  // (6) Adjacent/mergeable — only meaningful when there's a discrete successor,
  // i.e. for integer ranges (cardinality, frequency, and integer value ranges).
  if (kind === VALUE_KINDS.integer) {
    for (let i = 0; i < ivs.length; i++) {
      for (let j = i + 1; j < ivs.length; j++) {
        const A = ivs[i], B = ivs[j]
        const maxLo = cmp(A.lo, B.lo) >= 0 ? A.lo : B.lo
        const minHi = cmp(A.hi, B.hi) <= 0 ? A.hi : B.hi
        // Already overlap → mergeable warning would be redundant
        if (cmp(maxLo, minHi) <= 0) continue
        // Both endpoints must be finite to talk about a "+1 gap"
        if (typeof minHi !== 'number' || typeof maxLo !== 'number') continue
        if (minHi + 1 === maxLo) {
          push(`range-mergeable-${i}-${j}`, `${ctx.label}: spec ${i + 1} and spec ${j + 1} are adjacent and could be merged`, 'warning')
        }
      }
    }
  }

  // (7) Out of ascending order — adjacent pairs in the user's original
  // sequence; for a partial order only pairs that are comparable. Not for
  // strings: a string value range is usually an enumeration, which should be
  // writable in its natural order (e.g. 'summer', 'autumn', 'winter', 'spring').
  if (kind.order === 'none' || kind === VALUE_KINDS.string) return
  for (let i = 1; i < ivs.length; i++) {
    if (cmp(ivs[i].lo, ivs[i - 1].lo) < 0) {
      push(`range-out-of-order-${i}`, `${ctx.label}: spec ${i + 1} starts before spec ${i} (sequence is not in ascending order)`, 'warning')
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

export function runValidation(state, enabledCategories) {
  const { objectTypes, facts, constraints, subtypes = [] } = state
  // The composite preferred identifiers of the entity types, worked out once
  // rather than per fact type.
  let compositePIs = null
  const entityCompositePIs = () => compositePIs ??= objectTypes
    .filter(ot => ot.kind === 'entity')
    .map(ot => findCompositePI(ot, facts, objectTypes, constraints))
    .filter(Boolean)
  const errors = []
  let ctx = null   // made when a check needs it (constraintFormulas.js makeContext)

  // ── Derivation Rules ─────────────────────────────────────────────────────────
  if (enabledCategories.has('derivationRules')) {
    const dctx = makeContext(state)
    derivationIssues(state, dctx).forEach((i, n) => errors.push({
      id: `derivation-${i.ot.id}-${n}`,
      category: 'derivationRules',
      elementId: i.ot.id,
      elementKind: i.ot.kind,
      message: `Derivation rule: ${i.message}`,
      severity: i.severity,
    }))
    factDerivationIssues(state, dctx).forEach((i, n) => errors.push({
      id: `derivation-${i.fact.id}-${n}`,
      category: 'derivationRules',
      elementId: i.fact.id,
      elementKind: 'fact',
      message: `Derivation rule: ${i.message}`,
      severity: i.severity,
    }))
    // The rules must not depend on each other in a cycle.
    const nodes = derivationGraph(state, dctx)
    const label = (key) => {
      const nd = nodes.get(key)
      return nd.kind === 'type' ? nd.name : `"${factLabel(dctx.factById.get(nd.id), dctx)}"`
    }
    derivationCycles(nodes).forEach((cycle, n) => {
      const path = cycle.map(label).join(' → ')
      for (const key of new Set(cycle)) {
        const nd = nodes.get(key)
        errors.push({
          id: `derivation-cycle-${n}-${nd.id}`,
          category: 'derivationRules',
          elementId: nd.id,
          elementKind: nd.kind === 'fact' ? 'fact' : dctx.otById.get(nd.id)?.kind,
          message: cycle.length === 2
            ? `Derivation rule: ${label(key)} is derived from itself`
            : `Derivation rule: the rules depend on each other in a cycle (${path})`,
          severity: 'error',
        })
      }
    })
  }

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
        const hasImpliedUC = entityCompositePIs().some(cp => cp.factIds?.includes(f.id))
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
      const ucs = (f.uniqueness || []).map(u => u.roles)
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
      for (const cp of entityCompositePIs()) {
        if (!cp.factIds?.includes(f.id)) continue
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
        // A query stored as a formula must pass the query checks (query.js).
        for (let i = 0; i < sequences.length; i++) {
          if (!isFormulaQuery(queries[i])) continue
          ctx ??= makeContext(state)
          const bad = checkQuery(queries[i], sequences[i] ?? [], state, ctx).find(x => x.severity === 'error')
          if (bad) errors.push({
            id: `invalid-query-${c.id}-${i}`, category: 'constraintStructure', elementId: c.id, elementKind: 'constraint',
            message: `${label} constraint: the query formula of sequence ${i + 1} is not valid: ${bad.message}`,
            severity: 'error',
          })
        }
      }

      // An outer-join external uniqueness needs a conjunctive query with at
      // least one part on a role that is mandatory for the target.
      if (c.outerJoin) {
        ctx ??= makeContext(state)
        const why = whyNoOuterJoin(c, ctx)
        if (why) errors.push({
          id: `outer-join-${c.id}`, category: 'constraintStructure', elementId: c.id, elementKind: 'constraint',
          message: `${label} constraint: it can't be read with outer joins: ${why}`,
          severity: 'error',
        })
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
        // Binding hyphens only guide verbalisation: "has first- Name" and
        // "has first Name" are the same reading.
        const sig = readingSignature(plainParts(r.parts, r.roleOrder.length), r.roleOrder, f.roles, otMap)
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
      const kind = valueKindOf(a)
      if (!kind) return { kind: null, typeName: null }
      return { kind, typeName: a.datatypeId }
    }

    const intCtx = { kind: VALUE_KINDS.integer, typeName: 'integer' }

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
