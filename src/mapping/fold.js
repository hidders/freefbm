// Fold (workbench step 12; workbench doc, Hard parts 8 "derive, then fold").
//
// A schema on one side of a mapping is refined by adding derived types and
// fact types whose rules stay in the mapping fragment: ∃, ∧, fact and type
// atoms, and value constants. Fold composes those rules with the mapping:
//   1. unfold: each atom of a derived element's rule is replaced by the other
//      side of the mapping rule that maps that atom alone (an "atomic" rule:
//      one fact type, or one entity type, between reference values), its
//      frontier variables joined through the reference values of the rule's
//      variables. The result, with the derived element's own pattern on its
//      side, is a new mapping rule;
//   2. promote: the derived elements become ordinary ones, keeping the
//      population their rules gave;
//   3. remove the originals they replace: a fact type the rules used goes only
//      if it can be recovered from the rest. Because the rules are
//      correspondences, that is checked by running the mapping without the
//      original's rules there and back on a generic population of the other
//      side (the frozen other side of those rules, closed under that side's
//      constraints, accounting.js): everything must come back.
//
// planFold(state, mapping) works out what Fold would do (no changes); the
// store's foldMapping applies a plan as one undo step.
//
//   plan: {
//     side: 'source' | 'target',             where the derived elements are
//     items: [{ id, kind: 'type'|'fact', name, rule | null, error | null, issues }],
//     candidates: [{ factId, name, usedBy: [id], recoverable, reason }],
//     mapping,                               the mapping with the new rules
//   }

import { asSide, expandSide, sideContext, sideSchemaId, SIDES, checkRule, readingName, treeToSide } from './mapping.js'
import { schemeOf, prepareRun, executeRun } from './runMapping.js'
import { worldOf, genericPopulation, accountingSteps, relationalLabel } from './accounting.js'
import { upgradeRule, directSupertypes, referenceParts, SUBJECT } from '../logic/derivationRule.js'
import { factRuleParts, isDerivedFact } from '../logic/factDerivation.js'
import { makePopulationEvaluator } from '../logic/derivedPopulation.js'
import { projCellKey } from '../utils/populationValidation.js'
import { uid, mkConstraint } from '../store/storeHelpers.js'
import { valueKindName } from '../utils/datatypeValues.js'

const other = (side) => (side === 'source' ? 'target' : 'source')
const keyOf = (cell) => JSON.stringify(projCellKey(cell))
class FoldError extends Error {}

const elsOf = (ctx) => ({ objectTypes: ctx.objectTypes, facts: ctx.facts, subtypes: ctx.subtypes, constraints: ctx.constraints })

// The value types at the leaves of a type's reference scheme, in order: the
// type itself for a value type. Null when it has none we can follow.
export function keyLeaves(typeId, ctx, els, depth = 0) {
  // (An objectified fact type is identified through its implied links.)
  const t = ctx.otById.get(typeId) ?? (ctx.factById.get(typeId)?.objectified ? ctx.factById.get(typeId) : null)
  if (!t || depth > 6) return null
  if (t.kind === 'value') return [typeId]
  const sch = schemeOf(typeId, els)
  if (sch?.kind === 'refMode') return [sch.rm.vtId]
  if (sch?.kind !== 'composite') return null
  const out = []
  for (const p of sch.parts) {
    const player = ctx.factById.get(p.factId)?.roles[p.roleIndex]?.objectTypeId
    const sub = keyLeaves(player, ctx, els, depth + 1)
    if (!sub) return null
    out.push(...sub)
  }
  return out
}

// The parts of a scheme with the range of leaves each covers.
export function schemeParts(typeId, ctx, els) {
  const sch = schemeOf(typeId, els)
  if (sch?.kind === 'refMode') return [{ factId: sch.rm.factId, entityRoleIndex: 1 - sch.rm.vtRoleIndex, roleIndex: sch.rm.vtRoleIndex, player: sch.rm.vtId, from: 0, n: 1 }]
  if (sch?.kind !== 'composite') return null
  let from = 0
  return sch.parts.map(p => {
    const player = ctx.factById.get(p.factId)?.roles[p.roleIndex]?.objectTypeId
    const n = keyLeaves(player, ctx, els)?.length ?? 1
    const out = { ...p, player, from, n }
    from += n
    return out
  })
}

// All supertypes of a type.
function supertypesOf(typeId, els) {
  const out = new Set(), todo = [typeId]
  while (todo.length) {
    const t = todo.pop()
    for (const st of els.subtypes ?? []) if (st.subId === t && !out.has(st.superId)) { out.add(st.superId); todo.push(st.superId) }
  }
  return out
}

// ── Atomic rules ─────────────────────────────────────────────────────────────

// What one side of a rule maps on its own, from its expanded flat form:
//   { kind: 'entity', typeId, key: [leaf] }
//   { kind: 'fact', factId, roles: [[leaf]] }
// with leaf { y } (a frontier variable) or { c } (a constant); null when the
// side is anything else.
function atomicOf(side, ctx, els) {
  const ex = expandSide(asSide(side), ctx)
  const vars = new Map(ex.vars.map(v => [v.id, v]))
  if (ex.atoms.some(a => a.t === 'opt' || a.t === 'not')) return null
  const binds = new Map(), consts = new Map()
  for (const a of ex.atoms) {
    if (a.t === 'bind') binds.set(a.v, a.y)
    if (a.t === 'const') consts.set(a.v, String(a.text ?? '').trim().replace(/^'(.*)'$/s, '$1'))
  }
  const facts = ex.atoms.filter(a => a.t === 'fact')
  const used = new Set()   // identifying atoms
  const memo = new Map()
  const keyOfVar = (id, depth = 0) => {
    if (memo.has(id)) return memo.get(id)
    let out = null
    if (binds.has(id)) out = [{ y: binds.get(id) }]
    else if (consts.has(id)) out = [{ c: consts.get(id) }]
    else if (depth < 6) {
      const v = vars.get(id)
      const parts = v && schemeParts(v.typeId, ctx, els)
      if (parts) {
        out = []
        for (const p of parts) {
          const a = facts.find(x => x.factId === p.factId && x.args[p.entityRoleIndex] === id && x.args[p.roleIndex])
          const sub = a && keyOfVar(a.args[p.roleIndex], depth + 1)
          if (!sub) { out = null; break }
          used.add(a)
          out.push(...sub)
        }
      }
    }
    memo.set(id, out)
    return out
  }
  for (const v of ex.vars) keyOfVar(v.id)
  const content = facts.filter(a => !used.has(a))
  const types = ex.atoms.filter(a => a.t === 'type' && vars.get(a.arg)?.typeId !== a.typeId)
  if (content.length === 1 && !types.length) {
    const a = content[0]
    const roles = a.args.map(id => (id ? keyOfVar(id) : null))
    if (roles.some(r => !r)) return null
    return { kind: 'fact', factId: a.factId, roles }
  }
  if (!content.length && types.length <= 1) {
    // One entity (or table row) and its identifier.
    const typed = types[0]
    // (A subtype's instance plays its supertype's identifying role.)
    const at = (typeId, playerId) => typeId === playerId || supertypesOf(typeId, els).has(playerId)
    const roots = typed ? [vars.get(typed.arg)] : ex.vars.filter(v => ctx.otById.get(v.typeId)?.kind === 'entity'
      && !facts.some(a => used.has(a) && a.args.some((x, i) => x === v.id && !at(v.typeId, ctx.factById.get(a.factId)?.roles[i]?.objectTypeId))))
    if (roots.length !== 1 || !roots[0]) return null
    const key = keyOfVar(roots[0].id)
    return key ? { kind: 'entity', typeId: typed ? typed.typeId : roots[0].typeId, key } : null
  }
  return null
}

