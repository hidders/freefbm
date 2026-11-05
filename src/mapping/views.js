// View mappings (one-way mappings): the elements of a target schema defined
// by queries over a source schema (data exchange plan, step 1).
//
// A two-way mapping (mapping.js) relates two schemas by rules φ ⟺ ψ that can
// be run either way. A view mapping only goes forward: each rule defines one
// element of the target schema, as a derivation rule whose atoms and variable
// types come from the source schema (and may also use the target's own
// elements). It is the GAV form of a schema mapping, so the target's
// population is the views evaluated over the source's, and views compose by
// substitution.
//
//   view: { id, name, sourceSchemaId, targetSchemaId, rules: [ViewRule] }
//   ViewRule: { id, name, head: { typeId } | { factId }, rule }
//
// The rule has the format of the head's own derivation rules:
//   - an entity type without supertypes: through its reference scheme, the
//     free variables are its reference values ref:0…, and each answer is an
//     instance (derivationRule.js);
//   - a subtype: the subject ranges over its supertypes (derivationRule.js);
//   - a fact type: { body, extraVars, terms }, one variable per role, roles
//     selected or computed from a term (factDerivation.js). A computed role
//     whose player is an entity type with a reference mode makes the instance
//     with that value, which is how a fact of the target gets its objects
//     from values of the source.
// Variables of different schemas meet through their data values (≈): an
// entity with a reference mode has the value it is identified by.
//
// The rules live in the view mapping, not on the target's elements, so the
// target schema stays as its owner wrote it and may have several views into
// it. To evaluate, the rules are put on the target's elements as derived
// rules of a copy of the two schemas (viewState), and the evaluator of
// derived populations (derivedPopulation.js) does the rest.

import { uid } from '../store/storeHelpers.js'
import { hole, checkRule as checkTypeRule, whyNotDerivableType, upgradeRule, derivationEntry } from '../logic/derivationRule.js'
import { checkFactRule, emptyFactRule, factDerivationEntries } from '../logic/factDerivation.js'
import { makeContext, readingText } from '../logic/constraintFormulas.js'
import { withDerivedPopulations } from '../logic/derivedPopulation.js'
import { identifyingFactIds } from '../utils/refMode.js'

export const mkView = (name, sourceSchemaId, targetSchemaId) =>
  ({ id: uid(), name, sourceSchemaId, targetSchemaId, rules: [] })

// A rule for a head, with the empty rule of the head's kind.
export const mkViewRule = (head) =>
  ({ id: uid(), name: '', head, rule: head.factId ? emptyFactRule() : hole() })

export const headId = (rule) => rule?.head?.factId ?? rule?.head?.typeId ?? null

// Views of a file, keeping those whose schemas exist.
export function loadViews(raw, schemaIds) {
  if (!Array.isArray(raw)) return []
  return raw.filter(v => v && typeof v === 'object' && schemaIds.has(v.sourceSchemaId) && schemaIds.has(v.targetSchemaId))
    .map(v => ({
      id: String(v.id ?? uid()), name: String(v.name ?? 'View'),
      sourceSchemaId: v.sourceSchemaId, targetSchemaId: v.targetSchemaId,
      rules: (Array.isArray(v.rules) ? v.rules : [])
        .filter(r => r && typeof r === 'object' && r.head && (typeof r.head.typeId === 'string' || typeof r.head.factId === 'string'))
        .map(r => ({
          id: String(r.id ?? uid()), name: String(r.name ?? ''),
          head: r.head.factId ? { factId: r.head.factId } : { typeId: r.head.typeId },
          rule: r.rule ?? (r.head.factId ? emptyFactRule() : hole()),
        })),
    }))
}

// ── The two schemas, with the views as derivation rules ─────────────────────

const SCOPED = ['objectTypes', 'facts', 'subtypes', 'constraints']

// The state cut down to the view's two schemas, with every rule's head
// derived by it (a rule whose head is gone or in another schema is left
// out) and the stored population of the target left out: the target has
// what the views give, and nothing else. Cached per state and view.
const viewStates = new WeakMap()
export function viewState(state, view) {
  let byView = viewStates.get(state)
  if (!byView) { byView = new WeakMap(); viewStates.set(state, byView) }
  if (byView.has(view)) return byView.get(view)
  const ids = new Set([view.sourceSchemaId, view.targetSchemaId])
  const out = { ...state }
  for (const k of SCOPED) out[k] = (state[k] ?? []).filter(x => ids.has(x.schemaId))
  const heads = new Map()
  for (const r of view.rules ?? []) {
    const id = headId(r)
    if (id && !heads.has(id)) heads.set(id, r)
  }
  const inTarget = (x) => x.schemaId === view.targetSchemaId
  out.objectTypes = out.objectTypes.map(o => (inTarget(o) && heads.has(o.id) && heads.get(o.id).head.typeId
    ? { ...o, derivation: 'derived', derivationRule: heads.get(o.id).rule } : o))
  out.facts = out.facts.map(f => (inTarget(f) && heads.has(f.id) && heads.get(f.id).head.factId
    ? { ...f, derivation: 'derived', derivationRule: heads.get(f.id).rule } : f))
  // The target starts empty.
  const target = new Set([...out.objectTypes, ...out.facts].filter(inTarget).map(x => x.id))
  const drop = (obj) => Object.fromEntries(Object.entries(obj ?? {}).filter(([k]) => !target.has(k)))
  out.populations = drop(state.populations)
  out.factPopulations = drop(state.factPopulations)
  out.subtypeMappings = Object.fromEntries(Object.entries(state.subtypeMappings ?? {})
    .filter(([edgeId]) => !(state.subtypes ?? []).some(s => s.id === edgeId && inTarget(s))))
  out.nestedEntityMappings = drop(state.nestedEntityMappings)
  // The target's values come from the source: a variable of a target value
  // type is bound by ≈ to a value (derivedPopulation.js).
  out.openTypes = new Set(out.objectTypes.filter(o => inTarget(o) && o.kind === 'value').map(o => o.id))
  byView.set(view, out)
  return out
}

