import React, { useEffect, useMemo, useState } from 'react'
import { useOrmStore } from '../store/ormStore'
import { clusterRules, shapesOf, DEFAULT_CAP } from '../mapping/ruleClusters.js'

const FONT = "'Segoe UI', Helvetica, Arial, sans-serif"
const CAP_KEY = 'freefbm.suggestDiagrams.cap'

const readCap = () => {
  try { const v = +localStorage.getItem(CAP_KEY); return v >= 10 && v <= 500 ? v : DEFAULT_CAP } catch { return DEFAULT_CAP }
}

// Suggest diagrams: the rules of a mapping split into groups that share
// elements (mapping/ruleClusters.js), as a first partition to review: rename
// a group, move a rule to another group, merge groups, leave groups out, then
// make one mapping diagram per group (store.newMappingDiagrams, one undo
// step). Opened with store.suggestDiagramsDialog = { mappingId }.
export default function SuggestDiagramsDialog() {
  const mappingId = useOrmStore(s => s.suggestDiagramsDialog?.mappingId ?? null)
  if (!mappingId) return null
  return <Dialog mappingId={mappingId} />
}

function Dialog({ mappingId }) {
  const close = () => useOrmStore.setState({ suggestDiagramsDialog: null })
  const mapping = useOrmStore(s => s.mappings?.find(x => x.id === mappingId) ?? s.views?.find(x => x.id === mappingId) ?? null)
  const diagrams = useOrmStore(s => s.diagrams)
  // Rules some diagram of the mapping draws already.
  const placed = useMemo(() => {
    const out = new Set()
    for (const d of diagrams) if (d.mappingId === mappingId) for (const id of d.mappingRuleIds ?? []) out.add(id)
    return out
  }, [diagrams, mappingId])
  const orphans = mapping ? mapping.rules.filter(r => !placed.has(r.id)).length : 0
  const [scope, setScope] = useState(() => (placed.size && orphans ? 'orphans' : 'all'))
  const [capText, setCapText] = useState(() => String(readCap()))
  const [cap, setCap] = useState(readCap)
  const commitCap = () => {
    const v = Math.max(10, Math.min(500, Math.round(+capText) || DEFAULT_CAP))
    setCapText(String(v)); setCap(v)
    try { localStorage.setItem(CAP_KEY, String(v)) } catch { /* private window */ }
  }

  // The suggestion, computed after the dialog has drawn ("Grouping…").
  const [result, setResult] = useState(null)
  useEffect(() => {
    if (!mapping) return
    setResult(null)
    const t = setTimeout(() => {
      const st = useOrmStore.getState()
      const ruleIds = scope === 'orphans' ? mapping.rules.filter(r => !placed.has(r.id)).map(r => r.id) : null
      try { setResult(clusterRules(st, mapping, { ruleIds, cap })) } catch (err) { setResult({ error: String(err?.message ?? err) }) }
    }, 30)
    return () => clearTimeout(t)
    // placed is read once per scope/cap change, so creating diagrams elsewhere doesn't regroup.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mapping, scope, cap])

  // Editable copy of the groups.
  const [groups, setGroups] = useState([])
  const [open, setOpen] = useState(() => new Set())
  useEffect(() => {
    setGroups((result?.groups ?? []).map(g => ({ ...g, on: true })))
    setOpen(new Set())
  }, [result])
  const index = useMemo(() => new Map((result?.info ?? []).map((r, i) => [r.id, i])), [result])
  const shapes = (ruleIds) => (result?.info ? shapesOf(result.info, ruleIds.map(id => index.get(id)).filter(i => i != null)) : 0)
  const ruleName = useMemo(() => new Map((mapping?.rules ?? []).map((r, k) => [r.id, r.name || `Rule ${k + 1}`])), [mapping])
  const groupName = (id) => groups.find(g => g.id === id)?.name ?? ''

  const edit = (id, patch) => setGroups(gs => gs.map(g => (g.id === id ? { ...g, ...patch } : g)))
  const moveRule = (ruleId, to) => setGroups(gs => {
    let next = gs.map(g => ({ ...g, ruleIds: g.ruleIds.filter(x => x !== ruleId) }))
    if (to === '__new') next.push({ id: `n${Date.now()}`, name: ruleName.get(ruleId), ruleIds: [ruleId], on: true })
    else next = next.map(g => (g.id === to ? { ...g, ruleIds: [...g.ruleIds, ruleId] } : g))
    return next.filter(g => g.ruleIds.length)
  })
  const merge = (from, to) => setGroups(gs => {
    const src = gs.find(g => g.id === from)
    return gs.filter(g => g.id !== from).map(g => (g.id === to ? { ...g, ruleIds: [...g.ruleIds, ...src.ruleIds] } : g))
  })
  const toggleOpen = (id) => setOpen(o => { const n = new Set(o); if (n.has(id)) n.delete(id); else n.add(id); return n })

  const chosen = groups.filter(g => g.on && g.ruleIds.length)
  const go = () => {
    close()
    useOrmStore.getState().newMappingDiagrams(mappingId, chosen.map(g => ({ name: g.name, ruleIds: g.ruleIds })))
  }
  const ruleCount = groups.reduce((t, g) => t + g.ruleIds.length, 0)

  return (
    <div onMouseDown={e => { if (e.target === e.currentTarget) close() }}
      onKeyDown={e => { e.stopPropagation(); if (e.key === 'Escape') close() }}
      style={{ position: 'fixed', inset: 0, zIndex: 1000, background: 'rgba(0,0,0,0.25)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: FONT }}>
      <div className="suggest-diagrams-dialog" style={{ width: 720, maxWidth: 'calc(100vw - 32px)', maxHeight: '84vh', display: 'flex', flexDirection: 'column',
        background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', boxShadow: 'var(--shadow-lg)' }}>
        <div style={{ padding: '12px 14px 8px', borderBottom: '1px solid var(--border-soft)' }}>
          <div style={{ fontWeight: 600, fontSize: 14, color: 'var(--ink-1)' }}>Suggest diagrams for {mapping?.name ?? 'the mapping'}</div>
          <div style={{ fontSize: 12, color: 'var(--ink-2)', marginTop: 4, lineHeight: 1.45 }}>
            A first split of the rules into diagrams: rules that name the same elements go together, first the rules about one
            type or table, then the groups that foreign keys and relationships join, up to a size. Rename, move rules, merge
            or leave out groups, and each group you keep becomes a mapping diagram. You can go on adding and taking off rules by hand.
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 14, alignItems: 'center', marginTop: 8, fontSize: 12, color: 'var(--ink-1)' }}>
            <label style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              At most
              <input aria-label="Shapes per diagram" type="number" min={10} max={500} value={capText}
                onChange={e => setCapText(e.target.value)} onBlur={commitCap}
                onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); commitCap() } }}
                style={{ width: 56, fontSize: 12, padding: '2px 4px' }} />
              shapes per diagram
            </label>
            {placed.size > 0 && <span style={{ display: 'flex', gap: 10 }}>
              <label style={{ display: 'flex', gap: 4, alignItems: 'center', cursor: 'pointer' }}>
                <input type="radio" name="sd-scope" checked={scope === 'all'} onChange={() => setScope('all')} style={{ width: 'auto' }} />
                All {mapping?.rules.length ?? 0} rules
              </label>
              <label style={{ display: 'flex', gap: 4, alignItems: 'center', cursor: orphans ? 'pointer' : 'default', color: orphans ? 'var(--ink-1)' : 'var(--ink-3)' }}>
                <input type="radio" name="sd-scope" disabled={!orphans} checked={scope === 'orphans'} onChange={() => setScope('orphans')} style={{ width: 'auto' }} />
                The {orphans} on no diagram
              </label>
            </span>}
          </div>
        </div>
        <div style={{ overflowY: 'auto', padding: '6px 14px', fontSize: 12, minHeight: 120 }}>
          {!mapping && <div style={{ color: 'var(--danger)' }}>The mapping no longer exists.</div>}
          {mapping && !result && <div style={{ color: 'var(--ink-2)', padding: '8px 0' }}>Grouping {scope === 'orphans' ? orphans : mapping.rules.length} rules…</div>}
          {result?.error && <div style={{ color: 'var(--danger)' }}>The rules could not be grouped: {result.error}</div>}
          {result && !result.error && !groups.length && <div style={{ color: 'var(--ink-2)', padding: '8px 0' }}>No rules to group.</div>}
          {groups.map(g => {
            const n = shapes(g.ruleIds)
            const isOpen = open.has(g.id)
            return (
              <div key={g.id} className="sd-group" style={{ borderTop: '1px solid var(--border-soft)', padding: '5px 0' }}>
                <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                  <input type="checkbox" aria-label="Make this diagram" checked={g.on} onChange={() => edit(g.id, { on: !g.on })} style={{ width: 'auto' }} />
                  <button onClick={() => toggleOpen(g.id)} aria-expanded={isOpen} title={isOpen ? 'Hide the rules' : 'Show the rules'}
                    style={{ border: 'none', background: 'none', cursor: 'pointer', color: 'var(--ink-2)', padding: '0 2px', fontSize: 11, width: 14 }}>{isOpen ? '▾' : '▸'}</button>
                  <input aria-label="Diagram name" value={g.name} onChange={e => edit(g.id, { name: e.target.value })}
                    style={{ flex: 1, minWidth: 120, fontSize: 12, fontWeight: 600, padding: '2px 4px', opacity: g.on ? 1 : 0.55 }} />
                  <span style={{ color: n > cap ? '#b45309' : 'var(--ink-2)', whiteSpace: 'nowrap' }}
                    title={n > cap ? 'More shapes than the limit' : undefined}>
                    {g.ruleIds.length} rule{g.ruleIds.length === 1 ? '' : 's'} · {n} shapes
                  </span>
                  {g.stability != null && g.stability < 0.7 && (
                    <span style={{ color: 'var(--ink-3)', whiteSpace: 'nowrap' }} title="Grouping again with other settings often splits this group differently: a candidate for checking by hand">varies</span>
                  )}
                  <select aria-label="Merge into" value="" onChange={e => { if (e.target.value) merge(g.id, e.target.value) }}
                    style={small}>
                    <option value="">Merge into…</option>
                    {groups.filter(h => h.id !== g.id).map(h => <option key={h.id} value={h.id}>{h.name}</option>)}
                  </select>
                </div>
                {isOpen && (
                  <div style={{ margin: '4px 0 2px 42px' }}>
                    {g.ruleIds.map(id => {
                      const u = result?.unsure?.get(id)
                      const alt = u?.alt && groups.some(h => h.id === u.alt && h.id !== g.id) ? u.alt : null
                      return (
                        <div key={id} style={{ display: 'flex', gap: 6, alignItems: 'center', padding: '1px 0' }}>
                          <span style={{ flex: 1, color: 'var(--ink-1)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {ruleName.get(id)}{placed.has(id) && <span style={{ color: 'var(--ink-3)' }}> · on a diagram</span>}
                          </span>
                          {alt && (
                            <button onClick={() => moveRule(id, alt)} title={`Grouping again with other settings mostly puts this rule with ${groupName(alt)}`}
                              style={{ fontSize: 11, border: '1px dashed var(--border)', background: 'none', borderRadius: 3, cursor: 'pointer', color: 'var(--ink-2)' }}>
                              ? → {groupName(alt)}
                            </button>
                          )}
                          <select aria-label="Move to" value="" onChange={e => { if (e.target.value) moveRule(id, e.target.value) }} style={small}>
                            <option value="">Move to…</option>
                            {groups.filter(h => h.id !== g.id).map(h => <option key={h.id} value={h.id}>{h.name}</option>)}
                            <option value="__new">A new group</option>
                          </select>
                        </div>
                      )
                    })}
                  </div>
                )}
              </div>
            )
          })}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 14px', borderTop: '1px solid var(--border-soft)' }}>
          <span style={{ flex: 1, fontSize: 12, color: 'var(--ink-2)' }}>
            {groups.length ? `${groups.length} group${groups.length === 1 ? '' : 's'} of ${ruleCount} rules` : ''}
          </span>
          <button onClick={close} style={btn(false)}>Cancel</button>
          <button onClick={go} disabled={!chosen.length} style={{ ...btn(true), opacity: chosen.length ? 1 : 0.5 }}>
            Make {chosen.length} diagram{chosen.length === 1 ? '' : 's'}
          </button>
        </div>
      </div>
    </div>
  )
}

const small = { fontFamily: FONT, fontSize: 11, height: 22, padding: '0 4px', width: 'auto', maxWidth: 140, minWidth: 0 }

const btn = (primary) => ({
  fontFamily: FONT, fontSize: 12, padding: '5px 12px', borderRadius: 4, cursor: 'pointer',
  border: `1px solid ${primary ? 'var(--accent)' : 'var(--border)'}`,
  background: primary ? 'var(--accent)' : 'var(--bg-surface)', color: primary ? '#fff' : 'var(--ink-1)',
})
