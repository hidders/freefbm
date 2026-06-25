// Validation of sample populations (distinct from schema validation in validation.js).
// Population issues are warnings — the schema is well-formed, but the sample data
// is inconsistent with it.

import { validateValueAgainstDatatype } from './datatypeValidation.js'
import { datatypeAssignmentToKind } from './datatypeMapping.js'
import { isIdentifyingFact, getVtEffectivePopulation, getEntityEffectivePopulation, getEntityIdentifierShape, findRefMode, findCompositePI, findInheritedPI, findRolePlayer, getNestedCellShape, isCompleteValue, UNSET } from './refMode.js'

// Walk `cell` against the nested `shape` (from getNestedCellShape), trimming
// string leaves and returning either:
//   { complete: true,  value }  — fully populated value (string or nested array)
//   { complete: false }         — at least one leaf is empty (or shape mismatch)
function normalizeCellByShape(cell, shape) {
  if (shape.kind === 'single') {
    const v = typeof cell === 'string' ? cell.trim() : ''
    return v === '' ? { complete: false } : { complete: true, value: v }
  }
  const arr = Array.isArray(cell) ? cell : []
  const out = []
  for (let i = 0; i < shape.columns.length; i++) {
    const res = normalizeCellByShape(arr[i], shape.columns[i])
    if (!res.complete) return { complete: false }
    out.push(res.value)
  }
  return { complete: true, value: out }
}

// Effective leaf datatype for a player. VT → its own datatypeAssignment.
// Entity → walks the (single-column) ref-mode chain through getEntityIdentifierShape
// to find the leaf VT. Multi-column or no-PI entities yield null. Cycle-safe.
function effectiveLeafAssignment(playerOtId, facts, objectTypes, subtypes, visited) {
  if (!playerOtId) return null
  const v = visited ?? new Set()
  if (v.has(playerOtId)) return null
  v.add(playerOtId)
  const playerOt = objectTypes.find(o => o.id === playerOtId)
  if (!playerOt) return null
  if (playerOt.kind === 'value') return playerOt.datatypeAssignment ?? null
  if (playerOt.kind !== 'entity') return null
  const shape = getEntityIdentifierShape(playerOt, facts, objectTypes, subtypes)
  if (!shape || shape.columns.length !== 1) return null
  return effectiveLeafAssignment(shape.columns[0].playerOtId, facts, objectTypes, subtypes, v)
}

// Walk a (possibly nested) cell value against its nested shape, returning one
// entry per leaf whose value fails its leaf player's datatype.
//   { value, assignment, pathLabel, err }
// pathLabel is the breadcrumb of column labels from the call site down to the
// failing leaf (e.g. "Building → BuildingCode"), or '' if the leaf is at the
// top of this walk.
function collectLeafTypeErrors(value, shape, facts, objectTypes, subtypes, pathLabel) {
  const out = []
  if (shape.kind === 'single') {
    if (typeof value !== 'string' || value === '') return out
    const assignment = effectiveLeafAssignment(shape.playerOtId, facts, objectTypes, subtypes)
    if (!datatypeAssignmentToKind(assignment)) return out
    const err = validateValueAgainstDatatype(value, assignment)
    if (!err) return out
    out.push({ value, assignment, pathLabel: pathLabel || '', err })
    return out
  }
  if (!Array.isArray(value)) return out
  for (let i = 0; i < shape.columns.length; i++) {
    const sub = shape.columns[i]
    const subLabel = sub.label || `col ${i + 1}`
    const nextLabel = pathLabel ? `${pathLabel} → ${subLabel}` : subLabel
    out.push(...collectLeafTypeErrors(value[i], sub, facts, objectTypes, subtypes, nextLabel))
  }
  return out
}

// Frequency range matching — a range is an array of segments (single/lower/upper/range)
// OR'd together. An empty range or unspecified bounds are treated as "no constraint".
function freqSpecSatisfies(count, spec) {
  if (!spec) return false
  const num = (x) => {
    if (x === '' || x === null || x === undefined) return null
    const n = Number(x)
    return Number.isFinite(n) ? n : null
  }
  if (spec.type === 'single') {
    const v = num(spec.value)
    return v == null ? true : count === v
  }
  if (spec.type === 'lower') {
    const v = num(spec.lower)
    return v == null ? true : count >= v
  }
  if (spec.type === 'upper') {
    const v = num(spec.upper)
    return v == null ? true : count <= v
  }
  if (spec.type === 'range') {
    const lo = num(spec.lower)
    const hi = num(spec.upper)
    if (lo == null && hi == null) return true
    if (lo == null) return count <= hi
    if (hi == null) return count >= lo
    return count >= lo && count <= hi
  }
  return true
}

export function freqRangeSatisfies(count, range) {
  if (!range || range.length === 0) return true
  return range.some(spec => freqSpecSatisfies(count, spec))
}

function formatFreqRangeShort(range) {
  if (!range?.length) return ''
  const parts = range.map(spec => {
    if (spec.type === 'single') return spec.value ?? ''
    if (spec.type === 'lower')  return `${spec.lower ?? ''}..`
    if (spec.type === 'upper')  return `..${spec.upper ?? ''}`
    if (spec.type === 'range')  return `${spec.lower ?? ''}..${spec.upper ?? ''}`
    return ''
  }).filter(Boolean)
  return parts.join(', ')
}

// Compute population issues from the current store snapshot.
// Returns an array of { kind, elementId, ...payload, message }.
// The elementId is the diagram element to badge — fact id for danglingReference,
// object-type id for typeMismatch.
//
// Currently detected:
//   - emptyTupleCell:        a fact-tuple cell is empty (every role of a tuple must
//                            be populated).
//   - danglingReference:     a fact-tuple cell holds a non-empty value that does not
//                            appear in the role player's population (or the parent
//                            entity, when the player is an implicit ref-mode VT).
//   - typeMismatch:          an instance value in a value-type / entity population
//                            does not parse against the assigned datatype (abstract
//                            profile only).
//   - uniquenessViolation:   multiple fact-tuples share the same projection on a
//                            uniqueness role-set (declared via fact.uniqueness or
//                            fact.preferredUniqueness).
//   - mandatoryRoleNotPlayed: a player instance must appear at every mandatory role
//                            in at least one tuple, but does not.
//   - frequencyViolation:    an internal frequency constraint requires each projection
//                            value-combination to appear N times within a declared
//                            range, but a group violates that count.
//   - exclusionViolation:    a value appears in the projected populations of two or
//                            more sequences of an exclusion constraint.
//   - equalityViolation:     a value appears in one sequence's projection but not
//                            another's, violating an equality constraint.
//   - subsetViolation:       a value appears in the first sequence's projection but
//                            not the second's, violating a subset constraint.
//   - ringViolation:         the population of a binary fact type violates one of
//                            the relational properties declared by a ring constraint
//                            (irreflexive, reflexive, purely-reflexive, asymmetric,
//                            symmetric, antisymmetric, transitive, intransitive,
//                            strongly-intransitive, acyclic).
//   - nonIndependentNotPlaying: an instance of a non-independent (nested) entity type
//                            does not appear as a role player in any fact type.
//   - duplicateIdentifier:   two distinct entries in the same entity type's population
//                            are shown to identify the same real-world entity via the
//                            equivalence relation induced by subtype edges.
//   - inclusiveOrViolation:  an instance of the target type does not appear in any of
//                            the projected populations of an inclusive-or constraint's
//                            role sequences.
//   - exclusiveOrViolation:      an instance appears in zero or more-than-one of the
//                                projected populations of an exclusive-or constraint's
//                                role sequences (must appear in exactly one).
//   - valueComparisonViolation:  for a fact tuple, the value at role-sequence 1 does not
//                                satisfy the declared operator relative to the value at
//                                role-sequence 2 (same-fact single-role pairs only).

// Returns true if v1 <op> v2 holds. Both strings; numeric comparison used when both parse.
function cmpValues(v1, v2, op) {
  if (v1 === '' || v2 === '') return true
  const n1 = Number(v1), n2 = Number(v2)
  const a = (!isNaN(n1) && !isNaN(n2)) ? n1 : v1
  const b = (!isNaN(n1) && !isNaN(n2)) ? n2 : v2
  switch (op) {
    case '=':  return a === b
    case '≠':  return a !== b
    case '<':  return a < b
    case '≤':  return a <= b
    case '>':  return a > b
    case '≥':  return a >= b
    default:   return true
  }
}

