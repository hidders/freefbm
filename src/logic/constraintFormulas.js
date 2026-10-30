// Translates FreeFBM constraints into formulas of the ORM2 logic.
//
// First-order formulas with counting quantifiers ∃^{≤n}, ∃^{≥n}, ∃^{=n}, ∃^{n..m} for
// uniqueness and frequency, plus transitive closure [TC_{v,w} φ](s, t) for the
// acyclic and strongly intransitive rings. Value ranges and value comparisons
// use value atoms x ≈ c, x < y, … that compare data values under the
// variable's datatype. Cardinality ranges are not formalised yet. A deontic
// constraint's formula φ is wrapped as O(φ) (modality.js).
//
// Atoms use the fact type's primary reading (readingParts), whose slots follow
// roles[] order, so fact atom arguments are always in roles[] order.

import {
  mkVar, forall, exists, count, countRange, not, truth, implies, iff, and, or, tc,
  factAtom, typeAtom, cmp, vcmp, obligatory,
} from './formula.js'
import { isDeonticUniqueness, isDeonticMandatory } from './modality.js'
import { VALUE_KINDS, parseLiteral } from '../utils/datatypeValues.js'
import { valueAccess, withValues, valueConstant } from './values.js'
import { isDerived, derivationEntry } from './derivationRule.js'
import { isDerivedFact, factDerivationEntries } from './factDerivation.js'
import { counterexample } from '../verbalisation/negative.js'

const SEQUENCE_TYPES = new Set([
  'inclusiveOr', 'exclusiveOr', 'exclusion', 'equality', 'subset',
  'uniqueness', 'frequency', 'ring', 'valueComparison',
])

const CONSTRAINT_LABELS = {
  inclusiveOr:     'Inclusive-or',
  exclusiveOr:     'Exclusive-or',
  exclusion:       'Exclusion',
  equality:        'Equality',
  subset:          'Subset',
  uniqueness:      'External uniqueness',
  frequency:       'External frequency',
  ring:            'Ring',
  valueComparison: 'Value comparison',
}

// Value comparison operators: the stored = and ≠ compare values, so they
// become ≈ and ≉ to keep them apart from equality of objects.
const VALUE_OP = { '=': '≈', '≠': '≉' }

const RING_LABELS = {
  'irreflexive':           'irreflexive',
  'reflexive':             'locally reflexive',
  'purely-reflexive':      'purely reflexive',
  'asymmetric':            'asymmetric',
  'symmetric':             'symmetric',
  'antisymmetric':         'antisymmetric',
  'transitive':            'transitive',
  'intransitive':          'intransitive',
  'strongly-intransitive': 'strongly intransitive',
  'acyclic':               'acyclic',
}

// ── Join-path queries ────────────────────────────────────────────────────────
//
// Each sequence of an external constraint denotes a query: an existentially
// quantified conjunction of atoms whose free variables are the sequence
// positions (and, for uniqueness and frequency, the target object type).
// compileSequence returns a builder that produces that formula for given free
// variables, with fresh bound variables on every call.

const normalizeSeeded = (s) => (typeof s === 'number' ? { roleIndex: s, seqPosition: 0 } : s)

// A query for a sequence that has none stored: roles of one fact type, or a
// single subtype edge. Mirrors the store's automatic query generation.
function implicitQuery(seq) {
  if (seq.length === 1 && seq[0].kind === 'subtype') {
    return { atoms: [{ id: 's', kind: 'subtype', originalId: seq[0].subtypeId, isSeeded: true }], links: [] }
  }
  const roles = seq.filter(m => m.kind === 'role' && !m.factId?.includes('_il_'))
  if (roles.length === 0 || roles.length !== seq.length) return null
  if (new Set(roles.map(m => m.factId)).size !== 1) return null
  return {
    atoms: [{ id: 'f', kind: 'fact', originalId: roles[0].factId,
      seededRoles: roles.map((m, i) => ({ roleIndex: m.roleIndex, seqPosition: i })) }],
    links: [],
  }
}

