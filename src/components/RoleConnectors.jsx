import React, { useEffect, useRef, useState } from 'react'
import { useOrmStore } from '../store/ormStore'
import { useDiagramElements } from '../hooks/useDiagramElements'
import { entityBounds } from './ObjectTypeNode'
import { ROLE_W, ROLE_H, ROLE_GAP, nestedFactBounds, displayRoleOrder } from './FactTypeNode'
export { roleAnchor } from '../utils/geometry'
import { roleAnchor } from '../utils/geometry'
import { isSelectionMode, isElementSelecting } from '../utils/cursorUtils'

const DOT_R = 4  // mandatory dot radius

/**
 * Returns the nearest point on the border of a rect defined by {left,right,top,bottom,cx,cy}
 * facing toward (tx, ty).
 */
function rectBorderPoint(b, tx, ty) {
  const cx = b.cx, cy = b.cy
  const dx = tx - cx, dy = ty - cy
  if (dx === 0 && dy === 0) return { x: cx, y: cy }
  const hw = (b.right - b.left) / 2
  const hh = (b.bottom - b.top) / 2
  const t  = Math.abs(dx) * hh > Math.abs(dy) * hw
    ? hw / Math.abs(dx)
    : hh / Math.abs(dy)
  return { x: cx + dx * t, y: cy + dy * t }
}

function otBorderPoint(ot, tx, ty) {
  return rectBorderPoint(entityBounds(ot), tx, ty)
}

/** Returns the border point and position for either a regular OT or an objectified fact. */
function playerBorderPoint(ot, nestedFact, tx, ty) {
  if (ot)         return rectBorderPoint(entityBounds(ot),      tx, ty)
  if (nestedFact) return rectBorderPoint(nestedFactBounds(nestedFact), tx, ty)
  return null
}

function playerXY(ot, nestedFact) {
  if (ot)         return { x: ot.x,         y: ot.y }
  if (nestedFact) return { x: nestedFact.x, y: nestedFact.y }
  return null
}

// ── component ─────────────────────────────────────────────────────────────────

