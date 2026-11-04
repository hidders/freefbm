import React, { useMemo, useState } from 'react'
import { useOrmStore } from '../store/ormStore'
import { planRelational } from '../relational/rmap.js'
import { handEdited } from '../mapping/regenerate.js'

const FONT = "'Segoe UI', Helvetica, Arial, sans-serif"

const MODE_TEXT = {
  never: 'Never: natural keys only',
  composite: 'For composite identifiers',
  always: 'Always',
}

// Generate tables (workbench step 13): the tables Rmap makes of an ORM2
// schema, with the choice of surrogate keys (decision Q4: never, composite
// identifiers only, or always, overridable per entity type). Opened with
// store.generateRelationalDialog = { ormSchemaId }.
export default function GenerateRelationalDialog() {
  const ormSchemaId = useOrmStore(s => s.generateRelationalDialog?.ormSchemaId ?? null)
  const regen = useOrmStore(s => s.generateRelationalDialog?.regenerate ?? null)
  if (!ormSchemaId) return null
  return <Dialog ormSchemaId={ormSchemaId} regen={regen} />
}

// With regen (a mapping id), the choices start as that mapping's generator
// kept them, and the tables replace its target schema in place.
function Dialog({ ormSchemaId, regen }) {
  const close = () => useOrmStore.setState({ generateRelationalDialog: null })
  const schema = useOrmStore(s => s.schemas.find(x => x.id === ormSchemaId))
  const { kept, target, edited } = useMemo(() => {
    const st = useOrmStore.getState()
    const m = regen ? st.mappings.find(x => x.id === regen) : null
    return { kept: m?.generator?.options ?? null, target: m ? st.schemas.find(x => x.id === m.targetSchemaId) : null, edited: m ? handEdited(st, m) : false }
  }, [regen])
  const [mode, setMode] = useState(kept?.surrogates ?? 'never')
  const [overrides, setOverrides] = useState(kept?.overrides ?? {})
  const { plan, error } = useMemo(() => {
    try { return { plan: planRelational(useOrmStore.getState(), ormSchemaId, { surrogates: mode, overrides }) }
    } catch (err) { return { error: `The tables could not be planned: ${err?.message ?? err}` } }
  }, [ormSchemaId, mode, overrides])
  const go = () => {
    close()
    useOrmStore.getState().generateRelationalFromOrm(ormSchemaId, { surrogates: mode, overrides, regenerate: regen })
  }
  const typeName = (id) => plan?.ctx.otById.get(id)?.name ?? plan?.ctx.factById.get(id)?.objectifiedName ?? '?'
  const entityOf = (t) => (t.typeId ? plan.entities.get(t.typeId) : null)
  const describe = (t) => {
    if (t.kind === 'fact') return 'fact type'
    const e = entityOf(t)
    const nested = plan.ctx.factById.get(t.typeId)?.objectified
    if (t.kind === 'subtype') return `subtype ${typeName(t.typeId)} of ${typeName(e.superId)}`
    return `${nested ? 'objectified fact type' : 'entity type'} ${typeName(t.typeId)}`
  }
  const notes = (plan?.log ?? []).filter(l => !/^\d+ tables:/.test(l.text))
  const counts = plan ? plan.tables.reduce((m, t) => ({ ...m, [t.kind]: (m[t.kind] ?? 0) + 1 }), {}) : {}

  return (
    <div onMouseDown={e => { if (e.target === e.currentTarget) close() }}
      onKeyDown={e => { e.stopPropagation(); if (e.key === 'Escape') close() }}
      style={{ position: 'fixed', inset: 0, zIndex: 1000, background: 'rgba(0,0,0,0.25)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: FONT }}>
      <div className="generate-relational-dialog" style={{ width: 640, maxWidth: 'calc(100vw - 32px)', maxHeight: '80vh', display: 'flex', flexDirection: 'column',
        background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', boxShadow: 'var(--shadow-lg)' }}>
        <div style={{ padding: '12px 14px 8px', borderBottom: '1px solid var(--border-soft)' }}>
          <div style={{ fontWeight: 600, fontSize: 14, color: 'var(--ink-1)' }}>{regen ? `Regenerate ${target?.name ?? 'the tables'} from` : 'Generate tables from'} {schema?.name ?? 'this schema'}</div>
          <div style={{ fontSize: 12, color: 'var(--ink-2)', marginTop: 4, lineHeight: 1.45 }}>
            {regen ? 'Makes the tables again' : 'Makes a new relational schema and a mapping to it'}, the way Rmap does: functional fact types go into the table of
            the entity type they describe, other fact types get tables of their own, and a subtype's table shares its supertype's key.
            The population, if any, is carried over.
          </div>
        </div>
        <div style={{ overflowY: 'auto', padding: '8px 14px', fontSize: 12 }}>
          {error && <div style={{ color: 'var(--danger)' }}>{error}</div>}
          {regen && <div style={{ color: 'var(--ink-2)', margin: '2px 0 8px', lineHeight: 1.45 }}>
            Makes {target?.name ?? 'the schema'} again in place, with these choices: elements that come back keep their places on its diagram,
            and other mappings and diagrams that name them still do.
            {edited && <div style={{ color: '#b45309', marginTop: 4 }}>
              ⚠ {target?.name ?? 'The schema'} or its mapping was changed by hand since it was generated. Regenerating replaces those changes.
            </div>}
          </div>}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '2px 0 8px' }}>
            <span style={{ fontWeight: 600, color: 'var(--ink-1)' }}>Surrogate keys</span>
            <select value={mode} onChange={e => { setMode(e.target.value); setOverrides({}) }} style={{ fontSize: 12, fontFamily: FONT }}>
              {Object.entries(MODE_TEXT).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </div>
          <div style={{ color: 'var(--ink-2)', marginBottom: 6, lineHeight: 1.45 }}>
            A surrogate is an integer identity column; the natural key stays as UNIQUE NOT NULL and references go through the surrogate.
            Tick or untick a table to override the choice for its entity type.
          </div>
          {plan && <>
            <div style={{ fontWeight: 600, color: 'var(--ink-1)', margin: '10px 0 4px' }}>
              {plan.tables.length} tables{plan.tables.length ? `: ${['entity', 'subtype', 'fact'].filter(k => counts[k]).map(k => `${counts[k]} for ${k === 'entity' ? 'entity types' : k === 'subtype' ? 'subtypes' : 'fact types'}`).join(', ')}` : ''}
            </div>
            <div style={{ color: 'var(--ink-3)', fontSize: 11, marginBottom: 4 }}>Each table with its columns and their types: the primary key underlined, columns that may be NULL in italics.</div>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <tbody>
                {plan.tables.map(t => {
                  const e = entityOf(t)
                  const canSurrogate = t.kind === 'entity' && e && !plan.ctx.factById.get(t.typeId)?.objectified
                  return (
                    <tr key={t.name} style={{ borderTop: '1px solid var(--border-soft)', verticalAlign: 'top' }}>
                      <td style={{ padding: '3px 6px 3px 0', width: 18 }}>
                        {canSurrogate && (
                          <input type="checkbox" title="Surrogate key" checked={!!e.surrogate} style={{ width: 'auto', margin: 0 }}
                            onChange={() => setOverrides(o => ({ ...o, [t.typeId]: !e.surrogate }))}/>
                        )}
                      </td>
                      <td style={{ padding: '3px 6px 3px 0', color: 'var(--ink-1)', whiteSpace: 'nowrap' }}>{t.name}</td>
                      <td style={{ padding: '3px 0', color: 'var(--ink-2)' }}>
                        <div>{describe(t)}</div>
                        <div style={{ fontFamily: 'var(--font-mono, monospace)', fontSize: 11, color: 'var(--ink-3)' }}>
                          {t.columns.map((c, i) => (
                            <span key={c.name}>{i ? ', ' : ''}<span title={c.notNull ? 'NOT NULL' : 'may be NULL'}
                              style={{ ...(t.pk.includes(c.name) ? { textDecoration: 'underline', color: 'var(--ink-2)' } : null), ...(!c.notNull ? { fontStyle: 'italic' } : null) }}>{c.name}</span>
                              {c.sql && <span style={{ opacity: 0.75 }}> {c.sql}</span>}</span>
                          ))}
                        </div>
                        {t.fks.length > 0 && <div style={{ fontFamily: 'var(--font-mono, monospace)', fontSize: 11, color: 'var(--ink-3)' }}>
                          {t.fks.map((fk, i) => <span key={i}>{i ? ', ' : ''}FOREIGN KEY ({fk.cols.join(', ')}) → {plan.entities.get(fk.refTypeId)?.table ?? typeName(fk.refTypeId)}</span>)}
                        </div>}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
            {notes.length > 0 && <>
              <div style={{ fontWeight: 600, color: 'var(--ink-1)', margin: '10px 0 4px' }}>Notes</div>
              <ul className="copyable" style={{ margin: 0, paddingLeft: 18, color: 'var(--ink-2)', lineHeight: 1.45 }}>
                {notes.map((l, i) => <li key={i} style={{ listStyle: l.level === 'warn' ? '"⚠  "' : 'disc' }}>{l.text}</li>)}
              </ul>
            </>}
          </>}
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, padding: '10px 14px', borderTop: '1px solid var(--border-soft)' }}>
          <button onClick={close} style={btn(false)}>Cancel</button>
          <button onClick={go} disabled={!plan?.tables.length} autoFocus style={{ ...btn(true), opacity: plan?.tables.length ? 1 : 0.5 }}>{regen ? 'Regenerate' : 'Generate tables'}</button>
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
