// The records of a table (RM schemas first-class, step 3). Encoding B stores
// a table's rows as the population of its entity type (each instance is its
// primary key: the value of a one-column key, the list of key values of a
// composite one, in the order of the key's columns) and each other column's
// values as tuples of the column's fact type (none for NULL). This reads them
// as records and writes records back.

import { relationalModel } from './relationalModel.js'
import { findRefMode, findCompositePI } from '../utils/refMode.js'
import { withDerivedPopulations } from '../logic/derivedPopulation.js'

const keyOf = (cell) => JSON.stringify(cell)

// The table's layout: { table, columns, keyFacts, refMode, readOnly, reason }.
// columns: [{ factId, name, type, pk, notNull, derived, vtId, t, v }].
export function tableShape(state, schemaId, tableId) {
  const model = relationalModel(state, schemaId)
  const table = model.tables.find(t => t.id === tableId)
  if (!table) return null
  const refMode = findRefMode(table.entity, state.facts, state.objectTypes)
  const cp = refMode ? null : findCompositePI(table.entity, state.facts, state.objectTypes, state.constraints)
  const keyFacts = refMode ? [refMode.factId] : cp ? (cp.factIds ?? (cp.factId ? [cp.factId] : [])) : []
  const columns = table.columns.map(c => ({
    factId: c.fact.id, name: c.name, vtId: c.vt.id, t: c.t, v: c.v,
    type: c.vt.datatypeAssignment?.datatypeId ?? null,
    pk: keyFacts.includes(c.fact.id), keyIndex: keyFacts.indexOf(c.fact.id),
    notNull: c.notNull || keyFacts.includes(c.fact.id),
    derived: c.fact.derivation === 'derived',
  }))
  const derivedRows = table.entity.derivation === 'derived'
  const reason = !keyFacts.length ? 'The table has no primary key, so its rows can\'t be stored.'
    : derivedRows ? 'A rule derives the rows of this table (a view).' : null
  return { table, columns, keyFacts, refMode: !!refMode, readOnly: !!reason, reason, derivedRows }
}

// The records: [{ id, cell, values: { factId: value | null } }], derived rows
// and columns computed. Sorted by key.
export function tableRecords(state, shape) {
  if (!shape?.keyFacts.length) return []
  const anyDerived = shape.derivedRows || shape.columns.some(c => c.derived)
  const data = anyDerived ? withDerivedPopulations(state) : state
  const cells = data.populations?.[shape.table.id] ?? []
  const byKey = new Map(cells.map(cell => [keyOf(cell), { id: keyOf(cell), cell, values: {} }]))
  for (const c of shape.columns) {
    if (c.pk) {
      for (const r of byKey.values()) r.values[c.factId] = shape.refMode ? r.cell : (r.cell?.[c.keyIndex] ?? null)
      continue
    }
    for (const r of byKey.values()) r.values[c.factId] = null
    for (const tuple of data.factPopulations?.[c.factId] ?? []) {
      const r = byKey.get(keyOf(tuple[c.t]))
      if (r && r.values[c.factId] == null) r.values[c.factId] = tuple[c.v] ?? null
    }
  }
  const sortKey = (r) => shape.keyFacts.map(f => r.values[f] ?? '')
  const cmp = (a, b) => {
    const x = sortKey(a), y = sortKey(b)
    for (let i = 0; i < x.length; i++) {
      const nx = Number(x[i]), ny = Number(y[i])
      const d = x[i] !== '' && y[i] !== '' && !isNaN(nx) && !isNaN(ny) ? nx - ny : String(x[i]).localeCompare(String(y[i]))
      if (d) return d
    }
    return 0
  }
  return [...byKey.values()].sort(cmp)
}

const normal = (col, v) => {
  if (v == null) return null
  const s = String(v).trim()
  if (s === '') return null
  if (col.type === 'boolean') {
    const l = s.toLowerCase()
    if (['t', 'true', 'yes', 'y', '1', 'on'].includes(l)) return 'true'
    if (['f', 'false', 'no', 'n', '0', 'off'].includes(l)) return 'false'
  }
  return s
}

// The populations with the record `old` (its cell, or null for a new one)
// replaced by one with these values ({ factId: value }; missing or empty is
// NULL). Returns { populations, factPopulations } or { error }.
export function withRecord(state, shape, old, values) {
  if (shape.readOnly) return { error: shape.reason }
  const val = {}
  for (const c of shape.columns) if (!c.derived) val[c.factId] = normal(c, values[c.factId])
  const keyVals = shape.keyFacts.map(f => val[f])
  const missing = shape.columns.filter(c => c.pk && val[c.factId] == null)
  if (missing.length) return { error: `The key needs a value for ${missing.map(c => c.name).join(', ')}.` }
  const cell = shape.refMode ? keyVals[0] : keyVals
  const id = keyOf(cell)
  const pops = state.populations ?? {}, fpops = state.factPopulations ?? {}
  const current = pops[shape.table.id] ?? []
  const oldId = old == null ? null : keyOf(old)
  if (id !== oldId && current.some(x => keyOf(x) === id))
    return { error: `There is already a row with the key ${shape.keyFacts.map(f => val[f]).join(', ')}.` }
  const populations = { ...pops }
  const factPopulations = { ...fpops }
  // The entity instance.
  populations[shape.table.id] = oldId == null ? [...current, cell] : current.map(x => (keyOf(x) === oldId ? cell : x))
  // Value types get the values that are new to them.
  for (const c of shape.columns) {
    const v = val[c.factId]
    if (v == null || c.derived) continue
    const vp = populations[c.vtId] ?? []
    if (!vp.some(x => x === v)) populations[c.vtId] = [...vp, v]
  }
  // The columns' tuples (key columns are stored in the instance).
  for (const c of shape.columns) {
    if (c.pk || c.derived) continue
    const tuples = (factPopulations[c.factId] ?? []).filter(t => oldId == null || keyOf(t[c.t]) !== oldId)
    const v = val[c.factId]
    if (v != null) { const t = []; t[c.t] = cell; t[c.v] = v; tuples.push(t) }
    if (tuples.length) factPopulations[c.factId] = tuples
    else delete factPopulations[c.factId]
  }
  return { populations, factPopulations, cell }
}

// The populations without the record `cell`.
export function withoutRecord(state, shape, cell) {
  if (shape.readOnly) return { error: shape.reason }
  const id = keyOf(cell)
  const populations = { ...(state.populations ?? {}) }
  const factPopulations = { ...(state.factPopulations ?? {}) }
  const rest = (populations[shape.table.id] ?? []).filter(x => keyOf(x) !== id)
  if (rest.length) populations[shape.table.id] = rest
  else delete populations[shape.table.id]
  for (const c of shape.columns) {
    if (c.pk || c.derived || !factPopulations[c.factId]) continue
    const tuples = factPopulations[c.factId].filter(t => keyOf(t[c.t]) !== id)
    if (tuples.length) factPopulations[c.factId] = tuples
    else delete factPopulations[c.factId]
  }
  return { populations, factPopulations }
}
