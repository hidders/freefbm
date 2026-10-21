import React, { useMemo, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useOrmStore } from '../store/ormStore'
import { formalise } from '../logic/constraintFormulas.js'
import { renderFormula } from '../logic/renderFormula.js'

// ── Formalisation tab ───────────────────────────────────────────────────────
// Lists the logic formula behind every constraint in the selected part of the
// diagram (or the whole diagram when nothing is selected), optionally followed
// by the implicit disjointness and participation constraints.

const TOKEN_STYLE = {
  var:     { color: 'var(--formula-var)', fontWeight: 600 },
  reading: { color: 'var(--formula-reading)' },
  type:    { color: 'var(--formula-type)', fontWeight: 600 },
  op:      { color: 'var(--formula-op)' },
  punct:   { color: 'var(--ink-3)' },
  qgap:    { display: 'inline-block', width: '0.4em', overflow: 'hidden', verticalAlign: 'bottom' },
}

// Show/hide state of the optional sections, remembered across tab switches.
function useToggle(key) {
  const read = () => { try { return localStorage.getItem(key) === '1' } catch { return false } }
  const [on, setOn] = useState(read)
  const toggle = () => setOn(v => {
    try { localStorage.setItem(key, v ? '0' : '1') } catch { /* storage unavailable */ }
    return !v
  })
  return [on, toggle]
}

export default function FormalisationTab() {
  const state = useOrmStore(useShallow(s => ({
    objectTypes: s.objectTypes, facts: s.facts, subtypes: s.subtypes, constraints: s.constraints,
    diagrams: s.diagrams, activeDiagramId: s.activeDiagramId,
    selectedId: s.selectedId, multiSelectedIds: s.multiSelectedIds,
    selectedMandatoryDot: s.selectedMandatoryDot, selectedUniqueness: s.selectedUniqueness,
    selectedInternalFrequency: s.selectedInternalFrequency,
  })))
  const [showDisjoint, toggleDisjoint] = useToggle('freefbm.formalisation.disjointness')
  const [showParticipation, toggleParticipation] = useToggle('freefbm.formalisation.participation')

  const { entries, implicit, ctx, scope } = useMemo(() => formalise(state), [state])
  const sections = [
    showDisjoint && { title: 'Implicit disjointness constraints', items: implicit.disjointness,
      empty: 'There is only one subtype hierarchy, so there is nothing to keep disjoint.' },
    showParticipation && { title: 'Implicit participation constraints', items: implicit.participation,
      empty: 'Every type here is independent.' },
  ].filter(Boolean)

  return (
    <div>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap',
        fontSize: 11, color: 'var(--ink-2)', marginBottom: 8,
        paddingBottom: 4, borderBottom: '1px solid var(--border-soft)',
        userSelect: 'none',
      }}>
        <span>
          {scope === 'diagram' ? 'Constraints on this diagram' : 'Constraints in the selection'} ({entries.length})
        </span>
        <span style={{ flex: 1 }}/>
        <span style={{ display: 'inline-flex', gap: 6 }}>
          <ToggleButton on={showDisjoint} onClick={toggleDisjoint}
            title="Show that the roots of different subtype hierarchies are disjoint">Implicit disjointness</ToggleButton>
          <ToggleButton on={showParticipation} onClick={toggleParticipation}
            title="Show that instances of non-independent types play some role">Implicit participation</ToggleButton>
        </span>
        <Legend />
      </div>
      {entries.length === 0 && sections.length === 0
        ? <div style={{ fontSize: 12, color: 'var(--ink-muted)', fontStyle: 'italic' }}>
            {scope === 'diagram'
              ? 'This diagram has no constraints yet.'
              : 'The selection has no constraints. Select fact types or constraints to see their formulas.'}
          </div>
        : (
          /* Focusable so Cmd/Ctrl+A selects just these formulas (see App.jsx) */
          <div data-text-panel tabIndex={0} className="text-panel">
            {entries.map(e => <Entry key={e.key} e={e} ctx={ctx} />)}
            {sections.map(sec => (
              <div key={sec.title}>
                <div className="text-panel-section">{sec.title}</div>
                {sec.items.length
                  ? sec.items.map(e => <Entry key={e.key} e={e} ctx={ctx} />)
                  : <div style={{ fontSize: 12, color: 'var(--ink-muted)', fontStyle: 'italic', marginBottom: 10 }}>{sec.empty}</div>}
              </div>
            ))}
          </div>
        )}
    </div>
  )
}

function Entry({ e, ctx }) {
  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{ fontSize: 10, color: 'var(--ink-muted)', letterSpacing: '0.04em', marginBottom: 2 }}>
        {e.kind}{e.subject ? ` · ${e.subject}` : ''}
      </div>
      {e.formula
        ? <Formula formula={e.formula} ctx={ctx} />
        : <div style={{ fontSize: 12, color: 'var(--ink-muted)', fontStyle: 'italic' }}>{e.note}</div>}
    </div>
  )
}

function ToggleButton({ on, onClick, title, children }) {
  return (
    <button type="button" aria-pressed={on} onClick={onClick} title={title} style={{
      fontSize: 10, padding: '1px 8px', borderRadius: 10, cursor: 'pointer',
      border: `1px solid ${on ? 'var(--accent)' : 'var(--border-soft)'}`,
      background: on ? 'var(--bg-text-panel)' : 'transparent',
      color: on ? 'var(--accent)' : 'var(--ink-muted)',
    }}>{on ? '✓ ' : ''}{children}</button>
  )
}

function Formula({ formula, ctx }) {
  const tokens = useMemo(() => renderFormula(formula, ctx), [formula, ctx])
  return (
    <div style={{ fontFamily: 'var(--font-mono)', fontSize: 12, lineHeight: 1.6, whiteSpace: 'pre-wrap', userSelect: 'text' }}>
      {tokens.map((t, i) => t.sup
        ? <sup key={i} style={{ ...TOKEN_STYLE.op, fontSize: '0.75em' }}>{t.text}</sup>
        : <span key={i} style={TOKEN_STYLE[t.cls]}>{t.text}</span>)}
    </div>
  )
}

function Legend() {
  const item = (cls, label) => (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
      <span style={{ width: 8, height: 8, borderRadius: 2, background: TOKEN_STYLE[cls].color }}/>
      {label}
    </span>
  )
  return (
    <span style={{ display: 'inline-flex', gap: 12, fontSize: 10, color: 'var(--ink-muted)' }}>
      {item('var', 'variable')}
      {item('reading', 'reading')}
      {item('type', 'object type')}
      {item('op', 'logic')}
    </span>
  )
}
