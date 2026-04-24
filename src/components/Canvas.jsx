import React, { useRef, useCallback, useState, useEffect } from 'react'
import { useOrmStore } from '../store/ormStore'
import { useDiagramElements } from '../hooks/useDiagramElements'
import ObjectTypeNode from './ObjectTypeNode'
import FactTypeNode from './FactTypeNode'
import SubtypeArrows from './SubtypeArrows'
import ConstraintNodes from './ConstraintNodes'
import RoleConnectors, { MandatoryDots } from './RoleConnectors'
import Minimap from './Minimap'
import ContextMenu from './ContextMenu'
import ConstraintMemberLabels from './ConstraintMemberLabels'

const SNAP = 10  // grid snap in world units

function snap(v) { return Math.round(v / SNAP) * SNAP }

export default function Canvas() {
  const store = useOrmStore()
  const { objectTypes: visibleOts, facts: visibleFacts, constraints: visibleConstraints } = useDiagramElements()
  const sharedIds = store.getSharedIds?.() ?? new Set()
  const svgRef = useRef(null)
  const [dragState, setDragState]     = useState(null)
  const [bandRect, setBandRect]       = useState(null)  // { x1,y1,x2,y2 } world coords | null
  const [mousePos, setMousePos]       = useState({ x: 0, y: 0 })
  const [snapEnabled, setSnapEnabled] = useState(true)
  const [spaceDown, setSpaceDown]     = useState(false)
  const spaceRef                      = useRef(false)   // always-current mirror for event handlers
  const [contextMenu, setContextMenu] = useState(null)  // { x, y, items } | null

  const closeContextMenu = useCallback(() => setContextMenu(null), [])

  const handleMultiSelectionContextMenu = useCallback((e) => {
    e.preventDefault()
    e.stopPropagation()
    const canAlign = store.multiSelectedIds.length >= 2
    setContextMenu({
      x: e.clientX, y: e.clientY,
      items: [
        { label: 'Align horizontally', disabled: !canAlign,
          action: () => store.alignMultiSelection('y') },
        { label: 'Align vertically', disabled: !canAlign,
          action: () => store.alignMultiSelection('x') },
      ],
    })
  }, [store])

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
        ...(store.diagrams?.length > 1 ? ['---',
          { label: 'Remove from This Diagram',
            action: () => store.removeElementFromDiagram(ot.id, store.activeDiagramId) },
        ] : []),
        '---',
        { label: `Delete ${ot.kind === 'entity' ? 'Entity' : 'Value'} Type`,
          danger: true, action: () => store.deleteObjectType(ot.id) },
      ],
    })
  }, [store])

  const handleRoleContextMenu = useCallback((fact, roleIndex, e) => {
    e.preventDefault()
    e.stopPropagation()
    const role = fact.roles[roleIndex]
    const hasUnary = fact.uniqueness.some(u => u.length === 1 && u[0] === roleIndex)
    setContextMenu({
      x: e.clientX, y: e.clientY,
      items: [
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
        '---',
        { label: 'Delete role',
          danger: true, disabled: fact.arity <= 1,
          action: () => { store.deleteRole(fact.id, roleIndex); store.clearSelection() } },
      ],
    })
  }, [store])

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
        { label: fact.orientation === 'vertical' ? 'Show Horizontally' : 'Show Vertically',
          action: () => store.updateFact(fact.id, {
            orientation: fact.orientation === 'vertical' ? 'horizontal' : 'vertical'
          }) },
        '---',
        ...(fact.objectified && fact.orientation !== 'vertical' ? [
          { label: 'Nested Reading',
            checked: !!fact.nestedReading,
            action: () => {
              const patch = { nestedReading: !fact.nestedReading }
              if (fact.nestedReading && fact.readingAbove) { patch.readingAbove = false; patch.readingOffset = null }
              store.updateFactLayout(fact.id, patch)
            } },
        ] : []),
        { label: fact.orientation === 'vertical' ? 'Reading is shown right' : 'Reading is shown above',
          checked: !!fact.readingAbove,
          disabled: fact.objectified && fact.orientation !== 'vertical' && !fact.nestedReading,
          action: () => store.updateFactLayout(fact.id, { readingAbove: !fact.readingAbove, readingOffset: null }) },
        { label: fact.orientation === 'vertical' ? 'Uniqueness is shown left' : 'Uniqueness is shown below',
          checked: !!fact.uniquenessBelow,
          action: () => store.updateFactLayout(fact.id, { uniquenessBelow: !fact.uniquenessBelow }) },
        '---',
        { label: 'Add role',
          action: () => store.setFactArity(fact.id, fact.arity + 1) },
        { label: 'Remove last role',
          disabled: fact.arity <= 1,
          action: () => store.setFactArity(fact.id, fact.arity - 1) },
        ...(fact.arity === 2 ? ['---',
          { label: 'Reverse Role Order',
            action: () => store.reorderRoles(fact.id, 0, 1) }] : []),
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
        ...(store.diagrams?.length > 1 ? ['---',
          { label: 'Remove from This Diagram',
            action: () => store.removeElementFromDiagram(fact.id, store.activeDiagramId) },
        ] : []),
        '---',
        { label: 'Delete Fact Type',
          danger: true, action: () => store.deleteFact(fact.id) },
      ],
    })
  }, [store])

  const handleConstraintContextMenu = useCallback((c, e) => {
    if (store.multiSelectedIds.length > 1 && store.multiSelectedIds.includes(c.id)) {
      return handleMultiSelectionContextMenu(e)
    }
    e.preventDefault()
    e.stopPropagation()
    store.select(c.id, 'constraint')
    const isSingleton = c.constraintType === 'inclusiveOr' || c.constraintType === 'exclusiveOr' || c.constraintType === 'uniqueness'
    const maxSequences = (c.constraintType === 'equality' || c.constraintType === 'subset') ? 2 : Infinity
    const sequences = c.sequences || []
    const items = []
    if (c.sequences != null) {
      items.push({ label: 'Add role sequence',
        disabled: sequences.length >= maxSequences,
        action: () => store.startSequenceConstruction(c.id, 'newSequence') })
      if (isSingleton) {
        items.push({ label: 'Set target object type',
          action: () => {
            store.setTool('addTargetConnector')
            store.setLinkDraft({ type: 'targetConnector', constraintId: c.id })
          } })
      }
      if (sequences.length > 0 && !isSingleton) {
        items.push({ label: 'Add role position',
          action: () => store.startSequenceConstruction(c.id, 'extend') })
      }
      items.push('---')
      if (c.constraintType === 'uniqueness') {
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
      } else {
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
            const toSingleton = t === 'inclusiveOr' || t === 'exclusiveOr'
            if (toSingleton && c.sequences && c.sequences.some(g => g.length > 1)) {
              patch.sequences = c.sequences.map(g => g.slice(0, 1))
            }
            store.updateConstraint(c.id, patch)
          },
        })) })
        items.push('---')
      }
    }
    if (store.diagrams?.length > 1) {
      items.push('---')
      items.push({ label: 'Remove from This Diagram',
        action: () => store.removeElementFromDiagram(c.id, store.activeDiagramId) })
    }
    items.push('---')
    items.push({ label: 'Delete Constraint', danger: true,
      action: () => store.deleteConstraint(c.id) })
    setContextMenu({ x: e.clientX, y: e.clientY, items })
  }, [store])

  const screenToWorld = useCallback((sx, sy) => {
    const rect = svgRef.current?.getBoundingClientRect()
    if (!rect) return { x: 0, y: 0 }
    return {
      x: (sx - rect.left - store.pan.x) / store.zoom,
      y: (sy - rect.top  - store.pan.y) / store.zoom,
    }
  }, [store.pan, store.zoom])

  // ── background click / placement ────────────────────────────────────────
  const handleSVGMouseDown = useCallback((e) => {
    const isBackground = e.target === svgRef.current || e.target.closest('.canvas-bg')
    if (!isBackground) return

    // Middle-click → pan
    if (e.button === 1 || (e.button === 0 && spaceRef.current)) {
      e.preventDefault()
      setDragState({ type: 'pan', startX: e.clientX, startY: e.clientY,
                     origX: store.pan.x, origY: store.pan.y })
      return
    }
    if (e.button !== 0) return

    let { x, y } = screenToWorld(e.clientX, e.clientY)
    if (snapEnabled) { x = snap(x); y = snap(y) }

    if (store.tool === 'addEntity')     { store.addEntity(x, y); store.setTool('select'); return }
    if (store.tool === 'addValue')      { store.addValue(x, y);  store.setTool('select'); return }
    if (store.tool === 'addFact2')      { store.addFact(x, y, 2); store.setTool('select'); return }
    if (store.tool === 'addNestedFact')      { store.addNestedFact(x, y, 2); store.setTool('select'); return }
    if (store.tool === 'addNestedValueFact') { store.addNestedValueFact(x, y, 2); store.setTool('select'); return }
    if (store.tool.startsWith('addConstraint:')) {
      store.addConstraint(store.tool.split(':')[1], x, y)
      store.setTool('select'); return
    }
    if (store.sequenceConstruction) {
      store.abandonSequenceConstruction()
      if (useOrmStore.getState().tool === 'connectConstraint') {
        store.clearSelection()
        store.setTool('select')
      }
      return
    }
    if (store.tool === 'assignRole' || store.tool === 'addSubtype' || store.tool === 'toggleMandatory' || store.tool === 'addInternalUniqueness') { store.setTool('select'); return }
    if (store.tool === 'connectConstraint') { store.clearSelection(); store.setTool('select'); return }
    if (store.tool === 'addTargetConnector') { store.clearLinkDraft(); store.setTool('select'); return }
    if (store.linkDraft) { store.clearLinkDraft(); return }

    // In select mode: start rubber-band (replaces left-drag pan)
    if (!e.shiftKey) store.clearSelection()
    const { x: wx, y: wy } = screenToWorld(e.clientX, e.clientY)
    setDragState({ type: 'band', startX: e.clientX, startY: e.clientY,
                   wx, wy, active: false, endWx: wx, endWy: wy,
                   additive: e.shiftKey })
    setBandRect(null)
    e.preventDefault()
  }, [store, screenToWorld, snapEnabled])

  // ── element drag start (called by child nodes) ──────────────────────────
  const handleDragStart = useCallback((id, kind, e) => {
    // If we're in roleAssign mode and the drag starts on an object type,
    // start the link-draft rather than dragging the element.
    if (store.tool === 'assignRole' && kind !== 'fact' && kind !== 'constraint') {
      store.setLinkDraft({ type: 'roleAssign', objectTypeId: id })
      e.stopPropagation()
      return
    }

    const multiIds = store.multiSelectedIds
    if (multiIds.length > 0 && multiIds.includes(id)) {
      // Multi-element drag — record initial position from diagram-positioned elements
      const getPos = (eid) => {
        const ot = visibleOts.find(o => o.id === eid)
        if (ot) return { id: eid, kind: 'ot', origX: ot.x, origY: ot.y }
        const f = visibleFacts.find(f => f.id === eid)
        if (f) return { id: eid, kind: 'fact', origX: f.x, origY: f.y }
        const c = visibleConstraints.find(c => c.id === eid)
        if (c) return { id: eid, kind: 'constraint', origX: c.x, origY: c.y }
        return null
      }
      const elements = multiIds.map(getPos).filter(Boolean)
      setDragState({ type: 'multiElement', startX: e.clientX, startY: e.clientY, elements })
      return
    }

    const el = kind === 'fact'
      ? visibleFacts.find(f => f.id === id)
      : kind === 'constraint'
        ? visibleConstraints.find(c => c.id === id)
        : visibleOts.find(o => o.id === id)
    if (!el) return
    setDragState({ type: 'element', id, kind,
                   startX: e.clientX, startY: e.clientY,
                   origX: el.x, origY: el.y })
  }, [store])

  // ── mouse move ──────────────────────────────────────────────────────────
  const handleMouseMove = useCallback((e) => {
    const world = screenToWorld(e.clientX, e.clientY)
    setMousePos(world)
    if (!dragState) return

    const dx = e.clientX - dragState.startX
    const dy = e.clientY - dragState.startY

    if (dragState.type === 'pan') {
      store.setPan(dragState.origX + dx, dragState.origY + dy)
    } else if (dragState.type === 'element') {
      if (dx * dx + dy * dy < 16) return
      let wx = dragState.origX + dx / store.zoom
      let wy = dragState.origY + dy / store.zoom
      if (snapEnabled) { wx = snap(wx); wy = snap(wy) }
      if (dragState.kind === 'fact')            store.moveFact(dragState.id, wx, wy)
      else if (dragState.kind === 'constraint') store.moveConstraint(dragState.id, wx, wy)
      else                                      store.moveObjectType(dragState.id, wx, wy)
    } else if (dragState.type === 'multiElement') {
      if (dx * dx + dy * dy < 16) return
      const wdx = dx / store.zoom
      const wdy = dy / store.zoom
      for (const el of dragState.elements) {
        let wx = el.origX + wdx
        let wy = el.origY + wdy
        if (snapEnabled) { wx = snap(wx); wy = snap(wy) }
        if (el.kind === 'fact')            store.moveFact(el.id, wx, wy)
        else if (el.kind === 'constraint') store.moveConstraint(el.id, wx, wy)
        else                               store.moveObjectType(el.id, wx, wy)
      }
    } else if (dragState.type === 'band') {
      if (!dragState.active && dx * dx + dy * dy < 16) return
      const { x: endWx, y: endWy } = screenToWorld(e.clientX, e.clientY)
      setDragState(prev => ({ ...prev, active: true, endWx, endWy }))
      setBandRect({ x1: dragState.wx, y1: dragState.wy, x2: endWx, y2: endWy })
    }
  }, [dragState, store, screenToWorld, snapEnabled])

  const handleMouseUp = useCallback(() => {
    if (dragState?.type === 'band' && dragState.active) {
      const minX = Math.min(dragState.wx, dragState.endWx)
      const maxX = Math.max(dragState.wx, dragState.endWx)
      const minY = Math.min(dragState.wy, dragState.endWy)
      const maxY = Math.max(dragState.wy, dragState.endWy)
      const inBand = (x, y) => x >= minX && x <= maxX && y >= minY && y <= maxY
      const s = useOrmStore.getState()
      const ids = [
        ...s.objectTypes.filter(o => inBand(o.x, o.y)).map(o => o.id),
        ...s.facts.filter(f => inBand(f.x, f.y)).map(f => f.id),
        ...s.constraints.filter(c => inBand(c.x, c.y)).map(c => c.id),
        ...s.subtypes.filter(st => {
          const sub = s.objectTypes.find(o => o.id === st.subId)
          const sup = s.objectTypes.find(o => o.id === st.superId)
          if (!sub || !sup) return false
          return inBand((sub.x + sup.x) / 2, (sub.y + sup.y) / 2)
        }).map(st => st.id),
      ]
      const finalIds = dragState.additive
        ? [...new Set([...s.multiSelectedIds, ...ids])]
        : ids
      store.setMultiSelection(finalIds)
    }
    setDragState(null)
    setBandRect(null)
  }, [dragState, store])

  // ── wheel zoom ──────────────────────────────────────────────────────────
  const handleWheel = useCallback((e) => {
    e.preventDefault()
    if (e.ctrlKey) {
      // Pinch-to-zoom (macOS trackpad) or Ctrl+scroll wheel → zoom
      const rect = svgRef.current.getBoundingClientRect()
      const cx = e.clientX - rect.left
      const cy = e.clientY - rect.top
      const factor = e.deltaY < 0 ? 1.1 : 0.909
      const newZoom = Math.min(3, Math.max(0.15, store.zoom * factor))
      store.setPan(
        cx - (cx - store.pan.x) * (newZoom / store.zoom),
        cy - (cy - store.pan.y) * (newZoom / store.zoom),
      )
      store.setZoom(newZoom)
    } else {
      // Two-finger trackpad scroll (or plain scroll wheel) → pan
      store.setPan(store.pan.x - e.deltaX, store.pan.y - e.deltaY)
    }
  }, [store])

  useEffect(() => {
    const el = svgRef.current
    if (!el) return
    el.addEventListener('wheel', handleWheel, { passive: false })
    return () => el.removeEventListener('wheel', handleWheel)
  }, [handleWheel])

  // Snap toggle (Shift) and pan mode (Space)
  useEffect(() => {
    const down = (e) => {
      if (e.key === 'Shift') setSnapEnabled(false)
      if (e.key === ' ') {
        const tag = document.activeElement?.tagName
        if (tag !== 'INPUT' && tag !== 'TEXTAREA') {
          e.preventDefault()
          spaceRef.current = true
          setSpaceDown(true)
        }
      }
    }
    const up = (e) => {
      if (e.key === 'Shift') setSnapEnabled(true)
      if (e.key === ' ') { spaceRef.current = false; setSpaceDown(false) }
    }
    window.addEventListener('keydown', down)
    window.addEventListener('keyup',   up)
    return () => { window.removeEventListener('keydown', down); window.removeEventListener('keyup', up) }
  }, [])

  // ── cursor ──────────────────────────────────────────────────────────────
  const cursor =
    dragState?.type === 'pan'          ? 'grabbing'
    : spaceDown                        ? 'grab'
    : store.sequenceConstruction       ? 'crosshair'
    : store.tool === 'connectConstraint' ? 'cell'
    : store.tool === 'assignRole'      ? 'copy'
    : store.tool === 'addSubtype'      ? 'cell'
    : store.tool === 'select'
      ? (dragState?.type === 'band'         ? 'crosshair'
       : dragState?.type === 'multiElement' ? 'grabbing'
       : 'default')
    : store.tool.startsWith('add') ? 'crosshair'
    : 'default'

  return (
    <div style={{ flex: 1, position: 'relative', overflow: 'hidden' }}>
      <svg
        ref={svgRef}
        id="orm2-canvas-svg"
        tabIndex={0}
        style={{ width: '100%', height: '100%', display: 'block',
                 background: 'var(--bg-canvas)', cursor, outline: 'none' }}
        onMouseEnter={() => {
          const ae = document.activeElement
          if (!ae || ae === document.body || ae === svgRef.current)
            svgRef.current?.focus({ preventScroll: true })
        }}
        onMouseDown={handleSVGMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
      >
        <defs>
          <pattern id="gridSm" width={20 * store.zoom} height={20 * store.zoom}
            x={store.pan.x % (20 * store.zoom)} y={store.pan.y % (20 * store.zoom)}
            patternUnits="userSpaceOnUse">
            <path d={`M ${20 * store.zoom} 0 L 0 0 0 ${20 * store.zoom}`}
              fill="none" stroke="#ddd4c8" strokeWidth="0.5"/>
          </pattern>
          <pattern id="gridLg" width={100 * store.zoom} height={100 * store.zoom}
            x={store.pan.x % (100 * store.zoom)} y={store.pan.y % (100 * store.zoom)}
            patternUnits="userSpaceOnUse">
            <rect width={100 * store.zoom} height={100 * store.zoom} fill="url(#gridSm)"/>
            <path d={`M ${100 * store.zoom} 0 L 0 0 0 ${100 * store.zoom}`}
              fill="none" stroke="#ccc3b8" strokeWidth="1"/>
          </pattern>
          <marker id="arrowSubtype" markerWidth="4.5" markerHeight="4.5" refX="0.25" refY="2" orient="auto">
            <path d="M 0.25 0.25 L 4.25 2 L 0.25 3.75 Z" fill="var(--col-subtype)" stroke="none"/>
          </marker>
          <marker id="arrowSubtypeAccent" markerWidth="4.5" markerHeight="4.5" refX="0.25" refY="2" orient="auto">
            <path d="M 0.25 0.25 L 4.25 2 L 0.25 3.75 Z" fill="var(--accent)" stroke="none"/>
          </marker>
          <marker id="arrowSubset" markerWidth="10" markerHeight="10" refX="9" refY="4" orient="auto">
            <path d="M 1 1 L 9 4 L 1 7" fill="none" stroke="var(--col-excl)" strokeWidth="1.5"/>
          </marker>
          <marker id="arrowSubsetSolid" markerWidth="13" markerHeight="13" refX="12" refY="5" orient="auto">
            <path d="M 1 1 L 12 5 L 1 9 Z" fill="var(--col-excl)" stroke="none"/>
          </marker>
          <marker id="arrowConstraintTarget" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
            <path d="M 1 1 L 7 4 L 1 7" fill="none" stroke="var(--col-constraint)" strokeWidth="1.5"
              strokeLinecap="round" strokeLinejoin="round"/>
          </marker>
          <filter id="selectGlow" x="-20%" y="-20%" width="140%" height="140%">
            <feDropShadow dx="0" dy="0" stdDeviation="3"
              floodColor="var(--accent)" floodOpacity="0.5"/>
          </filter>
          <filter id="sharedGlow" x="-20%" y="-20%" width="140%" height="140%">
            <feDropShadow dx="5" dy="5" stdDeviation="0"
              floodColor="#444" floodOpacity="0.5"/>
          </filter>
        </defs>

        <rect className="canvas-bg" width="100%" height="100%" fill="url(#gridLg)"/>

        <g transform={`translate(${store.pan.x},${store.pan.y}) scale(${store.zoom})`}>
          <SubtypeArrows  mousePos={mousePos}/>
          {visibleFacts.map(f => (
            <FactTypeNode key={f.id} fact={f} onDragStart={handleDragStart}
              isShared={sharedIds.has(f.id)}
              onContextMenu={(e) => handleFactContextMenu(f, e)}
              onRoleContextMenu={(roleIndex, e) => handleRoleContextMenu(f, roleIndex, e)}/>
          ))}
          <RoleConnectors mousePos={mousePos}/>
          {visibleOts.map(ot => (
            <ObjectTypeNode key={ot.id} objectType={ot}
              onDragStart={handleDragStart}
              mousePos={mousePos}
              isShared={sharedIds.has(ot.id)}
              onContextMenu={(e) => handleOtContextMenu(ot, e)}/>
          ))}
          <MandatoryDots/>
          <ConstraintNodes onDragStart={handleDragStart} mousePos={mousePos}
            onContextMenu={handleConstraintContextMenu}/>
          <ConstraintMemberLabels/>

          {/* Rubber-band selection rect */}
          {bandRect && (
            <rect
              x={Math.min(bandRect.x1, bandRect.x2)}
              y={Math.min(bandRect.y1, bandRect.y2)}
              width={Math.abs(bandRect.x2 - bandRect.x1)}
              height={Math.abs(bandRect.y2 - bandRect.y1)}
              fill="rgba(30,120,220,0.08)"
              stroke="rgba(30,120,220,0.6)"
              strokeWidth={1 / store.zoom}
              strokeDasharray={`${4 / store.zoom} ${2 / store.zoom}`}
              style={{ pointerEvents: 'none' }}
            />
          )}
        </g>

        {/* Space-pan overlay — covers all elements when Space is held so only panning is possible */}
        {spaceDown && (
          <rect
            x="0" y="0" width="100%" height="100%"
            fill="transparent"
            style={{ cursor: dragState?.type === 'pan' ? 'grabbing' : 'grab' }}
            onMouseDown={e => {
              if (e.button !== 0) return
              e.stopPropagation()
              setDragState({ type: 'pan', startX: e.clientX, startY: e.clientY,
                             origX: store.pan.x, origY: store.pan.y })
            }}
          />
        )}
      </svg>

      {/* Minimap overlay */}
      <Minimap/>

      {/* Context menu */}
      {contextMenu && (
        <ContextMenu
          x={contextMenu.x} y={contextMenu.y}
          items={contextMenu.items}
          onClose={closeContextMenu}/>
      )}

      {/* Snap indicator */}
      <div style={{
        position: 'absolute', bottom: 6, left: 10,
        fontSize: 10, color: 'var(--ink-muted)',
        fontFamily: 'var(--font-mono)',
        pointerEvents: 'none',
      }}>
        {snapEnabled ? '⊞ snap on' : '⊡ snap off'} · hold Shift to toggle · hold Space to pan
      </div>
    </div>
  )
}