export function computePopulationIssues({ facts, factPopulations, objectTypes, populations, subtypes, subtypeMappings, nestedEntityMappings, constraints }) {
  const otById = new Map((objectTypes || []).map(o => [o.id, o]))
  const issues = []

  // Per-role-player effective population lookup (memoised).
  // - Entity: stored populations[entityId] unioned with subtype populations.
  // - Value type: union of populations[vtId] plus every entity instance (with
  //   subtypes) from every entity using this VT as ref mode.
  // - Objectified fact (nested entity type): its tuples from factPopulations.
  const popCache = new Map()
  const playerPopulation = (player) => {
    if (!player) return []
    if (popCache.has(player.id)) return popCache.get(player.id)
    let pop
    if (player.objectified) {
      // For nested entities with an explicit PI, the role value in a connecting
      // fact is the PI of the nested entity — check against nestedEntityMappings.
      const rm  = findRefMode(player, facts || [], objectTypes || [])
      const cp  = !rm && findCompositePI(player, facts || [], objectTypes || [], constraints)
      const inh = !rm && !cp && findInheritedPI(player, facts || [], objectTypes || [], subtypes || [], constraints)
      if (rm || cp || inh) {
        pop = nestedEntityMappings?.[player.id] ?? []
      } else {
        pop = factPopulations?.[player.id] ?? []
      }
    } else if (player.kind === 'entity') {
      pop = getEntityEffectivePopulation(player.id, populations || {}, facts || [], objectTypes || [], subtypes || [], subtypeMappings || {})
    } else if (player.kind === 'value') {
      pop = getVtEffectivePopulation(player.id, populations || {}, facts || [], objectTypes || [], subtypes || [], subtypeMappings || {})
    } else {
      pop = []
    }
    popCache.set(player.id, pop)
    return pop
  }

  // Identifying facts (ref-mode binary or composite-PI) are tautological —
  // their tuples are derived from the entity population — so skip them in
  // every iteration below (except section 3 which uses effectiveFactTuples).
  // Objectified facts are NOT skipped: their tuples are their own population
  // and must be validated like any fact-tuple set.
  // Also skip facts that are the identifying fact for a nested entity type.
  const isSkippableFact = (fact) => {
    if (isIdentifyingFact(fact, facts || [], objectTypes || [], constraints)) return true
    for (const nf of (facts || [])) {
      if (!nf.objectified || nf.objectifiedKind === 'value' || nf.id === fact.id) continue
      const rm = findRefMode(nf, facts || [], objectTypes || [])
      if (rm && rm.factId === fact.id) return true
      const cp = findCompositePI(nf, facts || [], objectTypes || [], constraints)
      if (cp && (cp.factId === fact.id || cp.factIds?.includes(fact.id))) return true
    }
    return false
  }

  // (projCellKey and projCellDisplay are now module-level functions)

  // True when `fact` is the identifying fact (ref-mode or composite-PI) for
  // a nested entity type (objectified fact). Such facts' mandatory-role checks
  // are tautological and should be skipped in section 3.
  const isNestedEntityIdentifyingFact = (fact) => {
    for (const nf of (facts ?? [])) {
      if (!nf.objectified || nf.objectifiedKind === 'value' || nf.id === fact.id) continue
      const rm = findRefMode(nf, facts || [], objectTypes || [])
      if (rm && rm.factId === fact.id) return true
      const cp = findCompositePI(nf, facts || [], objectTypes || [], constraints)
      if (cp && (cp.factId === fact.id || cp.factIds?.includes(fact.id))) return true
    }
    return false
  }

  // Wrapper for module-level computeEffectiveFactTuples with local state.
  const effectiveFactTuples = (fact) =>
    computeEffectiveFactTuples(fact, facts || [], factPopulations || {}, objectTypes || [], populations || {}, nestedEntityMappings || {}, constraints)

  // ── 1. Dangling references in fact-tuple cells ──────────────────────────
  // For each fact-tuple cell, validate against its role player's nested shape:
  //   - emptyTupleCell:    any leaf in the cell is empty
  //   - danglingReference: the full (possibly nested) cell value is not in
  //                        the player's population
  // Nested composite-PI players are walked recursively via getNestedCellShape
  // so sub-tuples are compared by JSON encoding at any depth.
  if (facts?.length && factPopulations) {
    for (const fact of facts) {
      if (isSkippableFact(fact)) continue
      const tuples = factPopulations[fact.id]
      if (!tuples?.length) continue
      tuples.forEach((tuple, ti) => {
        if (!Array.isArray(tuple)) return
        tuple.forEach((cell, ri) => {
          const role = fact.roles?.[ri]
          const player = role?.objectTypeId
            ? findRolePlayer(role.objectTypeId, objectTypes || [], facts || [])
            : null
          const shape = getNestedCellShape(player, facts || [], objectTypes || [], subtypes || [], constraints)
          const norm = normalizeCellByShape(cell, shape)
          if (!norm.complete) {
            issues.push({
              kind: 'emptyTupleCell',
              elementId: fact.id,
              factId: fact.id, tupleIndex: ti, roleIndex: ri,
              message: shape.kind === 'tuple'
                ? `tuple ${ti + 1}, role ${ri + 1} is incomplete`
                : `tuple ${ti + 1}, role ${ri + 1} is empty`,
            })
            return
          }
          if (!player) return
          const playerPop = playerPopulation(player)
          const cellKey = JSON.stringify(norm.value)
          const exists = playerPop.some(v => JSON.stringify(v) === cellKey)
          if (!exists) {
            const playerLabel = player.name || player.objectifiedName || 'the role player'
            issues.push({
              kind: 'danglingReference',
              elementId: fact.id,
              factId: fact.id, tupleIndex: ti, roleIndex: ri,
              value: norm.value, playerId: player.id,
              message: `${projCellDisplay(norm.value)} is not in the population of ${playerLabel}`,
            })
          }
        })
      })
    }
  }

  // ── 2. Uniqueness violations in fact populations ────────────────────────
  if (facts?.length && factPopulations) {
    for (const fact of facts) {
      if (isSkippableFact(fact)) continue
      const tuples = factPopulations[fact.id]
      if (!tuples?.length || tuples.length < 2) continue
      // Union uniqueness + preferredUniqueness, deduplicated by sorted role-set.
      // A preferred uniqueness also implies a uniqueness on each role it does NOT
      // cover (the identifying scheme is 1:1), so we add those as singleton UCs.
      const ucMap = new Map()
      const addUC = (rs) => {
        if (!Array.isArray(rs) || rs.length === 0) return
        const sorted = [...rs].sort((a, b) => a - b)
        const k = sorted.join(',')
        if (!ucMap.has(k)) ucMap.set(k, sorted)
      }
      const arity0 = fact.arity ?? fact.roles?.length ?? 0
      ;(fact.uniqueness          || []).forEach(addUC)
      ;(fact.preferredUniqueness || []).forEach(addUC)
      for (const pu of (fact.preferredUniqueness || [])) {
        if (!Array.isArray(pu)) continue
        const puSet = new Set(pu)
        for (let ri = 0; ri < arity0; ri++) {
          if (!puSet.has(ri)) addUC([ri])  // implied uniqueness on each uncovered role
        }
      }
      if (ucMap.size === 0) continue

      for (const roleSet of ucMap.values()) {
        // Group tuples by their projection on roleSet; skip tuples with any
        // empty cell in that projection (those are already flagged separately).
        const groups = new Map()
        tuples.forEach((tuple, ti) => {
          if (!Array.isArray(tuple)) return
          const proj = roleSet.map(r => projCellKey(tuple[r]))
          if (proj.some(v => v === null)) return
          const key = JSON.stringify(proj)
          let g = groups.get(key)
          if (!g) {
            g = { proj, tupleIndices: [] }
            groups.set(key, g)
          }
          g.tupleIndices.push(ti)
        })
        for (const g of groups.values()) {
          if (g.tupleIndices.length < 2) continue
          const roleLabel = roleSet.map(r => {
            const role = fact.roles?.[r]
            return role?.roleName?.trim() || `role ${r + 1}`
          }).join(', ')
          const valueLabel = g.proj.map(projCellDisplay).join(', ')
          const tupleLabel = g.tupleIndices.map(i => i + 1).join(', ')
          issues.push({
            kind: 'uniquenessViolation',
            elementId: fact.id,
            factId: fact.id,
            roleIndices: [...roleSet],
            tupleIndices: [...g.tupleIndices],
            values: [...g.proj],
            message: `uniqueness over ${roleLabel} violated by tuples ${tupleLabel} (${valueLabel})`,
          })
        }
      }
    }
  }

  // ── 2b. Internal frequency violations ──────────────────────────────────
  if (facts?.length && factPopulations) {
    for (const fact of facts) {
      if (isSkippableFact(fact)) continue
      const tuples = factPopulations[fact.id]
      if (!tuples?.length) continue
      const fItems = fact.internalFrequency || []
      if (fItems.length === 0) continue
      for (const ifItem of fItems) {
        const roleSet = Array.isArray(ifItem?.roles) ? ifItem.roles : []
        if (roleSet.length === 0) continue
        if (!ifItem?.range?.length) continue
        const sortedRoles = [...roleSet].sort((a, b) => a - b)
        const groups = new Map()
        tuples.forEach((tuple, ti) => {
          if (!Array.isArray(tuple)) return
          const proj = sortedRoles.map(r => projCellKey(tuple[r]))
          if (proj.some(v => v === null)) return
          const key = JSON.stringify(proj)
          let g = groups.get(key)
          if (!g) {
            g = { proj, tupleIndices: [] }
            groups.set(key, g)
          }
          g.tupleIndices.push(ti)
        })
        for (const g of groups.values()) {
          if (freqRangeSatisfies(g.tupleIndices.length, ifItem.range)) continue
          const roleLabel = sortedRoles.map(r => {
            const role = fact.roles?.[r]
            return role?.roleName?.trim() || `role ${r + 1}`
          }).join(', ')
          const valueLabel = g.proj.map(projCellDisplay).join(', ')
          const tupleLabel = g.tupleIndices.map(i => i + 1).join(', ')
          const rangeText  = formatFreqRangeShort(ifItem.range)
          issues.push({
            kind: 'frequencyViolation',
            elementId: fact.id,
            factId: fact.id,
            internalFrequencyId: ifItem.id,
            roleIndices: sortedRoles,
            tupleIndices: [...g.tupleIndices],
            values: [...g.proj],
            count: g.tupleIndices.length,
            message: `frequency ${rangeText} over ${roleLabel} violated by (${valueLabel}): appears ${g.tupleIndices.length} time${g.tupleIndices.length === 1 ? '' : 's'} (in tuples ${tupleLabel})`,
          })
        }
      }
    }
  }

  // ── 3. Mandatory roles: every player instance must appear at the role ──
  // A role is mandatory if explicitly marked (role.mandatory), or implicitly because
  // a preferred-uniqueness role-set on the same fact does not cover it — every
  // instance of the player must still appear so the identifying scheme is total.
  // Unlike other sections, identifying facts are NOT skipped here — their
  // effective tuples are derived from the entity population so mandatory-role
  // checks apply to both direct and identifying facts.
  if (facts?.length) {
    const factName = (f) => (f.readingParts || []).filter(Boolean).join(' ').trim() || 'this fact type'
    for (const fact of facts) {
      // Nested-entity identifying facts are tautologically satisfied:
      // every NE instance by construction appears in its PI, so no errors can fire.
      if (isNestedEntityIdentifyingFact(fact)) continue
      // Don't skip facts with no tuples here: a mandatory role with no tuples
      // means every player instance is unplayed (every instance gets flagged).
      const tuples = effectiveFactTuples(fact) || []
      const arity  = fact.arity ?? fact.roles?.length ?? 0
      if (arity < 1) continue
      // Roles implicitly mandatory because a preferred uniqueness covers everything else
      const implicitMandatory = new Set()
      for (const pu of (fact.preferredUniqueness || [])) {
        if (!Array.isArray(pu)) continue
        const puSet = new Set(pu)
        for (let ri = 0; ri < arity; ri++) {
          if (!puSet.has(ri)) implicitMandatory.add(ri)
        }
      }
      for (let ri = 0; ri < arity; ri++) {
        const role = fact.roles?.[ri]
        const isMandatory = role?.mandatory || implicitMandatory.has(ri)
        if (!isMandatory || !role?.objectTypeId) continue
        const player = findRolePlayer(role.objectTypeId, objectTypes || [], facts || [])
        if (!player) continue
        const instances = playerPopulation(player)
        if (!instances?.length) continue
        // Collect every non-empty value that appears at this role across all tuples.
        // For composite-PI players the cell is a sub-tuple; we key on JSON.
        const playedKeys = new Set()
        for (const tuple of tuples) {
          if (!Array.isArray(tuple)) continue
          const key = projCellKey(tuple[ri])
          if (key !== null) playedKeys.add(JSON.stringify(key))
        }
        instances.forEach((rawV, idx) => {
          const norm = projCellKey(rawV)
          if (norm === null) return  // empty instance — separately problematic
          if (playedKeys.has(JSON.stringify(norm))) return
          const rLabel = role.roleName?.trim() || `role ${ri + 1}`
          const display = projCellDisplay(norm)
          issues.push({
            kind: 'mandatoryRoleNotPlayed',
            elementId: player.id,
            otId: player.id,
            instanceIndex: idx,
            value: rawV,
            factId: fact.id,
            roleIndex: ri,
            message: `${display} does not play the mandatory ${rLabel} in ${factName(fact)}`,
          })
        })
      }
    }
  }

  // ── 4. Type mismatches against datatypeAssignment ───────────────────────
  // VTs: check each stored value against the VT's own datatype.
  // Ref-mode entities: each stored value is a value of the ref-mode VT, so it
  //   must match that VT's datatype.
  // Composite-PI entities: each tuple cell maps to one identifying role; that
  //   cell's value must match the player VT's datatype.
  if (objectTypes?.length && populations) {
    for (const ot of objectTypes) {
      const instances = populations[ot.id]
      if (!instances?.length) continue

      // Plain VT (or entity with its own datatypeAssignment): single-column check.
      if (ot.kind === 'value') {
        const assignment = ot.datatypeAssignment
        if (!datatypeAssignmentToKind(assignment)) continue
        instances.forEach((v, idx) => {
          if (typeof v !== 'string') return
          const err = validateValueAgainstDatatype(v, assignment)
          if (!err) return
          issues.push({
            kind: 'typeMismatch',
            elementId: ot.id,
            otId: ot.id, instanceIndex: idx, value: v,
            profileId: assignment.profileId, datatypeId: assignment.datatypeId,
            message: `"${v}" ${err}`,
          })
        })
        continue
      }

      if (ot.kind !== 'entity') continue

      // Entity instance type checks: route through the identifier shape, which
      // resolves to the entity's own PI or — for inheriting subtypes — to the
      // supertype that owns the PI. For each top-level column we walk the
      // column's full nested shape (composite-PI players may themselves have
      // composite PIs) and validate every leaf string against its leaf VT's
      // datatype.
      const shape = getEntityIdentifierShape(ot, facts || [], objectTypes || [], subtypes || [], constraints)
      if (!shape) continue
      const colShapes = shape.columns.map(col => {
        const playerOt = col.playerOtId ? otById.get(col.playerOtId) : null
        return getNestedCellShape(playerOt, facts || [], objectTypes || [], subtypes || [], constraints)
      })

      instances.forEach((inst, idx) => {
        // Normalise: ref-mode entities store strings directly; composite-PI
        // entities store tuples. For single-column composite-PI the instance
        // is still a tuple of length 1.
        const cells = shape.columns.length === 1 && typeof inst === 'string'
          ? [inst]
          : Array.isArray(inst) ? inst : []
        for (let ci = 0; ci < shape.columns.length; ci++) {
          const leafErrors = collectLeafTypeErrors(
            cells[ci], colShapes[ci],
            facts || [], objectTypes || [], subtypes || [], '')
          for (const le of leafErrors) {
            issues.push({
              kind: 'typeMismatch',
              elementId: ot.id,
              otId: ot.id,
              instanceIndex: idx,
              ...(shape.columns.length > 1 ? { cellIndex: ci } : {}),
              value: le.value,
              profileId: le.assignment.profileId,
              datatypeId: le.assignment.datatypeId,
              message: le.pathLabel
                ? `${le.pathLabel}: "${le.value}" ${le.err}`
                : `"${le.value}" ${le.err}`,
            })
          }
        }
      })
    }
  }

  // ── 5. Value range violations ──────────────────────────────────────────
  // Check each OT's valueRange against its population instances.
  if (objectTypes?.length && populations) {
    for (const ot of objectTypes) {
      const vr = ot.valueRange
      if (!vr?.length) continue
      const instances = populations[ot.id]
      if (!instances?.length) continue
      const kind = datatypeAssignmentToKind(ot.datatypeAssignment)
      instances.forEach((v, idx) => {
        if (valueInRange(v, vr, kind)) return
        issues.push({
          kind: 'valueRangeViolation',
          elementId: ot.id,
          otId: ot.id, instanceIndex: idx, value: v,
          message: `"${v}" is outside the value range of ${ot.name || 'this type'}`,
        })
      })
    }
  }

  // ── 6. Role value range violations ─────────────────────────────────────
  // Check each role's valueRange against the tuple cells in that role.
  // Identifying facts are NOT skipped — their effective tuples are derived
  // from the entity population so role value ranges are still validated.
  if (facts?.length && factPopulations) {
    for (const fact of facts) {
      const tuples = effectiveFactTuples(fact)
      if (!tuples?.length) continue
      const arity = fact.arity ?? fact.roles?.length ?? 0
      for (let ri = 0; ri < arity; ri++) {
        const role = fact.roles?.[ri]
        const vr = role?.valueRange
        if (!vr?.length) continue
        const playerOt = role?.objectTypeId ? otById.get(role.objectTypeId) : null
        const kind = datatypeAssignmentToKind(playerOt?.datatypeAssignment)
        tuples.forEach((tuple, ti) => {
          const v = typeof tuple?.[ri] === 'string' ? tuple[ri].trim() : ''
          if (v === '') return
          if (valueInRange(v, vr, kind)) return
          const rLabel = role.roleName?.trim() || `role ${ri + 1}`
          issues.push({
            kind: 'valueRangeViolation',
            elementId: fact.id,
            factId: fact.id, tupleIndex: ti, roleIndex: ri, value: v,
            message: `"${v}" is outside the value range of ${rLabel} in ${fact.readingParts?.filter(Boolean).join(' ').trim() || 'this fact type'}`,
          })
        })
      }
    }
  }

  // ── 7. Subtype mapping completeness + injectivity (non-inheriting only) ──
  // For each non-inheriting subtype edge, the mapping from subtype instances
  // to supertype instances must be:
  //   - total:     every subtype instance has a complete supertype-side row
  //   - injective: no two distinct subtype instances share the same supertype
  //                value
  if (subtypes?.length) {
    for (const edge of subtypes) {
      if (edge.inheritsPreferredIdentifier !== false) continue
      const sub = otById.get(edge.subId)
      const sup = otById.get(edge.superId)
      if (!sub || sub.kind !== 'entity') continue
      if (!sup || sup.kind !== 'entity') continue
      const subPop = populations?.[sub.id] ?? []
      if (subPop.length === 0) continue
      const supShape = getEntityIdentifierShape(sup, facts || [], objectTypes || [], subtypes || [], constraints)
      const width = supShape?.columns?.length ?? 0
      if (width === 0) continue
      const map = subtypeMappings?.[edge.id] ?? []

      const seenSupKeys = new Map()  // key → [subtype-row indices]
      subPop.forEach((subInst, i) => {
        if (!isCompleteValue(subInst)) return
        const row = map[i]
        if (!Array.isArray(row)) {
          issues.push({
            kind: 'mappingIncomplete',
            elementId: edge.id,
            subtypeEdgeId: edge.id,
            subtypeId: sub.id,
            supertypeId: sup.id,
            rowIndex: i,
            message: `${sub.name || 'subtype'} instance at row ${i + 1} has no ${sup.name || 'supertype'} mapping`,
          })
          return
        }
        const cells = Array.from({ length: width }, (_, ci) => row[ci])
        const supInstance = width === 1 ? cells[0] : cells
        if (!isCompleteValue(supInstance)) {
          issues.push({
            kind: 'mappingIncomplete',
            elementId: edge.id,
            subtypeEdgeId: edge.id,
            subtypeId: sub.id,
            supertypeId: sup.id,
            rowIndex: i,
            message: `${sub.name || 'subtype'} instance at row ${i + 1} has no ${sup.name || 'supertype'} mapping`,
          })
          return
        }
        const key = JSON.stringify(supInstance)
        if (!seenSupKeys.has(key)) seenSupKeys.set(key, [])
        seenSupKeys.get(key).push(i)
      })

      const displayValue = (v) => Array.isArray(v)
        ? `(${v.map(displayValue).join(', ')})`
        : `"${v}"`
      for (const [key, rows] of seenSupKeys) {
        if (rows.length < 2) continue
        const inst = JSON.parse(key)
        const valueLabel = displayValue(inst)
        const rowLabel = rows.map(r => r + 1).join(', ')
        issues.push({
          kind: 'mappingNotInjective',
          elementId: edge.id,
          subtypeEdgeId: edge.id,
          subtypeId: sub.id,
          supertypeId: sup.id,
          rowIndices: [...rows],
          values: inst,
          message: `${sub.name || 'subtype'} → ${sup.name || 'supertype'} mapping is not injective: rows ${rowLabel} share ${valueLabel}`,
        })
      }
    }
  }

  // ── 8. Missing propagation: values that should appear in another type's pop ─
  // Populations across related types are no longer derived silently — they're
  // independent stores kept in sync only via cascading propagation at edit
  // time. When the user then edits/deletes, those stores can drift apart.
  // The rules below flag drift so the user can re-propagate (or accept the
  // mismatch as part of a draft model).
  const popKeys = (pop) => {
    const set = new Set()
    for (const v of (pop ?? [])) {
      if (typeof v === 'string') { if (v !== '') set.add(JSON.stringify(v)) }
      else if (Array.isArray(v)) {
        if (v.length === 0) continue
        if (v.some(c => typeof c !== 'string')) continue
        set.add(JSON.stringify(v))
      }
    }
    return set
  }

  if (objectTypes?.length) {
    for (const ot of objectTypes) {
      if (ot.kind !== 'entity') continue
      const myPop = populations?.[ot.id] ?? []
      if (myPop.length === 0) continue

      // (a) Inheriting subtype: each value must also be in every inheriting
      //     supertype's population.
      for (const st of (subtypes || [])) {
        if (st.subId !== ot.id) continue
        if (st.inheritsPreferredIdentifier === false) continue
        const sup = otById.get(st.superId)
        if (!sup || sup.kind !== 'entity') continue
        const supKeys = popKeys(populations?.[sup.id])
        myPop.forEach((v, idx) => {
          if (typeof v === 'string' && v === '') return
          if (Array.isArray(v) && v.some(c => typeof c !== 'string')) return
          if (supKeys.has(JSON.stringify(v))) return
          const display = Array.isArray(v) ? `(${v.map(c => `"${c}"`).join(', ')})` : `"${v}"`
          issues.push({
            kind: 'missingInSupertypePop',
            elementId: ot.id,
            otId: ot.id,
            instanceIndex: idx,
            value: v,
            supertypeId: sup.id,
            message: `${display} is not in the population of ${sup.name || 'the supertype'}`,
          })
        })
      }

      // (b) Ref-mode entity: each value must be in the ref-mode VT's pop.
      const rm = findRefMode(ot, facts || [], objectTypes || [])
      if (rm) {
        const vt = otById.get(rm.vtId)
        if (vt) {
          const vtKeys = popKeys(populations?.[vt.id])
          myPop.forEach((v, idx) => {
            if (typeof v !== 'string' || v === '') return
            if (vtKeys.has(JSON.stringify(v))) return
            issues.push({
              kind: 'missingInPlayerPop',
              elementId: ot.id,
              otId: ot.id,
              instanceIndex: idx,
              value: v,
              playerId: vt.id,
              message: `"${v}" is not in the population of ${vt.name || 'the ref-mode value type'}`,
            })
          })
        }
        continue
      }

      // (c) Composite-PI entity: each tuple cell must be in the corresponding
      //     identifying-role player's pop.
      const cp = findCompositePI(ot, facts || [], objectTypes || [], constraints)
      if (cp) {
        const colPlayers = cp.identifyingRoleIndices.map((ri, ci) => {
          const factId = cp.factIds ? cp.factIds[ci] : cp.factId
          const fact = (facts || []).find(f => f.id === factId)
          const playerOtId = fact?.roles?.[ri]?.objectTypeId
          const player = playerOtId ? findRolePlayer(playerOtId, objectTypes || [], facts || []) : null
          if (!player) return null
          const sourcePop = player.objectified
            ? (factPopulations?.[player.id] ?? [])
            : (populations?.[player.id] ?? [])
          return { playerOt: player, keys: popKeys(sourcePop) }
        })
        myPop.forEach((tuple, idx) => {
          if (!Array.isArray(tuple)) return
          tuple.forEach((cell, ci) => {
            const col = colPlayers[ci]
            if (!col) return
            // Normalise cell to a JSON-comparable form: trimmed string, or
            // complete tuple. Skip empty / partially-empty cells (handled
            // elsewhere). Tuple cells correspond to nested composite-PI
            // players — same comparison still works (popKeys uses JSON).
            let key
            if (typeof cell === 'string') {
              const trimmed = cell.trim()
              if (trimmed === '') return
              key = JSON.stringify(trimmed)
            } else if (Array.isArray(cell)) {
              if (cell.length === 0) return
              if (cell.some(c => typeof c !== 'string')) return
              key = JSON.stringify(cell)
            } else return
            if (col.keys.has(key)) return
            const display = Array.isArray(cell)
              ? `(${cell.map(c => `"${c}"`).join(', ')})`
              : `"${cell}"`
            issues.push({
              kind: 'missingInPlayerPop',
              elementId: ot.id,
              otId: ot.id,
              instanceIndex: idx,
              cellIndex: ci,
              value: cell,
              playerId: col.playerOt.id,
              message: `${display} is not in the population of ${col.playerOt.name || col.playerOt.objectifiedName || 'the identifying-role player'}`,
            })
          })
        })
      }

      // (d) Composite-PI entity: flag population entries that still contain
      //     the UNSET sentinel (truly unedited cells). Empty strings are valid
      //     in ORM2 and are NOT incomplete.
      if (cp) {
        const containsUnset = (v) => {
          if (typeof v === 'string') return v === UNSET
          if (Array.isArray(v)) return v.some(containsUnset)
          return false
        }
        myPop.forEach((tuple, idx) => {
          if (!Array.isArray(tuple)) return
          if (!containsUnset(tuple)) return
          const displayCell = (c) => Array.isArray(c)
            ? `(${c.map(cc => `"${cc}"`).join(', ')})`
            : `"${c}"`
          const display = `(${tuple.map(displayCell).join(', ')})`
          issues.push({
            kind: 'incompleteIdentifier',
            elementId: ot.id,
            otId: ot.id,
            instanceIndex: idx,
            value: tuple,
            message: `${display} is an incomplete identifier for ${ot.name || 'this entity'} — some identifying roles contain unedited cells`,
          })
        })
      }
    }
  }

  // (e) Non-inheriting subtype edges: each complete mapping row's
  //     supertype-encoded value must be in the supertype's pop.
  if (subtypes?.length) {
    for (const edge of subtypes) {
      if (edge.inheritsPreferredIdentifier !== false) continue
      const sup = otById.get(edge.superId)
      if (!sup || sup.kind !== 'entity') continue
      const shape = getEntityIdentifierShape(sup, facts || [], objectTypes || [], subtypes || [], constraints)
      if (!shape) continue
      const width = shape.columns.length
      const supKeys = popKeys(populations?.[sup.id])
      const rows = subtypeMappings?.[edge.id] ?? []
      const subPop = populations?.[edge.subId] ?? []
      const displayInstance = (v) => Array.isArray(v)
        ? `(${v.map(displayInstance).join(', ')})`
        : `"${v}"`
      rows.forEach((row, idx) => {
        if (!isCompleteValue(subPop[idx])) return
        if (!Array.isArray(row)) return
        const cells = Array.from({ length: width }, (_, ci) => row[ci])
        const supValue = width === 1 ? cells[0] : cells
        if (!isCompleteValue(supValue)) return
        if (supKeys.has(JSON.stringify(supValue))) return
        const display = displayInstance(supValue)
        issues.push({
          kind: 'missingInSupertypePop',
          elementId: edge.id,
          subtypeEdgeId: edge.id,
          rowIndex: idx,
          value: supValue,
          supertypeId: sup.id,
          message: `${display} is not in the population of ${sup.name || 'the supertype'}`,
        })
      })
    }
  }

  // ── 9. Exclusion, equality, subset constraint population checks ───────────
  // Each sequence has an associated query (a relational join pattern).  We
  // evaluate the query to obtain a result set, then compare sets across
  // sequences:
  //   exclusion: all pairwise result sets must be disjoint
  //   equality:  all result sets must be equal
  //   subset:    result set of sequence 1 ⊆ result set of sequence 2
  //
  // If a query is absent or has an unrecognised structure we fall back to a
  // direct role-projection of the underlying fact population (legacy path).
  if (constraints?.length && facts?.length) {
    const CHECKED = new Set([])  // exclusion, equality, subset all handled after DSU

    // (normalizeSeededRole is now a module-level function)

    // Evaluate one query → { keys: Set<string>, values: any[] } or null.
    //
    // The evaluator handles three structural forms:
    //
    // A) Subtype atom (no fact atoms): result = population of the sub OT.
    //
    // B) Fact atoms with seeded-role output positions (the standard form for
    //    exclusion / equality / subset).  OT atoms are pure join variables —
    //    they constrain which fact rows may be combined but never appear in the
    //    output.  A recursive nested-loop join collects (seeded-role value)
    //    tuples ordered by seqPosition.
    //
    // C) Legacy: one isOutput OT copy, no seeded-role outputs (older saved
    //    queries or manually-built queries for uniqueness / frequency).  The
    //    result is the intersection of the per-fact-copy value sets reachable
    //    through the output variable.
    // (evaluateQuery is now a module-level function)

    const seqLabel = (i) => `sequence ${i + 1}`
    const displayV = (rawV) => projCellDisplay(projCellKey(rawV))

    for (const c of (constraints || [])) {
      if (!CHECKED.has(c.constraintType)) continue
      const seqs    = c.sequences ?? []
      const queries = c.queries ?? []
      if (seqs.length < 2) continue

      const projections = seqs.map((seq, i) => {
        const qResult = evaluateQuery(queries[i] ?? null, facts, populations, effectiveFactTuples)
        return qResult !== null ? qResult : projectSequence(seq, facts, effectiveFactTuples)
      })
      if (projections.some(p => p === null)) continue

      if (c.constraintType === 'equality') {
        const ref = projections[0]
        for (let i = 1; i < projections.length; i++) {
          const pi = projections[i]
          for (const rawV of ref.values) {
            if (!pi.keys.has(JSON.stringify(projCellKey(rawV)))) {
              issues.push({
                kind: 'equalityViolation',
                elementId: c.id,
                constraintId: c.id,
                seqIndices: [0, i],
                value: rawV,
                message: `${displayV(rawV)} is in ${seqLabel(0)} but not in ${seqLabel(i)} — violates equality`,
              })
            }
          }
          for (const rawV of pi.values) {
            if (!ref.keys.has(JSON.stringify(projCellKey(rawV)))) {
              issues.push({
                kind: 'equalityViolation',
                elementId: c.id,
                constraintId: c.id,
                seqIndices: [i, 0],
                value: rawV,
                message: `${displayV(rawV)} is in ${seqLabel(i)} but not in ${seqLabel(0)} — violates equality`,
              })
            }
          }
        }
      }

      if (c.constraintType === 'subset') {
        const [sub, sup] = projections
        for (const rawV of sub.values) {
          if (!sup.keys.has(JSON.stringify(projCellKey(rawV)))) {
            issues.push({
              kind: 'subsetViolation',
              elementId: c.id,
              constraintId: c.id,
              seqIndices: [0, 1],
              value: rawV,
              message: `${displayV(rawV)} is in ${seqLabel(0)} but not in ${seqLabel(1)} — violates subset`,
            })
          }
        }
      }
    }
  }

  // ── 9b. Inclusive-or and exclusive-or constraint population checks ───────────
  // inclusive-or:  every instance of the target type must appear in at least one
  //                sequence projection.
  // exclusive-or: moved to after DSU construction for DSU-based correspondence checks.

  // ── 9c. Value comparison constraint population checks ─────────────────────
  // For each value-comparison constraint, obtain the binary relation from
  // the query (if defined) or by direct same-fact projection, then check
  // that every pair satisfies the declared operator.
  if (constraints?.length && facts?.length) {
    for (const c of (constraints || [])) {
      if (c.constraintType !== 'valueComparison') continue
      const seqs = c.sequences ?? []
      const seq = seqs[0]
      if (!Array.isArray(seq) || seq.length < 2) continue
      const roleMembers = seq.filter(m => m.kind === 'role' && !m.factId?.includes('_il_'))
      if (roleMembers.length !== 2) continue
      const op = c.operator ?? '='
      const query = (c.queries ?? [])[0] ?? null
      if (query) {
        const qResult = evaluateQuery(query, facts, populations, effectiveFactTuples)
        if (!qResult) continue
        qResult.values.forEach((rawVal, ti) => {
          if (!Array.isArray(rawVal) || rawVal.length < 2) return
          const v1 = typeof rawVal[0] === 'string' ? rawVal[0].trim() : String(rawVal[0] ?? '')
          const v2 = typeof rawVal[1] === 'string' ? rawVal[1].trim() : String(rawVal[1] ?? '')
          if (cmpValues(v1, v2, op)) return
          issues.push({
            kind: 'valueComparisonViolation',
            elementId: c.id,
            constraintId: c.id,
            tupleIndex: ti,
            value: v1, value2: v2,
            message: `"${v1}" ${op} "${v2}" — comparison does not hold`,
          })
        })
      } else {
        const r0 = roleMembers[0]
        const r1 = roleMembers[1]
        if (r0.factId !== r1.factId) continue
        const fact = (facts || []).find(f => f.id === r0.factId)
        if (!fact) continue
        const tuples = effectiveFactTuples(fact) ?? []
        tuples.forEach((tuple, ti) => {
          const v1 = typeof tuple?.[r0.roleIndex] === 'string' ? tuple[r0.roleIndex].trim() : ''
          const v2 = typeof tuple?.[r1.roleIndex] === 'string' ? tuple[r1.roleIndex].trim() : ''
          if (cmpValues(v1, v2, op)) return
          issues.push({
            kind: 'valueComparisonViolation',
            elementId: c.id,
            constraintId: c.id,
            factId: fact.id,
            tupleIndex: ti,
            roleIndex0: r0.roleIndex,
            roleIndex1: r1.roleIndex,
            value: v1, value2: v2,
            message: `"${v1}" ${op} "${v2}" — comparison does not hold`,
          })
        })
      }
    }
  }

  // ── 10. External uniqueness constraint checks ──────────────────────────────
  // An external uniqueness constrains a set of roles (possibly from different
  // facts) so that every combination of values is unique.  The constraint may
  // have a query (defining a cross-fact join through the target OT) in which
  // case evaluateQuery gives the correct projected tuples with join counts.
  // Without a query, a direct role projection is used (best-effort for
  // single-fact constraints or per-role uniqueness for cross-fact).
  if (constraints?.length && facts?.length) {
    for (const con of constraints) {
      if (con.constraintType !== 'uniqueness') continue
      const seqs = con.sequences ?? []
      if (seqs.length === 0) continue
      const seq = seqs[0]
      if (!Array.isArray(seq) || seq.length === 0) continue
      const roleMembers = seq.filter(m => m.kind === 'role' && !m.factId?.includes('_il_'))
      if (roleMembers.length === 0) continue

      const query = (con.queries ?? [])[0] ?? null
      let counts = new Map()

      if (query) {
        const qResult = evaluateQuery(query, facts, populations, effectiveFactTuples)
        if (qResult && qResult.counts) {
          for (const [key, count] of qResult.counts) {
            if (count > 1) counts.set(key, count)
          }
        }
      }

      // Fallback: direct role projection — only valid when all roles are on the
      // same fact (composite-key check).  Cross-fact role sets require a query
      // to define the join; without one the constraint cannot be validated.
      if (counts.size === 0) {
        const uniqueFacts = new Set(roleMembers.map(m => m.factId))
        if (uniqueFacts.size === 1) {
          const factId = roleMembers[0].factId
          const fact = (facts || []).find(f => f.id === factId)
          if (fact) {
            const riList = roleMembers.map(m => m.roleIndex)
            const tmp = new Map()
            for (const tuple of (effectiveFactTuples(fact) ?? [])) {
              if (!Array.isArray(tuple)) continue
              const norms = riList.map(ri => projCellKey(tuple[ri]))
              if (norms.some(n => n === null)) continue
              const key = JSON.stringify(norms)
              tmp.set(key, (tmp.get(key) ?? 0) + 1)
            }
            for (const [key, count] of tmp) {
              if (count > 1) counts.set(key, count)
            }
          }
        }
      }

      for (const [key, count] of counts) {
        const rawNorms = JSON.parse(key)
        const isSingle = roleMembers.length === 1
        const value = isSingle ? rawNorms[0] : rawNorms
        const displayStr = isSingle
          ? projCellDisplay(rawNorms[0])
          : `(${rawNorms.map(v => projCellDisplay(v)).join(', ')})`
        issues.push({
          kind: 'uniquenessViolation',
          elementId: con.id,
          constraintId: con.id,
          value,
          message: `External uniqueness violated: ${displayStr} appears ${count} times`,
        })
      }

      // ── 10a. Preferred identifier (PI) check for external uniqueness ──
      // When the constraint is marked as a preferred identifier, every element
      // in the target OT's population must appear exactly once as the target
      // of a query result record.  "Target" means the value bound to the OT
      // copy whose originalId matches con.targetObjectTypeId.
      if (con.isPreferredIdentifier && con.targetObjectTypeId && query) {
        const targetAtom = query.atoms.find(
          a => a.kind === 'objectType' && a.originalId === con.targetObjectTypeId
        )
        if (targetAtom) {
          const targetCounts = new Map()
          const resetQuery = (con.queries ?? [])[0] ?? null
          evaluateQuery(resetQuery, facts, populations, effectiveFactTuples, (varAssign) => {
            const normKey = varAssign.get(targetAtom.id)
            if (normKey != null) {
              targetCounts.set(normKey, (targetCounts.get(normKey) ?? 0) + 1)
            }
          })

          const targetPop = populations?.[con.targetObjectTypeId] ?? []
          for (const inst of targetPop) {
            if (!isCompleteValue(inst)) continue
            const instNorm = projCellKey(inst)
            if (instNorm === null) continue
            const instKey = JSON.stringify(instNorm)
            const count = targetCounts.get(instKey) ?? 0
            if (count !== 1) {
              issues.push({
                kind: 'uniquenessViolation',
                elementId: con.id,
                constraintId: con.id,
                value: inst,
                message: `Preferred identifier violated: ${projCellDisplay(instNorm)} appears ${count} time${count === 0 ? 's (missing from query result)' : 's in query result'}`,
              })
            }
          }
        }
      }
    }
  }

  // ── 11. Ring constraint population checks ──────────────────────────────────
  // The binary relation R is determined as follows:
  //   • Query defined: always use evaluateQuery — the query specifies which
  //     relation to check (e.g. FT(OUT1,OUT2) gives R directly; a composed
  //     query FT(OUT1,V)&FT(V,OUT2) gives R∘R).  Query result values are
  //     [left, right] pairs (seqPosition 0 and 1).
  //   • No query, same fact: project directly from effectiveFactTuples using
  //     the two sequence role indices.
  //   • No query, cross-fact: cannot determine R; skip.
  if (constraints?.length && facts?.length) {
    for (const con of constraints) {
      if (con.constraintType !== 'ring') continue
      const ringTypes = con.ringTypes ?? []
      if (ringTypes.length === 0) continue
      const seqs = con.sequences ?? []
      if (seqs.length === 0) continue
      const seq = seqs[0]
      if (!Array.isArray(seq) || seq.length < 2) continue
      const roleMembers = seq.filter(m => m.kind === 'role')
      const leftRef  = roleMembers[0]
      const rightRef = roleMembers[1]
      if (!leftRef || !rightRef) continue

      // Role player OTs for DSU-based cross-type identity comparison.
      const leftOtId  = (facts || []).find(f => f.id === leftRef.factId)?.roles?.[leftRef.roleIndex]?.objectTypeId ?? null
      const rightOtId = (facts || []).find(f => f.id === rightRef.factId)?.roles?.[rightRef.roleIndex]?.objectTypeId ?? null

      // Build DSU so instances from different types that represent the same object
      // are treated as identical (C2 case: left and right roles have different PI roots).
      const { dsuFind: ringDsuFind, nodeKey: ringNodeKey } =
        buildSubtypeDSU({ objectTypes, facts, populations, subtypes, subtypeMappings, factPopulations, nestedEntityMappings })

      // Compute DSU representative for a norm value at a given OT.
      const keyToNorm = new Map()  // rep string → norm value (for violation display)
      const toRep = (otId, norm) => {
        const rep = otId ? ringDsuFind(ringNodeKey(otId, norm)) : JSON.stringify(norm)
        if (!keyToNorm.has(rep)) keyToNorm.set(rep, norm)
        return rep
      }

      // Build the relation as a deduplicated set of {a, b, aKey, bKey} pairs.
      // aKey/bKey are DSU representatives (not raw JSON strings).
      const relMap = new Map()
      const query = (con.queries ?? [])[0] ?? null

      if (query) {
        // Query-defined relation: result values are [leftVal, rightVal] arrays.
        const qResult = evaluateQuery(query, facts, populations, effectiveFactTuples)
        if (!qResult) continue
        for (const rawVal of qResult.values) {
          if (!Array.isArray(rawVal) || rawVal.length < 2) continue
          const aNorm = projCellKey(rawVal[0])
          const bNorm = projCellKey(rawVal[1])
          if (aNorm === null || bNorm === null) continue
          const aKey = toRep(leftOtId, aNorm)
          const bKey = toRep(rightOtId, bNorm)
          const k = JSON.stringify([aKey, bKey])
          if (!relMap.has(k)) relMap.set(k, { a: aNorm, b: bNorm, aKey, bKey })
        }
      } else if (leftRef.factId === rightRef.factId) {
        // No query, same fact: project directly from the fact population.
        const fact = (facts || []).find(f => f.id === leftRef.factId)
        if (!fact) continue
        for (const tuple of (effectiveFactTuples(fact) ?? [])) {
          if (!Array.isArray(tuple)) continue
          const aNorm = projCellKey(tuple[leftRef.roleIndex])
          const bNorm = projCellKey(tuple[rightRef.roleIndex])
          if (aNorm === null || bNorm === null) continue
          const aKey = toRep(leftOtId, aNorm)
          const bKey = toRep(rightOtId, bNorm)
          const k = JSON.stringify([aKey, bKey])
          if (!relMap.has(k)) relMap.set(k, { a: aNorm, b: bNorm, aKey, bKey })
        }
      } else {
        // No query, cross-fact: cannot determine R.
        continue
      }

      const rel = [...relMap.values()]
      if (rel.length === 0) continue

      // Pair-existence and successor structures.
      const pairSet = new Set(rel.map(({ aKey, bKey }) => JSON.stringify([aKey, bKey])))
      const hasPair = (ak, bk) => pairSet.has(JSON.stringify([ak, bk]))

      const succMap = new Map()
      for (const { aKey, bKey } of rel) {
        if (!succMap.has(aKey)) succMap.set(aKey, new Set())
        succMap.get(aKey).add(bKey)
      }

      const dv = (v) => projCellDisplay(v)
      const push = (ringType, extra) => issues.push({
        kind: 'ringViolation', elementId: con.id, constraintId: con.id, ringType, ...extra,
      })

      for (const rt of ringTypes) {

        if (rt === 'irreflexive') {
          for (const { a, b, aKey, bKey } of rel) {
            if (aKey !== bKey) continue
            push(rt, { value: a,
              message: `Irreflexivity violated: (${dv(a)}, ${dv(b)}) is a self-pair` })
          }

        } else if (rt === 'reflexive') {
          // Every element that appears in any role must have a self-pair in R.
          const participants = new Map()
          for (const { a, aKey, b, bKey } of rel) {
            if (!participants.has(aKey)) participants.set(aKey, a)
            if (!participants.has(bKey)) participants.set(bKey, b)
          }
          for (const [key, val] of participants) {
            if (hasPair(key, key)) continue
            push(rt, { value: val,
              message: `Local reflexivity violated: ${dv(val)} participates in the relation but (${dv(val)}, ${dv(val)}) is not in the population` })
          }

        } else if (rt === 'purely-reflexive') {
          for (const { a, b, aKey, bKey } of rel) {
            if (aKey === bKey) continue
            push(rt, { value: a, value2: b,
              message: `Pure reflexivity violated: (${dv(a)}, ${dv(b)}) is not a self-pair` })
          }

        } else if (rt === 'asymmetric') {
          // ∀(a,b) ∈ R: (b,a) ∉ R.  Report each violating pair once.
          for (const { a, b, aKey, bKey } of rel) {
            if (!hasPair(bKey, aKey)) continue
            if (aKey > bKey) continue  // deduplicate
            push(rt, { value: a, value2: b,
              message: `Asymmetry violated: both (${dv(a)}, ${dv(b)}) and (${dv(b)}, ${dv(a)}) are in the population` })
          }

        } else if (rt === 'symmetric') {
          // ∀(a,b) ∈ R: (b,a) ∈ R.
          for (const { a, b, aKey, bKey } of rel) {
            if (hasPair(bKey, aKey)) continue
            push(rt, { value: a, value2: b,
              message: `Symmetry violated: (${dv(a)}, ${dv(b)}) is in the population but (${dv(b)}, ${dv(a)}) is not` })
          }

        } else if (rt === 'antisymmetric') {
          // ∀(a,b) ∈ R, a≠b: (b,a) ∉ R.  Report each violating pair once.
          for (const { a, b, aKey, bKey } of rel) {
            if (aKey === bKey) continue
            if (!hasPair(bKey, aKey)) continue
            if (aKey > bKey) continue  // deduplicate
            push(rt, { value: a, value2: b,
              message: `Antisymmetry violated: both (${dv(a)}, ${dv(b)}) and (${dv(b)}, ${dv(a)}) are in the population` })
          }

        } else if (rt === 'transitive') {
          // ∀(a,b),(b,c) ∈ R: (a,c) ∈ R.  Report each missing closure once.
          const reported = new Set()
          for (const { a, b, aKey, bKey } of rel) {
            for (const cKey of (succMap.get(bKey) ?? [])) {
              if (hasPair(aKey, cKey)) continue
              const rk = JSON.stringify([aKey, cKey])
              if (reported.has(rk)) continue
              reported.add(rk)
              const cVal = keyToNorm.get(cKey) ?? cKey
              push(rt, { value: a, value2: cVal,
                message: `Transitivity violated: (${dv(a)}, ${dv(b)}) and (${dv(b)}, ${dv(cVal)}) are in the population but (${dv(a)}, ${dv(cVal)}) is not` })
            }
          }

        } else if (rt === 'intransitive') {
          // ∀(a,b),(b,c) ∈ R: (a,c) ∉ R.  Report each violating closure once.
          const reported = new Set()
          for (const { a, b, aKey, bKey } of rel) {
            for (const cKey of (succMap.get(bKey) ?? [])) {
              if (!hasPair(aKey, cKey)) continue
              const rk = JSON.stringify([aKey, cKey])
              if (reported.has(rk)) continue
              reported.add(rk)
              const cVal = keyToNorm.get(cKey) ?? cKey
              push(rt, { value: a, value2: cVal,
                message: `Intransitivity violated: (${dv(a)}, ${dv(b)}), (${dv(b)}, ${dv(cVal)}), and (${dv(a)}, ${dv(cVal)}) are all in the population` })
            }
          }

        } else if (rt === 'strongly-intransitive') {
          // ∀x,y,z: R(x,y) ∧ R⁺(y,z) → ¬R(x,z)
          const reach = new Map()
          const computeReach = (startKey) => {
            if (reach.has(startKey)) return reach.get(startKey)
            const visited = new Set()
            const queue = [startKey]
            while (queue.length > 0) {
              const node = queue.shift()
              for (const next of (succMap.get(node) ?? [])) {
                if (!visited.has(next)) { visited.add(next); queue.push(next) }
              }
            }
            reach.set(startKey, visited)
            return visited
          }

          const reported = new Set()
          for (const { a: x, aKey: xKey, b: y, bKey: yKey } of rel) {
            for (const zKey of computeReach(yKey)) {
              if (!hasPair(xKey, zKey)) continue
              const rk = JSON.stringify([xKey, zKey])
              if (reported.has(rk)) continue
              reported.add(rk)
              const zVal = keyToNorm.get(zKey) ?? zKey
              push(rt, { value: x, value2: zVal,
                message: zKey === yKey
                  ? `Strong intransitivity violated: (${dv(x)}, ${dv(y)}) is in the population and ${dv(y)} can reach itself (cycle), so (${dv(x)}, ${dv(y)}) should not exist`
                  : `Strong intransitivity violated: (${dv(x)}, ${dv(y)}) is in the population, ${dv(y)} can reach ${dv(zVal)}, but (${dv(x)}, ${dv(zVal)}) is also in the population` })
            }
          }

        } else if (rt === 'acyclic') {
          // DFS cycle detection on the successor graph.
          const WHITE = 0, GRAY = 1, BLACK = 2
          const color = new Map()
          for (const [k] of succMap) color.set(k, WHITE)
          for (const { bKey } of rel) { if (!color.has(bKey)) color.set(bKey, WHITE) }

          let foundCycle = null
          const dfs = (node, stack) => {
            if (foundCycle) return
            color.set(node, GRAY)
            stack.push(node)
            for (const next of (succMap.get(node) ?? [])) {
              if (foundCycle) return
              if (color.get(next) === GRAY) {
                foundCycle = stack.slice(stack.indexOf(next))
                return
              }
              if ((color.get(next) ?? WHITE) === WHITE) dfs(next, stack)
            }
            stack.pop()
            color.set(node, BLACK)
          }
          for (const [node] of color) {
            if (color.get(node) === WHITE) dfs(node, [])
            if (foundCycle) break
          }

          if (foundCycle) {
            const cycleParsed = foundCycle.map(k => keyToNorm.get(k) ?? k)
            const cycleLabel  = [...cycleParsed, cycleParsed[0]].map(dv).join(' → ')
            push(rt, { cycle: cycleParsed,
              message: `Acyclicity violated: cycle ${cycleLabel}` })
          }
        }
      }
    }
  }

  // ── 12. External frequency constraint checks ────────────────────────────────
  // An external frequency constraint constrains a set of roles (possibly from
  // different facts) so that every combination of values appears a number of
  // times within a specified frequency range.  The structure mirrors external
  // uniqueness (query → evaluateQuery with counts), but the violation condition
  // uses freqRangeSatisfies instead of count > 1.
  if (constraints?.length && facts?.length) {
    for (const con of constraints) {
      if (con.constraintType !== 'frequency') continue
      const seqs = con.sequences ?? []
      if (seqs.length === 0) continue
      const seq = seqs[0]
      if (!Array.isArray(seq) || seq.length === 0) continue
      const roleMembers = seq.filter(m => m.kind === 'role' && !m.factId?.includes('_il_'))
      if (roleMembers.length === 0) continue
      const freqSpec = con.frequency
      if (!freqSpec || (Array.isArray(freqSpec) && freqSpec.length === 0)) continue

      const query = (con.queries ?? [])[0] ?? null
      let counts = new Map()

      if (query) {
        const qResult = evaluateQuery(query, facts, populations, effectiveFactTuples)
        if (qResult && qResult.counts) {
          for (const [key, count] of qResult.counts) {
            if (!freqRangeSatisfies(count, freqSpec)) counts.set(key, count)
          }
        }
      }

      // Fallback: direct role projection — same structure as uniqueness fallback
      if (counts.size === 0) {
        const uniqueFacts = new Set(roleMembers.map(m => m.factId))
        if (uniqueFacts.size === 1) {
          const factId = roleMembers[0].factId
          const fact = (facts || []).find(f => f.id === factId)
          if (fact) {
            const riList = roleMembers.map(m => m.roleIndex)
            const tmp = new Map()
            for (const tuple of (effectiveFactTuples(fact) ?? [])) {
              if (!Array.isArray(tuple)) continue
              const norms = riList.map(ri => projCellKey(tuple[ri]))
              if (norms.some(n => n === null)) continue
              const key = JSON.stringify(norms)
              tmp.set(key, (tmp.get(key) ?? 0) + 1)
            }
            for (const [key, count] of tmp) {
              if (!freqRangeSatisfies(count, freqSpec)) counts.set(key, count)
            }
          }
        }
      }

      for (const [key, count] of counts) {
        const rawNorms = JSON.parse(key)
        const isSingle = roleMembers.length === 1
        const value = isSingle ? rawNorms[0] : rawNorms
        const displayStr = isSingle
          ? projCellDisplay(rawNorms[0])
          : `(${rawNorms.map(v => projCellDisplay(v)).join(', ')})`
        issues.push({
          kind: 'frequencyViolation',
          elementId: con.id,
          constraintId: con.id,
          value,
          count,
          message: `Frequency violated: ${displayStr} appears ${count} times (outside range)`,
        })
      }
    }
  }

  // ── Shared DSU for subtype identifier equivalence (used by sections 13 & 14) ──
  // Builds the "represents the same entity" equivalence relation over
  // (typeId, entryKey) pairs induced by subtype edges.
  //
  // R1 (PI-inheriting  T1 → T2): union (T1, e) with (T2, e) for each e in T1's pop.
  // R2 (non-inheriting T1 → T2): union (T1, e1) with (T2, e2) per subtypeMappings row.
  //
  // Node key: typeId + ':' + JSON([normalized key parts]) — scalar keys are always
  // wrapped in an array so the format is uniform with future composite-UC tuple PIs.
  const dsuParent = new Map()
  const dsuRank   = new Map()
  const dsuFind = (x) => {
    if (!dsuParent.has(x)) { dsuParent.set(x, x); dsuRank.set(x, 0) }
    while (dsuParent.get(x) !== x) {
      dsuParent.set(x, dsuParent.get(dsuParent.get(x)))  // path halving
      x = dsuParent.get(x)
    }
    return x
  }
  const dsuUnion = (x, y) => {
    const rx = dsuFind(x), ry = dsuFind(y)
    if (rx === ry) return
    const rkx = dsuRank.get(rx) ?? 0, rky = dsuRank.get(ry) ?? 0
    if (rkx < rky) dsuParent.set(rx, ry)
    else if (rkx > rky) dsuParent.set(ry, rx)
    else { dsuParent.set(ry, rx); dsuRank.set(rx, rkx + 1) }
  }
  const nodeKey = (typeId, k) =>
    typeId + ':' + JSON.stringify(Array.isArray(k) ? k : [k])
  const directPop = (typeId) => {
    const ot = otById.get(typeId)
    if (ot) return ot.kind === 'entity' ? (populations?.[typeId] ?? []) : []
    const f = (facts || []).find(ff => ff.id === typeId && ff.objectified)
    return f ? playerPopulation(f) : []
  }
  for (const edge of (subtypes || [])) {
    const { subId, superId } = edge
    if (!subId || !superId) continue
    if (edge.inheritsPreferredIdentifier !== false) {
      for (const entry of directPop(subId)) {
        const k = projCellKey(entry)
        if (k === null) continue
        dsuUnion(nodeKey(subId, k), nodeKey(superId, k))
      }
    } else {
      const subPop  = directPop(subId)
      const mapping = subtypeMappings?.[edge.id] ?? []
      for (let i = 0; i < mapping.length; i++) {
        const e1 = subPop[i], e2 = mapping[i]
        if (e1 == null || !Array.isArray(e2)) continue
        const k1 = projCellKey(e1), k2 = projCellKey(e2)
        if (k1 === null || k2 === null) continue
        dsuUnion(nodeKey(subId, k1), nodeKey(superId, k2))
      }
    }
  }

  // ── 13. Non-independence: every instance must participate in a real fact ───────
  // For each non-independent (nested) entity type, every instance in its effective
  // population must appear as a role player in at least one fact type.  Implied
  // links (the auto-generated binary links of objectified facts) are not stored as
  // separate fact entries, so all facts in the array naturally qualify as real facts.
  if ((objectTypes?.length || facts?.length) && factPopulations) {
    // Build the raw participation set from fact tuple cells.
    const participates = new Set()
    for (const fact of (facts || [])) {
      const tuples = factPopulations[fact.id]
      if (!tuples?.length) continue
      for (let ri = 0; ri < (fact.roles?.length ?? 0); ri++) {
        const otId = fact.roles[ri]?.objectTypeId
        if (!otId) continue
        for (const tuple of tuples) {
          if (!Array.isArray(tuple)) continue
          const cellKey = projCellKey(tuple[ri])
          if (cellKey === null) continue
          participates.add(JSON.stringify([otId, cellKey]))
        }
      }
    }

    // Ref-mode VT participation: entity population strings are implicit fact
    // participants for the ref-mode VT even when factPopulations has no explicit
    // tuples for the ref-mode fact (which is the normal case).
    for (const ot of (objectTypes || [])) {
      if (ot.kind !== 'entity') continue
      const rm = findRefMode(ot, facts || [], objectTypes || [])
      if (!rm) continue
      for (const v of (populations?.[ot.id] ?? [])) {
        const cellKey = projCellKey(v)
        if (cellKey !== null) participates.add(JSON.stringify([rm.vtId, cellKey]))
      }
    }
    for (const fact of (facts || [])) {
      if (!fact.objectified || fact.objectifiedKind === 'value') continue
      const rm = findRefMode(fact, facts || [], objectTypes || [])
      if (!rm) continue
      for (const v of (nestedEntityMappings?.[fact.id] ?? [])) {
        const cellKey = projCellKey(v)
        if (cellKey !== null) participates.add(JSON.stringify([rm.vtId, cellKey]))
      }
    }

    // Composite-PI participation: for each fact with preferredUniqueness, derive
    // PI-role values from the entity population so that types playing PI roles
    // count as participating even when factPopulations has no explicit entry.
    // (Ref-mode is a special case already covered above; this loop is harmless
    // for those facts but also handles multi-role composite PIs.)
    for (const fact of (facts || [])) {
      if (!fact.preferredUniqueness?.length) continue
      for (const pu of fact.preferredUniqueness) {
        if (!pu.length) continue
        const coveredSet = new Set(pu)
        // Find the entity population for this PI group.
        // Case A: fact is a nested entity — PI values are in nestedEntityMappings.
        // Case B: a regular entity OT plays the uncovered role.
        let entityPop = []
        if (fact.objectified && fact.objectifiedKind !== 'value') {
          entityPop = nestedEntityMappings?.[fact.id] ?? []
        } else {
          for (let ri = 0; ri < (fact.roles?.length ?? 0); ri++) {
            if (coveredSet.has(ri)) continue
            const otId = fact.roles[ri]?.objectTypeId
            if (!otId) continue
            const ot = (objectTypes || []).find(o => o.id === otId)
            if (ot?.kind === 'entity') { entityPop = populations?.[otId] ?? []; break }
          }
        }
        for (const inst of entityPop) {
          const cells = Array.isArray(inst) ? inst : [inst]
          pu.forEach((ri, cellIdx) => {
            const otId = fact.roles?.[ri]?.objectTypeId
            if (!otId) return
            const k = projCellKey(cells[cellIdx])
            if (k !== null) participates.add(JSON.stringify([otId, k]))
          })
        }
      }
    }

    // Convert to a set of DSU representatives so that participation via any
    // member of the same equivalence class (supertype or subtype) counts.
    const participatesRep = new Set()
    for (const entry of participates) {
      const [typeId, k] = JSON.parse(entry)
      participatesRep.add(dsuFind(nodeKey(typeId, k)))
    }

    // Regular entity types
    for (const ot of (objectTypes || [])) {
      if (ot.kind !== 'entity' || ot.isIndependent) continue
      const pop = getEntityEffectivePopulation(ot.id, populations || {}, facts || [], objectTypes || [], subtypes || [], subtypeMappings || {})
      for (const inst of (pop || [])) {
        const cellKey = projCellKey(inst)
        if (cellKey === null) continue
        if (!participatesRep.has(dsuFind(nodeKey(ot.id, cellKey))))
          issues.push({
            kind: 'nonIndependentNotPlaying',
            elementId: ot.id,
            otId: ot.id,
            message: `${projCellDisplay(inst)} does not participate in any fact type (${ot.name || 'entity type'} is not independent)`,
          })
      }
    }

    // Value types (independent value types are exempt)
    for (const ot of (objectTypes || [])) {
      if (ot.kind !== 'value' || ot.isIndependent) continue
      const pop = getVtEffectivePopulation(ot.id, populations || {}, facts || [], objectTypes || [], subtypes || [], subtypeMappings || {})
      for (const inst of (pop || [])) {
        const cellKey = projCellKey(inst)
        if (cellKey === null) continue
        if (!participatesRep.has(dsuFind(nodeKey(ot.id, cellKey))))
          issues.push({
            kind: 'nonIndependentNotPlaying',
            elementId: ot.id,
            otId: ot.id,
            message: `${projCellDisplay(inst)} does not participate in any fact type (${ot.name || 'value type'})`,
          })
      }
    }

    // Nested entity types (objectified facts, entity kind only)
    for (const fact of (facts || [])) {
      if (!fact.objectified || fact.objectifiedKind === 'value' || fact.isIndependent) continue
      const name = fact.objectifiedName || 'nested entity type'
      const pop = playerPopulation(fact)
      for (const inst of (pop || [])) {
        const cellKey = projCellKey(inst)
        if (cellKey === null) continue
        if (!participatesRep.has(dsuFind(nodeKey(fact.id, cellKey))))
          issues.push({
            kind: 'nonIndependentNotPlaying',
            elementId: fact.id,
            otId: fact.id,
            factId: fact.id,
            message: `${projCellDisplay(inst)} does not participate in any fact type (${name} is not independent)`,
          })
      }
    }
  }

  // ── 14. Duplicate identifier check ──────────────────────────────────────────
  // Uses the shared DSU (built above) to find entity types whose effective
  // population contains two distinct entries in the same equivalence class —
  // meaning they identify the same real-world entity.
  {
    const checkCollisions = (typeId, effPop, typeName, isNested) => {
      if (!effPop || effPop.length < 2) return
      const seen = new Map()  // representative → { k, display } of first entry
      for (const entry of effPop) {
        const k = projCellKey(entry)
        if (k === null) continue
        const rep = dsuFind(nodeKey(typeId, k))
        const display = projCellDisplay(k)
        if (seen.has(rep)) {
          const first = seen.get(rep)
          issues.push({
            kind: 'duplicateIdentifier',
            elementId: typeId,
            otId: typeId,
            ...(isNested ? { factId: typeId } : {}),
            value: k,
            value2: first.k,
            message: `${display} and ${first.display} identify the same entity in ${typeName} — duplicate entries in the population`,
          })
        } else {
          seen.set(rep, { k, display })
        }
      }
    }

    for (const ot of (objectTypes || [])) {
      if (ot.kind !== 'entity') continue
      const effPop = getEntityEffectivePopulation(
        ot.id, populations || {}, facts || [], objectTypes || [], subtypes || [], subtypeMappings || {}
      )
      checkCollisions(ot.id, effPop, ot.name || 'entity type', false)
    }

    for (const fact of (facts || [])) {
      if (!fact.objectified || fact.objectifiedKind === 'value') continue
      const effPop = playerPopulation(fact)
      checkCollisions(fact.id, effPop, fact.objectifiedName || 'nested entity type', true)
    }
  }

  // ── Exclusion: DSU-based tuple equivalence check ─────────────────────────
  // The union of all query results is partitioned into equivalence classes of
  // tuples (component-wise DSU representative equality).  A violation occurs
  // when two or more sequences contribute a tuple to the same class.
  if (constraints?.length) {
    for (const c of (constraints || [])) {
      if (c.constraintType !== 'exclusion') continue
      const seqs = c.sequences ?? []
      const queries = c.queries ?? []
      if (seqs.length < 2) continue

      const projections = seqs.map((seq, i) => {
        const qResult = evaluateQuery(queries[i] ?? null, facts, populations, effectiveFactTuples)
        return qResult !== null ? qResult : projectSequence(seq, facts, effectiveFactTuples)
      })
      if (projections.some(p => p === null)) continue

      const posOtIds = (si) => (seqs[si] ?? []).map(m => {
        if (m.kind === 'role') return (facts || []).find(f => f.id === m.factId)?.roles?.[m.roleIndex]?.objectTypeId ?? null
        if (m.kind === 'subtype') return (subtypes || []).find(s => s.id === m.subtypeId)?.superId ?? null
        return null
      })

      const tupleClassKey = (rawV, si) => {
        const otIds = posOtIds(si)
        const cells = Array.isArray(rawV) ? rawV : [rawV]
        const reps = cells.map((v, p) => {
          const otId = otIds[p]; if (!otId) return null
          const k = projCellKey(v); if (k === null) return null
          return dsuFind(nodeKey(otId, k))
        })
        return reps.some(r => r === null) ? null : JSON.stringify(reps)
      }

      const classMap = new Map() // classKey → { seqSet, representative }
      for (let i = 0; i < projections.length; i++) {
        for (const rawV of (projections[i]?.values ?? [])) {
          const ck = tupleClassKey(rawV, i)
          if (ck === null) continue
          if (!classMap.has(ck)) classMap.set(ck, { seqSet: new Set(), representative: rawV })
          classMap.get(ck).seqSet.add(i)
        }
      }

      for (const { seqSet, representative } of classMap.values()) {
        if (seqSet.size < 2) continue
        const seqList = [...seqSet]
        issues.push({
          kind: 'exclusionViolation',
          elementId: c.id,
          constraintId: c.id,
          seqIndices: seqList,
          value: projCellKey(representative),
          message: `Equivalent tuple appears in sequences ${seqList.map(i => i + 1).join(', ')} — violates exclusion`,
        })
      }
    }
  }

  // ── Equality / Subset: DSU-based tuple equivalence checks ────────────────
  if (constraints?.length) {
    for (const c of (constraints || [])) {
      if (c.constraintType !== 'equality' && c.constraintType !== 'subset') continue
      const seqs = c.sequences ?? []
      const queries = c.queries ?? []
      if (seqs.length < 2) continue

      const projections = seqs.map((seq, i) => {
        const qResult = evaluateQuery(queries[i] ?? null, facts, populations, effectiveFactTuples)
        return qResult !== null ? qResult : projectSequence(seq, facts, effectiveFactTuples)
      })
      if (projections.some(p => p === null)) continue

      const posOtIds = (si) => (seqs[si] ?? []).map(m => {
        if (m.kind === 'role') return (facts || []).find(f => f.id === m.factId)?.roles?.[m.roleIndex]?.objectTypeId ?? null
        if (m.kind === 'subtype') return (subtypes || []).find(s => s.id === m.subtypeId)?.superId ?? null
        return null
      })
      const tupleClassKey = (rawV, si) => {
        const otIds = posOtIds(si)
        const cells = Array.isArray(rawV) ? rawV : [rawV]
        const reps = cells.map((v, p) => {
          const otId = otIds[p]; if (!otId) return null
          const k = projCellKey(v); if (k === null) return null
          return dsuFind(nodeKey(otId, k))
        })
        return reps.some(r => r === null) ? null : JSON.stringify(reps)
      }

      const classMap = new Map()
      for (let i = 0; i < projections.length; i++) {
        for (const rawV of (projections[i]?.values ?? [])) {
          const ck = tupleClassKey(rawV, i)
          if (ck === null) continue
          if (!classMap.has(ck)) classMap.set(ck, { seqSets: seqs.map(() => new Set()), rep: rawV })
          classMap.get(ck).seqSets[i].add(JSON.stringify(projCellKey(rawV)))
        }
      }

      const reportedCks = new Set()
      for (const [ck, { seqSets, rep }] of classMap) {
        if (reportedCks.has(ck)) continue
        if (c.constraintType === 'equality') {
          // Violation: any sequence has no results in this class
          const emptySets = seqSets.map((s, i) => s.size === 0 ? i : -1).filter(i => i >= 0)
          if (emptySets.length > 0) {
            reportedCks.add(ck)
            issues.push({
              kind: 'equalityViolation', elementId: c.id, constraintId: c.id,
              seqIndices: emptySets, value: projCellKey(rep),
              message: `Equivalent tuple is missing in sequence${emptySets.length > 1 ? 's' : ''} ${emptySets.map(i => i + 1).join(', ')} — violates equality`,
            })
          }
        } else {
          // subset: violation when seq0 has results but seq1 doesn't
          if (seqSets[0].size > 0 && seqSets[1].size === 0) {
            reportedCks.add(ck)
            issues.push({
              kind: 'subsetViolation', elementId: c.id, constraintId: c.id,
              seqIndices: [0, 1], value: projCellKey(rep),
              message: `Equivalent tuple is in sequence 1 but not in sequence 2 — violates subset`,
            })
          }
        }
      }
    }
  }

  // ── Inclusive Or / Exclusive Or: DSU-based correspondence checks ──────────
  // For each instance of the target OT, at least one sequence must have a
  // corresponding instance (same DSU representative = represents the same object).
  if (constraints?.length) {
    for (const c of (constraints || [])) {
      if (c.constraintType !== 'inclusiveOr') continue
      if (!c.targetObjectTypeId) continue
      const seqs = c.sequences ?? []
      if (seqs.length < 2) continue

      // Get target OT effective population
      const targetPlayer = otById.get(c.targetObjectTypeId)
        ?? (facts || []).find(f => f.id === c.targetObjectTypeId && f.objectified)
      if (!targetPlayer) continue
      const targetPop = playerPopulation(targetPlayer)
      if (!targetPop || targetPop.length === 0) continue

      // Build a DSU representative set for each sequence
      const seqRepSets = seqs.map(seq => {
        const repSet = new Set()
        if (!Array.isArray(seq) || seq.length !== 1) return repSet
        const m = seq[0]
        if (m.kind === 'subtype') {
          const st = (subtypes || []).find(s => s.id === m.subtypeId)
          if (!st) return repSet
          const subPlayer = otById.get(st.subId)
            ?? (facts || []).find(f => f.id === st.subId && f.objectified)
          const subPop = subPlayer ? playerPopulation(subPlayer) : []
          for (const v of subPop) {
            const k = projCellKey(v)
            if (k !== null) repSet.add(dsuFind(nodeKey(st.subId, k)))
          }
        } else if (m.kind === 'role' && !m.factId?.includes('_il_')) {
          const fact = (facts || []).find(f => f.id === m.factId)
          const anchorOtId = fact?.roles?.[m.roleIndex]?.objectTypeId
          if (!fact || !anchorOtId) return repSet
          for (const tuple of (effectiveFactTuples(fact) ?? [])) {
            if (!Array.isArray(tuple)) continue
            const k = projCellKey(tuple[m.roleIndex])
            if (k !== null) repSet.add(dsuFind(nodeKey(anchorOtId, k)))
          }
        }
        return repSet
      })

      const reportedReps = new Set()
      for (const inst of targetPop) {
        const k = projCellKey(inst)
        if (k === null) continue
        const rep = dsuFind(nodeKey(c.targetObjectTypeId, k))
        if (reportedReps.has(rep)) continue
        if (!seqRepSets.some(rs => rs.has(rep))) {
          reportedReps.add(rep)
          issues.push({
            kind: 'inclusiveOrViolation',
            elementId: c.id,
            constraintId: c.id,
            value: k,
            message: `Inclusive-or violated: ${projCellDisplay(k)} does not appear in any of the constrained role sequences`,
          })
        }
      }
    }
  }

  // ── Exclusive Or: DSU-based — each target instance must be in exactly one sequence ──
  if (constraints?.length) {
    for (const c of (constraints || [])) {
      if (c.constraintType !== 'exclusiveOr') continue
      if (!c.targetObjectTypeId) continue
      const seqs = c.sequences ?? []
      if (seqs.length < 2) continue

      const targetPlayer = otById.get(c.targetObjectTypeId)
        ?? (facts || []).find(f => f.id === c.targetObjectTypeId && f.objectified)
      if (!targetPlayer) continue
      const targetPop = playerPopulation(targetPlayer)
      if (!targetPop || targetPop.length === 0) continue

      const seqRepSets = seqs.map(seq => {
        const repSet = new Set()
        if (!Array.isArray(seq) || seq.length !== 1) return repSet
        const m = seq[0]
        if (m.kind === 'subtype') {
          const st = (subtypes || []).find(s => s.id === m.subtypeId)
          if (!st) return repSet
          const subPlayer = otById.get(st.subId)
            ?? (facts || []).find(f => f.id === st.subId && f.objectified)
          const subPop = subPlayer ? playerPopulation(subPlayer) : []
          for (const v of subPop) {
            const k = projCellKey(v)
            if (k !== null) repSet.add(dsuFind(nodeKey(st.subId, k)))
          }
        } else if (m.kind === 'role' && !m.factId?.includes('_il_')) {
          const fact = (facts || []).find(f => f.id === m.factId)
          const anchorOtId = fact?.roles?.[m.roleIndex]?.objectTypeId
          if (!fact || !anchorOtId) return repSet
          for (const tuple of (effectiveFactTuples(fact) ?? [])) {
            if (!Array.isArray(tuple)) continue
            const k = projCellKey(tuple[m.roleIndex])
            if (k !== null) repSet.add(dsuFind(nodeKey(anchorOtId, k)))
          }
        }
        return repSet
      })

      const reportedReps = new Set()
      for (const inst of targetPop) {
        const k = projCellKey(inst)
        if (k === null) continue
        const rep = dsuFind(nodeKey(c.targetObjectTypeId, k))
        if (reportedReps.has(rep)) continue
        const count = seqRepSets.filter(rs => rs.has(rep)).length
        if (count !== 1) {
          reportedReps.add(rep)
          issues.push({
            kind: 'exclusiveOrViolation',
            elementId: c.id,
            constraintId: c.id,
            value: k,
            message: count === 0
              ? `Exclusive-or violated: ${projCellDisplay(k)} does not appear in any of the constrained role sequences`
              : `Exclusive-or violated: ${projCellDisplay(k)} appears in ${count} role sequences (must be exactly one)`,
          })
        }
      }
    }
  }

  return issues
}

