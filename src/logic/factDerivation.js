// Derivation rules of derived and semi-derived fact types
// (docs/logic/agg-logic.tex, "Derivation Rules").
//
// A fact type p has one variable per role, named after the role's player.
// Each role is either selected, so its variable is bound to an object of the
// current population, or computed, so its object is the one whose data value
// is given by a term. Writing x for the selected variables, y for the
// computed ones and z for the rule's extra variables, a rule is
//   p(x, y*) ⇐ φ(x, z) ∧ ⋀ yᵢ ≈ tᵢ(x, z)
// and is stored on the fact type (derivationRule) as
//   { body: R, extraVars: [{ id, typeId }], terms: { [roleId]: T } }
// with R a formula and T a data term in the format of derivationRule.js. The
// roles with an entry in terms are the computed ones; φ may not use them.
//
// Formalisation:
//   F1  ∀x, z (φ → ∃y (p(x, y) ∧ ⋀ yᵢ ≈ tᵢ))
//   F2  ∀x, y (p(x, y) → ∃z (φ ∧ ⋀ yᵢ ≈ tᵢ))
// A derived fact type has both, a semi-derived one only F1. Without computed
// roles, F1 and F2 together are shown as ∀x (p(x) ↔ ∃z φ). A derived fact
// type without extra variables shows F1 as ∀x (φ → ∃y p(x, y)): F2 then
// gives yᵢ ≈ tᵢ(x) for every fact, so the equations add nothing to F1.

import { forall, exists, implies, iff, and, factAtom } from './formula.js'
import { hole, upgradeRule, checkFormula, formulaVariables, ruleFormula, childPaths, isDerived } from './derivationRule.js'
import { fits } from './dataOperators.js'
import { valueAccess } from './values.js'
import { findRefMode, findCompositePI } from '../utils/refMode.js'

export const roleVarId = (role) => `role:${role.id}`

export function isDerivedFact(f) {
  return f?.derivation === 'derived' || f?.derivation === 'semiDerived'
}

// The ORM2 mark after the reading of a derived (*) or semi-derived (+) fact type,
// doubled (** or ++) when its population is also stored, as in NORMA.
export const factDerivationMark = (f) => {
  const m = f?.derivation === 'derived' ? '*' : f?.derivation === 'semiDerived' ? '+' : ''
  return m && f.derivationStored ? m + m : m
}

export const emptyFactRule = () => ({ body: hole(), extraVars: [], terms: {} })

// Whether a role of the fact type is computed by its rule.
export const isComputedRole = (fact, role, rule = fact.derivationRule) =>
  !!rule?.terms && Object.prototype.hasOwnProperty.call(rule.terms, role.id)

// The fact types that identify an entity type (ref mode or composite
// identifier) are not derived by a rule: their population follows from the
// entity's population.
export function isIdentifyingFact(fact, state) {
  const facts = state.facts ?? [], objectTypes = state.objectTypes ?? []
  for (const t of [...objectTypes, ...facts.filter(f => f.objectified)]) {
    if (t.id === fact.id) continue
    if (findRefMode(t, facts, objectTypes)?.factId === fact.id) return true
    const cp = findCompositePI(t, facts, objectTypes, state.constraints)
    if (cp && (cp.factId === fact.id || cp.factIds?.includes(fact.id))) return true
  }
  return false
}

// Why the fact type cannot be derived, or null.
export function whyNotDerivable(fact, state) {
  if (fact.objectified) return 'An objectified fact type cannot be derived'
  if (isIdentifyingFact(fact, state)) return 'A fact type that identifies an entity type cannot be derived'
  return null
}

// The value-defining equation yᵢ ≈ tᵢ of a computed role, as a value
// comparison atom. The same term gives the same node, so the typing recorded
// for it stays valid between checking and formalising.
const eqCache = new WeakMap()
function equation(varId, term) {
  if (!term || typeof term !== 'object') return { t: 'vcmp', op: '≈', left: { t: 'var', id: varId }, right: hole() }
  if (!eqCache.has(term)) eqCache.set(term, new Map())
  const m = eqCache.get(term)
  if (!m.has(varId)) m.set(varId, { t: 'vcmp', op: '≈', left: { t: 'var', id: varId }, right: term })
  return m.get(varId)
}

