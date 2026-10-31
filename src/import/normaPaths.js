// NORMA role paths → FreeFBM rule trees (the format of derivationRule.js).
//
// NORMA states derivation rules and join paths as role paths. A path starts
// at a root object type and walks through fact types: a join (StartRole,
// PostInnerJoin) enters a fact type through a role played by the object the
// path is at, and SameFactType roles move on to other roles of that fact
// type. Each pathed role stands for the object that plays it. After its own
// roles a path can split into subpaths, combined with And, Or or Xor (each
// optionally negated), and each subpath continues from where its parent
// ended. A negated join negates the fact type it enters together with the
// rest of its path (NORMA's verbaliser scopes the negation the same way).
// Object unifiers say that several pathed roles stand for one object, and a
// pathed role (or the root) can carry a value condition.
//
// The translation gives each object (pathed roles joined or unified are one
// object) a variable, each fact type entry a fact atom over all its roles
// (roles the path does not visit get variables of their own), each subtype
// link a type atom and each value condition a comparison of the object's data
// value. A variable is bound by ∃ at the innermost negation or branch that
// holds all its uses; the projected objects are the rule's free variables.
//
// Not translated (reported as the reason): outer joins, negated roots,
// calculated values and constants, and paths that walk into the implicit
// boolean role of an old-style unary through its value.

import { SUBJECT } from '../logic/derivationRule.js'

const kids = (el, name) => el ? [...el.children].filter(c => !name || c.localName === name) : []
const kid  = (el, name) => kids(el, name)[0] ?? null
const attr = (el, name) => el?.getAttribute(name) ?? null

// A link fact type F_il_k: F and k.
const baseFact = (m) => (m.link ? m.factId.split('_il_')[0] : m.factId)
const linkIndex = (m) => Number(m.factId.split('_il_')[1])

class Untranslatable extends Error {}
const fail = (why) => { throw new Untranslatable(why) }

