// Property-based tests of Generate tables (src/relational/rmap.js) against
// the meaning of its mapping (the Claude doc "Proving Rmap correct: plan and
// theorem statements"). Random well-formed ORM2 schemas S (phase 1: entity
// types with reference modes or composite identifiers, value types, unary,
// binary and ternary fact types with internal uniqueness and mandatory roles,
// subtypes that inherit their identifier or have one of their own, multiple
// supertypes under one root, objectified fact types playing roles)
// and random legal populations I; for each, Rmap gives T and M, and:
//
//   P1  run(S → T, I) satisfies Σ_T                         (totality)
//   P2  back(run(I)) = I                                    (injectivity on S)
//   P3  a mutated image J′ that satisfies Σ_T comes back to a legal I′ and
//       run(back(J′)) = J′                                  (surjectivity, injectivity on T)
//   Pb  a mutated I′ that breaks Σ_S, and comes back whole, runs to a J′
//       that breaks Σ_T (one that a run drops part of is related to a
//       smaller I, which is fine)
//   Pd  a mutated J′ that breaks Σ_T does not come back to a legal I′ whose
//       image is J′ again
//   P4  the equivalence summary does not say "not"
//   P5  the PostgreSQL DDL accepts the image's rows and refuses each mutated
//       image that breaks Σ_T (with --pg; needs initdb/pg_ctl/psql)
//
// Σ is judged by population validation (resultIssues), which
// scripts/population-coverage-check.mjs checks against the formulas. A failing
// schema is shrunk (fact types, types, instances left out while the same
// property still fails) and saved, with T and the mapping, as an .ffbm file
// to open in FreeFBM. Mutations change only facts that are not identifying,
// add no tuple twice, and drop the values nothing uses any more.
//
//   node scripts/rmap-property-check.mjs [--runs N] [--seed S] [--mutations K]
//        [--no-equivalence] [--pg] [--out DIR] [--only P1,P2,…] [--save] [--no-shrink] [--surrogates never|composite|always] [--verbose]

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { createServer } from 'vite'

const args = process.argv.slice(2)
const opt = (name, dflt) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : dflt }
const flag = (name) => args.includes(`--${name}`)
const RUNS = Number(opt('runs', 50))
const SEED = Number(opt('seed', 1))
const MUTATIONS = Number(opt('mutations', 6))
const EQUIV = !flag('no-equivalence')
const PG = flag('pg')
const OUT = opt('out', path.join(os.tmpdir(), 'rmap-pbt'))
const ONLY = opt('only', null)?.split(',')
const SAVE = flag('save')
const VERBOSE = flag('verbose')
const SHRINK = !flag('no-shrink')
const SURROGATES = opt('surrogates', null)   // never | composite | always (else random per seed)

const server = await createServer({ server: { middlewareMode: true, hmr: false }, appType: 'custom', logLevel: 'error' })
const load = (p) => server.ssrLoadModule(p)
const { useOrmStore } = await load('/src/store/ormStore.js')
const { resultIssues, numberInvented } = await load('/src/mapping/exchanges.js')
const { roundTrip, runMapping, withRunApplied } = await load('/src/mapping/runMapping.js')
const { equivalence } = await load('/src/mapping/equivalence.js')
const { exportPostgresDdl } = await load('/src/relational/ddlExport.js')
const { populationSql } = await load('/src/relational/populationSql.js')
const { identifiedRoles } = await load('/src/utils/independence.js')

// ── Random numbers (reproducible) ───────────────────────────────────────────
function rng(seed) {
  let s = (seed * 2654435761) % 2147483648 || 1
  const r = () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648 }
  r.int = (lo, hi) => lo + Math.floor(r() * (hi - lo + 1))
  r.pick = (xs) => xs[Math.floor(r() * xs.length)]
  r.chance = (p) => r() < p
  return r
}

const S = 'sch_S'
const TEXT = { profileId: 'abstract', datatypeId: 'text', params: {} }
const INT = { profileId: 'abstract', datatypeId: 'integer', params: {} }
const clone = (x) => JSON.parse(JSON.stringify(x))
const key = (c) => JSON.stringify(c)

// ── Schemas ─────────────────────────────────────────────────────────────────
// A schema is kept as a small description (types, facts, links), turned into
// a model file by toModel, so that shrinking can leave parts out.

