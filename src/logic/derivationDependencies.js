// Dependencies between derivation rules, for the schema check that derived
// subtypes and derived fact types are not defined in terms of themselves.
//
// The rule of a derived or semi-derived type or fact type depends on
//   - every fact type its atoms use, and every type its type atoms use;
//   - every type its variables range over: quantified variables, and the
//     free variables of a fact type's rule and the variables of aggregates
//     that no positive fact atom of the condition binds (or that it binds
//     through a role of another type);
//   - the supertypes of a derived subtype, whose instances are its candidates.
// Depending on a type means depending on its rule when it is derived, and on
// every derived fact type that computes objects of it (or of a subtype of it,
// or of an entity type identified by its values), since those objects are in
// its population. The graph over the rules must have no cycles.

import { upgradeRule, childPaths, isDerived, directSupertypes, typeGraph, atomFact } from './derivationRule.js'
import { isDerivedFact, factRuleParts } from './factDerivation.js'
import { valueAccess } from './values.js'

const QUANT = new Set(['forall', 'exists', 'count'])

// The ids of the variables vs ([{ id, typeIds }]) that a positive fact atom
// of the condition binds through a role of their own type.
function boundByAtoms(cond, vs, ctx) {
  const bound = new Set()
  const conjuncts = cond?.t === 'and' ? cond.args : [cond]
  for (const c of conjuncts) {
    if (c?.t !== 'fact') continue
    const fact = atomFact(ctx, c.factId)
    ;(c.args ?? []).forEach((id, i) => {
      const v = vs.find(x => x.id === id)
      if (v && fact?.roles[i]?.objectTypeId === v.typeIds[0]) bound.add(id)
    })
  }
  return bound
}

// The fact types and types a formula or term uses directly.
function uses(n, ctx, out = { facts: new Set(), types: new Set() }) {
  if (!n || typeof n !== 'object') return out
  if (n.t === 'fact' && n.factId) out.facts.add(n.factId)
  if (n.t === 'type' && n.typeId) out.types.add(n.typeId)
  if (QUANT.has(n.t) && n.v?.typeId) out.types.add(n.v.typeId)
  if (n.t === 'agg') {
    const vs = (n.vars ?? []).map(v => ({ id: v.id, typeIds: [v.typeId] }))
    const bound = boundByAtoms(n.cond, vs, ctx)
    for (const v of vs) if (!bound.has(v.id) && v.typeIds[0]) out.types.add(v.typeIds[0])
  }
  for (const p of childPaths(n)) uses(p.reduce((x, k) => x?.[k], n), ctx, out)
  return out
}

// The derivation rules of the schema as graph nodes:
// [{ key, kind: 'type' | 'fact', id, name, deps: [key] }].
export function derivationGraph(state, ctx) {
  const graph = typeGraph(state)
  const facts = state.facts ?? []
  const nodes = new Map()
  const typeKey = (id) => `type:${id}`
  const factKey = (id) => `fact:${id}`

  // The rules a dependency on type typeId leads to.
  const computing = facts.filter(f => f.derivation === 'derived' && f.derivationRule?.terms)
  const viaType = (typeId) => {
    const out = []
    if (isDerived(ctx.otById.get(typeId))) out.push(typeKey(typeId))
    for (const f of computing) {
      const computes = f.roles.some(r => Object.prototype.hasOwnProperty.call(f.derivationRule.terms, r.id) && r.objectTypeId
        && (graph.up(r.objectTypeId).has(typeId) || valueAccess(r.objectTypeId, ctx)?.via?.valueTypeId === typeId))
      if (computes) out.push(factKey(f.id))
    }
    return out
  }
  const viaFact = (factId) => (isDerivedFact(ctx.factById.get(factId)) ? [factKey(factId)] : [])

  for (const ot of (state.objectTypes ?? [])) {
    if (!isDerived(ot) || !ot.derivationRule) continue
    const u = uses(upgradeRule(ot.derivationRule), ctx)
    for (const s of directSupertypes(ot.id, state.subtypes)) u.types.add(s)
    nodes.set(typeKey(ot.id), { key: typeKey(ot.id), kind: 'type', id: ot.id, name: ctx.typeName(ot.id),
      deps: [...[...u.facts].flatMap(viaFact), ...[...u.types].flatMap(viaType)] })
  }
  for (const f of facts) {
    if (!isDerivedFact(f) || !f.derivationRule) continue
    const parts = factRuleParts(f)
    const u = uses(parts.body, ctx)
    for (const { eq } of parts.eqs) uses(eq.right, ctx, u)
    const bound = boundByAtoms(parts.body, [...parts.selected, ...parts.extra], ctx)
    for (const v of [...parts.selected, ...parts.extra]) if (!bound.has(v.id)) u.types.add(v.typeIds[0])
    nodes.set(factKey(f.id), { key: factKey(f.id), kind: 'fact', id: f.id, name: null,
      deps: [...[...u.facts].flatMap(viaFact), ...[...u.types].flatMap(viaType)] })
  }
  return nodes
}

// The cycles of the graph, each as a list of node keys from a node back to
// itself (each node in at most one reported cycle).
export function derivationCycles(nodes) {
  const color = new Map(), stack = [], cycles = [], inCycle = new Set()
  const visit = (key) => {
    color.set(key, 'grey')
    stack.push(key)
    for (const d of (nodes.get(key)?.deps ?? [])) {
      if (!nodes.has(d)) continue
      if (color.get(d) === 'grey') {
        const cycle = stack.slice(stack.indexOf(d))
        if (!cycle.some(k => inCycle.has(k))) { cycles.push([...cycle, d]); cycle.forEach(k => inCycle.add(k)) }
      } else if (!color.has(d)) visit(d)
    }
    stack.pop()
    color.set(key, 'black')
  }
  for (const key of nodes.keys()) if (!color.has(key)) visit(key)
  return cycles
}
