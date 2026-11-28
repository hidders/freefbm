// Validation of mappings after free edits of their schemas (workbench step 11).
//
// A mapping's rules name elements of its two schemas by id. Editing either
// schema by hand can break them: a fact type, column or table that is
// deleted or moved, a role added or removed, a role player or column type
// changed, a key changed so that a rule is no longer key-safe. checkRule
// finds all of these; here they are collected for the Validation panel
// (categories 'mappingRules' and 'mappingCoverage'), each issue naming its
// mapping and rule so that a click opens the rule in the rule editor.
//
// Coverage: an element of either schema that no rule of a mapping names is
// not carried over by it (a new column, a new fact type). It is listed as a
// warning against the element itself, for mappings that have rules. So is a
// role that the rules name only with constants (a boolean column read only as
// col ≈ true) while it may hold other values: a population with one of those
// is carried over as if the fact were not there.

import { checkRule, sideContext, sideSchemaId, expandSide, asSide, SIDES } from './mapping.js'
import { identifyingFactIds } from '../utils/refMode.js'
import { withImplicitRules } from './sameModel.js'
import { valueKindName } from '../utils/datatypeValues.js'

const ctxsOf = (state, mapping, cache) => {
  const get = (id) => {
    if (!cache.has(id)) cache.set(id, sideContext(state, id))
    return cache.get(id)
  }
  return { source: get(mapping.sourceSchemaId), target: get(mapping.targetSchemaId) }
}

// Issues of every rule of every mapping: [{ mapping, rule, ruleIndex, severity, side, text }].
export function mappingRuleIssues(state, cache = new Map()) {
  const out = []
  for (const m of state.mappings ?? []) {
    const ctxs = ctxsOf(state, m, cache)
    m.rules.forEach((r, k) => {
      let issues
      try { issues = checkRule(r, m, state, ctxs) } catch (err) {
        issues = [{ severity: 'error', side: null, text: `the rule could not be checked (${err?.message ?? err})` }]
      }
      for (const i of issues) out.push({ mapping: m, rule: r, ruleIndex: k, ...i })
    })
  }
  return out
}

// The values a role may hold, when they are few: its value range of single
// values, else its value type's, else true and false for a boolean; null
// when there are more.
function fewValues(vt, role) {
  if (!vt || vt.kind !== 'value') return null
  const r = role?.valueRange?.length ? role.valueRange : vt.valueRange ?? []
  if (r.length) return r.length <= 16 && r.every(x => x.type === 'single') ? r.map(x => String(x.value)) : null
  const a = vt.datatypeAssignment
  if (['boolean', 'yesNo'].includes(valueKindName(a)) || /^bool/i.test(a?.datatypeId ?? '')) return ['true', 'false']
  return null
}

// Why a role named only with constants loses information, as a phrase.
export function valuesText(v) {
  const q = (xs) => xs.map(x => `'${x}'`).join(', ')
  const named = `the rules read only ${v.named.length === 1 ? 'the value' : 'the values'} ${q(v.named)}`
  return v.missing ? `${named}, so ${q(v.missing)} would be carried over as if the fact were not there`
    : `${named}, so any other value would be carried over as if the fact were not there`
}

