import { create } from 'zustand'
import { EXTERNAL_CONSTRAINT_TYPES } from '../constants.js'
import { constraintMaxSequences, isSingletonSequence, isOpenEndedConstruction } from '../utils/constraintRules.js'
import { runValidation as runValidationRules, DEFAULT_VALIDATION_CATEGORIES } from '../utils/validation.js'
import { computePopulationIssues } from '../utils/populationValidation.js'
import { findRefMode, refModeLabel, vtNameFromLabel, isRefModeFact, isIdentifyingFact, findCompositePI, findInheritedPI, getEntityEffectivePopulation, getVtEffectivePopulation, getEntityIdentifierShape, getRoleCellShape, propagateValueToPlayer, isCompleteValue, findRolePlayer } from '../utils/refMode.js'

// ── pan animation ─────────────────────────────────────────────────────────────
let _panAnimId = null

// ── id generator ──────────────────────────────────────────────────────────────
let _n = 1
const uid = () => `n${Date.now()}_${_n++}`

// ── default constructors ──────────────────────────────────────────────────────

const mkEntity = (x, y) => ({
  id: uid(), kind: 'entity',
  name: 'Entity', x, y,
  isPersonal: false,  // describes persons → enables personal pronouns in verbalisation
  valueRangeOffset: null,
  datatypeAssignment: null,  // { profileId, datatypeId, params? } | null
})

const mkValue = (x, y) => ({
  id: uid(), kind: 'value',
  name: 'Value', x, y,
  valueRangeOffset: null,
  datatypeAssignment: null,  // { profileId, datatypeId, params? } | null
})

const mkRole = () => ({
  id: uid(), objectTypeId: null, roleName: '', mandatory: false,
  linkReadingParts: ['', '', ''],
  linkReadingReverseParts: null,
})

// Returns the smallest positive integer not already used in any fact reading.
function nextRelationNumber(facts) {
  const used = new Set()
  const re = /^has relation(\d+)/
  for (const f of facts) {
    for (const p of (f.readingParts || [])) {
      const m = re.exec(p?.trim() || ''); if (m) used.add(Number(m[1]))
    }
    for (const alt of (f.alternativeReadings || [])) {
      for (const p of (alt.parts || [])) {
        const m = re.exec(p?.trim() || ''); if (m) used.add(Number(m[1]))
      }
    }
  }
  let n = 1; while (used.has(n)) n++; return n
}

function defaultReadingParts(arity, n) {
  const parts = Array(arity + 1).fill('')
  parts[1] = arity === 2 ? `has relation${n} with` : `has relation${n}`
  return parts
}

const mkFact = (x, y, arity = 2) => ({
  id: uid(), kind: 'fact',
  x, y, arity,
  roles: Array.from({ length: arity }, mkRole),
  readingParts: null,
  alternativeReadings: [],
  readingDisplay: 'forward',
  shownReadingOrder: null,
  uniqueness: [],
  preferredUniqueness: [],
  internalFrequency: [],
  orientation: 'horizontal',
  readingOffsetAbove: null,
  readingOffsetBelow: null,
  readingAbove: false,
  uniquenessBelow: false,
  implicitLinks: [], // [{ roleIndex, x, y, readingParts, alternativeReadings, readingDisplay, orientation, readingOffsetAbove, readingOffsetBelow, readingAbove, uniquenessBelow, preferredUniqueness, roleNames }]
})

const mkImplicitLink = (roleIndex) => ({
  roleIndex, x: null, y: null,
  readingParts: ['', 'involves', ''],
  alternativeReadings: [{ roleOrder: [1, 0], parts: ['', 'is involved in', ''] }],
  readingDisplay: 'forward', orientation: 'horizontal',
  readingOffsetAbove: null, readingOffsetBelow: null, readingAbove: false,
  uniquenessBelow: false, preferredUniqueness: false, roleNames: [null, null],
})

const mkSubtype = (subId, superId) => ({
  id: uid(), kind: 'subtype',
  subId, superId,
  inheritsPreferredIdentifier: true,
})

// Returns 'entity' | 'value' | null for any subtype endpoint id.
// Entity types are disjoint from value types, so subtype edges must connect
// same-kind endpoints (entity↔entity or value↔value).
export function subtypeKindOf(id, objectTypes, facts) {
  const ot = objectTypes.find(o => o.id === id)
  if (ot) return ot.kind === 'value' ? 'value' : 'entity'
  const f = facts.find(ff => ff.id === id)
  if (f?.objectified) return f.objectifiedKind === 'value' ? 'value' : 'entity'
  return null
}


const mkConstraint = (type, x, y) => ({
  id: uid(), kind: 'constraint',
  constraintType: type,
  x, y,
  // subtype-like constraints use sequences; others use roleSequences
  sequences:     EXTERNAL_CONSTRAINT_TYPES.has(type) ? [] : undefined,
  queries:       EXTERNAL_CONSTRAINT_TYPES.has(type) ? [] : undefined,
  roleSequences: EXTERNAL_CONSTRAINT_TYPES.has(type) ? undefined : [[], []],
  // inclusiveOr / exclusiveOr / uniqueness / frequency / valueComparison can optionally reference a target object type
  targetObjectTypeId: (type === 'inclusiveOr' || type === 'exclusiveOr' || type === 'uniqueness' || type === 'frequency' || type === 'valueComparison') ? null : undefined,
  operator: type === 'valueComparison' ? '=' : undefined,
  // external uniqueness: preferred identifier flag
  isPreferredIdentifier: type === 'uniqueness' ? false : undefined,
  ringTypes: type === 'ring' ? [] : undefined,
  frequency: null,
  exhaustive: true,
  exclusive: false,
  subtypeIds: [],
})

// ── occurrence helpers ─────────────────────────────────────────────────────────
const mkOcc = (schemaElementId, x, y, extra = {}) =>
  ({ id: `occ_${uid()}`, schemaElementId, x: Math.round(x), y: Math.round(y), ...extra })

const occOf    = (diag, elementId)        => diag.occurrences?.find(o => o.schemaElementId === elementId)
const inDiag   = (diag, elementId)        => diag.occurrences?.some(o => o.schemaElementId === elementId) ?? false
const patchOcc = (diag, elementId, patch) => ({
  ...diag,
  occurrences: (diag.occurrences ?? []).map(o =>
    o.schemaElementId === elementId ? { ...o, ...patch } : o
  ),
})
const addOccIfAbsent = (diag, elementId, x, y, extra = {}) =>
  inDiag(diag, elementId) ? diag : { ...diag, occurrences: [...(diag.occurrences ?? []), mkOcc(elementId, x, y, extra)] }

// For each occurrence of `ownerId`, add owned VT/FT occurrences that are hidden until the
// owner is expanded. Each owner occurrence gets its own fresh VT occurrence (no sharing
// between ref modes by default). vtRoleIndex is used to wire roleOccurrenceMap on the FT
// occurrence so role connectors find the right VT occurrence when multiple VT occs exist.
const addOwnedRefModeOccsIfAbsent = (diag, ownerId, vtId, vtX, vtY, ftId, ftX, ftY, vtRoleIndex = null) => {
  const allOccs = diag.occurrences ?? []
  const ownerOccs = allOccs.filter(o => o.schemaElementId === ownerId)
  if (ownerOccs.length === 0) return diag
  const extraOccs = ownerOccs.flatMap(ownerOcc => {
    // Check per-owner-occurrence: each owner occ gets its own VT/FT pair.
    const hasOwnedVt = allOccs.some(o => o.schemaElementId === vtId && o.refModeOwnerOccId === ownerOcc.id)
    const hasOwnedFt = allOccs.some(o => o.schemaElementId === ftId && o.refModeOwnerOccId === ownerOcc.id)
    if (hasOwnedVt && hasOwnedFt) return []
    const newOccs = []
    let vtOccId = hasOwnedVt
      ? allOccs.find(o => o.schemaElementId === vtId && o.refModeOwnerOccId === ownerOcc.id)?.id ?? null
      : null
    if (!hasOwnedVt) {
      // Place each owned VT/FT occurrence at the standard ref-mode offsets from its owner
      // occurrence, not at the schema VT/FT coordinates (which are anchored to the first entity
      // that created them and would cause all subsequent expansions to overlap).
      const vtOcc = mkOcc(vtId, ownerOcc.x + 160, ownerOcc.y, { refModeOwnerOccId: ownerOcc.id })
      vtOccId = vtOcc.id
      newOccs.push(vtOcc)
    }
    if (!hasOwnedFt) {
      const ftExtra = { refModeOwnerOccId: ownerOcc.id }
      if (vtRoleIndex !== null && vtOccId) {
        ftExtra.roleOccurrenceMap = {
          [String(1 - vtRoleIndex)]: ownerOcc.id,
          [String(vtRoleIndex)]: vtOccId,
        }
      }
      newOccs.push(mkOcc(ftId, ownerOcc.x + 80, ownerOcc.y, ftExtra))
    }
    return newOccs
  })
  if (extraOccs.length === 0) return diag
  return { ...diag, occurrences: [...(diag.occurrences ?? []), ...extraOccs] }
}
const rmOcc = (diag, elementId) => ({
  ...diag,
  occurrences: (diag.occurrences ?? []).filter(o => o.schemaElementId !== elementId),
})

// Patch occurrence by its own ID (not schema element ID) — needed for multi-occurrence drag
const patchOccById = (diag, occId, patch) => ({
  ...diag,
  occurrences: (diag.occurrences ?? []).map(o => o.id === occId ? { ...o, ...patch } : o),
})

// Build an initial roleOccurrenceMap for a fact given the occurrences in a diagram.
// Maps role index (string) → occurrence ID of the first matching OT occurrence.
const buildRoleOccurrenceMap = (fact, occurrences) => {
  const map = {}
  for (let i = 0; i < (fact.roles ?? []).length; i++) {
    const r = fact.roles[i]
    if (!r.objectTypeId) continue
    const occ = occurrences.find(o => o.schemaElementId === r.objectTypeId)
    if (occ) map[String(i)] = occ.id
  }
  return map
}

// Constraint-occurrence helpers (constraintOccurrences is separate from occurrences)
const mkConstraintOcc = (schemaConstraintId, x, y) =>
  ({ id: `cocc_${uid()}`, schemaConstraintId, x: Math.round(x), y: Math.round(y), roleOccurrenceRefs: {}, queryOccurrenceRefs: {} })
const cOccOf    = (diag, cId) => (diag.constraintOccurrences ?? []).find(co => co.schemaConstraintId === cId)
const cInDiag   = (diag, cId) => (diag.constraintOccurrences ?? []).some(co => co.schemaConstraintId === cId)
const patchCOcc = (diag, cId, patch) => ({
  ...diag,
  constraintOccurrences: (diag.constraintOccurrences ?? []).map(co =>
    co.schemaConstraintId === cId ? { ...co, ...patch } : co
  ),
})
const patchCOccById = (diag, cOccId, patch) => ({
  ...diag,
  constraintOccurrences: (diag.constraintOccurrences ?? []).map(co =>
    co.id === cOccId ? { ...co, ...patch } : co
  ),
})
const addCOccIfAbsent = (diag, cId, x, y) =>
  cInDiag(diag, cId) ? diag : { ...diag, constraintOccurrences: [...(diag.constraintOccurrences ?? []), mkConstraintOcc(cId, x, y)] }
const rmCOcc = (diag, cId) => ({
  ...diag,
  constraintOccurrences: (diag.constraintOccurrences ?? []).filter(co => co.schemaConstraintId !== cId),
})

// Normalize subtypeEndpointOccs value to always be an array.
// Handles migration from the old single-object format { subOccId, superOccId }.
const normalizeStEps = (raw) => {
  if (!raw) return []
  return Array.isArray(raw) ? raw : [raw]
}

// Returns a canonical fingerprint for a constraint occurrence's roleOccurrenceRefs,
// used to detect duplicate combinations when allowing multiple constraint occurrences.
const roleOccRefsKey = (refs) => {
  const r = refs && !Array.isArray(refs) ? refs : {}
  return Object.entries(r).sort((a, b) => a[0].localeCompare(b[0])).map(([k, v]) => `${k}:${v}`).join('|')
}

const mkDiagram = (name = 'Main') => ({ id: uid(), name, occurrences: [], constraintOccurrences: [], implicitLinkPositions: {}, multiSelectedIds: [], profileId: null, shownImplicitLinks: [], notes: [], expandedRefModes: [], expandedRefModeOccs: [], subtypeOccurrences: [], subtypeEndpointOccs: {} })
const mkNote    = (x, y)          => ({ id: uid(), x: Math.round(x), y: Math.round(y), w: 160, h: 100, text: '', connectors: [] })

// ── name uniqueness ───────────────────────────────────────────────────────────
// Strip trailing digits → find smallest N ≥ 1 such that base+N ∉ usedNames.
function makeUniqueName(originalName, usedNames) {
  const m = originalName.match(/^(.*?)(\d+)$/)
  const base = m ? m[1] : originalName
  let n = 1
  while (usedNames.has(`${base}${n}`)) n++
  return `${base}${n}`
}

// ── orphaned constraint purge ─────────────────────────────────────────────────
// After diagram-level removals, delete any constraints that are no longer present
// in any diagram (show-all diagrams always count as containing every constraint).
function purgeOrphanedConstraints(diagrams, constraints) {
  if (!constraints.length) return constraints
  const inAnyDiagram = (id) => diagrams.some(d => cInDiag(d, id))
  const kept = constraints.filter(c => inAnyDiagram(c.id))
  return kept.length === constraints.length ? constraints : kept
}

// ── principle 3 closure ───────────────────────────────────────────────────────
// For every fact (or objectified fact) in the seed set, transitively add all
// role-player object types / objectified facts.  This ensures that any diagram
// (or clipboard) that contains a fact also contains all the OTs it references.
function closeUnderPrinciple3(seedIds, { facts, objectTypes }) {
  const result = new Set(seedIds)
  let changed = true
  while (changed) {
    changed = false
    for (const f of facts) {
      if (!result.has(f.id)) continue
      for (const r of f.roles) {
        if (!r.objectTypeId || result.has(r.objectTypeId)) continue
        const exists =
          objectTypes.some(o => o.id === r.objectTypeId) ||
          facts.some(f2 => f2.id === r.objectTypeId && f2.objectified)
        if (exists) { result.add(r.objectTypeId); changed = true }
      }
    }
  }
  return result
}

// ── cascade removal ───────────────────────────────────────────────────────────
// When an OT (or objectified fact acting as an OT) is removed from a diagram,
// every fact that has it as a role player must also be removed, recursively.
// Objectified facts are referenced by their fact.id as objectTypeId in other roles.
function computeCascadeRemove(startId, facts) {
  const toRemove = new Set([startId])
  const queue = [startId]
  while (queue.length > 0) {
    const id = queue.shift()
    for (const fact of facts) {
      if (toRemove.has(fact.id)) continue
      if (fact.roles.some(r => r.objectTypeId === id)) {
        toRemove.add(fact.id)
        queue.push(fact.id)
      }
    }
  }
  return toRemove
}

// ── preferred-identifier helpers ──────────────────────────────────────────────

// Given a fact and one of its preferred-uniqueness role-sets, return the id of
// the (nested) object type identified by it: the player at the single role NOT
// covered by the PI. Returns null when the role-set isn't a valid PI shape.
function identifiedIdForInternalPI(fact, pu) {
  if (!fact || !Array.isArray(pu)) return null
  if (pu.length !== (fact.arity - 1)) return null
  const covered = new Set(pu)
  for (let ri = 0; ri < fact.arity; ri++) {
    if (!covered.has(ri)) return fact.roles?.[ri]?.objectTypeId ?? null
  }
  return null
}

// Demote every OTHER preferred identifier that targets the same identified id.
// exceptFactId / exceptConstraintId are the source of the new PI (not demoted).
// Returns updated { facts, constraints }.
function demoteOtherPIsFor(identifiedId, facts, constraints, exceptFactId, exceptConstraintId) {
  if (!identifiedId) return { facts, constraints }
  const newFacts = facts.map(f => {
    if (f.id === exceptFactId) return f
    const prefs = f.preferredUniqueness || []
    if (prefs.length === 0) return f
    const filtered = prefs.filter(pu => identifiedIdForInternalPI(f, pu) !== identifiedId)
    if (filtered.length === prefs.length) return f
    return { ...f, preferredUniqueness: filtered }
  })
  const newConstraints = constraints.map(c => {
    if (c.id === exceptConstraintId) return c
    if (c.constraintType !== 'uniqueness') return c
    if (!c.isPreferredIdentifier) return c
    if (c.targetObjectTypeId !== identifiedId) return c
    return { ...c, isPreferredIdentifier: false }
  })
  return { facts: newFacts, constraints: newConstraints }
}

// ── ref-mode helpers ──────────────────────────────────────────────────────────

// Build the VT + binary FT pair for a freshly-introduced ref mode.
// The VT-side role carries a preferred-identifier unary UC; the entity-side
// role carries an ordinary unary UC.  Default readings: "has" / "refers to".
function mkRefModePair(entity, vtName) {
  const vt = { ...mkValue(Math.round(entity.x + 160), Math.round(entity.y)), name: vtName }
  const ft = {
    ...mkFact(Math.round(entity.x + 80), Math.round(entity.y), 2),
    roles: [{ ...mkRole(), objectTypeId: entity.id }, { ...mkRole(), objectTypeId: vt.id }],
    uniqueness: [[1]],
    preferredUniqueness: [[1]],
    readingParts: ['', 'has', ''],
    alternativeReadings: [{ roleOrder: [1, 0], parts: ['', 'refers to', ''] }],
  }
  return { vt, ft }
}


// Find an existing binary fact that connects `entityId` to `vtId` with a reading
// of ['', 'has', ''] in the entity→vt direction (either as the main reading or
// as an alternative reading). Returns { fact, vtRoleIndex } or null.
function findMatchingRefModeFact(entityId, vtId, facts) {
  const TARGET = ['', 'has', '']
  for (const f of facts) {
    if (f.arity !== 2 || f.roles?.length !== 2) continue
    if (!f.roles.some(r => r.objectTypeId === entityId)) continue
    if (!f.roles.some(r => r.objectTypeId === vtId)) continue
    const defaultOrder = [0, 1]
    const readings = f.readingParts
      ? [{ parts: f.readingParts, roleOrder: defaultOrder }]
      : []
    for (const alt of (f.alternativeReadings || [])) {
      if (alt.parts) readings.push({ parts: alt.parts, roleOrder: alt.roleOrder ?? defaultOrder })
    }
    for (const { parts, roleOrder } of readings) {
      if (!Array.isArray(parts) || parts.length !== 3) continue
      if (parts[0] !== TARGET[0] || parts[1] !== TARGET[1] || parts[2] !== TARGET[2]) continue
      if (roleOrder.length < 2) continue
      const r0 = f.roles[roleOrder[0]]
      const r1 = f.roles[roleOrder[1]]
      if (r0?.objectTypeId === entityId && r1?.objectTypeId === vtId) {
        return { fact: f, vtRoleIndex: roleOrder[1] }
      }
    }
  }
  return null
}

// ── ref-mode label helpers ────────────────────────────────────────────────────
// Shared by setEntityRefModeLabel and setNestedRefModeLabel.

// Returns the state patch that demotes a ref-mode PI and converts owned
// VT/FT occurrences back to independent so they remain visible on the canvas.
// ownerId: the entity OT ID or objectified-fact ID whose ref mode is being cleared.
function clearRefModePI(state, ownerId, current) {
  return {
    facts: state.facts.map(f => f.id !== current.factId ? f : ({
      ...f,
      preferredUniqueness: (f.preferredUniqueness || [])
        .filter(pu => !(pu.length === 1 && pu[0] === current.vtRoleIndex)),
    })),
    diagrams: state.diagrams.map(d => {
      if (d.id !== state.activeDiagramId) return d
      const ownerOccIds = new Set((d.occurrences ?? []).filter(o => o.schemaElementId === ownerId).map(o => o.id))
      let nd = {
        ...d,
        occurrences: (d.occurrences ?? []).map(o => {
          if ((o.schemaElementId === current.vtId || o.schemaElementId === current.factId) && ownerOccIds.has(o.refModeOwnerOccId))
            return { ...o, refModeOwnerOccId: null }
          return o
        }),
        expandedRefModeOccs: (d.expandedRefModeOccs ?? []).filter(id => !ownerOccIds.has(id)),
      }
      const vtEl = state.objectTypes.find(o => o.id === current.vtId)
      const ftEl = state.facts.find(f => f.id === current.factId)
      nd = addOccIfAbsent(nd, current.vtId,  vtEl?.x ?? 0, vtEl?.y ?? 0)
      nd = addOccIfAbsent(nd, current.factId, ftEl?.x ?? 0, ftEl?.y ?? 0)
      return nd
    }),
    isDirty: true,
  }
}

// Returns the state patch for adding a ref mode when none currently exists.
// owner: { id, name, x, y } — the entity OT or objectified-fact acting as owner.
// demoteTargetId: entity OT ID to demote competing PIs for (null for nested entities).
function applyFreshRefMode(state, owner, targetVtName, existing, matchFact, demoteTargetId) {
  if (matchFact) {
    const factsWithPi = state.facts.map(f => {
      if (f.id !== matchFact.fact.id) return f
      const alreadySet = (f.preferredUniqueness || []).some(pu => pu.length === 1 && pu[0] === matchFact.vtRoleIndex)
      if (alreadySet) return f
      return { ...f, preferredUniqueness: [...(f.preferredUniqueness || []), [matchFact.vtRoleIndex]] }
    })
    const { facts: cFacts, constraints: cCons } = demoteTargetId
      ? demoteOtherPIsFor(demoteTargetId, factsWithPi, state.constraints, matchFact.fact.id, null)
      : { facts: factsWithPi, constraints: state.constraints }
    return {
      facts: cFacts, constraints: cCons,
      diagrams: state.diagrams.map(d => {
        if (d.id !== state.activeDiagramId) return d
        const ftEl = state.facts.find(f => f.id === matchFact.fact.id)
        return addOwnedRefModeOccsIfAbsent(d, owner.id, existing.id, existing.x ?? 0, existing.y ?? 0, matchFact.fact.id, ftEl?.x ?? 0, ftEl?.y ?? 0, matchFact.vtRoleIndex)
      }),
      isDirty: true,
    }
  }
  let nextOts = state.objectTypes
  let vt
  if (existing) {
    vt = existing
  } else {
    const { vt: newVt } = mkRefModePair(owner, targetVtName)
    vt = newVt
    nextOts = [...nextOts, newVt]
  }
  const ft = {
    ...mkFact(Math.round(owner.x + 80), Math.round(owner.y), 2),
    roles: [{ ...mkRole(), objectTypeId: owner.id }, { ...mkRole(), objectTypeId: vt.id }],
    uniqueness: [[1]], preferredUniqueness: [[1]],
    readingParts: ['', 'has', ''],
    alternativeReadings: [{ roleOrder: [1, 0], parts: ['', 'refers to', ''] }],
  }
  const factsAfterAdd = [...state.facts, ft]
  const { facts: cFacts, constraints: cCons } = demoteTargetId
    ? demoteOtherPIsFor(demoteTargetId, factsAfterAdd, state.constraints, ft.id, null)
    : { facts: factsAfterAdd, constraints: state.constraints }
  return {
    objectTypes: nextOts, facts: cFacts, constraints: cCons,
    diagrams: state.diagrams.map(d => {
      if (d.id !== state.activeDiagramId) return d
      return addOwnedRefModeOccsIfAbsent(d, owner.id, vt.id, vt.x, vt.y, ft.id, ft.x, ft.y, 1)
    }),
    isDirty: true,
  }
}

// ── query-generation helpers ──────────────────────────────────────────────────

// Returns the unique minimal common ancestor of all `otIds` in the subtype DAG
// (reflexive transitive closure), or null if none exists or it is not unique.
// "Minimal" means no proper descendant of it is also a common ancestor.
function findUniqueLCA(otIds, subtypes) {
  if (otIds.length === 0) return null
  const ancestorsOf = (id) => {
    const visited = new Set(), q = [id]
    while (q.length) {
      const curr = q.shift()
      if (visited.has(curr)) continue
      visited.add(curr)
      for (const st of subtypes) { if (st.subId === curr) q.push(st.superId) }
    }
    return visited
  }
  let common = ancestorsOf(otIds[0])
  for (let i = 1; i < otIds.length; i++) {
    const a = ancestorsOf(otIds[i])
    common = new Set([...common].filter(id => a.has(id)))
  }
  if (common.size === 0) return null
  // Keep only minimal elements: those with no proper descendant also in common.
  const commonArr = [...common]
  const minimal = commonArr.filter(id => {
    const desc = new Set(), q = [id]
    while (q.length) {
      const curr = q.shift()
      for (const st of subtypes) {
        if (st.superId === curr && !desc.has(st.subId)) { desc.add(st.subId); q.push(st.subId) }
      }
    }
    return !commonArr.some(other => other !== id && desc.has(other))
  })
  return minimal.length === 1 ? minimal[0] : null
}

// Returns a BFS path of subtype steps from `fromId` (supertype) down to `toId` (subtype),
// each step as { subtypeId, fromId, toId }. Returns [] when fromId === toId, null if no path.
function findPathDown(fromId, toId, subtypes) {
  if (fromId === toId) return []
  const parent = new Map() // childOtId → { subtypeId, parentOtId }
  const q = [fromId], visited = new Set([fromId])
  while (q.length) {
    const curr = q.shift()
    for (const st of subtypes) {
      if (st.superId === curr && !visited.has(st.subId)) {
        parent.set(st.subId, { subtypeId: st.id, parentOtId: curr })
        if (st.subId === toId) {
          const path = []
          let node = toId
          while (node !== fromId) {
            const { subtypeId, parentOtId } = parent.get(node)
            path.unshift({ subtypeId, fromId: parentOtId, toId: node })
            node = parentOtId
          }
          return path
        }
        visited.add(st.subId)
        q.push(st.subId)
      }
    }
  }
  return null
}

// ── constraint endpoint deps ─────────────────────────────────────────────────
// Returns unique fact/OT deps from a constraint's sequences, grouped by schema ID.
// Each dep: { schemaId, kind: 'fact'|'ot', label, memberKeys: ['si:mi', ...] }
// memberKeys are the roleOccurrenceRefs keys that reference this element.
function factTypeLabel(f, objectTypes) {
  if (!f) return null
  if (f.objectifiedName) return f.objectifiedName
  if (f.name) return f.name
  const parts = f.readingParts || []
  const roles = f.roles || []
  if (roles.length === 0) return null
  const tokens = []
  for (let i = 0; i <= roles.length; i++) {
    const seg = parts[i]?.trim()
    if (seg) tokens.push(seg)
    if (i < roles.length) {
      const ot = objectTypes?.find(o => o.id === roles[i].objectTypeId)
      tokens.push(ot?.name ?? '?')
    }
  }
  return tokens.join(' ') || null
}

function getConstraintDeps(c, facts, objectTypes) {
  const factDepsMap = new Map()  // schemaId → memberKeys[]
  const seqs = c.sequences ?? c.roleSequences ?? []
  seqs.forEach((seq, si) => {
    seq.forEach((m, mi) => {
      const fid = m.factId
      if (!fid || fid.includes('_il_')) return
      const key = `${si}:${mi}`
      if (!factDepsMap.has(fid)) factDepsMap.set(fid, [])
      factDepsMap.get(fid).push(key)
    })
  })
  const deps = []
  for (const [schemaId, memberKeys] of factDepsMap) {
    const el = facts?.find(f => f.id === schemaId)
    const label = factTypeLabel(el, objectTypes) ?? schemaId
    deps.push({ schemaId, kind: 'fact', label, memberKeys })
  }
  return deps
}

// ── constraint auto-sync ──────────────────────────────────────────────────────
// Returns the set of constraint IDs that are eligible for a given elementId set.
// Returns deduplicated list of all schema elements (facts, OTs, subtypes) referenced in
// the constraint's query atoms, excluding those already covered by getConstraintDeps.
function getConstraintQueryDeps(c, facts, objectTypes, subtypes) {
  const seen = new Set()
  const deps = []
  for (const q of (c.queries ?? [])) {
    if (!q?.atoms) continue
    for (const at of q.atoms) {
      const schemaId = at.originalId
      if (!schemaId || seen.has(schemaId) || schemaId.includes('_il_')) continue
      seen.add(schemaId)
      if (at.kind === 'fact') {
        const el = facts?.find(f => f.id === schemaId)
        deps.push({ schemaId, kind: 'fact', label: factTypeLabel(el, objectTypes) ?? schemaId })
      } else if (at.kind === 'objectType') {
        const el = objectTypes?.find(o => o.id === schemaId)
        deps.push({ schemaId, kind: 'ot', label: el?.name ?? schemaId })
      } else if (at.kind === 'subtype') {
        const st = subtypes?.find(s => s.id === schemaId)
        const subName = objectTypes?.find(o => o.id === st?.subId)?.name ?? '?'
        const supName = objectTypes?.find(o => o.id === st?.superId)?.name ?? '?'
        deps.push({ schemaId, kind: 'subtype', label: `${subName} → ${supName}` })
      }
    }
  }
  return deps
}

// A constraint is eligible when every fact/OT/subtype-endpoint it refers to is present.
// For implied link fact IDs (e.g. "abc_il_0"), checks that the parent fact is in the
// diagram and the implied link is shown in shownImplicitLinks.
function eligibleConstraints(constraints, subtypes, elementIdSet, facts, shownImplicitLinks) {
  const factMap = facts ? Object.fromEntries(facts.map(f => [f.id, f])) : {}
  return constraints.filter(c => {
    const deps = [] // [{ kind: 'fact', id }, { kind: 'impliedLink', factId, roleIndex }, { kind: 'subtype', id }, { kind: 'ot', id }]

    if (c.sequences != null) {
      for (const seq of c.sequences) {
        for (const m of seq) {
          if (m.kind === 'role' && m.factId) {
            if (m.factId.includes('_il_')) {
              const parts = m.factId.split('_il_')
              if (parts.length === 2) deps.push({ kind: 'impliedLink', factId: parts[0], roleIndex: Number(parts[1]) })
            } else {
              deps.push({ kind: 'fact', id: m.factId })
            }
          }
          if (m.kind === 'subtype' && m.subtypeId) deps.push({ kind: 'subtype', id: m.subtypeId })
        }
      }
    } else if (c.roleSequences != null) {
      for (const seq of c.roleSequences) {
        for (const ref of seq) {
          if (ref.factId) {
            if (ref.factId.includes('_il_')) {
              const parts = ref.factId.split('_il_')
              if (parts.length === 2) deps.push({ kind: 'impliedLink', factId: parts[0], roleIndex: Number(parts[1]) })
            } else {
              deps.push({ kind: 'fact', id: ref.factId })
            }
          }
        }
      }
    }
    if (c.targetObjectTypeId) deps.push({ kind: 'ot', id: c.targetObjectTypeId })

    // No connectors → not eligible for auto-add (but should persist if already in diagram)
    if (deps.length === 0) return false

    // Check all dependencies
    for (const dep of deps) {
      if (dep.kind === 'fact') {
        if (!elementIdSet.has(dep.id)) return false
      } else if (dep.kind === 'impliedLink') {
        if (!elementIdSet.has(dep.factId)) return false
        if (!shownImplicitLinks || !shownImplicitLinks.includes(`${dep.factId}:${dep.roleIndex}`)) return false
      } else if (dep.kind === 'subtype') {
        const st = subtypes.find(s => s.id === dep.id)
        if (!st || !elementIdSet.has(st.subId) || !elementIdSet.has(st.superId)) return false
      } else if (dep.kind === 'ot') {
        if (!elementIdSet.has(dep.id)) return false
      }
    }
    return true
  })
}

// Returns true if a constraint has no connectors (no sequences/roleSequences and no targetObjectTypeId).
function hasNoConnectors(c) {
  if (c.targetObjectTypeId) return false
  if (c.sequences != null) {
    return (c.sequences || []).every(seq => seq.length === 0)
  }
  if (c.roleSequences != null) {
    return (c.roleSequences || []).every(seq => seq.length === 0)
  }
  return true
}

// Recomputes which constraints belong in each diagram based on what elements are present.
// Constraints with connectors follow their referred elements automatically.
// Constraints with no connectors persist in the diagram until explicitly removed.
// Constraints are stored in constraintOccurrences[], separate from occurrences[].
// This function only REMOVES constraint occurrences when their deps leave the diagram.
// New constraint occurrences are never auto-added — they must be added explicitly.
function syncConstraints(diagrams, constraints, subtypes, facts) {
  return diagrams.map(d => {
    const shownImplicitLinks = d.shownImplicitLinks || []
    const constraintIdSet = new Set(constraints.map(c => c.id))
    const nonConstraintIds = new Set((d.occurrences ?? []).map(o => o.schemaElementId))
    const currentConstraintOccs = d.constraintOccurrences ?? []

    const mustKeep = new Set([...nonConstraintIds])
    const eligible = eligibleConstraints(constraints, subtypes, mustKeep, facts, shownImplicitLinks)
    const eligibleIds = new Set(eligible.map(c => c.id))

    // Keep an occurrence only if: the constraint still exists in the schema AND
    // (it has no connectors OR all its deps are still present in the diagram).
    const filtered = currentConstraintOccs.filter(co => {
      if (!constraintIdSet.has(co.schemaConstraintId)) return false
      const c = constraints.find(cc => cc.id === co.schemaConstraintId)
      if (!c) return false
      return hasNoConnectors(c) || eligibleIds.has(co.schemaConstraintId)
    })

    if (filtered.length === currentConstraintOccs.length) return d
    return { ...d, constraintOccurrences: filtered }
  })
}

// ── connected-ids BFS ─────────────────────────────────────────────────────────
function computeConnectedIds(startId, { objectTypes, facts, subtypes, constraints }) {
  const visited = new Set([startId])
  const queue   = [startId]
  while (queue.length > 0) {
    const id = queue.shift()
    // OT → Facts via roles
    for (const f of facts) {
      if (!visited.has(f.id) && f.roles.some(r => r.objectTypeId === id)) {
        visited.add(f.id); queue.push(f.id)
      }
    }
    // Fact → OTs via roles
    const fact = facts.find(f => f.id === id)
    if (fact) {
      for (const r of fact.roles) {
        if (r.objectTypeId && !visited.has(r.objectTypeId)) {
          visited.add(r.objectTypeId); queue.push(r.objectTypeId)
        }
      }
    }
    // OT ↔ Subtypes
    for (const st of subtypes) {
      if (!visited.has(st.id) && (st.subId === id || st.superId === id)) {
        visited.add(st.id); queue.push(st.id)
      }
    }
    const st = subtypes.find(s => s.id === id)
    if (st) {
      for (const otId of [st.subId, st.superId]) {
        if (!visited.has(otId)) { visited.add(otId); queue.push(otId) }
      }
    }
    // Fact → Constraints via roleSequences
    for (const c of constraints) {
      if (!visited.has(c.id) && c.roleSequences &&
          c.roleSequences.some(g => g.some(r => r.factId === id))) {
        visited.add(c.id); queue.push(c.id)
      }
    }
    const con = constraints.find(c => c.id === id)
    if (con) {
      if (con.roleSequences) {
        for (const g of con.roleSequences) {
          for (const r of g) {
            if (!visited.has(r.factId)) { visited.add(r.factId); queue.push(r.factId) }
          }
        }
      }
      // Subtype-like constraints ↔ Subtypes via sequences
      if (con.sequences) {
        for (const g of con.sequences) {
          for (const m of g) {
            if (m.kind === 'subtype' && !visited.has(m.subtypeId)) {
              visited.add(m.subtypeId); queue.push(m.subtypeId)
            }
          }
        }
      }
    }
    // Subtype → Constraints via sequences
    if (st) {
      for (const c of constraints) {
        if (!visited.has(c.id) && c.sequences &&
            c.sequences.some(g => g.some(m => m.kind === 'subtype' && m.subtypeId === id))) {
          visited.add(c.id); queue.push(c.id)
        }
      }
    }
  }
  return [...visited]
}

// ── diagram migration helpers ─────────────────────────────────────────────────
// These run during loadModel to bring older file formats up to the current shape.
// They are pure functions of their arguments — no store access.

