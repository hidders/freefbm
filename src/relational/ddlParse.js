// A parser for the table-defining part of PostgreSQL DDL (workbench step 5).
// It reads what a schema dump or a hand-written script declares about tables:
// CREATE TABLE (columns, types, NOT NULL, PRIMARY KEY, UNIQUE, REFERENCES,
// CHECK), ALTER TABLE ... ADD [CONSTRAINT] (pg_dump style) and column changes
// (ADD/DROP/RENAME/ALTER COLUMN), CREATE TYPE ... AS
// ENUM, CREATE DOMAIN and CREATE UNIQUE INDEX on plain columns. Everything else
// (views, functions, triggers, grants...) is counted and skipped. Rows of
// INSERT INTO ... VALUES are read as sample data (step 8), with literal values
// only, as are the rows of COPY ... FROM stdin blocks (pg_dump's data
// format: text, or CSV); rows of a partition count as rows of its table.
//
// parseDdl(sql) → { tables, enums, domains, inserts, skipped, problems }
//   tables:  [{ name, qualified, columns: [{ name, type, notNull, checks: [text] }],
//               primaryKey: [col] | null, uniques: [[col]], foreignKeys: [{ columns,
//               refTable, refColumns | null, name | null }], checks: [text],
//               keyNames?: { pk | uniqueKey(cols) → constraint name } }]
//   enums:   Map(name → [label])
//   domains: Map(name → { type, notNull, checks: [text] })
//   inserts: [{ table: { name, schema }, columns: [name] | null, rows: [[value]], copy? }]
//            value: a string, null (NULL), or undefined (not a literal)
//   skipped: Map(statement kind → count)
//   problems:[text]

import { quoteIdent } from './sqlNames.js'

// ── Lexer ────────────────────────────────────────────────────────────────────
// Tokens: { t: 'id' | 'qid' | 'str' | 'num' | 'op' | 'semi', v, raw }.
// 'id' values are lower-cased (PostgreSQL folds unquoted names); 'qid' keeps
// its case. Comments, and dollar-quoted bodies of functions, are skipped over
// as strings so their semicolons don't end a statement.
export function tokenize(sql, { oracle = false, dialect = null } = {}) {
  const tsql = dialect === 'sqlserver'
  oracle ||= dialect === 'oracle'
  const pg = !oracle && !tsql
  const out = []
  let i = 0
  const n = sql.length
  while (i < n) {
    const c = sql[i]
    if (/\s/.test(c)) { i++; continue }
    if (tsql) {
      // A line holding only GO [count] ends a batch (sqlcmd, SSMS).
      if ((c === 'G' || c === 'g') && /(^|\n)[ \t]*$/.test(sql.slice(Math.max(0, i - 80), i)) && /^go[ \t]*(\d+[ \t]*)?(--[^\n]*)?(\r?\n|$)/i.test(sql.slice(i, i + 80))) {
        out.push({ t: 'slash', v: 'go', raw: 'GO' })
        while (i < n && sql[i] !== '\n') i++
        continue
      }
      // [name]: a quoted name (]] is a ]); unquoted names keep their case
      // as written (name), as SQL Server compares names without case.
      if (c === '[') {
        const start = i
        i++
        let v = ''
        while (i < n) {
          if (sql[i] === ']' && sql[i + 1] === ']') { v += ']'; i += 2; continue }
          if (sql[i] === ']') { i++; break }
          v += sql[i++]
        }
        out.push({ t: 'qid', v, raw: sql.slice(start, i) })
        continue
      }
      // N'…' (Unicode) strings are plain strings here.
      if ((c === 'N' || c === 'n') && sql[i + 1] === "'") { i++; continue }
      // 0x… binary literals, as PostgreSQL's bytea text '\x…'.
      if (c === '0' && (sql[i + 1] === 'x' || sql[i + 1] === 'X')) {
        const hex = /^0[xX]([0-9A-Fa-f]*)/.exec(sql.slice(i, i + 1e6))
        out.push({ t: 'str', v: `\\x${hex[1].toLowerCase()}`, raw: `'\\x${hex[1].toLowerCase()}'` })
        i += hex[0].length
        continue
      }
    }
    if (oracle) {
      // A line holding only / ends a PL/SQL unit (SQL*Plus).
      if (c === '/' && sql[i + 1] !== '*' && /(^|\n)[ \t]*$/.test(sql.slice(Math.max(0, i - 80), i)) && /^\/[ \t]*(\r?\n|$)/.test(sql.slice(i, i + 80))) {
        out.push({ t: 'slash', v: '/', raw: '/' }); i++; continue
      }
      // q'[…]' quoting: the text up to the closing bracket and a quote.
      const qm = /^[nN]?[qQ]'(.)/.exec(sql.slice(i, i + 4))
      if (qm) {
        const close = { '[': ']', '(': ')', '{': '}', '<': '>' }[qm[1]] ?? qm[1]
        const start = i
        const from = i + qm[0].length
        const end = sql.indexOf(`${close}'`, from)
        const stop = end < 0 ? n : end + 2
        out.push({ t: 'str', v: sql.slice(from, end < 0 ? n : end), raw: sql.slice(start, stop) })
        i = stop
        continue
      }
    }
    // psql meta-commands (\c db, \set ...) run to the end of their line.
    if (pg && c === '\\' && /(^|\n)[ \t]*$/.test(sql.slice(Math.max(0, i - 80), i))) { while (i < n && sql[i] !== '\n') i++; continue }
    if (c === '-' && sql[i + 1] === '-') { while (i < n && sql[i] !== '\n') i++; continue }
    if (c === '/' && sql[i + 1] === '*') {
      let depth = 1; i += 2
      while (i < n && depth) {
        if (sql[i] === '/' && sql[i + 1] === '*') { depth++; i += 2 }
        else if (sql[i] === '*' && sql[i + 1] === '/') { depth--; i += 2 }
        else i++
      }
      continue
    }
    if (c === "'" || (pg && (c === 'E' || c === 'e') && sql[i + 1] === "'")) {
      const start = i
      if (c !== "'") i++
      i++
      let v = ''
      while (i < n) {
        if (sql[i] === "'" && sql[i + 1] === "'") { v += "'"; i += 2; continue }
        if (sql[i] === '\\' && c !== "'") { v += sql[i + 1] ?? ''; i += 2; continue }
        if (sql[i] === "'") { i++; break }
        v += sql[i++]
      }
      out.push({ t: 'str', v, raw: sql.slice(start, i) })
      continue
    }
    if (c === '$' && pg) {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i, i + 64))
      if (m) {
        const tag = m[0]
        const end = sql.indexOf(tag, i + tag.length)
        const stop = end < 0 ? n : end + tag.length
        out.push({ t: 'str', v: sql.slice(i + tag.length, end < 0 ? n : end), raw: sql.slice(i, stop) })
        i = stop
        continue
      }
    }
    if (c === '"') {
      const start = i
      i++
      let v = ''
      while (i < n) {
        if (sql[i] === '"' && sql[i + 1] === '"') { v += '"'; i += 2; continue }
        if (sql[i] === '"') { i++; break }
        v += sql[i++]
      }
      // Oracle folds unquoted names to upper case, so "EMPLOYEES" is the
      // unquoted employees, read as PostgreSQL would read it unquoted.
      if (oracle && /^[A-Z][A-Z0-9_$#]*$/.test(v)) {
        const low = v.toLowerCase()
        const plain = quoteIdent(low) === low
        out.push(plain ? { t: 'id', v: low, raw: low } : { t: 'qid', v: low, raw: `"${low}"` })
        continue
      }
      out.push({ t: 'qid', v, raw: sql.slice(start, i) })
      continue
    }
    if (/[A-Za-z_\u0080-￿]/.test(c)) {
      const start = i
      while (i < n && (/[A-Za-z0-9_$\u0080-￿]/.test(sql[i]) || ((oracle || tsql) && (sql[i] === '#' || (tsql && sql[i] === '@'))))) i++
      const raw = sql.slice(start, i)
      out.push(tsql ? { t: 'id', v: raw.toLowerCase(), raw, name: raw } : { t: 'id', v: raw.toLowerCase(), raw })
      continue
    }
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(sql[i + 1] ?? ''))) {
      const m = /^[0-9]*\.?[0-9]+(?:[eE][+-]?[0-9]+)?/.exec(sql.slice(i))
      out.push({ t: 'num', v: m[0], raw: m[0] })
      i += m[0].length
      continue
    }
    if (c === ';') { out.push({ t: 'semi', v: ';', raw: ';' }); i++; continue }
    const two = sql.slice(i, i + 2)
    if (['<=', '>=', '<>', '!=', '::', '||'].includes(two)) { out.push({ t: 'op', v: two, raw: two }); i += 2; continue }
    out.push({ t: 'op', v: c, raw: c })
    i++
  }
  return out
}

