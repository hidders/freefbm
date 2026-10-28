// The Dutch library: morphology, word order and phrase builders for the
// rules in dutch.vr.
//
// Word order is a property of the environment, env.form:
//   (none)  main clause, verb second       Student volgt Course
//   'sub'   subordinate, verb last         … dat Student Course volgt
//   'inv'   inverted, verb first           dan volgt Student Course
// Readings are written in main-clause order. A reading's subordinate form
// comes from the lexicon (subParts), else the finite verb, the first word
// after the subject, moves to the end: "Course is Credits waard" becomes
// "… Course Credits waard is". Inversion puts that verb before the subject.
// Gender ('de' or 'het', from the lexicon, 'de' by default) chooses elke/elk
// and die/dat.

import { isVar } from '../match.js'
import { rangeSpec, exclusionItems, exclusiveOrItems, sameUpToWild, distributable, isComplex, isSingular, subjectOf, occurs } from '../structure.js'
import { tok, seq } from '../engine.js'
import { joinList, joinPhrases, operation } from './english.js'
import { AGGS } from '../../logic/dataOperators.js'

const kw = (s) => tok(s, 'kw')
const punct = (s) => tok(s, 'punct')
const hasText = (parts) => Array.isArray(parts) && parts.some(p => p?.trim())

// ── Morphology ───────────────────────────────────────────────────────────────

const number = (n) => kw(n === 1 ? 'één' : String(n))

// Plural of a name: -s after an unstressed ending, -'s after another vowel,
// else -en with a long vowel written single (Student → Studenten, Course →
// Courses, Gebouw → Gebouwen, Jaar → Jaren). Stress is unknown, so
// "Kat → Katten" needs the lexicon.
export function pluralise(name) {
  if (/(e|el|em|en|er|je)$/i.test(name)) return `${name}s`
  if (/[aiouy]$/i.test(name)) return `${name}'s`
  return name.replace(/(a|e|o|u)\1([^aeiou])$/i, '$1$2') + 'en'
}

const IRREGULAR_PLURAL = { is: 'zijn', heeft: 'hebben', kan: 'kunnen', wil: 'willen', mag: 'mogen', zal: 'zullen', moet: 'moeten', wordt: 'worden', was: 'waren', had: 'hadden' }

// The plural of a finite verb in the present: volgt → volgen, coördineert →
// coördineren, neemt → nemen, leeft → leven; null when it is not a form the
// rules know.
export function pluralVerb(w) {
  const lower = w.toLowerCase()
  if (IRREGULAR_PLURAL[lower]) return IRREGULAR_PLURAL[lower]
  if (!/t$/.test(lower) || lower.length < 3) return null
  let stem = lower.slice(0, -1)
  if (/(aa|ee|oo|uu)[^aeiou]$/.test(stem)) stem = stem.replace(/(a|e|o|u)\1([^aeiou])$/, '$1$2')
  else if (/[^aeiou][aeiou]([bdgklmnprt])$/.test(stem) && !/[ée]r$/.test(stem) && stem.length <= 4) stem = stem + stem.slice(-1)
  stem = stem.replace(/f$/, 'v').replace(/s$/, 'z')
  return stem + 'en'
}

const article = () => kw('een')
const every = (h, v) => kw(h.gender(v) === 'het' ? 'elk' : 'elke')
const demonstrative = (h, v) => kw(h.gender(v) === 'het' ? 'dat' : 'die')
const relPron = (h, v, plural) => kw(!plural && h.gender(v) === 'het' ? 'dat' : 'die')

function quantifier(op, n, m) {
  if (op === '..') return [kw('minstens'), number(n), kw('en hoogstens'), number(m)]
  return [kw({ '≤': 'hoogstens', '≥': 'minstens', '=': 'precies' }[op] ?? op), number(n)]
}

function quantifiedNP(h, op, n, m, v) {
  return [quantifier(op, n, m), tok(isSingular(op, n) ? h.name(v) : h.plural(v), 'type')]
}

const names = (h, vars) => joinList(vars.map(v => tok(h.name(v), 'type')), 'en')

// ── Readings and word order ──────────────────────────────────────────────────

const splitFirst = (text) => {
  const m = /^\s*(\S+)\s*(.*)$/s.exec(text ?? '')
  return m ? [m[1], m[2]] : ['', '']
}

