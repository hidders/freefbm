// Checks that population validation checks every constraint: for each
// constraint entry of the Constraints tab (formalise, whole schema, plus the
// implicit participation entries) the formula is evaluated on a population
// (the evaluator's closedFormula), and population validation must report an
// issue about that constraint exactly when the formula is false.
//
//   node scripts/population-coverage-check.mjs [--runs N] [--seed S] [--verbose] [file.ffbm …]
//
// Without files it checks the sample (src/data/sample.ffbm) and its variants
// (scripts/coverage-fixtures.mjs: constraints of every kind and shape added
// to the sample). Each schema is checked on its own population and on N
// mutated ones (default 300): tuples and instances removed, added, duplicated
// or changed, after which the structural issues (dangling references, values
// missing from a supertype or reference value type, datatype mismatches …)
// are repaired by removing what they name, so that only constraints can be
// broken.
//
// Reported, with exit code 1:
//   unchecked    an entry with a formula that no issue kind stands for;
//   missed       the formula is false and validation reports nothing about it;
//   false alarm  validation reports an issue about it and the formula holds;
//   modality     an issue of a deontic constraint not marked deontic, or the
//                other way round.
// An unknown issue kind (neither about a constraint nor structural) is
// reported too, so that a new check is placed on one side or the other.

import { createServer } from 'vite'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const opt = (name, dflt) => { const i = args.indexOf(name); if (i < 0) return dflt; const v = args[i + 1]; args.splice(i, 2); return v }
const runs = Number(opt('--runs', 300))
let seed = Number(opt('--seed', 1))
const verbose = args.includes('--verbose') ? (args.splice(args.indexOf('--verbose'), 1), true) : false
const files = args

globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} }
const server = await createServer({ root, logLevel: 'error', server: { middlewareMode: true }, appType: 'custom', optimizeDeps: { noDiscovery: true, include: [] } })
const load = (p) => server.ssrLoadModule(p)
const { useOrmStore } = await load('/src/store/ormStore.js')
const { computePopulationIssues } = await load('/src/utils/populationValidation.js')
const { withDerivedPopulations, semiDerivedPopulationIssues, derivedFactPopulationIssues, formulaConstraintPopulationIssues, makePopulationEvaluator } = await load('/src/logic/derivedPopulation.js')
const { formalise } = await load('/src/logic/constraintFormulas.js')
const { formulaToRule } = await load('/src/logic/formulaToRule.js')
const { valueKindOf } = await load('/src/utils/datatypeValues.js')
const { VARIANTS } = await load('/scripts/coverage-fixtures.mjs')

// ── Random numbers (reproducible) ────────────────────────────────────────────
const rand = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648 }
const pick = (xs) => xs[Math.floor(rand() * xs.length)]

// ── Which issues are about which entry ──────────────────────────────────────

// Issue kinds that say the population is not a well-formed instance of the
// schema, whatever its constraints: the mutations repair these.
const STRUCTURAL = new Set(['emptyTupleCell', 'danglingReference', 'typeMismatch', 'missingInPlayerPop',
  'missingInSupertypePop', 'incompleteIdentifier', 'mappingIncomplete', 'mappingNotInjective', 'duplicateIdentifier'])
// Issue kinds about constraints, as the matchers below read them.
const CONSTRAINT_KINDS = new Set(['uniquenessViolation', 'frequencyViolation', 'mandatoryRoleNotPlayed', 'valueRangeViolation',
  'cardinalityViolation', 'ringViolation', 'valueComparisonViolation', 'exclusionViolation', 'equalityViolation', 'subsetViolation',
  'inclusiveOrViolation', 'exclusiveOrViolation', 'formulaViolated', 'semiDerivedMissing', 'derivedFactUndefined', 'nonIndependentNotPlaying'])

const same = (a, b) => a.length === b.length && [...a].sort().join(',') === [...b].sort().join(',')

