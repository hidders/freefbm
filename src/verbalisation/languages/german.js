// The German library: cases, word order and phrase builders for the rules in
// german.vr.
//
// German combines what dutch.js and polish.js do:
//
// Word order is a property of the environment, env.form, as in Dutch:
//   (none)  main clause, verb second       Student belegt Kurs
//   'sub'   subordinate, verb last         …, dass Student Kurs belegt
//   'inv'   inverted, verb first           dann belegt Student Kurs
// Readings are written in main-clause order. A reading's subordinate form
// comes from the lexicon (subParts), else the finite verb, the first word
// after the subject, moves to the end: "Student wird von Professor betreut"
// becomes "… Student von Professor betreut wird". A separable particle that
// ends the reading joins the verb: "nimmt an Kurs teil" → "an Kurs teilnimmt".
//
// Cases are as in Polish: a reading gives each of its slots a case (nom,
// gen, dat, acc; by default the nominative for the first and the
// accusative for the others), and the noun phrases that fill slots are
// built per case: "jeder Kurs", "jeden Kurs", "einem Kurs", "keinen Kurs",
// "diesem Kurs". The rules pass the phrase's kind ("some", "none", "each",
// "bare", "that" or a counting quantifier) and the functions here build it
// in the slot's case. The lexicon gives a type its gender (m, f, n; else
// guessed from the ending), its plural and, where the defaults are wrong,
// its case forms (weak nouns: des Studenten, dem Studenten, den Studenten).
//
// Relative clauses are set off by commas on both sides; the closing comma is
// a relEnd token that the contraction pass (contract) drops before other
// punctuation and at the end of the sentence.

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
// The comma closing a relative clause, dropped when punctuation or the end
// of the sentence follows (see contract).
const relEnd = () => ({ text: ',', cls: 'relEnd' })
const hasText = (parts) => Array.isArray(parts) && parts.some(p => p?.trim())
const splitFirst = (text) => {
  const m = /^\s*(\S+)\s*(.*)$/s.exec(text ?? '')
  return m ? [m[1], m[2]] : ['', '']
}
const words = (...ws) => ws.filter(Boolean).join(' ')

export const CASES = ['nom', 'gen', 'dat', 'acc']
export const GENDERS = ['m', 'f', 'n']
const CI = { nom: 0, gen: 1, dat: 2, acc: 3 }
const ci = (c) => CI[c] ?? 0

// ── Determiners ──────────────────────────────────────────────────────────────

// Each row: nominative, genitive, dative, accusative.
const DET = {
  each: { m: ['jeder', 'jedes', 'jedem', 'jeden'], f: ['jede', 'jeder', 'jeder', 'jede'], n: ['jedes', 'jedes', 'jedem', 'jedes'] },
  some: { m: ['ein', 'eines', 'einem', 'einen'], f: ['eine', 'einer', 'einer', 'eine'], n: ['ein', 'eines', 'einem', 'ein'] },
  none: { m: ['kein', 'keines', 'keinem', 'keinen'], f: ['keine', 'keiner', 'keiner', 'keine'], n: ['kein', 'keines', 'keinem', 'kein'], pl: ['keine', 'keiner', 'keinen', 'keine'] },
  that: { m: ['dieser', 'dieses', 'diesem', 'diesen'], f: ['diese', 'dieser', 'dieser', 'diese'], n: ['dieses', 'dieses', 'diesem', 'dieses'], pl: ['diese', 'dieser', 'diesen', 'diese'] },
  the: { m: ['der', 'des', 'dem', 'den'], f: ['die', 'der', 'der', 'die'], n: ['das', 'des', 'dem', 'das'], pl: ['die', 'der', 'den', 'die'] },
  same: { m: ['derselbe', 'desselben', 'demselben', 'denselben'], f: ['dieselbe', 'derselben', 'derselben', 'dieselbe'], n: ['dasselbe', 'desselben', 'demselben', 'dasselbe'], pl: ['dieselben', 'derselben', 'denselben', 'dieselben'] },
  rel: { m: ['der', 'dessen', 'dem', 'den'], f: ['die', 'deren', 'der', 'die'], n: ['das', 'dessen', 'dem', 'das'], pl: ['die', 'deren', 'denen', 'die'] },
}
const det = (kind, g, c, plural = false) => DET[kind][plural ? 'pl' : g]?.[ci(c)] ?? DET[kind][g][ci(c)]

// ── Nouns ────────────────────────────────────────────────────────────────────

const lastWord = (name) => (/(\S+)$/.exec(name ?? '')?.[1] ?? '').toLowerCase()