// Splits tokens into statements at top-level semicolons. In Oracle scripts a
// PL/SQL unit (a trigger, procedure, function, package, type or anonymous
// block) holds semicolons and ends at a line holding only /.
const PLSQL_UNITS = new Set(['trigger', 'procedure', 'function', 'package', 'type'])
function plsqlUnit(cur) {
  const ws = cur.slice(0, 6).filter(t => t.t === 'id').map(t => t.v)
  if (ws[0] === 'begin' || ws[0] === 'declare') return true
  if (ws[0] !== 'create') return false
  const rest = ws.slice(1).filter(w => !['or', 'replace', 'editionable', 'noneditionable', 'force', 'nonforce'].includes(w))
  return PLSQL_UNITS.has(rest[0])
}
function statements(tokens, dialect = 'postgresql') {
  if (dialect === 'sqlserver') return tsqlStatements(tokens)
  const oracle = dialect === 'oracle' || dialect === true
  const out = []
  let cur = []
  let unit = null
  for (const tk of tokens) {
    if (tk.t === 'slash') { if (cur.length) out.push(cur); cur = []; unit = null; continue }
    if (tk.t === 'semi') {
      unit ??= oracle && plsqlUnit(cur)
      if (unit) { cur.push(tk); continue }
      if (cur.length) out.push(cur)
      cur = []; unit = null
    } else cur.push(tk)
  }
  if (cur.length) out.push(cur)
  return out
}

// T-SQL: batches end at GO; a procedure, function, trigger or view is a
// whole batch. Elsewhere a statement ends at a semicolon, which T-SQL makes
// optional, or where a word that only starts a statement follows (INSERT,
// CREATE, IF, PRINT, …), outside parentheses.
const TSQL_UNITS = new Set(['procedure', 'proc', 'function', 'trigger', 'view'])
const TSQL_STARTS = new Set(['insert', 'create', 'if', 'print', 'use', 'exec', 'execute', 'declare', 'raiserror', 'throw',
  'bulk', 'grant', 'deny', 'revoke', 'truncate', 'set', 'alter', 'drop', 'begin', 'end', 'commit', 'rollback', 'while', 'return'])
// After these words, IF (DROP TABLE IF EXISTS) and the like don't start a statement.
const TSQL_OBJECT = new Set(['table', 'view', 'index', 'procedure', 'proc', 'function', 'trigger', 'schema', 'type', 'sequence',
  'database', 'column', 'constraint', 'user', 'role', 'synonym', 'default', 'rule', 'statistics', 'login'])
function tsqlStatements(tokens) {
  const out = []
  let cur = [], unit = false, depth = 0
  const flush = () => { if (cur.length) out.push(cur); cur = []; depth = 0; unit = false }
  for (const tk of tokens) {
    if (tk.t === 'slash') { flush(); continue }
    if (unit === true) { cur.push(tk); continue }
    if (unit === null) {
      // CREATE [OR ALTER] PROCEDURE|FUNCTION|TRIGGER|VIEW: up to GO.
      const ws = [...cur, tk].filter(t => t.t === 'id').map(t => t.v).slice(1).filter(w => w !== 'or' && w !== 'alter')
      if (ws.length) unit = TSQL_UNITS.has(ws[0])
      if (unit) { cur.push(tk); continue }
    }
    if (tk.t === 'semi') { if (!depth) flush(); continue }
    if (tk.t === 'op' && tk.v === '(') depth++
    if (tk.t === 'op' && tk.v === ')') depth--
    if (!depth && cur.length && tk.t === 'id' && TSQL_STARTS.has(tk.v)) {
      const first = cur[0].t === 'id' ? cur[0].v : null
      const prev = cur[cur.length - 1]
      const pw = prev.t === 'id' ? prev.v : null
      const inside = TSQL_OBJECT.has(pw)
        // ALTER TABLE t ALTER COLUMN / DROP COLUMN …, ALTER DATABASE … SET …
        || (first === 'alter' && ['alter', 'drop', 'set'].includes(tk.v))
        // UPDATE … SET, ON DELETE|UPDATE SET NULL
        || (tk.v === 'set' && (first === 'update' || pw === 'delete' || pw === 'update'))
        // BEGIN TRAN, END TRY, BEGIN CATCH …
        || (tk.v === 'rollback' && pw === 'with') || (tk.v === 'insert' && pw === 'bulk') || (pw === 'begin' && ['tran', 'transaction', 'try', 'catch', 'distributed'].includes(tk.v))
        || (tk.v === 'end' && first === 'case')
      if (!inside) flush()
    }
    if (!cur.length && tk.t === 'id' && tk.v === 'create') unit = null
    cur.push(tk)
  }
  flush()
  return out
}

// Which SQL dialect a script is written in: 'sqlserver' when it has T-SQL's
// GO lines, [names] or types, 'oracle' when it uses Oracle's types or
// SQL*Plus's / lines, else 'postgresql'.
export function detectDialect(sql0) {
  const sql = sql0.length > 4e6 ? sql0.slice(0, 4e6) : sql0
  const code = sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, '')
  // SQL Server: GO lines, [bracketed] names, NVARCHAR(MAX), IDENTITY(1, 1).
  if (/^[ \t]*GO[ \t]*(\d+[ \t]*)?\r?$|\[\w+\]\s*\.\s*\[\w+\]|\b(N?VARCHAR|VARBINARY)\s*\(\s*MAX\s*\)|\bIDENTITY\s*\(\s*\d+\s*,|\bNVARCHAR\b|\bDATETIME2?\b|\bUNIQUEIDENTIFIER\b/im.test(code)) return 'sqlserver'
  return /\b(VARCHAR2|NVARCHAR2|NUMBER\s*\(|CLOB|NCLOB|BINARY_(FLOAT|DOUBLE))|^[ \t]*\/[ \t]*$|\bENABLE\s*[,;)]|\bLONG\s+RAW\b/im.test(sql) ? 'oracle' : 'postgresql'
}

// SQL*Plus commands (one line each, no semicolon) taken out of an Oracle script.
const SQLPLUS_LINE = /^[ \t]*(rem(ark)?\b|prompt\b|spool\b|@@?|exit\b|quit\b|whenever\b|connect\b|conn\b|host\b|pause\b|accept\b|undefine\b|clear\b|timing\b|show\b|define\s+\w+\s*=|set\s+(define|echo|feedback|serveroutput|linesize|pagesize|verify|termout|heading|timing|trimspool|trimout|sqlblanklines|long|scan|escape|autocommit|sqlprompt|newpage|wrap|tab|colsep|numwidth|arraysize|concat|markup|errorlogging)\b|col(umn)?\s+\S+\s+(format|heading|new_value|noprint|clear)\b).*$/gim

// sqlcmd commands (:setvar, :on error exit, :r file…) taken out of a T-SQL script.
const SQLCMD_LINE = /^[ \t]*:(setvar|on|r|connect|out|error|exit|quit|serverlist|listvar|reset|ed|perftrace|help|xml)\b.*$/gim

// ── Token stream helpers ─────────────────────────────────────────────────────

// A name as written: SQL Server keeps the case of unquoted names (name),
// PostgreSQL and Oracle fold them (v).
const nm = (t) => t?.name ?? t?.v

class Stream {
  constructor(tokens) { this.tk = tokens; this.i = 0 }
  peek(k = 0) { return this.tk[this.i + k] }
  next() { return this.tk[this.i++] }
  done() { return this.i >= this.tk.length }
  isWord(w, k = 0) { const t = this.peek(k); return t?.t === 'id' && t.v === w }
  isOp(o, k = 0) { const t = this.peek(k); return t?.t === 'op' && t.v === o }
  eatWord(...ws) {
    for (let k = 0; k < ws.length; k++) if (!this.isWord(ws[k], k)) return false
    this.i += ws.length
    return true
  }
  eatOp(o) { if (this.isOp(o)) { this.i++; return true } return false }
  // Tokens of a parenthesised group (without its outer parentheses).
  group() {
    if (!this.eatOp('(')) return null
    const start = this.i
    let depth = 1
    while (!this.done()) {
      const t = this.next()
      if (t.t === 'op' && t.v === '(') depth++
      else if (t.t === 'op' && t.v === ')') { depth--; if (!depth) return this.tk.slice(start, this.i - 1) }
    }
    return this.tk.slice(start)
  }
  // A possibly schema-qualified name: { name, schema }.
  qname() {
    const parts = []
    const t = this.peek()
    if (!t || (t.t !== 'id' && t.t !== 'qid')) return null
    parts.push(nm(this.next()))
    while (this.isOp('.') && (this.peek(1)?.t === 'id' || this.peek(1)?.t === 'qid')) { this.i++; parts.push(nm(this.next())) }
    // SQL Server: [db].[schema].[name]; dbo is the default schema.
    let schema = parts.length > 1 ? parts[parts.length - 2] : null
    if (mode === 'sqlserver' && schema?.toLowerCase() === 'dbo') schema = null
    return { name: parts[parts.length - 1], schema }
  }
}

