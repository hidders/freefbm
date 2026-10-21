// Translates FreeFBM constraints into formulas of the ORM2 logic.
//
// Stage 1 of the logic only: first-order formulas with counting quantifiers
// ∃^{≤n}, ∃^{≥n}, ∃^{=n} for uniqueness and frequency. Constraints that need
// data terms (value and cardinality ranges) or transitive closure (acyclic,
// strongly intransitive) are listed with a note instead of a formula.
//
// Atoms use the fact type's primary reading (readingParts), whose slots follow
// roles[] order, so fact atom arguments are always in roles[] order.

import {
  mkVar, forall, exists, count, not, implies, iff, and, or,
  factAtom, typeAtom, cmp,
} from './formula.js'

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
      factParts.push({ factId: fact.id, nodes })
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

// ∀x̄ (∃ȳ φ → ⋁ (∃^{≥lo} ȳ φ ∧ ∃^{≤hi} ȳ φ)), with φ built fresh per use.
function frequencyFormula(xs, ys, phi, specs) {
  const bounds = specs.map(({ lo, hi }) => {
    if (lo != null && lo === hi) return count('=', lo, ys, phi())
    return and(
      lo != null && lo > 1 ? count('≥', lo, ys, phi()) : null,
      hi != null ? count('≤', hi, ys, phi()) : null,
    )
  })
  if (bounds.some(b => b === null)) return null
  return forall(xs, implies(exists(ys, phi()), or(bounds)))
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

// ── Internal constraints of one fact type ────────────────────────────────────

function factEntries(fact, ctx) {
  const out = []
  const reading = readingText(fact, ctx)
  const arity = fact.roles.length
  const roleVars = () => fact.roles.map(r => mkVar(r.objectTypeId))
  const preferred = new Set((fact.preferredUniqueness ?? []).map(u => [...u].sort().join(',')))

  for (const u of (fact.uniqueness ?? [])) {
    const isPreferred = preferred.has([...u].sort().join(','))
    const base = { key: `${fact.id}:uc:${u.join(',')}`, elementId: fact.id,
      kind: isPreferred ? 'Uniqueness (preferred identifier)' : 'Uniqueness', subject: reading }
    if (u.length >= arity) {
      out.push({ ...base, note: 'Spans every role, so it holds for any set of facts.' })
      continue
    }
    const xs = roleVars()
    const ys = xs.filter((_, i) => !u.includes(i))
    out.push({ ...base, formula: forall(xs.filter((_, i) => u.includes(i)), count('≤', 1, ys, factAtom(fact.id, xs))) })
    if (isPreferred) out.push(...preferredIdentifierEntries(fact, u, reading))
  }

  fact.roles.forEach((r, i) => {
    if (!r.mandatory) return
    const xs = roleVars()
    out.push({ key: `${fact.id}:mand:${i}`, elementId: fact.id, kind: 'Mandatory role', subject: reading,
      formula: forall([xs[i]], exists(xs.filter((_, j) => j !== i), factAtom(fact.id, xs))) })
  })

  for (const f of (fact.internalFrequency ?? [])) {
    const base = { key: `${fact.id}:freq:${f.id}`, elementId: fact.id, kind: 'Frequency', subject: reading }
    const specs = frequencySpecs(f.range)
    const roles = f.roles ?? []
    const xs = roleVars()
    const formula = specs.length && roles.length < arity
      ? frequencyFormula(xs.filter((_, i) => roles.includes(i)), xs.filter((_, i) => !roles.includes(i)),
          () => factAtom(fact.id, xs), specs)
      : null
    out.push(formula ? { ...base, formula } : { ...base, note: 'No frequency range is set yet.' })
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
  const atLeast = !fact.roles[e].mandatory
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

// ── External constraints ─────────────────────────────────────────────────────

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
      const vs = shared(q)
      const t = q.targetType ? mkVar(q.targetType) : null
      const op = c.operator ?? '='
      return { ...entry, kind: `${entry.kind} (${op})`,
        formula: forall([...(t ? [t] : []), ...vs], implies(q.build({ outVars: vs, targetVar: t }), cmp(op, vs[0], vs[1]))) }
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
      default:                 return { ...e, note: 'Needs transitive closure, which a later stage of the logic adds.' }
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
        readingParts: il.readingParts ?? ['', 'involves', ''] })
    }
  }
  return {
    otById, factById, linkById, typeName,
    subtypeById: new Map((state.subtypes ?? []).map(s => [s.id, s])),
  }
}

function constraintFactIds(c) {
  const ids = new Set()
  for (const seq of (c.sequences ?? []))
    for (const m of seq) if (m.kind === 'role' && m.factId) ids.add(m.factId.split('_il_')[0])
  return ids
}

// Returns the formulas for the selected part of the active diagram (or for the
// whole diagram when nothing is selected), as a list of entries:
//   { key, elementId, kind, subject, formula? , note? }
export function formalise(state) {
  const ctx = makeContext(state)
  const constraints = (state.constraints ?? []).filter(c => SEQUENCE_TYPES.has(c.constraintType))

  const selected = new Set(state.multiSelectedIds ?? [])
  if (state.selectedId) selected.add(state.selectedId.split('_il_')[0])
  for (const s of [state.selectedMandatoryDot, state.selectedUniqueness, state.selectedInternalFrequency])
    if (s?.factId) selected.add(s.factId)

  const subtypes = state.subtypes ?? []
  let factIds, otIds, constraintIds, subtypeIds
  if (selected.size === 0) {
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

  // Types in scope for the implicit constraints: those on the diagram, or the
  // selected ones and the players of the selected fact types.
  const typeIds = new Set(otIds)
  if (selected.size === 0) {
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
  for (const fact of (state.facts ?? [])) {
    if (factIds.has(fact.id)) { entries.push(...factEntries(fact, ctx)); continue }
    // A selected object type brings the mandatory roles it plays.
    if (otIds.size) entries.push(...factEntries(fact, ctx).filter(e =>
      e.kind === 'Mandatory role' && otIds.has(fact.roles[Number(e.key.split(':').pop())]?.objectTypeId)))
  }
  for (const c of constraints) {
    if (!constraintIds.has(c.id)) continue
    const e = constraintEntry(c, ctx)
    entries.push(...(Array.isArray(e) ? e : [e]))
  }
  const implicit = implicitEntries(state, ctx, typeIds)
  implicit.impliedLinks = (state.facts ?? [])
    .filter(f => factIds.has(f.id) && f.objectified && f.objectifiedKind !== 'value')
    .flatMap(f => impliedLinkEntries(f, ctx))
  return { entries, implicit, ctx,
    scope: selected.size === 0 ? 'diagram' : 'selection' }
}
