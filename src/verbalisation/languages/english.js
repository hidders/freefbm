// English verbalisation rules, following NORMA's wording where it has one
// ("Each … at most one …", "For each …, …", "at most one of the following
// holds"). Written as rule objects for now; a rule syntax and parser can
// produce the same objects later.
//
// Each phrase kind lists idioms first and generic rules last:
//   sentence  a whole formula; the engine adds the capital and full stop
//   clause    a formula inside a sentence; introduced variables are referred
//             to as "that X" (or by bare name in an "If … then …" sentence)
//   vp        a verb phrase about the subject ?subj, e.g. "has some Email";
//             null when the formula cannot be said that way, so the caller
//             falls back to a clause

import { P, alphaEq, isVar } from '../match.js'
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
function joinList(items, conj) {
  const out = []
  items.forEach((it, i) => {
    if (i > 0) out.push(i === items.length - 1 ? kw(conj) : punct(','))
    out.push(it)
  })
  return out
}

// Joins phrases with a connective; null if any is null.
function joinPhrases(parts, conj) {
  if (parts.some(p => p === null)) return null
  return parts.flatMap((p, i) => (i ? [kw(conj), p] : [p]))
}

const names = (h, vars) => joinList(vars.map(v => tok(h.name(v), 'type')), 'and')

// at most one / at least 2 / exactly one / at least 2 and at most 5
function quantifier(op, n, m) {
  if (op === '..') return [kw('at least'), number(n), kw('and at most'), number(m)]
  return [kw({ '≤': 'at most', '≥': 'at least', '=': 'exactly' }[op] ?? op), number(n)]
}
const isSingular = (op, n) => op !== '..' && n === 1

