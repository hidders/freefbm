// Verbalisation engine: turns a formula of the ORM2 logic (src/logic/formula.js)
// into a sentence, using the rules of a language definition.
//
// Pipeline (see the design doc "Verbalisation DSL: review and plan"):
//   1. normalise   the wildcard rewrite (normalise.js)
//   2. names       variables get the names the Formalisation tab shows
//                  (renderFormula), so formula and sentence agree
//   3. rules       first-match rules per phrase kind, which build phrases
//   4. linearise   spacing, capitals and the full stop
//
// A language is { id, label, rules: { sentence, clause, vp }, ...helpers }.
// A rule is { name, match, guard?, template }:
//   match     a pattern (match.js); in 'vp' rules ?subj is pre-bound to the
//             subject variable, whose slot the verb phrase leaves out
//   guard     optional (bindings, h, node) => boolean, structural tests only
//   template  (bindings, h, node) => phrase, or null to let later rules try
// A phrase is a (nested) array of tokens { text, cls }, cls one of
// 'kw' (fixed words), 'type' (object types and variables), 'reading',
// 'const' (values) and 'punct'.
//
// Rules are tried in order, so idioms come before the generic rule for the
// same node type; each language ends every phrase kind with generic rules
// that accept any node, so every formula gets a sentence.

import { renderFormula } from '../logic/renderFormula.js'
import { normalise } from './normalise.js'
import { negativeForm } from './negative.js'
import { match, isVar } from './match.js'
import { readingsFor, typeLexicon, hasText } from './lexicon.js'

export const tok = (text, cls = 'kw') => ({ text, cls })

// Concatenates phrases; null if any part is null (a sub-phrase failed).
export function seq(...parts) {
  return parts.some(p => p === null) ? null : parts
}

// Verbalises a formula. Returns { tokens, text, trace }: tokens carry a
// space flag (whether a space precedes them) for rendering, trace lists the
// rules that built the sentence, outermost first. With options.stats (a Map),
// every rule tried counts there, under 'kind: name', how often its pattern
// matched ({ matched }), its guard then failed ({ rejected }) and its
// template failed ({ failed }); see analysis.js. With options.negative the
// sentence says what the formula rules out (negative.js), when it can; the
// result's formula is then the rewritten one.
export function verbalise(input, ctx, language, options = {}) {
  const formula = (options.negative && negativeForm(input)) || input
  const names = new Map()
  renderFormula(formula, ctx, names)
  const trace = []
  const phrase = makePhraser(ctx, language, names, trace, options.stats)
  const out = phrase('sentence', normalise(formula), {})
  if (!out) throw new Error('no rule applies')
  return { ...linearise(out, language), trace, formula }
}