function genSchema(r) {
  const d = { entities: [], values: [], facts: [] }
  const vt = (name, dt) => { const v = { id: `vt_${name}`, name, dt }; d.values.push(v); return v.id }
  const nE = r.int(2, 5)
  for (let i = 0; i < nE; i++) {
    const name = `E${i}`
    const prior = d.entities
    const e = { id: `ot_${name}`, name, supers: [], independent: r.chance(0.3) }
    const roll = r()
    if (prior.length && roll < 0.3) {
      // A subtype of an earlier type, maybe of two in one hierarchy.
      const sup = r.pick(prior)
      e.supers.push(sup.id)
      const same = prior.filter(p => p.id !== sup.id && rootOf(d, p.id) === rootOf(d, sup.id))
      if (same.length && r.chance(0.35)) e.supers.push(r.pick(same).id)
      // A preferred identifier of its own: its instances are its own cells,
      // and subtypeMappings say which supertype instance each one is.
      if (r.chance(0.35)) { e.refMode = vt(`${name}Nr`, TEXT); e.ownId = true }
    } else if (prior.some(p => !p.supers.length) && roll < 0.45) {
      // A composite identifier: an earlier root and a number.
      const part = r.pick(prior.filter(p => !p.supers.length))
      e.composite = { partEntity: part.id, partValue: vt(`${name}Code`, TEXT) }
    } else {
      e.refMode = vt(`${name}Nr`, TEXT)
    }
    d.entities.push(e)
  }
  const ents = d.entities
  const shared = [vt('Name', TEXT), vt('Amount', INT)]
  const nF = r.int(1, 6)
  for (let i = 0; i < nF; i++) {
    const E = r.pick(ents).id
    const kind = r.pick(['attr', 'attr', 'rel', 'rel', 'unary', 'ternary'])
    const f = { id: `f${i}`, kind }
    if (kind === 'attr') {
      f.players = [E, r.chance(0.5) ? r.pick(shared) : vt(`V${i}`, r.chance(0.5) ? TEXT : INT)]
      f.ucs = r.pick([[[0]], [[0]], [[1]], [[0], [1]], [[0, 1]]])
    } else if (kind === 'rel') {
      f.players = [E, r.pick(ents).id]
      f.ucs = r.pick([[[0]], [[1]], [[0], [1]], [[0, 1]]])
    } else if (kind === 'unary') {
      f.players = [E]
      f.ucs = [[0]]
    } else {
      f.players = [E, r.pick(ents).id, r.pick(shared)]
      f.ucs = r.pick([[[0, 1, 2]], [[0, 1]]])
    }
    f.mandatory = f.players.map((p, k) => p.startsWith('ot_') && kind !== 'unary' && r.chance(0.25) && k === 0)
    d.facts.push(f)
  }
  // Objectified fact types: some binaries between entity types and ternaries,
  // identified through their link fact types (an instance's cell is the
  // tuple), each playing in a fact type or two of its own.
  for (const f of [...d.facts]) {
    if (!(f.kind === 'rel' || f.kind === 'ternary') || !r.chance(0.35)) continue
    f.objectified = true
    f.independent = r.chance(0.4)
    if (r.chance(0.3)) f.identifier = [...f.ucs].sort((a, b) => a.length - b.length)[0]
    const n = r.int(1, 2)
    for (let j = 0; j < n; j++) {
      const g = { id: `${f.id}n${j}`, kind: r.pick(['attr', 'rel']) }
      if (g.kind === 'attr') { g.players = [f.id, r.chance(0.5) ? r.pick(shared) : vt(`V${f.id}n${j}`, INT)]; g.ucs = r.pick([[[0]], [[0]], [[0, 1]]]) }
      else { g.players = r.chance(0.5) ? [f.id, r.pick(ents).id] : [r.pick(ents).id, f.id]; g.ucs = r.pick([[[0]], [[1]], [[0, 1]]]) }
      g.mandatory = g.players.map(p => p === f.id && r.chance(0.3))
      d.facts.push(g)
    }
  }
  // External constraints: inclusive-/exclusive-or over roles of one player,
  // exclusion, subset and equality between roles (or role pairs) with the
  // same players, and an external uniqueness over the far roles of two
  // binaries sharing a player (its query and target inferred by the store).
  d.ext = []
  const roles = d.facts.flatMap(f => f.players.map((p, i) => ({ fid: f.id, i, p })))
    .filter(x => !d.values.some(v => v.id === x.p))
  const nX = r.int(0, 3)
  for (let k = 0; k < nX; k++) {
    const kind = r.pick(['or', 'or', 'set', 'set', 'pair', 'uc'])
    const id = `x${k}`
    if (kind === 'or' || kind === 'set') {
      const a = r.pick(roles)
      const others = roles.filter(x => x.p === a.p && x.fid !== a.fid)
      if (!a || !others.length) continue
      const b = r.pick(others)
      const seqs = [[{ fid: a.fid, i: a.i }], [{ fid: b.fid, i: b.i }]]
      if (kind === 'or') d.ext.push({ id, type: r.chance(0.4) ? 'exclusiveOr' : 'inclusiveOr', player: a.p, seqs })
      else d.ext.push({ id, type: r.pick(['exclusion', 'subset', 'subset', 'equality']), seqs })
    } else if (kind === 'pair') {
      const bins = d.facts.filter(f => f.players.length === 2)
      const f = r.pick(bins)
      if (!f) continue
      const same = bins.filter(g => g.id !== f.id && [...g.players].sort().join() === [...f.players].sort().join())
      if (!same.length) continue
      const g = r.pick(same)
      const j0 = g.players[0] === f.players[0] ? 0 : 1
      d.ext.push({ id, type: r.pick(['exclusion', 'subset', 'equality']), seqs: [[{ fid: f.id, i: 0 }, { fid: f.id, i: 1 }], [{ fid: g.id, i: j0 }, { fid: g.id, i: 1 - j0 }]] })
    } else {
      const bins = d.facts.filter(f => f.players.length === 2)
      const pairs = []
      for (const f of bins) for (const g of bins) if (f.id < g.id) for (let i = 0; i < 2; i++) for (let j = 0; j < 2; j++)
        if (f.players[i] === g.players[j] && d.entities.some(e => e.id === f.players[i])) pairs.push({ f, i, g, j })
      if (!pairs.length) continue
      const { f, i, g, j } = r.pick(pairs)
      d.ext.push({ id, type: 'uniqueness', target: f.players[i], near: [{ fid: f.id, i }, { fid: g.id, i: j }], seqs: [[{ fid: f.id, i: 1 - i }, { fid: g.id, i: 1 - j }]] })
    }
  }
  return d
}

const objectifiedOf = (d, id) => d.facts.find(f => f.id === id && f.objectified)

// Drops the tuples that use an instance of an objectified fact type that is
// no longer there (its tuple removed), until none do.
function cascadeNested(d, facts) {
  for (let changed = true; changed;) {
    changed = false
    for (const g of d.facts) {
      const before = (facts[g.id] ?? []).length
      facts[g.id] = (facts[g.id] ?? []).filter(t => t.every((c, i) => {
        const o = objectifiedOf(d, g.players[i])
        return !o || (facts[o.id] ?? []).some(x => key(x) === key(c))
      }))
      if (facts[g.id].length !== before) changed = true
    }
  }
  return facts
}

