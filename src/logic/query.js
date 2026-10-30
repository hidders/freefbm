// Join-path queries of external constraints, as formulas of the ORM2 logic.
//
// Each role sequence of an external constraint denotes a query: a formula
// whose free variables are the sequence positions (and, for uniqueness and
// frequency, the target object type). A query has the same form as a
// derivation rule (derivationRule.js), with its free variables declared:
//
//   { free: [{ id, typeId }],      one per sequence position, in order
//     target: { id, typeId } | null,
//     body: R }                     a rule tree over those variables
//
// The graphical query editor draws the conjunctive fragment of this
// language as a graph of atoms and links, stored on the query as
// { atoms, links }. When a query has a graph, the graph is what the user
// edits, and its formula is derived from it (graphToRule); serialize stores
// both, so a file always carries the formula.

import { mkVar, exists } from './formula.js'
import { ruleFormula } from './derivationRule.js'

const normalizeSeeded = (s) => (typeof s === 'number' ? { roleIndex: s, seqPosition: 0 } : s)

// The graph of a sequence that has no stored query: roles of one fact type,
// or a single subtype edge. Mirrors the store's automatic query generation.
export function implicitGraph(seq) {
  if (seq.length === 1 && seq[0].kind === 'subtype') {
    return { atoms: [{ id: 's', kind: 'subtype', originalId: seq[0].subtypeId, isSeeded: true }], links: [] }
  }
  const roles = seq.filter(m => m.kind === 'role' && !m.factId?.includes('_il_'))
  if (roles.length === 0 || roles.length !== seq.length) return null
  if (new Set(roles.map(m => m.factId)).size !== 1) return null
  return {
    atoms: [{ id: 'f', kind: 'fact', originalId: roles[0].factId,
      seededRoles: roles.map((m, i) => ({ roleIndex: m.roleIndex, seqPosition: i })) }],
    links: [],
  }
}

export const hasGraph = (q) => !!(q && (q.atoms || q.copies))

