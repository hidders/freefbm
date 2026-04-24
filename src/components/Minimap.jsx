import React, { useMemo, useCallback, useRef, useState, useEffect } from 'react'
import { useOrmStore } from '../store/ormStore'
import { useDiagramElements } from '../hooks/useDiagramElements'
import { entityBounds, computeOtSize } from './ObjectTypeNode'
import { factBounds, nestedFactBounds, ROLE_W, ROLE_H, ROLE_GAP } from './FactTypeNode'

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

  const PILL_W = 114
  const panelW = collapsed ? PILL_W    : MM_W + 2
  const panelH = collapsed ? HDR_H     : MM_H + HDR_H + 2
  const panelR = collapsed ? HDR_H / 2 : 6

  // Fixed pill anchor: just above the status bar (26px), to the left of the inspector
  const pillLeft = window.innerWidth  - 258 - PILL_W
  const pillTop  = window.innerHeight - 26 - 8 - HDR_H
  const displayLeft = collapsed ? pillLeft : posX
  const displayTop  = collapsed ? pillTop  : posY

  return (
    <>
      {/* ── Single morphing panel ── */}
      <div
        ref={panelRef}
        onClick={collapsed ? () => setCollapsed(false) : undefined}
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
          cursor: collapsed ? 'pointer' : 'default',
          transition: collapsed
            ? 'width 0.28s ease, height 0.28s ease, border-radius 0.28s ease, left 0.28s ease, top 0.28s ease'
            : 'width 0.28s ease, height 0.28s ease, border-radius 0.28s ease',
        }}
      >
        {/* Pill label (fades in when collapsed) */}
        <div style={{
          position: 'absolute', inset: 0,
          display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 5,
          fontSize: 9, color: 'var(--ink-muted)',
          letterSpacing: '0.05em', textTransform: 'uppercase',
          fontFamily: "'Segoe UI', Helvetica, Arial, sans-serif",
          whiteSpace: 'nowrap',
          opacity: collapsed ? 1 : 0,
          transition: collapsed ? 'opacity 0.14s ease 0.14s' : 'opacity 0.08s ease',
          pointerEvents: 'none',
        }}>
          <span style={{ fontSize: 11 }}>⊟</span>
          <span>minimap</span>
          <span>{Math.round(store.zoom * 100)}%</span>
        </div>

        {/* Panel content (fades out when collapsed) */}
        <div style={{
          opacity: collapsed ? 0 : 1,
          transition: collapsed ? 'opacity 0.1s ease' : 'opacity 0.18s ease 0.12s',
          pointerEvents: collapsed ? 'none' : 'auto',
        }}>

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
          const isSel  = store.selectedId === f.id
          const isV    = f.orientation === 'vertical'
          const n      = Math.max(f.arity, 1)
          const long   = n * ROLE_W + (n - 1) * ROLE_GAP  // role-strip length
          const short  = ROLE_H                             // role-strip thickness
          // core role-bar rect (no bars/padding)
          const rw = Math.max(2, (isV ? short : long) * scale)
          const rh = Math.max(1, (isV ? long  : short) * scale)
          const rx = wx(f.x) - rw / 2
          const ry = wy(f.y) - rh / 2
          if (f.objectified) {
            const nb = nestedFactBounds(f)
            const nw = Math.max(4, (nb.right - nb.left) * scale)
            const nh = Math.max(3, (nb.bottom - nb.top) * scale)
            return (
              <g key={f.id}>
                {/* outer entity box */}
                <rect
                  x={wx(nb.left)} y={wy(nb.top)} width={nw} height={nh} rx={2}
                  fill={isSel ? 'var(--accent)' : 'var(--bg-raised)'}
                  stroke={isSel ? 'var(--accent)' : 'var(--col-entity)'}
                  strokeWidth={isSel ? 1.5 : 0.8} fillOpacity={isSel ? 0.4 : 1}/>
                {/* inner role bar */}
                <rect
                  x={rx} y={ry} width={rw} height={rh} rx={0.5}
                  fill={isSel ? 'var(--accent)' : '#f0ede8'}
                  stroke={isSel ? 'var(--accent)' : 'var(--col-fact)'}
                  strokeWidth={0.5} fillOpacity={isSel ? 0.5 : 1}/>
              </g>
            )
          }
          return (
            <rect key={f.id}
              x={rx} y={ry} width={rw} height={rh} rx={1}
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
        </div>{/* end panel content */}
      </div>{/* end morphing panel */}
    </>
  )
}
