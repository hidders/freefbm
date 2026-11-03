// Constraint accounting (workbench step 10; docs/logic/schema-mappings.tex,
// section "Constraint accounting").
//
// For a mapping between schemas A and B, every constraint χ of A gets a
// status with respect to B, and every constraint of B one with respect to A:
//   native   one constraint of B keeps χ (e.g. a NOT NULL column for a
//            mandatory role, or the structure of B itself);
//   implied  several constraints of B keep χ together;
//   lost     a population of B that satisfies all of B's constraints maps to
//            a population of A that violates χ (the counterexample);
//   unknown  neither was found, or χ is of a kind not checked yet.
//
// The tex document defines the statuses by unfolding χ through the rules into
// a formula χ→B over B. Here the unfolding is done on populations instead:
//   1. the smallest population V of A that violates χ is built from χ's
//      counterexample formula (negative.js), with labelled nulls ⊥1, ⊥2, …
//      for unknown values, so V stands for every violation of its shape;
//   2. the mapping carries V to B (runMapping.js), giving I0;
//   3. I0 is closed under B's constraints (the chase): uniqueness constraints
//      merge labelled nulls, mandatory roles, subset and equality constraints
//      add the facts they ask for, with new labelled nulls;
//   4. the result I is carried back to A. If it still violates χ and I
//      satisfies B's constraints, I is a counterexample: χ is lost. If the
//      chase removed the violation (or found it impossible), χ is kept, and
//      running the chase again without each constraint it used tells which of
//      them were needed: one gives native, several implied.
// Because the chase adds only what B's constraints force, I is the least
// population of B containing I0, so a violation that survives it is real and
// one that does not cannot happen in B (for rules without negation and
// constraints the chase handles; others are checked on I but not chased).
//
// accountMapping(state, mapping) → {
//   sides: { source: [result], target: [result] },   constraints of that side, w.r.t. the other
//   ms, notes: [text],
// }
// result: { key, entry, status: 'native'|'implied'|'lost'|'unknown', reason,
//   by: [{ key, entry, label }],                  the constraints of the other side that keep it
//   counterexample: { lines: [text], violation: text } | null, deontic }

import { formalise } from '../logic/constraintFormulas.js'
import { counterexample } from '../verbalisation/negative.js'
import { computePopulationIssues, projCellKey } from '../utils/populationValidation.js'
import { makePopulationEvaluator, formulaConstraintPopulationIssues } from '../logic/derivedPopulation.js'
import { isFormulaConstraint, formulaElements } from '../logic/formulaConstraint.js'
import { identifyingFactIds } from '../utils/refMode.js'
import { isDeonticUniqueness, isDeonticMandatory } from '../logic/modality.js'
import { relationalModel } from '../relational/relationalModel.js'
import { prepareRun, executeRun, schemeOf } from './runMapping.js'
import { sideContext, sideSchemaId, SIDES, expandSide, asSide } from './mapping.js'
import { plainParts } from '../verbalisation/hyphenBinding.js'

const isFresh = (v) => typeof v === 'string' && v.startsWith('⊥')
const keyOf = (cell) => JSON.stringify(projCellKey(cell))
const other = (side) => (side === 'source' ? 'target' : 'source')

class Unsupported extends Error {}

// ── One schema ───────────────────────────────────────────────────────────────

// Lookups for the schema of one side.
export function worldOf(state, schemaId) {
  const ctx = sideContext(state, schemaId)
  const els = { objectTypes: ctx.objectTypes, facts: ctx.facts, subtypes: ctx.subtypes, constraints: ctx.constraints }
  const supers = new Map()
  for (const st of ctx.subtypes) {
    if (!supers.has(st.subId)) supers.set(st.subId, [])
    supers.get(st.subId).push(st.superId)
  }
  return {
    schemaId, ctx, els, supers,
    ident: identifyingFactIds(els.facts, els.objectTypes, els.constraints),
    relational: ctx.relational ? relationalModel(state, schemaId) : null,
  }
}

const emptyPops = () => ({ populations: {}, factPopulations: {} })
const clonePops = (p) => ({
  populations: Object.fromEntries(Object.entries(p.populations ?? {}).map(([k, v]) => [k, [...v]])),
  factPopulations: Object.fromEntries(Object.entries(p.factPopulations ?? {}).map(([k, v]) => [k, v.map(t => [...t])])),
})
const sizeOf = (p) => Object.values(p.factPopulations).reduce((a, v) => a + v.length, 0) + Object.values(p.populations).reduce((a, v) => a + v.length, 0)
const isIdentifying = (w, factId) => w.ident.entity.has(factId) || w.ident.nested.has(factId)
const playerOf = (w, factId, ri) => w.ctx.factById.get(factId)?.roles[ri]?.objectTypeId

// An instance of a type, with what keeps the stored populations aligned: the
// supertypes have it too, and its reference values are values of their types.
function addInst(w, pops, typeId, cell) {
  if (cell == null || !typeId) return
  const list = pops.populations[typeId] ?? (pops.populations[typeId] = [])
  const k = keyOf(cell)
  if (list.some(c => keyOf(c) === k)) return
  list.push(cell)
  for (const sup of w.supers.get(typeId) ?? []) addInst(w, pops, sup, cell)
  if (w.ctx.otById.get(typeId)?.kind !== 'entity') return
  const sch = schemeOf(typeId, w.els)
  if (sch?.kind === 'refMode' && typeof cell === 'string') addInst(w, pops, sch.rm.vtId, cell)
  if (sch?.kind === 'composite' && Array.isArray(cell)) sch.parts.forEach((p, i) => addInst(w, pops, playerOf(w, p.factId, p.roleIndex), cell[i]))
}

// A fact, with its players. Identifying facts are not stored: they follow
// from the identified instances.
function addTuple(w, pops, factId, tuple) {
  const f = w.ctx.factById.get(factId)
  if (!f) return
  f.roles.forEach((r, i) => addInst(w, pops, r.objectTypeId, tuple[i]))
  if (isIdentifying(w, factId)) return
  const list = pops.factPopulations[factId] ?? (pops.factPopulations[factId] = [])
  const k = JSON.stringify(tuple.map(keyOf))
  if (!list.some(t => JSON.stringify(t.map(keyOf)) === k)) list.push(tuple)
}

// A new instance of a type that equals no other: a labelled null, or for a
// composite identifier a combination of them.
function freshCell(w, pops, typeId, fresh, depth = 0) {
  const ot = w.ctx.otById.get(typeId)
  if (!ot) throw new Unsupported('an objectified fact type plays a role here')
  let cell
  if (ot.kind === 'entity') {
    const sch = schemeOf(typeId, w.els)
    if (sch?.kind === 'nested') throw new Unsupported('an entity type identified by a nested fact type')
    cell = sch?.kind === 'composite' && depth < 4
      ? sch.parts.map(p => freshCell(w, pops, playerOf(w, p.factId, p.roleIndex), fresh, depth + 1))
      : fresh(sch?.kind === 'refMode' ? sch.rm.vtId : null)
  } else cell = fresh(typeId)
  addInst(w, pops, typeId, cell)
  return cell
}

