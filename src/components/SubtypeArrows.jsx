import React from 'react'
import { useOrmStore } from '../store/ormStore'
import { useDiagramElements } from '../hooks/useDiagramElements'
import { entityBounds } from './ObjectTypeNode'
import { nestedFactBounds } from './FactTypeNode'

function rectBorderPoint(b, tx, ty) {
  const cx = b.cx, cy = b.cy
  const dx = tx - cx, dy = ty - cy
  if (dx === 0 && dy === 0) return { x: cx, y: cy }
  const hw = (b.right - b.left) / 2, hh = (b.bottom - b.top) / 2
  const t = Math.abs(dx) * hh > Math.abs(dy) * hw
    ? hw / Math.abs(dx)
    : hh / Math.abs(dy)
  return { x: cx + dx * t, y: cy + dy * t }
}

function playerBounds(id, otMap, nestedMap) {
  const ot = otMap[id]
  if (ot) return entityBounds(ot)
  const nf = nestedMap[id]
  if (nf) return nestedFactBounds(nf)
  return null
}

export default function SubtypeArrows({ mousePos, onContextMenu }) {
  const store     = useOrmStore()
  const { objectTypes, facts, subtypes } = useDiagramElements()
  const otMap     = Object.fromEntries(objectTypes.map(o => [o.id, o]))
  const nestedMap = Object.fromEntries(facts.filter(f => f.objectified).map(f => [f.id, f]))

  return (
    <g>
      {subtypes.map(st => {
        const subBounds = playerBounds(st.subId,   otMap, nestedMap)
        const supBounds = playerBounds(st.superId,  otMap, nestedMap)
        if (!subBounds || !supBounds) return null

        const from = rectBorderPoint(subBounds, supBounds.cx, supBounds.cy)
        const to   = rectBorderPoint(supBounds, subBounds.cx, subBounds.cy)
        const isSelected  = store.selectedId === st.id || store.multiSelectedIds.includes(st.id)
        const gc = store.sequenceConstruction
        const isCandidate = !!gc && !isSelected

        // Shorten line so the stem ends at the arrowhead base,
        // letting the tip protrude to the shape border.
        const sw = isCandidate ? 5.5 : 4.5
        const arrowLen = 4 * sw  // marker coord length (4.25-0.25) × strokeWidth
        const edgeDx = to.x - from.x, edgeDy = to.y - from.y
        const edgeDist = Math.sqrt(edgeDx * edgeDx + edgeDy * edgeDy)
        const lineEnd = edgeDist > arrowLen
          ? { x: to.x - edgeDx / edgeDist * arrowLen, y: to.y - edgeDy / edgeDist * arrowLen }
          : to

        // Per-edge inline filter with userSpaceOnUse bounds avoids the
        // bounding-box degeneration problem on perfectly horizontal/vertical lines.
        const filterId = `stGlow-${st.id}`
        const fp = 15  // padding in world units around the line endpoints
        const filterProps = (isSelected || isCandidate) ? {
          id: filterId,
          filterUnits: 'userSpaceOnUse',
          x:      Math.min(from.x, to.x) - fp,
          y:      Math.min(from.y, to.y) - fp,
          width:  Math.abs(to.x - from.x) + fp * 2,
          height: Math.abs(to.y - from.y) + fp * 2,
        } : null

        return (
          <g key={st.id}
            className="selectable-group"
            onContextMenu={(e) => onContextMenu?.(st, e)}
            onClick={(e) => {
              e.stopPropagation()
              if (store.sequenceConstruction) {
                store.collectSequenceMember({ kind: 'subtype', subtypeId: st.id })
                return
              }
              if (store.tool === 'assignRole' || store.tool === 'addSubtype' || store.tool === 'toggleMandatory' || store.tool === 'addInternalUniqueness') { store.setTool('select'); return }
              if (store.tool === 'connectConstraint') { store.clearSelection(); store.setTool('select'); return }
              if (e.shiftKey) { store.shiftSelect(st.id); return }
              store.select(st.id, 'subtype')
            }}
            style={{ cursor: 'pointer' }}>
            {/* Inline filter defined before the element that uses it */}
            {filterProps && (
              <defs>
                <filter {...filterProps}>
                  <feDropShadow dx="0" dy="0" stdDeviation="3"
                    floodColor={isSelected ? 'var(--accent)' : 'var(--col-candidate)'}
                    floodOpacity="0.5"/>
                </filter>
              </defs>
            )}
            {/* Hit area */}
            <line x1={from.x} y1={from.y} x2={to.x} y2={to.y}
              stroke="transparent" strokeWidth={10} style={{ pointerEvents: 'all' }}/>
            {/* Hover ring — wider solid stroke so it shows as a halo around the arrow */}
            <line className="hover-ring" x1={from.x} y1={from.y} x2={lineEnd.x} y2={lineEnd.y}
              style={{ strokeWidth: 10 }}/>
            {/* Arrow — accent marker + glow filter when selected */}
            <line x1={from.x} y1={from.y} x2={lineEnd.x} y2={lineEnd.y}
              stroke={isSelected ? 'var(--accent)' : 'var(--col-subtype)'}
              strokeWidth={sw}
              strokeDasharray={st.inheritsPreferredIdentifier === false ? `${sw * 3} ${sw * 2}` : undefined}
              markerEnd={isSelected ? 'url(#arrowSubtypeAccent)' : 'url(#arrowSubtype)'}
              filter={filterProps ? `url(#${filterId})` : undefined}
            />
          </g>
        )
      })}

      {/* Draft subtype arrow */}
      {store.linkDraft?.type === 'subtype' && (() => {
        const fromBounds = playerBounds(store.linkDraft.fromId, otMap, nestedMap)
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
