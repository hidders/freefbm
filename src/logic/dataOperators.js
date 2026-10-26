// Data operators: the data functions and data predicates of the logic
// (docs/logic/agg-logic.tex, section "Adding typed terms"), so that derivation
// rules can compute values.
//
// The sorts of the logic are the value kinds of src/utils/datatypeValues.js
// (integer, decimal, date, …), so every datatype profile gets the same
// operators. Decisions (Jan, 2026-10-26):
//   - numbers widen implicitly: integer ⊑ decimal ⊑ float;
//   - operators are partial (÷ 0, 31 January + 1 month, overflow): a term
//     without a value makes the atom it is in false;
//   - there is no today or now.
//
// Data terms in derivation rules (src/logic/derivationRule.js):
//   { t: 'hole' }
//   { t: 'var', id }                         the data value of a variable
//   { t: 'const', text }                     read under the sort its place needs
//   { t: 'op', op, args: [T] }               an operator from OPS
//   { t: 'if', cond: R, then: T, else: T }   conditional term; cond is a formula
// and the atoms that use them:
//   { t: 'vcmp', op: '≈' | '≉' | '<' | '≤' | '>' | '≥', left: T, right: T }
//   { t: 'dpred', op, args: [T] }            a data predicate from PREDS
//
// Values are those that VALUE_KINDS parse to: numbers for the numeric sorts,
// strings, 1/0 for booleans, { ms, tz } for dates and times, and
// { months, seconds } for durations. Timezoned dates and times are computed
// in UTC.

import { VALUE_KINDS, parseLiteral } from '../utils/datatypeValues.js'

// ── Sorts ────────────────────────────────────────────────────────────────────

const NUM = ['integer', 'decimal', 'float']
const DUR = ['yearMonthDuration', 'dayTimeDuration', 'duration']
const RANK = { integer: 0, decimal: 1, float: 2 }

// The sort of a value kind: Yes or No is a boolean.
export const sortOf = (kindName) => (kindName === 'yesNo' ? 'boolean' : kindName ?? null)

// Whether a value of sort s can be used where sort p is expected.
export const fits = (s, p) => s === p || (s in RANK && p in RANK && RANK[s] <= RANK[p])

// The smallest sort both a and b widen to, or null.
export const join = (a, b) => (fits(a, b) ? b : fits(b, a) ? a : null)

// The sort a lone constant gets when nothing around it says otherwise.
export function guessSort(text) {
  const s = String(text ?? '').trim()
  if (/^[+-]?\d+$/.test(s)) return 'integer'
  if (/^[+-]?(\d+(\.\d*)?|\.\d+)$/.test(s)) return 'decimal'
  if (/^(true|false)$/i.test(s)) return 'boolean'
  return 'string'
}

const parseAs = (text, sort) => {
  const kind = VALUE_KINDS[sort]
  if (!kind) return { invalid: true }
  return parseLiteral(String(text ?? ''), kind)
}

// ── Numbers ──────────────────────────────────────────────────────────────────

// A numeric result as a value of its sort, or undefined (overflow, ÷ 0).
// Decimals are JS numbers rounded to 15 significant digits, so 0.1 + 0.2 ≈ 0.3.
function num(x, sort) {
  if (typeof x !== 'number' || Number.isNaN(x) && sort !== 'float') return undefined
  if (sort === 'integer') return Number.isSafeInteger(x) ? x : undefined
  if (sort === 'decimal') return Number.isFinite(x) ? Number(x.toPrecision(15)) : undefined
  return x
}

const roundHalfAway = (x, n = 0) => {
  const f = 10 ** n
  return Math.sign(x) * Math.round(Math.abs(x) * f) / f
}

// ── Dates and times ─────────────────────────────────────────────────────────

const DAY = 86400000
const T0 = Date.UTC(1972, 0, 1)
const mod = (a, b) => ((a % b) + b) % b
const daysInMonth = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate()