function makePhraser(ctx, lang, names, trace, stats) {
  // Names come from the language's lexicon; subscripts (Course₁) from the
  // names the formula shows.
  const lex = (typeId) => typeLexicon(ctx, typeId, lang.id)
  const typeIdsOf = (v) => (v.typeIds?.length > 1 ? v.typeIds : [v.typeId])
  const baseName = (v) => typeIdsOf(v).map(t => lex(t).name).join('&')
  const subscript = (v) => (v.t === 'wild' ? '' : /[₀-₉]*$/u.exec(names.get(v) ?? '')[0])
  const pluralOf = (typeId) => lex(typeId).plural ?? lang.pluralise?.(lex(typeId).name) ?? lex(typeId).name

  function phrase(as, node, env) {
    const seed = env.subject !== undefined ? { '?subj': env.subject } : {}
    for (const rule of lang.rules[as] ?? []) {
      const b = match(rule.match, node, seed)
      if (!b) continue
      const key = `${as}: ${rule.name}`
      const count = (field) => {
        if (!stats) return
        const s = stats.get(key) ?? { matched: 0, rejected: 0, failed: 0 }
        s[field]++
        stats.set(key, s)
      }
      count('matched')
      const h = helpers(env)
      if (rule.guard && !rule.guard(b, h, node)) { count('rejected'); continue }
      const mark = trace.length
      trace.push(key)
      const out = rule.template(b, h, node)
      if (out) return out
      count('failed')
      trace.length = mark
    }
    return null
  }

  function helpers(env) {
    const h = {
      env, ctx, lang,
      with: (extra) => helpers({ ...env, ...extra }),
      sentence: (node) => phrase('sentence', node, { ...env, subject: undefined, verb: undefined }),
      clause: (node, extra) => phrase('clause', node, { ...env, verb: undefined, ...extra, subject: undefined }),
      // env.verb (a verb form such as plural or negated, see lang.verbForm)
      // carries over to verb phrases about the same subject only.
      vp: (node, subject, extra) => phrase('vp', node,
        { ...env, verb: subject === env.subject ? env.verb : undefined, ...extra, subject }),
      // The variable's name with its subscript (Course₁), the bare type name
      // (Course), and the plural (Courses₁), all in the language.
      name: (v) => baseName(v) + subscript(v),
      baseName,
      plural: (v) => (typeIdsOf(v).length > 1 ? baseName(v) : pluralOf(v.typeId)) + subscript(v),
      // The same for a type given by its id.
      typeLabel: (typeId) => lex(typeId).name,
      typePlural: (typeId) => pluralOf(typeId),
      // The subscript of a variable's name ('₂', or '').
      subscript,
      // The lexicon entry of a variable's type, or of a type given by its id,
      // in the language: { name, plural, gender, forms } (forms: case forms,
      // as in Polish; {} if none).
      entry: (vOrTypeId) => lex(typeof vOrTypeId === 'string' ? vOrTypeId : vOrTypeId.typeId),
      // The grammatical gender the lexicon gives the type (null if none).
      gender: (vOrTypeId) => lex(typeof vOrTypeId === 'string' ? vOrTypeId : vOrTypeId.typeId).gender,
      objectType: (v) => ctx.otById.get(v.typeId),
      // A reference to a variable already introduced, or a wildcard; c is
      // the grammatical case of its slot, for languages with cases.
      ref: (v, c) => (v?.t === 'wild' ? lang.wildNP(h, v, c) : lang.refNP(h, v, c)),
      reading: (atom, subject, overrides) => reading(h, atom, subject, overrides),
      term: (t) => lang.term(h, t),
    }
    return h
  }

  // The fact type (or implied link) of a fact atom.
  const factOf = (atom) => ctx.factById.get(atom.factId) ?? ctx.linkById?.get(atom.factId)

  // Renders a fact atom with one of its readings in the language (see
  // lexicon.js). With a subject, only a reading that starts with the
  // subject's role (with nothing before it) is used, and the subject's slot
  // is left out: the verb phrase. Without one, a reading that starts with a
  // variable already introduced is preferred (as in "that Course has some
  // CourseTitle"), else the primary reading. The language shapes the
  // reading's parts for the environment (lang.shapeReading(h, reading,
  // elided, atom): verb forms, word order; null fails the reading, and it may return { parts, cases } to
  // change the cases too). overrides maps variables to the phrases that fill
  // their slots, or to functions from the slot's case to such a phrase.
  // A reading may give each slot a grammatical case (cases[k], Polish).
  function reading(h, atom, subject, overrides = new Map()) {
    const fact = factOf(atom)
    if (!fact) return null
    const n = atom.args.length
    const all = readingsFor(fact, lang.id, n, ctx.liveLanguage)
    const empty0 = (r) => !r.parts[0]?.trim()
    let pick
    if (subject !== undefined) {
      const si = atom.args.indexOf(subject)
      if (si < 0) return null
      pick = all.find(r => r.roleOrder[0] === si && empty0(r))
    } else {
      pick = all.find(r => { const a = atom.args[r.roleOrder[0]]; return isVar(a) && !overrides.has(a) && empty0(r) }) ?? all[0]
    }
    if (!pick) return null
    const shaped = (lang.shapeReading ?? shapeReading)(h, pick, subject !== undefined, atom)
    if (!shaped) return null
    const parts = Array.isArray(shaped) ? shaped : shaped.parts
    const cases = (Array.isArray(shaped) ? null : shaped.cases) ?? pick.cases ?? []
    const out = []
    let subjectSeen = false
    for (let k = 0; k <= n; k++) {
      const part = parts[k]?.trim()
      if (part) out.push(tok(part, 'reading'))
      if (k === n) break
      const arg = atom.args[pick.roleOrder[k]]
      const c = cases[k] || undefined
      if (subject !== undefined && arg === subject) {
        if (subjectSeen) out.push(lang.reflexive(h, arg, c))
        subjectSeen = true
      } else if (overrides.has(arg)) {
        const o = overrides.get(arg)
        const filled = typeof o === 'function' ? o(c) : o
        if (filled === null) return null
        out.push(filled)
      } else out.push(h.ref(arg, c))
    }
    return out
  }

  // The default shaping: with a plural subject the reading's plural form if
  // it has one, else the first word of the verb phrase inflected by
  // lang.verbForm for env.verb (null when it cannot be).
  function shapeReading(h, pick, elided) {
    if (h.env.verb === 'plural' && hasText(pick.pluralParts)) return pick.pluralParts
    if (!elided || !h.env.verb || !lang.verbForm || !pick.parts[1]?.trim()) return pick.parts
    const verb = lang.verbForm(h, pick.parts[1].trim())
    return verb === null ? null : [pick.parts[0], verb, ...pick.parts.slice(2)]
  }

  return phrase
}

const NO_SPACE_BEFORE = new Set([',', ';', ':', '.', ')'])

// Flattens a phrase into tokens, lets the language contract neighbouring
// words (lang.contract: French "que il" → "qu'il"; a token with glue gets no
// space before it), sets the spacing, capitalises the first word and adds the
// full stop.
export function linearise(phrase, lang) {
  const flat = []
  const walk = (p) => {
    if (!p) return
    if (Array.isArray(p)) p.forEach(walk)
    else if (p.text) flat.push({ ...p })
  }
  walk(phrase)
  if (lang?.contract) {
    const contracted = lang.contract(flat).filter(t => t.text)
    flat.length = 0
    flat.push(...contracted)
  }
  flat.push(tok('.', 'punct'))
  flat.forEach((t, i) => {
    t.space = i > 0 && !t.glue && !(t.cls === 'punct' && NO_SPACE_BEFORE.has(t.text)) && flat[i - 1].text !== '('
  })
  if (flat.length) flat[0] = { ...flat[0], text: flat[0].text[0].toUpperCase() + flat[0].text.slice(1) }
  const text = flat.map(t => (t.space ? ' ' : '') + t.text).join('')
  return { tokens: flat, text }
}