// ── Checks ──────────────────────────────────────────────────────────────────

// The element ids a rule names (atoms, variable types, extra variables).
function namedIds(rule) {
  const out = new Set()
  const walk = (n) => {
    if (!n || typeof n !== 'object') return
    if (Array.isArray(n)) { n.forEach(walk); return }
    if (n.t === 'fact' && n.factId) out.add(String(n.factId).split('_il_')[0])
    if (n.t === 'type' && n.typeId) out.add(n.typeId)
    if (n.v?.typeId) out.add(n.v.typeId)
    if (n.t === 'agg' || n.t === 'tc') for (const v of n.vars ?? []) if (v.typeId) out.add(v.typeId)
    for (const [k, c] of Object.entries(n)) if (k !== 'v' && k !== 'vars') walk(c)
  }
  walk(rule)
  return out
}

// What the head of a rule is: { element, kind: 'type' | 'fact' } or { error }.
function headOf(state, view, rule) {
  const id = headId(rule)
  const el = rule.head?.factId
    ? (state.facts ?? []).find(f => f.id === id)
    : (state.objectTypes ?? []).find(o => o.id === id)
  if (!el) return { error: 'The element this rule defines no longer exists' }
  if (el.schemaId !== view.targetSchemaId) return { error: `${elementName(el, state)} is not in the target schema` }
  return { element: el, kind: rule.head.factId ? 'fact' : 'type' }
}

// The name of an element, for messages.
export function elementName(el, state, ctx = null) {
  if (!el) return 'a deleted element'
  if (el.name) return el.name
  if (!el.roles) return 'an unnamed type'
  return readingText(el, ctx ?? makeContext(state)) || 'an unnamed fact type'
}

// Problems with one rule: [{ path, severity, message }].
export function checkViewRule(state, view, rule, draft = rule.rule) {
  const h = headOf(state, view, rule)
  if (h.error) return [{ path: [], severity: 'error', message: h.error }]
  const vs = viewState(state, view)
  const out = []
  const first = (view.rules ?? []).find(r => headId(r) === headId(rule))
  if (first && first.id !== rule.id) out.push({ path: [], severity: 'error', message: `${elementName(h.element, state)} already has a rule in this view; only the first one counts` })
  // The rule may name elements of the two schemas only.
  const schemaOf = new Map([...(state.objectTypes ?? []), ...(state.facts ?? [])].map(x => [x.id, x.schemaId]))
  for (const id of namedIds(draft)) {
    const sid = schemaOf.get(id)
    if (sid && sid !== view.sourceSchemaId && sid !== view.targetSchemaId) {
      const el = (state.objectTypes ?? []).find(o => o.id === id) ?? (state.facts ?? []).find(f => f.id === id)
      const sname = state.schemas?.find(s => s.id === sid)?.name ?? 'another schema'
      out.push({ path: [], severity: 'error', message: `${elementName(el, state)} is in ${sname}, which is neither the source nor the target of this view` })
    }
  }
  const ctx = makeContext(vs)
  if (h.kind === 'type') {
    const ot = vs.objectTypes.find(o => o.id === h.element.id)
    if (ot.kind !== 'entity') return [{ path: [], severity: 'error', message: `${ot.name} is a value type: its values come with the fact types that use them` }]
    const why = whyNotDerivableType(ot.id, vs)
    if (why) return [...out, { path: [], severity: 'error', message: why }]
    const s = { ...vs, objectTypes: vs.objectTypes.map(o => (o.id === ot.id ? { ...o, derivationRule: draft } : o)) }
    out.push(...checkTypeRule(draft, ot.id, s, ctx))
  } else {
    const f = vs.facts.find(x => x.id === h.element.id)
    const ident = identifyingFactIds(vs.facts, vs.objectTypes, vs.constraints)
    const identifies = [...ident.refModes.values()].some(rm => rm.factId === f.id)
      || [...ident.compositePIs.values()].some(cp => cp.factId === f.id || (cp.factIds ?? []).includes(f.id))
    if (identifies) return [...out, { path: [], severity: 'error', message: `${elementName(f, state)} identifies its entity type: its facts come with that type's rule` }]
    const patched = { ...f, derivation: 'derived', derivationRule: draft }
    const s = { ...vs, facts: vs.facts.map(x => (x.id === f.id ? patched : x)) }
    out.push(...checkFactRule(patched, s, ctx, undefined, draft))
  }
  return out
}

