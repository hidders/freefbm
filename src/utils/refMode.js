// Reference-mode helpers.
//
// In ORM2, a reference mode is a shorthand for the following pattern:
//   entity ──(binary fact)── value type, with a preferred identifier on the
//   value-type role.
// These helpers detect that pattern and convert between a ref-mode "label"
// (what the user sees in the entity's inspector) and the underlying VT name.

// Detect a ref mode on `entity`. Returns { vtId, factId, vtRoleIndex } or null.
// Conditions:
//   - exactly one fact has arity 2, with this entity in one role and a value
//     type in the other, and a preferred-identifier unary UC on the VT role.
// If multiple candidate facts exist (shouldn't happen — only one PI per
// entity) we return the first one to keep the resolver total.
//
// `entity` may be either an entity ObjectType or a nested entity type
// (objectified fact with objectifiedKind !== 'value'). Nested value types
// and plain (non-objectified) facts never qualify.
export function findRefMode(entity, facts, objectTypes) {
  if (!entity) return null
  const isEntityOt    = entity.kind === 'entity'
  const isNestedEntity = !!entity.objectified && entity.objectifiedKind !== 'value'
  if (!isEntityOt && !isNestedEntity) return null
  const otById = new Map(objectTypes.map(o => [o.id, o]))
  for (const fact of facts) {
    if (fact.id === entity.id) continue
    if (fact.arity !== 2) continue
    if (!Array.isArray(fact.roles) || fact.roles.length !== 2) continue
    const [r0, r1] = fact.roles
    let entityRoleIndex = -1
    if (r0.objectTypeId === entity.id) entityRoleIndex = 0
    else if (r1.objectTypeId === entity.id) entityRoleIndex = 1
    else continue
    const vtRoleIndex = 1 - entityRoleIndex
    const vtId = fact.roles[vtRoleIndex].objectTypeId
    const vt = otById.get(vtId)
    if (!vt || vt.kind !== 'value') continue
    const piList = fact.preferredUniqueness || []
    const isPi = piList.some(pu => pu.length === 1 && pu[0] === vtRoleIndex)
    if (!isPi) continue
    return { vtId, factId: fact.id, vtRoleIndex }
  }
  return null
}

// Resolve a role-player id to either an object type or an objectified fact.
// Returns null when the id matches neither. Use this everywhere a role's
// `objectTypeId` is dereferenced — objectified facts can play roles in other
// facts just like entities can.
export function findRolePlayer(id, objectTypes, facts) {
  if (!id) return null
  const ot = objectTypes.find(o => o.id === id)
  if (ot) return ot
  const f = facts.find(ff => ff.id === id && ff.objectified)
  return f || null
}

// Display name for a player (either OT or objectified fact). Useful for
// labels, autocomplete tooltips, and error messages.
export function playerName(player) {
  if (!player) return ''
  return player.name || player.objectifiedName || ''
}

// Display label for a ref mode.
//   refModeLabel('Employee', 'EmployeeCode') === '.code'
//   refModeLabel('Employee', 'Code')         === 'Code'
export function refModeLabel(entityName, vtName) {
  if (!entityName || !vtName) return vtName ?? ''
  if (vtName.length > entityName.length && vtName.startsWith(entityName)) {
    const suffix = vtName.slice(entityName.length)
    return '.' + suffix.charAt(0).toLowerCase() + suffix.slice(1)
  }
  return vtName
}

// Inverse of refModeLabel — canonical VT name from a user-typed label.
//   vtNameFromLabel('Employee', '.code') === 'EmployeeCode'
//   vtNameFromLabel('Employee', 'Code')  === 'Code'
export function vtNameFromLabel(entityName, label) {
  if (!label) return ''
  if (label.startsWith('.')) {
    const suffix = label.slice(1)
    if (!suffix) return label  // bare '.' is not a complete label yet; don't expand to entity name
    return entityName + suffix.charAt(0).toUpperCase() + suffix.slice(1)
  }
  return label
}

// Returns the IDs of all entities that use this VT as their ref-mode VT.
// (Shared VTs can be referenced by multiple entities — see CompanyName ↔ Employee
//  + Customer in the design notes.)
export function entitiesUsingVtAsRefMode(vtId, facts, objectTypes) {
  const out = []
  for (const ot of objectTypes) {
    if (ot.kind !== 'entity') continue
    const rm = findRefMode(ot, facts, objectTypes)
    if (rm && rm.vtId === vtId) out.push(ot.id)
  }
  return out
}

