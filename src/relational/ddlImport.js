// Turns parsed PostgreSQL DDL (ddlParse.js) into a relational schema in
// encoding B (docs/logic/schema-mappings.tex, 'The relational profile'):
//   table          → entity type
//   column         → binary fact type "table has column" to a value type, with
//                    a uniqueness constraint on the table's role
//   NOT NULL       → mandatory table role
//   PRIMARY KEY    → preferred identifier (internal UC on the value role for
//                    one column, external UC for several)
//   UNIQUE         → uniqueness constraint (internal or external)
//   FOREIGN KEY    → subset constraint between the column sequences
//   CHECK, enum    → value ranges where they are a list or a range of values
//
// Columns linked by foreign keys share their value type, as do unrelated
// columns of the same name and type, so that the subset constraints compare
// like with like. A column whose name differs from its value type's keeps its
// name as the role name of the value role (and in the reading).
//
// buildRelationalSchema(parsed, { schemaId, diagramName }) →
//   { objectTypes, facts, constraints, diagram, log, stats }

import { parseDdl, tokenize } from './ddlParse.js'
import { checkToFormula, splitCheck } from './checkFormula.js'
import { relationalModel } from './relationalModel.js'
import { findRefMode, findCompositePI, identifyingFactIds } from '../utils/refMode.js'
import { mkEntity, mkValue, mkFact, mkUniqueness, withMandatoryId, mkConstraint, mkDiagram, mkOcc, uid } from '../store/storeHelpers.js'

export function importPostgresDdl(sql, opts) {
  const parsed = parseDdl(sql)
  const built = buildRelationalSchema(parsed, opts)
  built.sample = samplePopulation(parsed, built)
  return built
}

// ── Sample rows ──────────────────────────────────────────────────────────────

// The rows of the script's INSERT statements as the sample population of the
// built schema: { populations, factPopulations, rows, log }. A row is an
// instance of its table's entity type, identified by its primary key (the
// reference mode, or the composite identifier); every other column with a
// value is a tuple of the column's fact type. Rows of a table without a
// primary key, or with a key that isn't given, are left out.
const MAX_ROWS = 20000
export function samplePopulation(parsed, built) {
  const populations = {}, factPopulations = {}
  const log = []
  const inserts = parsed.inserts ?? []
  if (!inserts.length) return { populations, factPopulations, rows: 0, log }
  const { objectTypes, facts, constraints } = built
  const rm = relationalModel({ objectTypes, facts, constraints }, null)
  const ident = identifyingFactIds(facts, objectTypes, constraints)
  const byName = new Map(rm.tables.map(t => [t.name.toLowerCase(), t]))
  const sets = new Map()
  const add = (obj, id, cell, key) => {
    if (!sets.has(obj)) sets.set(obj, new Map())
    const m = sets.get(obj)
    if (!m.has(id)) { m.set(id, new Set()); obj[id] = [] }
    if (m.get(id).has(key)) return
    m.get(id).add(key)
    obj[id].push(cell)
  }
  let rows = 0, dropped = 0, expr = 0
  const noKey = new Set(), unknownCols = new Set()
  for (const ins of inserts) {
    const table = byName.get(ins.table.name.toLowerCase()) ?? byName.get(`${ins.table.schema}_${ins.table.name}`.toLowerCase())
    if (!table) { dropped += ins.rows.length; continue }
    const cols = ins.columns ?? table.columns.map(c => c.name)
    const colOf = cols.map(n => {
      const c = table.columns.find(x => x.name.toLowerCase() === String(n).toLowerCase())
      if (!c) unknownCols.add(`${table.name}.${n}`)
      return c
    })
    // How a row's entity is identified.
    const refMode = findRefMode(table.entity, facts, objectTypes)
    const cp = refMode ? null : findCompositePI(table.entity, facts, objectTypes, constraints)
    const keyFacts = refMode ? [refMode.factId] : cp ? (cp.factIds ?? (cp.factId ? [cp.factId] : [])) : []
    if (!keyFacts.length) { noKey.add(table.name); dropped += ins.rows.length; continue }
    for (const row of ins.rows) {
      if (rows >= MAX_ROWS) { dropped++; continue }
      const val = new Map()
      row.forEach((v, i) => {
        if (v === undefined) expr++
        // Leading and trailing spaces don't count in sample values.
        if (colOf[i] && v != null && String(v).trim() !== '') val.set(colOf[i].fact.id, String(v).trim())
      })
      const keyVals = keyFacts.map(fid => val.get(fid))
      if (keyVals.some(v => v == null)) { dropped++; continue }
      const cell = refMode ? keyVals[0] : keyVals
      add(populations, table.entity.id, cell, JSON.stringify(cell))
      rows++
      for (const [fid, v] of val) {
        const col = rm.columnByFact.get(fid)
        add(populations, col.vt.id, v, JSON.stringify(v))
        if (ident.entity.has(fid)) continue
        const t = []
        t[col.t] = cell; t[col.v] = v
        add(factPopulations, fid, t, JSON.stringify([JSON.stringify(cell), v]))
      }
    }
  }
  if (rows) log.push({ level: 'note', text: `Read ${rows} rows of INSERT statements into the sample population` })
  if (dropped) log.push({ level: 'warn', text: `Left out ${dropped} rows${noKey.size ? ` (no primary key: ${[...noKey].join(', ')})` : ''}${rows >= MAX_ROWS ? `; at most ${MAX_ROWS} rows are read` : ''}` })
  if (expr) log.push({ level: 'warn', text: `Left out ${expr} values that are not literals (expressions or function calls)` })
  if (unknownCols.size) log.push({ level: 'warn', text: `Columns not in the table: ${[...unknownCols].slice(0, 8).join(', ')}` })
  return { populations, factPopulations, rows, log }
}

