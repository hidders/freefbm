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
  preferredUniqueness: false,
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

// elementIds: null  = no filter, show all elements (default / first diagram)
// elementIds: []    = intentionally empty (new user-created diagram)
const mkDiagram = (name = 'Main') => ({ id: uid(), name, elementIds: null, positions: {}, multiSelectedIds: [], profileId: null, shownImplicitLinks: [], notes: [], expandedRefModes: [] })
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
  const inAnyDiagram = (id) => diagrams.some(d => d.elementIds === null || d.elementIds.includes(id))
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

// ── constraint auto-sync ──────────────────────────────────────────────────────
// Returns the set of constraint IDs that are eligible for a given elementId set.
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
function syncConstraints(diagrams, constraints, subtypes, facts) {
  return diagrams.map(d => {
    if (d.elementIds === null) return d   // show-all diagram: no sync needed

    const shownImplicitLinks = d.shownImplicitLinks || []
    const constraintIdSet = new Set(constraints.map(c => c.id))

    // Separate existing constraints into connectorless and connectorful
    const existingConstraintIds = d.elementIds.filter(id => constraintIdSet.has(id))
    const connectorlessExisting = existingConstraintIds.filter(id => {
      const c = constraints.find(cc => cc.id === id)
      return c && hasNoConnectors(c)
    })

    // Non-constraint IDs + existing connectorless constraints should always stay
    const nonConstraintIds = d.elementIds.filter(id => !constraintIdSet.has(id))
    const mustKeep = new Set([...nonConstraintIds, ...connectorlessExisting])
    const mustKeepSet = mustKeep

    // Compute eligible constraints (those with connectors whose deps are all present)
    const eligible = eligibleConstraints(constraints, subtypes, mustKeepSet, facts, shownImplicitLinks)

    const newElementIds = [
      ...mustKeep,
      ...eligible.map(c => c.id),
    ]

    // Avoid unnecessary object allocation if nothing changed
    const oldSet = new Set(d.elementIds)
    const unchanged = newElementIds.length === d.elementIds.length &&
      newElementIds.every(id => oldSet.has(id))
    if (unchanged) return d

    const newPositions = { ...d.positions }
    for (const c of eligible) {
      if (!newPositions[c.id]) newPositions[c.id] = { x: c.x, y: c.y }
    }
    return { ...d, elementIds: newElementIds, positions: newPositions }
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

// ── query helper: merge fact/nested-OT copies with identical role→OT connectivity ──
function runFactMergePass(copies, links, allFacts) {
  const getArity = (factId) => {
    if (factId.includes('_il_')) return 2
    const f = allFacts.find(f => f.id === factId)
    return f?.arity ?? f?.roles?.length ?? 0
  }
  const isObjectifiedId = (id) => allFacts.some(f => f.id === id && f.objectified)
  let mCopies = copies, mLinks = links, again = true
  while (again) {
    again = false
    const factCopies = mCopies.filter(c => c.kind === 'fact' || (c.kind === 'objectType' && isObjectifiedId(c.originalId)))
    const byOrig = {}
    for (const c of factCopies) { if (!byOrig[c.originalId]) byOrig[c.originalId] = []; byOrig[c.originalId].push(c) }
    for (const group of Object.values(byOrig)) {
      if (group.length < 2) continue
      const arity = getArity(group[0].originalId)
      if (!arity) continue
      const allRoles = Array.from({ length: arity }, (_, k) => k)
      let found = false
      for (let i = 0; i < group.length && !found; i++) {
        const m1 = {}; for (const l of mLinks) if (l.copyId === group[i].id) m1[l.roleIndex] = l.variableId
        if (!allRoles.every(r => m1[r] != null)) continue
        for (let j = i + 1; j < group.length && !found; j++) {
          const m2 = {}; for (const l of mLinks) if (l.copyId === group[j].id) m2[l.roleIndex] = l.variableId
          if (!allRoles.every(r => m2[r] != null)) continue
          if (!allRoles.every(r => m1[r] === m2[r])) continue
          const merged = { ...group[i], seededRoles: [...new Set([...(group[i].seededRoles ?? []), ...(group[j].seededRoles ?? [])])] }
          mCopies = mCopies.filter(c => c.id !== group[j].id).map(c => c.id === group[i].id ? merged : c)
          mLinks  = mLinks
            .filter(l => l.copyId !== group[j].id)
            .map(l => l.variableId === group[j].id ? { ...l, variableId: group[i].id } : l)
          found = again = true
        }
      }
      if (again) break
    }
  }
  return { copies: mCopies, links: mLinks }
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
  uniquenessConstruction:  null,   // { factId, roleIndices: number[] } | null
  frequencyConstruction:   null,   // { stage:2|3, factId, x, y, roleIndices:number[], ifId?:string, range?:[] } | null
  sequenceConstruction:    null,   // { constraintId, steps: [{sequenceIndex}][], collected: [{sequenceIndex, member}][] } | null
  constraintHighlight:     null,   // { constraintId, sequenceIndex: number|null, positionIndex: number|null } | null
  queryIndexHighlight:     null,   // { constraintId, queryIndex: number } | null
  queryEditDraft:          null,   // { constraintId, sequenceIndex, copies:[{id,kind,originalId,isOutput}], links:[{copyId,roleIndex,variableId}], pendingClick } | null
  pendingTargetPick:       null,   // { constraintId } | null  — set while the user is clicking a target OT in the diagram

  tool:      'select',
  linkDraft: null,
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
    const sourcePos = activeDiagram?.positions ?? {}
    const clipPositions = {}
    for (const el of [...copiedOts, ...copiedFacts, ...copiedCons]) {
      const p = sourcePos[el.id]
      clipPositions[el.id] = p ? { x: p.x, y: p.y } : { x: el.x, y: el.y }
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
    const existingIds = new Set(
      activeDiagram?.elementIds === null
        ? [...objectTypes.map(o => o.id), ...facts.map(f => f.id), ...constraints.map(c => c.id)]
        : (activeDiagram?.elementIds ?? [])
    )

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
    if (activeDiagram?.elementIds !== null && positioned.length > 0) {
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

        const elementIds = d.elementIds === null ? null : [...d.elementIds, ...addIds]
        const positions = {
          ...d.positions,
          ...Object.fromEntries(toAdd.map(el => {
            const cp = getClipPos(el)
            return [el.id, d.positions[el.id] ?? { x: cp.x + ox, y: cp.y + oy }]
          })),
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
          ...d,
          elementIds,
          positions,
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
      diagrams: s.diagrams.map(d => d.id !== activeDiagramId ? d : {
        ...d,
        elementIds: d.elementIds === null ? null : [...d.elementIds, ...newOts.map(o => o.id), ...newFacts.map(f => f.id), ...newCons.map(c => c.id)],
        positions: {
          ...d.positions,
          ...Object.fromEntries(newOts.map(o  => [o.id, { x: o.x, y: o.y }])),
          ...Object.fromEntries(newFacts.map(f => [f.id, { x: f.x, y: f.y }])),
          ...Object.fromEntries(newCons.map(c  => [c.id, { x: c.x, y: c.y }])),
        },
        shownImplicitLinks: newShownILKeys.length > 0
          ? [...new Set([...(d.shownImplicitLinks ?? []), ...newShownILKeys])]
          : (d.shownImplicitLinks ?? []),
        expandedRefModes: dupExpandedRefs.size > 0
          ? [...new Set([...(d.expandedRefModes ?? []), ...dupExpandedRefs])]
          : (d.expandedRefModes ?? []),
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
          selectedUniqueness: null, multiSelectedIds: [],
          uniquenessConstruction: null, frequencyConstruction: null,
          pan: { x: 0, y: 0 }, zoom: 1 })
  },

   loadModel(data, filePath = null) {
    const d = typeof data === 'string' ? JSON.parse(data) : data
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
      // Discard old-format queries (patternRoles/patternSubtypes) — replaced by copy-graph format
      if (out.queries && out.queries.some(q => q && q.patternRoles)) {
        out = { ...out, queries: out.queries.map(q => (q && q.patternRoles) ? null : q) }
      }
      return out
    })
    const parsedOts  = d.objectTypes  || []
    const parsedSts  = d.subtypes      || []

    let diagrams, activeDiagramId
    if (d.diagrams && d.diagrams.length > 0) {
      // Always start with empty selection; strip any persisted selection state
      diagrams        = d.diagrams.map(diag => ({
        ...diag,
        multiSelectedIds: [],
        expandedRefModes: diag.expandedRefModes ?? [],
      }))
      activeDiagramId = d.activeDiagramId ?? d.diagrams[0].id
    } else {
      // Migrate: put all existing elements into a single default diagram
      const positions = {}
      parsedOts.forEach(o  => { positions[o.id]  = { x: o.x,  y: o.y  } })
      facts.forEach(f      => { positions[f.id]  = { x: f.x,  y: f.y  } })
      constraints.forEach(c => { positions[c.id] = { x: c.x,  y: c.y  } })
      const allIds = [...parsedOts.map(o => o.id), ...facts.map(f => f.id), ...constraints.map(c => c.id)]
      const diag   = { id: uid(), name: 'Main', elementIds: allIds, positions, multiSelectedIds: [], expandedRefModes: [] }
      diagrams        = [diag]
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
      filePath, isDirty: false, selectedId: null, selectedKind: null,
    })
  },

  serialize() {
    const { objectTypes, facts, subtypes, constraints, diagrams, activeDiagramId, populations, factPopulations, subtypeMappings, nestedEntityMappings, pan, zoom } = get()
    // Strip in-memory-only selection state; flush current pan/zoom into active diagram
    const cleanDiagrams = diagrams.map(({ multiSelectedIds: _, ...d }) =>
      d.id === activeDiagramId ? { ...d, pan, zoom } : d
    )
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
      objectTypes, facts, subtypes, constraints,
      diagrams: cleanDiagrams, activeDiagramId,
      populations:         populations    ?? {},
      factPopulations:     cleanFactPops,
      subtypeMappings:     cleanStMaps,
      nestedEntityMappings: cleanNem,
    }, null, 2)
  },

  setFilePath(p) { set({ filePath: p }) },
  markClean()    { set({ isDirty: false }) },

  // ── object types ────────────────────────────────────────────────────────

  addEntity(x, y) {
    const base = mkEntity(Math.round(x), Math.round(y))
    set(s => {
      const used = new Set(
        s.objectTypes.map(o => o.name).concat(s.facts.map(f => f.objectifiedName).filter(Boolean))
      )
      let n = 1
      while (used.has(`Entity${n}`)) n++
      const e = { ...base, name: `Entity${n}` }
      return {
      objectTypes: [...s.objectTypes, e],
      diagrams: s.diagrams.map(d => d.id !== s.activeDiagramId ? d : {
        ...d,
        elementIds: d.elementIds === null ? null : [...d.elementIds, e.id],
        positions:  { ...d.positions, [e.id]: { x: e.x, y: e.y } },
      }),
      isDirty: true, selectedId: e.id, selectedKind: 'entity',
    }})
    return base.id
  },

  addValue(x, y) {
    const base = mkValue(Math.round(x), Math.round(y))
    set(s => {
      const used = new Set(
        s.objectTypes.map(o => o.name).concat(s.facts.map(f => f.objectifiedName).filter(Boolean))
      )
      let n = 1
      while (used.has(`Value${n}`)) n++
      const v = { ...base, name: `Value${n}` }
      return {
        objectTypes: [...s.objectTypes, v],
        diagrams: s.diagrams.map(d => d.id !== s.activeDiagramId ? d : {
          ...d,
          elementIds: d.elementIds === null ? null : [...d.elementIds, v.id],
          positions:  { ...d.positions, [v.id]: { x: v.x, y: v.y } },
        }),
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
      set(state => ({
        facts: state.facts.map(f => f.id !== current.factId ? f : ({
          ...f,
          preferredUniqueness: (f.preferredUniqueness || [])
            .filter(pu => !(pu.length === 1 && pu[0] === current.vtRoleIndex)),
        })),
        // Keep the now-orphan fact/VT visible by expanding them in the active diagram.
        diagrams: state.diagrams.map(d => d.id !== state.activeDiagramId ? d : ({
          ...d,
          expandedRefModes: (d.expandedRefModes ?? []).includes(entityId)
            ? d.expandedRefModes
            : [...(d.expandedRefModes ?? []), entityId],
          elementIds: d.elementIds === null ? null : (
            [current.vtId, current.factId].reduce(
              (ids, eid) => ids.includes(eid) ? ids : [...ids, eid],
              d.elementIds,
            )
          ),
        })),
        isDirty: true,
      }))
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
          let nextOts = state.objectTypes
          let nextDiagrams = state.diagrams
          if (!oldVtUsedElsewhere) {
            nextOts = nextOts.filter(o => o.id !== current.vtId)
            nextDiagrams = nextDiagrams.map(d => ({
              ...d,
              elementIds: d.elementIds === null ? null : d.elementIds.filter(eid => eid !== current.vtId),
              positions: Object.fromEntries(Object.entries(d.positions).filter(([k]) => k !== current.vtId)),
            }))
          }
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

    // No ref mode yet: create or attach to an existing VT, then create (or reuse) the fact.
    const existing = s.objectTypes.find(o => o.kind === 'value' && o.name === targetVtName)
    // If the target VT already exists, look for a fact with the same reading rather than creating a duplicate.
    const matchFact = existing ? findMatchingRefModeFact(entity.id, existing.id, s.facts) : null
    set(state => {
      if (matchFact) {
        // Reuse the existing fact: ensure preferredUniqueness is set on the VT role.
        const factsWithPi = state.facts.map(f => {
          if (f.id !== matchFact.fact.id) return f
          const alreadySet = (f.preferredUniqueness || []).some(
            pu => pu.length === 1 && pu[0] === matchFact.vtRoleIndex
          )
          if (alreadySet) return f
          return { ...f, preferredUniqueness: [...(f.preferredUniqueness || []), [matchFact.vtRoleIndex]] }
        })
        const { facts: cFacts, constraints: cCons } =
          demoteOtherPIsFor(entity.id, factsWithPi, state.constraints, matchFact.fact.id, null)
        return {
          facts: cFacts,
          constraints: cCons,
          diagrams: state.diagrams.map(d => d.id !== state.activeDiagramId ? d : ({
            ...d,
            elementIds: d.elementIds === null ? null : [
              ...d.elementIds,
              ...[matchFact.fact.id, existing.id].filter(id => !d.elementIds.includes(id)),
            ],
          })),
          isDirty: true,
        }
      }
      let nextOts = state.objectTypes
      let vt
      if (existing) {
        vt = existing
      } else {
        const { vt: newVt } = mkRefModePair(entity, targetVtName)
        vt = newVt
        nextOts = [...nextOts, newVt]
      }
      // Build the fact (always new — even when reusing an existing VT, the relationship is per-entity)
      const ft = {
        ...mkFact(Math.round(entity.x + 80), Math.round(entity.y), 2),
        roles: [{ ...mkRole(), objectTypeId: entity.id }, { ...mkRole(), objectTypeId: vt.id }],
        uniqueness: [[1]],
        preferredUniqueness: [[1]],
        readingParts: ['', 'has', ''],
        alternativeReadings: [{ roleOrder: [1, 0], parts: ['', 'refers to', ''] }],
      }
      const newIds = existing ? [ft.id] : [vt.id, ft.id]
      const factsAfterAdd = [...state.facts, ft]
      // The new fact's PI identifies `entity` — demote any pre-existing PIs for it.
      const { facts: cFacts, constraints: cCons } =
        demoteOtherPIsFor(entity.id, factsAfterAdd, state.constraints, ft.id, null)
      return {
        objectTypes: nextOts,
        facts: cFacts,
        constraints: cCons,
        diagrams: state.diagrams.map(d => d.id !== state.activeDiagramId ? d : ({
          ...d,
          elementIds: d.elementIds === null ? null : [...d.elementIds, ...newIds.filter(nid => !d.elementIds.includes(nid))],
          positions: {
            ...d.positions,
            ...(existing ? {} : { [vt.id]: { x: vt.x, y: vt.y } }),
            [ft.id]: { x: ft.x, y: ft.y },
          },
        })),
        isDirty: true,
      }
    })
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
      set(trimmed ? 'nothing' : null) // no-op placeholder
      setDisplay(null)
      if (!current) return
      // Remove PI from the existing ref-mode fact, keep FT+VT visible.
      set(state => ({
        facts: state.facts.map(f => f.id !== current.factId ? f : ({
          ...f,
          preferredUniqueness: (f.preferredUniqueness || []).filter(pu => !(pu.length === 1 && pu[0] === current.vtRoleIndex)),
        })),
        diagrams: state.diagrams.map(d => d.id !== state.activeDiagramId ? d : ({
          ...d,
          expandedRefModes: (d.expandedRefModes ?? []).includes(factId)
            ? d.expandedRefModes
            : [...(d.expandedRefModes ?? []), factId],
          elementIds: d.elementIds === null ? null : (
            [current.vtId, current.factId].reduce((ids, eid) => ids.includes(eid) ? ids : [...ids, eid], d.elementIds)
          ),
        })),
        isDirty: true,
      }))
      return
    }

    setDisplay(trimmed)
    const entityName = fact.objectifiedName || 'Entity'
    const targetVtName = vtNameFromLabel(entityName, trimmed)
    const current = findRefMode(fact, s.facts, s.objectTypes)

    if (current) {
      // Rename existing VT to match new label.
      set(state => ({
        objectTypes: state.objectTypes.map(o => o.id === current.vtId ? { ...o, name: targetVtName } : o),
        isDirty: true,
      }))
      return
    }

    // No ref mode yet: create VT + binary fact + set PI (or reuse an existing matching fact).
    const existing = s.objectTypes.find(o => o.kind === 'value' && o.name === targetVtName)
    const wrapEntity = { id: factId, name: entityName, x: fact.x, y: fact.y }
    const matchFact = existing ? findMatchingRefModeFact(factId, existing.id, s.facts) : null
    set(state => {
      if (matchFact) {
        const factsWithPi = state.facts.map(f => {
          if (f.id !== matchFact.fact.id) return f
          const alreadySet = (f.preferredUniqueness || []).some(
            pu => pu.length === 1 && pu[0] === matchFact.vtRoleIndex
          )
          if (alreadySet) return f
          return { ...f, preferredUniqueness: [...(f.preferredUniqueness || []), [matchFact.vtRoleIndex]] }
        })
        return {
          facts: factsWithPi,
          diagrams: state.diagrams.map(d => d.id !== state.activeDiagramId ? d : ({
            ...d,
            elementIds: d.elementIds === null ? null : [
              ...d.elementIds,
              ...[matchFact.fact.id, existing.id].filter(id => !d.elementIds.includes(id)),
            ],
          })),
          isDirty: true,
        }
      }
      let nextOts = state.objectTypes
      let vt
      if (existing) {
        vt = existing
      } else {
        const pair = mkRefModePair(wrapEntity, targetVtName)
        vt = pair.vt
        nextOts = [...nextOts, pair.vt]
      }
      const ft = {
        ...mkFact(Math.round(wrapEntity.x + 80), Math.round(wrapEntity.y), 2),
        roles: [{ ...mkRole(), objectTypeId: wrapEntity.id }, { ...mkRole(), objectTypeId: vt.id }],
        uniqueness: [[1]],
        preferredUniqueness: [[1]],
        readingParts: ['', 'has', ''],
        alternativeReadings: [{ roleOrder: [1, 0], parts: ['', 'refers to', ''] }],
      }
      const newIds = existing ? [ft.id] : [vt.id, ft.id]
      return {
        objectTypes: nextOts,
        facts: [...state.facts, ft],
        diagrams: state.diagrams.map(d => d.id !== state.activeDiagramId ? d : ({
          ...d,
          elementIds: d.elementIds === null ? null : [...d.elementIds, ...newIds.filter(nid => !d.elementIds.includes(nid))],
          positions: {
            ...d.positions,
            ...(existing ? {} : { [vt.id]: { x: vt.x, y: vt.y } }),
            [ft.id]: { x: ft.x, y: ft.y },
          },
        })),
        isDirty: true,
      }
    })
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
      diagrams: s.diagrams.map(d => d.id !== s.activeDiagramId ? d : {
        ...d,
        positions: { ...d.positions, [id]: { x, y } },
      }),
      isDirty: true,
    }))
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
      diagrams: s.diagrams.map(d => ({
        ...d,
        elementIds: d.elementIds === null ? null : d.elementIds.filter(eid => eid !== id),
        positions:  Object.fromEntries(Object.entries(d.positions).filter(([k]) => {
          if (k === id) return false
          if (k.startsWith(`${id}:il:`)) return false
          return true
        })),
      })),
        selectedId: s.selectedId === id ? null : s.selectedId,
        isDirty: true,
      }
    })
  },

  // Per-diagram display toggle: show the ref mode's VT + FT as ordinary diagram
  // elements (instead of as shorthand inside the entity rect). The VT and FT
  // already exist as schema elements; this just adds them to elementIds and
  // marks the entity expanded in the target diagram.
  expandRefMode(otId, diagramId = null) {
    const { objectTypes, facts, activeDiagramId } = get()
    const ot = objectTypes.find(o => o.id === otId)
    const nested = !ot ? facts.find(f => f.id === otId && f.objectified && f.objectifiedKind !== 'value') : null
    const owner = ot ?? nested
    if (!owner) return
    if (ot && ot.kind !== 'entity') return
    const rm = findRefMode(owner, facts, objectTypes)
    if (!rm) return
    const targetDiagramId = diagramId ?? activeDiagramId
    set(s => ({
      diagrams: s.diagrams.map(d => {
        if (d.id !== targetDiagramId) return d
        if ((d.expandedRefModes ?? []).includes(otId)) return d
        const elementIds = d.elementIds === null ? null : [
          ...d.elementIds,
          ...([rm.vtId, rm.factId].filter(eid => !d.elementIds.includes(eid))),
        ]
        return { ...d, elementIds, expandedRefModes: [...(d.expandedRefModes ?? []), otId] }
      }),
      isDirty: true,
    }))
  },

  collapseRefMode(otId, diagramId = null) {
    const { activeDiagramId } = get()
    const targetDiagramId = diagramId ?? activeDiagramId
    set(s => ({
      diagrams: s.diagrams.map(d => {
        if (d.id !== targetDiagramId) return d
        return { ...d, expandedRefModes: (d.expandedRefModes ?? []).filter(id => id !== otId) }
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
      diagrams: s.diagrams.map(d => d.id !== s.activeDiagramId ? d : {
        ...d,
        elementIds: d.elementIds === null ? null : [...d.elementIds, f.id],
        positions:  { ...d.positions, [f.id]: { x: f.x, y: f.y } },
      }),
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
        diagrams: s.diagrams.map(d => d.id !== s.activeDiagramId ? d : {
          ...d,
          elementIds: d.elementIds === null ? null : [...d.elementIds, f.id],
          positions:  { ...d.positions, [f.id]: { x: f.x, y: f.y } },
        }),
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
      const oldPos = diag?.positions?.[id]
      const fact   = s.facts.find(f => f.id === id)
      const oldX   = oldPos?.x ?? fact?.x ?? 0
      const oldY   = oldPos?.y ?? fact?.y ?? 0
      const dx = x - oldX
      const dy = y - oldY
      return {
        diagrams: s.diagrams.map(d => d.id !== s.activeDiagramId ? d : {
          ...d,
          positions: { ...d.positions, [id]: { ...(d.positions[id] ?? {}), x, y } },
        }),
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
  // uniquenessBelow, nestedReading). Stored in diagram.positions alongside x,y.
  updateFactLayout(id, patch) {
    set(s => ({
      diagrams: s.diagrams.map(d => d.id !== s.activeDiagramId ? d : {
        ...d,
        positions: {
          ...d.positions,
          [id]: { ...(d.positions[id] ?? {}), ...patch },
        },
      }),
      isDirty: true,
    }))
  },

  // Store role-name label offset per diagram (in positions[factId].roleNameOffsets[roleIndex]).
  updateRoleNameOffset(factId, roleIndex, offset) {
    set(s => ({
      diagrams: s.diagrams.map(d => d.id !== s.activeDiagramId ? d : {
        ...d,
        positions: {
          ...d.positions,
          [factId]: {
            ...(d.positions[factId] ?? {}),
            roleNameOffsets: {
              ...((d.positions[factId] ?? {}).roleNameOffsets ?? {}),
              [roleIndex]: offset,
            },
          },
        },
      }),
      isDirty: true,
    }))
  },

  // Store value-range label offset per diagram (in positions[factId].valueRangeOffsets[roleIndex]).
  updateValueRangeOffset(factId, roleIndex, offset) {
    set(s => ({
      diagrams: s.diagrams.map(d => d.id !== s.activeDiagramId ? d : {
        ...d,
        positions: {
          ...d.positions,
          [factId]: {
            ...(d.positions[factId] ?? {}),
            valueRangeOffsets: {
              ...((d.positions[factId] ?? {}).valueRangeOffsets ?? {}),
              [roleIndex]: offset,
            },
          },
        },
      }),
      isDirty: true,
    }))
  },

  updateCardinalityRangeOffset(factId, roleIndex, offset) {
    set(s => ({
      diagrams: s.diagrams.map(d => d.id !== s.activeDiagramId ? d : {
        ...d,
        positions: {
          ...d.positions,
          [factId]: {
            ...(d.positions[factId] ?? {}),
            cardinalityRangeOffsets: {
              ...((d.positions[factId] ?? {}).cardinalityRangeOffsets ?? {}),
              [roleIndex]: offset,
            },
          },
        },
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
        const positions = { ...d.positions }
        const ilKeys = Object.keys(positions).filter(k => k.startsWith(`${factId}:il:`))
        for (const k of ilKeys) {
          const ri = Number(k.split(':')[2])
          const newRi = oldToNew[ri]
          if (newRi !== undefined && newRi !== ri) {
            positions[`${factId}:il:${newRi}`] = positions[k]
            delete positions[k]
            // Remap implied frequency positions
            for (const fk of ilKeys.filter(x => x.startsWith(`${factId}:il:${ri}:if:`))) {
              const newFk = fk.replace(`${factId}:il:${ri}:if:`, `${factId}:il:${newRi}:if:`)
              positions[newFk] = positions[fk]
              delete positions[fk]
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
        return { ...d, positions, shownImplicitLinks: remappedShown }
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
      const pos = diag?.positions?.[factId]
      const currentRoleOrder = pos?.roleOrder || [0, 1]
      const newRoleOrder = currentRoleOrder[0] === 0 && currentRoleOrder[1] === 1 ? [1, 0] : [0, 1]
      return {
        diagrams: s.diagrams.map(d => d.id !== s.activeDiagramId ? d : {
          ...d,
          positions: {
            ...d.positions,
            [factId]: { ...(d.positions[factId] ?? {}), roleOrder: newRoleOrder },
          },
        }),
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
          const positions = { ...d.positions }
          const ilKeys = Object.keys(positions).filter(k => k.startsWith(`${factId}:il:`)).sort((a, b) => Number(b.split(':')[2]) - Number(a.split(':')[2]))
          for (const k of ilKeys) {
            const ri = Number(k.split(':')[2])
            if (ri >= atIndex) {
              positions[`${factId}:il:${ri + 1}`] = positions[k]
              delete positions[k]
              // Remap implied frequency positions
              for (const fk of Object.keys(positions).filter(x => x.startsWith(`${factId}:il:${ri}:if:`))) {
                positions[fk.replace(`${factId}:il:${ri}:if:`, `${factId}:il:${ri + 1}:if:`)] = positions[fk]
                delete positions[fk]
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
          return { ...d, positions, shownImplicitLinks: remappedShown }
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
          const positions = { ...d.positions }
          const ilKey = `${factId}:il:${roleIndex}`
          // Remove the deleted implicit link's position and its implied frequency positions
          delete positions[ilKey]
          for (const k of Object.keys(positions)) {
            if (k.startsWith(`${ilKey}:if:`)) delete positions[k]
          }
          for (const [k, v] of Object.entries(positions)) {
            if (k.startsWith(`${factId}:il:`)) {
              const parts = k.split(':')
              const ri = Number(parts[2])
              if (ri > roleIndex) {
                const newKey = `${factId}:il:${ri - 1}`
                positions[newKey] = v
                delete positions[k]
                // Remap implied frequency positions too
                for (const fk of Object.keys(positions)) {
                  if (fk.startsWith(`${factId}:il:${ri}:if:`)) {
                    const newFk = fk.replace(`${factId}:il:${ri}:if:`, `${factId}:il:${ri - 1}:if:`)
                    positions[newFk] = positions[fk]
                    delete positions[fk]
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
          return { ...d, positions, shownImplicitLinks: remappedShown }
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

      // Principle 3: add objectTypeId to every diagram that already contains factId
      const ot = s.objectTypes.find(o => o.id === objectTypeId) ?? s.facts.find(f => f.id === objectTypeId)
      const otPos = ot ? { x: ot.x, y: ot.y } : { x: 100, y: 100 }

      const updatedDiagrams = s.diagrams.map(d => {
        const factInDiagram = d.elementIds === null || d.elementIds.includes(factId)
        if (!factInDiagram) return d
        // show-all diagram already shows everything; no entry needed
        if (d.elementIds === null) return d
        if (d.elementIds.includes(objectTypeId)) return d
        return {
          ...d,
          elementIds: [...d.elementIds, objectTypeId],
          positions: { ...d.positions, [objectTypeId]: d.positions[objectTypeId] ?? otPos },
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
        const positions = { ...(diag?.positions || {}) }
        positions[key] = { ...(positions[key] || {}), ...positionPatch }
        changes.diagrams = s.diagrams.map(d =>
          d.id === s.activeDiagramId ? { ...d, positions } : d
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
      const positions = { ...(diag?.positions || {}) }
      positions[key] = { ...(positions[key] || {}), ...patch }
      return {
        diagrams: s.diagrams.map(d => d.id === s.activeDiagramId ? { ...d, positions } : d),
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
      diagrams: s.diagrams.map(d => ({
        ...d,
        elementIds: d.elementIds === null ? null : d.elementIds.filter(eid => eid !== id),
        positions:  Object.fromEntries(Object.entries(d.positions).filter(([k]) => k !== id)),
      })),
      selectedId: s.selectedId === id ? null : s.selectedId,
      isDirty: true,
      }
    })
  },

  // ── subtypes ────────────────────────────────────────────────────────────

  addSubtype(subId, superId) {
    const s0 = get()
    const exists = s0.subtypes.some(s => s.subId === subId && s.superId === superId)
    if (exists || subId === superId) return
    // Entity/value kinds are disjoint — reject mixed-kind subtype edges
    const subKind   = subtypeKindOf(subId,   s0.objectTypes, s0.facts)
    const superKind = subtypeKindOf(superId, s0.objectTypes, s0.facts)
    if (subKind && superKind && subKind !== superKind) return
    const st = mkSubtype(subId, superId)
    set(s => ({ subtypes: [...s.subtypes, st], isDirty: true,
                selectedId: st.id, selectedKind: 'subtype' }))
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
        let sequences = (c.sequences || []).map(g => [...g])
        for (const { sequenceIndex, member } of collected) {
          if (sequenceIndex >= sequences.length) {
            while (sequences.length < sequenceIndex) sequences.push([])
            sequences.push([member])
          } else {
            sequences[sequenceIndex] = [...sequences[sequenceIndex], member]
          }
        }
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
      const commitQuery = (copies, links, lcaId) => {
        set(s => ({
          constraints: s.constraints.map(con => {
            if (con.id !== constraintId) return con
            const queries = [...(con.queries || [])]
            while (queries.length < 1) queries.push(null)
            queries[0] = { copies, links }
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

      // Build tree: root OT copy for LCA; per branch a path of subtype edge copies
      // from the LCA down to the other-role OT, then the fact copy.
      const rootCopyId = uid()
      const copies = [
        { id: rootCopyId, kind: 'objectType', originalId: lcaId,
          isOutput: hasTargetOt, dx: 16, dy: 16 },
      ]
      const links = []

      for (let i = 0; i < roleMembers.length; i++) {
        const m = roleMembers[i]
        const P = otherOtIds[i]
        const path = findPathDown(lcaId, P, subtypes)
        if (path === null) return  // LCA not actually an ancestor — schema inconsistency

        let prevOtCopyId = rootCopyId
        for (const step of path) {
          const childOtCopyId = uid()
          const stCopyId = uid()
          copies.push({ id: childOtCopyId, kind: 'objectType', originalId: step.toId,
            isOutput: false, dx: (i + 2) * 16, dy: (i + 2) * 16 })
          copies.push({ id: stCopyId, kind: 'subtype', originalId: step.subtypeId,
            isOutput: false, dx: (i + 2) * 16, dy: (i + 2) * 16 })
          links.push({ copyId: stCopyId, roleIndex: 1, variableId: prevOtCopyId })  // supertype end
          links.push({ copyId: stCopyId, roleIndex: 0, variableId: childOtCopyId }) // subtype end
          prevOtCopyId = childOtCopyId
        }

        const factCopyId = uid()
        copies.push({ id: factCopyId, kind: 'fact', originalId: m.factId,
          isOutput: false, seededRoles: [{ roleIndex: m.roleIndex, seqPosition: i }],
          dx: (i + 3) * 16, dy: (i + 3) * 16 })
        links.push({ copyId: factCopyId, roleIndex: 1 - m.roleIndex, variableId: prevOtCopyId })
      }

      commitQuery(copies, links, lcaId)
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
          // LCA becomes the target OT; queries no longer contain a copy for it.
          applyQueries(lcaId, i => {
            const mem = members[i]
            if (mem.kind === 'subtype') {
              const subOtCopyId = uid(), stCopyId = uid()
              return {
                copies: [
                  { id: subOtCopyId, kind: 'objectType', originalId: mem.st.subId,
                    isOutput: false, dx: 16, dy: 16 },
                  { id: stCopyId, kind: 'subtype', originalId: mem.st.id,
                    isOutput: true, isSeeded: true, dx: 24, dy: 24 },
                ],
                links: [
                  { copyId: stCopyId, roleIndex: 0, variableId: subOtCopyId },
                ],
              }
            } else {
              const factCopyId = uid()
              return {
                copies: [
                  { id: factCopyId, kind: 'fact', originalId: mem.m.factId,
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
            const subOtCopyId = uid(), supOtCopyId = uid(), stCopyId = uid()
            existingQueries[i] = {
              copies: [
                { id: subOtCopyId, kind: 'objectType', originalId: st.subId,
                  isOutput: false, dx: 16, dy: 16 },
                { id: supOtCopyId, kind: 'objectType', originalId: st.superId,
                  isOutput: false, dx: 32, dy: 32 },
                { id: stCopyId, kind: 'subtype', originalId: st.id,
                  isSeeded: true, dx: 24, dy: 24 },
              ],
              links: [
                { copyId: stCopyId, roleIndex: 0, variableId: subOtCopyId },
                { copyId: stCopyId, roleIndex: 1, variableId: supOtCopyId },
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
                const rootCopyId = uid()
                // exclusion / equality / subset never designate a target OT — root copy is a plain join variable.
                const copies = [{ id: rootCopyId, kind: 'objectType', originalId: lcaId,
                  isOutput: false, dx: 16, dy: 16 }]
                const links = []
                roleMembers.forEach((m, j) => {
                  let prevOtCopyId = rootCopyId
                  for (const step of paths[j]) {
                    const childOtCopyId = uid(), pathStCopyId = uid()
                    copies.push({ id: childOtCopyId, kind: 'objectType', originalId: step.toId,
                      isOutput: false, dx: (j + 2) * 16, dy: (j + 2) * 16 })
                    copies.push({ id: pathStCopyId, kind: 'subtype', originalId: step.subtypeId,
                      isOutput: false, dx: (j + 2) * 16, dy: (j + 2) * 16 })
                    links.push({ copyId: pathStCopyId, roleIndex: 1, variableId: prevOtCopyId })
                    links.push({ copyId: pathStCopyId, roleIndex: 0, variableId: childOtCopyId })
                    prevOtCopyId = childOtCopyId
                  }
                  const factCopyId = uid()
                  copies.push({ id: factCopyId, kind: 'fact', originalId: m.factId,
                    isOutput: false, seededRoles: [{ roleIndex: m.roleIndex, seqPosition: m.seqPos }],
                    dx: (j + 3) * 16, dy: (j + 3) * 16 })
                  links.push({ copyId: factCopyId, roleIndex: 1 - m.roleIndex, variableId: prevOtCopyId })
                })
                existingQueries[i] = { copies, links }
                changed = true
                continue
              }
            }
          }
        }

        // Rule 2: all roles in the same fact type → single fact copy with all roles marked
        const factIds = new Set(roleMembers.map(m => m.factId))
        if (factIds.size === 1) {
          const factCopyId = uid()
          existingQueries[i] = {
            copies: [{ id: factCopyId, kind: 'fact', originalId: [...factIds][0],
              isOutput: false, seededRoles: roleMembers.map(m => ({ roleIndex: m.roleIndex, seqPosition: m.seqPos })),
              dx: 16, dy: 16 }],
            links: [],
          }
          changed = true
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
    const { copies, links } = qd
    if (copies.length === 0) return { valid: false, reason: 'Pattern is empty' }
    // Union-find on copies — edges are links between fact/subtype copies and OT copies
    const parent = {}
    const find = id => { if (parent[id] === undefined) parent[id] = id; return parent[id] === id ? id : (parent[id] = find(parent[id])) }
    const union = (a, b) => { parent[find(a)] = find(b) }
    for (const lk of links) union(lk.copyId, lk.variableId)
    const roots = new Set(copies.map(c => find(c.id)))
    if (roots.size > 1) return { valid: false, reason: 'Pattern is not connected' }
    return { valid: true, reason: null }
  },

  startQueryEdit(constraintId, sequenceIndex) {
    const c = get().constraints.find(c => c.id === constraintId)
    if (!c) return
    const existing = (c.queries || [])[sequenceIndex] || null
    // Re-edit an already-saved new-format query
    if (existing?.copies) {
      set({ queryEditDraft: { constraintId, sequenceIndex, copies: existing.copies, links: existing.links, pendingClick: null } })
      return
    }
    // Seed fresh graph from sequence members
    const seq = c.sequences[sequenceIndex] || []
    const facts   = get().facts
    const subtypes = get().subtypes
    const copies = [], links = []
    const offsetCount = {}  // originalId → how many copies created so far
    const nextOffset = (originalId) => {
      const n = offsetCount[originalId] ?? 0
      offsetCount[originalId] = n + 1
      return { dx: (n + 1) * 16, dy: (n + 1) * 16 }
    }

    const hasExplicitTarget = !!c.targetObjectTypeId
    // ring / valueComparison / exclusion / equality / subset have no output OT concept;
    // targetObjectTypeId may be set as a side-effect of auto-generation but should not be marked output
    const hasOutputOt = ['uniqueness', 'frequency', 'inclusiveOr', 'exclusiveOr'].includes(c.constraintType)

    // Target copy — created first so it is never shared with role variables
    if (hasExplicitTarget) {
      const targetCopyId = uid()
      copies.push({ id: targetCopyId, kind: 'objectType', originalId: c.targetObjectTypeId, isOutput: hasOutputOt, ...nextOffset(c.targetObjectTypeId) })
    }

    // Each role gets its own fresh fact copy; OT copies are added by the user later
    seq.forEach((m, seqPos) => {
      if (m.kind !== 'role') return
      const factCopyId = uid()
      copies.push({ id: factCopyId, kind: 'fact', originalId: m.factId, isOutput: false, seededRoles: [{ roleIndex: m.roleIndex, seqPosition: seqPos }], ...nextOffset(m.factId) })
    })
    for (const m of seq) {
      if (m.kind !== 'subtype') continue
      const st = subtypes.find(s => s.id === m.subtypeId)
      if (!st) continue
      const stCopyId = uid()
      copies.push({ id: stCopyId, kind: 'subtype', originalId: m.subtypeId, isOutput: !hasExplicitTarget, isSeeded: true, ...nextOffset(m.subtypeId) })
      const makeOtCopy = (otId) => {
        const cid = uid()
        copies.push({ id: cid, kind: 'objectType', originalId: otId, isOutput: false, ...nextOffset(otId) })
        return cid
      }
      links.push({ copyId: stCopyId, roleIndex: 0, variableId: makeOtCopy(st.subId)   })
      links.push({ copyId: stCopyId, roleIndex: 1, variableId: makeOtCopy(st.superId) })
    }
    set({ queryEditDraft: { constraintId, sequenceIndex, copies, links, pendingClick: null } })
  },

  queryEditClick(target) {
    // target: { type: 'otCopy'|'otOriginal'|'factCopyRole'|'factOriginalRole'|'subtypeCopy'|'subtypeOriginal', id, roleIndex? }
    const qd = get().queryEditDraft
    if (!qd) return
    const { pendingClick } = qd
    if (!pendingClick) {
      // First click must be on a copy, not an original
      if (target.type !== 'otCopy' && target.type !== 'factCopyRole' && target.type !== 'subtypeCopy') return
      set({ queryEditDraft: { ...qd, pendingClick: target } })
      return
    }
    // Same target clicked again → cancel pending
    if (pendingClick.type === target.type && pendingClick.id === target.id && pendingClick.roleIndex === target.roleIndex) {
      set({ queryEditDraft: { ...qd, pendingClick: null } })
      return
    }
    const isOtSide   = t => t.type === 'otCopy'   || t.type === 'otOriginal'
    const isRoleSide = t => t.type === 'factCopyRole' || t.type === 'factOriginalRole' || t.type === 'subtypeCopy' || t.type === 'subtypeOriginal'

    // Two OT-side clicks
    if (isOtSide(pendingClick) && isOtSide(target)) {

      // Resolve original IDs for both sides
      const ot1OrigId = pendingClick.type === 'otCopy'
        ? qd.copies.find(c => c.id === pendingClick.id)?.originalId : pendingClick.id
      const ot2OrigId = target.type === 'otCopy'
        ? qd.copies.find(c => c.id === target.id)?.originalId : target.id
      if (!ot1OrigId || !ot2OrigId) { set({ queryEditDraft: { ...qd, pendingClick: null } }); return }

      // Find a subtype edge connecting the two OTs (either direction)
      const allSubtypes = get().subtypes
      const st = allSubtypes.find(s =>
        (s.subId === ot1OrigId && s.superId === ot2OrigId) ||
        (s.subId === ot2OrigId && s.superId === ot1OrigId)
      )
      if (!st) { set({ queryEditDraft: { ...qd, pendingClick: null } }); return }

      const newCopies2 = [...qd.copies]
      const newLinks2  = [...qd.links]
      const offsetFor  = (origId) => {
        const n = newCopies2.filter(c => c.originalId === origId).length
        return { dx: (n + 1) * 16, dy: (n + 1) * 16 }
      }

      // Resolve or create OT1 copy
      let ot1CopyId
      if (pendingClick.type === 'otCopy') { ot1CopyId = pendingClick.id }
      else { ot1CopyId = uid(); newCopies2.push({ id: ot1CopyId, kind: 'objectType', originalId: ot1OrigId, isOutput: false, ...offsetFor(ot1OrigId) }) }

      // Resolve or create OT2 copy
      let ot2CopyId
      if (target.type === 'otCopy') { ot2CopyId = target.id }
      else { ot2CopyId = uid(); newCopies2.push({ id: ot2CopyId, kind: 'objectType', originalId: ot2OrigId, isOutput: false, ...offsetFor(ot2OrigId) }) }

      // Create subtype copy linking them
      const stCopyId = uid()
      const stIsOutput = !get().constraints.find(c => c.id === qd.constraintId)?.targetObjectTypeId
      newCopies2.push({ id: stCopyId, kind: 'subtype', originalId: st.id, isOutput: stIsOutput, isSeeded: false, ...offsetFor(st.id) })
      newLinks2.push({ copyId: stCopyId, roleIndex: 0, variableId: st.subId   === ot1OrigId ? ot1CopyId : ot2CopyId })
      newLinks2.push({ copyId: stCopyId, roleIndex: 1, variableId: st.superId === ot1OrigId ? ot1CopyId : ot2CopyId })

      set({ queryEditDraft: { ...qd, copies: newCopies2, links: newLinks2, pendingClick: null } })
      return
    }

    let otTarget, roleTarget
    if (isOtSide(pendingClick) && isRoleSide(target))       { otTarget = pendingClick; roleTarget = target }
    else if (isRoleSide(pendingClick) && isOtSide(target))  { roleTarget = pendingClick; otTarget = target }
    else { set({ queryEditDraft: { ...qd, pendingClick: null } }); return }

    const facts    = get().facts
    const subtypes = get().subtypes
    const newCopies = [...qd.copies]
    const newLinks  = [...qd.links]

    // Helper: initial dx/dy for a new copy based on how many of the same originalId already exist
    const newCopyOffset = (originalId) => {
      const n = newCopies.filter(c => c.originalId === originalId).length
      return { dx: (n + 1) * 16, dy: (n + 1) * 16 }
    }

    // Resolve or create OT copy
    let otCopyId, otOriginalId
    if (otTarget.type === 'otCopy') {
      otCopyId = otTarget.id
      otOriginalId = newCopies.find(c => c.id === otCopyId)?.originalId
    } else {
      otCopyId = uid(); otOriginalId = otTarget.id
      newCopies.push({ id: otCopyId, kind: 'objectType', originalId: otOriginalId, isOutput: false, ...newCopyOffset(otOriginalId) })
    }
    if (!otOriginalId) { set({ queryEditDraft: { ...qd, pendingClick: null } }); return }

    // Resolve or create fact/subtype copy and determine roleIndex
    let roleCopyId, roleIndex
    if (roleTarget.type === 'factCopyRole') {
      roleCopyId = roleTarget.id; roleIndex = roleTarget.roleIndex
    } else if (roleTarget.type === 'factOriginalRole') {
      roleCopyId = uid(); roleIndex = roleTarget.roleIndex
      const isObjectified = facts.find(f => f.id === roleTarget.id)?.objectified
      newCopies.push({ id: roleCopyId, kind: isObjectified ? 'objectType' : 'fact', originalId: roleTarget.id, isOutput: false, ...newCopyOffset(roleTarget.id) })
    } else {
      // Subtype: infer which end from OT type
      const stOriginalId = roleTarget.type === 'subtypeCopy'
        ? (qd.copies.find(c => c.id === roleTarget.id)?.originalId)
        : roleTarget.id
      const st = subtypes.find(s => s.id === stOriginalId)
      if (!st) { set({ queryEditDraft: { ...qd, pendingClick: null } }); return }
      if      (otOriginalId === st.subId)   roleIndex = 0
      else if (otOriginalId === st.superId) roleIndex = 1
      else { set({ queryEditDraft: { ...qd, pendingClick: null } }); return }
      if (roleTarget.type === 'subtypeCopy') {
        roleCopyId = roleTarget.id
      } else {
        roleCopyId = uid()
        const stOut = !get().constraints.find(c => c.id === qd.constraintId)?.targetObjectTypeId
        newCopies.push({ id: roleCopyId, kind: 'subtype', originalId: stOriginalId, isOutput: stOut, isSeeded: false, ...newCopyOffset(stOriginalId) })
      }
    }

    // Type-check for fact role slots
    if (roleTarget.type === 'factCopyRole' || roleTarget.type === 'factOriginalRole') {
      const factOrigId = newCopies.find(c => c.id === roleCopyId)?.originalId
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
    const existingIdx = newLinks.findIndex(l => l.copyId === roleCopyId && l.roleIndex === roleIndex)
    if (existingIdx !== -1) newLinks.splice(existingIdx, 1)

    newLinks.push({ copyId: roleCopyId, roleIndex, variableId: otCopyId })

    set({ queryEditDraft: { ...qd, copies: newCopies, links: newLinks, pendingClick: null } })
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
        queries[qd.sequenceIndex] = { copies: qd.copies, links: qd.links }
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

  updateQueryCopyOffset(copyId, dx, dy) {
    const qd = get().queryEditDraft
    if (!qd) return
    set(s => {
      const diagrams = s.diagrams.map(d => {
        if (d.id !== s.activeDiagramId) return d
        const qp = d.queryPositions ?? {}
        const forC = qp[qd.constraintId] ?? {}
        const forS = forC[qd.sequenceIndex] ?? {}
        return { ...d, queryPositions: { ...qp, [qd.constraintId]: { ...forC, [qd.sequenceIndex]: { ...forS, [copyId]: { dx, dy } } } } }
      })
      return {
        diagrams,
        isDirty: true,
      }
    })
  },

  resetQueryCopyPosition(copyId) {
    const qd = get().queryEditDraft
    if (!qd) return
    set(s => {
      const diagrams = s.diagrams.map(d => {
        if (d.id !== s.activeDiagramId) return d
        const qp = d.queryPositions ?? {}
        const forC = qp[qd.constraintId] ?? {}
        const forS = { ...(forC[qd.sequenceIndex] ?? {}) }
        delete forS[copyId]
        return { ...d, queryPositions: { ...qp, [qd.constraintId]: { ...forC, [qd.sequenceIndex]: forS } } }
      })
      return { diagrams, isDirty: true }
    })
  },

  mergeOtCopyInto(draggedId, targetId) {
    const qd = get().queryEditDraft
    if (!qd) return
    const dragged = qd.copies.find(c => c.id === draggedId)
    const target  = qd.copies.find(c => c.id === targetId)
    if (!dragged || !target || dragged.originalId !== target.originalId) return
    const survived = (dragged.isOutput || target.isOutput) ? { ...target, isOutput: true } : target
    const afterMergeCopies = qd.copies.filter(c => c.id !== draggedId).map(c => c.id === targetId ? survived : c)
    const afterMergeLinks  = qd.links.map(l => l.variableId === draggedId ? { ...l, variableId: targetId } : l)
    const { copies, links } = runFactMergePass(afterMergeCopies, afterMergeLinks, get().facts)
    set({ queryEditDraft: { ...qd, copies, links, pendingClick: null } })
  },

  splitOtCopy(copyId) {
    const qd = get().queryEditDraft
    if (!qd) return
    const cp = qd.copies.find(c => c.id === copyId)
    if (!cp || cp.kind !== 'objectType') return

    const allFacts = get().facts
    const isObjectifiedId = (id) => allFacts.some(f => f.id === id && f.objectified)
    const isFactSide = (c) => c.kind === 'fact' || (c.kind === 'objectType' && isObjectifiedId(c.originalId))

    // Only links where the role side is a fact/nested-OT copy
    const roleLinks = qd.links.filter(l =>
      l.variableId === copyId &&
      qd.copies.some(c => c.id === l.copyId && isFactSide(c))
    )
    if (roleLinks.length < 2) return

    const n = roleLinks.length
    const baseDx = cp.dx ?? 16, baseDy = cp.dy ?? 16
    let newCopies = [...qd.copies]
    let newLinks  = [...qd.links]

    // Create one replacement OT copy per role link, spread in a circle
    roleLinks.forEach((lk, i) => {
      const newId = uid()
      const angle  = (2 * Math.PI * i) / n
      const radius = 30
      newCopies.push({
        id: newId, kind: cp.kind, originalId: cp.originalId,
        isOutput: cp.isOutput && i === 0,
        dx: baseDx + Math.round(Math.cos(angle) * radius),
        dy: baseDy + Math.round(Math.sin(angle) * radius),
      })
      const idx = newLinks.indexOf(lk)
      newLinks[idx] = { ...lk, variableId: newId }
    })

    // Remove the original copy and any remaining links to it (e.g. subtype links)
    newCopies = newCopies.filter(c => c.id !== copyId)
    newLinks  = newLinks.filter(l => l.variableId !== copyId && l.copyId !== copyId)

    // Drop orphaned subtype copies (missing either endpoint)
    const orphaned = new Set(
      newCopies.filter(c => {
        if (c.kind !== 'subtype') return false
        return !newLinks.some(l => l.copyId === c.id && l.roleIndex === 0) ||
               !newLinks.some(l => l.copyId === c.id && l.roleIndex === 1)
      }).map(c => c.id)
    )
    newCopies = newCopies.filter(c => !orphaned.has(c.id))
    newLinks  = newLinks.filter(l => !orphaned.has(l.copyId) && !orphaned.has(l.variableId))

    set({ queryEditDraft: { ...qd, copies: newCopies, links: newLinks, pendingClick: null } })
  },

  splitFactCopy(copyId) {
    const qd = get().queryEditDraft
    if (!qd) return
    const cp = qd.copies.find(c => c.id === copyId)
    if (!cp) return

    const allFacts = get().facts
    const isObjectifiedId = (id) => allFacts.some(f => f.id === id && f.objectified)

    // Applies to plain fact copies and objectified-fact OT copies
    if (cp.kind !== 'fact' && !(cp.kind === 'objectType' && isObjectifiedId(cp.originalId))) return

    const fact = allFacts.find(f => f.id === cp.originalId)
    const arity = fact?.arity ?? fact?.roles?.length ?? 0
    if (arity < 2) return

    const seededMap = new Map((cp.seededRoles ?? []).map(s =>
      typeof s === 'number' ? [s, { roleIndex: s, seqPosition: null }] : [s.roleIndex, s]))
    const baseDx  = cp.dx ?? 16, baseDy = cp.dy ?? 16

    // Snapshot existing role connections before we filter links
    const roleConnections = {}
    for (let ri = 0; ri < arity; ri++) {
      const lk = qd.links.find(l => l.copyId === copyId && l.roleIndex === ri)
      if (lk) roleConnections[ri] = lk.variableId
    }

    // Remove all links associated with the original copy (role links and back-links)
    let newLinks  = qd.links.filter(l => l.copyId !== copyId && l.variableId !== copyId)
    let newCopies = qd.copies.filter(c => c.id !== copyId)

    // Create one replacement copy per role, spread in a circle
    for (let ri = 0; ri < arity; ri++) {
      const newId  = uid()
      const angle  = (2 * Math.PI * ri) / arity
      const radius = 30
      newCopies.push({
        id: newId, kind: cp.kind, originalId: cp.originalId,
        isOutput: false,
        seededRoles: seededMap.has(ri) ? [seededMap.get(ri)] : [],
        dx: baseDx + Math.round(Math.cos(angle) * radius),
        dy: baseDy + Math.round(Math.sin(angle) * radius),
      })
      if (roleConnections[ri] !== undefined) {
        newLinks.push({ copyId: newId, roleIndex: ri, variableId: roleConnections[ri] })
      }
    }

    set({ queryEditDraft: { ...qd, copies: newCopies, links: newLinks, pendingClick: null } })
  },

  splitOutputRoles(copyId) {
    const qd = get().queryEditDraft
    if (!qd) return
    const cp = qd.copies.find(c => c.id === copyId)
    if (!cp) return

    const allFacts = get().facts
    const isObjectifiedId = (id) => allFacts.some(f => f.id === id && f.objectified)
    if (cp.kind !== 'fact' && !(cp.kind === 'objectType' && isObjectifiedId(cp.originalId))) return

    const seededRoles = cp.seededRoles ?? []
    if (seededRoles.length <= 1) return

    const [firstRole, ...otherRoles] = seededRoles
    const baseDx = cp.dx ?? 16, baseDy = cp.dy ?? 16

    // Original copy keeps only the first output role; all its links are preserved
    let newCopies = qd.copies.map(c =>
      c.id === copyId ? { ...c, seededRoles: [firstRole] } : c
    )
    const newLinks = [...qd.links]

    // One fresh, unconnected copy per remaining output role
    otherRoles.forEach((ri, i) => {
      const angle  = (2 * Math.PI * (i + 1)) / (otherRoles.length + 1)
      const radius = 36
      newCopies.push({
        id: uid(), kind: cp.kind, originalId: cp.originalId,
        isOutput: false,
        seededRoles: [ri],
        dx: baseDx + Math.round(Math.cos(angle) * radius),
        dy: baseDy + Math.round(Math.sin(angle) * radius),
      })
    })

    set({ queryEditDraft: { ...qd, copies: newCopies, links: newLinks, pendingClick: null } })
  },

  removeQueryCopy(copyId) {
    const qd = get().queryEditDraft
    if (!qd) return
    // Remove links touching this copy
    const remainingLinks = qd.links.filter(l => l.copyId !== copyId && l.variableId !== copyId)
    // Orphan any subtype copies whose sub or super OT copy is now missing
    const orphaned = new Set(
      qd.copies
        .filter(cp => {
          if (cp.kind !== 'subtype') return false
          const hasSubLink = remainingLinks.some(l => l.copyId === cp.id && l.roleIndex === 0)
          const hasSupLink = remainingLinks.some(l => l.copyId === cp.id && l.roleIndex === 1)
          return !hasSubLink || !hasSupLink
        })
        .map(cp => cp.id)
    )
    orphaned.add(copyId)
    const newCopies = qd.copies.filter(cp => !orphaned.has(cp.id))
    const newLinks  = remainingLinks.filter(l => !orphaned.has(l.copyId) && !orphaned.has(l.variableId))
    set({ queryEditDraft: { ...qd, copies: newCopies, links: newLinks, pendingClick: null } })
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

        let elementIds = d.elementIds === null ? null : [...d.elementIds, c.id]
        let positions  = { ...d.positions, [c.id]: { x: c.x, y: c.y } }

        for (const id of idsToAdd) {
          if (elementIds !== null && elementIds.includes(id)) continue
          const el = s.objectTypes.find(o => o.id === id) ?? s.facts.find(f => f.id === id)
          if (!el) continue
          if (elementIds !== null) elementIds = [...elementIds, id]
          positions = { ...positions, [id]: positions[id] ?? { x: el.x, y: el.y } }
        }

        // Add implied links to shownImplicitLinks
        const shown = d.shownImplicitLinks || []
        const newShown = new Set(shown)
        for (const ilKey of impliedLinksToShow) newShown.add(ilKey)
        const shownChanged = newShown.size !== shown.length || [...newShown].some(k => !shown.includes(k))

        return {
          ...d,
          elementIds,
          positions,
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
      diagrams: s.diagrams.map(d => d.id !== s.activeDiagramId ? d : {
        ...d,
        positions: { ...d.positions, [id]: { x, y } },
      }),
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
      diagrams: s.diagrams.map(d => ({
        ...d,
        elementIds: d.elementIds === null ? null : d.elementIds.filter(eid => eid !== id),
        positions:  Object.fromEntries(Object.entries(d.positions).filter(([k]) => k !== id)),
      })),
      selectedId: s.selectedId === id ? null : s.selectedId,
      isDirty: true,
    }))
  },

  // ── selection ────────────────────────────────────────────────────────────

   select(id, kind) {
    if (get().uniquenessConstruction) get().abandonUniquenessConstruction()
    if (get().frequencyConstruction) get().abandonFrequencyConstruction()
    if (get().sequenceConstruction) get().abandonSequenceConstruction()
    if (kind === 'implicitLink') {
      const [factId, roleIndex] = id.split('_il_').map((v, i) => i === 0 ? v : Number(v))
      set({ selectedId: id, selectedKind: 'implicitLink', selectedImplicitLink: roleIndex, selectedRole: null, selectedUniqueness: null, selectedImplicitLinkRole: null,
            selectedMandatoryDot: null, selectedInternalFrequency: null,
            selectedValueRange: null, selectedCardinalityRange: null, multiSelectedIds: [] })
      return
    }
    set({ selectedId: id, selectedKind: kind, selectedRole: null, selectedImplicitLink: null, selectedImplicitLinkRole: null, selectedUniqueness: null,
          selectedMandatoryDot: null, selectedInternalFrequency: null,
          selectedValueRange: null, selectedCardinalityRange: null, multiSelectedIds: [] })
  },
  clearSelection() {
    if (get().uniquenessConstruction) get().abandonUniquenessConstruction()
    if (get().frequencyConstruction) get().abandonFrequencyConstruction()
    if (get().sequenceConstruction) get().abandonSequenceConstruction()
    set({ selectedId: null, selectedKind: null, selectedRole: null, selectedImplicitLink: null, selectedImplicitLinkRole: null, selectedUniqueness: null,
          selectedMandatoryDot: null, selectedInternalFrequency: null,
          selectedValueRange: null, selectedCardinalityRange: null, multiSelectedIds: [] })
  },

  selectMandatoryDot(factId, roleIndex) {
    if (get().uniquenessConstruction) get().abandonUniquenessConstruction()
    if (get().frequencyConstruction) get().abandonFrequencyConstruction()
    set({ selectedMandatoryDot: { factId, roleIndex }, selectedId: null, selectedKind: null,
          selectedRole: null, selectedUniqueness: null, selectedInternalFrequency: null,
          selectedValueRange: null, selectedCardinalityRange: null, multiSelectedIds: [] })
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
          selectedValueRange: null, selectedCardinalityRange: null, multiSelectedIds: [] })
  },
  selectImpliedMandatoryDot(factId, roleIndex) {
    if (get().uniquenessConstruction) get().abandonUniquenessConstruction()
    if (get().frequencyConstruction) get().abandonFrequencyConstruction()
    set({ selectedMandatoryDot: { factId, roleIndex, implied: true },
          selectedId: null, selectedKind: null, selectedRole: null,
          selectedUniqueness: null, selectedInternalFrequency: null,
          selectedValueRange: null, selectedCardinalityRange: null, multiSelectedIds: [] })
  },

  selectInternalFrequency(factId, ifId) {
    if (get().uniquenessConstruction) get().abandonUniquenessConstruction()
    if (get().frequencyConstruction) get().abandonFrequencyConstruction()
    set({ selectedInternalFrequency: { factId, ifId }, selectedId: null, selectedKind: null,
          selectedRole: null, selectedUniqueness: null, selectedMandatoryDot: null,
          selectedValueRange: null, selectedCardinalityRange: null, multiSelectedIds: [] })
  },
  deselectInternalFrequency() { set({ selectedInternalFrequency: null }) },

  selectValueRange(desc) {
    set({ selectedValueRange: desc, selectedId: null, selectedKind: null,
          selectedRole: null, selectedUniqueness: null, selectedMandatoryDot: null,
          selectedInternalFrequency: null, selectedCardinalityRange: null, multiSelectedIds: [] })
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
          selectedInternalFrequency: null, selectedValueRange: null, multiSelectedIds: [] })
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
    const elementIds = activeDiagram?.elementIds  // null = show-all diagram

    const visible = (id) => elementIds === null || elementIds.includes(id)

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

  shiftSelect(id) {
    set(s => {
      const base = s.multiSelectedIds.length > 0
        ? s.multiSelectedIds
        : (s.selectedId ? [s.selectedId] : [])
      const isRemoving = base.includes(id)
      let next = isRemoving ? base.filter(i => i !== id) : [...base, id]
      // When adding/removing an entity with a collapsed ref-mode, also add/remove
      // the implied fact type and value type.
      const ot = s.objectTypes.find(o => o.id === id)
             ?? s.facts.find(f => f.id === id && f.objectified)
      if (ot) {
        const rm = findRefMode(ot, s.facts, s.objectTypes)
        if (rm) {
          const expanded = (s.diagrams.find(d => d.id === s.activeDiagramId)?.expandedRefModes ?? []).includes(id)
          if (!expanded) {
            if (isRemoving) {
              next = next.filter(i => i !== rm.factId && i !== rm.vtId)
            } else {
              if (!next.includes(rm.factId)) next = [...next, rm.factId]
              if (!next.includes(rm.vtId))   next = [...next, rm.vtId]
            }
          }
        }
      }
      return { multiSelectedIds: next, selectedId: null, selectedKind: null,
               selectedRole: null, selectedUniqueness: null }
    })
  },

  setMultiSelection(ids) {
    if (ids.length === 0) {
      set({ multiSelectedIds: [], selectedId: null, selectedKind: null,
            selectedRole: null, selectedUniqueness: null })
    } else {
      set(s => {
        const expanded = new Set(s.diagrams.find(d => d.id === s.activeDiagramId)?.expandedRefModes ?? [])
        const result = [...ids]
        const idSet = new Set(ids)
        for (const id of ids) {
          const ot = s.objectTypes.find(o => o.id === id)
                 ?? s.facts.find(f => f.id === id && f.objectified)
          if (!ot || expanded.has(id)) continue
          const rm = findRefMode(ot, s.facts, s.objectTypes)
          if (!rm) continue
          if (!idSet.has(rm.factId)) { idSet.add(rm.factId); result.push(rm.factId) }
          if (!idSet.has(rm.vtId))   { idSet.add(rm.vtId);   result.push(rm.vtId) }
        }
        return { multiSelectedIds: result, selectedId: null, selectedKind: null,
                 selectedRole: null, selectedUniqueness: null }
      })
    }
  },

  clearMultiSelection() {
    set({ multiSelectedIds: [] })
  },

  alignMultiSelection(axis) {
    const { multiSelectedIds, activeDiagramId, diagrams, objectTypes, facts, constraints } = get()
    if (multiSelectedIds.length < 2) return
    const idSet   = new Set(multiSelectedIds)
    const diagram = diagrams.find(d => d.id === activeDiagramId)
    const pos     = diagram?.positions ?? {}

    // Collect ref-mode fact/VT IDs whose parent entity has a collapsed ref-mode
    // in this diagram — these are rendered as part of the entity node and must
    // not participate in alignment as independent elements.
    const expandedRefModes = new Set(diagram?.expandedRefModes ?? [])
    const impliedCollapsed = new Set()
    for (const id of multiSelectedIds) {
      const ot = objectTypes.find(o => o.id === id)
             ?? facts.find(f => f.id === id && f.objectified)
      if (!ot) continue
      const rm = findRefMode(ot, facts, objectTypes)
      if (!rm || expandedRefModes.has(id)) continue
      impliedCollapsed.add(rm.factId)
      impliedCollapsed.add(rm.vtId)
    }

    const getAxis = (id) => {
      if (pos[id]) return pos[id][axis]
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

    const newPos = { ...pos }
    ids.forEach(id => {
      const base = pos[id]
        ?? (() => {
          const ot = objectTypes.find(o => o.id === id); if (ot) return { x: ot.x, y: ot.y }
          const f  = facts.find(f => f.id === id);       if (f)  return { x: f.x,  y: f.y  }
          const c  = constraints.find(c => c.id === id); if (c)  return { x: c.x,  y: c.y  }
          return { x: 0, y: 0 }
        })()
      newPos[id] = { ...base, [axis]: target }
    })

    set(s => ({
      diagrams: s.diagrams.map(d => d.id !== activeDiagramId ? d : { ...d, positions: newPos }),
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
        diagrams: s.diagrams.map(d => ({
          ...d,
          elementIds: d.elementIds === null ? null : d.elementIds.filter(id => !otIds.has(id) && !factIds.has(id) && !conIds.has(id)),
          positions:  Object.fromEntries(
            Object.entries(d.positions).filter(([k]) => {
              if (otIds.has(k) || factIds.has(k) || conIds.has(k) || ilPosKeysToRemove.has(k)) return false
              // Remove implied frequency constraint positions for deleted implicit links
              for (const ilKey of ilKeysToRemove) {
                if (k.startsWith(`${ilKey}:if:`)) return false
              }
              return true
            })
          ),
          shownImplicitLinks: (d.shownImplicitLinks || []).filter(ilKey => !ilKeysToRemove.has(ilKey)),
        })),
        selectedId: null,
        selectedKind: null,
        selectedRole: null,
        multiSelectedIds: [],
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
      const ilKeysToRemove = (fact?.implicitLinks || []).map(il => `${factId}:il:${il.roleIndex}:if:${ifId}`)
      return {
        facts: s.facts.map(f => f.id !== factId ? f : {
          ...f,
          internalFrequency: (f.internalFrequency || []).filter(i => i.id !== ifId),
        }),
        diagrams: s.diagrams.map(d => ({
          ...d,
          positions: Object.fromEntries(Object.entries(d.positions).filter(([k]) => !ilKeysToRemove.includes(k))),
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
    const factPos = activeDiagram?.positions[factId] ?? { x: fact.x, y: fact.y }
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

  selectRole(factId, roleIndex) {
    set({ selectedId: factId, selectedKind: 'fact', selectedRole: { factId, roleIndex }, selectedUniqueness: null,
          selectedMandatoryDot: null, selectedInternalFrequency: null,
          selectedValueRange: null, selectedCardinalityRange: null })
  },
  selectUniqueness(factId, uIndex) {
    if (get().uniquenessConstruction) get().abandonUniquenessConstruction()
    if (get().frequencyConstruction) get().abandonFrequencyConstruction()
    set({ selectedId: factId, selectedKind: 'fact', selectedUniqueness: { factId, uIndex }, selectedRole: null,
          selectedMandatoryDot: null, selectedInternalFrequency: null,
          selectedValueRange: null, selectedCardinalityRange: null })
  },

  // ── tool & link drafts ───────────────────────────────────────────────────

  setTool(tool)    {
    const prev = get().tool
    const clearRoleSelection = (prev === 'assignRole' && tool !== 'assignRole')
    set({ tool, linkDraft: null, ...(clearRoleSelection ? { selectedId: null, selectedKind: null, selectedRole: null, selectedUniqueness: null } : {}) })
  },
  setLinkDraft(d)  { set({ linkDraft: d }) },
  clearLinkDraft() { set({ linkDraft: null }) },

  // ── view ─────────────────────────────────────────────────────────────────

  centerOnElement(id) {
    const { objectTypes, facts, constraints, subtypes, diagrams, activeDiagramId, zoom } = get()
    const diagram = diagrams.find(d => d.id === activeDiagramId)
    const positions = diagram?.positions ?? {}
    const getElemPos = el => { const p = positions[el.id]; return { x: p?.x ?? el.x, y: p?.y ?? el.y } }

    let wx, wy
    const ot = objectTypes.find(o => o.id === id)
    if (ot) { const p = getElemPos(ot); wx = p.x; wy = p.y }
    if (wx == null) {
      const f = facts.find(f => f.id === id)
      if (f) { const p = getElemPos(f); wx = p.x; wy = p.y }
    }
    if (wx == null) {
      const c = constraints.find(c => c.id === id)
      if (c) { const p = getElemPos(c); wx = p.x; wy = p.y }
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

  navigateToElement(elementId, elementKind) {
    const { diagrams, activeDiagramId, objectTypes } = get()

    // Switch to a diagram that contains the element (prefer active, then any)
    const active = diagrams.find(d => d.id === activeDiagramId)
    const inActive = active?.elementIds === null || active?.elementIds?.includes(elementId)
    if (!inActive) {
      const target = diagrams.find(d =>
        d.id !== activeDiagramId && (d.elementIds === null || d.elementIds?.includes(elementId))
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
    const positions = diagram?.positions ?? {}
    const elementIds = new Set(diagram?.elementIds ?? [])
    const getPos = (el) => positions[el.id] ?? { x: el.x, y: el.y }
    const pts = [
      ...objectTypes.filter(ot => !elementIds.size || elementIds.has(ot.id)).map(ot => ({ ...getPos(ot), hw: 70, hh: 28 })),
      ...facts.filter(f => !elementIds.size || elementIds.has(f.id)).map(f => ({ ...getPos(f), hw: f.arity * 16, hh: 16 })),
      ...constraints.filter(c => !elementIds.size || elementIds.has(c.id)).map(c => ({ ...getPos(c), hw: 16, hh: 16 })),
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
    const d = { ...mkDiagram(name), elementIds: [] }   // intentionally empty
    set(s => {
      // Freeze any show-all diagrams (elementIds: null) to an explicit snapshot
      // of the current element IDs so elements created in the new diagram don't
      // automatically appear in existing diagrams.
      const allIds = [
        ...s.objectTypes.map(o => o.id),
        ...s.facts.map(f => f.id),
        ...s.constraints.map(c => c.id),
      ]
      const diagrams = s.diagrams.map(diag =>
        diag.elementIds === null ? { ...diag, elementIds: allIds } : diag
      )
      return { diagrams: [...diagrams, d], activeDiagramId: d.id, pan: { x: 0, y: 0 }, zoom: 1, isDirty: true }
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
      incoming?.elementIds === null || (incoming?.elementIds ?? []).includes(selId)
    )

    set({
      diagrams:        savedDiagrams,
      activeDiagramId: id,
      pan:             incoming?.pan  ?? { x: 0, y: 0 },
      zoom:            incoming?.zoom ?? 1,
      multiSelectedIds: restoredSelection,
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
      const impliedLinksToShow = new Set() // "factId:roleIndex"
      const visited  = new Set()
      const queue    = [elementId]

      while (queue.length > 0) {
        const id = queue.shift()
        if (visited.has(id)) continue
        visited.add(id)

        const st = s.subtypes.find(x => x.id === id)
        if (st) {
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
        const el = s.objectTypes.find(o => o.id === id) ?? s.facts.find(f => f.id === id)
        if (el) {
          idsToAdd.add(id)
          const fact = s.facts.find(f => f.id === id)
          if (fact)
            for (const r of fact.roles)
              if (r.objectTypeId && !visited.has(r.objectTypeId)) queue.push(r.objectTypeId)
        }
      }

      const targetDiagram = s.diagrams.find(d => d.id === diagramId)
      const existingIds = new Set(targetDiagram?.elementIds ?? [])

      const updatedDiagrams = s.diagrams.map(d => {
        if (d.id !== diagramId) return d

        let elementIds = d.elementIds === null ? null : [...d.elementIds]
        let positions  = { ...d.positions }

        for (const id of idsToAdd) {
          if (elementIds !== null && elementIds.includes(id)) continue
          const el = s.objectTypes.find(o => o.id === id) ?? s.facts.find(f => f.id === id)
          if (!el) continue
          if (elementIds !== null) elementIds = [...elementIds, id]
          positions = { ...positions, [id]: positions[id] ?? { x: el.x, y: el.y } }
        }

        // Add implied links to shownImplicitLinks
        const shown = d.shownImplicitLinks || []
        const newShown = new Set(shown)
        for (const ilKey of impliedLinksToShow) newShown.add(ilKey)
        const shownChanged = newShown.size !== shown.length || [...newShown].some(k => !shown.includes(k))

        return {
          ...d,
          elementIds,
          positions,
          shownImplicitLinks: shownChanged ? [...newShown] : shown,
        }
      })

      // Select all newly added OT/fact IDs as multi-selection (including synced constraints)
      const newlyAdded = [...idsToAdd].filter(id =>
        targetDiagram?.elementIds === null ? false : !existingIds.has(id)
      )
      const syncedDiagrams = syncConstraints(updatedDiagrams, s.constraints, s.subtypes, s.facts)
      const syncedTarget = syncedDiagrams.find(d => d.id === diagramId)
      const newConstraintIds = (syncedTarget?.elementIds ?? []).filter(id =>
        !existingIds.has(id) && s.constraints.some(c => c.id === id)
      )
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
      // Cascade: removing an OT also removes every fact that has it as a role player,
      // and recursively any further OTs/facts linked through objectified facts.
      const toRemove = computeCascadeRemove(elementId, s.facts)

      const updatedDiagrams = s.diagrams.map(d => {
        if (d.id !== diagramId) return d
        // null means "show all" — convert to explicit list minus removed elements
        const base = d.elementIds === null
          ? [...s.objectTypes.map(o => o.id), ...s.facts.map(f => f.id), ...s.constraints.map(c => c.id)]
          : d.elementIds
        return {
          ...d,
          elementIds: base.filter(id => !toRemove.has(id)),
          // Positions are kept so elements re-added later resume their previous location.
          positions: d.positions,
          expandedRefModes: (d.expandedRefModes ?? []).filter(id => !toRemove.has(id)),
        }
      })
      const syncedDiagrams = syncConstraints(updatedDiagrams, s.constraints, s.subtypes, s.facts)
      return { diagrams: syncedDiagrams, isDirty: true }
    })
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
      for (const id of multiSelectedIds) {
        computeCascadeRemove(id, s.facts).forEach(cid => cascaded.add(cid))
      }

      const updatedDiagrams = s.diagrams.map(d => {
        if (d.id !== diagramId) return d
        const base = d.elementIds === null
          ? [...s.objectTypes.map(o => o.id), ...s.facts.map(f => f.id), ...s.constraints.map(c => c.id)]
          : d.elementIds
        return {
          ...d,
          elementIds: base.filter(id => !cascaded.has(id)),
          // Element positions are kept so re-added elements resume their previous location.
          // Only implied-link-specific position keys are cleaned up (they have no schema identity).
          positions:  Object.fromEntries(Object.entries(d.positions).filter(([k]) => {
            if (ilPosKeysToRemove.has(k)) return false
            for (const ilKey of ilKeysToRemove) {
              if (k.startsWith(`${ilKey}:if:`)) return false
            }
            return true
          })),
          shownImplicitLinks: (d.shownImplicitLinks || []).filter(ilKey => !ilKeysToRemove.has(ilKey)),
          expandedRefModes: (d.expandedRefModes ?? []).filter(id => !cascaded.has(id)),
        }
      })
      const syncedDiagrams = syncConstraints(updatedDiagrams, s.constraints, s.subtypes, s.facts)
      return {
        diagrams: syncedDiagrams,
        multiSelectedIds: [],
        selectedId: null, selectedKind: null, selectedRole: null, selectedUniqueness: null,
        isDirty: true,
      }
    })
  },

  getSharedIds() {
    const { diagrams } = get()
    const counts = {}
    diagrams.forEach(d => (d.elementIds ?? []).forEach(id => { counts[id] = (counts[id] || 0) + 1 }))
    return new Set(Object.keys(counts).filter(id => counts[id] > 1))
  },
}))
