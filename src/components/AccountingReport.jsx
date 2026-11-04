import React, { useState } from 'react'
import { useOrmStore } from '../store/ormStore'
import { GRAPHICAL_NAME } from '../mapping/recognise.js'
import { accountingSteps } from '../mapping/accounting.js'
import { SIDES } from '../mapping/mapping.js'
import { Sentence, Formula } from './ConstraintsTab.jsx'
import { proposeTranslation } from '../mapping/translate.js'
import { useVerbalisation } from '../verbalisation/workbench.js'

// Constraint accounting (workbench step 10, mapping/accounting.js): for each
// constraint of either schema of a mapping, whether the other schema keeps it.
// The result lives in store.mappingAccounting[mappingId] (not saved, not part
// of undo): { running, done, total } while it runs, then { result } or
// { error }. The diagrams show badges from it (MappingLayer AccountingBadges).

export const STATUS = {
  native:  { label: 'native',  color: 'var(--col-candidate)', title: 'One constraint of the other schema keeps it (or the other schema’s structure does)' },
  implied: { label: 'implied', color: 'var(--map-source)',    title: 'Several constraints of the other schema keep it together, or the rules do' },
  lost:    { label: 'lost',    color: '#dc2626',              title: 'A population of the other schema that satisfies its constraints maps to one that breaks it' },
  unknown: { label: 'unknown', color: 'var(--ink-muted)',     title: 'Neither kept nor lost could be shown, or constraints of this kind are not checked yet' },
}

const setAccounting = (mappingId, value) => useOrmStore.setState(s => {
  const next = { ...(s.mappingAccounting ?? {}) }
  if (value) next[mappingId] = value
  else delete next[mappingId]
  return { mappingAccounting: next }
})

// Runs the accounting of a mapping in slices, so the window stays responsive.
export function runAccounting(mapping) {
  const token = {}
  const steps = accountingSteps(useOrmStore.getState(), mapping)
  setAccounting(mapping.id, { running: true, done: 0, total: 0, token })
  const tick = () => {
    if (useOrmStore.getState().mappingAccounting?.[mapping.id]?.token !== token) return   // stopped or restarted
    const t0 = performance.now()
    try {
      for (;;) {
        const r = steps.next()
        if (r.done) { setAccounting(mapping.id, { result: r.value, at: Date.now() }); return }
        if (performance.now() - t0 > 40) { setAccounting(mapping.id, { running: true, ...r.value, token }); setTimeout(tick, 0); return }
      }
    } catch (err) {
      setAccounting(mapping.id, { error: String(err?.message ?? err) })
    }
  }
  setTimeout(tick, 0)
}

