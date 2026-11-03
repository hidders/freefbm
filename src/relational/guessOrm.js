// Guessing an ORM2 schema from a relational one (workbench plan, step 9).
//
// Reverse engineering in the style of the classic heuristics (Hainaut's
// DB-MAIN, NORMA's Rmap read backwards), on a relational schema of the file
// (encoding B, relationalModel.js):
//   table                 → entity type, named by the table (singular, Pascal case)
//   primary key           → its reference scheme: a reference mode for one
//                           column, else a preferred external uniqueness
//                           constraint over the key's columns and foreign keys
//   surrogate key         → (a generated column) dropped when the table has a
//                           declared UNIQUE natural key, which then identifies
//                           it; otherwise kept as the reference mode. The
//                           choice can be overridden per table.
//   primary key that is a foreign key → subtype of the referenced table's type
//   junction table        → (all columns in its foreign keys, all in its key,
//                           not referenced) an m:n (or n-ary) fact type
//   other column          → fact type "Entity has Value", mandatory when NOT NULL
//   foreign key           → fact type between the two entity types, read from
//                           the column name ("reports to", "has support rep")
//   UNIQUE                → uniqueness constraint (internal or external)
//
// It also writes the mapping between the two schemas: one rule per entity
// type, per attribute fact type and per foreign key or junction fact type,
// with the relational schema as source. Each rule identifies the entities it
// names through their reference schemes, joining over a dropped surrogate
// where it has to.
//
// analyseTables(state, relSchemaId) → [{ table, kind, name, surrogate, naturalKey, defaultSurrogate, superTable }]
// guessOrmSchema(state, relSchemaId, { schemaId, surrogates, mappingName }) →
//   { objectTypes, facts, subtypes, constraints, diagram, mapping, log, stats }

import { relationalModel } from './relationalModel.js'
import { mkEntity, mkValue, mkFact, mkUniqueness, withMandatoryId, mkConstraint, mkDiagram, mkOcc,
  mkSubtype, uid, addOwnedRefModeOccsIfAbsent } from '../store/storeHelpers.js'
import { mkMapping } from '../mapping/mapping.js'

// ── Names ────────────────────────────────────────────────────────────────────

const words = (name) => String(name ?? '')
  .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
  .split(/[^A-Za-z0-9]+/).filter(Boolean).map(w => w.toLowerCase())
const pascal = (ws) => ws.map(w => w.charAt(0).toUpperCase() + w.slice(1)).join('')

// The singular of an English plural, for the last word of a table name.
export function singular(w) {
  if (w.length <= 3) return w
  if (/ies$/.test(w)) return w.slice(0, -3) + 'y'
  if (/(ss|x|ch|sh)es$/.test(w)) return w.slice(0, -2)
  if (/(ss|us|is)$/.test(w)) return w
  if (/s$/.test(w)) return w.slice(0, -1)
  return w
}
const entityWords = (tableName) => {
  const ws = words(tableName)
  if (ws.length) ws[ws.length - 1] = singular(ws[ws.length - 1])
  return ws
}

const PREPOSITIONS = new Set(['to', 'via', 'by', 'from', 'for', 'of', 'in', 'on', 'at', 'with'])

// The reading of a foreign key's fact type from its column name: "has" when
// the name is the referenced table's, the name itself when it reads as a verb
// phrase ("reports to"), else "has <name>".
function fkReading(fk, refWords) {
  if (fk.from.length !== 1) return 'has'
  let ws = words(fk.from[0].name)
  if (ws.length > 1 && (ws[ws.length - 1] === 'id' || ws[ws.length - 1] === 'key' || ws[ws.length - 1] === 'no')) ws = ws.slice(0, -1)
  if (!ws.length || (ws.length === 1 && ws[0] === 'id')) return 'has'
  const same = (a, b) => a.length === b.length && a.every((w, i) => w === b[i] || singular(w) === singular(b[i]))
  if (same(ws, refWords) || same(ws, words(fk.toTable.name)) || same(words(fk.from[0].name), words(fk.to[0].name))) return 'has'
  if (ws.length >= 2 && (/[^s]s$/.test(ws[0]) || PREPOSITIONS.has(ws[ws.length - 1]))) return ws.join(' ')
  return `has ${ws.join(' ')}`
}

// ── Analysis ─────────────────────────────────────────────────────────────────

const sameSet = (a, b) => a.length === b.length && a.every(x => b.includes(x))

