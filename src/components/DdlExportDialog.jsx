import React, { useMemo } from 'react'
import { useOrmStore } from '../store/ormStore'
import { SQL_TARGETS, sqlSettings, techniqueName } from '../relational/enforcement.js'

const FONT = "'Segoe UI', Helvetica, Arial, sans-serif"
const OLD_MODE_KEY = 'freefbm.ddlExport.assertions'

// File › Export SQL DDL…: a relational schema is a relational schema in
// general, with any constraint over its tables (assertions included), so how
// the target DBMS enforces each constraint is reported here before the script
// is saved (planEnforcement, relational/enforcement.js): by the tables, as a
// CHECK or FOREIGN KEY it is rewritten to, by a trigger, as an audit query
// (a commented query returning the rows that break it), or not at all.
// The target and the trigger-or-audit choice (for all assertions, and per
// assertion) are the schema's SQL settings (store.setSchemaSql), saved in the
// file. Opened with store.ddlExportDialog = { schemaId } (useElectronMenu.js).
export default function DdlExportDialog() {
  const schemaId = useOrmStore(s => s.ddlExportDialog?.schemaId ?? null)
  if (!schemaId) return null
  return <Dialog schemaId={schemaId} />
}

// The choice the dialog made before it was kept on the schema.
const oldMode = () => { try { return localStorage.getItem(OLD_MODE_KEY) === 'comments' ? 'audit' : null } catch { return null } }

const STATUS = { enforced: 'enforced', partly: 'partly enforced', not: 'not enforced' }
const STATUS_COLOR = { enforced: 'var(--ink-3)', partly: '#a46a00', not: '#b03a2e' }

