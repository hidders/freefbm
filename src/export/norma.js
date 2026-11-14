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
import { otBoxSize } from '../components/ObjectTypeNode.jsx'
import { findRefMode, refModeLabel } from '../utils/refMode.js'
import { derivationMark } from '../logic/derivationRule.js'
import { datatypeAssignmentToKind } from '../utils/datatypeMapping.js'

const NS = {
  orm: 'http://schemas.neumont.edu/ORM/2006-04/ORMCore',
  ormDiagram: 'http://schemas.neumont.edu/ORM/2006-04/ORMDiagram',
  ormRoot: 'http://schemas.neumont.edu/ORM/2006-04/ORMRoot',
}
const BASE_FONT_SIZE = '0.0972222238779068'   // 7 pt in inches, as NORMA writes it

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
  const pad = '\t'.repeat(depth)
  const a = Object.entries(node.attrs).filter(([, v]) => v != null && v !== false)
    .map(([k, v]) => ` ${k}="${esc(v)}"`).join('')
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
  for (const f of facts) {
    const ucs = (f.uniqueness ?? []).map(u => ({ ...u, roles: [...u.roles].sort((a, b) => a - b) }))
    const key = (roles) => [...roles].sort((a, b) => a - b).join(',')
    const mandatory = f.roles.map(r => !!r.mandatory)
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
    if (f.internalFrequency?.length) skip('internal frequency constraints', f.internalFrequency.length)
    if (f.roles.some(r => r.valueRange?.length)) skip('role value ranges', f.roles.filter(r => r.valueRange?.length).length)
    if (f.derivation || f.derivationRule) skip('fact type derivation rules')
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
    if (!otById.has(st.subId) || !otById.has(st.superId)) continue
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
    const subName = otById.get(st.subId).name, superName = otById.get(st.superId).name
    subtypeEls.push(el('orm:SubtypeFact', { id: normaId(st.id), _Name: `${subName}IsASubtypeOf${superName}`, PreferredIdentificationPath: path ? 'true' : null }, [
      el('orm:FactRoles', {}, [
        el('orm:SubtypeMetaRole', { id: subRole, _IsMandatory: 'true', _Multiplicity: 'ZeroToOne', Name: '' }, [el('orm:RolePlayer', { ref: normaId(st.subId) })]),
        el('orm:SupertypeMetaRole', { id: superRole, _IsMandatory: 'false', _Multiplicity: 'ExactlyOne', Name: '' }, [el('orm:RolePlayer', { ref: normaId(st.superId) })]),
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
    if (ot.kind === 'entity') {
      const rm = refModes.get(ot.id)
      const pi = preferredFor.get(ot.id)
      objectEls.push(el('orm:EntityType', { ...common, IsPersonal: ot.isPersonal ? 'true' : null, _ReferenceMode: rm?.mode ?? '' }, [
        played && el('orm:PlayedRoles', {}, played),
        pi && el('orm:PreferredIdentifier', { ref: pi }),
      ]))
    } else {
      objectEls.push(el('orm:ValueType', common, [
        played && el('orm:PlayedRoles', {}, played),
        conceptualDataType(ot),
      ]))
    }
    if (ot.valueRange?.length) skip('value ranges of object types')
    if (ot.cardinalityRange?.length) skip('cardinality ranges')
    if (ot.derivation || ot.derivationRule) skip('subtype derivation rules')
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
      el('orm:FactRoles', {}, f.roles.map(r => el('orm:Role', { id: normaId(r.id), Name: r.roleName ?? '' },
        playerOf(r) ? [el('orm:RolePlayer', { ref: playerRef(playerOf(r)) })] : null))),
      orders.size && el('orm:ReadingOrders', {}, [...orders.values()].map(o => {
        const roId = normaId(f.id, `ro:${o.order.join(',')}`)
        return el('orm:ReadingOrder', { id: roId }, [
          el('orm:Readings', {}, o.texts.map(t => el('orm:Reading', { id: normaId(f.id, `reading${k++}`) }, [el('orm:Data', {}, t)]))),
          el('orm:RoleSequence', {}, o.order.map(ri => el('orm:Role', { ref: roleIdOf(f, ri) }))),
        ])
      })),
      internalRefs.get(f.id) && el('orm:InternalConstraints', {}, internalRefs.get(f.id)),
    ])
  })
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

  function factLabel(f) {
    const parts = f.readingParts
    const names = f.roles.map(r => otById.get(r.objectTypeId)?.name ?? factById.get(r.objectTypeId)?.objectifiedName ?? '…')
    if (!parts) return names.join(' ')
    return [parts[0], ...names.flatMap((nm, i) => [nm, parts[i + 1]])].map(s => (s ?? '').trim()).filter(Boolean).join(' ')
  }

  if (constraints.length) skip('external constraints', constraints.length)
  if (state.groups?.length) skip('groups')

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
        shapes.push(el('ormDiagram:ObjectTypeShape', { id: shapeId(occ), IsExpanded: 'true',
          AbsoluteBounds: boundsAttr(inches(occ.x) - W / 2, inches(occ.y) - H / 2, W, H),
          ExpandRefMode: rm && expanded.has(occ.id) ? 'true' : null }, [el('ormDiagram:Subject', { ref: normaId(ot.id) })]))
        continue
      }
      const f = factById.get(occ.schemaElementId)
      if (f) { shapes.push(factShape(f, occ, shapeId(occ))); continue }
    }
    if (d.notes?.length) skip('diagram notes', d.notes.length)
    if (d.constraintOccurrences?.length) skip('external constraint shapes', d.constraintOccurrences.length)
    return el('ormDiagram:ORMDiagram', { id: normaId(d.id, GUID_RE.test(d.id) ? '' : 'diagram'), IsCompleteView: 'false',
      Name: d.name ?? '', BaseFontName: 'Tahoma', BaseFontSize: BASE_FONT_SIZE }, [
      shapes.length && el('ormDiagram:Shapes', {}, shapes),
      el('ormDiagram:Subject', { ref: modelId }),
    ])
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
    return el('ormDiagram:FactTypeShape', { id, IsExpanded: 'true', AbsoluteBounds: boundsAttr(cx - W / 2, cy - H / 2, W, H),
      ConstraintDisplayPosition: below ? 'Bottom' : null, DisplayOrientation: vertical ? 'VerticalRotatedRight' : null }, [
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

  // ── the file ─────────────────────────────────────────────────────────────
  const root = el('ormRoot:ORM2', { 'xmlns:orm': NS.orm, 'xmlns:ormDiagram': NS.ormDiagram, 'xmlns:ormRoot': NS.ormRoot }, [
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
      el('orm:ReferenceModeKinds', {}, modeKinds.map(([k, format]) =>
        el('orm:ReferenceModeKind', { id: kindId(k), FormatString: format, ReferenceModeType: k }))),
    ]),
    ...diagramEls,
  ])
  const out = ['<?xml version="1.0" encoding="utf-8"?>']
  write(root, 0, out)
  return { xml: out.join('\r\n') + '\r\n', report }
}