// ── Types ────────────────────────────────────────────────────────────────────

const SIMPLE = {
  int: 'integer', int4: 'integer', integer: 'integer',
  int2: 'smallint', smallint: 'smallint',
  int8: 'bigint', bigint: 'bigint',
  serial: 'serial', serial4: 'serial', bigserial: 'bigserial', serial8: 'bigserial',
  smallserial: 'smallserial', serial2: 'smallserial',
  numeric: 'numeric', decimal: 'numeric',
  real: 'real', float4: 'real',
  'double precision': 'double precision', float8: 'double precision',
  money: 'money', text: 'text', bytea: 'bytea',
  varchar: 'character varying', 'character varying': 'character varying',
  char: 'character', character: 'character', bpchar: 'character',
  bool: 'boolean', boolean: 'boolean', date: 'date',
  uuid: 'uuid', json: 'json', jsonb: 'jsonb', xml: 'xml', inet: 'inet', cidr: 'cidr', macaddr: 'macaddr',
}

const intArg = (a) => { const n = parseInt(a, 10); return Number.isFinite(n) ? n : undefined }

// The datatype assignment for a parsed column type, or null.
export function pgAssignment(type) {
  if (!type?.name) return null
  const name = type.name
  const args = type.args ?? []
  const as = (datatypeId, params = {}) => {
    const p = Object.fromEntries(Object.entries(params).filter(([, v]) => v !== undefined && v !== false && v !== ''))
    return { profileId: 'postgresql', datatypeId, ...(Object.keys(p).length ? { params: p } : {}) }
  }
  if (name === 'float') return as(intArg(args[0]) <= 24 ? 'real' : 'double precision')
  if (name === 'time' || name === 'time without time zone') return as('time', { precision: intArg(args[0]) })
  if (name === 'timetz' || name === 'time with time zone') return as('time', { precision: intArg(args[0]), withTimeZone: true })
  if (name === 'timestamp' || name === 'timestamp without time zone') return as('timestamp', { precision: intArg(args[0]) })
  if (name === 'timestamptz' || name === 'timestamp with time zone') return as('timestamp', { precision: intArg(args[0]), withTimeZone: true })
  if (name.startsWith('interval')) return as('interval', { fields: name.slice(8).trim().toUpperCase() || undefined, precision: intArg(args[0]) })
  const id = SIMPLE[name]
  if (!id) return null
  if (id === 'numeric') return as(id, { precision: intArg(args[0]), scale: intArg(args[1]) })
  if (id === 'character varying' || id === 'character') return as(id, { length: intArg(args[0]) })
  return as(id)
}

const assignmentKey = (a) => a ? `${a.datatypeId}(${Object.entries(a.params ?? {}).map(([k, v]) => `${k}=${v}`).join(',')})` : ''

// ── CHECK conditions → value ranges ──────────────────────────────────────────

// Reads a CHECK condition on one column as value range specs:
// { column, specs } or null when it is not a list or a range of values.
// `column` is the name the condition is about ('value' for a domain).
export function checkToRange(text) {
  let tks = dropIsNull(stripCasts(tokenize(text)))
  const res = orOfValues(tks) ?? andOfBounds(tks)
  return res
}

