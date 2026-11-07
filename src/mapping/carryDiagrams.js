// Carrying a schema's division into diagrams across a generated mapping
// (Generate tables, Guess ORM2): each diagram of the schema the mapping was
// made from gets a twin in the new schema, showing what the rules about the
// diagram's elements make there.
//
// A rule is about a diagram when the diagram shows all of the rule's core
// elements on that side: its tables and the fact types it reads that identify
// nothing (a table row, an attribute, a foreign key between two tables shown,
// a fact type and not the reference schemes it joins over); a rule with none
// of those (an entity or subtype rule) by its type atoms, else by the most
// specific entity types of its ∃ variables, else by the entity types its
// identifying facts identify. The twin shows every element the diagram's
// rules name on the other side (ruleWantedElements, plus the types of their ∃
// variables), the way a mapping diagram draws a rule.

import { ruleElements } from './mapping.js'
import { ruleWantedElements } from './diagramRules.js'
import { identifyingFactIds } from '../utils/refMode.js'

const baseId = (id) => id.split('_il_')[0]

// The elements a rule is about on one side ('source' | 'target'): the ones a
// diagram must show for the rule to belong to it.
export function ruleCore(state, rule, side) {
  const e = ruleElements(rule)[side]
  const ident = identifyingFactIds(state.facts, state.objectTypes, state.constraints)
  const facts = [...new Set(e.factIds.map(baseId))]
  const own = facts.filter(id => !ident.entity.has(id))
  const tables = e.tableIds ?? []
  if (own.length || tables.length) return [...new Set([...own, ...tables])]
  if (e.typeIds.length) return [...new Set(e.typeIds)]
  const typed = typedEntities(state, e)
  if (typed.length) return typed
  // Only identifying facts: the entity types they identify.
  const out = new Set()
  for (const [typeId, rm] of ident.refModes) if (facts.includes(rm.factId)) out.add(typeId)
  for (const [typeId, cp] of ident.compositePIs) if ((cp.factIds ?? []).some(id => facts.includes(id)) || facts.includes(cp.factId)) out.add(typeId)
  return [...out]
}

// The entity types of a pattern's ∃ variables, but those that are a
// supertype of another (an entity rule of a subtype joins over its
// supertype's reference scheme): ∃x:Lecturer ∃n (Person has PersonNr(x, n) …).
function typedEntities(state, e) {
  const ids = (e.varTypeIds ?? []).filter(id => state.objectTypes.some(o => o.id === id && o.kind === 'entity'))
  const supers = new Set()
  const up = (id, seen = new Set()) => {
    for (const st of state.subtypes ?? []) if (st.subId === id && !seen.has(st.superId)) { seen.add(st.superId); supers.add(st.superId); up(st.superId, seen) }
  }
  for (const id of ids) up(id)
  return [...new Set(ids.filter(id => !supers.has(id)))]
}

// The plain diagrams (no mapping diagrams) of a schema, in tab order.
export const plainDiagramsOf = (state, schemaId) =>
  (state.diagrams ?? []).filter(d => d.schemaId === schemaId && !d.mappingId)

// The twins of the diagrams of schema fromSchemaId over the mapping m (made
// from that schema to another): [{ name, sourceDiagramId, elementIds, all }],
// one per diagram that some rule is about, in tab order; all is true when
// every rule of the mapping is about it (the twin shows what a diagram of the
// whole new schema shows). Empty when the schema has a single diagram.
export function carriedDiagrams(state, m, fromSchemaId) {
  const diagrams = plainDiagramsOf(state, fromSchemaId)
  if (diagrams.length < 2 || !m?.rules?.length) return []
  const from = m.sourceSchemaId === fromSchemaId ? 'source' : 'target'
  const to = from === 'source' ? 'target' : 'source'
  const cores = m.rules.map(r => ({ r, core: ruleCore(state, r, from) })).filter(x => x.core.length)
  const out = []
  for (const d of diagrams) {
    const shown = new Set((d.occurrences ?? []).map(o => o.schemaElementId))
    const rules = cores.filter(x => x.core.every(id => shown.has(id))).map(x => x.r)
    if (!rules.length) continue
    const wanted = ruleWantedElements(state, m, rules)[to]
    // A subtype that only types a variable (its entity rule) comes too.
    for (const r of rules) for (const id of typedEntities(state, ruleElements(r)[to])) wanted.add(id)
    out.push({ name: d.name, sourceDiagramId: d.id, elementIds: [...wanted], all: rules.length === cores.length })
  }
  return out
}
