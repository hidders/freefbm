// Refactor (relational Fold plan, part 2; design decision Q6): a schema with
// derived elements declared in it becomes a new version in one step. The
// command clones the schema, makes the identity mapping from the old version
// to the clone (one rule per entity type and fact type, or per table and
// column), and then folds the clone's derived elements into that mapping
// (fold.js). The old version and the mapping stay beside the new one: the
// mapping records the change, so it can migrate populations and be checked
// by accounting.
//
// cloneSchema(state, schemaId, name) gives the clone's parts with fresh ids;
// identityMapping(state, oldId, newId, idMap) the mapping between the two.

import { uid, mkSchema } from '../store/storeHelpers.js'
import { sideContext, mkMapping } from './mapping.js'
import { keyLeaves, schemeParts, ownPattern, elsOf, snake, sideToTree } from './fold.js'
import { readingName } from './mapping.js'

// The schema's elements, diagrams (not mapping diagrams) and populations with
// fresh ids: { schema, objectTypes, facts, subtypes, constraints, diagrams,
// populations, factPopulations, idMap }.
export function cloneSchema(state, schemaId, name) {
  const old = state.schemas.find(s => s.id === schemaId)
  const schema = { ...mkSchema(name, old?.profile ?? 'orm2') }
  const inSchema = (x) => x.schemaId === schemaId
  const parts = {
    objectTypes: (state.objectTypes ?? []).filter(inSchema),
    facts: (state.facts ?? []).filter(f => inSchema(f) && !f._implicit),
    subtypes: (state.subtypes ?? []).filter(inSchema),
    constraints: (state.constraints ?? []).filter(inSchema),
    diagrams: (state.diagrams ?? []).filter(d => inSchema(d) && !d.mappingId),
  }
  // Every id the parts define: elements, roles, constraints inside fact
  // types, table rules, occurrences.
  const idMap = new Map([[schemaId, schema.id]])
  const collect = (x) => {
    if (Array.isArray(x)) { x.forEach(collect); return }
    if (!x || typeof x !== 'object') return
    for (const [k, v] of Object.entries(x)) {
      if ((k === 'id' || k === 'mandatoryId') && typeof v === 'string' && !idMap.has(v)) idMap.set(v, uid())
      else if (v && typeof v === 'object') collect(v)
    }
  }
  collect(parts)
  // Ids also occur inside implied-link ids ('<factId>_il_<i>').
  const str = (v) => {
    if (idMap.has(v)) return idMap.get(v)
    // Implied links '<factId>_il_<i>', and rule variables 'role:<roleId>'.
    const m = v.match(/^(role:)?(.+?)(_il_\d+)?$/)
    return m && idMap.has(m[2]) ? (m[1] ?? '') + idMap.get(m[2]) + (m[3] ?? '') : v
  }
  const remap = (x) => {
    if (typeof x === 'string') return str(x)
    if (Array.isArray(x)) return x.map(remap)
    if (!x || typeof x !== 'object') return x
    return Object.fromEntries(Object.entries(x).map(([k, v]) => [str(k), remap(v)]))
  }
  const out = remap(parts)
  const populations = {}, factPopulations = {}
  for (const o of parts.objectTypes) if (state.populations?.[o.id]) populations[idMap.get(o.id)] = state.populations[o.id]
  for (const f of parts.facts) if (state.factPopulations?.[f.id]) factPopulations[idMap.get(f.id)] = state.factPopulations[f.id]
  return { schema, ...out, populations, factPopulations, idMap }
}

const isFullyDerived = (x) => x.derivation === 'derived'

// The identity mapping from schema oldId to its clone newId: for every
// entity type with an identifier and every fact type that does not identify
// one (fully derived ones are left to Fold), the element's own pattern on
// both sides over the frontier names of its reference values.
// Returns { mapping, skipped: [name] }.
export function identityMapping(state, oldId, newId, idMap, name) {
  const ctxOld = sideContext(state, oldId), ctxNew = sideContext(state, newId)
  const elsOld = elsOf(ctxOld), elsNew = elsOf(ctxNew)
  const mapping = mkMapping(name, oldId, newId)
  const skipped = []
  const ident = new Set()
  for (const o of ctxOld.objectTypes) for (const p of schemeParts(o.id, ctxOld, elsOld) ?? []) ident.add(p.factId)
  const namesFor = (typeIds) => {
    const taken = new Set()
    return typeIds.map(tid => (keyLeaves(tid, ctxOld, elsOld) ?? []).map(vt => {
      const base = snake(ctxOld.otById.get(vt)?.name)
      let n = base
      for (let i = 2; taken.has(n); i++) n = `${base}_${i}`
      taken.add(n)
      return n
    }))
  }
  const add = (el, kind, label) => {
    const twin = (kind === 'fact' ? ctxNew.factById : ctxNew.otById).get(idMap.get(el.id))
    const typeIds = kind === 'fact' ? el.roles.map(r => r.objectTypeId) : [el.id]
    if (!twin || typeIds.some(t => !keyLeaves(t, ctxOld, elsOld))) { skipped.push(label); return }
    const names = namesFor(typeIds)
    const rootNames = kind === 'fact' ? names : [names.flat()]
    try {
      const source = sideToTree(ownPattern(el, kind, ctxOld, elsOld, rootNames))
      const target = sideToTree(ownPattern(twin, kind, ctxNew, elsNew, rootNames))
      mapping.rules.push({ id: uid(), name: label, source, target })
    } catch { skipped.push(label) }
  }
  for (const o of ctxOld.objectTypes) {
    if (o.kind !== 'entity' || isFullyDerived(o)) continue
    add(o, 'type', o.name)
  }
  for (const f of ctxOld.facts) {
    if (ident.has(f.id) || isFullyDerived(f)) continue
    add(f, 'fact', readingName(f, ctxOld))
  }
  return { mapping, skipped }
}

// The fully derived elements of a schema, which a refactor would fold.
export function derivedToFold(state, schemaId) {
  const ctx = sideContext(state, schemaId)
  return [...ctx.objectTypes.filter(isFullyDerived), ...ctx.facts.filter(isFullyDerived)]
}