// Merging labelled nulls: union-find over values. A labelled null may become
// a constant; two different constants can't be merged.
class Subst {
  constructor() { this.p = new Map(); this.changed = false }
  find(x) { while (this.p.has(x)) x = this.p.get(x); return x }
  union(a, b) {
    const ra = this.find(a), rb = this.find(b)
    if (ra === rb) return true
    if (isFresh(ra)) this.p.set(ra, rb)
    else if (isFresh(rb)) this.p.set(rb, ra)
    else return false
    this.changed = true
    return true
  }
  unify(a, b) {
    if (a == null || b == null) return a == b
    if (typeof a === 'string' && typeof b === 'string') return this.union(a, b)
    if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => this.unify(x, b[i]))
    return false
  }
  apply(c) { return typeof c === 'string' ? this.find(c) : Array.isArray(c) ? c.map(x => this.apply(x)) : c }
}

function applySubst(w, pops, S) {
  const out = emptyPops()
  for (const [id, cells] of Object.entries(pops.populations)) for (const c of cells) addInst(w, out, id, S.apply(c))
  for (const [id, tuples] of Object.entries(pops.factPopulations)) for (const t of tuples) addTuple(w, out, id, t.map(c => S.apply(c)))
  return out
}

const evaluatorOf = (w, pops) => makePopulationEvaluator({ ...w.els, ...pops, nestedEntityMappings: {}, subtypeMappings: {} })

// ── Building a violation ─────────────────────────────────────────────────────

// The formula with each disjunction (at a positive place) resolved one way.
function alternatives(f, cap = 8) {
  if (!f || typeof f !== 'object') return [f]
  switch (f.t) {
    case 'or': return f.args.flatMap(a => alternatives(a, cap)).slice(0, cap)
    case 'and': {
      let acc = [[]]
      for (const a of f.args) acc = acc.flatMap(xs => alternatives(a, cap).map(y => [...xs, y])).slice(0, cap)
      return acc.map(args => ({ t: 'and', args }))
    }
    case 'exists': case 'count': return alternatives(f.body, cap).map(body => ({ ...f, body }))
    default: return [f]
  }
}

// The smallest populations of the side that make the counterexample formula X
// true (one per way of reading its disjunctions). Negated parts are not built:
// the result is checked against the constraint afterwards.
function buildViolations(X, w, fresh) {
  const out = []
  for (const alt of alternatives(X)) {
    const pops = emptyPops()
    const S = new Subst()
    let ok = true
    const cellOf = (env, v) => {
      if (!env.has(v)) env.set(v, freshCell(w, pops, v.typeId, fresh))
      return env.get(v)
    }
    const constText = (t) => String(t.text ?? '').trim().replace(/^'(.*)'$/s, '$1')
    const build = (f, env) => {
      if (!f || !ok) return
      switch (f.t) {
        case 'exists':
          for (const v of f.vars) env.set(v, freshCell(w, pops, v.typeId, fresh))
          build(f.body, env)
          return
        case 'count': {
          const n = f.op === '>' ? f.n + 1 : f.op === '≤' ? 0 : f.n
          if (n > 6) throw new Unsupported(`a count of ${n}`)
          for (let k = 0; k < n; k++) {
            const e = new Map(env)
            for (const v of f.vars) e.set(v, freshCell(w, pops, v.typeId, fresh))
            build(f.body, e)
          }
          return
        }
        case 'and': for (const a of f.args) build(a, env); return
        case 'fact': {
          const fact = w.ctx.factById.get(f.factId)
          if (!fact) throw new Unsupported('a fact type of another schema')
          const cells = f.args.map(v => cellOf(env, v))
          if (isIdentifying(w, fact.id)) {
            // Its value is the identified instance's identifier (or part of it).
            fact.roles.forEach((r, i) => {
              const sch = schemeOf(r.objectTypeId, w.els)
              if (sch?.kind === 'refMode' && sch.rm.factId === fact.id && 1 - sch.rm.vtRoleIndex === i) {
                if (!S.unify(cells[i], cells[sch.rm.vtRoleIndex])) ok = false
              } else if (sch?.kind === 'composite' && Array.isArray(cells[i])) {
                sch.parts.forEach((p, k) => { if (p.factId === fact.id && p.entityRoleIndex === i && !S.unify(cells[i][k], cells[p.roleIndex])) ok = false })
              }
            })
          }
          addTuple(w, pops, fact.id, cells)
          return
        }
        case 'type': addInst(w, pops, f.typeId, cellOf(env, f.arg)); return
        case 'not': case 'true': return
        case 'cmp':
          if (f.op === '=' && !S.unify(cellOf(env, f.left), cellOf(env, f.right))) ok = false
          return
        case 'vcmp': {
          const side = (t) => (t?.t === 'const' ? constText(t) : t && !t.t ? cellOf(env, t) : undefined)
          const l = side(f.left), r = side(f.right)
          if (l === undefined || r === undefined) throw new Unsupported('a value comparison with a data term')
          if (f.op === '≈') { if (!S.unify(l, r)) ok = false; return }
          if (f.op === '≉' && !(f.left?.t === 'const' || f.right?.t === 'const')) return
          throw new Unsupported('a comparison with a constant')
        }
        default: throw new Unsupported(`a formula part of kind ${f.t}`)
      }
    }
    build(alt, new Map())
    if (ok) out.push(S.changed ? applySubst(w, pops, S) : pops)
  }
  return out
}

// ── Checking a population ────────────────────────────────────────────────────

// Population issues that say nothing about constraints here: alignment of the
// stored populations, datatypes, and ranges judged on labelled nulls.
const NOISE = new Set(['emptyTupleCell', 'danglingReference', 'typeMismatch', 'missingInPlayerPop', 'missingInSupertypePop',
  'incompleteIdentifier', 'mappingIncomplete', 'mappingNotInjective'])
const onNull = (i) => (i.kind === 'valueRangeViolation' || i.kind === 'valueComparisonViolation') && JSON.stringify(i).includes('⊥')
// The issues of a population. Only fact types with facts, or with a player
// that has instances, can have any, so the others are left out (populations
// here are small, schemas may be large). With `constraintId`, of the external
// constraints only that one is checked.
// The same selection gives the same array, so that the lookups cached per
// array (reference schemes, identifying facts) are not computed again.
function stable(w, list) {
  const cache = w.stable ?? (w.stable = new Map())
  const k = list.map(x => x.id).join('\u0000')
  if (!cache.has(k)) cache.set(k, list)
  return cache.get(k)
}
// Violations of constraints the chase does not apply (it adds no facts for
// them), which still rule out a population that breaks them.
const KILLING_KINDS = new Set(['exclusionViolation', 'ringViolation', 'valueRangeViolation', 'formulaViolated', 'valueComparisonViolation'])

