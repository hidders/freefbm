// NORMA's date and time values, as written in value ranges of an .orm file.
//
// NORMA keeps a value range bound as the text the user typed (MinValue,
// MaxValue). Only the numeric data types are culture sensitive and also get
// an InvariantMinValue/InvariantMaxValue; date and time types do not
// (ORMModel/ObjectModel/DataTypesGenerator.cs: DateTemporalDataType and the
// others have no TryConvertToInvariant). NORMA checks such a bound with
// .NET's DateTime.TryParse in the user's current culture and compares bounds
// with DateTime.TryParse in the invariant culture, so a bound can be any text
// .NET reads as a date: "1900/01/01", "1/31/1900", "31 January 1900",
// "Monday, January 01, 1900", "1900-01-01 13:00", "1:30 PM", …
//
// FreeFBM writes dates and times as XML Schema does (YYYY-MM-DD, HH:MM[:SS],
// YYYY-MM-DDTHH:MM[:SS]). normaTemporal reads the forms .NET accepts in the
// invariant culture (month before day when the order is open, as NORMA's own
// comparison does) and gives the XML Schema form.

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july',
  'august', 'september', 'october', 'november', 'december']
const WEEKDAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday']

function monthOf(word) {
  const w = word.toLowerCase().replace(/\.$/, '')
  if (w.length < 3) return null
  const i = MONTHS.findIndex(m => m === w || (w.length === 3 && m.startsWith(w)) || (w === 'sept' && m === 'september'))
  return i < 0 ? null : i + 1
}

// .NET Framework's Gregorian calendar reads a two-digit year up to 29 as 20yy.
const fullYear = (s) => (s.length <= 2 ? (Number(s) <= 29 ? 2000 : 1900) + Number(s) : Number(s))

const pad = (n, w = 2) => String(n).padStart(w, '0')

function validDate(y, mo, d) {
  if (!(y >= 1 && y <= 9999) || mo < 1 || mo > 12 || d < 1) return false
  const last = new Date(0)
  last.setUTCFullYear(y, mo, 0)   // day 0 of the next month: the last of this one
  return d <= last.getUTCDate()
}

// The time part: "13:45", "13:45:30.5", "1:45 PM", "1 PM", with an optional
// "Z" or "+01:00". → { h, mi, s, tz } or null.
function readTime(text) {
  const m = /^(\d{1,2})(?::(\d{2}))?(?::(\d{2}(?:\.\d+)?))?\s*(am|pm|a\.m\.|p\.m\.)?\s*(z|[+-]\d{2}:?\d{2})?$/i.exec(text.trim())
  if (!m) return null
  let h = Number(m[1])
  const mi = m[2] === undefined ? 0 : Number(m[2]), s = m[3] === undefined ? 0 : Number(m[3])
  if (m[2] === undefined && !m[4]) return null   // a lone number is no time
  if (m[4]) {
    if (h < 1 || h > 12) return null
    const pm = /^p/i.test(m[4])
    h = h % 12 + (pm ? 12 : 0)
  }
  if (h > 23 || mi > 59 || s >= 60) return null
  let tz = m[5] ? m[5].toUpperCase() : undefined
  if (tz && tz !== 'Z' && !tz.includes(':')) tz = `${tz.slice(0, 3)}:${tz.slice(3)}`
  return { h, mi, s, tz }
}

// The date part. → { y, mo, d, ambiguous } or null; ambiguous when day and
// month could be swapped (read month first, as the invariant culture does).
function readDate(text) {
  let t = text.trim().replace(/,/g, ' ').replace(/\s+/g, ' ')
  // a leading weekday ("Monday, January 01, 1900")
  const first = t.split(' ')[0].toLowerCase()
  if (WEEKDAYS.some(w => w === first || (first.length === 3 && w.startsWith(first)))) t = t.slice(first.length).trim()
  let m
  // year first: 1900-01-01, 1900/1/1, 1900.01.01
  if ((m = /^(\d{4})([-/.])(\d{1,2})\2(\d{1,2})$/.exec(t))) return { y: +m[1], mo: +m[3], d: +m[4] }
  // numeric with the year last: month first (invariant), else day first
  if ((m = /^(\d{1,2})([-/.])(\d{1,2})\2(\d{4}|\d{2})$/.exec(t))) {
    const a = +m[1], b = +m[3], y = fullYear(m[4])
    if (a <= 12) return { y, mo: a, d: b, ambiguous: b <= 12 && a !== b }
    return { y, mo: b, d: a }
  }
  // with a month name: "January 1 1900", "1 January 1900", "1-Jan-1900",
  // "1900 January 1"
  const parts = t.split(/[ \-/]/).filter(Boolean)
  if (parts.length === 3) {
    const [p, q, r] = parts
    let mo
    if ((mo = monthOf(p)) && /^\d{1,2}$/.test(q) && /^\d{2,4}$/.test(r)) return { y: fullYear(r), mo, d: +q }
    if ((mo = monthOf(q)) && /^\d{1,2}$/.test(p) && /^\d{2,4}$/.test(r)) return { y: fullYear(r), mo, d: +p }
    if ((mo = monthOf(q)) && /^\d{4}$/.test(p) && /^\d{1,2}$/.test(r)) return { y: +p, mo, d: +r }
  }
  return null
}

// Splits "1900/01/01 13:45" or "1900-01-01T13:45" into a date and a time.
function splitDateTime(text) {
  const t = text.trim()
  const iso = /^(\d{4}-\d{1,2}-\d{1,2})T(.+)$/i.exec(t)
  if (iso) return { date: readDate(iso[1]), time: readTime(iso[2]) || 'bad' }
  // the time starts at the first h:mm, or at "h AM"
  const m = /\s(\d{1,2}(?::\d{2}|\s*(?:am|pm)\b).*)$/i.exec(t)
  if (m) return { date: readDate(t.slice(0, m.index)), time: readTime(m[1]) || 'bad' }
  return { date: readDate(t), time: null }
}

const timeText = ({ h, mi, s, tz }) =>
  `${pad(h)}:${pad(mi)}${s ? `:${s < 10 ? '0' : ''}${s}` : ''}${tz ?? ''}`

// A NORMA date/time text as FreeFBM writes it for kind 'date', 'time' or
// 'datetime': { text, ambiguous } or null when it is not read as one.
export function normaTemporal(raw, kind) {
  const str = String(raw ?? '').trim()
  if (!str) return null
  if (kind === 'time') {
    const tm = readTime(str)
    return tm ? { text: timeText(tm) } : null
  }
  const { date, time } = splitDateTime(str)
  if (!date || time === 'bad' || !validDate(date.y, date.mo, date.d)) return null
  const day = `${pad(date.y, 4)}-${pad(date.mo)}-${pad(date.d)}`
  const ambiguous = !!date.ambiguous
  if (kind === 'date') {
    // a date with a time other than midnight is no plain date
    if (time && (time.h || time.mi || time.s)) return null
    return { text: day + (time?.tz ?? ''), ambiguous }
  }
  if (kind === 'datetime') return { text: `${day}T${timeText(time ?? { h: 0, mi: 0, s: 0 })}`, ambiguous }
  return null
}
