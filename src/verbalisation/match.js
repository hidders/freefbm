// Pattern matching over formula trees (see src/logic/formula.js).
//
// A pattern is plain data, so that a parser for a rule syntax can produce the
// same objects later:
//   '_'          matches anything and binds nothing
//   '?x'         a metavariable: binds the value, or, when already bound,
//                matches only the same value (variables by identity)
//   '?xs*'       as the last element of a list pattern, binds the rest of the
//                list (zero or more elements)
//   [p₁, …]      a list of exactly these elements (or more, with a ?xs* tail)
//   { k: p, … }  an object whose fields match; fields are matched in order,
//                so a quantifier's vars are bound before its body is matched
//   { $fact: '?P', has: ['?x', …], rest: '?ws*' }
//                a fact atom over fact type ?P whose arguments include the
//                (already bound) variables in has, in any role. Without rest
//                no other arguments are allowed; with rest the others are
//                bound as a list.
//   other values match by ===.
//
// match returns the extended bindings object, or null.

export function match(p, x, b = {}) {
  if (p === '_') return b
  if (typeof p === 'string' && p.startsWith('?')) {
    if (Object.prototype.hasOwnProperty.call(b, p)) return same(b[p], x) ? b : null
    return { ...b, [p]: x }
  }
  if (Array.isArray(p)) return matchList(p, x, b)
  if (p && typeof p === 'object') {
    if (p.$fact) return matchFact(p, x, b)
    if (!x || typeof x !== 'object') return null
    for (const k of Object.keys(p)) {
      b = match(p[k], x[k], b)
      if (!b) return null
    }
    return b
  }
  return p === x ? b : null
}

const isTail = (p) => typeof p === 'string' && p.startsWith('?') && p.endsWith('*')

function same(a, b) {
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v, i) => v === b[i])
  return a === b
}

function matchList(p, xs, b) {
  if (!Array.isArray(xs)) return null
  const tail = p.length && isTail(p[p.length - 1]) ? p[p.length - 1] : null
  const fixed = tail ? p.slice(0, -1) : p
  if (tail ? xs.length < fixed.length : xs.length !== fixed.length) return null
  for (let i = 0; i < fixed.length; i++) {
    b = match(fixed[i], xs[i], b)
    if (!b) return null
  }
  return tail ? match(tail, xs.slice(fixed.length), b) : b
}

function matchFact(p, x, b) {
  if (x?.t !== 'fact') return null
  b = match(p.$fact, x.factId, b)
  if (!b) return null
  const left = [...x.args]
  for (const m of p.has ?? []) {
    const v = b[m]
    const i = v === undefined ? -1 : left.indexOf(v)
    if (i < 0) return null
    left.splice(i, 1)
  }
  if (p.rest) return match(p.rest, left, b)
  return left.length ? null : b
}

// Pattern builders, so rules read like the formula constructors.
export const P = {
  forall: (vars, body) => ({ t: 'forall', vars, body }),
  exists: (vars, body) => ({ t: 'exists', vars, body }),
  count:  (op, n, vars, body) => ({ t: 'count', op, n, vars, body }),
  not:    (arg) => ({ t: 'not', arg }),
  and:    (args) => ({ t: 'and', args }),
  or:     (args) => ({ t: 'or', args }),
  implies: (left, right) => ({ t: 'implies', left, right }),
  iff:    (left, right) => ({ t: 'iff', left, right }),
  type:   (typeId, arg) => ({ t: 'type', typeId, arg }),
  cmp:    (op, left, right) => ({ t: 'cmp', op, left, right }),
  vcmp:   (op, left, right) => ({ t: 'vcmp', op, left, right }),
  fact:   (factId, has, rest) => ({ $fact: factId, has, ...(rest ? { rest } : {}) }),
  tc:     (vars, body, args) => ({ t: 'tc', vars, body, args }),
  node:   (t) => ({ t }),
}

// Structural equality of two formulas up to renaming of bound variables.
// Constraint formulas build each occurrence of a query afresh, so two copies
// of the same subformula have different bound variable objects.
export function alphaEq(a, b, map = new Map()) {
  if (a === b) return true
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return a === b
  if (Array.isArray(a)) return Array.isArray(b) && a.length === b.length && a.every((x, i) => alphaEq(x, b[i], map))
  if (isVar(a) || isVar(b)) return isVar(a) && isVar(b) && map.get(a) === b
  if (a.t !== b.t) return false
  if (a.t === 'wild') return a.typeId === b.typeId
  let m = map
  if (Array.isArray(a.vars)) {
    if (!Array.isArray(b.vars) || a.vars.length !== b.vars.length) return false
    m = new Map(map)
    a.vars.forEach((v, i) => m.set(v, b.vars[i]))
  }
  const keys = new Set([...Object.keys(a), ...Object.keys(b)])
  keys.delete('vars')
  for (const k of keys) if (!alphaEq(a[k], b[k], m)) return false
  return true
}

// Variables are the only objects in a formula without a t field.
export const isVar = (x) => !!x && typeof x === 'object' && !Array.isArray(x) && !('t' in x) && 'typeId' in x