// The issues that are violations of an entry's constraint, as a predicate;
// null when no issue kind stands for it.
function matcherOf(entry, state) {
  const k = entry.key
  let m
  if (k.startsWith('part:')) return (i) => i.kind === 'nonIndependentNotPlaying' && i.otId === k.slice(5)
  if ((m = k.match(/^([^:]+):uc:([\d,]+)$/))) {
    const roles = m[2].split(',').map(Number)
    return (i) => i.kind === 'uniquenessViolation' && i.factId === m[1] && same(i.roleIndices ?? [], roles)
  }
  // A preferred identifier's "exactly one": the implied uniqueness on the
  // identified role, or the implied mandatory role.
  if ((m = k.match(/^([^:]+):pi:([\d,]+)$/))) {
    const fact = state.facts.find(f => f.id === m[1])
    const covered = m[2].split(',').map(Number)
    const e = fact.roles.map((_, i) => i).find(i => !covered.includes(i))
    return (i) => i.factId === m[1] && ((i.kind === 'uniquenessViolation' && same(i.roleIndices ?? [], [e]))
      || (i.kind === 'mandatoryRoleNotPlayed' && i.roleIndex === e))
  }
  if ((m = k.match(/^([^:]+):mand:(\d+)$/))) return (i) => i.kind === 'mandatoryRoleNotPlayed' && i.factId === m[1] && i.roleIndex === +m[2]
  if ((m = k.match(/^([^:]+):vr:(\d+)$/))) return (i) => i.kind === 'valueRangeViolation' && i.factId === m[1] && i.roleIndex === +m[2]
  if ((m = k.match(/^([^:]+):vr$/))) return (i) => i.kind === 'valueRangeViolation' && i.otId === m[1] && i.factId == null
  if ((m = k.match(/^([^:]+):freq:(.+)$/))) return (i) => i.kind === 'frequencyViolation' && i.factId === m[1] && i.internalFrequencyId === m[2]
  if ((m = k.match(/^([^:]+):card$/))) return (i) => i.kind === 'cardinalityViolation' && i.otId === m[1] && i.roleIndex == null
  if ((m = k.match(/^([^:]+):card:(\d+)$/))) return (i) => i.kind === 'cardinalityViolation' && i.factId === m[1] && i.roleIndex === +m[2]
  if ((m = k.match(/^([^:]+):derivation(:\d)?$/))) return (i) => (i.kind === 'semiDerivedMissing' || i.kind === 'derivedFactUndefined') && i.elementId === m[1]
  if ((m = k.match(/^([^:]+):exactlyOne$/))) return (i) => i.kind === 'uniquenessViolation' && i.constraintId === m[1]
  const c = state.constraints.find(x => x.id === k.split(':')[0])
  if (c && c.constraintType === 'ring') {
    const rt = k.split(':')[1]
    return (i) => i.kind === 'ringViolation' && i.constraintId === c.id && i.ringType === rt
  }
  if (c && !k.includes(':')) return (i) => CONSTRAINT_KINDS.has(i.kind) && i.constraintId === c.id
  return null
}

// Entries that hold by construction of the stored data: nothing to check.
const BY_CONSTRUCTION = (entry) => /^disj:|:il(:|$)/.test(entry.key) || entry.kind === 'Subtype' || entry.key.includes(':possible:')

// ── Populations ─────────────────────────────────────────────────────────────

const POP_KEYS = ['populations', 'factPopulations', 'nestedEntityMappings', 'subtypeMappings']
const clone = (x) => JSON.parse(JSON.stringify(x ?? {}))
const popsOf = (s) => Object.fromEntries(POP_KEYS.map(k => [k, clone(s[k])]))

function allIssues(s) {
  return [...computePopulationIssues(withDerivedPopulations(s)), ...semiDerivedPopulationIssues(s),
    ...derivedFactPopulationIssues(s), ...formulaConstraintPopulationIssues(s)]
}

