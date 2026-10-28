import React, { useMemo, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useOrmStore } from '../store/ormStore'
import { formalise } from '../logic/constraintFormulas.js'
import { renderFormula } from '../logic/renderFormula.js'
import { verbalise } from '../verbalisation/engine.js'
import { english } from '../verbalisation/languages/english.js'

// ── Constraints tab ─────────────────────────────────────────────────────────
// Lists every constraint in the selected part of the diagram (or, when
// nothing is selected, the whole diagram or the whole schema, as the scope
// switch says), optionally followed by the implicit disjointness,
// participation and implied-link constraints. The view switch shows each
// constraint as an English sentence, as its logic formula, or both.

export const TOKEN_STYLE = {
  var:     { color: 'var(--formula-var)', fontWeight: 600 },
  reading: { color: 'var(--formula-reading)' },
  type:    { color: 'var(--formula-type)', fontWeight: 600 },
  op:      { color: 'var(--formula-op)' },
  fn:      { color: 'var(--formula-fn)' },
  const:   { color: 'var(--formula-const)' },
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

const VIEWS = [
  { id: 'sentences', label: 'Sentences', title: 'Show each constraint as an English sentence' },
  { id: 'formulas',  label: 'Formulas',  title: 'Show each constraint as a formula of the logic' },
  { id: 'both',      label: 'Both',      title: 'Show each sentence with its formula underneath' },
]
const VIEW_KEY = 'freefbm.constraints.view'

// The chosen view, remembered across sessions; sentences by default.
function useView() {
  const read = () => {
    try { const v = localStorage.getItem(VIEW_KEY); return VIEWS.some(x => x.id === v) ? v : 'sentences' } catch { return 'sentences' }
  }
  const [view, setView] = useState(read)
  const choose = (v) => {
    setView(v)
    try { localStorage.setItem(VIEW_KEY, v) } catch { /* storage unavailable */ }
  }
  return [view, choose]
}

// Sentence token colours: object types and readings as in the formulas,
// fixed words in the logic colour.
const SENTENCE_STYLE = {
  kw:      { color: 'var(--formula-op)' },
  type:    TOKEN_STYLE.type,
  reading: TOKEN_STYLE.reading,
  const:   TOKEN_STYLE.const,
  punct:   { color: 'var(--ink-2)' },
}

export default function ConstraintsTab() {
  const state = useOrmStore(useShallow(s => ({
    objectTypes: s.objectTypes, facts: s.facts, subtypes: s.subtypes, constraints: s.constraints,
    diagrams: s.diagrams, activeDiagramId: s.activeDiagramId,
    selectedId: s.selectedId, multiSelectedIds: s.multiSelectedIds,
    selectedMandatoryDot: s.selectedMandatoryDot, selectedUniqueness: s.selectedUniqueness,
    selectedInternalFrequency: s.selectedInternalFrequency, selectedValueRange: s.selectedValueRange,
    selectedCardinalityRange: s.selectedCardinalityRange,
  })))
  const [showDisjoint, toggleDisjoint] = useToggle('freefbm.formalisation.disjointness')
  const [showParticipation, toggleParticipation] = useToggle('freefbm.formalisation.participation')
  const [showLinks, toggleLinks] = useToggle('freefbm.formalisation.impliedLinks')
  const [wholeSchema, toggleWholeSchema] = useToggle('freefbm.formalisation.wholeSchema')
  const [view, setView] = useView()

  const { entries, implicit, ctx, scope } = useMemo(() => formalise(state, { wholeSchema }), [state, wholeSchema])
  const sections = [
    showDisjoint && { title: 'Implicit disjointness constraints', items: implicit.disjointness,
      empty: 'There is only one entity-type hierarchy, so there is nothing to keep disjoint.' },
    showParticipation && { title: 'Implicit participation constraints', items: implicit.participation,
      empty: 'Every type here is independent.' },
    showLinks && { title: 'Implied link constraints', items: implicit.impliedLinks,
      empty: 'There are no nested fact types here.' },
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
          {scope === 'selection' ? 'Constraints in the selection'
            : scope === 'schema' ? 'Constraints in the whole schema' : 'Constraints on this diagram'} ({entries.length})
        </span>
        <ViewSwitch view={view} onChange={setView} />
        <ToggleButton on={wholeSchema} onClick={toggleWholeSchema}
          title="With nothing selected, list the constraints of the whole schema instead of only this diagram">Whole schema</ToggleButton>
        <span style={{ flex: 1 }}/>
        <span style={{ display: 'inline-flex', gap: 6 }}>
          <ToggleButton on={showDisjoint} onClick={toggleDisjoint}
            title="Show that the roots of different entity-type hierarchies are disjoint">Implicit disjointness</ToggleButton>
          <ToggleButton on={showParticipation} onClick={toggleParticipation}
            title="Show that instances of non-independent types play some role">Implicit participation</ToggleButton>
          <ToggleButton on={showLinks} onClick={toggleLinks}
            title="Show how a nested fact type relates to its implied link fact types">Implied links</ToggleButton>
        </span>
        {view === 'sentences' ? <SentenceLegend /> : <Legend />}
      </div>
      {entries.length === 0 && sections.length === 0
        ? <div style={{ fontSize: 12, color: 'var(--ink-muted)', fontStyle: 'italic' }}>
            {scope === 'diagram' ? 'This diagram has no constraints yet.'
              : scope === 'schema' ? 'The schema has no constraints yet.'
              : 'The selection has no constraints. Select fact types or constraints to see them.'}
          </div>
        : (
          /* Focusable so Cmd/Ctrl+A selects just what is shown here (see App.jsx) */
          <div data-text-panel tabIndex={0} className="text-panel">
            {entries.map(e => <Entry key={e.key} e={e} ctx={ctx} view={view} />)}
            {sections.map(sec => (
              <div key={sec.title}>
                <div className="text-panel-section">{sec.title}</div>
                {sec.items.length
                  ? sec.items.map(e => <Entry key={e.key} e={e} ctx={ctx} view={view} />)
                  : <div style={{ fontSize: 12, color: 'var(--ink-muted)', fontStyle: 'italic', marginBottom: 10 }}>{sec.empty}</div>}
              </div>
            ))}
          </div>
        )}
    </div>
  )
}

function Entry({ e, ctx, view }) {
  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{ fontSize: 10, color: 'var(--ink-muted)', letterSpacing: '0.04em', marginBottom: 2 }}>
        {e.kind}{e.subject ? ` · ${e.subject}` : ''}
      </div>
      {e.formula
        ? <>
            {view !== 'formulas' && <Sentence formula={e.formula} ctx={ctx} />}
            {view === 'formulas' && <Formula formula={e.formula} ctx={ctx} />}
            {view === 'both' && <div style={{ opacity: 0.75, fontSize: 11 }}><Formula formula={e.formula} ctx={ctx} /></div>}
          </>
        : <div style={{ fontSize: 12, color: 'var(--ink-muted)', fontStyle: 'italic' }}>{e.note}</div>}
    </div>
  )
}

