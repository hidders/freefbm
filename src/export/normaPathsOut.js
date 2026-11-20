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
// A value condition on a variable (x ≈ 'c', x < 'c', …, and a disjunction
// of such conditions on one variable) is a value restriction on a pathed
// role that stands for the variable in the same part of the path (its
// negation or disjunction branch), or, when that part has none, on the root
// of a subpath of its own, unified with the variable. A lower and an upper
// bound of one variable in one conjunction are one range. ¬(φ ↔ ψ) is a
// split Xor.
//
// Other rules (closures, data conditions, computed roles, comparisons
// between values) are refused with a reason; the export keeps those as
// informal rules.

const refuse = (why) => ({ error: why })

// The cases of a rule that is a disjunction (under ∃, which goes into each
// case that uses its variable), or null.
function disjuncts(rule) {
  let m = (rule.extraVars ?? []).reduceRight((b, v) => ({ t: 'exists', v, body: b }), rule.body)
  const vs = []
  while (m?.t === 'exists') { vs.push(m.v); m = m.body }
  if (m?.t !== 'or' || (m.args ?? []).length < 2) return null
  const flat = (n) => (n.t === 'or' ? n.args.flatMap(flat) : [n])
  return flat(m).map(c => vs.filter(v => usesVar(c, v.id)).reduceRight((b, v) => ({ t: 'exists', v, body: b }), c))
}