// Splits a token list at top-level commas.
function splitCommas(tokens) {
  const out = []
  let cur = []
  let depth = 0
  for (const t of tokens) {
    if (t.t === 'op' && t.v === '(') depth++
    if (t.t === 'op' && t.v === ')') depth--
    if (depth === 0 && t.t === 'op' && t.v === ',') { out.push(cur); cur = [] }
    else cur.push(t)
  }
  if (cur.length) out.push(cur)
  return out
}

// Source text of tokens, with spaces between words.
export function tokensText(tokens) {
  let s = ''
  let prev = null
  for (const t of tokens) {
    const word = t.t !== 'op'
    const tight = t.t === 'op' && ['(', ')', ',', '.', '::'].includes(t.v)
    if (prev && !(tight || (prev.t === 'op' && ['(', '.', '::'].includes(prev.v))) && (word || prev.t !== 'op' || !tight)) s += ' '
    s += t.raw
    prev = t
  }
  return s
}

const nameList = (tokens) => splitCommas(tokens ?? []).map(part => {
  const t = part.find(x => x.t === 'id' || x.t === 'qid')
  return t ? nm(t) : null
}).filter(Boolean)

// Words that end a column's type.
const TYPE_STOP = new Set(['constraint', 'not', 'null', 'default', 'primary', 'unique', 'references',
  'check', 'collate', 'generated', 'identity', 'deferrable', 'initially',
  // Oracle
  'enable', 'disable', 'visible', 'invisible', 'encrypt', 'as',
  // SQL Server
  'rowguidcol', 'sparse', 'filestream', 'masked'])

// ── Statements ───────────────────────────────────────────────────────────────

let mode = 'postgresql'
export function parseDdl(sql0, { dialect = null } = {}) {
  dialect ??= detectDialect(sql0)
  const oracle = dialect === 'oracle'
  const was = mode
  mode = dialect
  try { return parseScript(sql0, dialect, oracle) } finally { mode = was }
}

