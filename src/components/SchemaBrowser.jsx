import React, { useState, useRef, useCallback, useEffect } from 'react'
import { useOrmStore } from '../store/ormStore'
import { BOTTOM_PANEL_TAB_STRIP_H } from '../constants.js'
import { useDiagramElements } from '../hooks/useDiagramElements'
import {
  EntityTypeIcon, ValueTypeIcon, NestedFactTypeIcon, FactTypeIcon, SubtypeIcon,
  UniquenessConstraintIcon, InclusiveOrConstraintIcon, ExclusionConstraintIcon, SubtypeConstraintIcon,
  EqualityConstraintIcon, SubsetConstraintIcon, RingConstraintIcon, FrequencyConstraintIcon,
  ValueComparisonConstraintIcon, NoteIcon,
} from './ToolPanel'

const FONT = "'Segoe UI', Helvetica, Arial, sans-serif"

const MIN_W  = 180
const MIN_H  = 120
const MAX_W  = 640
const MAX_H  = 900
const HDR_H  = 24
const INIT_W = 240
const INIT_H = 400

// ── helpers ───────────────────────────────────────────────────────────────────


const CONSTRAINT_ICON_MAP = {
  uniqueness:      <UniquenessConstraintIcon />,
  inclusiveOr:     <InclusiveOrConstraintIcon />,
  exclusion:       <ExclusionConstraintIcon />,
  exclusiveOr:     <SubtypeConstraintIcon />,
  equality:        <EqualityConstraintIcon />,
  subset:          <SubsetConstraintIcon />,
  ring:            <RingConstraintIcon />,
  frequency:       <FrequencyConstraintIcon />,
  valueComparison: <ValueComparisonConstraintIcon />,
}

// Returns the set of diagram IDs that contain an element
function diagramsContaining(elementId, diagrams) {
  return diagrams.filter(d => d.occurrences?.some(o => o.schemaElementId === elementId))
}

function subtypeDiagramsContaining(st, diagrams) {
  return diagrams.filter(d =>
    d.occurrences?.some(o => o.schemaElementId === st.subId) &&
    d.occurrences?.some(o => o.schemaElementId === st.superId)
  )
}

// ── sub-components ────────────────────────────────────────────────────────────

function FactLabel({ fact, otMap }) {
  const parts = fact.readingParts || []
  const n = fact.arity
  const hasAnyPart = parts.some(p => p?.trim())
  if (!hasAnyPart) {
    return <span style={{ fontStyle: 'italic', color: 'var(--ink-muted)', fontSize: 11 }}>
      {fact.objectifiedName || fact.name || `(${n}-ary fact)`}
    </span>
  }
  const tokens = []
  for (let i = 0; i <= n; i++) {
    const seg = parts[i]?.trim()
    if (seg) tokens.push(<span key={`s${i}`} style={{ color: '#2a7a2a' }}>{seg}</span>)
    if (i < n) {
      const name = otMap[fact.roles[i]?.objectTypeId]?.name || '?'
      tokens.push(<span key={`r${i}`} style={{ color: '#7c4dbd', fontWeight: 700 }}>{name}</span>)
    }
  }
  return <span style={{ display: 'inline-flex', flexWrap: 'wrap', gap: '0.25em', fontSize: 11 }}>{tokens}</span>
}

function OrphanBadge() {
  return (
    <span title="Not in any diagram" style={{
      fontSize: 8, color: 'var(--danger)', border: '1px solid var(--danger)',
      borderRadius: 3, padding: '0 3px', lineHeight: '13px',
      flexShrink: 0, marginLeft: 3,
    }}>orphan</span>
  )
}

function LinkBadge() {
  return (
    <span title="Implied link" style={{
      fontSize: 8, color: 'var(--ink-muted)', border: '1px solid var(--border)',
      borderRadius: 3, padding: '0 3px', lineHeight: '13px',
      flexShrink: 0, marginLeft: 3,
    }}>link</span>
  )
}

