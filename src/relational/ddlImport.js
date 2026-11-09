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
//   { objectTypes, facts, constraints, diagram, diagrams, log, stats }
// diagram is the one of all tables; diagrams adds one per SQL schema
// (namespace) when there are several.

import { parseDdl, tokenize, uniqueKey, detectDialect } from './ddlParse.js'
import { checkToFormula, assertionToFormula, splitCheck } from './checkFormula.js'
import { relationalModel } from './relationalModel.js'
import { findRefMode, findCompositePI, identifyingFactIds } from '../utils/refMode.js'
import { mkEntity, mkValue, mkFact, mkUniqueness, withMandatoryId, mkConstraint, mkDiagram, mkOcc, uid } from '../store/storeHelpers.js'

// Whether a condition's text is one parenthesised whole: "(a OR b)", not "(a) OR (b)".
function wrapped(x) {
  if (!x.startsWith('(') || !x.endsWith(')')) return false
  let d = 0, quote = null
  for (let i = 0; i < x.length; i++) {
    if (quote) { if (x[i] === quote) quote = null; continue }
    if (x[i] === "'" || x[i] === '"') quote = x[i]
    else if (x[i] === '(') d++
    else if (x[i] === ')' && --d === 0 && i < x.length - 1) return false
  }
  return true
}

// A key's name in the script (CONSTRAINT name), kept as sqlName.
const keyName = (t, key) => t.keyNames?.[key] ?? null

export function importPostgresDdl(sql, opts) {
  const parsed = parseDdl(sql, { dialect: opts?.dialect ?? null })
  const built = buildRelationalSchema(parsed, { schemaNames: sqlSchemaNames(sql), ...opts })
  built.sample = samplePopulation(parsed, built)
  return built
}

// The SQL schemas a script creates, as it writes their names (the parser
// folds unquoted names to lower case): Map(lower → written).
export function sqlSchemaNames(sql) {
  const out = new Map()
  // SQL Server keeps names as written, [quoted] or not.
  const tsql = detectDialect(sql) === 'sqlserver'
  for (const m of sql.matchAll(/\bcreate\s+schema\s+(?:if\s+not\s+exists\s+)?("([^"]+)"|\[([^\]]+)\]|[A-Za-z_][\w$]*)/gi)) {
    const name = m[2] ?? m[3] ?? m[1]
    const key = m[2] ?? m[3] ?? (tsql ? name : name.toLowerCase())
    if (!out.has(key)) out.set(key, name)
  }
  return out
}

// ── Sample rows ──────────────────────────────────────────────────────────────

// A value as the sample population writes it: booleans as true/false (COPY
// writes t/f).
const TRUE = new Set(['t', 'true', 'y', 'yes', 'on', '1']), FALSE = new Set(['f', 'false', 'n', 'no', 'off', '0'])
function cellValue(col, v0, dateOrder = null) {
  const id = col.vt.datatypeAssignment?.datatypeId
  const v = dateOrder && (id === 'date' || id === 'timestamp') ? tsqlDate(v0, dateOrder) : v0
  // A date for a timestamp column (Oracle's DATE is read as timestamp(0)).
  if (id === 'timestamp' && /^\d{4}-\d{2}-\d{2}$/.test(v)) return `${v} 00:00:00`
  if (id !== 'boolean') return v
  const l = v.toLowerCase()
  return TRUE.has(l) ? 'true' : FALSE.has(l) ? 'false' : v
}

// A date as SQL Server reads it ('2021/1/2', '12/08/1948' in the script's
// DATEFORMAT order, default mdy, '19480812', '2021-01-02T10:00:00') in ISO
// form; anything else as it is.
const pad = (x) => String(x).padStart(2, '0')
export function tsqlDate(v, order = 'mdy') {
  const time = (t) => (t ? ` ${t.replace(/^[ T]/, '').trim()}` : '')
  let m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})([ T].*)?$/.exec(v)
  if (m) return `${m[1]}-${pad(m[2])}-${pad(m[3])}${time(m[4])}`
  m = /^(\d{4})(\d{2})(\d{2})([ T].*)?$/.exec(v)
  if (m) return `${m[1]}-${m[2]}-${m[3]}${time(m[4])}`
  m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})([ T].*)?$/.exec(v)
  if (m) {
    const [mo, d] = order === 'dmy' ? [m[2], m[1]] : [m[1], m[2]]
    return `${m[3]}-${pad(mo)}-${pad(d)}${time(m[4])}`
  }
  return v
}

