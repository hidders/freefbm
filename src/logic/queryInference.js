// The queries FreeFBM infers for the role sequences of external constraints.
//
// The query of a sequence is in one of three states:
//   stored    the user drew or wrote it, or an import read it;
//   inferred  nothing is stored and there is exactly one natural join for the
//             sequence (the rules per constraint kind are below); it is worked
//             out again whenever the schema changes and never saved;
//   open      nothing is stored and there is no single natural join: no query,
//             and for kinds with a target object type no inferred target.
// The target object type belongs to the query: it is inferred together with
// the queries, or set by the user (targetInferred unset), or the target of a
// stored query. The store keeps the inferred queries in the constraint, marked
// inferred: true (and the inferred target marked targetInferred: true), so
// every reader of c.queries sees them; saving leaves them out.
//
// Rules (the Claude doc "Rules for queries and target object types of
// external constraints", agreed with Jan 2026-11-24):
//   external uniqueness and frequency: one sequence of roles in different
//     binary fact types whose other roles are played by a common supertype T
//     (or, with a target the user chose, by T or a subtype of it): the target
//     is T and the query joins through it. Roles of one fact type stay open:
//     the constraint means an internal one.
//   inclusive-or and exclusive-or: sequences of one role or subtype link whose
//     players (supertypes of the links) have a common supertype T, or are each
//     the user's target or a subtype of it.
//   exclusion, subset, equality, ring, value comparison: no target; per
//     sequence, roles of one fact type, one subtype link, or roles of binary
//     fact types (different ones for ring and value comparison) whose other
//     roles are played by a common supertype.
// Only binary fact types are joined; anything else stays open.

import { findUniqueLCA, findPathDown } from '../store/storeHelpers.js'

export const TARGET_KINDS = new Set(['uniqueness', 'frequency', 'inclusiveOr', 'exclusiveOr'])
const OR_KINDS = new Set(['inclusiveOr', 'exclusiveOr'])
const PAIR_KINDS = new Set(['ring', 'valueComparison'])
const INFERRING = new Set([...TARGET_KINDS, 'exclusion', 'equality', 'subset', 'ring', 'valueComparison'])

const KIND_LABEL = { uniqueness: 'uniqueness', frequency: 'frequency' }

// A stored query: one the user or an import made, not one inferred.
export const isStoredQuery = (q) => !!q && !q.inferred

// The target object type of a stored query: the output object type atom of a
// graph, or the target variable of a formula. Undefined when it has none.
export function storedQueryTarget(q) {
  if (!isStoredQuery(q)) return undefined
  if (q.atoms || q.copies) {
    const t = (q.atoms ?? q.copies).find(a => a.kind === 'objectType' && a.isOutput && !a.freeVar)
    return t?.originalId ?? undefined
  }
  return q.target?.typeId ?? undefined
}

// What inference needs of the schema: facts and subtypes by id, type names.
export function inferenceEnv(state) {
  return {
    factById: new Map((state.facts ?? []).map(f => [f.id, f])),
    subtypes: state.subtypes ?? [],
    subtypeById: new Map((state.subtypes ?? []).map(s => [s.id, s])),
    nameOf: (id) => (state.objectTypes ?? []).find(o => o.id === id)?.name
      ?? (state.facts ?? []).find(f => f.id === id)?.objectifiedName ?? 'a deleted type',
  }
}

const names = (ids, env) => {
  const ns = [...new Set(ids)].map(env.nameOf)
  return ns.length <= 2 ? ns.join(' and ') : `${ns.slice(0, -1).join(', ')} and ${ns.at(-1)}`
}

// The roles of a sequence when every member is a role of a fact type (not of
// a link fact type), else null.
const rolesOf = (seq) => {
  if (!seq.length || seq.some(m => m.kind !== 'role' || m.factId?.includes('_il_'))) return null
  return seq.map((m, pos) => ({ ...m, pos }))
}