// How each table will be read: { table, kind: 'entity' | 'junction' |
// 'subtype' | 'nokey', name, surrogate, naturalKey, defaultSurrogate,
// superTable, superFk }.
export function analyseTables(state, relSchemaId, rm = relationalModel(state, relSchemaId)) {
  const referenced = new Set(rm.fks.map(fk => fk.toTable.id))
  const out = []
  for (const t of rm.tables) {
    const info = { table: t, kind: 'entity', name: pascal(entityWords(t.name)) || 'Entity',
      surrogate: null, naturalKey: null, defaultSurrogate: null, superTable: null, superFk: null }
    const pk = t.pk
    // A surrogate: a one-column key whose values are generated.
    if (pk?.length === 1 && pk[0].generated) {
      info.surrogate = pk[0]
      const nk = t.uniques.filter(u => u.every(c => c.notNull && !c.generated) && !u.includes(pk[0]))
        .sort((a, b) => a.length - b.length)[0]
      info.naturalKey = nk ?? null
      info.defaultSurrogate = nk ? 'drop' : 'keep'
    }
    const inFk = new Set(t.fks.flatMap(fk => fk.from))
    const subFk = pk && t.fks.find(fk => fk.toTable !== t && sameSet(fk.from, pk) && fk.toTable.pk && sameSet(fk.to, fk.toTable.pk))
    if (pk && !t.columns.some(c => c.generated) && t.fks.length >= 2 && t.columns.every(c => inFk.has(c)) &&
        sameSet(pk, t.columns) && !referenced.has(t.id) &&
        t.fks.reduce((n, fk) => n + fk.from.length, 0) === t.columns.length) {
      info.kind = 'junction'
    } else if (subFk) {
      info.kind = 'subtype'
      info.superTable = subFk.toTable
      info.superFk = subFk
    } else if (!pk && !t.uniques.some(u => u.every(c => c.notNull))) {
      info.kind = 'nokey'
    }
    out.push(info)
  }
  // A subtype of a junction table (which has no entity type) stays an entity.
  const byId = new Map(out.map(i => [i.table.id, i]))
  for (const i of out) if (i.kind === 'subtype' && byId.get(i.superTable.id)?.kind === 'junction') { i.kind = 'entity'; i.superTable = null; i.superFk = null }
  return out
}

// ── The schema ───────────────────────────────────────────────────────────────

