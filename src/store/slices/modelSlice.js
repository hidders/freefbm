import { runValidation as runValidationRules, DEFAULT_VALIDATION_CATEGORIES } from '../../utils/validation.js'
import { computePopulationIssues } from '../../utils/populationValidation.js'
import { isIdentifyingFact } from '../../utils/refMode.js'
import {
  uid, mkEntity, mkValue, mkFact, mkRole, mkSubtype, mkConstraint, mkDiagram, mkNote, mkImplicitLink,
  mkOcc, occOf, inDiag, patchOcc, rmOcc, patchOccById, buildRoleOccurrenceMap,
  mkConstraintOcc, cOccOf, cInDiag, patchCOcc, patchCOccById, addCOccIfAbsent, rmCOcc,
  addOccIfAbsent, addOwnedRefModeOccsIfAbsent, normalizeStEps, roleOccRefsKey,
  makeUniqueName, purgeOrphanedConstraints, closeUnderPrinciple3, computeCascadeRemove,
  identifiedIdForInternalPI, demoteOtherPIsFor, mkRefModePair, findMatchingRefModeFact,
  vtNameFromLabel, clearRefModePI, applyFreshRefMode,
  findUniqueLCA, findPathDown, migrateRefModeExpansion, migrateSubtypeOccurrences,
  migrateOldDiagram, nextRelationNumber, defaultReadingParts, subtypeKindOf,
  factTypeLabel, getConstraintDeps, getConstraintQueryDeps, eligibleConstraints,
  syncConstraints, computeConnectedIds, hasNoConnectors, runFactMergePass,
  EMPTY,
} from '../storeHelpers'

export function createModelSlice(set, get) {
  return {
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
  }
}
