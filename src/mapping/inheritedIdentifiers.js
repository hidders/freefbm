// Subtypes with a preferred identifier of their own, for runs and checks.
//
// A subtype S that inherits no preferred identifier (every subtype link from
// it has inheritsPreferredIdentifier false) and has one of its own (a
// reference mode or a composite identifier) holds its instances as cells of
// its own identifier: populations[S] are, say, DId values, and
// subtypeMappings[link] says, row by row, which supertype instance each one
// is. Mapping runs, constraint accounting and the equivalence summary match
// and build by cell, and an instance has one cell there, so they could not
// say that D 'd7' is A '1' (a rule reading A's identifier for a D found
// nothing, and a run building a D could not keep its A identifier).
//
// withInheritedIdentifiers(state, schemaIds) gives a copy in which each such
// S inherits its supertype's identifier instead (its links to supertypes with
// that identifier inherit), and its own identifier is an ordinary key: the
// identifying fact types lose their preference and get the uniqueness and
// mandatory constraints the preferred identifier implied, and their tuples
// are stored. Its instances (and those of subtypes that inherit S's
// identifier, and the cells at roles they play) become the supertype cells
// the mappings name. `back(pops)` turns a population of that copy (such as a
// run's result) back: own cells again, subtypeMappings rebuilt, the
// identifying tuples dropped. Null when nothing needs it. Cells nested inside
// composite identifiers are left as they are.

import { findRefMode, findCompositePI } from '../utils/refMode.js'
import { projCellKey } from '../utils/populationValidation.js'

const keyOf = (cell) => JSON.stringify(projCellKey(cell))

// The parts of an own identifier: [{ factId, entityRi, ri }] in cell order.
function partsOf(rm, cp) {
  if (rm) return [{ factId: rm.factId, entityRi: 1 - rm.vtRoleIndex, ri: rm.vtRoleIndex }]
  if (cp.factIds) return cp.factIds.map((factId, i) => ({ factId, entityRi: cp.entityRoleIndices[i], ri: cp.identifyingRoleIndices[i] }))
  return cp.identifyingRoleIndices.map(ri => ({ factId: cp.factId, entityRi: cp.entityRoleIndex, ri }))
}

