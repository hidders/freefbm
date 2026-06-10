import { useCallback } from 'react'
import { constraintMaxSequences, hasTargetObjectType, suppressRolePosition, isSingletonSequence } from '../utils/constraintRules'
import { findRefMode } from '../utils/refMode'

export function useContextMenuHandlers(store, setContextMenu, setVrPopup) {

  const handleMultiSelectionContextMenu = useCallback((e) => {
    e.preventDefault()
    e.stopPropagation()
    const canAlign = store.multiSelectedIds.length >= 2
    const idsToRemove = store.multiSelectedIds.filter(id =>
      store.objectTypes.some(o => o.id === id) || store.facts.some(f => f.id === id) || id.includes('_il_')
    )
    setContextMenu({
      x: e.clientX, y: e.clientY,
      items: [
        { label: 'Align horizontally', disabled: !canAlign,
          action: () => store.alignMultiSelection('y') },
        { label: 'Align vertically', disabled: !canAlign,
          action: () => store.alignMultiSelection('x') },
        '---',
        { label: 'Remove from Diagram', disabled: idsToRemove.length === 0,
          action: () => store.removeMultiSelectionFromDiagram(store.activeDiagramId, idsToRemove) },
        { label: 'Delete Selection', danger: true,
          action: () => store.deleteMultiSelection() },
      ],
    })
  }, [store, setContextMenu])

  const handleOtContextMenu = useCallback((ot, e) => {
    if (store.multiSelectedIds.length > 1 && store.multiSelectedIds.includes(ot.id)) {
      return handleMultiSelectionContextMenu(e)
    }
    e.preventDefault()
    e.stopPropagation()
    store.select(ot.id, ot.kind)
    const hasRefMode = ot.kind === 'entity' && !!findRefMode(ot, store.facts, store.objectTypes)
    const diagram = store.diagrams.find(d => d.id === store.activeDiagramId)
    const isExpandedHere = (diagram?.expandedRefModes ?? []).includes(ot.id)
    const refExpansionItems = hasRefMode
      ? ['---', isExpandedHere
          ? { label: 'Collapse Reference Mode', action: () => store.collapseRefMode(ot.id) }
          : { label: 'Expand Reference Mode',   action: () => store.expandRefMode(ot.id)   }]
      : []
    setContextMenu({
      x: e.clientX, y: e.clientY,
      items: [
        { label: ot.kind === 'entity' ? 'Change to Value Type' : 'Change to Entity Type',
          action: () => store.updateObjectType(ot.id, { kind: ot.kind === 'entity' ? 'value' : 'entity' }) },
        ...refExpansionItems,
        '---',
        { label: 'Remove from Diagram',
          action: () => store.removeElementFromDiagram(ot.id, store.activeDiagramId) },
        '---',
        { label: `Delete ${ot.kind === 'entity' ? 'Entity' : 'Value'} Type`,
          danger: true, action: () => store.deleteObjectType(ot.id) },
      ],
    })
  }, [store, setContextMenu, handleMultiSelectionContextMenu])

  const handleRoleContextMenu = useCallback((fact, roleIndex, e) => {
    e.preventDefault()
    e.stopPropagation()
    const role = fact.roles[roleIndex]
    const hasUnary = fact.uniqueness.some(u => u.length === 1 && u[0] === roleIndex)
    const items = [
      { label: 'is Mandatory', checked: !!role.mandatory,
        action: () => store.updateRole(fact.id, roleIndex, { mandatory: !role.mandatory }) },
      { label: 'has Uniqueness Constraint', checked: hasUnary,
        action: () => store.toggleUniqueness(fact.id, [roleIndex]) },
      '---',
      { label: 'Insert Role Before',
        action: () => { store.insertRole(fact.id, roleIndex); store.selectRole(fact.id, roleIndex + 1) } },
      { label: 'Insert Role After',
        action: () => store.insertRole(fact.id, roleIndex + 1) },
      ...(fact.arity > 2 ? [
        { label: 'Move Role to Left',
          disabled: roleIndex === 0,
          action: () => { store.reorderRoles(fact.id, roleIndex, roleIndex - 1); store.selectRole(fact.id, roleIndex - 1) } },
        { label: 'Move Role to Right',
          disabled: roleIndex === fact.arity - 1,
          action: () => { store.reorderRoles(fact.id, roleIndex, roleIndex + 1); store.selectRole(fact.id, roleIndex + 1) } },
      ] : []),
    ]
    if (fact.objectified && role.objectTypeId) {
      const isShown = store.isImplicitLinkShown(fact.id, roleIndex)
      items.push('---', { label: 'show Link Fact Type',
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

  const handleFactContextMenu = useCallback((fact, e) => {
    if (store.multiSelectedIds.length > 1 && store.multiSelectedIds.includes(fact.id)) {
      return handleMultiSelectionContextMenu(e)
    }
    e.preventDefault()
    e.stopPropagation()
    store.select(fact.id, 'fact')
    const hasRefMode = fact.objectified && fact.objectifiedKind !== 'value'
      && !!findRefMode(fact, store.facts, store.objectTypes)
    const diagram = store.diagrams.find(d => d.id === store.activeDiagramId)
    const isExpandedHere = (diagram?.expandedRefModes ?? []).includes(fact.id)
    const refExpansionItems = hasRefMode
      ? [isExpandedHere
          ? { label: 'Collapse Reference Mode', action: () => store.collapseRefMode(fact.id) }
          : { label: 'Expand Reference Mode',   action: () => store.expandRefMode(fact.id)   },
         '---']
      : []
    setContextMenu({
      x: e.clientX, y: e.clientY,
      items: [
        ...(fact.arity > 1 ? [
          { label: 'Add spanning Uniq. Constr.',
            disabled: (() => {
              const allRoles = Array.from({ length: fact.arity }, (_, i) => i)
              const key = JSON.stringify(allRoles)
              return (fact.uniqueness || []).some(u => JSON.stringify([...u].sort()) === key)
            })(),
            action: () => {
              const allRoles = Array.from({ length: fact.arity }, (_, i) => i)
              store.toggleUniqueness(fact.id, allRoles)
            } },
          '---',
        ] : []),
        ...(fact.arity === 2 ? [
          { label: 'Reverse Roles',
            action: () => store.reverseRoles(fact.id) },
        ] : []),
        { label: fact.orientation === 'vertical' ? 'Show Horizontally' : 'Show Vertically',
          action: () => store.updateFactLayout(fact.id, {
            orientation: fact.orientation === 'vertical' ? 'horizontal' : 'vertical',
          }) },
        '---',
        { label: 'Change into', submenu: [
            ...(!fact.objectified ? [
              { label: 'Nested Entity Type',
                action: () => store.convertToNestedEntity(fact.id) },
            ] : [
              { label: 'Fact Type',
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
            { label: 'Implied Links', submenu: [
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
        { label: 'Remove from Diagram',
          action: () => store.removeElementFromDiagram(fact.id, store.activeDiagramId) },
        '---',
        { label: fact.objectified ? 'Delete Nested Entity Type' : 'Delete Fact Type',
          danger: true, action: () => store.deleteFact(fact.id) },
      ],
    })
  }, [store, setContextMenu, handleMultiSelectionContextMenu])

  const handleIfContextMenu = useCallback((fact, ifId, e) => {
    e.preventDefault()
    e.stopPropagation()
    setContextMenu({
      x: e.clientX, y: e.clientY,
      items: [
        { label: 'Edit Frequency Range…', action: () => store.startFrequencyRangeEdit(fact.id, ifId) },
        '---',
        { label: 'Change into Internal Uniqueness Constraint',
          action: () => store.convertFrequencyToUniqueness(fact.id, ifId),
        },
        '---',
        { label: 'Delete Frequency Constraint', danger: true,
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
        { label: 'Edit Value Range…', action: () => {
            store.setTool('select')
            setVrPopup({ factId: fact.id, roleIndex, x: e.clientX, y: e.clientY })
          }},
        '---',
        { label: 'Delete Value Range', danger: true,
          action: () => store.updateRole(fact.id, roleIndex, { valueRange: [] }) },
      ],
    })
  }, [store, setContextMenu, setVrPopup])

  const handleRoleCrContextMenu = useCallback((fact, roleIndex, e) => {
    e.preventDefault()
    e.stopPropagation()
    setContextMenu({
      x: e.clientX, y: e.clientY,
      items: [
        { label: 'Edit Cardinality Range…', action: () => {
            store.setTool('select')
            setVrPopup({ factId: fact.id, roleIndex, x: e.clientX, y: e.clientY,
                         naturalNumbers: true, title: `Cardinality Range — Role ${roleIndex + 1}` })
          }},
        '---',
        { label: 'Delete Cardinality Range', danger: true,
          action: () => store.updateRole(fact.id, roleIndex, { cardinalityRange: [] }) },
      ],
    })
  }, [store, setContextMenu, setVrPopup])

  const handleNestedVrContextMenu = useCallback((fact, e) => {
    e.preventDefault()
    e.stopPropagation()
    setContextMenu({
      x: e.clientX, y: e.clientY,
      items: [
        { label: 'Edit Value Range…', action: () => {
            store.setTool('select')
            setVrPopup({ nestedFactId: fact.id, x: e.clientX, y: e.clientY })
          }},
        '---',
        { label: 'Delete Value Range', danger: true,
          action: () => store.updateFact(fact.id, { valueRange: null }) },
      ],
    })
  }, [store, setContextMenu, setVrPopup])

  const handleNestedCrContextMenu = useCallback((fact, e) => {
    e.preventDefault()
    e.stopPropagation()
    setContextMenu({
      x: e.clientX, y: e.clientY,
      items: [
        { label: 'Edit Cardinality Range…', action: () => {
            store.setTool('select')
            setVrPopup({ nestedFactId: fact.id, x: e.clientX, y: e.clientY,
                         naturalNumbers: true, title: `Cardinality Range — ${fact.objectifiedName || 'Nested Type'}` })
          }},
        '---',
        { label: 'Delete Cardinality Range', danger: true,
          action: () => store.updateFact(fact.id, { cardinalityRange: null }) },
      ],
    })
  }, [store, setContextMenu, setVrPopup])

  const handleOtValueRangeContextMenu = useCallback((ot, e) => {
    e.preventDefault()
    e.stopPropagation()
    setContextMenu({
      x: e.clientX, y: e.clientY,
      items: [
        { label: 'Edit Value Range…', action: () => {
            store.setTool('select')
            setVrPopup({ otId: ot.id, x: e.clientX, y: e.clientY })
          }},
        '---',
        { label: 'Delete Value Range', danger: true,
          action: () => store.updateObjectType(ot.id, { valueRange: [] }) },
      ],
    })
  }, [store, setContextMenu, setVrPopup])

  const handleOtCardinalityRangeContextMenu = useCallback((ot, e) => {
    e.preventDefault()
    e.stopPropagation()
    setContextMenu({
      x: e.clientX, y: e.clientY,
      items: [
        { label: 'Edit Cardinality Range…', action: () => {
            store.setTool('select')
            setVrPopup({ otId: ot.id, x: e.clientX, y: e.clientY,
                         naturalNumbers: true, title: `Cardinality Range — ${ot.name || 'Object Type'}` })
          }},
        '---',
        { label: 'Delete Cardinality Range', danger: true,
          action: () => store.updateObjectType(ot.id, { cardinalityRange: [] }) },
      ],
    })
  }, [store, setContextMenu, setVrPopup])

  const handleMandatoryDotContextMenu = useCallback((factId, roleIndex, e) => {
    e.preventDefault()
    e.stopPropagation()
    setContextMenu({
      x: e.clientX, y: e.clientY,
      items: [
        { label: 'Delete Mandatory Constraint', danger: true,
          action: () => store.removeMandatoryRole(factId, roleIndex) },
      ],
    })
  }, [store, setContextMenu])

  const handleUniquenessBarContextMenu = useCallback((fact, ui, e) => {
    e.preventDefault()
    e.stopPropagation()
    const uRoles = fact.uniqueness[ui]
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
        { label: 'Is Preferred', checked: isPreferred, disabled: piDisabled, title: piTitle,
          action: () => store.setPreferredUniqueness(fact.id, uRoles) },
        '---',
        { label: 'Change into Internal Frequency Constraint',
          action: () => store.convertUniquenessToFrequency(fact.id, uRoles),
        },
        '---',
        { label: 'Delete Uniqueness Constraint', danger: true,
          action: () => store.toggleUniqueness(fact.id, uRoles) },
      ],
    })
  }, [store, setContextMenu])

  const handleImplicitLinkBarContextMenu = useCallback((parentFact, il, ui, e) => {
    e.preventDefault()
    e.stopPropagation()
    const hasSoloBase = (parentFact.uniqueness || []).some(u => u.length === 1 && u[0] === il.roleIndex)
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
        { label: 'Is Preferred', checked: isPreferred, disabled: identifiesVt, title: piTitle,
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
    setContextMenu({
      x: e.clientX, y: e.clientY,
      items: [
        {
          label: 'Inherits Preferred Identifier',
          checked: st.inheritsPreferredIdentifier !== false,
          action: () => store.updateSubtype(st.id, { inheritsPreferredIdentifier: st.inheritsPreferredIdentifier === false }),
        },
        '---',
        { label: 'Delete Subtype Relationship', danger: true, action: () => store.deleteSubtype(st.id) },
      ],
    })
  }, [store, setContextMenu, handleMultiSelectionContextMenu])

  const handleConstraintContextMenu = useCallback((c, e) => {
    if (store.multiSelectedIds.length > 1 && store.multiSelectedIds.includes(c.id)) {
      return handleMultiSelectionContextMenu(e)
    }
    e.preventDefault()
    e.stopPropagation()
    store.select(c.id, 'constraint')
    const maxSequences  = constraintMaxSequences(c.constraintType)
    const hasTargetOt   = hasTargetObjectType(c.constraintType)
    const noRolePos     = suppressRolePosition(c.constraintType)
    const sequences = c.sequences || []
    const items = []

    // "Set Target Object Type" for applicable constraint types
    if (hasTargetOt) {
      items.push({
        label: 'Set Target Object Type…',
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
        items.push({ label: 'Edit Frequency Range…',
          action: () => store.startExternalFrequencyEdit(c.id) })
        items.push({ label: 'Change into External Uniqueness Constraint',
          action: () => store.updateConstraint(c.id, { constraintType: 'uniqueness', isPreferredIdentifier: false }) })
        items.push('---')
      } else if (c.constraintType === 'uniqueness') {
        // External UC's target is the identified element. Disallow PI if the
        // target is a value type — value types are self-identifying.
        const targetOt = c.targetObjectTypeId
          ? store.objectTypes.find(o => o.id === c.targetObjectTypeId) : null
        const identifiesVt = targetOt?.kind === 'value'
        items.push({
          label: 'Is Preferred Identifier',
          checked: !!c.isPreferredIdentifier,
          disabled: identifiesVt,
          title: identifiesVt ? 'A value type cannot have a preferred identifier' : undefined,
          action: () => store.updateConstraint(c.id, { isPreferredIdentifier: !c.isPreferredIdentifier }),
        })
        items.push({ label: 'Change into External Frequency Constraint',
          action: () => store.updateConstraint(c.id, { constraintType: 'frequency', frequency: [{ type: 'upper', upper: 1 }] }) })
        items.push('---')
      } else if (c.constraintType === 'equality' || c.constraintType === 'subset') {
        const other = c.constraintType === 'equality' ? 'subset' : 'equality'
        const otherLabel = c.constraintType === 'equality' ? 'Subset' : 'Equality'
        items.push({ label: `Change to ${otherLabel} Constraint`,
          action: () => store.updateConstraint(c.id, { constraintType: other }) })
        if (c.constraintType === 'subset') {
          items.push({ label: 'Reverse direction',
            disabled: sequences.length < 2,
            action: () => store.swapConstraintSequences(c.id) })
        }
        items.push('---')
      } else if (c.constraintType !== 'frequency' && c.constraintType !== 'valueComparison' && c.constraintType !== 'ring') {
        const CHANGE_LABELS = {
          exclusiveOr: 'Exclusive Or',
          exclusion:   'Exclusion',
          inclusiveOr: 'Inclusive Or',
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
    if (items.length === 0 || items[items.length - 1] !== '---') items.push('---')
    items.push({ label: 'Delete Constraint', danger: true,
      action: () => store.deleteConstraint(c.id) })
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
    const ilPos = activeDiag?.positions?.[ilKey] ?? {}
    const isVertical = (ilPos.orientation ?? il?.orientation) === 'vertical'
    setContextMenu({
      x: e.clientX, y: e.clientY,
      items: [
        { label: isVertical ? 'Show Horizontally' : 'Show Vertically',
          action: () => store.updateImplicitLink(factId, roleIndex, {
            orientation: isVertical ? 'horizontal' : 'vertical'
          }) },
        { label: 'Reverse Roles',
          action: () => store.reverseImplicitLinkRoles(factId, roleIndex) },
        '---',
        { label: 'Remove from Diagram',
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