// The rule's entries for the Constraints tab and the Mappings tab: formulas
// (and sentences) of the head as derived by it.
export function viewRuleEntries(state, view, rule) {
  const h = headOf(state, view, rule)
  if (h.error) return []
  const vs = viewState(state, view)
  const ctx = makeContext(vs)
  try {
    if (h.kind === 'type') {
      const ot = vs.objectTypes.find(o => o.id === h.element.id)
      return [derivationEntry({ ...ot, derivation: 'derived', derivationRule: upgradeRule(rule.rule) }, vs, ctx)]
    }
    const f = vs.facts.find(x => x.id === h.element.id)
    return factDerivationEntries({ ...f, derivation: 'derived', derivationRule: rule.rule }, vs, ctx, rule.rule)
  } catch {
    return []
  }
}

// The elements of the target that no rule defines, with a severity: a fact
// type with a mandatory role is an error (its players' instances would
// violate it), the others warnings. Value types, identifying fact types, and
// elements the target derives itself are left out. [{ elementId, kind, severity }]
export function viewCoverage(state, view) {
  const defined = new Set((view.rules ?? []).map(headId))
  const ots = (state.objectTypes ?? []).filter(o => o.schemaId === view.targetSchemaId)
  const facts = (state.facts ?? []).filter(f => f.schemaId === view.targetSchemaId)
  const ident = identifyingFactIds(facts, ots, (state.constraints ?? []).filter(c => c.schemaId === view.targetSchemaId))
  const identIds = new Set([...[...ident.refModes.values()].map(rm => rm.factId),
    ...[...ident.compositePIs.values()].flatMap(cp => [cp.factId, ...(cp.factIds ?? [])])].filter(Boolean))
  const out = []
  for (const o of ots) {
    if (o.kind !== 'entity' || defined.has(o.id) || o.derivation === 'derived') continue
    out.push({ elementId: o.id, kind: 'type', severity: 'warning' })
  }
  for (const f of facts) {
    if (defined.has(f.id) || identIds.has(f.id) || f.derivation === 'derived') continue
    out.push({ elementId: f.id, kind: 'fact', severity: (f.roles ?? []).some(r => r.mandatory) ? 'error' : 'warning' })
  }
  return out
}

// ── Running ─────────────────────────────────────────────────────────────────

// Evaluates the view over the source's population.
//   { schemaId (the target), populations, factPopulations (the target's),
//     rules: [{ id, name, n, error? }], counts: [{ id, name, kind, n }], log }
export function runView(state, view) {
  const vs = viewState(state, view)
  const ctx = makeContext(vs)
  const log = []
  const rules = []
  const heads = new Map()   // element id → index in rules
  for (const r of view.rules ?? []) {
    const id = headId(r)
    const h = headOf(state, view, r)
    const name = h.element ? elementName(h.element, state, ctx) : '(deleted)'
    if (h.error || heads.has(id)) { rules.push({ id: r.id, name, n: 0, error: h.error ?? 'a second rule for the same element' }); continue }
    const errs = checkViewRule(state, view, r).filter(i => i.severity === 'error')
    rules.push({ id: r.id, name, n: 0, kind: h.kind, ...(errs.length ? { error: errs[0].message } : {}) })
    if (!errs.length) heads.set(id, rules.length - 1)
  }
  const report = { errors: new Map(), failures: new Map() }
  const done = withDerivedPopulations(vs, report)
  for (const [id, k] of heads) {
    const r = rules[k]
    if (report.errors.has(id)) { r.error = report.errors.get(id); continue }
    r.n = ((r.kind === 'fact' ? done.factPopulations : done.populations)?.[id] ?? []).length
    for (const fl of report.failures.get(id) ?? []) log.push({ level: 'warning', text: `${r.name}: ${fl.message}` })
  }
  for (const r of rules) if (r.error) log.push({ level: 'error', text: `${r.name}: ${r.error}` })
  const target = [...vs.objectTypes, ...vs.facts].filter(x => x.schemaId === view.targetSchemaId)
  const factIds = new Set(vs.facts.map(f => f.id))
  const populations = {}, factPopulations = {}, counts = []
  for (const x of target) {
    const isFact = factIds.has(x.id)
    const p = (isFact ? done.factPopulations : done.populations)?.[x.id]
    if (!p?.length) continue
    ;(isFact ? factPopulations : populations)[x.id] = p
    counts.push({ id: x.id, name: elementName(x, state, ctx), kind: isFact ? 'fact' : x.kind === 'value' ? 'value' : 'entity', n: p.length })
  }
  for (const c of viewCoverage(state, view)) {
    if (c.severity !== 'error') continue
    const el = target.find(x => x.id === c.elementId)
    log.push({ level: 'warning', text: `${elementName(el, state, ctx)} has no rule, so it is empty, but it has a mandatory role` })
  }
  return { schemaId: view.targetSchemaId, populations, factPopulations, rules, counts, log }
}
