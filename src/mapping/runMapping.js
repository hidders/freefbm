// Running a schema mapping on sample populations (workbench step 8).
//
// A rule φ ⟺ ψ means ∀$y [∃x̄ φ ↔ ∃z̄ ψ] (mapping.js). Running a mapping from
// one side to the other
//   1. matches each rule's pattern on the "from" side against that side's
//      population, which gives the rule's frontier tuples $y (an optional part
//      [$y](…) that doesn't match gives $y = NULL), and
//   2. builds, for every frontier tuple, the smallest population of the "to"
//      side in which the rule's other pattern holds: each variable bound by
//      x ≈ $y or x ≈ 'c' takes that value, and each entity variable is created
//      from its reference scheme (a reference mode, or a composite identifier
//      made of the values of its identifying roles), as key-safety promises.
//      Table rows (relational atoms) are spelt out in encoding B first.
// The population built from all rules replaces the population of the other
// side's types and fact types when it is applied.
//
// runMapping(state, mapping, direction) → {
//   from, to,                       'source' | 'target'
//   populations: { otId: [cell] },  factPopulations: { factId: [[cell]] }
//   rules: [{ id, name, matches, built, skipped }],
//   counts: [{ id, name, kind: 'type'|'fact', n }],
//   log: [{ level: 'error'|'warning'|'note', text }],
// }
// roundTrip(state, mapping, direction) runs it there and back and compares
// what comes back with what was there: { ...there, back, compare: [...], log }.
//
// Cells are as in the Population tab: a string for a value or a reference
// mode, an array for a composite identifier.

import { makePopulationEvaluator } from '../logic/derivedPopulation.js'
import { projCellKey } from '../utils/populationValidation.js'
import { findRefMode, findCompositePI, findInheritedPI, identifyingFactIds } from '../utils/refMode.js'
import { asSide, expandSide, sideContext, sideSchemaId, readingName, checkRule, SIDES } from './mapping.js'

const keyOf = (cell) => {
  const k = projCellKey(cell)
  return k === null ? null : JSON.stringify(k)
}
// The data value a cell stands for, as $y carries it: the string itself, or
// for a composite identifier the JSON of its parts.
const valueOf = (cell) => {
  const k = projCellKey(cell)
  return k === null ? null : typeof k === 'string' ? k : JSON.stringify(k)
}
const constValue = (text) => String(text ?? '').trim().replace(/^'(.*)'$/s, '$1')

const other = (side) => (side === 'source' ? 'target' : 'source')

// The population data the evaluator reads, from the store state.
const dataOf = (state) => ({
  objectTypes: state.objectTypes ?? [], facts: (state.facts ?? []).filter(f => !f._implicit),
  subtypes: state.subtypes ?? [], constraints: state.constraints ?? [],
  populations: state.populations ?? {}, factPopulations: state.factPopulations ?? {},
  nestedEntityMappings: state.nestedEntityMappings ?? {}, subtypeMappings: state.subtypeMappings ?? {},
})

// ── Matching a pattern ───────────────────────────────────────────────────────

