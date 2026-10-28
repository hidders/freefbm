// Derivation rules of derived and semi-derived subtypes.
//
// A rule is a formula of the ORM2 logic with exactly one free variable, the
// subject, which ranges over the intersection of the subtype's direct
// supertypes (in subtype-link order) and is named after them: Student&Employee.
// For subtype S with rule φ:
//   derived       ∀x (S(x) ↔ φ(x))
//   semi-derived  ∀x (φ(x) → S(x))
//
// Rules are stored on the object type (derivationRule) as JSON trees that the
// rule editor builds. Variables have ids, and their display names are made at
// render time, as in the Formalisation panel:
//
//   { t: 'hole' }                                   a part not filled in yet
//   { t: 'true' }
//   { t: 'not', arg }
//   { t: 'and' | 'or', args: [R, R, …] }
//   { t: 'implies' | 'iff', left, right }
//   { t: 'forall' | 'exists', v: { id, typeId }, body }
//   { t: 'count', op: '≤' | '≥' | '=', n, v: { id, typeId }, body }
//   { t: 'count', op: '..', n, m, v: { id, typeId }, body }   ∃^{n..m}
//   { t: 'fact', factId, args: [varId | null] }     args in roles[] order; factId
//                                                   can also be an implied link of a
//                                                   nested fact type, '<factId>_il_<i>'
//                                                   (roles: nested type, player)
//   { t: 'type', typeId, arg: varId | null }
//   { t: 'cmp', op: '=' | '≠', left: varId | null, right: varId | null }
//   { t: 'vcmp', op: '≈' | '≉' | '<' | '≤' | '>' | '≥', left: T, right: T }
//   { t: 'dpred', op, args: [T, …] }                data predicate
// where T is a data term (see src/logic/dataOperators.js): a hole, a
// variable's data value { t: 'var', id }, a constant { t: 'const', text }, an
// operator { t: 'op', op, args }, { t: 'if', cond: R, then: T, else: T }, or
// an aggregate { t: 'agg', fn, distinct, vars: [{ id, typeId }], cond: R, term: T }
// whose variables are in scope in cond and term.
// Older rules stored vcmp as left: varId, right: { var } | { const };
// upgradeRule turns them into terms.
//
// The subject's variable id is SUBJECT.

import {
  mkVar, mkMeetVar, forall, exists, count, countRange, not, truth, implies, iff, and, or,
  factAtom, typeAtom, cmp, vcmp, dpred, fn, ite, agg,
} from './formula.js'
import { renderFormula } from './renderFormula.js'
import { valueAccess, withValues, valueConstant } from './values.js'
import { sortOf, typeComparison, typePredicate, termVarIds, FAIL } from './dataOperators.js'

export const SUBJECT = 'subject'

export const DERIVATION_MODES = [
  { id: 'none',        label: 'Not derived' },
  { id: 'derived',     label: 'Derived' },
  { id: 'semiDerived', label: 'Semi-derived' },
]

export const hole = () => ({ t: 'hole' })

// The fact type a fact atom uses: a fact type of the schema, or an implied
// link of a nested fact type (ctx.linkById, from makeContext).
export const atomFact = (ctx, factId) => ctx.factById.get(factId) ?? ctx.linkById?.get(factId)

// The direct supertypes of a type, in subtype-link order.
export function directSupertypes(typeId, subtypes) {
  const out = []
  for (const st of (subtypes ?? [])) if (st.subId === typeId && !out.includes(st.superId)) out.push(st.superId)
  return out
}

export function isDerived(ot) {
  return ot?.derivation === 'derived' || ot?.derivation === 'semiDerived'
}

// The ORM2 mark after the name of a derived (*) or semi-derived (+) type.
export const derivationMark = (ot) => (ot?.derivation === 'derived' ? '*' : ot?.derivation === 'semiDerived' ? '+' : '')

// ── Upgrading older rules ────────────────────────────────────────────────────

const upgraded = new WeakMap()

