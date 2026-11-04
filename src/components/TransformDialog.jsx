// Named transformations (mapping/transformations.js): pick one, fill in what
// it needs, and apply it as one step. The result is a new version of the
// schema with the mapping from the old one. Opened with
// store.transformDialog = { schemaId }.
import React, { useMemo, useState } from 'react'
import { useOrmStore } from '../store/ormStore'
import { sideContext } from '../mapping/mapping'
import { TRANSFORMATIONS } from '../mapping/transformations'

const FONT = "'Segoe UI', Helvetica, Arial, sans-serif"

export default function TransformDialog() {
  const schemaId = useOrmStore(s => s.transformDialog?.schemaId ?? null)
  if (!schemaId) return null
  return <Dialog schemaId={schemaId} />
}

function Dialog({ schemaId }) {
  const close = () => useOrmStore.setState({ transformDialog: null })
  const { ctx, schema } = useMemo(() => {
    const st = useOrmStore.getState()
    return { ctx: sideContext(st, schemaId), schema: st.schemas.find(x => x.id === schemaId) }
  }, [schemaId])
  const kinds = TRANSFORMATIONS.filter(t => t.profile === (schema?.profile === 'relational' ? 'relational' : 'orm2'))
  const [kind, setKind] = useState(kinds[0]?.id ?? null)
  const [params, setParams] = useState({})
  const [error, setError] = useState(null)
  const tr = kinds.find(t => t.id === kind)
  const p = params[kind] ?? {}
  const setP = (patch) => { setError(null); setParams(x => ({ ...x, [kind]: { ...(x[kind] ?? {}), ...patch } })) }

  const field = (label, control) => (
    <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', margin: '6px 0' }}>
      <span style={{ width: 110, color: 'var(--ink-3)', flex: 'none' }}>{label}</span>
      <div style={{ flex: 1, minWidth: 0 }}>{control}</div>
    </div>
  )
  const tableSelect = (value, onChange, tables = ctx.tables) => (
    <select value={value ?? ''} onChange={e => onChange(e.target.value || null)} style={sel}>
      <option value="">Choose a table…</option>
      {tables.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
    </select>
  )
  const nameInput = (fallback) => (
    <input value={p.name ?? fallback ?? ''} onChange={e => setP({ name: e.target.value })} style={{ ...sel, width: 220 }} aria-label="Name of the new table" />
  )
  // The params with a default name filled in.
  const withName = (fallback) => (p.name == null && fallback ? { ...p, name: fallback } : p)

  let form = null, effective = p
  if (kind === 'split') {
    const t = ctx.tableById.get(p.tableId)
    const fallback = t ? `${t.name}_part` : ''
    effective = withName(fallback)
    form = <>
      {field('Table', tableSelect(p.tableId, v => setP({ tableId: v, columnIds: [] }), ctx.tables.filter(x => x.pk?.length)))}
      {t && field('Columns to move', (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '2px 12px' }}>
          {t.columns.filter(c => !c.pk).map(c => (
            <label key={c.fact.id} style={{ display: 'flex', gap: 4, alignItems: 'center', cursor: 'pointer' }}>
              <input type="checkbox" style={{ width: 'auto' }} checked={(p.columnIds ?? []).includes(c.fact.id)}
                onChange={e => setP({ columnIds: e.target.checked ? [...(p.columnIds ?? []), c.fact.id] : (p.columnIds ?? []).filter(x => x !== c.fact.id) })} />
              {c.name}{c.notNull ? '' : '?'}
            </label>
          ))}
        </div>
      ))}
      {t && field('New table', nameInput(fallback))}
    </>
  } else if (kind === 'absorb') {
    const from = ctx.tables.filter(u => tr.targets(ctx, u.id).length)
    const targets = p.fromId ? tr.targets(ctx, p.fromId) : []
    effective = { ...p, intoId: p.intoId ?? targets[0]?.id ?? null }
    form = <>
      {field('Table to absorb', tableSelect(p.fromId, v => setP({ fromId: v, intoId: null }), from))}
      {p.fromId && field('Into', tableSelect(effective.intoId, v => setP({ intoId: v }), targets))}
      {!from.length && <div style={{ color: 'var(--ink-2)' }}>No table's key is a foreign key to another table's key, so none can be absorbed.</div>}
    </>
  } else if (kind === 'fkToTable' || kind === 'boolToTable') {
    const opts = tr.options(ctx)
    const key = (o) => `${o.tableId}|${o.columnId ?? o.columnIds?.join(',')}`
    const cur = opts.find(o => o.tableId === p.tableId && (kind === 'boolToTable' ? o.columnId === p.columnId : JSON.stringify(o.columnIds) === JSON.stringify(p.columnIds)))
    effective = withName(cur?.name)
    form = <>
      {field(kind === 'fkToTable' ? 'Foreign key' : 'Boolean column', (
        <select value={cur ? key(cur) : ''} style={sel} onChange={e => {
          const o = opts.find(x => key(x) === e.target.value)
          setP(o ? { tableId: o.tableId, columnId: o.columnId, columnIds: o.columnIds, name: null } : { tableId: null })
        }}>
          <option value="">Choose…</option>
          {opts.map(o => <option key={key(o)} value={key(o)}>{o.label}</option>)}
        </select>
      ))}
      {!opts.length && <div style={{ color: 'var(--ink-2)' }}>{kind === 'fkToTable' ? 'The schema has no foreign key outside a primary key.' : 'The schema has no boolean column.'}</div>}
      {cur && field('New table', nameInput(cur.name))}
    </>
  }
  const effProblems = tr ? tr.check(effective, ctx) : []
  const run = () => {
    const r = useOrmStore.getState().transformSchema(schemaId, kind, effective)
    if (r.error) setError(r.error)
    else close()
  }

  return (
    <div onMouseDown={e => { if (e.target === e.currentTarget) close() }}
      onKeyDown={e => { e.stopPropagation(); if (e.key === 'Escape') close() }}
      style={{ position: 'fixed', inset: 0, zIndex: 1000, background: 'rgba(0,0,0,0.25)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: FONT }}>
      <div className="transform-dialog" style={{ width: 620, maxWidth: 'calc(100vw - 32px)', maxHeight: '80vh', display: 'flex', flexDirection: 'column',
        background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', boxShadow: 'var(--shadow-lg)' }}>
        <div style={{ padding: '12px 14px 8px', borderBottom: '1px solid var(--border-soft)' }}>
          <div style={{ fontWeight: 600, fontSize: 14, color: 'var(--ink-1)' }}>Transform {schema?.name ?? 'the schema'}</div>
          <div style={{ fontSize: 12, color: 'var(--ink-2)', marginTop: 4, lineHeight: 1.45 }}>
            A transformation makes a new version of the schema, with the mapping from this one. This schema stays as it is;
            the mapping's Equivalence button checks that nothing is lost.
          </div>
        </div>
        <div style={{ overflowY: 'auto', padding: '8px 14px', fontSize: 12 }}>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>
            {kinds.map(t => (
              <button key={t.id} onClick={() => { setKind(t.id); setError(null) }}
                style={{ ...btn(false), borderColor: t.id === kind ? 'var(--accent)' : 'var(--border)', color: t.id === kind ? 'var(--accent)' : 'var(--ink-1)', fontWeight: t.id === kind ? 600 : 400 }}>
                {t.label}
              </button>
            ))}
          </div>
          {form}
          {tr && <div style={{ marginTop: 10, color: 'var(--ink-1)', lineHeight: 1.45 }}>{tr.describe(effective, ctx)}</div>}
          {effProblems.map((x, i) => <div key={i} style={{ color: 'var(--ink-3)', marginTop: 3 }}>{x}</div>)}
          {error && <div style={{ color: 'var(--danger)', marginTop: 6 }}>Could not transform: {error}</div>}
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, padding: '10px 14px', borderTop: '1px solid var(--border-soft)' }}>
          <button onClick={close} style={btn(false)}>Cancel</button>
          <button onClick={run} disabled={!!effProblems.length} style={{ ...btn(true), opacity: effProblems.length ? 0.5 : 1 }}>Transform</button>
        </div>
      </div>
    </div>
  )
}

const sel = { fontFamily: FONT, fontSize: 12, padding: '2px 4px', border: '1px solid var(--border)', borderRadius: 4, background: 'var(--bg-surface)', color: 'var(--ink-1)', maxWidth: '100%' }
const btn = (primary) => ({
  fontFamily: FONT, fontSize: 12, padding: '5px 12px', borderRadius: 4, cursor: 'pointer',
  border: `1px solid ${primary ? 'var(--accent)' : 'var(--border)'}`,
  background: primary ? 'var(--accent)' : 'var(--bg-surface)', color: primary ? '#fff' : 'var(--ink-1)',
})