function issuesOf(w, pops, constraintId) {
  const active = new Set(Object.entries(pops.populations).filter(([, v]) => v.length).map(([k]) => k))
  const facts = w.els.facts.filter(f => pops.factPopulations[f.id]?.length || f.roles.some(r => active.has(r.objectTypeId)))
  const factIds = new Set(facts.map(f => f.id))
  // Preferred identifiers always: they say how instances are identified.
  const constraints = constraintId !== undefined
    ? w.els.constraints.filter(c => c.id === constraintId || c.isPreferredIdentifier)
    : w.els.constraints.filter(c => c.isPreferredIdentifier || (c.sequences ?? []).some(sq => (sq ?? []).some(m => factIds.has(m?.factId))) || active.has(c.targetObjectTypeId)
      || (isFormulaConstraint(c) && [...formulaElements(c.rule).facts].some(id => factIds.has(id))))
  const data = { ...w.els, facts: stable(w, facts), constraints: stable(w, constraints), ...pops, nestedEntityMappings: {}, subtypeMappings: {} }
  // Formula constraints are checked by evaluating their formula (over all of
  // the side's fact types, which the formula may name beyond those populated).
  const formulas = constraints.filter(isFormulaConstraint)
  const formulaIssues = formulas.length ? formulaConstraintPopulationIssues({ ...data, facts: w.els.facts, constraints: w.els.constraints }, formulas) : []
  return [...computePopulationIssues(data), ...formulaIssues]
    .filter(i => !NOISE.has(i.kind) && !onNull(i))
}

// The key of the constraint an issue is about, as formalise names entries.
function issueKey(i) {
  switch (i.kind) {
    case 'uniquenessViolation': return i.constraintId ?? `${i.factId}:uc:${i.roleIndices.join(',')}`
    case 'mandatoryRoleNotPlayed': return `${i.factId}:mand:${i.roleIndex}`
    case 'frequencyViolation': return `${i.factId}:freq:${i.internalFrequencyId}`
    case 'ringViolation': return `${i.constraintId}:${i.ringType}`
    case 'valueRangeViolation': return i.factId != null ? `${i.factId}:vr:${i.roleIndex}` : `${i.otId}:vr`
    default: return i.constraintId ?? i.elementId ?? i.kind
  }
}

// Whether an issue is a violation of the constraint of a formalise entry.
function issueMatches(entry) {
  const m = issueMatcher(entry)
  if (m) m.constraintId = /:(uc|mand|freq|vr)(:|$)/.test(entry.key) ? null : entry.key.split(':')[0]
  return m
}
function issueMatcher(entry) {
  const k = entry.key
  const same = (a, b) => a.length === b.length && [...a].sort().join(',') === [...b].sort().join(',')
  let m
  if ((m = k.match(/^([^:]+):uc:([\d,]+)$/))) {
    const roles = m[2].split(',').map(Number)
    return (i) => i.kind === 'uniquenessViolation' && i.factId === m[1] && same(i.roleIndices ?? [], roles)
  }
  if ((m = k.match(/^([^:]+):mand:(\d+)$/))) return (i) => i.kind === 'mandatoryRoleNotPlayed' && i.factId === m[1] && i.roleIndex === +m[2]
  if ((m = k.match(/^([^:]+):vr:(\d+)$/))) return (i) => i.kind === 'valueRangeViolation' && i.factId === m[1] && i.roleIndex === +m[2]
  if ((m = k.match(/^([^:]+):vr$/))) return (i) => i.kind === 'valueRangeViolation' && i.otId === m[1] && i.factId == null
  if ((m = k.match(/^([^:]+):freq:(.+)$/))) return (i) => i.kind === 'frequencyViolation' && i.factId === m[1] && i.internalFrequencyId === m[2]
  if (!k.includes(':')) return (i) => !i.kind.startsWith('mandatoryRole') && (i.constraintId ?? i.elementId) === k && i.kind !== 'missingInSupertypePop'
  if ((m = k.match(/^([^:]+):([a-z]+)$/)) && entry.kind?.startsWith('Ring')) return (i) => i.kind === 'ringViolation' && i.constraintId === m[1] && i.ringType === m[2]
  return null
}
const violations = (w, pops, match) => issuesOf(w, pops, match.constraintId ?? null).filter(match)

// ── The chase ────────────────────────────────────────────────────────────────

// A role sequence of a set-comparison constraint as something to project:
// { kind: 'one', factId, roles } (roles of one fact type), or { kind: 'join',
// joinType, parts: [{ factId, valueRi, entityRi }] } (one role of each of some
// binary fact types, joined on the instance at their other roles). Null when
// it is neither.
function seqShape(seq, w) {
  const ms = seq ?? []
  if (!ms.length || ms.some(m => m?.kind !== 'role')) return null
  const fids = new Set(ms.map(m => m.factId))
  const binary = ms.every(m => w.ctx.factById.get(m.factId)?.roles.length === 2)
  if (fids.size === ms.length && binary) {
    const parts = ms.map(m => ({ factId: m.factId, valueRi: m.roleIndex, entityRi: 1 - m.roleIndex }))
    const joins = new Set(parts.map(p => playerOf(w, p.factId, p.entityRi)))
    if (joins.size === 1) return { kind: 'join', joinType: [...joins][0], parts }
  }
  if (fids.size === 1 && w.ctx.factById.has(ms[0].factId)) return { kind: 'one', factId: ms[0].factId, roles: ms.map(m => m.roleIndex) }
  return null
}

// The tuples a sequence projects to.
function project(shape, ev) {
  if (shape.kind === 'one') return (ev.factTuples(shape.factId).tuples ?? []).map(t => shape.roles.map(r => t[r]))
  const index = shape.parts.map(p => {
    const ix = new Map()
    for (const t of ev.factTuples(p.factId).tuples ?? []) {
      const k = keyOf(t[p.entityRi])
      if (!ix.has(k)) ix.set(k, [])
      ix.get(k).push(t[p.valueRi])
    }
    return ix
  })
  const out = []
  for (const e of ev.population(shape.joinType).instances ?? []) {
    let acc = [[]]
    for (const ix of index) acc = acc.flatMap(xs => (ix.get(keyOf(e)) ?? []).map(v => [...xs, v]))
    out.push(...acc.slice(0, 20).map(vals => Object.assign(vals, { entity: e })))
  }
  return out
}

// Adds what makes the sequence project to vals.
function addProjection(w, pops, shape, vals, fresh) {
  if (shape.kind === 'one') {
    const f = w.ctx.factById.get(shape.factId)
    addTuple(w, pops, f.id, f.roles.map((r, j) => {
      const k = shape.roles.indexOf(j)
      return k >= 0 ? vals[k] : freshCell(w, pops, r.objectTypeId, fresh)
    }))
    return
  }
  // A new instance of the joined type; its identifier from vals where they
  // give it (a foreign key to a key), else labelled nulls.
  const J = shape.joinType
  const sch = schemeOf(J, w.els)
  const given = (factId, ri) => shape.parts.findIndex(p => p.factId === factId && p.valueRi === ri)
  let cell
  if (sch?.kind === 'refMode') {
    const k = given(sch.rm.factId, sch.rm.vtRoleIndex)
    cell = k >= 0 ? vals[k] : null
  } else if (sch?.kind === 'composite') {
    cell = sch.parts.map(p => {
      const k = given(p.factId, p.roleIndex)
      return k >= 0 ? vals[k] : freshCell(w, pops, playerOf(w, p.factId, p.roleIndex), fresh)
    })
  }
  if (cell == null) cell = freshCell(w, pops, J, fresh)
  else addInst(w, pops, J, cell)
  shape.parts.forEach((p, k) => {
    if (isIdentifying(w, p.factId)) return
    const t = [null, null]
    t[p.entityRi] = cell
    t[p.valueRi] = vals[k]
    addTuple(w, pops, p.factId, t)
  })
}

