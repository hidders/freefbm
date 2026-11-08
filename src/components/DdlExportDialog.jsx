import React, { useMemo } from 'react'
import { useOrmStore } from '../store/ormStore'

const FONT = "'Segoe UI', Helvetica, Arial, sans-serif"

// File › Export PostgreSQL DDL…: a relational schema is a relational schema in
// general, with any constraint over its tables (assertions included), so what
// PostgreSQL itself can't enforce is reported here, before the script is
// saved: the assertions the script writes as queries that return the rows
// breaking them, and what it can't write at all (ddlExport.js warnings).
// Opened with store.ddlExportDialog = { schemaId } (useElectronMenu.js).
export default function DdlExportDialog() {
  const schemaId = useOrmStore(s => s.ddlExportDialog?.schemaId ?? null)
  if (!schemaId) return null
  return <Dialog schemaId={schemaId} />
}

function Dialog({ schemaId }) {
  const close = () => useOrmStore.setState({ ddlExportDialog: null })
  const schema = useOrmStore(s => s.schemas.find(x => x.id === schemaId))
  const res = useMemo(() => {
    try { return useOrmStore.getState().exportPostgresDdl(schemaId) } catch (e) { return { error: e.message } }
  }, [schemaId])
  const save = async () => {
    close()
    const api = window.electronAPI
    if (api?.saveSql) await api.saveSql({ defaultPath: `${(schema?.name ?? 'schema').replace(/[^A-Za-z0-9_-]+/g, '_')}.sql`, content: res.sql })
  }
  const assertions = res.assertions ?? []
  const warnings = res.warnings ?? []

  return (
    <div onMouseDown={e => { if (e.target === e.currentTarget) close() }}
      onKeyDown={e => { e.stopPropagation(); if (e.key === 'Escape') close() }}
      style={{ position: 'fixed', inset: 0, zIndex: 1000, background: 'rgba(0,0,0,0.25)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: FONT }}>
      <div className="ddl-export-dialog" style={{ width: 580, maxWidth: 'calc(100vw - 32px)', maxHeight: '80vh', display: 'flex', flexDirection: 'column',
        background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', boxShadow: 'var(--shadow-lg)' }}>
        <div style={{ padding: '12px 14px 8px', borderBottom: '1px solid var(--border-soft)' }}>
          <div style={{ fontWeight: 600, fontSize: 14, color: 'var(--ink-1)' }}>Export {schema?.name ?? 'schema'} as PostgreSQL DDL</div>
          <div style={{ fontSize: 12, color: 'var(--ink-2)', marginTop: 4, lineHeight: 1.45 }}>
            {res.error ? `The export failed: ${res.error}`
              : 'PostgreSQL can’t enforce everything this schema says. The script lists the following in comments; the rest is created as tables, keys, foreign keys and CHECKs.'}
          </div>
        </div>
        {!res.error && (
          <div style={{ overflowY: 'auto', padding: '8px 14px', fontSize: 12 }} data-text-panel className="copyable">
            {assertions.length > 0 && <>
              <div style={{ fontWeight: 600, color: 'var(--ink-1)', margin: '4px 0 4px' }}>
                {assertions.length} assertion{assertions.length === 1 ? '' : 's'}, not enforced
              </div>
              <div style={{ color: 'var(--ink-2)', marginBottom: 6, lineHeight: 1.45 }}>
                PostgreSQL has no assertions (CREATE ASSERTION). Each is written as a query that returns the rows breaking it,
                so it can be checked by hand or in a trigger.
              </div>
              {assertions.map((a, i) => (
                <div key={i} style={{ borderTop: '1px solid var(--border-soft)', padding: '4px 0' }}>
                  <div style={{ color: 'var(--ink-1)' }}>{a.label}{a.deontic ? ' (deontic)' : ''}</div>
                  {a.text && <div style={{ color: 'var(--ink-2)', fontFamily: 'var(--font-mono, monospace)', fontSize: 11, wordBreak: 'break-word' }}>{a.text}</div>}
                </div>
              ))}
            </>}
            {warnings.length > 0 && <>
              <div style={{ fontWeight: 600, color: 'var(--ink-1)', margin: '10px 0 4px' }}>Not enforced or not written</div>
              {warnings.map((w, i) => (
                <div key={i} style={{ borderTop: '1px solid var(--border-soft)', padding: '4px 0', color: 'var(--ink-1)', wordBreak: 'break-word' }}>{w}</div>
              ))}
            </>}
          </div>
        )}
        <div style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 8, padding: '10px 14px', borderTop: '1px solid var(--border-soft)' }}>
          <button onClick={close} style={btn(false)}>Cancel</button>
          {!res.error && <button onClick={save} autoFocus style={btn(true)}>Save script…</button>}
        </div>
      </div>
    </div>
  )
}

const btn = (primary) => ({
  fontFamily: FONT, fontSize: 12, padding: '5px 12px', borderRadius: 4, cursor: 'pointer',
  border: `1px solid ${primary ? 'var(--accent)' : 'var(--border)'}`,
  background: primary ? 'var(--accent)' : 'var(--bg-surface)', color: primary ? '#fff' : 'var(--ink-1)',
})