// ctx: {
//   roleRef(normaRoleId)  → { kind: 'role', factId, roleIndex, link? } | { kind: 'subtype', subtypeId, side }
//                           | { kind: 'booleanRole', factId } | undefined
//   playerOf(member)      → the object type (or nested fact type) id that plays it
//   factById, stById, typeOf(normaTypeId) → FreeFBM type id
//   up(typeId)            → the set of the type and all its supertypes
//   rangesOf(valueConstraintEl) → FreeFBM range specs
// }
export function makePathTranslator(ctx) {
  // One path: nodes are NORMA ids of path roots and pathed roles, and fresh
  // ids for roles a path does not visit. The paths of one rule share
  // `counter`, so their variables get distinct ids.
  function session(counter = { n: 0 }) {
    const parent = new Map()
    const nodeTypes = new Map()   // node → [typeId]
    let fresh = 0
    const add = (n, typeId) => {
      if (!parent.has(n)) { parent.set(n, n); nodeTypes.set(n, []) }
      if (typeId && !nodeTypes.get(n).includes(typeId)) nodeTypes.get(n).push(typeId)
      return n
    }
    const find = (n) => { while (parent.get(n) !== n) n = parent.get(n); return n }
    const union = (a, b) => {
      const ra = find(a), rb = find(b)
      if (ra === rb) return
      parent.set(rb, ra)
      for (const t of nodeTypes.get(rb)) if (!nodeTypes.get(ra).includes(t)) nodeTypes.get(ra).push(t)
    }
    const freshNode = (typeId) => add(`_n${++fresh}`, typeId)

    const valueCondition = (el) => {
      const vr = kid(el, 'ValueRestriction')
      const vc = vr && kids(vr)[0]
      const ranges = vc ? ctx.rangesOf(vc) : []
      return ranges.length ? ranges : null
    }

    // A path's own roles, then its split, from context node `at`. Returns a
    // list of IR items; negation and branches are { k: 'scope', item }.
    function walkPath(pathEl, at) {
      const roles = kids(kid(pathEl, 'PathedRoles'), 'PathedRole')
      return walkRoles(roles, 0, at, (end) => split(pathEl, end))
    }

    function walkRoles(roles, i, at, tail) {
      if (i >= roles.length) return tail(at)
      const entry = roles[i]
      const purpose = attr(entry, 'Purpose')
      if (purpose === 'PostOuterJoin') fail('it uses an outer join')
      if (purpose !== 'PostInnerJoin' && purpose !== 'StartRole') fail(`a ${purpose} step does not follow a join`)
      let j = i + 1
      while (j < roles.length && attr(roles[j], 'Purpose') === 'SameFactType') j++
      const group = roles.slice(i, j)
      const items = []
      const members = group.map(r => {
        const m = ctx.roleRef(attr(r, 'ref'))
        if (!m) fail('it uses a role FreeFBM does not have')
        return m
      })
      const em = members[0]
      if (em.kind === 'booleanRole') fail('it enters an old-style unary through its boolean value')
      add(attr(entry, 'id'), ctx.playerOf(em))
      union(at, attr(entry, 'id'))
      let end = attr(entry, 'id')
      if (em.kind === 'subtype') {
        // a subtype link: every role of it stands for the same object
        const st = ctx.stById.get(em.subtypeId)
        group.forEach((r, k) => {
          const m = members[k]
          if (m.kind !== 'subtype' || m.subtypeId !== em.subtypeId) fail('a step leaves the fact type it is in')
          add(attr(r, 'id'), ctx.playerOf(m))
          union(attr(entry, 'id'), attr(r, 'id'))
        })
        items.push({ k: 'type', typeId: st.subId, node: attr(entry, 'id') })
        end = attr(group.at(-1), 'id')
      } else if (members.some(m => m.link)) {
        // a link fact type of an objectified fact type F, whose other role
        // NORMA names by the role of F it stands for: each visited role k of F
        // becomes the implied link F_il_k from the nesting instance d
        const F = baseFact(em)
        const nested = []          // nodes that stand for d
        const players = new Map()  // role index of F → node
        group.forEach((r, k) => {
          const m = members[k]
          if (m.kind !== 'role' || baseFact(m) !== F) fail('a step leaves the fact type it is in')
          const n = add(attr(r, 'id'), ctx.playerOf(m))
          if (m.link && m.roleIndex === 0) nested.push([n, linkIndex(m)])
          else {
            const ri = m.link ? linkIndex(m) : m.roleIndex
            if (players.has(ri)) fail('it visits a role twice in one step')
            players.set(ri, n)
          }
          end = n
        })
        const d = nested.length ? nested[0][0] : freshNode(F)
        nested.forEach(([n]) => union(d, n))
        for (const ri of new Set([...players.keys(), ...nested.map(([, ri]) => ri)])) {
          const y = players.get(ri) ?? freshNode(ctx.playerOf({ kind: 'role', factId: F, roleIndex: ri }))
          items.push({ k: 'fact', factId: `${F}_il_${ri}`, args: [d, y] })
        }
      } else {
        const factId = em.factId
        const fact = em.link ? null : ctx.factById.get(factId)
        const arity = em.link ? 2 : fact.roles.length
        const args = new Array(arity).fill(null)
        group.forEach((r, k) => {
          const m = members[k]
          if (m.kind === 'booleanRole' && m.factId === factId) {
            if (valueCondition(r)) fail('it tests the boolean value of an old-style unary')
            return
          }
          if (m.kind !== 'role' || m.factId !== factId) fail('a step leaves the fact type it is in')
          if (args[m.roleIndex] != null) fail('it visits a role twice in one step')
          args[m.roleIndex] = add(attr(r, 'id'), ctx.playerOf(m))
          end = attr(r, 'id')
        })
        for (let ri = 0; ri < arity; ri++) {
          if (args[ri] == null) args[ri] = freshNode(ctx.playerOf({ kind: 'role', factId, roleIndex: ri, link: em.link }))
        }
        items.push({ k: 'fact', factId, args })
      }
      for (const r of group) {
        const ranges = valueCondition(r)
        if (ranges) items.push({ k: 'value', node: attr(r, 'id'), ranges })
      }
      const rest = walkRoles(roles, j, end, tail)
      if (attr(entry, 'IsNegated') === 'true') return [{ k: 'not', item: { k: 'scope', items: [...items, ...rest] } }]
      return [...items, ...rest]
    }

    function split(pathEl, at) {
      const subs = kids(kid(pathEl, 'SubPaths'), 'SubPath')
      if (!subs.length) return []
      const op = attr(pathEl, 'SplitCombinationOperator') ?? 'And'
      const negated = attr(pathEl, 'SplitIsNegated') === 'true'
      const branches = subs.map(s => walkPath(s, at))
      let out
      if (op === 'And') out = negated ? [{ k: 'scope', items: branches.flat() }] : branches.flat()
      else out = [{ k: op === 'Or' ? 'or' : 'xor', items: branches.map(b => ({ k: 'scope', items: b })) }]
      return negated ? [{ k: 'not', item: op === 'And' ? out[0] : { k: 'scope', items: out } }] : out
    }

    // The IR of one role path, rooted at its root node.
    function rolePath(pathEl) {
      const root = kid(pathEl, 'RootObjectType')
      if (!root) fail('a path has no root object type')
      if (attr(root, 'IsNegated') === 'true') fail('its root object type is negated')
      const rootId = attr(root, 'id')
      add(rootId, ctx.typeOf(attr(root, 'ref')))
      const items = []
      const ranges = valueCondition(root)
      if (ranges) items.push({ k: 'value', node: rootId, ranges })
      items.push(...walkPath(pathEl, rootId))
      if (!items.length) fail('a path is empty')
      for (const u of kids(kid(pathEl, 'ObjectUnifiers'), 'ObjectUnifier')) {
        const refs = kids(u).map(e => attr(e, 'ref')).filter(r => parent.has(r))
        refs.slice(1).forEach(r => union(refs[0], r))
      }
      return { rootId, items }
    }

    // The most specific of a class's types (the first when they are not in
    // one line).
    const classType = (c) => {
      const ts = nodeTypes.get(c) ?? []
      return ts.find(t => ts.every(u => ctx.up(t).has(u))) ?? ts[0] ?? null
    }

    // Emits the rule tree. `fixed` maps a node to { id, typeId } for the free
    // variables; every other class is bound at the scope that holds all its
    // uses (top: returned in `top`, to be bound by the caller).
    function emit(items, fixed) {
      const fixedByClass = new Map()
      const eqs = []
      for (const [n, v] of fixed) {
        const c = find(n)
        if (fixedByClass.has(c)) eqs.push({ t: 'cmp', op: '=', left: fixedByClass.get(c).id, right: v.id })
        else fixedByClass.set(c, v)
      }
      // scopes: the top, each 'scope' item; uses of classes per scope
      const scopeOf = new Map()   // class → scope (lowest common)
      const scopes = []
      const mkScope = (parentScope) => {
        const s = { parent: parentScope, depth: parentScope ? parentScope.depth + 1 : 0, vars: [] }
        scopes.push(s)
        return s
      }
      const lca = (a, b) => {
        while (a.depth > b.depth) a = a.parent
        while (b.depth > a.depth) b = b.parent
        while (a !== b) { a = a.parent; b = b.parent }
        return a
      }
      const use = (n, s) => {
        const c = find(n)
        if (fixedByClass.has(c)) return
        scopeOf.set(c, scopeOf.has(c) ? lca(scopeOf.get(c), s) : s)
      }
      const top = mkScope(null)
      const itemScope = new Map()
      const collect = (list, s) => {
        for (const it of list) {
          if (it.k === 'fact') it.args.forEach(a => use(a, s))
          else if (it.k === 'type' || it.k === 'value') use(it.node, s)
          else if (it.k === 'not') collect([it.item], s)
          else if (it.k === 'or' || it.k === 'xor') collect(it.items, s)
          else if (it.k === 'scope') { const inner = mkScope(s); itemScope.set(it, inner); collect(it.items, inner) }
        }
      }
      collect(items, top)

      const varOf = new Map()   // class → { id, typeId }
      for (const [c, s] of scopeOf) {
        const v = { id: `v${++counter.n}`, typeId: classType(c) }
        varOf.set(c, v)
        s.vars.push(v)
      }
      for (const [c, v] of fixedByClass) varOf.set(c, v)
      const vid = (n) => varOf.get(find(n)).id

      const conj = (fs) => {
        const parts = fs.flatMap(f => (f.t === 'and' ? f.args : [f]))
        return parts.length === 0 ? { t: 'true' } : parts.length === 1 ? parts[0] : { t: 'and', args: parts }
      }
      const bind = (vars, body) => vars.reduceRight((b, v) => ({ t: 'exists', v, body: b }), body)
      const valueTest = (node, ranges) => {
        const x = { t: 'var', id: vid(node) }
        const c = (op, text) => ({ t: 'vcmp', op, left: x, right: { t: 'const', text } })
        const one = (r) => {
          if (r.type === 'single') return c('≈', r.value)
          const lo = r.lower != null && r.type !== 'upper' ? c(r.lowerOpen ? '>' : '≥', r.lower) : null
          const hi = r.upper != null && r.type !== 'lower' ? c(r.upperOpen ? '<' : '≤', r.upper) : null
          return conj([lo, hi].filter(Boolean))
        }
        return ranges.length === 1 ? one(ranges[0]) : { t: 'or', args: ranges.map(one) }
      }
      const out = (it) => {
        switch (it.k) {
          case 'fact': return { t: 'fact', factId: it.factId, args: it.args.map(vid) }
          case 'type': {
            const v = varOf.get(find(it.node))
            return v.typeId && ctx.up(v.typeId).has(it.typeId) ? null : { t: 'type', typeId: it.typeId, arg: v.id }
          }
          case 'value': return valueTest(it.node, it.ranges)
          case 'not': return { t: 'not', arg: out(it.item) }
          case 'or': return { t: 'or', args: it.items.map(out) }
          case 'xor': {
            const bs = it.items.map(out)
            if (bs.length === 2) return { t: 'not', arg: { t: 'iff', left: bs[0], right: bs[1] } }
            return { t: 'or', args: bs.map((b, i) => conj([b, ...bs.filter((_, j) => j !== i).map(o => ({ t: 'not', arg: o }))])) }
          }
          case 'scope': return bind(itemScope.get(it).vars, conj(it.items.map(out).filter(Boolean)))
        }
      }
      const body = conj([...items.map(out).filter(Boolean), ...eqs])
      return { body, top: top.vars }
    }

    const has = (n) => parent.has(n)
    return { rolePath, emit, find, has, classType }
  }

  const sourceNode = (el) => {
    const src = kids(el)[0]
    if (!src) fail('a projection has no source')
    if (src.localName !== 'PathRoot' && src.localName !== 'PathedRole') fail('it projects a calculated value or a constant')
    return attr(src, 'ref')
  }
  const pathsOf = (ownerEl) => kids(kid(ownerEl, 'PathComponents'), 'RolePath')
  const attempt = (fn) => {
    try { return fn() } catch (e) { if (e instanceof Untranslatable) return { error: e.message }; throw e }
  }
  const bindAll = (vars, body) => vars.reduceRight((b, v) => ({ t: 'exists', v, body: b }), body)

  // A fact type's derivation path → { body, extraVars, terms } or { error }.
  // Each role path with its projection is one case of the rule; several are
  // joined by ∨.
  function factRule(fact, dpEl) {
    return attempt(() => {
      if (kids(kid(dpEl, 'PathComponents')).some(e => e.localName !== 'RolePath')) fail('it uses calculated values')
      const projections = kids(kid(dpEl, 'DerivationProjections'), 'DerivationProjection')
      const paths = pathsOf(dpEl)
      if (!paths.length) fail('it has no path')
      const roleById = new Map(fact.roles.map(r => [r.id, r]))
      const counter = { n: 0 }
      const cases = paths.map(p => {
        const s = session(counter)
        const { items } = s.rolePath(p)
        const proj = projections.find(d => attr(d, 'ref') === attr(p, 'id')) ?? (paths.length === 1 ? projections[0] : null)
        const fixed = []
        for (const rp of kids(proj, 'RoleProjection')) {
          const role = roleById.get(attr(rp, 'ref'))
          if (!role) continue   // the boolean role of an old-style unary
          const n = sourceNode(kid(rp, 'DerivationSource'))
          if (!s.has(n)) fail('a projection refers to an object outside its path')
          fixed.push([n, { id: `role:${role.id}`, typeId: role.objectTypeId }])
        }
        const missing = fact.roles.filter(r => !fixed.some(([, v]) => v.id === `role:${r.id}`))
        if (missing.length) fail('a role of the fact type is not projected')
        return s.emit(items, fixed)
      })
      if (cases.length === 1) return { body: cases[0].body, extraVars: cases[0].top, terms: {} }
      return { body: { t: 'or', args: cases.map(c => bindAll(c.top, c.body)) }, extraVars: [], terms: {} }
    })
  }

  // A subtype's derivation path → rule tree (the subject is each path's root)
  // or { error }. Empty paths, which NORMA keeps for rules not written yet,
  // are left out and counted in `skipped`.
  function subtypeRule(ot, sdpEl, supertypeIds) {
    return attempt(() => {
      if (kids(kid(sdpEl, 'PathComponents')).some(e => e.localName !== 'RolePath')) fail('it uses calculated values')
      const paths = pathsOf(sdpEl)
      const subject = { id: SUBJECT, typeId: supertypeIds[0] ?? null }
      let skipped = 0
      const cases = []
      const counter = { n: 0 }
      for (const p of paths) {
        const r = attempt(() => {
          const s = session(counter)
          const { rootId, items } = s.rolePath(p)
          const c = s.emit(items, [[rootId, subject]])
          return bindAll(c.top, c.body)
        })
        if (r.error === 'a path is empty') { skipped++; continue }
        if (r.error) fail(r.error)
        cases.push(r)
      }
      if (!cases.length) fail('its paths are empty')
      return { rule: cases.length === 1 ? cases[0] : { t: 'or', args: cases }, skipped }
    })
  }

  // A constraint sequence's join path → { free, target, body } or { error }.
  // positionOf(constraintRoleId) gives the sequence position a projection
  // fills; with withTarget the path's root is the query's target.
  function joinQuery(jpEl, positionOf, freeTypes, withTarget) {
    return attempt(() => {
      const paths = pathsOf(jpEl)
      if (paths.length !== 1) fail(paths.length ? 'it has several paths' : 'it has no path')
      const s = session()
      const { rootId, items } = s.rolePath(paths[0])
      const proj = kid(kid(jpEl, 'JoinPathProjections'), 'JoinPathProjection')
      const free = freeTypes.map((typeId, i) => ({ id: `q${i}`, typeId }))
      const fixed = []
      for (const cp of kids(proj, 'ConstraintRoleProjection')) {
        const i = positionOf(attr(cp, 'ref'))
        if (i == null || i < 0) fail('a projection fills no position of the sequence')
        const n = sourceNode(kid(cp, 'ProjectedFrom'))
        if (!s.has(n)) fail('a projection refers to an object outside its path')
        fixed.push([n, free[i]])
      }
      if (new Set(fixed.map(([, v]) => v.id)).size !== free.length) fail('not every position of the sequence is projected')
      let target = null
      if (withTarget && !fixed.some(([n]) => s.find(n) === s.find(rootId))) {
        target = { id: 't', typeId: s.classType(s.find(rootId)) }
        fixed.push([rootId, target])
      }
      const c = s.emit(items, fixed)
      return { free, target, body: bindAll(c.top, c.body) }
    })
  }

  return { factRule, subtypeRule, joinQuery }
}

