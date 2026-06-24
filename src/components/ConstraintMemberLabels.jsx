import React from 'react'
import { useOrmStore } from '../store/ormStore'
import { useDiagramElements } from '../hooks/useDiagramElements'
import { roleCenter, makeImplicitLinkFact } from './FactTypeNode'
import { entityBounds } from './ObjectTypeNode'

// Constraint types for which sequence-membership labels are shown on the canvas
const LABELED_CONSTRAINT_TYPES = new Set(['exclusiveOr', 'exclusion', 'inclusiveOr', 'equality', 'subset', 'uniqueness', 'ring', 'valueComparison', 'frequency'])
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
  if (store.queryEditDraft || store.queryIndexHighlight) return null
  if (selectedKind !== 'constraint') return null
  const c = store.constraints.find(con => con.id === selectedId)
  if (!c || !LABELED_CONSTRAINT_TYPES.has(c.constraintType)) return null

  const sequences = c.sequences || []
  if (sequences.length === 0) return null

  // Use queryOccurrenceRefs to position labels at the anchored occurrence of each fact type.
  const activeDiag = store.diagrams.find(d => d.id === store.activeDiagramId)
  const activeCocc = activeDiag?.constraintOccurrences?.find(co => co.schemaConstraintId === selectedId)
  const qor = activeCocc?.queryOccurrenceRefs ?? {}
  const factByOccId = Object.fromEntries(visibleFacts.filter(f => f.occurrenceId).map(f => [f.occurrenceId, f]))

  // Build factMap: first occurrence as default, then override with anchored occurrence.
  const factMap = {}
  for (const f of visibleFacts) { if (!(f.id in factMap)) factMap[f.id] = f }
  for (const [schemaId, occId] of Object.entries(qor)) {
    const anchored = factByOccId[occId]
    if (anchored) factMap[schemaId] = anchored
  }
  // Add synthetic implied link facts so member labels can resolve them
  store.facts.filter(f => f.objectified).forEach(f => {
    if (factMap[f.id]) {
      (f.implicitLinks || []).forEach(il => {
        if (store.isImplicitLinkShown(f.id, il.roleIndex)) {
          const synth = makeImplicitLinkFact(f, il)
          factMap[synth.id] = synth
        }
      })
    }
  })
  const subtypeMap = Object.fromEntries(subtypes.map(st => [st.id, st]))
  const otMap      = Object.fromEntries(objectTypes.map(o  => [o.id,  o]))

  // When editing a query, restrict labels to the sequence being queried
  const qd = store.queryEditDraft
  const editingSequenceIndex = (qd && qd.constraintId === c.id) ? qd.sequenceIndex : null

  // Build member-key → [{gi, pi}] map (restricted to editing sequence when active)
  const posMap = {}
  for (let gi = 0; gi < sequences.length; gi++) {
    if (editingSequenceIndex !== null && gi !== editingSequenceIndex) continue
    for (let pi = 0; pi < sequences[gi].length; pi++) {
      const m   = sequences[gi][pi]
      const key = m.kind === 'role'
        ? `role:${m.factId}:${m.roleIndex}`
        : `subtype:${m.subtypeId}`
      if (!posMap[key]) posMap[key] = []
      posMap[key].push({ gi, pi })
    }
  }

  // When a specific query button is pressed, restrict labels to sequence members of that query
  const qh = store.queryIndexHighlight
  let allowedKeys = null
  if (qh && qh.constraintId === c.id) {
    const seq = (c.sequences || [])[qh.queryIndex] || []
    allowedKeys = new Set(
      seq.map(m => m.kind === 'role' ? `role:${m.factId}:${m.roleIndex}` : `subtype:${m.subtypeId}`)
    )
  }

  // One label per unique member
  const labels = []
  const seen   = new Set()

  for (let gi = 0; gi < sequences.length; gi++) {
    if (editingSequenceIndex !== null && gi !== editingSequenceIndex) continue
    for (let pi = 0; pi < sequences[gi].length; pi++) {
      const m   = sequences[gi][pi]
      const key = m.kind === 'role'
        ? `role:${m.factId}:${m.roleIndex}`
        : `subtype:${m.subtypeId}`
      if (seen.has(key)) continue
      seen.add(key)
      if (allowedKeys && !allowedKeys.has(key)) continue

      const positions = posMap[key]
      const text = positions.length > 1
        ? '{..}'
        : `${positions[0].gi + 1}.${positions[0].pi + 1}`

      let x, y, isVertical = false
      if (m.kind === 'role') {
        const fact = factMap[m.factId]
        if (!fact) continue
        const rc = roleCenter(fact, m.roleIndex)
        x = rc.x; y = rc.y
        isVertical = fact.orientation === 'vertical'
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

      labels.push({ key, x, y, text, w, h, isVertical })
    }
  }

  return (
    <g style={{ pointerEvents: 'none' }}>
      {labels.map(({ key, x, y, text, w, h, isVertical }) => (
        <g key={key} transform={`translate(${x},${y})${isVertical ? ' rotate(90)' : ''}`}>
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
