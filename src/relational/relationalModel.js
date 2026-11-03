// Reads a relational schema (encoding B, docs/logic/schema-mappings.tex) back
// as tables: the view that the DDL export and the ERD view share.
//
// relationalModel(state, schemaId) → {
//   tables: [{ id, name, entity, columns: [col], pk: [col] | null, uniques: [[col]], fks: [fk] }],
//   columnByFact: Map(factId → col),
//   fks: [{ from: [col], to: [col], fromTable, toTable, constraintId }],
//   notColumns: [fact],      // fact types that are not columns
//   notExported: [text],     // constraints with no table form
//   (each table also has checks: [{ name, text, constraintId }], the formula
//   constraints read from CHECK constraints)
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

  const tables = ots.filter(o => o.kind === 'entity').map(e => ({ id: e.id, name: e.name, entity: e, columns: [], pk: null, uniques: [], fks: [], checks: [] }))
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
    if ((f.preferredUniqueness ?? []).some(u => u.length === 1 && u[0] === col.v)) col.table.pk = [col]
    else if ((f.uniqueness ?? []).some(u => u.roles?.length === 1 && u.roles[0] === col.v)) col.table.uniques.push([col])
  }
  const fks = []
  const notExported = []
  for (const c of constraints) {
    if (c.constraintType === 'uniqueness') {
      const cols = asColumns(c.sequences?.[0])
      if (!cols) { notExported.push(`external uniqueness constraint ${c.id} (not over the columns of one table)`); continue }
      if (c.isPreferredIdentifier) cols[0].table.pk = cols
      else cols[0].table.uniques.push(cols)
      continue
    }
    if (c.constraintType === 'subset' && c.sequences?.length === 2) {
      const from = asColumns(c.sequences[0]), to = asColumns(c.sequences[1])
      if (from && to && from.length === to.length) {
        const fk = { from, to, fromTable: from[0].table, toTable: to[0].table, constraintId: c.id }
        fks.push(fk)
        fk.fromTable.fks.push(fk)
        continue
      }
      notExported.push(`subset constraint ${c.id} (not between the columns of two tables)`)
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
      notExported.push(`value comparison constraint ${c.name || c.id} (not between two columns of one table)`)
      continue
    }
    if (c.constraintType === 'formula') {
      const ch = sqlCheckOf(c, (factId) => columnByFact.get(factId)?.name ?? null, quoteName)
      const table = ch.text && tableById.get(ch.table)
      if (table) table.checks.push({ name: ch.name, text: ch.text, constraintId: c.id })
      else notExported.push(`formula constraint ${c.name || c.id} (${ch.reason ?? 'not over one table'})`)
      continue
    }
    notExported.push(`${c.constraintType} constraint ${c.id}`)
  }
  for (const t of tables) {
    for (const c of t.pk ?? []) { c.pk = true; c.notNull = true }
    for (const u of t.uniques) if (u.length === 1) u[0].unique = true
    for (const fk of t.fks) for (const c of fk.from) c.fk = true
  }
  return { tables, columnByFact, fks, notColumns, notExported }
}

// Whether the columns are a key (primary or unique) of their table.
export function isKey(table, cols) {
  const same = (k) => k.length === cols.length && k.every(c => cols.includes(c))
  return !!(table.pk && same(table.pk)) || table.uniques.some(same)
}
