// The schema browser's sections for a mapping diagram (diagram.mappingId):
// the mapping's rules rather than the elements of its two schemas, since a
// mapping diagram is a subset of the rules (diagram.mappingRuleIds) and the
// elements they name come along. + puts a rule on the diagram with its
// elements (store.showMappingRules), − takes it off with the elements no
// other rule on the diagram needs (store.hideMappingRules).

import React, { useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useOrmStore } from '../store/ormStore'
import { diagramRuleIds, isViewMapping } from '../store/storeHelpers'
import { Highlight } from '../utils/nameFilter.jsx'
import { checkRule, sideContext, sideTokens, tokensText, SIDES } from '../mapping/mapping.js'
import { checkViewRule, viewRuleText, headId, elementName } from '../mapping/views.js'

const FONT = 'var(--font-ui)'

// Per rule of the mapping: its label, formula and number of errors/warnings.
export function useMappingRuleInfos(mapping) {
  const state = useOrmStore(useShallow(s => ({
    schemas: s.schemas, objectTypes: s.objectTypes, facts: s.facts, constraints: s.constraints, subtypes: s.subtypes,
    views: s.views,
  })))
  return useMemo(() => {
    if (!mapping) return []
    const isView = isViewMapping(state, mapping)
    const ctxs = isView ? null : { source: sideContext(state, mapping.sourceSchemaId), target: sideContext(state, mapping.targetSchemaId) }
    return mapping.rules.map((r, k) => {
      let issues = [], formula = ''
      try {
        issues = isView ? checkViewRule(state, mapping, r).map(i => ({ severity: i.severity })) : checkRule(r, mapping, state, ctxs)
        formula = isView ? viewRuleText(state, mapping, r) : SIDES.map(side => tokensText(sideTokens(r[side], ctxs[side]))).join('  ⟺  ')
      } catch { /* a broken rule still gets a row */ }
      const head = isView ? state.objectTypes.find(o => o.id === headId(r)) ?? state.facts.find(f => f.id === headId(r)) : null
      const label = r.name || (head ? elementName(head, state) : `Rule ${k + 1}`)
      const errors = issues.filter(i => i.severity === 'error').length
      return { r, k, label, formula, errors, warnings: issues.length - errors }
    })
  }, [mapping, state])
}

// Rules of the mapping that no diagram of it draws.
export function mappingRuleOrphanCount(mapping, diagrams) {
  if (!mapping) return 0
  const mine = diagrams.filter(d => d.mappingId === mapping.id)
  return mapping.rules.filter(r => !mine.some(d => diagramRuleIds(d, mapping).has(r.id))).length
}

// The diagram point where a rule's node is drawn (MappingLayer.jsx), or null.
function ruleNodePoint(ruleId) {
  const g = document.querySelector(`.mapping-rule[data-rule-id="${CSS.escape(ruleId)}"] > g[transform]`)
  const m = g?.getAttribute('transform')?.match(/translate\(\s*([-\d.e]+)[ ,]+([-\d.e]+)\s*\)/)
  return m ? { x: Number(m[1]), y: Number(m[2]) } : null
}