// The rule with value comparisons in the older form (variable ids and
// { var } / { const } sides) turned into terms. The same rule object always
// gives the same result, so typing information keyed by its nodes stays valid.
export function upgradeRule(rule) {
  if (!rule || typeof rule !== 'object') return rule
  if (upgraded.has(rule)) return upgraded.get(rule)
  const side = (x) => (x && typeof x === 'object' && 't' in x ? x
    : x && typeof x === 'object' && 'const' in x ? { t: 'const', text: String(x.const ?? '') }
    : x && typeof x === 'object' ? (x.var != null ? { t: 'var', id: x.var } : hole())
    : x != null ? { t: 'var', id: x } : hole())
  const up = (n) => {
    switch (n?.t) {
      case 'not': return { ...n, arg: up(n.arg) }
      case 'and': case 'or': return { ...n, args: n.args.map(up) }
      case 'implies': case 'iff': return { ...n, left: up(n.left), right: up(n.right) }
      case 'forall': case 'exists': case 'count': return { ...n, body: up(n.body) }
      case 'vcmp': {
        if (n.left && typeof n.left === 'object' && 't' in n.left && n.right && 't' in n.right) return n
        return { t: 'vcmp', op: n.op, left: side(n.left), right: side(n.right) }
      }
      default: return n
    }
  }
  const out = JSON.stringify(rule).includes('"vcmp"') ? up(rule) : rule
  upgraded.set(rule, out)
  return out
}

// ── Tree access ──────────────────────────────────────────────────────────────
//
// A path is a list of keys from the root, e.g. ['body', 'args', 1].

export function getAt(node, path) {
  return path.reduce((n, k) => n?.[k], node)
}

export function setAt(node, path, value) {
  if (path.length === 0) return value
  const [k, ...rest] = path
  const copy = Array.isArray(node) ? [...node] : { ...node }
  copy[k] = setAt(node[k], rest, value)
  return copy
}

// The child slots of a node, as [key, …] paths relative to the node.
export function childPaths(n) {
  switch (n?.t) {
    case 'not': return [['arg']]
    case 'and': case 'or': return n.args.map((_, i) => ['args', i])
    case 'implies': case 'iff': return [['left'], ['right']]
    case 'forall': case 'exists': case 'count': return [['body']]
    case 'vcmp': return [['left'], ['right']]
    case 'dpred': case 'op': return n.args.map((_, i) => ['args', i])
    case 'if': return [['cond'], ['then'], ['else']]
    case 'agg': return n.fn === 'count' ? [['cond']] : [['cond'], ['term']]
    default: return []
  }
}

// Whether the slot at a path holds a data term (rather than a formula).
export function isTermSlot(rule, path) {
  if (!path.length) return false
  const last = path[path.length - 1]
  const parentPath = path.slice(0, typeof last === 'number' ? -2 : -1)
  const parent = getAt(rule, parentPath)
  switch (parent?.t) {
    case 'vcmp': case 'op': case 'dpred': return true
    case 'if': case 'agg': return last !== 'cond'
    default: return false
  }
}

const QUANT = new Set(['forall', 'exists', 'count'])

// The variables in scope at a path, outermost first: the subject, then the
// variable of every quantifier and aggregate above the path.
export function varsInScope(rule, path, subjectTypeIds) {
  const out = [{ id: SUBJECT, typeIds: subjectTypeIds }]
  let n = rule
  for (let i = 0; i < path.length; i++) {
    if (QUANT.has(n?.t) && path[i] === 'body') out.push({ id: n.v.id, typeIds: [n.v.typeId] })
    if (n?.t === 'agg' && (path[i] === 'cond' || path[i] === 'term'))
      for (const v of (n.vars ?? [])) out.push({ id: v.id, typeIds: [v.typeId] })
    n = n?.[path[i]]
  }
  return out
}

// ── Types ────────────────────────────────────────────────────────────────────

// Subtype structure of the schema, for the typing checks.
export function typeGraph(state) {
  const subtypes = state.subtypes ?? []
  const memo = new Map()
  // The type and all its (transitive) supertypes.
  const up = (id) => {
    if (memo.has(id)) return memo.get(id)
    const seen = new Set([id]), todo = [id]
    while (todo.length) {
      const t = todo.pop()
      for (const st of subtypes) if (st.subId === t && !seen.has(st.superId)) { seen.add(st.superId); todo.push(st.superId) }
    }
    memo.set(id, seen)
    return seen
  }
  // How well a variable of types typeIds (an intersection) fits a place for
  // instances of placeId: 'ok' when it is the place's type or a subtype of it,
  // 'overlap' when the two share a supertype (only some instances fit), and
  // 'none' when they lie in different hierarchies.
  const fit = (typeIds, placeId) => {
    if (!placeId) return 'ok'
    if (typeIds.some(t => up(t).has(placeId))) return 'ok'
    const placeUp = up(placeId)
    if (typeIds.some(t => [...up(t)].some(a => placeUp.has(a)))) return 'overlap'
    return 'none'
  }
  return { up, fit }
}