// The atomic rules of a mapping for one side: { facts: Map(factId → [entry]),
// types: Map(typeId → [entry]) } with entry { rule, atomic }.
export function atomicRules(mapping, side, ctx, els) {
  const facts = new Map(), types = new Map()
  for (const rule of mapping.rules) {
    let a
    try { a = atomicOf(rule[side], ctx, els) } catch { a = null }
    if (!a) continue
    const m = a.kind === 'fact' ? facts : types
    const id = a.kind === 'fact' ? a.factId : a.typeId
    if (!m.has(id)) m.set(id, [])
    m.get(id).push({ rule, atomic: a })
  }
  return { facts, types }
}

// ── Unfolding ────────────────────────────────────────────────────────────────

// Union-find over slots (the values a folded rule joins on).
class Slots {
  constructor() { this.p = new Map(); this.type = new Map(); this.n = 0; this.const = new Map(); this.name = new Map() }
  make(typeId) { const s = `s${++this.n}`; this.type.set(s, typeId); return s }
  find(s) { while (this.p.has(s)) s = this.p.get(s); return s }
  union(a, b) {
    a = this.find(a); b = this.find(b)
    if (a === b) return
    this.p.set(b, a)
    if (this.const.has(b)) this.setConst(a, this.const.get(b))
    if (!this.name.has(a) && this.name.has(b)) this.name.set(a, this.name.get(b))
  }
  setConst(s, c) {
    s = this.find(s)
    if (this.const.has(s) && this.const.get(s) !== c) throw new FoldError(`the rule asks for both '${this.const.get(s)}' and '${c}' in one place`)
    this.const.set(s, c)
  }
}

// The derivation rule of a derived element, as { vars: [{ id, typeId }],
// atoms, roots: [{ id, typeId }] } in the mapping fragment; throws FoldError
// for anything outside it.
function fragmentOf(el, kind, ctx) {
  let rule, roots
  if (kind === 'fact') {
    const parts = factRuleParts(el)
    if (parts.computed.length) throw new FoldError('its rule computes values (terms), which a mapping rule can\'t give')
    rule = parts.body
    roots = [...parts.selected, ...parts.extra].map(r => ({ id: r.id, typeId: r.typeIds[0] }))
  } else {
    rule = upgradeRule(el.derivationRule)
    const supers = directSupertypes(el.id, ctx.subtypes)
    roots = supers.length ? [{ id: SUBJECT, typeId: el.id }]
      : (referenceParts(el.id, { ...elsOf(ctx) }) ?? []).map(p => ({ id: p.id, typeId: p.typeId }))
  }
  const vars = [], atoms = []
  const walk = (n) => {
    switch (n?.t) {
      case 'true': return
      case 'and': (n.args ?? []).forEach(walk); return
      case 'exists': vars.push({ id: n.v.id, typeId: n.v.typeId }); walk(n.body); return
      case 'fact': atoms.push(n); return
      case 'type': atoms.push(n); return
      case 'vcmp':
        if (n.op === '≈' && n.left?.t === 'var' && n.right?.t === 'const') { atoms.push({ t: 'const', v: n.left.id, text: n.right.text }); return }
        if (n.op === '≈' && n.right?.t === 'var' && n.left?.t === 'const') { atoms.push({ t: 'const', v: n.right.id, text: n.left.text }); return }
        // Two values that are equal (a table rule's join on $y, table rules
        // compile it so when the variables' types differ).
        if (n.op === '≈' && n.left?.t === 'var' && n.right?.t === 'var') { atoms.push({ t: 'veq', a: n.left.id, b: n.right.id }); return }
        throw new FoldError('its rule compares values in a way a mapping rule can\'t (only x ≈ \'c\')')
      case 'hole': case undefined: throw new FoldError('its rule is not complete')
      default: {
        const what = { not: 'a negation', or: 'a disjunction', implies: 'an implication', iff: 'an equivalence', forall: 'a ∀', count: 'a counting quantifier', tc: 'a transitive closure', cmp: 'an (in)equality of objects', dpred: 'a data predicate' }[n.t] ?? n.t
        throw new FoldError(`its rule uses ${what}; only ∃, ∧, atoms and x ≈ 'c' can be folded`)
      }
    }
  }
  walk(rule)
  return { vars, atoms, roots }
}

// The other side of an atomic rule, renamed for one use: its frontier
// variables become slots (by leaf), its variables fresh ones.
function instantiateSide(side, slotOf, fresh) {
  const flat = asSide(side)
  const ren = new Map()
  const v = (id) => { if (id == null) return id; if (!ren.has(id)) ren.set(id, fresh()); return ren.get(id) }
  const bad = flat.atoms.some(a => a.t === 'opt' || a.t === 'not' || (a.t === 'rel' && Object.values(a.args ?? {}).some(x => x?.k === 'opt' || x?.k === 'absent')))
  if (bad) throw new FoldError('a rule it unfolds through has an optional or negated part')
  const vars = flat.vars.map(x => ({ id: v(x.id), typeId: x.typeId }))
  const atoms = flat.atoms.map(a => {
    switch (a.t) {
      case 'fact': return { t: 'fact', factId: a.factId, args: a.args.map(v) }
      case 'type': return { t: 'type', typeId: a.typeId, arg: v(a.arg) }
      case 'bind': return { t: 'bind', v: v(a.v), y: slotOf(a.y) }
      case 'const': return { t: 'const', v: v(a.v), text: a.text }
      case 'rel': return { t: 'rel', tableId: a.tableId, args: Object.fromEntries(Object.entries(a.args ?? {}).map(([c, x]) => [c,
        x.k === 'fv' ? { k: 'fv', y: slotOf(x.y) } : x.k === 'var' ? { k: 'var', v: v(x.v) } : { ...x }])) }
      default: throw new FoldError(`a rule it unfolds through has a ${a.t} atom`)
    }
  })
  return { vars, atoms }
}

