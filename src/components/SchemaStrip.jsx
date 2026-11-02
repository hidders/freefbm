import React, { useState, useRef, useEffect } from 'react'
import { useOrmStore } from '../store/ormStore'
import { useShallow } from 'zustand/react/shallow'
import { activeSchemaIdOf } from '../store/storeHelpers'

const FONT = "'Segoe UI', Helvetica, Arial, sans-serif"

export const PROFILE_LABELS = {
  orm2:       { tag: 'ORM2', name: 'ORM2 schema',       color: 'var(--col-schema-orm2)' },
  relational: { tag: 'RM',   name: 'Relational schema', color: 'var(--col-schema-relational)' },
}

// The schemas of the file as a row of chips above the diagram tabs (workbench
// step 3). Shown only when the file has more than one schema; with one, the
// diagram tab bar offers "+ Schema" instead. Clicking a chip switches to that
// schema's diagrams, double-clicking renames it, and an empty schema can be
// removed with its ✕.
export default function SchemaStrip() {
  const { schemas, activeId, counts } = useOrmStore(useShallow(s => ({
    schemas: s.schemas ?? [],
    activeId: activeSchemaIdOf(s),
    counts: countsKey(s),
  })))
  const [editingId, setEditingId] = useState(null)
  const [draft, setDraft] = useState('')
  const inputRef = useRef(null)

  useEffect(() => {
    if (editingId && inputRef.current) { inputRef.current.focus(); inputRef.current.select() }
  }, [editingId])

  if (schemas.length <= 1) return null
  const sizes = Object.fromEntries(counts.split('|').filter(Boolean).map(x => x.split('=')).map(([k, v]) => [k, +v]))

  const commit = () => {
    if (editingId && draft.trim()) useOrmStore.getState().renameSchema(editingId, draft.trim())
    setEditingId(null)
  }

  return (
    <div id="schema-strip" style={{
      display: 'flex', alignItems: 'center', gap: 6,
      padding: '4px 8px', background: 'var(--bg-deep)',
      borderBottom: '1px solid var(--border)', overflowX: 'auto', flexShrink: 0,
      fontFamily: FONT, userSelect: 'none',
    }}>
      <span style={{ fontSize: 9, letterSpacing: '0.07em', textTransform: 'uppercase', color: 'var(--ink-2)', marginRight: 2 }}>
        Schemas
      </span>
      {schemas.map(sc => {
        const active = sc.id === activeId
        const prof = PROFILE_LABELS[sc.profile] ?? PROFILE_LABELS.orm2
        const size = sizes[sc.id] ?? 0
        const editing = editingId === sc.id
        return (
          <div
            key={sc.id}
            data-schema-id={sc.id}
            onClick={() => { if (!editing) useOrmStore.getState().setActiveSchema(sc.id) }}
            onDoubleClick={() => { setDraft(sc.name); setEditingId(sc.id) }}
            title={`${prof.name} · ${size} element${size === 1 ? '' : 's'}. Double-click to rename.`}
            className="schema-chip"
            style={{
              display: 'flex', alignItems: 'center', gap: 5,
              height: 22, padding: '0 8px 0 3px', borderRadius: 11,
              border: `1px solid ${active ? 'var(--border-dark)' : 'var(--border)'}`,
              background: active ? 'var(--bg-canvas)' : 'var(--bg-surface)',
              color: active ? 'var(--ink-1)' : 'var(--ink-2)',
              fontSize: 12, fontWeight: active ? 600 : 400,
              cursor: 'pointer', whiteSpace: 'nowrap', flexShrink: 0,
              boxShadow: active ? 'var(--shadow-sm)' : 'none',
            }}
          >
            <span style={{
              fontSize: 9, fontWeight: 700, letterSpacing: '0.04em', color: '#fff',
              background: prof.color, borderRadius: 8, padding: '1px 5px', lineHeight: '12px',
            }}>{prof.tag}</span>
            {editing ? (
              <input
                ref={inputRef}
                value={draft}
                onChange={e => setDraft(e.target.value)}
                onBlur={commit}
                onKeyDown={e => {
                  e.stopPropagation()
                  if (e.key === 'Enter') { e.preventDefault(); commit() }
                  if (e.key === 'Escape') setEditingId(null)
                }}
                onClick={e => e.stopPropagation()}
                style={{
                  border: 'none', outline: 'none', background: 'transparent', color: 'var(--ink-1)',
                  fontSize: 12, fontFamily: FONT, width: Math.max(60, draft.length * 8),
                }}
              />
            ) : <span>{sc.name}</span>}
            {size === 0 && !editing && (
              <span
                title="Remove this empty schema"
                onClick={e => { e.stopPropagation(); useOrmStore.getState().deleteSchema(sc.id) }}
                style={{ color: 'var(--ink-muted)', fontSize: 10, marginLeft: 2, cursor: 'pointer' }}
                onMouseEnter={e => { e.currentTarget.style.color = 'var(--danger)' }}
                onMouseLeave={e => { e.currentTarget.style.color = 'var(--ink-muted)' }}
              >✕</span>
            )}
          </div>
        )
      })}
      <NewSchemaMenu variant="strip" />
    </div>
  )
}

