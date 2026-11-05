import React, { useMemo, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useOrmStore } from '../store/ormStore'
import { makeContext } from '../logic/constraintFormulas.js'
import { checkViewRule, viewRuleEntries, viewCoverage, viewState, runView, headId, elementName } from '../mapping/views.js'
import { IssueList } from './MappingFormula.jsx'
import { resultIssues, issueLines } from '../mapping/exchanges.js'
import { Violations } from './Exchanges.jsx'
import { ContractReport, runContract } from './ContractReport.jsx'
import { withRunApplied } from '../mapping/runMapping.js'
import { Formula, Sentence } from './ConstraintsTab.jsx'
import { useVerbalisation } from '../verbalisation/workbench.js'

// The view mappings of the file (mapping/views.js), under the two-way
// mappings in the Mappings tab: each defines elements of a target schema by
// queries over a source schema, and runs one way, from source to target.
export default function ViewMappings() {
  const state = useOrmStore(useShallow(s => ({
    schemas: s.schemas, objectTypes: s.objectTypes, facts: s.facts, constraints: s.constraints,
    subtypes: s.subtypes, views: s.views ?? [], editing: s.ruleEditor, language: s.viewLanguage,
  })))
  const verbaliser = useVerbalisation(state.language)
  // Rules as sentences, formulas or both, kept per user.
  const [show, setShowRaw] = useState(() => { try { return localStorage.getItem(SHOW_KEY) || 'sentences' } catch { return 'sentences' } })
  const setShow = (v) => { setShowRaw(v); try { localStorage.setItem(SHOW_KEY, v) } catch { /* not kept */ } }
  const act = useOrmStore.getState
  const schemas = state.schemas
  const [src, setSrc] = useState(schemas[0]?.id ?? '')
  const [tgt, setTgt] = useState(schemas[1]?.id ?? schemas[0]?.id ?? '')
  const valid = (id) => schemas.some(s => s.id === id)
  const srcId = valid(src) ? src : schemas[0]?.id
  const tgtId = valid(tgt) ? tgt : (schemas[1] ?? schemas[0])?.id
  const name = (id) => schemas.find(s => s.id === id)?.name ?? '(deleted schema)'
  // The last run per view: { result, ms, applied } | { error }.
  const [runs, setRuns] = useState({})
  const doRun = (v) => {
    const t0 = performance.now()
    try {
      const st = useOrmStore.getState()
      const result = runView(st, v)
      // The result checked against the target's constraints.
      const issues = issueLines(st, resultIssues({ ...st, ...withRunApplied(st, result) }, v.targetSchemaId), v.targetSchemaId)
      setRuns(r => ({ ...r, [v.id]: { result, issues, ms: Math.round(performance.now() - t0) } }))
    } catch (err) {
      setRuns(r => ({ ...r, [v.id]: { error: String(err?.message ?? err) } }))
    }
  }

  const select = { fontSize: 12, padding: '2px 4px', border: '1px solid var(--border)', borderRadius: 3, background: 'var(--bg-surface)', color: 'var(--ink)' }
  const btn = { fontSize: 11, padding: '2px 8px', border: '1px solid var(--border)', borderRadius: 3, background: 'var(--bg-surface)', color: 'var(--ink-2)', cursor: 'pointer' }
  const link = { ...btn, border: 'none', background: 'none', padding: '0 4px', color: 'var(--ink-muted)' }

  return (
    <div className="view-mappings" style={{ marginTop: 18 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 4 }}>
        <span style={{ fontWeight: 700 }}>Views</span>
        {state.views.length > 0 && <span role="radiogroup" aria-label="Show view rules as" style={{ display: 'inline-flex', border: '1px solid var(--border-soft)', borderRadius: 10, overflow: 'hidden' }}>
          {[['sentences', 'Sentences'], ['formulas', 'Formulas'], ['both', 'Both']].map(([id, label], i) => (
            <button key={id} type="button" role="radio" aria-checked={show === id} onClick={() => setShow(id)} style={{
              fontSize: 10, padding: '1px 9px', cursor: 'pointer', border: 'none', borderLeft: i ? '1px solid var(--border-soft)' : 'none',
              background: show === id ? 'var(--bg-text-panel)' : 'transparent', color: show === id ? 'var(--accent)' : 'var(--ink-muted)', fontWeight: show === id ? 600 : 400,
            }}>{label}</button>
          ))}
        </span>}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', marginBottom: 10 }}>
        <span style={{ color: 'var(--ink-muted)' }}>New view from</span>
        <select aria-label="View source schema" value={srcId} onChange={e => setSrc(e.target.value)} style={select}>
          {schemas.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
        <span style={{ color: 'var(--ink-muted)' }}>to</span>
        <select aria-label="View target schema" value={tgtId} onChange={e => setTgt(e.target.value)} style={select}>
          {schemas.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
        <button style={btn} disabled={srcId === tgtId} title={srcId === tgtId ? 'A view reads one schema and defines another' : undefined}
          onClick={() => act().addView(srcId, tgtId, `${name(srcId)} as ${name(tgtId)}`)}>Add view</button>
      </div>
      {state.views.length === 0 && <div style={{ color: 'var(--ink-muted)', lineHeight: 1.45 }}>
        No views yet. A view runs one way: each of its rules defines an element of the target schema, an entity type through its
        reference values or a fact type, by a query over the source schema. Running it builds the target's population from the source's.
      </div>}
      {state.views.map(v => <ViewBox key={v.id} view={v} state={state} name={name} run={runs[v.id]}
        onRun={() => doRun(v)} onApplied={() => setRuns(r => ({ ...r, [v.id]: { ...r[v.id], applied: true } }))}
        onCloseRun={() => setRuns(r => { const n = { ...r }; delete n[v.id]; return n })}
        styles={{ select, btn, link }} show={show} language={verbaliser.language} />)}
    </div>
  )
}

const SHOW_KEY = 'freefbm.views.show'

function ViewBox({ view: v, state, name, run, onRun, onApplied, onCloseRun, styles, show, language }) {
  const { select, btn, link } = styles
  const act = useOrmStore.getState
  const vs = useMemo(() => viewState(state, v), [state, v])
  const ctx = useMemo(() => makeContext(vs), [vs])
  const rules = useMemo(() => v.rules.map(r => ({ r, issues: checkViewRule(state, v, r), entries: viewRuleEntries(state, v, r) })), [state, v])
  const coverage = useMemo(() => viewCoverage(state, v), [state, v])
  const count = { error: 0, warning: 0 }
  for (const { issues } of rules) for (const i of issues) count[i.severity]++
  const label = (id) => elementName((state.objectTypes ?? []).find(o => o.id === id) ?? (state.facts ?? []).find(f => f.id === id), state, ctx)
  // Elements of the target that may get a rule: those without one.
  const candidates = useMemo(() => coverage.map(c => ({ ...c, label: label(c.elementId) }))
    .sort((a, b) => (a.kind === b.kind ? a.label.localeCompare(b.label) : a.kind === 'type' ? -1 : 1)), [coverage])
  const [pick, setPick] = useState('')
  const add = (id) => {
    const c = candidates.find(x => x.elementId === id)
    if (c) act().addViewRule(v.id, c.kind === 'fact' ? { factId: id } : { typeId: id })
    setPick('')
  }
  const missingErrors = coverage.filter(c => c.severity === 'error')
  const contract = useOrmStore(s => s.viewContracts?.[v.id])
  return (
    <div className="view-mapping" style={{ marginBottom: 14, border: '1px solid var(--border-soft)', borderRadius: 4 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', padding: '4px 8px', background: 'var(--bg-raised)', borderBottom: '1px solid var(--border-soft)' }}>
        <input aria-label="View name" value={v.name} onChange={e => act().updateView(v.id, { name: e.target.value })}
          style={{ ...select, fontWeight: 700, minWidth: 160 }} />
        <span style={{ color: 'var(--ink-muted)' }}>{name(v.sourceSchemaId)} ⇒ {name(v.targetSchemaId)} (one way)</span>
        <span style={{ color: 'var(--ink-muted)' }}>· {v.rules.length} rule{v.rules.length === 1 ? '' : 's'}
          {count.error > 0 && <span style={{ color: '#dc2626' }}> · {count.error} error{count.error === 1 ? '' : 's'}</span>}
          {count.warning > 0 && <span style={{ color: '#d97706' }}> · {count.warning} warning{count.warning === 1 ? '' : 's'}</span>}
        </span>
        <div style={{ flex: 1 }} />
        <select aria-label="Element to define" value={pick} onChange={e => add(e.target.value)} style={select} disabled={!candidates.length}>
          <option value="">{candidates.length ? '+ Rule for…' : 'Every element has a rule'}</option>
          {candidates.map(c => <option key={c.elementId} value={c.elementId}>{c.label}{c.kind === 'fact' ? '' : ' (type)'}</option>)}
        </select>
        <button style={btn} title="Show this view as a diagram: both schemas side by side, each rule linked to the elements it reads and defines" onClick={() => act().openViewDiagram(v.id)}>Diagram</button>
        <button style={btn} title={`Build the population of ${name(v.targetSchemaId)} from that of ${name(v.sourceSchemaId)}`} onClick={onRun}>Run ⇒</button>
        <button style={btn} title={`Check which constraints of ${name(v.targetSchemaId)} the constraints of ${name(v.sourceSchemaId)} guarantee through this view, and what the supplier must also guarantee`} onClick={() => runContract(v)}>Contract</button>
        <button style={btn} title="Delete this view and its rules" onClick={() => act().deleteView(v.id)}>Delete</button>
      </div>
      {contract && <ContractReport contract={contract} view={v} name={name} />}
      {run && <ViewRunReport run={run} view={v} name={name} onApply={() => { act().applyView(v.id); onApplied() }} onClose={onCloseRun} />}
      {rules.length === 0 && <div style={{ padding: '6px 8px', color: 'var(--ink-muted)' }}>No rules yet: pick an element of {name(v.targetSchemaId)} under + Rule for….</div>}
      {rules.map(({ r, issues, entries }, k) => {
        const open = state.editing?.viewId === v.id && state.editing.ruleId === r.id
        return (
          <div key={r.id} style={{ padding: '6px 8px', borderTop: k ? '1px solid var(--border-soft)' : 'none', background: open ? 'var(--bg-raised)' : 'transparent' }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
              <span style={{ fontWeight: 600, minWidth: 140 }}>{label(headId(r))}</span>
              <div data-text-panel tabIndex={0} className="copyable" style={{ flex: 1, outline: 'none', minWidth: 0 }}>
                {entries.filter(e => e.formula).map(e => <React.Fragment key={e.key}>
                  {show !== 'formulas' && <Sentence formula={e.formula} ctx={ctx} language={language} />}
                  {show !== 'sentences' && <div style={show === 'both' ? { opacity: 0.75, fontSize: 11 } : undefined}><Formula formula={e.formula} ctx={ctx} /></div>}
                </React.Fragment>)}
                {!entries.some(e => e.formula) && <span style={{ color: 'var(--ink-muted)' }}>No formula yet.</span>}
              </div>
              <button style={btn} onClick={() => act().openViewRuleEditor(v.id, r.id)}>Edit</button>
              <button style={link} title="Delete this rule" onClick={() => act().deleteViewRule(v.id, r.id)}>×</button>
            </div>
            {issues.length > 0 && <div data-text-panel tabIndex={0} className="copyable" style={{ marginTop: 3, marginLeft: 148, outline: 'none' }}>
              <IssueList issues={issues.map(i => ({ severity: i.severity, text: i.message }))} />
            </div>}
          </div>
        )
      })}
      {v.rules.length > 0 && coverage.length > 0 && <div data-text-panel tabIndex={0} className="copyable" style={{ padding: '6px 8px', borderTop: '1px solid var(--border-soft)', color: 'var(--ink-muted)', outline: 'none', lineHeight: 1.45 }}>
        {missingErrors.length > 0 && <div style={{ color: '#dc2626' }}>✕ No rule, but a mandatory role (the view leaves it empty): {missingErrors.map(c => label(c.elementId)).join(', ')}</div>}
        {coverage.length > missingErrors.length && <div>Not defined by this view (left empty): {coverage.filter(c => c.severity !== 'error').map(c => label(c.elementId)).join(', ')}</div>}
      </div>}
    </div>
  )
}

// What a run of a view gave (runView).
function ViewRunReport({ run, view, name, onApply, onClose }) {
  const box = { padding: '6px 8px 8px', borderBottom: '1px solid var(--border-soft)', background: 'var(--bg-text-panel)' }
  const btn = { fontSize: 11, padding: '2px 8px', border: '1px solid var(--border)', borderRadius: 3, background: 'var(--bg-surface)', color: 'var(--ink-2)', cursor: 'pointer' }
  const close = <button style={{ ...btn, border: 'none', background: 'none', color: 'var(--ink-muted)' }} title="Close" onClick={onClose}>×</button>
  if (run.error) return <div style={{ ...box, color: '#dc2626' }}>The run failed: {run.error} {close}</div>
  const r = run.result
  const levelColor = { error: '#dc2626', warning: '#d97706', note: 'var(--ink-muted)' }
  const cell = { padding: '1px 10px 1px 0', whiteSpace: 'nowrap' }
  const tgt = name(view.targetSchemaId)
  const total = r.counts.reduce((a, c) => a + c.n, 0)
  return (
    <div className="view-run" data-text-panel tabIndex={0} style={{ ...box, outline: 'none' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 4 }}>
        <b>{name(view.sourceSchemaId)} ⇒ {tgt}</b>
        <span style={{ color: 'var(--ink-muted)' }}>{r.rules.map(x => `${x.name}: ${x.error ? 'error' : x.n}`).join(' · ')} · {run.ms} ms</span>
        <div style={{ flex: 1 }} />
        {run.applied
          ? <span style={{ color: 'var(--col-candidate)' }}>✓ Applied to the population of {tgt} (Undo takes it back)</span>
          : <button style={btn} disabled={!total} title={`Replace the sample population of ${tgt} with this one`} onClick={onApply}>Apply to {tgt}</button>}
        {close}
      </div>
      {r.counts.length === 0
        ? <div style={{ color: 'var(--ink-muted)' }}>Nothing was built from the population of {name(view.sourceSchemaId)}.</div>
        : <table style={{ borderCollapse: 'collapse', fontSize: 12 }}><tbody>
          {r.counts.map(c => <tr key={c.id}><td style={cell}>{c.name}</td><td style={{ ...cell, color: 'var(--ink-muted)' }}>{c.kind === 'fact' ? 'fact type' : c.kind === 'value' ? 'value type' : 'entity type'}</td><td style={{ ...cell, textAlign: 'right' }}>{c.n}</td></tr>)}
        </tbody></table>}
      {total > 0 && (run.issues?.length
        ? <div style={{ marginTop: 4 }}>
          <div style={{ color: '#dc2626' }}>✕ The result breaks {run.issues.length === 1 ? 'a constraint' : `constraints ${run.issues.length} times`} of {tgt}:</div>
          <div style={{ marginLeft: 14 }}><Violations lines={run.issues} /></div>
        </div>
        : <div style={{ marginTop: 4, color: 'var(--col-candidate)' }}>✓ The result meets the constraints of {tgt}.</div>)}
      {r.log.length > 0 && <div style={{ marginTop: 4 }}>{r.log.map((l, i) => <div key={i} style={{ color: levelColor[l.level] ?? 'var(--ink-muted)' }}>{l.level === 'error' ? '✕' : '!'} {l.text}</div>)}</div>}
    </div>
  )
}
