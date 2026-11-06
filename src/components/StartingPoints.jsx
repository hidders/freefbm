import React, { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useOrmStore } from '../store/ormStore'
import { majorTypes } from '../utils/neighbourhood.js'

// Suggested starting points (growing mode): the schema's major types, ranked
// (majorTypes), each with New diagram (New Diagram from Here) and, when this
// diagram doesn't show it, Add here.
export default function StartingPoints({ diagram }) {
  const [open, setOpen] = useState(null)   // { x, y } of the menu
  const ref = useRef(null)
  const objectTypes = useOrmStore(s => s.objectTypes)
  const facts = useOrmStore(s => s.facts)
  const subtypes = useOrmStore(s => s.subtypes)
  const constraints = useOrmStore(s => s.constraints)
  const schemas = useOrmStore(s => s.schemas)
  const diagrams = useOrmStore(s => s.diagrams)
  const list = useMemo(() => open ? majorTypes({ objectTypes, facts, subtypes, constraints, schemas, diagrams }, diagram.schemaId, 20) : [],
    [open, objectTypes, facts, subtypes, constraints, schemas, diagrams, diagram.schemaId])
  const shown = new Set((diagram.occurrences ?? []).map(o => o.schemaElementId))

  useEffect(() => {
    if (!open) return
    const close = (e) => { if (!ref.current?.contains(e.target)) setOpen(null) }
    const esc = (e) => { if (e.key === 'Escape') setOpen(null) }
    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', esc)
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', esc) }
  }, [open])

  const btn = { fontSize: 10, padding: '1px 6px', border: '1px solid var(--border)', borderRadius: 4, background: 'var(--bg-surface)', color: 'var(--ink-2)', cursor: 'pointer', whiteSpace: 'nowrap' }
  return <>
    <span className="starting-points-toggle" title="The schema's major types, as seeds for new diagrams"
      onMouseDown={e => e.stopPropagation()}
      onClick={e => { const r = e.currentTarget.getBoundingClientRect(); setOpen(open ? null : { x: r.left, y: r.bottom + 4 }) }}
      style={{ cursor: 'pointer', color: open ? 'var(--ink-1)' : 'var(--ink-3)' }}
      onMouseEnter={e => { e.currentTarget.style.color = 'var(--ink-1)' }}
      onMouseLeave={e => { if (!open) e.currentTarget.style.color = 'var(--ink-3)' }}
    >Starting points</span>
    {open && createPortal(
      <div ref={ref} className="starting-points" style={{ position: 'fixed', left: Math.min(open.x, window.innerWidth - 400), top: open.y, width: 380, maxHeight: '60vh', overflowY: 'auto', zIndex: 1000,
        background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 6, boxShadow: '0 6px 24px rgba(0,0,0,0.18)', padding: '6px 0', fontSize: 12 }}>
        <div style={{ padding: '2px 12px 6px', color: 'var(--ink-3)', fontSize: 11, borderBottom: '1px solid var(--border)' }}>
          Major types of this schema, the most connected first
        </div>
        {!list.length && <div style={{ padding: '8px 12px', color: 'var(--ink-3)' }}>No types with relationships</div>}
        {list.map(m => (
          <div key={m.id} className="starting-point" style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 12px' }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 600, color: 'var(--ink-1)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{m.name}</div>
              <div style={{ fontSize: 11, color: 'var(--ink-3)' }}>
                {m.reason}{m.diagrams ? ` · on ${m.diagrams} diagram${m.diagrams === 1 ? '' : 's'}` : ' · on no diagram'}
              </div>
            </div>
            {!shown.has(m.id) && (
              <button style={btn} title="Add it to this diagram"
                onClick={() => { const s = useOrmStore.getState(); s.addElementToDiagram(m.id, diagram.id); s.centerOnElement(m.id); setOpen(null) }}>Add here</button>
            )}
            <button style={btn} title="A new diagram with it, and its neighbours to choose from"
              onClick={() => { useOrmStore.getState().newDiagramFrom(m.id); setOpen(null) }}>New diagram</button>
          </div>
        ))}
      </div>, document.body)}
  </>
}
