// The neighbourhood of an element in its schema, for growing a diagram by hand
// (the Add neighbours… picker, NeighbourPicker.jsx). Each neighbour is a unit
// that is added as a whole: in an ORM2 schema a fact type the element plays
// (with its other players, as addElementToDiagram adds them) or a subtype
// link; in a relational schema a table joined to it by a foreign key, or a
// junction table together with the table(s) on its far side.
//
// neighbourUnits(state, diagram, elementId) →
//   [{ key, group, label, ids, far, shown, otherDiagrams, defaultOn, hub }]
//   ids:  the element ids to add (addElementToDiagram each)
//   far:  the elements the unit leads to (for "one more step")
//   shown: every id is on the diagram already
//   otherDiagrams: how many other diagrams show the unit
//   defaultOn: pre-ticked (attributes and dependants)
//   hub: the far element has many neighbours of its own

import { findRefMode } from './refMode.js'
import { relationalModel } from '../relational/relationalModel.js'

export const GROUPS = {
  attributes:    'Attributes',
  relationships: 'Relationships',
  subtypes:      'Subtypes',
  supertypes:    'Supertypes',
  references:    'References',
  referencedBy:  'Referenced by',
  manyToMany:    'Many-to-many',
}
export const GROUP_ORDER = ['attributes', 'subtypes', 'supertypes', 'relationships', 'references', 'referencedBy', 'manyToMany']

const HUB = 12

const isRelational = (state, schemaId) => state.schemas?.find(s => s.id === schemaId)?.profile === 'relational'

// Diagrams a unit may be counted on: plain diagrams of the schema.
const plainDiagrams = (state, diagram) => (state.diagrams ?? []).filter(d => !d.mappingId && d.schemaId === diagram?.schemaId)

function onDiagram(d, id, subtypes) {
  if (subtypes.has(id)) return (d.subtypeOccurrences ?? []).includes(id)
  return (d.occurrences ?? []).some(o => o.schemaElementId === id)
}

export function neighbourUnits(state, diagram, elementId) {
  if (!diagram || !elementId) return []
  const units = isRelational(state, diagram.schemaId)
    ? relationalUnits(state, diagram.schemaId, elementId)
    : ormUnits(state, diagram.schemaId, elementId)
  const subtypeIds = new Set((state.subtypes ?? []).map(s => s.id))
  const others = plainDiagrams(state, diagram).filter(d => d.id !== diagram.id)
  for (const u of units) {
    u.shown = u.ids.every(id => onDiagram(diagram, id, subtypeIds))
    u.otherDiagrams = others.filter(d => onDiagram(d, u.ids[0], subtypeIds)).length
  }
  return units
}

// For the "+n" badges of growing mode: how many neighbourhood units of each
// element shown on the diagram are not shown yet. Map(elementId → n), only n > 0.
export function hiddenNeighbourCounts(state, diagram) {
  const out = new Map()
  if (!diagram || diagram.mappingId) return out
  const subtypeIds = new Set((state.subtypes ?? []).map(s => s.id))
  const shown = new Set((diagram.occurrences ?? []).map(o => o.schemaElementId))
  const relational = isRelational(state, diagram.schemaId)
  const model = relational ? relationalModel(state, diagram.schemaId) : null
  const anchors = relational
    ? model.tables.filter(t => shown.has(t.id)).map(t => t.id)
    : [...shown].filter(id => hasNeighbourhood(state, id))
  for (const id of anchors) {
    const units = relational ? relationalUnits(state, diagram.schemaId, id, model) : ormUnits(state, diagram.schemaId, id)
    const n = units.filter(u => !u.ids.every(x => onDiagram(diagram, x, subtypeIds))).length
    if (n) out.set(id, n)
  }
  return out
}

// How much of a schema its (plain) diagrams show: tables of a relational
// schema; object types and fact types of an ORM2 schema.
export function diagramCoverage(state, schemaId) {
  const onSome = new Set()
  for (const d of state.diagrams ?? []) {
    if (d.mappingId || d.schemaId !== schemaId) continue
    for (const o of d.occurrences ?? []) onSome.add(o.schemaElementId)
  }
  if (isRelational(state, schemaId)) {
    const tables = state.objectTypes.filter(o => o.schemaId === schemaId && o.kind === 'entity')
    return { kind: 'tables', total: tables.length, shown: tables.filter(t => onSome.has(t.id)).length }
  }
  const els = [...state.objectTypes.filter(o => o.schemaId === schemaId), ...state.facts.filter(f => f.schemaId === schemaId && !f._implicit)]
  return { kind: 'elements', total: els.length, shown: els.filter(e => onSome.has(e.id)).length }
}