function compileSequence(seq, query, ctx) {
  const q = query ?? implicitQuery(seq ?? [])
  if (!q) return { error: 'its role sequence has no join path yet' }
  const atoms = q.atoms ?? q.copies ?? []
  const links = q.links ?? []

  // Every argument slot of every atom is a node; links and subtype edges merge
  // nodes into classes, and each class becomes one variable.
  const parent = new Map()
  const nodeType = new Map()
  const find = (n) => { while (parent.get(n) !== n) n = parent.get(n); return n }
  const addNode = (n, typeId) => { if (!parent.has(n)) { parent.set(n, n); nodeType.set(n, typeId) } }
  const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent.set(rb, ra) }
  const linkTarget = (atomId, roleIndex) =>
    links.find(l => l.atomId === atomId && l.roleIndex === roleIndex)?.variableId

  for (const a of atoms) if (a.kind === 'objectType') addNode(a.id, a.originalId)
  // A link to a fact atom of an objectified fact type stands for the instance
  // that nests the atom's fact, so that atom is a node of the nested type too.
  for (const a of atoms) {
    if (a.kind === 'fact' && ctx.factById.get(a.originalId)?.objectified && links.some(l => l.variableId === a.id))
      addNode(a.id, a.originalId)
  }

  const factParts = []   // { factId, nodes }
  const subtypeParts = [] // { subId, node }
  const outputs = []     // { seqPosition, node }
  for (const a of atoms) {
    if (a.kind === 'fact') {
      const fact = ctx.factById.get(a.originalId)
      if (!fact) return { error: 'its join path refers to a deleted fact type' }
      const nodes = fact.roles.map((r, ri) => {
        const linked = linkTarget(a.id, ri)
        if (linked && parent.has(linked)) return linked
        const n = `${a.id}#${ri}`
        addNode(n, r.objectTypeId)
        return n
      })
      if (parent.has(a.id)) {
        // The nesting instance d of the fact, through the implied links:
        // d involves A ∧ d involves B ∧ … (which entails the fact itself).
        const ils = fact.roles.map((_, ri) => ctx.linkById.get(`${fact.id}_il_${ri}`))
        if (ils.some(l => !l)) return { error: 'a role of its join path has no implied link yet' }
        ils.forEach((l, ri) => factParts.push({ factId: l.id, nodes: [a.id, nodes[ri]] }))
      } else {
        factParts.push({ factId: fact.id, nodes })
      }
      for (const s of (a.seededRoles ?? []).map(normalizeSeeded)) {
        if (s.seqPosition != null) outputs.push({ seqPosition: s.seqPosition, node: nodes[s.roleIndex] })
      }
    } else if (a.kind === 'subtype') {
      const st = ctx.subtypeById.get(a.originalId)
      if (!st) return { error: 'its join path refers to a deleted subtype' }
      const ends = [0, 1].map(ri => {
        const linked = linkTarget(a.id, ri)
        if (linked && parent.has(linked)) return linked
        const n = `${a.id}#${ri}`
        addNode(n, ri === 0 ? st.subId : st.superId)
        return n
      })
      union(ends[1], ends[0])
      subtypeParts.push({ subId: st.subId, node: ends[1] })
      if (a.isSeeded) {
        const pos = Math.max(0, (seq ?? []).findIndex(m => m.kind === 'subtype' && m.subtypeId === st.id))
        outputs.push({ seqPosition: pos, node: ends[1] })
      }
    }
  }
  outputs.sort((x, y) => x.seqPosition - y.seqPosition)
  const targetAtom = atoms.find(a => a.kind === 'objectType' && a.isOutput)
  const targetNode = targetAtom && !outputs.some(o => find(o.node) === find(targetAtom.id))
    ? targetAtom.id : null

  // The type of a class is the type of its most general node: the one that is
  // not the subtype end of any subtype atom in the class.
  const subEnds = new Set()
  for (const a of atoms) if (a.kind === 'subtype') {
    const linked = linkTarget(a.id, 0)
    subEnds.add(linked && parent.has(linked) ? linked : `${a.id}#0`)
  }
  const classType = (root) => {
    let fallback = null
    for (const n of parent.keys()) {
      if (find(n) !== root) continue
      fallback ??= nodeType.get(n)
      if (!subEnds.has(n)) return nodeType.get(n)
    }
    return fallback
  }

  const build = ({ outVars = [], targetVar = null } = {}) => {
    const varOf = new Map()
    const equalities = []
    const bindFree = (node, v) => {
      const root = find(node)
      const prev = varOf.get(root)
      if (prev && prev !== v) equalities.push(cmp('=', prev, v))
      else varOf.set(root, v)
    }
    outputs.forEach((o, i) => { if (outVars[i]) bindFree(o.node, outVars[i]) })
    if (targetNode && targetVar) bindFree(targetNode, targetVar)
    const free = new Set(varOf.values())
    const bound = []
    const v = (node) => {
      const root = find(node)
      if (!varOf.has(root)) {
        const nv = mkVar(classType(root))
        varOf.set(root, nv)
        bound.push(nv)
      }
      return varOf.get(root)
    }
    const conjuncts = [
      ...factParts.map(p => factAtom(p.factId, p.nodes.map(v))),
      ...subtypeParts.map(p => typeAtom(p.subId, v(p.node))),
      ...equalities,
    ]
    return exists(bound.filter(b => !free.has(b)), and(conjuncts))
  }

  return {
    arity: outputs.length,
    outTypes: outputs.map(o => classType(find(o.node))),
    targetType: targetNode ? classType(find(targetNode)) : null,
    build,
  }
}

// ── Frequency ranges ─────────────────────────────────────────────────────────

const toNum = (x) => {
  if (x === '' || x == null) return null
  const n = Number(x)
  return Number.isFinite(n) ? n : null
}

// Normalises a frequency range (an array of single/lower/upper/range specs, or
// the older { min, max } object) to [{ lo, hi }] with null for an open bound.
function frequencySpecs(range) {
  if (!range) return []
  if (!Array.isArray(range)) return [{ lo: toNum(range.min), hi: toNum(range.max) }]
  return range.map(s => {
    if (s.type === 'single') return { lo: toNum(s.value), hi: toNum(s.value) }
    if (s.type === 'lower')  return { lo: toNum(s.lower), hi: null }
    if (s.type === 'upper')  return { lo: null, hi: toNum(s.upper) }
    return { lo: toNum(s.lower), hi: toNum(s.upper) }
  }).filter(s => s.lo != null || s.hi != null)
}

// ∀x̄ (∃ȳ φ → ⋁ ∃^{lo..hi} ȳ φ), with φ built fresh per use. A lower bound of
// 1 or less is implied by ∃ȳ φ, so it leaves ∃^{≤hi}; no upper bound gives ∃^{≥lo}.
function frequencyFormula(xs, ys, phi, specs) {
  const bounds = specs.map(({ lo, hi }) => {
    if (lo != null && lo === hi) return count('=', lo, ys, phi())
    if (lo != null && lo > 1 && hi != null) return countRange(lo, hi, ys, phi())
    return and(
      lo != null && lo > 1 ? count('≥', lo, ys, phi()) : null,
      hi != null ? count('≤', hi, ys, phi()) : null,
    )
  })
  if (bounds.some(b => b === null)) return null
  return forall(xs, implies(exists(ys, phi()), or(bounds)))
}

// ── Cardinality ranges ───────────────────────────────────────────────────────

// ⋁ ∃^{lo..hi} x φ over the specs (∃^{≤hi} with no lower bound above 0,
// ∃^{≥lo} with no upper bound), with x and φ built fresh per use by
// phi() → { x, body }; null when some spec holds for any population.
function cardinalityFormula(phi, specs) {
  const q = (op, n) => { const { x, body } = phi(); return count(op, n, [x], body) }
  const bounds = specs.map(({ lo, hi }) => {
    if (lo != null && lo === hi) return q('=', lo)
    if (lo != null && lo > 0 && hi != null) { const { x, body } = phi(); return countRange(lo, hi, [x], body) }
    return and(lo != null && lo > 0 ? q('≥', lo) : null, hi != null ? q('≤', hi) : null)
  })
  if (!bounds.length || bounds.some(b => b === null)) return null
  return or(bounds)
}

function cardinalityEntry(base, range, phi) {
  const formula = cardinalityFormula(phi, frequencySpecs(range))
  return formula ? { ...base, formula } : { ...base, note: 'Holds for any population, so it says nothing.' }
}

// The population of the type (an object type or an objectified fact type)
// has a number of instances in the range.
function typeCardinalityEntry(typeId, range, ctx, deontic = false) {
  return asDeontic(deontic, cardinalityEntry({ key: `${typeId}:card`, elementId: typeId, kind: 'Cardinality', subject: ctx.typeName(typeId) },
    range, () => ({ x: mkVar(typeId), body: truth() })))
}

