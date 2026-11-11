// Populations as sentences: each row of a fact type, and each instance of a
// value type or entity type, written in the language of the readings
// (the Population tab's Sentences view).
//
// An instance is written as a noun phrase found from its type's preferred
// identifier, the way the population stores it (a cell holds the identifier:
// the reference value, the list of a composite identifier's parts, an
// objectified fact type's tuple or its own identifier):
//   reference mode            Person 'P1'               (popular: .nr, .code)
//                             Mass 12 kg                (unit-based)
//                             Book with ISBN '…'        (general)
//   composite identifier      the Room that is in Building 'MAL' and has RoomNr '151'
//                             (the identifying readings, read from the entity;
//                             past depth 2, or without such readings, Room ('MAL', '151'))
//   objectified fact type     the Enrolment in which Student 'P1' enrols in Course 'DB1'
// A subtype instance takes the name of the type it is met as (the role
// player) and its supertype's identifier. Values are quoted unless their
// datatype is a number or a truth value.
//
// The design choices are in the Claude doc "Population sentences: examples to
// choose from" (2026-11-11). The fixed words come from the language's
// `population` section (english.js); a language without one is written in
// English.

import { tok, linearise, phraseKit } from './engine.js'
import { findRefMode, findCompositePI, findInheritedPI, findRolePlayer, identifyingFactIds } from '../utils/refMode.js'
import { datatypeAssignmentToKind } from '../utils/datatypeMapping.js'
import { makePopulationEvaluator } from '../logic/derivedPopulation.js'

const UNQUOTED = new Set(['integer', 'decimal', 'boolean'])
// Composite identifiers nested deeper than this are written as tuples.
const MAX_DEPTH = 2

// The identifier of an entity type or objectified fact type, own or
// inherited: { kind: 'refMode', rm, owner } | { kind: 'composite', cp, owner }
// | { kind: 'objectified', fact } | null.
export function identifierOf(player, schema) {
  const { facts, objectTypes, subtypes, constraints } = schema
  const isNested = !!player?.objectified && player.objectifiedKind !== 'value'
  if (!player || (player.kind !== 'entity' && !isNested)) return null
  const rm = findRefMode(player, facts, objectTypes)
  if (rm) return { kind: 'refMode', rm, owner: player }
  const cp = findCompositePI(player, facts, objectTypes, constraints)
  if (cp) return { kind: 'composite', cp, owner: player }
  const inh = findInheritedPI(player, facts, objectTypes, subtypes, constraints)
  if (inh?.kind === 'refMode') return { kind: 'refMode', rm: inh.refMode, owner: inh.supertype }
  if (inh?.kind === 'compositePI') {
    // A nested supertype without an identifier of its own: its fact's tuple.
    if (inh.cp.entityRoleIndex === null) return { kind: 'objectified', fact: inh.supertype }
    return { kind: 'composite', cp: inh.cp, owner: inh.supertype }
  }
  if (isNested) return { kind: 'objectified', fact: player }
  return null
}

