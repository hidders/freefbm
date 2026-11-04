// Graphical constraints among formulas (formula plan, step 5).
//
// A formula constraint, or the translation of a lost constraint
// (translate.js), often says what a graphical constraint with join paths
// says. asGraphical(rule) recognises these shapes, with ȳ the leading ∀
// variables and L, R, ψ positive existential parts (∃, ∧, fact and type
// atoms, ≈):
//
//   ∀ȳ (L → x op y)               value comparison, L its join path
//   ∀ȳ (L → R)                     subset, L and R the join paths
//   ∀ȳ (G → (L ↔ R)), ∀ȳ (L ↔ R)   equality (G ∧ L, G ∧ R)
//   ∀ȳ (G → ¬(L ∧ R)), ∀ȳ (L → ¬R) exclusion
//   ∀ȳ (G ∧ ∃t ψ → ∃^{…} t ψ)       frequency (uniqueness for ≤ 1) over ȳ,
//                                   target t, join path G ∧ ψ
//   ∀t (L1 ∨ … ∨ Ln)                inclusive-or of the Li about t
//   ∀y (∃z F(z,y) → L1 ∨ … ∨ Ln)    inclusive-or about z: ∃y (F(z,y) ∧ Li);
//                                   with ¬(Li ∧ Lj) for each pair, exclusive-or
//
// Each sequence position is a role where its variable occurs in a fact atom
// of that join path. The result is { constraintType, sequences, queries,
// operator?, frequency?, targetObjectTypeId? } (queries are formula queries,
// query.js), or null.

const VC_OF = { '≈': '=', '≉': '≠', '<': '<', '≤': '≤', '>': '>', '≥': '≥' }

const conj = (n) => (!n ? [] : n.t === 'and' ? n.args.flatMap(conj) : [n])
const andOf = (parts) => {
  const flat = parts.filter(Boolean).flatMap(conj).filter(p => p.t !== 'true')
  return flat.length === 0 ? { t: 'true' } : flat.length === 1 ? flat[0] : { t: 'and', args: flat }
}

// Whether a part is positive existential.
function positive(n) {
  if (!n) return false
  switch (n.t) {
    case 'true': case 'fact': case 'type': return true
    case 'exists': return positive(n.body)
    case 'and': return n.args.every(positive)
    case 'vcmp': return n.op === '≈'
    default: return false
  }
}

// A role where variable id occurs in a fact atom of n (not an implied link).
function roleOf(n, id) {
  if (!n || typeof n !== 'object') return null
  if (n.t === 'fact') {
    if (n.factId.includes('_il_')) return null
    const i = n.args.indexOf(id)
    return i >= 0 ? { kind: 'role', factId: n.factId, roleIndex: i } : null
  }
  for (const k of ['body', 'arg', 'left', 'right']) { const r = roleOf(n[k], id); if (r) return r }
  for (const a of n.args ?? []) { if (typeof a === 'object') { const r = roleOf(a, id); if (r) return r } }
  return null
}

const free = (vars) => vars.map(v => ({ id: v.id, typeId: v.typeId }))
const query = (vars, body, target = null) => ({ free: free(vars), target, body })

// Sequences and queries of a set comparison over vars, or null.
function setComparison(constraintType, vars, bodies) {
  if (!vars.length || !bodies.every(positive)) return null
  const sequences = bodies.map(b => vars.map(v => roleOf(b, v.id)))
  if (sequences.some(s => s.some(m => !m))) return null
  return { constraintType, sequences, queries: bodies.map(b => query(vars, b)) }
}

// The part with bound variable ids renamed in order of binding and `as`
// renamed to '$', for comparing two parts up to bound names.
function canon(n, as) {
  const map = new Map(as ? [[as, '$']] : [])
  let k = 0
  const go = (x) => {
    if (Array.isArray(x)) return x.map(go)
    if (!x || typeof x !== 'object') return typeof x === 'string' && map.has(x) ? map.get(x) : x
    const out = {}
    if ((x.t === 'exists' || x.t === 'forall' || x.t === 'count') && x.v) { map.set(x.v.id, `b${k++}`); out.v = { ...x.v, id: map.get(x.v.id) } }
    for (const [key, val] of Object.entries(x)) {
      if (key === 'v' && out.v) continue
      out[key] = key === 'id' || key === 'arg' || key === 'args' || typeof val === 'object' ? go(val) : val
    }
    return out
  }
  return JSON.stringify(go(n))
}

function frequencyOf(c) {
  const n = String(c.n), m = c.m != null ? String(c.m) : null
  switch (c.op) {
    case '≤': return [{ type: 'upper', upper: n }]
    case '≥': return [{ type: 'lower', lower: n }]
    case '=': return [{ type: 'single', value: n }]
    case '..': return [{ type: 'range', lower: n, upper: m }]
    default: return null
  }
}

