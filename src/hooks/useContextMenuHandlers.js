import { useCallback } from 'react'
import { constraintMaxSequences, hasTargetObjectType, suppressRolePosition, isSingletonSequence } from '../utils/constraintRules'
import { findRefMode, refModeCollapseBlockers } from '../utils/refMode'
import { isDeonticUniqueness } from '../logic/modality'
import { makeContext } from '../logic/constraintFormulas.js'
import { whyNoOuterJoin } from '../logic/query.js'
import { placeOrmUnits, placeErdUnits } from '../layout/growPlacement.js'
import { layoutMappingDiagram } from '../layout/mappingLayout.js'
import { useOrmStore } from '../store/ormStore'
import { openDeleteFromSchema, canDeleteFromSchema, schemaDeletionIds } from '../utils/deleteSelection'

// Delete from Schema…: asks first (DeleteFromSchemaDialog.jsx); Delete on the
// keyboard only takes things off the diagram.
function deleteFromSchemaItem(store, ids, label = 'Delete from schema…') {
  const st = useOrmStore.getState()
  const del = schemaDeletionIds({ ...st, multiSelectedIds: ids, selectedId: null })
  return { label, danger: true, disabled: !canDeleteFromSchema(st, del),
    action: () => openDeleteFromSchema(del) }
}

// The checkable "Deontic" item that switches a constraint between alethic and
// deontic modality (modality.js).
const deonticItem = (checked, setDeontic, disabledTitle = null) => ({
  label: 'Deontic', checked: !!checked && !disabledTitle, disabled: !!disabledTitle,
  title: disabledTitle ?? 'An obligation: what ought to hold, which a population may break',
  action: () => setDeontic(!checked),
})

