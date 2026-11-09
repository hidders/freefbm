// SQL identifiers: quoted when they are not plain lower-case names or are
// reserved words, by the rules of the SQL dialect being written (PostgreSQL by
// default; withDialect('oracle', fn) writes Oracle while fn runs, so the
// writers that share these helpers, formulaSql.js, viewSql.js and
// relationalModel.js, write that dialect). Oracle folds unquoted names to
// upper case, so a plain lower-case name stays unquoted there too, and every
// reference to it is written the same way.

let current = 'postgresql'
export const sqlDialect = () => current
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

export function quoteIdent(name) {
  if (current === 'oracle') {
    if (/^[a-z][a-z0-9_$#]*$/.test(name) && !ORACLE_RESERVED.has(name) && name.length <= 128) return name
    return `"${String(name).replace(/"/g, '""')}"`
  }
  if (/^[a-z_][a-z0-9_$]*$/.test(name) && !RESERVED.has(name)) return name
  return `"${String(name).replace(/"/g, '""')}"`
}
