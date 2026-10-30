// The library shared by the Romance languages (French, Italian, Spanish):
// structural tests and phrase builders for their rule files, parametrised by
// a profile of words and morphology (french.js, italian.js, spanish.js).
//
// The word order is the English one, so the phrase builders follow
// english.js. What differs:
//   gender    'm' or 'f' (from the lexicon, 'm' by default) chooses the
//             articles and demonstratives: un/une, ce/cette, un/una, quel/quella
//   negation  a particle before the verb, and in French "pas" after it:
//             env.verb 'negated' gives "ne suit pas", 'ne' only the particle,
//             as with "aucun": "ne suit aucun Cours"; env.none makes a
//             wildcard "aucun Cours" and negates the verb of its reading
//   relatives a preposition before the gap moves to the pronoun: "dans
//             laquelle", "in cui", "en la que"
//   contract  the profile's contractions of neighbouring words: "que un" →
//             "qu'un", "un studente" → "uno studente", "y Inscripción" → "e
//             Inscripción" (see makeContract)

import { isVar } from '../match.js'
import {
  occurs, rangeSpec, exclusionItems, exclusiveOrItems, sameUpToWild, distributable, isComplex, isSingular, subjectOf,
} from '../structure.js'
import { tok, seq } from '../engine.js'
import { joinList, joinPhrases, operation } from './english.js'
import { PREDS } from '../../logic/dataOperators.js'

const kw = (s) => tok(s, 'kw')
const punct = (s) => tok(s, 'punct')
const hasText = (parts) => Array.isArray(parts) && parts.some(p => p?.trim())

export const splitFirst = (text) => {
  const m = /^\s*(\S+)\s*(.*)$/s.exec(text ?? '')
  return m ? [m[1], m[2]] : ['', '']
}
const words = (...ws) => ws.filter(Boolean).join(' ')

// Plural of a name whose head is its first word, the words up to a
// preposition pluralised by plural(word): "Année universitaire" →
// "Années universitaires", "Numéro de personne" → "Numéros de personne".
export function pluraliseName(name, plural, prepositions) {
  const m = /^(.*?)([₀-₉]*)$/u.exec(name)
  const ws = m[1].split(' ')
  const stop = ws.findIndex((w, i) => i > 0 && prepositions.has(w.toLowerCase()))
  return ws.map((w, i) => (stop < 0 || i < stop ? plural(w) : w)).join(' ') + m[2]
}

// Contractions of neighbouring words. A rule
//   { word, next: /regex/, to, glue }   replaces word when the next word
//                                       matches (glue: no space after it)
//   { word, nextWord, to }              replaces the two words by one
// applies within a token and across tokens.
export function makeContract(rules, punctMap = {}) {
  const find = (w, nw) => rules.find(r => r.word === w.toLowerCase() &&
    (r.nextWord ? nw?.toLowerCase() === r.nextWord : r.next.test(nw ?? '')))
  const keepCase = (from, to) => (from[0] === from[0].toUpperCase() && from[0] !== from[0].toLowerCase()
    ? to[0].toUpperCase() + to.slice(1) : to)
  return (tokens) => {
    const out = tokens.map(t => (t.cls === 'punct' && punctMap[t.text] ? { ...t, text: punctMap[t.text], glue: true } : { ...t }))
    for (let i = 0; i < out.length; i++) {
      const t = out[i]
      if (t.cls === 'punct' || t.cls === 'const') continue
      const ws = t.text.split(' ')
      let text = ''
      for (let j = 0; j < ws.length; j++) {
        const w = ws[j]
        const inToken = j + 1 < ws.length
        const next = inToken ? ws[j + 1] : out.slice(i + 1).find(x => x.text)
        const nw = inToken ? next : (next?.cls === 'punct' ? null : next?.text.split(' ')[0])
        const r = nw ? find(w, nw) : null
        const sep = j ? (text.endsWith("'") ? '' : ' ') : ''
        if (!r) { text += sep + w; continue }
        const to = keepCase(w, r.to)
        if (r.nextWord) {
          text += sep + to
          if (inToken) j++
          else next.text = next.text.split(' ').slice(1).join(' ')
        } else {
          text += sep + to
          if (r.glue && !inToken) next.glue = true
        }
      }
      t.text = text
    }
    return out
  }
}

// ── The library ──────────────────────────────────────────────────────────────