const snake = (s) => String(s ?? 'v').replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/[^A-Za-z0-9]+/g, '_').replace(/^_|_$/g, '').toLowerCase() || 'v'

// Unfolds one derived element into a new mapping rule (pattern trees for both
// sides, oriented as the mapping's): { rule } or throws FoldError.
function unfold(el, kind, X, Y, ctxs, atomics) {
  const ctxX = ctxs[X], ctxY = ctxs[Y]
  const els = elsOf(ctxX)
  const frag = fragmentOf(el, kind, ctxX)
  const S = new Slots()
  const varType = new Map([...frag.roots, ...frag.vars].map(v => [v.id, v.typeId]))
  const slotsMemo = new Map()
  const slotsOf = (id) => {
    if (slotsMemo.has(id)) return slotsMemo.get(id)
    const typeId = varType.get(id)
    const leaves = keyLeaves(typeId, ctxX, els)
    if (!leaves) throw new FoldError(`${ctxX.otById.get(typeId)?.name ?? 'a type'} has no reference scheme to join on`)
    const out = leaves.map(vt => S.make(vt))
    slotsMemo.set(id, out)
    return out
  }
  const nameOfType = (id) => ctxX.otById.get(id)?.name ?? ctxX.factById.get(id) ? readingName(ctxX.factById.get(id), ctxX) : '?'
  let n = 0
  const fresh = () => `f${++n}`
  const parts = []   // instantiated other sides
  const asserted = new Set()
  const use = (entry, leavesFor) => {
    const map = new Map()   // frontier name → slot
    leavesFor.forEach(([leaves, slots]) => leaves.forEach((leaf, i) => {
      if (leaf.y != null) {
        if (map.has(leaf.y)) S.union(map.get(leaf.y), slots[i]); else map.set(leaf.y, slots[i])
        const s = S.find(slots[i])
        if (!S.name.has(s)) S.name.set(s, leaf.y)
      } else S.setConst(slots[i], leaf.c)
    }))
    parts.push(instantiateSide(entry.rule[Y], (y) => {
      if (!map.has(y)) { const s = S.make(null); map.set(y, s); S.name.set(s, y) }
      return map.get(y)
    }, fresh))
  }
  const ident = (factId, ri) => {
    // Whether role ri of the fact type identifies its player at the other role.
    const f = ctxX.factById.get(factId)
    if (!f) return null
    for (let e = 0; e < f.roles.length; e++) {
      if (e === ri) continue
      const ps = schemeParts(f.roles[e].objectTypeId, ctxX, els)
      const p = ps?.find(q => q.factId === factId && q.entityRoleIndex === e && q.roleIndex === ri)
      if (p) return { e, p }
    }
    return null
  }
  for (const a of frag.atoms) {
    if (a.t === 'const') { slotsOf(a.v).forEach(s => S.setConst(s, String(a.text ?? '').trim().replace(/^'(.*)'$/s, '$1'))); continue }
    if (a.t === 'veq') {
      const sa = slotsOf(a.a), sb = slotsOf(a.b)
      if (sa.length !== sb.length) throw new FoldError('its rule equates values with different identifiers')
      sa.forEach((x, i) => S.union(x, sb[i]))
      continue
    }
    if (a.t === 'type') {
      const t = ctxX.otById.get(a.typeId)
      if (!t || t.kind === 'value') continue
      const e = atomics.types.get(a.typeId)?.[0]
      if (!e) throw new FoldError(`no mapping rule maps ${t.name} on its own`)
      use(e, [[e.atomic.key, slotsOf(a.arg)]])
      asserted.add(a.arg)
      continue
    }
    const f = ctxX.factById.get(a.factId)
    if (!f) throw new FoldError('its rule names a fact type that is not in the schema (an implied link?)')
    if (a.args.some(x => x == null)) throw new FoldError('its rule has an atom with a missing variable')
    // An identifying fact: the reference values are the same.
    const idParts = f.roles.map((_, i) => ident(f.id, i)).filter(Boolean)
    if (f.roles.length === 2 && idParts.length) {
      const { e, p } = idParts[0]
      const es = slotsOf(a.args[e]), vs = slotsOf(a.args[p.roleIndex])
      vs.forEach((s, i) => S.union(es[p.from + i], s))
      continue
    }
    const entry = atomics.facts.get(f.id)?.[0]
    if (!entry) throw new FoldError(`no mapping rule maps ${readingName(f, ctxX)} on its own`)
    use(entry, a.args.map((id, i) => {
      const leaves = entry.atomic.roles[i], slots = slotsOf(id)
      if (leaves.length !== slots.length) throw new FoldError(`the rule for ${readingName(f, ctxX)} gives role ${i + 1} another identifier`)
      return [leaves, slots]
    }))
    a.args.forEach(id => asserted.add(id))
  }
  // Entities the rule only names by their identifier exist through their
  // type's own rule.
  for (const v of [...frag.roots, ...frag.vars]) {
    const t = ctxX.otById.get(v.typeId)
    if (!t || t.kind !== 'entity' || asserted.has(v.id)) continue
    if (kind === 'type' && v.id === SUBJECT) continue
    const e = atomics.types.get(v.typeId)?.[0]
    if (!e) throw new FoldError(`no mapping rule maps ${t.name} on its own`)
    use(e, [[e.atomic.key, slotsOf(v.id)]])
  }
  if (kind === 'type' && frag.roots[0]?.id === SUBJECT && !asserted.has(SUBJECT)) {
    // A subtype's candidates are its supertypes' instances.
    for (const sup of directSupertypes(el.id, ctxX.subtypes)) {
      const e = atomics.types.get(sup)?.[0]
      if (!e) throw new FoldError(`no mapping rule maps ${ctxX.otById.get(sup)?.name ?? 'its supertype'} on its own`)
      use(e, [[e.atomic.key, slotsOf(SUBJECT)]])
    }
  }

  // The frontier: the slots of the derived element's own variables.
  const rootSlots = kind === 'fact'
    ? factRuleParts(el).roles.map(r => slotsOf(r.id))
    : frag.roots.map(r => slotsOf(r.id))
  const frontier = new Map()   // slot root → name
  const taken = new Set()
  for (const s of rootSlots.flat().map(x => S.find(x))) {
    if (frontier.has(s)) continue
    let base = S.name.get(s) ?? snake(ctxX.otById.get(S.type.get(s))?.name)
    let name = base
    for (let i = 2; taken.has(name); i++) name = `${base}_${i}`
    taken.add(name)
    frontier.set(s, name)
  }
  for (const s of frontier.keys()) if (S.const.has(s)) throw new FoldError('its own values are fixed by a constant')

  // The other side: joined through the slots.
  const ySide = finishOther(parts, S, frontier, ctxY)
  // The derived element's side: its pattern over the frontier.
  const xSide = ownPattern(el, kind, ctxX, els, rootSlots.map(ss => ss.map(s => frontier.get(S.find(s)))))
  const rule = { id: uid(), name: kind === 'fact' ? readingName(el, ctxX) : el.name, [X]: sideToTree(xSide), [Y]: sideToTree(ySide) }
  return rule
}

