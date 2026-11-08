// Schema mappings between two schemas of the file (mapping/mapping.js).
import { mkMapping, mkRule, ruleElements } from '../../mapping/mapping.js'
import { withRunApplied, runMapping } from '../../mapping/runMapping.js'
import { foldChanges, addConstraint, strip, planFold } from '../../mapping/fold.js'
import { mkDiagram, mkConstraint, mkConstraintOcc } from '../storeHelpers'
import { formulaElements } from '../../logic/formulaConstraint.js'
import { graphicalFields, GRAPHICAL_NAME } from '../../mapping/recognise.js'
import { findRefMode } from '../../utils/refMode.js'
import { mkTableRule, tableRulesOf, compileTableRulesInto, newColumn, withPrimaryKey, bodyFrontier, withoutRuleElements } from '../../relational/derivedTables.js'
import { sideContext, treeToSide, expandSide, checkRule } from '../../mapping/mapping.js'
import { mkEntity } from '../storeHelpers'
import { cloneSchema, identityMapping } from '../../mapping/refactor.js'
import { compactMapping } from '../../mapping/sameModel.js'
import { entriesOf, accountingSteps } from '../../mapping/accounting.js'
import { proposeTranslation } from '../../mapping/translate.js'
import { makeContext } from '../../logic/constraintFormulas.js'
import { formulaToString } from '../../logic/renderFormula.js'
import { transformationById } from '../../mapping/transformations.js'
import { mkLock } from '../../mapping/pairLock.js'
import { withSimple } from '../../mapping/carry.js'
import { withTableConstraints } from '../../relational/tableUnits.js'
import { relationalView, rmLabel } from '../../relational/relationalView.js'
import { uid, mappingOfDiagram, isViewMapping, makeUniqueName, diagramRuleIds } from '../storeHelpers'
import { numberInvented } from '../../mapping/exchanges.js'
import { ruleWantedElements, compactRulePlacement } from '../../mapping/diagramRules.js'
import { erdPartsOfDiagram } from '../../relational/erdBoxes.js'

// The constraints of the old version (schemaId) about the given elements
// (all of them when elementIds is null) that the mapping m loses, each added
// to the new version as its translation when the translation keeps it.
// Returns report lines. Also used by Generate tables (schemaSlice), where a
// constraint the tables have no form for becomes an assertion.
export function carryLost(get, m, schemaId, elementIds, { to = 'the new version' } = {}) {
  const keys = new Set(entriesOf(get(), schemaId).filter(e => !e.possible && (!elementIds || elementIds.has(e.elementId))).map(e => e.key))
  if (!keys.size) return []
  const gen = accountingSteps(get(), m, { onlyKeys: keys })
  let r
  do r = gen.next(); while (!r.done)
  const out = []
  let ctx = null
  for (const x of r.value.sides.source.filter(e => e.status === 'lost')) {
    const kind = x.entry?.kind ?? 'constraint'
    let what = x.label || (x.entry?.subject ? `${kind} · ${x.entry.subject}` : kind)
    if (!x.label && !x.entry?.subject && x.entry?.formula) {
      try { what = `${kind} ${formulaToString(x.entry.formula, (ctx ??= makeContext(get())))}` } catch { /* the kind alone */ }
    }
    const p = proposeTranslation(get(), m, x, 'source')
    if (p.error || p.errors?.length || !['native', 'implied'].includes(p.status)) { out.push(`Kept by nothing in ${to}: ${what}${p.error ? ` (${p.error})` : ''}; the Equivalence report says more`); continue }
    get().addCarriedConstraint(m.targetSchemaId, { rule: p.rule, deontic: p.deontic, graphical: p.graphical })
    out.push(`Added ${p.graphical ? GRAPHICAL_NAME[p.graphical.constraintType] : 'a formula constraint'} to ${to} for ${what}`)
  }
  return out
}

// Whether any type or fact type of a schema has a population.
function hasPopulation(st, schemaId) {
  const ids = new Set([...st.objectTypes, ...st.facts].filter(x => x.schemaId === schemaId).map(x => x.id))
  return Object.entries(st.populations ?? {}).some(([k, v]) => ids.has(k) && v?.length)
    || Object.entries(st.factPopulations ?? {}).some(([k, v]) => ids.has(k) && v?.length)
}