// The uniqueness constraints the chase applies: internal ones per fact type,
// and external ones over a 'join' or 'one' sequence. Preferred identifiers
// hold by how instances are identified.
function uniquenessOf(w) {
  const out = []
  for (const f of w.ctx.facts) {
    if (isIdentifying(w, f.id)) continue
    for (const u of f.uniqueness ?? []) {
      if (!u.roles?.length || u.roles.length >= f.roles.length || isDeonticUniqueness(f, u.roles)) continue
      out.push({ key: `${f.id}:uc:${u.roles.join(',')}`, shape: { kind: 'one', factId: f.id, roles: u.roles } })
    }
  }
  for (const c of w.ctx.constraints) {
    if (c.constraintType !== 'uniqueness' || c.isPreferredIdentifier || c.deontic) continue
    const shape = seqShape(c.sequences?.[0], w)
    if (shape) out.push({ key: c.id, shape })
  }
  return out
}

// Closes a population under the side's constraints: { pops, fired: Set(key),
// failed: key | null, exceeded, branching }. Constraints in `disabled` are
// left out.
function chase(w, start, fresh, { disabled = new Set(), tgds = true, maxRounds = 20, maxSize = 250 } = {}) {
  // Closed first: instances of a subtype are instances of its supertypes (a
  // run builds only the types its rules name).
  let pops = applySubst(w, start, new Subst())
  const fired = new Set()
  let branching = false
  const ucs = uniquenessOf(w).filter(u => !disabled.has(u.key))
  const sets = w.ctx.constraints.filter(c => !c.deontic && !disabled.has(c.id) && (c.constraintType === 'subset' || c.constraintType === 'equality') && c.sequences?.length === 2)
    .map(c => ({ c, a: seqShape(c.sequences[0], w), b: seqShape(c.sequences[1], w) })).filter(x => x.a && x.b)
  const ors = w.ctx.constraints.filter(c => !c.deontic && !disabled.has(c.id) && (c.constraintType === 'inclusiveOr' || c.constraintType === 'exclusiveOr') && c.targetObjectTypeId)
  for (let round = 0; round < maxRounds; round++) {
    // Uniqueness: merge, until nothing changes.
    for (let k = 0; k < 20; k++) {
      const S = new Subst()
      const ev = evaluatorOf(w, pops)
      for (const u of ucs) {
        const merged = S.p.size
        const groups = new Map()
        if (u.shape.kind === 'one') {
          for (const t of ev.factTuples(u.shape.factId).tuples ?? []) {
            const tt = t.map(c => S.apply(c))
            const g = JSON.stringify(u.shape.roles.map(r => keyOf(tt[r])))
            if (!groups.has(g)) { groups.set(g, tt); continue }
            const first = groups.get(g)
            for (let i = 0; i < tt.length; i++) {
              if (u.shape.roles.includes(i)) continue
              if (!S.unify(first[i], tt[i])) return { pops, fired: fired.add(u.key), failed: u.key }
            }
          }
        } else {
          for (const vals of project(u.shape, ev)) {
            const g = JSON.stringify(vals.map(v => keyOf(S.apply(v))))
            if (!groups.has(g)) { groups.set(g, vals.entity); continue }
            if (!S.unify(S.apply(groups.get(g)), S.apply(vals.entity))) return { pops, fired: fired.add(u.key), failed: u.key }
          }
        }
        if (S.p.size > merged) fired.add(u.key)
      }
      if (!S.changed) break
      pops = applySubst(w, pops, S)
    }
    if (!tgds) return { pops, fired, failed: null, branching }
    // Mandatory roles, subset and equality constraints: add what they ask for.
    const ev = evaluatorOf(w, pops)
    let added = false
    for (const f of w.ctx.facts) {
      if (isIdentifying(w, f.id)) continue
      f.roles.forEach((r, i) => {
        const key = `${f.id}:mand:${i}`
        if (!r.mandatory || isDeonticMandatory(r) || disabled.has(key)) return
        const played = new Set((ev.factTuples(f.id).tuples ?? []).map(t => keyOf(t[i])))
        for (const e of ev.population(r.objectTypeId).instances ?? []) {
          if (played.has(keyOf(e))) continue
          addTuple(w, pops, f.id, f.roles.map((q, j) => (j === i ? e : freshCell(w, pops, q.objectTypeId, fresh))))
          fired.add(key)
          added = true
        }
      })
    }
    for (const c of ors) {
      // A disjunction: the chase takes the first role, so what it finds is one
      // population among several.
      const seqs = (c.sequences ?? []).map(s => s?.[0]).filter(m => m?.kind === 'role')
      if (!seqs.length) continue
      const played = new Set()
      for (const m of seqs) for (const t of ev.factTuples(m.factId).tuples ?? []) played.add(keyOf(t[m.roleIndex]))
      for (const e of ev.population(c.targetObjectTypeId).instances ?? []) {
        if (played.has(keyOf(e))) continue
        const f = w.ctx.factById.get(seqs[0].factId)
        if (!f) continue
        addTuple(w, pops, f.id, f.roles.map((q, j) => (j === seqs[0].roleIndex ? e : freshCell(w, pops, q.objectTypeId, fresh))))
        fired.add(c.id)
        branching = added = true
      }
    }
    for (const { c, a, b } of sets) {
      for (const [x, y] of c.constraintType === 'equality' ? [[a, b], [b, a]] : [[a, b]]) {
        const have = new Set(project(y, ev).map(vals => JSON.stringify(vals.map(keyOf))))
        for (const vals of project(x, ev)) {
          if (vals.some(v => v == null) || have.has(JSON.stringify(vals.map(keyOf)))) continue
          addProjection(w, pops, y, vals, fresh)
          have.add(JSON.stringify(vals.map(keyOf)))
          fired.add(c.id)
          added = true
        }
      }
    }
    if (sizeOf(pops) > maxSize) return { pops, fired, exceeded: true }
    if (!added) return { pops, fired, failed: null, branching }
  }
  return { pops, fired, exceeded: true }
}

// ── Accounting ───────────────────────────────────────────────────────────────

// Entries of the Constraints tab that are not constraints to account for.
const skipEntry = (e) => !e.formula || e.possible || /deriv|implied link/i.test(e.kind ?? '')

// The constraints of a side, as the Constraints tab lists them for the whole schema.
export function entriesOf(state, schemaId) {
  const inSchema = (x) => x.schemaId === schemaId
  const scoped = {
    ...state,
    objectTypes: (state.objectTypes ?? []).filter(inSchema), facts: (state.facts ?? []).filter(inSchema),
    subtypes: (state.subtypes ?? []).filter(inSchema), constraints: (state.constraints ?? []).filter(inSchema),
    selectedId: null, multiSelectedIds: [], selectedMandatoryDot: null, selectedUniqueness: null,
    selectedInternalFrequency: null, selectedValueRange: null, selectedCardinalityRange: null,
  }
  const { entries, ctx } = formalise(scoped, { wholeSchema: true })
  return Object.assign(entries, { ctx })
}

