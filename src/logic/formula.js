// Formula syntax trees for the ORM2 logic (docs/logic/agg-logic.tex).
//
// Formulas are plain objects so they can be rendered as a string now and as an
// indented, nested structure later. Variables are objects compared by
// identity; their display names (Person, Person₁, …) are only assigned when a
// formula is rendered.
//
//   { t: 'forall' | 'exists', vars: [Var], body }
//   { t: 'count', op: '≤' | '≥' | '=', n, vars: [Var], body }   counting quantifier ∃^{op n}
//   { t: 'count', op: '..', n, m, vars: [Var], body }           range quantifier ∃^{n..m}:
//       at least n and at most m tuples of vars satisfy body
//   { t: 'and' | 'or', args: [F] }
//   { t: 'implies' | 'iff', left, right }
//   { t: 'not', arg }
//   { t: 'possible', arg }                ◇X, X can hold: only in the default verbalisations of
//       missing constraints (constraintFormulas.js possibleEntries)
//   { t: 'true' }                            ⊤, the formula that always holds
//   { t: 'fact', factId, args: [Var] }      fact type atom, args in roles[] order
//   { t: 'type', typeId, arg: Var }          object type membership, e.g. Student(Person)
//   { t: 'cmp', op, left: Var, right: Var }  object equality =, ≠
//   { t: 'vcmp', op, left: Term, right: Term }
//       value comparison ≈, ≉, <, ≤, >, ≥ on data values. The left side is
//       never a constant; the datatype of the other side says how a constant
//       is read and compared.
//   { t: 'dpred', op, args: [Term] }         data predicate (dataOperators.js PREDS)
//
// Data terms: a Var (its data value), or
//   { t: 'const', text, quoted }             the string representation of a value
//   { t: 'fn', op, args: [Term] }            data operator (dataOperators.js OPS)
//   { t: 'ite', cond: F, then: Term, else: Term }   if cond then … else …
//   { t: 'agg', fn, distinct, vars: [Var], cond: F, term: Term | null }
//       aggregate F{t | v₁, …, vₙ : φ} (dataOperators.js AGGS); binds vars in
//       cond and term; count has no term: Count{v₁, …, vₙ : φ}
//   { t: 'tc', star, vars: [Var, Var], body, args: [Var, Var] }
//       transitive closure [TC_{v,w} φ](s, t), or with star the
//       reflexive-transitive closure [TC*_{v,w} φ](s, t); binds vars in body only

// A variable ranges over the population of its type (an object type id, or
// the id of an objectified fact type).
export const mkVar = (typeId) => ({ typeId })
// A variable over the intersection of several types (the direct supertypes of
// a derived subtype); typeId is the first of them.
export const mkMeetVar = (typeIds) => (typeIds.length > 1 ? { typeId: typeIds[0], typeIds } : mkVar(typeIds[0]))

export const forall = (vars, body) => vars.length ? { t: 'forall', vars, body } : body
export const exists = (vars, body) => vars.length ? { t: 'exists', vars, body } : body
export const count  = (op, n, vars, body) => ({ t: 'count', op, n, vars, body })
export const countRange = (n, m, vars, body) => ({ t: 'count', op: '..', n, m, vars, body })
export const not    = (arg) => ({ t: 'not', arg })
export const truth  = () => ({ t: 'true' })
export const implies = (left, right) => ({ t: 'implies', left, right })
export const iff     = (left, right) => ({ t: 'iff', left, right })
export const factAtom = (factId, args) => ({ t: 'fact', factId, args })
export const typeAtom = (typeId, arg) => ({ t: 'type', typeId, arg })
export const cmp = (op, left, right) => ({ t: 'cmp', op, left, right })
export const vcmp = (op, left, right) => ({ t: 'vcmp', op, left, right })
export const dpred = (op, args) => ({ t: 'dpred', op, args })
export const constant = (text, quoted = true) => ({ t: 'const', text, quoted })
export const fn = (op, args) => ({ t: 'fn', op, args })
export const ite = (cond, then, otherwise) => ({ t: 'ite', cond, then, else: otherwise })
export const agg = (fn, distinct, vars, cond, term) => ({ t: 'agg', fn, distinct, vars, cond, term })
export const tc  = (vars, body, args, star = false) => ({ t: 'tc', star, vars, body, args })

function nary(t, args) {
  const flat = []
  for (const a of args) {
    if (!a) continue
    if (a.t === t) flat.push(...a.args)
    else flat.push(a)
  }
  if (flat.length === 0) return null
  if (flat.length === 1) return flat[0]
  return { t, args: flat }
}
export const and = (...args) => nary('and', args.flat())
export const or  = (...args) => nary('or',  args.flat())
