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

// funcs: SQL functions of the script (parseDdl's functions: name →
// { params: [name | null], body, language }), inlined where a condition calls
// them; params: the arguments of the function being inlined (name or $i →
// parsed expression).
class Parser {
  constructor(tks, funcs = null, params = null, depth = 0, site = null) { this.tk = tks; this.i = 0; this.funcs = funcs; this.params = params; this.depth = depth; this.site = site }
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
    if (this.isWord('exists') && this.isOp('(', 1)) {
      this.i += 2
      const q = this.select()
      this.expectOp(')')
      return { k: 'exists', q }
    }
    const l = this.expr()
    if (this.eatWord('is')) {
      const neg = this.eatWord('not')
      if (this.eatWord('null')) return { k: 'isnull', e: l, neg }
      // IS TRUE / IS FALSE are never unknown: c IS TRUE is NOT (c IS NULL
      // OR NOT c = true), so a NULL does not pass (c = true would let it).
      const truth = (v) => wrapNeg(neg, { k: 'not', arg: { k: 'or', args: [{ k: 'isnull', e: l, neg: false },
        { k: 'not', arg: { k: 'cmp', op: '=', l, r: { k: 'lit', kind: 'bool', v } } }] } })
      if (this.eatWord('true')) return truth('true')
      if (this.eatWord('false')) return truth('false')
      no(this.isWord('distinct') ? 'IS DISTINCT FROM' : `IS ${neg ? 'NOT ' : ''}${String(this.peek()?.raw ?? '').toUpperCase()}`)
    }
    const neg = this.isWord('not') && ['in', 'between', 'like', 'ilike'].some(w => this.isWord(w, 1)) ? (this.next(), true) : false
    if (this.eatWord('in')) {
      this.expectOp('(')
      if (this.isWord('select')) {
        const q = this.select()
        this.expectOp(')')
        return wrapNeg(neg, { k: 'insub', e: l, q })
      }
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
  // SELECT [DISTINCT] items FROM t [AS] a, … [[INNER | CROSS] JOIN t b [ON c]] [WHERE c]
  // → { items: [expr] | null (for *), from: [{ table, schema, alias }], where }
  select() {
    if (!this.eatWord('select')) no('a subquery without SELECT')
    this.eatWord('distinct')
    let items = []
    if (this.eatOp('*')) items = null
    else {
      for (;;) {
        if (['id', 'qid'].includes(this.peek()?.t) && this.isOp('.', 1) && this.isOp('*', 2)) { this.i += 3; items = null }
        else { const e = this.exprOrCond(); if (items) items.push(e) }
        if (this.eatWord('as')) this.next()
        if (!this.eatOp(',')) break
      }
    }
    const from = [], on = []
    if (this.eatWord('from')) {
      const item = () => {
        const parts = [this.next()]
        if (!['id', 'qid'].includes(parts[0]?.t) || (parts[0].t === 'id' && parts[0].v === 'select')) no('a FROM item that is not a table')
        while (this.isOp('.') && ['id', 'qid'].includes(this.peek(1)?.t)) { this.next(); parts.push(this.next()) }
        const name = parts[parts.length - 1].v
        this.eatWord('as')
        let alias = name
        const a = this.peek()
        if (a && (a.t === 'qid' || (a.t === 'id' && !FROM_STOP.has(a.v)))) alias = this.next().v
        from.push({ table: name, schema: parts.length > 1 ? parts[parts.length - 2].v : null, alias })
      }
      item()
      for (;;) {
        if (this.eatOp(',')) { item(); continue }
        if (['left', 'right', 'full', 'natural'].some(w => this.isWord(w))) no(`a ${this.peek().v.toUpperCase()} JOIN`)
        if (this.isWord('inner') || this.isWord('join') || this.isWord('cross')) {
          this.eatWord('inner')
          const cross = this.eatWord('cross')
          if (!this.eatWord('join')) no('JOIN expected')
          item()
          if (!cross) {
            if (this.isWord('using')) no('JOIN … USING')
            if (this.eatWord('on')) on.push(this.or())
          }
          continue
        }
        break
      }
    }
    let where = this.eatWord('where') ? this.or() : null
    for (const w of ['group', 'having', 'order', 'limit', 'offset', 'union', 'intersect', 'except', 'fetch'])
      if (this.isWord(w)) no(`${w.toUpperCase()} in a subquery`)
    if (on.length) where = { k: 'and', args: where ? [...on, where] : on }
    return { items, from, where, site: this.site }
  }
  // An expression or a condition (a select item, a function's result).
  exprOrCond() {
    const save = this.i
    try {
      const e = this.expr()
      if (this.done() || this.isOp(',') || this.isOp(')') || this.isWord('from') || this.isWord('as') || this.isOp(';')) return e
    } catch (err) { if (!(err instanceof Unsupported)) throw err }
    this.i = save
    return { k: 'cond', c: this.or() }
  }
  // A call of a SQL function of the script: its body with the arguments in
  // place of its parameters. A body is SELECT cond, RETURN cond, or a SELECT
  // of a condition over an aggregate FROM … WHERE … (the aggregate is then
  // a subquery over those rows).
  inline(t) {
    const f = this.funcs.get(t.v)
    if (this.depth > 8) no(`the function ${t.raw}, which calls itself`)
    if (f.language !== 'sql' || f.body == null) no(`the ${f.language === 'plpgsql' ? 'PL/pgSQL ' : ''}function ${t.raw}`)
    this.next()
    const args = []
    if (!this.isOp(')')) { args.push(this.expr()); while (this.eatOp(',')) args.push(this.expr()) }
    this.expectOp(')')
    // The arguments' columns are the caller's: the rows the body's
    // subqueries bring in (marked with this call's site) don't hide them.
    const site = ++sites
    const mark = (x) => {
      if (!x || typeof x !== 'object') return x
      if (Array.isArray(x)) return x.map(mark)
      const y = Object.fromEntries(Object.entries(x).map(([k, v]) => [k, mark(v)]))
      if (y.k === 'col') y.argOf = [...(y.argOf ?? []), site]
      return y
    }
    const params = new Map()
    f.params.forEach((name, i) => {
      const a = mark(args[i] ?? no(`the function ${t.raw} called with too few arguments`))
      params.set(`$${i + 1}`, a)
      if (name) params.set(name, a)
    })
    const p = new Parser(tokenize(f.body), this.funcs, params, this.depth + 1, site)
    let c
    if (p.eatWord('return')) c = p.or()
    else {
      const q = p.select()
      if (!q.items || q.items.length !== 1) no(`the function ${t.raw}, whose SELECT does not return one value`)
      const item = q.items[0]
      if (!q.from.length) c = item.k === 'cond' ? item.c : item
      else {
        const hasAgg = (x) => !!x && typeof x === 'object' && (x.k === 'agg' || Object.values(x).some(v => (Array.isArray(v) ? v.some(hasAgg) : hasAgg(v))))
        if (!hasAgg(item)) no(`the function ${t.raw}, whose SELECT reads rows without an aggregate`)
        const lift = (x) => {
          if (!x || typeof x !== 'object') return x
          if (Array.isArray(x)) return x.map(lift)
          if (x.k === 'agg') return { k: 'subq', q: { ...q, items: [x] } }
          return Object.fromEntries(Object.entries(x).map(([k, v]) => [k, lift(v)]))
        }
        c = lift(item.k === 'cond' ? item.c : item)
      }
    }
    while (p.eatOp(';')) { /* a trailing semicolon */ }
    if (!p.done()) no(`"${p.peek().raw ?? p.peek().v}" in the function ${t.raw}`)
    return CONDS.has(c.k) ? { k: 'cond', c } : c
  }
  primary() {
    const t = this.next()
    if (!t) no('an incomplete condition')
    if (t.t === 'num') return { k: 'lit', kind: 'num', v: t.v }
    if (t.t === 'str') return { k: 'lit', kind: 'str', v: t.v }
    if (t.t === 'op' && t.v === '(' && this.isWord('select')) {
      // A scalar subquery.
      const q = this.select()
      this.expectOp(')')
      return { k: 'subq', q }
    }
    if (t.t === 'op' && t.v === '$' && this.peek()?.t === 'num' && this.params) {
      const arg = this.params.get(`$${this.next().v}`)
      return arg ?? no('a parameter with no argument')
    }
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
      if (this.isOp('(') && AGGS.has(t.v)) {
        // An aggregate (in a subquery's select list).
        this.next()
        const distinct = this.eatWord('distinct')
        const arg = this.eatOp('*') ? null : this.expr()
        this.expectOp(')')
        return { k: 'agg', fn: t.v, distinct, arg }
      }
      if (this.isOp('(') && this.funcs?.has(t.v) && !FUNCS[t.v] && t.v !== 'round') return this.inline(t)
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
      // tbl.col: the column (of the row the name tbl stands for)
      if (this.isOp('.') && (this.peek(1)?.t === 'id' || this.peek(1)?.t === 'qid')) { this.next(); return { k: 'col', name: this.next().v, qual: t.v } }
      if (this.params?.has(t.v)) return this.params.get(t.v)
      return { k: 'col', name: t.v }
    }
    no(`"${t.raw ?? t.v}"`)
  }
}