// A constraint of a relational schema in table terms, or null.
export function relationalLabel(w, key) {
  const rm = w.relational
  if (!rm) return null
  const colName = (c) => `${c.table.name}.${c.name}`
  let m
  if ((m = key.match(/^([^:]+):mand:(\d+)$/))) {
    const c = rm.columnByFact.get(m[1])
    if (c && +m[2] === c.t) return `${colName(c)} NOT NULL`
  }
  if ((m = key.match(/^([^:]+):uc:([\d,]+)$/))) {
    const c = rm.columnByFact.get(m[1])
    if (c && m[2] === String(c.t)) return `${colName(c)} has one value per row`
    if (c && m[2] === String(c.v)) return c.pk ? `PRIMARY KEY ${c.table.name}(${c.name})` : `UNIQUE ${c.table.name}(${c.name})`
  }
  if (!key.includes(':')) {
    const fk = rm.fks.find(f => f.constraintId === key)
    if (fk) return `FOREIGN KEY ${fk.fromTable.name}(${fk.from.map(c => c.name).join(', ')}) → ${fk.toTable.name}(${fk.to.map(c => c.name).join(', ')})`
    for (const t of rm.tables) {
      const c = w.ctx.constraints.find(x => x.id === key)
      if (c?.constraintType !== 'uniqueness') break
      const cols = (c.sequences?.[0] ?? []).map(mm => rm.columnByFact.get(mm.factId)).filter(Boolean)
      if (cols.length && cols[0].table === t) return `${c.isPreferredIdentifier ? 'PRIMARY KEY' : 'UNIQUE'} ${t.name}(${cols.map(x => x.name).join(', ')})`
    }
  }
  return null
}

// A population as lines of text: table rows for a relational schema, facts
// otherwise.
function describe(w, pops) {
  const lines = []
  const show = (c) => (c == null ? 'NULL' : Array.isArray(c) ? `(${c.map(show).join(', ')})` : String(c))
  if (w.relational) {
    for (const t of w.relational.tables) {
      for (const row of pops.populations[t.id] ?? []) {
        const vals = t.columns.map(col => {
          let v
          if (isIdentifying(w, col.fact.id)) {
            const sch = schemeOf(t.id, w.els)
            if (sch?.kind === 'refMode') v = row
            else if (sch?.kind === 'composite') { const k = sch.parts.findIndex(p => p.factId === col.fact.id); v = k >= 0 ? row[k] : undefined }
          } else {
            const vs = (pops.factPopulations[col.fact.id] ?? []).filter(tu => keyOf(tu[col.t]) === keyOf(row)).map(tu => tu[col.v])
            v = vs.length > 1 ? `{${vs.map(show).join(', ')}}` : vs[0]
          }
          return `${col.name} ${show(v ?? null)}`
        })
        lines.push(`${t.name}(${vals.join(', ')})`)
      }
    }
    return lines
  }
  const shown = new Set()
  for (const f of w.ctx.facts) {
    for (const t of pops.factPopulations[f.id] ?? []) {
      const parts = plainParts(f.readingParts ?? [], f.roles.length)
      const words = []
      f.roles.forEach((r, i) => {
        if (parts[i]?.trim()) words.push(parts[i].trim())
        words.push(`${w.ctx.otById.get(r.objectTypeId)?.name ?? '?'} ${show(t[i])}`)
      })
      if (parts[f.roles.length]?.trim()) words.push(parts[f.roles.length].trim())
      lines.push(words.join(' '))
      t.forEach((c, i) => shown.add(`${f.roles[i].objectTypeId}|${keyOf(c)}`))
    }
  }
  for (const o of w.ctx.objectTypes) {
    if (o.kind !== 'entity') continue
    const alone = (pops.populations[o.id] ?? []).filter(c => !shown.has(`${o.id}|${keyOf(c)}`)
      && !(w.supers.get(o.id) ?? []).length && ![...w.supers].some(([sub, sups]) => sups.includes(o.id) && (pops.populations[sub] ?? []).some(x => keyOf(x) === keyOf(c))))
    for (const c of alone) lines.push(`${o.name} ${show(c)}`)
  }
  return lines
}

// Renames labelled nulls ⊥17 → ⊥₁ in order of appearance.
function renumber(texts) {
  const map = new Map()
  const SUB = '₀₁₂₃₄₅₆₇₈₉'
  const sub = (n) => String(n).split('').map(d => SUB[+d]).join('')
  return texts.map(t => t.replace(/⊥\d+/g, (x) => {
    if (!map.has(x)) map.set(x, `⊥${sub(map.size + 1)}`)
    return map.get(x)
  }))
}

// The constants the rules' patterns on the "from" side compare values with,
// by value type: { vtId → [text] }.
function constantsOf(prep) {
  const out = new Map()
  for (const r of prep.rules) {
    if (r.skipped) continue
    const types = new Map()
    const walk = (vars, atoms) => {
      for (const v of vars ?? []) types.set(v.id, v.typeId)
      for (const a of atoms ?? []) {
        if (a.t === 'opt' || a.t === 'not') walk(a.vars, a.atoms)
        if (a.t === 'const' && a.v) {
          const vt = types.get(a.v), text = String(a.text ?? '').trim().replace(/^'(.*)'$/s, '$1')
          if (!vt) continue
          if (!out.has(vt)) out.set(vt, new Set())
          out.get(vt).add(text)
        }
      }
    }
    walk(r.fromSide.vars, r.fromSide.atoms)
  }
  return out
}

// Versions of a population with some labelled nulls replaced by constants
// the rules look for (a discriminator column, say), so that a rule carries it.
function withConstants(w, pops, fresh, constants, cap = 12) {
  const nulls = new Set()
  const scan = (c) => { if (Array.isArray(c)) c.forEach(scan); else if (isFresh(c) && constants.has(fresh.types.get(c))) nulls.add(c) }
  for (const cells of Object.values(pops.populations)) cells.forEach(scan)
  for (const ts of Object.values(pops.factPopulations)) ts.forEach(t => t.forEach(scan))
  let combos = [[]]
  for (const x of nulls) combos = combos.flatMap(cs => [null, ...constants.get(fresh.types.get(x))].map(c => [...cs, [x, c]])).slice(0, cap * 4)
  const out = []
  for (const cs of combos) {
    if (cs.every(([, c]) => c === null)) continue
    const S = new Subst()
    if (cs.every(([x, c]) => c === null || S.union(x, c))) out.push(applySubst(w, pops, S))
    if (out.length >= cap) break
  }
  return out
}

