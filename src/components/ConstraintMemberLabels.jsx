import React from 'react'
import { useOrmStore } from '../store/ormStore'
import { useDiagramElements } from '../hooks/useDiagramElements'
import { roleCenter } from './FactTypeNode'
import { entityBounds } from './ObjectTypeNode'

// Constraint types for which sequence-membership labels are shown on the canvas
// (subset of EXTERNAL_CONSTRAINT_TYPES — excludes ring)
const LABELED_CONSTRAINT_TYPES = new Set(['exclusiveOr', 'exclusion', 'inclusiveOr', 'equality', 'subset', 'uniqueness'])
const FONT_SIZE    = 9
const CHAR_W       = 5.5   // approximate mono char width at FONT_SIZE
const PAD_X        = 5
const PAD_Y        = 3

function borderPoint(ot, tx, ty) {
  const b  = entityBounds(ot)
  const cx = b.cx, cy = b.cy
  const dx = tx - cx, dy = ty - cy
  if (dx === 0 && dy === 0) return { x: cx, y: cy }
  const hw = (b.right - b.left) / 2, hh = (b.bottom - b.top) / 2
  const t  = Math.abs(dx) * hh > Math.abs(dy) * hw
    ? hw / Math.abs(dx)
    : hh / Math.abs(dy)
  return { x: cx + dx * t, y: cy + dy * t }
}

export default function ConstraintMemberLabels() {
  const store = useOrmStore()
  const { selectedId, selectedKind } = store
  const { facts: visibleFacts, objectTypes, subtypes } = useDiagramElements()

  if (!store.showSequenceMembership) return null
  if (selectedKind !== 'constraint') return null
  const c = store.constraints.find(con => con.id === selectedId)
  if (!c || !LABELED_CONSTRAINT_TYPES.has(c.constraintType)) return null

  const sequences = c.sequences || []
  if (sequences.length === 0) return null

  const factMap    = Object.fromEntries(visibleFacts.map(f  => [f.id,  f]))
  const subtypeMap = Object.fromEntries(subtypes.map(st => [st.id, st]))
  const otMap      = Object.fromEntries(objectTypes.map(o  => [o.id,  o]))

  // Build member-key → [{gi, pi}] map
  const posMap = {}
  for (let gi = 0; gi < sequences.length; gi++) {
    for (let pi = 0; pi < sequences[gi].length; pi++) {
      const m   = sequences[gi][pi]
      const key = m.kind === 'role'
        ? `role:${m.factId}:${m.roleIndex}`
        : `subtype:${m.subtypeId}`
      if (!posMap[key]) posMap[key] = []
      posMap[key].push({ gi, pi })
    }
  }

  // One label per unique member
  const labels = []
  const seen   = new Set()

  for (let gi = 0; gi < sequences.length; gi++) {
    for (let pi = 0; pi < sequences[gi].length; pi++) {
      const m   = sequences[gi][pi]
      const key = m.kind === 'role'
        ? `role:${m.factId}:${m.roleIndex}`
        : `subtype:${m.subtypeId}`
      if (seen.has(key)) continue
      seen.add(key)

      const positions = posMap[key]
      const text = positions.length > 1
        ? '{..}'
        : `${positions[0].gi + 1}.${positions[0].pi + 1}`

      let x, y
      if (m.kind === 'role') {
        const fact = factMap[m.factId]
        if (!fact) continue
        const rc = roleCenter(fact, m.roleIndex)
        x = rc.x; y = rc.y
      } else {
        const st    = subtypeMap[m.subtypeId]
        if (!st) continue
        const subOt = otMap[st.subId], supOt = otMap[st.superId]
        if (!subOt || !supOt) continue
        const from  = borderPoint(subOt, supOt.x, supOt.y)
        const to    = borderPoint(supOt, subOt.x, subOt.y)
        x = (from.x + to.x) / 2
        y = (from.y + to.y) / 2
      }

      const w = text.length * CHAR_W + PAD_X * 2
      const h = FONT_SIZE + PAD_Y * 2

      labels.push({ key, x, y, text, w, h })
    }
  }

  return (
    <g style={{ pointerEvents: 'none' }}>
      {labels.map(({ key, x, y, text, w, h }) => (
        <g key={key} transform={`translate(${x},${y})`}>
          <rect x={-w / 2} y={-h / 2} width={w} height={h} rx={3}
            fill="#1a7fd4" opacity={0.9}/>
          <text textAnchor="middle" dominantBaseline="central"
            fontSize={FONT_SIZE} fill="#fff"
            fontFamily="var(--font-mono)" fontWeight={700}>
            {text}
          </text>
        </g>
      ))}
    </g>
  )
}
