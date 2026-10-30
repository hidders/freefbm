// The English library: morphology, structural tests and phrase builders for
// the rules in english.vr, which follow NORMA's wording where it has one
// ("Each … at most one …", "For each …, …", "at most one of the following
// holds"). The language itself is english.vr compiled against this library
// (see index.js and rules.js).

import { isVar } from '../match.js'
import {
  occurs, rangeSpec, exclusionItems, exclusiveOrItems, sameUpToWild, distributable, isComplex, isSingular, subjectOf,
} from '../structure.js'
import { tok, seq } from '../engine.js'
import { OPS, PREDS, AGGS } from '../../logic/dataOperators.js'

const kw = (s) => tok(s, 'kw')
const punct = (s) => tok(s, 'punct')

// ── Morphology ───────────────────────────────────────────────────────────────

const NUMBER_WORDS = { 1: 'one' }
const number = (n) => tok(NUMBER_WORDS[n] ?? String(n), 'kw')

// Plural of a name, keeping a trailing subscript: Course₂ → Courses₂.
export function plural(name) {
  const m = /^(.*?)([₀-₉]*)$/u.exec(name)
  const [base, sub] = [m[1], m[2]]
  const p = /(s|x|z|ch|sh)$/i.test(base) ? base + 'es'
    : /[^aeiou]y$/i.test(base) ? base.slice(0, -1) + 'ies'
    : base + 's'
  return p + sub
}

const article = (word) => (/^[aeiou]/i.test(word) ? 'an' : 'a')

// "who" for types declared personal, else "that".
const relPron = (h, v) => kw(h.objectType(v)?.isPersonal ? 'who' : 'that')

// A, B and C
export function joinList(items, conj) {
  const out = []
  items.forEach((it, i) => {
    if (i > 0) out.push(i === items.length - 1 ? kw(conj) : punct(','))
    out.push(it)
  })
  return out
}

// Joins phrases with a connective; null if any is null.
export function joinPhrases(parts, conj) {
  if (parts.some(p => p === null)) return null
  return parts.flatMap((p, i) => (i ? [kw(conj), p] : [p]))
}

const names = (h, vars) => joinList(vars.map(v => tok(h.name(v), 'type')), 'and')

// at most one / at least 2 / exactly one / at least 2 and at most 5
function quantifier(op, n, m) {
  if (op === '..') return [kw('at least'), number(n), kw('and at most'), number(m)]
  return [kw({ '≤': 'at most', '≥': 'at least', '=': 'exactly', '>': 'more than' }[op] ?? op), number(n)]
}

// "at most one Course", "at most 6 Courses"
function quantifiedNP(h, op, n, m, v) {
  const name = h.name(v)
  return [quantifier(op, n, m), tok(isSingular(op, n) ? name : h.plural(v), 'type')]
}

// Verb forms. Readings are written in the third person singular ("enrols
// in", "is worth"); env.verb asks for another form of their first word:
//   plural   "enrol in", "are worth"
//   negated  "does not enrol in", "is not worth"
// Returns null when the word is not a verb form the rules know, such as a
// past tense, so the caller falls back to another wording.
const AUXILIARIES = new Set(['is', 'was', 'can', 'could', 'will', 'would', 'may', 'might', 'must', 'shall', 'should'])
const PLURAL_AUX = { is: 'are', was: 'were' }

function baseVerb(w) {
  if (w === 'has') return 'have'
  if (w === 'does') return 'do'
  if (/[^aeiou]ies$/.test(w)) return w.slice(0, -3) + 'y'
  if (/(ss|sh|ch|x|z|o)es$/.test(w)) return w.slice(0, -2)
  if (/[^su]s$/.test(w)) return w.slice(0, -1)
  return null
}

export function inflect(text, form) {
  if (!form) return text
  const [, w, rest] = /^(\S+)(.*)$/s.exec(text) ?? [null, text, '']
  const lower = w.toLowerCase()
  if (form === 'plural') {
    if (AUXILIARIES.has(lower)) return (PLURAL_AUX[lower] ?? w) + rest
    return (baseVerb(lower) ?? w) + rest
  }
  if (form === 'negated') {
    if (lower === 'can') return 'cannot' + rest
    if (AUXILIARIES.has(lower)) return `${w} not${rest}`
    const base = baseVerb(lower)
    return base ? `does not ${base}${rest}` : null
  }
  return null
}