// ── LCA and C1/C2 detection helpers ──────────────────────────────────────────

// Reflexive transitive closure of the supertype relation upward from typeId.
function ancestorSetPV(typeId, subtypes) {
  const visited = new Set()
  const queue = [typeId]
  while (queue.length) {
    const curr = queue.shift()
    if (visited.has(curr)) continue
    visited.add(curr)
    for (const st of (subtypes || [])) { if (st.subId === curr) queue.push(st.superId) }
  }
  return visited
}

// Least Common Ancestor(s) of a set of type IDs.
// Returns the most specific (lowest) common ancestors — may be >1 in a DAG.
export function findLCAsForTypes(typeIds, subtypes) {
  const ids = typeIds.filter(Boolean)
  if (ids.length === 0) return []
  let common = [...ancestorSetPV(ids[0], subtypes)]
  for (let i = 1; i < ids.length; i++) {
    const ancs = ancestorSetPV(ids[i], subtypes)
    common = common.filter(id => ancs.has(id))
  }
  if (common.length === 0) return []
  return common.filter(id => !common.some(y => y !== id && ancestorSetPV(y, subtypes).has(id)))
}

// PI root: the type whose PI definition typeId ultimately uses.
// Returns typeId itself if it has its own PI; the ancestor ID if inherited; null if no PI.
function getPIRootPV(typeId, data) {
  const { facts, objectTypes, subtypes, constraints } = data
  const entity = (objectTypes || []).find(o => o.id === typeId) || (facts || []).find(f => f.id === typeId)
  if (!entity) return null
  if (findRefMode(entity, facts || [], objectTypes || [])) return typeId
  if (findCompositePI(entity, facts || [], objectTypes || [], constraints || [])) return typeId
  const inh = findInheritedPI(entity, facts || [], objectTypes || [], subtypes || [], constraints || [])
  return inh ? inh.supertype.id : null
}

