import React, { useState, useRef, useCallback, useEffect } from 'react'
import { createPortal } from 'react-dom'
import ContextMenu from './ContextMenu'
import { useOrmStore, useOrmStoreIgnoring, useScopedStore } from '../store/ormStore'
import { openDeleteFromSchema } from '../utils/deleteSelection'
import { activeSchemaIdOf, diagramRuleIds } from '../store/storeHelpers'
import { BOTTOM_PANEL_TAB_STRIP_H } from '../constants.js'
import { useDiagramElements } from '../hooks/useDiagramElements'
import {
  EntityTypeIcon, ValueTypeIcon, NestedFactTypeIcon, FactTypeIcon, SubtypeIcon,
  UniquenessConstraintIcon, InclusiveOrConstraintIcon, ExclusionConstraintIcon, SubtypeConstraintIcon,
  EqualityConstraintIcon, SubsetConstraintIcon, RingConstraintIcon, FrequencyConstraintIcon, FormulaConstraintIcon,
  ValueComparisonConstraintIcon, NoteIcon,
} from './ToolPanel'
import { queryElements } from '../logic/query.js'
import { activeRelationalFace } from '../relational/face.js'
import { relationalView, rmObjectOf } from '../relational/relationalView.js'
import { relationalSections, relationalOrphanCount } from './RelationalBrowser.jsx'
import { makeNameFilter, Highlight } from '../utils/nameFilter.jsx'
import { mappingOfDiagram } from '../store/storeHelpers'
import { useMappingRuleInfos, mappingRuleSections, mappingRuleOrphanCount } from './MappingRuleBrowser.jsx'

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
  formula:         <FormulaConstraintIcon />,
  valueComparison: <ValueComparisonConstraintIcon />,
}

// Returns the set of diagrams that contain an element (non-constraint)
function diagramsContaining(elementId, diagrams) {
  return diagrams.filter(d => d.occurrences?.some(o => o.schemaElementId === elementId))
}

// Returns the set of diagrams that contain a constraint
function constraintDiagramsContaining(constraintId, diagrams) {
  return diagrams.filter(d => d.constraintOccurrences?.some(co => co.schemaConstraintId === constraintId))
}

function subtypeDiagramsContaining(st, diagrams) {
  return diagrams.filter(d => (d.subtypeOccurrences ?? []).includes(st.id))
}

// ── sub-components ────────────────────────────────────────────────────────────