const verb = (h, text) => {
  const t = inflect(text, h.env.verb)
  return t === null ? null : kw(t)
}

const VALUE_OPS = { '≈': 'is', '≉': 'is not', '<': 'is less than', '≤': 'is at most', '>': 'is more than', '≥': 'is at least' }

// ── Structural tests ─────────────────────────────────────────────────────────

// The value range ∀x (x ≈ c ∨ (x ≥ a ∧ x ≤ b) ∨ …) as its listed items, or null.
// An interval with an open (exclusive) bound is said with both bounds: "more
// than 0 and at most 100".
const RANGE_BOUND = { '≥': 'at least', '≤': 'at most', '>': 'more than', '<': 'less than' }
function rangeItems(h, body, x) {
  const spec = rangeSpec(body, x)
  return spec && spec.map(i => i.op === '..'
    ? (i.loOp === '≥' && i.hiOp === '≤' ? [h.term(i.lo), kw('to'), h.term(i.hi)]
      : [kw(RANGE_BOUND[i.loOp]), h.term(i.lo), kw('and'), kw(RANGE_BOUND[i.hiOp]), h.term(i.hi)])
    : i.op === '≈' ? [h.term(i.value)] : [kw(RANGE_BOUND[i.op]), h.term(i.value)])
}

// ── Phrases built from parts ─────────────────────────────────────────────────

// A relative clause about x: "that has some Email", "who enrols in some
// Course", or with x as the object, "that some AcademicYear starts in".
// extra (say { verb: 'plural' }) applies to a verb phrase about x.
function relative(h, a, x, extra) {
  const r = relativeBody(h, a, x, extra)
  if (r) return [relPron(h, x), r]
  const c = h.clause(a)
  return c && [kw('such that'), c]
}

// The relative clause without its pronoun, or null when x is neither the
// subject of a verb phrase nor a single slot of a fact atom.
function relativeBody(h, a, x, extra) {
  const vp = h.vp(a, x, extra)
  if (vp) return vp
  if (a.t === 'fact' && a.args.filter(z => z === x).length === 1)
    return h.reading(a, undefined, new Map([[x, []]]))
  return null
}

// A noun phrase np for y followed by relative clauses for the conjuncts
// about it: "some Offering that involves Course and involves some Term",
// "some Course that Staff coordinates". Conjuncts without one, such as a
// comparison of a value computed from y, come last as "such that …".
function withRelatives(h, np, y, conj, extra) {
  if (!conj.length) return np
  const vps = conj.map(a => h.vp(a, y, extra))
  if (vps.every(Boolean)) return [np, relPron(h, y), joinPhrases(vps, 'and')]
  const parts = conj.map(a => relativeBody(h, a, y, extra))
  const rel = parts.filter(Boolean).flatMap((p, i) => [i ? kw('and') : [], relPron(h, y), p])
  const other = conj.filter((a, i) => !parts[i])
  if (!other.length) return [np, rel]
  const cl = joinPhrases(other.map(a => h.clause(a)), 'and')
  return cl && [np, rel, rel.length ? kw('and') : [], kw('such that'), cl]
}

// "exactly one of the following holds: that Staff is a Professor; …"
function clauseList(h, intro, items) {
  const parts = items.map(it => h.clause(it))
  if (parts.some(p => !p)) return null
  return [kw(intro), punct(':'), parts.flatMap((p, i) => (i ? [punct(';'), p] : [p]))]
}

// A verb phrase about x from a fact atom in which a quantified y is the
// object, the y filled in by np: "has at most one PersonName".
// With more conjuncts about y they become a relative clause on y:
// "teaches some Offering that involves Course".
function objectQuantified(h, x, y, body, np) {
  const conj = body.t === 'and' ? body.args : [body]
  const anchor = conj.find(a => a.t === 'fact' && a.args.includes(x) && a.args.includes(y) &&
    a.args.filter(z => z === y).length === 1)
  if (!anchor) return null
  const fill = withRelatives(h, np, y, conj.filter(a => a !== anchor))
  return fill && h.reading(anchor, x, new Map([[y, fill]]))
}

