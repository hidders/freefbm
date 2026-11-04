// Equivalence of the two schemas of a mapping: one verdict, built from the
// checks that exist (round trips, constraint accounting, translations).
//
// A mapping between S and T makes them equivalent when
//   1. information of S is kept: every population of S can be recovered from
//      the population of T the mapping builds from it (and the same for T);
//   2. every constraint of S is kept in T (T allows no population whose
//      image in S breaks it), and every constraint of T is kept in S.
//
// (1) is tested per rule, on a generic population: the rule's pattern on one
// side, with labelled nulls for its values, closed under that side's
// constraints (genericPopulation), is run there and back with the whole
// mapping; whatever the pattern names must come back. Elements that no rule
// names (mappingIssues.js, uncoveredElements) are not carried at all.
// (2) is constraint accounting (accounting.js). A constraint kept only with
// the help of formula constraints of the other side counts as kept by a
// complex constraint; one that is lost gets its translation (translate.js),
// a value comparison constraint (graphical) when it has that shape, else a
// formula constraint.
//
// The checks run on populations, so the verdict is "no counterexample
// found", not a proof. Deontic constraints don't restrict populations and are
// listed apart.
//
// equivalenceSteps(state, mapping) yields { phase, done, total } and returns
// { verdict, info: { source, target }, constraints: { source, target },
//   accounting, ms }, see summarise.

import { worldOf, genericPopulation, genericInstance, contains, accountingSteps } from './accounting.js'
import { prepareRun, executeRun } from './runMapping.js'
import { finiteCases } from './fold.js'
import { expandSide, asSide, readingName, SIDES } from './mapping.js'
import { uncoveredElements } from './mappingIssues.js'
import { translateEntry, asValueComparison } from './translate.js'
import { isIndependentType } from '../utils/independence.js'

const other = (side) => (side === 'source' ? 'target' : 'source')
const dirFrom = (side) => (side === 'source' ? 'forward' : 'backward')

// The entity types and stored fact types a pattern names.
function namedBy(w, ruleSide) {
  const s = expandSide(asSide(ruleSide), w.ctx)
  const typeIds = new Set(), factIds = new Set()
  const walk = (vars, atoms) => {
    for (const v of vars ?? []) if (v.typeId) typeIds.add(v.typeId)
    for (const a of atoms ?? []) {
      if (a.t === 'type') typeIds.add(a.typeId)
      if (a.t === 'fact') factIds.add(a.factId)
      if (a.t === 'opt' || a.t === 'not') walk(a.vars, a.atoms)
    }
  }
  walk(s.vars, s.atoms)
  return {
    typeIds: [...typeIds].filter(id => w.ctx.otById.get(id)?.kind === 'entity'),
    factIds: [...factIds].filter(id => !w.ident.entity.has(id) && !w.ident.nested.has(id)),
  }
}

// Whether what one rule's pattern on side X names comes back after a run
// there and back: { ok: true } | { ok: false, reason } | { ok: null, reason }
// (not checked).
function ruleComesBack(wX, rule, X, preps) {
  if (!rule[X]) return { ok: null, reason: 'the rule has no pattern on this side' }
  const g = genericPopulation(wX, [rule[X]])
  if (g.error) return { ok: null, reason: g.error }
  const named = namedBy(wX, rule[X])
  // A labelled null of a type with a few values (a boolean, a list): each
  // of them in turn.
  let start, back
  for (const pops of finiteCases(wX, g.pops)) {
    start = { populations: {}, factPopulations: {} }
    for (const id of named.typeIds) if (pops.populations[id]) start.populations[id] = pops.populations[id]
    for (const id of named.factIds) if (pops.factPopulations[id]) start.factPopulations[id] = pops.factPopulations[id]
    const there = executeRun(preps.there, pops)
    back = executeRun(preps.back, there)
    if (!contains(wX, back, start, back.invented)) break
    start = null
  }
  if (!start) return { ok: true }
  // What did not come back, for the message.
  const missing = []
  for (const id of named.factIds) {
    const part = { populations: {}, factPopulations: { [id]: start.factPopulations[id] ?? [] } }
    if (!contains(wX, back, part, back.invented)) missing.push(readingName(wX.ctx.factById.get(id), wX.ctx))
  }
  for (const id of named.typeIds) {
    const part = { populations: { [id]: start.populations[id] ?? [] }, factPopulations: {} }
    if (!contains(wX, back, part, back.invented)) missing.push(wX.ctx.otById.get(id)?.name ?? 'an entity type')
  }
  return { ok: false, reason: missing.length ? `${missing.slice(0, 4).join(', ')}${missing.length > 4 ? ', …' : ''} do${missing.length === 1 ? 'es' : ''} not come back` : 'what it matches does not come back' }
}

// Whether an instance of entity type typeId on its own (with what the
// schema's constraints force around it) comes back after a run there and
// back: an entity type whose instances need not play any role a rule maps
// is lost even when every fact type it plays in is mapped.
function instanceComesBack(wX, typeId, preps) {
  const g = genericInstance(wX, typeId)
  if (g.error) return { ok: null, reason: g.error }
  for (const pops of finiteCases(wX, g.pops)) {
    const start = { populations: { [typeId]: pops.populations[typeId] ?? [] }, factPopulations: {} }
    const there = executeRun(preps.there, pops)
    const back = executeRun(preps.back, there)
    if (!contains(wX, back, start, back.invented)) return { ok: false, reason: 'an instance that plays no other mapped role does not come back' }
  }
  return { ok: true }
}