// Completes a population by the rules: each fact that a rule's pattern on
// this side names gets the rest of that pattern around it (with labelled
// nulls for what is unknown), as everything the mapping builds on this side
// is made of whole patterns. The rule with the smallest pattern is taken.
function complete(w, V, prep, fresh) {
  const pops = clonePops(V)
  const ev = evaluatorOf(w, V)
  const S = new Subst()
  const used = new Set(), impossible = []
  for (const f of w.ctx.facts) {
    const tuples = ev.factTuples(f.id).tuples ?? []
    if (!tuples.length) continue
    // The patterns (with an optional part if the fact is in one) that name f.
    const cands = []
    for (const r of prep.rules) {
      if (r.skipped) continue
      const top = { vars: r.fromSide.vars ?? [], atoms: (r.fromSide.atoms ?? []).filter(a => a.t !== 'opt' && a.t !== 'not') }
      const at = (atoms) => atoms.find(a => a.t === 'fact' && a.factId === f.id)
      if (at(top.atoms)) { cands.push({ r, side: top, seed: at(top.atoms) }); continue }
      for (const o of (r.fromSide.atoms ?? []).filter(a => a.t === 'opt')) {
        const inner = (o.atoms ?? []).filter(a => a.t !== 'opt' && a.t !== 'not')
        if (at(inner)) { cands.push({ r, side: { vars: [...top.vars, ...(o.vars ?? [])], atoms: [...top.atoms, ...inner] }, seed: at(inner) }); break }
      }
    }
    if (!cands.length) continue
    cands.sort((a, b) => a.side.atoms.length - b.side.atoms.length)
    for (const t of tuples) {
      // A labelled null may become a constant the pattern asks for.
      const c = cands.find(({ side, seed }) => {
        const S2 = new Subst()
        S2.p = new Map(S.p)
        if (!instantiate(w, pops, side, seed, t, fresh, S2)) return false
        S.p = S2.p
        return true
      })
      if (!c) { impossible.push(...cands.map(x => x.r.name)); continue }
      used.add(c.r.name)
    }
  }
  return { pops: S.p.size ? applySubst(w, pops, S) : pops, rules: [...used], impossible: [...new Set(impossible)] }
}

// Adds a match of a pattern (its top level) in which the seed atom is the
// tuple t; false (and nothing added) when the pattern can't have t there, as
// it asks for another constant.
function instantiate(w, pops, side, seed, t, fresh, S) {
  const vars = new Map((side.vars ?? []).map(v => [v.id, v]))
  const atoms = side.atoms
  const env = new Map(), y = new Map()
  let clash = false
  for (const [i, id] of seed.args.entries()) {
    if (id == null) continue
    if (env.has(id) && keyOf(env.get(id)) !== keyOf(t[i])) return false
    env.set(id, t[i])
  }
  const propagate = () => {
    for (let changed = true; changed && !clash;) {
      changed = false
      const set = (id, c) => {
        if (id == null || c == null) return
        if (!env.has(id)) { env.set(id, c); changed = true } else if (keyOf(S.apply(env.get(id))) !== keyOf(S.apply(c)) && !S.unify(S.apply(env.get(id)), S.apply(c))) clash = true
      }
      for (const a of atoms) {
        if (a.t === 'const') set(a.v, String(a.text ?? '').trim().replace(/^'(.*)'$/s, '$1'))
        else if (a.t === 'bind') {
          if (env.has(a.v) && !y.has(a.y)) { y.set(a.y, env.get(a.v)); changed = true } else if (y.has(a.y)) set(a.v, y.get(a.y))
        } else if (a.t === 'fact' && isIdentifying(w, a.factId)) {
          const f = w.ctx.factById.get(a.factId)
          f?.roles.forEach((r, i) => {
            const e = a.args[i]
            const sch = schemeOf(r.objectTypeId, w.els)
            if (sch?.kind === 'refMode' && sch.rm.factId === f.id && 1 - sch.rm.vtRoleIndex === i) {
              const v = a.args[sch.rm.vtRoleIndex]
              if (env.has(e)) set(v, env.get(e)); else if (env.has(v)) set(e, env.get(v))
            } else if (sch?.kind === 'composite' && sch.parts.some(p => p.factId === f.id && p.entityRoleIndex === i)) {
              if (env.has(e) && Array.isArray(env.get(e))) {
                sch.parts.forEach((p, k) => { if (p.factId === f.id && p.entityRoleIndex === i) set(a.args[p.roleIndex], env.get(e)[k]) })
              } else if (!env.has(e)) {
                const parts = sch.parts.map(p => {
                  const at = atoms.find(x => x.t === 'fact' && x.factId === p.factId && x.args[p.entityRoleIndex] === e)
                  return at && env.has(at.args[p.roleIndex]) ? env.get(at.args[p.roleIndex]) : undefined
                })
                if (parts.every(x => x !== undefined)) set(e, parts)
              }
            }
          })
        }
      }
    }
  }
  propagate()
  if (clash) return false
  // What nothing gives is a labelled null; instances first, as their
  // identifiers then give values.
  for (;;) {
    const open = [...vars.values()].filter(v => !env.has(v.id))
    if (!open.length) break
    const v = open.find(x => w.ctx.otById.get(x.typeId)?.kind === 'entity') ?? open[0]
    env.set(v.id, freshCell(w, pops, v.typeId, fresh))
    propagate()
    if (clash) return false
  }
  for (const v of vars.values()) addInst(w, pops, v.typeId, env.get(v.id))
  for (const a of atoms) {
    if (a.t === 'type' && env.has(a.arg)) addInst(w, pops, a.typeId, env.get(a.arg))
    if (a.t === 'fact' && a.args.every(id => id != null && env.has(id))) addTuple(w, pops, a.factId, a.args.map(id => env.get(id)))
  }
  return true
}

// A population of a side's schema in which each pattern (one side of a rule)
// holds, with labelled nulls for its values, closed under the schema's
// constraints: what any population with those matches must contain. Used by
// Fold (fold.js) to test whether a mapping still carries them. { pops } or
// { error }.
export function genericPopulation(w, patterns) {
  let n = 0
  const fresh = (typeId) => { const v = `⊥${++n}`; if (typeId) fresh.types.set(v, typeId); return v }
  fresh.types = new Map()
  const pops = emptyPops()
  try {
    for (const p of patterns) instantiate(w, pops, expandSide(asSide(p), w.ctx), { args: [] }, [], fresh, new Subst())
    const r = chase(w, pops, fresh)
    if (r.failed) return { error: 'the constraints of the other schema rule out such a population' }
    return { pops: r.pops, exceeded: !!r.exceeded }
  } catch (err) {
    if (err instanceof Unsupported) return { error: err.message }
    throw err
  }
}

// Populations with one value outside a value range (of a role, or of a value
// type, then in some fact type it plays a role in).
function rangeViolations(key, w, fresh, match) {
  let m, fact, ri, range
  if ((m = key.match(/^([^:]+):vr:(\d+)$/))) {
    fact = w.ctx.factById.get(m[1]); ri = +m[2]; range = fact?.roles[ri]?.valueRange
  } else if ((m = key.match(/^([^:]+):vr$/))) {
    const vt = w.ctx.otById.get(m[1]); range = vt?.valueRange
    for (const f of w.ctx.facts) {
      const i = f.roles.findIndex(r => r.objectTypeId === vt?.id)
      if (i >= 0 && (!fact || (isIdentifying(w, fact.id) && !isIdentifying(w, f.id)))) { fact = f; ri = i }
    }
  }
  if (!fact || !range?.length) return []
  // Candidates: just beyond the numeric bounds, then values of other kinds.
  const nums = range.flatMap(sp => [sp.value, sp.lower, sp.upper]).filter(v => v !== '' && v != null && Number.isFinite(Number(v))).map(Number)
  const cands = [...new Set([
    ...(nums.length ? [Math.max(...nums) + 1, Math.min(...nums) - 1, Math.max(...nums) + 0.5] : []).map(String),
    '-1', '0', '1000000000', 'zz', 'Z', '1800-01-01', '9999-12-31', 'false', 'true',
  ])]
  for (const v of cands) {
    const pops = emptyPops()
    try {
      const e = fact.roles.findIndex((_, j) => j !== ri)
      const sch = isIdentifying(w, fact.id) && fact.roles.length === 2 ? schemeOf(fact.roles[e]?.objectTypeId, w.els) : null
      if (sch?.kind === 'refMode') addInst(w, pops, fact.roles[e].objectTypeId, v)
      else if (sch?.kind === 'composite') {
        // The value is part of the identifier of the instance at the other role.
        addInst(w, pops, fact.roles[e].objectTypeId, sch.parts.map(p => (p.factId === fact.id && p.roleIndex === ri ? v
          : freshCell(w, pops, playerOf(w, p.factId, p.roleIndex), fresh))))
      } else addTuple(w, pops, fact.id, fact.roles.map((r, j) => (j === ri ? v : freshCell(w, pops, r.objectTypeId, fresh))))
    } catch (e) {
      if (e instanceof Unsupported) return []
      throw e
    }
    if (violations(w, pops, match).length) return [pops]
  }
  return []
}

