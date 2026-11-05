// The population of a relational schema as a SQL data script (data exchange
// plan, step 3): INSERT statements or COPY blocks, one per stored table,
// parents before children (by foreign key), so the script loads into a
// database made from the schema's DDL (ddlExport.js). Views and fully
// derived columns are not written; a table with derived columns is stored as
// <name>_base, as in the DDL. Generated columns (serial, identity) get their
// values written and their sequences moved past the largest one.

import { relationalModel } from './relationalModel.js'
import { tableShape, tableRecords } from './records.js'
import { tableViews } from './viewSql.js'
import { typeSql } from './ddlExport.js'
import { quoteIdent as q } from './sqlNames.js'
import { valueKindName } from '../utils/datatypeValues.js'

const NUMERIC = new Set(['integer', 'decimal', 'float'])

// Tables in an order where every table comes after the tables its foreign
// keys refer to (a cycle is broken where it is met; such scripts need
// deferred constraints, which the result's notes say).
export function fkOrder(tables) {
  const out = [], state = new Map()
  let cyclic = false
  const visit = (t) => {
    if (state.get(t) === 2) return
    if (state.get(t) === 1) { cyclic = true; return }
    state.set(t, 1)
    for (const fk of t.fks) if (fk.toTable !== t) visit(fk.toTable)
    state.set(t, 2)
    out.push(t)
  }
  for (const t of tables) visit(t)
  return { order: out, cyclic }
}

const literal = (v, col) => {
  if (v == null) return 'NULL'
  const s = String(v)
  if (col.kind === 'boolean') return /^(true|1|t|yes)$/i.test(s) ? 'true' : 'false'
  if (NUMERIC.has(col.kind) && /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(s.trim())) return s.trim()
  return `'${s.replace(/'/g, "''")}'`
}

// COPY text format: \N for NULL, backslash escapes for \, tab, newline, CR.
const copyCell = (v, col) => {
  if (v == null) return '\\N'
  const s = col.kind === 'boolean' ? (/^(true|1|t|yes)$/i.test(String(v)) ? 't' : 'f') : String(v)
  return s.replace(/\\/g, '\\\\').replace(/\t/g, '\\t').replace(/\n/g, '\\n').replace(/\r/g, '\\r')
}

// { sql, tables: [{ name, rows }], notes: [text] }. format: 'insert' | 'copy'.
export function populationSql(state, schemaId, { format = 'insert', header = null } = {}) {
  const model = relationalModel(state, schemaId)
  const views = tableViews(state, model, typeSql)
  const { order, cyclic } = fkOrder(model.tables)
  const notes = []
  const lines = []
  if (header) lines.push(...header.split('\n').map(l => `-- ${l}`), '')
  if (cyclic) {
    notes.push('Some foreign keys form a cycle: load the script with the foreign keys deferred (or added after the data).')
    lines.push('-- Foreign keys form a cycle: run with deferred constraints, or add the foreign keys afterwards.', 'BEGIN;', 'SET CONSTRAINTS ALL DEFERRED;', '')
  }
  const written = []
  const sequences = []
  let invented = 0
  for (const t of order) {
    const view = views.get(t.id)
    if (view?.kind === 'view') continue
    const shape = tableShape(state, schemaId, t.id)
    if (!shape) continue
    if (!shape.keyFacts.length) { notes.push(`${t.name} has no primary key, so its rows are not stored and not written.`); continue }
    const skip = view?.kind === 'base' ? view.derivedCols : new Set()
    const cols = shape.columns.filter(c => !skip.has(c.factId)).map(c => {
      const mc = model.columnByFact.get(c.factId)
      return { ...c, kind: valueKindName(mc?.vt?.datatypeAssignment) ?? null, generated: mc?.generated ?? null }
    })
    const records = tableRecords(state, shape)
    if (!records.length) continue
    const name = view?.kind === 'base' ? view.baseName : t.name
    written.push({ name, rows: records.length })
    const colList = cols.map(c => q(c.name)).join(', ')
    for (const r of records) for (const c of cols) if (typeof r.values[c.factId] === 'string' && r.values[c.factId].startsWith('⟨')) invented++
    if (format === 'copy') {
      lines.push(`COPY ${q(name)} (${colList}) FROM stdin;`)
      for (const r of records) lines.push(cols.map(c => copyCell(r.values[c.factId], c)).join('\t'))
      lines.push('\\.', '')
    } else {
      lines.push(`INSERT INTO ${q(name)} (${colList}) VALUES`)
      lines.push(records.map(r => `  (${cols.map(c => literal(r.values[c.factId], c)).join(', ')})`).join(',\n') + ';', '')
    }
    for (const c of cols) if (c.generated) sequences.push({ table: name, col: c.name })
  }
  if (sequences.length) {
    lines.push('-- Move the sequences of generated columns past the values written.')
    for (const s of sequences) {
      const tl = `'${q(s.table).replace(/'/g, "''")}'`
      lines.push(`SELECT setval(pg_get_serial_sequence(${tl}, '${s.col.replace(/'/g, "''")}'), COALESCE(MAX(${q(s.col)}), 0) + 1, false) FROM ${q(s.table)};`)
    }
    lines.push('')
  }
  if (cyclic) lines.push('COMMIT;', '')
  if (invented) notes.push(`${invented} values were invented by a run (⟨…⟩) for columns that are not generated; they are written as text.`)
  if (!written.length) notes.push('The schema has no rows to write.')
  return { sql: lines.join('\n'), tables: written, notes }
}