export function romanceLibrary(P) {
  const gender = (h, v) => (h.gender(v) === 'f' ? 'f' : 'm')
  const typeTok = (s) => tok(s, 'type')
  const number = (h, n, g) => kw(n === 1 ? P.one(g) : String(n))

  // A verb (the first word of text) in the environment's form: plural, or
  // negated; null when the profile cannot make the plural.
  function verbForm(h, text, verb = h.env.verb) {
    let [w, rest] = splitFirst(text)
    if (!w) return text
    if (verb === 'plural') {
      w = P.pluralVerb(w)
      if (!w) return null
    }
    if (verb === 'negated') return words(P.negation, w, P.negationAfter, rest)
    if (verb === 'ne') return words(P.negation, w, rest)
    return words(w, rest)
  }
  const verbKw = (h, text) => {
    const v = verbForm(h, text)
    return v === null ? null : kw(v)
  }

  // A reading's parts for the environment: the plural form, and the verb
  // (the first word after the first slot) negated. In Italian and Spanish a
  // "nessun"/"ningún" before the verb takes no "non"/"no" (P.noneBeforeVerb).
  function shapeReading(h, pick, elided, atom) {
    let parts = pick.parts
    const verb = h.env.verb
    if (verb === 'plural' && hasText(pick.pluralParts)) parts = pick.pluralParts
    else if (verb === 'plural') {
      const v = verbForm(h, parts[1], 'plural')
      if (v === null) return null
      parts = [parts[0], v, ...parts.slice(2)]
    }
    const noneFirst = P.noneBeforeVerb && !verb && h.env.none && !elided && atom?.args[pick.roleOrder[0]]?.t === 'wild'
    const neg = verb === 'negated' ? 'negated' : (verb === 'ne' || (h.env.none && !noneFirst)) ? 'ne' : null
    if (neg) {
      if (!parts[1]?.trim()) return null
      parts = [parts[0], verbForm(h, parts[1], neg), ...parts.slice(2)]
    }
    return parts
  }

  const names = (h, vs) => joinList(vs.map(v => typeTok(h.name(v))), P.and)
  const everyList = (h, vs) => joinList(vs.map(v => [kw(P.each), typeTok(h.name(v))]), P.and)

  function quantifier(h, q, g) {
    if (q.op === '..') return [kw(P.quant['≥']), number(h, q.n, g), kw(`${P.and} ${P.quant['≤']}`), number(h, q.m, g)]
    return [kw(P.quant[q.op] ?? q.op), number(h, q.n, g)]
  }
  const quantNP = (h, q, v) => [quantifier(h, q, gender(h, v)), typeTok(isSingular(q.op, q.n) ? h.name(v) : h.plural(v))]

  // "tel que", "telle que", "tels que": agreeing with the variables ys,
  // or with a combination of them (feminine in all three languages).
  const suchThat = (h, ys, plural) => kw(P.suchThat(ys.length === 1 ? gender(h, ys[0]) : 'f', plural || false))

  // A relative clause on x as { pron, body }: "qui suit un Cours", or with x
  // as the object "que un Étudiant suit"; a preposition before the gap joins
  // the pronoun: "dans laquelle une Année universitaire commence".
  function relativeParts(h, a, x, extra, fills) {
    const plural = extra?.verb === 'plural'
    const vp = !fills && h.vp(a, x, extra)
    if (vp) return { pron: kw(P.relSubj), body: vp }
    if (a.t !== 'fact' || a.args.filter(z => z === x).length !== 1) return null
    const gap = { text: '', cls: 'gap' }
    const body = h.with({ verb: undefined }).reading(a, undefined, new Map([...(fills ?? []), [x, gap]]))
    if (!body) return null
    const i = body.indexOf(gap)
    const before = body[i - 1]
    const m = before?.cls === 'reading' ? /^(.*?)\s*(\S+)$/.exec(before.text) : null
    if (m && P.prepositions.has(m[2].toLowerCase())) {
      const pron = P.relPrep(m[2].toLowerCase(), gender(h, x), plural)
      if (pron) {
        const out = [...body]
        out[i - 1] = tok(m[1], 'reading')
        return { pron: kw(pron), body: out }
      }
    }
    return { pron: kw(P.relObj), body }
  }
  const relativeBody = (h, a, x, extra) => {
    const r = relativeParts(h, a, x, extra)
    return r && [r.pron, r.body]
  }
  function relative(h, a, x, extra) {
    const r = relativeBody(h, a, x, extra)
    if (r) return r
    const c = h.clause(a)
    return c && [suchThat(h, [x]), c]
  }

  // A noun phrase np for y with relative clauses for the conjuncts about it.
  function withRelatives(h, np, y, conj, extra) {
    if (!conj.length) return np
    const vps = conj.map(a => h.vp(a, y, extra))
    if (vps.every(Boolean)) return [np, kw(P.relSubj), joinPhrases(vps, P.and)]
    const parts = conj.map(a => relativeBody(h, a, y, extra))
    const rel = parts.filter(Boolean).flatMap((p, i) => [i ? kw(P.and) : [], p])
    const other = conj.filter((a, i) => !parts[i])
    if (!other.length) return [np, rel]
    const cl = joinPhrases(other.map(a => h.clause(a)), P.and)
    return cl && [np, rel, rel.length ? kw(P.and) : [], suchThat(h, [y], extra?.verb === 'plural'), cl]
  }

  function clauseList(h, intro, items) {
    const parts = items.map(it => h.clause(it))
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

  const isA = (h, T) => {
    if (h.env.verb === 'plural') return [kw(P.isA.plural), typeTok(h.typePlural(T))]
    return seq(verbKw(h, P.isA.verb), kw(P.some(h.gender(T) === 'f' ? 'f' : 'm')), typeTok(h.typeLabel(T)))
  }

  const predicateLabel = (f) => P.predicates[f.op] ?? PREDS[f.op]?.label ?? f.op

  const functions = {
    rangeItems: (h, body, x) => {
      const spec = rangeSpec(body, x)
      return spec && spec.map(i => i.op === '..'
        ? (i.loOp === '≥' && i.hiOp === '≤' ? [kw(P.range[0]), h.term(i.lo), kw(P.range[1]), h.term(i.hi)]
          : [kw(P.quant[i.loOp]), h.term(i.lo), kw(P.and), kw(P.quant[i.hiOp]), h.term(i.hi)])
        : i.op === '≈' ? [h.term(i.value)] : [kw(P.quant[i.op]), h.term(i.value)])
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

    // Determiners that agree with the variable's gender.
    some: (h, v) => kw(P.some(gender(h, v))),
    none: (h, v) => kw(P.none(gender(h, v))),
    everyList: (h, vs) => everyList(h, vs),
    // "tel que" for the variables ys; plural for a count other than one.
    suchThat: (h, ys, q) => suchThat(h, ys, q ? !isSingular(q.op, q.n) : ys.length > 1),
    names: (h, vs) => names(h, vs),
    relPron: () => kw(P.relSubj),
    relative: (h, a, x, extra) => relative(h, a, x, extra),
    relativeBody: (h, a, x, extra) => relativeBody(h, a, x, extra),
    clauseList: (h, intro, items) => clauseList(h, intro, items),
    objectQuantified: (h, x, y, body, np) => objectQuantified(h, x, y, body, np),
    anchoredClause: (h, y, body, np) => anchoredClause(h, y, body, np),
    quantNP: (h, q, y) => quantNP(h, q, y),
    quantifier: (h, q, ys) => quantifier(h, q, ys.length === 1 ? gender(h, ys[0]) : 'f'),
    commaList: (h, items) => items.flatMap((it, i) => (i ? [punct(','), it] : [it])),
    clauses: (h, fs, conj) => joinPhrases(fs.map(f => h.clause(f)), conj),
    vps: (h, fs, x, conj) => joinPhrases(fs.map(f => h.vp(f, x)), conj),
    someList: (h, ys) => joinList(ys.map(y => [kw(P.some(gender(h, y))), typeTok(h.name(y))]), P.and),
    countedNP: (h, q, ys) => {
      const one = isSingular(q.op, q.n)
      return ys.length === 1
        ? typeTok(one ? h.name(ys[0]) : h.plural(ys[0]))
        : [kw(one ? P.combination[0] : P.combination[1]), names(h, ys)]
    },
    // "Cours₁ n'est pas un prérequis pour Cours₃", "Étudiant ne suit aucun
    // Cours": ¬A as its subject and the negated verb phrase.
    negatedClause: (h, a) => {
      let x
      if (a.t === 'exists') x = a.vars.length === 1 && a.body.t === 'fact' ? a.body.args.find(z => isVar(z) && z !== a.vars[0]) : null
      else x = a.t === 'type' ? a.arg : a.args.find(isVar)
      return x ? seq(h.ref(x), h.vp(a, x, { verb: 'negated' })) : null
    },
    isA: (h, T) => isA(h, T),
    // The words of a value comparison, the verb inflected in a verb phrase.
    valueOp: (h, op, inVP) => (P.valueOps[op] ? (inVP ? verbKw(h, P.valueOps[op]) : kw(P.valueOps[op])) : kw(op)),
    sameVP: (h, op, r) => seq(verbKw(h, op === '=' ? P.isA.verb : words(P.negation, P.isA.verb, P.negationAfter)), h.ref(r)),
    predicateLabel: (h, f) => kw(predicateLabel(f)),
    dataPredicate: (h, f) => f.args.length === 2
      ? [h.term(f.args[0]), kw(predicateLabel(f)), h.term(f.args[1])]
      : [kw(predicateLabel(f)), punct('('), joinList(f.args.map(a => h.term(a)), P.and), punct(')')],
    closure: (h, f) => seq(h.ref(f.args[0]), kw(P.closure.linked), h.ref(f.args[1]),
      kw(f.star ? P.closure.star : P.closure.plus), kw(P.some(gender(h, f.vars[0]))), typeTok(h.name(f.vars[0])),
      kw(P.closure.to), kw(P.some(gender(h, f.vars[1]))), typeTok(h.name(f.vars[1])),
      suchThat(h, [f.vars[1]]), h.clause(f.body)),
    directlyOrIndirectly: (h, f, x, t) => {
      const [v, w] = f.vars
      const sub = (a) => (a === v ? x : a === w ? t : a)
      const r = h.reading({ ...f.body, args: f.body.args.map(sub) }, x)
      return seq(r, punct(','), kw(P.directly),
        f.star ? [kw(P.orIs), t === x ? kw(P.reflexive(gender(h, x))) : h.ref(t)] : [])
    },
    exactlyOneEach: (h, ys, args, x) => joinPhrases(ys.map(y => h.vp({ t: 'count', op: '=', n: 1, vars: [y],
      body: args.find(a => occurs(a, y)) }, x)), P.and),
    unknownNode: (h, f) => kw(`(${f?.t ?? '?'})`),
  }

  function term(h, t) {
    if (isVar(t) || t?.t === 'wild') return h.ref(t)
    switch (t?.t) {
      case 'const': return tok(t.quoted ? `'${t.text}'` : t.text, 'const')
      case 'fn': return operation(h, t, P.operations, P.operationFallback, P.and)
      case 'ite':
        return seq(punct('('), kw(P.ite[0]), h.clause(t.cond), kw(P.ite[1]), term(h, t.then), kw(P.ite[2]), term(h, t.else), punct(')'))
      case 'agg': return aggregate(h, t)
      default: return kw('?')
    }
  }

  //   Count{y : φ}               le nombre d'Étudiants qui suivent Cours
  //   F{y | y : φ}               la somme de tous les Crédits qui …
  //   F{k | c, k : φ ∧ R(c, k)}  la somme des Crédits que vaut chaque Cours
  //                              que Étudiant suit
  function aggregate(h, t) {
    const label = P.aggregates[t.fn] ?? t.fn
    const distinct = t.distinct ? [kw(P.distinct)] : []
    const conj = t.cond?.t === 'and' ? t.cond.args : t.cond?.t === 'true' ? [] : [t.cond]
    if (t.vars.length === 1 && (!t.term || t.term === t.vars[0])) {
      const y = t.vars[0]
      const r = withRelatives(h, [], y, conj, { verb: 'plural' })
      if (r) return [kw(label), kw(t.term ? P.allOf(gender(h, y)) : P.of), distinct, typeTok(h.plural(y)), r]
    }
    if (t.vars.length === 2 && t.term && t.vars.includes(t.term)) {
      const k = t.term, c = t.vars.find(v => v !== k)
      const link = conj.find(a => a.t === 'fact' && a.args.length === 2 && a.args.includes(c) && a.args.includes(k))
      const restC = conj.filter(a => a !== link)
      if (link && restC.every(a => !occurs(a, k))) {
        const cNP = withRelatives(h, [kw(P.each), typeTok(h.name(c))], c, restC)
        const r = cNP && relativeParts(h, link, k, undefined, new Map([[c, cNP]]))
        if (r) return [kw(label), kw(P.ofThe(gender(h, k))), distinct, typeTok(h.plural(k)), r.pron, r.body]
      }
    }
    const what = t.vars.length === 1 ? typeTok(h.plural(t.vars[0])) : [kw(P.combination[1]), names(h, t.vars)]
    const cond = h.clause(t.cond)
    const such = suchThat(h, t.vars.length === 1 ? t.vars : [t.vars[0], t.vars[1]], true)
    if (!t.term) return seq(kw(label), kw(P.of), distinct, what, such, cond)
    return seq(kw(label), kw(P.of), distinct, term(h, t.term), kw(P.overAll), what, such, cond)
  }

  return {
    id: P.id,
    label: P.label,
    functions,
    term,
    // "la même Adresse e-mail" for the variables in env.same (negative.js).
    refNP: (h, v) => (h.env.same?.includes(v) ? [kw(P.same(gender(h, v))), typeTok(h.name(v))] : h.env.refStyle === 'bare' ? typeTok(h.name(v)) : [kw(P.that(gender(h, v))), typeTok(h.name(v))]),
    // "un Cours", or "aucun Cours" in a negated atom (env.none).
    wildNP: (h, w) => [kw(h.env.none ? P.none(gender(h, w)) : P.some(gender(h, w))), typeTok(h.name(w))],
    reflexive: (h, v) => kw(P.reflexive(gender(h, v))),
    pluralise: (name) => pluraliseName(name, P.pluralWord, P.prepositions),
    shapeReading,
    contract: P.contract,
  }
}