export function guessOrmSchema(state, relSchemaId, { schemaId = null, surrogates = {}, mappingName = null } = {}) {
  const log = []
  const note = (text) => log.push({ level: 'note', text })
  const warn = (text) => log.push({ level: 'warn', text })
  const rm = relationalModel(state, relSchemaId)
  const plan = analyseTables(state, relSchemaId, rm)
  const info = new Map(plan.map(p => [p.table.id, p]))

  // Which surrogates go.
  for (const p of plan) {
    if (!p.surrogate) continue
    const choice = surrogates[p.table.id] ?? p.defaultSurrogate
    p.dropSurrogate = choice === 'drop' && !!p.naturalKey
    if (choice === 'drop' && !p.naturalKey) warn(`${p.table.name}: the surrogate ${p.surrogate.name} is kept, as the table has no UNIQUE NOT NULL natural key`)
  }
  // The columns that identify a table's rows in the ORM2 schema.
  for (const p of plan) {
    const t = p.table
    if (p.kind === 'subtype') p.key = t.pk
    else if (p.dropSurrogate) p.key = p.naturalKey
    else if (t.pk) p.key = t.pk
    else if (p.kind !== 'nokey') {
      p.key = t.uniques.filter(u => u.every(c => c.notNull)).sort((a, b) => a.length - b.length)[0]
      note(`${t.name} has no primary key; its UNIQUE (${p.key.map(c => c.name).join(', ')}) identifies it`)
    }
  }

  const objectTypes = [], facts = [], subtypes = [], constraints = []
  const names = new Set()
  const uniqueName = (n) => { let u = n; for (let i = 2; names.has(u); i++) u = `${n}${i}`; names.add(u); return u }

  // Entity types first, so value types can avoid their names.
  const entityOf = new Map()   // table id → entity type
  for (const p of plan) {
    if (p.kind === 'junction') continue
    const e = { ...mkEntity(0, 0), name: uniqueName(p.name), schemaId }
    entityOf.set(p.table.id, e)
    p.entity = e
    objectTypes.push(e)
  }

  // Value types, shared by name, datatype and value range; a length or
  // precision that differs takes the larger. A name already taken by another
  // datatype gets the entity type's name in front.
  const vtByKey = new Map()
  const vtNamesTaken = new Set()
  const valueType = (name, col, own = false, owner = null) => {
    const a = col.vt.datatypeAssignment ?? null
    const key = own ? `own:${name}` : `${name}|${a?.profileId}:${a?.datatypeId}|${JSON.stringify(col.vt.valueRange ?? null)}`
    const had = vtByKey.get(key)
    if (had) {
      if (a?.params && had.datatypeAssignment) {
        const p = { ...(had.datatypeAssignment.params ?? {}) }
        for (const [k, v] of Object.entries(a.params)) if (typeof v === 'number') p[k] = Math.max(p[k] ?? v, v)
        had.datatypeAssignment = { ...had.datatypeAssignment, params: p }
      }
      return had
    }
    let n = name
    if (vtNamesTaken.has(n) && owner && !n.startsWith(owner.name)) n = owner.name + n
    vtNamesTaken.add(n)
    const vt = { ...mkValue(0, 0), name: uniqueName(n), schemaId, datatypeAssignment: a ? { ...a, ...(a.params ? { params: { ...a.params } } : {}) } : null,
      ...(col.vt.valueRange?.length ? { valueRange: col.vt.valueRange } : {}) }
    vtByKey.set(key, vt)
    objectTypes.push(vt)
    return vt
  }
  const vtName = (col) => {
    const n = pascal(words(col.name)) || 'Value'
    return [...entityOf.values()].some(e => e.name === n) ? `${n}Value` : n
  }
  const roleRange = (col) => col.fact.roles[col.v]?.valueRange?.length ? { valueRange: col.fact.roles[col.v].valueRange } : {}

  // A binary fact type: role 0 played by `a`, role 1 by `b`.
  const binary = (a, b, reading, extra = {}) => {
    const f = { ...mkFact(0, 0, 2), schemaId, readingParts: ['', reading, ''] }
    f.roles = [{ ...f.roles[0], objectTypeId: a.id }, { ...f.roles[1], objectTypeId: b.id }]
    Object.assign(f, extra)
    facts.push(f)
    return f
  }
  const setMandatory = (f, i) => { f.roles[i] = withMandatoryId({ ...f.roles[i], mandatory: true }) }

  // Per table: the fact type of each column and foreign key.
  //   p.colFact: col → { fact, role }   (the role holding the column's value)
  //   p.fkFact:  fk  → fact (role 1 = referenced entity)
  for (const p of plan) { p.colFact = new Map(); p.fkFact = new Map() }

  for (const p of plan) {
    const t = p.table, e = p.entity
    if (p.kind === 'junction') continue
    if (p.kind === 'subtype') {
      const st = { ...mkSubtype(e.id, entityOf.get(p.superTable.id).id), schemaId }
      subtypes.push(st)
    }
    const key = p.key ?? []
    const keyFks = p.kind === 'subtype' ? [] : t.fks.filter(fk => fk.from.every(c => key.includes(c)))
    const keyFkCols = new Set(keyFks.flatMap(fk => fk.from))
    const keyPlain = p.kind === 'subtype' ? [] : key.filter(c => !keyFkCols.has(c))
    p.keyFks = keyFks
    p.keyPlain = keyPlain
    const inFk = new Set(t.fks.flatMap(fk => fk.from))

    // The reference scheme.
    if (p.kind !== 'subtype' && key.length === 1 && keyPlain.length === 1) {
      // A reference mode.
      const col = key[0]
      let n = pascal(words(col.name))
      if (!n.startsWith(e.name)) n = e.name + n
      const surrogateKept = p.surrogate === col
      const vt = surrogateKept || t.pk?.[0] === col ? valueType(n, col, true) : valueType(vtName(col), col, false, e)
      const f = binary(e, vt, 'has', { uniqueness: [mkUniqueness([1])], preferredUniqueness: [[1]],
        alternativeReadings: [{ roleOrder: [1, 0], parts: ['', 'refers to', ''] }] })
      f.roles[1] = { ...f.roles[1], ...roleRange(col) }
      p.colFact.set(col, { fact: f, role: 1 })
    } else if (p.kind !== 'subtype' && key.length) {
      const members = []
      for (const col of keyPlain) {
        const f = binary(e, valueType(vtName(col), col, false, e), 'has', { uniqueness: [mkUniqueness([0])] })
        setMandatory(f, 0)
        f.roles[1] = { ...f.roles[1], ...roleRange(col) }
        p.colFact.set(col, { fact: f, role: 1 })
        members.push({ kind: 'role', factId: f.id, roleIndex: 1 })
      }
      for (const fk of keyFks) {
        const ref = entityOf.get(fk.toTable.id)
        if (!ref) continue
        const f = binary(e, ref, fkReading(fk, words(ref.name)), { uniqueness: [mkUniqueness([0])] })
        setMandatory(f, 0)
        p.fkFact.set(fk, f)
        members.push({ kind: 'role', factId: f.id, roleIndex: 1 })
      }
      if (members.length === 1) {
        // One entity role identifies: a preferred uniqueness constraint on it.
        const f = facts.find(x => x.id === members[0].factId)
        f.uniqueness.push(mkUniqueness([1])); f.preferredUniqueness = [[1]]
      } else {
        constraints.push({ ...mkConstraint('uniqueness', 0, 0), schemaId, isPreferredIdentifier: true,
          targetObjectTypeId: e.id, sequences: [members], queries: [null], _entity: e })
      }
    } else if (p.kind === 'nokey') {
      warn(`${t.name} has no primary key and no UNIQUE NOT NULL columns; ${e.name} has no reference scheme and the mapping has no rules for it`)
    }

    // Other columns.
    for (const col of t.columns) {
      if (p.colFact.has(col) || inFk.has(col) || (p.dropSurrogate && col === p.surrogate)) continue
      if (p.kind === 'subtype' && key.includes(col)) continue
      const f = binary(e, valueType(vtName(col), col, false, e), 'has', { uniqueness: [mkUniqueness([0])] })
      if (col.notNull) setMandatory(f, 0)
      f.roles[1] = { ...f.roles[1], ...roleRange(col) }
      p.colFact.set(col, { fact: f, role: 1 })
    }
    // Foreign keys.
    for (const fk of t.fks) {
      if (p.fkFact.has(fk) || fk === p.superFk) continue
      const ref = entityOf.get(fk.toTable.id)
      if (!ref) continue
      const f = binary(e, ref, fkReading(fk, words(ref.name)), { uniqueness: [mkUniqueness([0])] })
      if (fk.from.every(c => c.notNull)) setMandatory(f, 0)
      p.fkFact.set(fk, f)
    }
    if (p.dropSurrogate) note(`${t.name}: the surrogate ${p.surrogate.name} is dropped; ${e.name} is identified by ${p.naturalKey.map(c => c.name).join(', ')}`)
  }

  // Junction tables: m:n (or n-ary) fact types.
  for (const p of plan) {
    if (p.kind !== 'junction') continue
    const t = p.table
    const players = t.fks.map(fk => entityOf.get(fk.toTable.id))
    if (players.some(x => !x)) { warn(`${t.name}: a junction table between tables without entity types is left out`); continue }
    const n = players.length
    const f = { ...mkFact(0, 0, n), schemaId }
    f.roles = f.roles.map((r, i) => ({ ...r, objectTypeId: players[i].id }))
    const ws = words(t.name)
    const refWs = new Set(players.flatMap(x => words(x.name)).concat(t.fks.flatMap(fk => words(fk.toTable.name))))
    const own = ws.filter(w => !refWs.has(w) && !refWs.has(singular(w)))
    const verb = own.length ? own.join(' ') : 'has'
    f.readingParts = n === 2 ? ['', verb, ''] : ['', verb, ...Array(n - 2).fill('with'), '']
    f.uniqueness = [mkUniqueness(f.roles.map((_, i) => i))]
    facts.push(f)
    p.fact = f
    note(`${t.name} is a junction table: ${players.map(x => x.name).join(' – ')} is ${n === 2 ? 'a many-to-many' : `an ${n}-ary`} fact type`)
  }

  // Other uniqueness constraints.
  for (const p of plan) {
    if (p.kind === 'junction' || p.kind === 'nokey') continue
    const t = p.table
    const keys = [...t.uniques, ...(t.pk ? [t.pk] : [])]
    for (const u of keys) {
      if (p.key && sameSet(u, p.key)) continue
      if (p.dropSurrogate && u.length === 1 && u[0] === p.surrogate) continue
      if (p.kind === 'subtype' && sameSet(u, t.pk)) continue
      const members = []
      const used = new Set()
      for (const fk of t.fks) {
        if (fk.from.every(c => u.includes(c)) && p.fkFact.has(fk) && !fk.from.some(c => used.has(c))) {
          members.push({ kind: 'role', factId: p.fkFact.get(fk).id, roleIndex: 1 })
          fk.from.forEach(c => used.add(c))
        }
      }
      for (const c of u) {
        if (used.has(c)) continue
        const cf = p.colFact.get(c)
        if (!cf) { members.length = 0; break }
        members.push({ kind: 'role', factId: cf.fact.id, roleIndex: cf.role })
        used.add(c)
      }
      if (!members.length) { warn(`${t.name}: UNIQUE (${u.map(c => c.name).join(', ')}) has no ORM2 form here and is left out`); continue }
      if (members.length === 1) {
        const f = facts.find(x => x.id === members[0].factId)
        if (!f.uniqueness.some(x => x.roles.length === 1 && x.roles[0] === members[0].roleIndex)) f.uniqueness.push(mkUniqueness([members[0].roleIndex]))
      } else {
        constraints.push({ ...mkConstraint('uniqueness', 0, 0), schemaId, isPreferredIdentifier: false,
          targetObjectTypeId: p.entity.id, sequences: [members], queries: [null], _entity: p.entity })
      }
    }
  }

  const mapping = { ...mkMapping(mappingName ?? 'Mapping', relSchemaId, schemaId), rules: buildRules(plan, info, objectTypes) }
  for (const p of plan) if (p.kind === 'nokey') p.noRules = true

  const diagram = layoutDiagram(plan, rm, { objectTypes, facts, subtypes, constraints, schemaId })

  const stats = {
    entityTypes: entityOf.size, valueTypes: objectTypes.length - entityOf.size, factTypes: facts.length,
    subtypes: subtypes.length, junctions: plan.filter(p => p.kind === 'junction' && p.fact).length,
    dropped: plan.filter(p => p.dropSurrogate).length, rules: mapping.rules.length,
  }
  for (const c of constraints) delete c._entity
  return { objectTypes, facts, subtypes, constraints, diagram, mapping, log, stats, plan }
}