// The join of roles of binary fact types through their other roles' players:
// { graph, target } with the target object type T, or { reason }.
function joinThrough(roles, i, env, { target = null, asOutput = false } = {}) {
  const facts = roles.map(m => env.factById.get(m.factId))
  const k = facts.findIndex(f => !f)
  if (k >= 0) return { reason: 'one of its roles belongs to a deleted fact type' }
  const nary = facts.find(f => f.roles.length !== 2)
  if (nary) return { reason: `the fact type of one of its roles has ${nary.roles.length === 1 ? 'one role' : `${nary.roles.length} roles`}, and only binary fact types are joined automatically` }
  const others = roles.map((m, j) => facts[j].roles[1 - m.roleIndex]?.objectTypeId)
  if (others.some(o => !o)) return { reason: 'one of its fact types has a role without a player' }
  let T = target
  if (T) {
    const off = others.filter(o => findPathDown(T, o, env.subtypes) === null)
    if (off.length) return { reason: `${names(off, env)} ${off.length === 1 && new Set(off).size === 1 ? 'is' : 'are'} not ${env.nameOf(T)} or a subtype of it, so the roles can't be joined through the target` }
  } else {
    T = findUniqueLCA(others, env.subtypes)
    if (!T) return { reason: `the other roles of its fact types are played by ${names(others, env)}, which have no single common supertype to join through` }
  }
  const id = (n) => `inf${i}_${n}`
  let n = 0
  const root = id(n++)
  const atoms = [{ id: root, kind: 'objectType', originalId: T, isOutput: asOutput, dx: 16, dy: 16 }]
  const links = []
  roles.forEach((m, j) => {
    let prev = root
    for (const step of findPathDown(T, others[j], env.subtypes)) {
      const child = id(n++), st = id(n++)
      atoms.push({ id: child, kind: 'objectType', originalId: step.toId, isOutput: false, dx: (j + 2) * 16, dy: (j + 2) * 16 })
      atoms.push({ id: st, kind: 'subtype', originalId: step.subtypeId, isOutput: false, dx: (j + 2) * 16, dy: (j + 2) * 16 })
      links.push({ atomId: st, roleIndex: 1, variableId: prev })
      links.push({ atomId: st, roleIndex: 0, variableId: child })
      prev = child
    }
    const fa = id(n++)
    atoms.push({ id: fa, kind: 'fact', originalId: m.factId, isOutput: false,
      seededRoles: [{ roleIndex: m.roleIndex, seqPosition: m.pos }], dx: (j + 3) * 16, dy: (j + 3) * 16 })
    links.push({ atomId: fa, roleIndex: 1 - m.roleIndex, variableId: prev })
  })
  return { graph: { atoms, links, inferred: true }, target: T }
}

// The roles of one fact type as one fact atom.
const oneFact = (roles, i) => ({
  graph: { inferred: true, links: [], atoms: [{ id: `inf${i}_0`, kind: 'fact', originalId: roles[0].factId, isOutput: false,
    seededRoles: roles.map(m => ({ roleIndex: m.roleIndex, seqPosition: m.pos })), dx: 16, dy: 16 }] },
})

// One subtype link: its subtype's population.
function subtypeGraph(st, i) {
  const sub = `inf${i}_0`, sup = `inf${i}_1`, edge = `inf${i}_2`
  return { inferred: true,
    atoms: [
      { id: sub, kind: 'objectType', originalId: st.subId, isOutput: false, dx: 16, dy: 16 },
      { id: sup, kind: 'objectType', originalId: st.superId, isOutput: false, dx: 32, dy: 32 },
      { id: edge, kind: 'subtype', originalId: st.id, isSeeded: true, isOutput: false, dx: 24, dy: 24 },
    ],
    links: [
      { atomId: edge, roleIndex: 0, variableId: sub },
      { atomId: edge, roleIndex: 1, variableId: sup },
    ] }
}

// A sequence of a kind without a target: { graph } or { reason }.
function inferPlain(c, seq, i, env) {
  if (seq.length === 1 && seq[0].kind === 'subtype') {
    const st = env.subtypeById.get(seq[0].subtypeId)
    return st ? { graph: subtypeGraph(st, i) } : { reason: 'its subtype link was deleted' }
  }
  const roles = rolesOf(seq)
  if (!roles) return { reason: seq.some(m => m.kind === 'subtype')
    ? 'it mixes subtype links with roles, or holds several subtype links' : 'it holds a role of a link fact type' }
  if (new Set(roles.map(m => m.factId)).size === 1) {
    if (!env.factById.get(roles[0].factId)) return { reason: 'its fact type was deleted' }
    return oneFact(roles, i)
  }
  if (PAIR_KINDS.has(c.constraintType) && roles.length !== 2) return { reason: 'it needs exactly two roles' }
  const r = joinThrough(roles, i, env)
  return r.reason ? r : { graph: r.graph }
}