function ImpliedLinkFactIcon() {
  const stroke = 'var(--col-fact)'
  const x1 = 1, x2 = 9, x3 = 17, y1 = 4.2, y2 = 13.8, sw = 1.5, da = '2.5 1.8'
  return (
    <svg width={22} height={22} viewBox="0 0 18 18" style={{ display: 'block', flexShrink: 0 }}>
      <rect x={x1} y={y1} width={x2 - x1} height={y2 - y1} fill="#ffffff" stroke="none" />
      <rect x={x2} y={y1} width={x3 - x2} height={y2 - y1} fill="#ffffff" stroke="none" />
      <line x1={x1} y1={y1} x2={x1} y2={y2} stroke={stroke} strokeWidth={sw} strokeDasharray={da} />
      <line x1={x1} y1={y1} x2={x3} y2={y1} stroke={stroke} strokeWidth={sw} strokeDasharray={da} />
      <line x1={x3} y1={y1} x2={x3} y2={y2} stroke={stroke} strokeWidth={sw} strokeDasharray={da} />
      <line x1={x1} y1={y2} x2={x3} y2={y2} stroke={stroke} strokeWidth={sw} strokeDasharray={da} />
      <line x1={x2} y1={y1} x2={x2} y2={y2} stroke={stroke} strokeWidth={sw} strokeDasharray={da} />
    </svg>
  )
}

function RefExpansionRow({ icon, label, onSelect }) {
  return (
    <div
      onClick={onSelect}
      style={{
        display: 'flex', alignItems: 'center',
        padding: '2px 8px 2px 28px',
        borderBottom: '1px solid var(--border-soft)',
        cursor: 'pointer',
      }}
      onMouseEnter={e => { e.currentTarget.style.background = 'var(--bg-raised)' }}
      onMouseLeave={e => { e.currentTarget.style.background = '' }}
    >
      <span style={{ flexShrink: 0, marginRight: 5, lineHeight: 0, transform: 'scale(0.75)' }}>
        {icon}
      </span>
      <span style={{
        flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis',
        whiteSpace: 'nowrap', fontSize: 11, fontFamily: FONT,
        fontStyle: 'italic', color: 'var(--ink-muted)',
      }}>
        {label}
      </span>
      <span title="Collapsed reference mode expansion" style={{
        fontSize: 8, color: 'var(--ink-muted)', border: '1px solid var(--border)',
        borderRadius: 3, padding: '0 3px', lineHeight: '13px',
        flexShrink: 0, marginLeft: 3,
      }}>ref</span>
    </div>
  )
}

function ImpliedLinkIcon() {
  return (
    <svg width="14" height="10" viewBox="0 0 14 10" style={{ display: 'block' }}>
      <rect x="0.5" y="2" width="4" height="6" rx="1" fill="none" stroke="currentColor" strokeWidth="1" strokeDasharray="2,1"/>
      <line x1="4.5" y1="5" x2="9.5" y2="5" stroke="currentColor" strokeWidth="1" strokeDasharray="2,1"/>
      <rect x="9.5" y="2" width="4" height="6" rx="1" fill="none" stroke="currentColor" strokeWidth="1"/>
    </svg>
  )
}

