// The contract check of a view mapping (data exchange plan, step 4): which
// constraints of the view's target (the consumer's schema) the source's
// constraints (the supplier's) guarantee through the views, and for the
// others a counterexample: a population of the source that meets its
// constraints but gives, through the views, one that breaks the target's.
// That is what the supplier must also guarantee.
//
// GAV views compose by substitution, so in the logic this unfolds each
// target constraint through the views into a formula over the source and
// asks whether the source's constraints imply it. As constraint accounting
// does for two-way mappings (accounting.js), the unfolding is done on
// populations: the two schemas are put into one world whose constraints are
// the source's and the view rules (each as a formula constraint, a target
// element holds iff its rule's body does), and the smallest violation of the
// target constraint is closed under them by the chase (contractEntry).

import { worldOf, entriesOf, contractEntry, relationalLabel, relationalSentence } from './accounting.js'
import { viewRuleEntries, runView, headId } from './views.js'
import { formulaToRule } from '../logic/formulaToRule.js'
import { withSimple } from './carry.js'
import { computePopulationIssues } from '../utils/populationValidation.js'
import { identifyingFactIds } from '../utils/refMode.js'
import { valueKindName } from '../utils/datatypeValues.js'

const MERGED = '__contract__'
const skip = (e) => !e.formula || e.possible || /deriv|implied link/i.test(e.kind ?? '')

// The state with the view's two schemas as one (schema MERGED), the target's
// elements stored (not derived), and each view rule's formulas as formula
// constraints `view:<ruleId>:<i>`. Returns { state, viewKeys, notes }.
function mergedState(state, view) {
  const ids = new Set([view.sourceSchemaId, view.targetSchemaId])
  const heads = new Set((view.rules ?? []).map(headId))
  const move = (x) => (ids.has(x.schemaId) ? { ...x, schemaId: MERGED } : x)
  const plain = (x) => (heads.has(x.id) ? { ...x, derivation: undefined, derivationRule: undefined } : x)
  const constraints = (state.constraints ?? []).map(move)
  const viewKeys = new Set()
  const notes = []
  for (const r of view.rules ?? []) {
    const entries = viewRuleEntries(state, view, r)
    entries.forEach((e, i) => {
      if (!e.formula) return
      let rule
      try { rule = formulaToRule(e.formula) } catch {
        notes.push(`The rule for ${e.title ?? 'an element'} has a part the check cannot use; it is left out.`)
        return
      }
      const id = `view:${r.id}:${i}`
      viewKeys.add(id)
      constraints.push({ id, constraintType: 'formula', rule, schemaId: MERGED, name: `View rule ${i + 1}` })
    })
  }
  // A target entity type without a rule of its own gets its instances only
  // from fact rules that compute a role it plays: each instance plays one of
  // those roles (a disjunction the chase branches on). One that nothing
  // gives is empty, as is a fact type without a rule.
  const target = (x) => x.schemaId === view.targetSchemaId
  const ident = identifyingFactIds((state.facts ?? []).filter(target), (state.objectTypes ?? []).filter(target), (state.constraints ?? []).filter(target))
  const identifying = (fid) => ident.entity.has(fid) || ident.nested.has(fid)
  const producers = new Map()
  for (const r of view.rules ?? []) {
    if (!r.head.factId) continue
    const f = (state.facts ?? []).find(x => x.id === r.head.factId)
    if (!f) continue
    f.roles.forEach((role, i) => {
      if (!r.rule?.terms?.[role.id]) return
      if (!producers.has(role.objectTypeId)) producers.set(role.objectTypeId, [])
      producers.get(role.objectTypeId).push({ fact: f, i })
    })
  }
  const empty = new Set()
  const hasSubtypes = (id) => (state.subtypes ?? []).some(st => st.superId === id)
  for (const o of (state.objectTypes ?? []).filter(target)) {
    if (o.kind !== 'entity' || heads.has(o.id) || hasSubtypes(o.id)) continue
    const ps = producers.get(o.id) ?? []
    if (!ps.length) { empty.add(o.id); continue }
    const e = { id: 'e', typeId: o.id }
    const alt = ({ fact, i }) => {
      const vars = fact.roles.map((r, k) => (k === i ? null : { id: `y${k}`, typeId: r.objectTypeId }))
      const atom = { t: 'fact', factId: fact.id, args: fact.roles.map((_, k) => (k === i ? 'e' : `y${k}`)) }
      return vars.filter(Boolean).reduceRight((b, v) => ({ t: 'exists', v, body: b }), atom)
    }
    const right = ps.length === 1 ? alt(ps[0]) : { t: 'or', args: ps.map(alt) }
    const id = `view:produce:${o.id}`
    viewKeys.add(id)
    constraints.push({ id, constraintType: 'formula', schemaId: MERGED, name: `Where ${o.name} comes from`,
      rule: { t: 'forall', v: e, body: { t: 'implies', left: { t: 'type', typeId: o.id, arg: 'e' }, right } } })
  }
  for (const f of (state.facts ?? []).filter(target)) if (!heads.has(f.id) && !identifying(f.id) && f.derivation !== 'derived') empty.add(f.id)
  return {
    empty,
    state: {
      ...state,
      schemas: [...(state.schemas ?? []), { id: MERGED, name: 'Source and target', profile: 'orm2' }],
      objectTypes: (state.objectTypes ?? []).map(o => plain(move(o))),
      facts: (state.facts ?? []).map(f => plain(move(f))),
      subtypes: (state.subtypes ?? []).map(move),
      constraints,
    },
    viewKeys, notes,
  }
}

