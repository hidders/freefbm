// The Population tab of a relational schema showing its tables (RM schemas
// first-class, step 3): the records of one table as a grid, one row per
// record and one column per table column (relational/records.js). Stored
// tables are edited in place: click a cell, Enter or leaving it commits, Esc
// cancels; the last row adds a record; ✕ deletes one. Views and derived
// columns are computed and read-only. Cells that break NOT NULL or a foreign
// key are marked.

import React, { useMemo, useState, useEffect, useRef } from 'react'
import { useOrmStore } from '../store/ormStore'
import { activeSchemaIdOf } from '../store/storeHelpers'
import { relationalView } from '../relational/relationalView'
import { relationalModel } from '../relational/relationalModel'
import { tableShape, tableRecords } from '../relational/records'
import { TableIcon } from './RelationalBrowser'
import { selectedTableId } from '../relational/rmText'

const PAGE = 200
const FONT = "'Segoe UI', Helvetica, Arial, sans-serif"

export default function RelationalPopulation() {
  const schemaId = useOrmStore(s => activeSchemaIdOf(s))
  const selected = useOrmStore(s => selectedTableId(s, relationalView(s, schemaId)))
  const objectTypes = useOrmStore(s => s.objectTypes)
  const [tableId, setTableId] = useState(selected)
  useEffect(() => { if (selected) setTableId(selected) }, [selected])
  const tables = useMemo(() => objectTypes.filter(o => o.schemaId === schemaId && o.kind === 'entity')
    .sort((a, b) => a.name.localeCompare(b.name)), [objectTypes, schemaId])
  const current = tables.some(t => t.id === tableId) ? tableId : null
  return (
    <div style={{ fontFamily: FONT, fontSize: 11 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <TableIcon />
        <select value={current ?? ''} onChange={e => setTableId(e.target.value || null)}
          style={{ fontSize: 11, padding: '2px 4px', background: 'var(--bg-surface)', color: 'var(--ink)', border: '1px solid var(--border)', borderRadius: 3 }}>
          <option value="">Choose a table…</option>
          {tables.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
        </select>
        {!current && <span style={{ color: 'var(--ink-3)' }}>or select one in the schema browser or the diagram.</span>}
      </div>
      {current && <RecordGrid key={current} schemaId={schemaId} tableId={current} />}
    </div>
  )
}

function RecordGrid({ schemaId, tableId }) {
  const populations = useOrmStore(s => s.populations)
  const factPopulations = useOrmStore(s => s.factPopulations)
  const facts = useOrmStore(s => s.facts)
  const objectTypes = useOrmStore(s => s.objectTypes)
  const constraints = useOrmStore(s => s.constraints)
  const [filter, setFilter] = useState('')
  const [page, setPage] = useState(0)
  const [error, setError] = useState(null)

  const { shape, records, fkChecks, typeOf } = useMemo(() => {
    const st = useOrmStore.getState()
    const shape = tableShape(st, schemaId, tableId)
    if (!shape) return { shape: null, records: [], fkChecks: [] }
    // Column types as the ERD and the DDL write them (varchar(160)).
    const view = relationalView(st, schemaId)
    const typeOf = (c) => view.objects.get(`col:${c.factId}`)?.type ?? c.type
    const records = tableRecords(st, shape)
    // Foreign keys of this table: the key values each may point to.
    const model = relationalModel(st, schemaId)
    const fkChecks = model.fks.filter(fk => fk.fromTable.id === tableId).map(fk => {
      const toShape = tableShape(st, schemaId, fk.toTable.id)
      const toRecords = toShape ? tableRecords(st, toShape) : []
      const toIds = fk.to.map(c => c.fact.id)
      const keys = new Set(toRecords.map(r => JSON.stringify(toIds.map(id => r.values[id]))))
      return { name: fk.name?.name ?? 'foreign key', target: fk.toTable.name, from: fk.from.map(c => c.fact.id), keys }
    })
    return { shape, records, fkChecks, typeOf }
  }, [schemaId, tableId, populations, factPopulations, facts, objectTypes, constraints])

  if (!shape) return null
  const cols = shape.columns
  const q = filter.trim().toLowerCase()
  const shown = q ? records.filter(r => cols.some(c => String(r.values[c.factId] ?? '').toLowerCase().includes(q))) : records
  const pages = Math.max(1, Math.ceil(shown.length / PAGE))
  const pg = Math.min(page, pages - 1)
  const rows = shown.slice(pg * PAGE, pg * PAGE + PAGE)

  // What is wrong with a cell, or null.
  const problem = (r, c) => {
    const v = r.values[c.factId]
    if (v == null && c.notNull && !c.derived) return 'NOT NULL: this column needs a value'
    for (const fk of fkChecks) {
      if (!fk.from.includes(c.factId)) continue
      const vals = fk.from.map(id => r.values[id])
      if (vals.some(x => x == null)) continue
      if (!fk.keys.has(JSON.stringify(vals))) return `${fk.name}: no row of ${fk.target} has ${vals.join(', ')}`
    }
    return null
  }

  const commit = (oldCell, values) => {
    const res = useOrmStore.getState().setTableRecord(schemaId, tableId, oldCell, values)
    setError(res.error ?? null)
    return !res.error
  }
  const remove = (cell) => {
    const res = useOrmStore.getState().deleteTableRecord(schemaId, tableId, cell)
    setError(res.error ?? null)
  }

  const th = { padding: '3px 8px', textAlign: 'left', fontWeight: 600, borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap',
    position: 'sticky', top: 0, background: 'var(--bg-surface)', zIndex: 1 }
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6, color: 'var(--ink-muted)' }}>
        <span><b style={{ color: 'var(--ink)' }}>{shape.table.name}</b> · {records.length} {records.length === 1 ? 'row' : 'rows'}</span>
        {shape.readOnly && <span style={{ color: 'var(--ink-3)' }}>{shape.reason} Its records are read-only.</span>}
        <div style={{ flex: 1 }} />
        <input value={filter} onChange={e => { setFilter(e.target.value); setPage(0) }} placeholder="Filter rows…"
          style={{ fontSize: 11, padding: '2px 6px', width: 160, background: 'var(--bg-surface)', color: 'var(--ink)', border: '1px solid var(--border)', borderRadius: 3 }} />
        {pages > 1 && <span>
          <button className="rg-page" disabled={pg === 0} onClick={() => setPage(pg - 1)}>‹</button>
          {' '}{pg + 1} / {pages}{' '}
          <button className="rg-page" disabled={pg >= pages - 1} onClick={() => setPage(pg + 1)}>›</button>
        </span>}
      </div>
      {error && <div style={{ color: 'var(--danger)', marginBottom: 6 }}>{error}</div>}
      <table style={{ borderCollapse: 'collapse', fontSize: 11 }}>
        <thead>
          <tr>
            {cols.map(c => (
              <th key={c.factId} style={th} title={c.derived ? 'Derived: computed by a rule' : undefined}>
                {c.name}
                <span style={{ marginLeft: 6, fontWeight: 400, color: 'var(--ink-3)', fontFamily: 'var(--font-mono)', fontSize: 9 }}>
                  {[typeOf(c), c.pk ? 'PK' : '', fkChecks.some(f => f.from.includes(c.factId)) ? 'FK' : '', c.notNull && !c.pk ? 'NOT NULL' : '', c.derived ? 'derived' : ''].filter(Boolean).join(' ')}
                </span>
              </th>
            ))}
            <th style={{ ...th, width: 20 }} />
          </tr>
        </thead>
        <tbody>
          {rows.map(r => (
            <tr key={r.id} className="rg-row">
              {cols.map(c => (
                <Cell key={c.factId} value={r.values[c.factId]} problem={problem(r, c)}
                  readOnly={shape.readOnly || c.derived}
                  onCommit={(v) => commit(r.cell, { ...r.values, [c.factId]: v })} />
              ))}
              <td style={{ padding: '0 4px', borderBottom: '1px solid var(--border-soft)' }}>
                {!shape.readOnly && <button className="rg-delete" title="Delete this row" onClick={() => remove(r.cell)}
                  style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--ink-3)', fontSize: 11 }}>✕</button>}
              </td>
            </tr>
          ))}
          {!shape.readOnly && <NewRow cols={cols} onAdd={(values) => commit(null, values)} />}
        </tbody>
      </table>
    </div>
  )
}

