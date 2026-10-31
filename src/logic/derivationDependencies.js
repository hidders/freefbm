// Dependencies between derivation rules, for the schema check that derived
// subtypes and derived fact types are not defined in terms of themselves.
//
// The rule of a derived or semi-derived type or fact type depends on
//   - every fact type its atoms use, and every type its type atoms use;
//   - every type its variables range over: the variables of quantifiers,
//     aggregates and a fact type's rule (its free variables) that no positive
//     fact atom binds through a role of their own type. An atom binds a
//     variable when it is a conjunct of the formula that restricts it, looking
//     through nested existentials: the body of ∃ or ∃^{≥n}, the antecedent of
//     ∀'s implication, an aggregate's condition, the rule's body. A variable
//     so bound only takes values from that fact type, so the formula does not
//     depend on the rest of its type's population;
//   - the supertypes of a derived subtype, whose instances are its candidates.
// Depending on a type means depending on its rule when it is derived, and on
// every derived fact type that computes objects of it (or of a subtype of it,
// or of an entity type identified by its values), since those objects are in
// its population. The graph over the rules must have no cycles, except that
// a semi-derived fact type or subtype may use itself where it occurs
// positively: its population is then the least fixpoint of its rule over the
// stored population.

import { upgradeRule, childPaths, isDerived, directSupertypes, typeGraph, atomFact } from './derivationRule.js'
import { isDerivedFact, factRuleParts } from './factDerivation.js'
import { valueAccess } from './values.js'

const QUANT = new Set(['forall', 'exists', 'count'])

// The conjuncts of a formula, looking through nested conjunctions and
// existentials.
function conjuncts(n, out = []) {
  if (n?.t === 'and') n.args.forEach(a => conjuncts(a, out))
  else if (n?.t === 'exists') conjuncts(n.body, out)
  else if (n) out.push(n)
  return out
}

// The ids of the variables vs ([{ id, typeIds }]) that a positive fact atom
// of the condition binds through a role of their own type.
function boundByAtoms(cond, vs, ctx) {
  const bound = new Set()
  for (const c of conjuncts(cond)) {
    if (c?.t !== 'fact') continue
    const fact = atomFact(ctx, c.factId)
    ;(c.args ?? []).forEach((id, i) => {
      const v = vs.find(x => x.id === id)
      if (v && fact?.roles[i]?.objectTypeId === v.typeIds[0]) bound.add(id)
    })
  }
  return bound
}

// The polarity of each child of a node, given the node's (1 positive, -1
// negative, 0 both or not monotone).
function childPolarity(n, key, pol) {
  switch (n.t) {
    case 'not': return -pol
    case 'implies': return key === 'left' ? -pol : pol
    case 'iff': return 0
    case 'count': return n.op === '≥' ? pol : 0
    case 'and': case 'or': case 'forall': case 'exists': case 'tc': return pol
    default: return 0   // data terms, if-conditions, aggregates
  }
}

// The fact types and types a formula or term uses directly; nonPositive
// collects those used somewhere other than positively.
function uses(n, ctx, out = { facts: new Set(), types: new Set(), nonPositive: new Set() }, pol = 1) {
  if (!n || typeof n !== 'object') return out
  if (n.t === 'fact' && n.factId) { out.facts.add(n.factId); if (pol !== 1) out.nonPositive.add(n.factId) }
  if (n.t === 'type' && n.typeId) { out.types.add(n.typeId); if (pol !== 1) out.nonPositive.add(n.typeId) }
  if (QUANT.has(n.t) && n.v?.typeId) {
    // The formula restricting the variable: ∀x (φ → ψ) ranges over φ, while
    // ∃^{≤n}, ∃^{=n} and ∃^{0..m} also count the instances outside the body.
    const guard = n.t === 'forall' ? (n.body?.t === 'implies' ? n.body.left : null)
      : n.t === 'exists' || ((n.op === '≥' || n.op === '..') && n.n >= 1) ? n.body : null
    if (!boundByAtoms(guard, [{ id: n.v.id, typeIds: [n.v.typeId] }], ctx).has(n.v.id)) out.types.add(n.v.typeId)
  }
  if (n.t === 'agg') {
    const vs = (n.vars ?? []).map(v => ({ id: v.id, typeIds: [v.typeId] }))
    const bound = boundByAtoms(n.cond, vs, ctx)
    for (const v of vs) if (!bound.has(v.id) && v.typeIds[0]) out.types.add(v.typeIds[0])
  }
  if (n.t === 'tc') {
    const vs = (n.vars ?? []).map(v => ({ id: v.id, typeIds: [v.typeId] }))
    const bound = boundByAtoms(n.body, vs, ctx)
    for (const v of vs) if (!bound.has(v.id) && v.typeIds[0]) out.types.add(v.typeIds[0])
  }
  for (const p of childPaths(n)) uses(p.reduce((x, k) => x?.[k], n), ctx, out, childPolarity(n, p[0], pol))
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
    const deps = [...[...u.facts].flatMap(viaFact), ...[...u.types].flatMap(viaType)]
    nodes.set(typeKey(ot.id), { key: typeKey(ot.id), kind: 'type', id: ot.id, name: ctx.typeName(ot.id),
      deps: ot.derivation === 'semiDerived' && !u.nonPositive.has(ot.id) ? deps.filter(k => k !== typeKey(ot.id)) : deps })
  }
  for (const f of facts) {
    if (!isDerivedFact(f) || !f.derivationRule) continue
    const parts = factRuleParts(f)
    const u = uses(parts.body, ctx)
    for (const { eq } of parts.eqs) uses(eq.right, ctx, u, 0)
    const bound = boundByAtoms(parts.body, [...parts.selected, ...parts.extra], ctx)
    for (const v of [...parts.selected, ...parts.extra]) if (!bound.has(v.id)) u.types.add(v.typeIds[0])
    const deps = [...[...u.facts].flatMap(viaFact), ...[...u.types].flatMap(viaType)]
    nodes.set(factKey(f.id), { key: factKey(f.id), kind: 'fact', id: f.id, name: null,
      deps: f.derivation === 'semiDerived' && !u.nonPositive.has(f.id) ? deps.filter(k => k !== factKey(f.id)) : deps })
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