// The rows of the script's INSERT statements (and COPY blocks) as the sample population of the
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
  // SQL Server reads dates in the order SET DATEFORMAT gives (mdy by default).
  const dateOrder = parsed.dialect === 'sqlserver' ? (parsed.dateFormat ?? 'mdy') : null
  let rows = 0, dropped = 0, expr = 0
  const noKey = new Set(), noKeyValue = new Set(), unknownCols = new Set(), cut = new Map()
  const tableOf = (ins) => byName.get(ins.table.name.toLowerCase()) ?? byName.get(`${ins.table.schema}_${ins.table.name}`.toLowerCase())
  // At most MAX_ROWS rows in all, shared fairly: small tables are read whole
  // (their rows are what the others refer to), large ones cut to an equal share.
  const given = new Map()
  for (const ins of inserts) { const t = tableOf(ins); if (t) given.set(t, (given.get(t) ?? 0) + ins.rows.length) }
  const quota = new Map(given)
  if ([...given.values()].reduce((a, b) => a + b, 0) > MAX_ROWS) {
    let left = MAX_ROWS
    const todo = [...given].sort((a, b) => a[1] - b[1])
    todo.forEach(([t, n], i) => { const q = Math.min(n, Math.floor(left / (todo.length - i))); quota.set(t, q); left -= q })
  }
  for (const ins of inserts) {
    const table = tableOf(ins)
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
      if (!(quota.get(table) > 0)) { dropped++; cut.set(table.name, (cut.get(table.name) ?? 0) + 1); continue }
      quota.set(table, quota.get(table) - 1)
      const val = new Map()
      row.forEach((v, i) => {
        if (v === undefined) expr++
        // Leading and trailing spaces don't count in sample values.
        if (colOf[i] && v != null && String(v).trim() !== '') val.set(colOf[i].fact.id, cellValue(colOf[i], String(v).trim(), dateOrder))
      })
      const keyVals = keyFacts.map(fid => val.get(fid))
      if (keyVals.some(v => v == null)) { dropped++; noKeyValue.add(table.name); continue }
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
  const how = [inserts.some(i => !i.copy) && 'INSERT statements', inserts.some(i => i.copy) && 'COPY blocks'].filter(Boolean).join(' and ')
  if (rows) log.push({ level: 'note', text: `Read ${rows} rows of ${how} into the sample population` })
  if (dropped) log.push({ level: 'warn', text: `Left out ${dropped} rows${noKey.size ? ` (no primary key: ${[...noKey].join(', ')})` : ''}${noKeyValue.size ? ` (no value for the primary key, e.g. one the database generates: ${[...noKeyValue].join(', ')})` : ''}${cut.size ? `; at most ${MAX_ROWS} rows are read, so large tables are cut (${[...cut].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([n, k]) => `${n} −${k}`).join(', ')}${cut.size > 6 ? ', …' : ''}), and some of their foreign keys may point to rows that were left out` : ''}` })
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
  macaddr8: 'macaddr8', bit: 'bit', varbit: 'bit varying', 'bit varying': 'bit varying',
  tsvector: 'tsvector', tsquery: 'tsquery',
  point: 'point', line: 'line', lseg: 'lseg', box: 'box', path: 'path', polygon: 'polygon', circle: 'circle',
  int4range: 'int4range', int8range: 'int8range', numrange: 'numrange',
  tsrange: 'tsrange', tstzrange: 'tstzrange', daterange: 'daterange',
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
  if (id === 'character varying' || id === 'character' || id === 'bit' || id === 'bit varying') return as(id, { length: intArg(args[0]) })
  return as(id)
}