// C1: all types in typeIds share the same PI root (a single common ancestor that
// provides the PI for all of them). In C1 identifiers are directly comparable.
export function checkC1ForTypes(typeIds, data) {
  const ids = typeIds.filter(Boolean)
  if (ids.length <= 1) return { isC1: true, piRoot: ids[0] ?? null }
  const roots = ids.map(id => getPIRootPV(id, data))
  if (roots.some(r => r === null)) return { isC1: false, piRoot: null }
  const first = roots[0]
  return roots.every(r => r === first) ? { isC1: true, piRoot: first } : { isC1: false, piRoot: null }
}

// ── Subtype DSU (shared by computePopulationIssues and table computations) ──
function buildSubtypeDSU(data) {
  const { objectTypes, facts, populations, subtypes, subtypeMappings, factPopulations, nestedEntityMappings } = data
  const dsuParent = new Map()
  const dsuRank   = new Map()
  const dsuFind = (x) => {
    if (!dsuParent.has(x)) { dsuParent.set(x, x); dsuRank.set(x, 0) }
    while (dsuParent.get(x) !== x) {
      dsuParent.set(x, dsuParent.get(dsuParent.get(x)))
      x = dsuParent.get(x)
    }
    return x
  }
  const dsuUnion = (x, y) => {
    const rx = dsuFind(x), ry = dsuFind(y)
    if (rx === ry) return
    const rkx = dsuRank.get(rx) ?? 0, rky = dsuRank.get(ry) ?? 0
    if (rkx < rky) dsuParent.set(rx, ry)
    else if (rkx > rky) dsuParent.set(ry, rx)
    else { dsuParent.set(ry, rx); dsuRank.set(rx, rkx + 1) }
  }
  const nodeKey = (typeId, k) =>
    typeId + ':' + JSON.stringify(Array.isArray(k) ? k : [k])

  // Track every (typeId, k) added, for LCA translation.
  const nodeInfoMap = new Map()  // nodeKeyStr → { typeId, k }
  const track = (typeId, k) => {
    const nk = nodeKey(typeId, k)
    if (!nodeInfoMap.has(nk)) nodeInfoMap.set(nk, { typeId, k })
    return nk
  }

  const otById = new Map((objectTypes || []).map(o => [o.id, o]))
  const directPop = (typeId) => {
    const ot = otById.get(typeId)
    if (ot) return ot.kind === 'entity' ? (populations?.[typeId] ?? []) : []
    const f = (facts || []).find(ff => ff.id === typeId && ff.objectified)
    if (!f) return []
    return nestedEntityMappings?.[typeId] ?? factPopulations?.[typeId] ?? []
  }
  for (const edge of (subtypes || [])) {
    const { subId, superId } = edge
    if (!subId || !superId) continue
    if (edge.inheritsPreferredIdentifier !== false) {
      for (const entry of directPop(subId)) {
        const k = projCellKey(entry)
        if (k === null) continue
        dsuUnion(track(subId, k), track(superId, k))
      }
    } else {
      const subPop  = directPop(subId)
      const mapping = subtypeMappings?.[edge.id] ?? []
      for (let i = 0; i < mapping.length; i++) {
        const e1 = subPop[i], e2 = mapping[i]
        if (e1 == null || !Array.isArray(e2)) continue
        const k1 = projCellKey(e1), k2 = projCellKey(e2)
        if (k1 === null || k2 === null) continue
        dsuUnion(track(subId, k1), track(superId, k2))
      }
    }
  }

  // Lazily-built class map: DSU rep → Map<typeId, k>.
  let classMap = null
  const getClassMap = () => {
    if (classMap) return classMap
    classMap = new Map()
    for (const [nk, { typeId, k }] of nodeInfoMap) {
      const rep = dsuFind(nk)
      if (!classMap.has(rep)) classMap.set(rep, new Map())
      if (!classMap.get(rep).has(typeId)) classMap.get(rep).set(typeId, k)
    }
    return classMap
  }

  // Translate instance (typeId, k) to its equivalent key at lcaTypeId level.
  // Returns k unchanged if typeId === lcaTypeId (identity).
  // Returns null when no mapping exists (no subtype edge data).
  const translateToLCA = (typeId, k, lcaTypeId) => {
    if (!lcaTypeId || typeId === lcaTypeId) return k
    const nk = nodeKey(typeId, k)
    if (!dsuParent.has(nk)) return null
    const rep = dsuFind(nk)
    return getClassMap().get(rep)?.get(lcaTypeId) ?? null
  }

  return { dsuFind, nodeKey, translateToLCA }
}