function stripCasts(tks) {
  const out = []
  for (let i = 0; i < tks.length; i++) {
    const t = tks[i]
    if (t.t === 'op' && t.v === '::') {
      // skip a type name: words, dots, and one (...) or [] group
      i++
      while (i < tks.length && (tks[i].t === 'id' || tks[i].t === 'qid' || (tks[i].t === 'op' && tks[i].v === '.'))) {
        if (tks[i].t === 'id' && ['and', 'or', 'between', 'in'].includes(tks[i].v)) break
        i++
      }
      if (tks[i]?.t === 'op' && tks[i].v === '[' && tks[i + 1]?.v === ']') i += 2
      i--
      continue
    }
    out.push(t)
  }
  return out
}

// Removes parentheses around the whole list, repeatedly.
function unwrap(tks) {
  while (tks.length >= 2 && tks[0].v === '(' && tks[tks.length - 1].v === ')') {
    let depth = 0, whole = true
    for (let i = 0; i < tks.length; i++) {
      if (tks[i].v === '(' && tks[i].t === 'op') depth++
      if (tks[i].v === ')' && tks[i].t === 'op') depth--
      if (depth === 0 && i < tks.length - 1) { whole = false; break }
    }
    if (!whole) break
    tks = tks.slice(1, -1)
  }
  return tks
}

function splitTop(tks, word) {
  const parts = [[]]
  let depth = 0
  let between = false   // the AND of BETWEEN x AND y is not a conjunction
  for (let i = 0; i < tks.length; i++) {
    const t = tks[i]
    if (t.t === 'op' && t.v === '(') depth++
    if (t.t === 'op' && t.v === ')') depth--
    if (depth === 0 && t.t === 'id' && t.v === 'between') between = true
    if (depth === 0 && t.t === 'id' && t.v === word) {
      if (word === 'and' && between) { between = false; parts[parts.length - 1].push(t); continue }
      parts.push([])
      continue
    }
    parts[parts.length - 1].push(t)
  }
  return parts
}

// Drops "col IS NULL" alternatives: a CHECK passes on NULL anyway.
function dropIsNull(tks) {
  const parts = splitTop(unwrap(tks), 'or').map(unwrap)
  if (parts.length < 2) return tks
  const kept = parts.filter(p => !(p.length === 3 && colName(p[0]) && p[1].t === 'id' && p[1].v === 'is' && p[2].t === 'id' && p[2].v === 'null'))
  if (kept.length === parts.length || !kept.length) return tks
  const out = []
  kept.forEach((p, i) => { if (i) out.push({ t: 'id', v: 'or', raw: 'OR' }); out.push({ t: 'op', v: '(', raw: '(' }, ...p, { t: 'op', v: ')', raw: ')' }) })
  return out
}

const colName = (t) => (t?.t === 'id' || t?.t === 'qid') && !['and', 'or', 'not', 'in', 'between', 'any', 'array', 'null', 'true', 'false'].includes(t.v) ? t.v : null

// A literal at tks[i]: { value, next } (a number may have a sign).
function literal(tks, i) {
  const t = tks[i]
  if (!t) return null
  if (t.t === 'str') return { value: t.v, next: i + 1 }
  if (t.t === 'num') return { value: t.v, next: i + 1 }
  if (t.t === 'op' && (t.v === '-' || t.v === '+') && tks[i + 1]?.t === 'num') return { value: (t.v === '-' ? '-' : '') + tks[i + 1].v, next: i + 2 }
  if (t.t === 'id' && (t.v === 'true' || t.v === 'false')) return { value: t.v, next: i + 1 }
  return null
}

function literalList(tks) {
  const out = []
  let i = 0
  while (i < tks.length) {
    const l = literal(tks, i)
    if (!l) return null
    out.push(l.value)
    i = l.next
    if (i < tks.length) { if (tks[i].v !== ',') return null; i++ }
  }
  return out
}

// col IN (...), col = ANY (ARRAY[...]), and ORs of col = v.
function orOfValues(tks) {
  const parts = splitTop(unwrap(tks), 'or').map(unwrap)
  let column = null
  const values = []
  for (const p of parts) {
    const c = colName(p[0])
    if (!c || (column && column !== c)) return null
    column = c
    if (p[1]?.t === 'id' && p[1].v === 'in' && p[2]?.v === '(' && p[p.length - 1]?.v === ')') {
      const vs = literalList(p.slice(3, -1)); if (!vs) return null; values.push(...vs); continue
    }
    if (p[1]?.v === '=' && p[2]?.t === 'id' && p[2].v === 'any') {
      // = ANY ((ARRAY[...])) or = ANY (ARRAY[...])
      const inner = unwrap(p.slice(3))
      if (inner[0]?.t === 'id' && inner[0].v === 'array' && inner[1]?.v === '[' && inner[inner.length - 1]?.v === ']') {
        const vs = literalList(inner.slice(2, -1)); if (!vs) return null; values.push(...vs); continue
      }
      return null
    }
    if (p[1]?.v === '=' && p.length >= 3) {
      const l = literal(p, 2); if (!l || l.next !== p.length) return null; values.push(l.value); continue
    }
    return null
  }
  if (!column || !values.length) return null
  return { column, specs: values.map(v => ({ type: 'single', value: v })) }
}

