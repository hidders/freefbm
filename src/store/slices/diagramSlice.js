import { findRefMode } from '../../utils/refMode.js'
import {
  mkDiagram, occOf, inDiag, cInDiag, cOccOf,
  addOccIfAbsent, addOwnedRefModeOccsIfAbsent,
  normalizeStEps, syncConstraints, computeCascadeRemove, rmCOcc,
} from '../storeHelpers'

// Module-level variable for pan animation — only used by centerOnElement/centerOnOccurrence
let _panAnimId = null

export function createDiagramSlice(set, get) {
  return {
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
            expandedRefModeOccs: (() => { const occSet = new Set(newOccs.map(o => o.id)); return (d.expandedRefModeOccs ?? []).filter(id => occSet.has(id)) })(),
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
  }
}
