import { create } from 'zustand'
import { EXTERNAL_CONSTRAINT_TYPES } from '../constants.js'
import { constraintMaxSequences, isSingletonSequence, isOpenEndedConstruction } from '../utils/constraintRules.js'
import { runValidation as runValidationRules, DEFAULT_VALIDATION_CATEGORIES } from '../utils/validation.js'

// ── pan animation ─────────────────────────────────────────────────────────────
let _panAnimId = null

// ── id generator ──────────────────────────────────────────────────────────────
let _n = 1
const uid = () => `n${Date.now()}_${_n++}`

// ── default constructors ──────────────────────────────────────────────────────

const mkEntity = (x, y) => ({
  id: uid(), kind: 'entity',
  name: 'Entity', x, y,
  refMode: 'none',
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

// ── ref-expansion diagram cleanup ─────────────────────────────────────────────
// Given a set of element IDs being removed from a specific diagram, compute:
//   refCollapse  – entity IDs to drop from expandedRefModes
//   extraRemove  – companion VT IDs to also remove (when their FT is removed but
//                  the VT isn't already in toRemove and isn't independently used)
function computeRefExpansionCleanup(toRemove, objectTypes, facts, diagElementIds) {
  const refCollapse = new Set()
  const extraRemove = new Set()
  for (const id of toRemove) {
    const vt = objectTypes.find(o => o.id === id && o._refExpansion)
    if (vt) {
      refCollapse.add(vt._refExpansion)
      // The companion FT is already caught by computeCascadeRemove (VT is its role player)
    }
    const ft = facts.find(f => f.id === id && f._refExpansion)
    if (ft) {
      refCollapse.add(ft._refExpansion)
      // Also remove the companion VT unless it is independently used in the diagram
      const vtId = objectTypes.find(o => o._refExpansion === ft._refExpansion)?.id
      if (vtId && !toRemove.has(vtId)) {
        const vtUsedElsewhere = facts.some(f =>
          !f._refExpansion && !toRemove.has(f.id) &&
          f.roles.some(r => r.objectTypeId === vtId) &&
          (diagElementIds === null || (diagElementIds ?? []).includes(f.id))
        )
        if (!vtUsedElsewhere) extraRemove.add(vtId)
      }
    }
  }
  return { refCollapse, extraRemove }
}

// ── ref-expansion helpers ─────────────────────────────────────────────────────

// Build the VT and FT schema objects for a first-time ref-mode expansion.
function mkRefExpansionPair(ot) {
  const refSuffix = ot.refMode.startsWith('.') ? ot.refMode.slice(1) : null
  const vtName = refSuffix !== null
    ? ot.name + refSuffix.charAt(0).toUpperCase() + refSuffix.slice(1)
    : ot.refMode
  const vt = { ...mkValue(Math.round(ot.x + 160), Math.round(ot.y)), name: vtName, _refExpansion: ot.id }
  const ft = {
    ...mkFact(Math.round(ot.x + 80), Math.round(ot.y), 2),
    roles: [{ ...mkRole(), objectTypeId: ot.id }, { ...mkRole(), objectTypeId: vt.id }],
    uniqueness: [[0], [1]],
    readingParts: ['', 'is identified by', ''],
    alternativeReadings: [{ roleOrder: [1, 0], parts: ['', 'identifies', ''] }],
    _refExpansion: ot.id,
  }
  return { vt, ft }
}

// Collect the IDs of all _refExpansion elements tied to an entity.
function expansionIdsFor(entityId, objectTypes, facts) {
  return new Set([
    ...objectTypes.filter(o => o._refExpansion === entityId).map(o => o.id),
    ...facts.filter(f => f._refExpansion === entityId).map(f => f.id),
  ])
}

// Return updated diagrams with the entity's expansion removed from every diagram.
function diagramsWithPurgedExpansion(entityId, expansionIds, diagrams) {
  return diagrams.map(d => ({
    ...d,
    expandedRefModes: (d.expandedRefModes ?? []).filter(eid => eid !== entityId),
    elementIds: d.elementIds === null ? null : (d.elementIds ?? []).filter(eid => !expansionIds.has(eid)),
  }))
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

  inspectorWidth: 240,

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

    // Determine which entity IDs need to be in expandedRefModes of the target diagram.
    // Covers both clipboard.expandedRefModes (captured at copy time) and VT/FT with _refExpansion
    // (for backward-compat with clipboards saved before this feature).
    const allTargetIds = new Set([...closedIds, ...existingIds])
    const refEntityIds = new Set()
    for (const id of (clipboard.expandedRefModes ?? [])) {
      if (allTargetIds.has(id)) refEntityIds.add(id)
    }
    for (const o of clipboard.objectTypes) {
      if (o._refExpansion && allTargetIds.has(o._refExpansion)) refEntityIds.add(o._refExpansion)
    }
    for (const f of clipboard.facts) {
      if (f._refExpansion && allTargetIds.has(f._refExpansion)) refEntityIds.add(f._refExpansion)
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
      return { ...o, id: idMap.get(o.id), x: sp.x + OFFSET, y: sp.y + OFFSET, name,
               _refExpansion: o._refExpansion ? remap(o._refExpansion) : o._refExpansion }
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
        _refExpansion: f._refExpansion ? remap(f._refExpansion) : f._refExpansion,
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

    // Collect expanded ref modes for the duplicate: from clipboard.expandedRefModes (remapped)
    // and from _refExpansion on any new VT/FT
    const dupExpandedRefs = new Set([
      ...(clipboard.expandedRefModes ?? []).map(id => idMap.get(id)).filter(Boolean),
      ...newOts.filter(o => o._refExpansion).map(o => o._refExpansion),
      ...newFacts.filter(f => f._refExpansion).map(f => f._refExpansion),
    ])

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

  runValidation() {
    const s = get()
    const enabled = new Set(
      Object.entries(s.validationCategories).filter(([, v]) => v).map(([k]) => k)
    )
    set({ validationErrors: runValidationRules(s, enabled) })
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
    // When setting on an entity with an expanded reference mode, mirror to the generated VT.
    set(s => {
      const ot   = s.objectTypes.find(o => o.id === id)
      const vtId = ot?.refModeExpanded
        ? s.objectTypes.find(o => o._refExpansion === id)?.id
        : null
      return {
        objectTypes: s.objectTypes.map(o =>
          (o.id === id || o.id === vtId) ? { ...o, datatypeAssignment: assignment } : o
        ),
        isDirty: true,
      }
    })
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
      return {
        ...f,
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
      diagrams        = d.diagrams.map(diag => ({ ...diag, multiSelectedIds: [] }))
      activeDiagramId = d.activeDiagramId ?? d.diagrams[0].id
      // Migration: old files used ot.refModeExpanded (global) + refModeHidden on VT/FT.
      // Convert to per-diagram expandedRefModes.
      diagrams = diagrams.map(diag => {
        if (diag.expandedRefModes) return diag  // already in new format
        const expandedRefs = parsedOts
          .filter(o => o.refModeExpanded && (
            diag.elementIds === null ||
            parsedOts.some(vt => vt._refExpansion === o.id && (diag.elementIds ?? []).includes(vt.id)) ||
            facts.some(ft => ft._refExpansion === o.id && (diag.elementIds ?? []).includes(ft.id))
          ))
          .map(o => o.id)
        return { ...diag, expandedRefModes: expandedRefs }
      })
    } else {
      // Migrate: put all existing elements into a single default diagram
      const positions = {}
      parsedOts.forEach(o  => { positions[o.id]  = { x: o.x,  y: o.y  } })
      facts.forEach(f      => { positions[f.id]  = { x: f.x,  y: f.y  } })
      constraints.forEach(c => { positions[c.id] = { x: c.x,  y: c.y  } })
      const allIds = [...parsedOts.map(o => o.id), ...facts.map(f => f.id), ...constraints.map(c => c.id)]
      const expandedRefModes = parsedOts.filter(o => o.refModeExpanded).map(o => o.id)
      const diag   = { id: uid(), name: 'Main', elementIds: allIds, positions, multiSelectedIds: [], expandedRefModes }
      diagrams        = [diag]
      activeDiagramId = diag.id
    }

    set({
      objectTypes: parsedOts,
      facts,
      subtypes:    parsedSts,
      constraints,
      diagrams,
      activeDiagramId,
      filePath, isDirty: false, selectedId: null, selectedKind: null,
    })
  },

  serialize() {
    const { objectTypes, facts, subtypes, constraints, diagrams, activeDiagramId } = get()
    // Strip in-memory-only selection state before persisting
    const cleanDiagrams = diagrams.map(({ multiSelectedIds: _, ...d }) => d)
    return JSON.stringify({ objectTypes, facts, subtypes, constraints, diagrams: cleanDiagrams, activeDiagramId }, null, 2)
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
        s.objectTypes.filter(o => o.kind === 'value').map(o => o.name)
          .concat(s.facts.filter(f => f.objectifiedKind === 'value').map(f => f.objectifiedName).filter(Boolean))
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

      // If refMode is being cleared (set to 'none' or empty) on an entity that had implied
      // elements, hard-delete those elements now — same as deleteObjectType's expansion cleanup.
      if (patch.refMode !== undefined && ot?.kind === 'entity') {
        const hadValid = ot.refMode && ot.refMode !== 'none'
        const hasValid = patch.refMode && patch.refMode !== 'none'
        if (hadValid && !hasValid) {
          const expIds = expansionIdsFor(id, s.objectTypes, s.facts)
          return {
            objectTypes: s.objectTypes
              .filter(o => o._refExpansion !== id)
              .map(o => o.id === id ? { ...o, ...patch, refModeExpanded: false } : o),
            facts: s.facts.filter(f => f._refExpansion !== id),
            diagrams: diagramsWithPurgedExpansion(id, expIds, s.diagrams),
            isDirty: true,
          }
        }
      }

      // When the entity name or refMode changes, keep the generated value type name in sync.
      let vtId = null, vtName = null
      if (ot?.refModeExpanded && (patch.name !== undefined || patch.refMode !== undefined)) {
        vtId = s.objectTypes.find(o => o._refExpansion === id)?.id
        if (vtId) {
          const newName    = patch.name    ?? ot.name
          const newRefMode = patch.refMode ?? ot.refMode
          const refSuffix  = newRefMode?.startsWith('.') ? newRefMode.slice(1) : null
          vtName = refSuffix !== null
            ? newName + refSuffix.charAt(0).toUpperCase() + refSuffix.slice(1)
            : newRefMode
        }
      }
      return {
        objectTypes: s.objectTypes.map(o =>
          o.id === id    ? { ...o, ...patch }    :
          o.id === vtId  ? { ...o, name: vtName } : o
        ),
        isDirty: true,
      }
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
    // Truly remove any ref-mode expansion elements tied to this entity (don't just hide them).
    // Also, if the user is deleting the generated value type itself, clean up the whole expansion.
    const ot = get().objectTypes.find(o => o.id === id)
    if (ot?._refExpansion) {
      // Deleting the generated value type: hard-remove VT + FT, clear flag on parent entity.
      const parentId = ot._refExpansion
      const expIds = expansionIdsFor(parentId, get().objectTypes, get().facts)
      set(s => ({
        objectTypes: s.objectTypes
          .filter(o => o._refExpansion !== parentId)
          .map(o => o.id === parentId ? { ...o, refModeExpanded: false } : o),
        facts: s.facts.filter(f => f._refExpansion !== parentId),
        diagrams: diagramsWithPurgedExpansion(parentId, expIds, s.diagrams),
        isDirty: true,
      }))
      return  // The value type was removed by the filter above — nothing more to do.
    }
    if (ot?.refModeExpanded || get().objectTypes.some(o => o._refExpansion === id)) {
      // Deleting the entity: hard-remove its expansion elements first.
      const expIds = expansionIdsFor(id, get().objectTypes, get().facts)
      set(s => ({
        objectTypes: s.objectTypes.filter(o => o._refExpansion !== id),
        facts: s.facts.filter(f => f._refExpansion !== id),
        diagrams: diagramsWithPurgedExpansion(id, expIds, s.diagrams),
        isDirty: true,
      }))
    }

    set(s => {
      const removedSubtypeIds = new Set(
        s.subtypes.filter(st => st.subId === id || st.superId === id).map(st => st.id)
      )
      return {
        objectTypes: s.objectTypes.filter(o => o.id !== id),
        facts: s.facts.map(f => ({
          ...f,
          roles: f.roles.map(r => r.objectTypeId === id ? { ...r, objectTypeId: null } : r),
        })),
        subtypes: s.subtypes.filter(st => st.subId !== id && st.superId !== id),
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

  expandRefMode(otId) {
    const { objectTypes, facts, activeDiagramId, diagrams } = get()
    const ot = objectTypes.find(o => o.id === otId)
    if (!ot || ot.kind !== 'entity' || !ot.refMode || ot.refMode === 'none') return

    // Check if already expanded in THIS diagram (not globally)
    const activeDiag = diagrams.find(d => d.id === activeDiagramId)
    if ((activeDiag?.expandedRefModes ?? []).includes(otId)) return

    // Re-use elements from a previous expansion if they already exist globally
    const existingVt = objectTypes.find(o => o._refExpansion === otId)
    const existingFt = facts.find(f => f._refExpansion === otId)

    if (existingVt && existingFt) {
      set(s => ({
        objectTypes: s.objectTypes.map(o => o.id === otId ? { ...o, refModeExpanded: true } : o),
        diagrams: s.diagrams.map(d => {
          if (d.id !== activeDiagramId) return d
          const elementIds = d.elementIds === null ? null : [
            ...d.elementIds,
            ...(d.elementIds.includes(existingVt.id) ? [] : [existingVt.id]),
            ...(d.elementIds.includes(existingFt.id) ? [] : [existingFt.id]),
          ]
          const expandedRefModes = [...(d.expandedRefModes ?? []), otId]
          return { ...d, elementIds, expandedRefModes }
        }),
        isDirty: true,
      }))
      return
    }

    // First-time expansion: create fresh elements
    // Dot-prefixed refMode → EntityNameSuffix  (e.g. Person + .id → PersonId)
    const { vt, ft } = mkRefExpansionPair(ot)

    set(s => ({
      objectTypes: [
        ...s.objectTypes.map(o => o.id === otId ? { ...o, refModeExpanded: true } : o),
        vt,
      ],
      facts: [...s.facts, ft],
      diagrams: s.diagrams.map(d => {
        if (d.id !== activeDiagramId) return d
        const elementIds = d.elementIds === null ? null : [...(d.elementIds ?? []), vt.id, ft.id]
        const expandedRefModes = [...(d.expandedRefModes ?? []), otId]
        return { ...d, elementIds, expandedRefModes }
      }),
      isDirty: true,
    }))
  },

  // Adds only the implied VT to a specific diagram — no expansion, no FT added.
  // Creates VT/FT as schema objects if they do not exist yet.
  addImpliedVtToDiagram(entityId, diagramId) {
    const { objectTypes, facts } = get()
    const ot = objectTypes.find(o => o.id === entityId)
    if (!ot || ot.kind !== 'entity' || !ot.refMode || ot.refMode === 'none') return

    const existingVt = objectTypes.find(o => o._refExpansion === entityId)
    if (existingVt) {
      set(s => ({
        diagrams: s.diagrams.map(d => {
          if (d.id !== diagramId || d.elementIds === null || d.elementIds.includes(existingVt.id)) return d
          return { ...d, elementIds: [...d.elementIds, existingVt.id] }
        }),
        isDirty: true,
      }))
      return
    }

    // Create VT + FT schema objects; only VT enters the diagram.
    const { vt, ft } = mkRefExpansionPair(ot)
    set(s => ({
      objectTypes: [...s.objectTypes.map(o => o.id === entityId ? { ...o, refModeExpanded: true } : o), vt],
      facts: [...s.facts, ft],
      diagrams: s.diagrams.map(d => {
        if (d.id !== diagramId || d.elementIds === null) return d
        return { ...d, elementIds: [...d.elementIds, vt.id] }
      }),
      isDirty: true,
    }))
  },

  // Adds the implied FT together with its entity and VT to a specific diagram.
  // Creates VT/FT as schema objects if they do not exist yet.
  addImpliedFtToDiagram(entityId, diagramId) {
    const { objectTypes, facts, diagrams } = get()
    const ot = objectTypes.find(o => o.id === entityId)
    if (!ot || ot.kind !== 'entity' || !ot.refMode || ot.refMode === 'none') return

    const diag = diagrams.find(d => d.id === diagramId)
    if ((diag?.expandedRefModes ?? []).includes(entityId)) return

    const existingVt = objectTypes.find(o => o._refExpansion === entityId)
    const existingFt = facts.find(f => f._refExpansion === entityId)

    if (existingVt && existingFt) {
      set(s => ({
        objectTypes: s.objectTypes.map(o => o.id === entityId ? { ...o, refModeExpanded: true } : o),
        diagrams: s.diagrams.map(d => {
          if (d.id !== diagramId) return d
          const toAdd = [entityId, existingVt.id, existingFt.id]
          const elementIds = d.elementIds === null ? null :
            [...d.elementIds, ...toAdd.filter(id => !d.elementIds.includes(id))]
          return { ...d, elementIds, expandedRefModes: [...(d.expandedRefModes ?? []), entityId] }
        }),
        isDirty: true,
      }))
      return
    }

    // Create VT + FT schema objects.
    const { vt, ft } = mkRefExpansionPair(ot)
    set(s => ({
      objectTypes: [...s.objectTypes.map(o => o.id === entityId ? { ...o, refModeExpanded: true } : o), vt],
      facts: [...s.facts, ft],
      diagrams: s.diagrams.map(d => {
        if (d.id !== diagramId) return d
        const toAdd = [entityId, vt.id, ft.id]
        const elementIds = d.elementIds === null ? null :
          [...d.elementIds, ...toAdd.filter(id => !d.elementIds.includes(id))]
        return { ...d, elementIds, expandedRefModes: [...(d.expandedRefModes ?? []), entityId] }
      }),
      isDirty: true,
    }))
  },

  collapseRefMode(otId) {
    const { activeDiagramId, facts } = get()
    const vtId = get().objectTypes.find(o => o._refExpansion === otId)?.id
    const ftId = facts.find(f => f._refExpansion === otId)?.id
    set(s => ({
      diagrams: s.diagrams.map(d => {
        if (d.id !== activeDiagramId) return d
        // Keep the VT in elementIds if it plays a role in another (non-expansion) fact
        // that is visible in this diagram — it has independent uses beyond the ref mode.
        const vtUsedIndependently = vtId && facts.some(f =>
          !f._refExpansion &&
          f.roles.some(r => r.objectTypeId === vtId) &&
          (d.elementIds === null || (d.elementIds ?? []).includes(f.id))
        )
        const elementIds = d.elementIds === null ? null :
          (d.elementIds ?? []).filter(id => id !== ftId && (id !== vtId || vtUsedIndependently))
        const expandedRefModes = (d.expandedRefModes ?? []).filter(id => id !== otId)
        return { ...d, elementIds, expandedRefModes }
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

  addNestedValueFact(x, y, arity = 2) {
    const n = nextRelationNumber(get().facts)
    const base = { ...mkFact(Math.round(x), Math.round(y), arity), readingParts: defaultReadingParts(arity, n), objectified: true, objectifiedKind: 'value', nestedReading: false, datatypeAssignment: null }
    base.roles = base.roles.map(r => ({ ...r, linkReadingParts: ['', 'involves', ''] }))
    base.implicitLinks = Array.from({ length: arity }, (_, i) => mkImplicitLink(i))
    set(s => {
      const used = new Set(
        s.objectTypes.filter(o => o.kind === 'value').map(o => o.name)
          .concat(s.facts.filter(f => f.objectifiedKind === 'value').map(f => f.objectifiedName).filter(Boolean))
      )
      let n = 1
      while (used.has(`Value${n}`)) n++
      const f = { ...base, objectifiedName: `Value${n}` }
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

  convertToNestedValue(id) {
    set(s => {
      const used = new Set(
        s.objectTypes.filter(o => o.kind === 'value').map(o => o.name)
          .concat(s.facts.filter(f => f.objectifiedKind === 'value').map(f => f.objectifiedName).filter(Boolean))
      )
      let n = 1
      while (used.has(`Value${n}`)) n++
      return {
        facts: s.facts.map(f => f.id !== id ? f : {
          ...f, objectified: true, objectifiedKind: 'value',
          objectifiedName: `Value${n}`, nestedReading: false,
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
      return { facts, constraints, isDirty: true,
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
    set(s => ({
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
      isDirty: true,
    }))
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
    set(s => ({
      facts: s.facts.map(f => {
        if (f.id !== factId) return f
        if (roleIndices.length !== f.arity - 1) {
          return { ...f, preferredUniqueness: (f.preferredUniqueness || []).filter(pu => JSON.stringify([...pu].sort()) !== key) }
        }
        const current = f.preferredUniqueness || []
        const exists = current.some(pu => JSON.stringify([...pu].sort()) === key)
        const preferredUniqueness = exists
          ? current.filter(pu => JSON.stringify([...pu].sort()) !== key)
          : [...current, [...roleIndices]]
        return { ...f, preferredUniqueness }
      }),
      isDirty: true,
    }))
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
    set(s => ({
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
    }))
  },

  // ── subtypes ────────────────────────────────────────────────────────────

  addSubtype(subId, superId) {
    const exists = get().subtypes.some(s => s.subId === subId && s.superId === superId)
    if (exists || subId === superId) return
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
      const size = c.constraintType === 'ring' ? 2
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
    const { constraints, facts } = get()
    const c = constraints.find(c => c.id === constraintId)
    if (!c) return

    if (['uniqueness', 'ring', 'valueComparison', 'frequency'].includes(c.constraintType)) {
      const seq = c.sequences?.[0] ?? []
      const roleMembers = seq.filter(m => m.kind === 'role' && !m.factId?.includes('_il_'))
      if (roleMembers.length === 0 || roleMembers.length !== seq.length) return

      // All roles must be in binary fact types
      for (const m of roleMembers) {
        const f = facts.find(f => f.id === m.factId)
        if (!f || f.arity !== 2) return
      }

      // There must be a single common OT connected to the OTHER role of each fact
      let targetOtId = null
      for (const m of roleMembers) {
        const f = facts.find(f => f.id === m.factId)
        const otherRi = 1 - m.roleIndex
        const otId = f.roles[otherRi]?.objectTypeId
        if (!otId) return
        if (targetOtId === null) targetOtId = otId
        else if (targetOtId !== otId) return
      }
      if (!targetOtId) return

      // Don't overwrite if the user has already set a different target or a query
      if (c.targetObjectTypeId && c.targetObjectTypeId !== targetOtId) return
      if (c.queries?.[0] != null) return

      // Build the query
      const targetCopyId = uid()
      const copies = [
        { id: targetCopyId, kind: 'objectType', originalId: targetOtId,
          isOutput: true, dx: 16, dy: 16 },
      ]
      const links = []
      roleMembers.forEach((m, i) => {
        const otherRi = 1 - m.roleIndex
        const factCopyId = uid()
        copies.push({ id: factCopyId, kind: 'fact', originalId: m.factId,
          isOutput: false, seededRoles: [m.roleIndex],
          dx: (i + 2) * 16, dy: (i + 2) * 16 })
        links.push({ copyId: factCopyId, roleIndex: otherRi, variableId: targetCopyId })
      })

      set(s => ({
        constraints: s.constraints.map(c => {
          if (c.id !== constraintId) return c
          const queries = [...(c.queries || [])]
          while (queries.length < 1) queries.push(null)
          queries[0] = { copies, links }
          return { ...c, targetObjectTypeId: targetOtId, queries }
        }),
        isDirty: true,
      }))
    }

    if (c.constraintType === 'inclusiveOr' || c.constraintType === 'exclusiveOr') {
      const sequences = c.sequences ?? []
      if (sequences.length === 0) return
      const allSubtypes = get().subtypes

      // Helper: apply generated queries for matching sequences
      const applyQueries = (targetOtId, buildQuery) => {
        if (c.targetObjectTypeId && c.targetObjectTypeId !== targetOtId) return
        const existingQueries = [...(c.queries ?? [])]
        while (existingQueries.length < sequences.length) existingQueries.push(null)
        const toGenerate = existingQueries.map((q, i) => q == null ? i : -1).filter(i => i >= 0)
        if (toGenerate.length === 0) return
        for (const i of toGenerate) existingQueries[i] = buildQuery(i)
        set(s => ({
          constraints: s.constraints.map(con =>
            con.id !== constraintId ? con : { ...con, targetObjectTypeId: targetOtId, queries: existingQueries }
          ),
          isDirty: true,
        }))
      }

      // ── Rule 1: every sequence is a single subtype edge, all with the same supertype ──
      const stMembers = sequences.map(seq =>
        seq.length === 1 && seq[0].kind === 'subtype'
          ? (allSubtypes.find(s => s.id === seq[0].subtypeId) ?? null)
          : null
      )
      if (stMembers.every(m => m !== null)) {
        const superIds = new Set(stMembers.map(st => st.superId))
        if (superIds.size === 1) {
          const targetOtId = [...superIds][0]
          applyQueries(targetOtId, i => {
            const st = stMembers[i]
            const targetCopyId = uid(), subOtCopyId = uid(), stCopyId = uid()
            return {
              copies: [
                { id: targetCopyId, kind: 'objectType', originalId: targetOtId,
                  isOutput: true, dx: 16, dy: 16 },
                { id: subOtCopyId, kind: 'objectType', originalId: st.subId,
                  isOutput: false, dx: 32, dy: 32 },
                { id: stCopyId, kind: 'subtype', originalId: st.id,
                  isOutput: true, isSeeded: true, dx: 24, dy: 24 },
              ],
              links: [
                { copyId: stCopyId, roleIndex: 0, variableId: subOtCopyId },
                { copyId: stCopyId, roleIndex: 1, variableId: targetCopyId },
              ],
            }
          })
          return
        }
      }

      // ── Rule 2: every sequence is a single role, all connected to the same OT ──
      const roleMembers = sequences.map(seq =>
        seq.length === 1 && seq[0].kind === 'role' && !seq[0].factId?.includes('_il_')
          ? seq[0] : null
      )
      if (roleMembers.every(m => m !== null)) {
        const targetOtIds = new Set(roleMembers.map(m => {
          const f = facts.find(f => f.id === m.factId)
          return f?.roles[m.roleIndex]?.objectTypeId ?? null
        }))
        if (targetOtIds.size === 1) {
          const targetOtId = [...targetOtIds][0]
          if (targetOtId) {
            applyQueries(targetOtId, i => {
              const m = roleMembers[i]
              const targetCopyId = uid(), factCopyId = uid()
              return {
                copies: [
                  { id: targetCopyId, kind: 'objectType', originalId: targetOtId,
                    isOutput: true, dx: 16, dy: 16 },
                  { id: factCopyId, kind: 'fact', originalId: m.factId,
                    isOutput: false, seededRoles: [m.roleIndex], dx: 32, dy: 32 },
                ],
                links: [
                  { copyId: factCopyId, roleIndex: m.roleIndex, variableId: targetCopyId },
                ],
              }
            })
          }
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

        // Rule 3 (exclusion only): single subtype edge → subtype copy + sub OT copy (output) + super OT copy
        if (c.constraintType === 'exclusion' && seq.length === 1 && seq[0].kind === 'subtype') {
          const st = allSubtypes.find(s => s.id === seq[0].subtypeId)
          if (st) {
            const subOtCopyId = uid(), supOtCopyId = uid(), stCopyId = uid()
            existingQueries[i] = {
              copies: [
                { id: subOtCopyId, kind: 'objectType', originalId: st.subId,
                  isOutput: true, dx: 16, dy: 16 },
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

        const roleMembers = seq.filter(m => m.kind === 'role' && !m.factId?.includes('_il_'))
        if (roleMembers.length === 0 || roleMembers.length !== seq.length) continue

        // Rule 1: all roles in binary fact types with same "other" OT
        let allBinary = true
        for (const m of roleMembers) {
          const f = facts.find(f => f.id === m.factId)
          if (!f || f.arity !== 2) { allBinary = false; break }
        }
        if (allBinary) {
          let targetOtId = null, otValid = true
          for (const m of roleMembers) {
            const f = facts.find(f => f.id === m.factId)
            const otId = f.roles[1 - m.roleIndex]?.objectTypeId
            if (!otId) { otValid = false; break }
            if (targetOtId === null) targetOtId = otId
            else if (targetOtId !== otId) { otValid = false; break }
          }
          if (otValid && targetOtId) {
            const targetCopyId = uid()
            const copies = [
              { id: targetCopyId, kind: 'objectType', originalId: targetOtId,
                isOutput: true, dx: 16, dy: 16 },
            ]
            const links = []
            roleMembers.forEach((m, j) => {
              const factCopyId = uid()
              copies.push({ id: factCopyId, kind: 'fact', originalId: m.factId,
                isOutput: false, seededRoles: [m.roleIndex],
                dx: (j + 2) * 16, dy: (j + 2) * 16 })
              links.push({ copyId: factCopyId, roleIndex: 1 - m.roleIndex, variableId: targetCopyId })
            })
            existingQueries[i] = { copies, links }
            changed = true
            continue
          }
        }

        // Rule 2: all roles in the same fact type → single fact copy with all roles marked
        const factIds = new Set(roleMembers.map(m => m.factId))
        if (factIds.size === 1) {
          const factCopyId = uid()
          existingQueries[i] = {
            copies: [{ id: factCopyId, kind: 'fact', originalId: [...factIds][0],
              isOutput: false, seededRoles: roleMembers.map(m => m.roleIndex),
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

    // Target copy — created first so it is never shared with role variables
    if (hasExplicitTarget) {
      const targetCopyId = uid()
      copies.push({ id: targetCopyId, kind: 'objectType', originalId: c.targetObjectTypeId, isOutput: true, ...nextOffset(c.targetObjectTypeId) })
    }

    // Each role gets its own fresh fact copy; OT copies are added by the user later
    for (const m of seq) {
      if (m.kind !== 'role') continue
      const factCopyId = uid()
      copies.push({ id: factCopyId, kind: 'fact', originalId: m.factId, isOutput: false, seededRoles: [m.roleIndex], ...nextOffset(m.factId) })
    }
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

    const seeded  = new Set(cp.seededRoles ?? [])
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
        seededRoles: seeded.has(ri) ? [ri] : [],
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
      const newConstraints = s.constraints.map(c => c.id === id ? { ...c, ...patch } : c)
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
      const next = base.includes(id) ? base.filter(i => i !== id) : [...base, id]
      return { multiSelectedIds: next, selectedId: null, selectedKind: null,
               selectedRole: null, selectedUniqueness: null }
    })
  },

  setMultiSelection(ids) {
    if (ids.length === 0) {
      set({ multiSelectedIds: [], selectedId: null, selectedKind: null,
            selectedRole: null, selectedUniqueness: null })
    } else {
      set({ multiSelectedIds: ids, selectedId: null, selectedKind: null,
            selectedRole: null, selectedUniqueness: null })
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

    const getAxis = (id) => {
      if (pos[id]) return pos[id][axis]
      const ot = objectTypes.find(o => o.id === id); if (ot) return ot[axis]
      const f  = facts.find(f => f.id === id);       if (f)  return f[axis]
      const c  = constraints.find(c => c.id === id); if (c)  return c[axis]
      return 0
    }

    const ids = [...idSet].filter(id =>
      objectTypes.some(o => o.id === id) ||
      facts.some(f => f.id === id) ||
      constraints.some(c => c.id === id)
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
    set(s => ({ diagrams: [...s.diagrams, d], activeDiagramId: d.id, pan: { x: 0, y: 0 }, zoom: 1, isDirty: true }))
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
    const { activeDiagramId, multiSelectedIds, diagrams } = get()
    if (id === activeDiagramId) return

    // Save the current multi-selection into the outgoing diagram, then restore
    // the incoming diagram's own selection (filtering out any stale IDs).
    const savedDiagrams = diagrams.map(d =>
      d.id === activeDiagramId ? { ...d, multiSelectedIds } : d
    )
    const incoming = savedDiagrams.find(d => d.id === id)
    const restoredSelection = (incoming?.multiSelectedIds ?? []).filter(selId =>
      incoming?.elementIds === null || (incoming?.elementIds ?? []).includes(selId)
    )

    set({
      diagrams:        savedDiagrams,
      activeDiagramId: id,
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

      const diagElementIds = s.diagrams.find(d => d.id === diagramId)?.elementIds ?? null
      const { refCollapse, extraRemove } =
        computeRefExpansionCleanup(toRemove, s.objectTypes, s.facts, diagElementIds)
      const allToRemove = extraRemove.size > 0 ? new Set([...toRemove, ...extraRemove]) : toRemove

      const updatedDiagrams = s.diagrams.map(d => {
        if (d.id !== diagramId) return d
        // null means "show all" — convert to explicit list minus removed elements
        const base = d.elementIds === null
          ? [...s.objectTypes.map(o => o.id), ...s.facts.map(f => f.id), ...s.constraints.map(c => c.id)]
          : d.elementIds
        return {
          ...d,
          elementIds: base.filter(id => !allToRemove.has(id)),
          // Positions are kept so elements re-added later resume their previous location.
          positions: d.positions,
          expandedRefModes: refCollapse.size > 0
            ? (d.expandedRefModes ?? []).filter(id => !refCollapse.has(id))
            : (d.expandedRefModes ?? []),
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

      const diagElementIds = s.diagrams.find(d => d.id === diagramId)?.elementIds ?? null
      const { refCollapse, extraRemove } =
        computeRefExpansionCleanup(cascaded, s.objectTypes, s.facts, diagElementIds)
      const allToRemove = extraRemove.size > 0 ? new Set([...cascaded, ...extraRemove]) : cascaded

      const updatedDiagrams = s.diagrams.map(d => {
        if (d.id !== diagramId) return d
        const base = d.elementIds === null
          ? [...s.objectTypes.map(o => o.id), ...s.facts.map(f => f.id), ...s.constraints.map(c => c.id)]
          : d.elementIds
        return {
          ...d,
          elementIds: base.filter(id => !allToRemove.has(id)),
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
          expandedRefModes: refCollapse.size > 0
            ? (d.expandedRefModes ?? []).filter(id => !refCollapse.has(id))
            : (d.expandedRefModes ?? []),
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
