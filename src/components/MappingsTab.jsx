import React, { useEffect, useMemo, useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useOrmStore } from '../store/ormStore'
import { sideContext, sideTokens, checkRule, SIDES, sideSchemaId } from '../mapping/mapping.js'
import { PatternText, IssueList } from './MappingFormula.jsx'
import { runMapping, roundTrip } from '../mapping/runMapping.js'
import { AccountingReport, runAccounting } from './AccountingReport.jsx'
import { EquivalenceReport, runEquivalence } from './EquivalenceReport.jsx'
import { CarryPanel } from './CarryPanel.jsx'
import ViewMappings from './ViewMappings.jsx'
import Exchanges from './Exchanges.jsx'

// The mappings of the file (workbench step 7): each relates a source and a
// target schema by rules φ ⟺ ψ. Rules are edited in MappingRuleEditor.
export default function MappingsTab() {
  const state = useOrmStore(useShallow(s => ({
    schemas: s.schemas, objectTypes: s.objectTypes, facts: s.facts, constraints: s.constraints,
    subtypes: s.subtypes, mappings: s.mappings ?? [], editing: s.mappingRuleEditor,
    accounting: s.mappingAccounting ?? {}, equivalence: s.mappingEquivalence ?? {}, advanced: s.advancedMode, focus: s.mappingRuleFocus,
  })))
  const advanced = state.advanced
  // Basic mode: a rule asked for (from the canvas or the Validation panel) is
  // scrolled to and highlighted.
  const focusRef = useRef(null)
  useEffect(() => { focusRef.current?.scrollIntoView?.({ block: 'nearest' }) }, [state.focus])
  const act = useOrmStore.getState
  const schemas = state.schemas
  // The last run per mapping: { kind: 'run' | 'roundTrip', direction, result, ms } | { error }.
  const [runs, setRuns] = useState({})
  const doRun = (m, kind, direction) => {
    const full = useOrmStore.getState()
    const t0 = performance.now()
    try {
      const result = kind === 'run' ? runMapping(full, m, direction) : roundTrip(full, m, direction)
      setRuns(r => ({ ...r, [m.id]: { kind, direction, result, ms: Math.round(performance.now() - t0) } }))
    } catch (err) {
      setRuns(r => ({ ...r, [m.id]: { error: String(err?.message ?? err) } }))
    }
  }
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
      {!advanced && <div style={{ color: 'var(--ink-muted)', marginBottom: 10, lineHeight: 1.45 }}>
        Mappings come from Tables generated from… and ORM2 schema guessed from… in the schema strip's + menu, and change by Fold:
        derive the new types in a schema, then fold them in. Switch to Advanced mode (top of the tool panel) to write or edit rules by hand.
      </div>}
      {advanced && <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', marginBottom: 10 }}>
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
      </div>}

      {state.mappings.length === 0 && <div style={{ color: 'var(--ink-muted)' }}>
        No mappings yet. A mapping relates a source and a target schema by rules φ ⟺ ψ: whenever the source pattern φ matches with values $y, the target pattern ψ matches with the same values, and back.
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
              {advanced && <button style={btn} onClick={() => act().addMappingRule(m.id)}>+ Rule</button>}
              <button style={btn} title={`Build the population of ${name(m.targetSchemaId)} from that of ${name(m.sourceSchemaId)}`} onClick={() => doRun(m, 'run', 'forward')}>Run →</button>
              <button style={btn} title={`Build the population of ${name(m.sourceSchemaId)} from that of ${name(m.targetSchemaId)}`} onClick={() => doRun(m, 'run', 'backward')}>Run ←</button>
              <button style={btn} title={`Run the mapping from ${name(m.sourceSchemaId)} there and back, and compare what comes back`} onClick={() => doRun(m, 'roundTrip', 'forward')}>Round trip</button>
              <button style={btn} title={`Whether ${name(m.sourceSchemaId)} and ${name(m.targetSchemaId)} are equivalent under this mapping: no information lost either way, every constraint kept, and how many need formula constraints`} onClick={() => runEquivalence(m)}>Equivalence</button>
              <button style={btn} title={`For each constraint of either schema, whether the other schema keeps it under this mapping: native, implied, lost (with a counterexample) or unknown`} onClick={() => runAccounting(m)}>Accounting</button>
              <button style={btn} disabled={!!m.lock} title={m.lock ? 'Unlock the mapping to fold' : 'Fold the derived types and fact types of a schema into this mapping: each gets a mapping rule and becomes ordinary, and the fact types it replaces can go'} onClick={() => useOrmStore.setState({ foldDialog: { mappingId: m.id } })}>Fold…</button>
              <button className="mapping-lock" style={{ ...btn, whiteSpace: 'nowrap', ...(m.lock ? { borderColor: 'var(--accent)', color: 'var(--accent)' } : {}) }} aria-pressed={!!m.lock}
                title={m.lock ? `Unlock: ${name(m.sourceSchemaId)} and ${name(m.targetSchemaId)} can be edited freely again` : `Lock ${name(m.sourceSchemaId)} and ${name(m.targetSchemaId)} to new constraints only, and carry the constraints added to one to the other`}
                onClick={() => act().lockMapping(m.id, !m.lock)}>{m.lock ? '✓ ' : ''}Constraints only</button>
              <button style={btn} title="Delete this mapping and its rules" onClick={() => act().deleteMapping(m.id)}>Delete</button>
            </div>
            {runs[m.id] && <RunReport run={runs[m.id]} mapping={m} name={name}
              onApply={(run) => { act().applyMappingRun(run); setRuns(r => ({ ...r, [m.id]: { ...r[m.id], applied: true } })) }}
              onClose={() => setRuns(r => { const n = { ...r }; delete n[m.id]; return n })} />}
            {m.lock && <CarryPanel mapping={m} name={name} />}
            {state.equivalence[m.id] && <EquivalenceReport eq={state.equivalence[m.id]} mapping={m} name={name} />}
            {state.accounting[m.id] && <AccountingReport acc={state.accounting[m.id]} mapping={m} name={name} />}
            {rules.length === 0 && <div style={{ padding: '6px 8px', color: 'var(--ink-muted)' }}>No rules yet.</div>}
            {rules.map(({ r, issues }, k) => {
              const focused = !advanced && state.focus?.mappingId === m.id && state.focus.ruleId === r.id
              const open = (advanced && state.editing?.mappingId === m.id && state.editing.ruleId === r.id) || focused
              const toks = SIDES.map(side => sideTokens(r[side], ctxs.get(sideSchemaId(m, side)) ?? sideContext(state, null)))
              return (
                <div key={r.id} ref={focused ? focusRef : null} style={{ padding: '6px 8px', borderTop: k ? '1px solid var(--border-soft)' : 'none',
                  background: open ? 'var(--bg-raised)' : 'transparent', boxShadow: focused ? 'inset 3px 0 0 var(--accent)' : 'none' }}>
                  <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                    <span style={{ fontWeight: 600, minWidth: 60 }}>{r.name || `Rule ${k + 1}`}</span>
                    <div data-text-panel tabIndex={0} className="copyable" style={{ flex: 1, outline: 'none' }}>
                      <PatternText tokens={toks[0]} />
                      <PatternText tokens={[{ text: '  ⟺  ', kind: 'op' }]} />
                      <PatternText tokens={toks[1]} />
                    </div>
                    {advanced && <>
                      <button style={link} title="Move up" disabled={k === 0} onClick={() => act().moveMappingRule(m.id, r.id, -1)}>↑</button>
                      <button style={link} title="Move down" disabled={k === rules.length - 1} onClick={() => act().moveMappingRule(m.id, r.id, 1)}>↓</button>
                      <button style={btn} onClick={() => act().openMappingRuleEditor(m.id, r.id)}>Edit</button>
                    </>}
                    {advanced || issues.some(i => i.severity === 'error')
                      ? <button style={advanced ? link : btn} title="Delete this rule" onClick={() => act().deleteMappingRule(m.id, r.id)}>{advanced ? '×' : 'Drop rule'}</button>
                      : null}
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
      <ViewMappings />
      <Exchanges />
    </div>
  )
}

// What a run or a round trip of a mapping gave (runMapping.js).
function RunReport({ run, mapping, name, onApply, onClose }) {
  const box = { margin: '0', padding: '6px 8px 8px', borderBottom: '1px solid var(--border-soft)', background: 'var(--bg-text-panel)' }
  const btn = { fontSize: 11, padding: '2px 8px', border: '1px solid var(--border)', borderRadius: 3, background: 'var(--bg-surface)', color: 'var(--ink-2)', cursor: 'pointer' }
  const close = <button style={{ ...btn, border: 'none', background: 'none', color: 'var(--ink-muted)' }} title="Close" onClick={onClose}>×</button>
  if (run.error) return <div style={{ ...box, color: '#dc2626' }}>The run failed: {run.error} {close}</div>
  const levelColor = { error: '#dc2626', warning: '#d97706', note: 'var(--ink-muted)' }
  const LogList = ({ log }) => log.map((l, i) => <div key={i} style={{ color: levelColor[l.level] ?? 'var(--ink-muted)' }}>{l.level === 'error' ? '✕' : l.level === 'warning' ? '!' : '·'} {l.text}</div>)
  const sideName = (side) => name(side === 'source' ? mapping.sourceSchemaId : mapping.targetSchemaId)
  const cell = { padding: '1px 10px 1px 0', whiteSpace: 'nowrap' }
  const num = { ...cell, textAlign: 'right' }

  if (run.kind === 'run') {
    const r = run.result
    const total = r.counts.reduce((a, c) => a + c.n, 0)
    return (
      <div className="mapping-run" data-text-panel tabIndex={0} style={{ ...box, outline: 'none' }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 4 }}>
          <b>{sideName(r.from)} → {sideName(r.to)}</b>
          <span style={{ color: 'var(--ink-muted)' }}>{r.rules.map(x => `${x.name}: ${x.matches} match${x.matches === 1 ? '' : 'es'}`).join(' · ')} · {run.ms} ms</span>
          <div style={{ flex: 1 }} />
          {run.applied
            ? <span style={{ color: 'var(--col-candidate)' }}>✓ Applied to the population of {sideName(r.to)} (Undo takes it back)</span>
            : <button style={btn} disabled={!total} title={`Replace the sample population of ${sideName(r.to)} with this one`} onClick={() => onApply(r)}>Apply to {sideName(r.to)}</button>}
          {close}
        </div>
        {r.counts.length === 0
          ? <div style={{ color: 'var(--ink-muted)' }}>Nothing was built: no rule matched the population of {sideName(r.from)}.</div>
          : <table style={{ borderCollapse: 'collapse', fontSize: 12 }}><tbody>
            {r.counts.map(c => <tr key={c.id}><td style={cell}>{c.name}</td><td style={{ ...cell, color: 'var(--ink-muted)' }}>{c.kind === 'fact' ? 'fact type' : c.kind === 'value' ? 'value type' : 'entity type'}</td><td style={num}>{c.n}</td></tr>)}
          </tbody></table>}
        {r.log.length > 0 && <div style={{ marginTop: 4 }}><LogList log={r.log} /></div>}
      </div>
    )
  }
  const r = run.result
  const exact = r.compare.every(c => !c.lost && !c.gained)
  return (
    <div className="mapping-run" data-text-panel tabIndex={0} style={{ ...box, outline: 'none' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 4 }}>
        <b>Round trip {sideName(r.there.from)} → {sideName(r.there.to)} → {sideName(r.there.from)}</b>
        <span style={{ color: exact ? 'var(--col-candidate)' : '#d97706' }}>{exact ? '✓ everything the rules read comes back unchanged' : 'some facts change'}</span>
        <span style={{ color: 'var(--ink-muted)' }}>· {run.ms} ms · nothing is changed</span>
        <div style={{ flex: 1 }} />
        {close}
      </div>
      <table style={{ borderCollapse: 'collapse', fontSize: 12 }}>
        <thead><tr style={{ color: 'var(--ink-muted)', textAlign: 'left' }}>
          <th style={cell}>{sideName(r.there.from)}</th><th style={num}>before</th><th style={num}>after</th><th style={num}>lost</th><th style={num}>new</th><th style={cell}></th>
        </tr></thead>
        <tbody>{r.compare.map((c, i) => (
          <tr key={i}>
            <td style={cell}>{c.name}</td><td style={num}>{c.before}</td><td style={num}>{c.after}</td>
            <td style={{ ...num, color: c.lost ? '#dc2626' : undefined }}>{c.lost}</td>
            <td style={{ ...num, color: c.gained ? '#d97706' : undefined }}>{c.gained}</td>
            <td style={{ ...cell, color: 'var(--ink-muted)', whiteSpace: 'normal' }}>{c.examples.join('; ')}</td>
          </tr>
        ))}</tbody>
      </table>
      {r.uncovered.length > 0 && <div style={{ marginTop: 4, color: 'var(--ink-muted)' }}>
        Not read by any rule (not carried over): {r.uncovered.slice(0, 30).join(', ')}{r.uncovered.length > 30 ? `, and ${r.uncovered.length - 30} more` : ''}
      </div>}
      {r.log.length > 0 && <div style={{ marginTop: 4 }}><LogList log={r.log} /></div>}
    </div>
  )
}
