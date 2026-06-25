import React from 'react'
import { useOrmStore } from '../store/ormStore'
import { useDiagramElements } from '../hooks/useDiagramElements'
import { entityBounds } from './ObjectTypeNode'
import { nestedFactBounds } from './FactTypeNode'
import { isSelectionMode, isElementSelecting } from '../utils/cursorUtils'

export function rectBorderPoint(b, tx, ty) {
  const cx = b.cx, cy = b.cy
  const dx = tx - cx, dy = ty - cy
  if (dx === 0 && dy === 0) return { x: cx, y: cy }
  const hw = (b.right - b.left) / 2, hh = (b.bottom - b.top) / 2
  const t = Math.abs(dx) * hh > Math.abs(dy) * hw
    ? hw / Math.abs(dx)
    : hh / Math.abs(dy)
  return { x: cx + dx * t, y: cy + dy * t }
}

export function playerBounds(id, otMap, nestedMap) {
  const ot = otMap[id]
  if (ot) return entityBounds(ot)
  const nf = nestedMap[id]
  if (nf) return nestedFactBounds(nf)
  return null
}

// Look up bounds by occurrence ID first (pinned endpoint), fall back to schema ID.
function playerBoundsForEndpoint(occId, schemaId, otByOccId, nestedByOccId, otMap, nestedMap) {
  if (occId) {
    const asOt = otByOccId[occId]
    if (asOt) return entityBounds(asOt)
    const asNf = nestedByOccId[occId]
    if (asNf) return nestedFactBounds(asNf)
  }
  return playerBounds(schemaId, otMap, nestedMap)
}

