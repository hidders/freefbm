// Which occurrence a role's connector goes to, as NORMA decides it. NORMA
// saves no role connectors (RolePlayerLink is left out of its files); it
// rebuilds them on load and after every move with MultiShapeUtility
// .FindNearestShapeForElement, the rule written out here. This module is the
// one place FreeFBM works out proximity between shapes: role connectors,
// subtype links, the layout score and the NORMA import and export use it.
//
// The rule, for links from a shape of element A (a fact type) to the shapes
// of element B (a role's player, or a subtype's supertype):
// - each shape F of A finds the shape P of B nearest to it, centre to centre
//   (squared Euclidean distance); shapes of B that don't take the link are
//   skipped (NORMA's Defer: an entity type shape whose reference mode is
//   collapsed, for that reference mode's fact type);
// - F is linked to P unless another shape of A is strictly nearer to P: then
//   F's link is left out altogether (NORMA does not fall back to the second
//   nearest). So each shape of B takes at most one link per role, except
//   when two shapes of A are exactly as near to it;
// - on a tie for the nearest P, the shape of B later in the list wins (NORMA
//   walks the shapes last to first and keeps the first strictly nearer one).
// Each role is decided on its own, so the two roles of a ring fact type go
// to the same shape of their player.
//
// Centres are the shapes' as NORMA has them: an object type's box is centred
// on its occurrence point, a fact type's shape on its role boxes plus a band
// per level of uniqueness bars on the bars' side (factShapeCentre).

import { NORMA, PX_PER_INCH } from './normaGeometry.js'
import { findRefMode } from '../utils/refMode.js'

const d2 = (p, q) => (p.x - q.x) ** 2 + (p.y - q.y) ** 2
const self = (o) => o

// The candidate nearest to point p, NORMA's tie: the later one in the list.
export function nearestTo(p, candidates, centre = self) {
  let best = null, bestD = Infinity
  for (let i = candidates.length - 1; i >= 0; i--) {
    const dc = d2(p, centre(candidates[i]))
    if (dc < bestD) { bestD = dc; best = candidates[i] }
  }
  return best
}

// NORMA's links between the shapes of two elements: pairs [from, to] by the
// rule above. fromOk and toOk leave out shapes that take no link.
export function nearestPairs(froms, tos, { centre = self, fromOk = () => true, toOk = () => true } = {}) {
  const fs = froms.filter(fromOk), ts = tos.filter(toOk)
  if (!fs.length || !ts.length) return []
  const fc = fs.map(centre), tc = ts.map(centre)
  const pairs = []
  fs.forEach((f, i) => {
    let best = -1, bestD = Infinity
    for (let j = ts.length - 1; j >= 0; j--) {
      if (ts[j] === f) continue
      const dj = d2(fc[i], tc[j])
      if (dj < bestD) { bestD = dj; best = j }
    }
    if (best < 0) return
    for (let k = 0; k < fs.length; k++) {
      if (k !== i && fs[k] !== ts[best] && d2(fc[k], tc[best]) < bestD) return
    }
    pairs.push([f, ts[best]])
  })
  return pairs
}

// The number of levels of uniqueness bars NORMA draws on a fact type: one for
// all single-role bars (and those a preferred identifier implies), one per
// bar over several roles; a unary's uniqueness is not drawn.
export function normaBarLevels(f) {
  const ucs = (f.uniqueness ?? []).map(u => u.roles)
  const implied = (f.preferredUniqueness ?? []).some(pu => f.roles.some((_, ri) => !pu.includes(ri)))
  const single = f.roles.length > 1 && (ucs.some(r => r.length === 1) || implied)
  return (single ? 1 : 0) + ucs.filter(r => r.length > 1).length
}

// The centre of NORMA's shape of a fact type occurrence (occ: x, y at the
// middle of its role boxes, orientation, uniquenessBelow, displayAsObjectType;
// f: the fact type, for its bars). The bars' bands shift it towards them.
export function factShapeCentre(f, occ = f) {
  if (f.objectified && occ.displayAsObjectType) return { x: occ.x, y: occ.y }
  const shift = normaBarLevels(f) * NORMA.constraintBand * PX_PER_INCH / 2
  if (!shift) return { x: occ.x, y: occ.y }
  const below = !!(occ.uniquenessBelow ?? f.uniquenessBelow)
  const vertical = (occ.orientation ?? f.orientation) === 'vertical'
  // vertical: the bars are right of the roles, or left when "below"
  if (vertical) return { x: occ.x + (below ? -shift : shift), y: occ.y }
  return { x: occ.x, y: occ.y + (below ? shift : -shift) }
}

