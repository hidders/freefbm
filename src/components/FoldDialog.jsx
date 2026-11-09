import React, { useMemo, useState } from 'react'
import { useOrmStore } from '../store/ormStore'
import { planFold } from '../mapping/fold.js'
import { sideContext, sideTokens, tokensText } from '../mapping/mapping.js'

const FONT = 'var(--font-ui)'

// Fold (workbench step 12): the derived elements of one schema of a mapping,
// each with the mapping rule its rule unfolds to, and the fact types they
// replace with whether each can go. Opened with store.foldDialog = { mappingId }.
export default function FoldDialog() {
  const mappingId = useOrmStore(s => s.foldDialog?.mappingId ?? null)
  const side = useOrmStore(s => s.foldDialog?.side ?? null)
  if (!mappingId) return null
  return <Dialog mappingId={mappingId} side={side} />
}

function Dialog({ mappingId, side }) {
  const close = () => useOrmStore.setState({ foldDialog: null })
  // Set by Refactor: the old version's elements to delete once folded.
  const twins = useOrmStore(s => s.foldDialog?.twins ?? null)
  const { plan, ctxs, schemaName, mapping, error } = useMemo(() => {
    const st = useOrmStore.getState()
    const m = st.mappings?.find(x => x.id === mappingId)
    if (!m) return { error: 'The mapping no longer exists.' }
    try {
      const p = planFold(st, m, { side })
      const ctxs = { source: sideContext(st, m.sourceSchemaId), target: sideContext(st, m.targetSchemaId) }
      return { plan: p, ctxs, mapping: m, schemaName: ctxs[p.side].schema?.name ?? 'the schema' }
    } catch (err) {
      return { error: `Fold could not be planned: ${err?.message ?? err}` }
    }
  }, [mappingId, side])
  const ok = (i) => !!(i.rule || i.constraint)
  const [fold, setFold] = useState(() => new Set((plan?.items ?? []).filter(ok).map(i => i.id)))
  const [remove, setRemove] = useState(() => new Set((plan?.candidates ?? []).filter(c => c.recoverable).map(c => c.factId)))
  const toggle = (set, setter, id) => setter(() => { const n = new Set(set); if (n.has(id)) n.delete(id); else n.add(id); return n })
  const candidates = (plan?.candidates ?? []).filter(c => c.usedBy.some(id => fold.has(id)))
  const go = () => {
    close()
    useOrmStore.getState().foldMapping(plan, { fold: [...fold], remove: candidates.filter(c => remove.has(c.factId)).map(c => c.factId), twins })
  }
  const text = (tree, side) => { try { return tokensText(sideTokens(tree, ctxs[side])) } catch { return '…' } }

  return (
    <div onMouseDown={e => { if (e.target === e.currentTarget) close() }}
      onKeyDown={e => { e.stopPropagation(); if (e.key === 'Escape') close() }}
      style={{ position: 'fixed', inset: 0, zIndex: 1000, background: 'rgba(0,0,0,0.25)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: FONT }}>
      <div className="fold-dialog" style={{ width: 680, maxWidth: 'calc(100vw - 32px)', maxHeight: '80vh', display: 'flex', flexDirection: 'column',
        background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', boxShadow: 'var(--shadow-lg)' }}>
        <div style={{ padding: '12px 14px 8px', borderBottom: '1px solid var(--border-soft)' }}>
          <div style={{ fontWeight: 600, fontSize: 14, color: 'var(--ink-1)' }}>
            Fold {plan ? `the derived elements of ${schemaName}` : ''} into {mapping?.name ?? 'the mapping'}
          </div>
          <div style={{ fontSize: 12, color: 'var(--ink-2)', marginTop: 4, lineHeight: 1.45 }}>
            Each derived type or fact type gets a mapping rule, made by unfolding its derivation rule through the rules that map
            the elements it uses. It then becomes an ordinary element, keeping its population. The fact types it was derived from
            can go when the rest of the mapping still carries everything they did. A semi-derived element becomes stored, holding
            its stored and its derived rows, and its rule stays as a constraint.
          </div>
        </div>
        <div style={{ overflowY: 'auto', padding: '8px 14px', fontSize: 12 }}>
          {error && <div style={{ color: 'var(--danger)' }}>{error}</div>}
          {plan && !plan.items.length && (
            <div style={{ color: 'var(--ink-2)', lineHeight: 1.45 }}>
              Neither schema has a derived or semi-derived type or fact type. Mark an element as derived, give it a rule over the schema
              (∃, ∧ and atoms), check its population, and fold it here.
            </div>
          )}
          {plan?.items.length > 0 && <div style={{ fontWeight: 600, color: 'var(--ink-1)', margin: '4px 0 4px' }}>Derived elements</div>}
          {plan?.items.map(i => (
            <div key={i.id} style={{ borderTop: '1px solid var(--border-soft)', padding: '5px 0' }}>
              <label style={{ display: 'flex', gap: 6, alignItems: 'baseline', color: ok(i) ? 'var(--ink-1)' : 'var(--ink-3)', cursor: ok(i) ? 'pointer' : 'default' }}>
                <input type="checkbox" disabled={!ok(i)} checked={ok(i) && fold.has(i.id)} onChange={() => toggle(fold, setFold, i.id)} style={{ width: 'auto' }}/>
                <span><b style={{ fontWeight: 600 }}>{i.name}</b> <span style={{ color: 'var(--ink-3)' }}>({i.semi ? 'semi-derived ' : ''}{i.kind === 'fact' ? 'fact type' : 'type'})</span></span>
              </label>
              {i.error && <div style={{ marginLeft: 22, color: 'var(--ink-2)' }}>Can't be folded: {i.error}.</div>}
              {i.constraint && (
                <div className="copyable" style={{ marginLeft: 22, marginTop: 2, fontSize: 11, color: 'var(--ink-2)', lineHeight: 1.5 }}>
                  <div>Stays as {i.constraint.graphical ? 'a subset constraint' : 'a formula constraint'}:</div>
                  <div style={{ fontFamily: 'var(--font-mono, monospace)' }}>{i.constraint.text}</div>
                </div>
              )}
              {i.rule && (
                <div className="copyable" style={{ marginLeft: 22, marginTop: 2, fontFamily: 'var(--font-mono, monospace)', fontSize: 11, color: 'var(--ink-2)', lineHeight: 1.5 }}>
                  <div>{text(i.rule.source, 'source')}</div>
                  <div>⟺ {text(i.rule.target, 'target')}</div>
                  {i.issues.map((x, k) => (
                    <div key={k} style={{ fontFamily: FONT, color: x.severity === 'error' ? 'var(--danger)' : '#b45309' }}>{x.text}</div>
                  ))}
                </div>
              )}
            </div>
          ))}
          {candidates.length > 0 && <>
            <div style={{ fontWeight: 600, color: 'var(--ink-1)', margin: '10px 0 4px' }}>Fact types they were derived from</div>
            {candidates.map(c => (
              <label key={c.factId} style={{ display: 'flex', gap: 6, alignItems: 'baseline', borderTop: '1px solid var(--border-soft)', padding: '4px 0',
                color: c.recoverable ? 'var(--ink-1)' : 'var(--ink-3)', cursor: c.recoverable ? 'pointer' : 'default' }}>
                <input type="checkbox" disabled={!c.recoverable} checked={c.recoverable && remove.has(c.factId)} onChange={() => toggle(remove, setRemove, c.factId)} style={{ width: 'auto' }}/>
                <span>
                  {c.recoverable ? 'Remove' : 'Keep'} <b style={{ fontWeight: 600 }}>{c.name}</b>
                  <span style={{ color: 'var(--ink-2)' }}> · {c.reason}</span>
                </span>
              </label>
            ))}
          </>}
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, padding: '10px 14px', borderTop: '1px solid var(--border-soft)' }}>
          <button onClick={close} style={btn(false)}>Cancel</button>
          <button onClick={go} disabled={!fold.size} autoFocus style={{ ...btn(true), opacity: fold.size ? 1 : 0.5 }}>Fold</button>
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
