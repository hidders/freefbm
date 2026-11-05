// Tables as the unit of a relational schema's diagrams (RM schemas
// first-class, step 2): a diagram of a relational schema shows a table whole
// or not at all, in either face. A table's parts are its entity type (encoding
// B), its column fact types and their value types; showing any part of a
// table shows all of it, and hiding any part hides all of it. A value type
// shared by several tables stays while a table that uses it is shown.
// Constraints follow their elements (syncConstraints), and a foreign key needs
// no more than its two tables: one whose target table is not shown keeps its
// columns, without a line. Mapping diagrams show parts of tables and are left
// out.

import { relationalModel } from './relationalModel.js'
import { computeCascadeRemove, addOccIfAbsent, mkConstraintOcc } from '../store/storeHelpers.js'
import { formulaElements } from '../logic/formulaConstraint.js'

const cache = new WeakMap()

// { tableOf: Map(entity or column fact id → entity id), parts: Map(entity id →
// { facts, vts }), columnVts: Set } for a relational schema, or null.
export function tableUnits(state, schemaId) {
  const schema = state.schemas?.find(s => s.id === schemaId)
  if (schema?.profile !== 'relational') return null
  let bySchema = cache.get(state.facts)
  if (!bySchema) { bySchema = new Map(); cache.set(state.facts, bySchema) }
  const hit = bySchema.get(schemaId)
  if (hit && hit.ots === state.objectTypes) return hit.units
  const model = relationalModel(state, schemaId)
  const tableOf = new Map(), parts = new Map(), columnVts = new Set()
  for (const t of model.tables) {
    tableOf.set(t.id, t.id)
    const facts = t.columns.map(c => c.fact.id), vts = [...new Set(t.columns.map(c => c.vt.id))]
    for (const f of facts) tableOf.set(f, t.id)
    for (const v of vts) columnVts.add(v)
    parts.set(t.id, { facts, vts })
  }
  const units = { tableOf, parts, columnVts }
  bySchema.set(schemaId, { ots: state.objectTypes, units })
  return units
}

// The units that apply to a diagram, or null (mapping diagrams, ORM2 schemas).
export function diagramUnits(state, diagram) {
  if (!diagram || diagram.mappingId) return null
  return tableUnits(state, diagram.schemaId)
}

// The ids to show with `id`: its table's entity type and column fact types
// (their value types follow from the fact types' roles), or none.
export function tableCompanions(units, id) {
  const t = units?.tableOf.get(id)
  return t ? [t, ...units.parts.get(t).facts] : []
}

// The element ids to take off `diagram` when `ids` are removed from it: each
// table part stands for its whole table (with the cascade of its entity type),
// a value type that a shown column of another table uses stays, and value
// types that only the removed columns used go too.
export function tableRemoval(state, diagram, units, ids) {
  const out = new Set()
  const shown = new Set((diagram?.occurrences ?? []).map(o => o.schemaElementId))
  const asked = new Set()
  for (const id of ids) asked.add(units.tableOf.get(id) ?? id)
  for (const id of asked) {
    if (units.columnVts.has(id) && !units.tableOf.has(id)) continue // decided below
    computeCascadeRemove(id, state.facts).forEach(x => out.add(x))
  }
  // Value types: gone when no remaining shown fact type uses them.
  const used = new Set()
  for (const f of state.facts) {
    if (!shown.has(f.id) || out.has(f.id)) continue
    for (const r of f.roles) if (r.objectTypeId) used.add(r.objectTypeId)
  }
  for (const id of shown) {
    if (!units.columnVts.has(id) || used.has(id) || out.has(id)) continue
    const wasUsed = state.facts.some(f => out.has(f.id) && f.roles.some(r => r.objectTypeId === id))
    if (wasUsed || asked.has(id)) out.add(id)
  }
  return out
}

// The diagram with an occurrence of each constraint of its schema that is
// about shown elements only and not yet on it (keys, foreign keys between
// shown tables, CHECKs, value comparisons), placed by the fact types it names.
export function withTableConstraints(state, diagram) {
  const occ = new Map((diagram.occurrences ?? []).map(o => [o.schemaElementId, o]))
  const has = new Set((diagram.constraintOccurrences ?? []).map(o => o.schemaConstraintId))
  const add = []
  for (const c of state.constraints) {
    if (c.schemaId !== diagram.schemaId || has.has(c.id)) continue
    let facts, types = []
    if (c.constraintType === 'formula') {
      const el = formulaElements(c.rule)
      facts = [...el.facts]; types = [...el.types]
    } else {
      if (!c.sequences?.length || c.sequences.flat().some(m => m?.kind !== 'role' || !m.factId || m.factId.includes('_il_'))) continue
      facts = [...new Set(c.sequences.flat().map(m => m.factId))]
    }
    if (!facts.length || facts.some(f => !occ.has(f)) || types.some(t => !occ.has(t))) continue
    const os = facts.map(f => occ.get(f))
    const x = os.reduce((a, o) => a + (o.x ?? 0), 0) / os.length, y = os.reduce((a, o) => a + (o.y ?? 0), 0) / os.length
    add.push(mkConstraintOcc(c.id, Math.round(x + 40), Math.round(y + (os.length === 1 ? 40 : 0))))
  }
  return add.length ? { ...diagram, constraintOccurrences: [...(diagram.constraintOccurrences ?? []), ...add] } : diagram
}

// Diagrams with partly shown tables completed (opening older files): adds the
// missing parts and never hides any. Returns the diagrams array unchanged when
// nothing is missing.
export function completeTables(state, diagrams) {
  let changed = false
  const out = diagrams.map(d => {
    const units = diagramUnits(state, d)
    if (!units) return d
    const shown = new Set((d.occurrences ?? []).map(o => o.schemaElementId))
    const tables = new Set([...shown].map(id => units.tableOf.get(id)).filter(Boolean))
    let nd = d
    for (const t of tables) {
      const { facts } = units.parts.get(t)
      const ids = [t, ...facts]
      for (const f of facts) {
        const fact = state.facts.find(x => x.id === f)
        for (const r of fact?.roles ?? []) if (r.objectTypeId) ids.push(r.objectTypeId)
      }
      for (const id of ids) {
        if (shown.has(id)) continue
        const el = state.objectTypes.find(o => o.id === id) ?? state.facts.find(f => f.id === id)
        if (!el) continue
        nd = addOccIfAbsent(nd, id, el.x ?? 0, el.y ?? 0)
        shown.add(id)
      }
    }
    if (nd !== d) { changed = true; nd = withTableConstraints(state, nd) }
    return nd
  })
  return changed ? out : diagrams
}