// Every type a variable can range over: object types and objectified fact types.
export function allTypeOptions(state) {
  return [
    ...(state.objectTypes ?? []).map(o => ({ id: o.id, name: o.name || 'Unnamed', kind: o.kind })),
    ...(state.facts ?? []).filter(f => f.objectified)
      .map(f => ({ id: f.id, name: f.objectifiedName || 'Unnamed', kind: 'nested' })),
  ].sort((a, b) => a.name.localeCompare(b.name))
}

// ── Display names ────────────────────────────────────────────────────────────

// Builds formula variables for the subject and every quantifier, and their
// display names, by rendering just the binding structure of the rule.
export function ruleVariables(rule, subjectTypeIds, ctx) {
  return formulaVariables(rule, [{ id: SUBJECT, typeIds: subjectTypeIds }], ctx)
}

// The same for a formula with free variables roots ([{ id, typeIds }]).
export function formulaVariables(rule, roots, ctx) {
  const vars = new Map(roots.map(r => [r.id, mkMeetVar(r.typeIds)]))
  const skeleton = (n) => {
    switch (n?.t) {
      case 'not': return not(skeleton(n.arg))
      case 'and': case 'or': return { t: n.t, args: n.args.map(skeleton) }
      case 'implies': case 'iff': return { t: n.t, left: skeleton(n.left), right: skeleton(n.right) }
      case 'forall': case 'exists': case 'count': {
        const v = mkVar(n.v.typeId)
        vars.set(n.v.id, v)
        return { t: n.t === 'count' ? 'exists' : n.t, vars: [v], body: skeleton(n.body) }
      }
      case 'vcmp': case 'dpred': {
        const parts = childPaths(n).flatMap(p => termSkeleton(getAt(n, p)))
        return parts.length ? { t: 'and', args: [truth(), ...parts] } : truth()
      }
      default: return truth()
    }
  }
  // The binding structure inside a term: if-conditions and aggregates.
  const termSkeleton = (x) => {
    switch (x?.t) {
      case 'if': return [skeleton(x.cond), ...termSkeleton(x.then), ...termSkeleton(x.else)]
      case 'op': return (x.args ?? []).flatMap(termSkeleton)
      case 'agg': {
        const vs = (x.vars ?? []).map(w => { const fv = mkVar(w.typeId); vars.set(w.id, fv); return fv })
        return [{ t: 'exists', vars: vs, body: { t: 'and', args: [skeleton(x.cond), ...termSkeleton(x.term)] } }]
      }
      default: return []
    }
  }
  const names = new Map()
  renderFormula(forall(roots.map(r => vars.get(r.id)), skeleton(rule)), ctx, names)
  const nameOf = new Map([...vars].map(([id, v]) => [id, names.get(v) ?? '?']))
  return { vars, nameOf }
}

// ── Checking ─────────────────────────────────────────────────────────────────

