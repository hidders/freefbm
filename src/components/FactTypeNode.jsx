import React, { useCallback, useEffect, useRef, useState } from 'react'
import { useOrmStore } from '../store/ormStore'
import { formatValueRange } from './ObjectTypeNode'

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
    if (!t(0) && t(1)) return t(1)
    const tokens = []
    if (t(0)) tokens.push(t(0))
    tokens.push('...')
    if (t(1)) tokens.push(t(1))
    return tokens.join(' ')
  }

  if (n === 2) {
    // Omit dots only when solely the middle segment is non-empty
    if (!t(0) && t(1) && !t(2)) return t(1)
  }

  // Interleave text parts with '...' role-position dots
  const tokens = []
  for (let i = 0; i <= n; i++) {
    if (t(i)) tokens.push(t(i))
    if (i < n) tokens.push('...')
  }
  // For binary only: trim leading/trailing dots for cleanliness when the
  // outer parts are empty. For n > 2 every dot marks a distinct role and
  // must be kept so the reading remains unambiguous.
  if (n === 2) {
    while (tokens.length && tokens[0] === '...') tokens.shift()
    while (tokens.length && tokens[tokens.length - 1] === '...') tokens.pop()
  }
  return tokens.join(' ')
}

export function getDisplayReading(fact) {
  return buildDisplayReading(fact.readingParts, fact.arity)
}
const BAR_H       = 3    // stroke width of each uniqueness bar
const BAR_MARGIN  = 4    // gap between top of role box and lowest bar
const BAR_SPACING = 5    // vertical distance between successive bar levels
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

