// Enforcing a relational schema's constraints in a target SQL DBMS (the plan
// in the Claude doc "Enforcing constraints per SQL DBMS"; stage 1, PostgreSQL).
//
// A relational schema is DBMS-neutral: any constraint over its tables is
// fine. Which of them a DBMS enforces, and how, is decided here, per target,
// by going down a ladder of techniques for each constraint and taking the
// first one the target has:
//
//   table      the table form: NOT NULL, PRIMARY KEY, UNIQUE, FOREIGN KEY, CHECK
//   check      a constraint about one row, written as a CHECK (formulaSql.js)
//   foreignKey an assertion that is a foreign key (foreignKeyRewrite.js),
//              written as one; with a UNIQUE first when its columns are more
//              than a key
//   trigger    an assertion, as a trigger that runs its violation query
//              (PostgreSQL: a constraint trigger, deferred to the end of the
//              transaction)
//   audit      an assertion, as a commented query that returns the rows
//              breaking it (run it to check the data)
//   none       not written: about a view or a derived column, or no SQL form
//
// Whether an assertion becomes a trigger or an audit query is the user's
// choice (schema.sql.assertions, default triggers), per constraint too
// (schema.sql.overrides[rmId]); deontic constraints are always audit queries.
//
// planEnforcement(state, schemaId, settings?) → { target, items, counts }
//   item: { rmId | null, label, kind, technique, status ('enforced' | 'partly'
//           | 'not'), note, choice ('trigger' | 'audit' | null: the user's
//           choice applies), entry (assertions: the export's query entry) }
//   counts: { enforced, partly, not }

import { relationalView } from './relationalView.js'
import { constraintsAsSql } from './formulaSql.js'
import { isKey } from './relationalModel.js'
import { tableViews } from './viewSql.js'
import { asForeignKey } from './foreignKeyRewrite.js'
import { typeSql } from './ddlExport.js'

// The SQL DBMSs a schema can be written for. Only PostgreSQL is written yet;
// the others are the plan's next stages.
export const SQL_TARGETS = [
  { id: 'postgresql', name: 'PostgreSQL', ready: true, deferredTriggers: true, assertions: false },
  { id: 'oracle', name: 'Oracle', ready: false },
  { id: 'sqlserver', name: 'SQL Server', ready: false },
  { id: 'mysql', name: 'MySQL', ready: false },
  { id: 'sqlite', name: 'SQLite', ready: false },
]
export const targetOf = (id) => SQL_TARGETS.find(t => t.id === id && t.ready) ?? SQL_TARGETS[0]

// A schema's SQL settings (saved with the schema), with their defaults.
export function sqlSettings(schema) {
  const s = schema?.sql ?? {}
  return {
    target: targetOf(s.target).id,
    assertions: s.assertions === 'audit' ? 'audit' : 'triggers',
    overrides: s.overrides && typeof s.overrides === 'object' ? s.overrides : {},
  }
}

const TECHNIQUE = {
  table: 'table constraint', check: 'CHECK', foreignKey: 'FOREIGN KEY', trigger: 'trigger',
  audit: 'audit query', none: 'not written',
}
export const techniqueName = (t) => TECHNIQUE[t] ?? t