function rootOf(d, id) {
  const e = d.entities.find(x => x.id === id)
  return e?.supers.length ? rootOf(d, e.supers[0]) : id
}

// The description as a model file.
function toModel(d, pop) {
  const objectTypes = [], factTypes = [], subtypes = [], externalConstraints = []
  const role = (id, ot, extra = {}) => ({ id, objectTypeId: ot, roleName: '', mandatory: false, ...extra })
  for (const v of d.values) objectTypes.push({ id: v.id, kind: 'value', name: v.name, x: 0, y: 0, schemaId: S, datatypeAssignment: v.dt })
  for (const e of d.entities) {
    objectTypes.push({ id: e.id, kind: 'entity', name: e.name, x: 0, y: 0, schemaId: S, isIndependent: e.independent })
    if (e.refMode) factTypes.push({ id: `${e.id}_ref`, kind: 'fact', x: 0, y: 0, arity: 2, schemaId: S,
      roles: [role(`${e.id}_r0`, e.id, { mandatory: true }), role(`${e.id}_r1`, e.refMode)], readingParts: ['', 'has', ''],
      uniqueness: [{ id: `${e.id}_u0`, roles: [0] }, { id: `${e.id}_u1`, roles: [1] }], preferredUniqueness: [[1]] })
    if (e.composite) {
      const { partEntity, partValue } = e.composite
      factTypes.push({ id: `${e.id}_p0`, kind: 'fact', x: 0, y: 0, arity: 2, schemaId: S,
        roles: [role(`${e.id}_p0r0`, e.id, { mandatory: true }), role(`${e.id}_p0r1`, partEntity)], readingParts: ['', 'is in', ''],
        uniqueness: [{ id: `${e.id}_p0u`, roles: [0] }] })
      factTypes.push({ id: `${e.id}_p1`, kind: 'fact', x: 0, y: 0, arity: 2, schemaId: S,
        roles: [role(`${e.id}_p1r0`, e.id, { mandatory: true }), role(`${e.id}_p1r1`, partValue)], readingParts: ['', 'has', ''],
        uniqueness: [{ id: `${e.id}_p1u`, roles: [0] }] })
      externalConstraints.push({ id: `${e.id}_pid`, kind: 'constraint', constraintType: 'uniqueness', x: 0, y: 0, schemaId: S,
        sequences: [[{ kind: 'role', factId: `${e.id}_p0`, roleIndex: 1 }, { kind: 'role', factId: `${e.id}_p1`, roleIndex: 1 }]],
        queries: [{ free: [{ id: 'q0', typeId: partEntity }, { id: 'q1', typeId: partValue }], target: { id: 't', typeId: e.id },
          body: { t: 'and', args: [{ t: 'fact', factId: `${e.id}_p0`, args: ['t', 'q0'] }, { t: 'fact', factId: `${e.id}_p1`, args: ['t', 'q1'] }] } }],
        targetObjectTypeId: e.id, isPreferredIdentifier: true, frequency: null, exhaustive: true, exclusive: false, subtypeIds: [] })
    }
    e.supers.forEach((s, k) => subtypes.push({ id: `st_${e.id}_${k}`, kind: 'subtype', subId: e.id, superId: s, inheritsPreferredIdentifier: !e.ownId && k === 0, schemaId: S }))
  }
  const name = (id) => d.entities.find(e => e.id === id)?.name ?? d.values.find(v => v.id === id)?.name ?? (objectifiedOf(d, id) ? `O${id}` : id)
  for (const f of d.facts) {
    const words = f.kind === 'unary' ? ['', `is p${f.id}`] : f.players.length === 2 ? ['', `r${f.id}`, ''] : ['', `r${f.id}`, 'with', '']
    factTypes.push({ id: f.id, kind: 'fact', x: 0, y: 0, arity: f.players.length, schemaId: S,
      roles: f.players.map((p, k) => role(`${f.id}_r${k}`, p, { mandatory: !!f.mandatory[k], roleName: f.players.length > 1 && f.players.filter(q => q === p).length > 1 ? `${name(p).toLowerCase()}${k}` : '' })),
      readingParts: words, uniqueness: f.ucs.map((u, k) => ({ id: `${f.id}_u${k}`, roles: u })),
      ...(f.objectified ? { objectified: true, objectifiedKind: 'entity', objectifiedName: `O${f.id}`, isIndependent: !!f.independent, objectifiedIdentifier: f.identifier ?? null } : {}) })
  }
  for (const x of d.ext ?? []) externalConstraints.push({ id: x.id, kind: 'constraint', constraintType: x.type, x: 0, y: 0, schemaId: S,
    sequences: x.seqs.map(q => q.map(({ fid, i }) => ({ kind: 'role', factId: fid, roleIndex: i }))), queries: x.seqs.map(() => null),
    targetObjectTypeId: x.target ?? null, isPreferredIdentifier: false, frequency: null,
    exhaustive: x.type === 'inclusiveOr' || x.type === 'exclusiveOr', exclusive: x.type === 'exclusiveOr', subtypeIds: [] })
  if (pop?.factPopulations) pop = { ...pop, factPopulations: cascadeNested(d, clone(pop.factPopulations)) }
  return {
    version: 3,
    schema: { schemas: [{ id: S, name: 'S', profile: 'orm2' }], objectTypes, factTypes, subtypes, externalConstraints },
    diagrams: [{ id: 'd1', name: 'S', schemaId: S, occurrences: [] }], activeDiagramId: 'd1',
    ...(pop?.objs ? materialise(d, pop) : { populations: pop?.populations ?? {}, factPopulations: pop?.factPopulations ?? {} }),
  }
}

// ── Populations ─────────────────────────────────────────────────────────────
// Cells are the reference values (inherited ones for subtypes), a list of the
// parts for a composite identifier. Built legal by construction, then
// repaired by removing objects that miss a mandatory role or, for types that
// are not independent, play no role besides their identification.

