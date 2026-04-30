import React, { useRef, useCallback, useState, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { useOrmStore } from '../store/ormStore'
import { useDiagramElements } from '../hooks/useDiagramElements'
import { useContextMenuHandlers } from '../hooks/useContextMenuHandlers'
import ObjectTypeNode from './ObjectTypeNode'
import FactTypeNode, { factBounds } from './FactTypeNode'
import SubtypeArrows from './SubtypeArrows'
import ConstraintNodes from './ConstraintNodes'
import RoleConnectors, { MandatoryDots } from './RoleConnectors'
import Minimap from './Minimap'
import ContextMenu from './ContextMenu'
import ConstraintMemberLabels from './ConstraintMemberLabels'
import { ValueRangeEditor } from './Inspector'

const SNAP = 10  // grid snap in world units

function snap(v) { return Math.round(v / SNAP) * SNAP }

// ── Shared popup positioning ─────────────────────────────────────────────────
// Returns { left, top|bottom, maxHeight } that keep the popup within the viewport.
function popupPos(x, y, popW) {
  const MARGIN = 8, GAP = 16
  const left = Math.max(MARGIN, Math.min(x - popW / 2, window.innerWidth - popW - MARGIN))
  const spaceAbove = y - GAP
  const spaceBelow = window.innerHeight - y - GAP
  if (spaceAbove >= spaceBelow || spaceAbove >= 120) {
    return { left, bottom: window.innerHeight - y + GAP,
             maxHeight: Math.max(60, spaceAbove - MARGIN) }
  }
  return { left, top: y + GAP,
           maxHeight: Math.max(60, spaceBelow - MARGIN) }
}

// ── Draggable popup hook ──────────────────────────────────────────────────────
// Returns { dragOffset, onDragMouseDown } — apply transform + cursor to header.
function usePopupDrag() {
  const [offset, setOffset] = useState({ x: 0, y: 0 })
  const onDragMouseDown = useCallback((e) => {
    if (e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()
    const startX = e.clientX - offset.x
    const startY = e.clientY - offset.y
    const onMove = (ev) => setOffset({ x: ev.clientX - startX, y: ev.clientY - startY })
    const onUp   = () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }, [offset.x, offset.y])
  return { dragOffset: offset, onDragMouseDown }
}

// ── Frequency Range pop-up (stage 3 of internal frequency construction) ──────
function FrequencyRangePopup({ range, onChange, x, y, onDone, onAbort }) {
  const ref = useRef(null)
  const { dragOffset, onDragMouseDown } = usePopupDrag()

  useEffect(() => {
    const onDown = (e) => { if (!ref.current?.contains(e.target)) onAbort() }
    document.addEventListener('mousedown', onDown, true)
    return () => document.removeEventListener('mousedown', onDown, true)
  }, [onAbort])

  const POP_W = 280
  const pos = popupPos(x, y, POP_W)

  return createPortal(
    <div ref={ref}
      onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); onDone() } }}
      style={{
        position: 'fixed', ...pos,
        transform: `translate(${dragOffset.x}px, ${dragOffset.y}px)`,
        width: POP_W,
        overflowY: 'auto',
        background: 'var(--bg-surface)',
        border: '1px solid var(--border)',
        borderRadius: 6,
        boxShadow: '0 4px 20px rgba(0,0,0,0.2)',
        padding: '10px 12px',
        zIndex: 10200,
        fontFamily: 'var(--font-mono)',
        fontSize: 12,
        color: 'var(--ink-2)',
      }}>
      <div
        onMouseDown={onDragMouseDown}
        style={{ fontSize: 10, fontWeight: 600, color: 'var(--ink-muted)',
          textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 8,
          cursor: 'move', userSelect: 'none' }}>
        Frequency Range
      </div>
      <ValueRangeEditor range={range} onChange={onChange} naturalNumbers={true}/>
      <button
        onClick={onDone}
        style={{
          marginTop: 8,
          padding: '4px 12px',
          background: 'var(--accent)',
          color: '#fff',
          border: 'none',
          borderRadius: 4,
          cursor: 'pointer',
          fontSize: 11,
          fontFamily: 'var(--font-mono)',
        }}>
        Done
      </button>
    </div>,
    document.body
  )
}

