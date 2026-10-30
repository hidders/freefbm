// The Polish library: cases, agreement and phrase builders for the rules in
// polish.vr.
//
// Polish nouns decline. The lexicon gives a type its name (nominative
// singular), plural (nominative plural), gender and the other case forms
// (see lexicon.js), and a reading gives each of its slots a case, by default
// the nominative for the first and the accusative for the others:
//   Student studiuje Przedmiot               cases ['nom', 'acc']
//   Sala znajduje się w Budynku              cases ['nom', 'loc']
// References and determiners take the case of their slot: "ten Przedmiot",
// "tego Przedmiotu", "jakiś Pracownik", "żadnego Przedmiotu". A negated verb
// ("nie studiuje") puts its accusative object in the genitive. So the noun
// phrases that fill slots are built per case: the rules pass the phrase's
// kind ("some", "none", "each", or the counting quantifier) instead of the
// phrase, and the functions here build it in the slot's case.
//
// Genders: 'mp' masculine personal, 'ma' masculine animate, 'mi' masculine
// inanimate (the default), 'f' feminine, 'n' neuter. Numbers govern the
// noun: jeden Przedmiot, 2–4 Przedmioty, 5 Przedmiotów (and with masculine
// personal nouns 2 Profesorów), and with 5 or more the verb is singular.

import { isVar } from '../match.js'
import {
  occurs, rangeSpec, exclusionItems, exclusiveOrItems, sameUpToWild, distributable, isComplex, isSingular, subjectOf,
} from '../structure.js'
import { tok, seq } from '../engine.js'
import { joinList, joinPhrases } from './english.js'
import { OPS } from '../../logic/dataOperators.js'

const kw = (s) => tok(s, 'kw')
const punct = (s) => tok(s, 'punct')
const typeTok = (s) => tok(s, 'type')
const hasText = (parts) => Array.isArray(parts) && parts.some(p => p?.trim())
const splitFirst = (text) => {
  const m = /^\s*(\S+)\s*(.*)$/s.exec(text ?? '')
  return m ? [m[1], m[2]] : ['', '']
}
const words = (...ws) => ws.filter(Boolean).join(' ')

export const CASES = ['nom', 'gen', 'dat', 'acc', 'ins', 'loc']
export const GENDERS = ['mp', 'ma', 'mi', 'f', 'n']

// ── Adjectival declension (determiners and pronouns) ─────────────────────────

const HARD = {
  m: { nom: 'y', gen: 'ego', dat: 'emu', accA: 'ego', accI: 'y', ins: 'ym', loc: 'ym' },
  n: { nom: 'e', gen: 'ego', dat: 'emu', acc: 'e', ins: 'ym', loc: 'ym' },
  f: { nom: 'a', gen: 'ej', dat: 'ej', acc: 'ą', ins: 'ą', loc: 'ej' },
  pl: { nom: 'e', gen: 'ych', dat: 'ym', accP: 'ych', acc: 'e', ins: 'ymi', loc: 'ych' },
}
// After k and g: y → i, e → ie.
const soften = (e) => e.replace(/^y/, 'i').replace(/^e/, 'ie')

// The form of an adjective-like word with stem stem (każd, któr, tak) for a
// noun of gender g in case c, singular or plural; irregular forms from over
// (keys like 'm.nom', 'n.acc', 'pl.mp.nom'), suffix added to all forms.
function adjective(stem, g, c, plural, { over = {}, soft = false, suffix = '' } = {}) {
  const personal = g === 'mp'
  const animate = g === 'mp' || g === 'ma'
  let key, ending
  if (plural) {
    key = personal && c === 'nom' ? 'pl.mp.nom' : `pl.${c}`
    ending = c === 'acc' ? (personal ? HARD.pl.accP : HARD.pl.acc) : HARD.pl[c]
  } else if (g === 'f' || g === 'n') {
    key = `${g}.${c}`
    ending = HARD[g][c]
  } else {
    key = `m.${c}${c === 'acc' ? (animate ? 'A' : 'I') : ''}`
    ending = c === 'acc' ? (animate ? HARD.m.accA : HARD.m.accI) : HARD.m[c]
  }
  const form = over[key] ?? over[key.replace(/[AI]$/, '')] ?? stem + (soft ? soften(ending) : ending)
  return form + suffix
}

