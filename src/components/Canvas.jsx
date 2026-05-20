import React, { useRef, useCallback, useState, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { useOrmStore } from '../store/ormStore'
import { useDiagramElements } from '../hooks/useDiagramElements'
import { useContextMenuHandlers } from '../hooks/useContextMenuHandlers'
import ObjectTypeNode, { computeOtSize, entityBounds } from './ObjectTypeNode'
import FactTypeNode, { factBounds, nestedFactBounds, makeImplicitLinkFact, ROLE_W, ROLE_H, ROLE_GAP } from './FactTypeNode'
import SubtypeArrows, { rectBorderPoint, playerBounds } from './SubtypeArrows'
import { EXTERNAL_CONSTRAINT_TYPES } from '../constants'
import ConstraintNodes from './ConstraintNodes'
import RoleConnectors, { MandatoryDots } from './RoleConnectors'
import Minimap from './Minimap'
import ContextMenu from './ContextMenu'
import ConstraintMemberLabels from './ConstraintMemberLabels'
import QueryCopies from './QueryCopies'
import NoteNode from './NoteNode'
import { ValueRangeEditor } from './Inspector'
import { isSelectionMode, isElementSelecting } from '../utils/cursorUtils'

const SNAP = 10  // grid snap in world units

function snap(v) { return Math.round(v / SNAP) * SNAP }

// Point on the boundary of a note rectangle (centered at note.x, note.y) toward (tx, ty)
function noteEdgePoint(note, tx, ty) {
  const dx = tx - note.x
  const dy = ty - note.y
  if (dx === 0 && dy === 0) return { x: note.x, y: note.y }
  const hw = note.w / 2, hh = note.h / 2
  const tX = dx !== 0 ? hw / Math.abs(dx) : Infinity
  const tY = dy !== 0 ? hh / Math.abs(dy) : Infinity
  const t = Math.min(tX, tY)
  return { x: note.x + dx * t, y: note.y + dy * t }
}

// ── Validation error badges ──────────────────────────────────────────────────
// OT badges are rendered inside ObjectTypeNode; this handles fact type and constraint badges.
const BADGE_SEV_COLOUR = { error: '#dc2626', warning: '#d97706' }
const BADGE_SEV_ICON   = { error: '✕', warning: '!' }
const BADGE_POPUP_FONT = "'Segoe UI', Helvetica, Arial, sans-serif"

function ValidationBadges({ store, visibleOts, visibleFacts, visibleConstraints, positions }) {
  const errors = store.validationErrors
  const [popup, setPopup] = useState(null)  // { clientX, clientY, elementErrors }

  useEffect(() => {
    const onUp = () => setPopup(null)
    window.addEventListener('mouseup', onUp)
    return () => window.removeEventListener('mouseup', onUp)
  }, [])

  if (!errors || errors.length === 0) return null

  const errorIds = new Set(errors.map(e => e.elementId))
  const badgeColour = (id) => errors.some(e => e.elementId === id && e.severity === 'error') ? '#dc2626' : '#d97706'
  const R = 6

  const handleMouseDown = (e, elementId) => {
    if (e.button !== 0) return
    e.stopPropagation()
    setPopup({ clientX: e.clientX, clientY: e.clientY, elementErrors: errors.filter(err => err.elementId === elementId) })
  }

  const POP_W = 260
  const pos = popup ? popupPos(popup.clientX, popup.clientY, POP_W) : null

  return (
    <>
      <g>
        {visibleOts.filter(ot => errorIds.has(ot.id)).map(ot => {
          const { w, h } = computeOtSize(ot)
          const bx = ot.x + w / 2 - 1, by = ot.y - h / 2 + 1
          return (
            <g key={ot.id} style={{ cursor: 'help', pointerEvents: 'all' }}
               onMouseDown={e => handleMouseDown(e, ot.id)}>
              <circle cx={bx} cy={by} r={R + 2} fill="transparent"/>
              <circle cx={bx} cy={by} r={R} fill={badgeColour(ot.id)}/>
              <text x={bx} y={by} textAnchor="middle" dominantBaseline="middle"
                fontSize={7} fontWeight={700} fill="#fff" style={{ pointerEvents: 'none' }}>!</text>
            </g>
          )
        })}
        {visibleFacts.filter(f => !f._implicit && errorIds.has(f.id)).map(f => {
          const p = positions[f.id]
          const fx = p?.x ?? f.x, fy = p?.y ?? f.y
          const n = Math.max(f.arity, 1)
          const isVert = (p?.orientation ?? f.orientation) === 'vertical'
          let bx, by
          if (isVert) {
            const totalH = n * ROLE_W + (n - 1) * ROLE_GAP
            bx = fx + ROLE_H / 2 + R - 1
            by = fy - totalH / 2 - R + 1
          } else {
            const totalW = n * ROLE_W + (n - 1) * ROLE_GAP
            bx = fx + totalW / 2 + R - 1
            by = fy - ROLE_H / 2 - R + 1
          }
          return (
            <g key={f.id} style={{ cursor: 'help', pointerEvents: 'all' }}
               onMouseDown={e => handleMouseDown(e, f.id)}>
              <circle cx={bx} cy={by} r={R + 2} fill="transparent"/>
              <circle cx={bx} cy={by} r={R} fill={badgeColour(f.id)}/>
              <text x={bx} y={by} textAnchor="middle" dominantBaseline="middle"
                fontSize={7} fontWeight={700} fill="#fff" style={{ pointerEvents: 'none' }}>!</text>
            </g>
          )
        })}
        {visibleConstraints.filter(c => errorIds.has(c.id)).map(c => {
          const bx = c.x + R, by = c.y - R
          return (
            <g key={c.id} style={{ cursor: 'help', pointerEvents: 'all' }}
               onMouseDown={e => handleMouseDown(e, c.id)}>
              <circle cx={bx} cy={by} r={R + 2} fill="transparent"/>
              <circle cx={bx} cy={by} r={R} fill={badgeColour(c.id)}/>
              <text x={bx} y={by} textAnchor="middle" dominantBaseline="middle"
                fontSize={7} fontWeight={700} fill="#fff" style={{ pointerEvents: 'none' }}>!</text>
            </g>
          )
        })}
      </g>
      {popup && createPortal(
        <div style={{
          position: 'fixed', ...pos, width: POP_W, maxHeight: pos.maxHeight,
          overflowY: 'auto',
          background: 'var(--bg-surface)',
          border: '1px solid var(--border)',
          borderRadius: 6,
          boxShadow: '0 4px 20px rgba(0,0,0,0.22)',
          padding: 8,
          zIndex: 10200,
          fontFamily: BADGE_POPUP_FONT,
          pointerEvents: 'none',
          userSelect: 'none',
          display: 'flex', flexDirection: 'column', gap: 4,
        }}>
          {popup.elementErrors.map(err => (
            <div key={err.id} style={{
              display: 'flex', alignItems: 'flex-start', gap: 6,
              padding: '5px 7px', borderRadius: 4,
              background: 'var(--bg-raised)',
              border: '1px solid var(--border-soft)',
              borderLeft: `3px solid ${BADGE_SEV_COLOUR[err.severity]}`,
            }}>
              <span style={{ color: BADGE_SEV_COLOUR[err.severity], fontWeight: 700, fontSize: 9, marginTop: 2, flexShrink: 0 }}>
                {BADGE_SEV_ICON[err.severity]}
              </span>
              <span style={{ fontSize: 11, color: 'var(--ink-2)', lineHeight: 1.4 }}>{err.message}</span>
            </div>
          ))}
        </div>,
        document.body
      )}
    </>
  )
}

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
  const activeHandlers = useRef(null)

  useEffect(() => {
    return () => {
      if (activeHandlers.current) {
        document.removeEventListener('mousemove', activeHandlers.current.onMove)
        document.removeEventListener('mouseup',   activeHandlers.current.onUp)
        activeHandlers.current = null
      }
    }
  }, [])

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
      activeHandlers.current = null
    }
    activeHandlers.current = { onMove, onUp }
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
  const activeDiagram = store.diagrams.find(d => d.id === store.activeDiagramId)
  const visibleNotes = activeDiagram?.notes ?? []

  // ── Note inline editing ──────────────────────────────────────────────────
  const [noteEditing, setNoteEditing] = useState(null)  // { noteId, text } | null

  const commitNoteEdit = useCallback(() => {
    if (!noteEditing) return
    store.updateNote(noteEditing.noteId, { text: noteEditing.text })
    setNoteEditing(null)
  }, [noteEditing, store])

  // ── Note "remove subject" dim state ─────────────────────────────────────
  const rsNote = store.noteRemoveSubjectDraft
    ? visibleNotes.find(n => n.id === store.noteRemoveSubjectDraft.noteId) : null
  const rsIds  = rsNote ? new Set((rsNote.connectors ?? []).map(c => c.targetId)) : null

  // "Pick a note" mode — initiated by the Note Connector tool button
  const isNotePickMode = store.tool === 'addNoteConnector'

  // ── Query edit state ─────────────────────────────────────────────────────
  const qd = store.queryEditDraft

  // ── Dim mode — non-interactive elements dimmed while a tool is active ─────
  const dimMode = (() => {
    if (qd) return null  // query edit handles its own dimming
    const { tool, linkDraft, sequenceConstruction, uniquenessConstruction, frequencyConstruction, pendingTargetPick } = store
    const objectifiedIds = new Set(visibleFacts.filter(f => f.objectified).map(f => f.id))
    const NONE = null          // null = all elements of this type are undimmed
    const ALL  = new Set()    // empty Set = all elements of this type are dimmed

    if (pendingTargetPick) {
      return { factIds: objectifiedIds, otIds: NONE, subtypesDim: true, constraintsDim: true, connectorsDim: true, impliedLinksDim: true, dimInnerFact: true }
    }
    if (tool === 'addSubtype') {
      return { factIds: objectifiedIds, otIds: NONE, subtypesDim: true, constraintsDim: true, connectorsDim: true, impliedLinksDim: true, dimInnerFact: true }
    }
    if (tool === 'assignRole') {
      if (linkDraft?.type === 'roleAssign' && linkDraft.factId != null) {
        return { factIds: new Set([...objectifiedIds, linkDraft.factId]), otIds: NONE, subtypesDim: true, constraintsDim: true, connectorsDim: true, impliedLinksDim: true, dimInnerFact: true }
      }
      return { factIds: NONE, otIds: ALL, subtypesDim: true, constraintsDim: true, connectorsDim: true, impliedLinksDim: true, dimObjectification: true }
    }
    if (tool === 'toggleMandatory') {
      return { factIds: NONE, otIds: ALL, subtypesDim: true, constraintsDim: true, connectorsDim: true, dimObjectification: true }
    }
    if (uniquenessConstruction) {
      return { factIds: new Set([uniquenessConstruction.factId]), otIds: ALL, subtypesDim: true, constraintsDim: true, connectorsDim: true, impliedLinksDim: true }
    }
    if (frequencyConstruction) {
      return { factIds: new Set([frequencyConstruction.factId]), otIds: ALL, subtypesDim: true, constraintsDim: true, connectorsDim: true, impliedLinksDim: true }
    }
    if (tool === 'addInternalUniqueness') {
      return { factIds: NONE, otIds: ALL, subtypesDim: true, constraintsDim: true, connectorsDim: true, impliedLinksDim: true }
    }
    if (tool === 'addInternalFrequency') {
      return { factIds: NONE, otIds: ALL, subtypesDim: true, constraintsDim: true, connectorsDim: true, impliedLinksDim: true }
    }
    if (sequenceConstruction) {
      return { factIds: NONE, otIds: ALL, subtypesDim: false, constraintsDim: true, connectorsDim: true }
    }
    if (tool === 'connectConstraint') {
      return { factIds: ALL, otIds: ALL, subtypesDim: true, constraintsDim: false, connectorsDim: true }
    }
    if (tool === 'addConstraint:valueRange') {
      const eligibleOtIds = new Set(
        visibleOts.filter(ot => ot.kind === 'value' || (ot.kind === 'entity' && ot.refMode && ot.refMode !== 'none')).map(ot => ot.id)
      )
      return { factIds: NONE, otIds: eligibleOtIds, subtypesDim: true, constraintsDim: true, connectorsDim: true, dimObjectification: true }
    }
    if (tool === 'addConstraint:cardinality') {
      return { factIds: NONE, otIds: NONE, subtypesDim: true, constraintsDim: true, connectorsDim: true }
    }
    return null
  })()

  const isFactDimmed  = (f)  => dimMode?.factIds != null && !dimMode.factIds.has(f.id)
  const isOtDimmed    = (ot) => dimMode?.otIds   != null && !dimMode.otIds.has(ot.id)
  const queryOpacity  = (id) => {
    if (!queryReachable) return null
    return queryReachable.has(id) ? 1 : 0.2
  }

  // During query construction: set of original IDs that are NOT selectable next (used by SubtypeArrows/RoleConnectors)
  const queryOriginals = qd ? new Set(qd.copies.map(cp => cp.originalId)) : null
  const queryReachable = (() => {
    if (!qd) return null
    if (!qd.pendingClick) return new Set()  // no first click yet — all originals dimmed

    // After first click on a copy: only originals directly reachable from its underlying original
    const pending = qd.pendingClick
    const reachable = new Set()  // intentionally empty — no 0.45 tier

    if (pending.type === 'otCopy') {
      const pendingOrigId = qd.copies.find(c => c.id === pending.id)?.originalId
      if (pendingOrigId) {
        if (store.objectTypes.some(o => o.id === pendingOrigId)) {
          store.facts.forEach(f => {
            if (!f._implicit && f.roles.some(r => r.objectTypeId === pendingOrigId))
              reachable.add(f.id)
          })
          store.subtypes.forEach(st => {
            if (st.subId === pendingOrigId || st.superId === pendingOrigId)
              reachable.add(st.subId === pendingOrigId ? st.superId : st.subId)
          })
        } else {
          // Objectified fact used as outer-frame OT click: treat as a regular OT.
          // Find facts that use this objectified fact as a role player, and OTs via subtype edges.
          store.facts.forEach(f => {
            if (!f._implicit && f.roles.some(r => r.objectTypeId === pendingOrigId))
              reachable.add(f.id)
          })
          store.subtypes.forEach(st => {
            if (st.subId === pendingOrigId || st.superId === pendingOrigId)
              reachable.add(st.subId === pendingOrigId ? st.superId : st.subId)
          })
        }
      }
    } else if (pending.type === 'factCopyRole') {
      const factOrigId = qd.copies.find(c => c.id === pending.id)?.originalId
      const fact = factOrigId ? store.facts.find(f => f.id === factOrigId) : null
      if (fact) {
        const otId = fact.roles[pending.roleIndex]?.objectTypeId
        if (otId) reachable.add(otId)
      }
    } else if (pending.type === 'subtypeCopy') {
      const stOrigId = qd.copies.find(c => c.id === pending.id)?.originalId
      const st = stOrigId ? store.subtypes.find(s => s.id === stOrigId) : null
      if (st) { reachable.add(st.subId); reachable.add(st.superId) }
    }

    return reachable
  })()

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

  // ── Note hit-testing (for connectors and remove-subject) ────────────────
  const hitTestElement = useCallback((wx, wy) => {
    for (const c of visibleConstraints) {
      if (Math.hypot(wx - c.x, wy - c.y) < 14) return c.id
    }
    for (const ot of visibleOts) {
      const { w: ow, h: oh } = computeOtSize(ot)
      if (Math.abs(wx - ot.x) < ow / 2 && Math.abs(wy - ot.y) < oh / 2) return ot.id
    }
    for (const f of visibleFacts) {
      const b = factBounds(f)
      if (wx >= b.left && wx <= b.right && wy >= b.top && wy <= b.bottom) return f.id
    }
    const diag = store.diagrams.find(d => d.id === store.activeDiagramId)
    for (const f of visibleFacts.filter(vf => vf.objectified)) {
      for (const il of (f.implicitLinks || []).filter(il => store.isImplicitLinkShown(f.id, il.roleIndex))) {
        const role   = f.roles[il.roleIndex]
        const assoc  = visibleOts.find(o => o.id === role?.objectTypeId)
                    || visibleFacts.find(vf => vf.id === role?.objectTypeId && vf.objectified)
        if (assoc) {
          const ilPos = diag?.positions[`${f.id}:il:${il.roleIndex}`]
          const ilX   = ilPos?.x ?? Math.round((f.x + assoc.x) / 2)
          const ilY   = ilPos?.y ?? Math.round((f.y + assoc.y) / 2)
          if (Math.hypot(wx - ilX, wy - ilY) < 18) return `${f.id}_il_${il.roleIndex}`
        }
      }
    }
    for (const st of visibleSubtypes) {
      const otMap     = Object.fromEntries(visibleOts.map(o => [o.id, o]))
      const nestedMap = Object.fromEntries(visibleFacts.filter(vf => vf.objectified).map(vf => [vf.id, vf]))
      const subB = playerBounds(st.subId,   otMap, nestedMap)
      const supB = playerBounds(st.superId,  otMap, nestedMap)
      if (subB && supB) {
        const from = rectBorderPoint(subB, supB.cx, supB.cy)
        const to   = rectBorderPoint(supB, subB.cx, subB.cy)
        const dx = to.x - from.x, dy = to.y - from.y
        const lenSq = dx * dx + dy * dy
        const t = lenSq === 0 ? 0 : Math.max(0, Math.min(1, ((wx - from.x) * dx + (wy - from.y) * dy) / lenSq))
        const dist = Math.hypot(wx - (from.x + t * dx), wy - (from.y + t * dy))
        if (dist < 8) return st.id
      }
    }
    return null
  }, [visibleOts, visibleFacts, visibleConstraints, visibleSubtypes, store])

  // ── Note context menu ────────────────────────────────────────────────────
  const handleNoteContextMenu = useCallback((note, e) => {
    store.select(note.id, 'note')
    setContextMenu({
      x: e.clientX, y: e.clientY,
      items: [
        { label: 'Add subject',    action: () => store.startNoteConnector(note.id) },
        { label: 'Remove subject', disabled: !(note.connectors?.length),
          action: () => store.startNoteRemoveSubject(note.id) },
        '---',
        { label: 'Remove from diagram', action: () => store.deleteNote(note.id) },
        { label: 'Delete', danger: true, action: () => store.deleteNote(note.id) },
      ],
    })
  }, [store])

  const {
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

    // Target pick mode: background click cancels it
    if (store.pendingTargetPick) { store.cancelTargetPick(); return }

    // Query edit mode: background click cancels any pending connection, but not the edit itself
    if (store.queryEditDraft) { if (e.button === 0) store.cancelQueryPendingClick(); return }

    // Selection-mode tools: no panning, cancel on background click
    if (isSelectionMode(store.tool)) {
      if (e.button === 0) {
        if (store.uniquenessConstruction) { store.abandonUniquenessConstruction() }
        if (store.frequencyConstruction) { store.abandonFrequencyConstruction() }
        if (store.sequenceConstruction) { store.abandonSequenceConstruction() }
        if (store.linkDraft) { store.clearLinkDraft() }
        store.setTool('select')
        e.preventDefault()
        return
      }
      return // ignore all other buttons in selection mode
    }

    // Sequence construction (from double-clicking constraint): cancel on background click
    if (store.sequenceConstruction && e.button === 0) {
      store.abandonSequenceConstruction()
      e.preventDefault()
      return
    }

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

    if (store.tool === 'addNote')          { store.addNote(x, y);   store.setTool('select'); return }
    if (store.tool === 'addNoteConnector') { store.setTool('select'); return }
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
    // Query edit mode: no dragging allowed
    if (store.queryEditDraft) return
    // Selection-mode tools and sequence construction handle interactions in child components; prevent fallback dragging
    if (isSelectionMode(store.tool) || store.sequenceConstruction) return

    // If we're in roleAssign mode and the drag starts on an object type,
    // start the link-draft rather than dragging the element.
    if (store.tool === 'assignRole' && kind !== 'fact' && kind !== 'constraint') {
      store.setLinkDraft({ type: 'roleAssign', objectTypeId: id })
      e.stopPropagation()
      return
    }

    // Handle implicit link drag
    if (kind === 'implicitLink') {
      const [factId, roleIndex] = id.split('_il_').map((v, i) => i === 0 ? v : Number(v))
      const parentFact = visibleFacts.find(f => f.id === factId)
      const il = parentFact?.implicitLinks?.find(l => l.roleIndex === roleIndex)
      if (!parentFact || !il) return
      const diag = store.diagrams.find(d => d.id === store.activeDiagramId)
      const positions = diag?.positions ?? {}
      const ilPos = positions[`${factId}:il:${roleIndex}`]
      const role = parentFact.roles[roleIndex]
      const associatedOtid = role?.objectTypeId
      const associatedOt = visibleOts.find(o => o.id === associatedOtid)
      const associatedNf = !associatedOt ? visibleFacts.find(f => f.id === associatedOtid && f.objectified) : null
      const defaultX = (associatedOt || associatedNf) ? Math.round((parentFact.x + (associatedOt || associatedNf).x) / 2) : parentFact.x
      const defaultY = (associatedOt || associatedNf) ? Math.round((parentFact.y + (associatedOt || associatedNf).y) / 2) : parentFact.y
      const origX = ilPos?.x ?? il.x ?? defaultX
      const origY = ilPos?.y ?? il.y ?? defaultY
      setDragState({ type: 'element', id, kind: 'implicitLink',
                     startX: e.clientX, startY: e.clientY,
                     origX, origY,
                     implicitFactId: factId, implicitRoleIndex: roleIndex })
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
        if (eid.includes('_il_')) {
          const [factId, roleIndex] = eid.split('_il_').map((v, i) => i === 0 ? v : Number(v))
          const parentFact = visibleFacts.find(f => f.id === factId)
          const il = parentFact?.implicitLinks?.find(l => l.roleIndex === roleIndex)
          if (parentFact && il) {
            const diag = store.diagrams.find(d => d.id === store.activeDiagramId)
            const positions = diag?.positions ?? {}
            const ilPos = positions[`${factId}:il:${roleIndex}`]
            const role = parentFact.roles[roleIndex]
            const associatedOtid = role?.objectTypeId
            const associatedOt = visibleOts.find(o => o.id === associatedOtid)
            const associatedNf = !associatedOt ? visibleFacts.find(f => f.id === associatedOtid && f.objectified) : null
            const defaultX = (associatedOt || associatedNf) ? Math.round((parentFact.x + (associatedOt || associatedNf).x) / 2) : parentFact.x
            const defaultY = (associatedOt || associatedNf) ? Math.round((parentFact.y + (associatedOt || associatedNf).y) / 2) : parentFact.y
            return { id: eid, kind: 'implicitLink', origX: ilPos?.x ?? il.x ?? defaultX, origY: ilPos?.y ?? il.y ?? defaultY, implicitFactId: factId, implicitRoleIndex: roleIndex }
          }
        }
        return null
      }
      const elements = multiIds.map(getPos).filter(Boolean)
      setDragState({ type: 'multiElement', startX: e.clientX, startY: e.clientY, elements })
      return
    }

    if (kind === 'note') {
      const diag = store.diagrams.find(d => d.id === store.activeDiagramId)
      const noteEl = (diag?.notes ?? []).find(n => n.id === id)
      if (!noteEl) return
      store.select(id, 'note')
      setDragState({ type: 'element', id, kind: 'note',
                     startX: e.clientX, startY: e.clientY,
                     origX: noteEl.x, origY: noteEl.y })
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
  }, [store, visibleOts, visibleFacts, visibleConstraints])

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
      else if (dragState.kind === 'implicitLink') store.updateImplicitLink(dragState.implicitFactId, dragState.implicitRoleIndex, { x: snapEnabled ? snap(wx) : wx, y: snapEnabled ? snap(wy) : wy })
      else if (dragState.kind === 'note')       store.updateNote(dragState.id, { x: snapEnabled ? snap(wx) : wx, y: snapEnabled ? snap(wy) : wy })
      else                                      store.moveObjectType(dragState.id, wx, wy)
    } else if (dragState.type === 'noteResize') {
      const newW = Math.max(80, dragState.origW + dx / store.zoom)
      const newH = Math.max(40, dragState.origH + dy / store.zoom)
      store.updateNote(dragState.noteId, { w: Math.round(newW), h: Math.round(newH) })
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
        else if (el.kind === 'implicitLink') store.updateImplicitLink(el.implicitFactId, el.implicitRoleIndex, { x: snapEnabled ? snap(wx) : wx, y: snapEnabled ? snap(wy) : wy })
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
      const nestedMap = Object.fromEntries(visibleFacts.filter(f => f.objectified).map(f => [f.id, f]))
      const diag = store.diagrams.find(d => d.id === store.activeDiagramId)
      const diagPos = diag?.positions ?? {}
      const ids = [
        ...visibleOts        .filter(o  => inBand(o.x, o.y))           .map(o  => o.id),
        ...visibleFacts      .filter(f  => boxInBand(factBounds(f)))    .map(f  => f.id),
        ...visibleConstraints.filter(c  => inBand(c.x, c.y))           .map(c  => c.id),
        ...visibleSubtypes   .filter(st => {
          const sub = visibleOts.find(o => o.id === st.subId) || nestedMap[st.subId]
          const sup = visibleOts.find(o => o.id === st.superId) || nestedMap[st.superId]
          if (!sub || !sup) return false
          return inBand((sub.x + sup.x) / 2, (sub.y + sup.y) / 2)
        }).map(st => st.id),
        ...visibleFacts.flatMap(f =>
          (f.implicitLinks || []).filter(il => {
            const ilKey = `${f.id}:il:${il.roleIndex}`
            const ilPos = diagPos[ilKey]
            const role = f.roles[il.roleIndex]
            const associatedOtid = role?.objectTypeId
            const associatedOt = visibleOts.find(o => o.id === associatedOtid)
            const associatedNf = !associatedOt ? visibleFacts.find(ff => ff.id === associatedOtid && ff.objectified) : null
            const defaultX = (associatedOt || associatedNf) ? Math.round((f.x + (associatedOt || associatedNf).x) / 2) : f.x
            const defaultY = (associatedOt || associatedNf) ? Math.round((f.y + (associatedOt || associatedNf).y) / 2) : f.y
            const ilX = ilPos?.x ?? il.x ?? defaultX
            const ilY = ilPos?.y ?? il.y ?? defaultY
            return inBand(ilX, ilY)
          }).map(il => `${f.id}_il_${il.roleIndex}`)
        ),
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
    : isElementSelecting(store.tool, store.sequenceConstruction) ? 'crosshair'
    : store.tool === 'select'
      ? (dragState?.type === 'band'         ? 'crosshair'
       : dragState?.type === 'multiElement' ? 'grabbing'
       : 'default')
    : store.tool.startsWith('add') ? 'crosshair'
    : 'default'

  // ── Shared hover-outline helper for note connector modes ─────────────────
  // Shapes, stroke-width and stroke-dasharray match the CSS .hover-ring elements
  // used in select mode. All measurements are in world units (= CSS user units
  // inside the SVG transform group), so they scale with zoom identically to the
  // CSS-driven rings.
  const noteHoverOutline = (hoverId) => {
    if (!hoverId) return null
    const color = 'rgba(64,120,200,0.55)'
    const noEvents = { pointerEvents: 'none' }

    // Object type — rect+3px pad, rx=8, strokeWidth=2, dash=4 3  (matches ObjectTypeNode hover-ring)
    const ot = visibleOts.find(o => o.id === hoverId)
    if (ot) {
      const b = entityBounds(ot)
      return <rect fill="none" stroke={color} strokeWidth={2} strokeDasharray="4 3" style={noEvents}
        x={b.left - 3} y={b.top - 3} width={b.right - b.left + 6} height={b.bottom - b.top + 6} rx={8}/>
    }

    // Fact / nested OT — tight rect around role boxes only (matches FactTypeNode line 1733)
    const f = visibleFacts.find(vf => vf.id === hoverId)
    if (f) {
      const n     = f.arity
      const isVert = f.orientation === 'vertical'
      const span  = n * ROLE_W + (n - 1) * ROLE_GAP   // same formula for both axes
      if (isVert) {
        const lx = f.x - ROLE_H / 2, ty = f.y - span / 2
        return <rect fill="none" stroke={color} strokeWidth={2} strokeDasharray="4 3" style={noEvents}
          x={lx - 3} y={ty - 3} width={ROLE_H + 6} height={span + 6} rx={2}/>
      } else {
        const lx = f.x - span / 2, ty = f.y - ROLE_H / 2
        return <rect fill="none" stroke={color} strokeWidth={2} strokeDasharray="4 3" style={noEvents}
          x={lx - 3} y={ty - 3} width={span + 6} height={ROLE_H + 6} rx={2}/>
      }
    }

    // External constraint — circle matching ConstraintNodes hover-ring radius (+4px)
    const c = visibleConstraints.find(vc => vc.id === hoverId)
    if (c) {
      const r = (EXTERNAL_CONSTRAINT_TYPES.has(c.constraintType) && c.constraintType !== 'ring' ? 10 : 14) + 4
      return <circle fill="none" stroke={color} strokeWidth={2} strokeDasharray="4 3" style={noEvents}
        cx={c.x} cy={c.y} r={r}/>
    }

    // Subtype — thick dashed line along the arrow (matches SubtypeArrows hover-ring line,
    // which uses inline strokeWidth=10 world-units and CSS stroke-dasharray=4 3)
    const st = visibleSubtypes.find(s => s.id === hoverId)
    if (st) {
      const otMap     = Object.fromEntries(visibleOts.map(o => [o.id, o]))
      const nestedMap = Object.fromEntries(visibleFacts.filter(vf => vf.objectified).map(vf => [vf.id, vf]))
      const subB = playerBounds(st.subId,   otMap, nestedMap)
      const supB = playerBounds(st.superId,  otMap, nestedMap)
      if (subB && supB) {
        const from    = rectBorderPoint(subB, supB.cx, supB.cy)
        const to      = rectBorderPoint(supB, subB.cx, subB.cy)
        const arrowLen = 4 * 4.5
        const edgeDx  = to.x - from.x, edgeDy = to.y - from.y
        const edgeDist = Math.sqrt(edgeDx * edgeDx + edgeDy * edgeDy)
        const lineEnd  = edgeDist > arrowLen
          ? { x: to.x - edgeDx / edgeDist * arrowLen, y: to.y - edgeDy / edgeDist * arrowLen }
          : to
        return <line fill="none" stroke={color} strokeWidth={10} strokeDasharray="4 3" style={noEvents}
          x1={from.x} y1={from.y} x2={lineEnd.x} y2={lineEnd.y}/>
      }
    }

    return null
  }

  return (
    <div style={{ flex: 1, position: 'relative', overflow: 'hidden' }}>
      <svg
        ref={svgRef}
        id="orm2-canvas-svg"
        className={qd ? 'query-edit' : store.tool === 'select' ? 'tool-select' : undefined}
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
          <marker id="arrowSubtypeQueryIn" markerWidth="4.5" markerHeight="4.5" refX="0.25" refY="2" orient="auto">
            <path d="M 0.25 0.25 L 4.25 2 L 0.25 3.75 Z" fill="var(--col-query-in)" stroke="none"/>
          </marker>
          <marker id="arrowSubtypeCopy" markerWidth="4.5" markerHeight="4.5" refX="0.25" refY="2" orient="auto">
            <path d="M 0.25 0.25 L 4.25 2 L 0.25 3.75 Z" fill="#15803d" stroke="none"/>
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
          {/* Note connectors — rendered below notes so notes sit on top */}
          {visibleNotes.flatMap(note => (note.connectors ?? []).map(conn => {
            let tx, ty
            const tid = conn.targetId
            if (tid.includes('_il_')) {
              const [fid, riStr] = tid.split('_il_')
              const pf  = visibleFacts.find(f => f.id === fid)
              const il  = pf?.implicitLinks?.find(l => l.roleIndex === Number(riStr))
              const assoc = pf ? (visibleOts.find(o => o.id === pf.roles[Number(riStr)]?.objectTypeId)
                              || visibleFacts.find(f => f.id === pf.roles[Number(riStr)]?.objectTypeId)) : null
              if (pf && assoc) {
                const ilPos = activeDiagram?.positions[`${fid}:il:${Number(riStr)}`]
                tx = ilPos?.x ?? Math.round((pf.x + assoc.x) / 2)
                ty = ilPos?.y ?? Math.round((pf.y + assoc.y) / 2)
              }
            } else {
              const tgt = visibleOts.find(o => o.id === tid)
                || visibleFacts.find(f => f.id === tid)
                || visibleConstraints.find(c => c.id === tid)
              if (tgt) { tx = tgt.x; ty = tgt.y }
              else {
                const st  = visibleSubtypes.find(s => s.id === tid)
                if (st) {
                  const sub = visibleOts.find(o => o.id === st.subId)  || visibleFacts.find(f => f.id === st.subId)
                  const sup = visibleOts.find(o => o.id === st.superId) || visibleFacts.find(f => f.id === st.superId)
                  if (sub && sup) { tx = (sub.x + sup.x) / 2; ty = (sub.y + sup.y) / 2 }
                }
              }
            }
            if (tx == null) return null
            const ep = noteEdgePoint(note, tx, ty)
            return (
              <line key={conn.id}
                x1={ep.x} y1={ep.y} x2={tx} y2={ty}
                stroke="#b8a040" strokeWidth={1 / store.zoom}
                strokeDasharray={`${5 / store.zoom} ${3 / store.zoom}`}
                style={{ pointerEvents: 'none' }}
              />
            )
          }))}

          {/* Notes render beneath diagram elements */}
          {visibleNotes.map(note => (
            <g key={note.id} opacity={rsIds && !rsIds.has(note.id) ? 0.15 : 1}>
              <NoteNode
                note={note}
                selected={store.selectedId === note.id && store.selectedKind === 'note'}
                onDragStart={handleDragStart}
                onResizeStart={(noteId, e) => {
                  setDragState({ type: 'noteResize', noteId,
                                 startX: e.clientX, startY: e.clientY,
                                 origW: note.w, origH: note.h })
                }}
                onDoubleClick={noteId => {
                  const n = visibleNotes.find(vn => vn.id === noteId)
                  if (n) setNoteEditing({ noteId, text: n.text })
                }}
                onContextMenu={handleNoteContextMenu}
              />
            </g>
          ))}
          <g opacity={store.queryIndexHighlight && !qd ? 0.2 : 1} style={store.queryIndexHighlight && !qd ? { pointerEvents: 'none' } : undefined}>
          <g style={(dimMode?.subtypesDim) ? { pointerEvents: 'none' } : undefined}>
            <SubtypeArrows mousePos={mousePos} onContextMenu={handleSubtypeContextMenu} dimAllSubtypes={dimMode?.subtypesDim ?? false} queryReachable={queryReachable} queryOriginals={queryOriginals} noteSubjectIds={isNotePickMode ? new Set() : rsIds}/>
          </g>
          {visibleFacts.map(f => {
            const factDimmed = isFactDimmed(f) || (rsIds != null && !rsIds.has(f.id)) || isNotePickMode
            const factOpacity = factDimmed ? (rsIds != null ? 0.12 : 0.35) : (queryOpacity(f.id) ?? 1)
            return (
            <g key={f.id} opacity={factOpacity < 1 ? factOpacity : 1} style={factOpacity <= 0.2 ? { pointerEvents: 'none' } : undefined}>
            <FactTypeNode fact={f} onDragStart={handleDragStart}
              dimObjectification={!!(f.objectified && dimMode?.dimObjectification)}
              dimInnerFact={!!(f.objectified && dimMode?.dimInnerFact)}
              dimInternalConstraints={!!store.noteConnectorDraft || (rsIds != null && rsIds.has(f.id))}
              isShared={sharedIds.has(f.id)}
              visibleConstraints={visibleConstraints}
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
            </g>
            )
          })}
           {visibleFacts.filter(f => f.objectified).map(f =>
              (f.implicitLinks || []).filter(il => store.isImplicitLinkShown(f.id, il.roleIndex)).map(il => {
                 const synth = makeImplicitLinkFact(f, il)
                 const ilDimmed = (dimMode?.factIds != null && !dimMode.factIds.has(f.id)) || dimMode?.impliedLinksDim
                   || queryReachable != null
                return (
                  <g key={synth.id} opacity={ilDimmed ? 0.2 : 1}
                    style={ilDimmed ? { pointerEvents: 'none' } : undefined}>
                    <FactTypeNode fact={synth}
                      onDragStart={(id, kind, e) => handleDragStart(id, 'implicitLink', e)}
                      isShared={false}
                      visibleConstraints={visibleConstraints}
                      onContextMenu={(e) => handleImplicitLinkContextMenu(f.id, il.roleIndex, e)}
                      onBarContextMenu={(ui, e) => handleImplicitLinkBarContextMenu(f, il, ui, e)}/>
                  </g>
               )
             })
           )}
          <g opacity={(rsIds != null || !!store.noteConnectorDraft || isNotePickMode) ? 0.12 : dimMode?.connectorsDim ? 0.35 : 1} style={(dimMode?.connectorsDim || !!qd) ? { pointerEvents: 'none' } : undefined}>
            <RoleConnectors mousePos={mousePos} queryReachable={queryReachable} queryOriginals={queryOriginals}/>
          </g>
          {visibleOts.map(ot => {
            const otDimmed = isOtDimmed(ot) || (rsIds != null && !rsIds.has(ot.id)) || isNotePickMode
            const otOpacity = otDimmed ? (rsIds != null ? 0.12 : 0.35) : (queryOpacity(ot.id) ?? 1)
            return (
            <g key={ot.id} opacity={otOpacity < 1 ? otOpacity : 1} style={otOpacity <= 0.2 ? { pointerEvents: 'none' } : undefined}>
            <ObjectTypeNode objectType={ot}
              onDragStart={handleDragStart}
              mousePos={mousePos}
              isShared={sharedIds.has(ot.id)}
              dimInternalConstraints={!!store.noteConnectorDraft || (rsIds != null && rsIds.has(ot.id))}
              onContextMenu={(e) => handleOtContextMenu(ot, e)}
              onDoubleClickValueRange={(cx, cy) => handleOtValueRangeClick(ot, cx, cy)}
              onValueRangeClick={(cx, cy) => handleOtValueRangeClick(ot, cx, cy)}
              onCardinalityRangeClick={(cx, cy) => handleOtCardinalityRangeClick(ot, cx, cy)}
              onValueRangeContextMenu={(e) => handleOtValueRangeContextMenu(ot, e)}
              onCardinalityRangeContextMenu={(e) => handleOtCardinalityRangeContextMenu(ot, e)}/>
            </g>
            )
          })}
          <g opacity={(rsIds != null || !!store.noteConnectorDraft || isNotePickMode) ? 0.12 : dimMode?.connectorsDim ? 0.35 : 1} style={(dimMode?.connectorsDim || !!qd) ? { pointerEvents: 'none' } : undefined}>
            <MandatoryDots onContextMenu={handleMandatoryDotContextMenu} queryReachable={queryReachable} queryOriginals={queryOriginals}/>
          </g>
          <g opacity={(qd || dimMode?.constraintsDim) ? 0.35 : 1} style={(dimMode?.constraintsDim || !!qd) ? { pointerEvents: 'none' } : undefined}>
            <ConstraintNodes onDragStart={handleDragStart} mousePos={mousePos}
              onContextMenu={handleConstraintContextMenu}
              noteSubjectIds={isNotePickMode ? new Set() : rsIds}/>
          </g>
          <ConstraintMemberLabels/>
          <ValidationBadges store={store} visibleOts={visibleOts} visibleFacts={visibleFacts} visibleConstraints={visibleConstraints} positions={store.diagrams.find(d => d.id === store.activeDiagramId)?.positions ?? {}}/>
          </g>{/* end previewDim wrapper */}
          {(qd || store.queryIndexHighlight) && <QueryCopies
            mousePos={mousePos}
            onCopyClick={target => store.queryEditClick(target)}
            onCopyContextMenu={(e, copyId, isProtected, isAtDefault) => {
              setContextMenu({
                x: e.clientX, y: e.clientY,
                items: [
                  { label: 'Reset position', disabled: isAtDefault, action: () => store.resetQueryCopyPosition(copyId) },
                  '---',
                  { label: 'Remove copy', danger: !isProtected, disabled: isProtected, action: () => store.removeQueryCopy(copyId) },
                ],
              })
            }}
          />}

          {/* Note connector draft — rubber-band line, hover outline + transparent click overlay */}
          {store.noteConnectorDraft && (() => {
            const srcNote = visibleNotes.find(n => n.id === store.noteConnectorDraft.noteId)
            if (!srcNote) return null
            const ep = mousePos ? noteEdgePoint(srcNote, mousePos.x, mousePos.y) : null
            const hoverId = hitTestElement(mousePos.x, mousePos.y)
            return (
              <>
                {ep && mousePos && (
                  <line x1={ep.x} y1={ep.y} x2={mousePos.x} y2={mousePos.y}
                    stroke="#b8a040" strokeWidth={1 / store.zoom}
                    strokeDasharray={`${5 / store.zoom} ${3 / store.zoom}`}
                    style={{ pointerEvents: 'none' }}
                  />
                )}
                {noteHoverOutline(hoverId)}
                <rect x={-50000} y={-50000} width={100000} height={100000}
                  fill="rgba(0,0,0,0)"
                  style={{ cursor: hoverId ? 'pointer' : 'crosshair', pointerEvents: 'all' }}
                  onMouseDown={e => {
                    if (e.button !== 0) return
                    e.stopPropagation()
                    const { x: wx, y: wy } = screenToWorld(e.clientX, e.clientY)
                    const targetId = hitTestElement(wx, wy)
                    if (targetId) store.addNoteConnector(store.noteConnectorDraft.noteId, targetId)
                    else store.cancelNoteConnector()
                  }}
                />
              </>
            )
          })()}

          {/* Note remove-subject mode — hover outline + click handler */}
          {store.noteRemoveSubjectDraft && rsNote && (() => {
            const hoverId = (() => {
              const id = hitTestElement(mousePos.x, mousePos.y)
              return (id && rsIds?.has(id)) ? id : null
            })()
            return (
              <>
                {noteHoverOutline(hoverId)}
                <rect x={-50000} y={-50000} width={100000} height={100000}
                  fill="rgba(0,0,0,0)"
                  style={{ cursor: hoverId ? 'pointer' : 'default', pointerEvents: 'all' }}
                  onMouseDown={e => {
                    if (e.button !== 0) return
                    e.stopPropagation()
                    const { x: wx, y: wy } = screenToWorld(e.clientX, e.clientY)
                    const targetId = hitTestElement(wx, wy)
                    if (targetId && rsIds?.has(targetId)) {
                      const conn = rsNote.connectors.find(c => c.targetId === targetId)
                      if (conn) store.removeNoteConnector(rsNote.id, conn.id)
                    }
                    store.cancelNoteRemoveSubject()
                  }}
                />
              </>
            )
          })()}

          {/* Note-pick mode — dim everything except notes; hover outline + click to pick */}
          {isNotePickMode && (() => {
            const hovered = visibleNotes.find(n =>
              mousePos.x >= n.x - n.w / 2 && mousePos.x <= n.x + n.w / 2 &&
              mousePos.y >= n.y - n.h / 2 && mousePos.y <= n.y + n.h / 2
            ) ?? null
            return (
              <>
                {hovered && (
                  <rect fill="none" stroke="rgba(64,120,200,0.55)" strokeWidth={2}
                    strokeDasharray="4 3" style={{ pointerEvents: 'none' }}
                    x={hovered.x - hovered.w / 2 - 3} y={hovered.y - hovered.h / 2 - 3}
                    width={hovered.w + 6} height={hovered.h + 6} rx={4}
                  />
                )}
                <rect x={-50000} y={-50000} width={100000} height={100000}
                  fill="rgba(0,0,0,0)"
                  style={{ cursor: hovered ? 'pointer' : 'default', pointerEvents: 'all' }}
                  onMouseDown={e => {
                    if (e.button !== 0) return
                    e.stopPropagation()
                    const { x: wx, y: wy } = screenToWorld(e.clientX, e.clientY)
                    const picked = visibleNotes.find(n =>
                      wx >= n.x - n.w / 2 && wx <= n.x + n.w / 2 &&
                      wy >= n.y - n.h / 2 && wy <= n.y + n.h / 2
                    )
                    if (picked) store.startNoteConnector(picked.id)
                    store.setTool('select')
                  }}
                />
              </>
            )
          })()}

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

      {/* Note inline editing textarea — absolutely positioned over the note */}
      {noteEditing && (() => {
        const note = visibleNotes.find(n => n.id === noteEditing.noteId)
        if (!note) return null
        const FOLD = 16
        const left   = (note.x - note.w / 2) * store.zoom + store.pan.x
        const top    = (note.y - note.h / 2) * store.zoom + store.pan.y
        const width  = (note.w - FOLD) * store.zoom
        const height = note.h * store.zoom
        return (
          <>
            {/* Click-outside backdrop — commits the edit when user clicks off the note */}
            <div
              style={{ position: 'absolute', inset: 0, zIndex: 49 }}
              onMouseDown={commitNoteEdit}
            />
            <textarea
            autoFocus
            value={noteEditing.text}
            onChange={e => setNoteEditing(prev => ({ ...prev, text: e.target.value }))}
            onKeyDown={e => {
              if (e.key === 'Escape') { setNoteEditing(null); return }
              e.stopPropagation()
            }}
            style={{
              position: 'absolute',
              left: Math.round(left), top: Math.round(top),
              width: Math.round(width), height: Math.round(height),
              fontSize: Math.round(11 * store.zoom),
              fontFamily: "'Segoe UI', Helvetica, Arial, sans-serif",
              lineHeight: 1.4,
              background: '#fffde7',
              border: 'none',
              outline: '2px solid var(--accent)',
              resize: 'none',
              padding: `${Math.round(7 * store.zoom)}px ${Math.round(7 * store.zoom)}px`,
              color: '#333',
              zIndex: 50,
              boxSizing: 'border-box',
              borderRadius: 0,
            }}
          />
          </>
        )
      })()}

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