function genPopulation(d, r) {
  const pops = {}, facts = {}
  // objs[entity] maps each object (by the key of its root type's cell) to its
  // cell in that entity type: its own identifier's value for a subtype with
  // one, else the cell of the type it inherits its identifier from.
  const objs = {}
  const add = (id, c) => { pops[id] = pops[id] ?? []; if (!pops[id].some(x => key(x) === key(c))) pops[id].push(c) }
  for (const e of d.entities) {
    objs[e.id] = {}
    if (e.supers.length) {
      // Objects of every supertype.
      let n = 0
      for (const rk of Object.keys(objs[e.supers[0]] ?? {})) {
        if (!e.supers.every(s => objs[s]?.[rk] !== undefined) || !r.chance(0.6)) continue
        if (e.ownId) {
          const c = `${e.name.toLowerCase()}k${++n}`
          objs[e.id][rk] = c; add(e.refMode, c); facts[`${e.id}_ref`] = [...(facts[`${e.id}_ref`] ?? []), [c, c]]
        } else objs[e.id][rk] = objs[e.supers[0]][rk]
      }
      pops[e.id] = Object.values(objs[e.id])
      continue
    }
    const n = r.int(0, 4)
    for (let k = 1; k <= n; k++) {
      if (e.refMode) { const c = `${e.name.toLowerCase()}k${k}`; objs[e.id][key(c)] = c; add(e.refMode, c); facts[`${e.id}_ref`] = [...(facts[`${e.id}_ref`] ?? []), [c, c]] }
      else {
        const parts = Object.values(objs[e.composite.partEntity] ?? {})
        if (!parts.length) continue
        const c = [r.pick(parts), `c${k}`]
        if (objs[e.id][key(c)] !== undefined) continue
        objs[e.id][key(c)] = c; add(e.composite.partValue, c[1])
        facts[`${e.id}_p0`] = [...(facts[`${e.id}_p0`] ?? []), [c, c[0]]]
        facts[`${e.id}_p1`] = [...(facts[`${e.id}_p1`] ?? []), [c, c[1]]]
      }
    }
    pops[e.id] = Object.values(objs[e.id])
  }
  const effective = (id) => {
    if (objectifiedOf(d, id)) return facts[id] ?? []
    const out = new Map((pops[id] ?? []).map(c => [key(c), c]))
    if (!d.entities.some(e => e.id === id)) for (const v of valueCands(id)) out.set(key(v), v)
    return [...out.values()]
  }
  const valueCands = (id) => {
    const v = d.values.find(x => x.id === id)
    if (!v) return []
    return v.dt.datatypeId === 'integer' ? ['1', '2', '3', '4'] : ['a', 'b', 'c', 'd']
  }
  for (const f of d.facts) {
    const cands = f.players.map(effective)
    const out = []
    if (cands.every(c => c.length)) for (let t = 0; t < r.int(0, 6); t++) {
      const tuple = cands.map(c => r.pick(c))
      if (f.ucs.some(u => out.some(o => u.every(k => key(o[k]) === key(tuple[k]))))) continue
      out.push(tuple)
    }
    facts[f.id] = out
    f.players.forEach((p, k) => { if (d.values.some(v => v.id === p)) for (const t of out) add(p, t[k]) })
  }
  repairPopulation(d, pops, facts, objs)
  return { populations: pops, factPopulations: facts, objs }
}

// The model's populations from objs: each entity type's cells, and for each
// subtype link that does not inherit the identifier, the supertype cell of
// each of the subtype's instances (subtypeMappings, row by row).
function materialise(d, pop) {
  const populations = { ...pop.populations }, subtypeMappings = {}
  for (const e of d.entities) {
    const objs = pop.objs[e.id] ?? {}
    populations[e.id] = Object.values(objs)
    e.supers.forEach((s, k) => {
      if (!e.ownId && k === 0) return
      subtypeMappings[`st_${e.id}_${k}`] = Object.keys(objs).map(rk => {
        const c = pop.objs[s]?.[rk]
        return Array.isArray(c) ? c : [c]
      })
    })
  }
  return { populations, factPopulations: pop.factPopulations, subtypeMappings }
}