// The datatype assignment for an Oracle column type: the nearest PostgreSQL
// type (relational schemas keep one type system), with the Oracle type as
// written in sqlTypes.oracle, so an Oracle export gives it back. null for a type
// FreeFBM does not know.
export function oracleAssignment(type) {
  if (!type?.name) return null
  const name = type.name
  const args = type.args ?? []
  const text = `${name.toUpperCase()}${args.length ? `(${args.join(', ').toUpperCase()})` : ''}`
  const as = (datatypeId, params = {}) => {
    const p = Object.fromEntries(Object.entries(params).filter(([, v]) => v !== undefined && v !== false && v !== ''))
    return { profileId: 'postgresql', datatypeId, ...(Object.keys(p).length ? { params: p } : {}), sqlTypes: { oracle: text } }
  }
  const p = intArg(args[0]), sc = args[1] != null ? intArg(args[1]) : undefined
  if (name === 'number' || name === 'numeric' || name === 'decimal' || name === 'dec') {
    if (args[0] === '*') return sc ? as('numeric', { precision: 38, scale: sc }) : as('numeric', { precision: 38, scale: 0 })
    if (p == null) return as('numeric')
    if (!sc) return p <= 4 ? as('smallint') : p <= 9 ? as('integer') : p <= 18 ? as('bigint') : as('numeric', { precision: p, scale: 0 })
    return as('numeric', { precision: p, scale: sc })
  }
  if (name === 'integer' || name === 'int' || name === 'smallint') return as('numeric', { precision: 38, scale: 0 })
  if (name === 'binary_float' || name === 'real' || (name === 'float' && p != null && p <= 24)) return as('real')
  if (name === 'binary_double' || name === 'double precision' || name === 'float') return as('double precision')
  if (['varchar2', 'nvarchar2', 'varchar', 'character varying', 'national character varying', 'nchar varying'].includes(name)) return as('character varying', { length: p })
  if (['char', 'nchar', 'character', 'national character'].includes(name)) return as('character', { length: p ?? 1 })
  if (['clob', 'nclob', 'long', 'rowid', 'urowid'].includes(name)) return as('text')
  if (['blob', 'raw', 'long raw', 'bfile'].includes(name)) return as('bytea')
  if (name === 'date') return as('timestamp', { precision: 0 })
  if (name === 'timestamp') return as('timestamp', { precision: p })
  if (name === 'timestamp with time zone' || name === 'timestamp with local time zone') return as('timestamp', { precision: p, withTimeZone: true })
  if (name.startsWith('interval year')) return as('interval', { fields: 'YEAR TO MONTH' })
  if (name.startsWith('interval day')) return as('interval', { fields: 'DAY TO SECOND' })
  if (name === 'boolean') return as('boolean')
  if (name === 'json') return as('jsonb')
  if (name === 'xmltype' || name === 'sys.xmltype') return as('xml')
  return null
}