export function AccountingReport({ acc, mapping, name }) {
  const [all, setAll] = useState(false)
  const viewLanguage = useOrmStore(s => s.viewLanguage)
  const { language } = useVerbalisation(viewLanguage)
  const box = { padding: '6px 8px 8px', borderBottom: '1px solid var(--border-soft)', background: 'var(--bg-text-panel)' }
  const btn = { fontSize: 11, padding: '2px 8px', border: '1px solid var(--border)', borderRadius: 3, background: 'var(--bg-surface)', color: 'var(--ink-2)', cursor: 'pointer' }
  const close = <button style={{ ...btn, border: 'none', background: 'none', color: 'var(--ink-muted)' }} title="Close" onClick={() => setAccounting(mapping.id, null)}>×</button>
  const sideName = (side) => name(side === 'source' ? mapping.sourceSchemaId : mapping.targetSchemaId)
  const other = (side) => (side === 'source' ? 'target' : 'source')

  if (acc.error) return <div style={{ ...box, color: '#dc2626' }}>Constraint accounting failed: {acc.error} {close}</div>
  if (acc.running) {
    const pct = acc.total ? Math.round(100 * acc.done / acc.total) : 0
    return (
      <div style={{ ...box, display: 'flex', alignItems: 'center', gap: 8 }}>
        <b>Constraint accounting</b>
        <span style={{ color: 'var(--ink-muted)' }}>checking constraint {acc.done} of {acc.total || '…'}</span>
        <div style={{ width: 160, height: 5, background: 'var(--border-soft)', borderRadius: 3 }}>
          <div style={{ width: `${pct}%`, height: '100%', background: 'var(--accent)', borderRadius: 3 }} />
        </div>
        <button style={btn} onClick={() => setAccounting(mapping.id, null)}>Stop</button>
      </div>
    )
  }
  const r = acc.result
  const counts = (side) => r.sides[side].reduce((m, x) => ({ ...m, [x.status]: (m[x.status] ?? 0) + 1 }), {})
  return (
    <div className="mapping-accounting" style={box}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 6, flexWrap: 'wrap' }}>
        <b>Constraint accounting</b>
        <span style={{ color: 'var(--ink-muted)' }}>{r.ms} ms · nothing is changed</span>
        <div style={{ flex: 1 }} />
        <label style={{ fontSize: 11, color: 'var(--ink-2)', display: 'inline-flex', gap: 4, alignItems: 'center', cursor: 'pointer' }}>
          <input type="checkbox" checked={all} onChange={e => setAll(e.target.checked)} /> Show kept constraints too
        </label>
        <button style={btn} title="Check again, after changes to the schemas or the rules" onClick={() => runAccounting(mapping)}>Again</button>
        {close}
      </div>
      <div data-text-panel tabIndex={0} className="copyable" style={{ outline: 'none' }}>
        {SIDES.map(side => {
          const c = counts(side)
          const items = r.sides[side].filter(x => all || x.status === 'lost' || x.status === 'unknown')
          return (
            <div key={side} style={{ marginBottom: 8 }}>
              <div className="text-panel-section" style={{ marginBottom: 4 }}>
                Constraints of {sideName(side)}, in {sideName(other(side))}:{' '}
                {['native', 'implied', 'lost', 'unknown'].filter(k => c[k]).map(k => (
                  <span key={k} style={{ color: STATUS[k].color, marginRight: 8 }}>{c[k]} {STATUS[k].label}</span>
                ))}
              </div>
              {!items.length && <div style={{ color: 'var(--ink-muted)', fontStyle: 'italic', marginBottom: 4 }}>
                {r.sides[side].length ? `${sideName(other(side))} keeps every constraint of ${sideName(side)}.` : `${sideName(side)} has no constraints.`}
              </div>}
              {items.map(x => <Item key={x.key} x={x} mapping={mapping} side={side} ctx={r.ctxs[side]} otherCtx={r.ctxs[other(side)]} language={language}
                here={sideName(side)} there={sideName(other(side))} />)}
            </div>
          )
        })}
      </div>
    </div>
  )
}

// An accounting item, kept by a constraint now added to the other schema.
const markKept = (mappingId, side, key, status, reason) => useOrmStore.setState(s => {
  const a = s.mappingAccounting?.[mappingId]
  if (!a?.result) return {}
  const sides = { ...a.result.sides, [side]: a.result.sides[side].map(e => (e.key === key ? { ...e, status, reason, by: [], counterexample: null } : e)) }
  return { mappingAccounting: { ...s.mappingAccounting, [mappingId]: { ...a, result: { ...a.result, sides } } } }
})

const VC_NAME = { '=': 'equal to', '≠': 'different from', '<': 'less than', '≤': 'at most', '>': 'greater than', '≥': 'at least' }

function Item({ x, mapping, side, ctx, otherCtx, language, here, there }) {
  const [open, setOpen] = useState(x.status === 'lost')
  const [carry, setCarry] = useState(null)   // proposeTranslation's result, once asked
  const st = STATUS[x.status]
  const mono = { fontFamily: 'var(--font-mono)', fontSize: 11.5, lineHeight: 1.5 }
  const Constraint = ({ label, entry, c }) => (label
    ? <div style={{ ...mono, fontSize: 12 }}>{label}</div>
    : entry?.formula ? <Sentence formula={entry.formula} ctx={c} language={language} />
    : <div>{entry?.kind ?? 'a constraint'}</div>)
  const more = (lines, n) => (lines.length > n ? [...lines.slice(0, n), `… and ${lines.length - n} more`] : lines)
  return (
    <div style={{ display: 'flex', gap: 8, padding: '3px 0', borderTop: '1px solid var(--border-soft)' }}>
      <span title={st.title} style={{ flex: '0 0 54px', fontSize: 10, fontWeight: 700, color: st.color, paddingTop: 3, textTransform: 'uppercase', letterSpacing: '0.04em' }}>{st.label}</span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 10, color: 'var(--ink-muted)', letterSpacing: '0.04em' }}>{x.entry.kind}{x.entry.subject ? ` · ${x.entry.subject}` : ''}</div>
        <Constraint label={x.label} entry={x.entry} c={ctx} />
        <div style={{ fontSize: 11, color: 'var(--ink-2)', marginTop: 1 }}>
          {x.reason}
          {(x.counterexample || x.by.length > 0) && <button type="button" onClick={() => setOpen(o => !o)}
            style={{ marginLeft: 6, fontSize: 11, border: 'none', background: 'none', color: 'var(--accent)', cursor: 'pointer', padding: 0 }}>
            {open ? 'less' : x.counterexample ? 'counterexample' : 'which'}</button>}
          {x.status === 'lost' && !carry && <button type="button" title={`Write this constraint over ${there}, through the mapping's rules`}
            onClick={() => setCarry(proposeTranslation(useOrmStore.getState(), mapping, x, side))}
            style={{ marginLeft: 6, fontSize: 11, border: 'none', background: 'none', color: 'var(--accent)', cursor: 'pointer', padding: 0 }}>
            translate</button>}
        </div>
        {carry && <Carried carry={carry} x={x} mapping={mapping} side={side} language={language} there={there} onClose={() => setCarry(null)} />}
        {open && x.by.length > 0 && <div style={{ marginTop: 3, paddingLeft: 10, borderLeft: '2px solid var(--border-soft)' }}>
          {x.by.map(b => <Constraint key={b.key} label={b.label} entry={b.entry} c={otherCtx} />)}
        </div>}
        {open && x.counterexample && <div style={{ marginTop: 3, paddingLeft: 10, borderLeft: '2px solid #dc2626' }}>
          <div style={{ fontSize: 11, color: 'var(--ink-2)' }}>In {there} (⊥ stands for any value, NULL for none):</div>
          {more(x.counterexample.there, 14).map((l, i) => <div key={i} style={mono}>{l}</div>)}
          <div style={{ fontSize: 11, color: 'var(--ink-2)', marginTop: 2 }}>which the mapping turns into this in {here}:</div>
          {more(x.counterexample.back, 10).map((l, i) => <div key={i} style={mono}>{l}</div>)}
        </div>}
      </div>
    </div>
  )
}