// Whether an instance of an entity type may exist without playing any role
// but its identifying ones: only when the type is independent (a table's
// rows always are, see independence.js). Otherwise implicit participation
// makes it play some other role, which the rules' round trips cover.
function mayStandAlone(w, ot) {
  return isIndependentType(ot, w.ctx.schema ? [w.ctx.schema] : [])
}

// Where a kept constraint's keepers live: graphical constraints (or the
// structure, or the rules) only, or some formula constraint of the other side.
function keptBy(x, otherConstraints) {
  const formulas = x.by.filter(b => otherConstraints.get(b.key.split(':')[0])?.constraintType === 'formula')
  return formulas.length ? { complex: true, formulas } : { complex: false }
}

export function* equivalenceSteps(state, mapping) {
  const t0 = Date.now()
  const worlds = { source: worldOf(state, mapping.sourceSchemaId), target: worldOf(state, mapping.targetSchemaId) }
  const preps = { forward: prepareRun(state, mapping, 'forward', { check: false }), backward: prepareRun(state, mapping, 'backward', { check: false }) }

  // 1. Information.
  const info = {}
  const nTotal = 2 * mapping.rules.length + SIDES.reduce((n, X) => n + worlds[X].ctx.objectTypes.filter(o => o.kind === 'entity' && mayStandAlone(worlds[X], o)).length, 0)
  let done = 0
  for (const X of SIDES) {
    const wX = worlds[X]
    const run = { there: preps[dirFrom(X)], back: preps[dirFrom(other(X))] }
    const rules = []
    for (const [k, r] of mapping.rules.entries()) {
      let res
      try { res = ruleComesBack(wX, r, X, run) } catch (err) { res = { ok: null, reason: `the check failed (${err?.message ?? err})` } }
      rules.push({ id: r.id, name: r.name || `Rule ${k + 1}`, ...res })
      yield { phase: 'information', done: ++done, total: nTotal }
    }
    const types = []
    for (const ot of wX.ctx.objectTypes) {
      if (ot.kind !== 'entity' || !mayStandAlone(wX, ot)) continue
      let res
      try { res = instanceComesBack(wX, ot.id, run) } catch (err) { res = { ok: null, reason: `the check failed (${err?.message ?? err})` } }
      types.push({ id: ot.id, name: ot.name, ...res })
      yield { phase: 'information', done: ++done, total: nTotal }
    }
    const u = uncoveredElements(state, mapping, X, wX.ctx)
    const unmapped = [
      ...u.typeIds.map(id => ({ id, kind: 'type', name: wX.ctx.otById.get(id)?.name ?? '?' })),
      ...u.factIds.map(id => ({ id, kind: 'fact', name: readingName(wX.ctx.factById.get(id), wX.ctx) })),
    ]
    const unmappedIds = new Set(unmapped.map(x => x.id))
    const checked = [...rules, ...types.filter(t => !unmappedIds.has(t.id))]
    info[X] = { rules, types, unmapped,
      lost: checked.filter(r => r.ok === false), unchecked: checked.filter(r => r.ok == null) }
  }

  // 2. Constraints.
  const steps = accountingSteps(state, mapping)
  let accounting
  for (;;) {
    const r = steps.next()
    if (r.done) { accounting = r.value; break }
    yield { phase: 'constraints', ...r.value }
  }
  const constraints = {}
  for (const X of SIDES) {
    const otherCs = new Map(worlds[other(X)].ctx.constraints.map(c => [c.id, c]))
    const out = { graphical: [], complex: [], lost: [], unknown: [], deontic: [] }
    for (const x of accounting.sides[X]) {
      if (x.deontic) { out.deontic.push(x); continue }
      if (x.status === 'native' || x.status === 'implied') {
        const k = keptBy(x, otherCs)
        if (k.complex) out.complex.push({ ...x, formulas: k.formulas })
        else out.graphical.push(x)
      } else if (x.status === 'lost') {
        // What adding it to the other side would take.
        let fix
        try {
          const t = translateEntry(state, mapping, x.entry, X)
          fix = t.error ? { kind: 'none', reason: t.error } : asValueComparison(t.rule) ? { kind: 'graphical' } : { kind: 'formula' }
        } catch (err) { fix = { kind: 'none', reason: String(err?.message ?? err) } }
        out.lost.push({ ...x, fix })
      } else out.unknown.push(x)
    }
    constraints[X] = out
  }
  return { ...summarise(info, constraints), info, constraints, accounting, ms: Date.now() - t0, mappingId: mapping.id }
}

// The verdict: 'equivalent' (nothing failed, nothing undecided), 'undecided'
// (nothing failed, some checks undecided) or 'not' (something failed).
export function summarise(info, constraints) {
  let failed = 0, undecided = 0, formulas = 0
  for (const X of SIDES) {
    failed += info[X].lost.length + info[X].unmapped.length + constraints[X].lost.length
    undecided += info[X].unchecked.length + constraints[X].unknown.length
    formulas += constraints[X].complex.length
  }
  const verdict = failed ? 'not' : undecided ? 'undecided' : 'equivalent'
  return { verdict, failed, undecided, formulas }
}

export function equivalence(state, mapping) {
  const steps = equivalenceSteps(state, mapping)
  for (;;) { const r = steps.next(); if (r.done) return r.value }
}