function ElementRow({ icon, label, isOrphaned, inCurrentDiagram, onSelect, onAdd, onDelete }) {
  return (
    <div
      onClick={onSelect}
      style={{
        display: 'flex', alignItems: 'center',
        padding: '3px 8px',
        borderBottom: '1px solid var(--border-soft)',
        cursor: 'pointer',
        background: isOrphaned ? 'rgba(192,57,43,0.04)' : undefined,
      }}
      onMouseEnter={e => { e.currentTarget.style.background = 'var(--bg-raised)' }}
      onMouseLeave={e => { e.currentTarget.style.background = isOrphaned ? 'rgba(192,57,43,0.04)' : '' }}
    >
      {/* Fixed-width add button slot keeps icon/name aligned across all rows */}
      <div style={{ width: 22, flexShrink: 0, marginRight: 5 }}>
        {!inCurrentDiagram && onAdd && (
          <button
            onMouseDown={e => e.stopPropagation()}
            onClick={e => { e.stopPropagation(); onAdd() }}
            title="Add to this diagram"
            style={{
              background: 'none', border: '1px solid var(--border)',
              borderRadius: 3, cursor: 'pointer',
              fontSize: 9, color: 'var(--ink-muted)', padding: '1px 5px',
              width: '100%',
            }}
            onMouseEnter={e => {
              e.currentTarget.style.background = '#1e3a8a'
              e.currentTarget.style.color = 'white'
              e.currentTarget.style.borderColor = '#1e3a8a'
            }}
            onMouseLeave={e => {
              e.currentTarget.style.background = 'none'
              e.currentTarget.style.color = 'var(--ink-muted)'
              e.currentTarget.style.borderColor = 'var(--border)'
            }}
          >+</button>
        )}
      </div>
      <span style={{ flexShrink: 0, marginRight: 5, lineHeight: 0, transform: 'scale(0.8)' }}>
        {icon}
      </span>
      <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis',
        whiteSpace: 'nowrap', fontSize: 11, fontFamily: FONT }}>
        {label}
      </span>
      {isOrphaned && <OrphanBadge />}
      {onDelete && (
        <button
          onMouseDown={e => e.stopPropagation()}
          onClick={e => { e.stopPropagation(); onDelete() }}
          title="Delete"
          style={{
            background: 'none', border: '1px solid #e0b0a8',
            borderRadius: 3, cursor: 'pointer',
            fontSize: 9, color: 'var(--danger)', padding: '1px 5px',
            flexShrink: 0, marginLeft: 4,
          }}
          onMouseEnter={e => {
            e.currentTarget.style.background = 'var(--danger)'
            e.currentTarget.style.color = 'white'
            e.currentTarget.style.borderColor = 'var(--danger)'
          }}
          onMouseLeave={e => {
            e.currentTarget.style.background = 'none'
            e.currentTarget.style.color = 'var(--danger)'
            e.currentTarget.style.borderColor = '#e0b0a8'
          }}
        >×</button>
      )}
    </div>
  )
}

function SectionHeader({ title, count }) {
  return (
    <div style={{
      padding: '5px 8px 3px',
      fontSize: 9, color: 'var(--ink-muted)',
      letterSpacing: '0.08em', textTransform: 'uppercase',
      background: 'var(--bg-raised)',
      borderBottom: '1px solid var(--border-soft)',
      fontFamily: FONT,
      display: 'flex', justifyContent: 'space-between', alignItems: 'center',
    }}>
      <span>{title}</span>
      {count > 0 && <span style={{ fontSize: 9, color: 'var(--ink-muted)' }}>{count}</span>}
    </div>
  )
}

// ── main component ────────────────────────────────────────────────────────────

