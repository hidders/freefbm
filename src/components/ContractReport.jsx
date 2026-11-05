import React, { useState } from 'react'
import { useOrmStore } from '../store/ormStore'
import { contractSteps, CONTRACT_ORDER } from '../mapping/contract.js'
import { Sentence } from './ConstraintsTab.jsx'
import { useVerbalisation } from '../verbalisation/workbench.js'

// The contract check of a view (data exchange step 4, mapping/contract.js):
// for each constraint of the view's target, whether the source's constraints
// guarantee it through the views, or what the supplier must also guarantee.
// The result lives in store.viewContracts[viewId] (not saved, not part of
// undo): { running, done, total } while it runs, then { result } or { error }.

export const CONTRACT_STATUS = {
  mustGuarantee: { label: 'supplier must guarantee', color: '#dc2626', title: 'A population of the source that meets its constraints gives, through the views, one that breaks this constraint' },
  unknown:       { label: 'not decided', color: 'var(--ink-muted)', title: 'The check could not decide, or constraints of this kind are not checked yet' },
  guaranteed:    { label: 'guaranteed', color: 'var(--col-candidate)', title: 'Every population of the source that meets its constraints gives one that meets this constraint' },
}

const setContract = (viewId, value) => useOrmStore.setState(s => {
  const next = { ...(s.viewContracts ?? {}) }
  if (value) next[viewId] = value
  else delete next[viewId]
  return { viewContracts: next }
})

// Runs the check in slices, so the window stays responsive.
export function runContract(view) {
  const token = {}
  const steps = contractSteps(useOrmStore.getState(), view)
  setContract(view.id, { running: true, done: 0, total: 0, token })
  const tick = () => {
    if (useOrmStore.getState().viewContracts?.[view.id]?.token !== token) return
    const t0 = performance.now()
    try {
      for (;;) {
        const r = steps.next()
        if (r.done) { setContract(view.id, { result: r.value, at: Date.now() }); return }
        if (performance.now() - t0 > 40) { setContract(view.id, { running: true, ...r.value, token }); setTimeout(tick, 0); return }
      }
    } catch (err) {
      setContract(view.id, { error: String(err?.message ?? err) })
    }
  }
  setTimeout(tick, 0)
}