/**
 * Compute the row-per-target-instance table for an Inclusive Or constraint.
 *
 * C1: all involved types share the same PI root → identifiers are directly
 *     comparable; translatedTid === original tid key.
 * C2: types have different PI roots → identifiers are translated to the chosen
 *     LCA level; translatedTid is the LCA-level key (bold in the UI).
 *
 * Returns {
 *   seqCount, rows: [{ tid, translatedTid, seqMatches, hasViolation }],
 *   isC1, piRoot, availableLCAs: string[], lcaId: string|null
 * } or null.
 */
export function computeInclusiveOrTable(data, constraintId, selectedLcaId = null) {
  const { facts, factPopulations, objectTypes, populations, subtypes, subtypeMappings, nestedEntityMappings, constraints } = data
  const con = (constraints || []).find(c => c.id === constraintId)
  if (!con || con.constraintType !== 'inclusiveOr') return null
  if (!con.targetObjectTypeId) return null
  const seqs = con.sequences ?? []
  if (seqs.length < 2) return null

  // Determine the instance type for each sequence (the type whose instances appear).
  const seqInstanceTypeId = (seq) => {
    if (!Array.isArray(seq) || seq.length !== 1) return null
    const m = seq[0]
    if (m.kind === 'subtype') return (subtypes || []).find(s => s.id === m.subtypeId)?.subId ?? null
    if (m.kind === 'role') return (facts || []).find(f => f.id === m.factId)?.roles?.[m.roleIndex]?.objectTypeId ?? null
    return null
  }
  const seqTypeIds = seqs.map(seqInstanceTypeId).filter(Boolean)
  const allTypeIds = [con.targetObjectTypeId, ...seqTypeIds]

  const { isC1, piRoot } = checkC1ForTypes(allTypeIds, data)
  let availableLCAs = [], lcaId = null
  if (isC1) {
    availableLCAs = piRoot ? [piRoot] : []
    lcaId = piRoot
  } else {
    availableLCAs = findLCAsForTypes(allTypeIds, subtypes || [])
    lcaId = selectedLcaId ?? availableLCAs[0] ?? null
  }

  const { dsuFind, nodeKey, translateToLCA } = buildSubtypeDSU(data)

  const eft = (fact) =>
    computeEffectiveFactTuples(fact, facts || [], factPopulations || {}, objectTypes || [], populations || {}, nestedEntityMappings || {}, constraints)

  const otById = new Map((objectTypes || []).map(o => [o.id, o]))
  const playerPop = (id) => {
    const ot = otById.get(id)
    if (ot) {
      if (ot.kind === 'entity') return getEntityEffectivePopulation(id, populations || {}, facts || [], objectTypes || [], subtypes || [], subtypeMappings || {})
      if (ot.kind === 'value')  return getVtEffectivePopulation(id, populations || {}, facts || [], objectTypes || [], subtypes || [], subtypeMappings || {})
      return []
    }
    const f = (facts || []).find(ff => ff.id === id && ff.objectified)
    if (f) return nestedEntityMappings?.[id] ?? factPopulations?.[id] ?? []
    return []
  }

  const targetPop = playerPop(con.targetObjectTypeId)
  if (!targetPop || targetPop.length === 0)
    return { seqCount: seqs.length, rows: [], isC1, piRoot, availableLCAs, lcaId }

  // Per sequence: DSU rep → [anchor instances]
  const seqRepMaps = seqs.map(seq => {
    const repMap = new Map()
    if (!Array.isArray(seq) || seq.length !== 1) return repMap
    const m = seq[0]
    if (m.kind === 'subtype') {
      const st = (subtypes || []).find(s => s.id === m.subtypeId)
      if (!st) return repMap
      for (const v of playerPop(st.subId)) {
        const k = projCellKey(v)
        if (k === null) continue
        const rep = dsuFind(nodeKey(st.subId, k))
        if (!repMap.has(rep)) repMap.set(rep, [])
        repMap.get(rep).push(v)
      }
    } else if (m.kind === 'role' && !m.factId?.includes('_il_')) {
      const fact = (facts || []).find(f => f.id === m.factId)
      const anchorOtId = fact?.roles?.[m.roleIndex]?.objectTypeId
      if (!fact || !anchorOtId) return repMap
      const seen = new Set()
      for (const tuple of (eft(fact) ?? [])) {
        if (!Array.isArray(tuple)) continue
        const v = tuple[m.roleIndex]
        const k = projCellKey(v)
        if (k === null) continue
        const kStr = JSON.stringify(k)
        if (seen.has(kStr)) continue
        seen.add(kStr)
        const rep = dsuFind(nodeKey(anchorOtId, k))
        if (!repMap.has(rep)) repMap.set(rep, [])
        repMap.get(rep).push(v)
      }
    }
    return repMap
  })

  const rows = []
  for (const inst of targetPop) {
    const k = projCellKey(inst)
    if (k === null) continue
    const rep = dsuFind(nodeKey(con.targetObjectTypeId, k))
    const seqMatchLists = seqRepMaps.map(m => m.get(rep) ?? [])
    const hasViolation = seqMatchLists.every(m => m.length === 0)
    // Translate target identifier to LCA level (identity in C1).
    const translatedTid = (!isC1 && lcaId)
      ? (translateToLCA(con.targetObjectTypeId, k, lcaId) ?? k)
      : k
    const numRows = Math.max(1, ...seqMatchLists.map(m => m.length))
    for (let r = 0; r < numRows; r++) {
      rows.push({
        tid: inst,
        translatedTid,
        seqMatches: seqMatchLists.map(m => r < m.length ? m[r] : null),
        hasViolation,
      })
    }
  }

  return { seqCount: seqs.length, rows, isC1, piRoot, availableLCAs, lcaId }
}