// The instantiated other sides as one pattern: slots in the frontier become
// frontier variables, the others variables joined between the parts;
// repeated rows and entities are merged.
function finishOther(parts, S, frontier, ctx) {
  let vars = parts.flatMap(p => p.vars)
  let atoms = parts.flatMap(p => p.atoms)
  const varType = new Map(vars.map(v => [v.id, v.typeId]))
  // Slot variables: one per internal slot.
  const slotVar = new Map()
  const declare = (s, typeId) => {
    if (!slotVar.has(s)) { slotVar.set(s, { id: `j${slotVar.size + 1}`, typeId }); return slotVar.get(s) }
    const v = slotVar.get(s)
    if (typeId && v.typeId && typeId !== v.typeId) {
      const a = ctx.otById.get(typeId)?.name ?? '?', b = ctx.otById.get(v.typeId)?.name ?? '?'
      throw new FoldError(`the folded rule would join values of ${b} and ${a}`)
    }
    if (!v.typeId) v.typeId = typeId
    return v
  }
  const ren = new Map()   // variable → variable
  const r = (id) => { while (ren.has(id)) id = ren.get(id); return id }
  const out = []
  for (const a of atoms) {
    if (a.t === 'bind') {
      const s = S.find(a.y)
      if (frontier.has(s)) out.push({ t: 'bind', v: a.v, y: frontier.get(s) })
      else ren.set(a.v, declare(s, varType.get(a.v)).id)
    } else if (a.t === 'rel') {
      const tb = ctx.tableById.get(a.tableId)
      const args = {}
      for (const [c, x] of Object.entries(a.args)) {
        if (x.k !== 'fv') { args[c] = x; continue }
        const s = S.find(x.y)
        if (frontier.has(s)) args[c] = { k: 'fv', y: frontier.get(s) }
        else args[c] = { k: 'var', v: declare(s, tb?.columns.find(col => col.fact.id === c)?.vt.id).id }
      }
      out.push({ ...a, args })
    } else out.push(a)
  }
  for (const [s, v] of slotVar) if (S.const.has(s)) out.push({ t: 'const', v: v.id, text: S.const.get(s) })
  vars = [...vars, ...slotVar.values()]
  const fix = (a) => {
    if (a.t === 'fact') return { ...a, args: a.args.map(r) }
    if (a.t === 'type') return { ...a, arg: r(a.arg) }
    if (a.t === 'bind' || a.t === 'const') return { ...a, v: r(a.v) }
    if (a.t === 'rel') return { ...a, args: Object.fromEntries(Object.entries(a.args).map(([c, x]) => [c, x.k === 'var' ? { k: 'var', v: r(x.v) } : x])) }
    return a
  }
  atoms = out.map(fix)
  // Merge entities with the same identifying value, and rows with the same key.
  const els = elsOf(ctx)
  for (let changed = true; changed;) {
    changed = false
    const byKey = new Map()
    for (const a of atoms) {
      if (a.t !== 'fact') continue
      const f = ctx.factById.get(a.factId)
      if (f?.roles.length !== 2) continue
      for (let e = 0; e < 2; e++) {
        const sch = schemeOf(f.roles[e].objectTypeId, els)
        if (sch?.kind !== 'refMode' || sch.rm.factId !== f.id || sch.rm.vtRoleIndex !== 1 - e) continue
        const k = `${f.id}:${a.args[1 - e]}`
        const had = byKey.get(k)
        if (had && had !== a.args[e]) { ren.set(a.args[e], had); changed = true } else byKey.set(k, a.args[e])
      }
    }
    // Two values bound to one frontier variable are the same value.
    const byY = new Map()
    for (const a of atoms) {
      if (a.t !== 'bind') continue
      const had = byY.get(a.y)
      if (had && had !== a.v && varType.get(had) === varType.get(a.v)) { ren.set(a.v, had); changed = true } else if (!had) byY.set(a.y, a.v)
    }
    atoms = atoms.map(fix)
    // Rows of one table with the same primary key.
    const rows = []
    for (const a of atoms) {
      if (a.t !== 'rel') { rows.push(a); continue }
      const tb = ctx.tableById.get(a.tableId)
      const pk = tb?.pk?.map(c => c.fact.id)
      const same = pk?.length && rows.find(b => b.t === 'rel' && b.tableId === a.tableId
        && pk.every(c => a.args[c] && JSON.stringify(a.args[c]) === JSON.stringify(b.args[c]))
        && Object.entries(a.args).every(([c, x]) => !b.args[c] || JSON.stringify(b.args[c]) === JSON.stringify(x)))
      if (same) { Object.assign(same.args, a.args); changed = true } else rows.push({ ...a, args: { ...a.args } })
    }
    atoms = rows
    const seen = new Set()
    atoms = atoms.filter(a => { const k = JSON.stringify(a); if (seen.has(k)) return false; seen.add(k); return true })
  }
  atoms = dropRedundantRows(atoms)
  atoms = dropBareIdentifiers(atoms, ctx)
  // A constant for a column: written in the row.
  for (const c of atoms.filter(a => a.t === 'const')) {
    const refs = atoms.filter(a => a !== c && JSON.stringify(a).includes(JSON.stringify(c.v)))
    const row = refs.length === 1 && refs[0].t === 'rel' ? refs[0] : null
    const col = row && Object.keys(row.args).find(k => row.args[k].k === 'var' && row.args[k].v === c.v)
    if (!col) continue
    row.args[col] = { k: 'const', text: c.text }
    atoms = atoms.filter(a => a !== c)
  }
  const usedVars = new Set()
  for (const a of atoms) {
    if (a.t === 'fact') a.args.forEach(x => usedVars.add(x))
    if (a.t === 'type') usedVars.add(a.arg)
    if (a.t === 'bind' || a.t === 'const') usedVars.add(a.v)
    if (a.t === 'rel') Object.values(a.args).forEach(x => x.k === 'var' && usedVars.add(x.v))
  }
  const seenVar = new Set()
  vars = vars.map(v => ({ ...v, id: r(v.id) })).filter(v => usedVars.has(v.id) && !seenVar.has(v.id) && seenVar.add(v.id))
  return { vars, atoms }
}

