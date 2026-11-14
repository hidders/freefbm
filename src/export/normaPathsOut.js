// FreeFBM rule trees → NORMA role paths, for the NORMA export (the inverse
// of src/import/normaPaths.js, for conjunctive rules).
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
// Other rules (negation, disjunction, closures, value and data conditions,
// computed roles, link fact types of objectifications) are refused with a
// reason; the export keeps those as informal rules.

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
  const atoms = [], types = [], eqs = [], varType = new Map()
  const walk = (n) => {
    if (!n || typeof n !== 'object') return refuse('an empty part')
    switch (n.t) {
      case 'exists': {
        for (const v of [].concat(n.v ?? n.vars ?? [])) varType.set(v.id, v.typeId)
        return walk(n.body)
      }
      case 'and': { for (const a of n.args ?? []) { const r = walk(a); if (r?.error) return r } return null }
      case 'fact': {
        const arity = arityOf(n.factId)
        if (arity == null) return refuse('a fact type the export leaves out')
        if ((n.args ?? []).length !== arity || n.args.some(a => typeof a !== 'string')) return refuse('a fact atom with terms')
        atoms.push(n); return null
      }
      case 'type': {
        if (typeof n.arg !== 'string') return refuse('a type test of a term')
        types.push(n); return null
      }
      case 'cmp':
        if (n.op === '=' && typeof n.left === 'string' && typeof n.right === 'string') { eqs.push([n.left, n.right]); return null }
        return refuse('a comparison')
      case 'true': return null
      case 'not': return refuse('a negation')
      case 'or': return refuse('a disjunction')
      case 'tc': return refuse('a transitive closure')
      case 'vcmp': case 'pred': return refuse('a value condition')
      default: return refuse(`a ${n.t ?? 'part'} FreeFBM cannot write as a role path yet`)
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
  const err = walk(rule.body)
  if (err?.error) return err
  if (!atoms.length && !types.length) return refuse('no fact types')

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

  const subPaths = []
  atoms.forEach((a, k) => {
    const pathed = a.args.map((_, i) => el('orm:PathedRole', { id: id(`a${k}r${i}`), ref: roleRef(a.factId, i), Purpose: i === 0 ? 'PostInnerJoin' : 'SameFactType' }))
    a.args.forEach((v, i) => addNode(v, { kind: 'PathedRole', id: id(`a${k}r${i}`) }))
    subPaths.push(el('orm:SubPath', { id: id(`a${k}`) }, [
      el('orm:RootObjectType', { id: id(`a${k}root`), ref: opts.typeRef(playerOf(a.factId, 0)) }),
      el('orm:PathedRoles', {}, pathed),
    ]))
  })
  types.forEach((t, k) => {
    addNode(t.arg, { kind: 'PathRoot', id: id(`t${k}root`) })
    subPaths.push(el('orm:SubPath', { id: id(`t${k}`) }, [el('orm:RootObjectType', { id: id(`t${k}root`), ref: opts.typeRef(t.typeId) })]))
  })

  // every projected variable must be bound by the body
  for (const p of opts.projected ?? []) {
    const ns = nodes.get(find(p.varId)) ?? []
    if (!ns.length) return refuse('a role of the fact type is not bound by the rule')
  }
  if ((nodes.get(find(opts.subject)) ?? []).length < 2) return refuse('the subject is not bound by the rule')

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
