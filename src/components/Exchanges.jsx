import React, { useMemo, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useOrmStore } from '../store/ormStore'
import { withRunApplied } from '../mapping/runMapping.js'
import { populationSql } from '../relational/populationSql.js'
import { checkExchange, exchangeSchemas, nextSteps, runExchange, stepMapping, issueLines, groupedLines } from '../mapping/exchanges.js'

// The exchanges of the file (mapping/exchanges.js), under the views in the
// Mappings tab: chains of two-way mappings and views that carry a
// population from the first schema to the last, checked on the way, with the
// last schema's rows exported as a SQL data script.
export default function Exchanges() {
  const state = useOrmStore(useShallow(s => ({
    schemas: s.schemas, mappings: s.mappings ?? [], views: s.views ?? [], exchanges: s.exchanges ?? [],
  })))
  const act = useOrmStore.getState
  const name = (id) => state.schemas.find(s => s.id === id)?.name ?? '(deleted schema)'
  // The last run per exchange: { out, ms, applied } | { error }.
  const [runs, setRuns] = useState({})
  const doRun = (x) => {
    const t0 = performance.now()
    try {
      const out = runExchange(useOrmStore.getState(), x)
      setRuns(r => ({ ...r, [x.id]: { out, ms: Math.round(performance.now() - t0) } }))
    } catch (err) {
      setRuns(r => ({ ...r, [x.id]: { error: String(err?.message ?? err) } }))
    }
  }
  const select = { fontSize: 12, padding: '2px 4px', border: '1px solid var(--border)', borderRadius: 3, background: 'var(--bg-surface)', color: 'var(--ink)' }
  const btn = { fontSize: 11, padding: '2px 8px', border: '1px solid var(--border)', borderRadius: 3, background: 'var(--bg-surface)', color: 'var(--ink-2)', cursor: 'pointer' }
  const link = { ...btn, border: 'none', background: 'none', padding: '0 4px', color: 'var(--ink-muted)' }
  const canChain = state.mappings.length + state.views.length > 0
  return (
    <div className="exchanges" style={{ marginTop: 18 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 4 }}>
        <span style={{ fontWeight: 700 }}>Exchanges</span>
        <button style={btn} disabled={!canChain} title={canChain ? 'A chain of mappings and views, from a supplier\'s schema to a consumer\'s' : 'Make a mapping or a view first'}
          onClick={() => act().addExchange('Exchange')}>Add exchange</button>
      </div>
      {state.exchanges.length === 0 && <div style={{ color: 'var(--ink-muted)', lineHeight: 1.45 }}>
        No exchanges yet. An exchange chains mappings (either way) and views (forward), for example the supplier&apos;s tables → their ORM2
        schema ⇒ the consumer&apos;s ORM2 schema → the consumer&apos;s tables. Running it carries the population along the chain and checks it
        against each schema&apos;s constraints; the last schema&apos;s rows can be exported as SQL.
      </div>}
      {state.exchanges.map(x => <ExchangeBox key={x.id} ex={x} name={name} run={runs[x.id]} styles={{ select, btn, link }}
        onRun={() => doRun(x)} onApplied={() => setRuns(r => ({ ...r, [x.id]: { ...r[x.id], applied: true } }))}
        onCloseRun={() => setRuns(r => { const n = { ...r }; delete n[x.id]; return n })} />)}
    </div>
  )
}

