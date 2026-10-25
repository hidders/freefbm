// Formula syntax trees for the ORM2 logic (docs/logic/agg-logic.tex).
//
// Formulas are plain objects so they can be rendered as a string now and as an
// indented, nested structure later. Variables are objects compared by
// identity; their display names (Person, Person₁, …) are only assigned when a
// formula is rendered.
//
//   { t: 'forall' | 'exists', vars: [Var], body }
//   { t: 'count', op: '≤' | '≥' | '=', n, vars: [Var], body }   counting quantifier ∃^{op n}
//   { t: 'and' | 'or', args: [F] }
//   { t: 'implies' | 'iff', left, right }
//   { t: 'not', arg }
//   { t: 'true' }                            ⊤, the formula that always holds
//   { t: 'fact', factId, args: [Var] }      fact type atom, args in roles[] order
//   { t: 'type', typeId, arg: Var }          object type membership, e.g. Student(Person)
//   { t: 'cmp', op, left: Var, right: Var }  object equality =, ≠
//   { t: 'vcmp', op, left: Var, right: Var | Const }
//       value comparison ≈, ≉, <, ≤, >, ≥ on the data values of the
//       objects. The left side is always a variable, whose datatype says how
//       the constant on the right is read and compared.
//   { t: 'const', text, quoted }             the string representation of a value
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
export const not    = (arg) => ({ t: 'not', arg })
export const truth  = () => ({ t: 'true' })
export const implies = (left, right) => ({ t: 'implies', left, right })
export const iff     = (left, right) => ({ t: 'iff', left, right })
export const factAtom = (factId, args) => ({ t: 'fact', factId, args })
export const typeAtom = (typeId, arg) => ({ t: 'type', typeId, arg })
export const cmp = (op, left, right) => ({ t: 'cmp', op, left, right })
export const vcmp = (op, left, right) => ({ t: 'vcmp', op, left, right })
export const constant = (text, quoted = true) => ({ t: 'const', text, quoted })
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