// The parts of a rule: its body, the root variables ({ id, typeIds, roleId?,
// computed? }) in role order then the extra variables, and the equations of
// the computed roles ({ role, varId, eq }).
export function factRuleParts(fact, rule = fact.derivationRule) {
  const body = upgradeRule(rule?.body) ?? hole()
  const roles = fact.roles.map(r => ({
    id: roleVarId(r), typeIds: [r.objectTypeId], roleId: r.id, computed: isComputedRole(fact, r, rule),
  }))
  const extra = (rule?.extraVars ?? []).map(v => ({ id: v.id, typeIds: [v.typeId], extra: true }))
  const selected = roles.filter(r => !r.computed)
  const computed = roles.filter(r => r.computed)
  const eqs = computed.map(r => ({ roleId: r.roleId, varId: r.id, eq: equation(r.id, rule.terms[r.roleId]) }))
  return { body, roles, extra, selected, computed, eqs, roots: [...roles, ...extra] }
}

// Display names of all the rule's variables.
export function factRuleVariables(fact, ctx, rule = fact.derivationRule) {
  const parts = factRuleParts(fact, rule)
  return { ...formulaVariables(and(parts.body, ...parts.eqs.map(e => e.eq)) ?? parts.body, parts.roots, ctx), parts }
}

// Every variable a formula or term refers to, including inside if-conditions.
function varRefs(n, out = new Set()) {
  if (!n || typeof n !== 'object') return out
  switch (n.t) {
    case 'var': if (n.id != null) out.add(n.id); return out
    case 'fact': for (const a of (n.args ?? [])) if (a != null) out.add(a); return out
    case 'type': if (n.arg != null) out.add(n.arg); return out
    case 'cmp': if (n.left != null) out.add(n.left); if (n.right != null) out.add(n.right); return out
    default:
      for (const p of childPaths(n)) varRefs(p.reduce((x, k) => x?.[k], n), out)
      return out
  }
}

// Issues with the rule of a fact type: [{ path, severity, message }]. Paths
// are into the rule: ['body', …] for the condition, ['terms', roleId, …] for
// the term of a computed role, and ['extraVars', i] for an extra variable.
// With `typing`, the sorts of the data terms are recorded as in checkRule.
export function checkFactRule(fact, state, ctx, typing = { sorts: new Map(), params: new Map() }, rule = fact.derivationRule) {
  const why = whyNotDerivable(fact, state)
  if (why) return [{ path: [], severity: 'error', message: why }]
  if (!rule) return [{ path: [], severity: 'error', message: 'There is no derivation rule yet' }]
  const issues = []
  const err = (path, message) => issues.push({ path, severity: 'error', message })
  const warn = (path, message) => issues.push({ path, severity: 'warning', message })

  fact.roles.forEach((r, i) => {
    if (!r.objectTypeId || !(ctx.otById.has(r.objectTypeId) || ctx.factById.get(r.objectTypeId)?.objectified))
      err([], `Role ${i + 1} has no object type`)
  })
  if (issues.length) return issues
  ;(rule.extraVars ?? []).forEach((v, i) => {
    if (!v.typeId || !(ctx.otById.has(v.typeId) || ctx.factById.get(v.typeId)?.objectified))
      err(['extraVars', i], 'The variable has no type')
  })
  if (issues.length) return issues

  const { nameOf, parts } = factRuleVariables(fact, ctx, rule)
  const name = (id) => nameOf.get(id) ?? '?'
  const computedIds = new Set(parts.computed.map(c => c.id))
  const unavailable = new Map(parts.computed.map(c => [c.id,
    `${name(c.id)} is computed by its term, so the condition cannot use it`]))
  const scope = [...parts.selected, ...parts.extra]

  // The condition φ.
  const inBody = checkFormula(parts.body, scope, { nameOf, selfFactId: fact.id, unavailable }, state, ctx, typing)
  for (const i of inBody.issues) issues.push({ ...i, path: ['body', ...i.path] })

  // The terms, through their equations yᵢ ≈ tᵢ.
  for (const { roleId, varId, eq } of parts.eqs) {
    const at = ['terms', roleId]
    const playerId = parts.roles.find(r => r.id === varId).typeIds[0]
    const player = ctx.otById.get(playerId)
    if (!player) { err(at, `${name(varId)} is a nested entity type, so its objects cannot be computed`); continue }
    if (isDerived(player)) { err(at, `${name(varId)} is a derived subtype, so its objects cannot be computed`); continue }
    if (!valueAccess(playerId, ctx)) {
      err(at, `${name(varId)} has no data value: ${ctx.typeName(playerId)} is not a value type and has no reference mode`)
      continue
    }
    const others = new Map(unavailable)
    others.delete(varId)
    const r = checkFormula(undefined, [], {
      nameOf, selfFactId: fact.id, unavailable: others,
      extra: [{ node: eq, path: [], scope: [...scope, parts.roles.find(x => x.id === varId)] }],
    }, state, ctx, typing)
    for (const i of r.issues) {
      const p = i.path[0] === 'right' ? i.path.slice(1) : []
      issues.push({ ...i, path: [...at, ...p] })
    }
    if (r.issues.some(i => i.severity === 'error')) continue
    const own = [...varRefs(eq.right)].filter(id => computedIds.has(id))
    if (own.length) { err(at, `The term uses ${name(own[0])}, which is computed`); continue }
    const ts = typing.sorts.get(eq.right), ys = typing.sorts.get(eq.left)
    if (ts != null && ys != null && !fits(ts, ys))
      err(at, `The term gives ${ts} values, but ${name(varId)} has ${ys} values`)
  }

  // A variable the condition does not mention ranges over its whole type.
  // That is often a forgotten atom, so warn, unless a computed role's term
  // uses the variable (e.g. every Student has total credits Sum{…}).
  if (!issues.some(i => i.severity === 'error')) {
    const inTerms = new Set()
    for (const { eq } of parts.eqs) varRefs(eq.right, inTerms)
    const unmentioned = (v) => !inBody.used.has(v.id) && !inTerms.has(v.id)
    const message = (v) => `${name(v.id)} does not occur in the condition or a term, so it ranges over every ${ctx.typeName(v.typeIds[0])}`
    for (const v of parts.selected) if (unmentioned(v)) warn(['body'], message(v))
    parts.extra.forEach((v, i) => { if (unmentioned(v)) warn(['extraVars', i], message(v)) })
  }
  return issues
}