// Rows that another row of the same table already gives: every column the
// same, or a variable used nowhere else (∃v R(…, v, …) holds when R(…, w, …)
// does). Such a row comes from unfolding an entity whose existence the rest
// of the rule already implies.
function dropRedundantRows(atoms) {
  const uses = new Map()
  const count = (v) => uses.set(v, (uses.get(v) ?? 0) + 1)
  for (const a of atoms) {
    if (a.t === 'fact') a.args.forEach(count)
    if (a.t === 'type') count(a.arg)
    if (a.t === 'bind' || a.t === 'const') count(a.v)
    if (a.t === 'rel') Object.values(a.args).forEach(x => x.k === 'var' && count(x.v))
  }
  const out = [...atoms]
  for (let i = out.length - 1; i >= 0; i--) {
    const a = out[i]
    if (a.t !== 'rel') continue
    const covered = out.some((b, j) => j !== i && b.t === 'rel' && b.tableId === a.tableId && Object.entries(a.args).every(([c, x]) => {
      const y = b.args[c]
      if (!y) return false
      if (x.k === 'var' && uses.get(x.v) === 1) return true
      return JSON.stringify(x) === JSON.stringify(y)
    }))
    if (covered) out.splice(i, 1)
  }
  return out
}

// Identifying facts whose value is used nowhere else: every entity has its
// identifier, so ∃v (E has v) adds nothing when E is otherwise in the rule.
function dropBareIdentifiers(atoms, ctx) {
  const els = elsOf(ctx)
  const uses = new Map()
  const count = (v) => uses.set(v, (uses.get(v) ?? 0) + 1)
  for (const a of atoms) {
    if (a.t === 'fact') a.args.forEach(count)
    if (a.t === 'type') count(a.arg)
    if (a.t === 'bind' || a.t === 'const') count(a.v)
    if (a.t === 'rel') Object.values(a.args).forEach(x => x.k === 'var' && count(x.v))
  }
  return atoms.filter(a => {
    if (a.t !== 'fact') return true
    const f = ctx.factById.get(a.factId)
    if (f?.roles.length !== 2) return true
    for (let e = 0; e < 2; e++) {
      const parts = schemeParts(f.roles[e].objectTypeId, ctx, els)
      if (!parts?.some(p => p.factId === f.id && p.entityRoleIndex === e)) continue
      // The entity must be in the rule some other way, its value nowhere else.
      if (uses.get(a.args[1 - e]) === 1 && (uses.get(a.args[e]) ?? 0) > 1) return false
    }
    return true
  })
}

// The pattern of a derived element over the frontier names of its variables'
// reference values, the way generated rules write it.
function ownPattern(el, kind, ctx, els, rootNames) {
  const row = ctx.relational ? ownRow(el, kind, ctx, rootNames) : null
  if (row) return row
  let n = 0
  const vars = [], atoms = []
  const mk = (typeId) => { const v = { id: `d${++n}`, typeId }; vars.push(v); return v.id }
  const identify = (id, typeId, names) => {
    const t = ctx.otById.get(typeId)
    if (t?.kind === 'value') { atoms.push({ t: 'bind', v: id, y: names[0] }); return }
    for (const p of schemeParts(typeId, ctx, els) ?? []) {
      const w = mk(p.player)
      const f = ctx.factById.get(p.factId)
      const args = f.roles.map(() => null)
      args[p.entityRoleIndex] = id
      args[p.roleIndex] = w
      atoms.push({ t: 'fact', factId: p.factId, args })
      identify(w, p.player, names.slice(p.from, p.from + p.n))
    }
  }
  if (kind === 'fact') {
    const args = el.roles.map((r, i) => {
      const id = mk(r.objectTypeId)
      identify(id, r.objectTypeId, rootNames[i])
      return id
    })
    atoms.push({ t: 'fact', factId: el.id, args })
  } else {
    const e = mk(el.id)
    identify(e, el.id, rootNames.flat())
    if (directSupertypes(el.id, ctx.subtypes).length) atoms.push({ t: 'type', typeId: el.id, arg: e })
  }
  return { vars, atoms }
}

// On a relational side: a table, or a column, as a row of its table keyed by
// its primary key, the way generated rules write it; null when it isn't one.
function ownRow(el, kind, ctx, rootNames) {
  const tb = kind === 'type' ? ctx.tableById.get(el.id)
    : ctx.tables.find(t => t.columns.some(c => c.fact.id === el.id))
  const pk = tb?.pk
  if (!pk?.length) return null
  const args = {}
  if (kind === 'type') {
    const names = rootNames.flat()
    const parts = referenceParts(tb.id, elsOf(ctx)) ?? []
    if (parts.length !== pk.length || names.length !== pk.length) return null
    parts.forEach((p, i) => { args[p.factId] = { k: 'fv', y: names[i] } })
  } else {
    const col = tb.columns.find(c => c.fact.id === el.id)
    const keyNames = rootNames[col.t], valName = rootNames[col.v]?.[0]
    const parts = referenceParts(tb.id, elsOf(ctx)) ?? []
    if (!valName || parts.length !== pk.length || keyNames?.length !== pk.length) return null
    parts.forEach((p, i) => { args[p.factId] = { k: 'fv', y: keyNames[i] } })
    args[el.id] = { k: 'fv', y: valName }
  }
  return { vars: [], atoms: [{ t: 'rel', tableId: tb.id, args }] }
}

// A flat side as a pattern tree.
export function sideToTree(side) {
  const node = (a) => {
    if (a.t === 'bind') return { t: 'vcmp', op: '≈', left: { t: 'var', id: a.v }, right: { t: 'fv', y: a.y } }
    if (a.t === 'const') return { t: 'vcmp', op: '≈', left: { t: 'var', id: a.v }, right: { t: 'const', text: a.text } }
    return a
  }
  const body = side.atoms.length === 1 ? node(side.atoms[0]) : { t: 'and', args: side.atoms.map(node) }
  return side.vars.reduceRight((b, v) => ({ t: 'exists', v: { id: v.id, typeId: v.typeId }, body: b }), body)
}

// ── Planning ─────────────────────────────────────────────────────────────────

// The fully derived elements of one schema, in an order in which each comes
// after the derived elements its rule uses.
function derivedElements(ctx) {
  const items = [
    ...ctx.objectTypes.filter(o => o.derivation === 'derived').map(o => ({ el: o, kind: 'type' })),
    ...ctx.facts.filter(f => f.derivation === 'derived').map(f => ({ el: f, kind: 'fact' })),
  ]
  const ids = new Set(items.map(i => i.el.id))
  const usesOf = (it) => {
    const s = JSON.stringify(it.kind === 'fact' ? it.el.derivationRule ?? null : it.el.derivationRule ?? null)
    return [...ids].filter(id => id !== it.el.id && s.includes(JSON.stringify(id)))
  }
  // Identifying fact types of a derived entity type stand for it.
  const owner = new Map()
  for (const it of items) if (it.kind === 'type') for (const p of referenceParts(it.el.id, elsOf(ctx)) ?? []) owner.set(p.factId, it.el.id)
  const deps = new Map(items.map(it => {
    const s = JSON.stringify(it.el.derivationRule ?? null)
    const via = [...owner].filter(([fid, o]) => o !== it.el.id && s.includes(JSON.stringify(fid))).map(([, o]) => o)
    return [it.el.id, new Set([...usesOf(it), ...via])]
  }))
  const out = [], done = new Set()
  for (let progress = true; progress && out.length < items.length;) {
    progress = false
    for (const it of items) {
      if (done.has(it.el.id) || [...deps.get(it.el.id)].some(d => !done.has(d))) continue
      out.push(it); done.add(it.el.id); progress = true
    }
  }
  for (const it of items) if (!done.has(it.el.id)) out.push({ ...it, cyclic: true })
  return out
}