function parseScript(sql0, dialect, oracle) {
  const tsql = dialect === 'sqlserver'
  const { sql: sql1, copies } = oracle || tsql ? { sql: sql0, copies: [] } : extractCopies(sql0)
  const sql = oracle ? sql1.replace(SQLPLUS_LINE, '') : tsql ? sql1.replace(SQLCMD_LINE, '') : sql1
  const tables = new Map()   // key: qualified name
  const enums = new Map()
  const domains = new Map()
  const skipped = new Map()
  const inserts = []
  const problems = []
  const assertions = []        // CREATE ASSERTION: { name, text }
  const functions = new Map()  // CREATE FUNCTION: name → { params: [name | null], body, language, returns }
  const parentOf = new Map()   // partition key → its table's qualified name
  const skip = (kind) => skipped.set(kind, (skipped.get(kind) ?? 0) + 1)
  // psql's \copy … FROM a file (AdventureWorks reads its rows from CSV files
  // next to the script): the rows are not in the script, so not read.
  for (const _ of sql.matchAll(/^[ \t]*\\copy\b[^\n]*\bfrom\s+(?!stdin\b|pstdin\b)/gim)) skip('\\copy … FROM a file (its rows are not in the script)')
  // SQL Server compares names without case.
  const ci = (x) => (tsql && x != null ? String(x).toLowerCase() : x)
  const keyOf = (q) => ci(`${q.schema ?? ''}.${q.name}`)
  const findTable = (q) => tables.get(keyOf(q)) ?? [...tables.values()].find(t => ci(t.name) === ci(q.name) && (!q.schema || ci(t.schema) === ci(q.schema)))

  let dateFormat = null   // SQL Server: SET DATEFORMAT dmy | mdy | …
  const partitions = new Set()
  const seqTriggers = []   // Oracle: [table, column] a BEFORE INSERT trigger fills from a sequence
  const handle = (tokens, defSchema) => {
    const s = new Stream(tokens)
    const qn = () => { const q = s.qname(); return q && !q.schema && defSchema ? { ...q, schema: defSchema } : q }
    try {
      // Oracle: an anonymous PL/SQL block; the INSERTs in it are read as rows.
      if (oracle && (s.isWord('begin') || s.isWord('declare'))) {
        // EXECUTE IMMEDIATE 'CREATE ASSERTION …' (as FreeFBM's Oracle export
        // writes assertions, with triggers if Oracle refuses one) is read as
        // the assertion; the triggers are not read.
        let cur = [], rows = 0
        for (const t of tokens) {
          if (t.t !== 'semi') { cur.push(t); continue }
          const k = cur.findIndex(x => x.t === 'id' && x.v === 'insert')
          const e = cur.findIndex((x, i) => x.t === 'id' && x.v === 'execute' && cur[i + 1]?.v === 'immediate' && cur[i + 2]?.t === 'str')
          if (k >= 0 && cur[k + 1]?.t === 'id' && (cur[k + 1].v === 'into' || cur[k + 1].v === 'all')) { handle(cur.slice(k), defSchema); rows++ }
          else if (e >= 0 && /^\s*create\s+assertion\b/i.test(cur[e + 2].v)) { handle(tokenize(cur[e + 2].v, { oracle }), defSchema); rows++ }
          cur = []
        }
        if (!rows) skip('PL/SQL block')
        return
      }
      if (s.eatWord('create')) {
        s.eatWord('or', 'replace')
        if (tsql) s.eatWord('or', 'alter')
        if (oracle) { s.eatWord('editionable'); s.eatWord('noneditionable'); s.eatWord('no', 'force'); s.eatWord('force'); s.eatWord('private') }
        s.eatWord('global'); s.eatWord('local')
        s.eatWord('temporary'); s.eatWord('temp'); s.eatWord('unlogged')
        if (s.eatWord('table')) { parseCreateTable(s, tables, keyOf, problems, skip, defSchema, parentOf); return }
        if (s.eatWord('schema')) {
          // CREATE SCHEMA name [AUTHORIZATION role] [schema elements...]
          s.eatWord('if', 'not', 'exists')
          const q = s.qname()
          if (s.eatWord('authorization')) s.next()
          const rest = s.tk.slice(s.i)
          if (!rest.length) { skip('CREATE SCHEMA'); return }
          // The elements are statements without semicolons, each starting with CREATE or GRANT.
          let cur = []
          let depth = 0
          const flush = () => { if (cur.length) handle(cur, q?.name ?? defSchema); cur = [] }
          for (const t of rest) {
            if (t.t === 'op' && t.v === '(') depth++
            if (t.t === 'op' && t.v === ')') depth--
            if (depth === 0 && t.t === 'id' && (t.v === 'create' || t.v === 'grant') && cur.length) flush()
            cur.push(t)
          }
          flush()
          return
        }
        if (s.eatWord('type')) {
          const q = s.qname()
          // SQL Server: CREATE TYPE name FROM base [NOT NULL] (an alias type)
          // is a domain.
          if (tsql && q && s.eatWord('from')) {
            const d = { type: readType(s), notNull: false, checks: [] }
            readColumnConstraints(s, d, null, problems)
            domains.set(q.name.toLowerCase(), d)
            return
          }
          if (q && s.eatWord('as', 'enum')) {
            enums.set(q.name, splitCommas(s.group() ?? []).map(p => p.find(t => t.t === 'str')?.v).filter(v => v != null))
          } else skip('CREATE TYPE (not an enum)')
          return
        }
        if (s.eatWord('domain')) {
          const q = s.qname()
          s.eatWord('as')
          const type = readType(s)
          const d = { type, notNull: false, checks: [] }
          readColumnConstraints(s, d, null, problems)
          if (q) domains.set(q.name, d)
          return
        }
        if (s.isWord('unique') && (s.isWord('index', 1) || ((s.isWord('clustered', 1) || s.isWord('nonclustered', 1)) && s.isWord('index', 2)))) {
          s.i += s.isWord('index', 1) ? 2 : 3
          s.eatWord('concurrently'); s.eatWord('if', 'not', 'exists')
          const indexName = !s.isWord('on') ? s.qname()?.name ?? null : null
          s.eatWord('on'); s.eatWord('only')
          const q = qn()
          if (s.eatWord('using')) s.next()
          const g = s.group()
          const cols = g && splitCommas(g).every(p => p.length === 1 && (p[0].t === 'id' || p[0].t === 'qid')) ? nameList(g) : null
          let rest = s.tk.slice(s.i)
          const t = q && findTable(q)
          // WHERE c IS NOT NULL AND … over key columns only leaves out the
          // rows that standard SQL's UNIQUE does not compare: the same key
          // (FreeFBM's SQL Server export writes UNIQUE so).
          const w = rest.findIndex(x => x.t === 'id' && x.v === 'where')
          if (w >= 0 && cols) {
            const conds = []
            let cur = []
            for (const x of rest.slice(w + 1)) {
              if (x.t === 'id' && x.v === 'and') { conds.push(cur); cur = [] }
              else if (!(x.t === 'op' && (x.v === '(' || x.v === ')'))) cur.push(x)
            }
            conds.push(cur)
            const inKey = (x) => (x.t === 'id' || x.t === 'qid') && cols.some(n => n.toLowerCase() === String(nm(x)).toLowerCase())
            const ok = conds.every(c => c.length === 4 && inKey(c[0]) && c[1].v === 'is' && c[2].v === 'not' && c[3].v === 'null')
            if (ok) rest = rest.slice(0, w)
          }
          if (t && cols && !rest.some(x => x.t === 'id' && x.v === 'where')) { t.uniques.push(cols); nameKey(t, uniqueKey(cols), indexName) }
          else skip('CREATE UNIQUE INDEX on expressions or with WHERE')
          return
        }
        // Oracle: a BEFORE INSERT trigger that fills a column from a sequence
        // (:NEW.col := seq.NEXTVAL, or SELECT seq.NEXTVAL INTO :NEW.col) makes
        // the column a surrogate, as an identity column would.
        if (oracle && s.eatWord('trigger')) {
          const tq = s.qname()
          const rest = s.tk.slice(s.i)
          const at = rest.findIndex(t => t.t === 'id' && t.v === 'on')
          const ws = rest.slice(0, at).filter(t => t.t === 'id').map(t => t.v)
          const ts = new Stream(rest.slice(at + 1))
          const q = ts.qname()
          // A statement trigger that raises an error when a violation query
          // has rows (SELECT COUNT(*) INTO v FROM dual WHERE EXISTS (query), as
          // FreeFBM's Oracle export writes constraints Oracle can't assert):
          // read as the assertion NOT EXISTS (query), once for all its tables.
          const ex = rest.findIndex((t, i) => t.t === 'id' && t.v === 'dual' && rest[i + 1]?.v === 'where' && rest[i + 2]?.v === 'exists' && rest[i + 3]?.v === '(')
          if (tq && q && ex >= 0 && rest.some(t => t.t === 'id' && t.v === 'raise_application_error') && !ws.includes('each')) {
            const g = new Stream(rest.slice(ex + 3)).group()
            const name = tq.name.endsWith(`_on_${q.name}`) ? tq.name.slice(0, -(q.name.length + 4)) : tq.name
            const text = `NOT EXISTS (${conditionText(g)})`
            if (!assertions.some(a => a.name === name || a.text === text)) assertions.push({ name, text })
            skip('CREATE TRIGGER (read as the assertion it checks)')
            return
          }
          const nv = rest.findIndex(t => t.t === 'id' && t.v === 'nextval')
          if (q && ws.includes('before') && ws.includes('insert') && nv >= 0) {
            // The :NEW.col nearest to NEXTVAL.
            let best = null
            rest.forEach((t, i) => {
              if (t.t === 'op' && t.v === ':' && rest[i + 1]?.v === 'new' && rest[i + 2]?.v === '.' && rest[i + 3]) {
                const d = Math.abs(i - nv)
                if (!best || d < best.d) best = { d, col: rest[i + 3].v }
              }
            })
            if (best) seqTriggers.push([q, best.col])
          }
          skip('CREATE TRIGGER')
          return
        }
        // SQL Server: a trigger that throws when a violation query has rows
        // (IF EXISTS (query) THROW …, as FreeFBM's SQL Server export writes
        // assertions) is read as the assertion NOT EXISTS (query).
        if (tsql && s.eatWord('trigger')) {
          const tq = s.qname()
          s.eatWord('on')
          const q = s.qname()
          const rest = s.tk.slice(s.i)
          const ex = rest.findIndex((t, i) => t.t === 'id' && t.v === 'if' && rest[i + 1]?.v === 'exists' && rest[i + 2]?.v === '(')
          if (tq && q && ex >= 0 && rest.some(t => t.t === 'id' && (t.v === 'throw' || t.v === 'raiserror'))) {
            const g = new Stream(rest.slice(ex + 2)).group()
            const name = tq.name.endsWith(`_on_${q.name}`) ? tq.name.slice(0, -(q.name.length + 4)) : tq.name
            const text = `NOT EXISTS (${conditionText(g)})`
            if (!assertions.some(a => a.name === name || a.text === text)) assertions.push({ name, text })
            skip('CREATE TRIGGER (read as the assertion it checks)')
            return
          }
          skip('CREATE TRIGGER')
          return
        }
        // CREATE ASSERTION name CHECK (condition) [DEFERRABLE …] (SQL standard).
        if (s.eatWord('assertion')) {
          const q = s.qname()
          if (!s.eatWord('check')) { problems.push(`CREATE ASSERTION ${q?.name ?? ''}: CHECK expected`); return }
          const g = s.group()
          if (q && g) assertions.push({ name: q.name, text: conditionText(g) })
          return
        }
        // CREATE FUNCTION: kept so a CHECK that calls a SQL function can be
        // read through its body.
        if (s.eatWord('function')) {
          const q = s.qname()
          const g = s.group() ?? []
          const params = splitCommas(g).map(p => {
            const ws = p.filter(t => !(t.t === 'id' && ['in', 'out', 'inout', 'variadic'].includes(t.v) && p.length > 2))
            const di = ws.findIndex(t => (t.t === 'id' && t.v === 'default') || (t.t === 'op' && t.v === '='))
            const head = di >= 0 ? ws.slice(0, di) : ws
            return head.length >= 2 && (head[0].t === 'id' || head[0].t === 'qid') ? head[0].v : null
          })
          let language = null, body = null, returns = null
          while (!s.done()) {
            if (s.eatWord('returns')) { returns = s.next()?.v ?? null; continue }
            if (s.eatWord('language')) { language = s.next()?.v?.toLowerCase() ?? null; continue }
            if (s.eatWord('as')) { const t = s.next(); if (t?.t === 'str') body = t.v; continue }
            if (s.eatWord('return')) { body = `RETURN ${tokensText(s.tk.slice(s.i))}`; language ??= 'sql'; break }
            s.next()
          }
          if (q) functions.set(q.name, { params, body, language: language ?? 'sql', returns })
          skip('CREATE FUNCTION (read only where a CHECK calls it)')
          return
        }
        const kind = tokens.slice(1, 4).filter(t => t.t === 'id').map(t => t.v)
          .find(w => ['view', 'function', 'procedure', 'trigger', 'index', 'sequence', 'schema', 'extension',
            'materialized', 'aggregate', 'rule', 'policy', 'publication', 'operator', 'cast', 'language'].includes(w))
        skip(`CREATE ${(kind ?? tokens[1]?.v ?? '').toUpperCase()}`)
        return
      }
      // Oracle: INSERT ALL INTO t [(cols)] VALUES (…) … SELECT … FROM dual.
      if (oracle && s.eatWord('insert', 'all')) {
        while (s.eatWord('into')) {
          const q = qn()
          const columns = s.isOp('(') ? nameList(s.group()) : null
          if (!q || !s.eatWord('values')) { skip('INSERT ALL … (not VALUES)'); return }
          const g = s.group()
          if (g) inserts.push({ table: q, columns, rows: [splitCommas(g).map(literalValue)] })
        }
        return
      }
      if (s.eatWord('insert', 'into') || (tsql && s.isWord('insert') && (s.peek(1)?.t === 'qid' || (s.peek(1)?.t === 'id' && !['all', 'overwrite'].includes(s.peek(1).v))) && s.eatWord('insert'))) {
        const q = qn()
        let columns = null
        if (s.isOp('(')) columns = nameList(s.group())
        if (s.eatWord('overriding')) { s.next(); s.next() }
        if (!q || !s.eatWord('values')) { skip('INSERT INTO ... (not VALUES)'); return }
        const rows = []
        for (;;) {
          const g = s.group()
          if (!g) break
          rows.push(splitCommas(g).map(literalValue))
          if (!s.eatOp(',')) break
        }
        inserts.push({ table: q, columns, rows })
        return
      }
      if (s.eatWord('alter', 'table')) {
        s.eatWord('if', 'exists'); s.eatWord('only')
        const q = qn()
        const t = q && findTable(q)
        if (s.isWord('attach') && s.isWord('partition', 1)) {
          s.i += 2
          const child = qn()
          if (child) { partitions.add(keyOf(child)); if (q) parentOf.set(keyOf(child), q) }
          return
        }
        // SQL Server: WITH CHECK | NOCHECK ADD …, and one ADD for a list.
        if (tsql) { s.eatWord('with', 'check'); s.eatWord('with', 'nocheck') }
        const actions = splitCommas(s.tk.slice(s.i))
        let used = false
        let lastVerb = null
        for (const a0 of actions) {
          let a = a0
          if (tsql) {
            const w = a[0]?.t === 'id' ? a[0].v : null
            if (['add', 'drop', 'alter'].includes(w)) lastVerb = a[0]
            else if (lastVerb && !['check', 'nocheck', 'enable', 'disable', 'set', 'switch', 'rebuild', 'with'].includes(w)) a = [lastVerb, ...a]
          }
          const as = new Stream(a)
          if (!t) {
            // Sequences, views and the like are altered too; only adding to a missing table is a problem.
            if (as.isWord('add') && !as.isWord('column', 1)) problems.push(`ALTER TABLE ${q?.name}: the table was not created in this script`)
            continue
          }
          if (oracle && as.isWord('add') && as.isOp('(', 1)) {
            as.next()
            for (const item of splitCommas(as.group())) {
              const is = new Stream(item)
              if (['constraint', 'primary', 'unique', 'foreign', 'check'].some(w => is.isWord(w))) { if (readTableConstraint(is, t, problems)) used = true }
              else if (alterColumn(new Stream([{ t: 'id', v: 'add', raw: 'ADD' }, ...item]), t, problems)) used = true
            }
            continue
          }
          if (oracle && as.eatWord('modify')) {
            if (as.isWord('constraint') || as.isWord('primary') || as.isWord('unique')) continue
            const items = as.isOp('(') ? splitCommas(as.group()) : [as.tk.slice(as.i)]
            for (const item of items) if (modifyColumn(new Stream(item), t, problems)) used = true
            continue
          }
          // SQL Server: ALTER COLUMN c type [NULL | NOT NULL].
          if (tsql && as.isWord('alter') && as.isWord('column', 1)) {
            as.i += 2
            const k = as.next()
            const col = k && t.columns.find(c => c.name.toLowerCase() === String(nm(k)).toLowerCase())
            if (!col) { problems.push(`${t.name}: ALTER COLUMN of an unknown column`); continue }
            const type = readType(as)
            if (type.name) col.type = type
            col.notNull = as.isWord('not') && as.isWord('null', 1)
            used = true
            continue
          }
          if (alterColumn(as, t, problems)) { used = true; continue }
          if (!as.eatWord('add')) continue
          if (readTableConstraint(as, t, problems)) used = true
        }
        if (!used) skip('ALTER TABLE (other than adding a constraint or changing columns)')
        return
      }
      if (tsql && s.isWord('bulk') && s.isWord('insert', 1)) { skip('BULK INSERT … FROM a file (its rows are not in the script)'); return }
      if (tsql && s.eatWord('set', 'dateformat')) { dateFormat = s.next()?.v?.toLowerCase() ?? null; return }
      const head = tokens.slice(0, 2).filter(t => t.t === 'id').map(t => t.v.toUpperCase()).join(' ')
      skip(head || 'statement')
    } catch (err) {
      problems.push(`Could not read: ${tokensText(tokens).slice(0, 120)}… (${err.message})`)
    }
  }
  for (const tokens of statements(tokenize(sql, { dialect }), dialect)) handle(tokens, null)
  if (oracle) {
    // A unique index behind a primary key or UNIQUE constraint (as Oracle's
    // DBMS_METADATA writes them) is the same key.
    const same = (a, b) => a.length === b.length && a.every((c, i) => c === b[i])
    // Tables Oracle makes for its own use (ORA$… behind assertions, BIN$…
    // in the recycle bin) are not the schema's.
    for (const [k, t] of tables) if (/^(ora\$|bin\$)/i.test(t.name)) { tables.delete(k); skip('Oracle system table (ORA$…, BIN$…)') }
    for (const t of tables.values()) {
      // A foreign key written both in CREATE TABLE and as a separate ALTER
      // TABLE (DBMS_METADATA's REF_CONSTRAINT) is one foreign key.
      const fkKey = (fk) => `${fk.columns}|${fk.refSchema ?? ''}.${fk.refTable}|${fk.refColumns ?? ''}`
      t.foreignKeys = t.foreignKeys.filter((fk, i) => t.foreignKeys.findIndex(g => fkKey(g) === fkKey(fk)) === i)
      t.uniques = t.uniques.filter((u, i) => !(t.primaryKey && same(u, t.primaryKey)) && t.uniques.findIndex(v => same(u, v)) === i)
      for (const [tk, col] of seqTriggers) {
        if (tk.name !== t.name || (tk.schema && t.schema && tk.schema !== t.schema)) continue
        const c = t.columns.find(x => x.name === col)
        if (c && !c.identity) c.defaultGenerated = 'sequence'
      }
    }
  }
  if (tsql) caseFold([...tables.values()], inserts, domains)
  // Partitions of a partitioned table hold its rows; they are not tables of their own.
  for (const k of partitions) if (tables.delete(k)) skip('partition (ALTER TABLE ... ATTACH PARTITION)')
  for (const c of copies) {
    if (c.problem) { problems.push(c.problem); continue }
    inserts.push({ table: c.table, columns: c.columns, rows: c.rows, copy: true })
  }
  // Rows of a partition are rows of its table.
  for (const ins of inserts) {
    let q = ins.table
    for (let k = 0; k < 4 && (parentOf.has(keyOf(q)) || (!q.schema && [...parentOf.keys()].some(x => x.endsWith(`.${q.name}`)))); k++)
      q = parentOf.get(keyOf(q)) ?? parentOf.get([...parentOf.keys()].find(x => x.endsWith(`.${q.name}`)))
    ins.table = q
  }
  return { tables: [...tables.values()], enums, domains, inserts, skipped, problems, assertions, functions, dialect, dateFormat }
}

