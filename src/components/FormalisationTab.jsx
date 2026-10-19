import React, { useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useOrmStore } from '../store/ormStore'
import { formalise } from '../logic/constraintFormulas.js'
import { renderFormula } from '../logic/renderFormula.js'

// ── Formalisation tab ───────────────────────────────────────────────────────
// Lists the logic formula behind every constraint in the selected part of the
// diagram (or the whole diagram when nothing is selected).

const TOKEN_STYLE = {
  var:     { color: 'var(--formula-var)', fontWeight: 600 },
  reading: { color: 'var(--formula-reading)' },
  type:    { color: 'var(--formula-type)', fontWeight: 600 },
  op:      { color: 'var(--formula-op)' },
  punct:   { color: 'var(--ink-3)' },
}

export default function FormalisationTab() {
  const state = useOrmStore(useShallow(s => ({
    objectTypes: s.objectTypes, facts: s.facts, subtypes: s.subtypes, constraints: s.constraints,
    diagrams: s.diagrams, activeDiagramId: s.activeDiagramId,
    selectedId: s.selectedId, multiSelectedIds: s.multiSelectedIds,
    selectedMandatoryDot: s.selectedMandatoryDot, selectedUniqueness: s.selectedUniqueness,
    selectedInternalFrequency: s.selectedInternalFrequency,
  })))

  const { entries, ctx, scope } = useMemo(() => formalise(state), [state])

  if (entries.length === 0) {
    return (
      <div style={{ fontSize: 12, color: 'var(--ink-muted)', fontStyle: 'italic' }}>
        {scope === 'diagram'
          ? 'This diagram has no constraints yet.'
          : 'The selection has no constraints. Select fact types or constraints to see their formulas.'}
      </div>
    )
  }

  return (
    <div>
      <div style={{
        display: 'flex', alignItems: 'baseline', gap: 16, flexWrap: 'wrap',
        fontSize: 11, color: 'var(--ink-2)', marginBottom: 8,
        paddingBottom: 4, borderBottom: '1px solid var(--border-soft)',
      }}>
        <span>
          {scope === 'diagram' ? 'Constraints on this diagram' : 'Constraints in the selection'} ({entries.length})
        </span>
        <span style={{ flex: 1 }}/>
        <Legend />
      </div>
      {entries.map(e => (
        <div key={e.key} style={{ marginBottom: 10 }}>
          <div style={{ fontSize: 10, color: 'var(--ink-muted)', letterSpacing: '0.04em', marginBottom: 2 }}>
            {e.kind}{e.subject ? ` · ${e.subject}` : ''}
          </div>
          {e.formula
            ? <Formula formula={e.formula} ctx={ctx} />
            : <div style={{ fontSize: 12, color: 'var(--ink-muted)', fontStyle: 'italic' }}>{e.note}</div>}
        </div>
      ))}
    </div>
  )
}

function Formula({ formula, ctx }) {
  const tokens = useMemo(() => renderFormula(formula, ctx), [formula, ctx])
  return (
    <div style={{ fontFamily: 'var(--font-mono)', fontSize: 12, lineHeight: 1.6, whiteSpace: 'pre-wrap', userSelect: 'text' }}>
      {tokens.map((t, i) => t.sup
        ? <sup key={i} style={{ ...TOKEN_STYLE.op, fontSize: '0.75em' }}>{t.text}</sup>
        : t.sub
          ? <sub key={i} style={{ ...TOKEN_STYLE[t.cls], fontSize: '0.75em' }}>{t.text}</sub>
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
