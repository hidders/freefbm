import React, { useState, useRef, useEffect } from 'react'
import { useOrmStore } from '../store/ormStore'

export default function DiagramTabs() {
  const store = useOrmStore()
  const diagrams        = store.diagrams ?? []
  const activeDiagramId = store.activeDiagramId

  const [editingId, setEditingId] = useState(null)
  const [draft,     setDraft]     = useState('')
  const inputRef     = useRef(null)
  const containerRef = useRef(null)

  // dragRef: { fromIndex, startX, startY, dragging, currentDrop, tabWidth }
  const dragRef = useRef(null)
  const [dragIndex,   setDragIndex]   = useState(null)
  const [dropIndex,   setDropIndex]   = useState(null)
  const [dragOffsetX, setDragOffsetX] = useState(0)
  const [dragWidth,   setDragWidth]   = useState(0)

  const isDragging = dragIndex !== null

  useEffect(() => {
    if (editingId && inputRef.current) {
      inputRef.current.focus()
      inputRef.current.select()
    }
  }, [editingId])

  const commitRename = () => {
    if (editingId && draft.trim()) store.renameDiagram(editingId, draft.trim())
    setEditingId(null)
  }

  const startRename = (d) => {
    setDraft(d.name)
    setEditingId(d.id)
  }

  const handleDelete = (e, id) => {
    e.stopPropagation()
    if (diagrams.length <= 1) return
    store.deleteDiagram(id)
  }

  const handleTabMouseDown = (e, tabIndex) => {
    if (e.button !== 0) return
    if (editingId === diagrams[tabIndex]?.id) return
    e.preventDefault()

    dragRef.current = { fromIndex: tabIndex, startX: e.clientX, startY: e.clientY,
                        dragging: false, currentDrop: tabIndex, tabWidth: 0 }

    const computeDrop = (clientX) => {
      if (!containerRef.current) return tabIndex
      const tabs = containerRef.current.querySelectorAll('[data-tab-idx]')
      for (const tab of tabs) {
        const idx = parseInt(tab.dataset.tabIdx)
        if (idx === dragRef.current?.fromIndex) continue  // skip dragged tab
        const rect = tab.getBoundingClientRect()
        if (clientX < rect.left + rect.width / 2) return idx
      }
      return diagrams.length
    }

    const onMove = (me) => {
      const dr = dragRef.current
      if (!dr) return
      if (!dr.dragging) {
        if (Math.hypot(me.clientX - dr.startX, me.clientY - dr.startY) < 5) return
        // Measure the tab width once at drag start
        const tabEl = containerRef.current?.querySelector(`[data-tab-idx="${tabIndex}"]`)
        dr.tabWidth = tabEl ? tabEl.getBoundingClientRect().width + 2 : 80  // +2 for gap
        dr.dragging = true
        setDragIndex(tabIndex)
        setDragWidth(dr.tabWidth)
        setDropIndex(tabIndex)
        setDragOffsetX(0)
      }
      const offsetX = me.clientX - dr.startX
      setDragOffsetX(offsetX)
      const drop = computeDrop(me.clientX)
      dr.currentDrop = drop
      setDropIndex(drop)
    }

    const onUp = () => {
      const dr = dragRef.current
      dragRef.current = null
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup',   onUp)
      if (!dr) return
      if (dr.dragging) {
        const from = dr.fromIndex, to = dr.currentDrop
        if (to !== from && to !== from + 1) store.reorderDiagram(from, to)
        setDragIndex(null)
        setDropIndex(null)
        setDragOffsetX(0)
        setDragWidth(0)
      }
    }

    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup',   onUp)
  }

  // Compute per-tab horizontal shift during drag
  const tabShift = (i) => {
    if (!isDragging || i === dragIndex) return 0
    if (i < dragIndex && dropIndex <= i) return  dragWidth
    if (i > dragIndex && dropIndex >  i) return -dragWidth
    return 0
  }

  if (!diagrams.length) return null

  return (
    <div
      id="diagram-tabs"
      ref={containerRef}
      style={{
        display: 'flex',
        alignItems: 'flex-end',
        background: 'var(--bg-raised)',
        borderBottom: '1px solid var(--border)',
        paddingLeft: 8,
        paddingTop: 5,
        gap: 2,
        flexShrink: 0,
        overflowX: 'auto',
      }}
    >
      {diagrams.map((d, i) => {
        const isActive  = d.id === activeDiagramId
        const isEditing = editingId === d.id
        const isBeingDragged = isDragging && dragIndex === i
        const shift = tabShift(i)

        return (
          <div
            key={d.id}
            data-tab-idx={i}
            onClick={() => { if (!isEditing && !isDragging) store.setActiveDiagram(d.id) }}
            onDoubleClick={() => { if (!isDragging) startRename(d) }}
            onMouseDown={(e) => handleTabMouseDown(e, i)}
            style={{
              display: 'flex', alignItems: 'center', gap: 4,
              padding: '0 10px',
              height: isActive ? 28 : 25,
              marginBottom: isActive ? -1 : 0,
              border: '1px solid var(--border)',
              borderBottom: isActive ? '1px solid var(--bg-canvas)' : '1px solid var(--border)',
              borderRadius: '5px 5px 0 0',
              background: isActive ? 'var(--bg-canvas)' : 'var(--bg-surface)',
              cursor: isBeingDragged ? 'grabbing' : isDragging ? 'default' : 'pointer',
              color: isActive ? 'var(--ink-1)' : 'var(--ink-muted)',
              fontSize: 12,
              fontFamily: "'Segoe UI', Helvetica, Arial, sans-serif",
              whiteSpace: 'nowrap',
              userSelect: 'none',
              minWidth: 60,
              boxSizing: 'border-box',
              flexShrink: 0,
              fontWeight: isActive ? 500 : 400,
              position: 'relative',
              zIndex: isBeingDragged ? 10 : 1,
              opacity: isBeingDragged ? 0.85 : 1,
              transform: isBeingDragged
                ? `translateX(${dragOffsetX}px)`
                : shift ? `translateX(${shift}px)` : 'none',
              transition: isBeingDragged ? 'none' : 'transform 0.15s ease',
              boxShadow: isBeingDragged ? 'var(--shadow-md)' : 'none',
            }}
          >
            {isEditing ? (
              <input
                ref={inputRef}
                value={draft}
                onChange={e => setDraft(e.target.value)}
                onBlur={commitRename}
                onKeyDown={e => {
                  e.stopPropagation()
                  if (e.key === 'Enter') { e.preventDefault(); commitRename() }
                  if (e.key === 'Escape') { e.stopPropagation(); setEditingId(null) }
                }}
                onMouseDown={e => e.stopPropagation()}
                style={{
                  border: 'none', outline: 'none',
                  background: 'transparent',
                  color: 'var(--ink-1)',
                  fontSize: 12,
                  fontFamily: "'Segoe UI', Helvetica, Arial, sans-serif",
                  width: Math.max(60, draft.length * 8),
                }}
              />
            ) : (
              <span>{d.name}</span>
            )}

            {diagrams.length > 1 && (
              <span
                title="Remove diagram"
                onClick={e => handleDelete(e, d.id)}
                style={{
                  marginLeft: 2, fontSize: 10, lineHeight: 1,
                  color: 'var(--ink-muted)',
                  opacity: isActive ? 0.6 : 0.35,
                  cursor: 'pointer',
                  padding: '1px 2px',
                  borderRadius: 2,
                }}
                onMouseEnter={e => { e.currentTarget.style.color = 'var(--ink-1)'; e.currentTarget.style.opacity = '1' }}
                onMouseLeave={e => { e.currentTarget.style.color = 'var(--ink-muted)'; e.currentTarget.style.opacity = isActive ? '0.6' : '0.35' }}
              >
                ✕
              </span>
            )}
          </div>
        )
      })}

      {/* Add new diagram */}
      <div
        onClick={() => store.addDiagram(`Diagram ${diagrams.length + 1}`)}
        title="Add diagram"
        style={{
          display: 'flex', alignItems: 'center',
          padding: '0 10px',
          height: 25,
          cursor: 'pointer',
          color: 'var(--ink-muted)',
          fontSize: 16, lineHeight: 1,
          userSelect: 'none',
          borderRadius: '5px 5px 0 0',
        }}
        onMouseEnter={e => { e.currentTarget.style.color = 'var(--ink-1)' }}
        onMouseLeave={e => { e.currentTarget.style.color = 'var(--ink-muted)' }}
      >
        +
      </div>
    </div>
  )
}