// The same for a clause: y's quantified noun phrase sits in some atom that
// also mentions an introduced variable, the other conjuncts about y become a
// relative clause.
function anchoredClause(h, y, body, np) {
  const conj = body.t === 'and' ? body.args : [body]
  for (const anchor of conj) {
    if (anchor.t !== 'fact' || anchor.args.filter(z => z === y).length !== 1) continue
    if (!anchor.args.some(a => a !== y && (isVar(a)))) continue
    const fill = withRelatives(h, np, y, conj.filter(a => a !== anchor))
    if (!fill) continue
    const r = h.reading(anchor, undefined, new Map([[y, fill]]))
    if (r) return r
  }
  return null
}

// ── Library ──────────────────────────────────────────────────────────────────
//
// The functions the rules in english.vr call: structural tests (guards) and
// phrase builders (templates). Each takes the phrase helpers h first.


const predicateLabel = (f) => PREDS[f.op]?.label ?? f.op

const functions = {
  // Guards
  rangeItems: (h, body, x) => rangeItems(h, body, x),
  exclusionItems: (h, f) => exclusionItems(f),
  exclusiveOrItems: (h, f) => exclusiveOrItems(f),
  sameUpToWild: (h, a, b, ys) => sameUpToWild(a, b, ys),
  distributable: (h, ys, args, x) => distributable(ys, args, x),
  isComplex: (h, f) => isComplex(f),
  isVar: (h, x) => isVar(x),
  // Every variable of vs occurs in f.
  occursAll: (h, f, vs) => vs.every(v => occurs(f, v)),
  singular: (h, q) => isSingular(q.op, q.n),
  wildCount: (h, f) => f.args.filter(a => a?.t === 'wild').length,
  subjectOf: (h, f) => subjectOf(f),

  // Phrases
  names: (h, vs) => names(h, vs),
  relPron: (h, v) => relPron(h, v),
  relative: (h, a, x, extra) => relative(h, a, x, extra),
  relativeBody: (h, a, x, extra) => relativeBody(h, a, x, extra),
  clauseList: (h, intro, items) => clauseList(h, intro, items),
  objectQuantified: (h, x, y, body, np) => objectQuantified(h, x, y, body, np),
  anchoredClause: (h, y, body, np) => anchoredClause(h, y, body, np),
  quantNP: (h, q, y) => quantifiedNP(h, q.op, q.n, q.m, y),
  quantifier: (h, q) => quantifier(q.op, q.n, q.m),
  verb: (h, text) => verb(h, text),
  // a, b, c
  commaList: (h, items) => items.flatMap((it, i) => (i ? [punct(','), it] : [it])),
  // The phrases of the formulas, joined by a connective.
  clauses: (h, fs, conj) => joinPhrases(fs.map(f => h.clause(f)), conj),
  vps: (h, fs, x, conj) => joinPhrases(fs.map(f => h.vp(f, x)), conj),
  // some A and some B
  someList: (h, ys) => joinList(ys.map(y => [kw('some'), tok(h.name(y), 'type')]), 'and'),
  // Course, Courses, combination of A and B, combinations of A and B
  countedNP: (h, q, ys) => {
    const one = isSingular(q.op, q.n)
    return ys.length === 1
      ? tok(one ? h.name(ys[0]) : h.plural(ys[0]), 'type')
      : [kw(one ? 'combination of' : 'combinations of'), names(h, ys)]
  },
  // "Course₁ is not a prerequisite for Course₃": ¬A as its subject and the
  // negated verb phrase; null when A has no subject.
  negatedClause: (h, a) => {
    let x
    if (a.t === 'exists') x = a.vars.length === 1 && a.body.t === 'fact' ? a.body.args.find(z => isVar(z) && z !== a.vars[0]) : null
    else x = a.t === 'type' ? a.arg : a.args.find(isVar)
    return x ? seq(h.ref(x), h.vp(a, x, { verb: 'negated' })) : null
  },
  // is a Professor, is not a Professor, are Professors
  isA: (h, T) => {
    const name = h.typeLabel(T)
    if (h.env.verb === 'plural') return [kw('are'), tok(h.typePlural(T), 'type')]
    return seq(verb(h, 'is'), kw(article(name)), tok(name, 'type'))
  },
  // The words of a value comparison, inflected in a verb phrase.
  valueOp: (h, op, inVP) => (VALUE_OPS[op] ? (inVP ? verb(h, VALUE_OPS[op]) : kw(VALUE_OPS[op])) : kw(op)),
  predicateLabel: (h, f) => kw(predicateLabel(f)),
  dataPredicate: (h, f) => f.args.length === 2
    ? [h.term(f.args[0]), kw(predicateLabel(f)), h.term(f.args[1])]
    : [kw(predicateLabel(f)), punct('('), joinList(f.args.map(a => h.term(a)), 'and'), punct(')'), kw('holds')],
  closure: (h, f) => seq(h.ref(f.args[0]), kw('is linked to'), h.ref(f.args[1]),
    kw(f.star ? 'by zero or more steps, each from some' : 'by one or more steps, each from some'),
    tok(h.name(f.vars[0]), 'type'), kw('to some'), tok(h.name(f.vars[1]), 'type'), kw('such that'),
    h.clause(f.body)),
  // [TC_{v,w} R(v, w)](x, t): "is a prerequisite for t, directly or indirectly"
  directlyOrIndirectly: (h, f, x, t) => {
    const [v, w] = f.vars
    const sub = (a) => (a === v ? x : a === w ? t : a)
    const r = h.reading({ ...f.body, args: f.body.args.map(sub) }, x)
    return seq(r, punct(','), kw('directly or indirectly'),
      f.star ? [kw('or is'), t === x ? kw('itself') : h.ref(t)] : [])
  },
  // "is in exactly one Building and has exactly one RoomNr"
  exactlyOneEach: (h, ys, args, x) => joinPhrases(ys.map(y => h.vp({ t: 'count', op: '=', n: 1, vars: [y],
    body: args.find(a => occurs(a, y)) }, x)), 'and'),
  unknownNode: (h, f) => kw(`(${f?.t ?? '?'})`),
}