const wrapNeg = (neg, c) => (neg ? { k: 'not', arg: c } : c)
const AGGS = new Set(['count', 'sum', 'avg', 'min', 'max'])
let sites = 0   // inlined function calls
const CONDS = new Set(['cmp', 'and', 'or', 'not', 'isnull', 'in', 'insub', 'exists', 'like', 'regex', 'const'])
const FROM_STOP = new Set(['where', 'join', 'inner', 'left', 'right', 'full', 'cross', 'natural', 'on', 'using', 'group', 'having',
  'order', 'limit', 'offset', 'union', 'intersect', 'except', 'fetch', 'as'])

export function parseCheck(text, funcs = null) {
  const p = new Parser(tokenize(text), funcs)
  const c = p.or()
  if (!p.done()) no(`"${p.peek().raw ?? p.peek().v}"`)
  return c
}

// ── Translation ──────────────────────────────────────────────────────────────

const CMP = { '=': '≈', '<>': '≉', '!=': '≉', '<': '<', '<=': '≤', '>': '>', '>=': '≥' }
const NEG = { '≈': '≉', '≉': '≈', '<': '≥', '≤': '>', '>': '≤', '≥': '<' }
const FLIP = { '≈': '≈', '≉': '≉', '<': '>', '≤': '≥', '>': '<', '≥': '≤' }

