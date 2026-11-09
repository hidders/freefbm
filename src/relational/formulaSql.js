// Constraints as SQL (formula plan, step 4).
//
// A constraint of a relational schema (encoding B: a row is an instance t of
// its table's entity type, a column c with value v is the fact c(t, v)) is
// written from its formula (formula.js syntax tree, as formalise gives it):
//
//   - a formula ∀t φ about one row t of a table, whose φ reads only that row,
//     becomes CHECK (φ'): a column c read as v is the value of c when it is
//     not NULL, so ∀v (c(t, v) → p(v)) is "c IS NULL OR p(c)" and ∃v (c(t, v)
//     ∧ p(v)) is "c IS NOT NULL AND p(c)";
//   - any other formula becomes a query that returns its violations: for
//     ∀x̄ (φ → ψ) the x̄ for which φ holds and ψ does not, with each quantifier
//     an EXISTS over the tables its variables range over, and a transitive
//     closure [TC_{v,w} φ](s, t) a WITH RECURSIVE query of what s reaches.
//
// Values bound to variables are never NULL, so every condition written here
// is true or false, never unknown (SQL's third value): where a negation could
// meet a NULL, the condition says IS NULL or IS DISTINCT FROM.
//
// formulaToSql(formula, model, names) → { check: { tableId, text } } |
//   { query: text, deontic, tables: [tableId] } | { error }, with model from relationalModel
//   and names(Var) → a display name for a column of the query's result;
//   qualify(table) → the table's name as written in FROM (default: quoted).

import { quoteIdent, sqlDialect } from './sqlNames.js'
import { makeContext, constraintEntries } from '../logic/constraintFormulas.js'
import { renderFormula, formulaToString } from '../logic/renderFormula.js'

class Unsupported extends Error {}
const no = (what) => { throw new Unsupported(what) }