export function planEnforcement(state, schemaId, settings0 = null) {
  const settings = settings0 ?? sqlSettings((state.schemas ?? []).find(s => s.id === schemaId))
  const target = targetOf(settings.target)
  const view = relationalView(state, schemaId)
  const model = view.model
  const items = []
  const item = (x) => { items.push({ rmId: null, note: null, choice: null, entry: null, ...x }); return x }

  // The table form, from the relational view (a view's keys are not enforced).
  const unwrittenIds = new Set(model.unwritten.map(c => c.id))
  for (const o of view.objects.values()) {
    if (!['notNull', 'primaryKey', 'unique', 'foreignKey', 'check'].includes(o.kind)) continue
    if (o.kind === 'foreignKey') {
      const fk = model.fks.find(x => `fk:${x.constraintId}` === o.rmId)
      if (fk && !isKey(fk.toTable, fk.to)) continue   // an assertion, below
    }
    // A CHECK written from a constraint with no table form is a rewrite.
    const rewritten = o.kind === 'check' && unwrittenIds.has(o.members?.[0])
    if (o.enforced) item({ rmId: o.rmId, label: o.label, kind: o.kind, technique: rewritten ? 'check' : 'table', status: 'enforced',
      note: rewritten ? 'a constraint about one row' : null })
    else item({ rmId: o.rmId, label: o.label, kind: o.kind, technique: 'none', status: 'not',
      note: 'about a view or a derived column' })
  }

  // Assertions: constraints with no table form (and foreign keys to columns
  // that are not a key, which SQL refuses), from their formulas.
  const views = tableViews(state, model, typeSql)
  const isView = (id) => views.get(id)?.kind === 'view'
  const badFks = model.fks.filter(fk => !isKey(fk.toTable, fk.to))
  const assertionSources = [
    ...constraintsAsSql(state, model).map(x => ({ ...x, prefix: 'as' })),
    ...(badFks.length ? constraintsAsSql(state, { ...model, unwritten: badFks.map(fk => state.constraints.find(c => c.id === fk.constraintId)).filter(Boolean) })
      .map(x => ({ ...x, prefix: 'fk', note: 'its referenced columns are not a key' })) : []),
  ]
  const byRm = new Map(view.assertions.map(a => [a.rmId, a]))
  for (const { c, entries, prefix, note: why } of assertionSources) {
    entries.forEach((e, i) => {
      if (e.check) return                      // a CHECK: listed above (relational view)
      const rmId = prefix === 'fk' ? `fk:${c.id}` : `${prefix}:${c.id}${entries.length > 1 ? `:${i}` : ''}`
      const kind = e.entry?.kind ?? c.constraintType
      const label = byRm.get(rmId)?.label ?? (c.name ? `${c.name} (${kind})` : kind)
      const exportLabel = `${c.name ? `${c.name}: ` : ''}${entries[0]?.entry.kind ?? c.constraintType}${kind !== entries[0]?.entry.kind ? `, ${kind}` : ''}`
      const entry = { ...e, rmId, label: exportLabel, name: c.name || null, kind, constraintId: c.id }
      const base = { rmId, label, kind: 'assertion', entry }
      if (!e.query) { item({ ...base, technique: 'none', status: 'not', note: e.error ?? 'it has no SQL form' }); return }
      const fk = !e.deontic && prefix === 'as' ? asForeignKey(e.entry?.formula, model) : null
      if (fk && !isView(fk.fromTable.id) && !isView(fk.toTable.id)) {
        item({ ...base, technique: 'foreignKey', status: 'enforced', entry: { ...entry, fk },
          note: fk.existing ? `the same as FOREIGN KEY ${fk.existing.name?.name ?? ''}`.trim()
            : `${fk.fromTable.name} (${fk.from.map(x => x.name).join(', ')}) REFERENCES ${fk.toTable.name} (${fk.to.map(x => x.name).join(', ')})${fk.addUnique ? ', with a UNIQUE on the referenced columns' : ''}` })
        return
      }
      if (e.deontic) { item({ ...base, technique: 'audit', status: 'not', note: 'deontic: it ought to hold, so it is not enforced' }); return }
      const choice = settings.overrides[rmId] === 'trigger' || settings.overrides[rmId] === 'audit' ? settings.overrides[rmId] : null
      const mode = choice ?? (settings.assertions === 'audit' ? 'audit' : 'trigger')
      const read = (e.tables ?? []).filter(id => model.tables.some(t => t.id === id))
      const stored = read.filter(id => !isView(id))
      if (mode === 'audit') { item({ ...base, technique: 'audit', status: 'not', choice, note: why ?? null }); return }
      if (!stored.length) { item({ ...base, technique: 'audit', status: 'not', choice, viewsOnly: true, note: 'it reads only views, so no trigger can check it' }); return }
      item({ ...base, technique: 'trigger', choice, status: stored.length < read.length ? 'partly' : 'enforced',
        note: stored.length < read.length ? 'it also reads views, whose changes do not run it' : why ?? null })
    })
  }

  // What the export has no SQL for at all.
  const inSchema = (x) => !schemaId || x.schemaId === schemaId
  const otById = new Map((state.objectTypes ?? []).map(o => [o.id, o]))
  const none = (label) => item({ label, kind: 'other', technique: 'none', status: 'not' })
  for (const f of model.notColumns) none(`fact type ${(f.readingParts ?? []).join(' ').trim() || f.id}, which is not a column`)
  for (const s of (state.subtypes ?? []).filter(inSchema)) none(`subtype ${otById.get(s.subId)?.name} of ${otById.get(s.superId)?.name}`)
  for (const t of model.tables) for (const col of t.columns) {
    if ((col.fact.internalFrequency ?? []).length) none(`frequency constraint on ${t.name}.${col.name}`)
    if (col.fact.roles.some(r => r.cardinalityRange?.length)) none(`cardinality range on ${t.name}.${col.name}`)
  }
  for (const o of (state.objectTypes ?? []).filter(inSchema)) if (o.cardinalityRange?.length) none(`cardinality range of ${o.name}`)

  const counts = { enforced: 0, partly: 0, not: 0 }
  for (const x of items) counts[x.status]++
  return { target, settings, items, counts }
}