// ── Mapping rules ────────────────────────────────────────────────────────────

const and = (parts) => (parts.length === 1 ? parts[0] : { t: 'and', args: parts })
const exists = (vars, body) => vars.reduceRight((b, v) => ({ t: 'exists', v, body: b }), body)
const factAtom = (factId, args) => ({ t: 'fact', factId, args })
const typeAtom = (typeId, arg) => ({ t: 'type', typeId, arg })
const bindAtom = (id, y) => ({ t: 'vcmp', op: '≈', left: { t: 'var', id }, right: { t: 'fv', y } })

function buildRules(plan, info, objectTypes) {
  otNames = new Map(objectTypes.map(o => [o.id, o.name]))
  const rules = []
  for (const p of plan) {
    if (p.kind === 'nokey' || (p.kind === 'junction' && !p.fact)) continue
    if (p.kind === 'junction') { rules.push(junctionRule(p, info)); continue }
    rules.push(entityRule(p, info))
    for (const [col, cf] of p.colFact) {
      if ((p.key ?? []).includes(col)) continue
      rules.push(attributeRule(p, info, col, cf))
    }
    for (const [fk, f] of p.fkFact) {
      if (p.keyFks.includes(fk)) continue
      rules.push(fkRule(p, info, fk, f))
    }
  }
  return rules
}

