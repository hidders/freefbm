import React, { useCallback, useState, useRef, useEffect } from 'react'
import { useOrmStore } from '../store/ormStore'

const OT_FONT       = "'Segoe UI', Helvetica, Arial, sans-serif"
const OT_SIZE_NAME  = 18
const OT_SIZE_REF   = 12
const OT_PAD_X      = 8    // horizontal padding each side
const OT_MIN_W      = 60
const OT_H_SINGLE   = 32   // box height with name only
const OT_H_DOUBLE   = 48   // box height with name + reference mode

function formatRangeSpec(spec) {
  if (!spec) return ''
  if (spec.type === 'single') return String(spec.value ?? '')
  if (spec.type === 'lower')  return `${spec.lower ?? ''}..`
  if (spec.type === 'upper')  return `..${spec.upper ?? ''}`
  if (spec.type === 'range')  return `${spec.lower ?? ''}..${spec.upper ?? ''}`
  return ''
}

export function formatValueRange(range) {
  if (!range || range.length === 0) return null
  const parts = range.map(formatRangeSpec).filter(Boolean)
  return parts.length ? '{' + parts.join(', ') + '}' : null
}

let _canvas = null
function measureText(text, fontSize) {
  if (!_canvas) _canvas = document.createElement('canvas')
  const ctx = _canvas.getContext('2d')
  ctx.font = `${fontSize}px ${OT_FONT}`
  return ctx.measureText(text).width
}

export function computeOtSize(ot, nameOverride) {
  const showRefMode = useOrmStore.getState().showReferenceMode
  const hasRef = showRefMode && ot.kind === 'entity' && ot.refMode && ot.refMode !== 'none'
  const nameW  = measureText(nameOverride ?? ot.name ?? '', OT_SIZE_NAME)
  const refW   = hasRef ? measureText(`(${ot.refMode})`, OT_SIZE_REF) : 0
  const w = Math.max(OT_MIN_W, Math.max(nameW, refW) + OT_PAD_X * 2)
  const h = hasRef ? OT_H_DOUBLE : OT_H_SINGLE
  return { w, h }
}

export function entityBounds(ot) {
  const { w, h } = computeOtSize(ot)
  return { left: ot.x - w / 2, right: ot.x + w / 2,
           top:  ot.y - h / 2, bottom: ot.y + h / 2,
           cx: ot.x, cy: ot.y }
}

