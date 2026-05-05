import { ROLE_W, ROLE_H, ROLE_GAP, displayRoleOrder } from '../components/FactTypeNode'

/**
 * Returns the outward-facing cardinal anchor point on a role box.
 *
 * Candidate sides: N, S, W, E (mid-points of each edge).
 * Inner edges are excluded — the east edge for every non-last role,
 * and the west edge for every non-first role — so connectors always
 * exit from the outer perimeter of the fact-type shape.
 * The closest remaining candidate to (tx, ty) is returned.
 */
export function roleAnchor(fact, roleIndex, tx, ty) {
  const n      = Math.max(fact.arity, 1)
  const dro    = displayRoleOrder(fact)
  const posIdx = dro.indexOf(roleIndex)
  const isFirst = posIdx === 0
  const isLast  = posIdx === n - 1

  if (fact.orientation === 'vertical') {
    const totalH = n * ROLE_W + (n - 1) * ROLE_GAP
    const startY = fact.y - totalH / 2
    const roleTopY = startY + posIdx * (ROLE_W + ROLE_GAP)
    const leftX   = fact.x - ROLE_H / 2
    const cx      = fact.x
    const cy      = roleTopY + ROLE_W / 2

    const candidates = [
      { x: cx,            y: roleTopY,          side: 'N' },
      { x: cx,            y: roleTopY + ROLE_W, side: 'S' },
      { x: leftX,         y: cy,                side: 'W' },
      { x: leftX + ROLE_H, y: cy,               side: 'E' },
    ]
    const allowed = candidates.filter(c => {
      if (c.side === 'N' && !isFirst) return false
      if (c.side === 'S' && !isLast)  return false
      return true
    })
    let best = allowed[0], bestDist = Infinity
    for (const p of allowed) {
      const d = (p.x - tx) ** 2 + (p.y - ty) ** 2
      if (d < bestDist) { bestDist = d; best = p }
    }
    return best
  }

  const startX = fact.x - (n * ROLE_W + (n - 1) * ROLE_GAP) / 2
  const roleX  = startX + posIdx * (ROLE_W + ROLE_GAP)
  const roleY  = fact.y - ROLE_H / 2
  const cx     = roleX + ROLE_W / 2
  const cy     = roleY + ROLE_H / 2

  const candidates = [
    { x: cx,             y: roleY,          side: 'N' },
    { x: cx,             y: roleY + ROLE_H, side: 'S' },
    { x: roleX,          y: cy,             side: 'W' },
    { x: roleX + ROLE_W, y: cy,             side: 'E' },
  ]
  const allowed = candidates.filter(c => {
    if (c.side === 'E' && !isLast)  return false
    if (c.side === 'W' && !isFirst) return false
    return true
  })

  let best = allowed[0], bestDist = Infinity
  for (const p of allowed) {
    const d = (p.x - tx) ** 2 + (p.y - ty) ** 2
    if (d < bestDist) { bestDist = d; best = p }
  }
  return best
}