const DETERMINERS = {
  // każdy, każdego, każdemu, …
  each: (g, c) => adjective('każd', g, c, false),
  // żaden, żadnego, …; żadna, …
  none: (g, c) => adjective('żadn', g, c, false, { over: { 'm.nom': 'żaden', 'm.accI': 'żaden' } }),
  // jakiś, jakiegoś, …; jakaś, …; jakieś
  some: (g, c, pl) => adjective('jak', g, c, pl, { soft: true, suffix: 'ś', over: { 'pl.mp.nom': 'jacy' } }),
  // sam, samego, …; sama, …; samo
  same: (g, c) => adjective('sam', g, c, false, { over: { 'm.nom': 'sam', 'm.accI': 'sam', 'n.nom': 'samo', 'n.acc': 'samo' } }),
  // jeden, jednego, …; jedna, …; jedno
  one: (g, c) => adjective('jedn', g, c, false, { over: { 'm.nom': 'jeden', 'm.accI': 'jeden', 'n.nom': 'jedno', 'n.acc': 'jedno' } }),
  // który, którego, …; którzy, które
  which: (g, c, pl) => adjective('któr', g, c, pl, { over: { 'pl.mp.nom': 'którzy' } }),
  // taki, takiego, …; tacy, takie
  such: (g, c, pl) => adjective('tak', g, c, pl, { soft: true, over: { 'pl.mp.nom': 'tacy' } }),
  // ten, tego, temu, …; ta, tej, tę; to; ci, te
  that: (g, c, pl) => adjective('t', g, c, pl, { over: {
    'm.nom': 'ten', 'm.gen': 'tego', 'm.dat': 'temu', 'm.accA': 'tego', 'm.accI': 'ten', 'm.ins': 'tym', 'm.loc': 'tym',
    'n.nom': 'to', 'n.gen': 'tego', 'n.dat': 'temu', 'n.acc': 'to', 'n.ins': 'tym', 'n.loc': 'tym',
    'f.nom': 'ta', 'f.gen': 'tej', 'f.dat': 'tej', 'f.acc': 'tę', 'f.ins': 'tą', 'f.loc': 'tej',
    'pl.mp.nom': 'ci', 'pl.nom': 'te', 'pl.gen': 'tych', 'pl.dat': 'tym', 'pl.acc': 'te', 'pl.ins': 'tymi', 'pl.loc': 'tych',
  } }),
  // wszystkie, wszystkich, …
  all: (g, c) => adjective('wszystk', g, c, true, { soft: true, over: { 'pl.mp.nom': 'wszyscy' } }),
}

// ── Nouns ────────────────────────────────────────────────────────────────────

// A rough plural for the Inspector's placeholder: -a → -y (-i after k, g),
// -o and -e → -a, a consonant → -y (-i after k, g), -owie for masculine
// personal nouns.
export function pluralise(name, gender) {
  if (gender === 'mp') return `${name}owie`
  if (/[kg]a$/.test(name)) return `${name.slice(0, -1)}i`
  if (/a$/.test(name)) return `${name.slice(0, -1)}y`
  if (/[oe]$/.test(name)) return `${name.slice(0, -1)}a`
  if (/[kg]$/.test(name)) return `${name}i`
  return `${name}y`
}

// Default forms when the lexicon has none: the accusative singular of an
// animate masculine noun is its genitive, of other nouns the nominative
// (right for inanimate masculine and neuter nouns); the accusative plural of
// a masculine personal noun is its genitive plural. Others fall back to the
// nominative of the same number.
function nounForm(entry, c = 'nom', plural = false) {
  const g = entry.gender || 'mi'
  const f = entry.forms ?? {}
  const nomPl = entry.plural || pluralise(entry.name, g)
  if (c === 'nom') return plural ? nomPl : entry.name
  const own = f[plural ? `${c}Pl` : c]
  if (own?.trim()) return own.trim()
  if (c === 'acc') {
    if (plural) return g === 'mp' ? nounForm(entry, 'gen', true) : nomPl
    return g === 'mp' || g === 'ma' ? nounForm(entry, 'gen', false) : entry.name
  }
  return plural ? nomPl : entry.name
}

