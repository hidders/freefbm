// Assertion nodes in an ERD (behind the Assertions switch, diagram.erdAssertions):
// each assertion of the schema whose tables are all on the diagram is a
// circle like an ORM2 external constraint, with the glyph of its kind (or a
// pill with its name), linked to its tables: a solid line to a table it
// constrains, a dashed arrow to a table it only references
// (src/relational/erdAssertions.js). A click selects it (Inspector); while it
// is selected or hovered its tables and the columns it reads are
// highlighted; dragging moves it (diagram.erdAssertionPositions).

import React, { useMemo, useRef, useEffect } from 'react'
import { useOrmStore } from '../store/ormStore'
import { relationalView } from '../relational/relationalView'
import { FONT } from '../relational/erdBoxes'
import { assertionShapes, placeAssertions, boxBorder, nodeWidth, NODE_R, ASSERTION_KINDS } from '../relational/erdAssertions'
import { measureDiagramText } from '../diagram/diagramFont.js'

function measure(text) {
  return measureDiagramText(text, 12)
}
const widthOf = (s) => nodeWidth(s, measure)

function freqText(f) {
  const r = f?.[0]
  if (!r) return '#'
  if (r.type === 'upper') return `≤${r.upper}`
  if (r.type === 'lower') return `≥${r.lower}`
  if (r.type === 'single') return `${r.value}`
  if (r.type === 'range') return `${r.lower}..${r.upper}`
  return '#'
}

// The glyph of a kind, centred at (cx, cy), drawn as the ORM2 constraint symbols are.
export function AssertionGlyph({ shape, cx, cy, color }) {
  const R = NODE_R, d = R * 0.707
  const text = (t, size = 13) => (
    <text x={cx} y={cy} textAnchor="middle" dominantBaseline="central" fontSize={size} fill={color}
      fontFamily="var(--font-mono)" fontWeight={600} style={{ pointerEvents: 'none' }}>{t}</text>
  )
  const cross = <>
    <line x1={cx - d} y1={cy - d} x2={cx + d} y2={cy + d} stroke={color} strokeWidth={2} strokeLinecap="round"/>
    <line x1={cx + d} y1={cy - d} x2={cx - d} y2={cy + d} stroke={color} strokeWidth={2} strokeLinecap="round"/>
  </>
  const dot = <circle cx={cx} cy={cy} r={3.5} fill={color}/>
  switch (shape.kind) {
    case 'subset': return text('⊆')
    case 'equality': return text('=')
    case 'exclusion': return cross
    case 'inclusiveOr': return dot
    case 'exclusiveOr': return <>{cross}{dot}</>
    case 'uniqueness': return <line x1={cx - R} y1={cy} x2={cx + R} y2={cy} stroke={color} strokeWidth={2} strokeLinecap="round"/>
    case 'frequency': { const t = freqText(shape.frequency); return text(t, t.length > 2 ? 9 : 11) }
    case 'valueComparison': return <>
      <circle cx={cx - R} cy={cy} r={2.5} fill={color}/><circle cx={cx + R} cy={cy} r={2.5} fill={color}/>
      {text(shape.operator ?? '=', 12)}
    </>
    case 'ring': return text('↺', 14)
    case 'aggregate': return text('Σ')
    default: return text('φ')
  }
}

// The assertions to draw, with their positions. The highlight of the hovered
// or selected one is given to the parent (onHighlight) so the table boxes
// show it.
export function useErdAssertions(schemaId, diagram, boxes, enabled) {
  const objectTypes = useOrmStore(s => s.objectTypes)
  const facts = useOrmStore(s => s.facts)
  const constraints = useOrmStore(s => s.constraints)
  const subtypes = useOrmStore(s => s.subtypes)
  return useMemo(() => {
    if (!enabled || !schemaId) return { shapes: [], places: new Map() }
    const view = relationalView(useOrmStore.getState(), schemaId)
    const shapes = assertionShapes(view).filter(s => s.tables.length && s.tables.every(t => boxes.has(t.id)))
    return { shapes, places: placeAssertions(shapes, boxes, diagram?.erdAssertionPositions ?? {}, widthOf) }
  }, [enabled, schemaId, objectTypes, facts, constraints, subtypes, boxes, diagram?.erdAssertionPositions])
}