// One rule's variables and frontier names.
function ruleScope() {
  let n = 0
  const ys = new Set()
  return {
    v: (typeId) => ({ id: `g${++n}`, typeId }),
    y: (name) => {
      const base = String(name).replace(/[^A-Za-z0-9_]/g, '_') || 'y'
      let y = base
      for (let i = 2; ys.has(y); i++) y = `${base}${i}`
      ys.add(y)
      return y
    },
  }
}

// Whether a column's value is a dropped surrogate (directly, or through the
// foreign keys of a reference scheme), so that the ORM2 side has no value for
// it and the source must join to the table that has its natural key.
function droppedValue(info, table, col, seen = new Set()) {
  const p = info.get(table.id)
  if (!p || seen.has(p)) return false
  seen.add(p)
  if (p.dropSurrogate && col === p.surrogate) return true
  if (p.kind === 'subtype' && p.superFk.from.includes(col)) {
    const i = p.superFk.from.indexOf(col)
    return droppedValue(info, p.superTable, p.superFk.to[i], seen)
  }
  for (const fk of table.fks) {
    const i = fk.from.indexOf(col)
    if (i >= 0 && (p.keyFks ?? []).includes(fk)) return droppedValue(info, fk.toTable, fk.to[i], seen)
  }
  return false
}

// The source term of a column of a table's row: a frontier variable, or a
// source variable when its value has no counterpart in the ORM2 schema.
function termFor(sc, info, src, table, col, ref = null) {
  if (ref ? droppedValue(info, ref.table, ref.col) : droppedValue(info, table, col)) {
    const v = sc.v(col.vt.id)
    src.vars.push(v)
    return { v: v.id }
  }
  return { y: sc.y(col.name) }
}
const termArg = (term) => (term.y ? { k: 'fv', y: term.y } : { k: 'var', v: term.v })