function utc(y, mo, d, ms = 0) {
  const date = new Date(0)
  date.setUTCFullYear(y, mo - 1, d)
  date.setUTCHours(0, 0, 0, 0)
  return date.getTime() + ms
}

const fields = (ms) => {
  const d = new Date(ms)
  return { y: d.getUTCFullYear(), mo: d.getUTCMonth() + 1, d: d.getUTCDate(), inDay: mod(ms, DAY) }
}

// Adds months to an instant, keeping the day of the month where it exists
// and taking the last day of the month otherwise (31 January + P1M = 28/29 February).
function addMonths(ms, months) {
  if (!months) return ms
  const f = fields(ms)
  const total = f.y * 12 + (f.mo - 1) + months
  const y = Math.floor(total / 12), mo = mod(total, 12) + 1
  return utc(y, mo, Math.min(f.d, daysInMonth(y, mo)), f.inDay)
}

function plusDuration(v, dur, sort, sign = 1) {
  if (sort === 'time') return { ms: T0 + mod(v.ms - T0 + sign * dur.seconds * 1000, DAY), tz: v.tz }
  let ms = addMonths(v.ms, sign * dur.months) + sign * dur.seconds * 1000
  if (sort === 'date') ms -= mod(ms, DAY)
  return Number.isFinite(ms) ? { ms, tz: v.tz } : undefined
}

// Difference of two instants as a day-time duration; undefined when only one
// has a timezone.
const minus = (a, b) => (a.tz !== b.tz ? undefined : { months: 0, seconds: (a.ms - b.ms) / 1000 })

function yearsBetween(a, b) {
  if (b.ms < a.ms) return -yearsBetween(b, a)
  const fa = fields(a.ms), fb = fields(b.ms)
  let y = fb.y - fa.y
  if (fb.mo < fa.mo || (fb.mo === fa.mo && (fb.d < fa.d || (fb.d === fa.d && fb.inDay < fa.inDay)))) y--
  return y
}

// ── Text forms (toText) ─────────────────────────────────────────────────────

const pad = (n, w = 2) => String(Math.abs(n)).padStart(w, '0')
const year = (y) => (y < 0 ? '-' : '') + pad(y, 4)
function timeText(inDay) {
  const s = inDay / 1000
  const h = Math.floor(s / 3600), mi = Math.floor((s % 3600) / 60), sec = s % 60
  const secText = Number.isInteger(sec) ? pad(sec) : (sec < 10 ? '0' : '') + String(Number(sec.toFixed(3)))
  return `${pad(h)}:${pad(mi)}:${secText}`
}
function durationText({ months, seconds }) {
  if (!months && !seconds) return 'PT0S'
  const neg = months < 0 || seconds < 0
  let m = Math.abs(months), s = Math.abs(seconds)
  const Y = Math.floor(m / 12), M = m % 12
  const D = Math.floor(s / 86400); s -= D * 86400
  const H = Math.floor(s / 3600); s -= H * 3600
  const Mi = Math.floor(s / 60); s = Number((s - Mi * 60).toFixed(3))
  let out = (neg ? '-' : '') + 'P' + (Y ? `${Y}Y` : '') + (M ? `${M}M` : '') + (D ? `${D}D` : '')
  if (H || Mi || s) out += 'T' + (H ? `${H}H` : '') + (Mi ? `${Mi}M` : '') + (s ? `${s}S` : '')
  return out
}

export function valueText(v, sort) {
  switch (sort) {
    case 'integer': case 'decimal': return String(v)
    case 'float': return Number.isNaN(v) ? 'NaN' : v === Infinity ? 'INF' : v === -Infinity ? '-INF' : String(v)
    case 'boolean': return v ? 'true' : 'false'
    case 'string': return v
    case 'date': { const f = fields(v.ms); return `${year(f.y)}-${pad(f.mo)}-${pad(f.d)}${v.tz ? 'Z' : ''}` }
    case 'datetime': { const f = fields(v.ms); return `${year(f.y)}-${pad(f.mo)}-${pad(f.d)}T${timeText(f.inDay)}${v.tz ? 'Z' : ''}` }
    case 'time': return timeText(mod(v.ms, DAY)) + (v.tz ? 'Z' : '')
    case 'duration': case 'yearMonthDuration': case 'dayTimeDuration': return durationText(v)
    default: return undefined
  }
}