// Every match of a flat (expanded) side over the population: an array of
// frontier assignments { y → value | null }, without duplicates. Variables
// range over the populations of their types; fact atoms over the fact types'
// tuples (identifying ones included, as the evaluator gives them).
function matchSide(side, ev, limit = 100000, players = new Map()) {
  // A variable's sort: a variable of a subtype bound at a role of its
  // supertype holds only the subtype's instances.
  const sortOf = new Map()
  const collectVars = (vs, atoms) => {
    for (const v of vs ?? []) sortOf.set(v.id, v.typeId)
    for (const a of atoms ?? []) if (a.t === 'opt' || a.t === 'not') collectVars(a.vars, a.atoms)
  }
  collectVars(side.vars, side.atoms)
  const tupleCache = new Map()
  const tuplesOf = (factId) => {
    if (!tupleCache.has(factId)) {
      const r = ev.factTuples(factId)
      tupleCache.set(factId, r.error ? { error: r.error, rows: [] } : { rows: r.tuples.map(t => ({ t, k: t.map(keyOf) })) })
    }
    return tupleCache.get(factId)
  }
  // Rows of a fact type by the key at one position.
  const indexCache = new Map()
  const indexOf = (factId, pos) => {
    const ck = `${factId}:${pos}`
    if (!indexCache.has(ck)) {
      const ix = new Map()
      for (const row of tuplesOf(factId).rows) {
        const k = row.k[pos]
        if (!ix.has(k)) ix.set(k, [])
        ix.get(k).push(row)
      }
      indexCache.set(ck, ix)
    }
    return indexCache.get(ck)
  }
  const popCache = new Map()
  const domain = (typeId) => {
    if (!popCache.has(typeId)) {
      const p = ev.population(typeId)
      popCache.set(typeId, p.error ? [] : p.instances)
    }
    return popCache.get(typeId)
  }
  const keyCache = new Map()
  const domainKeys = (typeId) => {
    if (!keyCache.has(typeId)) keyCache.set(typeId, new Set(domain(typeId).map(keyOf)))
    return keyCache.get(typeId)
  }
  const errors = new Set()

  // Yields [env, y] for each way atoms hold, extending env (varId → cell) and
  // y (name → value | null). Atoms are taken cheapest first.
  function* solve(atoms, vars, env, y) {
    if (!atoms.length) {
      const free = vars.find(v => !env.has(v.id))
      if (!free) { yield [env, y]; return }
      // A variable no atom binds ranges over its type.
      for (const cell of domain(free.typeId)) yield* solve(atoms, vars, new Map(env).set(free.id, cell), y)
      return
    }
    let best = -1, bestScore = Infinity
    atoms.forEach((a, i) => {
      const s = score(a, env, y)
      if (s < bestScore) { bestScore = s; best = i }
    })
    const a = atoms[best]
    const rest = atoms.filter((_, i) => i !== best)
    if (bestScore >= 50) {
      // Only atoms waiting on an unbound variable: enumerate one.
      const v = waitingVar(a, env, vars)
      if (!v) return
      for (const cell of domain(v.typeId)) yield* solve(atoms, vars, new Map(env).set(v.id, cell), y)
      return
    }
    switch (a.t) {
      case 'type': {
        if (env.has(a.arg)) {
          const k = keyOf(env.get(a.arg))
          if (domainKeys(a.typeId).has(k)) yield* solve(rest, vars, env, y)
        } else for (const cell of domain(a.typeId)) yield* solve(rest, vars, new Map(env).set(a.arg, cell), y)
        return
      }
      case 'fact': {
        const { rows, error } = tuplesOf(a.factId)
        if (error) errors.add(error)
        const want = a.args.map(id => (env.has(id) ? keyOf(env.get(id)) : undefined))
        const at = want.findIndex(w => w !== undefined)
        for (const { t, k } of (at < 0 ? rows : indexOf(a.factId, at).get(want[at]) ?? [])) {
          if (want.some((w, i) => w !== undefined && w !== k[i])) continue
          // The same variable twice in one atom must meet the same cell.
          const next = new Map(env)
          let ok = true
          a.args.forEach((id, i) => {
            if (!ok || id == null) return
            if (next.has(id)) { if (keyOf(next.get(id)) !== k[i]) ok = false }
            else {
              const sort = sortOf.get(id)
              if (sort && players.get(a.factId)?.[i] !== sort && !domainKeys(sort).has(k[i])) ok = false
              else next.set(id, t[i])
            }
          })
          if (ok) yield* solve(rest, vars, next, y)
        }
        return
      }
      case 'bind': {
        if (env.has(a.v)) {
          const val = valueOf(env.get(a.v))
          if (a.y in y) { if (y[a.y] === val) yield* solve(rest, vars, env, y) }
          else yield* solve(rest, vars, env, { ...y, [a.y]: val })
        } else if (y[a.y] != null) {
          yield* solve(rest, vars, new Map(env).set(a.v, y[a.y]), y)
        }
        return
      }
      case 'const': {
        if (!env.has(a.v)) yield* solve(rest, vars, new Map(env).set(a.v, constValue(a.text)), y)
        else if (valueOf(env.get(a.v)) === constValue(a.text)) yield* solve(rest, vars, env, y)
        return
      }
      case 'opt': {
        // [$y](P): $y is P's value when P holds, else NULL.
        const vals = new Set()
        for (const [, y2] of solve(a.atoms ?? [], [...vars, ...(a.vars ?? [])], env, a.y in y ? y : { ...y })) {
          vals.add(y2[a.y] ?? null)
          if (vals.size > 50) break
        }
        if (a.y in y) {
          if (vals.has(y[a.y]) || (y[a.y] === null && !vals.size)) yield* solve(rest, vars, env, y)
          return
        }
        if (!vals.size) yield* solve(rest, vars, env, { ...y, [a.y]: null })
        else for (const val of vals) yield* solve(rest, vars, env, { ...y, [a.y]: val })
        return
      }
      case 'not': {
        const it = solve(a.atoms ?? [], [...vars, ...(a.vars ?? [])], env, y)
        if (it.next().done) yield* solve(rest, vars, env, y)
        return
      }
      default:
        yield* solve(rest, vars, env, y)
    }
  }
  // Lower is cheaper; ≥ 50 means it waits for a variable.
  function score(a, env, y) {
    const has = (id) => id == null || env.has(id)
    switch (a.t) {
      case 'const': return env.has(a.v) ? 0 : 1
      case 'bind': return env.has(a.v) || y[a.y] != null ? 0 : 60
      // An atom joined to what is bound costs its fan-out; one that is not
      // (a cross product with what is bound) comes after those.
      case 'type': return has(a.arg) ? 0 : (env.size ? 32 : 20) + Math.min(15, domain(a.typeId).length / 100)
      case 'fact': {
        const bound = a.args.findIndex(id => id != null && env.has(id))
        if (a.args.every(id => id == null || env.has(id))) return 0
        const rows = tuplesOf(a.factId).rows.length
        if (bound >= 0) return 5 + Math.min(25, rows / Math.max(1, indexOf(a.factId, bound).size))
        return (env.size ? 30 : 10) + Math.min(15, rows / 100)
      }
      case 'opt': case 'not': {
        // After the variables of the part's surroundings are bound.
        const inner = new Set((a.vars ?? []).map(v => v.id))
        const outer = []
        const walk = (xs) => { for (const x of xs ?? []) {
          if (x.t === 'fact') outer.push(...x.args.filter(id => id != null && !inner.has(id)))
          if (x.t === 'type' || x.t === 'bind' || x.t === 'const') { const id = x.arg ?? x.v; if (id != null && !inner.has(id)) outer.push(id) }
          if (x.t === 'opt' || x.t === 'not') walk(x.atoms)
        } }
        walk(a.atoms)
        return outer.every(id => env.has(id)) ? 45 : 70
      }
      default: return 0
    }
  }
  function waitingVar(a, env, vars) {
    const ids = a.t === 'bind' ? [a.v] : a.t === 'fact' ? a.args : a.t === 'type' ? [a.arg] : []
    for (const id of ids) if (id != null && !env.has(id)) return vars.find(v => v.id === id) ?? null
    for (const v of vars) if (!env.has(v.id)) return v
    return null
  }

  const out = [], seen = new Set()
  let truncated = false
  for (const [, y] of solve(side.atoms ?? [], side.vars ?? [], new Map(), {})) {
    const k = JSON.stringify(Object.keys(y).sort().map(n => [n, y[n]]))
    if (seen.has(k)) continue
    seen.add(k)
    out.push(y)
    if (out.length >= limit) { truncated = true; break }
  }
  return { tuples: out, errors: [...errors], truncated }
}