// The gender a name's ending suggests, for a type without one in the
// lexicon: -ung, -heit, -keit, -schaft, -ion, -tät, -ik, -ur, -ei, -enz,
// -anz, -ie, -zeit, -nummer, -erin, -entin and most nouns in -e are feminine (Note,
// Adresse), -chen, -lein, -um, -ment, -nis and Ge…e neuter (Gebäude), the
// others masculine. A compound takes the gender of its last part.
export function guessGender(name) {
  const w = lastWord(name)
  if (/(chen|lein|um|ment|nis|tum)$/.test(w) || /ge[a-zäöüß]*e$/.test(w)) return 'n'
  if (/(ung|heit|keit|schaft|ion|tät|ik|ur|ei|enz|anz|ie|zeit|nummer|zahl|erin|entin|antin|istin|orin)$/.test(w)) return 'f'
  if (/e$/.test(w) && !/(code|name|kunde|käse)$/.test(w)) return 'f'
  return 'm'
}

// A rough plural for the Inspector's placeholder and for types without one
// in the lexicon: -e → -en (Note → Noten; Ge…e unchanged), -ung, -heit,
// -keit, -schaft, -ion, -tät, -ei and other feminine nouns → -en, feminine
// -el, -er → -eln, -ern (Nummer → Nummern), other -el, -er, -en, -chen,
// -lein unchanged, a final vowel → -s, -nis → -nisse, -or, -ent, -ant, -ist
// → -en (Professor → Professoren, Student → Studenten), else -e (Kurs →
// Kurse). Umlauts (Raum → Räume) need the lexicon.
export function pluralise(name, gender) {
  const g = gender || guessGender(name)
  const w = lastWord(name)
  if (!w) return name
  if (/e$/.test(w)) return g === 'n' && /ge[a-zäöüß]*e$/.test(w) ? name : `${name}n`
  if (/nis$/.test(w)) return `${name}se`
  if (/in$/.test(w) && g === 'f') return `${name}nen`
  if (/(el|er)$/.test(w)) return g === 'f' ? `${name}n` : name
  if (/(en|chen|lein)$/.test(w)) return name
  if (/[aiouy]$/.test(w) || /^[A-Z0-9]+$/.test(name)) return `${name}s`
  if (/um$/.test(w)) return `${name.slice(0, -2)}en`
  if (g === 'f' || /(or|ent|ant|ist|and)$/.test(w)) return `${name}en`
  return `${name}e`
}

const genderOf = (entry) => entry?.gender || guessGender(entry?.name)

// Whether a masculine noun is weak (der Student, den Studenten): its plural
// is the singular plus -n or -en and it ends like a weak noun.
const isWeak = (entry, nomPl) => genderOf(entry) === 'm' && /(e|ent|ant|ist|and|at|oge|graf|soph)$/i.test(entry.name)
  && (nomPl === `${entry.name}n` || nomPl === `${entry.name}en`)

// The form of a type's name in case c, singular or plural. The lexicon's
// forms win; else the genitive singular of a masculine or neuter noun adds
// -s (-es after s, ß, x, z), a weak masculine noun adds -n or -en outside
// the nominative, and the dative plural adds -n unless the plural ends in -n
// or -s.
export function nounForm(entry, c = 'nom', plural = false) {
  const g = genderOf(entry)
  const f = entry.forms ?? {}
  const nomPl = entry.plural || pluralise(entry.name, g)
  if (c === 'nom') return plural ? nomPl : entry.name
  const own = f[plural ? `${c}Pl` : c]
  if (own?.trim()) return own.trim()
  if (plural) return c === 'dat' && !/[ns]$/.test(nomPl) ? `${nomPl}n` : nomPl
  if (isWeak(entry, nomPl)) return nomPl
  if (c === 'gen' && g !== 'f') return entry.name + (/(s|ß|x|z)$/.test(entry.name) ? 'es' : 's')
  return entry.name
}

// The placeholder the Inspector shows for a case form (key gen, dat, acc,
// genPl, …): what the sentences use when it is empty.
export function defaultForm(entry, key) {
  const plural = key.endsWith('Pl')
  return nounForm({ ...entry, forms: {} }, plural ? key.slice(0, -2) : key, plural)
}

// ── Numbers ──────────────────────────────────────────────────────────────────

const countOf = (q) => (q.op === '..' ? q.m : q.n)

// "höchstens einen", "mindestens 2", "mindestens einen und höchstens 3":
// one is declined like the article.
function quantifier(q, g, c) {
  const num = (n) => kw(n === 1 ? det('some', g, c) : String(n))
  if (q.op === '..') return [kw('mindestens'), num(q.n), kw('und höchstens'), num(q.m)]
  return [kw({ '≤': 'höchstens', '≥': 'mindestens', '=': 'genau', '>': 'mehr als' }[q.op] ?? q.op), num(q.n)]
}

