// Renders a formula tree (see formula.js) as a flat list of styled tokens:
//   { text, cls }   cls: 'var' | 'reading' | 'type' | 'op' | 'punct'
//   { text, cls: 'op', sup: true }   the bound of a counting quantifier, or TC's *
//   { text, cls, sub: true }         the variables bound by TC
//
// Variables are named after their type. A subscript is added only when two
// variables of the same type can be in scope at once somewhere in the
// formula; otherwise the bare type name is used, as in (Person lives in Country).

const SUBSCRIPTS = '₀₁₂₃₄₅₆₇₈₉'
const subscript = (n) => String(n).split('').map(d => SUBSCRIPTS[d]).join('')

const QUANTIFIERS = new Set(['forall', 'exists', 'count'])
const BINDERS = new Set([...QUANTIFIERS, 'tc'])
// Rendered without parentheses as the body of a quantifier or after ¬.
const ATOMIC = new Set(['fact', 'type', 'not', 'tc'])
const BINARY = new Set(['and', 'or', 'implies', 'iff'])
const OP = { and: ' ∧ ', or: ' ∨ ', implies: ' → ', iff: ' ↔ ' }

function boundVars(f) {
  return BINDERS.has(f.t) ? f.vars : []
}

function children(f) {
  switch (f.t) {
    case 'forall': case 'exists': case 'count': case 'tc': return [f.body]
    case 'and': case 'or': return f.args
    case 'implies': case 'iff': return [f.left, f.right]
    case 'not': return [f.arg]
    default: return []
  }
}

// For each type name, the largest number of distinct variables of that type
// that are in scope at the same time.
function maxInScope(f, baseOf, scope = new Map(), max = new Map()) {
  const added = []
  for (const v of boundVars(f)) {
    const b = baseOf(v)
    scope.set(b, (scope.get(b) ?? 0) + 1)
    max.set(b, Math.max(max.get(b) ?? 0, scope.get(b)))
    added.push(b)
  }
  for (const c of children(f)) maxInScope(c, baseOf, scope, max)
  for (const b of added) scope.set(b, scope.get(b) - 1)
  return max
}

export function renderFormula(formula, ctx) {
  const baseOf = (v) => ctx.typeName(v.typeId)
  const max = maxInScope(formula, baseOf)
  const names = new Map()       // var → current display name
  const inScope = []            // [{ v, base, index }]
  const out = []
  const push = (text, cls = 'punct', extra) => out.push({ text, cls, ...extra })

  const nameOf = (v) => {
    if (!names.has(v)) bind(v)   // free variable: name it on first use
    return names.get(v)
  }
  const bind = (v) => {
    const base = baseOf(v)
    let index = 1
    while (inScope.some(s => s.base === base && s.index === index)) index++
    inScope.push({ v, base, index })
    names.set(v, (max.get(base) ?? 1) > 1 ? base + subscript(index) : base)
  }
  const unbind = (n) => { inScope.splice(inScope.length - n, n) }

  const pushVar = (v) => push(nameOf(v), 'var')

  const wrapped = (f) => { push('('); render(f); push(')') }

  const render = (f) => {
    switch (f.t) {
      case 'fact': {
        const fact = ctx.factById.get(f.factId)
        const parts = fact?.readingParts ?? []
        push('(')
        const words = []
        f.args.forEach((v, i) => {
          if (parts[i]?.trim()) words.push(() => push(parts[i].trim(), 'reading'))
          words.push(() => pushVar(v))
        })
        if (parts[f.args.length]?.trim()) words.push(() => push(parts[f.args.length].trim(), 'reading'))
        words.forEach((w, i) => { if (i) push(' '); w() })
        push(')')
        return
      }
      case 'type':
        push(ctx.typeName(f.typeId), 'type'); push('('); pushVar(f.arg); push(')')
        return
      case 'cmp':
        pushVar(f.left); push(` ${f.op} `, 'op'); pushVar(f.right)
        return
      case 'not':
        push('¬', 'op')
        if (ATOMIC.has(f.arg.t)) render(f.arg)
        else wrapped(f.arg)
        return
      case 'and': case 'or':
        f.args.forEach((a, i) => {
          if (i) push(OP[f.t], 'op')
          if (BINARY.has(a.t) || (QUANTIFIERS.has(a.t) && i < f.args.length - 1)) wrapped(a)
          else render(a)
        })
        return
      case 'implies': case 'iff':
        if (BINARY.has(f.left.t) || QUANTIFIERS.has(f.left.t)) wrapped(f.left); else render(f.left)
        push(OP[f.t], 'op')
        if (BINARY.has(f.right.t)) wrapped(f.right); else render(f.right)
        return
      case 'forall': case 'exists': case 'count': {
        if (f.t === 'count') {
          push('∃', 'op'); push(`${f.op}${f.n}`, 'op', { sup: true }); push(' ')
          f.vars.forEach((v, i) => { if (i) push(', '); bind(v); pushVar(v) })
        } else {
          f.vars.forEach((v, i) => { if (i) push(' '); push(f.t === 'forall' ? '∀' : '∃', 'op'); bind(v); pushVar(v) })
        }
        push(' ')
        const b = f.body
        if (ATOMIC.has(b.t) || QUANTIFIERS.has(b.t)) render(b)
        else wrapped(b)
        unbind(f.vars.length)
        return
      }
      case 'tc': {
        // [TC_{v,w} φ](s, t): v and w are bound inside the brackets only.
        push('['); push('TC', 'op')
        if (f.star) push('*', 'op', { sup: true })
        f.vars.forEach((v, i) => { if (i) push(',', 'punct', { sub: true }); bind(v); push(nameOf(v), 'var', { sub: true }) })
        push(' ')
        const b = f.body
        if (ATOMIC.has(b.t) || QUANTIFIERS.has(b.t)) render(b)
        else wrapped(b)
        unbind(f.vars.length)
        push(']('); pushVar(f.args[0]); push(', '); pushVar(f.args[1]); push(')')
        return
      }
      default:
        push('?')
    }
  }

  render(formula)
  return out
}

export function formulaToString(formula, ctx) {
  const tokens = renderFormula(formula, ctx)
  let s = ''
  tokens.forEach((t, i) => {
    if (t.sup) s += `^{${t.text}}`
    else if (t.sub) {
      if (!tokens[i - 1]?.sub) s += '_{'
      s += t.text
      if (!tokens[i + 1]?.sub) s += '}'
    } else s += t.text
  })
  return s
}