// ── Building a population ────────────────────────────────────────────────────

// The reference scheme that identifies instances of an entity type (or an
// objectified fact type): { kind: 'refMode', rm } | { kind: 'composite', parts }
// with parts [{ factId, entityRoleIndex, roleIndex }] in identifier order.
const schemeCache = new WeakMap()
export function schemeOf(typeId, data) {
  let m = schemeCache.get(data)
  if (!m) { m = new Map(); schemeCache.set(data, m) }
  if (!m.has(typeId)) m.set(typeId, computeScheme(typeId, data))
  return m.get(typeId)
}
function computeScheme(typeId, data) {
  const { facts, objectTypes, subtypes, constraints } = data
  const t = objectTypes.find(o => o.id === typeId) ?? facts.find(f => f.id === typeId)
  if (!t) return null
  const fromCp = (cp, owner) => {
    if (cp.factIds) return { kind: 'composite', parts: cp.factIds.map((fid, i) => ({ factId: fid, entityRoleIndex: cp.entityRoleIndices[i], roleIndex: cp.identifyingRoleIndices[i] })) }
    if (cp.entityRoleIndex == null) return { kind: 'nested', fact: owner }
    return { kind: 'composite', parts: cp.identifyingRoleIndices.map(ri => ({ factId: cp.factId, entityRoleIndex: cp.entityRoleIndex, roleIndex: ri })) }
  }
  const rm = findRefMode(t, facts, objectTypes)
  if (rm) return { kind: 'refMode', rm }
  const cp = findCompositePI(t, facts, objectTypes, constraints)
  if (cp) return fromCp(cp, t)
  const inh = findInheritedPI(t, facts, objectTypes, subtypes, constraints)
  if (inh?.kind === 'refMode') return { kind: 'refMode', rm: inh.refMode }
  if (inh?.kind === 'compositePI') return fromCp(inh.cp, inh.supertype)
  return null
}