const td = { padding: '2px 8px', borderBottom: '1px solid var(--border-soft)', whiteSpace: 'nowrap', maxWidth: 280, overflow: 'hidden', textOverflow: 'ellipsis' }

function Cell({ value, problem, readOnly, onCommit }) {
  const [edit, setEdit] = useState(null)
  const done = useRef(false)
  if (edit != null) {
    const finish = (ok) => {
      if (done.current) return
      done.current = true
      const keep = ok && edit !== (value ?? '') ? onCommit(edit) : true
      if (keep !== false || !ok) setEdit(null)
      else done.current = false
    }
    return (
      <td style={{ ...td, padding: 0 }}>
        <input className="rg-input" autoFocus value={edit} onChange={e => setEdit(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') finish(true); if (e.key === 'Escape') finish(false); e.stopPropagation() }}
          onBlur={() => finish(true)}
          style={{ fontSize: 11, padding: '2px 7px', width: '100%', minWidth: 80, border: '1px solid var(--accent)', background: 'var(--bg-surface)', color: 'var(--ink)' }} />
      </td>
    )
  }
  return (
    <td className="rg-cell" title={problem ?? (readOnly ? 'Read-only' : 'Click to edit')}
      onClick={() => { if (!readOnly) { done.current = false; setEdit(value ?? '') } }}
      style={{ ...td, cursor: readOnly ? 'default' : 'text', color: readOnly ? 'var(--ink-3)' : undefined,
        background: problem ? 'rgba(192,57,43,0.10)' : undefined }}>
      {value == null ? <span style={{ color: 'var(--ink-3)', fontStyle: 'italic' }}>NULL</span> : String(value)}
    </td>
  )
}

function NewRow({ cols, onAdd }) {
  const [vals, setVals] = useState({})
  const add = () => { if (onAdd(vals)) setVals({}) }
  return (
    <tr>
      {cols.map(c => (
        <td key={c.factId} style={{ ...td, padding: 0 }}>
          {c.derived ? null : (
            <input className="rg-new" value={vals[c.factId] ?? ''} placeholder={c.pk ? `${c.name} (key)` : c.name}
              onChange={e => setVals(v => ({ ...v, [c.factId]: e.target.value }))}
              onKeyDown={e => { if (e.key === 'Enter') add(); e.stopPropagation() }}
              style={{ fontSize: 11, padding: '2px 7px', width: '100%', minWidth: 80, border: '1px dashed var(--border)', background: 'transparent', color: 'var(--ink)' }} />
          )}
        </td>
      ))}
      <td style={{ padding: '0 4px' }}>
        <button className="rg-add" title="Add this row (Enter)" onClick={add}
          style={{ background: 'none', border: '1px solid var(--border)', borderRadius: 3, cursor: 'pointer', color: 'var(--ink-muted)', fontSize: 11, padding: '0 5px' }}>+</button>
      </td>
    </tr>
  )
}