// checkToFormula(text, columns, tableTypeId, { tables, funcs }): a CHECK of a
// table; assertionToFormula(text, { tables, funcs }): a CREATE ASSERTION's
// condition (closed: no row of its own). tables(name, schema) → { typeId,
// columns } for the tables a subquery reads, or null; funcs: the script's SQL
// functions (inlined). Each gives { rule, columns (the CHECK's own columns
// read), tables (the names of the other tables read) } or { error }.
//
// A subquery's rows are variables r of their tables' entity types, and its
// WHERE counts when it is TRUE, so besides N and U the translation has T(φ)
// ("φ is true", = ¬U) and F(φ) ("φ is false", = ¬N):
//
//   T(p) = ∃v̄ (c̄(r, v̄) ∧ p)        F(p) = ∃v̄ (c̄(r, v̄) ∧ ¬p)
//   N(EXISTS q) = T(EXISTS q) = ∃r̄ T(where)
//   U(EXISTS q) = F(EXISTS q) = ∀r̄ U(where)
//   x IN (SELECT e …): T = ∃r̄ (T(where) ∧ T(x = e)), N = ∃r̄ (T(where) ∧ N(x = e))
//   (SELECT COUNT(*) FROM t WHERE w) op n: ∃^{op n} r T(w), never unknown
//
// A disjunction with a part ∀v̄ (A → ¬p) (as U gives) is read as ∀v̄ (A ∧ p →
// the rest), so NOT EXISTS (… WHERE a AND NOT EXISTS (…)) becomes ∀r̄ (… → ∃ …).
export function checkToFormula(text, columns, tableTypeId, opts = {}) {
  return translate(text, { columns, tableTypeId, ...opts })
}
export function assertionToFormula(text, opts = {}) {
  return translate(text, { columns: null, tableTypeId: null, ...opts })
}