// The population with each labelled null ⊥n replaced by a value of its
// value type's datatype that occurs nowhere else (numbers from 900001, dates
// from 2100-01-01, texts "value n"), so the views can compute with it.
// Booleans and types without a datatype keep ⊥n. Cached per population.
const concreteCache = new WeakMap()
function concrete(state, src) {
  if (concreteCache.has(src)) return concreteCache.get(src)
  const otById = new Map((state.objectTypes ?? []).map(o => [o.id, o]))
  const map = new Map()
  let n = 0
  const pick = (kind) => {
    n++
    if (kind === 'integer' || kind === 'decimal' || kind === 'float') return String(900000 + n)
    if (kind === 'string') return `value ${n}`
    if (kind === 'date' || kind === 'datetime') {
      const d = new Date(Date.UTC(2100, 0, 1) + n * 86400000).toISOString()
      return kind === 'date' ? d.slice(0, 10) : d.slice(0, 19)
    }
    return null
  }
  for (const [id, cells] of Object.entries(src.populations)) {
    const o = otById.get(id)
    if (o?.kind !== 'value') continue
    const kind = valueKindName(o.datatypeAssignment)
    for (const c of cells) if (typeof c === 'string' && c.startsWith('⊥') && !map.has(c)) { const v = pick(kind); if (v != null) map.set(c, v) }
  }
  const sub = (c) => (Array.isArray(c) ? c.map(sub) : map.get(c) ?? c)
  const out = {
    populations: Object.fromEntries(Object.entries(src.populations).map(([k, v]) => [k, v.map(sub)])),
    factPopulations: Object.fromEntries(Object.entries(src.factPopulations).map(([k, v]) => [k, v.map(t => t.map(sub))])),
  }
  concreteCache.set(src, out)
  return out
}