// ── Numbers ──────────────────────────────────────────────────────────────────

// How a number n governs a noun in the nominative or accusative: 'one', 'few'
// (2–4, 22–24, …: the noun in the plural, the verb plural) or 'many' (the
// noun in the genitive plural, the verb singular). Masculine personal nouns
// take 'many' for every number above one.
function numberClass(n, g) {
  if (n === 1) return 'one'
  if (g !== 'mp' && n % 10 >= 2 && n % 10 <= 4 && !(n % 100 >= 12 && n % 100 <= 14)) return 'few'
  return 'many'
}

// The counted noun phrase: "co najwyżej jeden Przedmiot", "co najmniej 2
// Kursy", "co najwyżej 6 Przedmiotów"; in an oblique case the noun takes that
// case in the plural ("co najwyżej 6 Przedmiotom").
function quantifier(q, g, c) {
  const words = { '≤': 'co najwyżej', '≥': 'co najmniej', '=': 'dokładnie', '>': 'więcej niż' }
  const num = (n) => kw(n === 1 ? DETERMINERS.one(g, c) : String(n))
  if (q.op === '..') return [kw('co najmniej'), num(q.n), kw('i co najwyżej'), num(q.m)]
  return [kw(words[q.op] ?? q.op), num(q.n)]
}
const countOf = (q) => (q.op === '..' ? q.m : q.n)

function countedNoun(entry, q, c) {
  const g = entry.gender || 'mi'
  const k = numberClass(countOf(q), g)
  if (k === 'one') return nounForm(entry, c, false)
  if (c === 'nom' || c === 'acc') return k === 'few' ? nounForm(entry, c, true) : nounForm(entry, 'gen', true)
  return nounForm(entry, c, true)
}
// Whether a subject counted by q takes a plural verb.
const pluralVerbFor = (q, g) => numberClass(countOf(q), g) === 'few'

// ── Verbs ────────────────────────────────────────────────────────────────────

const IRREGULAR = { jest: 'są', wynosi: 'wynoszą', ma: 'mają', może: 'mogą', chce: 'chcą', idzie: 'idą', bierze: 'biorą', wie: 'wiedzą', je: 'jedzą' }

// The third person plural of a verb in the third person singular:
// studiuje → studiują, prowadzi → prowadzą, czyta → czytają.
export function pluralVerb(w) {
  const lower = w.toLowerCase()
  if (IRREGULAR[lower]) return IRREGULAR[lower]
  if (/je$/.test(lower)) return `${lower.slice(0, -1)}ą`
  if (/a$/.test(lower)) return `${lower}ją`
  if (/[iy]$/.test(lower)) return `${lower.replace(/[iy]$/, '')}ą`
  return null
}

// ── Readings ─────────────────────────────────────────────────────────────────

// The reading's parts and slot cases for the environment: the plural form,
// and "nie" before the verb with its accusative objects in the genitive.
function shapeReading(h, pick) {
  const n = pick.roleOrder.length
  let parts = pick.parts
  let cases = Array.from({ length: n }, (_, k) => pick.cases?.[k] || (k ? 'acc' : 'nom'))
  if (h.env.verb === 'plural') {
    if (hasText(pick.pluralParts)) parts = pick.pluralParts
    else {
      const [w, rest] = splitFirst(parts[1])
      const pv = w && pluralVerb(w)
      if (!pv) return null
      parts = [parts[0], words(pv, rest), ...parts.slice(2)]
    }
  }
  if (h.env.verb === 'negated' || h.env.none) {
    if (!parts[1]?.trim()) return null
    parts = [parts[0], words('nie', parts[1].trim()), ...parts.slice(2)]
    cases = cases.map((c, k) => (k && c === 'acc' ? 'gen' : c))
  }
  return { parts, cases }
}