// An invented surrogate value, from the values of another key.
const invent = (vals) => `⟨${vals.join(', ')}⟩`

// The keys of an entity type other than its preferred identifier, as lists of
// { factId, entityRi, valueRi }: a binary fact type with a uniqueness
// constraint on its other role, or an external uniqueness constraint over
// binary fact types. Fewest parts first.
const altKeyCache = new WeakMap()
function altKeysOf(typeId, data) {
  let m = altKeyCache.get(data)
  if (!m) { m = new Map(); altKeyCache.set(data, m) }
  if (m.has(typeId)) return m.get(typeId)
  const sch = schemeOf(typeId, data)
  const pref = sch?.kind === 'refMode' ? sch.rm.factId : null
  const keys = []
  for (const f of data.facts) {
    if (f.id === pref || f.roles?.length !== 2) continue
    f.roles.forEach((r, i) => {
      if (r.objectTypeId !== typeId) return
      const o = 1 - i
      if ((f.uniqueness ?? []).some(u => u.roles?.length === 1 && u.roles[0] === o)) keys.push([{ factId: f.id, entityRi: i, valueRi: o }])
    })
  }
  const factById = lookups(data).factById
  for (const c of data.constraints ?? []) {
    if (c.constraintType !== 'uniqueness' || c.isPreferredIdentifier) continue
    const seq = c.sequences?.[0] ?? []
    const parts = seq.map(mm => {
      const f = mm?.kind === 'role' && factById.get(mm.factId)
      return f?.roles?.length === 2 && f.roles[1 - mm.roleIndex]?.objectTypeId === typeId ? { factId: f.id, entityRi: 1 - mm.roleIndex, valueRi: mm.roleIndex } : null
    })
    if (parts.length && parts.every(Boolean)) keys.push(parts)
  }
  keys.sort((a, b) => a.length - b.length)
  m.set(typeId, keys)
  return keys
}

// Id lookups over the data's element arrays, made once per data object.
const lookupCache = new WeakMap()
function lookups(data) {
  let lk = lookupCache.get(data)
  if (!lk) {
    lk = { otIds: new Set(data.objectTypes.map(o => o.id)), factById: new Map(data.facts.map(f => [f.id, f])) }
    lookupCache.set(data, lk)
  }
  return lk
}

