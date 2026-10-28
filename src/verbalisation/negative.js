// Negative verbalisation, as in NORMA: a constraint is said as the situation
// it rules out ("It is impossible that some Person has more than one
// PersonName") instead of what must hold ("Each Person has at most one
// PersonName").
//
// The mode is a formula rewrite. φ is turned into ¬X, where X is the
// counterexample: ¬φ with the negation pushed inward, so ∀ becomes ∃, ∃^{≤n}
// becomes ∃^{>n}, ∧ and ∨ swap, A → B becomes A ∧ ¬B and value comparisons
// flip. A negated ∃ stays negated, read as "no". The result is
// { t: 'not', mode: 'impossible', arg: X }, which each language's sentence
// rule 'impossible' reads as "it is impossible that X".
//
// Some formulas have no useful counterexample: a derivation rule (↔) would
// only become "it is not true that … if and only if …". Then the rewrite
// gives null and the positive sentence is used, as NORMA does.

import { isVar, alphaEq } from './match.js'

export function negativeForm(f) {
  const x = counterexample(f)
  return x ? { t: 'not', mode: 'impossible', arg: x } : null
}

// X with φ ≡ ¬X, or null.
export function counterexample(f) {
  return neg(f)
}

const FLIP = { '≈': '≉', '≉': '≈', '<': '≥', '≥': '<', '>': '≤', '≤': '>', '=': '≠', '≠': '=' }

function neg(f) {
  if (!f || typeof f !== 'object' || isVar(f)) return null
  switch (f.t) {
    case 'forall': {
      const body = neg(f.body)
      return body && { t: 'exists', vars: f.vars, body }
    }
    case 'count': {
      // ∃^{>n}, "more than n", is used only here, for NORMA's "more than one".
      if (f.op === '≤') return f.n <= 0 ? { t: 'exists', vars: f.vars, body: f.body } : { ...f, op: '>' }
      if (f.op === '≥' && f.n >= 2) return { ...f, op: '≤', n: f.n - 1 }
      if (f.op === '≥') return f.n <= 0 ? null : none(f)
      // Exactly n, or n to m: fewer or more. "has no PersonNr or has more
      // than one PersonNr".
      // Not for combinations: "no combination of Building and RoomNr" would
      // become "not both … and …" (the wildcard rewrite splits it).
      if (f.vars.length > 1) return not(f)
      const lo = f.n, hi = f.op === '..' ? f.m : f.n
      const fewer = lo <= 0 ? null : lo === 1 ? none(f) : { ...f, op: '≤', n: lo - 1, m: undefined }
      const more = { ...f, op: '>', n: hi, m: undefined }
      return fewer ? { t: 'or', args: [fewer, more] } : more
    }
    case 'and':
    case 'or': {
      const args = f.args.map(neg)
      return args.every(Boolean) ? { t: f.t === 'and' ? 'or' : 'and', args: flatten(f.t === 'and' ? 'or' : 'and', args) } : null
    }
    case 'implies': {
      const right = neg(f.right)
      if (!right) return null
      // ∃ys R ∧ ∃^{>n} ys R is just ∃^{>n} ys R (a frequency constraint).
      if (right.t === 'count' && right.op === '>' && alphaEq(f.left, { t: 'exists', vars: right.vars, body: right.body })) return right
      return { t: 'and', args: flatten('and', [f.left, right]) }
    }
    case 'not': return f.arg
    case 'cmp':
    case 'vcmp': return FLIP[f.op] ? { ...f, op: FLIP[f.op] } : not(f)
    case 'iff':
    case 'true':
    case 'possible': return null
    default: return not(f)
  }
}

const not = (arg) => ({ t: 'not', arg })
const none = (q) => not({ t: 'exists', vars: q.vars, body: q.body })
const flatten = (t, args) => args.flatMap(a => (a.t === t ? a.args : [a]))
