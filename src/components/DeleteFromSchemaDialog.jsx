import React, { useMemo, useEffect, useRef } from 'react'
import { useOrmStore } from '../store/ormStore'
import { deletionSummary, deleteFromSchema } from '../utils/deleteSelection'

const FONT = 'var(--font-ui)'

// Edit › Delete from Schema… asks here first: it names what will be deleted
// and what goes with it. Delete on the keyboard only takes things off the
// diagram (utils/deleteSelection.js).
export default function DeleteFromSchemaDialog() {
  const ids = useOrmStore(s => s.deleteFromSchemaDialog?.ids ?? null)
  if (!ids) return null
  return <Dialog ids={ids} />
}

function Dialog({ ids }) {
  const close = () => useOrmStore.setState({ deleteFromSchemaDialog: null })
  const { elements, consequences } = useMemo(() => deletionSummary(useOrmStore.getState(), ids), [ids])
  const cancelRef = useRef(null)
  useEffect(() => { cancelRef.current?.focus() }, [])
  const go = () => { close(); deleteFromSchema(ids) }
  const n = elements.length

  return (
    <div onMouseDown={e => { if (e.target === e.currentTarget) close() }}
      onKeyDown={e => { e.stopPropagation(); if (e.key === 'Escape') close() }}
      style={{ position: 'fixed', inset: 0, zIndex: 1000, background: 'rgba(0,0,0,0.25)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: FONT }}>
      <div role="alertdialog" aria-labelledby="del-schema-title" style={{ width: 460, maxWidth: 'calc(100vw - 32px)', maxHeight: '80vh', display: 'flex', flexDirection: 'column',
        background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', boxShadow: 'var(--shadow-lg)' }}>
        <div style={{ padding: '12px 14px 8px', borderBottom: '1px solid var(--border-soft)' }}>
          <div id="del-schema-title" style={{ fontWeight: 600, fontSize: 14, color: 'var(--ink-1)' }}>
            Delete {n === 1 ? 'this element' : `these ${n} elements`} from the schema?
          </div>
          <div style={{ fontSize: 12, color: 'var(--ink-2)', marginTop: 4, lineHeight: 1.45 }}>
            They are removed from the schema and from every diagram, with their sample populations.
            To take something off this diagram only, press Delete instead. Undo brings it all back.
          </div>
        </div>
        <div style={{ overflowY: 'auto', padding: '8px 14px', fontSize: 12, color: 'var(--ink-1)', lineHeight: 1.5 }}>
          <ul style={{ margin: '0 0 6px', paddingLeft: 18 }}>
            {elements.slice(0, 12).map((t, i) => <li key={i}>{t}</li>)}
            {elements.length > 12 && <li style={{ color: 'var(--ink-3)' }}>and {elements.length - 12} more</li>}
          </ul>
          {consequences.length > 0 && <>
            <div style={{ fontWeight: 600, margin: '6px 0 2px' }}>With {n === 1 ? 'it' : 'them'}</div>
            <ul style={{ margin: 0, paddingLeft: 18, color: 'var(--ink-2)' }}>
              {consequences.map((t, i) => <li key={i}>{t}</li>)}
            </ul>
          </>}
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, padding: '10px 14px', borderTop: '1px solid var(--border-soft)' }}>
          <button ref={cancelRef} onClick={close} style={btn(false)}>Cancel</button>
          <button onClick={go} style={btn(true)}>Delete from schema</button>
        </div>
      </div>
    </div>
  )
}

const btn = (danger) => ({
  padding: '5px 14px', fontSize: 12, fontFamily: FONT, borderRadius: 4, cursor: 'pointer',
  border: `1px solid ${danger ? 'var(--danger)' : 'var(--border)'}`,
  background: danger ? 'var(--danger)' : 'var(--bg-raised)', color: danger ? '#fff' : 'var(--ink-1)',
})