function ExchangeBox({ ex, name, run, styles, onRun, onApplied, onCloseRun }) {
  const { select, btn, link } = styles
  const act = useOrmStore.getState
  const state = useOrmStore(useShallow(s => ({ schemas: s.schemas, mappings: s.mappings, views: s.views })))
  const problems = useMemo(() => checkExchange(state, ex), [state, ex])
  const schemas = useMemo(() => exchangeSchemas(state, ex), [state, ex])
  const end = schemas.length ? schemas[schemas.length - 1] : null
  const options = useMemo(() => nextSteps(state, end), [state, end])
  const [pick, setPick] = useState('')
  const add = (key) => {
    const o = options.find(x => `${x.mappingId}:${x.direction}` === key)
    if (o) act().addExchangeStep(ex.id, o)
    setPick('')
  }
  const errorFree = !problems.some(p => !/passes a schema twice/.test(p.message))
  return (
    <div className="exchange" style={{ marginBottom: 14, border: '1px solid var(--border-soft)', borderRadius: 4 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', padding: '4px 8px', background: 'var(--bg-raised)', borderBottom: '1px solid var(--border-soft)' }}>
        <input aria-label="Exchange name" value={ex.name} onChange={e => act().updateExchange(ex.id, { name: e.target.value })}
          style={{ ...select, fontWeight: 700, minWidth: 160 }} />
        <span style={{ color: 'var(--ink-muted)' }}>{schemas.length ? schemas.map(name).join(' → ') : 'no steps yet'}</span>
        <div style={{ flex: 1 }} />
        <select aria-label="Next step" value={pick} onChange={e => add(e.target.value)} style={select} disabled={!options.length}>
          <option value="">{options.length ? (end ? `+ Step from ${name(end)}…` : '+ First step…') : `Nothing leaves ${name(end)}`}</option>
          {options.map(o => <option key={`${o.mappingId}:${o.direction}`} value={`${o.mappingId}:${o.direction}`}>
            {o.name} {o.isView ? '⇒' : o.direction === 'forward' ? '→' : '←'} {name(o.to)}
          </option>)}
        </select>
        <button style={btn} disabled={!errorFree} title={`Carry the population of ${name(schemas[0])} along the chain to ${name(end)}`} onClick={onRun}>Run</button>
        <button style={btn} title="Delete this exchange (its mappings and views stay)" onClick={() => act().deleteExchange(ex.id)}>Delete</button>
      </div>
      {run && <ExchangeRunReport run={run} ex={ex} name={name} end={end} onApplied={onApplied} onClose={onCloseRun} />}
      {ex.steps.map((s, i) => {
        const sm = stepMapping(state, s)
        const own = problems.filter(p => p.step === i)
        const from = schemas[i], to = schemas[i + 1]
        return (
          <div key={i} style={{ display: 'flex', alignItems: 'baseline', gap: 8, padding: '4px 8px', borderTop: i ? '1px solid var(--border-soft)' : 'none' }}>
            <span style={{ color: 'var(--ink-muted)', minWidth: 18 }}>{i + 1}.</span>
            <span style={{ fontWeight: 600 }}>{sm ? sm.m.name : '(deleted mapping)'}</span>
            {sm && <span style={{ color: 'var(--ink-muted)' }}>
              {sm.isView ? 'view' : s.direction === 'forward' ? 'forward' : 'backward'}: {name(from)} {sm.isView ? '⇒' : '→'} {name(to)}
            </span>}
            {own.map((p, k) => <span key={k} style={{ color: '#dc2626' }}>✕ {p.message}</span>)}
            <div style={{ flex: 1 }} />
            <button style={link} title="Remove this step and the steps after it" onClick={() => act().removeExchangeStep(ex.id, i)}>×</button>
          </div>
        )
      })}
      {problems.filter(p => p.step === null && ex.steps.length).map((p, k) => <div key={k} style={{ padding: '4px 8px', color: '#d97706' }}>! {p.message}</div>)}
    </div>
  )
}

// What a run of an exchange gave (runExchange): per step its counts, log
// and the check against the schema it fills; Apply puts the last step's
// population into its schema, Export writes it as SQL.
function ExchangeRunReport({ run, ex, name, end, onApplied, onClose }) {
  const box = { padding: '6px 8px 8px', borderBottom: '1px solid var(--border-soft)', background: 'var(--bg-text-panel)' }
  const btn = { fontSize: 11, padding: '2px 8px', border: '1px solid var(--border)', borderRadius: 3, background: 'var(--bg-surface)', color: 'var(--ink-2)', cursor: 'pointer' }
  const close = <button style={{ ...btn, border: 'none', background: 'none', color: 'var(--ink-muted)' }} title="Close" onClick={onClose}>×</button>
  const act = useOrmStore.getState
  const relational = useOrmStore(s => s.schemas.find(x => x.id === end)?.profile === 'relational')
  const [exported, setExported] = useState(null)
  if (run.error) return <div style={{ ...box, color: '#dc2626' }}>The run failed: {run.error} {close}</div>
  const { out } = run
  const levelColor = { error: '#dc2626', warning: '#d97706', note: 'var(--ink-muted)' }
  const tgt = name(end)
  const doExport = async (format) => {
    const st = act()
    // The rows as the run left them (the same as applied, if it was).
    const s = run.applied ? st : { ...st, ...withRunApplied(st, out.result) }
    const res = populationSql(s, end, { format, header: `Rows of ${tgt}, made by the exchange ${ex.name} in FreeFBM.` })
    const fileName = `${tgt.replace(/[^A-Za-z0-9_-]+/g, '_')}-rows.sql`
    const api = window.electronAPI
    let path = fileName
    if (api?.saveSql) path = await api.saveSql({ defaultPath: fileName, content: res.sql })
    else {
      const a = document.createElement('a')
      a.href = URL.createObjectURL(new Blob([res.sql], { type: 'text/plain' })); a.download = fileName; a.click()
    }
    if (path) setExported({ path, tables: res.tables, notes: res.notes })
  }
  return (
    <div className="exchange-run" data-text-panel tabIndex={0} style={{ ...box, outline: 'none' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 4, flexWrap: 'wrap' }}>
        <b>{ex.name}</b>
        <span style={{ color: 'var(--ink-muted)' }}>{out.steps.length} step{out.steps.length === 1 ? '' : 's'} · {run.ms} ms</span>
        <div style={{ flex: 1 }} />
        {out.ok && (run.applied
          ? <span style={{ color: 'var(--col-candidate)' }}>✓ Applied to the population of {tgt} (Undo takes it back)</span>
          : <button style={btn} title={`Replace the sample population of ${tgt} with the result`} onClick={() => { act().applyExchangeRun(out.result); onApplied() }}>Apply to {tgt}</button>)}
        {out.ok && relational && <>
          <button style={btn} title={`The rows of ${tgt} as INSERT statements, parents before children`} onClick={() => doExport('insert')}>Export INSERT…</button>
          <button style={btn} title={`The rows of ${tgt} as COPY … FROM stdin blocks`} onClick={() => doExport('copy')}>Export COPY…</button>
        </>}
        {close}
      </div>
      {exported && <div style={{ color: 'var(--col-candidate)', marginBottom: 4 }}>
        ✓ Wrote {exported.tables.reduce((a, t) => a + t.rows, 0)} rows of {exported.tables.length} tables to {exported.path}
        {exported.notes.map((n, i) => <div key={i} style={{ color: '#d97706' }}>! {n}</div>)}
      </div>}
      {out.steps.map(s => <StepReport key={s.index} step={s} name={name} levelColor={levelColor} />)}
    </div>
  )
}

function StepReport({ step: s, name, levelColor }) {
  const [open, setOpen] = useState(false)
  const state = useOrmStore.getState()
  const lines = useMemo(() => issueLines(state, s.issues ?? [], s.to), [s])
  const total = (s.counts ?? []).reduce((a, c) => a + c.n, 0)
  const errs = (s.log ?? []).filter(l => l.level === 'error')
  return (
    <div style={{ padding: '3px 0', borderTop: s.index ? '1px dashed var(--border-soft)' : 'none' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
        <span style={{ color: 'var(--ink-muted)' }}>{s.index + 1}.</span>
        <b>{s.name}</b>
        <span style={{ color: 'var(--ink-muted)' }}>{name(s.from)} {s.isView ? '⇒' : '→'} {name(s.to)}: {total} instances and facts</span>
        {s.error
          ? <span style={{ color: '#dc2626' }}>✕ {s.error}</span>
          : lines.length
            ? <span style={{ color: '#dc2626' }}>✕ {lines.length} violation{lines.length === 1 ? '' : 's'} of {name(s.to)}&apos;s constraints</span>
            : <span style={{ color: 'var(--col-candidate)' }}>✓ meets {name(s.to)}&apos;s constraints</span>}
        {errs.length > 0 && <span style={{ color: '#dc2626' }}>· {errs.length} rule error{errs.length === 1 ? '' : 's'}</span>}
        <button style={{ fontSize: 11, border: 'none', background: 'none', color: 'var(--ink-muted)', cursor: 'pointer' }} onClick={() => setOpen(o => !o)}>{open ? 'Less' : 'Details'}</button>
      </div>
      {open && <div style={{ marginLeft: 22 }}>
        {(s.counts ?? []).length > 0 && <div style={{ color: 'var(--ink-muted)' }}>{s.counts.map(c => `${c.name}: ${c.n}`).join(' · ')}</div>}
        {(s.log ?? []).map((l, i) => <div key={i} style={{ color: levelColor[l.level] ?? 'var(--ink-muted)' }}>{l.level === 'error' ? '✕' : '!'} {l.text}</div>)}
        <Violations lines={lines} />
      </div>}
    </div>
  )
}

// Violations, those of one kind about one element together ("and 346 more
// like it").
export function Violations({ lines, limit = 30 }) {
  const groups = useMemo(() => groupedLines(lines), [lines])
  return <>
    {groups.slice(0, limit).map((g, i) => <div key={i} style={{ color: '#dc2626' }}>
      ✕ {g.text}{g.more > 0 && <span style={{ color: 'var(--ink-muted)' }}> (and {g.more} more like it)</span>}
    </div>)}
    {groups.length > limit && <div style={{ color: 'var(--ink-muted)' }}>… and {groups.length - limit} more kinds</div>}
  </>
}