// SQL Server compares names without case: every reference to a table or a
// column is written as the table or column was declared (keys, foreign keys,
// rows, the names in CHECKs), and types and domains are lower case.
function caseFold(tables, inserts, domains) {
  const low = (x) => String(x).toLowerCase()
  const tableOf = (name, schema) => tables.find(t => low(t.name) === low(name) && (!schema || low(t.schema ?? '') === low(schema)))
    ?? tables.find(t => low(t.name) === low(name))
  const colsOf = (t) => new Map(t.columns.map(c => [low(c.name), c.name]))
  const fix = (t, cols) => cols?.map(c => colsOf(t).get(low(c)) ?? c) ?? cols
  for (const [k, d] of [...domains]) { domains.delete(k); domains.set(low(k), d); if (d.type?.name) d.type.name = low(d.type.name) }
  for (const t of tables) {
    for (const c of t.columns) if (c.type?.name) c.type.name = low(c.type.name)
    t.primaryKey = fix(t, t.primaryKey)
    if (t.keyNames) t.keyNames = Object.fromEntries(Object.entries(t.keyNames).map(([k, n]) =>
      [k === 'pk' ? k : uniqueKey(fix(t, k.slice(2).split('\u0000'))), n]))
    t.uniques = t.uniques.map(u => fix(t, u))
    for (const fk of t.foreignKeys) {
      fk.columns = fix(t, fk.columns)
      const rt = tableOf(fk.refTable, fk.refSchema)
      if (rt) { fk.refTable = rt.name; fk.refSchema = rt.schema; fk.refColumns = fix(rt, fk.refColumns) }
    }
    const names = colsOf(t)
    const text = (x) => tokensText(tokenize(x).map(k => {
      const n = (k.t === 'id' || k.t === 'qid') && names.get(low(k.v))
      return n && n !== k.v ? { t: 'qid', v: n, raw: quoteIdent(n) } : k
    }))
    t.checks = t.checks.map(text)
    for (const c of t.columns) c.checks = c.checks.map(text)
  }
  for (const ins of inserts) {
    const t = tableOf(ins.table.name, ins.table.schema)
    if (!t) continue
    ins.table = { name: t.name, schema: t.schema }
    ins.columns = fix(t, ins.columns)
  }
}

