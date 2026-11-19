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

// How NORMA links the shapes of two elements on a diagram: see
// src/diagram/roleLinks.js (nearestPairs), the one place proximity is decided.
export { nearestPairs as nearestShapePairs } from './roleLinks.js'
import { nearestPairs as nearestShapePairs } from './roleLinks.js'

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
