// Populations of derived and semi-derived subtypes and fact types, computed
// by evaluating their derivation rules (src/logic/derivationRule.js,
// src/logic/factDerivation.js) over the sample populations.
//
// An instance is the cell that identifies it, as in the Population tab: a
// string for a reference mode, an array for a composite identifier. Instances
// are compared by projCellKey after canonicalising the data, so value-equal
// spellings (en-GB, en-gb) are the same instance. The candidates for a
// subtype are the instances that all its direct supertypes share, so they keep
// the supertypes' identifiers.
//
// A quantified variable ranges over the population of its type; the
// population of another derived type is itself computed. A derived fact type
// with computed roles adds the objects it computes to the populations of
// their types (and their supertypes, and the value type of their reference
// mode). Rules that depend on each other in a cycle get an error.

import { canonicalizePopulationData, factTupleSource, projCellKey } from '../utils/populationValidation.js'
import { findRefMode, findCompositePI, findInheritedPI, propagateValueToPlayer } from '../utils/refMode.js'
import { VALUE_KINDS, parseLiteral } from '../utils/datatypeValues.js'
import { makeContext } from './constraintFormulas.js'
import { valueAccess } from './values.js'
import { makeTermEvaluator, valueText } from './dataOperators.js'
import { SUBJECT, directSupertypes, checkRule, upgradeRule, typeGraph, atomFact } from './derivationRule.js'
import { checkFactRule, factRuleParts } from './factDerivation.js'

const keyOf = (cell) => {
  const k = projCellKey(cell)
  return k === null ? null : JSON.stringify(k)
}

