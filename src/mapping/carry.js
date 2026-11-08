// Carrying constraints across a locked mapping (RM schemas first-class,
// step 5; pairLock.js). The constraints either schema got since the lock are
// checked against the other schema (accounting.js); for each that the other
// schema loses, the simplest constraint that keeps it there is proposed:
// first a plain one on a fact type the translation names (a mandatory role,
// a single-role uniqueness, or, between columns of a relational schema, a
// foreign key: NOT NULL, UNIQUE and FOREIGN KEY in its DDL), each checked by
// accounting; else the translation itself (translate.js), as a graphical
// constraint with join paths or a formula constraint, which a relational
// schema writes as a CHECK or an assertion.

import { accountingSteps, entriesOf } from './accounting.js'
import { translateEntry, proposeTranslation } from './translate.js'
import { formulaElements } from '../logic/formulaConstraint.js'
import { relationalModel } from '../relational/relationalModel.js'
import { relationalView } from '../relational/relationalView.js'
import { rmSentence, RM_SENTENCE_LANGUAGES } from '../relational/rmText.js'
import { mkConstraint, uid } from '../store/storeHelpers.js'
import { withImplicitRules } from './sameModel.js'

const otherOf = (side) => (side === 'source' ? 'target' : 'source')
const schemaOf = (mapping, side) => (side === 'source' ? mapping.sourceSchemaId : mapping.targetSchemaId)
const skip = (e) => !e.formula || e.possible || /deriv|implied link/i.test(e.kind ?? '')
const kept = (s) => s === 'native' || s === 'implied'

// The entries each side got since the lock: { source: [entry], target: [entry] }.
export function addedEntries(state, mapping) {
  const out = {}
  for (const side of ['source', 'target']) {
    const sid = schemaOf(mapping, side)
    const base = new Set(mapping.lock?.base?.[sid]?.entryKeys ?? [])
    out[side] = entriesOf(state, sid).filter(e => !skip(e) && !base.has(e.key))
  }
  return out
}

// A plain constraint applied to a state: { state, id } (id: the new
// constraint's, uniqueness's or mandatory's id).
// simple: { kind: 'mandatory', factId, roleIndex } | { kind: 'unique', factId, roleIndex }
//       | { kind: 'fk', schemaId, from: { factId, roleIndex }, to: { factId, roleIndex } }
export function withSimple(state, simple, id = uid()) {
  if (simple.kind === 'fk') {
    const c = { ...mkConstraint('subset', 0, 0), id, schemaId: simple.schemaId,
      sequences: [[{ kind: 'role', ...simple.from }], [{ kind: 'role', ...simple.to }]] }
    return { state: { ...state, constraints: [...state.constraints, c] }, id }
  }
  const facts = state.facts.map(f => {
    if (f.id !== simple.factId) return f
    if (simple.kind === 'mandatory')
      return { ...f, roles: f.roles.map((r, i) => (i === simple.roleIndex ? { ...r, mandatory: true, mandatoryId: id } : r)) }
    return { ...f, uniqueness: [...(f.uniqueness ?? []), { id, roles: [simple.roleIndex] }] }
  })
  return { state: { ...state, facts }, id }
}

// The plain constraints worth trying in the other schema for entry x of
// `side`, the likeliest first.
function candidates(state, mapping, x, side) {
  const t = translateEntry(state, mapping, x.entry, side)
  if (t.error) return []
  const sid = schemaOf(mapping, otherOf(side))
  const named = [...formulaElements(t.rule).facts].map(id => state.facts.find(f => f.id === id)).filter(f => f && f.roles.length === 2)
  const mand = [], uniq = [], fks = []
  for (const f of named) {
    f.roles.forEach((r, i) => {
      if (!r.mandatory) mand.push({ kind: 'mandatory', factId: f.id, roleIndex: i })
      if (!(f.uniqueness ?? []).some(u => u.roles.length === 1 && u.roles[0] === i)) uniq.push({ kind: 'unique', factId: f.id, roleIndex: i })
    })
  }
  const rel = state.schemas?.find(s => s.id === sid)?.profile === 'relational'
  if (rel) {
    const model = relationalModel(state, sid)
    const cols = named.map(f => model.columnByFact.get(f.id)).filter(Boolean)
    const has = new Set(model.fks.map(fk => `${fk.from.map(c => c.fact.id)}>${fk.to.map(c => c.fact.id)}`))
    for (const a of cols) for (const b of cols) {
      if (a.table === b.table || a.vt.id !== b.vt.id || !(b.pk || b.unique) || has.has(`${a.fact.id}>${b.fact.id}`)) continue
      fks.push({ kind: 'fk', schemaId: sid, from: { factId: a.fact.id, roleIndex: a.v }, to: { factId: b.fact.id, roleIndex: b.v } })
    }
  }
  // The kind of the lost constraint first.
  const k = x.key
  const order = /:mand:/.test(k) ? [mand, uniq, fks] : /:uc:|:pi:/.test(k) ? [uniq, mand, fks] : [fks, mand, uniq]
  return order.flat().slice(0, 24)
}

