// Value semantics for datatypes: separates a data value from the strings that
// represent it (XML Schema's lexical space vs value space). Equality and order
// in constraints are defined over values, so e.g. 'en-GB' = 'en-gb' for
// xs:language and 'P2D' < 'P10D' for durations.
//
// Each value kind has:
//   parse(str)    → { value } | { invalid: true }   (str is trimmed, non-empty)
//   compare(a, b) → negative / 0 / positive, or NaN when a and b are
//                   incomparable (only for partially ordered kinds)
//   equal(a, b)   → value equality
//   order         → 'total' | 'partial' | 'none'
//   expect        → short description of the accepted syntax, for messages

const sign = (x) => (x < 0 ? -1 : x > 0 ? 1 : 0)

// ── Date/time model ──────────────────────────────────────────────────────────
// Every date/time-like value is { ms, tz } where ms is the instant in UTC
// milliseconds (with fields missing from the type filled in from 1972-01-01)
// and tz says whether a timezone was given. Values without a timezone are
// read as UTC. Following XML Schema, a value with a timezone and one without
// are only comparable when they are more than 14 hours apart.

const TZ_RE = '(Z|[+-]\\d{2}:\\d{2})?'
const FOURTEEN_HOURS = 14 * 3600 * 1000

function tzOffsetMs(tz) {
  if (!tz || tz === 'Z') return 0
  const s = tz[0] === '-' ? -1 : 1
  const [h, m] = tz.slice(1).split(':').map(Number)
  if (h > 14 || m > 59 || (h === 14 && m > 0)) return null
  return s * (h * 60 + m) * 60000
}

function daysInMonth(y, m) {
  return new Date(Date.UTC(y, m, 0)).getUTCDate()
}

// Build a { ms, tz } value, or null when a field is out of range.
function mkMoment({ y = 1972, mo = 1, d = 1, h = 0, mi = 0, s = 0, tz }) {
  if (mo < 1 || mo > 12) return null
  if (d < 1 || d > daysInMonth(y, mo)) return null
  if (h > 24 || mi > 59 || s >= 60) return null
  if (h === 24 && (mi > 0 || s > 0)) return null
  const off = tzOffsetMs(tz)
  if (off === null) return null
  const date = new Date(0)
  date.setUTCFullYear(y, mo - 1, d)
  date.setUTCHours(0, 0, 0, 0)
  const ms = date.getTime() + ((h * 60 + mi) * 60 + s) * 1000 - off
  return { ms, tz: !!tz }
}

function compareMoments(a, b) {
  if (a.tz === b.tz) return sign(a.ms - b.ms)
  // One has a timezone and the other not: the untimezoned one could be
  // anywhere in [ms - 14h, ms + 14h].
  const [p, q, flip] = a.tz ? [a, b, 1] : [b, a, -1]
  if (p.ms < q.ms - FOURTEEN_HOURS) return -1 * flip
  if (p.ms > q.ms + FOURTEEN_HOURS) return 1 * flip
  return NaN
}

const momentKind = (re, toFields, expect) => ({
  order: 'partial',
  expect,
  parse(str) {
    const m = re.exec(str)
    const v = m && mkMoment(toFields(m))
    return v ? { value: v } : { invalid: true }
  },
  compare: compareMoments,
  equal: (a, b) => a.tz === b.tz && a.ms === b.ms,
})

const YEAR = '(-?\\d{4,})'
const yr = (s) => Number(s)
const num = (s) => (s === undefined ? 0 : Number(s))

// ── Durations ────────────────────────────────────────────────────────────────
// A duration value is { months, seconds }, both carrying the sign.