// Evaluator over one (canonicalised) data set. population(typeId) returns
// { instances: [cell], keys: Set } or { error }; factTuples(factId) returns
// { tuples: [[cell]], keys: Set } or { error }.
export function makePopulationEvaluator(rawData) {
  const data = canonicalizePopulationData(rawData)
  const { objectTypes = [], facts = [], subtypes = [], constraints = [], populations = {}, factPopulations = {}, nestedEntityMappings = {} } = data
  const ctx = makeContext(data)
  const graph = typeGraph(data)
  const tuplesOf = factTupleSource(data)
  const otById = new Map(objectTypes.map(o => [o.id, o]))
  const factById = new Map(facts.map(f => [f.id, f]))
  const cache = new Map()
  const visiting = new Set()
  const factCache = new Map()

  const fromCells = (cells) => {
    const instances = [], keys = new Set()
    for (const c of cells ?? []) {
      const k = keyOf(c)
      if (k === null || keys.has(k)) continue
      keys.add(k)
      instances.push(c)
    }
    return { instances, keys }
  }

  // The stored population of a type that is not derived.
  const storedPopulation = (typeId) => {
    const ot = otById.get(typeId)
    if (ot) return fromCells(populations[typeId])
    const f = factById.get(typeId)
    if (f?.objectified) {
      const hasPI = findRefMode(f, facts, objectTypes) || findCompositePI(f, facts, objectTypes, constraints)
        || findInheritedPI(f, facts, objectTypes, subtypes, constraints)
      if (hasPI) return fromCells(nestedEntityMappings[typeId])
      return fromCells((factPopulations[typeId] ?? []).map(t => (Array.isArray(t) ? t.slice(0, f.roles.length) : t)))
    }
    return { instances: [], keys: new Set() }
  }

  const storedTuples = (fact) => {
    const tuples = [], keys = new Set()
    for (const t of (tuplesOf(fact) ?? [])) {
      if (!Array.isArray(t)) continue
      const ks = fact.roles.map((_, i) => keyOf(t[i]))
      if (ks.some(k => k === null)) continue
      const k = JSON.stringify(ks)
      if (keys.has(k)) continue
      keys.add(k)
      tuples.push(t.slice(0, fact.roles.length))
    }
    return { tuples, keys }
  }

  // ── Evaluating formulas ──
  //
  // env: varId → { cell, key, typeIds }. failure records the first error met
  // while evaluating (a population that cannot be computed).
  const makeEval = (typing) => {
    const state = { failure: null }
    const fail = (e) => { if (!state.failure) state.failure = e }
    const domain = (typeId) => {
      const p = population(typeId)
      if (p.error) fail(p.error)
      return p.instances ?? []
    }
    const kindOf = (typeIds) => {
      const t = typeIds.find(id => valueAccess(id, ctx))
      return t ? valueAccess(t, ctx).kindName : null
    }
    // The data value of a variable: { value, raw }, value parsed under the
    // datatype of the variable's type (raw when it has none).
    const varValue = (env, id) => {
      const a = env.get(id)
      if (!a || typeof a.cell !== 'string') return undefined
      const raw = a.cell.trim()
      const kindName = kindOf(a.typeIds)
      if (!kindName) return { raw }
      const p = parseLiteral(raw, VALUE_KINDS[kindName])
      return 'value' in p ? { value: p.value, raw } : undefined
    }
    const terms = (env) => makeTermEvaluator({
      sorts: typing.sorts, params: typing.params,
      varValue: (id) => varValue(env, id),
      holds: (f) => holds(f, env),
      aggregate: (n) => {
        const bindings = solve(n.cond, n.vars.map(v => ({ id: v.id, typeIds: [v.typeId] })), env)
        if (state.failure) return undefined
        return bindings.map(e => (n.term ? terms(e).value(n.term) : null))
      },
    })
    const tupleKeys = (factId) => {
      const r = factTuples(factId)
      if (r.error) { fail(r.error); return new Set() }
      return r.keys
    }
    const holds = (n, env) => {
      switch (n.t) {
        case 'true': return true
        case 'not': return !holds(n.arg, env)
        case 'and': return n.args.every(a => holds(a, env))
        case 'or': return n.args.some(a => holds(a, env))
        case 'implies': return !holds(n.left, env) || holds(n.right, env)
        case 'iff': return holds(n.left, env) === holds(n.right, env)
        case 'forall': case 'exists': case 'count': {
          let count = 0
          for (const cell of domain(n.v.typeId)) {
            const inner = new Map(env).set(n.v.id, { cell, key: keyOf(cell), typeIds: [n.v.typeId] })
            const h = holds(n.body, inner)
            if (n.t === 'forall' && !h) return false
            if (n.t === 'exists' && h) return true
            if (h) count++
          }
          if (n.t === 'forall') return true
          if (n.t === 'exists') return false
          return n.op === '≤' ? count <= n.n : n.op === '≥' ? count >= n.n
            : n.op === '..' ? count >= n.n && count <= n.m : count === n.n
        }
        case 'fact':
          return tupleKeys(n.factId).has(JSON.stringify(n.args.map(id => env.get(id).key)))
        case 'type': {
          const p = population(n.typeId)
          if (p.error) fail(p.error)
          return !!p.keys?.has(env.get(n.arg).key)
        }
        case 'cmp': {
          const eq = env.get(n.left).key === env.get(n.right).key
          return n.op === '=' ? eq : !eq
        }
        case 'vcmp': return terms(env).compare(n)
        case 'dpred': return terms(env).predicate(n)
        default: return false
      }
    }

    // Every binding of the variables vs ([{ id, typeIds }]) under which the
    // formula holds. The positive fact atoms of a conjunction bind their
    // variables from the fact type's tuples; other variables range over
    // their type.
    const solve = (formula, vs, env0 = new Map()) => {
      const conjuncts = formula.t === 'and' ? formula.args : [formula]
      const atoms = conjuncts.filter(c => c.t === 'fact' && atomFact(ctx, c.factId))
      const out = []
      const typeIdsOf = new Map(vs.map(v => [v.id, v.typeIds]))
      const go = (env) => {
        if (state.failure) return
        const open = vs.filter(v => !env.has(v.id))
        if (!open.length) { if (holds(formula, env)) out.push(env); return }
        const atom = atoms.find(a => a.args.some(id => typeIdsOf.has(id) && !env.has(id)))
        if (atom) {
          const fact = atomFact(ctx, atom.factId)
          const r = factTuples(atom.factId)
          if (r.error) { fail(r.error); return }
          for (const t of r.tuples) {
            const inner = new Map(env)
            let ok = true
            atom.args.forEach((id, i) => {
              if (!ok || id == null) return
              const key = keyOf(t[i])
              const had = inner.get(id)
              if (had) { if (had.key !== key) ok = false; return }
              const typeIds = typeIdsOf.get(id)
              if (!typeIds) return
              // The tuple holds a player of the role; the variable may be of
              // another type in its hierarchy.
              if (typeIds[0] !== fact.roles[i].objectTypeId && !population(typeIds[0]).keys?.has(key)) { ok = false; return }
              inner.set(id, { cell: t[i], key, typeIds })
            })
            if (ok) go(inner)
          }
          return
        }
        const v = open[0]
        for (const cell of domain(v.typeIds[0])) go(new Map(env).set(v.id, { cell, key: keyOf(cell), typeIds: v.typeIds }))
      }
      go(env0)
      return out
    }
    return { holds, solve, terms, varValue, state }
  }

  // ── Derived subtypes ──

  // The instances a derivation rule yields for derived type typeId.
  const derive = (ot) => {
    const typing = { sorts: new Map(), params: new Map() }
    const errors = checkRule(ot.derivationRule, ot.id, data, ctx, typing).filter(i => i.severity === 'error')
    if (errors.length) return { error: `${errors[0].message}.` }
    const rule = upgradeRule(ot.derivationRule)
    const supers = directSupertypes(ot.id, subtypes)
    const superPops = supers.map(population)
    const bad = superPops.find(p => p.error)
    if (bad) return { error: bad.error }
    // Candidates: instances in every direct supertype, in the first one's order.
    const candidates = superPops[0].instances.filter(c => superPops.every(p => p.keys.has(keyOf(c))))
    const ev = makeEval(typing)
    const instances = [], keys = new Set()
    for (const cell of candidates) {
      const key = keyOf(cell)
      if (ev.holds(rule, new Map([[SUBJECT, { cell, key, typeIds: supers }]]))) {
        instances.push(cell)
        keys.add(key)
      }
      if (ev.state.failure) return { error: ev.state.failure }
    }
    return { instances, keys }
  }

  // ── Derived fact types ──

  // What the rule of a derived or semi-derived fact type yields:
  //   { tuples, keys, computed: Map(typeId → [cell]), failures: [{ tuple, message }] }
  // computed: the objects of computed roles that are not in the stored
  // population of their type; failures: bindings whose term has no value.
  const deriveFact = (fact) => {
    const typing = { sorts: new Map(), params: new Map() }
    const errors = checkFactRule(fact, data, ctx, typing).filter(i => i.severity === 'error')
    if (errors.length) return { error: `${errors[0].message}.` }
    const parts = factRuleParts(fact)
    const ev = makeEval(typing)
    const bindings = ev.solve(parts.body, [...parts.selected, ...parts.extra])
    if (ev.state.failure) return { error: ev.state.failure }

    // The cell of a computed value in the stored population of a type, or a
    // new one.
    const known = new Map()
    const cellFor = (typeId, kindName, text) => {
      if (!known.has(typeId)) known.set(typeId, storedPopulation(typeId).instances.filter(c => typeof c === 'string'))
      const kind = kindName ? VALUE_KINDS[kindName] : null
      const p = kind ? parseLiteral(text, kind) : null
      const found = known.get(typeId).find(c => {
        if (!kind || !('value' in p)) return c.trim() === text
        const q = parseLiteral(c, kind)
        return 'value' in q && kind.equal(q.value, p.value)
      })
      return { cell: found ?? text, isNew: found === undefined }
    }

    const tuples = [], keys = new Set(), computed = new Map(), failures = []
    for (const env of bindings) {
      const cells = new Map(parts.selected.map(v => [v.id, env.get(v.id).cell]))
      let ok = true
      for (const { varId, eq } of parts.eqs) {
        const role = parts.roles.find(r => r.id === varId)
        const typeId = role.typeIds[0]
        const kindName = valueAccess(typeId, ctx)?.kindName ?? null
        const ys = typing.sorts.get(eq.left), ts = typing.sorts.get(eq.right)
        const t = ev.terms(env)
        let text
        if (ys == null || ts == null) text = eq.right.t === 'var' ? ev.varValue(env, eq.right.id)?.raw : undefined
        else {
          const v = t.value(eq.right)
          text = v === undefined ? undefined : valueText(v, ys)
        }
        if (text === undefined) {
          failures.push({ cells: parts.selected.map(v => env.get(v.id).cell), roleId: role.roleId,
            message: `the term of ${ctx.typeName(typeId)} has no value` })
          ok = false
          break
        }
        const { cell, isNew } = cellFor(typeId, kindName, text)
        cells.set(varId, cell)
        if (isNew) {
          if (!computed.has(typeId)) computed.set(typeId, [])
          if (!computed.get(typeId).includes(cell)) computed.get(typeId).push(cell)
        }
      }
      if (ev.state.failure) return { error: ev.state.failure }
      if (!ok) continue
      const tuple = parts.roles.map(r => cells.get(r.id))
      const k = JSON.stringify(tuple.map(keyOf))
      if (keys.has(k)) continue
      keys.add(k)
      tuples.push(tuple)
    }
    return { tuples, keys, computed, failures }
  }

  // The rule's result for a derived or semi-derived fact type, cached.
  const derivedFact = (factId) => {
    if (factCache.has(factId)) return factCache.get(factId)
    const fact = factById.get(factId)
    if (!fact) return { error: 'Unknown fact type.' }
    const mark = `fact:${factId}`
    if (visiting.has(mark))
      return { error: `The derivation rules of ${factLabel(fact)} and the types it depends on refer to each other` }
    visiting.add(mark)
    const r = deriveFact(fact)
    visiting.delete(mark)
    factCache.set(factId, r)
    return r
  }

  // The tuples of an implied link '<factId>_il_<i>' of a nested fact type:
  // (nesting instance, player of role i) for every fact of the nested fact type.
  const linkTuples = (link) => {
    const [factId, i] = link.id.split('_il_')
    const fact = factById.get(factId)
    const tuples = [], keys = new Set()
    ;(tuplesOf(fact) ?? []).forEach((row, rowIndex) => {
      if (!Array.isArray(row)) return
      const pair = [tuplesOf.nestingInstance(fact, row, rowIndex), row[Number(i)]]
      const ks = pair.map(c => (c == null ? null : keyOf(c)))
      if (ks.some(k => k === null)) return
      const k = JSON.stringify(ks)
      if (keys.has(k)) return
      keys.add(k)
      tuples.push(pair)
    })
    return { tuples, keys }
  }

  // The tuples of any fact type: computed for a (fully) derived one, stored
  // otherwise.
  function factTuples(factId) {
    const fact = factById.get(factId)
    if (!fact) {
      const link = ctx.linkById.get(factId)
      return link ? linkTuples(link) : { tuples: [], keys: new Set() }
    }
    if (fact.derivation === 'derived') return derivedFact(factId)
    return storedTuples(fact)
  }

  // The (fully) derived fact types that compute objects for typeId: the type
  // of a computed role is typeId, a subtype of it, or an entity type
  // identified by values of typeId.
  const computingFacts = (typeId) => facts.filter(f => f.derivation === 'derived' && f.derivationRule?.terms
    && f.roles.some(r => Object.prototype.hasOwnProperty.call(f.derivationRule.terms, r.id) && r.objectTypeId
      && (graph.up(r.objectTypeId).has(typeId) || valueAccess(r.objectTypeId, ctx)?.via?.valueTypeId === typeId)))

  // The objects derived fact types add to the population of typeId.
  const computedObjects = (typeId) => {
    const cells = []
    for (const f of computingFacts(typeId)) {
      const r = derivedFact(f.id)
      if (r.error) return { error: r.error }
      for (const [t, cs] of r.computed) {
        if (graph.up(t).has(typeId) || valueAccess(t, ctx)?.via?.valueTypeId === typeId) cells.push(...cs)
      }
    }
    return { cells }
  }

  const factLabel = (fact) => {
    const parts = fact.readingParts ?? []
    const words = []
    fact.roles.forEach((r, i) => { if (parts[i]?.trim()) words.push(parts[i].trim()); words.push(ctx.typeName(r.objectTypeId)) })
    if (parts[fact.roles.length]?.trim()) words.push(parts[fact.roles.length].trim())
    return words.join(' ')
  }

  // Population of any type: computed for a (fully) derived type, stored
  // otherwise, plus the objects derived fact types compute for it. A
  // semi-derived type's population is the stored one.
  function population(typeId) {
    if (cache.has(typeId)) return cache.get(typeId)
    const mark = `type:${typeId}`
    if (visiting.has(mark))
      return { error: `The derivation rules of ${ctx.typeName(typeId)} and the types it depends on refer to each other` }
    visiting.add(mark)
    const ot = otById.get(typeId)
    let p = ot?.derivation === 'derived' ? derive(ot) : storedPopulation(typeId)
    if (!p.error) {
      const extra = computedObjects(typeId)
      if (extra.error) p = { error: extra.error }
      else if (extra.cells.length) p = fromCells([...p.instances, ...extra.cells])
    }
    visiting.delete(mark)
    cache.set(typeId, p)
    return p
  }

  // What the rule of a derived or semi-derived type yields.
  const derived = (typeId) => {
    const ot = otById.get(typeId)
    if (!ot) return { error: 'Unknown type.' }
    if (ot.derivation === 'derived') return population(typeId)
    const mark = `type:${typeId}`
    if (visiting.has(mark)) return { error: 'cycle' }
    visiting.add(mark)
    const p = derive(ot)
    visiting.delete(mark)
    return p
  }

  // ── Queries of external constraints ──

  // The tuples of a query in rule form (query.js): { keys, values, counts,
  // bindings } or { error }. values holds one cell per tuple of the free
  // variables (the cell itself for a single position), keys their projCellKey
  // strings, counts the number of bindings of all variables per tuple, and
  // bindings every binding (varId → cell). The ∃ block at the top is solved
  // together with the free variables, so its fact atoms drive the join.
  const queryResult = (rule, typing = { sorts: new Map(), params: new Map() }) => {
    let body = rule.body
    const bound = []
    while (body?.t === 'exists') { bound.push(body.v); body = body.body }
    const ev = makeEval(typing)
    const heads = [...rule.free, ...(rule.target ? [rule.target] : [])]
    const envs = ev.solve(body, [...heads, ...bound].map(v => ({ id: v.id, typeIds: [v.typeId] })))
    if (ev.state.failure) return { error: ev.state.failure }
    const keys = new Set(), values = [], counts = new Map(), bindings = []
    for (const env of envs) {
      const cells = rule.free.map(f => env.get(f.id).cell)
      const norms = cells.map(c => projCellKey(c))
      if (norms.some(n => n === null)) continue
      const key = JSON.stringify(norms.length === 1 ? norms[0] : norms)
      counts.set(key, (counts.get(key) ?? 0) + 1)
      if (!keys.has(key)) { keys.add(key); values.push(cells.length === 1 ? cells[0] : cells) }
      bindings.push(new Map([...env].map(([id, a]) => [id, a.cell])))
    }
    return { keys, values, counts, bindings }
  }

  return { data, population, derived, derivedFact, factTuples, storedTuples, keyOf, ctx, queryResult }
}

