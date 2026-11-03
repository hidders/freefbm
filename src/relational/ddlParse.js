// A parser for the table-defining part of PostgreSQL DDL (workbench step 5).
// It reads what a schema dump or a hand-written script declares about tables:
// CREATE TABLE (columns, types, NOT NULL, PRIMARY KEY, UNIQUE, REFERENCES,
// CHECK), ALTER TABLE ... ADD [CONSTRAINT] (pg_dump style) and column changes
// (ADD/DROP/RENAME/ALTER COLUMN), CREATE TYPE ... AS
// ENUM, CREATE DOMAIN and CREATE UNIQUE INDEX on plain columns. Everything else
// (views, functions, triggers, grants...) is counted and skipped. Rows of
// INSERT INTO ... VALUES are read as sample data (step 8), with literal values
// only.
//
// parseDdl(sql) → { tables, enums, domains, inserts, skipped, problems }
//   tables:  [{ name, qualified, columns: [{ name, type, notNull, checks: [text] }],
//               primaryKey: [col] | null, uniques: [[col]], foreignKeys: [{ columns,
//               refTable, refColumns | null }], checks: [text] }]
//   enums:   Map(name → [label])
//   domains: Map(name → { type, notNull, checks: [text] })
//   inserts: [{ table: { name, schema }, columns: [name] | null, rows: [[value]] }]
//            value: a string, null (NULL), or undefined (not a literal)
//   skipped: Map(statement kind → count)
//   problems:[text]