// Removes the instances that break a mandatory role or implicit
// participation, with everything that uses them, until none do.
function repairPopulation(d, pops, facts, objs) {
  const subsOf = (id) => d.entities.filter(e => e.supers.includes(id)).map(e => e.id)
  const below = (id) => [...new Set([id, ...subsOf(id).flatMap(below)])]
  // An object (by root key) out of a type and every type below it, with the
  // tuples that use its cell there.
  const remove = (typeId, rk) => {
    for (const id of below(typeId)) {
      const c = objs[id]?.[rk]
      if (c === undefined) continue
      delete objs[id][rk]
      pops[id] = Object.values(objs[id])
      for (const [fid, ts] of Object.entries(facts)) {
        const players = playersOf(d, fid)
        facts[fid] = ts.filter(t => !t.some((x, i) => players[i] === id && key(x) === key(c)))
      }
      // Composite identifiers that use it.
      for (const e of d.entities.filter(x => x.composite && x.composite.partEntity === id))
        for (const [rk2, x] of Object.entries(objs[e.id] ?? {})) if (key(x[0]) === key(c)) remove(e.id, rk2)
    }
  }
  for (let round = 0; round < 50; round++) {
    let changed = false
    cascadeNested(d, facts)
    // External constraints: tuples out of the second sequence (or the
    // subset side), and objects out that play none of an or-constraint's roles.
    for (const x of d.ext ?? []) {
      const proj = (q, t) => key(q.map(s => t[s.i]))
      const projOf = (q) => new Set((facts[q[0].fid] ?? []).map(t => proj(q, t)))
      const keepOnly = (q, keep) => {
        const ts = facts[q[0].fid] ?? []
        facts[q[0].fid] = ts.filter(t => keep(proj(q, t)))
        if (facts[q[0].fid].length !== ts.length) changed = true
      }
      const [A, B] = x.seqs
      if (x.type === 'uniqueness') {
        // At most one instance of the target per combination of far values.
        const [a, b] = x.near
        const farA = new Map()
        for (const t of facts[a.fid] ?? []) { const k = key(t[a.i]); farA.set(k, [...(farA.get(k) ?? []), key(t[1 - a.i])]) }
        const seen = new Map()
        const ts = facts[b.fid] ?? []
        facts[b.fid] = ts.filter(t => {
          const e = key(t[b.i]), combos = (farA.get(e) ?? []).map(va => `${va}|${key(t[1 - b.i])}`)
          if (combos.some(c => seen.has(c) && seen.get(c) !== e)) return false
          combos.forEach(c => seen.set(c, e))
          return true
        })
        if (facts[b.fid].length !== ts.length) changed = true
        continue
      }
      if (x.type === 'exclusion' || x.type === 'exclusiveOr') { const inA = projOf(A); keepOnly(B, k => !inA.has(k)) }
      if (x.type === 'subset' || x.type === 'equality') { const inB = projOf(B); keepOnly(A, k => inB.has(k)) }
      if (x.type === 'equality') { const inA = projOf(A); keepOnly(B, k => inA.has(k)) }
      if (x.type === 'inclusiveOr' || x.type === 'exclusiveOr') {
        const played = new Set(x.seqs.flatMap(q => [...projOf(q)]))
        const o = objectifiedOf(d, x.player)
        if (o) {
          const ts = facts[o.id] ?? []
          facts[o.id] = ts.filter(t => played.has(key([t])))
          if (facts[o.id].length !== ts.length) changed = true
        } else for (const [rk, c] of Object.entries({ ...(objs[x.player] ?? {}) }))
          if (objs[x.player]?.[rk] !== undefined && !played.has(key([c]))) { remove(x.player, rk); changed = true }
      }
    }
    cascadeNested(d, facts)
    // Instances of objectified fact types that miss a mandatory role, or play
    // nothing while not independent: their tuples out.
    for (const o of d.facts.filter(f => f.objectified)) {
      facts[o.id] = (facts[o.id] ?? []).filter(t => {
        const plays = (g, i) => (facts[g.id] ?? []).some(x => key(x[i]) === key(t))
        const missed = d.facts.some(g => g.players.some((p, i) => p === o.id && g.mandatory[i] && !plays(g, i)))
        const none = !o.independent && !d.facts.some(g => g.players.some((p, i) => p === o.id && plays(g, i)))
        if (missed || none) { changed = true; return false }
        return true
      })
    }
    cascadeNested(d, facts)
    for (const e of d.entities) {
      for (const [rk, c] of Object.entries({ ...(objs[e.id] ?? {}) })) {
        if (objs[e.id]?.[rk] === undefined) continue
        const plays = (fid, i, cell) => (facts[fid] ?? []).some(t => key(t[i]) === key(cell))
        const mandatoryMissed = d.facts.some(f => f.players.some((p, i) => p === e.id && f.mandatory[i] && !plays(f.id, i, c)))
        // Implicit participation: some role besides identification, its own or a supertype's/subtype's.
        const hier = d.entities.filter(x => rootOf(d, x.id) === rootOf(d, e.id) && objs[x.id]?.[rk] !== undefined).map(x => x.id)
        const playsAny = d.facts.some(f => f.players.some((p, i) => hier.includes(p) && plays(f.id, i, objs[p][rk])))
          || d.entities.some(x => x.composite && hier.includes(x.composite.partEntity) && (facts[`${x.id}_p0`] ?? []).some(t => key(t[1]) === key(objs[x.composite.partEntity][rk])))
        const notIndep = !e.independent && !playsAny
        if (mandatoryMissed || notIndep) { remove(e.id, rk); changed = true }
      }
    }
    if (!changed) break
  }
  // Values left with nothing using them (a removed instance's reference value).
  for (const v of d.values) {
    const used = new Set()
    for (const [fid, ts] of Object.entries(facts)) playersOf(d, fid).forEach((p, i) => { if (p === v.id) for (const t of ts) used.add(key(t[i])) })
    for (const e of d.entities) for (const c of pops[e.id] ?? []) {
      if (e.refMode === v.id) used.add(key(c))
      if (e.composite?.partValue === v.id) used.add(key(c[1]))
    }
    if (pops[v.id]) pops[v.id] = pops[v.id].filter(c => used.has(key(c)))
  }
}

function playersOf(d, fid) {
  const f = d.facts.find(x => x.id === fid)
  if (f) return f.players
  for (const e of d.entities) {
    if (fid === `${e.id}_ref`) return [e.id, e.refMode]
    if (fid === `${e.id}_p0`) return [e.id, e.composite.partEntity]
    if (fid === `${e.id}_p1`) return [e.id, e.composite.partValue]
  }
  return []
}

// ── One case ────────────────────────────────────────────────────────────────

const store = () => useOrmStore.getState()
const brief = (issues, n = 3) => issues.slice(0, n).map(i => i.message ?? i.kind).join('; ') + (issues.length > n ? ` (+${issues.length - n})` : '')
const lossOf = (rt) => rt.compare.filter(c => c.lost || c.gained).map(c => `${c.name}: ${c.lost ? `lost ${c.lost}` : ''}${c.gained ? ` gained ${c.gained}` : ''} ${c.examples.slice(0, 2).join(', ')}`.trim())

// Generates T and M for a model; null when S is not legal (a generator gap).
function prepare(model, sur = { mode: 'never', overrides: {} }) {
  store().loadModel(clone(model), null)
  const sIssues = resultIssues(store(), S)
  if (sIssues.length) return { illegal: sIssues }
  store().generateRelationalFromOrm(S, { diagrams: false, assertions: true, surrogates: sur.mode, overrides: sur.overrides })
  const st = store()
  const m = st.mappings.at(-1)
  return { st, m, T: m.targetSchemaId }
}

