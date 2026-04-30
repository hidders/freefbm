import React, { useState, useRef, useCallback, useEffect } from 'react'
import { useOrmStore } from '../store/ormStore'
import { useDiagramElements } from '../hooks/useDiagramElements'
import {
  EntityTypeIcon, ValueTypeIcon, NestedFactTypeIcon, NestedValueTypeIcon, FactTypeIcon, SubtypeIcon,
  UniquenessConstraintIcon, InclusiveOrConstraintIcon, ExclusionConstraintIcon, SubtypeConstraintIcon,
  EqualityConstraintIcon, SubsetConstraintIcon, RingConstraintIcon, FrequencyConstraintIcon,
  ValueComparisonConstraintIcon,
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
  return diagrams.filter(d => d.elementIds === null || (d.elementIds ?? []).includes(elementId))
}

function subtypeDiagramsContaining(st, diagrams) {
  return diagrams.filter(d =>
    d.elementIds === null ||
    ((d.elementIds ?? []).includes(st.subId) && (d.elementIds ?? []).includes(st.superId))
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
      fontSize: 8, color: '#c0392b', border: '1px solid #c0392b',
      borderRadius: 3, padding: '0 3px', lineHeight: '13px',
      flexShrink: 0, marginLeft: 3,
    }}>orphan</span>
  )
}