// ── Verbs ────────────────────────────────────────────────────────────────────

const IRREGULAR = {
  ist: 'sind', hat: 'haben', wird: 'werden', kann: 'können', darf: 'dürfen', muss: 'müssen', soll: 'sollen',
  will: 'wollen', mag: 'mögen', weiß: 'wissen', tut: 'tun', war: 'waren', hatte: 'hatten', wurde: 'wurden',
}
// Strong verbs whose vowel changes in the singular; also with a prefix
// (enthält → enthalten, gehört is regular).
const STRONG = {
  gibt: 'geben', nimmt: 'nehmen', hält: 'halten', fällt: 'fallen', läuft: 'laufen', trägt: 'tragen',
  fährt: 'fahren', schläft: 'schlafen', lässt: 'lassen', wächst: 'wachsen', sieht: 'sehen', liest: 'lesen',
  geschieht: 'geschehen', empfiehlt: 'empfehlen', befiehlt: 'befehlen', spricht: 'sprechen', hilft: 'helfen',
  trifft: 'treffen', gilt: 'gelten', wirft: 'werfen', vergisst: 'vergessen', isst: 'essen', bricht: 'brechen',
  stirbt: 'sterben', wirbt: 'werben', tritt: 'treten', ergab: 'ergaben', erhielt: 'erhielten',
}
const PREFIXES = /^(be|ent|er|ge|ver|zer|emp|über|unter|wider|ab|an|auf|aus|bei|ein|mit|nach|vor|zu|zurück|teil|frei|fest|her|hin|weg)?$/

// The third person plural of a verb in the third person singular: belegt →
// belegen, arbeitet → arbeiten, koordiniert → koordinieren, ändert →
// ändern, regelt → regeln, ist → sind, nimmt → nehmen; null when it is not
// a form the rules know.
export function pluralVerb(w) {
  const lower = w.toLowerCase()
  if (IRREGULAR[lower]) return IRREGULAR[lower]
  for (const [s, p] of Object.entries(STRONG)) {
    if (lower.endsWith(s) && PREFIXES.test(lower.slice(0, -s.length))) return lower.slice(0, -s.length) + p
  }
  if (!/t$/.test(lower) || lower.length < 3) return null
  if (/iert$/.test(lower)) return `${lower.slice(0, -1)}en`
  if (/[^aeiouäöüi]ert$/.test(lower) || /[^aeiouäöüi]elt$/.test(lower)) return `${lower.slice(0, -1)}n`
  if (/et$/.test(lower)) return `${lower.slice(0, -1)}n`
  return `${lower.slice(0, -1)}en`
}

// Separable particles that join the finite verb at the end of a
// subordinate clause: "an Kurs teil" + "nimmt" → "an Kurs teilnimmt".
const PARTICLES = new Set(['ab', 'an', 'auf', 'aus', 'bei', 'ein', 'fest', 'fort', 'her', 'hin', 'los', 'mit', 'nach',
  'vor', 'weg', 'zu', 'zurück', 'zusammen', 'teil', 'statt', 'frei', 'dar', 'vorbei', 'weiter'])

// The reading's parts and slot cases for the environment: the plural verb,
// then the word order.
export function shapeReading(h, pick, elided) {
  const n = pick.roleOrder.length
  const cases = Array.from({ length: n }, (_, k) => pick.cases?.[k] || (k ? 'acc' : 'nom'))
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
      parts = [parts[0], words(pv, splitFirst(parts[1])[1]), ...parts.slice(2)]
      finite = pv
    } else return null
  }
  if (form === 'sub') {
    if (hasText(pick.subParts)) {
      if (!plural) return { parts: pick.subParts, cases }
      // The singular finite verb in the subordinate form becomes plural.
      const singular = splitFirst(pick.parts[1])[0]
      return { parts: pick.subParts.map(p => (p ?? '').split(/(\s+)/).map(w => (w === singular ? finite : w)).join('')), cases }
    }
    if (!finite) return { parts, cases }
    const out = [...parts]
    out[1] = splitFirst(parts[1])[1]
    const end = out[n]?.trim() ?? ''
    const m = /^(.*?)\s*(\S+)$/.exec(end)
    out[n] = m && PARTICLES.has(m[2].toLowerCase()) ? words(m[1], m[2] + finite) : words(end, finite)
    return { parts: out, cases }
  }
  if (form === 'inv') {
    const [verb, rest] = splitFirst(parts[1])
    return { parts: [verb, rest, ...parts.slice(2)], cases }
  }
  return { parts, cases }
}