// Runs the views on a population of the source (labelled nulls as values)
// and says whether the target constraint `match` is broken: true, false, or
// null when the views could not be run.
function confirmer(state, view, targetWorld) {
  return (src, match) => {
    try {
      const keep = (obj) => Object.fromEntries(Object.entries(obj ?? {}).filter(([id]) => !targetWorld.ids.has(id)))
      const s = {
        ...state,
        populations: { ...keep(state.populations), ...concrete(state, src).populations },
        factPopulations: { ...keep(state.factPopulations), ...concrete(state, src).factPopulations },
      }
      const run = runView(s, view)
      const pops = { populations: run.populations, factPopulations: run.factPopulations }
      const issues = match.evaluate ? match.evaluate(targetWorld.w, pops)
        : computePopulationIssues({ ...targetWorld.w.els, schemas: [], ...pops, nestedEntityMappings: {}, subtypeMappings: {} }).filter(match)
      return issues.length > 0
    } catch {
      return null
    }
  }
}

// One step per target constraint: yields { done, total } and returns
// { results: [result], notes, ms, viewId }. Results as contractEntry's, with
// `by` labelled in the source's own terms (table names for a relational
// source).
export function* contractSteps(state, view, { onlyKeys = null, propose = !onlyKeys } = {}) {
  const t0 = Date.now()
  const { state: ms, viewKeys, notes, empty } = mergedState(state, view)
  const W = worldOf(ms, MERGED)
  const sourceIds = new Set([...(state.objectTypes ?? []), ...(state.facts ?? [])].filter(x => x.schemaId === view.sourceSchemaId).map(x => x.id))
  const targetIds = new Set([...(state.objectTypes ?? []), ...(state.facts ?? [])].filter(x => x.schemaId === view.targetSchemaId).map(x => x.id))
  const srcEntries = entriesOf(state, view.sourceSchemaId)
  const tgtEntries = entriesOf(state, view.targetSchemaId)
  const sourceKeys = new Set(srcEntries.filter(e => !skip(e)).map(e => e.key))
  for (const c of state.constraints ?? []) if (c.schemaId === view.sourceSchemaId) sourceKeys.add(c.id)
  // The source's uniqueness constraints (merges only), for a first, small chase.
  const uniqueKeys = new Set([...sourceKeys].filter(k => /:uc:/.test(k) || (state.constraints ?? []).some(c => c.id === k && c.constraintType === 'uniqueness')))
  const targetKeys = new Set(tgtEntries.map(e => e.key))
  for (const c of state.constraints ?? []) if (c.schemaId === view.targetSchemaId) targetKeys.add(c.id)
  // The target's identification is structure the views keep (an instance
  // is its reference values), so its preferred identifiers stay on.
  for (const k of [...targetKeys]) if (/:pi:|:exactlyOne$/.test(k)) targetKeys.delete(k)
  const T = worldOf(state, view.targetSchemaId)
  const targetWorld = { w: T, ids: new Set([...sourceIds, ...targetIds]) }
  const confirm = confirmer(state, view, targetWorld)
  const S = worldOf(state, view.sourceSchemaId)
  let n = 0
  const fresh = (typeId) => { const v = `⊥${++n}`; if (typeId) fresh.types.set(v, typeId); return v }
  fresh.types = new Map()
  const todo = tgtEntries.filter(e => !skip(e) && (!onlyKeys || onlyKeys.has(e.key)))
  const results = []
  let done = 0
  for (const e of todo) {
    let r
    try { r = contractEntry(e, W, { sourceKeys, targetKeys, viewKeys, sourceIds, confirm, empty, uniqueKeys }, fresh) } catch (err) {
      r = { key: e.key, entry: e, by: [], counterexample: null, status: 'unknown', reason: `Not checked: ${err?.message ?? err}.` }
    }
    const byKey = new Map(srcEntries.map(x => [x.key, x]))
    r.by = r.by.map(b => ({ ...b, entry: byKey.get(b.key) ?? byKey.get(String(b.key).split(':')[0]) ?? null,
      label: relationalLabel(S, b.key), sentence: relationalSentence(S, b.key) }))
    r.label = relationalLabel(T, e.key)
    results.push(r)
    yield { done: ++done, total: todo.length }
  }
  // For each counterexample, a plain constraint of the source that would
  // rule it out, with its entry there (for its sentence).
  if (propose) {
    const must = results.filter(r => r.status === 'mustGuarantee')
    let k = 0
    for (const r of must) {
      const p = proposeGuarantee(state, view, r)
      if (p) {
        const entries = entriesOf(p.state, view.sourceSchemaId)
        r.proposal = { simple: p.simple, key: p.key, entry: entries.find(e => e.key === p.key) ?? null, ctx: entries.ctx,
          label: relationalLabel(worldOf(p.state, view.sourceSchemaId), p.key), sentence: relationalSentence(worldOf(p.state, view.sourceSchemaId), p.key) }
      }
      yield { done: done + (++k), total: todo.length + must.length }
    }
  }
  return { results, notes, ms: Date.now() - t0, viewId: view.id, ctxs: { source: srcEntries.ctx, target: tgtEntries.ctx } }
}

