// Writes a relational schema as SQL Server DDL (2022 or later; constraint
// enforcement, stage 3). The same reading of the schema as the PostgreSQL
// and Oracle exports (ddlExport.js, oracleDdl.js), in T-SQL (sqlNames.js
// withDialect('sqlserver')): datatypes mapped to SQL Server's (a column read
// from a SQL Server script keeps its own type), CHECKs written from their
// formulas, and assertions as planned by planEnforcement (enforcement.js).
// SQL Server has neither CREATE ASSERTION nor deferred triggers, so an
// assertion is
//
//   indexedView a view WITH SCHEMABINDING of the rows breaking it, joined with
//              a table of two equal rows, with a unique clustered index, so
//              it can hold no rows; or, for uniqueness over a join, a view
//              grouped by the key and what is counted, with a unique index on
//              the key. SQL Server checks it in the statement itself.
//   trigger    a trigger per table the query reads, AFTER INSERT, UPDATE,
//              DELETE (once per statement), that throws when the query finds
//              a row breaking it; the statement is then rolled back.
//   audit      the query as a comment.
//
// SQL Server's UNIQUE allows only one NULL, unlike standard SQL's, so a
// UNIQUE over columns that may be NULL is written as a unique index filtered
// on those columns being NOT NULL, which is the standard meaning. Views and
// triggers must start a batch, so the script separates batches with GO
// (sqlcmd, SSMS).
//
// exportSqlServerDdl(state, schemaId, { assertions, overrides })
//   → { sql, warnings, queries, assertions, plan }

import { tableViews, viewOrder } from './viewSql.js'
import { valueKindName } from '../utils/datatypeValues.js'
import { relationalModel } from './relationalModel.js'
import { quoteIdent, withDialect, nativeType } from './sqlNames.js'
import { constraintsAsSql } from './formulaSql.js'
import { rangeSql } from './ddlExport.js'
import { planEnforcement, sqlSettings } from './enforcement.js'
import { relationalView } from './relationalView.js'

const snakeName = (name) => String(name ?? '').trim().replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '').toLowerCase()

// SQL types in SQL Server, and other profiles by their value kind.
// → { type, warning? } | null
export function sqlServerType(assignment, generated) {
  const identity = (t) => `${t} IDENTITY(1,1)`
  if (generated === 'serial') return { type: identity('INT') }
  if (generated === 'smallserial') return { type: identity('SMALLINT') }
  if (generated === 'bigserial') return { type: identity('BIGINT') }
  if (!assignment?.datatypeId) return null
  // A column read from a SQL Server script keeps its type.
  const own = nativeType(assignment, 'sqlserver')
  if (own) return { type: generated === 'identity' ? identity(own) : own }
  const p = assignment.params ?? {}
  const id = assignment.datatypeId
  let type = null, warning = null
  const chars = (n, nat = true) => (n == null || n > 4000 ? `${nat ? 'N' : ''}VARCHAR(MAX)` : `${nat ? 'N' : ''}VARCHAR(${n})`)
  if (assignment.profileId === 'postgresql') {
    const map = {
      smallint: 'SMALLINT', integer: 'INT', bigint: 'BIGINT', smallserial: 'SMALLINT', serial: 'INT', bigserial: 'BIGINT',
      real: 'REAL', 'double precision': 'FLOAT', money: 'MONEY', text: 'NVARCHAR(MAX)', bytea: 'VARBINARY(MAX)', boolean: 'BIT',
      date: 'DATE', uuid: 'UNIQUEIDENTIFIER', xml: 'XML', inet: 'NVARCHAR(45)', cidr: 'NVARCHAR(45)', macaddr: 'NVARCHAR(17)', macaddr8: 'NVARCHAR(23)',
    }
    if (id === 'numeric') {
      if (p.precision == null) { type = 'DECIMAL(38, 10)'; warning = 'SQL Server has no numeric without a precision; written as DECIMAL(38, 10)' }
      else type = `DECIMAL(${Math.min(p.precision, 38)}${p.scale != null ? `, ${p.scale}` : ''})`
      if (p.precision > 38) warning = `SQL Server's DECIMAL has at most 38 digits; written as DECIMAL(38${p.scale != null ? `, ${p.scale}` : ''})`
    }
    else if (id === 'character varying') type = chars(p.length)
    else if (id === 'character') type = p.length > 4000 ? 'NVARCHAR(MAX)' : `NCHAR(${p.length ?? 1})`
    else if (id === 'timestamp') type = `${p.withTimeZone ? 'DATETIMEOFFSET' : 'DATETIME2'}(${p.precision ?? 6})`
    else if (id === 'time') { type = `TIME(${p.precision ?? 6})`; if (p.withTimeZone) warning = 'SQL Server\'s TIME has no time zone' }
    else if (id === 'json' || id === 'jsonb') { type = 'NVARCHAR(MAX)'; warning = 'SQL Server 2022 has no JSON type; written as NVARCHAR(MAX)' }
    else if (id === 'interval') { type = 'NVARCHAR(100)'; warning = 'SQL Server has no interval type; written as NVARCHAR(100)' }
    else if (map[id]) type = map[id]
    else { type = 'NVARCHAR(MAX)'; warning = `SQL Server has no ${id === 'user-defined' ? p.sql || 'user-defined' : id} type; written as NVARCHAR(MAX)` }
  } else {
    const byKind = { integer: 'BIGINT', decimal: 'DECIMAL(38, 10)', float: 'FLOAT', boolean: 'BIT', date: 'DATE',
      datetime: 'DATETIME2', string: 'NVARCHAR(MAX)', hexBinary: 'VARBINARY(MAX)' }
    type = byKind[valueKindName(assignment)] ?? null
    if (!type) return null
  }
  if (generated === 'identity') type = identity(type)
  return { type, warning }
}

