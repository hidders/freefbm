// Populations of derived and semi-derived subtypes, computed by evaluating
// their derivation rules (src/logic/derivationRule.js) over the sample
// populations.
//
// An instance is the cell that identifies it, as in the Population tab: a
// string for a reference mode, an array for a composite identifier. Instances
// are compared by projCellKey after canonicalising the data, so value-equal
// spellings (en-GB, en-gb) are the same instance. The candidates for a
// subtype are the instances that all its direct supertypes share, so they keep
// the supertypes' identifiers.
//
// A quantified variable ranges over the population of its type; the
// population of another derived type is itself computed. Rules that depend on
// each other in a cycle get an error.

import { canonicalizePopulationData, factTupleSource, projCellKey } from '../utils/populationValidation.js'
import { findRefMode, findCompositePI, findInheritedPI } from '../utils/refMode.js'
import { VALUE_KINDS, parseLiteral } from '../utils/datatypeValues.js'
import { makeContext } from './constraintFormulas.js'
import { valueAccess } from './values.js'
import { SUBJECT, directSupertypes, checkRule } from './derivationRule.js'

const keyOf = (cell) => {
  const k = projCellKey(cell)
  return k === null ? null : JSON.stringify(k)
}

// Compares two data values under an operator of the logic (≈ ≉ < ≤ > ≥).
function compareValues(a, b, op, kindName) {
  const kind = kindName ? VALUE_KINDS[kindName] : null
  let x = a, y = b, eq, c
  if (kind) {
    const pa = parseLiteral(a, kind), pb = parseLiteral(b, kind)
    if (!('value' in pa) || !('value' in pb)) return false
    eq = kind.equal(pa.value, pb.value)
    c = eq ? 0 : kind.compare(pa.value, pb.value)
  } else {
    const na = Number(a), nb = Number(b)
    if (a !== '' && b !== '' && Number.isFinite(na) && Number.isFinite(nb)) { x = na; y = nb }
    eq = x === y
    c = eq ? 0 : x < y ? -1 : 1
  }
  switch (op) {
    case '≈': return eq
    case '≉': return !eq
    case '<': return c < 0
    case '≤': return c <= 0
    case '>': return c > 0
    case '≥': return c >= 0
    default:  return false
  }
}

// Evaluator over one (canonicalised) data set. population(typeId) returns
// { instances: [cell], keys: Set } or { error }.
export function makePopulationEvaluator(rawData) {
  const data = canonicalizePopulationData(rawData)
  const { objectTypes = [], facts = [], subtypes = [], constraints = [], populations = {}, factPopulations = {}, nestedEntityMappings = {} } = data
  const ctx = makeContext(data)
  const tuplesOf = factTupleSource(data)
  const otById = new Map(objectTypes.map(o => [o.id, o]))
  const factById = new Map(facts.map(f => [f.id, f]))
  const cache = new Map()
  const visiting = new Set()
  const factKeys = new Map()

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

  const tupleKeys = (factId) => {
    if (!factKeys.has(factId)) {
      const fact = factById.get(factId)
      const set = new Set()
      for (const t of (fact ? tuplesOf(fact) ?? [] : [])) {
        if (!Array.isArray(t)) continue
        const ks = fact.roles.map((_, i) => keyOf(t[i]))
        if (ks.every(k => k !== null)) set.add(JSON.stringify(ks))
      }
      factKeys.set(factId, set)
    }
    return factKeys.get(factId)
  }

  // The instances a derivation rule yields for derived type typeId.
  const derive = (ot) => {
    const errors = checkRule(ot.derivationRule, ot.id, data, ctx).filter(i => i.severity === 'error')
    if (errors.length) return { error: `${errors[0].message}.` }
    const supers = directSupertypes(ot.id, subtypes)
    const superPops = supers.map(population)
    const bad = superPops.find(p => p.error)
    if (bad) return { error: bad.error }
    // Candidates: instances in every direct supertype, in the first one's order.
    const candidates = superPops[0].instances.filter(c => superPops.every(p => p.keys.has(keyOf(c))))

    const kindOf = (typeIds) => {
      const t = typeIds.find(id => valueAccess(id, ctx))
      return t ? valueAccess(t, ctx).kindName : null
    }
    let failure = null
    const domain = (typeId) => {
      const p = population(typeId)
      if (p.error && !failure) failure = p.error
      return p.instances ?? []
    }
    // env: varId → { cell, key, typeIds }
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
          return n.op === '≤' ? count <= n.n : n.op === '≥' ? count >= n.n : count === n.n
        }
        case 'fact':
          return tupleKeys(n.factId).has(JSON.stringify(n.args.map(id => env.get(id).key)))
        case 'type': {
          const p = population(n.typeId)
          if (p.error && !failure) failure = p.error
          return !!p.keys?.has(env.get(n.arg).key)
        }
        case 'cmp': {
          const eq = env.get(n.left).key === env.get(n.right).key
          return n.op === '=' ? eq : !eq
        }
        case 'vcmp': {
          const a = env.get(n.left)
          const kind = kindOf(a.typeIds)
          const left = typeof a.cell === 'string' ? a.cell.trim() : null
          const rightCell = 'const' in n.right ? String(n.right.const).trim() : env.get(n.right.var).cell
          const right = typeof rightCell === 'string' ? rightCell.trim() : null
          if (left === null || right === null) return false
          return compareValues(left, right, n.op, kind)
        }
        default: return false
      }
    }

    const instances = [], keys = new Set()
    for (const cell of candidates) {
      const key = keyOf(cell)
      if (holds(ot.derivationRule, new Map([[SUBJECT, { cell, key, typeIds: supers }]]))) {
        instances.push(cell)
        keys.add(key)
      }
      if (failure) return { error: failure }
    }
    return { instances, keys }
  }

  // Population of any type: computed for a (fully) derived type, stored
  // otherwise. A semi-derived type's population is the stored one.
  function population(typeId) {
    if (cache.has(typeId)) return cache.get(typeId)
    const ot = otById.get(typeId)
    if (ot?.derivation !== 'derived') {
      const p = storedPopulation(typeId)
      cache.set(typeId, p)
      return p
    }
    if (visiting.has(typeId))
      return { error: `The derivation rules of ${ctx.typeName(typeId)} and the types it depends on refer to each other` }
    visiting.add(typeId)
    const p = derive(ot)
    visiting.delete(typeId)
    cache.set(typeId, p)
    return p
  }

  // What the rule of a derived or semi-derived type yields.
  const derived = (typeId) => {
    const ot = otById.get(typeId)
    if (!ot) return { error: 'Unknown type.' }
    if (ot.derivation === 'derived') return population(typeId)
    if (visiting.has(typeId)) return { error: 'cycle' }
    visiting.add(typeId)
    const p = derive(ot)
    visiting.delete(typeId)
    return p
  }

  return { data, population, derived, keyOf }
}

// The data with the populations of derived types replaced by their computed
// ones (left as stored when the rule can't be evaluated), for population
// validation.
export function withDerivedPopulations(data) {
  const derivedTypes = (data.objectTypes ?? []).filter(o => o.derivation === 'derived')
  if (!derivedTypes.length) return data
  const ev = makePopulationEvaluator(data)
  const populations = { ...(data.populations ?? {}) }
  for (const ot of derivedTypes) {
    const p = ev.population(ot.id)
    if (p.error) continue
    if (p.instances.length) populations[ot.id] = p.instances
    else delete populations[ot.id]
  }
  return { ...data, populations }
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

export function formatCell(v) {
  return Array.isArray(v) ? `(${v.map(formatCell).join(', ')})` : `"${v}"`
}
