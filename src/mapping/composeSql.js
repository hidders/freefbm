// Composed SQL for an exchange (data exchange plan, step 5): the whole chain
// as one script over the first schema's tables, INSERT INTO t … SELECT … for
// each table of the last schema, so the supplier's database fills the
// consumer's tables without the rows passing through FreeFBM.
//
// The rows of a table of the last schema are what the last step's rules give
// it: a two-way mapping run into it builds, for each match of a rule's other
// side, the rows its side names (keyed by their primary key, columns from
// the frontier values); a view gives its rows and columns by derivation
// rules. Each such rule is a query over the schema the step starts from, and
// that query is unfolded back through the steps before it, to a query over
// the first schema:
//
//   - a view (GAV) replaces each atom of its target by the rule that defines
//     it (a fact type's rule with its role variables the atom's arguments, a
//     type's rule with its reference values the instance; an entity type
//     without a rule of its own has the instances the fact rules make, one
//     case per such role);
//   - a two-way mapping replaces each atom of the schema it ends in by the
//     other side of the rule that maps it on its own (fold.js atomicRules),
//     its frontier values the atom's arguments;
//   - an identifying fact equates an instance with its value: values meet
//     across schemas by ≈ as in views, an entity with a reference mode being
//     the value it is identified by, a row being its primary key.
//
// Disjunctions are taken out as unions. The query over the first schema is
// written as SQL by formulaSql.js (the query of ∀ō ¬φ is SELECT ō WHERE φ).
//
// composeExchangeSql(state, ex) → { sql, tables: [{ name, rules }], notes } |
//   { error }. Parts that can't be written yet (composite identifiers
// compared across schemas, optional parts, aggregates, keys a run would
// invent) leave their table or column out with a note.

import { stepMapping, stepEnds, checkExchange } from './exchanges.js'
import { expandSide, asSide, sideContext } from './mapping.js'
import { atomicRules, schemeParts, keyLeaves } from './fold.js'
import { upgradeRule, referenceParts, SUBJECT } from '../logic/derivationRule.js'
import { headId } from './views.js'
import { relationalModel } from '../relational/relationalModel.js'
import { formulaToSql } from '../relational/formulaSql.js'
import { tableViews } from '../relational/viewSql.js'
import { typeSql } from '../relational/ddlExport.js'
import { fkOrder } from '../relational/populationSql.js'
import { quoteIdent as q } from '../relational/sqlNames.js'

class ComposeError extends Error {}
const fail = (m) => { throw new ComposeError(m) }

// A query: { vars: Map(id → typeId), atoms } with atoms in the rule-tree
// format (fact, type, vcmp, dpred; terms var/const/op/if), plus
// { t: 'not', q } and { t: 'or', qs }. Variable ids are unique in a
// composition, so queries can be merged by putting their maps together.
const newQ = () => ({ vars: new Map(), atoms: [] })
const MAX_UNION = 64

// ── Rule trees into queries ─────────────────────────────────────────────────

function termOf(t, ren) {
  switch (t?.t) {
    case 'var': return { t: 'var', id: ren(t.id) }
    case 'const': return { t: 'const', text: t.text }
    case 'op': return { t: 'op', op: t.op, args: t.args.map(a => termOf(a, ren)) }
    case 'if': return { t: 'if', cond: condOf(t.cond, ren), then: termOf(t.then, ren), else: termOf(t.else, ren) }
    case 'agg': return fail('a rule uses an aggregate')
    case 'hole': case undefined: case null: return fail('a rule is not finished')
  }
  return fail(`a rule uses a ${t.t} term`)
}
// A condition of an if-term (no quantifiers).
function condOf(n, ren) {
  switch (n?.t) {
    case 'true': return n
    case 'and': case 'or': return { t: n.t, args: n.args.map(a => condOf(a, ren)) }
    case 'not': return { t: 'not', arg: condOf(n.arg, ren) }
    case 'vcmp': return { t: 'vcmp', op: n.op, left: termOf(n.left, ren), right: termOf(n.right, ren) }
    case 'dpred': return { t: 'dpred', op: n.op, args: n.args.map(a => termOf(a, ren)) }
  }
  return fail('a rule has a condition in a term that is not written yet')
}

