// Schema mappings between two schemas of the file (mapping/mapping.js).
import { mkMapping, mkRule } from '../../mapping/mapping.js'

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
      mapMappings(ms => ms.filter(m => m.id !== id))
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
    openMappingRuleEditor(mappingId, ruleId) { set({ mappingRuleEditor: { mappingId, ruleId } }) },
    closeMappingRuleEditor() { set({ mappingRuleEditor: null }) },
  }
}