// Whether an element can have a neighbourhood: an object type, an objectified
// fact type, or a table.
export function hasNeighbourhood(state, elementId) {
  if (state.objectTypes?.some(o => o.id === elementId)) return true
  return !!state.facts?.some(f => f.id === elementId && f.objectified)
}

// ── ORM2 ─────────────────────────────────────────────────────────────────────

function nameOf(state, id) {
  const ot = state.objectTypes.find(o => o.id === id)
  if (ot) return ot.name || '?'
  const f = state.facts.find(x => x.id === id)
  return f?.objectifiedName || f?.name || '?'
}

// The fact type's primary reading with its players' names, roles[] order.
export function factLabel(state, f) {
  const names = f.roles.map(r => (r.objectTypeId ? nameOf(state, r.objectTypeId) : '…'))
  const parts = f.readingParts
  if (!parts || parts.length !== f.roles.length + 1) return names.join(' — ')
  let s = parts[0] ? parts[0] + ' ' : ''
  names.forEach((n, i) => { s += n; if (parts[i + 1]) s += ' ' + parts[i + 1] + ' '; else if (i < names.length - 1) s += ' ' })
  return s.replace(/\s+/g, ' ').trim()
}

// How many fact types and subtype links an object type takes part in.
function degreeMap(state, schemaId) {
  const deg = new Map()
  const bump = (id) => deg.set(id, (deg.get(id) ?? 0) + 1)
  for (const f of state.facts) {
    if (f.schemaId !== schemaId || f._implicit) continue
    for (const id of new Set(f.roles.map(r => r.objectTypeId).filter(Boolean))) bump(id)
  }
  for (const s of state.subtypes ?? []) if (s.schemaId === schemaId) { bump(s.subId); bump(s.superId) }
  return deg
}

function ormUnits(state, schemaId, x) {
  const out = []
  const kindOf = (id) => {
    const ot = state.objectTypes.find(o => o.id === id)
    if (ot) return ot.kind
    const f = state.facts.find(y => y.id === id)
    return f?.objectified ? (f.objectifiedKind === 'value' ? 'value' : 'entity') : null
  }
  const self = state.objectTypes.find(o => o.id === x) ?? state.facts.find(f => f.id === x && f.objectified)
  const ref = self && kindOf(x) === 'entity' ? findRefMode(self, state.facts, state.objectTypes) : null
  const deg = degreeMap(state, schemaId)
  for (const f of state.facts) {
    if (f.schemaId !== schemaId || f._implicit || f.id === ref?.factId) continue
    if (!f.roles.some(r => r.objectTypeId === x)) continue
    const far = [...new Set(f.roles.map(r => r.objectTypeId).filter(id => id && id !== x))]
    const attribute = far.every(id => kindOf(id) === 'value')
    out.push({
      key: f.id, group: attribute ? 'attributes' : 'relationships', label: factLabel(state, f),
      ids: [f.id], far, defaultOn: attribute,
      hub: !attribute && far.some(id => (deg.get(id) ?? 0) > HUB),
    })
  }
  for (const s of state.subtypes ?? []) {
    if (s.schemaId !== schemaId) continue
    if (s.superId === x) out.push({ key: s.id, group: 'subtypes', label: nameOf(state, s.subId), ids: [s.id], far: [s.subId], defaultOn: true, hub: false })
    else if (s.subId === x) out.push({ key: s.id, group: 'supertypes', label: nameOf(state, s.superId), ids: [s.id], far: [s.superId], defaultOn: false,
      hub: (deg.get(s.superId) ?? 0) > HUB })
  }
  return out
}

// ── Relational ───────────────────────────────────────────────────────────────

const sameSet = (a, b) => a.length === b.length && a.every(c => b.includes(c))

// A junction table: its primary key is made of the columns of two or more
// foreign keys (it may have other columns, such as last_update).
function junctionFks(t) {
  if (!t.pk || t.fks.length < 2) return null
  const fks = t.fks.filter(fk => fk.from.every(c => t.pk.includes(c)))
  if (fks.length < 2) return null
  const covered = new Set(fks.flatMap(fk => fk.from))
  return t.pk.every(c => covered.has(c)) ? fks : null
}