// The "effective" population of an entity is now just its stored population.
// Cross-type relationships (subtype inclusion, ref-mode VT alignment, composite
// PI player alignment) are no longer derived silently: they're maintained at
// edit time via cascading propagation in the store and flagged by validation
// when they drift out of sync. Trailing args are kept for caller signature
// compatibility but are unused.
export function getEntityEffectivePopulation(entityId, populations /* , facts, objectTypes, subtypes, subtypeMappings */) {
  return populations?.[entityId] ?? []
}

// As above for value types — just the stored population.
export function getVtEffectivePopulation(vtId, populations /* , facts, objectTypes, subtypes, subtypeMappings */) {
  return populations?.[vtId] ?? []
}

// True iff the given fact is the ref-mode fact for some entity.
export function isRefModeFact(fact, facts, objectTypes) {
  if (!fact || fact.arity !== 2) return false
  for (const ot of objectTypes) {
    if (ot.kind !== 'entity') continue
    const rm = findRefMode(ot, facts, objectTypes)
    if (rm && rm.factId === fact.id) return true
  }
  return false
}

// Detect a *composite* preferred identifier on `entity`: an n-ary fact (n ≥ 2)
// with a preferredUniqueness covering exactly n-1 roles where the uncovered
// role is played by this entity. Excludes the binary VT-on-covered-role case,
// which is reported by findRefMode instead.
// Returns { factId, identifyingRoleIndices (sorted), entityRoleIndex } or null.
//
// Also detects composite PI defined by an external uniqueness constraint
// (constraintType === 'uniqueness', isPreferredIdentifier === true,
// targetObjectTypeId === entity.id) when `constraints` is provided.
//
// `entity` may be either an entity ObjectType or a nested entity type
// (objectified fact). For a nested entity its own underlying fact is skipped —
// uniqueness within the nested fact is not an external composite PI of the
// nested entity as a player.
export function findCompositePI(entity, facts, objectTypes, constraints) {
  if (!entity) return null
  const isEntityOt    = entity.kind === 'entity'
  const isNestedEntity = !!entity.objectified && entity.objectifiedKind !== 'value'
  if (!isEntityOt && !isNestedEntity) return null
  const refMode = findRefMode(entity, facts, objectTypes)
  for (const fact of facts) {
    if (fact.id === entity.id) continue
    if (refMode && fact.id === refMode.factId) continue
    if (!Array.isArray(fact.roles)) continue
    if (!fact.roles.some(r => r.objectTypeId === entity.id)) continue
    for (const pu of (fact.preferredUniqueness || [])) {
      if (!Array.isArray(pu)) continue
      if (pu.length !== fact.arity - 1) continue
      const covered = new Set(pu)
      let entityRoleIndex = -1
      for (let ri = 0; ri < fact.arity; ri++) {
        if (!covered.has(ri)) { entityRoleIndex = ri; break }
      }
      if (entityRoleIndex === -1) continue
      if (fact.roles[entityRoleIndex]?.objectTypeId !== entity.id) continue
      return {
        factId: fact.id,
        identifyingRoleIndices: [...pu].sort((a, b) => a - b),
        entityRoleIndex,
      }
    }
  }
  // Check external uniqueness constraints with isPreferredIdentifier.
  if (constraints) {
    for (const c of constraints) {
      if (c.constraintType !== 'uniqueness') continue
      if (!c.isPreferredIdentifier) continue
      if (c.targetObjectTypeId && c.targetObjectTypeId !== entity.id) continue
      const seq = (c.sequences ?? [])[0]
      if (!Array.isArray(seq) || seq.length === 0) continue
      const roleMembers = seq.filter(m => m.kind === 'role' && m.factId && !String(m.factId).includes('_il_'))
      if (roleMembers.length === 0) continue
      const firstFactId = roleMembers[0].factId
      if (roleMembers.every(m => m.factId === firstFactId)) {
        // Single-fact external uniqueness PI.
        if (refMode && firstFactId === refMode.factId) continue
        const fact = facts.find(f => f.id === firstFactId)
        if (!fact || fact.id === entity.id) continue
        const coveredIndices = new Set(roleMembers.map(m => m.roleIndex))
        const uncoveredRoles = (fact.roles || []).map((r, ri) => ({ r, ri })).filter(({ ri }) => !coveredIndices.has(ri))
        if (uncoveredRoles.length !== 1) continue
        const { r, ri: entityRoleIndex } = uncoveredRoles[0]
        if (r.objectTypeId !== entity.id) continue
        return {
          factId: firstFactId,
          identifyingRoleIndices: [...coveredIndices].sort((a, b) => a - b),
          entityRoleIndex,
          constraintId: c.id,
        }
      } else {
        // Cross-fact external uniqueness PI: roles come from different facts.
        // Each fact must have exactly 1 uncovered role, played by the same entity.
        const factGroups = new Map()
        for (const m of roleMembers) {
          if (!factGroups.has(m.factId)) factGroups.set(m.factId, [])
          factGroups.get(m.factId).push(m)
        }
        const segments = []
        let entityOtId = null
        let valid = true
        for (const [fid, members] of factGroups) {
          if (refMode && fid === refMode.factId) { valid = false; break }
          const f = facts.find(ff => ff.id === fid)
          if (!f || f.id === entity.id) { valid = false; break }
          const covered = new Set(members.map(m => m.roleIndex))
          const uncovered = (f.roles || []).map((r, ri) => ({ r, ri })).filter(({ ri }) => !covered.has(ri))
          if (uncovered.length !== 1) { valid = false; break }
          const { r, ri: entityRi } = uncovered[0]
          if (entityOtId === null) entityOtId = r.objectTypeId
          else if (entityOtId !== r.objectTypeId) { valid = false; break }
          for (const m of members) {
            segments.push({ factId: fid, identifyingRoleIndex: m.roleIndex, entityRoleIndex: entityRi })
          }
        }
        if (valid && entityOtId === entity.id && segments.length > 0) {
          return {
            factId: null,
            factIds: segments.map(s => s.factId),
            identifyingRoleIndices: segments.map(s => s.identifyingRoleIndex),
            entityRoleIndices: segments.map(s => s.entityRoleIndex),
            entityRoleIndex: segments[0].entityRoleIndex,
            constraintId: c.id,
          }
        }
      }
    }
  }
  return null
}