// The rule form { free, target, body } of a query graph, or { error }.
//
// Every argument slot of every atom is a node; links and subtype edges merge
// nodes into classes, and each class becomes one variable. Classes holding a
// sequence position become the free variables q0, q1, …; the target object
// type becomes t; every other class is bound by ∃ at the top, in order of
// first use. Two positions in one class are equated (q1 = q0).
export function graphToRule(graph, seq, ctx) {
  const atoms = graph.atoms ?? graph.copies ?? []
  const links = graph.links ?? []

  const parent = new Map()
  const nodeType = new Map()
  const find = (n) => { while (parent.get(n) !== n) n = parent.get(n); return n }
  const addNode = (n, typeId) => { if (!parent.has(n)) { parent.set(n, n); nodeType.set(n, typeId) } }
  const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent.set(rb, ra) }
  const linkTarget = (atomId, roleIndex) =>
    links.find(l => l.atomId === atomId && l.roleIndex === roleIndex)?.variableId

  for (const a of atoms) if (a.kind === 'objectType') addNode(a.id, a.originalId)
  // A link to a fact atom of an objectified fact type stands for the instance
  // that nests the atom's fact, so that atom is a node of the nested type too.
  for (const a of atoms) {
    if (a.kind === 'fact' && ctx.factById.get(a.originalId)?.objectified && links.some(l => l.variableId === a.id))
      addNode(a.id, a.originalId)
  }

  const factParts = []    // { factId, nodes }
  const subtypeParts = [] // { subId, node }
  const outputs = []      // { seqPosition, node }
  for (const a of atoms) {
    if (a.kind === 'fact') {
      const fact = ctx.factById.get(a.originalId)
      if (!fact) return { error: 'its join path refers to a deleted fact type' }
      const nodes = fact.roles.map((r, ri) => {
        const linked = linkTarget(a.id, ri)
        if (linked && parent.has(linked)) return linked
        const n = `${a.id}#${ri}`
        addNode(n, r.objectTypeId)
        return n
      })
      if (parent.has(a.id)) {
        // The nesting instance d of the fact, through the implied links:
        // d involves A ∧ d involves B ∧ … (which entails the fact itself).
        const ils = fact.roles.map((_, ri) => ctx.linkById.get(`${fact.id}_il_${ri}`))
        if (ils.some(l => !l)) return { error: 'a role of its join path has no implied link yet' }
        ils.forEach((l, ri) => factParts.push({ factId: l.id, nodes: [a.id, nodes[ri]] }))
      } else {
        factParts.push({ factId: fact.id, nodes })
      }
      for (const s of (a.seededRoles ?? []).map(normalizeSeeded)) {
        if (s.seqPosition != null) outputs.push({ seqPosition: s.seqPosition, node: nodes[s.roleIndex] })
      }
    } else if (a.kind === 'subtype') {
      const st = ctx.subtypeById.get(a.originalId)
      if (!st) return { error: 'its join path refers to a deleted subtype' }
      const ends = [0, 1].map(ri => {
        const linked = linkTarget(a.id, ri)
        if (linked && parent.has(linked)) return linked
        const n = `${a.id}#${ri}`
        addNode(n, ri === 0 ? st.subId : st.superId)
        return n
      })
      union(ends[1], ends[0])
      subtypeParts.push({ subId: st.subId, node: ends[1] })
      if (a.isSeeded) {
        const pos = Math.max(0, (seq ?? []).findIndex(m => m.kind === 'subtype' && m.subtypeId === st.id))
        outputs.push({ seqPosition: pos, node: ends[1] })
      }
    }
  }
  outputs.sort((x, y) => x.seqPosition - y.seqPosition)
  const targetAtom = atoms.find(a => a.kind === 'objectType' && a.isOutput)
  const targetNode = targetAtom && !outputs.some(o => find(o.node) === find(targetAtom.id))
    ? targetAtom.id : null

  // The type of a class is the type of its most general node: the one that is
  // not the subtype end of any subtype atom in the class.
  const subEnds = new Set()
  for (const a of atoms) if (a.kind === 'subtype') {
    const linked = linkTarget(a.id, 0)
    subEnds.add(linked && parent.has(linked) ? linked : `${a.id}#0`)
  }
  const classType = (root) => {
    let fallback = null
    for (const n of parent.keys()) {
      if (find(n) !== root) continue
      fallback ??= nodeType.get(n)
      if (!subEnds.has(n)) return nodeType.get(n)
    }
    return fallback
  }

  const varOf = new Map()   // class root → variable id
  const free = []
  const equalities = []
  outputs.forEach((o, i) => {
    const id = `q${i}`
    free.push({ id, typeId: classType(find(o.node)) })
    const prev = varOf.get(find(o.node))
    if (prev) equalities.push({ t: 'cmp', op: '=', left: prev, right: id })
    else varOf.set(find(o.node), id)
  })
  const target = targetNode ? { id: 't', typeId: classType(find(targetNode)) } : null
  if (target) varOf.set(find(targetNode), target.id)
  const bound = []
  const v = (node) => {
    const root = find(node)
    if (!varOf.has(root)) {
      const id = `v${bound.length}`
      varOf.set(root, id)
      bound.push({ id, typeId: classType(root) })
    }
    return varOf.get(root)
  }
  const conjuncts = [
    ...factParts.map(p => ({ t: 'fact', factId: p.factId, args: p.nodes.map(v) })),
    ...subtypeParts.map(p => ({ t: 'type', typeId: p.subId, arg: v(p.node) })),
    ...equalities,
  ]
  let body = conjuncts.length === 1 ? conjuncts[0] : { t: 'and', args: conjuncts }
  for (const b of [...bound].reverse()) body = { t: 'exists', v: b, body }
  // The variable of each object type atom, for tools that work on the graph.
  const atomVars = new Map(atoms.filter(a => a.kind === 'objectType' && parent.has(a.id) && varOf.has(find(a.id)))
    .map(a => [a.id, varOf.get(find(a.id))]))
  return { free, target, body, atomVars }
}