// The phrase builder for one language: { np(typeId, cell), keyLines() }.
// keyLines gives, for the popular reference modes the phrases used, the
// sentences saying what the values are ("Persons are referred to by PersonNr.").
function makeWriter(ctx, language) {
  const w = language.population ?? englishWords
  const h = phraseKit(ctx, language)
  const schema = ctx.schema
  const otById = ctx.otById
  const player = (id) => findRolePlayer(id, schema.objectTypes, schema.facts)
  const used = new Map()   // value type id → Set of type ids referred to by it
  let n = 0
  const v = (typeId) => ({ typeId, id: `pop:${n++}` })

  const valueToken = (vtId, cell) => {
    const kind = datatypeAssignmentToKind(otById.get(vtId)?.datatypeAssignment)
    const text = String(cell)
    return tok(UNQUOTED.has(kind) ? text : `'${text}'`, 'const')
  }

  // The parts of an identifier, flattened into constants: ('MAL', '151').
  const tuple = (typeId, cell, visiting) => {
    const ident = identifierOf(player(typeId), schema)
    const parts = identifierParts(ident, schema)
    if (!parts || !Array.isArray(cell) || parts.length !== cell.length) return [valueToken(null, cell)]
    const inner = parts.map((p, i) => leaf(p.typeId, cell[i], visiting))
    if (inner.length === 1) return inner[0]
    return [tok('(', 'punct'), ...inner.flatMap((x, i) => (i ? [tok(',', 'punct'), x] : [x])), tok(')', 'punct')]
  }
  // A part of a tuple: the value of a value type or of a reference mode, else
  // the nested tuple.
  const leaf = (typeId, cell, visiting) => {
    const p = player(typeId)
    if (!p || (p.kind !== 'entity' && !p.objectified)) return valueToken(typeId, cell)
    const ident = identifierOf(p, schema)
    if (ident?.kind === 'refMode') return valueToken(ident.rm.vtId, cell)
    if (!ident || visiting.has(p.id)) return valueToken(null, Array.isArray(cell) ? JSON.stringify(cell) : cell)
    return tuple(typeId, cell, new Set([...visiting, p.id]))
  }

  // The noun phrase of an instance of typeId (a cell as the population holds it).
  function np(typeId, cell, depth = 0, visiting = new Set()) {
    const p = player(typeId)
    const name = tok(h.typeLabel(typeId), 'type')
    if (!p) return [name, valueToken(null, cell)]
    if (p.kind === 'value') return [name, valueToken(typeId, cell)]
    const ident = identifierOf(p, schema)
    if (!ident) return [name, valueToken(null, cell)]
    if (ident.kind === 'refMode') {
      const { owner, rm } = ident
      const value = valueToken(rm.vtId, cell)
      if (owner.refModeKind === 'unit' && owner.refModeName) return [name, value, tok(owner.refModeName, 'kw')]
      if (owner.refModeKind === 'general') return [name, w.with, tok(h.typeLabel(rm.vtId), 'type'), value]
      if (!used.has(rm.vtId)) used.set(rm.vtId, new Set())
      used.get(rm.vtId).add(typeId)
      return [name, value]
    }
    const short = () => [name, tuple(typeId, cell, new Set([...visiting, p.id]))]
    if (visiting.has(p.id) || depth >= MAX_DEPTH || !Array.isArray(cell)) return short()
    const inner = new Set([...visiting, p.id])
    if (ident.kind === 'objectified') {
      const fact = ident.fact
      const args = fact.roles.map(r => v(r.objectTypeId))
      const overrides = new Map(args.map((a, i) => [a, np(fact.roles[i].objectTypeId, cell[i], depth + 1, inner)]))
      const clause = h.reading({ t: 'fact', factId: fact.id, args }, undefined, overrides)
      return clause ? [w.the, name, w.inWhich, clause] : short()
    }
    const clauses = identifyingClauses(ident, typeId, cell, depth, inner)
    return clauses ? [w.the, name, w.rel(h, v(typeId)), w.join(clauses)] : short()
  }

  // The identifying facts of a composite identifier as verb phrases about the
  // entity: "is in Building 'MAL'", "has RoomNr '151'"; null when one of them
  // has no reading that starts at the entity.
  function identifyingClauses(ident, typeId, cell, depth, visiting) {
    const { cp } = ident
    const segments = cp.identifyingRoleIndices.map((ri, ci) => ({
      factId: cp.factIds ? cp.factIds[ci] : cp.factId,
      ri, ci,
      ei: cp.entityRoleIndices ? cp.entityRoleIndices[ci] : cp.entityRoleIndex,
    }))
    if (segments.length !== cell.length) return null
    const byFact = new Map()
    for (const s of segments) {
      if (!byFact.has(s.factId)) byFact.set(s.factId, [])
      byFact.get(s.factId).push(s)
    }
    const out = []
    for (const [factId, segs] of byFact) {
      const fact = ctx.factById.get(factId)
      if (!fact) return null
      const args = fact.roles.map(r => v(r.objectTypeId))
      const subject = args[segs[0].ei]
      const overrides = new Map(segs.map(s => [args[s.ri], np(fact.roles[s.ri].objectTypeId, cell[s.ci], depth + 1, visiting)]))
      const vp = h.reading({ t: 'fact', factId, args }, subject, overrides)
      if (!vp) return null
      out.push(vp)
    }
    return out
  }

  const keyLines = () => [...used].map(([vtId, typeIds]) =>
    linearise(w.referredTo(h, [...typeIds], vtId), language))

  return { h, w, np, valueToken, keyLines }
}