// ── Catalogue ────────────────────────────────────────────────────────────────
//
// Each operator: label (for menus and messages), symbol and style ('infix',
// 'prefix' or 'func') for display, prec for infix operators, group for the
// editor's menu, sigs = [[paramSorts, resultSort], …] tried in order (a
// non-constant argument fits a parameter it widens to; a constant must parse
// under it), and ev(values, paramSorts, resultSort) → value | undefined.

const each = (sorts, f) => sorts.map(f)
const sameNum = () => each(NUM, s => [[s, s], s])
const MOMENTS = ['date', 'datetime']
const isDur = (s) => DUR.includes(s)
const TEXT_SORTS = [...NUM, 'boolean', 'string', 'date', 'datetime', 'time', ...DUR]
const ORDERED = [...NUM, 'string', 'date', 'datetime', 'time', 'yearMonthDuration', 'dayTimeDuration', 'gYear', 'gYearMonth']

export const OPS = {
  add: {
    label: 'plus', symbol: '+', style: 'infix', prec: 1, assoc: true, group: 'Numbers',
    sigs: [...sameNum(), ...each(DUR, d => [[d, d], d]),
      ...MOMENTS.flatMap(t => each(DUR, d => [[t, d], t])), [['time', 'dayTimeDuration'], 'time']],
    ev([a, b], [pa, pb], r) {
      if (r in RANK) return num(a + b, r)
      if (isDur(pa)) return { months: a.months + b.months, seconds: a.seconds + b.seconds }
      return plusDuration(a, b, r)
    },
  },
  sub: {
    label: 'minus', symbol: '−', style: 'infix', prec: 1, group: 'Numbers',
    sigs: [...sameNum(), ...each(DUR, d => [[d, d], d]),
      ...each([...MOMENTS, 'time'], t => [[t, t], 'dayTimeDuration']),
      ...MOMENTS.flatMap(t => each(DUR, d => [[t, d], t])), [['time', 'dayTimeDuration'], 'time']],
    ev([a, b], [pa, pb], r) {
      if (r in RANK) return num(a - b, r)
      if (isDur(pa)) return { months: a.months - b.months, seconds: a.seconds - b.seconds }
      if (pa === pb) return minus(a, b)
      return plusDuration(a, b, r, -1)
    },
  },
  mul: {
    label: 'times', symbol: '×', style: 'infix', prec: 2, assoc: true, group: 'Numbers',
    sigs: [...sameNum(), [['yearMonthDuration', 'decimal'], 'yearMonthDuration'], [['dayTimeDuration', 'decimal'], 'dayTimeDuration']],
    ev([a, b], [pa], r) {
      if (r in RANK) return num(a * b, r)
      if (pa === 'yearMonthDuration') return { months: roundHalfAway(a.months * b), seconds: 0 }
      return { months: 0, seconds: num(a.seconds * b, 'decimal') }
    },
  },
  div: {
    label: 'divided by', symbol: '÷', style: 'infix', prec: 2, group: 'Numbers',
    sigs: [[['decimal', 'decimal'], 'decimal'], [['float', 'float'], 'float'],
      [['yearMonthDuration', 'decimal'], 'yearMonthDuration'], [['dayTimeDuration', 'decimal'], 'dayTimeDuration'],
      [['yearMonthDuration', 'yearMonthDuration'], 'decimal'], [['dayTimeDuration', 'dayTimeDuration'], 'decimal']],
    ev([a, b], [pa, pb], r) {
      if (pa in RANK) return r === 'float' ? a / b : b === 0 ? undefined : num(a / b, r)
      if (!isDur(pb)) {
        if (b === 0) return undefined
        return pa === 'yearMonthDuration' ? { months: roundHalfAway(a.months / b), seconds: 0 }
          : { months: 0, seconds: num(a.seconds / b, 'decimal') }
      }
      const [x, y] = pa === 'yearMonthDuration' ? [a.months, b.months] : [a.seconds, b.seconds]
      return y === 0 ? undefined : num(x / y, 'decimal')
    },
  },
  idiv: {
    label: 'whole division', symbol: 'div', style: 'infix', prec: 2, group: 'Numbers',
    sigs: [[['integer', 'integer'], 'integer']],
    ev: ([a, b]) => (b === 0 ? undefined : num(Math.trunc(a / b), 'integer')),
  },
  mod: {
    label: 'remainder', symbol: 'mod', style: 'infix', prec: 2, group: 'Numbers',
    sigs: [[['integer', 'integer'], 'integer']],
    ev: ([a, b]) => (b === 0 ? undefined : a % b),
  },
  neg: {
    label: 'negation', symbol: '−', style: 'prefix', group: 'Numbers',
    sigs: [...each(NUM, s => [[s], s]), ...each(DUR, d => [[d], d])],
    ev: ([a], [p], r) => (r in RANK ? num(-a, r) : { months: -a.months, seconds: -a.seconds }),
  },
  abs: {
    label: 'abs', symbol: 'abs', style: 'func', group: 'Numbers',
    sigs: [...each(NUM, s => [[s], s]), ...each(['yearMonthDuration', 'dayTimeDuration'], d => [[d], d])],
    ev: ([a], [p], r) => (r in RANK ? num(Math.abs(a), r) : { months: Math.abs(a.months), seconds: Math.abs(a.seconds) }),
  },
  least: {
    label: 'least', symbol: 'least', style: 'func', group: 'Numbers',
    sigs: each(ORDERED, s => [[s, s], s]),
    ev: ([a, b], [p]) => { const c = VALUE_KINDS[p].compare(a, b); return Number.isNaN(c) ? undefined : c <= 0 ? a : b },
  },
  greatest: {
    label: 'greatest', symbol: 'greatest', style: 'func', group: 'Numbers',
    sigs: each(ORDERED, s => [[s, s], s]),
    ev: ([a, b], [p]) => { const c = VALUE_KINDS[p].compare(a, b); return Number.isNaN(c) ? undefined : c >= 0 ? a : b },
  },
  round: {
    label: 'round to n decimals', symbol: 'round', style: 'func', group: 'Numbers',
    sigs: [[['decimal', 'integer'], 'decimal'], [['float', 'integer'], 'float']],
    ev: ([a, n], [p], r) => (n < 0 || n > 15 ? undefined : num(roundHalfAway(a, n), r)),
  },
  floor: {
    label: 'floor', symbol: 'floor', style: 'func', group: 'Numbers',
    sigs: [[['integer'], 'integer'], [['decimal'], 'integer'], [['float'], 'float']],
    ev: ([a], [p], r) => num(Math.floor(a), r),
  },
  ceiling: {
    label: 'ceiling', symbol: 'ceiling', style: 'func', group: 'Numbers',
    sigs: [[['integer'], 'integer'], [['decimal'], 'integer'], [['float'], 'float']],
    ev: ([a], [p], r) => num(Math.ceil(a), r),
  },
  truncate: {
    label: 'truncate', symbol: 'truncate', style: 'func', group: 'Numbers',
    sigs: [[['integer'], 'integer'], [['decimal'], 'integer'], [['float'], 'float']],
    ev: ([a], [p], r) => num(Math.trunc(a), r),
  },
  power: {
    label: 'power', symbol: 'power', style: 'func', group: 'Numbers',
    sigs: [[['float', 'float'], 'float']],
    ev: ([a, b]) => a ** b,
  },
  sqrt: {
    label: 'square root', symbol: 'sqrt', style: 'func', group: 'Numbers',
    sigs: [[['float'], 'float']],
    ev: ([a]) => (a < 0 ? undefined : Math.sqrt(a)),
  },

  concat: {
    label: 'concatenation', symbol: '‖', style: 'infix', prec: 1, assoc: true, group: 'Text',
    sigs: [[['string', 'string'], 'string']],
    ev: ([a, b]) => a + b,
  },
  length: {
    label: 'length', symbol: 'length', style: 'func', group: 'Text',
    sigs: [[['string'], 'integer']],
    ev: ([a]) => [...a].length,
  },
  substring: {
    label: 'substring (start, length)', symbol: 'substring', style: 'func', group: 'Text',
    sigs: [[['string', 'integer', 'integer'], 'string']],
    ev([s, start, len]) {
      const cs = [...s]
      const from = Math.max(1, start), to = Math.max(from, start + len)
      return cs.slice(from - 1, to - 1).join('')
    },
  },
  upper: { label: 'upper case', symbol: 'upper', style: 'func', group: 'Text', sigs: [[['string'], 'string']], ev: ([a]) => a.toUpperCase() },
  lower: { label: 'lower case', symbol: 'lower', style: 'func', group: 'Text', sigs: [[['string'], 'string']], ev: ([a]) => a.toLowerCase() },
  trim:  { label: 'trim', symbol: 'trim', style: 'func', group: 'Text', sigs: [[['string'], 'string']], ev: ([a]) => a.trim() },
  toText: {
    label: 'as text', symbol: 'toText', style: 'func', group: 'Text',
    sigs: each(TEXT_SORTS, s => [[s], 'string']),
    ev: ([a], [p]) => valueText(a, p),
  },

  year: {
    label: 'year', symbol: 'year', style: 'func', group: 'Dates and times',
    sigs: each(['date', 'datetime', 'gYear', 'gYearMonth'], s => [[s], 'integer']),
    ev: ([a]) => fields(a.ms).y,
  },
  month: {
    label: 'month', symbol: 'month', style: 'func', group: 'Dates and times',
    sigs: each(['date', 'datetime', 'gYearMonth', 'gMonth', 'gMonthDay'], s => [[s], 'integer']),
    ev: ([a]) => fields(a.ms).mo,
  },
  day: {
    label: 'day of the month', symbol: 'day', style: 'func', group: 'Dates and times',
    sigs: each(['date', 'datetime', 'gMonthDay', 'gDay'], s => [[s], 'integer']),
    ev: ([a]) => fields(a.ms).d,
  },
  hour: {
    label: 'hour', symbol: 'hour', style: 'func', group: 'Dates and times',
    sigs: each(['datetime', 'time'], s => [[s], 'integer']),
    ev: ([a]) => Math.floor(mod(a.ms, DAY) / 3600000),
  },
  minute: {
    label: 'minute', symbol: 'minute', style: 'func', group: 'Dates and times',
    sigs: each(['datetime', 'time'], s => [[s], 'integer']),
    ev: ([a]) => Math.floor(mod(a.ms, 3600000) / 60000),
  },
  second: {
    label: 'second', symbol: 'second', style: 'func', group: 'Dates and times',
    sigs: each(['datetime', 'time'], s => [[s], 'decimal']),
    ev: ([a]) => num(mod(a.ms, 60000) / 1000, 'decimal'),
  },
  dayOfWeek: {
    label: 'day of the week (1 = Monday)', symbol: 'dayOfWeek', style: 'func', group: 'Dates and times',
    sigs: each(MOMENTS, s => [[s], 'integer']),
    ev: ([a]) => mod(new Date(a.ms).getUTCDay() + 6, 7) + 1,
  },
  yearsBetween: {
    label: 'whole years between', symbol: 'yearsBetween', style: 'func', group: 'Dates and times',
    sigs: each(MOMENTS, s => [[s, s], 'integer']),
    ev: ([a, b]) => (a.tz !== b.tz ? undefined : yearsBetween(a, b)),
  },
  makeDate: {
    label: 'date from year, month, day', symbol: 'makeDate', style: 'func', group: 'Dates and times',
    sigs: [[['integer', 'integer', 'integer'], 'date']],
    ev: ([y, m, d]) => (m < 1 || m > 12 || d < 1 || d > daysInMonth(y, m) ? undefined : { ms: utc(y, m, d), tz: false }),
  },
  dateOf: {
    label: 'date part', symbol: 'dateOf', style: 'func', group: 'Dates and times',
    sigs: [[['datetime'], 'date']],
    ev: ([a]) => ({ ms: a.ms - mod(a.ms, DAY), tz: a.tz }),
  },
  timeOf: {
    label: 'time part', symbol: 'timeOf', style: 'func', group: 'Dates and times',
    sigs: [[['datetime'], 'time']],
    ev: ([a]) => ({ ms: T0 + mod(a.ms, DAY), tz: a.tz }),
  },
  totalMonths: {
    label: 'in months', symbol: 'totalMonths', style: 'func', group: 'Durations',
    sigs: [[['yearMonthDuration'], 'integer']],
    ev: ([a]) => a.months,
  },
  totalDays: {
    label: 'in days', symbol: 'totalDays', style: 'func', group: 'Durations',
    sigs: [[['dayTimeDuration'], 'decimal']],
    ev: ([a]) => num(a.seconds / 86400, 'decimal'),
  },
  totalSeconds: {
    label: 'in seconds', symbol: 'totalSeconds', style: 'func', group: 'Durations',
    sigs: [[['dayTimeDuration'], 'decimal']],
    ev: ([a]) => num(a.seconds, 'decimal'),
  },
}