export default function RoleConnectors({ mousePos }) {
  const store = useOrmStore()
  const { objectTypes, facts: visibleFacts } = useDiagramElements()
  const otMap     = Object.fromEntries(objectTypes.map(o => [o.id, o]))
  const nestedMap = Object.fromEntries(visibleFacts.filter(f => f.objectified).map(f => [f.id, f]))
  const dotAtObject = store.mandatoryDotPosition === 'object'

  // Read diagram positions for role name offsets
  const diagPos = store.diagrams?.find(d => d.id === store.activeDiagramId)?.positions ?? {}

  const getRoleNameOffset = (factId, roleIndex) => {
    const p = diagPos[factId]
    return p?.roleNameOffsets?.[roleIndex] ?? null
  }

  // ── role-name label drag + inline edit ────────────────────────────────────
  const dragRef = useRef(null)
  const [liveDrag, setLiveDrag] = useState(null) // { factId, roleIndex, dx, dy } | null
  const [editing, setEditing] = useState(null)   // { factId, roleIndex, draft } | null

  useEffect(() => {
    const onMove = (e) => {
      const d = dragRef.current
      if (!d) return
      const zoom = useOrmStore.getState().zoom
      const dx = d.origDx + (e.clientX - d.startX) / zoom
      const dy = d.origDy + (e.clientY - d.startY) / zoom
      setLiveDrag({ factId: d.factId, roleIndex: d.roleIndex, dx, dy })
    }
    const onUp = (e) => {
      const d = dragRef.current
      if (!d) return
      dragRef.current = null
      const wasDrag = (e.clientX - d.startX) ** 2 + (e.clientY - d.startY) ** 2 > 16
      if (wasDrag) {
        const zoom = useOrmStore.getState().zoom
        const dx = d.origDx + (e.clientX - d.startX) / zoom
        const dy = d.origDy + (e.clientY - d.startY) / zoom
        useOrmStore.getState().updateRoleNameOffset(d.factId, d.roleIndex, { dx, dy })
      }
      setLiveDrag(null)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup',   onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup',   onUp)
    }
  }, [])

  // Commit role-name edit when user clicks outside the foreignObject input
  useEffect(() => {
    if (!editing) return
    const onDown = (e) => {
      if (!e.target.closest?.('foreignObject')) {
        const trimmed = editing.draft.trim()
        if (editing.factId.includes('_il_')) {
          const [parentFactId, ilRoleIdxStr] = editing.factId.split('_il_')
          const ilRoleIndex = Number(ilRoleIdxStr)
          const s = useOrmStore.getState()
          const f = s.facts.find(ff => ff.id === parentFactId)
          const il = f?.implicitLinks?.find(l => l.roleIndex === ilRoleIndex)
          if (il) {
            const roleNames = [...(il.roleNames || [null, null])]
            roleNames[editing.roleIndex] = trimmed || null
            s.updateImplicitLink(parentFactId, ilRoleIndex, { roleNames })
          }
        } else {
          store.updateRole(editing.factId, editing.roleIndex, { roleName: trimmed })
        }
        setEditing(null)
      }
    }
    window.addEventListener('mousedown', onDown, true)
    return () => window.removeEventListener('mousedown', onDown, true)
  }, [editing, store])

  // ── build connector descriptors ────────────────────────────────────────────
  const connectors = visibleFacts.flatMap(fact =>
    fact.roles.map((role, ri) => {
      if (!role.objectTypeId) return null
      const ot       = otMap[role.objectTypeId]
      const nf       = !ot ? nestedMap[role.objectTypeId] : null
      if (!ot && !nf) return null

      const { x: px, y: py } = playerXY(ot, nf)
      const anchor = roleAnchor(fact, ri, px, py)
      const border = playerBorderPoint(ot, nf, anchor.x, anchor.y)

      let dotPos = null
      if (role.mandatory) dotPos = dotAtObject ? border : anchor

      // Connector midpoint
      const mx = (anchor.x + border.x) / 2
      const my = (anchor.y + border.y) / 2

      // Auto perpendicular offset (used when no custom offset stored)
      const edgeDx = border.x - anchor.x
      const edgeDy = border.y - anchor.y
      const len = Math.sqrt(edgeDx * edgeDx + edgeDy * edgeDy) || 1
      const autoOx = -edgeDy / len * 9
      const autoOy =  edgeDx / len * 9

      return {
        key: `${fact.id}-${ri}`,
        factId: fact.id, roleIndex: ri,
        anchor, border, dotPos,
        mx, my,
        autoOffset: { dx: autoOx, dy: autoOy },
        nameOffset: getRoleNameOffset(fact.id, ri) ?? role.nameOffset ?? null,
        roleName: role.roleName,
      }
    }).filter(Boolean)
  )

  // Implicit link connectors (dashed role boxes)
  const implicitConnectors = visibleFacts.flatMap(fact => {
    if (!fact.objectified) return []
    return (fact.implicitLinks || []).filter(il => store.isImplicitLinkShown(fact.id, il.roleIndex)).flatMap(il => {
      const role = fact.roles[il.roleIndex]
      if (!role?.objectTypeId) return []
      const ot = otMap[role.objectTypeId]
      const nf = !ot ? nestedMap[role.objectTypeId] : null
      if (!ot && !nf) return []
      const roleOrder = il.roleOrder || [0, 1]
      const roleNames = il.roleNames || [null, null]
      const ilKey = `${fact.id}:il:${il.roleIndex}`
      const ilPos = diagPos[ilKey]
      const schemaX = il.x
      const schemaY = il.y
      const defaultX = (ot || nf) ? Math.round((fact.x + (ot || nf).x) / 2) : fact.x
      const defaultY = (ot || nf) ? Math.round((fact.y + (ot || nf).y) / 2) : fact.y
      const ilX = ilPos?.x ?? schemaX ?? defaultX
      const ilY = ilPos?.y ?? schemaY ?? defaultY
      const assocId = ot?.id ?? nf?.id
      const synthFact = {
        id: `${fact.id}_il_${il.roleIndex}`,
        x: ilX, y: ilY,
        arity: 2, orientation: il.orientation || 'horizontal',
        roles: [
          { objectTypeId: roleOrder[0] === 0 ? fact.id : assocId, nameOffset: null },
          { objectTypeId: roleOrder[1] === 0 ? fact.id : assocId, nameOffset: null },
        ],
      }
      return [0, 1].map(ri => {
        const sRole = synthFact.roles[ri]
        const targetOt = otMap[sRole.objectTypeId]
        const targetNf = !targetOt ? nestedMap[sRole.objectTypeId] : null
        if (!targetOt && !targetNf) return null
        const { x: px, y: py } = playerXY(targetOt, targetNf)
        const anchor = roleAnchor(synthFact, ri, px, py)
        const border = playerBorderPoint(targetOt, targetNf, anchor.x, anchor.y)
        const isMandatoryRole = sRole.objectTypeId === fact.id || (ri === 1 && role?.mandatory)
        const dotPos = isMandatoryRole ? anchor : (dotAtObject ? border : anchor)
        const mx = (anchor.x + border.x) / 2
        const my = (anchor.y + border.y) / 2
        const edgeDx = border.x - anchor.x
        const edgeDy = border.y - anchor.y
        const len = Math.sqrt(edgeDx * edgeDx + edgeDy * edgeDy) || 1
        return {
          key: `${fact.id}_il_${il.roleIndex}-${ri}`,
          factId: synthFact.id, roleIndex: ri,
          anchor, border, dotPos,
          mx, my,
          autoOffset: { dx: -edgeDy / len * 9, dy: edgeDx / len * 9 },
          nameOffset: getRoleNameOffset(synthFact.id, ri),
          roleName: roleNames[ri] || '',
          isImplicit: true,
        }
      }).filter(Boolean)
    })
  })

  const allConnectors = [...connectors, ...implicitConnectors]

  return (
    <g>
      {/* Connector lines */}
      {allConnectors.map(({ key, anchor, border }) => (
        <line key={key}
          x1={border.x} y1={border.y}
          x2={anchor.x} y2={anchor.y}
          stroke="var(--col-fact)" strokeWidth={1.5} strokeOpacity={0.75}/>
      ))}

      {/* Role name labels — draggable, offset stored relative to connector midpoint */}
      {store.showRoleNames && allConnectors.map(({ key, factId, roleIndex, roleName,
                                                mx, my, autoOffset, nameOffset }) => {
        if (!roleName) return null

        // Resolve current label position
        const isDragging = liveDrag?.factId === factId && liveDrag?.roleIndex === roleIndex
        let lx, ly, origDx, origDy
        if (isDragging) {
          lx = mx + liveDrag.dx;  ly = my + liveDrag.dy
          origDx = liveDrag.dx;   origDy = liveDrag.dy
        } else if (nameOffset) {
          lx = mx + nameOffset.dx;  ly = my + nameOffset.dy
          origDx = nameOffset.dx;   origDy = nameOffset.dy
        } else {
          lx = mx + (autoOffset?.dx ?? 0);  ly = my + (autoOffset?.dy ?? 0)
          origDx = autoOffset?.dx ?? 0;   origDy = autoOffset?.dy ?? 0
        }

        const isEditingThis = editing?.factId === factId && editing?.roleIndex === roleIndex

        const commitEdit = () => {
          const trimmed = editing.draft.trim()
          store.updateRole(editing.factId, editing.roleIndex, { roleName: trimmed })
          setEditing(null)
        }

        if (isEditingThis) {
          const W = Math.max(80, editing.draft.length * 8 + 24)
          return (
            <foreignObject key={`lbl-${key}`}
              x={lx - W / 2} y={ly - 11} width={W} height={22}>
              <input
                // eslint-disable-next-line jsx-a11y/no-autofocus
                autoFocus
                value={editing.draft}
                onChange={e => setEditing(prev => ({ ...prev, draft: e.target.value }))}
                onBlur={commitEdit}
                onKeyDown={e => {
                  e.stopPropagation()
                  if (e.key === 'Enter') { e.preventDefault(); commitEdit() }
                  if (e.key === 'Escape') { e.stopPropagation(); setEditing(null) }
                }}
                onMouseDown={e => e.stopPropagation()}
                style={{
                  width: '100%', height: '100%',
                  border: '1px solid #1a7fd4', borderRadius: 3, outline: 'none',
                  background: '#fff', color: '#1a7fd4',
                  fontSize: 12, fontFamily: "'Segoe UI', Helvetica, Arial, sans-serif",
                  textAlign: 'center', padding: '0 4px', boxSizing: 'border-box',
                }}
              />
            </foreignObject>
          )
        }

        return (
          <text key={`lbl-${key}`}
            x={lx} y={ly}
            textAnchor="middle" dominantBaseline="middle"
            fontSize={12} fontFamily="'Segoe UI', Helvetica, Arial, sans-serif"
            fill="#1a7fd4"
            style={{ cursor: isDragging ? 'grabbing' : 'grab', userSelect: 'none' }}
            onMouseDown={e => {
              e.stopPropagation()
              dragRef.current = {
                factId, roleIndex,
                startX: e.clientX, startY: e.clientY,
                origDx, origDy,
              }
              setLiveDrag({ factId, roleIndex, dx: origDx, dy: origDy })
            }}
            onDoubleClick={e => {
              e.stopPropagation()
              let draft = ''
              if (factId.includes('_il_')) {
                const [parentFactId, ilRoleIdxStr] = factId.split('_il_')
                const ilRoleIndex = Number(ilRoleIdxStr)
                const s = useOrmStore.getState()
                const f = s.facts.find(ff => ff.id === parentFactId)
                const il = f?.implicitLinks?.find(l => l.roleIndex === ilRoleIndex)
                draft = (il?.roleNames || [null, null])[roleIndex] || ''
              } else {
                const fact = useOrmStore.getState().facts.find(f => f.id === factId)
                const role = fact?.roles[roleIndex]
                draft = role?.roleName || ''
              }
              setEditing({ factId, roleIndex, draft })
            }}>
            [{roleName}]
          </text>
        )
      })}

      {/* Draft line while user is assigning a role */}
      {store.linkDraft?.type === 'roleAssign' && (() => {
        const draft = store.linkDraft

        if (draft.objectTypeId) {
          // Object-type-first: line from object-type (or objectified fact) border toward mouse
          const ot = otMap[draft.objectTypeId]
          const nf = !ot ? nestedMap[draft.objectTypeId] : null
          if (!ot && !nf) return null
          const border = playerBorderPoint(ot, nf, mousePos.x, mousePos.y)
          return (
            <line key="draft"
              x1={border.x} y1={border.y}
              x2={mousePos.x} y2={mousePos.y}
              stroke="var(--col-fact)" strokeWidth={1.5}
              strokeDasharray="5 3" strokeOpacity={0.6}/>
          )
        }

        if (draft.factId != null && draft.roleIndex != null) {
          // Role-first: line from role-box anchor toward mouse
          const fact = visibleFacts.find(f => f.id === draft.factId)
          if (!fact) return null
          const anchor = roleAnchor(fact, draft.roleIndex, mousePos.x, mousePos.y)
          return (
            <line key="draft"
              x1={anchor.x} y1={anchor.y}
              x2={mousePos.x} y2={mousePos.y}
              stroke="var(--col-fact)" strokeWidth={1.5}
              strokeDasharray="5 3" strokeOpacity={0.6}/>
          )
        }

        return null
      })()}
    </g>
  )
}