// ── Noun phrases ─────────────────────────────────────────────────────────────

const gender = (h, v) => genderOf(h.entry(v))
const noun = (h, v, c = 'nom', plural = false) => typeTok(nounForm(h.entry(v), c, plural) + (typeof v === 'string' ? '' : h.subscript(v)))
const kindPlural = (kind) => !!kind && typeof kind === 'object' && countOf(kind) !== 1

// A noun phrase of the given kind for y, in case c: 'some' (ein Kurs),
// 'none' (kein Kurs), 'each' (jeder Kurs), 'that' (dieser Kurs), 'bare'
// (Kurs) or a counting quantifier node (höchstens einen Kurs, mindestens 2
// Kurse).
function np(h, y, kind, c = 'nom') {
  const g = gender(h, y)
  if (kind && typeof kind === 'object') return [quantifier(kind, g, c), noun(h, y, c, kindPlural(kind))]
  if (kind === 'bare') return noun(h, y, c)
  return [kw(det(kind, g, c)), noun(h, y, c)]
}

const PREPOSITIONS = new Set(['an', 'auf', 'aus', 'bei', 'durch', 'für', 'gegen', 'hinter', 'in', 'mit', 'nach', 'neben',
  'ohne', 'über', 'um', 'unter', 'von', 'vor', 'zu', 'zwischen', 'während', 'wegen'])

// A relative clause on x, verb last, as { pron, body }: ", der einen Kurs
// belegt", ", den ein Student belegt", ", in dem ein Studienjahr beginnt";
// the pronoun agrees with x and takes the case of x's slot. fills are
// further slot fillers (variable → phrase or case → phrase).
function relativeParts(h, a, x, plural, fills) {
  const g = gender(h, x)
  const vp = !fills && h.vp(a, x, { form: 'sub', ...(plural ? { verb: 'plural' } : {}) })
  if (vp) return { pron: [punct(','), kw(det('rel', g, 'nom', plural))], body: vp }
  if (a.t !== 'fact' || a.args.filter(z => z === x).length !== 1) return null
  let slotCase = 'acc'
  const gap = { text: '', cls: 'gap' }
  const body = h.with({ form: 'sub', verb: undefined }).reading(a, undefined,
    new Map([...(fills ?? []), [x, (c) => { slotCase = c || 'acc'; return gap }]]))
  if (!body) return null
  const i = body.indexOf(gap)
  const before = body[i - 1]
  const m = before?.cls === 'reading' ? /^(.*?)\s*(\S+)$/.exec(before.text) : null
  const pron = det('rel', g, slotCase, plural)
  if (m && PREPOSITIONS.has(m[2].toLowerCase())) {
    const out = [...body]
    out[i - 1] = tok(m[1], 'reading')
    return { pron: [punct(','), kw(`${m[2]} ${pron}`)], body: out }
  }
  return { pron: [punct(','), kw(pron)], body }
}
const relativeBody = (h, a, x, plural) => {
  const r = relativeParts(h, a, x, plural)
  return r && [r.pron, r.body, relEnd()]
}
// Relative clauses on one noun joined by "und", each but the first without
// its comma, and one closing comma: ", das Kurs betrifft und das ein
// Semester betrifft,".
const joinRelatives = (rels) => (rels.length ? [rels.map((r, i) => (i ? [kw('und'), r[0].slice(1), r[1]] : [r[0], r[1]])), relEnd()] : [])

// ", für den gilt, dass …" after the noun phrases ys introduced by "es
// gibt"; plural for several or a count above one.
const forWhich = (h, ys, plural) => [punct(','),
  kw(`für ${ys.length === 1 && !plural ? det('rel', gender(h, ys[0]), 'acc') : 'die'}`), kw('gilt'), punct(','), kw('dass')]

const suchThat = () => [kw('derart'), punct(','), kw('dass')]

// The noun phrase for y with relative clauses for the conjuncts about it,
// as a function of the case of its slot.
function withRelatives(h, y, kind, conj) {
  const plural = kindPlural(kind)
  const rels = []
  const other = []
  for (const a of conj) {
    const r = relativeBody(h, a, y, plural)
    if (r) rels.push(r)
    else other.push(a)
  }
  const cl = other.length ? joinPhrases(other.map(a => h.clause(a, { form: 'sub' })), 'und') : []
  if (cl === null) return null
  // ", der … und der …": the second relative clause without its comma.
  return (c) => [np(h, y, kind, c), other.length ? rels.map((r, i) => (i ? [kw('und'), r[0].slice(1), r[1]] : [r[0], r[1]])) : joinRelatives(rels),
    other.length ? [rels.length ? kw('und') : [], suchThat(), cl, relEnd()] : []]
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
  const parts = items.map(it => h.clause(it, { form: undefined }))
  if (parts.some(p => !p)) return null
  return [kw(intro), punct(':'), parts.flatMap((p, i) => (i ? [punct(';'), p] : [p]))]
}

