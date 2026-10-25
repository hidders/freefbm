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
//   { t: 'fact', factId, args: [varId | null] }     args in roles[] order
//   { t: 'type', typeId, arg: varId | null }
//   { t: 'cmp', op: '=' | '≠', left: varId | null, right: varId | null }
//   { t: 'vcmp', op: '≈' | '≉' | '<' | '≤' | '>' | '≥', left: varId | null,
//     right: { var: varId | null } | { const: text } }
//
// The subject's variable id is SUBJECT.

import {
  mkVar, mkMeetVar, forall, exists, count, not, truth, implies, iff, and, or,
  factAtom, typeAtom, cmp, vcmp,
} from './formula.js'
import { renderFormula } from './renderFormula.js'
import { valueAccess, withValues, valueConstant } from './values.js'
import { VALUE_KINDS, parseLiteral } from '../utils/datatypeValues.js'

export const SUBJECT = 'subject'

export const DERIVATION_MODES = [
  { id: 'none',        label: 'Not derived' },
  { id: 'derived',     label: 'Derived' },
  { id: 'semiDerived', label: 'Semi-derived' },
]

export const hole = () => ({ t: 'hole' })

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
    default: return []
  }
}

const QUANT = new Set(['forall', 'exists', 'count'])

// The variables in scope at a path, outermost first: the subject, then the
// variable of every quantifier above the path.
export function varsInScope(rule, path, subjectTypeIds) {
  const out = [{ id: SUBJECT, typeIds: subjectTypeIds }]
  let n = rule
  for (let i = 0; i < path.length; i++) {
    if (QUANT.has(n?.t) && path[i] === 'body') out.push({ id: n.v.id, typeIds: [n.v.typeId] })
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
  const vars = new Map([[SUBJECT, mkMeetVar(subjectTypeIds)]])
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
      default: return truth()
    }
  }
  const names = new Map()
  renderFormula(forall([vars.get(SUBJECT)], skeleton(rule)), ctx, names)
  const nameOf = new Map([...vars].map(([id, v]) => [id, names.get(v) ?? '?']))
  return { vars, nameOf }
}

// ── Checking ─────────────────────────────────────────────────────────────────

