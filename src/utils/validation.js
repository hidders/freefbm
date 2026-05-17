// ORM2 schema validation rules, organised by category (matching NORMA's grouping).

export const VALIDATION_CATEGORIES = {
  factTypeDefinition: {
    label: 'Fact Type Definition',
    description: 'Missing role players, missing internal uniqueness constraints, duplicate predicate readings',
  },
  constraintStructure: {
    label: 'Constraint Structure',
    description: 'Role sequence arity mismatches, insufficient role sequences',
  },
  naming: {
    label: 'Naming',
    description: 'Duplicate object type names',
  },
}

export const DEFAULT_VALIDATION_CATEGORIES = Object.fromEntries(
  Object.keys(VALIDATION_CATEGORIES).map(k => [k, true])
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

export function runValidation({ objectTypes, facts, constraints }, enabledCategories) {
  const errors = []

  // ── Fact Type Definition ─────────────────────────────────────────────────────
  if (enabledCategories.has('factTypeDefinition')) {
    const otMap = Object.fromEntries(objectTypes.map(o => [o.id, o]))

    // Collect all (signature → [{factId, label}]) across the whole schema for cross-fact check
    const globalSigMap = {}  // sig → [{ factId, desc }]

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
      if (f.arity >= 2 && (!f.uniqueness || f.uniqueness.length === 0)) {
        errors.push({
          id: `fact-needs-uniqueness-${f.id}`,
          category: 'factTypeDefinition',
          elementId: f.id,
          elementKind: 'fact',
          message: 'Non-unary fact type has no internal uniqueness constraint',
          severity: 'warning',
        })
      }

      // DuplicateReadingSignatureError
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
            category: 'factTypeDefinition',
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
            category: 'factTypeDefinition',
            elementId: fid,
            elementKind: 'fact',
            message: `Predicate reading also used in another fact type: "${sig}"`,
            severity: 'error',
          })
        }
      }
    }
  }

  // ── Constraint Structure ─────────────────────────────────────────────────────
  if (enabledCategories.has('constraintStructure')) {
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

    }
  }

  // ── Naming ───────────────────────────────────────────────────────────────────
  if (enabledCategories.has('naming')) {
    // ObjectTypeDuplicateNameError
    const nameMap = {}
    for (const ot of objectTypes) {
      const name = ot.name?.trim()
      if (!name) continue
      if (!nameMap[name]) nameMap[name] = []
      nameMap[name].push(ot.id)
    }
    for (const [name, ids] of Object.entries(nameMap)) {
      if (ids.length > 1) {
        for (const id of ids) {
          errors.push({
            id: `dup-name-ot-${id}`,
            category: 'naming',
            elementId: id,
            elementKind: 'objectType',
            message: `Duplicate object type name: "${name}"`,
            severity: 'error',
          })
        }
      }
    }
  }

  return errors
}
