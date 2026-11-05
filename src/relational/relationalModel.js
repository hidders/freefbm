// Reads a relational schema (encoding B, docs/logic/schema-mappings.tex) back
// as tables: the view that the DDL export and the ERD view share.
//
// relationalModel(state, schemaId) → {
//   tables: [{ id, name, entity, columns: [col], pk: [col] | null, uniques: [[col]], fks: [fk] }],
//   columnByFact: Map(factId → col),
//   fks: [{ from: [col], to: [col], fromTable, toTable, constraintId }],
//   notColumns: [fact],      // fact types that are not columns
//   notExported: [text],     // constraints with no table form
//   unwritten: [constraint], // those constraints (formulaSql.js may still
//                            // write them as a CHECK or a violation query)
//   (each table also has checks: [{ name, text, constraintId }], the formula
//   constraints read from CHECK constraints, and pkSource / uniqueSources
//   (parallel to uniques): { ucId | constraintId, sqlName }, the element each
//   key comes from; each fk has constraintId and sqlName)
// }
// col: { fact, table, vt, t (table role index), v (value role index), name,
//        notNull, generated, pk, unique, fk }

import { sqlCheckOf, VC_SQL } from './checkFormula.js'

const quoteName = (n) => (/^[a-z_][a-z0-9_$]*$/.test(n) ? n : `"${n.replace(/"/g, '""')}"`)

export function relationalModel(state, schemaId) {
  const inSchema = (x) => !schemaId || x.schemaId === schemaId
  const ots = (state.objectTypes ?? []).filter(inSchema)
  const facts = (state.facts ?? []).filter(f => inSchema(f) && !f._implicit)
  const constraints = (state.constraints ?? []).filter(inSchema)
  const otById = new Map(ots.map(o => [o.id, o]))

  const tables = ots.filter(o => o.kind === 'entity').map(e => ({ id: e.id, name: e.name, entity: e, columns: [], pk: null, uniques: [], fks: [], checks: [],
    pkSource: null, uniqueSources: [] }))
  const tableById = new Map(tables.map(t => [t.id, t]))
  const columnByFact = new Map()
  const notColumns = []
  for (const f of facts) {
    const kinds = f.roles.map(r => otById.get(r.objectTypeId)?.kind)
    if (f.roles.length !== 2 || f.objectified || kinds.filter(k => k === 'entity').length !== 1 || !kinds.includes('value')) {
      notColumns.push(f)
      continue
    }
    const t = kinds.indexOf('entity'), v = 1 - t
    const vt = otById.get(f.roles[v].objectTypeId)
    const table = tableById.get(f.roles[t].objectTypeId)
    const col = { fact: f, table, vt, t, v, name: f.roles[v].roleName?.trim() || vt.name,
      notNull: !!f.roles[t].mandatory, generated: f.roles[v].sqlGenerated ?? null,
      pk: false, unique: false, fk: false,
      singleValued: (f.uniqueness ?? []).some(u => u.roles?.length === 1 && u.roles[0] === t) }
    columnByFact.set(f.id, col)
    table.columns.push(col)
  }

  // Role members of a sequence as columns of one table, or null.
  const asColumns = (seq) => {
    const cols = (seq ?? []).map(m => {
      const c = m?.kind === 'role' ? columnByFact.get(m.factId) : null
      return c && m.roleIndex === c.v ? c : null
    })
    if (!cols.length || cols.some(c => !c)) return null
    return new Set(cols.map(c => c.table.id)).size === 1 ? cols : null
  }

  for (const col of columnByFact.values()) {
    const f = col.fact
    const uc = (f.uniqueness ?? []).find(u => u.roles?.length === 1 && u.roles[0] === col.v)
    const source = { ucId: uc?.id ?? null, sqlName: uc?.sqlName ?? null }
    if ((f.preferredUniqueness ?? []).some(u => u.length === 1 && u[0] === col.v)) { col.table.pk = [col]; col.table.pkSource = source }
    else if (uc) { col.table.uniques.push([col]); col.table.uniqueSources.push(source) }
  }
  const fks = []
  const notExported = [], unwritten = []
  const skip = (c, text) => { notExported.push(text); unwritten.push(c) }
  for (const c of constraints) {
    if (c.constraintType === 'uniqueness') {
      const cols = asColumns(c.sequences?.[0])
      if (!cols) { skip(c, `external uniqueness constraint ${c.id} (not over the columns of one table)`); continue }
      const source = { constraintId: c.id, sqlName: c.sqlName ?? null }
      if (c.isPreferredIdentifier) { cols[0].table.pk = cols; cols[0].table.pkSource = source }
      else { cols[0].table.uniques.push(cols); cols[0].table.uniqueSources.push(source) }
      continue
    }
    if (c.constraintType === 'subset' && c.sequences?.length === 2) {
      const from = asColumns(c.sequences[0]), to = asColumns(c.sequences[1])
      if (from && to && from.length === to.length) {
        const fk = { from, to, fromTable: from[0].table, toTable: to[0].table, constraintId: c.id, sqlName: c.sqlName ?? null }
        fks.push(fk)
        fk.fromTable.fks.push(fk)
        continue
      }
      skip(c, `subset constraint ${c.id} (not between the columns of two tables)`)
      continue
    }
    if (c.constraintType === 'valueComparison') {
      // Two columns of one table compared: CHECK (a op b).
      const cols = asColumns(c.sequences?.[0])
      if (cols?.length === 2 && VC_SQL[c.operator ?? '=']) {
        cols[0].table.checks.push({ name: c.name || null, constraintId: c.id,
          text: `${quoteName(cols[0].name)} ${VC_SQL[c.operator ?? '=']} ${quoteName(cols[1].name)}` })
        continue
      }
      skip(c, `value comparison constraint ${c.name || c.id} (not between two columns of one table)`)
      continue
    }
    if (c.constraintType === 'formula') {
      const ch = sqlCheckOf(c, (factId) => columnByFact.get(factId)?.name ?? null, quoteName)
      const table = ch.text && tableById.get(ch.table)
      if (table) table.checks.push({ name: ch.name, text: ch.text, constraintId: c.id })
      else skip(c, `formula constraint ${c.name || c.id} (${ch.reason ?? 'not over one table'})`)
      continue
    }
    skip(c, `${c.constraintType} constraint ${c.id}`)
  }
  for (const t of tables) {
    for (const c of t.pk ?? []) { c.pk = true; c.notNull = true }
    for (const u of t.uniques) if (u.length === 1) u[0].unique = true
    for (const fk of t.fks) for (const c of fk.from) c.fk = true
  }
  nameKeys(tables, fks)
  return { tables, columnByFact, fks, notColumns, notExported, unwritten }
}