export default function ObjectTypeNode({ objectType: ot, onDragStart, mousePos, onContextMenu, isShared }) {
  const store = useOrmStore()
  const isSelected    = store.selectedId === ot.id || store.multiSelectedIds.includes(ot.id)
  const isSubtypeTool      = store.tool === 'addSubtype'
  const isAssignTool       = store.tool === 'assignRole'
  const isDraftFrom        = store.linkDraft?.type === 'subtype' && store.linkDraft.fromId === ot.id
  const hasDraft           = store.linkDraft?.type === 'roleAssign' && store.linkDraft.factId != null
  const isTargetCandidate  = store.tool === 'addTargetConnector' && store.linkDraft?.type === 'targetConnector'

  const [editing, setEditing]       = useState(false)
  const [draft, setDraft]           = useState('')
  const [editingRef, setEditingRef] = useState(false)
  const [draftRef, setDraftRef]     = useState('')
  const inputRef             = useRef(null)
  const inputRefRef          = useRef(null)

  const vrDragRef   = useRef(null)

  const [vrLive, setVrLive] = useState(null) // { dx, dy } | null

  useEffect(() => {
    const onMove = (e) => {
      const d = vrDragRef.current
      if (!d) return
      const zoom = useOrmStore.getState().zoom
      const dx = d.origDx + (e.clientX - d.startX) / zoom
      const dy = d.origDy + (e.clientY - d.startY) / zoom
      setVrLive({ dx, dy })
    }
    const onUp = (e) => {
      const d = vrDragRef.current
      if (!d) return
      const zoom = useOrmStore.getState().zoom
      const dx = d.origDx + (e.clientX - d.startX) / zoom
      const dy = d.origDy + (e.clientY - d.startY) / zoom
      useOrmStore.getState().updateObjectType(ot.id, { valueRangeOffset: { dx, dy } })
      vrDragRef.current = null
      setVrLive(null)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup',   onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup',   onUp)
    }
  }, [ot.id])

  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus()
      inputRef.current.select()
    }
  }, [editing])

  useEffect(() => {
    if (editingRef && inputRefRef.current) {
      inputRefRef.current.focus()
      inputRefRef.current.select()
    }
  }, [editingRef])

  const commitEdit = useCallback(() => {
    const trimmed = draft.trim()
    if (trimmed) store.updateObjectType(ot.id, { name: trimmed })
    setEditing(false)
  }, [draft, ot.id, store])

  const commitRefEdit = useCallback(() => {
    const trimmed = draftRef.trim()
    if (trimmed) store.updateObjectType(ot.id, { refMode: trimmed })
    setEditingRef(false)
  }, [draftRef, ot.id, store])

  // Stop editing when the node is deselected
  useEffect(() => {
    if (!isSelected) {
      if (editing) commitEdit()
      if (editingRef) commitRefEdit()
    }
  }, [isSelected]) // eslint-disable-line react-hooks/exhaustive-deps

  // Commit name edit when user clicks outside the foreignObject
  useEffect(() => {
    if (!editing) return
    const onDown = (e) => { if (!e.target.closest?.('foreignObject')) commitEdit() }
    window.addEventListener('mousedown', onDown, true)
    return () => window.removeEventListener('mousedown', onDown, true)
  }, [editing, commitEdit])

  // Commit ref-mode edit when user clicks outside the foreignObject
  useEffect(() => {
    if (!editingRef) return
    const onDown = (e) => { if (!e.target.closest?.('foreignObject')) commitRefEdit() }
    window.addEventListener('mousedown', onDown, true)
    return () => window.removeEventListener('mousedown', onDown, true)
  }, [editingRef, commitRefEdit])

  const { w, h } = computeOtSize(ot, editing ? draft : undefined)
  const hasRef = ot.kind === 'entity' && store.showReferenceMode && ot.refMode && ot.refMode !== 'none'
  const refModeText = hasRef ? `(${ot.refMode})` : null

  const handleDoubleClick = useCallback((e) => {
    if (isSubtypeTool || isAssignTool) return
    e.stopPropagation()
    const inRefArea = hasRef && e.target?.getAttribute?.('data-refhit') === 'true'
    if (inRefArea) {
      setDraftRef(ot.refMode ?? '')
      setEditingRef(true)
    } else {
      setDraft(ot.name)
      setEditing(true)
    }
  }, [ot.name, ot.refMode, isSubtypeTool, isAssignTool, hasRef])

  const handleMouseDown = useCallback((e) => {
    if (editing || editingRef) { e.stopPropagation(); return }
    e.stopPropagation()
    if (e.button !== 0) return

    if (isSubtypeTool) {
      if (!store.linkDraft) {
        store.setLinkDraft({ type: 'subtype', fromId: ot.id })
      } else if (store.linkDraft.fromId !== ot.id) {
        store.addSubtype(store.linkDraft.fromId, ot.id)
        store.clearLinkDraft()
        store.setTool('select')
      }
      return
    }

    if (store.tool === 'connectConstraint') { store.clearSelection(); store.setTool('select'); return }
    if (store.tool === 'toggleMandatory' || store.tool === 'addInternalUniqueness') { store.setTool('select'); return }
    if (store.tool === 'addTargetConnector') {
      const draft = store.linkDraft
      if (draft?.type === 'targetConnector' && draft?.constraintId) {
        store.updateConstraint(draft.constraintId, { targetObjectTypeId: ot.id })
        store.clearLinkDraft()
        store.setTool('select')
      }
      return
    }
    if (isAssignTool) {
      const draft = store.linkDraft
      if (draft?.factId != null && draft?.roleIndex != null) {
        store.assignObjectTypeToRole(draft.factId, draft.roleIndex, ot.id)
        const autoReturn = draft?.autoReturn
        store.clearLinkDraft()
        if (autoReturn) store.setTool('select')
      } else {
        store.setTool('select')
      }
      return
    }

    if (e.shiftKey) {
      store.shiftSelect(ot.id)
      return
    }
    store.select(ot.id, ot.kind)
    onDragStart(ot.id, ot.kind, e)
  }, [store, ot, onDragStart, isSubtypeTool, isAssignTool, editing, editingRef])

  const isSubtypeCandidate = isSubtypeTool && !isDraftFrom

  const stroke = isSelected          ? 'var(--accent)'
    : isDraftFrom                    ? 'var(--col-subtype)'
    : isSubtypeCandidate             ? 'var(--col-candidate)'
    : hasDraft                       ? 'var(--col-candidate)'
    : isTargetCandidate              ? 'var(--col-candidate)'
    : ot.kind === 'entity'           ? 'var(--col-entity)'
    :                                  'var(--col-value)'

  const strokeW = (isSelected || isDraftFrom) ? 2.5 : (isSubtypeCandidate || hasDraft || isTargetCandidate) ? 2 : 1.5
  const fill    = (hasDraft || isSubtypeCandidate || isTargetCandidate) ? 'var(--fill-candidate)'
    :                                  '#ffffff'

  // Text vertical positions
  // Single line: name centred in box
  // Two lines: name and ref centred together as a block
  const nameY = refModeText ? ot.y - 8 : ot.y
  const refY  = ot.y + 11

  return (
    <g
      onMouseDown={handleMouseDown}
      onDoubleClick={handleDoubleClick}
      onContextMenu={onContextMenu}
      style={{ cursor: isSubtypeTool || isAssignTool || isTargetCandidate ? 'cell' : editing ? 'text' : 'grab' }}
      filter={isSelected || isDraftFrom || hasDraft ? 'url(#selectGlow)' : isShared ? 'url(#sharedGlow)' : undefined}
    >
      <rect x={ot.x - w/2} y={ot.y - h/2} width={w} height={h} rx={6}
        fill={fill} stroke={stroke} strokeWidth={strokeW}
        strokeDasharray={ot.kind === 'value' ? '6 3' : 'none'}/>

      {editing ? (
        <foreignObject x={ot.x - w/2 + 2} y={nameY - OT_SIZE_NAME * 0.75}
          width={w - 4} height={OT_SIZE_NAME * 1.5}>
          <input
            ref={inputRef}
            value={draft}
            onChange={e => setDraft(e.target.value)}
            onBlur={commitEdit}
            onKeyDown={e => {
              if (e.key === 'Enter') { e.preventDefault(); commitEdit() }
              if (e.key === 'Escape') { e.stopPropagation(); setEditing(false) }
            }}
            onMouseDown={e => e.stopPropagation()}
            style={{
              width: '100%',
              height: '100%',
              border: 'none',
              outline: 'none',
              background: 'transparent',
              textAlign: 'center',
              fontSize: OT_SIZE_NAME,
              fontFamily: OT_FONT,
              color: ot.kind === 'entity' ? 'var(--col-entity)' : 'var(--col-value)',
              padding: 0,
            }}
          />
        </foreignObject>
      ) : (
        <text x={ot.x} y={nameY}
          textAnchor="middle" dominantBaseline="middle"
          fill={ot.kind === 'entity' ? 'var(--col-entity)' : 'var(--col-value)'}
          fontSize={OT_SIZE_NAME} fontFamily={OT_FONT}
          style={{ pointerEvents: 'none' }}>
          {ot.name}
        </text>
      )}

      {refModeText && (
        editingRef ? (
          <foreignObject x={ot.x - w/2 + 2} y={refY - OT_SIZE_REF * 0.75}
            width={w - 4} height={OT_SIZE_REF * 1.5}>
            <input
              ref={inputRefRef}
              value={draftRef}
              onChange={e => setDraftRef(e.target.value)}
              onBlur={commitRefEdit}
              onKeyDown={e => {
                if (e.key === 'Enter') { e.preventDefault(); commitRefEdit() }
                if (e.key === 'Escape') { e.stopPropagation(); setEditingRef(false) }
              }}
              onMouseDown={e => e.stopPropagation()}
              style={{
                width: '100%',
                height: '100%',
                border: 'none',
                outline: 'none',
                background: 'transparent',
                textAlign: 'center',
                fontSize: OT_SIZE_REF,
                fontFamily: OT_FONT,
                color: 'var(--ink-3)',
                padding: 0,
              }}
            />
          </foreignObject>
        ) : (
          <>
            <text x={ot.x} y={refY}
              textAnchor="middle" dominantBaseline="middle"
              fill="var(--ink-3)" fontSize={OT_SIZE_REF} fontFamily={OT_FONT}
              style={{ pointerEvents: 'none' }}>
              {refModeText}
            </text>
            {/* Transparent hit area — data-refhit lets the g dblclick handler know origin */}
            <rect x={ot.x - w/2} y={refY - 9} width={w} height={18}
              fill="transparent" data-refhit="true"
              style={{ cursor: 'text', pointerEvents: 'all' }}/>
          </>
        )
      )}

      {(() => {
        const vr = formatValueRange(ot.valueRange)
        if (!vr) return null
        const AUTO_DX = 0
        const AUTO_DY = h / 2 + 14
        const off = vrLive ?? (ot.valueRangeOffset ?? { dx: AUTO_DX, dy: AUTO_DY })
        const tx = ot.x + off.dx
        const ty = ot.y + off.dy
        return (
          <text x={tx} y={ty}
            textAnchor="middle" dominantBaseline="middle"
            fill="var(--col-constraint)" fontSize={11} fontFamily={OT_FONT}
            style={{ cursor: vrLive ? 'grabbing' : 'grab', userSelect: 'none' }}
            onMouseDown={e => {
              e.stopPropagation()
              vrDragRef.current = { startX: e.clientX, startY: e.clientY, origDx: off.dx, origDy: off.dy }
              setVrLive({ dx: off.dx, dy: off.dy })
            }}>
            {vr}
          </text>
        )
      })()}
    </g>
  )
}