// Target parts that identify entity variable x of table `table`'s type, from
// the source terms of the table's columns (terms: col → term). Columns of
// the reference scheme that have no term (a dropped surrogate's table reached
// by its surrogate) are looked up by a join in the source.
function identify(sc, info, src, table, x, terms) {
  const p = info.get(table.id)
  if (p.kind === 'subtype') {
    const t2 = new Map()
    p.superFk.from.forEach((c, i) => { if (terms.has(c)) t2.set(p.superFk.to[i], terms.get(c)) })
    return [typeAtom(p.entity.id, x), ...identify(sc, info, src, p.superTable, x, t2)]
  }
  const key = p.key ?? []
  if (key.some(c => !terms.has(c))) {
    // Reached through the surrogate: join to the row to get the natural key.
    const st = terms.get(p.surrogate)
    const own = new Map(terms)
    const args = st ? { [p.surrogate.fact.id]: termArg(st) } : {}
    for (const c of key) {
      if (!own.has(c)) own.set(c, termFor(sc, info, src, table, c))
      args[c.fact.id] = termArg(own.get(c))
    }
    src.atoms.push({ t: 'rel', tableId: table.id, args })
    terms = own
  }
  const parts = []
  for (const col of p.keyPlain) {
    const cf = p.colFact.get(col)
    const w = sc.v(cf.fact.roles[1].objectTypeId)
    let term = terms.get(col)
    if (!term.y) {
      // A source variable: give it a frontier name for the target.
      const y = sc.y(col.name)
      src.atoms.push(bindAtom(term.v, y))
      term = { y }
    }
    parts.push(exists([w], and([factAtom(cf.fact.id, [x, w.id]), bindAtom(w.id, term.y)])))
  }
  for (const fk of p.keyFks) {
    const f = p.fkFact.get(fk)
    if (!f) continue
    const z = sc.v(f.roles[1].objectTypeId)
    const t2 = new Map()
    fk.from.forEach((c, i) => t2.set(fk.to[i], terms.get(c)))
    parts.push(exists([z], and([factAtom(f.id, [x, z.id]), ...identify(sc, info, src, fk.toTable, z.id, t2)])))
  }
  return parts
}

// The terms of a row's key columns, plus `more` columns.
function rowTerms(sc, info, src, p, more = []) {
  const terms = new Map()
  for (const c of [...(p.key ?? []), ...more]) if (!terms.has(c)) terms.set(c, termFor(sc, info, src, p.table, c))
  return terms
}
const relAtom = (table, terms) => ({ t: 'rel', tableId: table.id,
  args: Object.fromEntries([...terms].map(([c, term]) => [c.fact.id, termArg(term)])) })
const sourceTree = (src, main) => exists(src.vars, and([main, ...src.atoms]))

// A rule's name: the reading of its fact type.
let otNames = new Map()
const factName = (f) => f.roles.map((r, i) => [otNames.get(r.objectTypeId) ?? '?', f.readingParts?.[i + 1]].filter(Boolean).join(' ')).join(' ')

function entityRule(p, info) {
  const sc = ruleScope()
  const src = { vars: [], atoms: [] }
  const terms = rowTerms(sc, info, src, p)
  const x = sc.v(p.entity.id)
  const id = identify(sc, info, src, p.table, x.id, terms)
  const tgt = exists([x], and(p.kind === 'subtype' ? id : [typeAtom(p.entity.id, x.id), ...id]))
  return { id: uid(), name: p.entity.name, source: sourceTree(src, relAtom(p.table, terms)), target: tgt }
}

function attributeRule(p, info, col, cf) {
  const sc = ruleScope()
  const src = { vars: [], atoms: [] }
  const terms = rowTerms(sc, info, src, p, [col])
  const x = sc.v(p.entity.id), w = sc.v(cf.fact.roles[1].objectTypeId)
  const tgt = exists([x], and([...identify(sc, info, src, p.table, x.id, terms),
    exists([w], and([factAtom(cf.fact.id, [x.id, w.id]), bindAtom(w.id, terms.get(col).y)]))]))
  return { id: uid(), name: factName(cf.fact), source: sourceTree(src, relAtom(p.table, terms)), target: tgt }
}