export default function SchemaBrowser() {
  const store = useOrmStore()
  const { diagram } = useDiagramElements()

  const diagrams = store.diagrams ?? []

  const [collapsed,   setCollapsed]   = useState(true)
  const [expandFrom,  setExpandFrom]  = useState(null)
  const [animating,   setAnimating]   = useState(false)
  const [showOrphans, setShowOrphans] = useState(false)
  const [resizing,    setResizing]    = useState(false)
  const [pos,  setPos]  = useState(null)
  const [size, setSize] = useState({ w: INIT_W, h: INIT_H })
  const [winW, setWinW] = useState(window.innerWidth)
  const [winH, setWinH] = useState(window.innerHeight)
  const animTimerRef = useRef(null)
  const dragRef      = useRef(null)
  const resizeRef    = useRef(null)
  const panelRef     = useRef(null)

  useEffect(() => {
    const onResize = () => { setWinW(window.innerWidth); setWinH(window.innerHeight) }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  const toolbarBottom = document.getElementById('app-toolbar')?.getBoundingClientRect().bottom ?? 36
  const tabsBottom    = document.getElementById('diagram-tabs')?.getBoundingClientRect().bottom ?? (toolbarBottom + 35)
  const posX = pos?.x ?? Math.max(8, winW - 248 - INIT_W - 8)
  const posY = pos?.y ?? (tabsBottom + 8)

  // ── drag to move ─────────────────────────────────────────────────────────
  const handleHeaderMouseDown = useCallback((e) => {
    if (e.button !== 0) return
    e.preventDefault(); e.stopPropagation()
    dragRef.current = { startMouseX: e.clientX, startMouseY: e.clientY, startPosX: posX, startPosY: posY }
    const onMove = (me) => {
      if (!dragRef.current) return
      const { startMouseX, startMouseY, startPosX, startPosY } = dragRef.current
      setPos({
        x: Math.max(0, Math.min(window.innerWidth  - size.w - 2, startPosX + me.clientX - startMouseX)),
        y: Math.max(0, Math.min(window.innerHeight - size.h - 2, startPosY + me.clientY - startMouseY)),
      })
    }
    const onUp = () => { dragRef.current = null; window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp) }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup',   onUp)
  }, [posX, posY, size.w, size.h])

  // ── resize ────────────────────────────────────────────────────────────────
  const handleResizeMouseDown = useCallback((e, dir) => {
    if (e.button !== 0) return
    e.preventDefault(); e.stopPropagation()
    setResizing(true)
    resizeRef.current = { dir, startX: e.clientX, startY: e.clientY, startW: size.w, startH: size.h, startXPos: posX, startPosY: posY }
    const panelEl = panelRef.current
    const onMove = (me) => {
      if (!resizeRef.current || !panelEl) return
      const { dir, startX, startY, startW, startH, startXPos, startPosY } = resizeRef.current
      const dx = me.clientX - startX, dy = me.clientY - startY
      let newW = startW, newH = startH, newX = startXPos, newY = startPosY
      if (dir === 'e' || dir === 'se') newW = Math.max(MIN_W, Math.min(MAX_W, startW + dx))
      if (dir === 'w' || dir === 'sw') {
        newW = Math.max(MIN_W, Math.min(MAX_W, startW - dx))
        newX = startXPos + (startW - newW)
      }
      if (dir === 's' || dir === 'se' || dir === 'sw') newH = Math.max(MIN_H, Math.min(MAX_H, startH + dy))
      panelEl.style.left = `${newX}px`
      panelEl.style.top = `${newY}px`
      panelEl.style.width = `${newW}px`
      panelEl.style.height = `${newH}px`
      resizeRef.current._live = { w: newW, h: newH, x: newX, y: newY }
    }
    const onUp = () => {
      const live = resizeRef.current?._live
      if (live) {
        setSize({ w: live.w, h: live.h })
        setPos({ x: live.x, y: live.y })
      }
      resizeRef.current = null
      setResizing(false)
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup',   onUp)
  }, [size, posX, posY])

  const handleCollapse = useCallback(() => {
    setCollapsed(true); setAnimating(true)
    if (animTimerRef.current) clearTimeout(animTimerRef.current)
    animTimerRef.current = setTimeout(() => setAnimating(false), 350)
  }, [])

  const handleExpand = useCallback(() => {
    const pw = 128
    const s   = useOrmStore.getState()
    const bph = s.bottomPanelCollapsed ? BOTTOM_PANEL_TAB_STRIP_H : s.bottomPanelHeight
    const px = window.innerWidth  - 258 - 114 - 6 - pw
    const py = window.innerHeight - 26 - bph - 8  - HDR_H
    setExpandFrom({ x: px, y: py }); setCollapsed(false); setAnimating(true)
    if (animTimerRef.current) clearTimeout(animTimerRef.current)
    animTimerRef.current = setTimeout(() => setAnimating(false), 350)
    requestAnimationFrame(() => requestAnimationFrame(() => setExpandFrom(null)))
  }, [])

  // ── data ──────────────────────────────────────────────────────────────────

  const otMap = Object.fromEntries(store.objectTypes.map(o => [o.id, o]))
  const otAndNestedMap = {
    ...otMap,
    ...Object.fromEntries(store.facts.filter(f => f.objectified).map(f => [f.id, { name: f.objectifiedName }])),
  }

  // "in current diagram" checks
  const inDiag = (id) => diagram?.occurrences?.some(o => o.schemaElementId === id) ?? false

  const subtypeInDiag = (st) =>
    (diagram?.occurrences?.some(o => o.schemaElementId === st.subId) &&
     diagram?.occurrences?.some(o => o.schemaElementId === st.superId)) ?? false

  const shownImplicitLinksSet = new Set(diagram?.shownImplicitLinks ?? [])
  const ilInDiag = (il) => inDiag(il.factId) && shownImplicitLinksSet.has(`${il.factId}:${il.roleIndex}`)

  // "orphaned" = not in any diagram
  const isOrphaned   = (id) => !diagrams.some(d => d.occurrences?.some(o => o.schemaElementId === id))
  const isStOrphaned = (st) => !diagrams.some(d =>
    d.occurrences?.some(o => o.schemaElementId === st.subId) &&
    d.occurrences?.some(o => o.schemaElementId === st.superId)
  )

  const expandedRefModes = new Set(diagram?.expandedRefModes ?? [])

  const allOrphanCount = [
    ...store.objectTypes.filter(o => isOrphaned(o.id)),
    ...store.facts.filter(f => isOrphaned(f.id)),
    ...store.subtypes.filter(st => isStOrphaned(st)),
    ...store.constraints.filter(c => isOrphaned(c.id)),
  ].length

  useEffect(() => {
    if (allOrphanCount === 0) setShowOrphans(false)
  }, [allOrphanCount])

  // ── groups ────────────────────────────────────────────────────────────────

  const impliedLinks = store.facts
    .filter(f => f.objectified)
    .flatMap(f => (f.implicitLinks || [])
      .filter(il => f.roles[il.roleIndex]?.objectTypeId)
      .map(il => ({
        id: `${f.id}_il_${il.roleIndex}`,
        factId: f.id,
        roleIndex: il.roleIndex,
        objectifiedName: f.objectifiedName || '(unnamed)',
        roleOtId: f.roles[il.roleIndex].objectTypeId,
        readingParts: il.readingParts,
      }))
    )

  const entityTypes = store.objectTypes.filter(o => o.kind === 'entity')
    .map(o => ({ id: o.id, label: o.name || '(unnamed)', kind: 'entity' }))
    .sort((a, b) => a.label.localeCompare(b.label))

  const nestedEntityTypes = store.facts.filter(f => f.objectified && f.objectifiedKind !== 'value')
    .map(f => ({ id: f.id, label: f.objectifiedName || '(unnamed)', kind: 'entity' }))
    .sort((a, b) => a.label.localeCompare(b.label))

  const valueTypes = store.objectTypes.filter(o => o.kind === 'value')
    .map(o => ({ id: o.id, label: o.name || '(unnamed)', kind: 'value' }))
    .sort((a, b) => a.label.localeCompare(b.label))

  const factTypes = [
    ...store.facts.filter(f => !f.objectified),
    ...impliedLinks.map(il => ({ ...il, isImpliedLink: true })),
  ]

  const subtypeEdges = [...store.subtypes].sort((a, b) => {
    const supA = otAndNestedMap[a.superId]?.name ?? ''
    const supB = otAndNestedMap[b.superId]?.name ?? ''
    const cmp = supA.localeCompare(supB)
    if (cmp !== 0) return cmp
    const subA = otAndNestedMap[a.subId]?.name ?? ''
    const subB = otAndNestedMap[b.subId]?.name ?? ''
    return subA.localeCompare(subB)
  })

  const CONSTRAINT_TYPE_ORDER = ['uniqueness','inclusiveOr','exclusion','exclusiveOr','equality','subset','ring','frequency','valueComparison']
  const constraintNodes = [...store.constraints].sort((a, b) => {
    const ia = CONSTRAINT_TYPE_ORDER.indexOf(a.constraintType)
    const ib = CONSTRAINT_TYPE_ORDER.indexOf(b.constraintType)
    return (ia === -1 ? 999 : ia) - (ib === -1 ? 999 : ib)
  })

  const rHandle = (dir) => ({
    position: 'absolute', zIndex: 2,
    ...(dir === 'e'  ? { right: 0, top: 0, bottom: 0, width: 5, cursor: 'ew-resize' } : {}),
    ...(dir === 'w'  ? { left: 0, top: 0, bottom: 0, width: 5, cursor: 'ew-resize' } : {}),
    ...(dir === 's'  ? { bottom: 0, left: 0, right: 0, height: 5, cursor: 'ns-resize' } : {}),
    ...(dir === 'se' ? { bottom: 0, right: 0, width: 12, height: 12, cursor: 'nwse-resize' } : {}),
    ...(dir === 'sw' ? { bottom: 0, left: 0, width: 12, height: 12, cursor: 'nesw-resize' } : {}),
  })

  const PILL_W = 128
  const MINIMAP_PILL_W = 114
  const panelW = collapsed ? PILL_W    : size.w
  const panelH = collapsed ? HDR_H     : size.h
  const panelR = collapsed ? HDR_H / 2 : 6

  const inspectorWidth = store.inspectorWidth
  const bottomPanelH   = store.bottomPanelCollapsed ? BOTTOM_PANEL_TAB_STRIP_H : store.bottomPanelHeight
  const pillLeft = winW - inspectorWidth - MINIMAP_PILL_W - 12 - PILL_W
  const pillTop  = winH - 26 - bottomPanelH - 8 - HDR_H
  const displayLeft = expandFrom?.x ?? (collapsed ? pillLeft : posX)
  const displayTop  = expandFrom?.y ?? (collapsed ? pillTop  : posY)

  // Only center when the element is visible in the current diagram.
  // Exceptions: implied links (center on parent fact if fact is in diagram)
  // and ref-expansion rows (always center on parent entity — handled inline).
  const selectEl = (id, kind) => {
    store.select(id, kind)
    if (inDiag(id)) store.centerOnElement(id)
  }

  const selectSubtype = (st) => {
    store.select(st.id, 'subtype')
    if (subtypeInDiag(st)) store.centerOnElement(st.id)
  }

  const selectImpliedLink = (il) => {
    store.select(il.id, 'implicitLink')
    if (inDiag(il.factId)) store.centerOnElement(il.factId)
  }

  const sections = [
    {
      title: 'Entity Types',
      items: showOrphans ? entityTypes.filter(el => isOrphaned(el.id)) : entityTypes,
      renderRow: (el) => {
        return (
          <ElementRow key={el.id}
            icon={<EntityTypeIcon />}
            label={el.label}
            isOrphaned={isOrphaned(el.id)}
            inCurrentDiagram={inDiag(el.id)}
            onSelect={() => selectEl(el.id, el.kind)}
            onAdd={() => store.addElementToDiagram(el.id, diagram?.id)}
            onDelete={() => store.deleteObjectType(el.id)}
          />
        )
      },
    },
    {
      title: 'Nested Entity Types',
      items: showOrphans ? nestedEntityTypes.filter(el => isOrphaned(el.id)) : nestedEntityTypes,
      renderRow: (el) => (
        <ElementRow key={el.id}
          icon={<NestedFactTypeIcon />}
          label={el.label}
          isOrphaned={isOrphaned(el.id)}
          inCurrentDiagram={inDiag(el.id)}
          onSelect={() => selectEl(el.id, el.kind)}
          onAdd={() => store.addElementToDiagram(el.id, diagram?.id)}
          onDelete={() => store.deleteFact(el.id)}
        />
      ),
    },
    {
      title: 'Value Types',
      items: showOrphans ? valueTypes.filter(el => isOrphaned(el.id)) : valueTypes,
      renderRow: (el) => (
        <ElementRow key={el.id}
          icon={<ValueTypeIcon />}
          label={el.label}
          isOrphaned={isOrphaned(el.id)}
          inCurrentDiagram={inDiag(el.id)}
          onSelect={() => selectEl(el.id, el.kind)}
          onAdd={() => store.addElementToDiagram(el.id, diagram?.id)}
          onDelete={() => store.deleteObjectType(el.id)}
        />
      ),
    },
    {
      title: 'Fact Types',
      items: showOrphans ? factTypes.filter(f => {
        if (f.isImpliedLink) return false
        return isOrphaned(f.id)
      }) : factTypes,
      renderRow: (f) => {
        if (f.isImpliedLink) {
          // Construct a synthetic 2-role fact so FactLabel can render the reading naturally.
          // Role 0 = the objectified fact (treated as an OT), Role 1 = the role-playing OT.
          const syntheticFact = {
            readingParts: f.readingParts || ['', 'involves', ''],
            arity: 2,
            objectifiedName: f.objectifiedName,
            roles: [{ objectTypeId: f.factId }, { objectTypeId: f.roleOtId }],
          }
          const syntheticOtMap = { ...otAndNestedMap, [f.factId]: { name: f.objectifiedName } }
          return (
            <ElementRow key={f.id}
              icon={<ImpliedLinkFactIcon />}
              label={<><FactLabel fact={syntheticFact} otMap={syntheticOtMap} /><LinkBadge /></>}
              isOrphaned={false}
              inCurrentDiagram={ilInDiag(f)}
              onSelect={() => selectImpliedLink(f)}
              onAdd={() => {
                if (!inDiag(f.factId)) store.addElementToDiagram(f.factId, diagram?.id)
                if (!shownImplicitLinksSet.has(`${f.factId}:${f.roleIndex}`)) store.toggleImplicitLink(f.factId, f.roleIndex)
              }}
              onDelete={undefined}
            />
          )
        }
        return (
          <ElementRow key={f.id}
            icon={<FactTypeIcon />}
            label={<FactLabel fact={f} otMap={otAndNestedMap} />}
            isOrphaned={isOrphaned(f.id)}
            inCurrentDiagram={inDiag(f.id)}
            onSelect={() => selectEl(f.id, 'fact')}
            onAdd={() => store.addElementToDiagram(f.id, diagram?.id)}
            onDelete={() => store.deleteFact(f.id)}
          />
        )
      },
    },
    {
      title: 'Subtype Relationships',
      items: showOrphans ? subtypeEdges.filter(st => isStOrphaned(st)) : subtypeEdges,
      renderRow: (st) => {
        const subName  = otAndNestedMap[st.subId]?.name  ?? '?'
        const supName  = otAndNestedMap[st.superId]?.name ?? '?'
        return (
          <ElementRow key={st.id}
            icon={<SubtypeIcon />}
            label={<span style={{ fontSize: 11 }}>{subName} <span style={{ color: 'var(--ink-muted)' }}>⊂</span> {supName}</span>}
            isOrphaned={isStOrphaned(st)}
            inCurrentDiagram={subtypeInDiag(st)}
            onSelect={() => selectSubtype(st)}
            onAdd={() => store.addElementToDiagram(st.id, diagram?.id)}
            onDelete={() => store.deleteSubtype(st.id)}
          />
        )
      },
    },
    {
      title: 'External Constraints',
      items: showOrphans ? constraintNodes.filter(c => isOrphaned(c.id)) : constraintNodes,
      renderRow: (c) => (
        <ElementRow key={c.id}
          icon={CONSTRAINT_ICON_MAP[c.constraintType] ?? <UniquenessConstraintIcon />}
          label={<span style={{ fontSize: 11, color: 'var(--ink-muted)', fontStyle: 'italic' }}>
            {c.constraintType}
          </span>}
          isOrphaned={isOrphaned(c.id)}
          inCurrentDiagram={inDiag(c.id)}
          onSelect={() => selectEl(c.id, 'constraint')}
          onAdd={() => store.addElementToDiagram(c.id, diagram?.id)}
          onDelete={() => store.deleteConstraint(c.id)}
        />
      ),
    },
    {
      title: 'Notes',
      items: showOrphans ? [] : (diagram?.notes ?? []),
      renderRow: (note) => {
        const preview = (note.text || '').split('\n')[0].slice(0, 40) || '(empty)'
        return (
          <ElementRow key={note.id}
            icon={<NoteIcon />}
            label={<span style={{ fontSize: 11, fontStyle: note.text ? 'normal' : 'italic',
              color: note.text ? 'var(--ink-2)' : 'var(--ink-muted)' }}>{preview}</span>}
            isOrphaned={false}
            inCurrentDiagram={true}
            onSelect={() => { store.select(note.id, 'note'); store.centerOnElement(note.id) }}
            onAdd={null}
            onDelete={() => store.deleteNote(note.id)}
          />
        )
      },
    },
  ].filter(s => s.items.length > 0)

  return (
    <>
      <div
        ref={panelRef}
        onClick={collapsed ? handleExpand : undefined}
        style={{
          position: 'fixed',
          left: displayLeft, top: displayTop,
          width: panelW, height: panelH,
          background: 'var(--bg-surface)',
          border: '1px solid var(--border)',
          borderRadius: panelR,
          overflow: 'hidden',
          boxShadow: 'var(--shadow-md)',
          userSelect: 'none',
          zIndex: 10,
          WebkitAppRegion: 'no-drag',
          fontFamily: FONT,
          cursor: collapsed ? 'pointer' : 'default',
          transition: resizing ? 'none' : (animating
            ? 'width 0.28s ease, height 0.28s ease, border-radius 0.28s ease, left 0.28s ease, top 0.28s ease'
            : 'width 0.28s ease, height 0.28s ease, border-radius 0.28s ease'),
        }}
      >
        {/* Pill label */}
        <div style={{
          position: 'absolute', inset: 0,
          display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 5,
          fontSize: 9, color: 'var(--ink-muted)',
          letterSpacing: '0.05em', textTransform: 'uppercase',
          fontFamily: FONT, whiteSpace: 'nowrap',
          opacity: collapsed ? 1 : 0,
          transition: collapsed ? 'opacity 0.14s ease 0.14s' : 'opacity 0.08s ease',
          pointerEvents: 'none',
        }}>
          <span style={{ fontSize: 11 }}>⊞</span>
          <span>schema</span>
          {allOrphanCount > 0 && (
            <span style={{
              background: 'var(--danger)', color: 'white',
              borderRadius: 8, fontSize: 9, padding: '0 4px', lineHeight: '14px',
              minWidth: 14, textAlign: 'center',
            }}>{allOrphanCount}</span>
          )}
        </div>

        {/* Panel content */}
        <div style={{
          display: 'flex', flexDirection: 'column', height: '100%',
          opacity: collapsed ? 0 : 1,
          transition: collapsed ? 'opacity 0.1s ease' : 'opacity 0.18s ease 0.12s',
          pointerEvents: collapsed ? 'none' : 'auto',
        }}>
          {/* Header */}
          <div
            onMouseDown={handleHeaderMouseDown}
            style={{
              height: HDR_H,
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              padding: '0 6px',
              borderBottom: '1px solid var(--border-soft)',
              cursor: 'grab',
              background: 'var(--bg-raised)',
              flexShrink: 0,
            }}
          >
            <span style={{ fontSize: 9, color: 'var(--ink-muted)',
              letterSpacing: '0.07em', textTransform: 'uppercase',
              pointerEvents: 'none' }}>
              ⠿ schema browser
            </span>
            <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              {allOrphanCount > 0 && (
                <span
                  onClick={() => setShowOrphans(p => !p)}
                  title={showOrphans ? 'Show all elements' : 'Show only orphans'}
                  style={{
                    fontSize: 9,
                    color: showOrphans ? 'white' : 'var(--danger)',
                    border: '1px solid var(--danger)',
                    borderRadius: 3,
                    padding: '0 4px',
                    lineHeight: '14px',
                    cursor: 'pointer',
                    background: showOrphans ? 'var(--danger)' : 'transparent',
                  }}
                >
                  {allOrphanCount} orphan{allOrphanCount !== 1 ? 's' : ''}
                </span>
              )}
              <button
                onMouseDown={e => e.stopPropagation()}
                onClick={handleCollapse}
                title="Collapse schema browser"
                style={{
                  background: 'none', border: 'none', cursor: 'pointer',
                  padding: '0 2px', fontSize: 11, lineHeight: 1,
                  color: 'var(--ink-muted)', pointerEvents: 'all',
                }}
              >−</button>
            </div>
          </div>

          {/* Element list */}
          <div style={{ overflowY: 'auto', flex: 1 }}>
            {sections.length === 0 ? (
              <div style={{ padding: 10, fontSize: 11, color: 'var(--ink-muted)', textAlign: 'center' }}>
                Schema is empty.
              </div>
            ) : sections.map(sec => (
              <div key={sec.title}>
                <SectionHeader title={sec.title} count={sec.items.length} />
                {sec.items.map(item => sec.renderRow(item))}
              </div>
            ))}
          </div>

          {/* Resize handles */}
          <div style={rHandle('e')}  onMouseDown={e => handleResizeMouseDown(e, 'e')} />
          <div style={rHandle('w')}  onMouseDown={e => handleResizeMouseDown(e, 'w')} />
          <div style={rHandle('s')}  onMouseDown={e => handleResizeMouseDown(e, 's')} />
          <div style={rHandle('se')} onMouseDown={e => handleResizeMouseDown(e, 'se')} />
          <div style={rHandle('sw')} onMouseDown={e => handleResizeMouseDown(e, 'sw')} />
        </div>
      </div>
    </>
  )
}
