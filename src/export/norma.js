// NORMA .orm export (milestone 1 of docs/norma-export.md).
//
// exportNorma(state, { schemaId, name }) writes one ORM2 schema of the store's
// state as a NORMA file and returns { xml, report }: report lists what the
// export left out or adapted ({ level: 'note' | 'warn', text }), in the style
// of the import log.
//
// Milestone 1 covers entity and value types (data types, reference modes),
// fact types with their readings, internal uniqueness (preferred identifiers
// included), simple mandatory roles, subtype links, and the diagram shapes of
// object types and fact types. Everything else is listed in the report.
//
// The geometry is the importer's read backwards (src/import/norma.js): 200 px
// per inch, an object type's shape centred on its occurrence with NORMA's
// size around its name, a fact type's shape around its role boxes with a band
// per level of uniqueness bars on the bars' side (factRoleMiddle).
//
// Ids: an element imported from NORMA keeps its GUID; other ids are a hash of
// the FreeFBM id and the element's part in the file, written as a GUID, so
// that exporting twice gives the same file.

import { NORMA, inches } from '../diagram/normaGeometry.js'
import { readingLabelSize, rangeLabelSize, roleNameLabelSize, nameLabelSize, roleAnchor, nameAnchor, factLabelBox, objectTypeLabelBox } from '../import/normaLabels.js'
import { otBoxSize } from '../components/ObjectTypeNode.jsx'
import { findRefMode, refModeLabel } from '../utils/refMode.js'
import { derivationMark } from '../logic/derivationRule.js'
import { datatypeAssignmentToKind } from '../utils/datatypeMapping.js'
import { makeContext, constraintEntry } from '../logic/constraintFormulas.js'
import { factDerivationEntries } from '../logic/factDerivation.js'
import { derivationEntry } from '../logic/derivationRule.js'
import { renderFormula } from '../logic/renderFormula.js'

const NS = {
  cp: 'http://schemas.neumont.edu/ORM/2007-11/CustomProperties',
  shapeGroup: 'http://www.ormsolutions.com/NORMA/2009-01/ShapeGrouping',
  orm: 'http://schemas.neumont.edu/ORM/2006-04/ORMCore',
  ormDiagram: 'http://schemas.neumont.edu/ORM/2006-04/ORMDiagram',
  ormRoot: 'http://schemas.neumont.edu/ORM/2006-04/ORMRoot',
}
const BASE_FONT_SIZE = '0.0972222238779068'   // 7 pt in inches, as NORMA writes it
const PX = 200   // px per inch (normaGeometry's PX_PER_INCH)

// ── ids ─────────────────────────────────────────────────────────────────────

const GUID_RE = /^_[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$/

// cyrb128: four 32-bit hashes of the string, 128 bits in all.
function hash128(str) {
  let h1 = 1779033703, h2 = 3144134277, h3 = 1013904242, h4 = 2773480762
  for (let i = 0; i < str.length; i++) {
    const k = str.charCodeAt(i)
    h1 = h2 ^ Math.imul(h1 ^ k, 597399067)
    h2 = h3 ^ Math.imul(h2 ^ k, 2869860233)
    h3 = h4 ^ Math.imul(h3 ^ k, 951274213)
    h4 = h1 ^ Math.imul(h4 ^ k, 2716044179)
  }
  h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067)
  h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233)
  h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213)
  h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179)
  h1 ^= (h2 ^ h3 ^ h4); h2 ^= h1; h3 ^= h1; h4 ^= h1
  return [h1, h2, h3, h4].map(h => (h >>> 0).toString(16).padStart(8, '0')).join('')
}

// A NORMA id for a FreeFBM id (and a part of it): the id itself when it is
// already one of NORMA's GUIDs, else a hash written as a GUID (version 4
// layout, so that tools reading GUIDs accept it).
export function normaId(id, part = '') {
  if (!part && GUID_RE.test(id)) return id.toUpperCase()
  const h = hash128(`freefbm:${id}${part ? '#' + part : ''}`).toUpperCase()
  const v = (n) => ((parseInt(n, 16) & 0x3) | 0x8).toString(16).toUpperCase()
  return `_${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${v(h[16])}${h.slice(17, 20)}-${h.slice(20, 32)}`
}

// ── XML ─────────────────────────────────────────────────────────────────────

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  // characters XML 1.0 does not allow
  .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')

// A tiny element builder: el('orm:Role', { id, Name }, [children]) or text.
function el(name, attrs = {}, children = null) {
  return { name, attrs, children }
}
function write(node, depth, out) {
  // a lazy node is resolved when the file is written (notes collected while building)
  if (node.lazy) { const n = node.lazy(); if (n) write(n, depth, out); return }
  const pad = '\t'.repeat(depth)
  const a = Object.entries(node.attrs).filter(([, v]) => v != null && v !== false)
    .map(([k, v]) => ` ${k}="${esc(v).replace(/\r/g, '&#xD;').replace(/\n/g, '&#xA;').replace(/\t/g, '&#x9;')}"`).join('')
  const kids = Array.isArray(node.children) ? node.children.filter(Boolean) : node.children
  if (kids == null || (Array.isArray(kids) && !kids.length)) { out.push(`${pad}<${node.name}${a} />`); return }
  if (!Array.isArray(kids)) { out.push(`${pad}<${node.name}${a}>${esc(kids)}</${node.name}>`); return }
  out.push(`${pad}<${node.name}${a}>`)
  for (const k of kids) write(k, depth + 1, out)
  out.push(`${pad}</${node.name}>`)
}

// Numbers as NORMA writes them: plain decimals.
const num = (x) => String(Math.round(x * 1e10) / 1e10)
const boundsAttr = (l, t, w, h) => [l, t, w, h].map(num).join(', ')

// ── data types ──────────────────────────────────────────────────────────────

const DT_CATEGORIES = ['RawData', 'Numeric', 'Temporal', 'Logical', 'Text', 'Other']
// NORMA profile id → NORMA element (NumericUnsignedInteger → UnsignedIntegerNumericDataType)
function normaDataTypeElement(datatypeId) {
  const cat = DT_CATEGORIES.find(c => datatypeId?.startsWith(c))
  if (!cat) return null
  return `${datatypeId.slice(cat.length)}${cat}DataType`
}
// The nearest NORMA type for a datatype of another profile, by its kind.
const KIND_TO_NORMA = {
  text: 'TextVariableLength', integer: 'NumericSignedInteger', decimal: 'NumericDecimal',
  boolean: 'LogicalTrueOrFalse', date: 'TemporalDate', datetime: 'TemporalDateAndTime', time: 'TemporalTime',
}

// ── ranges and constraint attributes ────────────────────────────────────────

// FreeFBM range specs (src/import/norma.js rangeSpec) → NORMA ValueRange attributes
function valueRangeAttrs(r) {
  const open = (b) => b ? 'Open' : null
  if (r.type === 'single') return { MinValue: r.value, MaxValue: r.value }
  if (r.type === 'range') return { MinValue: r.lower, MaxValue: r.upper, MinInclusion: open(r.lowerOpen), MaxInclusion: open(r.upperOpen) }
  if (r.type === 'lower') return { MinValue: r.lower, MaxValue: '', MinInclusion: open(r.lowerOpen) }
  if (r.type === 'upper') return { MinValue: '', MaxValue: r.upper, MaxInclusion: open(r.upperOpen) }
  return null
}
// count ranges (frequency, cardinality) → [min, max], max 0 meaning unbounded
function countBounds(ranges) {
  const r = (ranges ?? [])[0]
  if (!r) return [1, 0]
  if (r.type === 'single') return [Number(r.value), Number(r.value)]
  if (r.type === 'range') return [Number(r.lower), Number(r.upper)]
  if (r.type === 'lower') return [Number(r.lower), 0]
  if (r.type === 'upper') return [1, Number(r.upper)]
  return [1, 0]
}
const frequencyAttrs = (ranges) => { const [min, max] = countBounds(ranges); return { MinFrequency: min, MaxFrequency: max } }
function frequencyText(ranges) {
  const [min, max] = countBounds(ranges)
  return max === 0 ? `≥ ${min}` : min === max ? String(min) : min <= 1 ? `≤ ${max}` : `${min}..${max}`
}
const RING_NAMES = { 'purely-reflexive': 'PurelyReflexive', 'strongly-intransitive': 'StronglyIntransitive', irreflexive: 'Irreflexive',
  reflexive: 'Reflexive', antisymmetric: 'Antisymmetric', asymmetric: 'Asymmetric', symmetric: 'Symmetric', intransitive: 'Intransitive',
  transitive: 'Transitive', acyclic: 'Acyclic' }
// NORMA's ring types (RingConstraintTypeValues in ORM2Core.xsd): fixed combinations
const RING_TYPES = new Set(['Reflexive', 'Irreflexive', 'PurelyReflexive', 'Symmetric', 'Antisymmetric', 'Asymmetric', 'Transitive',
  'Intransitive', 'StronglyIntransitive', 'Acyclic', 'AcyclicTransitive', 'AcyclicIntransitive', 'AcyclicStronglyIntransitive',
  'ReflexiveSymmetric', 'ReflexiveAntisymmetric', 'ReflexiveTransitive', 'ReflexiveTransitiveAntisymmetric', 'SymmetricTransitive',
  'SymmetricIrreflexive', 'SymmetricIntransitive', 'SymmetricStronglyIntransitive', 'AsymmetricIntransitive',
  'AsymmetricStronglyIntransitive', 'TransitiveIrreflexive', 'TransitiveAntisymmetric', 'TransitiveAsymmetric'])