// The number of distinct objects playing role i of the fact type is in the range.
function roleCardinalityEntry(fact, i, ctx, reading = readingText(fact, ctx)) {
  const r = fact.roles[i]
  const base = { key: `${fact.id}:card:${i}`, elementId: fact.id, kind: `Cardinality (role ${i + 1})`, subject: reading }
  if (!r.objectTypeId) return { ...base, note: 'The role has no player yet.' }
  return asDeontic(r.cardinalityRangeDeontic, cardinalityEntry(base, r.cardinalityRange, () => {
    const xs = fact.roles.map(p => mkVar(p.objectTypeId))
    return { x: xs[i], body: exists(xs.filter((_, j) => j !== i), factAtom(fact.id, xs)) }
  }))
}

// The entry for a selected cardinality range ({ otId } | { factId, roleIndex }
// | { nestedFactId }), or null.
function selectedCardinalityEntry(sel, ctx) {
  const ot = sel.otId ? ctx.otById.get(sel.otId) : null
  if (ot?.cardinalityRange?.length) return typeCardinalityEntry(ot.id, ot.cardinalityRange, ctx, ot.cardinalityRangeDeontic)
  const nested = sel.nestedFactId ? ctx.factById.get(sel.nestedFactId) : null
  if (nested?.cardinalityRange?.length) return typeCardinalityEntry(nested.id, nested.cardinalityRange, ctx, nested.cardinalityRangeDeontic)
  const fact = sel.factId != null ? ctx.factById.get(sel.factId) : null
  if (fact?.roles[sel.roleIndex]?.cardinalityRange?.length) return roleCardinalityEntry(fact, sel.roleIndex, ctx)
  return null
}

// ── Readable labels ──────────────────────────────────────────────────────────

export function readingText(fact, ctx) {
  const parts = fact.readingParts ?? []
  const words = []
  fact.roles.forEach((r, i) => {
    if (parts[i]?.trim()) words.push(parts[i].trim())
    words.push(ctx.typeName(r.objectTypeId))
  })
  if (parts[fact.roles.length]?.trim()) words.push(parts[fact.roles.length].trim())
  return words.join(' ')
}

const BOUND_FIELDS = { single: ['value'], lower: ['lower'], upper: ['upper'], range: ['lower', 'upper'] }

// The condition a value range puts on a value variable, as v => formula, or
// { error } when the range can't be read under the datatype.
function rangeCondition(range, kindName) {
  const kind = kindName ? VALUE_KINDS[kindName] : null
  for (const [i, spec] of range.entries()) {
    const fields = BOUND_FIELDS[spec.type]
    if (!fields) return { error: `range ${i + 1} has an unknown form` }
    for (const f of fields) {
      const p = parseLiteral(spec[f], kind ?? VALUE_KINDS.string)
      if (p.empty) return { error: `range ${i + 1} has an empty ${f === 'value' ? 'value' : `${f} bound`}` }
      if (p.invalid) return { error: `${String(spec[f]).trim()} is not a valid ${kind.expect}` }
    }
    if (kind?.order === 'none' && spec.type !== 'single')
      return { error: `${kindName} values have no order, so only single values are allowed` }
  }
  const c = (raw) => valueConstant(raw, kindName)
  return {
    cond: (v) => or(range.map(spec => {
      // An open bound (lowerOpen, upperOpen) excludes the bound itself.
      const lo = spec.lowerOpen ? '>' : '≥', hi = spec.upperOpen ? '<' : '≤'
      switch (spec.type) {
        case 'single': return vcmp('≈', v, c(spec.value))
        case 'lower':  return vcmp(lo, v, c(spec.lower))
        case 'upper':  return vcmp(hi, v, c(spec.upper))
        default:       return and(vcmp(lo, v, c(spec.lower)), vcmp(hi, v, c(spec.upper)))
      }
    })),
  }
}

// ∀x̄ (… → the value of x is in the range), or a note. `x` is the variable
// whose value is restricted, `wrap` builds the formula around the condition.
function valueRangeEntry(base, range, typeId, ctx, wrap) {
  const access = valueAccess(typeId, ctx)
  if (!access) return { ...base, note: `No formula yet: ${ctx.typeName(typeId)} has no reference mode, so it has no value to restrict.` }
  const rc = rangeCondition(range, access.kindName)
  if (rc.error) return { ...base, note: `No formula yet: ${rc.error}.` }
  return { ...base, formula: wrap((x) => withValues([{ x, access }], rc.cond)) }
}

function typeValueRangeEntry(type, ctx) {
  const x = mkVar(type.id)
  return asDeontic(type.valueRangeDeontic, valueRangeEntry(
    { key: `${type.id}:vr`, elementId: type.id, kind: 'Value range', subject: ctx.typeName(type.id) },
    type.valueRange, type.id, ctx, (cond) => forall([x], cond(x))))
}

// ∀x (∃ȳ (… x …) → the value of x is in the range), for the value range on
// role i of the fact type.
function roleValueRangeEntry(fact, i, ctx, reading = readingText(fact, ctx)) {
  const r = fact.roles[i]
  const base = { key: `${fact.id}:vr:${i}`, elementId: fact.id,
    kind: `Value range (role ${i + 1})`, subject: reading }
  if (!r.objectTypeId) return { ...base, note: 'The role has no player yet.' }
  const xs = fact.roles.map(p => mkVar(p.objectTypeId))
  return asDeontic(r.valueRangeDeontic, valueRangeEntry(base, r.valueRange, r.objectTypeId, ctx, (cond) =>
    forall([xs[i]], implies(exists(xs.filter((_, j) => j !== i), factAtom(fact.id, xs)), cond(xs[i])))))
}

// ── Internal constraints of one fact type ────────────────────────────────────