export function asGraphical(rule) {
  const vars = []
  let n = rule
  while (n?.t === 'forall') { vars.push(n.v); n = n.body }
  if (!n || !vars.length) return null

  if (n.t === 'implies') {
    const { left: L, right: R } = n
    // Value comparison.
    if (R?.t === 'vcmp' && VC_OF[R.op] && R.left?.t === 'var' && R.right?.t === 'var' && R.left.id !== R.right.id) {
      const va = vars.find(v => v.id === R.left.id), vb = vars.find(v => v.id === R.right.id)
      const ra = roleOf(L, R.left.id), rb = roleOf(L, R.right.id)
      if (!va || !vb || !ra || !rb || !positive(L)) return null
      const rest = vars.filter(v => v !== va && v !== vb)
      const body = rest.reduceRight((b, v) => ({ t: 'exists', v, body: b }), L)
      return { constraintType: 'valueComparison', sequences: [[ra, rb]], queries: [query([va, vb], body)], operator: VC_OF[R.op] }
    }
    // Equality or exclusion under a guard.
    if (R?.t === 'iff') return setComparison('equality', vars, [andOf([L, R.left]), andOf([L, R.right])])
    if (R?.t === 'not' && R.arg?.t === 'and' && R.arg.args.length === 2) return setComparison('exclusion', vars, [andOf([L, R.arg.args[0]]), andOf([L, R.arg.args[1]])])
    if (R?.t === 'not' && positive(R.arg)) return setComparison('exclusion', vars, [L, R.arg])
    // Frequency: the antecedent holds ∃t ψ, the consequent counts t with ψ.
    if (R?.t === 'count' && R.v) {
      const range = frequencyOf(R)
      if (!range || !positive(R.body)) return null
      // The antecedent's ∃t ψ: the same part, else one about a t of the same
      // type (the check of the result decides whether it says the same).
      const want = canon(R.body, R.v.id)
      const parts = conj(L)
      let k = parts.findIndex(p => p.t === 'exists' && canon(p.body, p.v.id) === want)
      if (k < 0) k = parts.findIndex(p => p.t === 'exists' && p.v.typeId === R.v.typeId)
      if (k < 0) return null
      const body = andOf([...parts.filter((_, i) => i !== k), R.body])
      if (!positive(body)) return null
      const sequence = vars.map(v => roleOf(body, v.id))
      if (sequence.some(m => !m)) return null
      const uniqueness = R.op === '≤' && R.n === 1
      return { constraintType: uniqueness ? 'uniqueness' : 'frequency', sequences: [sequence],
        queries: [query(vars, body, { id: R.v.id, typeId: R.v.typeId })], targetObjectTypeId: R.v.typeId,
        ...(uniqueness ? {} : { frequency: range }) }
    }
    // Inclusive- or exclusive-or about the instance z of a guard ∃z F(z, y):
    // ∀z (∃y (F(z, y) ∧ L1) ∨ …).
    const disjuncts = R?.t === 'or' ? R.args
      : R?.t === 'and' && R.args[0]?.t === 'or' && R.args.slice(1).every(p => p.t === 'not') ? R.args[0].args : null
    if (disjuncts && vars.length === 1 && L?.t === 'exists' && L.body?.t === 'fact' && L.body.args.length === 2 && L.body.args.includes(vars[0].id) && L.body.args.includes(L.v.id)) {
      if (!disjuncts.every(positive)) return null
      const z = L.v, y = vars[0]
      const exclusive = R.t === 'and'
      if (exclusive && R.args.length - 1 !== disjuncts.length * (disjuncts.length - 1) / 2) return null
      const bodies = disjuncts.map(d => ({ t: 'exists', v: y, body: andOf([L.body, d]) }))
      const sequences = bodies.map(b => [roleOf(b, z.id)])
      if (sequences.some(q => !q[0])) return null
      return { constraintType: exclusive ? 'exclusiveOr' : 'inclusiveOr', sequences, queries: bodies.map(b => query([z], b)), targetObjectTypeId: z.typeId }
    }
    // Subset.
    return setComparison('subset', vars, [L, R])
  }
  if (n.t === 'iff') return setComparison('equality', vars, [n.left, n.right])
  if (n.t === 'not' && n.arg?.t === 'and' && n.arg.args.length === 2) return setComparison('exclusion', vars, n.arg.args)
  // Inclusive-or about one variable.
  if (n.t === 'or' && vars.length === 1 && n.args.every(positive)) {
    const t = vars[0]
    const sequences = n.args.map(b => [roleOf(b, t.id)])
    if (sequences.some(s => !s[0])) return null
    return { constraintType: 'inclusiveOr', sequences, queries: n.args.map(b => query([t], b)), targetObjectTypeId: t.typeId }
  }
  return null
}

// The graphical constraint as fields of a constraint (mkConstraint's shape).
export function graphicalFields(g) {
  return {
    constraintType: g.constraintType, sequences: g.sequences, queries: g.queries,
    ...(g.operator ? { operator: g.operator } : {}),
    ...(g.frequency ? { frequency: g.frequency } : {}),
    ...(g.targetObjectTypeId ? { targetObjectTypeId: g.targetObjectTypeId } : {}),
  }
}

export const GRAPHICAL_NAME = {
  valueComparison: 'a value comparison', subset: 'a subset constraint', equality: 'an equality constraint',
  exclusion: 'an exclusion constraint', frequency: 'an external frequency constraint', uniqueness: 'an external uniqueness constraint',
  inclusiveOr: 'an inclusive-or constraint', exclusiveOr: 'an exclusive-or constraint',
}