// Checks a formula whose free variables are `roots` ([{ id, typeIds }]), the
// part shared by the rules of derived subtypes and derived fact types.
// opts: nameOf (display names of the variables), selfAndBelow (types whose use
// makes the rule circular, with selfName), selfFactId (the fact type a rule
// derives), unavailable (Map varId → message for variables that may not be
// used here), and extra ([{ node, path, scope }]: atoms checked on their own,
// with their own scope). Returns { issues, used }, used = the ids of the
// variables the formula and the extra atoms use.
export function checkFormula(rule, roots, opts, state, ctx, typing = { sorts: new Map(), params: new Map() }) {
  const issues = []
  const nameOf = opts.nameOf
  const graph = typeGraph(state)
  const name = (id) => nameOf.get(id) ?? '?'
  const typeLabel = (typeIds) => typeIds.map(ctx.typeName).join('&')
  const err = (path, message) => issues.push({ path, severity: 'error', message })
  const warn = (path, message) => issues.push({ path, severity: 'warning', message })
  const used = new Set()
  const selfAndBelow = opts.selfAndBelow ?? new Set()
  const selfName = opts.selfName ?? ''

  // The variable a reference names, or null with an error when it is missing
  // or no longer in scope.
  const use = (path, id, scope, what) => {
    if (id == null) { err(path, `${what} is not chosen yet`); return null }
    const v = scope.find(s => s.id === id)
    if (!v) {
      err(path, opts.unavailable?.get(id) ?? `${what} refers to a variable that is no longer in scope`)
      return null
    }
    used.add(id)
    return v
  }
  const place = (path, v, placeId, where) => {
    const f = graph.fit(v.typeIds, placeId)
    if (f === 'none')
      err(path, `${name(v.id)} cannot be ${where}: ${typeLabel(v.typeIds)} and ${ctx.typeName(placeId)} are in different type hierarchies`)
    else if (f === 'overlap')
      warn(path, `${name(v.id)} is ${where}, which only holds for those that are a ${ctx.typeName(placeId)}`)
  }
  const valueOf = (path, v) => {
    const t = v.typeIds.find(id => valueAccess(id, ctx))
    if (!t) { err(path, `${name(v.id)} has no data value: ${typeLabel(v.typeIds)} is not a value type and has no reference mode`); return null }
    return valueAccess(t, ctx)
  }

  // The typing context of the data terms of an atom (dataOperators.js).
  const termTyping = (scope) => ({
    sorts: typing.sorts, params: typing.params, err,
    varSort(id, p) {
      const v = use(p, id, scope, 'The variable')
      const a = v && valueOf(p, v)
      return a ? sortOf(a.kindName) : FAIL
    },
    formula: (cond, p) => walk(cond, p, scope),
    bind(vars, p) {
      vars.forEach((w, i) => {
        if (!w?.typeId || !(ctx.otById.has(w.typeId) || ctx.factById.get(w.typeId)?.objectified))
          err([...p, 'vars', i], 'The variable has no type')
      })
      return termTyping([...scope, ...vars.map(w => ({ id: w.id, typeIds: [w.typeId] }))])
    },
  })

  const walk = (n, path, scope) => {
    switch (n?.t) {
      case undefined: case 'hole':
        err(path, 'This part of the formula is not filled in yet')
        return
      case 'true': return
      case 'not': walk(n.arg, [...path, 'arg'], scope); return
      case 'and': case 'or':
        n.args.forEach((a, i) => walk(a, [...path, 'args', i], scope))
        return
      case 'implies': case 'iff':
        walk(n.left, [...path, 'left'], scope)
        walk(n.right, [...path, 'right'], scope)
        return
      case 'forall': case 'exists': case 'count':
        if (!n.v?.typeId || !(ctx.otById.has(n.v.typeId) || ctx.factById.get(n.v.typeId)?.objectified))
          err(path, 'The quantified variable has no type')
        if (n.t === 'count' && !(Number.isInteger(n.n) && n.n >= 0))
          err(path, 'The bound of a counting quantifier must be a whole number of 0 or more')
        if (n.t === 'count' && n.op === '..' && Number.isInteger(n.n)) {
          if (!(Number.isInteger(n.m) && n.m >= 0))
            err(path, 'The upper bound of a counting quantifier must be a whole number of 0 or more')
          else if (n.m < n.n)
            err(path, 'The upper bound of a counting quantifier is below its lower bound')
        }
        walk(n.body, [...path, 'body'], [...scope, { id: n.v.id, typeIds: [n.v.typeId] }])
        return
      case 'fact': {
        const fact = atomFact(ctx, n.factId)
        if (!fact) { err(path, 'The fact type no longer exists'); return }
        if (fact.id === opts.selfFactId) err(path, 'The rule uses the fact type it derives, so it defines it in terms of itself')
        fact.roles.forEach((r, i) => {
          const v = use(path, n.args?.[i], scope, `Argument ${i + 1}`)
          if (selfAndBelow.has(r.objectTypeId))
            warn(path, `The rule uses a role of ${ctx.typeName(r.objectTypeId)}, so it defines ${selfName} in terms of itself`)
          else if (v) place(path, v, r.objectTypeId, `in a ${ctx.typeName(r.objectTypeId)} role`)
        })
        return
      }
      case 'type': {
        if (!ctx.otById.has(n.typeId) && !ctx.factById.get(n.typeId)?.objectified) { err(path, 'The type no longer exists'); return }
        const v = use(path, n.arg, scope, 'The argument')
        if (!v) return
        if (graph.fit(v.typeIds, n.typeId) === 'none')
          err(path, `${name(v.id)} can never be a ${ctx.typeName(n.typeId)}: they are in different type hierarchies`)
        if (selfAndBelow.has(n.typeId))
          warn(path, `The rule refers to ${ctx.typeName(n.typeId)}, so it defines ${selfName} in terms of itself`)
        return
      }
      case 'cmp': {
        const a = use(path, n.left, scope, 'The left side')
        const b = use(path, n.right, scope, 'The right side')
        if (a && b && graph.fit(a.typeIds, b.typeIds[0]) === 'none' && graph.fit(b.typeIds, a.typeIds[0]) === 'none')
          err(path, `${name(a.id)} and ${name(b.id)} can never be the same object: they are in different type hierarchies`)
        return
      }
      case 'vcmp': case 'dpred': {
        const tc = termTyping(scope)
        if (n.t === 'vcmp') typeComparison(n, path, tc)
        else typePredicate(n, path, tc)
        return
      }
      default:
        err(path, 'Unknown kind of formula')
    }
  }
  if (rule !== undefined) walk(rule, [], roots)
  for (const x of (opts.extra ?? [])) walk(x.node, x.path, x.scope)
  return { issues, used }
}