const DURATION_RE = /^(-)?P(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/

function parseDuration(str, allowYM, allowDT) {
  const m = DURATION_RE.exec(str)
  if (!m) return null
  const [, neg, Y, Mo, D, H, Mi, S] = m
  if (str.endsWith('T')) return null
  if ([Y, Mo, D, H, Mi, S].every(x => x === undefined)) return null
  if (!allowYM && (Y !== undefined || Mo !== undefined)) return null
  if (!allowDT && [D, H, Mi, S].some(x => x !== undefined)) return null
  const sg = neg ? -1 : 1
  return {
    months: sg * (num(Y) * 12 + num(Mo)),
    seconds: sg * (((num(D) * 24 + num(H)) * 60 + num(Mi)) * 60 + num(S)),
  }
}

// XML Schema's reference instants for comparing general durations: a
// duration is smaller than another iff it is smaller when added to each of
// these, and incomparable if the four results disagree.
const DURATION_REFS = [
  Date.UTC(1696, 8, 1), Date.UTC(1697, 1, 1), Date.UTC(1903, 2, 1), Date.UTC(1903, 6, 1),
]

function addDuration(refMs, d) {
  const date = new Date(refMs)
  date.setUTCMonth(date.getUTCMonth() + d.months)   // refs are on day 1: no clamping
  return date.getTime() + d.seconds * 1000
}

function compareDurations(a, b) {
  const signs = DURATION_REFS.map(r => sign(addDuration(r, a) - addDuration(r, b)))
  return signs.every(s => s === signs[0]) ? signs[0] : NaN
}

const durationKind = (allowYM, allowDT, order, expect) => ({
  order,
  expect,
  parse(str) {
    const v = parseDuration(str, allowYM, allowDT)
    return v ? { value: v } : { invalid: true }
  },
  compare: compareDurations,
  equal: (a, b) => a.months === b.months && a.seconds === b.seconds,
})

// ── Kinds ────────────────────────────────────────────────────────────────────

const cmpPrimitive = (a, b) => (a < b ? -1 : a > b ? 1 : 0)
const eqPrimitive = (a, b) => a === b

const FLOAT_RE = /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/

export const VALUE_KINDS = {
  string: {
    order: 'total', expect: 'string',
    parse: (str) => ({ value: str }),
    compare: cmpPrimitive, equal: eqPrimitive,
  },
  integer: {
    order: 'total', expect: 'integer',
    parse: (str) => (/^[+-]?\d+$/.test(str) ? { value: Number(str) } : { invalid: true }),
    compare: cmpPrimitive, equal: eqPrimitive,
  },
  decimal: {
    order: 'total', expect: 'decimal',
    parse: (str) => (/^[+-]?(\d+(\.\d*)?|\.\d+)$/.test(str) ? { value: Number(str) } : { invalid: true }),
    compare: cmpPrimitive, equal: eqPrimitive,
  },
  float: {
    // NaN is not comparable to anything, not even to itself.
    order: 'partial', expect: 'floating-point number',
    parse(str) {
      if (str === 'INF' || str === '+INF') return { value: Infinity }
      if (str === '-INF') return { value: -Infinity }
      if (str === 'NaN') return { value: NaN }
      return FLOAT_RE.test(str) ? { value: Number(str) } : { invalid: true }
    },
    compare: (a, b) => (Number.isNaN(a) || Number.isNaN(b) ? NaN : cmpPrimitive(a, b)),
    equal: eqPrimitive,
  },
  boolean: {
    order: 'total', expect: 'boolean (true/false)',
    parse(str) {
      const s = str.toLowerCase()
      if (s === 'true' || s === '1') return { value: 1 }
      if (s === 'false' || s === '0') return { value: 0 }
      return { invalid: true }
    },
    compare: cmpPrimitive, equal: eqPrimitive,
  },
  // NORMA's Yes or No type: the same values as boolean, also written yes/no.
  yesNo: {
    order: 'total', expect: 'yes/no',
    parse(str) {
      const s = str.toLowerCase()
      if (s === 'yes' || s === 'true' || s === '1') return { value: 1 }
      if (s === 'no' || s === 'false' || s === '0') return { value: 0 }
      return { invalid: true }
    },
    compare: cmpPrimitive, equal: eqPrimitive,
  },
  date: momentKind(
    new RegExp(`^${YEAR}-(\\d{2})-(\\d{2})${TZ_RE}$`),
    m => ({ y: yr(m[1]), mo: +m[2], d: +m[3], tz: m[4] }),
    'date (YYYY-MM-DD)'),
  datetime: momentKind(
    new RegExp(`^${YEAR}-(\\d{2})-(\\d{2})[T ](\\d{2}):(\\d{2})(?::(\\d{2}(?:\\.\\d+)?))?${TZ_RE}$`),
    m => ({ y: yr(m[1]), mo: +m[2], d: +m[3], h: +m[4], mi: +m[5], s: num(m[6]), tz: m[7] }),
    'datetime (YYYY-MM-DDTHH:MM[:SS][Z])'),
  time: momentKind(
    new RegExp(`^(\\d{2}):(\\d{2})(?::(\\d{2}(?:\\.\\d+)?))?${TZ_RE}$`),
    m => ({ h: +m[1], mi: +m[2], s: num(m[3]), tz: m[4] }),
    'time (HH:MM[:SS])'),
  gYear: momentKind(
    new RegExp(`^${YEAR}${TZ_RE}$`),
    m => ({ y: yr(m[1]), tz: m[2] }),
    'year (YYYY)'),
  gYearMonth: momentKind(
    new RegExp(`^${YEAR}-(\\d{2})${TZ_RE}$`),
    m => ({ y: yr(m[1]), mo: +m[2], tz: m[3] }),
    'year and month (YYYY-MM)'),
  gMonth: momentKind(
    new RegExp(`^--(\\d{2})${TZ_RE}$`),
    m => ({ mo: +m[1], tz: m[2] }),
    'month (--MM)'),
  gMonthDay: momentKind(
    new RegExp(`^--(\\d{2})-(\\d{2})${TZ_RE}$`),
    m => ({ mo: +m[1], d: +m[2], tz: m[3] }),
    'month and day (--MM-DD)'),
  gDay: momentKind(
    new RegExp(`^---(\\d{2})${TZ_RE}$`),
    m => ({ d: +m[1], tz: m[2] }),
    'day of month (---DD)'),
  duration: durationKind(true, true, 'partial', 'duration (e.g. P1Y2M3DT4H)'),
  dayTimeDuration: durationKind(false, true, 'total', 'day-time duration (e.g. P3DT4H30M)'),
  yearMonthDuration: durationKind(true, false, 'total', 'year-month duration (e.g. P1Y6M)'),
  language: {
    order: 'none', expect: 'language tag (e.g. en-GB)',
    parse: (str) => (/^[a-zA-Z]{1,8}(-[a-zA-Z0-9]{1,8})*$/.test(str) ? { value: str.toLowerCase() } : { invalid: true }),
    compare: () => NaN, equal: eqPrimitive,
  },
  // SQL binary strings compare byte by byte; hex is normalised to lower case
  // so string order on it is byte order. Accepts X'0A1B' or plain hex.
  binary: {
    order: 'total', expect: 'hex bytes (e.g. 0A1B)',
    parse(str) {
      const m = /^(?:[xX]'([0-9a-fA-F]*)'|([0-9a-fA-F]*))$/.exec(str)
      const hex = m && (m[1] ?? m[2])
      return hex != null && hex.length % 2 === 0 ? { value: hex.toLowerCase() } : { invalid: true }
    },
    compare: cmpPrimitive, equal: eqPrimitive,
  },
  hexBinary: {
    order: 'none', expect: 'hex bytes (e.g. 0A1B)',
    parse: (str) => (/^([0-9a-fA-F]{2})*$/.test(str) ? { value: str.toLowerCase() } : { invalid: true }),
    compare: () => NaN, equal: eqPrimitive,
  },
  base64Binary: {
    order: 'none', expect: 'base64 data',
    parse(str) {
      const s = str.replace(/\s+/g, '')
      return /^([A-Za-z0-9+/]{4})*([A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(s) ? { value: s } : { invalid: true }
    },
    compare: () => NaN, equal: eqPrimitive,
  },
  // Values with equality but no meaningful order (URIs, qualified names,
  // JSON and XML documents, null).
  unordered: {
    order: 'none', expect: 'value',
    parse: (str) => ({ value: str }),
    compare: () => NaN, equal: eqPrimitive,
  },
}

// ── Datatype → value kind ────────────────────────────────────────────────────

const ABSTRACT = {
  text: 'string', integer: 'integer', decimal: 'decimal',
  boolean: 'boolean', date: 'date', datetime: 'datetime',
  duration: 'duration',
}

const SQL = {
  CHAR: 'string', VARCHAR: 'string', CLOB: 'string',
  NCHAR: 'string', NVARCHAR: 'string', NCLOB: 'string',
  BINARY: 'binary', VARBINARY: 'binary', BLOB: 'binary',
  NUMERIC: 'decimal', DECIMAL: 'decimal',
  INTEGER: 'integer', SMALLINT: 'integer', BIGINT: 'integer',
  FLOAT: 'float', REAL: 'float', 'DOUBLE PRECISION': 'float', DECFLOAT: 'float',
  BOOLEAN: 'boolean',
  DATE: 'date', TIME: 'time', TIMESTAMP: 'datetime',
  INTERVAL: 'duration',   // narrowed by startField below
  JSON: 'unordered', XML: 'unordered',
}

const XSD = {
  'xs:string': 'string', 'xs:normalizedString': 'string', 'xs:token': 'string',
  'xs:language': 'language', 'xs:anyURI': 'unordered',
  'xs:Name': 'string', 'xs:NCName': 'string', 'xs:ID': 'string', 'xs:IDREF': 'string',
  'xs:NMTOKEN': 'string', 'xs:ENTITY': 'string',
  'xs:NOTATION': 'unordered', 'xs:QName': 'unordered',
  'xs:decimal': 'decimal',
  'xs:integer': 'integer', 'xs:long': 'integer', 'xs:int': 'integer',
  'xs:short': 'integer', 'xs:byte': 'integer',
  'xs:nonNegativeInteger': 'integer', 'xs:positiveInteger': 'integer',
  'xs:float': 'float', 'xs:double': 'float',
  'xs:boolean': 'boolean',
  'xs:dateTime': 'datetime', 'xs:dateTimeStamp': 'datetime',
  'xs:date': 'date', 'xs:time': 'time',
  'xs:duration': 'duration', 'xs:dayTimeDuration': 'dayTimeDuration',
  'xs:yearMonthDuration': 'yearMonthDuration',
  'xs:gYear': 'gYear', 'xs:gYearMonth': 'gYearMonth', 'xs:gMonth': 'gMonth',
  'xs:gMonthDay': 'gMonthDay', 'xs:gDay': 'gDay',
  'xs:base64Binary': 'base64Binary', 'xs:hexBinary': 'hexBinary',
}

const JSON_PROFILE = {
  string: 'string', number: 'float', integer: 'integer',
  boolean: 'boolean', null: 'unordered',
}

const TYPESCRIPT = {
  string: 'string', number: 'float', bigint: 'integer',
  boolean: 'boolean', null: 'unordered', Date: 'datetime', Uint8Array: 'hexBinary',
}

// NORMA raw data cannot be compared in NORMA, so it is unordered here.
const NORMA = {
  TextFixedLength: 'string', TextVariableLength: 'string', TextLargeLength: 'string',
  NumericSignedInteger: 'integer', NumericSignedSmallInteger: 'integer',
  NumericSignedLargeInteger: 'integer', NumericUnsignedInteger: 'integer',
  NumericUnsignedTinyInteger: 'integer', NumericUnsignedSmallInteger: 'integer',
  NumericUnsignedLargeInteger: 'integer', NumericAutoCounter: 'integer',
  NumericFloatingPoint: 'float', NumericSinglePrecisionFloatingPoint: 'float',
  NumericDoublePrecisionFloatingPoint: 'float',
  NumericDecimal: 'decimal', NumericMoney: 'decimal',
  NumericUUID: 'unordered',
  RawDataFixedLength: 'hexBinary', RawDataVariableLength: 'hexBinary',
  RawDataLargeLength: 'hexBinary', RawDataPicture: 'hexBinary', RawDataOleObject: 'hexBinary',
  TemporalAutoTimestamp: 'datetime', TemporalTime: 'time',
  TemporalDate: 'date', TemporalDateAndTime: 'datetime',
  LogicalTrueOrFalse: 'boolean', LogicalYesOrNo: 'yesNo', LogicalTrue: 'boolean',
  OtherRowId: 'unordered', OtherObjectId: 'unordered',
}

const MAPPING = {
  abstract: ABSTRACT,
  sql2016: SQL,
  xmlschema: XSD,
  json: JSON_PROFILE,
  typescript: TYPESCRIPT,
  norma: NORMA,
}

// Name of the value kind for a datatype assignment, or null when the datatype
// is unknown (no assignment, or not in the mapping).
export function valueKindName(assignment) {
  if (!assignment?.profileId || !assignment?.datatypeId) return null
  const kind = MAPPING[assignment.profileId]?.[assignment.datatypeId] ?? null
  if (kind === 'duration' && assignment.profileId === 'sql2016') {
    // SQL intervals are either year-month or day-time, by their leading field.
    const f = String(assignment.params?.startField ?? '').trim().toUpperCase()
    if (f === 'YEAR' || f === 'MONTH') return 'yearMonthDuration'
    if (['DAY', 'HOUR', 'MINUTE', 'SECOND'].includes(f)) return 'dayTimeDuration'
  }
  return kind
}

export function valueKindOf(assignment) {
  const name = valueKindName(assignment)
  return name ? VALUE_KINDS[name] : null
}

// Parse a literal: { empty } for a blank field, otherwise the kind's parse.
export function parseLiteral(raw, kind) {
  const s = typeof raw === 'string' ? raw.trim() : raw == null ? '' : String(raw)
  if (s === '') return { empty: true }
  return kind.parse(s)
}
