// A formalised constraint (formula.js syntax trees, variables as objects
// with a typeId) as a rule tree (derivationRule.js format, variables with
// ids), so it can be evaluated (closedFormula), rewritten like mapping rules
// or kept as a formula constraint. Throws on parts with no rule form.

export function formulaToRule(f) {
  const ids = new Map()
  const vid = (x) => { if (!x) return null; if (!ids.has(x)) ids.set(x, `c${ids.size + 1}`); return ids.get(x) }
  const decl = (x) => ({ id: vid(x), typeId: x.typeId })
  const term = (t) => {
    if (t && !t.t && t.typeId) return { t: 'var', id: vid(t) }
    switch (t?.t) {
      case 'const': return { t: 'const', text: t.text }
      case 'fn': return { t: 'op', op: t.op, args: t.args.map(term) }
      case 'ite': return { t: 'if', cond: go(t.cond), then: term(t.then), else: term(t.else) }
      case 'agg': return { t: 'agg', fn: t.fn, distinct: t.distinct, vars: t.vars.map(decl), cond: go(t.cond), term: term(t.term) }
    }
    throw new Error('a term that has no rule form')
  }
  const go = (g) => {
    switch (g.t) {
      case 'true': return { t: 'true' }
      case 'not': return { t: 'not', arg: go(g.arg) }
      case 'and': case 'or': return { t: g.t, args: g.args.map(go) }
      case 'implies': case 'iff': return { t: g.t, left: go(g.left), right: go(g.right) }
      case 'forall': case 'exists': { const vs = g.vars.map(decl); return vs.reduceRight((b, v) => ({ t: g.t, v, body: b }), go(g.body)) }
      case 'count': {
        if (g.vars.length !== 1) return countOfSeveral(g)
        const v = decl(g.vars[0])
        return g.op === '..' ? { t: 'count', op: '..', n: g.n, m: g.m, v, body: go(g.body) } : { t: 'count', op: g.op, n: g.n, v, body: go(g.body) }
      }
      case 'tc': return { t: 'tc', star: !!g.star, vars: g.vars.map(decl), body: go(g.body), args: g.args.map(vid) }
      case 'fact': return { t: 'fact', factId: g.factId, args: g.args.map(vid) }
      case 'type': return { t: 'type', typeId: g.typeId, arg: vid(g.arg) }
      case 'cmp': return { t: 'cmp', op: g.op, left: vid(g.left), right: vid(g.right) }
      case 'vcmp': return { t: 'vcmp', op: g.op, left: term(g.left), right: term(g.right) }
      case 'dpred': return { t: 'dpred', op: g.op, args: g.args.map(term) }
    }
    throw new Error(`a ${g.t} part`)
  }
  // A count of several variables ȳ (an external preferred identifier's
  // "exactly one combination"), for bounds 0 and 1: at least one is ∃ȳ φ,
  // at most one is ¬∃ȳ ȳ' (φ ∧ φ' ∧ ȳ ≠ ȳ'), φ' a copy of φ over ȳ'.
  const countOfSeveral = (g) => {
    const atLeastOne = () => { const vs = g.vars.map(decl); return vs.reduceRight((b, v) => ({ t: 'exists', v, body: b }), go(g.body)) }
    const atMostOne = () => {
      const vs = g.vars.map(decl), b1 = go(g.body)
      const saved = g.vars.map(x => ids.get(x))
      g.vars.forEach(x => ids.set(x, `c${ids.size + 1}`))
      const ws = g.vars.map(decl), b2 = go(g.body)
      g.vars.forEach((x, i) => ids.set(x, saved[i]))
      const differ = { t: 'or', args: vs.map((v, i) => ({ t: 'cmp', op: '≠', left: v.id, right: ws[i].id })) }
      const body = [...vs, ...ws].reduceRight((b, v) => ({ t: 'exists', v, body: b }), { t: 'and', args: [b1, b2, differ] })
      return { t: 'not', arg: body }
    }
    const { op, n } = g
    if (op === '≥' && n === 1) return atLeastOne()
    if ((op === '≤' && n === 0) || (op === '<' && n === 1)) return { t: 'not', arg: atLeastOne() }
    if ((op === '≤' && n === 1) || (op === '<' && n === 2)) return atMostOne()
    if (op === '=' && n === 1) return { t: 'and', args: [atLeastOne(), atMostOne()] }
    if (op === '=' && n === 0) return { t: 'not', arg: atLeastOne() }
    if (op === '>' && n === 0) return atLeastOne()
    throw new Error('a count of several variables')
  }
  return go(f)
}
