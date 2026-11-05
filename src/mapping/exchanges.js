// Exchanges (data exchange plan, step 3): chains of two-way mappings and
// view mappings that carry a population from the first schema to the last.
//
//   exchange: { id, name, steps: [{ mappingId, direction: 'forward' | 'backward' }] }
//
// A step is a two-way mapping (mapping.js), run either way, or a view mapping
// (views.js), forward only. Each step's source is the schema the step before
// ended in. A typical chain: the supplier's tables → their ORM2 schema
// (backward through the mapping Guess made), the supplier's views → the
// consumer's ORM2 schema, → the consumer's tables (forward through the
// mapping Generate made, or backward through one Guess made).
//
// Running an exchange runs each step on the population the step before left
// (runMapping or runView, then withRunApplied), and checks every schema it
// fills against that schema's constraints (resultIssues). Only the result
// of the last step is put into the file (store.applyExchange); the ones in
// between are shown, not kept.

import { uid, scopeToSchema } from '../store/storeHelpers.js'
import { runMapping, withRunApplied } from './runMapping.js'
import { runView } from './views.js'
import { relationalView } from '../relational/relationalView.js'
import { rmViolations } from '../relational/rmText.js'
import { makeContext, readingText } from '../logic/constraintFormulas.js'
import { computePopulationIssues } from '../utils/populationValidation.js'
import { withDerivedPopulations, semiDerivedPopulationIssues, derivedFactPopulationIssues, formulaConstraintPopulationIssues } from '../logic/derivedPopulation.js'

export const mkExchange = (name, steps = []) => ({ id: uid(), name, steps })

export function loadExchanges(raw, mappingIds) {
  if (!Array.isArray(raw)) return []
  return raw.filter(x => x && typeof x === 'object').map(x => ({
    id: String(x.id ?? uid()), name: String(x.name ?? 'Exchange'),
    steps: (Array.isArray(x.steps) ? x.steps : [])
      .filter(s => s && mappingIds.has(s.mappingId))
      .map(s => ({ mappingId: s.mappingId, direction: s.direction === 'backward' ? 'backward' : 'forward' })),
  }))
}

// The mapping or view of a step: { m, isView } or null.
export function stepMapping(state, step) {
  const m = (state.mappings ?? []).find(x => x.id === step.mappingId)
  if (m) return { m, isView: false }
  const v = (state.views ?? []).find(x => x.id === step.mappingId)
  return v ? { m: v, isView: true } : null
}

// The schemas a step goes from and to.
export function stepEnds(state, step) {
  const sm = stepMapping(state, step)
  if (!sm) return null
  const back = !sm.isView && step.direction === 'backward'
  return { from: back ? sm.m.targetSchemaId : sm.m.sourceSchemaId, to: back ? sm.m.sourceSchemaId : sm.m.targetSchemaId }
}

// The schemas of the chain in order (first, then each step's end), as far
// as the steps exist.
export function exchangeSchemas(state, ex) {
  const out = []
  for (const s of ex.steps) {
    const e = stepEnds(state, s)
    if (!e) break
    if (!out.length) out.push(e.from)
    out.push(e.to)
  }
  return out
}

// Problems with the chain: [{ step, message }] (step: its index, or null).
export function checkExchange(state, ex) {
  const out = []
  const name = (id) => state.schemas?.find(s => s.id === id)?.name ?? 'a deleted schema'
  if (!ex.steps.length) out.push({ step: null, message: 'The exchange has no steps yet' })
  let at = null
  ex.steps.forEach((s, i) => {
    const sm = stepMapping(state, s)
    if (!sm) { out.push({ step: i, message: 'Its mapping was deleted' }); at = null; return }
    if (sm.isView && s.direction === 'backward') out.push({ step: i, message: `${sm.m.name} is a view: it only goes forward` })
    const e = stepEnds(state, s)
    if (at && e.from !== at) out.push({ step: i, message: `${sm.m.name} starts at ${name(e.from)}, but the step before ends at ${name(at)}` })
    at = e.to
  })
  const seen = exchangeSchemas(state, ex)
  if (new Set(seen).size < seen.length) out.push({ step: null, message: 'The chain passes a schema twice; only the last population there is kept' })
  return out
}

// What the steps a schema can take from here: [{ mappingId, direction, to }],
// for adding a step after the chain's end (or any first step when from is null).
export function nextSteps(state, from) {
  const out = []
  for (const m of state.mappings ?? []) {
    if (!from || m.sourceSchemaId === from) out.push({ mappingId: m.id, direction: 'forward', name: m.name, isView: false, to: m.targetSchemaId })
    if (!from || m.targetSchemaId === from) out.push({ mappingId: m.id, direction: 'backward', name: m.name, isView: false, to: m.sourceSchemaId })
  }
  for (const v of state.views ?? []) {
    if (!from || v.sourceSchemaId === from) out.push({ mappingId: v.id, direction: 'forward', name: v.name, isView: true, to: v.targetSchemaId })
  }
  return out
}

// The population issues of one schema (as the Validation panel computes
// them), with derived elements computed.
export function resultIssues(state, schemaId) {
  const s = scopeToSchema(state, schemaId)
  return [
    ...computePopulationIssues(withDerivedPopulations(s)),
    ...semiDerivedPopulationIssues(s),
    ...derivedFactPopulationIssues(s),
    ...formulaConstraintPopulationIssues(s),
  ]
}