function translate(text, { columns, tableTypeId, table = null, tables = null, funcs = null }) {
  try {
    const cond = parseCheck(text, funcs)
    let n = 0, m = 0
    const T = 't'
    // Rows in scope, innermost frame first; each row: { alias, table, id, cols }.
    const base = columns ? [[{ alias: table, table, id: T, cols: columns }]] : []
    const ownCols = []
    const others = new Set()
    const find = (e, scope) => {
      for (const frame of scope) {
        for (const r of frame) {
          if (r.site && e.argOf?.includes(r.site)) continue
          if (e.qual && e.qual !== r.alias && e.qual !== r.table) continue
          const col = r.cols.get(e.name)
          if (col) {
            if (r.id === T && !ownCols.includes(e.name)) ownCols.push(e.name)
            return { row: r.id, ...col }
          }
          if (e.qual) no(`the column ${e.qual}.${e.name}, which is not in the table`)
        }
      }
      return no(e.qual ? `${e.qual}.${e.name}, which names no table of the query` : `the column ${e.name}, which is not in the table`)
    }
    const rowsOf = (q) => q.from.map(f => {
      const tb = tables?.(f.table, f.schema) ?? no(`the table ${f.table}, which is not in the script`)
      others.add(tb.name ?? f.table)
      return { alias: f.alias, table: f.table, id: `r${++m}`, typeId: tb.typeId, cols: tb.columns, site: q.site }
    })

    // The columns an atomic condition reads, in order of appearance.
    const colsOf = (x, out = []) => {
      if (!x || typeof x !== 'object') return out
      if (x.k === 'subq' || x.k === 'agg') no('a subquery or aggregate used as a value')
      if (x.k === 'col') { if (!out.some(c => c.name === x.name && c.qual === x.qual)) out.push(x); return out }
      for (const v of Object.values(x)) {
        if (Array.isArray(v)) v.forEach(y => colsOf(y, out))
        else if (v && typeof v === 'object') colsOf(v, out)
      }
      return out
    }
    const keyOf = (e) => `${e.qual ?? ''}.${e.name}`
    const isConst = (e) => e.k === 'lit'
    const termOf = (e, env) => {
      switch (e.k) {
        case 'col': return { t: 'var', id: env.get(keyOf(e)) }
        case 'lit': return { t: 'const', text: e.v }
        case 'op': return { t: 'op', op: e.op, args: e.args.map(a => termOf(a, env)) }
        case 'cond': no('a condition used as a value')
      }
      no('this expression')
    }
    const lower = (e) => ({ k: 'op', op: 'lower', args: [e] })
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
          const [, lead, mid, trail] = /^(%?)(.*?)(%?)$/s.exec(pat)
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
    const negate = (b) => (b.t === 'vcmp' ? { ...b, op: NEG[b.op] } : { t: 'not', arg: b })
    // An atomic condition in a mode: N ∀v̄ (c̄ → p), U ∀v̄ (c̄ → ¬p), T ∃v̄ (c̄ ∧ p), F ∃v̄ (c̄ ∧ ¬p).
    const atomic = (c, mode, scope) => {
      const refs = colsOf(c)
      const env = new Map()
      const vars = refs.map(e => { const col = find(e, scope); const id = `v${++n}`; env.set(keyOf(e), id); return { id, typeId: col.vtId, col } })
      let body = atomFormula(c, env)
      if (mode === 'U' || mode === 'F') body = negate(body)
      if (!vars.length) return body
      const facts = vars.map(v => ({ t: 'fact', factId: v.col.factId, args: [v.col.row, v.id] }))
      const fs = facts.length === 1 ? facts[0] : { t: 'and', args: facts }
      const universal = mode === 'N' || mode === 'U'
      body = universal ? { t: 'implies', left: fs, right: body } : { t: 'and', args: [...facts, body] }
      for (const v of [...vars].reverse()) body = { t: universal ? 'forall' : 'exists', v: { id: v.id, typeId: v.typeId }, body }
      return body
    }
    const quant = (q, rows, body) => [...rows].reverse().reduce((b, r) => ({ t: q, v: { id: r.id, typeId: r.typeId }, body: b }), body)
    const isAtomic = (c) => !['and', 'or', 'not', 'isnull', 'const', 'exists', 'insub'].includes(c.k)
    const trueish = (mode) => mode === 'N' || mode === 'T'
    const SWAP = { N: 'U', U: 'N', T: 'F', F: 'T' }
    // (SELECT COUNT(…) FROM t WHERE w) op n, or n op (…).
    const countCmp = (c, scope) => {
      let l = c.l, r = c.r, op = c.op
      if (r.k === 'subq') { [l, r] = [r, l]; op = { '<': '>', '<=': '>=', '>': '<', '>=': '<=', '=': '=', '<>': '<>', '!=': '!=' }[op] }
      if (l.k !== 'subq' || !l.q.items || l.q.items.length !== 1 || l.q.items[0].k !== 'agg' || l.q.items[0].fn !== 'count') no('a subquery used as a value')
      if (r.k !== 'lit' || r.kind !== 'num' || !/^\d+$/.test(r.v)) no('a COUNT compared with something other than a whole number')
      if (l.q.from.length !== 1) no('a COUNT over a join')
      const agg = l.q.items[0]
      if (agg.distinct) no('COUNT(DISTINCT …)')
      const k = +r.v
      const rows = rowsOf(l.q)
      const inner = [rows, ...scope]
      const parts = []
      if (l.q.where) parts.push(tr(l.q.where, 'T', inner))
      // COUNT(c) counts the rows where c is not NULL.
      if (agg.arg) parts.push(tr({ k: 'isnull', e: agg.arg, neg: true }, 'T', inner))
      const body = parts.length === 0 ? { t: 'true' } : parts.length === 1 ? parts[0] : { t: 'and', args: parts }
      const v = { id: rows[0].id, typeId: rows[0].typeId }
      const cnt = (o, x) => ({ t: 'count', op: o, n: x, v, body })
      switch (op) {
        case '<=': return cnt('≤', k)
        case '<': return k === 0 ? { t: 'not', arg: { t: 'true' } } : cnt('≤', k - 1)
        case '>=': return cnt('≥', k)
        case '>': return cnt('≥', k + 1)
        case '=': return cnt('=', k)
        default: return { t: 'not', arg: cnt('=', k) }
      }
    }
    const hasSubq = (x) => !!x && typeof x === 'object' && (x.k === 'subq' || Object.values(x).some(v => (Array.isArray(v) ? v.some(hasSubq) : hasSubq(v))))
    const tr = (c, mode, scope) => {
      switch (c.k) {
        case 'and': case 'or': {
          const conj = (c.k === 'and') === trueish(mode)
          let kept = c.args
          if (!conj && (mode === 'N' || mode === 'U')) {
            const positive = mode === 'N'
            const read = new Set(c.args.filter(isAtomic).flatMap(a => (hasSubq(a) ? [] : colsOf(a).map(keyOf))))
            kept = c.args.filter(a => !(a.k === 'isnull' && a.e.k === 'col' && (positive !== a.neg) && read.has(keyOf(a.e))))
          }
          const args = kept.map(a => tr(a, mode, scope))
          return args.length === 1 ? args[0] : { t: conj ? 'and' : 'or', args }
        }
        case 'not': return tr(c.arg, SWAP[mode], scope)
        case 'const': return c.v === trueish(mode) ? { t: 'true' } : { t: 'not', arg: { t: 'true' } }
        case 'isnull': {
          if (c.e.k !== 'col') no('IS NULL on an expression')
          const col = find(c.e, scope)
          const id = `v${++n}`
          const ex = { t: 'exists', v: { id, typeId: col.vtId }, body: { t: 'fact', factId: col.factId, args: [col.row, id] } }
          return (trueish(mode) !== c.neg) ? { t: 'not', arg: ex } : ex
        }
        case 'exists': {
          const rows = rowsOf(c.q)
          const inner = [rows, ...scope]
          if (trueish(mode)) return quant('exists', rows, c.q.where ? tr(c.q.where, 'T', inner) : { t: 'true' })
          return quant('forall', rows, c.q.where ? tr(c.q.where, 'U', inner) : { t: 'not', arg: { t: 'true' } })
        }
        case 'insub': {
          if (!c.q.items || c.q.items.length !== 1 || c.q.items[0].k === 'cond') no('IN over a subquery that does not select one value')
          const rows = rowsOf(c.q)
          const inner = [rows, ...scope]
          const eq = { k: 'cmp', op: '=', l: c.e, r: c.q.items[0] }
          // T: ∃r̄ (T(w) ∧ T(x = e)); N: ∃r̄ (T(w) ∧ N(x = e)); F = ¬N, U = ¬T.
          const pos = (m2) => {
            const parts = [...(c.q.where ? [tr(c.q.where, 'T', inner)] : []), tr(eq, m2, inner)]
            return quant('exists', rows, parts.length === 1 ? parts[0] : { t: 'and', args: parts })
          }
          if (mode === 'T') return pos('T')
          if (mode === 'N') return pos('N')
          if (mode === 'U') return { t: 'not', arg: pos('T') }
          return { t: 'not', arg: pos('N') }
        }
        default: {
          if (c.k === 'cmp' && (c.l.k === 'subq' || c.r.k === 'subq')) {
            const f = countCmp(c, scope)
            return trueish(mode) ? f : { t: 'not', arg: f }
          }
          return atomic(c, mode, scope)
        }
      }
    }
    let rule = tr(cond, 'N', base)
    if (columns) rule = { t: 'forall', v: { id: T, typeId: tableTypeId }, body: rule }
    if (others.size) rule = tidy(rule)
    return { rule, columns: ownCols, tables: [...others] }
  } catch (e) {
    if (e instanceof Unsupported) return { error: e.message }
    throw e
  }
}