export default function FactTypeNode({ fact, onDragStart, onContextMenu, onRoleContextMenu, isShared }) {
  const store = useOrmStore()
  const isSelected     = store.selectedId === fact.id || store.multiSelectedIds.includes(fact.id)
  const hasSelectedRole = store.selectedRole?.factId === fact.id
  // Visual selection: suppress fact-level highlight when a role is selected
  const isFactSelected  = isSelected && !hasSelectedRole
  const isAssignTool      = store.tool === 'assignRole'
  const isSubtypeTool     = store.tool === 'addSubtype'
  const isTargetTool      = store.tool === 'addTargetConnector' && store.linkDraft?.type === 'targetConnector'
  const isUniquenessTool  = store.tool === 'addInternalUniqueness'
  const isConnectorTool = isAssignTool || isSubtypeTool || store.tool === 'connectConstraint'
  const isDraftFrom       = store.linkDraft?.type === 'subtype' && store.linkDraft.fromId === fact.id
  const isAssigning    = store.linkDraft?.type === 'roleAssign'
  const roleFirstDraft = isAssigning && store.linkDraft.factId === fact.id
  const inConstruction = store.uniquenessConstruction?.factId === fact.id
  const ucRoles        = inConstruction ? store.uniquenessConstruction.roleIndices : []

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
    }

    if (isUniquenessTool) {
      store.setTool('select')
      store.startUniquenessConstruction(fact.id)
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
    if (e.shiftKey) { store.shiftSelect(fact.id); return }
    store.select(fact.id, 'fact')
    onDragStart(fact.id, 'fact', e)
  }, [store, fact.id, onDragStart, isAssignTool, inConstruction])

  const isRoleSelected = (ri) =>
    store.selectedRole?.factId === fact.id && store.selectedRole?.roleIndex === ri

  const handleRoleDoubleClick = useCallback((roleIndex, e) => {
    e.stopPropagation()
    if (store.sequenceConstruction || inConstruction) return
    store.select(fact.id, 'fact')
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
      store.collectSequenceMember({ kind: 'role', factId: fact.id, roleIndex })
      return
    }
    if (inConstruction) {
      store.toggleUniquenessConstructionRole(roleIndex)
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
    if (store.tool === 'toggleMandatory') {
      const role = fact.roles[roleIndex]
      store.updateRole(fact.id, roleIndex, { mandatory: !role.mandatory })
      store.setTool('select')
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

    const thisRoleSelected =
      store.selectedRole?.factId === fact.id && store.selectedRole?.roleIndex === roleIndex

    if (thisRoleSelected) {
      // Role already selected → click starts connector; drag drags the fact type
      const startX = e.clientX, startY = e.clientY
      let done = false
      const cleanup = () => {
        if (done) return; done = true
        window.removeEventListener('mousemove', onMove)
        window.removeEventListener('mouseup',   onUp)
      }
      const onMove = (me) => {
        const dx = me.clientX - startX, dy = me.clientY - startY
        if (dx * dx + dy * dy > 16) { cleanup(); onDragStart(fact.id, 'fact', { clientX: startX, clientY: startY }) }
      }
      const onUp = () => {
        cleanup()
        store.select(fact.id, 'fact')  // deselect role, keep fact selected
      }
      window.addEventListener('mousemove', onMove)
      window.addEventListener('mouseup',   onUp)
      return
    }

    if (isSelected) {
      // Fact selected but role not yet selected → select role; drag drags the fact type
      const startX = e.clientX, startY = e.clientY
      let done = false
      const cleanup = () => {
        if (done) return; done = true
        window.removeEventListener('mousemove', onMove)
        window.removeEventListener('mouseup',   onUp)
      }
      const onMove = (me) => {
        const dx = me.clientX - startX, dy = me.clientY - startY
        if (dx * dx + dy * dy > 16) { cleanup(); onDragStart(fact.id, 'fact', { clientX: startX, clientY: startY }) }
      }
      const onUp = () => { cleanup(); store.selectRole(fact.id, roleIndex) }
      window.addEventListener('mousemove', onMove)
      window.addEventListener('mouseup',   onUp)
      return
    }

    // Fact not selected → select fact and start drag
    store.select(fact.id, 'fact')
    onDragStart(fact.id, 'fact', e)
  }, [store, fact.id, isAssignTool, inConstruction, isSelected, onDragStart])

  // ── Annotation drag (value-range labels + reading text) ───────────────────
  const vrDragRef      = useRef(null)
  const readingDragRef = useRef(null)
  const nameDragRef    = useRef(null)
  const [vrLive,      setVrLive]      = useState(null) // { roleIndex, dx, dy } | null
  const [readingLive, setReadingLive] = useState(null) // { dx, dy } | null
  const [nameLive,    setNameLive]    = useState(null) // { dx, dy } | null
  const [editingName,    setEditingName]    = useState(false)
  const [nameDraft,      setNameDraft]      = useState('')
  const nameInputRef = useRef(null)
  const [editingRefMode, setEditingRefMode] = useState(false)
  const [refModeDraft,   setRefModeDraft]   = useState('')
  const refModeInputRef = useRef(null)

  useEffect(() => {
    const onMove = (e) => {
      const zoom = useOrmStore.getState().zoom
      const d = vrDragRef.current
      if (d) {
        const dx = d.origDx + (e.clientX - d.startX) / zoom
        const dy = d.origDy + (e.clientY - d.startY) / zoom
        setVrLive({ roleIndex: d.roleIndex, dx, dy })
      }
      const rd = readingDragRef.current
      if (rd) {
        const dx = rd.origDx + (e.clientX - rd.startX) / zoom
        const dy = rd.origDy + (e.clientY - rd.startY) / zoom
        setReadingLive({ dx, dy })
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
      const d = vrDragRef.current
      if (d) {
        const dx = d.origDx + (e.clientX - d.startX) / zoom
        const dy = d.origDy + (e.clientY - d.startY) / zoom
        useOrmStore.getState().updateValueRangeOffset(fact.id, d.roleIndex, { dx, dy })
        vrDragRef.current = null
        setVrLive(null)
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

  useEffect(() => {
    if (editingRefMode && refModeInputRef.current) {
      refModeInputRef.current.focus()
      refModeInputRef.current.select()
    }
  }, [editingRefMode])

  // Commit name/refMode edits when the fact is deselected
  useEffect(() => {
    if (!isSelected && editingName) commitNameEdit()
    if (!isSelected && editingRefMode) commitRefModeEdit()
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
  const roleStroke    = isFactSelected               ? 'var(--accent)'
    : isUniquenessTool                               ? 'var(--col-candidate)'
    : isNestedSubtypeCandidate                       ? 'var(--col-candidate)'
    : (isDraftFrom && fact.objectified)              ? 'var(--col-subtype)'
    :                                                  'var(--col-fact)'
  const roleStrokeW   = isFactSelected ? 2 : (isUniquenessTool || isNestedSubtypeCandidate || (isDraftFrom && fact.objectified)) ? 2 : 1.5
  const gc = store.sequenceConstruction
  const isRoleCandidate = (isAssignTool && !isAssigning) || store.tool === 'toggleMandatory' || isUniquenessTool || !!gc
  const roleHighlight = isRoleCandidate ? 'var(--fill-candidate)' : '#ffffff'

  const isVertical = fact.orientation === 'vertical'

  // ── Uniqueness bar level assignment ────────────────────────────────────────
  const hasUnary = fact.uniqueness.some(u => u.length === 1)
  let multiLevel = hasUnary ? 0 : -1
  const levels = fact.uniqueness.map(uRoles =>
    uRoles.length === 1 ? 0 : ++multiLevel
  )
  const multiCount = multiLevel

  const INSET = 2
  const FONT = "'Segoe UI', Helvetica, Arial, sans-serif"
  const barsBelow = !!fact.uniquenessBelow

  // Bar coordinate helpers
  const barY_h = (level) => barsBelow
    ? topY + ROLE_H + BAR_MARGIN + BAR_SPACING * (level + 1) - BAR_H / 2
    : topY - BAR_MARGIN - BAR_SPACING * (level + 1) + BAR_H / 2

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
    store.select(fact.id, 'fact')
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

    if (!text) return null

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

    return (
      <text x={tx} y={ty} textAnchor="middle" dominantBaseline="middle"
        fontSize={14} fill="var(--ink-3)" fontFamily={FONT}
        style={{ cursor: isDraggingReading ? 'grabbing' : 'grab', userSelect: 'none' }}
        onMouseDown={e => {
          e.stopPropagation()
          readingDragRef.current = { startX: e.clientX, startY: e.clientY, origDx: off.dx, origDy: off.dy }
          setReadingLive({ dx: off.dx, dy: off.dy })
        }}>
        {text}
      </text>
    )
  }

  // ── VR annotation helpers ─────────────────────────────────────────────────
  const VR_DEFAULT = isVertical ? { dx: -50, dy: 0 } : VR_DEFAULT_OFFSET

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
       style={{ cursor: ((isSubtypeTool || isTargetTool) && fact.objectified) ? 'cell' : 'grab' }}
       filter={isFactSelected || isDraftFrom ? 'url(#selectGlow)' : undefined}>

      {/* Objectified (nested) fact type — outer entity/value border + name */}
      {fact.objectified && (() => {
        const isSubtypeCandidate = (isSubtypeTool || isTargetTool) && !isDraftFrom
        const nestedCol  = isDraftFrom        ? 'var(--col-subtype)'
          : isSubtypeCandidate                ? 'var(--col-candidate)'
          : fact.objectifiedKind === 'value'  ? 'var(--col-value)'
          :                                     'var(--col-entity)'
        const nestedDash    = fact.objectifiedKind === 'value' ? '6 3' : 'none'
        const nestedFill    = (isSubtypeCandidate || isDraftFrom) ? 'var(--fill-candidate)' : '#ffffff'
        const nestedStrokeW = (isDraftFrom || isSubtypeCandidate) ? 2 : 1.5
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
                    {fact.objectifiedName}
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
                <text x={fact.x} y={readingY}
                  textAnchor="middle" dominantBaseline="middle"
                  fontSize={NESTED_READING_FONT_SIZE} fontFamily={FONT}
                  fill={nestedCol}
                  style={{ pointerEvents: 'none', userSelect: 'none' }}>
                  {readingText}
                </text>
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
                  {fact.objectifiedName}
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
              <text x={fact.x} y={readingY}
                textAnchor="middle" dominantBaseline="middle"
                fontSize={NESTED_READING_FONT_SIZE} fontFamily={FONT}
                fill={nestedCol}
                style={{ pointerEvents: 'none', userSelect: 'none' }}>
                {readingText}
              </text>
            )}
          </>
        )
      })()}

      {isVertical ? (
        <>
          {/* White background */}
          <rect x={leftX_v} y={startY_v} width={ROLE_H} height={totalH_v}
            fill={isNestedSubtypeCandidate ? 'var(--fill-candidate)' : '#ffffff'} stroke="none" style={{ pointerEvents: 'none' }}/>

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
                    : isRoleCandidate ? roleHighlight
                    : isNestedSubtypeCandidate ? 'var(--fill-candidate)'
                    : isRoleSelected(ri) ? '#dde8f5'
                    : highlightedRoles?.has(ri) ? '#fde3c8'
                    : '#ffffff'
                  }
                  stroke={isRoleSelected(ri) ? 'var(--accent)' : isRoleCandidate ? 'var(--col-candidate)' : roleStroke}
                  strokeWidth={isRoleSelected(ri) ? 2 : isRoleCandidate ? 2 : roleStrokeW}
                  onMouseDown={(e)   => handleRoleMouseDown(ri, e)}
                  onDoubleClick={(e) => handleRoleDoubleClick(ri, e)}
                  onContextMenu={(e) => handleRoleContextMenu(ri, e)}
                  style={{ cursor: ((isSubtypeTool || isTargetTool) && fact.objectified) ? 'cell' : isAssignTool || inConstruction || !!store.sequenceConstruction || isRoleSelected(ri) ? 'crosshair' : 'pointer' }}
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
                <g key={ui} style={{ cursor: 'pointer' }}
                  onMouseDown={e => e.stopPropagation()} onClick={barClickHandler(ui)}>
                  <line x1={barX} y1={startY_v + INSET} x2={barX} y2={startY_v + totalH_v - INSET}
                    stroke={barStroke} strokeWidth={BAR_H + 1} strokeLinecap="butt"
                    strokeDasharray="3 3" strokeOpacity={0.6}/>
                </g>
              )
            }

            const { barX, runs } = buildRunsV(displayRoles, displayLevel, ui)
            const minRI = Math.min(...displayRoles), maxRI = Math.max(...displayRoles)
            const hitY1 = startY_v + minRI * (ROLE_W + ROLE_GAP)
            const hitY2 = startY_v + maxRI * (ROLE_W + ROLE_GAP) + ROLE_W
            return (
              <g key={ui} style={{ cursor: 'pointer' }}
                onMouseDown={e => e.stopPropagation()} onClick={barClickHandler(ui)}>
                <line x1={barX} y1={hitY1} x2={barX} y2={hitY2} stroke="transparent" strokeWidth={10}/>
                {runs.map(({ y1, y2, solid, key }) => (
                  <line key={key} x1={barX} y1={y1} x2={barX} y2={y2}
                    stroke={barStroke} strokeWidth={isUSelected ? BAR_H + 1 : BAR_H}
                    strokeLinecap="butt"
                    strokeDasharray={solid ? 'none' : '3 3'}
                    strokeOpacity={solid ? 1 : 0.6}/>
                ))}
              </g>
            )
          })}

          {/* Construction preview bar (vertical) */}
          {inConstruction && store.uniquenessConstruction?.uIndex == null && (() => {
            const previewLevel = multiCount + 1
            const barX = barX_v(previewLevel)
            if (ucRoles.length === 0) {
              return (
                <g style={{ pointerEvents: 'none' }}>
                  <line x1={barX} y1={startY_v + INSET} x2={barX} y2={startY_v + totalH_v - INSET}
                    stroke="var(--accent)" strokeWidth={BAR_H + 1} strokeLinecap="butt"
                    strokeDasharray="3 3" strokeOpacity={0.6}/>
                </g>
              )
            }
            const { runs } = buildRunsV(ucRoles, previewLevel, 'preview')
            return (
              <g style={{ pointerEvents: 'none' }}>
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
                    : isRoleCandidate ? roleHighlight
                    : isNestedSubtypeCandidate ? 'var(--fill-candidate)'
                    : isRoleSelected(ri) ? '#dde8f5'
                    : highlightedRoles?.has(ri) ? '#fde3c8'
                    : '#ffffff'
                  }
                  stroke={isRoleSelected(ri) ? 'var(--accent)' : isRoleCandidate ? 'var(--col-candidate)' : roleStroke}
                  strokeWidth={isRoleSelected(ri) ? 2 : isRoleCandidate ? 2 : roleStrokeW}
                  onMouseDown={(e)   => handleRoleMouseDown(ri, e)}
                  onDoubleClick={(e) => handleRoleDoubleClick(ri, e)}
                  onContextMenu={(e) => handleRoleContextMenu(ri, e)}
                  style={{ cursor: ((isSubtypeTool || isTargetTool) && fact.objectified) ? 'cell' : isAssignTool || inConstruction || !!store.sequenceConstruction || isRoleSelected(ri) ? 'crosshair' : 'pointer' }}
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
                <g key={ui} style={{ cursor: 'pointer' }}
                  onMouseDown={e => e.stopPropagation()} onClick={barClickHandler(ui)}>
                  <line x1={startX + INSET} y1={barY} x2={startX + totalW - INSET} y2={barY}
                    stroke={barStroke} strokeWidth={BAR_H + 1} strokeLinecap="butt"
                    strokeDasharray="3 3" strokeOpacity={0.6}/>
                </g>
              )
            }

            const { barY, runs } = buildRuns(displayRoles, displayLevel, ui)
            const minRI = Math.min(...displayRoles), maxRI = Math.max(...displayRoles)
            const hitX1 = startX + minRI * (ROLE_W + ROLE_GAP)
            const hitX2 = startX + maxRI * (ROLE_W + ROLE_GAP) + ROLE_W
            return (
              <g key={ui} style={{ cursor: 'pointer' }}
                onMouseDown={e => e.stopPropagation()} onClick={barClickHandler(ui)}>
                <line x1={hitX1} y1={barY} x2={hitX2} y2={barY} stroke="transparent" strokeWidth={10}/>
                {runs.map(({ x1, x2, solid, key }) => (
                  <line key={key} x1={x1} y1={barY} x2={x2} y2={barY}
                    stroke={barStroke}
                    strokeWidth={isUSelected ? BAR_H + 1 : BAR_H}
                    strokeLinecap="butt"
                    strokeDasharray={solid ? 'none' : '3 3'}
                    strokeOpacity={solid ? 1 : 0.6}/>
                ))}
              </g>
            )
          })}

          {/* Construction preview bar (horizontal) */}
          {inConstruction && store.uniquenessConstruction?.uIndex == null && (() => {
            const previewLevel = multiCount + 1
            const barY = barY_h(previewLevel)
            if (ucRoles.length === 0) {
              return (
                <g style={{ pointerEvents: 'none' }}>
                  <line x1={startX + INSET} y1={barY} x2={startX + totalW - INSET} y2={barY}
                    stroke="var(--accent)" strokeWidth={BAR_H + 1} strokeLinecap="butt"
                    strokeDasharray="3 3" strokeOpacity={0.6}/>
                </g>
              )
            }
            const { runs } = buildRuns(ucRoles, previewLevel, 'preview')
            return (
              <g style={{ pointerEvents: 'none' }}>
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

      return (
        <g key={`vr-${role.id}`}>
          <line x1={connX} y1={connY} x2={lineEnd.x} y2={lineEnd.y}
            stroke="var(--col-constraint)" strokeWidth={1.5}
            strokeDasharray="5 3" style={{ pointerEvents: 'none' }}/>
          <text x={textX} y={textY}
            textAnchor="middle" dominantBaseline="middle"
            fill="var(--col-constraint)" fontSize={11} fontFamily={VR_FONT}
            style={{ cursor: dragging ? 'grabbing' : 'grab', userSelect: 'none' }}
            onMouseDown={e => {
              e.stopPropagation()
              vrDragRef.current = { roleIndex: ri, startX: e.clientX, startY: e.clientY,
                                    origDx: off.dx, origDy: off.dy }
              setVrLive({ roleIndex: ri, dx: off.dx, dy: off.dy })
            }}>
            {vr}
          </text>
        </g>
      )
    })}
  </>
  )
}