// Adds a rule tree's conjunction to query qq. ren: rule var id → query var id
// (a Map, extended by quantifiers); fresh() gives new ids.
function addTree(qq, node, ren, fresh) {
  const rv = (id) => (ren.has(id) ? ren.get(id) : fail('a rule uses a variable outside its quantifier'))
  switch (node?.t) {
    case 'true': return
    case 'and': node.args.forEach(a => addTree(qq, a, ren, fresh)); return
    case 'exists': {
      const id = fresh()
      qq.vars.set(id, node.v.typeId)
      addTree(qq, node.body, new Map(ren).set(node.v.id, id), fresh)
      return
    }
    case 'not': {
      const inner = newQ()
      addTree(inner, node.arg, ren, fresh)
      qq.atoms.push({ t: 'not', q: inner })
      return
    }
    case 'or': {
      qq.atoms.push({ t: 'or', qs: node.args.map(a => { const inner = newQ(); addTree(inner, a, ren, fresh); return inner }) })
      return
    }
    case 'fact': qq.atoms.push({ t: 'fact', factId: node.factId, args: node.args.map(rv) }); return
    case 'type': qq.atoms.push({ t: 'type', typeId: node.typeId, arg: rv(node.arg) }); return
    case 'cmp': qq.atoms.push({ t: 'vcmp', op: node.op === '≠' ? '≉' : '≈', left: { t: 'var', id: rv(node.left) }, right: { t: 'var', id: rv(node.right) } }); return
    case 'vcmp': qq.atoms.push({ t: 'vcmp', op: node.op, left: termOf(node.left, rv), right: termOf(node.right, rv) }); return
    case 'dpred': qq.atoms.push({ t: 'dpred', op: node.op, args: node.args.map(a => termOf(a, rv)) }); return
    case 'hole': case undefined: case null: return fail('a rule is not finished')
  }
  return fail(`a rule uses ${node.t === 'tc' ? 'a transitive closure' : node.t === 'count' ? 'a counting quantifier' : `${node.t}`}, which is not written as SQL in a chain yet`)
}

// A mapping side (expanded) as a query: vars renamed fresh, frontier binds
// returned as y → [var ids].
function sideQuery(ex, fresh) {
  const qq = newQ()
  const ren = new Map()
  for (const v of ex.vars) { const id = fresh(); ren.set(v.id, id); qq.vars.set(id, v.typeId) }
  const rv = (id) => ren.get(id) ?? fail('a mapping rule has an atom with a missing variable')
  const front = new Map()
  const add = (target, atoms) => {
    for (const a of atoms) {
      switch (a.t) {
        case 'fact': target.atoms.push({ t: 'fact', factId: a.factId, args: a.args.map(rv) }); break
        case 'type': target.atoms.push({ t: 'type', typeId: a.typeId, arg: rv(a.arg) }); break
        case 'bind': {
          if (target !== qq) fail('a mapping rule reads a frontier value inside a negation')
          if (!front.has(a.y)) front.set(a.y, [])
          front.get(a.y).push(rv(a.v))
          break
        }
        case 'const': target.atoms.push({ t: 'vcmp', op: '≈', left: { t: 'var', id: rv(a.v) }, right: { t: 'const', text: String(a.text ?? '').trim().replace(/^'(.*)'$/s, '$1') } }); break
        case 'not': {
          const inner = newQ()
          for (const v of a.vars ?? []) { const id = fresh(); ren.set(v.id, id); inner.vars.set(id, v.typeId) }
          add(inner, a.atoms)
          target.atoms.push({ t: 'not', q: inner })
          break
        }
        case 'opt': fail('a mapping rule has an optional part ($y?), which is not written as SQL in a chain yet'); break
        default: fail(`a mapping rule has a ${a.t} atom`)
      }
    }
  }
  add(qq, ex.atoms)
  // A frontier value read twice is the same value.
  for (const vs of front.values()) for (const v of vs.slice(1)) qq.atoms.push({ t: 'vcmp', op: '≈', left: { t: 'var', id: vs[0] }, right: { t: 'var', id: v } })
  return { q: qq, front: new Map([...front].map(([y, vs]) => [y, vs[0]])) }
}

const merge = (into, from) => { for (const [k, v] of from.vars) into.vars.set(k, v); into.atoms.push(...from.atoms) }
const eqv = (a, b) => ({ t: 'vcmp', op: '≈', left: { t: 'var', id: a }, right: { t: 'var', id: b } })

// ── One step, backwards ─────────────────────────────────────────────────────

// What a step needs to rewrite queries over the schema it ends in into
// queries over the schema it starts from.
function stepContext(state, step) {
  const sm = stepMapping(state, step)
  const ends = stepEnds(state, step)
  const ctxTo = sideContext(state, ends.to)
  const els = { objectTypes: ctxTo.objectTypes, facts: ctxTo.facts, subtypes: ctxTo.subtypes, constraints: ctxTo.constraints }
  const cx = { state, sm, ends, ctxTo, ctxFrom: sideContext(state, ends.from), els, isView: sm.isView }
  // An identifying fact: { e (entity role), v (value role) } or null.
  const idents = new Map()
  cx.identifying = (factId) => {
    if (idents.has(factId)) return idents.get(factId)
    const f = ctxTo.factById.get(factId)
    let out = null
    for (let e = 0; f && f.roles.length === 2 && e < 2 && !out; e++) {
      const player = f.roles[e].objectTypeId
      const p = schemeParts(player, ctxTo, els)?.find(x => x.factId === f.id && x.entityRoleIndex === e)
      if (!p) continue
      if ((keyLeaves(player, ctxTo, els)?.length ?? 0) !== 1) out = { composite: ctxTo.otById.get(player)?.name ?? 'an entity type' }
      else out = { e, v: p.roleIndex }
    }
    idents.set(factId, out)
    return out
  }
  if (sm.isView) {
    cx.factRules = new Map(), cx.typeRules = new Map()
    for (const r of sm.m.rules ?? []) {
      const id = headId(r)
      const m = r.head.factId ? cx.factRules : cx.typeRules
      if (id && !m.has(id)) m.set(id, r)
    }
    // An entity type without a rule has the instances that computed roles of
    // fact rules make (as contract.js's view:produce).
    cx.producers = new Map()
    for (const [fid, r] of cx.factRules) {
      const f = ctxTo.factById.get(fid)
      f?.roles.forEach((role, i) => {
        if (!r.rule?.terms?.[role.id]) return
        if (!cx.producers.has(role.objectTypeId)) cx.producers.set(role.objectTypeId, [])
        cx.producers.get(role.objectTypeId).push({ fact: f, i })
      })
    }
  } else {
    const back = step.direction === 'backward'
    cx.toSide = back ? 'source' : 'target'
    cx.fromSide = back ? 'target' : 'source'
    cx.atomics = atomicRules(sm.m, cx.toSide, ctxTo, els)
  }
  return cx
}