// PostgreSQL's default name for a constraint of table over cols (truncated to
// 63 bytes, as PostgreSQL does): <table>_<col>_…_<suffix>, or <table>_<suffix>
// for a primary key and a CHECK over no single column.
export function defaultConstraintName(table, cols, suffix) {
  const parts = suffix === 'pkey' || !cols?.length ? [table] : [table, ...cols]
  const name = `${parts.join('_')}_${suffix}`
  return name.length > 63 ? `${parts.join('_').slice(0, 63 - suffix.length - 1)}_${suffix}` : name
}

// Names the keys and foreign keys: their own name (sqlName, from the script)
// or PostgreSQL's default. Primary and unique keys are indexes, so their names
// are unique in the schema; foreign key names are unique per table. A name
// already taken gets a number, as PostgreSQL does (film_pkey1), and is then no
// longer marked explicit. Sets t.pkName, t.uniqueNames (parallel to uniques)
// and fk.name, each { name, explicit }.
function nameKeys(tables, fks) {
  const take = (used, src, def) => {
    let name = src?.sqlName || def
    const explicit = !!src?.sqlName && !used.has(name)
    for (let i = 1; used.has(name); i++) name = `${src?.sqlName || def}${i}`
    used.add(name)
    return { name, explicit }
  }
  const indexes = new Set()
  // Explicit names first, so a default never takes a name the script gave.
  const ordered = (items) => [...items.filter(x => x.src?.sqlName), ...items.filter(x => !x.src?.sqlName)]
  const keys = tables.flatMap(t => [
    ...(t.pk ? [{ t, src: t.pkSource, cols: t.pk, suffix: 'pkey', set: (n) => { t.pkName = n } }] : []),
    ...t.uniques.map((u, i) => ({ t, src: t.uniqueSources[i], cols: u, suffix: 'key', set: (n) => { (t.uniqueNames ??= [])[i] = n } })),
  ])
  for (const k of ordered(keys)) k.set(take(indexes, k.src, defaultConstraintName(k.t.name, k.cols.map(c => c.name), k.suffix)))
  const perTable = new Map()
  for (const fk of ordered(fks.map(fk => ({ fk, src: fk }))).map(x => x.fk)) {
    if (!perTable.has(fk.fromTable)) perTable.set(fk.fromTable, new Set())
    fk.name = take(perTable.get(fk.fromTable), fk, defaultConstraintName(fk.fromTable.name, fk.from.map(c => c.name), 'fkey'))
  }
}

// Whether the columns are a key (primary or unique) of their table.
export function isKey(table, cols) {
  const same = (k) => k.length === cols.length && k.every(c => cols.includes(c))
  return !!(table.pk && same(table.pk)) || table.uniques.some(same)
}
