// Carrying a constraint through a mapping (formula plan, step 3).
//
// A constraint χ of one schema that the other schema loses (accounting.js)
// can be added to that other schema as a formula constraint: χ with every
// atom replaced by what the mapping says it is there. As in Fold (fold.js)
// this goes through the mapping's atomic rules, those that map one fact type,
// or one entity type, between reference values:
//
//   - a variable x of an entity type E becomes the variables ȳ of E's
//     reference values; ∀x φ becomes ∀ȳ (E'(ȳ) → φ'), ∃x φ becomes
//     ∃ȳ (E'(ȳ) ∧ φ'), where E'(ȳ) is the other side of E's rule;
//   - a fact atom F(x̄) becomes the other side of F's rule, its frontier
//     variables the reference values of x̄, its other variables ∃-bound;
//   - an identifying fact (x has its reference value v) equates the values;
//   - value comparisons and data terms keep their form.
//
// translateEntry(state, mapping, entry, side) → { rule, deontic } (a rule
// tree over the other side's schema, derivationRule.js format) or { error }.
// asValueComparison(rule, ctx) recognises ∀x̄ (φ → x op y) as a value
// comparison constraint with φ as its join path.

import { expandSide, asSide, sideContext, SIDES } from './mapping.js'
import { keyLeaves, schemeParts, atomicRules } from './fold.js'
import { accountingSteps } from './accounting.js'
import { makeContext } from '../logic/constraintFormulas.js'
import { checkFormulaConstraint, formulaConstraintEntry } from '../logic/formulaConstraint.js'
import { asGraphical, graphicalFields } from './recognise.js'
import { mkConstraint } from '../store/storeHelpers.js'
import { withImplicitRules } from './sameModel.js'

const other = (side) => (side === 'source' ? 'target' : 'source')
class TranslateError extends Error {}
const fail = (m) => { throw new TranslateError(m) }

const andOf = (args) => {
  const flat = args.filter(Boolean).flatMap(a => (a.t === 'and' ? a.args : [a])).filter(a => a.t !== 'true')
  return flat.length === 0 ? { t: 'true' } : flat.length === 1 ? flat[0] : { t: 'and', args: flat }
}
const orOf = (args) => (args.length === 1 ? args[0] : { t: 'or', args })
const existsAll = (vars, body) => vars.reduceRight((b, v) => ({ t: 'exists', v, body: b }), body)
const forallAll = (vars, body) => vars.reduceRight((b, v) => ({ t: 'forall', v, body: b }), body)

