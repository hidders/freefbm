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
        return { ...entry, kind, formula: forall(xs, count('≤', 1, [t], phi())) }
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
  return {
    otById, factById, typeName,
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

  let factIds, otIds, constraintIds
  if (selected.size === 0) {
    const diagram = (state.diagrams ?? []).find(d => d.id === state.activeDiagramId)
    const onDiagram = new Set((diagram?.occurrences ?? []).map(o => o.schemaElementId))
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
    constraintIds = new Set(constraints.filter(c => {
      if (selected.has(c.id)) return true
      const fs = constraintFactIds(c)
      return fs.size > 0 && [...fs].every(id => factIds.has(id))
    }).map(c => c.id))
  }

  const entries = []
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
  return { entries, ctx, scope: selected.size === 0 ? 'diagram' : 'selection' }
}
