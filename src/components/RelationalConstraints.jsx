// The Constraints tab of a relational schema showing its tables (RM schemas
// first-class, step 4): each table's NOT NULLs, keys, foreign keys and
// CHECKs, and the schema's assertions, as table sentences (rmText.js), as
// formulas of the logic (as for an ORM2 schema; the SQL is in the
// Inspector), or both, with the sample rows that break them. The selected
// assertion, the selected table's constraints, or the whole schema's.

import React, { useMemo, useState } from 'react'
import { useOrmStore } from '../store/ormStore'
import { activeSchemaIdOf, scopeToSchema } from '../store/storeHelpers'
import { relationalView, rmObjectOfKey } from '../relational/relationalView'
import { rmSentence, rmViolations, selectedTableId, selectedRmObject } from '../relational/rmText'
import { formalise } from '../logic/constraintFormulas.js'
import { useVerbalisation, languageInfo } from '../verbalisation/workbench.js'
import { Sentence, Formula } from './ConstraintsTab'

const VIEWS = [
  { id: 'sentences', label: 'Sentences', title: 'Say what each constraint requires of the rows' },
  { id: 'formulas', label: 'Formulas', title: 'Show each constraint as a formula of the logic' },
  { id: 'both', label: 'Both', title: 'Show each sentence with its formula underneath' },
]
const KEY = 'freefbm.constraints.rmView'
const NOTHING_SELECTED = { selectedId: null, multiSelectedIds: [], selectedMandatoryDot: null, selectedUniqueness: null,
  selectedInternalFrequency: null, selectedValueRange: null, selectedCardinalityRange: null }
const readView = () => { try { const v = localStorage.getItem(KEY); return VIEWS.some(x => x.id === v) ? v : 'sentences' } catch { return 'sentences' } }

export default function RelationalConstraints() {
  const schemaId = useOrmStore(s => activeSchemaIdOf(s))
  const objectTypes = useOrmStore(s => s.objectTypes)
  const facts = useOrmStore(s => s.facts)
  const constraints = useOrmStore(s => s.constraints)
  const issues = useOrmStore(s => s.populationIssues)
  const viewLanguage = useOrmStore(s => s.viewLanguage)
  const selected = useOrmStore(s => selectedTableId(s, relationalView(s, schemaId)))
  const selectedAssertion = useOrmStore(s => {
    const o = selectedRmObject(s, relationalView(s, schemaId))
    return o?.kind === 'assertion' ? o.rmId : null
  })
  const [view, setViewState] = useState(readView)
  const setView = (v) => { setViewState(v); try { localStorage.setItem(KEY, v) } catch { /* storage unavailable */ } }
  const [whole, setWhole] = useState(false)
  const verbaliser = useVerbalisation(viewLanguage)

  const needFormulas = view !== 'sentences'
  const { rm, violations, formulas, ctx } = useMemo(() => {
    const st = useOrmStore.getState()
    const rm = relationalView(st, schemaId)
    // Assertions say in ORM2 terms what they require (they have no table
    // form); the formulas of the others are those of the ORM2 constraints
    // they stand for.
    // formalise lists only the selected elements' constraints while
    // something is selected, and this is not recomputed when the selection
    // changes, so it reads the schema with nothing selected.
    const scoped = { ...scopeToSchema(st), ...NOTHING_SELECTED }
    const { entries, ctx } = rm.assertions.length || needFormulas ? formalise(scoped, { wholeSchema: true }) : { entries: [], ctx: null }
    const formulas = new Map()
    const add = (rmId, f) => { if (!formulas.has(rmId)) formulas.set(rmId, []); formulas.get(rmId).push(f) }
    for (const a of rm.assertions) {
      const [cId, i] = a.rmId.slice(3).split(':')
      const e = entries.filter(x => x.elementId === cId)[Number(i ?? 0)]
      if (e?.formula) add(a.rmId, e.formula)
    }
    if (needFormulas) {
      for (const e of entries) {
        if (!e.formula || !e.key || e.key.includes(':possible:')) continue
        const o = rmObjectOfKey(rm, scoped.facts, e.key)
        if (o && o.kind !== 'assertion') add(o.rmId, e.formula)
      }
    }
    return { rm, violations: rmViolations(rm, issues), formulas, ctx }
  }, [schemaId, objectTypes, facts, constraints, issues, needFormulas])

  const assertionObj = selectedAssertion && !whole ? rm.objects.get(selectedAssertion) : null
  const tableObj = selected && !whole && !assertionObj ? rm.objects.get(`table:${selected}`) : null
  const tables = assertionObj ? [] : tableObj ? [tableObj.base ? rm.objects.get(tableObj.base) : tableObj] : rm.tables.filter(t => t.keys.length)
  const groups = tables.map(t => ({ title: t.name, items: t.keys.map(id => rm.objects.get(id)).filter(Boolean) }))
  if (assertionObj) groups.push({ title: 'Assertion', items: [assertionObj] })
  else if (!tableObj && rm.assertions.length) groups.push({ title: 'Assertions', items: rm.assertions })
  const scoped = tableObj || assertionObj
  const count = groups.reduce((a, g) => a + g.items.length, 0)
  const broken = groups.reduce((a, g) => a + g.items.filter(o => violations.has(o.rmId)).length, 0)

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap', fontSize: 11, color: 'var(--ink-2)',
        marginBottom: 8, paddingBottom: 4, borderBottom: '1px solid var(--border-soft)', userSelect: 'none' }}>
        <span>{assertionObj ? `Assertion ${assertionObj.name ?? assertionObj.label}` : tableObj ? `Constraints of ${tableObj.name}` : 'Constraints of the tables'} ({count}){broken ? ` · ${broken} broken by the rows` : ''}</span>
        <span role="radiogroup" aria-label="Show constraints as" style={{ display: 'inline-flex', border: '1px solid var(--border-soft)', borderRadius: 10, overflow: 'hidden' }}>
          {VIEWS.map((v, i) => {
            const on = v.id === view
            return (
              <button key={v.id} type="button" role="radio" aria-checked={on} title={v.title} onClick={() => setView(v.id)} style={{
                fontSize: 10, padding: '1px 9px', cursor: 'pointer', border: 'none', borderLeft: i ? '1px solid var(--border-soft)' : 'none',
                background: on ? 'var(--bg-text-panel)' : 'transparent', color: on ? 'var(--accent)' : 'var(--ink-muted)', fontWeight: on ? 600 : 400,
              }}>{v.label}</button>
            )
          })}
        </span>
        {(selected || selectedAssertion) && (
          <button type="button" aria-pressed={whole} onClick={() => setWhole(w => !w)}
            title={selectedAssertion ? 'List every constraint, not only the selected assertion' : 'List the constraints of every table, not only the selected one'} style={{
              fontSize: 10, padding: '1px 8px', borderRadius: 10, cursor: 'pointer',
              border: `1px solid ${whole ? 'var(--accent)' : 'var(--border-soft)'}`, background: whole ? 'var(--bg-text-panel)' : 'transparent',
              color: whole ? 'var(--accent)' : 'var(--ink-muted)' }}>{whole ? '✓ ' : ''}Whole schema</button>
        )}
      </div>
      {!count
        ? <div style={{ fontSize: 12, color: 'var(--ink-muted)', fontStyle: 'italic' }}>{tableObj ? 'This table has no constraints.' : 'The schema has no constraints.'}</div>
        : (
          <div data-text-panel tabIndex={0} className="text-panel">
            {groups.map(g => (
              <div key={g.title}>
                {(groups.length > 1 || !scoped) && <div className="text-panel-section">{g.title}</div>}
                {g.items.map(o => <RmEntry key={o.rmId} rm={rm} o={o} view={view} broken={violations.get(o.rmId)}
                  formulas={formulas.get(o.rmId) ?? []} ctx={ctx} language={verbaliser.language} lang={languageInfo(viewLanguage).id} />)}
              </div>
            ))}
          </div>
        )}
    </div>
  )
}

