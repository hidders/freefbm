// Constraints only, and carrying them across (RM schemas first-class, step 5;
// mapping/pairLock.js, mapping/carry.js). Shown under a locked mapping in the
// Mappings tab: the constraints either schema got since the lock, whether
// the other schema keeps each, and for each it loses the simplest constraint
// that would keep it there (in table terms for a relational schema), with
// Add; and, for a relational side, the ALTER TABLE script for what it got.

import React, { useState } from 'react'
import { useOrmStore } from '../store/ormStore'
import { carrySteps, changeScript } from '../mapping/carry.js'
import { useVerbalisation } from '../verbalisation/workbench.js'
import { Sentence } from './ConstraintsTab'
import { RmSentence } from './RelationalConstraints.jsx'

const btn = { fontSize: 11, padding: '2px 8px', border: '1px solid var(--border)', borderRadius: 3, background: 'var(--bg-surface)', color: 'var(--ink-2)', cursor: 'pointer' }
const note = { fontSize: 11, color: 'var(--ink-2)' }
const mono = { fontFamily: 'var(--font-mono)', fontSize: 11.5, lineHeight: 1.5, whiteSpace: 'pre-wrap', userSelect: 'text' }

export function CarryPanel({ mapping, name }) {
  const [report, setReport] = useState(null)   // { running, done, total } | { items, ctxs } | { error }
  const [script, setScript] = useState(false)
  const viewLanguage = useOrmStore(s => s.viewLanguage)
  const { language } = useVerbalisation(viewLanguage)
  const sideName = (side) => name(side === 'source' ? mapping.sourceSchemaId : mapping.targetSchemaId)
  const other = (side) => (side === 'source' ? 'target' : 'source')
  const relSides = ['source', 'target'].filter(side => {
    const sid = side === 'source' ? mapping.sourceSchemaId : mapping.targetSchemaId
    return useOrmStore.getState().schemas.find(s => s.id === sid)?.profile === 'relational'
  })

  const run = () => {
    const steps = carrySteps(useOrmStore.getState(), mapping)
    setReport({ running: true, done: 0, total: 0 })
    const tick = () => {
      const t0 = performance.now()
      try {
        for (;;) {
          const r = steps.next()
          if (r.done) { setReport(r.value); return }
          if (performance.now() - t0 > 40) { setReport({ running: true, ...r.value }); setTimeout(tick, 0); return }
        }
      } catch (err) { setReport({ error: String(err?.message ?? err) }) }
    }
    setTimeout(tick, 0)
  }

  const box = { padding: '6px 8px 8px', borderBottom: '1px solid var(--border-soft)', background: 'var(--bg-text-panel)' }
  return (
    <div className="carry-panel" style={box}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <span style={{ fontWeight: 700, fontSize: 11 }}>Constraints only</span>
        <span style={note}>
          {sideName('source')} and {sideName('target')} take new constraints but no other edits, so the rules stay valid.
          Add constraints to either one, then carry them to the other.
        </span>
        <div style={{ flex: 1 }} />
        <button className="carry-run" style={btn} onClick={run} disabled={report?.running}
          title="Check the constraints added since the lock against the other schema, and propose what keeps each one there">
          {report?.running ? `Checking ${report.done}/${report.total || '…'}` : 'Carry constraints…'}</button>
        {relSides.length > 0 && <button className="carry-script" style={btn} onClick={() => setScript(v => !v)}
          title="The ALTER TABLE statements for what the relational schema got since the lock">{script ? 'Hide' : 'Change script'}</button>}
      </div>
      {script && relSides.map(side => <ChangeScript key={side} mapping={mapping} side={side} name={sideName(side)} />)}
      {report?.error && <div style={{ ...note, color: 'var(--danger)', marginTop: 4 }}>The check failed: {report.error}</div>}
      {report?.items && (report.items.length === 0
        ? <div style={{ ...note, marginTop: 4, fontStyle: 'italic' }}>Neither schema has new constraints since the lock.</div>
        : <div style={{ marginTop: 4 }}>
            {report.items.map(it => <CarryItem key={`${it.side}:${it.x.key}`} it={it} ctx={report.ctxs?.[it.side]} language={language}
              here={sideName(it.side)} there={sideName(other(it.side))} mapping={mapping} />)}
          </div>)}
    </div>
  )
}

