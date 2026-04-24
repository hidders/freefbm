import { create } from 'zustand'
import { EXTERNAL_CONSTRAINT_TYPES } from '../constants.js'

// ── id generator ──────────────────────────────────────────────────────────────
let _n = 1
const uid = () => `n${Date.now()}_${_n++}`

// ── default constructors ──────────────────────────────────────────────────────

const mkEntity = (x, y) => ({
  id: uid(), kind: 'entity',
  name: 'Entity', x, y,
  refMode: 'id',
  valueRangeOffset: null,
})

const mkValue = (x, y) => ({
  id: uid(), kind: 'value',
  name: 'Value', x, y,
  valueRangeOffset: null,
})

const mkRole = () => ({
  id: uid(), objectTypeId: null, roleName: '', mandatory: false,
})

const mkFact = (x, y, arity = 2) => ({
  id: uid(), kind: 'fact',
  x, y, arity,
  roles: Array.from({ length: arity }, mkRole),
  readingParts: Array(arity + 1).fill(''),
  alternativeReadings: [],
  readingDisplay: 'forward',   // 'forward' | 'both' | 'reverse'
  uniqueness: [],
  orientation: 'horizontal',   // 'horizontal' | 'vertical'
  readingOffset: null,         // { dx, dy } relative to fact centre, or null for auto
  readingAbove: false,         // show reading above (horizontal) or right (vertical)
  uniquenessBelow: false,      // show uniqueness bars below (horizontal) or left (vertical)
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
  roleSequences: EXTERNAL_CONSTRAINT_TYPES.has(type) ? undefined : [[], []],
  // inclusiveOr / exclusiveOr / uniqueness can optionally reference a target object type
  targetObjectTypeId: (type === 'inclusiveOr' || type === 'exclusiveOr' || type === 'uniqueness') ? null : undefined,
  // external uniqueness: preferred identifier flag
  isPreferredIdentifier: type === 'uniqueness' ? false : undefined,
  ringTypes: type === 'ring' ? [] : undefined,
  frequency: { min: 1, max: 1 },
  exhaustive: true,
  exclusive: false,
  subtypeIds: [],
})

// elementIds: null  = no filter, show all elements (default / first diagram)
// elementIds: []    = intentionally empty (new user-created diagram)
const mkDiagram = (name = 'Main') => ({ id: uid(), name, elementIds: null, positions: {} })

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

// ── constraint auto-sync ──────────────────────────────────────────────────────
// Returns the set of constraint IDs that are eligible for a given elementId set.
// A constraint is eligible when every fact/OT/subtype-endpoint it refers to is present.
function eligibleConstraints(constraints, subtypes, elementIdSet) {
  return constraints.filter(c => {
    const factIds    = new Set()
    const otIds      = new Set()
    const subtypeIds = new Set()

    if (c.sequences != null) {
      for (const seq of c.sequences) {
        for (const m of seq) {
          if (m.kind === 'role'    && m.factId)    factIds.add(m.factId)
          if (m.kind === 'subtype' && m.subtypeId) subtypeIds.add(m.subtypeId)
        }
      }
    } else if (c.roleSequences != null) {
      for (const seq of c.roleSequences) {
        for (const ref of seq) {
          if (ref.factId) factIds.add(ref.factId)
        }
      }
    }
    if (c.targetObjectTypeId) otIds.add(c.targetObjectTypeId)

    // Must refer to at least one thing
    if (factIds.size === 0 && otIds.size === 0 && subtypeIds.size === 0) return false

    for (const id of factIds)    { if (!elementIdSet.has(id)) return false }
    for (const id of otIds)      { if (!elementIdSet.has(id)) return false }
    for (const id of subtypeIds) {
      const st = subtypes.find(s => s.id === id)
      if (!st || !elementIdSet.has(st.subId) || !elementIdSet.has(st.superId)) return false
    }
    return true
  })
}

