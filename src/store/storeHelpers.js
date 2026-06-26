import { EXTERNAL_CONSTRAINT_TYPES } from '../constants.js'
export { findRefMode, vtNameFromLabel } from '../utils/refMode.js'
import { findRefMode } from '../utils/refMode.js'

// ── pan animation ─────────────────────────────────────────────────────────────
export let _panAnimId = null

// ── id generator ──────────────────────────────────────────────────────────────
let _n = 1
export const uid = () => `n${Date.now()}_${_n++}`

// ── default constructors ──────────────────────────────────────────────────────

export const mkEntity = (x, y) => ({
  id: uid(), kind: 'entity',
  name: 'Entity', x, y,
  isPersonal: false,  // describes persons → enables personal pronouns in verbalisation
  valueRangeOffset: null,
  datatypeAssignment: null,  // { profileId, datatypeId, params? } | null
})

export const mkValue = (x, y) => ({
  id: uid(), kind: 'value',
  name: 'Value', x, y,
  valueRangeOffset: null,
  datatypeAssignment: null,  // { profileId, datatypeId, params? } | null
})

export const mkRole = () => ({
  id: uid(), objectTypeId: null, roleName: '', mandatory: false,
  linkReadingParts: ['', '', ''],
  linkReadingReverseParts: null,
})