// ── Positive linear recursion → transitive closure ─────────────────────────
//
// NORMA lets a fully derived fact type F use itself, as in
//   F(x, n) ⇐ Base(x, n) ∨ ∃y (Step₁(x, y) ∧ F(y, n)) ∨ …
// where every recursive case enters F once, positively, with all arguments
// but one (the carried role k) passed on unchanged. Read as its least
// fixpoint that is
//   F(x, n) ⇐ ∃y ([TC*_{u,w} Step₁(u, w) ∨ …](x, y) ∧ Base(y, n))
// which no longer refers to F. closeLinearRecursion(fact, rule) gives that
// rule, or null when the rule is not of this form (or not recursive).
// factById gives the fact types of the rule's atoms.

// A copy of a rule tree with the variable ids of `map` renamed.
function renameVars(n, map) {
  if (typeof n === 'string') return map.has(n) ? map.get(n) : n
  if (Array.isArray(n)) return n.map(x => renameVars(x, map))
  if (!n || typeof n !== 'object') return n
  const out = {}
  for (const [k, x] of Object.entries(n)) {
    // Only variable references are renamed, never fact or type ids.
    if (k === 'args' && n.t === 'fact' || k === 'args' && n.t === 'tc' || k === 'arg' && n.t === 'type'
      || (k === 'left' || k === 'right') && n.t === 'cmp' || k === 'id' && n.t === 'var') out[k] = renameVars(x, map)
    else if (x && typeof x === 'object') out[k] = renameVars(x, map)
    else out[k] = x
  }
  return out
}