export function ContractReport({ contract: c, view, name }) {
  const viewLanguage = useOrmStore(s => s.viewLanguage)
  const { language } = useVerbalisation(viewLanguage)
  const [showAll, setShowAll] = useState(false)
  const [added, setAdded] = useState({})
  const box = { padding: '6px 8px 8px', borderBottom: '1px solid var(--border-soft)', background: 'var(--bg-text-panel)' }
  const btn = { fontSize: 11, padding: '2px 8px', border: '1px solid var(--border)', borderRadius: 3, background: 'var(--bg-surface)', color: 'var(--ink-2)', cursor: 'pointer' }
  const close = <button style={{ ...btn, border: 'none', background: 'none', color: 'var(--ink-muted)' }} title="Close" onClick={() => setContract(view.id, null)}>×</button>
  const src = name(view.sourceSchemaId), tgt = name(view.targetSchemaId)
  if (c.error) return <div style={{ ...box, color: '#dc2626' }}>The contract check failed: {c.error} {close}</div>
  if (c.running) {
    const pct = c.total ? Math.round(100 * c.done / c.total) : 0
    return (
      <div style={{ ...box, display: 'flex', alignItems: 'center', gap: 8 }}>
        <b>Contract</b>
        <span style={{ color: 'var(--ink-muted)' }}>checking constraint {c.done} of {c.total || '…'}</span>
        <div style={{ width: 160, height: 5, background: 'var(--border-soft)', borderRadius: 3 }}>
          <div style={{ width: `${pct}%`, height: '100%', background: 'var(--accent)', borderRadius: 3 }} />
        </div>
        <button style={btn} onClick={() => setContract(view.id, null)}>Stop</button>
      </div>
    )
  }
  const r = c.result
  const count = r.results.reduce((m, x) => ({ ...m, [x.status]: (m[x.status] ?? 0) + 1 }), {})
  const sorted = [...r.results].sort((a, b) => CONTRACT_ORDER.indexOf(a.status) - CONTRACT_ORDER.indexOf(b.status))
  const shown = showAll ? sorted : sorted.filter(x => x.status !== 'guaranteed')
  const tctx = r.ctxs.target, sctx = r.ctxs.source
  const sentence = (entry, ctx, text) => (text
    ? <div style={{ fontSize: 13, lineHeight: 1.5 }}>{text}</div>
    : entry?.formula ? <Sentence formula={entry.formula} ctx={ctx} language={language} /> : <span style={{ color: 'var(--ink-muted)' }}>(no sentence)</span>)
  return (
    <div className="view-contract" data-text-panel tabIndex={0} style={{ ...box, outline: 'none' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 6, flexWrap: 'wrap' }}>
        <b>Contract: {src} ⇒ {tgt}</b>
        <span style={{ color: 'var(--ink-muted)' }}>
          {r.results.length} constraints of {tgt} ·{' '}
          {CONTRACT_ORDER.filter(st => count[st]).map((st, i) => <React.Fragment key={st}>{i > 0 && ' · '}<span style={{ color: CONTRACT_STATUS[st].color }}>{count[st]} {CONTRACT_STATUS[st].label}</span></React.Fragment>)}
          {' · '}{r.ms} ms
        </span>
        <div style={{ flex: 1 }} />
        <label style={{ color: 'var(--ink-muted)', fontSize: 11 }}><input type="checkbox" checked={showAll} onChange={e => setShowAll(e.target.checked)} /> show guaranteed ones too</label>
        {close}
      </div>
      {!count.mustGuarantee && !count.unknown && <div style={{ color: 'var(--col-candidate)', marginBottom: 4 }}>
        ✓ The constraints of {src} guarantee every constraint of {tgt} through the views: any population that meets {src}&apos;s constraints gives one that meets {tgt}&apos;s.
      </div>}
      {r.notes.map((n, i) => <div key={i} style={{ color: '#d97706' }}>! {n}</div>)}
      {shown.map(x => {
        const st = CONTRACT_STATUS[x.status]
        const p = x.proposal
        return (
          <div key={x.key} style={{ padding: '5px 0', borderTop: '1px dashed var(--border-soft)' }}>
            <div style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}>
              <span title={st.title} style={{ color: st.color, fontSize: 11, minWidth: 150, fontWeight: 600 }}>{st.label}</span>
              <div style={{ flex: 1, minWidth: 0 }}>
                {sentence(x.entry, tctx, null)}
                <div style={{ color: 'var(--ink-muted)', fontSize: 11 }}>{x.label ? `${x.label} · ` : ''}{x.entry?.kind} · {x.reason}</div>
                {x.by?.length > 0 && <div style={{ fontSize: 11, marginTop: 2 }}>
                  <span style={{ color: 'var(--ink-muted)' }}>By {src}:</span>
                  {x.by.map(b => <div key={b.key} style={{ marginLeft: 12 }}>{sentence(b.entry, sctx, b.sentence)}</div>)}
                </div>}
                {x.counterexample && <div style={{ fontSize: 11, marginTop: 3 }}>
                  <div style={{ color: 'var(--ink-muted)' }}>For example, this population of {src} meets its constraints:</div>
                  {x.counterexample.source.map((l, i) => <div key={i} style={{ marginLeft: 12, fontFamily: 'var(--font-mono)' }}>{l}</div>)}
                  <div style={{ color: 'var(--ink-muted)' }}>but the views make this of it in {tgt}, which breaks the constraint:</div>
                  {x.counterexample.target.map((l, i) => <div key={i} style={{ marginLeft: 12, fontFamily: 'var(--font-mono)' }}>{l}</div>)}
                </div>}
                {p && <div style={{ marginTop: 4, padding: '4px 6px', border: '1px solid var(--border-soft)', borderRadius: 3, background: 'var(--bg-surface)' }}>
                  <div style={{ fontSize: 11, color: 'var(--ink-muted)' }}>{src} would guarantee it with this constraint{p.label ? ` (${p.label})` : ''}:</div>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}>
                    <div style={{ flex: 1 }}>{sentence(p.entry, p.ctx, p.sentence)}</div>
                    {added[x.key]
                      ? <span style={{ color: 'var(--col-candidate)', fontSize: 11 }}>✓ Added to {src}</span>
                      : <button style={btn} title={`Add this constraint to ${src} (Undo takes it back); run the check again to see the result`}
                        onClick={() => { useOrmStore.getState().addSimpleConstraint(view.sourceSchemaId, p.simple); setAdded(a => ({ ...a, [x.key]: true })) }}>Add to {src}</button>}
                  </div>
                </div>}
                {x.status === 'mustGuarantee' && !p && <div style={{ fontSize: 11, color: 'var(--ink-muted)', marginTop: 3 }}>
                  No single mandatory role or uniqueness constraint of {src} guarantees it; the supplier must guarantee it some other way, or the views must change.
                </div>}
              </div>
            </div>
          </div>
        )
      })}
      {!shown.length && count.guaranteed > 0 && <div style={{ color: 'var(--ink-muted)' }}>Tick “show guaranteed ones too” to see which constraints of {src} guarantee each.</div>}
    </div>
  )
}