const subOf = (cx, sub, sup) => sub === sup || cx.ctxTo.subtypes.some(st => st.subId === sub && subOf(cx, st.superId, sup))

// One atom of the schema the step ends in, rewritten: { q } (a conjunction
// to put in its place), { alts: [q] } (a union) or { none: true } (false).
function rewriteAtom(cx, a, fresh) {
  const { ctxTo } = cx
  if (a.t === 'fact') {
    const f = ctxTo.factById.get(a.factId) ?? fail('a fact type that is not in its schema')
    if (f._link) fail('an objectified fact type identified through its links is not written as SQL in a chain yet')
    const id = cx.identifying(f.id)
    if (id?.composite) fail(`${id.composite} has a composite identifier; comparing such instances across schemas is not written yet`)
    if (id) return { q: { vars: new Map(), atoms: [eqv(a.args[id.e], a.args[id.v])] } }
    if (cx.isView) {
      const r = cx.factRules.get(f.id)
      if (!r) return { none: true }
      const rule = r.rule ?? {}
      const qq = newQ()
      const ren = new Map(f.roles.map((role, i) => [`role:${role.id}`, a.args[i]]))
      for (const v of rule.extraVars ?? []) { const nid = fresh(); ren.set(v.id, nid); qq.vars.set(nid, v.typeId) }
      addTree(qq, upgradeRule(rule.body), ren, fresh)
      f.roles.forEach((role, i) => {
        const t = rule.terms?.[role.id]
        if (t) qq.atoms.push({ t: 'vcmp', op: '≈', left: { t: 'var', id: a.args[i] }, right: termOf(t, (x) => (ren.has(x) ? ren.get(x) : fail('a rule uses a variable outside its quantifier'))) })
        // A selected role ranges over its player's instances.
        else if (ctxTo.otById.get(role.objectTypeId)?.kind === 'entity') qq.atoms.push({ t: 'type', typeId: role.objectTypeId, arg: a.args[i] })
      })
      return { q: qq }
    }
    const entries = cx.atomics.facts.get(f.id) ?? []
    if (!entries.length) return { none: true }
    const alts = entries.map(({ rule, atomic }) => {
      const { q: qq, front } = sideQuery(expandSide(asSide(rule[cx.fromSide]), cx.ctxFrom), fresh)
      atomic.roles.forEach((leaves, i) => {
        if (leaves.length !== 1) fail('a mapping rule maps an entity with a composite identifier; that is not written as SQL in a chain yet')
        const leaf = leaves[0]
        if (leaf.y != null) qq.atoms.push(eqv(a.args[i], front.get(leaf.y) ?? fail('a mapping rule gives a value its other side does not read')))
        else qq.atoms.push({ t: 'vcmp', op: '≈', left: { t: 'var', id: a.args[i] }, right: { t: 'const', text: leaf.c } })
      })
      return qq
    })
    return alts.length === 1 ? { q: alts[0] } : { alts }
  }
  if (a.t === 'type') {
    const t = ctxTo.otById.get(a.typeId)
    if (!t) fail('a type that is not in its schema')
    if (cx.isView) {
      if (t.kind === 'value') return { q: newQ() }
      const r = cx.typeRules.get(t.id)
      if (r) {
        const qq = newQ()
        const supers = ctxTo.subtypes.some(st => st.subId === t.id)
        let ren
        if (supers) ren = new Map([[SUBJECT, a.arg]])
        else {
          const parts = referenceParts(t.id, cx.state) ?? fail(`${t.name} has no reference scheme`)
          if (parts.length !== 1) fail(`${t.name} has a composite identifier; comparing such instances across schemas is not written yet`)
          ren = new Map([[parts[0].id, a.arg]])
        }
        addTree(qq, upgradeRule(r.rule), ren, fresh)
        return { q: qq }
      }
      const ps = [...cx.producers.entries()].filter(([typeId]) => subOf(cx, typeId, t.id)).flatMap(([, list]) => list)
      if (!ps.length) return { none: true }
      const alts = ps.map(({ fact, i }) => {
        const qq = newQ()
        const args = fact.roles.map((role, k) => {
          if (k === i) return a.arg
          const nid = fresh()
          qq.vars.set(nid, role.objectTypeId)
          return nid
        })
        qq.atoms.push({ t: 'fact', factId: fact.id, args })
        return qq
      })
      return alts.length === 1 ? { q: alts[0] } : { alts }
    }
    const entries = cx.atomics.types.get(t.id) ?? []
    if (!entries.length) {
      if (t.kind === 'value') return { q: newQ() }
      return { none: true }
    }
    const alts = entries.map(({ rule, atomic }) => {
      const { q: qq, front } = sideQuery(expandSide(asSide(rule[cx.fromSide]), cx.ctxFrom), fresh)
      if (atomic.key.length !== 1) fail(`${t.name} has a composite identifier; comparing such instances across schemas is not written yet`)
      const leaf = atomic.key[0]
      if (leaf.y != null) qq.atoms.push(eqv(a.arg, front.get(leaf.y) ?? fail('a mapping rule gives a value its other side does not read')))
      else qq.atoms.push({ t: 'vcmp', op: '≈', left: { t: 'var', id: a.arg }, right: { t: 'const', text: leaf.c } })
      return qq
    })
    return alts.length === 1 ? { q: alts[0] } : { alts }
  }
  return fail(`a ${a.t} atom`)
}

