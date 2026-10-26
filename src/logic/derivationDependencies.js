// Dependencies between derivation rules, for the schema check that derived
// subtypes and derived fact types are not defined in terms of themselves.
//
// The rule of a derived or semi-derived type or fact type depends on
//   - every fact type its atoms use, and every type its type atoms use;
//   - every type its variables range over: quantified variables, and the
//     free variables of a fact type's rule that no positive fact atom of the
//     condition binds (or that it binds through a role of another type);
//   - the supertypes of a derived subtype, whose instances are its candidates.
// Depending on a type means depending on its rule when it is derived, and on
// every derived fact type that computes objects of it (or of a subtype of it,
// or of an entity type identified by its values), since those objects are in
// its population. The graph over the rules must have no cycles.

import { upgradeRule, childPaths, isDerived, directSupertypes, typeGraph } from './derivationRule.js'
import { isDerivedFact, factRuleParts } from './factDerivation.js'
import { valueAccess } from './values.js'

const QUANT = new Set(['forall', 'exists', 'count'])

// The fact types and types a formula or term uses directly.
function uses(n, out = { facts: new Set(), types: new Set() }) {
  if (!n || typeof n !== 'object') return out
  if (n.t === 'fact' && n.factId) out.facts.add(n.factId)
  if (n.t === 'type' && n.typeId) out.types.add(n.typeId)
  if (QUANT.has(n.t) && n.v?.typeId) out.types.add(n.v.typeId)
  for (const p of childPaths(n)) uses(p.reduce((x, k) => x?.[k], n), out)
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
    const u = uses(upgradeRule(ot.derivationRule))
    for (const s of directSupertypes(ot.id, state.subtypes)) u.types.add(s)
    nodes.set(typeKey(ot.id), { key: typeKey(ot.id), kind: 'type', id: ot.id, name: ctx.typeName(ot.id),
      deps: [...[...u.facts].flatMap(viaFact), ...[...u.types].flatMap(viaType)] })
  }
  for (const f of facts) {
    if (!isDerivedFact(f) || !f.derivationRule) continue
    const parts = factRuleParts(f)
    const u = uses(parts.body)
    for (const { eq } of parts.eqs) uses(eq.right, u)
    // Free variables bound by a positive fact atom of the condition, through
    // a role of their own type.
    const bound = new Set()
    const conjuncts = parts.body.t === 'and' ? parts.body.args : [parts.body]
    for (const c of conjuncts) {
      if (c.t !== 'fact') continue
      const fact = ctx.factById.get(c.factId)
      ;(c.args ?? []).forEach((id, i) => {
        const v = [...parts.selected, ...parts.extra].find(x => x.id === id)
        if (v && fact?.roles[i]?.objectTypeId === v.typeIds[0]) bound.add(id)
      })
    }
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