function RmEntry({ rm, o, view, broken, formulas, ctx, language, lang }) {
  const sentence = o.kind === 'assertion' ? null : rmSentence(rm, o, { lang })
  const select = () => {
    const st = useOrmStore.getState()
    if (o.members?.[0]) st.selectRm(o)
  }
  return (
    <div className="rm-constraint" style={{ marginBottom: 10 }}>
      <div onClick={select} style={{ fontSize: 10, color: 'var(--ink-muted)', letterSpacing: '0.04em', marginBottom: 2, cursor: 'pointer' }}>
        {o.label}
      </div>
      {view !== 'formulas' && (sentence
        ? <div style={{ fontSize: 13, lineHeight: 1.5, userSelect: 'text' }}>{sentence}</div>
        : formulas[0] ? <Sentence formula={formulas[0]} ctx={ctx} language={language} /> : null)}
      {view !== 'sentences' && formulas.map((f, i) => (
        <div key={i} style={view === 'both' ? { opacity: 0.75, fontSize: 11 } : undefined}><Formula formula={f} ctx={ctx} /></div>
      ))}
      {view !== 'sentences' && !formulas.length && (
        <div style={{ fontSize: 11, color: 'var(--ink-muted)', fontStyle: 'italic' }}>No formula.</div>
      )}
      {broken?.length > 0 && (
        <div style={{ fontSize: 11, color: 'var(--danger)', marginTop: 2 }}>
          {broken.length === 1 ? 'The rows break it:' : `The rows break it ${broken.length} times, e.g.:`}
          {broken.slice(0, 3).map((m, i) => <div key={i} style={{ marginLeft: 12 }}>{m}</div>)}
        </div>
      )}
    </div>
  )
}

// The table sentence of an object of a relational schema in the view
// language (rmText.js); when the object is not there (yet), the fallback: a
// sentence, or { [lang]: sentence }.
export function RmSentence({ schemaId, rmId, fallback = null, style = null }) {
  const lang = useOrmStore(s => languageInfo(s.viewLanguage).id)
  const text = useOrmStore(s => {
    const o = rmId ? relationalView(s, schemaId).objects.get(rmId) : null
    return o ? rmSentence(relationalView(s, schemaId), o, { lang }) : typeof fallback === 'object' && fallback ? fallback[lang] ?? fallback.en : fallback
  })
  return text ? <div style={{ fontSize: 13, lineHeight: 1.5, userSelect: 'text', ...style }}>{text}</div> : null
}