// The facts of one schema's population that may be changed: not identifying
// (their tuples are not stored; an instance's cells are its identifier).
function mutable(st, schemaId) {
  const ident = new Set([...identifiedRoles(st)].map(k => k.split(':')[0]))
  return st.facts.filter(f => f.schemaId === schemaId && !ident.has(f.id) && !f.derivationRule && !f.derived)
}

// A mutation of a schema's population: a tuple removed, a cell changed to
// another instance of its role's player, or a tuple added.
function mutate(st, schemaId, r) {
  const facts = mutable(st, schemaId)
  if (!facts.length) return null
  const f = r.pick(facts)
  const tuples = [...(st.factPopulations[f.id] ?? [])]
  const cands = (i) => {
    const p = f.roles[i].objectTypeId
    const fromFacts = st.facts.filter(g => g.schemaId === schemaId).flatMap(g => (st.factPopulations[g.id] ?? []).flatMap(t => t.filter((_, j) => g.roles[j]?.objectTypeId === p)))
    return [...new Map([...(st.populations[p] ?? []), ...fromFacts].map(c => [key(c), c])).values()]
  }
  const op = tuples.length ? r.pick(['remove', 'change', 'add']) : 'add'
  let desc
  if (op === 'remove') { const k = r.int(0, tuples.length - 1); desc = `removed ${key(tuples[k])} from ${f.id}`; tuples.splice(k, 1) }
  else if (op === 'change') {
    const k = r.int(0, tuples.length - 1), i = r.int(0, f.roles.length - 1)
    const c = cands(i).filter(x => key(x) !== key(tuples[k][i]))
    if (!c.length) return null
    const t = [...tuples[k]]; t[i] = r.pick(c)
    if (tuples.some(x => key(x) === key(t))) return null   // a set: no duplicates
    desc = `changed ${key(tuples[k])} to ${key(t)} in ${f.id}`; tuples[k] = t
  } else {
    const t = f.roles.map((_, i) => { const c = cands(i); return c.length ? r.pick(c) : null })
    if (t.some(x => x == null) || tuples.some(x => key(x) === key(t))) return null
    desc = `added ${key(t)} to ${f.id}`; tuples.push(t)
  }
  return { state: withoutUnusedValues({ ...st, factPopulations: { ...st.factPopulations, [f.id]: tuples } }, schemaId), desc, factId: f.id }
}

// The state with each value type of a schema holding only the values that a
// tuple or an instance's identifier uses, so that a removed tuple does not
// leave a value that plays nothing (an artefact of how mutations are made).
function withoutUnusedValues(st, schemaId) {
  const used = new Map()   // value type → Set of values
  const use = (vt, c) => { if (!used.has(vt)) used.set(vt, new Set()); (Array.isArray(c) ? c.flat(9) : [c]).forEach(x => used.get(vt).add(String(x))) }
  const ident = new Set(identifiedRoles(st))
  for (const f of st.facts) {
    if (f.schemaId !== schemaId) continue
    const idRole = f.roles.findIndex((_, i) => ident.has(`${f.id}:${i}`))
    if (idRole >= 0) {
      // An identifying fact: its values are the identified instances' cells.
      f.roles.forEach((r, i) => { if (i !== idRole) for (const c of st.populations[f.roles[idRole].objectTypeId] ?? []) use(r.objectTypeId, c) })
      continue
    }
    for (const t of st.factPopulations[f.id] ?? []) f.roles.forEach((r, i) => use(r.objectTypeId, t[i]))
  }
  const populations = { ...st.populations }
  for (const o of st.objectTypes) if (o.schemaId === schemaId && o.kind === 'value' && !o.isIndependent && populations[o.id])
    populations[o.id] = populations[o.id].filter(c => used.get(o.id)?.has(String(c)))
  return { ...st, populations }
}