// Role links of a diagram, worked out per role when asked and kept.
//   facts:   fact type occurrences (any objects)
//   players: occurrences that can play roles: object types, and objectified
//            fact types (their occurrences stand for the nesting type)
//   factId(f), playerId(p): the schema element an occurrence shows
//   roleIds(f): the player's schema id for each role of f's fact type
//   centre(o): an occurrence's centre (default: o itself, { x, y })
//   accepts(p, f, ri): false when p takes no link from role ri of f
// linkOf(f, ri) is the player occurrence role ri of f links to, or null.
// Candidates are indexed by schema element, so a role costs (fact type
// occurrences) × (player occurrences + fact type occurrences) distance tests,
// not the whole diagram's: cheap enough to rebuild on every drag frame.
export function roleLinkIndex({ facts, players, factId = (f) => f.id, playerId = (p) => p.id,
  roleIds = (f) => f.roles.map(r => r?.objectTypeId ?? null), centre = self, accepts = () => true }) {
  const factsOf = new Map(), playersOf = new Map()
  for (const f of facts) {
    const id = factId(f)
    if (!factsOf.has(id)) factsOf.set(id, [])
    factsOf.get(id).push(f)
  }
  for (const p of players) {
    const id = playerId(p)
    if (!playersOf.has(id)) playersOf.set(id, [])
    playersOf.get(id).push(p)
  }
  const done = new Map()   // `${factId}\u0000${ri}` → Map(fact occurrence → player occurrence)
  const linksOfRole = (f, ri) => {
    const id = factId(f)
    const key = `${id}\u0000${ri}`
    let links = done.get(key)
    if (!links) {
      links = new Map()
      const pid = roleIds(f)[ri]
      const ps = pid != null ? playersOf.get(pid) : null
      if (ps) {
        const fs = factsOf.get(id) ?? [f]
        for (const [a, b] of nearestPairs(fs, ps, { centre, toOk: (p) => accepts(p, f, ri) })) links.set(a, b)
      }
      done.set(key, links)
    }
    return links
  }
  return {
    linkOf: (f, ri) => linksOfRole(f, ri).get(f) ?? null,
    playersOf: (id) => playersOf.get(id) ?? [],
    // the occurrence of element id nearest to point p (no two-sided test:
    // for things drawn once per diagram, such as link fact types)
    nearest: (id, p) => nearestTo(p, playersOf.get(id) ?? [], centre),
  }
}

// Where each role's player is drawn, by the rule above: the player's
// occurrence nearest to it, unless another occurrence of the fact type is
// nearer to that one. Nothing is stored (file format 3 drops the older
// roleOccurrenceMap and unlinkedRoles). Link fact types, drawn once per
// diagram, go to the nearest occurrence (nearest). Objectified fact types are
// players through their own occurrences. collapsedRefFacts and expandedOccs
// (useDiagramElements, the diagram's expandedRefModeOccs) keep a reference
// mode's fact type off entity type occurrences that show the mode
// collapsed, as NORMA does; refModeFacts (useDiagramElements) does the same
// for one shown on its own.
export function playerLookup(objectTypes, visibleFacts, { collapsedRefFacts = {}, refModeFacts = null, expandedOccs = null } = {}) {
  const nested = visibleFacts.filter(f => f.objectified && !f._implicit)
  const centres = new Map()
  const centre = (o) => {
    if (!o.roles) return o
    let c = centres.get(o)
    if (!c) centres.set(o, c = factShapeCentre(o))
    return c
  }
  // refModeFacts (factId → entity id, useDiagramElements) also covers a
  // reference mode fact type shown on its own; collapsedRefFacts only those hidden.
  const refEntity = new Map(refModeFacts ? Object.entries(refModeFacts)
    : Object.entries(collapsedRefFacts).map(([fid, e]) => [fid, e?.entityId]))
  const links = roleLinkIndex({
    facts: visibleFacts.filter(f => !f._implicit),
    players: [...objectTypes, ...nested],
    centre,
    accepts: (p, f) => !(expandedOccs && refEntity.get(f.id) === p.id && !expandedOccs.has(p.occurrenceId)),
  })
  const asPlayer = (p) => !p ? { ot: null, nf: null } : p.roles ? { ot: null, nf: p } : { ot: p, nf: null }
  const nearest = (id, x, y) => asPlayer(links.nearest(id, { x, y }))
  const forRole = (fact, ri) => fact.roles[ri]?.objectTypeId ? asPlayer(links.linkOf(fact, ri)) : { ot: null, nf: null }
  // each objectified fact type once: its link fact types are drawn once per diagram
  const linkOwners = []
  const seen = new Set()
  for (const f of visibleFacts) {
    if (!f.objectified || f._implicit || seen.has(f.id)) continue
    seen.add(f.id); linkOwners.push(f)
  }
  return { forRole, nearest, linkOwners }
}