// ── Terms and noun phrases ───────────────────────────────────────────────────

function term(h, t) {
  if (isVar(t) || t?.t === 'wild') return h.ref(t)
  switch (t?.t) {
    case 'const':
      return tok(t.quoted ? `'${t.text}'` : t.text, 'const')
    case 'fn':
      return operation(h, t)
    case 'ite':
      return seq(punct('('), kw('if'), h.clause(t.cond), kw('then'), term(h, t.then), kw('else'), term(h, t.else), punct(')'))
    case 'agg':
      return aggregate(h, t)
    default:
      return kw('?')
  }
}

// Data operators: {0}, {1}, … are the arguments. Operators without an
// entry read "the <label> of a and b".
const OPERATION = {
  add: '{0} plus {1}', sub: '{0} minus {1}', mul: '{0} times {1}', div: '{0} divided by {1}',
  idiv: 'the whole number of times {1} goes into {0}', mod: 'the remainder of {0} divided by {1}',
  neg: 'minus {0}', abs: 'the absolute value of {0}',
  least: 'the least of {0} and {1}', greatest: 'the greatest of {0} and {1}',
  round: '{0} rounded to {1} decimals', roundInt: '{0} rounded to a whole number',
  floor: '{0} rounded down', ceiling: '{0} rounded up', truncate: '{0} truncated',
  power: '{0} to the power {1}', sqrt: 'the square root of {0}',
  concat: '{0} followed by {1}', length: 'the length of {0}',
  substring: 'the part of {0} of length {2} from position {1}',
  upper: '{0} in upper case', lower: '{0} in lower case', trim: '{0} without leading and trailing spaces',
  toText: '{0} as text',
  year: 'the year of {0}', month: 'the month of {0}', day: 'the day of the month of {0}',
  hour: 'the hour of {0}', minute: 'the minute of {0}', second: 'the second of {0}',
  dayOfWeek: 'the day of the week of {0}', yearsBetween: 'the number of whole years from {0} to {1}',
  makeDate: 'the date with year {0}, month {1} and day {2}',
  dateOf: 'the date of {0}', timeOf: 'the time of day of {0}',
  totalMonths: '{0} in months', totalDays: '{0} in days', totalSeconds: '{0} in seconds',
}