// "Article has markup MoneyAmount"
export function factLabel(fact, ctx) {
  const parts = fact.readingParts ?? []
  const words = []
  fact.roles.forEach((r, i) => {
    if (parts[i]?.trim()) words.push(parts[i].trim())
    words.push(ctx.typeName(r.objectTypeId))
  })
  if (parts[fact.roles.length]?.trim()) words.push(parts[fact.roles.length].trim())
  return words.join(' ')
}

// The formulas of a rule that checkFactRule accepts:
// { f1, f2 } with computed roles, { iff } without (f2 null when semi-derived).
export function factRuleFormulas(fact, state, ctx, rule = fact.derivationRule) {
  const typing = { sorts: new Map(), params: new Map() }
  const errors = checkFactRule(fact, state, ctx, typing, rule).filter(i => i.severity === 'error')
  if (errors.length) return { error: errors[0] }
  const { vars, parts } = factRuleVariables(fact, ctx, rule)
  const v = (r) => vars.get(r.id)
  const x = parts.selected.map(v), y = parts.computed.map(v), z = parts.extra.map(v)
  const phi = ruleFormula(parts.body, vars, ctx, typing)
  const eqs = parts.eqs.map(e => ruleFormula(e.eq, vars, ctx, typing))
  const p = factAtom(fact.id, parts.roles.map(v))
  const semi = fact.derivation === 'semiDerived'
  if (!y.length) {
    return semi
      ? { f1: forall([...x, ...z], implies(phi, p)) }
      : { iff: forall(x, iff(p, exists(z, phi))) }
  }
  // A condition ⊤ (every combination of the selected roles) is left out.
  const top = phi.t === 'true'
  const derived = exists(y, !semi && !z.length ? p : and(p, ...eqs))
  return {
    f1: forall([...x, ...z], top ? derived : implies(phi, derived)),
    f2: semi ? null : forall([...x, ...y], implies(p, exists(z, top ? and(...eqs) : and(phi, ...eqs)))),
  }
}

// The Formalisation panel entries for a derived or semi-derived fact type.
export function factDerivationEntries(fact, state, ctx, rule = fact.derivationRule) {
  const semi = fact.derivation === 'semiDerived'
  const base = { elementId: fact.id, subject: factLabel(fact, ctx) }
  const kind = semi ? 'Semi-derivation rule' : 'Derivation rule'
  const fs = factRuleFormulas(fact, state, ctx, rule)
  if (fs.error) return [{ ...base, key: `${fact.id}:derivation`, kind, note: `No formula yet. ${fs.error.message}.` }]
  if (fs.iff) return [{ ...base, key: `${fact.id}:derivation`, kind, formula: fs.iff }]
  const out = [{ ...base, key: `${fact.id}:derivation:1`, kind: `${kind}, every derived fact holds`, formula: fs.f1 }]
  if (fs.f2) out.push({ ...base, key: `${fact.id}:derivation:2`, kind: `${kind}, only derived facts hold`, formula: fs.f2 })
  return out
}

// Validation messages for every derived or semi-derived fact type.
export function factDerivationIssues(state, ctx) {
  const out = []
  for (const f of (state.facts ?? [])) {
    if (!isDerivedFact(f)) continue
    for (const i of checkFactRule(f, state, ctx)) out.push({ fact: f, ...i })
  }
  return out
}