export function translateEntry(state, mapping, entry, side) {
  mapping = withImplicitRules(state, mapping)
  const X = side, Y = other(side)
  const ctxs = { source: sideContext(state, mapping.sourceSchemaId), target: sideContext(state, mapping.targetSchemaId) }
  const ctxX = ctxs[X], ctxY = ctxs[Y]
  const els = { objectTypes: ctxX.objectTypes, facts: ctxX.facts, subtypes: ctxX.subtypes, constraints: ctxX.constraints }
  try {
    let f = entry.formula
    if (!f) fail('it has no formula')
    const deontic = f.t === 'obligatory'
    if (deontic) f = f.arg
    const atomics = atomicRules(mapping, X, ctxX, els)
    let n = 0
    const slotType = new Map()   // slot var id → type id in Y (once known)
    const newSlot = () => { const id = `y${++n}`; return id }
    const env = new Map()        // Var (object) → [slot ids]
    const slotsOf = (x) => env.get(x) ?? fail('a variable is used outside its quantifier')

    // The other side of a rule, its frontier variables given by `front`
    // (name → slot id), its own variables fresh and ∃-bound.
    const instantiate = (ruleSide, front, what) => {
      const ex = expandSide(asSide(ruleSide), ctxY)
      const ren = new Map(), eqs = []
      const own = []
      const types = new Map(ex.vars.map(v => [v.id, v.typeId]))
      const bindVar = (v, y) => {
        const s = front.get(y) ?? fail(`the rule for ${what} uses a value the constraint does not give`)
        if (types.get(v) && !slotType.has(s)) slotType.set(s, types.get(v))
        if (ren.has(v) && ren.get(v) !== s) eqs.push({ t: 'vcmp', op: '≈', left: { t: 'var', id: ren.get(v) }, right: { t: 'var', id: s } })
        else ren.set(v, s)
      }
      const collect = (atoms) => {
        for (const a of atoms) {
          if (a.t === 'bind') bindVar(a.v, a.y)
          if (a.t === 'opt') collect(a.atoms)
        }
      }
      collect(ex.atoms)
      const r = (v) => {
        if (v == null) fail(`the rule for ${what} has an atom with a missing variable`)
        if (!ren.has(v)) { const id = `z${++n}`; ren.set(v, id); own.push({ id, typeId: types.get(v) }) }
        return ren.get(v)
      }
      const atomsOf = (atoms) => andOf(atoms.map(a => {
        switch (a.t) {
          case 'fact': return { t: 'fact', factId: a.factId, args: a.args.map(r) }
          // A variable has its type already.
          case 'type': return ctxY.otById.get(a.typeId)?.kind === 'value' || types.get(a.arg) === a.typeId ? (r(a.arg), null) : { t: 'type', typeId: a.typeId, arg: r(a.arg) }
          case 'bind': return null
          case 'const': return { t: 'vcmp', op: '≈', left: { t: 'var', id: r(a.v) }, right: { t: 'const', text: String(a.text ?? '').trim().replace(/^'(.*)'$/s, '$1') } }
          // The frontier values are given, so an optional part is there.
          case 'opt': return atomsOf(a.atoms)
          case 'not': {
            const before = own.length
            const body = atomsOf(a.atoms)
            const inner = own.splice(before)
            return { t: 'not', arg: existsAll(inner.map(v => ({ id: v.id, typeId: v.typeId })), body) }
          }
          default: return fail(`the rule for ${what} has a ${a.t} atom`)
        }
      }))
      const body = andOf([atomsOf(ex.atoms), ...eqs])
      return existsAll(own.map(v => ({ id: v.id, typeId: v.typeId })), body)
    }

    // E'(slots): an entity's existence on the other side.
    const entityGuard = (typeId, slots) => {
      const t = ctxX.otById.get(typeId)
      if (!t || t.kind === 'value') return null
      const e = atomics.types.get(typeId)?.[0]
      if (!e) fail(`no mapping rule maps ${t.name} on its own`)
      return withLeaves(e.atomic.key, slots, (front, extra) => andOf([instantiate(e.rule[Y], front, t.name), ...extra]))
    }
    // Frontier names of a rule's leaves matched to slots; constant leaves
    // become comparisons.
    const withLeaves = (leaves, slots, k) => {
      if (leaves.length !== slots.length) fail('a rule gives a type another identifier than its reference scheme')
      const front = new Map(), extra = []
      leaves.forEach((leaf, i) => {
        if (leaf.y != null) {
          if (front.has(leaf.y) && front.get(leaf.y) !== slots[i]) extra.push({ t: 'vcmp', op: '≈', left: { t: 'var', id: front.get(leaf.y) }, right: { t: 'var', id: slots[i] } })
          else front.set(leaf.y, slots[i])
        } else extra.push({ t: 'vcmp', op: '≈', left: { t: 'var', id: slots[i] }, right: { t: 'const', text: leaf.c } })
      })
      return k(front, extra)
    }

    const subOf = (sub, sup) => sub === sup || ctxX.subtypes.some(st => st.subId === sub && subOf(st.superId, sup))
    const conjuncts = (n) => (!n ? [] : n.t === 'and' ? n.args.flatMap(conjuncts) : [n])
    const playsIn = (atoms, x) => atoms.some(a => a.t === 'fact' && a.args.some((v, i) => v === x
      && subOf(ctxX.factById.get(a.factId)?.roles[i]?.objectTypeId, x.typeId)))

    const bind = (x) => {
      const leaves = keyLeaves(x.typeId, ctxX, els) ?? fail(`${ctxX.otById.get(x.typeId)?.name ?? 'a type'} has no reference scheme to carry over`)
      const slots = leaves.map(() => newSlot())
      env.set(x, slots)
      return slots
    }
    const declared = (slots) => slots.map(id => ({ id, typeId: slotType.get(id) ?? fail('a value of the constraint has no counterpart in the other schema') }))

    const term = (t) => {
      if (t && !t.t && t.typeId) {
        const s = slotsOf(t)
        if (s.length !== 1) fail('it compares the value of an entity with a composite identifier')
        return { t: 'var', id: s[0] }
      }
      switch (t?.t) {
        case 'const': return { t: 'const', text: t.text }
        case 'fn': return { t: 'op', op: t.op, args: t.args.map(term) }
        case 'ite': return { t: 'if', cond: tr(t.cond), then: term(t.then), else: term(t.else) }
        case 'agg': return fail('it uses an aggregate')
      }
      return fail('it uses a term that is not carried over yet')
    }

    const tr = (g) => {
      switch (g.t) {
        case 'true': return { t: 'true' }
        case 'not': return { t: 'not', arg: tr(g.arg) }
        case 'and': return andOf(g.args.map(tr))
        case 'or': return orOf(g.args.map(tr))
        case 'implies': return { t: 'implies', left: tr(g.left), right: tr(g.right) }
        case 'iff': return { t: 'iff', left: tr(g.left), right: tr(g.right) }
        case 'forall': case 'exists': {
          const slots = g.vars.map(bind)
          // No guard where the formula itself says x is an E: x plays a role
          // of E (or of a subtype of E) in a fact atom of the antecedent.
          const known = conjuncts(g.t === 'forall' ? (g.body.t === 'implies' ? g.body.left : null) : g.body)
          const guards = g.vars.map((x, i) => (playsIn(known, x) ? null : entityGuard(x.typeId, slots[i]))).filter(Boolean)
          const body = tr(g.body)
          const vars = declared(slots.flat())
          // ∀ȳ (E'(ȳ) → (ψ → χ)) is written ∀ȳ (E'(ȳ) ∧ ψ → χ).
          const guarded = !guards.length ? body
            : body.t === 'implies' ? { t: 'implies', left: andOf([...guards, body.left]), right: body.right }
            : { t: 'implies', left: andOf(guards), right: body }
          return g.t === 'forall'
            ? forallAll(vars, guarded)
            : existsAll(vars, andOf([...guards, body]))
        }
        case 'count': {
          if (g.vars.length !== 1) fail('it counts tuples of several variables')
          const slots = bind(g.vars[0])
          if (slots.length !== 1) fail('it counts entities with a composite identifier')
          const guard = entityGuard(g.vars[0].typeId, slots)
          const body = andOf([guard, tr(g.body)])
          const [v] = declared(slots)
          return g.op === '..' ? { t: 'count', op: '..', n: g.n, m: g.m, v, body } : { t: 'count', op: g.op, n: g.n, v, body }
        }
        case 'type': return entityGuard(g.typeId, slotsOf(g.arg)) ?? { t: 'true' }
        case 'cmp': {
          const a = slotsOf(g.left), b = slotsOf(g.right)
          if (a.length !== b.length) fail('it compares entities with different identifiers')
          const eqs = a.map((s, i) => ({ t: 'vcmp', op: g.op === '≠' ? '≉' : '≈', left: { t: 'var', id: s }, right: { t: 'var', id: b[i] } }))
          return g.op === '≠' ? orOf(eqs) : andOf(eqs)
        }
        case 'vcmp': return { t: 'vcmp', op: g.op, left: term(g.left), right: term(g.right) }
        case 'dpred': return { t: 'dpred', op: g.op, args: g.args.map(term) }
        case 'fact': {
          const fact = ctxX.factById.get(g.factId) ?? fail('it names a fact type that is not in its schema')
          const args = g.args.map(slotsOf)
          // An identifying fact: the reference values are the same.
          for (let e = 0; e < fact.roles.length && fact.roles.length === 2; e++) {
            const p = schemeParts(fact.roles[e].objectTypeId, ctxX, els)?.find(q => q.factId === fact.id && q.entityRoleIndex === e)
            if (!p) continue
            const es = args[e], vs = args[p.roleIndex]
            vs.forEach((s, i) => {
              const t = es[p.from + i]
              if (!slotType.has(s) && slotType.has(t)) slotType.set(s, slotType.get(t))
              if (!slotType.has(t) && slotType.has(s)) slotType.set(t, slotType.get(s))
            })
            return andOf(vs.map((s, i) => ({ t: 'vcmp', op: '≈', left: { t: 'var', id: es[p.from + i] }, right: { t: 'var', id: s } })))
          }
          const entry = atomics.facts.get(fact.id)?.[0]
          if (!entry) fail(`no mapping rule maps "${(fact.readingParts ?? []).join(' ').trim()}" on its own`)
          const leaves = entry.atomic.roles.flat(), slots = args.flat()
          return withLeaves(leaves, slots, (front, extra) => andOf([instantiate(entry.rule[Y], front, 'a fact type'), ...extra]))
        }
        case 'tc': {
          // [TC_{v,w} φ](s, t) over entities with one reference value each:
          // the closure of φ's translation over those values.
          const [sv, sw] = g.vars.map(bind)
          if (sv.length !== 1 || sw.length !== 1) fail('it takes a transitive closure over entities with a composite identifier')
          const body = tr(g.body)
          const [s, t] = g.args.map(a => (a ? slotsOf(a) : fail('it uses a transitive closure with an open end')))
          if (s.length !== 1 || t.length !== 1) fail('it takes a transitive closure over entities with a composite identifier')
          return { t: 'tc', star: !!g.star, vars: declared([sv[0], sw[0]]), body, args: [s[0], t[0]] }
        }
        default: return fail(`it uses ${g.t}`)
      }
    }
    const unique = new Set()
    for (const fy of ctxY.facts) {
      if (fy.roles?.length !== 2) continue
      for (const u of [...(fy.uniqueness ?? []).map(u => u.roles ?? []), ...(fy.preferredUniqueness ?? [])])
        if (u?.length === 1) unique.add(`${fy.id}:${u[0]}`)
    }
    const mandatory = new Set(ctxY.facts.flatMap(fy => (fy.roles ?? []).map((r, i) => (r.mandatory ? `${fy.id}:${i}` : null)).filter(Boolean)))
    const rule = simplify(tr(f), { unique, mandatory })
    return { rule, deontic }
  } catch (e) {
    if (e instanceof TranslateError) return { error: e.message }
    throw e
  }
}

