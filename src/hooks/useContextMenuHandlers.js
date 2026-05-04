import { useCallback } from 'react'
import { constraintMaxSequences, hasTargetObjectType, suppressRolePosition, isSingletonSequence } from '../utils/constraintRules'

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
    setContextMenu({
      x: e.clientX, y: e.clientY,
      items: [
        { label: ot.kind === 'entity' ? 'Change to Value Type' : 'Change to Entity Type',
          action: () => store.updateObjectType(ot.id, { kind: ot.kind === 'entity' ? 'value' : 'entity' }) },
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
      { label: 'Is Mandatory', checked: !!role.mandatory,
        action: () => store.updateRole(fact.id, roleIndex, { mandatory: !role.mandatory }) },
      { label: 'Has Uniqueness Constraint', checked: hasUnary,
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
      items.push('---', { label: 'Link Fact Type is Shown',
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
    setContextMenu({
      x: e.clientX, y: e.clientY,
      items: [
        { label: 'Add role',
          action: () => store.setFactArity(fact.id, fact.arity + 1) },
        { label: 'Remove last role',
          disabled: fact.arity <= 1,
          action: () => store.setFactArity(fact.id, fact.arity - 1) },
        '---',
        { label: fact.orientation === 'vertical' ? 'Show Horizontally' : 'Show Vertically',
          action: () => store.updateFact(fact.id, {
            orientation: fact.orientation === 'vertical' ? 'horizontal' : 'vertical'
          }) },
        ...(fact.arity === 2 ? [
          { label: 'Reverse Roles',
            action: () => store.reverseRoles(fact.id) },
        ] : []),
        '---',
        ...(fact.arity > 1 ? [
          { label: 'Add Uniqueness Constraint',
            action: () => store.startUniquenessConstruction(fact.id) },
        ] : []),
        '---',
        { label: 'Change into', submenu: [
            ...(!fact.objectified || fact.objectifiedKind === 'value' ? [
              { label: 'Nested Entity Type',
                action: () => store.convertToNestedEntity(fact.id) },
            ] : []),
            ...(!fact.objectified || fact.objectifiedKind !== 'value' ? [
              { label: 'Nested Value Type',
                action: () => store.convertToNestedValue(fact.id) },
            ] : []),
            ...(fact.objectified ? [
              { label: 'Fact Type',
                action: () => store.updateFact(fact.id, {
                  objectified: false, objectifiedName: undefined,
                  nestedReading: false, readingAbove: false, readingOffset: null,
                }) },
            ] : []),
          ],
        },
        '---',
        { label: 'Remove from Diagram',
          action: () => store.removeElementFromDiagram(fact.id, store.activeDiagramId) },
        '---',
        { label: fact.objectified
            ? (fact.objectifiedKind === 'value' ? 'Delete Nested Value Type' : 'Delete Nested Entity Type')
            : 'Delete Fact Type',
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
    const prefKey = fact.preferredUniqueness
      ? JSON.stringify([...fact.preferredUniqueness].sort((a, b) => a - b))
      : null
    const isPreferred = prefKey !== null &&
      JSON.stringify([...uRoles].sort((a, b) => a - b)) === prefKey
    setContextMenu({
      x: e.clientX, y: e.clientY,
      items: [
        { label: 'Is Preferred', checked: isPreferred,
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
    if (c.sequences != null) {
      items.push({ label: 'Add role sequence',
        disabled: sequences.length >= maxSequences,
        action: () => store.startSequenceConstruction(c.id, 'newSequence') })
      if (hasTargetOt) {
        items.push({ label: 'Set target object type',
          action: () => {
            store.setTool('addTargetConnector')
            store.setLinkDraft({ type: 'targetConnector', constraintId: c.id })
          } })
      }
      if (sequences.length > 0 && !noRolePos) {
        items.push({ label: 'Add role position',
          action: () => store.startSequenceConstruction(c.id, 'extend') })
      }
      items.push('---')
      if (c.constraintType === 'frequency') {
        items.push({ label: 'Edit Frequency Range…',
          action: () => store.startExternalFrequencyEdit(c.id) })
        items.push('---')
      } else if (c.constraintType === 'uniqueness') {
        items.push({
          label: 'Is Preferred Identifier',
          checked: !!c.isPreferredIdentifier,
          action: () => store.updateConstraint(c.id, { isPreferredIdentifier: !c.isPreferredIdentifier }),
        })
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
    const isVertical = il?.orientation === 'vertical'
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
    handleSubtypeContextMenu,
    handleConstraintContextMenu,
  }
}