function fkRule(p, info, fk, f) {
  const sc = ruleScope()
  const src = { vars: [], atoms: [] }
  const terms = rowTerms(sc, info, src, p)
  fk.from.forEach((c, i) => { if (!terms.has(c)) terms.set(c, termFor(sc, info, src, p.table, c, { table: fk.toTable, col: fk.to[i] })) })
  const x = sc.v(p.entity.id), z = sc.v(f.roles[1].objectTypeId)
  const t2 = new Map(fk.from.map((c, i) => [fk.to[i], terms.get(c)]))
  const main = relAtom(p.table, terms)
  const tgt = exists([x, z], and([...identify(sc, info, src, p.table, x.id, terms),
    ...identify(sc, info, src, fk.toTable, z.id, t2), factAtom(f.id, [x.id, z.id])]))
  return { id: uid(), name: factName(f), source: sourceTree(src, main), target: tgt }
}

function junctionRule(p, info) {
  const sc = ruleScope()
  const src = { vars: [], atoms: [] }
  const t = p.table
  const terms = new Map()
  for (const fk of t.fks) fk.from.forEach((c, i) => terms.set(c, termFor(sc, info, src, t, c, { table: fk.toTable, col: fk.to[i] })))
  const zs = p.fact.roles.map(r => sc.v(r.objectTypeId))
  const parts = []
  t.fks.forEach((fk, i) => {
    const t2 = new Map(fk.from.map((c, j) => [fk.to[j], terms.get(c)]))
    parts.push(...identify(sc, info, src, fk.toTable, zs[i].id, t2))
  })
  parts.push(factAtom(p.fact.id, zs.map(z => z.id)))
  return { id: uid(), name: factName(p.fact), source: sourceTree(src, relAtom(t, terms)), target: exists(zs, and(parts)) }
}

// ── Diagram ──────────────────────────────────────────────────────────────────

// Places boxes (Map id → {w, h}, sets x, y) in rows: the entity types that
// reference nothing at the top, those that reference them below, and so on,
// so that the lines between them run mostly up and down, between the blocks
// of attributes. A row that gets too wide wraps; within a row, a box goes
// near the boxes above it that it is linked to.
function rowLayout(boxes, ids, edges) {
  const idSet = new Set(ids)
  const out = new Map(ids.map(id => [id, new Set()])), inc = new Map(ids.map(id => [id, new Set()]))
  for (const [a, b] of edges) if (a !== b && idSet.has(a) && idSet.has(b)) { out.get(a).add(b); inc.get(b).add(a) }
  const depth = new Map(), onStack = new Set()
  const visit = (id) => {
    if (depth.has(id)) return depth.get(id)
    onStack.add(id)
    let d = 0
    for (const b of out.get(id)) if (!onStack.has(b)) d = Math.max(d, visit(b) + 1)
    onStack.delete(id)
    depth.set(id, d)
    return d
  }
  ids.forEach(visit)
  const layers = []
  for (const id of ids) (layers[depth.get(id)] ??= []).push(id)
  const area = ids.reduce((sum, id) => sum + (boxes.get(id).w + 80) * (boxes.get(id).h + 90), 0)
  const maxW = Math.max(1400, Math.sqrt(area) * 1.6)
  const cx = new Map()
  let y = 80
  for (const layer of layers.filter(Boolean)) {
    const key = (id) => {
      const xs = [...out.get(id), ...inc.get(id)].filter(n => cx.has(n)).map(n => cx.get(n))
      return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : Infinity
    }
    const sorted = layer.map((id, i) => ({ id, k: key(id), i })).sort((a, b) => a.k - b.k || a.i - b.i)
    let x = 80, rowH = 0
    for (const { id } of sorted) {
      const b = boxes.get(id)
      if (x > 80 && x + b.w > maxW) { y += rowH + 90; x = 80; rowH = 0 }
      b.x = x; b.y = y
      cx.set(id, x + b.w / 2)
      x += b.w + 80
      rowH = Math.max(rowH, b.h)
    }
    y += rowH + 110
  }
}

const ROW_H = 50
const ATTR_W = 330