// The rule form of the query of a sequence: from its graph, from its stored
// formula, or from the implicit graph when nothing is stored.
export function queryRule(query, seq, ctx) {
  if (query && !hasGraph(query) && query.body) return query
  const graph = hasGraph(query) ? query : implicitGraph(seq ?? [])
  if (!graph) return { error: 'its role sequence has no join path yet' }
  return graphToRule(graph, seq, ctx)
}

// The ids of the variables bound by quantifiers in a rule tree.
function quantifiedVars(n, out = []) {
  if (!n || typeof n !== 'object') return out
  if ((n.t === 'forall' || n.t === 'exists' || n.t === 'count') && n.v) out.push(n.v)
  if (n.t === 'agg') out.push(...(n.vars ?? []))
  for (const k of Object.keys(n)) {
    const c = n[k]
    if (Array.isArray(c)) c.forEach(x => quantifiedVars(x, out))
    else if (c && typeof c === 'object' && k !== 'v') quantifiedVars(c, out)
  }
  return out
}

// ∃x ∃y φ → ∃x,y φ, as one quantifier block.
function mergeExists(f) {
  if (f?.t !== 'exists') return f
  const vars = [...f.vars]
  let body = f.body
  while (body?.t === 'exists') { vars.push(...body.vars); body = body.body }
  return { t: 'exists', vars, body }
}

// The variables in order of first occurrence in a formula.
function firstUse(f, out = []) {
  if (!f || typeof f !== 'object') return out
  if (!f.t && 'typeId' in f) { if (!out.includes(f)) out.push(f); return out }   // a Var
  for (const k of Object.keys(f)) {
    const c = f[k]
    if (k === 'vars') continue
    if (Array.isArray(c)) c.forEach(x => firstUse(x, out))
    else if (c && typeof c === 'object') firstUse(c, out)
  }
  return out
}

// A compiled query: { arity, outTypes, targetType, build } where
// build({ outVars, targetVar }) gives the query's formula for those free
// variables, with fresh bound variables on every call. A position (or the
// target) without a variable is bound by ∃. Or { error }.
export function compileQuery(query, seq, ctx, typing = { sorts: new Map(), params: new Map() }) {
  const rule = queryRule(query, seq, ctx)
  if (rule.error) return rule
  const { free, target, body } = rule
  const build = ({ outVars = [], targetVar = null } = {}) => {
    const vars = new Map()
    const missing = []
    free.forEach((f, i) => {
      if (outVars[i]) vars.set(f.id, outVars[i])
      else { const x = mkVar(f.typeId); vars.set(f.id, x); missing.push(x) }
    })
    if (target) {
      if (targetVar) vars.set(target.id, targetVar)
      else { const x = mkVar(target.typeId); vars.set(target.id, x); missing.push(x) }
    }
    for (const q of quantifiedVars(body)) vars.set(q.id, mkVar(q.typeId))
    const f = mergeExists(ruleFormula(body, vars, ctx, typing))
    if (!missing.length) return f
    // Unbound positions join the outer ∃, in order of first use.
    const merged = mergeExists(exists(missing, f))
    const order = firstUse(merged.body)
    merged.vars.sort((a, b) => order.indexOf(a) - order.indexOf(b))
    return merged
  }
  return {
    arity: free.length,
    outTypes: free.map(f => f.typeId),
    targetType: target?.typeId ?? null,
    build,
  }
}

// The constraint with the rule form stored beside each query graph, as
// serialize writes it. A graph that can't be read keeps no rule form.
export function withRuleForms(c, ctx) {
  if (!c.queries?.some(hasGraph)) return c
  return {
    ...c,
    queries: c.queries.map((q, i) => {
      if (!hasGraph(q)) return q
      const { free, target, body, error } = graphToRule(q, c.sequences?.[i] ?? [], ctx)
      const { free: _f, target: _t, body: _b, ...graph } = q
      return error ? graph : { ...graph, free, target, body }
    }),
  }
}