// A verb with its complement in the environment's word order: "ist
// höchstens 30" / "höchstens 30 ist"; the verb plural with env.verb.
function verbPhrase(h, verb, complement) {
  const v = h.env.verb === 'plural' ? (pluralVerb(verb) ?? verb) : verb
  if (h.env.form === 'sub') return [complement, kw(v)]
  return [kw(v), complement]
}

const VALUE_OPS = { '≈': '', '≉': 'nicht', '<': 'kleiner als', '≤': 'höchstens', '>': 'größer als', '≥': 'mindestens' }

const PREDICATES = {
  startsWith: 'beginnt mit', endsWith: 'endet auf', contains: 'enthält',
  matches: 'entspricht dem regulären Ausdruck',
}

// "Kurstitel beginnt mit 'Intro'" / "… Kurstitel mit 'Intro' beginnt"
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
    const bound = { '≥': 'mindestens', '≤': 'höchstens', '>': 'mehr als', '<': 'weniger als' }
    return spec && spec.map(i => i.op === '..'
      ? (i.loOp === '≥' && i.hiOp === '≤' ? [h.term(i.lo), kw('bis'), h.term(i.hi)]
        : [kw(bound[i.loOp]), h.term(i.lo), kw('und'), kw(bound[i.hiOp]), h.term(i.hi)])
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

  // A noun phrase of a kind ("some", "none", "each", "that", "bare" or a
  // counting quantifier) for y in case c: np(?y, "each", "acc") is "jeden Kurs".
  np: (h, y, kind, c) => np(h, y, kind, c || 'nom'),
  // jeden Kurs und jedes Semester, in case c.
  eachList: (h, vs, c) => joinList(vs.map(v => np(h, v, 'each', c)), 'und'),
  // einen Mitarbeiter und einen Kurs (after "es gibt")
  someList: (h, ys) => joinList(ys.map(y => np(h, y, 'some', 'acc')), 'und'),
  // ", für den gilt, dass" after "es gibt": q the counting quantifier, if any.
  forWhich: (h, ys, q) => forWhich(h, ys, ys.length > 1 || (!!q && kindPlural(q))),
  relative: (h, a, x) => {
    const r = relativeBody(h, a, x, false)
    if (r) return r
    const c = h.clause(a, { form: 'sub' })
    return c && [suchThat(), c, relEnd()]
  },
  relativeBody: (h, a, x, q) => relativeBody(h, a, x, kindPlural(q)),
  clauseList: (h, intro, items) => clauseList(h, intro, items),
  objectQuantified: (h, x, y, body, kind) => objectQuantified(h, x, y, body, kind),
  anchoredClause: (h, y, body, kind) => anchoredClause(h, y, body, kind),
  commaList: (h, items) => items.flatMap((it, i) => (i ? [punct(','), it] : [it])),
  // The clauses joined by a connective; in inverted order only the first
  // is inverted ("dann ist A und B …").
  clauses: (h, fs, conj) => joinPhrases(fs.map((f, i) => h.clause(f, i && h.env.form === 'inv' ? { form: undefined } : {})), conj),
  vps: (h, fs, x, conj) => joinPhrases(fs.map(f => h.vp(f, x)), conj),
  // "genau eine Kombination von Gebäude und Raumnummer", "2 Kombinationen …"
  countedNP: (h, q, ys) => {
    if (ys.length === 1) return np(h, ys[0], q, 'acc')
    const one = countOf(q) === 1
    return [quantifier(q, 'f', 'acc'), kw(one ? 'Kombination von' : 'Kombinationen von'), joinList(ys.map(y => noun(h, y)), 'und')]
  },
  // "es gibt" and its object (accusative), in the environment's word order.
  thereIs: (h, np) => {
    if (h.env.form === 'sub') return [kw('es'), np, kw('gibt')]
    if (h.env.form === 'inv') return [kw('gibt es'), np]
    return [kw('es gibt'), np]
  },
  // "es ist nicht der Fall, dass …", in the environment's word order.
  notTrue: (h, clause) => {
    if (h.env.form === 'sub') return [kw('es nicht der Fall ist'), punct(','), kw('dass'), clause]
    if (h.env.form === 'inv') return [kw('ist es nicht der Fall'), punct(','), kw('dass'), clause]
    return [kw('es ist nicht der Fall'), punct(','), kw('dass'), clause]
  },
  // A type atom as a clause: "Mitarbeiter ist ein Professor".
  isAClause: (h, T, x) => {
    const np = [kw(det('some', gender(h, T), 'nom')), noun(h, T)]
    if (h.env.form === 'inv') return [kw('ist'), h.ref(x), np]
    return [h.ref(x), verbPhrase(h, 'ist', np)]
  },
  isA: (h, T) => (h.env.verb === 'plural'
    ? verbPhrase(h, 'ist', noun(h, T, 'nom', true))
    : verbPhrase(h, 'ist', [kw(det('some', gender(h, T), 'nom')), noun(h, T)])),
  notA: (h, T) => verbPhrase(h, 'ist', [kw(det('none', gender(h, T), 'nom')), noun(h, T)]),
  valueVP: (h, op, r) => verbPhrase(h, 'ist', [VALUE_OPS[op] ? kw(VALUE_OPS[op]) : [], h.term(r)]),
  valueClause: (h, op, l, r) => {
    const comp = [VALUE_OPS[op] ? kw(VALUE_OPS[op]) : [], h.term(r)]
    if (h.env.form === 'inv') return [kw('ist'), h.term(l), comp]
    return [h.term(l), verbPhrase(h, 'ist', comp)]
  },
  sameVP: (h, op, r) => verbPhrase(h, 'ist', [op === '=' ? [] : kw('nicht'), h.ref(r)]),
  predicateVP: (h, f) => predicate(h, f, []),
  predicateClause: (h, f) => predicate(h, f, h.term(f.args[0])),
  closure: (h, f) => seq(h.ref(f.args[0]), kw('ist über'),
    kw(f.star ? 'null oder mehr Schritte' : 'einen oder mehrere Schritte'), kw('mit'), h.ref(f.args[1], 'dat'),
    kw('verbunden'), punct(','), kw('jeweils von'), np(h, f.vars[0], 'some', 'dat'), kw('zu'),
    np(h, f.vars[1], 'some', 'dat'), kw('derart'), punct(','), kw('dass'), h.clause(f.body, { form: 'sub' })),
  directlyOrIndirectly: (h, f, x, t) => {
    const [v, w] = f.vars
    const sub = (a) => (a === v ? x : a === w ? t : a)
    const r = h.reading({ ...f.body, args: f.body.args.map(sub) }, x)
    return seq(r, punct(','), kw('direkt oder indirekt'),
      f.star ? [kw('oder ist'), t === x ? kw('es selbst') : h.ref(t)] : [])
  },
  exactlyOneEach: (h, ys, args, x) => joinPhrases(ys.map(y => h.vp({ t: 'count', op: '=', n: 1, vars: [y],
    body: args.find(a => occurs(a, y)) }, x)), 'und'),
  unknownNode: (h, f) => kw(`(${f?.t ?? '?'})`),
}

