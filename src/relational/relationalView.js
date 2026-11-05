// The relational face of a relational schema (RM schemas first-class, step 1).
//
// A relational schema is stored as encoding B (docs/logic/schema-mappings.tex):
// a table is an entity type, a column a binary fact type from it to a value
// type, keys are uniqueness constraints, foreign keys subset constraints, and
// so on. relationalModel reads the tables back for the ERD and the DDL export.
// relationalView goes one step further: it gives each object a user of a
// relational schema talks about (table, view, column, key, foreign key, CHECK,
// NOT NULL, assertion) a stable id of its own (an RM id), its SQL name and
// text, and the ORM2 elements it stands for, plus the inverse map, so panels
// can show tables and keys instead of entity types and external constraints,
// and anything that names an ORM2 element (a validation issue, an accounting
// entry, a rule) can be shown as the relational object it belongs to.
//
// It writes nothing: it is a reading of the stored ORM2 elements, the same one
// the DDL export makes (tables with derived parts as in viewSql.js, other
// constraints as in formulaSql.js).
//
// relationalView(state, schemaId) → {
//   model,                        relationalModel(state, schemaId)
//   objects: Map(rmId → object),  tables in schema order, each followed by its parts
//   tables: [object],             the tables and views
//   assertions: [object],         constraints with no table form
//   ofOrm: Map(ormId → [rmId]),   the objects an ORM2 element stands in, most specific first
//   unmapped: [ormId],            elements of the schema no object stands for
// }
//
// RM ids (stable as long as the elements are; ids are the ORM2 ids they come from):
//   table:<entityId>    a table, or a view when it has derived rows or columns
//   base:<entityId>     the stored part <name>_base of a table with derived columns
//                       or semi-derived rows or columns (the export's CREATE TABLE)
//   col:<factId>        a column (of the table, or of the view)
//   bcol:<factId>       a column of a base table
//   nn:<factId>         NOT NULL on a column
//   pk:<entityId>       the primary key
//   uq:<ucId>           a UNIQUE key (internal uniqueness id or external constraint id)
//   fk:<constraintId>   a foreign key (subset constraint)
//   ck:<constraintId>[:<i>]           a CHECK from a constraint (formula, value comparison,
//                                     or a constraint the export writes as a CHECK)
//   ck:<factId>:type / ck:<factId>:role   a column CHECK from a value range
//   as:<constraintId>[:<i>]           an assertion: a constraint with no table form
//
// object: { rmId, kind, name, label, table (rmId | null), members: [ormId], sql, enforced, … }
//   kind 'table' | 'view':  entityId, columns: [rmId], base (rmId | null), keys: [rmId],
//                           derived: 'rows' | 'columns' | null, error (rules with no SQL form)
//   kind 'column':          factId, type (SQL), notNull, generated, pk, unique, fk,
//                           derived ('derived' | 'semiDerived' | null)
//   kind 'notNull', 'primaryKey', 'unique', 'check': columns: [rmId]
//   kind 'foreignKey':      columns, refTable, refColumns
//   kind 'assertion':       query (SQL returning the violations) | null, formula (text), error
// name is the SQL name (a column's own name, a constraint's name: its name in
// the script, else PostgreSQL's default); label is how a panel names it
// ("film.title", "PRIMARY KEY film_pkey"); sql its SQL text ("PRIMARY KEY
// (film_id)"); enforced is false for constraints PostgreSQL would not check
// (on a view or a derived column, assertions).

import { relationalModel, defaultConstraintName } from './relationalModel.js'
import { tableViews } from './viewSql.js'
import { typeSql, rangeSql } from './ddlExport.js'
import { constraintsAsSql } from './formulaSql.js'
import { quoteIdent as q } from './sqlNames.js'
import { valueKindName } from '../utils/datatypeValues.js'

const NUMERIC_KINDS = new Set(['integer', 'decimal', 'float'])

