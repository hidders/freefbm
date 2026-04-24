import React, { useMemo, useCallback, useRef, useState, useEffect } from 'react'
import { useOrmStore } from '../store/ormStore'
import { useDiagramElements } from '../hooks/useDiagramElements'
import { entityBounds, computeOtSize } from './ObjectTypeNode'
import { factBounds } from './FactTypeNode'

const MM_W  = 170
const MM_H  = 110
const PAD   = 30
const HDR_H = 20   // header bar height

export default function Minimap() {
  const store = useOrmStore()
  const { objectTypes: visOts, facts: visFacts, constraints: visCons, subtypes: visSubs } = useDiagramElements()

  const [collapsed, setCollapsed] = useState(false)

  // ── drag-to-move state ────────────────────────────────────────────────────
  const dragRef  = useRef(null)
  const panelRef = useRef(null)

  const [parentSize, setParentSize] = useState({ w: 1200, h: 700 })

  useEffect(() => {
    const el = panelRef.current?.parentElement
    if (!el) return
    const obs = new ResizeObserver(([e]) => {
      setParentSize({ w: e.contentRect.width, h: e.contentRect.height })
    })
    obs.observe(el)
    return () => obs.disconnect()
  }, [])

  const defaultX = window.innerWidth - MM_W - 250   // leave room for inspector (240px) + gap
  const defaultY = window.innerHeight - MM_H - HDR_H - 36  // above status bar (~26px) + gap

  const posX = store.minimapPos.x ?? defaultX
  const posY = store.minimapPos.y ?? defaultY

  const handleHeaderMouseDown = useCallback((e) => {
    if (e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()
    dragRef.current = {
      startMouseX: e.clientX,
      startMouseY: e.clientY,
      startPosX:   posX,
      startPosY:   posY,
    }

    const onMove = (me) => {
      if (!dragRef.current) return
      const { startMouseX, startMouseY, startPosX, startPosY } = dragRef.current
      const newX = Math.max(0, Math.min(window.innerWidth  - MM_W - 2,  startPosX + me.clientX - startMouseX))
      const newY = Math.max(0, Math.min(window.innerHeight - MM_H - HDR_H - 2, startPosY + me.clientY - startMouseY))
      store.setMinimapPos(newX, newY)
    }

    const onUp = () => {
      dragRef.current = null
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }

    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }, [posX, posY, store])

  // ── diagram bounds ────────────────────────────────────────────────────────
  const bounds = useMemo(() => {
    const all = [
      ...visOts.map(ot => {
        const b = entityBounds(ot)
        return { minX: b.left, minY: b.top, maxX: b.right, maxY: b.bottom }
      }),
      ...visFacts.map(f => {
        const b = factBounds(f)
        return { minX: b.left, minY: b.top, maxX: b.right, maxY: b.bottom }
      }),
      ...visCons.map(c => ({
        minX: c.x - 20, minY: c.y - 20, maxX: c.x + 20, maxY: c.y + 20,
      })),
    ]
    if (!all.length) return { minX: 0, minY: 0, maxX: 800, maxY: 600 }
    return {
      minX: Math.min(...all.map(b => b.minX)) - PAD,
      minY: Math.min(...all.map(b => b.minY)) - PAD,
      maxX: Math.max(...all.map(b => b.maxX)) + PAD,
      maxY: Math.max(...all.map(b => b.maxY)) + PAD,
    }
  }, [visOts, visFacts, visCons])

  const worldW = bounds.maxX - bounds.minX || 800
  const worldH = bounds.maxY - bounds.minY || 600
  const scale  = Math.min(MM_W / worldW, MM_H / worldH)

  const wx = (x) => (x - bounds.minX) * scale
  const wy = (y) => (y - bounds.minY) * scale

  // Viewport rect in world space
  const vW = parentSize.w / store.zoom
  const vH = parentSize.h / store.zoom
  const vX = -store.pan.x / store.zoom
  const vY = -store.pan.y / store.zoom

  // Click on SVG body → pan canvas to that world position
  const handleSVGClick = useCallback((e) => {
    if (dragRef.current) return
    const rect = e.currentTarget.getBoundingClientRect()
    const worldX = (e.clientX - rect.left)  / scale + bounds.minX
    const worldY = (e.clientY - rect.top)   / scale + bounds.minY
    store.setPan(
      -(worldX * store.zoom) + parentSize.w / 2,
      -(worldY * store.zoom) + parentSize.h / 2,
    )
  }, [scale, bounds, store, parentSize])

  // ── visibility guard ──────────────────────────────────────────────────────
  const isEmpty = visOts.length === 0 && visFacts.length === 0
  if (isEmpty) return null

  const TRANSITION = 'opacity 0.2s ease, transform 0.2s ease'

  return (
    <>
      {/* ── Collapsed pill ── */}
      <button
        onClick={() => setCollapsed(false)}
        title="Open minimap"
        style={{
          position: 'fixed',
          bottom: 34,
          right: 258,
          zIndex: 10,
          display: 'flex', alignItems: 'center', gap: 5,
          padding: '3px 10px',
          background: 'var(--bg-raised)',
          border: '1px solid var(--border)',
          borderRadius: 12,
          boxShadow: 'var(--shadow-md)',
          cursor: 'pointer',
          fontSize: 10,
          color: 'var(--ink-muted)',
          letterSpacing: '0.05em',
          fontFamily: "'Segoe UI', Helvetica, Arial, sans-serif",
          userSelect: 'none',
          opacity: collapsed ? 0.9 : 0,
          transform: collapsed ? 'scale(1)' : 'scale(0.9)',
          pointerEvents: collapsed ? 'auto' : 'none',
          transition: TRANSITION,
        }}
      >
        <span style={{ fontSize: 12 }}>⊟</span>
        <span style={{ textTransform: 'uppercase' }}>Minimap</span>
        <span style={{ fontSize: 9, color: 'var(--ink-muted)' }}>
          {Math.round(store.zoom * 100)}%
        </span>
      </button>

      {/* ── Expanded panel ── */}
      <div
        ref={panelRef}
        style={{
          position: 'fixed',
          left: posX,
          top:  posY,
          width: MM_W + 2,
          background: 'var(--bg-surface)',
          border: '1px solid var(--border)',
          borderRadius: 6,
          overflow: 'hidden',
          boxShadow: 'var(--shadow-md)',
          userSelect: 'none',
          zIndex: 10,
          WebkitAppRegion: 'no-drag',
          opacity: collapsed ? 0 : 0.93,
          transform: collapsed ? 'scale(0.95)' : 'scale(1)',
          pointerEvents: collapsed ? 'none' : 'auto',
          transition: TRANSITION,
          transformOrigin: 'bottom right',
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
        }}
      >
        <span style={{ fontSize: 9, color: 'var(--ink-muted)',
          letterSpacing: '0.07em', textTransform: 'uppercase',
          pointerEvents: 'none' }}>
          ⠿ minimap
        </span>
        <span style={{ fontSize: 9, color: 'var(--ink-muted)', pointerEvents: 'none' }}>
          {Math.round(store.zoom * 100)}%
        </span>
        <button
          onMouseDown={e => e.stopPropagation()}
          onClick={() => setCollapsed(true)}
          title="Collapse minimap"
          style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '0 2px',
            fontSize: 11, lineHeight: 1, color: 'var(--ink-muted)', pointerEvents: 'all' }}
        >−</button>
      </div>

      {/* SVG thumbnail */}
      <svg
        width={MM_W} height={MM_H}
        onClick={handleSVGClick}
        style={{ display: 'block', cursor: 'crosshair' }}
      >
        <rect width={MM_W} height={MM_H} fill="var(--bg-canvas)"/>

        {/* Role connectors */}
        {(() => {
          const nestedMap = Object.fromEntries(visFacts.filter(f => f.objectified).map(f => [f.id, f]))
          return visFacts.flatMap(fact =>
            fact.roles.map((role, ri) => {
              const ot = visOts.find(o => o.id === role.objectTypeId)
              const nf = !ot ? nestedMap[role.objectTypeId] : null
              const player = ot ?? nf
              if (!player) return null
              return (
                <line key={`${fact.id}-${ri}`}
                  x1={wx(player.x)} y1={wy(player.y)} x2={wx(fact.x)} y2={wy(fact.y)}
                  stroke="var(--col-fact)" strokeWidth={0.6} strokeOpacity={0.4}/>
              )
            }).filter(Boolean)
          )
        })()}

        {/* Subtype arrows */}
        {(() => {
          const nestedMap = Object.fromEntries(visFacts.filter(f => f.objectified).map(f => [f.id, f]))
          const playerXY = (id) => {
            const ot = visOts.find(o => o.id === id)
            if (ot) return ot
            return nestedMap[id] ?? null
          }
          return visSubs.map(st => {
            const sub = playerXY(st.subId)
            const sup = playerXY(st.superId)
            if (!sub || !sup) return null
            return (
              <line key={st.id}
                x1={wx(sub.x)} y1={wy(sub.y)} x2={wx(sup.x)} y2={wy(sup.y)}
                stroke="var(--col-subtype)" strokeWidth={0.8} strokeOpacity={0.5}/>
            )
          })
        })()}

        {/* Entity / value types */}
        {visOts.map(ot => {
          const isSel = store.selectedId === ot.id
          const { w: otW, h: otH } = computeOtSize(ot)
          const ew = Math.max(4, otW * scale), eh = Math.max(2, otH * scale)
          return (
            <rect key={ot.id}
              x={wx(ot.x) - ew/2} y={wy(ot.y) - eh/2} width={ew} height={eh} rx={2}
              fill={isSel ? 'var(--accent)' : 'var(--bg-raised)'}
              stroke={isSel ? 'var(--accent)' : (ot.kind === 'value' ? 'var(--col-value)' : 'var(--col-entity)')}
              strokeWidth={isSel ? 1.5 : 0.8} fillOpacity={isSel ? 0.5 : 1}
              strokeDasharray={ot.kind === 'value' ? '3 1.5' : 'none'}/>
          )
        })}

        {/* Fact types */}
        {visFacts.map(f => {
          const isSel = store.selectedId === f.id
          const fw = Math.max(2, f.arity * 30 * scale)
          const fh = Math.max(2, 30 * scale)
          return (
            <rect key={f.id}
              x={wx(f.x) - fw/2} y={wy(f.y) - fh/2} width={fw} height={fh} rx={1}
              fill={isSel ? 'var(--accent)' : '#f0ede8'}
              stroke={isSel ? 'var(--accent)' : 'var(--col-fact)'}
              strokeWidth={isSel ? 1.5 : 0.7} fillOpacity={isSel ? 0.5 : 1}/>
          )
        })}

        {/* Constraint connectors (all types) + target object type edges */}
        {(() => {
          const otMap      = Object.fromEntries(visOts.map(o => [o.id, o]))
          const nestedMap  = Object.fromEntries(visFacts.filter(f => f.objectified).map(f => [f.id, f]))
          const subtypeMap = Object.fromEntries(visSubs.map(st => [st.id, st]))
          const factMap    = Object.fromEntries(visFacts.map(f => [f.id, f]))

          return visCons.flatMap(c => {
            const lines = []

            if (c.sequences != null) {
              ;(c.sequences || []).forEach((seq, gi) => {
                seq.forEach((m, mi) => {
                  const key = `${c.id}-g${gi}-m${mi}`
                  if (m.kind === 'subtype') {
                    const st = subtypeMap[m.subtypeId]
                    if (!st) return
                    const subOt = otMap[st.subId], supOt = otMap[st.superId]
                    if (!subOt || !supOt) return
                    lines.push(<line key={key}
                      x1={wx(c.x)} y1={wy(c.y)}
                      x2={wx((subOt.x + supOt.x) / 2)} y2={wy((subOt.y + supOt.y) / 2)}
                      stroke="var(--col-constraint)" strokeWidth={0.6}
                      strokeDasharray="2 1.5" strokeOpacity={0.7}/>)
                  } else if (m.kind === 'role') {
                    const fact = factMap[m.factId]
                    if (!fact) return
                    lines.push(<line key={key}
                      x1={wx(c.x)} y1={wy(c.y)}
                      x2={wx(fact.x)} y2={wy(fact.y)}
                      stroke="var(--col-constraint)" strokeWidth={0.6}
                      strokeDasharray="2 1.5" strokeOpacity={0.7}/>)
                  }
                })
              })
            } else if (c.roleSequences != null) {
              ;(c.roleSequences || []).forEach((seq, gi) => {
                seq.forEach((ref, ri) => {
                  const fact = factMap[ref.factId]
                  if (!fact) return
                  lines.push(<line key={`${c.id}-g${gi}-r${ri}`}
                    x1={wx(c.x)} y1={wy(c.y)}
                    x2={wx(fact.x)} y2={wy(fact.y)}
                    stroke="var(--col-constraint)" strokeWidth={0.6}
                    strokeDasharray="2 1.5" strokeOpacity={0.7}/>)
                })
              })
            }

            if (store.showTargetConnectors && c.targetObjectTypeId) {
              const ot = otMap[c.targetObjectTypeId] ?? nestedMap[c.targetObjectTypeId]
              if (ot) lines.push(<line key={`${c.id}-target`}
                x1={wx(c.x)} y1={wy(c.y)}
                x2={wx(ot.x)} y2={wy(ot.y)}
                stroke="var(--col-constraint)" strokeWidth={0.6}
                strokeDasharray="2 1.5" strokeOpacity={0.7}/>)
            }

            return lines
          })
        })()}

        {/* Constraint nodes */}
        {visCons.map(c => {
          const isSubtype = c.constraintType === 'exclusiveOr' || c.constraintType === 'exclusion' || c.constraintType === 'inclusiveOr'
          const r = Math.max(1.5, (isSubtype ? 8 : 14) * scale)
          return (
            <circle key={c.id} cx={wx(c.x)} cy={wy(c.y)} r={r}
              fill="var(--bg-canvas)" stroke="var(--col-constraint)" strokeWidth={0.7}/>
          )
        })}

        {/* Viewport rect */}
        <rect
          x={Math.max(0, wx(vX))} y={Math.max(0, wy(vY))}
          width={Math.min(MM_W, vW * scale)} height={Math.min(MM_H, vH * scale)}
          fill="none" stroke="var(--ink-3)"
          strokeWidth={1} strokeOpacity={0.4} strokeDasharray="3 2"/>
      </svg>
      </div>
    </>
  )
}
