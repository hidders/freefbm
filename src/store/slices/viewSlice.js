// View mappings (mapping/views.js): one-way mappings that define elements of
// a target schema by queries over a source schema.
import { mkView, mkViewRule, headId, runView } from '../../mapping/views.js'
import { withRunApplied } from '../../mapping/runMapping.js'

export const createViewSlice = (set, get) => {
  const mapViews = (fn) => set(s => ({ views: fn(s.views ?? []), isDirty: true }))
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
    deleteView(id) {
      mapViews(vs => vs.filter(v => v.id !== id))
      if (get().ruleEditor?.viewId === id) set({ ruleEditor: null })
    },
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
  }
}