// Walk up inheriting subtype edges from `entity` to find an ancestor with a PI.
// Returns:
//   { kind: 'refMode',      refMode, supertype } — for ref-mode binaries
//   { kind: 'compositePI',  cp,      supertype } — for composite-PI schemes
//   null                                          — no inherited identifier
//
// Stops at the first ancestor that has a PI. Subtype edges with
// inheritsPreferredIdentifier === false break the chain.
export function findInheritedPI(entity, facts, objectTypes, subtypes, constraints) {
  if (!entity) return null
  const isEntityOt    = entity.kind === 'entity'
  const isNestedEntity = !!entity.objectified && entity.objectifiedKind !== 'value'
  if (!isEntityOt && !isNestedEntity) return null
  const visited = new Set([entity.id])
  const queue = [entity.id]
  while (queue.length) {
    const id = queue.shift()
    for (const st of subtypes || []) {
      if (st.subId !== id) continue
      if (st.inheritsPreferredIdentifier === false) continue
      const sup = findRolePlayer(st.superId, objectTypes, facts)
      const supIsEntity = sup?.kind === 'entity'
        || (sup?.objectified && sup?.objectifiedKind !== 'value')
      if (!sup || !supIsEntity || visited.has(sup.id)) continue
      visited.add(sup.id)
      const rm = findRefMode(sup, facts, objectTypes)
      if (rm) return { kind: 'refMode', refMode: rm, supertype: sup }
      const cp = findCompositePI(sup, facts, objectTypes, constraints)
      if (cp) return { kind: 'compositePI', cp, supertype: sup }
      // Nested entity with no explicit PI: implicit composite PI over its own
      // role players. Synthesize a cp so callers (population editors, etc.)
      // can treat it like any other composite PI.
      if (sup.objectified && sup.objectifiedKind !== 'value') {
        const arity = sup.arity ?? sup.roles?.length ?? 0
        const cpImplicit = {
          factId: sup.id,
          identifyingRoleIndices: Array.from({ length: arity }, (_, i) => i),
          entityRoleIndex: null,
        }
        return { kind: 'compositePI', cp: cpImplicit, supertype: sup }
      }
      queue.push(sup.id)
    }
  }
  return null
}