const IDENTIFIED = 'It holds by how instances are identified (reference schemes), so no population can break it.'

// Whether population b has every instance and fact of a. Instances of types
// whose surrogates b invented (and their reference values) match any.
function contains(w, b, a, invented = []) {
  const wild = new Set()
  for (const { typeId } of invented) {
    wild.add(typeId)
    const sch = schemeOf(typeId, w.els)
    if (sch?.kind === 'refMode') wild.add(sch.rm.vtId)
    for (const [sub, sups] of w.supers) if (sups.includes(typeId)) wild.add(sub)
  }
  // A cell's key with the wild parts (also inside composite identifiers) as *.
  const kw = (c, typeId, depth = 0) => {
    if (wild.has(typeId)) return '*'
    const sch = depth < 4 && Array.isArray(c) ? schemeOf(typeId, w.els) : null
    if (sch?.kind === 'composite') return `[${c.map((x, i) => kw(x, playerOf(w, sch.parts[i]?.factId, sch.parts[i]?.roleIndex), depth + 1)).join(',')}]`
    return keyOf(c)
  }
  for (const [id, cells] of Object.entries(a.populations)) {
    if (wild.has(id)) continue
    const have = new Set((b.populations[id] ?? []).map(c => kw(c, id)))
    if (cells.some(c => !have.has(kw(c, id)))) return false
  }
  for (const [id, tuples] of Object.entries(a.factPopulations)) {
    const f = w.ctx.factById.get(id)
    const k = (t) => JSON.stringify(t.map((c, i) => kw(c, f?.roles[i]?.objectTypeId)))
    const have = new Set((b.factPopulations[id] ?? []).map(k))
    if (tuples.some(t => !have.has(k(t)))) return false
  }
  return true
}