export function useContextMenuHandlers(store, setContextMenu, setVrPopup) {

  // Collapsing is refused while constraints link to the entity's own ref-fact role.
  const collapseItem = (entity, occurrenceId) => {
    const n = refModeCollapseBlockers(entity, store.facts, store.objectTypes, store.constraints).length
    return n > 0
      ? { label: `Collapse reference mode (blocked: ${n} constraint${n > 1 ? 's' : ''} on ${entity.name || entity.objectifiedName || 'its'}'s own role)`, disabled: true, action: () => {} }
      : { label: 'Collapse reference mode', action: () => store.collapseRefMode(occurrenceId) }
  }

  const handleMultiSelectionContextMenu = useCallback((e) => {
    e.preventDefault()
    e.stopPropagation()
    const canAlign = store.multiSelectedIds.length >= 2
    const idsToRemove = store.multiSelectedIds.filter(id =>
      store.objectTypes.some(o => o.id === id) || store.facts.some(f => f.id === id) || id.includes('_il_')
    )
    const occIdsToRemove = store.multiSelectedOccurrenceIds
    // Two object types (or objectified fact types) selected: Connect.
    const pair = [...new Set(store.multiSelectedIds)].filter(id => connectable(store, id))
    setContextMenu({
      x: e.clientX, y: e.clientY,
      items: [
        { label: 'Align horizontally', disabled: !canAlign,
          action: () => store.alignMultiSelection('y') },
        { label: 'Align vertically', disabled: !canAlign,
          action: () => store.alignMultiSelection('x') },
        '---',
        // On a mapping diagram the selected rule nodes can be split off.
        ...(store.diagrams.find(d => d.id === store.activeDiagramId)?.mappingId ? (() => {
          const ids = useOrmStore.getState().selectedRuleIds ?? []
          if (!ids.length) return []
          const n = ids.length === 1 ? 'Rule' : `${ids.length} Rules`
          const did = store.activeDiagramId
          return [
            { label: `Move ${n} to new diagram`, title: 'Elements still linked to rules that stay here are kept on both diagrams',
              action: () => useOrmStore.getState().rulesToNewDiagram(did, ids, { move: true, layout: layoutMappingDiagram }) },
            { label: `Copy ${n} to new diagram`,
              action: () => useOrmStore.getState().rulesToNewDiagram(did, ids, { layout: layoutMappingDiagram }) },
            '---',
          ]
        })() : [
          ...(pair.length === 2 ? [connectItem(store, pair[0], pair[1])] : []),
          { label: 'Copy selection to new diagram', action: () => store.selectionToNewDiagram(false) },
          { label: 'Move selection to new diagram', title: 'Object types still linked to what stays here are kept on both diagrams',
            action: () => store.selectionToNewDiagram(true) },
          '---',
        ]),
        { label: 'Remove selection from diagram', disabled: idsToRemove.length === 0 && occIdsToRemove.length === 0,
          action: () => {
            if (occIdsToRemove.length > 0) {
              for (const occId of occIdsToRemove) {
                store.removeOccurrenceFromDiagram(occId, store.activeDiagramId)
              }
            } else {
              store.removeMultiSelectionFromDiagram(store.activeDiagramId, idsToRemove)
            }
          } },
        deleteFromSchemaItem(store, store.multiSelectedIds, 'Delete selection from schema…'),
      ],
    })
  }, [store, setContextMenu])

  const handleOtContextMenu = useCallback((ot, e, occurrenceId = null) => {
    if (store.multiSelectedIds.length > 1 && store.multiSelectedIds.includes(ot.id)) {
      return handleMultiSelectionContextMenu(e)
    }
    e.preventDefault()
    e.stopPropagation()
    store.select(ot.id, ot.kind, occurrenceId)
    const diagram = store.diagrams.find(d => d.id === store.activeDiagramId)
    const rmInfo = ot.kind === 'entity' ? findRefMode(ot, store.facts, store.objectTypes) : null
    const diagramOccs = diagram?.occurrences ?? []
    const expandedOccsSet = new Set(diagram?.expandedRefModeOccs ?? [])
    // FT is "visible for B" if it is owned by B and B is expanded, or if it is independent.
    const ftVisible = !!(rmInfo && occurrenceId && diagramOccs.some(o => {
      if (o.schemaElementId !== rmInfo.factId) return false
      if (!o.refModeOwnerOccId) return true
      return o.refModeOwnerOccId === occurrenceId && expandedOccsSet.has(occurrenceId)
    }))
    // VT is visible by any means (independent or any owner expanded).
    const vtVisible = !!(rmInfo && occurrenceId && diagramOccs.some(o =>
      o.schemaElementId === rmInfo.vtId &&
      (!o.refModeOwnerOccId || expandedOccsSet.has(o.refModeOwnerOccId))
    ))
    const hasRefMode = ot.kind === 'entity' && !!rmInfo
    const isExpandedHere = occurrenceId
      ? (ftVisible && vtVisible)
      : (diagram?.expandedRefModes ?? []).includes(ot.id)
    const refExpansionItems = hasRefMode && occurrenceId
      ? ['---', isExpandedHere
          ? collapseItem(ot, occurrenceId)
          : { label: 'Expand reference mode',   action: () => store.expandRefMode(occurrenceId)   }]
      : []
    setContextMenu({
      x: e.clientX, y: e.clientY,
      items: [
        ...growItems(store, ot.id, occurrenceId),
        { label: ot.kind === 'entity' ? 'Change to value type' : 'Change to entity type',
          action: () => store.updateObjectType(ot.id, { kind: ot.kind === 'entity' ? 'value' : 'entity' }) },
        ...refExpansionItems,
        '---',
        { label: 'Remove from diagram',
          action: () => occurrenceId
            ? store.removeOccurrenceFromDiagram(occurrenceId, store.activeDiagramId)
            : store.removeElementFromDiagram(ot.id, store.activeDiagramId) },
        '---',
        deleteFromSchemaItem(store, [ot.id]),
      ],
    })
  }, [store, setContextMenu, handleMultiSelectionContextMenu])

  const handleRoleContextMenu = useCallback((fact, roleIndex, e) => {
    e.preventDefault()
    e.stopPropagation()
    const role = fact.roles[roleIndex]
    const hasUnary = fact.uniqueness.some(u => u.roles.length === 1 && u.roles[0] === roleIndex)
    const items = [
      { label: 'Is mandatory', checked: !!role.mandatory,
        action: () => store.updateRole(fact.id, roleIndex, { mandatory: !role.mandatory }) },
      { label: 'Has uniqueness constraint', checked: hasUnary,
        action: () => store.toggleUniqueness(fact.id, [roleIndex]) },
      '---',
      { label: 'Insert role before',
        action: () => { store.insertRole(fact.id, roleIndex); store.selectRole(fact.id, roleIndex + 1) } },
      { label: 'Insert role after',
        action: () => store.insertRole(fact.id, roleIndex + 1) },
      ...(fact.arity > 2 ? [
        { label: 'Move role to left',
          disabled: roleIndex === 0,
          action: () => { store.reorderRoles(fact.id, roleIndex, roleIndex - 1); store.selectRole(fact.id, roleIndex - 1) } },
        { label: 'Move role to right',
          disabled: roleIndex === fact.arity - 1,
          action: () => { store.reorderRoles(fact.id, roleIndex, roleIndex + 1); store.selectRole(fact.id, roleIndex + 1) } },
      ] : []),
    ]
    if (fact.objectified && role.objectTypeId) {
      const isShown = store.isImplicitLinkShown(fact.id, roleIndex)
      items.push('---', { label: 'Show link fact type',
        checked: isShown,
        action: () => store.toggleImplicitLink(fact.id, roleIndex) })
    }
    items.push('---',
      { label: 'Delete role',
        danger: true, disabled: fact.arity <= 1,
        action: () => { store.deleteRole(fact.id, roleIndex); store.clearSelection() } })
    setContextMenu({
      x: e.clientX, y: e.clientY,
      items,
    })
  }, [store, setContextMenu])

  const handleFactContextMenu = useCallback((fact, e, occurrenceId = null) => {
    if (store.multiSelectedIds.length > 1 && store.multiSelectedIds.includes(fact.id)) {
      return handleMultiSelectionContextMenu(e)
    }
    e.preventDefault()
    e.stopPropagation()
    store.select(fact.id, 'fact', occurrenceId)
    const hasRefMode = fact.objectified && fact.objectifiedKind !== 'value'
      && !!findRefMode(fact, store.facts, store.objectTypes)
    const diagram = store.diagrams.find(d => d.id === store.activeDiagramId)
    const isExpandedHere = occurrenceId
      ? (diagram?.expandedRefModeOccs ?? []).includes(occurrenceId)
      : (diagram?.expandedRefModes ?? []).includes(fact.id)
    const refExpansionItems = hasRefMode && occurrenceId
      ? [isExpandedHere
          ? collapseItem(fact, occurrenceId)
          : { label: 'Expand reference mode',   action: () => store.expandRefMode(occurrenceId)   },
         '---']
      : []
    setContextMenu({
      x: e.clientX, y: e.clientY,
      items: [
        ...(fact.objectified ? growItems(store, fact.id, occurrenceId) : []),
        ...(fact.arity > 1 ? [
          { label: 'Add spanning uniqueness constraint',
            disabled: (() => {
              const allRoles = Array.from({ length: fact.arity }, (_, i) => i)
              const key = JSON.stringify(allRoles)
              return (fact.uniqueness || []).some(u => JSON.stringify([...u.roles].sort()) === key)
            })(),
            action: () => {
              const allRoles = Array.from({ length: fact.arity }, (_, i) => i)
              store.toggleUniqueness(fact.id, allRoles)
            } },
          '---',
        ] : []),
        ...(fact.arity === 2 ? [
          { label: 'Reverse roles',
            action: () => store.reverseRoles(fact.id) },
        ] : []),
        { label: fact.orientation === 'vertical' ? 'Show horizontally' : 'Show vertically',
          action: () => store.updateFactLayout(fact.id, {
            orientation: fact.orientation === 'vertical' ? 'horizontal' : 'vertical',
          }) },
        '---',
        { label: 'Change into', submenu: [
            ...(!fact.objectified ? [
              { label: 'Objectified fact type',
                action: () => store.convertToNestedEntity(fact.id) },
            ] : [
              { label: 'Fact type',
                action: () => store.updateFact(fact.id, {
                  objectified: false, objectifiedName: undefined,
                  nestedReading: false, readingAbove: false, readingOffsetAbove: null, readingOffsetBelow: null,
                }) },
            ]),
          ],
        },
        '---',
        ...refExpansionItems,
        ...(fact.objectified ? (() => {
          const eligibleIls = (fact.implicitLinks || []).filter(il => fact.roles[il.roleIndex]?.objectTypeId)
          const shownCount  = eligibleIls.filter(il => store.isImplicitLinkShown(fact.id, il.roleIndex)).length
          const total       = eligibleIls.length
          return [
            { label: 'Link fact types', submenu: [
              { label: 'Show all',
                disabled: shownCount === total,
                action: () => store.setAllImplicitLinksShown(fact.id, true) },
              { label: 'Hide all',
                disabled: shownCount === 0,
                action: () => store.setAllImplicitLinksShown(fact.id, false) },
            ]},
          ]
        })() : []),
        '---',
        { label: 'Remove from diagram',
          action: () => occurrenceId
            ? store.removeOccurrenceFromDiagram(occurrenceId, store.activeDiagramId)
            : store.removeElementFromDiagram(fact.id, store.activeDiagramId) },
        '---',
        deleteFromSchemaItem(store, [fact.id]),
      ],
    })
  }, [store, setContextMenu, handleMultiSelectionContextMenu])

  const handleIfContextMenu = useCallback((fact, ifId, e) => {
    e.preventDefault()
    e.stopPropagation()
    setContextMenu({
      x: e.clientX, y: e.clientY,
      items: [
        { label: 'Edit frequency range…', action: () => store.startFrequencyRangeEdit(fact.id, ifId) },
        deonticItem((fact.internalFrequency || []).find(f => f.id === ifId)?.deontic,
          v => store.updateInternalFrequency(fact.id, ifId, { deontic: v })),
        '---',
        { label: 'Change into internal uniqueness constraint',
          action: () => store.convertFrequencyToUniqueness(fact.id, ifId),
        },
        '---',
        { label: 'Delete frequency constraint', danger: true,
          action: () => store.removeInternalFrequency(fact.id, ifId) },
      ],
    })
  }, [store, setContextMenu])

  const handleRoleValueContextMenu = useCallback((fact, roleIndex, e) => {
    e.preventDefault()
    e.stopPropagation()
    setContextMenu({
      x: e.clientX, y: e.clientY,
      items: [
        { label: 'Edit value range…', action: () => {
            store.setTool('select')
            setVrPopup({ factId: fact.id, roleIndex, x: e.clientX, y: e.clientY })
          }},
        deonticItem(fact.roles[roleIndex]?.valueRangeDeontic, v => store.updateRole(fact.id, roleIndex, { valueRangeDeontic: v })),
        '---',
        { label: 'Delete value range', danger: true,
          action: () => store.updateRole(fact.id, roleIndex, { valueRange: [], valueRangeDeontic: false }) },
      ],
    })
  }, [store, setContextMenu, setVrPopup])

  const handleRoleCrContextMenu = useCallback((fact, roleIndex, e) => {
    e.preventDefault()
    e.stopPropagation()
    setContextMenu({
      x: e.clientX, y: e.clientY,
      items: [
        { label: 'Edit cardinality range…', action: () => {
            store.setTool('select')
            setVrPopup({ factId: fact.id, roleIndex, x: e.clientX, y: e.clientY,
                         naturalNumbers: true, title: `Cardinality range — Role ${roleIndex + 1}` })
          }},
        deonticItem(fact.roles[roleIndex]?.cardinalityRangeDeontic, v => store.updateRole(fact.id, roleIndex, { cardinalityRangeDeontic: v })),
        '---',
        { label: 'Delete cardinality range', danger: true,
          action: () => store.updateRole(fact.id, roleIndex, { cardinalityRange: [], cardinalityRangeDeontic: false }) },
      ],
    })
  }, [store, setContextMenu, setVrPopup])

  const handleNestedVrContextMenu = useCallback((fact, e) => {
    e.preventDefault()
    e.stopPropagation()
    setContextMenu({
      x: e.clientX, y: e.clientY,
      items: [
        { label: 'Edit value range…', action: () => {
            store.setTool('select')
            setVrPopup({ nestedFactId: fact.id, x: e.clientX, y: e.clientY })
          }},
        deonticItem(fact?.valueRangeDeontic, v => store.updateFact(fact.id, { valueRangeDeontic: v })),
        '---',
        { label: 'Delete value range', danger: true,
          action: () => store.updateFact(fact.id, { valueRange: null, valueRangeDeontic: false }) },
      ],
    })
  }, [store, setContextMenu, setVrPopup])

  const handleNestedCrContextMenu = useCallback((fact, e) => {
    e.preventDefault()
    e.stopPropagation()
    setContextMenu({
      x: e.clientX, y: e.clientY,
      items: [
        { label: 'Edit cardinality range…', action: () => {
            store.setTool('select')
            setVrPopup({ nestedFactId: fact.id, x: e.clientX, y: e.clientY,
                         naturalNumbers: true, title: `Cardinality range — ${fact.objectifiedName || 'objectified fact type'}` })
          }},
        deonticItem(fact?.cardinalityRangeDeontic, v => store.updateFact(fact.id, { cardinalityRangeDeontic: v })),
        '---',
        { label: 'Delete cardinality range', danger: true,
          action: () => store.updateFact(fact.id, { cardinalityRange: null, cardinalityRangeDeontic: false }) },
      ],
    })
  }, [store, setContextMenu, setVrPopup])

  const handleOtValueRangeContextMenu = useCallback((ot, e) => {
    e.preventDefault()
    e.stopPropagation()
    setContextMenu({
      x: e.clientX, y: e.clientY,
      items: [
        { label: 'Edit value range…', action: () => {
            store.setTool('select')
            setVrPopup({ otId: ot.id, x: e.clientX, y: e.clientY })
          }},
        deonticItem(ot?.valueRangeDeontic, v => store.updateObjectType(ot.id, { valueRangeDeontic: v })),
        '---',
        { label: 'Delete value range', danger: true,
          action: () => store.updateObjectType(ot.id, { valueRange: [], valueRangeDeontic: false }) },
      ],
    })
  }, [store, setContextMenu, setVrPopup])

  const handleOtCardinalityRangeContextMenu = useCallback((ot, e) => {
    e.preventDefault()
    e.stopPropagation()
    setContextMenu({
      x: e.clientX, y: e.clientY,
      items: [
        { label: 'Edit cardinality range…', action: () => {
            store.setTool('select')
            setVrPopup({ otId: ot.id, x: e.clientX, y: e.clientY,
                         naturalNumbers: true, title: `Cardinality range — ${ot.name || 'Object type'}` })
          }},
        deonticItem(ot?.cardinalityRangeDeontic, v => store.updateObjectType(ot.id, { cardinalityRangeDeontic: v })),
        '---',
        { label: 'Delete cardinality range', danger: true,
          action: () => store.updateObjectType(ot.id, { cardinalityRange: [], cardinalityRangeDeontic: false }) },
      ],
    })
  }, [store, setContextMenu, setVrPopup])

  const handleMandatoryDotContextMenu = useCallback((factId, roleIndex, e) => {
    e.preventDefault()
    e.stopPropagation()
    setContextMenu({
      x: e.clientX, y: e.clientY,
      items: [
        deonticItem(store.facts.find(f => f.id === factId)?.roles[roleIndex]?.mandatoryDeontic,
          v => store.updateRole(factId, roleIndex, { mandatoryDeontic: v })),
        '---',
        { label: 'Delete mandatory constraint', danger: true,
          action: () => store.removeMandatoryRole(factId, roleIndex) },
      ],
    })
  }, [store, setContextMenu])

  const identifiesObjectified = (fact, roles) => Array.isArray(fact.objectifiedIdentifier)
    && JSON.stringify([...fact.objectifiedIdentifier].sort((a, b) => a - b)) === JSON.stringify([...roles].sort((a, b) => a - b))
  const handleUniquenessBarContextMenu = useCallback((fact, ui, e) => {
    e.preventDefault()
    e.stopPropagation()
    const uRoles = fact.uniqueness[ui]?.roles
    if (!uRoles) return
    const uKey = JSON.stringify([...uRoles].sort((a, b) => a - b))
    const isPreferred = (fact.preferredUniqueness || []).some(pu =>
      JSON.stringify([...pu].sort((a, b) => a - b)) === uKey
    )
    const canBePreferred = uRoles.length === fact.arity - 1
    // The PI identifies the uncovered role's player. Disallow if that player
    // would be a value type — value types are self-identifying via datatype.
    let identifiesVt = false
    if (canBePreferred) {
      const covered = new Set(uRoles)
      const uncoveredRi = fact.roles.findIndex((_, ri) => !covered.has(ri))
      const uncoveredOtId = uncoveredRi >= 0 ? fact.roles[uncoveredRi]?.objectTypeId : null
      const uncoveredOt = uncoveredOtId ? store.objectTypes.find(o => o.id === uncoveredOtId) : null
      if (uncoveredOt?.kind === 'value') identifiesVt = true
    }
    const piDisabled = !canBePreferred || identifiesVt
    const piTitle = identifiesVt ? 'A value type cannot have a preferred identifier' : undefined
    setContextMenu({
      x: e.clientX, y: e.clientY,
      items: [
        { label: 'Is preferred', checked: isPreferred, disabled: piDisabled, title: piTitle,
          action: () => store.setPreferredUniqueness(fact.id, uRoles) },
        ...(fact.objectified ? [{ label: `Identifies ${fact.objectifiedName || 'the objectified fact type'}`,
          checked: identifiesObjectified(fact, uRoles),
          action: () => store.setObjectifiedIdentifier(fact.id, uRoles) }] : []),
        deonticItem(isDeonticUniqueness(fact, uRoles), v => store.setUniquenessDeontic(fact.id, uRoles, v),
          isPreferred || identifiesObjectified(fact, uRoles) ? 'A preferred identifier is always alethic' : null),
        '---',
        { label: 'Change into internal frequency constraint',
          action: () => store.convertUniquenessToFrequency(fact.id, uRoles),
        },
        '---',
        { label: 'Delete uniqueness constraint', danger: true,
          action: () => store.toggleUniqueness(fact.id, uRoles) },
      ],
    })
  }, [store, setContextMenu])

  const handleImplicitLinkBarContextMenu = useCallback((parentFact, il, ui, e) => {
    e.preventDefault()
    e.stopPropagation()
    const hasSoloBase = (parentFact.uniqueness || []).some(u => u.roles.length === 1 && u.roles[0] === il.roleIndex)
    const propagated = hasSoloBase ? [[0], [1]] : [[0]]
    const uRoles = propagated[ui]
    if (!uRoles) return
    const sortedKey = JSON.stringify([...uRoles].sort())
    const prefArr = il.preferredUniqueness || []
    const isPreferred = prefArr.some(pu => JSON.stringify([...pu].sort()) === sortedKey)
    // PI on uRoles=[0] identifies the implicit link's role player (the parent
    // fact's role at il.roleIndex). Disallow if that player is a value type.
    let identifiesVt = false
    if (uRoles.length === 1 && uRoles[0] === 0) {
      const playerOtId = parentFact.roles?.[il.roleIndex]?.objectTypeId
      const playerOt   = playerOtId ? store.objectTypes.find(o => o.id === playerOtId) : null
      if (playerOt?.kind === 'value') identifiesVt = true
    }
    const piTitle = identifiesVt ? 'A value type cannot have a preferred identifier' : undefined
    setContextMenu({
      x: e.clientX, y: e.clientY,
      items: [
        { label: 'Is preferred', checked: isPreferred, disabled: identifiesVt, title: piTitle,
          action: () => {
            const next = isPreferred
              ? prefArr.filter(pu => JSON.stringify([...pu].sort()) !== sortedKey)
              : [...prefArr, [...uRoles]]
            store.updateImplicitLink(parentFact.id, il.roleIndex, { preferredUniqueness: next })
          },
        },
      ],
    })
  }, [store, setContextMenu])

  const handleSubtypeContextMenu = useCallback((st, e) => {
    if (store.multiSelectedIds.length > 1 && store.multiSelectedIds.includes(st.id)) {
      return handleMultiSelectionContextMenu(e)
    }
    e.preventDefault()
    e.stopPropagation()
    store.select(st.id, 'subtype')
    const diagramId = store.activeDiagramId
    const activeDiag = store.diagrams?.find(d => d.id === diagramId)
    const rawEps = activeDiag?.subtypeEndpointOccs?.[st.id]
    const epsArr = Array.isArray(rawEps) ? rawEps : (rawEps ? [rawEps] : [])
    const canRemoveOccurrence = st.subOccId != null && st.superOccId != null && epsArr.length > 1
    const items = [
      {
        label: 'Inherits preferred identifier',
        checked: st.inheritsPreferredIdentifier !== false,
        action: () => store.updateSubtype(st.id, { inheritsPreferredIdentifier: st.inheritsPreferredIdentifier === false }),
      },
      '---',
    ]
    if (canRemoveOccurrence) {
      items.push({ label: 'Remove this occurrence from diagram',
        action: () => store.removeSubtypeOccurrenceFromDiagram(st.id, st.subOccId, st.superOccId, diagramId) })
    }
    items.push({ label: 'Remove all occurrences from diagram',
      action: () => store.removeElementFromDiagram(st.id, diagramId) })
    items.push('---', deleteFromSchemaItem(store, [st.id]))
    setContextMenu({ x: e.clientX, y: e.clientY, items })
  }, [store, setContextMenu, handleMultiSelectionContextMenu])

  const handleConstraintContextMenu = useCallback((c, e, constraintOccurrenceId = null) => {
    if (store.multiSelectedIds.length > 1 && store.multiSelectedIds.includes(c.id)) {
      return handleMultiSelectionContextMenu(e)
    }
    e.preventDefault()
    e.stopPropagation()
    store.select(c.id, 'constraint', constraintOccurrenceId)
    const maxSequences  = constraintMaxSequences(c.constraintType)
    const hasTargetOt   = hasTargetObjectType(c.constraintType)
    const noRolePos     = suppressRolePosition(c.constraintType)
    const sequences = c.sequences || []
    const items = []

    // "Set Target Object Type" for applicable constraint types
    if (hasTargetOt) {
      items.push({
        label: 'Set target object type…',
        action: () => store.startTargetPick(c.id),
      })

      items.push('---')
    }
    if (c.sequences != null) {
      items.push({ label: 'Add role sequence',
        disabled: sequences.length >= maxSequences,
        action: () => store.startSequenceConstruction(c.id, 'newSequence') })

      if (sequences.length > 0 && !noRolePos) {
        items.push({ label: 'Add role position',
          action: () => store.startSequenceConstruction(c.id, 'extend') })
      }
      items.push('---')
      if (c.constraintType === 'frequency') {
        items.push({ label: 'Edit frequency range…',
          action: () => store.startExternalFrequencyEdit(c.id) })
        items.push({ label: 'Change into external uniqueness constraint',
          action: () => store.updateConstraint(c.id, { constraintType: 'uniqueness', isPreferredIdentifier: false }) })
        items.push('---')
      } else if (c.constraintType === 'uniqueness') {
        // External UC's target is the identified element. Disallow PI if the
        // target is a value type — value types are self-identifying.
        const targetOt = c.targetObjectTypeId
          ? store.objectTypes.find(o => o.id === c.targetObjectTypeId) : null
        const identifiesVt = targetOt?.kind === 'value'
        items.push({
          label: 'Is preferred identifier',
          checked: !!c.isPreferredIdentifier,
          disabled: identifiesVt,
          title: identifiesVt ? 'A value type cannot have a preferred identifier' : undefined,
          action: () => store.updateConstraint(c.id, c.isPreferredIdentifier
            ? { isPreferredIdentifier: false } : { isPreferredIdentifier: true, deontic: false }),
        })
        items.push({ label: 'Change into external frequency constraint',
          action: () => store.updateConstraint(c.id, { constraintType: 'frequency', frequency: [{ type: 'upper', upper: 1 }] }) })
        items.push('---')
      } else if (c.constraintType === 'equality' || c.constraintType === 'subset') {
        const other = c.constraintType === 'equality' ? 'subset' : 'equality'
        const otherLabel = c.constraintType === 'equality' ? 'subset' : 'equality'
        items.push({ label: `Change into ${otherLabel} constraint`,
          action: () => store.updateConstraint(c.id, { constraintType: other }) })
        if (c.constraintType === 'subset') {
          items.push({ label: 'Reverse direction',
            disabled: sequences.length < 2,
            action: () => store.swapConstraintSequences(c.id) })
        }
        items.push('---')
      } else if (c.constraintType !== 'frequency' && c.constraintType !== 'valueComparison' && c.constraintType !== 'ring') {
        const CHANGE_LABELS = {
          exclusiveOr: 'Exclusive or',
          exclusion:   'Exclusion',
          inclusiveOr: 'Inclusive or',
        }
        const others = ['exclusiveOr', 'exclusion', 'inclusiveOr']
          .filter(t => t !== c.constraintType)
        items.push({ label: 'Change into', submenu: others.map(t => ({
          label: CHANGE_LABELS[t],
          action: () => {
            const patch = { constraintType: t }
            if (isSingletonSequence(t) && c.sequences && c.sequences.some(g => g.length > 1)) {
              patch.sequences = c.sequences.map(g => g.slice(0, 1))
            }
            store.updateConstraint(c.id, patch)
          },
        })) })
        items.push('---')
      }
    }
    if (items.length && items[items.length - 1] === '---') items.pop()
    items.push(deonticItem(c.deontic, v => store.updateConstraint(c.id, { deontic: v }),
      c.isPreferredIdentifier ? 'A preferred identifier is always alethic' : null))
    if (c.constraintType === 'uniqueness') {
      const why = c.outerJoin ? null : whyNoOuterJoin(c, makeContext(store), { offerOnly: true })
      items.push({ label: 'Outer join', checked: !!c.outerJoin, disabled: !!why,
        title: why ? `Not available: ${why}` : 'No value in an optional part counts as a value (drawn as an o through the bar)',
        action: () => store.updateConstraint(c.id, { outerJoin: !c.outerJoin || undefined }) })
    }
    items.push('---')
    items.push({ label: 'Remove from diagram',
      action: () => constraintOccurrenceId
        ? store.removeConstraintOccurrenceFromDiagram(constraintOccurrenceId, store.activeDiagramId)
        : store.removeElementFromDiagram(c.id, store.activeDiagramId) })
    items.push('---')
    items.push(deleteFromSchemaItem(store, [c.id]))
    setContextMenu({ x: e.clientX, y: e.clientY, items })
  }, [store, setContextMenu, handleMultiSelectionContextMenu])

  const handleImplicitLinkContextMenu = useCallback((factId, roleIndex, e) => {
    const synthId = `${factId}_il_${roleIndex}`
    if (store.multiSelectedIds.length > 1 && store.multiSelectedIds.includes(synthId)) {
      return handleMultiSelectionContextMenu(e)
    }
    e.preventDefault()
    e.stopPropagation()
    store.selectImplicitLink(factId, roleIndex)
    const il = store.facts.find(f => f.id === factId)?.implicitLinks?.find(l => l.roleIndex === roleIndex)
    const ilKey = `${factId}:il:${roleIndex}`
    const activeDiag = store.diagrams.find(d => d.id === store.activeDiagramId)
    const ilPos = activeDiag?.implicitLinkPositions?.[ilKey] ?? {}
    const isVertical = (ilPos.orientation ?? il?.orientation) === 'vertical'
    setContextMenu({
      x: e.clientX, y: e.clientY,
      items: [
        { label: isVertical ? 'Show horizontally' : 'Show vertically',
          action: () => store.updateImplicitLink(factId, roleIndex, {
            orientation: isVertical ? 'horizontal' : 'vertical'
          }) },
        { label: 'Reverse roles',
          action: () => store.reverseImplicitLinkRoles(factId, roleIndex) },
        '---',
        { label: 'Remove from diagram',
          action: () => store.toggleImplicitLink(factId, roleIndex) },
      ],
    })
  }, [store, setContextMenu, handleMultiSelectionContextMenu])

  return {
    handleMultiSelectionContextMenu,
    handleImplicitLinkContextMenu,
    handleOtContextMenu,
    handleRoleContextMenu,
    handleFactContextMenu,
    handleIfContextMenu,
    handleRoleValueContextMenu,
    handleRoleCrContextMenu,
    handleNestedVrContextMenu,
    handleNestedCrContextMenu,
    handleOtValueRangeContextMenu,
    handleOtCardinalityRangeContextMenu,
    handleMandatoryDotContextMenu,
    handleUniquenessBarContextMenu,
    handleImplicitLinkBarContextMenu,
    handleSubtypeContextMenu,
    handleConstraintContextMenu,
  }
}