// Which side of the mapping holds the derived elements: the one with more.
function foldSide(state, mapping) {
  const counts = SIDES.map(side => derivedElements(sideContext(state, sideSchemaId(mapping, side))).length)
  return counts[0] > counts[1] ? 'source' : 'target'
}

const nameOf = (it, ctx) => (it.kind === 'fact' ? readingName(it.el, ctx) : it.el.name)

export function planFold(state, mapping, { side = null, check = true } = {}) {
  const X = side ?? foldSide(state, mapping), Y = other(X)
  const ctxs = { source: sideContext(state, mapping.sourceSchemaId), target: sideContext(state, mapping.targetSchemaId) }
  const ctxX = ctxs[X]
  const els = elsOf(ctxX)
  const items = []
  let working = mapping
  for (const it of derivedElements(ctxX)) {
    const item = { id: it.el.id, kind: it.kind, name: nameOf(it, ctxX), rule: null, error: null, issues: [] }
    items.push(item)
    if (it.cyclic) { item.error = 'its rule depends on itself'; continue }
    try {
      const atomics = atomicRules(working, X, ctxX, els)
      const rule = unfold(it.el, it.kind, X, Y, ctxs, atomics)
      item.rule = rule
      working = { ...working, rules: [...working.rules, rule] }
    } catch (err) {
      if (!(err instanceof FoldError)) throw err
      item.error = err.message
    }
  }
  // The new rules' checks, against the schemas as they will be (the derived
  // elements ordinary ones).
  const after = promoted(state, items.filter(i => i.rule).map(i => i.id))
  for (const i of items) if (i.rule) i.issues = checkRule(i.rule, working, after)
  const plan = { side: X, items, candidates: [], mapping: working }
  if (check) plan.candidates = removalCandidates(after, state, working, X, items)
  return plan
}

// The state with derived elements turned into ordinary ones (their rules
// gone), keeping the populations the rules gave.
function promoted(state, ids) {
  const set = new Set(ids)
  if (!set.size) return state
  const ev = makePopulationEvaluator(state)
  const populations = { ...(state.populations ?? {}) }, factPopulations = { ...(state.factPopulations ?? {}) }
  for (const o of state.objectTypes ?? []) {
    if (!set.has(o.id)) continue
    const p = ev.population(o.id)
    if (!p.error) populations[o.id] = p.instances
  }
  for (const f of state.facts ?? []) {
    if (!set.has(f.id)) continue
    const r = ev.factTuples(f.id)
    if (!r.error) factPopulations[f.id] = r.tuples
  }
  return {
    ...state,
    objectTypes: (state.objectTypes ?? []).map(o => (set.has(o.id) ? strip(o) : o)),
    facts: (state.facts ?? []).map(f => (set.has(f.id) ? strip(f) : f)),
    populations, factPopulations,
  }
}

// The fact types the folded rules used (rules read from `before`, the state
// before promotion), and whether each can go.
function removalCandidates(state, before, mapping, X, items) {
  const ctxX = sideContext(state, sideSchemaId(mapping, X))
  const els = elsOf(ctxX)
  const ident = new Set()
  for (const o of ctxX.objectTypes) for (const p of schemeParts(o.id, ctxX, els) ?? []) ident.add(p.factId)
  const folded = new Set(items.filter(i => i.rule).map(i => i.id))
  const usedBy = new Map()
  for (const i of items) {
    if (!i.rule) continue
    const el = (i.kind === 'fact' ? before.facts : before.objectTypes).find(x => x.id === i.id)
    const s = JSON.stringify(el?.derivationRule ?? null)
    for (const f of ctxX.facts) {
      if (ident.has(f.id) || folded.has(f.id) || isDerivedFact(f) || !s.includes(JSON.stringify(f.id))) continue
      if (!usedBy.has(f.id)) usedBy.set(f.id, [])
      usedBy.get(f.id).push(i.id)
    }
  }
  return [...usedBy].map(([factId, by]) => {
    const f = ctxX.factById.get(factId)
    const { dropped, ...r } = recoverable(state, mapping, X, [factId])
    return { factId, name: readingName(f, ctxX), usedBy: by, ...r }
  })
}

// Whether fact types of side X can be dropped with the rules that name them:
// run the rest of the mapping there and back on a generic population of the
// other side built from those rules. { recoverable, reason }.
export function recoverable(state, mapping, X, factIds) {
  const Y = other(X)
  const ctxX = sideContext(state, sideSchemaId(mapping, X))
  const ids = new Set(factIds)
  const names = (rule) => {
    const s = expandSide(asSide(rule[X]), ctxX)
    const out = new Set()
    const walk = (atoms) => { for (const a of atoms ?? []) { if (a.t === 'fact') out.add(a.factId); if (a.t === 'opt' || a.t === 'not') walk(a.atoms) } }
    walk(s.atoms)
    return out
  }
  const dropped = mapping.rules.filter(r => [...names(r)].some(id => ids.has(id)))
  const kept = mapping.rules.filter(r => !dropped.includes(r))
  if (!dropped.length) return { recoverable: true, reason: 'no rule maps it', dropped: [] }
  const wY = worldOf(state, sideSchemaId(mapping, Y))
  const g = genericPopulation(wY, dropped.map(r => r[Y]))
  if (g.error) return { recoverable: false, reason: `could not be checked: ${g.error}`, dropped: dropped.map(r => r.id) }
  const rest = { ...mapping, rules: kept }
  const dirThere = Y === 'source' ? 'forward' : 'backward', dirBack = Y === 'source' ? 'backward' : 'forward'
  const prepThere = prepareRun(state, rest, dirThere, { check: false }), prepBack = prepareRun(state, rest, dirBack, { check: false })
  // Every fact of the other side that the dropped rules name must come back.
  const named = new Set()
  for (const r of dropped) {
    const s = expandSide(asSide(r[Y]), wY.ctx)
    for (const a of s.atoms) if (a.t === 'fact') named.add(a.factId)
  }
  const data = (p) => ({ ...wY.els, ...p, nestedEntityMappings: {}, subtypeMappings: {} })
  // A value of a type with few values (a boolean, an enumeration) is tried
  // with each of them, as the rules may treat each differently.
  for (const pops of finiteCases(wY, g.pops)) {
    let n = 0
    const fresh = () => `⊥r${++n}`
    const lost = lostFact(wY, named, data, pops, executeRun(prepBack, executeRun(prepThere, pops, { fresh }), { fresh }))
    if (lost) return { ...lost, dropped: dropped.map(r => r.id) }
  }
  return { recoverable: true, reason: 'the other rules give back everything it carried', dropped: dropped.map(r => r.id) }
}