// ── The library ──────────────────────────────────────────────────────────────

const PREPOSITIONS = new Set(['w', 'we', 'na', 'do', 'od', 'z', 'ze', 'o', 'dla', 'przez', 'przy', 'po', 'za', 'nad', 'pod', 'przed', 'między', 'u', 'ku', 'bez', 'wobec'])

const gender = (h, v) => h.entry(v).gender || 'mi'
const noun = (h, v, c = 'nom', plural = false) => typeTok(nounForm(h.entry(v), c, plural) + (typeof v === 'string' ? '' : h.subscript(v)))

// A noun phrase of the given kind for y, in case c: 'some' (jakiś
// Przedmiot), 'none' (żaden Przedmiot), 'each' (każdy Przedmiot), 'bare'
// (Przedmiot) or a counting quantifier node.
function np(h, y, kind, c = 'nom') {
  const g = gender(h, y)
  if (kind && typeof kind === 'object') {
    return [quantifier(kind, g, c), typeTok(countedNoun(h.entry(y), kind, c) + h.subscript(y))]
  }
  if (kind === 'bare') return noun(h, y, c)
  return [kw(DETERMINERS[kind](g, c, false)), noun(h, y, c)]
}
const kindPlural = (kind, g) => !!kind && typeof kind === 'object' && !isSingular(kind.op, kind.n) &&
  numberClass(countOf(kind), g) !== 'one'

// A relative clause on x as { pron, body }: "który studiuje jakiś Przedmiot",
// "który Student studiuje", "w którym zaczyna się jakiś Rok akademicki"; the
// pronoun agrees with x and takes the case of x's slot. fills are further
// slot fillers (variable → phrase or case → phrase).
function relativeParts(h, a, x, plural, fills) {
  const g = gender(h, x)
  const vp = !fills && h.vp(a, x, plural ? { verb: 'plural' } : {})
  if (vp) return { pron: [punct(','), kw(DETERMINERS.which(g, 'nom', plural))], body: vp }
  if (a.t !== 'fact' || a.args.filter(z => z === x).length !== 1) return null
  let slotCase = 'acc'
  const gap = { text: '', cls: 'gap' }
  const body = h.with({ verb: undefined }).reading(a, undefined, new Map([...(fills ?? []), [x, (c) => { slotCase = c || 'acc'; return gap }]]))
  if (!body) return null
  const i = body.indexOf(gap)
  const before = body[i - 1]
  const m = before?.cls === 'reading' ? /^(.*?)\s*(\S+)$/.exec(before.text) : null
  const pron = DETERMINERS.which(g, slotCase, plural)
  if (m && PREPOSITIONS.has(m[2].toLowerCase())) {
    const out = [...body]
    out[i - 1] = tok(m[1], 'reading')
    return { pron: [punct(','), kw(`${m[2]} ${pron}`)], body: out }
  }
  return { pron: [punct(','), kw(pron)], body }
}
const relativeBody = (h, a, x, plural) => {
  const r = relativeParts(h, a, x, plural)
  return r && [r.pron, r.body]
}

// "taki, że" agreeing with y (nominative), or with a combination.
const suchThat = (h, ys, plural) => {
  const g = ys.length === 1 ? gender(h, ys[0]) : 'f'
  return [kw(DETERMINERS.such(g, 'nom', plural)), punct(','), kw('że')]
}

// The noun phrase for y with relative clauses for the conjuncts about it,
// as a function of the case of its slot.
function withRelatives(h, y, kind, conj) {
  const plural = kindPlural(kind, gender(h, y))
  const rels = []
  const other = []
  for (const a of conj) {
    const r = relativeBody(h, a, y, plural)
    if (r) rels.push(r)
    else other.push(a)
  }
  const cl = other.length ? joinPhrases(other.map(a => h.clause(a)), 'i') : []
  if (cl === null) return null
  return (c) => [np(h, y, kind, c), rels.map((r, i) => (i ? [kw('i'), r[0].slice(1), r[1]] : r)),
    other.length ? [rels.length ? kw('i') : [], kw(DETERMINERS.such(gender(h, y), c, plural)), punct(','), kw('że'), cl] : []]
}

