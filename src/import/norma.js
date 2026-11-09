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
//     join paths become query formulas, and derivation paths become the
//     derivation rules of fact types and subtypes (normaPaths.js)
//   - element groups with their colours, custom properties (a property
//     named Definition or Note fills the element's own field), model notes
//   - diagrams: shapes become occurrences, inches become pixels
//
// Where the import adapts the model to FreeFBM's (a reading of NORMA's
// construct that FreeFBM writes differently, or something it cannot keep),
// the element gets an import note (src/utils/importNotes.js): 'changed' when
// the meaning changed or something was lost, 'rewritten' when it says the
// same. Adaptations of layout only are in the log.

import { narrowestNoteWidth, fittingNoteHeight } from '../components/NoteNode.jsx'
import { getDatatypeById } from '../data/datatypeProfiles.js'
import { makePathTranslator, closeLinearRecursion } from './normaPaths.js'
import { addImportNote } from '../utils/importNotes.js'
import { VALUE_KINDS, valueKindName } from '../utils/datatypeValues.js'
import { normaTemporal } from './normaTemporal.js'

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

// A NORMA colour as .NET's ColorConverter writes it: "255, 128, 0", "128, 255,
// 128, 0" (alpha first) or a colour name → #rrggbb. Web colour names are the
// CSS ones (resolved by the browser); Windows system colours get their
// default Windows 10 values. Transparent colours give null (no colour).
const SYSTEM_COLORS = {
  activeborder: '#b4b4b4', activecaption: '#99b4d1', activecaptiontext: '#000000', appworkspace: '#ababab',
  buttonface: '#f0f0f0', buttonhighlight: '#ffffff', buttonshadow: '#a0a0a0', control: '#f0f0f0',
  controldark: '#a0a0a0', controldarkdark: '#696969', controllight: '#e3e3e3', controllightlight: '#ffffff',
  controltext: '#000000', desktop: '#000000', gradientactivecaption: '#b9d1ea', gradientinactivecaption: '#d7e4f2',
  graytext: '#6d6d6d', highlight: '#0078d7', highlighttext: '#ffffff', hottrack: '#0066cc',
  inactiveborder: '#f4f7fc', inactivecaption: '#bfcddb', inactivecaptiontext: '#000000', info: '#ffffe1',
  infotext: '#000000', menu: '#f0f0f0', menubar: '#f0f0f0', menuhighlight: '#3399ff', menutext: '#000000',
  scrollbar: '#c8c8c8', window: '#ffffff', windowframe: '#646464', windowtext: '#000000',
}
let _ctx = null
function toHex(v) {
  if (!v) return null
  const m = v.match(/^\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*(\d+)\s*)?$/)
  if (m) {
    const [a, rgb] = m[4] != null ? [+m[1], m.slice(2)] : [255, m.slice(1, 4)]
    return a === 0 ? null : '#' + rgb.map(n => Math.min(255, +n).toString(16).padStart(2, '0')).join('')
  }
  const name = v.trim().toLowerCase()
  if (SYSTEM_COLORS[name]) return SYSTEM_COLORS[name]
  try {
    _ctx ??= document.createElement('canvas').getContext('2d')
    _ctx.fillStyle = '#000000'
    _ctx.fillStyle = name
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
  const derivationPaths = []   // { el: fact type or object type, path: its NORMA derivation path }

  const byId = new Map()
  for (const el of doc.getElementsByTagName('*')) { const id = attr(el, 'id'); if (id) byId.set(id, el) }
  const kindOf = (id) => byId.get(id)?.localName ?? null

  const objectTypes = [], facts = [], subtypes = [], constraints = []
  const otById = new Map(), factById = new Map(), stById = new Map(), conById = new Map()
  const playerId = new Map()           // NORMA object type id → FreeFBM player id
  const implicitBoolean = new Set()    // NORMA value type ids
  const booleanAllowsFalse = new Set() // those whose value constraint is not just true
  const notesFor = new Map()           // FreeFBM element → extra Note lines
  const addNote = (el, line) => { if (el) notesFor.set(el, [...(notesFor.get(el) ?? []), line]) }
  const changed = (el, text) => addImportNote(el, 'changed', text)
  const rewritten = (el, text) => addImportNote(el, 'rewritten', text)

  // NORMA's informal derivation rules: the text of a path's
  // InformalRule/DerivationNote, or of the older DerivationExpression that came
  // before role paths (its DerivationStorage says how derived the element is).
  // The text goes into the element's note; an element with only an informal
  // rule is marked derived and listed in the log.
  const informalOnly = [], informalEls = new Set()
  const informalRule = (el, pathEl, exprEl, name, what) => {
    const text = textOf(path(pathEl, 'InformalRule', 'DerivationNote', 'Body')) || textOf(kid(exprEl, 'Body'))
    if (!pathEl && exprEl) {
      const storage = attr(exprEl, 'DerivationStorage') ?? ''
      el.derivation = storage.startsWith('PartiallyDerived') ? 'semiDerived' : 'derived'
      if (storage.endsWith('Stored')) changed(el, 'NORMA stores the derived values (DerivationStorage = Stored); FreeFBM leaves storage to the mapping and does not keep it.')
    }
    if (!text) return
    addNote(el, `NORMA derivation rule (informal): ${text}`)
    const formal = pathEl && kids(kid(pathEl, 'PathComponents'), 'RolePath').some(p => kids(p).length)
    if (!formal) {
      informalOnly.push(`${what} ${name}`); informalEls.add(el)
      changed(el, 'NORMA has only an informal derivation rule for this element (kept in its note); it is marked derived, but has no formal rule yet.')
    }
  }

  // The model's functions, which NORMA's calculated values apply.
  const functions = new Map(kids(kid(model, 'Functions'), 'Function').map(fn => [attr(fn, 'id'), {
    name: attr(fn, 'Name'), symbol: attr(fn, 'OperatorSymbol'), isBoolean: attr(fn, 'IsBoolean') === 'true',
    params: kids(kid(fn, 'Parameters'), 'Parameter').map(p => ({ id: attr(p, 'id'), bag: attr(p, 'BagInput') === 'true' })),
  }]))

  // ── object types ──────────────────────────────────────────────────────────
  const objects = kids(kid(model, 'Objects'))
  const objectifiedFacts = new Map()   // NORMA fact id → ObjectifiedType element (explicit only)
  for (const o of objects) {
    const id = attr(o, 'id'), name = attr(o, 'Name') ?? ''
    if (o.localName === 'ValueType' && attr(o, 'IsImplicitBooleanValue') === 'true') {
      implicitBoolean.add(id)
      // NORMA restricted the value to true; a wider range made it open world
      const vc = path(o, 'ValueRestriction', 'ValueConstraint')
      if (vc && valueRanges(vc).some(r => r.type !== 'single' || !/^(true|1)$/i.test(String(r.value).trim()))) booleanAllowsFalse.add(id)
      continue
    }
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
      // NORMA's reference mode name as written ("Name"); the label shows it, not the
      // value type's suffix ("DiplomatName", "Family Name"), see refModeLabel
      ...(o.localName === 'EntityType' && attr(o, '_ReferenceMode') && { refModeName: attr(o, '_ReferenceMode') }),
      ...(attr(o, 'IsIndependent') === 'true' && { isIndependent: true }),
    }
    const cdt = kid(o, 'ConceptualDataType')
    if (cdt) {
      const dt = byId.get(attr(cdt, 'ref'))
      const dtId = dt && datatypeId(dt.localName)
      const pdt = dtId && getDatatypeById('norma', dtId)
      if (pdt) {
        // NORMA's Length is the precision for floating point, decimal and money
        const len = Number(attr(cdt, 'Length') ?? 0), scale = Number(attr(cdt, 'Scale') ?? 0)
        const lenParam = pdt.params.find(p => p.name === 'length' || p.name === 'precision')?.name
        const hasScale = pdt.params.some(p => p.name === 'scale')
        ot.datatypeAssignment = { profileId: 'norma', datatypeId: dtId,
          params: { ...(len > 0 && lenParam && { [lenParam]: len }), ...(scale > 0 && hasScale && { scale }) } }
      } else if (dt && dt.localName !== 'UnspecifiedDataType') {
        warn(`${o.localName === 'EntityType' ? 'Entity type' : 'Value type'} "${name}": data type ${dt.localName} has no FreeFBM equivalent, left unset.`)
        changed(ot, `NORMA's data type ${dt.localName} has no FreeFBM equivalent, so the data type is left unset.`)
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
    const sdRule = kid(o, 'SubtypeDerivationRule')
    const sdr = kid(sdRule, 'SubtypeDerivationPath')
    if (sdr) {
      ot.derivation = attr(sdr, 'DerivationCompleteness') === 'PartiallyDerived' ? 'semiDerived' : 'derived'
      derivationPaths.push({ el: ot, path: sdr, name })
    }
    informalRule(ot, sdr, kid(sdRule, 'SubtypeDerivationExpression'), name, 'subtype')
    objectTypes.push(ot); otById.set(id, ot); playerId.set(id, id)
  }

  // ── fact types ────────────────────────────────────────────────────────────
  const unaryPatterns = new Map()   // NORMA fact id → UnaryPattern
  const negationOf = new Map()      // positive unary's id → its negation's id
  const negationPairs = new Map()   // either of a pair → the other
  // A fact type as its reading with its players' names, “Person smokes”
  // (NORMA's _Name otherwise).
  const factName0 = (fid) => {
    const f = factById.get(fid), rp = f?.readingParts
    if (rp && f.roles.length) {
      const name = (r) => otById.get(playerId.get(r._player) ?? r.objectTypeId)?.name
        ?? factById.get(playerId.get(r._player) ?? r.objectTypeId)?.objectifiedName ?? '…'
      const words = []
      f.roles.forEach((r, i) => { words.push(rp[i], name(r)) })
      words.push(rp[f.roles.length])
      return `“${words.map(w => (w ?? '').trim()).filter(Boolean).join(' ')}”`
    }
    return attr(kids(kid(model, 'Facts')).find(e => attr(e, 'id') === fid), '_Name') ?? fid
  }
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
    const boolRoleEls = roleEls.filter(r => !real.includes(r))

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
    // (The older binary format itself is only in the log: it says the same.)
    if (isUnary) {
      if (boolRoleEls.some(r => booleanAllowsFalse.has(attr(kid(r, 'RolePlayer'), 'ref'))))
        changed(fact, "NORMA's hidden boolean value of this unary may also be false, so NORMA could record that it does not hold; FreeFBM keeps only the facts that it holds, and a missing fact means it does not hold.")
    }
    if (isUnary) for (const r of roleEls) if (!realIds.includes(attr(r, 'id'))) roleRef.set(attr(r, 'id'), { kind: 'booleanRole', factId: id })
    // Current NORMA's unary patterns: a negation pair, a default value.
    const pattern = attr(f, 'UnaryPattern')
    if (pattern && pattern !== 'NotUnary') unaryPatterns.set(id, pattern)
    const negRef = attr(kid(f, 'NegatedByUnaryFactType'), 'ref')
    if (negRef) negationOf.set(id, negRef)
    const dv = real.map(r => textOf(kid(r, 'DefaultValue'))).find(Boolean)
    const dflt = /DefaultTrue$/.test(pattern ?? '') ? 'true' : /DefaultFalse$/.test(pattern ?? '') ? 'false' : roleIds.length === 1 ? dv : null
    if (dflt) changed(fact, `NORMA gives this unary the default value ${dflt}; FreeFBM has no default values, so it was left out.`)

    // readings
    for (const o of orders) {
      // A unary's reading orders may list the boolean role; its placeholders
      // then count it, so map them through the raw sequence.
      const idxOf = (rid) => roleIds.indexOf(rid)
      for (const data of o.readings) {
        const rp = readingParts(data, o.rawSeq.length)
        if (!rp) { warn(`A reading of fact type ${id} could not be read: “${data}”.`); changed(fact, `NORMA's reading “${data}” could not be read and was left out.`); continue }
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
    const dRule = kid(f, 'DerivationRule')
    const dp = kid(dRule, 'FactTypeDerivationPath')
    if (dp) {
      fact.derivation = attr(dp, 'DerivationCompleteness') === 'PartiallyDerived' ? 'semiDerived' : 'derived'
      if (attr(dp, 'DerivationStorage') === 'Stored') changed(fact, 'NORMA stores the derived values (DerivationStorage = Stored); FreeFBM leaves storage to the mapping and does not keep it.')
      derivationPaths.push({ el: fact, path: dp, name: attr(f, '_Name') ?? id })
    }
    informalRule(fact, dp, kid(dRule, 'DerivationExpression'), attr(f, '_Name') ?? id, 'fact type')
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
  // Negatable unaries (current NORMA): a positive unary F paired with its
  // negation N (UnaryPattern Negation). NORMA reads the pair as three-valued
  // (holds, does not hold, unknown); FreeFBM keeps both unaries under the
  // closed-world assumption, F as "is known to …" and N as "is known not to …",
  // with the exclusion (or exclusive-or, when Required) NORMA gives them.
  for (const [fid, nid] of negationOf) {
    const F = factById.get(fid), N = factById.get(nid)
    if (!F || !N) continue
    negationPairs.set(fid, nid); negationPairs.set(nid, fid)
    count('negatableUnaries')
    const fName = factName0(fid)
    if (!N.readingParts && !N.alternativeReadings.length && F.readingParts) {
      const parts = [...F.readingParts]
      parts[parts.length - 1] = `${parts[parts.length - 1]} (negation)`.trim()
      N.readingParts = parts
      changed(N, `NORMA gives this negation of ${fName} no reading of its own; it reads as that unary followed by “(negation)” here, so give it a reading of its own.`)
    }
    const nName = factName0(nid)
    const pat = unaryPatterns.get(fid) ?? ''
    if (/^RequiredWithNegation/.test(pat)) {
      rewritten(F, `NORMA pairs this unary with its negation ${nName} and requires one of them; FreeFBM keeps both unaries with an exclusive-or constraint, so ${nName} holds exactly when this one does not.`)
      rewritten(N, `The negation of ${fName} in NORMA, kept as a unary of its own with an exclusive-or constraint.`)
    } else {
      changed(F, `NORMA pairs this unary with its negation ${nName}, so that it holds, does not hold or is unknown (open world). FreeFBM reads both unaries under the closed-world assumption: this one says it is known to hold, ${nName} that it is known not to hold, and an instance in neither is unknown. The readings are kept as imported.${/^Deontic/.test(pat) ? ' NORMA requires one of the two as a deontic rule.' : ''}`)
      changed(N, `The negation of ${fName} in NORMA, kept as a unary of its own: it says that ${fName} is known not to hold (see the note there).`)
    }
    const dF = !!F.derivation, dN = !!N.derivation
    if (dF !== dN) {
      const [stored, derived] = dF ? [N, F] : [F, N]
      changed(stored, `${factName0(derived.id)} is derived in NORMA but this unary, its ${dF ? 'negation' : 'positive form'}, has no rule; it is stored here, so the two may disagree.`)
    }
  }

  // role players, now that objectified facts are known
  for (const f of facts) for (const r of f.roles) {
    r.objectTypeId = playerId.get(r._player) ?? null
    if (!r.objectTypeId) warn(`A role of fact type ${f.id} has no player FreeFBM can show.`)
    delete r._player
  }

  // date and time bounds of value ranges, in XML Schema's form
  {
    const show = (b) => `“${b}”`
    const fix = (el, ranges, owner, assignment) => {
      const kindName = valueKindName(assignment)
      if (!ranges?.length || !['date', 'time', 'datetime'].includes(kindName)) return
      const kind = VALUE_KINDS[kindName]
      const done = [], unsure = []
      for (const r of ranges) for (const key of ['value', 'lower', 'upper']) {
        const b = r[key]
        if (b == null || b === '' || !kind.parse(String(b).trim()).invalid) continue
        const got = normaTemporal(b, kindName)
        if (!got) continue
        r[key] = got.text
        done.push(`${show(b)} is ${got.text}`)
        if (got.ambiguous) unsure.push(show(b))
        counts.temporalBounds = (counts.temporalBounds ?? 0) + 1
      }
      if (!done.length) return
      const what = `NORMA keeps the bounds of a value range as typed. In the value range ${owner}, ${done.join(', ')}, written as XML Schema writes ${kindName === 'time' ? 'times' : 'dates'}.`
      if (unsure.length) changed(el, `${what} NORMA writes a bound as typed; ${unsure.join(', ')} ${unsure.length === 1 ? 'is' : 'are'} read month first, as NORMA compares bounds (its invariant culture). Swap day and month if the model was made with day first.`)
      else rewritten(el, what)
    }
    for (const ot of objectTypes) fix(ot, ot.valueRange, `of ${ot.name}`, ot.datatypeAssignment)
    for (const f of facts) f.roles.forEach((r, i) =>
      fix(f, r.valueRange, `on role ${i + 1} of ${factName0(f.id)}`, otById.get(r.objectTypeId)?.datatypeAssignment))
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
  // as F_il_r (role 0 the objectified type, role 1 the original player).
  // An objectified old-style unary has an ObjectifiedUnaryRole (naming its
  // unary role by UnaryRole) where other link fact types have a RoleProxy.
  for (const lf of factEls.filter(f => f.localName === 'ImpliedFact')) {
    const proxy = kid(kid(lf, 'FactRoles'), 'RoleProxy') ?? kid(kid(lf, 'FactRoles'), 'ObjectifiedUnaryRole')
    const own = kid(kid(lf, 'FactRoles'), 'Role')
    const orig = roleRef.get(attr(kid(proxy, 'Role') ?? kid(proxy, 'UnaryRole'), 'ref'))
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

  // ── role paths: derivation rules and join paths ───────────────────────────
  const upMemo = new Map()
  const up = (t) => {
    if (upMemo.has(t)) return upMemo.get(t)
    const seen = new Set([t]), todo = [t]
    while (todo.length) { const x = todo.pop(); for (const st of subtypes) if (st.subId === x && !seen.has(st.superId)) { seen.add(st.superId); todo.push(st.superId) } }
    upMemo.set(t, seen)
    return seen
  }
  const paths = makePathTranslator({
    roleRef: (id) => roleRef.get(id), playerOf: playerOfMember, factById, stById,
    typeOf: (id) => playerId.get(id), up, rangesOf: valueRanges,
    functionOf: (id) => functions.get(id), isBooleanType: (id) => implicitBoolean.has(id),
  })
  const failedRules = [], closedNames = []
  // Rules and queries that test an old-style unary's boolean for false, which
  // the translator reads as the unary's negation.
  const negationReads = []
  const factName = (fid) => attr(factEls.find(f => attr(f, 'id') === fid), '_Name') ?? fid
  const noteNegations = (what, el) => {
    const fids = [...new Set(paths.takeNegations())]
    if (!fids.length) return
    const names = fids.map(factName)
    negationReads.push(`${what} (${names.join(', ')})`)
    changed(el, `NORMA's path tests the hidden boolean value of the unar${names.length === 1 ? 'y' : 'ies'} ${names.join(', ')} for false, which literally matches nothing (that value can only be true); FreeFBM reads it as “does not hold”.`)
  }
  for (const { el, path: dp, name } of derivationPaths) {
    const isFact = el.kind !== 'entity' && el.kind !== 'value'
    if (isFact) {
      const r = paths.factRule(el, dp)
      if (r.error) {
        if (!informalEls.has(el)) { failedRules.push(`fact type ${name}: ${r.error}`); changed(el, `NORMA's derivation rule could not be translated (${r.error}); the fact type is marked derived but has no rule.`) }
        continue
      }
      // A fully derived fact type defined by positive linear recursion gets a
      // transitive closure instead. A semi-derived one keeps its recursion:
      // its stored facts feed it too, which FreeFBM reads as a least fixpoint.
      noteNegations(`fact type ${name}`, el)
      const closed = el.derivation === 'derived' && closeLinearRecursion(el, r, factById)
      el.derivationRule = closed || r
      if (closed) {
        count('closedRecursions'); closedNames.push(name)
        rewritten(el, "NORMA's derivation rule uses this fact type itself (linear recursion); it is written with a transitive closure [TC* …] instead, which says the same.")
      }
      count('factRules')
    } else {
      const supers = subtypes.filter(st => st.subId === el.id).map(st => st.superId)
      const r = paths.subtypeRule(el, dp, supers)
      if (r.error) {
        if (!informalEls.has(el)) { failedRules.push(`subtype ${name}: ${r.error}`); changed(el, `NORMA's derivation rule could not be translated (${r.error}); the subtype is marked derived but has no rule.`) }
        continue
      }
      noteNegations(`subtype ${name}`, el)
      el.derivationRule = r.rule
      if (r.skipped) rewritten(el, `${r.skipped} empty path${r.skipped === 1 ? '' : 's'} of NORMA's derivation rule (kept for rules not written yet) ${r.skipped === 1 ? 'was' : 'were'} left out.`)
      count('subtypeRules')
    }
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
  // Internal constraints, which are no FreeFBM constraints but keep NORMA's id:
  const ucById = new Map()      // internal uniqueness: NORMA id → { id, roles }
  const ifById = new Map()      // internal frequency: NORMA id → its entry
  const mandatoryIds = new Set() // simple mandatory: NORMA id = role.mandatoryId

  const mkCon = (c, type, extra = {}) => ({
    id: attr(c, 'id'), kind: 'constraint', constraintType: type, x: 0, y: 0,
    sequences: [], queries: [], frequency: null, exhaustive: true, exclusive: false, subtypeIds: [],
    ...(attr(c, 'Modality') === 'Deontic' && { deontic: true }),
    ...extra,
  })
  // seqEls: the RoleSequence elements, which hold each sequence's join path
  const setQueries = (con, seqs, seqEls, outputTarget = false) => {
    let pending = false
    con.queries = seqs.map((ms, i) => {
      const jp = path(seqEls[i], 'JoinRule', 'JoinPath')
      const automatic = !jp || attr(jp, 'IsAutomatic') === 'true'
      let g = autoJoin(ms, automatic, outputTarget)
      if (g === undefined) return null
      if (g === null && jp) {
        const crIds = kids(seqEls[i]).map(e => attr(e, 'id'))
        const q = paths.joinQuery(jp, (id) => crIds.indexOf(id), ms.map(playerOfMember), outputTarget)
        if (q.error) {
          failedJoins.push(`${attr(seqEls[i].closest('[Name]'), 'Name') ?? con.id}: ${q.error}`)
          changed(con, `NORMA's join path of ${seqs.length > 1 ? `sequence ${i + 1}` : 'the role sequence'} could not be translated (${q.error}); the sequence is imported without it, so the constraint says something else until a query is added.`)
          pending = true
          return null
        }
        count('translatedJoins')
        noteNegations(`the join path of ${attr(seqEls[i].closest('[Name]'), 'Name') ?? con.id}`, con)
        if (outputTarget && q.target && !con.targetObjectTypeId) con.targetObjectTypeId = q.target.typeId
        return q
      }
      if (g === null) {
        pending = true
        changed(con, `The roles of ${seqs.length > 1 ? `sequence ${i + 1}` : 'the role sequence'} need a join path that the import could not build; the sequence is imported without it, so the constraint says something else until a query is added.`)
        return null
      }
      if (outputTarget && !con.targetObjectTypeId) con.targetObjectTypeId = g._target
      delete g._target
      return g
    })
    if (pending) { count('pendingJoins'); con._pendingJoin = true }
  }
  const failedJoins = []
  const pushCon = (con, c) => { constraints.push(con); conById.set(con.id, con); conAlias.set(attr(c, 'id'), con.id) }
  // The elements a constraint's members are about, for an import note on a
  // constraint that is not imported.
  const kindLabel = (c) => c.localName.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase()
  const conName = (c) => attr(c, 'Name') ?? attr(c, 'id')
  const membersAbout = (ms) => [...new Set(ms.filter(Boolean).map(m =>
    m.kind === 'subtype' ? stById.get(m.subtypeId) : factById.get(m.factId.split('_il_')[0])).filter(Boolean))]
  const skippedOn = (ms, c, why) => {
    for (const el of membersAbout(ms)) changed(el, `NORMA's ${kindLabel(c)} ${conName(c)} was not imported: ${why}.`)
  }
  const unaryNames = (fids) => [...new Set(fids)].map(factName0).join(", ")
  const unknownMembers = (ms, c) => {
    if (!ms.every(Boolean)) {
      warn(`${c.localName} ${conName(c)} refers to a role FreeFBM does not have; skipped.`)
      skippedOn(ms, c, 'it refers to a role FreeFBM does not have')
      return true
    }
    const bool = ms.filter(m => m.kind === 'booleanRole')
    if (bool.length) {
      warn(`${c.localName} ${conName(c)} refers to the hidden boolean role of an old-style unary; skipped.`)
      skippedOn(ms, c, `it refers to the hidden boolean role of the unary ${unaryNames(bool.map(m => m.factId))}, which FreeFBM does not have`)
      return true
    }
    return false
  }
  // Simple mandatory roles (NORMA role ids), for constraints read before the
  // mandatory constraint itself.
  const mandatoryRoles = new Set()
  for (const c of conEls) if (c.localName === 'MandatoryConstraint' && attr(c, 'IsSimple') === 'true'
    && attr(c, 'IsImplied') !== 'true' && attr(c, 'Modality') !== 'Deontic') refsOf(kid(c, 'RoleSequence')).forEach(r => mandatoryRoles.add(r))
  const isMandatoryRole = (rid) => mandatoryRoles.has(rid) || attr(roleEl.get(rid), '_IsMandatory') === 'true'
  const typeName = (tid) => otById.get(tid)?.name ?? factById.get(tid)?.objectifiedName ?? tid

  // An external uniqueness constraint whose sequence has the hidden boolean
  // role of old-style unaries U: that value can only be true, so the
  // constraint is about the instances that U holds for: the boolean role
  // drops out and U(t) becomes a condition (Jan's decision, 2026-11-08). When
  // U is mandatory the condition always holds and the constraint is the
  // uniqueness of the other roles (a preferred identifier stays one); else
  // it is a uniqueness among the instances U holds for, which identifies no
  // type.
  function qualifiedUniqueness(c, ms, seqEl) {
    const id = attr(c, 'id'), name = conName(c)
    const isBool = (m) => m.kind === 'booleanRole'
    const unaries = [...new Set(ms.filter(isBool).map(m => m.factId))].map(fid => factById.get(fid))
    const realMs = ms.filter(m => !isBool(m))
    const uNames = unaryNames(unaries.map(f => f.id))
    const pif = playerId.get(attr(kid(c, 'PreferredIdentifierFor'), 'ref')) ?? null
    if (!realMs.length) { skippedOn(ms, c, `it is only about the hidden boolean role of ${uNames}`); return }
    const deontic = attr(c, 'Modality') === 'Deontic'
    const suggest = 'If the modeller meant whether it holds, model it as a binary to a Boolean value type (Transform › Unary → boolean) and add that role to the constraint.'
    const mandatory = unaries.every(f => isMandatoryRole(f.roles[0].id))
    const what = pif ? `NORMA's preferred identifier ${name} of ${typeName(pif)}` : `NORMA's uniqueness constraint ${name}`
    const position = (crId) => {
      const i = crIdsOf(seqEl).indexOf(crId)
      if (i < 0) return null
      if (isBool(ms[i])) return 'drop'
      return realMs.indexOf(ms[i])
    }
    if (mandatory) {
      const note = `${what} includes the unary ${uNames}, whose hidden boolean value can only be true. ${unaries.length === 1 ? 'That unary is' : 'Those unaries are'} mandatory, so ${unaries.length === 1 ? 'it was' : 'they were'} left out of the constraint, which says the same. ${suggest}`
      unaries.forEach(f => rewritten(f, note))
      // the other roles in one fact type: an internal uniqueness
      const f = factById.get(realMs[0].factId)
      if (f && realMs.every(m => m.kind === 'role' && !m.link && m.factId === f.id) && realMs.length < f.arity) {
        const roles = realMs.map(m => m.roleIndex).sort((a, b) => a - b)
        const same = f.uniqueness.find(u => u.roles.join() === roles.join())
        const uc = same ?? { id, roles }
        if (!same) f.uniqueness.push(uc)
        ucById.set(id, uc)
        const rest = f.roles.filter((_, ri) => !roles.includes(ri))
        if (pif && rest.length === 1 && rest[0].objectTypeId === pif) f.preferredUniqueness.push(roles)
        if (deontic) f.deonticUniqueness = [...(f.deonticUniqueness ?? []), roles]
        rewritten(f, note)
        return
      }
      const con = mkCon(c, 'uniqueness', { sequences: [realMs.map(asMember)], targetObjectTypeId: pif, isPreferredIdentifier: !!pif })
      const g = autoJoin(realMs, true, true)
      if (g) { if (!con.targetObjectTypeId) con.targetObjectTypeId = g._target; delete g._target; con.queries = [g] }
      else if (g === null) con.queries = [conditionalQuery(c, con, realMs, seqEl, position, [])]
      rewritten(con, note)
      pushCon(con, c)
      return
    }
    const con = mkCon(c, 'uniqueness', { sequences: [realMs.map(asMember)], targetObjectTypeId: pif, isPreferredIdentifier: false })
    con.queries = [conditionalQuery(c, con, realMs, seqEl, position, unaries)]
    if (pif) {
      const n = typeName(pif)
      const note = `${what} includes the unary ${uNames}, whose hidden boolean value can only be true. It is read as a uniqueness among the ${n} instances that ${unaries.length === 1 ? 'unary holds' : 'those unaries hold'} for, so it no longer identifies every ${n}, and ${n} has no preferred identifier. ${suggest}`
      changed(con, note)
      unaries.forEach(f => changed(f, note))
    } else {
      rewritten(con, `${what} includes the unary ${uNames}, whose hidden boolean value can only be true; it is written as a uniqueness among the instances that ${unaries.length === 1 ? 'unary holds' : 'those unaries hold'} for, which says the same. ${suggest}`)
    }
    pushCon(con, c)
  }
  const crIdsOf = (seqEl) => kids(seqEl).map(e => attr(e, 'id'))
  // The query of a uniqueness over realMs, from NORMA's join path when there
  // is one (positions of the boolean roles dropped), else joined through the
  // instance t their other roles are played by (or that nests their fact
  // type), with the unaries U(t).
  function conditionalQuery(c, con, realMs, seqEl, position, unaries) {
    const jp = path(seqEl, 'JoinRule', 'JoinPath')
    if (jp) {
      const q = paths.joinQuery(jp, position, realMs.map(playerOfMember), true)
      if (!q.error) {
        count('translatedJoins')
        if (q.target && !con.targetObjectTypeId) con.targetObjectTypeId = q.target.typeId
        return q
      }
      failedJoins.push(`${conName(c)}: ${q.error}`)
      changed(con, `NORMA's join path could not be translated (${q.error}); the sequence is imported without it, so the constraint says something else until a query is added.`)
      count('pendingJoins'); con._pendingJoin = true
      return null
    }
    const subject = unaries[0]?.roles[0].objectTypeId
    // each role's atom from the target t: its fact type's other role, or the
    // implied link when t nests the fact type
    const others = realMs.map(m => {
      const o = otherRole(m)
      if (o && (!subject || o.player === subject)) return o
      if (subject && m.kind === 'role' && !m.link && m.factId === subject) return { link: true, player: subject }
      return null
    })
    const players = new Set([...others.map(o => o?.player), ...unaries.map(f => f.roles[0].objectTypeId)])
    if (others.some(o => !o) || players.size !== 1) {
      changed(con, 'The roles of the sequence need a join path that the import could not build; the sequence is imported without it, so the constraint says something else until a query is added.')
      count('pendingJoins'); con._pendingJoin = true
      return null
    }
    const target = { id: 't', typeId: [...players][0] }
    if (!con.targetObjectTypeId) con.targetObjectTypeId = target.typeId
    const free = realMs.map((m, i) => ({ id: `q${i}`, typeId: playerOfMember(m) }))
    const atoms = realMs.map((m, i) => {
      if (others[i].link) return { t: 'fact', factId: `${m.factId}_il_${m.roleIndex}`, args: [target.id, free[i].id] }
      const args = []
      args[m.roleIndex] = free[i].id
      args[others[i].roleIndex] = target.id
      return { t: 'fact', factId: m.factId, args }
    })
    for (const f of unaries) atoms.push({ t: 'fact', factId: f.id, args: [target.id] })
    return { free, target, body: atoms.length === 1 ? atoms[0] : { t: 'and', args: atoms } }
  }

  for (const c of conEls) {
    const id = attr(c, 'id'), t = c.localName
    const seq = kid(c, 'RoleSequence')
    const seqs = kids(kid(c, 'RoleSequences'), 'RoleSequence')
    if (t === 'UniquenessConstraint') {
      const ms = members(seq)
      if (attr(c, 'IsInternal') === 'true') {
        // On the far role of an objectification's link fact type: the
        // uniqueness of that role in the objectified fact type.
        if (ms.length === 1 && ms[0]?.link && ms[0].roleIndex === 1) {
          const F = factById.get(ms[0].factId.split('_il_')[0]), k = Number(ms[0].factId.split('_il_')[1])
          if (F && !F.uniqueness.some(u => u.roles.length === 1 && u.roles[0] === k)) {
            F.uniqueness.push({ id, roles: [k] })
            rewritten(F, `NORMA's uniqueness constraint on the role of ${typeName(F.roles[k].objectTypeId)} in the link fact type of ${F.objectifiedName || 'this objectification'} is the uniqueness of that role in the objectified fact type, so it is written there.`)
          }
          continue
        }
        if (ms.some(m => m?.kind === 'subtype' || m?.link)) continue   // implied by the subtype link or objectification
        const real = ms.filter(m => m?.kind === 'role')
        if (!real.length) {
          if (ms.some(m => m?.kind === 'booleanRole'))
            skippedOn(ms, c, 'it is on the hidden boolean role of the unary (at most one instance may have the fact), which FreeFBM does not have')
          continue
        }
        const f = factById.get(real[0].factId)
        const roles = real.map(m => m.roleIndex).sort((a, b) => a - b)
        const same = f.uniqueness.find(u => u.roles.join() === roles.join())
        if (same) ucById.set(id, same)
        else { const uc = { id, roles }; f.uniqueness.push(uc); ucById.set(id, uc) }
        // A preferred identifier for the player of the one role left over. NORMA
        // also marks the uniqueness that identifies an objectified fact type
        // itself; FreeFBM takes that from the fact type's uniqueness.
        const pif = playerId.get(attr(kid(c, 'PreferredIdentifierFor'), 'ref'))
        const rest = f.roles.filter((_, ri) => !roles.includes(ri))
        if (pif && rest.length === 1 && rest[0].objectTypeId === pif) f.preferredUniqueness.push(roles)
        if (attr(c, 'Modality') === 'Deontic') f.deonticUniqueness = [...(f.deonticUniqueness ?? []), roles]
        continue
      }
      if (ms.every(Boolean) && ms.some(m => m.kind === 'booleanRole')) { qualifiedUniqueness(c, ms, seq); continue }
      if (unknownMembers(ms, c)) continue
      const pif = attr(kid(c, 'PreferredIdentifierFor'), 'ref')
      const con = mkCon(c, 'uniqueness', {
        sequences: [ms.map(asMember)],
        targetObjectTypeId: pif ? playerId.get(pif) ?? null : null,
        isPreferredIdentifier: !!pif,
      })
      setQueries(con, [ms], [seq], true)
      pushCon(con, c)
    } else if (t === 'MandatoryConstraint') {
      if (attr(c, 'IsImplied') === 'true') { count('impliedMandatory'); continue }
      const ms = members(seq)
      if (attr(c, 'IsSimple') === 'true') {
        const m = ms[0]
        // On the far role of a link fact type: mandatory in the objectified fact type.
        if (m?.link && m.roleIndex === 1) {
          const F = factById.get(m.factId.split('_il_')[0]), role = F?.roles[Number(m.factId.split('_il_')[1])]
          if (role && !role.mandatory) {
            role.mandatory = true; role.mandatoryId = id; mandatoryIds.add(id)
            if (attr(c, 'Modality') === 'Deontic') role.mandatoryDeontic = true
            rewritten(F, `NORMA's mandatory constraint on the role of ${typeName(role.objectTypeId)} in the link fact type of ${F.objectifiedName || 'this objectification'} is the mandatory role in the objectified fact type, so it is written there.`)
          }
          continue
        }
        if (m?.kind === 'booleanRole') { skippedOn(ms, c, 'it is on the hidden boolean role of the unary (some instance must have the fact), which FreeFBM does not have'); continue }
        if (!m || m.kind !== 'role' || m.link) continue   // subtype meta roles and link roles: implied
        const role = factById.get(m.factId).roles[m.roleIndex]
        role.mandatory = true
        role.mandatoryId = id
        mandatoryIds.add(id)
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
      setQueries(con, sms, seqs)
      pushCon(con, c)
    } else if (t === 'RingConstraint') {
      const ms = members(seq)
      if (unknownMembers(ms, c)) continue
      const rt = ringTypes(attr(c, 'Type'))
      if (!rt) {
        warn(`Ring constraint ${attr(c, 'Name')} has a type FreeFBM does not know (${attr(c, 'Type')}); skipped.`)
        skippedOn(ms, c, `its ring type ${attr(c, 'Type')} is one FreeFBM does not know`)
        continue
      }
      const con = mkCon(c, 'ring', { sequences: [ms.map(asMember)], ringTypes: rt })
      setQueries(con, [ms], [seq])
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
        ifById.set(id, f.internalFrequency.at(-1))
        conAlias.set(id, `if:${f.id}`)
      } else {
        const con = mkCon(c, 'frequency', { sequences: [ms.map(asMember)], frequency: range, targetObjectTypeId: null })
        setQueries(con, [ms], [seq], true)
        pushCon(con, c)
      }
    } else if (t === 'ValueComparisonConstraint') {
      const ms = members(seq)
      if (unknownMembers(ms, c)) continue
      const con = mkCon(c, 'valueComparison', { sequences: [ms.map(asMember)],
        operator: VC_OPS[attr(c, 'Operator')] ?? '=', targetObjectTypeId: null })
      setQueries(con, [ms], [seq])
      pushCon(con, c)
    } else {
      warn(`${t} ${attr(c, 'Name') ?? id} is not imported.`)
      skippedOn([seq, ...seqs].flatMap(members), c, 'FreeFBM has no constraint of this kind')
    }
  }

  // ── Definition, Note and custom properties ─────────────────────────────────
  const elementFor = (normaId) => {
    if (otById.has(normaId)) return otById.get(normaId)
    if (factById.has(normaId)) return factById.get(normaId)
    if (playerId.has(normaId) && factById.has(playerId.get(normaId))) return factById.get(playerId.get(normaId))
    if (stById.has(normaId)) return stById.get(normaId)
    if (ucById.has(normaId)) return ucById.get(normaId)
    if (ifById.has(normaId)) return ifById.get(normaId)
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
      implicitLinkPositions: {}, profileId: 'norma', shownImplicitLinks: [], notes: [], expandedRefModes: [],
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
        // FreeFBM's vertical fact type is NORMA's horizontal one turned a
        // quarter clockwise (VerticalRotatedRight): the first role on top,
        // the bars on the right. VerticalRotatedLeft turns it the other way,
        // so the role order is reversed and the bars change side.
        const orient = attr(s, 'DisplayOrientation')
        const turnedLeft = orient === 'VerticalRotatedLeft'
        if (orient && orient.startsWith('Vertical')) occ.orientation = 'vertical'
        if ((attr(s, 'ConstraintDisplayPosition') === 'Bottom') !== turnedLeft) occ.uniquenessBelow = true
        const rdo = refsOf(kid(s, 'RoleDisplayOrder')).filter(r => f.roles.some(x => x.id === r))
        const display = [...(rdo.length === f.arity ? rdo : f._normaRoleOrder)]
        if (turnedLeft) display.reverse()
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
        // FreeFBM's note font is smaller than NORMA's: keep the left edge and
        // take the narrowest width that wraps the text the same way, and
        // the height that leaves as much room below the text as above it.
        // The top left corner stays where NORMA has it.
        const w0 = Math.max(80, b.w), h0 = Math.max(40, b.h)
        const w = narrowestNoteWidth(mn.text, w0)
        const h = fittingNoteHeight(mn.text, w) ?? h0
        diag.notes.push({ id: nid, x: b.cx - (w0 - w) / 2, y: b.cy - (h0 - h) / 2, w, h, text: mn.text,
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
    // subtype links: NORMA draws no shape for them, so link the closest pair
    // of shapes (a type can be drawn more than once on a diagram)
    diag.subtypeOccurrences = []
    diag.subtypeEndpointOccs = {}
    for (const st of subtypes) {
      let best = null, bestD = Infinity
      for (const sub of occsOf(st.subId)) {
        if (sub.refModeOwnerOccId) continue
        const sup = nearest(st.superId, sub.x, sub.y, o => !o.refModeOwnerOccId)
        const d = sup ? Math.hypot(sup.x - sub.x, sup.y - sub.y) : Infinity
        if (d < bestD) { bestD = d; best = { subOccId: sub.id, superOccId: sup.id } }
      }
      if (!best) continue
      diag.subtypeOccurrences.push(st.id)
      diag.subtypeEndpointOccs[st.id] = [best]
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
  // NORMA's ORMDiagramDynamicColor roles → group colour channels (utils/groups.js)
  const COLOR_ROLES = { Outline: 'outline', Background: 'fill', ForegroundText: 'text',
    ForegroundGraphics: 'graphics', FloatingText: 'floating', Constraint: 'constraint',
    DeonticConstraint: 'deontic', RolePlayerConnector: 'connector' }
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
      if (mandatoryIds.has(ref)) { memberIds.push(ref); continue }
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
      implicitLinkPositions: {}, profileId: 'norma', shownImplicitLinks: [], expandedRefModes: [], expandedRefModeOccs: [],
      pan: { x: 0, y: 0 }, zoom: 1,
      notes: [...modelNotes].filter(([id, mn]) => !notesShown.has(id) && !mn.refs.length)
        .map(([id, mn], i) => ({ id, x: 140 + (i % 4) * 260, y: 100 + Math.floor(i / 4) * 140, w: 240, h: 120, text: mn.text, connectors: [] })) }
    diagrams.push(diag)
  }
  for (const [el, lines] of notesFor) el.note = [el.note, ...lines].filter(Boolean).join('\n')

  // A rule or join path that negates a unary NORMA pairs with a negation:
  // NORMA may have meant either "not known to hold" or the negation.
  if (negationPairs.size) {
    const negated = (node, inNot, out) => {
      if (!node || typeof node !== 'object') return out
      if (Array.isArray(node)) { for (const x of node) negated(x, inNot, out); return out }
      if (node.t === 'fact' && inNot && negationPairs.has(node.factId)) out.add(node.factId)
      for (const [k, v] of Object.entries(node)) if (k !== 'factId') negated(v, inNot || node.t === 'not', out)
      return out
    }
    const check = (el, rule) => {
      const fids = [...negated(rule, false, new Set())]
      if (!fids.length) return
      const what = fids.map(fid => `not ${factName0(fid)}`).join(', ')
      const negs = fids.map(fid => factName0(negationPairs.get(fid))).join(', ')
      changed(el, `This ${el.kind === 'constraint' ? 'join path' : 'rule'} says ${what}, a unary that NORMA pairs with a negation. NORMA may have meant the negation ${negs}; FreeFBM reads “not” as “not known to hold”, which includes unknown. Use the negation instead if that was meant.`)
    }
    for (const el of [...objectTypes, ...facts]) if (el.derivationRule) check(el, el.derivationRule)
    for (const c of constraints) if (c.queries) check(c, c.queries)
  }

  // ── log ───────────────────────────────────────────────────────────────────
  const unused = (n, what) => n ? [`${n} ${what}`] : []
  const crm = kids(kid(model, 'CustomReferenceModes')).length
  log.unshift({ level: 'note', text: `Imported ${objectTypes.length} object types, ${facts.length} fact types (${facts.filter(f => f.objectified).length} objectified), ${subtypes.length} subtype links, ${constraints.length} external constraints, ${groups.length} groups, ${propertyDefinitions.length} custom property definitions and ${diagrams.length} diagrams.` })
  if (counts.negatableUnaries) note(`${counts.negatableUnaries} unar${counts.negatableUnaries === 1 ? 'y is' : 'ies are'} paired with a negation in NORMA (true, false or unknown); each pair is kept as two unaries under the closed-world assumption ("is known to …", "is known not to …") with the exclusion NORMA gives them; see their import notes.`)
  const nImportNotes = [...objectTypes, ...facts, ...subtypes, ...constraints].reduce((n, el) => n + (el.importNotes?.length ?? 0), 0)
  if (nImportNotes) note(`${nImportNotes} import note${nImportNotes === 1 ? ' says' : 's say'} what was adapted to FreeFBM, on the elements concerned; they are listed under Import in the Validation panel and marked ✎ on the diagrams.`)
  if (counts.temporalBounds) note(`${counts.temporalBounds} date or time bound${counts.temporalBounds === 1 ? ' of a value range is' : 's of value ranges are'} written as XML Schema does (1900-01-01); NORMA keeps them as typed (such as 1900/01/01).`)
  if (counts.unaries) note(`${counts.unaries} unary fact types were stored by NORMA as binaries with an implicit boolean value type; they are unaries here.`)
  const skippedImplied = [...unused(counts.impliedObjectification, 'implied objectifications'), ...unused(counts.impliedMandatory, 'implied mandatory constraints')]
  if (skippedImplied.length) note(`Skipped what NORMA implies and FreeFBM derives itself: ${skippedImplied.join(', ')}.`)
  if (counts.factRules || counts.subtypeRules || counts.translatedJoins)
    note(`Translated ${counts.factRules ?? 0} fact type and ${counts.subtypeRules ?? 0} subtype derivation rules${counts.translatedJoins ? ` and ${counts.translatedJoins} join paths` : ''} from NORMA's role paths into formulas.`)
  if (closedNames.length) note(`The recursive derivation rule${closedNames.length === 1 ? '' : 's'} of ${closedNames.join(', ')} ${closedNames.length === 1 ? 'was' : 'were'} rewritten with a transitive closure [TC* …], which says the same under least-fixpoint semantics without the fact type referring to itself.`)
  if (negationReads.length) note(`A test that an old-style unary's boolean value is false matches nothing literally (NORMA restricted that value to true), so it was read as the unary's negation in ${negationReads.join('; ')}.`)
  if (informalOnly.length) warn(`${informalOnly.length === 1 ? 'One element has' : `${informalOnly.length} elements have`} only an informal derivation rule, kept in ${informalOnly.length === 1 ? 'its' : 'their'} note and listed as incomplete by validation: ${informalOnly.join(', ')}.`)
  for (const f of failedRules) warn(`The derivation rule of ${f}; it is marked derived but has no rule, so validation lists it as incomplete.`)
  for (const f of failedJoins) warn(`The join path of ${f}; the sequence is imported without it.`)
  if (counts.pendingJoins) warn(`${counts.pendingJoins} constraints have a join path that could not be translated; their sequences are imported without it.`)
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
