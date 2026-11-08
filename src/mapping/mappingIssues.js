// Validation of mappings after free edits of their schemas (workbench step 11).
//
// A mapping's rules name elements of its two schemas by id. Editing either
// schema by hand can break them: a fact type, column or table that is
// deleted or moved, a role added or removed, a role player or column type
// changed, a key changed so that a rule is no longer key-safe. checkRule
// finds all of these; here they are collected for the Validation panel
// (categories 'mappingRules' and 'mappingCoverage'), each issue naming its
// mapping and rule so that a click opens the rule in the rule editor.
//
// Coverage: an element of either schema that no rule of a mapping names is
// not carried over by it (a new column, a new fact type). It is listed as a
// warning against the element itself, for mappings that have rules.

import { checkRule, sideContext, sideSchemaId, expandSide, asSide, SIDES } from './mapping.js'
import { identifyingFactIds } from '../utils/refMode.js'
import { withImplicitRules } from './sameModel.js'

const ctxsOf = (state, mapping, cache) => {
  const get = (id) => {
    if (!cache.has(id)) cache.set(id, sideContext(state, id))
    return cache.get(id)
  }
  return { source: get(mapping.sourceSchemaId), target: get(mapping.targetSchemaId) }
}

// Issues of every rule of every mapping: [{ mapping, rule, ruleIndex, severity, side, text }].
export function mappingRuleIssues(state, cache = new Map()) {
  const out = []
  for (const m of state.mappings ?? []) {
    const ctxs = ctxsOf(state, m, cache)
    m.rules.forEach((r, k) => {
      let issues
      try { issues = checkRule(r, m, state, ctxs) } catch (err) {
        issues = [{ severity: 'error', side: null, text: `the rule could not be checked (${err?.message ?? err})` }]
      }
      for (const i of issues) out.push({ mapping: m, rule: r, ruleIndex: k, ...i })
    })
  }
  return out
}

// The elements of one side's schema that no rule of the mapping names:
// { typeIds, factIds }. Value types are left out (they come with the fact
// types that use them), and so are fully derived fact types (their rule
// gives them) and identifying fact types of a named entity type.
export function uncoveredElements(state, mapping, side, ctx = sideContext(state, sideSchemaId(mapping, side))) {
  mapping = withImplicitRules(state, mapping)
  const typeIds = new Set(), factIds = new Set()
  for (const r of mapping.rules) {
    let s
    try { s = expandSide(asSide(r[side]), ctx) } catch { continue }
    for (const v of s.vars ?? []) if (v.typeId) typeIds.add(v.typeId)
    const walk = (vars, atoms) => {
      for (const v of vars ?? []) if (v.typeId) typeIds.add(v.typeId)
      for (const a of atoms ?? []) {
        if (a.t === 'type') typeIds.add(a.typeId)
        if (a.t === 'fact') factIds.add(a.factId)
        if (a.t === 'opt' || a.t === 'not') walk(a.vars, a.atoms)
      }
    }
    walk(s.vars, s.atoms)
  }
  // Types named through the fact types they play in.
  for (const fid of factIds) for (const r of ctx.factById.get(fid)?.roles ?? []) typeIds.add(r.objectTypeId)
  const ident = identifyingFactIds(ctx.facts, ctx.objectTypes, ctx.constraints)
  const identifies = new Map()   // identifying fact id → the entity type ids it identifies
  for (const [otId, rm] of ident.refModes) identifies.set(rm.factId, [...(identifies.get(rm.factId) ?? []), otId])
  for (const [otId, cp] of ident.compositePIs) for (const fid of [cp.factId, ...(cp.factIds ?? [])].filter(Boolean)) identifies.set(fid, [...(identifies.get(fid) ?? []), otId])
  const out = { typeIds: [], factIds: [] }
  for (const ot of ctx.objectTypes) if (ot.kind === 'entity' && !typeIds.has(ot.id)) out.typeIds.push(ot.id)
  for (const f of ctx.facts) {
    if (factIds.has(f.id) || f.derivation === 'derived') continue
    if ((identifies.get(f.id) ?? []).some(id => typeIds.has(id))) continue
    out.factIds.push(f.id)
  }
  return out
}

// Coverage of every mapping with rules (or unchanged elements, sameModel.js), per element: [{ mapping, side, elementId, kind: 'type' | 'fact' }].
export function mappingCoverageIssues(state, cache = new Map()) {
  const out = []
  for (const m of state.mappings ?? []) {
    if (!m.rules.length && !m.unchanged?.length) continue
    const ctxs = ctxsOf(state, m, cache)
    for (const side of SIDES) {
      const u = uncoveredElements(state, m, side, ctxs[side])
      for (const id of u.typeIds) out.push({ mapping: m, side, elementId: id, kind: 'type' })
      for (const id of u.factIds) out.push({ mapping: m, side, elementId: id, kind: 'fact' })
    }
  }
  return out
}
