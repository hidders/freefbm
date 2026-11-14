// FreeFBM rule trees → NORMA role paths, for the NORMA export (the inverse
// of src/import/normaPaths.js, for rules without data conditions).
//
// A rule whose body is built from ∃, ∧, fact atoms, type atoms (subtype
// tests) and equalities between variables is a conjunctive query. It is
// written as one lead role path from the subject (the first role of a
// derived fact type, or the subtype of a subtype rule) that splits (And)
// into one subpath per atom. A subpath has a root object type of its own:
// for a fact atom, the player of the fact type's first role, entered through
// that role (PostInnerJoin) and walking the other roles (SameFactType); for
// a type atom, the type itself. Each pathed role stands for the object at
// that place of the atom; object unifiers say which of them are one object
// (one variable). A derived fact type's roles are projected from a pathed
// role (or the lead root) of their variable.
//
// Negation and disjunction nest: a disjunction is a subpath that splits Or
// into one subpath per part, a negation a subpath whose (And) split is
// negated (SplitIsNegated); variables shared across them are unified, and
// the importer binds each where all its uses are. Equalities between
// variables are taken outside negations and disjunctions only.
//
// Other rules (closures, value and data conditions, computed roles,
// comparisons) are refused with a reason; the export keeps those as
// informal rules.

const refuse = (why) => ({ error: why })