function SlotButton({ title, onClick, children, danger = false }) {
  const color = danger ? 'var(--danger)' : 'var(--ink-muted)'
  const border = danger ? '#e0b0a8' : 'var(--border)'
  const hot = danger ? 'var(--danger)' : '#1e3a8a'
  return (
    <button title={title}
      onMouseDown={e => e.stopPropagation()}
      onClick={e => { e.stopPropagation(); onClick() }}
      style={{ background: 'none', border: `1px solid ${border}`, borderRadius: 3, cursor: 'pointer', padding: '2px 4px',
        width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', color }}
      onMouseEnter={e => { e.currentTarget.style.background = hot; e.currentTarget.style.color = 'white'; e.currentTarget.style.borderColor = hot }}
      onMouseLeave={e => { e.currentTarget.style.background = 'none'; e.currentTarget.style.color = color; e.currentTarget.style.borderColor = border }}
    >{children}</button>
  )
}

const PLUS = (
  <svg width="9" height="9" viewBox="0 0 9 9" style={{ display: 'block' }}>
    <rect x="3.5" y="0" width="2" height="9" rx="0.5" fill="currentColor"/>
    <rect x="0" y="3.5" width="9" height="2" rx="0.5" fill="currentColor"/>
  </svg>
)
const MINUS = (
  <svg width="9" height="9" viewBox="0 0 9 9" style={{ display: 'block' }}>
    <rect x="0" y="3.5" width="9" height="2" rx="0.5" fill="currentColor"/>
  </svg>
)

// The sections, in SchemaBrowser's format: [{ title, items, renderRow, total? }].
export function mappingRuleSections({ mapping, infos, diagram, diagrams, showOrphans, filter, editingRuleId, onMenu }) {
  if (!mapping || !diagram) return []
  const st = () => useOrmStore.getState()
  const isView = isViewMapping(st(), mapping)
  const on = diagramRuleIds(diagram, mapping)
  const mine = diagrams.filter(d => d.mappingId === mapping.id)
  const orphan = (id) => !mine.some(d => diagramRuleIds(d, mapping).has(id))
  const open = (info) => {
    const s = st()
    if (on.has(info.r.id)) { const p = ruleNodePoint(info.r.id); if (p) s.centerOnPoint(p.x, p.y) }
    if (isView) s.openViewRuleEditor(mapping.id, info.r.id)
    else s.openMappingRuleEditor(mapping.id, info.r.id)
  }
  // Adds the rule and brings its node into view.
  const addRule = (id) => {
    st().showMappingRules(diagram.id, [id])
    const p = st().diagrams.find(d => d.id === diagram.id)?.mappingRulePositions?.[id]
    if (p) st().centerOnPoint(p.x, p.y)
  }
  const row = (info) => {
    const here = on.has(info.r.id)
    const lone = orphan(info.r.id)
    const selected = editingRuleId === info.r.id
    const bg = selected ? 'var(--bg-raised)' : lone ? 'rgba(192,57,43,0.04)' : ''
    return (
      <div key={info.r.id} className="mapping-browser-row" data-rule-id={info.r.id} data-on-diagram={here ? 'true' : 'false'}
        onClick={() => open(info)}
        onContextMenu={e => onMenu?.(e, info)}
        title={`${info.label}: ${info.formula}${here ? '' : '\nNot on this diagram'}`}
        style={{ display: 'flex', alignItems: 'center', padding: '3px 8px', borderBottom: '1px solid var(--border-soft)',
          cursor: 'pointer', background: bg || undefined }}
        onMouseEnter={e => { e.currentTarget.style.background = 'var(--bg-raised)' }}
        onMouseLeave={e => { e.currentTarget.style.background = bg }}
      >
        <div style={{ width: 22, flexShrink: 0, marginRight: 5 }}>
          {!here && <SlotButton title="Add to this diagram, with the elements it names" onClick={() => addRule(info.r.id)}>{PLUS}</SlotButton>}
        </div>
        <span style={{ flexShrink: 0, marginRight: 5, fontSize: 11, fontWeight: 700, color: 'var(--map-source)', width: 14, textAlign: 'center' }}>
          {isView ? '⇒' : '⟺'}
        </span>
        <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 11, fontFamily: FONT,
          color: here ? undefined : 'var(--ink-3)' }}>
          <Highlight text={info.label} filter={filter} />
          {info.formula && <span style={{ color: 'var(--ink-3)', marginLeft: 6 }}><Highlight text={info.formula} filter={filter} /></span>}
        </span>
        {(info.errors > 0 || info.warnings > 0) && (
          <span title={`${info.errors ? `${info.errors} error${info.errors === 1 ? '' : 's'}` : ''}${info.errors && info.warnings ? ', ' : ''}${info.warnings ? `${info.warnings} warning${info.warnings === 1 ? '' : 's'}` : ''}`}
            style={{ width: 7, height: 7, borderRadius: 4, flexShrink: 0, marginLeft: 4, background: info.errors ? 'var(--danger)' : '#d97706' }} />
        )}
        {lone && <span title="Not on any diagram of this mapping" style={{ fontSize: 8, color: 'var(--danger)', marginLeft: 4 }}>●</span>}
        {here && (
          <div style={{ width: 22, flexShrink: 0, marginLeft: 4 }}>
            <SlotButton danger title="Remove from this diagram (the elements no other rule here names go too)" onClick={() => st().hideMappingRules(diagram.id, [info.r.id])}>{MINUS}</SlotButton>
          </div>
        )}
      </div>
    )
  }
  const match = (info) => filter.test(info.label, info.formula)
  const narrow = (items) => (filter ? { total: items.length, items: items.filter(match) } : { items })
  const listed = showOrphans ? infos.filter(i => orphan(i.r.id)) : infos
  const shown = listed.filter(i => on.has(i.r.id))
  const hidden = listed.filter(i => !on.has(i.r.id))
  return [
    { title: 'Rules on this diagram', ...narrow(shown), renderRow: row },
    { title: 'Other rules', ...narrow(hidden), renderRow: row },
  ].filter(s => s.items.length)
}