// "at most one Course", "at most 6 Courses"
function quantifiedNP(h, op, n, m, v) {
  const name = h.name(v)
  return [quantifier(op, n, m), tok(isSingular(op, n) ? name : plural(name), 'type')]
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

const occurs = (f, v) => f === v || (!!f && typeof f === 'object' && !isVar(f) &&
  Object.entries(f).some(([k, x]) => k !== 'vars' && occurs(x, v)))

// The value range ∀x (x ≈ c ∨ (x ≥ a ∧ x ≤ b) ∨ …) as its listed items, or null.
function rangeItems(h, body, x) {
  const isConst = (t) => t?.t === 'const'
  const item = (f) => {
    if (f.t === 'vcmp' && f.left === x && isConst(f.right)) {
      if (f.op === '≈') return [h.term(f.right)]
      if (f.op === '≥') return [kw('at least'), h.term(f.right)]
      if (f.op === '≤') return [kw('at most'), h.term(f.right)]
      return null
    }
    if (f.t === 'and' && f.args.length === 2) {
      const [a, b] = f.args
      if (a.t === 'vcmp' && b.t === 'vcmp' && a.left === x && b.left === x && a.op === '≥' && b.op === '≤' &&
          isConst(a.right) && isConst(b.right))
        return [h.term(a.right), kw('to'), h.term(b.right)]
    }
    return null
  }
  const items = (body.t === 'or' ? body.args : [body]).map(item)
  return items.every(Boolean) ? items : null
}

// The members of "at most one of the following holds": ¬(A ∧ B ∧ …), or
// ¬(Aᵢ ∧ Aⱼ) for every pair of some A₁ … Aₙ (n ≥ 3); else null.
function exclusionItems(f) {
  if (f.t === 'not' && f.arg.t === 'and') return f.arg.args
  if (f.t !== 'and' || !f.args.every(a => a.t === 'not' && a.arg.t === 'and' && a.arg.args.length === 2)) return null
  const items = []
  const indexOf = (g) => {
    const i = items.findIndex(x => alphaEq(x, g))
    if (i >= 0) return i
    items.push(g)
    return items.length - 1
  }
  const pairs = new Set(f.args.map(a => a.arg.args.map(indexOf).sort().join(',')))
  const k = items.length
  if (k < 3 || pairs.size !== f.args.length || pairs.size !== k * (k - 1) / 2) return null
  return items
}

// (A₁ ∨ … ∨ Aₙ) ∧ "at most one of A₁ … Aₙ": the items, or null.
function exclusiveOrItems(f) {
  if (f.t !== 'and' || f.args[0]?.t !== 'or') return null
  const alts = f.args[0].args
  const rest = f.args.slice(1)
  const excl = rest.length === 1 ? exclusionItems(rest[0]) : exclusionItems({ t: 'and', args: rest })
  if (!excl || excl.length !== alts.length) return null
  return excl.every(e => alts.some(a => alphaEq(a, e))) ? alts : null
}

// A is the fact atom B with the variables ys replaced by wildcards, so that
// ∀x (A → ∃^{≤n} ys B) says the same as ∀x ∃^{≤n} ys B.
function sameUpToWild(a, b, ys) {
  if (a?.t !== 'fact' || b?.t !== 'fact' || a.factId !== b.factId) return false
  return b.args.every((y, i) => (ys.includes(y) ? a.args[i]?.t === 'wild' : a.args[i] === y))
}

// ∃^{=1} y₁ … yₙ (R₁(x, y₁) ∧ … ∧ Rₙ(x, yₙ)), each Rᵢ a fact atom over x and
// yᵢ only: the number of combinations is the product of the counts, so it
// holds exactly when each Rᵢ has exactly one yᵢ.
function distributable(ys, args, x) {
  if (ys.length < 2 || args.length !== ys.length) return false
  return ys.every(y => {
    const own = args.filter(a => occurs(a, y))
    return own.length === 1 && own[0].t === 'fact' && own[0].args.length === 2 &&
      own[0].args.includes(x) && own[0].args.includes(y)
  })
}

const isComplex = (f) => ['and', 'or', 'implies', 'iff'].includes(f.t)

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

// ── Rules ────────────────────────────────────────────────────────────────────

const sentence = [
  {
    name: 'value-range',
    match: P.forall(['?x'], '?body'),
    guard: (b, h) => !!rangeItems(h, b['?body'], b['?x']),
    template: (b, h) => [kw('the possible values of'), tok(h.name(b['?x']), 'type'), kw('are'),
      rangeItems(h, b['?body'], b['?x']).flatMap((it, i) => (i ? [punct(','), it] : [it]))],
  },
  {
    name: 'exactly-one-of',
    match: P.forall(['?x'], '?body'),
    guard: (b) => !!exclusiveOrItems(b['?body']),
    template: (b, h) => seq([kw('for each'), tok(h.name(b['?x']), 'type'), punct(',')],
      clauseList(h, 'exactly one of the following holds', exclusiveOrItems(b['?body']))),
  },
  {
    name: 'no',
    match: P.forall(['?x'], P.not('?a')),
    template: (b, h) => seq([kw('no'), tok(h.name(b['?x']), 'type')], h.vp(b['?a'], b['?x'], { negative: true })),
  },
  {
    // ∀x (∃ys R → ∃^{≤n} ys R) says no more than ∀x ∃^{≤n} ys R.
    name: 'each-at-most',
    match: P.forall(['?x'], P.implies('?a', P.count('≤', '?n', '?ys', '?c'))),
    guard: (b) => sameUpToWild(b['?a'], b['?c'], b['?ys']),
    template: (b, h, node) => seq([kw('each'), tok(h.name(b['?x']), 'type')], h.vp(node.body.right, b['?x'])),
  },
  {
    name: 'each-that',
    match: P.forall(['?x'], P.implies('?a', '?c')),
    template: (b, h) => seq([kw('each'), tok(h.name(b['?x']), 'type')], relative(h, b['?a'], b['?x']), h.vp(b['?c'], b['?x'])),
  },
  {
    name: 'at-least-one-of',
    match: P.forall(['?x'], P.or('?args')),
    guard: (b) => b['?args'].length > 2 || b['?args'].some(isComplex),
    template: (b, h) => seq([kw('for each'), tok(h.name(b['?x']), 'type'), punct(',')],
      clauseList(h, 'at least one of the following holds', b['?args'])),
  },
  {
    name: 'each',
    match: P.forall(['?x'], '?body'),
    template: (b, h) => seq([kw('each'), tok(h.name(b['?x']), 'type')], h.vp(b['?body'], b['?x'])),
  },
  {
    // Derivation rules: "Student is a TeachingAssistant if and only if
    // Student assists in some Course", with the variables by bare name.
    name: 'definition',
    match: P.forall('?vs', P.iff('?a', '?c')),
    guard: (b) => (b['?a'].t === 'type' || (b['?a'].t === 'fact' && b['?a'].args.every(isVar))) &&
      b['?vs'].every(v => occurs(b['?a'], v)),
    template: (b, h) => {
      const hb = h.with({ refStyle: 'bare' })
      return seq(hb.clause(b['?a']), kw('if and only if'), hb.clause(b['?c']))
    },
  },
  {
    // NORMA's style for rules over several variables, which are then
    // referred to by their (subscripted) names.
    name: 'if-then',
    match: P.forall('?vs', P.implies('?a', '?c')),
    guard: (b) => b['?vs'].length > 1 && b['?vs'].every(v => occurs(b['?a'], v)),
    template: (b, h) => {
      const hb = h.with({ refStyle: 'bare' })
      return seq(kw('if'), hb.clause(b['?a']), kw('then'), hb.clause(b['?c']))
    },
  },
  {
    name: 'for-each',
    match: P.forall('?vs', '?body'),
    template: (b, h) => seq([kw('for each'), names(h, b['?vs']), punct(',')], h.clause(b['?body'])),
  },
  {
    name: 'clause',
    match: '?f',
    template: (b, h) => h.clause(b['?f']),
  },
]

const clause = [
  {
    name: 'at-most-one-of',
    match: '?f',
    guard: (b) => !!exclusionItems(b['?f']),
    template: (b, h) => clauseList(h, 'at most one of the following holds', exclusionItems(b['?f'])),
  },
  {
    // "Course₁ is not a prerequisite for Course₃", "Student enrols in no Course"
    name: 'not-subject',
    match: P.not('?a'),
    guard: (b) => ['fact', 'type', 'exists'].includes(b['?a'].t),
    template: (b, h) => {
      const a = b['?a']
      if (a.t === 'exists') {
        const x = a.vars.length === 1 && a.body.t === 'fact' ? a.body.args.find(z => isVar(z) && z !== a.vars[0]) : null
        return x ? seq(h.ref(x), h.vp(b['?a'], x, { verb: 'negated' })) : null
      }
      const x = a.t === 'type' ? a.arg : a.args.find(isVar)
      return x ? seq(h.ref(x), h.vp(a, x, { verb: 'negated' })) : null
    },
  },
  { name: 'not', match: P.not('?a'), template: (b, h) => seq(kw('it is not true that'), h.clause(b['?a'])) },
  { name: 'and', match: P.and('?args'), template: (b, h) => joinPhrases(b['?args'].map(a => h.clause(a)), 'and') },
  { name: 'or', match: P.or('?args'), template: (b, h) => joinPhrases(b['?args'].map(a => h.clause(a)), 'or') },
  { name: 'implies', match: P.implies('?a', '?c'), template: (b, h) => seq(kw('if'), h.clause(b['?a']), kw('then'), h.clause(b['?c'])) },
  { name: 'iff', match: P.iff('?a', '?c'), template: (b, h) => seq(h.clause(b['?a']), kw('if and only if'), h.clause(b['?c'])) },
  {
    name: 'for-each',
    match: P.forall('?vs', '?body'),
    template: (b, h) => seq([kw('for each'), names(h, b['?vs']), punct(',')], h.clause(b['?body'])),
  },
  {
    name: 'some-subject',
    match: P.exists(['?y'], '?body'),
    template: (b, h) => seq([kw('some'), tok(h.name(b['?y']), 'type')], h.vp(b['?body'], b['?y'])),
  },
  {
    name: 'some-object',
    match: P.exists(['?y'], '?body'),
    template: (b, h) => anchoredClause(h, b['?y'], b['?body'], [kw('some'), tok(h.name(b['?y']), 'type')]),
  },
  {
    name: 'quantified-subject',
    match: P.count('?op', '?n', ['?y'], '?body'),
    guard: (b) => isSingular(b['?op'], b['?n']),
    template: (b, h, node) => seq(quantifiedNP(h, node.op, node.n, node.m, b['?y']), h.vp(b['?body'], b['?y'])),
  },
  {
    // Cardinality: "there are at most 100 Courses".
    name: 'there-are-n-objects',
    match: P.count('?op', '?n', ['?y'], P.node('true')),
    template: (b, h, node) => [kw(isSingular(node.op, node.n) ? 'there is' : 'there are'), quantifiedNP(h, node.op, node.n, node.m, b['?y'])],
  },
  {
    // "there are at least 5 Staffs that coordinate some Course",
    // "there are at most 50 Courses that some Student enrols in"
    name: 'there-are-n-that',
    match: P.count('?op', '?n', ['?y'], '?body'),
    guard: (b, h, node) => !isSingular(node.op, node.n),
    template: (b, h, node) => {
      const r = relativeBody(h, b['?body'], b['?y'], { verb: 'plural' })
      return r && [kw('there are'), quantifiedNP(h, node.op, node.n, node.m, b['?y']), relPron(h, b['?y']), r]
    },
  },
  {
    name: 'quantified-object',
    match: P.count('?op', '?n', ['?y'], '?body'),
    guard: (b) => isSingular(b['?op'], b['?n']),
    template: (b, h, node) => anchoredClause(h, b['?y'], b['?body'], quantifiedNP(h, node.op, node.n, node.m, b['?y'])),
  },
  {
    name: 'there-is-some',
    match: P.exists('?ys', '?body'),
    template: (b, h) => seq([kw('there is'), joinList(b['?ys'].map(y => [kw('some'), tok(h.name(y), 'type')]), 'and'),
      kw('such that')], h.clause(b['?body'])),
  },
  {
    name: 'there-are-n',
    match: P.count('?op', '?n', '?ys', '?body'),
    template: (b, h, node) => {
      const ys = b['?ys']
      const one = isSingular(node.op, node.n)
      const what = ys.length === 1
        ? tok(one ? h.name(ys[0]) : plural(h.name(ys[0])), 'type')
        : [kw(one ? 'combination of' : 'combinations of'), names(h, ys)]
      return seq([kw(one ? 'there is' : 'there are'), quantifier(node.op, node.n, node.m), what, kw('such that')], h.clause(b['?body']))
    },
  },
  { name: 'fact', match: P.node('fact'), template: (b, h, node) => h.reading(node) },
  {
    name: 'subject-vp',
    match: { t: '_' },
    guard: (b, h, node) => ['type', 'vcmp', 'cmp', 'dpred', 'tc'].includes(node.t) && subjectOf(node) !== null,
    template: (b, h, node) => seq(h.ref(subjectOf(node)), h.vp(node, subjectOf(node))),
  },
  {
    name: 'value-comparison',
    match: P.vcmp('?op', '?l', '?r'),
    template: (b, h) => seq(h.term(b['?l']), kw(VALUE_OPS[b['?op']] ?? b['?op']), h.term(b['?r'])),
  },
  {
    name: 'data-predicate',
    match: P.node('dpred'),
    template: (b, h, node) => node.args.length === 2
      ? [h.term(node.args[0]), kw(PREDS[node.op]?.label ?? node.op), h.term(node.args[1])]
      : [kw(PREDS[node.op]?.label ?? node.op), punct('('), joinList(node.args.map(a => h.term(a)), 'and'), punct(')'), kw('holds')],
  },
  {
    name: 'closure',
    match: P.node('tc'),
    template: (b, h, node) => seq(h.ref(node.args[0]), kw('is linked to'), h.ref(node.args[1]),
      kw(node.star ? 'by zero or more steps, each from some' : 'by one or more steps, each from some'),
      tok(h.name(node.vars[0]), 'type'), kw('to some'), tok(h.name(node.vars[1]), 'type'), kw('such that'),
      h.clause(node.body)),
  },
  { name: 'true', match: P.node('true'), template: () => [kw('true')] },
  {
    name: 'unknown',
    match: '_',
    template: (b, h, node) => [kw(`(${node?.t ?? '?'})`)],
  },
]

// The variable an atom is about, when it can be the subject of a verb phrase.
function subjectOf(f) {
  switch (f.t) {
    case 'type': return f.arg
    case 'vcmp': case 'cmp': return isVar(f.left) ? f.left : null
    case 'dpred': return isVar(f.args[0]) ? f.args[0] : null
    case 'tc': return isVar(f.args[0]) ? f.args[0] : null
    default: return null
  }
}

const vp = [
  {
    name: 'fact',
    match: P.fact('?P', ['?subj'], '?rest*'),
    template: (b, h, node) => h.reading(node, b['?subj']),
  },
  {
    name: 'is-a',
    match: P.type('?T', '?subj'),
    template: (b, h) => {
      const name = h.ctx.typeName(b['?T'])
      if (h.env.verb === 'plural') return [kw('are'), tok(plural(name), 'type')]
      return seq(verb(h, 'is'), kw(article(name)), tok(name, 'type'))
    },
  },
  {
    name: 'value-comparison',
    match: P.vcmp('?op', '?subj', '?r'),
    template: (b, h) => seq(VALUE_OPS[b['?op']] ? verb(h, VALUE_OPS[b['?op']]) : kw(b['?op']), h.term(b['?r'])),
  },
  {
    name: 'same-object',
    match: P.cmp('?op', '?subj', '?r'),
    template: (b, h) => seq(verb(h, b['?op'] === '=' ? 'is' : 'is not'), h.ref(b['?r'])),
  },
  {
    name: 'data-predicate',
    match: { t: 'dpred', args: ['?subj', '?r'] },
    guard: (b, h) => !h.env.verb,
    template: (b, h, node) => seq(kw(PREDS[node.op]?.label ?? node.op), h.term(b['?r'])),
  },
  {
    // [TC_{v,w} R(v, w)](x, t): "is a prerequisite for t, directly or indirectly"
    name: 'directly-or-indirectly',
    match: P.tc(['?v', '?w'], P.fact('?P', ['?v', '?w']), ['?subj', '?t']),
    guard: (b, h) => b['?v'] !== b['?w'] && !h.env.verb,
    template: (b, h, node) => {
      const sub = (a) => (a === b['?v'] ? b['?subj'] : a === b['?w'] ? b['?t'] : a)
      const r = h.reading({ ...node.body, args: node.body.args.map(sub) }, b['?subj'])
      return seq(r, punct(','), kw('directly or indirectly'),
        node.star ? [kw('or is'), b['?t'] === b['?subj'] ? kw('itself') : h.ref(b['?t'])] : [])
    },
  },
  {
    name: 'and',
    match: P.and('?args'),
    guard: (b, h) => h.env.verb !== 'negated',
    template: (b, h) => joinPhrases(b['?args'].map(a => h.vp(a, b['?subj'])), 'and'),
  },
  {
    name: 'or',
    match: P.or('?args'),
    guard: (b, h) => h.env.verb !== 'negated' && b['?args'].length <= 2 && !b['?args'].some(isComplex),
    template: (b, h) => joinPhrases(b['?args'].map(a => h.vp(a, b['?subj'])), 'or'),
  },
  {
    // "is in exactly one Building and has exactly one RoomNr"
    name: 'exactly-one-each',
    match: P.count('=', 1, '?ys', P.and('?args')),
    guard: (b, h) => h.env.verb !== 'negated' && distributable(b['?ys'], b['?args'], b['?subj']),
    template: (b, h) => joinPhrases(b['?ys'].map(y => h.vp({ t: 'count', op: '=', n: 1, vars: [y],
      body: b['?args'].find(a => occurs(a, y)) }, b['?subj'])), 'and'),
  },
  {
    name: 'quantified-object',
    match: P.count('?op', '?n', ['?y'], '?body'),
    guard: (b, h) => h.env.verb !== 'negated',
    template: (b, h, node) => objectQuantified(h, b['?subj'], b['?y'], b['?body'], quantifiedNP(h, node.op, node.n, node.m, b['?y'])),
  },
  {
    // Negated: "enrols in no Course"; the verb stays positive.
    name: 'no-object',
    match: P.exists(['?y'], '?body'),
    guard: (b, h) => h.env.verb === 'negated',
    template: (b, h) => objectQuantified(h.with({ verb: undefined }), b['?subj'], b['?y'], b['?body'], [kw('no'), tok(h.name(b['?y']), 'type')]),
  },
  {
    name: 'some-object',
    match: P.exists(['?y'], '?body'),
    guard: (b, h) => h.env.verb !== 'negated',
    template: (b, h) => objectQuantified(h, b['?subj'], b['?y'], b['?body'], [kw(h.env.negative ? 'any' : 'some'), tok(h.name(b['?y']), 'type')]),
  },
]

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
// binds less tightly: "(Credits plus 5) times 2".
function operation(h, t) {
  const def = OPS[t.op]
  const arg = (a, i) => {
    const inner = a?.t === 'fn' ? OPS[a.op] : null
    const loose = def?.style === 'infix' && inner?.style === 'infix' &&
      (inner.prec < def.prec || (inner.prec === def.prec && (i > 0 || a.op !== t.op) && !(def.assoc && a.op === t.op)))
    return loose ? [punct('('), term(h, a), punct(')')] : term(h, a)
  }
  const pattern = OPERATION[t.op]
  if (!pattern) return [kw(`the ${def?.label ?? t.op} of`), joinList(t.args.map(a => term(h, a)), 'and')]
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
      if (r) return [kw(t.term ? `the ${label} of all` : 'the number of'), distinct, tok(plural(h.name(y)), 'type'), r]
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
  const what = t.vars.length === 1 ? tok(plural(h.name(t.vars[0])), 'type') : [kw('combinations of'), names(h, t.vars)]
  if (!t.term) return seq(kw('the number of'), distinct, what, kw('such that'), h.clause(t.cond))
  return seq(kw(`the ${label} of`), distinct, term(h, t.term), kw('over all'), what, kw('such that'), h.clause(t.cond))
}

export const english = {
  id: 'en',
  label: 'English',
  rules: { sentence, clause, vp },
  term,
  // "that Course", or "Course" in an If … then … sentence.
  refNP: (h, v) => (h.env.refStyle === 'bare' ? tok(h.name(v), 'type') : [kw('that'), tok(h.name(v), 'type')]),
  // A wildcard: "some Course", or "any Course" after "No" or a negated verb.
  wildNP: (h, w) => [kw(h.env.negative || h.env.verb === 'negated' ? 'any' : 'some'), tok(h.name(w), 'type')],
  verbForm: (h, text) => inflect(text, h.env.verb),
  reflexive: (h, v) => kw(h.objectType(v)?.isPersonal ? 'themselves' : 'itself'),
}
