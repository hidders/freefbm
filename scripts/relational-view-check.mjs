// Checks relationalView (src/relational/relationalView.js) against the DDL
// export on PostgreSQL scripts: each script is imported as a relational
// schema, and the view's tables, views, keys, foreign keys, CHECKs and NOT
// NULLs (the enforced ones) must match what the export writes; every element
// of the schema must be an object's member or listed as unmapped; and the
// export, imported again, must give the same objects with the same names.
//
//   node scripts/relational-view-check.mjs file.sql …     exit 1 on a difference
//
// The test schemas (Chinook, Northwind, Pagila, AdventureWorks, University)
// are in the project files, test-schemas/postgres/.

import fs from 'fs'
import { importPostgresDdl } from '../src/relational/ddlImport.js'
import { exportPostgresDdl } from '../src/relational/ddlExport.js'
import { buildView } from '../src/relational/relationalView.js'

const files = process.argv.slice(2)
if (!files.length) { console.error('usage: node scripts/relational-view-check.mjs file.sql …'); process.exit(2) }

const stateOf = (built) => ({
  objectTypes: built.objectTypes, facts: built.facts, constraints: built.constraints, subtypes: [],
  schemas: [{ id: null, name: 'S', profile: 'relational' }],
})

// Counts of what the export writes, outside comments.
function exportCounts(sql) {
  const code = sql.split('\n').filter(l => !l.trimStart().startsWith('--')).join('\n')
  const n = (re) => (code.match(re) ?? []).length
  return {
    table: n(/^CREATE TABLE /gm), view: n(/^CREATE VIEW /gm),
    primaryKey: n(/PRIMARY KEY \(/g), unique: n(/\bUNIQUE \(/g), foreignKey: n(/FOREIGN KEY \(/g),
    check: n(/\bCHECK \(/g), notNull: n(/(?<!\bIS) NOT NULL\b/gi),
  }
}

function viewCounts(view) {
  const out = { table: 0, view: 0, primaryKey: 0, unique: 0, foreignKey: 0, check: 0, notNull: 0 }
  for (const o of view.objects.values()) {
    if (o.kind === 'table' || o.kind === 'view') {
      // A table whose rules have no SQL form is written as a table.
      if (o.kind === 'view' && o.error) out.table++
      else out[o.kind]++
    } else if (o.kind in out && o.enforced) out[o.kind]++
  }
  return out
}

const signature = (view) => [...view.objects.values()]
  .filter(o => o.kind !== 'assertion')
  .map(o => `${o.kind} ${o.label}${o.sql ? ` ${o.sql}` : ''}`).sort()

// What an element id is, for a message.
const describe = (state) => (id) => {
  const o = state.objectTypes.find(x => x.id === id)
  if (o) return `${o.kind} ${o.name}`
  const f = state.facts.find(x => x.id === id)
  if (f) return `fact ${f.readingParts?.join(' ')}`
  const c = state.constraints.find(x => x.id === id)
  if (c) return `${c.constraintType} ${c.name ?? ''}`
  const g = state.facts.find(x => x.uniqueness.some(u => u.id === id) || x.roles.some(r => r.mandatoryId === id))
  return g ? `uniqueness or mandatory of ${g.readingParts?.join(' ')}` : id
}

let failed = false
for (const file of files) {
  const sql = fs.readFileSync(file, 'utf8')
  const t0 = Date.now()
  const state = stateOf(importPostgresDdl(sql, { schemaId: null }))
  const view = buildView(state, null)
  const ms = Date.now() - t0
  const { sql: out, queries } = exportPostgresDdl(state, null)
  const want = exportCounts(out), got = viewCounts(view)
  const problems = []
  for (const k of Object.keys(want)) if (want[k] !== got[k]) problems.push(`${k}: export ${want[k]}, view ${got[k]}`)
  const asQueries = view.assertions.filter(a => a.query).length
  if (asQueries !== queries) problems.push(`assertions with a query: export ${queries}, view ${asQueries}`)

  // Every element is a member of an object, or unmapped.
  const unmapped = new Set(view.unmapped)
  const ids = [
    ...state.objectTypes.map(o => o.id), ...state.facts.map(f => f.id), ...state.constraints.map(c => c.id),
    ...state.facts.flatMap(f => f.uniqueness.map(u => u.id)),
    ...state.facts.flatMap(f => f.roles.map(r => r.mandatoryId).filter(Boolean)),
  ]
  const missing = ids.filter(id => !view.ofOrm.has(id) && !unmapped.has(id))
  if (missing.length) problems.push(`${missing.length} elements in no object, e.g. ${missing.slice(0, 3).map(describe(state)).join('; ')}`)

  // Export, import again: the same objects with the same names.
  const again = buildView(stateOf(importPostgresDdl(out, { schemaId: null })), null)
  const a = signature(view), b = signature(again)
  const onlyA = a.filter(x => !b.includes(x)), onlyB = b.filter(x => !a.includes(x))
  if (onlyA.length || onlyB.length) problems.push(`round trip differs: ${onlyA.slice(0, 3).join(' | ')} ⇄ ${onlyB.slice(0, 3).join(' | ')}`)

  const explicit = [...view.model.tables.flatMap(t => [t.pkName, ...(t.uniqueNames ?? [])]), ...view.model.fks.map(f => f.name)]
    .filter(n => n?.explicit).length
  console.log(`${file.split('/').pop()}: ${got.table} tables, ${got.view} views, ${got.primaryKey} PKs, ${got.unique} UNIQUE, `
    + `${got.foreignKey} FKs, ${got.check} CHECKs, ${got.notNull} NOT NULL, ${view.assertions.length} assertions, `
    + `${view.unmapped.length} unmapped; ${explicit} keys named in the script; ${ms} ms`)
  for (const p of problems) console.log(`  ✗ ${p}`)
  if (problems.length) failed = true
}
process.exit(failed ? 1 : 0)
