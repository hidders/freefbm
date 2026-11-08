// Mappings within one data model (ORM2 to ORM2, relational to relational),
// such as the mapping from a schema to its new version (Refactor, named
// transformations): such a mapping holds only the rules that change
// something. An element that the new version keeps as it was (an entity
// type, a table, a fact type, a column) is recorded as a pair in
// `mapping.unchanged` ([[sourceElementId, targetElementId]]) instead of as a
// rule that copies it to itself.
//
// Whatever reads a mapping's meaning (runs, accounting, equivalence, Fold,
// translation, exchanges, coverage) reads it through withImplicitRules, which
// gives the mapping with those identity rules written out (ids `same_<id>`,
// marked `identity`); compactMapping turns identity rules back into pairs.
// The Mappings tab, mapping diagrams and rule checks see only the rules.

import { sideContext, readingName } from './mapping.js'
import { keyLeaves, schemeParts, ownPattern, elsOf, snake, sideToTree, atomicOf } from './fold.js'

const isFullyDerived = (x) => x.derivation === 'derived'

// The sides of a mapping between two schemas of one profile, with what an
// identity rule needs: { old, neu } of { ctx, els, ident }.
function sidesOf(state, mapping) {
  const mk = (schemaId) => {
    const ctx = sideContext(state, schemaId), els = elsOf(ctx)
    const ident = new Set()
    for (const o of ctx.objectTypes) for (const p of schemeParts(o.id, ctx, els) ?? []) ident.add(p.factId)
    return { ctx, els, ident }
  }
  return { old: mk(mapping.sourceSchemaId), neu: mk(mapping.targetSchemaId) }
}

// Whether a mapping is between two schemas of the same profile.
export function isSameModel(state, mapping) {
  const p = (id) => state.schemas?.find(s => s.id === id)?.profile ?? 'orm2'
  return !!mapping && mapping.sourceSchemaId !== mapping.targetSchemaId && p(mapping.sourceSchemaId) === p(mapping.targetSchemaId)
}

// The element of a side (entity type or fact type) with its kind and label,
// when an identity rule can be written for it; else null.
function elementOf(side, id) {
  const { ctx, ident } = side
  const o = ctx.otById.get(id)
  if (o) return o.kind === 'entity' && !isFullyDerived(o) ? { el: o, kind: 'type', label: o.name } : null
  const f = ctx.facts.find(x => x.id === id)
  if (!f || ident.has(f.id) || isFullyDerived(f)) return null
  return { el: f, kind: 'fact', label: readingName(f, ctx) }
}

// The identity rule from element oldId of the source side to newId of the
// target side: the element's own pattern on both sides over the frontier
// names of its reference values (as fold.js writes them). null when there is
// none (no identifier, the two differ in kind or arity, or with sameName in
// name: an element renamed since stays a pair, but a renaming is a change
// compactMapping does not hide).
function identityRuleOf(sides, oldId, newId, { sameName = true } = {}) {
  const a = elementOf(sides.old, oldId), b = elementOf(sides.neu, newId)
  if (!a || !b || a.kind !== b.kind || (sameName && a.label !== b.label)) return null
  if (a.kind === 'fact' && a.el.roles.length !== b.el.roles.length) return null
  const { ctx, els } = sides.old
  const typeIds = a.kind === 'fact' ? a.el.roles.map(r => r.objectTypeId) : [a.el.id]
  if (typeIds.some(t => !keyLeaves(t, ctx, els))) return null
  const taken = new Set()
  const names = typeIds.map(tid => (keyLeaves(tid, ctx, els) ?? []).map(vt => {
    const base = snake(ctx.otById.get(vt)?.name)
    let n = base
    for (let i = 2; taken.has(n); i++) n = `${base}_${i}`
    taken.add(n)
    return n
  }))
  const rootNames = a.kind === 'fact' ? names : [names.flat()]
  try {
    const source = sideToTree(ownPattern(a.el, a.kind, ctx, els, rootNames))
    const target = sideToTree(ownPattern(b.el, b.kind, sides.neu.ctx, sides.neu.els, rootNames))
    return { id: `same_${oldId}`, name: a.label, source, target, identity: [oldId, newId] }
  } catch { return null }
}

