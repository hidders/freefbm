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
// case that uses its variable), or null. A disjunction inside a case with
// an equality between variables among its parts (an inlined subquery's
// identity case, x = y ∨ R(x, y)) is split into cases too, so that each
// equality holds for its whole case and becomes a unification.
const MAX_CASES = 16
function disjuncts(rule) {
  const whole = (rule.extraVars ?? []).reduceRight((b, v) => ({ t: 'exists', v, body: b }), rule.body)
  const flat = (n) => (n.t === 'or' ? n.args.flatMap(flat) : [n])
  const isEq = (n) => n?.t === 'cmp' && n.op === '=' && typeof n.left === 'string' && typeof n.right === 'string'
  const hasEq = (n) => n?.t === 'or' && flat(n).some(c => { let m = c; while (m?.t === 'exists') m = m.body; return isEq(m) || (m?.t === 'and' && m.args.some(isEq)) })
  // the alternatives of n: ∃ passes through, ∨ splits (at the top, or when
  // it has an equality), ∧ takes the product of its parts' alternatives
  const alts = (n, top) => {
    if (n?.t === 'exists') return alts(n.body, top).map(b => usesVar(b, n.v.id) ? { t: 'exists', v: n.v, body: b } : b)
    if (n?.t === 'or' && (top || hasEq(n))) return flat(n).flatMap(c => alts(c, true))
    if (n?.t === 'and') {
      let out = [[]]
      for (const a of n.args ?? []) {
        const as = alts(a, false)
        out = out.flatMap(xs => as.map(x => [...xs, x]))
        if (out.length > MAX_CASES) return [n]
      }
      return out.map(xs => (xs.length === 1 ? xs[0] : { t: 'and', args: xs.flatMap(x => (x.t === 'and' ? x.args : [x])) }))
    }
    return [n]
  }
  const cases = alts(whole, true)
  return cases.length >= 2 && cases.length <= MAX_CASES ? cases : null
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
  // Computed roles: a term is a calculated value of the path projected to
  // its role: an aggregate over the rule's own body (NORMA's aggregate over
  // the path, grouped by the objects it shares with the rule), or variables
  // and constants under data operators (functions of the model).
  const computed = []   // { roleVar, agg?: { fn, distinct, by, input }, term? }
  for (const [roleId, t] of Object.entries(rule.terms ?? {})) {
    if (!opts.functionOf || opts.join) return refuse('computed roles')
    if (t?.t === 'agg') {
      const a = aggregateOver(rule, t)
      if (!a) return refuse('an aggregate that is not over the rule\'s own body')
      computed.push({ roleVar: `role:${roleId}`, agg: a })
    } else if (calculable(t)) computed.push({ roleVar: `role:${roleId}`, term: t })
    else return refuse('computed roles')
  }
  const computedVar = new Set(computed.map(a => a.roleVar))
  const plain = (opts.projected ?? []).filter(p => !computedVar.has(p.varId))
  // comparisons of values and data conditions of the whole rule: calculated
  // conditions of the lead path
  const calcConds = []
  // A fact type's rule that is a disjunction as a whole is written as NORMA
  // writes it: one lead path per case, each with its own projection, so
  // that each case unifies its own objects (a case may give two roles the
  // same object).
  if (opts.projected && !opts.join && !opts.oneCase) {
    const cases = disjuncts(rule)
    if (cases && computed.length) return refuse('computed roles in a rule of several cases')
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
        // NORMA's conditions belong to the lead path, so only one that
        // holds for the whole rule
        if (positive && opts.functionOf && !opts.join && calculable(n.left) && calculable(n.right)) { calcConds.push(n); return null }
        fail = positive ? 'a comparison of values' : 'a comparison of values inside a negation or disjunction'; return null
      }
      case 'dpred': case 'pred':
        if (n.t === 'dpred' && positive && opts.functionOf && !opts.join && (n.args ?? []).every(calculable)) { calcConds.push(n); return null }
        fail = positive ? 'a data condition' : 'a data condition inside a negation or disjunction'; return null
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

  // one class per object: variables made equal are one
  const parent = new Map()
  const find = (x) => { while (parent.has(x) && parent.get(x) !== x) x = parent.get(x); return x }
  const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent.set(ra, rb) }
  for (const [a, b] of eqs) union(a, b)
  // The root is of the most specific type of the subject's variables (a
  // case x = y projects both roles from it, as NORMA's own paths do).
  let rootType = opts.subjectType
  const below = (t, sup) => { for (let k = 0, x = t; x && k < 32; k++) { if (x === sup) return true; x = opts.subtypeLinkOf?.(x)?.superId } return false }
  for (const p of plain) {
    if (p.typeId && find(p.varId) === find(opts.subject) && p.typeId !== rootType && below(p.typeId, rootType)) rootType = p.typeId
  }
  if (rootType !== opts.subjectType) varType.set(opts.subject, rootType)
  // A case without fact types is the root alone, when it projects every
  // role from it (an instance of the root's type, x = y).
  const rootOnly = !leaves(body) && !opts.join && plain.length && !computed.length
    && plain.every(p => find(p.varId) === find(opts.subject)) && !(body?.items ?? []).some(x => x.k === 'value')
  if (!leaves(body) && !rootOnly) return refuse('no fact types')

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
    // a type test of v first: the parts after it are walked from the subtype
    const ti = pending.findIndex(x => x.k === 'type' && same(x.t.arg, v))
    if (ti > 0) pending.unshift(...pending.splice(ti, 1))
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
      // NORMA steps into a subtype through its supertype's meta role, then
      // its subtype's. An object of another subtype of that supertype first climbs
      // to it through its own subtype links (NORMA refuses to join an object
      // to a role its type does not play: "incompatible role player").
      const climb = []
      let at = varType.get(v) ?? varType.get([...varType.keys()].find(y => same(y, v)))
      for (let guard = 0; at && at !== link.superId && guard < 20; guard++) {
        const up = opts.subtypeLinkOf?.(at)
        if (!up) { climb.length = 0; break }
        climb.push(up)
        at = up.superId
      }
      if (at !== link.superId) climb.length = 0
      const next = gather(v)
      return [el('orm:SubPath', { id: id(`t${k}`) }, [
        el('orm:PathedRoles', {}, [
          ...climb.flatMap((up, j) => [
            el('orm:PathedRole', { id: id(`t${k}u${j}a`), ref: up.subRole, Purpose: 'PostInnerJoin' }),
            el('orm:PathedRole', { id: id(`t${k}u${j}b`), ref: up.superRole, Purpose: 'SameFactType' }),
          ]),
          el('orm:PathedRole', { id: id(`t${k}r0`), ref: link.superRole, Purpose: 'PostInnerJoin' }),
          el('orm:PathedRole', { id: id(`t${k}r1`), ref: link.subRole, Purpose: 'SameFactType' }),
        ]),
        // the rest of what is said about the object goes on from the
        // subtype, so that roles only the subtype plays are joined from it
        next.length && el('orm:SubPaths', {}, next),
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
    // Parts not joined to the subject start from an object of their own: a
    // subpath with a root object type (NORMA's new object, joined to the
    // rest through unifiers and the path's conditions), from a role the
    // rule projects where there is one.
    const candidates = [...(opts.projected ?? []).map(p => p.varId), ...varType.keys()]
    while (!fail && pending.length && calcConds.length) {
      const v = candidates.find(y => pending.some(x => mentions(x, y)) && varType.get(y))
      if (!v) break
      const k = n++
      addNode(v, { kind: 'PathRoot', id: id(`r${k}root`) })
      const inner = gather(v)
      subPaths.push(el('orm:SubPath', { id: id(`r${k}`) }, [
        el('orm:RootObjectType', { id: id(`r${k}root`), ref: opts.typeRef(varType.get(v)) }),
        inner.length && el('orm:SubPaths', {}, inner),
      ]))
    }
    if (!fail && pending.length) fail = 'a part that is not joined to the subject'
    subPaths.push(...valueRoots())
  }
  if (fail) return refuse(fail)

  // every projected variable must be bound by the body
  for (const p of plain) {
    const ns = nodes.get(find(p.varId)) ?? []
    if (!ns.length) return refuse('a role of the fact type is not bound by the rule')
  }
  if (!subPaths.length && !rootOnly) return refuse('the subject is not bound by the rule')

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
  const nodeOf = (v) => { const ns = nodes.get(find(v)) ?? []; return ns.find(n => n.kind === 'PathedRole') ?? ns[0] }
  // calculated values: each gets an id, inputs are path nodes, constants or
  // other calculated values (written before the ones that use them)
  const calcEls = []
  const nodeRef = (n) => el(`orm:${n.kind}`, { ref: n.id })
  const calc = (spec, sources, extra = {}) => {
    const k = calcEls.length
    const fn = opts.functionOf({ ...spec, arity: sources.length })
    const cid = id(`calc${k}`)
    calcEls.push(null)   // keeps the number while the inputs are written
    calcEls[k] = el('orm:CalculatedValue', { id: cid, UniversalAggregationContext: extra.universal ? 'true' : null }, [
      el('orm:Function', { ref: fn.ref }),
      extra.context && extra.context.length && el('orm:AggregationContext', {}, extra.context.map(nodeRef)),
      el('orm:Inputs', {}, sources.map((src, i) => el('orm:Input', { id: id(`calc${k}in${i}`), DistinctValues: extra.distinct ? 'true' : null }, [
        el('orm:Parameter', { ref: fn.params[i] }),
        el('orm:Source', {}, [src]),
      ]))),
    ])
    return cid
  }
  let calcFail = null
  const source = (t) => {
    if (t?.t === 'var') {
      const n = nodeOf(t.id)
      if (!n) { calcFail = 'a calculation reading an object the path does not reach'; return null }
      return nodeRef(n)
    }
    if (t?.t === 'const') return el('orm:Constant', { id: id(`const${calcEls.length}_${constCount++}`) }, [el('orm:Value', {}, String(t.text ?? ''))])
    if (t?.t === 'op') {
      const args = t.args.map(source)
      if (calcFail) return null
      return el('orm:CalculatedValue', { ref: calc(OP_FUNCTIONS[t.op] ?? { name: t.op }, args) })
    }
    calcFail = 'a term the export cannot write as a calculation'; return null
  }
  let constCount = 0
  const condIds = []
  for (const c of calcConds) {
    const args = c.t === 'vcmp' ? [source(c.left), source(c.right)] : c.args.map(source)
    if (calcFail) return refuse(calcFail)
    condIds.push(calc(c.t === 'vcmp' ? CMP_FUNCTIONS[c.op] : { name: c.op, isBoolean: true }, args))
  }
  const projectedCalc = new Map()   // role var → calculated value id or constant element
  for (const c of computed) {
    if (c.agg) {
      const a = c.agg
      if ([...a.by, a.input].some(v => !nodeOf(v))) return refuse('an aggregate over an object the path does not reach')
      projectedCalc.set(c.roleVar, el('orm:CalculatedValue', { ref: calc({ name: a.fn, bag: true }, [nodeRef(nodeOf(a.input))],
        { context: a.by.map(nodeOf), universal: !a.by.length, distinct: a.distinct }) }))
    } else {
      const src = source(c.term)
      if (calcFail) return refuse(calcFail)
      if (src.name === 'orm:PathedRole' || src.name === 'orm:PathRoot') return refuse('a computed role that is another object of the path')
      projectedCalc.set(c.roleVar, src)
    }
  }
  const path = el('orm:PathComponents', {}, [
    el('orm:RolePath', { id: leadId, SplitCombinationOperator: leadOr ? 'Or' : null }, [
      el('orm:RootObjectType', { id: leadRoot, ref: opts.typeRef(rootType) }),
      subPaths.length && el('orm:SubPaths', {}, subPaths),
      unifiers.length && el('orm:ObjectUnifiers', {}, unifiers),
      calcEls.length && el('orm:CalculatedValues', {}, calcEls),
      condIds.length && el('orm:Conditions', {}, condIds.map(ref => el('orm:CalculatedCondition', { ref }))),
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
      if (projectedCalc.has(p.varId)) return el('orm:RoleProjection', { id: id(`proj${i}`), ref: p.roleId }, [
        el('orm:DerivationSource', {}, [projectedCalc.get(p.varId)]),
      ])
      const ns = nodes.get(find(p.varId))
      const src = ns.find(n => n.kind === 'PathedRole') ?? ns[0]
      return el('orm:RoleProjection', { id: id(`proj${i}`), ref: p.roleId }, [
        el('orm:DerivationSource', {}, [el(`orm:${src.kind}`, { ref: src.id })]),
      ])
    })),
  ]) : null
  return { path, projections }
}