// Role links of a diagram's stored occurrences, for the store's own
// decisions (which value type occurrence a reference mode uses, which
// occurrences a mapping diagram needs, …), as they are drawn: visible fact
// type occurrences link by the rule above to visible occurrences. A hidden
// occurrence of a collapsed reference mode's fact type links to its owner
// and to the occurrence of its other player that the same owner owns, else
// to that player's occurrence nearest to the owner.
//   diag: { occurrences, expandedRefModeOccs }; facts, objectTypes: the schema's
// linkOf(occ, ri) gives the occurrence, or null.
export function occurrenceRoleLinks(diag, facts, objectTypes) {
  const occs = diag?.occurrences ?? []
  const expanded = new Set(diag?.expandedRefModeOccs ?? [])
  const byId = new Map(occs.map(o => [o.id, o]))
  const factById = new Map(facts.map(f => [f.id, f]))
  const hidden = (o) => o.refModeOwnerOccId != null && !expanded.has(o.refModeOwnerOccId)
  const visible = occs.filter(o => !hidden(o))
  const isFact = (o) => factById.has(o.schemaElementId)
  const centres = new Map()
  const centre = (o) => {
    let c = centres.get(o)
    if (!c) {
      const f = factById.get(o.schemaElementId)
      centres.set(o, c = f ? factShapeCentre(f, o) : o)
    }
    return c
  }
  // a reference mode's fact type takes no link from an entity occurrence showing it collapsed
  const refFactOf = new Map()
  const refFact = (id) => {
    if (!refFactOf.has(id)) {
      const el = objectTypes.find(o => o.id === id) ?? factById.get(id)
      refFactOf.set(id, el && (el.kind === 'entity' || el.objectified) ? findRefMode(el, facts, objectTypes)?.factId ?? null : null)
    }
    return refFactOf.get(id)
  }
  const index = roleLinkIndex({
    facts: visible.filter(isFact),
    players: visible,
    factId: (o) => o.schemaElementId,
    playerId: (o) => o.schemaElementId,
    roleIds: (o) => factById.get(o.schemaElementId).roles.map(r => r?.objectTypeId ?? null),
    centre,
    accepts: (p, f) => expanded.has(p.id) || refFact(p.schemaElementId) !== f.schemaElementId,
  })
  return {
    linkOf(occ, ri) {
      const f = factById.get(occ.schemaElementId)
      const pid = f?.roles[ri]?.objectTypeId
      if (!pid) return null
      if (!hidden(occ)) return index.linkOf(occ, ri)
      const owner = byId.get(occ.refModeOwnerOccId)
      if (owner?.schemaElementId === pid) return owner
      return occs.find(o => o.schemaElementId === pid && o.refModeOwnerOccId === occ.refModeOwnerOccId)
        ?? nearestTo(owner ?? occ, occs.filter(o => o.schemaElementId === pid))
    },
    // the visible fact type occurrences with a role linked to occurrence occId
    linkedFrom(occId) {
      return visible.filter(o => isFact(o) && factById.get(o.schemaElementId).roles.some((_, ri) => index.linkOf(o, ri)?.id === occId))
    },
  }
}