// The identity rules from a schema to its clone (idMap: old id → new id),
// for every entity type with an identifier and every fact type that does not
// identify one (fully derived ones are left to Fold). { rules, skipped: [name] }.
export function identityRules(state, mapping, idMap) {
  const sides = sidesOf(state, mapping)
  const rules = [], skipped = []
  const ids = [
    ...sides.old.ctx.objectTypes.filter(o => o.kind === 'entity').map(o => o.id),
    ...sides.old.ctx.facts.map(f => f.id),
  ]
  for (const id of ids) {
    const it = elementOf(sides.old, id)
    if (!it) continue
    const r = idMap.has(id) ? identityRuleOf(sides, id, idMap.get(id)) : null
    if (r) rules.push(r)
    else skipped.push(it.label)
  }
  return { rules, skipped }
}

// The mapping with the identity rules of its unchanged pairs written out
// after its own rules (pairs whose elements no longer fit are left out).
// Cached per mapping while the schemas' elements stay the same.
const cache = new WeakMap()
export function withImplicitRules(state, mapping) {
  if (!mapping?.unchanged?.length) return mapping
  const keys = [state.schemas, state.objectTypes, state.facts, state.subtypes, state.constraints]
  const hit = cache.get(mapping)
  if (hit && hit.keys.every((k, i) => k === keys[i])) return hit.out
  const sides = sidesOf(state, mapping)
  const own = new Set(mapping.rules.map(r => r.id))
  const extra = mapping.unchanged.map(([a, b]) => identityRuleOf(sides, a, b, { sameName: false })).filter(r => r && !own.has(r.id))
  const out = { ...mapping, unchanged: [], rules: [...mapping.rules, ...extra] }
  cache.set(mapping, { keys, out })
  return out
}

// The number of elements a mapping carries unchanged.
export const unchangedCount = (mapping) => mapping?.unchanged?.length ?? 0

// The element pair an identity-shaped rule copies, read from its sides
// (each maps one element on its own); null otherwise.
function pairOf(sides, rule) {
  const one = (side, tree) => {
    let a
    try { a = atomicOf(tree, side.ctx, side.els) } catch { a = null }
    return a ? (a.kind === 'fact' ? a.factId : a.typeId) : null
  }
  const a = one(sides.old, rule.source), b = one(sides.neu, rule.target)
  return a && b ? [a, b] : null
}

const same = (x, y) => JSON.stringify(x) === JSON.stringify(y)

// The mapping with each rule that only copies an element of a same-model
// mapping to its twin (as identityRules writes it) turned into an unchanged
// pair. Rules marked `identity` are checked against that pair; with infer,
// unmarked rules too (older files), by the element each side maps. Pairs
// whose elements are gone are dropped. Other mappings are returned as they are.
export function compactMapping(state, mapping, { infer = false } = {}) {
  if (!mapping || !isSameModel(state, mapping)) return mapping
  const sides = sidesOf(state, mapping)
  const pairs = new Map()
  for (const [a, b] of mapping.unchanged ?? []) if (identityRuleOf(sides, a, b, { sameName: false })) pairs.set(a, b)
  const rules = []
  let changed = pairs.size !== (mapping.unchanged?.length ?? 0)
  for (const r of mapping.rules) {
    const pair = r.identity ?? (infer ? pairOf(sides, r) : null)
    const gen = pair && !pairs.has(pair[0]) ? identityRuleOf(sides, pair[0], pair[1]) : null
    if (gen && same(gen.source, r.source) && same(gen.target, r.target)) {
      pairs.set(pair[0], pair[1]); changed = true
      continue
    }
    if (r.identity) { const { identity: _i, ...rest } = r; rules.push(rest); changed = true } else rules.push(r)
  }
  if (!changed) return mapping
  const { unchanged: _u, ...rest } = mapping
  return { ...rest, rules, ...(pairs.size ? { unchanged: [...pairs] } : {}) }
}