// Adds to `pop` the population that one frontier tuple y makes the side's
// pattern hold in. Returns the names of variables it could not determine.
function buildSide(side, y, data, pop, ident) {
  const vars = new Map()
  const all = []   // [atom, live] in this match
  const collect = (part, live) => {
    for (const v of part.vars ?? []) vars.set(v.id, v)
    for (const a of part.atoms ?? []) {
      if (a.t === 'opt') collect(a, live && y[a.y] != null)
      else if (a.t === 'not') continue
      else all.push([a, live])
    }
  }
  collect(side, true)
  const atoms = all.filter(([, live]) => live).map(([a]) => a)
  const env = new Map()
  for (const a of atoms) {
    if (a.t === 'bind' && a.v && y[a.y] != null) env.set(a.v, y[a.y])
    if (a.t === 'const' && a.v) env.set(a.v, constValue(a.text))
  }
  // Entity variables from their reference schemes, until nothing changes;
  // then (below) values from the entities, and invented surrogates.
  for (let outer = true; outer;) {
  outer = false
  for (let changed = true; changed;) {
    changed = false
    for (const v of vars.values()) {
      if (env.has(v.id)) continue
      const sch = schemeOf(v.typeId, data)
      if (!sch) continue
      const find = (factId, entityRi, ri) => {
        const a = atoms.find(x => x.t === 'fact' && x.factId === factId && x.args[entityRi] === v.id && env.has(x.args[ri]))
        return a ? env.get(a.args[ri]) : undefined
      }
      let cell
      if (sch.kind === 'refMode') {
        const vtRi = sch.rm.vtRoleIndex
        cell = find(sch.rm.factId, 1 - vtRi, vtRi)
        if (cell !== undefined && typeof cell !== 'string') cell = undefined
      } else if (sch.kind === 'composite') {
        const parts = sch.parts.map(p => find(p.factId, p.entityRoleIndex, p.roleIndex))
        if (parts.every(p => p !== undefined)) cell = parts
      }
      if (cell !== undefined) { env.set(v.id, cell); changed = true }
    }
  }
  // The value of a reference mode is the entity's cell, and the parts of a
  // composite identifier are the cell's parts.
  for (const a of atoms) {
    if (a.t !== 'fact') continue
    for (const v of vars.values()) {
      if (!env.has(v.id)) continue
      const sch = schemeOf(v.typeId, data)
      const cell = env.get(v.id)
      if (sch?.kind === 'refMode' && a.factId === sch.rm.factId && a.args[1 - sch.rm.vtRoleIndex] === v.id) {
        const w = a.args[sch.rm.vtRoleIndex]
        if (w && !env.has(w) && typeof cell === 'string') { env.set(w, cell); outer = true }
      } else if (sch?.kind === 'composite' && Array.isArray(cell)) {
        sch.parts.forEach((p, i) => {
          if (a.factId !== p.factId || a.args[p.entityRoleIndex] !== v.id) return
          const w = a.args[p.roleIndex]
          if (w && !env.has(w) && cell[i] !== undefined) { env.set(w, cell[i]); outer = true }
        })
      }
    }
  }
  if (outer) continue
  // A surrogate (a reference mode whose value nothing gives) is invented from
  // another key of the entity type, e.g. a natural key declared UNIQUE:
  // ⟨its values⟩. Its value then fills the reference mode's value variable.
  {
    for (const v of vars.values()) {
      if (env.has(v.id)) continue
      const sch = schemeOf(v.typeId, data)
      if (sch?.kind !== 'refMode') continue
      // The same key in every rule (inventKeys, from prepareRun), so that
      // rules giving different keys still invent the same surrogate.
      const keys = pop.inventKeys?.has(v.typeId) ? [pop.inventKeys.get(v.typeId)] : altKeysOf(v.typeId, data)
      for (const key of keys) {
        const vals = key.map(p => {
          const a = atoms.find(x => x.t === 'fact' && x.factId === p.factId && x.args[p.entityRi] === v.id && env.has(x.args[p.valueRi]))
          return a ? valueOf(env.get(a.args[p.valueRi])) : undefined
        })
        if (vals.some(x => x == null)) continue
        env.set(v.id, invent(vals))
        if (!pop.invented) pop.invented = new Map()
        pop.invented.set(v.typeId, key)
        outer = true
        break
      }
      if (outer) break
    }
  }
  }
  const unknown = [...vars.values()].filter(v => !env.has(v.id) && !v.synthetic)
  // Whatever it determines: instances of the variables' types, the type
  // atoms, and the tuples of fact types that identify nothing (identifying
  // ones follow from the entity populations).
  const lk = lookups(data)
  const addInst = (typeId, cell) => {
    if (!lk.otIds.has(typeId)) return
    const k = keyOf(cell)
    if (k === null) return
    if (!pop.types.has(typeId)) pop.types.set(typeId, new Map())
    pop.types.get(typeId).set(k, cell)
  }
  for (const v of vars.values()) if (env.has(v.id)) addInst(v.typeId, env.get(v.id))
  for (const a of atoms) {
    if (a.t === 'type' && env.has(a.arg)) addInst(a.typeId, env.get(a.arg))
    if (a.t === 'fact' && a.args.every(id => env.has(id))) {
      const f = lk.factById.get(a.factId)
      if (!f) continue
      // Players get the instances too (a variable may be of a subtype).
      a.args.forEach((id, i) => addInst(f.roles[i]?.objectTypeId, env.get(id)))
      if (ident.entity.has(f.id) || ident.nested.has(f.id)) continue
      const t = a.args.map(id => env.get(id))
      const k = JSON.stringify(t.map(keyOf))
      if (!pop.facts.has(f.id)) pop.facts.set(f.id, new Map())
      pop.facts.get(f.id).set(k, t)
    }
  }
  return unknown
}

// ── Running a mapping ────────────────────────────────────────────────────────