function Dialog({ schemaId }) {
  const close = () => useOrmStore.setState({ ddlExportDialog: null })
  const schema = useOrmStore(s => s.schemas.find(x => x.id === schemaId))
  const setSql = useOrmStore(s => s.setSchemaSql)
  const settings = useMemo(() => {
    const s = sqlSettings(schema)
    return schema?.sql?.assertions ? s : { ...s, assertions: oldMode() ?? s.assertions }
  }, [schema])
  const res = useMemo(() => {
    try { return useOrmStore.getState().exportSqlDdl(schemaId, { target: settings.target, assertions: settings.assertions, overrides: settings.overrides }) }
    catch (e) { return { error: e.message } }
  }, [schemaId, settings])
  const save = async () => {
    close()
    const api = window.electronAPI
    if (api?.saveSql) await api.saveSql({ defaultPath: `${(schema?.name ?? 'schema').replace(/[^A-Za-z0-9_-]+/g, '_')}${settings.target && settings.target !== 'postgresql' ? `_${settings.target}` : ''}.sql`, content: res.sql })
  }
  const items = res.plan?.items ?? []
  const warnings = res.warnings ?? []
  const assertions = items.filter(x => x.kind === 'assertion')
  const tableForm = items.filter(x => x.kind !== 'assertion' && x.kind !== 'other')
  const rewritten = tableForm.filter(x => x.technique === 'check')
  const native = tableForm.filter(x => x.technique === 'table')
  const notTable = tableForm.filter(x => x.status !== 'enforced')
  const by = (t) => items.filter(x => x.technique === t).length
  const counts = res.plan?.counts ?? { enforced: 0, partly: 0, not: 0 }
  const total = counts.enforced + counts.partly + counts.not
  const oracle = settings.target === 'oracle'
  const choosable = (x) => ['trigger', 'audit', 'assertion'].includes(x.technique) && !x.entry?.deontic && !x.viewsOnly
  const defaultName = oracle ? 'assertion if possible' : settings.assertions === 'audit' ? 'audit query' : 'trigger'

  return (
    <div onMouseDown={e => { if (e.target === e.currentTarget) close() }}
      onKeyDown={e => { e.stopPropagation(); if (e.key === 'Escape') close() }}
      style={{ position: 'fixed', inset: 0, zIndex: 1000, background: 'rgba(0,0,0,0.25)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: FONT }}>
      <div className="ddl-export-dialog" style={{ width: 640, maxWidth: 'calc(100vw - 32px)', maxHeight: '84vh', display: 'flex', flexDirection: 'column',
        background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', boxShadow: 'var(--shadow-lg)' }}>
        <div style={{ padding: '12px 14px 8px', borderBottom: '1px solid var(--border-soft)' }}>
          <div style={{ fontWeight: 600, fontSize: 14, color: 'var(--ink-1)' }}>Export {schema?.name ?? 'schema'} as SQL DDL</div>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--ink-2)', marginTop: 6 }}>
            Target
            <select value={settings.target} onChange={e => setSql(schemaId, { target: e.target.value })}
              style={{ fontSize: 12, padding: '2px 4px', border: '1px solid var(--border)', borderRadius: 3, background: 'var(--bg-raised)', color: 'var(--ink-1)' }}>
              {SQL_TARGETS.map(t => <option key={t.id} value={t.id} disabled={!t.ready}>{t.name}{t.ready ? '' : ' (later)'}</option>)}
            </select>
            <span style={{ color: 'var(--ink-3)' }}>kept with the schema</span>
          </label>
          <div style={{ fontSize: 12, color: 'var(--ink-2)', marginTop: 6, lineHeight: 1.45 }}>
            {res.error ? `The export failed: ${res.error}`
              : <>{counts.enforced} of {total} constraints are enforced{counts.partly ? `, ${counts.partly} partly` : ''}:
                {' '}{native.filter(x => x.status === 'enforced').length} by the tables, {rewritten.length + by('foreignKey')} rewritten as a CHECK or a FOREIGN KEY,
                {' '}{by('assertion') ? `${by('assertion')} by CREATE ASSERTION, ` : ''}{by('trigger')} by triggers. {by('audit')} {by('audit') === 1 ? 'is an audit query' : 'are audit queries'} (run {by('audit') === 1 ? 'it' : 'them'} to find the rows breaking {by('audit') === 1 ? 'it' : 'them'}){counts.not - by('audit') > 0 ? `, ${counts.not - by('audit')} not written` : ''}.</>}
          </div>
        </div>
        {!res.error && (
          <div style={{ overflowY: 'auto', padding: '8px 14px', fontSize: 12 }} data-text-panel className="copyable">
            {assertions.length > 0 && <>
              <div style={{ fontWeight: 600, color: 'var(--ink-1)', margin: '4px 0 4px' }}>
                {assertions.length} assertion{assertions.length === 1 ? '' : 's'} (constraints with no table form)
              </div>
              <div style={{ color: 'var(--ink-2)', marginBottom: 6, lineHeight: 1.45 }}>
                {oracle
                  ? <>Those that are a foreign key in disguise are written as one. Oracle checks the others with CREATE ASSERTION when it can:
                    no counts, aggregates or transitive closures, and only joins it can check fast (in practice along NOT NULL foreign keys);
                    those that ask for rows are checked at commit. When Oracle can't, or refuses one when the script runs, they become
                    triggers, which Oracle runs after each statement (it has no deferred triggers), or audit queries: commented queries
                    that return the rows breaking them.</>
                  : settings.target === 'sqlserver'
                  ? <>Those that are a foreign key in disguise are written as one. SQL Server has no CREATE ASSERTION and no deferred
                    triggers, so the others become triggers (AFTER INSERT, UPDATE, DELETE, raising an error with THROW) that check the
                    assertion after each statement, so an assertion that asks for rows in another table can only be met when both are
                    written in one statement, or with its triggers disabled while loading; or audit queries: commented queries that
                    return the rows breaking them.</>
                  : <>Those that are a foreign key in disguise are written as one. PostgreSQL has no CREATE ASSERTION, so the others become
                    constraint triggers, which run the assertion's query at the end of every transaction that changes a table it reads
                    (so load rows in one transaction), or audit queries: commented queries that return the rows breaking them.</>}
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 3, marginBottom: 6 }}>
                {(oracle
                  ? [['triggers', 'Where Oracle cannot assert one, enforce it with triggers'], ['audit', 'Where Oracle cannot assert one, write an audit query (not enforced)']]
                  : [['triggers', 'Enforce them with triggers'], ['audit', 'Write them as audit queries (not enforced)']]).map(([m, text]) => (
                  <label key={m} style={{ display: 'flex', alignItems: 'center', gap: 5, color: 'var(--ink-1)', cursor: 'pointer' }}>
                    <input type="radio" name="ddl-assertions" checked={settings.assertions === m} onChange={() => setSql(schemaId, { assertions: m })} />{text}
                  </label>
                ))}
              </div>
              {assertions.map(a => (
                <div key={a.rmId} data-enforcement={a.rmId} style={{ borderTop: '1px solid var(--border-soft)', padding: '4px 0' }}>
                  <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, color: 'var(--ink-1)' }}>
                    <span style={{ flex: 1, minWidth: 0 }}>{a.label}</span>
                    {choosable(a)
                      ? <select value={a.choice ?? ''} title="How this assertion is written"
                          onChange={e => setSql(schemaId, { overrides: { [a.rmId]: e.target.value || null } })}
                          style={{ fontSize: 11, padding: '1px 3px', border: '1px solid var(--border)', borderRadius: 3, background: 'var(--bg-raised)', color: 'var(--ink-1)' }}>
                          <option value="">as chosen above ({defaultName})</option>
                          <option value="trigger">{oracle ? 'assertion or trigger' : 'trigger'}</option>
                          <option value="audit">audit query</option>
                        </select>
                      : <span style={{ color: 'var(--ink-2)' }}>{techniqueName(a.technique)}</span>}
                    <span style={{ color: STATUS_COLOR[a.status], whiteSpace: 'nowrap' }}>{STATUS[a.status]}</span>
                  </div>
                  {a.note && <div style={{ color: 'var(--ink-2)' }}>{a.technique === 'foreignKey' ? `Written as FOREIGN KEY: ${a.note}` : a.note}</div>}
                  {a.entry?.text && <div style={{ color: 'var(--ink-2)', fontFamily: 'var(--font-mono, monospace)', fontSize: 11, wordBreak: 'break-word' }}>{a.entry.text}</div>}
                </div>
              ))}
            </>}
            {rewritten.length > 0 && <>
              <div style={{ fontWeight: 600, color: 'var(--ink-1)', margin: '10px 0 4px' }}>Rewritten as a CHECK</div>
              {rewritten.map(x => (
                <div key={x.rmId} style={{ borderTop: '1px solid var(--border-soft)', padding: '4px 0', color: 'var(--ink-1)' }}>{x.label}
                  <span style={{ color: 'var(--ink-3)', marginLeft: 6 }}>{x.note}</span></div>
              ))}
            </>}
            <details style={{ margin: '10px 0 4px' }}>
              <summary style={{ fontWeight: 600, color: 'var(--ink-1)', cursor: 'pointer' }}>
                {native.length} enforced by the tables (NOT NULL, keys, foreign keys, CHECKs){notTable.length ? `, ${notTable.length} on views or derived columns not` : ''}
              </summary>
              {native.concat(notTable).map(x => (
                <div key={x.rmId} style={{ borderTop: '1px solid var(--border-soft)', padding: '3px 0', color: 'var(--ink-1)', display: 'flex', gap: 6 }}>
                  <span style={{ flex: 1 }}>{x.label}</span>
                  {x.status !== 'enforced' && <span style={{ color: STATUS_COLOR[x.status] }}>{STATUS[x.status]}{x.note ? `: ${x.note}` : ''}</span>}
                </div>
              ))}
            </details>
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
