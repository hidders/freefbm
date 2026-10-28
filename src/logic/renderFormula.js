// Renders a formula tree (see formula.js) as a flat list of styled tokens:
//   { text, cls }   cls: 'var' | 'reading' | 'type' | 'op' | 'fn' | 'const' | 'punct'
//                   ('fn': data operators and predicates)
//   { text, cls: 'op', sup: true }   the bound of a counting quantifier (≤n, ≥n, =n or n..m), or TC's *
//   { text, cls, sub: true }         the variables bound by TC, an aggregate's 'distinct'
//   { text: QGAP, cls: 'qgap' }      the narrow gap between a quantifier and its variable
//
// Variables are named after their type. A subscript is added only when two
// variables of the same type can be in scope at once somewhere in the
// formula; otherwise the bare type name is used, as in (Person lives in Country).
// renderFormula takes an optional names map that it fills with each variable's
// display name, so an editor can label the variables the same way.

import { OPS, PREDS, AGGS } from './dataOperators.js'

const SUBSCRIPTS = '₀₁₂₃₄₅₆₇₈₉'
const subscript = (n) => String(n).split('').map(d => SUBSCRIPTS[d]).join('')

// Thin space: copies as a narrow space, and is drawn narrower than a full
// monospace cell (see TOKEN_STYLE.qgap in ConstraintsTab.jsx).
export const QGAP = '\u2009'

const QUANTIFIERS = new Set(['forall', 'exists', 'count'])
const BINDERS = new Set([...QUANTIFIERS, 'tc', 'agg'])
// Rendered without parentheses as the body of a quantifier or after ¬.
const ATOMIC = new Set(['fact', 'type', 'true', 'not', 'tc', 'dpred'])
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
    case 'not': case 'possible': return [f.arg]
    case 'vcmp': return [...termConds(f.left), ...termConds(f.right)]
    case 'dpred': return f.args.flatMap(termConds)
    case 'agg': return [f.cond, ...termConds(f.term)]
    default: return []
  }
}

// The conditions of the if-terms in a data term (formulas with their own
// quantifiers), and its aggregates (which bind variables).
function termConds(x) {
  switch (x?.t) {
    case 'fn': return x.args.flatMap(termConds)
    case 'ite': return [x.cond, ...termConds(x.then), ...termConds(x.else)]
    case 'agg': return [x]
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

export function renderFormula(formula, ctx, names = new Map()) {
  // A variable over the intersection of several types is named after all of
  // them, joined by &: Student&Employee.
  const baseOf = (v) => v.typeIds?.length > 1 ? v.typeIds.map(ctx.typeName).join('&') : ctx.typeName(v.typeId)
  const max = maxInScope(formula, baseOf)
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

  // A data term. Infix operators get parentheses inside a tighter operator,
  // and on the right of an equally tight one unless it is the same
  // associative operator.
  const renderTerm = (x, parent = null, right = false) => {
    switch (x?.t) {
      case undefined:
        pushVar(x)
        return
      case 'const':
        push(x.quoted ? `'${x.text.replace(/['\\]/g, '\\$&')}'` : x.text, 'const')
        return
      case 'fn': {
        const def = OPS[x.op]
        if (!def) { push('?'); return }
        if (def.style === 'infix') {
          const p = parent?.style === 'prefix' ? 3 : parent?.style === 'infix' ? parent.prec : 0
          const paren = def.prec < p || (def.prec === p && right && !(parent === def && def.assoc))
          if (paren) push('(')
          renderTerm(x.args[0], def, false)
          push(` ${def.symbol} `, 'fn')
          renderTerm(x.args[1], def, true)
          if (paren) push(')')
        } else if (def.style === 'prefix') {
          push(def.symbol, 'fn')
          renderTerm(x.args[0], def, true)
        } else renderCall(def, x.args)
        return
      }
      case 'ite':
        push('('); push('if', 'op'); push(' ')
        if (BINARY.has(x.cond.t) || QUANTIFIERS.has(x.cond.t)) wrapped(x.cond); else render(x.cond)
        push(' then ', 'op'); renderTerm(x.then)
        push(' else ', 'op'); renderTerm(x.else)
        push(')')
        return
      case 'agg': {
        // Sum{t | v₁, v₂ : φ}, Sum_distinct{…}, Count{v₁, v₂ : φ}
        push(AGGS[x.fn]?.symbol ?? '?', 'fn')
        if (x.distinct) push('distinct', 'fn', { sub: true })
        push('{')
        x.vars.forEach(bind)
        if (x.term) { renderTerm(x.term); push(' | ') }
        x.vars.forEach((v, i) => { if (i) push(', '); pushVar(v) })
        push(' : ')
        render(x.cond)
        push('}')
        unbind(x.vars.length)
        return
      }
      default:
        push('?')
    }
  }
  const renderCall = (def, args) => {
    push(def.symbol, 'fn'); push('(')
    args.forEach((a, i) => { if (i) push(', '); renderTerm(a) })
    push(')')
  }

  const render = (f) => {
    switch (f.t) {
      case 'fact': {
        const fact = ctx.factById.get(f.factId) ?? ctx.linkById?.get(f.factId)
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
      case 'true':
        push('⊤', 'op')
        return
      case 'cmp':
        pushVar(f.left); push(` ${f.op} `, 'op'); pushVar(f.right)
        return
      case 'vcmp':
        renderTerm(f.left); push(` ${f.op} `, 'op'); renderTerm(f.right)
        return
      case 'dpred':
        renderCall(PREDS[f.op] ?? { symbol: f.op }, f.args)
        return
      case 'possible':
        // ◇X: X can hold (the default verbalisation of a missing constraint).
        push('◇', 'op')
        if (ATOMIC.has(f.arg.t) || QUANTIFIERS.has(f.arg.t)) render(f.arg)
        else wrapped(f.arg)
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
          push('∃', 'op'); push(f.op === '..' ? `${f.n}..${f.m}` : `${f.op}${f.n}`, 'op', { sup: true }); push(QGAP, 'qgap')
          f.vars.forEach((v, i) => { if (i) push(', '); bind(v); pushVar(v) })
        } else {
          f.vars.forEach((v, i) => { if (i) push(' '); push(f.t === 'forall' ? '∀' : '∃', 'op'); push(QGAP, 'qgap'); bind(v); pushVar(v) })
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