function factEntries(fact, ctx, info) {
  const out = []
  const reading = readingText(fact, ctx)
  const arity = fact.roles.length
  const roleVars = () => fact.roles.map(r => mkVar(r.objectTypeId))
  const preferred = new Set((fact.preferredUniqueness ?? []).map(u => [...u].sort().join(',')))

  for (const u of (fact.uniqueness ?? [])) {
    const isPreferred = preferred.has([...u].sort().join(','))
    const deontic = !isPreferred && isDeonticUniqueness(fact, u)
    const base = { key: `${fact.id}:uc:${u.join(',')}`, elementId: fact.id,
      kind: isPreferred ? 'Uniqueness (preferred identifier)' : deontic ? 'Uniqueness (deontic)' : 'Uniqueness', subject: reading }
    if (u.length >= arity) {
      out.push({ ...base, note: 'Spans every role, so it holds for any set of facts.' })
      continue
    }
    const xs = roleVars()
    const ys = xs.filter((_, i) => !u.includes(i))
    out.push({ ...base, formula: modal(deontic, forall(xs.filter((_, i) => u.includes(i)), count('≤', 1, ys, factAtom(fact.id, xs)))) })
    if (isPreferred) out.push(...preferredIdentifierEntries(fact, u, reading))
  }
  out.push(...possibleUniqueness(fact, reading, info))

  fact.roles.forEach((r, i) => { if (r.valueRange?.length) out.push(roleValueRangeEntry(fact, i, ctx, reading)) })
  fact.roles.forEach((r, i) => { if (r.cardinalityRange?.length) out.push(roleCardinalityEntry(fact, i, ctx, reading)) })

  fact.roles.forEach((r, i) => {
    if (!r.mandatory) {
      const d = possibleMandatory(fact, i, reading, info)
      if (d) out.push(d)
      return
    }
    const xs = roleVars()
    const deontic = isDeonticMandatory(r)
    out.push({ key: `${fact.id}:mand:${i}`, elementId: fact.id, kind: deontic ? 'Mandatory role (deontic)' : 'Mandatory role',
      subject: reading, formula: modal(deontic, forall([xs[i]], exists(xs.filter((_, j) => j !== i), factAtom(fact.id, xs)))) })
  })

  for (const f of (fact.internalFrequency ?? [])) {
    const base = { key: `${fact.id}:freq:${f.id}`, elementId: fact.id, kind: f.deontic ? 'Frequency (deontic)' : 'Frequency', subject: reading }
    const specs = frequencySpecs(f.range)
    const roles = f.roles ?? []
    const xs = roleVars()
    const formula = specs.length && roles.length < arity
      ? frequencyFormula(xs.filter((_, i) => roles.includes(i)), xs.filter((_, i) => !roles.includes(i)),
          () => factAtom(fact.id, xs), specs)
      : null
    out.push(formula ? { ...base, formula: modal(f.deontic, formula) } : { ...base, note: 'No frequency range is set yet.' })
  }
  return out
}

// A preferred identifier also says that every instance of the identified type
// has exactly one identifying value (combination), written with ∃^{=1}. For an
// internal one, the identified type plays the one role outside u; for a nested
// entity type the identification comes from the nesting itself. When an
// explicit uniqueness or mandatory constraint already gives one half, only the
// other half (at most one, or at least one) is added.
function preferredIdentifierEntries(fact, u, reading) {
  const others = fact.roles.map((_, i) => i).filter(i => !u.includes(i))
  if (others.length !== 1 || (fact.objectified && fact.objectifiedKind !== 'value')) return []
  const e = others[0]
  const atMost = !(fact.uniqueness ?? []).some(v => v.length === 1 && v[0] === e)
  const atLeast = !fact.roles[e].mandatory || isDeonticMandatory(fact.roles[e])
  if (!atMost && !atLeast) return []
  const xs = fact.roles.map(r => mkVar(r.objectTypeId))
  const ys = xs.filter((_, i) => i !== e)
  const atom = factAtom(fact.id, xs)
  const [label, body] = atMost && atLeast ? ['exactly one', count('=', 1, ys, atom)]
    : atMost ? ['at most one', count('≤', 1, ys, atom)]
    : ['at least one', exists(ys, atom)]
  return [{ elementId: fact.id, subject: reading, key: `${fact.id}:pi:${u.join(',')}`,
    kind: `Preferred identifier (${label} identifier)`, formula: forall([xs[e]], body) }]
}

// The formula of a constraint with its modality: O(φ) for a deontic one.
const modal = (deontic, phi) => (deontic ? obligatory(phi) : phi)

// ── External constraints ─────────────────────────────────────────────────────

// A deontic external constraint: each of its formulas becomes O(φ).
function deonticEntries(c, e) { return asDeontic(c.deontic, e) }

// Entries (one or an array) made deontic when the flag is set.
function asDeontic(deontic, e) {
  if (!deontic) return e
  const wrap = (x) => ({ ...x, kind: `${x.kind} (deontic)`, ...(x.formula ? { formula: obligatory(x.formula) } : {}) })
  return Array.isArray(e) ? e.map(wrap) : wrap(e)
}

