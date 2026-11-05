// View mappings (mapping/views.js): one-way mappings that define elements of
// a target schema by queries over a source schema.
import { mkView, mkViewRule, headId, runView } from '../../mapping/views.js'
import { withRunApplied } from '../../mapping/runMapping.js'
import { mkExchange } from '../../mapping/exchanges.js'
import { populationSql } from '../../relational/populationSql.js'

export const createViewSlice = (set, get) => {
  const mapViews = (fn) => set(s => ({ views: fn(s.views ?? []), isDirty: true }))
  const mapExchanges = (fn) => set(s => ({ exchanges: fn(s.exchanges ?? []), isDirty: true }))
  const mapSteps = (id, fn) => mapExchanges(xs => xs.map(x => (x.id === id ? { ...x, steps: fn(x.steps) } : x)))
  const mapRules = (viewId, fn) =>
    mapViews(vs => vs.map(v => (v.id === viewId ? { ...v, rules: fn(v.rules) } : v)))
  return {
    // Adds a view from one schema to another; returns its id.
    addView(sourceSchemaId, targetSchemaId, name) {
      const used = new Set([...(get().views ?? []), ...(get().mappings ?? [])].map(m => m.name))
      const base = name ?? 'View'
      let unique = base
      for (let i = 2; used.has(unique); i++) unique = `${base} ${i}`
      const v = mkView(unique, sourceSchemaId, targetSchemaId)
      mapViews(vs => [...vs, v])
      return v.id
    },
    updateView(id, patch) {
      mapViews(vs => vs.map(v => (v.id === id ? { ...v, ...patch } : v)))
    },
    // Its diagrams go too; leave them first if one is active. One undo step.
    deleteView(id) {
      const s = get()
      const v = s.views?.find(x => x.id === id)
      const active = s.diagrams.find(d => d.id === s.activeDiagramId)
      set(st => ({ historyBatch: (st.historyBatch ?? 0) + 1 }))
      try {
        if (active?.mappingId === id) {
          const back = s.diagrams.find(d => !d.mappingId && d.schemaId === v?.sourceSchemaId) ?? s.diagrams.find(d => !d.mappingId)
          if (back) get().setActiveDiagram(back.id)
        }
        set(st => ({ diagrams: st.diagrams.filter(d => d.mappingId !== id), views: (st.views ?? []).filter(x => x.id !== id), isDirty: true }))
      } finally {
        set(st => ({ historyBatch: Math.max(0, (st.historyBatch ?? 1) - 1) }))
      }
      if (get().ruleEditor?.viewId === id) set({ ruleEditor: null })
    },
    // The view's diagram: both schemas, each rule a node linked to the
    // elements it names (MappingLayer.jsx); made on first use.
    openViewDiagram(id) { return get().openMappingDiagram(id) },
    // Adds a rule for an element of the target (head: { typeId } | { factId })
    // and opens it in the rule editor; returns its id. An element that has a
    // rule already opens that one.
    addViewRule(viewId, head, { open = true } = {}) {
      const v = get().views?.find(x => x.id === viewId)
      if (!v) return null
      const id = head.factId ?? head.typeId
      const had = v.rules.find(r => headId(r) === id)
      const r = had ?? mkViewRule(head)
      if (!had) mapRules(viewId, rs => [...rs, r])
      if (open) get().openViewRuleEditor(viewId, r.id)
      return r.id
    },
    // patch: fields of the rule, or a function of the rule giving the new rule.
    updateViewRule(viewId, ruleId, patch) {
      mapRules(viewId, rs => rs.map(r => (r.id === ruleId ? (typeof patch === 'function' ? patch(r) : { ...r, ...patch }) : r)))
    },
    deleteViewRule(viewId, ruleId) {
      mapRules(viewId, rs => rs.filter(r => r.id !== ruleId))
      const ed = get().ruleEditor
      if (ed?.viewId === viewId && ed.ruleId === ruleId) set({ ruleEditor: null })
    },
    // The rule in the derivation rule editor (DerivationRuleEditor's view mode).
    openViewRuleEditor(viewId, ruleId) {
      const v = get().views?.find(x => x.id === viewId)
      const r = v?.rules.find(x => x.id === ruleId)
      if (!r) return
      set({ ruleEditor: { viewId, ruleId, otId: r.head.typeId ?? null, factId: r.head.factId ?? null }, ruleHighlight: null })
    },
    // Puts what the view gives into the target's population, as one undo
    // step. Returns the run (runView).
    applyView(viewId) {
      const v = get().views?.find(x => x.id === viewId)
      if (!v) return null
      const run = runView(get(), v)
      set(s => ({ ...withRunApplied(s, run), isDirty: true }))
      return run
    },

    // Exchanges (mapping/exchanges.js): chains of mappings and views.
    addExchange(name, steps = []) {
      const used = new Set((get().exchanges ?? []).map(x => x.name))
      const base = name ?? 'Exchange'
      let unique = base
      for (let i = 2; used.has(unique); i++) unique = `${base} ${i}`
      const x = mkExchange(unique, steps)
      mapExchanges(xs => [...xs, x])
      return x.id
    },
    updateExchange(id, patch) { mapExchanges(xs => xs.map(x => (x.id === id ? { ...x, ...patch } : x))) },
    deleteExchange(id) { mapExchanges(xs => xs.filter(x => x.id !== id)) },
    addExchangeStep(id, step) { mapSteps(id, ss => [...ss, { mappingId: step.mappingId, direction: step.direction ?? 'forward' }]) },
    // Removes a step and the ones after it (they start where it ended).
    removeExchangeStep(id, index) { mapSteps(id, ss => ss.slice(0, index)) },
    // Puts the last step's population (runExchange's result) into its
    // schema, as one undo step.
    applyExchangeRun(result) {
      if (!result?.schemaId) return
      set(s => ({ ...withRunApplied(s, result), isDirty: true }))
    },
    // The population of a relational schema as a data script
    // (relational/populationSql.js): { sql, tables, notes }.
    populationSql(schemaId, opts) { return populationSql(get(), schemaId, opts) },
  }
}
