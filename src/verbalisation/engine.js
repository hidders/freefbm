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
import { match, isVar } from './match.js'

export const tok = (text, cls = 'kw') => ({ text, cls })

// Concatenates phrases; null if any part is null (a sub-phrase failed).
export function seq(...parts) {
  return parts.some(p => p === null) ? null : parts
}

// Verbalises a formula. Returns { tokens, text, trace }: tokens carry a
// space flag (whether a space precedes them) for rendering, trace lists the
// rules that built the sentence, outermost first.
export function verbalise(formula, ctx, language) {
  const names = new Map()
  renderFormula(formula, ctx, names)
  const trace = []
  const phrase = makePhraser(ctx, language, names, trace)
  const out = phrase('sentence', normalise(formula), {})
  if (!out) throw new Error('no rule applies')
  return { ...linearise(out), trace }
}

function makePhraser(ctx, lang, names, trace) {
  const baseName = (v) => (v.typeIds?.length > 1 ? v.typeIds.map(ctx.typeName).join('&') : ctx.typeName(v.typeId))

  function phrase(as, node, env) {
    const seed = env.subject !== undefined ? { '?subj': env.subject } : {}
    for (const rule of lang.rules[as] ?? []) {
      const b = match(rule.match, node, seed)
      if (!b) continue
      const h = helpers(env)
      if (rule.guard && !rule.guard(b, h, node)) continue
      const mark = trace.length
      trace.push(`${as}: ${rule.name}`)
      const out = rule.template(b, h, node)
      if (out) return out
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
      // The variable's name as the formula shows it (Course₁), and the bare
      // type name (Course), used for wildcards and plurals.
      name: (v) => (v.t === 'wild' ? baseName(v) : names.get(v) ?? baseName(v)),
      baseName,
      objectType: (v) => ctx.otById.get(v.typeId),
      // A reference to a variable already introduced, or a wildcard.
      ref: (v) => (v?.t === 'wild' ? lang.wildNP(h, v) : lang.refNP(h, v)),
      reading: (atom, subject, overrides) => reading(h, atom, subject, overrides),
      term: (t) => lang.term(h, t),
    }
    return h
  }

  // The fact type (or implied link) of a fact atom.
  const factOf = (atom) => ctx.factById.get(atom.factId) ?? ctx.linkById?.get(atom.factId)

  // Renders a fact atom with one of its readings. With a subject, only a
  // reading that starts with the subject's role (with nothing before it) is
  // used, and the subject's slot is left out: the verb phrase, whose first
  // word the language inflects for env.verb (lang.verbForm, null when it
  // cannot, which fails the reading). Without one,
  // a reading that starts with a variable already introduced is preferred
  // (as in "that Course has some CourseTitle"), else the primary reading.
  // overrides maps variables to the phrases that fill their slots.
  function reading(h, atom, subject, overrides = new Map()) {
    const fact = factOf(atom)
    if (!fact) return null
    const n = atom.args.length
    const all = [{ roleOrder: [...Array(n).keys()], parts: fact.readingParts ?? [] },
      ...(fact.alternativeReadings ?? [])].filter(r => r.roleOrder?.length === n && r.parts)
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
    const out = []
    let subjectSeen = false
    for (let k = 0; k <= n; k++) {
      let part = pick.parts[k]?.trim()
      if (part && subject !== undefined && k === 1 && h.env.verb && lang.verbForm) {
        part = lang.verbForm(h, part)
        if (part === null) return null
      }
      if (part) out.push(tok(part, 'reading'))
      if (k === n) break
      const arg = atom.args[pick.roleOrder[k]]
      if (subject !== undefined && arg === subject) {
        if (subjectSeen) out.push(lang.reflexive(h, arg))
        subjectSeen = true
      } else if (overrides.has(arg)) out.push(overrides.get(arg))
      else out.push(h.ref(arg))
    }
    return out
  }

  return phrase
}

const NO_SPACE_BEFORE = new Set([',', ';', ':', '.', ')'])

// Flattens a phrase into tokens, sets their spacing, capitalises the first
// word and adds the full stop.
export function linearise(phrase) {
  const flat = []
  const walk = (p) => {
    if (!p) return
    if (Array.isArray(p)) p.forEach(walk)
    else if (p.text) flat.push({ ...p })
  }
  walk(phrase)
  flat.push(tok('.', 'punct'))
  flat.forEach((t, i) => {
    t.space = i > 0 && !(t.cls === 'punct' && NO_SPACE_BEFORE.has(t.text)) && flat[i - 1].text !== '('
  })
  if (flat.length) flat[0] = { ...flat[0], text: flat[0].text[0].toUpperCase() + flat[0].text.slice(1) }
  const text = flat.map(t => (t.space ? ' ' : '') + t.text).join('')
  return { tokens: flat, text }
}