// The parts of a reading for the environment: plural verb, then word order.
export function shapeReading(h, pick, elided) {
  const plural = h.env.verb === 'plural'
  const form = h.env.form
  const verbFirst = !pick.parts[0]?.trim() && pick.parts[1]?.trim()
  if (form === 'inv' && (elided || !verbFirst)) return null
  let parts = pick.parts
  let finite = verbFirst ? splitFirst(parts[1])[0] : null
  if (plural) {
    if (hasText(pick.pluralParts)) {
      parts = pick.pluralParts
      finite = splitFirst(parts[1])[0]
    } else if (verbFirst) {
      const pv = pluralVerb(finite)
      if (!pv) return null
      parts = [parts[0], [pv, splitFirst(parts[1])[1]].filter(Boolean).join(' '), ...parts.slice(2)]
      finite = pv
    } else return null
  }
  if (form === 'sub') {
    if (hasText(pick.subParts)) {
      if (!plural) return pick.subParts
      // The singular finite verb in the subordinate form becomes plural.
      const singular = splitFirst(pick.parts[1])[0]
      return pick.subParts.map(p => (p ?? '').split(/(\s+)/).map(w => (w === singular ? finite : w)).join(''))
    }
    if (!finite) return parts
    const n = parts.length - 1
    const out = [...parts]
    out[1] = splitFirst(parts[1])[1]
    out[n] = [out[n]?.trim(), finite].filter(Boolean).join(' ')
    return out
  }
  if (form === 'inv') {
    const [verb, rest] = splitFirst(parts[1])
    return [verb, rest, ...parts.slice(2)]
  }
  return parts
}

// ── Phrases built from parts ─────────────────────────────────────────────────

const PREPOSITIONS = new Set(['aan', 'bij', 'door', 'in', 'met', 'naar', 'om', 'op', 'over', 'tot', 'uit', 'van', 'voor'])

// A relative clause on x, in subordinate order, as { pron, body }: "die" +
// "een Vak volgt", or with x as the object, "dat" + "een Student volgt". A
// preposition before the gap joins the pronoun: "waarin" + "een Studiejaar
// begint". null when x is neither the subject of a verb phrase nor a single
// slot of a fact atom.
function relativeParts(h, a, x, extra) {
  const plural = extra?.verb === 'plural'
  const vp = h.vp(a, x, { ...extra, form: 'sub' })
  if (vp) return { pron: relPron(h, x, plural), body: vp }
  if (a.t !== 'fact' || a.args.filter(z => z === x).length !== 1) return null
  const gap = { text: '', cls: 'gap' }
  const body = h.with({ form: 'sub', verb: undefined }).reading(a, undefined, new Map([[x, gap]]))
  if (!body) return null
  const i = body.indexOf(gap)
  const before = body[i - 1]
  const m = before?.cls === 'reading' ? /^(.*?)\s*(\S+)$/.exec(before.text) : null
  if (m && PREPOSITIONS.has(m[2].toLowerCase())) {
    const out = [...body]
    out[i - 1] = tok(m[1], 'reading')
    return { pron: kw(`waar${m[2].toLowerCase()}`), body: out }
  }
  return { pron: relPron(h, x, plural), body }
}

function relativeBody(h, a, x, extra) {
  const r = relativeParts(h, a, x, extra)
  return r && [r.pron, r.body]
}

function relative(h, a, x, extra) {
  const r = relativeParts(h, a, x, extra)
  if (r) return [r.pron, r.body]
  const c = h.clause(a, { form: 'sub' })
  return c && [kw('zodanig dat'), c]
}

function withRelatives(h, np, y, conj, extra) {
  if (!conj.length) return np
  const plural = extra?.verb === 'plural'
  const vps = conj.map(a => h.vp(a, y, { ...extra, form: 'sub' }))
  if (vps.every(Boolean)) return [np, relPron(h, y, plural), joinPhrases(vps, 'en')]
  const parts = conj.map(a => relativeBody(h, a, y, extra))
  const rel = parts.filter(Boolean).flatMap((p, i) => [i ? kw('en') : [], p])
  const other = conj.filter((a, i) => !parts[i])
  if (!other.length) return [np, rel]
  const cl = joinPhrases(other.map(a => h.clause(a, { form: 'sub' })), 'en')
  return cl && [np, rel, rel.length ? kw('en') : [], kw('zodanig dat'), cl]
}

