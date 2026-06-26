import { constraintMaxSequences, isSingletonSequence, isOpenEndedConstruction } from '../../utils/constraintRules.js'
import {
  uid, mkConstraint, mkConstraintOcc, mkOcc,
  addOccIfAbsent, addCOccIfAbsent, patchCOcc, patchCOccById, rmCOcc,
  roleOccRefsKey, syncConstraints, getConstraintDeps, getConstraintQueryDeps,
  findUniqueLCA, findPathDown, demoteOtherPIsFor, runFactMergePass,
} from '../storeHelpers'

export function createConstraintSlice(set, get) {
  return {
    // Add a constraint occurrence with explicit roleOccurrenceRefs and queryOccurrenceRefs.
    // Allows multiple occurrences of the same schema constraint (one per unique roleOccurrenceRefs combination).
    // Silently does nothing if this exact roleOccurrenceRefs fingerprint already exists (rule 2).
    addConstraintToDiagram(constraintId, diagramId, roleOccurrenceRefs = {}, queryOccurrenceRefs = {}) {
      const s = get()
      const c = s.constraints.find(x => x.id === constraintId)
      if (!c) return
      const diag = s.diagrams.find(d => d.id === diagramId)
      if (!diag) return
      const newKey = roleOccRefsKey(roleOccurrenceRefs)
      const isDuplicate = (diag.constraintOccurrences ?? []).some(co =>
        co.schemaConstraintId === constraintId && roleOccRefsKey(co.roleOccurrenceRefs) === newKey
      )
      if (isDuplicate) return
      set(s => ({
        diagrams: s.diagrams.map(d => {
          if (d.id !== diagramId) return d
          // Offset subsequent occurrences so they don't land on top of existing ones.
          const existingCount = (d.constraintOccurrences ?? []).filter(co => co.schemaConstraintId === constraintId).length
          const offsetX = existingCount * 24
          const cocc = { ...mkConstraintOcc(constraintId, (c.x ?? 0) + offsetX, (c.y ?? 0) + offsetX), roleOccurrenceRefs, queryOccurrenceRefs }
          return { ...d, constraintOccurrences: [...(d.constraintOccurrences ?? []), cocc] }
        }),
        isDirty: true,
        selectedId: constraintId, selectedKind: 'constraint',
      }))
    },

    // Begin a guided pick flow for adding a constraint.
    // Phase 1: sequence deps (fact types/OTs directly connected via sequences/roleSequences).
    // Phase 2: query deps (all elements referenced in the constraint's query atoms).
    // For each dep: 0 occurrences → auto-create; 1 → auto-resolve; 2+ → user picks.
    // Sequence deps also serve as query anchors so they are not re-asked in phase 2.
    startConstraintEndpointPick(constraintId, diagramId) {
      const s = get()
      const c = s.constraints.find(x => x.id === constraintId)
      if (!c) return
      const diag = s.diagrams.find(d => d.id === diagramId) ?? s.diagrams.find(d => d.id === s.activeDiagramId)
      if (!diag) return
      const targetDiagramId = diag.id

      const seqDeps = getConstraintDeps(c, s.facts, s.objectTypes)
      const queryDeps = getConstraintQueryDeps(c, s.facts, s.objectTypes, s.subtypes)
      const seqDepIds = new Set(seqDeps.map(d => d.schemaId))

      let occs = [...(diag.occurrences ?? [])]
      const newOccs = []
      const newSubtypeOccs = []
      const resolvedRefs = {}
      const queryResolvedRefs = {}
      const pendingPicks = []

      // Phase 1: sequence deps
      for (const dep of seqDeps) {
        const existing = occs.filter(o => o.schemaElementId === dep.schemaId)
        if (existing.length === 0) {
          const el = s.facts.find(f => f.id === dep.schemaId) ?? s.objectTypes.find(o => o.id === dep.schemaId)
          if (el) {
            const newOcc = mkOcc(dep.schemaId, el.x ?? 0, el.y ?? 0)
            newOccs.push(newOcc)
            occs.push(newOcc)
            for (const mk of dep.memberKeys) resolvedRefs[mk] = newOcc.id
            queryResolvedRefs[dep.schemaId] = newOcc.id
          }
        } else if (existing.length === 1) {
          for (const mk of dep.memberKeys) resolvedRefs[mk] = existing[0].id
          queryResolvedRefs[dep.schemaId] = existing[0].id
        } else {
          pendingPicks.push({ ...dep, targetRef: 'role' })
        }
      }

      // Phase 2: query-only deps (skip anything already handled as a sequence dep)
      const processedQueryIds = new Set(seqDepIds)
      for (const dep of queryDeps) {
        if (processedQueryIds.has(dep.schemaId)) continue
        processedQueryIds.add(dep.schemaId)

        if (dep.kind === 'subtype') {
          // Subtypes have at most one occurrence; auto-add if missing
          const stOccs = diag.subtypeOccurrences ?? []
          if (!stOccs.includes(dep.schemaId)) newSubtypeOccs.push(dep.schemaId)
          // No queryOccurrenceRef needed for subtypes (only one occurrence possible)
          continue
        }

        const existing = occs.filter(o => o.schemaElementId === dep.schemaId)
        if (existing.length === 0) {
          const el = s.facts.find(f => f.id === dep.schemaId) ?? s.objectTypes.find(o => o.id === dep.schemaId)
          if (el) {
            const newOcc = mkOcc(dep.schemaId, el.x ?? 0, el.y ?? 0)
            newOccs.push(newOcc)
            occs.push(newOcc)
            queryResolvedRefs[dep.schemaId] = newOcc.id
          }
        } else if (existing.length === 1) {
          queryResolvedRefs[dep.schemaId] = existing[0].id
        } else {
          pendingPicks.push({ ...dep, targetRef: 'query' })
        }
      }

      if (newOccs.length > 0 || newSubtypeOccs.length > 0) {
        set(s => ({
          diagrams: s.diagrams.map(d => {
            if (d.id !== targetDiagramId) return d
            return {
              ...d,
              occurrences: newOccs.length > 0 ? [...(d.occurrences ?? []), ...newOccs] : d.occurrences,
              subtypeOccurrences: newSubtypeOccs.length > 0
                ? [...new Set([...(d.subtypeOccurrences ?? []), ...newSubtypeOccs])]
                : d.subtypeOccurrences,
            }
          }),
          isDirty: true,
        }))
      }

      if (pendingPicks.length === 0) {
        get().addConstraintToDiagram(constraintId, targetDiagramId, resolvedRefs, queryResolvedRefs)
        return
      }
      set({ linkDraft: { type: 'constraintEndpointPick', constraintId, diagramId: targetDiagramId, pendingPicks, resolvedRefs, queryResolvedRefs } })
    },

    // Called when the user clicks a fact or OT occurrence during constraintEndpointPick mode.
    pickConstraintEndpoint(occurrenceId) {
      const draft = get().linkDraft
      if (!draft || draft.type !== 'constraintEndpointPick') return
      const [currentPick, ...remainingPicks] = draft.pendingPicks
      if (!currentPick) return
      const newRefs = { ...draft.resolvedRefs }
      const newQueryRefs = { ...(draft.queryResolvedRefs ?? {}) }
      if (currentPick.targetRef !== 'query') {
        // Sequence dep: update roleOccurrenceRefs for each memberKey
        for (const mk of (currentPick.memberKeys ?? [])) newRefs[mk] = occurrenceId
      }
      // All picks also anchor this schema element in queryOccurrenceRefs
      newQueryRefs[currentPick.schemaId] = occurrenceId
      if (remainingPicks.length === 0) {
        get().addConstraintToDiagram(draft.constraintId, draft.diagramId, newRefs, newQueryRefs)
        set({ linkDraft: null })
      } else {
        set({ linkDraft: { ...draft, pendingPicks: remainingPicks, resolvedRefs: newRefs, queryResolvedRefs: newQueryRefs } })
      }
    },

    toggleSubtypeInConstraint(constraintId, subtypeId) {
      // Legacy flat list (kept for non-groups constraints)
      set(s => ({
        constraints: s.constraints.map(c => {
          if (c.id !== constraintId) return c
          const ids = c.subtypeIds || []
          return { ...c, subtypeIds: ids.includes(subtypeId) ? ids.filter(id => id !== subtypeId) : [...ids, subtypeId] }
        }),
        isDirty: true,
      }))
    },

    // ── sequence-based constraint actions ────────────────────────────────────

    // ── sequence construction ─────────────────────────────────────────────────
    // mode: 'newSequence' | 'extend'
    startSequenceConstruction(constraintId, mode) {
      const c = get().constraints.find(c => c.id === constraintId)
      if (!c) return
      const sequences = c.sequences || []
      let steps
      const isSingleton   = isSingletonSequence(c.constraintType)
      const openEndedType = isOpenEndedConstruction(c.constraintType)
      const maxSequences  = constraintMaxSequences(c.constraintType)
      if (mode === 'newSequence') {
        if (sequences.length >= maxSequences) return
        const newSequenceIdx = sequences.length
        const size = (c.constraintType === 'ring' || c.constraintType === 'valueComparison') ? 2
          : isSingleton ? 1 : (sequences.length > 0 ? sequences[0].length : 1)
        steps = Array.from({ length: size }, () => ({ sequenceIndex: newSequenceIdx }))
      } else {
        // extend: one pick per sequence
        if (sequences.length === 0) return
        steps = sequences.map((_, i) => ({ sequenceIndex: i }))
      }
      const openEnded = mode === 'newSequence' && openEndedType && sequences.length === 0
      set({ sequenceConstruction: { constraintId, steps, collected: [], openEnded } })
    },

    collectSequenceMember(member) {
      // Roles from implied links are not allowed in external constraint sequences
      if (member.kind === 'role' && member.factId.includes('_il_')) return

      const gc = get().sequenceConstruction
      if (!gc || gc.steps.length === 0) return

      const [current, ...remaining] = gc.steps
      const gi = current.sequenceIndex

      // Duplicate check: member must not already be in this sequence
      const memberEq = (a, b) => {
        if (!a || !b || a.kind !== b.kind) return false
        if (a.kind === 'role')    return a.factId === b.factId && a.roleIndex === b.roleIndex
        if (a.kind === 'subtype') return a.subtypeId === b.subtypeId
        return false
      }
      const existingSequence = get().constraints.find(c => c.id === gc.constraintId)?.sequences?.[gi] || []
      const inExisting = existingSequence.some(m => memberEq(m, member))
      const inCollected = gc.collected.some(item => item.sequenceIndex === gi && memberEq(item.member, member))
      if (inExisting || inCollected) {
        set({ sequenceConstruction: { ...gc, warning: 'Already in sequence' } })
        return
      }

      const collected = [...gc.collected, { sequenceIndex: gi, member }]
      if (remaining.length === 0 && gc.openEnded) {
        // Open-ended: keep going — append another step for the same sequence
        set({ sequenceConstruction: { ...gc, steps: [{ sequenceIndex: gi }], collected, warning: null } })
      } else if (remaining.length === 0) {
        get()._commitSequenceConstruction(gc.constraintId, collected)
      } else {
        set({ sequenceConstruction: { ...gc, steps: remaining, collected, warning: null } })
      }
    },

    _commitSequenceConstruction(constraintId, collected) {
      const fromMenu = get().tool === 'connectConstraint'
      set({ sequenceConstruction: null, tool: 'select',
        ...(fromMenu ? { selectedId: null, selectedKind: null } : {}) })
      set(s => {
        const newConstraints = s.constraints.map(c => {
          if (c.id !== constraintId) return c
          const originalLength = (c.sequences || []).length
          let sequences = (c.sequences || []).map(g => [...g])
          for (const { sequenceIndex, member } of collected) {
            if (sequenceIndex >= sequences.length) {
              while (sequences.length < sequenceIndex) sequences.push([])
              sequences.push([member])
            } else {
              sequences[sequenceIndex] = [...sequences[sequenceIndex], member]
            }
          }
          // Remove newly added sequences that are schema-equivalent to an existing one
          // (same roles/subtypes in same order, regardless of which occurrences were chosen)
          const seqMemberEq = (a, b) => {
            if (!a || !b || a.kind !== b.kind) return false
            if (a.kind === 'role') return a.factId === b.factId && a.roleIndex === b.roleIndex
            if (a.kind === 'subtype') return a.subtypeId === b.subtypeId
            return false
          }
          const existingSeqs = sequences.slice(0, originalLength)
          sequences = sequences.filter((seq, i) =>
            i < originalLength ||
            !existingSeqs.some(ex => ex.length === seq.length && ex.every((m, j) => seqMemberEq(m, seq[j])))
          )
          // Pad queries array to match sequences length (new sequences get null query)
          const queries = [...(c.queries || [])]
          while (queries.length < sequences.length) queries.push(null)
          return { ...c, sequences, queries }
        })
        return {
          constraints: newConstraints,
          diagrams: syncConstraints(s.diagrams, newConstraints, s.subtypes, s.facts),
          isDirty: true,
        }
      })
      // After committing, try to auto-generate query/target for supported constraint types
      get()._tryAutoGenerateQuery(constraintId)
    },

    _tryAutoGenerateQuery(constraintId) {
      const { constraints, facts, subtypes } = get()
      const c = constraints.find(c => c.id === constraintId)
      if (!c) return

      if (['uniqueness', 'ring', 'valueComparison', 'frequency'].includes(c.constraintType)) {
        const seq = c.sequences?.[0] ?? []
        const roleMembers = seq.filter(m => m.kind === 'role' && !m.factId?.includes('_il_'))
        if (roleMembers.length === 0 || roleMembers.length !== seq.length) return

        // Don't overwrite an existing query
        if (c.queries?.[0] != null) return

        const hasTargetOt = c.constraintType === 'uniqueness' || c.constraintType === 'frequency'
        const commitQuery = (atoms, links, lcaId) => {
          set(s => ({
            constraints: s.constraints.map(con => {
              if (con.id !== constraintId) return con
              const queries = [...(con.queries || [])]
              while (queries.length < 1) queries.push(null)
              queries[0] = { atoms, links }
              return { ...con, ...(hasTargetOt && lcaId ? { targetObjectTypeId: lcaId } : {}), queries }
            }),
            isDirty: true,
          }))
        }

        // ── Case 1 (ring only): both roles in the same fact type ─────────────────
        // No binary-fact requirement — any arity is allowed here.
        if (c.constraintType === 'ring' && roleMembers.length === 2
            && roleMembers[0].factId === roleMembers[1].factId) {
          const factCopyId = uid()
          commitQuery(
            [{ id: factCopyId, kind: 'fact', originalId: roleMembers[0].factId,
               isOutput: false,
               seededRoles: roleMembers.map((m, i) => ({ roleIndex: m.roleIndex, seqPosition: i })),
               dx: 16, dy: 16 }],
            [],
            null,
          )
          return
        }

        // ── Case 2: all roles from distinct binary fact types, unique LCA of other-role OTs ─
        // All roles must be in binary fact types.
        for (const m of roleMembers) {
          const f = facts.find(f => f.id === m.factId)
          if (!f || f.arity !== 2) return
        }
        // Each factId must be distinct.
        const factIds = roleMembers.map(m => m.factId)
        if (new Set(factIds).size !== factIds.length) return

        // Collect the OT at the OTHER role of each fact.
        const otherOtIds = []
        for (const m of roleMembers) {
          const f = facts.find(f => f.id === m.factId)
          const otId = f.roles[1 - m.roleIndex]?.objectTypeId
          if (!otId) return
          otherOtIds.push(otId)
        }

        const lcaId = findUniqueLCA(otherOtIds, subtypes)
        if (!lcaId) return
        if (hasTargetOt && c.targetObjectTypeId && c.targetObjectTypeId !== lcaId) return

        // Build tree: root OT atom for LCA; per branch a path of subtype edge atoms
        // from the LCA down to the other-role OT, then the fact atom.
        const rootAtomId = uid()
        const atoms = [
          { id: rootAtomId, kind: 'objectType', originalId: lcaId,
            isOutput: hasTargetOt, dx: 16, dy: 16 },
        ]
        const links = []

        for (let i = 0; i < roleMembers.length; i++) {
          const m = roleMembers[i]
          const P = otherOtIds[i]
          const path = findPathDown(lcaId, P, subtypes)
          if (path === null) return  // LCA not actually an ancestor — schema inconsistency

          let prevOtAtomId = rootAtomId
          for (const step of path) {
            const childOtAtomId = uid()
            const stAtomId = uid()
            atoms.push({ id: childOtAtomId, kind: 'objectType', originalId: step.toId,
              isOutput: false, dx: (i + 2) * 16, dy: (i + 2) * 16 })
            atoms.push({ id: stAtomId, kind: 'subtype', originalId: step.subtypeId,
              isOutput: false, dx: (i + 2) * 16, dy: (i + 2) * 16 })
            links.push({ atomId: stAtomId, roleIndex: 1, variableId: prevOtAtomId })  // supertype end
            links.push({ atomId: stAtomId, roleIndex: 0, variableId: childOtAtomId }) // subtype end
            prevOtAtomId = childOtAtomId
          }

          const factAtomId = uid()
          atoms.push({ id: factAtomId, kind: 'fact', originalId: m.factId,
            isOutput: false, seededRoles: [{ roleIndex: m.roleIndex, seqPosition: i }],
            dx: (i + 3) * 16, dy: (i + 3) * 16 })
          links.push({ atomId: factAtomId, roleIndex: 1 - m.roleIndex, variableId: prevOtAtomId })
        }

        commitQuery(atoms, links, lcaId)
      }

      if (c.constraintType === 'inclusiveOr' || c.constraintType === 'exclusiveOr') {
        const sequences = c.sequences ?? []
        if (sequences.length === 0) return
        const allSubtypes = get().subtypes

        // Helper: regenerate queries for ALL sequences using the given LCA as target OT.
        // Always regenerates all sequences so every query uses the same LCA.
        const applyQueries = (targetOtId, buildQuery) => {
          const newQueries = sequences.map((_, i) => buildQuery(i))
          set(s => ({
            constraints: s.constraints.map(con =>
              con.id !== constraintId ? con : { ...con, targetObjectTypeId: targetOtId, queries: newQueries }
            ),
            isDirty: true,
          }))
        }

        // ── Rule: every sequence is a single subtype edge or single role; anchor OTs share a unique LCA ──
        // Anchor OT for a subtype edge = superId; for a role = the OT of that role.
        const members = sequences.map(seq => {
          if (seq.length !== 1) return null
          const m = seq[0]
          if (m.kind === 'subtype') {
            const st = allSubtypes.find(s => s.id === m.subtypeId)
            return st ? { kind: 'subtype', st, anchorOtId: st.superId } : null
          }
          if (m.kind === 'role' && !m.factId?.includes('_il_')) {
            const f = facts.find(f => f.id === m.factId)
            const otId = f?.roles[m.roleIndex]?.objectTypeId ?? null
            return otId ? { kind: 'role', m, anchorOtId: otId } : null
          }
          return null
        })
        if (members.every(mem => mem !== null)) {
          const lcaId = findUniqueLCA(members.map(mem => mem.anchorOtId), allSubtypes)
          if (lcaId) {
            // LCA becomes the target OT; queries no longer contain an atom for it.
            applyQueries(lcaId, i => {
              const mem = members[i]
              if (mem.kind === 'subtype') {
                const subOtAtomId = uid(), stAtomId = uid()
                return {
                  atoms: [
                    { id: subOtAtomId, kind: 'objectType', originalId: mem.st.subId,
                      isOutput: false, dx: 16, dy: 16 },
                    { id: stAtomId, kind: 'subtype', originalId: mem.st.id,
                      isOutput: true, isSeeded: true, dx: 24, dy: 24 },
                  ],
                  links: [
                    { atomId: stAtomId, roleIndex: 0, variableId: subOtAtomId },
                  ],
                }
              } else {
                const factAtomId = uid()
                return {
                  atoms: [
                    { id: factAtomId, kind: 'fact', originalId: mem.m.factId,
                      isOutput: false, seededRoles: [{ roleIndex: mem.m.roleIndex, seqPosition: 0 }],
                      dx: 16, dy: 16 },
                  ],
                  links: [],
                }
              }
            })
          }
        }
      }

      if (['exclusion', 'equality', 'subset'].includes(c.constraintType)) {
        const sequences = c.sequences ?? []
        if (sequences.length === 0) return

        const existingQueries = [...(c.queries ?? [])]
        while (existingQueries.length < sequences.length) existingQueries.push(null)
        let changed = false

        const allSubtypes = get().subtypes

        for (let i = 0; i < sequences.length; i++) {
          if (existingQueries[i] != null) continue  // don't overwrite existing query

          const seq = sequences[i]

          // Rule 3 (exclusion only): single subtype edge → subtype copy + sub OT copy + super OT copy.
          // Neither OT copy is isOutput — the result is the sub-type's population, identified by
          // the subtype copy being isSeeded.
          if (c.constraintType === 'exclusion' && seq.length === 1 && seq[0].kind === 'subtype') {
            const st = allSubtypes.find(s => s.id === seq[0].subtypeId)
            if (st) {
              const subOtAtomId = uid(), supOtAtomId = uid(), stAtomId = uid()
              existingQueries[i] = {
                atoms: [
                  { id: subOtAtomId, kind: 'objectType', originalId: st.subId,
                    isOutput: false, dx: 16, dy: 16 },
                  { id: supOtAtomId, kind: 'objectType', originalId: st.superId,
                    isOutput: false, dx: 32, dy: 32 },
                  { id: stAtomId, kind: 'subtype', originalId: st.id,
                    isSeeded: true, dx: 24, dy: 24 },
                ],
                links: [
                  { atomId: stAtomId, roleIndex: 0, variableId: subOtAtomId },
                  { atomId: stAtomId, roleIndex: 1, variableId: supOtAtomId },
                ],
              }
              changed = true
              continue
            }
          }

          // Track each member's position within the original seq for seqPosition annotation
          const roleMembers = seq.reduce((acc, m, seqPos) => {
            if (m.kind === 'role' && !m.factId?.includes('_il_')) acc.push({ ...m, seqPos })
            return acc
          }, [])
          if (roleMembers.length === 0 || roleMembers.length !== seq.length) continue

          // Rule 0: all roles within the same fact type → fact atom with the sequence roles as output variables
          const factIds = new Set(roleMembers.map(m => m.factId))
          if (factIds.size === 1) {
            const factAtomId = uid()
            existingQueries[i] = {
              atoms: [{ id: factAtomId, kind: 'fact', originalId: [...factIds][0],
                isOutput: false, seededRoles: roleMembers.map(m => ({ roleIndex: m.roleIndex, seqPosition: m.seqPos })),
                dx: 16, dy: 16 }],
              links: [],
            }
            changed = true
            continue
          }

          // Rule 1: all roles in binary fact types; other-role OTs share a unique LCA
          let allBinary = true
          for (const m of roleMembers) {
            const f = facts.find(f => f.id === m.factId)
            if (!f || f.arity !== 2) { allBinary = false; break }
          }
          if (allBinary) {
            const otherOtIds = []
            let otValid = true
            for (const m of roleMembers) {
              const f = facts.find(f => f.id === m.factId)
              const otId = f.roles[1 - m.roleIndex]?.objectTypeId
              if (!otId) { otValid = false; break }
              otherOtIds.push(otId)
            }
            if (otValid) {
              const lcaId = findUniqueLCA(otherOtIds, allSubtypes)
              if (lcaId) {
                const paths = otherOtIds.map(otId => findPathDown(lcaId, otId, allSubtypes))
                if (paths.every(p => p !== null)) {
                  const rootAtomId = uid()
                  // exclusion / equality / subset never designate a target OT — root atom is a plain join variable.
                  const atoms = [{ id: rootAtomId, kind: 'objectType', originalId: lcaId,
                    isOutput: false, dx: 16, dy: 16 }]
                  const links = []
                  roleMembers.forEach((m, j) => {
                    let prevOtAtomId = rootAtomId
                    for (const step of paths[j]) {
                      const childOtAtomId = uid(), pathStAtomId = uid()
                      atoms.push({ id: childOtAtomId, kind: 'objectType', originalId: step.toId,
                        isOutput: false, dx: (j + 2) * 16, dy: (j + 2) * 16 })
                      atoms.push({ id: pathStAtomId, kind: 'subtype', originalId: step.subtypeId,
                        isOutput: false, dx: (j + 2) * 16, dy: (j + 2) * 16 })
                      links.push({ atomId: pathStAtomId, roleIndex: 1, variableId: prevOtAtomId })
                      links.push({ atomId: pathStAtomId, roleIndex: 0, variableId: childOtAtomId })
                      prevOtAtomId = childOtAtomId
                    }
                    const factAtomId = uid()
                    atoms.push({ id: factAtomId, kind: 'fact', originalId: m.factId,
                      isOutput: false, seededRoles: [{ roleIndex: m.roleIndex, seqPosition: m.seqPos }],
                      dx: (j + 3) * 16, dy: (j + 3) * 16 })
                    links.push({ atomId: factAtomId, roleIndex: 1 - m.roleIndex, variableId: prevOtAtomId })
                  })
                  existingQueries[i] = { atoms, links }
                  changed = true
                  continue
                }
              }
            }
          }
        }

        if (changed) {
          set(s => ({
            constraints: s.constraints.map(con =>
              con.id !== constraintId ? con : { ...con, queries: existingQueries }
            ),
            isDirty: true,
          }))
        }
      }
    },

    abandonSequenceConstruction() {
      const gc = get().sequenceConstruction
      // Open-ended sequence: commit whatever was collected rather than discarding
      if (gc?.openEnded && gc.collected.length > 0) {
        get()._commitSequenceConstruction(gc.constraintId, gc.collected)
      } else {
        set({ sequenceConstruction: null })
      }
    },

    commitSequenceConstruction() {
      const gc = get().sequenceConstruction
      if (!gc) return
      if (gc.collected.length > 0) {
        get()._commitSequenceConstruction(gc.constraintId, gc.collected)
      } else {
        set({ sequenceConstruction: null })
      }
    },

    setConstraintHighlight(h)  { set({ constraintHighlight: h }) },
    clearConstraintHighlight() { if (get().constraintHighlight !== null) set({ constraintHighlight: null }) },
    setQueryIndexHighlight(h)  { set({ queryIndexHighlight: h }) },
    clearQueryIndexHighlight() { if (get().queryIndexHighlight !== null) set({ queryIndexHighlight: null }) },

    startTargetPick(constraintId) { set({ pendingTargetPick: { constraintId } }) },
    cancelTargetPick() { set({ pendingTargetPick: null }) },
    commitTargetPick(objectTypeId) {
      const { pendingTargetPick, constraints } = get()
      if (!pendingTargetPick) return
      const { constraintId } = pendingTargetPick
      const c = constraints.find(c => c.id === constraintId)
      if (c) {
        set(s => ({
          constraints: s.constraints.map(con =>
            con.id === constraintId ? { ...con, targetObjectTypeId: objectTypeId } : con
          ),
          pendingTargetPick: null,
        }))
      } else {
        set({ pendingTargetPick: null })
      }
    },

    removeConstraintSequencePosition(constraintId, position) {
      set(s => {
        const newConstraints = s.constraints.map(c => {
          if (c.id !== constraintId) return c
          const sequences = (c.sequences || [])
            .map(g => g.filter((_, i) => i !== position))
            .filter(g => g.length > 0)
          return { ...c, sequences }
        })
        return {
          constraints: newConstraints,
          diagrams: syncConstraints(s.diagrams, newConstraints, s.subtypes, s.facts),
          isDirty: true,
        }
      })
    },

    removeConstraintSequence(constraintId, sequenceIndex) {
      set(s => {
        const newConstraints = s.constraints.map(c => {
          if (c.id !== constraintId) return c
          const sequences = (c.sequences || []).filter((_, i) => i !== sequenceIndex)
          const queries   = (c.queries   || []).filter((_, i) => i !== sequenceIndex)
          return { ...c, sequences, queries }
        })
        return {
          constraints: newConstraints,
          diagrams: syncConstraints(s.diagrams, newConstraints, s.subtypes, s.facts),
          isDirty: true,
        }
      })
    },

    swapConstraintSequences(constraintId) {
      set(s => ({
        constraints: s.constraints.map(c => {
          if (c.id !== constraintId) return c
          const sequences = c.sequences || []
          if (sequences.length < 2) return c
          const swapped = [sequences[1], sequences[0], ...sequences.slice(2)]
          const queries  = c.queries  || []
          const swappedQ = queries.length >= 2 ? [queries[1], queries[0], ...queries.slice(2)] : queries
          return { ...c, sequences: swapped, queries: swappedQ }
        }),
        isDirty: true,
      }))
    },

    // ── query editing ────────────────────────────────────────────────────────

    /** Returns { valid: bool, reason: string|null } for the current queryEditDraft. */
    getQueryEditValidation() {
      const qd = get().queryEditDraft
      if (!qd) return { valid: false, reason: null }
      const { atoms, links } = qd
      if (atoms.length === 0) return { valid: false, reason: 'Pattern is empty' }
      // Union-find on atoms — edges are links between fact/subtype atoms and OT atoms
      const parent = {}
      const find = id => { if (parent[id] === undefined) parent[id] = id; return parent[id] === id ? id : (parent[id] = find(parent[id])) }
      const union = (a, b) => { parent[find(a)] = find(b) }
      for (const lk of links) union(lk.atomId, lk.variableId)
      const roots = new Set(atoms.map(a => find(a.id)))
      if (roots.size > 1) return { valid: false, reason: 'Pattern is not connected' }
      return { valid: true, reason: null }
    },

    startQueryEdit(constraintId, sequenceIndex) {
      const c = get().constraints.find(c => c.id === constraintId)
      if (!c) return
      const existing = (c.queries || [])[sequenceIndex] || null
      // Re-edit an already-saved query (atoms is the current field; copies is the old name for backward compat)
      if (existing?.atoms || existing?.copies) {
        const atoms = existing.atoms ?? existing.copies ?? []
        const links = (existing.links ?? []).map(lk => lk.copyId !== undefined && lk.atomId === undefined ? { ...lk, atomId: lk.copyId } : lk)
        set({ queryEditDraft: { constraintId, sequenceIndex, atoms, links, pendingClick: null } })
        return
      }
      // Seed fresh graph from sequence members
      const seq = c.sequences[sequenceIndex] || []
      const facts   = get().facts
      const subtypes = get().subtypes
      const atoms = [], links = []
      const offsetCount = {}  // originalId → how many atoms created so far
      const nextOffset = (originalId) => {
        const n = offsetCount[originalId] ?? 0
        offsetCount[originalId] = n + 1
        return { dx: (n + 1) * 16, dy: (n + 1) * 16 }
      }

      const hasExplicitTarget = !!c.targetObjectTypeId
      // ring / valueComparison / exclusion / equality / subset have no output OT concept;
      // targetObjectTypeId may be set as a side-effect of auto-generation but should not be marked output
      const hasOutputOt = ['uniqueness', 'frequency', 'inclusiveOr', 'exclusiveOr'].includes(c.constraintType)

      // Target atom — created first so it is never shared with role variables
      if (hasExplicitTarget) {
        const targetAtomId = uid()
        atoms.push({ id: targetAtomId, kind: 'objectType', originalId: c.targetObjectTypeId, isOutput: hasOutputOt, ...nextOffset(c.targetObjectTypeId) })
      }

      // Each role gets its own fresh fact atom; OT atoms are added by the user later
      seq.forEach((m, seqPos) => {
        if (m.kind !== 'role') return
        const factAtomId = uid()
        atoms.push({ id: factAtomId, kind: 'fact', originalId: m.factId, isOutput: false, seededRoles: [{ roleIndex: m.roleIndex, seqPosition: seqPos }], ...nextOffset(m.factId) })
      })
      for (const m of seq) {
        if (m.kind !== 'subtype') continue
        const st = subtypes.find(s => s.id === m.subtypeId)
        if (!st) continue
        const stAtomId = uid()
        atoms.push({ id: stAtomId, kind: 'subtype', originalId: m.subtypeId, isOutput: !hasExplicitTarget, isSeeded: true, ...nextOffset(m.subtypeId) })
        const makeOtAtom = (otId) => {
          const cid = uid()
          atoms.push({ id: cid, kind: 'objectType', originalId: otId, isOutput: false, ...nextOffset(otId) })
          return cid
        }
        links.push({ atomId: stAtomId, roleIndex: 0, variableId: makeOtAtom(st.subId)   })
        links.push({ atomId: stAtomId, roleIndex: 1, variableId: makeOtAtom(st.superId) })
      }
      set({ queryEditDraft: { constraintId, sequenceIndex, atoms, links, pendingClick: null } })
    },

    queryEditClick(target) {
      // target: { type: 'otAtom'|'otOriginal'|'factAtomRole'|'factOriginalRole'|'subtypeAtom'|'subtypeOriginal', id, roleIndex? }
      const qd = get().queryEditDraft
      if (!qd) return
      const { pendingClick } = qd
      if (!pendingClick) {
        // First click must be on an atom, not an original
        if (target.type !== 'otAtom' && target.type !== 'factAtomRole' && target.type !== 'subtypeAtom') return
        set({ queryEditDraft: { ...qd, pendingClick: target } })
        return
      }
      // Same target clicked again → cancel pending
      if (pendingClick.type === target.type && pendingClick.id === target.id && pendingClick.roleIndex === target.roleIndex) {
        set({ queryEditDraft: { ...qd, pendingClick: null } })
        return
      }
      const isOtSide   = t => t.type === 'otAtom'   || t.type === 'otOriginal'
      const isRoleSide = t => t.type === 'factAtomRole' || t.type === 'factOriginalRole' || t.type === 'subtypeAtom' || t.type === 'subtypeOriginal'

      // Two OT-side clicks
      if (isOtSide(pendingClick) && isOtSide(target)) {

        // Resolve original IDs for both sides
        const ot1OrigId = pendingClick.type === 'otAtom'
          ? qd.atoms.find(a => a.id === pendingClick.id)?.originalId : pendingClick.id
        const ot2OrigId = target.type === 'otAtom'
          ? qd.atoms.find(a => a.id === target.id)?.originalId : target.id
        if (!ot1OrigId || !ot2OrigId) { set({ queryEditDraft: { ...qd, pendingClick: null } }); return }

        // Find a subtype edge connecting the two OTs (either direction)
        const allSubtypes = get().subtypes
        const st = allSubtypes.find(s =>
          (s.subId === ot1OrigId && s.superId === ot2OrigId) ||
          (s.subId === ot2OrigId && s.superId === ot1OrigId)
        )
        if (!st) { set({ queryEditDraft: { ...qd, pendingClick: null } }); return }

        const newAtoms2 = [...qd.atoms]
        const newLinks2  = [...qd.links]
        const offsetFor  = (origId) => {
          const n = newAtoms2.filter(a => a.originalId === origId).length
          return { dx: (n + 1) * 16, dy: (n + 1) * 16 }
        }

        // Resolve or create OT1 atom
        let ot1AtomId
        if (pendingClick.type === 'otAtom') { ot1AtomId = pendingClick.id }
        else { ot1AtomId = uid(); newAtoms2.push({ id: ot1AtomId, kind: 'objectType', originalId: ot1OrigId, isOutput: false, ...offsetFor(ot1OrigId) }) }

        // Resolve or create OT2 atom
        let ot2AtomId
        if (target.type === 'otAtom') { ot2AtomId = target.id }
        else { ot2AtomId = uid(); newAtoms2.push({ id: ot2AtomId, kind: 'objectType', originalId: ot2OrigId, isOutput: false, ...offsetFor(ot2OrigId) }) }

        // Create subtype atom linking them
        const stAtomId = uid()
        const stIsOutput = !get().constraints.find(c => c.id === qd.constraintId)?.targetObjectTypeId
        newAtoms2.push({ id: stAtomId, kind: 'subtype', originalId: st.id, isOutput: stIsOutput, isSeeded: false, ...offsetFor(st.id) })
        newLinks2.push({ atomId: stAtomId, roleIndex: 0, variableId: st.subId   === ot1OrigId ? ot1AtomId : ot2AtomId })
        newLinks2.push({ atomId: stAtomId, roleIndex: 1, variableId: st.superId === ot1OrigId ? ot1AtomId : ot2AtomId })

        set({ queryEditDraft: { ...qd, atoms: newAtoms2, links: newLinks2, pendingClick: null } })
        return
      }

      let otTarget, roleTarget
      if (isOtSide(pendingClick) && isRoleSide(target))       { otTarget = pendingClick; roleTarget = target }
      else if (isRoleSide(pendingClick) && isOtSide(target))  { roleTarget = pendingClick; otTarget = target }
      else { set({ queryEditDraft: { ...qd, pendingClick: null } }); return }

      const facts    = get().facts
      const subtypes = get().subtypes
      const newAtoms = [...qd.atoms]
      const newLinks  = [...qd.links]

      // Helper: initial dx/dy for a new atom based on how many of the same originalId already exist
      const newAtomOffset = (originalId) => {
        const n = newAtoms.filter(a => a.originalId === originalId).length
        return { dx: (n + 1) * 16, dy: (n + 1) * 16 }
      }

      // Resolve or create OT atom
      let otAtomId, otOriginalId
      if (otTarget.type === 'otAtom') {
        otAtomId = otTarget.id
        otOriginalId = newAtoms.find(a => a.id === otAtomId)?.originalId
      } else {
        otAtomId = uid(); otOriginalId = otTarget.id
        newAtoms.push({ id: otAtomId, kind: 'objectType', originalId: otOriginalId, isOutput: false, ...newAtomOffset(otOriginalId) })
      }
      if (!otOriginalId) { set({ queryEditDraft: { ...qd, pendingClick: null } }); return }

      // Resolve or create fact/subtype atom and determine roleIndex
      let roleAtomId, roleIndex
      if (roleTarget.type === 'factAtomRole') {
        roleAtomId = roleTarget.id; roleIndex = roleTarget.roleIndex
      } else if (roleTarget.type === 'factOriginalRole') {
        roleAtomId = uid(); roleIndex = roleTarget.roleIndex
        const isObjectified = facts.find(f => f.id === roleTarget.id)?.objectified
        newAtoms.push({ id: roleAtomId, kind: isObjectified ? 'objectType' : 'fact', originalId: roleTarget.id, isOutput: false, ...newAtomOffset(roleTarget.id) })
      } else {
        // Subtype: infer which end from OT type
        const stOriginalId = roleTarget.type === 'subtypeAtom'
          ? (qd.atoms.find(a => a.id === roleTarget.id)?.originalId)
          : roleTarget.id
        const st = subtypes.find(s => s.id === stOriginalId)
        if (!st) { set({ queryEditDraft: { ...qd, pendingClick: null } }); return }
        if      (otOriginalId === st.subId)   roleIndex = 0
        else if (otOriginalId === st.superId) roleIndex = 1
        else { set({ queryEditDraft: { ...qd, pendingClick: null } }); return }
        if (roleTarget.type === 'subtypeAtom') {
          roleAtomId = roleTarget.id
        } else {
          roleAtomId = uid()
          const stOut = !get().constraints.find(c => c.id === qd.constraintId)?.targetObjectTypeId
          newAtoms.push({ id: roleAtomId, kind: 'subtype', originalId: stOriginalId, isOutput: stOut, isSeeded: false, ...newAtomOffset(stOriginalId) })
        }
      }

      // Type-check for fact role slots
      if (roleTarget.type === 'factAtomRole' || roleTarget.type === 'factOriginalRole') {
        const factOrigId = newAtoms.find(a => a.id === roleAtomId)?.originalId
        let expectedOtId
        if (factOrigId?.includes('_il_')) {
          const [pFid, riStr] = factOrigId.split('_il_')
          const pFact = facts.find(f => f.id === pFid)
          expectedOtId = roleIndex === 0 ? pFid : pFact?.roles[Number(riStr)]?.objectTypeId
        } else {
          expectedOtId = facts.find(f => f.id === factOrigId)?.roles[roleIndex]?.objectTypeId
        }
        if (expectedOtId !== otOriginalId) { set({ queryEditDraft: { ...qd, pendingClick: null } }); return }
      }

      // If the role slot is already filled, drop the old connection before adding the new one
      const existingIdx = newLinks.findIndex(l => l.atomId === roleAtomId && l.roleIndex === roleIndex)
      if (existingIdx !== -1) newLinks.splice(existingIdx, 1)

      newLinks.push({ atomId: roleAtomId, roleIndex, variableId: otAtomId })

      set({ queryEditDraft: { ...qd, atoms: newAtoms, links: newLinks, pendingClick: null } })
    },

    commitQueryEdit() {
      const qd = get().queryEditDraft
      if (!qd) return
      set(s => ({
        queryEditDraft: null,
        constraints: s.constraints.map(c => {
          if (c.id !== qd.constraintId) return c
          const queries = [...(c.queries || [])]
          while (queries.length <= qd.sequenceIndex) queries.push(null)
          queries[qd.sequenceIndex] = { atoms: qd.atoms, links: qd.links }
          return { ...c, queries }
        }),
        isDirty: true,
      }))
    },

    cancelQueryEdit() {
      set({ queryEditDraft: null })
    },

    cancelQueryPendingClick() {
      const qd = get().queryEditDraft
      if (qd?.pendingClick) set({ queryEditDraft: { ...qd, pendingClick: null } })
    },

    updateQueryAtomOffset(atomId, dx, dy) {
      const qd = get().queryEditDraft
      if (!qd) return
      set(s => {
        const diagrams = s.diagrams.map(d => {
          if (d.id !== s.activeDiagramId) return d
          const qp = d.queryPositions ?? {}
          const forC = qp[qd.constraintId] ?? {}
          const forS = forC[qd.sequenceIndex] ?? {}
          return { ...d, queryPositions: { ...qp, [qd.constraintId]: { ...forC, [qd.sequenceIndex]: { ...forS, [atomId]: { dx, dy } } } } }
        })
        return {
          diagrams,
          isDirty: true,
        }
      })
    },

    resetQueryAtomPosition(atomId) {
      const qd = get().queryEditDraft
      if (!qd) return
      set(s => {
        const diagrams = s.diagrams.map(d => {
          if (d.id !== s.activeDiagramId) return d
          const qp = d.queryPositions ?? {}
          const forC = qp[qd.constraintId] ?? {}
          const forS = { ...(forC[qd.sequenceIndex] ?? {}) }
          delete forS[atomId]
          return { ...d, queryPositions: { ...qp, [qd.constraintId]: { ...forC, [qd.sequenceIndex]: forS } } }
        })
        return { diagrams, isDirty: true }
      })
    },

    mergeOtAtomInto(draggedId, targetId) {
      const qd = get().queryEditDraft
      if (!qd) return
      const dragged = qd.atoms.find(a => a.id === draggedId)
      const target  = qd.atoms.find(a => a.id === targetId)
      if (!dragged || !target || dragged.originalId !== target.originalId) return
      const survived = (dragged.isOutput || target.isOutput) ? { ...target, isOutput: true } : target
      const afterMergeAtoms = qd.atoms.filter(a => a.id !== draggedId).map(a => a.id === targetId ? survived : a)
      const afterMergeLinks = qd.links.map(l => l.variableId === draggedId ? { ...l, variableId: targetId } : l)
      const { atoms, links } = runFactMergePass(afterMergeAtoms, afterMergeLinks, get().facts)
      set({ queryEditDraft: { ...qd, atoms, links, pendingClick: null } })
    },

    splitOtAtom(atomId) {
      const qd = get().queryEditDraft
      if (!qd) return
      const at = qd.atoms.find(a => a.id === atomId)
      if (!at || at.kind !== 'objectType') return

      const allFacts = get().facts
      const isObjectifiedId = (id) => allFacts.some(f => f.id === id && f.objectified)
      const isFactSide = (a) => a.kind === 'fact' || (a.kind === 'objectType' && isObjectifiedId(a.originalId))

      // Only links where the role side is a fact/nested-OT atom
      const roleLinks = qd.links.filter(l =>
        l.variableId === atomId &&
        qd.atoms.some(a => a.id === l.atomId && isFactSide(a))
      )
      if (roleLinks.length < 2) return

      const n = roleLinks.length
      const baseDx = at.dx ?? 16, baseDy = at.dy ?? 16
      let newAtoms = [...qd.atoms]
      let newLinks  = [...qd.links]

      // Create one replacement OT atom per role link, spread in a circle
      roleLinks.forEach((lk, i) => {
        const newId = uid()
        const angle  = (2 * Math.PI * i) / n
        const radius = 30
        newAtoms.push({
          id: newId, kind: at.kind, originalId: at.originalId,
          isOutput: at.isOutput && i === 0,
          dx: baseDx + Math.round(Math.cos(angle) * radius),
          dy: baseDy + Math.round(Math.sin(angle) * radius),
        })
        const idx = newLinks.indexOf(lk)
        newLinks[idx] = { ...lk, variableId: newId }
      })

      // Remove the original atom and any remaining links to it (e.g. subtype links)
      newAtoms = newAtoms.filter(a => a.id !== atomId)
      newLinks  = newLinks.filter(l => l.variableId !== atomId && l.atomId !== atomId)

      // Drop orphaned subtype atoms (missing either endpoint)
      const orphaned = new Set(
        newAtoms.filter(a => {
          if (a.kind !== 'subtype') return false
          return !newLinks.some(l => l.atomId === a.id && l.roleIndex === 0) ||
                 !newLinks.some(l => l.atomId === a.id && l.roleIndex === 1)
        }).map(a => a.id)
      )
      newAtoms = newAtoms.filter(a => !orphaned.has(a.id))
      newLinks  = newLinks.filter(l => !orphaned.has(l.atomId) && !orphaned.has(l.variableId))

      set({ queryEditDraft: { ...qd, atoms: newAtoms, links: newLinks, pendingClick: null } })
    },

    splitFactAtom(atomId) {
      const qd = get().queryEditDraft
      if (!qd) return
      const at = qd.atoms.find(a => a.id === atomId)
      if (!at) return

      const allFacts = get().facts
      const isObjectifiedId = (id) => allFacts.some(f => f.id === id && f.objectified)

      // Applies to plain fact atoms and objectified-fact OT atoms
      if (at.kind !== 'fact' && !(at.kind === 'objectType' && isObjectifiedId(at.originalId))) return

      const fact = allFacts.find(f => f.id === at.originalId)
      const arity = fact?.arity ?? fact?.roles?.length ?? 0
      if (arity < 2) return

      const seededMap = new Map((at.seededRoles ?? []).map(s =>
        typeof s === 'number' ? [s, { roleIndex: s, seqPosition: null }] : [s.roleIndex, s]))
      const baseDx  = at.dx ?? 16, baseDy = at.dy ?? 16

      // Snapshot existing role connections before we filter links
      const roleConnections = {}
      for (let ri = 0; ri < arity; ri++) {
        const lk = qd.links.find(l => l.atomId === atomId && l.roleIndex === ri)
        if (lk) roleConnections[ri] = lk.variableId
      }

      // Remove all links associated with the original atom (role links and back-links)
      let newLinks  = qd.links.filter(l => l.atomId !== atomId && l.variableId !== atomId)
      let newAtoms = qd.atoms.filter(a => a.id !== atomId)

      // Create one replacement atom per role, spread in a circle
      for (let ri = 0; ri < arity; ri++) {
        const newId  = uid()
        const angle  = (2 * Math.PI * ri) / arity
        const radius = 30
        newAtoms.push({
          id: newId, kind: at.kind, originalId: at.originalId,
          isOutput: false,
          seededRoles: seededMap.has(ri) ? [seededMap.get(ri)] : [],
          dx: baseDx + Math.round(Math.cos(angle) * radius),
          dy: baseDy + Math.round(Math.sin(angle) * radius),
        })
        if (roleConnections[ri] !== undefined) {
          newLinks.push({ atomId: newId, roleIndex: ri, variableId: roleConnections[ri] })
        }
      }

      set({ queryEditDraft: { ...qd, atoms: newAtoms, links: newLinks, pendingClick: null } })
    },

    splitOutputRoles(atomId) {
      const qd = get().queryEditDraft
      if (!qd) return
      const at = qd.atoms.find(a => a.id === atomId)
      if (!at) return

      const allFacts = get().facts
      const isObjectifiedId = (id) => allFacts.some(f => f.id === id && f.objectified)
      if (at.kind !== 'fact' && !(at.kind === 'objectType' && isObjectifiedId(at.originalId))) return

      const seededRoles = at.seededRoles ?? []
      if (seededRoles.length <= 1) return

      const [firstRole, ...otherRoles] = seededRoles
      const baseDx = at.dx ?? 16, baseDy = at.dy ?? 16

      // Original atom keeps only the first output role; all its links are preserved
      let newAtoms = qd.atoms.map(a =>
        a.id === atomId ? { ...a, seededRoles: [firstRole] } : a
      )
      const newLinks = [...qd.links]

      // One fresh, unconnected atom per remaining output role
      otherRoles.forEach((ri, i) => {
        const angle  = (2 * Math.PI * (i + 1)) / (otherRoles.length + 1)
        const radius = 36
        newAtoms.push({
          id: uid(), kind: at.kind, originalId: at.originalId,
          isOutput: false,
          seededRoles: [ri],
          dx: baseDx + Math.round(Math.cos(angle) * radius),
          dy: baseDy + Math.round(Math.sin(angle) * radius),
        })
      })

      set({ queryEditDraft: { ...qd, atoms: newAtoms, links: newLinks, pendingClick: null } })
    },

    removeQueryAtom(atomId) {
      const qd = get().queryEditDraft
      if (!qd) return
      // Remove links touching this atom
      const remainingLinks = qd.links.filter(l => l.atomId !== atomId && l.variableId !== atomId)
      // Orphan any subtype atoms whose sub or super OT atom is now missing
      const orphaned = new Set(
        qd.atoms
          .filter(at => {
            if (at.kind !== 'subtype') return false
            const hasSubLink = remainingLinks.some(l => l.atomId === at.id && l.roleIndex === 0)
            const hasSupLink = remainingLinks.some(l => l.atomId === at.id && l.roleIndex === 1)
            return !hasSubLink || !hasSupLink
          })
          .map(at => at.id)
      )
      orphaned.add(atomId)
      const newAtoms = qd.atoms.filter(at => !orphaned.has(at.id))
      const newLinks = remainingLinks.filter(l => !orphaned.has(l.atomId) && !orphaned.has(l.variableId))
      set({ queryEditDraft: { ...qd, atoms: newAtoms, links: newLinks, pendingClick: null } })
    },

    clearConstraintQuery(constraintId, sequenceIndex) {
      set(s => ({
        constraints: s.constraints.map(c => {
          if (c.id !== constraintId) return c
          const queries = [...(c.queries || [])]
          if (sequenceIndex < queries.length) queries[sequenceIndex] = null
          return { ...c, queries }
        }),
        isDirty: true,
      }))
    },

    // ── constraints ─────────────────────────────────────────────────────────

    addConstraint(type, x, y) {
      const c = mkConstraint(type, Math.round(x), Math.round(y))
      set(s => {
        // BFS to collect all OT/fact IDs that must accompany the new constraint in the diagram,
        // plus implied links that need to be shown.
        const idsToAdd = new Set()
        const impliedLinksToShow = new Set()
        const visited  = new Set()
        const queue    = [c.id]

        // Seed visited with existing OT and fact IDs so we don't re-queue them
        for (const o of s.objectTypes) visited.add(o.id)
        for (const f of s.facts) visited.add(f.id)

        // Temporarily add the new constraint so BFS can find it
        const tempConstraints = [...s.constraints, c]

        while (queue.length > 0) {
          const id = queue.shift()
          if (visited.has(id)) continue
          visited.add(id)

          const con = tempConstraints.find(x => x.id === id)
          if (con) {
            // Queue all referenced facts, subtypes, and target OT
            if (con.roleSequences)
              for (const seq of con.roleSequences)
                for (const ref of seq)
                  if (ref.factId && !visited.has(ref.factId)) queue.push(ref.factId)
            if (con.sequences)
              for (const seq of con.sequences)
                for (const m of seq) {
                  if (m.kind === 'role' && m.factId && !visited.has(m.factId)) queue.push(m.factId)
                  if (m.kind === 'subtype' && m.subtypeId) {
                    const st = s.subtypes.find(x => x.id === m.subtypeId)
                    if (st) {
                      if (!visited.has(st.subId)) queue.push(st.subId)
                      if (!visited.has(st.superId)) queue.push(st.superId)
                    }
                  }
                }
            if (con.targetObjectTypeId && !visited.has(con.targetObjectTypeId))
              queue.push(con.targetObjectTypeId)
            continue
          }

          // Check if this is an implied link fact ID (e.g. "abc_il_0")
          if (typeof id === 'string' && id.includes('_il_')) {
            const parts = id.split('_il_')
            if (parts.length === 2) {
              const parentFactId = parts[0]
              const roleIndex = Number(parts[1])
              impliedLinksToShow.add(`${parentFactId}:${roleIndex}`)
              if (!visited.has(parentFactId)) queue.push(parentFactId)
              // Queue the associated object type
              const parentFact = s.facts.find(f => f.id === parentFactId)
              if (parentFact && parentFact.roles[roleIndex]?.objectTypeId) {
                const assocId = parentFact.roles[roleIndex].objectTypeId
                if (!visited.has(assocId)) queue.push(assocId)
              }
              continue
            }
          }

          // OT or fact
          const el = s.objectTypes.find(o => o.id === id) ?? s.facts.find(f => f.id === id)
          if (el) {
            idsToAdd.add(id)
            const fact = s.facts.find(f => f.id === id)
            if (fact)
              for (const r of fact.roles)
                if (r.objectTypeId && !visited.has(r.objectTypeId)) queue.push(r.objectTypeId)
          }
        }

        // Update diagrams: add the constraint and all its dependencies
        const updatedDiagrams = s.diagrams.map(d => {
          if (d.id !== s.activeDiagramId) return d

          let nd = addCOccIfAbsent(d, c.id, c.x, c.y)

          for (const id of idsToAdd) {
            const el = s.objectTypes.find(o => o.id === id) ?? s.facts.find(f => f.id === id)
            if (!el) continue
            nd = addOccIfAbsent(nd, id, el.x ?? 0, el.y ?? 0)
          }

          // Add implied links to shownImplicitLinks
          const shown = d.shownImplicitLinks || []
          const newShown = new Set(shown)
          for (const ilKey of impliedLinksToShow) newShown.add(ilKey)
          const shownChanged = newShown.size !== shown.length || [...newShown].some(k => !shown.includes(k))

          return {
            ...nd,
            shownImplicitLinks: shownChanged ? [...newShown] : shown,
          }
        })

        return {
          constraints: [...s.constraints, c],
          diagrams: syncConstraints(updatedDiagrams, tempConstraints, s.subtypes, s.facts),
          isDirty: true, selectedId: c.id, selectedKind: 'constraint',
        }
      })
      return c.id
    },

    updateConstraint(id, patch) {
      set(s => {
        const before = s.constraints.find(c => c.id === id)
        const newConstraints = s.constraints.map(c => c.id === id ? { ...c, ...patch } : c)
        // If this update promotes an external uniqueness constraint to preferred
        // identifier, demote every other PI (internal or external) for the same target.
        const promotesPI =
          before?.constraintType === 'uniqueness' &&
          'isPreferredIdentifier' in patch &&
          !!patch.isPreferredIdentifier &&
          !before.isPreferredIdentifier
        if (promotesPI) {
          const targetId = ('targetObjectTypeId' in patch ? patch.targetObjectTypeId : before.targetObjectTypeId)
          const { facts: cFacts, constraints: cCons } =
            demoteOtherPIsFor(targetId, s.facts, newConstraints, null, id)
          return {
            facts: cFacts,
            constraints: cCons,
            diagrams: syncConstraints(s.diagrams, cCons, s.subtypes, cFacts),
            isDirty: true,
          }
        }
        return {
          constraints: newConstraints,
          diagrams: syncConstraints(s.diagrams, newConstraints, s.subtypes, s.facts),
          isDirty: true,
        }
      })
    },

    moveConstraint(id, x, y) {
      set(s => ({
        diagrams: s.diagrams.map(d => d.id !== s.activeDiagramId ? d : patchCOcc(d, id, { x, y })),
        isDirty: true,
      }))
    },

    moveConstraintOccurrence(cOccId, x, y) {
      set(s => ({
        diagrams: s.diagrams.map(d => d.id !== s.activeDiagramId ? d : patchCOccById(d, cOccId, { x: Math.round(x), y: Math.round(y) })),
        isDirty: true,
      }))
    },

    addRoleToConstraintSequence(constraintId, sequenceIndex, factId, roleIndex) {
      if (factId.includes('_il_') && roleIndex !== 0) return
      set(s => {
        const newConstraints = s.constraints.map(c => {
          if (c.id !== constraintId) return c
          const roleSequences = c.roleSequences.map((g, gi) =>
            gi === sequenceIndex
              ? [...g.filter(r => !(r.factId === factId && r.roleIndex === roleIndex)),
                 { factId, roleIndex }]
              : g
          )
          return { ...c, roleSequences }
        })
        return {
          constraints: newConstraints,
          diagrams: syncConstraints(s.diagrams, newConstraints, s.subtypes, s.facts),
          isDirty: true,
        }
      })
    },

    deleteConstraint(id) {
      if (get().sequenceConstruction?.constraintId === id) return
      set(s => ({
        constraints: s.constraints.filter(c => c.id !== id),
        diagrams: s.diagrams.map(d => rmCOcc(d, id)),
        selectedId: s.selectedId === id ? null : s.selectedId,
        isDirty: true,
      }))
    },
  }
}