// Issues with a rule for subtype `typeId`: [{ path, severity, message }],
// severity 'error' (the rule is not a valid derivation rule) or 'warning'.
export function checkRule(rule, typeId, state, ctx) {
  const issues = []
  const supers = directSupertypes(typeId, state.subtypes)
  if (!supers.length) {
    issues.push({ path: [], severity: 'error', message: `${ctx.typeName(typeId)} is not a subtype, so it cannot be derived` })
    return issues
  }
  if (!rule) {
    issues.push({ path: [], severity: 'error', message: 'There is no derivation rule yet' })
    return issues
  }
  const graph = typeGraph(state)
  const { nameOf } = ruleVariables(rule, supers, ctx)
  const name = (id) => nameOf.get(id) ?? '?'
  const typeLabel = (typeIds) => typeIds.map(ctx.typeName).join('&')
  const err = (path, message) => issues.push({ path, severity: 'error', message })
  const warn = (path, message) => issues.push({ path, severity: 'warning', message })
  let subjectUsed = false
  const selfAndBelow = new Set([typeId])
  for (let grew = true; grew;) {
    grew = false
    for (const st of (state.subtypes ?? [])) if (selfAndBelow.has(st.superId) && !selfAndBelow.has(st.subId)) { selfAndBelow.add(st.subId); grew = true }
  }

  // The variable a reference names, or null with an error when it is missing
  // or no longer in scope.
  const use = (path, id, scope, what) => {
    if (id == null) { err(path, `${what} is not chosen yet`); return null }
    const v = scope.find(s => s.id === id)
    if (!v) { err(path, `${what} refers to a variable that is no longer in scope`); return null }
    if (id === SUBJECT) subjectUsed = true
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
        walk(n.body, [...path, 'body'], [...scope, { id: n.v.id, typeIds: [n.v.typeId] }])
        return
      case 'fact': {
        const fact = ctx.factById.get(n.factId)
        if (!fact) { err(path, 'The fact type no longer exists'); return }
        fact.roles.forEach((r, i) => {
          const v = use(path, n.args?.[i], scope, `Argument ${i + 1}`)
          if (selfAndBelow.has(r.objectTypeId))
            warn(path, `The rule uses a role of ${ctx.typeName(r.objectTypeId)}, so it defines ${ctx.typeName(typeId)} in terms of itself`)
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
          warn(path, `The rule refers to ${ctx.typeName(n.typeId)}, so it defines ${ctx.typeName(typeId)} in terms of itself`)
        return
      }
      case 'cmp': {
        const a = use(path, n.left, scope, 'The left side')
        const b = use(path, n.right, scope, 'The right side')
        if (a && b && graph.fit(a.typeIds, b.typeIds[0]) === 'none' && graph.fit(b.typeIds, a.typeIds[0]) === 'none')
          err(path, `${name(a.id)} and ${name(b.id)} can never be the same object: they are in different type hierarchies`)
        return
      }
      case 'vcmp': {
        const a = use(path, n.left, scope, 'The left side')
        const ka = a && valueOf(path, a)
        let kind = ka ? VALUE_KINDS[ka.kindName] ?? null : null
        if (n.right && 'const' in n.right) {
          const p = parseLiteral(n.right.const, kind ?? VALUE_KINDS.string)
          if (p.empty) err(path, 'The constant is empty')
          else if (p.invalid) err(path, `${String(n.right.const).trim()} is not a valid ${kind.expect}`)
        } else {
          const b = use(path, n.right?.var, scope, 'The right side')
          const kb = b && valueOf(path, b)
          if (ka && kb && ka.kindName && kb.kindName && ka.kindName !== kb.kindName)
            err(path, `The values have different datatypes (${ka.kindName} and ${kb.kindName})`)
          kind ??= kb ? VALUE_KINDS[kb.kindName] ?? null : null
        }
        if (kind?.order === 'none' && n.op !== '≈' && n.op !== '≉')
          err(path, `${ka?.kindName ?? 'These'} values have no order, so only ≈ and ≉ apply`)
        return
      }
      default:
        err(path, 'Unknown kind of formula')
    }
  }
  walk(rule, [], [{ id: SUBJECT, typeIds: supers }])
  if (!subjectUsed && !issues.some(i => i.severity === 'error'))
    warn([], `The rule does not mention ${typeLabel(supers)}, so it holds for all of them or for none`)
  return issues
}

// ── Formalisation ────────────────────────────────────────────────────────────

// The formula of a rule that checkRule accepts, for the given variables (from
// ruleVariables).
export function ruleFormula(rule, vars, ctx) {
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
      case 'count': return count(n.op, n.n, [v(n.v.id)], tr(n.body))
      case 'fact': return factAtom(n.factId, n.args.map(v))
      case 'type': return typeAtom(n.typeId, v(n.arg))
      case 'cmp': return cmp(n.op, v(n.left), v(n.right))
      case 'vcmp': {
        const x = v(n.left), ax = value(x)
        if ('const' in n.right) return withValues([{ x, access: ax }], (vx) => vcmp(n.op, vx, valueConstant(n.right.const, ax.kindName)))
        const y = v(n.right.var)
        return withValues([{ x, access: ax }, { x: y, access: value(y) }], (vx, vy) => vcmp(n.op, vx, vy))
      }
      default: return truth()
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
  const errors = checkRule(ot.derivationRule, ot.id, state, ctx).filter(i => i.severity === 'error')
  if (errors.length) return { ...base, note: `No formula yet. ${errors[0].message}.` }
  const { vars } = ruleVariables(ot.derivationRule, supers, ctx)
  const x = vars.get(SUBJECT)
  const phi = ruleFormula(ot.derivationRule, vars, ctx)
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