// The first fact of the generic population that does not come back, as
// { recoverable: false, reason }, or null.
function lostFact(wY, named, data, gPops, back) {
  const evG = makePopulationEvaluator(data(gPops)), evB = makePopulationEvaluator(data(back))
  for (const fid of named) {
    const have = new Set((evB.factTuples(fid).tuples ?? []).map(t => JSON.stringify(t.map(keyOf))))
    const lost = (evG.factTuples(fid).tuples ?? []).find(t => !have.has(JSON.stringify(t.map(keyOf))))
    if (lost) {
      const show = (c) => (typeof c === 'string' ? c : JSON.stringify(c))
      const col = wY.relational?.tables.flatMap(t => t.columns.map(c => ({ t, c }))).find(x => x.c.fact.id === fid)
      const what = col ? `${col.t.name}.${col.c.name} would lose values such as ${show(lost[col.c.v])} (row ${show(lost[col.c.t])})`
        : `${wY.ctx.factById.get(fid) ? readingName(wY.ctx.factById.get(fid), wY.ctx) : 'a fact type'} would lose facts such as (${lost.map(show).join(', ')})`
      return { recoverable: false, reason: `without it, ${what}` }
    }
  }
  return null
}

// The values of a value type when there are only a few: a boolean's, or a
// value range of single values. Null otherwise.
function finiteValues(vt, role = null) {
  if (!vt) return null
  if (valueKindName(vt.datatypeAssignment) === 'boolean' || /^bool/i.test(vt.datatypeAssignment?.datatypeId ?? '')) return ['true', 'false']
  const r = role?.valueRange?.length ? role.valueRange : vt.valueRange ?? []
  return r.length && r.length <= 8 && r.every(x => x.type === 'single') ? r.map(x => String(x.value)) : null
}

// The population with each labelled null of a value type with few values
// replaced by each of them (at most 16 cases); the population itself when
// there is none.
export function finiteCases(w, pops) {
  const nulls = new Map()
  for (const f of w.ctx.facts) for (const t of pops.factPopulations?.[f.id] ?? []) t.forEach((c, i) => {
    if (typeof c !== 'string' || !c.startsWith('⊥') || nulls.has(c)) return
    const vals = finiteValues(w.ctx.otById.get(f.roles[i]?.objectTypeId), f.roles[i])
    if (vals) nulls.set(c, vals)
  })
  // Rows of a table keyed by several columns: the key's values.
  for (const [tid, rows] of Object.entries(pops.populations ?? {})) {
    const pk = w.ctx.tableById?.get(tid)?.pk
    if (!pk || pk.length < 2) continue
    for (const row of rows) if (Array.isArray(row)) row.forEach((c, i) => {
      if (typeof c !== 'string' || !c.startsWith('⊥') || nulls.has(c) || !pk[i]) return
      const vals = finiteValues(pk[i].vt, pk[i].fact.roles[pk[i].v])
      if (vals) nulls.set(c, vals)
    })
  }
  if (!nulls.size) return [pops]
  let cases = [[]]
  for (const [n, vals] of nulls) cases = cases.flatMap(cs => vals.map(v => [...cs, [n, v]])).slice(0, 16)
  const text = JSON.stringify(pops)
  return cases.map(cs => JSON.parse(cs.reduce((s, [n, v]) => s.split(JSON.stringify(n)).join(JSON.stringify(v)), text)))
}

// What applying a plan changes, for the store: the new mapping (rules of the
// removed fact types dropped), the promoted elements, and the fact types to
// delete. Removals are checked together; one that is not recoverable with the
// others is kept. { mapping, promote: [id], remove: [factId], report: [text] }.
export function foldChanges(state, plan, { fold = null, remove = null } = {}) {
  const chosen = plan.items.filter(i => i.rule && (!fold || fold.includes(i.id)))
  const report = []
  const base = state.mappings.find(m => m.id === plan.mapping.id)
  let mapping = { ...base, rules: [...base.rules, ...chosen.map(i => i.rule)] }
  for (const i of chosen) report.push(`Folded ${i.name} into the mapping as rule "${i.rule.name}"`)
  for (const i of plan.items.filter(x => !x.rule)) report.push(`Not folded: ${i.name} (${i.error})`)
  const after = promoted(state, chosen.map(i => i.id))
  const wanted = (remove ?? plan.candidates.filter(c => c.recoverable).map(c => c.factId))
  const removeIds = []
  for (const fid of wanted) {
    const r = recoverable(after, mapping, plan.side, [...removeIds, fid])
    const name = plan.candidates.find(c => c.factId === fid)?.name ?? 'a fact type'
    if (r.recoverable) removeIds.push(fid)
    else report.push(`Kept ${name}: ${r.reason}`)
  }
  if (removeIds.length) {
    const r = recoverable(after, mapping, plan.side, removeIds)
    mapping = { ...mapping, rules: mapping.rules.filter(x => !r.dropped.includes(x.id)) }
    for (const fid of removeIds) report.push(`Removed ${plan.candidates.find(c => c.factId === fid)?.name ?? 'a fact type'} and its rules`)
  }
  const changes = { mapping, promote: chosen.map(i => i.id), remove: removeIds, populations: after.populations, factPopulations: after.factPopulations, add: [], report }
  // Constraints the folded fact types get from the other side: a mandatory
  // role or a single-role uniqueness constraint that the mapping keeps
  // (accounting.js), e.g. a NOT NULL column that a removed fact type carried.
  const folded = chosen.filter(i => i.kind === 'fact').map(i => i.id)
  if (folded.length) {
    const sug = suggestedConstraints(foldedState(state, changes), mapping, plan.side, folded)
    changes.add = sug
    for (const c of sug) report.push(`Added ${c.label} (${c.status}: ${c.reason})`)
  }
  // Foreign keys of folded tables, to and from the tables with the same key.
  const tables = chosen.filter(i => i.kind === 'type').map(i => i.id)
  if (tables.length) {
    const fks = suggestedForeignKeys(foldedState(state, changes), mapping, plan.side, tables)
    changes.add = [...changes.add, ...fks]
    for (const c of fks) report.push(`Added ${c.label} (${c.status}: ${c.reason})`)
  }
  return changes
}

