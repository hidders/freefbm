// NORMA .orm import.
//
// importNorma(xmlText) reads a NORMA model file and returns { data, log,
// name, pendingJoinIds }:
// data is a FreeFBM file (the same JSON that serialize writes, so it goes
// through loadModel and its migrations), log lists what was dropped, turned
// into a Note, or left for later. NORMA's GUIDs are kept as element ids.
//
// The mapping, in brief (see the "NORMA .orm import readiness" doc):
//   - entity and value types; a value type marked IsImplicitBooleanValue is
//     NORMA's old encoding of a unary, so its binary becomes a unary fact
//   - fact types, roles, readings (several per role order, hyphen binding
//     as written in NORMA's reading text); roles[] follows the first
//     reading's role order, NORMA's own order becomes the shapes' roleOrder
//   - explicit objectifications; implied ones and their link facts are
//     skipped, as are implied mandatories
//   - internal uniqueness, preferred identifiers, mandatory roles,
//     inclusive-or, exclusive-or (NORMA's exclusion + mandatory pair),
//     exclusion, subset, equality, ring (combinations split), frequency,
//     value comparison, value and cardinality ranges, deontic modality
//   - subtypes, with constraints on subtype links
//   - join paths that NORMA builds automatically become query graphs; other
//     join paths and all derivation paths are left for the path translator
//     (the derivation mode is set, the rule is not)
//   - element groups with their colours, custom properties (a property
//     named Definition or Note fills the element's own field), model notes
//   - diagrams: shapes become occurrences, inches become pixels

const SCALE = 200   // pixels per inch

const ORM = 'http://schemas.neumont.edu/ORM/2006-04/ORMCore'

// ── XML helpers ──────────────────────────────────────────────────────────────

const kids = (el, name) => el ? [...el.children].filter(c => !name || c.localName === name) : []
const kid  = (el, name) => kids(el, name)[0] ?? null
const path = (el, ...names) => names.reduce((e, n) => kid(e, n), el)
const attr = (el, name) => el?.getAttribute(name) ?? null
const refsOf = (el) => el ? [...el.children].map(c => attr(c, 'ref')).filter(Boolean) : []
const textOf = (el) => (el?.textContent ?? '').trim()

function bounds(shape) {
  const b = (attr(shape, 'AbsoluteBounds') ?? '').split(',').map(Number)
  if (b.length !== 4 || b.some(n => !Number.isFinite(n))) return null
  const [x, y, w, h] = b
  return { cx: Math.round((x + w / 2) * SCALE), cy: Math.round((y + h / 2) * SCALE),
           w: Math.round(w * SCALE), h: Math.round(h * SCALE) }
}

// "255, 128, 0" or a .NET colour name → #rrggbb (names via the browser).
let _ctx = null
function toHex(v) {
  if (!v) return null
  const m = v.match(/^\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*$/)
  if (m) return '#' + m.slice(1).map(n => (+n).toString(16).padStart(2, '0')).join('')
  try {
    _ctx ??= document.createElement('canvas').getContext('2d')
    _ctx.fillStyle = '#000000'
    _ctx.fillStyle = v.toLowerCase()
    return _ctx.fillStyle.startsWith('#') ? _ctx.fillStyle : null
  } catch { return null }
}

// NORMA data type element → the NORMA profile's datatype id
// (UnsignedIntegerNumericDataType → NumericUnsignedInteger).
function datatypeId(tag) {
  const base = tag.replace(/DataType$/, '')
  const cat = ['RawData', 'Numeric', 'Temporal', 'Logical', 'Text', 'Other'].find(c => base.endsWith(c))
  return cat ? cat + base.slice(0, -cat.length) : null
}

// AcyclicStronglyIntransitive → ['acyclic', 'strongly-intransitive']
const RING_WORDS = [
  ['PurelyReflexive', 'purely-reflexive'], ['StronglyIntransitive', 'strongly-intransitive'],
  ['Irreflexive', 'irreflexive'], ['Reflexive', 'reflexive'], ['Antisymmetric', 'antisymmetric'],
  ['Asymmetric', 'asymmetric'], ['Symmetric', 'symmetric'], ['Intransitive', 'intransitive'],
  ['Transitive', 'transitive'], ['Acyclic', 'acyclic'],
]
function ringTypes(type) {
  const out = []
  let s = type ?? ''
  while (s) {
    const w = RING_WORDS.find(([n]) => s.startsWith(n))
    if (!w) return null
    out.push(w[1]); s = s.slice(w[0].length)
  }
  return out
}

const VC_OPS = { Equal: '=', NotEqual: '≠', LessThan: '<', LessThanOrEqual: '≤', GreaterThan: '>', GreaterThanOrEqual: '≥' }

// NORMA ValueRange → a FreeFBM range spec.
function rangeSpec(vr) {
  const lo = attr(vr, 'MinValue') ?? '', hi = attr(vr, 'MaxValue') ?? ''
  const lowerOpen = attr(vr, 'MinInclusion') === 'Open', upperOpen = attr(vr, 'MaxInclusion') === 'Open'
  if (lo !== '' && lo === hi && !lowerOpen && !upperOpen) return { type: 'single', value: lo }
  if (lo !== '' && hi !== '') return { type: 'range', lower: lo, upper: hi, ...(lowerOpen && { lowerOpen }), ...(upperOpen && { upperOpen }) }
  if (lo !== '') return { type: 'lower', lower: lo, ...(lowerOpen && { lowerOpen }) }
  if (hi !== '') return { type: 'upper', upper: hi, ...(upperOpen && { upperOpen }) }
  return null
}
const valueRanges = (vc) => kids(kid(vc, 'ValueRanges'), 'ValueRange').map(rangeSpec).filter(Boolean)

// min..max with max 0 meaning unbounded, as frequency and cardinality ranges.
function countRange(min, max) {
  const lo = Number(min ?? 1), hi = Number(max ?? 0)
  if (hi > 0 && lo === hi) return [{ type: 'single', value: String(lo) }]
  if (hi > 0) return [{ type: 'range', lower: String(lo), upper: String(hi) }]
  return [{ type: 'lower', lower: String(lo) }]
}