const FLIP = { '<': '>', '<=': '>=', '>': '<', '>=': '<=', '=': '=' }

// Conjunctions of col op v, v op col and col BETWEEN a AND b, as one interval.
function andOfBounds(tks) {
  const parts = splitTop(unwrap(tks), 'and').map(unwrap)
  let column = null
  let lo = null, hi = null   // { v, open }
  const num = (v) => Number(v)
  const tighterLo = (b) => { if (!lo || num(b.v) > num(lo.v) || (num(b.v) === num(lo.v) && b.open)) lo = b }
  const tighterHi = (b) => { if (!hi || num(b.v) < num(hi.v) || (num(b.v) === num(hi.v) && b.open)) hi = b }
  for (const p of parts) {
    let c = colName(p[0]), op, l
    if (c && p[1]?.t === 'id' && p[1].v === 'between') {
      const a = literal(p, 2)
      if (!a || p[a.next]?.v !== 'and') return null
      const b = literal(p, a.next + 1)
      if (!b || b.next !== p.length) return null
      if (column && column !== c) return null
      column = c
      tighterLo({ v: a.value, open: false }); tighterHi({ v: b.value, open: false })
      continue
    }
    if (c) { op = p[1]?.v; l = literal(p, 2) }
    else {
      l = literal(p, 0)
      if (!l) return null
      op = FLIP[p[l.next]?.v]
      c = colName(p[l.next + 1])
      if (!c || l.next + 2 !== p.length) return null
      l = { value: l.value, next: p.length }
    }
    if (!c || !op || !l || l.next !== p.length || !Number.isFinite(num(l.value))) return null
    if (column && column !== c) return null
    column = c
    if (op === '>') tighterLo({ v: l.value, open: true })
    else if (op === '>=') tighterLo({ v: l.value, open: false })
    else if (op === '<') tighterHi({ v: l.value, open: true })
    else if (op === '<=') tighterHi({ v: l.value, open: false })
    else if (op === '=') { tighterLo({ v: l.value, open: false }); tighterHi({ v: l.value, open: false }) }
    else return null
  }
  if (!column || (!lo && !hi)) return null
  let spec
  if (lo && hi && lo.v === hi.v && !lo.open && !hi.open) spec = { type: 'single', value: lo.v }
  else if (lo && hi) spec = { type: 'range', lower: lo.v, upper: hi.v, ...(lo.open && { lowerOpen: true }), ...(hi.open && { upperOpen: true }) }
  else if (lo) spec = { type: 'lower', lower: lo.v, ...(lo.open && { lowerOpen: true }) }
  else spec = { type: 'upper', upper: hi.v, ...(hi.open && { upperOpen: true }) }
  return { column, specs: [spec] }
}

// ── Schema ───────────────────────────────────────────────────────────────────

const ROW_H = 56          // vertical distance between columns of a table
const BLOCK_W = 560       // width of a table's block on the diagram
const GAP_Y = 70