// A computed role's term that NORMA can write: an aggregate F{t | v̄ : φ}
// (count without t) whose φ is the rule's body with v̄ for the rule's own
// variables (∃, in order), so that it aggregates over the path. Gives
// { fn, by, input } (by: the rule's variables φ also reads, the grouping;
// input: the rule's variable for t, or for count its first one), or null.
const AGG_FNS = new Set(['count', 'sum', 'avg', 'min', 'max'])
function aggregateOver(rule, t) {
  if (t?.t !== 'agg' || !AGG_FNS.has(t.fn)) return null
  let body = rule.body
  const own = [...(rule.extraVars ?? [])]
  while (body?.t === 'exists') { own.push(body.v); body = body.body }
  if (own.length !== (t.vars ?? []).length || !own.length || own.length > 5) return null
  // the aggregate's variables in some order are the rule's own (∃ inside
  // its condition left out on both sides)
  const strip = (n) => { while (n?.t === 'exists') n = n.body; return n }
  const want = JSON.stringify(strip(body))
  const perms = (xs) => xs.length <= 1 ? [xs] : xs.flatMap((x, i) => perms([...xs.slice(0, i), ...xs.slice(i + 1)]).map(r => [x, ...r]))
  const map = perms(own).map(o => new Map(t.vars.map((v, i) => [v.id, o[i].id])))
    .find(m => t.vars.every((v, i) => v.typeId === own.find(o => o.id === m.get(v.id)).typeId) && JSON.stringify(renameVars(strip(t.cond), m)) === want)
  if (!map) return null
  let input
  if (t.fn === 'count') { if (t.term) return null; input = own[0].id }
  else { if (t.term?.t !== 'var' || !map.has(t.term.id)) return null; input = map.get(t.term.id) }
  const by = [...new Set(freeVarsOf(t.cond))].filter(v => !map.has(v))
  return { fn: t.fn, distinct: !!t.distinct, by, input }
}
// A data term the export can write as calculated values: variables,
// constants and data operators over them.
function calculable(t) {
  if (t?.t === 'var' || t?.t === 'const') return true
  if (t?.t === 'op') return (t.args ?? []).every(calculable)
  return false
}
// The model's functions for comparisons and operators, named and with
// the symbols the importer reads (src/import/normaPaths.js FUNCTIONS);
// other data operators and predicates go by their own names.
const CMP_FUNCTIONS = {
  '≈': { name: 'equals', symbol: '=', isBoolean: true }, '≉': { name: 'notEquals', symbol: '<>', isBoolean: true },
  '<': { name: 'lessThan', symbol: '<', isBoolean: true }, '≤': { name: 'lessThanOrEqual', symbol: '<=', isBoolean: true },
  '>': { name: 'greaterThan', symbol: '>', isBoolean: true }, '≥': { name: 'greaterThanOrEqual', symbol: '>=', isBoolean: true },
}
const OP_FUNCTIONS = {
  add: { name: 'add', symbol: '+' }, sub: { name: 'subtract', symbol: '-' }, neg: { name: 'subtract', symbol: '-' },
  mul: { name: 'multiply', symbol: '*' }, div: { name: 'divide', symbol: '/' }, mod: { name: 'mod', symbol: '%' },
  concat: { name: 'concat' },
}
// The variable ids a rule tree reads (fact arguments, type tests, var terms,
// cmp sides), bound or not.
function freeVarsOf(n, out = []) {
  if (!n || typeof n !== 'object') return out
  if (Array.isArray(n)) { n.forEach(x => freeVarsOf(x, out)); return out }
  if (n.t === 'fact') out.push(...(n.args ?? []).filter(a => typeof a === 'string'))
  if (n.t === 'type' && typeof n.arg === 'string') out.push(n.arg)
  if (n.t === 'var') out.push(n.id)
  if (n.t === 'cmp') out.push(...[n.left, n.right].filter(a => typeof a === 'string'))
  for (const [k, x] of Object.entries(n)) if (k !== 'v' && k !== 'vars' && x && typeof x === 'object') freeVarsOf(x, out)
  return out
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