export function checkContract(state, view, opts) {
  const steps = contractSteps(state, view, opts)
  for (;;) { const r = steps.next(); if (r.done) return r.value }
}

export const CONTRACT_ORDER = ['mustGuarantee', 'unknown', 'guaranteed']

// What the supplier could add so that a target constraint the check found a
// counterexample for is guaranteed: a mandatory role or a single-role
// uniqueness constraint on a fact type of the source that the view rules
// for the constraint's elements read, each tried in turn (the constraint's
// own kind first). Returns { simple, key, state } (the source state with it,
// and the key of its entry there) or null.
export function proposeGuarantee(state, view, result, { max = 10 } = {}) {
  const factIds = new Set(), typeIds = new Set()
  const walk = (x) => {
    if (!x || typeof x !== 'object') return
    if (x.t === 'fact' && x.factId) factIds.add(String(x.factId).split('_il_')[0])
    if (x.t === 'type' && x.typeId) typeIds.add(x.typeId)
    if (x.typeId && !x.t) typeIds.add(x.typeId)
    for (const v of Object.values(x)) if (v && typeof v === 'object') walk(v)
  }
  walk(result.entry?.formula)
  const named = new Set()
  const walkRule = (x) => {
    if (!x || typeof x !== 'object') return
    if (x.t === 'fact' && x.factId) named.add(String(x.factId).split('_il_')[0])
    for (const v of Object.values(x)) if (v && typeof v === 'object') walkRule(v)
  }
  const plays = (r) => {
    const f = (state.facts ?? []).find(x => x.id === r.head.factId)
    return f?.roles.some(q => typeIds.has(q.objectTypeId))
  }
  for (const r of view.rules ?? []) if (factIds.has(headId(r)) || typeIds.has(headId(r)) || plays(r)) walkRule(r.rule)
  const facts = (state.facts ?? []).filter(f => named.has(f.id) && f.schemaId === view.sourceSchemaId && f.roles.length === 2)
  const mand = [], uniq = []
  for (const f of facts) f.roles.forEach((r, i) => {
    if (!r.mandatory) mand.push({ kind: 'mandatory', factId: f.id, roleIndex: i })
    if (!(f.uniqueness ?? []).some(u => u.roles.length === 1 && u.roles[0] === i)) uniq.push({ kind: 'unique', factId: f.id, roleIndex: i })
  })
  const order = /:mand:|Mandatory|Participation|part:/.test(`${result.key} ${result.entry?.kind ?? ''}`) ? [...mand, ...uniq] : [...uniq, ...mand]
  for (const simple of order.slice(0, max)) {
    const st = withSimple(state, simple).state
    const r = checkContract(st, view, { onlyKeys: new Set([result.key]) }).results[0]
    if (r?.status === 'guaranteed') return { simple, key: `${simple.factId}:${simple.kind === 'mandatory' ? 'mand' : 'uc'}:${simple.roleIndex}`, state: st }
  }
  return null
}
