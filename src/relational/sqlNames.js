// SQL identifiers: quoted when they are not plain lower-case names or are
// reserved words, by the rules of the SQL dialect being written (PostgreSQL by
// default; withDialect('oracle', fn) writes Oracle while fn runs, and
// withDialect('sqlserver', fn) T-SQL, so the
// writers that share these helpers, formulaSql.js, viewSql.js and
// relationalModel.js, write that dialect). Oracle folds unquoted names to
// upper case, so a plain lower-case name stays unquoted there too, and every
// reference to it is written the same way.

// The SQL dialects written and read: PostgreSQL, Oracle, SQL Server (T-SQL).
export const DIALECT_NAMES = { postgresql: 'PostgreSQL', oracle: 'Oracle', sqlserver: 'SQL Server' }

// A column type as a DBMS's own script wrote it (datatypeAssignment.sqlTypes,
// or the older .oracle), which that DBMS's export writes back.
export const nativeType = (assignment, dialect) =>
  assignment?.sqlTypes?.[dialect] ?? (dialect === 'oracle' ? assignment?.oracle : null) ?? null
export const nativeTypes = (assignment) => ({
  ...(assignment?.oracle ? { oracle: assignment.oracle } : {}),
  ...(assignment?.sqlTypes ?? {}),
})

let current = 'postgresql'
export const sqlDialect = () => current

// T-SQL has no TRUE and FALSE in conditions: TRUE and FALSE outside strings
// and quoted names as 1 = 1 and 1 = 0.
export function tsqlBooleans(text) {
  let out = '', i = 0
  while (i < text.length) {
    const c = text[i]
    const close = c === "'" ? "'" : c === '"' ? '"' : c === '[' ? ']' : null
    if (close) {
      let j = i + 1
      for (; j < text.length; j++) if (text[j] === close) { if (text[j + 1] === close) j++; else break }
      out += text.slice(i, j + 1); i = j + 1; continue
    }
    const m = /^(TRUE|FALSE)\b/.exec(text.slice(i, i + 6))
    if (m && !/[A-Za-z0-9_$@#]/.test(text[i - 1] ?? '')) { out += m[1] === 'TRUE' ? '(1 = 1)' : '(1 = 0)'; i += m[1].length; continue }
    out += c; i++
  }
  return out
}
export function withDialect(dialect, fn) {
  const prev = current
  current = dialect
  try { return fn() } finally { current = prev }
}

// Oracle's reserved words (V$RESERVED_WORDS with reserved = 'Y', plus a few
// keywords that break unquoted).
const ORACLE_RESERVED = new Set(`access add all alter and any as asc audit between boolean by char check cluster column
comment compress connect create current date decimal default delete desc distinct drop else exclusive exists false file
float for from grant group having identified immediate in increment index initial insert integer intersect into is level
like lock long maxextents minus mlslabel mode modify noaudit nocompress not nowait null number of offline on online option
or order pctfree prior public raw rename resource revoke row rowid rownum rows select session set share size smallint start
successful synonym sysdate table then to trigger true uid union unique update user validate values varchar varchar2 view
whenever where with`.split(/\s+/))

const RESERVED = new Set(`all analyse analyze and any array as asc asymmetric both case cast check collate column
constraint create current_catalog current_date current_role current_time current_timestamp current_user default
deferrable desc distinct do else end except false fetch for foreign from grant group having in initially intersect
into lateral leading limit localtime localtimestamp not null offset on only or order placing primary references
returning select session_user some symmetric table then to trailing true union unique user using variadic when
where window with`.split(/\s+/))

// T-SQL's reserved words (Microsoft's list), compared without case.
const TSQL_RESERVED = new Set(`add all alter and any as asc authorization backup begin between break browse bulk by cascade case
check checkpoint close clustered coalesce collate column commit compute constraint contains containstable continue convert
create cross current current_date current_time current_timestamp current_user cursor database dbcc deallocate declare default
delete deny desc disk distinct distributed double drop dump else end errlvl escape except exec execute exists exit external
fetch file fillfactor for foreign freetext freetexttable from full function goto grant group having holdlock identity
identity_insert identitycol if in index inner insert intersect into is join key kill left like lineno load merge national
nocheck nonclustered not null nullif of off offsets on open opendatasource openquery openrowset openxml option or order outer
over percent pivot plan precision primary print proc procedure public raiserror read readtext reconfigure references
replication restore restrict return revert revoke right rollback rowcount rowguidcol rule save schema securityaudit select
semantickeyphrasetable semanticsimilaritydetailstable semanticsimilaritytable session_user set setuser shutdown some statistics
system_user table tablesample textsize then to top tran transaction trigger truncate try_convert tsequal union unique unpivot
update updatetext use user values varying view waitfor when where while with within writetext`.split(/\s+/))

export function quoteIdent(name) {
  if (current === 'sqlserver') {
    // SQL Server keeps a name's case and compares names without it, so any
    // plain name stays unquoted; others are [quoted].
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && !TSQL_RESERVED.has(name.toLowerCase()) && name.length <= 128) return name
    return `[${String(name).replace(/]/g, ']]')}]`
  }
  if (current === 'oracle') {
    if (/^[a-z][a-z0-9_$#]*$/.test(name) && !ORACLE_RESERVED.has(name) && name.length <= 128) return name
    return `"${String(name).replace(/"/g, '""')}"`
  }
  if (/^[a-z_][a-z0-9_$]*$/.test(name) && !RESERVED.has(name)) return name
  return `"${String(name).replace(/"/g, '""')}"`
}