// A formula's English verbalisation. Hovering shows the rules that built it.
function Sentence({ formula, ctx }) {
  const result = useMemo(() => {
    try { return verbalise(formula, ctx, english) } catch (err) { return { error: err.message } }
  }, [formula, ctx])
  if (result.error) {
    return <div style={{ fontSize: 12, color: 'var(--ink-muted)', fontStyle: 'italic' }}>No verbalisation: {result.error}</div>
  }
  return (
    <div title={`Rules: ${result.trace.join(' › ')}`}
      style={{ fontSize: 13, lineHeight: 1.5, whiteSpace: 'pre-wrap', userSelect: 'text', marginBottom: 1 }}>
      {result.tokens.map((t, i) => (
        <React.Fragment key={i}>{t.space ? ' ' : ''}<span style={SENTENCE_STYLE[t.cls]}>{t.text}</span></React.Fragment>
      ))}
    </div>
  )
}

// Segmented Sentences | Formulas | Both switch.
function ViewSwitch({ view, onChange }) {
  return (
    <span role="radiogroup" aria-label="Show constraints as" style={{
      display: 'inline-flex', border: '1px solid var(--border-soft)', borderRadius: 10, overflow: 'hidden',
    }}>
      {VIEWS.map((v, i) => {
        const on = v.id === view
        return (
          <button key={v.id} type="button" role="radio" aria-checked={on} title={v.title} onClick={() => onChange(v.id)} style={{
            fontSize: 10, padding: '1px 9px', cursor: 'pointer', border: 'none',
            borderLeft: i ? '1px solid var(--border-soft)' : 'none',
            background: on ? 'var(--bg-text-panel)' : 'transparent',
            color: on ? 'var(--accent)' : 'var(--ink-muted)',
            fontWeight: on ? 600 : 400,
          }}>{v.label}</button>
        )
      })}
    </span>
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

export function Formula({ formula, ctx }) {
  const tokens = useMemo(() => renderFormula(formula, ctx), [formula, ctx])
  return (
    <div style={{ fontFamily: 'var(--font-mono)', fontSize: 12, lineHeight: 1.6, whiteSpace: 'pre-wrap', userSelect: 'text' }}>
      {tokens.map((t, i) => t.sup
        // A range bound n..m copies as ^{n..m}, so it stays readable as text.
        ? (t.text.includes('..')
          ? <React.Fragment key={i}>
              <span className="copy-only">^{'{'}</span>
              <sup style={{ ...TOKEN_STYLE.op, fontSize: '0.75em' }}>{t.text}</sup>
              <span className="copy-only">{'}'}</span>
            </React.Fragment>
          : <sup key={i} style={{ ...TOKEN_STYLE.op, fontSize: '0.75em' }}>{t.text}</sup>)
        : t.sub
          // A run of subscript tokens (TC's bound variables) copies as _{…}.
          ? <React.Fragment key={i}>
              {!tokens[i - 1]?.sub && <span className="copy-only">_{'{'}</span>}
              <sub style={{ ...TOKEN_STYLE[t.cls], fontSize: '0.75em' }}>{t.text}</sub>
              {!tokens[i + 1]?.sub && <span className="copy-only">{'}'}</span>}
            </React.Fragment>
          : <span key={i} style={TOKEN_STYLE[t.cls]}>{t.text}</span>)}
    </div>
  )
}

function SentenceLegend() {
  const item = (style, label) => (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
      <span style={{ width: 8, height: 8, borderRadius: 2, background: style.color }}/>
      {label}
    </span>
  )
  return (
    <span style={{ display: 'inline-flex', gap: 12, fontSize: 10, color: 'var(--ink-muted)' }}>
      {item(SENTENCE_STYLE.type, 'object type')}
      {item(SENTENCE_STYLE.reading, 'reading')}
      {item(SENTENCE_STYLE.kw, 'keyword')}
      {item(SENTENCE_STYLE.const, 'value')}
    </span>
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
      {item('fn', 'data operator')}
      {item('const', 'value')}
    </span>
  )
}