// A lost constraint, written over the other schema (mapping/translate.js).
function Carried({ carry, x, mapping, side, language, there, onClose }) {
  const [added, setAdded] = useState(false)
  const link = { marginLeft: 6, fontSize: 11, border: 'none', background: 'none', color: 'var(--accent)', cursor: 'pointer', padding: 0 }
  const btn = { fontSize: 11, padding: '2px 8px', border: '1px solid var(--border)', borderRadius: 3, background: 'var(--bg-surface)', color: 'var(--ink-2)', cursor: 'pointer' }
  const frame = { marginTop: 4, paddingLeft: 10, borderLeft: '2px solid var(--accent)' }
  const note = { fontSize: 11, color: 'var(--ink-2)' }
  if (carry.error) return (
    <div style={frame}><span style={note}>This constraint can't be written over {there} yet: {carry.error}.</span>
      <button type="button" style={link} onClick={onClose}>close</button></div>
  )
  const kept = carry.status === 'native' || carry.status === 'implied'
  const add = () => {
    useOrmStore.getState().addCarriedConstraint(carry.schemaId, { rule: carry.rule, deontic: carry.deontic, graphical: carry.graphical })
    markKept(mapping.id, side, x.key, carry.status ?? 'unknown',
      kept ? `Kept by a constraint added to ${there} from this one.` : `A constraint was added to ${there} from this one; check again to see whether it keeps it.`)
    setAdded(true)
  }
  return (
    <div style={frame}>
      <div style={note}>In {there} it would read{carry.vc ? `, as a value comparison constraint (${VC_NAME[carry.vc.operator] ?? carry.vc.operator})` : carry.graphical ? `, as ${GRAPHICAL_NAME[carry.graphical.constraintType]} with join paths` : ', as a formula constraint'}:</div>
      {carry.entry?.formula && <>
        <Sentence formula={carry.entry.formula} ctx={carry.ctx} language={language} />
        <div style={{ fontSize: 11.5 }}><Formula formula={carry.entry.formula} ctx={carry.ctx} /></div>
      </>}
      {carry.errors.length > 0 && <div style={{ ...note, color: '#dc2626' }}>{carry.errors.join('; ')}</div>}
      <div style={{ ...note, marginTop: 2 }}>
        {carry.errors.length ? 'It is not a valid constraint there.'
          : kept ? `Checked: with it, ${there} keeps this constraint (${carry.status}).`
          : `Checked: with it, the constraint is still ${carry.status ?? 'unknown'}${carry.reason ? ` (${carry.reason})` : ''}.`}
      </div>
      <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
        {added ? <span style={{ ...note, color: 'var(--col-candidate)' }}>Added to {there}.</span>
          : <button type="button" style={btn} disabled={carry.errors.length > 0} onClick={add}>Add to {there}</button>}
        <button type="button" style={{ ...btn, border: 'none', background: 'none' }} onClick={onClose}>{added ? 'Close' : 'Cancel'}</button>
      </div>
    </div>
  )
}