// Migrate old expandedRefModes (schema OT IDs) → expandedRefModeOccs (occurrence IDs).
// Also marks VT/FT occurrences with refModeOwnerOccId so the new visibility logic works.
function migrateRefModeExpansion(diag, parsedOts, facts) {
  if (!diag.expandedRefModes?.length || diag.expandedRefModeOccs?.length) {
    return { ...diag, expandedRefModeOccs: diag.expandedRefModeOccs ?? [] }
  }
  const expandedRefModeOccs = []
  let updatedOccs = [...(diag.occurrences ?? [])]
  for (const schemaId of diag.expandedRefModes) {
    const firstOcc = updatedOccs.find(o => o.schemaElementId === schemaId)
    if (!firstOcc) continue
    expandedRefModeOccs.push(firstOcc.id)
    const ot = parsedOts.find(o => o.id === schemaId)
    const nested = !ot ? facts.find(f => f.id === schemaId && f.objectified && f.objectifiedKind !== 'value') : null
    const owner = ot ?? nested
    if (!owner) continue
    const rm = findRefMode(owner, facts, parsedOts)
    if (!rm) continue
    updatedOccs = updatedOccs.map(o => {
      if ((o.schemaElementId === rm.vtId || o.schemaElementId === rm.factId) && !o.refModeOwnerOccId)
        return { ...o, refModeOwnerOccId: firstOcc.id }
      return o
    })
  }
  return { ...diag, occurrences: updatedOccs, expandedRefModeOccs }
}

// Populate subtypeOccurrences / subtypeEndpointOccs for diagrams that pre-date
// per-diagram subtype tracking. Always stores endpoint pairs as Array<{ subOccId, superOccId }>.
function migrateSubtypeOccurrences(diag, parsedSts) {
  const occs = diag.occurrences ?? []
  if (diag.subtypeOccurrences != null) {
    const existingEps = diag.subtypeEndpointOccs ?? {}
    const needsNormalization = !diag.subtypeEndpointOccs ||
      Object.values(existingEps).some(v => v && !Array.isArray(v))
    if (!needsNormalization) return diag
    const subtypeEndpointOccs = {}
    for (const stId of diag.subtypeOccurrences) {
      const existing = existingEps[stId]
      if (existing) {
        subtypeEndpointOccs[stId] = Array.isArray(existing) ? existing : [existing]
      } else {
        const st = parsedSts.find(x => x.id === stId)
        if (!st) continue
        const subOcc  = occs.find(o => o.schemaElementId === st.subId)
        const superOcc = occs.find(o => o.schemaElementId === st.superId)
        if (subOcc && superOcc) subtypeEndpointOccs[stId] = [{ subOccId: subOcc.id, superOccId: superOcc.id }]
      }
    }
    return { ...diag, subtypeEndpointOccs }
  }
  const subtypeOccurrences = []
  const subtypeEndpointOccs = {}
  for (const st of parsedSts) {
    const subOcc  = occs.find(o => o.schemaElementId === st.subId)
    const superOcc = occs.find(o => o.schemaElementId === st.superId)
    if (subOcc && superOcc) {
      subtypeOccurrences.push(st.id)
      subtypeEndpointOccs[st.id] = [{ subOccId: subOcc.id, superOccId: superOcc.id }]
    }
  }
  return { ...diag, subtypeOccurrences, subtypeEndpointOccs }
}

// Migrate the oldest format (elementIds + positions map) to the occurrence-based format.
function migrateOldDiagram(diag, parsedOts, facts, constraints, constraintIdSet) {
  const positions = diag.positions ?? {}
  const occurrences = []
  const constraintOccurrences = []
  const implicitLinkPositions = {}

  for (const [k, v] of Object.entries(positions)) {
    if (k.includes(':il:')) {
      implicitLinkPositions[k] = v
    } else {
      const { x, y, ...extra } = v
      if (x != null || y != null) {
        if (constraintIdSet.has(k)) {
          constraintOccurrences.push({ id: `cocc_${uid()}`, schemaConstraintId: k, x: x ?? 0, y: y ?? 0, roleOccurrenceRefs: [] })
        } else {
          occurrences.push({ id: `occ_${uid()}`, schemaElementId: k, x: x ?? 0, y: y ?? 0, ...extra })
        }
      }
    }
  }

  const elementIds = diag.elementIds
  if (elementIds === null) {
    const covered  = new Set(occurrences.map(o => o.schemaElementId))
    const coveredC = new Set(constraintOccurrences.map(co => co.schemaConstraintId))
    for (const el of [...parsedOts, ...facts]) {
      if (!covered.has(el.id))
        occurrences.push({ id: `occ_${uid()}`, schemaElementId: el.id, x: el.x ?? 0, y: el.y ?? 0 })
    }
    for (const c of constraints) {
      if (!coveredC.has(c.id))
        constraintOccurrences.push({ id: `cocc_${uid()}`, schemaConstraintId: c.id, x: c.x ?? 0, y: c.y ?? 0, roleOccurrenceRefs: [] })
    }
  } else if (Array.isArray(elementIds)) {
    const covered  = new Set(occurrences.map(o => o.schemaElementId))
    const coveredC = new Set(constraintOccurrences.map(co => co.schemaConstraintId))
    for (const id of elementIds) {
      if (constraintIdSet.has(id)) {
        if (coveredC.has(id)) continue
        const c = constraints.find(cc => cc.id === id)
        constraintOccurrences.push({ id: `cocc_${uid()}`, schemaConstraintId: id, x: c?.x ?? 0, y: c?.y ?? 0, roleOccurrenceRefs: [] })
      } else {
        if (covered.has(id)) continue
        const el = parsedOts.find(o => o.id === id) ?? facts.find(f => f.id === id)
        occurrences.push({ id: `occ_${uid()}`, schemaElementId: id, x: el?.x ?? 0, y: el?.y ?? 0 })
      }
    }
  }

  return {
    ...diag,
    occurrences,
    constraintOccurrences,
    implicitLinkPositions,
    multiSelectedIds: [],
    expandedRefModes: diag.expandedRefModes ?? [],
  }
}

// ── empty model ───────────────────────────────────────────────────────────────
const EMPTY = () => {
  const d = mkDiagram('Main')
  return {
    objectTypes:     [],
    facts:           [],
    subtypes:        [],
    constraints:     [],
    diagrams:        [d],
    activeDiagramId: d.id,
    // Schema-wide sample population: otId → array of instance values (strings).
    // Value type:  instance = the literal value.
    // Entity type: instance = the ref-mode value identifying the entity.
    populations:     {},
    // Fact-type populations: factId → array of tuples (each tuple is a string[]
    // of length = fact arity; each cell references a role-player instance).
    factPopulations: {},
    // Subtype-edge populations: edgeId → array of supertype-side mapping cells.
    // For non-inheriting subtype edges, each row holds the supertype-encoded
    // instance values that correspond to the subtype instance at the same
    // position in populations[subtypeId]. For inheriting edges, this is unused
    // (the mapping is derived as identity).
    subtypeMappings: {},
    // Nested-entity PI mappings: factId → array of PI values aligned by row with
    // factPopulations[factId]. Each entry is the explicit PI value for that row:
    // a string for single-column PIs (ref-mode), or an array for composite PIs.
    // Only populated when the nested entity type has an explicit PI.
    nestedEntityMappings: {},
  }
}

// ── query helper: merge fact/nested-OT atoms with identical role→OT connectivity ──
function runFactMergePass(atoms, links, allFacts) {
  const getArity = (factId) => {
    if (factId.includes('_il_')) return 2
    const f = allFacts.find(f => f.id === factId)
    return f?.arity ?? f?.roles?.length ?? 0
  }
  const isObjectifiedId = (id) => allFacts.some(f => f.id === id && f.objectified)
  let mAtoms = atoms, mLinks = links, again = true
  while (again) {
    again = false
    const factAtoms = mAtoms.filter(a => a.kind === 'fact' || (a.kind === 'objectType' && isObjectifiedId(a.originalId)))
    const byOrig = {}
    for (const a of factAtoms) { if (!byOrig[a.originalId]) byOrig[a.originalId] = []; byOrig[a.originalId].push(a) }
    for (const group of Object.values(byOrig)) {
      if (group.length < 2) continue
      const arity = getArity(group[0].originalId)
      if (!arity) continue
      const allRoles = Array.from({ length: arity }, (_, k) => k)
      let found = false
      for (let i = 0; i < group.length && !found; i++) {
        const m1 = {}; for (const l of mLinks) if (l.atomId === group[i].id) m1[l.roleIndex] = l.variableId
        if (!allRoles.every(r => m1[r] != null)) continue
        for (let j = i + 1; j < group.length && !found; j++) {
          const m2 = {}; for (const l of mLinks) if (l.atomId === group[j].id) m2[l.roleIndex] = l.variableId
          if (!allRoles.every(r => m2[r] != null)) continue
          if (!allRoles.every(r => m1[r] === m2[r])) continue
          const merged = { ...group[i], seededRoles: [...new Set([...(group[i].seededRoles ?? []), ...(group[j].seededRoles ?? [])])] }
          mAtoms = mAtoms.filter(a => a.id !== group[j].id).map(a => a.id === group[i].id ? merged : a)
          mLinks  = mLinks
            .filter(l => l.atomId !== group[j].id)
            .map(l => l.variableId === group[j].id ? { ...l, variableId: group[i].id } : l)
          found = again = true
        }
      }
      if (again) break
    }
  }
  return { atoms: mAtoms, links: mLinks }
}