// Readable forms of a translation with subqueries: ¬¬φ is φ, nested ∀ and ∃
// over conjunctions are flattened, and a disjunction with parts ∀v̄ (A → B)
// is read as ∀v̄ (A ∧ ¬B → the rest) (v̄ are fresh in every part).
function tidy(rule) {
  const free = (n, id) => JSON.stringify(n).includes(`"${id}"`)
  const negate = (b) => {
    if (b.t === 'vcmp' && NEG[b.op]) return { ...b, op: NEG[b.op] }
    if (b.t === 'not') return b.arg
    return { t: 'not', arg: b }
  }
  const and = (xs) => {
    const flat = xs.flatMap(x => (x.t === 'and' ? x.args : [x])).filter(x => x.t !== 'true')
    return flat.length === 0 ? { t: 'true' } : flat.length === 1 ? flat[0] : { t: 'and', args: flat }
  }
  const go = (x) => {
    if (!x || typeof x !== 'object' || Array.isArray(x)) return x
    let y = Object.fromEntries(Object.entries(x).map(([k, v]) => [k, Array.isArray(v) ? v.map(go) : go(v)]))
    if (y.t === 'not' && y.arg?.t === 'not') return y.arg.arg
    // ¬∃^{≥n} is ∃^{≤n-1}, ¬∃^{≤n} is ∃^{≥n+1}.
    if (y.t === 'not' && y.arg?.t === 'count' && y.arg.op === '≥' && y.arg.n > 0) return { ...y.arg, op: '≤', n: y.arg.n - 1 }
    if (y.t === 'not' && y.arg?.t === 'count' && y.arg.op === '≤') return { ...y.arg, op: '≥', n: y.arg.n + 1 }
    if (y.t === 'and') return and(y.args)
    if (y.t === 'or') {
      // Parts ∀v̄ (A → B) move into an antecedent: ∀v̄ (A ∧ ¬B → rest).
      const neg = [], rest = []
      for (const a of y.args) {
        let k = a; const vs = []
        while (k.t === 'forall') { vs.push(k.v); k = k.body }
        if (vs.length && k.t === 'implies' && !rest.some(r => vs.some(v => free(r, v.id)))) neg.push({ vs, left: and([k.left, negate(k.right)]) })
        else rest.push(a)
      }
      if (!rest.length && neg.length > 1) rest.push(y.args[y.args.length - 1]), neg.pop()
      if (!neg.length || !rest.length) return y
      const right = rest.length === 1 ? rest[0] : { t: 'or', args: rest }
      const body = { t: 'implies', left: and(neg.map(p => p.left)), right }
      return neg.flatMap(p => p.vs).reverse().reduce((b, v) => ({ t: 'forall', v, body: b }), body)
    }
    // ∀r (A → ∀v (B → C)) is ∀r ∀v (A ∧ B → C).
    if (y.t === 'implies' && y.right?.t === 'forall') {
      let k = y.right; const vs = []
      while (k.t === 'forall') { vs.push(k.v); k = k.body }
      if (k.t === 'implies' && !vs.some(v => free(y.left, v.id)))
        return vs.reverse().reduce((b, v) => ({ t: 'forall', v, body: b }), { t: 'implies', left: and([y.left, k.left]), right: k.right })
    }
    if (y.t === 'forall' && y.body?.t === 'forall') return y
    return y
  }
  // Twice: moving parts can make new chances.
  return mergeEqual(go(go(rule)))
}

