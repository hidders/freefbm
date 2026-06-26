import {
  findRefMode,
  isCompleteValue,
  findCompositePI,
  findInheritedPI,
  getRoleCellShape,
  getEntityIdentifierShape,
  propagateValueToPlayer,
  findRolePlayer,
} from '../../utils/refMode.js'

export function createPopulationSlice(set, get) {
  return {
    // ── populations (sample data per object type) ──────────────────────────
    addPopulationInstance(otId, value = '') {
      set(s => {
        const current = s.populations?.[otId] ?? []
        return {
          populations: { ...s.populations, [otId]: [...current, value] },
          isDirty: true,
        }
      })
    },

    updatePopulationInstance(otId, index, value) {
      set(s => {
        const current = s.populations?.[otId] ?? []
        if (index < 0 || index >= current.length) return {}
        const next = current.slice()
        next[index] = value
        return {
          populations: { ...s.populations, [otId]: next },
          isDirty: true,
        }
      })
    },

    removePopulationInstance(otId, index) {
      set(s => {
        const current = s.populations?.[otId] ?? []
        if (index < 0 || index >= current.length) return {}
        const removedValue = current[index]
        const next = current.slice()
        next.splice(index, 1)
        const populations = { ...s.populations }
        if (next.length === 0) delete populations[otId]
        else populations[otId] = next

        // Cascade: if the entity/nested-entity has a ref-mode and the VT is not
        // independent, remove the VT instance unless still used elsewhere.
        if (isCompleteValue(removedValue)) {
          const ot = s.objectTypes.find(o => o.id === otId) ?? s.facts.find(f => f.id === otId)
          if (ot) {
            const rm = findRefMode(ot, s.facts, s.objectTypes)
            if (rm) {
              const vt = s.objectTypes.find(o => o.id === rm.vtId)
              if (vt && !vt.isIndependent) {
                const stillInEntity = next.includes(removedValue)
                const stillInFacts = !stillInEntity && s.facts.some(f =>
                  f.id !== rm.factId &&
                  f.roles?.some((r, ri) => r?.objectTypeId === rm.vtId &&
                    (s.factPopulations?.[f.id] ?? []).some(tuple =>
                      Array.isArray(tuple) && tuple[ri] === removedValue
                    )
                  )
                )
                if (!stillInEntity && !stillInFacts) {
                  const vtPop = populations[rm.vtId] ?? []
                  const vtIdx = vtPop.indexOf(removedValue)
                  if (vtIdx !== -1) {
                    const nextVt = vtPop.slice()
                    nextVt.splice(vtIdx, 1)
                    if (nextVt.length === 0) delete populations[rm.vtId]
                    else populations[rm.vtId] = nextVt
                  }
                }
              }
            }
          }
        }

        return { populations, isDirty: true }
      })
    },

    // ── composite-PI entity populations ────────────────────────────────────
    // For entities with a composite preferred identifier, instances are tuples
    // (one cell per identifying role, in the order returned by
    // findCompositePI(...).identifyingRoleIndices). Stored as string[][] under
    // populations[entityId].

    addEntityTuple(entityId, width) {
      set(s => {
        if (!Number.isInteger(width) || width < 1) return {}
        const current = s.populations?.[entityId] ?? []
        const tuple = Array(width).fill('')
        return {
          populations: { ...s.populations, [entityId]: [...current, tuple] },
          isDirty: true,
        }
      })
    },

    updateEntityTupleCell(entityId, tupleIndex, cellIndex, value) {
      set(s => {
        const current = s.populations?.[entityId] ?? []
        if (tupleIndex < 0 || tupleIndex >= current.length) return {}
        const oldTuple = current[tupleIndex]
        if (!Array.isArray(oldTuple) || cellIndex < 0 || cellIndex >= oldTuple.length) return {}
        const next = current.slice()
        const newTuple = oldTuple.slice()
        newTuple[cellIndex] = value
        next[tupleIndex] = newTuple
        return {
          populations: { ...s.populations, [entityId]: next },
          isDirty: true,
        }
      })
    },

    removeEntityTuple(entityId, tupleIndex) {
      set(s => {
        const current = s.populations?.[entityId] ?? []
        if (tupleIndex < 0 || tupleIndex >= current.length) return {}
        const next = current.slice()
        next.splice(tupleIndex, 1)
        const populations = { ...s.populations }
        if (next.length === 0) delete populations[entityId]
        else populations[entityId] = next
        return { populations, isDirty: true }
      })
    },

    // Commit a composite-PI tuple cell on blur: cascade the cell value to the
    // corresponding identifying-role player's population (and further via
    // propagateValueToPlayer). The cell value may be a string or a (possibly
    // nested) tuple; partial values are skipped.
    commitEntityTupleCell(entityId, tupleIndex, cellIndex) {
      set(s => {
        const entity = s.objectTypes.find(o => o.id === entityId)
        if (!entity || entity.kind !== 'entity') return {}
        // Composite-PI may be owned by this entity or inherited from a supertype
        // (regular or nested-entity). For inherited PIs the synthetic cp from
        // findInheritedPI still maps cellIndex → role player of the identifying
        // fact, so per-cell cascade works identically.
        let cp = findCompositePI(entity, s.facts, s.objectTypes, s.constraints)
        if (!cp) {
          const inh = findInheritedPI(entity, s.facts, s.objectTypes, s.subtypes, s.constraints)
          if (inh?.kind === 'compositePI') cp = inh.cp
        }
        if (!cp) return {}
        if (cellIndex < 0 || cellIndex >= cp.identifyingRoleIndices.length) return {}
        const tuple = s.populations?.[entityId]?.[tupleIndex]
        if (!Array.isArray(tuple)) return {}
        const raw = tuple[cellIndex]
        const value = typeof raw === 'string' ? raw.trim() : raw
        if (!isCompleteValue(value)) return {}
        const factIdForCell = cp.factIds ? cp.factIds[cellIndex] : cp.factId
        const fact = s.facts.find(f => f.id === factIdForCell)
        const roleIndex = cp.identifyingRoleIndices[cellIndex]
        const playerOtId = fact?.roles?.[roleIndex]?.objectTypeId
        if (!playerOtId) return {}
        const populations = { ...s.populations }
        const factPopulations = { ...s.factPopulations }
        const ctx = { facts: s.facts, objectTypes: s.objectTypes, subtypes: s.subtypes, constraints: s.constraints }
        let changed = propagateValueToPlayer(populations, factPopulations, playerOtId, value, ctx)
        // If the whole tuple is now complete, also cascade it from the entity
        // itself so inheriting supertypes (including nested-entity supertypes
        // whose factPopulations should mirror this entity's tuples) get the row
        // automatically — no manual "Propagate to supertype" click needed.
        if (isCompleteValue(tuple)) {
          if (propagateValueToPlayer(populations, factPopulations, entityId, tuple, ctx)) changed = true
        }
        return changed ? { populations, factPopulations, isDirty: true } : {}
      })
    },

    // Propagate a list of values into `targetOtId`'s population, cascading
    // further via the standard rules (inheriting supertypes, ref-mode VTs,
    // composite-PI identifying-role players). Used by the "Propagate" buttons.
    propagateValues(targetOtId, values) {
      set(s => {
        if (!Array.isArray(values) || values.length === 0) return {}
        const populations = { ...s.populations }
        const factPopulations = { ...s.factPopulations }
        const ctx = { facts: s.facts, objectTypes: s.objectTypes, subtypes: s.subtypes, constraints: s.constraints }
        let changed = false
        for (const v of values) {
          if (propagateValueToPlayer(populations, factPopulations, targetOtId, v, ctx, true)) changed = true
        }
        return changed ? { populations, factPopulations, isDirty: true } : {}
      })
    },

    // Commit an entity-population instance on blur: cascade the value to
    // inheriting supertypes and (for ref-mode entities) to the ref-mode VT.
    // For composite-PI entity tuples, each cell is committed via
    // commitEntityTupleCell instead — this action handles single-string
    // populations (ref-mode entities, inheriting subtypes thereof).
    commitPopulationInstance(otId, instanceIndex) {
      set(s => {
        const ot = s.objectTypes.find(o => o.id === otId)
        if (!ot || ot.kind !== 'entity') return {}
        const value = s.populations?.[otId]?.[instanceIndex]
        if (typeof value !== 'string') return {}
        const trimmed = value.trim()
        if (trimmed === '') return {}
        const populations = { ...s.populations }
        const factPopulations = { ...s.factPopulations }
        const ctx = { facts: s.facts, objectTypes: s.objectTypes, subtypes: s.subtypes, constraints: s.constraints }
        // propagateValueToPlayer would re-add it to otId itself; that's already
        // there. We want propagation TO supertypes and ref-mode VT, so call the
        // helper which is idempotent for the current entity.
        const changed = propagateValueToPlayer(populations, factPopulations, otId, trimmed, ctx)
        return changed ? { populations, factPopulations, isDirty: true } : {}
      })
    },

    // ── subtype-edge mapping populations ───────────────────────────────────
    // For non-inheriting subtype edges: rows hold the supertype-side identifying
    // cells corresponding to each subtype instance (by position in
    // populations[subtypeId]). The subtype-side cells are derived from the
    // subtype's population and aren't stored here.

    updateSubtypeMappingCell(edgeId, rowIndex, cellIndex, value) {
      set(s => {
        if (rowIndex < 0 || cellIndex < 0) return {}
        const current = s.subtypeMappings?.[edgeId] ?? []
        const next = current.slice()
        while (next.length <= rowIndex) next.push([])
        const row = Array.isArray(next[rowIndex]) ? next[rowIndex].slice() : []
        while (row.length <= cellIndex) row.push('')
        row[cellIndex] = value
        next[rowIndex] = row
        return {
          subtypeMappings: { ...s.subtypeMappings, [edgeId]: next },
          isDirty: true,
        }
      })
    },

    // Commit a non-inheriting subtype-mapping cell on blur. When the whole
    // mapping row is complete (at every depth), the implied supertype instance
    // (single value or tuple, possibly nested) is propagated to the supertype's
    // population, cascading further. Partial rows do nothing.
    commitSubtypeMappingCell(edgeId, rowIndex, cellIndex) { // eslint-disable-line no-unused-vars
      set(s => {
        const edge = s.subtypes.find(st => st.id === edgeId)
        if (!edge || edge.inheritsPreferredIdentifier !== false) return {}
        const sup = s.objectTypes.find(o => o.id === edge.superId)
        if (!sup) return {}
        const shape = getEntityIdentifierShape(sup, s.facts, s.objectTypes, s.subtypes, s.constraints)
        if (!shape) return {}
        const row = s.subtypeMappings?.[edgeId]?.[rowIndex]
        if (!Array.isArray(row)) return {}
        const width = shape.columns.length
        const cells = Array.from({ length: width }, (_, ci) => row[ci])
        const supValue = width === 1 ? cells[0] : cells
        if (!isCompleteValue(supValue)) return {}
        const populations = { ...s.populations }
        const factPopulations = { ...s.factPopulations }
        const ctx = { facts: s.facts, objectTypes: s.objectTypes, subtypes: s.subtypes, constraints: s.constraints }
        const changed = propagateValueToPlayer(populations, factPopulations, sup.id, supValue, ctx)
        return changed ? { populations, factPopulations, isDirty: true } : {}
      })
    },

    // ── fact-type populations ──────────────────────────────────────────────
    addFactTuple(factId) {
      set(s => {
        const fact = s.facts.find(f => f.id === factId)
        if (!fact) return {}
        const arity = fact.arity ?? fact.roles?.length ?? 0
        if (arity < 1) return {}
        const current = s.factPopulations?.[factId] ?? []
        // Each cell is initialised based on its role's player shape: a single
        // empty string for plain roles, or a fresh sub-tuple for composite-PI
        // entity roles.
        const tuple = (fact.roles ?? []).slice(0, arity).map(role => {
          const shape = getRoleCellShape(role, s.facts, s.objectTypes, s.subtypes, s.constraints)
          return shape.kind === 'tuple' ? Array(shape.width).fill('') : ''
        })
        return {
          factPopulations: { ...s.factPopulations, [factId]: [...current, tuple] },
          isDirty: true,
        }
      })
    },

    updateFactTupleCell(factId, tupleIndex, roleIndex, value) {
      set(s => {
        const current = s.factPopulations?.[factId] ?? []
        if (tupleIndex < 0 || tupleIndex >= current.length) return {}
        const oldTuple = current[tupleIndex]
        if (roleIndex < 0 || roleIndex >= oldTuple.length) return {}
        const next = current.slice()
        const newTuple = oldTuple.slice()
        newTuple[roleIndex] = value
        next[tupleIndex] = newTuple
        return {
          factPopulations: { ...s.factPopulations, [factId]: next },
          isDirty: true,
        }
      })
    },

    removeFactTuple(factId, tupleIndex) {
      set(s => {
        const current = s.factPopulations?.[factId] ?? []
        if (tupleIndex < 0 || tupleIndex >= current.length) return {}
        const next = current.slice()
        next.splice(tupleIndex, 1)
        const factPopulations = { ...s.factPopulations }
        if (next.length === 0) delete factPopulations[factId]
        else factPopulations[factId] = next
        return { factPopulations, isDirty: true }
      })
    },

    commitFactTupleCell(factId, tupleIndex, roleIndex) {
      set(s => {
        const fact = s.facts.find(f => f.id === factId)
        if (!fact) return {}
        const tuple = s.factPopulations?.[factId]?.[tupleIndex]
        if (!Array.isArray(tuple)) return {}
        const cell = tuple[roleIndex]
        if (typeof cell !== 'string') return {}
        const trimmed = cell.trim()
        if (trimmed === '') return {}
        const role = fact.roles?.[roleIndex]
        if (!role?.objectTypeId) return {}
        // If the role connects to an objectified fact with a reference mode,
        // propagate the identifier to the ref-mode VT instead of the fact.
        let targetId = role.objectTypeId
        const targetPlayer = findRolePlayer(targetId, s.objectTypes, s.facts)
        if (targetPlayer?.objectified) {
          const rm = findRefMode(targetPlayer, s.facts, s.objectTypes)
          if (rm) targetId = rm.vtId
        }
        const populations = { ...s.populations }
        const factPopulations = { ...s.factPopulations }
        const ctx = { facts: s.facts, objectTypes: s.objectTypes, subtypes: s.subtypes, constraints: s.constraints }
        const changed = propagateValueToPlayer(populations, factPopulations, targetId, trimmed, ctx)
        return changed ? { populations, factPopulations, isDirty: true } : {}
      })
    },

    // ── nested-entity combined-table populations ────────────────────────────
    // For objectified facts with an explicit PI. Rows are aligned by index:
    //   nestedEntityMappings[factId][i] = PI value for row i
    //   factPopulations[factId][i]      = fact tuple for row i
    // Both arrays grow and shrink together via addNestedEntityRow / removeNestedEntityRow.

    addNestedEntityRow(factId) {
      set(s => {
        const fact = s.facts.find(f => f.id === factId)
        if (!fact || !fact.objectified) return {}
        const arity = fact.arity ?? fact.roles?.length ?? 0
        // Fact side: one empty cell per role.
        const currentFact = s.factPopulations?.[factId] ?? []
        const factTuple = (fact.roles ?? []).slice(0, arity).map(role => {
          const shape = getRoleCellShape(role, s.facts, s.objectTypes, s.subtypes, s.constraints)
          return shape.kind === 'tuple' ? Array(shape.width).fill('') : ''
        })
        // PI side: derive width from the entity identifier shape.
        const piShape = getEntityIdentifierShape(fact, s.facts, s.objectTypes, s.subtypes, s.constraints)
        const piWidth = piShape?.columns?.length ?? 0
        const currentPop = s.nestedEntityMappings?.[factId] ?? []
        const piValue = piWidth <= 1 ? '' : Array(piWidth).fill('')
        return {
          factPopulations:      { ...s.factPopulations,      [factId]: [...currentFact, factTuple] },
          nestedEntityMappings: { ...s.nestedEntityMappings, [factId]: [...currentPop,  piValue]   },
          isDirty: true,
        }
      })
    },

    // Add PI values to a nested entity type's population without requiring the
    // caller to know about the parallel factPopulations structure.  For each
    // piValue in piValues that is not already present, one row is appended to
    // both nestedEntityMappings (the PI value) and factPopulations (an empty
    // fact tuple).  This is the "propagate to nested entity" action used when a
    // connecting fact tuple references an N instance that does not yet exist.
    propagateToNestedEntity(factId, piValues) {
      set(s => {
        const fact = s.facts.find(f => f.id === factId)
        if (!fact || !fact.objectified) return {}
        const arity = fact.arity ?? fact.roles?.length ?? 0
        const currentFact = s.factPopulations?.[factId] ?? []
        const currentPop  = s.nestedEntityMappings?.[factId] ?? []
        const existingKeys = new Set(currentPop.map(v => JSON.stringify(v)))
        const nextFact = [...currentFact]
        const nextPop  = [...currentPop]
        let changed = false
        for (const piValue of (piValues ?? [])) {
          const key = JSON.stringify(piValue)
          if (existingKeys.has(key)) continue
          existingKeys.add(key)
          const factTuple = (fact.roles ?? []).slice(0, arity).map(role => {
            const shape = getRoleCellShape(role, s.facts, s.objectTypes, s.subtypes, s.constraints)
            return shape.kind === 'tuple' ? Array(shape.width).fill('') : ''
          })
          nextFact.push(factTuple)
          nextPop.push(piValue)
          changed = true
        }
        if (!changed) return {}
        const factPopulations      = { ...s.factPopulations,      [factId]: nextFact }
        const nestedEntityMappings = { ...s.nestedEntityMappings, [factId]: nextPop  }
        return { factPopulations, nestedEntityMappings, isDirty: true }
      })
    },

    removeNestedEntityRow(factId, rowIndex) {
      set(s => {
        const currentFact = s.factPopulations?.[factId] ?? []
        const currentPop  = s.nestedEntityMappings?.[factId] ?? []
        const maxLen = Math.max(currentFact.length, currentPop.length)
        if (rowIndex < 0 || rowIndex >= maxLen) return {}
        const removedValue = currentPop[rowIndex]
        const nextFact = currentFact.slice(); nextFact.splice(rowIndex, 1)
        const nextPop  = currentPop.slice();  nextPop.splice(rowIndex,  1)
        const factPopulations      = { ...s.factPopulations }
        const nestedEntityMappings = { ...s.nestedEntityMappings }
        if (nextFact.length === 0) delete factPopulations[factId]
        else factPopulations[factId] = nextFact
        if (nextPop.length === 0) delete nestedEntityMappings[factId]
        else nestedEntityMappings[factId] = nextPop

        // Cascade: if the nested entity has a ref-mode and the VT is not
        // independent, remove the VT instance unless still used elsewhere.
        // factPopulations is already updated (row removed), so checking it for
        // factId gives the post-deletion state.
        let populations = s.populations
        if (isCompleteValue(removedValue)) {
          const fact = s.facts.find(f => f.id === factId)
          if (fact) {
            const rm = findRefMode(fact, s.facts, s.objectTypes)
            if (rm) {
              const vt = s.objectTypes.find(o => o.id === rm.vtId)
              if (vt && !vt.isIndependent) {
                const stillInNested = nextPop.includes(removedValue)
                const stillInFacts = !stillInNested && s.facts.some(f =>
                  f.id !== factId &&
                  f.roles?.some((r, ri) => r?.objectTypeId === rm.vtId &&
                    (s.factPopulations?.[f.id] ?? []).some(tuple =>
                      Array.isArray(tuple) && tuple[ri] === removedValue
                    )
                  )
                )
                if (!stillInNested && !stillInFacts) {
                  populations = { ...populations }
                  const vtPop = populations[rm.vtId] ?? []
                  const vtIdx = vtPop.indexOf(removedValue)
                  if (vtIdx !== -1) {
                    const nextVt = vtPop.slice()
                    nextVt.splice(vtIdx, 1)
                    if (nextVt.length === 0) delete populations[rm.vtId]
                    else populations[rm.vtId] = nextVt
                  }
                }
              }
            }
          }
        }

        return { factPopulations, nestedEntityMappings, populations, isDirty: true }
      })
    },

    updateNestedEntityPICell(factId, rowIndex, cellIndex, value) {
      set(s => {
        const current = s.nestedEntityMappings?.[factId] ?? []
        if (rowIndex < 0 || rowIndex >= current.length) return {}
        const oldVal = current[rowIndex]
        let newVal
        if (Array.isArray(oldVal)) {
          const arr = oldVal.slice()
          while (arr.length <= cellIndex) arr.push('')
          arr[cellIndex] = value
          newVal = arr
        } else {
          newVal = value  // single-column PI (ref-mode): string
        }
        const next = current.slice(); next[rowIndex] = newVal
        return { nestedEntityMappings: { ...s.nestedEntityMappings, [factId]: next }, isDirty: true }
      })
    },

    // On blur of any PI cell: propagate the complete PI value to the PI-defining roles.
    commitNestedEntityPICell(factId, rowIndex) {
      set(s => {
        const fact = s.facts.find(f => f.id === factId)
        if (!fact || !fact.objectified) return {}
        const piValue = s.nestedEntityMappings?.[factId]?.[rowIndex]
        if (!isCompleteValue(piValue)) return {}
        const populations      = { ...s.populations }
        const factPopulations  = { ...s.factPopulations }
        const ctx = { facts: s.facts, objectTypes: s.objectTypes, subtypes: s.subtypes, constraints: s.constraints }
        let changed = false
        const rm = findRefMode(fact, s.facts, s.objectTypes)
        if (rm) {
          if (typeof piValue === 'string') {
            if (propagateValueToPlayer(populations, factPopulations, rm.vtId, piValue, ctx)) changed = true
          }
        } else {
          let cp = findCompositePI(fact, s.facts, s.objectTypes, s.constraints)
          if (!cp) {
            const inh = findInheritedPI(fact, s.facts, s.objectTypes, s.subtypes, s.constraints)
            if (inh?.kind === 'compositePI') cp = inh.cp
          }
          if (cp && Array.isArray(piValue)) {
            const piFact = s.facts.find(f => f.id === cp.factId)
            if (piFact) {
              cp.identifyingRoleIndices.forEach((roleIndex, ci) => {
                const playerOtId = piFact.roles?.[roleIndex]?.objectTypeId
                const cellValue  = piValue[ci]
                if (playerOtId && isCompleteValue(cellValue)) {
                  if (propagateValueToPlayer(populations, factPopulations, playerOtId, cellValue, ctx)) changed = true
                }
              })
            }
          }
        }
        return changed ? { populations, factPopulations, isDirty: true } : {}
      })
    },
  }
}
