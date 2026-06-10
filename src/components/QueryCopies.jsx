import React, { useEffect, useRef, useState } from 'react'
import { useOrmStore } from '../store/ormStore'
import { useDiagramElements } from '../hooks/useDiagramElements'
import { computeOtSize } from './ObjectTypeNode'
import { ROLE_W, ROLE_H, ROLE_GAP, displayRoleOrder, nestedFactBounds } from './FactTypeNode'
import { roleAnchor } from '../utils/geometry'

const COPY_OFFSET = 16
const COPY_SCALE  = 0.5

// Returns { hw, hh } half-dimensions of an OT copy in world units.
// Mirrors OtCopyFrame / NestedOtCopyFrame rendering dimensions.
function otCopyHalfDims(originalId, otMap, factMap) {
  if (factMap[originalId]?.objectified) {
    // NestedOtCopyFrame: rendered at full scale
    const nf = factMap[originalId]
    if (!nf) return null
    const b = nestedFactBounds(nf)
    return { hw: (b.right - b.left) / 2, hh: (b.bottom - b.top) / 2 }
  }
  const ot = otMap[originalId]
  if (ot) {
    const { w, h } = computeOtSize(ot)
    return { hw: w * COPY_SCALE / 2, hh: h * COPY_SCALE / 2 }
  }
  const nf = factMap[originalId]
  if (nf) {
    const b = nestedFactBounds(nf)
    return { hw: (b.right - b.left) * COPY_SCALE / 2, hh: (b.bottom - b.top) * COPY_SCALE / 2 }
  }
  return null
}

// Use literal hex so colours resolve in SVG regardless of context
const COL_COPY    = '#15803d'  // dark green
const COL_PENDING = '#1d4ed8'  // --accent (blue)
const COL_LINK    = 'rgba(21,128,61,0.45)'

const FILL_ROLE_SEEDED  = 'rgba(96,165,250,0.45)'   // light blue — target copy + seeded role boxes

// ── helpers ───────────────────────────────────────────────────────────────────

// Returns the Set of copy IDs that are selectable as the second click after the
// pending first click, or null if there is no pending click (no dimming needed).
function computeSelectableNextCopyIds(qd, store, factMap) {
  if (!qd?.pendingClick) return null
  const { pendingClick: pending, copies } = qd
  const result = new Set()

  if (pending.type === 'otCopy') {
    const pendingOrigId = copies.find(c => c.id === pending.id)?.originalId
    if (!pendingOrigId) return result
    for (const cp of copies) {
      if (cp.id === pending.id) continue
      const isObjectified = factMap[cp.originalId]?.objectified
      if (cp.kind === 'subtype') {
        const st = store.subtypes.find(s => s.id === cp.originalId)
        if (st && (st.subId === pendingOrigId || st.superId === pendingOrigId)) result.add(cp.id)
      } else if (isObjectified || cp.kind === 'fact') {
        const fact = store.facts.find(f => f.id === cp.originalId) ?? factMap[cp.originalId]
        if (fact?.roles.some(r => r.objectTypeId === pendingOrigId)) result.add(cp.id)
        if (isObjectified && store.subtypes.some(st =>
          (st.subId === pendingOrigId && st.superId === cp.originalId) ||
          (st.superId === pendingOrigId && st.subId === cp.originalId)
        )) result.add(cp.id)
      } else if (cp.kind === 'objectType') {
        if (store.subtypes.some(st =>
          (st.subId === pendingOrigId && st.superId === cp.originalId) ||
          (st.superId === pendingOrigId && st.subId === cp.originalId)
        )) result.add(cp.id)
      }
    }
  } else if (pending.type === 'factCopyRole') {
    const factOrigId = copies.find(c => c.id === pending.id)?.originalId
    let expectedOtId = null
    if (factOrigId?.includes('_il_')) {
      const [pFid, riStr] = factOrigId.split('_il_')
      const pFact = store.facts.find(f => f.id === pFid)
      expectedOtId = pending.roleIndex === 0 ? pFid : pFact?.roles[Number(riStr)]?.objectTypeId
    } else {
      const fact = factOrigId ? (store.facts.find(f => f.id === factOrigId) ?? factMap[factOrigId]) : null
      expectedOtId = fact?.roles[pending.roleIndex]?.objectTypeId
    }
    if (expectedOtId) {
      for (const cp of copies) {
        if (cp.id === pending.id) continue
        if (cp.originalId === expectedOtId && (cp.kind === 'objectType' || factMap[cp.originalId]?.objectified))
          result.add(cp.id)
      }
    }
  } else if (pending.type === 'subtypeCopy') {
    const stOrigId = copies.find(c => c.id === pending.id)?.originalId
    const st = stOrigId ? store.subtypes.find(s => s.id === stOrigId) : null
    if (st) {
      for (const cp of copies) {
        if (cp.id === pending.id) continue
        if (cp.kind === 'objectType' || factMap[cp.originalId]?.objectified) {
          if (cp.originalId === st.subId || cp.originalId === st.superId) result.add(cp.id)
        }
      }
    }
  }

  return result
}