// The parts of an identifier with their types, in the order a cell holds them.
function identifierParts(ident, schema) {
  if (!ident) return null
  if (ident.kind === 'objectified') return ident.fact.roles.map(r => ({ typeId: r.objectTypeId }))
  if (ident.kind === 'composite') {
    const { cp } = ident
    return cp.identifyingRoleIndices.map((ri, ci) => {
      const f = schema.facts.find(x => x.id === (cp.factIds ? cp.factIds[ci] : cp.factId))
      return { typeId: f?.roles?.[ri]?.objectTypeId }
    })
  }
  return null
}

// The fixed words, English (also the fallback for languages without their own).
const kw = (s) => tok(s, 'kw')
const article = (word) => (/^[aeiou]/i.test(word) ? 'an' : 'a')
export const englishWords = {
  the: kw('the'),
  with: kw('with'),
  inWhich: kw('in which'),
  rel: (h, v) => kw(h.objectType(v)?.isPersonal ? 'who' : 'that'),
  join: (parts) => parts.flatMap((p, i) => (i ? [kw('and'), p] : [p])),
  // There is a Person with PersonNr 'P1'.
  thereIs: (name, rest) => [kw('there is'), kw(article(name.text)), name, ...rest],
  // 'Alice' is a PersonName. / Person 'P1' is a Student.
  isA: (subject, name) => [subject, kw('is'), kw(article(name.text)), name],
  // Persons and Students are referred to by PersonNr.
  referredTo: (h, typeIds, vtId) => {
    const names = typeIds.map(t => tok(h.typePlural(t), 'type'))
    const list = names.flatMap((n, i) => (i === 0 ? [n] : [i === names.length - 1 ? kw('and') : tok(',', 'punct'), n]))
    return [...list, kw('are referred to by'), tok(h.typeLabel(vtId), 'type')]
  },
  derived: 'derived',
}