// The status of one constraint (entry) of world A with respect to world B.
function accountEntry(entry, A, B, run, fresh) {
  const base = { key: entry.key, entry, by: [], counterexample: null }
  let f = entry.formula
  const deontic = f?.t === 'obligatory'
  if (deontic) f = f.arg
  base.deontic = deontic
  const unknown = (reason) => ({ ...base, status: 'unknown', reason })
  if (/cardinality/i.test(entry.kind ?? '')) return unknown('Cardinality ranges are not checked yet.')
  if (/:pi:|:exactlyOne$/.test(entry.key)) return { ...base, status: 'native', reason: IDENTIFIED }
  const match = issueMatches(entry)
  if (!match) return unknown('Constraints of this kind are not checked yet.')
  let cands
  if (/:vr(:\d+)?$/.test(entry.key)) {
    // A value range: a value outside it, in a fact.
    cands = rangeViolations(entry.key, A, fresh, match)
    if (!cands.length) return unknown('No value outside this range was found to test with.')
  } else {
    const X = counterexample(f)
    if (!X) return unknown('This constraint has no counterexample form.')
    try { cands = buildViolations(X, A, fresh) } catch (e) {
      if (e instanceof Unsupported) return unknown(`Not checked yet: ${e.message}.`)
      throw e
    }
    cands = cands.filter(V => violations(A, V, match).length)
    if (!cands.length) return { ...base, status: 'native', reason: IDENTIFIED }
  }

  const backOf = (I) => executeRun(run.back, I)
  // The violation carried there and back, or only what it consists of (then
  // the other side's structure already rules it out), or not even that.
  let structural = false
  const carriedBack = (V) => {
    const I0 = executeRun(run.there, V)
    const back = backOf(I0)
    if (violations(A, back, match).length) return I0
    if (contains(A, back, V, back.invented)) structural = true
    return null
  }
  const killedBy = []
  let lost = null, notCarried = 0, undecided = null
  // Each violation, made into one the rules carry if need be: with what the
  // side's own mandatory roles and subset constraints (other than χ) add
  // around it, and with labelled nulls replaced by constants the rules test.
  const carried = [], keptByRules = []
  for (const V0 of cands.slice(0, 4)) {
    let I0 = carriedBack(V0)
    if (I0) { carried.push({ V: V0, I0 }); continue }
    let V = V0
    const ch = chase(A, V0, fresh, { disabled: new Set([entry.key]) })
    if (!ch.exceeded && !ch.failed && violations(A, ch.pops, match).length) {
      V = ch.pops
      I0 = carriedBack(V)
      if (I0) { carried.push({ V, I0 }); continue }
    }
    // With labelled nulls replaced by constants the rules test.
    const withConsts = (W) => {
      let some = false
      for (const V2 of withConstants(A, W, fresh, run.constants)) {
        if (!violations(A, V2, match).length) continue
        const I2 = carriedBack(V2)
        if (I2) { carried.push({ V: V2, I0: I2 }); some = true }
      }
      return some
    }
    if (withConsts(V)) continue
    // Completed by the rules: if that removes the violation, or no rule can
    // build part of it, the rules keep χ.
    const done = complete(A, V, run.there, fresh)
    if (done.impossible.length) { keptByRules.push(...done.impossible); continue }
    if (!violations(A, done.pops, match).length) { keptByRules.push(...done.rules); continue }
    V = done.pops
    I0 = carriedBack(V)
    if (I0) { carried.push({ V, I0 }); continue }
    if (!withConsts(V)) notCarried++
  }
  let bySubtypes = 0
  for (const { V, I0 } of carried.slice(0, 8)) {
    // The other side's subtyping alone (its instances of a subtype are
    // instances of the supertypes) may already remove the violation.
    if (!violations(A, backOf(applySubst(B, I0, new Subst())), match).length) { bySubtypes++; continue }
    const ch = chase(B, I0, fresh)
    if (ch.exceeded) {
      // Uniqueness alone may still rule it out: the facts the chase would go
      // on adding can only make more values equal.
      const chU = chase(B, I0, fresh, { tgds: false })
      if (!chU.exceeded && (chU.failed || !violations(A, backOf(chU.pops), match).length)) { killedBy.push({ I0, ch: chU, uOnly: true }); continue }
      undecided = 'The other schema’s constraints keep adding facts (the chase stopped).'
      continue
    }
    if (ch.failed) { killedBy.push({ I0, ch }); continue }
    const bad = issuesOf(B, ch.pops)
    const back = backOf(ch.pops)
    const v = violations(A, back, match)
    if (v.length && !bad.length) {
      if (!lost) lost = { I: ch.pops, V, back, branching: ch.branching }
      continue
    }
    if (bad.length) {
      // I breaks a constraint the chase does not apply.
      const k = issueKey(bad[0])
      if (KILLING_KINDS.has(bad[0].kind)) killedBy.push({ I0, ch: { ...ch, failed: k } })
      else undecided = 'A constraint of the other schema that is not checked yet is involved.'
      continue
    }
    if (ch.branching) { undecided = 'A disjunctive mandatory constraint of the other schema is involved.'; continue }
    killedBy.push({ I0, ch })
  }
  if (lost) {
    const there = describe(B, lost.I), back = describe(A, lost.back)
    const texts = renumber([...there, ...back])
    return { ...base, status: 'lost',
      reason: `A population of ${B.ctx.schema?.name ?? 'the other schema'} that satisfies its constraints maps to one that breaks this constraint.`,
      counterexample: { there: texts.slice(0, there.length), back: texts.slice(there.length) } }
  }
  if (bySubtypes && !killedBy.length && !undecided) return { ...base, status: 'native', reason: `Kept by the subtyping of ${B.ctx.schema?.name ?? 'the other schema'}: the mapping builds instances of a subtype, which are instances of its supertypes.` }
  if (killedBy.length) {
    // Which of the constraints the chase used are needed: leave each out.
    const needed = new Set(), usedAll = new Set()
    for (const { I0, ch: ch0, uOnly } of killedBy.slice(0, 2)) {
      // When uniqueness alone (no facts added) already rules the violation
      // out, the constraints that add facts are not needed: only the
      // uniqueness constraints are tried, which is quicker and says more.
      let ch = ch0, tgds = !uOnly
      if (tgds && ch0.fired.size > 1) {
        const chU = chase(B, I0, fresh, { tgds: false })
        if (!chU.exceeded && (chU.failed || !violations(A, backOf(chU.pops), match).length)) { ch = chU; tgds = false }
      }
      const used = [...new Set([ch.failed, ...ch.fired].filter(Boolean))]
      used.forEach(k => usedAll.add(k))
      for (const k of used.slice(0, 14)) {
        const ch2 = chase(B, I0, fresh, { disabled: new Set([k]), tgds })
        if (ch2.exceeded || ch2.failed) continue
        // Without the facts the chase would add, only whether the violation
        // comes back counts.
        const bad = tgds ? issuesOf(B, ch2.pops).filter(i => issueKey(i) !== k) : []
        if (!bad.length && violations(A, backOf(ch2.pops), match).length) needed.add(k)
      }
    }
    const keys = needed.size ? [...needed] : [...usedAll]
    const by = keys.map(k => ({ key: k, label: relationalLabel(B, k) }))
    if (!keys.length) return { ...base, status: 'native', by, reason: `Kept by the structure of ${B.ctx.schema?.name ?? 'the other schema'}: the mapping cannot build a population that breaks it.` }
    if (needed.size === 1) return { ...base, status: 'native', by, reason: `Kept by one constraint of ${B.ctx.schema?.name ?? 'the other schema'}.` }
    return { ...base, status: 'implied', by,
      reason: needed.size ? `Kept by these constraints of ${B.ctx.schema?.name ?? 'the other schema'} together.` : `Kept by any of these constraints of ${B.ctx.schema?.name ?? 'the other schema'}.` }
  }
  if (undecided) return unknown(undecided)
  if (keptByRules.length && !notCarried) {
    const names = [...new Set(keptByRules)]
    return { ...base, status: 'implied', by: [], rules: names,
      reason: `Kept by the rules: the mapping builds what this constraint is about only as part of whole patterns (${names.slice(0, 3).join(', ')}${names.length > 3 ? ', …' : ''}), which satisfy it.` }
  }
  if (structural) return { ...base, status: 'native', reason: `Kept by the structure of ${B.ctx.schema?.name ?? 'the other schema'}: what the mapping builds from a violation no longer breaks it.` }
  // Which rules name what the constraint is about.
  const factIds = new Set()
  const walkF = (x) => { if (!x || typeof x !== 'object') return; if (x.t === 'fact') factIds.add(x.factId); for (const v of Object.values(x)) if (v && typeof v === 'object') walkF(v) }
  walkF(f)
  const naming = run.there.rules.filter(r => !r.skipped && JSON.stringify(r.fromSide.atoms).match(new RegExp([...factIds].map(id => `"factId":"${id}"`).join('|') || '^$')))
  if (!naming.length) return unknown('No rule maps what this constraint is about, so the mapping says nothing about it.')
  return unknown(`The rules (${naming.slice(0, 4).map(r => r.name).join(', ')}${naming.length > 4 ? ', …' : ''}) carry what this constraint is about only together with other facts that the schema does not require, so a violation is not carried (a coverage question).`)
}

export function accountMapping(state, mapping, options) {
  const steps = accountingSteps(state, mapping, options)
  for (;;) { const r = steps.next(); if (r.done) return r.value }
}

// The same, one constraint per step: yields { done, total } and returns the
// result, so that the Mappings tab can show progress and stay responsive.
export function* accountingSteps(state, mapping, { onlyKeys = null } = {}) {
  const t0 = Date.now()
  const worlds = { source: worldOf(state, mapping.sourceSchemaId), target: worldOf(state, mapping.targetSchemaId) }
  const preps = {
    forward: prepareRun(state, mapping, 'forward', { check: false }),
    backward: prepareRun(state, mapping, 'backward', { check: false }),
  }
  // Labelled nulls, with the value type of each.
  let n = 0
  const fresh = (typeId) => { const v = `⊥${++n}`; if (typeId) fresh.types.set(v, typeId); return v }
  fresh.types = new Map()
  const allEntries = { source: entriesOf(state, mapping.sourceSchemaId), target: entriesOf(state, mapping.targetSchemaId) }
  const todo = Object.fromEntries(SIDES.map(side => [side, allEntries[side].filter(e => !skipEntry(e) && (!onlyKeys || onlyKeys.has(e.key)))]))
  const total = todo.source.length + todo.target.length
  let done = 0
  const sides = {}
  for (const side of SIDES) {
    const A = worlds[side], B = worlds[other(side)]
    const run = side === 'source' ? { there: preps.forward, back: preps.backward } : { there: preps.backward, back: preps.forward }
    run.constants = constantsOf(run.there)
    sides[side] = []
    for (const e of todo[side]) {
      const r = accountEntry(e, A, B, run, fresh)
      r.label = relationalLabel(A, e.key)
      sides[side].push(r)
      yield { done: ++done, total }
    }
  }
  // The other side's entries, for showing what keeps a constraint.
  for (const side of SIDES) {
    const byKey = new Map(allEntries[other(side)].map(e => [e.key, e]))
    for (const r of sides[side]) for (const b of r.by) b.entry = byKey.get(b.key) ?? byKey.get(b.key.split(':')[0]) ?? null
  }
  return { sides, ms: Date.now() - t0, mappingId: mapping.id, ctxs: { source: allEntries.source.ctx, target: allEntries.target.ctx } }
}

export const STATUS_ORDER = ['lost', 'unknown', 'implied', 'native']
