import React, { useMemo, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useOrmStore } from '../store/ormStore'
import { sideContext, sideTokens, checkRule, SIDES, sideSchemaId } from '../mapping/mapping.js'
import { PatternText, IssueList } from './MappingFormula.jsx'

// The mappings of the file (workbench step 7): each relates a source and a
// target schema by rules φ ⟺ ψ. Rules are edited in MappingRuleEditor.
export default function MappingsTab() {
  const state = useOrmStore(useShallow(s => ({
    schemas: s.schemas, objectTypes: s.objectTypes, facts: s.facts, constraints: s.constraints,
    subtypes: s.subtypes, mappings: s.mappings ?? [], editing: s.mappingRuleEditor,
  })))
  const act = useOrmStore.getState
  const schemas = state.schemas
  const [src, setSrc] = useState(schemas[0]?.id ?? '')
  const [tgt, setTgt] = useState(schemas[1]?.id ?? schemas[0]?.id ?? '')
  const name = (id) => schemas.find(s => s.id === id)?.name ?? '(deleted schema)'
  const valid = (id) => schemas.some(s => s.id === id)
  const srcId = valid(src) ? src : schemas[0]?.id
  const tgtId = valid(tgt) ? tgt : (schemas[1] ?? schemas[0])?.id

  // One context per schema, shared by every rule.
  const ctxs = useMemo(() => {
    const m = new Map()
    for (const s of schemas) m.set(s.id, sideContext(state, s.id))
    return m
  }, [state, schemas])

  const select = { fontSize: 12, padding: '2px 4px', border: '1px solid var(--border)', borderRadius: 3, background: 'var(--bg-surface)', color: 'var(--ink)' }
  const btn = { fontSize: 11, padding: '2px 8px', border: '1px solid var(--border)', borderRadius: 3, background: 'var(--bg-surface)', color: 'var(--ink-2)', cursor: 'pointer' }
  const link = { ...btn, border: 'none', background: 'none', padding: '0 4px', color: 'var(--ink-muted)' }

  return (
    <div style={{ fontSize: 12, color: 'var(--ink)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', marginBottom: 10 }}>
        <span style={{ color: 'var(--ink-muted)' }}>New mapping from</span>
        <select aria-label="Source schema" value={srcId} onChange={e => setSrc(e.target.value)} style={select}>
          {schemas.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
        <span style={{ color: 'var(--ink-muted)' }}>to</span>
        <select aria-label="Target schema" value={tgtId} onChange={e => setTgt(e.target.value)} style={select}>
          {schemas.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
        <button style={btn} onClick={() => act().addMapping(srcId, tgtId, `${name(srcId)} to ${name(tgtId)}`)}>Add</button>
        {schemas.length < 2 && <span style={{ color: 'var(--ink-muted)' }}>A mapping usually relates two schemas: add one in the schema strip, or import PostgreSQL DDL.</span>}
      </div>

      {state.mappings.length === 0 && <div style={{ color: 'var(--ink-muted)' }}>
        No mappings yet. A mapping relates a source and a target schema by rules φ ⟺ ψ: whenever the source pattern φ matches with values ŷ, the target pattern ψ matches with the same values, and back.
      </div>}

      {state.mappings.map(m => {
        const issueCount = { error: 0, warning: 0 }
        const rules = m.rules.map(r => {
          const issues = checkRule(r, m, state, { source: ctxs.get(m.sourceSchemaId), target: ctxs.get(m.targetSchemaId) })
          for (const i of issues) issueCount[i.severity]++
          return { r, issues }
        })
        return (
          <div key={m.id} style={{ marginBottom: 14, border: '1px solid var(--border-soft)', borderRadius: 4 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 8px', background: 'var(--bg-raised)', borderBottom: '1px solid var(--border-soft)' }}>
              <input aria-label="Mapping name" value={m.name} onChange={e => act().updateMapping(m.id, { name: e.target.value })}
                style={{ ...select, fontWeight: 700, minWidth: 160 }} />
              <span style={{ color: 'var(--ink-muted)' }}>{name(m.sourceSchemaId)} → {name(m.targetSchemaId)}</span>
              <span style={{ color: 'var(--ink-muted)' }}>· {m.rules.length} rule{m.rules.length === 1 ? '' : 's'}
                {issueCount.error > 0 && <span style={{ color: '#dc2626' }}> · {issueCount.error} error{issueCount.error === 1 ? '' : 's'}</span>}
                {issueCount.warning > 0 && <span style={{ color: '#d97706' }}> · {issueCount.warning} warning{issueCount.warning === 1 ? '' : 's'}</span>}
              </span>
              <div style={{ flex: 1 }} />
              <button style={btn} title="Show this mapping as a diagram: both schemas side by side, each rule linked to its elements" onClick={() => act().openMappingDiagram(m.id)}>Diagram</button>
              <button style={btn} onClick={() => act().addMappingRule(m.id)}>+ Rule</button>
              <button style={btn} title="Delete this mapping and its rules" onClick={() => act().deleteMapping(m.id)}>Delete</button>
            </div>
            {rules.length === 0 && <div style={{ padding: '6px 8px', color: 'var(--ink-muted)' }}>No rules yet.</div>}
            {rules.map(({ r, issues }, k) => {
              const open = state.editing?.mappingId === m.id && state.editing.ruleId === r.id
              const toks = SIDES.map(side => sideTokens(r[side], ctxs.get(sideSchemaId(m, side)) ?? sideContext(state, null)))
              return (
                <div key={r.id} style={{ padding: '6px 8px', borderTop: k ? '1px solid var(--border-soft)' : 'none',
                  background: open ? 'var(--bg-raised)' : 'transparent' }}>
                  <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                    <span style={{ fontWeight: 600, minWidth: 60 }}>{r.name || `Rule ${k + 1}`}</span>
                    <div data-text-panel tabIndex={0} className="copyable" style={{ flex: 1, outline: 'none' }}>
                      <PatternText tokens={toks[0]} />
                      <PatternText tokens={[{ text: '  ⟺  ', kind: 'op' }]} />
                      <PatternText tokens={toks[1]} />
                    </div>
                    <button style={link} title="Move up" disabled={k === 0} onClick={() => act().moveMappingRule(m.id, r.id, -1)}>↑</button>
                    <button style={link} title="Move down" disabled={k === rules.length - 1} onClick={() => act().moveMappingRule(m.id, r.id, 1)}>↓</button>
                    <button style={btn} onClick={() => act().openMappingRuleEditor(m.id, r.id)}>Edit</button>
                    <button style={link} title="Delete this rule" onClick={() => act().deleteMappingRule(m.id, r.id)}>×</button>
                  </div>
                  {issues.length > 0 && <div data-text-panel tabIndex={0} className="copyable" style={{ marginTop: 3, marginLeft: 68, outline: 'none' }}>
                    <IssueList issues={issues} />
                  </div>}
                </div>
              )
            })}
          </div>
        )
      })}
    </div>
  )
}
