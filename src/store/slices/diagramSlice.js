import { findRefMode } from '../../utils/refMode.js'
import {
  mkDiagram, occOf, inDiag, cInDiag, cOccOf,
  addOccIfAbsent, addOwnedRefModeOccsIfAbsent, mkOcc,
  normalizeStEps, syncConstraints, computeCascadeRemove, rmCOcc,
  mkUniqueness, withMandatoryId, mappingOfDiagram, makeUniqueName, eligibleConstraints, mkConstraintOcc,
} from '../storeHelpers'
import { erdPartsOfDiagram, erdTargetOf } from '../../relational/erdBoxes.js'
import { diagramUnits, tableCompanions, tableRemoval, completeTables, withTableConstraints } from '../../relational/tableUnits.js'
import { isErdDiagram, erdLayout } from '../../relational/erdBoxes.js'
import { relationalModel } from '../../relational/relationalModel.js'
import { neighbourUnits, connectPath } from '../../utils/neighbourhood.js'

// Module-level variable for pan animation — only used by centerOnElement/centerOnOccurrence
let _panAnimId = null

// A diagram with the external constraints added that all its elements now
// allow and that are about one of `touched` (elements just added by hand
// growing), so that adding neighbours brings the constraints among them.
function withTouchedConstraints(s, d, touched) {
  if (!touched.size) return d
  const shown = new Set((d.occurrences ?? []).map(o => o.schemaElementId))
  const have = new Set((d.constraintOccurrences ?? []).map(co => co.schemaConstraintId))
  const about = (c) => {
    const ids = []
    for (const seq of c.sequences ?? []) for (const m of seq) {
      if (m.factId) ids.push(m.factId.split('_il_')[0])
      if (m.subtypeId) { const st = s.subtypes.find(x => x.id === m.subtypeId); if (st) ids.push(st.subId, st.superId) }
    }
    for (const seq of c.roleSequences ?? []) for (const m of seq) if (m.factId) ids.push(m.factId.split('_il_')[0])
    if (c.targetObjectTypeId) ids.push(c.targetObjectTypeId)
    return ids
  }
  const add = eligibleConstraints(s.constraints.filter(c => c.schemaId === d.schemaId && !have.has(c.id)), s.subtypes, shown, s.facts, d.shownImplicitLinks ?? [])
    .filter(c => about(c).some(id => touched.has(id)))
  if (!add.length) return d
  return { ...d, constraintOccurrences: [...(d.constraintOccurrences ?? []), ...add.map(c => mkConstraintOcc(c.id, c.x ?? 0, c.y ?? 0))] }
}

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
      // Tables drawn as an ERD (the diagram of a relational schema, or the
      // relational side of a mapping diagram) are not where the occurrences
      // of their elements are: the table's box, or its column's row.
      const erdParts = erdPartsOfDiagram(get(), diagram)
      const erdAt = erdParts.length ? erdTargetOf(get(), erdParts, id) : null
      if (erdAt) { wx = erdAt.x + erdAt.w / 2; wy = erdAt.y + erdAt.h / 2 }
      const ot = wx == null ? objectTypes.find(o => o.id === id) : null
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

    // Pans so that the diagram point (wx, wy) is at the canvas centre.
    centerOnPoint(wx, wy) {
      const svg = document.getElementById('orm2-canvas-svg')
      if (!svg || wx == null || wy == null) return
      const { zoom, pan: startPan } = get()
      const rect = svg.getBoundingClientRect()
      const targetX = rect.width / 2 - wx * zoom, targetY = rect.height / 2 - wy * zoom
      const fromX = startPan.x, fromY = startPan.y
      const easeInOut = t => t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t
      const startTime = performance.now()
      if (_panAnimId) cancelAnimationFrame(_panAnimId)
      const step = (now) => {
        const t = Math.min((now - startTime) / 750, 1)
        const e = easeInOut(t)
        set({ pan: { x: fromX + (targetX - fromX) * e, y: fromY + (targetY - fromY) * e } })
        _panAnimId = t < 1 ? requestAnimationFrame(step) : null
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
      // A diagram of a relational schema starts with PostgreSQL datatypes.
      {
        const s0 = get()
        const active = s0.diagrams.find(x => x.id === s0.activeDiagramId)
        const schema = s0.schemas?.find(x => x.id === active?.schemaId)
        if (schema?.profile === 'relational') d.profileId = active?.profileId ?? 'postgresql'
        // A new diagram next to a mapping diagram draws the same mapping.
        if (active?.mappingId) { d.mappingId = active.mappingId; d.schemaId = active.schemaId; d.profileId = active.profileId ?? null }
      }
      set(s => {
        // In v2 all diagrams already have explicit occurrences lists (no show-all concept).
        // No migration needed — just add the new empty diagram.
        return { diagrams: [...s.diagrams, d], activeDiagramId: d.id, pan: { x: 0, y: 0 }, zoom: 1, isDirty: true }
      })
      return d.id
    },

    // A relational schema's diagram can be drawn as an ORM2 diagram or as an
    // entity-relationship diagram (crow's foot, read-only); see ErdView.jsx.
    setDiagramNotation(id, notation) {
      set(s => ({
        diagrams: s.diagrams.map(d => d.id === id ? { ...d, notation } : d),
        isDirty: true,
      }))
    },

    // How an ERD draws its foreign key lines: 'direct' (straight lines that bend
    // at box corners, the default) or 'orthogonal' (right-angled).
    setErdLines(id, erdLines) {
      set(s => ({
        diagrams: s.diagrams.map(d => d.id === id ? { ...d, erdLines } : d),
        isDirty: true,
      }))
    },

    // Forgets the ERD box positions, so the tables are laid out afresh.
    resetErdPositions(id) {
      set(s => ({
        diagrams: s.diagrams.map(d => d.id === id ? { ...d, erdPositions: {} } : d),
        isDirty: true,
      }))
    },

    // Puts the result of the ORM2 auto layout (src/layout/ormLayout.js) into a
    // diagram as one undo step: its occurrences and constraint occurrences, and
    // the internal frequency markers of its fact types (stored on the facts).
    applyDiagramLayout(id, { diagram, internalFrequency }) {
      set(s => ({
        diagrams: s.diagrams.map(d => d.id === id ? diagram : d),
        facts: Object.keys(internalFrequency ?? {}).length
          ? s.facts.map(f => internalFrequency[f.id] ? { ...f, internalFrequency: internalFrequency[f.id] } : f)
          : s.facts,
        isDirty: true,
      }))
    },

    // Top-left corners of ERD table boxes, per diagram: { [entityId]: {x, y} }.
    setErdPositions(id, positions) {
      set(s => ({
        diagrams: s.diagrams.map(d => d.id === id ? { ...d, erdPositions: { ...(d.erdPositions ?? {}), ...positions } } : d),
        isDirty: true,
      }))
    },

    renameDiagram(id, name) {
      set(s => ({
        diagrams: s.diagrams.map(d => d.id === id ? { ...d, name } : d),
        isDirty: true,
      }))
    },

    deleteDiagram(id) {
      set(s => {
        // Every schema keeps at least one diagram (its active diagram makes it
        // the active schema), so a schema's last diagram can't be deleted.
        const gone = s.diagrams.find(d => d.id === id)
        if (!gone) return {}
        // A mapping diagram can always go; the schema's own diagrams remain.
        const kin = d => d.id !== id && d.schemaId === gone.schemaId && !d.mappingId
        const siblings = gone.mappingId
          ? [...s.diagrams.filter(d => d.id !== id && d.mappingId === gone.mappingId), ...s.diagrams.filter(kin)]
          : s.diagrams.filter(kin)
        if (!siblings.length) return {}
        const newDiagrams = s.diagrams.filter(d => d.id !== id)
        const newActiveId = s.activeDiagramId === id ? siblings[0].id : s.activeDiagramId
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

    // ── growing diagrams by hand (utils/neighbourhood.js) ────────────────────

    // The Add neighbours… picker (NeighbourPicker.jsx) at an occurrence of an
    // object type or objectified fact type, or at a table of an ERD.
    openNeighbourPicker(elementId, occurrenceId = null) {
      const d = get().diagrams.find(x => x.id === get().activeDiagramId)
      if (!d || d.mappingId) return
      set({ neighbourPicker: { diagramId: d.id, elementId, occurrenceId } })
    },
    closeNeighbourPicker() { set({ neighbourPicker: null }) },
    // Growing mode: "+n" badges at elements with neighbours not shown (GrowBadges.jsx).
    setGrowMode(on) { set({ growMode: !!on }) },

    // Adds the chosen neighbourhood units of an element to a diagram as one
    // undo step, placed around the anchor without moving what is there
    // (layout/growPlacement.js). With oneMoreStep, the pre-ticked units of the
    // elements they lead to come too.
    // The placement functions are passed in (layout/growPlacement.js reads the
    // components' geometry, which the store must not import).
    // Connect: adds the shortest chain of fact types / foreign keys between
    // two elements (connectPath), each unit placed beside the element before
    // it, as one undo step. Returns the number of units added, or null when
    // the two are not connected.
    connectElements(diagramId, fromId, toId, { place } = {}) {
      const s0 = get()
      const d0 = s0.diagrams.find(d => d.id === diagramId)
      if (!d0) return null
      const path = connectPath(s0, d0.schemaId, fromId, toId)
      if (!path) {
        set({ readOnlyNotice: 'These two are not connected by fact types or foreign keys' })
        return null
      }
      if (!path.length) return 0
      get().addNeighbours(diagramId, fromId, null, [], { place, given: path })
      return path.length
    },

    // given: [{ unit, anchorId, step }] instead of units around one anchor
    // (Connect: a path, each unit placed around the element before it).
    addNeighbours(diagramId, anchorId, anchorOccId, units, { oneMoreStep = false, place, given = null } = {}) {
      if (given) units = given.map(p => p.unit)
      const s0 = get()
      const d0 = s0.diagrams.find(d => d.id === diagramId)
      if (!d0 || !units.length) return
      const erd = isErdDiagram(s0, d0)
      const beforeOccIds = new Set((d0.occurrences ?? []).map(o => o.id))
      const beforeCoccIds = (d0.constraintOccurrences ?? []).map(o => o.id)
      // An ERD's tables without a stored position are fixed where they are drawn now.
      const frozen = {}
      if (erd) for (const [id, b] of erdLayout(relationalModel(s0, d0.schemaId), d0)) frozen[id] = { x: b.x, y: b.y }
      const shownBefore = new Set((d0.occurrences ?? []).map(o => o.schemaElementId))
      set(st => ({ historyBatch: (st.historyBatch ?? 0) + 1 }))
      try {
        if (erd && Object.keys(frozen).length) get().setErdPositions(diagramId, frozen)
        const plans = given ? given.map(p => ({ ...p, anchorOccId: null })) : units.map(u => ({ unit: u, anchorId, anchorOccId, step: 0 }))
        const planned = new Set(units.map(u => u.ids.join('|')))
        for (const u of units) for (const id of u.ids) get().addElementToDiagram(id, diagramId)
        if (given) {
          const d1 = get().diagrams.find(d => d.id === diagramId)
          for (const p of plans) p.anchorOccId = (d1.occurrences ?? []).find(o => o.schemaElementId === p.anchorId && !o.refModeOwnerOccId)?.id ?? null
        }
        if (oneMoreStep) {
          const d1 = get().diagrams.find(d => d.id === diagramId)
          const more = []
          for (const u of units) for (const far of u.far) {
            if (shownBefore.has(far)) continue
            const farOcc = (d1.occurrences ?? []).find(o => o.schemaElementId === far && !o.refModeOwnerOccId)
            for (const v of neighbourUnits(get(), d1, far)) {
              const k = v.ids.join('|')
              if (!v.defaultOn || v.shown || planned.has(k)) continue
              planned.add(k)
              more.push({ unit: v, anchorId: far, anchorOccId: farOcc?.id ?? null, step: 1 })
            }
          }
          for (const p of more) for (const id of p.unit.ids) get().addElementToDiagram(id, diagramId)
          plans.push(...more)
        }
        if (!erd) {
          const touched = new Set(plans.flatMap(p => [...p.unit.ids, ...p.unit.far]).filter(x => !shownBefore.has(x)))
          set(st => ({ diagrams: st.diagrams.map(d => (d.id === diagramId ? withTouchedConstraints(st, d, touched) : d)) }))
        }
        const s1 = get()
        const d1 = s1.diagrams.find(d => d.id === diagramId)
        if (erd) {
          const boxes = erdLayout(relationalModel(s1, d1.schemaId), d1)
          const pos = place.erd(boxes, new Set(Object.keys(frozen)), plans)
          if (Object.keys(pos).length) get().setErdPositions(diagramId, pos)
        } else {
          const { occ, cocc, freq } = place.orm(s1, diagramId, beforeOccIds, plans, beforeCoccIds)
          set(st => ({
            diagrams: st.diagrams.map(d => d.id !== diagramId ? d : {
              ...d,
              occurrences: d.occurrences.map(o => occ[o.id] ? { ...o, ...occ[o.id] } : o),
              constraintOccurrences: (d.constraintOccurrences ?? []).map(o => cocc[o.id] ? { ...o, ...cocc[o.id] } : o),
            }),
            facts: Object.keys(freq).length ? st.facts.map(f => freq[f.id] ? { ...f, internalFrequency: freq[f.id] } : f) : st.facts,
          }))
        }
        const added = [...new Set(plans.flatMap(p => p.unit.ids))].filter(id => !shownBefore.has(id))
        set({ multiSelectedIds: added, selectedId: null, selectedKind: null, selectedRole: null, selectedUniqueness: null, isDirty: true })
      } finally {
        set(st => ({ historyBatch: Math.max(0, (st.historyBatch ?? 1) - 1) }))
      }
    },

    // The selected elements in a new diagram of the same schema, where they
    // are on this one (top-down splitting of a large diagram). With move, they
    // leave this diagram, except object types that a fact type left here still
    // needs (the boundary is shown on both). One undo step.
    selectionToNewDiagram(move = false) {
      const s0 = get()
      const src = s0.diagrams.find(d => d.id === s0.activeDiagramId)
      if (!src || src.mappingId) return null
      const known = (id) => s0.objectTypes.some(o => o.id === id) || s0.facts.some(f => f.id === id)
        || s0.subtypes.some(x => x.id === id) || s0.constraints.some(c => c.id === id)
      const ids = [...new Set([...s0.multiSelectedIds, ...(s0.selectedId ? [s0.selectedId] : [])])].filter(known)
      if (!ids.length) return null
      const used = new Set(s0.diagrams.filter(d => d.schemaId === src.schemaId).map(d => d.name))
      const name = makeUniqueName(`${src.name} part `, used)
      const { pan, zoom } = s0
      const erd = isErdDiagram(s0, src)
      const srcBoxes = erd ? erdLayout(relationalModel(s0, src.schemaId), src) : null
      set(st => ({ historyBatch: (st.historyBatch ?? 0) + 1 }))
      let id
      try {
        id = get().addDiagram(name)
        for (const x of ids) if (!s0.constraints.some(c => c.id === x)) get().addElementToDiagram(x, id)
        if (move) {
          const s1 = get()
          const sel = new Set(ids)
          const shownHere = new Set((src.occurrences ?? []).map(o => o.schemaElementId))
          const units = diagramUnits(s1, src)
          // An object type stays when a fact type it plays stays on the source.
          const staysFor = (otId) => s1.facts.some(f => shownHere.has(f.id) && !sel.has(f.id) && !(units && sel.has(units.tableOf.get(f.id)))
            && f.roles.some(r => r.objectTypeId === otId) && !f.roles.every(r => sel.has(r.objectTypeId)))
          const removable = ids.filter(x => !s1.objectTypes.some(o => o.id === x) || units || !staysFor(x))
          get().removeMultiSelectionFromDiagram(src.id, removable)
          // What the removal took off with them (a fact type an objectified
          // type plays, say) goes along, so nothing drops off both diagrams.
          const s2 = get()
          const left = new Set((s2.diagrams.find(d => d.id === src.id)?.occurrences ?? []).map(o => o.schemaElementId))
          const there = new Set((s2.diagrams.find(d => d.id === id)?.occurrences ?? []).map(o => o.schemaElementId))
          for (const x of shownHere) if (!left.has(x) && !there.has(x) && s2.facts.some(f => f.id === x)) get().addElementToDiagram(x, id)
        }
        // The external constraints among the elements, as on the source.
        if (!erd) set(st => ({ diagrams: st.diagrams.map(d => (d.id === id
          ? withTouchedConstraints(st, d, new Set((d.occurrences ?? []).map(o => o.schemaElementId))) : d)) }))
        set(st => ({
          diagrams: st.diagrams.map(d => {
            if (d.id !== id) return d
            // Each new occurrence where its element's (first) occurrence is on the source.
            const map = new Map()
            const taken = new Set()
            const occurrences = d.occurrences.map(o => {
              const owner = o.refModeOwnerOccId ? d.occurrences.find(x => x.id === o.refModeOwnerOccId)?.schemaElementId : null
              const from = (src.occurrences ?? []).find(x => !taken.has(x.id) && x.schemaElementId === o.schemaElementId
                && (owner ? src.occurrences.find(y => y.id === x.refModeOwnerOccId)?.schemaElementId === owner : !x.refModeOwnerOccId))
              if (!from) return o
              taken.add(from.id)
              map.set(from.id, o.id)
              const { id: _i, schemaElementId: _s, refModeOwnerOccId: _r, roleOccurrenceMap: _m, ...rest } = from
              return { ...o, ...rest }
            })
            const constraintOccurrences = (d.constraintOccurrences ?? []).map(co => {
              const from = (src.constraintOccurrences ?? []).find(x => x.schemaConstraintId === co.schemaConstraintId)
              if (from) return { ...co, x: from.x, y: from.y }
              // Not on the source: between the facts it is about.
              const c = st.constraints.find(x => x.id === co.schemaConstraintId)
              const fids = new Set([...(c?.sequences ?? []), ...(c?.roleSequences ?? [])].flat().map(m => m?.factId?.split('_il_')[0]).filter(Boolean))
              const pts = occurrences.filter(o => fids.has(o.schemaElementId) && !o.refModeOwnerOccId)
              return pts.length ? { ...co, x: Math.round(pts.reduce((a, o) => a + o.x, 0) / pts.length), y: Math.round(pts.reduce((a, o) => a + o.y, 0) / pts.length) - 30 } : co
            })
            const expandedRefModeOccs = [...new Set([...(d.expandedRefModeOccs ?? []),
              ...(src.expandedRefModeOccs ?? []).map(o => map.get(o)).filter(Boolean)])]
            const erdPositions = srcBoxes ? Object.fromEntries([...srcBoxes].filter(([t]) => inDiag(d, t)).map(([t, b]) => [t, { x: b.x, y: b.y }])) : d.erdPositions
            return { ...d, occurrences, constraintOccurrences, expandedRefModeOccs, ...(erdPositions ? { erdPositions } : {}) }
          }),
        }))
        set({ pan, zoom, multiSelectedIds: ids, selectedId: null, selectedKind: null })
      } finally {
        set(st => ({ historyBatch: Math.max(0, (st.historyBatch ?? 1) - 1) }))
      }
      return id
    },

    // A new diagram of the element's schema with just that element, centred,
    // and the Add neighbours… picker open on it.
    newDiagramFrom(elementId) {
      const s0 = get()
      const el = s0.objectTypes.find(o => o.id === elementId) ?? s0.facts.find(f => f.id === elementId)
      const active = s0.diagrams.find(d => d.id === s0.activeDiagramId)
      if (!el || !active || (el.schemaId && active.schemaId && el.schemaId !== active.schemaId)) return
      const base = (el.objectified ? el.objectifiedName : el.name) || 'Diagram'
      const used = new Set(s0.diagrams.filter(d => d.schemaId === active.schemaId).map(d => d.name))
      const name = used.has(base) ? makeUniqueName(`${base} `, used) : base
      set(st => ({ historyBatch: (st.historyBatch ?? 0) + 1 }))
      let id
      try {
        // A new diagram from a mapping diagram would draw the mapping too.
        if (active.mappingId) {
          const back = s0.diagrams.find(d => !d.mappingId && d.schemaId === el.schemaId)
          if (back) get().setActiveDiagram(back.id)
        }
        id = get().addDiagram(name)
        get().addElementToDiagram(elementId, id)
        set({ multiSelectedIds: [], selectedId: elementId, selectedKind: el.kind === 'fact' ? 'fact' : el.kind })
      } finally {
        set(st => ({ historyBatch: Math.max(0, (st.historyBatch ?? 1) - 1) }))
      }
      const s1 = get()
      const d = s1.diagrams.find(x => x.id === id)
      const occ = (d?.occurrences ?? []).find(o => o.schemaElementId === elementId && !o.refModeOwnerOccId)
      // Centred at once (no animation), so the picker opens next to it.
      let wx = occ?.x ?? 0, wy = occ?.y ?? 0
      const parts = erdPartsOfDiagram(s1, d)
      const at = parts.length ? erdTargetOf(s1, parts, elementId) : null
      if (at) { wx = at.x + at.w / 2; wy = at.y + at.h / 2 }
      const svg = typeof document !== 'undefined' ? document.getElementById('orm2-canvas-svg') : null
      const rect = svg?.getBoundingClientRect()
      if (rect) set({ zoom: 1, pan: { x: rect.width * 0.4 - wx, y: rect.height / 2 - wy } })
      set({ neighbourPicker: { diagramId: id, elementId, occurrenceId: occ?.id ?? null } })
      return id
    },

    addElementToDiagram(elementId, diagramId) {
      // A diagram shows only elements of its own schema.
      {
        const s = get()
        const target = s.diagrams.find(d => d.id === diagramId)
        const baseId = elementId.includes('_il_') ? elementId.split('_il_')[0] : elementId
        const el = s.objectTypes.find(o => o.id === baseId) ?? s.facts.find(f => f.id === baseId)
          ?? s.subtypes.find(st => st.id === baseId) ?? s.constraints.find(c => c.id === baseId)
        // A mapping diagram shows both schemas of its mapping.
        const m = mappingOfDiagram(s, target)
        const allowed = m ? [m.sourceSchemaId, m.targetSchemaId] : [target?.schemaId]
        if (target && el && el.schemaId && target.schemaId && !allowed.includes(el.schemaId)) return
      }
      set(s => {
        // BFS to collect all OT/fact IDs that must accompany elementId in the diagram.
        // Also tracks implied links that need to be shown.
        //
        // • OT / fact           → add it; for facts also queue all role-player OTs (principle 3)
        // • Subtype             → queue both endpoint OTs (subtype itself is implicit in diagrams)
        // • Constraint          → queue all referenced facts (including implied link parent facts),
        //                         subtype endpoints, target OT; constraint itself added by syncConstraints
        // • Implied link factId → parse "factId_il_roleIndex", queue parent fact, mark implied link shown
        // A relational schema's diagram shows tables whole (tableUnits.js).
        const units = diagramUnits(s, s.diagrams.find(d => d.id === diagramId))
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
            for (const p of tableCompanions(units, id)) if (!visited.has(p)) queue.push(p)
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
            // A value type whose only occurrences belong to collapsed reference
            // modes (hidden) gets one of its own, so the fact types added with
            // it don't point at nothing.
            const occsOf = (nd.occurrences ?? []).filter(o => o.schemaElementId === id)
            const expanded = new Set(nd.expandedRefModeOccs ?? [])
            if (occsOf.length && el.kind === 'value' && occsOf.every(o => o.refModeOwnerOccId != null && !expanded.has(o.refModeOwnerOccId)))
              nd = { ...nd, occurrences: [...nd.occurrences, mkOcc(id, el.x ?? 0, el.y ?? 0)] }
            else nd = addOccIfAbsent(nd, id, el.x ?? 0, el.y ?? 0)
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
        let syncedDiagrams = syncConstraints(updatedDiagrams, s.constraints, s.subtypes, s.facts)
        // A table comes with its keys and CHECKs, and foreign keys between shown tables.
        if (units) syncedDiagrams = syncedDiagrams.map(d => (d.id === diagramId ? withTableConstraints(s, d) : d))
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
      get().expandBlockedRefModes()
    },

    // Tables shown in part on diagrams of relational schemas completed, e.g.
    // after a transformation gave a table new columns (tableUnits.js).
    completeTableDiagrams() {
      set(s => {
        const c = completeTables(s, s.diagrams)
        return c === s.diagrams ? {} : { diagrams: syncConstraints(c, s.constraints, s.subtypes, s.facts) }
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
        // In a relational schema's diagram a table goes whole (tableUnits.js).
        const diag = s.diagrams.find(d => d.id === diagramId)
        const units = diagramUnits(s, diag)
        const toRemove = units ? tableRemoval(s, diag, units, [elementId]) : computeCascadeRemove(elementId, s.facts)

        const updatedDiagrams = s.diagrams.map(d => {
          if (d.id !== diagramId) return d
          // Occurrences drawn as part of a removed one (a collapsed reference
          // mode's value type) go with it.
          const goneOccIds = new Set((d.occurrences ?? []).filter(o => toRemove.has(o.schemaElementId)).map(o => o.id))
          const remainingOccs = (d.occurrences ?? []).filter(o => !toRemove.has(o.schemaElementId) && !goneOccIds.has(o.refModeOwnerOccId))
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
          const units = diagramUnits(s, diag)
          const toRemove = units ? tableRemoval(s, diag, units, [schemaElementId]) : computeCascadeRemove(schemaElementId, s.facts)
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
        const diag = s.diagrams.find(d => d.id === diagramId)
        const units = diagramUnits(s, diag)
        const elementIds = multiSelectedIds.filter(id => !constraintIdSetLocal.has(id) && !subtypeIdSetLocal.has(id))
        if (units) tableRemoval(s, diag, units, elementIds).forEach(cid => cascaded.add(cid))
        else for (const id of elementIds) computeCascadeRemove(id, s.facts).forEach(cid => cascaded.add(cid))

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
      const { selectedId, selectedKind, selectedOccurrenceId, selectedUniqueness,
              multiSelectedIds, activeDiagramId } = get()
      if (!activeDiagramId) return

      if (multiSelectedIds.length > 0) {
        get().removeMultiSelectionFromDiagram(activeDiagramId)
        return
      }

      // A selected internal uniqueness bar also carries its fact as selectedId,
      // so handle it first: delete only the constraint, never the fact occurrence.
      // Bars being edited and bars on implicit link facts are left to App.jsx.
      if (selectedUniqueness) {
        if (selectedUniqueness.implied || selectedUniqueness.roleIndex != null) return
        if (get().uniquenessConstruction) return
        const fact = get().facts.find(f => f.id === selectedUniqueness.factId)
        const roles = fact?.uniqueness[selectedUniqueness.uIndex]?.roles
        if (roles) get().removeUniqueness(fact.id, roles)
        get().clearSelection()
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
      // selectedRole: no-op (sub-element selection, not a whole occurrence)
    },

    getSharedIds() {
      const { diagrams } = get()
      const counts = {}
      diagrams.forEach(d => (d.occurrences ?? []).forEach(o => { counts[o.schemaElementId] = (counts[o.schemaElementId] || 0) + 1 }))
      return new Set(Object.keys(counts).filter(id => counts[id] > 1))
    },
  }
}