// The failures of one model: [{ prop, text }].
function check(model, seed, sur) {
  const out = []
  const want = (p) => !ONLY || ONLY.includes(p)
  let prep
  try { prep = prepare(model, sur) } catch (err) { return [{ prop: 'crash', text: `Generate tables failed: ${err.stack?.split('\n').slice(0, 3).join(' | ')}` }] }
  if (prep.illegal) return [{ prop: 'gen', text: `generated population of S is not legal: ${brief(prep.illegal)}` }]
  const { st, m, T } = prep
  const fail = (prop, text) => out.push({ prop, text })
  try {
    if (want('P1')) { const iss = resultIssues(st, T); if (iss.length) fail('P1', `image breaks Σ_T: ${brief(iss)}`) }
    if (want('P2')) { const rt = roundTrip(st, m, 'forward'); const l = lossOf(rt); if (l.length) fail('P2', `S → T → S differs: ${l.join('; ')}`) }
    const r = rng(seed * 7919 + 13)
    for (let k = 0; k < MUTATIONS; k++) {
      // Mutations of the image (P3, Pd).
      if (want('P3') || want('Pd')) {
        const mu = mutate(st, T, r)
        if (mu) {
          const legalT = !resultIssues(mu.state, T).length
          const back = runMapping(mu.state, m, 'backward')
          const s2 = { ...mu.state, ...withRunApplied(mu.state, back) }
          const sIss = resultIssues(s2, S)
          const rt = roundTrip(mu.state, m, 'backward')
          const l = lossOf(rt)
          if (legalT && want('P3')) {
            if (sIss.length) fail('P3', `legal J′ (${mu.desc}) comes back to an illegal I′: ${brief(sIss)}`)
            else if (l.length) fail('P3', `legal J′ (${mu.desc}) does not come back: ${l.join('; ')}`)
          }
          if (!legalT && want('Pd') && !sIss.length && !l.length)
            fail('Pd', `illegal J′ (${mu.desc}: ${brief(resultIssues(mu.state, T), 1)}) comes back unchanged through a legal I′`)
        }
      }
      // Mutations of S (Pb, and P1/P2 on legal ones).
      if (want('Pb') || want('P1') || want('P2')) {
        const mu = mutate(st, S, r)
        if (mu) {
          const sIss = resultIssues(mu.state, S)
          const there = runMapping(mu.state, m, 'forward')
          const t1 = { ...mu.state, ...withRunApplied(mu.state, there) }
          const t2 = { ...t1, ...numberInvented(t1, T) }   // (invented surrogates numbered, as a database would)
          const tIss = resultIssues(t2, T)
          // Only when I′ is all there in J′: a run there that drops part of I′
          // (an instance no rule reads on its own) relates it to a smaller I.
          const whole = sIss.length && !tIss.length && !lossOf(roundTrip(mu.state, m, 'forward')).length
          if (whole && want('Pb')) fail('Pb', `illegal I′ (${mu.desc}: ${brief(sIss, 1)}) runs to a legal J′`)
          if (!sIss.length && tIss.length && want('P1')) fail('P1', `legal I′ (${mu.desc}) runs to an illegal J′: ${brief(tIss)}`)
          if (!sIss.length && want('P2')) { const l = lossOf(roundTrip(mu.state, m, 'forward')); if (l.length) fail('P2', `legal I′ (${mu.desc}) does not come back: ${l.join('; ')}`) }
        }
      }
    }
    if (EQUIV && want('P4')) {
      const eq = equivalence(st, m)
      if (eq.verdict === 'not') {
        const why = ['source', 'target'].flatMap(X => [...eq.info[X].lost.map(x => `${x.name}: ${x.reason}`), ...eq.info[X].unmapped.map(x => `${x.name} unmapped`), ...eq.constraints[X].lost.map(x => `${x.label ?? x.key} lost`)])
        fail('P4', `equivalence says not: ${why.slice(0, 4).join('; ')}`)
      }
    }
    if (PG && want('P5')) out.push(...pgCheck(st, T, rng(seed * 31 + 7)))
  } catch (err) {
    fail('crash', err.stack?.split('\n').slice(0, 4).join(' | '))
  }
  return out
}

// ── P5: PostgreSQL ──────────────────────────────────────────────────────────

let pg = null
function pgStart() {
  if (pg) return pg
  const bin = ['/usr/lib/postgresql/16/bin', '/opt/homebrew/opt/postgresql@16/bin', '/usr/local/opt/postgresql@16/bin'].find(b => fs.existsSync(path.join(b, 'initdb')))
  if (!bin) throw new Error('--pg: initdb not found (PostgreSQL 16)')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rmap-pg-'))
  const port = String(55432 + Math.floor(Math.random() * 1000))
  const asUser = process.getuid?.() === 0 ? ['runuser', '-u', 'postgres', '--'] : []
  if (asUser.length) execFileSync('chown', ['postgres', dir])
  const run = (cmd, a) => execFileSync(asUser[0] ?? path.join(bin, cmd), asUser.length ? [...asUser.slice(1), path.join(bin, cmd), ...a] : a, { stdio: 'pipe' })
  run('initdb', ['-D', dir, '-A', 'trust', '-U', 'postgres'])
  run('pg_ctl', ['-D', dir, '-o', `-p ${port} -k ${dir}`, '-l', path.join(dir, 'log'), '-w', 'start'])
  pg = { bin, dir, port, run, n: 0 }
  process.on('exit', () => { try { run('pg_ctl', ['-D', dir, '-m', 'immediate', 'stop']) } catch { /* gone */ } })
  return pg
}
function psql(db, sql) {
  const p = pgStart()
  const res = spawnSync(path.join(p.bin, 'psql'), ['-h', p.dir, '-p', p.port, '-U', 'postgres', '-d', db, '-v', 'ON_ERROR_STOP=1', '-q', '-X'], { input: sql, encoding: 'utf8' })
  return { ok: res.status === 0, err: (res.stderr || '').trim().split('\n')[0] }
}
function pgCheck(st, T, r) {
  const out = []
  const ddl = exportPostgresDdl(st, T)
  const sql = typeof ddl === 'string' ? ddl : ddl.sql
  const fresh = () => { const db = `t${++pgStart().n}`; psql('postgres', `CREATE DATABASE ${db};`); return db }
  const db = fresh()
  const made = psql(db, sql)
  if (!made.ok) return [{ prop: 'P5', text: `DDL refused: ${made.err}` }]
  const rows = populationSql(st, T, { format: 'insert' })
  const ins = psql(db, typeof rows === 'string' ? rows : rows.sql)
  if (!ins.ok) out.push({ prop: 'P5', text: `the image's rows are refused: ${ins.err}` })
  for (let k = 0; k < MUTATIONS; k++) {
    const mu = mutate(st, T, r)
    if (!mu) continue
    const iss = resultIssues(mu.state, T)
    // A row with two values in one column cannot be written as SQL rows.
    if (!iss.length || iss.some(i => i.kind === 'uniquenessViolation' && i.factId === mu.factId && String(i.roleIndices) === '0')) continue
    const db2 = fresh()
    psql(db2, sql)
    const rows2 = populationSql(mu.state, T, { format: 'insert' })
    const res = psql(db2, typeof rows2 === 'string' ? rows2 : rows2.sql)
    if (res.ok) out.push({ prop: 'P5', text: `PostgreSQL accepts an illegal J′ (${mu.desc}: ${brief(iss, 1)})` })
  }
  return out
}

// ── Shrinking ───────────────────────────────────────────────────────────────