// ── Value Range pop-up ────────────────────────────────────────────────────────
function ValueRangePopup({ title, initialRange, onCommit, x, y, onClose, naturalNumbers }) {
  const ref = useRef(null)
  const [range, setRange] = React.useState(initialRange)
  const { dragOffset, onDragMouseDown } = usePopupDrag()

  useEffect(() => {
    const onDown = (e) => { if (!ref.current?.contains(e.target)) onClose() }
    document.addEventListener('mousedown', onDown, true)
    return () => document.removeEventListener('mousedown', onDown, true)
  }, [onClose])

  const commit = () => { onCommit(range); onClose() }

  const POP_W = 280
  const pos = popupPos(x, y, POP_W)

  return createPortal(
    <div ref={ref}
      onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); commit() } }}
      style={{
        position: 'fixed',
        ...pos,
        transform: `translate(${dragOffset.x}px, ${dragOffset.y}px)`,
        width: POP_W,
        overflowY: 'auto',
        background: 'var(--bg-surface)',
        border: '1px solid var(--border)',
        borderRadius: 6,
        boxShadow: '0 4px 20px rgba(0,0,0,0.2)',
        padding: '10px 12px',
        zIndex: 10200,
        fontFamily: 'var(--font-mono)',
        fontSize: 12,
        color: 'var(--ink-2)',
      }}>
      <div
        onMouseDown={onDragMouseDown}
        style={{ fontSize: 10, fontWeight: 600, color: 'var(--ink-muted)',
          textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 8,
          cursor: 'move', userSelect: 'none' }}>
        {title}
      </div>
      <ValueRangeEditor range={range} onChange={setRange} naturalNumbers={naturalNumbers}/>
      <button
        onClick={commit}
        style={{
          marginTop: 8,
          padding: '4px 12px',
          background: 'var(--accent)',
          color: '#fff',
          border: 'none',
          borderRadius: 4,
          cursor: 'pointer',
          fontSize: 11,
          fontFamily: 'var(--font-mono)',
        }}>
        Done
      </button>
    </div>,
    document.body
  )
}