const permutations = (xs) => xs.length <= 1 ? [xs] : xs.flatMap((x, i) => permutations([...xs.slice(0, i), ...xs.slice(i + 1)]).map(p => [x, ...p]))
function ringTypeName(types) {
  const words = [...new Set((types ?? []).map(t => RING_NAMES[t]).filter(Boolean))]
  if (!words.length || words.length > 3) return null
  return permutations(words).map(p => p.join('')).find(n => RING_TYPES.has(n)) ?? null
}
const VC_OPS = { Equal: '=', NotEqual: '≠', LessThan: '<', LessThanOrEqual: '≤', GreaterThan: '>', GreaterThanOrEqual: '≥' }

// ── export ──────────────────────────────────────────────────────────────────

export function exportNorma(state, { schemaId = null, name = null } = {}) {
  const report = []
  const note = (text) => report.push({ level: 'note', text })
  const warn = (text) => report.push({ level: 'warn', text })

  const schemas = state.schemas ?? []
  const schema = schemas.find(s => s.id === schemaId) ?? schemas.find(s => s.profile !== 'relational') ?? null
  const sid = schema?.id ?? null
  const inSchema = (x) => !sid || schemas.length <= 1 || x.schemaId === sid || x.schemaId == null
  const objectTypes = (state.objectTypes ?? []).filter(inSchema)
  const facts = (state.facts ?? []).filter(inSchema)
  const subtypes = (state.subtypes ?? []).filter(inSchema)
  const constraints = (state.constraints ?? []).filter(inSchema)
  const diagrams = (state.diagrams ?? []).filter(d => inSchema(d) && !d.mappingId && d.kind !== 'mapping')
  const modelName = name || schema?.name || 'Model'

  const otById = new Map(objectTypes.map(o => [o.id, o]))
  const factById = new Map(facts.map(f => [f.id, f]))
  // FreeFBM's formulas as text, for informal rules and notes
  let ctx = null
  try { ctx = makeContext(state) } catch { ctx = null }
  const formulaText = (entry) => {
    if (!entry?.formula || !ctx) return null
    try { return renderFormula(entry.formula, ctx).map(t => t.text).join('') } catch { return null }
  }
  const safe = (fn) => { try { return fn() } catch { return null } }
  // FreeFBM's remarks about what NORMA cannot take as it is: in the note of
  // the element concerned (NORMA's Notes window shows it), starting with
  // "FreeFBM:" so that the importer can leave them out again
  const ffNotes = []
  let derivedInformal = 0
  const elementRemarks = new Map()   // FreeFBM element id → remarks
  const ffNote = (targets, text) => {
    const t = targets.filter(Boolean)
    ffNotes.push({ targets: t, text: `FreeFBM: ${text}` })
    if (t[0]) elementRemarks.set(t[0], [...(elementRemarks.get(t[0]) ?? []), `FreeFBM: ${text}`])
  }
  const propDefs = (state.propertyDefinitions ?? []).filter(d => d?.id)
  const propDefIds = new Set(propDefs.map(d => d.id))
  const skipped = {}   // what milestone 1 leaves out → count
  const skip = (what, n = 1) => { skipped[what] = (skipped[what] ?? 0) + n }

  // Objectifications. FreeFBM's objectified fact types, and the ones NORMA
  // objectifies implicitly: a fact type with more than two roles or an
  // alethic internal uniqueness over more than one role, unless it is fully
  // derived (NORMA's IsImpliedObjectificationRequired). NORMA adds an implied
  // one it does not find while it loads, which its debug build reports as a
  // failed assertion, so the export writes them as NORMA saves them.
  const nests = new Map()            // fact id → { implied }
  for (const f of facts) {
    const deonticKeys = new Set((f.deonticUniqueness ?? []).map(r => [...r].sort((a, b) => a - b).join(',')))
    if (f.objectified) nests.set(f.id, { implied: false })
    // (fully derived ones are exempt; their rules are exported as informal rules)
    else if (f.derivation !== 'derived' && (f.roles.length > 2
      || (f.uniqueness ?? []).some(u => u.roles.length > 1 && !deonticKeys.has([...u.roles].sort((a, b) => a - b).join(',')))))
      nests.set(f.id, { implied: true })
  }
  const nestId = (fid) => normaId(fid, 'nesting-type')
  // a role's player: an object type, or an objectified fact type
  const playerOf = (role) => otById.has(role.objectTypeId) || nests.get(role.objectTypeId)?.implied === false ? role.objectTypeId : null
  const playerRef = (id) => otById.has(id) ? normaId(id) : nestId(id)
  const pascal = (text) => text.split(/[^\p{L}\p{N}]+/u).filter(Boolean).map(w => w[0].toUpperCase() + w.slice(1)).join('')

  // ── names NORMA wants unique ─────────────────────────────────────────────
  const counters = {}
  const autoName = (base) => `${base}${counters[base] = (counters[base] ?? 0) + 1}`

  // ── reference modes ──────────────────────────────────────────────────────
  // NORMA finds a reference mode from the value type's name and the format
  // of its kind ({0} the entity type, {1} the mode): Person_nr with NORMA's
  // default popular format {0}_{1}. The popular kind gets the format most of
  // the model's value types follow (PersonNr: {0}{1}); a mode named otherwise
  // gets a custom mode with its own format.
  const refModes = new Map()         // entity id → { vtId, factId, vtRoleIndex, mode, kind, format }
  const customModes = new Map()      // mode name → { format, kind }
  for (const ot of objectTypes) {
    if (ot.kind !== 'entity') continue
    const rm = findRefMode(ot, facts, objectTypes)
    const vt = rm && otById.get(rm.vtId)
    if (!vt) continue
    const label = refModeLabel(ot.name, vt.name, ot)
    let mode, kind, format
    if (ot.refModeKind === 'unit') { mode = ot.refModeName ?? label.replace(/:$/, ''); kind = 'UnitBased'; format = '{1}Value' }
    else if (label.startsWith('.') && vt.name.startsWith(ot.name)) {
      // the mode as the value type's name writes it, after the separator
      const rest = vt.name.slice(ot.name.length)
      const sep = /^[\s_-]*/.exec(rest)[0]
      mode = ot.refModeName && rest.slice(sep.length).toLowerCase() === ot.refModeName.toLowerCase() ? ot.refModeName : rest.slice(sep.length)
      kind = 'Popular'
      format = rest.slice(sep.length) === mode ? `{0}${sep}{1}` : `{0}${rest}`
    } else { mode = vt.name; kind = 'General'; format = '{1}' }
    refModes.set(ot.id, { ...rm, mode, kind, format })
  }
  const formatCount = new Map()
  for (const r of refModes.values()) if (r.kind === 'Popular' && r.format.includes('{1}')) formatCount.set(r.format, (formatCount.get(r.format) ?? 0) + 1)
  const popularFormat = [...formatCount].sort((a, b) => b[1] - a[1])[0]?.[0] ?? '{0}_{1}'
  const kindFormat = { General: '{1}', Popular: popularFormat, UnitBased: '{1}Value' }
  for (const [otId, r] of refModes) {
    if (r.format === kindFormat[r.kind]) continue
    const known = customModes.get(r.mode)
    if (!known) customModes.set(r.mode, { format: r.format, kind: r.kind })
    else if (known.format !== r.format) warn(`The reference mode “${r.mode}” of ${otById.get(otId).name} names its value type differently from another entity type's; NORMA has one name format per mode, so it may show the value type instead of the mode.`)
  }

  // ── data types ───────────────────────────────────────────────────────────
  const dataTypes = new Map()        // NORMA element name → id
  const dataTypeId = (elName) => {
    if (!dataTypes.has(elName)) dataTypes.set(elName, normaId(`datatype:${elName}`))
    return dataTypes.get(elName)
  }
  const unspecified = []
  const approximated = []
  function conceptualDataType(ot) {
    const a = ot.datatypeAssignment
    let normaDt = null, params = {}
    if (a?.profileId === 'norma') { normaDt = a.datatypeId; params = a.params ?? {} }
    else if (a) {
      normaDt = KIND_TO_NORMA[datatypeAssignmentToKind(a)] ?? 'TextVariableLength'
      approximated.push(`${ot.name} (${a.datatypeId} → ${normaDt})`)
      // FreeFBM's abstract types (text, integer, …) each have a NORMA type; others are a choice worth a note
      if (a.profileId !== 'abstract') ffNote([ot.id], `the data type of ${ot.name} is ${a.datatypeId} (${a.profileId} profile) in FreeFBM; NORMA has no such type, so it is written as the nearest NORMA type, ${normaDt.replace(/([a-z])([A-Z])/g, '$1 $2')}.`)
    }
    const elName = normaDt ? normaDataTypeElement(normaDt) : null
    if (!elName) { unspecified.push(ot.name); return el('orm:ConceptualDataType', { id: normaId(ot.id, 'cdt'), ref: dataTypeId('UnspecifiedDataType'), Scale: 0, Length: 0 }) }
    const length = params.length ?? params.precision ?? 0
    return el('orm:ConceptualDataType', { id: normaId(ot.id, 'cdt'), ref: dataTypeId(elName), Scale: params.scale ?? 0, Length: length })
  }

  // ── internal constraints ─────────────────────────────────────────────────
  // Per fact type: its uniqueness constraints and mandatory roles, with the
  // ones a preferred identifier implies (FreeFBM draws them, NORMA stores them).
  const conEls = []                 // orm:Constraints children
  const internalRefs = new Map()    // fact id → [constraint ref elements]
  const preferredFor = new Map()    // entity id → uniqueness constraint id
  const roleIdOf = (f, i) => normaId(f.roles[i].id)
  const seqEl = (conId, roleIds) => el('orm:RoleSequence', {}, roleIds.map((rid, i) => el('orm:Role', { id: normaId(conId, `seq${i}`), ref: rid })))
  const addInternal = (factId, kind, conId) => {
    internalRefs.set(factId, [...(internalRefs.get(factId) ?? []), el(`orm:${kind}`, { ref: conId })])
  }
  let impliedCount = 0
  // An external preferred identifier implies, in each binary it spans, a
  // uniqueness and a mandatory on the identified type's role (FreeFBM draws
  // them without storing them, as for internal ones).
  const impliedByExternal = new Map()   // fact id → Set of role indexes
  for (const c of constraints) {
    if (c.constraintType !== 'uniqueness' || !c.isPreferredIdentifier || !c.targetObjectTypeId) continue
    for (const m of c.sequences?.[0] ?? []) {
      const f = m.kind === 'role' && factById.get(m.factId)
      if (!f || f.roles.length !== 2) continue
      const other = 1 - m.roleIndex
      if (f.roles[other]?.objectTypeId === c.targetObjectTypeId) impliedByExternal.set(f.id, new Set([...(impliedByExternal.get(f.id) ?? []), other]))
    }
  }
  for (const f of facts) {
    const ucs = (f.uniqueness ?? []).map(u => ({ ...u, roles: [...u.roles].sort((a, b) => a - b) }))
    const key = (roles) => [...roles].sort((a, b) => a - b).join(',')
    const mandatory = f.roles.map(r => !!r.mandatory)
    for (const ri of impliedByExternal.get(f.id) ?? []) {
      if (!ucs.some(u => key(u.roles) === String(ri))) { ucs.push({ id: `${f.id}#implied-uc${ri}`, roles: [ri] }); impliedCount++ }
      if (!mandatory[ri]) { mandatory[ri] = 'implied'; impliedCount++ }
    }
    // implied by preferred identifiers
    for (const pu of f.preferredUniqueness ?? []) {
      f.roles.forEach((r, ri) => {
        if (pu.includes(ri)) return
        if (!ucs.some(u => key(u.roles) === String(ri))) { ucs.push({ id: `${f.id}#implied-uc${ri}`, roles: [ri] }); impliedCount++ }
        if (!mandatory[ri]) { mandatory[ri] = 'implied'; impliedCount++ }
      })
    }
    const deontic = new Set((f.deonticUniqueness ?? []).map(key))
    const preferred = new Set((f.preferredUniqueness ?? []).map(key))
    for (const u of ucs) {
      if (!u.roles.length || u.roles.some(ri => !f.roles[ri])) continue
      const id = normaId(u.id)
      const rest = f.roles.map((r, ri) => ({ r, ri })).filter(x => !u.roles.includes(x.ri))
      let pif = null
      const restPlayer = rest.length === 1 ? rest[0].r.objectTypeId : null
      if (preferred.has(key(u.roles)) && restPlayer && (otById.get(restPlayer)?.kind === 'entity' || nests.get(restPlayer)?.implied === false)) pif = restPlayer
      // the uniqueness that identifies the objectified fact type itself: the
      // one FreeFBM marks, else (as NORMA picks) the first alethic one over more than one role
      else if (nests.has(f.id) && (Array.isArray(f.objectifiedIdentifier) ? key(f.objectifiedIdentifier) === key(u.roles)
        : u.roles.length > 1 && !deontic.has(key(u.roles)))) pif = f.id
      if (pif && !preferredFor.has(pif)) preferredFor.set(pif, id)
      else pif = null
      conEls.push(el('orm:UniquenessConstraint', { id, Name: autoName('InternalUniquenessConstraint'), IsInternal: 'true',
        Modality: deontic.has(key(u.roles)) ? 'Deontic' : null }, [
        seqEl(u.id, u.roles.map(ri => roleIdOf(f, ri))),
        pif && el('orm:PreferredIdentifierFor', { ref: playerRef(pif) }),
      ]))
      addInternal(f.id, 'UniquenessConstraint', id)
    }
    f.roles.forEach((r, ri) => {
      if (!mandatory[ri]) return
      const cid = mandatory[ri] === 'implied' ? `${f.id}#implied-m${ri}` : (r.mandatoryId ?? `${r.id}#mandatory`)
      const id = normaId(cid)
      conEls.push(el('orm:MandatoryConstraint', { id, Name: autoName('SimpleMandatoryConstraint'), IsSimple: 'true',
        Modality: r.mandatoryDeontic ? 'Deontic' : null }, [seqEl(cid, [roleIdOf(f, ri)])]))
      addInternal(f.id, 'MandatoryConstraint', id)
    })
    // internal frequency: a frequency constraint over roles of this fact type
    for (const ifr of f.internalFrequency ?? []) {
      if (!ifr.roles?.length || ifr.roles.some(ri => !f.roles[ri])) continue
      conEls.push(el('orm:FrequencyConstraint', { id: normaId(ifr.id), Name: autoName('FrequencyConstraint'), ...frequencyAttrs(ifr.range),
        Modality: ifr.deontic ? 'Deontic' : null }, [seqEl(ifr.id, ifr.roles.map(ri => roleIdOf(f, ri)))]))
    }
  }

  // ── external constraints ─────────────────────────────────────────────────
  // A member is a role (of a fact type, or of an objectification's link fact
  // type, factId F_il_i) or a subtype link, which NORMA constrains through
  // its supertype meta role.
  const memberRef = (m) => {
    if (m?.kind === 'subtype') return normaId(m.subtypeId, 'super')
    if (m?.kind !== 'role') return null
    const link = /^(.*)_il_(\d+)$/.exec(m.factId ?? '')
    if (link) {
      if (!nests.has(link[1])) return null
      return m.roleIndex === 0 ? normaId(link[1], `link${link[2]}-role`) : normaId(link[1], `link${link[2]}-proxy`)
    }
    const f = factById.get(m.factId)
    return f?.roles[m.roleIndex] ? roleIdOf(f, m.roleIndex) : null
  }
  const shapeOf = new Map()        // FreeFBM constraint id → NORMA constraint id the shape shows, shape kind
  const joinsLeft = []
  const conNames = { uniqueness: 'ExternalUniquenessConstraint', inclusiveOr: 'InclusiveOrConstraint', exclusiveOr: 'ExclusiveOrConstraint',
    exclusion: 'ExclusionConstraint', equality: 'EqualityConstraint', subset: 'SubsetConstraint', ring: 'RingConstraint',
    frequency: 'FrequencyConstraint', valueComparison: 'ValueComparisonConstraint' }
  for (const c of constraints) {
    const seqs = (c.sequences ?? []).map(sq => sq.map(memberRef))
    const label = c.name || conNames[c.constraintType] || c.constraintType
    if (!seqs.length || seqs.some(sq => !sq.length || sq.some(r => !r))) {
      skip(`external constraints on elements the export leaves out (${label})`)
      const text = formulaText(safe(() => constraintEntry(c, ctx)))
      ffNote((c.sequences ?? []).flat().map(m => m.factId?.split('_il_')[0] ?? null), `the constraint ${label} is about elements NORMA does not have, so it was left out.${text ? ` FreeFBM's formula: ${text}` : ''}`)
      continue
    }
    const id = normaId(c.id)
    const name = c.name || autoName(conNames[c.constraintType] ?? 'Constraint')
    const modality = c.deontic ? 'Deontic' : null
    const roleSeq = (key, refs) => el('orm:RoleSequence', {}, refs.map((r, i) => el('orm:Role', { id: normaId(c.id, `${key}${i}`), ref: r })))
    const roleSeqs = () => el('orm:RoleSequences', {}, seqs.map((sq, k) => el('orm:RoleSequence', { id: normaId(c.id, `seq${k}`) },
      sq.map((r, i) => el('orm:Role', { id: normaId(c.id, `seq${k}r${i}`), ref: r })))))
    const flat = seqs.flat()
    switch (c.constraintType) {
      case 'uniqueness': {
        const target = c.isPreferredIdentifier && c.targetObjectTypeId && (otById.has(c.targetObjectTypeId) || nests.get(c.targetObjectTypeId)?.implied === false) ? c.targetObjectTypeId : null
        const pif = target && !preferredFor.has(target) ? target : null
        if (pif) preferredFor.set(pif, id)
        conEls.push(el('orm:UniquenessConstraint', { id, Name: name, Modality: modality }, [...docEls(c), roleSeq('r', seqs[0]), pif && el('orm:PreferredIdentifierFor', { ref: playerRef(pif) })]))
        shapeOf.set(c.id, { id, shape: 'ExternalConstraintShape' })
        break
      }
      case 'inclusiveOr':
        conEls.push(el('orm:MandatoryConstraint', { id, Name: name, Modality: modality }, [...docEls(c), roleSeq('r', flat)]))
        shapeOf.set(c.id, { id, shape: 'ExternalConstraintShape' })
        break
      case 'exclusiveOr': {
        // NORMA's exclusive-or: a disjunctive mandatory and an exclusion that refer to each other
        const ex = normaId(c.id, 'exclusion')
        conEls.push(
          el('orm:MandatoryConstraint', { id, Name: name, Modality: modality }, [...docEls(c), roleSeq('r', flat), el('orm:ExclusiveOrExclusionConstraint', { ref: ex })]),
          el('orm:ExclusionConstraint', { id: ex, Name: `${name}Exclusion`, Modality: modality }, [
            el('orm:RoleSequences', {}, flat.map((r, k) => el('orm:RoleSequence', { id: normaId(c.id, `xseq${k}`) }, [el('orm:Role', { id: normaId(c.id, `xseq${k}r`), ref: r })]))),
            el('orm:ExclusiveOrMandatoryConstraint', { ref: id }),
          ]))
        shapeOf.set(c.id, { id, shape: 'ExternalConstraintShape' })
        break
      }
      case 'exclusion': case 'equality': case 'subset': {
        const tag = { exclusion: 'ExclusionConstraint', equality: 'EqualityConstraint', subset: 'SubsetConstraint' }[c.constraintType]
        conEls.push(el(`orm:${tag}`, { id, Name: name, Modality: modality }, [...docEls(c), roleSeqs()]))
        shapeOf.set(c.id, { id, shape: 'ExternalConstraintShape' })
        break
      }
      case 'ring': {
        const type = ringTypeName(c.ringTypes)
        if (!type) {
          skip(`ring constraints with a combination NORMA does not have (${label})`)
          ffNote(c.sequences[0].map(m => m.factId), `the ring constraint ${label} combines ${c.ringTypes.join(', ')}, which is not one of NORMA's ring types, so it was left out.`)
          continue
        }
        conEls.push(el('orm:RingConstraint', { id, Name: name, Type: type, Modality: modality }, [...docEls(c), roleSeq('r', seqs[0])]))
        shapeOf.set(c.id, { id, shape: 'RingConstraintShape' })
        break
      }
      case 'frequency':
        conEls.push(el('orm:FrequencyConstraint', { id, Name: name, ...frequencyAttrs(c.frequency), Modality: modality }, [...docEls(c), roleSeq('r', seqs[0])]))
        shapeOf.set(c.id, { id, shape: 'FrequencyConstraintShape', text: frequencyText(c.frequency) })
        break
      case 'valueComparison': {
        const op = Object.entries(VC_OPS).find(([, sym]) => sym === c.operator)?.[0] ?? 'Equal'
        conEls.push(el('orm:ValueComparisonConstraint', { id, Name: name, Operator: op, Modality: modality }, [...docEls(c), roleSeq('r', seqs[0])]))
        shapeOf.set(c.id, { id, shape: 'ValueComparisonConstraintShape' })
        break
      }
      default:
        skip(`${c.constraintType} constraints`)
        continue
    }
    // NORMA builds a join path itself when the roles of a sequence lie in
    // binaries joined through one object type; other queries are not exported yet.
    if ((c.sequences ?? []).some((sq, k) => sq.length && !autoJoinable(sq) && c.queries?.[k])) {
      joinsLeft.push(label)
      const text = formulaText(safe(() => constraintEntry(c, ctx)))
      ffNote([c.id], `the join path of this ${conNames[c.constraintType]?.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase() ?? 'constraint'} is a FreeFBM query that this export does not write as a NORMA join path yet, so NORMA asks for one.${text ? ` FreeFBM's formula: ${text}` : ''}`)
    }
  }
  function autoJoinable(sq) {
    const roles = sq.filter(m => m.kind === 'role')
    if (roles.length !== sq.length) return sq.length === 1
    if (new Set(roles.map(m => m.factId)).size === 1) return true
    if (new Set(roles.map(m => m.factId)).size !== roles.length) return false
    const others = roles.map(m => { const f = factById.get(m.factId); return f?.roles.length === 2 ? f.roles[1 - m.roleIndex].objectTypeId : null })
    return others.every(Boolean) && new Set(others).size === 1
  }

  // ── subtype links ────────────────────────────────────────────────────────
  // NORMA's subtype fact: a mandatory and a uniqueness on the subtype's meta
  // role, a uniqueness on the supertype's. A subtype with no identifier of its
  // own takes it from one supertype (PreferredIdentificationPath).
  const playedRoles = new Map()      // object type id → [role ref elements]
  const plays = (otId, kind, roleId) => { if (otId) playedRoles.set(otId, [...(playedRoles.get(otId) ?? []), el(`orm:${kind}`, { ref: roleId })]) }
  for (const f of facts) f.roles.forEach(r => plays(playerOf(r), 'Role', normaId(r.id)))
  const subtypeEls = []
  const pathTaken = new Set()
  for (const st of subtypes) {
    // a subtype or supertype may be an objectified fact type
    const isType = (id) => otById.has(id) || nests.get(id)?.implied === false
    if (!isType(st.subId) || !isType(st.superId)) continue
    const subRole = normaId(st.id, 'sub'), superRole = normaId(st.id, 'super')
    plays(st.subId, 'SubtypeMetaRole', subRole); plays(st.superId, 'SupertypeMetaRole', superRole)
    const ownPI = preferredFor.has(st.subId) || refModes.has(st.subId)
    const path = st.inheritsPreferredIdentifier !== false && !ownPI && !pathTaken.has(st.subId)
    if (path) pathTaken.add(st.subId)
    const ids = { m: normaId(st.id, 'mandatory'), us: normaId(st.id, 'uc-sub'), up: normaId(st.id, 'uc-super') }
    conEls.push(
      el('orm:MandatoryConstraint', { id: ids.m, Name: autoName('SimpleMandatoryConstraint'), IsSimple: 'true' }, [seqEl(`${st.id}#mandatory`, [subRole])]),
      el('orm:UniquenessConstraint', { id: ids.us, Name: autoName('InternalUniquenessConstraint'), IsInternal: 'true' }, [seqEl(`${st.id}#uc-sub`, [subRole])]),
      el('orm:UniquenessConstraint', { id: ids.up, Name: autoName('InternalUniquenessConstraint'), IsInternal: 'true' }, [seqEl(`${st.id}#uc-super`, [superRole])]),
    )
    const typeName = (id) => otById.get(id)?.name ?? factById.get(id)?.objectifiedName ?? ''
    const subName = typeName(st.subId), superName = typeName(st.superId)
    subtypeEls.push(el('orm:SubtypeFact', { id: normaId(st.id), _Name: `${subName}IsASubtypeOf${superName}`, PreferredIdentificationPath: path ? 'true' : null }, [
      el('orm:FactRoles', {}, [
        el('orm:SubtypeMetaRole', { id: subRole, _IsMandatory: 'true', _Multiplicity: 'ZeroToOne', Name: '' }, [el('orm:RolePlayer', { ref: playerRef(st.subId) })]),
        el('orm:SupertypeMetaRole', { id: superRole, _IsMandatory: 'false', _Multiplicity: 'ExactlyOne', Name: '' }, [el('orm:RolePlayer', { ref: playerRef(st.superId) })]),
      ]),
      el('orm:InternalConstraints', {}, [
        el('orm:MandatoryConstraint', { ref: ids.m }), el('orm:UniquenessConstraint', { ref: ids.us }), el('orm:UniquenessConstraint', { ref: ids.up }),
      ]),
    ]))
  }

  // ── object types ─────────────────────────────────────────────────────────
  const objectEls = []
  for (const ot of objectTypes) {
    const common = { id: normaId(ot.id), Name: ot.name, IsIndependent: ot.isIndependent ? 'true' : null }
    const played = playedRoles.get(ot.id)
    const cardinality = ot.cardinalityRange?.length ? el('orm:CardinalityRestriction', {}, [
      el('orm:CardinalityConstraint', { id: normaId(ot.id, 'cardinality'), Name: autoName('ObjectTypeCardinalityConstraint'), Modality: ot.cardinalityRangeDeontic ? 'Deontic' : null }, [
        el('orm:Ranges', {}, ot.cardinalityRange.map((r, i) => { const [from, to] = countBounds([r]); return el('orm:CardinalityRange', { id: normaId(ot.id, `cardinality${i}`), From: from, To: to || null }) })),
      ])]) : null
    if (ot.kind === 'entity') {
      const rm = refModes.get(ot.id)
      const pi = preferredFor.get(ot.id)
      objectEls.push(el('orm:EntityType', { ...common, IsPersonal: ot.isPersonal ? 'true' : null, _ReferenceMode: rm?.mode ?? '' }, [
        ...docEls(ot),
        cardinality,
        played && el('orm:PlayedRoles', {}, played),
        subtypeDerivationEl(ot),
        pi && el('orm:PreferredIdentifier', { ref: pi }),
        extensionsOf(ot),
      ]))
    } else {
      objectEls.push(el('orm:ValueType', common, [
        ...docEls(ot),
        cardinality,
        played && el('orm:PlayedRoles', {}, played),
        subtypeDerivationEl(ot),
        conceptualDataType(ot),
        ot.valueRange?.length && el('orm:ValueRestriction', {}, [valueConstraintEl('orm:ValueConstraint', ot.id, ot.valueRange, ot.valueRangeDeontic, 'ValueTypeValueConstraint')]),
        extensionsOf(ot),
      ]))
    }
    // an entity type's value range is its reference mode's: on that role
    if (ot.kind === 'entity' && ot.valueRange?.length && !refModes.has(ot.id)) skip('value ranges of entity types without a reference mode')
  }

  // A derived subtype: NORMA's subtype derivation rule with FreeFBM's formula
  // as its informal rule.
  function subtypeDerivationEl(ot) {
    if (!ot.derivation || !subtypes.some(st => st.subId === ot.id)) return null
    const text = formulaText(safe(() => derivationEntry(ot, state, ctx)))
    derivedInformal++
    return el('orm:SubtypeDerivationRule', {}, [
      el('orm:SubtypeDerivationPath', { id: normaId(ot.id, 'derivation'), DerivationCompleteness: ot.derivation === 'semiDerived' ? 'PartiallyDerived' : null }, [
        el('orm:InformalRule', {}, [el('orm:DerivationNote', { id: normaId(ot.id, 'derivation-note') }, [el('orm:Body', {}, text ?? 'Derived in FreeFBM.')])]),
      ]),
    ])
  }
  // NORMA's own definition and note of an element
  function docEls(x) {
    return [
      x.definition && el('orm:Definitions', {}, [el('orm:Definition', { id: normaId(x.id, 'definition') }, [el('orm:Text', {}, x.definition)])]),
      // the element's note, then FreeFBM's remarks about it (known once the file is built)
      { lazy: () => {
        const text = [x.note, ...(elementRemarks.get(x.id) ?? [])].filter(Boolean).join('\n\n')
        return text ? el('orm:Notes', {}, [el('orm:Note', { id: normaId(x.id, 'note') }, [el('orm:Text', {}, text)])]) : null
      } },
    ]
  }
  // custom property values (NORMA's CustomProperties extension)
  function extensionsOf(x) {
    const vals = Object.entries(x.properties ?? {}).filter(([k, v]) => propDefIds.has(k) && v !== '' && v != null)
    if (!vals.length) return null
    return el('orm:Extensions', {}, vals.map(([k, v]) => el('cp:CustomProperty', { id: normaId(x.id, `property:${k}`), value: String(v) }, [el('cp:Definition', { ref: normaId(k, 'property-definition') })])))
  }

  // ── fact types ───────────────────────────────────────────────────────────
  let readingless = []
  const factEls = facts.map(f => {
    const n = f.roles.length
    // reading orders: role order → texts
    const orders = new Map()
    const addReading = (order, parts) => {
      if (!parts || order.length !== n) return
      const k = order.join(',')
      const text = [parts[0], ...order.flatMap((_, i) => [`{${i}}`, parts[i + 1]])]
        .map(s => (s ?? '').trim()).filter(Boolean).join(' ')
      if (!orders.has(k)) orders.set(k, { order, texts: [] })
      if (!orders.get(k).texts.includes(text)) orders.get(k).texts.push(text)
    }
    if (f.readingParts) addReading(f.roles.map((_, i) => i), f.readingParts)
    for (const ar of f.alternativeReadings ?? []) addReading(ar.roleOrder, ar.parts)
    if (!orders.size) readingless.push(factLabel(f))
    let k = 0
    const name = pascal(factLabel(f))
    return el('orm:Fact', { id: normaId(f.id), _Name: name || null }, [
      ...docEls(f),
      el('orm:FactRoles', {}, f.roles.map(r => el('orm:Role', { id: normaId(r.id), Name: r.roleName ?? '' },
        [playerOf(r) && el('orm:RolePlayer', { ref: playerRef(playerOf(r)) }), roleValueEl(f, r), extensionsOf(r)]))),
      orders.size && el('orm:ReadingOrders', {}, [...orders.values()].map(o => {
        const roId = normaId(f.id, `ro:${o.order.join(',')}`)
        return el('orm:ReadingOrder', { id: roId }, [
          el('orm:Readings', {}, o.texts.map(t => el('orm:Reading', { id: normaId(f.id, `reading${k++}`) }, [el('orm:Data', {}, t)]))),
          el('orm:RoleSequence', {}, o.order.map(ri => el('orm:Role', { ref: roleIdOf(f, ri) }))),
        ])
      })),
      internalRefs.get(f.id) && el('orm:InternalConstraints', {}, internalRefs.get(f.id)),
      derivationEl(f),
      extensionsOf(f),
    ])
  })
  // A derived fact type: NORMA's derivation rule with FreeFBM's formula as its
  // informal rule (NORMA's role paths are not written yet).
  function derivationEl(f) {
    if (!f.derivation) return null
    const entries = safe(() => factDerivationEntries(f, state, ctx)) ?? []
    const text = entries.map(formulaText).filter(Boolean).join('\n') || null
    const name = pascal(factLabel(f))
    derivedInformal++
    return el('orm:DerivationRule', {}, [
      el('orm:FactTypeDerivationPath', { id: normaId(f.id, 'derivation'), DerivationCompleteness: f.derivation === 'semiDerived' ? 'PartiallyDerived' : null }, [
        el('orm:InformalRule', {}, [el('orm:DerivationNote', { id: normaId(f.id, 'derivation-note') }, [el('orm:Body', {}, text ?? 'Derived in FreeFBM (no complete rule yet).')])]),
      ]),
    ])
  }
  // Each objectification: the objectifying type, and per role a link fact
  // type (ImpliedFact) between it and the role's player, with a role proxy for
  // the player's side and NORMA's uniqueness and mandatory on its own role.
  const nestEls = [], linkEls = []
  for (const [fid, { implied }] of nests) {
    const f = factById.get(fid)
    const typeId = nestId(fid), npId = normaId(fid, 'nesting')
    const linkRoles = f.roles.map((_, ri) => normaId(fid, `link${ri}-role`))
    const name = implied ? pascal(factLabel(f)) : (f.objectifiedName || pascal(factLabel(f)))
    const pi = preferredFor.get(fid)
    nestEls.push(el('orm:ObjectifiedType', { id: typeId, Name: name, IsIndependent: implied || f.isIndependent ? 'true' : null, _ReferenceMode: '' }, [
      el('orm:PlayedRoles', {}, [...linkRoles.map(r => el('orm:Role', { ref: r })), ...(playedRoles.get(fid) ?? [])]),
      pi && el('orm:PreferredIdentifier', { ref: pi }),
      el('orm:NestedPredicate', { id: npId, ref: normaId(fid), IsImplied: implied ? 'true' : null }),
    ]))
    f.roles.forEach((r, ri) => {
      const base = `${fid}#link${ri}`
      const proxy = normaId(fid, `link${ri}-proxy`), own = linkRoles[ri]
      const uc = normaId(base, 'uc'), m = normaId(base, 'mandatory')
      conEls.push(
        el('orm:UniquenessConstraint', { id: uc, Name: autoName('InternalUniquenessConstraint'), IsInternal: 'true' }, [seqEl(`${base}#uc`, [own])]),
        el('orm:MandatoryConstraint', { id: m, Name: autoName('SimpleMandatoryConstraint'), IsSimple: 'true' }, [seqEl(`${base}#mandatory`, [own])]),
      )
      const il = f.implicitLinks?.find(x => x.roleIndex === ri)
      const text = (parts, fallback) => parts ? `{0} ${(parts[1] ?? '').trim() || fallback} {1}` : `{0} ${fallback} {1}`
      const playerName = otById.get(r.objectTypeId)?.name ?? factById.get(r.objectTypeId)?.objectifiedName ?? ''
      linkEls.push(el('orm:ImpliedFact', { id: normaId(base), _Name: pascal(`${playerName} is involved in ${name}`) }, [
        el('orm:FactRoles', {}, [
          el('orm:RoleProxy', { id: proxy }, [el('orm:Role', { ref: normaId(r.id) })]),
          el('orm:Role', { id: own, _IsMandatory: 'true', _Multiplicity: 'ZeroToMany', Name: '' }, [el('orm:RolePlayer', { ref: typeId })]),
        ]),
        el('orm:ReadingOrders', {}, [
          el('orm:ReadingOrder', { id: normaId(base, 'ro-in') }, [
            el('orm:Readings', {}, [el('orm:Reading', { id: normaId(base, 'reading-in') }, [el('orm:Data', {}, text(il?.alternativeReadings?.[0]?.parts, 'is involved in'))])]),
            el('orm:RoleSequence', {}, [el('orm:Role', { ref: proxy }), el('orm:Role', { ref: own })]),
          ]),
          el('orm:ReadingOrder', { id: normaId(base, 'ro-out') }, [
            el('orm:Readings', {}, [el('orm:Reading', { id: normaId(base, 'reading-out') }, [el('orm:Data', {}, text(il?.readingParts, 'involves'))])]),
            el('orm:RoleSequence', {}, [el('orm:Role', { ref: own }), el('orm:Role', { ref: proxy })]),
          ]),
        ]),
        el('orm:InternalConstraints', {}, [el('orm:UniquenessConstraint', { ref: uc }), el('orm:MandatoryConstraint', { ref: m })]),
        el('orm:ImpliedByObjectification', { ref: npId }),
      ]))
    })
  }

  function valueConstraintEl(tag, ownerId, ranges, deontic, base) {
    return el(tag, { id: normaId(ownerId, 'valueconstraint'), Name: autoName(base), Modality: deontic ? 'Deontic' : null }, [
      el('orm:ValueRanges', {}, ranges.map(valueRangeAttrs).filter(Boolean).map((a, i) => el('orm:ValueRange', { id: normaId(ownerId, `valuerange${i}`), ...a }))),
    ])
  }
  // A role's value range, or the one of the entity type whose reference mode this role is.
  function roleValueEl(f, r) {
    let ranges = r.valueRange, deontic = r.valueRangeDeontic
    if (!ranges?.length) for (const [eid, rm] of refModes) {
      const ent = otById.get(eid)
      if (rm.factId === f.id && f.roles[rm.vtRoleIndex] === r && ent?.valueRange?.length) { ranges = ent.valueRange; deontic = ent.valueRangeDeontic }
    }
    if (!ranges?.length) return null
    return el('orm:ValueRestriction', {}, [valueConstraintEl('orm:RoleValueConstraint', r.id, ranges, deontic, 'RoleValueConstraint')])
  }

  function factLabel(f) {
    const parts = f.readingParts
    const names = f.roles.map(r => otById.get(r.objectTypeId)?.name ?? factById.get(r.objectTypeId)?.objectifiedName ?? '…')
    if (!parts) return names.join(' ')
    return [parts[0], ...names.flatMap((nm, i) => [nm, parts[i + 1]])].map(s => (s ?? '').trim()).filter(Boolean).join(' ')
  }

  if (joinsLeft.length) warn(`${joinsLeft.length} constraint${joinsLeft.length === 1 ? ' has a join' : 's have joins'} that NORMA cannot build by itself; their join paths are not exported yet, so NORMA may report that a join path is required: ${joinsLeft.join(', ')}.`)

  // ── data type elements ───────────────────────────────────────────────────
  const dataTypeEls = [...dataTypes].map(([elName, id]) => el(`orm:${elName}`, { id }))
  const modeKinds = ['General', 'Popular', 'UnitBased'].map(k => [k, kindFormat[k]])
  const kindId = (k) => normaId(`refmodekind:${k}`)

  // ── diagrams ─────────────────────────────────────────────────────────────
  const modelId = normaId(sid ?? 'model', sid ? 'model' : '')
  const diagramEls = diagrams.map(d => diagramEl(d))
  function diagramEl(d) {
    const shapes = []
    const expanded = new Set(d.expandedRefModeOccs ?? [])
    const shapeId = (occ) => normaId(GUID_RE.test(occ.id) ? occ.id : `${d.id}:${occ.id}`, GUID_RE.test(occ.id) ? '' : 'shape')
    for (const occ of d.occurrences ?? []) {
      // a collapsed reference mode is drawn in its entity's shape
      if (occ.refModeOwnerOccId && !expanded.has(occ.refModeOwnerOccId)) continue
      const ot = otById.get(occ.schemaElementId)
      if (ot) {
        const rm = refModes.get(ot.id)
        const vt = rm && otById.get(rm.vtId)
        const collapsed = rm && vt && !expanded.has(occ.id)
        const label = collapsed ? refModeLabel(ot.name, vt.name, ot) : null
        const { w, h } = otBoxSize((ot.name ?? '') + derivationMark(ot) + (ot.isIndependent ? ' !' : ''), label)
        const W = inches(w), H = inches(h)
        // value and cardinality range labels that were moved
        const rel = []
        const otBox = objectTypeLabelBox(ot, !!label)
        const S = { l: -w / 2, r: w / 2, t: -h / 2, b: h / 2 }
        const vOff = occ.valueRangeOffset ?? ot.valueRangeOffset
        if (ot.kind === 'value' && ot.valueRange?.length && vOff)
          rel.push(labelShape('ValueConstraintShape', `${shapeId(occ)}:vr`, occ, { x: vOff.dx, y: vOff.dy }, rangeLabelSize(ot.valueRange), otBox, S, normaId(ot.id, 'valueconstraint')))
        const cOff = occ.cardinalityRangeOffset ?? ot.cardinalityRangeOffset
        if (ot.cardinalityRange?.length && cOff)
          rel.push(labelShape('CardinalityConstraintShape', `${shapeId(occ)}:cr`, occ, { x: cOff.dx, y: cOff.dy }, rangeLabelSize(ot.cardinalityRange, true), otBox, S, normaId(ot.id, 'cardinality')))
        shapes.push(el('ormDiagram:ObjectTypeShape', { id: shapeId(occ), IsExpanded: 'true',
          AbsoluteBounds: boundsAttr(inches(occ.x) - W / 2, inches(occ.y) - H / 2, W, H),
          ExpandRefMode: rm && expanded.has(occ.id) ? 'true' : null }, [
          rel.length && el('ormDiagram:RelativeShapes', {}, rel),
          el('ormDiagram:Subject', { ref: normaId(ot.id) }),
        ]))
        continue
      }
      const f = factById.get(occ.schemaElementId)
      if (f) { shapes.push(factShape(f, occ, shapeId(occ))); continue }
    }
    for (const co of d.constraintOccurrences ?? []) {
      const sh = shapeOf.get(co.schemaConstraintId)
      if (!sh) continue
      const size = { ExternalConstraintShape: NORMA.externalConstraint.diameter, RingConstraintShape: NORMA.ringConstraint.diameter,
        ValueComparisonConstraintShape: NORMA.externalConstraint.diameter, FrequencyConstraintShape: frequencyDiameter(sh.text) }[sh.shape]
      shapes.push(el(`ormDiagram:${sh.shape}`, { id: normaId(`${d.id}:${co.id}`, 'shape'), IsExpanded: 'true',
        AbsoluteBounds: boundsAttr(inches(co.x) - size / 2, inches(co.y) - size / 2, size, size) }, [el('ormDiagram:Subject', { ref: sh.id })]))
    }
    // internal frequency constraints of the fact types drawn here
    for (const occ of d.occurrences ?? []) {
      const f = factById.get(occ.schemaElementId)
      if (!f || (occ.refModeOwnerOccId && !expanded.has(occ.refModeOwnerOccId))) continue
      for (const ifr of f.internalFrequency ?? []) {
        if (ifr.x == null || ifr.y == null) continue
        const size = frequencyDiameter(frequencyText(ifr.range))
        shapes.push(el('ormDiagram:FrequencyConstraintShape', { id: normaId(`${d.id}:${occ.id}:${ifr.id}`, 'shape'), IsExpanded: 'true',
          AbsoluteBounds: boundsAttr(inches(ifr.x) - size / 2, inches(ifr.y) - size / 2, size, size) }, [el('ormDiagram:Subject', { ref: normaId(ifr.id) })]))
      }
    }
    return el('ormDiagram:ORMDiagram', { id: normaId(d.id, GUID_RE.test(d.id) ? '' : 'diagram'), IsCompleteView: 'false',
      Name: d.name ?? '', BaseFontName: 'Tahoma', BaseFontSize: BASE_FONT_SIZE }, [
      shapes.length && el('ormDiagram:Shapes', {}, shapes),
      el('ormDiagram:Subject', { ref: modelId }),
    ])
  }

  // A label shape for a label FreeFBM draws at centre c (relative to the
  // occurrence's point) with the given size: the importer's placeLabel read
  // backwards. The side of FreeFBM's box the label is on, its gap from that
  // side and the edge (or centre) it lines up with along the side are kept,
  // measured from NORMA's shape S; a label over the box keeps its centre.
  function labelShape(kind, key, occ, c, size, box, S, subject) {
    const wn = size.w, hn = NORMA.lineHeight * PX
    const L = { l: c.x - size.w / 2, r: c.x + size.w / 2, t: c.y - size.h / 2, b: c.y + size.h / 2 }
    const gaps = { below: L.t - box.b, above: box.t - L.b, right: L.l - box.r, left: box.l - L.r }
    const side = Object.keys(gaps).reduce((a, k) => gaps[k] > gaps[a] ? k : a, 'below')
    let x, y
    if (gaps[side] < -6) { x = c.x; y = c.y }
    else {
      const gap = Math.max(gaps[side], 0)
      // along the side: the alignment closest to the box's start, middle or end
      const along = (lo, hi, blo, bhi, slo, shi, len) => {
        const opts = [[lo - blo, d => slo + d + len / 2], [(lo + hi) / 2 - (blo + bhi) / 2, d => (slo + shi) / 2 + d], [hi - bhi, d => shi + d - len / 2]]
        const [d, at] = opts.reduce((a, o) => Math.abs(o[0]) < Math.abs(a[0]) ? o : a)
        return at(d)
      }
      if (side === 'below' || side === 'above') {
        x = along(L.l, L.r, box.l, box.r, S.l, S.r, wn)
        y = side === 'below' ? S.b + gap + hn / 2 : S.t - gap - hn / 2
      } else {
        y = along(L.t, L.b, box.t, box.b, S.t, S.b, hn)
        x = side === 'right' ? S.r + gap + wn / 2 : S.l - gap - wn / 2
      }
    }
    const W = inches(wn), H = NORMA.lineHeight
    return el(`ormDiagram:${kind}`, { id: normaId(key, 'label'), IsExpanded: 'true', AbsoluteBounds: boundsAttr(inches(occ.x + x) - W / 2, inches(occ.y + y) - H / 2, W, H) },
      [el('ormDiagram:Subject', { ref: subject })])
  }

  // NORMA's frequency circle grows with its text (0.2247 in for "≥ 2")
  function frequencyDiameter(text) {
    return Math.max(NORMA.externalConstraint.diameter, 0.2247 + Math.max(0, (text ?? '').length - 3) * 0.05)
  }

  // NORMA's fact type shape around role boxes whose middle is the occurrence.
  function factShape(f, occ, id) {
    const n = Math.max(f.roles.length, 1)
    const vertical = (occ.orientation ?? f.orientation) === 'vertical'
    const below = !!(occ.uniquenessBelow ?? f.uniquenessBelow)
    const levels = barLevels(f)
    // an objectified fact type's shape holds NORMA's margins of the outline
    const pen = 1 / 72
    const [mAlong, mAcross] = f.objectified ? [NORMA.objectified.marginX, NORMA.objectified.marginY] : [NORMA.factBorder, NORMA.factBorder]
    const along = n * NORMA.roleBox.width + 2 * mAlong + pen
    const across = NORMA.roleBox.height + levels * NORMA.constraintBand + 2 * mAcross + pen
    const shift = levels * NORMA.constraintBand / 2
    let cx = inches(occ.x), cy = inches(occ.y)
    if (vertical) cx -= below ? shift : -shift
    else cy -= below ? -shift : shift
    const [W, H] = vertical ? [across, along] : [along, across]
    const order = occ.roleOrder ?? f.roleOrder
    const reordered = Array.isArray(order) && order.length === f.roles.length && order.some((r, i) => r !== i)
    // labels FreeFBM keeps at a set place: the reading, role value ranges,
    // role names and the objectified fact type's name (the importer's
    // placeLabel offsets, read back as centres; NORMA places the others)
    const g = { ...f, ...occ, x: occ.x, y: occ.y }
    const rel = []
    // NORMA's shape and FreeFBM's box, both relative to the occurrence's point
    const Sabs = { l: (cx - W / 2) * PX, r: (cx + W / 2) * PX, t: (cy - H / 2) * PX, b: (cy + H / 2) * PX }
    const S = { l: Sabs.l - occ.x, r: Sabs.r - occ.x, t: Sabs.t - occ.y, b: Sabs.b - occ.y }
    const box = factLabelBox(g, Sabs)
    const rOff = g.readingAbove ? g.readingOffsetAbove : g.readingOffsetBelow
    const firstOrder = f.readingParts ? f.roles.map((_, i) => i) : f.alternativeReadings?.[0]?.roleOrder
    if (rOff && firstOrder) rel.push(labelShape('ReadingShape', `${id}:reading`, occ, { x: rOff.dx, y: rOff.dy }, readingLabelSize(g), box, S, normaId(f.id, `ro:${firstOrder.join(',')}`)))
    f.roles.forEach((r, ri) => {
      const a = roleAnchor(g, ri)
      const vo = occ.valueRangeOffsets?.[ri]
      if (vo && r.valueRange?.length) rel.push(labelShape('ValueConstraintShape', `${id}:vr${ri}`, occ, { x: a.x + vo.dx, y: a.y + vo.dy }, rangeLabelSize(r.valueRange), box, S, normaId(r.id, 'valueconstraint')))
      const no = occ.roleNameOffsets?.[ri]
      if (no && r.roleName) rel.push(labelShape('RoleNameShape', `${id}:rn${ri}`, occ, { x: a.x + no.dx, y: a.y + no.dy }, roleNameLabelSize(r.roleName), box, S, normaId(r.id)))
    })
    if (f.objectified && f.objectifiedName && occ.nameOffset && (occ.nameOffset.dx || occ.nameOffset.dy)) {
      const a = nameAnchor(g, false)
      rel.push(labelShape('ObjectifiedFactTypeNameShape', `${id}:name`, occ, { x: a.x + occ.nameOffset.dx, y: a.y + occ.nameOffset.dy }, nameLabelSize(f.objectifiedName), box, S, nestId(f.id)))
    }
    return el('ormDiagram:FactTypeShape', { id, IsExpanded: 'true', AbsoluteBounds: boundsAttr(cx - W / 2, cy - H / 2, W, H),
      ConstraintDisplayPosition: below ? 'Bottom' : null, DisplayOrientation: vertical ? 'VerticalRotatedRight' : null,
      DisplayRoleNames: occ.roleNamesShown === false ? 'Off' : null }, [
      rel.length && el('ormDiagram:RelativeShapes', {}, rel),
      el('ormDiagram:Subject', { ref: normaId(f.id) }),
      reordered && el('ormDiagram:RoleDisplayOrder', {}, order.map(ri => el('ormDiagram:Role', { ref: roleIdOf(f, ri) }))),
    ])
  }
  // Levels of uniqueness bars as NORMA stacks them: single-role bars share
  // one level, each longer bar has its own (FactTypeNode's level assignment).
  function barLevels(f) {
    const ucs = (f.uniqueness ?? []).map(u => u.roles)
    const implied = (f.preferredUniqueness ?? []).some(pu => f.roles.some((_, ri) => !pu.includes(ri)))
    // a unary's uniqueness is not drawn
    const single = f.roles.length > 1 && (ucs.some(r => r.length === 1) || implied)
    return (single ? 1 : 0) + ucs.filter(r => r.length > 1).length
  }

  // ── report ───────────────────────────────────────────────────────────────
  note(`Exported ${objectTypes.length} object types, ${facts.length} fact types, ${subtypes.length} subtype links and ${diagrams.length} diagram${diagrams.length === 1 ? '' : 's'} of schema “${modelName}”.`)
  if (impliedCount) note(`${impliedCount} uniqueness and mandatory constraints that preferred identifiers imply (FreeFBM draws them without storing them) were written as constraints, as NORMA keeps them.`)
  if (popularFormat !== '{0}_{1}') note(`Popular reference modes use NORMA's name format ${popularFormat} (the value type ${popularFormat.replace('{0}', 'Person').replace('{1}', 'Nr')}), as most of the model's value types are named.`)
  if (customModes.size) note(`${customModes.size} reference mode${customModes.size === 1 ? '' : 's'} (${[...customModes.keys()].join(', ')}) ${customModes.size === 1 ? 'gets' : 'get'} a custom reference mode in NORMA, so that NORMA finds ${customModes.size === 1 ? 'it' : 'them'} from the value types' names.`)
  if (approximated.length) note(`Data types of another profile were written as the nearest NORMA type: ${approximated.join(', ')}.`)
  if (unspecified.length) warn(`${unspecified.length} value type${unspecified.length === 1 ? ' has' : 's have'} no data type, which NORMA reports as an error: ${unspecified.join(', ')}.`)
  if (readingless.length) warn(`${readingless.length} fact type${readingless.length === 1 ? ' has' : 's have'} no reading, which NORMA reports as an error: ${readingless.join(', ')}.`)
  const left = Object.entries(skipped)
  if (left.length) warn(`Not exported yet (later milestones of the export): ${left.map(([what, k]) => `${k} ${what}`).join(', ')}.`)

  // ── notes ────────────────────────────────────────────────────────────────
  // Diagram notes become NORMA model notes with a shape on each diagram that
  // shows them (FreeFBM's copies of one NORMA note, id_1, id_2, are one note);
  // a note's connectors become the elements it refers to. FreeFBM's own
  // import notes are left out. The "FreeFBM:" notes are added beside their
  // elements, on the first diagram that shows one of them.
  const idOf = new Map()   // FreeFBM element id → NORMA id, for references
  for (const ot of objectTypes) idOf.set(ot.id, ['ObjectType', normaId(ot.id)])
  for (const f of facts) idOf.set(f.id, ['FactType', normaId(f.id)])
  for (const c of constraints) if (shapeOf.has(c.id)) idOf.set(c.id, [['exclusion', 'equality', 'subset'].includes(c.constraintType) ? 'SetComparisonConstraint' : 'SetConstraint', shapeOf.get(c.id).id])
  const modelNotes = new Map()   // note key → { id, text, refs }
  const noteShapes = new Map()   // diagram id → [shape elements]
  const addNoteShape = (diagramId, noteId, x, y, w, h) =>
    noteShapes.set(diagramId, [...(noteShapes.get(diagramId) ?? []), el('ormDiagram:ModelNoteShape', { id: normaId(`${diagramId}:${noteId}`, 'note-shape'), IsExpanded: 'true',
      AbsoluteBounds: boundsAttr(inches(x), inches(y), inches(w), inches(h)) }, [el('ormDiagram:Subject', { ref: noteId })])])
  let importNotesLeft = 0
  for (const d of diagrams) for (const n of d.notes ?? []) {
    if (n.importNote) { importNotesLeft++; continue }
    if (/^FreeFBM:/.test(n.text ?? '')) continue
    const key = /^(_[0-9A-Fa-f-]{36})_\d+$/.exec(n.id)?.[1] ?? n.id
    if (!modelNotes.has(key)) modelNotes.set(key, { id: normaId(key, GUID_RE.test(key) ? '' : 'note'), text: n.text ?? '', refs: new Set() })
    const mn = modelNotes.get(key)
    for (const c of n.connectors ?? []) if (idOf.has(c.targetId)) mn.refs.add(c.targetId)
    addNoteShape(d.id, mn.id, n.x - (n.w ?? 0) / 2, n.y - (n.h ?? 0) / 2, n.w ?? 120, n.h ?? 40)
  }
  if (importNotesLeft) note(`${importNotesLeft} FreeFBM import note${importNotesLeft === 1 ? '' : 's'} shown on diagrams ${importNotesLeft === 1 ? 'was' : 'were'} left out; they describe the import from NORMA.`)
  // wrap long lines: NORMA does not wrap a note's text
  const wrap = (text, width = 72) => text.split('\n').map(line => {
    const out = []; let cur = ''
    for (const w of line.split(/\s+/)) { if (cur && (cur + ' ' + w).length > width) { out.push(cur); cur = w } else cur = cur ? `${cur} ${w}` : w }
    out.push(cur); return out.join('\n')
  }).join('\n')
  const noteSize = (text) => {
    const lines = text.split('\n')
    return { w: Math.max(...lines.map(l => l.length)) * 4.4 + 16, h: lines.length * NORMA.lineHeight * PX + 12 }
  }
  // where an element is drawn: first diagram and occurrence
  const drawnAt = (elId) => {
    for (const d of diagrams) {
      const o = (d.occurrences ?? []).find(o => o.schemaElementId === elId && !o.refModeOwnerOccId)
        ?? (d.constraintOccurrences ?? []).find(o => o.schemaConstraintId === elId)
      if (o) return { d, x: o.x, y: o.y }
    }
    return null
  }
  // the summary note
  const leftOut = []
  const others = schemas.filter(x => x.id !== sid)
  if (others.length) leftOut.push(`${others.length} other schema${others.length === 1 ? '' : 's'} (${others.map(x => x.name).join(', ')}): only “${modelName}” is exported`)
  if (state.mappings?.length) leftOut.push(`${state.mappings.length} mapping${state.mappings.length === 1 ? '' : 's'} between schemas`)
  const popCount = Object.keys(state.factPopulations ?? {}).length + Object.keys(state.populations ?? {}).length
  if (popCount) leftOut.push('sample populations')
  if ((state.languages ?? []).length > 1) leftOut.push(`names and readings in other languages (${state.languages.join(', ')}); NORMA has one`)
  for (const [what, k] of Object.entries(skipped)) leftOut.push(`${k} ${what}`)
  if (joinsLeft.length) leftOut.push(`the join paths of ${joinsLeft.length} constraint${joinsLeft.length === 1 ? '' : 's'}`)
  const nDerived = facts.filter(f => f.derivation).length + objectTypes.filter(o => o.derivation && subtypes.some(st => st.subId === o.id)).length
  if (nDerived) leftOut.push(`${nDerived} derivation rule${nDerived === 1 ? '' : 's'} as NORMA paths (kept as informal rules)`)
  const summary = wrap(`FreeFBM: this model was exported from FreeFBM. ${leftOut.length ? `Not in NORMA's form: ${leftOut.join('; ')}. Where it concerns one element, the element's note (NORMA's Notes window) says more, after “FreeFBM:”.` : 'Everything in it is in NORMA\'s form.'}`)
  // remarks about no element in particular (custom property types) go to the summary
  const general = ffNotes.filter(fn => !fn.targets.length).map(fn => fn.text.replace(/^FreeFBM: /, ''))
  {
    const id = normaId(`freefbm-summary:${modelName}`)
    const text = general.length ? wrap(`${summary.replace(/\n/g, ' ')} ${general.join(' ')}`) : summary
    modelNotes.set(id, { id, text, refs: new Set() })
    const d = diagrams[0]
    if (d) {
      // above and left of everything on the diagram, notes included
      const tops = [...(d.occurrences ?? []).map(o => o.y - 25), ...(d.notes ?? []).map(n => n.y - (n.h ?? 0) / 2), ...(d.constraintOccurrences ?? []).map(o => o.y - 20)]
      const lefts = [...(d.occurrences ?? []).map(o => o.x - 60), ...(d.notes ?? []).map(n => n.x - (n.w ?? 0) / 2)]
      const { w, h } = noteSize(text)
      addNoteShape(d.id, id, lefts.length ? Math.min(...lefts) : 40, (tops.length ? Math.min(...tops) : 100) - h - 30, w, h)
    }
  }
  const modelNoteEls = [...modelNotes.values()].map(mn => el('orm:ModelNote', { id: mn.id }, [
    el('orm:Text', {}, mn.text),
    mn.refs.size && el('orm:ReferencedBy', {}, [...mn.refs].map(r => el(`orm:${idOf.get(r)[0]}`, { ref: idOf.get(r)[1] }))),
  ]))
  for (const de of diagramEls) {
    const did = diagrams[diagramEls.indexOf(de)].id
    const extra = noteShapes.get(did)
    if (!extra?.length) continue
    let shapesEl = de.children.find(c => c && c.name === 'ormDiagram:Shapes')
    if (!shapesEl) { shapesEl = el('ormDiagram:Shapes', {}, []); de.children.unshift(shapesEl) }
    shapesEl.children.push(...extra)
  }
  const nRemarks = [...elementRemarks.values()].reduce((n, r) => n + r.length, 0)
  note(`A summary note on the first diagram says what NORMA could not take as it is${nRemarks ? `; ${nRemarks} remark${nRemarks === 1 ? '' : 's'} starting with “FreeFBM:” in the notes of the elements concerned ${nRemarks === 1 ? 'says' : 'say'} more` : ''}.${derivedInformal ? ` ${derivedInformal} derivation rule${derivedInformal === 1 ? ' is' : 's are'} written as NORMA informal rules holding FreeFBM's formula.` : ''}`)

  // ── groups ───────────────────────────────────────────────────────────────
  // Element groups with their colours (NORMA's shape grouping extension)
  const COLOR_ROLES = { outline: 'Outline', fill: 'Background', text: 'ForegroundText', graphics: 'ForegroundGraphics',
    floating: 'FloatingText', constraint: 'Constraint', deontic: 'DeonticConstraint', connector: 'RolePlayerConnector' }
  const rgb = (hex) => { const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex ?? ''); return m ? m.slice(1).map(h => parseInt(h, 16)).join(', ') : null }
  const memberRefOf = (mid) => {
    if (idOf.has(mid)) return idOf.get(mid)[1]
    for (const f of facts) {
      if (f.roles.some(r => r.id === mid)) return normaId(mid)
      if ((f.uniqueness ?? []).some(u => u.id === mid) || f.roles.some(r => r.mandatoryId === mid) || (f.internalFrequency ?? []).some(q => q.id === mid)) return normaId(mid)
    }
    if (subtypes.some(st => st.id === mid)) return normaId(mid)
    const key = /^(_[0-9A-Fa-f-]{36})_\d+$/.exec(mid)?.[1] ?? mid
    return modelNotes.get(key)?.id ?? null
  }
  const groups = (state.groups ?? []).filter(g => !sid || schemas.length <= 1 || (g.members ?? []).some(m => memberRefOf(m)))
  let usesShapeGroups = false
  const groupEls = groups.map(g => {
    const colors = Object.entries(g.colors ?? {}).map(([ch, hex]) => [COLOR_ROLES[ch], rgb(hex)]).filter(([r, v]) => r && v)
    if (colors.length) usesShapeGroups = true
    const refs = [...new Set((g.members ?? []).map(memberRefOf).filter(Boolean))]
    return el('orm:Group', { id: normaId(g.id, GUID_RE.test(g.id) ? '' : 'group'), Name: g.name || 'Group', Priority: g.priority || null }, [
      ...docEls(g),
      colors.length && el('orm:GroupTypes', {}, [el('shapeGroup:ORMShapeColorGroupType', { id: normaId(g.id, 'colors') },
        colors.map(([role, value]) => el('ormDiagram:ORMDiagramDynamicColor', { ColorRole: role, ColorValue: value })))]),
      refs.length && el('orm:Elements', {}, refs.map(r => el('orm:IncludedElement', { ref: r }))),
    ])
  })

  // ── custom property definitions ──────────────────────────────────────────
  const ORM_TYPES = { entity: ['EntityType'], value: ['ValueType'], fact: ['FactType'], role: ['Role'], subtype: ['SubtypeFact'],
    constraint: ['UniquenessConstraint', 'MandatoryConstraint', 'FrequencyConstraint', 'RingConstraint', 'EqualityConstraint', 'ExclusionConstraint', 'SubsetConstraint', 'ValueComparisonConstraint'],
    group: ['ElementGrouping'] }
  const CP_TYPES = { string: 'String', number: 'Decimal', date: 'DateTime' }
  const cpGroups = new Map()
  for (const d of propDefs) {
    const cat = d.category || 'FreeFBM'
    if (!cpGroups.has(cat)) cpGroups.set(cat, [])
    const types = [...new Set((d.appliesTo ?? []).flatMap(k => ORM_TYPES[k] ?? []))]
    if (!CP_TYPES[d.type]) ffNote([], `the custom property ${d.name} is a ${d.type} in FreeFBM; NORMA has no such property type, so it is a text property.`)
    cpGroups.get(cat).push(el('cp:Definition', { id: normaId(d.id, 'property-definition'), name: d.name, description: d.description || null, category: cat,
      dataType: CP_TYPES[d.type] ?? 'String', defaultValue: d.default || null, ORMTypes: (types.length ? types : ['EntityType', 'ValueType', 'FactType']).join(', ') }))
  }
  const cpEls = [...cpGroups].map(([cat, defs]) => el('cp:CustomPropertyGroup', { id: normaId(`property-group:${cat}`), name: cat, isDefault: 'false' }, [el('cp:PropertyDefinitions', {}, defs)]))

  // ── the file ─────────────────────────────────────────────────────────────
  const root = el('ormRoot:ORM2', { 'xmlns:orm': NS.orm, 'xmlns:ormDiagram': NS.ormDiagram,
    'xmlns:cp': cpEls.length ? NS.cp : null, 'xmlns:shapeGroup': usesShapeGroups ? NS.shapeGroup : null, 'xmlns:ormRoot': NS.ormRoot }, [
    el('orm:ORMModel', { id: modelId, Name: modelName }, [
      (objectEls.length || nestEls.length) && el('orm:Objects', {}, [...objectEls, ...nestEls]),
      (factEls.length || subtypeEls.length) && el('orm:Facts', {}, [...factEls, ...subtypeEls, ...linkEls]),
      conEls.length && el('orm:Constraints', {}, conEls),
      dataTypeEls.length && el('orm:DataTypes', {}, dataTypeEls),
      customModes.size && el('orm:CustomReferenceModes', {}, [...customModes].map(([mode, c]) =>
        el('orm:CustomReferenceMode', { id: normaId(`refmode:${mode}`), Name: mode }, [
          el('orm:CustomFormatString', {}, c.format),
          el('orm:Kind', { ref: kindId(c.kind) }),
        ]))),
      modelNoteEls.length && el('orm:ModelNotes', {}, modelNoteEls),
      el('orm:ReferenceModeKinds', {}, modeKinds.map(([k, format]) =>
        el('orm:ReferenceModeKind', { id: kindId(k), FormatString: format, ReferenceModeType: k }))),
    ]),
    ...diagramEls,
    groupEls.length && el('orm:Grouping', { id: normaId(`grouping:${modelName}`) }, [el('orm:ORMModel', { ref: modelId }), el('orm:Groups', {}, groupEls)]),
    ...cpEls,
  ])
  const out = ['<?xml version="1.0" encoding="utf-8"?>']
  write(root, 0, out)
  return { xml: out.join('\r\n') + '\r\n', report }
}