function rectBorderPoint(cx, cy, hw, hh, tx, ty) {
  const dx = tx - cx, dy = ty - cy
  if (dx === 0 && dy === 0) return { x: cx, y: cy }
  const t = Math.abs(dx) * hh > Math.abs(dy) * hw
    ? hw / Math.abs(dx) : hh / Math.abs(dy)
  return { x: cx + dx * t, y: cy + dy * t }
}

// ── OT copy frame ─────────────────────────────────────────────────────────────

function OtCopyFrame({ copy, dx, dy, isPending, isOutput, otMap, factMap, onMouseDown, onContextMenu }) {
  const color = isPending ? COL_PENDING : COL_COPY
  const sw = isOutput ? 3 : 2
  const FILL = isOutput ? FILL_ROLE_SEEDED : 'rgba(14,116,144,0.12)'

  const ot = otMap[copy.originalId]
  if (ot) {
    const { w: fw, h: fh } = computeOtSize(ot)
    const w = fw * COPY_SCALE, h = fh * COPY_SCALE
    const x = ot.x + dx - w / 2, y = ot.y + dy - h / 2
    return (
      <g className="qc-frame" onMouseDown={onMouseDown} onContextMenu={onContextMenu} style={{ cursor: onMouseDown ? 'grab' : 'default' }}>
        <rect x={x} y={y} width={w} height={h} rx={4}
          fill={FILL} stroke={color} strokeWidth={sw} opacity={0.9}
          strokeDasharray={ot.kind === 'value' ? '4 2' : undefined}/>
        <rect className="hover-ring" x={x - 3} y={y - 3} width={w + 6} height={h + 6} rx={7}/>
      </g>
    )
  }

  const nf = factMap[copy.originalId]
  if (nf) {
    const b = nestedFactBounds(nf)
    const fw = b.right - b.left, fh = b.bottom - b.top
    const w = fw * COPY_SCALE, h = fh * COPY_SCALE
    const x = nf.x + dx - w / 2, y = nf.y + dy - h / 2
    return (
      <g className="qc-frame" onMouseDown={onMouseDown} onContextMenu={onContextMenu} style={{ cursor: onMouseDown ? 'grab' : 'default' }}>
        <rect x={x} y={y} width={w} height={h} rx={4}
          style={{ fill: FILL, stroke: color, strokeWidth: sw, opacity: 0.9 }}/>
        <rect className="hover-ring" x={x - 3} y={y - 3} width={w + 6} height={h + 6} rx={7}/>
      </g>
    )
  }
  return null
}

// ── Nested OT copy frame (objectified fact — shows both OT outline and role boxes) ──────────