// ── MandatoryDots ─────────────────────────────────────────────────────────────
// Rendered in Canvas *after* all object type and fact nodes so dots always
// paint on top of the shapes they are linked to.

export function MandatoryDots({ onContextMenu }) {
  const store      = useOrmStore()
  const { objectTypes, facts: visibleFacts } = useDiagramElements()
  const otMap      = Object.fromEntries(objectTypes.map(o => [o.id, o]))
  const nestedMap  = Object.fromEntries(visibleFacts.filter(f => f.objectified).map(f => [f.id, f]))
  const dotAtObject = store.mandatoryDotPosition === 'object'
  const sel        = store.selectedMandatoryDot
  const diagPos    = store.diagrams?.find(d => d.id === store.activeDiagramId)?.positions ?? {}

  return (
    <g>
      {visibleFacts.flatMap(fact =>
        fact.roles.map((role, ri) => {
          if (!role.mandatory || !role.objectTypeId) return null
          const ot = otMap[role.objectTypeId]
          const nf = !ot ? nestedMap[role.objectTypeId] : null
          if (!ot && !nf) return null
          const { x: px, y: py } = playerXY(ot, nf)
          const anchor = roleAnchor(fact, ri, px, py)
          const border = playerBorderPoint(ot, nf, anchor.x, anchor.y)
          const pos    = dotAtObject ? border : anchor
          const isSelected = sel?.factId === fact.id && sel?.roleIndex === ri
          return (
            <g key={`dot-${fact.id}-${ri}`} className="selectable-group" style={{ cursor: isElementSelecting(store.tool, store.sequenceConstruction) ? 'not-allowed' : 'pointer', filter: isSelected ? 'drop-shadow(0 0 3px var(--accent))' : undefined }}>
              <circle
                cx={pos.x} cy={pos.y} r={DOT_R}
                fill="var(--col-mandatory)"
                onClick={e => {
                  e.stopPropagation()
                  if (isSelected) store.deselectMandatoryDot()
                  else store.selectMandatoryDot(fact.id, ri)
                }}
                onContextMenu={e => {
                  e.preventDefault(); e.stopPropagation()
                  store.selectMandatoryDot(fact.id, ri)
                  onContextMenu?.(fact.id, ri, e)
                }}/>
              <rect className="hover-ring"
                x={pos.x - DOT_R - 3} y={pos.y - DOT_R - 3}
                width={(DOT_R + 3) * 2} height={(DOT_R + 3) * 2}
                rx={DOT_R + 3}/>
            </g>
          )
        }).filter(Boolean)
      )}
      {/* Mandatory dots for implicit links (role 0 is always mandatory; role 1 is mandatory if base role is mandatory) */}
      {visibleFacts.flatMap(fact => {
        if (!fact.objectified) return []
        return (fact.implicitLinks || []).filter(il => store.isImplicitLinkShown(fact.id, il.roleIndex)).map(il => {
          const role = fact.roles[il.roleIndex]
          const roleOrder = il.roleOrder || [0, 1]
          const results = []

          // Role 0 (nested fact) — always mandatory
          if (role?.objectTypeId) {
            const ot = otMap[role.objectTypeId]
            const nf = !ot ? nestedMap[role.objectTypeId] : null
            if (ot || nf) {
              const ilKey = `${fact.id}:il:${il.roleIndex}`
              const ilPos = diagPos[ilKey]
              const schemaX = il.x
              const schemaY = il.y
              const defaultX = (ot || nf) ? Math.round((fact.x + (ot || nf).x) / 2) : fact.x
              const defaultY = (ot || nf) ? Math.round((fact.y + (ot || nf).y) / 2) : fact.y
              const ilX = ilPos?.x ?? schemaX ?? defaultX
              const ilY = ilPos?.y ?? schemaY ?? defaultY
              const mandatoryDisplayRole = roleOrder.indexOf(0)
              const synthFact = {
                id: `${fact.id}_il_${il.roleIndex}`,
                x: ilX, y: ilY,
                arity: 2, orientation: il.orientation || 'horizontal',
              }
              const targetOt = otMap[fact.id]
              const targetNf = !targetOt ? nestedMap[fact.id] : null
              if (targetOt || targetNf) {
                const { x: px, y: py } = playerXY(targetOt, targetNf)
                const anchor = roleAnchor(synthFact, mandatoryDisplayRole, px, py)
                const border = playerBorderPoint(targetOt, targetNf, anchor.x, anchor.y)
                const pos = dotAtObject ? border : anchor
                const isSelected = sel?.factId === synthFact.id && sel?.roleIndex === mandatoryDisplayRole
                results.push(
                  <g key={`dot-${synthFact.id}-${mandatoryDisplayRole}`} className="selectable-group" style={{ cursor: isElementSelecting(store.tool, store.sequenceConstruction) ? 'not-allowed' : 'pointer', filter: isSelected ? 'drop-shadow(0 0 3px var(--accent))' : undefined }}>
                    <circle
                      cx={pos.x} cy={pos.y} r={DOT_R}
                      fill="var(--col-mandatory)"
                      onClick={e => {
                        e.stopPropagation()
                        if (isSelected) store.deselectMandatoryDot()
                        else store.selectMandatoryDot(synthFact.id, mandatoryDisplayRole)
                      }}
                      onContextMenu={e => {
                        e.preventDefault(); e.stopPropagation()
                        store.selectMandatoryDot(synthFact.id, mandatoryDisplayRole)
                        onContextMenu?.(synthFact.id, mandatoryDisplayRole, e)
                      }}/>
                    <rect className="hover-ring"
                      x={pos.x - DOT_R - 3} y={pos.y - DOT_R - 3}
                      width={(DOT_R + 3) * 2} height={(DOT_R + 3) * 2}
                      rx={DOT_R + 3}/>
                  </g>
                )
              }
            }
          }

          // Role 1 (associated object type) — mandatory if base role is mandatory
          if (role?.mandatory) {
            const associatedOt = otMap[role.objectTypeId]
            const associatedNf = !associatedOt ? nestedMap[role.objectTypeId] : null
            if (associatedOt || associatedNf) {
              const ilKey = `${fact.id}:il:${il.roleIndex}`
              const ilPos = diagPos[ilKey]
              const schemaX = il.x
              const schemaY = il.y
              const defaultX = (associatedOt || associatedNf) ? Math.round((fact.x + (associatedOt || associatedNf).x) / 2) : fact.x
              const defaultY = (associatedOt || associatedNf) ? Math.round((fact.y + (associatedOt || associatedNf).y) / 2) : fact.y
              const ilX = ilPos?.x ?? schemaX ?? defaultX
              const ilY = ilPos?.y ?? schemaY ?? defaultY
              const mandatoryDisplayRole = roleOrder.indexOf(1)
              const synthFact = {
                id: `${fact.id}_il_${il.roleIndex}`,
                x: ilX, y: ilY,
                arity: 2, orientation: il.orientation || 'horizontal',
              }
              const { x: px, y: py } = playerXY(associatedOt, associatedNf)
              const anchor = roleAnchor(synthFact, mandatoryDisplayRole, px, py)
              const border = playerBorderPoint(associatedOt, associatedNf, anchor.x, anchor.y)
              const pos = dotAtObject ? border : anchor
              const isSelected = sel?.factId === synthFact.id && sel?.roleIndex === mandatoryDisplayRole
              results.push(
                <g key={`dot-${synthFact.id}-r1-${mandatoryDisplayRole}`} className="selectable-group" style={{ cursor: isElementSelecting(store.tool, store.sequenceConstruction) ? 'not-allowed' : 'pointer', filter: isSelected ? 'drop-shadow(0 0 3px var(--accent))' : undefined }}>
                  <circle
                    cx={pos.x} cy={pos.y} r={DOT_R}
                    fill="var(--col-mandatory)"
                    onClick={e => {
                      e.stopPropagation()
                      if (isSelected) store.deselectMandatoryDot()
                      else store.selectMandatoryDot(synthFact.id, mandatoryDisplayRole)
                    }}
                    onContextMenu={e => {
                      e.preventDefault(); e.stopPropagation()
                      store.selectMandatoryDot(synthFact.id, mandatoryDisplayRole)
                      onContextMenu?.(synthFact.id, mandatoryDisplayRole, e)
                    }}/>
                  <rect className="hover-ring"
                    x={pos.x - DOT_R - 3} y={pos.y - DOT_R - 3}
                    width={(DOT_R + 3) * 2} height={(DOT_R + 3) * 2}
                    rx={DOT_R + 3}/>
                </g>
              )
            }
          }

          return results
        }).flat().filter(Boolean)
      })}
    </g>
  )
}