export function buildRelationalSchema(parsed, { schemaId = null, diagramName = 'Tables' } = {}) {
  const log = []
  const note = (text) => log.push({ level: 'note', text })
  const warn = (text) => log.push({ level: 'warn', text })
  const { tables, enums, domains } = parsed

  // Table names: bare unless two schemas use the same name.
  const nameCount = new Map()
  for (const t of tables) nameCount.set(t.name, (nameCount.get(t.name) ?? 0) + 1)
  const tableName = (t) => nameCount.get(t.name) > 1 && t.schema ? `${t.schema}_${t.name}` : t.name
  const findTable = (name, schema) => tables.find(t => t.name === name && (!schema || t.schema === schema))
    ?? tables.find(t => t.name === name)

  // ── Column types and value-type classes ──
  const colKey = (t, c) => `${t.schema ?? ''}.${t.name}.${c}`
  const colInfo = new Map()   // key → { table, col, assignment, vtSpecs }
  const unknownTypes = new Set()
  for (const t of tables) {
    for (const c of t.columns) {
      let type = c.type
      let vtSpecs = null
      let notNull = c.notNull
      const extraChecks = []
      const bare = type.name
      if (!type.array && enums.has(bare)) {
        vtSpecs = enums.get(bare).map(v => ({ type: 'single', value: v }))
        type = { name: 'text', args: [] }
      } else if (!type.array && domains.has(bare)) {
        const d = domains.get(bare)
        type = d.type
        notNull = notNull || d.notNull
        for (const ch of d.checks) {
          const r = checkToRange(ch)
          if (r && r.column === 'value') vtSpecs = r.specs
          else extraChecks.push({ domain: bare, text: ch })
        }
      }
      let assignment = type.array ? null : pgAssignment(type)
      // A serial column is an integer column with generated values; its value
      // type is the plain integer type (so referencing columns get it too) and
      // the serial is kept on the column's role.
      let generated = c.identity ? 'identity' : c.defaultGenerated ?? null
      const plain = { serial: 'integer', bigserial: 'bigint', smallserial: 'smallint' }[assignment?.datatypeId]
      if (plain) { generated = assignment.datatypeId; assignment = { profileId: 'postgresql', datatypeId: plain } }
      if (type.array) { assignment = { profileId: 'postgresql', datatypeId: 'text' }; warn(`${tableName(t)}.${c.name}: the array type ${bare}[] is read as text`) }
      else if (!assignment) unknownTypes.add(bare)
      colInfo.set(colKey(t, c.name), { table: t, col: c, assignment, vtSpecs, notNull, extraChecks, generated })
    }
  }
  if (unknownTypes.size) warn(`Types with no PostgreSQL datatype here, left unset: ${[...unknownTypes].sort().join(', ')}`)

  // Foreign keys, resolved: referencing and referenced column keys.
  const fks = []
  for (const t of tables) {
    for (const fk of t.foreignKeys) {
      const rt = findTable(fk.refTable, fk.refSchema)
      if (!rt) { warn(`${tableName(t)}: foreign key to ${fk.refTable}, which is not in the script, is left out`); continue }
      const refCols = fk.refColumns ?? rt.primaryKey
      if (!refCols || refCols.length !== fk.columns.length) { warn(`${tableName(t)}: foreign key (${fk.columns.join(', ')}) to ${tableName(rt)} has no matching key columns and is left out`); continue }
      const from = fk.columns.map(c => colKey(t, c)), to = refCols.map(c => colKey(rt, c))
      const missing = [...from, ...to].filter(k => !colInfo.has(k))
      if (missing.length) { warn(`${tableName(t)}: foreign key (${fk.columns.join(', ')}) names unknown columns and is left out`); continue }
      fks.push({ table: t, refTable: rt, from, to })
    }
  }

  // Union-find over columns: a foreign key column shares the type of the
  // column it references.
  const parent = new Map([...colInfo.keys()].map(k => [k, k]))
  const find = (k) => { while (parent.get(k) !== k) { parent.set(k, parent.get(parent.get(k))); k = parent.get(k) } return k }
  for (const fk of fks) fk.from.forEach((k, i) => {
    const a = find(k), b = find(fk.to[i])
    if (a !== b) parent.set(a, b)   // the referenced side is the root
  })
  const classes = new Map()   // root → [key]
  for (const k of colInfo.keys()) {
    const r = find(k)
    if (!classes.has(r)) classes.set(r, [])
    classes.get(r).push(k)
  }

  // One value type per class; classes with the same name and type merge.
  const usedNames = new Set(tables.map(tableName))
  const vtByKey = new Map()      // column key → value type
  const vtByNameType = new Map() // `${name}\u0000${type}` → value type
  const objectTypes = []
  for (const [root, keys] of classes) {
    const rootInfo = colInfo.get(root)
    const assignment = rootInfo.assignment
    for (const k of keys) {
      const a = colInfo.get(k).assignment
      if (a && assignment && assignmentKey(a) !== assignmentKey(assignment) && SIMPLE_FAMILY(a) !== SIMPLE_FAMILY(assignment))
        note(`${tableName(colInfo.get(k).table)}.${colInfo.get(k).col.name} references a column of another type; it takes ${assignmentKey(assignment)}`)
    }
    const base = rootInfo.col.name
    const typeKey = assignmentKey(assignment) + '|' + JSON.stringify(rootInfo.vtSpecs ?? null)
    let vt = vtByNameType.get(`${base}\u0000${typeKey}`)
    if (!vt) {
      let name = base
      if (usedNames.has(name)) name = `${tableName(rootInfo.table)}_${base}`
      for (let i = 2; usedNames.has(name); i++) name = `${tableName(rootInfo.table)}_${base}${i}`
      usedNames.add(name)
      vt = { ...mkValue(0, 0), name, schemaId, datatypeAssignment: assignment ?? null,
        ...(rootInfo.vtSpecs ? { valueRange: rootInfo.vtSpecs } : {}) }
      objectTypes.push(vt)
      vtByNameType.set(`${base}\u0000${typeKey}`, vt)
    }
    for (const k of keys) vtByKey.set(k, vt)
  }

  // ── Tables and columns ──
  const facts = []
  const constraints = []
  const factByKey = new Map()   // column key → fact
  const entityOf = new Map()    // table → entity type
  for (const t of tables) {
    const e = { ...mkEntity(0, 0), name: tableName(t), schemaId }
    entityOf.set(t, e)
    objectTypes.push(e)
    const pk = t.primaryKey ?? []
    if (!pk.length) note(`Table ${e.name} has no primary key`)
    const singleUnique = new Set(t.uniques.filter(u => u.length === 1).map(u => u[0]))
    const otherChecks = []
    for (const c of t.columns) {
      const k = colKey(t, c.name)
      const info = colInfo.get(k)
      const vt = vtByKey.get(k)
      const f = { ...mkFact(0, 0, 2), schemaId }
      const parts = c.name === vt.name ? ['', 'has', ''] : ['', `has ${c.name} as`, '']
      f.readingParts = parts
      f.roles = [
        withMandatoryId({ ...f.roles[0], objectTypeId: e.id, mandatory: !!(info.notNull || pk.includes(c.name)) }),
        { ...f.roles[1], objectTypeId: vt.id, roleName: c.name === vt.name ? '' : c.name,
          ...(info.generated && { sqlGenerated: info.generated }) },
      ]
      f.uniqueness = [mkUniqueness([0])]
      const isPk = pk.length === 1 && pk[0] === c.name
      if (isPk || singleUnique.has(c.name)) f.uniqueness.push(mkUniqueness([1]))
      if (isPk) f.preferredUniqueness = [[1]]
      // Column CHECKs on this column alone become a value range on its role;
      // others become formula constraints, below.
      c.checks.forEach((ch, i) => {
        const r = checkToRange(ch)
        if (r && r.column === c.name) f.roles[1] = { ...f.roles[1], valueRange: intersectSpecs(f.roles[1].valueRange, r.specs) }
        else otherChecks.push({ text: ch, name: c.checkNames?.[i] ?? null, where: `${e.name}.${c.name}`, column: c.name })
      })
      for (const x of info.extraChecks) otherChecks.push({ text: x.text, name: null, where: `${e.name}.${c.name}`, domain: x.domain, column: c.name })
      facts.push(f)
      factByKey.set(k, f)
    }
    // Table CHECKs: those on one column become value ranges.
    t.checks.forEach((ch, i) => {
      const r = checkToRange(ch)
      const f = r && factByKey.get(colKey(t, r.column))
      if (f) f.roles[1] = { ...f.roles[1], valueRange: intersectSpecs(f.roles[1].valueRange, r.specs) }
      else otherChecks.push({ text: ch, name: t.checkNames?.[i] ?? null, where: e.name })
    })
    // Other CHECKs (checkFormula.js): a conjunct comparing two columns is a
    // value comparison constraint, one on a column's values alone a value
    // range, and what is left a formula constraint over the table's rows.
    const columns = new Map(t.columns.map(c => [c.name, { factId: factByKey.get(colKey(t, c.name)).id, vtId: vtByKey.get(colKey(t, c.name)).id }]))
    const usedNames = new Set()
    // PostgreSQL's own name for an unnamed CHECK: table_column_check; a CHECK
    // split in parts names them name, name_2, …
    const nameFor = (ch, k, column) => {
      let name = ch.name ? (k ? `${ch.name}_${k + 1}` : ch.name) : null
      if (!name) {
        const base = `${e.name}_${column ?? ''}_check`.replace('__', '_')
        name = base
        for (let j = 1; usedNames.has(name); j++) name = `${base}${j}`
      }
      usedNames.add(name)
      return name
    }
    for (const ch of otherChecks) {
      const what = ch.domain ? `the CHECK (${ch.text}) of domain ${ch.domain}` : `CHECK (${ch.text})`
      let restTexts = [ch.text]
      let k = 0
      if (!ch.domain) {
        const sp = splitCheck(ch.text)
        if (sp.error) { warn(`${ch.where}: ${what} is left out: ${sp.error} is not read yet`); continue }
        for (const cmp of sp.comparisons) {
          const a = columns.get(cmp.left), b = columns.get(cmp.right)
          if (!a || !b) { sp.rest.push(cmp.text); continue }
          const name = nameFor(ch, k++, cmp.left)
          constraints.push({ ...mkConstraint('valueComparison', 0, 0), schemaId, name, operator: cmp.op,
            sequences: [[{ kind: 'role', factId: a.factId, roleIndex: 1 }, { kind: 'role', factId: b.factId, roleIndex: 1 }]], queries: [null], _table: t })
          note(`${ch.where}: ${cmp.text} is read as a value comparison constraint (${name})`)
        }
        restTexts = []
        for (const text of sp.rest) {
          const r = checkToRange(text)
          const f = r && factByKey.get(colKey(t, r.column))
          if (f) {
            f.roles[1] = { ...f.roles[1], valueRange: intersectSpecs(f.roles[1].valueRange, r.specs) }
            note(`${ch.where}: ${text} is read as a value range of ${r.column}`)
          } else restTexts.push(text)
        }
        if (!restTexts.length) continue
      }
      const text = restTexts.length === 1 ? restTexts[0] : restTexts.map(x => `(${x})`).join(' AND ')
      const cols = ch.domain ? new Map([...columns, ['value', columns.get(ch.column)]]) : columns
      const res = checkToFormula(text, cols, e.id)
      if (res.error) { warn(`${ch.where}: ${what} is left out: ${res.error} is not read yet`); continue }
      const name = nameFor(ch, k, ch.column ?? res.columns.find(n => n !== 'value'))
      // The SQL text is kept for the export, with the column of each name
      // (renamed columns are renamed in the text) and the formula as read
      // (an edited formula is no longer this CHECK).
      const sqlText = ch.domain ? text.replace(/\bvalue\b/gi, ch.column) : text
      const sqlColumns = Object.fromEntries(res.columns.map(n => [n === 'value' && ch.domain ? ch.column : n, cols.get(n).factId]))
      constraints.push({ ...mkConstraint('formula', 0, 0), schemaId, name, rule: res.rule,
        sqlCheck: { text: sqlText, columns: sqlColumns, rule: JSON.stringify(res.rule) }, _table: t })
      note(`${ch.where}: ${text === ch.text ? what : `CHECK (${text})`} is read as the formula constraint ${name}`)
    }
    // Composite keys: external uniqueness over the value roles.
    const composite = [...(pk.length > 1 ? [{ cols: pk, preferred: true }] : []),
      ...t.uniques.filter(u => u.length > 1 && !(u.length === pk.length && u.every(c => pk.includes(c)))).map(cols => ({ cols, preferred: false }))]
    for (const { cols, preferred } of composite) {
      const members = cols.map(c => factByKey.get(colKey(t, c)))
      if (members.some(m => !m)) { warn(`${e.name}: key (${cols.join(', ')}) names unknown columns and is left out`); continue }
      constraints.push({ ...mkConstraint('uniqueness', 0, 0), schemaId, isPreferredIdentifier: preferred, targetObjectTypeId: e.id,
        sequences: [members.map(f => ({ kind: 'role', factId: f.id, roleIndex: 1 }))], queries: [null], _table: t })
    }
    // Columns of a single-column primary key or unique constraint are not repeated in uniques.
    for (const u of t.uniques) if (u.some(c => !colInfo.has(colKey(t, c)))) warn(`${e.name}: UNIQUE (${u.join(', ')}) names unknown columns and is left out`)
  }

  // Foreign keys: subset constraints.
  for (const fk of fks) {
    const seq = (keys) => keys.map(k => ({ kind: 'role', factId: factByKey.get(k).id, roleIndex: 1 }))
    constraints.push({ ...mkConstraint('subset', 0, 0), schemaId, sequences: [seq(fk.from), seq(fk.to)], queries: [null, null], _table: fk.table, _refTable: fk.refTable })
  }

  // ── Diagram ──
  const diagram = { ...mkDiagram(diagramName, schemaId), profileId: 'postgresql' }
  const occs = []
  const coccs = []
  const perRow = Math.max(1, Math.min(5, Math.ceil(Math.sqrt(tables.length))))
  const blockPos = new Map()
  // A table with a one-column primary key has a reference mode. Its key column
  // is drawn as a fact type like the other columns, so the entity is marked
  // expanded and the key column's occurrences belong to it; otherwise the
  // entity would also show the "(.ref)" shorthand.
  const expandedRefModeOccs = []
  // Formula constraints (CHECKs) stand right of their table's value types,
  // so the blocks are wider when there are any.
  const badgeW = Math.max(0, ...constraints.filter(c => c.constraintType === 'formula').map(c => 8 * (c.name.length + 2) + 12))
  const blockW = BLOCK_W + (badgeW ? badgeW + 30 : 0)
  let y = 80, rowH = 0
  tables.forEach((t, i) => {
    const col = i % perRow
    if (col === 0 && i) { y += rowH + GAP_Y; rowH = 0 }
    const x = 120 + col * blockW
    const n = Math.max(1, t.columns.length)
    const h = (n - 1) * ROW_H
    rowH = Math.max(rowH, h + 40)
    const e = entityOf.get(t)
    const eOcc = mkOcc(e.id, x, y + h / 2)
    occs.push(eOcc)
    e.x = x; e.y = y + h / 2
    blockPos.set(t, { x, y, h })
    const rm = findRefMode(e, facts, objectTypes)
    if (rm) expandedRefModeOccs.push(eOcc.id)
    t.columns.forEach((c, j) => {
      const k = colKey(t, c.name)
      const f = factByKey.get(k)
      const vt = vtByKey.get(k)
      const fy = y + j * ROW_H
      const owned = rm?.factId === f.id ? { refModeOwnerOccId: eOcc.id } : {}
      const vtOcc = mkOcc(vt.id, x + 330, fy, owned)
      const fOcc = mkOcc(f.id, x + 165, fy, { roleOccurrenceMap: { 0: eOcc.id, 1: vtOcc.id }, ...owned })
      occs.push(fOcc, vtOcc)
      f.x = x + 165; f.y = fy
      if (!vt._placed) { vt.x = x + 330; vt.y = fy; vt._placed = true }
    })
  })
  const formulaCount = new Map()
  for (const c of constraints) {
    const b = blockPos.get(c._table)
    let cx, cy
    if (c.constraintType === 'formula') {
      // Right of the table's value types, one under the other.
      const k = formulaCount.get(c._table) ?? 0
      formulaCount.set(c._table, k + 1)
      cx = b.x + 490 + badgeW / 2; cy = b.y + k * 32
    } else if (c.constraintType === 'uniqueness' || c.constraintType === 'valueComparison') {
      const ys = c.sequences[0].map(m => facts.find(f => f.id === m.factId).y)
      cx = b.x + (c.constraintType === 'uniqueness' ? 250 : 215); cy = ys.reduce((a, v) => a + v, 0) / ys.length
    } else {
      const fromY = facts.find(f => f.id === c.sequences[0][0].factId).y
      const toY = facts.find(f => f.id === c.sequences[1][0].factId).y
      const rb = blockPos.get(c._refTable)
      cx = (b.x + rb.x) / 2 + 250 + (b === rb ? 60 : 0)
      cy = (fromY + toY) / 2
    }
    c.x = Math.round(cx); c.y = Math.round(cy)
    coccs.push({ id: `cocc_${uid()}`, schemaConstraintId: c.id, x: c.x, y: c.y, roleOccurrenceRefs: {}, queryOccurrenceRefs: {} })
    delete c._table; delete c._refTable
  }
  for (const vt of objectTypes) delete vt._placed
  diagram.occurrences = occs
  diagram.constraintOccurrences = coccs
  diagram.expandedRefModeOccs = expandedRefModeOccs

  const stats = { tables: tables.length, columns: facts.length, valueTypes: objectTypes.length - tables.length,
    keys: constraints.filter(c => c.constraintType === 'uniqueness').length + facts.filter(f => f.uniqueness.length > 1).length,
    foreignKeys: fks.length, checks: constraints.filter(c => c.constraintType === 'formula').length,
    comparisons: constraints.filter(c => c.constraintType === 'valueComparison').length }
  for (const [kind, n] of parsed.skipped) note(`Skipped ${n} × ${kind}`)
  for (const p of parsed.problems) warn(p)
  return { objectTypes, facts, constraints, diagram, log, stats }
}

// Integer types (and their serials) count as one family when a foreign key
// column and the column it references differ only in size.
function SIMPLE_FAMILY(a) {
  const id = a?.datatypeId
  if (['smallint', 'integer', 'bigint', 'smallserial', 'serial', 'bigserial'].includes(id)) return 'int'
  return id
}

// Two CHECKs on one column: keep both ranges only when they are lists
// (intersection of value lists); otherwise the later one wins.
function intersectSpecs(prev, next) {
  if (!prev?.length) return next
  if (prev.every(s => s.type === 'single') && next.every(s => s.type === 'single')) {
    const vs = new Set(next.map(s => s.value))
    return prev.filter(s => vs.has(s.value))
  }
  return next
}