const conjuncts = (f) => (!f ? [] : f.t === 'and' ? f.args.flatMap(conjuncts) : f.t === 'true' ? [] : [f])
const NUMBER = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/
const literal = (text) => (NUMBER.test(String(text).trim()) ? String(text).trim() : `'${String(text).replace(/'/g, "''")}'`)
const VCMP = { '≈': '=', '≉': '<>', '<': '<', '≤': '<=', '>': '>', '≥': '>=' }
const COUNT = { '≤': '<=', '≥': '>=', '=': '=' }
function balanced(s) {
  let d = 0
  for (const ch of s) { if (ch === '(') d++; if (ch === ')' && --d < 0) return false }
  return d === 0
}
// Whether s is prefix(…) with the parenthesis closing at its end.
const wraps = (s, prefix) => s.startsWith(`${prefix}(`) && s.endsWith(')') && balanced(s.slice(prefix.length + 1, -1))
// The text with quoted strings and parenthesised parts left out.
const topLevel = (s) => {
  let out = '', d = 0, quote = null
  for (const ch of s) {
    if (quote) { if (ch === quote) quote = null; continue }
    if (ch === "'" || ch === '"') { quote = ch; continue }
    if (ch === '(') { d++; continue }
    if (ch === ')') { d--; continue }
    if (!d) out += ch
  }
  return out
}
// Parentheses where s would bind less tightly than its context: a term or
// condition with an operator at its top level.
const paren = (s) => (/[\s|+*/-]/.test(topLevel(s).trim()) && !wraps(s, 'EXISTS ') && !wraps(s, 'NOT EXISTS ') ? `(${s})` : s)
// a AND b AND c as [a, b, c] (outside parentheses and strings).
const splitAnd = (s) => splitTop(s, 'AND')
function splitTop(s, op) {
  const out = []
  let d = 0, quote = null, last = 0
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (quote) { if (ch === quote) quote = null; continue }
    if (ch === "'" || ch === '"') quote = ch
    else if (ch === '(') d++
    else if (ch === ')') d--
    else if (!d && s.startsWith(` ${op} `, i) && !/ BETWEEN \S+$/.test(s.slice(last, i))) { out.push(s.slice(last, i)); last = i + op.length + 2; i += op.length + 1 }
  }
  out.push(s.slice(last))
  return out
}
const hasTop = (s, word) => topLevel(s).includes(` ${word} `)
const conj = (xs) => (xs.length ? xs.map(x => (xs.length > 1 && hasTop(x, 'OR') ? `(${x})` : x)).join(' AND ') : 'TRUE')
// x = 'a' OR x = 'b' as x IN ('a', 'b').
const EQ_CONST = /^(.+?) = ('(?:[^']|'')*'|[+-]?[\d.]+(?:[eE][+-]?\d+)?)$/s
const inLists = (xs) => {
  const out = []
  for (const x of xs) {
    const m = !/ (AND|OR) /.test(topLevel(x)) && EQ_CONST.exec(x)
    const prev = out[out.length - 1]
    if (m && prev?.lhs === m[1]) prev.values.push(m[2])
    else out.push(m ? { lhs: m[1], values: [m[2]] } : { text: x })
  }
  return out.map(o => (o.text != null ? o.text : o.values.length > 1 ? `${o.lhs} IN (${o.values.join(', ')})` : `${o.lhs} = ${o.values[0]}`))
}
const disj = (xs0) => {
  const xs = inLists(xs0)
  return xs.length ? xs.map(x => (xs.length > 1 && hasTop(x, 'AND') ? `(${x})` : x)).join(' OR ') : 'FALSE'
}
const NEGATED = [[' IS NOT NULL', ' IS NULL'], [' IS NOT DISTINCT FROM ', ' IS DISTINCT FROM ']]
const negate = (s) => {
  if (s === 'TRUE') return 'FALSE'
  if (s === 'FALSE') return 'TRUE'
  if (wraps(s, 'NOT ')) return s.slice(5, -1)
  if (wraps(s, 'NOT EXISTS ')) return s.slice(4)
  if (wraps(s, 'EXISTS ')) return `NOT ${s}`
  const top = topLevel(s)
  // De Morgan, when each part negates without NOT.
  for (const [op, dual] of [['AND', 'OR'], ['OR', 'AND']]) {
    if (!top.includes(` ${op} `) || top.includes(` ${dual} `) || / BETWEEN /.test(top)) continue
    const parts = splitTop(s, op).map(p => negate(/^\(.*\)$/s.test(p) && balanced(p.slice(1, -1)) ? p.slice(1, -1) : p))
    if (parts.every(p => !p.startsWith('NOT ('))) return (op === 'AND' ? disj : conj)(parts)
  }
  if (!/ (AND|OR) /.test(top)) {
    for (const [a, b] of NEGATED) {
      if (top.split(a).length === 2 && !top.includes(b)) return s.replace(a, b)
      if (top.split(b).length === 2 && !top.includes(a)) return s.replace(b, a)
    }
    const cmp = [[' <> ', ' = '], [' <= ', ' > '], [' >= ', ' < '], [' = ', ' <> '], [' < ', ' >= '], [' > ', ' <= ']]
    for (const [a, b] of cmp) if (top.split(a).length === 2 && !/[<>=!~]/.test(top.replace(a, ''))) return s.replace(a, b)
  }
  return `NOT (${s})`
}

// Null-safe (in)equality: PostgreSQL's IS [NOT] DISTINCT FROM; Oracle has
// none, and DECODE treats two NULLs as equal.
const distinctSql = (a, b, distinct = true) => (sqlDialect() === 'oracle'
  ? `DECODE(${a}, ${b}, ${distinct ? 0 : 1}, ${distinct ? 1 : 0}) = 1`
  : `${a} IS ${distinct ? '' : 'NOT '}DISTINCT FROM ${b}`)
// Oracle's names for some data operators and casts (the rest are the same).
const ORACLE_CASTS = { asInteger: 'NUMBER(19)', asDecimal: 'NUMBER', asFloat: 'BINARY_DOUBLE', asBoolean: 'BOOLEAN', asDate: 'DATE', asDatetime: 'TIMESTAMP' }
const ORACLE_FUNC = { ceiling: 'ceil', truncate: 'trunc' }

