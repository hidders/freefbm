// CHECK constraints as formula constraints (formula plan, step 2).
//
// A CHECK condition of a table is read as a formula of encoding B: one row
// is an instance t of the table's entity type, and a column c with value v is
// the fact c(t, v). SQL's three-valued logic is kept exactly: a CHECK holds
// unless its condition is FALSE, and a comparison is UNKNOWN when a column it
// reads is NULL. So the constraint is ∀t N(φ), where N(φ) says "φ is not
// false" and U(φ) "φ is not true":
//
//   N(p) = ∀v̄ (c̄(t, v̄) → p(v̄))        U(p) = ∀v̄ (c̄(t, v̄) → ¬p(v̄))
//   N(a AND b) = N(a) ∧ N(b)              U(a AND b) = U(a) ∨ U(b)
//   N(a OR b)  = N(a) ∨ N(b)              U(a OR b)  = U(a) ∧ U(b)
//   N(NOT a)   = U(a)                     U(NOT a)   = N(a)
//   N(c IS NULL) = ¬∃v c(t, v)            U(c IS NULL) = ∃v c(t, v)
//
// for an atomic condition p over the columns c̄ (a comparison, IN, BETWEEN,
// LIKE, a regular expression, or a boolean column). CHECK (start < end) thus
// becomes ∀t ∀v ∀w (start(t, v) ∧ end(t, w) → v < w).
//
// checkToFormula(text, columns, tableTypeId) → { rule } or { error }, where
// columns maps a column name to { factId, vtId } (the fact's roles are
// [table, value type]); the name 'value' stands for the column in a domain's
// CHECK.

import { tokenize } from './ddlParse.js'

class Unsupported extends Error {}
const no = (what) => { throw new Unsupported(what) }

// ── Parsing ──────────────────────────────────────────────────────────────────

const KEYWORDS = new Set(['and', 'or', 'not', 'is', 'null', 'in', 'between', 'like', 'ilike', 'similar', 'true', 'false',
  'any', 'all', 'some', 'array', 'case', 'when', 'then', 'else', 'end', 'select', 'exists', 'distinct', 'from', 'escape'])

const FUNCS = {
  length: 'length', char_length: 'length', character_length: 'length',
  lower: 'lower', upper: 'upper', trim: 'trim', btrim: 'trim',
  abs: 'abs', floor: 'floor', ceil: 'ceiling', ceiling: 'ceiling', sqrt: 'sqrt', power: 'power',
  greatest: 'greatest', least: 'least', mod: 'mod',
}

class Parser {
  constructor(tks) { this.tk = tks; this.i = 0 }
  peek(k = 0) { return this.tk[this.i + k] }
  next() { return this.tk[this.i++] }
  isWord(w, k = 0) { const t = this.peek(k); return t?.t === 'id' && t.v === w }
  isOp(o, k = 0) { const t = this.peek(k); return t?.t === 'op' && t.v === o }
  eatWord(w) { if (this.isWord(w)) { this.i++; return true } return false }
  eatOp(o) { if (this.isOp(o)) { this.i++; return true } return false }
  expectOp(o) { if (!this.eatOp(o)) no(`"${o}" expected`) }
  done() { return this.i >= this.tk.length }

