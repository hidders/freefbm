import React, { useState, useRef, useCallback } from 'react'
import { useOrmStore } from '../store/ormStore'
import { useDiagramElements } from '../hooks/useDiagramElements'

const FONT = "'Segoe UI', Helvetica, Arial, sans-serif"

function FactReading({ fact, otMap }) {
  const parts = fact.readingParts || Array(fact.arity + 1).fill('')
  const n = fact.arity
  const hasAnyPart = parts.some(p => p?.trim())
  if (!hasAnyPart) {
    const label = fact.name || `Fact (${n})`
    return <span style={{ color: 'var(--ink-1)', fontStyle: 'italic', fontSize: 11 }}>{label}</span>
  }
  const tokens = []
  for (let i = 0; i <= n; i++) {
    const seg = parts[i]?.trim()
    if (seg) tokens.push(
      <span key={`s${i}`} style={{ color: '#2a7a2a', fontFamily: FONT, fontSize: 11 }}>{seg}</span>
    )
    if (i < n) {
      const otName = otMap[fact.roles[i]?.objectTypeId]?.name || '?'
      tokens.push(
        <span key={`r${i}`} style={{ color: '#7c4dbd', fontWeight: 700, fontFamily: FONT, fontSize: 11, whiteSpace: 'nowrap' }}>
          {otName}
        </span>
      )
    }
  }
  return (
    <span style={{ display: 'inline-flex', flexWrap: 'wrap', alignItems: 'center', gap: '0.3em', fontSize: 11 }}>
      {tokens}
    </span>
  )
}

const MIN_W  = 160
const MIN_H  = 100
const MAX_W  = 600
const MAX_H  = 800
const HDR_H  = 24
const INIT_W = 220
const INIT_H = 360

const kindLabel = { entity: '□', value: '◇', fact: '▭' }
const kindColor = {
  entity: 'var(--col-entity)',
  value:  'var(--col-value)',
  fact:   'var(--col-fact)',
}