function relationalUnits(state, schemaId, x, model = relationalModel(state, schemaId)) {
  const table = model.tables.find(t => t.id === x)
  if (!table) return []
  const deg = new Map(model.tables.map(t => [t.id, 0]))
  for (const fk of model.fks) {
    deg.set(fk.fromTable.id, deg.get(fk.fromTable.id) + 1)
    deg.set(fk.toTable.id, deg.get(fk.toTable.id) + 1)
  }
  const hub = (id) => deg.get(id) > HUB
  const cols = (fk) => fk.from.map(c => c.name).join(', ')
  const out = [], seen = new Map()
  // One unit per table (set): a second foreign key between the same tables
  // adds its columns to the label.
  const push = (u, more = null) => {
    const k = u.ids.join('|')
    const had = seen.get(k)
    if (had) {
      if (more) had.label = had.label.replace(/\)$/, `; ${more})`)
      had.defaultOn = had.defaultOn || u.defaultOn
      return
    }
    seen.set(k, u); out.push(u)
  }
  // A key of t over exactly these columns (1:1 or dependent tables).
  const isKeyOf = (t, from) => (t.pk && sameSet(t.pk, from)) || t.uniques.some(u => sameSet(u, from))
  for (const fk of table.fks) {
    const to = fk.toTable
    if (to.id === x) continue
    // This table depends on the one it references (a subtype or 1:1 table).
    const owner = isKeyOf(table, fk.from)
    push({ key: fk.constraintId, group: 'references', label: `${to.name} (${cols(fk)})`, ids: [to.id], far: [to.id], defaultOn: owner, hub: hub(to.id) }, cols(fk))
  }
  for (const fk of model.fks) {
    if (fk.toTable.id !== x || fk.fromTable.id === x) continue
    const t = fk.fromTable
    const jf = junctionFks(t)
    if (jf && jf.includes(fk)) {
      const farTables = [...new Set(jf.filter(o => o !== fk).map(o => o.toTable))].filter(o => o.id !== x)
      push({ key: `${fk.constraintId}:m2m`, group: 'manyToMany',
        label: `${t.name} → ${farTables.map(o => o.name).join(', ') || table.name}`,
        ids: [t.id, ...farTables.map(o => o.id)], far: farTables.map(o => o.id), defaultOn: false, hub: farTables.some(o => hub(o.id)) })
      continue
    }
    // Dependants: weak tables (the foreign key is part of their key), and 1:1 ones.
    const dependant = !!t.pk && fk.from.every(c => t.pk.includes(c)) || isKeyOf(t, fk.from)
    push({ key: fk.constraintId, group: 'referencedBy', label: `${t.name} (${cols(fk)})`, ids: [t.id], far: [t.id], defaultOn: dependant, hub: hub(t.id) }, cols(fk))
  }
  return out
}

// ── Suggested starting points ────────────────────────────────────────────────

