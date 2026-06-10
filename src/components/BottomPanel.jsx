import React, { useCallback, useEffect, useId, useRef, useState } from 'react'
import { useOrmStore } from '../store/ormStore'
import { findRefMode, refModeLabel, getVtEffectivePopulation, getEntityEffectivePopulation, findCompositePI, findInheritedPI, findRolePlayer, getEntityIdentifierShape, getRoleCellShape, getNestedCellShape, isCompleteValue, UNSET } from '../utils/refMode'
import { datatypeAssignmentToKind } from '../utils/datatypeMapping.js'
import { computeRingConstraintRelation, computeUniquenessProjection, computeSequenceProjections, computeValueComparisonData, computeInclusiveOrTable, computeExclusiveOrTable, computeExclusionTable, computeEqualityTable, computeSubsetTable, freqRangeSatisfies, projCellKey, findLCAsForTypes, checkC1ForTypes } from '../utils/populationValidation.js'
import { BOTTOM_PANEL_TAB_STRIP_H } from '../constants.js'

const MIN_HEIGHT = 80
const MAX_HEIGHT_RATIO = 0.75   // panel can't exceed 75% of the viewport row

const TABS = [
  { id: 'population',    label: 'Population' },
  { id: 'verbalisation', label: 'Verbalisation' },
]

export default function BottomPanel() {
  const store     = useOrmStore()
  const expandedH = store.bottomPanelHeight
  const collapsed = store.bottomPanelCollapsed
  const tab       = store.bottomPanelTab
  const height    = collapsed ? BOTTOM_PANEL_TAB_STRIP_H : expandedH
  const containerRef = useRef(null)
  const resizeRef    = useRef(null)

  const onResizeMouseDown = useCallback((e) => {
    if (collapsed) return
    e.preventDefault()
    resizeRef.current = { startY: e.clientY, startHeight: expandedH }
    document.body.style.cursor = 'ns-resize'
  }, [expandedH, collapsed])

  const onTabClick = (id) => {
    if (collapsed) store.setBottomPanelCollapsed(false)
    store.setBottomPanelTab(id)
  }

  useEffect(() => {
    const onMove = (e) => {
      if (!resizeRef.current) return
      const dy = resizeRef.current.startY - e.clientY  // drag up → taller
      const parentH = containerRef.current?.parentElement?.clientHeight ?? window.innerHeight
      const maxH = Math.max(MIN_HEIGHT, Math.floor(parentH * MAX_HEIGHT_RATIO))
      const next = Math.min(maxH, Math.max(MIN_HEIGHT, resizeRef.current.startHeight + dy))
      store.setBottomPanelHeight(next)
    }
    const onUp = () => {
      if (!resizeRef.current) return
      resizeRef.current = null
      document.body.style.cursor = ''
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [store])

  return (
    <div ref={containerRef} className="no-print" style={{
      height,
      flexShrink: 0,
      borderTop: '1px solid var(--border-soft)',
      background: 'var(--bg-surface)',
      display: 'flex', flexDirection: 'column',
      position: 'relative',
      overflow: 'hidden',
    }}>
      {/* Resize handle (top edge) — disabled while collapsed */}
      {!collapsed && (
        <div
          onMouseDown={onResizeMouseDown}
          title="Drag to resize"
          style={{
            position: 'absolute', top: -2, left: 0, right: 0, height: 5,
            cursor: 'ns-resize', zIndex: 3, background: 'transparent',
          }}
        />
      )}

      {/* Tab strip */}
      <div style={{
        display: 'flex', alignItems: 'stretch',
        height: BOTTOM_PANEL_TAB_STRIP_H,
        borderBottom: collapsed ? 'none' : '1px solid var(--border-soft)',
        background: 'var(--bg-surface)',
        flexShrink: 0,
      }}>
        {TABS.map(t => {
          const active = t.id === tab && !collapsed
          return (
            <button key={t.id}
              onClick={() => onTabClick(t.id)}
              style={{
                appearance: 'none',
                background: active ? 'var(--bg-raised)' : 'transparent',
                border: 'none',
                borderRight: '1px solid var(--border-soft)',
                borderBottom: active ? '2px solid var(--accent)' : '2px solid transparent',
                marginBottom: -1,
                padding: '6px 14px',
                fontSize: 11,
                fontWeight: active ? 700 : 500,
                color: active ? 'var(--ink)' : 'var(--ink-muted)',
                letterSpacing: '0.04em',
                cursor: 'pointer',
              }}>
              {t.label}
            </button>
          )
        })}
        <div style={{ flex: 1 }}/>
        <button
          onClick={() => store.setBottomPanelCollapsed(!collapsed)}
          title={collapsed ? 'Expand panel' : 'Collapse panel'}
          aria-label={collapsed ? 'Expand panel' : 'Collapse panel'}
          style={{
            appearance: 'none',
            background: 'transparent',
            border: 'none',
            padding: '0 12px',
            fontSize: 14,
            color: 'var(--ink-muted)',
            cursor: 'pointer',
          }}>
          {collapsed ? '▲' : '▼'}
        </button>
      </div>

      {/* Tab content — hidden when collapsed */}
      {!collapsed && (
        <div style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: 12 }}>
          {tab === 'population'    && <PopulationTab />}
          {tab === 'verbalisation' && <VerbalisationTab />}
        </div>
      )}
    </div>
  )
}

// ── Population tab ─────────────────────────────────────────────────────────
function PopulationTab() {
  const store = useOrmStore()
  const { selectedId, selectedRole, selectedKind } = store

  // Resolve the element whose population we're viewing
  const ot   = store.objectTypes.find(o => o.id === selectedId)
  const fact = store.facts.find(f => f.id === selectedId)
    ?? (selectedRole ? store.facts.find(f => f.id === selectedRole.factId) : null)
  const subtypeEdge = selectedKind === 'subtype'
    ? store.subtypes.find(st => st.id === selectedId)
    : null

  // Guard: if the selected element's effective identifier is cyclic, don't
  // show the population editor. The cycle may be on the element itself (own
  // ref-mode / composite-PI / nested implicit PI), or on an ancestor whose
  // identifier this element inherits.
  {
    const target = ot && ot.kind === 'entity' ? ot
      : (fact && fact.objectified && fact.objectifiedKind !== 'value') ? fact
      : null
    if (target) {
      const ownsRefMode = findRefMode(target, store.facts, store.objectTypes)
      const ownsCompositePI = !ownsRefMode && findCompositePI(target, store.facts, store.objectTypes, store.constraints)
      const inherited = !ownsRefMode && !ownsCompositePI
        ? findInheritedPI(target, store.facts, store.objectTypes, store.subtypes, store.constraints)
        : null
      // For a nested entity with no explicit PI and no inheritance, the cycle
      // (if any) is registered against its own id (implicit composite PI).
      const ownerId = (ownsRefMode || ownsCompositePI) ? target.id
        : (inherited?.supertype?.id ?? target.id)
      if (ownerId && store.validationErrors.some(e => e.id === `identifier-cycle-${ownerId}`)) {
        const targetLabel = target.name || target.objectifiedName || 'this element'
        const owner = ownerId === target.id ? null
          : findRolePlayer(ownerId, store.objectTypes, store.facts)
        const ownerLabel = owner?.name || owner?.objectifiedName || 'a supertype'
        return <EmptyState>
          Identifier cycle: {owner
            ? <>{targetLabel}'s identifier is inherited from <strong>{ownerLabel}</strong>, whose preferred identifier transitively depends on itself.</>
            : <>{targetLabel}'s preferred identifier transitively depends on itself.</>
          } Resolve the cycle first.
        </EmptyState>
      }
    }
  }

  if (ot)   return <ObjectTypePopulation ot={ot}/>
  if (fact) {
    if (selectedKind === 'implicitLink' && store.selectedImplicitLink != null)
      return <ImpliedLinkPopulation parentFact={fact} roleIndex={store.selectedImplicitLink} />
    if (fact.objectified && fact.objectifiedKind !== 'value')
      return <NestedEntityObjectifiedPopulation fact={fact}/>
    return <FactTypePopulation fact={fact}/>
  }
  if (subtypeEdge) return <SubtypeMappingPopulation edge={subtypeEdge}/>
  // Ring constraint population viewer
  const con = selectedKind === 'constraint'
    ? store.constraints.find(c => c.id === selectedId)
    : null
  if (con && con.constraintType === 'ring') return <RingConstraintPopulation con={con}/>
  if (con && con.constraintType === 'uniqueness') return <ExternalUniquenessPopulation con={con}/>
  if (con && con.constraintType === 'frequency') return <ExternalFrequencyPopulation con={con}/>
  if (con && con.constraintType === 'inclusiveOr')
    return <InclusiveOrConstraintPopulation con={con}/>
  if (con && con.constraintType === 'exclusiveOr')
    return <ExclusiveOrConstraintPopulation con={con}/>
  if (con && con.constraintType === 'exclusion')
    return <ExclusionConstraintPopulation con={con}/>
  if (con && con.constraintType === 'equality')
    return <EqualityConstraintPopulation con={con}/>
  if (con && con.constraintType === 'subset')
    return <SubsetConstraintPopulation con={con}/>
  if (con && con.constraintType === 'valueComparison')
    return <ValueComparisonPopulation con={con}/>
  return <EmptyState>Select a value type, entity type, fact type, or subtype edge to view its population.</EmptyState>
}

// Shared LCA selection dropdown shown above population tables.
// Greyed (disabled) when isC1=true (no translation needed).
// availableLCAs = array of type IDs; otById = Map<id,ot> for name lookup.
function LcaDropdown({ isC1, availableLCAs, lcaId, onSelect, label, otById }) {
  const otName = (id) => otById?.get(id)?.name || id?.slice(0, 8) || '—'
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6, fontSize: 11 }}>
      <span style={{ color: isC1 ? 'var(--ink-muted)' : 'var(--ink-2)' }}>
        {label ?? 'LCA:'}
      </span>
      <select
        disabled={isC1}
        value={lcaId ?? ''}
        onChange={e => onSelect(e.target.value || null)}
        style={{
          fontSize: 11, padding: '1px 4px',
          opacity: isC1 ? 0.45 : 1,
          background: 'var(--bg-surface)', color: 'var(--ink-1)',
          border: '1px solid var(--border)', borderRadius: 3,
          cursor: isC1 ? 'default' : 'pointer',
        }}
      >
        {availableLCAs.length === 0
          ? <option value="">—</option>
          : availableLCAs.map(id => (
              <option key={id} value={id}>{otName(id)}</option>
            ))}
      </select>
      {isC1 && <span style={{ color: 'var(--ink-muted)', fontStyle: 'italic' }}>(direct comparison)</span>}
    </div>
  )
}

// Format a translated key for bold display.
// Single-element arrays are unwrapped; multi-element composite PIs get parens.
const displayTranslated = (v) => {
  if (v === null || v === undefined) return '—'
  if (typeof v === 'string') return v
  if (Array.isArray(v)) {
    if (v.length === 1) return displayTranslated(v[0])
    return `(${v.map(displayTranslated).join(', ')})`
  }
  return String(v)
}

// Display an array of per-position translated values as a comma-separated tuple.
const displayTranslatedTuple = (tuple) =>
  tuple ? tuple.map(displayTranslated).join(', ') : '—'

