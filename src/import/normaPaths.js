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
// Object unifiers (and CorrelatedWith, their older form) say that several
// pathed roles stand for one object, and a pathed role (or the root) can
// carry a value condition. Only a join is negated: NORMA's verbaliser reads
// IsNegated on the entry role of a fact type, so it is ignored elsewhere.
//
// The translation gives each object (pathed roles joined or unified are one
// object) a variable, each fact type entry a fact atom over all its roles
// (roles the path does not visit get variables of their own), each subtype
// link a type atom and each value condition a comparison of the object's data
// value. A variable is bound by ∃ at the innermost negation or branch that
// holds all its uses; the projected objects are the rule's free variables.
//
// Calculated values apply a function of the model to path nodes, constants
// and other calculated values. NORMA has no function library: each model
// defines its functions by name and an optional operator symbol, so a
// function is read by its symbol or name (=, <, +, abs, …; FUNCTIONS below).
// A boolean one listed under a lead path's Conditions is a condition of the
// path, placed where all the objects it reads are bound (NORMA's verbaliser
// adds a condition as soon as its variables are known); a projected one is
// the term of a computed role.
//
// Old-style unaries: NORMA used to store a unary F as a binary whose second
// role is played by an implicit boolean value type restricted to true, and
// the importer keeps only the unary. A path through such a binary is a path
// through the unary: the boolean role is left out of the fact atom, a path
// may start at the boolean value and enter F through it, and a value
// condition on the boolean value (on the role or the root) is read as
// follows: true (or true and false) gives F(x), false alone gives ¬F(x). The
// literal reading of false would match nothing, as no tuple holds false;
// the modeller meant the negation, and NORMA mapped these unaries to a
// boolean column with false for not F. Such readings are collected for the
// import log (takeNegations). The boolean value is not an object of the
// path: joining it to another role, unifying or projecting it is refused,
// and a calculated value reading it reads the constant true.
//
// Not translated (reported as the reason): outer joins, negated roots,
// functions FreeFBM cannot read, aggregates, subqueries and shared paths.

import { SUBJECT } from '../logic/derivationRule.js'
import { OPS, PREDS } from '../logic/dataOperators.js'

const kids = (el, name) => el ? [...el.children].filter(c => !name || c.localName === name) : []
const kid  = (el, name) => kids(el, name)[0] ?? null
const attr = (el, name) => el?.getAttribute(name) ?? null
const textOf = (el) => (el?.textContent ?? '').trim()

// A link fact type F_il_k: F and k.
const baseFact = (m) => (m.link ? m.factId.split('_il_')[0] : m.factId)
const linkIndex = (m) => Number(m.factId.split('_il_')[1])

class Untranslatable extends Error {}
const fail = (why) => { throw new Untranslatable(why) }