// conjunctivePath(rule, opts) → { path, projections } (element trees) or { error }
//   rule: { body, terms? } (derivationRule.js)
//   opts.subject: the variable id of the subject (SUBJECT for a subtype rule)
//   opts.subjectType: its type id (FreeFBM id)
//   opts.projected: [{ roleId: NORMA role id, varId }] for a fact type's roles
//   opts.factById, opts.roleRef(factId, i) → NORMA role id, opts.typeRef(typeId) → NORMA id
//   opts.playerOf(factId, i) → FreeFBM type id of the role's player
//   opts.id(part) → a NORMA id for a part of this path
//   opts.el: the export's element builder
//   opts.valueConstraint(tag, id, ranges) → a NORMA value constraint element
export function conjunctivePath(rule, opts) {
  const { el, id } = opts
  if (!rule?.body) return refuse('no rule')
  if (rule.terms && Object.keys(rule.terms).length) return refuse('computed roles')
  // A fact type's rule that is a disjunction as a whole is written as NORMA
  // writes it: one lead path per case, each with its own projection, so
  // that each case unifies its own objects (a case may give two roles the
  // same object).
  if (opts.projected && !opts.join && !opts.oneCase) {
    const cases = disjuncts(rule)
    if (cases) {
      const parts = []
      for (const [j, body] of cases.entries()) {
        const r = conjunctivePath({ ...rule, body, extraVars: [] }, { ...opts, oneCase: true, id: (part) => id(`case${j}:${part}`) })
        if (r.error) return r
        parts.push(r)
      }
      return {
        path: el('orm:PathComponents', {}, parts.flatMap(r => r.path.children)),
        projections: el('orm:DerivationProjections', {}, parts.flatMap(r => r.projections.children)),
      }
    }
  }
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
      case 'and': return { k: 'and', items: mergeBounds((n.args ?? []).map(a => tree(a, positive)).filter(Boolean)) }
      case 'or': {
        const items = (n.args ?? []).map(a => tree(a, false)).filter(Boolean)
        // a disjunction of value conditions on one variable is one condition
        const one = items.map(x => (x.k === 'and' && x.items.length === 1 ? x.items[0] : x))
        if (one.length && one.every(x => x.k === 'value' && x.v === one[0].v)) return { k: 'value', v: one[0].v, ranges: one.flatMap(x => x.ranges) }
        return { k: 'or', items }
      }
      case 'not': {
        const b = n.body ?? n.arg ?? n.args?.[0]
        if (b?.t === 'iff') return { k: 'xor', items: [tree(b.left, false), tree(b.right, false)].filter(Boolean) }
        return { k: 'not', items: [tree(b, false)].filter(Boolean) }
      }
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
      case 'tc': fail = 'a transitive closure (NORMA has none; only the closure in a fully derived fact type\'s rule of the form ∃y ([TC* …](x, y) ∧ ψ(y, …)) is written, as recursion)'; return null
      case 'vcmp': {
        const r = valueRange(n)
        if (r) return r.negated ? { k: 'not', items: [{ k: 'value', v: r.v, ranges: [r.range] }] } : { k: 'value', v: r.v, ranges: [r.range] }
        fail = 'a comparison of values'; return null
      }
      case 'dpred': case 'pred': fail = 'a data condition'; return null
      default: fail = `a ${n.t ?? 'part'} FreeFBM cannot write as a role path yet`; return null
    }
  }
  // x op 'c' (or 'c' op x) as a range of x's values
  function valueRange(n) {
    const flip = { '<': '>', '≤': '≥', '>': '<', '≥': '≤', '≈': '≈', '≉': '≉' }
    let { op, left, right } = n
    if (left?.t === 'const' && right?.t === 'var') { [left, right] = [right, left]; op = flip[op] }
    if (left?.t !== 'var' || right?.t !== 'const' || !op) return null
    const c = right.text
    switch (op) {
      case '≈': return { v: left.id, range: { type: 'single', value: c } }
      case '≉': return { v: left.id, range: { type: 'single', value: c }, negated: true }
      case '>': case '≥': return { v: left.id, range: { type: 'lower', lower: c, lowerOpen: op === '>' } }
      case '<': case '≤': return { v: left.id, range: { type: 'upper', upper: c, upperOpen: op === '<' } }
      default: return null
    }
  }
  // a lower and an upper bound of one variable in one conjunction: one range
  function mergeBounds(items) {
    const out = [...items]
    for (let i = 0; i < out.length; i++) {
      const a = out[i]
      if (a.k !== 'value' || a.ranges.length !== 1 || !['lower', 'upper'].includes(a.ranges[0].type)) continue
      const j = out.findIndex((b, k) => k > i && b.k === 'value' && b.v === a.v && b.ranges.length === 1
        && ['lower', 'upper'].includes(b.ranges[0].type) && b.ranges[0].type !== a.ranges[0].type)
      if (j < 0) continue
      const [lo, hi] = a.ranges[0].type === 'lower' ? [a.ranges[0], out[j].ranges[0]] : [out[j].ranges[0], a.ranges[0]]
      out[i] = { k: 'value', v: a.v, ranges: [{ type: 'range', lower: lo.lower, lowerOpen: lo.lowerOpen, upper: hi.upper, upperOpen: hi.upperOpen }] }
      out.splice(j, 1)
    }
    return out
  }
  // the type of each variable, for a subpath rooted at it
  const varType = new Map([[opts.subject, opts.subjectType]])
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
  let body = tree(rule.body, true)
  if (fail) return refuse(fail)
  if (body?.k === 'value') body = { k: 'and', items: [body] }
  ;(function types(n) {
    if (!n || typeof n !== 'object') return
    if ((n.t === 'exists' || n.t === 'forall') && n.v?.typeId) varType.set(n.v.id, n.v.typeId)
    if (n.t === 'fact') (n.args ?? []).forEach((a, i) => { if (typeof a === 'string' && !varType.has(a)) varType.set(a, playerOf(n.factId, i)) })
    for (const k of ['body', 'arg', 'left', 'right']) if (n[k] && typeof n[k] === 'object') types(n[k])
    for (const a of n.args ?? []) if (a && typeof a === 'object') types(a)
  })(rule.body)
  const leaves = (t) => !t ? 0 : t.k === 'atom' || t.k === 'type' ? 1 : t.k === 'value' ? 0 : t.items.reduce((n, x) => n + leaves(x), 0)
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
    : t.k === 'type' ? same(t.t.arg, v) : t.k === 'value' ? same(t.v, v) : t.items.some(x => mentions(x, v))
  const flatAnd = (t) => !t ? [] : t.k === 'and' ? t.items.flatMap(flatAnd) : [t]
  // The value conditions of the part of the path being written: each goes on
  // a pathed role of its variable in that part (see roleEl), the rest on
  // subpaths of their own (valueRoots).
  let pending = [], vals = []
  const restriction = (v, idBase, tag) => {
    const i = vals.findIndex(x => !x.done && same(x.v, v))
    if (i < 0) return null
    vals[i].done = true
    return el('orm:ValueRestriction', {}, [opts.valueConstraint(tag, idBase, vals[i].ranges)])
  }
  const valueRoots = () => vals.filter(x => !x.done).map(x => {
    x.done = true
    const k = n++, type = varType.get(x.v) ?? varType.get([...varType.keys()].find(y => same(y, x.v)))
    if (!type) { fail = 'a value condition on a variable of no type'; return null }
    addNode(x.v, { kind: 'PathRoot', id: id(`v${k}root`) })
    return el('orm:SubPath', { id: id(`v${k}`) }, [
      el('orm:RootObjectType', { id: id(`v${k}root`), ref: opts.typeRef(type) }, [
        el('orm:ValueRestriction', {}, [opts.valueConstraint('orm:PathRootConditionValueConstraint', id(`v${k}vc`), x.ranges)]),
      ]),
    ])
  }).filter(Boolean)
  const splitVals = (items) => { const v = items.filter(x => x.k === 'value'); return [items.filter(x => x.k !== 'value'), v] }
  const gather = (v) => {
    const out = []
    for (let i = 0; i < pending.length && !fail;) {
      if (mentions(pending[i], v)) { const [t] = pending.splice(i, 1); out.push(...emitAt(t, v)); i = 0 }
      else i++
    }
    return out
  }
  const block = (items, v) => {
    const outer = pending, outerVals = vals
    ;[pending, vals] = splitVals(items)
    const out = gather(v)
    if (pending.length && !fail) fail = 'a part of a negation or disjunction that is not joined to the object it is about'
    out.push(...valueRoots())
    pending = outer; vals = outerVals
    return out
  }
  function emitAt(t, v) {
    const k = n++
    if (t.k === 'atom') {
      const a = t.a, e = a.args.findIndex(x => same(x, v))
      const others = a.args.map((_, i) => i).filter(i => i !== e)
      const role = (c, i, purpose) => {
        const rid = id(`a${k}c${c}r${i}`)
        return el('orm:PathedRole', { id: rid, ref: roleRef(a.factId, i), Purpose: purpose }, [restriction(a.args[i], id(`a${k}c${c}r${i}vc`), 'orm:PathedRoleConditionValueConstraint')].filter(Boolean))
      }
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
    if (t.k === 'or' || t.k === 'xor') return [el('orm:SubPath', { id: id(`s${k}`), SplitCombinationOperator: t.k === 'or' ? 'Or' : 'Xor' }, [
      el('orm:SubPaths', {}, t.items.map((x, j) => el('orm:SubPath', { id: id(`s${k}b${j}`) }, [el('orm:SubPaths', {}, block(flatAnd(x), v))]))),
    ])]
    return [el('orm:SubPath', { id: id(`s${k}`), SplitIsNegated: 'true' }, [el('orm:SubPaths', {}, block(t.items.flatMap(flatAnd), v))])]
  }
  // A rule that is a disjunction as a whole splits the lead path Or, as
  // NORMA's own paths do: NORMA projects the roles from each branch (their
  // places unified), and refuses a disjunction nested below the lead path.
  const top = flatAnd(body)
  const leadOr = top.length === 1 && top[0].k === 'or'
  let subPaths
  if (leadOr) {
    subPaths = top[0].items.map((x, j) => el('orm:SubPath', { id: id(`b${j}`) }, [el('orm:SubPaths', {}, block(flatAnd(x), opts.subject))]))
  } else {
    ;[pending, vals] = splitVals(top)
    subPaths = gather(opts.subject)
    if (!fail && pending.length) fail = 'a part that is not joined to the subject'
    subPaths.push(...valueRoots())
  }
  if (fail) return refuse(fail)

  // every projected variable must be bound by the body
  for (const p of opts.projected ?? []) {
    const ns = nodes.get(find(p.varId)) ?? []
    if (!ns.length) return refuse('a role of the fact type is not bound by the rule')
  }
  if (!subPaths.length) return refuse('the subject is not bound by the rule')

  // NORMA folds a path with a single plain subpath into it when it loads
  // the file, but leaves that subpath's own subpaths behind and deletes
  // them (RemoveIntraFactTypeSplits moves the parent's subpath links, not
  // the child's), and with them any projection from their roles. So the
  // path is written as NORMA keeps it: a single subpath that is neither
  // negated nor a disjunction becomes part of the path above it.
  const kids = (node, name) => (node.children ?? []).filter(c => c && c.name === name)
  const flatten = (node) => {
    for (;;) {
      const subs = kids(node, 'orm:SubPaths')[0]?.children?.filter(Boolean) ?? []
      const only = subs.length === 1 ? subs[0] : null
      if (!only || only.attrs.SplitIsNegated || kids(only, 'orm:RootObjectType').length) break
      const mine = kids(node, 'orm:PathedRoles')[0]?.children ?? []
      const theirs = kids(only, 'orm:PathedRoles')[0]?.children ?? []
      // A negated split of one part is that part's first pathed role negated
      // (NORMA's negation then covers the rest of the path, as the importer
      // reads it); the split itself would be folded away.
      if (node.attrs.SplitIsNegated) {
        if (mine.length || !theirs.length) break
        theirs[0].attrs = { ...theirs[0].attrs, IsNegated: 'true' }
        node.attrs = { ...node.attrs, SplitIsNegated: null }
      }
      const rest = (node.children ?? []).filter(c => c && c.name !== 'orm:PathedRoles' && c.name !== 'orm:SubPaths')
      const pathed = [...mine, ...theirs]
      // its subpaths now combine as they did below it
      node.attrs = { ...node.attrs, SplitCombinationOperator: only.attrs.SplitCombinationOperator ?? null }
      node.children = [
        ...rest.filter(c => c.name === 'orm:RootObjectType'),
        pathed.length && el('orm:PathedRoles', {}, pathed),
        ...kids(only, 'orm:SubPaths'),
        ...rest.filter(c => c.name !== 'orm:RootObjectType'),
      ].filter(Boolean)
    }
    for (const sp of kids(node, 'orm:SubPaths')) for (const c of sp.children ?? []) if (c) flatten(c)
    return node
  }
  const unifiers = [...nodes.values()].filter(ns => ns.length > 1).map((ns, k) =>
    el('orm:ObjectUnifier', { id: id(`u${k}`) }, ns.map(n => el(`orm:${n.kind}`, { ref: n.id }))))
  const path = el('orm:PathComponents', {}, [
    el('orm:RolePath', { id: leadId, SplitCombinationOperator: leadOr ? 'Or' : null }, [
      el('orm:RootObjectType', { id: leadRoot, ref: opts.typeRef(opts.subjectType) }),
      el('orm:SubPaths', {}, subPaths),
      unifiers.length && el('orm:ObjectUnifiers', {}, unifiers),
    ]),
  ])
  flatten(path.children[0])
  // a join path projects the constraint's roles (ConstraintRoleProjection)
  if (opts.join) {
    const projections = el('orm:JoinPathProjections', {}, [
      el('orm:JoinPathProjection', { id: id('projection'), ref: leadId }, opts.projected.map((p, i) => {
        const ns = nodes.get(find(p.varId))
        const src = ns.find(n => n.kind === 'PathedRole') ?? ns[0]
        return el('orm:ConstraintRoleProjection', { id: id(`proj${i}`), ref: p.roleId }, [el('orm:ProjectedFrom', {}, [el(`orm:${src.kind}`, { ref: src.id })])])
      })),
    ])
    return { path, projections }
  }
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

// ── Transitive closure → linear recursion ────────────────────────────────────
//
// NORMA has no closure, but a fully derived fact type F may use itself, read
// as the least fixpoint (the importer's closeLinearRecursion is the other
// way). A rule
//   F(x, n) ⇐ ∃y ([TC*_{u,w} φ(u, w)](x, y) ∧ ψ(y, n))
// in which x occurs nowhere else is
//   F(x, n) ⇐ ψ(x, n) ∨ ∃w (φ(x, w) ∧ F(w, n))
// and with TC (not TC*) the first case is ∃w (φ(x, w) ∧ ψ(w, n)). With the
// closure's arguments the other way round, φ is walked backwards.
// openRecursion(fact, rule) gives that rule, or null when the rule is not of
// this form.

function renameVars(n, map) {
  if (typeof n === 'string') return map.has(n) ? map.get(n) : n
  if (Array.isArray(n)) return n.map(x => renameVars(x, map))
  if (!n || typeof n !== 'object') return n
  const out = {}
  for (const [k, x] of Object.entries(n)) {
    // only variable references, never fact or type ids
    if (k === 'args' && (n.t === 'fact' || n.t === 'tc') || k === 'arg' && n.t === 'type'
      || (k === 'left' || k === 'right') && n.t === 'cmp' || k === 'id' && n.t === 'var') out[k] = renameVars(x, map)
    else if (x && typeof x === 'object') out[k] = renameVars(x, map)
    else out[k] = x
  }
  return out
}
// whether variable v is referred to in n (outside binders' own declarations)
function usesVar(n, v) {
  if (!n || typeof n !== 'object') return false
  if (Array.isArray(n)) return n.some(x => usesVar(x, v))
  if ((n.t === 'fact' || n.t === 'tc') && (n.args ?? []).includes(v)) return true
  if (n.t === 'type' && n.arg === v) return true
  if (n.t === 'cmp' && (n.left === v || n.right === v)) return true
  if (n.t === 'var' && n.id === v) return true
  return Object.entries(n).some(([k, x]) => k !== 'v' && k !== 'vars' && x && typeof x === 'object' && usesVar(x, v))
}

export function openRecursion(fact, rule) {
  if (!rule?.body || !fact?.roles?.length) return null
  const roleVar = fact.roles.map(r => `role:${r.id}`)
  let m = (rule.extraVars ?? []).reduceRight((b, v) => ({ t: 'exists', v, body: b }), rule.body)
  const locals = []
  while (m.t === 'exists') { locals.push(m.v); m = m.body }
  const conj = m.t === 'and' ? m.args : [m]
  const tcs = conj.filter(a => a.t === 'tc')
  if (tcs.length !== 1) return null
  const c = tcs[0], rest = conj.filter(a => a !== c)
  if (rest.some(a => JSON.stringify(a).includes('"tc"')) || !c.vars?.length || !c.args?.every(Boolean)) return null
  const [a, b] = c.args
  const forward = roleVar.includes(a) && locals.some(v => v.id === b)
  const backward = !forward && roleVar.includes(b) && locals.some(v => v.id === a)
  if (!forward && !backward) return null
  const x = forward ? a : b, y = forward ? b : a
  if (rest.some(r => usesVar(r, x)) || !rest.length) return null
  const k = roleVar.indexOf(x)

  const text = JSON.stringify(rule)
  let n = 0
  const fresh = () => { let id; do id = `rec${++n}`; while (text.includes(`"${id}"`)); return id }
  const w = { id: fresh(), typeId: c.vars[0].typeId ?? fact.roles[k].objectTypeId }
  const [u, v] = c.vars.map(z => z.id)
  // φ from x to w (forward) or from w to x (backward)
  const step = renameVars(c.body, new Map(forward ? [[u, x], [v, w.id]] : [[u, w.id], [v, x]]))
  const and = (args) => (args.length === 1 ? args[0] : { t: 'and', args })
  const bind = (vs, body) => vs.reduceRight((acc, z) => ({ t: 'exists', v: z, body: acc }), body)
  const others = locals.filter(z => z.id !== y)
  const base = c.star
    ? bind(others, renameVars(and(rest), new Map([[y, x]])))
    : bind([w], and([step, bind(others, renameVars(and(rest), new Map([[y, w.id]])))]))
  const self = { t: 'fact', factId: fact.id, args: roleVar.map((r, i) => (i === k ? w.id : r)) }
  // one recursive case per case of φ, so that each walks to w before F
  const steps = step.t === 'or' ? step.args : [step]
  const recursive = steps.map(s => bind([w], and([s, self])))
  const bases = !c.star && step.t === 'or'
    ? steps.map(s => bind([w], and([s, bind(others, renameVars(and(rest), new Map([[y, w.id]])))])))
    : [base]
  return { ...rule, body: { t: 'or', args: [...bases, ...recursive] }, extraVars: [] }
}