  // Conditions
  or() {
    const args = [this.and()]
    while (this.eatWord('or')) args.push(this.and())
    return args.length === 1 ? args[0] : { k: 'or', args }
  }
  and() {
    const arg = () => { const s0 = this.i; const a = this.not(); return { ...a, span: [s0, this.i] } }
    const args = [arg()]
    while (this.eatWord('and')) args.push(arg())
    return args.length === 1 ? args[0] : { k: 'and', args }
  }
  not() {
    if (this.eatWord('not')) return { k: 'not', arg: this.not() }
    return this.predicate()
  }
  predicate() {
    const l = this.expr()
    if (this.eatWord('is')) {
      const neg = this.eatWord('not')
      if (this.eatWord('null')) return { k: 'isnull', e: l, neg }
      if (this.eatWord('true')) return wrapNeg(neg, { k: 'cmp', op: '=', l, r: { k: 'lit', kind: 'bool', v: 'true' } })
      if (this.eatWord('false')) return wrapNeg(neg, { k: 'cmp', op: '=', l, r: { k: 'lit', kind: 'bool', v: 'false' } })
      no('IS DISTINCT FROM')
    }
    const neg = this.isWord('not') && ['in', 'between', 'like', 'ilike'].some(w => this.isWord(w, 1)) ? (this.next(), true) : false
    if (this.eatWord('in')) {
      this.expectOp('(')
      if (this.isWord('select')) no('a subquery')
      const list = [this.expr()]
      while (this.eatOp(',')) list.push(this.expr())
      this.expectOp(')')
      return wrapNeg(neg, { k: 'in', e: l, list })
    }
    if (this.eatWord('between')) {
      this.eatWord('symmetric') && no('BETWEEN SYMMETRIC')
      const lo = this.expr()
      if (!this.eatWord('and')) no('BETWEEN without AND')
      const hi = this.expr()
      return wrapNeg(neg, { k: 'and', args: [{ k: 'cmp', op: '>=', l, r: lo }, { k: 'cmp', op: '<=', l, r: hi }] })
    }
    if (this.isWord('like') || this.isWord('ilike')) {
      const ci = this.next().v === 'ilike'
      const pat = this.expr()
      if (this.isWord('escape')) no('LIKE … ESCAPE')
      return wrapNeg(neg, { k: 'like', e: l, pat, ci })
    }
    if (this.isOp('~') || (this.isOp('!') && this.isOp('~', 1))) {
      const negRe = this.eatOp('!')
      this.next()
      const ci = this.eatOp('*')
      const pat = this.expr()
      return wrapNeg(negRe, { k: 'regex', e: l, pat, ci })
    }
    for (const op of ['=', '<>', '!=', '<=', '>=', '<', '>']) {
      if (this.isOp(op)) {
        this.next()
        if (this.isWord('any') || this.isWord('some') || this.isWord('all')) {
          const all = this.next().v === 'all'
          this.expectOp('(')
          if (!this.eatWord('array')) no('ANY over something other than an array')
          this.expectOp('[')
          const list = [this.expr()]
          while (this.eatOp(',')) list.push(this.expr())
          this.expectOp(']')
          this.cast()
          this.expectOp(')')
          if (op === '=' && !all) return { k: 'in', e: l, list }
          if ((op === '<>' || op === '!=') && all) return { k: 'not', arg: { k: 'in', e: l, list } }
          const args = list.map(r => ({ k: 'cmp', op, l, r }))
          return args.length === 1 ? args[0] : { k: all ? 'and' : 'or', args }
        }
        return { k: 'cmp', op, l, r: this.expr() }
      }
    }
    // A boolean expression on its own: a boolean column, or TRUE/FALSE.
    if (l.k === 'lit' && l.kind === 'bool') return { k: 'const', v: l.v === 'true' }
    if (l.k === 'cond') return l.c
    return { k: 'cmp', op: '=', l, r: { k: 'lit', kind: 'bool', v: 'true' } }
  }