// The elements of one side's schema that no rule of the mapping names:
// { typeIds, factIds, values }, values: [{ factId, roleIndex, named: [text],
// missing: [text] | null }] for roles that the rules name only with constants
// and that may hold other values (missing null: any other value). Value types are left out (they come with the fact
// types that use them), and so are fully derived fact types (their rule
// gives them) and identifying fact types of a named entity type.
export function uncoveredElements(state, mapping, side, ctx = sideContext(state, sideSchemaId(mapping, side))) {
  mapping = withImplicitRules(state, mapping)
  const typeIds = new Set(), factIds = new Set()
  const pinned = new Map(), free = new Set()   // 'factId:i' → constants; roles some rule names with a variable
  for (const r of mapping.rules) {
    let s
    try { s = expandSide(asSide(r[side]), ctx) } catch { continue }
    for (const v of s.vars ?? []) if (v.typeId) typeIds.add(v.typeId)
    const walk = (vars, atoms) => {
      for (const v of vars ?? []) if (v.typeId) typeIds.add(v.typeId)
      for (const a of atoms ?? []) {
        if (a.t === 'type') typeIds.add(a.typeId)
        if (a.t === 'fact') factIds.add(a.factId)
        if (a.t === 'opt' || a.t === 'not') walk(a.vars, a.atoms)
      }
    }
    walk(s.vars, s.atoms)
    // Roles named with a constant (top level and optional parts: what a
    // match covers).
    const cover = (atoms, consts) => {
      const here = new Map(consts)
      for (const a of atoms ?? []) if (a.t === 'const') here.set(a.v, [...(here.get(a.v) ?? []), a.text])
      for (const a of atoms ?? []) {
        if (a.t === 'fact') a.args.forEach((v, i) => {
          const k = `${a.factId}:${i}`
          if (here.has(v)) { if (!pinned.has(k)) pinned.set(k, new Set()); for (const c of here.get(v)) pinned.get(k).add(c) } else free.add(k)
        })
        if (a.t === 'opt') cover(a.atoms, here)
      }
    }
    cover(s.atoms, new Map())
  }
  // Types named through the fact types they play in.
  for (const fid of factIds) for (const r of ctx.factById.get(fid)?.roles ?? []) typeIds.add(r.objectTypeId)
  const ident = identifyingFactIds(ctx.facts, ctx.objectTypes, ctx.constraints)
  const identifies = new Map()   // identifying fact id → the entity type ids it identifies
  for (const [otId, rm] of ident.refModes) identifies.set(rm.factId, [...(identifies.get(rm.factId) ?? []), otId])
  for (const [otId, cp] of ident.compositePIs) for (const fid of [cp.factId, ...(cp.factIds ?? [])].filter(Boolean)) identifies.set(fid, [...(identifies.get(fid) ?? []), otId])
  const out = { typeIds: [], factIds: [], values: [] }
  for (const [k, named] of pinned) {
    if (free.has(k)) continue
    const [fid, i] = [k.slice(0, k.lastIndexOf(':')), Number(k.slice(k.lastIndexOf(':') + 1))]
    const f = ctx.factById.get(fid)
    const role = f?.roles[i]
    const vals = fewValues(ctx.otById.get(role?.objectTypeId), role)
    const bool = vals?.length === 2 && vals.includes('true') && vals.includes('false')
    const norm = (v) => { const t = String(v).trim().toLowerCase(); return bool ? ({ yes: 'true', 1: 'true', no: 'false', 0: 'false' }[t] ?? t) : t }
    const have = new Set([...named].map(norm))
    const missing = vals ? vals.filter(v => !have.has(norm(v))) : null
    if (!missing || missing.length) out.values.push({ factId: fid, roleIndex: i, named: [...named], missing })
  }
  for (const ot of ctx.objectTypes) if (ot.kind === 'entity' && !typeIds.has(ot.id)) out.typeIds.push(ot.id)
  for (const f of ctx.facts) {
    if (factIds.has(f.id) || f.derivation === 'derived') continue
    if ((identifies.get(f.id) ?? []).some(id => typeIds.has(id))) continue
    out.factIds.push(f.id)
  }
  return out
}

// Coverage of every mapping with rules (or unchanged elements, sameModel.js), per element: [{ mapping, side, elementId, kind: 'type' | 'fact' }].
export function mappingCoverageIssues(state, cache = new Map()) {
  const out = []
  for (const m of state.mappings ?? []) {
    if (!m.rules.length && !m.unchanged?.length) continue
    const ctxs = ctxsOf(state, m, cache)
    for (const side of SIDES) {
      const u = uncoveredElements(state, m, side, ctxs[side])
      for (const id of u.typeIds) out.push({ mapping: m, side, elementId: id, kind: 'type' })
      for (const id of u.factIds) out.push({ mapping: m, side, elementId: id, kind: 'fact' })
      for (const v of u.values) out.push({ mapping: m, side, elementId: v.factId, kind: 'values', ...v })
    }
  }
  return out
}
