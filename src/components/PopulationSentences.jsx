import React, { useMemo, useState } from 'react'
import { useScopedStore } from '../store/ormStore'
import { makeContext } from '../logic/constraintFormulas.js'
import { populationSentences } from '../verbalisation/population.js'
import { useVerbalisation } from '../verbalisation/workbench.js'
import { SENTENCE_STYLE } from './ConstraintsTab.jsx'

const PAGE = 200

// The population of the selected object type or fact type as sentences
// (src/verbalisation/population.js), with a filter and 200 rows per page as
// in the table view.
export default function PopulationSentences({ elementId }) {
  const store = useScopedStore()
  const verbaliser = useVerbalisation(store.viewLanguage)
  const language = verbaliser.language
  const { objectTypes, facts, subtypes, constraints, populations, factPopulations, nestedEntityMappings,
    subtypeMappings, populationIssues, viewLanguage, objectTypeNameDisplay, removeNameCharacters } = store
  const result = useMemo(() => {
    const data = { objectTypes, facts, subtypes, constraints, populations, factPopulations, nestedEntityMappings,
      subtypeMappings, viewLanguage, objectTypeNameDisplay, removeNameCharacters }
    try {
      return populationSentences(data, makeContext(data), language, elementId, populationIssues ?? [])
    } catch (err) {
      return { rows: [], keyLines: [], error: err.message }
    }
  }, [objectTypes, facts, subtypes, constraints, populations, factPopulations, nestedEntityMappings,
    subtypeMappings, populationIssues, viewLanguage, objectTypeNameDisplay, removeNameCharacters, language, elementId])
  const [filter, setFilter] = useState('')
  const [page, setPage] = useState(0)

  const f = filter.trim().toLowerCase()
  const rows = f ? result.rows.filter(r => r.text.toLowerCase().includes(f)) : result.rows
  const pages = Math.max(1, Math.ceil(rows.length / PAGE))
  const at = Math.min(page, pages - 1)
  const shown = rows.slice(at * PAGE, (at + 1) * PAGE)
  const identified = result.identified
    ? (objectTypes.find(o => o.id === result.identified)?.name ?? facts.find(x => x.id === result.identified)?.objectifiedName)
    : null

  return (
    <div>
      {identified && (
        <div style={{ fontSize: 11, color: 'var(--ink-muted)', marginBottom: 8, maxWidth: 560 }}>
          This fact type identifies <strong>{identified}</strong>, so its instances are shown.
        </div>
      )}
      {!language.population && viewLanguage && viewLanguage !== 'en' && (
        <div style={{ fontSize: 11, color: 'var(--ink-muted)', marginBottom: 8 }}>
          The fixed words of these sentences are in English for now.
        </div>
      )}
      {result.error && (
        <div data-text-panel tabIndex={0} className="copyable" style={{ fontSize: 11, color: '#b91c1c', marginBottom: 8 }}>
          The population cannot be computed: {result.error}
        </div>
      )}
      {result.rows.length > 20 && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, fontSize: 11 }}>
          <input type="search" value={filter} placeholder="Filter sentences"
            onChange={e => { setFilter(e.target.value); setPage(0) }}
            style={{ fontSize: 11, padding: '2px 6px', width: 220 }}/>
          {pages > 1 && (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: 'var(--ink-muted)' }}>
              <button type="button" className="ui-btn" disabled={at === 0} onClick={() => setPage(at - 1)}>‹</button>
              {at * PAGE + 1}–{Math.min(rows.length, (at + 1) * PAGE)} of {rows.length}
              <button type="button" className="ui-btn" disabled={at >= pages - 1} onClick={() => setPage(at + 1)}>›</button>
            </span>
          )}
        </div>
      )}
      {result.rows.length === 0 && !result.error
        ? <div style={{ fontSize: 12, color: 'var(--ink-muted)', fontStyle: 'italic' }}>The population is empty.</div>
        : (
          <div data-text-panel tabIndex={0} className="text-panel">
            {result.keyLines.map((k, i) => (
              <div key={`k${i}`} style={{ fontSize: 12, color: 'var(--ink-muted)', marginBottom: 2 }}>
                <Tokens tokens={k.tokens}/>
              </div>
            ))}
            {result.keyLines.length > 0 && <div style={{ height: 6 }}/>}
            {shown.map((r, i) => (
              <div key={i} title={r.problems.length ? r.problems.join('\n') : undefined}
                style={{ fontSize: 13, lineHeight: 1.5, userSelect: 'text', display: 'flex', gap: 6, alignItems: 'baseline' }}>
                <span><Tokens tokens={r.tokens}/>
                  {r.derived && <span style={{ fontSize: 11, color: 'var(--ink-muted)', fontStyle: 'italic' }}> ({result.derivedLabel ?? 'derived'})</span>}
                </span>
                {r.problems.length > 0 && (
                  <span style={{ fontSize: 11, color: 'var(--danger, #b91c1c)' }}>⚠ {r.problems.join('; ')}</span>
                )}
              </div>
            ))}
          </div>
        )}
    </div>
  )
}

function Tokens({ tokens }) {
  return tokens.map((t, i) => (
    <React.Fragment key={i}>{t.space ? ' ' : ''}<span style={SENTENCE_STYLE[t.cls]}>{t.text}</span></React.Fragment>
  ))
}