// Values a run invented (⟨…⟩) for generated columns of a relational schema:
// numbered 1, 2, … per value, the same number for the same value
// everywhere. Returns { populations, factPopulations } or {}.
export function numberInvented(st, schemaId) {
  const gen = new Set(st.facts.filter(f => f.schemaId === schemaId).flatMap(f => f.roles.filter(r => r.sqlGenerated).map(r => r.objectTypeId)))
  if (!gen.size) return {}
  const ids = new Set([...st.objectTypes, ...st.facts].filter(x => x.schemaId === schemaId).map(x => x.id))
  const num = new Map()
  const map = (x) => {
    if (typeof x !== 'string' || !x.startsWith('⟨')) return Array.isArray(x) ? x.map(map) : x
    if (!num.has(x)) num.set(x, String(num.size + 1))
    return num.get(x)
  }
  const walk = (obj) => Object.fromEntries(Object.entries(obj ?? {}).map(([k, v]) => [k, ids.has(k) && Array.isArray(v) ? v.map(map) : v]))
  return { populations: walk(st.populations), factPopulations: walk(st.factPopulations) }
}

// The population of one schema in a state, as a run (for withRunApplied).
function runOf(state, schemaId) {
  const ids = new Set([...state.objectTypes, ...state.facts].filter(x => x.schemaId === schemaId).map(x => x.id))
  const pick = (obj) => Object.fromEntries(Object.entries(obj ?? {}).filter(([k]) => ids.has(k)))
  return { schemaId, populations: pick(state.populations), factPopulations: pick(state.factPopulations) }
}

// Runs the chain. Returns { ok, problems, steps: [{ index, name, isView,
// direction, from, to, counts, log, rules, issues, error? }], result } where
// result is the last step's run (the population of the last schema), ready
// for withRunApplied, or null when a step failed.
export function runExchange(state, ex, { check = true } = {}) {
  const problems = checkExchange(state, ex)
  const steps = []
  if (problems.length && problems.some(p => !/passes a schema twice/.test(p.message))) return { ok: false, problems, steps, result: null }
  let s = state
  let last = null
  for (let i = 0; i < ex.steps.length; i++) {
    const st = ex.steps[i]
    const { m, isView } = stepMapping(s, st)
    const ends = stepEnds(s, st)
    const out = { index: i, name: m.name, isView, direction: isView ? 'forward' : st.direction, from: ends.from, to: ends.to }
    try {
      const run = isView ? runView(s, m) : runMapping(s, m, st.direction)
      s = { ...s, ...withRunApplied(s, run) }
      if (s.schemas?.find(x => x.id === ends.to)?.profile === 'relational') s = { ...s, ...numberInvented(s, ends.to) }
      out.counts = run.counts
      out.log = run.log
      out.rules = run.rules
      out.issues = check ? resultIssues(s, ends.to) : []
      last = runOf(s, ends.to)
    } catch (err) {
      out.error = err?.message ?? String(err)
      steps.push(out)
      return { ok: false, problems, steps, result: null }
    }
    steps.push(out)
  }
  return { ok: true, problems, steps, result: last }
}

// The issues as lines for a report: [{ text, elementId }], each named by
// the element it is about; on a relational schema in table terms
// (rmText.js: "The album row 1 has no title.").
export function issueLines(state, issues, schemaId = null) {
  const otById = new Map((state.objectTypes ?? []).map(o => [o.id, o]))
  const factById = new Map((state.facts ?? []).map(f => [f.id, f]))
  const cById = new Map((state.constraints ?? []).map(c => [c.id, c]))
  const ctx = makeContext(state)
  const nameOf = (id) => {
    const o = otById.get(id)
    if (o) return o.name
    const f = factById.get(id)
    if (f) return f.name || f.objectifiedName || readingText(f, ctx) || null
    const c = cById.get(id)
    return c?.name || null
  }
  const show = (v) => (Array.isArray(v) ? `(${v.map(show).join(', ')})` : String(v))
  const rm = schemaId && state.schemas?.find(x => x.id === schemaId)?.profile === 'relational' ? relationalView(state, schemaId) : null
  return issues.map(i => {
    const elementId = i.elementId ?? i.factId ?? null
    const group = `${i.kind}|${i.factId ?? i.constraintId ?? i.elementId}`
    if (rm) {
      const m = [...rmViolations(rm, [i]).values()].flat()[0]
      if (m) return { text: m, elementId, group }
    }
    if (i.kind === 'mandatoryRoleNotPlayed' && factById.has(i.factId) && otById.has(i.otId ?? i.elementId)) {
      const f = factById.get(i.factId)
      return { text: `${otById.get(i.otId ?? i.elementId).name} ${show(i.value)} does not play its mandatory role in “${readingText(f, ctx)}”`, elementId, group }
    }
    const n = nameOf(i.elementId) ?? nameOf(i.factId) ?? nameOf(i.constraintId)
    return { text: n ? `${n}: ${i.message}` : i.message, elementId, group }
  })
}

// Lines of the same kind about the same element, together:
// [{ text (the first), more (how many others) }].
export function groupedLines(lines) {
  const by = new Map()
  for (const l of lines) {
    const g = by.get(l.group)
    if (g) g.more++
    else by.set(l.group, { text: l.text, more: 0 })
  }
  return [...by.values()]
}