// Cached per (objectTypes, facts, constraints, subtypes) and schema: panels may
// ask for it on every render.
const cache = new WeakMap()
const EMPTY = []
export function relationalView(state, schemaId) {
  let level = cache
  for (const k of [state.objectTypes, state.facts, state.constraints, state.subtypes ?? EMPTY]) {
    if (!level.has(k)) level.set(k, new WeakMap())
    level = level.get(k)
  }
  if (!level.has(EMPTY)) level.set(EMPTY, new Map())   // last level: schema id → view
  const bySchema = level.get(EMPTY)
  const sid = schemaId ?? null
  if (!bySchema.has(sid)) bySchema.set(sid, buildView(state, schemaId))
  return bySchema.get(sid)
}

export function buildView(state, schemaId) {
  const model = relationalModel(state, schemaId)
  const views = tableViews(state, model, typeSql)
  const objects = new Map(), ofOrm = new Map()
  const add = (o) => {
    objects.set(o.rmId, o)
    for (const m of o.members) {
      if (!m) continue
      if (!ofOrm.has(m)) ofOrm.set(m, [])
      ofOrm.get(m).push(o.rmId)
    }
    return o
  }
  const tables = [], assertions = []
  const tableOf = new Map()   // relationalModel table → rmId of the table holding its keys
  const colIdOf = new Map()   // factId → rmId of the stored column (bcol in a base table)
  const checkNames = new Map() // table rmId → Set of CHECK names taken
  const checkName = (tableRm, own, tableName, cols) => {
    if (!checkNames.has(tableRm)) checkNames.set(tableRm, new Set())
    const used = checkNames.get(tableRm)
    const base = own || defaultConstraintName(tableName, cols, 'check')
    let name = base
    for (let i = 1; used.has(name); i++) name = `${base}${i}`
    used.add(name)
    return name
  }
  const colList = (cols) => cols.map(c => q(c.name)).join(', ')

  for (const t of model.tables) {
    const v = views.get(t.id)
    const hasView = v && !v.error
    const isView = hasView                     // the table's own name is then a view
    const baseId = hasView && v.kind === 'base' ? `base:${t.id}` : null
    const derivedOf = (fid) => (v?.derivedCols?.has(fid) ? 'derived' : v?.semiCols?.has(fid) ? 'semiDerived' : null)
    const tableObj = add({
      rmId: `table:${t.id}`, kind: isView ? 'view' : 'table', name: t.name, label: t.name, table: null,
      entityId: t.id, members: [t.id], columns: [], base: baseId, keys: [],
      derived: !hasView ? null : v.kind === 'view' ? 'rows' : 'columns', error: v?.error ?? null,
      sql: null, enforced: true,
    })
    tables.push(tableObj)
    let baseObj = null
    if (baseId) {
      baseObj = add({ rmId: baseId, kind: 'table', name: v.baseName, label: v.baseName, table: null,
        entityId: t.id, members: [], columns: [], base: null, keys: [], derived: null, error: null,
        sql: null, enforced: true, of: tableObj.rmId })
      tables.push(baseObj)
    }
    // The keys are the stored table's: the base table, else the table itself.
    // A view's own keys are not enforced.
    const holder = baseObj ?? tableObj
    tableOf.set(t, holder.rmId)

    for (const col of t.columns) {
      const role = col.fact.roles[col.v]
      const tRole = col.fact.roles[col.t]
      const derived = derivedOf(col.fact.id)
      const colObj = add({
        rmId: `col:${col.fact.id}`, kind: 'column', name: col.name, label: `${t.name}.${col.name}`,
        table: tableObj.rmId, factId: col.fact.id, members: [col.fact.id, role.id, tRole.id,
          // the uniqueness on the table's role (one value per row), and the value type
          ...(col.fact.uniqueness ?? []).filter(u => u.roles?.length === 1 && u.roles[0] === col.t).map(u => u.id), col.vt.id],
        type: typeSql(col.vt.datatypeAssignment, col.generated), notNull: col.notNull, generated: col.generated,
        pk: col.pk, unique: col.unique, fk: col.fk, derived, sql: null, enforced: true,
      })
      tableObj.columns.push(colObj.rmId)
      colIdOf.set(col.fact.id, colObj.rmId)
      if (baseObj && derived !== 'derived') {
        const b = add({ ...colObj, rmId: `bcol:${col.fact.id}`, label: `${v.baseName}.${col.name}`, table: baseObj.rmId,
          members: [], notNull: col.notNull && derived !== 'semiDerived', derived: null, of: colObj.rmId })
        baseObj.columns.push(b.rmId)
        colIdOf.set(col.fact.id, b.rmId)
      }
    }
    const colIds = (cols) => cols.map(c => colIdOf.get(c.fact.id))
    const stored = (cols) => !isView || (!!baseObj && cols.every(c => derivedOf(c.fact.id) !== 'derived'))
    const keyObj = (o) => { add(o); holder.keys.push(o.rmId); return o }

    // NOT NULL (a mandatory table role; a primary key's columns always).
    for (const col of t.columns) {
      if (!col.notNull) continue
      const derived = derivedOf(col.fact.id)
      if (baseObj && derived) continue        // not stored as NOT NULL in the base table
      const mandatoryId = col.fact.roles[col.t].mandatoryId
      keyObj({ rmId: `nn:${col.fact.id}`, kind: 'notNull', name: null, label: `${holder.name}.${col.name} NOT NULL`,
        table: holder.rmId, members: [mandatoryId], columns: colIds([col]), sql: 'NOT NULL',
        enforced: stored([col]) })
    }
    if (t.pk) {
      const src = t.pkSource ?? {}
      keyObj({ rmId: `pk:${t.id}`, kind: 'primaryKey', name: t.pkName.name, label: `PRIMARY KEY ${t.pkName.name}`,
        table: holder.rmId, members: [src.ucId ?? src.constraintId], columns: colIds(t.pk),
        sql: `PRIMARY KEY (${colList(t.pk)})`, enforced: stored(t.pk) })
    }
    t.uniques.forEach((u, i) => {
      const src = t.uniqueSources[i] ?? {}
      const name = t.uniqueNames[i].name
      keyObj({ rmId: `uq:${src.ucId ?? src.constraintId}`, kind: 'unique', name, label: `UNIQUE ${name}`,
        table: holder.rmId, members: [src.ucId ?? src.constraintId], columns: colIds(u),
        sql: `UNIQUE (${colList(u)})`, enforced: stored(u) })
    })
    // Value ranges: CHECKs on their column (the export writes them inline).
    for (const col of t.columns) {
      if (baseObj && derivedOf(col.fact.id) === 'derived') continue
      const role = col.fact.roles[col.v]
      const numeric = NUMERIC_KINDS.has(valueKindName(col.vt.datatypeAssignment) ?? '')
      for (const [which, specs, owner] of [['type', col.vt.valueRange, col.vt.id], ['role', role.valueRange, role.id]]) {
        const cond = specs?.length ? rangeSql(q(col.name), specs, numeric) : null
        if (!cond) continue
        const name = checkName(holder.rmId, null, t.name, [col.name])
        keyObj({ rmId: `ck:${col.fact.id}:${which}`, kind: 'check', name, label: `CHECK ${name}`,
          table: holder.rmId, members: [owner], columns: colIds([col]), sql: `CHECK (${cond})`,
          enforced: stored([col]) })
      }
    }
    // CHECKs read from the script, and value comparisons within the table.
    for (const ch of t.checks) {
      const c = state.constraints.find(x => x.id === ch.constraintId)
      const cols = Object.keys(c?.sqlCheck?.columns ?? {})
      const name = checkName(holder.rmId, ch.name, t.name, cols.length === 1 ? cols : [])
      keyObj({ rmId: `ck:${ch.constraintId}`, kind: 'check', name, label: `CHECK ${name}`,
        table: holder.rmId, members: [ch.constraintId], columns: [], sql: `CHECK (${ch.text})`,
        enforced: !isView || !!baseObj })
    }
  }

  // Foreign keys, after all tables (they point across).
  for (const fk of model.fks) {
    const from = tableOf.get(fk.fromTable), to = tableOf.get(fk.toTable)
    const fromV = views.get(fk.fromTable.id), toV = views.get(fk.toTable.id)
    const storedEnd = (v, cols) => !(v && !v.error) || (v.kind === 'base' && cols.every(c => !v.derivedCols.has(c.fact.id)))
    const o = add({
      rmId: `fk:${fk.constraintId}`, kind: 'foreignKey', name: fk.name.name, label: `FOREIGN KEY ${fk.name.name}`,
      table: from, members: [fk.constraintId], columns: fk.from.map(c => colIdOf.get(c.fact.id)),
      refTable: to, refColumns: fk.to.map(c => colIdOf.get(c.fact.id)),
      sql: `FOREIGN KEY (${colList(fk.from)}) REFERENCES ${q(objects.get(to).name)} (${colList(fk.to)})`,
      enforced: storedEnd(fromV, fk.from) && storedEnd(toV, fk.to),
    })
    objects.get(from).keys.push(o.rmId)
  }

  // Constraints with no table form: a CHECK when they are about one row, else
  // an assertion (written as a query returning the violations, or not at all).
  const byEntity = new Map(model.tables.map(t => [t.id, t]))
  for (const { c, entries } of constraintsAsSql(state, model)) {
    entries.forEach((e, i) => {
      const suffix = entries.length > 1 ? `:${i}` : ''
      if (e.check) {
        const t = byEntity.get(e.check.tableId)
        const holder = tableOf.get(t)
        const name = checkName(holder, entries.length === 1 ? c.name : null, t.name, [])
        const o = add({ rmId: `ck:${c.id}${suffix}`, kind: 'check', name, label: `CHECK ${name}`, table: holder,
          members: [c.id], columns: [], sql: `CHECK (${e.check.text})`, enforced: true })
        objects.get(holder).keys.push(o.rmId)
        return
      }
      const kind = e.entry?.kind ?? c.constraintType
      const name = c.name || null
      assertions.push(add({ rmId: `as:${c.id}${suffix}`, kind: 'assertion', name,
        label: name ? `${name} (${kind})` : kind, table: null, members: [c.id],
        query: e.query ?? null, formula: e.text ?? null, error: e.query ? null : e.error ?? null,
        sql: e.query ?? null, enforced: false, deontic: !!e.deontic }))
    })
  }

  // What no object stands for: fact types that are not columns, subtypes,
  // and anything else of the schema the objects leave out.
  const inSchema = (x) => !schemaId || x.schemaId === schemaId
  const unmapped = [
    ...model.notColumns.map(f => f.id),
    ...(state.subtypes ?? []).filter(inSchema).map(s => s.id),
    ...(state.objectTypes ?? []).filter(o => inSchema(o) && o.kind !== 'entity' && !ofOrm.has(o.id)).map(o => o.id),
  ]
  return { model, objects, tables, assertions, ofOrm, unmapped }
}

// The object an ORM2 element is shown as (the most specific one), or null.
export function rmObjectOf(view, ormId) {
  const ids = view.ofOrm.get(ormId)
  return ids?.length ? view.objects.get(ids[0]) : null
}

// The relational name of an ORM2 element of the schema: "film.title" for a
// column's fact type, "PRIMARY KEY film_pkey" for its uniqueness constraint,
// or null when nothing relational stands for it.
export function rmLabel(view, ormId) {
  return rmObjectOf(view, ormId)?.label ?? null
}
