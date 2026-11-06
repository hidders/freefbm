import React, { useMemo } from 'react'
import { useOrmStore } from '../store/ormStore'
import { useDiagramElements } from '../hooks/useDiagramElements'
import { entityBounds } from './ObjectTypeNode'
import { nestedFactBounds } from './FactTypeNode'
import { hiddenNeighbourCounts } from '../utils/neighbourhood.js'

// Growing mode (the Grow switch right of the diagram tabs, or while the Add
// neighbours… picker is open): a "+n" badge at the bottom right of each
// element with n neighbourhood units that the diagram doesn't show yet; a
// click opens the picker there.

export function useGrowCounts() {
  const on = useOrmStore(s => !!s.growMode || s.neighbourPicker?.diagramId === s.activeDiagramId)
  const objectTypes = useOrmStore(s => s.objectTypes)
  const facts = useOrmStore(s => s.facts)
  const subtypes = useOrmStore(s => s.subtypes)
  const constraints = useOrmStore(s => s.constraints)
  const schemas = useOrmStore(s => s.schemas)
  const diagram = useOrmStore(s => s.diagrams.find(d => d.id === s.activeDiagramId))
  return useMemo(() => (on && diagram && !diagram.mappingId
    ? hiddenNeighbourCounts({ objectTypes, facts, subtypes, constraints, schemas }, diagram)
    : null), [on, objectTypes, facts, subtypes, constraints, schemas, diagram])
}

export function GrowBadge({ x, y, n, onOpen }) {
  const label = `+${n}`
  const w = 10 + label.length * 6.5
  return (
    <g className="grow-badge" transform={`translate(${x},${y})`} style={{ cursor: 'pointer', pointerEvents: 'all' }}
      onMouseDown={e => { e.stopPropagation(); e.preventDefault() }}
      onClick={e => { e.stopPropagation(); onOpen() }}>
      <title>{`${n} neighbour${n > 1 ? 's' : ''} not on this diagram: click to add`}</title>
      <rect x={-w / 2} y={-8} width={w} height={16} rx={8} fill="var(--accent)" stroke="var(--bg-surface)" strokeWidth={1.5} />
      <text textAnchor="middle" dy="0.35em" fontSize={10} fontWeight={700} fill="#fff" style={{ userSelect: 'none', fontFamily: "'Segoe UI', Helvetica, Arial, sans-serif" }}>{label}</text>
    </g>
  )
}

// On an ORM2 diagram: at object types and objectified fact types (each occurrence).
export function GrowBadges() {
  const counts = useGrowCounts()
  const { objectTypes, facts } = useDiagramElements()
  if (!counts?.size) return null
  const open = (id, occId) => useOrmStore.getState().openNeighbourPicker(id, occId)
  return (
    <g className="grow-badges">
      {objectTypes.filter(o => counts.has(o.id)).map(o => {
        const b = entityBounds(o)
        return <GrowBadge key={o.occurrenceId ?? o.id} x={b.right} y={b.bottom} n={counts.get(o.id)} onOpen={() => open(o.id, o.occurrenceId)} />
      })}
      {facts.filter(f => f.objectified && counts.has(f.id)).map(f => {
        const b = nestedFactBounds({ ...f, arity: f.roles.length })
        return <GrowBadge key={f.occurrenceId ?? f.id} x={b.right} y={b.bottom} n={counts.get(f.id)} onOpen={() => open(f.id, f.occurrenceId)} />
      })}
    </g>
  )
}