/**
 * Like computeInclusiveOrTable but for Exclusive Or.
 * Each row additionally carries:
 *   hasUncoveredViolation  — no sequence covers this target instance
 *   hasOverlapViolation    — two or more sequences cover this target instance
 *   overlappingSeqs        — Set<number> of sequence indices that overlap
 *   translatedTid          — identifier translated to LCA level (bold in UI)
 *
 * Returns also: { isC1, piRoot, availableLCAs, lcaId }.
 */
export function computeExclusiveOrTable(data, constraintId, selectedLcaId = null) {
  const { facts, factPopulations, objectTypes, populations, subtypes, subtypeMappings, nestedEntityMappings, constraints } = data
  const con = (constraints || []).find(c => c.id === constraintId)
  if (!con || con.constraintType !== 'exclusiveOr') return null
  if (!con.targetObjectTypeId) return null
  const seqs = con.sequences ?? []
  if (seqs.length < 2) return null

  const seqInstanceTypeId = (seq) => {
    if (!Array.isArray(seq) || seq.length !== 1) return null
    const m = seq[0]
    if (m.kind === 'subtype') return (subtypes || []).find(s => s.id === m.subtypeId)?.subId ?? null
    if (m.kind === 'role') return (facts || []).find(f => f.id === m.factId)?.roles?.[m.roleIndex]?.objectTypeId ?? null
    return null
  }
  const seqTypeIds = seqs.map(seqInstanceTypeId).filter(Boolean)
  const allTypeIds = [con.targetObjectTypeId, ...seqTypeIds]

  const { isC1, piRoot } = checkC1ForTypes(allTypeIds, data)
  let availableLCAs = [], lcaId = null
  if (isC1) {
    availableLCAs = piRoot ? [piRoot] : []
    lcaId = piRoot
  } else {
    availableLCAs = findLCAsForTypes(allTypeIds, subtypes || [])
    lcaId = selectedLcaId ?? availableLCAs[0] ?? null
  }

  const { dsuFind, nodeKey, translateToLCA } = buildSubtypeDSU(data)

  const eft = (fact) =>
    computeEffectiveFactTuples(fact, facts || [], factPopulations || {}, objectTypes || [], populations || {}, nestedEntityMappings || {}, constraints)

  const otById = new Map((objectTypes || []).map(o => [o.id, o]))
  const playerPop = (id) => {
    const ot = otById.get(id)
    if (ot) {
      if (ot.kind === 'entity') return getEntityEffectivePopulation(id, populations || {}, facts || [], objectTypes || [], subtypes || [], subtypeMappings || {})
      if (ot.kind === 'value')  return getVtEffectivePopulation(id, populations || {}, facts || [], objectTypes || [], subtypes || [], subtypeMappings || {})
      return []
    }
    const f = (facts || []).find(ff => ff.id === id && ff.objectified)
    if (f) return nestedEntityMappings?.[id] ?? factPopulations?.[id] ?? []
    return []
  }

  const targetPop = playerPop(con.targetObjectTypeId)
  if (!targetPop || targetPop.length === 0)
    return { seqCount: seqs.length, rows: [], isC1, piRoot, availableLCAs, lcaId }

  const seqRepMaps = seqs.map(seq => {
    const repMap = new Map()
    if (!Array.isArray(seq) || seq.length !== 1) return repMap
    const m = seq[0]
    if (m.kind === 'subtype') {
      const st = (subtypes || []).find(s => s.id === m.subtypeId)
      if (!st) return repMap
      for (const v of playerPop(st.subId)) {
        const k = projCellKey(v)
        if (k === null) continue
        const rep = dsuFind(nodeKey(st.subId, k))
        if (!repMap.has(rep)) repMap.set(rep, [])
        repMap.get(rep).push(v)
      }
    } else if (m.kind === 'role' && !m.factId?.includes('_il_')) {
      const fact = (facts || []).find(f => f.id === m.factId)
      const anchorOtId = fact?.roles?.[m.roleIndex]?.objectTypeId
      if (!fact || !anchorOtId) return repMap
      const seen = new Set()
      for (const tuple of (eft(fact) ?? [])) {
        if (!Array.isArray(tuple)) continue
        const v = tuple[m.roleIndex]
        const k = projCellKey(v)
        if (k === null) continue
        const kStr = JSON.stringify(k)
        if (seen.has(kStr)) continue
        seen.add(kStr)
        const rep = dsuFind(nodeKey(anchorOtId, k))
        if (!repMap.has(rep)) repMap.set(rep, [])
        repMap.get(rep).push(v)
      }
    }
    return repMap
  })

  const rows = []
  for (const inst of targetPop) {
    const k = projCellKey(inst)
    if (k === null) continue
    const rep = dsuFind(nodeKey(con.targetObjectTypeId, k))
    const seqMatchLists = seqRepMaps.map(m => m.get(rep) ?? [])
    const covered = seqMatchLists.map((m, i) => m.length > 0 ? i : -1).filter(i => i >= 0)
    const hasUncoveredViolation = covered.length === 0
    const hasOverlapViolation   = covered.length > 1
    const overlappingSeqs = new Set(hasOverlapViolation ? covered : [])
    const translatedTid = (!isC1 && lcaId)
      ? (translateToLCA(con.targetObjectTypeId, k, lcaId) ?? k)
      : k
    const numRows = Math.max(1, ...seqMatchLists.map(m => m.length))
    for (let r = 0; r < numRows; r++) {
      rows.push({
        tid: inst,
        translatedTid,
        seqMatches: seqMatchLists.map(m => r < m.length ? m[r] : null),
        hasUncoveredViolation, hasOverlapViolation, overlappingSeqs,
      })
    }
  }

  return { seqCount: seqs.length, rows, isC1, piRoot, availableLCAs, lcaId }
}