// Data predicates: atoms, rendered like functions.
export const PREDS = {
  startsWith: { label: 'starts with', symbol: 'startsWith', sigs: [[['string', 'string'], 'boolean']], ev: ([a, b]) => a.startsWith(b) },
  endsWith:   { label: 'ends with', symbol: 'endsWith', sigs: [[['string', 'string'], 'boolean']], ev: ([a, b]) => a.endsWith(b) },
  contains:   { label: 'contains', symbol: 'contains', sigs: [[['string', 'string'], 'boolean']], ev: ([a, b]) => a.includes(b) },
  matches: {
    label: 'matches the regular expression', symbol: 'matches', sigs: [[['string', 'string'], 'boolean']],
    ev([a, b]) { try { return new RegExp(b, 'u').test(a) } catch { return undefined } },
  },
}
for (const def of Object.values(PREDS)) def.style = 'func'

export const arity = (def) => def.sigs[0][0].length

// ── Typing ───────────────────────────────────────────────────────────────────
//
// typeComparison / typePredicate check an atom's terms and record, in
// tc.sorts, the sort of every term node and atom (null: a value without a
// datatype, compared as before datatypes had operators), and in tc.params the
// parameter sorts of the signature chosen for every operator. tc is
//   { sorts: Map, params: Map,
//     err(path, message),
//     varSort(id, path) → sort | null | FAIL   (reports its own errors)
//     formula(cond, path) }                    checks the condition of an if
// A rule is only evaluated or formalised when it typed without errors.

