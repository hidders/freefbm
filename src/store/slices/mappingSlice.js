// Schema mappings between two schemas of the file (mapping/mapping.js).
import { mkMapping, mkRule, ruleElements } from '../../mapping/mapping.js'
import { withRunApplied } from '../../mapping/runMapping.js'
import { mkDiagram } from '../storeHelpers'
import { findRefMode } from '../../utils/refMode.js'

// Gap between the source and the target side of a new mapping diagram.
const SIDE_GAP = 260

// Where an element (or a constraint) sits in its own schema's diagrams: the
// first occurrence in a diagram of that schema that isn't a mapping diagram.
function homePos(s, schemaId, elementId, isConstraint) {
  for (const d of s.diagrams) {
    if (d.schemaId !== schemaId || d.mappingId) continue
    const o = isConstraint
      ? (d.constraintOccurrences ?? []).find(c => c.schemaConstraintId === elementId)
      : (d.occurrences ?? []).find(c => c.schemaElementId === elementId)
    if (o) return { x: o.x, y: o.y }
  }
  return null
}

export const createMappingSlice = (set, get) => {
  const mapMappings = (fn) => set(s => ({ mappings: fn(s.mappings ?? []), isDirty: true }))
  const mapRules = (mappingId, fn) =>
    mapMappings(ms => ms.map(m => (m.id === mappingId ? { ...m, rules: fn(m.rules) } : m)))
  return {
    // Adds a mapping from one schema to another; returns its id.
    addMapping(sourceSchemaId, targetSchemaId, name) {
      const used = new Set((get().mappings ?? []).map(m => m.name))
      let base = name ?? 'Mapping', unique = base
      for (let i = 2; used.has(unique); i++) unique = `${base} ${i}`
      const m = mkMapping(unique, sourceSchemaId, targetSchemaId)
      mapMappings(ms => [...ms, m])
      return m.id
    },
    updateMapping(id, patch) {
      mapMappings(ms => ms.map(m => (m.id === id ? { ...m, ...patch } : m)))
    },
    deleteMapping(id) {
      // Its diagrams go too; leave them first if one is active.
      const s = get()
      const active = s.diagrams.find(d => d.id === s.activeDiagramId)
      set(st => ({ historyBatch: (st.historyBatch ?? 0) + 1 }))
      try {
        if (active?.mappingId === id) {
          const m = s.mappings?.find(x => x.id === id)
          const back = s.diagrams.find(d => !d.mappingId && d.schemaId === m?.sourceSchemaId) ?? s.diagrams.find(d => !d.mappingId)
          if (back) get().setActiveDiagram(back.id)
        }
        set(st => ({
          diagrams: st.diagrams.filter(d => d.mappingId !== id),
          mappings: (st.mappings ?? []).filter(m => m.id !== id),
          isDirty: true,
        }))
      } finally {
        set(st => ({ historyBatch: Math.max(0, (st.historyBatch ?? 1) - 1) }))
      }
      if (get().mappingRuleEditor?.mappingId === id) set({ mappingRuleEditor: null })
    },
    // Adds an empty rule and opens it in the editor; returns its id.
    addMappingRule(mappingId) {
      const m = get().mappings?.find(x => x.id === mappingId)
      if (!m) return null
      const r = mkRule(`Rule ${m.rules.length + 1}`)
      mapRules(mappingId, rs => [...rs, r])
      set({ mappingRuleEditor: { mappingId, ruleId: r.id } })
      return r.id
    },
    // patch: fields of the rule, or a function of the rule giving the new rule.
    updateMappingRule(mappingId, ruleId, patch) {
      mapRules(mappingId, rs => rs.map(r => (r.id === ruleId ? (typeof patch === 'function' ? patch(r) : { ...r, ...patch }) : r)))
    },
    deleteMappingRule(mappingId, ruleId) {
      mapRules(mappingId, rs => rs.filter(r => r.id !== ruleId))
      const ed = get().mappingRuleEditor
      if (ed?.mappingId === mappingId && ed.ruleId === ruleId) set({ mappingRuleEditor: null })
    },
    moveMappingRule(mappingId, ruleId, delta) {
      mapRules(mappingId, rs => {
        const i = rs.findIndex(r => r.id === ruleId), j = i + delta
        if (i < 0 || j < 0 || j >= rs.length) return rs
        const out = [...rs]; [out[i], out[j]] = [out[j], out[i]]
        return out
      })
    },
    // ── Mapping diagrams ────────────────────────────────────────────────────
    // A mapping diagram (diagram.mappingId) shows elements of the mapping's
    // source and target schema side by side, with each rule drawn as a node
    // linked to the elements its two patterns name (MappingLayer.jsx).

    // Switches to the mapping's first diagram, making one with the elements its
    // rules name if it has none yet. Returns the diagram id.
    openMappingDiagram(mappingId) {
      const s = get()
      const m = s.mappings?.find(x => x.id === mappingId)
      if (!m) return null
      const existing = s.diagrams.find(d => d.mappingId === mappingId)
      if (existing) { get().setActiveDiagram(existing.id); return existing.id }
      const d = { ...mkDiagram(m.name, m.sourceSchemaId), mappingId, mappingRulePositions: {} }
      set(st => ({ historyBatch: (st.historyBatch ?? 0) + 1 }))
      try {
        set(st => ({ diagrams: [...st.diagrams, d], isDirty: true }))
        get().setActiveDiagram(d.id)
        get().addMappingRuleElements(d.id)
        set({ multiSelectedIds: [], multiSelectedOccurrenceIds: [] })
      } finally {
        set(st => ({ historyBatch: Math.max(0, (st.historyBatch ?? 1) - 1) }))
      }
      const svg = typeof document !== 'undefined' ? document.querySelector('.canvas-bg')?.closest('svg') : null
      const r = svg?.getBoundingClientRect()
      get().fitToContent(r?.width || 1200, r?.height || 700)
      return d.id
    },

    // Adds to a mapping diagram the elements its rules name that it doesn't
    // show yet (with the role players and constraints that come with them),
    // as one undo step. Each element goes where it is in its own schema's
    // diagram, the target side shifted to the right of the source side.
    // Returns the number of elements added.
    addMappingRuleElements(diagramId) {
      const s0 = get()
      const diag = s0.diagrams.find(d => d.id === diagramId)
      const m = s0.mappings?.find(x => x.id === diag?.mappingId)
      if (!diag || !m) return 0
      const schemaOf = new Map()
      for (const k of ['objectTypes', 'facts', 'constraints']) for (const x of s0[k]) schemaOf.set(x.id, x.schemaId)
      const wanted = { source: new Set(), target: new Set() }
      for (const r of m.rules) {
        const els = ruleElements(r)
        for (const side of ['source', 'target']) {
          const e = els[side]
          for (const id of [...e.typeIds, ...e.factIds, ...e.tableIds]) wanted[side].add(id)
          // Columns of a table, except the one its reference mode stands for.
          for (const tableId of e.tableIds) {
            const t = s0.objectTypes.find(o => o.id === tableId)
            const rm = t ? findRefMode(t, s0.facts, s0.objectTypes) : null
            for (const colId of e.columnFactIds) {
              const f = s0.facts.find(x => x.id === colId)
              if (f && f.id !== rm?.factId && f.roles.some(r => r.objectTypeId === tableId)) wanted[side].add(colId)
            }
          }
        }
      }
      // A reference-mode fact type is drawn as its entity's "(.ref)" shorthand.
      for (const side of ['source', 'target']) for (const id of [...wanted[side]]) {
        const f = s0.facts.find(x => x.id === id)
        if (!f) continue
        for (const r of f.roles) {
          const e = s0.objectTypes.find(o => o.id === r.objectTypeId && o.kind === 'entity')
          if (e && findRefMode(e, s0.facts, s0.objectTypes)?.factId === id) { wanted[side].delete(id); wanted[side].add(e.id) }
        }
      }
      const shown = new Set((diag.occurrences ?? []).map(o => o.schemaElementId))
      const toAdd = [...wanted.source, ...wanted.target].filter(id => !shown.has(id) && schemaOf.has(id))
      if (!toAdd.length) return 0

      const beforeOccs = new Set((diag.occurrences ?? []).map(o => o.id))
      const beforeCOccs = new Set((diag.constraintOccurrences ?? []).map(o => o.id))
      set(st => ({ historyBatch: (st.historyBatch ?? 0) + 1 }))
      try {
        for (const id of toAdd) get().addElementToDiagram(id, diagramId)
        const s = get()
        const d = s.diagrams.find(x => x.id === diagramId)
        const sideOf = (sid) => (sid === m.sourceSchemaId ? 'source' : sid === m.targetSchemaId ? 'target' : null)
        // Offset per side: kept from an element already placed on that side,
        // else the source side stays put and the target side goes to its right.
        const offset = {}
        for (const o of d.occurrences ?? []) {
          if (!beforeOccs.has(o.id)) continue
          const side = sideOf(schemaOf.get(o.schemaElementId))
          const home = side && homePos(s, schemaOf.get(o.schemaElementId), o.schemaElementId, false)
          if (side && home && !offset[side]) offset[side] = { dx: o.x - home.x, dy: o.y - home.y }
        }
        const fresh = (d.occurrences ?? []).filter(o => !beforeOccs.has(o.id))
        const homes = new Map(fresh.map(o => [o.id, homePos(s, schemaOf.get(o.schemaElementId), o.schemaElementId, false) ?? { x: o.x, y: o.y }]))
        const box = (side, useHome) => {
          let minX = Infinity, maxX = -Infinity, minY = Infinity
          for (const o of d.occurrences ?? []) {
            if (sideOf(schemaOf.get(o.schemaElementId)) !== side) continue
            const p = beforeOccs.has(o.id) ? o : (useHome ? homes.get(o.id) : null)
            if (!p) continue
            minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x); minY = Math.min(minY, p.y)
          }
          return minX === Infinity ? null : { minX, maxX, minY }
        }
        if (!offset.source) offset.source = { dx: 0, dy: 0 }
        if (!offset.target) {
          const sb = box('source', true), tb = box('target', true)
          offset.target = sb && tb && m.sourceSchemaId !== m.targetSchemaId
            ? { dx: sb.maxX + offset.source.dx + SIDE_GAP - tb.minX, dy: sb.minY + offset.source.dy - tb.minY }
            : { dx: 0, dy: 0 }
        }
        const place = (o, home) => {
          const side = sideOf(schemaOf.get(o.schemaElementId ?? o.schemaConstraintId)) ?? 'source'
          return { ...o, x: Math.round(home.x + offset[side].dx), y: Math.round(home.y + offset[side].dy) }
        }
        set(st => ({
          diagrams: st.diagrams.map(x => x.id !== diagramId ? x : {
            ...x,
            occurrences: (x.occurrences ?? []).map(o => (beforeOccs.has(o.id) ? o : place(o, homes.get(o.id) ?? o))),
            constraintOccurrences: (x.constraintOccurrences ?? []).map(o => {
              if (beforeCOccs.has(o.id)) return o
              const home = homePos(st, schemaOf.get(o.schemaConstraintId), o.schemaConstraintId, true)
              return home ? place(o, home) : o
            }),
          }),
          isDirty: true,
        }))
      } finally {
        set(st => ({ historyBatch: Math.max(0, (st.historyBatch ?? 1) - 1) }))
      }
      return toAdd.length
    },

    // Where a rule's node sits in a mapping diagram; null puts it back between
    // the elements it links.
    setMappingRulePosition(diagramId, ruleId, pos) {
      set(st => ({
        diagrams: st.diagrams.map(d => {
          if (d.id !== diagramId) return d
          const next = { ...(d.mappingRulePositions ?? {}) }
          if (pos) next[ruleId] = { x: Math.round(pos.x), y: Math.round(pos.y) }
          else delete next[ruleId]
          return { ...d, mappingRulePositions: next }
        }),
        isDirty: true,
      }))
    },

    // Replaces the population of one schema with what running a mapping built
    // (runMapping.js), as one undo step.
    applyMappingRun(run) {
      if (!run?.schemaId) return
      set(s => ({ ...withRunApplied(s, run), isDirty: true }))
    },

    openMappingRuleEditor(mappingId, ruleId) { set({ mappingRuleEditor: { mappingId, ruleId } }) },
    closeMappingRuleEditor() { set({ mappingRuleEditor: null }) },
  }
}
