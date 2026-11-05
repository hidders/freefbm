// The Constraints tab of a relational schema showing its tables (RM schemas
// first-class, step 4): each table's NOT NULLs, keys, foreign keys and
// CHECKs, and the schema's assertions, as table sentences (rmText.js), as
// SQL, or both, with the sample rows that break them. The selected table's
// constraints, or the whole schema's.

import React, { useMemo, useState } from 'react'
import { useOrmStore } from '../store/ormStore'
import { activeSchemaIdOf, scopeToSchema } from '../store/storeHelpers'
import { relationalView } from '../relational/relationalView'
import { rmSentence, rmViolations, selectedTableId } from '../relational/rmText'
import { formalise } from '../logic/constraintFormulas.js'
import { useVerbalisation, languageInfo } from '../verbalisation/workbench.js'
import { Sentence } from './ConstraintsTab'

const VIEWS = [
  { id: 'sentences', label: 'Sentences', title: 'Say what each constraint requires of the rows' },
  { id: 'sql', label: 'SQL', title: 'Show each constraint as the DDL export writes it' },
  { id: 'both', label: 'Both', title: 'Show each sentence with its SQL underneath' },
]
const KEY = 'freefbm.constraints.rmView'
const readView = () => { try { const v = localStorage.getItem(KEY); return VIEWS.some(x => x.id === v) ? v : 'sentences' } catch { return 'sentences' } }

export default function RelationalConstraints() {
  const schemaId = useOrmStore(s => activeSchemaIdOf(s))
  const objectTypes = useOrmStore(s => s.objectTypes)
  const facts = useOrmStore(s => s.facts)
  const constraints = useOrmStore(s => s.constraints)
  const issues = useOrmStore(s => s.populationIssues)
  const viewLanguage = useOrmStore(s => s.viewLanguage)
  const selected = useOrmStore(s => selectedTableId(s, relationalView(s, schemaId)))
  const [view, setViewState] = useState(readView)
  const setView = (v) => { setViewState(v); try { localStorage.setItem(KEY, v) } catch { /* storage unavailable */ } }
  const [whole, setWhole] = useState(false)
  const verbaliser = useVerbalisation(viewLanguage)

  const { rm, violations, sentences } = useMemo(() => {
    const st = useOrmStore.getState()
    const rm = relationalView(st, schemaId)
    // Assertions say in ORM2 terms what they require (they have no table form).
    const { entries, ctx } = rm.assertions.length ? formalise(scopeToSchema(st), { wholeSchema: true }) : { entries: [], ctx: null }
    const sentences = new Map()
    for (const a of rm.assertions) {
      const [cId, i] = a.rmId.slice(3).split(':')
      const e = entries.filter(x => x.elementId === cId)[Number(i ?? 0)]
      if (e?.formula) sentences.set(a.rmId, { formula: e.formula, ctx })
    }
    return { rm, violations: rmViolations(rm, issues), sentences }
  }, [schemaId, objectTypes, facts, constraints, issues])

  const tableObj = selected && !whole ? rm.objects.get(`table:${selected}`) : null
  const tables = tableObj ? [tableObj.base ? rm.objects.get(tableObj.base) : tableObj] : rm.tables.filter(t => t.keys.length)
  const groups = tables.map(t => ({ title: t.name, items: t.keys.map(id => rm.objects.get(id)).filter(Boolean) }))
  if (!tableObj && rm.assertions.length) groups.push({ title: 'Assertions', items: rm.assertions })
  const count = groups.reduce((a, g) => a + g.items.length, 0)
  const broken = groups.reduce((a, g) => a + g.items.filter(o => violations.has(o.rmId)).length, 0)

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap', fontSize: 11, color: 'var(--ink-2)',
        marginBottom: 8, paddingBottom: 4, borderBottom: '1px solid var(--border-soft)', userSelect: 'none' }}>
        <span>{tableObj ? `Constraints of ${tableObj.name}` : 'Constraints of the tables'} ({count}){broken ? ` · ${broken} broken by the rows` : ''}</span>
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
        {selected && (
          <button type="button" aria-pressed={whole} onClick={() => setWhole(w => !w)}
            title="List the constraints of every table, not only the selected one" style={{
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
                {(groups.length > 1 || !tableObj) && <div className="text-panel-section">{g.title}</div>}
                {g.items.map(o => <RmEntry key={o.rmId} rm={rm} o={o} view={view} broken={violations.get(o.rmId)}
                  formula={sentences.get(o.rmId)} language={verbaliser.language} lang={languageInfo(viewLanguage).id} />)}
              </div>
            ))}
          </div>
        )}
    </div>
  )
}

function RmEntry({ rm, o, view, broken, formula, language, lang }) {
  const sentence = o.kind === 'assertion' ? null : rmSentence(rm, o, { lang })
  const col = o.kind === 'notNull' ? rm.objects.get(o.columns[0]) : null
  const sql = col ? `${col.name} ${col.type ?? ''} NOT NULL` : o.sql
  const select = () => {
    const st = useOrmStore.getState()
    if (o.members?.[0]) st.selectRm(o)
  }
  return (
    <div className="rm-constraint" style={{ marginBottom: 10 }}>
      <div onClick={select} style={{ fontSize: 10, color: 'var(--ink-muted)', letterSpacing: '0.04em', marginBottom: 2, cursor: 'pointer' }}>
        {o.label}{o.enforced ? '' : ' · not enforced'}
        {o.kind === 'assertion' && !o.query && ' · no SQL form'}
      </div>
      {view !== 'sql' && (sentence
        ? <div style={{ fontSize: 13, lineHeight: 1.5, userSelect: 'text' }}>{sentence}</div>
        : formula ? <Sentence formula={formula.formula} ctx={formula.ctx} language={language} /> : null)}
      {view !== 'sentences' && sql && (
        <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11, whiteSpace: 'pre-wrap', userSelect: 'text',
          opacity: view === 'both' ? 0.75 : 1 }}>{o.kind === 'assertion' ? `-- rows that break it:\n${sql}` : sql}</div>
      )}
      {o.kind === 'assertion' && !o.query && o.error && view !== 'sentences' && (
        <div style={{ fontSize: 11, color: 'var(--ink-muted)', fontStyle: 'italic' }}>{o.error}</div>
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