// Removes what structural issues name, until there are none (or give up).
function repair(s) {
  for (let round = 0; round < 12; round++) {
    const issues = computePopulationIssues(s).filter(i => STRUCTURAL.has(i.kind))
    if (!issues.length) return true
    const dropTuples = new Map(), dropInst = new Map()
    const add = (map, id, idx) => { if (!map.has(id)) map.set(id, new Set()); map.get(id).add(idx) }
    for (const i of issues) {
      if ((i.kind === 'danglingReference' || i.kind === 'emptyTupleCell') && i.tupleIndex != null) add(dropTuples, i.factId, i.tupleIndex)
      else if (i.subtypeEdgeId) {
        const edge = s.subtypes.find(e => e.id === i.subtypeEdgeId)
        if (edge && i.rowIndex != null) add(dropInst, edge.subId, i.rowIndex)
        else if (edge && i.rowIndices) i.rowIndices.forEach(r => add(dropInst, edge.subId, r))
      } else if (i.kind === 'duplicateIdentifier') {
        const pop = s.populations[i.otId] ?? []
        const idx = pop.findIndex(v => JSON.stringify(v) === JSON.stringify(i.value))
        if (idx >= 0) add(dropInst, i.otId, idx)
      } else if (i.otId && i.instanceIndex != null) add(dropInst, i.otId, i.instanceIndex)
      else return false
    }
    for (const [id, set] of dropTuples) s.factPopulations[id] = (s.factPopulations[id] ?? []).filter((_, ix) => !set.has(ix))
    for (const [id, set] of dropInst) {
      s.populations[id] = (s.populations[id] ?? []).filter((_, ix) => !set.has(ix))
      for (const e of s.subtypes.filter(e => e.subId === id && s.subtypeMappings?.[e.id]))
        s.subtypeMappings[e.id] = s.subtypeMappings[e.id].filter((_, ix) => !set.has(ix))
    }
  }
  return false
}

// A fresh value for a value type, of its datatype's kind.
function freshValue(s, vt) {
  const kind = vt ? Object.entries(VALUE_KINDS_BY_NAME).find(([, k]) => k === valueKindOf(vt.datatypeAssignment))?.[0] : 'string'
  const n = Math.floor(rand() * 40) - 5
  switch (kind) {
    case 'integer': case 'decimal': case 'float': case 'money': return String(n)
    case 'boolean': return rand() < 0.5 ? 'true' : 'false'
    case 'yesNo': return rand() < 0.5 ? 'yes' : 'no'
    case 'date': return `2026-0${1 + Math.floor(rand() * 9)}-1${Math.floor(rand() * 9)}`
    default: return `v${Math.abs(n)}`
  }
}
let VALUE_KINDS_BY_NAME = {}

// The cells a role may hold: the effective population of its player.
function candidates(s, typeId) {
  const out = new Map()
  const addCell = (c) => { if (c != null) out.set(JSON.stringify(c), c) }
  const subsOf = (id) => s.subtypes.filter(e => e.superId === id && e.inheritsPreferredIdentifier !== false).map(e => e.subId)
  const todo = [typeId], seen = new Set()
  while (todo.length) {
    const id = todo.pop()
    if (seen.has(id)) continue
    seen.add(id)
    for (const c of s.populations[id] ?? []) addCell(c)
    const f = s.facts.find(x => x.id === id && x.objectified)
    if (f) for (const c of (s.nestedEntityMappings[id] ?? s.factPopulations[id] ?? [])) addCell(Array.isArray(c) ? c.slice(0, f.roles.length) : c)
    todo.push(...subsOf(id))
  }
  // Values of a value type that some entity uses as its reference.
  return [...out.values()]
}

const storedFacts = (s) => s.facts.filter(f => f.derivation !== 'derived' && f.roles.every(r => r.objectTypeId) && !identifying(s, f))
let identIds = null
const identifying = (s, f) => identIds.entity.has(f.id) || identIds.nested.has(f.id)

// A fact population is a set: a tuple that is there already is not added
// (validation reports a duplicate as a uniqueness violation, the formulas
// read the population as a set).
const hasTuple = (s, f, t) => (s.factPopulations[f.id] ?? []).some(u => JSON.stringify(u) === JSON.stringify(t))