export default function SubtypeArrows({ mousePos, onContextMenu, dimAllSubtypes, queryReachable, queryOriginals, noteSubjectIds }) {
  const store     = useOrmStore()
  const { objectTypes, facts, subtypes } = useDiagramElements()
  // Schema-ID maps (for fallback and for the link-draft preview)
  const otMap     = Object.fromEntries(objectTypes.map(o => [o.id, o]))
  const nestedMap = Object.fromEntries(facts.filter(f => f.objectified).map(f => [f.id, f]))
  // Occurrence-ID maps (for pinned endpoint lookup)
  const otByOccId     = Object.fromEntries(objectTypes.filter(o => o.occurrenceId).map(o => [o.occurrenceId, o]))
  const nestedByOccId = Object.fromEntries(facts.filter(f => f.objectified && f.occurrenceId).map(f => [f.occurrenceId, f]))

  return (
    <g>
      {subtypes.map(st => {
        const subBounds = playerBoundsForEndpoint(st.subOccId,   st.subId,   otByOccId, nestedByOccId, otMap, nestedMap)
        const supBounds = playerBoundsForEndpoint(st.superOccId, st.superId, otByOccId, nestedByOccId, otMap, nestedMap)
        if (!subBounds || !supBounds) return null

        const from = rectBorderPoint(subBounds, supBounds.cx, supBounds.cy)
        const to   = rectBorderPoint(supBounds, subBounds.cx, subBounds.cy)
        const isSelected = st.occurrenceKey
          ? ((store.selectedOccurrenceId !== null
               ? store.selectedOccurrenceId === st.occurrenceKey
               : store.selectedId === st.id)
             ||
             (store.multiSelectedOccurrenceIds.length > 0
               ? store.multiSelectedOccurrenceIds.includes(st.occurrenceKey)
               : store.multiSelectedIds.includes(st.id)))
          : (store.selectedId === st.id || store.multiSelectedIds.includes(st.id))
        const gc = store.sequenceConstruction
        const qd = store.queryEditDraft
        const qh = store.queryIndexHighlight
        const selectedConstraint = !qd && (qh || (store.showConstraintQueries && store.selectedKind === 'constraint'))
          ? store.constraints.find(c => c.id === (qh?.constraintId ?? store.selectedId)) : null
        const inQueryHighlight = selectedConstraint
          ? (selectedConstraint.queries || []).some((q, qi) => {
              if (qh && qh.constraintId === selectedConstraint.id && qh.queryIndex !== qi) return false
              if (!q?.atoms) return (selectedConstraint.sequences?.[qi] || []).some(m => m.kind === 'subtype' && m.subtypeId === st.id)
              return q.atoms.some(at => at.kind === 'subtype' && at.originalId === st.id)
            })
          : false

        const sw = 4.5
        const arrowLen = 4 * sw
        const edgeDx = to.x - from.x, edgeDy = to.y - from.y
        const edgeDist = Math.sqrt(edgeDx * edgeDx + edgeDy * edgeDy)
        const lineEnd = edgeDist > arrowLen
          ? { x: to.x - edgeDx / edgeDist * arrowLen, y: to.y - edgeDy / edgeDist * arrowLen }
          : to

        const filterId = `stGlow-${st.occurrenceKey ?? st.id}`
        const fp = 15
        const filterProps = isSelected ? {
          id: filterId,
          filterUnits: 'userSpaceOnUse',
          x:      Math.min(from.x, to.x) - fp,
          y:      Math.min(from.y, to.y) - fp,
          width:  Math.abs(to.x - from.x) + fp * 2,
          height: Math.abs(to.y - from.y) + fp * 2,
        } : null

        return (
          <g key={st.occurrenceKey ?? st.id}
            className={qd ? undefined : 'selectable-group'}
            opacity={queryReachable != null
              ? (queryReachable.has(st.id) ? 1 : 0.2)
              : noteSubjectIds != null
                ? (noteSubjectIds.has(st.id) ? 1 : 0.12)
                : dimAllSubtypes ? 0.35 : 1}
            style={{ cursor: (() => {
              if (qd) return 'default'
              if (store.sequenceConstruction) return 'pointer'
              if (store.tool === 'connectConstraint') return 'pointer'
              if (isSelectionMode(store.tool)) return 'not-allowed'
              return 'pointer'
            })() }}
            onContextMenu={(e) => { if (qd) return; onContextMenu?.(st, e) }}
            onClick={(e) => {
              e.stopPropagation()
              if (qd) return
              if (store.sequenceConstruction) {
                store.collectSequenceMember({ kind: 'subtype', subtypeId: st.id })
                return
              }
              if (store.tool === 'assignRole' || store.tool === 'addSubtype' || store.tool === 'toggleMandatory' || store.tool === 'addInternalUniqueness' || store.tool === 'addInternalFrequency' || store.tool === 'addConstraint:valueRange' || store.tool === 'addConstraint:cardinality') { store.setTool('select'); return }
              if (store.tool === 'connectConstraint') { store.clearSelection(); store.setTool('select'); return }
              if (e.shiftKey) { store.shiftSelect(st.id, st.occurrenceKey ?? null); return }
              store.select(st.id, 'subtype', st.occurrenceKey ?? null)
            }}>
            {filterProps && (
              <defs>
                <filter {...filterProps}>
                  <feDropShadow dx="0" dy="0" stdDeviation="3"
                    floodColor={isSelected ? 'var(--accent)' : 'var(--col-query-in)'}
                    floodOpacity="0.6"/>
                </filter>
              </defs>
            )}
            <line x1={from.x} y1={from.y} x2={to.x} y2={to.y}
              stroke="transparent" strokeWidth={10} style={{ pointerEvents: 'all' }}/>
            <line className="hover-ring" x1={from.x} y1={from.y} x2={lineEnd.x} y2={lineEnd.y}
              style={{ strokeWidth: 10 }}/>
            <line x1={from.x} y1={from.y} x2={lineEnd.x} y2={lineEnd.y}
              stroke={isSelected ? 'var(--accent)' : inQueryHighlight ? 'var(--col-query-in)' : 'var(--col-subtype)'}
              strokeWidth={sw}
              strokeDasharray={st.inheritsPreferredIdentifier === false ? `${sw * 3} ${sw * 2}` : undefined}
              markerEnd={isSelected ? 'url(#arrowSubtypeAccent)' : inQueryHighlight ? 'url(#arrowSubtypeQueryIn)' : 'url(#arrowSubtype)'}
              filter={filterProps ? `url(#${filterId})` : undefined}
            />
          </g>
        )
      })}

      {store.linkDraft?.type === 'subtype' && (() => {
        const fromBounds = playerBoundsForEndpoint(store.linkDraft.fromOccId, store.linkDraft.fromId, otByOccId, nestedByOccId, otMap, nestedMap)
        if (!fromBounds) return null
        const bp = rectBorderPoint(fromBounds, mousePos.x, mousePos.y)
        return (
          <line x1={bp.x} y1={bp.y} x2={mousePos.x} y2={mousePos.y}
            stroke="var(--col-subtype)" strokeWidth={1.5}
            strokeDasharray="6 3" markerEnd="url(#arrowSubtype)"/>
        )
      })()}
    </g>
  )
}