// The datatype assignment for a SQL Server column type: the nearest SQL type
// (as for Oracle), with the type as written in sqlTypes.sqlserver. null for a
// type FreeFBM does not know (hierarchyid, geography, sql_variant…).
export function sqlserverAssignment(type) {
  if (!type?.name) return null
  const name = type.name.toLowerCase()
  const args = (type.args ?? []).map(a => String(a).trim())
  const text = `${name.toUpperCase()}${args.length && !(name === 'xml') ? `(${args.join(', ').toUpperCase()})` : ''}`
  const as = (datatypeId, params = {}) => {
    const p = Object.fromEntries(Object.entries(params).filter(([, v]) => v !== undefined && v !== false && v !== ''))
    return { profileId: 'postgresql', datatypeId, ...(Object.keys(p).length ? { params: p } : {}), sqlTypes: { sqlserver: text } }
  }
  const max = /^max$/i.test(args[0] ?? '')
  const p = max ? undefined : intArg(args[0]), sc = args[1] != null ? intArg(args[1]) : undefined
  switch (name) {
    case 'bit': return as('boolean')
    case 'tinyint': case 'smallint': return as('smallint')
    case 'int': case 'integer': return as('integer')
    case 'bigint': return as('bigint')
    case 'decimal': case 'dec': case 'numeric': return as('numeric', { precision: p ?? 18, scale: sc ?? 0 })
    case 'money': return as('numeric', { precision: 19, scale: 4 })
    case 'smallmoney': return as('numeric', { precision: 10, scale: 4 })
    case 'real': return as('real')
    case 'float': case 'double precision': return as(p != null && p <= 24 ? 'real' : 'double precision')
    case 'char': case 'nchar': case 'character': case 'national character': return as('character', { length: p ?? 1 })
    case 'varchar': case 'nvarchar': case 'character varying': case 'national character varying': case 'sysname':
      return max ? as('text') : as('character varying', { length: name === 'sysname' ? 128 : p ?? 1 })
    case 'text': case 'ntext': return as('text')
    case 'binary': case 'varbinary': case 'image': case 'rowversion': case 'timestamp': return as('bytea')
    case 'date': return as('date')
    case 'time': return as('time', { precision: p != null ? Math.min(p, 6) : undefined })
    case 'datetime': return as('timestamp', { precision: 3 })
    case 'smalldatetime': return as('timestamp', { precision: 0 })
    case 'datetime2': return as('timestamp', { precision: Math.min(p ?? 7, 6) })
    case 'datetimeoffset': return as('timestamp', { precision: Math.min(p ?? 7, 6), withTimeZone: true })
    case 'uniqueidentifier': return as('uuid')
    case 'xml': return as('xml')
    case 'json': return as('json')
  }
  return null
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

export function buildRelationalSchema(parsed, { schemaId = null, diagramName = 'Tables', schemaNames = null } = {}) {
  const log = []
  const note = (text) => log.push({ level: 'note', text })
  const warn = (text) => log.push({ level: 'warn', text })
  const { tables, enums, domains } = parsed
  const oracle = parsed.dialect === 'oracle', sqlserver = parsed.dialect === 'sqlserver'
  const assign = oracle ? oracleAssignment : sqlserver ? sqlserverAssignment : pgAssignment
  // A type FreeFBM does not know, as the other DBMS wrote it.
  const native = oracle || sqlserver ? (sql) => sql.toUpperCase() : null

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
      let assignment = type.array ? null : assign(type)
      // A serial column is an integer column with generated values; its value
      // type is the plain integer type (so referencing columns get it too) and
      // the serial is kept on the column's role.
      let generated = c.identity ? 'identity' : c.defaultGenerated ?? null
      const plain = { serial: 'integer', bigserial: 'bigint', smallserial: 'smallint' }[assignment?.datatypeId]
      if (plain) { generated = assignment.datatypeId; assignment = { profileId: 'postgresql', datatypeId: plain } }
      if (type.array) { assignment = { profileId: 'postgresql', datatypeId: 'text' }; warn(`${tableName(t)}.${c.name}: the array type ${bare}[] is read as text`) }
      else if (!assignment) {
        // A type of an extension or a CREATE TYPE: kept as written, so the
        // export gives it back.
        unknownTypes.add(bare)
        const sql = `${bare}${type.args?.length ? `(${type.args.join(', ')})` : ''}`
        assignment = { profileId: 'postgresql', datatypeId: 'user-defined', params: { sql }, ...(native ? { sqlTypes: { [parsed.dialect]: native(sql) } } : {}) }
      }
      colInfo.set(colKey(t, c.name), { table: t, col: c, assignment, vtSpecs, notNull, extraChecks, generated })
    }
  }
  if (oracle) {
    const kinds = new Map()
    for (const { table, col } of colInfo.values()) {
      const k = col.type.name
      if (k === 'date' || /^(varchar2|nvarchar2|char|nchar)$/.test(k)) (kinds.get(k) ?? kinds.set(k, []).get(k)).push(`${tableName(table)}.${col.name}`)
    }
    note('Read as Oracle DDL: each column has the nearest PostgreSQL type, and keeps its Oracle type for the Oracle export (NUMBER(p) is smallint, integer or bigint by its precision)')
    const list = (xs) => xs.length > 12 ? `${xs.slice(0, 12).join(', ')} and ${xs.length - 12} more` : xs.join(', ')
    if (kinds.has('date')) note(`Oracle's DATE holds a time of day too, so it is read as timestamp(0): ${list(kinds.get('date'))}`)
    const text = ['varchar2', 'nvarchar2', 'char', 'nchar'].flatMap(k => kinds.get(k) ?? [])
    if (text.length) note(`In Oracle an empty string is NULL, so these columns never hold '' there (a PostgreSQL export allows it): ${list(text)}`)
  }
  if (sqlserver) {
    const of = (re) => [...colInfo.values()].filter(x => re.test(x.col.type.name)).map(x => `${tableName(x.table)}.${x.col.name}`)
    const list = (xs) => xs.length > 12 ? `${xs.slice(0, 12).join(', ')} and ${xs.length - 12} more` : xs.join(', ')
    note('Read as SQL Server DDL: each column has the nearest SQL type, and keeps its SQL Server type for the SQL Server export (DATETIME is timestamp(3), BIT boolean, MONEY numeric(19, 4), NVARCHAR(MAX) text)')
    const tiny = of(/^tinyint$/)
    if (tiny.length) note(`TINYINT (0 to 255) is read as smallint: ${list(tiny)}`)
    // SQL Server's UNIQUE treats NULLs as equal (one NULL); standard SQL's,
    // which FreeFBM reads, compares only rows without NULLs.
    const nullableKeys = tables.flatMap(t => t.uniques.filter(u => u.some(c => !t.columns.find(x => x.name === c)?.notNull))
      .map(u => `${tableName(t)} (${u.join(', ')})`))
    if (nullableKeys.length) note(`These UNIQUE keys have columns that may be NULL. SQL Server allows one NULL in them, standard SQL (as FreeFBM reads them) any number; the SQL Server export keeps the standard meaning with a filtered unique index: ${list(nullableKeys)}`)
    const computed = tables.flatMap(t => (t.computed ?? []).map(c => `${tableName(t)}.${c}`))
    if (computed.length) note(`Computed columns (name AS expression) are left out: ${list(computed)}`)
  }
  if (unknownTypes.size) note(`Types FreeFBM does not know (from an extension or CREATE TYPE), kept as written: ${[...unknownTypes].sort().join(', ')}`)

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
      fks.push({ table: t, refTable: rt, from, to, name: fk.name ?? null })
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
    const typeKey = assignmentKey(assignment) + JSON.stringify(assignment?.sqlTypes ?? null) + '|' + JSON.stringify(rootInfo.vtSpecs ?? null)
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
  // CHECKs are read once every table has its columns, since a subquery may
  // read other tables (tableFor) and a CHECK may call a SQL function.
  const later = []
  const funcs = parsed.functions ?? null
  const tableFor = (name, schema) => {
    const t = findTable(name, schema)
    if (!t || !entityOf.has(t)) return null
    const cols = new Map(t.columns.map(c => [c.name, { factId: factByKey.get(colKey(t, c.name))?.id, vtId: vtByKey.get(colKey(t, c.name))?.id }]))
    return { name: entityOf.get(t).name, typeId: entityOf.get(t).id, columns: cols }
  }
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
      if (isPk || singleUnique.has(c.name)) {
        const sqlName = keyName(t, isPk ? 'pk' : uniqueKey([c.name]))
        f.uniqueness.push({ ...mkUniqueness([1]), ...(sqlName && { sqlName }) })
      }
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
    for (const ch of otherChecks) later.push(() => {
      const what = ch.domain ? `the CHECK (${ch.text}) of domain ${ch.domain}` : `CHECK (${ch.text})`
      let restTexts = [ch.text]
      let k = 0
      if (!ch.domain) {
        const sp = splitCheck(ch.text, funcs)
        if (sp.error) { warn(`${ch.where}: ${what} is left out: ${sp.error} is not read yet`); return }
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
        if (!restTexts.length) return
      }
      const text = restTexts.length === 1 ? restTexts[0] : restTexts.map(x => (wrapped(x) ? x : `(${x})`)).join(' AND ')
      const cols = ch.domain ? new Map([...columns, ['value', columns.get(ch.column)]]) : columns
      const res = checkToFormula(text, cols, e.id, { table: t.name, tables: tableFor, funcs })
      if (res.error) { warn(`${ch.where}: ${what} is left out: ${res.error} is not read yet`); return }
      const name = nameFor(ch, k, ch.column ?? res.columns.find(n => n !== 'value'))
      if (res.tables.length) {
        // A CHECK that reads other tables (a subquery, or a SQL function that
        // has one) is an assertion: PostgreSQL does not run such CHECKs, so
        // the export writes it as one (constraint triggers).
        constraints.push({ ...mkConstraint('formula', 0, 0), schemaId, name, rule: res.rule,
          sqlSource: { kind: 'check', table: e.name, text }, _table: t })
        note(`${ch.where}: ${text === ch.text ? what : `CHECK (${text})`} reads ${res.tables.join(', ')}, so it is read as the assertion ${name}`)
        return
      }
      // The SQL text is kept for the export, with the column of each name
      // (renamed columns are renamed in the text) and the formula as read
      // (an edited formula is no longer this CHECK).
      const sqlText = ch.domain ? text.replace(/\bvalue\b/gi, ch.column) : text
      const sqlColumns = Object.fromEntries(res.columns.map(n => [n === 'value' && ch.domain ? ch.column : n, cols.get(n).factId]))
      constraints.push({ ...mkConstraint('formula', 0, 0), schemaId, name, rule: res.rule,
        sqlCheck: { text: sqlText, columns: sqlColumns, rule: JSON.stringify(res.rule) }, _table: t })
      note(`${ch.where}: ${text === ch.text ? what : `CHECK (${text})`} is read as the formula constraint ${name}`)
    })
    // Composite keys: external uniqueness over the value roles.
    const composite = [...(pk.length > 1 ? [{ cols: pk, preferred: true }] : []),
      ...t.uniques.filter(u => u.length > 1 && !(u.length === pk.length && u.every(c => pk.includes(c)))).map(cols => ({ cols, preferred: false }))]
    for (const { cols, preferred } of composite) {
      const members = cols.map(c => factByKey.get(colKey(t, c)))
      if (members.some(m => !m)) { warn(`${e.name}: key (${cols.join(', ')}) names unknown columns and is left out`); continue }
      const sqlName = keyName(t, preferred ? 'pk' : uniqueKey(cols))
      constraints.push({ ...mkConstraint('uniqueness', 0, 0), schemaId, isPreferredIdentifier: preferred, targetObjectTypeId: e.id,
        ...(sqlName && { sqlName }),
        sequences: [members.map(f => ({ kind: 'role', factId: f.id, roleIndex: 1 }))], queries: [null], _table: t })
    }
    // Columns of a single-column primary key or unique constraint are not repeated in uniques.
    for (const u of t.uniques) if (u.some(c => !colInfo.has(colKey(t, c)))) warn(`${e.name}: UNIQUE (${u.join(', ')}) names unknown columns and is left out`)
  }
  for (const f of later) f()

  // CREATE ASSERTION: a formula constraint over the tables it reads (written
  // back as an assertion by the export).
  const tableOfName = new Map([...entityOf].map(([t, e]) => [e.name, t]))
  for (const a of parsed.assertions ?? []) {
    const res = assertionToFormula(a.text, { tables: tableFor, funcs })
    if (res.error) { warn(`Assertion ${a.name} is left out: ${res.error} is not read yet`); continue }
    constraints.push({ ...mkConstraint('formula', 0, 0), schemaId, name: a.name, rule: res.rule,
      sqlSource: { kind: 'assertion', text: a.text }, _table: tableOfName.get(res.tables[0]) ?? null })
    note(`Assertion ${a.name} is read as a formula constraint over ${res.tables.join(', ') || 'no table'}`)
  }

  // Foreign keys: subset constraints.
  for (const fk of fks) {
    const seq = (keys) => keys.map(k => ({ kind: 'role', factId: factByKey.get(k).id, roleIndex: 1 }))
    constraints.push({ ...mkConstraint('subset', 0, 0), schemaId, sequences: [seq(fk.from), seq(fk.to)], queries: [null, null], _table: fk.table, _refTable: fk.refTable,
      ...(fk.name && { sqlName: fk.name }) })
  }

  // ── Diagrams ──
  // One diagram of all tables; when the script puts its tables in two or more
  // SQL schemas (namespaces, CREATE SCHEMA), also one diagram per namespace,
  // named as the script writes it. The user may remove those.
  // A table with a one-column primary key has a reference mode. Its key column
  // is drawn as a fact type like the other columns, so the entity is marked
  // expanded and the key column's occurrences belong to it; otherwise the
  // entity would also show the "(.ref)" shorthand.
  // Formula constraints (CHECKs) stand right of their table's value types,
  // so the blocks are wider when there are any.
  const badgeW = Math.max(0, ...constraints.filter(c => c.constraintType === 'formula').map(c => 8 * (c.name.length + 2) + 12))
  const blockW = BLOCK_W + (badgeW ? badgeW + 30 : 0)
  const drawTables = (name, subset, primary) => {
    const diagram = { ...mkDiagram(name, schemaId), profileId: 'postgresql' }
    const occs = []
    const coccs = []
    const expandedRefModeOccs = []
    const perRow = Math.max(1, Math.min(5, Math.ceil(Math.sqrt(subset.length))))
    const blockPos = new Map()
    const factY = new Map()
    let y = 80, rowH = 0
    subset.forEach((t, i) => {
      const col = i % perRow
      if (col === 0 && i) { y += rowH + GAP_Y; rowH = 0 }
      const x = 120 + col * blockW
      const n = Math.max(1, t.columns.length)
      const h = (n - 1) * ROW_H
      rowH = Math.max(rowH, h + 40)
      const e = entityOf.get(t)
      const eOcc = mkOcc(e.id, x, y + h / 2)
      occs.push(eOcc)
      if (primary) { e.x = x; e.y = y + h / 2 }
      blockPos.set(t, { x, y, h })
      const rm = findRefMode(e, facts, objectTypes)
      if (rm) expandedRefModeOccs.push(eOcc.id)
      t.columns.forEach((c, j) => {
        const k = colKey(t, c.name)
        const f = factByKey.get(k)
        const vt = vtByKey.get(k)
        const fy = y + j * ROW_H
        factY.set(f.id, fy)
        const owned = rm?.factId === f.id ? { refModeOwnerOccId: eOcc.id } : {}
        const vtOcc = mkOcc(vt.id, x + 330, fy, owned)
        const fOcc = mkOcc(f.id, x + 165, fy, { roleOccurrenceMap: { 0: eOcc.id, 1: vtOcc.id }, ...owned })
        occs.push(fOcc, vtOcc)
        if (primary) {
          f.x = x + 165; f.y = fy
          if (!vt._placed) { vt.x = x + 330; vt.y = fy; vt._placed = true }
        }
      })
    })
    const formulaCount = new Map()
    for (const c of constraints) {
      const b = blockPos.get(c._table)
      // Only constraints within the diagram's tables (a foreign key to a
      // table of another namespace is left out).
      if (!b || (c._refTable && !blockPos.has(c._refTable))) continue
      let cx, cy
      if (c.constraintType === 'formula') {
        // Right of the table's value types, one under the other.
        const k = formulaCount.get(c._table) ?? 0
        formulaCount.set(c._table, k + 1)
        cx = b.x + 490 + badgeW / 2; cy = b.y + k * 32
      } else if (c.constraintType === 'uniqueness' || c.constraintType === 'valueComparison') {
        const ys = c.sequences[0].map(m => factY.get(m.factId))
        cx = b.x + (c.constraintType === 'uniqueness' ? 250 : 215); cy = ys.reduce((a, v) => a + v, 0) / ys.length
      } else {
        const fromY = factY.get(c.sequences[0][0].factId)
        const toY = factY.get(c.sequences[1][0].factId)
        const rb = blockPos.get(c._refTable)
        cx = (b.x + rb.x) / 2 + 250 + (b === rb ? 60 : 0)
        cy = (fromY + toY) / 2
      }
      cx = Math.round(cx); cy = Math.round(cy)
      if (primary) { c.x = cx; c.y = cy }
      coccs.push({ id: `cocc_${uid()}`, schemaConstraintId: c.id, x: cx, y: cy, roleOccurrenceRefs: {}, queryOccurrenceRefs: {} })
    }
    diagram.occurrences = occs
    diagram.constraintOccurrences = coccs
    diagram.expandedRefModeOccs = expandedRefModeOccs
    return diagram
  }
  const diagram = drawTables(diagramName, tables, true)
  const defaultNs = sqlserver ? 'dbo' : 'public'
  const namespaces = [...new Set(tables.map(t => t.schema ?? defaultNs))]
  const diagrams = [diagram]
  if (namespaces.length > 1) {
    for (const ns of namespaces) {
      const subset = tables.filter(t => (t.schema ?? defaultNs) === ns)
      diagrams.push(drawTables(schemaNames?.get(ns) ?? ns, subset, false))
    }
    note(`One diagram per SQL schema: ${namespaces.map(ns => schemaNames?.get(ns) ?? ns).join(', ')}`)
  }
  for (const t of tables) if (t.schema && t.schema !== 'public') entityOf.get(t).sqlSchema = schemaNames?.get(t.schema) ?? t.schema
  for (const c of constraints) { delete c._table; delete c._refTable }
  for (const vt of objectTypes) delete vt._placed

  const stats = { tables: tables.length, columns: facts.length, valueTypes: objectTypes.length - tables.length,
    keys: constraints.filter(c => c.constraintType === 'uniqueness').length + facts.filter(f => f.uniqueness.length > 1).length,
    foreignKeys: fks.length, checks: constraints.filter(c => c.constraintType === 'formula').length,
    comparisons: constraints.filter(c => c.constraintType === 'valueComparison').length }
  for (const [kind, n] of parsed.skipped) note(`Skipped ${n} × ${kind}`)
  for (const p of parsed.problems) warn(p)
  return { objectTypes, facts, constraints, diagram, diagrams, log, stats, dialect: parsed.dialect ?? 'postgresql' }
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