// Data operators (dataOperators.js OPS) in PostgreSQL.
const INFIX = { add: '+', sub: '-', mul: '*', div: '/', concat: '||' }
const CASTS = { asInteger: 'integer', asDecimal: 'numeric', asFloat: 'double precision', asBoolean: 'boolean', asDate: 'date', asDatetime: 'timestamp', asTime: 'time' }
const FUNC = { abs: 'abs', least: 'least', greatest: 'greatest', round: 'round', roundInt: 'round', floor: 'floor', ceiling: 'ceiling',
  truncate: 'trunc', power: 'power', sqrt: 'sqrt', length: 'length', substring: 'substr', upper: 'upper', lower: 'lower', trim: 'trim',
  mod: 'mod', idiv: 'div', makeDate: 'make_date' }
const EXTRACT = { year: 'YEAR', month: 'MONTH', day: 'DAY', hour: 'HOUR', minute: 'MINUTE', second: 'SECOND', dayOfWeek: 'ISODOW' }

// ∀x ∀y φ as ∀x, y φ (and the same for ∃).
const merged = (g) => {
  if (g?.t !== 'forall' && g?.t !== 'exists') return g
  const vars = [...g.vars]
  let body = g.body
  while (body?.t === g.t) { vars.push(...body.vars); body = body.body }
  return { ...g, vars, body }
}