// Accounting's status of key x.key on `side` with the other schema as in state2.
function statusWith(state2, mapping, x, side) {
  const gen = accountingSteps(state2, mapping, { onlyKeys: new Set([x.key]) })
  let r
  do r = gen.next(); while (!r.done)
  return r.value.sides[side].find(e => e.key === x.key) ?? null
}

// What a constraint added to the other schema is there: its entry (sentence
// and formula) and, in a relational schema, its table form.
function describe(state, state2, sid) {
  const before = new Set(entriesOf(state, sid).map(e => e.key))
  const after = entriesOf(state2, sid)
  const entry = after.find(e => !before.has(e.key) && e.formula) ?? null
  let rm = null
  if (state.schemas?.find(s => s.id === sid)?.profile === 'relational') {
    const old = relationalView(state, sid), now = relationalView(state2, sid)
    rm = [...now.objects.values()].filter(o => !old.objects.has(o.rmId) && !['table', 'view', 'column'].includes(o.kind))
      .map(o => ({ rmId: o.rmId, kind: o.kind, label: o.label, sql: o.kind === 'notNull' ? null : o.sql, enforced: o.enforced, sentence: Object.fromEntries(RM_SENTENCE_LANGUAGES.map(lang => [lang, rmSentence(now, o, { lang })])) }))
  }
  return { entry, ctx: after.ctx, rm }
}

// The proposal for entry x of `side` that the other schema loses:
// { kind: 'simple', simple, status, entry, ctx, rm } or
// { kind: 'translation', carry (proposeTranslation's result), entry, ctx, rm } or { error }.
export function proposeCarry(state, mapping, x, side) {
  mapping = withImplicitRules(state, mapping)
  const sid = schemaOf(mapping, otherOf(side))
  for (const simple of candidates(state, mapping, x, side)) {
    const { state: s2 } = withSimple(state, simple, '__carried')
    let y
    try { y = statusWith(s2, mapping, x, side) } catch { continue }
    if (kept(y?.status)) return { kind: 'simple', simple, status: y.status, ...describe(state, s2, sid) }
  }
  const carry = proposeTranslation(state, mapping, x, side)
  if (carry.error) return { error: carry.error }
  const c = carry.graphical
    ? { ...mkConstraint(carry.graphical.constraintType, 0, 0), id: '__carried', schemaId: sid, ...carry.graphical }
    : { ...mkConstraint('formula', 0, 0), id: '__carried', schemaId: sid, rule: carry.rule, ...(carry.deontic ? { deontic: true } : {}) }
  const s2 = { ...state, constraints: [...state.constraints, c] }
  let d = { entry: carry.entry, ctx: carry.ctx, rm: null }
  try { d = { ...describe(state, s2, sid), entry: d.entry ?? null, ctx: d.ctx } } catch { /* keep the translation's own entry */ }
  return { kind: 'translation', carry, status: carry.status, ...d }
}

// The carry report, one step per constraint: yields { done, total }, returns
// { items: [{ side, x (accounting item), proposal | null }], ms }.
export function* carrySteps(state, mapping) {
  mapping = withImplicitRules(state, mapping)
  const t0 = Date.now()
  const added = addedEntries(state, mapping)
  const keys = new Set([...added.source, ...added.target].map(e => e.key))
  const items = []
  if (!keys.size) return { items, ms: 0 }
  const gen = accountingSteps(state, mapping, { onlyKeys: keys })
  let r
  const total = keys.size * 2
  do { r = gen.next(); if (!r.done) yield { done: r.value.done, total } } while (!r.done)
  let done = keys.size
  for (const side of ['source', 'target']) {
    for (const x of r.value.sides[side]) {
      items.push({ side, x, proposal: kept(x.status) ? null : proposeCarry(state, mapping, x, side) })
      yield { done: ++done, total }
    }
  }
  return { items, ms: Date.now() - t0, ctxs: r.value.ctxs }
}

// ALTER TABLE statements for what a relational schema got since the lock:
// NOT NULLs, keys, foreign keys and CHECKs; assertions as their violation
// queries, in comments.
export function changeScript(state, mapping, schemaId) {
  const base = new Set(mapping.lock?.base?.[schemaId]?.rmIds ?? [])
  const view = relationalView(state, schemaId)
  const q = (n) => (/^[a-z_][a-z0-9_$]*$/.test(n) ? n : `"${n.replace(/"/g, '""')}"`)
  const lines = []
  for (const o of view.objects.values()) {
    if (base.has(o.rmId) || ['table', 'view', 'column'].includes(o.kind)) continue
    const t = view.objects.get(o.table)
    const tn = t ? q(t.name) : '?'
    if (o.kind === 'notNull') lines.push(`ALTER TABLE ${tn} ALTER COLUMN ${q(view.objects.get(o.columns[0])?.name ?? '?')} SET NOT NULL;`)
    else if (['primaryKey', 'unique', 'foreignKey', 'check'].includes(o.kind)) lines.push(`ALTER TABLE ${tn} ADD CONSTRAINT ${q(o.name)} ${o.sql};`)
    else if (o.kind === 'assertion') {
      lines.push(`-- ${o.label}: not enforced by PostgreSQL${o.query ? '; the rows that break it:' : ' (no SQL form)'}`)
      if (o.query) lines.push(...o.query.split('\n').map(l => `--   ${l}`))
    }
  }
  return lines.join('\n')
}