export default function SchemaBrowser() {
  const store = useOrmStore()
  const { diagram, elementIds } = useDiagramElements()

  const diagrams = store.diagrams ?? []

  const [collapsed, setCollapsed] = useState(false)
  const [pos,  setPos]  = useState(null)           // { x, y } | null → default
  const [size, setSize] = useState({ w: INIT_W, h: INIT_H })

  const dragRef   = useRef(null)
  const resizeRef = useRef(null)
  const panelRef  = useRef(null)

  const toolbarBottom = document.getElementById('app-toolbar')?.getBoundingClientRect().bottom ?? 36
  const tabsBottom    = document.getElementById('diagram-tabs')?.getBoundingClientRect().bottom ?? (toolbarBottom + 35)
  const posX = pos?.x ?? Math.max(8, window.innerWidth - 248 - INIT_W - 8)  // top-right of canvas (left of inspector)
  const posY = pos?.y ?? (tabsBottom + 8)

  // ── drag to move ─────────────────────────────────────────────────────────
  const handleHeaderMouseDown = useCallback((e) => {
    if (e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()
    dragRef.current = {
      startMouseX: e.clientX, startMouseY: e.clientY,
      startPosX: posX, startPosY: posY,
    }
    const onMove = (me) => {
      if (!dragRef.current) return
      const { startMouseX, startMouseY, startPosX, startPosY } = dragRef.current
      setPos({
        x: Math.max(0, Math.min(window.innerWidth  - size.w - 2, startPosX + me.clientX - startMouseX)),
        y: Math.max(0, Math.min(window.innerHeight - size.h - 2, startPosY + me.clientY - startMouseY)),
      })
    }
    const onUp = () => {
      dragRef.current = null
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup',   onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup',   onUp)
  }, [posX, posY, size.w, size.h])

  // ── resize ────────────────────────────────────────────────────────────────
  const handleResizeMouseDown = useCallback((e, dir) => {
    if (e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()
    resizeRef.current = {
      dir,
      startX: e.clientX, startY: e.clientY,
      startW: size.w,    startH: size.h,
    }
    const onMove = (me) => {
      if (!resizeRef.current) return
      const { dir, startX, startY, startW, startH } = resizeRef.current
      const dx = me.clientX - startX
      const dy = me.clientY - startY
      setSize({
        w: (dir === 'e' || dir === 'se')
          ? Math.max(MIN_W, Math.min(MAX_W, startW + dx)) : startW,
        h: (dir === 's' || dir === 'se')
          ? Math.max(MIN_H, Math.min(MAX_H, startH + dy)) : startH,
      })
    }
    const onUp = () => {
      resizeRef.current = null
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup',   onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup',   onUp)
  }, [size])

  // Only relevant when multiple diagrams exist
  if (diagrams.length <= 1) return null

  const otMap = Object.fromEntries(store.objectTypes.map(o => [o.id, o]))

  const factReadingText = (fact) => {
    const parts = fact.readingParts || []
    const n = fact.arity
    const hasAnyPart = parts.some(p => p?.trim())
    if (!hasAnyPart) return fact.name || ''
    const tokens = []
    for (let i = 0; i <= n; i++) {
      const seg = parts[i]?.trim()
      if (seg) tokens.push(seg)
      if (i < n) tokens.push(otMap[fact.roles[i]?.objectTypeId]?.name || '?')
    }
    return tokens.join(' ')
  }

  const entityGroup = [
    ...store.objectTypes.filter(o => !elementIds.has(o.id) && o.kind !== 'value').map(o => ({
      id: o.id, label: o.name || '(unnamed)', kind: 'entity', fact: null,
    })),
    ...store.facts.filter(f => !elementIds.has(f.id) && f.objectified && f.objectifiedKind !== 'value').map(f => ({
      id: f.id, label: f.objectifiedName || '(unnamed)', kind: 'entity', fact: null,
    })),
  ].sort((a, b) => a.label.localeCompare(b.label))

  const valueGroup = [
    ...store.objectTypes.filter(o => !elementIds.has(o.id) && o.kind === 'value').map(o => ({
      id: o.id, label: o.name || '(unnamed)', kind: 'value', fact: null,
    })),
    ...store.facts.filter(f => !elementIds.has(f.id) && f.objectified && f.objectifiedKind === 'value').map(f => ({
      id: f.id, label: f.objectifiedName || '(unnamed)', kind: 'value', fact: null,
    })),
  ].sort((a, b) => a.label.localeCompare(b.label))

  const factGroup = store.facts
    .filter(f => !elementIds.has(f.id) && !f.objectified)
    .map(f => ({ id: f.id, label: null, kind: 'fact', fact: f, sortKey: factReadingText(f) }))
    .sort((a, b) => a.sortKey.localeCompare(b.sortKey))

  const notInDiagram = [...entityGroup, ...valueGroup, ...factGroup]

  const TRANSITION = 'opacity 0.2s ease, transform 0.2s ease'

  // Shared resize handle style
  const rHandle = (dir, extra) => ({
    position: 'absolute', zIndex: 2,
    ...(dir === 'e'  ? { right: 0, top: 0, bottom: 0, width: 5, cursor: 'ew-resize' } : {}),
    ...(dir === 's'  ? { bottom: 0, left: 0, right: 0, height: 5, cursor: 'ns-resize' } : {}),
    ...(dir === 'se' ? { bottom: 0, right: 0, width: 12, height: 12, cursor: 'nwse-resize' } : {}),
    ...extra,
  })

  return (
    <>
      {/* ── Collapsed pill ── */}
      <button
        onClick={() => setCollapsed(false)}
        title="Open schema browser"
        style={{
          position: 'fixed',
          bottom: 34, right: 376,
          zIndex: 10,
          display: 'flex', alignItems: 'center', gap: 5,
          padding: '3px 10px',
          background: 'var(--bg-raised)',
          border: '1px solid var(--border)',
          borderRadius: 12,
          boxShadow: 'var(--shadow-md)',
          cursor: 'pointer',
          fontSize: 10, color: 'var(--ink-muted)',
          letterSpacing: '0.05em',
          fontFamily: FONT,
          userSelect: 'none',
          opacity: collapsed ? 0.9 : 0,
          transform: collapsed ? 'scale(1)' : 'scale(0.9)',
          pointerEvents: collapsed ? 'auto' : 'none',
          transition: TRANSITION,
        }}
      >
        <span style={{ fontSize: 12 }}>⊞</span>
        <span style={{ textTransform: 'uppercase' }}>Schema</span>
        {notInDiagram.length > 0 && (
          <span style={{
            background: 'var(--col-subtype)', color: 'white',
            borderRadius: 8, fontSize: 9, padding: '0 4px', lineHeight: '14px',
            minWidth: 14, textAlign: 'center',
          }}>
            {notInDiagram.length}
          </span>
        )}
      </button>

      {/* ── Expanded panel ── */}
      <div
        ref={panelRef}
        style={{
          position: 'fixed',
          left: posX, top: posY,
          width: size.w, height: size.h,
          background: 'var(--bg-surface)',
          border: '1px solid var(--border)',
          borderRadius: 6,
          overflow: 'hidden',
          boxShadow: 'var(--shadow-md)',
          userSelect: 'none',
          zIndex: 10,
          WebkitAppRegion: 'no-drag',
          display: 'flex',
          flexDirection: 'column',
          fontFamily: FONT,
          opacity: collapsed ? 0 : 0.95,
          transform: collapsed ? 'scale(0.95)' : 'scale(1)',
          pointerEvents: collapsed ? 'none' : 'auto',
          transition: TRANSITION,
          transformOrigin: 'top left',
        }}
      >
        {/* Drag handle header */}
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
            <span style={{ fontSize: 9, color: 'var(--ink-muted)', pointerEvents: 'none' }}>
              {notInDiagram.length} hidden
            </span>
            <button
              onMouseDown={e => e.stopPropagation()}
              onClick={() => setCollapsed(true)}
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
          {notInDiagram.length === 0 ? (
            <div style={{ padding: '10px', fontSize: 11, color: 'var(--ink-muted)', textAlign: 'center' }}>
              All elements shown.
            </div>
          ) : (
            [
              ...entityGroup,
              ...(valueGroup.length > 0 && entityGroup.length > 0 ? [{ id: '__div_v', divider: 'Value Types' }] : []),
              ...valueGroup,
              ...(factGroup.length > 0 && (entityGroup.length > 0 || valueGroup.length > 0) ? [{ id: '__div_f', divider: 'Fact Types' }] : []),
              ...factGroup,
            ].map(el => el.divider ? (
              <div key={el.id} style={{ borderTop: '2px solid var(--border)' }} />
            ) : (
              <div key={el.id}
                style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                  padding: '4px 8px',
                  borderBottom: '1px solid var(--border-soft)',
                  fontSize: 11,
                }}
              >
                <span style={{ display: 'flex', alignItems: 'center', gap: 5, minWidth: 0, flex: 1 }}>
                  <span style={{ color: kindColor[el.kind], fontSize: 12, flexShrink: 0 }}>
                    {kindLabel[el.kind]}
                  </span>
                  {el.fact
                    ? <FactReading fact={el.fact} otMap={otMap} />
                    : <span style={{ color: '#7c4dbd', fontWeight: 700, overflow: 'hidden',
                        textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {el.label}
                      </span>
                  }
                </span>
                <button
                  onMouseDown={e => e.stopPropagation()}
                  onClick={() => store.addElementToDiagram(el.id, diagram?.id)}
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
                >
                  Add
                </button>
              </div>
            ))
          )}
        </div>

        {/* Resize handles */}
        <div style={rHandle('e')}  onMouseDown={e => handleResizeMouseDown(e, 'e')} />
        <div style={rHandle('s')}  onMouseDown={e => handleResizeMouseDown(e, 's')} />
        <div style={rHandle('se')} onMouseDown={e => handleResizeMouseDown(e, 'se')} />
      </div>
    </>
  )
}