// ── Terms ────────────────────────────────────────────────────────────────────

// Data operators; {0:dat} puts the argument in the dative, {0:gen} in the
// genitive.
const OPERATION = {
  add: '{0} plus {1}', sub: '{0} minus {1}', mul: '{0} mal {1}', div: '{0} geteilt durch {1}',
  idiv: 'der ganzzahlige Teil von {0:dat} geteilt durch {1}', mod: 'der Rest von {0:dat} geteilt durch {1}',
  neg: 'minus {0}', abs: 'der Betrag von {0:dat}',
  least: 'der kleinere Wert von {0:dat} und {1:dat}', greatest: 'der größere Wert von {0:dat} und {1:dat}',
  round: '{0} gerundet auf {1} Nachkommastellen', roundInt: '{0} auf eine ganze Zahl gerundet',
  floor: '{0} abgerundet', ceiling: '{0} aufgerundet', truncate: '{0} abgeschnitten',
  power: '{0} hoch {1}', sqrt: 'die Quadratwurzel von {0:dat}',
  concat: '{0} gefolgt von {1:dat}', length: 'die Länge von {0:dat}',
  substring: 'der Teil von {0:dat} der Länge {2} ab Position {1}',
  upper: '{0} in Großbuchstaben', lower: '{0} in Kleinbuchstaben', trim: '{0} ohne Leerzeichen am Anfang und am Ende',
  toText: '{0} als Text', asInteger: '{0} als ganze Zahl', asDecimal: '{0} als Dezimalzahl', asFloat: '{0} als Gleitkommazahl', asBoolean: '{0} als Wahrheitswert', asDate: '{0} als Datum', asDatetime: '{0} als Datum und Uhrzeit', asTime: '{0} als Uhrzeit',
  year: 'das Jahr von {0:dat}', month: 'der Monat von {0:dat}', day: 'der Tag des Monats von {0:dat}',
  hour: 'die Stunde von {0:dat}', minute: 'die Minute von {0:dat}', second: 'die Sekunde von {0:dat}',
  dayOfWeek: 'der Wochentag von {0:dat}', yearsBetween: 'die Anzahl ganzer Jahre von {0:dat} bis {1:dat}',
  makeDate: 'das Datum mit Jahr {0}, Monat {1} und Tag {2}',
  dateOf: 'das Datum von {0:dat}', timeOf: 'die Uhrzeit von {0:dat}',
  totalMonths: '{0} in Monaten', totalDays: '{0} in Tagen', totalSeconds: '{0} in Sekunden',
}