// Like findInheritedPI but collects ALL PI-owning supertypes reachable via
// PI-inheriting edges, without stopping at the first. BFS does not continue
// beyond a PI-owning supertype (its own supertypes' PIs don't pass through).
// Returns [] when none found. Used to detect ambiguous inherited PI.
export function findAllInheritedPIs(entity, facts, objectTypes, subtypes, constraints) {
  if (!entity) return []
  const isEntityOt     = entity.kind === 'entity'
  const isNestedEntity = !!entity.objectified && entity.objectifiedKind !== 'value'
  if (!isEntityOt && !isNestedEntity) return []
  const found = []
  const visited = new Set([entity.id])
  const queue = [entity.id]
  while (queue.length) {
    const id = queue.shift()
    for (const st of subtypes || []) {
      if (st.subId !== id) continue
      if (st.inheritsPreferredIdentifier === false) continue
      const sup = findRolePlayer(st.superId, objectTypes, facts)
      const supIsEntity = sup?.kind === 'entity'
        || (sup?.objectified && sup?.objectifiedKind !== 'value')
      if (!sup || !supIsEntity || visited.has(sup.id)) continue
      visited.add(sup.id)
      const rm = findRefMode(sup, facts, objectTypes)
      if (rm) { found.push({ kind: 'refMode', refMode: rm, supertype: sup }); continue }
      const cp = findCompositePI(sup, facts, objectTypes, constraints)
      if (cp) { found.push({ kind: 'compositePI', cp, supertype: sup }); continue }
      if (sup.objectified && sup.objectifiedKind !== 'value') {
        const arity = sup.arity ?? sup.roles?.length ?? 0
        found.push({ kind: 'compositePI', cp: { factId: sup.id, identifyingRoleIndices: Array.from({ length: arity }, (_, i) => i), entityRoleIndex: null }, supertype: sup })
        continue
      }
      queue.push(sup.id)
    }
  }
  return found
}

// Describes how one instance of `entity` is laid out as cells. Used by the
// subtype-mapping editor (and could replace ad-hoc column derivation elsewhere).
// Returns { kind, ownedBy, factId, columns: [{ label, playerOtId }], inheritedFrom? }
// or null if the entity has no own or inherited identifier.
//
// Also handles objectified facts (entity.objectified === true): their
// identifier is the fact's role tuple.
export function getEntityIdentifierShape(entity, facts, objectTypes, subtypes, constraints) {
  if (!entity) return null
  if (entity.objectified) {
    const rm = findRefMode(entity, facts, objectTypes)
    if (rm) {
      const vt = objectTypes.find(o => o.id === rm.vtId)
      return {
        kind: 'refMode',
        ownedBy: entity.id,
        factId: rm.factId,
        columns: [{
          label: refModeLabel(entity.objectifiedName || entity.name || '', vt?.name || ''),
          playerOtId: rm.vtId,
        }],
      }
    }
    const cp = findCompositePI(entity, facts, objectTypes, constraints)
    if (cp) {
      return {
        kind: 'compositePI',
        ownedBy: entity.id,
        factId: cp.factId,
        columns: cp.identifyingRoleIndices.map((ri, ci) => {
          const piFact = facts.find(f => f.id === (cp.factIds ? cp.factIds[ci] : cp.factId))
          const role = piFact?.roles?.[ri]
          const player = role?.objectTypeId ? objectTypes.find(o => o.id === role.objectTypeId) : null
          return {
            label: role?.roleName?.trim() || player?.name || `role ${ri + 1}`,
            playerOtId: role?.objectTypeId ?? null,
          }
        }),
      }
    }
    const inh = findInheritedPI(entity, facts, objectTypes, subtypes, constraints)
    if (inh) {
      const supShape = getEntityIdentifierShape(inh.supertype, facts, objectTypes, subtypes, constraints)
      if (supShape) return { ...supShape, inheritedFrom: inh.supertype }
    }
    return {
      kind: 'objectified',
      ownedBy: entity.id,
      factId: entity.id,
      columns: (entity.roles || []).map((role, ri) => {
        const subPlayer = role.objectTypeId
          ? findRolePlayer(role.objectTypeId, objectTypes, facts)
          : null
        return {
          label: role.roleName?.trim() || playerName(subPlayer) || `role ${ri + 1}`,
          playerOtId: role.objectTypeId ?? null,
        }
      }),
    }
  }
  if (entity.kind !== 'entity') return null
  const rm = findRefMode(entity, facts, objectTypes)
  if (rm) {
    const vt = objectTypes.find(o => o.id === rm.vtId)
    return {
      kind: 'refMode',
      ownedBy: entity.id,
      factId: rm.factId,
      columns: [{
        label: refModeLabel(entity.name, vt?.name || ''),
        playerOtId: rm.vtId,
      }],
    }
  }
  const cp = findCompositePI(entity, facts, objectTypes, constraints)
  if (cp) {
    return {
      kind: 'compositePI',
      ownedBy: entity.id,
      factId: cp.factId,
      columns: cp.identifyingRoleIndices.map((ri, ci) => {
        const fact = facts.find(f => f.id === (cp.factIds ? cp.factIds[ci] : cp.factId))
        const role = fact?.roles?.[ri]
        const player = role?.objectTypeId ? objectTypes.find(o => o.id === role.objectTypeId) : null
        return {
          label: role?.roleName?.trim() || player?.name || `role ${ri + 1}`,
          playerOtId: role?.objectTypeId ?? null,
        }
      }),
    }
  }
  const inh = findInheritedPI(entity, facts, objectTypes, subtypes, constraints)
  if (inh) {
    const supShape = getEntityIdentifierShape(inh.supertype, facts, objectTypes, subtypes, constraints)
    if (supShape) return { ...supShape, inheritedFrom: inh.supertype }
  }
  return null
}