// The anchor of a one-member sequence of an or-constraint: the role's player,
// or the subtype link's supertype; { anchor, member } or { reason }.
function orAnchor(seq, env) {
  if (seq.length !== 1) return { reason: 'each of its sequences must be one role or one subtype link' }
  const m = seq[0]
  if (m.kind === 'subtype') {
    const st = env.subtypeById.get(m.subtypeId)
    return st ? { anchor: st.superId, st } : { reason: 'its subtype link was deleted' }
  }
  if (m.kind !== 'role' || m.factId?.includes('_il_')) return { reason: 'it holds a role of a link fact type' }
  const f = env.factById.get(m.factId)
  const anchor = f?.roles[m.roleIndex]?.objectTypeId
  return anchor ? { anchor, m } : { reason: 'its role has no player' }
}

function orGraph(a, i) {
  if (a.st) {
    const sub = `inf${i}_0`, edge = `inf${i}_1`
    return { inferred: true,
      atoms: [
        { id: sub, kind: 'objectType', originalId: a.st.subId, isOutput: false, dx: 16, dy: 16 },
        { id: edge, kind: 'subtype', originalId: a.st.id, isOutput: true, isSeeded: true, dx: 24, dy: 24 },
      ],
      links: [{ atomId: edge, roleIndex: 0, variableId: sub }] }
  }
  return { inferred: true, links: [], atoms: [{ id: `inf${i}_0`, kind: 'fact', originalId: a.m.factId, isOutput: false,
    seededRoles: [{ roleIndex: a.m.roleIndex, seqPosition: 0 }], dx: 16, dy: 16 }] }
}

// The queries and target of constraint c with every sequence that has no
// stored query inferred where it can be:
//   { queries, target, targetInferred, reasons }
// where reasons[i] says why sequence i is open (null when it is not). A
// target the user set (c.targetObjectTypeId without targetInferred) is kept;
// a stored query's target wins over it.
export function inferConstraint(c, env) {
  const seqs = c.sequences ?? []
  const stored = seqs.map((_, i) => (isStoredQuery(c.queries?.[i]) ? c.queries[i] : null))
  const reasons = seqs.map(() => null)
  const queries = [...stored]
  const kind = c.constraintType
  if (!INFERRING.has(kind)) return { queries: c.queries ?? [], target: c.targetObjectTypeId ?? null, targetInferred: false, reasons }
  // A NORMA join path the importer could not read: nothing is inferred in its place.
  if (c.untranslatedJoin) {
    seqs.forEach((seq, i) => { if (!stored[i] && seq?.length) reasons[i] = 'the imported NORMA file has a join path for it that FreeFBM could not translate' })
    const t = TARGET_KINDS.has(kind) ? (stored.map(storedQueryTarget).find(Boolean) ?? (c.targetInferred ? null : c.targetObjectTypeId ?? null)) : c.targetObjectTypeId ?? null
    return { queries, target: t, targetInferred: false, reasons }
  }

  if (!TARGET_KINDS.has(kind)) {
    seqs.forEach((seq, i) => {
      if (stored[i] || !seq?.length) return
      const r = inferPlain(c, seq, i, env)
      if (r.graph) queries[i] = r.graph
      else reasons[i] = r.reason
    })
    return { queries, target: c.targetObjectTypeId ?? null, targetInferred: false, reasons }
  }

  const userTarget = c.targetInferred ? null : (c.targetObjectTypeId ?? null)
  const storedTarget = stored.map(storedQueryTarget).find(t => t)
  const fixed = storedTarget ?? userTarget

  if (!OR_KINDS.has(kind)) {
    const seq = seqs[0] ?? []
    if (stored[0] || !seq.length) return { queries, target: fixed, targetInferred: false, reasons }
    const roles = rolesOf(seq)
    let r
    if (!roles) r = { reason: 'it holds a subtype link or a role of a link fact type' }
    else if (new Set(roles.map(m => m.factId)).size === 1)
      r = { reason: `its roles are all in one fact type: use an internal ${KIND_LABEL[kind]} constraint instead` }
    else if (new Set(roles.map(m => m.factId)).size !== roles.length)
      r = { reason: 'two of its roles are in the same fact type, and only roles of different fact types are joined automatically' }
    else r = joinThrough(roles, 0, env, { target: fixed, asOutput: true })
    if (r.reason) {
      reasons[0] = r.reason
      return { queries, target: fixed, targetInferred: false, reasons }
    }
    queries[0] = r.graph
    return { queries, target: r.target, targetInferred: !fixed, reasons }
  }

  // Inclusive-or and exclusive-or.
  const anchors = seqs.map(seq => orAnchor(seq ?? [], env))
  let T = fixed
  let why = null
  if (!T) {
    const bad = anchors.find(a => a.reason)
    if (bad) why = bad.reason
    else {
      T = findUniqueLCA(anchors.map(a => a.anchor), env.subtypes)
      if (!T) why = `its roles are played by ${names(anchors.map(a => a.anchor), env)}, which have no single common supertype`
    }
  }
  seqs.forEach((seq, i) => {
    if (stored[i] || !seq?.length) return
    const a = anchors[i]
    if (!T) reasons[i] = why
    else if (a.reason) reasons[i] = a.reason
    else if (findPathDown(T, a.anchor, env.subtypes) === null)
      reasons[i] = `${env.nameOf(a.anchor)} is not the target ${env.nameOf(T)} or a subtype of it`
    else queries[i] = orGraph(a, i)
  })
  return { queries, target: T ?? null, targetInferred: !!T && !fixed, reasons }
}