// ∃v (… ∧ v ≈ w ∧ …) and ∀v (… ∧ v ≈ w ∧ … → φ), v and w of one type: v is w
// (a join of two columns read as one value).
function mergeEqual(rule) {
  const typeOf = new Map()
  const note = (n) => {
    if (!n || typeof n !== 'object') return
    if (Array.isArray(n)) { n.forEach(note); return }
    if (['forall', 'exists', 'count'].includes(n.t) && n.v) typeOf.set(n.v.id, n.v.typeId)
    Object.values(n).forEach(note)
  }
  note(rule)
  const subst = (n, from, to) => {
    if (typeof n === 'string') return n === from ? to : n
    if (!n || typeof n !== 'object') return n
    if (Array.isArray(n)) return n.map(x => subst(x, from, to))
    const out = {}
    for (const [k, v] of Object.entries(n)) {
      if (k === 'v' && v?.id) out[k] = v
      else if (k === 'id' && n.t === 'var') out[k] = v === from ? to : v
      else if (k === 'args' && n.t === 'fact') out[k] = v.map(a => (a === from ? to : a))
      else if (k === 'arg' && n.t === 'type') out[k] = v === from ? to : v
      else out[k] = subst(v, from, to)
    }
    return out
  }
  const conj = (n) => (n?.t === 'and' ? n.args : n ? [n] : [])
  const andOf = (xs) => (xs.length === 0 ? { t: 'true' } : xs.length === 1 ? xs[0] : { t: 'and', args: xs })
  const hit = (parts, v) => parts.find(a => a.t === 'vcmp' && a.op === '≈' && a.left?.t === 'var' && a.right?.t === 'var'
    && (a.left.id === v || a.right.id === v) && a.left.id !== a.right.id
    && typeOf.get(a.left.id) === typeOf.get(a.right.id))
  const walk = (n) => {
    if (!n || typeof n !== 'object') return n
    if (Array.isArray(n)) return n.map(walk)
    const m = Object.fromEntries(Object.entries(n).map(([k, v]) => [k, walk(v)]))
    if (m.t !== 'exists' && m.t !== 'forall') return m
    // A block of ∃ (or ∀) and the conjunction (antecedent) under it.
    const vs = []
    let core = m
    while (core.t === m.t) { vs.push(core.v); core = core.body }
    const universal = m.t === 'forall'
    if (universal && core.t !== 'implies') return m
    let parts = conj(universal ? core.left : core)
    let rest = universal ? core.right : null
    for (let again = true; again;) {
      again = false
      for (const v of [...vs].reverse()) {
        const a = hit(parts, v.id)
        if (!a) continue
        const o = a.left.id === v.id ? a.right.id : a.left.id
        parts = subst(parts.filter(x => x !== a), v.id, o)
        if (rest) rest = subst(rest, v.id, o)
        vs.splice(vs.indexOf(v), 1)
        again = true
        break
      }
    }
    const left = andOf(parts)
    const body = universal ? (left.t === 'true' ? rest : { t: 'implies', left, right: rest }) : left
    return [...vs].reverse().reduce((b, v) => ({ t: m.t, v, body: b }), body)
  }
  return walk(rule)
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

export function splitCheck(text, funcs = null) {
  let cond
  const tks = tokenize(text)
  try {
    const p = new Parser(tks, funcs)
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
