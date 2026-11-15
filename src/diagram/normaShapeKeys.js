// What a NORMA shape is drawn from, as kept by the import (occurrence
// normaShape.key) and compared by the export: a shape whose key is the same
// is written back with NORMA's own id and bounds (docs/norma-export.md,
// milestone 4). Shared by src/import/norma.js and src/export/norma.js.

const keyOf = (o) => JSON.stringify(o)

export const otShapeKey = (occ) => keyOf({ x: occ.x, y: occ.y })
export const factShapeKey = (occ) => keyOf({ x: occ.x, y: occ.y, orientation: occ.orientation ?? null,
  uniquenessBelow: !!occ.uniquenessBelow, roleOrder: occ.roleOrder ?? null, roleNamesShown: occ.roleNamesShown !== false,
  ...(occ.displayAsObjectType && { displayAsObjectType: true }) })
export const noteShapeKey = (n) => keyOf({ x: n.x, y: n.y, w: n.w, h: n.h })

// How NORMA links the shapes of two elements on a diagram (MultiShapeUtility
// .FindNearestShapeForElement): each shape on the "from" side is linked to
// the "to" shape nearest to it, centre to centre, unless another "from" shape
// is nearer to that "to" shape: then that one takes the link and this shape
// gets none. Shapes that don't attach the link are skipped on either side.
// Returns the pairs [from, to].
export function nearestShapePairs(froms, tos, { centre = (o) => o, fromOk = () => true, toOk = () => true } = {}) {
  const d = (a, b) => { const p = centre(a), q = centre(b); return Math.hypot(p.x - q.x, p.y - q.y) }
  const fs = froms.filter(fromOk), ts = tos.filter(toOk)
  const pairs = []
  for (const f of fs) {
    let best = null, bestD = Infinity
    for (const t of ts) {
      if (t === f) continue
      const dt = d(f, t)
      if (dt < bestD) { bestD = dt; best = t }
    }
    if (!best) continue
    if (fs.some(g => g !== f && g !== best && d(g, best) < bestD)) continue
    pairs.push([f, best])
  }
  return pairs
}

// NORMA's subtype links on a diagram: a shape of the subtype that attaches
// its supertypes is linked to the nearest shape of the supertype that
// attaches its subtypes (DisplayRelatedTypes: AttachAllTypes by default,
// AttachSubtypes, AttachSupertypes, AttachNoTypes), unless another shape of
// the subtype is nearer to that one (nearestShapePairs). Returns the pairs
// { subOccId, superOccId } for subtypeEndpointOccs.
export const attachesSupertypes = (setting) => !['AttachNoTypes', 'AttachSubtypes'].includes(setting)
export const attachesSubtypes = (setting) => !['AttachNoTypes', 'AttachSupertypes'].includes(setting)
export function subtypeLinkPairs(subOccs, superOccs, settingOf = (o) => o.displayRelatedTypes) {
  return nearestShapePairs(subOccs, superOccs, {
    fromOk: (o) => attachesSupertypes(settingOf(o)),
    toOk: (o) => attachesSubtypes(settingOf(o)),
  }).map(([sub, sup]) => ({ subOccId: sub.id, superOccId: sup.id }))
}