// NORMA functions by operator symbol or name (lower case, without spaces,
// hyphens and underscores): comparisons, connectives, data operators and data
// predicates of src/logic/dataOperators.js.
const FUNCTIONS = (() => {
  const m = new Map()
  const put = (kind, op, ...keys) => keys.forEach(k => m.set(k, { kind, op }))
  put('cmp', '≈', '=', '==', 'eq', 'equal', 'equals', 'isequalto', 'equalto')
  put('cmp', '≉', '<>', '!=', '≠', 'ne', 'neq', 'notequal', 'notequals', 'isnotequalto', 'notequalto')
  put('cmp', '<', '<', 'lt', 'lessthan', 'islessthan')
  put('cmp', '≤', '<=', '≤', '=<', 'le', 'lte', 'lessthanorequal', 'lessthanorequalto', 'islessthanorequalto', 'atmost')
  put('cmp', '>', '>', 'gt', 'greaterthan', 'isgreaterthan')
  put('cmp', '≥', '>=', '≥', '=>', 'ge', 'gte', 'greaterthanorequal', 'greaterthanorequalto', 'isgreaterthanorequalto', 'atleast')
  put('and', null, 'and', '∧', '&&', '&')
  put('or', null, 'or', '∨', '||', '|')
  put('not', null, 'not', '¬', '!')
  put('op', 'add', '+', 'add', 'plus')
  put('op', 'sub', '-', '−', 'subtract', 'minus', 'sub')
  put('op', 'mul', '*', '×', '·', 'multiply', 'times', 'mul')
  put('op', 'div', '/', '÷', 'divide', 'div')
  put('op', 'mod', '%', 'mod', 'modulo', 'remainder')
  put('op', 'concat', 'concat', 'concatenate')
  for (const op of Object.keys(OPS)) if (!m.has(op.toLowerCase())) put('op', op, op.toLowerCase())
  for (const op of Object.keys(PREDS)) if (!m.has(op.toLowerCase())) put('pred', op, op.toLowerCase())
  return m
})()
const fnKey = (s) => String(s ?? '').trim().toLowerCase().replace(/[\s_-]+/g, '')
// A boolean value as NORMA may write it, or undefined.
const boolOf = (text) => {
  const t = String(text ?? '').trim().toLowerCase()
  if (['true', '1', 'yes', 't', 'y'].includes(t)) return true
  if (['false', '0', 'no', 'f', 'n'].includes(t)) return false
  return undefined
}

const fnLookup = (f) => FUNCTIONS.get(String(f.symbol ?? '').trim()) ?? FUNCTIONS.get(fnKey(f.name)) ?? FUNCTIONS.get(String(f.name ?? '').trim())

// All descendants of el called name.
const descendants = (el, name, out = []) => {
  for (const c of el ? [...el.children] : []) { if (c.localName === name) out.push(c); descendants(c, name, out) }
  return out
}