function term(h, t, c) {
  if (isVar(t) || t?.t === 'wild') return h.ref(t, c)
  switch (t?.t) {
    case 'const': return tok(t.quoted ? `'${t.text}'` : t.text, 'const')
    case 'fn': return operation(h, t)
    case 'ite':
      return seq(punct('('), kw('wenn'), h.clause(t.cond, { form: 'sub' }), punct(','), kw('dann'), term(h, t.then),
        punct(','), kw('sonst'), term(h, t.else), punct(')'))
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
  const pattern = OPERATION[t.op] ?? `${def?.label ?? t.op} von ${t.args.map((a, i) => `{${i}:dat}`).join(' und ')}`
  return pattern.split(/(\{\d(?::\w+)?\})/).filter(Boolean).map(part => {
    const m = /^\{(\d)(?::(\w+))?\}$/.exec(part)
    if (m) return arg(t.args[Number(m[1])], Number(m[1]), m[2])
    const [, comma, ws] = /^\s*(,?)\s*(.*?)\s*$/.exec(part)
    return [comma ? punct(',') : [], ws ? kw(ws) : []]
  })
}

const AGG_LABELS = { count: 'die Anzahl', sum: 'die Summe', avg: 'der Durchschnitt', min: 'der kleinste Wert', max: 'der größte Wert' }

//   Count{y : φ}               die Anzahl der Studenten, die diesen Kurs belegen
//   F{y | y : φ}               die Summe aller Leistungspunktzahlen, die …
//   F{k | c, k : φ ∧ R(c, k)}  die Summe der Leistungspunktzahlen, die jeder
//                              Kurs, den dieser Student belegt, hat
function aggregate(h, t) {
  const label = AGG_LABELS[t.fn] ?? t.fn
  const distinct = t.distinct ? [kw('verschiedenen')] : []
  const conj = t.cond?.t === 'and' ? t.cond.args : t.cond?.t === 'true' ? [] : [t.cond]
  if (t.vars.length === 1 && (!t.term || t.term === t.vars[0])) {
    const y = t.vars[0]
    const rels = conj.map(a => relativeParts(h, a, y, true)).map(r => r && [r.pron, r.body])
    if (rels.every(Boolean)) {
      return [kw(label), kw(t.term ? 'aller' : 'der'), distinct, noun(h, y, 'gen', true), joinRelatives(rels)]
    }
  }
  if (t.vars.length === 2 && t.term && t.vars.includes(t.term)) {
    const k = t.term, c = t.vars.find(v => v !== k)
    const link = conj.find(a => a.t === 'fact' && a.args.length === 2 && a.args.includes(c) && a.args.includes(k))
    const restC = conj.filter(a => a !== link)
    if (link && restC.every(a => !occurs(a, k))) {
      const cNP = withRelatives(h, c, 'each', restC)
      const r = cNP && relativeParts(h, link, k, true, new Map([[c, cNP]]))
      if (r) return [kw(label), kw('der'), distinct, noun(h, k, 'gen', true), r.pron, r.body, relEnd()]
    }
  }
  const what = t.vars.length === 1 ? [kw('der'), noun(h, t.vars[0], 'gen', true)]
    : [kw('der Kombinationen von'), joinList(t.vars.map(v => noun(h, v)), 'und')]
  const cond = h.clause(t.cond, { form: 'sub' })
  if (!t.term) return seq(kw(label), distinct, what, suchThat(), cond, relEnd())
  return seq(kw(label), kw('von'), distinct, term(h, t.term, 'dat'), kw('über alle'),
    t.vars.length === 1 ? noun(h, t.vars[0], 'acc', true) : [kw('Kombinationen von'), joinList(t.vars.map(v => noun(h, v)), 'und')],
    suchThat(), cond, relEnd())
}

// ── Commas ──────────────────────────────────────────────────

// The closing commas of relative clauses (relEnd) become commas unless
// punctuation or the end of the sentence follows, or another comma came
// just before. A definite article is not contracted with a preposition (in
// dem, not im): the population sentences use it only before a relative
// clause ("in dem Raum, der …").
export function contract(flat) {
  const out = []
  for (let i = 0; i < flat.length; i++) {
    const t = flat[i]
    if (t.cls === 'relEnd') {
      const next = flat.slice(i + 1).find(x => x.cls !== 'relEnd')
      const prev = out[out.length - 1]
      if (!next || next.cls === 'punct' || prev?.text === ',') continue
      out.push({ ...t, cls: 'punct' })
      continue
    }
    out.push(t)
  }
  return out
}

// ── Population sentences (src/verbalisation/population.js) ──────────────────
// The same functions as englishPopulation (english.js), with cases and the
// word order of dutchPopulation: "der Raum, der in Gebäude 'MAL' liegt",
// "die Einschreibung, in der Student 'P1' Kurs 'DB1' belegt". A name with a
// value and no article (Student 'P1') reads as a label and stays in the
// nominative; with the article it takes the case of its slot.

const sub = (h) => h.with({ form: 'sub', verb: undefined })

// The opening words text of a nominal reading in case c; entry is the type's
// lexicon entry, forms the reading's own case forms. When the words start
// with the type's own name, that name is declined.
export function declineNominalHead(entry, text, c = 'nom', forms) {
  if (c === 'nom') return text
  if (forms?.[c]?.trim()) return forms[c].trim()
  const [first, more] = splitFirst(text)
  if (!first || first.toLowerCase() !== entry?.name?.toLowerCase()) return text
  return words(nounForm(entry, c), more)
}

export const germanPopulation = {
  name: (h, typeId, c = 'nom', definite = false) => noun(h, typeId, definite ? c : 'nom'),
  the: (h, typeId, label, c = 'nom') => kw(det('the', gender(h, typeId), c)),
  // Buch mit ISBN '…'
  withValue: (h, vtId, value) => [kw('mit'), noun(h, vtId), value],
  // die Einschreibung, in der Student 'P1' Kurs 'DB1' belegt
  inWhich: (h, typeId, build) => {
    const c = build(sub(h))
    return c && [punct(','), kw(`in ${det('rel', gender(h, typeId), 'dat')}`), c, relEnd()]
  },
  // der Raum, der in Gebäude 'MAL' liegt und Raumnummer '151' hat
  relative: (h, typeId, build) => {
    const vps = build(sub(h))
    return vps && [punct(','), kw(det('rel', gender(h, typeId), 'nom')), joinList(vps, 'und'), relEnd()]
  },
  thereIs: (h, typeId, rest) => [kw('es gibt'), kw(det('some', gender(h, typeId), 'acc')), noun(h, typeId, 'acc'), rest],
  isA: (h, subject, typeId) => [subject, kw('ist'), kw(det('some', gender(h, typeId), 'nom')), noun(h, typeId)],
  // Personen und Studenten werden durch Personennummer bezeichnet.
  referredTo: (h, typeIds, vtId) => [joinList(typeIds.map(t => noun(h, t, 'nom', true)), 'und'),
    kw('werden durch'), noun(h, vtId), kw('bezeichnet')],
  derived: 'abgeleitet',
  // The case of a slot of a nominal reading when it gives none: Einschreibung
  // von Student 'P1' (dative after von).
  nominalCase: 'dat',
  nominalHead: (h, typeId, text, c = 'nom', forms) => declineNominalHead(h.entry(typeId), text, c, forms),
}

export const germanLibrary = {
  id: 'de',
  label: 'Deutsch',
  functions,
  term: (h, t) => term(h, t),
  // "dieser Kurs", "diesen Kurs", or bare in a Wenn … dann … sentence;
  // "denselben Kurs" for the variables in env.same (negative.js).
  // A bare name reads as a label and stays in the nominative.
  refNP: (h, v, c = 'nom') => (h.env.same?.includes(v) ? [kw(det('same', gender(h, v), c)), noun(h, v, c)]
    : h.env.refStyle === 'bare' ? noun(h, v)
    : [kw(det('that', gender(h, v), c)), noun(h, v, c)]),
  // "ein Kurs", or "kein Kurs" in a negated atom (env.none).
  wildNP: (h, w, c = 'nom') => np(h, w, h.env.none ? 'none' : 'some', c),
  reflexive: () => kw('sich selbst'),
  pluralise: (name) => pluralise(name),
  shapeReading,
  contract,
  population: germanPopulation,
}
