import React, { useCallback, useEffect, useRef, useState } from 'react'
import { useOrmStore } from '../store/ormStore'
import { formatValueRange, formatCardinalityRange, formatFrequencyRange } from './ObjectTypeNode'

const VR_DEFAULT_OFFSET = { dx: 0, dy: -50 }
const VR_FONT      = "'Segoe UI', Helvetica, Arial, sans-serif"
const VR_FONT_SIZE = 11
const VR_PAD_X     = 3   // horizontal margin inside text box
const VR_PAD_Y     = 3   // vertical margin inside text box

let _vrCanvas = null
function measureVrText(text) {
  if (!_vrCanvas) _vrCanvas = document.createElement('canvas')
  const ctx = _vrCanvas.getContext('2d')
  ctx.font = `${VR_FONT_SIZE}px ${VR_FONT}`
  return ctx.measureText(text).width
}

const NESTED_READING_FONT_SIZE = 13
const NESTED_READING_LINE_H    = 18   // font + line margin
const NESTED_READING_GAP       = 8    // gap between role boxes (or bars) and reading
const NESTED_READING_PAD_BELOW = 4    // gap between reading and bottom of outer box

let _readingCanvas = null
function measureNestedReadingText(text) {
  if (!_readingCanvas) _readingCanvas = document.createElement('canvas')
  const ctx = _readingCanvas.getContext('2d')
  ctx.font = `${NESTED_READING_FONT_SIZE}px ${VR_FONT}`
  return ctx.measureText(text).width
}

// Return the point on the text-box border closest to (fromX, fromY)
function vrBoxEdge(textX, textY, halfW, halfH, fromX, fromY) {
  const dx = fromX - textX, dy = fromY - textY
  if (dx === 0 && dy === 0) return { x: textX, y: textY }
  const t = Math.abs(dx) * halfH > Math.abs(dy) * halfW
    ? halfW / Math.abs(dx)
    : halfH / Math.abs(dy)
  return { x: textX + dx * t, y: textY + dy * t }
}

export const ROLE_W = 30
export const ROLE_H = 18
export const ROLE_GAP = 1

/** Returns the bounding rect of the outer entity box drawn around an objectified fact. */
export function nestedFactBounds(fact) {
  const PAD  = 10
  const n    = Math.max(fact.arity, 1)
  const isV  = fact.orientation === 'vertical'
  const barsBelow = !!fact.uniquenessBelow

  // Compute how many uniqueness bar levels are used (mirrors render logic)
  const hasUnary  = fact.uniqueness?.some(u => u.length === 1) ?? false
  let multiLevel  = hasUnary ? 0 : -1
  for (const u of (fact.uniqueness || [])) if (u.length > 1) multiLevel++
  const multiCount = multiLevel
  const hasAnyBar  = (fact.uniqueness?.length ?? 0) > 0
  const barSpace   = hasAnyBar
    ? BAR_MARGIN + BAR_SPACING * (multiCount + 1) + BAR_H / 2 + 5
    : 0
  const barPad = Math.max(PAD, Math.ceil(barSpace))

  // Compute reading text extent for nestedReading
  const readingText = fact.nestedReading ? getDisplayReading(fact) : ''
  const readingTextW = readingText ? measureNestedReadingText(readingText) : 0
  const READING_TIGHT_GAP = 4

  if (isV) {
    const totalH    = n * ROLE_W + (n - 1) * ROLE_GAP
    const padLeft   = barsBelow ? barPad : PAD
    const padRight  = barsBelow ? PAD    : barPad
    const padBottom = fact.nestedReading
      ? Math.max(PAD, READING_TIGHT_GAP + NESTED_READING_LINE_H + NESTED_READING_PAD_BELOW)
      : PAD
    return {
      left:   fact.x - ROLE_H / 2 - padLeft,
      right:  fact.x + ROLE_H / 2 + padRight,
      top:    fact.y - totalH / 2 - PAD,
      bottom: fact.y + totalH / 2 + padBottom,
      cx: fact.x, cy: fact.y,
    }
  }
  const totalW     = n * ROLE_W + (n - 1) * ROLE_GAP
  const ow         = Math.max(totalW + PAD * 2, readingTextW + PAD * 2)
  const readingPad = READING_TIGHT_GAP + NESTED_READING_LINE_H + NESTED_READING_PAD_BELOW
  const readingAboveActive = fact.nestedReading && !!fact.readingAbove
  const barsAbove = hasAnyBar && !barsBelow
  const readingAbovePad = Math.ceil(NESTED_READING_LINE_H * 1.5) + NESTED_READING_PAD_BELOW
  const padTop = readingAboveActive
    ? Math.max(barsAbove ? barPad : PAD, readingAbovePad)
    : (barsBelow ? PAD : barPad)
  const baseBottom = barsBelow ? barPad : PAD
  const padBottom = (fact.nestedReading && !readingAboveActive)
    ? Math.max(baseBottom, readingPad)
    : baseBottom
  return {
    left:   fact.x - ow / 2,
    right:  fact.x + ow / 2,
    top:    fact.y - ROLE_H / 2 - padTop,
    bottom: fact.y + ROLE_H / 2 + padBottom,
    cx: fact.x, cy: fact.y,
  }
}

export function buildDisplayReading(parts, n) {
  if (!parts || parts.every(p => !p?.trim())) return ''
  const t = i => parts[i]?.trim() || ''

  if (n === 1) {
    // Always include the dot so role position is unambiguous; only omit it
    // when both surrounding fragments are empty (handled by early return above).
    const tokens = []
    if (t(0)) tokens.push(t(0))
    tokens.push('...')
    if (t(1)) tokens.push(t(1))
    return tokens.join(' ')
  }

  // Interleave text parts with '...' role-position dots
  const tokens = []
  for (let i = 0; i <= n; i++) {
    if (t(i)) tokens.push(t(i))
    if (i < n) tokens.push('...')
  }
  // Trim leading/trailing dots only when BOTH outer fragments are empty —
  // if either the first or last fragment is non-empty the dots must stay so
  // the reader can see exactly where the roles sit in the reading.
  if (n === 2 && !t(0) && !t(n)) {
    while (tokens.length && tokens[0] === '...') tokens.shift()
    while (tokens.length && tokens[tokens.length - 1] === '...') tokens.pop()
  }
  return tokens.join(' ')
}

export function getDisplayReading(fact) {
  return buildDisplayReading(fact.readingParts, fact.arity)
}
const IF_CIRCLE_R = 8    // radius of internal-frequency constraint circle (matches external constraint size)
const IF_PAD_X    = 5    // horizontal padding inside IF stadium when range text is shown

let _ifCanvas = null
function measureIfText(text) {
  if (!_ifCanvas) _ifCanvas = document.createElement('canvas')
  const ctx = _ifCanvas.getContext('2d')
  ctx.font = `${VR_FONT_SIZE}px ${VR_FONT}`
  return ctx.measureText(text).width
}

/** Half-width of the IF shape: circle (IF_CIRCLE_R) when no label, stadium when label present. */
function ifShapeHalfW(label) {
  if (!label) return IF_CIRCLE_R
  return Math.max(IF_CIRCLE_R, (measureIfText(label) + IF_PAD_X * 2) / 2)
}

/**
 * If ri0 and ri1 are adjacent roles in the same fact, returns the point on their
 * shared edge (top/bottom for horizontal, left/right for vertical) closest to (cx, cy).
 * Otherwise returns null (fall back to individual connectors).
 */
function ifConsecutiveMidpoint(fact, ri0, ri1, cx, cy) {
  if (Math.abs(ri0 - ri1) !== 1) return null
  const rc0 = roleCenter(fact, ri0)
  const rc1 = roleCenter(fact, ri1)
  const midX = (rc0.x + rc1.x) / 2
  const midY = (rc0.y + rc1.y) / 2
  if (fact.orientation === 'vertical') {
    const lx = fact.x - ROLE_H / 2, rx = fact.x + ROLE_H / 2
    return (lx - cx) ** 2 < (rx - cx) ** 2 ? { x: lx, y: midY } : { x: rx, y: midY }
  }
  const ty = fact.y - ROLE_H / 2, by = fact.y + ROLE_H / 2
  return (ty - cy) ** 2 < (by - cy) ** 2 ? { x: midX, y: ty } : { x: midX, y: by }
}

/** Border point of a rounded-rect stadium facing toward (tx, ty). */
function stadiumEdge(cx, cy, hw, hh, tx, ty) {
  const dx = tx - cx, dy = ty - cy
  if (dx === 0 && dy === 0) return { x: cx, y: cy - hh }
  const t = Math.abs(dx) * hh > Math.abs(dy) * hw ? hw / Math.abs(dx) : hh / Math.abs(dy)
  return { x: cx + dx * t, y: cy + dy * t }
}

/**
 * Best cardinal anchor on a role box facing (tx, ty).
 * Mirrors roleAnchor() from RoleConnectors.jsx — duplicated to avoid circular imports.
 */
function computeRoleAnchor(fact, roleIndex, tx, ty) {
  const n      = Math.max(fact.arity, 1)
  const isFirst = roleIndex === 0
  const isLast  = roleIndex === n - 1
  if (fact.orientation === 'vertical') {
    const totalH   = n * ROLE_W + (n - 1) * ROLE_GAP
    const startY   = fact.y - totalH / 2
    const roleTopY = startY + roleIndex * (ROLE_W + ROLE_GAP)
    const leftX    = fact.x - ROLE_H / 2
    const cx       = fact.x
    const cy       = roleTopY + ROLE_W / 2
    const cands = [
      { x: cx,             y: roleTopY,          side: 'N' },
      { x: cx,             y: roleTopY + ROLE_W, side: 'S' },
      { x: leftX,          y: cy,                side: 'W' },
      { x: leftX + ROLE_H, y: cy,                side: 'E' },
    ].filter(c => !(c.side === 'N' && !isFirst) && !(c.side === 'S' && !isLast))
    let best = cands[0], bd = Infinity
    for (const p of cands) { const d = (p.x-tx)**2+(p.y-ty)**2; if (d < bd) { bd=d; best=p } }
    return best
  }
  const startX = fact.x - (n * ROLE_W + (n - 1) * ROLE_GAP) / 2
  const roleX  = startX + roleIndex * (ROLE_W + ROLE_GAP)
  const roleY  = fact.y - ROLE_H / 2
  const cx     = roleX + ROLE_W / 2
  const cy     = roleY + ROLE_H / 2
  const cands = [
    { x: cx,             y: roleY,          side: 'N' },
    { x: cx,             y: roleY + ROLE_H, side: 'S' },
    { x: roleX,          y: cy,             side: 'W' },
    { x: roleX + ROLE_W, y: cy,             side: 'E' },
  ].filter(c => !(c.side === 'E' && !isLast) && !(c.side === 'W' && !isFirst))
  let best = cands[0], bd = Infinity
  for (const p of cands) { const d = (p.x-tx)**2+(p.y-ty)**2; if (d < bd) { bd=d; best=p } }
  return best
}

const BAR_H       = 3    // stroke width of each uniqueness bar
const BAR_MARGIN  = 4    // gap between top of role box and lowest bar
const BAR_SPACING = 5    // vertical distance between successive bar levels
const PREF_OFFSET = 2.5  // shift for preferred uniqueness bar (keeps inner line at original pos)
const UNARY_CAP_R = 8

export function roleCenter(fact, roleIndex) {
  const n = Math.max(fact.arity, 1)
  if (fact.orientation === 'vertical') {
    const totalH = n * ROLE_W + (n - 1) * ROLE_GAP
    const startY = fact.y - totalH / 2
    return { x: fact.x, y: startY + roleIndex * (ROLE_W + ROLE_GAP) + ROLE_W / 2 }
  }
  const totalW = n * ROLE_W + (n - 1) * ROLE_GAP
  const startX = fact.x - totalW / 2
  return {
    x: startX + roleIndex * (ROLE_W + ROLE_GAP) + ROLE_W / 2,
    y: fact.y,
  }
}

export function roleLeft(fact, roleIndex) {
  const totalW = Math.max(fact.arity, 1) * ROLE_W + (Math.max(fact.arity, 1) - 1) * ROLE_GAP
  return fact.x - totalW / 2 + roleIndex * (ROLE_W + ROLE_GAP)
}

export function factBounds(fact) {
  const n = Math.max(fact.arity, 1)
  const multiCount = fact.uniqueness ? fact.uniqueness.filter(u => u.length > 1).length : 0
  const hasUnary   = fact.uniqueness ? fact.uniqueness.some(u => u.length === 1) : false
  const levelsUsed = (hasUnary ? 1 : 0) + multiCount + 1
  const barsBelow = !!fact.uniquenessBelow
  if (fact.orientation === 'vertical') {
    const totalH = n * ROLE_W + (n - 1) * ROLE_GAP
    const barsWidth = BAR_MARGIN + BAR_SPACING * (levelsUsed + 1)
    return {
      left:   fact.x - ROLE_H / 2 - (barsBelow ? barsWidth : 1),
      right:  fact.x + ROLE_H / 2 + (barsBelow ? 1 : barsWidth),
      top:    fact.y - totalH / 2 - 1,
      bottom: fact.y + totalH / 2 + 1,
    }
  }
  const totalW = n * ROLE_W + (n - 1) * ROLE_GAP
  const barsHeight = BAR_MARGIN + BAR_SPACING * (levelsUsed + 1)
  return {
    left:   fact.x - totalW / 2 - 1,
    right:  fact.x + totalW / 2 + 1,
    top:    fact.y - ROLE_H / 2 - (barsBelow ? 1 : barsHeight),
    bottom: fact.y + ROLE_H / 2 + (barsBelow ? barsHeight : 0) + 18,
  }
}