function CarryItem({ it, ctx, language, here, there, mapping }) {
  const [added, setAdded] = useState(false)
  const { x, proposal: p } = it
  const keptNow = x.status === 'native' || x.status === 'implied'
  const add = () => {
    const st = useOrmStore.getState()
    const sid = it.side === 'source' ? mapping.targetSchemaId : mapping.sourceSchemaId
    if (p.kind === 'simple') st.addSimpleConstraint(sid, p.simple)
    else st.addCarriedConstraint(p.carry.schemaId, { rule: p.carry.rule, deontic: p.carry.deontic, graphical: p.carry.graphical })
    setAdded(true)
  }
  const proposalKept = p && !p.error && (p.status === 'native' || p.status === 'implied')
  return (
    <div className="carry-item" style={{ display: 'flex', gap: 8, padding: '4px 0', borderTop: '1px solid var(--border-soft)' }}>
      <span style={{ flex: '0 0 60px', fontSize: 10, fontWeight: 700, paddingTop: 3, textTransform: 'uppercase', letterSpacing: '0.04em',
        color: keptNow || added ? 'var(--col-candidate)' : '#dc2626' }}>{keptNow ? 'kept' : added ? 'carried' : 'not kept'}</span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 10, color: 'var(--ink-muted)', letterSpacing: '0.04em' }}>New in {here}{x.label ? '' : ` · ${x.entry.kind}${x.entry.subject ? ` · ${x.entry.subject}` : ''}`}</div>
        {x.label ? <><div style={{ ...mono, fontSize: 12 }}>{x.label}</div>{x.rm ? <RmSentence schemaId={x.rm.schemaId} rmId={x.rm.rmId} fallback={x.sentence} /> : x.sentence && <div style={{ fontSize: 13, lineHeight: 1.5 }}>{x.sentence}</div>}</>
          : <Sentence formula={x.entry.formula} ctx={ctx} language={language} />}
        {keptNow && <div style={note}>{there} already keeps it ({x.status}).</div>}
        {!keptNow && p?.error && <div style={note}>It can't be carried to {there}: {p.error}.</div>}
        {!keptNow && p && !p.error && (
          <div style={{ marginTop: 3, paddingLeft: 10, borderLeft: '2px solid var(--accent)' }}>
            <div style={note}>In {there} it would be {p.kind === 'simple' ? 'this' : p.carry.graphical ? 'this constraint with join paths' : 'this formula constraint'}:</div>
            {p.rm?.length > 0
              ? p.rm.map(o => (
                <div key={o.rmId} style={mono}>
                  {o.label}{o.sql && o.kind !== 'assertion' ? `  ${o.sql}` : ''}
                  {o.kind === 'assertion' && <span style={note}>  (an assertion)</span>}
                </div>))
              : p.entry?.formula ? <Sentence formula={p.entry.formula} ctx={p.ctx} language={language} /> : null}
            {p.rm?.length > 0 && (p.rm.some(o => o.sentence)
              ? p.rm.filter(o => o.sentence).map(o => <RmSentence key={o.rmId} schemaId={it.side === 'source' ? mapping.targetSchemaId : mapping.sourceSchemaId} rmId={null} fallback={o.sentence} />)
              : p.entry?.formula && <div style={{ opacity: 0.8 }}><Sentence formula={p.entry.formula} ctx={p.ctx} language={language} /></div>)}
            <div style={{ ...note, marginTop: 2 }}>{proposalKept ? `Checked: with it, ${there} keeps the constraint.` : `Checked: with it, the constraint is still ${p.status ?? 'unknown'}.`}</div>
            <div style={{ marginTop: 3 }}>
              {added ? <span style={{ ...note, color: 'var(--col-candidate)' }}>Added to {there}.</span>
                : <button className="carry-add" style={btn} onClick={add} disabled={p.kind === 'translation' && p.carry.errors?.length > 0}>Add to {there}</button>}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

function ChangeScript({ mapping, side, name }) {
  const sid = side === 'source' ? mapping.sourceSchemaId : mapping.targetSchemaId
  useOrmStore(s => s.constraints)
  useOrmStore(s => s.facts)
  const text = changeScript(useOrmStore.getState(), mapping, sid)
  return (
    <div style={{ marginTop: 4 }}>
      <div style={note}>{name}, since the lock:</div>
      {text ? <pre className="carry-sql" style={{ ...mono, margin: '2px 0', padding: 6, background: 'var(--bg-surface)', border: '1px solid var(--border-soft)', borderRadius: 3 }}>{text}</pre>
        : <div style={{ ...note, fontStyle: 'italic' }}>Nothing new yet.</div>}
      {text && <div style={note}>Rows that break a new constraint are listed under it in the Constraints tab; fix them before running the script.</div>}
    </div>
  )
}