// ── Simplification ───────────────────────────────────────────────────────────

// ∀y (… ∧ x ≈ y ∧ … → φ) and ∃y (… ∧ x ≈ y ∧ …) with x, y of one type: y is x.
// With `unique` (the binary fact type roles "factId:i" that are unique on
// their own), ∃z (F(z, v) ∧ …) where F(x, v) already holds there, z and x of
// one type and F's role of v unique: z is x (a row of a table found again
// through its key, as a translation does when a column of the row is read).
// `mandatory` ("factId:i") lets a guard F(z, v) on z's mandatory role go.
export function simplify(rule, { unique = null, mandatory = null } = {}) {
  const subst = (n, from, to) => JSON.parse(JSON.stringify(n).replaceAll(`"id":"${from}"`, `"id":"${to}"`)
    .replaceAll(`"arg":"${from}"`, `"arg":"${to}"`).replace(new RegExp(`"${from}"(?=[,\\]])`, 'g'), `"${to}"`))
  const typeOf = new Map()
  const note = (n) => { if (n && typeof n === 'object') { if ((n.t === 'forall' || n.t === 'exists' || n.t === 'count') && n.v) typeOf.set(n.v.id, n.v.typeId); Object.values(n).forEach(x => (Array.isArray(x) ? x.forEach(note) : note(x))) } }
  note(rule)
  const eqWith = (conj, y) => {
    const list = conj?.t === 'and' ? conj.args : conj ? [conj] : []
    for (const a of list) {
      if (a.t !== 'vcmp' || a.op !== '≈' || a.left?.t !== 'var' || a.right?.t !== 'var') continue
      const o = a.left.id === y ? a.right.id : a.right.id === y ? a.left.id : null
      if (o && o !== y && typeOf.get(o) === typeOf.get(y)) return { other: o, atom: a }
    }
    return null
  }
  const drop = (conj, atom) => (conj.t === 'and' ? andOf(conj.args.filter(a => a !== atom)) : { t: 'true' })
  const walk = (n) => {
    if (!n || typeof n !== 'object') return n
    if (Array.isArray(n)) return n.map(walk)
    let m = Object.fromEntries(Object.entries(n).map(([k, v]) => [k, walk(v)]))
    if (m.t === 'forall' && m.body?.t === 'implies') {
      const hit = eqWith(m.body.left, m.v.id)
      if (hit) {
        const left = drop(m.body.left, hit.atom)
        const body = left.t === 'true' ? m.body.right : { ...m.body, left }
        return subst(body, m.v.id, hit.other)
      }
    }
    if (m.t === 'exists') {
      const hit = eqWith(m.body, m.v.id)
      if (hit) return subst(drop(m.body, hit.atom), m.v.id, hit.other)
    }
    if (m.t === 'and') m = andOf(m.args)
    return m
  }
  // ∃z over a conjunction with F(z, v), where the context knows F(x, v).
  const conjuncts = (n) => (n?.t === 'and' ? n.args : n ? [n] : [])
  const keyHit = (known, z, body) => {
    for (const a of conjuncts(body)) {
      if (a.t !== 'fact' || a.args?.length !== 2) continue
      const zi = a.args.indexOf(z)
      if (zi < 0 || a.args[1 - zi] === z || !unique.has(`${a.factId}:${1 - zi}`)) continue
      const v = a.args[1 - zi]
      const k = known.find(b => b.t === 'fact' && b.factId === a.factId && b.args[1 - zi] === v && b.args[zi] !== z && typeOf.get(b.args[zi]) === typeOf.get(z))
      if (k) return { other: k.args[zi], atom: a }
    }
    return null
  }
  const merge = (n, known) => {
    if (!n || typeof n !== 'object' || Array.isArray(n)) return n
    if (n.t === 'and') {
      const all = [...known, ...n.args]
      return andOf(n.args.map(a => merge(a, all.filter(b => b !== a))))
    }
    if (n.t === 'implies') {
      const left = merge(n.left, known)
      return { ...n, left, right: merge(n.right, [...known, ...conjuncts(left)]) }
    }
    if (n.t === 'exists') {
      const hit = keyHit(known, n.v.id, n.body)
      if (hit) return merge(subst(drop(n.body, hit.atom), n.v.id, hit.other), known)
      return { ...n, body: merge(n.body, known) }
    }
    if (n.t === 'forall') {
      // ∀v (∃z A ∧ B → R): when R reads a row again that A finds, z is
      // taken out of the antecedent, ∀v ∀z (A ∧ B → R), so R can use it;
      // and ∀v ∀z (L → R) with v only in L is ∀z (∃v L → R).
      const b = n.body
      const ex = b?.t === 'implies' ? conjuncts(b.left).filter(a => a.t === 'exists') : []
      if (ex.length) {
        let left = b.left, vars = []
        for (let k = 0; k < 4; k++) {
          const parts = conjuncts(left)
          const e = parts.find(a => a.t === 'exists')
          if (!e) break
          vars.push(e.v)
          left = andOf(parts.flatMap(a => (a === e ? conjuncts(e.body) : [a])))
        }
        const right = merge(b.right, [...known, ...conjuncts(left)])
        const used = (x, id) => JSON.stringify(x).includes(`"${id}"`)
        if (vars.some(v => used(right, v.id) && !used(b.right, v.id))) {
          const inner = forallAll(vars, { ...b, left, right })
          if (!used(right, n.v.id)) {
            // ∀v ∀z̄ (L → R), v not in R: ∀z̄ (∃v L → R), and ∀z̄ R when L
            // is F(z, v) with z's role mandatory (the row's own key).
            const zi = left.t === 'fact' && left.args?.length === 2 ? left.args.indexOf(left.args.find(a => a !== n.v.id)) : -1
            if (zi >= 0 && left.args[1 - zi] === n.v.id && mandatory?.has(`${left.factId}:${zi}`) && vars.some(v => v.id === left.args[zi]))
              return forallAll(vars, right)
            return forallAll(vars, { ...b, left: { t: 'exists', v: n.v, body: left }, right })
          }
          return { ...n, body: inner }
        }
      }
      return { ...n, body: merge(n.body, known) }
    }
    // Other connectives (∨, ¬, counts, …): the context still holds inside.
    if (n.t === 'or') return { ...n, args: n.args.map(a => merge(a, known)) }
    if (n.t === 'not') return { ...n, arg: merge(n.arg, known) }
    return n
  }
  let prev, cur = rule
  for (let i = 0; i < 6 && JSON.stringify(prev) !== JSON.stringify(cur); i++) {
    prev = cur
    cur = walk(cur)
    if (unique) cur = walk(merge(cur, []))
  }
  return cur
}

