// Table rules as SQL views (relational Fold plan, follow-up).
//
// A table rule (derivedTables.js) gives rows of a table, or values of some of
// its columns, by a query written as a mapping pattern. In PostgreSQL:
//
//   - a table whose rows are derived (kind 'table', ⟺) is a view of that
//     name: SELECT DISTINCT over the pattern, a column the head leaves out
//     NULL;
//   - a table with derived columns, or with semi-derived rows or columns, is
//     stored as <name>_base (the columns that are not fully derived), and the
//     view <name> reads it: semi-derived rows are the stored ones UNION the
//     query's, each derived column comes from its query by the primary key
//     (LEFT JOIN), and a semi-derived column is the stored value, else the
//     query's (COALESCE).
//
// A pattern becomes FROM and WHERE: each row of a table (a row atom) is a
// table in FROM, a column read with a value is that value when it is not NULL,
// x ≈ 'c' and shared $y are equalities, an optional part [$y](…) is a LEFT
// JOIN LATERAL (or just the column, when it only reads one), and ¬(…) is NOT
// EXISTS.
//
// tableViews(state, model, typeSql) → Map(tableId → { kind: 'view' | 'base',
//   baseName, view: text | null, derivedCols: Set(factId), semiCols:
//   Set(factId), uses: Set(tableId), error }), for the tables that have rules.
//   A semi-derived column is stored without NOT NULL: the view gives its
//   value when the stored one is missing.

import { tableRulesOf } from './derivedTables.js'
import { treeToSide, expandSide, sideContext } from '../mapping/mapping.js'
import { quoteIdent as q } from './sqlNames.js'

class Unsupported extends Error {}
const no = (what) => { throw new Unsupported(what) }

const NUMBER = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/
const literal = (text) => {
  const t = String(text ?? '').trim().replace(/^'(.*)'$/s, '$1')
  return NUMBER.test(t) ? t : `'${t.replace(/'/g, "''")}'`
}

// The FROM, WHERE and $y values of a pattern (its flat, expanded form), in
// the scope of the outer one's rows and values.
function compile(side, model, outer, counter) {
  const rows = new Map(outer?.rows ?? []), vals = new Map(outer?.vals ?? []), ys = new Map(outer?.ys ?? [])
  const from = [], where = [], laterals = [], newYs = []
  const tableOf = (typeId) => model.tables.find(t => t.id === typeId)
  for (const v of side.vars ?? []) {
    const t = tableOf(v.typeId)
    if (!t) continue
    const alias = `t${++counter.n}`
    rows.set(v.id, { alias, table: t })
    from.push(`${q(counter.nameOf?.(t) ?? t.name)} ${alias}`)
  }
  const atoms = side.atoms ?? []
  for (const a of atoms) {
    if (a.t !== 'fact') continue
    const col = model.columnByFact.get(a.factId)
    if (!col) no('a fact type that is not a column')
    const row = rows.get(a.args[col.t])
    if (!row) no(`a column read without its row (${col.table.name}.${col.name})`)
    const e = `${row.alias}.${q(col.name)}`
    const v = a.args[col.v]
    if (v == null || !vals.has(v)) {
      if (!col.notNull) where.push(`${e} IS NOT NULL`)
      if (v != null) vals.set(v, e)
    } else where.push(`${e} = ${vals.get(v)}`)
  }
  for (const a of atoms) {
    if (a.t === 'const') {
      if (!vals.has(a.v)) no('a constant for a value no column gives')
      where.push(`${vals.get(a.v)} = ${literal(a.text)}`)
    } else if (a.t === 'bind') {
      if (!vals.has(a.v)) no(`$${a.y} for a value no column gives`)
      if (ys.has(a.y)) where.push(`${vals.get(a.v)} = ${ys.get(a.y)}`)
      else { ys.set(a.y, vals.get(a.v)); newYs.push(a.y) }
    }
  }
  for (const a of atoms) {
    if (a.t === 'opt') {
      const inner = compile(a, model, { rows, vals, ys }, counter)
      const got = inner.newYs
      // Only reading a column of a row already there: the column itself.
      if (!inner.from.length && !inner.laterals.length && got.length === 1
        && inner.where.every(w => w === `${inner.ys.get(got[0])} IS NOT NULL`)) {
        ys.set(got[0], inner.ys.get(got[0])); newYs.push(got[0])
        continue
      }
      const alias = `o${++counter.n}`
      const sel = got.length ? got.map(y => `${inner.ys.get(y)} AS ${q(y)}`).join(', ') : '1 AS present'
      laterals.push(`LEFT JOIN LATERAL (${selectText(sel, inner)} LIMIT 1) ${alias} ON TRUE`)
      for (const y of got) { ys.set(y, `${alias}.${q(y)}`); newYs.push(y) }
    } else if (a.t === 'not') {
      const inner = compile(a, model, { rows, vals, ys }, counter)
      where.push(inner.from.length || inner.laterals.length ? `NOT EXISTS (${selectText('1', inner)})` : `NOT (${inner.where.join(' AND ') || 'TRUE'})`)
    } else if (!['fact', 'const', 'bind', 'type'].includes(a.t)) no(`${a.t} in a pattern`)
  }
  return { from, where, laterals, ys, newYs }
}

function selectText(select, c, distinct = false) {
  const from = c.from.length ? ` FROM ${c.from.join(', ')}` : ''
  const lat = c.laterals.length ? `${c.from.length ? '' : ' FROM (SELECT 1) one'} ${c.laterals.join(' ')}` : ''
  const where = c.where.length ? ` WHERE ${c.where.join(' AND ')}` : ''
  return `SELECT ${distinct ? 'DISTINCT ' : ''}${select}${from}${lat}${where}`
}