// One random change to the populations.
function mutate(s, log) {
  const facts = storedFacts(s)
  const types = s.objectTypes.filter(o => o.derivation !== 'derived')
  const r = rand()
  if (r < 0.25 && facts.length) {
    const f = pick(facts)
    const ts = s.factPopulations[f.id] ?? []
    if (!ts.length) return
    const ix = Math.floor(rand() * ts.length)
    log.push(`remove ${f.id}[${ix}]`)
    ts.splice(ix, 1)
  } else if (r < 0.5 && facts.length) {
    const f = pick(facts)
    const t = f.roles.map(ro => pick(candidates(s, ro.objectTypeId)))
    if (t.some(c => c == null) || hasTuple(s, f, t)) return
    log.push(`add ${f.id} ${JSON.stringify(t)}`)
    ;(s.factPopulations[f.id] ??= []).push(t)
  } else if (r < 0.65 && facts.length) {
    const f = pick(facts)
    const ts = s.factPopulations[f.id] ?? []
    if (!ts.length) return
    const t = [...pick(ts)]
    const ri = Math.floor(rand() * f.roles.length)
    const c = pick(candidates(s, f.roles[ri].objectTypeId))
    if (c == null) return
    t[ri] = c
    if (hasTuple(s, f, t)) return
    log.push(`add variant ${f.id} ${JSON.stringify(t)}`)
    ts.push(t)
  } else if (r < 0.8 && types.length) {
    const ot = pick(types)
    const pop = s.populations[ot.id] ?? []
    if (!pop.length) return
    const ix = Math.floor(rand() * pop.length)
    log.push(`remove ${ot.id}[${ix}]`)
    pop.splice(ix, 1)
  } else if (types.length) {
    // A new instance: a fresh value, or a value for a ref-mode entity type
    // (its value type gets it too), or an entity that a subtype also has.
    const ot = pick(types)
    if (ot.kind === 'value') {
      const v = freshValue(s, ot)
      log.push(`new ${ot.id} ${v}`)
      ;(s.populations[ot.id] ??= []).push(v)
      return
    }
    const sup = s.subtypes.find(e => e.subId === ot.id && e.inheritsPreferredIdentifier !== false)
    if (sup) {
      const c = pick(candidates(s, sup.superId))
      if (c == null) return
      log.push(`new ${ot.id} ${JSON.stringify(c)} (from its supertype)`)
      ;(s.populations[ot.id] ??= []).push(c)
      return
    }
    const rm = refModes.get(ot.id)
    if (rm) {
      const vt = s.objectTypes.find(o => o.id === rm.vtId)
      const v = freshValue(s, vt)
      log.push(`new ${ot.id} ${v}`)
      ;(s.populations[ot.id] ??= []).push(v)
      ;(s.populations[rm.vtId] ??= []).push(v)
    }
  }
}
let refModes = new Map()

// ── Checking one population ─────────────────────────────────────────────────

function check(s, entries, tally, label) {
  const issues = allIssues(s)
  for (const i of issues) if (!STRUCTURAL.has(i.kind) && !CONSTRAINT_KINDS.has(i.kind)) tally.unknownKinds.add(i.kind)
  const ev = makePopulationEvaluator(s)
  for (const e of entries) {
    const t = tally.byKey.get(e.key)
    let r
    try { r = ev.closedFormula(e.rule) } catch (err) { r = { error: err } }
    if (r.error) { t.undecided++; continue }
    const matching = issues.filter(e.match)
    const reported = matching.length > 0
    const deontic = /\(deontic\)/.test(e.kind)
    if (matching.some(i => !!i.deontic !== deontic)) { t.modality++; if (!t.modalityExample) t.modalityExample = label }
    if (!r.holds && !reported) { t.missed++; if (!t.missedExample) t.missedExample = label }
    else if (r.holds && reported) { t.falseAlarm++; if (!t.alarmExample) t.alarmExample = { label, issue: issues.find(e.match).message } }
    else if (r.holds) t.held++
    else t.caught++
  }
}

