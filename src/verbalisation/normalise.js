// Language-independent rewriting of a formula before it is verbalised.
//
// The wildcard rewrite: a variable bound by ∃ that occurs exactly once, as an
// argument of a fact atom reached from the ∃ through conjunctions only, is
// replaced by a wildcard { t: 'wild', typeId, v }, read as "some T" at that
// place. ∃y (A ∧ R(x, y)) becomes A ∧ R(x, _), which is equivalent because y
// occurs nowhere else. Disjunctions are not crossed: with an empty population
// ∃y (A ∨ R(y)) is false while A ∨ ∃y R(y) need not be.
//
// The formula is copied; its variable objects are shared with the original,
// so names given to them by renderFormula still apply.

import { isVar } from './match.js'

export function normalise(f) {
  return rewrite(f)
}

function rewrite(f) {
  if (!f || typeof f !== 'object' || isVar(f)) return f
  if (Array.isArray(f)) return f.map(rewrite)
  const out = {}
  for (const [k, v] of Object.entries(f)) out[k] = k === 'vars' ? v : rewrite(v)
  if (out.t !== 'exists') return out
  const keep = []
  let body = out.body
  for (const y of out.vars) {
    const site = singleSite(body, y)
    if (site) body = replaceAt(body, site, { t: 'wild', typeId: y.typeId, ...(y.typeIds ? { typeIds: y.typeIds } : {}), v: y })
    else keep.push(y)
  }
  return keep.length ? { ...out, vars: keep, body } : body
}

// The path to y's only occurrence when it is a fact atom argument reached
// through 'and' (and 'exists') nodes only, else null.
function singleSite(body, y) {
  if (occurrences(body, y) !== 1) return null
  const walk = (f, path) => {
    if (f?.t === 'fact') {
      const i = f.args.indexOf(y)
      return i >= 0 ? [...path, 'args', i] : null
    }
    if (f?.t === 'and') {
      for (let i = 0; i < f.args.length; i++) {
        const p = walk(f.args[i], [...path, 'args', i])
        if (p) return p
      }
    }
    if (f?.t === 'exists') return walk(f.body, [...path, 'body'])
    return null
  }
  return walk(body, [])
}

function occurrences(f, y) {
  if (f === y) return 1
  if (!f || typeof f !== 'object' || isVar(f)) return 0
  if (Array.isArray(f)) return f.reduce((n, x) => n + occurrences(x, y), 0)
  let n = 0
  for (const [k, v] of Object.entries(f)) if (k !== 'vars' && k !== 'v') n += occurrences(v, y)
  return n
}

function replaceAt(f, path, value) {
  if (!path.length) return value
  const [k, ...rest] = path
  const copy = Array.isArray(f) ? [...f] : { ...f }
  copy[k] = replaceAt(f[k], rest, value)
  return copy
}