function NestedOtCopyFrame({ copy, dx, dy, isPending, isOutput, factMap, onMouseDown, onRoleMouseDown, onContextMenu, selectableRoles }) {
  const color = isPending ? COL_PENDING : COL_COPY
  const sw = isOutput ? 3 : 2
  const FILL_OT = isOutput ? FILL_ROLE_SEEDED : 'rgba(14,116,144,0.12)'

  const nf = factMap[copy.originalId]
  if (!nf) return null

  // Outer OT boundary (full size)
  const b = nestedFactBounds(nf)
  const outerW = b.right - b.left, outerH = b.bottom - b.top
  const cx = nf.x + dx, cy = nf.y + dy
  const outerX = b.left + dx, outerY = b.top + dy

  // Inner role boxes (full size)
  const seededMap = new Map((copy.seededRoles ?? []).map(s =>
    typeof s === 'number' ? [s, null] : [s.roleIndex, s.seqPosition]))
  const n   = Math.max(nf.arity, 1)
  const dro = displayRoleOrder(nf)

  let roleBoxes
  if (nf.orientation === 'vertical') {
    const totalH = n * ROLE_W + (n - 1) * ROLE_GAP
    const startY = cy - totalH / 2, leftX = cx - ROLE_H / 2
    roleBoxes = dro.map((ri, pi) => ({ ri, x: leftX, y: startY + pi * (ROLE_W + ROLE_GAP), w: ROLE_H, h: ROLE_W }))
  } else {
    const totalW = n * ROLE_W + (n - 1) * ROLE_GAP
    const startX = cx - totalW / 2, topY = cy - ROLE_H / 2
    roleBoxes = dro.map((ri, pi) => ({ ri, x: startX + pi * (ROLE_W + ROLE_GAP), y: topY, w: ROLE_W, h: ROLE_H }))
  }

  return (
    <g className="qc-frame" onMouseDown={onMouseDown} onContextMenu={onContextMenu} style={{ cursor: onMouseDown ? 'grab' : 'default' }}>
      {/* Outer OT frame — click outside role boxes fires OT event via parent <g> */}
      <rect x={outerX} y={outerY} width={outerW} height={outerH} rx={8}
        fill={FILL_OT} stroke={color} strokeWidth={sw} opacity={0.9}/>
      <rect className="hover-ring" x={outerX - 3} y={outerY - 3} width={outerW + 6} height={outerH + 6} rx={11}/>
      {/* Role boxes — on top; stop propagation so only role event fires */}
      {roleBoxes.map(({ ri, x, y, w, h }) => {
        const isSeeded = seededMap.has(ri)
        const seqPos   = isSeeded ? seededMap.get(ri) : null
        return (
          <g key={ri}>
            <rect x={x} y={y} width={w} height={h}
              fill={isSeeded ? FILL_ROLE_SEEDED : FILL_ROLE_DEFAULT}
              stroke={color} strokeWidth={2.5}
              opacity={selectableRoles !== null && selectableRoles !== undefined && !selectableRoles.has(ri) ? 0.2 : 1}
              style={{ cursor: onRoleMouseDown ? 'grab' : 'default' }}
              onMouseDown={onRoleMouseDown
                ? (e) => { e.stopPropagation(); onRoleMouseDown(e, copy.id, ri) }
                : undefined}/>
            {isSeeded && seqPos != null && (
              <text x={x + w / 2} y={y + h / 2} textAnchor="middle" dominantBaseline="middle"
                fontSize={9} fill="white" fontWeight={700} style={{ pointerEvents: 'none' }}>
                {seqPos + 1}
              </text>
            )}
          </g>
        )
      })}
    </g>
  )
}

// ── Fact copy frame ───────────────────────────────────────────────────────────

const FILL_ROLE_DEFAULT = 'rgba(14,116,144,0.15)'

function FactCopyFrame({ copy, dx, dy, isPending, factMap, allFacts, onRoleMouseDown, onContextMenu, selectableRoles }) {
  const color = isPending ? COL_PENDING : COL_COPY
  const fact = factMap[copy.originalId] ?? allFacts.find(f => f.id === copy.originalId)
  if (!fact) return null

  const seededMap = new Map((copy.seededRoles ?? []).map(s =>
    typeof s === 'number' ? [s, null] : [s.roleIndex, s.seqPosition]))
  const roleFill = (ri) => seededMap.has(ri) ? FILL_ROLE_SEEDED : FILL_ROLE_DEFAULT
  const roleOpacity = (ri) => selectableRoles !== null && selectableRoles !== undefined && !selectableRoles.has(ri) ? 0.2 : 1

  const n = Math.max(fact.arity, 1)
  const dro = displayRoleOrder(fact)

  if (fact.orientation === 'vertical') {
    const totalH = n * ROLE_W + (n - 1) * ROLE_GAP
    const startY = fact.y + dy - totalH / 2
    const leftX  = fact.x + dx - ROLE_H / 2
    return (
      <g className="qc-frame" onContextMenu={onContextMenu}>
        <rect className="hover-ring" x={leftX - 3} y={startY - 3} width={ROLE_H + 6} height={totalH + 6} rx={4}/>
        {dro.map((ri, pi) => {
          const rx = leftX, ry = startY + pi * (ROLE_W + ROLE_GAP)
          const isSeeded = seededMap.has(ri)
          const seqPos   = isSeeded ? seededMap.get(ri) : null
          return (
            <g key={ri}>
              <rect x={rx} y={ry} width={ROLE_H} height={ROLE_W}
                opacity={roleOpacity(ri)}
                style={{ fill: roleFill(ri), stroke: color, strokeWidth: 2,
                  cursor: onRoleMouseDown ? 'grab' : 'default' }}
                onMouseDown={onRoleMouseDown ? (e) => onRoleMouseDown(e, copy.id, ri) : undefined}/>
              {isSeeded && seqPos != null && (
                <text x={rx + ROLE_H / 2} y={ry + ROLE_W / 2} textAnchor="middle" dominantBaseline="middle"
                  fontSize={9} fill="white" fontWeight={700} style={{ pointerEvents: 'none' }}>
                  {seqPos + 1}
                </text>
              )}
            </g>
          )
        })}
      </g>
    )
  }

  const totalW = n * ROLE_W + (n - 1) * ROLE_GAP
  const startX = fact.x + dx - totalW / 2
  const topY   = fact.y + dy - ROLE_H / 2
  return (
    <g className="qc-frame" onContextMenu={onContextMenu}>
      <rect className="hover-ring" x={startX - 3} y={topY - 3} width={totalW + 6} height={ROLE_H + 6} rx={4}/>
      {dro.map((ri, pi) => {
        const rx = startX + pi * (ROLE_W + ROLE_GAP), ry = topY
        const isSeeded = seededMap.has(ri)
        const seqPos   = isSeeded ? seededMap.get(ri) : null
        return (
          <g key={ri}>
            <rect x={rx} y={ry}
              width={ROLE_W} height={ROLE_H}
              opacity={roleOpacity(ri)}
              style={{ fill: roleFill(ri), stroke: color, strokeWidth: 2,
                cursor: onRoleMouseDown ? 'grab' : 'default' }}
              onMouseDown={onRoleMouseDown ? (e) => onRoleMouseDown(e, copy.id, ri) : undefined}/>
            {isSeeded && seqPos != null && (
              <text x={rx + ROLE_W / 2} y={ry + ROLE_H / 2} textAnchor="middle" dominantBaseline="middle"
                fontSize={9} fill="white" fontWeight={700} style={{ pointerEvents: 'none' }}>
                {seqPos + 1}
              </text>
            )}
          </g>
        )
      })}
    </g>
  )
}