// One rule's query: the head's columns (key first) from its body.
function ruleQuery(rule, table, model, ctx, cols, nullOf = () => 'NULL', self = null) {
  const side = expandSide(treeToSide(rule.body).side, ctx)
  // The table's own rows: its stored part (a view can't read itself).
  const nameOf = (t) => (t.id !== table.id ? t.name : self ?? no(`the rule of ${table.name} reads ${table.name} itself`))
  const c = compile(side, model, null, { n: 0, nameOf })
  const sel = cols.map(col => {
    const h = rule.head?.[col.fact.id]
    if (!h) return `${nullOf(col)} AS ${q(col.name)}`
    if (!c.ys.has(h.y)) no(`$${h.y} is not given by the query`)
    return `${c.ys.get(h.y)} AS ${q(col.name)}`
  })
  const uses = new Set()
  for (const v of side.vars ?? []) if (model.tables.some(t => t.id === v.typeId)) uses.add(v.typeId)
  const walk = (atoms) => { for (const a of atoms ?? []) { if (a.vars) for (const v of a.vars) if (model.tables.some(t => t.id === v.typeId)) uses.add(v.typeId); if (a.atoms) walk(a.atoms) } }
  walk(side.atoms)
  return { text: selectText(sel.join(', '), c, true), uses }
}

export function tableViews(state, model, typeSql) {
  const out = new Map()
  let ctx = null
  for (const t of model.tables) {
    const rules = tableRulesOf(t.entity).filter(r => r.body && r.head)
    if (!rules.length) continue
    ctx ??= sideContext(state, t.entity.schemaId)
    const key = new Set((t.pk ?? []).map(c => c.fact.id))
    const rowRule = rules.find(r => r.kind === 'table')
    const colRules = rules.filter(r => r.kind === 'columns')
    const derivedCols = new Set(), semiCols = new Map()
    for (const r of rules) for (const id of Object.keys(r.head)) {
      if (key.has(id)) continue
      if (r.mode === 'derived') derivedCols.add(id); else semiCols.set(id, r)
    }
    const res = { kind: 'base', baseName: `${t.name}_base`, view: null, derivedCols, semiCols: new Set(semiCols.keys()), uses: new Set(), error: null }
    try {
      if (!t.pk?.length) no(`${t.name} has no primary key`)
      const rowsView = rowRule?.mode === 'derived'
      if (rowsView) { res.kind = 'view'; res.baseName = null }
      const typed = (c) => { const ty = typeSql(c.vt.datatypeAssignment, null); return ty ? `NULL::${ty}` : 'NULL' }
      // Columns a columns rule derives fully: never stored, never in the rows' query.
      const colDerived = new Set(colRules.filter(r => r.mode === 'derived').flatMap(r => Object.keys(r.head).filter(id => !key.has(id))))
      const baseCols = t.columns.filter(c => !(rowsView ? colDerived : derivedCols).has(c.fact.id))
      // The rows: stored, derived, or both.
      let base
      if (rowsView) {
        const r = ruleQuery(rowRule, t, model, ctx, baseCols, typed)
        r.uses.forEach(u => res.uses.add(u))
        base = r.text
      } else {
        base = `SELECT ${baseCols.map(c => q(c.name)).join(', ')} FROM ${q(res.baseName)}`
        if (rowRule) {
          // Semi-derived rows: the query's, besides the stored ones.
          const r = ruleQuery(rowRule, t, model, ctx, baseCols, typed, res.baseName)
          r.uses.forEach(u => res.uses.add(u))
          base = `${base}\n  UNION\n  ${r.text.replace(/^SELECT DISTINCT /, 'SELECT ')}`
        }
      }
      if (rowsView && !colRules.length) res.view = `CREATE VIEW ${q(t.name)} AS\n  ${base};`
      else {
        const joins = [], sel = new Map(baseCols.map(c => [c.fact.id, `b.${q(c.name)}`]))
        colRules.forEach((r, i) => {
          const a = `d${i + 1}`
          const own = Object.keys(r.head).filter(id => !key.has(id))
          const cols = [...t.pk, ...own.map(id => model.columnByFact.get(id))]
          const rq = ruleQuery(r, t, model, ctx, cols, undefined, rowsView ? null : res.baseName)
          rq.uses.forEach(u => res.uses.add(u))
          joins.push(`LEFT JOIN (${rq.text}) ${a} ON ${t.pk.map(c => `${a}.${q(c.name)} = b.${q(c.name)}`).join(' AND ')}`)
          for (const id of own) {
            const name = q(model.columnByFact.get(id).name)
            sel.set(id, r.mode === 'derived' ? `${a}.${name}` : `COALESCE(b.${name}, ${a}.${name})`)
          }
        })
        const list = t.columns.map(c => `${sel.get(c.fact.id) ?? typed(c)} AS ${q(c.name)}`)
        const fromB = !rowsView && !rowRule ? `${q(res.baseName)} b` : `(${base}) b`
        res.view = `CREATE VIEW ${q(t.name)} AS\n  SELECT ${list.join(', ')}\n  FROM ${fromB}${joins.map(j => `\n  ${j}`).join('')};`
      }
      res.uses.delete(t.id)
    } catch (err) {
      if (!(err instanceof Unsupported)) throw err
      res.error = err.message
      res.kind = 'table'
    }
    out.set(t.id, res)
  }
  return out
}

// The views in an order in which each comes after the views it reads.
export function viewOrder(views) {
  const out = [], seen = new Set()
  const visit = (id, stack = new Set()) => {
    if (seen.has(id) || stack.has(id)) return
    stack.add(id)
    for (const u of views.get(id)?.uses ?? []) if (views.get(u)?.view) visit(u, stack)
    seen.add(id)
    out.push(id)
  }
  for (const [id, v] of views) if (v.view) visit(id)
  return out
}
