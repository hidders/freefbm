import React from 'react'
import { useOrmStore } from '../store/ormStore'
import { equivalenceSteps } from '../mapping/equivalence.js'
import { SIDES } from '../mapping/mapping.js'

// The equivalence summary of a mapping (mapping/equivalence.js): one verdict
// from round trips of generic populations and constraint accounting, with
// how many constraints are kept by graphical constraints and how many need
// formula constraints. The result lives in store.mappingEquivalence[mappingId]
// (not saved, not part of undo): { running, phase, done, total } while it
// runs, then { result, basis } or { error }. basis holds the element lists
// and the mapping it was computed from, so an edit marks it stale. The
// constraint accounting it ran is put in store.mappingAccounting too, so the
// accounting report (details, translations) and the diagram badges show it.

const setEquivalence = (mappingId, value) => useOrmStore.setState(s => {
  const next = { ...(s.mappingEquivalence ?? {}) }
  if (value) next[mappingId] = value
  else delete next[mappingId]
  return { mappingEquivalence: next }
})

const basisOf = (s, mappingId) => ({
  objectTypes: s.objectTypes, facts: s.facts, constraints: s.constraints, subtypes: s.subtypes,
  mapping: (s.mappings ?? []).find(m => m.id === mappingId),
})

export const isStale = (eq, s) => {
  if (!eq?.basis) return false
  const now = basisOf(s, eq.result?.mappingId)
  return Object.keys(now).some(k => now[k] !== eq.basis[k])
}

// Runs the checks in slices, so the window stays responsive.
export function runEquivalence(mapping) {
  const token = {}
  const state = useOrmStore.getState()
  const basis = basisOf(state, mapping.id)
  const steps = equivalenceSteps(state, mapping)
  setEquivalence(mapping.id, { running: true, phase: 'information', done: 0, total: 0, token })
  const tick = () => {
    if (useOrmStore.getState().mappingEquivalence?.[mapping.id]?.token !== token) return   // stopped or restarted
    const t0 = performance.now()
    try {
      for (;;) {
        const r = steps.next()
        if (r.done) {
          setEquivalence(mapping.id, { result: r.value, basis, at: Date.now() })
          useOrmStore.setState(s => ({ mappingAccounting: { ...(s.mappingAccounting ?? {}), [mapping.id]: { result: r.value.accounting, at: Date.now() } } }))
          return
        }
        if (performance.now() - t0 > 40) { setEquivalence(mapping.id, { running: true, ...r.value, token }); setTimeout(tick, 0); return }
      }
    } catch (err) {
      setEquivalence(mapping.id, { error: String(err?.message ?? err) })
    }
  }
  setTimeout(tick, 0)
}