// Recursive cell shape for a value that represents an instance of `player`.
//   - Non-entity / non-objectified-fact / null → { kind: 'single', playerOtId }
//   - Ref-mode or inherited-ref-mode entity    → { kind: 'single', playerOtId }
//   - Composite-PI entity (or inherited)       → { kind: 'tuple', playerOtId,
//                                                   columns: [<nested>] }
//   - Objectified fact (any arity ≥ 1)         → { kind: 'tuple', playerOtId,
//                                                   columns: [<nested per role>] }
// Each tuple column carries its own `label` and recursive shape, so the
// renderer can walk arbitrary nesting.
//
// Defensively breaks out of identifier cycles (which are a schema error
// flagged by validation) by collapsing the cycled player back to 'single'.
export function getNestedCellShape(player, facts, objectTypes, subtypes, constraints, _visited) {
  if (!player) return { kind: 'single', playerOtId: null }
  if (!player.objectified && player.kind !== 'entity') {
    return { kind: 'single', playerOtId: player.id }
  }
  const visited = _visited ?? new Set()
  if (visited.has(player.id)) {
    // Cycle break — render as opaque single cell; the schema error will tell
    // the user why.
    return { kind: 'single', playerOtId: player.id }
  }
  const shape = getEntityIdentifierShape(player, facts, objectTypes, subtypes, constraints)
  if (!shape || shape.columns.length === 0) {
    return { kind: 'single', playerOtId: player.id }
  }
  // Objectified facts with a ref-mode identifier (1 column) render as single,
  // showing the reference mode identifier string; multi-column shapes or
  // objectified facts without ref-mode render as tuple. Entities with
  // single-column identifier shapes stay as 'single'.
  if (shape.columns.length === 1) {
    return { kind: 'single', playerOtId: shape.columns[0].playerOtId ?? player.id }
  }
  const nextVisited = new Set(visited)
  nextVisited.add(player.id)
  return {
    kind: 'tuple',
    playerOtId: player.id,
    columns: shape.columns.map(col => {
      const subPlayer = col.playerOtId
        ? findRolePlayer(col.playerOtId, objectTypes, facts)
        : null
      const subShape = getNestedCellShape(subPlayer, facts, objectTypes, subtypes, constraints, nextVisited)
      return { label: col.label, ...subShape }
    }),
  }
}