export function withInheritedIdentifiers(state, schemaIds) {
  const inScope = new Set(schemaIds.filter(Boolean))
  const facts = (state.facts ?? []).filter(f => !f._implicit)
  const objectTypes = state.objectTypes ?? []
  const constraints = state.constraints ?? []
  const subtypes = state.subtypes ?? []
  const otById = new Map(objectTypes.map(o => [o.id, o]))
  const ownScheme = (t) => {
    if (!t || t.kind !== 'entity') return null
    const rm = findRefMode(t, facts, objectTypes)
    if (rm) return { rm, cp: null }
    const cp = findCompositePI(t, facts, objectTypes, constraints)
    return cp ? { rm: null, cp } : null
  }
  // The type whose own identifier a type uses, through inheriting links.
  const piOwner = (id, seen = new Set()) => {
    if (seen.has(id)) return null
    seen.add(id)
    if (ownScheme(otById.get(id))) return id
    for (const s of subtypes) if (s.subId === id && s.inheritsPreferredIdentifier !== false) { const o = piOwner(s.superId, seen); if (o) return o }
    return null
  }

  // ── The subtypes concerned ──
  const own = new Map()   // typeId → { parts, edges (made inheriting), owner (of the supertypes' identifier), scheme }
  for (const t of objectTypes) {
    if (t.kind !== 'entity' || !inScope.has(t.schemaId)) continue
    const ups = subtypes.filter(s => s.subId === t.id)
    if (!ups.length || ups.some(s => s.inheritsPreferredIdentifier !== false)) continue
    const sch = ownScheme(t)
    if (!sch) continue
    const withOwner = ups.map(e => ({ e, owner: piOwner(e.superId) })).filter(x => x.owner)
    if (!withOwner.length) continue
    const owner = withOwner[0].owner
    own.set(t.id, { parts: partsOf(sch.rm, sch.cp), scheme: sch, edges: withOwner.filter(x => x.owner === owner).map(x => x.e), owner })
  }
  if (!own.size) return null

  // The own subtype whose cells a type holds (itself, or one it inherits
  // its identifier from), or null.
  const holderMemo = new Map()
  const holderOf = (id) => {
    if (holderMemo.has(id)) return holderMemo.get(id)
    holderMemo.set(id, null)
    let out = null
    if (own.has(id)) out = id
    else if (!ownScheme(otById.get(id))) {
      for (const s of subtypes) if (s.subId === id && s.inheritsPreferredIdentifier !== false) { out = holderOf(s.superId); if (out) break }
    }
    holderMemo.set(id, out)
    return out
  }

  // ── Elements ──
  const madeInheriting = new Set([...own.values()].flatMap(o => o.edges.map(e => e.id)))
  const newSubtypes = subtypes.map(s => (madeInheriting.has(s.id) ? { ...s, inheritsPreferredIdentifier: true } : s))
  const factEdits = new Map()   // factId → { dropPu: [[ri…]], entityRis: Set }
  const prefOff = new Set()
  for (const [, o] of own) {
    const { rm, cp } = o.scheme
    for (const p of o.parts) {
      if (!factEdits.has(p.factId)) factEdits.set(p.factId, { dropPu: [], entityRis: new Set() })
      factEdits.get(p.factId).entityRis.add(p.entityRi)
    }
    if (rm) factEdits.get(rm.factId).dropPu.push([rm.vtRoleIndex])
    else if (cp.constraintId) prefOff.add(cp.constraintId)
    else factEdits.get(cp.factId).dropPu.push(cp.identifyingRoleIndices)
  }
  const same = (a, b) => a.length === b.length && [...a].sort().every((x, i) => x === [...b].sort()[i])
  const newFacts = (state.facts ?? []).map(f => {
    const ed = factEdits.get(f.id)
    if (!ed) return f
    const uniqueness = [...(f.uniqueness ?? [])]
    const addUc = (roles, tag) => { if (!uniqueness.some(u => same(u.roles ?? [], roles))) uniqueness.push({ id: `${f.id}_ownid_${tag}`, roles }) }
    ed.dropPu.forEach((pu, i) => addUc(pu, `p${i}`))
    for (const ri of ed.entityRis) if (f.roles.length === 2 || ed.dropPu.length) addUc([ri], `e${ri}`)
    return {
      ...f,
      // Still the roles an identifier identifies, for implicit participation.
      ownIdentifierRoles: [...ed.entityRis],
      uniqueness,
      preferredUniqueness: (f.preferredUniqueness ?? []).filter(pu => !ed.dropPu.some(d => same(d, pu))),
      roles: f.roles.map((r, ri) => (ed.entityRis.has(ri) && !r.mandatory ? { ...r, mandatory: true, mandatoryId: r.mandatoryId ?? `${f.id}_ownid_m${ri}` } : r)),
    }
  })
  const newConstraints = constraints.map(c => (prefOff.has(c.id) ? { ...c, isPreferredIdentifier: false } : c))

  // ── Cells: own cell ↔ the supertype cell mappings name ──
  const toCanon = new Map()   // typeId → Map(key of own cell → canon cell)
  const supCell = (edge, i) => {
    const row = state.subtypeMappings?.[edge.id]?.[i]
    if (!Array.isArray(row)) return undefined
    return row.length === 1 ? row[0] : row
  }
  const canonOf = (typeId, cell, depth = 0) => {
    const h = holderOf(typeId)
    if (!h || depth > 8) return cell
    if (!toCanon.has(h)) {
      const m = new Map()
      toCanon.set(h, m)
      const o = own.get(h)
      const sup = o.edges[0]
      ;(state.populations?.[h] ?? []).forEach((c, i) => {
        const s = supCell(sup, i)
        if (s !== undefined && projCellKey(s) !== null) m.set(keyOf(c), canonOf(sup.superId, s, depth + 1))
      })
    }
    return toCanon.get(h).get(keyOf(cell))
  }
  const populations = {}
  for (const [id, cells] of Object.entries(state.populations ?? {})) {
    if (!holderOf(id)) { populations[id] = cells; continue }
    populations[id] = cells.map(c => canonOf(id, c)).filter(c => c !== undefined)
  }
  const factById = new Map((state.facts ?? []).map(f => [f.id, f]))
  const factPopulations = {}
  for (const [id, tuples] of Object.entries(state.factPopulations ?? {})) {
    const f = factById.get(id)
    const hs = f?.roles.map(r => holderOf(r.objectTypeId)) ?? []
    if (!hs.some(Boolean)) { factPopulations[id] = tuples; continue }
    factPopulations[id] = tuples.map(t => t.map((c, i) => (hs[i] ? canonOf(f.roles[i].objectTypeId, c) : c))).filter(t => t.every(c => c !== undefined))
  }
  // The own identifier's facts, stored.
  for (const [id, o] of own) {
    const byFact = new Map()
    for (const [k, p] of o.parts.entries()) { if (!byFact.has(p.factId)) byFact.set(p.factId, []); byFact.get(p.factId).push({ ...p, k }) }
    for (const c of state.populations?.[id] ?? []) {
      const canon = canonOf(id, c)
      if (canon === undefined) continue
      const partCells = o.parts.length === 1 ? [c] : (Array.isArray(c) ? c : [])
      for (const [factId, ps] of byFact) {
        const f = factById.get(factId)
        if (!f) continue
        const t = f.roles.map(() => '')
        t[ps[0].entityRi] = canon
        for (const p of ps) t[p.ri] = partCells[p.k]
        if (t.some(x => x === undefined || projCellKey(x) === null)) continue
        ;(factPopulations[factId] ??= []).push(t)
      }
    }
  }
  const subtypeMappings = {}
  for (const [id, rows] of Object.entries(state.subtypeMappings ?? {})) {
    if (madeInheriting.has(id)) continue
    const e = subtypes.find(s => s.id === id)
    const h = e && own.has(e.subId) ? e.subId : null
    // Rows stay aligned with the subtype's population (instances without a
    // supertype instance are dropped from both).
    subtypeMappings[id] = h ? rows.filter((_, i) => canonOf(h, state.populations?.[h]?.[i]) !== undefined) : rows
  }

  const newState = { ...state, facts: newFacts, subtypes: newSubtypes, constraints: newConstraints, populations, factPopulations, subtypeMappings }

  // ── Back ──
  // pops: { populations, factPopulations } of the copy, for the elements of
  // one schema (a run's result). Gives them in the own cells, with the
  // subtypeMappings of the links made inheriting.
  const back = (pops) => {
    const P = pops.populations ?? {}, F = pops.factPopulations ?? {}
    const toOwn = new Map()   // holder → Map(key of canon → own cell)
    for (const [id, o] of own) {
      const m = new Map()
      toOwn.set(id, m)
      const vals = new Map()   // canon key → [part cells]
      o.parts.forEach((p, k) => {
        for (const t of F[p.factId] ?? []) {
          const ck = keyOf(t[p.entityRi])
          if (!vals.has(ck)) vals.set(ck, [])
          vals.get(ck)[k] = t[p.ri]
        }
      })
      for (const [ck, cells] of vals) if (cells.length === o.parts.length && cells.every(c => c !== undefined)) m.set(ck, o.parts.length === 1 ? cells[0] : cells)
    }
    const ownOf = (typeId, canon) => {
      const h = holderOf(typeId)
      return h ? toOwn.get(h).get(keyOf(canon)) : canon
    }
    const identifying = new Set([...own.values()].flatMap(o => o.parts.map(p => p.factId)))
    const populations = {}, factPopulations = {}, subtypeMappings = {}
    let dropped = 0
    for (const [id, cells] of Object.entries(P)) {
      if (!holderOf(id)) { populations[id] = cells; continue }
      const out = []
      for (const c of cells) { const x = ownOf(id, c); if (x === undefined) dropped++; else out.push(x) }
      populations[id] = out
      if (own.has(id)) {
        const o = own.get(id)
        for (const e of o.edges) {
          subtypeMappings[e.id] = cells.filter(c => ownOf(id, c) !== undefined).map(c => {
            const s = ownOf(e.superId, c) ?? c
            return Array.isArray(s) ? s : [s]
          })
        }
      }
    }
    for (const [id, tuples] of Object.entries(F)) {
      // Tuples of an own identifier follow from the cells again.
      if (identifying.has(id)) continue
      const f = factById.get(id)
      const hs = f?.roles.map(r => holderOf(r.objectTypeId)) ?? []
      if (!hs.some(Boolean)) { factPopulations[id] = tuples; continue }
      factPopulations[id] = tuples.map(t => t.map((c, i) => (hs[i] ? ownOf(f.roles[i].objectTypeId, c) : c))).filter(t => t.every(c => c !== undefined))
    }
    return { populations, factPopulations, subtypeMappings, dropped }
  }

  return { state: newState, back, own }
}
