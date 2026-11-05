// Constraints of a relational schema in table terms (RM schemas first-class,
// step 4): an English sentence for each key, NOT NULL, foreign key, CHECK and
// assertion of relationalView, and the population's violations of them as
// messages about rows. The ORM2 verbalisation (verbalisation/) stays for the
// logical view; these sentences are what the tables view shows.

const list = (xs) => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}`)

// Column names of an object's columns.
const colNames = (view, ids) => (ids ?? []).map(id => view.objects.get(id)?.name ?? '?')
const tableName = (view, obj) => view.objects.get(obj.table)?.name ?? '?'

// The condition of a CHECK's SQL text.
const condOf = (sql) => (sql ?? '').replace(/^CHECK \(/, '').replace(/\)$/, '')

// One sentence for an object (kind notNull, primaryKey, unique, foreignKey,
// check, assertion), or null. formula: the assertion's ORM2 sentence, if any.
export function rmSentence(view, obj, { sentence = null } = {}) {
  const t = tableName(view, obj)
  const cols = colNames(view, obj.columns)
  const several = cols.length > 1
  const theCols = several ? `combination of ${list(cols)}` : cols[0]
  switch (obj.kind) {
    case 'notNull':
      return `Each ${t} row has a ${cols[0]}.`
    case 'primaryKey':
      return `Each ${t} row is identified by its ${list(cols)}: every row has ${several ? 'them' : 'one'}, and no two rows have the same ${theCols}.`
    case 'unique':
      return `No two ${t} rows have the same ${theCols}${several ? ' (rows where one of them is NULL are not compared)' : ''}.`
    case 'foreignKey': {
      const ref = view.objects.get(obj.refTable)?.name ?? '?'
      const refCols = colNames(view, obj.refColumns)
      const same = cols.join() === refCols.join()
      return several
        ? `For each ${t} row whose ${list(cols)} are ${cols.length === 2 ? 'both' : 'all'} given, some ${ref} row has the same ${same ? 'values' : `values as ${list(refCols)}`}.`
        : `Each ${cols[0]} given in a ${t} row is the ${refCols[0]} of some ${ref} row.`
    }
    case 'check': {
      const cond = condOf(obj.sql)
      const m = cond.match(/^"?([A-Za-z_][\w$]*)"? IN \((.*)\)$/)
      if (m) return `Each ${m[1]} given in a ${t} row is one of ${m[2]}.`
      return `Each ${t} row satisfies ${cond}, unless a NULL in the row leaves that unknown.`
    }
    case 'assertion':
      return sentence ?? null
    default:
      return null
  }
}

// The population's violations of each object: Map(rmId → [message]).
// issues: store.populationIssues. A row is named by its key (the entity
// instance: one value, or a list of values).
export function rmViolations(view, issues) {
  const out = new Map()
  const push = (rmId, text) => { if (!out.has(rmId)) out.set(rmId, []); out.get(rmId).push(text) }
  const show = (v) => (Array.isArray(v) ? `(${v.map(show).join(', ')})` : v == null ? 'NULL' : String(v))
  const objOf = (ormId, kinds) => (view.ofOrm.get(ormId) ?? []).map(id => view.objects.get(id)).find(o => o && kinds.includes(o.kind))
  // The key object over exactly this column.
  const keyOver = (factId) => [...view.objects.values()].find(o => (o.kind === 'primaryKey' || o.kind === 'unique')
    && o.columns?.length === 1 && (o.columns[0] === `col:${factId}` || o.columns[0] === `bcol:${factId}`))
  for (const i of issues ?? []) {
    if (i.kind === 'mandatoryRoleNotPlayed' && i.factId) {
      const o = view.objects.get(`nn:${i.factId}`)
      if (o) { push(o.rmId, `The ${tableName(view, o)} row ${show(i.value)} has no ${colNames(view, o.columns)[0]}.`); continue }
    }
    if (i.kind === 'uniquenessViolation') {
      const o = i.factId ? keyOver(i.factId) : objOf(i.constraintId ?? i.elementId, ['primaryKey', 'unique'])
      if (o) {
        const v = i.values ? (i.values.length === 1 ? i.values[0] : i.values) : i.value
        push(o.rmId, `Several ${tableName(view, o)} rows have ${list(colNames(view, o.columns))} = ${show(v)}.`)
        continue
      }
    }
    if (i.kind === 'subsetViolation') {
      const o = objOf(i.constraintId ?? i.elementId, ['foreignKey'])
      if (o) {
        const ref = view.objects.get(o.refTable)?.name ?? '?'
        push(o.rmId, `A ${tableName(view, o)} row has ${list(colNames(view, o.columns))} = ${show(i.value)}, which no ${ref} row has.`)
        continue
      }
    }
    // Others (CHECKs, assertions): their own message, under the object.
    const o = objOf(i.constraintId ?? i.elementId, ['check', 'assertion', 'primaryKey', 'unique', 'foreignKey', 'notNull'])
    if (o) push(o.rmId, i.message)
  }
  return out
}

// The table (entity id) the selection is about: a table, view or stored
// part, a part of one (column, key, CHECK), or its entity type; or null.
export function selectedTableId(state, view) {
  if (!state.selectedId) return null
  const obj = (state.selectedRm?.id === state.selectedId ? view.objects.get(state.selectedRm.rmId) : null)
    ?? view.ofOrm.get(state.selectedId)?.map(id => view.objects.get(id)).find(Boolean)
  const tbl = obj && (obj.kind === 'table' || obj.kind === 'view' ? obj : view.objects.get(obj.table))
  return tbl?.entityId ?? null
}