function constraintEntry(c, ctx) {
  const entry = { key: c.id, elementId: c.id, kind: CONSTRAINT_LABELS[c.constraintType] ?? c.constraintType,
    subject: c.name || c.label || '' }
  const seqs = c.sequences ?? []
  if (seqs.length === 0) return { ...entry, note: 'No role sequences yet.' }
  const compiled = seqs.map((s, i) => compileSequence(s, c.queries?.[i], ctx))
  const bad = compiled.find(q => q.error)
  if (bad) return { ...entry, note: `No formula yet: ${bad.error}.` }

  const typeOf = (q, i) => q.outTypes[i] ?? null
  const shared = (q) => q.outTypes.map(t => mkVar(t))
  const sameArity = compiled.every(q => q.arity === compiled[0].arity)

  switch (c.constraintType) {
    case 'inclusiveOr':
    case 'exclusiveOr': {
      const t = mkVar(c.targetObjectTypeId ?? typeOf(compiled[0], 0) ?? compiled[0].targetType)
      const Q = (q) => q.arity >= 1 ? q.build({ outVars: [t] }) : q.build({ targetVar: t })
      const disj = or(compiled.map(Q))
      if (c.constraintType === 'inclusiveOr') return { ...entry, formula: forall([t], disj) }
      const pairs = []
      for (let i = 0; i < compiled.length; i++)
        for (let j = i + 1; j < compiled.length; j++)
          pairs.push(not(and(Q(compiled[i]), Q(compiled[j]))))
      return { ...entry, formula: forall([t], and(disj, ...pairs)) }
    }
    case 'exclusion':
    case 'equality':
    case 'subset': {
      if (!sameArity) return { ...entry, note: 'The role sequences have different lengths.' }
      const xs = shared(compiled[0])
      const Q = (q) => q.build({ outVars: xs })
      if (c.constraintType === 'subset') {
        if (compiled.length < 2) return { ...entry, note: 'A subset constraint needs two role sequences.' }
        return { ...entry, formula: forall(xs, implies(Q(compiled[0]), Q(compiled[1]))) }
      }
      const parts = []
      for (let i = 0; i < compiled.length; i++)
        for (let j = i + 1; j < compiled.length; j++) {
          if (c.constraintType === 'exclusion') parts.push(not(and(Q(compiled[i]), Q(compiled[j]))))
          else if (i === 0) parts.push(iff(Q(compiled[0]), Q(compiled[j])))
        }
      if (parts.length === 0) return { ...entry, note: 'It needs at least two role sequences.' }
      return { ...entry, formula: forall(xs, and(parts)) }
    }
    case 'uniqueness':
    case 'frequency': {
      const q = compiled[0]
      if (!q.targetType) return { ...entry, note: 'No formula yet: its join path has no target object type.' }
      const xs = shared(q)
      const t = mkVar(q.targetType)
      const phi = () => q.build({ outVars: xs, targetVar: t })
      if (c.constraintType === 'uniqueness') {
        const kind = c.isPreferredIdentifier ? 'External uniqueness (preferred identifier)' : entry.kind
        const main = { ...entry, kind, formula: forall(xs, count('≤', 1, [t], phi())) }
        if (!c.isPreferredIdentifier) return main
        // Every instance of the target has exactly one identifying combination.
        return [main,
          { ...entry, key: `${c.id}:exactlyOne`, kind: 'Preferred identifier (exactly one identifying combination)',
            formula: forall([t], count('=', 1, xs, phi())) }]
      }
      const specs = frequencySpecs(c.frequency)
      const formula = specs.length ? frequencyFormula(xs, [t], phi, specs) : null
      return formula ? { ...entry, formula } : { ...entry, note: 'No frequency range is set yet.' }
    }
    case 'ring':
      return ringEntries(c, compiled[0], entry)
    case 'valueComparison': {
      const q = compiled[0]
      if (q.arity !== 2) return { ...entry, note: 'A value comparison needs two roles.' }
      const op = VALUE_OP[c.operator ?? '='] ?? c.operator
      const e = { ...entry, kind: `${entry.kind} (${op})` }
      const access = q.outTypes.map(t => valueAccess(t, ctx))
      const noValue = q.outTypes.find((t, i) => !access[i])
      if (noValue !== undefined)
        return { ...e, note: `No formula yet: ${ctx.typeName(noValue)} has no reference mode, so it has no value to compare.` }
      const [k0, k1] = access.map(a => a.kindName)
      if (k0 && k1 && k0 !== k1)
        return { ...e, note: `No formula yet: the values have different datatypes (${k0} and ${k1}).` }
      const kind = VALUE_KINDS[k0 ?? k1]
      if (kind?.order === 'none' && op !== '≈' && op !== '≉')
        return { ...e, note: `No formula yet: ${k0 ?? k1} values have no order, so only ≈ and ≉ apply.` }
      const vs = shared(q)
      const t = q.targetType ? mkVar(q.targetType) : null
      return { ...e,
        formula: forall([...(t ? [t] : []), ...vs], implies(q.build({ outVars: vs, targetVar: t }),
          withValues(vs.map((x, i) => ({ x, access: access[i] })), (v0, v1) => vcmp(op, v0, v1)))) }
    }
    default:
      return { ...entry, note: 'This constraint type has no formula yet.' }
  }
}

function ringEntries(c, q, entry) {
  if (q.arity !== 2) return [{ ...entry, note: 'A ring constraint needs two roles.' }]
  const types = c.ringTypes ?? []
  if (types.length === 0) return [{ ...entry, note: 'No ring properties are selected yet.' }]
  const T = q.outTypes[0]
  const R = (a, b) => q.build({ outVars: [a, b] })
  // [TC_{v,w} R(v, w)](s, t), with fresh bound variables v, w.
  const closure = (s, t) => {
    const [v, w] = [mkVar(T), mkVar(T)]
    return tc([v, w], R(v, w), [s, t])
  }
  return types.map(rt => {
    const e = { ...entry, key: `${c.id}:${rt}`, kind: `Ring (${RING_LABELS[rt] ?? rt})` }
    const [x, y, z] = [mkVar(T), mkVar(T), mkVar(T)]
    switch (rt) {
      case 'irreflexive':      return { ...e, formula: forall([x], not(R(x, x))) }
      case 'reflexive':        return { ...e, formula: forall([x, y], implies(R(x, y), R(x, x))) }
      case 'purely-reflexive': return { ...e, formula: forall([x, y], implies(R(x, y), cmp('=', x, y))) }
      case 'asymmetric':       return { ...e, formula: forall([x, y], implies(R(x, y), not(R(y, x)))) }
      case 'symmetric':        return { ...e, formula: forall([x, y], implies(R(x, y), R(y, x))) }
      case 'antisymmetric':    return { ...e, formula: forall([x, y], implies(and(R(x, y), cmp('≠', x, y)), not(R(y, x)))) }
      case 'transitive':       return { ...e, formula: forall([x, y, z], implies(and(R(x, y), R(y, z)), R(x, z))) }
      case 'intransitive':     return { ...e, formula: forall([x, y, z], implies(and(R(x, y), R(y, z)), not(R(x, z)))) }
      case 'acyclic':          return { ...e, formula: forall([x], not(closure(x, x))) }
      case 'strongly-intransitive':
        return { ...e, formula: forall([x, y, z], implies(and(R(x, y), closure(y, z)), not(R(x, z)))) }
      default:                 return { ...e, note: 'This ring property has no formula yet.' }
    }
  })
}

// ── Subtype edges ────────────────────────────────────────────────────────────

// Every instance of the subtype is an instance of the supertype:
// ∀Manager Person(Manager).
function subtypeEntry(st, ctx) {
  const x = mkVar(st.subId)
  return { key: st.id, elementId: st.id, kind: 'Subtype',
    subject: `${ctx.typeName(st.subId)} is a ${ctx.typeName(st.superId)}`,
    formula: forall([x], typeAtom(st.superId, x)) }
}

// ── Implicit constraints ─────────────────────────────────────────────────────
//
// Two kinds of constraint that no shape on the diagram shows, listed only on
// request: the entity-type roots of the subtype hierarchies are pairwise disjoint, and an
// instance of a type that is not independent plays at least one role (other
// than being identified by its preferred identifier).

// Every type: object types and nested entity types (objectified fact types).
function allTypes(state) {
  return [
    ...(state.objectTypes ?? []).map(o => ({ id: o.id, kind: o.kind, independent: !!o.isIndependent })),
    ...(state.facts ?? []).filter(f => f.objectified).map(f => ({
      id: f.id, kind: f.objectifiedKind === 'value' ? 'nestedValue' : 'nested', independent: !!f.isIndependent })),
  ]
}