export const FAIL = Symbol('fail')
const DEFER = Symbol('defer')

const NO_DATATYPE = 'A value without a datatype cannot be used in a calculation; set the datatype of its value type'

function typeConst(n, path, tc, sort) {
  const text = String(n.text ?? '').trim()
  if (text === '') { tc.err(path, 'The constant is empty'); return FAIL }
  if (sort !== null) {
    const p = parseAs(text, sort)
    if (p.invalid) { tc.err(path, `${text} is not a valid ${VALUE_KINDS[sort]?.expect ?? sort}`); return FAIL }
  }
  tc.sorts.set(n, sort)
  return sort
}

// The sort of a term, or FAIL. Constants are typed by the caller once the
// sort of their place is known (DEFER), unless `expected` gives it.
function typeTerm(n, path, tc, expected) {
  switch (n?.t) {
    case undefined: case 'hole':
      tc.err(path, 'This part of the term is not filled in yet')
      return FAIL
    case 'var': {
      const s = tc.varSort(n.id, path)
      if (s !== FAIL) tc.sorts.set(n, s)
      return s
    }
    case 'const':
      return expected === undefined ? DEFER : typeConst(n, path, tc, expected)
    case 'op':
      return typeOp(OPS[n.op], n, path, tc)
    case 'if': {
      tc.formula(n.cond, [...path, 'cond'])
      const a = typeTerm(n.then, [...path, 'then'], tc)
      const b = typeTerm(n.else, [...path, 'else'], tc)
      if (a === FAIL || b === FAIL) return FAIL
      if (a === null || b === null) { tc.err(path, NO_DATATYPE); return FAIL }
      let s
      if (a === DEFER && b === DEFER) s = expected ?? guessSort(n.then.text)
      else if (a === DEFER) s = b
      else if (b === DEFER) s = a
      else {
        s = join(a, b)
        if (!s) { tc.err(path, `The two branches have different datatypes (${a} and ${b})`); return FAIL }
      }
      if (a === DEFER && typeConst(n.then, [...path, 'then'], tc, s) === FAIL) return FAIL
      if (b === DEFER && typeConst(n.else, [...path, 'else'], tc, s) === FAIL) return FAIL
      tc.sorts.set(n, s)
      return s
    }
    default:
      tc.err(path, 'Unknown kind of term')
      return FAIL
  }
}