function layoutDiagram(plan, rm, { objectTypes, facts, subtypes, constraints, schemaId }) {
  const diagram = { ...mkDiagram('Main', schemaId), profileId: 'postgresql' }
  const otById = new Map(objectTypes.map(o => [o.id, o]))
  const entities = plan.filter(p => p.entity)
  // A block per entity type: the entity, with its attributes to the right.
  const attrFacts = new Map(entities.map(p => [p.entity.id, []]))
  const linkFacts = []
  for (const f of facts) {
    const players = f.roles.map(r => otById.get(r.objectTypeId))
    if (f.roles.length === 2 && players[0]?.kind === 'entity' && players[1]?.kind === 'value') attrFacts.get(players[0].id)?.push(f)
    else linkFacts.push(f)
  }
  const refModeOf = new Map()
  for (const f of facts) if (f.preferredUniqueness?.some(u => u.length === 1 && u[0] === 1) && otById.get(f.roles[1].objectTypeId)?.kind === 'value') refModeOf.set(f.roles[0].objectTypeId, f)
  const boxes = new Map()
  for (const p of entities) {
    const n = attrFacts.get(p.entity.id).filter(f => refModeOf.get(p.entity.id) !== f).length
    boxes.set(p.entity.id, { w: n ? 110 + ATTR_W : 140, h: Math.max(60, n * ROW_H) })
  }
  const edges = []
  for (const f of linkFacts) for (let i = 1; i < f.roles.length; i++) edges.push([f.roles[0].objectTypeId, f.roles[i].objectTypeId])
  for (const st of subtypes) edges.push([st.subId, st.superId])
  rowLayout(boxes, entities.map(p => p.entity.id), edges)

  const occs = []
  const occOf = new Map()
  for (const p of entities) {
    const b = boxes.get(p.entity.id)
    const ex = Math.round(b.x + 120), ey = Math.round(b.y + b.h / 2)
    const o = mkOcc(p.entity.id, ex, ey)
    occs.push(o); occOf.set(p.entity.id, o)
    p.entity.x = ex; p.entity.y = ey
    const attrs = attrFacts.get(p.entity.id).filter(f => refModeOf.get(p.entity.id) !== f)
    attrs.forEach((f, i) => {
      const fy = Math.round(b.y + ROW_H / 2 + i * ROW_H)
      const vt = otById.get(f.roles[1].objectTypeId)
      const vo = mkOcc(vt.id, ex + 300, fy)
      occs.push(vo, mkOcc(f.id, ex + 150, fy, { roleOccurrenceMap: { 0: o.id, 1: vo.id } }))
      f.x = ex + 150; f.y = fy
      if (vt.x === 0 && vt.y === 0) { vt.x = ex + 300; vt.y = fy }
    })
  }
  // Fact types between entity types, half way between their players.
  const used = new Map()
  for (const f of linkFacts) {
    const os = f.roles.map(r => occOf.get(r.objectTypeId))
    if (os.some(o => !o)) continue
    let x = os.reduce((s, o) => s + o.x, 0) / os.length, y = os.reduce((s, o) => s + o.y, 0) / os.length
    if (os.every(o => o === os[0])) { x += 110; y -= 70 }   // a ring
    const k = `${Math.round(x / 40)}:${Math.round(y / 40)}`
    const n = used.get(k) ?? 0
    used.set(k, n + 1)
    y += n * 34
    f.x = Math.round(x); f.y = Math.round(y)
    occs.push(mkOcc(f.id, f.x, f.y, { roleOccurrenceMap: Object.fromEntries(os.map((o, i) => [i, o.id])) }))
  }
  diagram.occurrences = occs
  // Reference modes are drawn as the "(.ref)" shorthand: their value type and
  // fact type occurrences belong to the entity's occurrence.
  let d = diagram
  for (const [entityId, f] of refModeOf) {
    const e = otById.get(entityId)
    const vt = otById.get(f.roles[1].objectTypeId)
    if (vt.x === 0 && vt.y === 0) { vt.x = e.x + 160; vt.y = e.y }
    f.x = e.x + 80; f.y = e.y
    d = addOwnedRefModeOccsIfAbsent(d, entityId, vt.id, vt.x, vt.y, f.id, f.x, f.y, 1)
  }
  // Subtype links.
  d.subtypeOccurrences = subtypes.map(st => st.id)
  d.subtypeEndpointOccs = Object.fromEntries(subtypes.map(st => [st.id, [{ subOccId: occOf.get(st.subId).id, superOccId: occOf.get(st.superId).id }]]))
  // External uniqueness constraints, left of their entity type.
  d.constraintOccurrences = constraints.map(c => {
    const e = c._entity
    const fs = c.sequences[0].map(m => facts.find(f => f.id === m.factId))
    c.x = Math.round(fs.reduce((s, f) => s + f.x, 0) / fs.length)
    c.y = Math.round(fs.reduce((s, f) => s + f.y, 0) / fs.length + (fs.every(f => f.y === fs[0].y) ? -40 : 0))
    if (e && Math.abs(c.x - e.x) < 30 && Math.abs(c.y - e.y) < 30) c.y -= 50
    return { id: `cocc_${uid()}`, schemaConstraintId: c.id, x: c.x, y: c.y, roleOccurrenceRefs: {}, queryOccurrenceRefs: {} }
  })
  return d
}