// Roles in which the player is the type identified by a preferred identifier:
// the one role outside an internal preferred uniqueness, and the roles outside
// the sequence of an external preferred uniqueness. Returns "factId:roleIndex".
function identifiedRoles(state) {
  const out = new Set()
  for (const f of (state.facts ?? [])) {
    if (f.objectified && f.objectifiedKind !== 'value') continue
    for (const u of (f.preferredUniqueness ?? [])) {
      const others = f.roles.map((_, i) => i).filter(i => !u.includes(i))
      if (others.length === 1) out.add(`${f.id}:${others[0]}`)
    }
  }
  const factById = new Map((state.facts ?? []).map(f => [f.id, f]))
  for (const c of (state.constraints ?? [])) {
    if (c.constraintType !== 'uniqueness' || !c.isPreferredIdentifier) continue
    const inSeq = new Set()
    for (const seq of (c.sequences ?? []))
      for (const m of seq) if (m.kind === 'role' && m.factId) inSeq.add(`${m.factId.split('_il_')[0]}:${m.roleIndex}`)
    for (const key of inSeq) {
      const fact = factById.get(key.split(':')[0])
      fact?.roles.forEach((_, i) => { if (!inSeq.has(`${fact.id}:${i}`)) out.add(`${fact.id}:${i}`) })
    }
  }
  return out
}

export function implicitEntries(state, ctx, typeIds) {
  const types = allTypes(state)
  const subtypes = state.subtypes ?? []
  const supersOf = (id) => subtypes.filter(st => st.subId === id).map(st => st.superId)

  // Subtype hierarchies: connected components of the subtype graph.
  const comp = new Map()
  const find = (n) => { while (comp.get(n) !== n) n = comp.get(n); return n }
  for (const t of types) comp.set(t.id, t.id)
  for (const st of subtypes) if (comp.has(st.subId) && comp.has(st.superId)) comp.set(find(st.subId), find(st.superId))
  const ancestors = (id) => {
    const seen = new Set(), todo = [id]
    while (todo.length) for (const s of supersOf(todo.pop())) if (!seen.has(s)) { seen.add(s); todo.push(s) }
    return seen
  }

  // Disjointness: every pair of distinct entity-type roots that the scope
  // touches. Value types are left out: their disjointness from each other and
  // from entity types does not depend on the schema.
  const rootIds = []
  for (const t of types) {
    if (t.kind !== 'entity' && t.kind !== 'nested') continue
    if (supersOf(t.id).length) continue
    const inScope = [...typeIds].some(id => comp.has(id) && find(id) === find(t.id))
    if (inScope) rootIds.push(t.id)
  }
  const disjointness = []
  for (let i = 0; i < rootIds.length; i++)
    for (let j = i + 1; j < rootIds.length; j++) {
      const [a, b] = [rootIds[i], rootIds[j]]
      const x = mkVar(a)
      disjointness.push({ key: `disj:${a}:${b}`, elementId: a, kind: 'Disjoint roots',
        subject: `${ctx.typeName(a)} and ${ctx.typeName(b)}`, formula: forall([x], not(typeAtom(b, x))) })
    }

  // Participation: one disjunct for every role an instance of T can play.
  const identified = identifiedRoles(state)
  const participation = []
  for (const t of types) {
    if (!typeIds.has(t.id) || t.independent || t.kind === 'nestedValue') continue
    const up = ancestors(t.id)
    const x = mkVar(t.id)
    const disjuncts = []
    for (const f of (state.facts ?? [])) {
      f.roles.forEach((r, i) => {
        const p = r.objectTypeId
        if (!p || !comp.has(p) || find(p) !== find(t.id) || identified.has(`${f.id}:${i}`)) return
        const xs = f.roles.map((ro, j) => (j === i ? x : mkVar(ro.objectTypeId)))
        const atom = factAtom(f.id, xs)
        const body = p === t.id || up.has(p) ? atom : and(typeAtom(p, x), atom)
        disjuncts.push(exists(xs.filter((_, j) => j !== i), body))
      })
    }
    const base = { key: `part:${t.id}`, elementId: t.id, kind: 'Participation (not independent)', subject: ctx.typeName(t.id) }
    participation.push(disjuncts.length
      ? { ...base, formula: forall([x], or(disjuncts)) }
      : { ...base, note: 'It plays no role outside its preferred identifier, so its population must be empty.' })
  }
  return { disjointness, participation }
}

// ── Default verbalisation: constraints that are not there ────────────────────
//
// As NORMA does, the Constraints tab can say what the schema allows because a
// constraint is missing: "It is possible that some Person does not live in
// any City." factEntries lists them where the constraint would have been,
// marked possible: true. Only mandatory role and internal uniqueness
// constraints get one:
//   mandatory   every role that is not mandatory, explicitly or implied: an
//               identified role (preferred identifier) or the only role a
//               type that is not independent plays (implicit participation);
//   uniqueness  the maximal sets of roles, short of all of them, that contain
//               no uniqueness constraint's roles (a superset of one is
//               implied by it); an identified role counts as unique.
// Fully derived fact types get none. Each entry's formula is ◇X, X the
// counterexample of the missing constraint (verbalisation/negative.js).

// What the defaults need to know of the whole schema.
export function defaultsInfo(state) {
  const identified = identifiedRoles(state)
  return { identified, onlyRole: implicitlyMandatoryRoles(state, identified) }
}

const hasDefaults = (fact) => fact.derivation !== 'derived' && fact.roles.every(r => r.objectTypeId)

// The missing uniqueness constraints of a fact type, maximal ones only.
function possibleUniqueness(fact, reading, info) {
  const n = fact.roles.length
  if (!info || n < 2 || !hasDefaults(fact)) return []
  const isIdentified = (i) => info.identified.has(`${fact.id}:${i}`)
  const ucs = [...(fact.uniqueness ?? []), ...fact.roles.map((_, i) => i).filter(isIdentified).map(i => [i])]
  const missing = []
  for (let mask = 1; mask < (1 << n) - 1; mask++) {
    const set = fact.roles.map((_, i) => i).filter(i => mask & (1 << i))
    if (!ucs.some(u => u.every(i => set.includes(i)))) missing.push(set)
  }
  return missing
    .filter(set => !missing.some(t => t.length > set.length && set.every(i => t.includes(i))))
    .map(set => {
      const v = fact.roles.map(r => mkVar(r.objectTypeId))
      return { key: `${fact.id}:possible:uc:${set.join(',')}`, elementId: fact.id, kind: 'Possible (roles not unique)',
        subject: reading, possible: true, formula: possible(forall(v.filter((_, i) => set.includes(i)),
          count('≤', 1, v.filter((_, i) => !set.includes(i)), factAtom(fact.id, v)))) }
    })
}