// layer 'edges' draws the links (under the table boxes, so they don't cross
// them), 'nodes' the nodes (over them).
export default function ErdAssertions({ layer, diagram, shapes, places, boxes, selectedId, selectedRm, hovered, onHover, drag, setDrag }) {
  const dragRef = useRef(null)
  useEffect(() => () => dragRef.current?.cleanup?.(), [])

  const startDrag = (e, s) => {
    if (e.button !== 0) return
    e.stopPropagation()
    e.preventDefault()
    useOrmStore.getState().selectRm(s.obj)
    const sx = e.clientX, sy = e.clientY
    const onMove = (ev) => {
      const z = useOrmStore.getState().zoom
      const dx = (ev.clientX - sx) / z, dy = (ev.clientY - sy) / z
      if (!dragRef.current.moved && Math.hypot(dx, dy) < 3 / z) return
      dragRef.current.moved = true
      dragRef.current.dx = dx; dragRef.current.dy = dy
      setDrag({ rmId: s.rmId, dx, dy })
    }
    const cleanup = () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    const onUp = () => {
      cleanup()
      const r = dragRef.current
      dragRef.current = null
      setDrag(null)
      if (!r?.moved) return
      // Fix every shown node where it is, so the others don't move.
      const positions = {}
      for (const [id, p] of places) positions[id] = { x: p.x, y: p.y }
      const p = places.get(s.rmId)
      positions[s.rmId] = { x: Math.round(p.x + r.dx), y: Math.round(p.y + r.dy) }
      useOrmStore.getState().setErdAssertionPositions(diagram.id, positions)
    }
    dragRef.current = { moved: false, dx: 0, dy: 0, cleanup }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  const isSelected = (s) => selectedId === s.obj.members[0] && (!selectedRm || selectedRm.id !== selectedId || selectedRm.rmId === s.rmId)
  const color = (s) => (s.obj.deontic ? 'var(--col-deontic)' : 'var(--col-constraint)')

  return (
    <g className={`erd-assertions erd-assertion-${layer}`}>
      {layer === 'edges' && <defs>
        <marker id="erdAssertArrow" viewBox="0 0 10 10" refX={9} refY={5} markerWidth={7} markerHeight={7} orient="auto-start-reverse">
          <path d="M 0 1 L 9 5 L 0 9 z" fill="var(--col-constraint)"/>
        </marker>
        <marker id="erdAssertArrowDeontic" viewBox="0 0 10 10" refX={9} refY={5} markerWidth={7} markerHeight={7} orient="auto-start-reverse">
          <path d="M 0 1 L 9 5 L 0 9 z" fill="var(--col-deontic)"/>
        </marker>
      </defs>}
      {shapes.map(s => {
        const p0 = places.get(s.rmId)
        if (!p0) return null
        const p = drag?.rmId === s.rmId ? { x: p0.x + drag.dx, y: p0.y + drag.dy } : p0
        const sel = isSelected(s), hot = sel || hovered === s.rmId
        const col = color(s)
        const w = widthOf(s), h = NODE_R * 2
        const name = s.obj.name
        const gx = name ? p.x - w / 2 + NODE_R : p.x   // glyph centre
        const tableName = (id) => boxes.get(id)?.table.name ?? id
        const constrained = s.tables.filter(t => t.role === 'constrained').map(t => tableName(t.id))
        const referenced = s.tables.filter(t => t.role === 'referenced').map(t => tableName(t.id))
        const title = [s.obj.label, ASSERTION_KINDS[s.kind] ?? s.kind,
          constrained.length ? `Constrains: ${constrained.join(', ')}` : null,
          referenced.length ? `Refers to: ${referenced.join(', ')}` : null].filter(Boolean).join('\n')
        if (layer === 'edges') return (
          <g key={s.rmId} style={{ pointerEvents: 'none' }}>
            {s.tables.map(t => {
              const b = boxes.get(t.id)
              if (!b) return null
              const e = boxBorder(b, p.x, p.y)
              const ref = t.role === 'referenced'
              return <line key={t.id} x1={p.x} y1={p.y} x2={e.x} y2={e.y} stroke={col} strokeWidth={hot ? 2 : 1.2}
                strokeDasharray={ref ? '4 3' : undefined} opacity={hot ? 1 : 0.75}
                markerEnd={ref ? (s.obj.deontic ? 'url(#erdAssertArrowDeontic)' : 'url(#erdAssertArrow)') : undefined}/>
            })}
          </g>
        )
        return (
          <g key={s.rmId} data-assertion={s.rmId} style={{ cursor: 'grab' }}
            onMouseDown={e => startDrag(e, s)}
            onMouseEnter={() => onHover(s.rmId)} onMouseLeave={() => onHover(null)}
            filter={sel ? 'url(#selectGlow)' : undefined}>
            <title>{title}</title>
            {name
              ? <rect x={p.x - w / 2} y={p.y - h / 2} width={w} height={h} rx={h / 2} fill="#ffffff" stroke={col}
                  strokeWidth={sel ? 2 : 1.5} strokeDasharray={s.obj.deontic ? '3 2' : undefined}/>
              : <circle cx={p.x} cy={p.y} r={NODE_R} fill="#ffffff" stroke={col} strokeWidth={sel ? 2 : 1.5}
                  strokeDasharray={s.obj.deontic ? '3 2' : undefined}/>}
            {name && <line x1={gx + NODE_R + 1} y1={p.y - h / 2 + 3} x2={gx + NODE_R + 1} y2={p.y + h / 2 - 3} stroke={col} strokeWidth={1} opacity={0.5}/>}
            <AssertionGlyph shape={s} cx={gx} cy={p.y} color={col}/>
            {name && <text x={gx + NODE_R + 5} y={p.y} dominantBaseline="central" fontSize={12} fill={col}
              fontFamily={FONT} style={{ pointerEvents: 'none', userSelect: 'none' }}>{name}</text>}
          </g>
        )
      })}
    </g>
  )
}

// The highlight of an assertion for the table boxes: its tables and columns.
export function assertionHighlight(shape) {
  if (!shape) return null
  return { typeIds: shape.tables.map(t => t.id), factIds: [...shape.columns] }
}