function typeOp(def, n, path, tc) {
  if (!def) { tc.err(path, `Unknown operator ${n.op}`); return FAIL }
  const args = n.args ?? []
  if (args.length !== arity(def)) { tc.err(path, `${def.symbol} takes ${arity(def)} arguments`); return FAIL }
  const sorts = args.map((a, i) => typeTerm(a, [...path, 'args', i], tc))
  if (sorts.includes(FAIL)) return FAIL
  if (sorts.includes(null)) { tc.err(path, NO_DATATYPE); return FAIL }
  for (const a of args) {
    if (a.t === 'const' && String(a.text ?? '').trim() === '') { tc.err(path, 'A constant is empty'); return FAIL }
  }
  for (const [params, result] of def.sigs) {
    const ok = params.every((p, i) => (sorts[i] === DEFER ? !parseAs(args[i].text, p).invalid : fits(sorts[i], p)))
    if (!ok) continue
    args.forEach((a, i) => { if (sorts[i] === DEFER) tc.sorts.set(a, params[i]) })
    tc.sorts.set(n, result)
    tc.params.set(n, params)
    return result
  }
  const what = sorts.map((s, i) => (s === DEFER ? `the constant ${String(args[i].text).trim()}` : s))
  tc.err(path, `${def.symbol} cannot be applied to ${what.length > 1 ? `${what.slice(0, -1).join(', ')} and ${what[what.length - 1]}` : what[0]}`)
  return FAIL
}

