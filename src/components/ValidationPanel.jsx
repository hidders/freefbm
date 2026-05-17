import React, { useState, useRef, useCallback, useEffect } from 'react'
import { useOrmStore } from '../store/ormStore'
import { VALIDATION_CATEGORIES } from '../utils/validation.js'

const FONT   = "'Segoe UI', Helvetica, Arial, sans-serif"
const HDR_H  = 24
const MIN_W  = 200
const MIN_H  = 100
const MAX_W  = 640
const MAX_H  = 800
const INIT_W = 280
const INIT_H = 320

const SEV_COLOUR = { error: '#dc2626', warning: '#d97706' }
const SEV_ICON   = { error: '✕', warning: '!' }

const rHandle = (dir) => ({
  position: 'absolute', zIndex: 2,
  ...(dir === 'e'  ? { right: 0, top: 0, bottom: 0, width: 5, cursor: 'ew-resize' } : {}),
  ...(dir === 'w'  ? { left: 0, top: 0, bottom: 0, width: 5, cursor: 'ew-resize' } : {}),
  ...(dir === 'n'  ? { top: 0, left: 0, right: 0, height: 5, cursor: 'ns-resize' } : {}),
  ...(dir === 's'  ? { bottom: 0, left: 0, right: 0, height: 5, cursor: 'ns-resize' } : {}),
  ...(dir === 'se' ? { bottom: 0, right: 0, width: 12, height: 12, cursor: 'nwse-resize' } : {}),
  ...(dir === 'sw' ? { bottom: 0, left: 0, width: 12, height: 12, cursor: 'nesw-resize' } : {}),
})