// The default verbalisation of role i when it is not mandatory, or null.
function possibleMandatory(fact, i, reading, info) {
  if (!info || !hasDefaults(fact)) return null
  const key = `${fact.id}:${i}`
  if (fact.roles[i].mandatory || info.identified.has(key) || info.onlyRole.has(key)) return null
  const v = fact.roles.map(r => mkVar(r.objectTypeId))
  return { key: `${fact.id}:possible:mand:${i}`, elementId: fact.id, kind: 'Possible (role not mandatory)',
    subject: reading, possible: true, formula: possible(forall([v[i]], exists(v.filter((_, j) => j !== i), factAtom(fact.id, v)))) }
}

// ◇X for the constraint φ that is missing, X its counterexample.
const possible = (phi) => ({ t: 'possible', arg: counterexample(phi) })

// "factId:roleIndex" of the roles implicitly mandatory because their player
// is not independent and plays no other role (see implicitEntries).
function implicitlyMandatoryRoles(state, identified) {
  const types = allTypes(state)
  const subtypes = state.subtypes ?? []
  const related = (a, b) => {
    // Whether b is a or one of its sub- or supertypes, or shares a hierarchy.
    const comp = new Set([a]), todo = [a]
    while (todo.length) {
      const x = todo.pop()
      for (const st of subtypes) for (const [p, q] of [[st.subId, st.superId], [st.superId, st.subId]])
        if (p === x && !comp.has(q)) { comp.add(q); todo.push(q) }
    }
    return comp.has(b)
  }
  const out = new Set()
  for (const t of types) {
    if (t.independent || t.kind === 'nestedValue') continue
    const played = []
    for (const f of (state.facts ?? [])) f.roles.forEach((r, i) => {
      if (r.objectTypeId && related(t.id, r.objectTypeId) && !identified.has(`${f.id}:${i}`)) played.push({ f, i, p: r.objectTypeId })
    })
    if (played.length === 1 && played[0].p === t.id) out.add(`${played[0].f.id}:${played[0].i}`)
  }
  return out
}

// The semantics of nesting fact type f(A, B, C) as entity type D with implied
// links g1(D, A), g2(D, B), g3(D, C):
//   every f fact is represented by exactly one D,
//   every D combination of linked values is an f fact,
//   every D links exactly one combination of values.
export function impliedLinkEntries(fact, ctx) {
  const reading = readingText(fact, ctx)
  const base = { elementId: fact.id, subject: `${ctx.typeName(fact.id)} nests ${reading}` }
  const links = fact.roles.map((_, i) => ctx.linkById.get(`${fact.id}_il_${i}`))
  if (links.some(l => !l) || fact.roles.some(r => !r.objectTypeId))
    return [{ ...base, key: `${fact.id}:il`, kind: 'Implied links', note: 'Not every role has a player and an implied link yet.' }]
  const xs = () => fact.roles.map(r => mkVar(r.objectTypeId))
  const linked = (d, vs) => and(links.map((l, i) => factAtom(l.id, [d, vs[i]])))
  const out = []
  {
    const vs = xs(), d = mkVar(fact.id)
    out.push({ ...base, key: `${fact.id}:il:represented`, kind: 'Implied links (each fact has exactly one nesting instance)',
      formula: forall(vs, implies(factAtom(fact.id, vs), count('=', 1, [d], linked(d, vs)))) })
  }
  {
    const vs = xs(), d = mkVar(fact.id)
    out.push({ ...base, key: `${fact.id}:il:sound`, kind: 'Implied links (linked values form a fact)',
      formula: forall(vs, implies(exists([d], linked(d, vs)), factAtom(fact.id, vs))) })
  }
  {
    const vs = xs(), d = mkVar(fact.id)
    out.push({ ...base, key: `${fact.id}:il:combination`, kind: 'Implied links (each nesting instance links exactly one combination)',
      formula: forall([d], count('=', 1, vs, linked(d, vs))) })
  }
  return out
}

// ── Scope: which constraints belong to the current selection ─────────────────

export function makeContext(state) {
  const objectTypes = state.objectTypes ?? []
  const facts = state.facts ?? []
  const otById = new Map(objectTypes.map(o => [o.id, o]))
  const factById = new Map(facts.map(f => [f.id, f]))
  const typeName = (id) => {
    const p = otById.get(id) ?? factById.get(id)
    const name = (p?.name || p?.objectifiedName || '').replace(/\s+/g, '')
    return name || 'Thing'
  }
  // The implied link fact types of nested fact types, as fact-like objects:
  // roles [nested entity type, player of the base role], read "D involves A".
  const linkById = new Map()
  for (const f of facts) {
    if (!f.objectified) continue
    for (const il of (f.implicitLinks ?? [])) {
      const id = `${f.id}_il_${il.roleIndex}`
      linkById.set(id, { id, roles: [{ objectTypeId: f.id }, { objectTypeId: f.roles[il.roleIndex]?.objectTypeId }],
        readingParts: il.readingParts ?? ['', 'involves', ''], alternativeReadings: il.alternativeReadings ?? [], lexicon: il.lexicon })
    }
  }
  return {
    otById, factById, linkById, typeName,
    // The language the names and readings are in (see store/viewLanguage.js).
    liveLanguage: state.viewLanguage ?? 'en',
    schema: { facts, objectTypes, subtypes: state.subtypes ?? [], constraints: state.constraints ?? [] },
    subtypeById: new Map((state.subtypes ?? []).map(s => [s.id, s])),
  }
}

function constraintFactIds(c) {
  const ids = new Set()
  for (const seq of (c.sequences ?? []))
    for (const m of seq) if (m.kind === 'role' && m.factId) ids.add(m.factId.split('_il_')[0])
  return ids
}

