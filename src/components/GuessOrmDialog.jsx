import React, { useMemo, useState } from 'react'
import { useOrmStore } from '../store/ormStore'
import { layoutOrmDiagram } from '../layout/ormLayout'
import { plainDiagramsOf } from '../mapping/carryDiagrams.js'
import { analyseTables } from '../relational/guessOrm.js'

const FONT = 'var(--font-ui)'

const KIND_TEXT = {
  entity: 'entity type',
  subtype: 'subtype',
  junction: 'fact type (junction table)',
  nokey: 'entity type, no key',
  lookup: 'value type',
}

// Guess ORM2 schema (workbench step 9): how each table of a relational schema
// will be read, with the choice per table of keeping or dropping a surrogate
// key. Opened with store.guessOrmDialog = { relSchemaId }.
export default function GuessOrmDialog() {
  const relSchemaId = useOrmStore(s => s.guessOrmDialog?.relSchemaId ?? null)
  if (!relSchemaId) return null
  return <Dialog relSchemaId={relSchemaId} />
}

function Dialog({ relSchemaId }) {
  const close = () => useOrmStore.setState({ guessOrmDialog: null })
  const schema = useOrmStore(s => s.schemas.find(x => x.id === relSchemaId))
  const plan = useMemo(() => analyseTables(useOrmStore.getState(), relSchemaId), [relSchemaId])
  const [choice, setChoice] = useState(() => Object.fromEntries(plan.filter(p => p.surrogate).map(p => [p.table.id, p.defaultSurrogate])))
  const surrogates = plan.filter(p => p.surrogate)
  const diagramNames = useOrmStore(s => plainDiagramsOf(s, relSchemaId).map(d => d.name).join('\u0000'))
  const nDiagrams = diagramNames ? diagramNames.split('\u0000').length : 0
  const [keepDiagrams, setKeepDiagrams] = useState(true)
  const go = () => {
    close()
    useOrmStore.getState().guessOrmFromRelational(relSchemaId, { surrogates: choice, diagrams: keepDiagrams, layout: layoutOrmDiagram })
  }
  const counts = plan.reduce((m, p) => ({ ...m, [p.kind]: (m[p.kind] ?? 0) + 1 }), {})

  return (
    <div onMouseDown={e => { if (e.target === e.currentTarget) close() }}
      onKeyDown={e => { e.stopPropagation(); if (e.key === 'Escape') close() }}
      style={{ position: 'fixed', inset: 0, zIndex: 1000, background: 'rgba(0,0,0,0.25)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: FONT }}>
      <div className="guess-orm-dialog" style={{ width: 560, maxWidth: 'calc(100vw - 32px)', maxHeight: '80vh', display: 'flex', flexDirection: 'column',
        background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', boxShadow: 'var(--shadow-lg)' }}>
        <div style={{ padding: '12px 14px 8px', borderBottom: '1px solid var(--border-soft)' }}>
          <div style={{ fontWeight: 600, fontSize: 14, color: 'var(--ink-1)' }}>Guess an ORM2 schema from {schema?.name ?? 'this schema'}</div>
          <div style={{ fontSize: 12, color: 'var(--ink-2)', marginTop: 4, lineHeight: 1.45 }}>
            Makes a new ORM2 schema and a mapping to it. Tables become entity types, a primary key that is a foreign key makes a subtype,
            junction tables become many-to-many fact types, a table that only lists values becomes a value type, boolean NOT NULL
            columns become unary fact types, a type column with a list of values gives derived subtypes, and other columns and
            foreign keys become fact types read from their names.
          </div>
        </div>
        <div style={{ overflowY: 'auto', padding: '8px 14px', fontSize: 12 }}>
          <div style={{ color: 'var(--ink-2)', marginBottom: 6 }}>
            {plan.length} tables: {Object.entries(counts).map(([k, n]) => `${n} ${KIND_TEXT[k]}${n === 1 ? '' : 's'}`).join(', ')}.
          </div>
          {surrogates.length > 0 && <>
            <div style={{ fontWeight: 600, color: 'var(--ink-1)', margin: '8px 0 4px' }}>Surrogate keys</div>
            <div style={{ color: 'var(--ink-2)', marginBottom: 6, lineHeight: 1.45 }}>
              A generated key column can be dropped when the table declares a natural key (UNIQUE, NOT NULL), which then identifies the entity type.
              Otherwise it stays as the reference mode.
            </div>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <tbody>
                {surrogates.map(p => (
                  <tr key={p.table.id} style={{ borderTop: '1px solid var(--border-soft)' }}>
                    <td style={{ padding: '4px 6px 4px 0', color: 'var(--ink-1)' }}>{p.table.name}.{p.surrogate.name}</td>
                    <td style={{ padding: '4px 6px', color: 'var(--ink-2)' }}>
                      {p.naturalKey ? `natural key (${p.naturalKey.map(c => c.name).join(', ')})` : 'no natural key'}
                    </td>
                    <td style={{ padding: '4px 0', textAlign: 'right' }}>
                      <select value={choice[p.table.id]} disabled={!p.naturalKey}
                        onChange={e => setChoice(c => ({ ...c, [p.table.id]: e.target.value }))}
                        style={{ fontSize: 12, fontFamily: FONT }}>
                        <option value="keep">Keep as reference mode</option>
                        <option value="drop">Drop, identify by natural key</option>
                      </select>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>}
          <div style={{ fontWeight: 600, color: 'var(--ink-1)', margin: '10px 0 4px' }}>Tables</div>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <tbody>
              {plan.map(p => (
                <tr key={p.table.id} style={{ borderTop: '1px solid var(--border-soft)' }}>
                  <td style={{ padding: '3px 6px 3px 0', color: 'var(--ink-1)' }}>{p.table.name}</td>
                  <td style={{ padding: '3px 0', color: 'var(--ink-2)' }}>
                    {p.kind === 'junction' ? 'fact type (junction table)'
                      : p.kind === 'subtype' ? `${p.name}, subtype of the type of ${p.superTable.name}`
                      : p.kind === 'nokey' ? `${p.name} (no key: no rules)`
                      : p.kind === 'lookup' ? `value type ${p.name} (a list of values)` : p.name}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 8, padding: '10px 14px', borderTop: '1px solid var(--border-soft)' }}>
          {nDiagrams > 1 && (
            <label title={`One diagram in the new schema per diagram of ${schema?.name ?? 'this schema'} (${diagramNames.split('\u0000').join(', ')}), with what the mapping makes of its elements, laid out afresh`}
              style={{ marginRight: 'auto', display: 'flex', alignItems: 'center', gap: 5, fontSize: 12, color: 'var(--ink-2)', cursor: 'pointer' }}>
              <input type="checkbox" checked={keepDiagrams} onChange={e => setKeepDiagrams(e.target.checked)} />
              Keep the {nDiagrams} diagrams
            </label>
          )}
          <button onClick={close} style={btn(false)}>Cancel</button>
          <button onClick={go} autoFocus style={btn(true)}>Guess schema</button>
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