  // Expressions (|| at the level of + and -, as near enough for CHECKs)
  expr() {
    let l = this.term()
    for (;;) {
      if (this.eatOp('+')) l = { k: 'op', op: 'add', args: [l, this.term()] }
      else if (this.eatOp('-')) l = { k: 'op', op: 'sub', args: [l, this.term()] }
      else if (this.eatOp('||')) l = { k: 'op', op: 'concat', args: [l, this.term()] }
      else return l
    }
  }
  term() {
    let l = this.unary()
    for (;;) {
      if (this.eatOp('*')) l = { k: 'op', op: 'mul', args: [l, this.unary()] }
      else if (this.eatOp('/')) l = { k: 'op', op: 'div', args: [l, this.unary()] }
      else if (this.eatOp('%')) l = { k: 'op', op: 'mod', args: [l, this.unary()] }
      else return l
    }
  }
  unary() {
    if (this.eatOp('-')) {
      const e = this.unary()
      return e.k === 'lit' && e.kind === 'num' ? { ...e, v: e.v.startsWith('-') ? e.v.slice(1) : `-${e.v}` } : { k: 'op', op: 'neg', args: [e] }
    }
    if (this.eatOp('+')) return this.unary()
    const e = this.primary()
    this.cast()
    return e
  }
  // ::type, skipped: the column's own datatype decides.
  cast() {
    while (this.eatOp('::')) {
      while (this.peek()?.t === 'id' || this.peek()?.t === 'qid' || this.isOp('.')) {
        if (KEYWORDS.has(this.peek().v) && this.peek().t === 'id') break
        this.next()
      }
      if (this.isOp('(')) { this.next(); while (!this.done() && !this.eatOp(')')) this.next() }
      if (this.isOp('[') && this.isOp(']', 1)) this.i += 2
    }
  }
  primary() {
    const t = this.next()
    if (!t) no('an incomplete condition')
    if (t.t === 'num') return { k: 'lit', kind: 'num', v: t.v }
    if (t.t === 'str') return { k: 'lit', kind: 'str', v: t.v }
    if (t.t === 'op' && t.v === '(') {
      // A parenthesised condition or expression.
      const save = this.i
      try {
        const e = this.expr()
        if (this.eatOp(')')) return e
      } catch (err) { if (!(err instanceof Unsupported)) throw err }
      this.i = save
      const c = this.or()
      this.expectOp(')')
      return { k: 'cond', c }
    }
    if (t.t === 'id' && (t.v === 'true' || t.v === 'false')) return { k: 'lit', kind: 'bool', v: t.v }
    if (t.t === 'id' && t.v === 'null') no('a NULL constant')
    if (t.t === 'id' && KEYWORDS.has(t.v)) no(t.v.toUpperCase())
    if (t.t === 'id' || t.t === 'qid') {
      if (this.isOp('(')) {
        // A function call.
        const fn = FUNCS[t.v]
        if (t.v === 'round') {
          this.next()
          const args = [this.expr()]
          if (this.eatOp(',')) args.push(this.expr())
          this.expectOp(')')
          return { k: 'op', op: args.length === 1 ? 'roundInt' : 'round', args }
        }
        if (!fn) no(`the function ${t.raw}`)
        this.next()
        const args = []
        if (!this.isOp(')')) { args.push(this.expr()); while (this.eatOp(',')) args.push(this.expr()) }
        this.expectOp(')')
        if ((fn === 'greatest' || fn === 'least') && args.length > 2) return args.slice(1).reduce((a, b) => ({ k: 'op', op: fn, args: [a, b] }), args[0])
        return { k: 'op', op: fn, args }
      }
      // tbl.col: the column
      if (this.isOp('.') && (this.peek(1)?.t === 'id' || this.peek(1)?.t === 'qid')) { this.next(); return { k: 'col', name: this.next().v } }
      return { k: 'col', name: t.v }
    }
    no(`"${t.raw ?? t.v}"`)
  }
}

const wrapNeg = (neg, c) => (neg ? { k: 'not', arg: c } : c)

export function parseCheck(text) {
  const p = new Parser(tokenize(text))
  const c = p.or()
  if (!p.done()) no(`"${p.peek().raw ?? p.peek().v}"`)
  return c
}

// ── Translation ──────────────────────────────────────────────────────────────

const CMP = { '=': '≈', '<>': '≉', '!=': '≉', '<': '<', '<=': '≤', '>': '>', '>=': '≥' }
const NEG = { '≈': '≉', '≉': '≈', '<': '≥', '≤': '>', '>': '≤', '≥': '<' }
const FLIP = { '≈': '≈', '≉': '≉', '<': '>', '≤': '≥', '>': '<', '≥': '≤' }