// ── Shared base for exclusion / equality / subset population tables ──────────
// Builds Cartesian-product rows from equivalence classes.  Each row has
// { seqMatches, coveredSeqs, translatedTuple }.
//
// translatedTuple: one element per sequence position — the LCA-translated
// identifier for that position.  In C1 it equals the original key.
// Per-position C1/C2 info is returned in positionInfo[].
//
// selectedLcaIds: optional array of chosen LCA type IDs, one per position.
function _buildSetRows(data, constraintId, allowedTypes, selectedLcaIds = null) {
  const { facts, factPopulations, objectTypes, populations, subtypes, subtypeMappings, nestedEntityMappings, constraints } = data
  const con = (constraints || []).find(c => c.id === constraintId)
  if (!con || !allowedTypes.has(con.constraintType)) return null
  const seqs = con.sequences ?? []
  const queries = con.queries ?? []
  if (seqs.length < 2) return null

  const { dsuFind, nodeKey, translateToLCA } = buildSubtypeDSU(data)
  const eft = (fact) =>
    computeEffectiveFactTuples(fact, facts || [], factPopulations || {}, objectTypes || [], populations || {}, nestedEntityMappings || {}, constraints)

  const projections = seqs.map((seq, i) => {
    const qResult = evaluateQuery(queries[i] ?? null, facts, populations, eft)
    return qResult !== null ? qResult : projectSequence(seq, facts, eft)
  })
  if (projections.some(p => p === null)) return null

  // OT at position p in sequence si.
  const posOtId = (si, p) => {
    const m = (seqs[si] ?? [])[p]
    if (!m) return null
    if (m.kind === 'role') return (facts || []).find(f => f.id === m.factId)?.roles?.[m.roleIndex]?.objectTypeId ?? null
    if (m.kind === 'subtype') return (subtypes || []).find(s => s.id === m.subtypeId)?.subId ?? null
    return null
  }
  const seqLen = seqs[0]?.length ?? 0

  // Per-position C1/C2 detection and LCA selection.
  const positionInfo = Array.from({ length: seqLen }, (_, p) => {
    const otIds = seqs.map((_, si) => posOtId(si, p)).filter(Boolean)
    const { isC1, piRoot } = checkC1ForTypes(otIds, data)
    let availableLCAs = [], lcaId = null
    if (isC1) {
      availableLCAs = piRoot ? [piRoot] : []
      lcaId = piRoot
    } else {
      availableLCAs = findLCAsForTypes(otIds, subtypes || [])
      lcaId = selectedLcaIds?.[p] ?? availableLCAs[0] ?? null
    }
    return { isC1, piRoot, availableLCAs, lcaId }
  })

  const tupleClassKey = (rawV, si) => {
    const cells = Array.isArray(rawV) ? rawV : [rawV]
    const reps = cells.map((v, p) => {
      const otId = posOtId(si, p); if (!otId) return null
      const k = projCellKey(v); if (k === null) return null
      return dsuFind(nodeKey(otId, k))
    })
    return reps.some(r => r === null) ? null : JSON.stringify(reps)
  }

  const classMap = new Map()
  for (let i = 0; i < projections.length; i++) {
    for (const rawV of (projections[i]?.values ?? [])) {
      const ck = tupleClassKey(rawV, i)
      if (ck === null) continue
      if (!classMap.has(ck)) classMap.set(ck, seqs.map(() => []))
      classMap.get(ck)[i].push(rawV)
    }
  }

  const cartesian = (...arrays) =>
    arrays.reduce((acc, arr) => acc.flatMap(x => arr.map(y => [...x, y])), [[]])

  // Build translated tuple from any non-null seqMatch in the combo.
  const makeTranslatedTuple = (combo) => {
    for (let si = 0; si < combo.length; si++) {
      const v = combo[si]
      if (v === null) continue
      const cells = Array.isArray(v) ? v : [v]
      return cells.map((cell, p) => {
        const otId = posOtId(si, p)
        if (!otId) return null
        const k = projCellKey(cell)
        if (k === null) return null
        const { isC1, lcaId } = positionInfo[p] ?? {}
        if (isC1 || !lcaId) return k
        return translateToLCA(otId, k, lcaId) ?? k
      })
    }
    return null
  }

  const rows = []
  for (const seqResults of classMap.values()) {
    const factors = seqResults.map(r => r.length > 0 ? r : [null])
    for (const combo of cartesian(...factors)) {
      const coveredSeqs = new Set(combo.map((v, i) => v !== null ? i : -1).filter(i => i >= 0))
      rows.push({ seqMatches: combo, coveredSeqs, translatedTuple: makeTranslatedTuple(combo) })
    }
  }
  return { seqCount: seqs.length, rows, positionInfo }
}

/** Exclusion: violation when 2+ sequences have a result in the same equivalence class. */
export function computeExclusionTable(data, constraintId, selectedLcaIds = null) {
  const base = _buildSetRows(data, constraintId, new Set(['exclusion']), selectedLcaIds)
  if (!base) return null
  return {
    seqCount: base.seqCount,
    positionInfo: base.positionInfo,
    rows: base.rows.map(({ seqMatches, coveredSeqs, translatedTuple }) => ({
      seqMatches, translatedTuple,
      hasViolation: coveredSeqs.size >= 2,
      overlappingSeqs: coveredSeqs.size >= 2 ? coveredSeqs : new Set(),
    })),
  }
}

/** Equality: violation when any sequence has no result in the equivalence class. */
export function computeEqualityTable(data, constraintId, selectedLcaIds = null) {
  const base = _buildSetRows(data, constraintId, new Set(['equality']), selectedLcaIds)
  if (!base) return null
  return {
    seqCount: base.seqCount,
    positionInfo: base.positionInfo,
    rows: base.rows.map(({ seqMatches, coveredSeqs, translatedTuple }) => {
      const hasViolation = coveredSeqs.size < base.seqCount
      return {
        seqMatches, translatedTuple,
        hasViolation,
        uncoveredSeqs: hasViolation
          ? new Set(seqMatches.map((v, i) => v === null ? i : -1).filter(i => i >= 0))
          : new Set(),
      }
    }),
  }
}

/** Subset: violation when sequence 1 has a result but sequence 2 does not. */
export function computeSubsetTable(data, constraintId, selectedLcaIds = null) {
  const base = _buildSetRows(data, constraintId, new Set(['subset']), selectedLcaIds)
  if (!base) return null
  return {
    seqCount: base.seqCount,
    positionInfo: base.positionInfo,
    rows: base.rows.map(({ seqMatches, translatedTuple }) => ({
      seqMatches, translatedTuple,
      hasViolation: seqMatches[0] !== null && seqMatches[1] === null,
    })),
  }
}

// ── Projection helpers (module-level for reuse) ─────────────────────────────

export function projCellKey(cell) {
  if (typeof cell === 'string') {
    const t = cell.trim()
    return t === '' ? null : t
  }
  if (Array.isArray(cell)) {
    if (cell.length === 0) return null
    const out = []
    for (const c of cell) {
      const sub = projCellKey(c)
      if (sub === null) return null
      out.push(sub)
    }
    return out
  }
  return null
}

function projCellDisplay(v) {
  return Array.isArray(v) ? `(${v.map(projCellDisplay).join(', ')})` : `"${v}"`
}

function normalizeSeededRole(s) {
  return typeof s === 'number' ? { roleIndex: s, seqPosition: 0 } : s
}

function computeEffectiveFactTuples(fact, facts, factPopulations, objectTypes, populations, nestedEntityMappings, constraints) {
  // Helper: reconstruct one fact's tuple from a cross-fact PI tuple.
  // ci = index of this fact in cp.factIds; entityTuple = the entity's PI value.
  const crossFactTuple = (cp, ci, entityTuple, arity, entityRoleIdx) => {
    const out = Array(arity).fill('')
    const cell = Array.isArray(entityTuple) ? entityTuple[ci] : ''
    const idxInFact = cp.identifyingRoleIndices[ci]
    out[idxInFact] = typeof cell === 'string' ? cell : Array.isArray(cell) ? cell : ''
    if (entityRoleIdx != null) out[entityRoleIdx] = entityTuple
    return out
  }

  let isIdentifying = false
  for (const nf of (facts ?? [])) {
    if (!nf.objectified || nf.objectifiedKind === 'value' || nf.id === fact.id) continue
    const rm = findRefMode(nf, facts || [], objectTypes || [])
    if (rm && rm.factId === fact.id) { isIdentifying = true; break }
    const cp = findCompositePI(nf, facts || [], objectTypes || [], constraints)
    if (cp && (cp.factId === fact.id || cp.factIds?.includes(fact.id))) { isIdentifying = true; break }
  }
  if (!isIdentifying) {
    const direct = factPopulations?.[fact.id]
    if (direct?.length) return direct
  }
  for (const ot of (objectTypes ?? [])) {
    if (ot.kind !== 'entity') continue
    const entityPop = populations?.[ot.id]
    if (!entityPop?.length) continue
    const arity = fact.arity ?? fact.roles?.length ?? 0
    const rm = findRefMode(ot, facts || [], objectTypes || [])
    if (rm && rm.factId === fact.id) {
      return entityPop.map(v => Array.from({ length: arity },
        () => (typeof v === 'string' ? v : '')))
    }
    const cp = findCompositePI(ot, facts || [], objectTypes || [], constraints)
    if (cp && cp.factId === fact.id) {
      return entityPop.map(t => {
        const out = Array(arity).fill('')
        if (Array.isArray(t)) {
          cp.identifyingRoleIndices.forEach((ri, ci) => {
            const cell = t[ci]
            out[ri] = typeof cell === 'string' ? cell : Array.isArray(cell) ? cell : ''
          })
          if (cp.entityRoleIndex != null) out[cp.entityRoleIndex] = t
        }
        return out
      })
    }
    if (cp && cp.factIds) {
      const ci = cp.factIds.indexOf(fact.id)
      if (ci !== -1) {
        const entityRoleIdx = cp.entityRoleIndices ? cp.entityRoleIndices[ci] : cp.entityRoleIndex
        return entityPop.map(t => crossFactTuple(cp, ci, t, arity, entityRoleIdx))
      }
    }
  }
  for (const nf of (facts ?? [])) {
    if (!nf.objectified || nf.objectifiedKind === 'value') continue
    const nfPop = nestedEntityMappings?.[nf.id]
    if (!nfPop?.length) continue
    const arity = fact.arity ?? fact.roles?.length ?? 0
    const rm = findRefMode(nf, facts || [], objectTypes || [])
    if (rm && rm.factId === fact.id) {
      return nfPop.map(piVal =>
        Array.from({ length: arity }, () => (typeof piVal === 'string' ? piVal : ''))
      )
    }
    const cp = findCompositePI(nf, facts || [], objectTypes || [], constraints)
    if (cp && cp.factId === fact.id) {
      return nfPop.map(piTuple => {
        const out = Array(arity).fill('')
        if (Array.isArray(piTuple)) {
          cp.identifyingRoleIndices.forEach((ri, ci) => {
            const cell = piTuple[ci]
            out[ri] = typeof cell === 'string' ? cell : Array.isArray(cell) ? cell : ''
          })
          if (cp.entityRoleIndex != null) out[cp.entityRoleIndex] = piTuple
        }
        return out
      })
    }
    if (cp && cp.factIds) {
      const ci = cp.factIds.indexOf(fact.id)
      if (ci !== -1) {
        const entityRoleIdx = cp.entityRoleIndices ? cp.entityRoleIndices[ci] : cp.entityRoleIndex
        return nfPop.map(piTuple => crossFactTuple(cp, ci, piTuple, arity, entityRoleIdx))
      }
    }
  }
  return []
}

function evaluateQuery(query, facts, populations, effectiveFactTuplesFn, onResult) {
  if (!query) return null
  const { atoms, links } = query
  if (!atoms || atoms.length === 0) return null

  const factAtoms = atoms.filter(a => a.kind === 'fact')
  const otAtoms   = atoms.filter(a => a.kind === 'objectType')
  const stAtoms   = atoms.filter(a => a.kind === 'subtype')

  // ── A: single subtype atom → supertype population (output bound via supertype PI) ──
  if (stAtoms.length === 1 && factAtoms.length === 0) {
    const stAtom  = stAtoms[0]
    const supLink = links.find(l => l.atomId === stAtom.id && l.roleIndex === 1)
    const supOtAtom = supLink ? otAtoms.find(a => a.id === supLink.variableId) : null
    if (!supOtAtom) return null
    const subPop = populations?.[supOtAtom.originalId] ?? []
    const keys = new Set(), values = []
    for (const inst of subPop) {
      if (!isCompleteValue(inst)) continue
      const key = JSON.stringify(projCellKey(inst))
      if (!keys.has(key)) { keys.add(key); values.push(inst) }
    }
    return { keys, values }
  }

  if (factAtoms.length === 0) return null

  // Collect output positions from seeded roles across all fact atoms
  const outputPositions = []
  for (const fc of factAtoms) {
    for (const s of (fc.seededRoles ?? []).map(normalizeSeededRole)) {
      if (s.seqPosition != null)
        outputPositions.push({ fcId: fc.id, roleIndex: s.roleIndex, seqPosition: s.seqPosition })
    }
  }
  outputPositions.sort((a, b) => a.seqPosition - b.seqPosition)

  // ── B: seeded-role outputs — general nested-loop join ─────────────────
  if (outputPositions.length > 0) {
    const fcLinks = new Map()
    for (const lk of links) {
      if (!fcLinks.has(lk.atomId)) fcLinks.set(lk.atomId, [])
      fcLinks.get(lk.atomId).push(lk)
    }

    const fcRows = new Map()
    for (const fc of factAtoms) {
      const fact = (facts || []).find(f => f.id === fc.originalId)
      if (!fact) return null
      fcRows.set(fc.id, effectiveFactTuplesFn(fact) ?? [])
    }

    const results = new Map()
    const resultCounts = new Map()

    const enumerate = (fcIdx, varAssign, rowAssign) => {
      if (fcIdx === factAtoms.length) {
        const tuple = outputPositions.map(op => {
          const row = rowAssign.get(op.fcId)
          return Array.isArray(row) ? row[op.roleIndex] : null
        })
        if (tuple.some(v => v == null || projCellKey(v) === null)) return
        const norms  = tuple.map(projCellKey)
        const normVal = norms.length === 1 ? norms[0] : norms
        const rawVal  = tuple.length === 1 ? tuple[0] : tuple
        const key = JSON.stringify(normVal)
        resultCounts.set(key, (resultCounts.get(key) ?? 0) + 1)
        if (!results.has(key)) results.set(key, rawVal)
        if (onResult) onResult(varAssign)
        return
      }
      const fc = factAtoms[fcIdx]
      const myLinks = fcLinks.get(fc.id) ?? []
      for (const row of (fcRows.get(fc.id) ?? [])) {
        if (!Array.isArray(row)) continue
        let ok = true
        const newVar = new Map(varAssign)
        for (const lk of myLinks) {
          const v = row[lk.roleIndex]; const norm = projCellKey(v)
          if (norm === null) { ok = false; break }
          const nk = JSON.stringify(norm)
          if (newVar.has(lk.variableId)) {
            if (newVar.get(lk.variableId) !== nk) { ok = false; break }
          } else {
            newVar.set(lk.variableId, nk)
          }
        }
        if (!ok) continue
        const newRow = new Map(rowAssign)
        newRow.set(fc.id, row)
        enumerate(fcIdx + 1, newVar, newRow)
      }
    }

    enumerate(0, new Map(), new Map())
    return { keys: new Set(results.keys()), values: [...results.values()], counts: new Map(resultCounts) }
  }

  // ── C: legacy — single isOutput OT atom, intersection across fact atoms
  const outputOtAtoms = otAtoms.filter(a => a.isOutput)
  if (outputOtAtoms.length !== 1 || stAtoms.length > 0) return null
  const targetAtom = outputOtAtoms[0]
  const factSets = factAtoms.map(fc => {
    const link = links.find(l => l.atomId === fc.id && l.variableId === targetAtom.id)
    if (!link) return null
    const fact = (facts || []).find(f => f.id === fc.originalId)
    if (!fact) return null
    const rows = effectiveFactTuplesFn(fact)
    const set = new Map()
    for (const row of rows) {
      if (!Array.isArray(row)) continue
      const v = row[link.roleIndex]; const norm = projCellKey(v)
      if (norm === null) continue
      const key = JSON.stringify(norm)
      if (!set.has(key)) set.set(key, v)
    }
    return set
  })
  if (factSets.some(s => s === null)) return null
  let common = new Map(factSets[0])
  for (let i = 1; i < factSets.length; i++) {
    for (const key of [...common.keys()]) {
      if (!factSets[i].has(key)) common.delete(key)
    }
  }
  return { keys: new Set(common.keys()), values: [...common.values()] }
}

/**
 * Direct role-projection fallback for a constraint sequence (no query).
 * Returns { keys, values } or null when projection is impossible (cross-fact
 * roles without a query).
 */