// ── Subtype copy frame ────────────────────────────────────────────────────────

function SubtypeCopyFrame({ copy, subDx, subDy, supDx, supDy, isPending, isOutput, subtypeMap, otMap, factMap, onClick, onContextMenu }) {
  const color = isPending ? COL_PENDING : COL_COPY
  const st = subtypeMap[copy.originalId]
  if (!st) return null

  const getBounds = (id) => {
    const ot = otMap[id]
    if (ot) { const { w, h } = computeOtSize(ot); return { cx: ot.x, cy: ot.y, hw: w * COPY_SCALE / 2, hh: h * COPY_SCALE / 2 } }
    const nf = factMap[id]
    if (nf) { const b = nestedFactBounds(nf); return { cx: nf.x, cy: nf.y, hw: (b.right - b.left) / 2, hh: (b.bottom - b.top) / 2 } }
    return null
  }

  const subB = getBounds(st.subId), supB = getBounds(st.superId)
  if (!subB || !supB) return null

  const from = rectBorderPoint(subB.cx + subDx, subB.cy + subDy, subB.hw, subB.hh, supB.cx + supDx, supB.cy + supDy)
  const to   = rectBorderPoint(supB.cx + supDx, supB.cy + supDy, supB.hw, supB.hh, subB.cx + subDx, subB.cy + subDy)
  const ddx = to.x - from.x, ddy = to.y - from.y
  const dist = Math.sqrt(ddx*ddx + ddy*ddy)
  const sw = 4.5 * 0.9
  const arrowLen = 4 * sw
  const lineEnd = dist > arrowLen ? { x: to.x - ddx/dist*arrowLen, y: to.y - ddy/dist*arrowLen } : to

  return (
    <g className="qc-frame" onClick={onClick} onContextMenu={onContextMenu}
       style={{ cursor: onContextMenu ? 'context-menu' : onClick ? 'pointer' : 'default',
                filter: isOutput ? 'drop-shadow(0 0 3px rgba(96,165,250,1)) drop-shadow(0 0 6px rgba(96,165,250,0.6))' : undefined }}>
      <line x1={from.x} y1={from.y} x2={to.x} y2={to.y} stroke="transparent" strokeWidth={7.5}/>
      <line className="hover-ring" x1={from.x} y1={from.y} x2={to.x} y2={to.y}/>
      <line x1={from.x} y1={from.y} x2={lineEnd.x} y2={lineEnd.y}
        style={{ stroke: color, strokeWidth: sw, opacity: 0.75 }}
        markerEnd={`url(#arrowSubtype${isPending ? 'Accent' : 'Copy'})`}/>
    </g>
  )
}

// ── Link line ─────────────────────────────────────────────────────────────────

function otCopyBounds(originalId, dx, dy, otMap, factMap) {
  const ot = otMap[originalId]
  if (ot) {
    const { w, h } = computeOtSize(ot)
    const cx = ot.x + dx, cy = ot.y + dy
    return { cx, cy, hw: w * COPY_SCALE / 2, hh: h * COPY_SCALE / 2 }
  }
  const nf = factMap[originalId]
  if (nf) {
    const b = nestedFactBounds(nf)
    const cx = nf.x + dx, cy = nf.y + dy
    return { cx, cy, hw: (b.right - b.left) / 2, hh: (b.bottom - b.top) / 2 }
  }
  return null
}