function FactLabel({ fact, otMap, filter }) {
  const parts = fact.readingParts || []
  const n = fact.arity
  const hasAnyPart = parts.some(p => p?.trim())
  if (!hasAnyPart) {
    return <span style={{ fontStyle: 'italic', color: 'var(--ink-muted)', fontSize: 11 }}>
      <Highlight text={fact.objectifiedName || fact.name || `(${n}-ary fact)`} filter={filter} />
    </span>
  }
  const tokens = []
  for (let i = 0; i <= n; i++) {
    const seg = parts[i]?.trim()
    if (seg) tokens.push(<span key={`s${i}`} style={{ color: '#2a7a2a' }}><Highlight text={seg} filter={filter} /></span>)
    if (i < n) {
      const name = otMap[fact.roles[i]?.objectTypeId]?.name || '?'
      tokens.push(<span key={`r${i}`} style={{ color: '#7c4dbd', fontWeight: 700 }}><Highlight text={name} filter={filter} /></span>)
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

function ElementRow({ icon, label, isOrphaned, inCurrentDiagram, onSelect, onAdd, onAddExtra, addButtonStyle, addButtonDisabled, onDelete, deleteTitle = 'Delete from Schema…', onMenu }) {
  return (
    <div
      onClick={onSelect}
      onContextMenu={onMenu}
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
        {((!inCurrentDiagram && onAdd) || (addButtonDisabled != null && onAdd)) && (
          <button
            onMouseDown={e => e.stopPropagation()}
            onClick={e => { if (addButtonDisabled) return; e.stopPropagation(); onAdd() }}
            title={addButtonDisabled ? 'Already in this diagram' : 'Add to this diagram'}
            style={{
              background: addButtonDisabled ? 'none' : (addButtonStyle?.background ?? 'none'),
              border: `1px solid ${addButtonDisabled ? 'var(--border-soft)' : (addButtonStyle?.borderColor ?? 'var(--border)')}`,
              borderRadius: 3, cursor: addButtonDisabled ? 'default' : 'pointer',
              padding: '2px 4px', width: '100%',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              color: addButtonDisabled ? 'var(--border)' : (addButtonStyle?.color ?? 'var(--ink-muted)'),
              opacity: addButtonDisabled ? 0.5 : 1,
            }}
            onMouseEnter={e => {
              if (addButtonDisabled) return
              e.currentTarget.style.background = '#1e3a8a'
              e.currentTarget.style.color = 'white'
              e.currentTarget.style.borderColor = '#1e3a8a'
            }}
            onMouseLeave={e => {
              if (addButtonDisabled) return
              e.currentTarget.style.background = addButtonStyle?.background ?? 'none'
              e.currentTarget.style.color = addButtonStyle?.color ?? 'var(--ink-muted)'
              e.currentTarget.style.borderColor = addButtonStyle?.borderColor ?? 'var(--border)'
            }}
          >
            {/* Bold filled plus */}
            <svg width="9" height="9" viewBox="0 0 9 9" style={{ display: 'block' }}>
              <rect x="3.5" y="0" width="2" height="9" rx="0.5" fill="currentColor"/>
              <rect x="0" y="3.5" width="9" height="2" rx="0.5" fill="currentColor"/>
            </svg>
          </button>
        )}
        {inCurrentDiagram && onAddExtra && (
          <button
            onMouseDown={e => e.stopPropagation()}
            onClick={e => { e.stopPropagation(); onAddExtra() }}
            title="Add another occurrence"
            style={{
              background: 'none', border: '1px solid var(--border)',
              borderRadius: 3, cursor: 'pointer',
              padding: '2px 4px', width: '100%',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              color: 'var(--ink-muted)',
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
          >
            {/* Outlined plus with grey shadow — mirrors the multi-occurrence shadow in the diagram */}
            <svg width="9" height="9" viewBox="0 0 9 9" style={{ display: 'block', filter: 'drop-shadow(1.5px 1.5px 0px rgba(150,150,150,0.7))' }}>
              <rect x="3.5" y="0.5" width="2" height="8" rx="0.5" fill="none" stroke="currentColor" strokeWidth="1.2"/>
              <rect x="0.5" y="3.5" width="8" height="2" rx="0.5" fill="none" stroke="currentColor" strokeWidth="1.2"/>
            </svg>
          </button>
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
          title={deleteTitle}
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

const NEW_GROUP_ROW = { id: '__newGroup' }

// A group's colours as a small square; dashed when it sets none.
function GroupIcon({ group }) {
  const c = group.colors ?? {}
  const stroke = c.outline ?? c.text
  return (
    <svg width={22} height={22} viewBox="0 0 18 18" style={{ display: 'block', flexShrink: 0 }}>
      <rect x={2.5} y={3.5} width={13} height={11} rx={2} fill={c.fill ?? '#ffffff'}
        stroke={stroke ?? 'var(--ink-muted)'} strokeWidth={stroke ? 2 : 1.2} strokeDasharray={stroke ? undefined : '2 1.5'}/>
    </svg>
  )
}

function SectionHeader({ title, count, total }) {
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
      {total != null && total !== count
        ? <span style={{ fontSize: 9, color: 'var(--ink-muted)' }}>{count} / {total}</span>
        : count > 0 && <span style={{ fontSize: 9, color: 'var(--ink-muted)' }}>{count}</span>}
    </div>
  )
}

// ── main component ────────────────────────────────────────────────────────────

export default function SchemaBrowser() {
  const store = useScopedStore()
  const { diagram } = useDiagramElements()

  // A row's menu: grow a diagram from the element (NeighbourPicker.jsx).
  const [rowMenu, setRowMenu] = useState(null)
  const openRowMenu = (e, id) => {
    e.preventDefault()
    e.stopPropagation()
    const s = useOrmStore.getState()
    const d = s.diagrams.find(x => x.id === s.activeDiagramId)
    if (!d || d.mappingId) return
    const occ = (d.occurrences ?? []).find(o => o.schemaElementId === id && !o.refModeOwnerOccId)
    setRowMenu({ x: e.clientX, y: e.clientY, items: [
      { label: 'Add Neighbours…', disabled: !occ, title: occ ? undefined : 'Not on this diagram',
        action: () => { s.centerOnElement(id); s.openNeighbourPicker(id, occ?.id ?? null) } },
      { label: 'New Diagram from Here', action: () => s.newDiagramFrom(id) },
    ] })
  }

  const diagrams = store.diagrams ?? []

  // A mapping diagram lists the mapping's rules (MappingRuleBrowser.jsx).
  const mapping = useOrmStore(s => mappingOfDiagram(s, s.diagrams.find(d => d.id === s.activeDiagramId)))
  const ruleInfos = useMappingRuleInfos(mapping)
  const editingRuleId = useOrmStore(s => (!mapping ? null
    : s.mappingRuleEditor?.mappingId === mapping.id ? s.mappingRuleEditor.ruleId
    : s.ruleEditor?.viewId === mapping.id ? s.ruleEditor.ruleId : null))
  const openRuleMenu = (e, info) => {
    e.preventDefault()
    e.stopPropagation()
    const s = useOrmStore.getState()
    const d = s.diagrams.find(x => x.id === s.activeDiagramId)
    if (!d || !mapping) return
    const here = ruleInfos.filter(i => diagramRuleIds(d, mapping).has(i.r.id)).map(i => i.r.id)
    const on = here.includes(info.r.id)
    const others = ruleInfos.map(i => i.r.id).filter(id => !here.includes(id))
    setRowMenu({ x: e.clientX, y: e.clientY, items: [
      on ? { label: 'Remove from This Diagram', action: () => s.hideMappingRules(d.id, [info.r.id]) }
         : { label: 'Add to This Diagram', action: () => s.showMappingRules(d.id, [info.r.id]) },
      { label: 'New Diagram with This Rule', action: () => s.newMappingDiagram(mapping.id, [info.r.id]) },
      '---',
      { label: 'Add All Rules to This Diagram', disabled: !others.length, action: () => s.showMappingRules(d.id, others) },
      { label: 'Remove Other Rules from This Diagram', disabled: !here.some(id => id !== info.r.id),
        action: () => s.hideMappingRules(d.id, here.filter(id => id !== info.r.id)) },
    ] })
  }

  const [collapsed,   setCollapsed]   = useState(true)
  const [expandFrom,  setExpandFrom]  = useState(null)
  const [animating,   setAnimating]   = useState(false)
  const [showOrphans, setShowOrphans] = useState(false)
  const [showReady,   setShowReady]   = useState(false)
  const [occPicker,   setOccPicker]   = useState(null)
  const [resizing,    setResizing]    = useState(false)
  const [pos,  setPos]  = useState(null)
  const [size, setSize] = useState({ w: INIT_W, h: INIT_H })
  const [winW, setWinW] = useState(window.innerWidth)
  const [winH, setWinH] = useState(window.innerHeight)
  // Name filter (src/utils/nameFilter.js): kept across diagrams, cleared when
  // the active schema changes.
  const [query, setQuery] = useState('')
  const filter = makeNameFilter(query)
  const searchRef = useRef(null)
  const activeSchemaId = activeSchemaIdOf(store)
  useEffect(() => { setQuery('') }, [activeSchemaId])
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

  // Cmd/Ctrl+F opens the browser and puts the cursor in the filter box.
  const collapsedRef = useRef(collapsed)
  collapsedRef.current = collapsed
  useEffect(() => {
    const onKey = (e) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey || (e.key !== 'f' && e.key !== 'F')) return
      e.preventDefault()
      const wasCollapsed = collapsedRef.current
      if (wasCollapsed) handleExpand()
      setTimeout(() => { searchRef.current?.focus(); searchRef.current?.select() }, wasCollapsed ? 200 : 0)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [handleExpand])

  // ── data ──────────────────────────────────────────────────────────────────

  const otMap = Object.fromEntries(store.objectTypes.map(o => [o.id, o]))
  const otAndNestedMap = {
    ...otMap,
    ...Object.fromEntries(store.facts.filter(f => f.objectified).map(f => [f.id, { name: f.objectifiedName }])),
  }

  // "in current diagram" checks
  const inDiag = (id) => diagram?.occurrences?.some(o => o.schemaElementId === id) ?? false
  const cInCurrentDiag = (id) => diagram?.constraintOccurrences?.some(co => co.schemaConstraintId === id) ?? false

  const subtypeInDiag = (st) =>
    (diagram?.subtypeOccurrences ?? []).includes(st.id)

  const shownImplicitLinksSet = new Set(diagram?.shownImplicitLinks ?? [])
  const ilInDiag = (il) => inDiag(il.factId) && shownImplicitLinksSet.has(`${il.factId}:${il.roleIndex}`)

  // "orphaned" = not in any diagram
  const isOrphaned    = (id) => !diagrams.some(d => d.occurrences?.some(o => o.schemaElementId === id))
  const isCOrphaned   = (id) => !diagrams.some(d => d.constraintOccurrences?.some(co => co.schemaConstraintId === id))
  const isStOrphaned  = (st) => !diagrams.some(d =>
    (d.subtypeOccurrences ?? []).includes(st.id)
  )

  // Returns true when all (subOcc, superOcc) pairs are already covered for this subtype.
  const subtypeAllCombinationsCovered = (st) => {
    const occs = diagram?.occurrences ?? []
    const subOccs  = occs.filter(o => o.schemaElementId === st.subId)
    const superOccs = occs.filter(o => o.schemaElementId === st.superId)
    if (subOccs.length === 0 || superOccs.length === 0) return false
    const raw = diagram?.subtypeEndpointOccs?.[st.id]
    const pairsArr = Array.isArray(raw) ? raw : (raw ? [raw] : [])
    const coveredSet = new Set(pairsArr.map(ep => `${ep.subOccId}|${ep.superOccId}`))
    for (const sub of subOccs) {
      for (const sup of superOccs) {
        if (!coveredSet.has(`${sub.id}|${sup.id}`)) return false
      }
    }
    return true
  }

  // Returns true when all role-occurrence combinations are already covered for this constraint.
  const allConstraintCombinationsCovered = (c) => {
    if (!diagram) return false
    // Collect the set of fact types that contribute roles to this constraint.
    const factIds = new Set()
    for (const seq of (c.sequences ?? []))
      for (const m of seq)
        if (m.kind === 'role' && m.factId && !m.factId.includes('_il_')) factIds.add(m.factId)
    for (const seq of (c.roleSequences ?? []))
      for (const ref of seq)
        if (ref.factId && !ref.factId.includes('_il_')) factIds.add(ref.factId)
    if (factIds.size === 0) return diagram?.constraintOccurrences?.some(co => co.schemaConstraintId === c.id) ?? false
    // Build list of occurrences per fact type that are currently in the diagram.
    const occs = diagram?.occurrences ?? []
    const factOccs = {}
    for (const fid of factIds) {
      factOccs[fid] = occs.filter(o => o.schemaElementId === fid)
      if (factOccs[fid].length === 0) return false
    }
    // Build set of already-covered roleOccurrenceRefs keys.
    const coveredKeys = new Set(
      (diagram?.constraintOccurrences ?? [])
        .filter(co => co.schemaConstraintId === c.id)
        .map(co => {
          const refs = co.roleOccurrenceRefs ?? {}
          return Object.entries(refs).sort((a, b) => a[0].localeCompare(b[0])).map(([k, v]) => `${k}:${v}`).join('|')
        })
    )
    // Count total combinations: product of fact-occ counts.
    const factIdArr = [...factIds]
    const counts = factIdArr.map(fid => factOccs[fid].length)
    const total = counts.reduce((a, b) => a * b, 1)
    return coveredKeys.size >= total
  }

  // Fact type dep-readiness: green if all role-connected OTs already in diagram, orange otherwise
  const factDepsStatus = (fact) => {
    const roleOtIds = (fact.roles ?? []).map(r => r.objectTypeId).filter(Boolean)
    return roleOtIds.every(otId => inDiag(otId)) ? 'ready' : 'partial'
  }

  const FACT_ADD_STYLE_READY   = { color: '#166534', borderColor: '#16a34a', background: 'rgba(22,163,74,0.07)' }
  const FACT_ADD_STYLE_PARTIAL = { color: '#92400e', borderColor: '#d97706', background: 'rgba(217,119,6,0.07)' }

  // Constraint dep-readiness helper
  // "ready" = all directly-connected elements AND all query elements have ≥1 occurrence in diagram.
  const constraintDepsStatus = (c) => {
    const deps = []
    if (c.sequences) {
      for (const seq of c.sequences)
        for (const m of seq) {
          if (m.kind === 'role' && m.factId) {
            if (m.factId.includes('_il_')) {
              const [fid] = m.factId.split('_il_')
              deps.push({ kind: 'fact', id: fid })
            } else {
              deps.push({ kind: 'fact', id: m.factId })
            }
          }
          if (m.kind === 'subtype' && m.subtypeId) deps.push({ kind: 'subtype', id: m.subtypeId })
        }
    }
    if (c.roleSequences) {
      for (const seq of c.roleSequences)
        for (const ref of seq)
          if (ref.factId) {
            const id = ref.factId.includes('_il_') ? ref.factId.split('_il_')[0] : ref.factId
            deps.push({ kind: 'fact', id })
          }
    }
    if (c.targetObjectTypeId) deps.push({ kind: 'ot', id: c.targetObjectTypeId })
    if (deps.length === 0) return 'empty'
    const seqAllPresent = deps.every(dep => {
      if (dep.kind === 'fact') return inDiag(dep.id)
      if (dep.kind === 'ot')   return inDiag(dep.id)
      if (dep.kind === 'subtype') {
        const st = store.subtypes.find(s => s.id === dep.id)
        return st && inDiag(st.subId) && inDiag(st.superId)
      }
      return false
    })
    if (!seqAllPresent) return 'partial'
    // Also check query deps: every element used in the constraint's queries must be present
    for (const q of (c.queries ?? [])) {
      for (const at of queryElements(q, store.subtypes)) {
        if (!at.originalId || at.originalId.includes('_il_')) continue
        if (at.kind === 'subtype') {
          if (!subtypeInDiag({ id: at.originalId })) return 'partial'
        } else {
          if (!inDiag(at.originalId)) return 'partial'
        }
      }
    }
    return 'ready'
  }

  const readyConstraintCount = store.constraints.filter(c =>
    !cInCurrentDiag(c.id) && constraintDepsStatus(c) === 'ready'
  ).length
  const readySubtypeCount = store.subtypes.filter(st =>
    !subtypeInDiag(st) && inDiag(st.subId) && inDiag(st.superId)
  ).length
  const readyFactCount = store.facts.filter(f =>
    !f.objectified && !inDiag(f.id) && factDepsStatus(f) === 'ready'
  ).length
  const readyNestedEntityCount = store.facts.filter(f =>
    f.objectified && f.objectifiedKind !== 'value' && !inDiag(f.id) && factDepsStatus(f) === 'ready'
  ).length
  // A relational schema showing its tables lists tables, keys and constraints
  // instead (RelationalBrowser.jsx); its orphans are tables in no diagram.
  const relFace = useOrmStore(s => activeRelationalFace(s))
  const rmView = relFace && !mapping ? relationalView(useOrmStore.getState(), activeSchemaIdOf(store)) : null
  const [rmExpanded, setRmExpanded] = useState(() => new Set())
  const toggleRm = (id) => setRmExpanded(x => { const n = new Set(x); if (n.has(id)) n.delete(id); else n.add(id); return n })

  const readyCount = rmView || mapping ? 0 : readyConstraintCount + readySubtypeCount + readyFactCount + readyNestedEntityCount

  const allOrphanCount = mapping ? mappingRuleOrphanCount(mapping, diagrams) : rmView ? relationalOrphanCount(rmView, diagrams.filter(d => d.schemaId === activeSchemaIdOf(store))) : [
    ...store.objectTypes.filter(o => isOrphaned(o.id)),
    ...store.facts.filter(f => isOrphaned(f.id)),
    ...store.subtypes.filter(st => isStOrphaned(st)),
    ...store.constraints.filter(c => isCOrphaned(c.id)),
  ].length

  useEffect(() => {
    if (allOrphanCount === 0) setShowOrphans(false)
  }, [allOrphanCount])
  useEffect(() => {
    if (readyCount === 0) setShowReady(false)
  }, [readyCount])
  useEffect(() => {
    if (!occPicker) return
    const handler = () => setOccPicker(null)
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [occPicker])

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

  const factSortKey = f => {
    const parts = f.readingParts || []
    const n = f.arity || 0
    if (!parts.some(p => p?.trim())) return f.objectifiedName || f.name || ''
    const tokens = []
    for (let i = 0; i <= n; i++) {
      const seg = parts[i]?.trim()
      if (seg) tokens.push(seg)
      if (i < n) {
        const otName = otAndNestedMap[f.roles?.[i]?.objectTypeId]?.name
        if (otName) tokens.push(otName)
      }
    }
    return tokens.join(' ')
  }
  const factTypes = [
    ...store.facts.filter(f => !f.objectified),
    ...impliedLinks.map(il => ({ ...il, isImpliedLink: true })),
  ].sort((a, b) => factSortKey(a).localeCompare(factSortKey(b)))

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
  const selectEl = (e, id, kind) => {
    const occs = (diagram?.occurrences ?? [])
      .filter(o => o.schemaElementId === id)
      .sort((a, b) => a.y !== b.y ? a.y - b.y : a.x - b.x)
    if (occs.length <= 1) {
      const occId = occs[0]?.id ?? null
      store.select(id, kind, occId)
      if (occId) store.centerOnOccurrence(occId)
    } else {
      const rect = e.currentTarget.getBoundingClientRect()
      setOccPicker({ x: rect.right + 6, y: rect.top, id, kind, occs })
    }
  }

  const selectSubtype = (st) => {
    store.select(st.id, 'subtype')
    if (subtypeInDiag(st)) store.centerOnElement(st.id)
  }

  const selectImpliedLink = (il) => {
    store.select(il.id, 'implicitLink')
    if (inDiag(il.factId)) store.centerOnElement(il.factId)
  }

  const selectedRmId = !rmView ? null
    : store.selectedRm && store.selectedRm.id === store.selectedId ? store.selectedRm.rmId
    : rmObjectOf(rmView, store.selectedId)?.rmId ?? null
  const sections = mapping ? mappingRuleSections({ mapping, infos: ruleInfos, diagram, diagrams,
    showOrphans, filter, editingRuleId, onMenu: openRuleMenu }) : rmView ? relationalSections({ view: rmView, diagram: diagram?.mappingId ? null : diagram,
    diagrams: diagrams.filter(d => d.schemaId === activeSchemaIdOf(store)), expanded: rmExpanded, toggle: toggleRm,
    selectedRmId, showOrphans, filter, onMenu: openRowMenu }) : [
    {
      title: 'Entity Types',
      items: showOrphans ? entityTypes.filter(el => isOrphaned(el.id)) : showReady ? [] : entityTypes,
      match: (el) => filter.test(el.label),
      renderRow: (el) => {
        return (
          <ElementRow key={el.id}
            icon={<EntityTypeIcon />}
            label={<Highlight text={el.label} filter={filter} />}
            isOrphaned={isOrphaned(el.id)}
            inCurrentDiagram={inDiag(el.id)}
            onSelect={(e) => selectEl(e, el.id, el.kind)}
            onAdd={() => store.addElementToDiagram(el.id, diagram?.id)}
            onAddExtra={diagram ? () => store.addExtraOccurrence(el.id, diagram.id) : undefined}
            onMenu={e => openRowMenu(e, el.id)}
            onDelete={() => openDeleteFromSchema([el.id])}
          />
        )
      },
    },
    {
      title: 'Nested Entity Types',
      items: showOrphans ? nestedEntityTypes.filter(el => isOrphaned(el.id))
           : showReady   ? nestedEntityTypes.filter(el => {
               const neFact = store.facts.find(f => f.id === el.id)
               return !inDiag(el.id) && neFact && factDepsStatus(neFact) === 'ready'
             })
           : nestedEntityTypes,
      match: (el) => {
        const neFact = store.facts.find(f => f.id === el.id)
        return filter.test(el.label, neFact && factSortKey(neFact))
      },
      renderRow: (el) => {
        const neFact = store.facts.find(f => f.id === el.id)
        const neAddStyle = neFact
          ? (factDepsStatus(neFact) === 'ready' ? FACT_ADD_STYLE_READY : FACT_ADD_STYLE_PARTIAL)
          : undefined
        return (
          <ElementRow key={el.id}
            icon={<NestedFactTypeIcon />}
            label={<Highlight text={el.label} filter={filter} />}
            isOrphaned={isOrphaned(el.id)}
            inCurrentDiagram={inDiag(el.id)}
            onSelect={(e) => selectEl(e, el.id, el.kind)}
            onAdd={() => store.addElementToDiagram(el.id, diagram?.id)}
            onAddExtra={diagram ? () => store.addExtraOccurrence(el.id, diagram.id) : undefined}
            addButtonStyle={neAddStyle}
            onMenu={e => openRowMenu(e, el.id)}
            onDelete={() => openDeleteFromSchema([el.id])}
          />
        )
      },
    },
    {
      title: 'Value Types',
      items: showOrphans ? valueTypes.filter(el => isOrphaned(el.id)) : showReady ? [] : valueTypes,
      match: (el) => filter.test(el.label),
      renderRow: (el) => (
        <ElementRow key={el.id}
          icon={<ValueTypeIcon />}
          label={<Highlight text={el.label} filter={filter} />}
          isOrphaned={isOrphaned(el.id)}
          inCurrentDiagram={inDiag(el.id)}
          onSelect={(e) => selectEl(e, el.id, el.kind)}
          onAdd={() => store.addElementToDiagram(el.id, diagram?.id)}
          onAddExtra={diagram ? () => store.addExtraOccurrence(el.id, diagram.id) : undefined}
          onMenu={e => openRowMenu(e, el.id)}
            onDelete={() => openDeleteFromSchema([el.id])}
        />
      ),
    },
    {
      title: 'Fact Types',
      items: showOrphans ? factTypes.filter(f => !f.isImpliedLink && isOrphaned(f.id))
           : showReady   ? factTypes.filter(f => !f.isImpliedLink && !inDiag(f.id) && factDepsStatus(f) === 'ready')
           : factTypes,
      // The reading with its players' names, as the row shows it.
      match: (f) => f.isImpliedLink
        ? filter.test(f.objectifiedName, f.readingParts, otAndNestedMap[f.roleOtId]?.name)
        : filter.test(factSortKey(f), f.name, f.objectifiedName),
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
              label={<><FactLabel fact={syntheticFact} otMap={syntheticOtMap} filter={filter} /><LinkBadge /></>}
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
        const fAddStyle = factDepsStatus(f) === 'ready' ? FACT_ADD_STYLE_READY : FACT_ADD_STYLE_PARTIAL
        return (
          <ElementRow key={f.id}
            icon={<FactTypeIcon />}
            label={<FactLabel fact={f} otMap={otAndNestedMap} filter={filter} />}
            isOrphaned={isOrphaned(f.id)}
            inCurrentDiagram={inDiag(f.id)}
            onSelect={(e) => selectEl(e, f.id, 'fact')}
            onAdd={() => store.addElementToDiagram(f.id, diagram?.id)}
            onAddExtra={diagram ? () => store.addExtraOccurrence(f.id, diagram.id) : undefined}
            addButtonStyle={fAddStyle}
            onDelete={() => openDeleteFromSchema([f.id])}
          />
        )
      },
    },
    {
      title: 'Subtype Relationships',
      items: showOrphans ? subtypeEdges.filter(st => isStOrphaned(st))
           : showReady   ? subtypeEdges.filter(st => !subtypeInDiag(st) && inDiag(st.subId) && inDiag(st.superId))
           : subtypeEdges,
      match: (st) => filter.test(otAndNestedMap[st.subId]?.name, otAndNestedMap[st.superId]?.name),
      renderRow: (st) => {
        const subName  = otAndNestedMap[st.subId]?.name  ?? '?'
        const supName  = otAndNestedMap[st.superId]?.name ?? '?'
        const alreadyIn = subtypeInDiag(st)
        const endpointsPresent = inDiag(st.subId) && inDiag(st.superId)
        const allCoveredSt = subtypeAllCombinationsCovered(st)
        const stAddStyle = alreadyIn ? undefined
          : endpointsPresent
            ? { color: '#166534', borderColor: '#16a34a', background: 'rgba(22,163,74,0.07)' }
            : { color: '#92400e', borderColor: '#d97706', background: 'rgba(217,119,6,0.07)' }
        const stAddFn = () => {
          const occs = diagram?.occurrences ?? []
          const subOccs  = occs.filter(o => o.schemaElementId === st.subId)
          const superOccs = occs.filter(o => o.schemaElementId === st.superId)
          if (subOccs.length > 1 || superOccs.length > 1) {
            store.startSubtypeEndpointPick(st.id, diagram?.id)
          } else {
            store.addElementToDiagram(st.id, diagram?.id)
          }
        }
        return (
          <ElementRow key={st.id}
            icon={<SubtypeIcon />}
            label={<span style={{ fontSize: 11 }}><Highlight text={subName} filter={filter} /> <span style={{ color: 'var(--ink-muted)' }}>⊂</span> <Highlight text={supName} filter={filter} /></span>}
            isOrphaned={isStOrphaned(st)}
            inCurrentDiagram={alreadyIn}
            onSelect={() => selectSubtype(st)}
            onAdd={(!alreadyIn || allCoveredSt) ? stAddFn : undefined}
            onAddExtra={alreadyIn && !allCoveredSt ? stAddFn : undefined}
            addButtonStyle={stAddStyle}
            addButtonDisabled={allCoveredSt ? true : undefined}
            onDelete={() => openDeleteFromSchema([st.id])}
          />
        )
      },
    },
    {
      title: 'External Constraints',
      items: showOrphans ? constraintNodes.filter(c => isCOrphaned(c.id))
           : showReady   ? constraintNodes.filter(c => !cInCurrentDiag(c.id) && constraintDepsStatus(c) === 'ready')
           : constraintNodes,
      // Its name if it has one, else its kind.
      match: (c) => filter.test(c.name?.trim() || c.constraintType),
      renderRow: (c) => {
        const inCurrent = cInCurrentDiag(c.id)
        const allCoveredC = allConstraintCombinationsCovered(c)
        const status = constraintDepsStatus(c)
        const addStyle = inCurrent ? undefined
          : status === 'ready'
            ? { color: '#166534', borderColor: '#16a34a', background: 'rgba(22,163,74,0.07)' }
            : status === 'partial'
              ? { color: '#92400e', borderColor: '#d97706', background: 'rgba(217,119,6,0.07)' }
              : undefined
        const cAddFn = () => store.startConstraintEndpointPick(c.id, diagram?.id)
        return (
          <ElementRow key={c.id}
            icon={CONSTRAINT_ICON_MAP[c.constraintType] ?? <UniquenessConstraintIcon />}
            label={c.name?.trim()
              ? <span style={{ fontSize: 11 }}><Highlight text={c.name.trim()} filter={filter} />
                  <span style={{ color: 'var(--ink-muted)', fontStyle: 'italic' }}> · {c.constraintType}</span></span>
              : <span style={{ fontSize: 11, color: 'var(--ink-muted)', fontStyle: 'italic' }}>
                  <Highlight text={c.constraintType} filter={filter} />
                </span>}
            isOrphaned={isCOrphaned(c.id)}
            inCurrentDiagram={inCurrent}
            onSelect={(e) => selectEl(e, c.id, 'constraint')}
            onAdd={(!inCurrent || allCoveredC) ? cAddFn : undefined}
            onAddExtra={inCurrent && !allCoveredC ? cAddFn : undefined}
            addButtonStyle={addStyle}
            addButtonDisabled={allCoveredC ? true : undefined}
            onDelete={() => openDeleteFromSchema([c.id])}
          />
        )
      },
    },
    {
      title: 'Groups',
      count: store.groups.length,
      items: showOrphans || showReady ? [] : [...store.groups, NEW_GROUP_ROW],
      match: (g) => g !== NEW_GROUP_ROW && filter.test(g.name),
      renderRow: (g) => g === NEW_GROUP_ROW ? (
        <div key="__newGroup" onClick={() => store.addGroup()}
          style={{ padding: '3px 8px 3px 35px', fontSize: 11, color: 'var(--ink-muted)', cursor: 'pointer',
            borderBottom: '1px solid var(--border-soft)', fontFamily: FONT }}
          onMouseEnter={e => { e.currentTarget.style.background = 'var(--bg-raised)' }}
          onMouseLeave={e => { e.currentTarget.style.background = '' }}>
          + New group
        </div>
      ) : (
        <ElementRow key={g.id}
          icon={<GroupIcon group={g} />}
          label={<span style={{ fontSize: 11 }}>
            {g.name ? <Highlight text={g.name} filter={filter} /> : <i style={{ color: 'var(--ink-muted)' }}>(unnamed group)</i>}
            <span style={{ color: 'var(--ink-muted)' }}> · {g.members.length}</span>
          </span>}
          isOrphaned={false}
          inCurrentDiagram={true}
          onSelect={() => store.select(g.id, 'group')}
          onAdd={null}
          onDelete={() => store.deleteGroup(g.id)}
          deleteTitle="Delete group"
        />
      ),
    },
    {
      title: 'Notes',
      items: showOrphans || showReady ? [] : (diagram?.notes ?? []),
      match: (note) => filter.test(note.text),
      renderRow: (note) => {
        // Under a filter, the first line that matches.
        const lines = (note.text || '').split('\n')
        const line = (filter && lines.find(l => filter.test(l))) ?? lines[0]
        const preview = line.slice(0, 40) || '(empty)'
        return (
          <ElementRow key={note.id}
            icon={<NoteIcon />}
            label={<span style={{ fontSize: 11, fontStyle: note.text ? 'normal' : 'italic',
              color: note.text ? 'var(--ink-2)' : 'var(--ink-muted)' }}><Highlight text={preview} filter={filter} /></span>}
            isOrphaned={false}
            inCurrentDiagram={true}
            onSelect={() => { store.select(note.id, 'note'); store.centerOnElement(note.id) }}
            onAdd={null}
            onDelete={() => store.deleteNote(note.id)}
            deleteTitle="Delete note"
          />
        )
      },
    },
  ].map(s => !filter || !s.match ? s
      : { ...s, count: undefined, total: s.title === 'Groups' ? store.groups.length : s.items.length, items: s.items.filter(s.match) })
    .filter(s => s.items.length > 0)
    // An empty schema just says so, without the lone "+ New group" row.
    .filter((s, _, all) => s.title !== 'Groups' || s.count > 0 || all.length > 1)

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
          {readyCount > 0 && (
            <span style={{
              background: '#16a34a', color: 'white',
              borderRadius: 8, fontSize: 9, padding: '0 4px', lineHeight: '14px',
              minWidth: 14, textAlign: 'center',
            }}>{readyCount}</span>
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
              {mapping ? '⠿ mapping rules'
                : <>⠿ schema browser{(store.schemas?.length ?? 0) > 1 && ` · ${store.schemas.find(x => x.id === activeSchemaIdOf(store))?.name ?? ''}`}</>}
            </span>
            <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              {readyCount > 0 && (
                <span
                  onClick={() => { setShowReady(p => !p); setShowOrphans(false) }}
                  title={showReady ? 'Show all elements' : 'Show only ready-to-add subtypes and constraints'}
                  style={{
                    fontSize: 9,
                    color: showReady ? 'white' : '#16a34a',
                    border: '1px solid #16a34a',
                    borderRadius: 3, padding: '0 4px', lineHeight: '14px',
                    cursor: 'pointer',
                    background: showReady ? '#16a34a' : 'transparent',
                  }}
                >
                  {readyCount} ready
                </span>
              )}
              {allOrphanCount > 0 && (
                <span
                  onClick={() => { setShowOrphans(p => !p); setShowReady(false) }}
                  title={mapping ? (showOrphans ? 'Show all rules' : 'Show only rules on no diagram of this mapping')
                    : showOrphans ? 'Show all elements' : 'Show only orphans'}
                  style={{
                    fontSize: 9,
                    color: showOrphans ? 'white' : 'var(--danger)',
                    border: '1px solid var(--danger)',
                    borderRadius: 3,
                    padding: '0 4px',
                    lineHeight: '14px',
                    cursor: 'pointer',
                    background: showOrphans ? 'var(--danger)' : 'transparent',
                    whiteSpace: 'nowrap',
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

          {/* Name filter */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '4px 6px',
            borderBottom: '1px solid var(--border-soft)', flexShrink: 0 }}>
            <input ref={searchRef} value={query} placeholder={mapping ? 'Filter rules' : 'Filter by name'}
              title={mapping ? 'Show only rules whose name or formula contains this text (⌘F / Ctrl+F)'
                : 'Show only elements whose name contains this text (⌘F / Ctrl+F)'}
              onChange={e => setQuery(e.target.value)}
              onKeyDown={e => {
                if (e.key !== 'Escape') return
                e.stopPropagation()
                if (query) setQuery(''); else e.currentTarget.blur()
              }}
              style={{ flex: 1, minWidth: 0, fontSize: 11, fontFamily: FONT, padding: '2px 6px',
                border: '1px solid var(--border)', borderRadius: 3, background: 'var(--bg-surface)', color: 'var(--ink)' }} />
            {query && (
              <button onClick={() => { setQuery(''); searchRef.current?.focus() }} title="Clear filter"
                style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '0 2px',
                  fontSize: 13, lineHeight: 1, color: 'var(--ink-muted)' }}>×</button>
            )}
          </div>

          {/* Element list */}
          <div style={{ overflowY: 'auto', flex: 1 }}>
            {sections.length === 0 ? (
              <div style={{ padding: 10, fontSize: 11, color: 'var(--ink-muted)', textAlign: 'center' }}>
                {filter ? `No ${mapping ? 'rules' : 'elements'} match “${query.trim()}”.`
                  : mapping ? (showOrphans ? 'Every rule is on a diagram.' : 'This mapping has no rules yet.') : 'Schema is empty.'}
              </div>
            ) : sections.map(sec => (
              <div key={sec.title}>
                <SectionHeader title={sec.title} count={sec.count ?? sec.items.length} total={sec.total} />
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

      {occPicker && (
        <div
          onMouseDown={e => e.stopPropagation()}
          style={{
            position: 'fixed',
            left: occPicker.x,
            top: occPicker.y,
            background: 'var(--bg-panel)',
            border: '1px solid var(--border)',
            borderRadius: 6,
            boxShadow: '0 2px 10px rgba(0,0,0,0.18)',
            padding: '6px 8px',
            zIndex: 9999,
            fontFamily: FONT,
          }}
        >
          <div style={{ fontSize: 11, color: 'var(--ink-muted)', marginBottom: 5 }}>
            Select occurrence:
          </div>
          <div style={{ display: 'flex', gap: 5 }}>
            {occPicker.occs.map((occ, i) => (
              <button
                key={occ.id}
                onClick={() => {
                  store.select(occPicker.id, occPicker.kind, occ.id)
                  store.centerOnOccurrence(occ.id)
                  setOccPicker(null)
                }}
                style={{
                  width: 28, height: 28,
                  border: '1px solid var(--border)',
                  borderRadius: 4,
                  background: 'var(--bg-raised)',
                  cursor: 'pointer',
                  fontSize: 13,
                  fontWeight: 600,
                  color: 'var(--ink)',
                }}
              >
                {i + 1}
              </button>
            ))}
          </div>
        </div>
      )}
      {rowMenu && createPortal(<ContextMenu x={rowMenu.x} y={rowMenu.y} items={rowMenu.items} onClose={() => setRowMenu(null)}/>, document.body)}
    </>
  )
}