// The data with the populations of derived types and fact types replaced by
// their computed ones (left as stored when a rule can't be evaluated), and the
// objects that derived fact types compute added to the populations of their
// types, for population validation.
export function withDerivedPopulations(data) {
  const derivedTypes = (data.objectTypes ?? []).filter(o => o.derivation === 'derived')
  const derivedFacts = (data.facts ?? []).filter(f => f.derivation === 'derived')
  if (!derivedTypes.length && !derivedFacts.length) return data
  const ev = makePopulationEvaluator(data)
  const populations = { ...(ev.data.populations ?? {}) }
  const factPopulations = { ...(ev.data.factPopulations ?? {}) }
  const pctx = { facts: data.facts ?? [], objectTypes: data.objectTypes ?? [], subtypes: data.subtypes ?? [], constraints: data.constraints ?? [] }
  for (const ot of derivedTypes) {
    const p = ev.population(ot.id)
    if (p.error) continue
    if (p.instances.length) populations[ot.id] = p.instances
    else delete populations[ot.id]
  }
  for (const f of derivedFacts) {
    const r = ev.derivedFact(f.id)
    if (r.error) continue
    if (r.tuples.length) factPopulations[f.id] = r.tuples
    else delete factPopulations[f.id]
    // A computed object joins its type, as an entered one would (with its
    // supertypes and the value type of its reference mode).
    for (const [typeId, cells] of r.computed)
      for (const c of cells) propagateValueToPlayer(populations, factPopulations, typeId, c, pctx, true)
  }
  return { ...ev.data, populations, factPopulations }
}