// Recomputes which constraints belong in each diagram based on what elements are present.
// Constraints are never manually managed — they follow their referred elements automatically.
function syncConstraints(diagrams, constraints, subtypes) {
  return diagrams.map(d => {
    if (d.elementIds === null) return d   // show-all diagram: no sync needed

    // Strip all constraint ids, then re-add eligible ones
    const nonConstraintIds = d.elementIds.filter(id => !constraints.find(c => c.id === id))
    const nonConstraintSet = new Set(nonConstraintIds)
    const eligible         = eligibleConstraints(constraints, subtypes, nonConstraintSet)

    const newElementIds = [
      ...nonConstraintIds,
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
  selectedUniqueness:      null,   // { factId, uIndex } | null
  multiSelectedIds:        [],     // ids of additionally selected elements
  uniquenessConstruction:  null,   // { factId, roleIndices: number[] } | null
  sequenceConstruction:    null,   // { constraintId, steps: [{sequenceIndex}][], collected: [{sequenceIndex, member}][] } | null
  constraintHighlight:     null,   // { constraintId, sequenceIndex: number|null, positionIndex: number|null } | null

  tool:      'select',
  linkDraft: null,

  // ── global display settings ────────────────────────────────────────────
  // 'role'   → mandatory dot sits at the role-box end of the connector
  // 'object' → mandatory dot sits at the object-type border end
  mandatoryDotPosition: 'role',
  // Whether to show the reference mode label inside entity/value type nodes
  showReferenceMode: true,
  showRoleNames: true,
  showTargetConnectors: true,
  showSequenceMembership: true,
  showMinimap: true,
  // Position of the minimap panel in screen px from top-left of canvas container
  minimapPos: { x: null, y: null },  // null = default (bottom-right corner)

  clipboard: null,  // { objectTypes[], facts[], constraints[], subtypes[] } | null

  // ── clipboard ──────────────────────────────────────────────────────────
  copySelection() {
    const { selectedId, multiSelectedIds, objectTypes, facts, constraints, subtypes } = get()
    const ids = new Set(multiSelectedIds.length > 0 ? multiSelectedIds : selectedId ? [selectedId] : [])
    if (ids.size === 0) return
    const copiedOts   = objectTypes.filter(o => ids.has(o.id))
    const copiedFacts = facts.filter(f => ids.has(f.id))
    const copiedCons  = constraints.filter(c => ids.has(c.id))
    const otIds = new Set(copiedOts.map(o => o.id))
    // Subtypes only when both endpoints are in the copied set
    const copiedSts = subtypes.filter(st => otIds.has(st.subId) && otIds.has(st.superId))
    set({ clipboard: { objectTypes: copiedOts, facts: copiedFacts, constraints: copiedCons, subtypes: copiedSts } })
  },

  cutSelection() {
    get().copySelection()
    const { selectedId, selectedKind, multiSelectedIds } = get()
    if (multiSelectedIds.length > 0) { get().deleteMultiSelection(); return }
    if (!selectedId) return
    if (selectedKind === 'entity' || selectedKind === 'value') get().deleteObjectType(selectedId)
    else if (selectedKind === 'fact')       get().deleteFact(selectedId)
    else if (selectedKind === 'constraint') get().deleteConstraint(selectedId)
    else if (selectedKind === 'subtype')    get().deleteSubtype(selectedId)
  },

  pasteClipboard() {
    const { clipboard } = get()
    if (!clipboard) return
    const OFFSET = 20
    // Build old→new ID map for every copied element
    const idMap = new Map()
    const allSrc = [...clipboard.objectTypes, ...clipboard.facts, ...clipboard.constraints, ...clipboard.subtypes]
    for (const el of allSrc) idMap.set(el.id, uid())
    // Also new role IDs
    const remap = id => idMap.get(id) ?? id  // keep original if not in copied set

    const newOts = clipboard.objectTypes.map(o => ({
      ...o, id: idMap.get(o.id), x: o.x + OFFSET, y: o.y + OFFSET,
    }))

    const newFacts = clipboard.facts.map(f => ({
      ...f, id: idMap.get(f.id), x: f.x + OFFSET, y: f.y + OFFSET,
      roles: f.roles.map(r => ({
        ...r, id: uid(),
        objectTypeId: remap(r.objectTypeId),  // keep link even if OT not in copied set
      })),
    }))

    const remapMember = m =>
      m.kind === 'role'    ? { ...m, factId:    remap(m.factId) }
    : m.kind === 'subtype' ? { ...m, subtypeId: remap(m.subtypeId) }
    : m

    const newCons = clipboard.constraints.map(c => ({
      ...c, id: idMap.get(c.id), x: c.x + OFFSET, y: c.y + OFFSET,
      sequences:     c.sequences     ? c.sequences.map(g => g.map(remapMember)) : c.sequences,
      roleSequences: c.roleSequences ? c.roleSequences.map(g => g.map(r => ({ ...r, factId: remap(r.factId) }))) : c.roleSequences,
      targetObjectTypeId: c.targetObjectTypeId ? remap(c.targetObjectTypeId) : c.targetObjectTypeId,
    }))

    const newSts = clipboard.subtypes.map(st => ({
      ...st, id: idMap.get(st.id),
      subId: idMap.get(st.subId), superId: idMap.get(st.superId),
    }))

    const newIds = [...newOts, ...newFacts, ...newCons, ...newSts].map(e => e.id)
    const singleKind = newOts[0]?.kind ?? (newFacts.length ? 'fact' : newCons.length ? 'constraint' : 'subtype')

    set(s => ({
      objectTypes: [...s.objectTypes, ...newOts],
      facts:       [...s.facts,       ...newFacts],
      constraints: [...s.constraints, ...newCons],
      subtypes:    [...s.subtypes,    ...newSts],
      diagrams: s.diagrams.map(d => d.id !== s.activeDiagramId ? d : {
        ...d,
        elementIds: d.elementIds === null ? null : [...d.elementIds, ...newOts.map(o => o.id), ...newFacts.map(f => f.id), ...newCons.map(c => c.id)],
        positions: {
          ...d.positions,
          ...Object.fromEntries(newOts.map(o  => [o.id,  { x: o.x,  y: o.y  }])),
          ...Object.fromEntries(newFacts.map(f => [f.id,  { x: f.x,  y: f.y  }])),
          ...Object.fromEntries(newCons.map(c  => [c.id,  { x: c.x,  y: c.y  }])),
        },
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
  setShowTargetConnectors(val)      { set({ showTargetConnectors: val }) },
  setShowSequenceMembership(val)    { set({ showSequenceMembership: val }) },
  setShowMinimap(val)         { set({ showMinimap: val }) },
  setMinimapPos(x, y)         { set({ minimapPos: { x, y } }) },

  // ── model ops ──────────────────────────────────────────────────────────

  newModel() {
    set({ ...EMPTY(), filePath: null, isDirty: false,
          selectedId: null, selectedKind: null, selectedRole: null,
          selectedUniqueness: null, multiSelectedIds: [],
          pan: { x: 0, y: 0 }, zoom: 1 })
  },

  loadModel(data, filePath = null) {
    const d = typeof data === 'string' ? JSON.parse(data) : data
    const facts = (d.facts || []).map(f => ({
      ...f,
      readingParts: f.readingParts || Array((f.arity || 2) + 1).fill(''),
      alternativeReadings: f.alternativeReadings || [],
      readingDisplay: f.readingDisplay || 'forward',
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
      return out
    })
    const parsedOts  = d.objectTypes  || []
    const parsedSts  = d.subtypes      || []

    let diagrams, activeDiagramId
    if (d.diagrams && d.diagrams.length > 0) {
      diagrams        = d.diagrams
      activeDiagramId = d.activeDiagramId ?? d.diagrams[0].id
    } else {
      // Migrate: put all existing elements into a single default diagram
      const positions = {}
      parsedOts.forEach(o  => { positions[o.id]  = { x: o.x,  y: o.y  } })
      facts.forEach(f      => { positions[f.id]  = { x: f.x,  y: f.y  } })
      constraints.forEach(c => { positions[c.id] = { x: c.x,  y: c.y  } })
      const allIds = [...parsedOts.map(o => o.id), ...facts.map(f => f.id), ...constraints.map(c => c.id)]
      const diag   = { id: uid(), name: 'Main', elementIds: allIds, positions }
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
    return JSON.stringify({ objectTypes, facts, subtypes, constraints, diagrams, activeDiagramId }, null, 2)
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

  updateObjectType(id, patch) {
    set(s => ({
      objectTypes: s.objectTypes.map(o => o.id === id ? { ...o, ...patch } : o),
      isDirty: true,
    }))
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
          positions:  Object.fromEntries(Object.entries(d.positions).filter(([k]) => k !== id)),
        })),
        selectedId: s.selectedId === id ? null : s.selectedId,
        isDirty: true,
      }
    })
  },

  // ── fact types ──────────────────────────────────────────────────────────

  addFact(x, y, arity = 2) {
    const f = mkFact(Math.round(x), Math.round(y), arity)
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
    const base = { ...mkFact(Math.round(x), Math.round(y), arity), objectified: true, objectifiedKind, nestedReading: false }
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
    const base = { ...mkFact(Math.round(x), Math.round(y), arity), objectified: true, objectifiedKind: 'value', nestedReading: false }
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
    set(s => ({
      diagrams: s.diagrams.map(d => d.id !== s.activeDiagramId ? d : {
        ...d,
        positions: { ...d.positions, [id]: { ...(d.positions[id] ?? {}), x, y } },
      }),
      isDirty: true,
    }))
  },

  // Update per-diagram layout properties for a fact (readingAbove, readingOffset,
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
          roles = [...f.roles, ...extra]
        } else {
          roles = f.roles.slice(0, newArity)
        }
        const uniqueness = f.uniqueness.filter(u => u.every(i => i < newArity))
        const oldParts = f.readingParts || Array(current + 1).fill('')
        const readingParts = newArity > current
          ? [...oldParts, ...Array(newArity - current).fill('')]
          : oldParts.slice(0, newArity + 1)
        const alternativeReadings = (f.alternativeReadings || [])
          .filter(r => r.roleOrder.every(i => i < newArity) && r.roleOrder.length === newArity)
          .map(r => ({
            ...r,
            parts: newArity > r.parts.length - 1
              ? [...r.parts, ...Array(newArity - (r.parts.length - 1)).fill('')]
              : r.parts.slice(0, newArity + 1),
          }))
        return { ...f, arity: newArity, roles, uniqueness, readingParts, alternativeReadings }
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
      return { facts, constraints, isDirty: true }
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
          if ((f.readingParts || []).some(p => p.trim())) {
            const demotedOrder = Array.from({ length: n }, (_, i) => oldToNew[i])
            alternativeReadings = [...alternativeReadings, { roleOrder: demotedOrder, parts: f.readingParts }]
          }
        }

        return { ...f, roles, uniqueness, readingParts, alternativeReadings }
      }),
      isDirty: true,
    }))
  },

  insertRole(factId, atIndex) {
    set(s => {
      const facts = s.facts.map(f => {
        if (f.id !== factId) return f
        const roles = [...f.roles.slice(0, atIndex), mkRole(), ...f.roles.slice(atIndex)]
        const arity = f.arity + 1
        const uniqueness = f.uniqueness.map(u => u.map(i => i >= atIndex ? i + 1 : i))
        const rp = [...(f.readingParts || [])]
        rp.splice(atIndex, 0, '')
        return { ...f, arity, roles, uniqueness, readingParts: rp, alternativeReadings: [] }
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
      return { facts, constraints, isDirty: true }
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
        const rp = [...(f.readingParts || [])]
        rp.splice(roleIndex, 1)
        return { ...f, arity, roles, uniqueness, readingParts: rp, alternativeReadings: [] }
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
      return { facts, constraints, isDirty: true }
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
    set(s => ({
      facts: s.facts.map(f => {
        if (f.id !== factId) return f
        const roles = f.roles.map((r, i) =>
          i === roleIndex ? { ...r, objectTypeId } : r
        )
        return { ...f, roles }
      }),
      isDirty: true,
    }))
  },

  toggleUniqueness(factId, roleIndices) {
    set(s => ({
      facts: s.facts.map(f => {
        if (f.id !== factId) return f
        const key = JSON.stringify([...roleIndices].sort())
        const exists = f.uniqueness.some(u => JSON.stringify([...u].sort()) === key)
        const uniqueness = exists
          ? f.uniqueness.filter(u => JSON.stringify([...u].sort()) !== key)
          : [...f.uniqueness, roleIndices]
        return { ...f, uniqueness }
      }),
      isDirty: true,
    }))
  },

  updateAlternativeReading(factId, roleOrder, parts) {
    const key = JSON.stringify(roleOrder)
    set(s => ({
      facts: s.facts.map(f => {
        if (f.id !== factId) return f
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
    const isSingleton = c.constraintType === 'inclusiveOr' || c.constraintType === 'exclusiveOr' || c.constraintType === 'uniqueness'
    const openEndedType = c.constraintType === 'equality' || c.constraintType === 'subset' ||
      c.constraintType === 'exclusion'
    const maxSequences = (c.constraintType === 'equality' || c.constraintType === 'subset' || c.constraintType === 'ring') ? 2 : Infinity
    if (mode === 'newSequence') {
      if (sequences.length >= maxSequences) return
      const newSequenceIdx = sequences.length
      const size = isSingleton ? 1 : (sequences.length > 0 ? sequences[0].length : 1)
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
    set(s => ({
      constraints: s.constraints.map(c => {
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
        return { ...c, sequences }
      }),
      isDirty: true,
    }))
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

  removeConstraintSequencePosition(constraintId, position) {
    set(s => ({
      constraints: s.constraints.map(c => {
        if (c.id !== constraintId) return c
        const sequences = (c.sequences || [])
          .map(g => g.filter((_, i) => i !== position))
          .filter(g => g.length > 0)
        return { ...c, sequences }
      }),
      isDirty: true,
    }))
  },

  removeConstraintSequence(constraintId, sequenceIndex) {
    set(s => ({
      constraints: s.constraints.map(c => {
        if (c.id !== constraintId) return c
        const sequences = (c.sequences || []).filter((_, i) => i !== sequenceIndex)
        return { ...c, sequences }
      }),
      isDirty: true,
    }))
  },

  swapConstraintSequences(constraintId) {
    set(s => ({
      constraints: s.constraints.map(c => {
        if (c.id !== constraintId) return c
        const sequences = c.sequences || []
        if (sequences.length < 2) return c
        const swapped = [sequences[1], sequences[0], ...sequences.slice(2)]
        return { ...c, sequences: swapped }
      }),
      isDirty: true,
    }))
  },

  // ── constraints ─────────────────────────────────────────────────────────

  addConstraint(type, x, y) {
    const c = mkConstraint(type, Math.round(x), Math.round(y))
    set(s => ({
      constraints: [...s.constraints, c],
      diagrams: s.diagrams.map(d => d.id !== s.activeDiagramId ? d : {
        ...d,
        elementIds: d.elementIds === null ? null : [...d.elementIds, c.id],
        positions:  { ...d.positions, [c.id]: { x: c.x, y: c.y } },
      }),
      isDirty: true, selectedId: c.id, selectedKind: 'constraint',
    }))
    return c.id
  },

  updateConstraint(id, patch) {
    set(s => ({
      constraints: s.constraints.map(c => c.id === id ? { ...c, ...patch } : c),
      isDirty: true,
    }))
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
    set(s => ({
      constraints: s.constraints.map(c => {
        if (c.id !== constraintId) return c
        const roleSequences = c.roleSequences.map((g, gi) =>
          gi === sequenceIndex
            ? [...g.filter(r => !(r.factId === factId && r.roleIndex === roleIndex)),
               { factId, roleIndex }]
            : g
        )
        return { ...c, roleSequences }
      }),
      isDirty: true,
    }))
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
    if (get().uniquenessConstruction) get().commitUniquenessConstruction()
    if (get().sequenceConstruction) get().abandonSequenceConstruction()
    set({ selectedId: id, selectedKind: kind, selectedRole: null, selectedUniqueness: null, multiSelectedIds: [] })
  },
  clearSelection() {
    if (get().uniquenessConstruction) get().commitUniquenessConstruction()
    if (get().sequenceConstruction) get().abandonSequenceConstruction()
    set({ selectedId: null, selectedKind: null, selectedRole: null, selectedUniqueness: null, multiSelectedIds: [] })
  },

  selectAll() {
    const { objectTypes, facts, constraints, subtypes } = get()
    const ids = [
      ...objectTypes.map(o => o.id),
      ...facts.map(f => f.id),
      ...constraints.map(c => c.id),
      ...subtypes.map(st => st.id),
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
            Object.entries(d.positions).filter(([k]) => !otIds.has(k) && !factIds.has(k) && !conIds.has(k))
          ),
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
      if (oldKey === newKey) return
      // If the new role set already exists as a different constraint, leave everything intact
      const alreadyExists = fact.uniqueness.some((u, i) =>
        i !== uc.uIndex && JSON.stringify([...u].sort((a, b) => a - b)) === newKey
      )
      if (alreadyExists) return
      get().toggleUniqueness(uc.factId, oldRoles)           // remove old
      if (uc.roleIndices.length > 0) {
        get().toggleUniqueness(uc.factId, uc.roleIndices)   // add new
      }
    } else {
      // New constraint
      if (uc.roleIndices.length === 0) return
      const key = JSON.stringify([...uc.roleIndices].sort((a, b) => a - b))
      const exists = fact.uniqueness.some(u => JSON.stringify([...u].sort((a, b) => a - b)) === key)
      if (!exists) get().toggleUniqueness(uc.factId, uc.roleIndices)
    }
  },
  startUniquenessEdit(factId, uIndex) {
    const fact = get().facts.find(f => f.id === factId)
    if (!fact) return
    const roleIndices = [...fact.uniqueness[uIndex]]
    set({ uniquenessConstruction: { factId, roleIndices, uIndex }, selectedUniqueness: null })
  },
  selectRole(factId, roleIndex) {
    set({ selectedId: factId, selectedKind: 'fact', selectedRole: { factId, roleIndex }, selectedUniqueness: null })
  },
  selectUniqueness(factId, uIndex) {
    set({ selectedId: factId, selectedKind: 'fact', selectedUniqueness: { factId, uIndex }, selectedRole: null })
  },

  // ── tool & link drafts ───────────────────────────────────────────────────

  setTool(tool)    { set({ tool, linkDraft: null }) },
  setLinkDraft(d)  { set({ linkDraft: d }) },
  clearLinkDraft() { set({ linkDraft: null }) },

  // ── view ─────────────────────────────────────────────────────────────────

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
    set(s => ({ diagrams: [...s.diagrams, d], activeDiagramId: d.id, isDirty: true }))
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
      const newDiagrams   = s.diagrams.filter(d => d.id !== id)
      const newActiveId   = s.activeDiagramId === id ? newDiagrams[0]?.id : s.activeDiagramId
      return { diagrams: newDiagrams, activeDiagramId: newActiveId, isDirty: true }
    })
  },

  setActiveDiagram(id) {
    set({ activeDiagramId: id })
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
      const el = s.objectTypes.find(o => o.id === elementId)
        ?? s.facts.find(f => f.id === elementId)
      const pos = el ? { x: el.x, y: el.y } : { x: 100, y: 100 }

      // Collect the fact's linked object type ids (if adding a fact)
      const fact = s.facts.find(f => f.id === elementId)
      const linkedOtIds = fact
        ? fact.roles.map(r => r.objectTypeId).filter(Boolean)
        : []

      const updatedDiagrams = s.diagrams.map(d => {
        if (d.id !== diagramId) return d
        if (d.elementIds !== null && d.elementIds.includes(elementId)) return d

        let elementIds = d.elementIds === null ? null : [...d.elementIds, elementId]
        let positions  = { ...d.positions, [elementId]: d.positions[elementId] ?? pos }

        // Also add linked object types that aren't already in the diagram
        for (const otId of linkedOtIds) {
          if (elementIds !== null && elementIds.includes(otId)) continue
          const ot = s.objectTypes.find(o => o.id === otId)
          if (!ot) continue
          if (elementIds !== null) elementIds = [...elementIds, otId]
          positions = { ...positions, [otId]: positions[otId] ?? { x: ot.x, y: ot.y } }
        }

        return { ...d, elementIds, positions }
      })

      return {
        diagrams: syncConstraints(updatedDiagrams, s.constraints, s.subtypes),
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
          positions:  Object.fromEntries(Object.entries(d.positions).filter(([k]) => !toRemove.has(k))),
        }
      })
      return {
        diagrams: syncConstraints(updatedDiagrams, s.constraints, s.subtypes),
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