export function runMapping(state, mapping, direction = 'forward') {
  const prep = prepareRun(state, mapping, direction)
  const { from, to, ctxs } = prep
  const log = [...prep.log]
  const ex = executeRun(prep, state)
  const rules = prep.rules.map(r => ({ id: r.id, name: r.name, matches: ex.matches.get(r.id) ?? 0, ...(r.skipped ? { built: 0, skipped: true } : {}) }))
  log.push(...ex.log)
  const { populations, factPopulations } = ex
  // What each element of the other side gets.
  const counts = []
  for (const o of ctxs[to].objectTypes) {
    const n = populations[o.id]?.length ?? 0
    if (n) counts.push({ id: o.id, name: o.name, kind: o.kind === 'value' ? 'value' : 'entity', n })
  }
  for (const f of ctxs[to].facts) {
    const n = factPopulations[f.id]?.length ?? 0
    if (n) counts.push({ id: f.id, name: readingName(f, ctxs[to]), kind: 'fact', n })
  }
  const invented = ex.invented
  for (const { typeId } of invented) {
    const t = ctxs[to].otById.get(typeId)
    log.push({ level: 'note', text: `${t?.name ?? 'An entity type'}: its reference values were invented from another key (⟨…⟩), as nothing gives them` })
  }
  return { from, to, schemaId: sideSchemaId(mapping, to), populations, factPopulations, rules, counts, log, invented }
}

// What a run needs that does not depend on the population: the rules' sides
// spelt out, and lookups of the elements. Used again and again by constraint
// accounting (accounting.js), which runs mappings on many small populations.
export function prepareRun(state, mapping, direction = 'forward', { check = true } = {}) {
  const from = direction === 'forward' ? 'source' : 'target'
  const to = other(from)
  const elements = dataOf({ ...state, populations: {}, factPopulations: {}, nestedEntityMappings: {}, subtypeMappings: {} })
  const ctxs = { source: sideContext(state, mapping.sourceSchemaId), target: sideContext(state, mapping.targetSchemaId) }
  const log = []
  const rules = []
  for (const [k, r] of mapping.rules.entries()) {
    const name = r.name || `Rule ${k + 1}`
    const fromSide = expandSide(asSide(r[from]), ctxs[from])
    const toSide = expandSide(asSide(r[to]), ctxs[to])
    if (!(fromSide.atoms ?? []).length || !(toSide.atoms ?? []).length) {
      log.push({ level: 'warning', text: `${name}: skipped, a pattern is empty` })
      rules.push({ id: r.id, name, skipped: true })
      continue
    }
    if (check) {
      const errors = checkRule(r, mapping, state, ctxs).filter(i => i.severity === 'error')
      if (errors.length) log.push({ level: 'warning', text: `${name}: run although it has ${errors.length === 1 ? 'an error' : `${errors.length} errors`} (${errors[0].text})` })
    }
    if (hasNot(toSide.atoms)) log.push({ level: 'note', text: `${name}: the negated part of the ${to} pattern is a condition; nothing is built for it` })
    rules.push({ id: r.id, name, fromSide, toSide })
  }
  return {
    from, to, ctxs, rules, log, elements,
    ident: identifyingFactIds(elements.facts, elements.objectTypes, elements.constraints),
    players: new Map(elements.facts.map(f => [f.id, f.roles.map(r => r.objectTypeId)])),
    inventKeys: inventKeysOf(rules, elements),
  }
}

// For each entity type whose surrogate a run may have to invent: the first
// other key that every rule building it without its reference value gives.
function inventKeysOf(rules, data) {
  const avail = new Map()   // typeId → Set(index into altKeysOf)
  for (const r of rules) {
    if (r.skipped) continue
    const atoms = r.toSide.atoms ?? []
    const given = new Set(atoms.filter(a => a.t === 'bind' || a.t === 'const').map(a => a.v))
    for (const v of r.toSide.vars ?? []) {
      const sch = schemeOf(v.typeId, data)
      if (sch?.kind !== 'refMode') continue
      const refGiven = atoms.some(a => a.t === 'fact' && a.factId === sch.rm.factId && a.args[1 - sch.rm.vtRoleIndex] === v.id && given.has(a.args[sch.rm.vtRoleIndex]))
      if (refGiven) continue
      const keys = altKeysOf(v.typeId, data)
      const here = new Set(keys.map((k, i) => (k.every(p => atoms.some(a => a.t === 'fact' && a.factId === p.factId && a.args[p.entityRi] === v.id)) ? i : -1)).filter(i => i >= 0))
      if (!here.size) continue
      avail.set(v.typeId, avail.has(v.typeId) ? new Set([...avail.get(v.typeId)].filter(i => here.has(i))) : here)
    }
  }
  const out = new Map()
  for (const [typeId, set] of avail) if (set.size) out.set(typeId, altKeysOf(typeId, data)[Math.min(...set)])
  return out
}