// ── store ─────────────────────────────────────────────────────────────────────
export const useOrmStore = create((set, get) => ({
  ...EMPTY(),
  filePath: null,
  isDirty:  false,

  pan:  { x: 0, y: 0 },
  zoom: 1,

  selectedId:              null,
  selectedKind:            null,
  selectedRole:            null,   // { factId, roleIndex } | null
  selectedImplicitLink:      null,   // roleIndex within the parent fact identifying the selected implicit link
  selectedImplicitLinkRole: null,  // { factId, roleIndex, ilRoleIndex } | null
  selectedUniqueness:      null,   // { factId, uIndex } | null
  selectedMandatoryDot:    null,   // { factId, roleIndex } | null
  selectedInternalFrequency: null, // { factId, ifId } | null
  selectedValueRange:      null,   // { otId? } | { factId, roleIndex } | { nestedFactId } | null
  selectedCardinalityRange: null,  // same shape as selectedValueRange | null
  multiSelectedIds:        [],     // ids of additionally selected elements
  selectedOccurrenceId:      null,  // occurrence ID when a specific occurrence was clicked
  multiSelectedOccurrenceIds: [],   // parallel to multiSelectedIds; one entry per selected occurrence
  uniquenessConstruction:  null,   // { factId, roleIndices: number[] } | null
  frequencyConstruction:   null,   // { stage:2|3, factId, x, y, roleIndices:number[], ifId?:string, range?:[] } | null
  sequenceConstruction:    null,   // { constraintId, steps: [{sequenceIndex}][], collected: [{sequenceIndex, member}][] } | null
  constraintHighlight:     null,   // { constraintId, sequenceIndex: number|null, positionIndex: number|null } | null
  queryIndexHighlight:     null,   // { constraintId, queryIndex: number } | null
  queryEditDraft:          null,   // { constraintId, sequenceIndex, atoms:[{id,kind,originalId,isOutput}], links:[{atomId,roleIndex,variableId}], pendingClick } | null
  pendingTargetPick:       null,   // { constraintId } | null  — set while the user is clicking a target OT in the diagram

  tool:      'select',
  linkDraft: null,
  roleReconnectDraft: null,  // { factOccId, roleIndex, factSchemaId, currentOtSchemaId, diagramId } | null
  noteConnectorDraft:      null,  // { noteId } | null
  noteRemoveSubjectDraft:  null,  // { noteId } | null

  // ── global display settings ────────────────────────────────────────────
  // 'role'   → mandatory dot sits at the role-box end of the connector
  // 'object' → mandatory dot sits at the object-type border end
  mandatoryDotPosition: 'role',
  // Whether to show the reference mode label inside entity/value type nodes
  showReferenceMode: true,
  showRoleNames: true,
  showSequenceMembership: true,
  showConstraintQueries: true,
  showMinimap: true,
  // Position of the minimap panel in screen px from top-left of canvas container
  minimapPos: { x: null, y: null },  // null = default (bottom-right corner)

  // ── validation ────────────────────────────────────────────────────────────
  validationErrors: [],
  validationCategories: { ...DEFAULT_VALIDATION_CATEGORIES },
  // Population-validation issues (warnings — distinct from schema errors above).
  populationIssues: [],

  inspectorWidth: 240,
  bottomPanelHeight:    220,
  bottomPanelTab:       'population',
  bottomPanelCollapsed: true,

  clipboard: null,  // { objectTypes[], facts[], constraints[], subtypes[] } | null

  // ── clipboard ──────────────────────────────────────────────────────────

  copySelection() {
    const { selectedId, multiSelectedIds, objectTypes, facts, constraints, subtypes, diagrams, activeDiagramId } = get()
    const ids = new Set(multiSelectedIds.length > 0 ? multiSelectedIds : selectedId ? [selectedId] : [])
    if (ids.size === 0) return

    const activeDiagram = diagrams.find(d => d.id === activeDiagramId)
    const diagramShownIL      = new Set(activeDiagram?.shownImplicitLinks ?? [])
    const diagramExpandedRefs = new Set(activeDiagram?.expandedRefModes    ?? [])

    // Principle 3: expand to include role-player OTs for every fact in the selection
    const expandedIds = closeUnderPrinciple3([...ids], { facts, objectTypes })

    const copiedOts   = objectTypes.filter(o => expandedIds.has(o.id))
    const copiedFacts = facts.filter(f => expandedIds.has(f.id))
    // Principle 2: only include explicitly-selected constraints whose referenced
    // elements are all present in the expanded set
    const selectedCons = constraints.filter(c => ids.has(c.id))
    const copiedCons  = eligibleConstraints(selectedCons, subtypes, expandedIds)
    // Principle 1: auto-include subtypes whose both endpoints are in expanded set
    const copiedSts = subtypes.filter(st => expandedIds.has(st.subId) && expandedIds.has(st.superId))

    // Capture shown implied links: from explicit _il_ selection + shown ILs of selected objectified facts
    const copiedILKeys = new Set()
    for (const id of ids) {
      if (id.includes('_il_')) {
        const [factId, ri] = id.split('_il_')
        const key = `${factId}:${ri}`
        if (diagramShownIL.has(key)) copiedILKeys.add(key)
      }
    }
    for (const f of copiedFacts) {
      if (f.objectified) {
        ;(f.implicitLinks || []).forEach((_, i) => {
          const key = `${f.id}:${i}`
          if (diagramShownIL.has(key)) copiedILKeys.add(key)
        })
      }
    }

    // Capture expanded ref mode entity IDs present in the selection
    const copiedExpandedRefs = copiedOts
      .filter(o => o.kind === 'entity' && diagramExpandedRefs.has(o.id))
      .map(o => o.id)

    // Capture per-diagram positions from the source diagram so paste/duplicate
    // preserves the actual on-screen layout, not just the schema base positions.
    const clipPositions = {}
    for (const el of [...copiedOts, ...copiedFacts]) {
      const occ = occOf(activeDiagram, el.id)
      clipPositions[el.id] = occ ? { x: occ.x, y: occ.y } : { x: el.x, y: el.y }
    }
    for (const c of copiedCons) {
      const cocc = cOccOf(activeDiagram, c.id)
      clipPositions[c.id] = cocc ? { x: cocc.x, y: cocc.y } : { x: c.x, y: c.y }
    }

    const newClipboard = {
      objectTypes: copiedOts, facts: copiedFacts, constraints: copiedCons, subtypes: copiedSts,
      shownImplicitLinks: [...copiedILKeys],
      expandedRefModes:   copiedExpandedRefs,
      positions:          clipPositions,
    }
    set({ clipboard: newClipboard })
  },

  cutSelection() {
    // copySelection replaces the clipboard and purges any previously cut orphans
    get().copySelection()
    const { selectedId, selectedKind, multiSelectedIds, activeDiagramId } = get()

    if (multiSelectedIds.length > 0) {
      // Remove from diagram only; clipboard now holds a reference, so no schema purge
      get().removeMultiSelectionFromDiagram(activeDiagramId)
      return
    }
    if (!selectedId) return
    if (selectedKind === 'subtype') {
      // Subtypes have no diagram membership; deleting from schema is the only sensible cut
      get().deleteSubtype(selectedId)
    } else {
      // Remove from diagram only; element persists in schema (may become orphaned)
      get().removeElementFromDiagram(selectedId, activeDiagramId)
    }
  },

  // Ctrl+V: add original clipboard elements to the active diagram, skip those already present
  pasteClipboard() {
    const { clipboard, activeDiagramId, diagrams, objectTypes, facts, constraints, subtypes } = get()
    if (!clipboard) return

    const activeDiagram = diagrams.find(d => d.id === activeDiagramId)
    const existingIds = new Set((activeDiagram?.occurrences ?? []).map(o => o.schemaElementId))

    // Principle 3: ensure role-player OTs of clipboard facts are also added (even if
    // they are in the schema but not in the clipboard itself)
    const clipBaseIds = [
      ...clipboard.objectTypes.map(o => o.id),
      ...clipboard.facts.map(f => f.id),
    ]
    const closedIds = closeUnderPrinciple3(clipBaseIds, { facts, objectTypes })

    // Collect implied links that need to be shown (from pasted constraints + clipboard's own shown ILs)
    const impliedLinksToShow = new Set(clipboard.shownImplicitLinks ?? [])
    for (const c of clipboard.constraints) {
      if (c.sequences) {
        for (const seq of c.sequences) {
          for (const m of seq) {
            if (m.kind === 'role' && m.factId && m.factId.includes('_il_')) {
              const parts = m.factId.split('_il_')
              if (parts.length === 2) impliedLinksToShow.add(`${parts[0]}:${Number(parts[1])}`)
            }
          }
        }
      }
    }

    // Determine which entity IDs need to be in expandedRefModes of the target diagram
    // (from clipboard.expandedRefModes captured at copy time).
    const allTargetIds = new Set([...closedIds, ...existingIds])
    const refEntityIds = new Set()
    for (const id of (clipboard.expandedRefModes ?? [])) {
      if (allTargetIds.has(id)) refEntityIds.add(id)
    }

    const toAdd = [
      ...[...closedIds]
        .filter(id => !existingIds.has(id))
        .map(id => objectTypes.find(o => o.id === id) ?? facts.find(f => f.id === id))
        .filter(Boolean),
      ...clipboard.constraints.filter(c => !existingIds.has(c.id)),
    ]

    if (toAdd.length === 0 && impliedLinksToShow.size === 0 && refEntityIds.size === 0) return

    // Compute viewport centre in world coordinates using the canvas SVG element
    const { pan, zoom } = get()
    const svgEl = typeof document !== 'undefined' ? document.getElementById('orm2-canvas-svg') : null
    const svgRect = svgEl?.getBoundingClientRect()
    const viewportCenter = svgRect
      ? { x: (-pan.x + svgRect.width  / 2) / zoom,
          y: (-pan.y + svgRect.height / 2) / zoom }
      : { x: 400, y: 300 }

    // Use the per-diagram positions captured at copy time so that elements moved
    // within the source diagram keep their relative layout after paste.
    const clipPos = clipboard.positions ?? {}
    const getClipPos = (el) => clipPos[el.id] ?? { x: el.x, y: el.y }

    // Shift pasted elements to a sensible position:
    // • empty diagram  → top-left of bounding box at (100, 100) (visible after reset view)
    // • non-empty      → centre of bounding box on current viewport centre
    let ox = 0, oy = 0
    const positioned = toAdd.filter(el => el.x != null || clipPos[el.id])
    if (positioned.length > 0) {
      const allX = positioned.map(el => getClipPos(el).x)
      const allY = positioned.map(el => getClipPos(el).y)
      const minX = Math.min(...allX)
      const minY = Math.min(...allY)
      if (existingIds.size === 0) {
        // Empty diagram: anchor top-left corner to (100, 100)
        ox = 100 - minX
        oy = 100 - minY
      } else {
        // Non-empty diagram: centre bounding box on viewport centre
        const maxX = Math.max(...allX)
        const maxY = Math.max(...allY)
        ox = viewportCenter.x - (minX + maxX) / 2
        oy = viewportCenter.y - (minY + maxY) / 2
      }
    }

    const addIds = toAdd.map(el => el.id)
    const singleEl = toAdd.length === 1 ? toAdd[0] : null
    const singleKind = singleEl
      ? (clipboard.objectTypes.find(o => o.id === singleEl.id)?.kind
          ?? (clipboard.facts.find(f => f.id === singleEl.id) ? 'fact' : 'constraint'))
      : null

    set(s => {
      const updatedDiagrams = s.diagrams.map(d => {
        if (d.id !== activeDiagramId) return d

        let nd = d
        const pasteConstraintIdSet = new Set(s.constraints.map(c => c.id))
        for (const el of toAdd) {
          const cp = getClipPos(el)
          // Only add if not already present; use clipboard position + offset
          if (pasteConstraintIdSet.has(el.id)) {
            nd = addCOccIfAbsent(nd, el.id, cp.x + ox, cp.y + oy)
          } else if (!inDiag(nd, el.id)) {
            nd = { ...nd, occurrences: [...(nd.occurrences ?? []), mkOcc(el.id, cp.x + ox, cp.y + oy)] }
          }
        }

        // Add implied links to shownImplicitLinks
        const shown = d.shownImplicitLinks || []
        const newShown = new Set(shown)
        for (const ilKey of impliedLinksToShow) newShown.add(ilKey)
        const shownChanged = newShown.size !== shown.length || [...newShown].some(k => !shown.includes(k))

        // Add expanded ref mode entity IDs
        const oldExpandedRefs = d.expandedRefModes ?? []
        const newExpandedRefs = refEntityIds.size > 0
          ? [...new Set([...oldExpandedRefs, ...refEntityIds])]
          : oldExpandedRefs

        return {
          ...nd,
          shownImplicitLinks: shownChanged ? [...newShown] : shown,
          expandedRefModes:   newExpandedRefs,
        }
      })
      return {
        diagrams: syncConstraints(updatedDiagrams, s.constraints, s.subtypes, s.facts),
        selectedId:       addIds.length === 1 ? addIds[0] : null,
        selectedKind:     addIds.length === 1 ? singleKind : null,
        multiSelectedIds: addIds.length  >  1 ? addIds : [],
        isDirty: true,
      }
    })
  },

  // Ctrl+D: duplicate clipboard elements as fresh schema copies at +20px offset
  duplicateClipboard() {
    const { clipboard, activeDiagramId } = get()
    if (!clipboard) return
    const OFFSET = 20

    const idMap = new Map()
    for (const el of [...clipboard.objectTypes, ...clipboard.facts, ...clipboard.constraints, ...clipboard.subtypes])
      idMap.set(el.id, uid())
    const remap = id => idMap.get(id) ?? id

    // Collect all names currently in use (OTs + objectified facts acting as OTs)
    const usedNames = new Set([
      ...get().objectTypes.map(o => o.name),
      ...get().facts.map(f => f.objectifiedName).filter(Boolean),
    ])

    // Use per-diagram positions captured at copy time so the duplicated group
    // maintains the same relative layout as the original, not the schema base positions.
    const clipPos = clipboard.positions ?? {}
    const getSrcPos = (el) => clipPos[el.id] ?? { x: el.x, y: el.y }

    const newOts = clipboard.objectTypes.map(o => {
      const name = makeUniqueName(o.name, usedNames)
      usedNames.add(name)
      const sp = getSrcPos(o)
      return { ...o, id: idMap.get(o.id), x: sp.x + OFFSET, y: sp.y + OFFSET, name }
    })

    const newFacts = clipboard.facts.map(f => {
      let objectifiedName = f.objectifiedName
      if (f.objectified && objectifiedName) {
        objectifiedName = makeUniqueName(objectifiedName, usedNames)
        usedNames.add(objectifiedName)
      }
      const sp = getSrcPos(f)
      return {
        ...f, id: idMap.get(f.id), x: sp.x + OFFSET, y: sp.y + OFFSET,
        roles: f.roles.map(r => ({ ...r, id: uid(), objectTypeId: remap(r.objectTypeId) })),
        objectifiedName,
      }
    })

    const remapMember = m =>
      m.kind === 'role'    ? { ...m, factId:    remap(m.factId) }
    : m.kind === 'subtype' ? { ...m, subtypeId: remap(m.subtypeId) }
    : m

    const newCons = clipboard.constraints.map(c => {
      const sp = getSrcPos(c)
      return {
        ...c, id: idMap.get(c.id), x: sp.x + OFFSET, y: sp.y + OFFSET,
        sequences:     c.sequences     ? c.sequences.map(g => g.map(remapMember)) : c.sequences,
        roleSequences: c.roleSequences ? c.roleSequences.map(g => g.map(r => ({ ...r, factId: remap(r.factId) }))) : c.roleSequences,
        targetObjectTypeId: c.targetObjectTypeId ? remap(c.targetObjectTypeId) : c.targetObjectTypeId,
      }
    })

    const newSts = clipboard.subtypes.map(st => ({
      ...st, id: idMap.get(st.id),
      subId: idMap.get(st.subId), superId: idMap.get(st.superId),
    }))

    const newIds = [...newOts, ...newFacts, ...newCons, ...newSts].map(e => e.id)
    if (newIds.length === 0) return
    const singleKind = newOts[0]?.kind ?? (newFacts.length ? 'fact' : newCons.length ? 'constraint' : 'subtype')

    // Remap shown implied links to new fact IDs
    const newShownILKeys = (clipboard.shownImplicitLinks ?? []).map(key => {
      const [factId, ri] = key.split(':')
      return `${idMap.get(factId) ?? factId}:${ri}`
    })

    // Collect expanded ref modes for the duplicate: from clipboard.expandedRefModes (remapped).
    const dupExpandedRefs = new Set(
      (clipboard.expandedRefModes ?? []).map(id => idMap.get(id)).filter(Boolean)
    )

    set(s => ({
      objectTypes: [...s.objectTypes, ...newOts],
      facts:       [...s.facts,       ...newFacts],
      constraints: [...s.constraints, ...newCons],
      subtypes:    [...s.subtypes,    ...newSts],
      diagrams: s.diagrams.map(d => {
        if (d.id !== activeDiagramId) return d
        let nd = d
        for (const o of newOts)   nd = addOccIfAbsent(nd, o.id, o.x, o.y)
        for (const f of newFacts) nd = addOccIfAbsent(nd, f.id, f.x, f.y)
        for (const c of newCons)  nd = addCOccIfAbsent(nd, c.id, c.x, c.y)
        return {
          ...nd,
          shownImplicitLinks: newShownILKeys.length > 0
            ? [...new Set([...(d.shownImplicitLinks ?? []), ...newShownILKeys])]
            : (d.shownImplicitLinks ?? []),
          expandedRefModes: dupExpandedRefs.size > 0
            ? [...new Set([...(d.expandedRefModes ?? []), ...dupExpandedRefs])]
            : (d.expandedRefModes ?? []),
        }
      }),
      selectedId:       newIds.length === 1 ? newIds[0] : null,
      selectedKind:     newIds.length === 1 ? singleKind : null,
      multiSelectedIds: newIds.length  >  1 ? newIds : [],
      isDirty: true,
    }))
  },

  setMandatoryDotPosition(pos) { set({ mandatoryDotPosition: pos }) },
  setShowReferenceMode(val)   { set({ showReferenceMode: val }) },
  setShowRoleNames(val)             { set({ showRoleNames: val }) },
  setShowSequenceMembership(val)    { set({ showSequenceMembership: val }) },
  setShowConstraintQueries(val)     { set({ showConstraintQueries: val }) },
  setShowMinimap(val)         { set({ showMinimap: val }) },
  setMinimapPos(x, y)         { set({ minimapPos: { x, y } }) },
  setInspectorWidth(w)        { set({ inspectorWidth: w }) },
  setBottomPanelHeight(h)     { set({ bottomPanelHeight: h }) },
  setBottomPanelTab(t)        { set({ bottomPanelTab: t }) },
  setBottomPanelCollapsed(v)  { set({ bottomPanelCollapsed: v }) },

  runValidation() {
    const s = get()
    const enabled = new Set(
      Object.entries(s.validationCategories).filter(([, v]) => v).map(([k]) => k)
    )
    set({
      validationErrors: runValidationRules(s, enabled),
      populationIssues: computePopulationIssues(s),
    })
  },
  toggleValidationCategory(category) {
    set(s => ({ validationCategories: { ...s.validationCategories, [category]: !s.validationCategories[category] } }))
    get().runValidation()
  },

  setDiagramProfile(profileId) {
    set(s => ({
      diagrams: s.diagrams.map(d => d.id !== s.activeDiagramId ? d : { ...d, profileId }),
      isDirty: true,
    }))
  },

  setValueTypeDatatype(id, assignment) {
    // assignment: { profileId, datatypeId, params? } | null
    // Always applies to the target element directly. Ref-mode entities now hold
    // their datatype on the associated value type — the inspector edits that VT
    // directly instead of mirroring through the entity.
    set(s => ({
      objectTypes: s.objectTypes.map(o => o.id === id ? { ...o, datatypeAssignment: assignment } : o),
      isDirty: true,
    }))
  },

  // ── model ops ──────────────────────────────────────────────────────────

  newModel() {
    set({ ...EMPTY(), filePath: null, isDirty: false,
          selectedId: null, selectedKind: null, selectedRole: null, selectedImplicitLink: null, selectedImplicitLinkRole: null,
          selectedUniqueness: null, multiSelectedIds: [], selectedOccurrenceId: null, multiSelectedOccurrenceIds: [],
          uniquenessConstruction: null, frequencyConstruction: null,
          linkDraft: null, roleReconnectDraft: null,
          pan: { x: 0, y: 0 }, zoom: 1 })
  },

   loadModel(data, filePath = null) {
    let d = typeof data === 'string' ? JSON.parse(data) : data

    // v2 format: { version: 2, schema: { objectTypes, factTypes, subtypes, externalConstraints, displaySettings }, diagrams, ... }
    let schemaDisplaySettings = {}
    if (d.version === 2 && d.schema) {
      schemaDisplaySettings = d.schema.displaySettings ?? {}
      d = {
        ...d,
        objectTypes: d.schema.objectTypes        ?? [],
        facts:       d.schema.factTypes          ?? [],
        subtypes:    d.schema.subtypes           ?? [],
        constraints: d.schema.externalConstraints ?? [],
      }
    }

    const facts = (d.facts || []).map(f => {
      // Migration: if readingParts was stored as an all-empty array from the old format,
      // treat it as null (no reading). Only keep it if at least one fragment has content.
      let readingParts = f.readingParts
      if (readingParts && Array.isArray(readingParts) && readingParts.every(p => !p?.trim())) {
        readingParts = null
      }
      // Migration: nested value types have been removed; coerce any
      // objectifiedKind: 'value' to 'entity' so legacy files still load.
      const objectifiedKind = f.objectified
        ? (f.objectifiedKind === 'value' ? 'entity' : (f.objectifiedKind || 'entity'))
        : f.objectifiedKind
      return {
        ...f,
        objectifiedKind,
        readingParts,
        alternativeReadings: f.alternativeReadings || [],
        readingDisplay: f.readingDisplay || 'forward',
        shownReadingOrder: f.shownReadingOrder ?? null,
        roles: (f.roles || []).map(r => ({
          ...r,
          linkReadingParts: r.linkReadingParts ?? (f.objectified ? ['', 'involves', ''] : ['', '', '']),
          linkReadingReverseParts: r.linkReadingReverseParts ?? null,
        })),
        implicitLinks: ((f.implicitLinks && f.implicitLinks.length > 0 ? f.implicitLinks : null) || (f.objectified
          ? Array.from({ length: (f.roles || []).length }, (_, i) => mkImplicitLink(i))
          : [])).map(il => ({
            ...il,
            alternativeReadings: il.alternativeReadings || [],
            readingDisplay: il.readingDisplay || 'forward',
            roleNames: il.roleNames || [null, null],
            // Migrate: old boolean → array of role-index arrays (matching fact.preferredUniqueness format)
            preferredUniqueness: Array.isArray(il.preferredUniqueness)
              ? il.preferredUniqueness
              : (il.preferredUniqueness ? [[0]] : []),
          })),
        internalFrequency: (f.internalFrequency || []).map((if_, idx) => ({
          ...if_,
          x: if_.x ?? (f.x + 40 + idx * 20),
          y: if_.y ?? (f.y - 30),
        })),
        // Migration: preferredUniqueness was a single array, now it's an array of arrays
        preferredUniqueness: Array.isArray(f.preferredUniqueness)
          ? (f.preferredUniqueness.length > 0 && Array.isArray(f.preferredUniqueness[0])
            ? f.preferredUniqueness
            : f.preferredUniqueness.length > 0
              ? [f.preferredUniqueness]
              : [])
          : [],
      }
    }).map(f => ({
      ...f,
      // Migration: remove preferred uniqueness constraints that don't cover exactly n-1 roles
      preferredUniqueness: (f.preferredUniqueness || []).filter(pu => pu.length === f.arity - 1),
    }))
    // Migrate old field names → new names
    const constraints = (d.constraints || []).map(c => {
      let out = c
      // ringType (string) → ringTypes (array)
      if (out.constraintType === 'ring' && !out.ringTypes) {
        const { ringType, ...rest } = out
        out = { ...rest, ringTypes: ringType ? [ringType] : [] }
      }
      // groups → sequences
      if ('groups' in out && !('sequences' in out)) {
        const { groups, ...rest } = out
        out = { ...rest, sequences: groups }
      }
      // roleGroups → roleSequences
      if ('roleGroups' in out && !('roleSequences' in out)) {
        const { roleGroups, ...rest } = out
        out = { ...rest, roleSequences: roleGroups }
      }
      // ring roleSequences → sequences (ring now uses the subtype-like sequence mechanism)
      if (out.constraintType === 'ring' && out.roleSequences && !out.sequences) {
        const { roleSequences, ...rest } = out
        out = { ...rest, sequences: roleSequences.map(g => g.map(r => ({ kind: 'role', ...r }))) }
      }
      // valueComparison roleSequences → sequences
      if (out.constraintType === 'valueComparison' && out.roleSequences && !out.sequences) {
        const { roleSequences, ...rest } = out
        out = { ...rest, sequences: roleSequences.map(g => g.map(r => ({ kind: 'role', ...r }))) }
      }
      // frequency roleSequences → sequences (frequency now uses the external sequence mechanism)
      if (out.constraintType === 'frequency' && out.roleSequences && !out.sequences) {
        const { roleSequences, ...rest } = out
        out = { ...rest, sequences: roleSequences.map(g => g.map(r => ({ kind: 'role', ...r }))) }
      }
      // frequency { min, max } → range-spec array
      if (out.constraintType === 'frequency' && out.frequency && !Array.isArray(out.frequency)) {
        const { min, max } = out.frequency
        const spec = (max == null || max === Infinity)
          ? (min <= 0 ? null : { type: 'lower', lower: String(min) })
          : min === max
            ? { type: 'single', value: String(min) }
            : { type: 'range', lower: String(min), upper: String(max) }
        out = { ...out, frequency: spec ? [spec] : null }
      }
      // Discard old-format queries (patternRoles/patternSubtypes) — replaced by atom-graph format
      if (out.queries && out.queries.some(q => q && q.patternRoles)) {
        out = { ...out, queries: out.queries.map(q => (q && q.patternRoles) ? null : q) }
      }
      // Migrate 'copies'/'copyId' terminology to 'atoms'/'atomId'
      if (out.queries) {
        out = { ...out, queries: out.queries.map(q => {
          if (!q || q.atoms) return q
          const atoms = q.copies ?? []
          const links = (q.links ?? []).map(lk => lk.copyId !== undefined && lk.atomId === undefined ? { ...lk, atomId: lk.copyId } : lk)
          return { ...q, atoms, links }
        })}
      }
      return out
    })
    const parsedOts  = d.objectTypes  || []
    const parsedSts  = d.subtypes      || []

    const constraintIdSet = new Set(constraints.map(c => c.id))

    let diagrams, activeDiagramId
    if (d.diagrams && d.diagrams.length > 0) {
      diagrams = d.diagrams.map(diag => {
        if (diag.constraintOccurrences) {
          // Phase 3 format: constraintOccurrences already split out
          const d3 = { ...diag, constraintOccurrences: diag.constraintOccurrences, implicitLinkPositions: diag.implicitLinkPositions ?? {}, multiSelectedIds: [], expandedRefModes: diag.expandedRefModes ?? [] }
          return migrateSubtypeOccurrences(migrateRefModeExpansion(d3, parsedOts, facts), parsedSts)
        }
        if (diag.occurrences) {
          // Phase 1/2 format: occurrences exist but constraintOccurrences does not — split them
          const nonConstraintOccs = diag.occurrences.filter(o => !constraintIdSet.has(o.schemaElementId))
          const constraintOccs = diag.occurrences
            .filter(o => constraintIdSet.has(o.schemaElementId))
            .map(o => mkConstraintOcc(o.schemaElementId, o.x, o.y))
          const d12 = {
            ...diag,
            occurrences: nonConstraintOccs,
            constraintOccurrences: constraintOccs,
            implicitLinkPositions: diag.implicitLinkPositions ?? {},
            multiSelectedIds: [],
            expandedRefModes: diag.expandedRefModes ?? [],
          }
          return migrateSubtypeOccurrences(migrateRefModeExpansion(d12, parsedOts, facts), parsedSts)
        }
        // old format (elementIds + positions)
        return migrateSubtypeOccurrences(migrateRefModeExpansion(migrateOldDiagram(diag, parsedOts, facts, constraints, constraintIdSet), parsedOts, facts), parsedSts)
      })
      activeDiagramId = d.activeDiagramId ?? d.diagrams[0].id
    } else {
      // v1: no diagrams at all — create one from element x,y positions
      const occurrences = [
        ...parsedOts.map(o => ({ id: `occ_${uid()}`, schemaElementId: o.id, x: o.x ?? 0, y: o.y ?? 0 })),
        ...facts.map(f => ({ id: `occ_${uid()}`, schemaElementId: f.id, x: f.x ?? 0, y: f.y ?? 0 })),
      ]
      const constraintOccurrences = constraints.map(c => ({ id: `cocc_${uid()}`, schemaConstraintId: c.id, x: c.x ?? 0, y: c.y ?? 0, roleOccurrenceRefs: [] }))
      const subtypeOccurrences = []
      const subtypeEndpointOccs = {}
      for (const st of parsedSts) {
        const subOcc  = occurrences.find(o => o.schemaElementId === st.subId)
        const superOcc = occurrences.find(o => o.schemaElementId === st.superId)
        if (subOcc && superOcc) {
          subtypeOccurrences.push(st.id)
          subtypeEndpointOccs[st.id] = [{ subOccId: subOcc.id, superOccId: superOcc.id }]
        }
      }
      const diag = { ...mkDiagram('Main'), occurrences, constraintOccurrences, subtypeOccurrences, subtypeEndpointOccs }
      diagrams = [diag]
      activeDiagramId = diag.id
    }

    // Populations: keep only entries whose target element still exists.
    // Value types and ref-mode entities store flat strings; composite-PI
    // entities store arrays (possibly nested). Both must survive the round trip.
    const otIdSet = new Set(parsedOts.map(o => o.id))
    const rawPops = (d.populations && typeof d.populations === 'object') ? d.populations : {}
    const populations = {}
    const isStorable = v => typeof v === 'string' || (Array.isArray(v) && v.every(isStorable))
    for (const [otId, instances] of Object.entries(rawPops)) {
      if (!otIdSet.has(otId) || !Array.isArray(instances)) continue
      const clean = instances.filter(isStorable)
      if (clean.length) populations[otId] = clean
    }

    // Fact populations: keep entries whose fact still exists; resize tuples to current arity.
    // Identifying facts (ref-mode binary or composite-PI) are skipped — their
    // tuples are derived from the entity's population.
    const factById = new Map(facts.map(f => [f.id, f]))
    const rawFactPops = (d.factPopulations && typeof d.factPopulations === 'object') ? d.factPopulations : {}
    const factPopulations = {}
    for (const [fid, tuples] of Object.entries(rawFactPops)) {
      const fact = factById.get(fid)
      if (!fact || !Array.isArray(tuples)) continue
      if (isIdentifyingFact(fact, facts, parsedOts, constraints)) continue
      const arity = fact.arity ?? fact.roles?.length ?? 0
      if (arity < 1) continue
      const normalizeCell = (v) => {
        if (typeof v === 'string') return v
        if (Array.isArray(v)) return v.map(normalizeCell)
        return ''
      }
      const cleanTuples = tuples
        .filter(t => Array.isArray(t))
        .map(t => {
          const cells = t.map(normalizeCell)
          if (cells.length === arity) return cells
          if (cells.length < arity)  return [...cells, ...Array(arity - cells.length).fill('')]
          return cells.slice(0, arity)
        })
      if (cleanTuples.length) factPopulations[fid] = cleanTuples
    }

    // Subtype mappings: edgeId → array of supertype-side cell tuples. Kept only
    // for edges that still exist and don't inherit the PI.
    const stById = new Map(parsedSts.map(st => [st.id, st]))
    const rawStMaps = (d.subtypeMappings && typeof d.subtypeMappings === 'object') ? d.subtypeMappings : {}
    const subtypeMappings = {}
    for (const [edgeId, rows] of Object.entries(rawStMaps)) {
      const edge = stById.get(edgeId)
      if (!edge || !Array.isArray(rows)) continue
      if (edge.inheritsPreferredIdentifier !== false) continue
      const clean = rows
        .filter(r => Array.isArray(r))
        .map(r => r.map(v => typeof v === 'string' ? v : ''))
      if (clean.length) subtypeMappings[edgeId] = clean
    }

    // Nested-entity PI mappings: factId → array of PI values aligned with factPopulations.
    const rawNem = (d.nestedEntityMappings && typeof d.nestedEntityMappings === 'object') ? d.nestedEntityMappings : {}
    const nestedEntityMappings = {}
    for (const [fid, rows] of Object.entries(rawNem)) {
      const fact = factById.get(fid)
      if (!fact || !fact.objectified) continue
      if (!Array.isArray(rows)) continue
      const normalizePI = (v) => {
        if (typeof v === 'string') return v
        if (Array.isArray(v)) return v.map(c => (typeof c === 'string' ? c : ''))
        return ''
      }
      const clean = rows.map(normalizePI)
      if (clean.length) nestedEntityMappings[fid] = clean
    }

    const activeDiag = diagrams.find(d => d.id === activeDiagramId)
    const diagDS = activeDiag?.displaySettings ?? {}
    set({
      objectTypes: parsedOts,
      facts,
      subtypes:    parsedSts,
      constraints,
      diagrams,
      activeDiagramId,
      pan:  activeDiag?.pan  ?? { x: 0, y: 0 },
      zoom: activeDiag?.zoom ?? 1,
      populations,
      factPopulations,
      subtypeMappings,
      nestedEntityMappings,
      filePath, isDirty: false, selectedId: null, selectedKind: null, selectedOccurrenceId: null, multiSelectedOccurrenceIds: [],
      linkDraft: null, roleReconnectDraft: null,
      // Restore schema-level display settings (v2 files only; defaults kept for older files)
      ...(schemaDisplaySettings.mandatoryDotPosition  != null && { mandatoryDotPosition:    schemaDisplaySettings.mandatoryDotPosition }),
      ...(schemaDisplaySettings.showReferenceMode     != null && { showReferenceMode:        schemaDisplaySettings.showReferenceMode }),
      ...(schemaDisplaySettings.showRoleNames         != null && { showRoleNames:            schemaDisplaySettings.showRoleNames }),
      ...(schemaDisplaySettings.showSequenceMembership != null && { showSequenceMembership: schemaDisplaySettings.showSequenceMembership }),
      ...(schemaDisplaySettings.showConstraintQueries  != null && { showConstraintQueries:  schemaDisplaySettings.showConstraintQueries }),
      // Restore diagram-level display settings from the active diagram
      ...(diagDS.showMinimap != null && { showMinimap: diagDS.showMinimap }),
      ...(diagDS.minimapPos  != null && { minimapPos:  diagDS.minimapPos }),
    })
  },

  serialize() {
    const {
      objectTypes, facts, subtypes, constraints, diagrams, activeDiagramId,
      populations, factPopulations, subtypeMappings, nestedEntityMappings,
      pan, zoom,
      mandatoryDotPosition, showReferenceMode, showRoleNames,
      showSequenceMembership, showConstraintQueries,
      showMinimap, minimapPos,
    } = get()
    // Strip in-memory-only selection state; flush current pan/zoom + display settings into diagrams
    const cleanDiagrams = diagrams.map(({ multiSelectedIds: _, ...d }) => ({
      ...(d.id === activeDiagramId ? { ...d, pan, zoom } : d),
      displaySettings: { showMinimap, minimapPos },
    }))
    // Drop any stored identifying-fact populations — they are derived at runtime.
    const cleanFactPops = {}
    for (const [fid, tuples] of Object.entries(factPopulations ?? {})) {
      const f = facts.find(ff => ff.id === fid)
      if (!f || isIdentifyingFact(f, facts, objectTypes, constraints)) continue
      cleanFactPops[fid] = tuples
    }
    // Drop subtypeMappings for inheriting edges (they're derived).
    const cleanStMaps = {}
    for (const [edgeId, rows] of Object.entries(subtypeMappings ?? {})) {
      const edge = subtypes.find(st => st.id === edgeId)
      if (!edge) continue
      if (edge.inheritsPreferredIdentifier !== false) continue
      cleanStMaps[edgeId] = rows
    }
    // Only keep nestedEntityMappings for facts that still exist.
    const cleanNem = {}
    for (const [fid, rows] of Object.entries(nestedEntityMappings ?? {})) {
      if (facts.find(f => f.id === fid && f.objectified)) cleanNem[fid] = rows
    }
    return JSON.stringify({
      version: 2,
      schema: {
        objectTypes,
        factTypes:            facts,
        subtypes,
        externalConstraints:  constraints,
        displaySettings: {
          mandatoryDotPosition,
          showReferenceMode,
          showRoleNames,
          showSequenceMembership,
          showConstraintQueries,
        },
      },
      diagrams: cleanDiagrams, activeDiagramId,
      populations:          populations    ?? {},
      factPopulations:      cleanFactPops,
      subtypeMappings:      cleanStMaps,
      nestedEntityMappings: cleanNem,
    }, null, 2)
  },

  setFilePath(p) { set({ filePath: p }) },
  markClean()    { set({ isDirty: false }) },

  // ── object types ────────────────────────────────────────────────────────

  addEntity(x, y) {
    const base = mkEntity(Math.round(x), Math.round(y))
    set(s => {
      const used = new Set(s.objectTypes.map(o => o.name).concat(s.facts.map(f => f.objectifiedName).filter(Boolean)))
      const e = { ...base, name: makeUniqueName('Entity', used) }
      return {
        objectTypes: [...s.objectTypes, e],
        diagrams: s.diagrams.map(d => d.id !== s.activeDiagramId ? d : addOccIfAbsent(d, e.id, e.x, e.y)),
        isDirty: true, selectedId: e.id, selectedKind: 'entity',
      }
    })
    return base.id
  },

  addValue(x, y) {
    const base = mkValue(Math.round(x), Math.round(y))
    set(s => {
      const used = new Set(s.objectTypes.map(o => o.name).concat(s.facts.map(f => f.objectifiedName).filter(Boolean)))
      const v = { ...base, name: makeUniqueName('Value', used) }
      return {
        objectTypes: [...s.objectTypes, v],
        diagrams: s.diagrams.map(d => d.id !== s.activeDiagramId ? d : addOccIfAbsent(d, v.id, v.x, v.y)),
        isDirty: true, selectedId: v.id, selectedKind: 'value',
      }
    })
    return base.id
  },

  // ── notes ────────────────────────────────────────────────────────────────

  addNote(x, y) {
    const note = mkNote(x, y)
    set(s => ({
      diagrams: s.diagrams.map(d => d.id !== s.activeDiagramId ? d
        : { ...d, notes: [...(d.notes ?? []), note] }),
      isDirty: true, selectedId: note.id, selectedKind: 'note',
    }))
  },

  updateNote(id, patch) {
    set(s => ({
      diagrams: s.diagrams.map(d => d.id !== s.activeDiagramId ? d
        : { ...d, notes: (d.notes ?? []).map(n => n.id === id ? { ...n, ...patch } : n) }),
      isDirty: true,
    }))
  },

  deleteNote(id) {
    set(s => ({
      diagrams: s.diagrams.map(d => d.id !== s.activeDiagramId ? d
        : { ...d, notes: (d.notes ?? []).filter(n => n.id !== id) }),
      ...(s.selectedId === id ? { selectedId: null, selectedKind: null } : {}),
      noteConnectorDraft: null,
      noteRemoveSubjectDraft: null,
      isDirty: true,
    }))
  },

  startNoteConnector(noteId)      { set({ noteConnectorDraft: { noteId }, noteRemoveSubjectDraft: null }) },
  cancelNoteConnector()           { set({ noteConnectorDraft: null }) },
  startNoteRemoveSubject(noteId)  { set({ noteRemoveSubjectDraft: { noteId }, noteConnectorDraft: null }) },
  cancelNoteRemoveSubject()       { set({ noteRemoveSubjectDraft: null }) },

  addNoteConnector(noteId, targetId) {
    set(s => ({
      diagrams: s.diagrams.map(d => d.id !== s.activeDiagramId ? d : {
        ...d,
        notes: (d.notes ?? []).map(n => n.id !== noteId ? n : {
          ...n,
          connectors: [...(n.connectors ?? []), { id: uid(), targetId }],
        }),
      }),
      noteConnectorDraft: null,
      isDirty: true,
    }))
  },

  removeNoteConnector(noteId, connId) {
    set(s => ({
      diagrams: s.diagrams.map(d => d.id !== s.activeDiagramId ? d : {
        ...d,
        notes: (d.notes ?? []).map(n => n.id !== noteId ? n : {
          ...n,
          connectors: (n.connectors ?? []).filter(c => c.id !== connId),
        }),
      }),
      isDirty: true,
    }))
  },

  updateObjectType(id, patch) {
    set(s => {
      const ot = s.objectTypes.find(o => o.id === id)

      // When an entity is renamed and its old name was a prefix of the ref-mode
      // value type's name, rename the VT to keep the relationship visible.
      // Other consumers of the same VT re-derive their displayed label naturally.
      let vtRename = null
      if (ot?.kind === 'entity' && patch.name !== undefined && patch.name !== ot.name) {
        const rm = findRefMode(ot, s.facts, s.objectTypes)
        if (rm) {
          const vt = s.objectTypes.find(o => o.id === rm.vtId)
          if (vt && vt.name.length > ot.name.length && vt.name.startsWith(ot.name)) {
            const suffix = vt.name.slice(ot.name.length)
            vtRename = { vtId: vt.id, newName: patch.name + suffix }
          }
        }
      }

      return {
        objectTypes: s.objectTypes.map(o =>
          o.id === id              ? { ...o, ...patch } :
          o.id === vtRename?.vtId  ? { ...o, name: vtRename.newName } : o
        ),
        isDirty: true,
      }
    })
  },

  // Single entry point for editing the ref-mode label from the entity inspector.
  // - empty label, ref mode exists   → demote PI (fact + VT survive as ordinary
  //                                      elements; auto-expand them in this diagram).
  // - non-empty, no ref mode         → create VT + binary FT with PI (shorthand display).
  // - non-empty, ref mode exists     → rename the linked VT; reuses an existing VT
  //                                      by that name if one already exists.
  setEntityRefModeLabel(entityId, label) {
    const trimmed = (label ?? '').trim()
    const s = get()
    const entity = s.objectTypes.find(o => o.id === entityId)
    if (!entity || entity.kind !== 'entity') return
    const current = findRefMode(entity, s.facts, s.objectTypes)

    if (trimmed === '') {
      if (!current) return
      set(state => clearRefModePI(state, entityId, current))
      return
    }

    const targetVtName = vtNameFromLabel(entity.name, trimmed)
    if (current) {
      const existingMatch = s.objectTypes.find(o => o.id !== current.vtId && o.kind === 'value' && o.name === targetVtName)
      if (existingMatch) {
        // Rewire fact to the existing VT and drop the now-orphan one if unused elsewhere.
        set(state => {
          const oldVtUsedElsewhere = state.facts.some(f =>
            f.id !== current.factId && f.roles.some(r => r.objectTypeId === current.vtId)
          )
          const newFacts = state.facts.map(f => {
            if (f.id !== current.factId) return f
            const roles = f.roles.map((r, i) => i === current.vtRoleIndex ? { ...r, objectTypeId: existingMatch.id } : r)
            return { ...f, roles }
          })
          const nextOts = oldVtUsedElsewhere
            ? state.objectTypes
            : state.objectTypes.filter(o => o.id !== current.vtId)
          const nextDiagrams = state.diagrams.map(d => {
            const entityOccIds = new Set((d.occurrences ?? []).filter(o => o.schemaElementId === entityId).map(o => o.id))
            let nd = oldVtUsedElsewhere ? d : rmOcc(d, current.vtId)
            // Remove stale owned FT occs — their roleOccurrenceMap points to the now-deleted vtOcc
            nd = { ...nd, occurrences: (nd.occurrences ?? []).filter(o =>
              !(o.schemaElementId === current.factId && entityOccIds.has(o.refModeOwnerOccId))
            )}
            // Create fresh owned VT/FT occs wired to the new (existing) VT
            nd = addOwnedRefModeOccsIfAbsent(nd, entityId, existingMatch.id, existingMatch.x ?? 0, existingMatch.y ?? 0, current.factId, 0, 0, current.vtRoleIndex)
            return nd
          })
          return { objectTypes: nextOts, facts: newFacts, diagrams: nextDiagrams, isDirty: true }
        })
      } else {
        set(state => ({
          objectTypes: state.objectTypes.map(o => o.id === current.vtId ? { ...o, name: targetVtName } : o),
          isDirty: true,
        }))
      }
      return
    }

    const existing = s.objectTypes.find(o => o.kind === 'value' && o.name === targetVtName)
    const matchFact = existing ? findMatchingRefModeFact(entity.id, existing.id, s.facts) : null
    set(state => applyFreshRefMode(state, entity, targetVtName, existing, matchFact, entity.id))
  },

  setNestedRefModeLabel(factId, label) {
    const trimmed = (label ?? '').trim()
    const s = get()
    const fact = s.facts.find(f => f.id === factId)
    if (!fact || !fact.objectified || fact.objectifiedKind === 'value') return

    // Store the display annotation on the fact.
    const setDisplay = (v) => {
      set(state => ({
        facts: state.facts.map(f => f.id === factId ? { ...f, objectifiedRefMode: v || null } : f),
        isDirty: true,
      }))
    }

    if (trimmed === '') {
      const current = findRefMode(fact, s.facts, s.objectTypes)
      setDisplay(null)
      if (!current) return
      set(state => clearRefModePI(state, factId, current))
      return
    }

    setDisplay(trimmed)
    const entityName = fact.objectifiedName || 'Entity'
    const targetVtName = vtNameFromLabel(entityName, trimmed)
    const current = findRefMode(fact, s.facts, s.objectTypes)

    if (current) {
      set(state => ({
        objectTypes: state.objectTypes.map(o => o.id === current.vtId ? { ...o, name: targetVtName } : o),
        isDirty: true,
      }))
      return
    }

    const existing = s.objectTypes.find(o => o.kind === 'value' && o.name === targetVtName)
    const wrapEntity = { id: factId, name: entityName, x: fact.x, y: fact.y }
    const matchFact = existing ? findMatchingRefModeFact(factId, existing.id, s.facts) : null
    set(state => applyFreshRefMode(state, wrapEntity, targetVtName, existing, matchFact, null))
  },

  // ── populations (sample data per object type) ──────────────────────────
  addPopulationInstance(otId, value = '') {
    set(s => {
      const current = s.populations?.[otId] ?? []
      return {
        populations: { ...s.populations, [otId]: [...current, value] },
        isDirty: true,
      }
    })
  },

  updatePopulationInstance(otId, index, value) {
    set(s => {
      const current = s.populations?.[otId] ?? []
      if (index < 0 || index >= current.length) return {}
      const next = current.slice()
      next[index] = value
      return {
        populations: { ...s.populations, [otId]: next },
        isDirty: true,
      }
    })
  },

  removePopulationInstance(otId, index) {
    set(s => {
      const current = s.populations?.[otId] ?? []
      if (index < 0 || index >= current.length) return {}
      const removedValue = current[index]
      const next = current.slice()
      next.splice(index, 1)
      const populations = { ...s.populations }
      if (next.length === 0) delete populations[otId]
      else populations[otId] = next

      // Cascade: if the entity/nested-entity has a ref-mode and the VT is not
      // independent, remove the VT instance unless still used elsewhere.
      if (isCompleteValue(removedValue)) {
        const ot = s.objectTypes.find(o => o.id === otId) ?? s.facts.find(f => f.id === otId)
        if (ot) {
          const rm = findRefMode(ot, s.facts, s.objectTypes)
          if (rm) {
            const vt = s.objectTypes.find(o => o.id === rm.vtId)
            if (vt && !vt.isIndependent) {
              const stillInEntity = next.includes(removedValue)
              const stillInFacts = !stillInEntity && s.facts.some(f =>
                f.id !== rm.factId &&
                f.roles?.some((r, ri) => r?.objectTypeId === rm.vtId &&
                  (s.factPopulations?.[f.id] ?? []).some(tuple =>
                    Array.isArray(tuple) && tuple[ri] === removedValue
                  )
                )
              )
              if (!stillInEntity && !stillInFacts) {
                const vtPop = populations[rm.vtId] ?? []
                const vtIdx = vtPop.indexOf(removedValue)
                if (vtIdx !== -1) {
                  const nextVt = vtPop.slice()
                  nextVt.splice(vtIdx, 1)
                  if (nextVt.length === 0) delete populations[rm.vtId]
                  else populations[rm.vtId] = nextVt
                }
              }
            }
          }
        }
      }

      return { populations, isDirty: true }
    })
  },

  // ── composite-PI entity populations ────────────────────────────────────
  // For entities with a composite preferred identifier, instances are tuples
  // (one cell per identifying role, in the order returned by
  // findCompositePI(...).identifyingRoleIndices). Stored as string[][] under
  // populations[entityId].

  addEntityTuple(entityId, width) {
    set(s => {
      if (!Number.isInteger(width) || width < 1) return {}
      const current = s.populations?.[entityId] ?? []
      const tuple = Array(width).fill('')
      return {
        populations: { ...s.populations, [entityId]: [...current, tuple] },
        isDirty: true,
      }
    })
  },

  updateEntityTupleCell(entityId, tupleIndex, cellIndex, value) {
    set(s => {
      const current = s.populations?.[entityId] ?? []
      if (tupleIndex < 0 || tupleIndex >= current.length) return {}
      const oldTuple = current[tupleIndex]
      if (!Array.isArray(oldTuple) || cellIndex < 0 || cellIndex >= oldTuple.length) return {}
      const next = current.slice()
      const newTuple = oldTuple.slice()
      newTuple[cellIndex] = value
      next[tupleIndex] = newTuple
      return {
        populations: { ...s.populations, [entityId]: next },
        isDirty: true,
      }
    })
  },

  removeEntityTuple(entityId, tupleIndex) {
    set(s => {
      const current = s.populations?.[entityId] ?? []
      if (tupleIndex < 0 || tupleIndex >= current.length) return {}
      const next = current.slice()
      next.splice(tupleIndex, 1)
      const populations = { ...s.populations }
      if (next.length === 0) delete populations[entityId]
      else populations[entityId] = next
      return { populations, isDirty: true }
    })
  },

  // Commit a composite-PI tuple cell on blur: cascade the cell value to the
  // corresponding identifying-role player's population (and further via
  // propagateValueToPlayer). The cell value may be a string or a (possibly
  // nested) tuple; partial values are skipped.
  commitEntityTupleCell(entityId, tupleIndex, cellIndex) {
    set(s => {
      const entity = s.objectTypes.find(o => o.id === entityId)
      if (!entity || entity.kind !== 'entity') return {}
      // Composite-PI may be owned by this entity or inherited from a supertype
      // (regular or nested-entity). For inherited PIs the synthetic cp from
      // findInheritedPI still maps cellIndex → role player of the identifying
      // fact, so per-cell cascade works identically.
      let cp = findCompositePI(entity, s.facts, s.objectTypes, s.constraints)
      if (!cp) {
        const inh = findInheritedPI(entity, s.facts, s.objectTypes, s.subtypes, s.constraints)
        if (inh?.kind === 'compositePI') cp = inh.cp
      }
      if (!cp) return {}
      if (cellIndex < 0 || cellIndex >= cp.identifyingRoleIndices.length) return {}
      const tuple = s.populations?.[entityId]?.[tupleIndex]
      if (!Array.isArray(tuple)) return {}
      const raw = tuple[cellIndex]
      const value = typeof raw === 'string' ? raw.trim() : raw
      if (!isCompleteValue(value)) return {}
      const factIdForCell = cp.factIds ? cp.factIds[cellIndex] : cp.factId
      const fact = s.facts.find(f => f.id === factIdForCell)
      const roleIndex = cp.identifyingRoleIndices[cellIndex]
      const playerOtId = fact?.roles?.[roleIndex]?.objectTypeId
      if (!playerOtId) return {}
      const populations = { ...s.populations }
      const factPopulations = { ...s.factPopulations }
      const ctx = { facts: s.facts, objectTypes: s.objectTypes, subtypes: s.subtypes, constraints: s.constraints }
      let changed = propagateValueToPlayer(populations, factPopulations, playerOtId, value, ctx)
      // If the whole tuple is now complete, also cascade it from the entity
      // itself so inheriting supertypes (including nested-entity supertypes
      // whose factPopulations should mirror this entity's tuples) get the row
      // automatically — no manual "Propagate to supertype" click needed.
      if (isCompleteValue(tuple)) {
        if (propagateValueToPlayer(populations, factPopulations, entityId, tuple, ctx)) changed = true
      }
      return changed ? { populations, factPopulations, isDirty: true } : {}
    })
  },

  // Propagate a list of values into `targetOtId`'s population, cascading
  // further via the standard rules (inheriting supertypes, ref-mode VTs,
  // composite-PI identifying-role players). Used by the "Propagate" buttons.
  propagateValues(targetOtId, values) {
    set(s => {
      if (!Array.isArray(values) || values.length === 0) return {}
      const populations = { ...s.populations }
      const factPopulations = { ...s.factPopulations }
      const ctx = { facts: s.facts, objectTypes: s.objectTypes, subtypes: s.subtypes, constraints: s.constraints }
      let changed = false
      for (const v of values) {
        if (propagateValueToPlayer(populations, factPopulations, targetOtId, v, ctx, true)) changed = true
      }
      return changed ? { populations, factPopulations, isDirty: true } : {}
    })
  },

  // Commit an entity-population instance on blur: cascade the value to
  // inheriting supertypes and (for ref-mode entities) to the ref-mode VT.
  // For composite-PI entity tuples, each cell is committed via
  // commitEntityTupleCell instead — this action handles single-string
  // populations (ref-mode entities, inheriting subtypes thereof).
  commitPopulationInstance(otId, instanceIndex) {
    set(s => {
      const ot = s.objectTypes.find(o => o.id === otId)
      if (!ot || ot.kind !== 'entity') return {}
      const value = s.populations?.[otId]?.[instanceIndex]
      if (typeof value !== 'string') return {}
      const trimmed = value.trim()
      if (trimmed === '') return {}
      const populations = { ...s.populations }
      const factPopulations = { ...s.factPopulations }
      const ctx = { facts: s.facts, objectTypes: s.objectTypes, subtypes: s.subtypes, constraints: s.constraints }
      // propagateValueToPlayer would re-add it to otId itself; that's already
      // there. We want propagation TO supertypes and ref-mode VT, so call the
      // helper which is idempotent for the current entity.
      const changed = propagateValueToPlayer(populations, factPopulations, otId, trimmed, ctx)
      return changed ? { populations, factPopulations, isDirty: true } : {}
    })
  },

  // ── subtype-edge mapping populations ───────────────────────────────────
  // For non-inheriting subtype edges: rows hold the supertype-side identifying
  // cells corresponding to each subtype instance (by position in
  // populations[subtypeId]). The subtype-side cells are derived from the
  // subtype's population and aren't stored here.

  updateSubtypeMappingCell(edgeId, rowIndex, cellIndex, value) {
    set(s => {
      if (rowIndex < 0 || cellIndex < 0) return {}
      const current = s.subtypeMappings?.[edgeId] ?? []
      const next = current.slice()
      while (next.length <= rowIndex) next.push([])
      const row = Array.isArray(next[rowIndex]) ? next[rowIndex].slice() : []
      while (row.length <= cellIndex) row.push('')
      row[cellIndex] = value
      next[rowIndex] = row
      return {
        subtypeMappings: { ...s.subtypeMappings, [edgeId]: next },
        isDirty: true,
      }
    })
  },

  // Commit a non-inheriting subtype-mapping cell on blur. When the whole
  // mapping row is complete (at every depth), the implied supertype instance
  // (single value or tuple, possibly nested) is propagated to the supertype's
  // population, cascading further. Partial rows do nothing.
  commitSubtypeMappingCell(edgeId, rowIndex, cellIndex) { // eslint-disable-line no-unused-vars
    set(s => {
      const edge = s.subtypes.find(st => st.id === edgeId)
      if (!edge || edge.inheritsPreferredIdentifier !== false) return {}
      const sup = s.objectTypes.find(o => o.id === edge.superId)
      if (!sup) return {}
      const shape = getEntityIdentifierShape(sup, s.facts, s.objectTypes, s.subtypes, s.constraints)
      if (!shape) return {}
      const row = s.subtypeMappings?.[edgeId]?.[rowIndex]
      if (!Array.isArray(row)) return {}
      const width = shape.columns.length
      const cells = Array.from({ length: width }, (_, ci) => row[ci])
      const supValue = width === 1 ? cells[0] : cells
      if (!isCompleteValue(supValue)) return {}
      const populations = { ...s.populations }
      const factPopulations = { ...s.factPopulations }
      const ctx = { facts: s.facts, objectTypes: s.objectTypes, subtypes: s.subtypes, constraints: s.constraints }
      const changed = propagateValueToPlayer(populations, factPopulations, sup.id, supValue, ctx)
      return changed ? { populations, factPopulations, isDirty: true } : {}
    })
  },

  // ── fact-type populations ──────────────────────────────────────────────
  addFactTuple(factId) {
    set(s => {
      const fact = s.facts.find(f => f.id === factId)
      if (!fact) return {}
      const arity = fact.arity ?? fact.roles?.length ?? 0
      if (arity < 1) return {}
      const current = s.factPopulations?.[factId] ?? []
      // Each cell is initialised based on its role's player shape: a single
      // empty string for plain roles, or a fresh sub-tuple for composite-PI
      // entity roles.
      const tuple = (fact.roles ?? []).slice(0, arity).map(role => {
        const shape = getRoleCellShape(role, s.facts, s.objectTypes, s.subtypes, s.constraints)
        return shape.kind === 'tuple' ? Array(shape.width).fill('') : ''
      })
      return {
        factPopulations: { ...s.factPopulations, [factId]: [...current, tuple] },
        isDirty: true,
      }
    })
  },

  updateFactTupleCell(factId, tupleIndex, roleIndex, value) {
    set(s => {
      const current = s.factPopulations?.[factId] ?? []
      if (tupleIndex < 0 || tupleIndex >= current.length) return {}
      const oldTuple = current[tupleIndex]
      if (roleIndex < 0 || roleIndex >= oldTuple.length) return {}
      const next = current.slice()
      const newTuple = oldTuple.slice()
      newTuple[roleIndex] = value
      next[tupleIndex] = newTuple
      return {
        factPopulations: { ...s.factPopulations, [factId]: next },
        isDirty: true,
      }
    })
  },

  removeFactTuple(factId, tupleIndex) {
    set(s => {
      const current = s.factPopulations?.[factId] ?? []
      if (tupleIndex < 0 || tupleIndex >= current.length) return {}
      const next = current.slice()
      next.splice(tupleIndex, 1)
      const factPopulations = { ...s.factPopulations }
      if (next.length === 0) delete factPopulations[factId]
      else factPopulations[factId] = next
      return { factPopulations, isDirty: true }
    })
  },

  commitFactTupleCell(factId, tupleIndex, roleIndex) {
    set(s => {
      const fact = s.facts.find(f => f.id === factId)
      if (!fact) return {}
      const tuple = s.factPopulations?.[factId]?.[tupleIndex]
      if (!Array.isArray(tuple)) return {}
      const cell = tuple[roleIndex]
      if (typeof cell !== 'string') return {}
      const trimmed = cell.trim()
      if (trimmed === '') return {}
      const role = fact.roles?.[roleIndex]
      if (!role?.objectTypeId) return {}
      // If the role connects to an objectified fact with a reference mode,
      // propagate the identifier to the ref-mode VT instead of the fact.
      let targetId = role.objectTypeId
      const targetPlayer = findRolePlayer(targetId, s.objectTypes, s.facts)
      if (targetPlayer?.objectified) {
        const rm = findRefMode(targetPlayer, s.facts, s.objectTypes)
        if (rm) targetId = rm.vtId
      }
      const populations = { ...s.populations }
      const factPopulations = { ...s.factPopulations }
      const ctx = { facts: s.facts, objectTypes: s.objectTypes, subtypes: s.subtypes, constraints: s.constraints }
      const changed = propagateValueToPlayer(populations, factPopulations, targetId, trimmed, ctx)
      return changed ? { populations, factPopulations, isDirty: true } : {}
    })
  },

  // ── nested-entity combined-table populations ────────────────────────────
  // For objectified facts with an explicit PI. Rows are aligned by index:
  //   nestedEntityMappings[factId][i] = PI value for row i
  //   factPopulations[factId][i]      = fact tuple for row i
  // Both arrays grow and shrink together via addNestedEntityRow / removeNestedEntityRow.

  addNestedEntityRow(factId) {
    set(s => {
      const fact = s.facts.find(f => f.id === factId)
      if (!fact || !fact.objectified) return {}
      const arity = fact.arity ?? fact.roles?.length ?? 0
      // Fact side: one empty cell per role.
      const currentFact = s.factPopulations?.[factId] ?? []
      const factTuple = (fact.roles ?? []).slice(0, arity).map(role => {
        const shape = getRoleCellShape(role, s.facts, s.objectTypes, s.subtypes, s.constraints)
        return shape.kind === 'tuple' ? Array(shape.width).fill('') : ''
      })
      // PI side: derive width from the entity identifier shape.
      const piShape = getEntityIdentifierShape(fact, s.facts, s.objectTypes, s.subtypes, s.constraints)
      const piWidth = piShape?.columns?.length ?? 0
      const currentPop = s.nestedEntityMappings?.[factId] ?? []
      const piValue = piWidth <= 1 ? '' : Array(piWidth).fill('')
      return {
        factPopulations:      { ...s.factPopulations,      [factId]: [...currentFact, factTuple] },
        nestedEntityMappings: { ...s.nestedEntityMappings, [factId]: [...currentPop,  piValue]   },
        isDirty: true,
      }
    })
  },

  // Add PI values to a nested entity type's population without requiring the
  // caller to know about the parallel factPopulations structure.  For each
  // piValue in piValues that is not already present, one row is appended to
  // both nestedEntityMappings (the PI value) and factPopulations (an empty
  // fact tuple).  This is the "propagate to nested entity" action used when a
  // connecting fact tuple references an N instance that does not yet exist.
  propagateToNestedEntity(factId, piValues) {
    set(s => {
      const fact = s.facts.find(f => f.id === factId)
      if (!fact || !fact.objectified) return {}
      const arity = fact.arity ?? fact.roles?.length ?? 0
      const currentFact = s.factPopulations?.[factId] ?? []
      const currentPop  = s.nestedEntityMappings?.[factId] ?? []
      const existingKeys = new Set(currentPop.map(v => JSON.stringify(v)))
      const nextFact = [...currentFact]
      const nextPop  = [...currentPop]
      let changed = false
      for (const piValue of (piValues ?? [])) {
        const key = JSON.stringify(piValue)
        if (existingKeys.has(key)) continue
        existingKeys.add(key)
        const factTuple = (fact.roles ?? []).slice(0, arity).map(role => {
          const shape = getRoleCellShape(role, s.facts, s.objectTypes, s.subtypes, s.constraints)
          return shape.kind === 'tuple' ? Array(shape.width).fill('') : ''
        })
        nextFact.push(factTuple)
        nextPop.push(piValue)
        changed = true
      }
      if (!changed) return {}
      const factPopulations      = { ...s.factPopulations,      [factId]: nextFact }
      const nestedEntityMappings = { ...s.nestedEntityMappings, [factId]: nextPop  }
      return { factPopulations, nestedEntityMappings, isDirty: true }
    })
  },

  removeNestedEntityRow(factId, rowIndex) {
    set(s => {
      const currentFact = s.factPopulations?.[factId] ?? []
      const currentPop  = s.nestedEntityMappings?.[factId] ?? []
      const maxLen = Math.max(currentFact.length, currentPop.length)
      if (rowIndex < 0 || rowIndex >= maxLen) return {}
      const removedValue = currentPop[rowIndex]
      const nextFact = currentFact.slice(); nextFact.splice(rowIndex, 1)
      const nextPop  = currentPop.slice();  nextPop.splice(rowIndex,  1)
      const factPopulations      = { ...s.factPopulations }
      const nestedEntityMappings = { ...s.nestedEntityMappings }
      if (nextFact.length === 0) delete factPopulations[factId]
      else factPopulations[factId] = nextFact
      if (nextPop.length === 0) delete nestedEntityMappings[factId]
      else nestedEntityMappings[factId] = nextPop

      // Cascade: if the nested entity has a ref-mode and the VT is not
      // independent, remove the VT instance unless still used elsewhere.
      // factPopulations is already updated (row removed), so checking it for
      // factId gives the post-deletion state.
      let populations = s.populations
      if (isCompleteValue(removedValue)) {
        const fact = s.facts.find(f => f.id === factId)
        if (fact) {
          const rm = findRefMode(fact, s.facts, s.objectTypes)
          if (rm) {
            const vt = s.objectTypes.find(o => o.id === rm.vtId)
            if (vt && !vt.isIndependent) {
              const stillInNested = nextPop.includes(removedValue)
              const stillInFacts = !stillInNested && s.facts.some(f =>
                f.id !== factId &&
                f.roles?.some((r, ri) => r?.objectTypeId === rm.vtId &&
                  (s.factPopulations?.[f.id] ?? []).some(tuple =>
                    Array.isArray(tuple) && tuple[ri] === removedValue
                  )
                )
              )
              if (!stillInNested && !stillInFacts) {
                populations = { ...populations }
                const vtPop = populations[rm.vtId] ?? []
                const vtIdx = vtPop.indexOf(removedValue)
                if (vtIdx !== -1) {
                  const nextVt = vtPop.slice()
                  nextVt.splice(vtIdx, 1)
                  if (nextVt.length === 0) delete populations[rm.vtId]
                  else populations[rm.vtId] = nextVt
                }
              }
            }
          }
        }
      }

      return { factPopulations, nestedEntityMappings, populations, isDirty: true }
    })
  },

  updateNestedEntityPICell(factId, rowIndex, cellIndex, value) {
    set(s => {
      const current = s.nestedEntityMappings?.[factId] ?? []
      if (rowIndex < 0 || rowIndex >= current.length) return {}
      const oldVal = current[rowIndex]
      let newVal
      if (Array.isArray(oldVal)) {
        const arr = oldVal.slice()
        while (arr.length <= cellIndex) arr.push('')
        arr[cellIndex] = value
        newVal = arr
      } else {
        newVal = value  // single-column PI (ref-mode): string
      }
      const next = current.slice(); next[rowIndex] = newVal
      return { nestedEntityMappings: { ...s.nestedEntityMappings, [factId]: next }, isDirty: true }
    })
  },

  // On blur of any PI cell: propagate the complete PI value to the PI-defining roles.
  commitNestedEntityPICell(factId, rowIndex) {
    set(s => {
      const fact = s.facts.find(f => f.id === factId)
      if (!fact || !fact.objectified) return {}
      const piValue = s.nestedEntityMappings?.[factId]?.[rowIndex]
      if (!isCompleteValue(piValue)) return {}
      const populations      = { ...s.populations }
      const factPopulations  = { ...s.factPopulations }
      const ctx = { facts: s.facts, objectTypes: s.objectTypes, subtypes: s.subtypes, constraints: s.constraints }
      let changed = false
      const rm = findRefMode(fact, s.facts, s.objectTypes)
      if (rm) {
        if (typeof piValue === 'string') {
          if (propagateValueToPlayer(populations, factPopulations, rm.vtId, piValue, ctx)) changed = true
        }
      } else {
        let cp = findCompositePI(fact, s.facts, s.objectTypes, s.constraints)
        if (!cp) {
          const inh = findInheritedPI(fact, s.facts, s.objectTypes, s.subtypes, s.constraints)
          if (inh?.kind === 'compositePI') cp = inh.cp
        }
        if (cp && Array.isArray(piValue)) {
          const piFact = s.facts.find(f => f.id === cp.factId)
          if (piFact) {
            cp.identifyingRoleIndices.forEach((roleIndex, ci) => {
              const playerOtId = piFact.roles?.[roleIndex]?.objectTypeId
              const cellValue  = piValue[ci]
              if (playerOtId && isCompleteValue(cellValue)) {
                if (propagateValueToPlayer(populations, factPopulations, playerOtId, cellValue, ctx)) changed = true
              }
            })
          }
        }
      }
      return changed ? { populations, factPopulations, isDirty: true } : {}
    })
  },

  moveObjectType(id, x, y) {
    set(s => ({
      diagrams: s.diagrams.map(d => d.id !== s.activeDiagramId ? d : patchOcc(d, id, { x, y })),
      isDirty: true,
    }))
  },

  // Move an occurrence by its own occurrence ID (for multi-occurrence elements)
  moveOccurrence(occId, x, y) {
    set(s => ({
      diagrams: s.diagrams.map(d => d.id !== s.activeDiagramId ? d : patchOccById(d, occId, { x: Math.round(x), y: Math.round(y) })),
      isDirty: true,
    }))
  },

  // ── occurrence-level role reconnect ──────────────────────────────────────

  updateRoleOccurrenceMap(factOccId, roleIndex, otOccurrenceId, diagramId) {
    set(s => ({
      diagrams: s.diagrams.map(d =>
        d.id !== diagramId ? d : {
          ...d,
          occurrences: (d.occurrences ?? []).map(o =>
            o.id !== factOccId ? o
            : { ...o, roleOccurrenceMap: { ...(o.roleOccurrenceMap ?? {}), [String(roleIndex)]: otOccurrenceId } }
          ),
        }
      ),
      isDirty: true,
    }))
  },

  startRoleReconnect(factOccId, roleIndex, factSchemaId, currentOtSchemaId, diagramId) {
    set({ roleReconnectDraft: { factOccId, roleIndex, factSchemaId, currentOtSchemaId, diagramId } })
  },

  cancelRoleReconnect() {
    set({ roleReconnectDraft: null })
  },

  reconnectRoleOccurrence(newOtOccId) {
    set(s => {
      const draft = s.roleReconnectDraft
      if (!draft) return {}
      const { factOccId, roleIndex, factSchemaId, diagramId } = draft

      const diag = s.diagrams.find(d => d.id === diagramId)
      if (!diag) return { roleReconnectDraft: null }

      const factOcc = (diag.occurrences ?? []).find(o => o.id === factOccId)
      if (!factOcc) return { roleReconnectDraft: null }

      const fact = s.facts.find(f => f.id === factSchemaId)
      if (!fact) return { roleReconnectDraft: null }

      const role = fact.roles[roleIndex]
      if (!role) return { roleReconnectDraft: null }

      const newOtOcc = (diag.occurrences ?? []).find(o => o.id === newOtOccId)
      if (!newOtOcc) return { roleReconnectDraft: null }

      const oldSchemaOtId = role.objectTypeId
      const newSchemaOtId = newOtOcc.schemaElementId

      const riKey = String(roleIndex)

      if (oldSchemaOtId === newSchemaOtId) {
        // Case 1: same schema type — only update FTO1's map
        const updatedDiagrams = s.diagrams.map(d =>
          d.id !== diagramId ? d
          : patchOccById(d, factOccId, {
              roleOccurrenceMap: { ...(factOcc.roleOccurrenceMap ?? {}), [riKey]: newOtOccId }
            })
        )
        return { diagrams: updatedDiagrams, roleReconnectDraft: null, isDirty: true }
      }

      // Case 2: different schema type → schema change
      const updatedFacts = s.facts.map(f =>
        f.id !== fact.id ? f
        : { ...f, roles: f.roles.map((r, i) => i !== roleIndex ? r : { ...r, objectTypeId: newSchemaOtId }) }
      )

      const updatedDiagrams = s.diagrams.map(d => {
        const factOccsInDiag = (d.occurrences ?? []).filter(o => o.schemaElementId === fact.id)
        if (factOccsInDiag.length === 0) return d

        const newOtOccInDiag = (d.occurrences ?? []).find(o => o.schemaElementId === newSchemaOtId)
        if (!newOtOccInDiag) {
          // Case 2b-b2: remove all occurrences of this fact from the diagram
          return { ...d, occurrences: (d.occurrences ?? []).filter(o => o.schemaElementId !== fact.id) }
        }

        // Case 2a or 2b-b1
        const targetOtOccId = d.id === diagramId ? newOtOccId : newOtOccInDiag.id
        return {
          ...d,
          occurrences: (d.occurrences ?? []).map(o =>
            o.schemaElementId !== fact.id ? o
            : { ...o, roleOccurrenceMap: { ...(o.roleOccurrenceMap ?? {}), [riKey]: targetOtOccId } }
          )
        }
      })

      const syncedDiagrams = syncConstraints(updatedDiagrams, s.constraints, s.subtypes, updatedFacts)
      return { facts: updatedFacts, diagrams: syncedDiagrams, roleReconnectDraft: null, isDirty: true }
    })
  },

  // Add an extra occurrence of an element already in the diagram
  addExtraOccurrence(elementId, diagramId) {
    set(s => {
      const el = s.objectTypes.find(o => o.id === elementId) ?? s.facts.find(f => f.id === elementId)
      if (!el) return {}
      const diag = s.diagrams.find(d => d.id === diagramId)
      const existingCount = diag?.occurrences.filter(o => o.schemaElementId === elementId).length ?? 0
      const offset = existingCount * 40
      const x = (el.x ?? 100) + offset
      const y = (el.y ?? 100) + offset
      const newOcc = mkOcc(elementId, x, y)
      // If it's a fact, populate roleOccurrenceMap
      const isFact = s.facts.some(f => f.id === elementId)
      if (isFact && diag) {
        const fact = s.facts.find(f => f.id === elementId)
        newOcc.roleOccurrenceMap = buildRoleOccurrenceMap(fact, diag.occurrences)
      }
      return {
        diagrams: s.diagrams.map(d =>
          d.id !== diagramId ? d : { ...d, occurrences: [...(d.occurrences ?? []), newOcc] }
        ),
        isDirty: true,
      }
    })
  },

  deleteObjectType(id) {
    set(s => {
      const removedSubtypeIds = new Set(
        s.subtypes.filter(st => st.subId === id || st.superId === id).map(st => st.id)
      )
      const populations = { ...s.populations }
      delete populations[id]
      return {
        objectTypes: s.objectTypes.filter(o => o.id !== id),
        facts: s.facts.map(f => ({
          ...f,
          roles: f.roles.map(r => r.objectTypeId === id ? { ...r, objectTypeId: null } : r),
        })),
        subtypes: s.subtypes.filter(st => st.subId !== id && st.superId !== id),
        populations,
        constraints: s.constraints.map(c => ({
          ...c,
          subtypeIds: (c.subtypeIds || []).filter(sid => !removedSubtypeIds.has(sid)),
        })),
      diagrams: s.diagrams.map(d => {
        let nd = rmOcc(d, id)
        // Remove any implicit link positions that belong to the deleted OT's facts
        const newILP = Object.fromEntries(
          Object.entries(nd.implicitLinkPositions ?? {}).filter(([k]) => !k.startsWith(`${id}:il:`))
        )
        if (Object.keys(newILP).length !== Object.keys(nd.implicitLinkPositions ?? {}).length) {
          nd = { ...nd, implicitLinkPositions: newILP }
        }
        return nd
      }),
        selectedId: s.selectedId === id ? null : s.selectedId,
        isDirty: true,
      }
    })
  },

  // Per-diagram display toggle: show the ref mode's VT + FT as ordinary diagram
  // elements (instead of as shorthand inside the entity rect). The VT and FT
  // already exist as schema elements; this just adds them to elementIds and
  // marks the entity expanded in the target diagram.
  expandRefMode(otOccurrenceId, diagramId = null) {
    const { objectTypes, facts, activeDiagramId, diagrams } = get()
    const targetDiagramId = diagramId ?? activeDiagramId
    const targetDiagram = diagrams.find(d => d.id === targetDiagramId)
    const occ = targetDiagram?.occurrences?.find(o => o.id === otOccurrenceId)
    if (!occ) return
    const ot = objectTypes.find(o => o.id === occ.schemaElementId)
    const nested = !ot ? facts.find(f => f.id === occ.schemaElementId && f.objectified && f.objectifiedKind !== 'value') : null
    const owner = ot ?? nested
    if (!owner) return
    if (ot && ot.kind !== 'entity') return
    const rm = findRefMode(owner, facts, objectTypes)
    if (!rm) return
    const rmVt = objectTypes.find(o => o.id === rm.vtId)
    const rmFt = facts.find(f => f.id === rm.factId)
    set(s => ({
      diagrams: s.diagrams.map(d => {
        if (d.id !== targetDiagramId) return d
        if ((d.expandedRefModeOccs ?? []).includes(otOccurrenceId)) return d
        // Only create new owned occurrences if none already exist for this owner
        const ownerOcc2 = (d.occurrences ?? []).find(o => o.id === otOccurrenceId)
        const alreadyOwned = (d.occurrences ?? []).some(o => o.refModeOwnerOccId === otOccurrenceId)
        let newOccs = []
        if (!alreadyOwned && ownerOcc2) {
          const vtOcc = mkOcc(rm.vtId, ownerOcc2.x + 160, ownerOcc2.y, { refModeOwnerOccId: otOccurrenceId })
          const ftOcc = mkOcc(rm.factId, ownerOcc2.x + 80, ownerOcc2.y, {
            refModeOwnerOccId: otOccurrenceId,
            roleOccurrenceMap: {
              [String(1 - rm.vtRoleIndex)]: otOccurrenceId,
              [String(rm.vtRoleIndex)]: vtOcc.id,
            },
          })
          newOccs = [vtOcc, ftOcc]
        }
        return {
          ...d,
          occurrences: [...(d.occurrences ?? []), ...newOccs],
          expandedRefModeOccs: [...(d.expandedRefModeOccs ?? []), otOccurrenceId],
        }
      }),
      isDirty: true,
    }))
  },

  collapseRefMode(otOccurrenceId, diagramId = null) {
    const { activeDiagramId, facts, objectTypes } = get()
    const targetDiagramId = diagramId ?? activeDiagramId
    set(s => ({
      diagrams: s.diagrams.map(d => {
        if (d.id !== targetDiagramId) return d
        const occs = d.occurrences ?? []

        const ownerOcc = occs.find(o => o.id === otOccurrenceId)
        const ownerEl = ownerOcc
          ? (objectTypes.find(o => o.id === ownerOcc.schemaElementId)
            ?? facts.find(f => f.id === ownerOcc.schemaElementId && f.objectified && f.objectifiedKind !== 'value'))
          : null
        const rm = ownerEl ? findRefMode(ownerEl, facts, objectTypes) : null

        // FT occ to collapse: prefer one explicitly owned by this entity occ; fall back to
        // an independent occ (for v1 compat). Skip occs owned by OTHER entities.
        const ftOcc = rm ? (
          occs.find(o => o.schemaElementId === rm.factId && o.refModeOwnerOccId === otOccurrenceId) ??
          occs.find(o => o.schemaElementId === rm.factId && !o.refModeOwnerOccId)
        ) : null

        // VT occ: same preference — owned by this entity first, then independent.
        const vtOcc = rm ? (
          occs.find(o => o.schemaElementId === rm.vtId && o.refModeOwnerOccId === otOccurrenceId) ??
          occs.find(o => o.schemaElementId === rm.vtId && !o.refModeOwnerOccId)
        ) : null

        // VT is needed by another visible fact if any non-owned fact occurrence (excluding
        // the FT being collapsed) SPECIFICALLY references vtOcc via its roleOccurrenceMap.
        // Fall back to schema-level role check for facts without a roleOccurrenceMap.
        const expandedSet = new Set(d.expandedRefModeOccs ?? [])
        const vtNeededByOtherFact = vtOcc && rm
          ? occs.some(o => {
              if (ftOcc && o.id === ftOcc.id) return false
              if (o.refModeOwnerOccId === otOccurrenceId) return false
              // Only count currently visible fact occurrences.
              if (o.refModeOwnerOccId && !expandedSet.has(o.refModeOwnerOccId)) return false
              // Check if this fact occ specifically uses vtOcc via roleOccurrenceMap.
              if (o.roleOccurrenceMap) {
                return Object.values(o.roleOccurrenceMap).includes(vtOcc.id)
              }
              // v1 fallback: schema-level role check.
              const f = facts.find(x => x.id === o.schemaElementId)
              return f?.roles?.some(r => r.objectTypeId === rm.vtId)
            })
          : false

        let newOccs = occs
        // Adopt the FT (ensure it is owned by B so it hides when B is not expanded).
        if (ftOcc) {
          newOccs = newOccs.map(o =>
            o.id === ftOcc.id ? { ...o, refModeOwnerOccId: otOccurrenceId } : o)
        }
        // VT: adopt if not needed by others; liberate (make independent) if it is.
        if (vtOcc) {
          newOccs = newOccs.map(o =>
            o.id === vtOcc.id
              ? { ...o, refModeOwnerOccId: vtNeededByOtherFact ? null : otOccurrenceId }
              : o)
        }

        return {
          ...d,
          occurrences: newOccs,
          expandedRefModeOccs: (d.expandedRefModeOccs ?? []).filter(id => id !== otOccurrenceId),
        }
      }),
      isDirty: true,
    }))
  },

  // ── fact types ──────────────────────────────────────────────────────────

  addFact(x, y, arity = 2) {
    const n = nextRelationNumber(get().facts)
    const f = { ...mkFact(Math.round(x), Math.round(y), arity), readingParts: defaultReadingParts(arity, n) }
    set(s => ({
      facts: [...s.facts, f],
      diagrams: s.diagrams.map(d => d.id !== s.activeDiagramId ? d : addOccIfAbsent(d, f.id, f.x, f.y)),
      isDirty: true, selectedId: f.id, selectedKind: 'fact',
    }))
    return f.id
  },

  addNestedFact(x, y, arity = 2, objectifiedKind = 'entity') {
    const n = nextRelationNumber(get().facts)
    const base = { ...mkFact(Math.round(x), Math.round(y), arity), readingParts: defaultReadingParts(arity, n), objectified: true, objectifiedKind, nestedReading: false, datatypeAssignment: null }
    base.roles = base.roles.map(r => ({ ...r, linkReadingParts: ['', 'involves', ''] }))
    base.implicitLinks = Array.from({ length: arity }, (_, i) => mkImplicitLink(i))
    set(s => {
      const used = new Set(
        s.objectTypes.map(o => o.name).concat(s.facts.map(f => f.objectifiedName).filter(Boolean))
      )
      let n = 1
      while (used.has(`Entity${n}`)) n++
      const f = { ...base, objectifiedName: `Entity${n}` }
      return {
        facts: [...s.facts, f],
        diagrams: s.diagrams.map(d => d.id !== s.activeDiagramId ? d : addOccIfAbsent(d, f.id, f.x, f.y)),
        isDirty: true, selectedId: f.id, selectedKind: 'fact',
      }
    })
    return base.id
  },

  convertToNestedEntity(id) {
    set(s => {
      const used = new Set(
        s.objectTypes.map(o => o.name).concat(s.facts.map(f => f.objectifiedName).filter(Boolean))
      )
      let n = 1
      while (used.has(`Entity${n}`)) n++
      return {
        facts: s.facts.map(f => f.id !== id ? f : {
          ...f, objectified: true, objectifiedKind: 'entity',
          objectifiedName: `Entity${n}`, nestedReading: false,
          roles: f.roles.map(r => ({ ...r, linkReadingParts: ['', 'involves', ''] })),
          implicitLinks: Array.from({ length: f.arity }, (_, i) => mkImplicitLink(i)),
        }),
        isDirty: true,
      }
    })
  },

  updateFact(id, patch) {
    set(s => ({
      facts: s.facts.map(f => f.id === id ? { ...f, ...patch } : f),
      isDirty: true,
    }))
  },

  moveFact(id, x, y) {
    set(s => {
      const diag   = s.diagrams.find(d => d.id === s.activeDiagramId)
      const occ    = occOf(diag, id)
      const fact   = s.facts.find(f => f.id === id)
      const oldX   = occ?.x ?? fact?.x ?? 0
      const oldY   = occ?.y ?? fact?.y ?? 0
      const dx = x - oldX
      const dy = y - oldY
      return {
        diagrams: s.diagrams.map(d => d.id !== s.activeDiagramId ? d : patchOcc(d, id, { x, y })),
        facts: s.facts.map(f => f.id !== id || !f.internalFrequency?.length ? f : {
          ...f,
          internalFrequency: f.internalFrequency.map(if_ => ({
            ...if_, x: if_.x + dx, y: if_.y + dy,
          })),
        }),
        isDirty: true,
      }
    })
  },

  // Update per-diagram layout properties for a fact (readingAbove, readingOffsetAbove, readingOffsetBelow,
  // uniquenessBelow, nestedReading). Stored in occurrence alongside x,y.
  updateFactLayout(id, patch) {
    set(s => ({
      diagrams: s.diagrams.map(d => d.id !== s.activeDiagramId ? d : patchOcc(d, id, patch)),
      isDirty: true,
    }))
  },

  // Store role-name label offset per diagram (in occurrence.roleNameOffsets[roleIndex]).
  updateRoleNameOffset(factId, roleIndex, offset) {
    set(s => ({
      diagrams: s.diagrams.map(d => {
        if (d.id !== s.activeDiagramId) return d
        const cur = occOf(d, factId) ?? {}
        return patchOcc(d, factId, {
          roleNameOffsets: { ...(cur.roleNameOffsets ?? {}), [roleIndex]: offset },
        })
      }),
      isDirty: true,
    }))
  },

  // Store value-range label offset per diagram (in occurrence.valueRangeOffsets[roleIndex]).
  updateValueRangeOffset(factId, roleIndex, offset) {
    set(s => ({
      diagrams: s.diagrams.map(d => {
        if (d.id !== s.activeDiagramId) return d
        const cur = occOf(d, factId) ?? {}
        return patchOcc(d, factId, {
          valueRangeOffsets: { ...(cur.valueRangeOffsets ?? {}), [roleIndex]: offset },
        })
      }),
      isDirty: true,
    }))
  },

  updateCardinalityRangeOffset(factId, roleIndex, offset) {
    set(s => ({
      diagrams: s.diagrams.map(d => {
        if (d.id !== s.activeDiagramId) return d
        const cur = occOf(d, factId) ?? {}
        return patchOcc(d, factId, {
          cardinalityRangeOffsets: { ...(cur.cardinalityRangeOffsets ?? {}), [roleIndex]: offset },
        })
      }),
      isDirty: true,
    }))
  },

  // Change the arity of an existing fact type.
  // Adding roles appends blank ones at the end.
  // Removing roles trims from the end and cleans up uniqueness bars
  // and any constraint role-refs that pointed at the removed positions.
  setFactArity(factId, newArity) {
    if (newArity < 1) return
    set(s => {
      const facts = s.facts.map(f => {
        if (f.id !== factId) return f
        const current = f.roles.length
        let roles
        if (newArity > current) {
          const extra = Array.from({ length: newArity - current }, mkRole)
          roles = f.objectified
            ? [...f.roles, ...extra.map(r => ({ ...r, linkReadingParts: ['', 'involves', ''] }))]
            : [...f.roles, ...extra]
        } else {
          roles = f.roles.slice(0, newArity)
        }
        const uniqueness = f.uniqueness.filter(u => u.every(i => i < newArity))
        const internalFrequency = (f.internalFrequency || []).map(if_ => ({
          ...if_,
          roles: if_.roles.filter(i => i < newArity),
        })).filter(if_ => if_.roles.length > 0)
        const oldParts = f.readingParts
        const readingParts = oldParts
          ? (newArity > current
            ? [...oldParts, ...Array(newArity - current).fill('')]
            : oldParts.slice(0, newArity + 1))
          : null
        const alternativeReadings = (f.alternativeReadings || [])
          .filter(r => r.roleOrder.every(i => i < newArity) && r.roleOrder.length === newArity)
          .map(r => ({
            ...r,
            parts: newArity > r.parts.length - 1
              ? [...r.parts, ...Array(newArity - (r.parts.length - 1)).fill('')]
              : r.parts.slice(0, newArity + 1),
          }))
        let implicitLinks = f.implicitLinks || []
        if (newArity > current) {
          const existingIndices = new Set(implicitLinks.map(il => il.roleIndex))
          for (let i = current; i < newArity; i++) {
            if (!existingIndices.has(i)) {
              implicitLinks.push(mkImplicitLink(i))
            }
          }
        } else {
          implicitLinks = implicitLinks.filter(il => il.roleIndex < newArity)
        }
        return { ...f, arity: newArity, roles, uniqueness, internalFrequency, readingParts, alternativeReadings, shownReadingOrder: null, implicitLinks }
      })
      const constraints = s.constraints.map(c => ({
        ...c,
        roleSequences: c.roleSequences
          ? c.roleSequences.map(g => g.filter(r => !(r.factId === factId && r.roleIndex >= newArity)))
          : undefined,
        sequences: c.sequences
          ? c.sequences.map(g => g.filter(m => !(m.kind === 'role' && m.factId === factId && m.roleIndex >= newArity)))
          : undefined,
      }))
      // Resize each tuple in the fact's population to match the new arity
      const existingTuples = s.factPopulations?.[factId]
      let factPopulations = s.factPopulations
      if (existingTuples?.length) {
        const resized = existingTuples.map(t => {
          if (t.length === newArity) return t
          if (newArity > t.length) return [...t, ...Array(newArity - t.length).fill('')]
          return t.slice(0, newArity)
        })
        factPopulations = { ...s.factPopulations, [factId]: resized }
      }
      return { facts, constraints, factPopulations, isDirty: true,
        diagrams: s.diagrams.map(d => {
          const shown = (d.shownImplicitLinks || []).filter(k => {
            if (!k.startsWith(`${factId}:`)) return true
            const ri = Number(k.substring(k.indexOf(':') + 1))
            return ri < newArity
          })
          return shown.length === d.shownImplicitLinks?.length ? d : { ...d, shownImplicitLinks: shown }
        }),
      }
    })
  },

  // Move a role from fromIndex to toIndex, shifting others accordingly.
  // Uniqueness constraint sets have their indices remapped to match.
  reorderRoles(factId, fromIndex, toIndex) {
    if (fromIndex === toIndex) return
    set(s => {
      // Precompute oldToNew for use in both .facts.map and population remap below
      const target = s.facts.find(f => f.id === factId)
      const oldToNewOuter = {}
      if (target) {
        target.roles.forEach((_, oldI) => {
          let newI = oldI
          if (oldI === fromIndex) newI = toIndex
          else if (fromIndex < toIndex) { if (oldI > fromIndex && oldI <= toIndex) newI = oldI - 1 }
          else                          { if (oldI >= toIndex && oldI < fromIndex) newI = oldI + 1 }
          oldToNewOuter[oldI] = newI
        })
      }
      return {
      facts: s.facts.map(f => {
        if (f.id !== factId) return f
        const roles = [...f.roles]
        const [moved] = roles.splice(fromIndex, 1)
        roles.splice(toIndex, 0, moved)

        // Build a mapping: oldIndex → newIndex
        const oldToNew = {}
        f.roles.forEach((_, oldI) => {
          // After removing fromIndex and inserting at toIndex:
          let newI = oldI
          if (oldI === fromIndex) {
            newI = toIndex
          } else if (fromIndex < toIndex) {
            if (oldI > fromIndex && oldI <= toIndex) newI = oldI - 1
          } else {
            if (oldI >= toIndex && oldI < fromIndex) newI = oldI + 1
          }
          oldToNew[oldI] = newI
        })

        const uniqueness = f.uniqueness.map(u => u.map(i => oldToNew[i]))

        // Remap alternative readings' role order through oldToNew
        const remappedAlts = (f.alternativeReadings || []).map(r => ({
          ...r,
          roleOrder: r.roleOrder.map(i => oldToNew[i]),
        }))

        // If any remapped alternative now has the default order [0,1,...] it
        // means it describes the new physical ordering → promote it to primary,
        // and demote the old primary to an alternative (if it had any content).
        const n = f.roles.length
        const defaultKey = JSON.stringify(Array.from({ length: n }, (_, i) => i))
        const promoted = remappedAlts.find(r => JSON.stringify(r.roleOrder) === defaultKey)

          let readingParts = f.readingParts
          let alternativeReadings = remappedAlts

          if (promoted) {
            readingParts = promoted.parts
            alternativeReadings = remappedAlts.filter(r => JSON.stringify(r.roleOrder) !== defaultKey)
            if (f.readingParts && f.readingParts.some(p => p?.trim())) {
              const demotedOrder = Array.from({ length: n }, (_, i) => oldToNew[i])
              alternativeReadings = [...alternativeReadings, { roleOrder: demotedOrder, parts: f.readingParts }]
            }
          }

          let implicitLinks = f.implicitLinks || []
          if (f.objectified) {
            implicitLinks = implicitLinks.map(il => ({ ...il, roleIndex: oldToNew[il.roleIndex] ?? il.roleIndex }))
          }

          return { ...f, roles, uniqueness, readingParts, alternativeReadings, implicitLinks }
        }),
      diagrams: s.diagrams.map(d => {
        const ilp = { ...(d.implicitLinkPositions ?? {}) }
        const ilKeys = Object.keys(ilp).filter(k => k.startsWith(`${factId}:il:`))
        for (const k of ilKeys) {
          const ri = Number(k.split(':')[2])
          const newRi = oldToNew[ri]
          if (newRi !== undefined && newRi !== ri) {
            ilp[`${factId}:il:${newRi}`] = ilp[k]
            delete ilp[k]
            // Remap implied frequency positions
            for (const fk of ilKeys.filter(x => x.startsWith(`${factId}:il:${ri}:if:`))) {
              const newFk = fk.replace(`${factId}:il:${ri}:if:`, `${factId}:il:${newRi}:if:`)
              ilp[newFk] = ilp[fk]
              delete ilp[fk]
            }
          }
        }
        // Also remap shownImplicitLinks keys
        const shown = (d.shownImplicitLinks || [])
        const shownPrefix = `${factId}:`
        const remappedShown = shown.map(key => {
          if (!key.startsWith(shownPrefix)) return key
          const ri = Number(key.substring(shownPrefix.length))
          const newRi = oldToNew[ri]
          return newRi !== undefined ? `${factId}:${newRi}` : key
        })
        return { ...d, implicitLinkPositions: ilp, shownImplicitLinks: remappedShown }
      }),
      // Permute tuple cells in the fact's population to match the new role order
      factPopulations: (() => {
        const tuples = s.factPopulations?.[factId]
        if (!tuples?.length || !target) return s.factPopulations
        const remapped = tuples.map(t => {
          const next = t.slice()
          target.roles.forEach((_, oldI) => {
            const newI = oldToNewOuter[oldI]
            if (newI !== undefined) next[newI] = t[oldI] ?? ''
          })
          return next
        })
        return { ...s.factPopulations, [factId]: remapped }
      })(),
      isDirty: true,
      }
    })
  },

  reverseRoles(factId) {
    set(s => {
      const f = s.facts.find(f => f.id === factId)
      if (!f || f.arity !== 2) return {}
      const diag = s.diagrams.find(d => d.id === s.activeDiagramId)
      const occ = occOf(diag, factId)
      const currentRoleOrder = occ?.roleOrder || [0, 1]
      const newRoleOrder = currentRoleOrder[0] === 0 && currentRoleOrder[1] === 1 ? [1, 0] : [0, 1]
      return {
        diagrams: s.diagrams.map(d => d.id !== s.activeDiagramId ? d : patchOcc(d, factId, { roleOrder: newRoleOrder })),
        isDirty: true,
      }
    })
  },

  reverseImplicitLinkRoles(factId, roleIndex) {
    set(s => ({
      facts: s.facts.map(f => {
        if (f.id !== factId) return f
        return {
          ...f,
          implicitLinks: (f.implicitLinks || []).map(il => {
            if (il.roleIndex !== roleIndex) return il
            const current = il.roleOrder || [0, 1]
            return { ...il, roleOrder: [current[1], current[0]] }
          }),
        }
      }),
      isDirty: true,
    }))
  },

  insertRole(factId, atIndex) {
    set(s => {
      const facts = s.facts.map(f => {
        if (f.id !== factId) return f
        const newRole = f.objectified ? { ...mkRole(), linkReadingParts: ['', 'involves', ''] } : mkRole()
        const roles = [...f.roles.slice(0, atIndex), newRole, ...f.roles.slice(atIndex)]
        const arity = f.arity + 1
        const uniqueness = f.uniqueness.map(u => u.map(i => i >= atIndex ? i + 1 : i))
        const internalFrequency = (f.internalFrequency || []).map(if_ => ({
          ...if_, roles: if_.roles.map(i => i >= atIndex ? i + 1 : i),
        }))
        const rp = f.readingParts ? [...f.readingParts] : null
        if (rp) rp.splice(atIndex, 0, '')

        let implicitLinks = f.implicitLinks || []
        if (f.objectified) {
          // Remap existing implicit link roleIndices that shift due to insertion
          implicitLinks = implicitLinks.map(il =>
            il.roleIndex >= atIndex ? { ...il, roleIndex: il.roleIndex + 1 } : il
          )
          // Create implicit link entry for the new role
          implicitLinks = [...implicitLinks, mkImplicitLink(atIndex)]
        }

        return { ...f, arity, roles, uniqueness, internalFrequency, readingParts: rp, alternativeReadings: [], implicitLinks }
      })
      const constraints = s.constraints.map(c => ({
        ...c,
        roleSequences: c.roleSequences
          ? c.roleSequences.map(g => g.map(r => r.factId === factId && r.roleIndex >= atIndex ? { ...r, roleIndex: r.roleIndex + 1 } : r))
          : undefined,
        sequences: c.sequences
          ? c.sequences.map(g => g.map(m => m.kind === 'role' && m.factId === factId && m.roleIndex >= atIndex ? { ...m, roleIndex: m.roleIndex + 1 } : m))
          : undefined,
      }))
      return { facts, constraints, isDirty: true,
        diagrams: s.diagrams.map(d => {
          const ilp = { ...(d.implicitLinkPositions ?? {}) }
          const ilKeys = Object.keys(ilp).filter(k => k.startsWith(`${factId}:il:`)).sort((a, b) => Number(b.split(':')[2]) - Number(a.split(':')[2]))
          for (const k of ilKeys) {
            const ri = Number(k.split(':')[2])
            if (ri >= atIndex) {
              ilp[`${factId}:il:${ri + 1}`] = ilp[k]
              delete ilp[k]
              // Remap implied frequency positions
              for (const fk of Object.keys(ilp).filter(x => x.startsWith(`${factId}:il:${ri}:if:`))) {
                ilp[fk.replace(`${factId}:il:${ri}:if:`, `${factId}:il:${ri + 1}:if:`)] = ilp[fk]
                delete ilp[fk]
              }
            }
          }
          // Also remap shownImplicitLinks keys
          const shown = (d.shownImplicitLinks || [])
          const shownPrefix = `${factId}:`
          const remappedShown = shown.map(key => {
            if (!key.startsWith(shownPrefix)) return key
            const ri = Number(key.substring(shownPrefix.length))
            return ri >= atIndex ? `${factId}:${ri + 1}` : key
          })
          return { ...d, implicitLinkPositions: ilp, shownImplicitLinks: remappedShown }
        }),
      }
    })
  },

  deleteRole(factId, roleIndex) {
    set(s => {
      const facts = s.facts.map(f => {
        if (f.id !== factId) return f
        if (f.arity <= 1) return f
        const roles = f.roles.filter((_, i) => i !== roleIndex)
        const arity = f.arity - 1
        const uniqueness = f.uniqueness
          .filter(u => !u.includes(roleIndex))
          .map(u => u.map(i => i > roleIndex ? i - 1 : i))
        const internalFrequency = (f.internalFrequency || [])
          .map(if_ => ({ ...if_, roles: if_.roles.filter(i => i !== roleIndex).map(i => i > roleIndex ? i - 1 : i) }))
          .filter(if_ => if_.roles.length > 0)
        const rp = f.readingParts ? [...f.readingParts] : null
        if (rp) rp.splice(roleIndex, 1)
        let implicitLinks = f.implicitLinks || []
        if (f.objectified) {
          implicitLinks = implicitLinks
            .filter(il => il.roleIndex !== roleIndex)
            .map(il => il.roleIndex > roleIndex ? { ...il, roleIndex: il.roleIndex - 1 } : il)
        }
        return { ...f, arity, roles, uniqueness, internalFrequency, readingParts: rp, alternativeReadings: [], implicitLinks }
      })
      const constraints = s.constraints.map(c => ({
        ...c,
        roleSequences: c.roleSequences
          ? c.roleSequences.map(g =>
              g.filter(r => !(r.factId === factId && r.roleIndex === roleIndex))
               .map(r => r.factId === factId && r.roleIndex > roleIndex ? { ...r, roleIndex: r.roleIndex - 1 } : r))
          : undefined,
        sequences: c.sequences
          ? (() => {
              const positionsToRemove = new Set()
              c.sequences.forEach(g => g.forEach((m, i) => {
                if (m.kind === 'role' && m.factId === factId && m.roleIndex === roleIndex) positionsToRemove.add(i)
              }))
              return c.sequences
                .map(g => g
                  .filter((_, i) => !positionsToRemove.has(i))
                  .map(m => m.kind === 'role' && m.factId === factId && m.roleIndex > roleIndex ? { ...m, roleIndex: m.roleIndex - 1 } : m)
                )
            })()
          : undefined,
      }))
      return { facts, constraints, isDirty: true,
        diagrams: s.diagrams.map(d => {
          const ilp = { ...(d.implicitLinkPositions ?? {}) }
          const ilKey = `${factId}:il:${roleIndex}`
          // Remove the deleted implicit link's position and its implied frequency positions
          delete ilp[ilKey]
          for (const k of Object.keys(ilp)) {
            if (k.startsWith(`${ilKey}:if:`)) delete ilp[k]
          }
          for (const [k, v] of Object.entries(ilp)) {
            if (k.startsWith(`${factId}:il:`)) {
              const parts = k.split(':')
              const ri = Number(parts[2])
              if (ri > roleIndex) {
                const newKey = `${factId}:il:${ri - 1}`
                ilp[newKey] = v
                delete ilp[k]
                // Remap implied frequency positions too
                for (const fk of Object.keys(ilp)) {
                  if (fk.startsWith(`${factId}:il:${ri}:if:`)) {
                    const newFk = fk.replace(`${factId}:il:${ri}:if:`, `${factId}:il:${ri - 1}:if:`)
                    ilp[newFk] = ilp[fk]
                    delete ilp[fk]
                  }
                }
              }
            }
          }
          // Also remap shownImplicitLinks keys
          const shown = (d.shownImplicitLinks || [])
          const shownPrefix = `${factId}:`
          const remappedShown = shown
            .map(key => {
              if (!key.startsWith(shownPrefix)) return key
              const ri = Number(key.substring(shownPrefix.length))
              return ri > roleIndex ? `${factId}:${ri - 1}` : key
            })
            .filter(key => key !== `${factId}:${roleIndex}`)
          return { ...d, implicitLinkPositions: ilp, shownImplicitLinks: remappedShown }
        }),
      }
    })
  },

  updateRole(factId, roleIndex, patch) {
    set(s => ({
      facts: s.facts.map(f => {
        if (f.id !== factId) return f
        const roles = f.roles.map((r, i) => i === roleIndex ? { ...r, ...patch } : r)
        return { ...f, roles }
      }),
      isDirty: true,
    }))
  },

  assignObjectTypeToRole(factId, roleIndex, objectTypeId) {
    set(s => {
      const newFacts = s.facts.map(f => {
        if (f.id !== factId) return f
        return { ...f, roles: f.roles.map((r, i) => i === roleIndex ? { ...r, objectTypeId } : r) }
      })

      // For every diagram containing the fact: if the new OT is present keep the fact
      // (and update roleOccurrenceMap to its first occurrence); if absent, remove the
      // fact — adding the OT silently to foreign diagrams would violate user intent.
      const riKey = String(roleIndex)
      const updatedDiagrams = s.diagrams.map(d => {
        if (!inDiag(d, factId)) return d
        const newOtOcc = (d.occurrences ?? []).find(o => o.schemaElementId === objectTypeId)
        if (!newOtOcc) {
          return { ...d, occurrences: (d.occurrences ?? []).filter(o => o.schemaElementId !== factId) }
        }
        return {
          ...d,
          occurrences: (d.occurrences ?? []).map(o =>
            o.schemaElementId !== factId ? o
            : { ...o, roleOccurrenceMap: { ...(o.roleOccurrenceMap ?? {}), [riKey]: newOtOcc.id } }
          ),
        }
      })

      return {
        facts:   newFacts,
        diagrams: syncConstraints(updatedDiagrams, s.constraints, s.subtypes, newFacts),
        isDirty: true,
      }
    })
  },

  toggleUniqueness(factId, roleIndices) {
    set(s => ({
      facts: s.facts.map(f => {
        if (f.id !== factId) return f
        const key = JSON.stringify([...roleIndices].sort())
        const exists = f.uniqueness.some(u => JSON.stringify([...u].sort()) === key)
        const uniqueness = exists
          ? f.uniqueness.filter(u => JSON.stringify([...u].sort()) !== key)
          : [...f.uniqueness, roleIndices].sort((a, b) => a.length - b.length)
        const preferredUniqueness = (f.preferredUniqueness || []).filter(pu =>
          JSON.stringify([...pu].sort()) !== key
        )
        return { ...f, uniqueness, preferredUniqueness: preferredUniqueness.length > 0 ? preferredUniqueness : [] }
      }),
      isDirty: true,
    }))
  },

  setPreferredUniqueness(factId, roleIndices) {
    const key = JSON.stringify([...roleIndices].sort())
    set(s => {
      const fact = s.facts.find(f => f.id === factId)
      if (!fact) return {}
      const isValid = roleIndices.length === fact.arity - 1
      const wasOn = (fact.preferredUniqueness || []).some(pu => JSON.stringify([...pu].sort()) === key)
      const isPromote = isValid && !wasOn

      const newFacts = s.facts.map(f => {
        if (f.id !== factId) return f
        if (roleIndices.length !== f.arity - 1) {
          return { ...f, preferredUniqueness: (f.preferredUniqueness || []).filter(pu => JSON.stringify([...pu].sort()) !== key) }
        }
        const current = f.preferredUniqueness || []
        const preferredUniqueness = wasOn
          ? current.filter(pu => JSON.stringify([...pu].sort()) !== key)
          : [...current, [...roleIndices]]
        return { ...f, preferredUniqueness }
      })

      if (!isPromote) return { facts: newFacts, isDirty: true }

      const identifiedId = identifiedIdForInternalPI(fact, roleIndices)
      const { facts: cFacts, constraints: cCons } =
        demoteOtherPIsFor(identifiedId, newFacts, s.constraints, factId, null)

      // When this promotion produces a ref-mode pattern (binary fact, entity on
      // the uncovered role, VT on the covered role), keep it visible in the
      // active diagram instead of auto-collapsing into the entity's shorthand.
      let nextDiagrams = s.diagrams
      const identifiedOt = s.objectTypes.find(o => o.id === identifiedId)
      const isRefModePattern =
        fact.arity === 2 &&
        identifiedOt?.kind === 'entity' &&
        (() => {
          const coveredRoleIndex = roleIndices[0]
          const coveredOtId = fact.roles?.[coveredRoleIndex]?.objectTypeId
          const coveredOt = s.objectTypes.find(o => o.id === coveredOtId)
          return coveredOt?.kind === 'value'
        })()
      if (isRefModePattern) {
        nextDiagrams = s.diagrams.map(d => {
          if (d.id !== s.activeDiagramId) return d
          if ((d.expandedRefModes ?? []).includes(identifiedId)) return d
          return { ...d, expandedRefModes: [...(d.expandedRefModes ?? []), identifiedId] }
        })
      }

      return { facts: cFacts, constraints: cCons, diagrams: nextDiagrams, isDirty: true }
    })
  },

  // Toggle preferred-identifier status by uniqueness array index (used by
  // ImplicitLinkRoleInspector which knows the index, not the role-index array).
  togglePreferredUniqueness(factId, uniquenessIndex) {
    const fact = get().facts.find(f => f.id === factId)
    if (!fact) return
    const roleIndices = (fact.uniqueness || [])[uniquenessIndex]
    if (!Array.isArray(roleIndices)) return
    get().setPreferredUniqueness(factId, roleIndices)
  },

  updateAlternativeReading(factId, roleOrder, parts) {
    const key = JSON.stringify(roleOrder)
    set(s => ({
      facts: s.facts.map(f => {
        if (f.id !== factId) return f
        const n = f.arity
        const defaultKey = JSON.stringify(Array.from({ length: n }, (_, i) => i))
        // If the role order matches the natural order, store it as readingParts
        // (the one shown on the canvas), not as an alternative.
        if (key === defaultKey) {
          return { ...f, readingParts: parts }
        }
        const existing = (f.alternativeReadings || [])
        const exists = existing.some(r => JSON.stringify(r.roleOrder) === key)
        const alternativeReadings = exists
          ? existing.map(r => JSON.stringify(r.roleOrder) === key ? { ...r, parts } : r)
          : [...existing, { roleOrder, parts }]
        return { ...f, alternativeReadings }
      }),
      isDirty: true,
    }))
  },

  removeAlternativeReading(factId, roleOrder) {
    const key = JSON.stringify(roleOrder)
    set(s => ({
      facts: s.facts.map(f => {
        if (f.id !== factId) return f
        return { ...f, alternativeReadings: (f.alternativeReadings || []).filter(r => JSON.stringify(r.roleOrder) !== key) }
      }),
      isDirty: true,
    }))
  },

  removeDefaultReading(factId) {
    set(s => ({
      facts: s.facts.map(f => {
        if (f.id !== factId) return f
        return { ...f, readingParts: null }
      }),
      isDirty: true,
    }))
  },

  // ── implicit link fact types ────────────────────────────────────────────

  toggleImplicitLink(factId, roleIndex) {
    const key = `${factId}:${roleIndex}`
    const s = get()
    const diag = s.diagrams.find(d => d.id === s.activeDiagramId)
    const isShown = diag?.shownImplicitLinks?.includes(key) ?? false
    set(s2 => {
      const updatedDiagrams = s2.diagrams.map(d => {
        if (d.id !== s2.activeDiagramId) return d
        const shown = d.shownImplicitLinks || []
        return {
          ...d,
          shownImplicitLinks: isShown ? shown.filter(k => k !== key) : [...shown, key],
        }
      })
      return {
        diagrams: syncConstraints(updatedDiagrams, s2.constraints, s2.subtypes, s2.facts),
        isDirty: true,
      }
    })
  },

  isImplicitLinkShown(factId, roleIndex) {
    const s = get()
    const diag = s.diagrams.find(d => d.id === s.activeDiagramId)
    return diag?.shownImplicitLinks?.includes(`${factId}:${roleIndex}`) ?? false
  },

  setAllImplicitLinksShown(factId, show) {
    const s = get()
    const fact = s.facts.find(f => f.id === factId)
    if (!fact) return
    const eligibleRoles = (fact.implicitLinks || [])
      .filter(il => fact.roles[il.roleIndex]?.objectTypeId)
      .map(il => `${factId}:${il.roleIndex}`)
    if (eligibleRoles.length === 0) return
    set(s2 => {
      const updatedDiagrams = s2.diagrams.map(d => {
        if (d.id !== s2.activeDiagramId) return d
        const current = new Set(d.shownImplicitLinks || [])
        if (show) eligibleRoles.forEach(k => current.add(k))
        else eligibleRoles.forEach(k => current.delete(k))
        return { ...d, shownImplicitLinks: [...current] }
      })
      return {
        diagrams: syncConstraints(updatedDiagrams, s2.constraints, s2.subtypes, s2.facts),
        isDirty: true,
      }
    })
  },

  updateImplicitLink(factId, roleIndex, patch) {
    const positionKeys = ['x', 'y', 'roleOrder', 'readingOrder', 'orientation', 'readingDisplay', 'readingAbove', 'readingOffset', 'readingOffsetAbove', 'readingOffsetBelow']
    const schemaPatch = {}
    const positionPatch = {}
    for (const [key, value] of Object.entries(patch)) {
      if (positionKeys.includes(key)) {
        positionPatch[key] = value
      } else {
        schemaPatch[key] = value
      }
    }
    set(s => {
      const changes = {}
      if (Object.keys(schemaPatch).length > 0) {
        changes.facts = s.facts.map(f => {
          if (f.id !== factId) return f
          return {
            ...f,
            implicitLinks: (f.implicitLinks || []).map(il =>
              il.roleIndex === roleIndex ? { ...il, ...schemaPatch } : il
            ),
          }
        })
      }
      if (Object.keys(positionPatch).length > 0) {
        const key = `${factId}:il:${roleIndex}`
        const diag = s.diagrams.find(d => d.id === s.activeDiagramId)
        const ilp = { ...(diag?.implicitLinkPositions ?? {}) }
        ilp[key] = { ...(ilp[key] ?? {}), ...positionPatch }
        changes.diagrams = s.diagrams.map(d =>
          d.id === s.activeDiagramId ? { ...d, implicitLinkPositions: ilp } : d
        )
      }
      return Object.keys(changes).length > 0 ? { ...changes, isDirty: true } : {}
    })
  },

  selectImplicitLink(factId, roleIndex) {
    set({ selectedId: factId, selectedKind: 'implicitLink', selectedImplicitLink: roleIndex, selectedRole: null, selectedUniqueness: null, selectedImplicitLinkRole: null })
  },

  selectImplicitLinkUniqueness(factId, roleIndex, uIndex = 0) {
    set({ selectedId: null, selectedKind: null, selectedImplicitLink: null, selectedRole: null, selectedUniqueness: { factId, roleIndex, uIndex }, selectedImplicitLinkRole: null })
  },

  selectImplicitLinkRole(factId, roleIndex, ilRoleIndex) {
    set({ selectedId: factId, selectedKind: 'implicitLink', selectedImplicitLink: roleIndex, selectedImplicitLinkRole: { factId, roleIndex, ilRoleIndex }, selectedRole: null, selectedUniqueness: null })
  },

  updateImplicitLinkInternalFrequency(factId, roleIndex, origIfId, patch) {
    set(s => {
      const key = `${factId}:il:${roleIndex}:if:${origIfId}`
      const diag = s.diagrams.find(d => d.id === s.activeDiagramId)
      const ilp = { ...(diag?.implicitLinkPositions ?? {}) }
      ilp[key] = { ...(ilp[key] ?? {}), ...patch }
      return {
        diagrams: s.diagrams.map(d => d.id === s.activeDiagramId ? { ...d, implicitLinkPositions: ilp } : d),
        isDirty: true,
      }
    })
  },

  deleteFact(id) {
    const { linkDraft } = get()
    if (linkDraft?.type === 'roleAssign' && linkDraft?.factId === id) return
    set(s => {
      const factPopulations      = { ...s.factPopulations }
      const nestedEntityMappings = { ...s.nestedEntityMappings }
      delete factPopulations[id]
      delete nestedEntityMappings[id]
      return {
      factPopulations,
      nestedEntityMappings,
      facts: s.facts.filter(f => f.id !== id).map(f => ({
        ...f,
        // Clear role-player refs to this fact (in case it was an objectified nested type)
        roles: f.roles.map(r => r.objectTypeId === id ? { ...r, objectTypeId: null } : r),
      })),
      // Remove subtype arrows that have this fact as an endpoint (objectified type case)
      subtypes: s.subtypes.filter(st => st.subId !== id && st.superId !== id),
      constraints: s.constraints.map(c => ({
        ...c,
        roleSequences: c.roleSequences
          ? c.roleSequences.map(g => g.filter(r => r.factId !== id))
          : undefined,
      })),
      diagrams: s.diagrams.map(d => {
        let nd = rmOcc(d, id)
        // Remove implicit link positions for this fact
        const newILP = Object.fromEntries(
          Object.entries(nd.implicitLinkPositions ?? {}).filter(([k]) => !k.startsWith(`${id}:il:`))
        )
        if (Object.keys(newILP).length !== Object.keys(nd.implicitLinkPositions ?? {}).length) {
          nd = { ...nd, implicitLinkPositions: newILP }
        }
        return nd
      }),
      selectedId: s.selectedId === id ? null : s.selectedId,
      isDirty: true,
      }
    })
  },

  // ── subtypes ────────────────────────────────────────────────────────────

  addSubtype(subId, superId, subOccId = null, superOccId = null) {
    const s0 = get()
    const exists = s0.subtypes.some(s => s.subId === subId && s.superId === superId)
    if (exists || subId === superId) return
    // Entity/value kinds are disjoint — reject mixed-kind subtype edges
    const subKind   = subtypeKindOf(subId,   s0.objectTypes, s0.facts)
    const superKind = subtypeKindOf(superId, s0.objectTypes, s0.facts)
    if (subKind && superKind && subKind !== superKind) return
    const st = mkSubtype(subId, superId)
    set(s => ({
      subtypes: [...s.subtypes, st],
      diagrams: s.diagrams.map(d => {
        if (d.id !== s.activeDiagramId) return d
        const occs = d.occurrences ?? []
        // Use the explicitly clicked occurrence IDs when provided; fall back to first match.
        const resolvedSubOcc   = subOccId   ? occs.find(o => o.id === subOccId)   : occs.find(o => o.schemaElementId === subId)
        const resolvedSuperOcc = superOccId ? occs.find(o => o.id === superOccId) : occs.find(o => o.schemaElementId === superId)
        const newPair = resolvedSubOcc && resolvedSuperOcc
          ? { subOccId: resolvedSubOcc.id, superOccId: resolvedSuperOcc.id }
          : null
        return {
          ...d,
          subtypeOccurrences: [...(d.subtypeOccurrences ?? []), st.id],
          subtypeEndpointOccs: {
            ...(d.subtypeEndpointOccs ?? {}),
            [st.id]: newPair ? [newPair] : [],
          },
        }
      }),
      isDirty: true,
      selectedId: st.id, selectedKind: 'subtype',
    }))
  },

  updateSubtype(id, patch) {
    set(s => ({
      subtypes: s.subtypes.map(st => st.id === id ? { ...st, ...patch } : st),
      isDirty: true,
    }))
  },

  deleteSubtype(id) {
    set(s => ({
      subtypes: s.subtypes.filter(st => st.id !== id),
      diagrams: s.diagrams.map(d => {
        const { [id]: _dropped, ...restEndpoints } = d.subtypeEndpointOccs ?? {}
        return {
          ...d,
          subtypeOccurrences: (d.subtypeOccurrences ?? []).filter(sid => sid !== id),
          subtypeEndpointOccs: restEndpoints,
        }
      }),
      constraints: s.constraints.map(c => {
        if (c.sequences) {
          // Remove entire positions where any sequence references this subtype
          const positionsToRemove = new Set()
          c.sequences.forEach(g => g.forEach((m, i) => {
            if (m.kind === 'subtype' && m.subtypeId === id) positionsToRemove.add(i)
          }))
          const sequences = c.sequences.map(g => g.filter((_, i) => !positionsToRemove.has(i)))
          return { ...c, sequences }
        }
        return { ...c, subtypeIds: (c.subtypeIds || []).filter(sid => sid !== id) }
      }),
      selectedId: s.selectedId === id ? null : s.selectedId,
      isDirty: true,
    }))
  },

  // Add an already-existing subtype schema element to a specific diagram with pinned occurrence endpoints.
  // Allows multiple occurrences of the same schema subtype (one per unique sub/super occurrence pair).
  // Silently does nothing if this exact (subOccId, superOccId) pair already exists (rule 2).
  addSubtypeToDiagram(stId, diagramId, subOccId, superOccId) {
    const s = get()
    const st = s.subtypes.find(x => x.id === stId)
    if (!st) return
    const diag = s.diagrams.find(d => d.id === diagramId)
    if (!diag) return
    set(s => ({
      diagrams: s.diagrams.map(d => {
        if (d.id !== diagramId) return d
        const existingPairs = normalizeStEps((d.subtypeEndpointOccs ?? {})[stId])
        if (existingPairs.some(ep => ep.subOccId === subOccId && ep.superOccId === superOccId)) return d
        const alreadyInOccs = (d.subtypeOccurrences ?? []).includes(stId)
        return {
          ...d,
          subtypeOccurrences: alreadyInOccs ? d.subtypeOccurrences : [...(d.subtypeOccurrences ?? []), stId],
          subtypeEndpointOccs: {
            ...(d.subtypeEndpointOccs ?? {}),
            [stId]: [...existingPairs, { subOccId, superOccId }],
          },
        }
      }),
      isDirty: true,
      selectedId: stId, selectedKind: 'subtype',
    }))
  },

  // Remove a single (subOccId, superOccId) pair for a schema subtype from a diagram.
  // If the last pair is removed, the schema subtype is fully removed from the diagram.
  removeSubtypeOccurrenceFromDiagram(stId, subOccId, superOccId, diagramId) {
    set(s => ({
      diagrams: s.diagrams.map(d => {
        if (d.id !== diagramId) return d
        const existingPairs = normalizeStEps((d.subtypeEndpointOccs ?? {})[stId])
        const remainingPairs = existingPairs.filter(ep => ep.subOccId !== subOccId || ep.superOccId !== superOccId)
        if (remainingPairs.length === existingPairs.length) return d  // pair not found
        if (remainingPairs.length === 0) {
          const { [stId]: _dropped, ...restEndpoints } = d.subtypeEndpointOccs ?? {}
          return {
            ...d,
            subtypeOccurrences: (d.subtypeOccurrences ?? []).filter(id => id !== stId),
            subtypeEndpointOccs: restEndpoints,
          }
        }
        return {
          ...d,
          subtypeEndpointOccs: { ...(d.subtypeEndpointOccs ?? {}), [stId]: remainingPairs },
        }
      }),
      isDirty: true,
    }))
  },

  // Begin a guided endpoint-pick flow when there is ambiguity (multiple occurrences of sub or super type).
  // If a side has zero occurrences in the diagram, a fresh occurrence is created automatically.
  startSubtypeEndpointPick(stId, diagramId) {
    const s = get()
    const st = s.subtypes.find(x => x.id === stId)
    if (!st) return
    const diag = s.diagrams.find(d => d.id === diagramId) ?? s.diagrams.find(d => d.id === s.activeDiagramId)
    if (!diag) return
    const targetDiagramId = diag.id
    let occs      = diag.occurrences ?? []
    let subOccs   = occs.filter(o => o.schemaElementId === st.subId)
    let superOccs = occs.filter(o => o.schemaElementId === st.superId)

    // For any endpoint with no occurrences, auto-create one.
    const newOccs = []
    if (subOccs.length === 0) {
      const el = s.objectTypes.find(o => o.id === st.subId) ?? s.facts.find(f => f.id === st.subId)
      if (el) { const occ = mkOcc(st.subId, el.x ?? 0, el.y ?? 0); newOccs.push(occ); subOccs = [occ] }
    }
    if (superOccs.length === 0) {
      const el = s.objectTypes.find(o => o.id === st.superId) ?? s.facts.find(f => f.id === st.superId)
      if (el) { const occ = mkOcc(st.superId, el.x ?? 0, el.y ?? 0); newOccs.push(occ); superOccs = [occ] }
    }
    if (newOccs.length > 0) {
      set(s => ({
        diagrams: s.diagrams.map(d => d.id !== targetDiagramId ? d : {
          ...d, occurrences: [...(d.occurrences ?? []), ...newOccs],
        }),
        isDirty: true,
      }))
    }

    const subOccId   = subOccs.length === 1   ? subOccs[0].id   : null
    const superOccId = superOccs.length === 1 ? superOccs[0].id : null
    if (subOccId !== null && superOccId !== null) {
      get().addSubtypeToDiagram(stId, targetDiagramId, subOccId, superOccId)
      return
    }
    set({ linkDraft: { type: 'subtypeEndpointPick', stId, diagramId: targetDiagramId, subOccId, superOccId } })
  },

  // Called when user clicks an OT occurrence while in subtypeEndpointPick mode.
  pickSubtypeEndpoint(occurrenceId) {
    const draft = get().linkDraft
    if (!draft || draft.type !== 'subtypeEndpointPick') return
    let subOccId   = draft.subOccId
    let superOccId = draft.superOccId
    if (subOccId === null)        subOccId   = occurrenceId
    else if (superOccId === null) superOccId = occurrenceId
    if (subOccId !== null && superOccId !== null) {
      get().addSubtypeToDiagram(draft.stId, draft.diagramId, subOccId, superOccId)
      set({ linkDraft: null })
    } else {
      set({ linkDraft: { ...draft, subOccId, superOccId } })
    }
  },

  // Add a constraint occurrence with explicit roleOccurrenceRefs and queryOccurrenceRefs.
  // Allows multiple occurrences of the same schema constraint (one per unique roleOccurrenceRefs combination).
  // Silently does nothing if this exact roleOccurrenceRefs fingerprint already exists (rule 2).
  addConstraintToDiagram(constraintId, diagramId, roleOccurrenceRefs = {}, queryOccurrenceRefs = {}) {
    const s = get()
    const c = s.constraints.find(x => x.id === constraintId)
    if (!c) return
    const diag = s.diagrams.find(d => d.id === diagramId)
    if (!diag) return
    const newKey = roleOccRefsKey(roleOccurrenceRefs)
    const isDuplicate = (diag.constraintOccurrences ?? []).some(co =>
      co.schemaConstraintId === constraintId && roleOccRefsKey(co.roleOccurrenceRefs) === newKey
    )
    if (isDuplicate) return
    set(s => ({
      diagrams: s.diagrams.map(d => {
        if (d.id !== diagramId) return d
        // Offset subsequent occurrences so they don't land on top of existing ones.
        const existingCount = (d.constraintOccurrences ?? []).filter(co => co.schemaConstraintId === constraintId).length
        const offsetX = existingCount * 24
        const cocc = { ...mkConstraintOcc(constraintId, (c.x ?? 0) + offsetX, (c.y ?? 0) + offsetX), roleOccurrenceRefs, queryOccurrenceRefs }
        return { ...d, constraintOccurrences: [...(d.constraintOccurrences ?? []), cocc] }
      }),
      isDirty: true,
      selectedId: constraintId, selectedKind: 'constraint',
    }))
  },

  // Begin a guided pick flow for adding a constraint.
  // Phase 1: sequence deps (fact types/OTs directly connected via sequences/roleSequences).
  // Phase 2: query deps (all elements referenced in the constraint's query atoms).
  // For each dep: 0 occurrences → auto-create; 1 → auto-resolve; 2+ → user picks.
  // Sequence deps also serve as query anchors so they are not re-asked in phase 2.
  startConstraintEndpointPick(constraintId, diagramId) {
    const s = get()
    const c = s.constraints.find(x => x.id === constraintId)
    if (!c) return
    const diag = s.diagrams.find(d => d.id === diagramId) ?? s.diagrams.find(d => d.id === s.activeDiagramId)
    if (!diag) return
    const targetDiagramId = diag.id

    const seqDeps = getConstraintDeps(c, s.facts, s.objectTypes)
    const queryDeps = getConstraintQueryDeps(c, s.facts, s.objectTypes, s.subtypes)
    const seqDepIds = new Set(seqDeps.map(d => d.schemaId))

    let occs = [...(diag.occurrences ?? [])]
    const newOccs = []
    const newSubtypeOccs = []
    const resolvedRefs = {}
    const queryResolvedRefs = {}
    const pendingPicks = []

    // Phase 1: sequence deps
    for (const dep of seqDeps) {
      const existing = occs.filter(o => o.schemaElementId === dep.schemaId)
      if (existing.length === 0) {
        const el = s.facts.find(f => f.id === dep.schemaId) ?? s.objectTypes.find(o => o.id === dep.schemaId)
        if (el) {
          const newOcc = mkOcc(dep.schemaId, el.x ?? 0, el.y ?? 0)
          newOccs.push(newOcc)
          occs.push(newOcc)
          for (const mk of dep.memberKeys) resolvedRefs[mk] = newOcc.id
          queryResolvedRefs[dep.schemaId] = newOcc.id
        }
      } else if (existing.length === 1) {
        for (const mk of dep.memberKeys) resolvedRefs[mk] = existing[0].id
        queryResolvedRefs[dep.schemaId] = existing[0].id
      } else {
        pendingPicks.push({ ...dep, targetRef: 'role' })
      }
    }

    // Phase 2: query-only deps (skip anything already handled as a sequence dep)
    const processedQueryIds = new Set(seqDepIds)
    for (const dep of queryDeps) {
      if (processedQueryIds.has(dep.schemaId)) continue
      processedQueryIds.add(dep.schemaId)

      if (dep.kind === 'subtype') {
        // Subtypes have at most one occurrence; auto-add if missing
        const stOccs = diag.subtypeOccurrences ?? []
        if (!stOccs.includes(dep.schemaId)) newSubtypeOccs.push(dep.schemaId)
        // No queryOccurrenceRef needed for subtypes (only one occurrence possible)
        continue
      }

      const existing = occs.filter(o => o.schemaElementId === dep.schemaId)
      if (existing.length === 0) {
        const el = s.facts.find(f => f.id === dep.schemaId) ?? s.objectTypes.find(o => o.id === dep.schemaId)
        if (el) {
          const newOcc = mkOcc(dep.schemaId, el.x ?? 0, el.y ?? 0)
          newOccs.push(newOcc)
          occs.push(newOcc)
          queryResolvedRefs[dep.schemaId] = newOcc.id
        }
      } else if (existing.length === 1) {
        queryResolvedRefs[dep.schemaId] = existing[0].id
      } else {
        pendingPicks.push({ ...dep, targetRef: 'query' })
      }
    }

    if (newOccs.length > 0 || newSubtypeOccs.length > 0) {
      set(s => ({
        diagrams: s.diagrams.map(d => {
          if (d.id !== targetDiagramId) return d
          return {
            ...d,
            occurrences: newOccs.length > 0 ? [...(d.occurrences ?? []), ...newOccs] : d.occurrences,
            subtypeOccurrences: newSubtypeOccs.length > 0
              ? [...new Set([...(d.subtypeOccurrences ?? []), ...newSubtypeOccs])]
              : d.subtypeOccurrences,
          }
        }),
        isDirty: true,
      }))
    }

    if (pendingPicks.length === 0) {
      get().addConstraintToDiagram(constraintId, targetDiagramId, resolvedRefs, queryResolvedRefs)
      return
    }
    set({ linkDraft: { type: 'constraintEndpointPick', constraintId, diagramId: targetDiagramId, pendingPicks, resolvedRefs, queryResolvedRefs } })
  },

  // Called when the user clicks a fact or OT occurrence during constraintEndpointPick mode.
  pickConstraintEndpoint(occurrenceId) {
    const draft = get().linkDraft
    if (!draft || draft.type !== 'constraintEndpointPick') return
    const [currentPick, ...remainingPicks] = draft.pendingPicks
    if (!currentPick) return
    const newRefs = { ...draft.resolvedRefs }
    const newQueryRefs = { ...(draft.queryResolvedRefs ?? {}) }
    if (currentPick.targetRef !== 'query') {
      // Sequence dep: update roleOccurrenceRefs for each memberKey
      for (const mk of (currentPick.memberKeys ?? [])) newRefs[mk] = occurrenceId
    }
    // All picks also anchor this schema element in queryOccurrenceRefs
    newQueryRefs[currentPick.schemaId] = occurrenceId
    if (remainingPicks.length === 0) {
      get().addConstraintToDiagram(draft.constraintId, draft.diagramId, newRefs, newQueryRefs)
      set({ linkDraft: null })
    } else {
      set({ linkDraft: { ...draft, pendingPicks: remainingPicks, resolvedRefs: newRefs, queryResolvedRefs: newQueryRefs } })
    }
  },

  toggleSubtypeInConstraint(constraintId, subtypeId) {
    // Legacy flat list (kept for non-groups constraints)
    set(s => ({
      constraints: s.constraints.map(c => {
        if (c.id !== constraintId) return c
        const ids = c.subtypeIds || []
        return { ...c, subtypeIds: ids.includes(subtypeId) ? ids.filter(id => id !== subtypeId) : [...ids, subtypeId] }
      }),
      isDirty: true,
    }))
  },

  // ── sequence-based constraint actions ────────────────────────────────────

  // ── sequence construction ─────────────────────────────────────────────────
  // mode: 'newSequence' | 'extend'
  startSequenceConstruction(constraintId, mode) {
    const c = get().constraints.find(c => c.id === constraintId)
    if (!c) return
    const sequences = c.sequences || []
    let steps
    const isSingleton   = isSingletonSequence(c.constraintType)
    const openEndedType = isOpenEndedConstruction(c.constraintType)
    const maxSequences  = constraintMaxSequences(c.constraintType)
    if (mode === 'newSequence') {
      if (sequences.length >= maxSequences) return
      const newSequenceIdx = sequences.length
      const size = (c.constraintType === 'ring' || c.constraintType === 'valueComparison') ? 2
        : isSingleton ? 1 : (sequences.length > 0 ? sequences[0].length : 1)
      steps = Array.from({ length: size }, () => ({ sequenceIndex: newSequenceIdx }))
    } else {
      // extend: one pick per sequence
      if (sequences.length === 0) return
      steps = sequences.map((_, i) => ({ sequenceIndex: i }))
    }
    const openEnded = mode === 'newSequence' && openEndedType && sequences.length === 0
    set({ sequenceConstruction: { constraintId, steps, collected: [], openEnded } })
  },

  collectSequenceMember(member) {
    // Roles from implied links are not allowed in external constraint sequences
    if (member.kind === 'role' && member.factId.includes('_il_')) return

    const gc = get().sequenceConstruction
    if (!gc || gc.steps.length === 0) return

    const [current, ...remaining] = gc.steps
    const gi = current.sequenceIndex

    // Duplicate check: member must not already be in this sequence
    const memberEq = (a, b) => {
      if (!a || !b || a.kind !== b.kind) return false
      if (a.kind === 'role')    return a.factId === b.factId && a.roleIndex === b.roleIndex
      if (a.kind === 'subtype') return a.subtypeId === b.subtypeId
      return false
    }
    const existingSequence = get().constraints.find(c => c.id === gc.constraintId)?.sequences?.[gi] || []
    const inExisting = existingSequence.some(m => memberEq(m, member))
    const inCollected = gc.collected.some(item => item.sequenceIndex === gi && memberEq(item.member, member))
    if (inExisting || inCollected) {
      set({ sequenceConstruction: { ...gc, warning: 'Already in sequence' } })
      return
    }

    const collected = [...gc.collected, { sequenceIndex: gi, member }]
    if (remaining.length === 0 && gc.openEnded) {
      // Open-ended: keep going — append another step for the same sequence
      set({ sequenceConstruction: { ...gc, steps: [{ sequenceIndex: gi }], collected, warning: null } })
    } else if (remaining.length === 0) {
      get()._commitSequenceConstruction(gc.constraintId, collected)
    } else {
      set({ sequenceConstruction: { ...gc, steps: remaining, collected, warning: null } })
    }
  },

  _commitSequenceConstruction(constraintId, collected) {
    const fromMenu = get().tool === 'connectConstraint'
    set({ sequenceConstruction: null, tool: 'select',
      ...(fromMenu ? { selectedId: null, selectedKind: null } : {}) })
    set(s => {
      const newConstraints = s.constraints.map(c => {
        if (c.id !== constraintId) return c
        const originalLength = (c.sequences || []).length
        let sequences = (c.sequences || []).map(g => [...g])
        for (const { sequenceIndex, member } of collected) {
          if (sequenceIndex >= sequences.length) {
            while (sequences.length < sequenceIndex) sequences.push([])
            sequences.push([member])
          } else {
            sequences[sequenceIndex] = [...sequences[sequenceIndex], member]
          }
        }
        // Remove newly added sequences that are schema-equivalent to an existing one
        // (same roles/subtypes in same order, regardless of which occurrences were chosen)
        const seqMemberEq = (a, b) => {
          if (!a || !b || a.kind !== b.kind) return false
          if (a.kind === 'role') return a.factId === b.factId && a.roleIndex === b.roleIndex
          if (a.kind === 'subtype') return a.subtypeId === b.subtypeId
          return false
        }
        const existingSeqs = sequences.slice(0, originalLength)
        sequences = sequences.filter((seq, i) =>
          i < originalLength ||
          !existingSeqs.some(ex => ex.length === seq.length && ex.every((m, j) => seqMemberEq(m, seq[j])))
        )
        // Pad queries array to match sequences length (new sequences get null query)
        const queries = [...(c.queries || [])]
        while (queries.length < sequences.length) queries.push(null)
        return { ...c, sequences, queries }
      })
      return {
        constraints: newConstraints,
        diagrams: syncConstraints(s.diagrams, newConstraints, s.subtypes, s.facts),
        isDirty: true,
      }
    })
    // After committing, try to auto-generate query/target for supported constraint types
    get()._tryAutoGenerateQuery(constraintId)
  },

  _tryAutoGenerateQuery(constraintId) {
    const { constraints, facts, subtypes } = get()
    const c = constraints.find(c => c.id === constraintId)
    if (!c) return

    if (['uniqueness', 'ring', 'valueComparison', 'frequency'].includes(c.constraintType)) {
      const seq = c.sequences?.[0] ?? []
      const roleMembers = seq.filter(m => m.kind === 'role' && !m.factId?.includes('_il_'))
      if (roleMembers.length === 0 || roleMembers.length !== seq.length) return

      // Don't overwrite an existing query
      if (c.queries?.[0] != null) return

      const hasTargetOt = c.constraintType === 'uniqueness' || c.constraintType === 'frequency'
      const commitQuery = (atoms, links, lcaId) => {
        set(s => ({
          constraints: s.constraints.map(con => {
            if (con.id !== constraintId) return con
            const queries = [...(con.queries || [])]
            while (queries.length < 1) queries.push(null)
            queries[0] = { atoms, links }
            return { ...con, ...(hasTargetOt && lcaId ? { targetObjectTypeId: lcaId } : {}), queries }
          }),
          isDirty: true,
        }))
      }

      // ── Case 1 (ring only): both roles in the same fact type ─────────────────
      // No binary-fact requirement — any arity is allowed here.
      if (c.constraintType === 'ring' && roleMembers.length === 2
          && roleMembers[0].factId === roleMembers[1].factId) {
        const factCopyId = uid()
        commitQuery(
          [{ id: factCopyId, kind: 'fact', originalId: roleMembers[0].factId,
             isOutput: false,
             seededRoles: roleMembers.map((m, i) => ({ roleIndex: m.roleIndex, seqPosition: i })),
             dx: 16, dy: 16 }],
          [],
          null,
        )
        return
      }

      // ── Case 2: all roles from distinct binary fact types, unique LCA of other-role OTs ─
      // All roles must be in binary fact types.
      for (const m of roleMembers) {
        const f = facts.find(f => f.id === m.factId)
        if (!f || f.arity !== 2) return
      }
      // Each factId must be distinct.
      const factIds = roleMembers.map(m => m.factId)
      if (new Set(factIds).size !== factIds.length) return

      // Collect the OT at the OTHER role of each fact.
      const otherOtIds = []
      for (const m of roleMembers) {
        const f = facts.find(f => f.id === m.factId)
        const otId = f.roles[1 - m.roleIndex]?.objectTypeId
        if (!otId) return
        otherOtIds.push(otId)
      }

      const lcaId = findUniqueLCA(otherOtIds, subtypes)
      if (!lcaId) return
      if (hasTargetOt && c.targetObjectTypeId && c.targetObjectTypeId !== lcaId) return

      // Build tree: root OT atom for LCA; per branch a path of subtype edge atoms
      // from the LCA down to the other-role OT, then the fact atom.
      const rootAtomId = uid()
      const atoms = [
        { id: rootAtomId, kind: 'objectType', originalId: lcaId,
          isOutput: hasTargetOt, dx: 16, dy: 16 },
      ]
      const links = []

      for (let i = 0; i < roleMembers.length; i++) {
        const m = roleMembers[i]
        const P = otherOtIds[i]
        const path = findPathDown(lcaId, P, subtypes)
        if (path === null) return  // LCA not actually an ancestor — schema inconsistency

        let prevOtAtomId = rootAtomId
        for (const step of path) {
          const childOtAtomId = uid()
          const stAtomId = uid()
          atoms.push({ id: childOtAtomId, kind: 'objectType', originalId: step.toId,
            isOutput: false, dx: (i + 2) * 16, dy: (i + 2) * 16 })
          atoms.push({ id: stAtomId, kind: 'subtype', originalId: step.subtypeId,
            isOutput: false, dx: (i + 2) * 16, dy: (i + 2) * 16 })
          links.push({ atomId: stAtomId, roleIndex: 1, variableId: prevOtAtomId })  // supertype end
          links.push({ atomId: stAtomId, roleIndex: 0, variableId: childOtAtomId }) // subtype end
          prevOtAtomId = childOtAtomId
        }

        const factAtomId = uid()
        atoms.push({ id: factAtomId, kind: 'fact', originalId: m.factId,
          isOutput: false, seededRoles: [{ roleIndex: m.roleIndex, seqPosition: i }],
          dx: (i + 3) * 16, dy: (i + 3) * 16 })
        links.push({ atomId: factAtomId, roleIndex: 1 - m.roleIndex, variableId: prevOtAtomId })
      }

      commitQuery(atoms, links, lcaId)
    }

    if (c.constraintType === 'inclusiveOr' || c.constraintType === 'exclusiveOr') {
      const sequences = c.sequences ?? []
      if (sequences.length === 0) return
      const allSubtypes = get().subtypes

      // Helper: regenerate queries for ALL sequences using the given LCA as target OT.
      // Always regenerates all sequences so every query uses the same LCA.
      const applyQueries = (targetOtId, buildQuery) => {
        const newQueries = sequences.map((_, i) => buildQuery(i))
        set(s => ({
          constraints: s.constraints.map(con =>
            con.id !== constraintId ? con : { ...con, targetObjectTypeId: targetOtId, queries: newQueries }
          ),
          isDirty: true,
        }))
      }

      // ── Rule: every sequence is a single subtype edge or single role; anchor OTs share a unique LCA ──
      // Anchor OT for a subtype edge = superId; for a role = the OT of that role.
      const members = sequences.map(seq => {
        if (seq.length !== 1) return null
        const m = seq[0]
        if (m.kind === 'subtype') {
          const st = allSubtypes.find(s => s.id === m.subtypeId)
          return st ? { kind: 'subtype', st, anchorOtId: st.superId } : null
        }
        if (m.kind === 'role' && !m.factId?.includes('_il_')) {
          const f = facts.find(f => f.id === m.factId)
          const otId = f?.roles[m.roleIndex]?.objectTypeId ?? null
          return otId ? { kind: 'role', m, anchorOtId: otId } : null
        }
        return null
      })
      if (members.every(mem => mem !== null)) {
        const lcaId = findUniqueLCA(members.map(mem => mem.anchorOtId), allSubtypes)
        if (lcaId) {
          // LCA becomes the target OT; queries no longer contain an atom for it.
          applyQueries(lcaId, i => {
            const mem = members[i]
            if (mem.kind === 'subtype') {
              const subOtAtomId = uid(), stAtomId = uid()
              return {
                atoms: [
                  { id: subOtAtomId, kind: 'objectType', originalId: mem.st.subId,
                    isOutput: false, dx: 16, dy: 16 },
                  { id: stAtomId, kind: 'subtype', originalId: mem.st.id,
                    isOutput: true, isSeeded: true, dx: 24, dy: 24 },
                ],
                links: [
                  { atomId: stAtomId, roleIndex: 0, variableId: subOtAtomId },
                ],
              }
            } else {
              const factAtomId = uid()
              return {
                atoms: [
                  { id: factAtomId, kind: 'fact', originalId: mem.m.factId,
                    isOutput: false, seededRoles: [{ roleIndex: mem.m.roleIndex, seqPosition: 0 }],
                    dx: 16, dy: 16 },
                ],
                links: [],
              }
            }
          })
        }
      }
    }

    if (['exclusion', 'equality', 'subset'].includes(c.constraintType)) {
      const sequences = c.sequences ?? []
      if (sequences.length === 0) return

      const existingQueries = [...(c.queries ?? [])]
      while (existingQueries.length < sequences.length) existingQueries.push(null)
      let changed = false

      const allSubtypes = get().subtypes

      for (let i = 0; i < sequences.length; i++) {
        if (existingQueries[i] != null) continue  // don't overwrite existing query

        const seq = sequences[i]

        // Rule 3 (exclusion only): single subtype edge → subtype copy + sub OT copy + super OT copy.
        // Neither OT copy is isOutput — the result is the sub-type's population, identified by
        // the subtype copy being isSeeded.
        if (c.constraintType === 'exclusion' && seq.length === 1 && seq[0].kind === 'subtype') {
          const st = allSubtypes.find(s => s.id === seq[0].subtypeId)
          if (st) {
            const subOtAtomId = uid(), supOtAtomId = uid(), stAtomId = uid()
            existingQueries[i] = {
              atoms: [
                { id: subOtAtomId, kind: 'objectType', originalId: st.subId,
                  isOutput: false, dx: 16, dy: 16 },
                { id: supOtAtomId, kind: 'objectType', originalId: st.superId,
                  isOutput: false, dx: 32, dy: 32 },
                { id: stAtomId, kind: 'subtype', originalId: st.id,
                  isSeeded: true, dx: 24, dy: 24 },
              ],
              links: [
                { atomId: stAtomId, roleIndex: 0, variableId: subOtAtomId },
                { atomId: stAtomId, roleIndex: 1, variableId: supOtAtomId },
              ],
            }
            changed = true
            continue
          }
        }

        // Track each member's position within the original seq for seqPosition annotation
        const roleMembers = seq.reduce((acc, m, seqPos) => {
          if (m.kind === 'role' && !m.factId?.includes('_il_')) acc.push({ ...m, seqPos })
          return acc
        }, [])
        if (roleMembers.length === 0 || roleMembers.length !== seq.length) continue

        // Rule 0: all roles within the same fact type → fact atom with the sequence roles as output variables
        const factIds = new Set(roleMembers.map(m => m.factId))
        if (factIds.size === 1) {
          const factAtomId = uid()
          existingQueries[i] = {
            atoms: [{ id: factAtomId, kind: 'fact', originalId: [...factIds][0],
              isOutput: false, seededRoles: roleMembers.map(m => ({ roleIndex: m.roleIndex, seqPosition: m.seqPos })),
              dx: 16, dy: 16 }],
            links: [],
          }
          changed = true
          continue
        }

        // Rule 1: all roles in binary fact types; other-role OTs share a unique LCA
        let allBinary = true
        for (const m of roleMembers) {
          const f = facts.find(f => f.id === m.factId)
          if (!f || f.arity !== 2) { allBinary = false; break }
        }
        if (allBinary) {
          const otherOtIds = []
          let otValid = true
          for (const m of roleMembers) {
            const f = facts.find(f => f.id === m.factId)
            const otId = f.roles[1 - m.roleIndex]?.objectTypeId
            if (!otId) { otValid = false; break }
            otherOtIds.push(otId)
          }
          if (otValid) {
            const lcaId = findUniqueLCA(otherOtIds, allSubtypes)
            if (lcaId) {
              const paths = otherOtIds.map(otId => findPathDown(lcaId, otId, allSubtypes))
              if (paths.every(p => p !== null)) {
                const rootAtomId = uid()
                // exclusion / equality / subset never designate a target OT — root atom is a plain join variable.
                const atoms = [{ id: rootAtomId, kind: 'objectType', originalId: lcaId,
                  isOutput: false, dx: 16, dy: 16 }]
                const links = []
                roleMembers.forEach((m, j) => {
                  let prevOtAtomId = rootAtomId
                  for (const step of paths[j]) {
                    const childOtAtomId = uid(), pathStAtomId = uid()
                    atoms.push({ id: childOtAtomId, kind: 'objectType', originalId: step.toId,
                      isOutput: false, dx: (j + 2) * 16, dy: (j + 2) * 16 })
                    atoms.push({ id: pathStAtomId, kind: 'subtype', originalId: step.subtypeId,
                      isOutput: false, dx: (j + 2) * 16, dy: (j + 2) * 16 })
                    links.push({ atomId: pathStAtomId, roleIndex: 1, variableId: prevOtAtomId })
                    links.push({ atomId: pathStAtomId, roleIndex: 0, variableId: childOtAtomId })
                    prevOtAtomId = childOtAtomId
                  }
                  const factAtomId = uid()
                  atoms.push({ id: factAtomId, kind: 'fact', originalId: m.factId,
                    isOutput: false, seededRoles: [{ roleIndex: m.roleIndex, seqPosition: m.seqPos }],
                    dx: (j + 3) * 16, dy: (j + 3) * 16 })
                  links.push({ atomId: factAtomId, roleIndex: 1 - m.roleIndex, variableId: prevOtAtomId })
                })
                existingQueries[i] = { atoms, links }
                changed = true
                continue
              }
            }
          }
        }
      }

      if (changed) {
        set(s => ({
          constraints: s.constraints.map(con =>
            con.id !== constraintId ? con : { ...con, queries: existingQueries }
          ),
          isDirty: true,
        }))
      }
    }
  },

  abandonSequenceConstruction() {
    const gc = get().sequenceConstruction
    // Open-ended sequence: commit whatever was collected rather than discarding
    if (gc?.openEnded && gc.collected.length > 0) {
      get()._commitSequenceConstruction(gc.constraintId, gc.collected)
    } else {
      set({ sequenceConstruction: null })
    }
  },

  commitSequenceConstruction() {
    const gc = get().sequenceConstruction
    if (!gc) return
    if (gc.collected.length > 0) {
      get()._commitSequenceConstruction(gc.constraintId, gc.collected)
    } else {
      set({ sequenceConstruction: null })
    }
  },

  setConstraintHighlight(h)  { set({ constraintHighlight: h }) },
  clearConstraintHighlight() { if (get().constraintHighlight !== null) set({ constraintHighlight: null }) },
  setQueryIndexHighlight(h)  { set({ queryIndexHighlight: h }) },
  clearQueryIndexHighlight() { if (get().queryIndexHighlight !== null) set({ queryIndexHighlight: null }) },

  startTargetPick(constraintId) { set({ pendingTargetPick: { constraintId } }) },
  cancelTargetPick() { set({ pendingTargetPick: null }) },
  commitTargetPick(objectTypeId) {
    const { pendingTargetPick, constraints } = get()
    if (!pendingTargetPick) return
    const { constraintId } = pendingTargetPick
    const c = constraints.find(c => c.id === constraintId)
    if (c) {
      set(s => ({
        constraints: s.constraints.map(con =>
          con.id === constraintId ? { ...con, targetObjectTypeId: objectTypeId } : con
        ),
        pendingTargetPick: null,
      }))
    } else {
      set({ pendingTargetPick: null })
    }
  },

  removeConstraintSequencePosition(constraintId, position) {
    set(s => {
      const newConstraints = s.constraints.map(c => {
        if (c.id !== constraintId) return c
        const sequences = (c.sequences || [])
          .map(g => g.filter((_, i) => i !== position))
          .filter(g => g.length > 0)
        return { ...c, sequences }
      })
      return {
        constraints: newConstraints,
        diagrams: syncConstraints(s.diagrams, newConstraints, s.subtypes, s.facts),
        isDirty: true,
      }
    })
  },

  removeConstraintSequence(constraintId, sequenceIndex) {
    set(s => {
      const newConstraints = s.constraints.map(c => {
        if (c.id !== constraintId) return c
        const sequences = (c.sequences || []).filter((_, i) => i !== sequenceIndex)
        const queries   = (c.queries   || []).filter((_, i) => i !== sequenceIndex)
        return { ...c, sequences, queries }
      })
      return {
        constraints: newConstraints,
        diagrams: syncConstraints(s.diagrams, newConstraints, s.subtypes, s.facts),
        isDirty: true,
      }
    })
  },

  swapConstraintSequences(constraintId) {
    set(s => ({
      constraints: s.constraints.map(c => {
        if (c.id !== constraintId) return c
        const sequences = c.sequences || []
        if (sequences.length < 2) return c
        const swapped = [sequences[1], sequences[0], ...sequences.slice(2)]
        const queries  = c.queries  || []
        const swappedQ = queries.length >= 2 ? [queries[1], queries[0], ...queries.slice(2)] : queries
        return { ...c, sequences: swapped, queries: swappedQ }
      }),
      isDirty: true,
    }))
  },

  // ── query editing ────────────────────────────────────────────────────────

  /** Returns { valid: bool, reason: string|null } for the current queryEditDraft. */
  getQueryEditValidation() {
    const qd = get().queryEditDraft
    if (!qd) return { valid: false, reason: null }
    const { atoms, links } = qd
    if (atoms.length === 0) return { valid: false, reason: 'Pattern is empty' }
    // Union-find on atoms — edges are links between fact/subtype atoms and OT atoms
    const parent = {}
    const find = id => { if (parent[id] === undefined) parent[id] = id; return parent[id] === id ? id : (parent[id] = find(parent[id])) }
    const union = (a, b) => { parent[find(a)] = find(b) }
    for (const lk of links) union(lk.atomId, lk.variableId)
    const roots = new Set(atoms.map(a => find(a.id)))
    if (roots.size > 1) return { valid: false, reason: 'Pattern is not connected' }
    return { valid: true, reason: null }
  },

  startQueryEdit(constraintId, sequenceIndex) {
    const c = get().constraints.find(c => c.id === constraintId)
    if (!c) return
    const existing = (c.queries || [])[sequenceIndex] || null
    // Re-edit an already-saved query (atoms is the current field; copies is the old name for backward compat)
    if (existing?.atoms || existing?.copies) {
      const atoms = existing.atoms ?? existing.copies ?? []
      const links = (existing.links ?? []).map(lk => lk.copyId !== undefined && lk.atomId === undefined ? { ...lk, atomId: lk.copyId } : lk)
      set({ queryEditDraft: { constraintId, sequenceIndex, atoms, links, pendingClick: null } })
      return
    }
    // Seed fresh graph from sequence members
    const seq = c.sequences[sequenceIndex] || []
    const facts   = get().facts
    const subtypes = get().subtypes
    const atoms = [], links = []
    const offsetCount = {}  // originalId → how many atoms created so far
    const nextOffset = (originalId) => {
      const n = offsetCount[originalId] ?? 0
      offsetCount[originalId] = n + 1
      return { dx: (n + 1) * 16, dy: (n + 1) * 16 }
    }

    const hasExplicitTarget = !!c.targetObjectTypeId
    // ring / valueComparison / exclusion / equality / subset have no output OT concept;
    // targetObjectTypeId may be set as a side-effect of auto-generation but should not be marked output
    const hasOutputOt = ['uniqueness', 'frequency', 'inclusiveOr', 'exclusiveOr'].includes(c.constraintType)

    // Target atom — created first so it is never shared with role variables
    if (hasExplicitTarget) {
      const targetAtomId = uid()
      atoms.push({ id: targetAtomId, kind: 'objectType', originalId: c.targetObjectTypeId, isOutput: hasOutputOt, ...nextOffset(c.targetObjectTypeId) })
    }

    // Each role gets its own fresh fact atom; OT atoms are added by the user later
    seq.forEach((m, seqPos) => {
      if (m.kind !== 'role') return
      const factAtomId = uid()
      atoms.push({ id: factAtomId, kind: 'fact', originalId: m.factId, isOutput: false, seededRoles: [{ roleIndex: m.roleIndex, seqPosition: seqPos }], ...nextOffset(m.factId) })
    })
    for (const m of seq) {
      if (m.kind !== 'subtype') continue
      const st = subtypes.find(s => s.id === m.subtypeId)
      if (!st) continue
      const stAtomId = uid()
      atoms.push({ id: stAtomId, kind: 'subtype', originalId: m.subtypeId, isOutput: !hasExplicitTarget, isSeeded: true, ...nextOffset(m.subtypeId) })
      const makeOtAtom = (otId) => {
        const cid = uid()
        atoms.push({ id: cid, kind: 'objectType', originalId: otId, isOutput: false, ...nextOffset(otId) })
        return cid
      }
      links.push({ atomId: stAtomId, roleIndex: 0, variableId: makeOtAtom(st.subId)   })
      links.push({ atomId: stAtomId, roleIndex: 1, variableId: makeOtAtom(st.superId) })
    }
    set({ queryEditDraft: { constraintId, sequenceIndex, atoms, links, pendingClick: null } })
  },

  queryEditClick(target) {
    // target: { type: 'otAtom'|'otOriginal'|'factAtomRole'|'factOriginalRole'|'subtypeAtom'|'subtypeOriginal', id, roleIndex? }
    const qd = get().queryEditDraft
    if (!qd) return
    const { pendingClick } = qd
    if (!pendingClick) {
      // First click must be on an atom, not an original
      if (target.type !== 'otAtom' && target.type !== 'factAtomRole' && target.type !== 'subtypeAtom') return
      set({ queryEditDraft: { ...qd, pendingClick: target } })
      return
    }
    // Same target clicked again → cancel pending
    if (pendingClick.type === target.type && pendingClick.id === target.id && pendingClick.roleIndex === target.roleIndex) {
      set({ queryEditDraft: { ...qd, pendingClick: null } })
      return
    }
    const isOtSide   = t => t.type === 'otAtom'   || t.type === 'otOriginal'
    const isRoleSide = t => t.type === 'factAtomRole' || t.type === 'factOriginalRole' || t.type === 'subtypeAtom' || t.type === 'subtypeOriginal'

    // Two OT-side clicks
    if (isOtSide(pendingClick) && isOtSide(target)) {

      // Resolve original IDs for both sides
      const ot1OrigId = pendingClick.type === 'otAtom'
        ? qd.atoms.find(a => a.id === pendingClick.id)?.originalId : pendingClick.id
      const ot2OrigId = target.type === 'otAtom'
        ? qd.atoms.find(a => a.id === target.id)?.originalId : target.id
      if (!ot1OrigId || !ot2OrigId) { set({ queryEditDraft: { ...qd, pendingClick: null } }); return }

      // Find a subtype edge connecting the two OTs (either direction)
      const allSubtypes = get().subtypes
      const st = allSubtypes.find(s =>
        (s.subId === ot1OrigId && s.superId === ot2OrigId) ||
        (s.subId === ot2OrigId && s.superId === ot1OrigId)
      )
      if (!st) { set({ queryEditDraft: { ...qd, pendingClick: null } }); return }

      const newAtoms2 = [...qd.atoms]
      const newLinks2  = [...qd.links]
      const offsetFor  = (origId) => {
        const n = newAtoms2.filter(a => a.originalId === origId).length
        return { dx: (n + 1) * 16, dy: (n + 1) * 16 }
      }

      // Resolve or create OT1 atom
      let ot1AtomId
      if (pendingClick.type === 'otAtom') { ot1AtomId = pendingClick.id }
      else { ot1AtomId = uid(); newAtoms2.push({ id: ot1AtomId, kind: 'objectType', originalId: ot1OrigId, isOutput: false, ...offsetFor(ot1OrigId) }) }

      // Resolve or create OT2 atom
      let ot2AtomId
      if (target.type === 'otAtom') { ot2AtomId = target.id }
      else { ot2AtomId = uid(); newAtoms2.push({ id: ot2AtomId, kind: 'objectType', originalId: ot2OrigId, isOutput: false, ...offsetFor(ot2OrigId) }) }

      // Create subtype atom linking them
      const stAtomId = uid()
      const stIsOutput = !get().constraints.find(c => c.id === qd.constraintId)?.targetObjectTypeId
      newAtoms2.push({ id: stAtomId, kind: 'subtype', originalId: st.id, isOutput: stIsOutput, isSeeded: false, ...offsetFor(st.id) })
      newLinks2.push({ atomId: stAtomId, roleIndex: 0, variableId: st.subId   === ot1OrigId ? ot1AtomId : ot2AtomId })
      newLinks2.push({ atomId: stAtomId, roleIndex: 1, variableId: st.superId === ot1OrigId ? ot1AtomId : ot2AtomId })

      set({ queryEditDraft: { ...qd, atoms: newAtoms2, links: newLinks2, pendingClick: null } })
      return
    }

    let otTarget, roleTarget
    if (isOtSide(pendingClick) && isRoleSide(target))       { otTarget = pendingClick; roleTarget = target }
    else if (isRoleSide(pendingClick) && isOtSide(target))  { roleTarget = pendingClick; otTarget = target }
    else { set({ queryEditDraft: { ...qd, pendingClick: null } }); return }

    const facts    = get().facts
    const subtypes = get().subtypes
    const newAtoms = [...qd.atoms]
    const newLinks  = [...qd.links]

    // Helper: initial dx/dy for a new atom based on how many of the same originalId already exist
    const newAtomOffset = (originalId) => {
      const n = newAtoms.filter(a => a.originalId === originalId).length
      return { dx: (n + 1) * 16, dy: (n + 1) * 16 }
    }

    // Resolve or create OT atom
    let otAtomId, otOriginalId
    if (otTarget.type === 'otAtom') {
      otAtomId = otTarget.id
      otOriginalId = newAtoms.find(a => a.id === otAtomId)?.originalId
    } else {
      otAtomId = uid(); otOriginalId = otTarget.id
      newAtoms.push({ id: otAtomId, kind: 'objectType', originalId: otOriginalId, isOutput: false, ...newAtomOffset(otOriginalId) })
    }
    if (!otOriginalId) { set({ queryEditDraft: { ...qd, pendingClick: null } }); return }

    // Resolve or create fact/subtype atom and determine roleIndex
    let roleAtomId, roleIndex
    if (roleTarget.type === 'factAtomRole') {
      roleAtomId = roleTarget.id; roleIndex = roleTarget.roleIndex
    } else if (roleTarget.type === 'factOriginalRole') {
      roleAtomId = uid(); roleIndex = roleTarget.roleIndex
      const isObjectified = facts.find(f => f.id === roleTarget.id)?.objectified
      newAtoms.push({ id: roleAtomId, kind: isObjectified ? 'objectType' : 'fact', originalId: roleTarget.id, isOutput: false, ...newAtomOffset(roleTarget.id) })
    } else {
      // Subtype: infer which end from OT type
      const stOriginalId = roleTarget.type === 'subtypeAtom'
        ? (qd.atoms.find(a => a.id === roleTarget.id)?.originalId)
        : roleTarget.id
      const st = subtypes.find(s => s.id === stOriginalId)
      if (!st) { set({ queryEditDraft: { ...qd, pendingClick: null } }); return }
      if      (otOriginalId === st.subId)   roleIndex = 0
      else if (otOriginalId === st.superId) roleIndex = 1
      else { set({ queryEditDraft: { ...qd, pendingClick: null } }); return }
      if (roleTarget.type === 'subtypeAtom') {
        roleAtomId = roleTarget.id
      } else {
        roleAtomId = uid()
        const stOut = !get().constraints.find(c => c.id === qd.constraintId)?.targetObjectTypeId
        newAtoms.push({ id: roleAtomId, kind: 'subtype', originalId: stOriginalId, isOutput: stOut, isSeeded: false, ...newAtomOffset(stOriginalId) })
      }
    }

    // Type-check for fact role slots
    if (roleTarget.type === 'factAtomRole' || roleTarget.type === 'factOriginalRole') {
      const factOrigId = newAtoms.find(a => a.id === roleAtomId)?.originalId
      let expectedOtId
      if (factOrigId?.includes('_il_')) {
        const [pFid, riStr] = factOrigId.split('_il_')
        const pFact = facts.find(f => f.id === pFid)
        expectedOtId = roleIndex === 0 ? pFid : pFact?.roles[Number(riStr)]?.objectTypeId
      } else {
        expectedOtId = facts.find(f => f.id === factOrigId)?.roles[roleIndex]?.objectTypeId
      }
      if (expectedOtId !== otOriginalId) { set({ queryEditDraft: { ...qd, pendingClick: null } }); return }
    }

    // If the role slot is already filled, drop the old connection before adding the new one
    const existingIdx = newLinks.findIndex(l => l.atomId === roleAtomId && l.roleIndex === roleIndex)
    if (existingIdx !== -1) newLinks.splice(existingIdx, 1)

    newLinks.push({ atomId: roleAtomId, roleIndex, variableId: otAtomId })

    set({ queryEditDraft: { ...qd, atoms: newAtoms, links: newLinks, pendingClick: null } })
  },

  commitQueryEdit() {
    const qd = get().queryEditDraft
    if (!qd) return
    set(s => ({
      queryEditDraft: null,
      constraints: s.constraints.map(c => {
        if (c.id !== qd.constraintId) return c
        const queries = [...(c.queries || [])]
        while (queries.length <= qd.sequenceIndex) queries.push(null)
        queries[qd.sequenceIndex] = { atoms: qd.atoms, links: qd.links }
        return { ...c, queries }
      }),
      isDirty: true,
    }))
  },

  cancelQueryEdit() {
    set({ queryEditDraft: null })
  },

  cancelQueryPendingClick() {
    const qd = get().queryEditDraft
    if (qd?.pendingClick) set({ queryEditDraft: { ...qd, pendingClick: null } })
  },

  updateQueryAtomOffset(atomId, dx, dy) {
    const qd = get().queryEditDraft
    if (!qd) return
    set(s => {
      const diagrams = s.diagrams.map(d => {
        if (d.id !== s.activeDiagramId) return d
        const qp = d.queryPositions ?? {}
        const forC = qp[qd.constraintId] ?? {}
        const forS = forC[qd.sequenceIndex] ?? {}
        return { ...d, queryPositions: { ...qp, [qd.constraintId]: { ...forC, [qd.sequenceIndex]: { ...forS, [atomId]: { dx, dy } } } } }
      })
      return {
        diagrams,
        isDirty: true,
      }
    })
  },

  resetQueryAtomPosition(atomId) {
    const qd = get().queryEditDraft
    if (!qd) return
    set(s => {
      const diagrams = s.diagrams.map(d => {
        if (d.id !== s.activeDiagramId) return d
        const qp = d.queryPositions ?? {}
        const forC = qp[qd.constraintId] ?? {}
        const forS = { ...(forC[qd.sequenceIndex] ?? {}) }
        delete forS[atomId]
        return { ...d, queryPositions: { ...qp, [qd.constraintId]: { ...forC, [qd.sequenceIndex]: forS } } }
      })
      return { diagrams, isDirty: true }
    })
  },

  mergeOtAtomInto(draggedId, targetId) {
    const qd = get().queryEditDraft
    if (!qd) return
    const dragged = qd.atoms.find(a => a.id === draggedId)
    const target  = qd.atoms.find(a => a.id === targetId)
    if (!dragged || !target || dragged.originalId !== target.originalId) return
    const survived = (dragged.isOutput || target.isOutput) ? { ...target, isOutput: true } : target
    const afterMergeAtoms = qd.atoms.filter(a => a.id !== draggedId).map(a => a.id === targetId ? survived : a)
    const afterMergeLinks = qd.links.map(l => l.variableId === draggedId ? { ...l, variableId: targetId } : l)
    const { atoms, links } = runFactMergePass(afterMergeAtoms, afterMergeLinks, get().facts)
    set({ queryEditDraft: { ...qd, atoms, links, pendingClick: null } })
  },

  splitOtAtom(atomId) {
    const qd = get().queryEditDraft
    if (!qd) return
    const at = qd.atoms.find(a => a.id === atomId)
    if (!at || at.kind !== 'objectType') return

    const allFacts = get().facts
    const isObjectifiedId = (id) => allFacts.some(f => f.id === id && f.objectified)
    const isFactSide = (a) => a.kind === 'fact' || (a.kind === 'objectType' && isObjectifiedId(a.originalId))

    // Only links where the role side is a fact/nested-OT atom
    const roleLinks = qd.links.filter(l =>
      l.variableId === atomId &&
      qd.atoms.some(a => a.id === l.atomId && isFactSide(a))
    )
    if (roleLinks.length < 2) return

    const n = roleLinks.length
    const baseDx = at.dx ?? 16, baseDy = at.dy ?? 16
    let newAtoms = [...qd.atoms]
    let newLinks  = [...qd.links]

    // Create one replacement OT atom per role link, spread in a circle
    roleLinks.forEach((lk, i) => {
      const newId = uid()
      const angle  = (2 * Math.PI * i) / n
      const radius = 30
      newAtoms.push({
        id: newId, kind: at.kind, originalId: at.originalId,
        isOutput: at.isOutput && i === 0,
        dx: baseDx + Math.round(Math.cos(angle) * radius),
        dy: baseDy + Math.round(Math.sin(angle) * radius),
      })
      const idx = newLinks.indexOf(lk)
      newLinks[idx] = { ...lk, variableId: newId }
    })

    // Remove the original atom and any remaining links to it (e.g. subtype links)
    newAtoms = newAtoms.filter(a => a.id !== atomId)
    newLinks  = newLinks.filter(l => l.variableId !== atomId && l.atomId !== atomId)

    // Drop orphaned subtype atoms (missing either endpoint)
    const orphaned = new Set(
      newAtoms.filter(a => {
        if (a.kind !== 'subtype') return false
        return !newLinks.some(l => l.atomId === a.id && l.roleIndex === 0) ||
               !newLinks.some(l => l.atomId === a.id && l.roleIndex === 1)
      }).map(a => a.id)
    )
    newAtoms = newAtoms.filter(a => !orphaned.has(a.id))
    newLinks  = newLinks.filter(l => !orphaned.has(l.atomId) && !orphaned.has(l.variableId))

    set({ queryEditDraft: { ...qd, atoms: newAtoms, links: newLinks, pendingClick: null } })
  },

  splitFactAtom(atomId) {
    const qd = get().queryEditDraft
    if (!qd) return
    const at = qd.atoms.find(a => a.id === atomId)
    if (!at) return

    const allFacts = get().facts
    const isObjectifiedId = (id) => allFacts.some(f => f.id === id && f.objectified)

    // Applies to plain fact atoms and objectified-fact OT atoms
    if (at.kind !== 'fact' && !(at.kind === 'objectType' && isObjectifiedId(at.originalId))) return

    const fact = allFacts.find(f => f.id === at.originalId)
    const arity = fact?.arity ?? fact?.roles?.length ?? 0
    if (arity < 2) return

    const seededMap = new Map((at.seededRoles ?? []).map(s =>
      typeof s === 'number' ? [s, { roleIndex: s, seqPosition: null }] : [s.roleIndex, s]))
    const baseDx  = at.dx ?? 16, baseDy = at.dy ?? 16

    // Snapshot existing role connections before we filter links
    const roleConnections = {}
    for (let ri = 0; ri < arity; ri++) {
      const lk = qd.links.find(l => l.atomId === atomId && l.roleIndex === ri)
      if (lk) roleConnections[ri] = lk.variableId
    }

    // Remove all links associated with the original atom (role links and back-links)
    let newLinks  = qd.links.filter(l => l.atomId !== atomId && l.variableId !== atomId)
    let newAtoms = qd.atoms.filter(a => a.id !== atomId)

    // Create one replacement atom per role, spread in a circle
    for (let ri = 0; ri < arity; ri++) {
      const newId  = uid()
      const angle  = (2 * Math.PI * ri) / arity
      const radius = 30
      newAtoms.push({
        id: newId, kind: at.kind, originalId: at.originalId,
        isOutput: false,
        seededRoles: seededMap.has(ri) ? [seededMap.get(ri)] : [],
        dx: baseDx + Math.round(Math.cos(angle) * radius),
        dy: baseDy + Math.round(Math.sin(angle) * radius),
      })
      if (roleConnections[ri] !== undefined) {
        newLinks.push({ atomId: newId, roleIndex: ri, variableId: roleConnections[ri] })
      }
    }

    set({ queryEditDraft: { ...qd, atoms: newAtoms, links: newLinks, pendingClick: null } })
  },

  splitOutputRoles(atomId) {
    const qd = get().queryEditDraft
    if (!qd) return
    const at = qd.atoms.find(a => a.id === atomId)
    if (!at) return

    const allFacts = get().facts
    const isObjectifiedId = (id) => allFacts.some(f => f.id === id && f.objectified)
    if (at.kind !== 'fact' && !(at.kind === 'objectType' && isObjectifiedId(at.originalId))) return

    const seededRoles = at.seededRoles ?? []
    if (seededRoles.length <= 1) return

    const [firstRole, ...otherRoles] = seededRoles
    const baseDx = at.dx ?? 16, baseDy = at.dy ?? 16

    // Original atom keeps only the first output role; all its links are preserved
    let newAtoms = qd.atoms.map(a =>
      a.id === atomId ? { ...a, seededRoles: [firstRole] } : a
    )
    const newLinks = [...qd.links]

    // One fresh, unconnected atom per remaining output role
    otherRoles.forEach((ri, i) => {
      const angle  = (2 * Math.PI * (i + 1)) / (otherRoles.length + 1)
      const radius = 36
      newAtoms.push({
        id: uid(), kind: at.kind, originalId: at.originalId,
        isOutput: false,
        seededRoles: [ri],
        dx: baseDx + Math.round(Math.cos(angle) * radius),
        dy: baseDy + Math.round(Math.sin(angle) * radius),
      })
    })

    set({ queryEditDraft: { ...qd, atoms: newAtoms, links: newLinks, pendingClick: null } })
  },

  removeQueryAtom(atomId) {
    const qd = get().queryEditDraft
    if (!qd) return
    // Remove links touching this atom
    const remainingLinks = qd.links.filter(l => l.atomId !== atomId && l.variableId !== atomId)
    // Orphan any subtype atoms whose sub or super OT atom is now missing
    const orphaned = new Set(
      qd.atoms
        .filter(at => {
          if (at.kind !== 'subtype') return false
          const hasSubLink = remainingLinks.some(l => l.atomId === at.id && l.roleIndex === 0)
          const hasSupLink = remainingLinks.some(l => l.atomId === at.id && l.roleIndex === 1)
          return !hasSubLink || !hasSupLink
        })
        .map(at => at.id)
    )
    orphaned.add(atomId)
    const newAtoms = qd.atoms.filter(at => !orphaned.has(at.id))
    const newLinks = remainingLinks.filter(l => !orphaned.has(l.atomId) && !orphaned.has(l.variableId))
    set({ queryEditDraft: { ...qd, atoms: newAtoms, links: newLinks, pendingClick: null } })
  },

  clearConstraintQuery(constraintId, sequenceIndex) {
    set(s => ({
      constraints: s.constraints.map(c => {
        if (c.id !== constraintId) return c
        const queries = [...(c.queries || [])]
        if (sequenceIndex < queries.length) queries[sequenceIndex] = null
        return { ...c, queries }
      }),
      isDirty: true,
    }))
  },

  // ── constraints ─────────────────────────────────────────────────────────

  addConstraint(type, x, y) {
    const c = mkConstraint(type, Math.round(x), Math.round(y))
    set(s => {
      // BFS to collect all OT/fact IDs that must accompany the new constraint in the diagram,
      // plus implied links that need to be shown.
      const idsToAdd = new Set()
      const impliedLinksToShow = new Set()
      const visited  = new Set()
      const queue    = [c.id]

      // Seed visited with existing OT and fact IDs so we don't re-queue them
      for (const o of s.objectTypes) visited.add(o.id)
      for (const f of s.facts) visited.add(f.id)

      // Temporarily add the new constraint so BFS can find it
      const tempConstraints = [...s.constraints, c]

      while (queue.length > 0) {
        const id = queue.shift()
        if (visited.has(id)) continue
        visited.add(id)

        const con = tempConstraints.find(x => x.id === id)
        if (con) {
          // Queue all referenced facts, subtypes, and target OT
          if (con.roleSequences)
            for (const seq of con.roleSequences)
              for (const ref of seq)
                if (ref.factId && !visited.has(ref.factId)) queue.push(ref.factId)
          if (con.sequences)
            for (const seq of con.sequences)
              for (const m of seq) {
                if (m.kind === 'role' && m.factId && !visited.has(m.factId)) queue.push(m.factId)
                if (m.kind === 'subtype' && m.subtypeId) {
                  const st = s.subtypes.find(x => x.id === m.subtypeId)
                  if (st) {
                    if (!visited.has(st.subId)) queue.push(st.subId)
                    if (!visited.has(st.superId)) queue.push(st.superId)
                  }
                }
              }
          if (con.targetObjectTypeId && !visited.has(con.targetObjectTypeId))
            queue.push(con.targetObjectTypeId)
          continue
        }

        // Check if this is an implied link fact ID (e.g. "abc_il_0")
        if (typeof id === 'string' && id.includes('_il_')) {
          const parts = id.split('_il_')
          if (parts.length === 2) {
            const parentFactId = parts[0]
            const roleIndex = Number(parts[1])
            impliedLinksToShow.add(`${parentFactId}:${roleIndex}`)
            if (!visited.has(parentFactId)) queue.push(parentFactId)
            // Queue the associated object type
            const parentFact = s.facts.find(f => f.id === parentFactId)
            if (parentFact && parentFact.roles[roleIndex]?.objectTypeId) {
              const assocId = parentFact.roles[roleIndex].objectTypeId
              if (!visited.has(assocId)) queue.push(assocId)
            }
            continue
          }
        }

        // OT or fact
        const el = s.objectTypes.find(o => o.id === id) ?? s.facts.find(f => f.id === id)
        if (el) {
          idsToAdd.add(id)
          const fact = s.facts.find(f => f.id === id)
          if (fact)
            for (const r of fact.roles)
              if (r.objectTypeId && !visited.has(r.objectTypeId)) queue.push(r.objectTypeId)
        }
      }

      // Update diagrams: add the constraint and all its dependencies
      const updatedDiagrams = s.diagrams.map(d => {
        if (d.id !== s.activeDiagramId) return d

        let nd = addCOccIfAbsent(d, c.id, c.x, c.y)

        for (const id of idsToAdd) {
          const el = s.objectTypes.find(o => o.id === id) ?? s.facts.find(f => f.id === id)
          if (!el) continue
          nd = addOccIfAbsent(nd, id, el.x ?? 0, el.y ?? 0)
        }

        // Add implied links to shownImplicitLinks
        const shown = d.shownImplicitLinks || []
        const newShown = new Set(shown)
        for (const ilKey of impliedLinksToShow) newShown.add(ilKey)
        const shownChanged = newShown.size !== shown.length || [...newShown].some(k => !shown.includes(k))

        return {
          ...nd,
          shownImplicitLinks: shownChanged ? [...newShown] : shown,
        }
      })

      return {
        constraints: [...s.constraints, c],
        diagrams: syncConstraints(updatedDiagrams, tempConstraints, s.subtypes, s.facts),
        isDirty: true, selectedId: c.id, selectedKind: 'constraint',
      }
    })
    return c.id
  },

  updateConstraint(id, patch) {
    set(s => {
      const before = s.constraints.find(c => c.id === id)
      const newConstraints = s.constraints.map(c => c.id === id ? { ...c, ...patch } : c)
      // If this update promotes an external uniqueness constraint to preferred
      // identifier, demote every other PI (internal or external) for the same target.
      const promotesPI =
        before?.constraintType === 'uniqueness' &&
        'isPreferredIdentifier' in patch &&
        !!patch.isPreferredIdentifier &&
        !before.isPreferredIdentifier
      if (promotesPI) {
        const targetId = ('targetObjectTypeId' in patch ? patch.targetObjectTypeId : before.targetObjectTypeId)
        const { facts: cFacts, constraints: cCons } =
          demoteOtherPIsFor(targetId, s.facts, newConstraints, null, id)
        return {
          facts: cFacts,
          constraints: cCons,
          diagrams: syncConstraints(s.diagrams, cCons, s.subtypes, cFacts),
          isDirty: true,
        }
      }
      return {
        constraints: newConstraints,
        diagrams: syncConstraints(s.diagrams, newConstraints, s.subtypes, s.facts),
        isDirty: true,
      }
    })
  },

  moveConstraint(id, x, y) {
    set(s => ({
      diagrams: s.diagrams.map(d => d.id !== s.activeDiagramId ? d : patchCOcc(d, id, { x, y })),
      isDirty: true,
    }))
  },

  moveConstraintOccurrence(cOccId, x, y) {
    set(s => ({
      diagrams: s.diagrams.map(d => d.id !== s.activeDiagramId ? d : patchCOccById(d, cOccId, { x: Math.round(x), y: Math.round(y) })),
      isDirty: true,
    }))
  },

  addRoleToConstraintSequence(constraintId, sequenceIndex, factId, roleIndex) {
    if (factId.includes('_il_') && roleIndex !== 0) return
    set(s => {
      const newConstraints = s.constraints.map(c => {
        if (c.id !== constraintId) return c
        const roleSequences = c.roleSequences.map((g, gi) =>
          gi === sequenceIndex
            ? [...g.filter(r => !(r.factId === factId && r.roleIndex === roleIndex)),
               { factId, roleIndex }]
            : g
        )
        return { ...c, roleSequences }
      })
      return {
        constraints: newConstraints,
        diagrams: syncConstraints(s.diagrams, newConstraints, s.subtypes, s.facts),
        isDirty: true,
      }
    })
  },

  deleteConstraint(id) {
    if (get().sequenceConstruction?.constraintId === id) return
    set(s => ({
      constraints: s.constraints.filter(c => c.id !== id),
      diagrams: s.diagrams.map(d => rmCOcc(d, id)),
      selectedId: s.selectedId === id ? null : s.selectedId,
      isDirty: true,
    }))
  },

  // ── selection ────────────────────────────────────────────────────────────

   select(id, kind, occurrenceId = null) {
    if (get().uniquenessConstruction) get().abandonUniquenessConstruction()
    if (get().frequencyConstruction) get().abandonFrequencyConstruction()
    if (get().sequenceConstruction) get().abandonSequenceConstruction()
    if (kind === 'implicitLink') {
      const [factId, roleIndex] = id.split('_il_').map((v, i) => i === 0 ? v : Number(v))
      set({ selectedId: id, selectedKind: 'implicitLink', selectedImplicitLink: roleIndex, selectedRole: null, selectedUniqueness: null, selectedImplicitLinkRole: null,
            selectedMandatoryDot: null, selectedInternalFrequency: null,
            selectedValueRange: null, selectedCardinalityRange: null, multiSelectedIds: [],
            selectedOccurrenceId: null, multiSelectedOccurrenceIds: [] })
      return
    }
    set({ selectedId: id, selectedKind: kind, selectedRole: null, selectedImplicitLink: null, selectedImplicitLinkRole: null, selectedUniqueness: null,
          selectedMandatoryDot: null, selectedInternalFrequency: null,
          selectedValueRange: null, selectedCardinalityRange: null, multiSelectedIds: [],
          selectedOccurrenceId: occurrenceId, multiSelectedOccurrenceIds: [] })
  },
  clearSelection() {
    if (get().uniquenessConstruction) get().abandonUniquenessConstruction()
    if (get().frequencyConstruction) get().abandonFrequencyConstruction()
    if (get().sequenceConstruction) get().abandonSequenceConstruction()
    set({ selectedId: null, selectedKind: null, selectedRole: null, selectedImplicitLink: null, selectedImplicitLinkRole: null, selectedUniqueness: null,
          selectedMandatoryDot: null, selectedInternalFrequency: null,
          selectedValueRange: null, selectedCardinalityRange: null, multiSelectedIds: [],
          selectedOccurrenceId: null, multiSelectedOccurrenceIds: [] })
  },

  selectMandatoryDot(factId, roleIndex) {
    if (get().uniquenessConstruction) get().abandonUniquenessConstruction()
    if (get().frequencyConstruction) get().abandonFrequencyConstruction()
    set({ selectedMandatoryDot: { factId, roleIndex }, selectedId: null, selectedKind: null,
          selectedRole: null, selectedUniqueness: null, selectedInternalFrequency: null,
          selectedValueRange: null, selectedCardinalityRange: null, multiSelectedIds: [],
          selectedOccurrenceId: null, multiSelectedOccurrenceIds: [] })
  },
  deselectMandatoryDot() { set({ selectedMandatoryDot: null }) },

  // Implied internal constraints derived from a preferred identifier:
  //   - implied unary uniqueness on the role NOT covered by the preferred UC
  //   - implied mandatory on the same role
  // These are read-only — selecting opens an inspector but no edit/delete is permitted.
  selectImpliedUniqueness(factId, roleIndex) {
    if (get().uniquenessConstruction) get().abandonUniquenessConstruction()
    if (get().frequencyConstruction) get().abandonFrequencyConstruction()
    set({ selectedUniqueness: { factId, impliedRoleIndex: roleIndex, implied: true },
          selectedId: null, selectedKind: null, selectedRole: null,
          selectedMandatoryDot: null, selectedInternalFrequency: null,
          selectedValueRange: null, selectedCardinalityRange: null, multiSelectedIds: [],
          selectedOccurrenceId: null, multiSelectedOccurrenceIds: [] })
  },
  selectImpliedMandatoryDot(factId, roleIndex) {
    if (get().uniquenessConstruction) get().abandonUniquenessConstruction()
    if (get().frequencyConstruction) get().abandonFrequencyConstruction()
    set({ selectedMandatoryDot: { factId, roleIndex, implied: true },
          selectedId: null, selectedKind: null, selectedRole: null,
          selectedUniqueness: null, selectedInternalFrequency: null,
          selectedValueRange: null, selectedCardinalityRange: null, multiSelectedIds: [],
          selectedOccurrenceId: null, multiSelectedOccurrenceIds: [] })
  },

  selectInternalFrequency(factId, ifId) {
    if (get().uniquenessConstruction) get().abandonUniquenessConstruction()
    if (get().frequencyConstruction) get().abandonFrequencyConstruction()
    set({ selectedInternalFrequency: { factId, ifId }, selectedId: null, selectedKind: null,
          selectedRole: null, selectedUniqueness: null, selectedMandatoryDot: null,
          selectedValueRange: null, selectedCardinalityRange: null, multiSelectedIds: [],
          selectedOccurrenceId: null, multiSelectedOccurrenceIds: [] })
  },
  deselectInternalFrequency() { set({ selectedInternalFrequency: null }) },

  selectValueRange(desc) {
    set({ selectedValueRange: desc, selectedId: null, selectedKind: null,
          selectedRole: null, selectedUniqueness: null, selectedMandatoryDot: null,
          selectedInternalFrequency: null, selectedCardinalityRange: null, multiSelectedIds: [],
          selectedOccurrenceId: null, multiSelectedOccurrenceIds: [] })
  },
  deselectValueRange() { set({ selectedValueRange: null }) },
  removeValueRange(desc) {
    if (desc.otId)          get().updateObjectType(desc.otId, { valueRange: [] })
    else if (desc.factId != null) get().updateRole(desc.factId, desc.roleIndex, { valueRange: [] })
    else if (desc.nestedFactId)   get().updateFact(desc.nestedFactId, { valueRange: null })
    set({ selectedValueRange: null })
  },

  selectCardinalityRange(desc) {
    set({ selectedCardinalityRange: desc, selectedId: null, selectedKind: null,
          selectedRole: null, selectedUniqueness: null, selectedMandatoryDot: null,
          selectedInternalFrequency: null, selectedValueRange: null, multiSelectedIds: [],
          selectedOccurrenceId: null, multiSelectedOccurrenceIds: [] })
  },
  deselectCardinalityRange() { set({ selectedCardinalityRange: null }) },
  removeCardinalityRange(desc) {
    if (desc.otId)          get().updateObjectType(desc.otId, { cardinalityRange: [] })
    else if (desc.factId != null) get().updateRole(desc.factId, desc.roleIndex, { cardinalityRange: [] })
    else if (desc.nestedFactId)   get().updateFact(desc.nestedFactId, { cardinalityRange: null })
    set({ selectedCardinalityRange: null })
  },

  removeMandatoryRole(factId, roleIndex) {
    set(s => ({
      facts: s.facts.map(f => {
        if (f.id !== factId) return f
        const roles = f.roles.map((r, i) => i === roleIndex ? { ...r, mandatory: false } : r)
        return { ...f, roles }
      }),
      selectedMandatoryDot: null,
      isDirty: true,
    }))
  },

  selectAll() {
    const { objectTypes, facts, constraints, subtypes, diagrams, activeDiagramId } = get()
    const activeDiagram = diagrams.find(d => d.id === activeDiagramId)

    const visible = (id) => inDiag(activeDiagram, id)

    const shownILKeys = new Set(activeDiagram?.shownImplicitLinks ?? [])
    const impliedLinkIds = facts
      .filter(f => f.objectified && visible(f.id))
      .flatMap(f => (f.implicitLinks || []).map((_, i) => `${f.id}:${i}`))
      .filter(key => shownILKeys.has(key))
      .map(key => { const [fid, ri] = key.split(':'); return `${fid}_il_${ri}` })

    const ids = [
      ...objectTypes.filter(o  => visible(o.id)).map(o  => o.id),
      ...facts       .filter(f  => visible(f.id)).map(f  => f.id),
      ...constraints .filter(c  => visible(c.id)).map(c  => c.id),
      ...subtypes    .filter(st => visible(st.id)).map(st => st.id),
      ...impliedLinkIds,
    ]
    set({ multiSelectedIds: ids, selectedId: null, selectedKind: null,
          selectedRole: null, selectedUniqueness: null })
  },

  shiftSelect(id, occurrenceId = null) {
    set(s => {
      const base = s.multiSelectedIds.length > 0
        ? s.multiSelectedIds
        : (s.selectedId ? [s.selectedId] : [])
      const baseOccs = s.multiSelectedOccurrenceIds.length > 0
        ? s.multiSelectedOccurrenceIds
        : (s.selectedOccurrenceId ? [s.selectedOccurrenceId] : [])

      const isRemoving = occurrenceId ? baseOccs.includes(occurrenceId) : base.includes(id)

      let nextBase = isRemoving ? base.filter(i => i !== id) : (base.includes(id) ? base : [...base, id])
      let nextOccs = occurrenceId
        ? (isRemoving ? baseOccs.filter(o => o !== occurrenceId) : [...baseOccs, occurrenceId])
        : baseOccs

      // When adding/removing an entity with a collapsed ref-mode, also add/remove
      // the implied fact type and value type (only for schema-level operations).
      if (!occurrenceId || !isRemoving) {
        const ot = s.objectTypes.find(o => o.id === id)
               ?? s.facts.find(f => f.id === id && f.objectified)
        if (ot) {
          const rm = findRefMode(ot, s.facts, s.objectTypes)
          if (rm) {
            const activeDiag = s.diagrams.find(d => d.id === s.activeDiagramId)
            const expOccs = new Set(activeDiag?.expandedRefModeOccs ?? [])
            const anyExpanded = (activeDiag?.occurrences ?? []).some(o => o.schemaElementId === id && expOccs.has(o.id))
            if (!anyExpanded) {
              if (isRemoving) {
                nextBase = nextBase.filter(i => i !== rm.factId && i !== rm.vtId)
              } else {
                if (!nextBase.includes(rm.factId)) nextBase = [...nextBase, rm.factId]
                if (!nextBase.includes(rm.vtId))   nextBase = [...nextBase, rm.vtId]
              }
            }
          }
        }
      }
      return { multiSelectedIds: nextBase, multiSelectedOccurrenceIds: nextOccs,
               selectedId: null, selectedKind: null, selectedOccurrenceId: null,
               selectedRole: null, selectedUniqueness: null }
    })
  },

  setMultiSelection(ids, occurrenceIds = []) {
    if (ids.length === 0) {
      set({ multiSelectedIds: [], multiSelectedOccurrenceIds: [],
            selectedId: null, selectedKind: null, selectedOccurrenceId: null,
            selectedRole: null, selectedUniqueness: null })
    } else {
      set(s => {
        const activeDiagMulti = s.diagrams.find(d => d.id === s.activeDiagramId)
        const expOccsMulti = new Set(activeDiagMulti?.expandedRefModeOccs ?? [])
        const result = [...ids]
        const idSet = new Set(ids)
        for (const id of ids) {
          const ot = s.objectTypes.find(o => o.id === id)
                 ?? s.facts.find(f => f.id === id && f.objectified)
          const anyExpanded = (activeDiagMulti?.occurrences ?? []).some(o => o.schemaElementId === id && expOccsMulti.has(o.id))
          if (!ot || anyExpanded) continue
          const rm = findRefMode(ot, s.facts, s.objectTypes)
          if (!rm) continue
          if (!idSet.has(rm.factId)) { idSet.add(rm.factId); result.push(rm.factId) }
          if (!idSet.has(rm.vtId))   { idSet.add(rm.vtId);   result.push(rm.vtId) }
        }
        return { multiSelectedIds: result, multiSelectedOccurrenceIds: occurrenceIds,
                 selectedId: null, selectedKind: null, selectedOccurrenceId: null,
                 selectedRole: null, selectedUniqueness: null }
      })
    }
  },

  clearMultiSelection() {
    set({ multiSelectedIds: [], multiSelectedOccurrenceIds: [] })
  },

  alignMultiSelection(axis) {
    const { multiSelectedIds, activeDiagramId, diagrams, objectTypes, facts, constraints } = get()
    if (multiSelectedIds.length < 2) return
    const idSet   = new Set(multiSelectedIds)
    const diagram = diagrams.find(d => d.id === activeDiagramId)

    // Collect ref-mode fact/VT IDs whose parent entity has a collapsed ref-mode
    // in this diagram — these are rendered as part of the entity node and must
    // not participate in alignment as independent elements.
    const expOccsAlign = new Set(diagram?.expandedRefModeOccs ?? [])
    const impliedCollapsed = new Set()
    for (const id of multiSelectedIds) {
      const ot = objectTypes.find(o => o.id === id)
             ?? facts.find(f => f.id === id && f.objectified)
      if (!ot) continue
      const rm = findRefMode(ot, facts, objectTypes)
      const anyExpandedAlign = (diagram?.occurrences ?? []).some(o => o.schemaElementId === id && expOccsAlign.has(o.id))
      if (!rm || anyExpandedAlign) continue
      impliedCollapsed.add(rm.factId)
      impliedCollapsed.add(rm.vtId)
    }

    const getAxis = (id) => {
      const occ = occOf(diagram, id)
      if (occ) return occ[axis]
      const ot = objectTypes.find(o => o.id === id); if (ot) return ot[axis]
      const f  = facts.find(f => f.id === id);       if (f)  return f[axis]
      const c  = constraints.find(c => c.id === id); if (c)  return c[axis]
      return 0
    }

    const ids = [...idSet].filter(id =>
      !impliedCollapsed.has(id) && (
        objectTypes.some(o => o.id === id) ||
        facts.some(f => f.id === id) ||
        constraints.some(c => c.id === id)
      )
    )
    if (ids.length < 2) return
    const target = Math.round(ids.reduce((s, id) => s + getAxis(id), 0) / ids.length)

    set(s => ({
      diagrams: s.diagrams.map(d => {
        if (d.id !== activeDiagramId) return d
        let nd = d
        for (const id of ids) {
          nd = patchOcc(nd, id, { [axis]: target })
        }
        return nd
      }),
      isDirty: true,
    }))
  },

  deleteMultiSelection() {
    const { multiSelectedIds, linkDraft, sequenceConstruction } = get()
    if (multiSelectedIds.length === 0) return
    const idSet = new Set(multiSelectedIds)
    // Parse implicit link IDs
    const implicitLinkIds = new Set(multiSelectedIds.filter(id => id.includes('_il_')))
    const implicitLinksToDelete = []
    for (const id of implicitLinkIds) {
      const [factId, roleIndex] = id.split('_il_').map((v, i) => i === 0 ? v : Number(v))
      implicitLinksToDelete.push({ factId, roleIndex })
    }
    const ilKeysToRemove = new Set(implicitLinksToDelete.map(il => `${il.factId}:${il.roleIndex}`))
    const ilPosKeysToRemove = new Set(implicitLinksToDelete.map(il => `${il.factId}:il:${il.roleIndex}`))
    set(s => {
      const otIds   = new Set(s.objectTypes.filter(o => idSet.has(o.id)).map(o => o.id))
      const factIds = new Set(s.facts.filter(f => idSet.has(f.id) &&
        !(linkDraft?.type === 'roleAssign' && linkDraft?.factId === f.id)).map(f => f.id))
      const stIds   = new Set(s.subtypes.filter(st => idSet.has(st.id)).map(st => st.id))
      const conIds  = new Set(s.constraints.filter(c => idSet.has(c.id) &&
        !(sequenceConstruction?.constraintId === c.id)).map(c => c.id))

      // Subtypes removed because their OT endpoint is also being deleted
      const implicitStIds = new Set(s.subtypes
        .filter(st => otIds.has(st.subId) || otIds.has(st.superId))
        .map(st => st.id))
      const allStIds = new Set([...stIds, ...implicitStIds])

      return {
        objectTypes: s.objectTypes.filter(o => !otIds.has(o.id)),
        facts: s.facts
          .filter(f => !factIds.has(f.id))
          .map(f => ({
            ...f,
            roles: f.roles.map(r => otIds.has(r.objectTypeId) ? { ...r, objectTypeId: null } : r),
          })),
        subtypes: s.subtypes.filter(st => !allStIds.has(st.id)),
        constraints: s.constraints
          .filter(c => !conIds.has(c.id))
          .map(c => {
            let updated = c
            // Remove role-sequence refs to deleted facts
            if (updated.roleSequences) {
              updated = { ...updated, roleSequences: updated.roleSequences.map(g => g.filter(r => !factIds.has(r.factId))) }
            }
            // Remove subtype refs from sequences
            if (updated.sequences) {
              const positionsToRemove = new Set()
              updated.sequences.forEach(g => g.forEach((m, i) => {
                if (m.kind === 'subtype' && allStIds.has(m.subtypeId)) positionsToRemove.add(i)
              }))
              if (positionsToRemove.size > 0) {
                updated = { ...updated, sequences: updated.sequences.map(g => g.filter((_, i) => !positionsToRemove.has(i))) }
              }
              updated = { ...updated, subtypeIds: (updated.subtypeIds || []).filter(sid => !allStIds.has(sid)) }
            } else {
              updated = { ...updated, subtypeIds: (updated.subtypeIds || []).filter(sid => !allStIds.has(sid)) }
            }
            return updated
          }),
        diagrams: s.diagrams.map(d => {
          // Remove occurrences for deleted elements
          let nd = { ...d, occurrences: (d.occurrences ?? []).filter(o =>
            !otIds.has(o.schemaElementId) && !factIds.has(o.schemaElementId) && !conIds.has(o.schemaElementId)
          )}
          // Clean up implicit link positions
          const newILP = Object.fromEntries(
            Object.entries(nd.implicitLinkPositions ?? {}).filter(([k]) => {
              if (ilPosKeysToRemove.has(k)) return false
              for (const ilKey of ilKeysToRemove) {
                if (k.startsWith(`${ilKey}:if:`)) return false
              }
              return true
            })
          )
          nd = { ...nd, implicitLinkPositions: newILP, shownImplicitLinks: (d.shownImplicitLinks || []).filter(ilKey => !ilKeysToRemove.has(ilKey)) }
          return nd
        }),
        selectedId: null,
        selectedKind: null,
        selectedRole: null,
        multiSelectedIds: [],
        selectedOccurrenceId: null,
        multiSelectedOccurrenceIds: [],
        isDirty: true,
      }
    })
  },

  selectConnected() {
    const s = get()
    const startId = s.multiSelectedIds.length > 0 ? s.multiSelectedIds[0] : s.selectedId
    if (!startId) return
    const ids = computeConnectedIds(startId, s)
    set({ multiSelectedIds: ids, selectedId: null, selectedKind: null,
          selectedRole: null, selectedUniqueness: null })
  },
  startUniquenessConstruction(factId) {
    if (get().frequencyConstruction) get().abandonFrequencyConstruction()
    set({ uniquenessConstruction: { factId, roleIndices: [] } })
  },
  toggleUniquenessConstructionRole(roleIndex) {
    set(s => {
      const uc = s.uniquenessConstruction
      if (!uc) return {}
      const has = uc.roleIndices.includes(roleIndex)
      return { uniquenessConstruction: {
        ...uc,
        roleIndices: has ? uc.roleIndices.filter(i => i !== roleIndex) : [...uc.roleIndices, roleIndex],
      }}
    })
  },
  abandonUniquenessConstruction() {
    set({ uniquenessConstruction: null })
  },
  commitUniquenessConstruction() {
    const uc = get().uniquenessConstruction
    set({ uniquenessConstruction: null })
    if (!uc) return
    const fact = get().facts.find(f => f.id === uc.factId)
    if (!fact) return

    if (uc.uIndex != null) {
      // Editing an existing constraint — replace it unless unchanged
      const oldRoles = fact.uniqueness[uc.uIndex]
      if (!oldRoles) return
      const oldKey = JSON.stringify([...oldRoles].sort((a, b) => a - b))
      const newKey = JSON.stringify([...uc.roleIndices].sort((a, b) => a - b))
      if (oldKey === newKey) return  // unchanged — selectedUniqueness still valid
      // If the new role set already exists as a different constraint, leave everything intact
      const alreadyExists = fact.uniqueness.some((u, i) =>
        i !== uc.uIndex && JSON.stringify([...u].sort((a, b) => a - b)) === newKey
      )
      if (alreadyExists) return  // selectedUniqueness stays pointing to the unchanged bar
      get().toggleUniqueness(uc.factId, oldRoles)           // remove old
      if (uc.roleIndices.length > 0) {
        get().toggleUniqueness(uc.factId, uc.roleIndices)   // add new
        // Re-select the bar at its new index
        const updatedFact = get().facts.find(f => f.id === uc.factId)
        if (updatedFact) {
          const newIdx = updatedFact.uniqueness.findIndex(u =>
            JSON.stringify([...u].sort((a, b) => a - b)) === newKey)
          if (newIdx >= 0) get().selectUniqueness(uc.factId, newIdx)
          else get().select(uc.factId, 'fact')
        }
      } else {
        // All roles removed — bar deleted, return to fact inspector
        get().select(uc.factId, 'fact')
      }
    } else {
      // New constraint
      if (uc.roleIndices.length === 0) return
      const key = JSON.stringify([...uc.roleIndices].sort((a, b) => a - b))
      const exists = fact.uniqueness.some(u => JSON.stringify([...u].sort((a, b) => a - b)) === key)
      if (!exists) get().toggleUniqueness(uc.factId, uc.roleIndices)
    }
  },
  updateUniquenessRoles(factId, uIndex, newRoles) {
    if (newRoles.length === 0) return
    const fact = get().facts.find(f => f.id === factId)
    if (!fact) return
    const oldRoles = fact.uniqueness[uIndex]
    if (!oldRoles) return
    const oldKey = JSON.stringify([...oldRoles].sort((a, b) => a - b))
    const newKey = JSON.stringify([...newRoles].sort((a, b) => a - b))
    if (oldKey === newKey) return
    // Don't allow if the new set duplicates another bar
    const duplicate = fact.uniqueness.some((u, i) =>
      i !== uIndex && JSON.stringify([...u].sort((a, b) => a - b)) === newKey)
    if (duplicate) return
    get().toggleUniqueness(factId, oldRoles)   // remove old
    get().toggleUniqueness(factId, newRoles)   // add new
    // Re-select at the new index
    const updated = get().facts.find(f => f.id === factId)
    if (updated) {
      const newIdx = updated.uniqueness.findIndex(u =>
        JSON.stringify([...u].sort((a, b) => a - b)) === newKey)
      if (newIdx >= 0) get().selectUniqueness(factId, newIdx)
    }
  },
  addUniquenessBar(factId) {
    const fact = get().facts.find(f => f.id === factId)
    if (!fact) return
    const newRoles = []
    const hasEmpty = fact.uniqueness.some(u => u.length === 0)
    if (hasEmpty) return
    get().toggleUniqueness(factId, newRoles)
    const updated = get().facts.find(f => f.id === factId)
    if (!updated) return
    const newIdx = updated.uniqueness.findIndex(u => u.length === 0)
    if (newIdx >= 0) get().selectUniqueness(factId, newIdx)
  },
  addInternalFrequencyBar(factId) {
    const fact = get().facts.find(f => f.id === factId)
    if (!fact) return
    const ifId = uid()
    set(s => ({
      facts: s.facts.map(f => f.id !== factId ? f : {
        ...f,
        internalFrequency: [...(f.internalFrequency || []), {
          id: ifId, roles: [], range: [], x: f.x + 40, y: f.y - 30,
        }],
      }),
      isDirty: true,
    }))
    get().selectInternalFrequency(factId, ifId)
  },
  startUniquenessEdit(factId, uIndex) {
    const fact = get().facts.find(f => f.id === factId)
    if (!fact) return
    const roleIndices = [...fact.uniqueness[uIndex]]
    set({
      uniquenessConstruction: { factId, roleIndices, uIndex },
      selectedId: factId, selectedKind: 'fact',
      selectedUniqueness: { factId, uIndex },
      selectedRole: null, selectedMandatoryDot: null, selectedInternalFrequency: null,
      selectedValueRange: null, selectedCardinalityRange: null, multiSelectedIds: [],
      selectedOccurrenceId: null, multiSelectedOccurrenceIds: [],
    })
  },

  // ── Internal frequency construction ──────────────────────────────────────
  startFrequencyConstruction(factId) {
    if (get().uniquenessConstruction) get().abandonUniquenessConstruction()
    const fact = get().facts.find(f => f.id === factId)
    if (!fact) return
    set({ frequencyConstruction: { stage: 2, factId, x: fact.x + 40, y: fact.y - 30, roleIndices: [], ifId: null } })
  },
  moveFrequencyConstructionCircle(x, y) {
    set(s => s.frequencyConstruction
      ? { frequencyConstruction: { ...s.frequencyConstruction, x, y } } : {})
  },
  toggleFrequencyConstructionRole(roleIndex) {
    set(s => {
      const fc = s.frequencyConstruction
      if (!fc || fc.stage !== 2) return {}
      const has = fc.roleIndices.includes(roleIndex)
      return { frequencyConstruction: {
        ...fc,
        roleIndices: has ? fc.roleIndices.filter(i => i !== roleIndex) : [...fc.roleIndices, roleIndex],
      }}
    })
  },
  advanceFrequencyToRange() {
    const fc = get().frequencyConstruction
    if (!fc || fc.stage !== 2) return
    if (fc.ifId != null) {
      // Editing existing: commit role changes now, keep the existing range
      set({ frequencyConstruction: null })
      if (fc.roleIndices.length === 0) {
        get().removeInternalFrequency(fc.factId, fc.ifId)
      } else {
        const fact = get().facts.find(f => f.id === fc.factId)
        const existing = (fact?.internalFrequency || []).find(i => i.id === fc.ifId)
        get().updateInternalFrequency(fc.factId, fc.ifId, {
          roles: fc.roleIndices, x: fc.x, y: fc.y,
          range: existing?.range ?? [],
        })
      }
    } else {
      // New constraint: advance to range popup
      set({ frequencyConstruction: { ...fc, stage: 3, range: fc.range ?? [] } })
    }
  },
  updateFrequencyConstructionRange(range) {
    set(s => s.frequencyConstruction
      ? { frequencyConstruction: { ...s.frequencyConstruction, range } } : {})
  },
  abandonFrequencyConstruction() {
    set({ frequencyConstruction: null })
  },
  commitFrequencyConstruction() {
    const fc = get().frequencyConstruction
    set({ frequencyConstruction: null, tool: 'select' })
    if (!fc || fc.stage !== 3) return
    if (fc.constraintId != null) {
      // External frequency constraint
      get().updateConstraint(fc.constraintId, { frequency: fc.range ?? [] })
      return
    }
    if (fc.ifId != null) {
      // Editing an existing IF constraint
      const fact = get().facts.find(f => f.id === fc.factId)
      if (!fact) return
      const ifExists = (fact.internalFrequency || []).some(i => i.id === fc.ifId)
      if (!ifExists) return
      if (fc.roleIndices.length === 0) {
        get().removeInternalFrequency(fc.factId, fc.ifId)
      } else {
        get().updateInternalFrequency(fc.factId, fc.ifId, { roles: fc.roleIndices, range: fc.range ?? [], x: fc.x, y: fc.y })
      }
    } else {
      // New IF constraint
      if (fc.roleIndices.length === 0) return
      set(s => ({
        facts: s.facts.map(f => f.id !== fc.factId ? f : {
          ...f,
          internalFrequency: [...(f.internalFrequency || []), {
            id: uid(), roles: [...fc.roleIndices], range: fc.range ?? [], x: fc.x, y: fc.y,
          }],
        }),
        isDirty: true,
      }))
    }
  },
  startExternalFrequencyEdit(constraintId) {
    const c = get().constraints.find(c => c.id === constraintId)
    if (!c) return
    set({ frequencyConstruction: {
      stage: 3, constraintId,
      x: c.x + 40, y: c.y - 30,
      range: c.frequency ?? [],
    }})
  },
  startFrequencyRangeEdit(factId, ifId) {
    const fact = get().facts.find(f => f.id === factId)
    if (!fact) return
    const ifItem = (fact.internalFrequency || []).find(i => i.id === ifId)
    if (!ifItem) return
    set({ frequencyConstruction: {
      stage: 3, factId, ifId,
      x: ifItem.x ?? fact.x + 40,
      y: ifItem.y ?? fact.y - 30,
      roleIndices: [...ifItem.roles],
      range: ifItem.range ?? [],
    }})
  },
  startFrequencyEdit(factId, ifId) {
    const fact = get().facts.find(f => f.id === factId)
    if (!fact) return
    const ifItem = (fact.internalFrequency || []).find(i => i.id === ifId)
    if (!ifItem) return
    if (get().uniquenessConstruction) get().abandonUniquenessConstruction()
    set({ frequencyConstruction: {
      stage: 2, factId,
      x: ifItem.x ?? fact.x + 40,
      y: ifItem.y ?? fact.y - 30,
      roleIndices: [...ifItem.roles], ifId,
    }, selectedInternalFrequency: null })
  },
  updateInternalFrequency(factId, ifId, patch) {
    set(s => ({
      facts: s.facts.map(f => f.id !== factId ? f : {
        ...f,
        internalFrequency: (f.internalFrequency || []).map(i => i.id === ifId ? { ...i, ...patch } : i),
      }),
      isDirty: true,
    }))
  },
  removeInternalFrequency(factId, ifId) {
    set(s => {
      const fact = s.facts.find(f => f.id === factId)
      const ilKeysToRemove = new Set((fact?.implicitLinks || []).map(il => `${factId}:il:${il.roleIndex}:if:${ifId}`))
      return {
        facts: s.facts.map(f => f.id !== factId ? f : {
          ...f,
          internalFrequency: (f.internalFrequency || []).filter(i => i.id !== ifId),
        }),
        diagrams: s.diagrams.map(d => ({
          ...d,
          implicitLinkPositions: Object.fromEntries(Object.entries(d.implicitLinkPositions ?? {}).filter(([k]) => !ilKeysToRemove.has(k))),
        })),
        selectedInternalFrequency: null,
        isDirty: true,
      }
    })
  },

  convertFrequencyToUniqueness(factId, ifId) {
    const fact = get().facts.find(f => f.id === factId)
    if (!fact) return
    const ifItem = (fact.internalFrequency || []).find(i => i.id === ifId)
    if (!ifItem) return
    const roles = [...ifItem.roles]
    const key = JSON.stringify([...roles].sort((a, b) => a - b))
    const alreadyExists = fact.uniqueness.some(u => JSON.stringify([...u].sort((a, b) => a - b)) === key)
    set(s => ({
      facts: s.facts.map(f => {
        if (f.id !== factId) return f
        const internalFrequency = (f.internalFrequency || []).filter(i => i.id !== ifId)
        if (alreadyExists) return { ...f, internalFrequency }
        const uniqueness = [...f.uniqueness, roles].sort((a, b) => a.length - b.length)
        return { ...f, internalFrequency, uniqueness }
      }),
      isDirty: true,
    }))
    if (!alreadyExists) {
      const updated = get().facts.find(f => f.id === factId)
      const uIndex = updated.uniqueness.findIndex(u => JSON.stringify([...u].sort((a, b) => a - b)) === key)
      if (uIndex !== -1) get().selectUniqueness(factId, uIndex)
    } else {
      get().select(factId, 'fact')
    }
  },

  convertUniquenessToFrequency(factId, uRoles) {
    const fact = get().facts.find(f => f.id === factId)
    if (!fact) return
    const ifId = uid()
    const key = JSON.stringify([...uRoles].sort((a, b) => a - b))
    const activeDiagram = get().diagrams.find(d => d.id === get().activeDiagramId)
    const factOcc = occOf(activeDiagram, factId)
    const factPos = factOcc ? { x: factOcc.x, y: factOcc.y } : { x: fact.x, y: fact.y }
    set(s => ({
      facts: s.facts.map(f => {
        if (f.id !== factId) return f
        const uniqueness = f.uniqueness.filter(u => JSON.stringify([...u].sort((a, b) => a - b)) !== key)
        const preferredUniqueness = (f.preferredUniqueness || []).filter(pu =>
          JSON.stringify([...pu].sort((a, b) => a - b)) !== key
        )
        return {
          ...f,
          uniqueness,
          preferredUniqueness: preferredUniqueness.length > 0 ? preferredUniqueness : [],
          internalFrequency: [...(f.internalFrequency || []), {
            id: ifId, roles: [...uRoles], range: [{ type: 'upper', upper: 1 }], x: factPos.x + 40, y: factPos.y - 30,
          }],
        }
      }),
      isDirty: true,
    }))
    get().selectInternalFrequency(factId, ifId)
  },

  selectRole(factId, roleIndex, occurrenceId = null) {
    set({ selectedId: factId, selectedKind: 'fact', selectedRole: { factId, roleIndex, occurrenceId },
          selectedOccurrenceId: occurrenceId, multiSelectedOccurrenceIds: [],
          selectedUniqueness: null, selectedMandatoryDot: null, selectedInternalFrequency: null,
          selectedValueRange: null, selectedCardinalityRange: null })
  },
  selectUniqueness(factId, uIndex, occurrenceId = null) {
    if (get().uniquenessConstruction) get().abandonUniquenessConstruction()
    if (get().frequencyConstruction) get().abandonFrequencyConstruction()
    set({ selectedId: factId, selectedKind: 'fact', selectedUniqueness: { factId, uIndex, occurrenceId },
          selectedOccurrenceId: occurrenceId, multiSelectedOccurrenceIds: [],
          selectedRole: null, selectedMandatoryDot: null, selectedInternalFrequency: null,
          selectedValueRange: null, selectedCardinalityRange: null })
  },

  // ── tool & link drafts ───────────────────────────────────────────────────

  setTool(tool)    {
    const prev = get().tool
    const clearRoleSelection = (prev === 'assignRole' && tool !== 'assignRole')
    set({ tool, linkDraft: null, roleReconnectDraft: null, ...(clearRoleSelection ? { selectedId: null, selectedKind: null, selectedRole: null, selectedUniqueness: null } : {}) })
  },
  setLinkDraft(d)  { set({ linkDraft: d }) },
  clearLinkDraft() { set({ linkDraft: null, roleReconnectDraft: null }) },

  // ── view ─────────────────────────────────────────────────────────────────

  centerOnElement(id) {
    const { objectTypes, facts, constraints, subtypes, diagrams, activeDiagramId, zoom } = get()
    const diagram = diagrams.find(d => d.id === activeDiagramId)
    const getElemPos = el => {
      const occ = occOf(diagram, el.id)
      return { x: occ?.x ?? el.x, y: occ?.y ?? el.y }
    }

    let wx, wy
    const ot = objectTypes.find(o => o.id === id)
    if (ot) { const p = getElemPos(ot); wx = p.x; wy = p.y }
    if (wx == null) {
      const f = facts.find(f => f.id === id)
      if (f) { const p = getElemPos(f); wx = p.x; wy = p.y }
    }
    if (wx == null) {
      const c = constraints.find(c => c.id === id)
      if (c) {
        const cocc = cOccOf(diagram, id)
        wx = cocc?.x ?? c.x; wy = cocc?.y ?? c.y
      }
    }
    if (wx == null) {
      const st = subtypes.find(s => s.id === id)
      if (st) {
        const sub = objectTypes.find(o => o.id === st.subId) || facts.find(f => f.id === st.subId)
        const sup = objectTypes.find(o => o.id === st.superId) || facts.find(f => f.id === st.superId)
        if (sub && sup) {
          const sp = getElemPos(sub), tp = getElemPos(sup)
          wx = (sp.x + tp.x) / 2; wy = (sp.y + tp.y) / 2
        }
      }
    }
    if (wx == null) {
      const note = (diagram?.notes ?? []).find(n => n.id === id)
      if (note) { wx = note.x; wy = note.y }
    }
    if (wx == null) return
    const svg = document.getElementById('orm2-canvas-svg')
    if (!svg) return
    const rect = svg.getBoundingClientRect()
    const targetX = rect.width  / 2 - wx * zoom
    const targetY = rect.height / 2 - wy * zoom
    const { pan: startPan } = get()
    const fromX = startPan.x, fromY = startPan.y
    const DURATION = 750
    const easeInOut = t => t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t
    const startTime = performance.now()
    if (_panAnimId) cancelAnimationFrame(_panAnimId)
    const step = (now) => {
      const t = Math.min((now - startTime) / DURATION, 1)
      const e = easeInOut(t)
      set({ pan: { x: fromX + (targetX - fromX) * e, y: fromY + (targetY - fromY) * e } })
      if (t < 1) _panAnimId = requestAnimationFrame(step)
      else _panAnimId = null
    }
    _panAnimId = requestAnimationFrame(step)
  },

  centerOnOccurrence(occurrenceId) {
    const { diagrams, activeDiagramId, zoom } = get()
    const diagram = diagrams.find(d => d.id === activeDiagramId)
    const occ = diagram?.occurrences?.find(o => o.id === occurrenceId)
    if (!occ) return
    const wx = occ.x, wy = occ.y
    const svg = document.getElementById('orm2-canvas-svg')
    if (!svg) return
    const rect = svg.getBoundingClientRect()
    const targetX = rect.width  / 2 - wx * zoom
    const targetY = rect.height / 2 - wy * zoom
    const { pan: startPan } = get()
    const fromX = startPan.x, fromY = startPan.y
    const DURATION = 750
    const easeInOut = t => t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t
    const startTime = performance.now()
    if (_panAnimId) cancelAnimationFrame(_panAnimId)
    const step = (now) => {
      const t = Math.min((now - startTime) / DURATION, 1)
      const e = easeInOut(t)
      set({ pan: { x: fromX + (targetX - fromX) * e, y: fromY + (targetY - fromY) * e } })
      if (t < 1) _panAnimId = requestAnimationFrame(step)
      else _panAnimId = null
    }
    _panAnimId = requestAnimationFrame(step)
  },

  navigateToElement(elementId, elementKind) {
    const { diagrams, activeDiagramId, objectTypes, constraints } = get()
    const isConstraint = constraints.some(c => c.id === elementId)

    // Switch to a diagram that contains the element (prefer active, then any)
    const active = diagrams.find(d => d.id === activeDiagramId)
    const inActive = isConstraint ? cInDiag(active, elementId) : inDiag(active, elementId)
    if (!inActive) {
      const target = diagrams.find(d =>
        d.id !== activeDiagramId && (isConstraint ? cInDiag(d, elementId) : inDiag(d, elementId))
      )
      if (target) get().setActiveDiagram(target.id)
    }

    // Resolve kind for select()
    const kind = elementKind === 'objectType'
      ? (objectTypes.find(o => o.id === elementId)?.kind ?? 'entity')
      : elementKind

    // Allow the diagram switch to settle before selecting and centering
    setTimeout(() => {
      get().select(elementId, kind)
      get().centerOnElement(elementId)
    }, 0)
  },

  setPan(x, y)  { set({ pan: { x, y } }) },
  setZoom(z)    { set({ zoom: Math.min(3, Math.max(0.15, z)) }) },
  zoomBy(delta) { set(s => ({ zoom: Math.min(3, Math.max(0.15, s.zoom + delta)) })) },
  resetView()   { set({ pan: { x: 0, y: 0 }, zoom: 1 }) },
  fitToContent(vpW = 1200, vpH = 700) {
    const { objectTypes, facts, constraints, diagrams, activeDiagramId } = get()
    const diagram = diagrams?.find(d => d.id === activeDiagramId)
    const getPos = (el) => {
      const occ = occOf(diagram, el.id)
      return occ ? { x: occ.x, y: occ.y } : { x: el.x, y: el.y }
    }
    const pts = [
      ...objectTypes.filter(ot => inDiag(diagram, ot.id)).map(ot => ({ ...getPos(ot), hw: 70, hh: 28 })),
      ...facts.filter(f => inDiag(diagram, f.id)).map(f => ({ ...getPos(f), hw: f.arity * 16, hh: 16 })),
      ...constraints.filter(c => inDiag(diagram, c.id)).map(c => ({ ...getPos(c), hw: 16, hh: 16 })),
    ]
    if (!pts.length) return
    const PAD = 40
    const minX = Math.min(...pts.map(p => p.x - p.hw)) - PAD
    const minY = Math.min(...pts.map(p => p.y - p.hh)) - PAD
    const maxX = Math.max(...pts.map(p => p.x + p.hw)) + PAD
    const maxY = Math.max(...pts.map(p => p.y + p.hh)) + PAD
    const worldW = maxX - minX || 800
    const worldH = maxY - minY || 600
    const zoom = Math.min(vpW / worldW, vpH / worldH, 2)
    set({
      zoom,
      pan: {
        x: (vpW - worldW * zoom) / 2 - minX * zoom,
        y: (vpH - worldH * zoom) / 2 - minY * zoom,
      },
    })
  },

  // ── diagram management ───────────────────────────────────────────────────

  addDiagram(name = 'Diagram') {
    const d = mkDiagram(name)   // starts with empty occurrences
    set(s => {
      // In v2 all diagrams already have explicit occurrences lists (no show-all concept).
      // No migration needed — just add the new empty diagram.
      return { diagrams: [...s.diagrams, d], activeDiagramId: d.id, pan: { x: 0, y: 0 }, zoom: 1, isDirty: true }
    })
    return d.id
  },

  renameDiagram(id, name) {
    set(s => ({
      diagrams: s.diagrams.map(d => d.id === id ? { ...d, name } : d),
      isDirty: true,
    }))
  },

  deleteDiagram(id) {
    set(s => {
      if (s.diagrams.length <= 1) return {}  // can't delete the last diagram
      const newDiagrams = s.diagrams.filter(d => d.id !== id)
      const newActiveId = s.activeDiagramId === id ? newDiagrams[0]?.id : s.activeDiagramId
      // Schema elements are never deleted when a diagram is removed —
      // they persist as orphaned elements accessible via the schema browser.
      return {
        diagrams:        newDiagrams,
        activeDiagramId: newActiveId,
        isDirty: true,
      }
    })
  },

  setActiveDiagram(id) {
    const { activeDiagramId, multiSelectedIds, diagrams, pan, zoom } = get()
    if (id === activeDiagramId) return

    // Save the current multi-selection and pan/zoom into the outgoing diagram,
    // then restore the incoming diagram's own selection and viewport.
    const savedDiagrams = diagrams.map(d =>
      d.id === activeDiagramId ? { ...d, multiSelectedIds, pan, zoom } : d
    )
    const incoming = savedDiagrams.find(d => d.id === id)
    const restoredSelection = (incoming?.multiSelectedIds ?? []).filter(selId =>
      inDiag(incoming, selId)
    )

    // Rebuild occurrence IDs for the restored selection so the occurrence-aware
    // drag path is taken on the first drag after returning to this diagram.
    const restoredOccIds = restoredSelection.flatMap(selId => {
      const occs = (incoming?.occurrences ?? []).filter(o => o.schemaElementId === selId)
      if (occs.length > 0) return occs.map(o => o.id)
      const cocc = (incoming?.constraintOccurrences ?? []).find(co => co.schemaConstraintId === selId)
      return cocc ? [cocc.id] : []
    })

    set({
      diagrams:        savedDiagrams,
      activeDiagramId: id,
      pan:             incoming?.pan  ?? { x: 0, y: 0 },
      zoom:            incoming?.zoom ?? 1,
      multiSelectedIds: restoredSelection,
      multiSelectedOccurrenceIds: restoredOccIds,
      selectedId:       null,
      selectedKind:     null,
      selectedRole:     null,
      selectedUniqueness: null,
      queryEditDraft:  null,
    })
  },

  reorderDiagram(fromIndex, toIndex) {
    set(s => {
      const diagrams = [...s.diagrams]
      const [removed] = diagrams.splice(fromIndex, 1)
      const insertAt  = toIndex > fromIndex ? toIndex - 1 : toIndex
      diagrams.splice(insertAt, 0, removed)
      return { diagrams, isDirty: true }
    })
  },

  addElementToDiagram(elementId, diagramId) {
    set(s => {
      // BFS to collect all OT/fact IDs that must accompany elementId in the diagram.
      // Also tracks implied links that need to be shown.
      //
      // • OT / fact           → add it; for facts also queue all role-player OTs (principle 3)
      // • Subtype             → queue both endpoint OTs (subtype itself is implicit in diagrams)
      // • Constraint          → queue all referenced facts (including implied link parent facts),
      //                         subtype endpoints, target OT; constraint itself added by syncConstraints
      // • Implied link factId → parse "factId_il_roleIndex", queue parent fact, mark implied link shown
      const idsToAdd = new Set()
      const subtypeIdsToAdd = new Set()
      const impliedLinksToShow = new Set() // "factId:roleIndex"
      const visited  = new Set()
      const queue    = [elementId]

      while (queue.length > 0) {
        const id = queue.shift()
        if (visited.has(id)) continue
        visited.add(id)

        const st = s.subtypes.find(x => x.id === id)
        if (st) {
          subtypeIdsToAdd.add(id)
          if (!visited.has(st.subId))   queue.push(st.subId)
          if (!visited.has(st.superId)) queue.push(st.superId)
          continue
        }

        const con = s.constraints.find(x => x.id === id)
        if (con) {
          if (con.roleSequences)
            for (const seq of con.roleSequences)
              for (const ref of seq)
                if (ref.factId && !visited.has(ref.factId)) queue.push(ref.factId)
          if (con.sequences)
            for (const seq of con.sequences)
              for (const m of seq) {
                if (m.kind === 'role' && m.factId) {
                  if (!visited.has(m.factId)) queue.push(m.factId)
                }
                if (m.kind === 'subtype' && m.subtypeId && !visited.has(m.subtypeId)) queue.push(m.subtypeId)
              }
          if (con.targetObjectTypeId && !visited.has(con.targetObjectTypeId))
            queue.push(con.targetObjectTypeId)
          continue
        }

        // Check if this is an implied link fact ID (e.g. "abc_il_0")
        if (typeof id === 'string' && id.includes('_il_')) {
          const parts = id.split('_il_')
          if (parts.length === 2) {
            const parentFactId = parts[0]
            const roleIndex = Number(parts[1])
            impliedLinksToShow.add(`${parentFactId}:${roleIndex}`)
            // Queue the parent fact so it gets added to the diagram
            if (!visited.has(parentFactId)) queue.push(parentFactId)
            // Queue the associated object type (role 1 of the implied link = the OT from the parent fact's role)
            const parentFact = s.facts.find(f => f.id === parentFactId)
            if (parentFact && parentFact.roles[roleIndex]?.objectTypeId) {
              const assocId = parentFact.roles[roleIndex].objectTypeId
              if (!visited.has(assocId)) queue.push(assocId)
            }
            continue
          }
        }

        // OT or fact
        const fact = s.facts.find(f => f.id === id)
        const el   = fact ?? s.objectTypes.find(o => o.id === id)
        if (el) {
          idsToAdd.add(id)
          if (fact)
            for (const r of fact.roles)
              if (r.objectTypeId && !visited.has(r.objectTypeId)) queue.push(r.objectTypeId)
        }
      }

      const targetDiagram = s.diagrams.find(d => d.id === diagramId)
      const existingIds = new Set((targetDiagram?.occurrences ?? []).map(o => o.schemaElementId))

      const updatedDiagrams = s.diagrams.map(d => {
        if (d.id !== diagramId) return d

        let nd = d
        for (const id of idsToAdd) {
          const el = s.objectTypes.find(o => o.id === id) ?? s.facts.find(f => f.id === id)
          if (!el) continue
          nd = addOccIfAbsent(nd, id, el.x ?? 0, el.y ?? 0)
          // If this element has a ref mode, also create its owned VT/FT occurrences now
          // so each entity gets its own VT occurrence immediately (not only upon expansion).
          const ownerEl = s.objectTypes.find(o => o.id === id && o.kind === 'entity')
            ?? s.facts.find(f => f.id === id && f.objectified && f.objectifiedKind !== 'value')
          if (ownerEl) {
            const rm = findRefMode(ownerEl, s.facts, s.objectTypes)
            if (rm) {
              const vtEl = s.objectTypes.find(o => o.id === rm.vtId)
              const ftEl = s.facts.find(f => f.id === rm.factId)
              if (vtEl && ftEl) {
                nd = addOwnedRefModeOccsIfAbsent(nd, id, rm.vtId, vtEl.x ?? 0, vtEl.y ?? 0, rm.factId, ftEl.x ?? 0, ftEl.y ?? 0, rm.vtRoleIndex)
              }
            }
          }
        }

        // Add subtype occurrences with endpoint occurrence IDs (array format)
        if (subtypeIdsToAdd.size > 0) {
          const currentStOccs = new Set(nd.subtypeOccurrences ?? [])
          const newStIds = [...subtypeIdsToAdd].filter(id => !currentStOccs.has(id))
          if (newStIds.length > 0) {
            const newEndpoints = {}
            for (const stId of newStIds) {
              const st = s.subtypes.find(x => x.id === stId)
              if (!st) continue
              const subOcc  = (nd.occurrences ?? []).find(o => o.schemaElementId === st.subId)
              const superOcc = (nd.occurrences ?? []).find(o => o.schemaElementId === st.superId)
              if (subOcc && superOcc) newEndpoints[stId] = [{ subOccId: subOcc.id, superOccId: superOcc.id }]
            }
            nd = {
              ...nd,
              subtypeOccurrences: [...(nd.subtypeOccurrences ?? []), ...newStIds],
              subtypeEndpointOccs: { ...(nd.subtypeEndpointOccs ?? {}), ...newEndpoints },
            }
          }
        }

        // Add implied links to shownImplicitLinks
        const shown = d.shownImplicitLinks || []
        const newShown = new Set(shown)
        for (const ilKey of impliedLinksToShow) newShown.add(ilKey)
        const shownChanged = newShown.size !== shown.length || [...newShown].some(k => !shown.includes(k))

        return {
          ...nd,
          shownImplicitLinks: shownChanged ? [...newShown] : shown,
        }
      })

      // Select all newly added OT/fact IDs as multi-selection (including synced constraints)
      const newlyAdded = [...idsToAdd].filter(id => !existingIds.has(id))
      const syncedDiagrams = syncConstraints(updatedDiagrams, s.constraints, s.subtypes, s.facts)
      const syncedTarget = syncedDiagrams.find(d => d.id === diagramId)
      const existingConstraintIds = new Set((s.diagrams.find(d => d.id === diagramId)?.constraintOccurrences ?? []).map(co => co.schemaConstraintId))
      const newConstraintIds = (syncedTarget?.constraintOccurrences ?? [])
        .map(co => co.schemaConstraintId)
        .filter(id => !existingConstraintIds.has(id))
      const addedIds = newlyAdded.length > 0 ? newlyAdded : [...idsToAdd]
      const multiSelectedIds = [...new Set([...addedIds, ...newConstraintIds])]

      return {
        diagrams: syncedDiagrams,
        multiSelectedIds,
        selectedId: null, selectedKind: null, selectedRole: null, selectedUniqueness: null,
        isDirty: true,
      }
    })
  },

  removeElementFromDiagram(elementId, diagramId) {
    set(s => {
      // If removing a constraint directly, remove it from constraintOccurrences
      const isConstraint = s.constraints.some(c => c.id === elementId)
      if (isConstraint) {
        const updatedDiagrams = s.diagrams.map(d => d.id !== diagramId ? d : rmCOcc(d, elementId))
        return { diagrams: updatedDiagrams, isDirty: true }
      }

      // If removing a subtype directly, remove it from subtypeOccurrences and subtypeEndpointOccs
      const isSubtype = s.subtypes.some(st => st.id === elementId)
      if (isSubtype) {
        const updatedDiagrams = s.diagrams.map(d => {
          if (d.id !== diagramId) return d
          const { [elementId]: _dropped, ...restEndpoints } = d.subtypeEndpointOccs ?? {}
          return {
            ...d,
            subtypeOccurrences: (d.subtypeOccurrences ?? []).filter(id => id !== elementId),
            subtypeEndpointOccs: restEndpoints,
          }
        })
        return { diagrams: updatedDiagrams, isDirty: true }
      }

      // Cascade: removing an OT also removes every fact that has it as a role player,
      // and recursively any further OTs/facts linked through objectified facts.
      const toRemove = computeCascadeRemove(elementId, s.facts)

      const updatedDiagrams = s.diagrams.map(d => {
        if (d.id !== diagramId) return d
        const remainingOccs = (d.occurrences ?? []).filter(o => !toRemove.has(o.schemaElementId))
        const remainingOccIds = new Set(remainingOccs.map(o => o.id))
        const remainingElIds  = new Set(remainingOccs.map(o => o.schemaElementId))
        const newSubtypeEndpointOccs = {}
        const keptStIds = []
        for (const stId of (d.subtypeOccurrences ?? [])) {
          const st = s.subtypes.find(x => x.id === stId)
          if (!st || !remainingElIds.has(st.subId) || !remainingElIds.has(st.superId)) continue
          const remainingPairs = normalizeStEps((d.subtypeEndpointOccs ?? {})[stId])
            .filter(ep => remainingOccIds.has(ep.subOccId) && remainingOccIds.has(ep.superOccId))
          if (remainingPairs.length === 0) continue
          keptStIds.push(stId)
          newSubtypeEndpointOccs[stId] = remainingPairs
        }
        return {
          ...d,
          occurrences: remainingOccs,
          expandedRefModes:    (d.expandedRefModes    ?? []).filter(id => !toRemove.has(id)),
          expandedRefModeOccs: (d.expandedRefModeOccs ?? []).filter(id => remainingOccIds.has(id)),
          subtypeOccurrences:  keptStIds,
          subtypeEndpointOccs: newSubtypeEndpointOccs,
        }
      })
      const syncedDiagrams = syncConstraints(updatedDiagrams, s.constraints, s.subtypes, s.facts)
      return { diagrams: syncedDiagrams, isDirty: true }
    })
  },

  removeOccurrenceFromDiagram(occurrenceId, diagramId) {
    set(s => {
      const diag = s.diagrams.find(d => d.id === diagramId)
      if (!diag) return {}
      const occ = (diag.occurrences ?? []).find(o => o.id === occurrenceId)
      if (!occ) return {}
      const schemaElementId = occ.schemaElementId
      // Remove the occurrence itself and any owned ref-mode occurrences
      let remainingOccs = (diag.occurrences ?? []).filter(o => o.id !== occurrenceId && o.refModeOwnerOccId !== occurrenceId)
      const stillPresent = remainingOccs.some(o => o.schemaElementId === schemaElementId)

      let finalOccs = remainingOccs
      if (!stillPresent) {
        // Last occurrence of this element — cascade-remove dependent facts/OTs
        const toRemove = computeCascadeRemove(schemaElementId, s.facts)
        toRemove.delete(schemaElementId)
        finalOccs = remainingOccs.filter(o => !toRemove.has(o.schemaElementId))
      }

      const finalOccIds  = new Set(finalOccs.map(o => o.id))
      const finalElIds   = new Set(finalOccs.map(o => o.schemaElementId))
      const updatedDiagrams = s.diagrams.map(d => {
        if (d.id !== diagramId) return d
        // Remove subtype pairs that pin to the removed occurrence; drop the schema subtype
        // entirely if all its pairs are gone or its schema endpoints are no longer present.
        const newSubtypeEndpointOccs = {}
        const keptStIds = []
        for (const stId of (d.subtypeOccurrences ?? [])) {
          const st = s.subtypes.find(x => x.id === stId)
          if (!st || !finalElIds.has(st.subId) || !finalElIds.has(st.superId)) continue
          const remainingPairs = normalizeStEps((d.subtypeEndpointOccs ?? {})[stId])
            .filter(ep => ep.subOccId !== occurrenceId && ep.superOccId !== occurrenceId)
          if (remainingPairs.length === 0) continue
          keptStIds.push(stId)
          newSubtypeEndpointOccs[stId] = remainingPairs
        }
        return {
          ...d,
          occurrences: finalOccs,
          expandedRefModeOccs: (d.expandedRefModeOccs ?? []).filter(id => id !== occurrenceId && finalOccIds.has(id)),
          subtypeOccurrences:  keptStIds,
          subtypeEndpointOccs: newSubtypeEndpointOccs,
        }
      })
      const syncedDiagrams = syncConstraints(updatedDiagrams, s.constraints, s.subtypes, s.facts)
      return {
        diagrams: syncedDiagrams,
        selectedId:             s.selectedOccurrenceId === occurrenceId ? null : s.selectedId,
        selectedKind:           s.selectedOccurrenceId === occurrenceId ? null : s.selectedKind,
        selectedOccurrenceId:   s.selectedOccurrenceId === occurrenceId ? null : s.selectedOccurrenceId,
        multiSelectedIds:        s.multiSelectedIds.filter(id => id !== schemaElementId || remainingOccs.some(o => o.schemaElementId === id)),
        multiSelectedOccurrenceIds: s.multiSelectedOccurrenceIds.filter(oid => oid !== occurrenceId),
        isDirty: true,
      }
    })
  },

  removeConstraintOccurrenceFromDiagram(cOccId, diagramId) {
    set(s => ({
      diagrams: s.diagrams.map(d =>
        d.id !== diagramId ? d : {
          ...d,
          constraintOccurrences: (d.constraintOccurrences ?? []).filter(co => co.id !== cOccId),
        }
      ),
      selectedId:           s.selectedOccurrenceId === cOccId ? null : s.selectedId,
      selectedOccurrenceId: s.selectedOccurrenceId === cOccId ? null : s.selectedOccurrenceId,
      multiSelectedOccurrenceIds: s.multiSelectedOccurrenceIds.filter(id => id !== cOccId),
      isDirty: true,
    }))
  },

  removeMultiSelectionFromDiagram(diagramId, idsOverride = null) {
    const multiSelectedIds = idsOverride ?? get().multiSelectedIds
    if (multiSelectedIds.length === 0) return
    // Parse implicit link IDs
    const implicitLinkIds = multiSelectedIds.filter(id => id.includes('_il_'))
    const ilKeysToRemove = new Set(implicitLinkIds.map(id => {
      const [factId, roleIndex] = id.split('_il_').map((v, i) => i === 0 ? v : Number(v))
      return `${factId}:${roleIndex}`
    }))
    const ilPosKeysToRemove = new Set(implicitLinkIds.map(id => {
      const [factId, roleIndex] = id.split('_il_').map((v, i) => i === 0 ? v : Number(v))
      return `${factId}:il:${roleIndex}`
    }))
    set(s => {
      // Collect all IDs to remove, including cascade for each selected element
      const cascaded = new Set()
      const constraintIdSetLocal = new Set(s.constraints.map(c => c.id))
      const subtypeIdSetLocal    = new Set(s.subtypes.map(st => st.id))
      // Directly selected constraint IDs (to remove from constraintOccurrences)
      const directConstraintIds = new Set(multiSelectedIds.filter(id => constraintIdSetLocal.has(id)))
      // Directly selected subtype IDs (to remove from subtypeOccurrences)
      const directSubtypeIds = new Set(multiSelectedIds.filter(id => subtypeIdSetLocal.has(id)))
      for (const id of multiSelectedIds) {
        if (!constraintIdSetLocal.has(id) && !subtypeIdSetLocal.has(id)) {
          computeCascadeRemove(id, s.facts).forEach(cid => cascaded.add(cid))
        }
      }

      const updatedDiagrams = s.diagrams.map(d => {
        if (d.id !== diagramId) return d
        // Remove occurrences for cascaded IDs
        const newOccs = (d.occurrences ?? []).filter(o => !cascaded.has(o.schemaElementId))
        // Remove directly selected constraints from constraintOccurrences
        const newCOccs = (d.constraintOccurrences ?? []).filter(co => !directConstraintIds.has(co.schemaConstraintId))
        // Clean up implicit link positions for removed links
        const newILP = Object.fromEntries(Object.entries(d.implicitLinkPositions ?? {}).filter(([k]) => {
          if (ilPosKeysToRemove.has(k)) return false
          for (const ilKey of ilKeysToRemove) {
            if (k.startsWith(`${ilKey}:if:`)) return false
          }
          return true
        }))
        const remainingElIds = new Set(newOccs.map(o => o.schemaElementId))
        const newOccIds      = new Set(newOccs.map(o => o.id))
        const newSubtypeEndpointOccs2 = {}
        const keptStIds = []
        for (const stId of (d.subtypeOccurrences ?? [])) {
          if (directSubtypeIds.has(stId)) continue
          const st = s.subtypes.find(x => x.id === stId)
          if (!st || !remainingElIds.has(st.subId) || !remainingElIds.has(st.superId)) continue
          const remainingPairs = normalizeStEps((d.subtypeEndpointOccs ?? {})[stId])
            .filter(ep => newOccIds.has(ep.subOccId) && newOccIds.has(ep.superOccId))
          if (remainingPairs.length === 0) continue
          keptStIds.push(stId)
          newSubtypeEndpointOccs2[stId] = remainingPairs
        }
        return {
          ...d,
          occurrences: newOccs,
          constraintOccurrences: newCOccs,
          implicitLinkPositions: newILP,
          shownImplicitLinks: (d.shownImplicitLinks || []).filter(ilKey => !ilKeysToRemove.has(ilKey)),
          expandedRefModes:    (d.expandedRefModes    ?? []).filter(id => !cascaded.has(id)),
          expandedRefModeOccs: (() => { const s = new Set(newOccs.map(o => o.id)); return (d.expandedRefModeOccs ?? []).filter(id => s.has(id)) })(),
          subtypeOccurrences:  keptStIds,
          subtypeEndpointOccs: newSubtypeEndpointOccs2,
        }
      })
      const syncedDiagrams = syncConstraints(updatedDiagrams, s.constraints, s.subtypes, s.facts)
      return {
        diagrams: syncedDiagrams,
        multiSelectedIds: [],
        multiSelectedOccurrenceIds: [],
        selectedId: null, selectedKind: null, selectedOccurrenceId: null,
        selectedRole: null, selectedUniqueness: null,
        isDirty: true,
      }
    })
  },

  // Remove the current selection from the active diagram without touching the schema.
  // Handles single selection (all element kinds) and multi-selection.
  removeSelectedFromDiagram() {
    const { selectedId, selectedKind, selectedOccurrenceId,
            multiSelectedIds, activeDiagramId } = get()
    if (!activeDiagramId) return

    if (multiSelectedIds.length > 0) {
      get().removeMultiSelectionFromDiagram(activeDiagramId)
      return
    }

    if (!selectedId) return

    if (selectedKind === 'constraint') {
      if (selectedOccurrenceId)
        get().removeConstraintOccurrenceFromDiagram(selectedOccurrenceId, activeDiagramId)
      else
        get().removeElementFromDiagram(selectedId, activeDiagramId)
    } else if (selectedKind === 'subtype') {
      if (selectedOccurrenceId) {
        // occurrenceKey format: "${stId}:${subOccId}:${superOccId}"
        const [stId, rawSub, rawSuper] = selectedOccurrenceId.split(':')
        const subOccId   = rawSub   === 'null' ? null : rawSub
        const superOccId = rawSuper === 'null' ? null : rawSuper
        get().removeSubtypeOccurrenceFromDiagram(stId, subOccId, superOccId, activeDiagramId)
      } else {
        get().removeElementFromDiagram(selectedId, activeDiagramId)
      }
    } else if (selectedKind === 'entity' || selectedKind === 'value' || selectedKind === 'fact') {
      if (selectedOccurrenceId)
        get().removeOccurrenceFromDiagram(selectedOccurrenceId, activeDiagramId)
      else
        get().removeElementFromDiagram(selectedId, activeDiagramId)
    }
    // selectedRole / selectedUniqueness: no-op (sub-element selections, not whole occurrences)
  },

  getSharedIds() {
    const { diagrams } = get()
    const counts = {}
    diagrams.forEach(d => (d.occurrences ?? []).forEach(o => { counts[o.schemaElementId] = (counts[o.schemaElementId] || 0) + 1 }))
    return new Set(Object.keys(counts).filter(id => counts[id] > 1))
  },
}))