// A value comparison atom; returns its sort, null (no datatype) or FAIL.
export function typeComparison(n, path, tc) {
  if (n.left?.t === 'const') {
    tc.err([...path, 'left'], 'The left side should not be a constant: swap the sides')
    return FAIL
  }
  const a = typeTerm(n.left, [...path, 'left'], tc)
  const b = typeTerm(n.right, [...path, 'right'], tc)
  if (a === FAIL || b === FAIL) return FAIL
  let s
  if (b === DEFER) {
    s = a
    if (typeConst(n.right, [...path, 'right'], tc, a) === FAIL) return FAIL
  } else if (a === null || b === null) {
    // Values without a datatype: compared as text or numbers, as before.
    if (n.left.t !== 'var' || n.right.t !== 'var') { tc.err(path, NO_DATATYPE); return FAIL }
    s = null
  } else {
    s = join(a, b)
    if (!s) { tc.err(path, `The values have different datatypes (${a} and ${b})`); return FAIL }
  }
  if (s && VALUE_KINDS[s]?.order === 'none' && n.op !== '≈' && n.op !== '≉') {
    tc.err(path, `${s} values have no order, so only ≈ and ≉ apply`)
    return FAIL
  }
  tc.sorts.set(n, s)
  return s
}

export function typePredicate(n, path, tc) {
  return typeOp(PREDS[n.op], n, path, tc)
}