function checkState(name, state) {
  const ctx = formalise(state, { wholeSchema: true })
  const raw = [...ctx.entries, ...(ctx.implicit?.participation ?? [])]
  const entries = [], unchecked = []
  const noFormula = []
  for (const e of raw) {
    if (BY_CONSTRUCTION(e)) continue
    if (!e.formula) { if (e.note && !/holds for any|says nothing|Spans every role/.test(e.note)) noFormula.push(e); continue }
    const match = matcherOf(e, state)
    if (!match) { unchecked.push(e); continue }
    let rule
    try { rule = formulaToRule(e.formula.t === 'obligatory' ? e.formula.arg : e.formula) } catch { unchecked.push({ ...e, why: 'formula not evaluable' }); continue }
    entries.push({ ...e, match, rule })
  }
  const tally = { byKey: new Map(entries.map(e => [e.key, { entry: e, caught: 0, held: 0, missed: 0, falseAlarm: 0, undecided: 0, modality: 0 }])), unknownKinds: new Set() }

  check(state, entries, tally, 'the stored population')
  let skipped = 0
  for (let n = 0; n < runs; n++) {
    const s = { ...state, ...popsOf(state) }
    const log = []
    const steps = 1 + Math.floor(rand() * 4)
    for (let k = 0; k < steps; k++) mutate(s, log)
    if (!repair(s)) { skipped++; continue }
    check(s, entries, tally, log.join('; '))
  }

  console.log(`\n${name}: ${entries.length} entries checked on ${runs + 1 - skipped} populations${skipped ? ` (${skipped} left out, not repairable)` : ''}`)
  let bad = 0
  for (const e of noFormula) console.log(`  no formula   ${e.kind} — ${e.subject || e.key}: ${e.note} (not tested)`)
  for (const e of unchecked) { bad++; console.log(`  unchecked    ${e.kind} — ${e.subject || e.key}${e.why ? ` (${e.why})` : ''}`) }
  for (const t of tally.byKey.values()) {
    const what = `${t.entry.kind} — ${t.entry.subject || t.entry.key}`
    if (t.missed) { bad++; console.log(`  missed       ${what}: ${t.missed}× (e.g. after: ${t.missedExample})`) }
    if (t.modality) { bad++; console.log(`  modality     ${what}: ${t.modality}× reported as ${/\(deontic\)/.test(t.entry.kind) ? 'alethic' : 'deontic'} (e.g. after: ${t.modalityExample})`) }
    if (t.falseAlarm) { bad++; console.log(`  false alarm  ${what}: ${t.falseAlarm}× (e.g. after: ${t.alarmExample.label}: ${t.alarmExample.issue})`) }
    if (verbose || (!t.caught && !t.missed)) console.log(`  ${t.caught ? 'ok' : 'never broken'}${' '.repeat(t.caught ? 11 : 1)}${what}: ${t.caught} caught, ${t.held} held${t.undecided ? `, ${t.undecided} undecided` : ''}`)
  }
  for (const k of tally.unknownKinds) { bad++; console.log(`  unknown issue kind ${k}`) }
  return bad
}

function loadState(content) {
  useOrmStore.getState().loadModel(typeof content === 'string' ? JSON.parse(content) : content, null)
  const s = useOrmStore.getState()
  return { objectTypes: s.objectTypes, facts: s.facts, constraints: s.constraints, subtypes: s.subtypes, schemas: s.schemas,
    ...popsOf(s) }
}

async function main() {
  const { identifyingFactIds, findRefMode } = await load('/src/utils/refMode.js')
  VALUE_KINDS_BY_NAME = (await load('/src/utils/datatypeValues.js')).VALUE_KINDS
  const cases = []
  if (files.length) for (const f of files) cases.push([path.basename(f), loadState(fs.readFileSync(f, 'utf8'))])
  else {
    const base = JSON.parse(fs.readFileSync(path.join(root, 'src/data/sample.ffbm'), 'utf8'))
    cases.push(['sample', loadState(base)])
    for (const v of VARIANTS) cases.push([`sample + ${v.name}`, loadState(v.apply(clone(base)))])
  }
  let bad = 0
  for (const [name, state] of cases) {
    const ident = identifyingFactIds(state.facts, state.objectTypes, state.constraints)
    refModes = new Map(state.objectTypes.filter(o => o.kind === 'entity').map(o => [o.id, findRefMode(o, state.facts, state.objectTypes)]).filter(([, rm]) => rm))
    const run = () => { identIds = ident; return checkState(name, state) }
    bad += run()
  }
  await server.close()
  console.log(bad ? `\n${bad} problem${bad === 1 ? '' : 's'}` : '\nall constraints checked')
  process.exit(bad ? 1 : 0)
}
await main()