// Population issues of semi-derived types: instances the rule derives that
// the stored population lacks.
export function semiDerivedPopulationIssues(data) {
  const semi = (data.objectTypes ?? []).filter(o => o.derivation === 'semiDerived' && o.derivationRule)
  if (!semi.length) return []
  const ev = makePopulationEvaluator(data)
  const issues = []
  for (const ot of semi) {
    const p = ev.derived(ot.id)
    if (p.error) continue
    const stored = ev.population(ot.id)
    for (const cell of p.instances) {
      if (stored.keys.has(ev.keyOf(cell))) continue
      issues.push({
        kind: 'semiDerivedMissing', elementId: ot.id, otId: ot.id,
        message: `${formatCell(cell)} satisfies the derivation rule, so it must be a ${ot.name || 'instance'}`,
      })
    }
  }
  return issues
}

// Population issues of derived and semi-derived fact types: bindings for
// which a term has no value, and, for semi-derived ones, derived facts that
// the stored population lacks.
export function derivedFactPopulationIssues(data) {
  const ruled = (data.facts ?? []).filter(f => (f.derivation === 'derived' || f.derivation === 'semiDerived') && f.derivationRule)
  if (!ruled.length) return []
  const ev = makePopulationEvaluator(data)
  const issues = []
  for (const f of ruled) {
    const r = ev.derivedFact(f.id)
    if (r.error) continue
    for (const x of r.failures) {
      issues.push({
        kind: 'derivedFactUndefined', elementId: f.id, factId: f.id,
        message: `For ${x.cells.map(formatCell).join(', ')} the condition of the derivation rule holds, but ${x.message}`,
      })
    }
    if (f.derivation !== 'semiDerived') continue
    const stored = ev.storedTuples(f)
    for (const t of r.tuples) {
      if (stored.keys.has(JSON.stringify(t.map(ev.keyOf)))) continue
      issues.push({
        kind: 'semiDerivedMissing', elementId: f.id, factId: f.id,
        message: `${formatCell(t)} is derived by the rule, so it must be in the population`,
      })
    }
  }
  return issues
}

export function formatCell(v) {
  return Array.isArray(v) ? `(${v.map(formatCell).join(', ')})` : `"${v}"`
}