function clauseList(h, intro, items) {
  const parts = items.map(it => h.clause(it, { form: undefined }))
  if (parts.some(p => !p)) return null
  return [kw(intro), punct(':'), parts.flatMap((p, i) => (i ? [punct(';'), p] : [p]))]
}

function objectQuantified(h, x, y, body, np) {
  const conj = body.t === 'and' ? body.args : [body]
  const anchor = conj.find(a => a.t === 'fact' && a.args.includes(x) && a.args.includes(y) &&
    a.args.filter(z => z === y).length === 1)
  if (!anchor) return null
  const fill = withRelatives(h, np, y, conj.filter(a => a !== anchor))
  return fill && h.reading(anchor, x, new Map([[y, fill]]))
}

function anchoredClause(h, y, body, np) {
  const conj = body.t === 'and' ? body.args : [body]
  for (const anchor of conj) {
    if (anchor.t !== 'fact' || anchor.args.filter(z => z === y).length !== 1) continue
    if (!anchor.args.some(a => a !== y && isVar(a))) continue
    const fill = withRelatives(h, np, y, conj.filter(a => a !== anchor))
    if (!fill) continue
    const r = h.reading(anchor, undefined, new Map([[y, fill]]))
    if (r) return r
  }
  return null
}

// A verb with its complement in the environment's word order: "is
// hoogstens 30" / "hoogstens 30 is"; the verb plural with env.verb.
function verbPhrase(h, verb, complement) {
  const v = h.env.verb === 'plural' ? (pluralVerb(verb) ?? verb) : verb
  if (h.env.form === 'sub') return [complement, kw(v)]
  return [kw(v), complement]
}

const VALUE_OPS = { '≈': '', '≉': 'niet', '<': 'kleiner dan', '≤': 'hoogstens', '>': 'groter dan', '≥': 'minstens' }

const PREDICATES = {
  startsWith: 'begint met', endsWith: 'eindigt op', contains: 'bevat',
  matches: 'voldoet aan de reguliere expressie',
}

// "CourseTitle begint met 'Intro'" / "… CourseTitle met 'Intro' begint"
function predicate(h, f, subjectPhrase) {
  const [verb, rest] = splitFirst(PREDICATES[f.op] ?? f.op)
  const obj = [rest ? kw(rest) : [], h.term(f.args[1])]
  if (h.env.form === 'sub') return [subjectPhrase, obj, kw(verb)]
  if (h.env.form === 'inv') return [kw(verb), subjectPhrase, obj]
  return [subjectPhrase, kw(verb), obj]
}

// ── Library ──────────────────────────────────────────────────────────────────