// ── Lexer ────────────────────────────────────────────────────────────────────
// Tokens: { t: 'id' | 'qid' | 'str' | 'num' | 'op' | 'semi', v, raw }.
// 'id' values are lower-cased (PostgreSQL folds unquoted names); 'qid' keeps
// its case. Comments, and dollar-quoted bodies of functions, are skipped over
// as strings so their semicolons don't end a statement.
export function tokenize(sql) {
  const out = []
  let i = 0
  const n = sql.length
  while (i < n) {
    const c = sql[i]
    if (/\s/.test(c)) { i++; continue }
    // psql meta-commands (\c db, \set ...) run to the end of their line.
    if (c === '\\' && /(^|\n)[ \t]*$/.test(sql.slice(Math.max(0, i - 80), i))) { while (i < n && sql[i] !== '\n') i++; continue }
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
    if (c === "'" || ((c === 'E' || c === 'e') && sql[i + 1] === "'")) {
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
    if (c === '$') {
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
      out.push({ t: 'qid', v, raw: sql.slice(start, i) })
      continue
    }
    if (/[A-Za-z_\u0080-￿]/.test(c)) {
      const start = i
      while (i < n && /[A-Za-z0-9_$\u0080-￿]/.test(sql[i])) i++
      const raw = sql.slice(start, i)
      out.push({ t: 'id', v: raw.toLowerCase(), raw })
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

// Splits tokens into statements at top-level semicolons.
function statements(tokens) {
  const out = []
  let cur = []
  for (const tk of tokens) {
    if (tk.t === 'semi') { if (cur.length) out.push(cur); cur = [] }
    else cur.push(tk)
  }
  if (cur.length) out.push(cur)
  return out
}

// ── Token stream helpers ─────────────────────────────────────────────────────

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
    parts.push(this.next().v)
    while (this.isOp('.') && (this.peek(1)?.t === 'id' || this.peek(1)?.t === 'qid')) { this.i++; parts.push(this.next().v) }
    return { name: parts[parts.length - 1], schema: parts.length > 1 ? parts[parts.length - 2] : null }
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
  return t ? t.v : null
}).filter(Boolean)

// Words that end a column's type.
const TYPE_STOP = new Set(['constraint', 'not', 'null', 'default', 'primary', 'unique', 'references',
  'check', 'collate', 'generated', 'identity', 'deferrable', 'initially'])

// ── Statements ───────────────────────────────────────────────────────────────

export function parseDdl(sql) {
  const tables = new Map()   // key: qualified name
  const enums = new Map()
  const domains = new Map()
  const skipped = new Map()
  const inserts = []
  const problems = []
  const skip = (kind) => skipped.set(kind, (skipped.get(kind) ?? 0) + 1)
  const keyOf = (q) => `${q.schema ?? ''}.${q.name}`
  const findTable = (q) => tables.get(keyOf(q)) ?? [...tables.values()].find(t => t.name === q.name && (!q.schema || t.schema === q.schema))

  const partitions = new Set()
  const handle = (tokens, defSchema) => {
    const s = new Stream(tokens)
    const qn = () => { const q = s.qname(); return q && !q.schema && defSchema ? { ...q, schema: defSchema } : q }
    try {
      if (s.eatWord('create')) {
        s.eatWord('or', 'replace')
        s.eatWord('global'); s.eatWord('local')
        s.eatWord('temporary'); s.eatWord('temp'); s.eatWord('unlogged')
        if (s.eatWord('table')) { parseCreateTable(s, tables, keyOf, problems, skip, defSchema); return }
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
        if (s.isWord('unique') && s.isWord('index', 1)) {
          s.i += 2
          s.eatWord('concurrently'); s.eatWord('if', 'not', 'exists')
          if (!s.isWord('on')) s.qname()
          s.eatWord('on'); s.eatWord('only')
          const q = qn()
          if (s.eatWord('using')) s.next()
          const g = s.group()
          const cols = g && splitCommas(g).every(p => p.length === 1 && (p[0].t === 'id' || p[0].t === 'qid')) ? nameList(g) : null
          const rest = s.tk.slice(s.i)
          const t = q && findTable(q)
          if (t && cols && !rest.some(x => x.t === 'id' && x.v === 'where')) t.uniques.push(cols)
          else skip('CREATE UNIQUE INDEX on expressions or with WHERE')
          return
        }
        const kind = tokens.slice(1, 4).filter(t => t.t === 'id').map(t => t.v)
          .find(w => ['view', 'function', 'procedure', 'trigger', 'index', 'sequence', 'schema', 'extension',
            'materialized', 'aggregate', 'rule', 'policy', 'publication', 'operator', 'cast', 'language'].includes(w))
        skip(`CREATE ${(kind ?? tokens[1]?.v ?? '').toUpperCase()}`)
        return
      }
      if (s.eatWord('insert', 'into')) {
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
          if (child) partitions.add(keyOf(child))
          return
        }
        const actions = splitCommas(s.tk.slice(s.i))
        let used = false
        for (const a of actions) {
          const as = new Stream(a)
          if (!t) {
            // Sequences, views and the like are altered too; only adding to a missing table is a problem.
            if (as.isWord('add') && !as.isWord('column', 1)) problems.push(`ALTER TABLE ${q?.name}: the table was not created in this script`)
            continue
          }
          if (alterColumn(as, t, problems)) { used = true; continue }
          if (!as.eatWord('add')) continue
          if (readTableConstraint(as, t, problems)) used = true
        }
        if (!used) skip('ALTER TABLE (other than adding a constraint or changing columns)')
        return
      }
      const head = tokens.slice(0, 2).filter(t => t.t === 'id').map(t => t.v.toUpperCase()).join(' ')
      skip(head || 'statement')
    } catch (err) {
      problems.push(`Could not read: ${tokensText(tokens).slice(0, 120)}… (${err.message})`)
    }
  }
  for (const tokens of statements(tokenize(sql))) handle(tokens, null)
  // Partitions of a partitioned table hold its rows; they are not tables of their own.
  for (const k of partitions) if (tables.delete(k)) skip('partition (ALTER TABLE ... ATTACH PARTITION)')
  return { tables: [...tables.values()], enums, domains, inserts, skipped, problems }
}

// The value of a literal in a VALUES list: a string, null for NULL, or
// undefined for anything else (an expression or a function call). Casts
// (::type) are dropped.
function literalValue(tokens) {
  let tks = tokens
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

function parseCreateTable(s, tables, keyOf, problems, skip, defSchema) {
  s.eatWord('if', 'not', 'exists')
  let q = s.qname()
  if (q && !q.schema && defSchema) q = { ...q, schema: defSchema }
  if (!q) throw new Error('no table name')
  if (s.isWord('partition') && s.isWord('of', 1)) { skip('CREATE TABLE ... PARTITION OF'); return }
  if (s.isWord('of')) { skip('CREATE TABLE ... OF type'); return }
  const body = s.group()
  if (!body) { skip('CREATE TABLE AS'); return }
  const t = { name: q.name, schema: q.schema, columns: [], primaryKey: null, uniques: [], foreignKeys: [], checks: [] }
  for (const item of splitCommas(body)) {
    const is = new Stream(item)
    if (is.isWord('constraint') || is.isWord('primary') || is.isWord('unique') || is.isWord('foreign')
        || is.isWord('check') || is.isWord('exclude')) {
      readTableConstraint(is, t, problems)
      continue
    }
    if (is.isWord('like')) { problems.push(`${t.name}: LIKE in CREATE TABLE is not read`); continue }
    const nameTk = is.next()
    if (!nameTk || (nameTk.t !== 'id' && nameTk.t !== 'qid')) continue
    const col = { name: nameTk.v, type: readType(is), notNull: false, checks: [] }
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

// Column constraints after the type, into col (and, for REFERENCES, the table).
function readColumnConstraints(s, col, table, problems) {
  while (!s.done()) {
    if (s.eatWord('constraint')) { s.next(); continue }
    if (s.eatWord('not', 'null')) { col.notNull = true; continue }
    if (s.eatWord('null')) continue
    if (s.eatWord('default')) {
      // A default from a sequence or a UUID generator makes a surrogate.
      const start = s.i
      skipExpression(s)
      const words = s.tk.slice(start, s.i).filter(t => t.t === 'id').map(t => t.v)
      if (words.includes('nextval')) col.defaultGenerated = 'sequence'
      else if (words.some(w => /^(gen_random_uuid|uuid_generate\w*|uuidv\d)$/.test(w))) col.defaultGenerated = 'uuid'
      continue
    }
    if (s.eatWord('collate')) { s.qname(); continue }
    if (s.eatWord('generated')) {
      // GENERATED ALWAYS|BY DEFAULT AS IDENTITY [(...)] | AS (expr) STORED
      while (!s.done() && !s.isWord('as')) s.next()
      s.eatWord('as')
      if (s.eatWord('identity')) { if (s.isOp('(')) s.group(); col.identity = true }
      else { s.group(); s.eatWord('stored'); col.generated = true }
      continue
    }
    if (s.eatWord('primary', 'key')) { if (table) table.primaryKey = [col.name]; col.notNull = true; continue }
    if (s.eatWord('unique')) { s.eatWord('nulls', 'not', 'distinct'); if (table) table.uniques.push([col.name]); continue }
    if (s.eatWord('check')) { col.checks.push(tokensText(s.group() ?? [])); s.eatWord('no', 'inherit'); continue }
    if (s.eatWord('references')) {
      const q = s.qname()
      const g = s.isOp('(') ? nameList(s.group()) : null
      skipReferentialActions(s)
      if (table && q) table.foreignKeys.push({ columns: [col.name], refTable: q.name, refSchema: q.schema, refColumns: g })
      continue
    }
    if (s.eatWord('deferrable') || s.eatWord('not', 'deferrable') || s.eatWord('initially', 'deferred') || s.eatWord('initially', 'immediate')) continue
    s.next()
  }
}

// ALTER TABLE actions on columns: ADD [COLUMN], DROP COLUMN, RENAME [COLUMN]
// a TO b, ALTER [COLUMN] c SET|DROP NOT NULL, [SET DATA] TYPE, SET|DROP
// DEFAULT. Scripts such as AdventureWorks reshape tables after CREATE TABLE.
// Returns false for anything else (ADD of a table constraint among them).
function alterColumn(s, t, problems) {
  const colName = () => { const k = s.next(); return k && (k.t === 'id' || k.t === 'qid') ? k.v : null }
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
  if (s.eatWord('constraint')) cname = s.next()?.v ?? null
  if (s.eatWord('primary', 'key')) {
    t.primaryKey = nameList(s.group())
    return true
  }
  if (s.eatWord('unique')) {
    s.eatWord('nulls', 'not', 'distinct')
    const cols = nameList(s.group())
    if (cols.length) t.uniques.push(cols)
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
    t.checks.push(tokensText(s.group() ?? []))
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