// "schemaId=n|..." element counts per schema, as a string so the selector
// above stays shallow-equal while the counts don't change.
function countsKey(s) {
  const n = new Map()
  for (const k of ['objectTypes', 'facts', 'subtypes', 'constraints'])
    for (const x of (s[k] ?? [])) n.set(x.schemaId, (n.get(x.schemaId) ?? 0) + 1)
  return [...n].map(([k, v]) => `${k}=${v}`).join('|')
}

// A "+" that opens a small menu for adding an ORM2 or a relational schema.
// variant 'tab' sits at the right end of the diagram tab bar (one schema),
// 'strip' at the end of the schema strip.
export function NewSchemaMenu({ variant = 'strip' }) {
  const [open, setOpen] = useState(false)
  const ref = useRef(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e) => { if (!ref.current?.contains(e.target)) setOpen(false) }
    window.addEventListener('mousedown', onDown, true)
    return () => window.removeEventListener('mousedown', onDown, true)
  }, [open])

  const add = (profile) => {
    setOpen(false)
    useOrmStore.getState().addSchema(profile === 'relational' ? 'Relational' : 'Schema', profile)
  }

  const tab = variant === 'tab'
  return (
    <div ref={ref} style={{ position: tab ? 'static' : 'relative', marginLeft: tab ? 'auto' : 0, flexShrink: 0, alignSelf: tab ? 'center' : 'auto' }}>
      <div
        onClick={() => setOpen(o => !o)}
        title="Add a schema to this file"
        className="new-schema-button"
        style={{
          display: 'flex', alignItems: 'center', gap: 3,
          height: tab ? 20 : 22, padding: tab ? '0 8px' : '0 7px', marginRight: tab ? 8 : 0,
          borderRadius: 11, border: '1px dashed var(--border)',
          color: 'var(--ink-muted)', fontSize: 11, cursor: 'pointer', userSelect: 'none',
          fontFamily: FONT, whiteSpace: 'nowrap',
        }}
        onMouseEnter={e => { e.currentTarget.style.color = 'var(--ink-1)' }}
        onMouseLeave={e => { e.currentTarget.style.color = 'var(--ink-muted)' }}
      >
        <span style={{ fontSize: 13, lineHeight: 1 }}>+</span>{tab && <span>Schema</span>}
      </div>
      {open && (
        <div style={{
          position: 'fixed', zIndex: 50,
          ...menuPosition(ref.current),
          background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 6,
          boxShadow: 'var(--shadow-md)', padding: 4, minWidth: 170, fontFamily: FONT,
        }}>
          {['orm2', 'relational'].map(p => (
            <div key={p}
              onClick={() => add(p)}
              style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '5px 8px', borderRadius: 4, fontSize: 12, cursor: 'pointer', color: 'var(--ink-1)' }}
              onMouseEnter={e => { e.currentTarget.style.background = 'var(--bg-hover)' }}
              onMouseLeave={e => { e.currentTarget.style.background = 'transparent' }}
            >
              <span style={{
                fontSize: 9, fontWeight: 700, color: '#fff', background: PROFILE_LABELS[p].color,
                borderRadius: 8, padding: '1px 5px', lineHeight: '12px',
              }}>{PROFILE_LABELS[p].tag}</span>
              New {PROFILE_LABELS[p].name.toLowerCase()}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// Opens below the button, kept inside the window.
function menuPosition(el) {
  const r = el?.getBoundingClientRect()
  if (!r) return { top: 60, left: 8 }
  const left = Math.max(8, Math.min(r.left, window.innerWidth - 190))
  return { top: r.bottom + 4, left }
}