// Returns the smallest positive integer not already used in any fact reading.
export function nextRelationNumber(facts) {
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

export function defaultReadingParts(arity, n) {
  const parts = Array(arity + 1).fill('')
  parts[1] = arity === 2 ? `has relation${n} with` : `has relation${n}`
  return parts
}

export const mkFact = (x, y, arity = 2) => ({
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

export const mkImplicitLink = (roleIndex) => ({
  roleIndex, x: null, y: null,
  readingParts: ['', 'involves', ''],
  alternativeReadings: [{ roleOrder: [1, 0], parts: ['', 'is involved in', ''] }],
  readingDisplay: 'forward', orientation: 'horizontal',
  readingOffsetAbove: null, readingOffsetBelow: null, readingAbove: false,
  uniquenessBelow: false, preferredUniqueness: false, roleNames: [null, null],
})

export const mkSubtype = (subId, superId) => ({
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


export const mkConstraint = (type, x, y) => ({
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
export const mkOcc = (schemaElementId, x, y, extra = {}) =>
  ({ id: `occ_${uid()}`, schemaElementId, x: Math.round(x), y: Math.round(y), ...extra })

export const occOf    = (diag, elementId)        => diag.occurrences?.find(o => o.schemaElementId === elementId)
export const inDiag   = (diag, elementId)        => diag.occurrences?.some(o => o.schemaElementId === elementId) ?? false
export const patchOcc = (diag, elementId, patch) => ({
  ...diag,
  occurrences: (diag.occurrences ?? []).map(o =>
    o.schemaElementId === elementId ? { ...o, ...patch } : o
  ),
})
export const addOccIfAbsent = (diag, elementId, x, y, extra = {}) =>
  inDiag(diag, elementId) ? diag : { ...diag, occurrences: [...(diag.occurrences ?? []), mkOcc(elementId, x, y, extra)] }

// For each occurrence of `ownerId`, add owned VT/FT occurrences that are hidden until the
// owner is expanded. Each owner occurrence gets its own fresh VT occurrence (no sharing
// between ref modes by default). vtRoleIndex is used to wire roleOccurrenceMap on the FT
// occurrence so role connectors find the right VT occurrence when multiple VT occs exist.
export const addOwnedRefModeOccsIfAbsent = (diag, ownerId, vtId, vtX, vtY, ftId, ftX, ftY, vtRoleIndex = null) => {
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
export const rmOcc = (diag, elementId) => ({
  ...diag,
  occurrences: (diag.occurrences ?? []).filter(o => o.schemaElementId !== elementId),
})

// Patch occurrence by its own ID (not schema element ID) — needed for multi-occurrence drag
export const patchOccById = (diag, occId, patch) => ({
  ...diag,
  occurrences: (diag.occurrences ?? []).map(o => o.id === occId ? { ...o, ...patch } : o),
})

// Build an initial roleOccurrenceMap for a fact given the occurrences in a diagram.
// Maps role index (string) → occurrence ID of the first matching OT occurrence.
export const buildRoleOccurrenceMap = (fact, occurrences) => {
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
export const mkConstraintOcc = (schemaConstraintId, x, y) =>
  ({ id: `cocc_${uid()}`, schemaConstraintId, x: Math.round(x), y: Math.round(y), roleOccurrenceRefs: {}, queryOccurrenceRefs: {} })
export const cOccOf    = (diag, cId) => (diag.constraintOccurrences ?? []).find(co => co.schemaConstraintId === cId)
export const cInDiag   = (diag, cId) => (diag.constraintOccurrences ?? []).some(co => co.schemaConstraintId === cId)
export const patchCOcc = (diag, cId, patch) => ({
  ...diag,
  constraintOccurrences: (diag.constraintOccurrences ?? []).map(co =>
    co.schemaConstraintId === cId ? { ...co, ...patch } : co
  ),
})
export const patchCOccById = (diag, cOccId, patch) => ({
  ...diag,
  constraintOccurrences: (diag.constraintOccurrences ?? []).map(co =>
    co.id === cOccId ? { ...co, ...patch } : co
  ),
})
export const addCOccIfAbsent = (diag, cId, x, y) =>
  cInDiag(diag, cId) ? diag : { ...diag, constraintOccurrences: [...(diag.constraintOccurrences ?? []), mkConstraintOcc(cId, x, y)] }
export const rmCOcc = (diag, cId) => ({
  ...diag,
  constraintOccurrences: (diag.constraintOccurrences ?? []).filter(co => co.schemaConstraintId !== cId),
})

// Normalize subtypeEndpointOccs value to always be an array.
// Handles migration from the old single-object format { subOccId, superOccId }.
export const normalizeStEps = (raw) => {
  if (!raw) return []
  return Array.isArray(raw) ? raw : [raw]
}

// Returns a canonical fingerprint for a constraint occurrence's roleOccurrenceRefs,
// used to detect duplicate combinations when allowing multiple constraint occurrences.
export const roleOccRefsKey = (refs) => {
  const r = refs && !Array.isArray(refs) ? refs : {}
  return Object.entries(r).sort((a, b) => a[0].localeCompare(b[0])).map(([k, v]) => `${k}:${v}`).join('|')
}

export const mkDiagram = (name = 'Main') => ({ id: uid(), name, occurrences: [], constraintOccurrences: [], implicitLinkPositions: {}, multiSelectedIds: [], profileId: null, shownImplicitLinks: [], notes: [], expandedRefModes: [], expandedRefModeOccs: [], subtypeOccurrences: [], subtypeEndpointOccs: {} })
export const mkNote    = (x, y)          => ({ id: uid(), x: Math.round(x), y: Math.round(y), w: 160, h: 100, text: '', connectors: [] })

// ── name uniqueness ───────────────────────────────────────────────────────────
// Strip trailing digits → find smallest N ≥ 1 such that base+N ∉ usedNames.
export function makeUniqueName(originalName, usedNames) {
  const m = originalName.match(/^(.*?)(\d+)$/)
  const base = m ? m[1] : originalName
  let n = 1
  while (usedNames.has(`${base}${n}`)) n++
  return `${base}${n}`
}

// ── orphaned constraint purge ─────────────────────────────────────────────────
// After diagram-level removals, delete any constraints that are no longer present
// in any diagram (show-all diagrams always count as containing every constraint).
export function purgeOrphanedConstraints(diagrams, constraints) {
  if (!constraints.length) return constraints
  const inAnyDiagram = (id) => diagrams.some(d => cInDiag(d, id))
  const kept = constraints.filter(c => inAnyDiagram(c.id))
  return kept.length === constraints.length ? constraints : kept
}

// ── principle 3 closure ───────────────────────────────────────────────────────
// For every fact (or objectified fact) in the seed set, transitively add all
// role-player object types / objectified facts.  This ensures that any diagram
// (or clipboard) that contains a fact also contains all the OTs it references.
export function closeUnderPrinciple3(seedIds, { facts, objectTypes }) {
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
export function computeCascadeRemove(startId, facts) {
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
export function identifiedIdForInternalPI(fact, pu) {
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
export function demoteOtherPIsFor(identifiedId, facts, constraints, exceptFactId, exceptConstraintId) {
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
export function mkRefModePair(entity, vtName) {
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
export function findMatchingRefModeFact(entityId, vtId, facts) {
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
export function clearRefModePI(state, ownerId, current) {
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
export function applyFreshRefMode(state, owner, targetVtName, existing, matchFact, demoteTargetId) {
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
export function findUniqueLCA(otIds, subtypes) {
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
export function findPathDown(fromId, toId, subtypes) {
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
export function factTypeLabel(f, objectTypes) {
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

export function getConstraintDeps(c, facts, objectTypes) {
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
export function getConstraintQueryDeps(c, facts, objectTypes, subtypes) {
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
export function eligibleConstraints(constraints, subtypes, elementIdSet, facts, shownImplicitLinks) {
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
export function hasNoConnectors(c) {
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
export function syncConstraints(diagrams, constraints, subtypes, facts) {
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
export function computeConnectedIds(startId, { objectTypes, facts, subtypes, constraints }) {
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
export function migrateRefModeExpansion(diag, parsedOts, facts) {
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
export function migrateSubtypeOccurrences(diag, parsedSts) {
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
export function migrateOldDiagram(diag, parsedOts, facts, constraints, constraintIdSet) {
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
export const EMPTY = () => {
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
export function runFactMergePass(atoms, links, allFacts) {
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