function ElementRow({ icon, label, isOrphaned, inCurrentDiagram, onSelect, onAdd }) {
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
      <span style={{ flexShrink: 0, marginRight: 5, lineHeight: 0 }}>
        {icon}
      </span>
      <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis',
        whiteSpace: 'nowrap', fontSize: 11, fontFamily: FONT }}>
        {label}
      </span>
      {isOrphaned && <OrphanBadge />}
      {!inCurrentDiagram && (
        <button
          onMouseDown={e => e.stopPropagation()}
          onClick={e => { e.stopPropagation(); onAdd() }}
          title="Add to this diagram"
          style={{
            background: 'none', border: '1px solid var(--border)',
            borderRadius: 3, cursor: 'pointer',
            fontSize: 9, color: 'var(--ink-muted)', padding: '1px 5px',
            flexShrink: 0, marginLeft: 4,
          }}
          onMouseEnter={e => {
            e.currentTarget.style.background = 'var(--accent)'
            e.currentTarget.style.color = 'white'
            e.currentTarget.style.borderColor = 'var(--accent)'
          }}
          onMouseLeave={e => {
            e.currentTarget.style.background = 'none'
            e.currentTarget.style.color = 'var(--ink-muted)'
            e.currentTarget.style.borderColor = 'var(--border)'
          }}
        >+</button>
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
  const animTimerRef = useRef(null)
  const dragRef      = useRef(null)
  const resizeRef    = useRef(null)
  const panelRef     = useRef(null)

  const toolbarBottom = document.getElementById('app-toolbar')?.getBoundingClientRect().bottom ?? 36
  const tabsBottom    = document.getElementById('diagram-tabs')?.getBoundingClientRect().bottom ?? (toolbarBottom + 35)
  const posX = pos?.x ?? Math.max(8, window.innerWidth - 248 - INIT_W - 8)
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
    const px = window.innerWidth  - 258 - 114 - 6 - pw
    const py = window.innerHeight - 26  - 8  - HDR_H
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
  const inDiag = diagram?.elementIds === null
    ? () => true
    : (id) => (diagram?.elementIds ?? []).includes(id)

  const subtypeInDiag = (st) => diagram?.elementIds === null ||
    ((diagram?.elementIds ?? []).includes(st.subId) && (diagram?.elementIds ?? []).includes(st.superId))

  // "orphaned" = not in any diagram
  const isOrphaned   = (id) => !diagrams.some(d => d.elementIds === null || (d.elementIds ?? []).includes(id))
  const isStOrphaned = (st) => !diagrams.some(d =>
    d.elementIds === null ||
    ((d.elementIds ?? []).includes(st.subId) && (d.elementIds ?? []).includes(st.superId))
  )

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

  const entityTypes = [
    ...store.objectTypes.filter(o => o.kind === 'entity')
      .map(o => ({ id: o.id, label: o.name || '(unnamed)', kind: 'entity', isNested: false })),
    ...store.facts.filter(f => f.objectified && f.objectifiedKind !== 'value')
      .map(f => ({ id: f.id, label: f.objectifiedName || '(unnamed)', kind: 'entity', isNested: true })),
  ].sort((a, b) => a.label.localeCompare(b.label))

  const valueTypes = [
    ...store.objectTypes.filter(o => o.kind === 'value')
      .map(o => ({ id: o.id, label: o.name || '(unnamed)', kind: 'value', isNested: false })),
    ...store.facts.filter(f => f.objectified && f.objectifiedKind === 'value')
      .map(f => ({ id: f.id, label: f.objectifiedName || '(unnamed)', kind: 'value', isNested: true })),
  ].sort((a, b) => a.label.localeCompare(b.label))

  const factTypes = store.facts.filter(f => !f.objectified)

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
  const panelW = collapsed ? PILL_W    : size.w
  const panelH = collapsed ? HDR_H     : size.h
  const panelR = collapsed ? HDR_H / 2 : 6

  const pillLeft = window.innerWidth  - 258 - 114 - 6 - PILL_W
  const pillTop  = window.innerHeight - 26 - 8 - HDR_H
  const displayLeft = expandFrom?.x ?? (collapsed ? pillLeft : posX)
  const displayTop  = expandFrom?.y ?? (collapsed ? pillTop  : posY)

  const selectEl = (id, kind) => store.select(id, kind)

  const sections = [
    {
      title: 'Entity Types',
      items: showOrphans ? entityTypes.filter(el => isOrphaned(el.id)) : entityTypes,
      renderRow: (el) => (
        <ElementRow key={el.id}
          icon={el.isNested ? <NestedFactTypeIcon /> : <EntityTypeIcon />}
          label={el.label}
          isOrphaned={isOrphaned(el.id)}
          inCurrentDiagram={inDiag(el.id)}
          onSelect={() => selectEl(el.id, el.kind)}
          onAdd={() => store.addElementToDiagram(el.id, diagram?.id)}
        />
      ),
    },
    {
      title: 'Value Types',
      items: showOrphans ? valueTypes.filter(el => isOrphaned(el.id)) : valueTypes,
      renderRow: (el) => (
        <ElementRow key={el.id}
          icon={el.isNested ? <NestedValueTypeIcon /> : <ValueTypeIcon />}
          label={el.label}
          isOrphaned={isOrphaned(el.id)}
          inCurrentDiagram={inDiag(el.id)}
          onSelect={() => selectEl(el.id, el.kind)}
          onAdd={() => store.addElementToDiagram(el.id, diagram?.id)}
        />
      ),
    },
    {
      title: 'Fact Types',
      items: showOrphans ? factTypes.filter(f => isOrphaned(f.id)) : factTypes,
      renderRow: (f) => (
        <ElementRow key={f.id}
          icon={<FactTypeIcon />}
          label={<FactLabel fact={f} otMap={otAndNestedMap} />}
          isOrphaned={isOrphaned(f.id)}
          inCurrentDiagram={inDiag(f.id)}
          onSelect={() => selectEl(f.id, 'fact')}
          onAdd={() => store.addElementToDiagram(f.id, diagram?.id)}
        />
      ),
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
            onSelect={() => selectEl(st.id, 'subtype')}
            onAdd={() => store.addElementToDiagram(st.id, diagram?.id)}
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
        />
      ),
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
              background: '#c0392b', color: 'white',
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
                    color: showOrphans ? 'white' : '#c0392b',
                    border: '1px solid #c0392b',
                    borderRadius: 3,
                    padding: '0 4px',
                    lineHeight: '14px',
                    cursor: 'pointer',
                    background: showOrphans ? '#c0392b' : 'transparent',
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
