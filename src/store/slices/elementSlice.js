import { findRefMode, vtNameFromLabel } from '../../utils/refMode.js'
import {
  uid, mkEntity, mkValue, mkFact, mkRole, mkSubtype, mkConstraint, mkDiagram, mkNote, mkImplicitLink,
  mkOcc, occOf, inDiag, patchOcc, rmOcc, patchOccById, buildRoleOccurrenceMap,
  mkConstraintOcc, cOccOf, cInDiag, patchCOcc, patchCOccById, addCOccIfAbsent, rmCOcc,
  addOccIfAbsent, addOwnedRefModeOccsIfAbsent, normalizeStEps, roleOccRefsKey,
  makeUniqueName, purgeOrphanedConstraints, closeUnderPrinciple3, computeCascadeRemove,
  identifiedIdForInternalPI, demoteOtherPIsFor, mkRefModePair, findMatchingRefModeFact,
  clearRefModePI, applyFreshRefMode,
  findUniqueLCA, findPathDown, migrateRefModeExpansion, migrateSubtypeOccurrences,
  migrateOldDiagram, nextRelationNumber, defaultReadingParts, subtypeKindOf,
  factTypeLabel, getConstraintDeps, getConstraintQueryDeps, eligibleConstraints,
  syncConstraints, computeConnectedIds, hasNoConnectors, runFactMergePass,
} from '../storeHelpers'

export function createElementSlice(set, get) {
  return {
    // ── object types ────────────────────────────────────────────────────────────

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

    // Per-diagram display toggle: show the ref mode's VT + FT as ordinary diagram elements.
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

    // Update per-diagram layout properties for a fact.
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
            const newRi = oldToNewOuter[ri]
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
            const newRi = oldToNewOuter[ri]
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
        // (and update roleOccurrenceMap to its first occurrence); if absent, remove the fact.
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

    // Toggle preferred-identifier status by uniqueness array index.
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
      if (subId === superId) return
      // Value types cannot participate in subtype edges
      const subKind   = subtypeKindOf(subId,   s0.objectTypes, s0.facts)
      const superKind = subtypeKindOf(superId, s0.objectTypes, s0.facts)
      if (subKind === 'value' || superKind === 'value') return
      const existing = s0.subtypes.find(s => s.subId === subId && s.superId === superId)
      if (existing) {
        // Schema subtype already exists — just add this occurrence pair to the active diagram.
        const diag = s0.diagrams.find(d => d.id === s0.activeDiagramId)
        const occs = diag?.occurrences ?? []
        const resolvedSubOccId   = subOccId   ?? occs.find(o => o.schemaElementId === subId)?.id
        const resolvedSuperOccId = superOccId ?? occs.find(o => o.schemaElementId === superId)?.id
        get().addSubtypeToDiagram(existing.id, s0.activeDiagramId, resolvedSubOccId ?? null, resolvedSuperOccId ?? null)
        return
      }
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

    // Begin a guided endpoint-pick flow when there is ambiguity.
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
  }
}
