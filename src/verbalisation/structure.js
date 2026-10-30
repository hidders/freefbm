// Language-independent structural tests on formulas, for the guards and
// templates of every language's rules.

import { alphaEq, isVar } from './match.js'

export const occurs = (f, v) => f === v || (!!f && typeof f === 'object' && !isVar(f) &&
  Object.entries(f).some(([k, x]) => k !== 'vars' && occurs(x, v)))

// The value range ∀x (x ≈ c ∨ (x ≥ a ∧ x ≤ b) ∨ …) as its items
// [{ op: '≈' | '≥' | '≤' | '>' | '<', value } | { op: '..', lo, hi, loOp, hiOp }],
// or null. An interval's loOp is ≥ or > and its hiOp ≤ or <.
export function rangeSpec(body, x) {
  const isConst = (t) => t?.t === 'const'
  const item = (f) => {
    if (f.t === 'vcmp' && f.left === x && isConst(f.right) && ['≈', '≥', '≤', '>', '<'].includes(f.op)) return { op: f.op, value: f.right }
    if (f.t === 'and' && f.args.length === 2) {
      // An interval; > and < are its open (exclusive) bounds.
      const [a, b] = f.args
      if (a.t === 'vcmp' && b.t === 'vcmp' && a.left === x && b.left === x && (a.op === '≥' || a.op === '>') &&
          (b.op === '≤' || b.op === '<') && isConst(a.right) && isConst(b.right))
        return { op: '..', lo: a.right, hi: b.right, loOp: a.op, hiOp: b.op }
    }
    return null
  }
  const items = (body.t === 'or' ? body.args : [body]).map(item)
  return items.every(Boolean) ? items : null
}
// The members of "at most one of the following holds": ¬(A ∧ B ∧ …), or
// ¬(Aᵢ ∧ Aⱼ) for every pair of some A₁ … Aₙ (n ≥ 3); else null.
export function exclusionItems(f) {
  if (f.t === 'not' && f.arg.t === 'and') return f.arg.args
  if (f.t !== 'and' || !f.args.every(a => a.t === 'not' && a.arg.t === 'and' && a.arg.args.length === 2)) return null
  const items = []
  const indexOf = (g) => {
    const i = items.findIndex(x => alphaEq(x, g))
    if (i >= 0) return i
    items.push(g)
    return items.length - 1
  }
  const pairs = new Set(f.args.map(a => a.arg.args.map(indexOf).sort().join(',')))
  const k = items.length
  if (k < 3 || pairs.size !== f.args.length || pairs.size !== k * (k - 1) / 2) return null
  return items
}

// (A₁ ∨ … ∨ Aₙ) ∧ "at most one of A₁ … Aₙ": the items, or null.
export function exclusiveOrItems(f) {
  if (f.t !== 'and' || f.args[0]?.t !== 'or') return null
  const alts = f.args[0].args
  const rest = f.args.slice(1)
  const excl = rest.length === 1 ? exclusionItems(rest[0]) : exclusionItems({ t: 'and', args: rest })
  if (!excl || excl.length !== alts.length) return null
  return excl.every(e => alts.some(a => alphaEq(a, e))) ? alts : null
}

// A is the fact atom B with the variables ys replaced by wildcards, so that
// ∀x (A → ∃^{≤n} ys B) says the same as ∀x ∃^{≤n} ys B.
export function sameUpToWild(a, b, ys) {
  if (a?.t !== 'fact' || b?.t !== 'fact' || a.factId !== b.factId) return false
  return b.args.every((y, i) => (ys.includes(y) ? a.args[i]?.t === 'wild' : a.args[i] === y))
}

// ∃^{=1} y₁ … yₙ (R₁(x, y₁) ∧ … ∧ Rₙ(x, yₙ)), each Rᵢ a fact atom over x and
// yᵢ only: the number of combinations is the product of the counts, so it
// holds exactly when each Rᵢ has exactly one yᵢ.
export function distributable(ys, args, x) {
  if (ys.length < 2 || args.length !== ys.length) return false
  return ys.every(y => {
    const own = args.filter(a => occurs(a, y))
    return own.length === 1 && own[0].t === 'fact' && own[0].args.length === 2 &&
      own[0].args.includes(x) && own[0].args.includes(y)
  })
}

export const isComplex = (f) => ['and', 'or', 'implies', 'iff'].includes(f.t)


export const isSingular = (op, n) => op !== '..' && n === 1

// The variable an atom is about, when it can be the subject of a verb phrase.
export function subjectOf(f) {
  switch (f?.t) {
    case 'type': return f.arg
    case 'vcmp': case 'cmp': return isVar(f.left) ? f.left : null
    case 'dpred': return isVar(f.args[0]) ? f.args[0] : null
    case 'tc': return isVar(f.args[0]) ? f.args[0] : null
    default: return null
  }
}