function projectSequence(seq, facts, effectiveFactTuplesFn) {
  const members = (seq || []).filter(m => m.kind === 'role' && !m.factId?.includes('_il_'))
  if (members.length === 0) return null
  const uniqueFacts = [...new Set(members.map(m => m.factId))]
  const sameFact = uniqueFacts.length === 1
  if (!sameFact && members.length > 1) return null
  const keys = new Set(), values = []
  if (sameFact) {
    const fact = (facts || []).find(f => f.id === uniqueFacts[0])
    if (!fact) return null
    const tuples = effectiveFactTuplesFn(fact)
    const roleIdxs = members.map(m => m.roleIndex)
    for (const tuple of tuples) {
      if (!Array.isArray(tuple)) continue
      const cells = roleIdxs.map(ri => tuple[ri])
      const norms = cells.map(c => projCellKey(c))
      if (norms.some(n => n === null)) continue
      const normVal = norms.length === 1 ? norms[0] : norms
      const rawVal  = cells.length === 1 ? cells[0] : cells
      const key = JSON.stringify(normVal)
      if (!keys.has(key)) { keys.add(key); values.push(rawVal) }
    }
  } else {
    const { factId, roleIndex } = members[0]
    const fact = (facts || []).find(f => f.id === factId)
    if (!fact) return null
    const tuples = effectiveFactTuplesFn(fact)
    for (const tuple of tuples) {
      if (!Array.isArray(tuple)) continue
      const cell = tuple[roleIndex]
      const norm = projCellKey(cell)
      if (norm === null) continue
      const key = JSON.stringify(norm)
      if (!keys.has(key)) { keys.add(key); values.push(cell) }
    }
  }
  return { keys, values }
}

/**
 * Compute per-sequence projections for an exclusion, equality, or subset
 * constraint.  Each sequence is evaluated via its query (if available) or
 * via direct role-projection fallback.
 * Returns { projections: [{ keys, values, query }], seqCount } or null if
 * the constraint cannot be evaluated.
 */
export function computeSequenceProjections(data, constraintId) {
  const { facts, factPopulations, objectTypes, populations, subtypes, subtypeMappings, nestedEntityMappings, constraints } = data
  const con = (constraints || []).find(c => c.id === constraintId)
  if (!con || !['exclusion', 'equality', 'subset', 'inclusiveOr', 'exclusiveOr'].includes(con.constraintType)) return null
  const seqs = con.sequences ?? []
  if (seqs.length < 2) return null

  const eft = (fact) =>
    computeEffectiveFactTuples(fact, facts || [], factPopulations || {}, objectTypes || [], populations || [], nestedEntityMappings || {}, constraints)
  const queries = con.queries ?? []

  const projections = seqs.map((seq, i) => {
    const qResult = evaluateQuery(queries[i] ?? null, facts, populations, eft)
    const proj = qResult !== null ? qResult : projectSequence(seq, facts, eft)
    return proj ? { keys: proj.keys, values: proj.values, query: qResult !== null } : null
  })

  if (projections.some(p => p === null)) return null
  return { projections, seqCount: seqs.length }
}

/**
 * Compute paired role-value data for a value-comparison constraint.
 * Evaluates the binary relation defined by the constraint's query (or by
 * direct same-fact projection when no query is present) and checks each pair
 * against the declared operator.
 * Returns { operator, mode, pairs, label0, label1 } where pairs is an array of
 * { v1, v2, violates } objects, or null if the constraint is not valueComparison.
 * mode is 'query' | 'same-fact' | 'unsupported'.
 */
export function computeValueComparisonData(data, constraintId) {
  const { facts, factPopulations, objectTypes, populations, nestedEntityMappings, constraints } = data
  const con = (constraints || []).find(c => c.id === constraintId)
  if (!con || con.constraintType !== 'valueComparison') return null
  const seqs = con.sequences ?? []
  const op = con.operator ?? '='
  const seq = seqs[0]
  if (!Array.isArray(seq) || seq.length < 2) return { operator: op, mode: 'unsupported', pairs: null }
  const roleMembers = seq.filter(m => m.kind === 'role' && !m.factId?.includes('_il_'))
  if (roleMembers.length !== 2) return { operator: op, mode: 'unsupported', pairs: null }
  const r0 = roleMembers[0]
  const r1 = roleMembers[1]

  const eft = (fact) =>
    computeEffectiveFactTuples(fact, facts || [], factPopulations || {}, objectTypes || [], populations || {}, nestedEntityMappings || {}, constraints)

  // Query-based evaluation: the query defines the binary relation to check.
  const query = (con.queries ?? [])[0] ?? null
  if (query) {
    const qResult = evaluateQuery(query, facts || [], populations || {}, eft)
    if (qResult) {
      const pairs = []
      for (const rawVal of qResult.values) {
        if (!Array.isArray(rawVal) || rawVal.length < 2) continue
        const v1 = typeof rawVal[0] === 'string' ? rawVal[0].trim() : String(rawVal[0] ?? '')
        const v2 = typeof rawVal[1] === 'string' ? rawVal[1].trim() : String(rawVal[1] ?? '')
        pairs.push({ v1, v2, violates: !cmpValues(v1, v2, op) })
      }
      let label0 = 'Position 1', label1 = 'Position 2'
      if (r0.factId === r1.factId) {
        const fact = (facts || []).find(f => f.id === r0.factId)
        label0 = fact?.roles?.[r0.roleIndex]?.roleName?.trim() || `Role ${r0.roleIndex + 1}`
        label1 = fact?.roles?.[r1.roleIndex]?.roleName?.trim() || `Role ${r1.roleIndex + 1}`
      }
      return { operator: op, mode: 'query', pairs, label0, label1 }
    }
  }

  // Fallback: direct same-fact projection (no query defined yet).
  if (r0.factId !== r1.factId) return { operator: op, mode: 'unsupported', pairs: null }
  const fact = (facts || []).find(f => f.id === r0.factId)
  if (!fact) return { operator: op, mode: 'unsupported', pairs: null }
  const tuples = eft(fact) ?? []
  const pairs = tuples.map((tuple, ti) => {
    const v1 = typeof tuple?.[r0.roleIndex] === 'string' ? tuple[r0.roleIndex].trim() : ''
    const v2 = typeof tuple?.[r1.roleIndex] === 'string' ? tuple[r1.roleIndex].trim() : ''
    return { v1, v2, violates: !cmpValues(v1, v2, op), tupleIndex: ti }
  })
  const label0 = fact.roles?.[r0.roleIndex]?.roleName?.trim() || `Role ${r0.roleIndex + 1}`
  const label1 = fact.roles?.[r1.roleIndex]?.roleName?.trim() || `Role ${r1.roleIndex + 1}`
  return { operator: op, mode: 'same-fact', pairs, label0, label1 }
}

/**
 * Compute the binary relation that a ring constraint evaluates.
 *
 * C1: both role player types share the same PI root → table shows 2 columns.
 * C2: different PI roots → table shows 4 columns with translations (bold).
 *
 * Returns {
 *   pairs: [{ a, b, aKey, bKey, aTranslated, bTranslated }],
 *   ringTypes, query,
 *   isC1, piRoot, availableLCAs, lcaId, leftOtId, rightOtId
 * } or null.
 */
export function computeRingConstraintRelation(data, constraintId, selectedLcaId = null) {
  const { facts, factPopulations, objectTypes, populations, subtypes, subtypeMappings, nestedEntityMappings, constraints } = data
  const con = (constraints || []).find(c => c.id === constraintId)
  if (!con || con.constraintType !== 'ring') return null
  const ringTypes = con.ringTypes ?? []
  if (ringTypes.length === 0) return null
  const seqs = con.sequences ?? []
  if (seqs.length === 0) return null
  const seq = seqs[0]
  if (!Array.isArray(seq) || seq.length < 2) return null
  const roleMembers = seq.filter(m => m.kind === 'role')
  const leftRef  = roleMembers[0]
  const rightRef = roleMembers[1]
  if (!leftRef || !rightRef) return null

  const leftOtId  = (facts || []).find(f => f.id === leftRef.factId)?.roles?.[leftRef.roleIndex]?.objectTypeId ?? null
  const rightOtId = (facts || []).find(f => f.id === rightRef.factId)?.roles?.[rightRef.roleIndex]?.objectTypeId ?? null

  const { isC1, piRoot } = checkC1ForTypes([leftOtId, rightOtId].filter(Boolean), data)
  let availableLCAs = [], lcaId = null
  if (isC1) {
    availableLCAs = piRoot ? [piRoot] : []
    lcaId = piRoot
  } else {
    availableLCAs = findLCAsForTypes([leftOtId, rightOtId].filter(Boolean), subtypes || [])
    lcaId = selectedLcaId ?? availableLCAs[0] ?? null
  }

  const { translateToLCA } = buildSubtypeDSU(data)

  const eft = (fact) =>
    computeEffectiveFactTuples(fact, facts || [], factPopulations || {}, objectTypes || [], populations || {}, nestedEntityMappings || {}, constraints)

  const relMap = new Map()
  const query = (con.queries ?? [])[0] ?? null
  let qResult = null

  if (query) {
    qResult = evaluateQuery(query, facts, populations, eft)
    if (qResult) {
      for (const rawVal of qResult.values) {
        if (!Array.isArray(rawVal) || rawVal.length < 2) continue
        const aNorm = projCellKey(rawVal[0])
        const bNorm = projCellKey(rawVal[1])
        if (aNorm === null || bNorm === null) continue
        const aKey = JSON.stringify(aNorm)
        const bKey = JSON.stringify(bNorm)
        const k = JSON.stringify([aKey, bKey])
        if (!relMap.has(k)) relMap.set(k, { a: rawVal[0], b: rawVal[1], aNorm, bNorm, aKey, bKey })
      }
    }
  } else if (leftRef.factId === rightRef.factId) {
    const fact = (facts || []).find(f => f.id === leftRef.factId)
    if (fact) {
      for (const tuple of (eft(fact) ?? [])) {
        if (!Array.isArray(tuple)) continue
        const aNorm = projCellKey(tuple[leftRef.roleIndex])
        const bNorm = projCellKey(tuple[rightRef.roleIndex])
        if (aNorm === null || bNorm === null) continue
        const aKey = JSON.stringify(aNorm)
        const bKey = JSON.stringify(bNorm)
        const k = JSON.stringify([aKey, bKey])
        if (!relMap.has(k)) relMap.set(k, { a: tuple[leftRef.roleIndex], b: tuple[rightRef.roleIndex], aNorm, bNorm, aKey, bKey })
      }
    }
  }

  const pairs = [...relMap.values()].map(p => ({
    a: p.a, b: p.b, aKey: p.aKey, bKey: p.bKey,
    aTranslated: (!isC1 && lcaId && leftOtId)  ? (translateToLCA(leftOtId,  p.aNorm, lcaId) ?? p.aNorm) : p.aNorm,
    bTranslated: (!isC1 && lcaId && rightOtId) ? (translateToLCA(rightOtId, p.bNorm, lcaId) ?? p.bNorm) : p.bNorm,
  }))

  return {
    pairs,
    query: query ? { present: true, result: qResult ?? undefined } : null,
    ringTypes,
    isC1, piRoot, availableLCAs, lcaId, leftOtId, rightOtId,
  }
}

/**
 * Compute the projected values for an external uniqueness constraint.
 * Returns { entries, violations, roleCount } or null if the constraint
 * is not an external uniqueness or lacks the required structure.
 * Each entry is { values, norms, count }.
 * Violations are entries with count > 1.
 */
export function computeUniquenessProjection(data, constraintId) {
  const { facts, factPopulations, objectTypes, populations, subtypes, subtypeMappings, nestedEntityMappings, constraints } = data
  const con = (constraints || []).find(c => c.id === constraintId)
  if (!con || (con.constraintType !== 'uniqueness' && con.constraintType !== 'frequency')) return null
  const seqs = con.sequences ?? []
  if (seqs.length === 0) return null
  const seq = seqs[0]
  if (!Array.isArray(seq) || seq.length === 0) return null
  const roleMembers = seq.filter(m => m.kind === 'role' && !m.factId?.includes('_il_'))
  if (roleMembers.length === 0) return null

  const eft = (fact) =>
    computeEffectiveFactTuples(fact, facts || [], factPopulations || {}, objectTypes || [], populations || {}, nestedEntityMappings || {}, constraints)

  // Try query-based evaluation first (handles cross-fact joins via the target OT)
  const query = (con.queries ?? [])[0] ?? null
  let queryResult = null
  let entries, totalTuples

  if (query) {
    queryResult = evaluateQuery(query, facts, populations, eft)
    if (queryResult) {
      const raw = []
      for (const rawVal of queryResult.values) {
        const vals = Array.isArray(rawVal) ? rawVal : [rawVal]
        const norms = vals.map(projCellKey)
        if (norms.some(n => n === null)) continue
        const key = JSON.stringify(norms)
        const count = queryResult.counts?.get(key) ?? 1
        raw.push({ values: vals, norms, count })
      }
      entries = raw.sort((a, b) => b.count - a.count)
      totalTuples = [...queryResult.counts?.values() ?? []].reduce((s, c) => s + c, 0)
    }
  }

  // Fallback: direct role projection — only valid when all roles are on the
  // same fact (composite-key check).  Cross-fact role sets require a query.
  if (!entries) {
    const uniqueFacts = new Set(roleMembers.map(m => m.factId))
    if (uniqueFacts.size === 1) {
      const factId = roleMembers[0].factId
      const fact = (facts || []).find(f => f.id === factId)
      if (fact) {
        const riList = roleMembers.map(m => m.roleIndex)
        const projected = []
        for (const tuple of (eft(fact) ?? [])) {
          if (!Array.isArray(tuple)) continue
          const values = riList.map(ri => tuple[ri])
          const norms = values.map(projCellKey)
          if (norms.some(n => n === null)) continue
          projected.push({ values, norms })
        }
        const counts = new Map()
        for (const { values, norms } of projected) {
          const key = JSON.stringify(norms)
          if (!counts.has(key)) counts.set(key, { values, norms, count: 0 })
          counts.get(key).count++
        }
        entries = [...counts.values()].sort((a, b) => b.count - a.count)
        totalTuples = projected.length
      }
    }
    // When cross-fact and no query, entries stays undefined → viewer shows
    // "No projection data" message.
    if (!entries) entries = []; totalTuples = 0
  }

  const violations = entries.filter(e => e.count > 1)
  return {
    entries,
    violations,
    roleCount: roleMembers.length,
    totalTuples,
    queryUsed: !!query,
  }
}

// ── Value range comparison helpers ─────────────────────────────────────────

/**
 * Compare two values in a type-aware manner.
 * Returns a negative number if a < b, positive if a > b, 0 if equal, or NaN
 * when comparison is impossible (non-comparable types, empty values, etc.).
 */
function compareValues(a, b, typeKind) {
  if (a === '' || b === '' || a == null || b == null) return NaN

  if (typeKind === 'integer' || typeKind === 'decimal') {
    const na = Number(a); const nb = Number(b)
    return (Number.isFinite(na) && Number.isFinite(nb)) ? na - nb : NaN
  }

  if (typeKind === 'date' || typeKind === 'datetime') {
    // ISO format sorts lexicographically correctly
    return a.localeCompare(b)
  }

  // No declared type or text: try numeric first, then date, then lexicographic
  const na = Number(a); const nb = Number(b)
  if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb
  if (/^\d{4}-\d{2}-\d{2}$/.test(a) && /^\d{4}-\d{2}-\d{2}$/.test(b)) return a.localeCompare(b)
  return a.localeCompare(b)
}

/** True when the spec's constraint is trivially satisfied (bound is empty). */
function boundOpen(v) { return v === '' || v == null }

/** Check if a single range spec accepts the given value. */
function specSatisfies(value, spec, typeKind) {
  if (!spec) return false
  if (value === '' || value == null) return false

  if (spec.type === 'single') {
    const cmp = compareValues(value, spec.value, typeKind)
    return Number.isFinite(cmp) && cmp === 0
  }
  if (spec.type === 'lower') {
    return boundOpen(spec.lower) || (() => {
      const cmp = compareValues(value, spec.lower, typeKind)
      return Number.isFinite(cmp) && cmp >= 0
    })()
  }
  if (spec.type === 'upper') {
    return boundOpen(spec.upper) || (() => {
      const cmp = compareValues(value, spec.upper, typeKind)
      return Number.isFinite(cmp) && cmp <= 0
    })()
  }
  if (spec.type === 'range') {
    const lo = boundOpen(spec.lower) || (() => {
      const cmp = compareValues(value, spec.lower, typeKind)
      return Number.isFinite(cmp) && cmp >= 0
    })()
    const hi = boundOpen(spec.upper) || (() => {
      const cmp = compareValues(value, spec.upper, typeKind)
      return Number.isFinite(cmp) && cmp <= 0
    })()
    return lo && hi
  }
  return false
}

/** True when `value` satisfies at least one spec in the value range (OR semantics). */
function valueInRange(value, range, typeKind) {
  if (!range || range.length === 0) return true
  return range.some(spec => specSatisfies(value, spec, typeKind))
}