// Detect identifier-graph cycles. Builds the entity→entity dependency graph
// (E → P if entity P is an identifying-role player anywhere in E's identifier
// scheme, including via inherited PI) and returns:
//   - the array of all entity IDs participating in any cycle (as a Set), and
//   - an array of cycle paths (each path = list of entity IDs forming a cycle).
// Inherited subtypes share the supertype's PI scheme — they're treated as if
// they "depend on" the supertype for the purpose of cycle detection.
//
// Nested entity types (objectified facts) are included as nodes. When a
// nested entity has no explicit PI (ref-mode, composite-PI in another fact,
// or inherited), it falls back to an implicit composite PI whose identifying
// role players are exactly the players of its own underlying fact's roles —
// so any role pointing back to itself (directly or via a PI-inheriting
// subtype) forms a cycle.
export function findIdentifierCycles(facts, objectTypes, subtypes, constraints) {
  const deps = new Map()  // entityId → Set<playerEntityId>
  const otById = new Map(objectTypes.map(o => [o.id, o]))
  const factById = new Map(facts.map(f => [f.id, f]))
  const nestedEntityFacts = facts.filter(f => f.objectified && f.objectifiedKind !== 'value')
  const entityIds = [
    ...objectTypes.filter(o => o.kind === 'entity').map(o => o.id),
    ...nestedEntityFacts.map(f => f.id),
  ]
  const addPlayer = (set, id) => {
    if (!id) return
    const ot = otById.get(id)
    if (ot?.kind === 'entity') { set.add(id); return }
    const f = factById.get(id)
    if (f?.objectified && f.objectifiedKind !== 'value') set.add(id)
  }
  for (const id of entityIds) {
    const entity = otById.get(id) ?? factById.get(id)
    const players = new Set()
    // Own ref-mode: depends only on a VT (no entity edge).
    const rm = findRefMode(entity, facts, objectTypes)
    if (rm) { deps.set(id, players); continue }
    // Own composite-PI: depends on each identifying-role player.
    const cp = findCompositePI(entity, facts, objectTypes, constraints)
    if (cp) {
      cp.identifyingRoleIndices.forEach((ri, ci) => {
        const factId = cp.factIds ? cp.factIds[ci] : cp.factId
        const fact = factById.get(factId)
        addPlayer(players, fact?.roles?.[ri]?.objectTypeId)
      })
      deps.set(id, players)
      continue
    }
    // PI-inheriting subtype edges: depend on each immediate supertype.
    // Walked here (not via findInheritedPI) so we still link to supertypes
    // whose own PI is implicit — e.g. a nested-entity supertype.
    let hasInheritance = false
    for (const st of (subtypes || [])) {
      if (st.subId !== id) continue
      if (st.inheritsPreferredIdentifier === false) continue
      addPlayer(players, st.superId)
      hasInheritance = true
    }
    if (!hasInheritance && entity?.objectified && entity.objectifiedKind !== 'value') {
      // Nested entity without explicit or inherited PI: implicit composite PI
      // over its own role players.
      for (const role of (entity.roles || [])) {
        addPlayer(players, role.objectTypeId)
      }
    }
    deps.set(id, players)
  }

  // Tarjan-ish DFS to find cycles.
  const cycles = []
  const inCycle = new Set()
  const colour = new Map()  // 0=unseen, 1=on-stack, 2=done
  const stack = []
  function dfs(node) {
    colour.set(node, 1)
    stack.push(node)
    for (const next of (deps.get(node) ?? [])) {
      const c = colour.get(next) ?? 0
      if (c === 1) {
        const idx = stack.indexOf(next)
        const cycle = stack.slice(idx)
        cycles.push(cycle)
        for (const n of cycle) inCycle.add(n)
      } else if (c === 0) {
        dfs(next)
      }
    }
    colour.set(node, 2)
    stack.pop()
  }
  for (const id of entityIds) {
    if ((colour.get(id) ?? 0) === 0) dfs(id)
  }
  return { cycles, inCycle }
}

// Cached single-entity cycle check. Returns the cycle that contains `entityId`
// (array of entity IDs in cycle order, starting at entityId), or null.
export function findIdentifierCycle(entityId, facts, objectTypes, subtypes) {
  const { cycles, inCycle } = findIdentifierCycles(facts, objectTypes, subtypes)
  if (!inCycle.has(entityId)) return null
  for (const c of cycles) {
    if (c.includes(entityId)) {
      const i = c.indexOf(entityId)
      return [...c.slice(i), ...c.slice(0, i)]
    }
  }
  return null
}