// Runs prepared rules on the population in `pops` ({ populations,
// factPopulations, … }, e.g. the store state): { populations,
// factPopulations, matches: Map(ruleId → n), invented, log }.
export function executeRun(prep, pops, { limit } = {}) {
  const { ctxs, to } = prep
  const data = { ...prep.elements, populations: pops.populations ?? {}, factPopulations: pops.factPopulations ?? {},
    nestedEntityMappings: pops.nestedEntityMappings ?? {}, subtypeMappings: pops.subtypeMappings ?? {} }
  const ev = makePopulationEvaluator(data)
  const pop = { types: new Map(), facts: new Map(), inventKeys: prep.inventKeys }
  const log = []
  const matches = new Map()
  for (const r of prep.rules) {
    if (r.skipped) continue
    const m = matchSide(r.fromSide, ev, limit, prep.players)
    for (const e of m.errors) log.push({ level: 'error', text: `${r.name}: ${e}` })
    if (m.truncated) log.push({ level: 'warning', text: `${r.name}: stopped after ${m.tuples.length} matches` })
    const unknown = new Map()
    for (const y of m.tuples) {
      for (const v of buildSide(r.toSide, y, prep.elements, pop, prep.ident)) unknown.set(v.id, v)
    }
    for (const v of unknown.values()) {
      const t = ctxs[to].otById.get(v.typeId) ?? prep.elements.facts.find(f => f.id === v.typeId)
      log.push({ level: 'warning', text: `${r.name}: the ${t?.name ?? t?.objectifiedName ?? 'variable'} of the ${to} pattern is not determined by $y (no reference scheme reaches it), so it was not created` })
    }
    matches.set(r.id, m.tuples.length)
  }
  const populations = {}, factPopulations = {}
  for (const [id, m] of pop.types) populations[id] = [...m.values()]
  for (const [id, m] of pop.facts) factPopulations[id] = [...m.values()]
  const invented = [...(pop.invented ?? new Map())].map(([typeId, key]) => ({ typeId, key }))
  return { populations, factPopulations, matches, invented, log }
}

const hasNot = (atoms) => (atoms ?? []).some(a => a.t === 'not' || (a.t === 'opt' && hasNot(a.atoms)))

// The state with the population of one schema replaced by a run's result.
export function withRunApplied(state, run) {
  const ids = new Set([
    ...(state.objectTypes ?? []).filter(o => o.schemaId === run.schemaId).map(o => o.id),
    ...(state.facts ?? []).filter(f => f.schemaId === run.schemaId).map(f => f.id),
  ])
  const keep = (obj) => Object.fromEntries(Object.entries(obj ?? {}).filter(([id]) => !ids.has(id)))
  return {
    populations: { ...keep(state.populations), ...run.populations },
    factPopulations: { ...keep(state.factPopulations), ...run.factPopulations },
    nestedEntityMappings: keep(state.nestedEntityMappings),
    subtypeMappings: keep(state.subtypeMappings),
  }
}