// ── Evaluation ───────────────────────────────────────────────────────────────
//
// For a rule that typed without errors (sorts and params from its typing):
//   varValue(id)  → { value, raw } of the variable's data value, or undefined
//   holds(cond)   → truth of a condition
// A term without a value (an undefined operator result, or a missing value)
// makes the atom false.

function compareUnder(sort, a, b, op) {
  const kind = VALUE_KINDS[sort]
  const eq = kind.equal(a, b)
  const c = eq ? 0 : kind.compare(a, b)
  switch (op) {
    case '≈': return eq
    case '≉': return !eq
    case '<': return c < 0
    case '≤': return c <= 0
    case '>': return c > 0
    case '≥': return c >= 0
    default:  return false
  }
}

// Comparison of two strings without a datatype: as numbers when both are
// numbers, otherwise as text.
function compareRaw(a, b, op) {
  let x = a, y = b
  const na = Number(a), nb = Number(b)
  if (a !== '' && b !== '' && Number.isFinite(na) && Number.isFinite(nb)) { x = na; y = nb }
  const eq = x === y
  const c = eq ? 0 : x < y ? -1 : 1
  return compareUnder('integer', c, 0, op)
}

export function makeTermEvaluator({ sorts, params, varValue, holds }) {
  const value = (n) => {
    switch (n.t) {
      case 'var': return varValue(n.id)?.value
      case 'const': {
        const p = parseAs(n.text, sorts.get(n))
        return 'value' in p ? p.value : undefined
      }
      case 'op': {
        const vals = n.args.map(value)
        if (vals.some(v => v === undefined)) return undefined
        return OPS[n.op].ev(vals, params.get(n), sorts.get(n))
      }
      case 'if': return value(holds(n.cond) ? n.then : n.else)
      default: return undefined
    }
  }
  const raw = (n) => (n.t === 'var' ? varValue(n.id)?.raw : String(n.text ?? '').trim())
  return {
    value,
    compare(n) {
      const s = sorts.get(n)
      if (s == null) {
        const a = raw(n.left), b = raw(n.right)
        return a != null && b != null && compareRaw(a, b, n.op)
      }
      const a = value(n.left), b = value(n.right)
      return a !== undefined && b !== undefined && compareUnder(s, a, b, n.op)
    },
    predicate(n) {
      const vals = n.args.map(value)
      if (vals.some(v => v === undefined)) return false
      return PREDS[n.op].ev(vals, params.get(n)) === true
    },
  }
}

// ── Structure ────────────────────────────────────────────────────────────────

// Child term paths of a term node, relative to it.
export function termChildPaths(n) {
  switch (n?.t) {
    case 'op': case 'dpred': return (n.args ?? []).map((_, i) => ['args', i])
    case 'if': return [['then'], ['else']]
    case 'vcmp': return [['left'], ['right']]
    default: return []
  }
}

// The ids of the variables whose data values a term uses, outside the
// conditions of if-terms (which are formulas of their own).
export function termVarIds(n, out = []) {
  if (!n) return out
  if (n.t === 'var') { if (n.id != null && !out.includes(n.id)) out.push(n.id) }
  else for (const p of termChildPaths(n)) termVarIds(p.reduce((x, k) => x?.[k], n), out)
  return out
}

// The conditions of the if-terms in a term or atom, outermost first.
export function termConditions(n, out = []) {
  if (!n) return out
  if (n.t === 'if') out.push(n.cond)
  for (const p of termChildPaths(n)) termConditions(p.reduce((x, k) => x?.[k], n), out)
  return out
}