// The subtype and the types below it, whose use makes its rule circular.
function selfAndBelowOf(typeId, subtypes) {
  const out = new Set([typeId])
  for (let grew = true; grew;) {
    grew = false
    for (const st of (subtypes ?? [])) if (out.has(st.superId) && !out.has(st.subId)) { out.add(st.subId); grew = true }
  }
  return out
}

// Issues with a rule for subtype `typeId`: [{ path, severity, message }],
// severity 'error' (the rule is not a valid derivation rule) or 'warning'.
// With `typing`, the sorts of the data terms are recorded in typing.sorts and
// typing.params (see typeComparison in dataOperators.js); they are keyed by
// the nodes of upgradeRule(rule).
export function checkRule(rule, typeId, state, ctx, typing = { sorts: new Map(), params: new Map() }) {
  rule = upgradeRule(rule)
  const supers = directSupertypes(typeId, state.subtypes)
  if (!supers.length)
    return [{ path: [], severity: 'error', message: `${ctx.typeName(typeId)} is not a subtype, so it cannot be derived` }]
  if (!rule) return [{ path: [], severity: 'error', message: 'There is no derivation rule yet' }]
  const { nameOf } = ruleVariables(rule, supers, ctx)
  const { issues, used } = checkFormula(rule, [{ id: SUBJECT, typeIds: supers }], {
    nameOf, selfAndBelow: selfAndBelowOf(typeId, state.subtypes), selfName: ctx.typeName(typeId),
  }, state, ctx, typing)
  if (!used.has(SUBJECT) && !issues.some(i => i.severity === 'error'))
    issues.push({ path: [], severity: 'warning',
      message: `The rule does not mention ${supers.map(ctx.typeName).join('&')}, so it holds for all of them or for none` })
  return issues
}

// ── Formalisation ────────────────────────────────────────────────────────────