// Why sequence i of c has no query, for validation and the Inspector, or null.
export function openReason(c, i, env) {
  if (TARGET_KINDS.has(c.constraintType) && !c.targetObjectTypeId)
    return inferConstraint(c, env).reasons[i] ?? 'it has no target object type'
  return inferConstraint(c, env).reasons[i]
}

// ── Keeping the store's constraints up to date ──────────────────────────────

const same = (a, b) => a === b || JSON.stringify(a ?? null) === JSON.stringify(b ?? null)

// c with its inferred queries and target brought up to date (c itself when
// nothing changed).
export function withInferredQueries(c, env) {
  if (!INFERRING.has(c.constraintType) || !(c.sequences?.length)) return c
  const r = inferConstraint(c, env)
  const old = c.queries ?? []
  let changed = old.length !== r.queries.length
  const queries = r.queries.map((q, i) => {
    if (q && !q.inferred) return q
    if (same(old[i], q)) return old[i] ?? null
    changed = true
    return q
  })
  const next = { ...c }
  if (changed) next.queries = queries
  if (TARGET_KINDS.has(c.constraintType)) {
    const target = r.target ?? null
    if ((c.targetObjectTypeId ?? null) !== target) { next.targetObjectTypeId = target; changed = true }
    if (!!c.targetInferred !== r.targetInferred) {
      changed = true
      if (r.targetInferred) next.targetInferred = true
      else delete next.targetInferred
    }
  }
  return changed ? next : c
}

// The facts and subtypes inference reads for c, as a string, so a constraint
// is only inferred again when they change.
function inputsKey(c, env) {
  const parts = []
  for (const seq of c.sequences ?? []) for (const m of seq ?? []) {
    if (m.kind === 'role') {
      const f = env.factById.get(m.factId)
      parts.push(f ? `${f.id}:${f.roles.map(r => r.objectTypeId).join(',')}` : `-${m.factId}`)
    } else parts.push(`s${m.subtypeId}`)
  }
  return parts.join('|')
}

const memo = new WeakMap()   // constraint → { subtypes, facts, key }

// The constraints with their inferred queries brought up to date: the same
// array when nothing changed. Cheap when the facts and subtypes a constraint
// reads did not change.
export function refreshInferredQueries(state) {
  const constraints = state.constraints ?? []
  let env = null
  let out = null
  constraints.forEach((c, k) => {
    if (!INFERRING.has(c.constraintType)) return
    const m = memo.get(c)
    if (m && m.subtypes === state.subtypes && m.facts === state.facts) return
    env ??= inferenceEnv(state)
    const key = inputsKey(c, env)
    if (m && m.subtypes === state.subtypes && m.key === key) {
      memo.set(c, { ...m, facts: state.facts })
      return
    }
    const next = withInferredQueries(c, env)
    const entry = { subtypes: state.subtypes, facts: state.facts, key }
    memo.set(next, entry)
    if (next !== c) (out ??= [...constraints])[k] = next
  })
  return out ?? constraints
}

// c as saved: without inferred queries or an inferred target.
export function withoutInferred(c) {
  if (!c.queries?.some(q => q?.inferred) && !c.targetInferred) return c
  const out = { ...c, queries: (c.queries ?? []).map(q => (q?.inferred ? null : q)) }
  if (c.targetInferred) { out.targetObjectTypeId = null; delete out.targetInferred }
  return out
}

// The state with every external constraint's inferred queries filled in, for
// code that reads a model without the store (scripts, tests).
export function withInferredState(state) {
  const constraints = refreshInferredQueries(state)
  return constraints === state.constraints ? state : { ...state, constraints }
}