// Runs the mapping there and back, and compares what comes back with the
// population of the elements the rules name on the starting side.
export function roundTrip(state, mapping, direction = 'forward') {
  const there = runMapping(state, mapping, direction)
  const mid = { ...state, ...withRunApplied(state, there) }
  const back = runMapping(mid, mapping, direction === 'forward' ? 'backward' : 'forward')
  const from = there.from
  const ctx = sideContext(state, sideSchemaId(mapping, from))
  const data = dataOf(state)
  const ev = makePopulationEvaluator(data)
  const evBack = makePopulationEvaluator({ ...dataOf(mid), ...withRunApplied(mid, back) })
  // Elements the rules name on the starting side, table rows spelt out.
  const typeIds = new Set(), factIds = new Set()
  for (const r of mapping.rules) {
    const s = expandSide(asSide(r[from]), ctx)
    const walk = (atoms) => { for (const a of atoms ?? []) {
      if (a.t === 'type') typeIds.add(a.typeId)
      if (a.t === 'fact') factIds.add(a.factId)
      if (a.t === 'opt' || a.t === 'not') walk(a.atoms)
    } }
    walk(s.atoms)
  }
  const compare = []
  const log = []
  const diff = (name, kind, before, after, show) => {
    const lost = [...before.keys()].filter(k => !after.has(k))
    const gained = [...after.keys()].filter(k => !before.has(k))
    compare.push({ name, kind, before: before.size, after: after.size, lost: lost.length, gained: gained.length,
      examples: [...lost.slice(0, 3).map(k => `lost ${show(before.get(k))}`), ...gained.slice(0, 3).map(k => `new ${show(after.get(k))}`)] })
  }
  const showCell = (c) => (typeof c === 'string' ? c : JSON.stringify(c))
  // Invented surrogates count as equal to the ones they stand for: the
  // starting population is compared with its surrogates renamed.
  const rename = surrogateRenaming(data, ev, back.invented ?? [])
  for (const id of typeIds) {
    const t = ctx.otById.get(id)
    if (!t) continue
    const m = (p, r) => new Map((p.instances ?? []).map(c => (r ? r(c, id) : c)).map(c => [keyOf(c), c]))
    diff(t.name, t.kind === 'value' ? 'value' : 'entity', m(ev.population(id), rename), m(evBack.population(id)), showCell)
  }
  for (const id of factIds) {
    const f = ctx.factById.get(id)
    if (!f) continue
    const m = (r, ren) => new Map((r.tuples ?? []).map(t => (ren ? t.map((c, i) => ren(c, f.roles[i]?.objectTypeId)) : t)).map(t => [JSON.stringify(t.map(keyOf)), t]))
    diff(readingName(f, ctx), 'fact', m(ev.factTuples(id), rename), m(evBack.factTuples(id)), (t) => `(${t.map(showCell).join(', ')})`)
  }
  if (back.invented?.length) log.push({ level: 'note', text: 'Invented surrogates are compared with the ones they stand for (up to renaming)' })
  // Elements with a population that no rule reads.
  const uncovered = []
  for (const o of ctx.objectTypes) {
    if (typeIds.has(o.id) || o.kind === 'value') continue
    const n = ev.population(o.id).instances?.length ?? 0
    if (n && ![...factIds].some(fid => ctx.factById.get(fid)?.roles.some(r => r.objectTypeId === o.id))) uncovered.push(`${o.name} (${n})`)
  }
  for (const f of ctx.facts) {
    if (factIds.has(f.id)) continue
    const n = ev.factTuples(f.id).tuples?.length ?? 0
    if (n) uncovered.push(`${readingName(f, ctx)} (${n})`)
  }
  return { there, back, compare, uncovered, log: [...there.log, ...back.log, ...log] }
}

// A function renaming the cells of a population (cell, typeId) → cell so that
// each surrogate of an entity type in `invented` becomes the value invented
// for it from the same key, ⟨…⟩, wherever it occurs: as the entity, as the
// reference mode's value, and inside composite identifiers. Null when there
// is nothing to rename.
function surrogateRenaming(data, ev, invented) {
  if (!invented.length) return null
  const byVt = new Map()   // vtId → Map(original → invented)
  for (const { typeId, key } of invented) {
    const sch = schemeOf(typeId, data)
    if (sch?.kind !== 'refMode') continue
    const index = key.map(p => {
      const ix = new Map()
      for (const t of ev.factTuples(p.factId).tuples ?? []) ix.set(keyOf(t[p.entityRi]), valueOf(t[p.valueRi]))
      return ix
    })
    const ren = byVt.get(sch.rm.vtId) ?? new Map()
    for (const c of ev.population(typeId).instances ?? []) {
      const vals = index.map(ix => ix.get(keyOf(c)))
      if (typeof c === 'string' && vals.every(v => v != null)) ren.set(c, invent(vals))
    }
    byVt.set(sch.rm.vtId, ren)
  }
  const renameCell = (cell, typeId, depth = 0) => {
    if (cell == null || depth > 8) return cell
    if (byVt.has(typeId) && typeof cell === 'string') return byVt.get(typeId).get(cell) ?? cell
    const sch = schemeOf(typeId, data)
    if (sch?.kind === 'refMode' && typeof cell === 'string') return byVt.get(sch.rm.vtId)?.get(cell) ?? cell
    if (sch?.kind === 'composite' && Array.isArray(cell)) {
      const factById = lookups(data).factById
      return cell.map((c, i) => {
        const p = sch.parts[i]
        const player = p && factById.get(p.factId)?.roles[p.roleIndex]?.objectTypeId
        return player ? renameCell(c, player, depth + 1) : c
      })
    }
    return cell
  }
  return renameCell
}

export { SIDES }