// How a fact-tuple cell representing one role-player instance is laid out.
// - { kind: 'single' }                                  — a single text input
//     (used for value-type players, ref-mode entity players, and roles without
//      a typed player)
// - { kind: 'tuple', width, columns: [{ label, playerOtId }] }
//                                                       — N inline sub-inputs
//     (used when the player is a composite-PI entity, including subtypes that
//      inherit a composite PI from their supertype)
export function getRoleCellShape(role, facts, objectTypes, subtypes, constraints) {
  if (!role?.objectTypeId) return { kind: 'single' }
  const playerOt = objectTypes.find(o => o.id === role.objectTypeId)
  if (!playerOt || playerOt.kind !== 'entity') return { kind: 'single' }
  const shape = getEntityIdentifierShape(playerOt, facts, objectTypes, subtypes, constraints)
  if (!shape || shape.columns.length <= 1) return { kind: 'single' }
  return { kind: 'tuple', width: shape.columns.length, columns: shape.columns }
}

// Sentinel value for unedited cell positions. Used to distinguish "user has
// not yet interacted with this cell" from "user cleared this cell to empty".
export const UNSET = '\x00'

// True iff `v` is a complete value tree: a non-empty string (not the UNSET
// sentinel), or a non-empty array whose every element is itself complete.
export function isCompleteValue(v) {
  if (typeof v === 'string') return v !== '' && v !== UNSET
  if (!Array.isArray(v)) return false
  if (v.length === 0) return false
  return v.every(isCompleteValue)
}

// Cascading propagation: add `value` to the stored population of `otId`,
// then propagate as required by the type's relationships:
//   - inheriting subtype edges: cascade to each supertype with the same value
//   - ref-mode entity: cascade the string value to the ref-mode VT
//   - composite-PI entity: cascade each tuple cell to the corresponding
//     identifying-role player (cells themselves may be nested tuples for
//     deeper composite PIs)
//   - objectified fact: store the tuple in factPopulations[factId]; cascade
//     each cell to the corresponding role player
//
// Empty/incomplete values are skipped (partial tuples never propagate).
// Mutates the supplied `populations` (for OT targets) and `factPopulations`
// (for objectified-fact targets) and returns true iff anything was added.
// `ctx` carries { facts, objectTypes, subtypes } — read only.
//
// The `_visited` set is keyed by `${otId}|${JSON(value)}` and guards against
// infinite recursion when the schema contains cycles (subtype cycles, or
// cyclic identifier schemes — both flagged by validation, but the helper
// stays defensive so any caller path is safe).
export function propagateValueToPlayer(populations, factPopulations, otId, value, ctx, allowPartial, _visited) {
  if (!populations || !factPopulations || !otId || !ctx) return false
  if (!allowPartial && !isCompleteValue(value)) return false
  const player = findRolePlayer(otId, ctx.objectTypes || [], ctx.facts || [])
  if (!player) return false

  const visited = _visited ?? new Set()
  const visitKey = `${otId}|${JSON.stringify(value)}`
  if (visited.has(visitKey)) return false
  visited.add(visitKey)

  let changed = false
  const isFact = !!player.objectified
  const slot = isFact ? factPopulations : populations
  const current = slot[otId] ?? []
  const key = JSON.stringify(value)
  const present = current.some(v => JSON.stringify(v) === key)
  if (!present) {
    slot[otId] = [...current, Array.isArray(value) ? [...value] : value]
    changed = true
  }

  // Objectified-fact target: cascade each tuple cell to its role player.
  if (isFact) {
    if (Array.isArray(value)) {
      (player.roles || []).forEach((role, ri) => {
        const cellValue = value[ri]
        const playerOtId = role.objectTypeId
        if (playerOtId && cellValue !== undefined && cellValue !== null) {
          if (propagateValueToPlayer(populations, factPopulations, playerOtId, cellValue, ctx, false, visited)) changed = true
        }
      })
    }
    return changed
  }

  if (player.kind !== 'entity') return changed

  // Cascade to inheriting supertypes (same encoding as this subtype).
  for (const st of (ctx.subtypes || [])) {
    if (st.subId !== otId) continue
    if (st.inheritsPreferredIdentifier === false) continue
    if (propagateValueToPlayer(populations, factPopulations, st.superId, value, ctx, allowPartial, visited)) changed = true
  }

  // Cascade to the entity's own identifier scheme (ref-mode or composite-PI).
  const rm = findRefMode(player, ctx.facts || [], ctx.objectTypes || [])
  if (rm) {
    if (typeof value === 'string') {
      if (propagateValueToPlayer(populations, factPopulations, rm.vtId, value, ctx, false, visited)) changed = true
    }
    return changed
  }
  const cp = findCompositePI(player, ctx.facts || [], ctx.objectTypes || [], ctx.constraints)
  if (cp && Array.isArray(value)) {
    cp.identifyingRoleIndices.forEach((roleIndex, ci) => {
      const factId = cp.factIds ? cp.factIds[ci] : cp.factId
      const fact = (ctx.facts || []).find(f => f.id === factId)
      const playerOtId = fact?.roles?.[roleIndex]?.objectTypeId
      const cellValue = value[ci]
      if (playerOtId && cellValue !== undefined && cellValue !== null) {
        if (propagateValueToPlayer(populations, factPopulations, playerOtId, cellValue, ctx, false, visited)) changed = true
      }
    })
  }
  return changed
}