// The value of a literal in a VALUES list: a string, null for NULL, or
// undefined for anything else (an expression or a function call). Casts
// (::type) are dropped.
function literalValue(tokens) {
  let tks = tokens
  if (mode === 'oracle') {
    // DATE '…', TIMESTAMP '…', TO_DATE('…', 'format'), TO_TIMESTAMP(…).
    if (tks.length === 2 && tks[0].t === 'id' && (tks[0].v === 'date' || tks[0].v === 'timestamp') && tks[1].t === 'str') return tks[1].v
    if (tks[0]?.t === 'id' && /^to_(date|timestamp)$/.test(tks[0].v) && tks[1]?.t === 'op' && tks[1].v === '(' && tks[tks.length - 1]?.v === ')') {
      const args = splitCommas(tks.slice(2, -1))
      if (args[0]?.length === 1 && args[0][0].t === 'str' && (!args[1] || (args[1].length === 1 && args[1][0].t === 'str')))
        return oracleDate(args[0][0].v, args[1]?.[0].v ?? (tks[0].v === 'to_date' ? 'DD-MON-RR' : 'DD-MON-RR HH.MI.SSXFF AM')) ?? undefined
      return undefined
    }
  }
  const cast = tks.findIndex(t => t.t === 'op' && t.v === '::')
  if (cast > 0) tks = tks.slice(0, cast)
  // E'...', B'...' and the like: the prefix is a word before the string.
  if (tks.length === 2 && tks[0].t === 'id' && tks[1].t === 'str' && /^[ebxun&]$/.test(tks[0].v)) tks = [tks[1]]
  if (tks.length === 1) {
    const t = tks[0]
    if (t.t === 'str' || t.t === 'num') return t.v
    if (t.t === 'id' && t.v === 'null') return null
    if (t.t === 'id' && (t.v === 'true' || t.v === 'false')) return t.v
  }
  if (tks.length === 2 && tks[0].t === 'op' && (tks[0].v === '-' || tks[0].v === '+') && tks[1].t === 'num')
    return tks[0].v === '-' ? `-${tks[1].v}` : tks[1].v
  return undefined
}

function parseCreateTable(s, tables, keyOf, problems, skip, defSchema, parentOf) {
  s.eatWord('if', 'not', 'exists')
  let q = s.qname()
  if (q && !q.schema && defSchema) q = { ...q, schema: defSchema }
  if (!q) throw new Error('no table name')
  if (s.isWord('partition') && s.isWord('of', 1)) {
    s.i += 2
    let parent = s.qname()
    if (parent && !parent.schema && defSchema) parent = { ...parent, schema: defSchema }
    if (parent) parentOf.set(keyOf(q), parent)
    skip('CREATE TABLE ... PARTITION OF')
    return
  }
  if (s.isWord('of')) { skip('CREATE TABLE ... OF type'); return }
  const body = s.group()
  if (!body) { skip('CREATE TABLE AS'); return }
  const t = { name: q.name, schema: q.schema, columns: [], primaryKey: null, uniques: [], foreignKeys: [], checks: [] }
  for (const item of splitCommas(body)) {
    const is = new Stream(item)
    // A table constraint, unless the word is a column's name (primary BOOLEAN).
    if (is.isWord('constraint') || (is.isWord('primary') && is.isWord('key', 1)) || (is.isWord('unique') && (is.isOp('(', 1) || is.isWord('nulls', 1)))
        || (is.isWord('foreign') && is.isWord('key', 1)) || (is.isWord('check') && is.isOp('(', 1)) || (is.isWord('exclude') && (is.isWord('using', 1) || is.isOp('(', 1)))) {
      readTableConstraint(is, t, problems)
      continue
    }
    if (is.isWord('like')) { problems.push(`${t.name}: LIKE in CREATE TABLE is not read`); continue }
    const nameTk = is.next()
    if (!nameTk || (nameTk.t !== 'id' && nameTk.t !== 'qid')) continue
    // SQL Server: name AS expression (a computed column) has no type of its own.
    if (mode === 'sqlserver' && is.isWord('as')) { (t.computed ??= []).push(nm(nameTk)); continue }
    const col = { name: nm(nameTk), type: readType(is), notNull: false, checks: [] }
    readColumnConstraints(is, col, t, problems)
    t.columns.push(col)
  }
  if (tables.has(keyOf(q))) problems.push(`Table ${q.name} is created twice; the last one is kept`)
  tables.set(keyOf(q), t)
}

// A column type up to its first constraint word: { name, args, array }.
// name is lower case with the words joined by spaces ("double precision",
// "timestamp with time zone"); args are the numbers in its parentheses.
function readType(s) {
  const words = []
  let args = []
  let schemaQualified = false
  while (!s.done()) {
    const t = s.peek()
    if (t.t === 'id' || t.t === 'qid') {
      if (t.t === 'id' && TYPE_STOP.has(t.v)) break
      s.next()
      if (s.isOp('.')) { s.next(); schemaQualified = true; continue }
      words.push(t.v)
      continue
    }
    if (t.t === 'op' && t.v === '(') {
      const g = s.group()
      args = splitCommas(g).map(p => tokensText(p))
      continue
    }
    if (t.t === 'op' && t.v === '[') {
      while (!s.done() && !s.isOp(']')) s.next()
      s.next()
      return { name: words.join(' '), args, array: true, schemaQualified }
    }
    break
  }
  return { name: words.join(' '), args, array: false, schemaQualified }
}

// The names a script gives keys (CONSTRAINT name, or a unique index's name),
// kept in t.keyNames: 'pk' for the primary key, uniqueKey(cols) for a UNIQUE.
export const uniqueKey = (cols) => `u:${cols.join('\u0000')}`
function nameKey(t, key, name) {
  if (name) (t.keyNames ??= {})[key] = name
}

// Column constraints after the type, into col (and, for REFERENCES, the table).
function readColumnConstraints(s, col, table, problems) {
  while (!s.done()) {
    if (s.eatWord('constraint')) { col._cname = nm(s.next()) ?? null; continue }
    if (s.eatWord('not', 'null')) { col.notNull = true; continue }
    if (s.eatWord('null')) continue
    if (s.eatWord('default')) {
      // A default from a sequence or a UUID generator makes a surrogate.
      const start = s.i
      skipExpression(s)
      const words = s.tk.slice(start, s.i).filter(t => t.t === 'id').map(t => t.v)
      if (words.includes('nextval') || (words.includes('next') && words.includes('value') && words.includes('for'))) col.defaultGenerated = 'sequence'
      else if (words.some(w => /^(gen_random_uuid|uuid_generate\w*|uuidv\d|newid|newsequentialid)$/.test(w))) col.defaultGenerated = 'uuid'
      continue
    }
    if (s.eatWord('collate')) { s.qname(); continue }
    // SQL Server: IDENTITY [(seed, increment)].
    if (mode === 'sqlserver' && s.eatWord('identity')) { if (s.isOp('(')) s.group(); col.identity = true; continue }
    if (s.eatWord('generated')) {
      // GENERATED ALWAYS|BY DEFAULT AS IDENTITY [(...)] | AS (expr) STORED
      while (!s.done() && !s.isWord('as')) s.next()
      s.eatWord('as')
      if (s.eatWord('identity')) { if (s.isOp('(')) s.group(); col.identity = true }
      else { s.group(); s.eatWord('stored'); col.generated = true }
      continue
    }
    if (s.eatWord('primary', 'key')) {
      if (table) { table.primaryKey = [col.name]; nameKey(table, 'pk', col._cname) }
      col.notNull = true; col._cname = null
      continue
    }
    if (s.eatWord('unique')) {
      s.eatWord('nulls', 'not', 'distinct')
      if (table) { table.uniques.push([col.name]); nameKey(table, uniqueKey([col.name]), col._cname) }
      col._cname = null
      continue
    }
    if (s.eatWord('check')) {
      col.checks.push(conditionText(s.group() ?? []))
      ;(col.checkNames ??= [])[col.checks.length - 1] = col._cname ?? null
      s.eatWord('no', 'inherit')
      continue
    }
    if (s.eatWord('references')) {
      const q = s.qname()
      const g = s.isOp('(') ? nameList(s.group()) : null
      skipReferentialActions(s)
      if (table && q) table.foreignKeys.push({ columns: [col.name], refTable: q.name, refSchema: q.schema, refColumns: g, name: col._cname ?? null })
      col._cname = null
      continue
    }
    if (s.eatWord('deferrable') || s.eatWord('not', 'deferrable') || s.eatWord('initially', 'deferred') || s.eatWord('initially', 'immediate')) continue
    // Oracle: USING INDEX (CREATE …) | name | storage, ENABLE, NOVALIDATE…
    if (s.eatWord('using', 'index')) { if (s.isOp('(')) s.group(); continue }
    s.next()
  }
}

