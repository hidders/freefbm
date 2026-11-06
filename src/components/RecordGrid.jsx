// The Population tab of a relational schema showing its tables (RM schemas
// first-class, step 3): the records of one table as a grid, one row per
// record and one column per table column (relational/records.js). Stored
// tables are edited in place as in a fact type's population: every cell is an
// input, Enter or leaving it commits, Esc cancels; "+ Add tuple" adds an empty
// row that becomes a record once its key is filled in; × deletes one. Views
// and derived columns are computed and read-only. Cells that break NOT NULL or
// a foreign key are marked.

import React, { useMemo, useState, useEffect, useRef } from 'react'
import { useOrmStore } from '../store/ormStore'
import { activeSchemaIdOf } from '../store/storeHelpers'
import { relationalView } from '../relational/relationalView'
import { relationalModel } from '../relational/relationalModel'
import { tableShape, tableRecords } from '../relational/records'
import { TableIcon } from './RelationalBrowser'
import { selectedTableId } from '../relational/rmText'
import { removeBtnStyle, removeBtnHandlers, addBtnStyle, issueCellStyle } from './populationStyles'

const PAGE = 200
// Values offered in a foreign key column's list (the referenced rows' values).
const MAX_OPTIONS = 2000
// Rows added with "+ Add tuple" that are not records yet (no key, or a key
// that was refused), per table, so they survive switching tables.
const draftsByTable = new Map()
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
  const [drafts, setDraftsState] = useState(() => draftsByTable.get(tableId) ?? [])
  const setDrafts = (f) => setDraftsState(ds => {
    const next = typeof f === 'function' ? f(ds) : f
    if (next.length) draftsByTable.set(tableId, next); else draftsByTable.delete(tableId)
    return next
  })
  // Key values of a record just added from a draft: its page is shown.
  const [added, setAdded] = useState(null)

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
      // Per referencing column, the values of its referenced column.
      const options = {}
      fk.from.forEach((c, i) => {
        const vals = new Set()
        for (const r of toRecords) { const v = r.values[toIds[i]]; if (v != null) vals.add(String(v)) }
        options[c.fact.id] = [...vals].sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).slice(0, MAX_OPTIONS)
      })
      return { name: fk.name?.name ?? 'foreign key', target: fk.toTable.name, from: fk.from.map(c => c.fact.id), keys, options }
    })
    return { shape, records, fkChecks, typeOf }
  }, [schemaId, tableId, populations, factPopulations, facts, objectTypes, constraints])

  if (!shape) return null
  const cols = shape.columns
  const fkOptions = {}
  for (const fk of fkChecks) Object.assign(fkOptions, fk.options)
  const listId = (fid) => `rg-fk-${tableId}-${fid}`
  const q = filter.trim().toLowerCase()
  const shown = q ? records.filter(r => cols.some(c => String(r.values[c.factId] ?? '').toLowerCase().includes(q))) : records
  const pages = Math.max(1, Math.ceil(shown.length / PAGE))
  if (added) {
    const i = shown.findIndex(r => shape.keyFacts.every((f, j) => String(r.values[f] ?? '') === added[j]))
    if (i >= 0 && Math.floor(i / PAGE) !== page) setPage(Math.floor(i / PAGE))
    setAdded(null)
  }
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

  // Returns the error, or null when the record was written.
  const commit = (oldCell, values) => {
    const res = useOrmStore.getState().setTableRecord(schemaId, tableId, oldCell, values)
    setError(res.error ?? null)
    return res.error ?? null
  }
  // A draft row is kept until its key columns have values, then it is added
  // as a record (the other columns go with it, empty ones as NULL). A key the
  // table refuses (one it has already) stays on the draft, marked.
  const commitDraft = (d, c, v) => {
    const values = { ...d.values, [c.factId]: v }
    const keyed = cols.filter(k => k.pk).every(k => String(values[k.factId] ?? '').trim() !== '')
    let err = null
    if (keyed) {
      const res = useOrmStore.getState().setTableRecord(schemaId, tableId, null, values)
      err = res.error ?? null
      setError(err)
    }
    if (keyed && !err) {
      setDrafts(ds => ds.filter(x => x.id !== d.id))
      setAdded(shape.keyFacts.map(f => String(values[f] ?? '').trim()))
    } else setDrafts(ds => ds.map(x => x.id === d.id ? { ...x, values, error: err } : x))
    return null
  }
  const remove = (cell) => {
    const res = useOrmStore.getState().deleteTableRecord(schemaId, tableId, cell)
    setError(res.error ?? null)
  }

  const th = { padding: '3px 8px', textAlign: 'left', fontWeight: 600, borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap', verticalAlign: 'top',
    position: 'sticky', top: -12, background: 'var(--bg-surface)', zIndex: 1 } // -12: the panel's padding
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
      {Object.entries(fkOptions).map(([fid, vals]) => (
        <datalist key={fid} id={listId(fid)}>{vals.map(v => <option key={v} value={v} />)}</datalist>
      ))}
      <table style={{ borderCollapse: 'collapse', fontSize: 11 }}>
        <thead>
          <tr>
            {cols.map(c => (
              <th key={c.factId} style={th} title={c.derived ? 'Derived: computed by a rule' : undefined}>
                <div>{c.name}</div>
                <div style={{ fontWeight: 400, color: 'var(--ink-3)', fontFamily: 'var(--font-mono)', fontSize: 9 }}>{typeOf(c) || '\u00a0'}</div>
                <div style={{ fontWeight: 400, color: 'var(--ink-3)', fontFamily: 'var(--font-mono)', fontSize: 9 }}>
                  {[c.pk ? 'PK' : '', fkChecks.some(f => f.from.includes(c.factId)) ? 'FK' : '', c.notNull && !c.pk ? 'NOT NULL' : '', c.derived ? 'derived' : ''].filter(Boolean).join(' ') || '\u00a0'}
                </div>
              </th>
            ))}
            <th style={{ ...th, width: 20 }} />
          </tr>
        </thead>
        <tbody>
          {rows.map(r => (
            <tr key={r.id}>
              {cols.map(c => (
                <td key={c.factId} style={td}>
                  <Cell value={r.values[c.factId]} problem={problem(r, c)} list={fkOptions[c.factId] ? listId(c.factId) : undefined}
                    readOnly={shape.readOnly || c.derived}
                    onCommit={(v) => commit(r.cell, { ...r.values, [c.factId]: v })} />
                </td>
              ))}
              <td style={td}>
                {!shape.readOnly && <button onClick={() => remove(r.cell)} {...removeBtnHandlers}
                  style={removeBtnStyle} title="Remove record" aria-label="Remove record">×</button>}
              </td>
            </tr>
          ))}
          {drafts.map(d => (
            <tr key={d.id}>
              {cols.map(c => (
                <td key={c.factId} style={td}>
                  <Cell value={d.values[c.factId]} readOnly={c.derived} list={fkOptions[c.factId] ? listId(c.factId) : undefined}
                    problem={d.error && c.pk ? d.error : null}
                    placeholder={c.pk ? 'key' : ''}
                    onCommit={(v) => commitDraft(d, c, v)} />
                </td>
              ))}
              <td style={td}>
                <button onClick={() => setDrafts(ds => ds.filter(x => x.id !== d.id))} {...removeBtnHandlers}
                  style={removeBtnStyle} title="Remove tuple" aria-label="Remove tuple">×</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {drafts.filter(d => d.error).map(d => (
        <div key={d.id} style={{ color: 'var(--danger)', margin: '2px 0 4px' }}>{d.error} The new row is kept until its key is changed.</div>
      ))}
      {!shape.readOnly && <button style={{ ...addBtnStyle, marginTop: 4 }}
        onClick={() => { setError(null); setDrafts(ds => [...ds, { id: `draft-${Date.now()}-${ds.length}`, values: {} }]) }}>+ Add tuple</button>}
    </div>
  )
}

const td = { padding: '0 4px 4px 0', verticalAlign: 'middle' }
const inputStyle = { width: '100%', minWidth: 60, boxSizing: 'border-box' }
const readOnlyStyle = { color: 'var(--ink-2)', background: 'var(--bg-surface)' }

// One cell: an input like a fact type population's, committed on Enter or
// blur, or when the grid goes away while it is being edited (Esc restores the
// stored value). A value the table refuses stays in the cell, marked with the
// reason. NULL shows as a placeholder; a foreign key column offers the values
// of the referenced rows.
function Cell({ value, problem, readOnly, placeholder, list, onCommit }) {
  const stored = value == null ? '' : String(value)
  const [text, setText] = useState(stored)
  const [refused, setRefused] = useState(null)
  const focused = useRef(false)
  const live = useRef({})
  live.current = { text, stored, onCommit }
  useEffect(() => { if (!focused.current) { setText(stored); setRefused(null) } }, [stored])
  useEffect(() => () => {
    const { text, stored, onCommit } = live.current
    if (focused.current && text !== stored) onCommit(text)
  }, [])
  const finish = () => {
    focused.current = false
    if (text === stored) { setRefused(null); return }
    setRefused(onCommit(text) ?? null)
  }
  const issue = refused ?? problem
  return (
    <input value={text} disabled={readOnly} list={readOnly ? undefined : list}
      placeholder={value == null && !readOnly ? (placeholder || 'NULL') : (value == null ? 'NULL' : undefined)}
      title={issue ?? (readOnly ? 'Read-only' : undefined)}
      className={issue ? 'cell-issue' : undefined}
      onFocus={() => { focused.current = true }}
      onChange={e => setText(e.target.value)}
      onKeyDown={e => {
        if (e.key === 'Enter') e.currentTarget.blur()
        if (e.key === 'Escape') { focused.current = false; live.current.text = stored; setText(stored); setRefused(null); const t = e.currentTarget; setTimeout(() => t.blur()) }
        e.stopPropagation()
      }}
      onBlur={() => { if (focused.current) finish() }}
      style={{ ...inputStyle, ...(readOnly ? readOnlyStyle : null), ...(issue ? issueCellStyle : null) }} />
  )
}