export default function ValidationPanel() {
  const store = useOrmStore()

  const [collapsed,  setCollapsed]  = useState(false)
  const [animating,  setAnimating]  = useState(false)
  const [resizing,   setResizing]   = useState(false)
  const [size,       setSize]       = useState({ w: INIT_W, h: INIT_H })
  const [pos,        setPos]        = useState(null)
  const [expandFrom, setExpandFrom] = useState(null)
  const [winW,       setWinW]       = useState(window.innerWidth)
  const [winH,       setWinH]       = useState(window.innerHeight)

  const animTimerRef = useRef(null)
  const dragRef      = useRef(null)
  const resizeRef    = useRef(null)
  const panelRef     = useRef(null)

  useEffect(() => {
    const onResize = () => { setWinW(window.innerWidth); setWinH(window.innerHeight) }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  // ── layout (fixed positioning, same as SchemaBrowser) ────────────────────
  const inspectorWidth = store.inspectorWidth
  const PILL_W         = 140
  const SCHEMA_PILL_W  = 128
  const MINIMAP_PILL_W = 114

  const pillLeft = winW - inspectorWidth - MINIMAP_PILL_W - 12 - SCHEMA_PILL_W - 8 - PILL_W
  const pillTop  = winH - 26 - 8 - HDR_H

  const posX = pos?.x ?? Math.max(8, pillLeft - size.w + PILL_W)
  const posY = pos?.y ?? Math.max(8, pillTop  - size.h - 8)

  const panelW = collapsed ? PILL_W : size.w
  const panelH = collapsed ? HDR_H  : size.h
  const panelR = collapsed ? HDR_H / 2 : 6

  const displayLeft = expandFrom?.x ?? (collapsed ? pillLeft : posX)
  const displayTop  = expandFrom?.y ?? (collapsed ? pillTop  : posY)

  // ── drag ─────────────────────────────────────────────────────────────────
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
    resizeRef.current = { dir, startX: e.clientX, startY: e.clientY, startW: size.w, startH: size.h, startPosX: posX, startPosY: posY }
    const panelEl = panelRef.current
    const onMove = (me) => {
      if (!resizeRef.current || !panelEl) return
      const { dir, startX, startY, startW, startH, startPosX, startPosY } = resizeRef.current
      const dx = me.clientX - startX, dy = me.clientY - startY
      let newW = startW, newH = startH, newX = startPosX, newY = startPosY
      if (dir === 'e' || dir === 'se') newW = Math.max(MIN_W, Math.min(MAX_W, startW + dx))
      if (dir === 'w' || dir === 'sw') { newW = Math.max(MIN_W, Math.min(MAX_W, startW - dx)); newX = startPosX + (startW - newW) }
      if (dir === 's' || dir === 'se' || dir === 'sw') newH = Math.max(MIN_H, Math.min(MAX_H, startH + dy))
      if (dir === 'n') { newH = Math.max(MIN_H, Math.min(MAX_H, startH - dy)); newY = startPosY + (startH - newH) }
      panelEl.style.left = `${newX}px`; panelEl.style.top = `${newY}px`
      panelEl.style.width = `${newW}px`; panelEl.style.height = `${newH}px`
      resizeRef.current._live = { w: newW, h: newH, x: newX, y: newY }
    }
    const onUp = () => {
      const live = resizeRef.current?._live
      if (live) { setSize({ w: live.w, h: live.h }); setPos({ x: live.x, y: live.y }) }
      resizeRef.current = null; setResizing(false)
      window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup',   onUp)
  }, [posX, posY, size])

  const handleCollapse = useCallback(() => {
    setCollapsed(true); setAnimating(true)
    if (animTimerRef.current) clearTimeout(animTimerRef.current)
    animTimerRef.current = setTimeout(() => setAnimating(false), 350)
  }, [])

  const handleExpand = useCallback(() => {
    const pLeft = window.innerWidth - store.inspectorWidth - 114 - 12 - 128 - 8 - 140
    const pTop  = window.innerHeight - 26 - 8 - HDR_H
    setExpandFrom({ x: pLeft, y: pTop }); setCollapsed(false); setAnimating(true)
    if (animTimerRef.current) clearTimeout(animTimerRef.current)
    animTimerRef.current = setTimeout(() => setAnimating(false), 350)
    requestAnimationFrame(() => requestAnimationFrame(() => setExpandFrom(null)))
  }, [store.inspectorWidth])

  // ── data ──────────────────────────────────────────────────────────────────
  const errors = store.validationErrors || []
  const errorCount = errors.length
  const byCategory = {}
  for (const e of errors) {
    if (!byCategory[e.category]) byCategory[e.category] = []
    byCategory[e.category].push(e)
  }
  const navigate = (e) => store.navigateToElement(e.elementId, e.elementKind)

  // ── render ────────────────────────────────────────────────────────────────
  return (
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
      {/* Pill label — visible when collapsed */}
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
        <span style={{ fontSize: 11 }}>⚠</span>
        <span>validation</span>
        {errorCount > 0 && (
          <span style={{
            background: '#dc2626', color: 'white',
            borderRadius: 8, fontSize: 9, padding: '0 4px', lineHeight: '14px',
            minWidth: 14, textAlign: 'center',
          }}>{errorCount}</span>
        )}
      </div>

      {/* Panel content — visible when expanded */}
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
            height: HDR_H, flexShrink: 0,
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            padding: '0 6px',
            borderBottom: '1px solid var(--border-soft)',
            cursor: 'grab',
            background: 'var(--bg-raised)',
          }}
        >
          <span style={{ fontSize: 9, color: 'var(--ink-muted)',
            letterSpacing: '0.07em', textTransform: 'uppercase',
            pointerEvents: 'none' }}>
            ⠿ validation
          </span>
          <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            {errorCount > 0 && (
              <span style={{
                background: '#dc2626', color: 'white',
                borderRadius: 8, fontSize: 9, padding: '0 4px', lineHeight: '14px',
                minWidth: 14, textAlign: 'center',
              }}>{errorCount}</span>
            )}
            <button
              onMouseDown={e => e.stopPropagation()}
              onClick={handleCollapse}
              title="Collapse validation panel"
              style={{
                background: 'none', border: 'none', cursor: 'pointer',
                padding: '0 2px', fontSize: 11, lineHeight: 1,
                color: 'var(--ink-muted)', pointerEvents: 'all',
              }}
            >−</button>
          </div>
        </div>

        {/* Body */}
        <div style={{ flex: 1, overflowY: 'auto', padding: 8, display: 'flex', flexDirection: 'column', gap: 10 }}>
          {errorCount === 0 ? (
            <div style={{ fontSize: 11, color: 'var(--ink-muted)', textAlign: 'center', marginTop: 12 }}>
              No validation errors
            </div>
          ) : (
            Object.entries(byCategory).map(([cat, errs]) => (
              <div key={cat}>
                <div style={{
                  fontSize: 9, fontWeight: 700, letterSpacing: '0.08em',
                  textTransform: 'uppercase', color: 'var(--ink-muted)', marginBottom: 4,
                }}>
                  {VALIDATION_CATEGORIES[cat]?.label ?? cat}
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                  {errs.map(e => (
                    <div key={e.id} onClick={() => navigate(e)} style={{
                      display: 'flex', alignItems: 'flex-start', gap: 6,
                      padding: '5px 7px', borderRadius: 4,
                      background: 'var(--bg-raised)',
                      border: '1px solid var(--border-soft)',
                      borderLeft: `3px solid ${SEV_COLOUR[e.severity]}`,
                      cursor: 'pointer',
                    }}
                      onMouseEnter={ev => ev.currentTarget.style.background = 'var(--bg-hover)'}
                      onMouseLeave={ev => ev.currentTarget.style.background = 'var(--bg-raised)'}
                    >
                      <span style={{ color: SEV_COLOUR[e.severity], fontWeight: 700, fontSize: 9, marginTop: 2, flexShrink: 0 }}>
                        {SEV_ICON[e.severity]}
                      </span>
                      <span style={{ fontSize: 11, color: 'var(--ink-2)', lineHeight: 1.4 }}>{e.message}</span>
                    </div>
                  ))}
                </div>
              </div>
            ))
          )}
        </div>
      </div>

      {/* Resize handles */}
      {!collapsed && ['n','s','e','w','se','sw'].map(dir => (
        <div key={dir} style={rHandle(dir)} onMouseDown={e => handleResizeMouseDown(e, dir)}/>
      ))}
    </div>
  )
}