const functions = {
  rangeItems: (h, body, x) => {
    const spec = rangeSpec(body, x)
    return spec && spec.map(i => i.op === '..' ? [h.term(i.lo), kw('tot en met'), h.term(i.hi)]
      : i.op === '≈' ? [h.term(i.value)] : [kw(i.op === '≥' ? 'minstens' : 'hoogstens'), h.term(i.value)])
  },
  exclusionItems: (h, f) => exclusionItems(f),
  exclusiveOrItems: (h, f) => exclusiveOrItems(f),
  sameUpToWild: (h, a, b, ys) => sameUpToWild(a, b, ys),
  distributable: (h, ys, args, x) => distributable(ys, args, x),
  isComplex: (h, f) => isComplex(f),
  isVar: (h, x) => isVar(x),
  occursAll: (h, f, vs) => vs.every(v => occurs(f, v)),
  singular: (h, q) => isSingular(q.op, q.n),
  subjectOf: (h, f) => subjectOf(f),

  every: (h, v) => every(h, v),
  // elk Gebouw en elk Kamernummer
  everyList: (h, vs) => joinList(vs.map(v => [every(h, v), tok(h.name(v), 'type')]), 'en'),
  wildCount: (h, f) => f.args.filter(a => a?.t === 'wild').length,
  names: (h, vs) => names(h, vs),
  relPron: (h, v, plural) => relPron(h, v, plural),
  relative: (h, a, x, extra) => relative(h, a, x, extra),
  relativeBody: (h, a, x, extra) => relativeBody(h, a, x, extra),
  clauseList: (h, intro, items) => clauseList(h, intro, items),
  objectQuantified: (h, x, y, body, np) => objectQuantified(h, x, y, body, np),
  anchoredClause: (h, y, body, np) => anchoredClause(h, y, body, np),
  quantNP: (h, q, y) => quantifiedNP(h, q.op, q.n, q.m, y),
  quantifier: (h, q) => quantifier(q.op, q.n, q.m),
  commaList: (h, items) => items.flatMap((it, i) => (i ? [punct(','), it] : [it])),
  // The clauses joined by a connective; in inverted order only the first
  // is inverted ("dan is A en B …").
  clauses: (h, fs, conj) => joinPhrases(fs.map((f, i) => h.clause(f, i && h.env.form === 'inv' ? { form: undefined } : {})), conj),
  vps: (h, fs, x, conj) => joinPhrases(fs.map(f => h.vp(f, x)), conj),
  someList: (h, ys) => joinList(ys.map(y => [kw('een'), tok(h.name(y), 'type')]), 'en'),
  countedNP: (h, q, ys) => {
    const one = isSingular(q.op, q.n)
    return ys.length === 1
      ? tok(one ? h.name(ys[0]) : h.plural(ys[0]), 'type')
      : [kw(one ? 'combinatie van' : 'combinaties van'), names(h, ys)]
  },
  // "er is" / "er zijn", in the environment's word order; many is a
  // boolean or the counting quantifier whose number decides.
  thereIs: (h, many, np) => {
    const plural = typeof many === 'object' ? !isSingular(many.op, many.n) : !!many
    const v = kw(plural ? 'zijn' : 'is')
    if (h.env.form === 'sub') return [kw('er'), np, v]
    if (h.env.form === 'inv') return [v, kw('er'), np]
    return [kw('er'), v, np]
  },
  // "het is niet zo dat …", in the environment's word order.
  notTrue: (h, clause) => {
    if (h.env.form === 'sub') return [kw('het niet zo is dat'), clause]
    if (h.env.form === 'inv') return [kw('is het niet zo dat'), clause]
    return [kw('het is niet zo dat'), clause]
  },
  // A type atom as a clause or verb phrase: "Staff is een Professor".
  isAClause: (h, T, x) => {
    const np = [article(), tok(h.typeLabel(T), 'type')]
    if (h.env.form === 'inv') return [kw('is'), h.ref(x), np]
    return [h.ref(x), verbPhrase(h, 'is', np)]
  },
  isA: (h, T) => (h.env.verb === 'plural'
    ? verbPhrase(h, 'is', tok(h.typePlural(T), 'type'))
    : verbPhrase(h, 'is', [article(), tok(h.typeLabel(T), 'type')])),
  valueVP: (h, op, r) => verbPhrase(h, 'is', [VALUE_OPS[op] ? kw(VALUE_OPS[op]) : [], h.term(r)]),
  valueClause: (h, op, l, r) => {
    const comp = [VALUE_OPS[op] ? kw(VALUE_OPS[op]) : [], h.term(r)]
    if (h.env.form === 'inv') return [kw('is'), h.term(l), comp]
    return [h.term(l), verbPhrase(h, 'is', comp)]
  },
  sameVP: (h, op, r) => verbPhrase(h, 'is', [op === '=' ? [] : kw('niet'), h.ref(r)]),
  predicateVP: (h, f) => predicate(h, f, []),
  predicateClause: (h, f) => predicate(h, f, h.term(f.args[0])),
  closure: (h, f) => seq(h.ref(f.args[0]), kw('is verbonden met'), h.ref(f.args[1]),
    kw(f.star ? 'via nul of meer stappen, elk van een' : 'via een of meer stappen, elk van een'),
    tok(h.name(f.vars[0]), 'type'), kw('naar een'), tok(h.name(f.vars[1]), 'type'), kw('zodanig dat'),
    h.clause(f.body, { form: 'sub' })),
  directlyOrIndirectly: (h, f, x, t) => {
    const [v, w] = f.vars
    const sub = (a) => (a === v ? x : a === w ? t : a)
    const r = h.reading({ ...f.body, args: f.body.args.map(sub) }, x)
    return seq(r, punct(','), kw('direct of indirect'),
      f.star ? [kw('of is'), t === x ? kw('zichzelf') : h.ref(t)] : [])
  },
  exactlyOneEach: (h, ys, args, x) => joinPhrases(ys.map(y => h.vp({ t: 'count', op: '=', n: 1, vars: [y],
    body: args.find(a => occurs(a, y)) }, x)), 'en'),
  unknownNode: (h, f) => kw(`(${f?.t ?? '?'})`),
}

// ── Terms ────────────────────────────────────────────────────────────────────