export function formulaToSql(formula, model, names = () => null, { qualify = null } = {}) {
  const q = quoteIdent
  // The tables a query reads (its constraint triggers fire on them).
  const readTables = new Set()
  const tableName = (table) => { readTables.add(table.id); return qualify ? qualify(table) : q(table.name) }
  const tableById = new Map(model.tables.map(t => [t.id, t]))
  let f = formula
  const deontic = f?.t === 'obligatory'
  if (deontic) f = f.arg
  f = merged(f)
  let n = 0
  let subqueries = false

  // env: Var → { row: alias (null: the row of a CHECK), table } | { sql }
  const valueOf = (env, v) => {
    const b = env.get(v) ?? no('a variable is used outside its quantifier')
    if (b.sql == null) no('a row is used as a value')
    return b.sql
  }
  const colSql = (alias, col) => (alias ? `${alias}.${q(col.name)}` : q(col.name))
  const keyOf = (b) => {
    const pk = b.table.pk ?? no(`table ${b.table.name} has no primary key to compare rows by`)
    return pk.map(c => colSql(b.row, c))
  }
  const rowsEqual = (a, b) => {
    const ka = keyOf(a), kb = keyOf(b)
    return conj(ka.map((k, i) => `${k} = ${kb[i]}`))
  }

  const term = (t, env) => {
    if (t && !t.t) return valueOf(env, t)
    switch (t?.t) {
      case 'const': return literal(t.text)
      case 'fn': {
        const args = t.args.map(a => term(a, env))
        if (INFIX[t.op]) return args.map(paren).join(` ${INFIX[t.op]} `)
        if (t.op === 'neg') return `-${paren(args[0])}`
        if (sqlDialect() === 'oracle') {
          if (t.op === 'toText') return `TO_CHAR(${args[0]})`
          if (CASTS[t.op]) return ORACLE_CASTS[t.op] ? `CAST(${args[0]} AS ${ORACLE_CASTS[t.op]})` : no(`the cast ${t.op} in Oracle`)
          if (t.op === 'dayOfWeek') return `(TRUNC(${args[0]}) - TRUNC(${args[0]}, 'IW') + 1)`
          if (t.op === 'idiv') return `TRUNC(${args[0]} / ${args[1]})`
          if (t.op === 'makeDate') return no('makeDate in Oracle')
          if (EXTRACT[t.op]) return `EXTRACT(${EXTRACT[t.op]} FROM ${args[0]})`
          if (FUNC[t.op]) return `${ORACLE_FUNC[t.op] ?? FUNC[t.op]}(${args.join(', ')})`
        }
        if (t.op === 'toText') return `CAST(${args[0]} AS text)`
        if (CASTS[t.op]) return `CAST(${args[0]} AS ${CASTS[t.op]})`
        if (EXTRACT[t.op]) return `EXTRACT(${EXTRACT[t.op]} FROM ${args[0]})`
        if (FUNC[t.op]) return `${FUNC[t.op]}(${args.join(', ')})`
        return no(`the data operator ${t.op}`)
      }
      case 'ite': return `CASE WHEN ${cond(t.cond, env)} THEN ${term(t.then, env)} ELSE ${term(t.else, env)} END`
      case 'agg': {
        const b = bind(t.vars, conjuncts(t.cond), env, false)
        if (t.fn === 'count' && sqlDialect() === 'oracle' && t.vars.flatMap(v => partsOf(v, b.env)).length > 1)
          return `(SELECT COUNT(*) FROM (${select(`DISTINCT ${t.vars.flatMap(v => partsOf(v, b.env)).join(', ')}`, b)}))`
        const what = t.fn === 'count' ? `COUNT(DISTINCT ${tupleOf(t.vars, b.env)})`
          : `${t.fn.toUpperCase()}(${t.distinct ? 'DISTINCT ' : ''}${term(t.term, b.env)})`
        return `(${select(what, b)})`
      }
    }
    return no('this term')
  }
  // The SQL values that stand for a variable: its value, or its row's key.
  const partsOf = (x, env) => { const b = env.get(x) ?? no('a variable is used outside its quantifier'); return b.sql != null ? [b.sql] : keyOf(b) }
  const tupleOf = (vars, env) => {
    const parts = vars.flatMap(v => { const b = env.get(v); return b.sql != null ? [b.sql] : keyOf(b) })
    return parts.length === 1 ? parts[0] : `(${parts.join(', ')})`
  }
  const select = (what, b) => {
    subqueries = true
    return `SELECT ${what}${b.from.length ? ` FROM ${b.from.join(', ')}` : ''}${b.where.length ? ` WHERE ${conj(b.where.map(w => w.sql))}` : ''}`
  }

  // The variables vars bound by the conjuncts that say where they come from:
  // a row variable ranges over its table, a value variable takes the value
  // of a column a fact atom reads it from (or one a ≈ says it equals).
  // → { from, where: [{ sql, neg }], rest: [formula], env }
  // An ∃ among the conjuncts is taken out: ∀x̄ (∃ȳ φ ∧ χ → ψ) is
  // ∀x̄ ∀ȳ (φ ∧ χ → ψ), and ∃x̄ (∃ȳ φ ∧ χ) is ∃x̄ ∃ȳ (φ ∧ χ); a count counts
  // distinct x̄ (flatten false for an aggregate, which counts bindings).
  const bind = (vars0, list0, outer, flatten = true) => {
    const vars = [...vars0], list = []
    const take = (a) => { if (flatten && a.t === 'exists') { vars.push(...a.vars); conjuncts(a.body).forEach(take) } else list.push(a) }
    list0.forEach(take)
    const env = new Map(outer)
    const from = [], where = []
    const pending = new Set(vars)
    for (const v of vars) {
      const table = tableById.get(v.typeId)
      if (!table) continue
      const alias = `${table.name.replace(/[^A-Za-z]/g, '').slice(0, 1).toLowerCase() || 't'}${++n}`
      from.push(`${tableName(table)} ${alias}`)
      env.set(v, { row: alias, table })
      pending.delete(v)
    }
    const bound = (x) => x && (!x.t ? env.has(x) && !pending.has(x) : x.t === 'const' || (x.t === 'fn' && x.args.every(bound)))
    let rest = [...list]
    for (let changed = true; changed;) {
      changed = false
      rest = rest.filter(a => {
        if (a.t === 'fact') {
          const col = model.columnByFact.get(a.factId)
          if (!col) return true
          const r = env.get(a.args[col.t]), v = a.args[col.v]
          if (!r || r.sql != null || pending.has(a.args[col.t])) return true
          if (r.table !== col.table) no('a column is read from a row of another table')
          const c = colSql(r.row, col)
          if (pending.has(v)) {
            env.set(v, { sql: c }); pending.delete(v)
            // A NOT NULL column always has a value.
            if (!col.notNull && !col.pk) where.push({ sql: `${c} IS NOT NULL`, neg: `${c} IS NULL` })
          } else if (bound(v)) {
            const e = term(v, env)
            where.push({ sql: `${c} = ${e}`, neg: distinctSql(c, e) })
          } else return true
          changed = true
          return false
        }
        if (a.t === 'type' && env.get(a.arg)?.table && !pending.has(a.arg)) {
          if (env.get(a.arg).table.id !== a.typeId) no('a type atom that is not the row\'s table')
          changed = true
          return false
        }
        if (a.t === 'vcmp' && a.op === '≈') {
          for (const [x, y] of [[a.left, a.right], [a.right, a.left]]) {
            if (x && !x.t && pending.has(x) && bound(y)) { env.set(x, { sql: term(y, env) }); pending.delete(x); changed = true; return false }
          }
        }
        return true
      })
    }
    if (pending.size) no('a value is not read from a column')
    return { from, where, rest, env }
  }

  // A condition (true or false, never unknown).
  const cond = (g0, env) => {
    const g = merged(g0)
    switch (g.t) {
      case 'true': return 'TRUE'
      case 'and': return conj(g.args.map(a => cond(a, env)))
      case 'or': return disj(g.args.map(a => cond(a, env)))
      case 'not': return negate(cond(g.arg, env))
      case 'implies': return disj([negate(cond(g.left, env)), cond(g.right, env)])
      case 'iff': return sqlDialect() === 'oracle'
        ? `(CASE WHEN ${cond(g.left, env)} THEN 1 ELSE 0 END) = (CASE WHEN ${cond(g.right, env)} THEN 1 ELSE 0 END)`
        : `${paren(cond(g.left, env))} = ${paren(cond(g.right, env))}`
      case 'exists': {
        const b = bind(g.vars, conjuncts(g.body), env)
        const all = [...b.where.map(w => w.sql), ...b.rest.map(a => cond(a, b.env))]
        return b.from.length ? `EXISTS (${select('1', { ...b, where: all.map(sql => ({ sql })) })})` : conj(all)
      }
      case 'forall': {
        // ∀x̄ (φ → ψ): no x̄ with φ and not ψ.
        const body = g.body
        const [ante, cons] = body.t === 'implies' ? [conjuncts(body.left), body.right]
          : body.t === 'not' ? [conjuncts(body.arg), null] : [[], body]
        const b = bind(g.vars, ante, env)
        const rest = b.rest.map(a => cond(a, b.env))
        const right = cons ? cond(cons, b.env) : 'FALSE'
        if (!b.from.length) return disj([...b.where.map(w => w.neg), ...rest.map(negate), right].filter(x => x !== 'FALSE'))
        const all = [...b.where.map(w => w.sql), ...rest, ...(right === 'FALSE' ? [] : [negate(right)])]
        return `NOT EXISTS (${select('1', { ...b, where: all.map(sql => ({ sql })) })})`
      }
      case 'count': {
        const b = bind(g.vars, conjuncts(g.body), env)
        const all = [...b.where.map(w => w.sql), ...b.rest.map(a => cond(a, b.env))]
        const parts = g.vars.flatMap(v => partsOf(v, b.env))
        const cnt = !b.from.length ? null
          : sqlDialect() === 'oracle' && parts.length > 1
            ? `(SELECT COUNT(*) FROM (${select(`DISTINCT ${parts.join(', ')}`, { ...b, where: all.map(sql => ({ sql })) })}))`
            : `(${select(`COUNT(DISTINCT ${tupleOf(g.vars, b.env)})`, { ...b, where: all.map(sql => ({ sql })) })})`
        const count = cnt ?? `CASE WHEN ${conj(all)} THEN 1 ELSE 0 END`
        return g.op === '..' ? `${count} BETWEEN ${g.n} AND ${g.m}` : `${count} ${COUNT[g.op] ?? no(`the count ${g.op}`)} ${g.n}`
      }
      case 'fact': {
        const col = model.columnByFact.get(g.factId) ?? no('a fact type that is not a column')
        const r = env.get(g.args[col.t])
        if (!r?.table) no('a column of a row that is not bound')
        const c = colSql(r.row, col)
        return distinctSql(c, term(g.args[col.v], env), false)
      }
      case 'type': {
        const r = env.get(g.arg)
        if (r?.table) return r.table.id === g.typeId ? 'TRUE' : 'FALSE'
        return no('a type atom on a value')
      }
      case 'cmp': {
        const a = env.get(g.left), b = env.get(g.right)
        if (!a || !b) no('a variable is used outside its quantifier')
        const eq = a.sql != null && b.sql != null ? `${a.sql} = ${b.sql}` : a.table && b.table ? rowsEqual(a, b) : no('a row compared with a value')
        return g.op === '≠' ? negate(eq) : eq
      }
      case 'vcmp': return `${term(g.left, env)} ${VCMP[g.op] ?? no(`the comparison ${g.op}`)} ${term(g.right, env)}`
      case 'dpred': {
        const [a, b] = g.args
        const s = term(a, env)
        if (b?.t === 'const' && g.op !== 'matches' && !/[%_\\]/.test(b.text)) {
          const pat = g.op === 'startsWith' ? `${b.text}%` : g.op === 'endsWith' ? `%${b.text}` : `%${b.text}%`
          return `${s} LIKE ${literal(pat)}`
        }
        const t = term(b, env)
        if (sqlDialect() === 'oracle') switch (g.op) {
          case 'matches': return `REGEXP_LIKE(${s}, ${t})`
          case 'startsWith': return `SUBSTR(${s}, 1, LENGTH(${t})) = ${t}`
          case 'endsWith': return `SUBSTR(${s}, -LENGTH(${t})) = ${t}`
          case 'contains': return `INSTR(${s}, ${t}) > 0`
        }
        switch (g.op) {
          case 'matches': return `${s} ~ ${t}`
          case 'startsWith': return `starts_with(${s}, ${t})`
          case 'endsWith': return `right(${s}, length(${t})) = ${t}`
          case 'contains': return `strpos(${s}, ${t}) > 0`
        }
        return no(`the predicate ${g.op}`)
      }
      case 'tc': {
        // [TC_{v,w} φ](s, t): t is reached from s in one or more φ steps. The
        // w reached from s, as a recursive query that starts at s (UNION
        // stops on cycles); TC* also holds when s and t are the same.
        const [v, w] = g.vars
        const [s, t] = g.args
        if (!s || !t) no('a transitive closure with an open end')
        const sP = partsOf(s, env), tP = partsOf(t, env)
        const name = `tc${++n}`
        const ora = sqlDialect() === 'oracle'
        const cols = tP.map((_, i) => `r${i + 1}`)
        const sCols = sP.map((_, i) => `s${i + 1}`)
        const local = new Set([name])
        const step = (from) => {
          const b = bind([v, w], conjuncts(g.body), env)
          for (const f of b.from) local.add(f.split(' ').pop())
          const vP = partsOf(v, b.env), wP = partsOf(w, b.env)
          if (vP.length !== sP.length || wP.length !== tP.length) no('a transitive closure over rows and values')
          // Oracle cannot correlate a WITH inside a subquery with the outer
          // query, so its closure starts everywhere and keeps where it started.
          const start = ora ? (from ? vP.map((p, i) => `${p} = ${name}.r${i + 1}`) : [])
            : from ? vP.map((p, i) => `${p} = ${name}.r${i + 1}`) : vP.map((p, i) => `${p} = ${sP[i]}`)
          const what = ora ? [...(from ? sCols.map(c => `${name}.${c}`) : vP), ...wP] : wP
          const where = [...b.where.map(x => x.sql), ...b.rest.map(a => cond(a, b.env)), ...start]
          return select(what.join(', '), { from: [...(from ? [name] : []), ...b.from], where: where.map(sql => ({ sql })) })
        }
        let reach
        if (ora) {
          const all = [...sCols, ...cols]
          const body = `${step(false)} UNION ALL ${step(true)}`
          for (const m of body.matchAll(/\b([a-z]+\d+)\./g)) if (!local.has(m[1])) no('Oracle cannot use a parameter of a transitive closure from outside it')
          reach = `EXISTS (WITH ${name}(${all.join(', ')}) AS (${body}) CYCLE ${all.join(', ')} SET ${name}_cycle TO 1 DEFAULT 0 SELECT 1 FROM ${name} WHERE ${conj([...sP.map((p, i) => `${name}.${sCols[i]} = ${p}`), ...tP.map((p, i) => `${name}.${cols[i]} = ${p}`)])})`
        } else reach = `EXISTS (WITH RECURSIVE ${name}(${cols.join(', ')}) AS (${step(false)} UNION ${step(true)}) SELECT 1 FROM ${name} WHERE ${conj(tP.map((p, i) => `${name}.${cols[i]} = ${p}`))})`
        return g.star ? disj([conj(sP.map((p, i) => `${p} = ${tP[i]}`)), reach]) : reach
      }
    }
    return no(`a ${g.t}`)
  }

  try {
    if (!f) no('there is no formula')
    // One row of one table: a CHECK.
    const row = f.t === 'forall' && tableById.get(f.vars[0].typeId)
    if (row && !deontic) {
      try {
        subqueries = false
        const body = f.vars.length > 1 ? { t: 'forall', vars: f.vars.slice(1), body: f.body } : f.body
        const text = cond(body, new Map([[f.vars[0], { row: null, table: row }]]))
        if (!subqueries && text !== 'TRUE') return { check: { tableId: row.id, text } }
      } catch (e) { if (!(e instanceof Unsupported)) throw e }
    }
    // Otherwise the query that finds its violations.
    if (f.t === 'forall') {
      const body = f.body
      const [ante, cons] = body.t === 'implies' ? [conjuncts(body.left), body.right]
        : body.t === 'not' ? [conjuncts(body.arg), null] : [[], body]
      const b = bind(f.vars, ante, new Map())
      const where = [...b.where.map(w => w.sql), ...b.rest.map(a => cond(a, b.env))]
      if (cons) where.push(...splitAnd(negate(cond(cons, b.env))))
      const used = new Map()
      const as = (name) => {
        const base = String(name ?? 'value').toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '') || 'value'
        const k = (used.get(base) ?? 0) + 1
        used.set(base, k)
        return q(k > 1 ? `${base}_${k}` : base)
      }
      const cols = f.vars.flatMap(v => {
        const x = b.env.get(v)
        if (x.sql != null) return [`${x.sql} AS ${as(names(v))}`]
        return (x.table.pk ?? []).map(c => `${colSql(x.row, c)} AS ${as(`${x.table.name}_${c.name}`)}`)
      })
      const text = `SELECT ${cols.length ? `DISTINCT ${cols.join(', ')}` : `'violated' AS violation`}`
        + (b.from.length ? `\nFROM ${b.from.join(', ')}` : '') + (where.length ? `\nWHERE ${where.map(w => (where.length > 1 && hasTop(w, 'OR') ? `(${w})` : w)).join('\n  AND ')}` : '')
      return { query: text, deontic, tables: [...readTables] }
    }
    const where = negate(cond(f, new Map()))
    return { query: `SELECT 'violated' AS violation\nWHERE ${where}`, deontic, tables: [...readTables] }
  } catch (e) {
    if (e instanceof Unsupported) return { error: e.message }
    throw e
  }
}

// The constraints of a relational schema that have no table form
// (relationalModel's unwritten), each with what its formulas become:
// [{ c, entries: [{ entry, check, query, deontic, error, text }] }], where
// text is the formula as the Constraints tab writes it.
export function constraintsAsSql(state, model) {
  if (!model.unwritten?.length) return []
  const ctx = makeContext(state)
  return model.unwritten.map(c => ({
    c,
    entries: constraintEntries(c, state, ctx).map(entry => {
      if (!entry.formula) return { entry, error: entry.note ?? 'it has no formula' }
      const names = new Map()
      renderFormula(entry.formula, ctx, names)
      const text = formulaToString(entry.formula, ctx)
      return { entry, text, ...formulaToSql(entry.formula, model, (v) => names.get(v)) }
    }),
  }))
}