export default function FactTypeNode({ fact, onDragStart, onContextMenu, onRoleContextMenu, onBarContextMenu, onRoleValueClick, onNestedVrClick, onRoleCardinalityClick, onNestedCrClick, onIfContextMenu, onRoleValueContextMenu, onRoleCrContextMenu, onNestedVrContextMenu, onNestedCrContextMenu, isShared }) {
  const store = useOrmStore()
  const isSelected     = store.selectedId === fact.id || store.multiSelectedIds.includes(fact.id)
  const hasSelectedRole = store.selectedRole?.factId === fact.id
  const hasSelectedUniqueness = store.selectedUniqueness?.factId === fact.id
  // Visual selection: suppress fact-level highlight when a role or uniqueness bar is selected
  const isFactSelected  = isSelected && !hasSelectedRole && !hasSelectedUniqueness
  const isAssignTool      = store.tool === 'assignRole'
  const isSubtypeTool     = store.tool === 'addSubtype'
  const isTargetTool      = store.tool === 'addTargetConnector' && store.linkDraft?.type === 'targetConnector'
  const isUniquenessTool  = store.tool === 'addInternalUniqueness'
  const isFrequencyTool   = store.tool === 'addInternalFrequency'
  const isRoleValueTool   = store.tool === 'addConstraint:valueRange'
  const isCrTool          = store.tool === 'addConstraint:cardinality'
  const isConnectorTool = isAssignTool || isSubtypeTool || store.tool === 'connectConstraint'
  const isDraftFrom       = store.linkDraft?.type === 'subtype' && store.linkDraft.fromId === fact.id
  const isAssigning    = store.linkDraft?.type === 'roleAssign'
  const roleFirstDraft = isAssigning && store.linkDraft.factId === fact.id
  const inConstruction           = store.uniquenessConstruction?.factId === fact.id
  const ucRoles                  = inConstruction ? store.uniquenessConstruction.roleIndices : []
  const inFrequencyConstruction  = store.frequencyConstruction?.factId === fact.id
  const fcRoles                  = inFrequencyConstruction ? store.frequencyConstruction.roleIndices : []

  // Role boxes highlighted by constraint group table interaction
  const highlightedRoles = (() => {
    const h = store.constraintHighlight
    if (!h) return null
    const hc = store.constraints.find(c => c.id === h.constraintId)
    if (!hc) return null
    const result = new Set()
    const sequences = hc.sequences || []
    for (let gi = 0; gi < sequences.length; gi++) {
      if (h.sequenceIndex != null && h.sequenceIndex !== gi) continue
      for (let pi = 0; pi < sequences[gi].length; pi++) {
        if (h.positionIndex != null && h.positionIndex !== pi) continue
        const m = sequences[gi][pi]
        if (m.kind === 'role' && m.factId === fact.id) result.add(m.roleIndex)
      }
    }
    return result.size > 0 ? result : null
  })()
  const n      = Math.max(fact.arity, 1)
  const totalW = n * ROLE_W + (n - 1) * ROLE_GAP
  const startX = fact.x - totalW / 2
  const topY   = fact.y - ROLE_H / 2

  const handleMouseDown = useCallback((e) => {
    e.stopPropagation()
    if (e.button !== 0) return

    // Objectified (nested) facts also act as entity types for role assignment and subtype links
    if (fact.objectified) {
      if (isAssignTool) {
        const draft = store.linkDraft
        if (draft?.factId != null && draft?.roleIndex != null) {
          store.assignObjectTypeToRole(draft.factId, draft.roleIndex, fact.id)
          const autoReturn = draft?.autoReturn
          store.clearLinkDraft()
          if (autoReturn) store.setTool('select')
        } else {
          store.setTool('select')
        }
        return
      }
      if (store.tool === 'addSubtype') {
        if (!store.linkDraft) {
          store.setLinkDraft({ type: 'subtype', fromId: fact.id })
        } else if (store.linkDraft.fromId !== fact.id) {
          store.addSubtype(store.linkDraft.fromId, fact.id)
          store.clearLinkDraft()
          store.setTool('select')
        }
        return
      }
      if (store.tool === 'addTargetConnector' && store.linkDraft?.constraintId) {
        store.updateConstraint(store.linkDraft.constraintId, { targetObjectTypeId: fact.id })
        store.clearLinkDraft()
        store.setTool('select')
        return
      }
      if (isRoleValueTool) {
        const canHaveVr = fact.objectifiedKind === 'value'
          || (fact.objectifiedKind !== 'value' && fact.objectifiedRefMode && fact.objectifiedRefMode !== 'none')
        if (canHaveVr) { onNestedVrClick?.(e.clientX, e.clientY) }
        else { store.setTool('select') }
        return
      }
      if (isCrTool) {
        onNestedCrClick?.(e.clientX, e.clientY)
        return
      }
    }

    if (isRoleValueTool) { store.setTool('select'); return }
    if (isCrTool) { store.setTool('select'); return }
    if (isUniquenessTool) {
      store.setTool('select')
      store.startUniquenessConstruction(fact.id)
      return
    }
    if (isFrequencyTool) {
      store.setTool('select')
      store.startFrequencyConstruction(fact.id)
      return
    }
    if (isConnectorTool) {
      const wasConnect = store.tool === 'connectConstraint'
      if (store.sequenceConstruction) store.abandonSequenceConstruction()
      if (wasConnect) store.clearSelection()
      store.setTool('select')
      return
    }
    if (inConstruction) return  // Enter key confirms; clicking fact body does nothing
    if (inFrequencyConstruction) return  // Enter key confirms
    if (e.shiftKey) { store.shiftSelect(fact.id); return }
    store.select(fact.id, 'fact')
    onDragStart(fact.id, 'fact', e)
  }, [store, fact.id, onDragStart, isAssignTool, inConstruction, inFrequencyConstruction])

  const isRoleSelected = (ri) =>
    store.selectedRole?.factId === fact.id && store.selectedRole?.roleIndex === ri

  const handleRoleDoubleClick = useCallback((roleIndex, e) => {
    e.stopPropagation()
    if (store.sequenceConstruction || inConstruction) return
    if (store.tool !== 'select') return
    store.setTool('assignRole')
    store.setLinkDraft({ type: 'roleAssign', factId: fact.id, roleIndex, autoReturn: true })
  }, [store, fact.id, inConstruction])

  const handleRoleContextMenu = useCallback((roleIndex, e) => {
    if (isRoleSelected(roleIndex) && onRoleContextMenu) {
      e.preventDefault(); e.stopPropagation()
      onRoleContextMenu(roleIndex, e)
    } else {
      onContextMenu(e)
    }
  }, [onContextMenu, onRoleContextMenu, store.selectedRole])

  const handleRoleMouseDown = useCallback((roleIndex, e) => {
    e.stopPropagation()
    if (e.button !== 0) return
    if (e.detail >= 2) return  // second click of a double-click: do nothing
    if (e.shiftKey) { store.shiftSelect(fact.id); return }
    if (store.sequenceConstruction) {
      if (isVcConstruction && !vcEligibleRoles.has(roleIndex)) return
      store.collectSequenceMember({ kind: 'role', factId: fact.id, roleIndex })
      return
    }
    if (inConstruction) {
      store.toggleUniquenessConstructionRole(roleIndex)
      return
    }
    if (inFrequencyConstruction) {
      store.toggleFrequencyConstructionRole(roleIndex)
      return
    }
    if (isSubtypeTool) {
      if (fact.objectified) {
        if (!store.linkDraft) {
          store.setLinkDraft({ type: 'subtype', fromId: fact.id })
        } else if (store.linkDraft.fromId !== fact.id) {
          store.addSubtype(store.linkDraft.fromId, fact.id)
          store.clearLinkDraft()
          store.setTool('select')
        }
      } else {
        store.setTool('select')
      }
      return
    }
    if (store.tool === 'addTargetConnector') {
      if (fact.objectified && store.linkDraft?.constraintId) {
        store.updateConstraint(store.linkDraft.constraintId, { targetObjectTypeId: fact.id })
        store.clearLinkDraft()
        store.setTool('select')
      }
      return
    }
    if (store.tool === 'connectConstraint') { return }  // wait for user to click a constraint circle first
    if (isUniquenessTool) {
      store.setTool('select')
      store.startUniquenessConstruction(fact.id)
      return
    }
    if (isFrequencyTool) {
      store.setTool('select')
      store.startFrequencyConstruction(fact.id)
      return
    }
    if (store.tool === 'toggleMandatory') {
      const role = fact.roles[roleIndex]
      store.updateRole(fact.id, roleIndex, { mandatory: !role.mandatory })
      store.setTool('select')
      return
    }
    if (isRoleValueTool) {
      if (vrEligibleRoles.has(roleIndex)) onRoleValueClick?.(roleIndex, e.clientX, e.clientY)
      else store.setTool('select')
      return
    }
    if (isCrTool) {
      onRoleCardinalityClick?.(roleIndex, e.clientX, e.clientY)
      return
    }
    if (isAssignTool) {
      const draft = store.linkDraft
      if (draft?.factId === fact.id && draft?.roleIndex === roleIndex) {
        // Same role clicked again → abort
        const autoReturn = draft?.autoReturn
        store.clearLinkDraft()
        if (autoReturn) store.setTool('select')
        return
      }
      // If a source role was already chosen, clicking any other role cancels
      if (draft?.factId != null) {
        const autoReturn = draft?.autoReturn
        store.clearLinkDraft()
        if (autoReturn) store.setTool('select')
        return
      }
      // No source role yet (draft came from an object type click) → set this role as source
      store.setLinkDraft({ type: 'roleAssign', factId: fact.id, roleIndex, autoReturn: draft?.autoReturn ?? true })
      return
    }

    // Select mode: use click position to decide border (→ fact) vs interior (→ role)
    const thisRoleSelected = store.selectedRole?.factId === fact.id && store.selectedRole?.roleIndex === roleIndex
    const BORDER_PX = 3 * store.zoom
    const bbox = e.currentTarget.getBoundingClientRect()
    const inInterior = (
      e.clientX > bbox.left + BORDER_PX && e.clientX < bbox.right  - BORDER_PX &&
      e.clientY > bbox.top  + BORDER_PX && e.clientY < bbox.bottom - BORDER_PX
    )
    if (inInterior) {
      const startX = e.clientX, startY = e.clientY
      let done = false
      const onMove = (me) => {
        const dx = me.clientX - startX, dy = me.clientY - startY
        if (dx * dx + dy * dy > 16) {
          if (done) return; done = true
          window.removeEventListener('mousemove', onMove)
          window.removeEventListener('mouseup',   onUp)
          onDragStart(fact.id, 'fact', { clientX: startX, clientY: startY })
        }
      }
      const onUp = () => {
        if (done) return; done = true
        window.removeEventListener('mousemove', onMove)
        window.removeEventListener('mouseup',   onUp)
        if (thisRoleSelected) store.select(fact.id, 'fact')
        else                  store.selectRole(fact.id, roleIndex)
      }
      window.addEventListener('mousemove', onMove)
      window.addEventListener('mouseup',   onUp)
    } else {
      // Border click: select fact and start drag
      store.select(fact.id, 'fact')
      onDragStart(fact.id, 'fact', e)
    }
  }, [store, fact.id, isAssignTool, inConstruction, inFrequencyConstruction, isSelected, onDragStart])

  // ── Annotation drag (value-range labels + reading text) ───────────────────
  const vrDragRef       = useRef(null)
  const nestedVrDragRef = useRef(null)
  const crDragRef       = useRef(null)
  const nestedCrDragRef = useRef(null)
  const vrWasDragged       = useRef(false)
  const crWasDragged       = useRef(false)
  const nestedVrWasDragged = useRef(false)
  const nestedCrWasDragged = useRef(false)
  const ifDragRef         = useRef(null)   // { ifId, startX, startY, origX, origY } | null
  const ifWasDragged      = useRef(false)  // set true when existing IF circle drag threshold exceeded
  const ifConstrDragRef   = useRef(null)   // { startX, startY, origX, origY } | null (construction circle)
  const ifConstrWasDragged = useRef(false) // set true when construction circle drag threshold exceeded
  const readingDragRef  = useRef(null)
  const nameDragRef     = useRef(null)
  const [vrLive,       setVrLive]       = useState(null) // { roleIndex, dx, dy } | null
  const [nestedVrLive, setNestedVrLive] = useState(null) // { dx, dy } | null
  const [crLive,       setCrLive]       = useState(null) // { roleIndex, dx, dy } | null
  const [nestedCrLive, setNestedCrLive] = useState(null) // { dx, dy } | null
  const [ifLive,       setIfLive]       = useState(null) // { ifId, x, y } | null (existing IF circle live pos)
  const [ifConstrLive, setIfConstrLive] = useState(null) // { x, y } | null  (construction circle live pos)
  const [readingLive,    setReadingLive]    = useState(null)  // { dx, dy } | null
  const [nameLive,       setNameLive]       = useState(null)  // { dx, dy } | null
  const [editingName,    setEditingName]    = useState(false)
  const [nameDraft,      setNameDraft]      = useState('')
  const [editingReading,        setEditingReading]        = useState(false)
  const [editingReadingIsReverse, setEditingReadingIsReverse] = useState(false)
  const [readingDraft,          setReadingDraft]          = useState([])  // string[] of length arity+1
  const nameInputRef = useRef(null)
  const [editingRefMode, setEditingRefMode] = useState(false)
  const [refModeDraft,   setRefModeDraft]   = useState('')
  const refModeInputRef = useRef(null)

  useEffect(() => {
    const onMove = (e) => {
      const zoom = useOrmStore.getState().zoom
      const d = vrDragRef.current
      if (d) {
        const rawDx = e.clientX - d.startX, rawDy = e.clientY - d.startY
        if (rawDx*rawDx + rawDy*rawDy > 9) vrWasDragged.current = true
        setVrLive({ roleIndex: d.roleIndex, dx: d.origDx + rawDx / zoom, dy: d.origDy + rawDy / zoom })
      }
      const nvd = nestedVrDragRef.current
      if (nvd) {
        const rawDx = e.clientX - nvd.startX, rawDy = e.clientY - nvd.startY
        if (rawDx*rawDx + rawDy*rawDy > 9) nestedVrWasDragged.current = true
        setNestedVrLive({ dx: nvd.origDx + rawDx / zoom, dy: nvd.origDy + rawDy / zoom })
      }
      const cd = crDragRef.current
      if (cd) {
        const rawDx = e.clientX - cd.startX, rawDy = e.clientY - cd.startY
        if (rawDx*rawDx + rawDy*rawDy > 9) crWasDragged.current = true
        setCrLive({ roleIndex: cd.roleIndex, dx: cd.origDx + rawDx / zoom, dy: cd.origDy + rawDy / zoom })
      }
      const ncd = nestedCrDragRef.current
      if (ncd) {
        const rawDx = e.clientX - ncd.startX, rawDy = e.clientY - ncd.startY
        if (rawDx*rawDx + rawDy*rawDy > 9) nestedCrWasDragged.current = true
        setNestedCrLive({ dx: ncd.origDx + rawDx / zoom, dy: ncd.origDy + rawDy / zoom })
      }
      const rd = readingDragRef.current
      if (rd) {
        const dx = rd.origDx + (e.clientX - rd.startX) / zoom
        const dy = rd.origDy + (e.clientY - rd.startY) / zoom
        setReadingLive({ dx, dy })
      }
      const ifd = ifDragRef.current
      if (ifd) {
        const rawDx = e.clientX - ifd.startX, rawDy = e.clientY - ifd.startY
        if (rawDx*rawDx + rawDy*rawDy > 9) ifWasDragged.current = true
        setIfLive({ ifId: ifd.ifId, x: ifd.origX + rawDx / zoom, y: ifd.origY + rawDy / zoom })
      }
      const ifcd = ifConstrDragRef.current
      if (ifcd) {
        const dx = e.clientX - ifcd.startX, dy = e.clientY - ifcd.startY
        if (dx*dx + dy*dy > 9) ifConstrWasDragged.current = true
        const x = ifcd.origX + dx / zoom
        const y = ifcd.origY + dy / zoom
        setIfConstrLive({ x, y })
      }
      const nd = nameDragRef.current
      if (nd) {
        const dx = nd.origDx + (e.clientX - nd.startX) / zoom
        const dy = nd.origDy + (e.clientY - nd.startY) / zoom
        setNameLive({ dx, dy })
      }
    }
    const onUp = (e) => {
      const zoom = useOrmStore.getState().zoom
      const ifd = ifDragRef.current
      if (ifd) {
        const x = ifd.origX + (e.clientX - ifd.startX) / zoom
        const y = ifd.origY + (e.clientY - ifd.startY) / zoom
        useOrmStore.getState().updateInternalFrequency(fact.id, ifd.ifId, { x, y })
        ifDragRef.current = null
        setIfLive(null)
      }
      const ifcd = ifConstrDragRef.current
      if (ifcd) {
        const x = ifcd.origX + (e.clientX - ifcd.startX) / zoom
        const y = ifcd.origY + (e.clientY - ifcd.startY) / zoom
        useOrmStore.getState().moveFrequencyConstructionCircle(x, y)
        ifConstrDragRef.current = null
        setIfConstrLive(null)
      }
      const d = vrDragRef.current
      if (d) {
        const dx = d.origDx + (e.clientX - d.startX) / zoom
        const dy = d.origDy + (e.clientY - d.startY) / zoom
        useOrmStore.getState().updateValueRangeOffset(fact.id, d.roleIndex, { dx, dy })
        vrDragRef.current = null
        setVrLive(null)
      }
      const nvd = nestedVrDragRef.current
      if (nvd) {
        const dx = nvd.origDx + (e.clientX - nvd.startX) / zoom
        const dy = nvd.origDy + (e.clientY - nvd.startY) / zoom
        useOrmStore.getState().updateFact(fact.id, { valueRangeOffset: { dx, dy } })
        nestedVrDragRef.current = null
        setNestedVrLive(null)
      }
      const cd = crDragRef.current
      if (cd) {
        const dx = cd.origDx + (e.clientX - cd.startX) / zoom
        const dy = cd.origDy + (e.clientY - cd.startY) / zoom
        useOrmStore.getState().updateCardinalityRangeOffset(fact.id, cd.roleIndex, { dx, dy })
        crDragRef.current = null
        setCrLive(null)
      }
      const ncd = nestedCrDragRef.current
      if (ncd) {
        const dx = ncd.origDx + (e.clientX - ncd.startX) / zoom
        const dy = ncd.origDy + (e.clientY - ncd.startY) / zoom
        useOrmStore.getState().updateFact(fact.id, { cardinalityRangeOffset: { dx, dy } })
        nestedCrDragRef.current = null
        setNestedCrLive(null)
      }
      const rd = readingDragRef.current
      if (rd) {
        const dx = rd.origDx + (e.clientX - rd.startX) / zoom
        const dy = rd.origDy + (e.clientY - rd.startY) / zoom
        useOrmStore.getState().updateFactLayout(fact.id, { readingOffset: { dx, dy } })
        readingDragRef.current = null
        setReadingLive(null)
      }
      const nd = nameDragRef.current
      if (nd) {
        const dx = nd.origDx + (e.clientX - nd.startX) / zoom
        const dy = nd.origDy + (e.clientY - nd.startY) / zoom
        useOrmStore.getState().updateFactLayout(fact.id, { nameOffset: { dx, dy } })
        nameDragRef.current = null
        setNameLive(null)
      }
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup',   onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup',   onUp)
    }
  }, [fact.id])

  const commitNameEdit = useCallback(() => {
    setEditingName(false)
    const trimmed = nameDraft.trim()
    store.updateFact(fact.id, { objectifiedName: trimmed })
  }, [nameDraft, fact.id, store])

  useEffect(() => {
    if (editingName && nameInputRef.current) {
      nameInputRef.current.focus()
      nameInputRef.current.select()
    }
  }, [editingName])

  const commitRefModeEdit = useCallback(() => {
    setEditingRefMode(false)
    store.updateFact(fact.id, { objectifiedRefMode: refModeDraft.trim() })
    window.getSelection()?.removeAllRanges()
    setTimeout(() => window.getSelection()?.removeAllRanges(), 0)
  }, [refModeDraft, fact.id, store])

  const commitReadingEdit = useCallback(() => {
    const parts = readingDraft.map(p => p.trim())
    while (parts.length < fact.arity + 1) parts.push('')
    parts.length = fact.arity + 1
    if (editingReadingIsReverse) {
      store.updateAlternativeReading(fact.id, [1, 0], parts)
    } else {
      store.updateFact(fact.id, { readingParts: parts })
    }
    setEditingReading(false)
  }, [readingDraft, editingReadingIsReverse, fact.arity, fact.id, store])

  useEffect(() => {
    if (editingRefMode && refModeInputRef.current) {
      refModeInputRef.current.focus()
      refModeInputRef.current.select()
    }
  }, [editingRefMode])

  // Commit reading edit when user clicks outside the foreignObject
  useEffect(() => {
    if (!editingReading) return
    const onDown = (e) => { if (!e.target.closest?.('foreignObject')) commitReadingEdit() }
    window.addEventListener('mousedown', onDown, true)
    return () => window.removeEventListener('mousedown', onDown, true)
  }, [editingReading, commitReadingEdit])

  // Commit name/refMode/reading edits when the fact is deselected
  useEffect(() => {
    if (!isSelected && editingName) commitNameEdit()
    if (!isSelected && editingRefMode) commitRefModeEdit()
    if (!isSelected && editingReading) commitReadingEdit()
  }, [isSelected])  // eslint-disable-line react-hooks/exhaustive-deps

  // Commit name edit when user clicks outside the foreignObject
  useEffect(() => {
    if (!editingName) return
    const onDown = (e) => { if (!e.target.closest?.('foreignObject')) commitNameEdit() }
    window.addEventListener('mousedown', onDown, true)
    return () => window.removeEventListener('mousedown', onDown, true)
  }, [editingName, commitNameEdit])

  // Commit ref-mode edit when user clicks outside the foreignObject
  useEffect(() => {
    if (!editingRefMode) return
    const onDown = (e) => { if (!e.target.closest?.('foreignObject')) commitRefModeEdit() }
    window.addEventListener('mousedown', onDown, true)
    return () => window.removeEventListener('mousedown', onDown, true)
  }, [editingRefMode, commitRefModeEdit])

  const isNestedSubtypeCandidate = fact.objectified && !isDraftFrom && (isSubtypeTool || isTargetTool)
  // Stage-1 frequency: tool is active but no construction started yet → fact is selectable candidate
  const isFrequencyCandidate = isFrequencyTool && !store.frequencyConstruction
  const roleStroke    = isFactSelected               ? 'var(--accent)'
    : isUniquenessTool                               ? 'var(--col-candidate)'
    : isFrequencyCandidate                           ? 'var(--col-candidate)'
    : (isDraftFrom && fact.objectified)              ? 'var(--col-subtype)'
    :                                                  'var(--col-fact)'
  const roleStrokeW   = isFactSelected ? 2 : (isUniquenessTool || isFrequencyCandidate || (isDraftFrom && fact.objectified)) ? 2 : 1.5
  const gc = store.sequenceConstruction
  const gcConstraint = gc ? store.constraints.find(c => c.id === gc.constraintId) : null
  const isVcConstruction = gcConstraint?.constraintType === 'valueComparison'

  // Helper: is a role connected to a value type or entity with a reference mode?
  const isVrEligibleRole = (role) => {
    if (!role.objectTypeId) return false
    const ot = store.objectTypes.find(o => o.id === role.objectTypeId)
    if (ot) return ot.kind === 'value' || (ot.kind === 'entity' && ot.refMode && ot.refMode !== 'none')
    const nestedFact = store.facts.find(f => f.id === role.objectTypeId)
    return !!(nestedFact && nestedFact.objectified && nestedFact.objectifiedKind === 'value')
  }

  const vcEligibleRoles = isVcConstruction ? new Set(
    fact.roles.flatMap((role, ri) => isVrEligibleRole(role) ? [ri] : [])
  ) : null

  const isRoleCandidate = (isAssignTool && !isAssigning) || store.tool === 'toggleMandatory' || isUniquenessTool
    || isFrequencyCandidate  // stage 1: all facts' roles are candidate
    || (!!gc && !isVcConstruction)
  // Roles eligible for a value range constraint: connected to a value type or entity with a reference mode
  const vrEligibleRoles = isRoleValueTool ? new Set(
    fact.roles.flatMap((role, ri) => isVrEligibleRole(role) ? [ri] : [])
  ) : null
  const roleIsCandidate = (ri) => isRoleCandidate || (isRoleValueTool && vrEligibleRoles.has(ri)) || (isVcConstruction && vcEligibleRoles.has(ri)) || isCrTool
  const roleHighlight = isRoleCandidate ? 'var(--fill-candidate)' : '#ffffff'

  const isVertical = fact.orientation === 'vertical'

  // ── Uniqueness bar level assignment ────────────────────────────────────────
  // The uniqueness array is kept sorted in the store (ascending role count),
  // so level assignment here is simply positional.
  const hasUnary = fact.uniqueness.some(u => u.length === 1)
  let multiLevel = hasUnary ? 0 : -1
  const levels = fact.uniqueness.map(uRoles =>
    uRoles.length === 1 ? 0 : ++multiLevel
  )
  const multiCount = multiLevel
  const ifItems = fact.internalFrequency || []

  const INSET = 2
  const FONT = "'Segoe UI', Helvetica, Arial, sans-serif"
  const barsBelow = !!fact.uniquenessBelow
  const prefKey = fact.preferredUniqueness
    ? JSON.stringify([...fact.preferredUniqueness].sort((a, b) => a - b))
    : null
  const pIdx = prefKey !== null
    ? fact.uniqueness.findIndex(u => JSON.stringify([...u].sort((a, b) => a - b)) === prefKey)
    : -1
  const pLevel = pIdx >= 0 ? levels[pIdx] : -1

  // Bar coordinate helpers
  const barY_h = (level) => barsBelow
    ? topY + ROLE_H + BAR_MARGIN + BAR_SPACING * (level + 1) - BAR_H / 2
    : topY - BAR_MARGIN - BAR_SPACING * (level + 1) + BAR_H / 2

  // Adjust barY to keep the preferred bar's inner line at the original position,
  // and shift bars further from role boxes (above the preferred) by the same amount.
  const adjustedBarY = (level, isThisPreferred) => {
    if (pLevel < 0) return barY_h(level)
    const isAbove = level > pLevel  // further from role boxes in both orientations
    // Bars above shift by 2×PREF_OFFSET so their gap from the preferred outer line
    // equals the normal BAR_SPACING; the preferred bar itself shifts by 1×PREF_OFFSET.
    const shiftCount = (isAbove ? 2 : 0) + (isThisPreferred ? 1 : 0)
    const dir = barsBelow ? 1 : -1  // positive = away from role boxes
    return barY_h(level) + dir * PREF_OFFSET * shiftCount
  }

  // ── Horizontal helpers ─────────────────────────────────────────────────────
  function buildRuns(uRoles, level, ui) {
    const roleSet = new Set(uRoles)
    const minRI   = Math.min(...uRoles)
    const maxRI   = Math.max(...uRoles)
    const barY    = barY_h(level)
    const spanX1  = startX + minRI * (ROLE_W + ROLE_GAP)
    const spanX2  = startX + maxRI * (ROLE_W + ROLE_GAP) + ROLE_W
    const runs    = []
    let runStart  = minRI
    let runSolid  = roleSet.has(minRI)
    for (let ri = minRI + 1; ri <= maxRI + 1; ri++) {
      const solid = ri <= maxRI ? roleSet.has(ri) : null
      if (solid !== runSolid || ri > maxRI) {
        let x1 = startX + runStart * (ROLE_W + ROLE_GAP)
        let x2 = startX + (ri - 1) * (ROLE_W + ROLE_GAP) + ROLE_W
        if (x1 === spanX1) x1 += INSET
        if (x2 === spanX2) x2 -= INSET
        runs.push({ x1, x2, solid: runSolid, key: `${ui}-${runStart}` })
        runStart = ri
        runSolid = solid
      }
    }
    return { barY, runs }
  }

  // ── Vertical helpers ───────────────────────────────────────────────────────
  const totalH_v  = n * ROLE_W + (n - 1) * ROLE_GAP
  const startY_v  = fact.y - totalH_v / 2
  const leftX_v   = fact.x - ROLE_H / 2

  const barX_v = (level) => barsBelow
    ? leftX_v - BAR_MARGIN - BAR_SPACING * (level + 1) + BAR_H / 2
    : leftX_v + ROLE_H + BAR_MARGIN + BAR_SPACING * (level + 1) - BAR_H / 2

  // Adjust barX similarly: inner line of preferred stays put; bars further away shift outward.
  const adjustedBarX = (level, isThisPreferred) => {
    if (pLevel < 0) return barX_v(level)
    const isAbove = level > pLevel
    const shiftCount = (isAbove ? 2 : 0) + (isThisPreferred ? 1 : 0)
    const dir = barsBelow ? -1 : 1  // barsBelow=false → bars right (+X); barsBelow=true → bars left (-X)
    return barX_v(level) + dir * PREF_OFFSET * shiftCount
  }

  function buildRunsV(uRoles, level, ui) {
    const roleSet = new Set(uRoles)
    const minRI   = Math.min(...uRoles)
    const maxRI   = Math.max(...uRoles)
    const barX    = barX_v(level)
    const spanY1  = startY_v + minRI * (ROLE_W + ROLE_GAP)
    const spanY2  = startY_v + maxRI * (ROLE_W + ROLE_GAP) + ROLE_W
    const runs    = []
    let runStart  = minRI
    let runSolid  = roleSet.has(minRI)
    for (let ri = minRI + 1; ri <= maxRI + 1; ri++) {
      const solid = ri <= maxRI ? roleSet.has(ri) : null
      if (solid !== runSolid || ri > maxRI) {
        let y1 = startY_v + runStart * (ROLE_W + ROLE_GAP)
        let y2 = startY_v + (ri - 1) * (ROLE_W + ROLE_GAP) + ROLE_W
        if (y1 === spanY1) y1 += INSET
        if (y2 === spanY2) y2 -= INSET
        runs.push({ y1, y2, solid: runSolid, key: `${ui}-${runStart}` })
        runStart = ri
        runSolid = solid
      }
    }
    return { barX, runs }
  }

  // Shared bar click handler
  const barClickHandler = (ui) => (e) => {
    e.stopPropagation()
    if (isConnectorTool || store.sequenceConstruction) {
      const wasConnect = store.tool === 'connectConstraint'
      store.abandonSequenceConstruction()
      if (wasConnect) store.clearSelection()
      store.setTool('select')
      return
    }
    if (inConstruction && store.uniquenessConstruction?.uIndex === ui) {
      store.commitUniquenessConstruction()
      return
    }
    const alreadySelected = store.selectedUniqueness?.factId === fact.id && store.selectedUniqueness?.uIndex === ui
    if (alreadySelected) store.clearSelection()
    else store.selectUniqueness(fact.id, ui)
  }

  const barDoubleClickHandler = (ui) => (e) => {
    e.stopPropagation()
    store.startUniquenessEdit(fact.id, ui)
  }

  // ── Reading text builder ───────────────────────────────────────────────────
  function renderReading() {
    const forwardReading = getDisplayReading(fact)
    const displayMode = fact.arity === 2 ? (fact.readingDisplay || 'forward') : 'forward'
    let text = forwardReading

    if (displayMode === 'both' || displayMode === 'reverse') {
      const reverseAlt = (fact.alternativeReadings || []).find(
        r => r.roleOrder.length === 2 && r.roleOrder[0] === 1 && r.roleOrder[1] === 0
      )
      const reverseReading = reverseAlt ? buildDisplayReading(reverseAlt.parts, 2) : ''
      if (displayMode === 'both') {
        text = [forwardReading, reverseReading].filter(Boolean).join(' / ')
      } else {
        text = reverseReading ? ((isVertical ? '▲ ' : '◀ ') + reverseReading) : ''
      }
    }

    if (!text && !editingReading) return null

    const AUTO_DX = (() => {
      if (!isVertical) return 0
      if (!fact.objectified) return fact.readingAbove ? ROLE_H / 2 + 40 : -(ROLE_H / 2 + 40)
      // Measure the text so the reading edge (not just centre) clears the outer box
      if (!_vrCanvas) _vrCanvas = document.createElement('canvas')
      const _ctx = _vrCanvas.getContext('2d')
      _ctx.font = `14px ${VR_FONT}`
      const tw = _ctx.measureText(text).width
      const bounds = nestedFactBounds(fact)
      return fact.readingAbove
        ? bounds.right - fact.x + tw / 2 + 10
        : bounds.left  - fact.x - tw / 2 - 10
    })()
    const AUTO_DY = isVertical ? 0
      : fact.readingAbove ? -(ROLE_H / 2 + 18)
      : fact.objectified  ? nestedFactBounds(fact).bottom - fact.y + (isShared ? 18 : 10)
      : ROLE_H / 2 + 18
    const off = readingLive ?? (fact.readingOffset ?? { dx: AUTO_DX, dy: AUTO_DY })
    const tx = fact.x + off.dx
    const ty = fact.y + off.dy
    const isDraggingReading = !!readingLive

    if (editingReading) {
      const W = Math.max(120,
        readingDraft.reduce((s, seg) => s + Math.max(12, seg.length * 7), 0)
        + fact.arity * 18 + 8)
      return (
        <foreignObject x={tx - W / 2} y={ty - 12} width={W} height={24}>
          <div style={{ display:'flex', alignItems:'center', height:'100%', background:'#fff',
            border:'1px solid var(--accent)', borderRadius:3, padding:'0 4px', boxSizing:'border-box' }}>
            {readingDraft.map((seg, i) => (
              <React.Fragment key={i}>
                <input
                  // eslint-disable-next-line jsx-a11y/no-autofocus
                  autoFocus={i === 0}
                  value={seg}
                  onChange={e => { const v = e.target.value; setReadingDraft(prev => { const next = [...prev]; next[i] = v; return next }) }}
                  onBlur={() => { setTimeout(() => { if (!document.activeElement?.closest?.('foreignObject')) commitReadingEdit() }, 0) }}
                  onKeyDown={e => { e.stopPropagation(); if (e.key === 'Enter') { e.preventDefault(); commitReadingEdit() } if (e.key === 'Escape') { e.stopPropagation(); setEditingReading(false) } }}
                  onMouseDown={e => e.stopPropagation()}
                  style={{ width: Math.max(12, seg.length * 7), minWidth: 0, border:'none',
                    outline:'none', background:'#fef6ec', color:'var(--ink-2)',
                    fontSize:13, fontFamily:FONT, textAlign:'center',
                    padding:'0', boxSizing:'border-box' }}
                />
                {i < fact.arity && (
                  <span style={{ userSelect:'none', pointerEvents:'none', color:'var(--col-constraint)',
                    fontWeight:700, fontSize:13, fontFamily:FONT, padding:'0 2px', flexShrink:0 }}>...</span>
                )}
              </React.Fragment>
            ))}
          </div>
        </foreignObject>
      )
    }

    return (
      <text x={tx} y={ty} textAnchor="middle" dominantBaseline="middle"
        fontSize={14} fill="var(--ink-3)" fontFamily={FONT}
        style={{ cursor: isDraggingReading ? 'grabbing' : 'grab', userSelect: 'none' }}
        onMouseDown={e => {
          e.stopPropagation()
          readingDragRef.current = { startX: e.clientX, startY: e.clientY, origDx: off.dx, origDy: off.dy }
          setReadingLive({ dx: off.dx, dy: off.dy })
        }}
        onDoubleClick={e => {
          e.stopPropagation()
          if (store.sequenceConstruction || inConstruction || inFrequencyConstruction) return
          let isReverse = displayMode === 'reverse'
          if (displayMode === 'both') {
            const ctm = e.currentTarget.ownerSVGElement?.getScreenCTM()
            const worldClickX = ctm ? (e.clientX - ctm.e) / ctm.a : e.clientX
            isReverse = worldClickX > tx
          }
          if (isReverse) {
            const reverseAlt = (fact.alternativeReadings || []).find(
              r => r.roleOrder.length === 2 && r.roleOrder[0] === 1 && r.roleOrder[1] === 0
            )
            const existing = reverseAlt?.parts || []
            setReadingDraft(Array.from({ length: fact.arity + 1 }, (_, i) => existing[i] ?? ''))
          } else {
            const existing = fact.readingParts || []
            setReadingDraft(Array.from({ length: fact.arity + 1 }, (_, i) => existing[i] ?? ''))
          }
          setEditingReadingIsReverse(isReverse)
          setEditingReading(true)
        }}>
        {text}
      </text>
    )
  }

  // ── VR annotation helpers ─────────────────────────────────────────────────
  const VR_DEFAULT = isVertical ? { dx: -50, dy: 0 } : VR_DEFAULT_OFFSET
  const CR_DEFAULT = isVertical ? { dx: 50, dy: 0 } : { dx: 0, dy: 50 }

  function vrConnPoint(ri, textX, textY) {
    if (isVertical) {
      const roleTopY = startY_v + ri * (ROLE_W + ROLE_GAP)
      const roleCY   = roleTopY + ROLE_W / 2
      const dxT = textX - fact.x, dyT = textY - roleCY
      const angle = Math.atan2(dyT, dxT), abs = Math.abs(angle)
      if (abs < Math.PI / 4)              return { x: leftX_v + ROLE_H, y: roleCY }  // E
      if (abs > 3 * Math.PI / 4)          return { x: leftX_v,          y: roleCY }  // W
      if (angle < 0)                       return { x: fact.x,           y: roleTopY }         // N
      return                                      { x: fact.x,           y: roleTopY + ROLE_W } // S
    }
    const roleCX = startX + ri * (ROLE_W + ROLE_GAP) + ROLE_W / 2
    const rx = startX + ri * (ROLE_W + ROLE_GAP)
    const dxT = textX - roleCX, dyT = textY - fact.y
    const angle = Math.atan2(dyT, dxT), abs = Math.abs(angle)
    if (abs < Math.PI / 4)              return { x: rx + ROLE_W, y: fact.y }  // E
    if (abs > 3 * Math.PI / 4)          return { x: rx,          y: fact.y }  // W
    if (angle < 0)                       return { x: roleCX,      y: topY }           // N
    return                                      { x: roleCX,      y: topY + ROLE_H }  // S
  }

  // ── Nested fact VR/CR annotations (computed here so they render outside the glow group) ──
  const nestedVrAnnotation = !fact.objectified ? null : (() => {
    const canHaveVr = fact.objectifiedKind === 'value'
      || (fact.objectifiedKind !== 'value' && fact.objectifiedRefMode && fact.objectifiedRefMode !== 'none')
    if (!canHaveVr) return null
    const vr = formatValueRange(fact.valueRange)
    if (!vr) return null
    const nb = nestedFactBounds(fact)
    const nbCx = (nb.left + nb.right) / 2
    const nbCy = (nb.top + nb.bottom) / 2
    const nbHW = (nb.right - nb.left) / 2
    const nbHH = (nb.bottom - nb.top) / 2
    const defaultOff = { dx: 0, dy: nbHH + 14 }
    const off = nestedVrLive ?? (fact.valueRangeOffset ?? defaultOff)
    const tx = nbCx + off.dx
    const ty = nbCy + off.dy
    const dxL = tx - nbCx, dyL = ty - nbCy
    const tBox = (dxL === 0 && dyL === 0) ? 0
      : (Math.abs(dxL) * nbHH > Math.abs(dyL) * nbHW)
        ? nbHW / Math.abs(dxL) : nbHH / Math.abs(dyL)
    const connX = nbCx + dxL * tBox
    const connY = nbCy + dyL * tBox
    const halfW = measureVrText(vr) / 2 + VR_PAD_X
    const halfH = VR_FONT_SIZE / 2 + VR_PAD_Y
    const lineEnd = vrBoxEdge(tx, ty, halfW, halfH, connX, connY)
    return (() => {
        const nvDesc = { nestedFactId: fact.id }
        const isNvSelected = store.selectedValueRange?.nestedFactId === fact.id
        const nvFill = isNvSelected ? 'var(--accent)' : 'var(--col-constraint)'
        return (
          <g key="nested-vr" style={{ filter: isNvSelected ? 'drop-shadow(0 0 3px var(--accent))' : undefined }}>
            <line x1={connX} y1={connY} x2={lineEnd.x} y2={lineEnd.y}
              stroke={nvFill} strokeWidth={1.5}
              strokeDasharray="5 3" style={{ pointerEvents: 'none' }}/>
            <text x={tx} y={ty}
              textAnchor="middle" dominantBaseline="middle"
              fill={nvFill} fontSize={VR_FONT_SIZE} fontFamily={VR_FONT}
              style={{ cursor: nestedVrLive ? 'grabbing' : 'grab', userSelect: 'none' }}
              onMouseDown={e => {
                e.stopPropagation()
                nestedVrWasDragged.current = false
                nestedVrDragRef.current = { startX: e.clientX, startY: e.clientY, origDx: off.dx, origDy: off.dy }
                setNestedVrLive({ dx: off.dx, dy: off.dy })
              }}
              onClick={e => {
                e.stopPropagation()
                if (nestedVrWasDragged.current) { nestedVrWasDragged.current = false; return }
                if (isNvSelected) store.deselectValueRange()
                else store.selectValueRange(nvDesc)
              }}
              onContextMenu={e => {
                e.preventDefault(); e.stopPropagation()
                store.selectValueRange(nvDesc)
                onNestedVrContextMenu?.(e)
              }}>
              {vr}
            </text>
          </g>
        )
      })()
  })()

  const nestedCrAnnotation = !fact.objectified ? null : (() => {
    const cr = formatCardinalityRange(fact.cardinalityRange)
    if (!cr) return null
    const nb = nestedFactBounds(fact)
    const nbCx = (nb.left + nb.right) / 2
    const nbCy = (nb.top + nb.bottom) / 2
    const nbHW = (nb.right - nb.left) / 2
    const nbHH = (nb.bottom - nb.top) / 2
    const defaultOff = { dx: 0, dy: -(nbHH + 14) }
    const off = nestedCrLive ?? (fact.cardinalityRangeOffset ?? defaultOff)
    const tx = nbCx + off.dx
    const ty = nbCy + off.dy
    const dxL = tx - nbCx, dyL = ty - nbCy
    const tBox = (dxL === 0 && dyL === 0) ? 0
      : (Math.abs(dxL) * nbHH > Math.abs(dyL) * nbHW)
        ? nbHW / Math.abs(dxL) : nbHH / Math.abs(dyL)
    const connX = nbCx + dxL * tBox
    const connY = nbCy + dyL * tBox
    const halfW = measureVrText(cr) / 2 + VR_PAD_X
    const halfH = VR_FONT_SIZE / 2 + VR_PAD_Y
    const lineEnd = vrBoxEdge(tx, ty, halfW, halfH, connX, connY)
    return (() => {
        const ncDesc = { nestedFactId: fact.id }
        const isNcSelected = store.selectedCardinalityRange?.nestedFactId === fact.id
        const ncFill = isNcSelected ? 'var(--accent)' : 'var(--col-constraint)'
        return (
          <g key="nested-cr" style={{ filter: isNcSelected ? 'drop-shadow(0 0 3px var(--accent))' : undefined }}>
            <line x1={connX} y1={connY} x2={lineEnd.x} y2={lineEnd.y}
              stroke={ncFill} strokeWidth={1.5}
              strokeDasharray="5 3" style={{ pointerEvents: 'none' }}/>
            <text x={tx} y={ty}
              textAnchor="middle" dominantBaseline="middle"
              fill={ncFill} fontSize={VR_FONT_SIZE} fontFamily={VR_FONT}
              style={{ cursor: nestedCrLive ? 'grabbing' : 'grab', userSelect: 'none' }}
              onMouseDown={e => {
                e.stopPropagation()
                nestedCrWasDragged.current = false
                nestedCrDragRef.current = { startX: e.clientX, startY: e.clientY, origDx: off.dx, origDy: off.dy }
                setNestedCrLive({ dx: off.dx, dy: off.dy })
              }}
              onClick={e => {
                e.stopPropagation()
                if (nestedCrWasDragged.current) { nestedCrWasDragged.current = false; return }
                if (isNcSelected) store.deselectCardinalityRange()
                else store.selectCardinalityRange(ncDesc)
              }}
              onContextMenu={e => {
                e.preventDefault(); e.stopPropagation()
                store.selectCardinalityRange(ncDesc)
                onNestedCrContextMenu?.(e)
              }}>
              {cr}
            </text>
          </g>
        )
      })()
  })()

  return (
  <>
    {/* Shared-across-diagrams shadow — role boxes footprint only (non-objectified) */}
    {isShared && !fact.objectified && (
      <rect
        x={isVertical ? leftX_v : fact.x - totalW / 2}
        y={isVertical ? startY_v : topY}
        width={isVertical ? ROLE_H : totalW}
        height={isVertical ? totalH_v : ROLE_H}
        fill="white" stroke="none"
        filter="url(#sharedGlow)"
        style={{ pointerEvents: 'none' }}/>
    )}
    {/* ── Main fact-type group (role boxes + bars + reading) ───────────────── */}
    <g onMouseDown={handleMouseDown} onContextMenu={onContextMenu}
       style={{ cursor: (() => {
         if ((isSubtypeTool || isTargetTool) && fact.objectified) return 'cell'
         if (isAssignTool && isAssigning && fact.objectified) return 'cell'
         if (isRoleValueTool && fact.objectified) {
           const canHaveVr = fact.objectifiedKind === 'value'
             || (fact.objectifiedKind !== 'value' && fact.objectifiedRefMode && fact.objectifiedRefMode !== 'none')
           return canHaveVr ? 'pointer' : 'not-allowed'
         }
         if (isCrTool && fact.objectified) return 'pointer'
         return 'grab'
       })() }}
       filter={isFactSelected || isDraftFrom ? 'url(#selectGlow)' : undefined}>

      {/* Objectified (nested) fact type — outer entity/value border + name */}
      {fact.objectified && (() => {
        const isSubtypeCandidate = (isSubtypeTool || isTargetTool) && !isDraftFrom
        const canHaveVr = fact.objectifiedKind === 'value'
          || (fact.objectifiedKind !== 'value' && fact.objectifiedRefMode && fact.objectifiedRefMode !== 'none')
        const isNestedVrCandidate = isRoleValueTool && canHaveVr
        const isNestedCrCandidate = isCrTool
        const isAssignCandidate   = isAssignTool && isAssigning && store.linkDraft?.factId !== fact.id
        const nestedCol  = isDraftFrom        ? 'var(--col-subtype)'
          : isSubtypeCandidate                ? 'var(--col-candidate)'
          : isAssignCandidate                 ? 'var(--col-candidate)'
          : isNestedVrCandidate               ? 'var(--col-candidate)'
          : isNestedCrCandidate               ? 'var(--col-candidate)'
          : fact.objectifiedKind === 'value'  ? 'var(--col-value)'
          :                                     'var(--col-entity)'
        const nestedDash    = fact.objectifiedKind === 'value' ? '6 3' : 'none'
        const nestedFill    = (isSubtypeCandidate || isDraftFrom || isAssignCandidate || isNestedVrCandidate || isNestedCrCandidate) ? 'var(--fill-candidate)' : '#ffffff'
        const nestedStrokeW = (isDraftFrom || isSubtypeCandidate || isAssignCandidate || isNestedVrCandidate || isNestedCrCandidate) ? 2 : 1.5
        const nestedRefText = (fact.objectifiedKind !== 'value' && store.showReferenceMode
          && fact.objectifiedRefMode && fact.objectifiedRefMode !== 'none')
          ? `(${fact.objectifiedRefMode})` : null
        const PAD = 10
        const hasAnyBar = fact.uniqueness.length > 0
        const barSpace  = hasAnyBar
          ? BAR_MARGIN + BAR_SPACING * (multiCount + 1) + BAR_H / 2 + 5
          : 0
        const barPad = Math.max(PAD, Math.ceil(barSpace))

        const readingText  = fact.nestedReading ? getDisplayReading(fact) : ''
        const readingTextW = readingText ? measureNestedReadingText(readingText) : 0
        const readingExtra = fact.nestedReading
          ? NESTED_READING_GAP + NESTED_READING_LINE_H + NESTED_READING_PAD_BELOW
          : 0

        if (isVertical) {
          const padLeft   = barsBelow ? barPad : PAD
          const padRight  = barsBelow ? PAD    : barPad
          const READING_TIGHT_GAP = 4
          const padBottom = fact.nestedReading
            ? Math.max(PAD, READING_TIGHT_GAP + NESTED_READING_LINE_H + NESTED_READING_PAD_BELOW)
            : PAD
          const ow = ROLE_H + padLeft + padRight
          const oh = totalH_v + PAD + padBottom
          const boxTop = fact.y - totalH_v / 2 - PAD
          const nameY  = nestedRefText ? boxTop - 22 : boxTop - 10
          const readingY = fact.y + totalH_v / 2 + READING_TIGHT_GAP + NESTED_READING_LINE_H / 2
          const nameOff  = nameLive ?? (fact.nameOffset ?? { dx: 0, dy: 0 })
          const nameTx   = fact.x + nameOff.dx
          const nameTy   = nameY  + nameOff.dy
          return (
            <>
              <rect
                x={fact.x - ROLE_H / 2 - padLeft} y={boxTop}
                width={ow} height={oh} rx={6}
                fill={nestedFill} stroke={nestedCol} strokeWidth={nestedStrokeW}
                strokeDasharray={nestedDash}
                filter={isShared ? 'url(#sharedGlow)' : undefined}/>
              {(fact.objectifiedName || isSelected) && (
                editingName ? (
                  <foreignObject
                    x={nameTx - Math.max(ow, 120) / 2} y={nameTy - 13}
                    width={Math.max(ow, 120)} height={26}
                    style={{ overflow: 'visible' }}>
                    <input ref={nameInputRef}
                      value={nameDraft}
                      onChange={e => setNameDraft(e.target.value)}
                      onKeyDown={e => {
                        if (e.key === 'Enter')  { e.preventDefault(); commitNameEdit() }
                        if (e.key === 'Escape') { e.preventDefault(); setEditingName(false) }
                      }}
                      onBlur={commitNameEdit}
                      style={{
                        width: '100%', textAlign: 'center', border: 'none',
                        borderBottom: '1.5px solid var(--col-entity)',
                        background: 'transparent', outline: 'none',
                        fontSize: 18, fontFamily: FONT, color: 'var(--col-entity)',
                        cursor: 'text',
                      }}/>
                  </foreignObject>
                ) : (
                  <text x={nameTx} y={nameTy}
                    textAnchor="middle" dominantBaseline="middle"
                    fontSize={18} fontFamily={FONT}
                    fill={nestedCol}
                    style={{ cursor: nameLive ? 'grabbing' : 'grab', userSelect: 'none' }}
                    onMouseDown={e => {
                      e.stopPropagation()
                      nameDragRef.current = { startX: e.clientX, startY: e.clientY,
                        origDx: nameOff.dx, origDy: nameOff.dy }
                      setNameLive({ dx: nameOff.dx, dy: nameOff.dy })
                    }}
                    onDoubleClick={e => {
                      e.stopPropagation()
                      setNameDraft(fact.objectifiedName || '')
                      setEditingName(true)
                    }}>
                    {`\u201c${fact.objectifiedName}\u201d`}
                  </text>
                )
              )}
              {nestedRefText && (
                editingRefMode ? (
                  <foreignObject x={nameTx - 60} y={nameTy + 14 - 9} width={120} height={18}>
                    <input ref={refModeInputRef}
                      value={refModeDraft}
                      onChange={e => setRefModeDraft(e.target.value)}
                      onBlur={commitRefModeEdit}
                      onKeyDown={e => {
                        if (e.key === 'Enter')  { e.preventDefault(); commitRefModeEdit() }
                        if (e.key === 'Escape') { e.preventDefault(); setEditingRefMode(false) }
                      }}
                      onMouseDown={e => e.stopPropagation()}
                      style={{
                        width: '100%', height: '100%', textAlign: 'center',
                        border: 'none', borderBottom: `1px solid ${nestedCol}`,
                        background: 'transparent', outline: 'none',
                        fontSize: 11, fontFamily: FONT, color: nestedCol,
                      }}/>
                  </foreignObject>
                ) : (
                  <>
                    <text x={nameTx} y={nameTy + 14}
                      textAnchor="middle" dominantBaseline="middle"
                      fontSize={11} fontFamily={FONT}
                      fill={nestedCol}
                      style={{ pointerEvents: 'none', userSelect: 'none' }}>
                      {nestedRefText}
                    </text>
                    <rect
                      x={nameTx - 60} y={nameTy + 5}
                      width={120} height={18}
                      fill="transparent"
                      style={{ cursor: 'text' }}
                      onDoubleClick={e => {
                        e.stopPropagation()
                        setRefModeDraft(fact.objectifiedRefMode || '')
                        setEditingRefMode(true)
                      }}
                    />
                  </>
                )
              )}
              {readingText && (
                editingReading
                  ? (() => {
                      const W = Math.max(120,
                        readingDraft.reduce((s, seg) => s + Math.max(20, seg.length * 7 + 4), 0)
                        + fact.arity * 24 + 12)
                      return (
                        <foreignObject x={fact.x - W / 2} y={readingY - 12} width={W} height={24}>
                          <div style={{ display:'flex', alignItems:'center', height:'100%', background:'#fff',
                            border:`1px solid ${nestedCol}`, borderRadius:3, padding:'0 4px', boxSizing:'border-box' }}>
                            {readingDraft.map((seg, i) => (
                              <React.Fragment key={i}>
                                <input
                                  autoFocus={i === 0} // eslint-disable-line jsx-a11y/no-autofocus
                                  value={seg}
                                  onChange={e => { const v = e.target.value; setReadingDraft(prev => { const next = [...prev]; next[i] = v; return next }) }}
                                  onBlur={() => { setTimeout(() => { if (!document.activeElement?.closest?.('foreignObject')) commitReadingEdit() }, 0) }}
                                  onKeyDown={e => { e.stopPropagation(); if(e.key==='Enter'){e.preventDefault();commitReadingEdit()} if(e.key==='Escape'){e.stopPropagation();setEditingReading(false)} }}
                                  onMouseDown={e => e.stopPropagation()}
                                  style={{ width:Math.max(12, seg.length*7), minWidth:0, border:'none', outline:'none',
                                    background:'#fef6ec', color:nestedCol, fontSize:NESTED_READING_FONT_SIZE,
                                    fontFamily:FONT, textAlign:'center', padding:'0', boxSizing:'border-box' }}
                                />
                                {i < fact.arity && (
                                  <span style={{ userSelect:'none', pointerEvents:'none', color:'var(--col-constraint)',
                                    fontWeight:700, fontSize:NESTED_READING_FONT_SIZE, fontFamily:FONT, padding:'0 2px', flexShrink:0 }}>...</span>
                                )}
                              </React.Fragment>
                            ))}
                          </div>
                        </foreignObject>
                      )
                    })()
                  : (
                    <text x={fact.x} y={readingY}
                      textAnchor="middle" dominantBaseline="middle"
                      fontSize={NESTED_READING_FONT_SIZE} fontFamily={FONT}
                      fill={nestedCol}
                      style={{ cursor: 'pointer', userSelect: 'none' }}
                      onDoubleClick={e => { e.stopPropagation(); const ex=fact.readingParts||[]; setReadingDraft(Array.from({length:fact.arity+1},(_,i)=>ex[i]??'')); setEditingReading(true) }}>
                      {readingText}
                    </text>
                  )
              )}
            </>
          )
        }

        const READING_TIGHT_GAP = 4
        const readingPad = READING_TIGHT_GAP + NESTED_READING_LINE_H + NESTED_READING_PAD_BELOW
        const readingAboveActive = fact.nestedReading && !!fact.readingAbove
        const barsAbove = hasAnyBar && !barsBelow
        // padTop when reading is above: enough room for reading text + bars if present.
        // Reading centre sits at fact.y - ROLE_H/2 - NESTED_READING_LINE_H (matching the
        // AUTO_DY used for regular fact-type readings), so reading top is 1.5 line-heights
        // above the role-box top.
        const readingAbovePad = Math.ceil(NESTED_READING_LINE_H * 1.5) + NESTED_READING_PAD_BELOW
        const padTop = readingAboveActive
          ? Math.max(barsAbove ? barPad : PAD, readingAbovePad)
          : (barsBelow ? PAD : barPad)
        const baseBottom = barsBelow ? barPad : PAD
        const padBottom = (fact.nestedReading && !readingAboveActive)
          ? Math.max(baseBottom, readingPad)
          : baseBottom
        const ow = Math.max(totalW + PAD * 2, readingTextW + PAD * 2)
        const oh = ROLE_H + padTop + padBottom
        const nameY    = fact.y - ROLE_H / 2 - padTop - (nestedRefText ? 22 : 10)
        const readingY = readingAboveActive
          ? fact.y - ROLE_H / 2 - NESTED_READING_LINE_H
          : fact.y + ROLE_H / 2 + READING_TIGHT_GAP + NESTED_READING_LINE_H / 2
        const nameOff  = nameLive ?? (fact.nameOffset ?? { dx: 0, dy: 0 })
        const nameTx   = fact.x + nameOff.dx
        const nameTy   = nameY  + nameOff.dy
        return (
          <>
            <rect
              x={fact.x - ow / 2} y={fact.y - ROLE_H / 2 - padTop}
              width={ow} height={oh} rx={6}
              fill={nestedFill} stroke={nestedCol} strokeWidth={nestedStrokeW}
              strokeDasharray={nestedDash}
              filter={isShared ? 'url(#sharedGlow)' : undefined}/>
            {(fact.objectifiedName || isSelected) && (
              editingName ? (
                <foreignObject
                  x={nameTx - Math.max(ow, 120) / 2} y={nameTy - 13}
                  width={Math.max(ow, 120)} height={26}
                  style={{ overflow: 'visible' }}>
                  <input ref={nameInputRef}
                    value={nameDraft}
                    onChange={e => setNameDraft(e.target.value)}
                    onKeyDown={e => {
                      if (e.key === 'Enter')  { e.preventDefault(); commitNameEdit() }
                      if (e.key === 'Escape') { e.preventDefault(); setEditingName(false) }
                    }}
                    onBlur={commitNameEdit}
                    style={{
                      width: '100%', textAlign: 'center', border: 'none',
                      borderBottom: `1.5px solid ${nestedCol}`,
                      background: 'transparent', outline: 'none',
                      fontSize: 18, fontFamily: FONT, color: nestedCol,
                      cursor: 'text',
                    }}/>
                </foreignObject>
              ) : (
                <text x={nameTx} y={nameTy}
                  textAnchor="middle" dominantBaseline="middle"
                  fontSize={18} fontFamily={FONT}
                  fill={nestedCol}
                  style={{ cursor: nameLive ? 'grabbing' : 'grab', userSelect: 'none' }}
                  onMouseDown={e => {
                    e.stopPropagation()
                    nameDragRef.current = { startX: e.clientX, startY: e.clientY,
                      origDx: nameOff.dx, origDy: nameOff.dy }
                    setNameLive({ dx: nameOff.dx, dy: nameOff.dy })
                  }}
                  onDoubleClick={e => {
                    e.stopPropagation()
                    setNameDraft(fact.objectifiedName || '')
                    setEditingName(true)
                  }}>
                  {`\u201c${fact.objectifiedName}\u201d`}
                </text>
              )
            )}
            {nestedRefText && (
              editingRefMode ? (
                <foreignObject x={nameTx - 60} y={nameTy + 14 - 9} width={120} height={18}>
                  <input ref={refModeInputRef}
                    value={refModeDraft}
                    onChange={e => setRefModeDraft(e.target.value)}
                    onBlur={commitRefModeEdit}
                    onKeyDown={e => {
                      if (e.key === 'Enter')  { e.preventDefault(); commitRefModeEdit() }
                      if (e.key === 'Escape') { e.preventDefault(); setEditingRefMode(false) }
                    }}
                    onMouseDown={e => e.stopPropagation()}
                    style={{
                      width: '100%', height: '100%', textAlign: 'center',
                      border: 'none', borderBottom: `1px solid ${nestedCol}`,
                      background: 'transparent', outline: 'none',
                      fontSize: 11, fontFamily: FONT, color: nestedCol,
                    }}/>
                </foreignObject>
              ) : (
                <text x={nameTx} y={nameTy + 14}
                  textAnchor="middle" dominantBaseline="middle"
                  fontSize={11} fontFamily={FONT}
                  fill={nestedCol}
                  style={{ cursor: 'text', userSelect: 'none' }}
                  onDoubleClick={e => {
                    e.stopPropagation()
                    setRefModeDraft(fact.objectifiedRefMode || '')
                    setEditingRefMode(true)
                  }}>
                  {nestedRefText}
                </text>
              )
            )}
            {readingText && (
              editingReading
                ? (() => {
                    const W = Math.max(120,
                      readingDraft.reduce((s, seg) => s + Math.max(20, seg.length * 7 + 4), 0)
                      + fact.arity * 24 + 12)
                    return (
                      <foreignObject x={fact.x - W / 2} y={readingY - 12} width={W} height={24}>
                        <div style={{ display:'flex', alignItems:'center', height:'100%', background:'#fff',
                          border:`1px solid ${nestedCol}`, borderRadius:3, padding:'0 4px', boxSizing:'border-box' }}>
                          {readingDraft.map((seg, i) => (
                            <React.Fragment key={i}>
                              <input
                                autoFocus={i === 0} // eslint-disable-line jsx-a11y/no-autofocus
                                value={seg}
                                onChange={e => { const v = e.target.value; setReadingDraft(prev => { const next = [...prev]; next[i] = v; return next }) }}
                                onBlur={() => { setTimeout(() => { if (!document.activeElement?.closest?.('foreignObject')) commitReadingEdit() }, 0) }}
                                onKeyDown={e => { e.stopPropagation(); if(e.key==='Enter'){e.preventDefault();commitReadingEdit()} if(e.key==='Escape'){e.stopPropagation();setEditingReading(false)} }}
                                onMouseDown={e => e.stopPropagation()}
                                style={{ width:Math.max(12, seg.length*7), minWidth:0, border:'none', outline:'none',
                                  background:'#fef6ec', color:nestedCol, fontSize:NESTED_READING_FONT_SIZE,
                                  fontFamily:FONT, textAlign:'center', padding:'0', boxSizing:'border-box' }}
                              />
                              {i < fact.arity && (
                                <span style={{ userSelect:'none', pointerEvents:'none', color:'var(--col-constraint)',
                                  fontWeight:700, fontSize:NESTED_READING_FONT_SIZE, fontFamily:FONT, padding:'0 2px', flexShrink:0 }}>...</span>
                              )}
                            </React.Fragment>
                          ))}
                        </div>
                      </foreignObject>
                    )
                  })()
                : (
                  <text x={fact.x} y={readingY}
                    textAnchor="middle" dominantBaseline="middle"
                    fontSize={NESTED_READING_FONT_SIZE} fontFamily={FONT}
                    fill={nestedCol}
                    style={{ cursor: 'pointer', userSelect: 'none' }}
                    onDoubleClick={e => { e.stopPropagation(); const ex=fact.readingParts||[]; setReadingDraft(Array.from({length:fact.arity+1},(_,i)=>ex[i]??'')); setEditingReading(true) }}>
                    {readingText}
                  </text>
                )
            )}
          </>
        )
      })()}

      {isVertical ? (
        <>
          {/* White background */}
          <rect x={leftX_v} y={startY_v} width={ROLE_H} height={totalH_v}
            fill="#ffffff" stroke="none" style={{ pointerEvents: 'none' }}/>

          {/* Unary cap (north) */}
          {fact.arity === 1 && (
            <path d={`M ${leftX_v} ${startY_v} a ${ROLE_H/2} ${UNARY_CAP_R} 0 0 0 ${ROLE_H} 0`}
              fill="#ffffff" stroke={roleStroke} strokeWidth={roleStrokeW}
              style={{ pointerEvents: 'none' }}/>
          )}

          {/* Role boxes */}
          {fact.roles.map((role, ri) => {
            const ry = startY_v + ri * (ROLE_W + ROLE_GAP)
            return (
              <g key={role.id} filter={isRoleSelected(ri) ? 'url(#selectGlow)' : undefined}>
                <rect x={leftX_v} y={ry} width={ROLE_H} height={ROLE_W}
                  fill={
                    roleFirstDraft && store.linkDraft.roleIndex === ri ? '#e8e0f8'
                    : inConstruction && ucRoles.includes(ri) ? '#dde8f5'
                    : inFrequencyConstruction && fcRoles.includes(ri) ? '#dde8f5'
                    : roleIsCandidate(ri) ? 'var(--fill-candidate)'
                    : isRoleSelected(ri) ? '#dde8f5'
                    : highlightedRoles?.has(ri) ? '#fde3c8'
                    : '#ffffff'
                  }
                  stroke={isRoleSelected(ri) ? 'var(--accent)' : roleIsCandidate(ri) ? 'var(--col-candidate)' : roleStroke}
                  strokeWidth={isRoleSelected(ri) ? 2 : roleIsCandidate(ri) ? 2 : roleStrokeW}
                  onMouseDown={(e)   => handleRoleMouseDown(ri, e)}
                  onDoubleClick={(e) => handleRoleDoubleClick(ri, e)}
                  onContextMenu={(e) => handleRoleContextMenu(ri, e)}
                  style={{ cursor: ((isSubtypeTool || isTargetTool) && fact.objectified) ? 'cell' : isAssignTool || inConstruction || (!!store.sequenceConstruction && !isVcConstruction) || isRoleSelected(ri) ? 'crosshair' : (isRoleValueTool && !vrEligibleRoles.has(ri)) ? 'not-allowed' : (isVcConstruction && !vcEligibleRoles.has(ri)) ? 'not-allowed' : isVcConstruction ? 'crosshair' : 'pointer' }}
                />
                {isAssignTool && !role.objectTypeId && (
                  <text x={fact.x} y={ry + ROLE_W / 2}
                    textAnchor="middle" dominantBaseline="middle"
                    fontSize={9} fill="var(--col-fact)" fontFamily={FONT}
                    fontWeight={700} opacity={0.5} style={{ pointerEvents: 'none' }}>
                    {ri + 1}
                  </text>
                )}
              </g>
            )
          })}

          {/* Uniqueness bars (right side) */}
          {fact.uniqueness.map((uRoles, ui) => {
            const isEditing = inConstruction && store.uniquenessConstruction?.uIndex === ui
            const displayRoles = isEditing ? ucRoles : uRoles
            const isUSelected = (store.selectedUniqueness?.factId === fact.id && store.selectedUniqueness?.uIndex === ui) || isEditing
            const barStroke = isUSelected ? 'var(--accent)' : 'var(--col-mandatory)'
            const isEditingUnary = isEditing && uRoles.length === 1
            const displayLevel = isEditingUnary ? multiCount + 1 : levels[ui]

            if (isEditing && displayRoles.length === 0) {
              const barX = barX_v(displayLevel)
              return (
                <g key={ui} style={{ cursor: 'pointer', filter: isUSelected ? 'drop-shadow(0 0 3px var(--accent))' : undefined }}
                  onMouseDown={e => e.stopPropagation()} onClick={barClickHandler(ui)}
                  onDoubleClick={barDoubleClickHandler(ui)}>
                  <line x1={barX} y1={startY_v + INSET} x2={barX} y2={startY_v + totalH_v - INSET}
                    stroke={barStroke} strokeWidth={BAR_H + 1} strokeLinecap="butt"
                    strokeDasharray="3 3" strokeOpacity={0.6}/>
                </g>
              )
            }

            const { barX: rawBarX, runs } = buildRunsV(displayRoles, displayLevel, ui)
            const minRI = Math.min(...displayRoles), maxRI = Math.max(...displayRoles)
            const hitY1 = startY_v + minRI * (ROLE_W + ROLE_GAP)
            const hitY2 = startY_v + maxRI * (ROLE_W + ROLE_GAP) + ROLE_W
            const isPreferred = prefKey !== null &&
              JSON.stringify([...uRoles].sort((a, b) => a - b)) === prefKey
            const barX = adjustedBarX(displayLevel, isPreferred)
            const sw = isUSelected ? BAR_H + 1 : BAR_H
            return (
              <g key={ui} style={{ cursor: 'pointer', filter: isUSelected ? 'drop-shadow(0 0 3px var(--accent))' : undefined }}
                onMouseDown={e => e.stopPropagation()} onClick={barClickHandler(ui)}
                onDoubleClick={barDoubleClickHandler(ui)}
                onContextMenu={e => { e.preventDefault(); e.stopPropagation(); onBarContextMenu?.(ui, e) }}>
                <line x1={barX} y1={hitY1} x2={barX} y2={hitY2} stroke="transparent" strokeWidth={10}/>
                {isPreferred ? (
                  <>
                    {/* Solid runs: two lines at ±PREF_OFFSET */}
                    {[-PREF_OFFSET, PREF_OFFSET].map(dx =>
                      runs.filter(r => r.solid).map(({ y1, y2, key }) => (
                        <line key={`${key}-${dx}`} x1={barX + dx} y1={y1} x2={barX + dx} y2={y2}
                          stroke={barStroke} strokeWidth={sw} strokeLinecap="butt"/>
                      ))
                    )}
                    {/* Dashed runs: single line at midpoint between the two bars */}
                    {runs.filter(r => !r.solid).map(({ y1, y2, key }) => (
                      <line key={`${key}-mid`} x1={barX} y1={y1} x2={barX} y2={y2}
                        stroke={barStroke} strokeWidth={sw} strokeLinecap="butt"
                        strokeDasharray="3 3" strokeOpacity={0.6}/>
                    ))}
                  </>
                ) : (
                  runs.map(({ y1, y2, solid, key }) => (
                    <line key={`${key}-0`} x1={barX} y1={y1} x2={barX} y2={y2}
                      stroke={barStroke} strokeWidth={sw} strokeLinecap="butt"
                      strokeDasharray={solid ? 'none' : '3 3'}
                      strokeOpacity={solid ? 1 : 0.6}/>
                  ))
                )}
              </g>
            )
          })}

          {/* Construction preview bar (vertical) */}
          {inConstruction && store.uniquenessConstruction?.uIndex == null && (() => {
            const previewLevel = multiCount + 1
            const barX = adjustedBarX(previewLevel, false)
            if (ucRoles.length === 0) {
              return (
                <g style={{ cursor: 'pointer' }} onMouseDown={e => e.stopPropagation()}
                  onClick={() => store.commitUniquenessConstruction()}>
                  <line x1={barX} y1={startY_v + INSET} x2={barX} y2={startY_v + totalH_v - INSET}
                    stroke="var(--accent)" strokeWidth={BAR_H + 1} strokeLinecap="butt"
                    strokeDasharray="3 3" strokeOpacity={0.6}/>
                </g>
              )
            }
            const { runs } = buildRunsV(ucRoles, previewLevel, 'preview')
            return (
              <g style={{ cursor: 'pointer' }} onMouseDown={e => e.stopPropagation()}
                onClick={() => store.commitUniquenessConstruction()}>
                {runs.map(({ y1, y2, solid, key }) => (
                  <line key={key} x1={barX} y1={y1} x2={barX} y2={y2}
                    stroke="var(--accent)" strokeWidth={BAR_H + 1} strokeLinecap="butt"
                    strokeDasharray={solid ? 'none' : '3 3'}
                    strokeOpacity={solid ? 1 : 0.6}/>
                ))}
              </g>
            )
          })()}

        </>
      ) : (
        <>
          {/* White background covering all role boxes and gaps */}
          <rect x={startX} y={topY} width={totalW} height={ROLE_H} fill="#ffffff" stroke="none"
            style={{ pointerEvents: 'none' }}/>

          {/* Unary cap */}
          {fact.arity === 1 && (
            <path
              d={`M ${startX} ${topY + ROLE_H} a ${UNARY_CAP_R} ${ROLE_H/2} 0 0 0 0 ${-ROLE_H}`}
              fill="#ffffff" stroke={roleStroke} strokeWidth={roleStrokeW}
              style={{ pointerEvents: 'none' }}/>
          )}

          {/* Role boxes */}
          {fact.roles.map((role, ri) => {
            const rx = startX + ri * (ROLE_W + ROLE_GAP)
            return (
              <g key={role.id} filter={isRoleSelected(ri) ? 'url(#selectGlow)' : undefined}>
                <rect
                  x={rx} y={topY} width={ROLE_W} height={ROLE_H}
                  fill={
                    roleFirstDraft && store.linkDraft.roleIndex === ri ? '#e8e0f8'
                    : inConstruction && ucRoles.includes(ri) ? '#dde8f5'
                    : inFrequencyConstruction && fcRoles.includes(ri) ? '#dde8f5'
                    : roleIsCandidate(ri) ? 'var(--fill-candidate)'
                    : isRoleSelected(ri) ? '#dde8f5'
                    : highlightedRoles?.has(ri) ? '#fde3c8'
                    : '#ffffff'
                  }
                  stroke={isRoleSelected(ri) ? 'var(--accent)' : roleIsCandidate(ri) ? 'var(--col-candidate)' : roleStroke}
                  strokeWidth={isRoleSelected(ri) ? 2 : roleIsCandidate(ri) ? 2 : roleStrokeW}
                  onMouseDown={(e)   => handleRoleMouseDown(ri, e)}
                  onDoubleClick={(e) => handleRoleDoubleClick(ri, e)}
                  onContextMenu={(e) => handleRoleContextMenu(ri, e)}
                  style={{ cursor: ((isSubtypeTool || isTargetTool) && fact.objectified) ? 'cell' : isAssignTool || inConstruction || (!!store.sequenceConstruction && !isVcConstruction) || isRoleSelected(ri) ? 'crosshair' : (isRoleValueTool && !vrEligibleRoles.has(ri)) ? 'not-allowed' : (isVcConstruction && !vcEligibleRoles.has(ri)) ? 'not-allowed' : isVcConstruction ? 'crosshair' : 'pointer' }}
                />
                {isAssignTool && !role.objectTypeId && (
                  <text x={rx + ROLE_W/2} y={fact.y}
                    textAnchor="middle" dominantBaseline="middle"
                    fontSize={9} fill="var(--col-fact)" fontFamily={FONT}
                    fontWeight={700} opacity={0.5} style={{ pointerEvents: 'none' }}>
                    {ri + 1}
                  </text>
                )}
              </g>
            )
          })}

          {/* Uniqueness bars (above) */}
          {fact.uniqueness.map((uRoles, ui) => {
            const isEditing = inConstruction && store.uniquenessConstruction?.uIndex === ui
            const displayRoles = isEditing ? ucRoles : uRoles
            const isUSelected = (store.selectedUniqueness?.factId === fact.id && store.selectedUniqueness?.uIndex === ui) || isEditing
            const barStroke = isUSelected ? 'var(--accent)' : 'var(--col-mandatory)'
            const isEditingUnary = isEditing && uRoles.length === 1
            const displayLevel = isEditingUnary ? multiCount + 1 : levels[ui]

            if (isEditing && displayRoles.length === 0) {
              const barY = barY_h(displayLevel)
              return (
                <g key={ui} style={{ cursor: 'pointer', filter: isUSelected ? 'drop-shadow(0 0 3px var(--accent))' : undefined }}
                  onMouseDown={e => e.stopPropagation()} onClick={barClickHandler(ui)}
                  onDoubleClick={barDoubleClickHandler(ui)}>
                  <line x1={startX + INSET} y1={barY} x2={startX + totalW - INSET} y2={barY}
                    stroke={barStroke} strokeWidth={BAR_H + 1} strokeLinecap="butt"
                    strokeDasharray="3 3" strokeOpacity={0.6}/>
                </g>
              )
            }

            const { barY: rawBarY, runs } = buildRuns(displayRoles, displayLevel, ui)
            const minRI = Math.min(...displayRoles), maxRI = Math.max(...displayRoles)
            const hitX1 = startX + minRI * (ROLE_W + ROLE_GAP)
            const hitX2 = startX + maxRI * (ROLE_W + ROLE_GAP) + ROLE_W
            const isPreferred = prefKey !== null &&
              JSON.stringify([...uRoles].sort((a, b) => a - b)) === prefKey
            const barY = adjustedBarY(displayLevel, isPreferred)
            const sw = isUSelected ? BAR_H + 1 : BAR_H
            return (
              <g key={ui} style={{ cursor: 'pointer', filter: isUSelected ? 'drop-shadow(0 0 3px var(--accent))' : undefined }}
                onMouseDown={e => e.stopPropagation()} onClick={barClickHandler(ui)}
                onDoubleClick={barDoubleClickHandler(ui)}
                onContextMenu={e => { e.preventDefault(); e.stopPropagation(); onBarContextMenu?.(ui, e) }}>
                <line x1={hitX1} y1={barY} x2={hitX2} y2={barY} stroke="transparent" strokeWidth={10}/>
                {isPreferred ? (
                  <>
                    {/* Solid runs: two lines at ±PREF_OFFSET */}
                    {[-PREF_OFFSET, PREF_OFFSET].map(dy =>
                      runs.filter(r => r.solid).map(({ x1, x2, key }) => (
                        <line key={`${key}-${dy}`} x1={x1} y1={barY + dy} x2={x2} y2={barY + dy}
                          stroke={barStroke} strokeWidth={sw} strokeLinecap="butt"/>
                      ))
                    )}
                    {/* Dashed runs: single line at midpoint between the two bars */}
                    {runs.filter(r => !r.solid).map(({ x1, x2, key }) => (
                      <line key={`${key}-mid`} x1={x1} y1={barY} x2={x2} y2={barY}
                        stroke={barStroke} strokeWidth={sw} strokeLinecap="butt"
                        strokeDasharray="3 3" strokeOpacity={0.6}/>
                    ))}
                  </>
                ) : (
                  runs.map(({ x1, x2, solid, key }) => (
                    <line key={`${key}-0`} x1={x1} y1={barY} x2={x2} y2={barY}
                      stroke={barStroke} strokeWidth={sw} strokeLinecap="butt"
                      strokeDasharray={solid ? 'none' : '3 3'}
                      strokeOpacity={solid ? 1 : 0.6}/>
                  ))
                )}
              </g>
            )
          })}

          {/* Construction preview bar (horizontal) */}
          {inConstruction && store.uniquenessConstruction?.uIndex == null && (() => {
            const previewLevel = multiCount + 1
            const barY = adjustedBarY(previewLevel, false)
            if (ucRoles.length === 0) {
              return (
                <g style={{ cursor: 'pointer' }} onMouseDown={e => e.stopPropagation()}
                  onClick={() => store.commitUniquenessConstruction()}>
                  <line x1={startX + INSET} y1={barY} x2={startX + totalW - INSET} y2={barY}
                    stroke="var(--accent)" strokeWidth={BAR_H + 1} strokeLinecap="butt"
                    strokeDasharray="3 3" strokeOpacity={0.6}/>
                </g>
              )
            }
            const { runs } = buildRuns(ucRoles, previewLevel, 'preview')
            return (
              <g style={{ cursor: 'pointer' }} onMouseDown={e => e.stopPropagation()}
                onClick={() => store.commitUniquenessConstruction()}>
                {runs.map(({ x1, x2, solid, key }) => (
                  <line key={key} x1={x1} y1={barY} x2={x2} y2={barY}
                    stroke="var(--accent)" strokeWidth={BAR_H + 1} strokeLinecap="butt"
                    strokeDasharray={solid ? 'none' : '3 3'}
                    strokeOpacity={solid ? 1 : 0.6}/>
                ))}
              </g>
            )
          })()}

        </>
      )}

      {!(fact.objectified && fact.nestedReading) && renderReading()}
    </g>

    {/* ── Value range annotations ─────────────────────────────────────────────
        Rendered as siblings (outside the fact type's glow group) so they
        keep their own visual identity regardless of fact-type selection.    */}
    {fact.roles.map((role, ri) => {
      const vr = formatValueRange(role.valueRange)
      if (!vr) return null

      const rc = roleCenter(fact, ri)
      const off = vrLive?.roleIndex === ri
        ? { dx: vrLive.dx, dy: vrLive.dy }
        : (fact.valueRangeOffsets?.[ri] ?? role.valueRangeOffset ?? VR_DEFAULT)
      const textX = rc.x + off.dx
      const textY = rc.y + off.dy

      const { x: connX, y: connY } = vrConnPoint(ri, textX, textY)
      const dragging = vrLive?.roleIndex === ri
      const halfW = measureVrText(vr) / 2 + VR_PAD_X
      const halfH = VR_FONT_SIZE / 2 + VR_PAD_Y
      const lineEnd = vrBoxEdge(textX, textY, halfW, halfH, connX, connY)

      const vrDesc = { factId: fact.id, roleIndex: ri }
      const isVrSelected = store.selectedValueRange?.factId === fact.id && store.selectedValueRange?.roleIndex === ri
      const vrFill = isVrSelected ? 'var(--accent)' : 'var(--col-constraint)'
      return (
        <g key={`vr-${role.id}`} style={{ filter: isVrSelected ? 'drop-shadow(0 0 3px var(--accent))' : undefined }}>
          <line x1={connX} y1={connY} x2={lineEnd.x} y2={lineEnd.y}
            stroke={vrFill} strokeWidth={1.5}
            strokeDasharray="5 3" style={{ pointerEvents: 'none' }}/>
          <text x={textX} y={textY}
            textAnchor="middle" dominantBaseline="middle"
            fill={vrFill} fontSize={11} fontFamily={VR_FONT}
            style={{ cursor: dragging ? 'grabbing' : 'grab', userSelect: 'none' }}
            onMouseDown={e => {
              e.stopPropagation()
              vrWasDragged.current = false
              vrDragRef.current = { roleIndex: ri, startX: e.clientX, startY: e.clientY,
                                    origDx: off.dx, origDy: off.dy }
              setVrLive({ roleIndex: ri, dx: off.dx, dy: off.dy })
            }}
            onClick={e => {
              e.stopPropagation()
              if (vrWasDragged.current) { vrWasDragged.current = false; return }
              if (isVrSelected) store.deselectValueRange()
              else store.selectValueRange(vrDesc)
            }}
            onContextMenu={e => {
              e.preventDefault(); e.stopPropagation()
              store.selectValueRange(vrDesc)
              onRoleValueContextMenu?.(ri, e)
            }}>
            {vr}
          </text>
        </g>
      )
    })}

    {/* ── Cardinality range annotations ───────────────────────────────────────
        Rendered as siblings (outside the fact type's glow group) so they
        keep their own visual identity regardless of fact-type selection.    */}
    {fact.roles.map((role, ri) => {
      const cr = formatCardinalityRange(role.cardinalityRange)
      if (!cr) return null

      const rc = roleCenter(fact, ri)
      const off = crLive?.roleIndex === ri
        ? { dx: crLive.dx, dy: crLive.dy }
        : (fact.cardinalityRangeOffsets?.[ri] ?? role.cardinalityRangeOffset ?? CR_DEFAULT)
      const textX = rc.x + off.dx
      const textY = rc.y + off.dy

      const { x: connX, y: connY } = vrConnPoint(ri, textX, textY)
      const dragging = crLive?.roleIndex === ri
      const halfW = measureVrText(cr) / 2 + VR_PAD_X
      const halfH = VR_FONT_SIZE / 2 + VR_PAD_Y
      const lineEnd = vrBoxEdge(textX, textY, halfW, halfH, connX, connY)

      const crDesc = { factId: fact.id, roleIndex: ri }
      const isCrSelected = store.selectedCardinalityRange?.factId === fact.id && store.selectedCardinalityRange?.roleIndex === ri
      const crFill = isCrSelected ? 'var(--accent)' : 'var(--col-constraint)'
      return (
        <g key={`cr-${role.id}`} style={{ filter: isCrSelected ? 'drop-shadow(0 0 3px var(--accent))' : undefined }}>
          <line x1={connX} y1={connY} x2={lineEnd.x} y2={lineEnd.y}
            stroke={crFill} strokeWidth={1.5}
            strokeDasharray="5 3" style={{ pointerEvents: 'none' }}/>
          <text x={textX} y={textY}
            textAnchor="middle" dominantBaseline="middle"
            fill={crFill} fontSize={11} fontFamily={VR_FONT}
            style={{ cursor: dragging ? 'grabbing' : 'grab', userSelect: 'none' }}
            onMouseDown={e => {
              e.stopPropagation()
              crWasDragged.current = false
              crDragRef.current = { roleIndex: ri, startX: e.clientX, startY: e.clientY,
                                    origDx: off.dx, origDy: off.dy }
              setCrLive({ roleIndex: ri, dx: off.dx, dy: off.dy })
            }}
            onClick={e => {
              e.stopPropagation()
              if (crWasDragged.current) { crWasDragged.current = false; return }
              if (isCrSelected) store.deselectCardinalityRange()
              else store.selectCardinalityRange(crDesc)
            }}
            onContextMenu={e => {
              e.preventDefault(); e.stopPropagation()
              store.selectCardinalityRange(crDesc)
              onRoleCrContextMenu?.(ri, e)
            }}>
            {cr}
          </text>
        </g>
      )
    })}

    {nestedVrAnnotation}
    {nestedCrAnnotation}

    {/* ── Internal frequency circles ───────────────────────────────────────────
        Dashed circles rendered as siblings (outside glow group), each with
        connectors to its associated roles.                                   */}
    {ifItems.map(ifItem => {
      const isEditing = inFrequencyConstruction && store.frequencyConstruction?.ifId === ifItem.id
      const isIfSelected = !isEditing && store.selectedInternalFrequency?.ifId === ifItem.id
      const cx = (ifLive?.ifId === ifItem.id) ? ifLive.x : ifItem.x
      const cy = (ifLive?.ifId === ifItem.id) ? ifLive.y : ifItem.y
      const fr = formatFrequencyRange(ifItem.range)
      const col = isEditing ? 'var(--accent)' : isIfSelected ? 'var(--accent)' : 'var(--col-constraint)'
      const hw = ifShapeHalfW(fr)
      const isDragging = ifLive?.ifId === ifItem.id
      const handlers = {
        onMouseDown: e => {
          e.stopPropagation()
          ifWasDragged.current = false
          ifDragRef.current = { ifId: ifItem.id, startX: e.clientX, startY: e.clientY, origX: cx, origY: cy }
          setIfLive({ ifId: ifItem.id, x: cx, y: cy })
        },
        onClick: e => {
          e.stopPropagation()
          if (ifWasDragged.current) { ifWasDragged.current = false; return }
          if (isEditing) { store.advanceFrequencyToRange(); return }
          if (isIfSelected) store.deselectInternalFrequency()
          else store.selectInternalFrequency(fact.id, ifItem.id)
        },
        onDoubleClick: e => { e.stopPropagation(); store.startFrequencyEdit(fact.id, ifItem.id) },
        onContextMenu: e => { e.preventDefault(); e.stopPropagation(); onIfContextMenu?.(ifItem.id, e) },
      }
      return (
        <g key={`if-${ifItem.id}`} style={{ filter: isIfSelected ? 'drop-shadow(0 0 3px var(--accent))' : undefined }}>
          {(() => {
            const roles = isEditing ? fcRoles : ifItem.roles
            if (roles.length === 2) {
              const mid = ifConsecutiveMidpoint(fact, roles[0], roles[1], cx, cy)
              if (mid) {
                const edge = stadiumEdge(cx, cy, hw, IF_CIRCLE_R, mid.x, mid.y)
                return <line x1={edge.x} y1={edge.y} x2={mid.x} y2={mid.y}
                  stroke={col} strokeWidth={1.2} strokeDasharray="4 2" opacity={0.75}
                  style={{ pointerEvents: 'none' }}/>
              }
            }
            return roles.map(ri => {
              const anchor = computeRoleAnchor(fact, ri, cx, cy)
              const edge   = stadiumEdge(cx, cy, hw, IF_CIRCLE_R, anchor.x, anchor.y)
              return <line key={ri} x1={edge.x} y1={edge.y} x2={anchor.x} y2={anchor.y}
                stroke={col} strokeWidth={1.2} strokeDasharray="4 2" opacity={0.75}
                style={{ pointerEvents: 'none' }}/>
            })
          })()}
          {fr ? (
            // Range defined: show only the text label (no border)
            <text x={cx} y={cy} textAnchor="middle" dominantBaseline="central"
              fontSize={VR_FONT_SIZE} fill={col} fontFamily={VR_FONT}
              style={{ cursor: isDragging ? 'grabbing' : 'grab', userSelect: 'none' }}
              {...handlers}>
              {fr}
            </text>
          ) : (
            // No range yet: dashed circle with 'F'
            <>
              <circle cx={cx} cy={cy} r={IF_CIRCLE_R}
                fill="#ffffff" stroke={col} strokeWidth={1.5} strokeDasharray="3 2"
                style={{ cursor: isDragging ? 'grabbing' : 'grab' }}
                {...handlers}/>
              <text x={cx} y={cy} textAnchor="middle" dominantBaseline="central"
                fontSize={9} fill={col} fontFamily="var(--font-mono)" fontWeight={600}
                style={{ pointerEvents: 'none', userSelect: 'none' }}>
                F
              </text>
            </>
          )}
        </g>
      )
    })}

    {/* ── Internal frequency construction circle (stage 2, new constraints only) */}
    {inFrequencyConstruction && store.frequencyConstruction?.stage === 2 && !store.frequencyConstruction?.ifId && (() => {
      const fc = store.frequencyConstruction
      const cx = ifConstrLive?.x ?? fc.x
      const cy = ifConstrLive?.y ?? fc.y
      return (
        <g>
          {(() => {
            const roles = fc.roleIndices
            if (roles.length === 2) {
              const mid = ifConsecutiveMidpoint(fact, roles[0], roles[1], cx, cy)
              if (mid) {
                const edge = stadiumEdge(cx, cy, IF_CIRCLE_R, IF_CIRCLE_R, mid.x, mid.y)
                return <line x1={edge.x} y1={edge.y} x2={mid.x} y2={mid.y}
                  stroke="var(--accent)" strokeWidth={1.2} strokeDasharray="4 2" opacity={0.75}
                  style={{ pointerEvents: 'none' }}/>
              }
            }
            return roles.map(ri => {
              const anchor = computeRoleAnchor(fact, ri, cx, cy)
              const edge   = stadiumEdge(cx, cy, IF_CIRCLE_R, IF_CIRCLE_R, anchor.x, anchor.y)
              return <line key={ri} x1={edge.x} y1={edge.y} x2={anchor.x} y2={anchor.y}
                stroke="var(--accent)" strokeWidth={1.2} strokeDasharray="4 2" opacity={0.75}
                style={{ pointerEvents: 'none' }}/>
            })
          })()}
          <circle cx={cx} cy={cy} r={IF_CIRCLE_R}
            fill="#ffffff" stroke="var(--accent)" strokeWidth={1.5} strokeDasharray="3 2"
            style={{ cursor: ifConstrLive ? 'grabbing' : 'grab' }}
            onMouseDown={e => {
              e.stopPropagation()
              ifConstrWasDragged.current = false
              ifConstrDragRef.current = { startX: e.clientX, startY: e.clientY, origX: cx, origY: cy }
              setIfConstrLive({ x: cx, y: cy })
            }}
            onClick={e => {
              e.stopPropagation()
              if (ifConstrWasDragged.current) { ifConstrWasDragged.current = false; return }
              store.advanceFrequencyToRange()
            }}
          />
          <text x={cx} y={cy} textAnchor="middle" dominantBaseline="central"
            fontSize={9} fill="var(--accent)" fontFamily="var(--font-mono)" fontWeight={600}
            style={{ pointerEvents: 'none', userSelect: 'none' }}>
            F
          </text>
        </g>
      )
    })()}
  </>
  )
}