export function checkToFormula(text, columns, tableTypeId) {
  try {
    const cond = parseCheck(text)
    let n = 0
    const T = 't'
    const colOf = (name) => columns.get(name) ?? no(`the column ${name}, which is not in the table`)

    // The columns an atomic condition reads, in order of appearance.
    const colsOf = (x, out = []) => {
      if (!x || typeof x !== 'object') return out
      if (x.k === 'col') { if (!out.includes(x.name)) out.push(x.name); return out }
      for (const v of Object.values(x)) {
        if (Array.isArray(v)) v.forEach(y => colsOf(y, out))
        else if (v && typeof v === 'object') colsOf(v, out)
      }
      return out
    }
    const isConst = (e) => e.k === 'lit'
    const termOf = (e, env) => {
      switch (e.k) {
        case 'col': return { t: 'var', id: env.get(e.name) }
        case 'lit': return { t: 'const', text: e.v }
        case 'op': return { t: 'op', op: e.op, args: e.args.map(a => termOf(a, env)) }
        case 'cond': no('a condition used as a value')
      }
      no('this expression')
    }
    const lower = (e) => ({ k: 'op', op: 'lower', args: [e] })
    // The formula of an atomic condition with its columns bound in env.
    const atomFormula = (c, env) => {
      switch (c.k) {
        case 'cmp': {
          let l = c.l, r = c.r, op = CMP[c.op]
          if (isConst(l) && isConst(r)) no('a comparison of two constants')
          if (isConst(l)) { [l, r] = [r, l]; op = FLIP[op] }
          return { t: 'vcmp', op, left: termOf(l, env), right: termOf(r, env) }
        }
        case 'in': {
          if (isConst(c.e)) no('IN on a constant')
          const args = c.list.map(r => ({ t: 'vcmp', op: '≈', left: termOf(c.e, env), right: termOf(r, env) }))
          return args.length === 1 ? args[0] : { t: 'or', args }
        }
        case 'like': {
          if (c.pat.k !== 'lit' || c.pat.kind !== 'str') no('LIKE with a pattern that is not a constant')
          let pat = c.pat.v, e = c.e
          if (c.ci) { pat = pat.toLowerCase(); e = lower(e) }
          const arg = termOf(e, env)
          const plain = (s) => !/[%_]/.test(s)
          const m = /^(%?)(.*?)(%?)$/s.exec(pat)
          const [, lead, mid, trail] = m
          const pred = (op, s) => ({ t: 'dpred', op, args: [arg, { t: 'const', text: s }] })
          if (plain(mid)) {
            if (lead && trail) return pred('contains', mid)
            if (trail) return pred('startsWith', mid)
            if (lead) return pred('endsWith', mid)
            return { t: 'vcmp', op: '≈', left: arg, right: { t: 'const', text: mid } }
          }
          const re = '^' + [...pat].map(ch => (ch === '%' ? '.*' : ch === '_' ? '.' : ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))).join('') + '$'
          return pred('matches', re)
        }
        case 'regex': {
          if (c.pat.k !== 'lit' || c.pat.kind !== 'str') no('a regular expression that is not a constant')
          const e = c.ci ? lower(c.e) : c.e
          return { t: 'dpred', op: 'matches', args: [termOf(e, env), { t: 'const', text: c.ci ? c.pat.v.toLowerCase() : c.pat.v }] }
        }
      }
      no('this condition')
    }
    // ∀v̄ (c̄(t, v̄) → p(v̄)), or with ¬p for U.
    const quantified = (c, positive) => {
      const names = colsOf(c)
      const env = new Map()
      const vars = names.map(name => { const col = colOf(name); const id = `v${++n}`; env.set(name, id); return { id, typeId: col.vtId, col } })
      let body = atomFormula(c, env)
      if (!positive) body = body.t === 'vcmp' ? { ...body, op: NEG[body.op] } : { t: 'not', arg: body }
      if (!vars.length) return body
      const facts = vars.map(v => ({ t: 'fact', factId: v.col.factId, args: [T, v.id] }))
      body = { t: 'implies', left: facts.length === 1 ? facts[0] : { t: 'and', args: facts }, right: body }
      for (const v of [...vars].reverse()) body = { t: 'forall', v: { id: v.id, typeId: v.typeId }, body }
      return body
    }
    const exists = (name) => {
      const col = colOf(name)
      const id = `v${++n}`
      return { t: 'exists', v: { id, typeId: col.vtId }, body: { t: 'fact', factId: col.factId, args: [T, id] } }
    }
    const isAtomic = (c) => !['and', 'or', 'not', 'isnull', 'const'].includes(c.k)
    // N (positive: "not false") and U (negative: "not true").
    const tr = (c, positive) => {
      switch (c.k) {
        case 'and': case 'or': {
          const conj = (c.k === 'and') === positive
          // In a disjunction, "c is null" adds nothing next to an atomic
          // condition that reads c: that one is already not false (or not
          // true) when c is null. So (e >= s) OR (e IS NULL) is ∀v ∀w
          // (e(t, v) ∧ s(t, w) → v ≥ w).
          const read = new Set(c.args.filter(isAtomic).flatMap(a => colsOf(a)))
          const kept = conj ? c.args : c.args.filter(a => !(a.k === 'isnull' && a.e.k === 'col' && (positive !== a.neg) && read.has(a.e.name)))
          const args = kept.map(a => tr(a, positive))
          return args.length === 1 ? args[0] : { t: conj ? 'and' : 'or', args }
        }
        case 'not': return tr(c.arg, !positive)
        case 'const': return c.v === positive ? { t: 'true' } : { t: 'not', arg: { t: 'true' } }
        case 'isnull': {
          if (c.e.k !== 'col') no('IS NULL on an expression')
          const ex = exists(c.e.name)
          // N(c IS NULL) = ¬∃, U(c IS NULL) = ∃; IS NOT NULL the other way round.
          return (positive !== c.neg) ? { t: 'not', arg: ex } : ex
        }
        default: return quantified(c, positive)
      }
    }
    const rule = { t: 'forall', v: { id: T, typeId: tableTypeId }, body: tr(cond, true) }
    return { rule, columns: colsOf(cond) }
  } catch (e) {
    if (e instanceof Unsupported) return { error: e.message }
    throw e
  }
}