// ── Recognising value comparisons ────────────────────────────────────────────


// ∀x̄ (φ → x op y), with x and y variables that φ binds in fact atoms, as a
// value comparison constraint: { sequence: [role, role], query, operator }
// or null. The query is φ with x and y free (the others ∃-bound).
export function asValueComparison(rule) {
  const g = asGraphical(rule)
  return g?.constraintType === 'valueComparison' ? { sequence: g.sequences[0], query: g.queries[0], operator: g.operator } : null
}

// ── A proposal, checked ──────────────────────────────────────────────────────

// The translation of a lost constraint (an accounting item x of `side`),
// with what it would be in the other schema and whether accounting finds the
// constraint kept once it is there: { schemaId, rule, deontic, vc, entry,
// ctx, errors, status, reason } or { error }.
export function proposeTranslation(state, mapping, x, side) {
  mapping = withImplicitRules(state, mapping)
  const t = translateEntry(state, mapping, x.entry, side)
  if (t.error) return { error: t.error }
  const schemaId = side === 'source' ? mapping.targetSchemaId : mapping.sourceSchemaId
  const c = { id: '__carried', kind: 'constraint', constraintType: 'formula', schemaId, rule: t.rule, roleSequences: [], subtypeIds: [], name: '',
    ...(t.deontic ? { deontic: true } : {}) }
  const state2 = { ...state, constraints: [...state.constraints, c] }
  const ctx = makeContext(state2)
  const errors = checkFormulaConstraint(c, state2, ctx).filter(i => i.severity === 'error').map(i => i.message)
  const entry = formulaConstraintEntry(c, state2, ctx)
  let status = null, reason = null
  if (!errors.length) {
    try {
      const gen = accountingSteps(state2, mapping, { onlyKeys: new Set([x.key]) })
      let r
      do r = gen.next(); while (!r.done)
      const y = r.value.sides[side].find(e => e.key === x.key)
      status = y?.status ?? null; reason = y?.reason ?? null
    } catch (e) { reason = `The check failed: ${e?.message ?? e}` }
  }
  // A graphical constraint that says the same, when it keeps the constraint
  // too (its join paths are checked as such). Tried also when the formula's
  // check is undecided: the chase knows graphical constraints better (a
  // frequency that is broken needs no cases).
  let graphical = null
  const g = !t.deontic && !errors.length && status !== 'lost' ? asGraphical(t.rule) : null
  if (g) {
    try {
      const gc = { ...mkConstraint(g.constraintType, 0, 0), id: '__carried', schemaId, name: '', ...graphicalFields(g) }
      const state3 = { ...state, constraints: [...state.constraints, gc] }
      const gen = accountingSteps(state3, mapping, { onlyKeys: new Set([x.key]) })
      let r
      do r = gen.next(); while (!r.done)
      const y = r.value.sides[side].find(e => e.key === x.key)
      if (['native', 'implied'].includes(y?.status)) { graphical = g; if (!['native', 'implied'].includes(status)) { status = y.status; reason = y.reason } }
    } catch { graphical = null }
  }
  const vc = graphical?.constraintType === 'valueComparison' ? { sequence: graphical.sequences[0], query: graphical.queries[0], operator: graphical.operator } : null
  return { schemaId, rule: t.rule, deontic: t.deontic, graphical, vc, entry, ctx, errors, status, reason }
}

export { SIDES }