// The state after a fold, without the store's diagram bookkeeping (for
// checks; the store applies the same changes with its own actions).
export function foldedState(state, changes) {
  const promote = new Set(changes.promote), remove = new Set(changes.remove)
  let facts = (state.facts ?? []).filter(f => !remove.has(f.id)).map(f => (promote.has(f.id) ? strip(f) : f))
  for (const a of changes.add ?? []) if (a.kind !== 'fk') facts = facts.map(f => (f.id !== a.factId ? f : addConstraint(f, a)))
  const fks = (changes.add ?? []).filter(a => a.kind === 'fk').map(a => a.constraint)
  const factPopulations = Object.fromEntries(Object.entries(changes.factPopulations ?? state.factPopulations ?? {}).filter(([id]) => !remove.has(id)))
  return {
    ...state,
    mappings: (state.mappings ?? []).map(m => (m.id === changes.mapping.id ? changes.mapping : m)),
    objectTypes: (state.objectTypes ?? []).map(o => (promote.has(o.id) ? strip(o) : o)),
    facts, populations: changes.populations ?? state.populations, factPopulations,
    constraints: [...(state.constraints ?? []).map(c => (c.sequences ? { ...c, sequences: c.sequences.map(q => (q ?? []).filter(m => !remove.has(m?.factId))) } : c)), ...fks],
  }
}

// Foreign keys a folded table of a relational side X can have, that the
// mapping keeps: from its primary key to another table's primary key of the
// same value types, and back (a vertical split gives both).
// [{ kind: 'fk', constraint, key, label, status, reason }].
export function suggestedForeignKeys(state, mapping, X, tableIds) {
  const ctx = sideContext(state, sideSchemaId(mapping, X))
  if (!ctx.relational) return []
  const keyOfTable = (t) => {
    const parts = referenceParts(t.id, elsOf(ctx))
    const cols = parts?.map(p => t.columns.find(c => c.fact.id === p.factId))
    return cols?.length && cols.every(Boolean) ? cols : null
  }
  const props = []
  const seq = (cols) => cols.map(c => ({ kind: 'role', factId: c.fact.id, roleIndex: c.v }))
  const has = (from, to) => ctx.constraints.some(c => c.constraintType === 'subset'
    && JSON.stringify(c.sequences?.[0]?.map(m => m.factId)) === JSON.stringify(from.map(x => x.fact.id))
    && JSON.stringify(c.sequences?.[1]?.map(m => m.factId)) === JSON.stringify(to.map(x => x.fact.id)))
  for (const id of tableIds) {
    const t = ctx.tableById.get(id)
    const k = t && keyOfTable(t)
    if (!k) continue
    for (const u of ctx.tables) {
      if (u.id === id) continue
      const ku = keyOfTable(u)
      if (!ku || ku.length !== k.length || ku.some((c, i) => c.vt.id !== k[i].vt.id)) continue
      for (const [a, b, A, B] of [[k, ku, t, u], [ku, k, u, t]]) {
        if (has(a, b)) continue
        const c = { ...mkSubset(ctx.schemaId), sequences: [seq(a), seq(b)], queries: [null, null] }
        props.push({ kind: 'fk', constraint: c, key: c.id,
          label: `FOREIGN KEY ${A.name}(${a.map(x => x.name).join(', ')}) → ${B.name}(${b.map(x => x.name).join(', ')})` })
      }
    }
  }
  if (!props.length) return []
  const st = { ...state, constraints: [...state.constraints, ...props.map(p => p.constraint)] }
  const steps = accountingSteps(st, mapping, { onlyKeys: new Set(props.map(p => p.key)) })
  let r
  for (;;) { const x = steps.next(); if (x.done) { r = x.value; break } }
  const byKey = new Map(r.sides[X].map(e => [e.key, e]))
  return props.filter(p => ['native', 'implied'].includes(byKey.get(p.key)?.status)).map(p => {
    const e = byKey.get(p.key)
    const wY = worldOf(state, sideSchemaId(mapping, other(X)))
    const by = [...new Set(e.by.map(b => relationalLabel(wY, b.key) ?? (b.entry ? `${b.entry.kind}: ${b.entry.subject}` : null)).filter(Boolean))]
    return { ...p, status: e.status, reason: by.length ? `kept by ${by.join('; ')}` : e.reason }
  })
}
const mkSubset = (schemaId) => ({ ...mkConstraint('subset', 0, 0), schemaId })

// An element made ordinary: no derivation rule, nor a table rule it came from.
export const strip = (x) => { const { derivation, derivationRule, tableRuleId, ...rest } = x; return rest }

export function addConstraint(f, a) {
  if (a.kind === 'mand') return { ...f, roles: f.roles.map((r, i) => (i === a.roleIndex ? { ...r, mandatory: true } : r)) }
  return { ...f, uniqueness: [...(f.uniqueness ?? []), { id: uid(), roles: [a.roleIndex] }] }
}

// Mandatory roles and single-role uniqueness constraints a fact type of side
// X lacks, that the mapping keeps: [{ factId, kind: 'mand'|'uc', roleIndex,
// key, label, status, reason }].
export function suggestedConstraints(state, mapping, X, factIds) {
  const ctx = sideContext(state, sideSchemaId(mapping, X))
  const props = []
  for (const fid of factIds) {
    const f = ctx.factById.get(fid)
    if (!f) continue
    const name = readingName(f, ctx)
    f.roles.forEach((r, i) => {
      const player = ctx.otById.get(r.objectTypeId)?.name ?? '?'
      if (!r.mandatory) props.push({ factId: fid, kind: 'mand', roleIndex: i, key: `${fid}:mand:${i}`, label: `a mandatory role for ${player} in ${name}` })
      const hasUc = (f.uniqueness ?? []).some(u => (u.roles ?? []).every(x => x === i))
      if (f.roles.length === 2 && !hasUc) props.push({ factId: fid, kind: 'uc', roleIndex: i, key: `${fid}:uc:${i}`, label: `uniqueness on the ${player} role of ${name}` })
    })
  }
  if (!props.length) return []
  let st = state
  for (const p of props) st = { ...st, facts: st.facts.map(f => (f.id === p.factId ? addConstraint(f, p) : f)) }
  // The keys of the added uniqueness constraints are by role list.
  const steps = accountingSteps(st, mapping, { onlyKeys: new Set(props.map(p => p.key)) })
  let r
  for (;;) { const x = steps.next(); if (x.done) { r = x.value; break } }
  const byKey = new Map(r.sides[X].map(e => [e.key, e]))
  return props.filter(p => ['native', 'implied'].includes(byKey.get(p.key)?.status)).map(p => {
    const e = byKey.get(p.key)
    const wY = worldOf(state, sideSchemaId(mapping, other(X)))
    const by = [...new Set(e.by.map(b => relationalLabel(wY, b.key) ?? (b.entry ? `${b.entry.kind}: ${b.entry.subject}` : null)).filter(Boolean))]
    return { ...p, status: e.status, reason: by.length ? `kept by ${by.join('; ')}` : e.reason }
  })
}

export { atomicOf, treeToSide, ownPattern, elsOf, snake }