// Like roleAnchor from geometry.js but using scaled role-box dimensions
function scaledRoleAnchor(fact, roleIndex, tx, ty) {
  const rw = ROLE_W * COPY_SCALE, rh = ROLE_H * COPY_SCALE, rg = ROLE_GAP * COPY_SCALE
  const n = Math.max(fact.arity, 1)
  const dro = displayRoleOrder(fact)
  const posIdx = dro.indexOf(roleIndex)
  const isFirst = posIdx === 0, isLast = posIdx === n - 1

  if (fact.orientation === 'vertical') {
    const totalH = n * rw + (n - 1) * rg
    const startY = fact.y - totalH / 2
    const roleTopY = startY + posIdx * (rw + rg)
    const leftX = fact.x - rh / 2
    const cx = fact.x, cy = roleTopY + rw / 2
    const cands = [
      { x: cx,        y: roleTopY,      side: 'N' },
      { x: cx,        y: roleTopY + rw, side: 'S' },
      { x: leftX,     y: cy,            side: 'W' },
      { x: leftX + rh,y: cy,            side: 'E' },
    ].filter(c => !(c.side === 'N' && !isFirst) && !(c.side === 'S' && !isLast))
    return cands.reduce((best, p) => (p.x-tx)**2+(p.y-ty)**2 < (best.x-tx)**2+(best.y-ty)**2 ? p : best)
  }

  const totalW = n * rw + (n - 1) * rg
  const roleX = fact.x - totalW / 2 + posIdx * (rw + rg)
  const roleY = fact.y - rh / 2
  const cx = roleX + rw / 2, cy = roleY + rh / 2
  const cands = [
    { x: cx,         y: roleY,      side: 'N' },
    { x: cx,         y: roleY + rh, side: 'S' },
    { x: roleX,      y: cy,         side: 'W' },
    { x: roleX + rw, y: cy,         side: 'E' },
  ].filter(c => !(c.side === 'E' && !isLast) && !(c.side === 'W' && !isFirst))
  return cands.reduce((best, p) => (p.x-tx)**2+(p.y-ty)**2 < (best.x-tx)**2+(best.y-ty)**2 ? p : best)
}

function LinkLine({ link, copies, factMap, subtypeMap, otMap }) {
  const roleCopy = copies.find(c => c.id === link.copyId)
  const otCopy   = copies.find(c => c.id === link.variableId)
  if (!roleCopy || !otCopy) return null
  // Subtype copy endpoints are shown by the arrow itself — no separate link line needed
  if (roleCopy.kind === 'subtype') return null

  const roleDx = roleCopy.dx ?? COPY_OFFSET, roleDy = roleCopy.dy ?? COPY_OFFSET
  const otDx   = otCopy.dx  ?? COPY_OFFSET,  otDy   = otCopy.dy  ?? COPY_OFFSET

  const varBounds = otCopyBounds(otCopy.originalId, otDx, otDy, otMap, factMap)
  if (!varBounds) return null

  let anchor
  if (roleCopy.kind === 'fact' || (roleCopy.kind === 'objectType' && factMap[roleCopy.originalId]?.objectified)) {
    const fact = factMap[roleCopy.originalId]
    if (!fact) return null
    const offsetFact = { ...fact, x: fact.x + roleDx, y: fact.y + roleDy }
    anchor = roleAnchor(offsetFact, link.roleIndex, varBounds.cx, varBounds.cy)
  } else {
    const st = subtypeMap[roleCopy.originalId]
    if (!st) return null
    const endId = link.roleIndex === 0 ? st.subId : st.superId
    const endEl = otMap[endId] || factMap[endId]
    if (!endEl) return null
    anchor = { x: endEl.x + roleDx, y: endEl.y + roleDy }
  }

  const border = rectBorderPoint(varBounds.cx, varBounds.cy, varBounds.hw, varBounds.hh, anchor.x, anchor.y)

  return (
    <line x1={border.x} y1={border.y} x2={anchor.x} y2={anchor.y}
      style={{ stroke: COL_LINK, strokeWidth: 2, pointerEvents: 'none' }}/>
  )
}

// ── Main component ────────────────────────────────────────────────────────────