export default function Canvas() {
  const store = useOrmStore()
  const { objectTypes: visibleOts, facts: visibleFacts, constraints: visibleConstraints, subtypes: visibleSubtypes } = useDiagramElements()
  const sharedIds = store.getSharedIds?.() ?? new Set()
  const svgRef = useRef(null)
  const [dragState, setDragState]     = useState(null)
  const [bandRect, setBandRect]       = useState(null)  // { x1,y1,x2,y2 } world coords | null
  const [mousePos, setMousePos]       = useState({ x: 0, y: 0 })
  const [snapEnabled, setSnapEnabled] = useState(true)
  const [spaceDown, setSpaceDown]     = useState(false)
  const spaceRef                      = useRef(false)   // always-current mirror for event handlers
  const [contextMenu, setContextMenu] = useState(null) // { x, y, items } | null
  const [vrPopup, setVrPopup] = useState(null)         // { factId?, roleIndex?, otId?, x, y } | null

  const closeContextMenu = useCallback(() => setContextMenu(null), [])

  const {
    handleMultiSelectionContextMenu,
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
  } = useContextMenuHandlers(store, setContextMenu, setVrPopup)

  const handleRoleValueClick = useCallback((fact, roleIndex, clientX, clientY) => {
    store.setTool('select')
    setVrPopup({ factId: fact.id, roleIndex, x: clientX, y: clientY })
  }, [store])

  const handleOtValueRangeClick = useCallback((ot, clientX, clientY) => {
    store.setTool('select')
    setVrPopup({ otId: ot.id, x: clientX, y: clientY })
  }, [store])

  const handleNestedFactVrClick = useCallback((fact, clientX, clientY) => {
    store.setTool('select')
    setVrPopup({ nestedFactId: fact.id, x: clientX, y: clientY })
  }, [store])

  const handleOtCardinalityRangeClick = useCallback((ot, clientX, clientY) => {
    store.setTool('select')
    setVrPopup({ otId: ot.id, x: clientX, y: clientY, naturalNumbers: true, title: `Cardinality Range — ${ot.name || 'Object Type'}` })
  }, [store])

  const handleRoleCardinalityClick = useCallback((fact, roleIndex, clientX, clientY) => {
    store.setTool('select')
    setVrPopup({ factId: fact.id, roleIndex, x: clientX, y: clientY, naturalNumbers: true, title: `Cardinality Range — Role ${roleIndex + 1}` })
  }, [store])

  const handleNestedFactCrClick = useCallback((fact, clientX, clientY) => {
    store.setTool('select')
    setVrPopup({ nestedFactId: fact.id, x: clientX, y: clientY, naturalNumbers: true, title: `Cardinality Range — ${fact.objectifiedName || 'Nested Type'}` })
  }, [store])

  const screenToWorld = useCallback((sx, sy) => {
    const rect = svgRef.current?.getBoundingClientRect()
    if (!rect) return { x: 0, y: 0 }
    return {
      x: (sx - rect.left - store.pan.x) / store.zoom,
      y: (sy - rect.top  - store.pan.y) / store.zoom,
    }
  }, [store.pan, store.zoom])

  const worldToScreen = useCallback((wx, wy) => {
    const rect = svgRef.current?.getBoundingClientRect()
    if (!rect) return { x: 0, y: 0 }
    return {
      x: wx * store.zoom + store.pan.x + rect.left,
      y: wy * store.zoom + store.pan.y + rect.top,
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
    if (store.tool.startsWith('addConstraint:') && store.tool !== 'addConstraint:valueRange' && store.tool !== 'addConstraint:cardinality') {
      store.addConstraint(store.tool.split(':')[1], x, y)
      store.setTool('select'); return
    }
    if (store.uniquenessConstruction) {
      store.abandonUniquenessConstruction()
      store.setTool('select')
      return
    }
    if (store.frequencyConstruction) {
      store.abandonFrequencyConstruction()
      store.setTool('select')
      return
    }
    if (store.sequenceConstruction) {
      store.abandonSequenceConstruction()
      if (useOrmStore.getState().tool === 'connectConstraint') {
        store.clearSelection()
        store.setTool('select')
      }
      return
    }
    if (store.tool === 'assignRole' || store.tool === 'addSubtype' || store.tool === 'toggleMandatory' || store.tool === 'addInternalUniqueness' || store.tool === 'addInternalFrequency' || store.tool === 'addConstraint:valueRange' || store.tool === 'addConstraint:cardinality') { store.setTool('select'); return }
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
      const inBand    = (x, y) => x >= minX && x <= maxX && y >= minY && y <= maxY
      const boxInBand = (b)    => b.left >= minX && b.right <= maxX && b.top >= minY && b.bottom <= maxY
      // Use visibleOts/visibleFacts/visibleConstraints: they carry diagram-merged positions
      // so the hit-test matches what is actually rendered on screen.
      const ids = [
        ...visibleOts        .filter(o  => inBand(o.x, o.y))           .map(o  => o.id),
        ...visibleFacts      .filter(f  => boxInBand(factBounds(f)))    .map(f  => f.id),
        ...visibleConstraints.filter(c  => inBand(c.x, c.y))           .map(c  => c.id),
        ...visibleSubtypes   .filter(st => {
          const sub = visibleOts.find(o => o.id === st.subId)
          const sup = visibleOts.find(o => o.id === st.superId)
          if (!sub || !sup) return false
          return inBand((sub.x + sup.x) / 2, (sub.y + sup.y) / 2)
        }).map(st => st.id),
      ]
      const finalIds = dragState.additive
        ? [...new Set([...store.multiSelectedIds, ...ids])]
        : ids
      store.setMultiSelection(finalIds)
    }
    setDragState(null)
    setBandRect(null)
  }, [dragState, store, visibleOts, visibleFacts, visibleConstraints, visibleSubtypes])

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
        className={store.tool === 'select' ? 'tool-select' : undefined}
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
          <SubtypeArrows  mousePos={mousePos} onContextMenu={handleSubtypeContextMenu}/>
          {visibleFacts.map(f => (
            <FactTypeNode key={f.id} fact={f} onDragStart={handleDragStart}
              isShared={sharedIds.has(f.id)}
              onContextMenu={(e) => handleFactContextMenu(f, e)}
              onRoleContextMenu={(roleIndex, e) => handleRoleContextMenu(f, roleIndex, e)}
              onBarContextMenu={(ui, e) => handleUniquenessBarContextMenu(f, ui, e)}
              onRoleValueClick={(roleIndex, cx, cy) => handleRoleValueClick(f, roleIndex, cx, cy)}
              onNestedVrClick={(cx, cy) => handleNestedFactVrClick(f, cx, cy)}
              onRoleCardinalityClick={(roleIndex, cx, cy) => handleRoleCardinalityClick(f, roleIndex, cx, cy)}
              onNestedCrClick={(cx, cy) => handleNestedFactCrClick(f, cx, cy)}
              onIfContextMenu={(ifId, e) => handleIfContextMenu(f, ifId, e)}
              onRoleValueContextMenu={(ri, e) => handleRoleValueContextMenu(f, ri, e)}
              onRoleCrContextMenu={(ri, e) => handleRoleCrContextMenu(f, ri, e)}
              onNestedVrContextMenu={(e) => handleNestedVrContextMenu(f, e)}
              onNestedCrContextMenu={(e) => handleNestedCrContextMenu(f, e)}/>
          ))}
          <RoleConnectors mousePos={mousePos}/>
          {visibleOts.map(ot => (
            <ObjectTypeNode key={ot.id} objectType={ot}
              onDragStart={handleDragStart}
              mousePos={mousePos}
              isShared={sharedIds.has(ot.id)}
              onContextMenu={(e) => handleOtContextMenu(ot, e)}
              onDoubleClickValueRange={(cx, cy) => handleOtValueRangeClick(ot, cx, cy)}
              onValueRangeClick={(cx, cy) => handleOtValueRangeClick(ot, cx, cy)}
              onCardinalityRangeClick={(cx, cy) => handleOtCardinalityRangeClick(ot, cx, cy)}
              onValueRangeContextMenu={(e) => handleOtValueRangeContextMenu(ot, e)}
              onCardinalityRangeContextMenu={(e) => handleOtCardinalityRangeContextMenu(ot, e)}/>
          ))}
          <MandatoryDots onContextMenu={handleMandatoryDotContextMenu}/>
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

      {/* Context menu — rendered via portal at document.body to escape all stacking contexts */}
      {contextMenu && createPortal(
        <ContextMenu
          x={contextMenu.x} y={contextMenu.y}
          items={contextMenu.items}
          onClose={closeContextMenu}/>,
        document.body
      )}

      {vrPopup && (() => {
        let title, initialRange, onCommit
        if (vrPopup.naturalNumbers) {
          // Cardinality range popup
          title = vrPopup.title
          if (vrPopup.factId != null) {
            const fact = store.facts.find(f => f.id === vrPopup.factId)
            initialRange = fact?.roles[vrPopup.roleIndex]?.cardinalityRange
            onCommit = vr => store.updateRole(vrPopup.factId, vrPopup.roleIndex, { cardinalityRange: vr })
          } else if (vrPopup.nestedFactId != null) {
            const fact = store.facts.find(f => f.id === vrPopup.nestedFactId)
            initialRange = fact?.cardinalityRange
            onCommit = vr => store.updateFact(vrPopup.nestedFactId, { cardinalityRange: vr })
          } else {
            const ot = store.objectTypes.find(o => o.id === vrPopup.otId)
            initialRange = ot?.cardinalityRange
            onCommit = vr => store.updateObjectType(vrPopup.otId, { cardinalityRange: vr })
          }
        } else {
          // Value range popup
          if (vrPopup.factId != null) {
            const fact = store.facts.find(f => f.id === vrPopup.factId)
            initialRange = fact?.roles[vrPopup.roleIndex]?.valueRange
            onCommit = vr => store.updateRole(vrPopup.factId, vrPopup.roleIndex, { valueRange: vr })
            title    = `Value Range — Role ${vrPopup.roleIndex + 1}`
          } else if (vrPopup.nestedFactId != null) {
            const fact = store.facts.find(f => f.id === vrPopup.nestedFactId)
            initialRange = fact?.valueRange
            onCommit = vr => store.updateFact(vrPopup.nestedFactId, { valueRange: vr })
            title    = `Value Range — ${fact?.objectifiedName || 'Nested Type'}`
          } else {
            const ot = store.objectTypes.find(o => o.id === vrPopup.otId)
            initialRange = ot?.valueRange
            onCommit = vr => store.updateObjectType(vrPopup.otId, { valueRange: vr })
            title    = `Value Range — ${ot?.name || 'Object Type'}`
          }
        }
        return <ValueRangePopup title={title} initialRange={initialRange} onCommit={onCommit}
          x={vrPopup.x} y={vrPopup.y} onClose={() => setVrPopup(null)}
          naturalNumbers={vrPopup.naturalNumbers}/>
      })()}

      {store.frequencyConstruction?.stage === 3 && (() => {
        const fc = store.frequencyConstruction
        const sp = worldToScreen(fc.x, fc.y)
        return <FrequencyRangePopup
          range={fc.range ?? []}
          onChange={range => store.updateFrequencyConstructionRange(range)}
          x={sp.x} y={sp.y}
          onDone={() => store.commitFrequencyConstruction()}
          onAbort={() => { store.abandonFrequencyConstruction(); store.setTool('select') }}
        />
      })()}

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