// Whether an atom is about the schema the step ends in.
const ofTo = (cx, a) => (a.t === 'fact' && cx.ctxTo.factById.has(a.factId)) || (a.t === 'type' && cx.ctxTo.otById.has(a.typeId))

// A query over the schema the step ends in (and maybe others) as a union of
// queries without its atoms: [q] ([] when it is always false).
function rewrite(cx, q0, fresh, depth = 0) {
  if (depth > 12) fail('the rules of a view use each other in a cycle')
  // An entity variable that plays no role of the schema says that it is an
  // instance there: a type atom.
  const plays = new Set(q0.atoms.filter(a => a.t === 'fact' && ofTo(cx, a) && !cx.identifying(a.factId)).flatMap(a => a.args))
  const typed = new Set(q0.atoms.filter(a => a.t === 'type').map(a => a.arg))
  const existence = [...q0.vars].filter(([id, typeId]) => cx.ctxTo.otById.get(typeId)?.kind === 'entity' && !plays.has(id) && !typed.has(id))
    .map(([id, typeId]) => ({ t: 'type', typeId, arg: id }))
  let branches = [{ vars: new Map(q0.vars), atoms: [] }]
  const todo = [...q0.atoms, ...existence]
  let steps = 0
  while (todo.length) {
    if (++steps > 5000) fail('the query grows too large')
    const a = todo.shift()
    if (a.t === 'not') {
      const inner = rewrite(cx, a.q, fresh, depth + 1)
      for (const b of branches) for (const iq of inner) b.atoms.push({ t: 'not', q: iq })
      continue
    }
    let alts = null
    if (a.t === 'or') alts = a.qs
    else if (ofTo(cx, a)) {
      const r = rewriteAtom(cx, a, fresh)
      if (r.none) return []
      if (r.q) {
        for (const [k, v] of r.q.vars) for (const b of branches) b.vars.set(k, v)
        todo.unshift(...r.q.atoms)
        continue
      }
      alts = r.alts
    }
    if (alts) {
      const done = alts.flatMap(alt => rewrite(cx, alt, fresh, depth + 1))
      if (!done.length) return []
      const next = []
      for (const b of branches) for (const d of done) { const c = { vars: new Map(b.vars), atoms: [...b.atoms] }; merge(c, d); next.push(c) }
      if (next.length > MAX_UNION) fail('the query has too many cases')
      branches = next
      continue
    }
    for (const b of branches) b.atoms.push(a)
  }
  return branches
}

// ── The first schema's query as SQL ─────────────────────────────────────────

// A query over a relational schema with output terms → SELECT text, or
// throws. Columns are named by `names`.
// Renames variables in an atom or term (sub: id → id).
function substAtom(a, sub) {
  const v = (id) => sub.get(id) ?? id
  const term = (t) => (t.t === 'var' ? { t: 'var', id: v(t.id) } : t.t === 'op' ? { ...t, args: t.args.map(term) }
    : t.t === 'if' ? { ...t, cond: cond(t.cond), then: term(t.then), else: term(t.else) } : t)
  const cond = (n) => (n.t === 'and' || n.t === 'or' ? { ...n, args: n.args.map(cond) } : n.t === 'not' ? { ...n, arg: cond(n.arg) }
    : n.t === 'vcmp' ? { ...n, left: term(n.left), right: term(n.right) } : n.t === 'dpred' ? { ...n, args: n.args.map(term) } : n)
  switch (a.t) {
    case 'fact': return { ...a, args: a.args.map(v) }
    case 'type': return { ...a, arg: v(a.arg) }
    case 'vcmp': case 'dpred': return cond(a)
    case 'not': return { t: 'not', q: substQ(a.q, sub) }
    case 'or': return { t: 'or', qs: a.qs.map(x => substQ(x, sub)) }
  }
  return a
}
const substQ = (qq, sub) => ({ vars: new Map([...qq.vars].filter(([k]) => !sub.has(k))), atoms: qq.atoms.map(a => substAtom(a, sub)) })

