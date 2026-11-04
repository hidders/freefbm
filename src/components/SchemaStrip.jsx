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
  const { schemas, activeId, counts, mappings, activeMappingId, broken } = useOrmStore(useShallow(s => ({
    schemas: s.schemas ?? [],
    activeId: activeSchemaIdOf(s),
    counts: countsKey(s),
    mappings: s.mappings ?? [],
    activeMappingId: s.diagrams.find(d => d.id === s.activeDiagramId)?.mappingId ?? null,
    broken: brokenKey(s),
  })))
  const [editingId, setEditingId] = useState(null)
  const [draft, setDraft] = useState('')
  const inputRef = useRef(null)

  useEffect(() => {
    if (editingId && inputRef.current) { inputRef.current.focus(); inputRef.current.select() }
  }, [editingId])

  if (schemas.length <= 1 && !mappings.length) return null
  // Rules with errors per mapping (from validation, category Mapping Rules).
  const brokenRules = Object.fromEntries(broken.split('|').filter(Boolean).map(x => x.split('=')).map(([k, v]) => [k, +v]))
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
        const active = sc.id === activeId && !activeMappingId
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
            {(size === 0 || active) && schemas.length > 1 && !editing && (
              <span
                className="schema-delete"
                title={size === 0 ? 'Remove this empty schema' : 'Delete this schema with its elements (Undo brings it back)'}
                onClick={e => {
                  e.stopPropagation()
                  const st = useOrmStore.getState()
                  const ms = (st.mappings ?? []).filter(m => m.sourceSchemaId === sc.id || m.targetSchemaId === sc.id)
                  if (size > 0 || ms.length) {
                    const parts = [size ? `its ${size} element${size === 1 ? '' : 's'}` : null,
                      ms.length ? `${ms.length === 1 ? 'the mapping' : `the ${ms.length} mappings`} ${ms.map(m => `“${m.name}”`).join(', ')}` : null].filter(Boolean)
                    if (!window.confirm(`Delete schema “${sc.name}” with ${parts.join(' and ')}? Undo brings it back.`)) return
                  }
                  st.deleteSchema(sc.id, { withContents: true })
                }}
                style={{ color: 'var(--ink-muted)', fontSize: 10, marginLeft: 2, cursor: 'pointer' }}
                onMouseEnter={e => { e.currentTarget.style.color = 'var(--danger)' }}
                onMouseLeave={e => { e.currentTarget.style.color = 'var(--ink-muted)' }}
              >✕</span>
            )}
          </div>
        )
      })}
      <NewSchemaMenu variant="strip" />
      {mappings.length > 0 && <>
        <span style={{ fontSize: 9, letterSpacing: '0.07em', textTransform: 'uppercase', color: 'var(--ink-2)', margin: '0 2px 0 10px' }}>
          Mappings
        </span>
        {mappings.map(m => {
          const active = m.id === activeMappingId
          const nameOf = (id) => schemas.find(x => x.id === id)?.name ?? '?'
          return (
            <div key={m.id}
              data-mapping-id={m.id}
              className="mapping-chip"
              onClick={() => useOrmStore.getState().openMappingDiagram(m.id)}
              title={`${nameOf(m.sourceSchemaId)} ⟺ ${nameOf(m.targetSchemaId)} · ${m.rules.length} rule${m.rules.length === 1 ? '' : 's'}${brokenRules[m.id] ? `, ${brokenRules[m.id]} broken (see Validation › Mapping Rules)` : ''}. Click for its diagram.`}
              style={{
                display: 'flex', alignItems: 'center', gap: 5,
                height: 22, padding: '0 8px 0 3px', borderRadius: 11,
                border: `1px ${active ? 'solid' : 'dashed'} ${active ? 'var(--border-dark)' : 'var(--border)'}`,
                background: active ? 'var(--bg-canvas)' : 'var(--bg-surface)',
                color: active ? 'var(--ink-1)' : 'var(--ink-2)',
                fontSize: 12, fontWeight: active ? 600 : 400,
                cursor: 'pointer', whiteSpace: 'nowrap', flexShrink: 0,
                boxShadow: active ? 'var(--shadow-sm)' : 'none',
              }}>
              <span style={{
                fontSize: 9, fontWeight: 700, color: '#fff', borderRadius: 8, padding: '1px 5px', lineHeight: '12px',
                background: 'linear-gradient(90deg, var(--map-source) 50%, var(--map-target) 50%)',
              }}>⟺</span>
              <span>{m.name}</span>
              {brokenRules[m.id] > 0 && <span className="mapping-broken" style={{
                fontSize: 9, fontWeight: 700, color: '#fff', background: 'var(--danger, #dc2626)', borderRadius: 7,
                padding: '0 4px', lineHeight: '13px', minWidth: 13, textAlign: 'center',
              }}>{brokenRules[m.id]}</span>}
            </div>
          )
        })}
      </>}
    </div>
  )
}