const RED = '#dc2626', AMBER = '#d97706', GREEN = 'var(--col-candidate)'
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`
const list = (xs, n = 6) => `${xs.slice(0, n).join(', ')}${xs.length > n ? `, and ${xs.length - n} more` : ''}`

export function EquivalenceReport({ eq, mapping, name }) {
  const stale = useOrmStore(s => isStale(eq, s))
  const box = { padding: '6px 8px 8px', borderBottom: '1px solid var(--border-soft)', background: 'var(--bg-text-panel)' }
  const btn = { fontSize: 11, padding: '2px 8px', border: '1px solid var(--border)', borderRadius: 3, background: 'var(--bg-surface)', color: 'var(--ink-2)', cursor: 'pointer' }
  const close = <button style={{ ...btn, border: 'none', background: 'none', color: 'var(--ink-muted)' }} title="Close" onClick={() => setEquivalence(mapping.id, null)}>×</button>
  const sideName = (side) => name(side === 'source' ? mapping.sourceSchemaId : mapping.targetSchemaId)
  const other = (side) => (side === 'source' ? 'target' : 'source')

  if (eq.error) return <div style={{ ...box, color: RED }}>The equivalence check failed: {eq.error} {close}</div>
  if (eq.running) {
    const pct = eq.total ? Math.round(100 * eq.done / eq.total) : 0
    return (
      <div style={{ ...box, display: 'flex', alignItems: 'center', gap: 8 }}>
        <b>Equivalence</b>
        <span style={{ color: 'var(--ink-muted)' }}>{eq.phase === 'constraints' ? `checking constraint ${eq.done} of ${eq.total || '…'}` : `round trips: ${eq.done} of ${eq.total || '…'}`}</span>
        <div style={{ width: 160, height: 5, background: 'var(--border-soft)', borderRadius: 3 }}>
          <div style={{ width: `${pct}%`, height: '100%', background: 'var(--accent)', borderRadius: 3 }} />
        </div>
        <button style={btn} onClick={() => setEquivalence(mapping.id, null)}>Stop</button>
      </div>
    )
  }
  const r = eq.result
  const S = sideName('source'), T = sideName('target')
  const head = r.verdict === 'equivalent'
    ? { mark: '✓', color: GREEN, text: `${S} and ${T} are equivalent under this mapping` }
    : r.verdict === 'undecided'
      ? { mark: '?', color: AMBER, text: `No difference found, but ${plural(r.undecided, 'check')} could not be decided` }
      : { mark: '✕', color: RED, text: `${S} and ${T} are not equivalent under this mapping (${plural(r.failed, 'problem')})` }
  const lost = SIDES.reduce((n, X) => n + r.constraints[X].lost.length, 0)
  const how = r.formulas ? `${plural(r.formulas, 'constraint')} ${r.formulas === 1 ? 'is' : 'are'} kept only with the help of formula constraints.`
    : 'Every constraint that is kept is kept by graphical constraints (or the structure) alone.'
  const deontic = SIDES.reduce((n, X) => n + r.constraints[X].deontic.length, 0)
  return (
    <div className="mapping-equivalence" style={box}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 4, flexWrap: 'wrap' }}>
        <b>Equivalence</b>
        <span style={{ color: head.color, fontWeight: 600 }}>{head.mark} {head.text}</span>
        <span style={{ color: 'var(--ink-muted)' }}>· {(r.ms / 1000).toFixed(1)} s · nothing is changed</span>
        <div style={{ flex: 1 }} />
        <button style={btn} title="Check again, after changes to the schemas or the rules" onClick={() => runEquivalence(mapping)}>Again</button>
        {close}
      </div>
      {stale && <div style={{ color: AMBER, marginBottom: 4 }}>The schemas or the rules have changed since this check: check again to update it.</div>}
      <div data-text-panel tabIndex={0} className="copyable" style={{ outline: 'none' }}>
        {how && <div style={{ color: 'var(--ink-2)', marginBottom: 6 }}>{how}</div>}
        {SIDES.map(X => <Information key={`i${X}`} info={r.info[X]} here={sideName(X)} there={sideName(other(X))} />)}
        {SIDES.map(X => <Constraints key={`c${X}`} c={r.constraints[X]} here={sideName(X)} there={sideName(other(X))} />)}
        <div style={{ color: 'var(--ink-muted)', marginTop: 6, fontSize: 11, lineHeight: 1.45 }}>
          These checks run the mapping on populations: generic ones with a labelled null ⊥ for each value, closed under each schema’s
          constraints. A pass means no counterexample was found, not a proof.
          {deontic > 0 && ` ${plural(deontic, 'deontic constraint')} ${deontic === 1 ? 'is' : 'are'} left out, as ${deontic === 1 ? 'it doesn’t' : 'they don’t'} restrict populations.`}
          {(lost > 0 || r.undecided > 0) && ' The constraint accounting below has the details: counterexamples, and translations to add.'}
        </div>
      </div>
    </div>
  )
}

const Row = ({ mark, color, title, children }) => (
  <div style={{ display: 'flex', gap: 8, padding: '3px 0', borderTop: '1px solid var(--border-soft)' }}>
    <span style={{ flex: '0 0 14px', color, fontWeight: 700 }}>{mark}</span>
    <div style={{ flex: 1, minWidth: 0 }}>
      <div style={{ fontWeight: 600 }}>{title}</div>
      {children}
    </div>
  </div>
)
const Line = ({ color, children }) => <div style={{ fontSize: 11.5, color: color ?? 'var(--ink-2)' }}>{children}</div>

// Whether the population of one schema can be recovered from the other's.
function Information({ info, here, there }) {
  const bad = info.unmapped.length + info.lost.length
  const mark = bad ? '✕' : info.unchecked.length ? '?' : '✓'
  const color = bad ? RED : info.unchecked.length ? AMBER : GREEN
  const ok = info.rules.filter(x => x.ok).length + info.types.filter(x => x.ok).length
  return (
    <Row mark={mark} color={color} title={bad ? `${here} loses information in ${there}` : `Everything ${here} holds can be recovered from ${there}`}>
      {ok > 0 && <Line>{plural(info.rules.filter(x => x.ok).length, 'rule')}{info.types.some(x => x.ok) ? ` and ${plural(info.types.filter(x => x.ok).length, 'entity type')} on ${info.types.filter(x => x.ok).length === 1 ? 'its' : 'their'} own` : ''} come back unchanged after a run there and back.</Line>}
      {info.unmapped.length > 0 && <Line color={RED}>Not mapped by any rule, so not carried over: {list(info.unmapped.map(u => u.name))}.</Line>}
      {info.lost.map(x => <Line key={x.id} color={RED}>{x.name}: {x.reason}.</Line>)}
      {info.unchecked.length > 0 && <Line color={AMBER}>Not checked: {list(info.unchecked.map(x => `${x.name} (${x.reason})`), 4)}.</Line>}
    </Row>
  )
}

// How the constraints of one schema fare in the other.
function Constraints({ c, here, there }) {
  const kept = c.graphical.length + c.complex.length
  const mark = c.lost.length ? '✕' : c.unknown.length ? '?' : '✓'
  const color = c.lost.length ? RED : c.unknown.length ? AMBER : GREEN
  const label = (x) => x.label ?? `${x.entry.kind}${x.entry.subject ? ` (${x.entry.subject})` : ''}`
  const fixes = { graphical: c.lost.filter(x => x.fix.kind === 'graphical').length, formula: c.lost.filter(x => x.fix.kind === 'formula').length, none: c.lost.filter(x => x.fix.kind === 'none').length }
  // Undecided ones, grouped by reason.
  const reasons = new Map()
  for (const x of c.unknown) reasons.set(x.reason, (reasons.get(x.reason) ?? 0) + 1)
  const total = kept + c.lost.length + c.unknown.length
  return (
    <Row mark={mark} color={color} title={c.lost.length ? `${there} allows populations that break constraints of ${here}` : `Every constraint of ${here} holds in ${there}`}>
      {total === 0 && <Line>{here} has no constraints to check.</Line>}
      {kept > 0 && <Line>{kept} of {total} kept: {c.graphical.length} by graphical constraints or the structure of {there}{c.complex.length ? `, ${c.complex.length} only with formula constraints` : ''}.</Line>}
      {c.complex.length > 0 && <Line>Needing formula constraints: {list(c.complex.map(label), 4)}.</Line>}
      {c.lost.length > 0 && <Line color={RED}>
        {plural(c.lost.length, 'constraint')} lost: {list(c.lost.map(label), 4)}.{' '}
        {(fixes.graphical + fixes.formula) > 0 && `${fixes.graphical + fixes.formula === 1 ? 'It' : 'They'} can be carried to ${there} as ${[
          fixes.graphical && `${plural(fixes.graphical, 'value comparison')} (graphical)`,
          fixes.formula && plural(fixes.formula, 'formula constraint')].filter(Boolean).join(' and ')}${fixes.none ? `; ${fixes.none} can't be written over ${there} yet` : ''}.`}
        {fixes.graphical + fixes.formula === 0 && fixes.none > 0 && `${fixes.none === 1 ? 'It' : 'They'} can't be written over ${there} yet.`}
      </Line>}
      {reasons.size > 0 && <Line color={AMBER}>{plural(c.unknown.length, 'constraint')} not decided: {[...reasons].slice(0, 4).map(([why, n]) => `${n} × ${why.replace(/\.$/, '')}`).join('; ')}{reasons.size > 4 ? '; …' : ''}.</Line>}
    </Row>
  )
}