// The query with variables that ≈ makes equal taken together (those of the
// query's own scope go to the outer or first one), and rows of one table
// with the same primary key value taken together. Returns the substitution
// made (id → id), the query changed in place.
function simplifyQ(qq, outer, tables, outerKeys = new Map(), outerAtoms = new Set()) {
  let keys = outerKeys
  const all = new Map()
  for (let round = 0; round < 20; round++) {
    const parent = new Map()
    const find = (x) => { while (parent.has(x)) x = parent.get(x); return x }
    const own = (x) => qq.vars.has(x)
    const isRow = (x) => tables.has(qq.vars.get(x) ?? outer.get(x))
    const union = (a, b) => {
      a = find(a); b = find(b)
      if (a === b) return
      if (own(a) && !own(b)) parent.set(a, b)
      else if (own(b)) parent.set(b, a)
    }
    for (const a of qq.atoms) {
      if (a.t === 'vcmp' && a.op === '≈' && a.left.t === 'var' && a.right.t === 'var' && !isRow(a.left.id) && !isRow(a.right.id)) union(a.left.id, a.right.id)
    }
    // Rows of one table with the same key value.
    const keyOf = new Map(outerKeys)
    for (const a of qq.atoms) {
      if (a.t !== 'fact') continue
      for (const t of tables.values()) {
        const pk = t.pk?.length === 1 ? t.pk[0] : null
        if (!pk || pk.fact.id !== a.factId) continue
        const r = a.args[pk.t], k = find(a.args[pk.v])
        const key = `${t.id}|${k}`
        if (keyOf.has(key)) union(keyOf.get(key), r)
        else keyOf.set(key, r)
      }
    }
    const sub = new Map()
    for (const x of new Set([...parent.keys()])) sub.set(x, find(x))
    keys = keyOf
    if (!sub.size) break
    const next = substQ(qq, sub)
    qq.vars = next.vars
    qq.atoms = next.atoms
    for (const [k, v] of all) all.set(k, sub.get(v) ?? v)
    for (const [k, v] of sub) all.set(k, v)
  }
  // Atoms that say nothing, and atoms said twice (here or outside).
  const seen = new Set(outerAtoms)
  qq.atoms = qq.atoms.filter(a => {
    if (a.t === 'vcmp' && a.op === '≈' && a.left.t === 'var' && a.right.t === 'var' && a.left.id === a.right.id) return false
    if (a.t === 'not' || a.t === 'or') return true
    const k = JSON.stringify(a)
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
  const inner = new Map([...outer, ...qq.vars])
  for (const a of qq.atoms) {
    if (a.t === 'not') simplifyQ(a.q, inner, tables, keys, seen)
    if (a.t === 'or') a.qs.forEach(x => simplifyQ(x, inner, tables, keys, seen))
  }
  return all
}

function querySql(q0, outputs0, names, model, fresh, qualify) {
  const tables = new Map(model.tables.map(t => [t.id, t]))
  const renamed = simplifyQ(q0, new Map(), tables)
  const outputs = outputs0.map(t => substAtom({ t: 'vcmp', op: '≈', left: t, right: t }, renamed).left)
  // A row used as a value is its primary key.
  const pkVar = new Map()
  const prepare = (qq) => {
    for (const [id, typeId] of qq.vars) {
      const t = tables.get(typeId)
      if (!t) continue
      const k = fresh()
      pkVar.set(id, { k, t, q: qq })
    }
    for (const a of qq.atoms) {
      if (a.t === 'not') prepare(a.q)
      if (a.t === 'or') a.qs.forEach(prepare)
    }
  }
  prepare(q0)
  const used = new Set()
  const asValue = (id) => {
    const p = pkVar.get(id)
    if (!p) return id
    if (!used.has(id)) {
      if (p.t.pk?.length !== 1) fail(`table ${p.t.name} has ${p.t.pk ? 'a composite' : 'no'} primary key, so its rows can't be compared with values`)
      used.add(id)
      const col = p.t.pk[0]
      p.q.vars.set(p.k, col.vt.id)
      const args = []
      args[col.t] = id
      args[col.v] = p.k
      p.q.atoms.push({ t: 'fact', factId: col.fact.id, args })
    }
    return p.k
  }
  // Query vars as formula.js variables.
  const V = new Map()
  const varOf = (id, typeId) => { if (!V.has(id)) V.set(id, { typeId }); return V.get(id) }
  const typeOf = new Map()
  const note = (qq) => { for (const [k, v] of qq.vars) typeOf.set(k, v); for (const a of qq.atoms) { if (a.t === 'not') note(a.q); if (a.t === 'or') a.qs.forEach(note) } }
  note(q0)
  const vref = (id) => varOf(asValue(id), typeOf.get(asValue(id)) ?? fail('a value of the query is not bound'))
  const term = (t) => {
    switch (t.t) {
      case 'var': return vref(t.id)
      case 'const': return { t: 'const', text: t.text, quoted: true }
      case 'op': return { t: 'fn', op: t.op, args: t.args.map(term) }
      case 'if': return { t: 'ite', cond: cond(t.cond), then: term(t.then), else: term(t.else) }
    }
    return fail('a term')
  }
  const cond = (n) => {
    switch (n.t) {
      case 'true': return n
      case 'and': case 'or': return { t: n.t, args: n.args.map(cond) }
      case 'not': return { t: 'not', arg: cond(n.arg) }
      case 'vcmp': return { t: 'vcmp', op: n.op, left: term(n.left), right: term(n.right) }
      case 'dpred': return { t: 'dpred', op: n.op, args: n.args.map(term) }
    }
    return fail('a condition')
  }
  const atomF = (a) => {
    switch (a.t) {
      case 'fact': {
        const col = model.columnByFact.get(a.factId) ?? fail('the first schema has a fact type that is not a column')
        return { t: 'fact', factId: a.factId, args: a.args.map((x, i) => (i === col.t ? varOf(x, typeOf.get(x)) : vref(x))) }
      }
      case 'type': return tables.has(a.typeId) && pkVar.has(a.arg) ? { t: 'type', typeId: a.typeId, arg: varOf(a.arg, a.typeId) } : null
      case 'vcmp': case 'dpred': return cond(a)
      case 'not': return { t: 'not', arg: body(a.q) }
      case 'or': return { t: 'or', args: a.qs.map(body) }
    }
    return fail(`a ${a.t} atom`)
  }
  const body = (qq) => {
    const atoms = qq.atoms.map(atomF).filter(Boolean)
    const conj = atoms.length === 0 ? { t: 'true' } : atoms.length === 1 ? atoms[0] : { t: 'and', args: atoms }
    const vars = [...qq.vars.keys()].map(id => varOf(id, qq.vars.get(id)))
    return vars.length ? { t: 'exists', vars, body: conj } : conj
  }
  // One variable per output column, equal to its term.
  const outs = outputs.map((t, i) => {
    const id = fresh()
    const typeId = t.t === 'var' ? typeOf.get(asValue(t.id)) : null
    q0.vars.set(id, typeId)
    typeOf.set(id, typeId)
    q0.atoms.push({ t: 'vcmp', op: '≈', left: { t: 'var', id }, right: t })
    return { id, name: names[i] }
  })
  const outIds = new Set(outs.map(o => o.id))
  const outVars = outs.map(o => varOf(o.id, typeOf.get(o.id)))
  const inner = { vars: new Map([...q0.vars].filter(([k]) => !outIds.has(k))), atoms: q0.atoms }
  const formula = { t: 'forall', vars: outVars, body: { t: 'not', arg: body(inner) } }
  const nameOf = new Map(outs.map((o, i) => [outVars[i], o.name]))
  const r = formulaToSql(formula, model, (v) => nameOf.get(v) ?? 'value', { qualify })
  if (r.error) fail(r.error)
  if (!r.query) fail('the query could not be written')
  return r.query
}

// ── What the last step gives each table ─────────────────────────────────────

// [{ tableId, key: [term], cols: Map(factId → term), q, label }] over the
// schema the last step starts from (views: may still name its target).
function contributions(state, step, lastModel, fresh, notes) {
  const sm = stepMapping(state, step)
  const ends = stepEnds(state, step)
  const ctxTo = sideContext(state, ends.to)
  const tables = new Map(lastModel.tables.map(t => [t.id, t]))
  const out = []
  if (!sm.isView) {
    const back = step.direction === 'backward'
    const toSide = back ? 'source' : 'target', fromSide = back ? 'target' : 'source'
    const ctxFrom = sideContext(state, ends.from)
    for (const rule of sm.m.rules) {
      try {
        const to = expandSide(asSide(rule[toSide]), ctxTo)
        const { q: qq, front } = sideQuery(expandSide(asSide(rule[fromSide]), ctxFrom), fresh)
        const valueOf = (v) => {
          const b = to.atoms.find(a => a.t === 'bind' && a.v === v)
          if (b) return { t: 'var', id: front.get(b.y) ?? fail(`it gives ${b.y} a value its other side does not read (a run invents it)`) }
          const c = to.atoms.find(a => a.t === 'const' && a.v === v)
          if (c) return { t: 'const', text: String(c.text ?? '').trim().replace(/^'(.*)'$/s, '$1') }
          return null
        }
        if (to.atoms.some(a => a.t === 'opt' || a.t === 'not')) fail('its side in the last schema has an optional part or a negation')
        for (const v of to.vars) {
          const t = tables.get(v.typeId)
          if (!t) continue
          const cols = new Map()
          for (const a of to.atoms) {
            if (a.t !== 'fact') continue
            const col = lastModel.columnByFact.get(a.factId)
            if (!col || a.args[col.t] !== v.id) continue
            const val = valueOf(a.args[col.v])
            if (!val) fail(`it does not say what goes in ${t.name}.${col.name}`)
            cols.set(col.fact.id, val)
          }
          if (!t.pk?.length) fail(`${t.name} has no primary key`)
          const key = t.pk.map(c => cols.get(c.fact.id) ?? fail(`it does not give the primary key of ${t.name} (a run invents it)`))
          for (const c of t.pk) cols.delete(c.fact.id)
          // Each table row of the side gets the whole match.
          out.push({ tableId: t.id, key, cols, q: clone(qq), label: rule.name || 'a rule' })
        }
      } catch (e) {
        if (!(e instanceof ComposeError)) throw e
        notes.push(`The rule ${rule.name || '(unnamed)'} of ${sm.m.name} is left out: ${e.message}.`)
      }
    }
    return out
  }
  for (const r of sm.m.rules ?? []) {
    try {
      if (r.head.typeId) {
        const t = tables.get(r.head.typeId)
        if (!t) continue
        const parts = referenceParts(t.id, state) ?? fail(`${t.name} has no primary key`)
        const qq = newQ()
        const ren = new Map(parts.map(p => { const id = fresh(); qq.vars.set(id, p.typeId); return [p.id, id] }))
        addTree(qq, upgradeRule(r.rule), ren, fresh)
        // The key columns in the table's key order.
        const byFact = new Map(parts.map(p => [p.factId, { t: 'var', id: ren.get(p.id) }]))
        out.push({ tableId: t.id, key: t.pk.map(c => byFact.get(c.fact.id) ?? fail(`the rows of ${t.name} are not given by its key`)), cols: new Map(), q: qq, label: r.name || t.name })
        continue
      }
      const col = lastModel.columnByFact.get(r.head.factId)
      if (!col) continue
      const t = col.table
      if (t.pk?.length !== 1) fail(`${t.name} has a composite primary key; its columns are not written yet`)
      const f = col.fact, rule = r.rule ?? {}
      const qq = newQ()
      const ren = new Map(f.roles.map((role, i) => { const id = fresh(); qq.vars.set(id, role.objectTypeId); return [`role:${role.id}`, id] }))
      for (const v of rule.extraVars ?? []) { const id = fresh(); ren.set(v.id, id); qq.vars.set(id, v.typeId) }
      addTree(qq, upgradeRule(rule.body), ren, fresh)
      const rv = (x) => (ren.has(x) ? ren.get(x) : fail('a rule uses a variable outside its quantifier'))
      const roleTerm = (i) => {
        const role = f.roles[i]
        const term = rule.terms?.[role.id]
        if (term) return termOf(term, rv)
        if (i === col.t) qq.atoms.push({ t: 'type', typeId: t.id, arg: ren.get(`role:${role.id}`) })
        return { t: 'var', id: ren.get(`role:${role.id}`) }
      }
      out.push({ tableId: t.id, key: [roleTerm(col.t)], cols: new Map([[f.id, roleTerm(col.v)]]), q: qq, label: r.name || `${t.name}.${col.name}` })
    } catch (e) {
      if (!(e instanceof ComposeError)) throw e
      notes.push(`A rule of ${sm.m.name} is left out: ${e.message}.`)
    }
  }
  return out
}

const clone = (qq) => ({ vars: new Map(qq.vars), atoms: qq.atoms.map(a => (a.t === 'not' ? { t: 'not', q: clone(a.q) } : a.t === 'or' ? { t: 'or', qs: a.qs.map(clone) } : a)) })

// ── The script ──────────────────────────────────────────────────────────────

// The SELECTs of a union without those another one contains: the same
// SELECT and FROM lines, and a WHERE that asks for more (formulaToSql
// numbers aliases per query, so the same tables read the same way look the
// same).
function pruneUnion(selects) {
  const parse = (sql) => {
    const [head, where = ''] = sql.split(/\nWHERE /)
    return { head, conds: new Set(where ? where.split(/\n {2}AND /) : []) }
  }
  const ps = selects.map(parse)
  return selects.filter((_, i) => !ps.some((a, j) => j !== i && a.head === ps[i].head && a.conds.size < ps[i].conds.size && [...a.conds].every(c => ps[i].conds.has(c))))
}

const indent = (s, n = 2) => s.split('\n').map(l => ' '.repeat(n) + l).join('\n')

export function composeExchangeSql(state, ex, { header = null, sourceSchema = '', targetSchema = '' } = {}) {
  try {
    const problems = checkExchange(state, ex).filter(p => !/passes a schema twice/.test(p.message))
    if (problems.length) fail(problems[0].message)
    const steps = ex.steps
    const first = stepEnds(state, steps[0]).from, last = stepEnds(state, steps[steps.length - 1]).to
    const schemaOf = (id) => state.schemas?.find(s => s.id === id)
    if (schemaOf(first)?.profile !== 'relational') fail(`the chain starts at ${schemaOf(first)?.name ?? 'a deleted schema'}, which is not a relational schema`)
    if (schemaOf(last)?.profile !== 'relational') fail(`the chain ends at ${schemaOf(last)?.name ?? 'a deleted schema'}, which is not a relational schema`)
    let n = 0
    const fresh = () => `q${++n}`
    const notes = []
    const firstModel = relationalModel(state, first)
    const lastModel = relationalModel(state, last)
    const lastStep = steps.length - 1
    const cxs = steps.map(s => stepContext(state, s))
    const contribs = contributions(state, steps[lastStep], lastModel, fresh, notes)

    // Each contribution, unfolded to the first schema: [q].
    const unfold = (c) => {
      let qs = [c.q]
      for (let i = lastStep; i >= 0; i--) {
        if (i === lastStep && !cxs[i].isView) continue
        qs = qs.flatMap(qq => rewrite(cxs[i], qq, fresh))
        if (qs.length > MAX_UNION) fail('the query has too many cases')
      }
      return qs
    }
    // SELECT texts of a contribution for some outputs.
    const inSchema = (schema, name) => (schema ? `${q(schema)}.${q(name)}` : q(name))
    const qualify = (table) => inSchema(sourceSchema, table.name)
    const selects = (c, qs, outputs, names) => qs.map(qq => querySql(clone(qq), outputs, names, firstModel, fresh, qualify))

    const views = tableViews(state, lastModel, typeSql)
    const { order, cyclic } = fkOrder(lastModel.tables)
    const lines = []
    if (header) lines.push(...header.split('\n').map(l => `-- ${l}`), '')
    // One transaction, so assertions exported as deferred constraint triggers
    // (ddlExport.js) are checked once, on all the rows.
    lines.push('BEGIN;')
    if (cyclic) lines.push('-- Foreign keys form a cycle: run with deferred constraints.', 'SET CONSTRAINTS ALL DEFERRED;')
    lines.push('')
    const written = []
    const empty = []
    for (const t of order) {
      const view = views.get(t.id)
      const mine = contribs.filter(c => c.tableId === t.id)
      if (view?.kind === 'view') { if (mine.length) notes.push(`${t.name} is a view in the last schema, so nothing is inserted into it.`); continue }
      if (!mine.length) continue
      const skip = view?.kind === 'base' ? view.derivedCols : new Set()
      const name = view?.kind === 'base' ? view.baseName : t.name
      const full = inSchema(targetSchema, name)
      const keyNames = t.pk.map((c, i) => `k${i + 1}`)
      // The keys: every contribution's rows.
      const keySelects = []
      const colSelects = new Map()   // factId → [select]
      const unfolded = []
      for (const c of mine) {
        let qs
        try { qs = unfold(c) } catch (e) {
          if (!(e instanceof ComposeError)) throw e
          notes.push(`${c.label} (rows of ${t.name}) is left out: ${e.message}.`)
          continue
        }
        if (!qs.length) continue
        unfolded.push({ c, qs })
      }
      for (const { c, qs } of unfolded) {
        try { keySelects.push(...selects(c, qs, c.key, keyNames)) } catch (e) {
          if (!(e instanceof ComposeError)) throw e
          notes.push(`${c.label} (rows of ${t.name}) is left out: ${e.message}.`)
          continue
        }
        for (const [fid, term] of c.cols) {
          if (skip.has(fid)) continue
          try {
            const s = selects(c, qs, [...c.key, term], [...keyNames, 'v'])
            if (!colSelects.has(fid)) colSelects.set(fid, [])
            colSelects.get(fid).push(...s)
          } catch (e) {
            if (!(e instanceof ComposeError)) throw e
            notes.push(`${t.name}.${lastModel.columnByFact.get(fid)?.name} from ${c.label} is left out: ${e.message}.`)
          }
        }
      }
      if (!keySelects.length) {
        if (!unfolded.length && !notes.some(n => n.includes(`rows of ${t.name})`))) empty.push(name)
        continue
      }
      const cols = t.columns.filter(c => colSelects.has(c.fact.id))
      const target = [...t.pk, ...cols]
      const union = (ss) => pruneUnion([...new Set(ss)]).join('\nUNION\n')
      const ctes = [`k AS (\n${indent(union(keySelects))}\n)`]
      cols.forEach((c, i) => ctes.push(`c${i + 1} AS (\n${indent(union(colSelects.get(c.fact.id)))}\n)`))
      const on = (alias) => keyNames.map(k => `${alias}.${k} = k.${k}`).join(' AND ')
      lines.push(`-- ${name}: ${mine.length} rule${mine.length === 1 ? '' : 's'}`)
      lines.push(`INSERT INTO ${full} (${target.map(c => q(c.name)).join(', ')})`)
      lines.push(`WITH ${ctes.join(',\n')}`)
      lines.push(`SELECT ${[...keyNames.map(k => `k.${k}`), ...cols.map((c, i) => `c${i + 1}.v`)].join(', ')}`)
      lines.push(`FROM k${cols.map((c, i) => `\n  LEFT JOIN c${i + 1} ON ${on(`c${i + 1}`)}`).join('')};`, '')
      written.push({ name, rules: mine.length, columns: target.length })
      for (const c of t.columns) if (c.generated && colSelects.has(c.fact.id) || (c.generated && t.pk.includes(c))) lines.push(`SELECT setval(pg_get_serial_sequence('${full.replace(/'/g, "''")}', '${c.name.replace(/'/g, "''")}'), COALESCE(MAX(${q(c.name)}), 0) + 1, false) FROM ${full};`, '')
    }
    lines.push('COMMIT;', '')
    if (empty.length) notes.push(`Nothing earlier in the chain gives rows of ${empty.length === 1 ? '' : 'these tables: '}${empty.join(', ')}${empty.length === 1 ? ', so it is left out' : ''}.`)
    if (!written.length) notes.push('No table of the last schema gets rows.')
    return { sql: lines.join('\n'), tables: written, notes }
  } catch (e) {
    if (e instanceof ComposeError) return { error: e.message }
    throw e
  }
}
