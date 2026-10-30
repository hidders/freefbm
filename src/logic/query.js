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
// both, so a file always carries the formula. A query edited as a formula
// (in the rule editor) is stored as { free, target, body } only; when it lies
// in the graphical fragment, ruleToGraph draws it and the graphical editor
// can take it over.

import { mkVar, exists } from './formula.js'
import { ruleFormula, checkFormula, formulaVariables, upgradeRule, atomFact } from './derivationRule.js'

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
// A query stored as a formula only, as the rule editor saves it.
export const isFormulaQuery = (q) => !!(q && !hasGraph(q) && q.body)

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
      const fact = atomFact(ctx, a.originalId)
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

const checked = new WeakMap()   // ctx → query → its rule form, or { error }

// The rule form of the query of a sequence: from its graph, from its stored
// formula, or from the implicit graph when nothing is stored. A stored
// formula that checkQuery rejects gives { error }.
export function queryRule(query, seq, ctx) {
  if (isFormulaQuery(query)) {
    let byQuery = checked.get(ctx)
    if (!byQuery) checked.set(ctx, byQuery = new WeakMap())
    if (!byQuery.has(query)) {
      const bad = checkQuery(query, seq ?? [], ctx.schema, ctx).find(i => i.severity === 'error')
      byQuery.set(query, bad ? { error: 'its query formula is not valid' } : { ...query, body: upgradeRule(query.body) })
    }
    return byQuery.get(query)
  }
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
export function compileQuery(query, seq, ctx) {
  const rule = queryRule(query, seq, ctx)
  if (rule.error) return rule
  const { free, target, body } = rule
  const typing = queryTyping(rule, ctx)
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

// ── Formula queries ──────────────────────────────────────────────────────────

// The free variables of a query in rule form, for the checks and the editor:
// the positions, then the target.
export const queryRoots = (rule) =>
  [...rule.free, ...(rule.target ? [rule.target] : [])].map(f => ({ id: f.id, typeIds: [f.typeId] }))

// The sorts of the data terms of a query (see checkFormula), for ruleFormula
// and the population evaluator. Keyed by the nodes of upgradeRule(rule.body).
const typings = new WeakMap()
export function queryTyping(rule, ctx) {
  const body = upgradeRule(rule.body)
  if (typings.has(body)) return typings.get(body)
  const typing = { sorts: new Map(), params: new Map() }
  if (JSON.stringify(body ?? null).match(/"(vcmp|dpred)"/))
    checkFormula(body, queryRoots(rule), { nameOf: new Map() }, ctx.schema, ctx, typing)
  typings.set(body, typing)
  return typing
}

// The positive conjunctive core of a formula: the atoms reached from the top
// through ∃ and ∧ only, with their paths. `rest` lists the parts that are not
// such atoms (or ⊤ or an object equality) and so lie outside the graphical
// fragment.
export function conjunctiveCore(body, path = []) {
  const atoms = [], rest = [], bound = []
  const walk = (n, p) => {
    switch (n?.t) {
      case 'exists': bound.push(n.v); walk(n.body, [...p, 'body']); return
      case 'and': n.args.forEach((a, i) => walk(a, [...p, 'args', i])); return
      case 'true': return
      case 'fact': case 'type': atoms.push({ node: n, path: p }); return
      case 'cmp': if (n.op === '=') { atoms.push({ node: n, path: p }); return } break
    }
    rest.push({ node: n, path: p })
  }
  walk(body, path)
  return { atoms, rest, bound }
}

// Classes of variables that the core's object equalities (x = y) make equal:
// variable id → representative id.
function equalityClasses(core) {
  const parent = new Map()
  const find = (x) => { while (parent.has(x) && parent.get(x) !== x) x = parent.get(x); return x }
  for (const { node: n } of core.atoms) {
    if (n.t !== 'cmp' || n.left == null || n.right == null) continue
    const a = find(n.left), b = find(n.right)
    if (a !== b) parent.set(b, a)
  }
  return find
}

// The core atom that anchors position i of a sequence: a fact atom of the
// member's fact type with the position's variable (or one equal to it) at the
// member's role, or for a subtype member a type atom of its subtype. Or null.
function anchorOf(core, find, member, varId, ctx) {
  const cls = find(varId)
  if (member.kind === 'subtype') {
    const st = ctx.subtypeById.get(member.subtypeId)
    return core.atoms.find(({ node: n }) => n.t === 'type' && n.typeId === st?.subId && n.arg != null && find(n.arg) === cls) ?? null
  }
  // A role of a nested fact type is also played through its implied link
  // (D involves A), with the player second.
  const link = `${member.factId}_il_${member.roleIndex}`
  return core.atoms.find(({ node: n }) => n.t === 'fact' && n.factId === member.factId
    && n.args?.[member.roleIndex] != null && find(n.args[member.roleIndex]) === cls)
    ?? core.atoms.find(({ node: n }) => n.t === 'fact' && n.factId === link && n.args?.[1] != null && find(n.args[1]) === cls)
    ?? null
}

const memberLabel = (m, ctx) => {
  if (m.kind === 'subtype') {
    const st = ctx.subtypeById.get(m.subtypeId)
    return st ? `the subtype ${ctx.typeName(st.subId)} of ${ctx.typeName(st.superId)}` : 'a deleted subtype'
  }
  const f = atomFact(ctx, m.factId)
  return f ? `role ${m.roleIndex + 1} of ${f.readingParts?.length ? `“${readingOf(f, ctx)}”` : 'its fact type'}` : 'a deleted role'
}
const readingOf = (f, ctx) => {
  const parts = f.readingParts ?? []
  return f.roles.map((r, i) => `${parts[i] ?? ''} ${ctx.typeName(r.objectTypeId)}`).join(' ').concat(` ${parts[f.roles.length] ?? ''}`)
    .replace(/\s+/g, ' ').trim()
}

// Issues with a query in rule form for sequence seq, as checkRule gives them
// for derivation rules: [{ path, severity, message }]. Besides the typing
// checks, every position must be anchored: the formula must say, positively
// and through ∃ and ∧ only, that the position's variable plays the role of
// its sequence member; and the target, if any, must occur in it.
export function checkQuery(rule, seq, state, ctx, typing = { sorts: new Map(), params: new Map() }) {
  const body = upgradeRule(rule.body)
  if (!body) return [{ path: [], severity: 'error', message: 'There is no query formula yet' }]
  const roots = queryRoots(rule)
  const { nameOf } = formulaVariables(body, roots, ctx)
  const { issues, used } = checkFormula(body, roots, { nameOf }, state, ctx, typing)
  if (rule.free.length !== seq.length)
    issues.push({ path: [], severity: 'error',
      message: `The query has ${rule.free.length} position${rule.free.length === 1 ? '' : 's'} but its role sequence has ${seq.length}` })
  const core = conjunctiveCore(body)
  const find = equalityClasses(core)
  rule.free.forEach((f, i) => {
    if (!seq[i] || anchorOf(core, find, seq[i], f.id, ctx)) return
    issues.push({ path: [], severity: 'error',
      message: `${nameOf.get(f.id) ?? f.id} (position ${i + 1}) must play ${memberLabel(seq[i], ctx)}, in an atom that is not under ¬, ∨, →, ↔, ∀ or a counting quantifier` })
  })
  if (rule.target && !used.has(rule.target.id))
    issues.push({ path: [], severity: 'error',
      message: `The formula does not mention the target ${nameOf.get(rule.target.id) ?? ctx.typeName(rule.target.typeId)}` })
  return issues
}

// Why a query in rule form can't be drawn and edited as a graph, or null
// when it can.
export function whyNotGraphical(rule, seq, ctx) {
  const g = ruleToGraph(rule, seq, ctx)
  return g.error ?? null
}

const OUTSIDE = {
  not: 'a negation (¬)', or: 'a disjunction (∨)', implies: 'an implication (→)', iff: 'an equivalence (↔)',
  forall: 'a universal quantifier (∀)', count: 'a counting quantifier', cmp: 'an inequality (≠)',
  vcmp: 'a value comparison', dpred: 'a data predicate', hole: 'a part that is not filled in',
}

// The graph of a query in rule form, for the graphical editor and for
// drawing a query on the canvas: { atoms, links } or { error }. A query can be
// drawn when its formula is ∃ and ∧ over fact atoms, type atoms of a direct
// subtype and object equalities, with every position anchored. With lenient,
// the parts outside that fragment are left out (and partial is set), so the
// rest can still be shown.
//
// Atom ids follow the formula (the k-th atom, the class of a variable), so a
// layout stored per atom id stays put while the formula is unchanged.
export function ruleToGraph(rule, seq, ctx, { lenient = false } = {}) {
  const body = upgradeRule(rule.body)
  const core = conjunctiveCore(body)
  if (core.rest.length && !lenient) {
    const t = core.rest[0].node?.t
    return { error: `it uses ${OUTSIDE[t] ?? 'a part'} that the diagram can't show` }
  }
  const find = equalityClasses(core)
  const typeOf = new Map([...rule.free, ...(rule.target ? [rule.target] : []), ...core.bound].map(v => [v.id, v.typeId]))

  // Where each variable class is used: fact and subtype slots.
  const uses = new Map()
  const use = (varId) => { const c = find(varId); uses.set(c, (uses.get(c) ?? 0) + 1); return c }
  const parts = []
  for (const [k, { node: n }] of core.atoms.entries()) {
    if (n.t === 'fact') {
      const f = atomFact(ctx, n.factId)
      if (!f || n.args.some(a => a == null)) { if (lenient) continue; return { error: 'it has an atom that is not complete' } }
      parts.push({ k, kind: 'fact', node: n, classes: n.args.map(use) })
    } else if (n.t === 'type') {
      if (n.arg == null) { if (lenient) continue; return { error: 'it has an atom that is not complete' } }
      const argType = typeOf.get(n.arg)
      const st = (ctx.schema.subtypes ?? []).find(s => s.subId === n.typeId && s.superId === argType)
        ?? (ctx.schema.subtypes ?? []).find(s => s.subId === n.typeId)
      if (!st) { if (lenient) continue; return { error: `${ctx.typeName(n.typeId)} is not a subtype, so the diagram can't show its type atom` } }
      parts.push({ k, kind: 'subtype', node: n, st, classes: [use(n.arg)] })
    }
  }

  const targetClass = rule.target ? find(rule.target.id) : null

  // Implied links of one object d of a nested fact type F (d involves A,
  // d involves B, …) are drawn as one atom of F that d's other uses link to,
  // as the editor draws them. A link that d has twice stays on its own.
  const nests = new Map()   // class of d → { factId, part }
  const merged = new Map()  // core atom index of a merged link → { part, roleIndex }
  for (const p of parts) {
    if (p.kind !== 'fact' || !ctx.linkById?.has(p.node.factId)) continue
    const [factId, ri] = p.node.factId.split('_il_')
    const d = p.classes[0]
    if (d === targetClass) continue
    let nest = nests.get(d)
    if (!nest) {
      const f = ctx.factById.get(factId)
      nest = { factId, part: { k: p.k, kind: 'nest', factId, classes: f.roles.map(() => null), d } }
      nests.set(d, nest)
    }
    if (nest.factId !== factId || nest.part.classes[+ri] !== null) continue
    nest.part.classes[+ri] = p.classes[1]
    merged.set(p.k, { part: nest.part, roleIndex: +ri })
    p.merged = true
  }
  const drawn = [...parts.filter(p => !p.merged), ...[...nests.values()].map(n => n.part)].sort((a, b) => a.k - b.k)

  // The anchoring atom of each position.
  const seeds = new Map() // core atom index → [{ roleIndex, seqPosition }] | true
  for (const [i, f] of rule.free.entries()) {
    const a = seq[i] && anchorOf(core, find, seq[i], f.id, ctx)
    if (!a) { if (lenient) continue; return { error: `position ${i + 1} is not anchored in an atom of its role` } }
    let k = core.atoms.findIndex(x => x.node === a.node)
    let roleIndex = a.node.factId === seq[i].factId ? seq[i].roleIndex : 1
    if (merged.has(k)) ({ part: { k }, roleIndex } = merged.get(k))
    if (a.node.t === 'type') seeds.set(k, true)
    else seeds.set(k, [...(seeds.get(k) ?? []), { roleIndex, seqPosition: i }])
  }
  if (rule.target && !uses.has(targetClass) && !lenient) return { error: 'the target does not occur in it' }

  // A class used more than once, or holding the target, gets an object type
  // atom; a class used once stays implicit in its slot.
  const atoms = [], links = []
  // The object of a nested fact type is its atom.
  const otAtom = new Map([...nests].map(([d, n]) => [d, `a${n.part.k}`]))
  const otAtomOf = (cls) => {
    if (!otAtom.has(cls)) {
      const id = `x_${cls}`
      otAtom.set(cls, id)
      atoms.push({ id, kind: 'objectType', originalId: typeOf.get(cls) ?? null, isOutput: cls === targetClass })
    }
    return otAtom.get(cls)
  }
  if (targetClass && uses.has(targetClass)) otAtomOf(targetClass)
  for (const p of drawn) {
    const id = `a${p.k}`
    if (p.kind === 'fact' || p.kind === 'nest') {
      const seeded = seeds.get(p.k)
      atoms.push({ id, kind: 'fact', originalId: p.kind === 'nest' ? p.factId : p.node.factId, isOutput: false,
        ...(seeded ? { seededRoles: seeded } : {}) })
      p.classes.forEach((cls, ri) => {
        if (cls !== null && (uses.get(cls) > 1 || cls === targetClass)) links.push({ atomId: id, roleIndex: ri, variableId: otAtomOf(cls) })
      })
    } else {
      atoms.push({ id, kind: 'subtype', originalId: p.st.id, isOutput: !rule.target && seeds.has(p.k), isSeeded: seeds.has(p.k) })
      const sub = `${id}_sub`
      atoms.push({ id: sub, kind: 'objectType', originalId: p.st.subId, isOutput: false })
      links.push({ atomId: id, roleIndex: 0, variableId: sub })
      links.push({ atomId: id, roleIndex: 1, variableId: otAtomOf(p.classes[0]) })
    }
  }
  // Object type atoms need a type; a class of variables whose type is an
  // objectified fact type is shown as that fact type's object.
  for (const a of atoms) if (a.kind === 'objectType' && !a.originalId) return { error: 'a variable has no type' }
  return { atoms, links, ...(core.rest.length ? { partial: true } : {}) }
}

// The schema elements a query refers to, as graph atoms ({ kind, originalId }):
// its graph's atoms, or for a formula query its fact atoms, the subtypes of its
// type atoms and the types of its variables.
export function queryElements(q, subtypes = []) {
  if (!q) return []
  if (hasGraph(q)) return q.atoms ?? q.copies ?? []
  if (!q.body) return []
  const out = []
  const add = (kind, originalId) => { if (originalId && !out.some(a => a.kind === kind && a.originalId === originalId)) out.push({ kind, originalId }) }
  for (const v of [...(q.free ?? []), ...(q.target ? [q.target] : [])]) add('objectType', v.typeId)
  const walk = (n) => {
    if (!n || typeof n !== 'object') return
    if (Array.isArray(n)) { n.forEach(walk); return }
    if (n.t === 'fact') add('fact', n.factId)
    if (n.t === 'type') {
      const st = subtypes.find(s => s.subId === n.typeId)
      if (st) add('subtype', st.id)
      else add('objectType', n.typeId)
    }
    if (n.v?.typeId) add('objectType', n.v.typeId)
    for (const w of (n.t === 'agg' ? n.vars ?? [] : [])) add('objectType', w.typeId)
    Object.values(n).forEach(walk)
  }
  walk(q.body)
  return out
}

// Constraint types whose queries have a target object type.
export const TARGET_TYPES = new Set(['uniqueness', 'frequency', 'inclusiveOr', 'exclusiveOr'])

// The query of sequence i of constraint c in rule form, for the rule editor:
// the stored formula, the formula of its graph, or, when there is neither, a
// start that anchors every position in an atom of its role.
export function editableQuery(c, i, ctx) {
  const seq = c.sequences?.[i] ?? []
  const q = c.queries?.[i]
  if (isFormulaQuery(q)) return { free: q.free, target: q.target ?? null, body: upgradeRule(q.body) }
  const r = queryRule(q, seq, ctx)
  if (!r.error) return { free: r.free, target: r.target, body: r.body }
  const target = TARGET_TYPES.has(c.constraintType) && c.targetObjectTypeId ? { id: 't', typeId: c.targetObjectTypeId } : null
  const free = [], bound = [], conjuncts = []
  const atomOf = new Map()
  seq.forEach((m, k) => {
    const id = `q${k}`
    if (m.kind === 'subtype') {
      const st = ctx.subtypeById.get(m.subtypeId)
      free.push({ id, typeId: st?.superId ?? null })
      conjuncts.push({ t: 'type', typeId: st?.subId ?? null, arg: id })
      return
    }
    const f = atomFact(ctx, m.factId)
    free.push({ id, typeId: f?.roles[m.roleIndex]?.objectTypeId ?? null })
    if (!f) return
    let atom = atomOf.get(m.factId)
    if (!atom || atom.args[m.roleIndex] !== null) {
      atom = { t: 'fact', factId: m.factId, args: f.roles.map(() => null) }
      atomOf.set(m.factId, atom)
      conjuncts.push(atom)
    }
    atom.args[m.roleIndex] = id
  })
  // The other roles of the atoms get variables of their own.
  for (const atom of conjuncts) {
    if (atom.t !== 'fact') continue
    const f = atomFact(ctx, atom.factId)
    atom.args = atom.args.map((a, ri) => {
      if (a) return a
      const v = { id: `v${bound.length}`, typeId: f.roles[ri].objectTypeId }
      bound.push(v)
      return v.id
    })
  }
  let body = conjuncts.length === 0 ? { t: 'hole' } : conjuncts.length === 1 ? conjuncts[0] : { t: 'and', args: conjuncts }
  for (const b of [...bound].reverse()) body = { t: 'exists', v: b, body }
  return { free, target, body }
}