// The text of a CHECK with its column names replaced (renamed columns, for
// the export): renames maps an old name to the new one.
export function renameColumnsInCheck(text, renames, quote) {
  return joinTokens(tokenize(text), renames, quote)
}

function joinTokens(tks, renames = new Map(), quote = (x) => x) {
  return tks.map((t, i) => {
    const prevDot = tks[i - 1]?.t === 'op' && tks[i - 1].v === '.'
    if ((t.t === 'id' || t.t === 'qid') && !prevDot && renames.has(t.v) && !(tks[i + 1]?.t === 'op' && tks[i + 1].v === '('))
      return quote(renames.get(t.v))
    return t.raw ?? t.v
  }).reduce((s, x, i) => {
    if (!i) return x
    const prev = tks[i - 1], cur = tks[i]
    const tight = (prev.t === 'op' && ['(', '.', '::', '['].includes(prev.v)) || (cur.t === 'op' && [')', ',', '.', '::', '[', ']', '('].includes(cur.v) && !(cur.v === '(' && prev.t === 'id' && KEYWORDS.has(prev.v)))
    return s + (tight ? '' : ' ') + x
  }, '')
}

// The CHECK a formula constraint was read from, for the export: { table
// (entity id), name, text } with renamed columns renamed in the text, or
// { reason } when it is no longer that CHECK (the formula was edited, or a
// column it reads is gone). colName(factId) → the column's name now, or null.
export function sqlCheckOf(c, colName, quote) {
  const sc = c.sqlCheck
  if (!sc) return { reason: 'it was not read from a CHECK constraint' }
  if (JSON.stringify(c.rule) !== sc.rule) return { reason: 'its formula was edited after it was read from a CHECK constraint' }
  const renames = new Map()
  for (const [old, factId] of Object.entries(sc.columns ?? {})) {
    const now = colName(factId)
    if (now == null) return { reason: 'a column its CHECK reads is gone' }
    if (now !== old) renames.set(old, now)
  }
  return { table: c.rule?.v?.typeId, name: c.name || null, text: renames.size ? renameColumnsInCheck(sc.text, renames, quote) : sc.text }
}

// ── Graphical forms ──────────────────────────────────────────────────────────
//
// Before a CHECK becomes a formula constraint, its conjuncts that have a
// graphical form are taken out: a comparison of two columns of the row
// (possibly with "c IS NULL" alternatives for those columns, which add
// nothing) is a value comparison constraint over the two columns' value roles,
// joined through the table. splitCheck(text) → { comparisons: [{ left, op,
// right, text }], rest: [text] } (op as the value comparison constraint
// stores it), or { error } when the condition is not read.

const VC_OP = { '=': '=', '<>': '≠', '!=': '≠', '<': '<', '<=': '≤', '>': '>', '>=': '≥' }
export const VC_SQL = { '=': '=', '≠': '<>', '<': '<', '≤': '<=', '>': '>', '≥': '>=' }

export function splitCheck(text) {
  let cond
  const tks = tokenize(text)
  try {
    const p = new Parser(tks)
    cond = p.or()
    if (!p.done()) no(`"${p.peek().raw ?? p.peek().v}"`)
  } catch (e) {
    if (e instanceof Unsupported) return { error: e.message }
    throw e
  }
  const conjuncts = cond.k === 'and' ? cond.args : [{ ...cond, span: [0, tks.length] }]
  const comparisons = [], rest = []
  for (const c of conjuncts) {
    const cmp = columnComparison(c)
    const ctext = joinTokens(tks.slice(...c.span))
    if (cmp) comparisons.push({ ...cmp, text: ctext })
    else rest.push(ctext)
  }
  return { comparisons, rest }
}

// a op b for two different columns, alone or with "a IS NULL"/"b IS NULL"
// alternatives.
function columnComparison(c) {
  const atoms = c.k === 'or' ? c.args : [c]
  const cmps = atoms.filter(a => a.k === 'cmp')
  if (cmps.length !== 1) return null
  const { l, r, op } = cmps[0]
  if (l.k !== 'col' || r.k !== 'col' || l.name === r.name || !VC_OP[op]) return null
  const ok = atoms.every(a => a === cmps[0] || (a.k === 'isnull' && !a.neg && a.e.k === 'col' && (a.e.name === l.name || a.e.name === r.name)))
  return ok ? { left: l.name, op: VC_OP[op], right: r.name } : null
}
