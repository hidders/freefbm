// Constraints only (RM schemas first-class, step 5). A mapping can lock its
// two schemas so that they take new constraints but no other edits: the use
// case is an imported SQL schema, an ORM2 schema guessed from it, and a
// discussion with stakeholders that finds missing constraints. Constraints
// added to either side are then carried to the other side (carry.js), and
// the rules stay valid because nothing they name changes.
//
// mapping.lock = { at, base: { [schemaId]: { constraintIds, ucIds, mandatory,
// freqIds, entryKeys, rmIds } } } records what each schema had when it was
// locked. Under the lock a schema may get new constraints of any kind
// (external and formula constraints, mandatory roles, internal uniqueness,
// internal frequency, value and cardinality ranges), and change or remove
// those it got since; the constraints it had stay as they were (value and
// cardinality ranges excepted, which may change), and so do its object
// types, fact types (readings, roles, players) and subtypes.

import { entriesOf } from './accounting.js'
import { relationalView } from '../relational/relationalView.js'

const isRel = (state, id) => state.schemas?.find(s => s.id === id)?.profile === 'relational'

// What a schema has now, to compare later edits and additions with.
export function lockBase(state, schemaId) {
  const inS = (x) => x.schemaId === schemaId
  const facts = (state.facts ?? []).filter(inS)
  return {
    constraintIds: (state.constraints ?? []).filter(inS).map(c => c.id),
    ucIds: facts.flatMap(f => (f.uniqueness ?? []).map(u => u.id)),
    mandatory: facts.flatMap(f => f.roles.map((r, i) => (r.mandatory ? `${f.id}:${i}` : null)).filter(Boolean)),
    freqIds: facts.flatMap(f => (f.internalFrequency ?? []).map(q => q.id)),
    entryKeys: entriesOf(state, schemaId).map(e => e.key),
    rmIds: isRel(state, schemaId) ? [...relationalView(state, schemaId).objects.keys()] : null,
  }
}

export function mkLock(state, mapping) {
  return { at: new Date().toISOString(), base: {
    [mapping.sourceSchemaId]: lockBase(state, mapping.sourceSchemaId),
    [mapping.targetSchemaId]: lockBase(state, mapping.targetSchemaId),
  } }
}

// Map(schemaId → { base (merged over the locks naming it), mappingName }).
export function lockedSchemas(state) {
  const out = new Map()
  for (const m of state.mappings ?? []) {
    if (!m.lock?.base) continue
    for (const [sid, b] of Object.entries(m.lock.base)) {
      const cur = out.get(sid)
      if (!cur) { out.set(sid, { mappingName: m.name, constraintIds: new Set(b.constraintIds), ucIds: new Set(b.ucIds), mandatory: new Set(b.mandatory), freqIds: new Set(b.freqIds) }); continue }
      for (const k of ['constraintIds', 'ucIds', 'mandatory', 'freqIds']) for (const v of b[k] ?? []) cur[k].add(v)
    }
  }
  return out
}

// JSON without positions (x, y at any depth) and without the given keys at the top.
const unplaced = (v, drop = []) => JSON.stringify(v, function (k, val) {
  if ((k === 'x' || k === 'y') && typeof val === 'number') return undefined
  if (this === v && drop.includes(k)) return undefined
  return val
})

const OT_CONSTRAINT_KEYS = ['valueRange', 'cardinalityRange']
const FACT_CONSTRAINT_KEYS = ['uniqueness', 'internalFrequency', 'roles', 'preferredUniqueness', 'deonticUniqueness']
const ROLE_CONSTRAINT_KEYS = ['mandatory', 'mandatoryId', 'mandatoryDeontic', 'valueRange', 'cardinalityRange']

// Whether a fact type changed other than in constraints the lock allows.
function factProblem(o, x, base) {
  if (unplaced(o, FACT_CONSTRAINT_KEYS) !== unplaced(x, FACT_CONSTRAINT_KEYS)) return true
  if (o.roles.length !== x.roles.length) return true
  // The preferred identifier stays (an empty list and none are the same).
  if (JSON.stringify(o.preferredUniqueness ?? []) !== JSON.stringify(x.preferredUniqueness ?? [])) return true
  for (let i = 0; i < o.roles.length; i++) {
    if (unplaced(o.roles[i], ROLE_CONSTRAINT_KEYS) !== unplaced(x.roles[i], ROLE_CONSTRAINT_KEYS)) return true
    if (base.mandatory.has(`${o.id}:${i}`) && !x.roles[i].mandatory) return true
  }
  const kept = (arr, ids) => (arr ?? []).filter(u => ids.has(u.id)).map(u => unplaced(u)).sort().join('|')
  if (kept(o.uniqueness, base.ucIds) !== kept(x.uniqueness, base.ucIds)) return true
  if (kept(o.internalFrequency, base.freqIds) !== kept(x.internalFrequency, base.freqIds)) return true
  return false
}

// Why an update (prev → next, next possibly partial) is refused, or null: it
// edits a relational schema that is not locked (read-only), or a locked
// schema other than by adding constraints.
export function refusedEdit(prev, next) {
  const schemas = next.schemas ?? prev.schemas ?? []
  const rel = new Set(schemas.filter(s => s.profile === 'relational').map(s => s.id))
  const locked = (next.mappings ?? prev.mappings ?? []).some(m => m.lock) ? lockedSchemas({ mappings: next.mappings ?? prev.mappings }) : new Map()
  if (!rel.size && !locked.size) return null
  const guarded = (x) => x && !x._implicit && (rel.has(x.schemaId) || locked.has(x.schemaId))
  for (const key of ['objectTypes', 'facts', 'subtypes', 'constraints']) {
    const a = prev[key] ?? [], b = next[key]
    if (!Array.isArray(b) || a === b) continue
    const before = new Map(a.map(x => [x.id, x]))
    const kept = new Set()
    for (const x of b) {
      const o = before.get(x.id)
      kept.add(x.id)
      if (o === x || !(guarded(x) || guarded(o))) continue
      const sid = (o ?? x).schemaId
      const lock = locked.get(sid)
      if (!lock) { if (!o || unplaced(o) !== unplaced(x)) return { reason: 'readOnly' }; continue }
      const why = { reason: 'locked', mapping: lock.mappingName }
      if (key === 'constraints') {
        if (o && lock.constraintIds.has(o.id) && unplaced(o) !== unplaced(x)) return why
        continue
      }
      if (!o) return why
      if (key === 'objectTypes') {
        if (unplaced(o, OT_CONSTRAINT_KEYS) !== unplaced(x, OT_CONSTRAINT_KEYS)) return why
        continue
      }
      if (key === 'facts') { if (factProblem(o, x, lock)) return why; continue }
      if (unplaced(o) !== unplaced(x)) return why
    }
    for (const o of a) {
      if (kept.has(o.id) || !guarded(o)) continue
      const lock = locked.get(o.schemaId)
      if (!lock) return { reason: 'readOnly' }
      if (key !== 'constraints' || lock.constraintIds.has(o.id)) return { reason: 'locked', mapping: lock.mappingName }
    }
  }
  return null
}