function objectQuantified(h, x, y, body, kind) {
  const conj = body.t === 'and' ? body.args : [body]
  const anchor = conj.find(a => a.t === 'fact' && a.args.includes(x) && a.args.includes(y) &&
    a.args.filter(z => z === y).length === 1)
  if (!anchor) return null
  const fill = withRelatives(h, y, kind, conj.filter(a => a !== anchor))
  return fill && h.reading(anchor, x, new Map([[y, fill]]))
}

function anchoredClause(h, y, body, kind) {
  const conj = body.t === 'and' ? body.args : [body]
  for (const anchor of conj) {
    if (anchor.t !== 'fact' || anchor.args.filter(z => z === y).length !== 1) continue
    if (!anchor.args.some(a => a !== y && isVar(a))) continue
    const fill = withRelatives(h, y, kind, conj.filter(a => a !== anchor))
    if (!fill) continue
    const r = h.reading(anchor, undefined, new Map([[y, fill]]))
    if (r) return r
  }
  return null
}

function clauseList(h, intro, items) {
  const parts = items.map(it => h.clause(it))
  if (parts.some(p => !p)) return null
  return [kw(intro), punct(':'), parts.flatMap((p, i) => (i ? [punct(';'), p] : [p]))]
}

const verbKw = (h, w) => {
  let v = w
  if (h.env.verb === 'plural') v = pluralVerb(w)
  if (!v) return null
  return kw(h.env.verb === 'negated' ? `nie ${v}` : v)
}

const VALUE_OPS = { '≈': 'wynosi', '≉': 'nie wynosi', '<': 'wynosi mniej niż', '≤': 'wynosi co najwyżej', '>': 'wynosi więcej niż', '≥': 'wynosi co najmniej' }
const valueVerb = (h, text) => {
  const [w, rest] = splitFirst(text)
  const v = verbKw(h, w === 'nie' ? splitFirst(rest)[0] : w)
  if (!v) return null
  return w === 'nie' ? [kw('nie'), v, kw(splitFirst(rest)[1])] : [v, rest ? kw(rest) : []]
}

const PREDICATES = { startsWith: 'zaczyna się od', endsWith: 'kończy się na', contains: 'zawiera', matches: 'pasuje do wyrażenia regularnego' }

