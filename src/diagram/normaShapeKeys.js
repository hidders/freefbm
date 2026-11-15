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

// NORMA's subtype links on a diagram: each shape of the subtype that attaches
// its supertypes is linked to the nearest shape of the supertype that
// attaches its subtypes (DisplayRelatedTypes: AttachAllTypes by default,
// AttachSubtypes, AttachSupertypes, AttachNoTypes). Returns the pairs
// { subOccId, superOccId } for subtypeEndpointOccs.
export const attachesSupertypes = (setting) => !['AttachNoTypes', 'AttachSubtypes'].includes(setting)
export const attachesSubtypes = (setting) => !['AttachNoTypes', 'AttachSupertypes'].includes(setting)
export function subtypeLinkPairs(subOccs, superOccs, settingOf = (o) => o.displayRelatedTypes) {
  const pairs = []
  for (const sub of subOccs) {
    if (!attachesSupertypes(settingOf(sub))) continue
    let best = null, bestD = Infinity
    for (const sup of superOccs) {
      if (sup.id === sub.id || !attachesSubtypes(settingOf(sup))) continue
      const d = Math.hypot(sup.x - sub.x, sup.y - sub.y)
      if (d < bestD) { bestD = d; best = sup }
    }
    if (best) pairs.push({ subOccId: sub.id, superOccId: best.id })
  }
  return pairs
}