export default function QueryCopies({ onCopyClick, onCopyContextMenu, mousePos }) {
  const store = useOrmStore()
  const { objectTypes, facts } = useDiagramElements()
  const qd = store.queryEditDraft

  // Preview mode: show a saved query while the inspector button is held
  const qh = store.queryIndexHighlight
  const previewQuery = (!qd && qh)
    ? (store.constraints.find(c => c.id === qh.constraintId)?.queries?.[qh.queryIndex] ?? null)
    : null

  if (!qd && !previewQuery) return null

  const { copies, links } = qd ?? previewQuery
  const pendingClick = qd?.pendingClick ?? null
  const isPreview = !qd


  // Apply diagram positions to all elements (not just visible ones)
  const diagram   = store.diagrams.find(d => d.id === store.activeDiagramId)
  const positions = diagram?.positions ?? {}
  // Also apply orientation and displayRoleOrder so copies mirror the diagram's presentation
  const applyPos  = (el) => {
    const p = positions[el.id]
    if (!p) return el
    const r = { ...el, x: p.x ?? el.x, y: p.y ?? el.y }
    if (p.orientation     !== undefined) r.orientation     = p.orientation
    if (p.displayRoleOrder !== undefined) r.displayRoleOrder = p.displayRoleOrder
    return r
  }

  // Per-diagram copy position overrides (different diagrams can have different layouts)
  const constraintId    = qd?.constraintId ?? qh?.constraintId
  const sequenceIndex   = qd?.sequenceIndex ?? qh?.queryIndex
  const diagCopyPos     = diagram?.queryPositions?.[constraintId]?.[sequenceIndex] ?? {}

  const otMap   = Object.fromEntries([
    ...store.objectTypes.map(applyPos),
    ...objectTypes,
  ].map(o => [o.id, o]))
  const factMap = Object.fromEntries([
    ...store.facts.map(applyPos),
    ...facts,
  ].map(f => [f.id, f]))
  const subtypeMap = Object.fromEntries(store.subtypes.map(s => [s.id, s]))

  const isPending = (copyId) =>
    pendingClick && ['otCopy','factCopyRole'].includes(pendingClick.type) && pendingClick.id === copyId

  // ── Drag state ─────────────────────────────────────────────────────────────
  const dragRef  = useRef(null)
  const [liveDrag, setLiveDrag] = useState(null)  // { copyId, dx, dy, mergeTargetId } | null

  useEffect(() => {
    const onMove = (e) => {
      const d = dragRef.current
      if (!d) return
      const zoom = useOrmStore.getState().zoom
      const newDx = d.origDx + (e.clientX - d.startX) / zoom
      const newDy = d.origDy + (e.clientY - d.startY) / zoom

      // Detect merge candidate: another OT copy of the same original within threshold
      let mergeTargetId = null
      const { copies: currentCopies, queryPositions } = useOrmStore.getState().queryEditDraft ?? {}
      const draggedCopy = currentCopies?.find(c => c.id === d.copyId)
      if (draggedCopy?.kind === 'objectType' && currentCopies) {
        const diagram = useOrmStore.getState().diagrams.find(dd => dd.id === useOrmStore.getState().activeDiagramId)
        const cId = useOrmStore.getState().queryEditDraft?.constraintId
        const sIdx = useOrmStore.getState().queryEditDraft?.sequenceIndex
        const dcp = diagram?.queryPositions?.[cId]?.[sIdx] ?? {}
        const ot = otMap[draggedCopy.originalId]
        const nf = factMap[draggedCopy.originalId]
        const dragCx = ot ? ot.x + newDx : nf ? nf.x + newDx : null
        const dragCy = ot ? ot.y + newDy : nf ? nf.y + newDy : null
        if (dragCx !== null) {
          for (const cp of currentCopies) {
            if (cp.id === d.copyId || cp.kind !== 'objectType' || cp.originalId !== draggedCopy.originalId) continue
            const cpDx = dcp[cp.id]?.dx ?? cp.dx ?? COPY_OFFSET
            const cpDy = dcp[cp.id]?.dy ?? cp.dy ?? COPY_OFFSET
            const tOt = otMap[cp.originalId], tNf = factMap[cp.originalId]
            const tCx = tOt ? tOt.x + cpDx : tNf ? tNf.x + cpDx : null
            const tCy = tOt ? tOt.y + cpDy : tNf ? tNf.y + cpDy : null
            if (tCx === null) continue
            const dims = otCopyHalfDims(draggedCopy.originalId, otMap, factMap)
            if (dims && Math.abs(dragCx - tCx) < dims.hw * 2 && Math.abs(dragCy - tCy) < dims.hh * 2) {
              mergeTargetId = cp.id; break
            }
          }
        }
      }
      d.mergeTargetId = mergeTargetId
      setLiveDrag({ copyId: d.copyId, dx: newDx, dy: newDy, mergeTargetId })
    }
    const onUp = (e) => {
      const d = dragRef.current
      if (!d) return
      const mergeTargetId = d.mergeTargetId
      dragRef.current = null
      const distSq = (e.clientX - d.startX) ** 2 + (e.clientY - d.startY) ** 2
      setLiveDrag(null)
      if (distSq < 25) {
        if (d.clickTarget) onCopyClick(d.clickTarget)
      } else if (mergeTargetId) {
        store.mergeOtCopyInto(d.copyId, mergeTargetId)
      } else {
        const zoom = useOrmStore.getState().zoom
        store.updateQueryCopyOffset(
          d.copyId,
          d.origDx + (e.clientX - d.startX) / zoom,
          d.origDy + (e.clientY - d.startY) / zoom,
        )
      }
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup',   onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup',   onUp)
    }
  }, [store, onCopyClick, otMap, factMap])

  const isCopyProtected = (cp) =>
    cp.isOutput === true || (cp.seededRoles?.length > 0) || cp.isSeeded === true

  const isCopyAtDefault = (cp) => {
    const pos = diagCopyPos[cp.id]
    if (!pos) return true
    return pos.dx === (cp.dx ?? COPY_OFFSET) && pos.dy === (cp.dy ?? COPY_OFFSET)
  }

  const isNestedOtCopy = (cp) => cp.kind === 'objectType' && !!factMap[cp.originalId]?.objectified

  const makeCopyContextMenu = (cp) => !isPreview && onCopyContextMenu
    ? (e) => {
        e.preventDefault(); e.stopPropagation()
        onCopyContextMenu(e, cp.id, isCopyProtected(cp), isCopyAtDefault(cp))
      }
    : undefined

  const startDrag = (e, copyId, origDx, origDy, clickTarget) => {
    if (e.button !== 0) return
    e.stopPropagation()
    dragRef.current = { copyId, startX: e.clientX, startY: e.clientY, origDx, origDy, clickTarget }
  }

  const getCopyDx = (cp) => {
    if (liveDrag?.copyId === cp.id) return liveDrag.dx
    return diagCopyPos[cp.id]?.dx ?? cp.dx ?? COPY_OFFSET
  }
  const getCopyDy = (cp) => {
    if (liveDrag?.copyId === cp.id) return liveDrag.dy
    return diagCopyPos[cp.id]?.dy ?? cp.dy ?? COPY_OFFSET
  }

  // Copies with live dx/dy applied, for LinkLine rendering
  const liveCopies = copies.map(cp => {
    const dx = getCopyDx(cp), dy = getCopyDy(cp)
    return (dx !== cp.dx || dy !== cp.dy) ? { ...cp, dx, dy } : cp
  })

  // Compute the world-space anchor point of the pending copy for the draft line
  const pendingAnchor = (() => {
    if (!pendingClick || isPreview) return null
    const cp = copies.find(c => c.id === pendingClick.id)
    if (!cp) return null
    const dx = getCopyDx(cp), dy = getCopyDy(cp)
    if (pendingClick.type === 'otCopy') {
      const ot = otMap[cp.originalId]
      if (ot) return { x: ot.x + dx, y: ot.y + dy }
      const nf = factMap[cp.originalId]
      if (nf) return { x: nf.x + dx, y: nf.y + dy }
    }
    if (pendingClick.type === 'factCopyRole') {
      const fact = factMap[cp.originalId] ?? store.facts.find(f => f.id === cp.originalId)
      if (!fact) return null
      const ri = pendingClick.roleIndex
      const n = Math.max(fact.arity, 1)
      const dro = displayRoleOrder(fact)
      const posIdx = dro.indexOf(ri)
      if (fact.orientation === 'vertical') {
        const totalH = n * ROLE_W + (n - 1) * ROLE_GAP
        return { x: fact.x + dx, y: fact.y + dy - totalH / 2 + posIdx * (ROLE_W + ROLE_GAP) + ROLE_W / 2 }
      }
      const totalW = n * ROLE_W + (n - 1) * ROLE_GAP
      return { x: fact.x + dx - totalW / 2 + posIdx * (ROLE_W + ROLE_GAP) + ROLE_W / 2, y: fact.y + dy }
    }
    return null
  })()

  const selectableNextCopyIds = isPreview ? null : computeSelectableNextCopyIds(qd, store, factMap)
  const pendingCopyId = pendingClick?.id

  return (
    <g style={{ pointerEvents: isPreview ? 'none' : 'all' }}>
      {links.map((lk, i) => (
        <LinkLine key={i} link={lk} copies={liveCopies}
          factMap={factMap} subtypeMap={subtypeMap} otMap={otMap}/>
      ))}
      {copies.map(cp => {
        const dx = getCopyDx(cp), dy = getCopyDy(cp)
        const pending = isPending(cp.id)
        const isMergeTarget = liveDrag?.mergeTargetId === cp.id
        const glowFilter = isMergeTarget
          ? 'drop-shadow(0 0 6px rgba(29,78,216,1)) drop-shadow(0 0 14px rgba(29,78,216,0.7))'
          : pending
            ? 'drop-shadow(0 0 4px rgba(29,78,216,0.9)) drop-shadow(0 0 8px rgba(29,78,216,0.5))'
            : undefined
        // Dimming: when a pending click exists, hide copies that are not selectable next
        const copyOpacity = !selectableNextCopyIds || cp.id === pendingCopyId || selectableNextCopyIds.has(cp.id)
          ? 1 : 0.2

        // Per-role dimming: when an OT copy is pending, only the matching role boxes are selectable
        const pendingOrigId = pendingClick?.type === 'otCopy'
          ? (qd?.copies.find(c => c.id === pendingClick.id)?.originalId ?? null) : null
        const roleSelectableRoles = (() => {
          if (!pendingOrigId) return null
          const fact = factMap[cp.originalId] ?? store.facts.find(f => f.id === cp.originalId)
          if (!fact) return null
          const s = new Set()
          fact.roles.forEach((r, ri) => { if (r.objectTypeId === pendingOrigId) s.add(ri) })
          return s
        })()

        // Objectified fact: combined OT+role frame regardless of copy kind
        if ((cp.kind === 'objectType' || cp.kind === 'fact') && factMap[cp.originalId]?.objectified) return (
          <g key={cp.id} style={{ filter: glowFilter }} opacity={copyOpacity}>
          <NestedOtCopyFrame copy={cp} dx={dx} dy={dy}
            isPending={pending} isOutput={cp.isOutput}
            factMap={factMap}
            selectableRoles={roleSelectableRoles}
            onMouseDown={isPreview ? undefined : (e) => startDrag(e, cp.id, dx, dy, { type: 'otCopy', id: cp.id })}
            onRoleMouseDown={isPreview ? undefined : (e, copyId, roleIndex) =>
              startDrag(e, copyId, dx, dy, { type: 'factCopyRole', id: copyId, roleIndex })}
            onContextMenu={makeCopyContextMenu(cp)}/>
          </g>
        )
        if (cp.kind === 'objectType') return (
          <g key={cp.id} style={{ filter: glowFilter }} opacity={copyOpacity}>
          <OtCopyFrame copy={cp} dx={dx} dy={dy}
            isPending={pending} isOutput={cp.isOutput}
            otMap={otMap} factMap={factMap}
            onMouseDown={isPreview ? undefined : (e) => startDrag(e, cp.id, dx, dy, { type: 'otCopy', id: cp.id })}
            onContextMenu={makeCopyContextMenu(cp)}/>
          </g>
        )
        if (cp.kind === 'fact') return (
          <g key={cp.id} style={{ filter: glowFilter }} opacity={copyOpacity}>
          <FactCopyFrame copy={cp} dx={dx} dy={dy}
            isPending={pending} factMap={factMap} allFacts={store.facts}
            selectableRoles={roleSelectableRoles}
            onRoleMouseDown={isPreview ? undefined : (e, copyId, roleIndex) =>
              startDrag(e, copyId, dx, dy, { type: 'factCopyRole', id: copyId, roleIndex })}
            onContextMenu={makeCopyContextMenu(cp)}/>
          </g>
        )
        if (cp.kind === 'subtype') {
          const subLink = links.find(l => l.copyId === cp.id && l.roleIndex === 0)
          const supLink = links.find(l => l.copyId === cp.id && l.roleIndex === 1)
          const subOt   = subLink ? liveCopies.find(c => c.id === subLink.variableId) : null
          const supOt   = supLink ? liveCopies.find(c => c.id === supLink.variableId) : null
          const subDx = subOt?.dx ?? COPY_OFFSET, subDy = subOt?.dy ?? COPY_OFFSET
          const supDx = supOt?.dx ?? COPY_OFFSET, supDy = supOt?.dy ?? COPY_OFFSET
          return (
            <g key={cp.id} opacity={copyOpacity}>
            <SubtypeCopyFrame copy={cp}
              subDx={subDx} subDy={subDy} supDx={supDx} supDy={supDy}
              isPending={pending} isOutput={cp.isSeeded !== false}
              subtypeMap={subtypeMap} otMap={otMap} factMap={factMap}
              onClick={undefined}
              onContextMenu={makeCopyContextMenu(cp)}/>
            </g>
          )
        }
        return null
      })}

      {pendingAnchor && mousePos && (
        <line
          x1={pendingAnchor.x} y1={pendingAnchor.y}
          x2={mousePos.x} y2={mousePos.y}
          stroke={COL_PENDING} strokeWidth={1.5}
          strokeDasharray="6 3"
          style={{ pointerEvents: 'none' }}/>
      )}
    </g>
  )
}