const OPERATION = {
  add: '{0} plus {1}', sub: '{0} min {1}', mul: '{0} maal {1}', div: '{0} gedeeld door {1}',
  mod: 'de rest van {0} gedeeld door {1}', neg: 'min {0}', abs: 'de absolute waarde van {0}',
  least: 'de kleinste van {0} en {1}', greatest: 'de grootste van {0} en {1}',
  round: '{0} afgerond op {1} decimalen', roundInt: '{0} afgerond op een geheel getal',
  floor: '{0} naar beneden afgerond', ceiling: '{0} naar boven afgerond',
  power: '{0} tot de macht {1}', sqrt: 'de wortel van {0}',
  concat: '{0} gevolgd door {1}', length: 'de lengte van {0}',
  upper: '{0} in hoofdletters', lower: '{0} in kleine letters', toText: '{0} als tekst',
  year: 'het jaar van {0}', month: 'de maand van {0}', day: 'de dag van de maand van {0}',
  yearsBetween: 'het aantal hele jaren van {0} tot {1}',
}
const AGG_LABELS = { count: 'het aantal', sum: 'de som', avg: 'het gemiddelde', min: 'de kleinste waarde', max: 'de grootste waarde' }

function term(h, t) {
  if (isVar(t) || t?.t === 'wild') return h.ref(t)
  switch (t?.t) {
    case 'const': return tok(t.quoted ? `'${t.text}'` : t.text, 'const')
    case 'fn': return operation(h, t, OPERATION, (label) => `de ${label} van`, 'en')
    case 'ite':
      return seq(punct('('), kw('als'), h.clause(t.cond, { form: 'sub' }), kw('dan'), term(h, t.then), kw('anders'), term(h, t.else), punct(')'))
    case 'agg': return aggregate(h, t)
    default: return kw('?')
  }
}

//   Count{y : φ}             het aantal Studenten die Course volgen
//   F{k | c, k : φ ∧ R(c, k)}  de som van de Credits die elke Course die
//                            Student volgt waard is
function aggregate(h, t) {
  const label = AGG_LABELS[t.fn] ?? t.fn
  const distinct = t.distinct ? [kw('verschillende')] : []
  const conj = t.cond?.t === 'and' ? t.cond.args : t.cond?.t === 'true' ? [] : [t.cond]
  if (t.vars.length === 1 && (!t.term || t.term === t.vars[0])) {
    const y = t.vars[0]
    const r = withRelatives(h, [], y, conj, { verb: 'plural' })
    if (r) return [kw(t.term ? `${label} van alle` : label), distinct, tok(h.plural(y), 'type'), r]
  }
  if (t.vars.length === 2 && t.term && t.vars.includes(t.term)) {
    const k = t.term, c = t.vars.find(v => v !== k)
    const link = conj.find(a => a.t === 'fact' && a.args.length === 2 && a.args.includes(c) && a.args.includes(k))
    const restC = conj.filter(a => a !== link)
    if (link && restC.every(a => !occurs(a, k))) {
      const cNP = withRelatives(h, [every(h, c), tok(h.name(c), 'type')], c, restC)
      const r = cNP && h.with({ form: 'sub' }).reading(link, undefined, new Map([[k, []], [c, cNP]]))
      if (r) return [kw(`${label} van`), distinct, kw('de'), tok(h.name(k), 'type'), relPron(h, k), r]
    }
  }
  const what = t.vars.length === 1 ? tok(h.plural(t.vars[0]), 'type') : [kw('combinaties van'), names(h, t.vars)]
  const cond = h.clause(t.cond, { form: 'sub' })
  if (!t.term) return seq(kw(label), distinct, what, kw('zodanig dat'), cond)
  return seq(kw(`${label} van`), distinct, term(h, t.term), kw('over alle'), what, kw('zodanig dat'), cond)
}

export const dutchLibrary = {
  id: 'nl',
  label: 'Nederlands',
  functions,
  term,
  refNP: (h, v) => (h.env.refStyle === 'bare' ? tok(h.name(v), 'type') : [demonstrative(h, v), tok(h.name(v), 'type')]),
  // "een Vak", or "geen Vak" in a negated atom (env.none).
  wildNP: (h, w) => [kw(h.env.none ? 'geen' : 'een'), tok(h.name(w), 'type')],
  reflexive: () => kw('zichzelf'),
  pluralise,
  shapeReading,
}
