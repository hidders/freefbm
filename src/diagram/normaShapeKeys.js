// What a NORMA shape is drawn from, as kept by the import (occurrence
// normaShape.key) and compared by the export: a shape whose key is the same
// is written back with NORMA's own id and bounds (docs/norma-export.md,
// milestone 4). Shared by src/import/norma.js and src/export/norma.js.

const keyOf = (o) => JSON.stringify(o)

export const otShapeKey = (occ) => keyOf({ x: occ.x, y: occ.y })
export const factShapeKey = (occ) => keyOf({ x: occ.x, y: occ.y, orientation: occ.orientation ?? null,
  uniquenessBelow: !!occ.uniquenessBelow, roleOrder: occ.roleOrder ?? null, roleNamesShown: occ.roleNamesShown !== false })
export const noteShapeKey = (n) => keyOf({ x: n.x, y: n.y, w: n.w, h: n.h })