// An argument that is itself an infix operation is put in brackets when it
// binds less tightly: "(Credits plus 5) times 2". table maps operators to
// patterns; others read as fallback(label) followed by the arguments.
export function operation(h, t, table = OPERATION, fallback = (label) => `the ${label} of`, and = 'and') {
  const def = OPS[t.op]
  const arg = (a, i) => {
    const inner = a?.t === 'fn' ? OPS[a.op] : null
    const loose = def?.style === 'infix' && inner?.style === 'infix' &&
      (inner.prec < def.prec || (inner.prec === def.prec && (i > 0 || a.op !== t.op) && !(def.assoc && a.op === t.op)))
    return loose ? [punct('('), h.term(a), punct(')')] : h.term(a)
  }
  const pattern = table[t.op]
  if (!pattern) return [kw(fallback(def?.label ?? t.op)), joinList(t.args.map(a => h.term(a)), and)]
  return pattern.split(/(\{\d\})/).filter(Boolean).map(part => {
    const m = /^\{(\d)\}$/.exec(part)
    if (m) return arg(t.args[Number(m[1])], Number(m[1]))
    const [, comma, words] = /^\s*(,?)\s*(.*?)\s*$/.exec(part)
    return [comma ? punct(',') : [], words ? kw(words) : []]
  })
}

// Aggregates as noun phrases.
//   Count{y : φ}           the number of Students who enrol in Course
//   F{y | y : φ}           the sum of all Credits that …
//   F{k | c, k : φ ∧ R(c, k)}
//                          the sum of the Credits that each Course that
//                          Student enrols in is worth
// and otherwise "the F of t over all combinations of … such that …".
function aggregate(h, t) {
  const label = AGGS[t.fn]?.label ?? t.fn
  const distinct = t.distinct ? [kw('distinct')] : []
  const conj = t.cond?.t === 'and' ? t.cond.args : t.cond?.t === 'true' ? [] : [t.cond]
  const rels = (y, atoms) => withRelatives(h, [], y, atoms, { verb: 'plural' })
  if (t.vars.length === 1) {
    const y = t.vars[0]
    if (!t.term || t.term === y) {
      const r = rels(y, conj)
      if (r) return [kw(t.term ? `the ${label} of all` : 'the number of'), distinct, tok(h.plural(y), 'type'), r]
    }
  }
  if (t.vars.length === 2 && t.term && t.vars.includes(t.term)) {
    const k = t.term, c = t.vars.find(v => v !== k)
    const link = conj.find(a => a.t === 'fact' && a.args.length === 2 && a.args.includes(c) && a.args.includes(k))
    const restC = conj.filter(a => a !== link)
    if (link && restC.every(a => !occurs(a, k))) {
      const cNP = withRelatives(h, [kw('each'), tok(h.name(c), 'type')], c, restC)
      const r = cNP && h.reading(link, undefined, new Map([[k, []], [c, cNP]]))
      if (r) return [kw(`the ${label} of`), distinct, kw('the'), tok(h.name(k), 'type'), relPron(h, k), r]
    }
  }
  const what = t.vars.length === 1 ? tok(h.plural(t.vars[0]), 'type') : [kw('combinations of'), names(h, t.vars)]
  if (!t.term) return seq(kw('the number of'), distinct, what, kw('such that'), h.clause(t.cond))
  return seq(kw(`the ${label} of`), distinct, term(h, t.term), kw('over all'), what, kw('such that'), h.clause(t.cond))
}

// The English library: everything but the rules, which are in english.vr.
export const englishLibrary = {
  id: 'en',
  label: 'English',
  functions,
  term,
  // "that Course", or "Course" in an If … then … sentence.
  // "the same Email" for the variables in env.same (negative.js).
  refNP: (h, v) => (h.env.same?.includes(v) ? [kw('the same'), tok(h.name(v), 'type')] : h.env.refStyle === 'bare' ? tok(h.name(v), 'type') : [kw('that'), tok(h.name(v), 'type')]),
  // A wildcard: "some Course", "any Course" after "No" or a negated verb,
  // or "no Course" in a negated atom (env.none).
  wildNP: (h, w) => [kw(h.env.none ? 'no' : h.env.negative || h.env.verb === 'negated' ? 'any' : 'some'), tok(h.name(w), 'type')],
  verbForm: (h, text) => inflect(text, h.env.verb),
  pluralise: (name) => plural(name),
  reflexive: (h, v) => kw(h.objectType(v)?.isPersonal ? 'themselves' : 'itself'),
}