// The formula of a rule that checkRule accepts, for the given variables (from
// ruleVariables) and the typing that checkRule recorded.
export function ruleFormula(rule, vars, ctx, typing) {
  rule = upgradeRule(rule)
  const v = (id) => vars.get(id)
  const value = (x) => {
    const t = (x.typeIds ?? [x.typeId]).find(id => valueAccess(id, ctx))
    return valueAccess(t, ctx)
  }
  const tr = (n) => {
    switch (n.t) {
      case 'true': return truth()
      case 'not': return not(tr(n.arg))
      case 'and': return and(n.args.map(tr))
      case 'or': return or(n.args.map(tr))
      case 'implies': return implies(tr(n.left), tr(n.right))
      case 'iff': return iff(tr(n.left), tr(n.right))
      case 'forall': return forall([v(n.v.id)], tr(n.body))
      case 'exists': return exists([v(n.v.id)], tr(n.body))
      case 'count': return n.op === '..' ? countRange(n.n, n.m, [v(n.v.id)], tr(n.body)) : count(n.op, n.n, [v(n.v.id)], tr(n.body))
      case 'fact': return factAtom(n.factId, n.args.map(v))
      case 'type': return typeAtom(n.typeId, v(n.arg))
      case 'cmp': return cmp(n.op, v(n.left), v(n.right))
      case 'vcmp': case 'dpred': {
        // The data values of the variables the terms use, through their
        // reference modes where needed.
        const ids = termVarIds(n)
        return withValues(ids.map(id => ({ x: v(id), access: value(v(id)) })), (...vs) => {
          const term = termIn(new Map(ids.map((id, i) => [id, vs[i]])))
          return n.t === 'vcmp' ? vcmp(n.op, term(n.left), term(n.right)) : dpred(n.op, n.args.map(term))
        })
      }
      default: return truth()
    }
  }
  // Data terms, with valueOf mapping the ids of the variables they use to the
  // variables that hold their data values.
  const termIn = (valueOf) => (x) => {
    const term = termIn(valueOf)
    switch (x.t) {
      case 'var': return valueOf.get(x.id)
      case 'const': return valueConstant(x.text, typing.sorts.get(x))
      case 'op': return fn(x.op, x.args.map(term))
      case 'if': return ite(tr(x.cond), term(x.then), term(x.else))
      case 'agg': {
        // The aggregate's own variables whose data values the term uses
        // through a reference mode get a value variable of the aggregate, as
        // in Sum{CourseCode | Course, CourseCode : … ∧ Course has CourseCode}.
        // A reference mode is one-to-one, so the bag stays the same.
        const own = x.vars.map(w => v(w.id))
        const extra = [], atoms = [], inner = new Map(valueOf)
        if (x.fn !== 'count') {
          const ownIds = new Set(x.vars.map(w => w.id))
          for (const id of termVarIds(x.term)) {
            if (!ownIds.has(id)) continue
            const access = value(v(id))
            if (!access.via) { inner.set(id, v(id)); continue }
            const w = mkVar(access.via.valueTypeId)
            extra.push(w)
            atoms.push(factAtom(access.via.factId, access.via.valueIndex === 0 ? [w, v(id)] : [v(id), w]))
            inner.set(id, w)
          }
        }
        return agg(x.fn, !!x.distinct, [...own, ...extra], and(...atoms, tr(x.cond)),
          x.fn === 'count' ? null : termIn(inner)(x.term))
      }
      default: return null
    }
  }
  return tr(rule)
}

const article = (word) => (/^[aeiou]/i.test(word) ? 'an' : 'a')
const listAnd = (xs) => xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`

// "Student who is an Employee is a TeachingAssistant if and only if …"
export function derivationHeading(ot, supers, ctx) {
  const names = supers.map(ctx.typeName)
  const sub = ctx.typeName(ot.id)
  const who = names.length > 1 ? ` who is ${listAnd(names.slice(1).map(n => `${article(n)} ${n}`))}` : ''
  const conn = ot.derivation === 'semiDerived' ? 'if' : 'if and only if'
  return `${names[0]}${who} is ${article(sub)} ${sub} ${conn} …`
}

// The Formalisation panel entry for a derived or semi-derived subtype.
export function derivationEntry(ot, state, ctx) {
  const supers = directSupertypes(ot.id, state.subtypes)
  const semi = ot.derivation === 'semiDerived'
  const base = { key: `${ot.id}:derivation`, elementId: ot.id,
    kind: semi ? 'Semi-derivation rule' : 'Derivation rule',
    subject: supers.length ? derivationHeading(ot, supers, ctx) : ctx.typeName(ot.id) }
  const typing = { sorts: new Map(), params: new Map() }
  const errors = checkRule(ot.derivationRule, ot.id, state, ctx, typing).filter(i => i.severity === 'error')
  if (errors.length) return { ...base, note: `No formula yet. ${errors[0].message}.` }
  const rule = upgradeRule(ot.derivationRule)
  const { vars } = ruleVariables(rule, supers, ctx)
  const x = vars.get(SUBJECT)
  const phi = ruleFormula(rule, vars, ctx, typing)
  const s = typeAtom(ot.id, x)
  return { ...base, formula: forall([x], semi ? implies(phi, s) : iff(s, phi)) }
}

// Validation messages for every derived or semi-derived type.
export function derivationIssues(state, ctx) {
  const out = []
  for (const ot of (state.objectTypes ?? [])) {
    if (!isDerived(ot)) continue
    for (const i of checkRule(ot.derivationRule, ot.id, state, ctx))
      out.push({ ot, ...i })
  }
  return out
}