// ALTER TABLE actions on columns: ADD [COLUMN], DROP COLUMN, RENAME [COLUMN]
// a TO b, ALTER [COLUMN] c SET|DROP NOT NULL, [SET DATA] TYPE, SET|DROP
// DEFAULT. Scripts such as AdventureWorks reshape tables after CREATE TABLE.
// Returns false for anything else (ADD of a table constraint among them).
function alterColumn(s, t, problems) {
  const colName = () => { const k = s.next(); return k && (k.t === 'id' || k.t === 'qid') ? nm(k) : null }
  const find = (n) => t.columns.find(c => c.name === n)
  const start = s.i
  if (s.eatWord('add')) {
    const explicit = s.eatWord('column')
    if (!explicit && ['constraint', 'primary', 'unique', 'foreign', 'check', 'exclude'].some(w => s.isWord(w))) { s.i = start; return false }
    s.eatWord('if', 'not', 'exists')
    const name = colName()
    if (!name) { s.i = start; return false }
    const col = { name, type: readType(s), notNull: false, checks: [] }
    readColumnConstraints(s, col, t, problems)
    if (find(name)) t.columns = t.columns.filter(c => c.name !== name)
    t.columns.push(col)
    return true
  }
  if (s.eatWord('drop')) {
    if (!s.eatWord('column')) { s.i = start; return false }
    s.eatWord('if', 'exists')
    const name = colName()
    if (!name) return true
    // CASCADE or not, constraints on the column go with it.
    t.columns = t.columns.filter(c => c.name !== name)
    if (t.primaryKey?.includes(name)) t.primaryKey = null
    t.uniques = t.uniques.filter(u => !u.includes(name))
    t.foreignKeys = t.foreignKeys.filter(fk => !fk.columns.includes(name))
    return true
  }
  if (s.eatWord('rename')) {
    if (s.isWord('to') || s.isWord('constraint')) { s.i = start; return false }
    s.eatWord('column')
    const from = colName()
    if (!s.eatWord('to')) { s.i = start; return false }
    const to = colName()
    const col = from && to && find(from)
    if (!col) { problems.push(`${t.name}: RENAME COLUMN of an unknown column ${from}`); return true }
    col.name = to
    const ren = (cols) => cols?.map(c => (c === from ? to : c)) ?? cols
    t.primaryKey = ren(t.primaryKey)
    if (t.keyNames) t.keyNames = Object.fromEntries(Object.entries(t.keyNames).map(([k, n]) =>
      [k === 'pk' ? k : uniqueKey(ren(k.slice(2).split('\u0000'))), n]))
    t.uniques = t.uniques.map(ren)
    for (const fk of t.foreignKeys) fk.columns = ren(fk.columns)
    return true
  }
  if (s.eatWord('alter')) {
    s.eatWord('column')
    const col = find(colName())
    if (!col) { problems.push(`${t.name}: ALTER COLUMN of an unknown column`); return true }
    if (s.eatWord('set', 'not', 'null')) col.notNull = true
    else if (s.eatWord('drop', 'not', 'null')) col.notNull = false
    else if (s.eatWord('set', 'data', 'type') || s.eatWord('type')) col.type = readType(s)
    else if (s.eatWord('drop', 'default')) { delete col.defaultGenerated }
    else if (s.isWord('set') && s.isWord('default', 1)) { s.i++; readColumnConstraints(s, col, null, problems) }
    else if (s.isWord('add') && s.isWord('generated', 1)) { s.i++; readColumnConstraints(s, col, null, problems) }
    return true
  }
  return false
}

function readTableConstraint(s, t, problems) {
  let cname = null
  if (s.eatWord('constraint')) cname = nm(s.next()) ?? null
  if (s.eatWord('primary', 'key')) {
    s.eatWord('clustered'); s.eatWord('nonclustered')
    t.primaryKey = nameList(s.group())
    nameKey(t, 'pk', cname)
    return true
  }
  if (s.eatWord('unique')) {
    s.eatWord('nulls', 'not', 'distinct')
    s.eatWord('clustered'); s.eatWord('nonclustered')
    const cols = nameList(s.group())
    if (cols.length) { t.uniques.push(cols); nameKey(t, uniqueKey(cols), cname) }
    return true
  }
  if (s.eatWord('foreign', 'key')) {
    const cols = nameList(s.group())
    s.eatWord('references')
    const q = s.qname()
    const ref = s.isOp('(') ? nameList(s.group()) : null
    skipReferentialActions(s)
    if (q) t.foreignKeys.push({ columns: cols, refTable: q.name, refSchema: q.schema, refColumns: ref, name: cname })
    return true
  }
  if (s.eatWord('check')) {
    t.checks.push(conditionText(s.group() ?? []))
    ;(t.checkNames ??= [])[t.checks.length - 1] = cname
    return true
  }
  if (s.eatWord('exclude')) {
    problems.push(`${t.name}: EXCLUDE constraint ${cname ?? ''} is not read`)
    return true
  }
  return false
}

function skipReferentialActions(s) {
  while (!s.done()) {
    if (s.eatWord('match')) { s.next(); continue }
    if (s.eatWord('on', 'delete') || s.eatWord('on', 'update')) {
      if (!s.eatWord('no', 'action') && !s.eatWord('set', 'null') && !s.eatWord('set', 'default')) s.next()
      if (s.isOp('(')) s.group()
      continue
    }
    if (s.eatWord('deferrable') || s.eatWord('not', 'deferrable') || s.eatWord('initially', 'deferred') || s.eatWord('initially', 'immediate')) continue
    break
  }
}

// Skips a DEFAULT expression: up to the next constraint word at depth 0.
function skipExpression(s) {
  while (!s.done()) {
    const t = s.peek()
    if (t.t === 'id' && ['constraint', 'not', 'null', 'primary', 'unique', 'references', 'check', 'collate', 'generated'].includes(t.v)) {
      // 'not null' / 'null' could be part of the expression only in odd cases
      return
    }
    if (t.t === 'op' && t.v === '(') { s.group(); continue }
    s.next()
  }
}

// ── COPY ... FROM stdin ──────────────────────────────────────────────────────

// The COPY ... FROM stdin statements of a script and their data lines (up to
// a line \.), taken out of the script so the tokenizer never sees the data:
// { sql, copies: [{ table, columns, rows } | { problem }] }. Text format
// (tab-separated, \N for NULL, backslash escapes) and CSV (quotes, an empty
// unquoted field for NULL, HEADER skipped) are read.
export function extractCopies(sql) {
  if (!/\bcopy\b/i.test(sql)) return { sql, copies: [] }
  const copies = []
  const out = []
  const lines = sql.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    // A COPY statement that ends on this line and reads from stdin.
    if (!/^\s*copy\s/i.test(line) || !/\bfrom\s+stdin\b[^;]*;\s*$/i.test(line)) { out.push(line); continue }
    out.push('')
    const head = tokenize(line.replace(/;\s*$/, ''))
    const s = new Stream(head)
    s.eatWord('copy')
    const table = s.qname()
    let columns = null
    if (s.isOp('(')) columns = nameList(s.group())
    s.eatWord('from'); s.eatWord('stdin')
    // Options: WITH (FORMAT csv, HEADER, DELIMITER ',', NULL '') or the old CSV HEADER DELIMITER AS ',' form.
    const opt = { csv: false, header: false, delim: null, nul: null }
    const words = s.tk.slice(s.i)
    for (let k = 0; k < words.length; k++) {
      const w = words[k]
      const v = w.t === 'id' ? w.v : null
      const nextVal = () => { let j = k + 1; if (words[j]?.t === 'id' && words[j].v === 'as') j++; k = j; return words[j]?.v }
      if (v === 'csv') opt.csv = true
      else if (v === 'format') opt.csv = nextVal() === 'csv'
      else if (v === 'header') opt.header = !(words[k + 1]?.t === 'id' && words[k + 1].v === 'false')
      else if (v === 'delimiter') opt.delim = nextVal()
      else if (v === 'null') opt.nul = nextVal()
    }
    const delim = opt.delim ?? (opt.csv ? ',' : '\t')
    const nul = opt.nul ?? (opt.csv ? '' : '\\N')
    const data = []
    let j = i + 1
    for (; j < lines.length; j++) {
      const l = lines[j].replace(/\r$/, '')
      if (l === '\\.') break
      data.push(l)
      out.push('')
    }
    if (j < lines.length) out.push('')
    i = j
    if (!table) { copies.push({ problem: `Could not read: ${line.slice(0, 120)}` }); continue }
    const rows = opt.csv ? csvRows(data, delim, nul) : data.filter(l => l !== '').map(l => l.split(delim).map(f => (f === nul ? null : unescapeCopy(f))))
    if (opt.csv && opt.header) rows.shift()
    copies.push({ table, columns, rows })
  }
  return { sql: out.join('\n'), copies }
}