const functions = {
  rangeItems: (h, body, x) => {
    const spec = rangeSpec(body, x)
    const bound = { '≥': 'co najmniej', '≤': 'co najwyżej', '>': 'więcej niż', '<': 'mniej niż' }
    return spec && spec.map(i => i.op === '..'
      ? (i.loOp === '≥' && i.hiOp === '≤' ? [kw('od'), h.term(i.lo), kw('do'), h.term(i.hi)]
        : [kw(bound[i.loOp]), h.term(i.lo), kw('i'), kw(bound[i.hiOp]), h.term(i.hi)])
      : i.op === '≈' ? [h.term(i.value)] : [kw(bound[i.op]), h.term(i.value)])
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
  wildCount: (h, f) => f.args.filter(a => a?.t === 'wild').length,

  // A noun phrase of a kind ("some", "none", "each", "bare" or a counting
  // quantifier) for y in case c: np(?y, "each", "gen") is "każdego Przedmiotu".
  np: (h, y, kind, c) => np(h, y, kind, c || 'nom'),
  // każdego X i każdego Y, in case c.
  eachList: (h, vs, c) => joinList(vs.map(v => np(h, v, 'each', c)), 'i'),
  // jakiś X i jakiś Y
  someList: (h, ys) => joinList(ys.map(y => np(h, y, 'some')), 'i'),
  suchThat: (h, ys, q) => suchThat(h, ys, q ? !isSingular(q.op, q.n) : ys.length > 1),
  // istnieje or istnieją, agreeing with the noun counted by q (ys a
  // variable or a list), or with the list ys.
  exists: (h, q, ys) => {
    const vs = Array.isArray(ys) ? ys : [ys]
    return kw(pluralVerbFor(q, vs.length === 1 ? gender(h, vs[0]) : 'f') ? 'istnieją' : 'istnieje')
  },
  existSome: (h, ys) => kw(ys.length > 1 ? 'istnieją' : 'istnieje'),
  // The verb form for a subject counted by q: plural for 2–4.
  countVerb: (h, q, y) => (pluralVerbFor(q, gender(h, y)) ? 'plural' : ''),
  relative: (h, a, x) => {
    const r = relativeBody(h, a, x, false)
    if (r) return r
    const c = h.clause(a)
    return c && [suchThat(h, [x], false), c]
  },
  relativeBody: (h, a, x, q) => relativeBody(h, a, x, !!q && kindPlural(q, gender(h, x))),
  clauseList: (h, intro, items) => clauseList(h, intro, items),
  objectQuantified: (h, x, y, body, kind) => objectQuantified(h, x, y, body, kind),
  anchoredClause: (h, y, body, kind) => anchoredClause(h, y, body, kind),
  commaList: (h, items) => items.flatMap((it, i) => (i ? [punct(','), it] : [it])),
  clauses: (h, fs, conj) => joinPhrases(fs.map(f => h.clause(f)), conj),
  vps: (h, fs, x, conj) => joinPhrases(fs.map(f => h.vp(f, x)), conj),
  // "jedna kombinacja Pracownika i Przedmiotu", "5 kombinacji …"
  countedNP: (h, q, ys) => {
    if (ys.length === 1) return np(h, ys[0], q, 'nom')
    const k = numberClass(countOf(q), 'f')
    const comb = k === 'one' ? 'kombinacja' : k === 'few' ? 'kombinacje' : 'kombinacji'
    return [quantifier(q, 'f', 'nom'), kw(comb), joinList(ys.map(y => noun(h, y, 'gen')), 'i')]
  },
  // ¬A with its subject and the negated verb phrase: "Przedmiot₁ nie jest
  // prerekwizytem dla Przedmiotu₃", "Student nie studiuje żadnego Przedmiotu".
  negatedClause: (h, a) => {
    let x
    if (a.t === 'exists') x = a.vars.length === 1 && a.body.t === 'fact' ? a.body.args.find(z => isVar(z) && z !== a.vars[0]) : null
    else x = a.t === 'type' ? a.arg : a.args.find(isVar)
    return x ? seq(h.ref(x), h.vp(a, x, { verb: 'negated' })) : null
  },
  // jest Profesorem, nie jest Profesorem, są Profesorami
  isA: (h, T) => seq(verbKw(h, 'jest'), noun(h, T, 'ins', h.env.verb === 'plural')),
  valueVP: (h, op, r) => seq(valueVerb(h, VALUE_OPS[op] ?? op), h.term(r)),
  valueClause: (h, op, l, r) => [h.term(l), kw(VALUE_OPS[op] ?? op), h.term(r)],
  sameVP: (h, op, r) => seq(verbKw(h, 'jest'), kw(op === '=' ? 'tym samym co' : 'kimś innym niż'), h.ref(r)),
  predicateVP: (h, f) => [kw(PREDICATES[f.op] ?? f.op), h.term(f.args[1])],
  dataPredicate: (h, f) => f.args.length === 2
    ? [h.term(f.args[0]), kw(PREDICATES[f.op] ?? f.op), h.term(f.args[1])]
    : [kw(PREDICATES[f.op] ?? f.op), punct('('), joinList(f.args.map(a => h.term(a)), 'i'), punct(')')],
  closure: (h, f) => seq(h.ref(f.args[0]), kw('jest połączony z'), h.ref(f.args[1], 'ins'),
    kw(f.star ? 'przez zero lub więcej kroków, każdy od' : 'przez jeden lub więcej kroków, każdy od'),
    np(h, f.vars[0], 'some', 'gen'), kw('do'), np(h, f.vars[1], 'some', 'gen'), punct(','),
    kw('takich'), punct(','), kw('że'), h.clause(f.body)),
  directlyOrIndirectly: (h, f, x, t) => {
    const [v, w] = f.vars
    const sub = (a) => (a === v ? x : a === w ? t : a)
    const r = h.reading({ ...f.body, args: f.body.args.map(sub) }, x)
    return seq(r, punct(','), kw('bezpośrednio lub pośrednio'),
      f.star ? [kw('lub jest'), t === x ? kw('sobą') : h.ref(t, 'ins')] : [])
  },
  exactlyOneEach: (h, ys, args, x) => joinPhrases(ys.map(y => h.vp({ t: 'count', op: '=', n: 1, vars: [y],
    body: args.find(a => occurs(a, y)) }, x)), 'i'),
  unknownNode: (h, f) => kw(`(${f?.t ?? '?'})`),
}

// ── Terms ────────────────────────────────────────────────────────────────────

// Data operators; {0:gen} puts the argument in the genitive.
const OPERATION = {
  add: '{0} plus {1}', sub: '{0} minus {1}', mul: '{0} razy {1}', div: '{0} podzielone przez {1}',
  idiv: 'część całkowita z dzielenia {0:gen} przez {1}', mod: 'reszta z dzielenia {0:gen} przez {1}',
  neg: 'minus {0}', abs: 'wartość bezwzględna {0:gen}',
  least: 'mniejsza z wartości {0} i {1}', greatest: 'większa z wartości {0} i {1}',
  round: '{0} zaokrąglone do {1} miejsc po przecinku', roundInt: '{0} zaokrąglone do liczby całkowitej',
  floor: '{0} zaokrąglone w dół', ceiling: '{0} zaokrąglone w górę', truncate: '{0} obcięte',
  power: '{0} do potęgi {1}', sqrt: 'pierwiastek kwadratowy z {0:gen}',
  concat: '{0}, a po nim {1}', length: 'długość {0:gen}',
  substring: 'fragment {0:gen} o długości {2} od pozycji {1}',
  upper: '{0} wielkimi literami', lower: '{0} małymi literami', trim: '{0} bez spacji na początku i na końcu',
  toText: '{0} jako tekst',
  year: 'rok {0:gen}', month: 'miesiąc {0:gen}', day: 'dzień miesiąca {0:gen}',
  hour: 'godzina {0:gen}', minute: 'minuta {0:gen}', second: 'sekunda {0:gen}',
  dayOfWeek: 'dzień tygodnia {0:gen}', yearsBetween: 'liczba pełnych lat od {0:gen} do {1:gen}',
  makeDate: 'data o roku {0}, miesiącu {1} i dniu {2}',
  dateOf: 'data {0:gen}', timeOf: 'pora dnia {0:gen}',
  totalMonths: '{0} w miesiącach', totalDays: '{0} w dniach', totalSeconds: '{0} w sekundach',
}

function term(h, t, c) {
  if (isVar(t) || t?.t === 'wild') return h.ref(t, c)
  switch (t?.t) {
    case 'const': return tok(t.quoted ? `'${t.text}'` : t.text, 'const')
    case 'fn': return operation(h, t)
    case 'ite':
      return seq(punct('('), kw('jeśli'), h.clause(t.cond), punct(','), kw('to'), term(h, t.then), kw('w przeciwnym razie'), term(h, t.else), punct(')'))
    case 'agg': return aggregate(h, t)
    default: return kw('?')
  }
}

function operation(h, t) {
  const def = OPS[t.op]
  const arg = (a, i, c) => {
    const inner = a?.t === 'fn' ? OPS[a.op] : null
    const loose = def?.style === 'infix' && inner?.style === 'infix' &&
      (inner.prec < def.prec || (inner.prec === def.prec && (i > 0 || a.op !== t.op) && !(def.assoc && a.op === t.op)))
    return loose ? [punct('('), term(h, a, c), punct(')')] : term(h, a, c)
  }
  const pattern = OPERATION[t.op] ?? `${def?.label ?? t.op} ${t.args.map((a, i) => `{${i}:gen}`).join(' i ')}`
  return pattern.split(/(\{\d(?::\w+)?\})/).filter(Boolean).map(part => {
    const m = /^\{(\d)(?::(\w+))?\}$/.exec(part)
    if (m) return arg(t.args[Number(m[1])], Number(m[1]), m[2])
    const [, comma, ws] = /^\s*(,?)\s*(.*?)\s*$/.exec(part)
    return [comma ? punct(',') : [], ws ? kw(ws) : []]
  })
}

const AGG_LABELS = { count: 'liczba', sum: 'suma', avg: 'średnia', min: 'najmniejsza wartość', max: 'największa wartość' }

//   Count{y : φ}               liczba Studentów, którzy studiują Przedmiot
//   F{y | y : φ}               suma wszystkich Punktów, które …
//   F{k | c, k : φ ∧ R(c, k)}  suma Punktów ECTS, które ma każdy Przedmiot,
//                              który Student studiuje
function aggregate(h, t) {
  const label = AGG_LABELS[t.fn] ?? t.fn
  const distinct = t.distinct ? [kw('różnych')] : []
  const conj = t.cond?.t === 'and' ? t.cond.args : t.cond?.t === 'true' ? [] : [t.cond]
  if (t.vars.length === 1 && (!t.term || t.term === t.vars[0])) {
    const y = t.vars[0]
    const rels = conj.map(a => relativeBody(h, a, y, true))
    if (rels.every(Boolean)) {
      return [kw(label), t.term ? kw(DETERMINERS.all(gender(h, y), 'gen')) : [], distinct, noun(h, y, 'gen', true),
        rels.map((r, i) => (i ? [kw('i'), r[0].slice(1), r[1]] : r))]
    }
  }
  if (t.vars.length === 2 && t.term && t.vars.includes(t.term)) {
    const k = t.term, c = t.vars.find(v => v !== k)
    const link = conj.find(a => a.t === 'fact' && a.args.length === 2 && a.args.includes(c) && a.args.includes(k))
    const restC = conj.filter(a => a !== link)
    if (link && restC.every(a => !occurs(a, k))) {
      const cNP = withRelatives(h, c, 'each', restC)
      const r = cNP && relativeParts(h, link, k, true, new Map([[c, cNP]]))
      if (r) return [kw(label), distinct, noun(h, k, 'gen', true), r.pron, r.body]
    }
  }
  const what = t.vars.length === 1 ? noun(h, t.vars[0], 'gen', true) : [kw('kombinacji'), joinList(t.vars.map(v => noun(h, v, 'gen')), 'i')]
  const cond = h.clause(t.cond)
  if (!t.term) return seq(kw(label), distinct, what, punct(','), kw('takich'), punct(','), kw('że'), cond)
  return seq(kw(label), distinct, term(h, t.term, 'gen'), kw('po wszystkich'), what, punct(','), kw('takich'), punct(','), kw('że'), cond)
}

export const polishLibrary = {
  id: 'pl',
  label: 'Polski',
  functions,
  term: (h, t) => term(h, t),
  // "ten Przedmiot", "tego Przedmiotu", or bare in a Jeśli … to … sentence.
  // "ten sam Adres e-mail" for the variables in env.same (negative.js).
  refNP: (h, v, c = 'nom') => (h.env.same?.includes(v) ? [kw(DETERMINERS.that(gender(h, v), c, false)), kw(DETERMINERS.same(gender(h, v), c)), noun(h, v, c)]
    : h.env.refStyle === 'bare' ? noun(h, v, c)
    : [kw(DETERMINERS.that(gender(h, v), c, false)), noun(h, v, c)]),
  // "jakiś Przedmiot", or "żaden Przedmiot" in a negated atom (env.none or
  // a negated verb).
  wildNP: (h, w, c = 'nom') => np(h, w, h.env.none || h.env.verb === 'negated' ? 'none' : 'some', c),
  reflexive: (h, v, c) => kw({ dat: 'sobie', loc: 'sobie', ins: 'sobą' }[c] ?? 'siebie'),
  pluralise: (name) => pluralise(name),
  shapeReading,
}