const mentionsFact = (n, factId) => {
  if (!n || typeof n !== 'object') return false
  if (Array.isArray(n)) return n.some(x => mentionsFact(x, factId))
  if (n.t === 'fact' && n.factId === factId) return true
  return Object.values(n).some(x => mentionsFact(x, factId))
}

const varNumbers = (n, out = []) => {
  if (typeof n === 'string') { const m = /^v(\d+)$/.exec(n); if (m) out.push(Number(m[1])) }
  else if (Array.isArray(n)) n.forEach(x => varNumbers(x, out))
  else if (n && typeof n === 'object') Object.values(n).forEach(x => varNumbers(x, out))
  return out
}

export function closeLinearRecursion(fact, rule, factById) {
  if (!rule?.body || !mentionsFact(rule.body, fact.id)) return null
  const roleVar = fact.roles.map(r => `role:${r.id}`)
  const whole = (rule.extraVars ?? []).reduceRight((b, v) => ({ t: 'exists', v, body: b }), rule.body)
  const cases = whole.t === 'or' ? whole.args : [whole]
  const bases = [], steps = []
  let carried = null
  for (const c of cases) {
    if (!mentionsFact(c, fact.id)) { bases.push(c); continue }
    // ∃v₁ … ∃vₙ (A₁ ∧ … ∧ F(…) ∧ … ∧ Aₘ)
    const locals = []
    let m = c
    while (m.t === 'exists') { locals.push(m.v); m = m.body }
    const conj = m.t === 'and' ? m.args : [m]
    const self = conj.filter(a => a.t === 'fact' && a.factId === fact.id)
    const rest = conj.filter(a => !self.includes(a))
    if (self.length !== 1 || rest.some(a => mentionsFact(a, fact.id))) return null
    const args = self[0].args
    const k = args.findIndex((a, i) => a !== roleVar[i])
    if (k < 0 || args.some((a, i) => i !== k && a !== roleVar[i])) return null
    if (carried != null && carried !== k) return null
    carried = k
    const next = locals.find(v => v.id === args[k])
    if (!next || !rest.length) return null
    steps.push({ next, locals: locals.filter(v => v !== next), rest })
  }
  if (!bases.length || !steps.length) return null

  let n = Math.max(0, ...varNumbers(rule))
  const fresh = () => `v${++n}`
  const typeId = fact.roles[carried].objectTypeId
  const u = { id: fresh(), typeId }, w = { id: fresh(), typeId }, y = { id: fresh(), typeId }
  const x = roleVar[carried]
  const and = (args) => (args.length === 1 ? args[0] : { t: 'and', args })
  const or = (args) => (args.length === 1 ? args[0] : { t: 'or', args })
  const step = or(steps.map(s => {
    const map = new Map([[x, u.id], [s.next.id, w.id]])
    // A step that reaches a subtype of the carried role's player says so,
    // unless a role it fills already does.
    const fills = s.rest.some(a => a.t === 'fact' && a.args.some((id, i) =>
      id === s.next.id && factById.get(a.factId)?.roles[i]?.objectTypeId === s.next.typeId))
    const typed = s.next.typeId && s.next.typeId !== typeId && !fills ? [{ t: 'type', typeId: s.next.typeId, arg: w.id }] : []
    const body = and([...s.rest.map(a => renameVars(a, map)), ...typed])
    return s.locals.reduceRight((b, v) => ({ t: 'exists', v, body: b }), body)
  }))
  const closure = { t: 'tc', star: true, vars: [u, w], body: step, args: [x, y.id] }
  const base = renameVars(or(bases), new Map([[x, y.id]]))
  return { body: { t: 'exists', v: y, body: and([closure, base]) }, extraVars: [], terms: rule.terms ?? {} }
}