// The major types of a schema, ranked, as seeds for new diagrams (after the
// schema abstraction of Campbell, Halpin and Proper: a major type has many
// roles and is referenced; minor ones, such as attributes' value types,
// subtypes and dependent tables, are attached to a major one by the picker's
// defaults). majorTypes(state, schemaId, limit) →
//   [{ id, name, score, reason, diagrams }]  (diagrams: plain diagrams showing it)
export function majorTypes(state, schemaId, limit = 20) {
  const relational = isRelational(state, schemaId)
  const model = relational ? relationalModel(state, schemaId) : null
  const shownOn = new Map()
  for (const d of state.diagrams ?? []) {
    if (d.mappingId || d.schemaId !== schemaId) continue
    for (const id of new Set((d.occurrences ?? []).map(o => o.schemaElementId))) shownOn.set(id, (shownOn.get(id) ?? 0) + 1)
  }
  const out = []
  const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`
  if (relational) {
    for (const t of model.tables) {
      // Junction tables go with the tables they join; a table keyed by a
      // foreign key (subtype, 1:1 or weak table) goes with the one it depends
      // on unless it has much of its own.
      if (junctionFks(t)) continue
      const units = relationalUnits(state, schemaId, t.id, model)
      const dependant = units.some(u => u.group === 'references' && u.defaultOn)
      const by = units.filter(u => u.group === 'referencedBy').length
      const refs = units.filter(u => u.group === 'references').length
      const m2m = units.filter(u => u.group === 'manyToMany').length
      const score = 2 * by + 2 * m2m + refs + t.columns.length / 10 - (dependant ? 3 : 0)
      if (by + refs + m2m === 0 || score <= 1) continue
      const reason = [by && `referenced by ${plural(by, 'table')}`, refs && `references ${plural(refs, 'table')}`, m2m && `${m2m} many-to-many`].filter(Boolean).join(', ')
      out.push({ id: t.id, name: t.name, score, reason, diagrams: shownOn.get(t.id) ?? 0 })
    }
  } else {
    const subOf = new Set((state.subtypes ?? []).filter(s => s.schemaId === schemaId).map(s => s.subId))
    const cands = [
      ...state.objectTypes.filter(o => o.schemaId === schemaId && o.kind === 'entity'),
      ...state.facts.filter(f => f.schemaId === schemaId && f.objectified && !f._implicit),
    ]
    for (const c of cands) {
      const units = ormUnits(state, schemaId, c.id)
      const n = (g) => units.filter(u => u.group === g).length
      const rel = n('relationships'), attr = n('attributes'), sub = n('subtypes')
      // Mandatory roles it plays (outside its reference scheme).
      const mand = units.filter(u => u.ids.length === 1).reduce((k, u) => {
        const f = state.facts.find(x => x.id === u.ids[0])
        return k + (f?.roles.some(r => r.objectTypeId === c.id && r.mandatory) ? 1 : 0)
      }, 0)
      // A subtype goes with its supertype unless it has much of its own.
      const score = 2 * rel + attr + 1.5 * sub + 0.5 * mand - (subOf.has(c.id) ? 2 : 0)
      if (rel + sub === 0 || score <= 1) continue
      const reason = [rel && plural(rel, 'relationship'), attr && plural(attr, 'attribute'), sub && plural(sub, 'subtype')].filter(Boolean).join(', ')
      out.push({ id: c.id, name: nameOf(state, c.id), score, reason, diagrams: shownOn.get(c.id) ?? 0 })
    }
  }
  return out.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name)).slice(0, limit)
}

// ── Connect ──────────────────────────────────────────────────────────────────

// The shortest chain of neighbourhood units from one element to another
// (fact types and subtype links in ORM2, foreign keys and junction tables in a
// relational schema), going through hubs only when there is no other way of
// about the same length. → [{ unit, anchorId, step }] (anchorId: the element the
// unit is reached from), [] when they are the same, or null when there is none.
export function connectPath(state, schemaId, fromId, toId) {
  if (fromId === toId) return []
  const relational = isRelational(state, schemaId)
  const model = relational ? relationalModel(state, schemaId) : null
  const unitsOf = new Map()
  const units = (x) => {
    if (!unitsOf.has(x)) unitsOf.set(x, relational ? relationalUnits(state, schemaId, x, model) : ormUnits(state, schemaId, x))
    return unitsOf.get(x)
  }
  const deg = relational ? null : degreeMap(state, schemaId)
  const isHub = (id, u) => relational ? u.hub : (deg.get(id) ?? 0) > HUB
  const via = (y) => relational || state.objectTypes.some(o => o.id === y && o.kind === 'entity') || state.facts.some(f => f.id === y && f.objectified)
  const dist = new Map([[fromId, 0]]), prev = new Map()
  const queue = [[0, fromId]]
  const done = new Set()
  while (queue.length) {
    queue.sort((a, b) => a[0] - b[0])
    const [d, x] = queue.shift()
    if (done.has(x)) continue
    done.add(x)
    if (x === toId) break
    for (const u of units(x)) {
      for (const y of u.far) {
        // Not through value types: sharing one is no relationship.
        if (y !== toId && !via(y)) continue
        const cost = d + 1 + (y !== toId && isHub(y, u) ? 3 : 0)
        if (cost < (dist.get(y) ?? Infinity)) { dist.set(y, cost); prev.set(y, { from: x, unit: u }); queue.push([cost, y]) }
      }
    }
  }
  if (!prev.has(toId)) return null
  const chain = []
  for (let y = toId; y !== fromId; y = prev.get(y).from) chain.unshift(prev.get(y))
  return chain.map((p, i) => ({ unit: p.unit, anchorId: p.from, step: i }))
}
