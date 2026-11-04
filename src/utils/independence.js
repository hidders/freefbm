// Independent types and implicit participation (Halpin): an instance of an
// entity type that is not independent plays at least one role other than the
// roles in which it is identified by its preferred identifier. Used by the
// Constraints tab (implicit participation entries), population validation,
// constraint accounting and the equivalence check.

// Whether a type (object type or objectified fact type) is independent. The
// rows of a relational schema's tables (encoding B: table = entity type) may
// exist with only their key, so its entity types count as independent.
export function isIndependentType(el, schemas) {
  if (!el) return false
  if (el.isIndependent) return true
  if (el.kind !== 'entity') return false
  const s = (schemas ?? []).find(x => x.id === el.schemaId)
  return s?.profile === 'relational'
}

// Roles in which the player is the type identified by a preferred identifier:
// the one role outside an internal preferred uniqueness, and the roles outside
// the sequence of an external preferred uniqueness. Returns "factId:roleIndex".
export function identifiedRoles(state) {
  const out = new Set()
  for (const f of (state.facts ?? [])) {
    if (f.objectified && f.objectifiedKind !== 'value') continue
    for (const u of (f.preferredUniqueness ?? [])) {
      const others = f.roles.map((_, i) => i).filter(i => !u.includes(i))
      if (others.length === 1) out.add(`${f.id}:${others[0]}`)
    }
  }
  const factById = new Map((state.facts ?? []).map(f => [f.id, f]))
  for (const c of (state.constraints ?? [])) {
    if (c.constraintType !== 'uniqueness' || !c.isPreferredIdentifier) continue
    const inSeq = new Set()
    for (const seq of (c.sequences ?? []))
      for (const m of seq) if (m.kind === 'role' && m.factId) inSeq.add(`${m.factId.split('_il_')[0]}:${m.roleIndex}`)
    for (const key of inSeq) {
      const fact = factById.get(key.split(':')[0])
      fact?.roles.forEach((_, i) => { if (!inSeq.has(`${fact.id}:${i}`)) out.add(`${fact.id}:${i}`) })
    }
  }
  return out
}