// The sentences of the population of element (an object type or fact type id
// of data, a scoped store state): { rows: [{ tokens, text, derived, problems }],
// keyLines: [{ tokens, text }], note? }. issues are the population issues
// (store.populationIssues), shown as problems of the rows they name.
export function populationSentences(data, ctx, language, elementId, issues = []) {
  const ev = makePopulationEvaluator(data)
  const writer = makeWriter(ctx, language)
  const { h, w, np, valueToken } = writer
  const ot = ctx.otById.get(elementId)
  const fact = ctx.factById.get(elementId)
  const rows = []
  const say = (phrase, extra = {}) => {
    const s = linearise(phrase, language)
    rows.push({ ...s, derived: false, problems: [], ...extra })
  }

  if (fact) {
    // An identifying fact type repeats its entity type's identifier: show the
    // entity type's instances instead.
    const identified = identifiedBy(fact, ctx.schema)
    if (identified) return { ...populationSentences(data, ctx, language, identified, issues), note: 'identifies', identified }
    const args = fact.roles.map((r, i) => ({ typeId: r.objectTypeId, id: `row:${i}` }))
    const sentence = (tuple) => {
      const overrides = new Map(args.map((a, i) => [a, np(fact.roles[i].objectTypeId, tuple[i])]))
      return h.reading({ t: 'fact', factId: fact.id, args }, undefined, overrides)
    }
    const problemsOf = (ti) => issues.filter(i => i.factId === fact.id
      && (i.tupleIndex === ti || (Array.isArray(i.tupleIndices) && i.tupleIndices.includes(ti)))).map(i => i.message)
    if (fact.derivation !== 'derived') {
      ;(data.factPopulations?.[fact.id] ?? []).forEach((t, ti) => {
        if (!Array.isArray(t)) return
        const s = sentence(t)
        if (s) say(s, { problems: problemsOf(ti) })
      })
    }
    if (fact.derivation === 'derived' || fact.derivation === 'semiDerived') {
      const r = ev.derivedFact(fact.id)
      if (r.error) return { rows, keyLines: writer.keyLines(), error: String(r.error?.message ?? r.error) }
      const stored = fact.derivation === 'semiDerived' ? ev.storedTuples(fact).keys : new Set()
      for (const t of r.tuples) {
        if (stored.has(JSON.stringify(t.map(ev.keyOf)))) continue
        const s = sentence(t)
        if (s) say(s, { derived: true })
      }
    }
    return { rows, keyLines: writer.keyLines() }
  }

  if (ot) {
    const problemsOf = (idx) => issues.filter(i => i.otId === ot.id && i.instanceIndex === idx).map(i => i.message)
    const name = tok(h.typeLabel(ot.id), 'type')
    const ident = ot.kind === 'entity' ? identifierOf(ot, ctx.schema) : null
    // An instance as an "is a" or "there is" sentence: a subtype that
    // inherits its identifier is named by the type that owns it.
    const instance = (cell) => {
      if (ot.kind === 'value') return w.isA(valueToken(ot.id, cell), name)
      if (ident && ident.owner && ident.owner.id !== ot.id) return w.isA(np(ident.owner.id, cell), name)
      if (ident?.kind === 'refMode') {
        const { rm, owner } = ident
        if (owner.refModeKind === 'unit' && owner.refModeName)
          return w.thereIs(name, [valueToken(rm.vtId, cell), tok(owner.refModeName, 'kw')])
        return w.thereIs(name, [w.with, tok(h.typeLabel(rm.vtId), 'type'), valueToken(rm.vtId, cell)])
      }
      const phrase = np(ot.id, cell)
      // "the Room that …" → "There is a Room that …"
      return phrase[0] === w.the ? w.thereIs(name, phrase.slice(2)) : w.thereIs(name, phrase.slice(1))
    }
    if (ot.derivation !== 'derived') {
      ;(data.populations?.[ot.id] ?? []).forEach((cell, idx) => {
        if (cell === '' || cell == null) return
        say(instance(cell), { problems: problemsOf(idx) })
      })
    }
    if (ot.derivation === 'derived' || ot.derivation === 'semiDerived') {
      const r = ev.derived(ot.id)
      if (r.error) return { rows, keyLines: writer.keyLines(), error: String(r.error?.message ?? r.error) }
      const stored = ot.derivation === 'semiDerived' ? ev.population(ot.id).keys : new Set()
      for (const cell of r.instances) {
        if (stored.has(ev.keyOf(cell))) continue
        say(instance(cell), { derived: true })
      }
    }
    return { rows, keyLines: writer.keyLines() }
  }
  return { rows, keyLines: [] }
}

// The entity type a fact type identifies (by reference mode or composite
// identifier), or null.
function identifiedBy(fact, schema) {
  const { refModes, compositePIs } = identifyingFactIds(schema.facts, schema.objectTypes, schema.constraints)
  for (const [typeId, rm] of refModes) if (rm.factId === fact.id) return typeId
  for (const [typeId, cp] of compositePIs) if (cp.factId === fact.id || cp.factIds?.includes(fact.id)) return typeId
  return null
}