// ctx: {
//   roleRef(normaRoleId)  → { kind: 'role', factId, roleIndex, link? } | { kind: 'subtype', subtypeId, side }
//                           | { kind: 'booleanRole', factId } | undefined
//   playerOf(member)      → the object type (or nested fact type) id that plays it
//   factById, stById, typeOf(normaTypeId) → FreeFBM type id
//   up(typeId)            → the set of the type and all its supertypes
//   rangesOf(valueConstraintEl) → FreeFBM range specs
//   functionOf(normaFunctionId) → { name, symbol, isBoolean, params: [{ id, bag }] } | undefined
//   isBooleanType(normaTypeId) → whether it is the implicit boolean value type of an old-style unary
// }
export function makePathTranslator(ctx) {
  // One path: nodes are NORMA ids of path roots and pathed roles, and fresh
  // ids for roles a path does not visit. The paths of one rule share
  // `counter`, so their variables get distinct ids.
  function session(counter = { n: 0 }, calcs = new Map()) {
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

    // Nodes that stand for the boolean value of an old-style unary, and value
    // conditions on such a value at a path root (applied where the path
    // enters its unary).
    const boolNodes = new Set()
    const boolRootConds = new Map()   // root node → ranges
    const isBool = (n) => { const c = find(n); for (const b of boolNodes) if (find(b) === c) return true; return false }
    // The value a condition on a boolean allows: true, false, or null for both.
    const boolWanted = (ranges) => {
      const vals = ranges.map(r => {
        const v = r.type === 'single' ? boolOf(r.value) : undefined
        if (v === undefined) fail('it tests the boolean value of an old-style unary with a value FreeFBM cannot read')
        return v
      })
      const t = vals.includes(true), f = vals.includes(false)
      return t && !f ? true : f && !t ? false : null
    }
    // A path root: its node and the items of its value condition.
    const rootItems = (root) => {
      const id = attr(root, 'id')
      const ranges = valueCondition(root)
      if (ctx.isBooleanType?.(attr(root, 'ref'))) {
        add(id, null)
        boolNodes.add(id)
        if (ranges) boolRootConds.set(id, ranges)
        return []
      }
      add(id, ctx.typeOf(attr(root, 'ref')))
      return ranges ? [{ k: 'value', node: id, ranges }] : []
    }

    const valueCondition = (el) => {
      const vr = kid(el, 'ValueRestriction')
      const vc = vr && kids(vr)[0]
      const ranges = vc ? ctx.rangesOf(vc) : []
      return ranges.length ? ranges : null
    }

    // A path's own roles, then its split, from context node `at`. Returns a
    // list of IR items; negation and branches are { k: 'scope', item }.
    // A subpath with a root object type of its own starts again from that
    // root, a new object (joined to the rest only through unifiers).
    function walkPath(pathEl, at) {
      const roles = kids(kid(pathEl, 'PathedRoles'), 'PathedRole')
      const root = pathEl.localName === 'SubPath' ? kid(pathEl, 'RootObjectType') : null
      if (root) {
        if (attr(root, 'IsNegated') === 'true') fail('its root object type is negated')
        if (!attr(root, 'id')) fail('a subpath root has no id')
        const head = rootItems(root)
        at = attr(root, 'id')
        return [...head, ...walkRoles(roles, 0, at, (end) => split(pathEl, end))]
      }
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
      // The value a condition on the unary's boolean asks for (see the top).
      let wanted = null
      const want = (ranges) => {
        const v = boolWanted(ranges)
        if (v === null) return
        if (wanted !== null && wanted !== v) fail('it tests the boolean value of an old-style unary for both true and false')
        wanted = v
      }
      if (em.kind === 'booleanRole') {
        // entering the unary from its boolean value
        if (at == null || !isBool(at)) fail('it joins an object to the boolean value of an old-style unary')
        for (const [n, ranges] of boolRootConds) if (find(n) === find(at)) want(ranges)
        add(attr(entry, 'id'), null)
        boolNodes.add(attr(entry, 'id'))
      } else {
        if (at != null && isBool(at)) fail('it joins the boolean value of an old-style unary to another role')
        add(attr(entry, 'id'), ctx.playerOf(em))
      }
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
            add(attr(r, 'id'), null)
            boolNodes.add(attr(r, 'id'))
            const ranges = valueCondition(r)
            if (ranges) want(ranges)
            end = attr(r, 'id')
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
        const atom = { k: 'fact', factId, args }
        if (wanted === false) { items.push({ k: 'not', item: { k: 'scope', items: [atom] } }); noted?.push(factId) }
        else items.push(atom)
      }
      for (const r of group) {
        if (boolNodes.has(attr(r, 'id'))) continue
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
      const items = rootItems(root)
      items.push(...walkPath(pathEl, rootId))
      if (!items.length) fail('a path is empty')
      for (const u of kids(kid(pathEl, 'ObjectUnifiers'), 'ObjectUnifier')) {
        const refs = kids(u).map(e => attr(e, 'ref')).filter(r => parent.has(r))
        if (refs.some(isBool)) fail('it unifies the boolean value of an old-style unary')
        refs.slice(1).forEach(r => union(refs[0], r))
      }
      // CorrelatedWith, the older form of an object unifier
      for (const pr of descendants(pathEl, 'PathedRole')) {
        const other = attr(kid(pr, 'CorrelatedWith'), 'ref')
        if (other && parent.has(other) && parent.has(attr(pr, 'id'))) {
          if (isBool(other) || isBool(attr(pr, 'id'))) fail('it unifies the boolean value of an old-style unary')
          union(attr(pr, 'id'), other)
        }
      }
      // conditions: boolean calculated values the path must satisfy
      const conds = kids(kid(pathEl, 'Conditions'), 'CalculatedCondition').map(c => {
        const e = calcExpr(attr(c, 'ref'))
        if (!e.bool) fail('a condition of its path is not a boolean function')
        return e
      })
      return { rootId, items, conds }
    }

    // A calculated value (by id) as an expression over path nodes:
    //   { f: 'node', n } | { f: 'const', text } | { f: 'op', op, args }
    //   | { f: 'cmp', op, left, right } | { f: 'pred', op, args }
    //   | { f: 'and' | 'or', args } | { f: 'not', arg }
    // with bool set on the boolean ones.
    function calcExpr(id, seen = new Set()) {
      const el = calcs.get(id)
      if (!el) fail('it refers to a calculated value that is not there')
      if (seen.has(id)) fail('a calculated value uses itself')
      seen = new Set([...seen, id])
      const fn = ctx.functionOf?.(attr(kid(el, 'Function'), 'ref'))
      if (!fn) fail('a calculated value has no function')
      const label = fn.symbol || fn.name
      if (fn.params.some(p => p.bag)) fail(`it uses the aggregate function ${label}`)
      const inputs = kids(kid(el, 'Inputs'), 'Input')
      const pos = (inp, i) => { const k = fn.params.findIndex(p => p.id === attr(kid(inp, 'Parameter'), 'ref')); return k < 0 ? i : k }
      const args = inputs.map((inp, i) => [pos(inp, i), inp]).sort((a, b) => a[0] - b[0]).map(([, inp]) => {
        const src = kids(kid(inp, 'Source'))[0]
        if (!src) fail(`an input of ${label} has no source`)
        if (src.localName === 'Constant') return { f: 'const', text: textOf(kid(src, 'Value')) }
        if (src.localName === 'CalculatedValue') return calcExpr(attr(src, 'ref'), seen)
        const n = attr(src, 'ref')
        if (!parent.has(n)) fail(`an input of ${label} is outside its path`)
        if (isBool(n)) return { f: 'const', text: 'true' }   // an old-style unary's boolean
        return { f: 'node', n }
      })
      const def = fnLookup(fn)
      if (!def) fail(`it uses the function ${label}, which FreeFBM cannot read`)
      const value = (a) => { if (a.bool) fail(`${label} is given a condition where it needs a value`); return a }
      const cond = (a) => { if (!a.bool) fail(`${label} is given a value where it needs a condition`); return a }
      switch (def.kind) {
        case 'cmp':
          if (args.length !== 2) fail(`${label} does not have two inputs`)
          return { f: 'cmp', op: def.op, left: value(args[0]), right: value(args[1]), bool: true }
        case 'and': case 'or':
          if (args.length < 2) fail(`${label} has fewer than two inputs`)
          return { f: def.kind, args: args.map(cond), bool: true }
        case 'not':
          if (args.length !== 1) fail(`${label} does not have one input`)
          return { f: 'not', arg: cond(args[0]), bool: true }
        case 'pred':
          return { f: 'pred', op: def.op, args: args.map(value), bool: true }
        default: {
          const op = def.op === 'sub' && args.length === 1 ? 'neg' : def.op
          return { f: 'op', op, args: args.map(value) }
        }
      }
    }

    // The most specific of a class's types (the first when they are not in
    // one line).
    const classType = (c) => {
      const ts = nodeTypes.get(c) ?? []
      return ts.find(t => ts.every(u => ctx.up(t).has(u))) ?? ts[0] ?? null
    }

    // Emits the rule tree. `fixed` maps a node to { id, typeId } for the free
    // variables; every other class is bound at the scope that holds all its
    // uses (top: returned in `top`, to be bound by the caller). Conditions go
    // to the innermost scope that binds one of their objects (all of them
    // must be bound on its way up); the objects of `terms` (expressions the
    // caller writes with the returned `term`) are bound at the top.
    function emit(items, fixed, { conds = [], terms = [] } = {}) {
      const fixedByClass = new Map()
      const eqs = []
      for (const [n, v] of fixed) {
        if (isBool(n)) fail('it projects the boolean value of an old-style unary')
        const c = find(n)
        if (fixedByClass.has(c)) eqs.push({ t: 'cmp', op: '=', left: fixedByClass.get(c).id, right: v.id })
        else fixedByClass.set(c, v)
      }
      // scopes: the top, each 'scope' item; uses of classes per scope
      const scopeOf = new Map()   // class → scope (lowest common)
      const scopes = []
      const mkScope = (parentScope) => {
        const s = { parent: parentScope, depth: parentScope ? parentScope.depth + 1 : 0, vars: [], extra: [] }
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
      const exprNodes = (e, out = []) => {
        if (e.f === 'node') out.push(e.n)
        for (const a of [...(e.args ?? []), e.left, e.right, e.arg].filter(Boolean)) exprNodes(a, out)
        return out
      }
      for (const e of terms) exprNodes(e).forEach(n => use(n, top))
      for (const e of conds) {
        const classes = exprNodes(e).map(find).filter(c => !fixedByClass.has(c))
        for (const c of classes) if (!scopeOf.has(c)) scopeOf.set(c, top)
        const at = classes.map(c => scopeOf.get(c)).reduce((a, b) => (b.depth > a.depth ? b : a), top)
        const above = (s, t) => { while (t && t !== s) t = t.parent; return t === s }
        if (classes.some(c => !above(scopeOf.get(c), at))) fail('a condition reads objects of separate branches of its path')
        at.extra.push(e)
      }

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
      const term = (e) => {
        switch (e.f) {
          case 'node': return { t: 'var', id: vid(e.n) }
          case 'const': return { t: 'const', text: e.text }
          case 'op': return { t: 'op', op: e.op, args: e.args.map(term) }
          default: fail('a condition is used as a value')
        }
      }
      const condOut = (e) => {
        switch (e.f) {
          case 'cmp': return { t: 'vcmp', op: e.op, left: term(e.left), right: term(e.right) }
          case 'pred': return { t: 'dpred', op: e.op, args: e.args.map(term) }
          case 'and': return conj(e.args.map(condOut))
          case 'or': return { t: 'or', args: e.args.map(condOut) }
          case 'not': return { t: 'not', arg: condOut(e.arg) }
          default: fail('a value is used as a condition')
        }
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
          case 'scope': {
            const sc = itemScope.get(it)
            return bind(sc.vars, conj([...it.items.map(out).filter(Boolean), ...sc.extra.map(condOut)]))
          }
        }
      }
      const body = conj([...items.map(out).filter(Boolean), ...top.extra.map(condOut), ...eqs])
      return { body, top: top.vars, term }
    }

    const has = (n) => parent.has(n)
    return { rolePath, emit, find, has, classType, calcExpr }
  }

  const sourceNode = (el) => {
    const src = kids(el)[0]
    if (!src) fail('a projection has no source')
    if (src.localName !== 'PathRoot' && src.localName !== 'PathedRole') fail('it projects a calculated value or a constant')
    return attr(src, 'ref')
  }
  // The lead paths of a path owner (PathComponent is the older container),
  // after the checks for what the translation does not read.
  const pathsOf = (ownerEl) => {
    if (kids(kid(ownerEl, 'PathComponents')).some(e => e.localName === 'SharedRolePath')) fail('it shares a role path with another rule')
    if (kids(kid(ownerEl, 'Subqueries')).length) fail('it uses a subquery')
    return [...kids(kid(ownerEl, 'PathComponents'), 'RolePath'), ...kids(kid(ownerEl, 'PathComponent'), 'RolePath')]
  }
  // The calculated values of an owner by id: those of its lead paths and the
  // older ones kept on the owner itself.
  const calcsOf = (ownerEl, paths) => new Map(
    [kid(ownerEl, 'CalculatedValues'), ...paths.map(p => kid(p, 'CalculatedValues'))]
      .flatMap(c => kids(c, 'CalculatedValue')).map(c => [attr(c, 'id'), c]))
  // The unaries whose boolean a translated path tests for false (read as
  // their negation): collected per attempt, kept only when it succeeds.
  let noted = null
  let negations = []
  const attempt = (fn) => {
    const outer = noted
    noted = []
    try {
      const r = fn()
      if (!r?.error) (outer ?? negations).push(...noted)
      return r
    } catch (e) { if (e instanceof Untranslatable) return { error: e.message }; throw e } finally { noted = outer }
  }
  // The fact ids of the unaries read as negations since the last call.
  const takeNegations = () => { const out = negations; negations = []; return out }
  const bindAll = (vars, body) => vars.reduceRight((b, v) => ({ t: 'exists', v, body: b }), body)

  // A fact type's derivation path → { body, extraVars, terms } or { error }.
  // Each role path with its projection is one case of the rule; several are
  // joined by ∨.
  // A role projected from a calculated value or a constant is a computed
  // role whose term is that value (one path only: terms are not per case).
  function factRule(fact, dpEl) {
    return attempt(() => {
      const projections = kids(kid(dpEl, 'DerivationProjections'), 'DerivationProjection')
      const paths = pathsOf(dpEl)
      if (!paths.length) fail('it has no path')
      const calcs = calcsOf(dpEl, paths)
      const roleById = new Map(fact.roles.map(r => [r.id, r]))
      const counter = { n: 0 }
      let computed = {}
      const cases = paths.map(p => {
        const s = session(counter, calcs)
        const { items, conds } = s.rolePath(p)
        const proj = projections.find(d => attr(d, 'ref') === attr(p, 'id')) ?? (paths.length === 1 ? projections[0] : null)
        const fixed = [], terms = []
        for (const rp of kids(proj, 'RoleProjection')) {
          const role = roleById.get(attr(rp, 'ref'))
          if (!role) continue   // the boolean role of an old-style unary
          const src = kids(kid(rp, 'DerivationSource'))[0]
          if (src?.localName === 'CalculatedValue' || src?.localName === 'Constant') {
            if (paths.length > 1) fail('several paths compute a role')
            const e = src.localName === 'Constant' ? { f: 'const', text: textOf(kid(src, 'Value')) } : s.calcExpr(attr(src, 'ref'))
            if (e.bool) fail('a role is computed by a condition')
            terms.push([role, e])
            continue
          }
          const n = sourceNode(kid(rp, 'DerivationSource'))
          if (!s.has(n)) fail('a projection refers to an object outside its path')
          fixed.push([n, { id: `role:${role.id}`, typeId: role.objectTypeId }])
        }
        const done = (r) => fixed.some(([, v]) => v.id === `role:${r.id}`) || terms.some(([t]) => t === r)
        if (fact.roles.some(r => !done(r))) fail('a role of the fact type is not projected')
        const c = s.emit(items, fixed, { conds, terms: terms.map(([, e]) => e) })
        computed = Object.fromEntries(terms.map(([r, e]) => [r.id, c.term(e)]))
        return c
      })
      if (cases.length === 1) return { body: cases[0].body, extraVars: cases[0].top, terms: computed }
      return { body: { t: 'or', args: cases.map(c => bindAll(c.top, c.body)) }, extraVars: [], terms: {} }
    })
  }

  // A subtype's derivation path → rule tree (the subject is each path's root)
  // or { error }. Empty paths, which NORMA keeps for rules not written yet,
  // are left out and counted in `skipped`.
  function subtypeRule(ot, sdpEl, supertypeIds) {
    return attempt(() => {
      const paths = pathsOf(sdpEl)
      const calcs = calcsOf(sdpEl, paths)
      const subject = { id: SUBJECT, typeId: supertypeIds[0] ?? null }
      let skipped = 0
      const cases = []
      const counter = { n: 0 }
      for (const p of paths) {
        const r = attempt(() => {
          const s = session(counter, calcs)
          const { rootId, items, conds } = s.rolePath(p)
          const c = s.emit(items, [[rootId, subject]], { conds })
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
      const s = session({ n: 0 }, calcsOf(jpEl, paths))
      const { rootId, items, conds } = s.rolePath(paths[0])
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
      const c = s.emit(items, fixed, { conds })
      return { free, target, body: bindAll(c.top, c.body) }
    })
  }

  return { factRule, subtypeRule, joinQuery, takeNegations }
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