const COPY_ESC = { b: '\b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v' }
function unescapeCopy(f) {
  if (!f.includes('\\')) return f
  return f.replace(/\\(x[0-9a-fA-F]{1,2}|[0-7]{1,3}|.)/g, (_, e) => {
    if (e[0] === 'x' && e.length > 1) return String.fromCharCode(parseInt(e.slice(1), 16))
    if (/^[0-7]+$/.test(e)) return String.fromCharCode(parseInt(e, 8))
    return COPY_ESC[e] ?? e
  })
}

// CSV rows (a quoted field may run over several lines).
function csvRows(lines, delim, nul) {
  const text = lines.join('\n')
  const rows = []
  let row = [], field = '', quoted = false, inQ = false
  const end = () => { row.push(!quoted && field === nul ? null : field); field = ''; quoted = false }
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (inQ) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++ }
      else if (c === '"') inQ = false
      else field += c
    } else if (c === '"') { inQ = true; quoted = true }
    else if (c === delim) end()
    else if (c === '\n') { end(); rows.push(row); row = [] }
    else field += c
  }
  if (field !== '' || quoted || row.length) { end(); rows.push(row) }
  return rows
}

// ── Oracle ───────────────────────────────────────────────────────────────────

// ALTER TABLE … MODIFY col [type] [constraints] | MODIFY (col …, col …).
function modifyColumn(s, t, problems) {
  const k = s.next()
  const col = k && (k.t === 'id' || k.t === 'qid') ? t.columns.find(c => c.name === nm(k)) : null
  if (!col) { if (k) problems.push(`${t.name}: MODIFY of an unknown column ${k.v}`); return false }
  const type = readType(s)
  if (type.name) col.type = type
  // MODIFY col NULL drops NOT NULL.
  if (s.isWord('null') || (s.isWord('constraint') && s.isWord('null', 2))) col.notNull = false
  readColumnConstraints(s, col, t, problems)
  return true
}

// A condition's text (a CHECK or an assertion), with Oracle's REGEXP_LIKE(a,
// p [, 'i']) written as PostgreSQL's a ~ p (a ~* p), which the CHECK reader
// knows.
function conditionText(tks) {
  if (mode === 'sqlserver') {
    // [name] as "name"; 1 = 1 and 1 = 0 (T-SQL has no TRUE) as TRUE, FALSE.
    const out = []
    for (let i = 0; i < tks.length; i++) {
      const t = tks[i]
      if (t.t === 'num' && tks[i + 1]?.t === 'op' && tks[i + 1].v === '=' && tks[i + 2]?.t === 'num' && t.v === '1' && /^[01]$/.test(tks[i + 2].v)) {
        const v = tks[i + 2].v === '1' ? 'TRUE' : 'FALSE'
        out.push({ t: 'id', v: v.toLowerCase(), raw: v }); i += 2; continue
      }
      // LIKE with a [character class] (T-SQL's, not standard SQL's) as a
      // regular expression.
      if (t.t === 'id' && t.v === 'like' && tks[i + 1]?.t === 'str' && /\[[^\]]+\]/.test(tks[i + 1].v) && tks[i - 1]?.v !== 'not') {
        const re = `^${tks[i + 1].v.replace(/\[[^\]]*\]|[%_]|[.*+?^${}()|\\]/g, (m) => (m === '%' ? '.*' : m === '_' ? '.' : m.startsWith('[') ? m.replace(/^\[\^/, '[^') : `\\${m}`))}$`
        out.push({ t: 'op', v: '~', raw: '~' }, { t: 'str', v: re, raw: `'${re.replace(/'/g, "''")}'` })
        i++
        continue
      }
      out.push(t.t === 'qid' ? { ...t, raw: `"${t.v.replace(/"/g, '""')}"` } : t)
    }
    return tokensText(out)
  }
  if (mode !== 'oracle') return tokensText(tks)
  const out = []
  for (let i = 0; i < tks.length; i++) {
    const t = tks[i]
    if (t.t === 'id' && t.v === 'regexp_like' && tks[i + 1]?.t === 'op' && tks[i + 1].v === '(') {
      let depth = 0, j = i + 1
      for (; j < tks.length; j++) {
        if (tks[j].t === 'op' && tks[j].v === '(') depth++
        if (tks[j].t === 'op' && tks[j].v === ')' && --depth === 0) break
      }
      const args = splitCommas(tks.slice(i + 2, j))
      const flags = args[2]?.length === 1 && args[2][0].t === 'str' ? args[2][0].v : ''
      if (args.length >= 2 && /^[ic]*$/.test(flags)) {
        const ci = flags.lastIndexOf('i') > flags.lastIndexOf('c')
        out.push({ t: 'op', v: '(', raw: '(' }, ...conditionTokens(args[0]), { t: 'op', v: ci ? '~*' : '~', raw: ci ? '~*' : '~' },
          ...conditionTokens(args[1]), { t: 'op', v: ')', raw: ')' })
        i = j
        continue
      }
    }
    out.push(t)
  }
  return tokensText(out)
}
const conditionTokens = (tks) => tokenize(conditionText(tks))

// A date or timestamp written by TO_DATE / TO_TIMESTAMP with an Oracle
// format model, as 'YYYY-MM-DD' (no time in the format) or 'YYYY-MM-DD
// HH:MI:SS'; null when the value doesn't fit the format.
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
export function oracleDate(value, format) {
  const parts = format.toUpperCase().replace(/^FX/, '').match(/YYYY|RRRR|SYYYY|YY|RR|MONTH|MON|MM|DD|HH24|HH12|HH|MI|SSSSS|SS|FF\d?|X|AM|PM|A\.M\.|P\.M\.|"[^"]*"|[^A-Z0-9"]+|[A-Z0-9]/g) ?? []
  let v = value.trim(), y = null, mo = null, d = 1, h = 0, mi = 0, sec = 0, frac = '', pm = null, time = false
  const take = (re) => { const m = re.exec(v); if (!m) return null; v = v.slice(m[0].length); return m }
  for (const p of parts) {
    let m
    if (/^(YYYY|RRRR|SYYYY)$/.test(p)) { m = take(/^[+-]?\d{1,4}/); if (!m) return null; y = +m[0] }
    else if (p === 'YY' || p === 'RR') {
      m = take(/^\d{1,4}/); if (!m) return null
      y = m[0].length > 2 ? +m[0] : (p === 'RR' ? (+m[0] < 50 ? 2000 : 1900) : 2000) + +m[0]
    } else if (p === 'MONTH' || p === 'MON') {
      m = take(/^[A-Za-z]+/); if (!m) return null
      const k = MONTHS.indexOf(m[0].slice(0, 3).toLowerCase()); if (k < 0) return null
      mo = k + 1
    } else if (p === 'MM') { m = take(/^\d{1,2}/); if (!m) return null; mo = +m[0] }
    else if (p === 'DD') { m = take(/^\d{1,2}/); if (!m) return null; d = +m[0] }
    else if (/^HH/.test(p)) { m = take(/^\d{1,2}/); if (!m) return null; h = +m[0]; time = true; if (p !== 'HH24') pm ??= false }
    else if (p === 'MI') { m = take(/^\d{1,2}/); if (!m) return null; mi = +m[0]; time = true }
    else if (p === 'SS') { m = take(/^\d{1,2}/); if (!m) return null; sec = +m[0]; time = true }
    else if (/^FF/.test(p)) { m = take(/^\d+/); if (m) frac = m[0] }
    else if (p === 'X') take(/^[.,]/)
    else if (/^(AM|PM|A\.M\.|P\.M\.)$/.test(p)) { m = take(/^[AaPp]\.?[Mm]\.?/); if (m) pm = /^p/i.test(m[0]) }
    else take(/^[^A-Za-z0-9]*/)   // separators (Oracle is lenient about them)
  }
  if (y == null || mo == null || mo < 1 || mo > 12 || d < 1 || d > 31) return null
  if (pm != null) h = (h % 12) + (pm ? 12 : 0)
  const p2 = (x) => String(x).padStart(2, '0')
  const date = `${String(y).padStart(4, '0')}-${p2(mo)}-${p2(d)}`
  return time || frac ? `${date} ${p2(h)}:${p2(mi)}:${p2(sec)}${frac ? `.${frac}` : ''}` : date
}
