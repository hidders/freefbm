// Which violation queries Oracle can enforce with CREATE ASSERTION (23.26.1
// and later), learnt from probes on Oracle AI Database 26ai Free 23.26.3:
//
//   - the condition is NOT EXISTS (query), with comma joins (no ANSI JOIN),
//     no aggregates or scalar subqueries, no WITH, no DUAL (a synonym), and
//     at most three levels of nested SELECT;
//   - every equijoin must be one Oracle can check fast; in the probes that
//     held for joins along a NOT NULL foreign key to the key it references
//     (employee.dept_id = department.dept_id), and failed for nullable
//     foreign keys, self-joins and joins on other columns, indexed or not
//     (ORA-08673). Some correlated full-key lookups pass too, so the export
//     tries CREATE ASSERTION whenever nothing rules it out, and falls back
//     to triggers when Oracle refuses it (oracleDdl.js).
//
// oracleAssertion(query, model) → { ok, likely, reason, body }:
//   ok      nothing rules CREATE ASSERTION out (the script tries it)
//   likely  every equijoin is along a NOT NULL foreign key
//   reason  why not (ok false), or which join Oracle may refuse (likely false)
//   body    the query with SELECT 1 as its select list, for NOT EXISTS (…)

import { quoteIdent } from './sqlNames.js'

// The deepest nesting of SELECTs in the text (the outer one is level 1).
function selectDepth(text) {
  const stack = []          // per open parenthesis: does it hold a subquery
  let max = 0
  for (const m of text.matchAll(/\(|\)|\bSELECT\b/g)) {
    if (m[0] === '(') stack.push(false)
    else if (m[0] === ')') stack.pop()
    else {
      if (stack.length && /\(\s*$/.test(text.slice(0, m.index))) stack[stack.length - 1] = true
      max = Math.max(max, 1 + stack.filter(Boolean).length)
    }
  }
  return max
}

export function oracleAssertion(query, model) {
  const no = (reason) => ({ ok: false, likely: false, reason, body: null })
  if (!query) return no('it has no query')
  const lines = query.split('\n')
  if (!/^FROM /.test(lines[1] ?? '')) return no('it reads no table directly')
  if (/\b(COUNT|SUM|AVG|MIN|MAX)\(/.test(query)) return no('Oracle assertions cannot count or aggregate')
  if (/\bWITH\b/.test(query)) return no('Oracle assertions cannot use recursive queries (a transitive closure)')
  if (/\bJOIN\b/.test(query)) return no('Oracle assertions cannot use ANSI joins')
  const body = ['SELECT 1', ...lines.slice(1)].join('\n')
  if (selectDepth(body) > 3) return no('Oracle assertions allow at most three levels of nested queries')

  // The tables behind the aliases (formulaSql writes "table alias").
  const byName = new Map(model.tables.map(t => [quoteIdent(t.name), t]))
  const alias = new Map()
  for (const m of query.matchAll(/(?:FROM |, )("(?:[^"]|"")+"|[A-Za-z_][\w$#]*) ([a-z]+\d+)\b/g)) {
    const t = byName.get(m[1])
    if (t) alias.set(m[2], t)
  }
  const colOf = (t, name) => t.columns.find(c => quoteIdent(c.name) === name)
  const along = (a, ca, b, cb) => model.fks.some(fk => fk.fromTable === a && fk.toTable === b
    && fk.from.some((c, i) => c === ca && fk.to[i] === cb) && ca.notNull)
  const ident = '("(?:[^"]|"")+"|[A-Za-z_][\\w$#]*)'
  const eq = new RegExp(`\\b([a-z]+\\d+)\\.${ident} = ([a-z]+\\d+)\\.${ident}`, 'g')
  for (const m of query.matchAll(eq)) {
    const ta = alias.get(m[1]), tb = alias.get(m[3])
    if (!ta || !tb) continue
    const ca = colOf(ta, m[2]), cb = colOf(tb, m[4])
    if (!ca || !cb) continue
    if (!along(ta, ca, tb, cb) && !along(tb, cb, ta, ca))
      return { ok: true, likely: false, body, reason: `Oracle may refuse the join ${ta.name}.${ca.name} = ${tb.name}.${cb.name}, as it can only check joins along NOT NULL foreign keys fast` }
  }
  return { ok: true, likely: true, body, reason: null }
}