function RingConstraintPopulation({ con }) {
  const store = useOrmStore()
  const [selectedLcaId, setSelectedLcaId] = useState(null)
  const otById = new Map((store.objectTypes || []).map(o => [o.id, o]))
  const data = {
    facts: store.facts, factPopulations: store.factPopulations,
    objectTypes: store.objectTypes, populations: store.populations,
    subtypes: store.subtypes, subtypeMappings: store.subtypeMappings,
    nestedEntityMappings: store.nestedEntityMappings, constraints: store.constraints,
  }
  const result = computeRingConstraintRelation(data, con.id, selectedLcaId)
  const populationIssues = (store.populationIssues || []).filter(i => i.elementId === con.id)

  if (!result) {
    return (
      <div>
        <Header>Ring Constraint <strong>{con.name || `#${con.id.slice(0, 8)}`}</strong></Header>
        <div style={{ fontSize: 11, color: 'var(--ink-muted)', marginBottom: 8 }}>
          Ring properties: {(con.ringTypes ?? []).join(', ') || 'none'}
        </div>
        <EmptyState>No relation data available — constraint may lack required sequence or query structure.</EmptyState>
      </div>
    )
  }

  const { pairs, ringTypes, isC1, availableLCAs, lcaId } = result
  const displayVal = (v) => {
    if (typeof v === 'string') return v
    return JSON.stringify(v)
  }

  const cellSt = { padding: '2px 6px', fontSize: 11, fontFamily: 'monospace', borderRight: '1px solid var(--border-soft)' }
  const hdrSt  = { ...cellSt, fontFamily: 'inherit', fontWeight: 600, color: 'var(--ink-muted)', background: 'var(--bg-panel)', borderBottom: '1px solid var(--border-soft)', whiteSpace: 'nowrap' }

  return (
    <div>
      <Header>Ring Constraint <strong>{con.name || `#${con.id.slice(0, 8)}`}</strong></Header>
      <div style={{ fontSize: 11, color: 'var(--ink-muted)', marginBottom: 8 }}>
        Ring properties: {ringTypes.join(', ')}
      </div>

      <LcaDropdown
        isC1={isC1} availableLCAs={availableLCAs} lcaId={lcaId}
        onSelect={id => setSelectedLcaId(id)} otById={otById}
      />

      {pairs.length === 0 ? (
        <EmptyState>Empty relation — no pairs to display.</EmptyState>
      ) : (
        <>
          <div style={{ fontSize: 11, color: 'var(--ink-muted)', marginBottom: 4 }}>
            Relation ({pairs.length} pair{pairs.length === 1 ? '' : 's'}):
          </div>
          <div style={{ overflowX: 'auto', overflowY: 'auto', maxHeight: 280 }}>
            {isC1 ? (
              <table style={{ borderCollapse: 'collapse', minWidth: 240, border: '1px solid var(--border-soft)' }}>
                <thead>
                  <tr>
                    <th style={{ ...hdrSt, width: 120 }}>Left</th>
                    <th style={{ ...hdrSt, width: 120 }}>Right</th>
                  </tr>
                </thead>
                <tbody>
                  {pairs.map((pair, i) => (
                    <tr key={i} style={{ background: i % 2 === 0 ? 'transparent' : 'var(--bg-stripe)' }}>
                      <td style={{ ...cellSt, borderBottom: '1px solid var(--border-soft)' }}>{displayVal(pair.a)}</td>
                      <td style={{ ...cellSt, borderBottom: '1px solid var(--border-soft)' }}>{displayVal(pair.b)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <table style={{ borderCollapse: 'collapse', minWidth: 480, border: '1px solid var(--border-soft)' }}>
                <thead>
                  <tr>
                    <th style={{ ...hdrSt, width: 120 }}>Left</th>
                    <th style={{ ...hdrSt, width: 120 }}>Left (LCA)</th>
                    <th style={{ ...hdrSt, width: 120 }}>Right</th>
                    <th style={{ ...hdrSt, width: 120 }}>Right (LCA)</th>
                  </tr>
                </thead>
                <tbody>
                  {pairs.map((pair, i) => (
                    <tr key={i} style={{ background: i % 2 === 0 ? 'transparent' : 'var(--bg-stripe)' }}>
                      <td style={{ ...cellSt, borderBottom: '1px solid var(--border-soft)' }}>{displayVal(pair.a)}</td>
                      <td style={{ ...cellSt, borderBottom: '1px solid var(--border-soft)', fontWeight: 700 }}>{displayTranslated(pair.aTranslated)}</td>
                      <td style={{ ...cellSt, borderBottom: '1px solid var(--border-soft)' }}>{displayVal(pair.b)}</td>
                      <td style={{ ...cellSt, borderBottom: '1px solid var(--border-soft)', fontWeight: 700 }}>{displayTranslated(pair.bTranslated)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </>
      )}

      {populationIssues.length > 0 && (
        <div style={{ marginTop: 12 }}>
          <div style={{ fontSize: 11, color: '#b91c1c', marginBottom: 4 }}>Violations ({populationIssues.length}):</div>
          {populationIssues.map((issue, i) => (
            <div key={i} style={{ fontSize: 11, color: '#b91c1c', marginBottom: 2, lineHeight: 1.3 }}>
              • {issue.message}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function ExternalUniquenessPopulation({ con }) {
  const store = useOrmStore()
  const data = {
    facts: store.facts,
    factPopulations: store.factPopulations,
    objectTypes: store.objectTypes,
    populations: store.populations,
    subtypes: store.subtypes,
    subtypeMappings: store.subtypeMappings,
    nestedEntityMappings: store.nestedEntityMappings,
    constraints: store.constraints,
  }
  const result = computeUniquenessProjection(data, con.id)
  const populationIssues = (store.populationIssues || []).filter(i => i.elementId === con.id)

  const displayVal = (v) => {
    if (typeof v === 'string') return v
    return JSON.stringify(v)
  }

  if (!result) {
    return (
      <div>
        <Header>External Uniqueness <strong>{con.name || `#${con.id.slice(0, 8)}`}</strong></Header>
        <EmptyState>No projection data available — constraint may lack required sequence or role structure.</EmptyState>
      </div>
    )
  }

  const { entries, violations, roleCount, totalTuples } = result
  const isSingle = roleCount === 1

  return (
    <div>
      <Header>External Uniqueness <strong>{con.name || `#${con.id.slice(0, 8)}`}</strong></Header>
      <div style={{ fontSize: 11, color: 'var(--ink-muted)', marginBottom: 8 }}>
        {totalTuples} tuple{totalTuples === 1 ? '' : 's'} projected, {entries.length} unique{entries.length === 1 ? '' : 's'}
        {violations.length > 0 && (
          <span style={{ color: '#b91c1c' }}> — {violations.length} violation{violations.length === 1 ? '' : 's'}</span>
        )}
      </div>

      {entries.length === 0 ? (
        <EmptyState>Empty projection — no tuples to display.</EmptyState>
      ) : (
        <div style={{ maxWidth: 500 }}>
          <div style={{ display: 'flex', gap: 4, marginBottom: 4, borderBottom: '1px solid var(--border-soft)', paddingBottom: 4, alignItems: 'flex-end' }}>
            {isSingle ? (
              <div style={colHeaderStyle}>Value</div>
            ) : (
              Array.from({ length: roleCount }, (_, i) => (
                <div key={i} style={{ ...colHeaderStyle, flex: 1 }}>Value {i + 1}</div>
              ))
            )}
            <div style={{ ...colHeaderStyle, width: 50, textAlign: 'right' }}>Count</div>
          </div>
          {entries.map((entry, i) => {
            const isViolation = entry.count > 1
            const rowStyle = {
              display: 'flex', gap: 4, marginBottom: 2, padding: '2px 0',
              background: isViolation ? '#fef2f2' : (i % 2 === 0 ? 'transparent' : 'var(--bg-raised)'),
              borderRadius: isViolation ? 2 : 0,
            }
            const valStyle = {
              flex: isSingle ? undefined : 1,
              fontSize: 12, fontFamily: 'monospace',
              color: isViolation ? '#b91c1c' : undefined,
              fontWeight: isViolation ? 600 : undefined,
            }
            return (
              <div key={i} style={rowStyle}>
                {isSingle ? (
                  <div style={valStyle}>{displayVal(entry.values[0])}</div>
                ) : (
                  Array.from({ length: roleCount }, (_, ci) => (
                    <div key={ci} style={valStyle}>{displayVal(entry.values[ci])}</div>
                  ))
                )}
                <div style={{ width: 50, fontSize: 12, textAlign: 'right', fontFamily: 'monospace', color: isViolation ? '#b91c1c' : undefined }}>
                  {entry.count}
                </div>
              </div>
            )
          })}
        </div>
      )}

      {populationIssues.length > 0 && (
        <div style={{ marginTop: 12 }}>
          <div style={{ fontSize: 11, color: '#b91c1c', marginBottom: 4 }}>Schema violations ({populationIssues.length}):</div>
          {populationIssues.map((issue, i) => (
            <div key={i} style={{ fontSize: 11, color: '#b91c1c', marginBottom: 2, lineHeight: 1.3 }}>
              • {issue.message}
            </div>
          ))}
        </div>
      )}

      {!isSingle && (
        <div style={{ marginTop: 8, fontSize: 10, color: 'var(--ink-muted)', fontStyle: 'italic' }}>
          Multi-role projection: each tuple's values form a composite key.
        </div>
      )}
    </div>
  )
}

function ExternalFrequencyPopulation({ con }) {
  const store = useOrmStore()
  const data = {
    facts: store.facts,
    factPopulations: store.factPopulations,
    objectTypes: store.objectTypes,
    populations: store.populations,
    subtypes: store.subtypes,
    subtypeMappings: store.subtypeMappings,
    nestedEntityMappings: store.nestedEntityMappings,
    constraints: store.constraints,
  }
  const result = computeUniquenessProjection(data, con.id)
  const freqSpec = con.frequency
  const populationIssues = (store.populationIssues || []).filter(i => i.elementId === con.id)

  const displayVal = (v) => {
    if (typeof v === 'string') return v
    return JSON.stringify(v)
  }

  if (!result) {
    return (
      <div>
        <Header>External Frequency <strong>{con.name || `#${con.id.slice(0, 8)}`}</strong></Header>
        <EmptyState>No projection data available — constraint may lack required sequence or role structure.</EmptyState>
      </div>
    )
  }

  const { entries, roleCount, totalTuples } = result
  const isSingle = roleCount === 1
  const violations = entries.filter(e => !freqRangeSatisfies(e.count, freqSpec))

  return (
    <div>
      <Header>External Frequency <strong>{con.name || `#${con.id.slice(0, 8)}`}</strong></Header>
      <div style={{ fontSize: 11, color: 'var(--ink-muted)', marginBottom: 8 }}>
        {totalTuples} tuple{totalTuples === 1 ? '' : 's'} projected, {entries.length} unique{entries.length === 1 ? '' : 's'}
        {violations.length > 0 && (
          <span style={{ color: '#b91c1c' }}> — {violations.length} violation{violations.length === 1 ? '' : 's'}</span>
        )}
      </div>

      {entries.length === 0 ? (
        <EmptyState>Empty projection — no tuples to display.</EmptyState>
      ) : (
        <div style={{ maxWidth: 500 }}>
          <div style={{ display: 'flex', gap: 4, marginBottom: 4, borderBottom: '1px solid var(--border-soft)', paddingBottom: 4, alignItems: 'flex-end' }}>
            {isSingle ? (
              <div style={colHeaderStyle}>Value</div>
            ) : (
              Array.from({ length: roleCount }, (_, i) => (
                <div key={i} style={{ ...colHeaderStyle, flex: 1 }}>Value {i + 1}</div>
              ))
            )}
            <div style={{ ...colHeaderStyle, width: 50, textAlign: 'right' }}>Count</div>
          </div>
          {entries.map((entry, i) => {
            const isViolation = !freqRangeSatisfies(entry.count, freqSpec)
            const rowStyle = {
              display: 'flex', gap: 4, marginBottom: 2, padding: '2px 0',
              background: isViolation ? '#fef2f2' : (i % 2 === 0 ? 'transparent' : 'var(--bg-raised)'),
              borderRadius: isViolation ? 2 : 0,
            }
            const valStyle = {
              flex: isSingle ? undefined : 1,
              fontSize: 12, fontFamily: 'monospace',
              color: isViolation ? '#b91c1c' : undefined,
              fontWeight: isViolation ? 600 : undefined,
            }
            return (
              <div key={i} style={rowStyle}>
                {isSingle ? (
                  <div style={valStyle}>{displayVal(entry.values[0])}</div>
                ) : (
                  Array.from({ length: roleCount }, (_, ci) => (
                    <div key={ci} style={valStyle}>{displayVal(entry.values[ci])}</div>
                  ))
                )}
                <div style={{ width: 50, fontSize: 12, textAlign: 'right', fontFamily: 'monospace', color: isViolation ? '#b91c1c' : undefined }}>
                  {entry.count}
                </div>
              </div>
            )
          })}
        </div>
      )}

      {populationIssues.length > 0 && (
        <div style={{ marginTop: 12 }}>
          <div style={{ fontSize: 11, color: '#b91c1c', marginBottom: 4 }}>Schema violations ({populationIssues.length}):</div>
          {populationIssues.map((issue, i) => (
            <div key={i} style={{ fontSize: 11, color: '#b91c1c', marginBottom: 2, lineHeight: 1.3 }}>
              • {issue.message}
            </div>
          ))}
        </div>
      )}

      {!isSingle && (
        <div style={{ marginTop: 8, fontSize: 10, color: 'var(--ink-muted)', fontStyle: 'italic' }}>
          Multi-role projection: each tuple's values form a composite key.
        </div>
      )}
    </div>
  )
}

function InclusiveOrConstraintPopulation({ con }) {
  const store = useOrmStore()
  const [selectedLcaId, setSelectedLcaId] = useState(null)
  const otById = new Map((store.objectTypes || []).map(o => [o.id, o]))
  const data = {
    facts: store.facts, factPopulations: store.factPopulations,
    objectTypes: store.objectTypes, populations: store.populations,
    subtypes: store.subtypes, subtypeMappings: store.subtypeMappings,
    nestedEntityMappings: store.nestedEntityMappings, constraints: store.constraints,
  }
  const result = computeInclusiveOrTable(data, con.id, selectedLcaId)
  const violationKeys = new Set(
    (store.populationIssues || [])
      .filter(i => i.elementId === con.id && i.kind === 'inclusiveOrViolation')
      .map(i => JSON.stringify(i.value))
  )

  const displayVal = (v) => typeof v === 'string' ? v : JSON.stringify(v)

  if (!result) {
    return (
      <div>
        <Header>Inclusive Or <strong>{con.name || `#${con.id.slice(0, 8)}`}</strong></Header>
        <EmptyState>No data available — constraint may lack a target object type or role sequences.</EmptyState>
      </div>
    )
  }

  const { seqCount, rows, isC1, availableLCAs, lcaId } = result
  const violationCount = rows.filter(r => r.hasViolation).length

  const cellStyle = {
    padding: '2px 6px', fontSize: 11, fontFamily: 'monospace',
    borderRight: '1px solid var(--border-soft)', verticalAlign: 'top',
  }
  const headerStyle = {
    ...cellStyle, fontFamily: 'inherit', fontWeight: 600,
    color: 'var(--ink-muted)', background: 'var(--bg-panel)',
    borderBottom: '1px solid var(--border-soft)', whiteSpace: 'nowrap',
  }

  return (
    <div>
      <Header>Inclusive Or <strong>{con.name || `#${con.id.slice(0, 8)}`}</strong></Header>
      <div style={{ fontSize: 11, color: 'var(--ink-muted)', marginBottom: 8 }}>
        {seqCount} sequence{seqCount === 1 ? '' : 's'}
        {violationCount > 0 && (
          <span style={{ color: '#b91c1c' }}> — {violationCount} violation{violationCount === 1 ? '' : 's'}</span>
        )}
      </div>

      <LcaDropdown
        isC1={isC1} availableLCAs={availableLCAs} lcaId={lcaId}
        onSelect={id => setSelectedLcaId(id)} otById={otById}
      />

      {rows.length === 0 ? (
        <EmptyState>Target object type has no instances.</EmptyState>
      ) : (
        <div style={{ overflowX: 'auto', overflowY: 'auto', maxHeight: 280 }}>
          <table style={{ borderCollapse: 'collapse', minWidth: 100 + 120 + 100 * seqCount, border: '1px solid var(--border-soft)' }}>
            <thead>
              <tr>
                <th style={{ ...headerStyle, width: 100 }}>LCA key</th>
                <th style={{ ...headerStyle, width: 120 }}>Target</th>
                {Array.from({ length: seqCount }, (_, i) => (
                  <th key={i} style={{ ...headerStyle, width: 100 }}>Seq {i + 1}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, ri) => {
                const isViolation = row.hasViolation ||
                  violationKeys.has(JSON.stringify(projCellKey(row.tid)))
                const rowBg = isViolation ? '#fef2f2' : (ri % 2 === 0 ? 'transparent' : 'var(--bg-stripe)')
                return (
                  <tr key={ri} style={{ background: rowBg }}>
                    <td style={{ ...cellStyle, fontWeight: 700, borderBottom: '1px solid var(--border-soft)', color: isViolation ? '#b91c1c' : undefined }}>
                      {displayTranslated(row.translatedTid)}
                    </td>
                    <td style={{ ...cellStyle, borderBottom: '1px solid var(--border-soft)', color: isViolation ? '#b91c1c' : undefined }}>
                      {displayVal(row.tid)}
                      {isViolation && <span style={{ marginLeft: 4, opacity: 0.7 }}>⚠</span>}
                    </td>
                    {row.seqMatches.map((v, si) => (
                      <td key={si} style={{ ...cellStyle, borderBottom: '1px solid var(--border-soft)' }}>
                        {v === null
                          ? <span style={{ color: 'var(--ink-muted)', fontStyle: 'italic' }}>—</span>
                          : displayVal(v)}
                      </td>
                    ))}
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

function ExclusiveOrConstraintPopulation({ con }) {
  const store = useOrmStore()
  const [selectedLcaId, setSelectedLcaId] = useState(null)
  const otById = new Map((store.objectTypes || []).map(o => [o.id, o]))
  const data = {
    facts: store.facts, factPopulations: store.factPopulations,
    objectTypes: store.objectTypes, populations: store.populations,
    subtypes: store.subtypes, subtypeMappings: store.subtypeMappings,
    nestedEntityMappings: store.nestedEntityMappings, constraints: store.constraints,
  }
  const result = computeExclusiveOrTable(data, con.id, selectedLcaId)
  const violationKeys = new Set(
    (store.populationIssues || [])
      .filter(i => i.elementId === con.id && i.kind === 'exclusiveOrViolation')
      .map(i => JSON.stringify(i.value))
  )

  const displayVal = (v) => typeof v === 'string' ? v : JSON.stringify(v)

  if (!result) {
    return (
      <div>
        <Header>Exclusive Or <strong>{con.name || `#${con.id.slice(0, 8)}`}</strong></Header>
        <EmptyState>No data available — constraint may lack a target object type or role sequences.</EmptyState>
      </div>
    )
  }

  const { seqCount, rows, isC1, availableLCAs, lcaId } = result
  const uncoveredCount = rows.filter(r => r.hasUncoveredViolation).length
  const overlapCount   = rows.filter(r => r.hasOverlapViolation).length
  const violationCount = uncoveredCount + overlapCount

  const cellStyle = {
    padding: '2px 6px', fontSize: 11, fontFamily: 'monospace',
    borderRight: '1px solid var(--border-soft)', verticalAlign: 'top',
  }
  const headerStyle = {
    ...cellStyle, fontFamily: 'inherit', fontWeight: 600,
    color: 'var(--ink-muted)', background: 'var(--bg-panel)',
    borderBottom: '1px solid var(--border-soft)', whiteSpace: 'nowrap',
  }

  return (
    <div>
      <Header>Exclusive Or <strong>{con.name || `#${con.id.slice(0, 8)}`}</strong></Header>
      <div style={{ fontSize: 11, color: 'var(--ink-muted)', marginBottom: 8 }}>
        {seqCount} sequence{seqCount === 1 ? '' : 's'}
        {violationCount > 0 && (
          <span style={{ color: '#b91c1c' }}>
            {' '}— {uncoveredCount > 0 && `${uncoveredCount} uncovered`}
            {uncoveredCount > 0 && overlapCount > 0 && ', '}
            {overlapCount > 0 && `${overlapCount} overlapping`}
          </span>
        )}
      </div>

      <LcaDropdown
        isC1={isC1} availableLCAs={availableLCAs} lcaId={lcaId}
        onSelect={id => setSelectedLcaId(id)} otById={otById}
      />

      {rows.length === 0 ? (
        <EmptyState>Target object type has no instances.</EmptyState>
      ) : (
        <div style={{ overflowX: 'auto', overflowY: 'auto', maxHeight: 280 }}>
          <table style={{ borderCollapse: 'collapse', minWidth: 100 + 120 + 100 * seqCount, border: '1px solid var(--border-soft)' }}>
            <thead>
              <tr>
                <th style={{ ...headerStyle, width: 100 }}>LCA key</th>
                <th style={{ ...headerStyle, width: 120 }}>Target</th>
                {Array.from({ length: seqCount }, (_, i) => (
                  <th key={i} style={{ ...headerStyle, width: 100 }}>Seq {i + 1}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, ri) => {
                const isViolation = row.hasUncoveredViolation || row.hasOverlapViolation ||
                  violationKeys.has(JSON.stringify(projCellKey(row.tid)))
                const rowBg = row.hasUncoveredViolation ? '#fef2f2'
                  : row.hasOverlapViolation ? '#fff7ed'
                  : (ri % 2 === 0 ? 'transparent' : 'var(--bg-stripe)')
                return (
                  <tr key={ri} style={{ background: rowBg }}>
                    <td style={{ ...cellStyle, fontWeight: 700, borderBottom: '1px solid var(--border-soft)', color: isViolation ? '#b91c1c' : undefined }}>
                      {displayTranslated(row.translatedTid)}
                    </td>
                    <td style={{ ...cellStyle, color: isViolation ? '#b91c1c' : undefined, borderBottom: '1px solid var(--border-soft)' }}>
                      {displayVal(row.tid)}
                      {(row.hasUncoveredViolation || row.hasOverlapViolation) && <span style={{ marginLeft: 4, opacity: 0.7 }}>⚠</span>}
                    </td>
                    {row.seqMatches.map((v, si) => {
                      const isOverlapping = row.hasOverlapViolation && row.overlappingSeqs.has(si)
                      return (
                        <td key={si} style={{
                          ...cellStyle, borderBottom: '1px solid var(--border-soft)',
                          background: isOverlapping ? '#fed7aa' : undefined,
                        }}>
                          {v === null
                            ? <span style={{ color: 'var(--ink-muted)', fontStyle: 'italic' }}>—</span>
                            : <span style={{ color: isOverlapping ? '#9a3412' : undefined }}>{displayVal(v)}</span>}
                        </td>
                      )
                    })}
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

function ExclusionConstraintPopulation({ con }) {
  const store = useOrmStore()
  const [selectedLcaIds, setSelectedLcaIds] = useState({})
  const otById = new Map((store.objectTypes || []).map(o => [o.id, o]))
  const data = {
    facts: store.facts, factPopulations: store.factPopulations,
    objectTypes: store.objectTypes, populations: store.populations,
    subtypes: store.subtypes, subtypeMappings: store.subtypeMappings,
    nestedEntityMappings: store.nestedEntityMappings, constraints: store.constraints,
  }
  const base = computeExclusionTable(data, con.id)
  const lcaArr = base?.positionInfo?.map((pi, p) => selectedLcaIds[p] ?? pi.lcaId) ?? null
  const result = computeExclusionTable(data, con.id, lcaArr)
  const violationCount = result ? result.rows.filter(r => r.hasViolation).length : 0

  const displayVal = (v) => typeof v === 'string' ? v
    : Array.isArray(v) ? v.map(c => typeof c === 'string' ? c : JSON.stringify(c)).join(', ')
    : JSON.stringify(v)

  if (!result) {
    return (
      <div>
        <Header>Exclusion <strong>{con.name || `#${con.id.slice(0, 8)}`}</strong></Header>
        <EmptyState>No projection data available — constraint may lack required sequence or role structure.</EmptyState>
      </div>
    )
  }

  const { seqCount, rows, positionInfo } = result

  const cellStyle = {
    padding: '2px 6px', fontSize: 11, fontFamily: 'monospace',
    borderRight: '1px solid var(--border-soft)', verticalAlign: 'top',
  }
  const headerStyle = {
    ...cellStyle, fontFamily: 'inherit', fontWeight: 600,
    color: 'var(--ink-muted)', background: 'var(--bg-panel)',
    borderBottom: '1px solid var(--border-soft)', whiteSpace: 'nowrap',
  }

  const posLen = positionInfo?.length ?? 0

  return (
    <div>
      <Header>Exclusion <strong>{con.name || `#${con.id.slice(0, 8)}`}</strong></Header>
      <div style={{ fontSize: 11, color: 'var(--ink-muted)', marginBottom: 8 }}>
        {seqCount} sequence{seqCount === 1 ? '' : 's'}
        {violationCount > 0 && (
          <span style={{ color: '#b91c1c' }}> — {violationCount} violation{violationCount === 1 ? '' : 's'}</span>
        )}
      </div>

      {positionInfo?.map((pi, p) => (
        <LcaDropdown key={p}
          isC1={pi.isC1} availableLCAs={pi.availableLCAs} lcaId={selectedLcaIds[p] ?? pi.lcaId}
          onSelect={id => setSelectedLcaIds(prev => ({ ...prev, [p]: id }))}
          otById={otById}
          label={posLen > 1 ? `Position ${p + 1} LCA:` : 'LCA:'}
        />
      ))}

      {rows.length === 0 ? (
        <EmptyState>No query results — all sequences are empty.</EmptyState>
      ) : (
        <div style={{ overflowX: 'auto', overflowY: 'auto', maxHeight: 280 }}>
          <table style={{ borderCollapse: 'collapse', minWidth: 120 + 120 * seqCount, border: '1px solid var(--border-soft)' }}>
            <thead>
              <tr>
                <th style={{ ...headerStyle, width: 120 }}>LCA tuple</th>
                {Array.from({ length: seqCount }, (_, i) => (
                  <th key={i} style={{ ...headerStyle, width: 120 }}>Seq {i + 1}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, ri) => {
                const rowBg = row.hasViolation ? '#fff7ed'
                  : (ri % 2 === 0 ? 'transparent' : 'var(--bg-stripe)')
                return (
                  <tr key={ri} style={{ background: rowBg }}>
                    <td style={{ ...cellStyle, fontWeight: 700, borderBottom: '1px solid var(--border-soft)' }}>
                      {displayTranslatedTuple(row.translatedTuple)}
                    </td>
                    {row.seqMatches.map((v, si) => {
                      const isOverlapping = row.hasViolation && row.overlappingSeqs.has(si)
                      return (
                        <td key={si} style={{
                          ...cellStyle, borderBottom: '1px solid var(--border-soft)',
                          background: isOverlapping ? '#fed7aa' : undefined,
                        }}>
                          {v === null
                            ? <span style={{ color: 'var(--ink-muted)', fontStyle: 'italic' }}>—</span>
                            : <span style={{ color: isOverlapping ? '#9a3412' : undefined }}>{displayVal(v)}</span>}
                        </td>
                      )
                    })}
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

function SetConstraintTable({ label, rows, seqCount, positionInfo, violationCount, emptyStyle, highlightEmpty, otById, selectedLcaIds, onSelectLca }) {
  const displayVal = (v) => typeof v === 'string' ? v
    : Array.isArray(v) ? v.map(c => typeof c === 'string' ? c : JSON.stringify(c)).join(', ')
    : JSON.stringify(v)

  const cellStyle = {
    padding: '2px 6px', fontSize: 11, fontFamily: 'monospace',
    borderRight: '1px solid var(--border-soft)', verticalAlign: 'top',
  }
  const headerStyle = {
    ...cellStyle, fontFamily: 'inherit', fontWeight: 600,
    color: 'var(--ink-muted)', background: 'var(--bg-panel)',
    borderBottom: '1px solid var(--border-soft)', whiteSpace: 'nowrap',
  }

  const posLen = positionInfo?.length ?? 0

  return (
    <div>
      <Header>{label}</Header>
      <div style={{ fontSize: 11, color: 'var(--ink-muted)', marginBottom: 8 }}>
        {seqCount} sequence{seqCount === 1 ? '' : 's'}
        {violationCount > 0 && (
          <span style={{ color: '#b91c1c' }}> — {violationCount} violation{violationCount === 1 ? '' : 's'}</span>
        )}
      </div>

      {positionInfo?.map((pi, p) => (
        <LcaDropdown key={p}
          isC1={pi.isC1} availableLCAs={pi.availableLCAs} lcaId={selectedLcaIds?.[p] ?? pi.lcaId}
          onSelect={id => onSelectLca?.(p, id)}
          otById={otById}
          label={posLen > 1 ? `Position ${p + 1} LCA:` : 'LCA:'}
        />
      ))}

      {rows.length === 0 ? (
        <EmptyState>No query results — all sequences are empty.</EmptyState>
      ) : (
        <div style={{ overflowX: 'auto', overflowY: 'auto', maxHeight: 280 }}>
          <table style={{ borderCollapse: 'collapse', minWidth: 120 + 120 * seqCount, border: '1px solid var(--border-soft)' }}>
            <thead>
              <tr>
                <th style={{ ...headerStyle, width: 120 }}>LCA tuple</th>
                {Array.from({ length: seqCount }, (_, i) => (
                  <th key={i} style={{ ...headerStyle, width: 120 }}>Seq {i + 1}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, ri) => {
                const rowBg = row.hasViolation
                  ? (emptyStyle === 'orange' ? '#fff7ed' : '#fef2f2')
                  : (ri % 2 === 0 ? 'transparent' : 'var(--bg-stripe)')
                return (
                  <tr key={ri} style={{ background: rowBg }}>
                    <td style={{ ...cellStyle, fontWeight: 700, borderBottom: '1px solid var(--border-soft)' }}>
                      {displayTranslatedTuple(row.translatedTuple)}
                    </td>
                    {row.seqMatches.map((v, si) => {
                      const isEmpty = v === null
                      const highlight = row.hasViolation && highlightEmpty && isEmpty
                      const highlightFull = row.hasViolation && !highlightEmpty && row.overlappingSeqs?.has(si)
                      return (
                        <td key={si} style={{
                          ...cellStyle, borderBottom: '1px solid var(--border-soft)',
                          background: (highlight || highlightFull) ? '#fed7aa' : undefined,
                        }}>
                          {isEmpty
                            ? <span style={{ color: 'var(--ink-muted)', fontStyle: 'italic' }}>—</span>
                            : <span style={{ color: (highlight || highlightFull) ? '#9a3412' : undefined }}>
                                {displayVal(v)}
                              </span>}
                        </td>
                      )
                    })}
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

function EqualityConstraintPopulation({ con }) {
  const store = useOrmStore()
  const [selectedLcaIds, setSelectedLcaIds] = useState({})
  const otById = new Map((store.objectTypes || []).map(o => [o.id, o]))
  const data = {
    facts: store.facts, factPopulations: store.factPopulations,
    objectTypes: store.objectTypes, populations: store.populations,
    subtypes: store.subtypes, subtypeMappings: store.subtypeMappings,
    nestedEntityMappings: store.nestedEntityMappings, constraints: store.constraints,
  }
  const base = computeEqualityTable(data, con.id)
  const lcaArr = base?.positionInfo?.map((pi, p) => selectedLcaIds[p] ?? pi.lcaId) ?? null
  const result = computeEqualityTable(data, con.id, lcaArr)
  if (!result) return (
    <div>
      <Header>Equality <strong>{con.name || `#${con.id.slice(0, 8)}`}</strong></Header>
      <EmptyState>No projection data available.</EmptyState>
    </div>
  )
  const { seqCount, rows, positionInfo } = result
  const violationCount = rows.filter(r => r.hasViolation).length
  return <SetConstraintTable
    label={<>Equality <strong>{con.name || `#${con.id.slice(0, 8)}`}</strong></>}
    rows={rows} seqCount={seqCount} positionInfo={positionInfo} violationCount={violationCount}
    emptyStyle="red" highlightEmpty={true} otById={otById}
    selectedLcaIds={selectedLcaIds}
    onSelectLca={(p, id) => setSelectedLcaIds(prev => ({ ...prev, [p]: id }))}
  />
}

function SubsetConstraintPopulation({ con }) {
  const store = useOrmStore()
  const [selectedLcaIds, setSelectedLcaIds] = useState({})
  const otById = new Map((store.objectTypes || []).map(o => [o.id, o]))
  const data = {
    facts: store.facts, factPopulations: store.factPopulations,
    objectTypes: store.objectTypes, populations: store.populations,
    subtypes: store.subtypes, subtypeMappings: store.subtypeMappings,
    nestedEntityMappings: store.nestedEntityMappings, constraints: store.constraints,
  }
  const base = computeSubsetTable(data, con.id)
  const lcaArr = base?.positionInfo?.map((pi, p) => selectedLcaIds[p] ?? pi.lcaId) ?? null
  const result = computeSubsetTable(data, con.id, lcaArr)
  if (!result) return (
    <div>
      <Header>Subset <strong>{con.name || `#${con.id.slice(0, 8)}`}</strong></Header>
      <EmptyState>No projection data available.</EmptyState>
    </div>
  )
  const { seqCount, rows, positionInfo } = result
  const violationCount = rows.filter(r => r.hasViolation).length
  return <SetConstraintTable
    label={<>Subset <strong>{con.name || `#${con.id.slice(0, 8)}`}</strong></>}
    rows={rows} seqCount={seqCount} positionInfo={positionInfo} violationCount={violationCount}
    emptyStyle="red" highlightEmpty={true} otById={otById}
    selectedLcaIds={selectedLcaIds}
    onSelectLca={(p, id) => setSelectedLcaIds(prev => ({ ...prev, [p]: id }))}
  />
}

function ExternalBinaryConstraintPopulation({ con }) {
  const store = useOrmStore()
  const data = {
    facts: store.facts,
    factPopulations: store.factPopulations,
    objectTypes: store.objectTypes,
    populations: store.populations,
    subtypes: store.subtypes,
    subtypeMappings: store.subtypeMappings,
    nestedEntityMappings: store.nestedEntityMappings,
    constraints: store.constraints,
  }
  const result = computeSequenceProjections(data, con.id)
  const populationIssues = (store.populationIssues || []).filter(i => i.elementId === con.id)
  const typeLabel = con.constraintType === 'exclusion' ? 'Exclusion'
    : con.constraintType === 'equality' ? 'Equality'
    : con.constraintType === 'subset' ? 'Subset'
    : con.constraintType === 'inclusiveOr' ? 'Inclusive Or'
    : 'Exclusive Or'

  const displayVal = (v) => {
    if (typeof v === 'string') return v
    return JSON.stringify(v)
  }

  if (!result) {
    return (
      <div>
        <Header>{typeLabel} <strong>{con.name || `#${con.id.slice(0, 8)}`}</strong></Header>
        <EmptyState>No projection data available — constraint may lack required sequence or role structure.</EmptyState>
      </div>
    )
  }

  const { projections, seqCount } = result
  const isSingle = (proj) => {
    if (!proj.values.length) return false
    const v = proj.values[0]
    return typeof v === 'string' || (Array.isArray(v) && v.length <= 1)
  }

  // Compute violations per constraint type
  let violationEntries = []
  if (con.constraintType === 'exclusion') {
    for (let i = 0; i < projections.length; i++) {
      for (let j = i + 1; j < projections.length; j++) {
        for (const rawV of projections[i].values) {
          const key = JSON.stringify(projCellKey(rawV))
          if (projections[j].keys.has(key)) {
            violationEntries.push({ value: rawV, seqs: [i, j], key })
          }
        }
      }
    }
  } else if (con.constraintType === 'equality') {
    for (let i = 1; i < projections.length; i++) {
      for (const rawV of projections[0].values) {
        const key = JSON.stringify(projCellKey(rawV))
        if (!projections[i].keys.has(key)) {
          violationEntries.push({ value: rawV, seqs: [0, i], key, missingIn: i })
        }
      }
      for (const rawV of projections[i].values) {
        const key = JSON.stringify(projCellKey(rawV))
        if (!projections[0].keys.has(key)) {
          violationEntries.push({ value: rawV, seqs: [i, 0], key, missingIn: 0 })
        }
      }
    }
  } else if (con.constraintType === 'subset') {
    for (const rawV of projections[0].values) {
      const key = JSON.stringify(projCellKey(rawV))
      if (!projections[1].keys.has(key)) {
        violationEntries.push({ value: rawV, seqs: [0, 1], key })
      }
    }
  }

  const seqLabel = (i) => `Sequence ${i + 1}`

  return (
    <div>
      <Header>{typeLabel} <strong>{con.name || `#${con.id.slice(0, 8)}`}</strong></Header>
      <div style={{ fontSize: 11, color: 'var(--ink-muted)', marginBottom: 8 }}>
        {projections.length} sequence{projections.length === 1 ? '' : 's'}
        {violationEntries.length > 0 && (
          <span style={{ color: '#b91c1c' }}> — {violationEntries.length} violation{violationEntries.length === 1 ? '' : 's'}</span>
        )}
      </div>

      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
        {projections.map((proj, pi) => {
          const isProjSingle = isSingle(proj)
          return (
            <div key={pi} style={{ flex: '1 1 200px', minWidth: 160 }}>
              <div style={{ fontSize: 11, fontWeight: 600, marginBottom: 4, color: 'var(--ink-muted)' }}>
                {seqLabel(pi)} ({proj.values.length} value{proj.values.length === 1 ? '' : 's'}
                {proj.query ? ', query' : ', direct'}
                )
              </div>
              <div style={{ maxHeight: 200, overflowY: 'auto', border: '1px solid var(--border-soft)', borderRadius: 3 }}>
                {proj.values.length === 0 ? (
                  <div style={{ fontSize: 11, padding: 4, color: 'var(--ink-muted)' }}>Empty</div>
                ) : (
                  proj.values.map((rawV, vi) => {
                    const disp = isProjSingle ? displayVal(rawV)
                      : Array.isArray(rawV) ? `(${rawV.map(displayVal).join(', ')})`
                      : displayVal(rawV)
                    return (
                      <div key={vi} style={{
                        fontSize: 11, fontFamily: 'monospace', padding: '2px 4px',
                        borderBottom: vi < proj.values.length - 1 ? '1px solid var(--border-soft)' : 'none',
                      }}>
                        {disp}
                      </div>
                    )
                  })
                )}
              </div>
            </div>
          )
        })}
      </div>

      {violationEntries.length > 0 && (
        <div style={{ marginTop: 12 }}>
          <div style={{ fontSize: 11, color: '#b91c1c', marginBottom: 4 }}>
            {con.constraintType === 'subset' ? 'Values missing from superset'
              : con.constraintType === 'equality' ? 'Values missing from one or more sequences'
              : 'Overlapping values'} ({violationEntries.length}):
          </div>
          {violationEntries.slice(0, 50).map((entry, i) => {
            const disp = typeof entry.value === 'string' ? entry.value
              : Array.isArray(entry.value) ? `(${entry.value.map(displayVal).join(', ')})`
              : JSON.stringify(entry.value)
            let desc
            if (con.constraintType === 'exclusion') {
              desc = `in ${seqLabel(entry.seqs[0])} and ${seqLabel(entry.seqs[1])}`
            } else if (con.constraintType === 'equality') {
              desc = entry.missingIn !== undefined
                ? `in ${seqLabel(entry.seqs[0])} but not in ${seqLabel(entry.missingIn)}`
                : `in ${seqLabel(entry.seqs[0])} but not in ${seqLabel(entry.seqs[1])}`
            } else {
              desc = `in ${seqLabel(0)} but not in ${seqLabel(1)}`
            }
            return (
              <div key={i} style={{ fontSize: 11, color: '#b91c1c', marginBottom: 2 }}>
                • {disp} — {desc}
              </div>
            )
          })}
          {violationEntries.length > 50 && (
            <div style={{ fontSize: 11, color: 'var(--ink-muted)', marginTop: 2 }}>
              ...and {violationEntries.length - 50} more
            </div>
          )}
        </div>
      )}

      {populationIssues.length > 0 && (
        <div style={{ marginTop: 12 }}>
          <div style={{ fontSize: 11, color: '#b91c1c', marginBottom: 4 }}>Schema violations ({populationIssues.length}):</div>
          {populationIssues.map((issue, i) => (
            <div key={i} style={{ fontSize: 11, color: '#b91c1c', marginBottom: 2, lineHeight: 1.3 }}>
              • {issue.message}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function ValueComparisonPopulation({ con }) {
  const store = useOrmStore()
  const data = {
    facts: store.facts,
    factPopulations: store.factPopulations,
    objectTypes: store.objectTypes,
    populations: store.populations,
    subtypes: store.subtypes,
    subtypeMappings: store.subtypeMappings,
    nestedEntityMappings: store.nestedEntityMappings,
    constraints: store.constraints,
  }
  const result = computeValueComparisonData(data, con.id)
  const populationIssues = (store.populationIssues || []).filter(i => i.elementId === con.id)

  if (!result || result.mode === 'unsupported') {
    return (
      <div>
        <Header>Value Comparison <strong>{con.name || `#${con.id.slice(0, 8)}`}</strong></Header>
        <EmptyState>Validation is supported when the query of the role sequence defines a binary relation. Define a query above to enable population checking.</EmptyState>
        {populationIssues.length > 0 && (
          <div style={{ marginTop: 12 }}>
            <div style={{ fontSize: 11, color: '#b91c1c', marginBottom: 4 }}>Violations ({populationIssues.length}):</div>
            {populationIssues.map((issue, i) => (
              <div key={i} style={{ fontSize: 11, color: '#b91c1c', marginBottom: 2, lineHeight: 1.3 }}>• {issue.message}</div>
            ))}
          </div>
        )}
      </div>
    )
  }

  const { operator, pairs, label0, label1 } = result
  const violations = pairs.filter(p => p.violates)
  const cellSt = { padding: '2px 5px', borderBottom: '1px solid var(--border-soft)', fontSize: 11 }
  const headSt = { ...cellSt, fontWeight: 600, color: 'var(--ink-muted)', textAlign: 'left', background: 'var(--bg-raised)' }

  return (
    <div>
      <Header>Value Comparison <strong>{con.name || `#${con.id.slice(0, 8)}`}</strong></Header>
      <div style={{ fontSize: 11, color: 'var(--ink-muted)', marginBottom: 8 }}>
        Operator: <strong>{operator}</strong>
        {' — '}{pairs.length} tuple{pairs.length === 1 ? '' : 's'}
        {violations.length > 0 && (
          <span style={{ color: '#b91c1c' }}> — {violations.length} violation{violations.length === 1 ? '' : 's'}</span>
        )}
      </div>

      <div style={{ overflowX: 'auto', border: '1px solid var(--border-soft)', borderRadius: 3 }}>
        <table style={{ borderCollapse: 'collapse', width: '100%', minWidth: 240 }}>
          <thead>
            <tr>
              <th style={headSt}>{label0}</th>
              <th style={{ ...headSt, textAlign: 'center', width: 32 }}>{operator}</th>
              <th style={headSt}>{label1}</th>
              <th style={{ ...headSt, width: 22, textAlign: 'center' }}/>
            </tr>
          </thead>
          <tbody>
            {pairs.slice(0, 200).map((pair, i) => (
              <tr key={i} style={{ background: pair.violates ? 'rgba(220,38,38,0.06)' : undefined }}>
                <td style={{ ...cellSt, fontFamily: 'monospace' }}>{pair.v1 || <span style={{ color: 'var(--ink-muted)' }}>—</span>}</td>
                <td style={{ ...cellSt, textAlign: 'center', color: 'var(--ink-muted)' }}>{operator}</td>
                <td style={{ ...cellSt, fontFamily: 'monospace' }}>{pair.v2 || <span style={{ color: 'var(--ink-muted)' }}>—</span>}</td>
                <td style={{ ...cellSt, textAlign: 'center' }}>
                  {pair.v1 && pair.v2
                    ? pair.violates
                      ? <span style={{ color: '#dc2626', fontWeight: 700, fontSize: 10 }}>✕</span>
                      : <span style={{ color: '#16a34a', fontSize: 10 }}>✓</span>
                    : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {pairs.length > 200 && (
          <div style={{ fontSize: 11, color: 'var(--ink-muted)', padding: '4px 5px' }}>
            …and {pairs.length - 200} more rows
          </div>
        )}
      </div>
    </div>
  )
}

function EmptyState({ children }) {
  return (
    <div style={{ fontSize: 12, color: 'var(--ink-muted)', fontStyle: 'italic' }}>
      {children}
    </div>
  )
}

function Header({ children }) {
  return (
    <div style={{
      fontSize: 11, color: 'var(--ink-2)', marginBottom: 8,
      paddingBottom: 4, borderBottom: '1px solid var(--border-soft)',
    }}>{children}</div>
  )
}

// Delete-button styling — matches the Inspector's red-on-pink "×" buttons.
const removeBtnStyle = {
  flex: '0 0 auto', width: 22, height: 22, padding: 0,
  fontSize: 11, lineHeight: '20px',
  background: 'var(--bg-raised)', color: 'var(--danger)',
  border: '1px solid #e0b0a8', borderRadius: 3, cursor: 'pointer', flexShrink: 0,
}
const removeBtnHandlers = {
  onMouseEnter: e => {
    e.currentTarget.style.background = 'var(--danger)'
    e.currentTarget.style.color = '#fff'
    e.currentTarget.style.borderColor = 'var(--danger)'
  },
  onMouseLeave: e => {
    e.currentTarget.style.background = 'var(--bg-raised)'
    e.currentTarget.style.color = 'var(--danger)'
    e.currentTarget.style.borderColor = '#e0b0a8'
  },
}
const addBtnStyle = {
  fontSize: 11, padding: '4px 10px',
  background: 'var(--bg-raised)', color: 'var(--ink-2)',
  border: '1px solid var(--border-soft)', borderRadius: 3, cursor: 'pointer',
}
const colHeaderStyle = {
  fontSize: 10, color: 'var(--ink-muted)',
  textTransform: 'uppercase', letterSpacing: '0.08em',
  paddingBottom: 4,
}

function typeKindFromOt(ot) {
  return datatypeAssignmentToKind(ot?.datatypeAssignment)
}

// "Propagate" button used in the various Population panes. Always rendered;
// disabled when `missing` is empty. Clicking adds the missing values to
// `targetId`'s population (cascading further via the store helper).
function PropagateButton({ label, missing, targetId, onPropagate, title, style }) {
  const store = useOrmStore()
  const enabled = missing && missing.length > 0
  const tip = enabled
    ? (title || `Add ${missing.length} missing value${missing.length === 1 ? '' : 's'}`)
    : 'Nothing to propagate'
  const handleClick = enabled
    ? (onPropagate ?? (() => store.propagateValues(targetId, missing)))
    : undefined
  return (
    <button
      onClick={handleClick}
      disabled={!enabled}
      title={tip}
      style={{
        fontSize: 11, padding: '3px 9px',
        background: enabled ? 'var(--bg-raised)' : 'var(--bg-surface)',
        color: enabled ? 'var(--ink-2)' : 'var(--ink-muted)',
        border: '1px solid var(--border-soft)', borderRadius: 3,
        cursor: enabled ? 'pointer' : 'default',
        ...style,
      }}>
      {label}{enabled ? ` (${missing.length})` : ''}
    </button>
  )
}

// Compute missing values: items in `source` not present in `target` (compared
// by JSON encoding, so works for strings and arbitrary-depth tuples).
// Incomplete items are skipped.
function missingValues(source, target) {
  const targetKeys = new Set()
  for (const v of (target ?? [])) {
    if (isCompleteValue(v) || isPropagatableValue(v)) targetKeys.add(JSON.stringify(v))
  }
  const out = []
  const seen = new Set()
  for (const v of (source ?? [])) {
    if (!isPropagatableValue(v)) continue
    const k = JSON.stringify(v)
    if (targetKeys.has(k) || seen.has(k)) continue
    seen.add(k)
    out.push(v)
  }
  return out
}

// True for non-empty strings or arrays with at least one non-empty element.
// Unlike isCompleteValue, partial arrays qualify (e.g. ["d1", ""]).
function isPropagatableValue(v) {
  if (typeof v === 'string') return v !== '' && v !== UNSET
  if (!Array.isArray(v)) return false
  return v.some(e => typeof e === 'string' && e !== '' && e !== UNSET)
}

// Context-aware leaf candidate lookup. Given the population of an outer entity
// (`outerPop`), the current root value (`rootValue`) of a cell representing
// one instance of that entity, and a path from the root to a target leaf,
// return the distinct values that could appear at that leaf such that all
// other (complete) sibling values along the path match an instance in
// outerPop.
//
// Examples (Room ← Building+RoomNumber, Building ← BuildingCode+Campus):
//   rootValue = [["MAIN", "B1"], "01"], path = [0, 0]  → BuildingCodes in
//     Room.pop where the room's RoomNumber is "01" and the building's Campus
//     is "B1". (Empty sibling values impose no constraint.)
function candidatesAt(outerPop, rootValue, path) {
  const candidates = new Set()
  outer: for (const instance of outerPop ?? []) {
    let curInst = instance
    let curRoot = rootValue
    for (let depth = 0; depth < path.length; depth++) {
      if (!Array.isArray(curInst)) continue outer
      const targetIdx = path[depth]
      if (Array.isArray(curRoot)) {
        for (let i = 0; i < curInst.length; i++) {
          if (i === targetIdx) continue
          const sibling = curRoot[i]
          if (isCompleteValue(sibling)) {
            if (JSON.stringify(sibling) !== JSON.stringify(curInst[i])) continue outer
          }
        }
      }
      curInst = curInst[targetIdx]
      curRoot = Array.isArray(curRoot) ? curRoot[targetIdx] : undefined
    }
    if (typeof curInst === 'string' && curInst !== '') candidates.add(curInst)
  }
  return [...candidates].sort()
}

// Composite-PI entity population: a multi-column tuple editor, one column per
// identifying role of the identifying fact. Each tuple is one entity instance.
// When the PI is inherited (this entity is a subtype using its supertype's
// scheme), `inheritedFrom` is the supertype that owns the identifying fact.
function CompositePIEntityPopulation({ ot, cp, inheritedFrom }) {
  const store = useOrmStore()
  // For cross-fact PI (cp.factId === null), each column belongs to a different fact.
  const getFactForCol = (ci) =>
    store.facts.find(f => f.id === (cp.factIds ? cp.factIds[ci] : cp.factId))
  // Single identifying fact (null for cross-fact PI).
  const fact = cp.factId ? store.facts.find(f => f.id === cp.factId) : null
  if (!cp.factId && !cp.factIds) return <EmptyState>Identifying fact not found.</EmptyState>

  const tuples = store.populations?.[ot.id] ?? []
  const width  = cp.identifyingRoleIndices.length

  // Per-column nested cell shapes — each cell may itself be a composite-PI
  // tuple for nested PIs.
  const colShapes = cp.identifyingRoleIndices.map((ri, ci) => {
    const factForCol = getFactForCol(ci)
    const role = factForCol?.roles?.[ri]
    const playerOt = role?.objectTypeId
      ? findRolePlayer(role.objectTypeId, store.objectTypes, store.facts)
      : null
    return { role, playerOt, shape: getNestedCellShape(playerOt, store.facts, store.objectTypes, store.subtypes, store.constraints) }
  })
  const colLabel = (ci) => {
    const { role, playerOt } = colShapes[ci]
    return role?.roleName?.trim() || playerOt?.name || playerOt?.objectifiedName || `role ${ci + 1}`
  }
  // Autocomplete metadata keyed by leaf player id (shared across all leaves
  // referencing the same player, possibly at different nesting depths).
  const collectLeafPlayers = (shape, out) => {
    if (shape.kind === 'single') { if (shape.playerOtId) out.add(shape.playerOtId) }
    else shape.columns.forEach(c => collectLeafPlayers(c, out))
  }
  const leafPlayerIds = new Set()
  for (const cs of colShapes) collectLeafPlayers(cs.shape, leafPlayerIds)
  const popMetaByPlayer = new Map()
  for (const pid of leafPlayerIds) {
    const playerOt = store.objectTypes.find(o => o.id === pid)
    if (!playerOt) continue
    const pop = playerOt.kind === 'value'
      ? getVtEffectivePopulation(playerOt.id, store.populations || {}, store.facts, store.objectTypes, store.subtypes, store.subtypeMappings)
      : getEntityEffectivePopulation(playerOt.id, store.populations || {}, store.facts, store.objectTypes, store.subtypes, store.subtypeMappings)
    const values = pop.filter(v => typeof v === 'string')
    popMetaByPlayer.set(pid, {
      listId: values.length ? `pop-${ot.id}-p${pid}` : null,
      values,
      typeKind: typeKindFromOt(playerOt),
    })
  }
  const getMeta = (playerOtId) => popMetaByPlayer.get(playerOtId) || null

  // popFor: feed sub-scopes for context-aware narrowing. The TOP row is a new
  // entity instance being built (no outer scope), but a sub-cell that's a
  // composite-PI entity reference forms its own scope against that entity's pop.
  const popFor = (playerOtId) => {
    const player = playerOtId ? findRolePlayer(playerOtId, store.objectTypes, store.facts) : null
    if (!player) return null
    if (player.objectified) return store.factPopulations?.[player.id] ?? []
    if (player.kind !== 'entity') return null
    return getEntityEffectivePopulation(player.id, store.populations || {}, store.facts, store.objectTypes, store.subtypes, store.subtypeMappings)
  }

  const name = ot.name || 'entity'
  const reading = fact
    ? ((fact.readingParts || []).filter(Boolean).join(' ').trim() || 'identifying fact')
    : 'the identifying facts'

  // Index per-cell issues by "tupleIndex:cellIndex".
  const issuesByCell = new Map()
  for (const issue of (store.populationIssues || [])) {
    if (issue.otId !== ot.id) continue
    if (issue.instanceIndex == null || issue.cellIndex == null) continue
    const key = `${issue.instanceIndex}:${issue.cellIndex}`
    if (!issuesByCell.has(key)) issuesByCell.set(key, [])
    issuesByCell.get(key).push(issue)
  }

  const renderHeader = (shape, label) => {
    if (shape.kind === 'single') return <div style={{ ...colHeaderStyle, flex: 1, minWidth: 60 }}>{label}</div>
    return (
      <div style={{ ...colHeaderStyle, flex: shape.columns.length, minWidth: 60 * shape.columns.length }}>
        <div>{label}</div>
        <div style={{ display: 'flex', gap: 4, fontWeight: 400, opacity: 0.7, marginTop: 2 }}>
          {shape.columns.map((c, ci) => renderHeader(c, c.label))}
        </div>
      </div>
    )
  }

  return (
    <div>
      <Header>Population of <strong>{name}</strong></Header>
      <div style={{ maxWidth: 640, fontSize: 11, color: 'var(--ink-muted)', marginBottom: 8 }}>
        Each row is one {name} instance, identified by{' '}
        {fact
          ? <button onClick={() => store.select(fact.id, 'fact')}
              style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer',
                color: 'var(--accent)', fontSize: 11 }}>
              {reading}
            </button>
          : <span>{reading}</span>
        }
        {inheritedFrom && (
          <> (inherited from{' '}
            <button onClick={() => store.select(inheritedFrom.id, 'entity')}
              style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer',
                color: 'var(--accent)', fontSize: 11 }}>
              {inheritedFrom.name}
            </button>)
          </>
        )}.
      </div>
      <div style={{ maxWidth: 640 }}>
        {[...popMetaByPlayer.entries()].map(([pid, m]) => m.listId && (
          <datalist key={pid} id={m.listId}>
            {m.values.map((v, j) => <option key={j} value={v}/>)}
          </datalist>
        ))}
        <div style={{ display: 'flex', gap: 4 }}>
          {colShapes.map((cs, ci) => (
            <React.Fragment key={ci}>{renderHeader(cs.shape, colLabel(ci))}</React.Fragment>
          ))}
          <div style={{ width: 22 }}/>
        </div>
        {tuples.map((tuple, ti) => (
          <div key={ti} style={{ display: 'flex', gap: 4, marginBottom: 4, alignItems: 'center' }}>
            {colShapes.map((cs, ci) => {
              const cellIssues = issuesByCell.get(`${ti}:${ci}`)
              const cellIssue = cellIssues ? { message: cellIssues.map(it => it.message).join('\n') } : null
              return (
                <NestedCellEditor key={ci}
                  shape={cs.shape}
                  value={Array.isArray(tuple) ? tuple[ci] : undefined}
                  onChange={newCell => store.updateEntityTupleCell(ot.id, ti, ci, newCell)}
                  onCommit={() => store.commitEntityTupleCell(ot.id, ti, ci)}
                  getMeta={getMeta}
                  cellIssue={cellIssue}
                  popFor={popFor}/>
              )
            })}
            <button onClick={() => store.removeEntityTuple(ot.id, ti)}
              {...removeBtnHandlers}
              style={removeBtnStyle} title="Remove instance" aria-label="Remove instance">×</button>
          </div>
        ))}
        <button onClick={() => store.addEntityTuple(ot.id, width)} style={addBtnStyle}>
          + Add instance
        </button>
        <CompositePIPropagateTargets ot={ot} cp={cp} fact={fact} tuples={tuples}/>
      </div>
    </div>
  )
}

function ObjectTypePopulation({ ot }) {
  const store = useOrmStore()
  const isEntity = ot.kind === 'entity'
  const refMode  = isEntity ? findRefMode(ot, store.facts, store.objectTypes) : null
  let refVt     = refMode ? store.objectTypes.find(o => o.id === refMode.vtId) : null
  const compositePI = isEntity && !refMode ? findCompositePI(ot, store.facts, store.objectTypes, store.constraints) : null
  // No own PI? Walk up inheriting subtype edges for one to inherit.
  const inheritedPI = isEntity && !refMode && !compositePI
    ? findInheritedPI(ot, store.facts, store.objectTypes, store.subtypes, store.constraints)
    : null

  if (isEntity && compositePI) {
    return <CompositePIEntityPopulation ot={ot} cp={compositePI} />
  }

  if (isEntity && inheritedPI?.kind === 'compositePI') {
    return <CompositePIEntityPopulation ot={ot} cp={inheritedPI.cp} inheritedFrom={inheritedPI.supertype} />
  }

  // Inherited ref mode: same single-column editor as a direct ref-mode entity,
  // using the supertype's name for label derivation.
  let inheritedRefSupertype = null
  if (isEntity && inheritedPI?.kind === 'refMode') {
    inheritedRefSupertype = inheritedPI.supertype
    refVt = store.objectTypes.find(o => o.id === inheritedPI.refMode.vtId)
  }

  if (isEntity && !refVt) {
    return <EmptyState>Set a reference mode on {ot.name || 'this entity'} to enter sample instances.</EmptyState>
  }
  const instances   = store.populations?.[ot.id] ?? []
  // For inherited ref modes, derive the label using the *supertype's* name —
  // e.g., Employee subtype of Person with VT "PersonId" shows column ".id"
  // rather than the literal "PersonId".
  const labelEntityName = inheritedRefSupertype ? inheritedRefSupertype.name : ot.name
  const columnLabel = isEntity ? refModeLabel(labelEntityName, refVt.name) : (ot.name || 'value')
  const typeKind = isEntity ? null : typeKindFromOt(ot)
  const isBoolean = typeKind === 'boolean'
  // Index population issues for this OT by instance index (any issue that points
  // to a specific instance — currently typeMismatch and mandatoryRoleNotPlayed).
  const issuesByInstance = new Map()
  for (const issue of (store.populationIssues || [])) {
    if (issue.otId !== ot.id || issue.instanceIndex == null) continue
    const arr = issuesByInstance.get(issue.instanceIndex) ?? []
    arr.push(issue)
    issuesByInstance.set(issue.instanceIndex, arr)
  }
  return (
    <div>
      <Header>Population of <strong>{ot.name || (isEntity ? 'entity' : 'value')}</strong></Header>
      {inheritedRefSupertype && (
        <div style={{ maxWidth: 480, fontSize: 11, color: 'var(--ink-muted)', marginBottom: 8 }}>
          Identifier inherited from{' '}
          <button onClick={() => store.select(inheritedRefSupertype.id, 'entity')}
            style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer',
              color: 'var(--accent)', fontSize: 11 }}>
            {inheritedRefSupertype.name}
          </button>.
        </div>
      )}
      <div style={{ maxWidth: 480 }}>
        <div style={{ display: 'flex', gap: 4 }}>
          <div style={{ flex: 1, ...colHeaderStyle }}>{columnLabel}</div>
          <div style={{ width: 22 }}/>
        </div>
        {instances.map((v, i) => {
          const rowIssues = issuesByInstance.get(i)
          const issueStyle = rowIssues
            ? { borderColor: '#f5b400', boxShadow: 'inset 0 0 0 1px #f5b400', background: '#fff8e0' }
            : null
          return (
            <div key={i} style={{ display: 'flex', gap: 4, marginBottom: 4, alignItems: 'center' }}>
              {isBoolean ? (
                <select value={v ?? ''}
                  onChange={e => store.updatePopulationInstance(ot.id, i, e.target.value)}
                  onBlur={() => store.commitPopulationInstance(ot.id, i)}
                  className={rowIssues ? 'cell-issue' : undefined}
                  style={{ flex: 1, ...(issueStyle || {}), fontSize: 11, padding: '2px 4px' }}>
                  <option value=""></option>
                  <option value="true">true</option>
                  <option value="false">false</option>
                </select>
              ) : (
                <input value={v}
                  onChange={e => store.updatePopulationInstance(ot.id, i, e.target.value)}
                  onBlur={() => store.commitPopulationInstance(ot.id, i)}
                  onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur() }}
                  title={rowIssues ? rowIssues.map(it => it.message).join('\n') : undefined}
                  className={rowIssues ? 'cell-issue' : undefined}
                  style={{ flex: 1, ...(issueStyle || {}) }}
                  {...(typeKind === 'integer'  ? { type: 'number', step: 1 } : {})}
                  {...(typeKind === 'decimal'  ? { type: 'number', step: 'any' } : {})}
                  {...(typeKind === 'date'     ? { type: 'date' } : {})}
                  {...(typeKind === 'datetime' ? { type: 'datetime-local' } : {})}/>
              )}
              <button onClick={() => store.removePopulationInstance(ot.id, i)}
                {...removeBtnHandlers}
                style={removeBtnStyle} title="Remove instance" aria-label="Remove instance">×</button>
            </div>
          )
        })}
        <button onClick={() => store.addPopulationInstance(ot.id, '')}
          style={addBtnStyle}>+ Add instance</button>
        <PropagateTargets ot={ot} sourceValues={instances}/>
      </div>
      {(() => {
        const indepViolations = (store.populationIssues || []).filter(
          i => i.otId === ot.id && !i.factId &&
            (i.kind === 'nonIndependentNotPlaying' || i.kind === 'duplicateIdentifier')
        )
        if (!indepViolations.length) return null
        return (
          <div style={{ marginTop: 12 }}>
            <div style={{ fontSize: 11, color: '#b91c1c', marginBottom: 4 }}>Constraint violations ({indepViolations.length}):</div>
            {indepViolations.map((issue, i) => (
              <div key={i} style={{ fontSize: 11, color: '#b91c1c', marginBottom: 2, lineHeight: 1.3 }}>
                • {issue.message}
              </div>
            ))}
          </div>
        )
      })()}
    </div>
  )
}

// Propagate row for composite-PI entity populations: one button per
// identifying-role player (cell values → that player's pop), plus one button
// per inheriting supertype (whole tuple → supertype's pop).
function CompositePIPropagateTargets({ ot, cp, fact, tuples }) {
  const store = useOrmStore()
  if (!ot || !cp) return null
  const items = []
  // Per identifying-role player.
  cp.identifyingRoleIndices.forEach((ri, ci) => {
    const factForCol = cp.factIds
      ? store.facts.find(f => f.id === cp.factIds[ci])
      : fact
    const playerOtId = factForCol?.roles?.[ri]?.objectTypeId
    const player = playerOtId ? store.objectTypes.find(o => o.id === playerOtId) : null
    if (!player) return
    const cellValues = []
    for (const t of (tuples ?? [])) {
      if (!Array.isArray(t)) continue
      const c = t[ci]
      if (typeof c === 'string' && c !== '' && c !== UNSET) cellValues.push(c)
      else if (Array.isArray(c) && c.some(e => typeof e === 'string' && e !== '' && e !== UNSET)) cellValues.push(c)
    }
    items.push({
      id: player.id,
      label: `Propagate to ${player.name || 'player'}`,
      missing: missingValues(cellValues, store.populations?.[player.id]),
    })
  })
  // Inheriting supertypes (whole tuples).
  for (const st of (store.subtypes || [])) {
    if (st.subId !== ot.id) continue
    if (st.inheritsPreferredIdentifier === false) continue
    const sup = store.objectTypes.find(o => o.id === st.superId)
    if (!sup || sup.kind !== 'entity') continue
    items.push({
      id: sup.id,
      label: `Propagate to ${sup.name || 'supertype'}`,
      missing: missingValues(tuples, store.populations?.[sup.id]),
    })
  }
  if (items.length === 0) return null
  return (
    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 8 }}>
      {items.map(it => (
        <PropagateButton key={it.id} label={it.label} missing={it.missing} targetId={it.id}/>
      ))}
    </div>
  )
}

// Row of "Propagate to X" buttons shown below the editable population list of
// an entity or value type. One button per propagation target:
//   - entity: each inheriting supertype, the ref-mode VT (if any).
//   - value type: none (VTs are leaf populations under the new design).
function PropagateTargets({ ot, sourceValues }) {
  const store = useOrmStore()
  if (ot.kind !== 'entity') return null
  const targets = []
  // Inheriting supertype edges where this entity is the subtype.
  for (const st of (store.subtypes || [])) {
    if (st.subId !== ot.id) continue
    if (st.inheritsPreferredIdentifier === false) continue
    const sup = store.objectTypes.find(o => o.id === st.superId)
    if (!sup || sup.kind !== 'entity') continue
    targets.push({ id: sup.id, label: `Propagate to ${sup.name || 'supertype'}` })
  }
  // Ref-mode VT for this entity.
  const rm = findRefMode(ot, store.facts, store.objectTypes)
  if (rm) {
    const vt = store.objectTypes.find(o => o.id === rm.vtId)
    if (vt) targets.push({ id: vt.id, label: `Propagate to ${vt.name || 'value type'}` })
  }
  if (targets.length === 0) return null
  const targetPops = targets.map(t => ({
    ...t,
    missing: missingValues(sourceValues, store.populations?.[t.id]),
  }))
  return (
    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 8 }}>
      {targetPops.map(t => (
        <PropagateButton key={t.id} label={t.label} missing={t.missing} targetId={t.id}/>
      ))}
    </div>
  )
}

// Subtype-edge mapping editor. Left side = subtype identifier columns
// (always read-only, sourced from the subtype's population). Right side =
// supertype identifier columns: read-only mirror for inheriting edges,
// editable with autocomplete for non-inheriting edges.
//
// Both sides support nested identifiers via NestedCellEditor — e.g., a
// supertype whose composite-PI uses Building (itself composite-PI) renders
// the Building column as two sub-sub-inputs.
function SubtypeMappingPopulation({ edge }) {
  const store = useOrmStore()
  const sub  = store.objectTypes.find(o => o.id === edge.subId)
  const sup  = store.objectTypes.find(o => o.id === edge.superId)
  if (!sub || !sup) return <EmptyState>Subtype endpoint not found.</EmptyState>
  if (sub.kind !== 'entity' || sup.kind !== 'entity') {
    return <EmptyState>Mapping is only defined for entity-to-entity subtype edges.</EmptyState>
  }
  // Cell shape per side: a flat shape for the outer columns (so the table
  // layout still aligns row-by-row), and a per-column nested shape (used by
  // NestedCellEditor for any depth).
  const subTopShape = getEntityIdentifierShape(sub, store.facts, store.objectTypes, store.subtypes, store.constraints)
  const supTopShape = getEntityIdentifierShape(sup, store.facts, store.objectTypes, store.subtypes, store.constraints)
  if (!supTopShape) {
    return <EmptyState>Set a reference mode or composite identifier on {sup.name || 'the supertype'} first.</EmptyState>
  }
  if (!subTopShape) {
    return <EmptyState>Set a reference mode or composite identifier on {sub.name || 'the subtype'} first.</EmptyState>
  }
  const colShape = (topShape, ci) => {
    // For a top-level ref-mode shape, the "column" IS the cell (single value).
    // For composite-PI, the column has its own player whose own nested shape
    // we want.
    if (topShape.columns.length === 1) {
      const player = topShape.columns[0].playerOtId
        ? findRolePlayer(topShape.columns[0].playerOtId, store.objectTypes, store.facts) : null
      return getNestedCellShape(player, store.facts, store.objectTypes, store.subtypes, store.constraints)
    }
    const col = topShape.columns[ci]
    const player = col?.playerOtId
      ? findRolePlayer(col.playerOtId, store.objectTypes, store.facts) : null
    return getNestedCellShape(player, store.facts, store.objectTypes, store.subtypes, store.constraints)
  }
  const subColShapes = subTopShape.columns.map((_, ci) => colShape(subTopShape, ci))
  const supColShapes = supTopShape.columns.map((_, ci) => colShape(supTopShape, ci))

  const inherits = edge.inheritsPreferredIdentifier !== false
  const subPop   = store.populations?.[sub.id] ?? []
  const map      = store.subtypeMappings?.[edge.id] ?? []
  // Supertype pop for context-aware narrowing on the non-inheriting right side.
  // Each mapping row identifies one supertype instance; leaves narrow against
  // sup.pop respecting sibling top-level columns.
  const supPop   = !inherits ? (store.populations?.[sup.id] ?? []) : []

  // Collect leaf players for autocomplete (supertype side only — subtype side
  // is read-only).
  const collectLeafPlayers = (shape, out) => {
    if (shape.kind === 'single') { if (shape.playerOtId) out.add(shape.playerOtId) }
    else shape.columns.forEach(c => collectLeafPlayers(c, out))
  }
  const supLeafPlayers = new Set()
  for (const sh of supColShapes) collectLeafPlayers(sh, supLeafPlayers)
  const popMetaByPlayer = new Map()
  for (const pid of supLeafPlayers) {
    const playerOt = store.objectTypes.find(o => o.id === pid)
    if (!playerOt) continue
    const pop = playerOt.kind === 'value'
      ? getVtEffectivePopulation(playerOt.id, store.populations || {}, store.facts, store.objectTypes, store.subtypes, store.subtypeMappings)
      : getEntityEffectivePopulation(playerOt.id, store.populations || {}, store.facts, store.objectTypes, store.subtypes, store.subtypeMappings)
    const values = pop.filter(v => typeof v === 'string')
    popMetaByPlayer.set(pid, {
      listId: values.length ? `pop-st-${edge.id}-p${pid}` : null,
      values,
      typeKind: typeKindFromOt(playerOt),
    })
  }
  const getMeta = (playerOtId) => popMetaByPlayer.get(playerOtId) || null

  // Per-row issues for this subtype edge.
  const rowIssuesByIndex = new Map()
  for (const issue of (store.populationIssues || [])) {
    if (issue.subtypeEdgeId !== edge.id) continue
    const idxs = issue.rowIndex != null ? [issue.rowIndex]
      : Array.isArray(issue.rowIndices) ? issue.rowIndices : []
    for (const r of idxs) {
      if (!rowIssuesByIndex.has(r)) rowIssuesByIndex.set(r, [])
      rowIssuesByIndex.get(r).push(issue)
    }
  }

  // Subtype-side value at row i, column ci. For width-1 the instance IS the
  // cell value; for wider it indexes into the instance tuple.
  const subCellValue = (i, ci) => {
    const inst = subPop[i]
    if (subTopShape.columns.length === 1) return inst
    return Array.isArray(inst) ? inst[ci] : undefined
  }
  // Supertype-side value (stored OR mirrored for inheriting edges).
  const supCellValue = (i, ci) => {
    if (inherits) return subCellValue(i, ci)
    const row = map[i]
    return Array.isArray(row) ? row[ci] : undefined
  }
  // Whole supertype-side row for storage when the supertype is single-column
  // (no outer wrapping — row is one cell). For wider, the cell replaces one
  // slot in the row.
  const writeSupCell = (i, ci, newVal) => {
    store.updateSubtypeMappingCell(edge.id, i, ci, newVal)
  }

  const renderHeader = (shape, label) => {
    if (shape.kind === 'single') return <div style={{ ...colHeaderStyle, flex: 1, minWidth: 60 }}>{label}</div>
    return (
      <div style={{ ...colHeaderStyle, flex: shape.columns.length, minWidth: 60 * shape.columns.length }}>
        <div>{label}</div>
        <div style={{ display: 'flex', gap: 4, fontWeight: 400, opacity: 0.7, marginTop: 2 }}>
          {shape.columns.map((c, ci) => renderHeader(c, c.label))}
        </div>
      </div>
    )
  }

  return (
    <div>
      <Header>Subtype mapping: <strong>{sub.name}</strong> → <strong>{sup.name}</strong></Header>
      <div style={{ maxWidth: 720, fontSize: 11, color: 'var(--ink-muted)', marginBottom: 8 }}>
        {inherits
          ? <>The subtype inherits the supertype's preferred identifier — the mapping is the identity and is shown read-only.</>
          : <>Each row maps one {sub.name} instance to the corresponding {sup.name} instance. Add or remove subtype instances on{' '}
              <button onClick={() => store.select(sub.id, 'entity')}
                style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer',
                  color: 'var(--accent)', fontSize: 11 }}>{sub.name}</button>.
            </>}
      </div>
      <div style={{ maxWidth: 720 }}>
        {/* Datalists for supertype-side autocomplete */}
        {!inherits && [...popMetaByPlayer.entries()].map(([pid, m]) => m.listId && (
          <datalist key={pid} id={m.listId}>
            {m.values.map((v, j) => <option key={j} value={v}/>)}
          </datalist>
        ))}
        {/* Header row */}
        <div style={{ display: 'flex', gap: 4 }}>
          {subTopShape.columns.map((c, ci) => (
            <React.Fragment key={`s${ci}`}>{renderHeader(subColShapes[ci], c.label)}</React.Fragment>
          ))}
          <div style={{ width: 16, alignSelf: 'center', textAlign: 'center', color: 'var(--ink-muted)' }}>→</div>
          {supTopShape.columns.map((c, ci) => (
            <React.Fragment key={`p${ci}`}>{renderHeader(supColShapes[ci], c.label)}</React.Fragment>
          ))}
        </div>
        {subPop.length === 0
          ? <EmptyState>No {sub.name} instances yet.</EmptyState>
          : subPop.map((_, i) => {
            const rowIssues = rowIssuesByIndex.get(i)
            const cellIssue = rowIssues ? { message: rowIssues.map(it => it.message).join('\n') } : null
            return (
              <div key={i} style={{ display: 'flex', gap: 4, marginBottom: 4, alignItems: 'center' }}>
                {subColShapes.map((sh, ci) => (
                  <NestedCellEditor key={`sc${ci}`}
                    shape={sh}
                    value={subCellValue(i, ci)}
                    onChange={() => {}}
                    disabled={true}/>
                ))}
                <div style={{ width: 16, textAlign: 'center', color: 'var(--ink-muted)' }}>→</div>
                {(() => {
                  // For non-inheriting edges with a multi-column supertype:
                  // build the full row so sibling top-level cells can narrow
                  // each other (Strategy A across the whole row).
                  const supWidth = supTopShape.columns.length
                  const supRow = !inherits && supWidth > 1
                    ? Array.from({ length: supWidth }, (_, ci) => supCellValue(i, ci))
                    : null
                  return supColShapes.map((sh, ci) => (
                    inherits
                      ? <NestedCellEditor key={`pc${ci}`}
                          shape={sh}
                          value={supCellValue(i, ci)}
                          onChange={() => {}}
                          disabled={true}/>
                      : <NestedCellEditor key={`pc${ci}`}
                          shape={sh}
                          value={supCellValue(i, ci)}
                          onChange={newVal => writeSupCell(i, ci, newVal)}
                          onCommit={() => store.commitSubtypeMappingCell(edge.id, i, ci)}
                          getMeta={getMeta}
                          cellIssue={cellIssue}
                          outerScope={supRow ? { pop: supPop, value: supRow } : null}
                          leafPath={supRow ? [ci] : []}/>
                  ))
                })()}
              </div>
            )
          })}
        {!inherits && (() => {
          // Propagate button: pushes every complete mapping row's
          // supertype-encoded instance to the supertype's population.
          const complete = []
          for (const row of map) {
            if (!Array.isArray(row)) continue
            // For width-1 supertype: the row holds one cell that itself may
            // be a string or a nested tuple (whole instance).
            // For wider:           the row's cells together form the instance.
            const cells = supTopShape.columns.map((_, ci) => row[ci])
            const instance = supTopShape.columns.length === 1 ? cells[0] : cells
            if (!isCompleteValue(instance)) continue
            complete.push(instance)
          }
          const missing = missingValues(complete, store.populations?.[sup.id])
          return (
            <div style={{ marginTop: 8 }}>
              <PropagateButton
                label={`Propagate to ${sup.name || 'supertype'}`}
                missing={missing}
                targetId={sup.id}/>
            </div>
          )
        })()}
      </div>
    </div>
  )
}

// ── Nested entity type population ──────────────────────────────────────────
// Dispatches between the implicit-PI case (editable fact table + derived
// implied links) and the explicit-PI case (combined PI=>Fact table + derived
// PI fact + derived implied links).
function NestedEntityObjectifiedPopulation({ fact }) {
  const store = useOrmStore()
  const arity = fact.arity ?? fact.roles?.length ?? 0
  if (arity < 1) return <EmptyState>This fact type has no roles.</EmptyState>

  const rm        = findRefMode(fact, store.facts, store.objectTypes)
  const cp        = !rm ? findCompositePI(fact, store.facts, store.objectTypes, store.constraints) : null
  const inherited = (!rm && !cp)
    ? findInheritedPI(fact, store.facts, store.objectTypes, store.subtypes, store.constraints) : null
  const hasExplicitPI = !!(rm || cp || inherited)

  const name       = fact.objectifiedName || (fact.readingParts || []).filter(Boolean).join(' ').trim() || 'nested entity'
  const factTuples = store.factPopulations?.[fact.id] ?? []

  // Shape of each role in the underlying fact (for fact-side columns).
  const roleShapes = fact.roles.slice(0, arity).map(role => {
    const player = role?.objectTypeId
      ? findRolePlayer(role.objectTypeId, store.objectTypes, store.facts) : null
    return getNestedCellShape(player, store.facts, store.objectTypes, store.subtypes, store.constraints)
  })
  // Shape of the nested entity itself as a role player (for implied-link left column).
  const entityShape = getNestedCellShape(fact, store.facts, store.objectTypes, store.subtypes, store.constraints)

  const roleLabel = (ri) => {
    const r = fact.roles[ri]
    if (r?.roleName) return r.roleName
    const player = r?.objectTypeId
      ? findRolePlayer(r.objectTypeId, store.objectTypes, store.facts) : null
    return player?.name || player?.objectifiedName || `role ${ri + 1}`
  }

  if (!hasExplicitPI) {
    return <NestedEntityImplicitPIPopulation
      fact={fact} arity={arity} name={name} factTuples={factTuples}
      roleShapes={roleShapes} entityShape={entityShape} roleLabel={roleLabel} />
  }

  const piShape = getEntityIdentifierShape(fact, store.facts, store.objectTypes, store.subtypes, store.constraints)
  return <NestedEntityExplicitPIPopulation
    fact={fact} arity={arity} name={name} factTuples={factTuples}
    roleShapes={roleShapes} entityShape={entityShape} roleLabel={roleLabel}
    rm={rm} cp={cp} inherited={inherited} piShape={piShape} />
}

// ── Implied-link population (derived, shown when the implied link is selected) ─
function ImpliedLinkPopulation({ parentFact, roleIndex }) {
  const store = useOrmStore()
  const arity = parentFact.arity ?? parentFact.roles?.length ?? 0
  const role  = parentFact.roles[roleIndex]
  const rolePlayer = role?.objectTypeId
    ? findRolePlayer(role.objectTypeId, store.objectTypes, store.facts) : null

  // PI detection for the parent nested entity.
  const rm        = findRefMode(parentFact, store.facts, store.objectTypes)
  const cp        = !rm ? findCompositePI(parentFact, store.facts, store.objectTypes, store.constraints) : null
  const inherited = (!rm && !cp)
    ? findInheritedPI(parentFact, store.facts, store.objectTypes, store.subtypes, store.constraints) : null
  const hasExplicitPI = !!(rm || cp || inherited)
  const piShape = hasExplicitPI
    ? getEntityIdentifierShape(parentFact, store.facts, store.objectTypes, store.subtypes, store.constraints) : null

  // Shapes for the two columns of the implied-link table.
  const entityShape = getNestedCellShape(parentFact, store.facts, store.objectTypes, store.subtypes, store.constraints)
  const roleShape   = getNestedCellShape(rolePlayer,  store.facts, store.objectTypes, store.subtypes, store.constraints)

  // Column labels.
  const entityLabel = piShape
    ? `(${(piShape.columns || []).map(c => c.label).join(', ')})`
    : `(${Array.from({ length: arity }, (_, ri) => {
        const r = parentFact.roles[ri]
        const p = r?.objectTypeId ? findRolePlayer(r.objectTypeId, store.objectTypes, store.facts) : null
        return r?.roleName || p?.name || p?.objectifiedName || `role ${ri + 1}`
      }).join(', ')})`
  const roleLabel = role?.roleName || rolePlayer?.name || rolePlayer?.objectifiedName || `role ${roleIndex + 1}`
  const name = parentFact.objectifiedName || (parentFact.readingParts || []).filter(Boolean).join(' ').trim() || 'nested entity'

  // Row data.
  const factTuples = store.factPopulations?.[parentFact.id] ?? []
  const piValues   = hasExplicitPI ? (store.nestedEntityMappings?.[parentFact.id] ?? []) : null

  return (
    <div>
      <Header>Implied link: <strong>{name}</strong> → <strong>{roleLabel}</strong></Header>
      <div style={{ maxWidth: 640, fontSize: 11, color: 'var(--ink-muted)', marginBottom: 8 }}>
        Derived from the population of{' '}
        <button onClick={() => store.select(parentFact.id, 'fact')}
          style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer',
            color: 'var(--accent)', fontSize: 11 }}>
          {name}
        </button>. Read-only.
      </div>
      <div style={{ maxWidth: 640 }}>
        <div style={{ display: 'flex', gap: 4, marginBottom: 4 }}>
          {renderNestedHeader(entityShape, entityLabel)}
          {renderNestedHeader(roleShape, roleLabel)}
        </div>
        {factTuples.length === 0
          ? <EmptyState>No rows yet. Add rows on <button
              onClick={() => store.select(parentFact.id, 'fact')}
              style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer',
                color: 'var(--accent)', fontSize: 12 }}>{name}</button>.</EmptyState>
          : factTuples.map((tuple, i) => {
            const entityRef = piValues !== null ? piValues[i] : tuple
            const roleVal   = Array.isArray(tuple) ? tuple[roleIndex] : undefined
            return (
              <div key={i} style={{ display: 'flex', gap: 4, marginBottom: 4, alignItems: 'center' }}>
                <NestedCellEditor shape={entityShape} value={entityRef} onChange={() => {}} disabled />
                <NestedCellEditor shape={roleShape}   value={roleVal}   onChange={() => {}} disabled />
              </div>
            )
          })}
      </div>
    </div>
  )
}

// renderHeader helper shared across nested entity sub-components.
function renderNestedHeader(shape, label) {
  if (shape.kind === 'single') {
    return <div style={{ ...colHeaderStyle, flex: 1, minWidth: 60 }}>{label}</div>
  }
  return (
    <div style={{ ...colHeaderStyle, flex: shape.columns.length, minWidth: 60 * shape.columns.length }}>
      <div>{label}</div>
      <div style={{ display: 'flex', gap: 4, fontWeight: 400, opacity: 0.7, marginTop: 2 }}>
        {shape.columns.map((c, ci) => renderNestedHeader(c, c.label))}
      </div>
    </div>
  )
}

// Derived implied-links section. Shown in both PI cases.
// piValues: null → use factTuples as the entity reference (implicit PI).
//           array → use nestedEntityMappings values as entity reference (explicit PI).
// piShape: identifier shape used to derive the entity column label for explicit-PI case.
function DerivedImpliedLinks({ arity, factTuples, roleShapes, entityShape, roleLabel, piValues, piShape }) {
  const entityLabel = (() => {
    if (piShape) {
      // Explicit PI: label from the PI column labels, e.g. "(.ref)" or "(A, B)"
      const cols = piShape.columns || []
      return `(${cols.map(c => c.label).join(', ')})`
    }
    // Implicit PI: label from the underlying fact's role labels
    return `(${Array.from({ length: arity }, (_, ri) => roleLabel(ri)).join(', ')})`
  })()

  return (
    <div>
      <SectionDivider label="Implied links (derived)" />
      <div style={{ fontSize: 11, color: 'var(--ink-muted)', marginBottom: 8 }}>
        The implied binary links from this nested entity type to its role players are derived
        from the population above and shown read-only.
      </div>
      {Array.from({ length: arity }, (_, ri) => {
        const playerLabel = roleLabel(ri)
        const rows = factTuples.length > 0 ? factTuples : []
        return (
          <div key={ri} style={{ marginBottom: 12 }}>
            <div style={{ fontSize: 11, color: 'var(--ink-2)', marginBottom: 4 }}>
              Implied link → <strong>{playerLabel}</strong>
            </div>
            <div style={{ display: 'flex', gap: 4, marginBottom: 4 }}>
              {renderNestedHeader(entityShape, entityLabel)}
              {renderNestedHeader(roleShapes[ri], playerLabel)}
            </div>
            {rows.length === 0
              ? <EmptyState>No rows yet.</EmptyState>
              : rows.map((tuple, ti) => {
                  const entityRef = piValues === null ? tuple : piValues[ti]
                  const roleVal   = Array.isArray(tuple) ? tuple[ri] : undefined
                  return (
                    <div key={ti} style={{ display: 'flex', gap: 4, marginBottom: 4, alignItems: 'center' }}>
                      <NestedCellEditor shape={entityShape} value={entityRef} onChange={() => {}} disabled />
                      <NestedCellEditor shape={roleShapes[ri]} value={roleVal} onChange={() => {}} disabled />
                    </div>
                  )
                })}
          </div>
        )
      })}
    </div>
  )
}

// Case 1: No explicit PI. Editable underlying fact table + derived implied links.
function NestedEntityImplicitPIPopulation({ fact, arity, name, factTuples, roleShapes, entityShape, roleLabel }) {
  const store = useOrmStore()

  // Autocomplete metadata per leaf player (same pattern as FactTypePopulation).
  const collectLeafPlayers = (shape, out) => {
    if (shape.kind === 'single') { if (shape.playerOtId) out.add(shape.playerOtId) }
    else shape.columns.forEach(c => collectLeafPlayers(c, out))
  }
  const leafPlayerIds = new Set()
  for (const sh of roleShapes) collectLeafPlayers(sh, leafPlayerIds)
  const popMetaByPlayer = new Map()
  for (const pid of leafPlayerIds) {
    const playerOt = store.objectTypes.find(o => o.id === pid)
    if (!playerOt) continue
    const pop = playerOt.kind === 'value'
      ? getVtEffectivePopulation(playerOt.id, store.populations || {}, store.facts, store.objectTypes, store.subtypes, store.subtypeMappings)
      : getEntityEffectivePopulation(playerOt.id, store.populations || {}, store.facts, store.objectTypes, store.subtypes, store.subtypeMappings)
    popMetaByPlayer.set(pid, {
      listId: pop.filter(v => typeof v === 'string').length
        ? `pop-ne-${fact.id}-p${pid}` : null,
      values: pop.filter(v => typeof v === 'string'),
      typeKind: typeKindFromOt(playerOt),
    })
  }
  const getMeta = (id) => popMetaByPlayer.get(id) || null

  const issuesByCell = new Map()
  for (const issue of (store.populationIssues || [])) {
    if (issue.factId !== fact.id) continue
    const push = (ti, ri) => {
      const k = `${ti}:${ri}`
      if (!issuesByCell.has(k)) issuesByCell.set(k, [])
      issuesByCell.get(k).push(issue)
    }
    if (Array.isArray(issue.tupleIndices) && Array.isArray(issue.roleIndices)) {
      for (const ti of issue.tupleIndices) for (const ri of issue.roleIndices) push(ti, ri)
    } else if (issue.tupleIndex != null && issue.roleIndex != null) {
      push(issue.tupleIndex, issue.roleIndex)
    }
  }

  return (
    <div>
      <Header>Population of <strong>{name}</strong></Header>
      <div style={{ maxWidth: 640, fontSize: 11, color: 'var(--ink-muted)', marginBottom: 8 }}>
        No explicit preferred identifier — instances are identified by their role players.
        Each row is one fact tuple.
      </div>
      {[...popMetaByPlayer.entries()].map(([pid, m]) => m.listId && (
        <datalist key={pid} id={m.listId}>
          {m.values.map((v, j) => <option key={j} value={v}/>)}
        </datalist>
      ))}
      <div style={{ maxWidth: 640 }}>
        <div style={{ display: 'flex', gap: 4, marginBottom: 4 }}>
          {roleShapes.map((sh, ri) => (
            <React.Fragment key={ri}>{renderNestedHeader(sh, roleLabel(ri))}</React.Fragment>
          ))}
          <div style={{ width: 22 }}/>
        </div>
        {factTuples.map((tuple, ti) => (
          <div key={ti} style={{ display: 'flex', gap: 4, marginBottom: 4, alignItems: 'center' }}>
            {roleShapes.map((sh, ri) => {
              const issues = issuesByCell.get(`${ti}:${ri}`)
              const cellIssue = issues ? { message: issues.map(i => i.message).join('\n') } : null
              return (
                <NestedCellEditor key={ri}
                  shape={sh}
                  value={Array.isArray(tuple) ? tuple[ri] : undefined}
                  onChange={v => store.updateFactTupleCell(fact.id, ti, ri, v)}
                  onCommit={() => store.commitFactTupleCell(fact.id, ti, ri)}
                  getMeta={getMeta}
                  cellIssue={cellIssue} />
              )
            })}
            <button onClick={() => store.removeFactTuple(fact.id, ti)}
              {...removeBtnHandlers} style={removeBtnStyle}
              title="Remove tuple" aria-label="Remove tuple">×</button>
          </div>
        ))}
        <button onClick={() => store.addFactTuple(fact.id)} style={addBtnStyle}>
          + Add tuple
        </button>
      </div>

    </div>
  )
}

// Case 2: Explicit PI. Combined (PI => Fact) table + derived PI-fact + derived implied links.
function NestedEntityExplicitPIPopulation({ fact, arity, name, factTuples, roleShapes, entityShape, roleLabel, rm, cp, inherited, piShape }) {
  const store = useOrmStore()
  const piValues  = store.nestedEntityMappings?.[fact.id] ?? []
  const rowCount  = Math.max(piValues.length, factTuples.length)

  const piCols    = piShape?.columns ?? []
  const piWidth   = piCols.length

  // PI-side cell shapes.
  const piColShapes = piCols.map(col => {
    const player = col.playerOtId
      ? findRolePlayer(col.playerOtId, store.objectTypes, store.facts) : null
    return getNestedCellShape(player, store.facts, store.objectTypes, store.subtypes, store.constraints)
  })

  // Autocomplete for PI side.
  const collectLeafPlayers = (shape, out) => {
    if (shape.kind === 'single') { if (shape.playerOtId) out.add(shape.playerOtId) }
    else shape.columns.forEach(c => collectLeafPlayers(c, out))
  }
  const piLeafIds = new Set()
  for (const sh of piColShapes) collectLeafPlayers(sh, piLeafIds)
  const factLeafIds = new Set()
  for (const sh of roleShapes) collectLeafPlayers(sh, factLeafIds)
  const allLeafIds = new Set([...piLeafIds, ...factLeafIds])

  const popMetaByPlayer = new Map()
  for (const pid of allLeafIds) {
    const playerOt = store.objectTypes.find(o => o.id === pid)
    if (!playerOt) continue
    const pop = playerOt.kind === 'value'
      ? getVtEffectivePopulation(playerOt.id, store.populations || {}, store.facts, store.objectTypes, store.subtypes, store.subtypeMappings)
      : getEntityEffectivePopulation(playerOt.id, store.populations || {}, store.facts, store.objectTypes, store.subtypes, store.subtypeMappings)
    popMetaByPlayer.set(pid, {
      listId: pop.filter(v => typeof v === 'string').length
        ? `pop-nepi-${fact.id}-p${pid}` : null,
      values: pop.filter(v => typeof v === 'string'),
      typeKind: typeKindFromOt(playerOt),
    })
  }
  const getMeta = (id) => popMetaByPlayer.get(id) || null

  // Extract PI cell value for row i, col ci.
  const piCellValue = (i, ci) => {
    const piv = piValues[i]
    if (piWidth <= 1) return typeof piv === 'string' ? piv : ''
    return Array.isArray(piv) ? piv[ci] : undefined
  }


  // Population issues for the fact side.
  const issuesByCell = new Map()
  for (const issue of (store.populationIssues || [])) {
    if (issue.factId !== fact.id) continue
    const push = (ti, ri) => {
      const k = `${ti}:${ri}`
      if (!issuesByCell.has(k)) issuesByCell.set(k, [])
      issuesByCell.get(k).push(issue)
    }
    if (Array.isArray(issue.tupleIndices) && Array.isArray(issue.roleIndices)) {
      for (const ti of issue.tupleIndices) for (const ri of issue.roleIndices) push(ti, ri)
    } else if (issue.tupleIndex != null && issue.roleIndex != null) {
      push(issue.tupleIndex, issue.roleIndex)
    }
  }

  const inheritedFrom = inherited?.supertype ?? null

  return (
    <div>
      <Header>Population of <strong>{name}</strong></Header>
      <div style={{ maxWidth: 720, fontSize: 11, color: 'var(--ink-muted)', marginBottom: 8 }}>
        Each row maps one <strong>{name}</strong> instance (identified by its preferred identifier)
        to the underlying fact tuple. The left side <strong style={{ color: 'var(--ink-2)' }}>
          ({piCols.map(c => c.label).join(', ')})
        </strong> is the preferred identifier; the right side <strong style={{ color: 'var(--ink-2)' }}>
          ({Array.from({ length: arity }, (_, ri) => roleLabel(ri)).join(', ')})
        </strong> is the underlying fact.
        {inheritedFrom && (
          <> Identifier inherited from{' '}
            <button onClick={() => store.select(inheritedFrom.id, inheritedFrom.objectified ? 'fact' : 'entity')}
              style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer',
                color: 'var(--accent)', fontSize: 11 }}>
              {inheritedFrom.name || inheritedFrom.objectifiedName}
            </button>.
          </>
        )}
      </div>

      {/* Datalists */}
      {[...popMetaByPlayer.entries()].map(([pid, m]) => m.listId && (
        <datalist key={pid} id={m.listId}>
          {m.values.map((v, j) => <option key={j} value={v}/>)}
        </datalist>
      ))}

      {/* Combined table */}
      <div style={{ maxWidth: 720 }}>
        {/* Header */}
        <div style={{ display: 'flex', gap: 4, alignItems: 'flex-end', marginBottom: 4 }}>
          {piColShapes.map((sh, ci) => (
            <React.Fragment key={`pi${ci}`}>{renderNestedHeader(sh, piCols[ci]?.label ?? `pi${ci + 1}`)}</React.Fragment>
          ))}
          <div style={{ padding: '0 4px', color: 'var(--ink-muted)', fontSize: 12, alignSelf: 'center',
            fontWeight: 700, flexShrink: 0 }}>⇒</div>
          {roleShapes.map((sh, ri) => (
            <React.Fragment key={`ft${ri}`}>{renderNestedHeader(sh, roleLabel(ri))}</React.Fragment>
          ))}
          <div style={{ width: 22 }}/>
        </div>

        {/* Rows */}
        {rowCount === 0
          ? <EmptyState>No instances yet.</EmptyState>
          : Array.from({ length: rowCount }, (_, i) => {
            const factTuple = factTuples[i]
            return (
              <div key={i} style={{ display: 'flex', gap: 4, marginBottom: 4, alignItems: 'center' }}>
                {/* PI cells */}
                {piColShapes.map((sh, ci) => (
                  <NestedCellEditor key={`pi${ci}`}
                    shape={sh}
                    value={piCellValue(i, ci)}
                    onChange={v => {
                      if (piWidth <= 1) {
                        store.updateNestedEntityPICell(fact.id, i, 0, v)
                      } else {
                        store.updateNestedEntityPICell(fact.id, i, ci, v)
                      }
                    }}
                    onCommit={() => store.commitNestedEntityPICell(fact.id, i)}
                    getMeta={getMeta} />
                ))}
                <div style={{ padding: '0 4px', color: 'var(--ink-muted)', fontSize: 12,
                  alignSelf: 'center', fontWeight: 700, flexShrink: 0 }}>⇒</div>
                {/* Fact cells */}
                {roleShapes.map((sh, ri) => {
                  const issues = issuesByCell.get(`${i}:${ri}`)
                  const cellIssue = issues ? { message: issues.map(iss => iss.message).join('\n') } : null
                  return (
                    <NestedCellEditor key={`ft${ri}`}
                      shape={sh}
                      value={Array.isArray(factTuple) ? factTuple[ri] : undefined}
                      onChange={v => store.updateFactTupleCell(fact.id, i, ri, v)}
                      onCommit={() => store.commitFactTupleCell(fact.id, i, ri)}
                      getMeta={getMeta}
                      cellIssue={cellIssue} />
                  )
                })}
                <button onClick={() => store.removeNestedEntityRow(fact.id, i)}
                  {...removeBtnHandlers} style={removeBtnStyle}
                  title="Remove row" aria-label="Remove row">×</button>
              </div>
            )
          })}
        <button onClick={() => store.addNestedEntityRow(fact.id)} style={addBtnStyle}>
          + Add row
        </button>
      </div>

    </div>
  )
}

function FactTypePopulation({ fact }) {
  const store = useOrmStore()
  const arity = fact.arity ?? fact.roles?.length ?? 0
  if (arity < 1) return <EmptyState>This fact type has no roles.</EmptyState>

  // Per-role nested cell shape and metadata lookup for NestedCellEditor.
  const roleShapes = fact.roles.slice(0, arity).map(role => {
    const player = role?.objectTypeId
      ? findRolePlayer(role.objectTypeId, store.objectTypes, store.facts)
      : null
    return getNestedCellShape(player, store.facts, store.objectTypes, store.subtypes, store.constraints)
  })
  // Per-role player pop for context-aware narrowing. The cell at a role is a
  // reference to one instance of the player, so narrow against the player's
  // effective population. VT players have no narrowing scope (no siblings).
  const rolePlayerPops = fact.roles.slice(0, arity).map(role => {
    const player = role?.objectTypeId
      ? findRolePlayer(role.objectTypeId, store.objectTypes, store.facts)
      : null
    if (!player) return null
    if (player.objectified) {
      const rm = findRefMode(player, store.facts, store.objectTypes)
      if (rm) {
        return getVtEffectivePopulation(rm.vtId, store.populations || {}, store.facts, store.objectTypes, store.subtypes, store.subtypeMappings)
      }
      return store.factPopulations?.[player.id] ?? []
    }
    if (player.kind !== 'entity') return null
    return getEntityEffectivePopulation(player.id, store.populations || {}, store.facts, store.objectTypes, store.subtypes, store.subtypeMappings)
  })
  const collectLeafPlayers = (shape, out) => {
    if (shape.kind === 'single') { if (shape.playerOtId) out.add(shape.playerOtId) }
    else shape.columns.forEach(c => collectLeafPlayers(c, out))
  }
  const leafPlayerIds = new Set()
  for (const sh of roleShapes) collectLeafPlayers(sh, leafPlayerIds)
  const popMetaByPlayer = new Map()
  for (const pid of leafPlayerIds) {
    const playerOt = store.objectTypes.find(o => o.id === pid)
    if (!playerOt) continue
    const pop = playerOt.kind === 'value'
      ? getVtEffectivePopulation(playerOt.id, store.populations || {}, store.facts, store.objectTypes, store.subtypes, store.subtypeMappings)
      : getEntityEffectivePopulation(playerOt.id, store.populations || {}, store.facts, store.objectTypes, store.subtypes, store.subtypeMappings)
    const values = pop.filter(v => typeof v === 'string')
    popMetaByPlayer.set(pid, {
      listId: values.length ? `pop-${fact.id}-p${pid}` : null,
      values,
      typeKind: typeKindFromOt(playerOt),
    })
  }
  const getMeta = (playerOtId) => popMetaByPlayer.get(playerOtId) || null

  // Identifying fact (ref-mode binary or composite-PI): tuples are derived
  // from the entity's population. Also handles nested entity types as the
  // identified entity (objectified facts with explicit PI).
  const identifiedEntity = (() => {
    for (const ot of store.objectTypes) {
      if (ot.kind !== 'entity') continue
      const rm = findRefMode(ot, store.facts, store.objectTypes)
      if (rm && rm.factId === fact.id) {
        return { entity: ot, kind: 'refMode', vtRoleIndex: rm.vtRoleIndex, isNested: false }
      }
      const cp = findCompositePI(ot, store.facts, store.objectTypes, store.constraints)
      if (cp && cp.factId === fact.id) {
        return { entity: ot, kind: 'compositePI', cp, isNested: false }
      }
      if (cp && cp.factIds?.includes(fact.id)) {
        return { entity: ot, kind: 'compositePI', cp, isNested: false, factIndex: cp.factIds.indexOf(fact.id) }
      }
    }
    for (const nf of store.facts) {
      if (!nf.objectified || nf.objectifiedKind === 'value' || nf.id === fact.id) continue
      const rm = findRefMode(nf, store.facts, store.objectTypes)
      if (rm && rm.factId === fact.id) {
        return { entity: nf, kind: 'refMode', vtRoleIndex: rm.vtRoleIndex, isNested: true }
      }
      const cp = findCompositePI(nf, store.facts, store.objectTypes, store.constraints)
      if (cp && cp.factId === fact.id) {
        return { entity: nf, kind: 'compositePI', cp, isNested: true }
      }
      if (cp && cp.factIds?.includes(fact.id)) {
        return { entity: nf, kind: 'compositePI', cp, isNested: true, factIndex: cp.factIds.indexOf(fact.id) }
      }
    }
    return null
  })()
  if (identifiedEntity) {
    const { entity, kind, vtRoleIndex, cp, isNested, factIndex } = identifiedEntity
    // For nested entities the PI values live in nestedEntityMappings; for
    // regular entities they live in populations.
    const entityPop = isNested
      ? (store.nestedEntityMappings?.[entity.id] ?? [])
      : (store.populations?.[entity.id] ?? [])
    const entityName = entity.objectifiedName || entity.name || 'entity'
    const entityKind = isNested ? 'fact' : 'entity'
    const cellRO = {
      fontSize: 11, color: 'var(--ink-2)',
      background: 'var(--bg-surface)', border: '1px solid var(--border)',
      borderRadius: 3, padding: '2px 5px',
    }
    // Build derived display tuples — preserve array cell values for composite-PI
    // players so they render correctly via NestedCellEditor below.
    const displayTuples = kind === 'refMode'
      ? entityPop.map(v => Array.from({ length: arity }, () => (typeof v === 'string' ? v : '')))
      : factIndex != null
        ? entityPop.map(t => {
            const out = Array(arity).fill('')
            const idxInFact = cp.identifyingRoleIndices[factIndex]
            const cell = Array.isArray(t) ? t[factIndex] : ''
            out[idxInFact] = typeof cell === 'string' ? cell : Array.isArray(cell) ? cell : ''
            return out
          })
        : entityPop.map(t => {
            const out = Array(arity).fill('')
            if (Array.isArray(t)) {
              cp.identifyingRoleIndices.forEach((ri, ci) => {
                const cell = t[ci]
                out[ri] = typeof cell === 'string' ? cell
                  : Array.isArray(cell) ? cell
                  : ''
              })
            }
            return out
          })
    const entityRoleIndex = kind === 'refMode'
      ? (vtRoleIndex === 0 ? 1 : 0)
      : factIndex != null
        ? (cp.entityRoleIndices?.[factIndex] ?? cp.entityRoleIndex)
        : cp.entityRoleIndex
    return (
      <div>
        <Header>Population of <strong>{(fact.readingParts || []).filter(Boolean).join(' ').trim() || 'fact type'}</strong></Header>
        <div style={{ maxWidth: 640, fontSize: 11, color: 'var(--ink-muted)', marginBottom: 8 }}>
          Derived from the population of{' '}
          <button onClick={() => store.select(entity.id, entityKind)}
            style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer',
              color: 'var(--accent)', fontSize: 11 }}>
            {entityName}
          </button>.
        </div>
        {displayTuples.length === 0
          ? <EmptyState>No instances yet.</EmptyState>
          : (
            <div style={{ maxWidth: 640 }}>
              <div style={{ display: 'flex', gap: 4, marginBottom: 4 }}>
                {fact.roles.slice(0, arity).map((r, ri) => {
                  const shape = roleShapes[ri]
                  const label = r?.roleName || (r?.objectTypeId
                    ? (() => {
                        const p = findRolePlayer(r.objectTypeId, store.objectTypes, store.facts)
                        return p?.name || p?.objectifiedName
                      })()
                    : null) || `role ${ri + 1}`
                  if (shape.kind === 'single') {
                    return <div key={ri} style={{ ...colHeaderStyle, flex: 1, minWidth: 60 }}>{label}</div>
                  }
                  return (
                    <div key={ri} style={{ ...colHeaderStyle, flex: shape.columns.length, minWidth: 60 * shape.columns.length }}>
                      <div>{label}</div>
                      <div style={{ display: 'flex', gap: 4, fontWeight: 400, opacity: 0.7, marginTop: 2 }}>
                        {shape.columns.map((c, ci) => (
                          <div key={ci} style={{ flex: 1, minWidth: 60 }}>{c.label}</div>
                        ))}
                      </div>
                    </div>
                  )
                })}
              </div>
              {displayTuples.map((tuple, ti) => (
                <div key={ti} style={{ display: 'flex', gap: 4, marginBottom: 4, alignItems: 'center' }}>
                  {tuple.map((cell, ri) => (
                    ri === entityRoleIndex && kind === 'compositePI'
                      ? <NestedCellEditor key={ri}
                          shape={roleShapes[ri]}
                          value={entityPop[ti]}
                          getMeta={getMeta}
                          disabled={true}/>
                      : Array.isArray(cell)
                        ? <NestedCellEditor key={ri}
                            shape={roleShapes[ri]}
                            value={cell}
                            getMeta={getMeta}
                            disabled={true}/>
                        : <input key={ri} value={cell} readOnly disabled
                            style={{ flex: 1, ...cellRO }}/>
                  ))}
                </div>
              ))}
            </div>
          )}
      </div>
    )
  }

  const tuples = store.factPopulations?.[fact.id] ?? []
  // Index population issues for this fact by "tupleIndex:roleIndex" for O(1) lookup.
  // Per-cell issues use scalar tupleIndex/roleIndex; uniqueness violations carry
  // arrays — fan them out so every participating cell gets highlighted.
  const issuesByCell = new Map()
  const pushCell = (ti, ri, issue) => {
    const key = `${ti}:${ri}`
    if (!issuesByCell.has(key)) issuesByCell.set(key, [])
    issuesByCell.get(key).push(issue)
  }
  const constraintViolations = []
  for (const issue of (store.populationIssues || [])) {
    if (issue.factId !== fact.id) continue
    if (Array.isArray(issue.tupleIndices) && Array.isArray(issue.roleIndices)) {
      for (const ti of issue.tupleIndices) for (const ri of issue.roleIndices) pushCell(ti, ri, issue)
    } else if (issue.tupleIndex != null && issue.roleIndex != null) {
      pushCell(issue.tupleIndex, issue.roleIndex, issue)
    }
    if (issue.kind === 'uniquenessViolation' || issue.kind === 'frequencyViolation' || issue.kind === 'mandatoryRoleNotPlayed' || issue.kind === 'nonIndependentNotPlaying' || issue.kind === 'duplicateIdentifier') {
      constraintViolations.push(issue)
    }
  }
  const headerFor = (role, ri) => {
    if (role?.roleName) return role.roleName
    const player = role?.objectTypeId
      ? findRolePlayer(role.objectTypeId, store.objectTypes, store.facts)
      : null
    return player?.name || player?.objectifiedName || `role ${ri + 1}`
  }
  // Render header labels including nested sub-labels for tuple-shaped role
  // cells (one row of labels per depth).
  const renderHeader = (shape, label) => {
    if (shape.kind === 'single') {
      return <div style={{ ...colHeaderStyle, flex: 1, minWidth: 60 }}>{label}</div>
    }
    return (
      <div style={{ ...colHeaderStyle, flex: shape.columns.length, minWidth: 60 * shape.columns.length }}>
        <div>{label}</div>
        <div style={{ display: 'flex', gap: 4, fontWeight: 400, opacity: 0.7, marginTop: 2 }}>
          {shape.columns.map((c, ci) => renderHeader(c, c.label))}
        </div>
      </div>
    )
  }

  const name = (fact.readingParts || []).filter(Boolean).join(' ').trim() || 'fact type'
  return (
    <div>
      <Header>Population of <strong>{name}</strong> ({arity}-ary)</Header>
      {/* One datalist per distinct leaf player. */}
      {[...popMetaByPlayer.entries()].map(([pid, m]) => m.listId && (
        <datalist key={pid} id={m.listId}>
          {m.values.map((v, j) => <option key={j} value={v}/>)}
        </datalist>
      ))}
      <div style={{ display: 'flex', gap: 4, marginBottom: 4 }}>
        {fact.roles.slice(0, arity).map((r, ri) => (
          <React.Fragment key={ri}>{renderHeader(roleShapes[ri], headerFor(r, ri))}</React.Fragment>
        ))}
        <div style={{ width: 22 }}/>
      </div>
      {tuples.map((tuple, ti) => (
        <div key={ti} style={{ display: 'flex', gap: 4, marginBottom: 4, alignItems: 'center' }}>
          {fact.roles.slice(0, arity).map((_, ri) => {
            const shape = roleShapes[ri]
            const cellIssues = issuesByCell.get(`${ti}:${ri}`)
            const cellIssue = cellIssues ? { message: cellIssues.map(i => i.message).join('\n') } : null
            const cellValue = Array.isArray(tuple) ? tuple[ri] : undefined
            const playerPop = rolePlayerPops[ri]
            const outerScope = playerPop ? { pop: playerPop, value: cellValue } : null
            return (
              <NestedCellEditor key={ri}
                shape={shape}
                value={cellValue}
                onChange={newCell => store.updateFactTupleCell(fact.id, ti, ri, newCell)}
                onCommit={() => store.commitFactTupleCell(fact.id, ti, ri)}
                getMeta={getMeta}
                cellIssue={cellIssue}
                outerScope={outerScope}/>
            )
          })}
          <button onClick={() => store.removeFactTuple(fact.id, ti)}
            {...removeBtnHandlers}
            style={removeBtnStyle} title="Remove tuple" aria-label="Remove tuple">×</button>
        </div>
      ))}
      <button onClick={() => store.addFactTuple(fact.id)}
        style={addBtnStyle}>+ Add tuple</button>
      {/* Per-role propagate buttons: push tuple-cell values into each role
          player's population. */}
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 8 }}>
        {fact.roles.slice(0, arity).map((role, ri) => {
          const player = role?.objectTypeId
            ? findRolePlayer(role.objectTypeId, store.objectTypes, store.facts)
            : null
          if (!player) return null
          const values = []
          for (const t of tuples) {
            if (!Array.isArray(t)) continue
            const c = t[ri]
            if (isCompleteValue(c)) values.push(c)
          }
          // For nested entity types with explicit PI (ref-mode, composite-PI,
          // or inherited PI), the "identity" of an instance is the PI value
          // stored in nestedEntityMappings — not the ref-mode VT's population
          // or the fact tuple population.  We compare cell values against that
          // mapping and, when propagating, add a new row (PI + empty fact
          // tuple) rather than touching populations directly.
          const hasExplicitPI = player.objectified && (() => {
            const rm = findRefMode(player, store.facts, store.objectTypes)
            if (rm) return true
            const cp = findCompositePI(player, store.facts, store.objectTypes, store.constraints)
            if (cp) return true
            const inh = findInheritedPI(player, store.facts, store.objectTypes, store.subtypes, store.constraints)
            return !!inh
          })()
          const sourcePop = player.objectified
            ? (hasExplicitPI
                ? store.nestedEntityMappings?.[player.id] ?? []
                : store.factPopulations?.[player.id] ?? [])
            : store.populations?.[player.id]
          const missing = missingValues(values, sourcePop)
          const propTargetId = (player.objectified && hasExplicitPI) ? null : player.id
          const propagateAction = (player.objectified && hasExplicitPI)
            ? () => store.propagateToNestedEntity(player.id, missing)
            : null
          const playerLabel = player.name || player.objectifiedName || 'player'
          return (
            <PropagateButton key={ri}
              label={`Propagate ${headerFor(role, ri)} to ${playerLabel}`}
              missing={missing}
              targetId={propTargetId}
              onPropagate={propagateAction}/>
          )
        })}
      </div>
      {constraintViolations.length > 0 && (
        <div style={{ marginTop: 12 }}>
          <div style={{ fontSize: 11, color: '#b91c1c', marginBottom: 4 }}>Constraint violations ({constraintViolations.length}):</div>
          {constraintViolations.map((issue, i) => (
            <div key={i} style={{ fontSize: 11, color: '#b91c1c', marginBottom: 2, lineHeight: 1.3 }}>
              • {issue.message}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// Width of the native datalist dropdown arrow in Chromium (used to detect
// arrow clicks and force the dropdown open by clearing the input first).
const DATALIST_ARROW_W = 18

// Generic single-input leaf used by NestedCellEditor. Handles datalist
// autocomplete (including the "clear on arrow click" trick) and type-specific
// input attributes.
//
// If `values` (an explicit candidate list) is provided, an inline datalist is
// rendered with these values — used for context-aware narrowing where the
// candidate set depends on sibling cell values. Otherwise `listId` references
// a shared external datalist (the legacy per-player population list).
function LeafCellInput({ value, onChange, onCommit, listId, values, typeKind, title, className, style, disabled }) {
  const restoreRef = useRef(null)
  const generatedId = useId()
  const isBoolean = typeKind === 'boolean'

  if (isBoolean) {
    return (
      <select value={value ?? ''}
        className={className}
        onChange={e => onChange(e.target.value)}
        onBlur={onCommit}
        disabled={disabled}
        title={title}
        style={{ ...style, fontSize: 11, padding: '2px 4px' }}>
        <option value=""></option>
        <option value="true">true</option>
        <option value="false">false</option>
      </select>
    )
  }

  const typeProps =
    typeKind === 'integer'  ? { type: 'number', step: 1 }
    : typeKind === 'decimal'  ? { type: 'number', step: 'any' }
    : typeKind === 'date'     ? { type: 'date' }
    : typeKind === 'datetime' ? { type: 'datetime-local' }
    : {}

  const inlineListId = values !== undefined ? `pop-leaf-${generatedId}` : null
  const effectiveListId = inlineListId ?? listId
  const hasList = !!effectiveListId

  const onMouseDown = (e) => {
    if (!hasList || disabled) return
    const input = e.currentTarget
    const rect = input.getBoundingClientRect()
    const distFromRight = rect.right - e.clientX
    if (distFromRight < DATALIST_ARROW_W && input.value !== '') {
      restoreRef.current = input.value
      input.value = ''
      onChange('')
    }
  }
  const handleChange = (e) => {
    restoreRef.current = null
    onChange(e.target.value)
  }
  const handleBlur = () => {
    if (restoreRef.current != null) {
      onChange(restoreRef.current)
      restoreRef.current = null
    }
    if (onCommit) onCommit()
  }
  const onKeyDown = (e) => { if (e.key === 'Enter') e.currentTarget.blur() }

  return (
    <>
      {inlineListId && (
        <datalist id={inlineListId}>
          {values.map((v, i) => <option key={i} value={v}/>)}
        </datalist>
      )}
      <input value={value ?? ''}
        list={effectiveListId || undefined}
        className={className}
        onMouseDown={onMouseDown}
        onChange={handleChange}
        onBlur={handleBlur}
        onKeyDown={onKeyDown}
        disabled={disabled}
        title={title}
        style={style}
        {...typeProps}/>
    </>
  )
}

// Recursive cell editor for a value whose shape is described by `shape`
// (see getNestedCellShape in utils/refMode). Single-shape nodes render a
// LeafCellInput; tuple-shape nodes render N sub-editors inline.
//
//   onChange(newCellValue) is called whenever any leaf in the cell changes —
//   the new value is rebuilt at the top of the tree, so the caller receives
//   the *whole* cell.
//   onCommit() is called when any leaf blurs (used for propagation hooks).
//   getMeta(playerOtId) returns { listId, typeKind } for autocomplete + input
//   type for that leaf.
//   cellIssue (optional) is an issue object applied to every leaf — used to
//   highlight the entire cell when any sub-cell has an issue.
function NestedCellEditor({
  shape, value, onChange, onCommit, getMeta, cellIssue, disabled,
  outerScope = null,  // { pop, value } — narrowing scope this cell sits inside
  popFor = null,      // (playerOtId) => pop[] | null — establishes sub-scopes
                      //   when there's no outer scope and the sub-cell is a
                      //   composite-PI entity reference
  leafPath = [],      // path from scope root to this node (or this subtree's root)
  leafStyle = { flex: 1, minWidth: 60 },
}) {
  if (shape.kind === 'single') {
    const meta = getMeta?.(shape.playerOtId) || {}
    const candidateValues = outerScope
      ? candidatesAt(outerScope.pop, outerScope.value, leafPath)
      : undefined
    const hasIssue = !!cellIssue
    const issueStyle = hasIssue
      ? { borderColor: '#f5b400', boxShadow: 'inset 0 0 0 1px #f5b400', background: '#fff8e0' }
      : null
    return (
      <LeafCellInput
        value={typeof value === 'string' ? value : ''}
        onChange={onChange}
        onCommit={onCommit}
        listId={candidateValues === undefined ? meta.listId : undefined}
        values={candidateValues}
        typeKind={meta.typeKind}
        title={cellIssue?.message}
        className={hasIssue ? 'cell-issue' : undefined}
        disabled={disabled}
        style={{ ...leafStyle, ...(issueStyle || {}) }}/>
    )
  }
  const arr = Array.isArray(value) ? value
    : shape.kind === 'tuple' ? Array(shape.columns.length).fill(UNSET)
    : []
  return (
    <div style={{ display: 'flex', gap: 4, flex: shape.columns.length, minWidth: 60 * shape.columns.length }}>
      {shape.columns.map((col, ci) => {
        // Within an existing outer scope, extend the leaf path with this index.
        // Otherwise — if this sub-cell is a composite-PI entity reference and
        // popFor can provide a pop — establish a fresh scope here.
        let nextScope = outerScope
        let nextLeafPath = leafPath
        if (outerScope) {
          nextLeafPath = [...leafPath, ci]
        } else if (col.kind === 'tuple' && popFor) {
          const subPop = popFor(col.playerOtId)
          if (Array.isArray(subPop) && subPop.length) {
            nextScope = { pop: subPop, value: arr[ci] }
            nextLeafPath = []
          }
        }
        return (
          <NestedCellEditor key={ci}
            shape={col}
            value={arr[ci]}
            onChange={subVal => {
              const next = arr.slice()
              while (next.length <= ci) next.push(UNSET)
              next[ci] = subVal
              onChange(next)
            }}
            onCommit={onCommit}
            getMeta={getMeta}
            cellIssue={cellIssue}
            disabled={disabled}
            outerScope={nextScope}
            popFor={popFor}
            leafPath={nextLeafPath}
            leafStyle={leafStyle}/>
        )
      })}
    </div>
  )
}

// ── Verbalisation tab (placeholder) ────────────────────────────────────────
function VerbalisationTab() {
  return <EmptyState>Verbalisations will appear here.</EmptyState>
}