function shrink(d, pop, seed, prop) {
  const fails = (dd, pp) => { try { return check(toModel(dd, pp), seed, dd.sur).some(f => f.prop === prop) } catch { return false } }
  let cur = { d: clone(d), pop: clone(pop) }
  for (let changed = true, rounds = 0; changed && rounds < 20; rounds++) {
    changed = false
    const tries = []
    cur.d.facts.forEach((f0, i) => cur.d.facts.some(g => g.players.includes(f0.id)) || tries.push(() => { const x = clone(cur); const f = x.d.facts.splice(i, 1)[0]; delete x.pop.factPopulations[f.id]; x.d.ext = (x.d.ext ?? []).filter(c => ![...c.seqs.flat(), ...(c.near ?? [])].some(s => s.fid === f.id)); return x }))
    ;(cur.d.ext ?? []).forEach((_, i) => tries.push(() => { const x = clone(cur); x.d.ext.splice(i, 1); return x }))
    cur.d.entities.forEach((e, i) => {
      if (cur.d.entities.some(o => o.supers.includes(e.id) || o.composite?.partEntity === e.id) || cur.d.facts.some(f => f.players.includes(e.id))) return
      tries.push(() => { const x = clone(cur); x.d.entities.splice(i, 1); delete x.pop.populations[e.id]; delete x.pop.objs[e.id]; for (const k of Object.keys(x.pop.factPopulations)) if (k.startsWith(`${e.id}_`)) delete x.pop.factPopulations[k]; return x })
    })
    for (const [fid, ts] of Object.entries(cur.pop.factPopulations)) ts.forEach((_, i) => {
      if (/_ref$|_p[01]$/.test(fid)) return
      tries.push(() => { const x = clone(cur); x.pop.factPopulations[fid].splice(i, 1); return x })
    })
    for (const e of cur.d.entities.filter(o => !o.supers.length)) for (const rk of Object.keys(cur.pop.objs[e.id] ?? {})) tries.push(() => {
      // An object out of its hierarchy, with the tuples using any of its cells.
      const x = clone(cur)
      const cells = []
      for (const o of x.d.entities.filter(o => rootOf(x.d, o.id) === e.id)) {
        const c = x.pop.objs[o.id]?.[rk]
        if (c === undefined) continue
        cells.push(key(c)); delete x.pop.objs[o.id][rk]
      }
      for (const [fid, ts] of Object.entries(x.pop.factPopulations)) x.pop.factPopulations[fid] = ts.filter(t => !t.some(y => cells.includes(key(y)) || (Array.isArray(y) && cells.includes(key(y[0])))))
      return x
    })
    for (const t of tries) {
      const x = t()
      if (fails(x.d, x.pop)) { cur = x; changed = true; break }
    }
  }
  return cur
}

// ── Main ────────────────────────────────────────────────────────────────────

fs.mkdirSync(OUT, { recursive: true })
const counts = {}, firsts = new Map()
const t0 = Date.now()
let gaps = 0
for (let run = 0; run < RUNS; run++) {
  const seed = SEED + run
  const r = rng(seed)
  const d = genSchema(r)
  const pop = genPopulation(d, r)
  // Surrogates (decision Q4): never, for composite identifiers, or always,
  // with an override for a type now and then. (Drawn after the schema and
  // its population, so that a seed gives the same schema as before.)
  d.sur = { mode: SURROGATES ?? r.pick(['never', 'never', 'composite', 'always']), overrides: {} }
  for (const e of d.entities) if (!e.supers.length && r.chance(0.15)) d.sur.overrides[e.id] = r.chance(0.5)
  // --save: every generated schema S with its population, as seed<n>.ffbm.
  if (SAVE) fs.writeFileSync(path.join(OUT, `seed${seed}.ffbm`), JSON.stringify(toModel(d, pop), null, 1))
  const t1 = Date.now()
  const fails = check(toModel(d, pop), seed, d.sur)
  if (VERBOSE && Date.now() - t1 > 20000) console.log(`seed ${seed} took ${((Date.now() - t1) / 1000).toFixed(0)} s`)
  if (fails.some(f => f.prop === 'gen')) { gaps++; if (VERBOSE) console.log(`seed ${seed}: ${fails[0].text}`); continue }
  for (const f of fails) {
    counts[f.prop] = (counts[f.prop] ?? 0) + 1
    if (VERBOSE) console.log(`seed ${seed} ${f.prop} [surrogates ${d.sur.mode}${Object.keys(d.sur.overrides).length ? ' +' + JSON.stringify(d.sur.overrides) : ''}]: ${f.text}`)
    if (!firsts.has(f.prop)) firsts.set(f.prop, { seed, d, pop, text: f.text })
  }
}
console.log(`\n${RUNS} schemas (seeds ${SEED}–${SEED + RUNS - 1}), ${MUTATIONS} mutations each side, ${((Date.now() - t0) / 1000).toFixed(1)} s${gaps ? `; ${gaps} left out (generated population not legal)` : ''}`)
if (!firsts.size) console.log('No failures.')
for (const [prop, f] of firsts) {
  const small = prop === 'crash' || !SHRINK ? { d: f.d, pop: f.pop } : shrink(f.d, f.pop, f.seed, prop)
  const after = check(toModel(small.d, small.pop), f.seed, small.d.sur).find(x => x.prop === prop)
  const file = path.join(OUT, `${prop}-seed${f.seed}.ffbm`)
  // With T and the mapping that Generate tables gave (the store holds them after check).
  let content
  try { content = store().serialize() } catch { content = JSON.stringify(toModel(small.d, small.pop), null, 1) }
  fs.writeFileSync(file, content)
  console.log(`\n${prop}: ${counts[prop]} failing case${counts[prop] === 1 ? '' : 's'}; first at seed ${f.seed}, shrunk to ${small.d.entities.length} entity types and ${small.d.facts.length} fact types → ${file}`)
  console.log(`  ${(after ?? f).text}`)
}
await server.close()
process.exit(firsts.size ? 1 : 0)