const ADVANCED_KEY = 'freefbm.advancedMode'
const readAdvanced = () => { try { return localStorage.getItem(ADVANCED_KEY) === '1' } catch { return false } }

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
    // Basic or Advanced mode (the switch at the top of the tool panel), kept
    // per user. In Basic mode mapping rules come only from Generate, Guess
    // and Fold, and are shown read-only.
    advancedMode: readAdvanced(),
    setAdvancedMode(v) {
      try { localStorage.setItem(ADVANCED_KEY, v ? '1' : '0') } catch { /* not kept */ }
      set(st => ({ advancedMode: !!v, ...(v || st.mappingRuleEditor?.tableId ? {} : { mappingRuleEditor: null }) }))
    },
    // The rule the Mappings tab shows highlighted (Basic mode's stand-in for
    // the rule editor).
    mappingRuleFocus: null,
    // Adds a mapping from one schema to another; returns its id.
    addMapping(sourceSchemaId, targetSchemaId, name) {
      const used = new Set((get().mappings ?? []).map(m => m.name))
      let base = name ?? 'Mapping', unique = base
      for (let i = 2; used.has(unique); i++) unique = `${base} ${i}`
      const m = mkMapping(unique, sourceSchemaId, targetSchemaId)
      mapMappings(ms => [...ms, m])
      return m.id
    },
    // Constraints only (mapping/pairLock.js): on locks both schemas of the
    // mapping to new constraints, recording what they have now; off unlocks.
    lockMapping(id, on) {
      const s = get()
      const m = s.mappings.find(x => x.id === id)
      if (!m) return
      mapMappings(ms => ms.map(x => {
        if (x.id !== id) return x
        if (on) return { ...x, lock: mkLock(s, m) }
        const { lock: _off, ...rest } = x
        return rest
      }))
    },
    // A plain constraint carried across a locked mapping (mapping/carry.js):
    // a mandatory role, a single-role uniqueness or a foreign key (a subset
    // constraint between two columns), as one undo step. Returns its id.
    addSimpleConstraint(schemaId, simple) {
      const id = uid()
      set(st => {
        const r = withSimple(st, simple, id)
        const out = { facts: r.state.facts, constraints: r.state.constraints, isDirty: true }
        if (simple.kind === 'fk')
          out.diagrams = st.diagrams.map(d => (d.schemaId === schemaId && !d.mappingId ? withTableConstraints(r.state, d) : d))
        return out
      })
      return id
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
      // A view's diagram too (mapping/views.js): diagram.mappingId is the view's id.
      const m = s.mappings?.find(x => x.id === mappingId) ?? s.views?.find(x => x.id === mappingId)
      if (!m) return null
      const existing = s.diagrams.find(d => d.mappingId === mappingId)
      if (existing) { get().setActiveDiagram(existing.id); return existing.id }
      const d = { ...mkDiagram(m.name, m.sourceSchemaId), mappingId, mappingRuleIds: m.rules.map(r => r.id), mappingRulePositions: {} }
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
    addMappingRuleElements(diagramId, ruleIds = null) {
      const s0 = get()
      const diag = s0.diagrams.find(d => d.id === diagramId)
      const m = mappingOfDiagram(s0, diag)
      if (!diag || !m) return 0
      const schemaOf = new Map()
      for (const k of ['objectTypes', 'facts', 'constraints']) for (const x of s0[k]) schemaOf.set(x.id, x.schemaId)
      const on = diagramRuleIds(diag, m)
      const rules = m.rules.filter(r => (ruleIds ? ruleIds.includes(r.id) : on.has(r.id)))
      const wanted = ruleWantedElements(s0, m, rules)
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

    // Which rules a mapping diagram draws (diagram.mappingRuleIds; none
    // means all of them). Showing rules adds the elements they name;
    // hiding them takes off the elements no rule left on the diagram needs.
    // Each is one undo step.
    showMappingRules(diagramId, ruleIds) {
      const s0 = get()
      const diag = s0.diagrams.find(d => d.id === diagramId)
      const m = mappingOfDiagram(s0, diag)
      if (!m || !ruleIds.length) return
      const on = diagramRuleIds(diag, m)
      const next = m.rules.map(r => r.id).filter(id => on.has(id) || ruleIds.includes(id))
      set(st => ({ historyBatch: (st.historyBatch ?? 0) + 1 }))
      try {
        set(st => ({ diagrams: st.diagrams.map(d => (d.id === diagramId ? { ...d, mappingRuleIds: next } : d)), isDirty: true }))
        for (const id of ruleIds) if (!on.has(id)) get().placeMappingRule(diagramId, id)
      } finally {
        set(st => ({ historyBatch: Math.max(0, (st.historyBatch ?? 1) - 1) }))
      }
    },
    // Adds the elements of one rule that the diagram doesn't show yet, close
    // together near where the rule's node goes (diagramRules.js
    // compactRulePlacement), and puts the node there.
    placeMappingRule(diagramId, ruleId) {
      const s0 = get()
      const diag0 = s0.diagrams.find(d => d.id === diagramId)
      const m = mappingOfDiagram(s0, diag0)
      const rule = m?.rules.find(r => r.id === ruleId)
      if (!rule) return
      const beforeIds = new Set((diag0.occurrences ?? []).map(o => o.id))
      const beforeC = new Set((diag0.constraintOccurrences ?? []).map(o => o.id))
      get().addMappingRuleElements(diagramId, [ruleId])
      const s = get()
      const d = s.diagrams.find(x => x.id === diagramId)
      const occs = d.occurrences ?? []
      const fresh = occs.filter(o => !beforeIds.has(o.id) && !o.refModeOwnerOccId)
      const before = occs.filter(o => beforeIds.has(o.id) && !o.refModeOwnerOccId)
      const schemaOf = new Map()
      for (const k of ['objectTypes', 'facts']) for (const x of s[k]) schemaOf.set(x.id, x.schemaId)
      const sideOf = (id) => (schemaOf.get(id) === m.targetSchemaId && m.targetSchemaId !== m.sourceSchemaId ? 'target' : 'source')
      const w = ruleWantedElements(s, m, [rule])
      // Sides drawn as ERD tables: their boxes (new ones laid out where erdLayout puts them).
      const erd = {}
      const boxesNow = {}
      for (const part of erdPartsOfDiagram(s, d)) {
        const side = part.schemaId === m.targetSchemaId && m.targetSchemaId !== m.sourceSchemaId ? 'target' : 'source'
        const isNewTable = (t) => fresh.some(o => o.schemaElementId === t)
        erd[side] = {
          sizes: new Map([...part.boxes].filter(([t]) => isNewTable(t)).map(([t, b]) => [t, { w: b.w, h: b.h }])),
          before: [...part.boxes].filter(([t]) => !isNewTable(t)).map(([, b]) => b),
        }
        boxesNow[side] = part.boxes
      }
      const { node, at, tables } = compactRulePlacement(s, fresh, before, sideOf, new Set([...w.source, ...w.target]), erd,
        Object.entries(d.mappingRulePositions ?? {}).filter(([id]) => id !== ruleId && diagramRuleIds(d, m).has(id)).map(([, p]) => p))
      const delta = new Map(fresh.map(o => [o.id, at.has(o.id) ? { dx: at.get(o.id).x - o.x, dy: at.get(o.id).y - o.y } : { dx: 0, dy: 0 }]))
      set(st => ({
        diagrams: st.diagrams.map(x => {
          if (x.id !== diagramId) return x
          const occurrences = (x.occurrences ?? []).map(o => {
            const dd = delta.get(o.id) ?? (o.refModeOwnerOccId && !beforeIds.has(o.id) ? delta.get(o.refModeOwnerOccId) : null)
            return dd ? { ...o, x: Math.round(o.x + dd.dx), y: Math.round(o.y + dd.dy) } : o
          })
          // New constraint occurrences above the fact types they are about.
          const constraintOccurrences = (x.constraintOccurrences ?? []).map(co => {
            if (beforeC.has(co.id)) return co
            const c = st.constraints.find(k => k.id === co.schemaConstraintId)
            const fids = new Set([...(c?.sequences ?? []), ...(c?.roleSequences ?? [])].flat().map(mm => mm?.factId?.split('_il_')[0]).filter(Boolean))
            const pts = occurrences.filter(o => fids.has(o.schemaElementId) && !o.refModeOwnerOccId)
            return pts.length ? { ...co, x: Math.round(pts.reduce((a, o) => a + o.x, 0) / pts.length), y: Math.round(pts.reduce((a, o) => a + o.y, 0) / pts.length) - 40 } : co
          })
          // ERD tables: the shown ones stay where they are drawn, the new ones go to their spot.
          const erdPositions = Object.keys(boxesNow).length ? { ...(x.erdPositions ?? {}) } : x.erdPositions
          for (const boxes of Object.values(boxesNow)) for (const [t, b] of boxes) if (!tables.has(t)) erdPositions[t] = { x: Math.round(b.x), y: Math.round(b.y) }
          for (const [t, p] of tables) erdPositions[t] = p
          return { ...x, occurrences, constraintOccurrences, ...(erdPositions ? { erdPositions } : {}),
            mappingRulePositions: { ...(x.mappingRulePositions ?? {}), [ruleId]: node } }
        }),
        isDirty: true,
      }))
    },
    hideMappingRules(diagramId, ruleIds) {
      const s0 = get()
      const diag = s0.diagrams.find(d => d.id === diagramId)
      const m = mappingOfDiagram(s0, diag)
      if (!m || !ruleIds.length) return
      const on = diagramRuleIds(diag, m)
      const next = m.rules.map(r => r.id).filter(id => on.has(id) && !ruleIds.includes(id))
      const gone = ruleWantedElements(s0, m, m.rules.filter(r => ruleIds.includes(r.id)))
      const kept = ruleWantedElements(s0, m, m.rules.filter(r => next.includes(r.id)))
      const needed = new Set([...kept.source, ...kept.target])
      // The role players of the fact types left (a column's table among them).
      for (const id of [...needed]) {
        const f = s0.facts.find(x => x.id === id)
        for (const r of f?.roles ?? []) if (r.objectTypeId) needed.add(r.objectTypeId)
      }
      // The gone rules' elements and the role players of their fact types.
      const goneIds = new Set([...gone.source, ...gone.target])
      for (const id of [...goneIds]) {
        const f = s0.facts.find(x => x.id === id)
        for (const r of f?.roles ?? []) if (r.objectTypeId) goneIds.add(r.objectTypeId)
      }
      const shown = new Set((diag.occurrences ?? []).map(o => o.schemaElementId))
      const drop = [...goneIds].filter(id => shown.has(id) && !needed.has(id))
      const dropSet = new Set(drop)
      // Fact types before object types, so no removal cascades past them.
      const factIds = new Set(s0.facts.map(f => f.id))
      drop.sort((a, b) => (factIds.has(b) ? 1 : 0) - (factIds.has(a) ? 1 : 0))
      set(st => ({ historyBatch: (st.historyBatch ?? 0) + 1 }))
      try {
        set(st => ({ diagrams: st.diagrams.map(d => (d.id === diagramId ? { ...d, mappingRuleIds: next } : d)), isDirty: true }))
        for (const id of drop) {
          const d = get().diagrams.find(x => x.id === diagramId)
          const occs = d?.occurrences ?? []
          if (!occs.some(o => o.schemaElementId === id)) continue
          // An object type that a fact type shown for another reason (added by
          // hand, say) still needs stays; a reference mode drawn with its
          // entity doesn't count.
          if (!factIds.has(id)) {
            const keptFacts = new Set(occs.filter(o => !o.refModeOwnerOccId && !dropSet.has(o.schemaElementId)).map(o => o.schemaElementId))
            if (s0.facts.some(f => keptFacts.has(f.id) && f.roles.some(r => r.objectTypeId === id))) continue
          }
          get().removeElementFromDiagram(id, diagramId)
        }
      } finally {
        set(st => ({ historyBatch: Math.max(0, (st.historyBatch ?? 1) - 1) }))
      }
    },
    // A new diagram of the mapping drawing only the given rules, their
    // elements placed close together (placeMappingRule). One undo step.
    // Returns its id.
    newMappingDiagram(mappingId, ruleIds) {
      const s0 = get()
      const m = s0.mappings?.find(x => x.id === mappingId) ?? s0.views?.find(x => x.id === mappingId)
      if (!m) return null
      const used = new Set(s0.diagrams.map(d => d.name))
      const name = makeUniqueName(`${m.name} part `, used)
      const d = { ...mkDiagram(name, m.sourceSchemaId), mappingId, mappingRuleIds: [], mappingRulePositions: {} }
      set(st => ({ historyBatch: (st.historyBatch ?? 0) + 1 }))
      try {
        set(st => ({ diagrams: [...st.diagrams, d], isDirty: true }))
        get().setActiveDiagram(d.id)
        get().showMappingRules(d.id, ruleIds)
        set({ multiSelectedIds: [], multiSelectedOccurrenceIds: [] })
      } finally {
        set(st => ({ historyBatch: Math.max(0, (st.historyBatch ?? 1) - 1) }))
      }
      const svg = typeof document !== 'undefined' ? document.querySelector('.canvas-bg')?.closest('svg') : null
      const r = svg?.getBoundingClientRect()
      get().fitToContent(r?.width || 1200, r?.height || 700)
      return d.id
    },

    // Several new diagrams of a mapping at once, one per group of rules
    // ([{ name, ruleIds }], from the Suggest diagrams dialog), each drawing
    // its rules with their elements placed close together. One undo step;
    // the first new diagram becomes active. layout(state, diagramId) lays
    // each out afresh (layout/mappingLayout.js, passed in as it reads
    // component geometry). Returns the new diagram ids.
    newMappingDiagrams(mappingId, groups, { layout = null } = {}) {
      const s0 = get()
      const m = s0.mappings?.find(x => x.id === mappingId) ?? s0.views?.find(x => x.id === mappingId)
      if (!m) return []
      const used = new Set(s0.diagrams.map(d => d.name))
      const ids = []
      set(st => ({ historyBatch: (st.historyBatch ?? 0) + 1 }))
      try {
        for (const g of groups) {
          const ruleIds = g.ruleIds.filter(id => m.rules.some(r => r.id === id))
          if (!ruleIds.length) continue
          const want = g.name?.trim()
          let name = want || makeUniqueName(`${m.name} part `, used)
          for (let n = 2; used.has(name); n++) name = `${want} ${n}`
          used.add(name)
          const d = { ...mkDiagram(name, m.sourceSchemaId), mappingId, mappingRuleIds: [], mappingRulePositions: {} }
          set(st => ({ diagrams: [...st.diagrams, d], isDirty: true }))
          // The rules in mapping order, so a table's rules come together.
          const order = m.rules.map(r => r.id).filter(id => ruleIds.includes(id))
          get().showMappingRules(d.id, order)
          if (layout) { const res = layout(get(), d.id); if (res) get().applyDiagramLayout(d.id, res) }
          ids.push(d.id)
        }
        if (ids.length) get().setActiveDiagram(ids[0])
        set({ multiSelectedIds: [], multiSelectedOccurrenceIds: [] })
      } finally {
        set(st => ({ historyBatch: Math.max(0, (st.historyBatch ?? 1) - 1) }))
      }
      const svg = typeof document !== 'undefined' ? document.querySelector('.canvas-bg')?.closest('svg') : null
      const r = svg?.getBoundingClientRect()
      if (ids.length) get().fitToContent(r?.width || 1200, r?.height || 700)
      return ids
    },

    // Rule nodes selected on a mapping diagram (shift-click, rubber band);
    // session only, cleared with the rest of the selection.
    setRuleSelection(ids) { set({ selectedRuleIds: [...new Set(ids)] }) },
    toggleRuleSelected(ruleId) {
      const cur = get().selectedRuleIds ?? []
      set({ selectedRuleIds: cur.includes(ruleId) ? cur.filter(x => x !== ruleId) : [...cur, ruleId] })
    },

    // Splits rules off a mapping diagram: a new diagram of the same mapping
    // drawing those rules, laid out afresh by layout(state, diagramId)
    // (layout/mappingLayout.js, passed in), named "<diagram> part n". With
    // move the rules (and the elements no remaining rule needs) leave the
    // source diagram. One undo step; returns the new diagram's id.
    rulesToNewDiagram(diagramId, ruleIds, { move = false, layout = null } = {}) {
      const s0 = get()
      const src = s0.diagrams.find(d => d.id === diagramId)
      const m = mappingOfDiagram(s0, src)
      if (!m) return null
      const on = diagramRuleIds(src, m)
      const ids = ruleIds.filter(id => on.has(id))
      if (!ids.length) return null
      const name = makeUniqueName(`${src.name} part `, new Set(s0.diagrams.map(d => d.name)))
      let out = null
      set(st => ({ historyBatch: (st.historyBatch ?? 0) + 1 }))
      try {
        if (move) get().hideMappingRules(diagramId, ids)
        if (move) set(st => ({ diagrams: st.diagrams.map(d => {
          if (d.id !== diagramId || !d.mappingRulePositions) return d
          const next = { ...d.mappingRulePositions }
          for (const id of ids) delete next[id]
          return { ...d, mappingRulePositions: next }
        }) }))
        out = get().newMappingDiagrams(m.id, [{ name, ruleIds: ids }], { layout })[0] ?? null
        set({ selectedRuleIds: [] })
      } finally {
        set(st => ({ historyBatch: Math.max(0, (st.historyBatch ?? 1) - 1) }))
      }
      return out
    },

    // Several rule nodes moved at once ({ ruleId: {x, y} }), one undo step.
    setMappingRulePositions(diagramId, positions) {
      set(st => ({
        diagrams: st.diagrams.map(d => {
          if (d.id !== diagramId) return d
          const next = { ...(d.mappingRulePositions ?? {}) }
          for (const [id, p] of Object.entries(positions)) next[id] = { x: Math.round(p.x), y: Math.round(p.y) }
          return { ...d, mappingRulePositions: next }
        }),
        isDirty: true,
      }))
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

    // Fold (workbench step 12, mapping/fold.js): composes the rules of the
    // derived elements of one schema with the mapping, promotes them, removes
    // the fact types they replace and adds the constraints the mapping keeps
    // for them, as one undo step. plan from planFold; fold, remove: the
    // chosen element and fact type ids. Shows a report in the import log.
    // twins: { folded element id → element of the old version to delete } (Refactor).
    // compact: false leaves the mapping's identity rules written out (a
    // transformation compacts it once it is done).
    foldMapping(plan, { fold = null, remove = null, twins = null, compact = true } = {}) {
      const st = get()
      const m = st.mappings?.find(x => x.id === plan.mapping.id)
      if (!m) return null
      const ch = foldChanges(st, plan, { fold, remove })
      const promote = new Set(ch.promote), removeIds = new Set(ch.remove)
      const schemaId = plan.side === 'source' ? m.sourceSchemaId : m.targetSchemaId
      set(s => ({ historyBatch: (s.historyBatch ?? 0) + 1 }))
      try {
        set(s => ({
          mappings: s.mappings.map(x => (x.id === m.id ? ch.mapping : x)),
          objectTypes: s.objectTypes.map(o => (promote.has(o.id) ? strip(o) : o)),
          facts: s.facts.map(f => {
            let g = promote.has(f.id) ? strip(f) : f
            for (const a of ch.add) if (a.kind !== 'fk' && a.factId === f.id) g = addConstraint(g, a)
            return g
          }),
          populations: ch.populations, factPopulations: ch.factPopulations,
          isDirty: true,
        }))
        // Table rules lose what was folded (derivedTables.js).
        const tr = withoutRuleElements(get(), [...promote])
        if (tr.tableIds.length) {
          set({ objectTypes: tr.objectTypes })
          for (const id of tr.tableIds) set(st => compileTableRulesInto(st, id))
        }
        // Foreign keys the folded tables get: drawn where both tables are.
        const fks = ch.add.filter(a => a.kind === 'fk').map(a => a.constraint)
        if (fks.length) {
          set(st => ({ constraints: [...st.constraints, ...fks] }))
          for (const c of fks) {
            get()._tryAutoGenerateQuery?.(c.id)
            const tables = new Set(c.sequences.flat().map(m => get().facts.find(f => f.id === m.factId)?.roles.find(r => get().objectTypes.find(o => o.id === r.objectTypeId)?.kind === 'entity')?.objectTypeId))
            for (const d of get().diagrams) if (!d.mappingId && d.schemaId === schemaId && [...tables].every(t => (d.occurrences ?? []).some(o => o.schemaElementId === t))) get().addElementToDiagram(c.id, d.id)
          }
        }
        // Semi-derived elements made stored keep their rules as constraints.
        for (const c of ch.constraints ?? []) {
          get().addCarriedConstraint(schemaId, { rule: c.rule, graphical: c.graphical })
        }
        const before = get()
        const players = new Set(before.facts.filter(f => removeIds.has(f.id)).flatMap(f => f.roles.map(r => r.objectTypeId)))
        // A relational schema names its foreign keys and columns (relationalView).
        const rmView = before.schemas.find(x => x.id === schemaId)?.profile === 'relational' ? relationalView(before, schemaId) : null
        const rmName = (id) => (rmView ? rmLabel(rmView, id) : null)
        for (const c of before.constraints) {
          if (!(c.sequences ?? []).some(q => (q ?? []).some(x => removeIds.has(x?.factId)))) continue
          // A subset or equality constraint (a foreign key) of a removed column
          // goes with it; the mapping keeps what it said (a transformation
          // that moves the column adds it again where the column went).
          if ((c.constraintType === 'subset' || c.constraintType === 'equality') && get().deleteConstraint) {
            get().deleteConstraint(c.id)
            ch.report.push(rmName(c.id) ? `Removed ${rmName(c.id)}, of a removed column` : `Removed the ${c.constraintType} constraint ${c.name ? `${c.name} ` : ''}on a removed fact type`)
            continue
          }
          ch.report.push(rmName(c.id) ? `Check ${rmName(c.id)}: a column it names was removed` : `Check the ${c.constraintType ?? 'external'} constraint ${c.name ? `${c.name} ` : ''}on a removed fact type: it now has roles missing`)
        }
        for (const id of removeIds) get().deleteFact(id)
        // Value types the removed fact types leave without a role.
        const after = get()
        const named = JSON.stringify(after.mappings ?? [])
        for (const id of players) {
          const o = after.objectTypes.find(x => x.id === id)
          if (!o || o.kind !== 'value' || o.schemaId !== schemaId) continue
          if (after.facts.some(f => f.roles.some(r => r.objectTypeId === id)) || named.includes(JSON.stringify(id))) continue
          get().deleteObjectType(id)
          ch.report.push(rmView ? `Removed the column type ${o.name}, which no column uses any more` : `Removed value type ${o.name}, which no fact type uses any more`)
        }
        if (twins) {
          const gone = ch.promote.map(id => twins[id]).filter(Boolean)
          if (gone.length) {
            const tr = withoutRuleElements(get(), gone)
            set({ objectTypes: tr.objectTypes })
            for (const id of tr.tableIds) set(st => compileTableRulesInto(st, id))
            for (const id of gone) {
              if (get().facts.some(f => f.id === id)) { get().deleteFact(id); continue }
              // A table goes with its columns.
              for (const f of get().facts.filter(x => x.roles.some(r => r.objectTypeId === id))) get().deleteFact(f.id)
              if (get().objectTypes.some(o => o.id === id)) get().deleteObjectType(id)
            }
            ch.report.push(`Removed from the old version the ${gone.length} derived element${gone.length === 1 ? '' : 's'} now stored in the new one; the mapping gives them`)
          }
        }
        if (compact) get()._compactMapping(m.id)
      } finally {
        set(s => ({ historyBatch: Math.max(0, (s.historyBatch ?? 1) - 1) }))
      }
      get().setImportLog({ kind: 'fold', source: m.name, entries: ch.report.map(text => ({ level: /^(Not folded|Kept)/.test(text) ? 'warn' : 'note', text })) })
      return ch
    },

    // Opens the rule editor on a rule; in Basic mode, shows the rule in the
    // Mappings tab instead.
    // Adds a constraint carried through a mapping (mapping/translate.js) to a
    // schema: a graphical constraint when graphical is given (recognise.js),
    // a value comparison when vc is ({ sequence, query, operator }), else a
    // formula constraint. It is drawn on the
    // diagram of that schema that shows most of the fact types it names,
    // under them. One undo step; returns the new constraint's id.
    addCarriedConstraint(schemaId, { rule, deontic = false, name = '', vc = null, graphical = null }) {
      const s = get()
      if (!graphical && vc) graphical = { constraintType: 'valueComparison', operator: vc.operator, sequences: [vc.sequence], queries: [vc.query] }
      const base = graphical
        ? { ...mkConstraint(graphical.constraintType, 0, 0), ...graphicalFields(graphical) }
        : { ...mkConstraint('formula', 0, 0), rule }
      const c = { ...base, schemaId, name, ...(deontic ? { deontic: true } : {}) }
      const named = graphical ? new Set(graphical.sequences.flat().map(m => m?.factId)) : formulaElements(rule).facts
      const shown = (d) => (d.occurrences ?? []).filter(o => named.has(o.schemaElementId))
      const diagrams = s.diagrams.filter(d => d.schemaId === schemaId && !d.mappingId)
      const best = [...diagrams].sort((a, b) => shown(b).length - shown(a).length
        || (b.id === s.activeDiagramId) - (a.id === s.activeDiagramId))[0]
      let x = 100, y = 100
      const occs = best ? shown(best) : []
      if (occs.length) {
        // Right of the fact types and their players, level with the facts.
        const players = new Set(occs.flatMap(o => Object.values(o.roleOccurrenceMap ?? {})))
        const near = [...occs, ...(best.occurrences ?? []).filter(o => players.has(o.id))]
        x = Math.max(...near.map(o => o.x)) + 120
        y = occs.reduce((a, o) => a + o.y, 0) / occs.length
      }
      c.x = Math.round(x); c.y = Math.round(y)
      set(st => ({
        constraints: [...st.constraints, c],
        diagrams: best ? st.diagrams.map(d => (d.id === best.id
          ? { ...d, constraintOccurrences: [...(d.constraintOccurrences ?? []), mkConstraintOcc(c.id, c.x, c.y)] } : d)) : st.diagrams,
        isDirty: true,
      }))
      return c.id
    },

    openMappingRuleEditor(mappingId, ruleId) {
      if (get().advancedMode) { set({ mappingRuleEditor: { mappingId, ruleId } }); return }
      get().setBottomPanelCollapsed?.(false)
      get().setBottomPanelTab?.('mappings')
      set({ mappingRuleFocus: { mappingId, ruleId, at: Date.now() } })
    },
    closeMappingRuleEditor() { set({ mappingRuleEditor: null }) },

    // ── Derived tables and columns (relational/derivedTables.js) ───────────
    // A table's rules live on its entity type (tableRules) and are compiled
    // into derivation rules of the table and its columns on every change, in
    // the same step, so one edit is one undo step. They open in the mapping
    // rule editor (store.mappingRuleEditor = { tableId, ruleId }), in Basic
    // mode too: they are part of the schema, not of a mapping.

    // Adds a rule of the given kind ('table' | 'columns') and opens it.
    addTableRule(tableId, kind = 'table') {
      const t = get().objectTypes.find(o => o.id === tableId)
      if (!t) return null
      const r = mkTableRule(kind, kind === 'table' ? 'Rows' : `Columns ${tableRulesOf(t).filter(x => x.kind === 'columns').length + 1}`)
      get().updateTableRules(tableId, rs => [...rs, r])
      set({ mappingRuleEditor: { tableId, ruleId: r.id } })
      return r.id
    },
    // fn: the table's rules → the new rules. Compiles them in the same step.
    updateTableRules(tableId, fn, extra = null) {
      set(st => {
        const more = extra ? extra(st) : {}
        const base = { ...st, ...more }
        const objectTypes = base.objectTypes.map(o => (o.id === tableId ? { ...o, tableRules: fn(tableRulesOf(o)) } : o))
        const c = compileTableRulesInto({ ...base, objectTypes }, tableId)
        return { ...more, objectTypes: c.objectTypes, facts: c.facts, isDirty: true }
      })
    },
    // patch: fields of the rule, or a function of the rule giving the new rule.
    updateTableRule(tableId, ruleId, patch) {
      get().updateTableRules(tableId, rs => rs.map(r => (r.id === ruleId ? (typeof patch === 'function' ? patch(r) : { ...r, ...patch }) : r)))
    },
    deleteTableRule(tableId, ruleId) {
      get().updateTableRules(tableId, rs => rs.filter(r => r.id !== ruleId))
      const ed = get().mappingRuleEditor
      if (ed?.tableId === tableId && ed.ruleId === ruleId) set({ mappingRuleEditor: null })
    },
    openTableRuleEditor(tableId, ruleId) { set({ mappingRuleEditor: { tableId, ruleId } }) },

    // Adds a column for $y to the table and to the rule's row, as one undo
    // step: its value type is the type of the query's variable bound to $y
    // when that is a value type, else a new text value type. With key, the
    // column joins the primary key.
    addTableRuleColumn(tableId, ruleId, y, { name = y, key = false } = {}) {
      const s = get()
      const t = s.objectTypes.find(o => o.id === tableId)
      const rule = tableRulesOf(t).find(r => r.id === ruleId)
      if (!t || !rule) return null
      const ctx = sideContext(s, t.schemaId)
      const ex = expandSide(treeToSide(rule.body).side, ctx)
      const vt = (() => {
        const types = new Map()
        const scan = (vars, atoms) => { for (const v of vars ?? []) types.set(v.id, v.typeId); for (const a of atoms ?? []) if (a.t === 'opt' || a.t === 'not') scan(a.vars, a.atoms) }
        scan(ex.vars, ex.atoms)
        const find = (atoms) => { for (const a of atoms ?? []) { if (a.t === 'bind' && a.y === y) return a.v; if (a.t === 'opt') { const v = find(a.atoms); if (v) return v } } return null }
        const v = find(ex.atoms)
        const ot = v && s.objectTypes.find(o => o.id === types.get(v))
        return ot?.kind === 'value' ? ot.id : null
      })()
      const use = bodyFrontier(rule).get(y)
      const nullable = !!use?.guards
      const occ = s.diagrams.find(d => d.id === s.activeDiagramId)?.occurrences?.find(o => o.schemaElementId === tableId)
      const nCols = ctx.tableById.get(tableId)?.columns.length ?? 0
      const at = { ...t, x: (occ?.x ?? t.x ?? 0) + 180, y: (occ?.y ?? t.y ?? 0) + 50 * nCols }
      const col = newColumn(s, at, name, vt, { notNull: !nullable || key })
      const fact = { ...col.fact, x: at.x, y: at.y }
      set(st => ({ historyBatch: (st.historyBatch ?? 0) + 1 }))
      try {
        set({ objectTypes: col.objectTypes, facts: [...s.facts, fact], isDirty: true })
        if (key) {
          const s2 = get()
          const tb = sideContext(s2, t.schemaId).tableById.get(tableId)
          const k = withPrimaryKey(s2, t, [...(tb?.pk ?? []).map(c => c.fact.id), fact.id])
          set({ facts: k.facts, constraints: k.constraints })
        }
        get().updateTableRule(tableId, ruleId, r => ({ ...r, head: { ...r.head, [fact.id]: { k: nullable && !key ? 'opt' : 'fv', y } } }))
        for (const d of get().diagrams) if ((d.occurrences ?? []).some(o => o.schemaElementId === tableId)) get().addElementToDiagram(fact.id, d.id)
      } finally {
        set(st => ({ historyBatch: Math.max(0, (st.historyBatch ?? 1) - 1) }))
      }
      return fact.id
    },
    // Sets the table's primary key to these columns (in order), recompiling its rules.
    setTablePrimaryKey(tableId, columnFactIds) {
      const t = get().objectTypes.find(o => o.id === tableId)
      if (!t) return
      get().updateTableRules(tableId, rs => rs, (st) => withPrimaryKey(st, t, columnFactIds))
    },
    // Refactor (mapping/refactor.js): a new version of the schema, with the
    // identity mapping from the old one, as one undo step; then the Fold
    // dialog for the new version's derived elements. Returns the mapping id.
    refactorSchema(schemaId) {
      const r = get()._refactor(schemaId)
      if (!r) return null
      get()._compactMapping(r.mappingId)
      set({ foldDialog: { mappingId: r.mappingId, side: 'target', twins: r.twins } })
      return r.mappingId
    },
    // A same-model mapping keeps only the rules that change something: its
    // identity rules become unchanged pairs (sameModel.js). Not undoable on
    // its own: it is part of the action that calls it.
    _compactMapping(mappingId) {
      set(st => ({ mappings: (st.mappings ?? []).map(m => (m.id === mappingId ? compactMapping(st, m) : m)) }))
    },
    // The clone and the identity mapping, with a rule for every element
    // (compacted by the caller once the change is made):
    // { mappingId, idMap, twins, schemaId }.
    _refactor(schemaId, newName = null) {
      const s = get()
      const old = s.schemas.find(x => x.id === schemaId)
      if (!old) return null
      const used = new Set(s.schemas.map(x => x.name))
      let name = newName && !used.has(newName) ? newName : `${old.name} (new)`
      for (let i = 2; used.has(name); i++) name = `${old.name} (new ${i})`
      const cl = cloneSchema(s, schemaId, name)
      let mappingId = null
      set(st => ({ historyBatch: (st.historyBatch ?? 0) + 1 }))
      try {
        set(st => ({
          schemas: [...st.schemas, cl.schema],
          objectTypes: [...st.objectTypes, ...cl.objectTypes],
          facts: [...st.facts, ...cl.facts],
          subtypes: [...st.subtypes, ...cl.subtypes],
          constraints: [...st.constraints, ...cl.constraints],
          diagrams: [...st.diagrams, ...cl.diagrams],
          populations: { ...st.populations, ...cl.populations },
          factPopulations: { ...st.factPopulations, ...cl.factPopulations },
          isDirty: true,
        }))
        const { mapping, skipped } = identityMapping(get(), schemaId, cl.schema.id, cl.idMap, `${old.name} → ${name}`)
        mappingId = mapping.id
        set(st => ({ mappings: [...(st.mappings ?? []), mapping] }))
        if (cl.diagrams[0]) get().setActiveDiagram(cl.diagrams[0].id)
        get().setImportLog?.({ kind: 'fold', source: `Refactor ${old.name}`, entries: [
          { level: 'note', text: `Copied ${old.name} to ${name}, with the mapping ${mapping.name}; it carries the ${mapping.rules.length} entity types and fact types over unchanged and gets a rule for each one that changes.` },
          ...skipped.map(x => ({ level: 'warn', text: `No identity rule for ${x}: it has no identifier to map it by` })),
        ] })
      } finally {
        set(st => ({ historyBatch: Math.max(0, (st.historyBatch ?? 1) - 1) }))
      }
      // The old version's derived elements were the refactoring's plan: once
      // folded, their twins go from it (foldMapping, twins).
      const twins = {}
      for (const [o, n] of cl.idMap) {
        const el = s.objectTypes.find(x => x.id === o) ?? s.facts.find(x => x.id === o)
        if (el && el.derivation === 'derived') twins[n] = o
      }
      return { mappingId, idMap: cl.idMap, twins, schemaId: cl.schema.id }
    },
    // A named transformation (mapping/transformations.js) of a schema, as one
    // undo step: its derived elements in the schema, a new version with the
    // mapping to it, and the fold. Returns { mappingId, schemaId, report } or
    // { error }.
    transformSchema(schemaId, transformationId, params, { name = null } = {}) {
      const tr = transformationById(transformationId)
      if (!tr) return { error: 'No such transformation.' }
      const ctx0 = sideContext(get(), schemaId)
      const problems = tr.check(params, ctx0)
      if (problems.length) return { error: problems.join(' ') }
      const api = { getState: get, setState: set }
      const KEYS = ['schemas', 'objectTypes', 'facts', 'subtypes', 'constraints', 'diagrams', 'mappings', 'populations', 'factPopulations', 'activeDiagramId', 'importLog', 'foldDialog']
      const before = Object.fromEntries(KEYS.map(k => [k, get()[k]]))
      let out
      set(st => ({ historyBatch: (st.historyBatch ?? 0) + 1 }))
      try {
        const d = tr.derive ? tr.derive(api, params, ctx0) : null
        set({ mappingRuleEditor: null })
        const rf = get()._refactor(schemaId, name)
        let m = get().mappings.find(x => x.id === rf.mappingId)
        const report = []
        if (!d) {
          // Edited directly in the new version, rules rewritten with it.
          const ed = tr.edit(api, params, ctx0, { mapping: m, idMap: rf.idMap, report }) ?? {}
          m = get().mappings.find(x => x.id === rf.mappingId)
          const bad = m.rules.flatMap(r => checkRule(r, m, get()).filter(x => x.severity === 'error').map(x => `${r.name}: ${x.text}`))
          if (bad.length) throw new Error(bad.slice(0, 3).join('; '))
          // Constraints of the old version about the elements that moved
          // which the new one lost: carried over as formula constraints
          // (translate.js) when that keeps them.
          if (ed.carry?.length) report.push(...carryLost(get, m, schemaId, new Set(ed.carry)))
          // The population, carried over by running the mapping.
          if (hasPopulation(get(), schemaId)) {
            const run = runMapping(get(), m, 'forward')
            set(st => ({ ...withRunApplied(st, run), isDirty: true }))
            set(st => numberInvented(st, rf.schemaId))
          }
        }
        // Rules the transformation adds by hand (cases its derived elements
        // don't give, such as false for a boolean column).
        const extra = d?.rules?.(rf.idMap) ?? []
        if (extra.length) {
          set(st => ({ mappings: st.mappings.map(x => (x.id === m.id ? { ...x, rules: [...x.rules, ...extra] } : x)) }))
          m = get().mappings.find(x => x.id === rf.mappingId)
        }
        if (d) {
        const plan = planFold(get(), m, { side: 'target' })
        const remove = new Set((d.remove ?? []).map(id => rf.idMap.get(id)).filter(Boolean))
        // Only the fully derived elements the transformation made; semi-
        // derived ones the schema had stay as they are.
        const failed = plan.items.filter(i => !i.rule && !i.semi)
        if (failed.length) throw new Error(`${failed.map(i => `${i.name}: ${i.error}`).join('; ')}`)
        const ch = get().foldMapping(plan, { fold: plan.items.filter(i => i.rule).map(i => i.id), remove: plan.candidates.filter(c => remove.has(c.factId) && c.recoverable).map(c => c.factId), twins: rf.twins, compact: false })
        report.push(...(ch?.report ?? []))
        for (const c of plan.candidates) if (remove.has(c.factId) && !c.recoverable) report.push(`Kept ${c.name}: ${c.reason}`)
        m = get().mappings.find(x => x.id === rf.mappingId)
        d.post?.({ mapping: m, idMap: rf.idMap, report })
        }
        // A table with new columns shows them on every diagram showing it.
        get().completeTableDiagrams()
        // What the new version has that no diagram of it shows (a new key, a
        // moved foreign key): onto its first diagram.
        // Each on the diagrams that show all its fact types, between them.
        {
          const st = get()
          const shown = new Set(st.diagrams.filter(x => x.schemaId === rf.schemaId).flatMap(x => (x.constraintOccurrences ?? []).map(o => o.schemaConstraintId)))
          const todo = st.constraints.filter(c => c.schemaId === rf.schemaId && !shown.has(c.id) && c.sequences?.length)
          if (todo.length) set(s2 => ({ diagrams: s2.diagrams.map(d => {
            if (d.schemaId !== rf.schemaId || d.mappingId) return d
            const add = []
            for (const c of todo) {
              const occs = c.sequences.flat().map(m => (d.occurrences ?? []).find(o => o.schemaElementId === m?.factId))
              if (!occs.length || occs.some(o => !o)) continue
              const x = occs.reduce((a, o) => a + o.x, 0) / occs.length, y = occs.reduce((a, o) => a + o.y, 0) / occs.length
              add.push(mkConstraintOcc(c.id, Math.round(x + 40), Math.round(y + (occs.length === 1 ? 40 : 0))))
            }
            return add.length ? { ...d, constraintOccurrences: [...(d.constraintOccurrences ?? []), ...add] } : d
          }) }))
        }
        // The mapping keeps only the rules that change something.
        get()._compactMapping(rf.mappingId)
        m = get().mappings.find(x => x.id === rf.mappingId)
        get().setImportLog?.({ kind: 'transform', source: tr.label, entries: [
          { level: 'note', text: `${tr.describe(params, ctx0)} The new version is ${get().schemas.find(x => x.id === rf.schemaId)?.name}, with the mapping ${m.name} from the old one; its Equivalence button checks the change.` },
          ...report.map(text => ({ level: /^Kept /.test(text) ? 'warn' : 'note', text })),
        ] })
        out = { mappingId: rf.mappingId, schemaId: rf.schemaId, report }
      } catch (err) {
        // Nothing half done stays: back to the state before.
        set(before)
        out = { error: String(err?.message ?? err) }
      } finally {
        set(st => ({ historyBatch: Math.max(0, (st.historyBatch ?? 1) - 1) }))
      }
      return out
    },
    // A new table in a relational schema whose rows a rule derives; opens the
    // rule. Returns the table id.
    addDerivedTable(schemaId, name = 'derived_table') {
      const s = get()
      const used = new Set(s.objectTypes.filter(o => o.schemaId === schemaId).map(o => o.name))
      let unique = name
      for (let i = 2; used.has(unique); i++) unique = `${name}_${i}`
      const d = s.diagrams.find(x => x.id === s.activeDiagramId && x.schemaId === schemaId && !x.mappingId)
        ?? s.diagrams.find(x => x.schemaId === schemaId && !x.mappingId)
      const pos = { x: 120, y: 120 }
      if (d?.occurrences?.length) { pos.x = Math.max(...d.occurrences.map(o => o.x ?? 0)) + 260; pos.y = Math.min(...d.occurrences.map(o => o.y ?? 0)) }
      const e = { ...mkEntity(pos.x, pos.y), name: unique, schemaId }
      set(st => ({ historyBatch: (st.historyBatch ?? 0) + 1 }))
      try {
        set(st => ({ objectTypes: [...st.objectTypes, e], isDirty: true }))
        if (d) get().addElementToDiagram(e.id, d.id)
        get().addTableRule(e.id, 'table')
        get().select?.(e.id, 'entity')
      } finally {
        set(st => ({ historyBatch: Math.max(0, (st.historyBatch ?? 1) - 1) }))
      }
      return e.id
    },
  }
}