/**
 * Checks whether an external uniqueness constraint satisfies the four conditions
 * required to be used as a composite preferred identifier:
 *   1. Every role in sequences[0] belongs to a binary (2-role) fact type.
 *   2. Each fact type appears at most once in the sequence.
 *   3. The uncovered role in every involved fact links to the same object type.
 *   4. If targetObjectTypeId is set, it must equal that common object type.
 *
 * Returns { ok: true, entityOtId } on success or { ok: false, reason } on failure.
 */
export function canBeExternalUniquenessPI(constraint, facts) {
  const seq = constraint.sequences?.[0] || []
  if (seq.length === 0) return { ok: false, reason: 'Role sequence is empty' }

  const seenFactIds = new Set()
  let commonEntityOtId = null

  for (const roleRef of seq) {
    if (roleRef.kind !== 'role') {
      return { ok: false, reason: 'Sequence contains non-role references' }
    }
    const fact = facts.find(f => f.id === roleRef.factId)
    if (!fact) {
      return { ok: false, reason: 'A referenced fact type does not exist' }
    }
    const roles = fact.roles || []
    if (roles.length !== 2) {
      return { ok: false, reason: 'All involved fact types must be binary (exactly 2 roles)' }
    }
    if (seenFactIds.has(roleRef.factId)) {
      return { ok: false, reason: 'Each fact type may appear at most once in the sequence' }
    }
    seenFactIds.add(roleRef.factId)
    const uncoveredIdx = roleRef.roleIndex === 0 ? 1 : 0
    const uncoveredOtId = roles[uncoveredIdx]?.objectTypeId
    if (!uncoveredOtId) {
      return { ok: false, reason: 'An uncovered role has no object type assigned' }
    }
    if (commonEntityOtId === null) {
      commonEntityOtId = uncoveredOtId
    } else if (commonEntityOtId !== uncoveredOtId) {
      return { ok: false, reason: 'The uncovered roles in all involved facts must link to the same object type' }
    }
  }

  if (constraint.targetObjectTypeId && constraint.targetObjectTypeId !== commonEntityOtId) {
    return { ok: false, reason: 'Target object type does not match the entity type in the uncovered roles' }
  }

  return { ok: true, entityOtId: commonEntityOtId }
}

// True iff the given fact is the identifying fact for some entity, either via
// a ref-mode binary or via a composite preferred identifier.
export function isIdentifyingFact(fact, facts, objectTypes, constraints) {
  if (!fact) return false
  for (const ot of objectTypes) {
    if (ot.kind !== 'entity') continue
    const rm = findRefMode(ot, facts, objectTypes)
    if (rm && rm.factId === fact.id) return true
    const cp = findCompositePI(ot, facts, objectTypes, constraints)
    if (cp && (cp.factId === fact.id || cp.factIds?.includes(fact.id))) return true
  }
  return false
}