// Growing a diagram by hand from an element (NeighbourPicker.jsx): not on
// mapping diagrams, which show what their rules name.
// Connect with is offered for the element selected before this one (the menu
// selects the element it is opened on).
export function growItems(store, elementId, occurrenceId = null) {
  const diagram = store.diagrams.find(d => d.id === store.activeDiagramId)
  if (!diagram || diagram.mappingId) return []
  const shown = new Set((diagram.occurrences ?? []).map(o => o.schemaElementId))
  const now = useOrmStore.getState()
  const sel = now.selectedId === elementId ? [now.previousSelectedId] : [now.selectedId]
  const partners = [...new Set(sel.filter(id => id && id !== elementId && shown.has(id) && connectable(store, id)))]
  return [
    { label: 'Add neighbours…', action: () => store.openNeighbourPicker(elementId, occurrenceId) },
    { label: 'New diagram from here', action: () => store.newDiagramFrom(elementId) },
    ...(partners.length === 1 ? [connectItem(store, partners[0], elementId, `Connect with ${elementName(store, partners[0])}`)] : []),
    '---',
  ]
}

// An entity type (a table) or objectified fact type: what Connect joins.
const connectable = (store, id) => store.objectTypes.some(o => o.id === id && o.kind === 'entity') || store.facts.some(f => f.id === id && f.objectified)

const elementName = (store, id) => store.objectTypes.find(o => o.id === id)?.name
  || store.facts.find(f => f.id === id)?.objectifiedName || store.facts.find(f => f.id === id)?.name || '?'

// Connect: the shortest chain of fact types or foreign keys from one shown
// element to another (connectPath), added as one undo step.
export function connectItem(store, fromId, toId, label = 'Connect these two') {
  return {
    label, title: 'Add the shortest chain of fact types (foreign keys) between them',
    action: () => store.connectElements(store.activeDiagramId, fromId, toId, { place: { orm: placeOrmUnits, erd: placeErdUnits } }),
  }
}