// A literal of a value range in T-SQL: booleans are 1 and 0.
const literalFor = (kind) => (v) => {
  const s = String(v).trim()
  if ((kind === 'integer' || kind === 'decimal' || kind === 'float') && /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(s)) return s
  if (kind === 'boolean' && /^(true|false)$/i.test(s)) return /^true$/i.test(s) ? '1' : '0'
  return `'${String(v).replace(/'/g, "''")}'`
}

export function exportSqlServerDdl(state, schemaId, options = {}) {
  // The relational view (cached, PostgreSQL text) before switching dialects.
  relationalView(state, schemaId)
  const own = sqlSettings((state.schemas ?? []).find(x => x.id === schemaId))
  const settings = { ...own, target: 'sqlserver',
    ...(options.assertions && { assertions: options.assertions === 'triggers' ? 'triggers' : 'audit' }),
    ...(options.overrides && { overrides: options.overrides }) }
  const plan = planEnforcement(state, schemaId, settings)
  return withDialect('sqlserver', () => write(state, schemaId, plan))
}

function write(state, schemaId, plan) {
  const q = quoteIdent
  const inSchema = (x) => !schemaId || x.schemaId === schemaId
  const model = relationalModel(state, schemaId)
  const { tables, fks, notColumns } = model
  const warnings = []
  const tableById = new Map(tables.map(t => [t.id, t]))
  const unwrittenNotes = []
  constraintsAsSql(state, model).forEach(({ c, entries }, i) => {
    for (const e of entries)
      if (e.check) tableById.get(e.check.tableId).checks.push({ name: entries.length === 1 ? c.name || null : null, text: e.check.text })
    const bad = entries.filter(e => !e.check && !e.query)
    if (bad.length) unwrittenNotes.push(`${model.notExported[i]}: ${bad.map(e => e.error).join('; ')}`)
  })
  for (const f of notColumns) warnings.push(`Fact type ${(f.readingParts ?? []).join(' ').trim() || f.id} is not a column and is not exported`)
  for (const t of tables) for (const col of t.columns)
    if (!col.singleValued) warnings.push(`${t.name}.${col.name} has no uniqueness constraint on the table's role; it is exported as an ordinary column`)

  const planned = plan.items.filter(x => x.kind === 'assertion' && x.entry?.query)
  const queries = planned.map(x => ({ ...x.entry, technique: x.technique, viewsOnly: !!x.viewsOnly }))
  const badFks = new Set(planned.filter(x => x.rmId.startsWith('fk:')).map(x => x.entry.constraintId))

  // Names of tables, constraints, indexes and triggers: one name space per
  // SQL schema in SQL Server (constraints and triggers share it with tables).
  const used = new Set(tables.map(t => t.name.toLowerCase()))
  const fresh = (base) => {
    let name = base.slice(0, 128)
    for (let i = 2; used.has(name.toLowerCase()); i++) name = `${base.slice(0, 124)}_${i}`
    used.add(name.toLowerCase())
    return name
  }
  const named = (n) => (n?.explicit ? `CONSTRAINT ${q(fresh(n.name))} ` : '')

  // Columns in a key or a foreign key: SQL Server can't index (MAX) types.
  const keyCols = new Set()
  for (const t of tables) {
    for (const c of t.pk ?? []) keyCols.add(c.fact.id)
    for (const u of t.uniques) for (const c of u) keyCols.add(c.fact.id)
  }
  for (const fk of fks) for (const c of [...fk.from, ...fk.to]) keyCols.add(c.fact.id)
  // … nor index them in a view.
  const viewed = queries.filter(x => x.technique === 'indexedView')
  for (const x of viewed) if (x.view.kind === 'unique') for (const id of x.view.keyCols) keyCols.add(id)
  const typeOf = (a, g) => sqlServerType(a, g)?.type ?? null

  const lines = ['-- SQL Server DDL (2022 or later) written by FreeFBM',
    '-- Run it with sqlcmd or SSMS: batches end with a line holding GO.', '']
  // Indexed views need these settings when their tables and they are made,
  // and in every session that changes those tables (the defaults of SSMS and
  // of the ODBC, OLE DB and .NET drivers; sqlcmd needs -I).
  if (viewed.length) lines.push('SET ANSI_NULLS, ANSI_PADDING, ANSI_WARNINGS, ARITHABORT, CONCAT_NULL_YIELDS_NULL, QUOTED_IDENTIFIER ON;',
    'SET NUMERIC_ROUNDABORT OFF;', 'GO', '')
  const views = tableViews(state, model, typeOf)
  const storedName = (t) => { const v = views.get(t.id); return v?.kind === 'base' ? v.baseName : t.name }
  const filtered = [], shortened = []
  for (const t of tables) {
    const view = views.get(t.id)
    if (view?.kind === 'table') warnings.push(`${t.name}: its table rules are not written as a view (${view.error})`)
    if (view?.kind === 'view') {
      if (t.uniques.length || t.checks.length) warnings.push(`${t.name} is a view: its UNIQUE and CHECK constraints are not enforced`)
      continue
    }
    const skip = view?.kind === 'base' ? view.derivedCols : new Set()
    const items = []
    for (const col of t.columns) {
      if (skip.has(col.fact.id)) continue
      const role = col.fact.roles[col.v]
      const ty = sqlServerType(col.vt.datatypeAssignment, col.generated)
      if (ty?.warning) warnings.push(`${t.name}.${col.name}: ${ty.warning}`)
      let type = ty?.type
      if (!type) { type = 'NVARCHAR(MAX)'; warnings.push(`${t.name}.${col.name}: ${col.vt.name} has no datatype SQL Server knows; written as NVARCHAR(MAX)`) }
      if (keyCols.has(col.fact.id) && /\((MAX)\)/i.test(type)) {
        const short = type.replace(/^N?VARCHAR\(MAX\)/i, 'NVARCHAR(450)').replace(/^VARBINARY\(MAX\)/i, 'VARBINARY(900)')
        if (short !== type) { shortened.push(`${t.name}.${col.name}`); type = short }
      }
      let line = `  ${q(col.name)} ${type}`
      if (col.notNull && !view?.semiCols?.has(col.fact.id)) line += ' NOT NULL'
      const kind = valueKindName(col.vt.datatypeAssignment) ?? ''
      for (const specs of [col.vt.valueRange, role.valueRange]) {
        const cond = specs?.length ? rangeSql(q(col.name), specs, false, literalFor(kind)) : null
        if (cond) line += ` CHECK (${cond})`
      }
      items.push(line)
    }
    if (t.pk) items.push(`  ${named(t.pkName)}PRIMARY KEY (${t.pk.map(c => q(c.name)).join(', ')})`)
    const kept = (cols) => cols.every(c => !skip.has(c.fact.id))
    t.uniques.forEach((u, i) => {
      if (!kept(u)) return
      // UNIQUE allows one NULL in SQL Server: a filtered unique index keeps
      // the standard meaning (rows with a NULL in the key are not compared).
      const nullable = u.filter(c => !c.notNull && !c.pk)
      if (nullable.length) filtered.push({ t, u, nullable, name: t.uniqueNames?.[i] })
      else items.push(`  ${named(t.uniqueNames?.[i])}UNIQUE (${u.map(c => q(c.name)).join(', ')})`)
    })
    for (const ch of t.checks) items.push(`  ${ch.name ? `CONSTRAINT ${q(fresh(ch.name))} ` : ''}CHECK (${ch.text})`)
    if (!t.columns.length) warnings.push(`Table ${t.name} has no columns`)
    if (view?.kind === 'base') lines.push(`-- ${t.name} is a view (below) over its stored part ${storedName(t)}.`)
    lines.push(`CREATE TABLE ${q(storedName(t))} (`, items.join(',\n'), ');', '')
  }
  if (shortened.length) warnings.push(`SQL Server can't index NVARCHAR(MAX) or VARBINARY(MAX), so these key columns are NVARCHAR(450) or VARBINARY(900): ${shortened.length > 12 ? `${shortened.slice(0, 12).join(', ')} and ${shortened.length - 12} more` : shortened.join(', ')}`)
  if (filtered.length) {
    lines.push('-- UNIQUE over columns that may be NULL: SQL Server\'s UNIQUE would allow only one',
      '-- NULL, so these are unique indexes over the rows where the columns are not NULL.', '')
    for (const { t, u, nullable, name } of filtered) {
      const ix = fresh(name?.explicit ? name.name : `${t.name}_${u.map(c => c.name).join('_')}_key`)
      lines.push(`CREATE UNIQUE INDEX ${q(ix)} ON ${q(storedName(t))} (${u.map(c => q(c.name)).join(', ')})`
        + ` WHERE ${nullable.map(c => `${q(c.name)} IS NOT NULL`).join(' AND ')};`)
    }
    lines.push('')
  }
  const isStored = (t, cols) => views.get(t.id)?.kind !== 'view' && cols.every(c => !views.get(t.id)?.derivedCols?.has(c.fact.id))
  const storedFks = fks.filter(fk => !badFks.has(fk.constraintId) && isStored(fk.fromTable, fk.from) && isStored(fk.toTable, fk.to))
  for (const fk of fks) if (!storedFks.includes(fk) && !badFks.has(fk.constraintId))
    warnings.push(`FOREIGN KEY ${fk.fromTable.name}(${fk.from.map(c => c.name).join(', ')}) → ${fk.toTable.name}(${fk.to.map(c => c.name).join(', ')}) is about a view or a derived column and is not enforced`)
  const filteredKey = (t, cols) => filtered.some(x => x.t === t && x.u.length === cols.length && x.u.every(c => cols.includes(c)))
  for (const fk of storedFks) {
    if (filteredKey(fk.toTable, fk.to)) warnings.push(`FOREIGN KEY ${fk.fromTable.name}(${fk.from.map(c => c.name).join(', ')}) → ${fk.toTable.name}: SQL Server refuses a foreign key to a filtered unique index`)
    lines.push(`ALTER TABLE ${q(storedName(fk.fromTable))} ADD ${named(fk.name)}FOREIGN KEY (${fk.from.map(c => q(c.name)).join(', ')})`
      + ` REFERENCES ${q(storedName(fk.toTable))} (${fk.to.map(c => q(c.name)).join(', ')});`)
  }
  if (storedFks.length) lines.push('')
  const cols = (cs) => cs.map(c => q(c.name)).join(', ')
  const asFks = queries.filter(x => x.technique === 'foreignKey' && !x.fk.existing)
  if (asFks.length) lines.push('-- Assertions that are foreign keys:', '')
  for (const x of asFks) {
    const { fk } = x
    lines.push(`-- ${x.label}`, `--   ${x.text}`)
    if (fk.addUnique) lines.push(`ALTER TABLE ${q(storedName(fk.toTable))} ADD UNIQUE (${cols(fk.to)});`)
    lines.push(`ALTER TABLE ${q(storedName(fk.fromTable))} ADD ${x.name ? `CONSTRAINT ${q(fresh(snakeName(x.name)))} ` : ''}FOREIGN KEY (${cols(fk.from)})`
      + ` REFERENCES ${q(storedName(fk.toTable))} (${cols(fk.to)});`, '')
  }
  lines.push('GO', '')
  const order = viewOrder(views)
  if (order.length) {
    lines.push('-- Tables with derived rows or columns (table rules), as views:', '')
    for (const id of order) lines.push(views.get(id).view, 'GO', '')
  }

  // Assertions: indexed views, triggers and audit queries.
  // Unnamed assertions are numbered across views and triggers.
  const unnamed = new Map([...viewed, ...queries.filter(x => x.technique === 'trigger')].filter(x => !snakeName(x.name)).map((x, i) => [x, `assertion_${i + 1}`]))
  if (viewed.length) {
    const two = viewed.some(x => x.view.kind === 'empty') ? fresh('freefbm_two_rows') : null
    lines.push('-- Assertions, enforced by indexed views: SQL Server keeps each view up to date',
      '-- in the statement that changes its tables, and the view\'s unique index refuses',
      '-- a change that breaks the assertion.', '')
    if (two) lines.push(`-- Two equal rows: a view that joins them holds each row breaking an assertion`,
      '-- twice, which a unique index refuses.',
      `CREATE TABLE ${q(two)} (one INT NOT NULL CHECK (one = 1));`, `INSERT INTO ${q(two)} (one) VALUES (1), (1);`, 'GO', '')
    viewed.forEach((x) => {
      const v = x.view
      const name = fresh(snakeName(x.name) || unnamed.get(x))
      const from = v.from.map(({ table, alias }) => `dbo.${q(storedName(table))} ${alias}`)
      const where = v.where.length ? [`  WHERE ${v.where.join('\n    AND ')}`] : []
      lines.push(`-- ${x.label}`, `--   ${x.text}`)
      if (v.kind === 'empty') {
        const body = ['  SELECT two.one', `  FROM ${[...from, `dbo.${q(two)} two`].join(', ')}`, ...where]
        body[body.length - 1] += ';'
        lines.push(`CREATE VIEW dbo.${q(name)} WITH SCHEMABINDING AS`, ...body, 'GO',
          `CREATE UNIQUE CLUSTERED INDEX ${q(`${name}_none`)} ON dbo.${q(name)} (one);`, 'GO', '')
      } else {
        const ks = v.key.map((k, j) => `k${j + 1}`), cs = v.counted.map((c, j) => `c${j + 1}`)
        lines.push(`CREATE VIEW dbo.${q(name)} WITH SCHEMABINDING AS`,
          `  SELECT ${[...v.key.map((k, j) => `${k} AS ${ks[j]}`), ...v.counted.map((c, j) => `${c} AS ${cs[j]}`), 'COUNT_BIG(*) AS n'].join(', ')}`,
          `  FROM ${from.join(', ')}`, ...where, `  GROUP BY ${[...v.key, ...v.counted].join(', ')};`, 'GO',
          `CREATE UNIQUE CLUSTERED INDEX ${q(`${name}_rows`)} ON dbo.${q(name)} (${[...ks, ...cs].join(', ')});`,
          `CREATE UNIQUE INDEX ${q(`${name}_once`)} ON dbo.${q(name)} (${ks.join(', ')});`, 'GO', '')
      }
    })
  }
  const indent = (text, pad) => text.split('\n').map(l => `${pad}${l}`)
  const tsqlString = (s) => `N'${String(s).replace(/'/g, "''")}'`
  const triggerSql = (x, base, table) => {
    const what = `assertion ${x.name ? `${x.name} (${x.kind})` : x.kind} is violated`.slice(0, 2000)
    const head = [`CREATE TRIGGER ${q(fresh(`${base}_on_${table}`))} ON ${q(table)}`, 'AFTER INSERT, UPDATE, DELETE AS', 'BEGIN', '  SET NOCOUNT ON;']
    // A recursive WITH can't be inside EXISTS: the violations are counted.
    const check = x.with
      ? ['  DECLARE @violated INT;', ...indent(x.with, '  '), '  SELECT @violated = COUNT(*) FROM (', ...indent(x.body, '    '), '  ) AS v OPTION (MAXRECURSION 0);',
        `  IF @violated > 0 THROW 50001, ${tsqlString(what)}, 1;`]
      : ['  IF EXISTS (', ...indent(x.query, '    '), `  ) THROW 50001, ${tsqlString(what)}, 1;`]
    return [...head, ...check, 'END;', 'GO'].join('\n')
  }
  const onTables = (x) => [...new Set((x.tables ?? []).map(id => tableById.get(id)).filter(t => t && views.get(t.id)?.kind !== 'view').map(storedName))]
  const triggered = queries.filter(x => x.technique === 'trigger')
  const commented = queries.filter(x => x.technique === 'audit')
  if (triggered.length) {
    lines.push('-- Assertions, enforced by triggers: each statement that changes a table an',
      '-- assertion reads runs its query and fails (THROW, rolling the statement back)',
      '-- when it finds a row breaking it. SQL Server has no deferred triggers, so the',
      '-- check is after each statement: insert rows in an order that keeps it true.', '')
    triggered.forEach((x) => {
      const base = snakeName(x.name) || unnamed.get(x)
      lines.push(`-- ${x.label}`, `--   ${x.text}`)
      for (const t of onTables(x)) lines.push(triggerSql(x, base, t))
      lines.push('')
    })
  }
  if (commented.length) {
    lines.push('-- Constraints that SQL Server does not enforce here, as queries that return',
      '-- the rows breaking them (none when the data satisfies them):', '')
    for (const x of commented) {
      lines.push(`-- ${x.label}${x.deontic ? ' (deontic: ought to hold)' : ''}`, `--   ${x.text}`,
        ...`${x.query};`.split('\n').map(l => `-- ${l}`), '')
      if (x.viewsOnly) warnings.push(`${x.label}: it reads only views, so it gets no trigger`)
    }
  }
  const otById = new Map((state.objectTypes ?? []).map(o => [o.id, o]))
  const notes = [...unwrittenNotes]
  for (const s of (state.subtypes ?? []).filter(inSchema)) notes.push(`subtype ${otById.get(s.subId)?.name} of ${otById.get(s.superId)?.name}`)
  for (const t of tables) for (const col of t.columns)
    if ((col.fact.internalFrequency ?? []).length) notes.push(`frequency constraint on ${t.name}.${col.name}`)
  for (const o of (state.objectTypes ?? []).filter(inSchema))
    if (o.cardinalityRange?.length) notes.push(`cardinality range of ${o.name}`)
  for (const t of tables) for (const col of t.columns)
    if (col.fact.roles.some(r => r.cardinalityRange?.length)) notes.push(`cardinality range on ${t.name}.${col.name}`)
  for (const n of notes) warnings.push(`Not exported: ${n}`)
  if (warnings.length) lines.push('-- Not written as SQL:', ...warnings.map(w => `--   ${w}`), '')
  return {
    sql: lines.join('\n'), warnings, queries: queries.length, plan,
    assertions: queries.map(x => ({ label: x.label, text: x.text, deontic: !!x.deontic, technique: x.technique })),
  }
}