// "mappingId=n|..." the number of rules with errors per mapping, from the
// validation results, as a string for the same reason as countsKey.
function brokenKey(s) {
  const rules = new Map()
  for (const e of s.validationErrors ?? []) {
    if (e.category !== 'mappingRules' || e.severity !== 'error') continue
    if (!rules.has(e.mappingId)) rules.set(e.mappingId, new Set())
    rules.get(e.mappingId).add(e.elementId)
  }
  return [...rules].map(([k, v]) => `${k}=${v.size}`).join('|')
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
  const relSchemas = useOrmStore(useShallow(s => (s.schemas ?? []).filter(x => x.profile === 'relational')))
  const ormSchemas = useOrmStore(useShallow(s => (s.schemas ?? []).filter(x => x.profile !== 'relational')))
  // Schemas with derived or semi-derived elements, which Refactor folds into a new version.
  const refactorable = useOrmStore(useShallow(s => (s.schemas ?? []).filter(x =>
    (s.objectTypes ?? []).some(o => o.schemaId === x.id && (o.derivation === 'derived' || o.derivation === 'semiDerived')) || (s.facts ?? []).some(f => f.schemaId === x.id && (f.derivation === 'derived' || f.derivation === 'semiDerived')))))

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
    <div ref={ref} style={{ position: tab ? 'static' : 'relative', flexShrink: 0, alignSelf: tab ? 'center' : 'auto' }}>
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
          position: 'fixed', zIndex: 50, minWidth: 230,
          ...menuPosition(ref.current),
          background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 6,
          boxShadow: 'var(--shadow-md)', padding: 4, fontFamily: FONT,
        }}>
          {relSchemas.map(sc => (
            <div key={sc.id}
              className="guess-orm-item"
              onClick={() => { setOpen(false); useOrmStore.setState({ guessOrmDialog: { relSchemaId: sc.id } }) }}
              title="A new ORM2 schema guessed from the tables, with the mapping between them"
              style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '5px 8px', borderRadius: 4, fontSize: 12, cursor: 'pointer', color: 'var(--ink-1)' }}
              onMouseEnter={e => { e.currentTarget.style.background = 'var(--bg-hover)' }}
              onMouseLeave={e => { e.currentTarget.style.background = 'transparent' }}
            >
              <span style={{
                fontSize: 9, fontWeight: 700, color: '#fff', background: PROFILE_LABELS.orm2.color,
                borderRadius: 8, padding: '1px 5px', lineHeight: '12px',
              }}>{PROFILE_LABELS.orm2.tag}</span>
              ORM2 schema guessed from {sc.name}…
            </div>
          ))}
          {relSchemas.map(sc => (
            <div key={`derived-${sc.id}`}
              className="derived-table-item"
              onClick={() => { setOpen(false); useOrmStore.getState().addDerivedTable(sc.id) }}
              title="A new table of the relational schema whose rows a query over the schema gives (a view)"
              style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '5px 8px', borderRadius: 4, fontSize: 12, cursor: 'pointer', color: 'var(--ink-1)' }}
              onMouseEnter={e => { e.currentTarget.style.background = 'var(--bg-hover)' }}
              onMouseLeave={e => { e.currentTarget.style.background = 'transparent' }}
            >
              <span style={{
                fontSize: 9, fontWeight: 700, color: '#fff', background: PROFILE_LABELS.relational.color,
                borderRadius: 8, padding: '1px 5px', lineHeight: '12px',
              }}>{PROFILE_LABELS.relational.tag}</span>
              Derived table in {sc.name}…
            </div>
          ))}
          {[...relSchemas, ...ormSchemas].map(sc => (
            <div key={`transform-${sc.id}`}
              className="transform-schema-item"
              onClick={() => { setOpen(false); useOrmStore.setState({ transformDialog: { schemaId: sc.id } }) }}
              title="A named transformation (split, absorb, keys, partitioning, subtypes, unaries, …): a new version of the schema, with the mapping from this one"
              style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '5px 8px', borderRadius: 4, fontSize: 12, cursor: 'pointer', color: 'var(--ink-1)' }}
              onMouseEnter={e => { e.currentTarget.style.background = 'var(--bg-hover)' }}
              onMouseLeave={e => { e.currentTarget.style.background = 'transparent' }}
            >
              <span style={{
                fontSize: 9, fontWeight: 700, color: '#fff', background: PROFILE_LABELS.relational.color,
                borderRadius: 8, padding: '1px 5px', lineHeight: '12px',
              }}>{PROFILE_LABELS.relational.tag}</span>
              Transform {sc.name}…
            </div>
          ))}
          {refactorable.map(sc => (
            <div key={`refactor-${sc.id}`}
              className="refactor-schema-item"
              onClick={() => { setOpen(false); useOrmStore.getState().refactorSchema(sc.id) }}
              title="A new version of the schema in which its derived types, fact types, tables and columns are stored, with the mapping from the old version (Fold)"
              style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '5px 8px', borderRadius: 4, fontSize: 12, cursor: 'pointer', color: 'var(--ink-1)' }}
              onMouseEnter={e => { e.currentTarget.style.background = 'var(--bg-hover)' }}
              onMouseLeave={e => { e.currentTarget.style.background = 'transparent' }}
            >
              <span style={{
                fontSize: 9, fontWeight: 700, color: '#fff', background: PROFILE_LABELS[sc.profile === 'relational' ? 'relational' : 'orm2'].color,
                borderRadius: 8, padding: '1px 5px', lineHeight: '12px',
              }}>{PROFILE_LABELS[sc.profile === 'relational' ? 'relational' : 'orm2'].tag}</span>
              Refactor {sc.name}: new version with its derived elements folded…
            </div>
          ))}
          {ormSchemas.map(sc => (
            <div key={sc.id}
              className="generate-relational-item"
              onClick={() => { setOpen(false); useOrmStore.setState({ generateRelationalDialog: { ormSchemaId: sc.id } }) }}
              title="A new relational schema generated from the ORM2 schema (Rmap), with the mapping between them"
              style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '5px 8px', borderRadius: 4, fontSize: 12, cursor: 'pointer', color: 'var(--ink-1)' }}
              onMouseEnter={e => { e.currentTarget.style.background = 'var(--bg-hover)' }}
              onMouseLeave={e => { e.currentTarget.style.background = 'transparent' }}
            >
              <span style={{
                fontSize: 9, fontWeight: 700, color: '#fff', background: PROFILE_LABELS.relational.color,
                borderRadius: 8, padding: '1px 5px', lineHeight: '12px',
              }}>{PROFILE_LABELS.relational.tag}</span>
              Tables generated from {sc.name}…
            </div>
          ))}
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
