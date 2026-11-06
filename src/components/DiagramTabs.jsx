import React, { useState, useRef, useEffect } from 'react'
import { useOrmStore, useOrmStoreIgnoring } from '../store/ormStore'
import { activeSchemaIdOf, mappingOfDiagram, isViewMapping } from '../store/storeHelpers'
import { NewSchemaMenu } from './SchemaStrip'
import { isErdDiagram } from './ErdView'
import { layoutOrmDiagram } from '../layout/ormLayout'

export default function DiagramTabs() {
  const store = useOrmStoreIgnoring('pan', 'zoom')
  // Only the active schema's diagrams are shown; indices below are into this
  // list and are mapped back to store.diagrams for reordering.
  const allDiagrams     = store.diagrams ?? []
  // A mapping diagram's tabs are its mapping's diagrams instead.
  const activeSchemaId  = activeSchemaIdOf(store)
  const activeDiagramId = store.activeDiagramId
  const activeDiagram   = allDiagrams.find(d => d.id === activeDiagramId)
  const mapping         = mappingOfDiagram(store, activeDiagram)
  const isView          = isViewMapping(store, mapping)
  const diagrams        = mapping
    ? allDiagrams.filter(d => d.mappingId === mapping.id)
    : allDiagrams.filter(d => (!activeSchemaId || d.schemaId === activeSchemaId) && !d.mappingId)
  const singleSchema    = (store.schemas?.length ?? 1) <= 1 && !(store.mappings?.length) && !(store.views?.length)
  const isRelational    = !mapping && store.schemas?.find(x => x.id === activeDiagram?.schemaId)?.profile === 'relational'
  const schemaName      = (id) => store.schemas?.find(x => x.id === id)?.name ?? '?'

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

  useEffect(() => {
    if (!editingId) return
    const onDown = (e) => {
      if (!inputRef.current?.contains(e.target)) commitRename()
    }
    window.addEventListener('mousedown', onDown, true)
    return () => window.removeEventListener('mousedown', onDown, true)
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
    if (diagrams.length <= 1 && !mapping) return
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
        if (to !== from && to !== from + 1) {
          const gFrom = allDiagrams.indexOf(diagrams[from])
          const gTo = to < diagrams.length ? allDiagrams.indexOf(diagrams[to]) : allDiagrams.indexOf(diagrams[diagrams.length - 1]) + 1
          store.reorderDiagram(gFrom, gTo)
        }
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
              paddingLeft: 10,
              paddingRight: (diagrams.length > 1 || mapping) ? 28 : 10,
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

            {(diagrams.length > 1 || mapping) && (
              <span
                title={mapping && diagrams.length === 1 ? 'Remove this mapping diagram (the mapping and its rules stay)' : 'Remove diagram'}
                onClick={e => handleDelete(e, d.id)}
                style={{
                  position: 'absolute', right: 6,
                  top: '50%', transform: 'translateY(-50%)',
                  width: 15, height: 15,
                  borderRadius: '50%',
                  border: '1.5px solid #e0b0a8',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  color: 'var(--danger)',
                  fontSize: 9, fontWeight: 700, lineHeight: 1,
                  cursor: 'pointer', userSelect: 'none', flexShrink: 0,
                  boxSizing: 'border-box',
                }}
                onMouseEnter={e => {
                  e.currentTarget.style.background = 'var(--danger)'
                  e.currentTarget.style.borderColor = 'var(--danger)'
                  e.currentTarget.style.color = '#fff'
                }}
                onMouseLeave={e => {
                  e.currentTarget.style.background = 'transparent'
                  e.currentTarget.style.borderColor = '#e0b0a8'
                  e.currentTarget.style.color = 'var(--danger)'
                }}
              >
                ✕
              </span>
            )}
          </div>
        )
      })}

      {/* Add new diagram */}
      <div
        onClick={() => {
          const used = new Set(
            diagrams.map(d => d.name.match(/^Diagram (\d+)$/)?.[1]).filter(Boolean).map(Number)
          )
          let n = 1
          while (used.has(n)) n++
          store.addDiagram(`Diagram ${n}`)
        }}
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

      <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8, alignSelf: 'center' }}>
        {/* A mapping diagram names its mapping and can fetch its rules' elements. */}
        {mapping && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11, color: 'var(--ink-3)', whiteSpace: 'nowrap', marginRight: 8 }}>
            <span title="This diagram draws a mapping: elements of both schemas, and each rule as a node linked to the elements its patterns name">
              {isView ? 'View' : 'Mapping'} <b style={{ color: 'var(--ink-1)', fontWeight: 600 }}>{mapping.name}</b>:{' '}
              <span style={{ color: 'var(--map-source)', fontWeight: 600 }}>{schemaName(mapping.sourceSchemaId)}</span>
              {isView ? ' ⇒ ' : ' ⟺ '}
              <span style={{ color: 'var(--map-target)', fontWeight: 600 }}>{schemaName(mapping.targetSchemaId)}</span>
            </span>
            <span title="Add the elements the rules name that this diagram doesn't show yet"
              className="mapping-add-elements"
              onClick={() => useOrmStore.getState().addMappingRuleElements(activeDiagram.id)}
              style={{ cursor: 'pointer', textDecoration: 'underline', textDecorationColor: 'var(--border)' }}
              onMouseEnter={e => { e.currentTarget.style.color = 'var(--ink-1)' }}
              onMouseLeave={e => { e.currentTarget.style.color = 'var(--ink-3)' }}
            >Add rule elements</span>
          </div>
        )}
        {/* A relational schema shows tables (an ERD), or in Advanced mode its logical (ORM2) view. */}
        {activeDiagram && isRelational && isErdDiagram(store, activeDiagram) && (
          <div title="Lay the tables out afresh (forgets the positions of moved tables)"
            onClick={() => useOrmStore.getState().resetErdPositions(activeDiagram.id)}
            style={{ fontSize: 11, color: 'var(--ink-3)', cursor: 'pointer', userSelect: 'none', padding: '0 4px', whiteSpace: 'nowrap' }}
            onMouseEnter={e => { e.currentTarget.style.color = 'var(--ink-1)' }}
            onMouseLeave={e => { e.currentTarget.style.color = 'var(--ink-3)' }}
          >Auto layout</div>
        )}
        {activeDiagram && isRelational && isErdDiagram(store, activeDiagram) && <ErdLinesSwitch diagram={activeDiagram} />}
        {/* An ORM2 diagram (not a mapping diagram): lay out everything afresh. */}
        {activeDiagram && !mapping && !isErdDiagram(store, activeDiagram) && (activeDiagram.occurrences?.length ?? 0) > 0 && (
          <div title="Lay the whole diagram out afresh: moves every element, collapses reference modes, and draws each attribute's value type next to its entity type"
            className="orm-auto-layout"
            onClick={() => {
              const s = useOrmStore.getState()
              const result = layoutOrmDiagram(s, activeDiagram.id)
              if (result) s.applyDiagramLayout(activeDiagram.id, result)
            }}
            style={{ fontSize: 11, color: 'var(--ink-3)', cursor: 'pointer', userSelect: 'none', padding: '0 4px', whiteSpace: 'nowrap' }}
            onMouseEnter={e => { e.currentTarget.style.color = 'var(--ink-1)' }}
            onMouseLeave={e => { e.currentTarget.style.color = 'var(--ink-3)' }}
          >Auto layout</div>
        )}
        {activeDiagram && isRelational && store.advancedMode && <FaceSwitch schemaId={activeDiagram.schemaId} logical={!!store.logicalViews?.[activeDiagram.schemaId]} />}
        {/* With one schema the schema strip is hidden; a new schema starts here. */}
        {singleSchema && <NewSchemaMenu variant="tab" />}
      </div>
    </div>
  )
}