// Returns the formulas for the selected part of the active diagram (or, when
// nothing is selected, for the whole diagram, or for the whole schema when
// wholeSchema is set), as a list of entries:
//   { key, elementId, kind, subject, formula? , note? }
export function formalise(state, { wholeSchema = false } = {}) {
  const ctx = makeContext(state)

  // A selected value range shows just its own formula.
  const vr = state.selectedValueRange
  if (vr) {
    const ot = vr.otId ? ctx.otById.get(vr.otId) : null
    const fact = vr.factId != null ? ctx.factById.get(vr.factId) : null
    const entry = ot?.valueRange?.length ? typeValueRangeEntry(ot, ctx)
      : fact?.roles[vr.roleIndex]?.valueRange?.length ? roleValueRangeEntry(fact, vr.roleIndex, ctx)
      : null
    const typeId = ot?.id ?? fact?.roles[vr.roleIndex]?.objectTypeId
    const implicit = implicitEntries(state, ctx, new Set(typeId ? [typeId] : []))
    implicit.impliedLinks = []
    return { entries: entry ? [entry] : [], implicit, ctx, scope: 'selection' }
  }
  // So does a selected cardinality range.
  const cr = state.selectedCardinalityRange
  if (cr) {
    const entry = selectedCardinalityEntry(cr, ctx)
    const typeId = cr.otId ?? cr.nestedFactId ?? ctx.factById.get(cr.factId)?.roles[cr.roleIndex]?.objectTypeId
    const implicit = implicitEntries(state, ctx, new Set(typeId ? [typeId] : []))
    implicit.impliedLinks = []
    return { entries: entry ? [entry] : [], implicit, ctx, scope: 'selection' }
  }
  const constraints = (state.constraints ?? []).filter(c => SEQUENCE_TYPES.has(c.constraintType))

  const selected = new Set(state.multiSelectedIds ?? [])
  if (state.selectedId) selected.add(state.selectedId.split('_il_')[0])
  for (const s of [state.selectedMandatoryDot, state.selectedUniqueness, state.selectedInternalFrequency])
    if (s?.factId) selected.add(s.factId)

  const subtypes = state.subtypes ?? []
  let factIds, otIds, constraintIds, subtypeIds
  if (selected.size === 0 && wholeSchema) {
    factIds = new Set(ctx.factById.keys())
    otIds = new Set()
    subtypeIds = new Set(subtypes.map(st => st.id))
    constraintIds = new Set(constraints.map(c => c.id))
  } else if (selected.size === 0) {
    const diagram = (state.diagrams ?? []).find(d => d.id === state.activeDiagramId)
    const onDiagram = new Set((diagram?.occurrences ?? []).map(o => o.schemaElementId))
    subtypeIds = new Set(diagram?.subtypeOccurrences
      ?? subtypes.filter(st => onDiagram.has(st.subId) && onDiagram.has(st.superId)).map(st => st.id))
    factIds = new Set([...ctx.factById.keys()].filter(id => onDiagram.has(id)))
    otIds = new Set()
    for (const co of (diagram?.constraintOccurrences ?? [])) onDiagram.add(co.schemaConstraintId)
    constraintIds = new Set(constraints.filter(c => {
      if (onDiagram.has(c.id)) return true
      const fs = constraintFactIds(c)
      return fs.size > 0 && [...fs].every(id => factIds.has(id))
    }).map(c => c.id))
  } else {
    factIds = new Set([...selected].filter(id => ctx.factById.has(id)))
    otIds = new Set([...selected].filter(id => ctx.otById.has(id)))
    subtypeIds = new Set(subtypes.filter(st =>
      selected.has(st.id) || (selected.has(st.subId) && selected.has(st.superId))).map(st => st.id))
    constraintIds = new Set(constraints.filter(c => {
      if (selected.has(c.id)) return true
      const fs = constraintFactIds(c)
      return fs.size > 0 && [...fs].every(id => factIds.has(id))
    }).map(c => c.id))
  }

  // Types in scope for the implicit constraints: all of them, those on the
  // diagram, or the selected ones and the players of the selected fact types.
  const typeIds = new Set(otIds)
  if (selected.size === 0 && wholeSchema) {
    for (const t of allTypes(state)) typeIds.add(t.id)
  } else if (selected.size === 0) {
    const diagram = (state.diagrams ?? []).find(d => d.id === state.activeDiagramId)
    for (const o of (diagram?.occurrences ?? []))
      if (ctx.otById.has(o.schemaElementId) || ctx.factById.get(o.schemaElementId)?.objectified) typeIds.add(o.schemaElementId)
  }
  for (const id of factIds) {
    const f = ctx.factById.get(id)
    if (f.objectified) typeIds.add(id)
    for (const r of f.roles) if (r.objectTypeId) typeIds.add(r.objectTypeId)
  }

  const entries = subtypes.filter(st => subtypeIds.has(st.id)).map(st => subtypeEntry(st, ctx))
  // Derivation rules of the derived and semi-derived subtypes in scope.
  for (const ot of (state.objectTypes ?? [])) {
    if (isDerived(ot) && (selected.size ? otIds.has(ot.id) : typeIds.has(ot.id))) entries.push(derivationEntry(ot, state, ctx))
  }
  // Value ranges of the value types in scope, or of the selected ones.
  for (const ot of (state.objectTypes ?? [])) {
    if (ot.kind !== 'value' || !ot.valueRange?.length) continue
    if (selected.size ? otIds.has(ot.id) : typeIds.has(ot.id)) entries.push(typeValueRangeEntry(ot, ctx))
  }
  // Cardinality ranges of the object types and nested entity types in scope.
  for (const t of [...(state.objectTypes ?? []), ...(state.facts ?? []).filter(f => f.objectified)]) {
    if (!t.cardinalityRange?.length) continue
    const inScope = selected.size ? otIds.has(t.id) || factIds.has(t.id) : typeIds.has(t.id)
    if (inScope) entries.push(typeCardinalityEntry(t.id, t.cardinalityRange, ctx, t.cardinalityRangeDeontic))
  }
  const info = defaultsInfo(state)
  for (const fact of (state.facts ?? [])) {
    if (factIds.has(fact.id)) {
      if (isDerivedFact(fact)) entries.push(...factDerivationEntries(fact, state, ctx))
      entries.push(...factEntries(fact, ctx, info))
      continue
    }
    // A selected object type brings the mandatory roles it plays.
    if (otIds.size) entries.push(...factEntries(fact, ctx).filter(e =>
      e.key.startsWith(`${fact.id}:mand:`) && otIds.has(fact.roles[Number(e.key.split(':').pop())]?.objectTypeId)))
  }
  for (const c of constraints) {
    if (!constraintIds.has(c.id)) continue
    const e = deonticEntries(c, constraintEntry(c, ctx))
    entries.push(...(Array.isArray(e) ? e : [e]))
  }
  const implicit = implicitEntries(state, ctx, typeIds)
  implicit.impliedLinks = (state.facts ?? [])
    .filter(f => factIds.has(f.id) && f.objectified && f.objectifiedKind !== 'value')
    .flatMap(f => impliedLinkEntries(f, ctx))
  return { entries, implicit, ctx,
    scope: selected.size ? 'selection' : wholeSchema ? 'schema' : 'diagram' }
}