// Splits "{0} is used at {1} to report failed- {2}" into the texts around
// the placeholders, in placeholder order.
function readingParts(data, n) {
  const parts = []
  const order = []
  let rest = data
  for (;;) {
    const m = rest.match(/\{(\d+)\}/)
    if (!m) { parts.push(rest); break }
    parts.push(rest.slice(0, m.index))
    order.push(Number(m[1]))
    rest = rest.slice(m.index + m[0].length)
  }
  if (order.length !== n) return null
  return { order, parts: parts.map(p => p.replace(/\s+/g, ' ').trim()) }
}

// ── import ───────────────────────────────────────────────────────────────────

export function importNorma(xmlText) {
  const doc = new DOMParser().parseFromString(xmlText.replace(/^﻿/, ''), 'application/xml')
  if (doc.getElementsByTagName('parsererror').length) throw new Error('Not a readable XML file.')
  const model = doc.getElementsByTagNameNS(ORM, 'ORMModel')[0]
  if (!model) throw new Error('No NORMA model (ORMModel) in this file.')

  const log = []
  const counts = {}
  const note = (text) => log.push({ level: 'note', text })
  const warn = (text) => log.push({ level: 'warn', text })
  const count = (k, n = 1) => { counts[k] = (counts[k] ?? 0) + n }

  const byId = new Map()
  for (const el of doc.getElementsByTagName('*')) { const id = attr(el, 'id'); if (id) byId.set(id, el) }
  const kindOf = (id) => byId.get(id)?.localName ?? null

  const objectTypes = [], facts = [], subtypes = [], constraints = []
  const otById = new Map(), factById = new Map(), stById = new Map(), conById = new Map()
  const playerId = new Map()           // NORMA object type id → FreeFBM player id
  const implicitBoolean = new Set()    // NORMA value type ids
  const notesFor = new Map()           // FreeFBM element → extra Note lines
  const addNote = (el, line) => { if (el) notesFor.set(el, [...(notesFor.get(el) ?? []), line]) }

  // ── object types ──────────────────────────────────────────────────────────
  const objects = kids(kid(model, 'Objects'))
  const objectifiedFacts = new Map()   // NORMA fact id → ObjectifiedType element (explicit only)
  for (const o of objects) {
    const id = attr(o, 'id'), name = attr(o, 'Name') ?? ''
    if (o.localName === 'ValueType' && attr(o, 'IsImplicitBooleanValue') === 'true') { implicitBoolean.add(id); continue }
    if (o.localName === 'ObjectifiedType') {
      const np = kid(o, 'NestedPredicate')
      if (attr(np, 'IsImplied') === 'true') { count('impliedObjectification'); continue }
      objectifiedFacts.set(attr(np, 'ref'), o)
      playerId.set(id, attr(np, 'ref'))
      continue
    }
    if (o.localName !== 'EntityType' && o.localName !== 'ValueType') continue
    const ot = {
      id, kind: o.localName === 'EntityType' ? 'entity' : 'value', name, x: 0, y: 0,
      valueRangeOffset: null, datatypeAssignment: null,
      ...(o.localName === 'EntityType' && { isPersonal: attr(o, 'IsPersonal') === 'true' }),
      ...(attr(o, 'IsIndependent') === 'true' && { isIndependent: true }),
    }
    const cdt = kid(o, 'ConceptualDataType')
    if (cdt) {
      const dt = byId.get(attr(cdt, 'ref'))
      const dtId = dt && datatypeId(dt.localName)
      if (dtId) {
        const len = Number(attr(cdt, 'Length') ?? 0), scale = Number(attr(cdt, 'Scale') ?? 0)
        ot.datatypeAssignment = { profileId: 'norma', datatypeId: dtId,
          params: { ...(len > 0 && { length: len }), ...(scale > 0 && { scale }) } }
      }
    }
    const vc = path(o, 'ValueRestriction', 'ValueConstraint')
    if (vc) {
      ot.valueRange = valueRanges(vc)
      if (attr(vc, 'Modality') === 'Deontic') ot.valueRangeDeontic = true
    }
    const cc = path(o, 'CardinalityRestriction', 'CardinalityConstraint')
    if (cc) {
      const cr = kids(kid(cc, 'Ranges'), 'CardinalityRange')
      ot.cardinalityRange = cr.flatMap(r => countRange(attr(r, 'From') ?? 0, attr(r, 'To') ?? 0))
      if (attr(cc, 'Modality') === 'Deontic') ot.cardinalityRangeDeontic = true
    }
    const sdr = path(o, 'SubtypeDerivationRule', 'SubtypeDerivationPath')
    if (sdr) {
      ot.derivation = attr(sdr, 'DerivationCompleteness') === 'PartiallyDerived' ? 'semiDerived' : 'derived'
      count('subtypeRules')
    }
    objectTypes.push(ot); otById.set(id, ot); playerId.set(id, id)
  }

  // ── fact types ────────────────────────────────────────────────────────────
  const roleRef = new Map()   // NORMA role id → member { kind:'role', factId, roleIndex } | { kind:'subtype', subtypeId }
  const roleEl = new Map()    // NORMA role id → its element
  const factEls = kids(kid(model, 'Facts'))
  for (const f of factEls.filter(f => f.localName === 'Fact')) {
    const id = attr(f, 'id')
    const roleEls = kids(kid(f, 'FactRoles'), 'Role')
    // NORMA's binarised unary: drop the implicit boolean role.
    const real = roleEls.filter(r => !implicitBoolean.has(attr(kid(r, 'RolePlayer'), 'ref')))
    const isUnary = real.length < roleEls.length
    if (isUnary) count('unaries')

    // roles[] in the order of the first reading
    const orders = kids(kid(f, 'ReadingOrders'), 'ReadingOrder').map(ro => ({
      seq: refsOf(kid(ro, 'RoleSequence')).filter(r => real.some(e => attr(e, 'id') === r)),
      readings: kids(kid(ro, 'Readings'), 'Reading').map(rd => textOf(kid(rd, 'Data'))),
      rawSeq: refsOf(kid(ro, 'RoleSequence')),
    }))
    const realIds = real.map(r => attr(r, 'id'))
    const first = orders.find(o => o.seq.length === realIds.length && new Set(o.seq).size === realIds.length)
    const roleIds = first ? first.seq : realIds
    const fact = {
      id, kind: 'fact', x: 0, y: 0, arity: roleIds.length,
      roles: roleIds.map(rid => {
        const r = roleEls.find(e => attr(e, 'id') === rid)
        const role = { id: rid, objectTypeId: null, roleName: attr(r, 'Name') ?? '', mandatory: false,
          linkReadingParts: ['', '', ''], linkReadingReverseParts: null }
        const pref = attr(kid(r, 'RolePlayer'), 'ref')
        role._player = pref
        const rvc = path(r, 'ValueRestriction', 'RoleValueConstraint')
        if (rvc) {
          role.valueRange = valueRanges(rvc)
          if (attr(rvc, 'Modality') === 'Deontic') role.valueRangeDeontic = true
        }
        return role
      }),
      readingParts: null, alternativeReadings: [], readingDisplay: 'forward', shownReadingOrder: null,
      uniqueness: [], preferredUniqueness: [], internalFrequency: [],
      orientation: 'horizontal', readingOffsetAbove: null, readingOffsetBelow: null,
      readingAbove: false, uniquenessBelow: false, implicitLinks: [],
      _normaRoleOrder: realIds,
    }
    fact.roles.forEach((r, i) => { roleRef.set(r.id, { kind: 'role', factId: id, roleIndex: i }); roleEl.set(r.id, roleEls.find(e => attr(e, 'id') === r.id)) })
    if (isUnary) for (const r of roleEls) if (!realIds.includes(attr(r, 'id'))) roleRef.set(attr(r, 'id'), { kind: 'booleanRole', factId: id })

    // readings
    for (const o of orders) {
      // A unary's reading orders may list the boolean role; its placeholders
      // then count it, so map them through the raw sequence.
      const idxOf = (rid) => roleIds.indexOf(rid)
      for (const data of o.readings) {
        const rp = readingParts(data, o.rawSeq.length)
        if (!rp) { warn(`A reading of fact type ${id} could not be read: “${data}”.`); continue }
        const ordered = rp.order.map(k => o.rawSeq[k])
        const keep = ordered.map((rid, i) => ({ rid, i })).filter(x => idxOf(x.rid) >= 0)
        if (keep.length !== roleIds.length) continue
        // The texts around the kept placeholders: a dropped placeholder's
        // texts are joined to its neighbours.
        const parts = ['']
        let p = 0
        for (let i = 0; i <= ordered.length; i++) {
          parts[p] = [parts[p], rp.parts[i]].filter(Boolean).join(' ')
          if (i < ordered.length && idxOf(ordered[i]) >= 0) { p++; parts[p] = '' }
        }
        const roleOrder = keep.map(x => idxOf(x.rid))
        const isIdentity = roleOrder.every((r, i) => r === i)
        if (isIdentity && !fact.readingParts) fact.readingParts = parts
        else fact.alternativeReadings.push({ roleOrder, parts })
      }
    }

    // derivation
    const dp = path(f, 'DerivationRule', 'FactTypeDerivationPath')
    if (dp) {
      fact.derivation = attr(dp, 'DerivationCompleteness') === 'PartiallyDerived' ? 'semiDerived' : 'derived'
      if (attr(dp, 'DerivationStorage') === 'Stored') addNote(fact, 'NORMA: the derived values are stored (DerivationStorage = Stored).')
      count('factRules')
    }
    const ob = objectifiedFacts.get(id)
    if (ob) {
      fact.objectified = true
      fact.objectifiedKind = 'entity'
      fact.objectifiedName = attr(ob, 'Name') ?? ''
      if (attr(ob, 'IsIndependent') === 'true') fact.isIndependent = true
      fact.implicitLinks = fact.roles.map((_, i) => ({
        roleIndex: i, x: null, y: null,
        readingParts: ['', 'involves', ''],
        alternativeReadings: [{ roleOrder: [1, 0], parts: ['', 'is involved in', ''] }],
        readingDisplay: 'forward', orientation: 'horizontal',
        readingOffsetAbove: null, readingOffsetBelow: null, readingAbove: false,
        uniquenessBelow: false, preferredUniqueness: [], roleNames: [null, null],
      }))
    }
    facts.push(fact); factById.set(id, fact)
  }
  // role players, now that objectified facts are known
  for (const f of facts) for (const r of f.roles) {
    r.objectTypeId = playerId.get(r._player) ?? null
    if (!r.objectTypeId) warn(`A role of fact type ${f.id} has no player FreeFBM can show.`)
    delete r._player
  }

  // subtype links
  for (const sf of factEls.filter(f => f.localName === 'SubtypeFact')) {
    const id = attr(sf, 'id')
    const sub = kid(kid(sf, 'FactRoles'), 'SubtypeMetaRole'), sup = kid(kid(sf, 'FactRoles'), 'SupertypeMetaRole')
    const st = { id, kind: 'subtype',
      subId: playerId.get(attr(kid(sub, 'RolePlayer'), 'ref')),
      superId: playerId.get(attr(kid(sup, 'RolePlayer'), 'ref')),
      inheritsPreferredIdentifier: attr(sf, 'PreferredIdentificationPath') === 'true' }
    if (!st.subId || !st.superId) { warn(`Subtype link ${id} joins a type FreeFBM does not have.`); continue }
    subtypes.push(st); stById.set(id, st)
    roleRef.set(attr(sub, 'id'), { kind: 'subtype', subtypeId: id, side: 'sub' })
    roleRef.set(attr(sup, 'id'), { kind: 'subtype', subtypeId: id, side: 'super' })
  }

  // link fact types of explicit objectifications: their roles are reachable
  // as F_il_r (role 0 the objectified type, role 1 the original player)
  for (const lf of factEls.filter(f => f.localName === 'ImpliedFact')) {
    const proxy = kid(kid(lf, 'FactRoles'), 'RoleProxy')
    const own = kid(kid(lf, 'FactRoles'), 'Role')
    const orig = roleRef.get(attr(kid(proxy, 'Role'), 'ref'))
    if (!orig || orig.kind !== 'role' || !factById.get(orig.factId)?.objectified) continue
    const ilId = `${orig.factId}_il_${orig.roleIndex}`
    roleRef.set(attr(proxy, 'id'), { kind: 'role', factId: ilId, roleIndex: 1, link: true })
    roleRef.set(attr(own, 'id'), { kind: 'role', factId: ilId, roleIndex: 0, link: true })
    // readings, when they differ from the default
    const il = factById.get(orig.factId).implicitLinks[orig.roleIndex]
    const readings = kids(kid(lf, 'ReadingOrders'), 'ReadingOrder').map(ro => {
      const seq = refsOf(kid(ro, 'RoleSequence'))
      const rp = readingParts(textOf(path(ro, 'Readings', 'Reading', 'Data')), 2)
      if (!rp) return null
      const order = rp.order.map(k => seq[k] === attr(own, 'id') ? 0 : 1)
      return { order, parts: rp.parts }
    }).filter(Boolean)
    const fwd = readings.find(r => r.order[0] === 0), rev = readings.find(r => r.order[0] === 1)
    if (fwd) il.readingParts = fwd.parts
    if (rev) il.alternativeReadings = [{ roleOrder: [1, 0], parts: rev.parts }]
  }

  // ── constraints ───────────────────────────────────────────────────────────
  const conEls = kids(kid(model, 'Constraints'))
  const members = (seqEl) => refsOf(seqEl).map(r => roleRef.get(r) ?? null)
  const playerOfMember = (m) => {
    if (!m) return null
    if (m.kind === 'subtype') { const st = stById.get(m.subtypeId); return m.side === 'super' ? st?.superId : st?.subId }
    if (m.link) {
      const [fid, r] = m.factId.split('_il_')
      return m.roleIndex === 0 ? fid : factById.get(fid)?.roles[Number(r)]?.objectTypeId
    }
    return factById.get(m.factId)?.roles[m.roleIndex]?.objectTypeId ?? null
  }
  const otherRole = (m) => {
    if (m.link) return { factId: m.factId, roleIndex: 1 - m.roleIndex, player: playerOfMember({ ...m, roleIndex: 1 - m.roleIndex }) }
    const f = factById.get(m.factId)
    if (!f || f.arity !== 2) return null
    return { factId: f.id, roleIndex: 1 - m.roleIndex, player: f.roles[1 - m.roleIndex].objectTypeId }
  }
  const asMember = (m) => m.kind === 'subtype'
    ? { kind: 'subtype', subtypeId: m.subtypeId }
    : { kind: 'role', factId: m.factId, roleIndex: m.roleIndex }
  const commonPlayer = (ms) => {
    const ps = new Set(ms.map(playerOfMember))
    return ps.size === 1 ? [...ps][0] ?? null : null
  }

  // The query graph of a sequence whose roles lie in several fact types
  // joined through one object type, as NORMA's automatic join paths do.
  // Returns undefined when the sequence needs no query, null when it needs
  // one this importer cannot build.
  const autoJoin = (ms, joined, outputTarget) => {
    const roles = ms.filter(m => m.kind === 'role')
    if (roles.length !== ms.length) return ms.length === 1 ? undefined : null
    if (new Set(roles.map(m => m.factId)).size === 1 && !roles[0].factId.includes('_il_')) return undefined
    if (!joined) return null
    const others = roles.map(otherRole)
    if (others.some(o => !o)) return null
    const t = new Set(others.map(o => o.player))
    if (t.size !== 1) return null
    const target = [...t][0]
    if (new Set(roles.map(m => m.factId)).size !== roles.length) return null
    const tAtom = { id: 'q_t', kind: 'objectType', originalId: target, isOutput: !!outputTarget, dx: 16, dy: 16 }
    const atoms = [tAtom], links = []
    roles.forEach((m, i) => {
      atoms.push({ id: `q_${i}`, kind: 'fact', originalId: m.factId, isOutput: false,
        seededRoles: [{ roleIndex: m.roleIndex, seqPosition: i }], dx: 48 + 16 * i, dy: 48 + 16 * i })
      links.push({ atomId: `q_${i}`, roleIndex: others[i].roleIndex, variableId: 'q_t' })
    })
    return { atoms, links, _target: target }
  }

  const xorPair = new Map()   // exclusion id → mandatory id
  for (const c of conEls) {
    if (c.localName === 'MandatoryConstraint') {
      const ex = attr(kid(c, 'ExclusiveOrExclusionConstraint'), 'ref')
      if (ex) xorPair.set(ex, attr(c, 'id'))
    }
  }
  const conAlias = new Map()   // NORMA constraint id → FreeFBM constraint id (xor pairs)

  const mkCon = (c, type, extra = {}) => ({
    id: attr(c, 'id'), kind: 'constraint', constraintType: type, x: 0, y: 0,
    sequences: [], queries: [], frequency: null, exhaustive: true, exclusive: false, subtypeIds: [],
    ...(attr(c, 'Modality') === 'Deontic' && { deontic: true }),
    ...extra,
  })
  const setQueries = (con, seqs, c, outputTarget = false) => {
    const jr = c.getElementsByTagNameNS(ORM, 'JoinPath')[0]
    const automatic = !jr || attr(jr, 'IsAutomatic') === 'true'
    let pending = false
    con.queries = seqs.map(ms => {
      const g = autoJoin(ms, automatic, outputTarget)
      if (g === undefined) return null
      if (g === null) { pending = true; return null }
      if (outputTarget && !con.targetObjectTypeId) con.targetObjectTypeId = g._target
      delete g._target
      return g
    })
    if (pending) { count('pendingJoins'); con._pendingJoin = true }
  }
  const pushCon = (con, c) => { constraints.push(con); conById.set(con.id, con); conAlias.set(attr(c, 'id'), con.id) }
  const unknownMembers = (ms, c) => {
    if (ms.every(Boolean)) return false
    warn(`${c.localName} ${attr(c, 'Name') ?? attr(c, 'id')} refers to a role FreeFBM does not have; skipped.`)
    return true
  }

  for (const c of conEls) {
    const id = attr(c, 'id'), t = c.localName
    const seq = kid(c, 'RoleSequence')
    const seqs = kids(kid(c, 'RoleSequences'), 'RoleSequence')
    if (t === 'UniquenessConstraint') {
      const ms = members(seq)
      if (attr(c, 'IsInternal') === 'true') {
        if (ms.some(m => m?.kind === 'subtype' || m?.link)) continue   // implied by the subtype link or objectification
        const real = ms.filter(m => m?.kind === 'role')
        if (!real.length) continue
        const f = factById.get(real[0].factId)
        const roles = real.map(m => m.roleIndex).sort((a, b) => a - b)
        if (!f.uniqueness.some(u => u.join() === roles.join())) f.uniqueness.push(roles)
        // A preferred identifier for the player of the one role left over. NORMA
        // also marks the uniqueness that identifies an objectified fact type
        // itself; FreeFBM takes that from the fact type's uniqueness.
        const pif = playerId.get(attr(kid(c, 'PreferredIdentifierFor'), 'ref'))
        const rest = f.roles.filter((_, ri) => !roles.includes(ri))
        if (pif && rest.length === 1 && rest[0].objectTypeId === pif) f.preferredUniqueness.push(roles)
        if (attr(c, 'Modality') === 'Deontic') f.deonticUniqueness = [...(f.deonticUniqueness ?? []), roles]
        continue
      }
      if (unknownMembers(ms, c)) continue
      const pif = attr(kid(c, 'PreferredIdentifierFor'), 'ref')
      const con = mkCon(c, 'uniqueness', {
        sequences: [ms.map(asMember)],
        targetObjectTypeId: pif ? playerId.get(pif) ?? null : null,
        isPreferredIdentifier: !!pif,
      })
      setQueries(con, [ms], c, true)
      pushCon(con, c)
    } else if (t === 'MandatoryConstraint') {
      if (attr(c, 'IsImplied') === 'true') { count('impliedMandatory'); continue }
      const ms = members(seq)
      if (attr(c, 'IsSimple') === 'true') {
        const m = ms[0]
        if (!m || m.kind !== 'role' || m.link) continue   // subtype meta roles and link roles: implied
        const role = factById.get(m.factId).roles[m.roleIndex]
        role.mandatory = true
        if (attr(c, 'Modality') === 'Deontic') role.mandatoryDeontic = true
        continue
      }
      if (unknownMembers(ms, c)) continue
      const isXor = !!kid(c, 'ExclusiveOrExclusionConstraint')
      const con = mkCon(c, isXor ? 'exclusiveOr' : 'inclusiveOr', {
        sequences: ms.map(m => [asMember(m)]),
        targetObjectTypeId: commonPlayer(ms),
      })
      pushCon(con, c)
      if (isXor) conAlias.set(attr(kid(c, 'ExclusiveOrExclusionConstraint'), 'ref'), con.id)
    } else if (t === 'ExclusionConstraint' || t === 'SubsetConstraint' || t === 'EqualityConstraint') {
      if (xorPair.has(id)) continue
      const sms = seqs.map(members)
      if (sms.some(ms => unknownMembers(ms, c))) continue
      const type = t === 'ExclusionConstraint' ? 'exclusion' : t === 'SubsetConstraint' ? 'subset' : 'equality'
      const con = mkCon(c, type, { sequences: sms.map(ms => ms.map(asMember)) })
      setQueries(con, sms, c)
      pushCon(con, c)
    } else if (t === 'RingConstraint') {
      const ms = members(seq)
      if (unknownMembers(ms, c)) continue
      const rt = ringTypes(attr(c, 'Type'))
      if (!rt) { warn(`Ring constraint ${attr(c, 'Name')} has a type FreeFBM does not know (${attr(c, 'Type')}); skipped.`); continue }
      const con = mkCon(c, 'ring', { sequences: [ms.map(asMember)], ringTypes: rt })
      setQueries(con, [ms], c)
      pushCon(con, c)
    } else if (t === 'FrequencyConstraint') {
      const ms = members(seq)
      if (unknownMembers(ms, c)) continue
      const range = countRange(attr(c, 'MinFrequency'), attr(c, 'MaxFrequency'))
      const inOneFact = ms.every(m => m.kind === 'role' && !m.link && m.factId === ms[0].factId)
      if (inOneFact) {
        const f = factById.get(ms[0].factId)
        f.internalFrequency.push({ id, roles: ms.map(m => m.roleIndex), range,
          ...(attr(c, 'Modality') === 'Deontic' && { deontic: true }) })
        conAlias.set(id, `if:${f.id}`)
      } else {
        const con = mkCon(c, 'frequency', { sequences: [ms.map(asMember)], frequency: range, targetObjectTypeId: null })
        setQueries(con, [ms], c, true)
        pushCon(con, c)
      }
    } else if (t === 'ValueComparisonConstraint') {
      const ms = members(seq)
      if (unknownMembers(ms, c)) continue
      const con = mkCon(c, 'valueComparison', { sequences: [ms.map(asMember)],
        operator: VC_OPS[attr(c, 'Operator')] ?? '=', targetObjectTypeId: null })
      setQueries(con, [ms], c)
      pushCon(con, c)
    } else {
      warn(`${t} ${attr(c, 'Name') ?? id} is not imported.`)
    }
  }

  // ── Definition, Note and custom properties ─────────────────────────────────
  const elementFor = (normaId) => {
    if (otById.has(normaId)) return otById.get(normaId)
    if (factById.has(normaId)) return factById.get(normaId)
    if (playerId.has(normaId) && factById.has(playerId.get(normaId))) return factById.get(playerId.get(normaId))
    if (stById.has(normaId)) return stById.get(normaId)
    if (conAlias.has(normaId)) return conById.get(conAlias.get(normaId)) ?? null
    const rr = roleRef.get(normaId)
    if (rr?.kind === 'role' && !rr.link) return factById.get(rr.factId).roles[rr.roleIndex]
    return null
  }
  // NORMA's own Definition and Note children
  for (const [id, el] of byId) {
    const target = elementFor(id)
    if (!target) continue
    const def = textOf(path(el, 'Definitions', 'Definition', 'Text'))
    const nt = textOf(path(el, 'Notes', 'Note', 'Text'))
    if (def) target.definition = def
    if (nt) addNote(target, nt)
  }

  const KIND_OF_ORM_TYPE = {
    EntityType: ['entity'], ValueType: ['value'], FactType: ['fact'], SubtypeFact: ['subtype'],
    Role: ['role'], AllConstraints: ['constraint'], ElementGrouping: ['group'], ModelNote: ['note'],
    AllObjectTypes: ['entity', 'value'], ObjectType: ['entity', 'value'],
  }
  const CP_TYPES = { String: 'string', Integer: 'number', Decimal: 'number', DateTime: 'date', CustomEnumeration: 'enum' }
  const propertyDefinitions = []
  const defKind = new Map()   // definition id → 'definition' | 'note' | property id
  for (const g of doc.getElementsByTagNameNS('*', 'CustomPropertyGroup')) {
    for (const d of kids(kid(g, 'Definitions'), 'Definition').concat(kids(kid(g, 'PropertyDefinitions'), 'Definition'))) {
      const name = (attr(d, 'name') ?? '').trim()
      const did = attr(d, 'id')
      if (!did) continue
      if (/^definition$/i.test(name)) { defKind.set(did, 'definition'); continue }
      if (/^note$/i.test(name)) { defKind.set(did, 'note'); continue }
      const kinds = [...new Set((attr(d, 'ORMTypes') ?? '').split(',').map(s => s.trim()).flatMap(k => KIND_OF_ORM_TYPE[k] ?? []))]
      propertyDefinitions.push({
        id: did, name, category: attr(d, 'category') ?? attr(g, 'name') ?? '', description: attr(d, 'description') ?? '',
        type: CP_TYPES[attr(d, 'dataType')] ?? 'string',
        options: kids(d).filter(c => /Value/.test(c.localName)).map(textOf).filter(Boolean),
        default: attr(d, 'defaultValue') ?? '',
        appliesTo: kinds.length ? kinds : ['entity', 'value', 'fact', 'role', 'subtype', 'constraint', 'group', 'note'],
      })
      defKind.set(did, did)
    }
  }
  const applyProperties = (el, target) => {
    for (const cp of kids(kid(el, 'Extensions'), 'CustomProperty')) {
      const dk = defKind.get(attr(kid(cp, 'Definition'), 'ref'))
      const v = attr(cp, 'value') ?? ''
      if (!dk || v === '') continue
      if (dk === 'definition') target.definition = target.definition ? `${target.definition}\n${v}` : v
      else if (dk === 'note') addNote(target, v)
      else target.properties = { ...(target.properties ?? {}), [dk]: v }
      count('propertyValues')
    }
  }
  for (const [id, el] of byId) {
    if (!kid(el, 'Extensions')) continue
    const target = elementFor(id)
    if (target) applyProperties(el, target)
    else if (kids(kid(el, 'Extensions'), 'CustomProperty').length) count('propertiesDropped')
  }

  // ── model notes ───────────────────────────────────────────────────────────
  const modelNotes = new Map()   // id → { text, refs: [FreeFBM ids], el }
  for (const n of kids(kid(model, 'ModelNotes'), 'ModelNote')) {
    const refs = refsOf(kid(n, 'ReferencedBy')).map(r => elementFor(r)?.id).filter(Boolean)
    modelNotes.set(attr(n, 'id'), { text: textOf(kid(n, 'Text')), refs, el: n })
  }

  // ── diagrams ──────────────────────────────────────────────────────────────
  let occN = 0
  const newOccId = () => `occ_imp${++occN}`
  const diagrams = []
  const notesShown = new Set()
  const noteCopies = new Map()   // NORMA note id → FreeFBM note ids
  const firstPos = new Map()     // element id → { x, y }
  const ifPos = new Map()
  for (const d of doc.getElementsByTagNameNS('*', 'ORMDiagram')) {
    const diag = { id: attr(d, 'id'), name: attr(d, 'Name') || 'Diagram', occurrences: [], constraintOccurrences: [],
      implicitLinkPositions: {}, profileId: null, shownImplicitLinks: [], notes: [], expandedRefModes: [],
      expandedRefModeOccs: [], pan: { x: 0, y: 0 }, zoom: 1 }
    const expandedOwners = []
    const seenCon = new Set()
    for (const s of kids(kid(d, 'Shapes'))) {
      const subj = attr(kid(s, 'Subject'), 'ref')
      const b = bounds(s)
      if (!b) continue
      if (s.localName === 'ObjectTypeShape') {
        const ot = otById.get(subj)
        if (!ot) continue
        const occ = { id: newOccId(), schemaElementId: ot.id, x: b.cx, y: b.cy }
        diag.occurrences.push(occ)
        if (attr(s, 'ExpandRefMode') === 'true') expandedOwners.push(occ)
        if (!firstPos.has(ot.id)) firstPos.set(ot.id, { x: b.cx, y: b.cy })
      } else if (s.localName === 'FactTypeShape') {
        const f = factById.get(subj)
        if (!f) continue
        const occ = { id: newOccId(), schemaElementId: f.id, x: b.cx, y: b.cy }
        const orient = attr(s, 'DisplayOrientation')
        if (orient && orient.startsWith('Vertical')) occ.orientation = 'vertical'
        if (attr(s, 'ConstraintDisplayPosition') === 'Bottom') occ.uniquenessBelow = true
        const rdo = refsOf(kid(s, 'RoleDisplayOrder')).filter(r => f.roles.some(x => x.id === r))
        const display = rdo.length === f.arity ? rdo : f._normaRoleOrder
        const ro = display.map(rid => f.roles.findIndex(r => r.id === rid))
        if (ro.length === f.arity && ro.every(i => i >= 0) && ro.some((r, i) => r !== i)) occ.roleOrder = ro
        diag.occurrences.push(occ)
        if (!firstPos.has(f.id)) firstPos.set(f.id, { x: b.cx, y: b.cy })
      } else if (s.localName === 'ModelNoteShape') {
        const mn = modelNotes.get(subj)
        if (!mn) continue
        const copies = noteCopies.get(subj) ?? []
        const nid = copies.length ? `${subj}_${copies.length}` : subj
        noteCopies.set(subj, [...copies, nid])
        notesShown.add(subj)
        diag.notes.push({ id: nid, x: b.cx, y: b.cy, w: Math.max(80, b.w), h: Math.max(40, b.h), text: mn.text,
          connectors: mn.refs.map((targetId, i) => ({ id: `${nid}_c${i}`, targetId })) })
      } else if (/ConstraintShape$/.test(s.localName)) {
        const cid = conAlias.get(subj)
        if (!cid) continue
        if (cid.startsWith('if:')) { if (!ifPos.has(subj)) ifPos.set(subj, { x: b.cx, y: b.cy }); continue }
        if (seenCon.has(cid)) continue
        seenCon.add(cid)
        diag.constraintOccurrences.push({ id: `cocc_${s.getAttribute('id')}`, schemaConstraintId: cid,
          x: b.cx, y: b.cy, roleOccurrenceRefs: {}, queryOccurrenceRefs: {} })
        if (!firstPos.has(cid)) firstPos.set(cid, { x: b.cx, y: b.cy })
      }
    }
    finishDiagram(diag, expandedOwners)
    diagrams.push(diag)
  }

  // Occurrences FreeFBM needs that NORMA does not draw: the players of every
  // shown fact type, and the value type and fact type of a collapsed
  // reference mode. Then each fact occurrence's roles are tied to the
  // nearest occurrence of their player.
  function finishDiagram(diag, expandedOwners) {
    const occsOf = (id) => diag.occurrences.filter(o => o.schemaElementId === id)
    const nearest = (id, x, y, pred = () => true) => occsOf(id).filter(pred)
      .sort((a, b) => Math.hypot(a.x - x, a.y - y) - Math.hypot(b.x - x, b.y - y))[0] ?? null
    // reference modes
    const owners = diag.occurrences.filter(o => otById.get(o.schemaElementId)?.kind === 'entity'
      || factById.get(o.schemaElementId)?.objectified)
    for (const owner of owners) {
      const rm = refModeOf(owner.schemaElementId)
      if (!rm) continue
      if (expandedOwners.includes(owner)) {
        const vt = nearest(rm.vtId, owner.x, owner.y, o => !o.refModeOwnerOccId)
        const ft = nearest(rm.factId, owner.x, owner.y, o => !o.refModeOwnerOccId)
        if (vt && ft) {
          vt.refModeOwnerOccId = owner.id; ft.refModeOwnerOccId = owner.id
          ft.roleOccurrenceMap = { [String(1 - rm.vtRoleIndex)]: owner.id, [String(rm.vtRoleIndex)]: vt.id }
          diag.expandedRefModeOccs.push(owner.id)
          continue
        }
      }
      const vt = { id: newOccId(), schemaElementId: rm.vtId, x: owner.x + 160, y: owner.y, refModeOwnerOccId: owner.id }
      const ft = { id: newOccId(), schemaElementId: rm.factId, x: owner.x + 80, y: owner.y, refModeOwnerOccId: owner.id,
        roleOccurrenceMap: { [String(1 - rm.vtRoleIndex)]: owner.id, [String(rm.vtRoleIndex)]: vt.id } }
      diag.occurrences.push(vt, ft)
    }
    // players of shown facts
    for (const occ of [...diag.occurrences]) {
      const f = factById.get(occ.schemaElementId)
      if (!f || occ.roleOccurrenceMap) continue
      const map = {}
      f.roles.forEach((r, i) => {
        if (!r.objectTypeId) return
        let p = nearest(r.objectTypeId, occ.x, occ.y, o => !o.refModeOwnerOccId)
        if (!p) {
          p = { id: newOccId(), schemaElementId: r.objectTypeId, x: occ.x + (i - (f.arity - 1) / 2) * 140, y: occ.y + 90 }
          diag.occurrences.push(p)
          count('addedPlayers')
          const rm = refModeOf(r.objectTypeId)
          if (rm) {
            const vt = { id: newOccId(), schemaElementId: rm.vtId, x: p.x + 160, y: p.y, refModeOwnerOccId: p.id }
            diag.occurrences.push(vt, { id: newOccId(), schemaElementId: rm.factId, x: p.x + 80, y: p.y, refModeOwnerOccId: p.id,
              roleOccurrenceMap: { [String(1 - rm.vtRoleIndex)]: p.id, [String(rm.vtRoleIndex)]: vt.id } })
          }
        }
        map[String(i)] = p.id
      })
      occ.roleOccurrenceMap = map
    }
  }

  function refModeOf(ownerId) {
    for (const f of facts) {
      if (f.arity !== 2 || f.id === ownerId) continue
      const ei = f.roles.findIndex(r => r.objectTypeId === ownerId)
      if (ei < 0) continue
      const vi = 1 - ei
      const vt = otById.get(f.roles[vi].objectTypeId)
      if (vt?.kind !== 'value') continue
      if (!f.preferredUniqueness.some(pu => pu.length === 1 && pu[0] === vi)) continue
      return { vtId: vt.id, factId: f.id, vtRoleIndex: vi }
    }
    return null
  }

  // ── groups ────────────────────────────────────────────────────────────────
  const groups = []
  const COLOR_ROLES = { Outline: 'outline', Background: 'fill', ForegroundText: 'text' }
  for (const g of doc.getElementsByTagNameNS('*', 'Group')) {
    if (g.namespaceURI !== ORM) continue
    const types = kids(kid(g, 'GroupTypes'))
    if (types.some(t => t.localName === 'ORMShapeMissingGroupType')) { note(`Group “${attr(g, 'Name')}” is maintained by NORMA (shapes missing) and was not imported.`); continue }
    const colors = {}
    for (const t of types.filter(t => t.localName === 'ORMShapeColorGroupType'))
      for (const dc of kids(t, 'ORMDiagramDynamicColor')) {
        const ch = COLOR_ROLES[attr(dc, 'ColorRole')]
        const hex = toHex(attr(dc, 'ColorValue'))
        if (ch && hex) colors[ch] = hex
      }
    const memberIds = []
    let skipped = 0
    for (const ref of refsOf(kid(g, 'Elements'))) {
      const k = kindOf(ref)
      if (k === 'ModelNote') { memberIds.push(...(noteCopies.get(ref) ?? [])); continue }
      if (k === 'ReadingOrder') { let f = byId.get(ref); while (f && f.localName !== 'Fact') f = f.parentElement; if (f) memberIds.push(attr(f, 'id')); else skipped++; continue }
      const el = elementFor(ref)
      if (el?.id) memberIds.push(el.id); else skipped++
    }
    if (skipped) count('groupMembersDropped', skipped)
    groups.push({ id: attr(g, 'id'), name: attr(g, 'Name') ?? '', definition: '', note: '',
      priority: Number(attr(g, 'Priority') ?? 0) || 0, colors, members: [...new Set(memberIds)] })
    applyProperties(g, groups[groups.length - 1])
    const def = textOf(path(g, 'Definitions', 'Definition', 'Text'))
    if (def) groups[groups.length - 1].definition = def
  }

  // ── positions, notes, leftovers ───────────────────────────────────────────
  for (const el of [...objectTypes, ...facts, ...constraints]) {
    const p = firstPos.get(el.id)
    if (p) { el.x = p.x; el.y = p.y }
  }
  for (const f of facts) {
    for (const ifr of f.internalFrequency) {
      const p = ifPos.get(ifr.id)
      ifr.x = p?.x ?? f.x + 40; ifr.y = p?.y ?? f.y - 30
    }
    delete f._normaRoleOrder
  }
  // Sequences whose join NORMA built itself get the query FreeFBM would build
  // (openModelFile asks the store for it); the others wait for the translator.
  const pendingJoinIds = constraints.filter(c => c._pendingJoin).map(c => c.id)
  for (const c of constraints) delete c._pendingJoin

  let unplaced = 0
  for (const [id, mn] of modelNotes) {
    if (notesShown.has(id)) continue
    const targets = mn.refs.map(r => otById.get(r) ?? factById.get(r) ?? conById.get(r)).filter(Boolean)
    if (targets.length) targets.forEach(t => addNote(t, mn.text))
    else unplaced++
  }
  if (unplaced) {
    const diag = { id: 'imported-notes', name: 'Imported notes', occurrences: [], constraintOccurrences: [],
      implicitLinkPositions: {}, profileId: null, shownImplicitLinks: [], expandedRefModes: [], expandedRefModeOccs: [],
      pan: { x: 0, y: 0 }, zoom: 1,
      notes: [...modelNotes].filter(([id, mn]) => !notesShown.has(id) && !mn.refs.length)
        .map(([id, mn], i) => ({ id, x: 140 + (i % 4) * 260, y: 100 + Math.floor(i / 4) * 140, w: 240, h: 120, text: mn.text, connectors: [] })) }
    diagrams.push(diag)
  }
  for (const [el, lines] of notesFor) el.note = [el.note, ...lines].filter(Boolean).join('\n')

  // ── log ───────────────────────────────────────────────────────────────────
  const unused = (n, what) => n ? [`${n} ${what}`] : []
  const crm = kids(kid(model, 'CustomReferenceModes')).length
  log.unshift({ level: 'note', text: `Imported ${objectTypes.length} object types, ${facts.length} fact types (${facts.filter(f => f.objectified).length} objectified), ${subtypes.length} subtype links, ${constraints.length} external constraints, ${groups.length} groups, ${propertyDefinitions.length} custom property definitions and ${diagrams.length} diagrams.` })
  if (counts.unaries) note(`${counts.unaries} unary fact types were stored by NORMA as binaries with an implicit boolean value type; they are unaries here.`)
  const skippedImplied = [...unused(counts.impliedObjectification, 'implied objectifications'), ...unused(counts.impliedMandatory, 'implied mandatory constraints')]
  if (skippedImplied.length) note(`Skipped what NORMA implies and FreeFBM derives itself: ${skippedImplied.join(', ')}.`)
  if (counts.factRules || counts.subtypeRules)
    warn(`${counts.factRules ?? 0} fact type and ${counts.subtypeRules ?? 0} subtype derivation rules are marked derived, but their rules are not translated yet; validation lists them as incomplete.`)
  if (counts.pendingJoins) warn(`${counts.pendingJoins} constraints have a join path that is not translated yet; their sequences are imported without it.`)
  if (counts.addedPlayers) note(`${counts.addedPlayers} object type shapes were added next to fact types whose players NORMA did not draw on that diagram.`)
  if (unplaced) note(`${unplaced} model notes had no shape and no element; they are on the “Imported notes” diagram.`)
  if (counts.groupMembersDropped) note(`${counts.groupMembersDropped} group members (internal constraints and similar) have no FreeFBM counterpart and were left out of their groups.`)
  if (crm) note(`${crm} custom reference modes: the reference mode pattern is imported; NORMA's reference mode kinds and format strings are not.`)
  const phrases = kids(kid(model, 'RecognizedPhrases')).length
  if (phrases) note(`${phrases} recognised phrases (used by NORMA for relational names) were not imported.`)

  const data = {
    version: 2,
    schema: {
      objectTypes, factTypes: facts, subtypes, externalConstraints: constraints,
      ...(groups.length && { groups }),
      ...(propertyDefinitions.length && { propertyDefinitions }),
    },
    diagrams,
    activeDiagramId: diagrams[0]?.id ?? null,
  }
  if (!diagrams.length) delete data.diagrams
  return { data, log, name: attr(model, 'Name') ?? '', pendingJoinIds }
}