// Diagonal | Right-angled switch for the foreign key lines of an ERD.
function ErdLinesSwitch({ diagram }) {
  const current = diagram.erdLines === 'orthogonal' ? 'orthogonal' : 'direct'
  const opts = [
    ['direct', 'Diagonal', 'Draw foreign keys as straight lines that bend at table corners, from the row of their column'],
    ['orthogonal', 'Right-angled', 'Draw foreign keys as lines of horizontal and vertical stretches'],
  ]
  return (
    <div style={{ display: 'flex', border: '1px solid var(--border)', borderRadius: 11, overflow: 'hidden', height: 20, marginRight: 8, flexShrink: 0 }}>
      {opts.map(([id, label, title]) => (
        <div key={id} title={title}
          onClick={() => { if (id !== current) useOrmStore.getState().setErdLines(diagram.id, id) }}
          style={{
            padding: '0 9px', display: 'flex', alignItems: 'center', fontSize: 11, cursor: 'pointer', userSelect: 'none',
            fontWeight: id === current ? 700 : 400,
            background: id === current ? 'var(--ink-3)' : 'transparent',
            color: id === current ? '#fff' : 'var(--ink-3)',
          }}>{label}</div>
      ))}
    </div>
  )
}

// Tables | Logical switch for a relational schema (Advanced mode): its
// relational face, or its logical view, the ORM2 schema that stores it, in
// the diagrams, the schema browser, the Inspector and the tool panel.
function FaceSwitch({ schemaId, logical }) {
  const current = logical ? 'logical' : 'tables'
  const opts = [
    ['tables', 'Tables', "Show this schema as tables, keys and constraints (diagrams as crow's foot ERDs)"],
    ['logical', 'Logical', 'Show the ORM2 schema that stores this relational schema (its logical view)'],
  ]
  return (
    <div style={{ display: 'flex', border: '1px solid var(--border)', borderRadius: 11, overflow: 'hidden', height: 20, marginRight: 8, flexShrink: 0 }}>
      {opts.map(([id, label, title]) => (
        <div key={id} title={title}
          onClick={() => { if (id !== current) useOrmStore.getState().setSchemaLogicalView(schemaId, id === 'logical') }}
          style={{
            padding: '0 9px', display: 'flex', alignItems: 'center', fontSize: 11, cursor: 'pointer', userSelect: 'none',
            fontWeight: id === current ? 700 : 400,
            background: id === current ? 'var(--col-schema-relational)' : 'transparent',
            color: id === current ? '#fff' : 'var(--ink-3)',
          }}>{label}</div>
      ))}
    </div>
  )
}
