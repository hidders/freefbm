import { findRefMode } from '../../utils/refMode.js'
import {
  uid, occOf, inDiag, patchOcc,
  computeConnectedIds,
} from '../storeHelpers'

export function createSelectionSlice(set, get) {
  return {
    // ── selection ────────────────────────────────────────────────────────────

    select(id, kind, occurrenceId = null) {
      if (get().uniquenessConstruction) get().abandonUniquenessConstruction()
      if (get().frequencyConstruction) get().abandonFrequencyConstruction()
      if (get().sequenceConstruction) get().abandonSequenceConstruction()
      if (kind === 'implicitLink') {
        const [, roleIndex] = id.split('_il_').map((v, i) => i === 0 ? v : Number(v))
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

    setTool(tool) {
      const prev = get().tool
      const clearRoleSelection = (prev === 'assignRole' && tool !== 'assignRole')
      set({ tool, linkDraft: null, roleReconnectDraft: null, ...(clearRoleSelection ? { selectedId: null, selectedKind: null, selectedRole: null, selectedUniqueness: null } : {}) })
    },
    setLinkDraft(d)  { set({ linkDraft: d }) },
    clearLinkDraft() { set({ linkDraft: null, roleReconnectDraft: null }) },
  }
}