// conjunctivePath(rule, opts) → { path, projections } (element trees) or { error }
//   rule: { body, terms? } (derivationRule.js)
//   opts.subject: the variable id of the subject (SUBJECT for a subtype rule)
//   opts.subjectType: its type id (FreeFBM id)
//   opts.projected: [{ roleId: NORMA role id, varId }] for a fact type's roles
//   opts.factById, opts.roleRef(factId, i) → NORMA role id, opts.typeRef(typeId) → NORMA id
//   opts.playerOf(factId, i) → FreeFBM type id of the role's player
//   opts.id(part) → a NORMA id for a part of this path
//   opts.el: the export's element builder
export function conjunctivePath(rule, opts) {
  const { el, id } = opts
  if (!rule?.body) return refuse('no rule')
  if (rule.terms && Object.keys(rule.terms).length) return refuse('computed roles')
  // The body as a tree: { k: 'and' | 'or' | 'not', items } | { k: 'atom', a } | { k: 'type', t }.
  // Equalities between variables are only taken where they hold for the
  // whole rule (outside negations and disjunctions).
  const eqs = []
  let fail = null
  const tree = (n, positive) => {
    if (fail) return null
    if (!n || typeof n !== 'object') { fail = 'an empty part'; return null }
    switch (n.t) {
      case 'exists': return tree(n.body, positive)
      case 'and': return { k: 'and', items: (n.args ?? []).map(a => tree(a, positive)).filter(Boolean) }
      case 'or': return { k: 'or', items: (n.args ?? []).map(a => tree(a, false)).filter(Boolean) }
      case 'not': return { k: 'not', items: [tree(n.body ?? n.arg ?? n.args?.[0], false)].filter(Boolean) }
      case 'fact': {
        const arity = arityOf(n.factId)
        if (arity == null) { fail = 'a fact type the export leaves out'; return null }
        if ((n.args ?? []).length !== arity || n.args.some(a => typeof a !== 'string')) { fail = 'a fact atom with terms'; return null }
        return { k: 'atom', a: n }
      }
      case 'type':
        if (typeof n.arg !== 'string') { fail = 'a type test of a term'; return null }
        return { k: 'type', t: n, top: positive }
      case 'cmp':
        if (n.op === '=' && positive && typeof n.left === 'string' && typeof n.right === 'string') { eqs.push([n.left, n.right]); return null }
        fail = 'a comparison'; return null
      case 'true': return null
      case 'tc': fail = 'a transitive closure'; return null
      case 'vcmp': case 'pred': fail = 'a value condition'; return null
      default: fail = `a ${n.t ?? 'part'} FreeFBM cannot write as a role path yet`; return null
    }
  }
  // A link fact type F_il_k of an objectification is a binary: the
  // objectifying type's role (0) and the role proxy of F's role k (1).
  const link = (fid) => /^(.*)_il_(\d+)$/.exec(fid)
  function arityOf(fid) {
    const l = link(fid)
    if (l) return opts.factById.get(l[1])?.objectified || opts.isNested?.(l[1]) ? 2 : null
    return opts.factById.get(fid)?.roles.length ?? null
  }
  const roleRef = (fid, i) => { const l = link(fid); return l ? opts.linkRoleRef(l[1], Number(l[2]), i) : opts.roleRef(fid, i) }
  const playerOf = (fid, i) => { const l = link(fid); return l ? (i === 0 ? l[1] : opts.playerOf(l[1], Number(l[2]))) : opts.playerOf(fid, i) }
  const body = tree(rule.body, true)
  if (fail) return refuse(fail)
  const leaves = (t) => !t ? 0 : t.k === 'atom' || t.k === 'type' ? 1 : t.items.reduce((n, x) => n + leaves(x), 0)
  if (!leaves(body)) return refuse('no fact types')

  // one class per object: variables made equal are one
  const parent = new Map()
  const find = (x) => { while (parent.has(x) && parent.get(x) !== x) x = parent.get(x); return x }
  const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent.set(ra, rb) }
  for (const [a, b] of eqs) union(a, b)

  const nodes = new Map()      // class → [{ kind: 'PathedRole' | 'PathRoot', id }]
  const addNode = (v, node) => { const c = find(v); nodes.set(c, [...(nodes.get(c) ?? []), node]) }

  // the lead path's root: the subject
  const leadId = id('lead'), leadRoot = id('lead-root')
  addNode(opts.subject, { kind: 'PathRoot', id: leadRoot })

  // The path walks from the subject, as NORMA's own paths do: at an object
  // the path is at, each part that mentions it is a subpath from there. A
  // fact atom is entered through that object's role (PostInnerJoin) and
  // walks its other roles (SameFactType); to go on from another of its
  // objects, the atom is walked once per such object, ending at it, and the
  // copies' roles are unified. A type test steps into the type through the
  // subtype link's supertype meta role. A disjunction splits Or, a negation
  // negates its split; their parts are walked from the same object.
  let n = 0
  const same = (a, b) => find(a) === find(b)
  const mentions = (t, v) => t.k === 'atom' ? t.a.args.some(a => same(a, v))
    : t.k === 'type' ? same(t.t.arg, v) : t.items.some(x => mentions(x, v))
  const flatAnd = (t) => !t ? [] : t.k === 'and' ? t.items.flatMap(flatAnd) : [t]
  let pending = []
  const gather = (v) => {
    const out = []
    for (let i = 0; i < pending.length && !fail;) {
      if (mentions(pending[i], v)) { const [t] = pending.splice(i, 1); out.push(...emitAt(t, v)); i = 0 }
      else i++
    }
    return out
  }
  const block = (items, v) => {
    const outer = pending
    pending = items
    const out = gather(v)
    if (pending.length && !fail) fail = 'a part of a negation or disjunction that is not joined to the object it is about'
    pending = outer
    return out
  }
  function emitAt(t, v) {
    const k = n++
    if (t.k === 'atom') {
      const a = t.a, e = a.args.findIndex(x => same(x, v))
      const others = a.args.map((_, i) => i).filter(i => i !== e)
      const role = (c, i, purpose) => el('orm:PathedRole', { id: id(`a${k}c${c}r${i}`), ref: roleRef(a.factId, i), Purpose: purpose })
      if (!others.length) return [el('orm:SubPath', { id: id(`a${k}`) }, [el('orm:PathedRoles', {}, [role(0, e, 'PostInnerJoin')])])]
      // one walk per object the path goes on from (at least one walk)
      const onward = others.filter(j => pending.some(x => mentions(x, a.args[j])))
      return (onward.length ? onward : [others[others.length - 1]]).map(j => {
        const order = [...others.filter(i => i !== j), j]
        order.forEach(i => addNode(a.args[i], { kind: 'PathedRole', id: id(`a${k}c${j}r${i}`) }))
        const next = gather(a.args[j])
        return el('orm:SubPath', { id: id(`a${k}c${j}`) }, [
          el('orm:PathedRoles', {}, [role(j, e, 'PostInnerJoin'), ...order.map(i => role(j, i, 'SameFactType'))]),
          next.length && el('orm:SubPaths', {}, next),
        ])
      })
    }
    if (t.k === 'type') {
      const link = opts.subtypeLinkOf?.(t.t.typeId)
      if (!link) { fail = 'a test for a type that is no subtype'; return [] }
      // NORMA steps into a subtype by joining its supertype's meta role alone
      return [el('orm:SubPath', { id: id(`t${k}`) }, [
        el('orm:PathedRoles', {}, [el('orm:PathedRole', { id: id(`t${k}r0`), ref: link.superRole, Purpose: 'PostInnerJoin' })]),
      ])]
    }
    if (t.k === 'or') return [el('orm:SubPath', { id: id(`s${k}`), SplitCombinationOperator: 'Or' }, [
      el('orm:SubPaths', {}, t.items.map((x, j) => el('orm:SubPath', { id: id(`s${k}b${j}`) }, [el('orm:SubPaths', {}, block(flatAnd(x), v))]))),
    ])]
    return [el('orm:SubPath', { id: id(`s${k}`), SplitIsNegated: 'true' }, [el('orm:SubPaths', {}, block(t.items.flatMap(flatAnd), v))])]
  }
  pending = flatAnd(body)
  const subPaths = gather(opts.subject)
  if (!fail && pending.length) fail = 'a part that is not joined to the subject'
  if (fail) return refuse(fail)

  // every projected variable must be bound by the body
  for (const p of opts.projected ?? []) {
    const ns = nodes.get(find(p.varId)) ?? []
    if (!ns.length) return refuse('a role of the fact type is not bound by the rule')
  }
  if (!subPaths.length) return refuse('the subject is not bound by the rule')

  const unifiers = [...nodes.values()].filter(ns => ns.length > 1).map((ns, k) =>
    el('orm:ObjectUnifier', { id: id(`u${k}`) }, ns.map(n => el(`orm:${n.kind}`, { ref: n.id }))))
  const path = el('orm:PathComponents', {}, [
    el('orm:RolePath', { id: leadId }, [
      el('orm:RootObjectType', { id: leadRoot, ref: opts.typeRef(opts.subjectType) }),
      el('orm:SubPaths', {}, subPaths),
      unifiers.length && el('orm:ObjectUnifiers', {}, unifiers),
    ]),
  ])
  const projections = opts.projected ? el('orm:DerivationProjections', {}, [
    el('orm:DerivationProjection', { id: id('projection'), ref: leadId }, opts.projected.map((p, i) => {
      const ns = nodes.get(find(p.varId))
      const src = ns.find(n => n.kind === 'PathedRole') ?? ns[0]
      return el('orm:RoleProjection', { id: id(`proj${i}`), ref: p.roleId }, [
        el('orm:DerivationSource', {}, [el(`orm:${src.kind}`, { ref: src.id })]),
      ])
    })),
  ]) : null
  return { path, projections }
}
