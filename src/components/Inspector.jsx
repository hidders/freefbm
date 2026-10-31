import React, { useState, useRef, useCallback, useLayoutEffect, useEffect } from 'react'
import { useOrmStore, useOrmStoreIgnoring } from '../store/ormStore'
import { findRefMode, refModeLabel, findCompositePI, canBeExternalUniquenessPI } from '../utils/refMode'
import { getDisplayReading, makeImplicitLinkFact } from './FactTypeNode'
import { RingMiniSymbol } from './ConstraintNodes'
import Splitter from './Splitter'
import { NoteConnectorIcon } from './ToolPanel'
import { formatValueRange, formatCardinalityRange, formatFrequencyRange } from './ObjectTypeNode'
import { constraintMaxSequences, suppressRolePosition } from '../utils/constraintRules.js'
import { PROFILES, PROFILE_MAP, getDatatypeById } from '../data/datatypeProfiles'
import { datatypeAssignmentToKind } from '../utils/datatypeMapping.js'
import { VALIDATION_CATEGORIES } from '../utils/validation.js'
import { DERIVATION_MODES, directSupertypes, isDerived, checkRule } from '../logic/derivationRule.js'
import { isDerivedFact, isComputedRole, checkFactRule, whyNotDerivable } from '../logic/factDerivation.js'
import { makeContext } from '../logic/constraintFormulas.js'
import { isFormulaQuery, whyNotGraphical, whyNoOuterJoin } from '../logic/query.js'
import { hasTextSelection } from '../utils/textPanel.js'
import { isFallbackReading } from '../store/viewLanguage.js'
import { readingList, occurrences, preferredReadings } from '../store/readings.js'

const hasReadingText = (parts) => Array.isArray(parts) && parts.some(p => p?.trim())
import { isDeonticUniqueness } from '../logic/modality.js'
import { COLOR_CHANNELS, describeMember } from '../utils/groups.js'
import { PROPERTY_TYPES, PROPERTY_KINDS, definitionsFor, validPropertyValue, withProperty } from '../utils/customProperties.js'
import { plural as englishPlural } from '../verbalisation/languages/english.js'
import { pluralise as dutchPlural } from '../verbalisation/languages/dutch.js'
import { pluralise as frenchPlural } from '../verbalisation/languages/french.js'
import { pluralise as italianPlural } from '../verbalisation/languages/italian.js'
import { pluralise as spanishPlural } from '../verbalisation/languages/spanish.js'
import { pluralise as polishPlural } from '../verbalisation/languages/polish.js'

// ── Validation error components ───────────────────────────────────────────────

const SEV_COLOUR = { error: '#dc2626', warning: '#d97706' }
const SEV_ICON   = { error: '✕', warning: '!' }

function ValidationErrorList({ errors, store }) {
  if (!errors || errors.length === 0) return (
    <div style={{ fontSize: 11, color: 'var(--ink-muted)', padding: '6px 0', textAlign: 'center' }}>
      No validation errors
    </div>
  )

  // Group by category
  const byCategory = {}
  for (const e of errors) {
    if (!byCategory[e.category]) byCategory[e.category] = []
    byCategory[e.category].push(e)
  }

  const selectElement = (e) => { if (!hasTextSelection()) store.navigateToElement(e.elementId, e.elementKind) }

  return (
    <div data-text-panel tabIndex={0} className="copyable" style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 12 }}>
      {Object.entries(byCategory).map(([cat, errs]) => (
        <div key={cat}>
          <div style={{ fontSize: 10, color: 'var(--ink-muted)', letterSpacing: '0.06em',
            textTransform: 'uppercase', marginBottom: 4 }}>
            {VALIDATION_CATEGORIES[cat]?.label ?? cat}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
            {errs.map(e => (
              <div key={e.id}
                onClick={() => selectElement(e)}
                style={{
                  display: 'flex', alignItems: 'flex-start', gap: 6,
                  padding: '5px 7px', borderRadius: 4,
                  background: 'var(--bg-raised)', border: `1px solid var(--border-soft)`,
                  cursor: 'pointer', borderLeft: `3px solid ${SEV_COLOUR[e.severity]}`,
                }}
                onMouseEnter={ev => ev.currentTarget.style.background = 'var(--bg-hover)'}
                onMouseLeave={ev => ev.currentTarget.style.background = 'var(--bg-raised)'}
              >
                <span style={{ color: SEV_COLOUR[e.severity], fontWeight: 700,
                  fontSize: 10, marginTop: 1, flexShrink: 0 }}>
                  {SEV_ICON[e.severity]}
                </span>
                <span style={{ fontSize: 11, color: 'var(--ink-2)', lineHeight: 1.4 }}>
                  {e.message}
                </span>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}

export function ValidationErrorStrip({ elementId, store }) {
  const errors = (store.validationErrors || []).filter(e => e.elementId === elementId)
  if (errors.length === 0) return null
  return (
    <div data-text-panel tabIndex={0} className="copyable" style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 12 }}>
      {errors.map(e => (
        <div key={e.id} style={{
          display: 'flex', alignItems: 'flex-start', gap: 6,
          padding: '5px 8px', borderRadius: 4,
          background: e.severity === 'error' ? '#fef2f2' : '#fffbeb',
          border: `1px solid ${SEV_COLOUR[e.severity]}22`,
          borderLeft: `3px solid ${SEV_COLOUR[e.severity]}`,
        }}>
          <span style={{ color: SEV_COLOUR[e.severity], fontWeight: 700, fontSize: 10, marginTop: 1, flexShrink: 0 }}>
            {SEV_ICON[e.severity]}
          </span>
          <span style={{ fontSize: 11, color: 'var(--ink-2)', lineHeight: 1.4 }}>{e.message}</span>
        </div>
      ))}
    </div>
  )
}

const RING_TYPES = [
  { key: 'irreflexive',           label: 'Irreflexive' },
  { key: 'reflexive',             label: 'Reflexive (locally)' },
  { key: 'purely-reflexive',      label: 'Purely Reflexive' },
  { key: 'asymmetric',            label: 'Asymmetric' },
  { key: 'symmetric',             label: 'Symmetric' },
  { key: 'antisymmetric',         label: 'Antisymmetric' },
  { key: 'transitive',            label: 'Transitive' },
  { key: 'intransitive',          label: 'Intransitive' },
  { key: 'strongly-intransitive', label: 'Strongly Intransitive' },
  { key: 'acyclic',               label: 'Acyclic' },
]

// ── Ring property implication rules ──────────────────────────────────────────
// Each rule: if all antecedent properties are active, the consequent is implied.
// consequent: a property key, or 'EMPTY' meaning the relation must be empty.
const RING_RULES = [
  { antecedent: ['purely-reflexive'],             consequent: 'reflexive'   },
  { antecedent: ['purely-reflexive'],             consequent: 'symmetric'     },
  { antecedent: ['purely-reflexive'],             consequent: 'antisymmetric' },
  { antecedent: ['purely-reflexive'],             consequent: 'transitive'    },
  { antecedent: ['asymmetric'],                   consequent: 'irreflexive'   },
  { antecedent: ['asymmetric'],                   consequent: 'antisymmetric' },
  { antecedent: ['intransitive'],                 consequent: 'irreflexive' },
  { antecedent: ['strongly-intransitive'],        consequent: 'irreflexive' },
  { antecedent: ['strongly-intransitive'],        consequent: 'asymmetric'   },
  { antecedent: ['strongly-intransitive'],        consequent: 'intransitive' },
  { antecedent: ['acyclic'],                      consequent: 'irreflexive' },
  { antecedent: ['acyclic'],                      consequent: 'asymmetric'  },
  { antecedent: ['irreflexive', 'antisymmetric'], consequent: 'asymmetric'     },
  { antecedent: ['asymmetric',  'transitive'],    consequent: 'acyclic'        },
  { antecedent: ['symmetric',   'antisymmetric'], consequent: 'purely-reflexive' },
  { antecedent: ['symmetric',   'transitive'],    consequent: 'reflexive'        },
  { antecedent: ['irreflexive', 'transitive'],    consequent: 'asymmetric'          },
  { antecedent: ['transitive',  'intransitive'],  consequent: 'strongly-intransitive' },
  { antecedent: ['reflexive',   'irreflexive'],   consequent: 'EMPTY'      },
  { antecedent: ['reflexive',   'asymmetric'],    consequent: 'EMPTY'      },
  { antecedent: ['reflexive',   'intransitive'],         consequent: 'EMPTY' },
  { antecedent: ['reflexive',   'strongly-intransitive'], consequent: 'EMPTY' },
  { antecedent: ['reflexive',   'acyclic'],               consequent: 'EMPTY' },
  { antecedent: ['purely-reflexive', 'asymmetric'],      consequent: 'EMPTY' },
  { antecedent: ['purely-reflexive', 'intransitive'],          consequent: 'EMPTY' },
  { antecedent: ['purely-reflexive', 'strongly-intransitive'], consequent: 'EMPTY' },
  { antecedent: ['symmetric', 'asymmetric'],                   consequent: 'EMPTY' },
  { antecedent: ['symmetric', 'strongly-intransitive'],        consequent: 'EMPTY' },
  { antecedent: ['symmetric', 'acyclic'],                      consequent: 'EMPTY' },
]

// Removes any property from explicit that is implied by the remaining properties.
// Iterates until stable (handles chains).
function minimizeExplicit(explicit) {
  let minimal = [...explicit]
  let changed = true
  while (changed) {
    changed = false
    for (const p of minimal) {
      const without = minimal.filter(q => q !== p)
      if (computeRingImplied(without).active.has(p)) {
        minimal = without
        changed = true
        break
      }
    }
  }
  return minimal
}

// Returns { active: Set, implied: Set, isEmpty: bool }
// 'active' = explicit ∪ all implied properties (fixed-point closure).
// 'implied' = active \ explicit.
function computeRingImplied(explicit) {
  const explicitSet = new Set(explicit)
  const active = new Set(explicit)
  let changed = true
  while (changed) {
    changed = false
    for (const { antecedent, consequent } of RING_RULES) {
      if (consequent === 'EMPTY') continue
      if (!active.has(consequent) && antecedent.every(p => active.has(p))) {
        active.add(consequent)
        changed = true
      }
    }
  }
  const implied  = new Set([...active].filter(p => !explicitSet.has(p)))
  const isEmpty  = RING_RULES.some(({ antecedent, consequent }) =>
    consequent === 'EMPTY' && antecedent.every(p => active.has(p)))
  return { active, implied, isEmpty }
}

function Label({ children }) {
  return <label style={{ fontSize: 10, color: 'var(--ink-muted)', letterSpacing: '0.08em',
    textTransform: 'uppercase', marginBottom: 3, display: 'block' }}>{children}</label>
}
function InspectorTitle({ children }) {
  return (
    <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--ink)',
      borderBottom: '1px solid var(--border)', paddingBottom: 6, marginBottom: 12 }}>
      {children}
    </div>
  )
}
function Section({ title, children }) {
  return (
    <div style={{ marginBottom: 14 }}>
      {title && (
        <div style={{ fontSize: 10, color: 'var(--accent)', fontWeight: 700,
          letterSpacing: '0.08em', textTransform: 'uppercase',
          borderBottom: '1px solid var(--border-soft)', paddingBottom: 4, marginBottom: 8 }}>
          {title}
        </div>
      )}
      {children}
    </div>
  )
}
function Row({ children }) { return <div style={{ marginBottom: 8 }}>{children}</div> }

function RefModeExpandCollapseButtons({ factId, occurrenceId, store }) {
  const activeDiagram = store.diagrams?.find(d => d.id === store.activeDiagramId)
  const isExpandedHere = occurrenceId
    ? (activeDiagram?.expandedRefModeOccs ?? []).includes(occurrenceId)
    : (activeDiagram?.expandedRefModes ?? []).includes(factId)
  const refMode = findRefMode({ id: factId }, store.facts, store.objectTypes)
  if (!refMode) return null
  const refVt = store.objectTypes.find(o => o.id === refMode.vtId)
  return (
    <div style={{ display: 'flex', gap: 5, padding: '0 8px 8px', flexWrap: 'wrap' }}>
      <button
        onClick={() => store.select(refMode.factId, 'fact')}
        style={{ fontSize: 10, padding: '1px 6px',
          background: 'var(--bg-raised)', border: '1px solid var(--border-soft)',
          borderRadius: 3, cursor: 'pointer', color: 'var(--ink-2)' }}>
        Fact Type
      </button>
      {refVt && (
        <button
          onClick={() => store.select(refVt.id, 'value')}
          style={{ fontSize: 10, padding: '1px 6px',
            background: 'var(--bg-raised)', border: '1px solid var(--border-soft)',
            borderRadius: 3, cursor: 'pointer', color: 'var(--ink-2)' }}>
          Value Type
        </button>
      )}
      {occurrenceId && (
        <button
          onClick={() => isExpandedHere ? store.collapseRefMode(occurrenceId) : store.expandRefMode(occurrenceId)}
          style={{ fontSize: 10, padding: '1px 6px',
            background: 'var(--bg-raised)', border: '1px solid var(--border-soft)',
            borderRadius: 3, cursor: 'pointer', color: 'var(--ink-2)' }}>
          {isExpandedHere ? 'Collapse in this diagram' : 'Expand in this diagram'}
        </button>
      )}
    </div>
  )
}

// ── Diagrams-containing list ─────────────────────────────────────────────────
// Shows which diagrams contain the given element, in tab order.
// subtypeEndpointIds: [subId, superId] — for subtypes both endpoints must be in the diagram.
function DiagramList({ elementId, kind, subtypeEndpointIds, factId, roleIndex }) {
  const store = useOrmStoreIgnoring('pan', 'zoom')
  const { diagrams } = store
  const [occPicker, setOccPicker] = useState(null)
  const isImplicitLink = kind === 'implicitLink' && factId != null && roleIndex != null
  const needsOccurrencePick = !isImplicitLink && !subtypeEndpointIds && kind !== 'constraint'
  const containing = diagrams.filter(d => {
    if (isImplicitLink) {
      return (d.shownImplicitLinks || []).includes(`${factId}:${roleIndex}`)
    }
    if (subtypeEndpointIds) {
      const [a, b] = subtypeEndpointIds
      return d.occurrences?.some(o => o.schemaElementId === a) &&
             d.occurrences?.some(o => o.schemaElementId === b)
    }
    if (kind === 'constraint') {
      return d.constraintOccurrences?.some(co => co.schemaConstraintId === elementId) ?? false
    }
    return d.occurrences?.some(o => o.schemaElementId === elementId) ?? false
  })

  useEffect(() => {
    if (!occPicker) return
    const handler = () => setOccPicker(null)
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [occPicker])

  const handleClick = (d, e) => {
    store.setActiveDiagram(d.id)
    if (isImplicitLink) {
      store.selectImplicitLink(factId, roleIndex)
      return
    }
    if (!needsOccurrencePick) {
      store.select(elementId, kind)
      setTimeout(() => store.centerOnElement(elementId), 0)
      return
    }
    const occs = (d.occurrences ?? [])
      .filter(o => o.schemaElementId === elementId)
      .sort((a, b) => a.y !== b.y ? a.y - b.y : a.x - b.x)
    if (occs.length <= 1) {
      const occId = occs[0]?.id ?? null
      store.select(elementId, kind, occId)
      if (occId) setTimeout(() => store.centerOnOccurrence(occId), 0)
    } else {
      const rect = e.currentTarget.getBoundingClientRect()
      setOccPicker({ x: rect.right + 6, y: rect.top, occs })
    }
  }

  return (
    <>
      <Row>
        <Label>Appears in</Label>
        {containing.length === 0 ? (
          <span style={{ fontSize: 11, color: 'var(--danger)', fontStyle: 'italic' }}>
            not in any diagram (orphaned)
          </span>
        ) : (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
            {containing.map(d => (
              <span key={d.id} onClick={(e) => handleClick(d, e)}
                style={{
                  fontSize: 10, padding: '1px 6px',
                  background: 'var(--bg-raised)', border: '1px solid var(--border-soft)',
                  borderRadius: 3, color: 'var(--ink-2)', cursor: 'pointer',
                }}
                onMouseEnter={e => {
                  e.currentTarget.style.background = 'var(--accent)'
                  e.currentTarget.style.color = 'white'
                  e.currentTarget.style.borderColor = 'var(--accent)'
                }}
                onMouseLeave={e => {
                  e.currentTarget.style.background = 'var(--bg-raised)'
                  e.currentTarget.style.color = 'var(--ink-2)'
                  e.currentTarget.style.borderColor = 'var(--border-soft)'
                }}
              >{d.name}</span>
            ))}
          </div>
        )}
      </Row>
      {occPicker && (
        <div
          onMouseDown={e => e.stopPropagation()}
          style={{
            position: 'fixed',
            left: occPicker.x,
            top: occPicker.y,
            background: 'var(--bg-panel)',
            border: '1px solid var(--border)',
            borderRadius: 6,
            boxShadow: '0 2px 10px rgba(0,0,0,0.18)',
            padding: '6px 8px',
            zIndex: 9999,
          }}
        >
          <div style={{ fontSize: 11, color: 'var(--ink-muted)', marginBottom: 5 }}>
            Select occurrence:
          </div>
          <div style={{ display: 'flex', gap: 5 }}>
            {occPicker.occs.map((occ, i) => (
              <button
                key={occ.id}
                onClick={() => {
                  store.select(elementId, kind, occ.id)
                  store.centerOnOccurrence(occ.id)
                  setOccPicker(null)
                }}
                style={{
                  width: 28, height: 28,
                  border: '1px solid var(--border)',
                  borderRadius: 4,
                  background: 'var(--bg-raised)',
                  cursor: 'pointer',
                  fontSize: 13,
                  fontWeight: 600,
                  color: 'var(--ink)',
                }}
              >{i + 1}</button>
            ))}
          </div>
        </div>
      )}
    </>
  )
}

// ── Definition and note ──────────────────────────────────────────────────────
// Free text on a schema element, as NORMA's Definition and Note properties:
// the definition says what the element means, the note anything else.
function DocumentationSection({ el, onChange }) {
  const area = (field, placeholder) => (
    <textarea value={el[field] ?? ''} rows={field === 'definition' ? 3 : 2} placeholder={placeholder}
      onChange={e => onChange({ [field]: e.target.value })}
      style={{
        width: '100%', resize: 'vertical', boxSizing: 'border-box',
        fontSize: 12, fontFamily: 'inherit', lineHeight: 1.5,
        border: '1px solid var(--border)', borderRadius: 3,
        padding: '5px 7px', background: 'var(--bg-raised)',
        color: 'var(--ink-2)', outline: 'none',
      }}/>
  )
  return (
    <Section title="Documentation">
      <Row>
        <Label>Definition</Label>
        {area('definition', 'What this means in the domain…')}
      </Row>
      <Row>
        <Label>Note</Label>
        {area('note', 'Anything else worth recording…')}
      </Row>
    </Section>
  )
}

// ── Custom properties ────────────────────────────────────────────────────────
// The values of the model's property definitions (utils/customProperties.js)
// that apply to this kind of element, grouped by category.
function PropertyInput({ def, value, onChange }) {
  const invalid = !validPropertyValue(def, value ?? '')
  const style = { width: '100%', fontSize: 12, boxSizing: 'border-box',
    ...(invalid && { borderColor: 'var(--danger)' }) }
  const title = invalid ? `Not a valid ${PROPERTY_TYPES.find(t => t.id === def.type)?.label.toLowerCase()} value` : def.description || undefined
  const dflt = def.default ? `${def.type === 'boolean' ? (def.default === 'true' ? 'Yes' : 'No') : def.default} (default)` : ''
  if (def.type === 'boolean' || def.type === 'enum') {
    const opts = def.type === 'boolean' ? [['true', 'Yes'], ['false', 'No']] : (def.options ?? []).map(o => [o, o])
    return (
      <select value={value ?? ''} onChange={e => onChange(e.target.value)} style={style} title={title}>
        <option value="">{dflt || '—'}</option>
        {opts.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        {invalid && <option value={value}>{value}</option>}
      </select>
    )
  }
  return (
    <input type={def.type === 'date' ? 'date' : def.type === 'number' ? 'number' : 'text'}
      value={value ?? ''} placeholder={dflt} title={title} style={style}
      onChange={e => onChange(e.target.value)}
      onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur() }}/>
  )
}

function PropertiesSection({ el, kind, onChange }) {
  const store = useOrmStoreIgnoring('pan', 'zoom')
  const defs = definitionsFor(store.propertyDefinitions, kind)
  if (!defs.length) return null
  const categories = [...new Set(defs.map(d => d.category ?? ''))]
  return (
    <Section title="Custom properties">
      {categories.map(cat => (
        <div key={cat}>
          {cat && <div style={{ fontSize: 11, color: 'var(--ink-3)', fontWeight: 600, margin: '4px 0 6px' }}>{cat}</div>}
          {defs.filter(d => (d.category ?? '') === cat).map(d => (
            <Row key={d.id}>
              <Label>{d.name || '(unnamed)'}</Label>
              <PropertyInput def={d} value={el.properties?.[d.id]}
                onChange={v => onChange({ properties: withProperty(el.properties, d.id, v) })}/>
            </Row>
          ))}
        </div>
      ))}
    </Section>
  )
}

// Schema Settings: the model's property definitions.
function PropertyDefinitionsEditor() {
  const store = useOrmStoreIgnoring('pan', 'zoom')
  const [open, setOpen] = useState(null)
  const defs = store.propertyDefinitions
  const usage = id => {
    let n = 0
    const count = el => { if (el.properties?.[id] != null) n++ }
    store.objectTypes.forEach(count); store.subtypes.forEach(count); store.constraints.forEach(count); store.groups.forEach(count)
    store.facts.forEach(f => { count(f); f.roles.forEach(count) })
    store.diagrams.forEach(d => (d.notes ?? []).forEach(count))
    return n
  }
  return (
    <div style={{ marginBottom: 16 }}>
      <div style={{ fontSize: 10, color: 'var(--accent)', fontWeight: 700,
        letterSpacing: '0.1em', textTransform: 'uppercase',
        borderBottom: '1px solid var(--border-soft)', paddingBottom: 5, marginBottom: 10 }}>
        Custom Properties
      </div>
      {defs.length === 0 && (
        <div style={{ fontSize: 11, color: 'var(--ink-muted)', marginBottom: 8, lineHeight: 1.4 }}>
          Declare properties, such as an acronym or a source reference, that elements can then fill in.
        </div>
      )}
      {defs.map(d => {
        const isOpen = open === d.id
        const upd = patch => store.updatePropertyDefinition(d.id, patch)
        return (
          <div key={d.id} style={{ border: '1px solid var(--border-soft)', borderRadius: 4, marginBottom: 6,
            background: 'var(--bg-raised)' }}>
            <div onClick={() => setOpen(isOpen ? null : d.id)} title={PROPERTY_TYPES.find(t => t.id === d.type)?.label}
              style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '5px 8px', cursor: 'pointer', fontSize: 12 }}>
              <span style={{ color: 'var(--ink-muted)', fontSize: 9 }}>{isOpen ? '▼' : '▶'}</span>
              <span style={{ flex: 1, minWidth: 0, color: 'var(--ink-2)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {d.category && <span style={{ color: 'var(--ink-muted)' }}>{d.category} · </span>}{d.name || '(unnamed)'}
              </span>
            </div>
            {isOpen && (
              <div style={{ padding: '4px 8px 8px' }}>
                <Row><Label>Name</Label><TInput value={d.name} onChange={v => upd({ name: v })}/></Row>
                <Row><Label>Category</Label><TInput value={d.category} onChange={v => upd({ category: v })} placeholder="e.g. Glossary"/></Row>
                <Row><Label>Description</Label><TInput value={d.description} onChange={v => upd({ description: v })}/></Row>
                <Row>
                  <Label>Type</Label>
                  <select value={d.type} onChange={e => upd({ type: e.target.value, default: '' })} style={{ width: '100%', fontSize: 12 }}>
                    {PROPERTY_TYPES.map(t => <option key={t.id} value={t.id}>{t.label}</option>)}
                  </select>
                </Row>
                {d.type === 'enum' && (
                  <Row>
                    <Label>Choices (one per line)</Label>
                    <textarea rows={3} value={(d.options ?? []).join('\n')}
                      onChange={e => upd({ options: e.target.value.split('\n') })}
                      onBlur={e => upd({ options: [...new Set(e.target.value.split('\n').map(x => x.trim()).filter(Boolean))] })}
                      style={{ width: '100%', boxSizing: 'border-box', fontSize: 12, fontFamily: 'inherit' }}/>
                  </Row>
                )}
                <Row>
                  <Label>Default</Label>
                  <PropertyInput def={{ ...d, default: '' }} value={d.default} onChange={v => upd({ default: v })}/>
                </Row>
                <Row>
                  <Label>Applies to</Label>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '2px 8px' }}>
                    {PROPERTY_KINDS.map(k => (
                      <Checkbox key={k.id} label={k.label} checked={d.appliesTo.includes(k.id)}
                        onChange={v => upd({ appliesTo: v ? [...d.appliesTo, k.id] : d.appliesTo.filter(x => x !== k.id) })}/>
                    ))}
                  </div>
                </Row>
                <DangerBtn onClick={() => {
                  const n = usage(d.id)
                  if (n && !window.confirm(`Delete “${d.name}” and its values on ${n} element${n === 1 ? '' : 's'}?`)) return
                  store.deletePropertyDefinition(d.id)
                }}>Delete Property</DangerBtn>
              </div>
            )}
          </div>
        )
      })}
      <button onClick={() => setOpen(store.addPropertyDefinition())} style={{ fontSize: 11, padding: '3px 8px' }}>
        + Add property
      </button>
    </div>
  )
}

// ── Element groups ───────────────────────────────────────────────────────────
// The groups an element is in (utils/groups.js), with a picker to add it to
// another group or a new one.
function GroupSwatch({ group, size = 10 }) {
  const c = group.colors ?? {}
  return (
    <span style={{ display: 'inline-block', width: size, height: size, flexShrink: 0, borderRadius: 2,
      background: c.fill ?? 'transparent',
      border: `2px solid ${c.outline ?? c.text ?? 'var(--border)'}` }}/>
  )
}

function GroupPicker({ memberIds, exclude = [], label = 'Add to group…' }) {
  const store = useOrmStoreIgnoring('pan', 'zoom')
  const options = store.groups.filter(g => !exclude.includes(g.id))
  return (
    <select value="" style={{ fontSize: 11, width: '100%' }}
      onChange={e => {
        const v = e.target.value
        if (v === '__new') store.addGroup(memberIds)
        else if (v) store.addToGroup(v, memberIds)
      }}>
      <option value="">{label}</option>
      {options.map(g => <option key={g.id} value={g.id}>{g.name || '(unnamed group)'}</option>)}
      <option value="__new">New group…</option>
    </select>
  )
}

function GroupMembershipSection({ id }) {
  const store = useOrmStoreIgnoring('pan', 'zoom')
  const mine = store.groups.filter(g => g.members.includes(id))
  return (
    <Section title="Groups">
      {mine.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 6 }}>
          {mine.map(g => (
            <span key={g.id} style={{ display: 'inline-flex', alignItems: 'center', gap: 4,
              fontSize: 11, padding: '1px 4px 1px 6px', borderRadius: 3,
              border: '1px solid var(--border)', background: 'var(--bg-raised)' }}>
              <GroupSwatch group={g}/>
              <span style={{ cursor: 'pointer', color: 'var(--ink-2)' }} title="Show this group"
                onClick={() => store.select(g.id, 'group')}>{g.name || '(unnamed group)'}</span>
              <span title="Remove from this group" style={{ cursor: 'pointer', color: 'var(--ink-muted)', padding: '0 2px' }}
                onClick={() => store.removeFromGroup(g.id, [id])}>×</span>
            </span>
          ))}
        </div>
      )}
      <GroupPicker memberIds={[id]} exclude={mine.map(g => g.id)}/>
    </Section>
  )
}

// Opens a member: switches to a diagram that shows it and selects it.
function goToMember(store, id) {
  const m = describeMember(id, store)
  if (!m) return
  if (m.kind === 'note') {
    if (m.diagramId !== store.activeDiagramId) store.setActiveDiagram(m.diagramId)
    setTimeout(() => { store.select(id, 'note'); store.centerOnElement(id) }, 0)
  } else if (m.kind === 'role') {
    store.navigateToElement(m.factId, 'fact')
    setTimeout(() => store.selectRole(m.factId, m.roleIndex), 0)
  } else {
    store.navigateToElement(id, m.kind === 'entity' || m.kind === 'value' ? 'objectType' : m.kind)
  }
}

const COLOR_LABELS = { outline: 'Outline', fill: 'Fill', text: 'Text', graphics: 'Role boxes',
  floating: 'Readings and role names', constraint: 'Constraints', deontic: 'Deontic constraints', connector: 'Role lines' }
const COLOR_DEFAULTS = { outline: '#ff8000', fill: '#fff3e0', text: '#ff8000', graphics: '#ff8000',
  floating: '#ff8000', constraint: '#ff8000', deontic: '#ff8000', connector: '#ff8000' }

function GroupInspector({ group }) {
  const store = useOrmStoreIgnoring('pan', 'zoom')
  const update = patch => store.updateGroup(group.id, patch)
  const members = group.members.map(id => ({ id, m: describeMember(id, store) })).filter(x => x.m)
  const index = store.groups.findIndex(g => g.id === group.id)
  // Members shown on the active diagram that a multi-selection can hold.
  const diagram = store.diagrams.find(d => d.id === store.activeDiagramId)
  const selectable = members.filter(({ id, m }) =>
    m.kind === 'constraint' ? (diagram?.constraintOccurrences ?? []).some(o => o.schemaConstraintId === id)
    : m.kind === 'subtype' ? (diagram?.subtypeOccurrences ?? []).includes(id)
    : m.kind === 'note' ? m.diagramId === diagram?.id
    : m.kind !== 'role' && (diagram?.occurrences ?? []).some(o => o.schemaElementId === id))
  return (
    <div style={{ marginBottom: 18 }}>
      <InspectorTitle>Group</InspectorTitle>
      <Row>
        <Label>Name</Label>
        <TInput value={group.name} onChange={v => update({ name: v })} placeholder="Group name"/>
      </Row>

      <Section title="Colours">
        {COLOR_CHANNELS.map(ch => {
          const on = !!group.colors?.[ch]
          return (
            <div key={ch} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 5 }}>
              <Checkbox label={COLOR_LABELS[ch]} checked={on}
                onChange={v => update({ colors: { ...group.colors, [ch]: v ? COLOR_DEFAULTS[ch] : undefined } })}/>
              {on && <input type="color" value={group.colors[ch]}
                onChange={e => update({ colors: { ...group.colors, [ch]: e.target.value } })}
                style={{ width: 36, height: 20, padding: 0, border: '1px solid var(--border)', marginLeft: 'auto' }}/>}
            </div>
          )
        })}
        <Row>
          <Label>Priority</Label>
          <input type="number" step={1} value={group.priority ?? 0}
            onChange={e => update({ priority: Number.isFinite(+e.target.value) ? Math.round(+e.target.value) : 0 })}
            style={{ width: 70 }}/>
          <div style={{ fontSize: 11, color: 'var(--ink-muted)', marginTop: 4, lineHeight: 1.4 }}>
            When an element is in several groups, the highest priority sets each colour; on a tie, the group higher in the list.
          </div>
        </Row>
        <div style={{ display: 'flex', gap: 6 }}>
          <button disabled={index <= 0} onClick={() => store.moveGroup(group.id, -1)} style={{ fontSize: 11, padding: '2px 8px' }}>Move up</button>
          <button disabled={index >= store.groups.length - 1} onClick={() => store.moveGroup(group.id, 1)} style={{ fontSize: 11, padding: '2px 8px' }}>Move down</button>
        </div>
      </Section>

      <Section title={`Members (${members.length})`}>
        {members.length === 0 && (
          <div style={{ fontSize: 11, color: 'var(--ink-muted)', marginBottom: 6, lineHeight: 1.4 }}>
            No members yet. Add an element from its Groups section, or select several and use the Selection panel.
          </div>
        )}
        {members.map(({ id, m }) => (
          <div key={id} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, padding: '2px 0',
            borderBottom: '1px solid var(--border-soft)' }}>
            <span style={{ color: 'var(--ink-muted)', width: 66, flexShrink: 0 }}>{m.kind}</span>
            <span onClick={() => goToMember(store, id)} title="Go to this element"
              style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                cursor: 'pointer', color: 'var(--ink-2)' }}>{m.label}</span>
            <span title="Remove from group" onClick={() => store.removeFromGroup(group.id, [id])}
              style={{ cursor: 'pointer', color: 'var(--ink-muted)', padding: '0 3px' }}>×</span>
          </div>
        ))}
        {selectable.length > 0 && (
          <button style={{ fontSize: 11, padding: '3px 8px', marginTop: 8 }}
            title="Select the members shown on this diagram"
            onClick={() => store.setMultiSelection(selectable.map(x => x.id))}>
            Select on diagram ({selectable.length})
          </button>
        )}
      </Section>

      <DocumentationSection el={group} onChange={update}/>
      <PropertiesSection el={group} kind="group" onChange={update}/>

      <DangerBtn onClick={() => store.deleteGroup(group.id)}>Delete Group</DangerBtn>
    </div>
  )
}

function TInput({ value, onChange, placeholder }) {
  return <input value={value ?? ''} onChange={e => onChange(e.target.value)}
    onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur() }}
    placeholder={placeholder} style={{ width: '100%' }} />
}

function Checkbox({ label, checked, onChange, disabled = false, title }) {
  return (
    <label title={title} style={{ display: 'flex', alignItems: 'center', gap: 7,
      cursor: disabled ? 'not-allowed' : 'pointer',
      color: disabled ? 'var(--ink-muted)' : 'var(--ink-2)',
      fontSize: 12, marginBottom: 4, opacity: disabled ? 0.5 : 1 }}>
      <input type="checkbox" checked={!!checked} disabled={disabled}
        onChange={e => !disabled && onChange(e.target.checked)}
        style={{ width: 'auto', padding: 0, border: 'none', cursor: disabled ? 'not-allowed' : 'pointer' }}/>
      {label}
    </label>
  )
}

// Alethic or deontic (NORMA's Modality): a deontic constraint says what ought
// to hold, so a population may break it. It is drawn in blue and verbalised
// as "It is obligatory that …".
function DeonticCheckbox({ checked, onChange, disabled = false, title }) {
  return (
    <Checkbox label="Deontic (an obligation)" checked={checked} onChange={onChange} disabled={disabled}
      title={title ?? 'What ought to hold rather than what must hold: a population may break it. Drawn in blue; verbalised as \u201cIt is obligatory that \u2026\u201d'}/>
  )
}

function DangerBtn({ onClick, children }) {
  return (
    <button onClick={onClick}
      style={{ background: 'transparent', color: 'var(--danger)',
        border: '1px solid var(--danger)', borderRadius: 3, padding: '4px 10px', fontSize: 11, cursor: 'pointer' }}
      onMouseEnter={e => { e.currentTarget.style.background = 'var(--danger)'; e.currentTarget.style.color = '#fff' }}
      onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'var(--danger)' }}>
      {children}
    </button>
  )
}

function RichTooltip({ content, children, wrapStyle }) {
  const [pos, setPos] = useState(null)
  const tipRef = useRef(null)

  // After rendering the tooltip, nudge it back inside the viewport if it overflows
  useLayoutEffect(() => {
    const el = tipRef.current
    if (!el) return
    const r = el.getBoundingClientRect()
    let dx = 0, dy = 0
    if (r.right  > window.innerWidth)  dx = window.innerWidth  - r.right  - 6
    if (r.bottom > window.innerHeight) dy = window.innerHeight - r.bottom - 6
    if (r.left + dx < 6) dx = 6 - r.left
    if (r.top  + dy < 6) dy = 6 - r.top
    if (dx || dy) {
      el.style.left = (r.left + dx) + 'px'
      el.style.top  = (r.top  + dy) + 'px'
    }
  })

  return (
    <div style={{ position: 'relative', ...wrapStyle }}
      onMouseEnter={e => setPos({ x: e.clientX, y: e.clientY })}
      onMouseMove={e => setPos({ x: e.clientX, y: e.clientY })}
      onMouseLeave={() => setPos(null)}>
      {children}
      {pos && (
        <div ref={tipRef} style={{
          position: 'fixed', left: pos.x + 14, top: pos.y - 10,
          zIndex: 9999, background: '#fff',
          border: '1px solid var(--border)', borderRadius: 4,
          padding: '4px 8px', fontSize: 11,
          boxShadow: '0 2px 8px rgba(0,0,0,0.15)',
          pointerEvents: 'none', whiteSpace: 'nowrap',
        }}>
          {content}
        </div>
      )}
    </div>
  )
}

// ── Value Range editor ────────────────────────────────────────────────────────
const VR_TYPES = [
  { value: 'single', label: 'Single value' },
  { value: 'lower',  label: 'Lower bound' },
  { value: 'upper',  label: 'Upper bound' },
  { value: 'range',  label: 'Range' },
]

// Local-state-backed range input — commits to the store only on blur to avoid
// focus-stealing re-renders on every keystroke.
function RangeField({ value, onChange, placeholder, typeKind, numProps, inputStyle }) {
  const [localValue, setLocalValue] = useState(value)
  useEffect(() => { setLocalValue(value) }, [value])
  if (typeKind === 'boolean') {
    return (
      <select value={value ?? ''} onChange={e => onChange(e.target.value)}
        style={{ ...inputStyle }}>
        <option value=""></option>
        <option value="true">true</option>
        <option value="false">false</option>
      </select>
    )
  }
  return (
    <input {...numProps} className="range-field" value={localValue ?? ''} placeholder={placeholder}
      onChange={e => setLocalValue(e.target.value)}
      onBlur={() => { if (localValue !== value) onChange(localValue) }}
      onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur() }}
      style={inputStyle}/>
  )
}

export function ValueRangeEditor({ range, onChange, naturalNumbers = false, positiveIntegers = false, typeKind = null }) {
  const specs = range || []
  // Pointer-event based drag (HTML5 drag-and-drop on macOS Chrome has an
  // unsuppressable drag-image spring-back animation). `drag` is null when
  // not dragging, otherwise { startIdx, startY, dy, overIdx }.
  const [drag, setDrag] = useState(null)
  const dragRef = useRef(null)
  dragRef.current = drag
  const specsRef = useRef(specs)
  specsRef.current = specs
  const [snapping, setSnapping] = useState(false)  // true for one frame after a drop
  const rowRefs = useRef([])
  const rowHeightsRef = useRef([])  // captured at drag start (includes margin)

  // After a drop, suppress transitions for one frame so transforms reset to 0
  // instantly. A useLayoutEffect with a forced reflow makes sure the browser
  // commits the snap state before transitions are re-enabled — otherwise the
  // two adjacent renders collapse into one paint and the browser animates
  // from the pre-drop transforms.
  useLayoutEffect(() => {
    if (!snapping) return
    if (rowRefs.current[0]) void rowRefs.current[0].offsetHeight
    setSnapping(false)
  }, [snapping])

  const commit = (newSpecs) => onChange(newSpecs.length ? newSpecs : null)

  const addSpec = () => commit([...specs, { type: 'single', value: '' }])

  const removeSpec = (i) => commit(specs.filter((_, j) => j !== i))

  const updateSpec = (i, patch) => {
    const next = specs.map((s, j) => j === i ? { ...s, ...patch } : s)
    commit(next)
  }

  const changeType = (i, type) => {
    // Preserve any values that carry over
    const prev = specs[i]
    const base = { type }
    if (type === 'single') base.value = prev.value ?? prev.lower ?? prev.upper ?? ''
    if (type === 'lower')  base.lower = prev.lower ?? prev.value ?? ''
    if (type === 'upper')  base.upper = prev.upper ?? prev.value ?? ''
    if (type === 'range')  { base.lower = prev.lower ?? prev.value ?? ''; base.upper = prev.upper ?? '' }
    if (prev.lowerOpen && 'lower' in base) base.lowerOpen = true
    if (prev.upperOpen && 'upper' in base) base.upperOpen = true
    commit(specs.map((s, j) => j === i ? base : s))
  }

  const captureRowHeights = () => {
    rowHeightsRef.current = rowRefs.current.map(el => {
      if (!el) return 0
      const r = el.getBoundingClientRect()
      // Include the bottom margin (4px) so neighbour rows slide by full slot height
      return r.height + 4
    })
  }

  // Dragged row follows the cursor (translateY = drag.dy). Other rows between
  // the source and the current hover position shift by one slot height to
  // open up a gap at the drop target.
  const computeTranslate = (i) => {
    if (!drag) return 0
    if (i === drag.startIdx) return drag.dy
    const h = rowHeightsRef.current[drag.startIdx] || 0
    if (drag.startIdx < drag.overIdx && i > drag.startIdx && i <= drag.overIdx) return -h
    if (drag.startIdx > drag.overIdx && i < drag.startIdx && i >= drag.overIdx) return h
    return 0
  }

  // Pointer-capture based drag: setPointerCapture on the handle redirects all
  // subsequent pointer events to that element, so we get pointermove/up
  // synchronously even when the cursor moves off the handle. No window
  // listeners, no useEffect timing window.
  const onHandlePointerDown = (e, i) => {
    if (e.button !== 0) return
    e.preventDefault()
    try { e.currentTarget.setPointerCapture(e.pointerId) } catch {}
    captureRowHeights()
    setDrag({ startIdx: i, startY: e.clientY, dy: 0, overIdx: i })
  }

  const onHandlePointerMove = (e) => {
    const d = dragRef.current
    if (!d) return
    const dy = e.clientY - d.startY
    const h = rowHeightsRef.current[d.startIdx] || 28
    const n = specsRef.current.length
    let overIdx = d.startIdx + Math.round(dy / h)
    if (overIdx < 0) overIdx = 0
    if (overIdx > n - 1) overIdx = n - 1
    if (dy === d.dy && overIdx === d.overIdx) return
    setDrag({ ...d, dy, overIdx })
  }

  const onHandlePointerUp = (e) => {
    const d = dragRef.current
    try { e.currentTarget.releasePointerCapture(e.pointerId) } catch {}
    if (!d) { setDrag(null); return }
    if (d.overIdx !== d.startIdx) {
      const next = [...specsRef.current]
      const [moved] = next.splice(d.startIdx, 1)
      next.splice(d.overIdx, 0, moved)
      setSnapping(true)
      commit(next)
    }
    setDrag(null)
  }

  const inputStyle = { fontSize: 11, padding: '2px 3px', flex: 1, minWidth: 0 }
  const sepStyle = { fontSize: 11, color: 'var(--ink-muted)', flexShrink: 0, padding: '0 2px' }
  // Value ranges may have open (exclusive) bounds, as in NORMA; counts
  // (cardinality, frequency) are integers and don't need them.
  const openBounds = !naturalNumbers && !positiveIntegers
  const boundToggle = (i, spec, field) => {
    const open = !!spec[field]
    const sym = field === 'lowerOpen' ? (open ? '(' : '[') : (open ? ')' : ']')
    return (
      <button onClick={() => updateSpec(i, { [field]: !open })}
        title={open ? 'Open bound: the bound itself is excluded. Click to include it.'
          : 'Closed bound: the bound itself is included. Click to exclude it.'}
        style={{ fontSize: 12, fontFamily: 'var(--font-mono)', padding: '0 1px', flexShrink: 0,
          background: 'none', border: '1px solid transparent', borderRadius: 3, cursor: 'pointer',
          color: open ? 'var(--accent)' : 'var(--ink-muted)', fontWeight: open ? 700 : 400 }}>
        {sym}
      </button>
    )
  }
  // Pick a native input control based on the declared datatype (when known).
  // The naturalNumbers/positiveIntegers props remain for cardinality and
  // frequency, which are always integer with a fixed minimum.
  const numProps =
      positiveIntegers          ? { type: 'number', min: 1, step: 1 }
    : naturalNumbers            ? { type: 'number', min: 0, step: 1 }
    : typeKind === 'integer'    ? { type: 'number', step: 1 }
    : typeKind === 'decimal'    ? { type: 'number', step: 'any' }
    : typeKind === 'date'       ? { type: 'date' }
    : typeKind === 'datetime'   ? { type: 'datetime-local' }
    : typeKind === 'time'       ? { type: 'time', step: 1 }
    : {}

  return (
    <div>
      {specs.map((spec, i) => {
        const isDragRow = drag?.startIdx === i
        // Transition policy:
        //   - During the snap frame: no transitions anywhere (instant reset).
        //   - The dragged row never transitions transform (must track cursor 1:1).
        //   - Other rows transition transform smoothly so they slide into place.
        const transition = snapping
          ? 'none'
          : isDragRow
            ? 'opacity 120ms ease'
            : 'transform 180ms ease, opacity 120ms ease'
        return (
        <div key={i}
          ref={el => { rowRefs.current[i] = el }}
          style={{
            display: 'flex', gap: 3, marginBottom: 4, alignItems: 'center',
            opacity: isDragRow ? 0.85 : 1,
            transform: `translateY(${computeTranslate(i)}px)`,
            transition,
            borderRadius: 3,
            position: 'relative',
            zIndex: isDragRow ? 2 : 1,
            boxShadow: isDragRow ? '0 4px 10px rgba(0,0,0,0.18)' : 'none',
            background: isDragRow ? 'var(--bg-surface)' : 'transparent',
            willChange: drag ? 'transform' : 'auto',
          }}>
          <span
            onPointerDown={e => onHandlePointerDown(e, i)}
            onPointerMove={onHandlePointerMove}
            onPointerUp={onHandlePointerUp}
            onPointerCancel={onHandlePointerUp}
            style={{ cursor: drag ? 'grabbing' : 'grab', color: 'var(--ink-muted)', fontSize: 11,
              flexShrink: 0, paddingRight: 1, userSelect: 'none', touchAction: 'none' }}>⠿</span>
          <select value={spec.type} onChange={e => changeType(i, e.target.value)}
            style={{ fontSize: 11, flexShrink: 1, minWidth: 0, width: 64 }}>
            {VR_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
          </select>

          {spec.type === 'single' && (
            <RangeField value={spec.value} placeholder="value" typeKind={typeKind} numProps={numProps} inputStyle={inputStyle}
              onChange={v => updateSpec(i, { value: v })}/>
          )}
          {openBounds && (spec.type === 'lower' || spec.type === 'range') && boundToggle(i, spec, 'lowerOpen')}
          {(spec.type === 'lower' || spec.type === 'range') && (
            <RangeField value={spec.lower} placeholder="lower" typeKind={typeKind} numProps={numProps} inputStyle={inputStyle}
              onChange={v => updateSpec(i, { lower: v })}/>
          )}
          {(spec.type === 'lower' || spec.type === 'upper' || spec.type === 'range') && (
            <span style={sepStyle}>..</span>
          )}
          {(spec.type === 'upper' || spec.type === 'range') && (
            <RangeField value={spec.upper} placeholder="upper" typeKind={typeKind} numProps={numProps} inputStyle={inputStyle}
              onChange={v => updateSpec(i, { upper: v })}/>
          )}
          {openBounds && (spec.type === 'upper' || spec.type === 'range') && boundToggle(i, spec, 'upperOpen')}

          <button onClick={() => removeSpec(i)}
            style={{ background: 'none', border: 'none', color: 'var(--danger)',
              cursor: 'pointer', fontSize: 13, padding: '0 2px', flexShrink: 0 }}>
            ✕
          </button>
        </div>
        )
      })}
      <button onClick={addSpec}
        style={{ fontSize: 11, padding: '2px 8px', background: 'var(--bg-raised)',
          border: '1px solid var(--border)', borderRadius: 3,
          cursor: 'pointer', color: 'var(--ink-2)' }}>
        + Add range spec
      </button>
    </div>
  )
}

// ── Datatype field (value types, entity types with refMode, nested value types)─
function DatatypeField({ assignment, onSet }) {
  const store = useOrmStoreIgnoring('pan', 'zoom')
  const activeDiagram = store.diagrams?.find(d => d.id === store.activeDiagramId)
  const profileId = activeDiagram?.profileId ?? null
  const profile = profileId ? PROFILE_MAP[profileId] : null
  const mismatch = assignment && profileId && assignment.profileId !== profileId
  const matchingDt = assignment && !mismatch
    ? getDatatypeById(assignment.profileId, assignment.datatypeId)
    : null

  const selectStyle = {
    width: '100%', fontSize: 12, padding: '3px 6px',
    border: '1px solid var(--border)', borderRadius: 3,
    background: 'var(--bg-raised)', color: 'var(--ink-2)',
  }
  const paramInputStyle = {
    width: 60, fontSize: 12, padding: '2px 5px',
    border: '1px solid var(--border)', borderRadius: 3,
    background: 'var(--bg-raised)', color: 'var(--ink-2)',
  }

  return (
    <>
      <Row>
        <Label>Datatype</Label>
        {!profileId ? (
          <span style={{ fontSize: 11, color: 'var(--ink-muted)', fontStyle: 'italic' }}>
            No profile set
          </span>
        ) : mismatch ? (
          <span style={{ fontSize: 11, color: 'var(--danger)' }}>
            Profile mismatch
          </span>
        ) : (
          <select
            value={assignment?.datatypeId ?? ''}
            onChange={e => {
              const dtId = e.target.value
              if (!dtId) { onSet(null); return }
              onSet({ profileId, datatypeId: dtId, params: {} })
            }}
            style={selectStyle}>
            <option value="">— not set —</option>
            {profile.datatypes.map(dt => (
              <option key={dt.id} value={dt.id}>{dt.name}</option>
            ))}
          </select>
        )}
      </Row>
      {mismatch && (
        <div style={{ marginBottom: 6 }}>
          <div style={{
            fontSize: 11, color: 'var(--danger)',
            background: '#fdf0ee', border: '1px solid #e8b4ae',
            borderRadius: 3, padding: '5px 8px', marginBottom: 4,
          }}>
            &ldquo;{assignment.datatypeId}&rdquo; is from profile &ldquo;{PROFILE_MAP[assignment.profileId]?.name ?? assignment.profileId}&rdquo;,
            current profile is &ldquo;{profile?.name ?? profileId}&rdquo;.
          </div>
          <button
            onClick={() => onSet(null)}
            style={{ fontSize: 11, padding: '3px 8px', color: 'var(--danger)',
              background: 'transparent', border: '1px solid var(--danger)', borderRadius: 3, cursor: 'pointer' }}
            onMouseEnter={e => { e.currentTarget.style.background = 'var(--danger)'; e.currentTarget.style.color = '#fff' }}
            onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'var(--danger)' }}>
            Clear assignment
          </button>
        </div>
      )}
      {matchingDt && matchingDt.params.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, paddingLeft: 4, marginBottom: 4 }}>
          {matchingDt.params.map(param => (
            <Row key={param.name}>
              <Label>{param.name}{param.optional ? '' : ' *'}</Label>
              <input
                type="number"
                min={1}
                value={assignment.params?.[param.name] ?? ''}
                placeholder={param.optional ? 'optional' : 'required'}
                onChange={e => {
                  const val = e.target.value === '' ? undefined : Number(e.target.value)
                  const params = { ...(assignment.params ?? {}), [param.name]: val }
                  if (val === undefined) delete params[param.name]
                  onSet({ ...assignment, params })
                }}
                onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur() }}
                style={paramInputStyle}
              />
            </Row>
          ))}
        </div>
      )}
    </>
  )
}

// ── Entity / Value inspector ──────────────────────────────────────────────────
function ObjectTypeInspector({ ot }) {
  const store = useOrmStoreIgnoring('pan', 'zoom')

  // Derived ref-mode info for entities.
  const refMode    = ot.kind === 'entity' ? findRefMode(ot, store.facts, store.objectTypes) : null
  const refVt      = refMode ? store.objectTypes.find(o => o.id === refMode.vtId) : null
  const refLabel   = refVt ? refModeLabel(ot.name, refVt.name) : ''

  // Composite preferred identifier (non-ref-mode-binary PI scheme).
  const compositePi    = ot.kind === 'entity' && !refMode
    ? findCompositePI(ot, store.facts, store.objectTypes, store.constraints)
    : null
  const compositePiFact = compositePi ? store.facts.find(f => f.id === compositePi.factId) : null

  return (
    <div style={{ marginBottom: 18 }}>
      <InspectorTitle>{ot.kind === 'entity' ? 'Entity Type' : 'Value Type'}</InspectorTitle>
      <ValidationErrorStrip elementId={ot.id} store={store}/>
      <Row>
        <Label>Name</Label>
        {/* Without a name in the view language, the base name is the placeholder. */}
        <TInput value={ot._fb?.name != null ? '' : ot.name} placeholder={ot._fb?.name}
          onChange={v => store.updateObjectType(ot.id, { name: v })}/>
      </Row>
      {ot.kind === 'entity' && (
        compositePiFact ? (
          <>
            <Row>
              <Label>Reference Mode</Label>
              <span style={{ fontSize: 11, color: 'var(--ink-muted)', fontStyle: 'italic' }}>
                composite preferred identifier
              </span>
            </Row>
            <div style={{ display: 'flex', gap: 5, padding: '0 8px 8px', flexWrap: 'wrap' }}>
              <button
                onClick={() => store.select(compositePiFact.id, 'fact')}
                style={{ fontSize: 10, padding: '1px 6px',
                  background: 'var(--bg-raised)', border: '1px solid var(--border-soft)',
                  borderRadius: 3, cursor: 'pointer', color: 'var(--ink-2)' }}>
                Identifying Fact
              </button>
            </div>
          </>
        ) : (
          <Row>
            <Label>Reference Mode</Label>
            <TInput value={refLabel} placeholder=".code / name / —"
              onChange={v => store.setEntityRefModeLabel(ot.id, v)}/>
          </Row>
        )
      )}
      <RefModeExpandCollapseButtons factId={ot.id} occurrenceId={ot.occurrenceId} store={store}/>
      {ot.kind === 'entity' && refVt && (
        <Row>
          <Label>Datatype</Label>
          <span style={{ fontSize: 11, color: 'var(--ink-muted)' }}>
            {(() => {
              const a = refVt.datatypeAssignment
              const dt = a ? getDatatypeById(a.profileId, a.datatypeId) : null
              return dt ? dt.name : 'not set'
            })()}
            {' '}·{' '}
            <button
              onClick={() => store.select(refVt.id, 'value')}
              style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer',
                color: 'var(--accent)', fontSize: 11 }}>
              edit on {refVt.name}
            </button>
          </span>
        </Row>
      )}
      {ot.kind === 'value' && (
        <DatatypeField
          assignment={ot.datatypeAssignment}
          onSet={a => store.setValueTypeDatatype(ot.id, a)}
        />
      )}

      <Section title="Properties">
        {ot.kind === 'entity' && (
          <Checkbox label="Is personal"
            checked={!!ot.isPersonal}
            onChange={v => store.updateObjectType(ot.id, { isPersonal: v })}/>
        )}
        <Checkbox label="Is independent"
          checked={!!ot.isIndependent}
          onChange={v => store.updateObjectType(ot.id, { isIndependent: v })}/>
      </Section>

      <TypeLexiconSection name={ot.name} lexicon={ot.lexicon}
        onChange={lexicon => store.updateObjectType(ot.id, { lexicon })}/>

      {ot.kind === 'entity' && <DerivationSection ot={ot} store={store}/>}

      <Section title="Constraints">
        {ot.kind === 'value' && (
          <Row>
            <Label>Value Range</Label>
            <RangeChip range={ot.valueRange}
              onClick={() => store.selectValueRange({ otId: ot.id })} />
          </Row>
        )}
        <Row>
          <Label>Cardinality Range</Label>
          <RangeChip range={ot.cardinalityRange} format={formatCardinalityRange}
            onClick={() => store.selectCardinalityRange({ otId: ot.id })} />
        </Row>
      </Section>

      <DocumentationSection el={ot} onChange={patch => store.updateObjectType(ot.id, patch)}/>
      <PropertiesSection el={ot} kind={ot.kind} onChange={patch => store.updateObjectType(ot.id, patch)}/>
      <GroupMembershipSection id={ot.id}/>

      <Section title="Usage">
        <DiagramList elementId={ot.id} kind={ot.kind} />
      </Section>

      <DangerBtn onClick={() => store.deleteObjectType(ot.id)}>
        Delete {ot.kind === 'entity' ? 'Entity' : 'Value'} Type
      </DangerBtn>
    </div>
  )
}



// ── Derivation of a subtype ───────────────────────────────────────────────────
// Not derived, derived or semi-derived; only a subtype can be derived. The
// rule itself is edited in DerivationRuleEditor.
function DerivationSection({ ot, store }) {
  const supers = directSupertypes(ot.id, store.subtypes)
  const mode = ot.derivation ?? 'none'
  const notSubtype = supers.length === 0
  const issues = isDerived(ot) ? checkRule(ot.derivationRule, ot.id, store, makeContext(store)) : []
  const nErrors = issues.filter(i => i.severity === 'error').length
  return (
    <Section title="Derivation">
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}
        title={notSubtype ? 'Only a subtype can be derived' : undefined}>
        <div>
          {DERIVATION_MODES.map(m => (
            <label key={m.id} style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 12, marginBottom: 3, whiteSpace: 'nowrap',
              color: notSubtype ? 'var(--ink-muted)' : 'var(--ink-2)', opacity: notSubtype ? 0.5 : 1,
              cursor: notSubtype ? 'not-allowed' : 'pointer' }}>
              <input type="radio" name={`derivation-${ot.id}`} checked={mode === m.id} disabled={notSubtype}
                onChange={() => store.updateObjectType(ot.id, { derivation: m.id })}
                style={{ width: 'auto', padding: 0, border: 'none', cursor: 'inherit' }}/>
              {m.label}
            </label>
          ))}
        </div>
        <button disabled={notSubtype || !isDerived(ot)} onClick={() => store.openRuleEditor({ otId: ot.id })}
          style={{ fontSize: 11, padding: '2px 8px', borderRadius: 3, border: '1px solid var(--border)',
            background: 'var(--bg-raised)', color: 'var(--ink-2)',
            cursor: notSubtype || !isDerived(ot) ? 'not-allowed' : 'pointer',
            opacity: notSubtype || !isDerived(ot) ? 0.5 : 1 }}>
          Derivation rule…
        </button>
      </div>
      {isDerived(ot) && (
        <div style={{ fontSize: 11, marginTop: 4,
          color: nErrors ? 'var(--danger)' : 'var(--ink-muted)' }}>
          {!ot.derivationRule ? 'No rule yet'
            : nErrors ? `The rule has ${nErrors} problem${nErrors > 1 ? 's' : ''}`
            : 'The rule is valid'}
        </div>
      )}
    </Section>
  )
}

// ── Derivation of a fact type ─────────────────────────────────────────────────
// Not derived, derived or semi-derived. The rule, with the roles it computes,
// is edited in DerivationRuleEditor.
function FactDerivationSection({ fact, store }) {
  const mode = fact.derivation ?? 'none'
  const why = whyNotDerivable(fact, store)
  const blocked = !!why && mode === 'none'
  const issues = isDerivedFact(fact) ? checkFactRule(fact, store, makeContext(store)) : []
  const nErrors = issues.filter(i => i.severity === 'error').length
  const nComputed = fact.roles.filter(r => isComputedRole(fact, r)).length
  return (
    <Section title="Derivation">
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }} title={blocked ? why : undefined}>
        <div>
          {DERIVATION_MODES.map(m => (
            <label key={m.id} style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 12, marginBottom: 3, whiteSpace: 'nowrap',
              color: blocked ? 'var(--ink-muted)' : 'var(--ink-2)', opacity: blocked ? 0.5 : 1,
              cursor: blocked ? 'not-allowed' : 'pointer' }}>
              <input type="radio" name={`derivation-${fact.id}`} checked={mode === m.id} disabled={blocked}
                onChange={() => store.updateFact(fact.id, { derivation: m.id })}
                style={{ width: 'auto', padding: 0, border: 'none', cursor: 'inherit' }}/>
              {m.label}
            </label>
          ))}
        </div>
        <button disabled={!isDerivedFact(fact)} onClick={() => store.openRuleEditor({ factId: fact.id })}
          style={{ fontSize: 11, padding: '2px 8px', borderRadius: 3, border: '1px solid var(--border)',
            background: 'var(--bg-raised)', color: 'var(--ink-2)',
            cursor: !isDerivedFact(fact) ? 'not-allowed' : 'pointer',
            opacity: !isDerivedFact(fact) ? 0.5 : 1 }}>
          Derivation rule…
        </button>
      </div>
      {isDerivedFact(fact) && (
        <div style={{ fontSize: 11, marginTop: 4,
          color: nErrors ? 'var(--danger)' : 'var(--ink-muted)' }}>
          {!fact.derivationRule ? 'No rule yet'
            : nErrors ? `The rule has ${nErrors} problem${nErrors > 1 ? 's' : ''}`
            : `The rule is valid${nComputed ? `; it computes ${nComputed} role${nComputed > 1 ? 's' : ''}` : ''}`}
        </div>
      )}
    </Section>
  )
}

// ── Range chip — brief clickable summary linking to dedicated inspector ────────
function RangeChip({ range, onClick, format = formatValueRange }) {
  const text = format(range)
  const summary = text
    ? <span>{text}</span>
    : <span style={{ fontStyle: 'italic', color: 'var(--ink-muted)' }}>none</span>
  return (
    <div onClick={onClick}
      style={{ display: 'flex', alignItems: 'center', gap: 5,
        fontSize: 12, color: 'var(--ink-2)', marginBottom: 4,
        cursor: 'pointer', padding: '3px 8px',
        background: 'var(--bg-raised)', border: '1px solid var(--border-soft)',
        borderRadius: 3 }}>
      <span style={{ flex: 1 }}>{summary}</span>
      <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--accent)', flexShrink: 0, lineHeight: 1 }}>→</span>
    </div>
  )
}

// ── Base role chip — links to the base role of an implicit link ──────────────
function BaseRoleChip({ parentFact, roleIndex }) {
  const store = useOrmStoreIgnoring('pan', 'zoom')
  const otMap = Object.fromEntries(store.objectTypes.map(o => [o.id, o]))
  const factMap = Object.fromEntries(store.facts.filter(f => f.objectified).map(f => [f.id, f]))

  const playerName = (playerId) => {
    if (!playerId) return '?'
    const ot = otMap[playerId]
    if (ot) return ot.name
    const nf = factMap[playerId]
    if (nf?.objectified) return nf.objectifiedName || '(unnamed)'
    return '?'
  }

  const n = parentFact.arity
  const parts = parentFact.readingParts || []
  const tokens = []
  for (let i = 0; i <= n; i++) {
    const text = (parts[i] || '').trim()
    if (text) tokens.push({ kind: 'text', value: text })
    if (i < n) tokens.push({ kind: 'ot', roleIndex: i, value: playerName(parentFact.roles[i]?.objectTypeId) })
  }

  return (
    <div onClick={() => store.selectRole(parentFact.id, roleIndex)}
      style={{ display: 'flex', alignItems: 'center', gap: 5,
        fontSize: 12, color: 'var(--ink-2)',
        cursor: 'pointer', padding: '3px 8px',
        background: 'var(--bg-raised)', border: '1px solid var(--border-soft)',
        borderRadius: 3 }}>
      <span style={{ flex: 1 }}>
        {tokens.length === 0
          ? <span style={{ color: '#2a7a2a' }}>{parentFact.reading || parentFact.id}</span>
          : tokens.map((tok, i) => (
              <React.Fragment key={i}>
                {i > 0 && ' '}
                {tok.kind === 'ot'
                  ? <span style={{ color: '#7c4dbd', fontWeight: 600, background: tok.roleIndex === roleIndex ? '#f5efb8' : 'none', borderRadius: 2, padding: tok.roleIndex === roleIndex ? '0 2px' : 0 }}>{tok.value}</span>
                  : <span style={{ color: '#2a7a2a' }}>{tok.value}</span>
                }
              </React.Fragment>
            ))
        }
        {' '}<span style={{ color: 'var(--ink-muted)', fontWeight: 400 }}>({roleIndex + 1})</span>
      </span>
      <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--accent)', flexShrink: 0, lineHeight: 1 }}>→</span>
    </div>
  )
}

// ── Shared role constraints section (used in RoleList and RoleInspector) ─────
function RoleConstraintsSection({ role, onChange, onNavigateValueRange, onNavigateCardinalityRange }) {
  return (
    <Section title="Constraints">
      <Label>Participation</Label>
      <Checkbox label="Mandatory" checked={role.mandatory}
        onChange={v => onChange(v ? { mandatory: true } : { mandatory: false, mandatoryDeontic: false })} />
      {role.mandatory && (
        <div style={{ paddingLeft: 20 }}>
          <DeonticCheckbox checked={!!role.mandatoryDeontic} onChange={v => onChange({ mandatoryDeontic: v })}/>
        </div>
      )}
      <Row>
        <Label>Value Range</Label>
        {onNavigateValueRange
          ? <RangeChip range={role.valueRange} onClick={onNavigateValueRange} />
          : <ValueRangeEditor range={role.valueRange}
              onChange={vr => onChange({ valueRange: vr })} />}
      </Row>
      <Row>
        <Label>Cardinality Range</Label>
        {onNavigateCardinalityRange
          ? <RangeChip range={role.cardinalityRange} format={formatCardinalityRange} onClick={onNavigateCardinalityRange} />
          : <ValueRangeEditor naturalNumbers range={role.cardinalityRange}
              onChange={vr => onChange({ cardinalityRange: vr })} />}
      </Row>
    </Section>
  )
}

// ── Compact role list (fact inspector — click to inspect) ────
function CompactRoleList({ fact, store }) {
  const otMap     = Object.fromEntries(store.objectTypes.map(o => [o.id, o]))
  const nestedMap = Object.fromEntries(store.facts.filter(f => f.objectified).map(f => [f.id, f]))

  return (
    <div>
      {fact.roles.map((role, ri) => {
        const ot       = otMap[role.objectTypeId]
        const nf       = !ot ? nestedMap[role.objectTypeId] : null
        const player   = ot ? ot.name : nf ? nf.objectifiedName : null
        const hasImpliedLink = fact.objectified && !!role.objectTypeId
        const isShown  = hasImpliedLink && store.isImplicitLinkShown(fact.id, ri)
        return (
          <div
            key={role.id}
            onClick={() => store.selectRole(fact.id, ri)}
            style={{
              display: 'flex', alignItems: 'center', gap: 6,
              background: 'var(--bg-raised)',
              border: '1px solid var(--border-soft)',
              borderRadius: 4, padding: '5px 8px', marginBottom: 5,
              cursor: 'pointer', userSelect: 'none',
            }}
          >
            <span style={{ fontSize: 10, color: 'var(--ink-muted)', textTransform: 'uppercase',
              letterSpacing: '0.07em', flexShrink: 0, minWidth: 42 }}>
              Role {ri + 1}
            </span>
            <span style={{ fontSize: 12, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              color: player ? 'var(--ink)' : 'var(--ink-muted)',
              fontStyle: player ? 'normal' : 'italic' }}>
              {player ?? '—'}
              {nf && <span style={{ fontSize: 10, color: 'var(--ink-muted)', marginLeft: 3 }}>(nested)</span>}
            </span>
            {role.roleName && (
              <span style={{ fontSize: 10, color: 'var(--ink-muted)', flexShrink: 0,
                fontStyle: 'italic', maxWidth: 60, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {role.roleName}
              </span>
            )}
            {role.mandatory && (
              <span title="Mandatory" style={{ color: 'var(--col-constraint)', fontSize: 11, flexShrink: 0 }}>●</span>
            )}
            {hasImpliedLink && (
              <button
                onClick={e => { e.stopPropagation(); store.toggleImplicitLink(fact.id, ri) }}
                style={{ fontSize: 10, padding: '1px 6px', cursor: 'pointer', flexShrink: 0,
                  background: isShown ? 'var(--accent)' : 'var(--bg-raised)',
                  color: isShown ? '#fff' : 'var(--ink-muted)',
                  border: '1px solid var(--border)', borderRadius: 3 }}>
                {isShown ? 'Shown Link' : 'Show Link'}
              </button>
            )}
          </div>
        )
      })}
    </div>
  )
}

// ── Role inspector ────────────────────────────────────────────────────────────
function RoleInspector({ fact, roleIndex }) {
  const store = useOrmStoreIgnoring('pan', 'zoom')
  const role = fact.roles[roleIndex]
  if (!role) return null
  const reading = getDisplayReading(fact) || null

  return (
    <div style={{ marginBottom: 18 }}>
      <InspectorTitle>Role {roleIndex + 1}</InspectorTitle>
      <div style={{ marginBottom: 10 }}>
        <button
          onClick={() => store.select(fact.id, 'fact')}
          style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer',
            color: 'var(--accent)', fontSize: 11 }}>
          ← {reading ? reading : 'Fact Type'}
        </button>
      </div>
      <Row>
        <Label>Object Type</Label>
        <select value={role.objectTypeId || ''} style={{ width: '100%' }}
          onChange={e => store.assignObjectTypeToRole(fact.id, roleIndex, e.target.value || null)}
          onMouseDown={e => e.stopPropagation()}>
          <option value="">— unassigned —</option>
          {store.objectTypes.slice().sort((a, b) => a.name.localeCompare(b.name)).map(o => (
            <option key={o.id} value={o.id}>{o.name} ({o.kind})</option>
          ))}
          {store.facts.filter(f => f.objectified && f.id !== fact.id)
            .sort((a, b) => (a.objectifiedName || '').localeCompare(b.objectifiedName || ''))
            .map(f => (
              <option key={f.id} value={f.id}>{f.objectifiedName || '(unnamed)'} (nested)</option>
            ))}
        </select>
      </Row>
      <Row>
        <Label>Role Name</Label>
        <TInput value={role.roleName} placeholder="optional"
          onChange={v => store.updateRole(fact.id, roleIndex, { roleName: v })}/>
      </Row>
      <RoleConstraintsSection
        role={role}
        onChange={patch => store.updateRole(fact.id, roleIndex, patch)}
        onNavigateValueRange={() => store.selectValueRange({ factId: fact.id, roleIndex })}
        onNavigateCardinalityRange={() => store.selectCardinalityRange({ factId: fact.id, roleIndex })}
      />
      <PropertiesSection el={role} kind="role" onChange={patch => store.updateRole(fact.id, roleIndex, patch)}/>
      <GroupMembershipSection id={role.id}/>
      <Section title="Usage">
        <DangerBtn onClick={() => { store.deleteRole(fact.id, roleIndex); store.select(fact.id, 'fact') }}>
          Delete Role
        </DangerBtn>
      </Section>
    </div>
  )
}

// ── Internal Uniqueness Bar inspector ────────────────────────────────────────
function UniquenessBarInspector({ fact, uIndex }) {
  const store = useOrmStoreIgnoring('pan', 'zoom')
  const u = fact.uniqueness[uIndex]
  if (!u) return null

  const isImplicit = fact._implicit === true
  const parentFact = isImplicit ? store.facts.find(f => f.id === fact._parentFactId) : null
  const implicitLink = isImplicit && parentFact ? parentFact.implicitLinks?.find(il => il.roleIndex === fact._implicitRoleIndex) : null

  const otMap      = Object.fromEntries(store.objectTypes.map(o => [o.id, o]))
  const nestedMap  = Object.fromEntries(store.facts.filter(f => f.objectified).map(f => [f.id, f]))
  const sortedKey  = JSON.stringify([...u].sort())

  let isPreferred, canBePreferred, reading, identifiesVt = false
  if (isImplicit) {
    const prefArr = implicitLink?.preferredUniqueness || []
    isPreferred = prefArr.some(pu => JSON.stringify([...pu].sort()) === sortedKey)
    canBePreferred = true
    reading = getDisplayReading(fact) || null
    // Implicit link uniqueness on uRoles=[0] identifies the link's role player
    // (the parent fact's role at _implicitRoleIndex). Disallow PI if VT.
    if (u.length === 1 && u[0] === 0 && parentFact) {
      const playerOtId = parentFact.roles?.[fact._implicitRoleIndex]?.objectTypeId
      const playerOt   = playerOtId ? otMap[playerOtId] : null
      if (playerOt?.kind === 'value') identifiesVt = true
    }
  } else {
    isPreferred = (fact.preferredUniqueness || []).some(pu =>
      JSON.stringify([...pu].sort()) === sortedKey
    )
    canBePreferred = u.length === fact.arity - 1
    reading = getDisplayReading(fact) || null
    if (canBePreferred) {
      const covered = new Set(u)
      const uncoveredRi = fact.roles.findIndex((_, ri) => !covered.has(ri))
      const uncoveredOtId = uncoveredRi >= 0 ? fact.roles[uncoveredRi]?.objectTypeId : null
      const uncoveredOt = uncoveredOtId ? otMap[uncoveredOtId] : null
      if (uncoveredOt?.kind === 'value') identifiesVt = true
    }
  }

  const toggleRole = (ri) => {
    if (isImplicit) return
    const next = u.includes(ri) ? u.filter(i => i !== ri) : [...u, ri]
    if (next.length === 0) return
    store.updateUniquenessRoles(fact.id, uIndex, next)
  }

  const togglePreferred = () => {
    if (isImplicit) {
      const prefArr = implicitLink?.preferredUniqueness || []
      const next = isPreferred
        ? prefArr.filter(pu => JSON.stringify([...pu].sort()) !== sortedKey)
        : [...prefArr, [...u]]
      store.updateImplicitLink(parentFact.id, fact._implicitRoleIndex, { preferredUniqueness: next })
    } else {
      store.setPreferredUniqueness(fact.id, u)
    }
  }

  return (
    <div style={{ marginBottom: 18 }}>
      <InspectorTitle>Internal Uniqueness</InspectorTitle>
      <div style={{ marginBottom: 10 }}>
        <button onClick={() => isImplicit ? store.selectImplicitLink(parentFact.id, fact._implicitRoleIndex) : store.select(fact.id, 'fact')}
          style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer',
            color: 'var(--accent)', fontSize: 11 }}>
          ← {reading ?? 'Fact Type'}
        </button>
      </div>
      <Row>
        <Label>Roles covered</Label>
        {fact.roles.map((role, ri) => {
          const ot     = otMap[role.objectTypeId]
          const nf     = !ot ? nestedMap[role.objectTypeId] : null
          const player = ot ? ot.name : nf ? (nf.objectifiedName || '(unnamed)') : null
          const checked = u.includes(ri)
          const isLast  = checked && u.length === 1
          return (
            <Checkbox
              key={ri}
              label={`Role ${ri + 1}${player ? ` · ${player}` : ''}`}
              checked={checked}
              disabled={isImplicit || isLast}
              onChange={() => toggleRole(ri)}
            />
          )
        })}
      </Row>
      <Row>
        <Label>Identification</Label>
        <Checkbox
          label="Preferred Identifier"
          checked={isPreferred}
          disabled={!canBePreferred || identifiesVt}
          title={identifiesVt ? 'A value type cannot have a preferred identifier' : undefined}
          onChange={() => togglePreferred()}
        />
      </Row>
      {!isImplicit && (
        <Row>
          <Label>Modality</Label>
          <DeonticCheckbox checked={!isPreferred && isDeonticUniqueness(fact, u)} disabled={isPreferred}
            title={isPreferred ? 'A preferred identifier is always alethic' : undefined}
            onChange={v => store.setUniquenessDeontic(fact.id, u, v)}/>
        </Row>
      )}
      {!isImplicit && (
        <div style={{ marginTop: 8 }}>
          <DangerBtn onClick={() => { store.toggleUniqueness(fact.id, u); store.select(fact.id, 'fact') }}>
            Delete
          </DangerBtn>
        </div>
      )}
    </div>
  )
}

// ── Implied Internal Uniqueness inspector (read-only) ───────────────────────
function ImpliedUniquenessBarInspector({ fact, roleIndex }) {
  const store = useOrmStoreIgnoring('pan', 'zoom')
  const role = fact.roles[roleIndex]
  if (!role) return null
  const otMap     = Object.fromEntries(store.objectTypes.map(o => [o.id, o]))
  const nestedMap = Object.fromEntries(store.facts.filter(f => f.objectified).map(f => [f.id, f]))
  const ot        = otMap[role.objectTypeId]
  const nf        = !ot ? nestedMap[role.objectTypeId] : null
  const player    = ot ? ot.name : nf ? (nf.objectifiedName || '(unnamed)') : null
  const reading   = getDisplayReading(fact) || null

  return (
    <div style={{ marginBottom: 18 }}>
      <InspectorTitle>Implied Uniqueness</InspectorTitle>
      <div style={{ marginBottom: 10 }}>
        <button onClick={() => store.select(fact.id, 'fact')}
          style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer',
            color: 'var(--accent)', fontSize: 11 }}>
          ← {reading ?? 'Fact Type'}
        </button>
      </div>
      <Row>
        <Label>Role</Label>
        <div style={{ fontSize: 12 }}>
          Role {roleIndex + 1}{player ? ` · ${player}` : ''}
        </div>
      </Row>
      <Section title="Origin">
        <div style={{ fontSize: 11, color: 'var(--ink-muted)', lineHeight: 1.45 }}>
          This unary uniqueness constraint is implied by the preferred identifier
          covering the other role{fact.arity > 2 ? 's' : ''} of this fact type.
          It cannot be edited or deleted directly.
        </div>
      </Section>
    </div>
  )
}

// ── Implied Mandatory Role inspector (read-only) ────────────────────────────
function ImpliedMandatoryDotInspector({ fact, roleIndex }) {
  const store = useOrmStoreIgnoring('pan', 'zoom')
  const role = fact.roles[roleIndex]
  if (!role) return null
  const otMap     = Object.fromEntries(store.objectTypes.map(o => [o.id, o]))
  const nestedMap = Object.fromEntries(store.facts.filter(f => f.objectified).map(f => [f.id, f]))
  const ot        = otMap[role.objectTypeId]
  const nf        = !ot ? nestedMap[role.objectTypeId] : null
  const player    = ot ? ot.name : nf ? (nf.objectifiedName || '(unnamed)') : null
  const reading   = getDisplayReading(fact) || null

  return (
    <div style={{ marginBottom: 18 }}>
      <InspectorTitle>Implied Mandatory Role</InspectorTitle>
      <div style={{ marginBottom: 10 }}>
        <button onClick={() => store.select(fact.id, 'fact')}
          style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer',
            color: 'var(--accent)', fontSize: 11 }}>
          ← {reading ?? 'Fact Type'}
        </button>
      </div>
      <Row>
        <Label>Role</Label>
        <div style={{ fontSize: 12 }}>
          Role {roleIndex + 1}{player ? ` · ${player}` : ''}
        </div>
      </Row>
      <Section title="Origin">
        <div style={{ fontSize: 11, color: 'var(--ink-muted)', lineHeight: 1.45 }}>
          This mandatory role constraint is implied by the preferred identifier
          covering the other role{fact.arity > 2 ? 's' : ''} of this fact type.
          It cannot be edited or deleted directly.
        </div>
      </Section>
    </div>
  )
}

// ── Internal Frequency Constraint inspector ───────────────────────────────────
function InternalFrequencyInspector({ fact, ifItem }) {
  const store   = useOrmStoreIgnoring('pan', 'zoom')
  const isImplicit = fact._implicit === true
  const parentFact = isImplicit ? store.facts.find(f => f.id === fact._parentFactId) : null
  const otMap   = Object.fromEntries(store.objectTypes.map(o => [o.id, o]))
  const nestedMap = Object.fromEntries(store.facts.filter(f => f.objectified).map(f => [f.id, f]))
  const reading = getDisplayReading(fact) || null

  const toggleRole = (ri) => {
    if (isImplicit) return
    const next = ifItem.roles.includes(ri)
      ? ifItem.roles.filter(i => i !== ri)
      : [...ifItem.roles, ri]
    if (next.length === 0) return
    store.updateInternalFrequency(fact.id, ifItem.id, { roles: next })
  }

  return (
    <div style={{ marginBottom: 18 }}>
      <InspectorTitle>Frequency Range</InspectorTitle>
      <div style={{ marginBottom: 10 }}>
        <button onClick={() => isImplicit ? store.selectImplicitLink(parentFact.id, fact._implicitRoleIndex) : store.select(fact.id, 'fact')}
          style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer',
            color: 'var(--accent)', fontSize: 11 }}>
          ← {reading ?? 'Fact Type'}
        </button>
      </div>
      <Row>
        <Label>Roles covered</Label>
        {fact.roles.map((role, ri) => {
          const ot     = otMap[role.objectTypeId]
          const nf     = !ot ? nestedMap[role.objectTypeId] : null
          const player = ot ? ot.name : nf ? (nf.objectifiedName || '(unnamed)') : null
          const checked = ifItem.roles.includes(ri)
          const isLast  = checked && ifItem.roles.length === 1
          return (
            <Checkbox
              key={ri}
              label={`Role ${ri + 1}${player ? ` · ${player}` : ''}`}
              checked={checked}
              disabled={isImplicit || isLast}
              onChange={() => toggleRole(ri)}
            />
          )
        })}
      </Row>
      <Row>
        <Label>Frequency Range</Label>
        <ValueRangeEditor
          positiveIntegers
          range={ifItem.range}
          onChange={vr => store.updateInternalFrequency(fact.id, ifItem.id, { range: vr })}
        />
      </Row>
      {!isImplicit && (
        <Row>
          <Label>Modality</Label>
          <DeonticCheckbox checked={!!ifItem.deontic}
            onChange={v => store.updateInternalFrequency(fact.id, ifItem.id, { deontic: v })}/>
        </Row>
      )}
      {!isImplicit && (
        <div style={{ marginTop: 8 }}>
          <Label>Usage</Label>
          <DangerBtn onClick={() => { store.removeInternalFrequency(fact.id, ifItem.id); store.select(fact.id, 'fact') }}>
            Delete Frequency Range
          </DangerBtn>
        </div>
      )}
    </div>
  )
}

function typeKindFromAssignment(a) {
  return datatypeAssignmentToKind(a)
}

// ── Shared helper: resolve a value/cardinality range selection to display info ─
function useRangeSelectionInfo(sel) {
  const store = useOrmStoreIgnoring('pan', 'zoom')
  if (!sel) return null
  if (sel.otId) {
    const ot = store.objectTypes.find(o => o.id === sel.otId)
    if (!ot) return null
    return {
      label: ot.name,
      backLabel: ot.name,
      onBack: () => store.select(ot.id, ot.kind),
      valueRange:      ot.valueRange,
      cardinalityRange: ot.cardinalityRange,
      valueRangeDeontic:       !!ot.valueRangeDeontic,
      cardinalityRangeDeontic: !!ot.cardinalityRangeDeontic,
      onPatch:                 patch => store.updateObjectType(ot.id, patch),
      valueTypeKind:   typeKindFromAssignment(ot.datatypeAssignment),
      onChangeValueRange:      vr => store.updateObjectType(ot.id, { valueRange: vr }),
      onChangeCardinalityRange: vr => store.updateObjectType(ot.id, { cardinalityRange: vr }),
      onDeleteValueRange:      () => { store.removeValueRange(sel); store.select(ot.id, ot.kind) },
      onDeleteCardinalityRange: () => { store.removeCardinalityRange(sel); store.select(ot.id, ot.kind) },
    }
  }
  if (sel.factId != null) {
    const f = store.facts.find(f => f.id === sel.factId)
    if (!f) return null
    const role = f.roles[sel.roleIndex]
    if (!role) return null
    const reading = getDisplayReading(f) || 'Fact Type'
    const player = store.objectTypes.find(o => o.id === role.objectTypeId)
    return {
      label: `Role ${sel.roleIndex + 1} of ${reading}`,
      backLabel: `Role ${sel.roleIndex + 1}`,
      onBack: () => store.selectRole(f.id, sel.roleIndex),
      valueRange:      role.valueRange,
      cardinalityRange: role.cardinalityRange,
      valueRangeDeontic:       !!role.valueRangeDeontic,
      cardinalityRangeDeontic: !!role.cardinalityRangeDeontic,
      onPatch:                 patch => store.updateRole(f.id, sel.roleIndex, patch),
      valueTypeKind:   typeKindFromAssignment(player?.datatypeAssignment),
      onChangeValueRange:      vr => store.updateRole(f.id, sel.roleIndex, { valueRange: vr }),
      onChangeCardinalityRange: vr => store.updateRole(f.id, sel.roleIndex, { cardinalityRange: vr }),
      onDeleteValueRange:      () => { store.removeValueRange(sel); store.selectRole(f.id, sel.roleIndex) },
      onDeleteCardinalityRange: () => { store.removeCardinalityRange(sel); store.selectRole(f.id, sel.roleIndex) },
    }
  }
  if (sel.nestedFactId) {
    const f = store.facts.find(f => f.id === sel.nestedFactId)
    if (!f) return null
    const name = f.objectifiedName || '(unnamed)'
    return {
      label: name,
      backLabel: name,
      onBack: () => store.select(f.id, 'fact'),
      valueRange:      f.valueRange,
      cardinalityRange: f.cardinalityRange,
      valueRangeDeontic:       !!f.valueRangeDeontic,
      cardinalityRangeDeontic: !!f.cardinalityRangeDeontic,
      onPatch:                 patch => store.updateFact(f.id, patch),
      valueTypeKind:   typeKindFromAssignment(f.datatypeAssignment),
      onChangeValueRange:      vr => store.updateFact(f.id, { valueRange: vr }),
      onChangeCardinalityRange: vr => store.updateFact(f.id, { cardinalityRange: vr }),
      onDeleteValueRange:      () => { store.removeValueRange(sel); store.select(f.id, 'fact') },
      onDeleteCardinalityRange: () => { store.removeCardinalityRange(sel); store.select(f.id, 'fact') },
    }
  }
  return null
}

// ── Value Range inspector ─────────────────────────────────────────────────────
function ValueRangeConstraintInspector({ sel }) {
  const info = useRangeSelectionInfo(sel)
  if (!info) return null
  return (
    <div style={{ marginBottom: 18 }}>
      <InspectorTitle>Value Range</InspectorTitle>
      <div style={{ marginBottom: 10 }}>
        <button onClick={info.onBack}
          style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer',
            color: 'var(--accent)', fontSize: 11 }}>
          ← {info.backLabel}
        </button>
      </div>
      <Row>
        <Label>On</Label>
        <div style={{ fontSize: 12, color: 'var(--ink-2)' }}>{info.label}</div>
      </Row>
      <Row>
        <Label>Range specifications</Label>
        <ValueRangeEditor
          range={info.valueRange}
          onChange={info.onChangeValueRange}
          typeKind={info.valueTypeKind}
        />
      </Row>
      <Label>Modality</Label>
      <DeonticCheckbox checked={info.valueRangeDeontic}
        onChange={v => info.onPatch({ valueRangeDeontic: v })}/>
      <Label>Usage</Label>
      <DangerBtn onClick={info.onDeleteValueRange}>Delete Value Range</DangerBtn>
    </div>
  )
}

// ── Cardinality Range inspector ───────────────────────────────────────────────
function CardinalityRangeInspector({ sel }) {
  const info = useRangeSelectionInfo(sel)
  if (!info) return null
  return (
    <div style={{ marginBottom: 18 }}>
      <InspectorTitle>Cardinality Range</InspectorTitle>
      <div style={{ marginBottom: 10 }}>
        <button onClick={info.onBack}
          style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer',
            color: 'var(--accent)', fontSize: 11 }}>
          ← {info.backLabel}
        </button>
      </div>
      <Row>
        <Label>On</Label>
        <div style={{ fontSize: 12, color: 'var(--ink-2)' }}>{info.label}</div>
      </Row>
      <Row>
        <Label>Range specifications</Label>
        <ValueRangeEditor
          naturalNumbers
          range={info.cardinalityRange}
          onChange={info.onChangeCardinalityRange}
        />
      </Row>
      <Label>Modality</Label>
      <DeonticCheckbox checked={info.cardinalityRangeDeontic}
        onChange={v => info.onPatch({ cardinalityRangeDeontic: v })}/>
      <Label>Usage</Label>
      <DangerBtn onClick={info.onDeleteCardinalityRange}>Delete Cardinality Range</DangerBtn>
    </div>
  )
}

// ── Permutation generator ─────────────────────────────────────────────────────
function generatePermutations(n) {
  const result = []
  const base = Array.from({ length: n }, (_, i) => i)
  function permute(remaining, current) {
    if (remaining.length === 0) { result.push(current); return }
    for (let i = 0; i < remaining.length; i++) {
      permute(
        [...remaining.slice(0, i), ...remaining.slice(i + 1)],
        [...current, remaining[i]]
      )
    }
  }
  permute(base, [])
  return result
}

// ── Reading editor ────────────────────────────────────────────────────────────
// parts:        string[] of length arity+1
// roleOrder:    number[] of length arity — roleOrder[i] is the role index at position i
// onUpdatePart: (i, value) => void
// fallback: the parts are the base language's, shown until translated.
function ReadingEditor({ fact, store, parts, roleOrder, onUpdatePart, fallback = false }) {
  const n = fact.arity
  const otMap     = Object.fromEntries(store.objectTypes.map(o => [o.id, o]))
  const nestedMap = Object.fromEntries(store.facts.filter(f => f.objectified).map(f => [f.id, f]))
  const FONT = "'Segoe UI', Helvetica, Arial, sans-serif"

  const handleBlur = (i, val) => {
    const trimmed = val.trim()
    if (trimmed !== val) onUpdatePart(i, trimmed)
  }

  return (
    <div style={{
      display: 'flex', flexWrap: 'wrap', alignItems: 'center',
      border: '1px solid var(--border)', borderRadius: 4,
      padding: '3px 6px', background: '#fff',
      fontFamily: FONT, fontSize: 12, lineHeight: 1.8,
      cursor: 'text',
    }}>
      {parts.map((seg, i) => (
        <React.Fragment key={i}>
          {/* inline-block span sized by hidden text; input overlays it absolutely */}
          <span style={{ display: 'inline-block', position: 'relative', background: '#fef6ec', borderRadius: 2, padding: '0 4px', outline: '1px dotted var(--border)' }}>
            <span aria-hidden style={{
              visibility: 'hidden', whiteSpace: 'pre',
              fontSize: 12, fontFamily: FONT, padding: 0, margin: 0,
              display: 'block',
            }}>
              {seg || ' '}
            </span>
            <input
              value={seg}
              onChange={e => onUpdatePart(i, e.target.value)}
              onBlur={e => handleBlur(i, e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur() } }}
              style={{
                position: 'absolute', inset: 0, width: '100%', height: '100%',
                border: 'none', outline: 'none', background: 'transparent',
                WebkitAppearance: 'none', appearance: 'none',
                color: fallback ? 'var(--ink-muted)' : 'var(--ink-2)', fontSize: 12, fontFamily: FONT,
                fontStyle: fallback ? 'italic' : 'normal',
                padding: '0 4px', margin: 0, boxSizing: 'border-box',
              }}
            />
          </span>
          {i < n && (() => {
            const subscriptNums = ['₀','₁','₂','₃','₄','₅','₆','₇','₈','₉']
            const nameOccurrences = new Map()
            const defaultOrder = Array.from({ length: n }, (_, k) => k)
            for (const ri of defaultOrder) {
              const oid = fact.roles?.[ri]?.objectTypeId
              const ot  = otMap[oid]
              const nf  = nestedMap[oid]
              const name = ot?.name ?? nf?.objectifiedName ?? '?'
              const prev = nameOccurrences.get(name) ?? []
              prev.push({ ri, idx: prev.length })
              nameOccurrences.set(name, prev)
            }
            const oid = fact.roles[roleOrder[i]]?.objectTypeId
            const ot  = otMap[oid]
            const nf  = nestedMap[oid]
            const name  = ot?.name ?? nf?.objectifiedName ?? '?'
            const isValue = ot?.kind === 'value'
            const color = isValue ? 'var(--col-value)' : 'var(--col-entity)'
            let displayName = name
            const occ = nameOccurrences.get(name)
            if (occ && occ.length > 1) {
              const occIdx = occ.find(o => o.ri === roleOrder[i])?.idx ?? 0
              const subscript = occIdx + 1 < 10 ? subscriptNums[occIdx + 1] : `(${occIdx + 1})`
              displayName = `${name}${subscript}`
            }
            return (
              <span style={{
                color, fontSize: 12, fontFamily: FONT, fontWeight: 700,
                userSelect: 'none', whiteSpace: 'nowrap',
                paddingLeft: '0.35em', paddingRight: '0.35em',
              }}>
                {displayName}
              </span>
            )
          })()}
        </React.Fragment>
      ))}
    </div>
  )
}

// ── Lexicon: word and reading forms in the view language ──────────────────────
// The name and readings themselves are in the view language already (see
// src/store/viewLanguage.js); these sections edit what the language adds to
// them, in lexicon[viewLanguage]. See src/verbalisation/lexicon.js for the
// format. Empty fields are left out, so the verbalisation derives them (the
// placeholders show what it derives).

const lexWithout = (lexicon, lang, entry) => {
  const clean = Object.fromEntries(Object.entries(entry).filter(([, v]) =>
    v != null && v !== '' && !(Array.isArray(v) && !v.length)))
  const next = { ...(lexicon ?? {}) }
  if (Object.keys(clean).length) next[lang] = clean
  else delete next[lang]
  return Object.keys(next).length ? next : undefined
}

// The languages of the lexicon: how a type is named in each (plural rule for
// the placeholder, genders, and for Polish the case forms) and which forms of
// a reading each adds.
const ROMANCE_GENDERS = [['m', 'masculine (default)'], ['f', 'feminine']]
const LEXICON_LANGS = [
  { id: 'en', label: 'English', pluralise: englishPlural, forms: [
    { key: 'pluralParts', label: 'Plural form', hint: 'With a plural subject: Courses are prerequisites for Course. Empty: the verb is made plural.' },
  ] },
  { id: 'nl', label: 'Dutch', pluralise: dutchPlural,
    genders: [['de', 'de (default)'], ['het', 'het']], genderHint: 'de-words take elke and die, het-words elk and dat', forms: [
      { key: 'subParts', label: 'Subordinate form', hint: 'Verb last: … dat Student Course volgt. Empty: the first verb moves to the end.' },
      { key: 'pluralParts', label: 'Plural form', hint: 'With a plural subject: Studenten volgen Course. Empty: the verb is made plural.' },
    ] },
  ...[['fr', 'French', frenchPlural, 'Étudiant suit Cours', 'Étudiants suivent Cours', 'chaque, un/une, ce/cette'],
    ['it', 'Italian', italianPlural, 'Studente frequenta Corso', 'Studenti frequentano Corso', 'un/una, quel/quella'],
    ['es', 'Spanish', spanishPlural, 'Estudiante cursa Curso', 'Estudiantes cursan Curso', 'un/una, ese/esa'],
  ].map(([id, label, pluralise, example, plural, genderHint]) => ({ id, label, pluralise, genders: ROMANCE_GENDERS, genderHint, forms: [
    { key: 'pluralParts', label: 'Plural form', hint: `With a plural subject: ${plural}. Empty: the verb is made plural.` },
  ] })),
  { id: 'pl', label: 'Polish', pluralise: polishPlural, cases: true,
    genders: [['mi', 'masc. inanimate (default)'], ['ma', 'masc. animate'], ['mp', 'masc. personal'], ['f', 'feminine'], ['n', 'neuter']],
    genderHint: 'Chooses każdy/każda/każde, ten/ta/to and the numeral forms', forms: [
      { key: 'pluralParts', label: 'Plural form', hint: 'With a plural subject: Studenci studiują Przedmiot. Empty: the verb is made plural.' },
    ] },
]
const CASE_LABELS = { nom: 'Nominative', gen: 'Genitive', dat: 'Dative', acc: 'Accusative', ins: 'Instrumental', loc: 'Locative' }
const CASE_SHORT = { gen: 'Gen.', dat: 'Dat.', acc: 'Acc.', ins: 'Ins.', loc: 'Loc.' }

// The forms of a type's name in the view language: plural and gender, and
// in Polish the other cases.
function TypeLexiconSection({ name, lexicon, onChange }) {
  const tab = useOrmStore(s => s.viewLanguage)
  const lang = LEXICON_LANGS.find(l => l.id === tab) ?? LEXICON_LANGS[0]
  const lex = lexicon ?? {}
  const entry = lex[tab] ?? {}
  const setEntry = (next) => onChange(lexWithout(lexicon, tab, next))
  const set = (key, value) => setEntry({ ...entry, [key]: value.trim() ? value : undefined })
  const setForm = (key, value) => {
    const forms = { ...(entry.forms ?? {}), [key]: value.trim() ? value : undefined }
    Object.keys(forms).forEach(k => forms[k] === undefined && delete forms[k])
    setEntry({ ...entry, forms: Object.keys(forms).length ? forms : undefined })
  }
  const plural = entry.plural?.trim() || (name ? lang.pluralise(name, entry.gender) : '')
  return (
    <Section title="Word forms">
      <Row>
        <Label>Plural</Label>
        <TInput value={entry.plural ?? ''} placeholder={name ? lang.pluralise(name, entry.gender) : ''} onChange={v => set('plural', v)}/>
      </Row>
      {lang.genders && (
        <Row>
          <Label>Gender</Label>
          <select value={entry.gender ?? ''} onChange={e => set('gender', e.target.value)} title={lang.genderHint} style={{ width: '100%' }}>
            <option value="">{lang.genders[0][1]}</option>
            {lang.genders.map(([v, label]) => <option key={v} value={v}>{label.replace(' (default)', '')}</option>)}
          </select>
        </Row>
      )}
      {lang.cases && (
        <div style={{ display: 'grid', gridTemplateColumns: 'auto minmax(0, 1fr) minmax(0, 1fr)', gap: 4, alignItems: 'center' }}
          title="Empty: the accusative follows the gender, other cases use the nominative">
          <span/><Label>Singular</Label><Label>Plural</Label>
          {['gen', 'dat', 'acc', 'ins', 'loc'].map(c => (
            <React.Fragment key={c}>
              <span style={{ fontSize: 10, color: 'var(--ink-muted)' }} title={CASE_LABELS[c]}>{CASE_SHORT[c]}</span>
              <TInput value={entry.forms?.[c] ?? ''} placeholder={name} onChange={v => setForm(c, v)}/>
              <TInput value={entry.forms?.[`${c}Pl`] ?? ''} placeholder={plural} onChange={v => setForm(`${c}Pl`, v)}/>
            </React.Fragment>
          ))}
        </div>
      )}
    </Section>
  )
}

// The forms of a fact type's readings in the view language (Dutch
// subordinate form, plural form), one per reading; in Polish with the case
// of each slot.
function FactLexiconSection({ fact, store }) {
  const tab = store.viewLanguage
  const n = fact.arity
  if (n < 1) return null
  // The readings in the view language (not the base readings shown in their
  // place), with their forms, by position in the reading list.
  const all = readingList(fact, n, tab)
  const occ = occurrences(all)
  const shown = all.map((r, i) => ({ ...r, i, nth: occ[i] }))
    .filter(r => hasReadingText(r.parts) && !isFallbackReading(fact, r.roleOrder, r.parts))
  if (!shown.length) return null
  const lang = LEXICON_LANGS.find(t => t.id === tab) ?? LEXICON_LANGS[0]
  const update = (r, key, k, val) => {
    const list = [...(r.forms?.[key] ?? Array(key === 'cases' ? n : n + 1).fill(''))]
    list[k] = val
    store.updateReadingForms(fact.id, r.i, { [key]: list.some(p => p?.trim()) ? list : undefined })
  }
  const playerName = (ri) => {
    const id = fact.roles?.[ri]?.objectTypeId
    const p = store.objectTypes.find(o => o.id === id) ?? store.facts.find(f => f.id === id)
    return p?.name || p?.objectifiedName || '?'
  }
  return (
    <Section title="Reading forms">
      {shown.map(r => {
        const order = r.roleOrder
        const forms = r.forms ?? {}
        return (
          <div key={r.i} style={{ marginBottom: 10 }}>
            {shown.length > 1 && <Label>({order.map(i => i + 1).join(', ')}){r.nth ? ` · alternative ${r.nth}` : ''}</Label>}
            {lang.forms.map(f => (
              <div key={f.key} style={{ marginBottom: 4 }} title={f.hint}>
                <div style={{ fontSize: 10, color: 'var(--ink-muted)', marginBottom: 2 }}>{f.label}</div>
                <ReadingEditor fact={fact} store={store} roleOrder={order}
                  parts={forms[f.key] ?? Array(n + 1).fill('')}
                  onUpdatePart={(i, val) => update(r, f.key, i, val)}/>
              </div>
            ))}
            {lang.cases && (
              <div title="The case each object type takes in this reading; empty: nominative for the first, accusative for the others">
                <div style={{ fontSize: 10, color: 'var(--ink-muted)', marginBottom: 2 }}>Cases</div>
                <div style={{ display: 'grid', gridTemplateColumns: 'auto minmax(0, 1fr)', gap: 4, alignItems: 'center' }}>
                  {order.map((ri, k) => (
                    <React.Fragment key={k}>
                      <span style={{ fontSize: 11 }}>{playerName(ri)}</span>
                      <select value={forms.cases?.[k] ?? ''} onChange={e => update(r, 'cases', k, e.target.value)} style={{ width: '100%' }}>
                        <option value="">{k ? 'accusative' : 'nominative'} (default)</option>
                        {Object.entries(CASE_LABELS).map(([c, label]) => <option key={c} value={c}>{label.toLowerCase()}</option>)}
                      </select>
                    </React.Fragment>
                  ))}
                </div>
              </div>
            )}
          </div>
        )
      })}
    </Section>
  )
}

// ── Reading rows ────────────────────────────────────────────────────────────
// The readings of a fact type or implied link (readingList in
// src/store/readings.js). A role order may have several readings; the first
// is preferred (shown in the diagram, tried first in verbalisation), and the
// others can be made preferred. The primary reading (roles in their own
// order, first of its order) has no remove button.
function ReadingRows({ readings, fact, store, isFallback = () => false, onUpdate, onRemove, onPrefer }) {
  const occ = occurrences(readings)
  const count = (order) => readings.filter(r => JSON.stringify(r.roleOrder) === JSON.stringify(order)).length
  const linkBtn = { background: 'none', border: 'none', cursor: 'pointer', fontSize: 11, padding: 0 }
  return readings.map((r, i) => {
    const several = count(r.roleOrder) > 1
    const label = `(${r.roleOrder.map(j => j + 1).join(', ')})` + (several ? (occ[i] ? ` · alternative ${occ[i]}` : ' · preferred') : '')
    return (
      <Row key={`${JSON.stringify(r.roleOrder)}#${occ[i]}`}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 3, gap: 8 }}>
          <Label>{label}</Label>
          <span style={{ display: 'flex', gap: 8 }}>
            {occ[i] > 0 && (
              <button onClick={() => onPrefer(i)} title="Make this the preferred reading for this role order"
                style={{ ...linkBtn, color: 'var(--accent)', whiteSpace: 'nowrap' }}>prefer</button>
            )}
            {!(r.primary && occ[i] === 0) && (
              <button onClick={() => onRemove(i)} title="Remove this reading"
                style={{ ...linkBtn, color: 'var(--danger)', fontSize: 12 }}>✕</button>
            )}
          </span>
        </div>
        <ReadingEditor
          fact={fact} store={store}
          parts={r.parts}
          roleOrder={r.roleOrder}
          fallback={isFallback(r)}
          onUpdatePart={(k, val) => {
            const parts = [...r.parts]
            parts[k] = val
            onUpdate(i, parts)
          }}
        />
      </Row>
    )
  })
}

// ── Add reading row: dropdown for ordering + inline reading editor ────────────
// Any role order can be chosen: one that has readings gets another one. A
// word ending in a hyphen ("first-") binds to the next object type, one
// starting with a hyphen ("-principal") to the previous one (NORMA hyphen
// binding, src/verbalisation/hyphenBinding.js).
function AddReadingRow({ fact, store, available, onAdd }) {
  const [selIdx, setSelIdx] = useState(0)
  const [draftParts, setDraftParts] = useState(() => Array(fact.arity + 1).fill(''))
  const arity = fact.arity
  const otMap     = Object.fromEntries(store.objectTypes.map(o => [o.id, o]))
  const nestedMap = Object.fromEntries(store.facts.filter(f => f.objectified).map(f => [f.id, f]))
  const FONT = "'Segoe UI', Helvetica, Arial, sans-serif"

  useEffect(() => {
    setDraftParts(Array(arity + 1).fill(''))
  }, [arity])

  useEffect(() => {
    if (selIdx >= available.length) setSelIdx(0)
  }, [available.length])

  const safeSelIdx = selIdx >= available.length ? 0 : selIdx
  const roleOrder = available[safeSelIdx]
  if (!roleOrder) return null

  const hasContent = draftParts.some(p => p.trim())

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && hasContent) {
      e.preventDefault()
      onAdd(roleOrder, [...draftParts])
      setDraftParts(Array(arity + 1).fill(''))
    }
  }

  const handleBlur = (i) => {
    const trimmed = draftParts[i].trim()
    if (trimmed !== draftParts[i]) {
      const next = [...draftParts]
      next[i] = trimmed
      setDraftParts(next)
    }
  }

  return (
    <div style={{ marginBottom: 8 }}>
      <div style={{ display: 'flex', gap: 4, alignItems: 'center', marginBottom: 4 }}>
        <select value={selIdx} onChange={e => setSelIdx(Number(e.target.value))}
          style={{ flex: '0 0 auto', fontSize: 11, minWidth: 60 }}>
          {available.map((p, i) => (
            <option key={i} value={i}>({p.map(j => j + 1).join(', ')})</option>
          ))}
        </select>
      </div>
      <div style={{
        display: 'flex', flexWrap: 'wrap', alignItems: 'center',
        border: '1px solid var(--border)', borderRadius: 4,
        padding: '3px 6px', background: '#fff',
        fontFamily: FONT, fontSize: 12, lineHeight: 1.8,
        cursor: 'text',
      }}>
        {draftParts.map((seg, i) => (
          <React.Fragment key={i}>
            <span style={{ display: 'inline-block', position: 'relative', background: '#fef6ec', borderRadius: 2, padding: '0 4px', outline: '1px dotted var(--border)' }}>
              <span aria-hidden style={{ visibility: 'hidden', whiteSpace: 'pre', fontSize: 12, fontFamily: FONT, display: 'block' }}>{seg || ' '}</span>
              <input value={seg}
                onChange={e => { const next = [...draftParts]; next[i] = e.target.value; setDraftParts(next) }}
                onBlur={() => handleBlur(i)}
                onKeyDown={handleKeyDown}
                style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', border: 'none', outline: 'none', background: 'transparent', WebkitAppearance: 'none', appearance: 'none', color: 'var(--ink-2)', fontSize: 12, fontFamily: FONT, padding: '0 4px', margin: 0, boxSizing: 'border-box' }}
              />
            </span>
            {i < arity && (() => {
              const subscriptNums = ['₀','₁','₂','₃','₄','₅','₆','₇','₈','₉']
              const nameOccurrences = new Map()
              const defaultOrder = Array.from({ length: arity }, (_, k) => k)
              for (const ri of defaultOrder) {
                const oid = fact.roles?.[ri]?.objectTypeId
                const ot  = otMap[oid]
                const nf  = nestedMap[oid]
                const name = ot?.name ?? nf?.objectifiedName ?? '?'
                const prev = nameOccurrences.get(name) ?? []
                prev.push({ ri, idx: prev.length })
                nameOccurrences.set(name, prev)
              }
              const oid = fact.roles?.[roleOrder[i]]?.objectTypeId
              const ot  = otMap[oid]
              const nf  = nestedMap[oid]
              const name  = ot?.name ?? nf?.objectifiedName ?? '?'
              const isValue = ot?.kind === 'value'
              const color = isValue ? 'var(--col-value)' : 'var(--col-entity)'
              let displayName = name
              const occ = nameOccurrences.get(name)
              if (occ && occ.length > 1) {
                const occIdx = occ.find(o => o.ri === roleOrder[i])?.idx ?? 0
                const subscript = occIdx + 1 < 10 ? subscriptNums[occIdx + 1] : `(${occIdx + 1})`
                displayName = `${name}${subscript}`
              }
              return (
                <span style={{ color, fontSize: 12, fontFamily: FONT, fontWeight: 700, userSelect: 'none', whiteSpace: 'nowrap', paddingLeft: '0.35em', paddingRight: '0.35em' }}>{displayName}</span>
              )
            })()}
          </React.Fragment>
        ))}
      </div>
    </div>
  )
}

// ── Fact presentation subsection ─────────────────────────────────────────────
function FactPresentationSubsection({ fact, store }) {
  const dro = fact.roleOrder || [0, 1]
  const reverseDro = [...dro].reverse()

  const hasForwardReading = fact.arity === 2 && (
    (JSON.stringify(dro) === '[0,1]' && fact.readingParts && fact.readingParts.some(p => p?.trim())) ||
    (JSON.stringify(dro) !== '[0,1]' && (fact.alternativeReadings || []).some(r => JSON.stringify(r.roleOrder) === JSON.stringify(dro) && r.parts?.some(p => p?.trim()))) ||
    (fact.alternativeReadings || []).some(r => JSON.stringify(r.roleOrder) === JSON.stringify(dro) && r.parts?.some(p => p?.trim()))
  )
  const hasReverseReading = fact.arity === 2 && (
    (JSON.stringify(reverseDro) === '[0,1]' && fact.readingParts && fact.readingParts.some(p => p?.trim())) ||
    (JSON.stringify(reverseDro) !== '[0,1]' && (fact.alternativeReadings || []).some(r => JSON.stringify(r.roleOrder) === JSON.stringify(reverseDro) && r.parts?.some(p => p?.trim())))
  )

  // Auto-set readingDisplay when only one reading is available
  useEffect(() => {
    if (fact.arity === 2) {
      const current = fact.readingDisplay || 'forward'
      if (hasForwardReading && !hasReverseReading && current !== 'forward') {
        store.updateFactLayout(fact.id, { readingDisplay: 'forward' })
      } else if (!hasForwardReading && hasReverseReading && current !== 'reverse') {
        store.updateFactLayout(fact.id, { readingDisplay: 'reverse' })
      }
    }
  }, [hasForwardReading, hasReverseReading, fact.id, fact.arity, fact.readingDisplay, store])

  const n = fact.arity
  const defaultOrder = Array.from({ length: n }, (_, i) => i)
  const permutations = n <= 4 ? getPermutations(defaultOrder) : [defaultOrder]
  const permutationLabel = (order) => `(${order.map(i => i + 1).join(', ')})`

  return (
    <Section title="Presentation">
      <Row>
        <Label>Shown Role Box Order</Label>
        <select value={JSON.stringify(dro)} style={{ width: '100%' }}
          onChange={e => {
            const newOrder = JSON.parse(e.target.value)
            store.updateFactLayout(fact.id, { roleOrder: JSON.stringify(newOrder) === JSON.stringify(defaultOrder) ? undefined : newOrder, readingOffsetAbove: null, readingOffsetBelow: null })
          }}>
          {permutations.map((perm, i) => (
            <option key={i} value={JSON.stringify(perm)}>{permutationLabel(perm)}</option>
          ))}
        </select>
      </Row>
      {fact.arity === 2 && (
        <Row>
          <Label>Shown Reading</Label>
          {[
            { value: 'forward', label: 'Forward only' },
            { value: 'both',    label: 'Forward / Reverse' },
            { value: 'reverse', label: '◂  Reverse only' },
          ].map(opt => {
            const disabled =
              (opt.value === 'forward' && !hasForwardReading) ||
              (opt.value === 'both' && (!hasForwardReading || !hasReverseReading)) ||
              (opt.value === 'reverse' && !hasReverseReading)
            const isCurrent = (fact.readingDisplay || 'forward') === opt.value
            return (
              <label key={opt.value} style={{
                display: 'flex', alignItems: 'center', gap: 6,
                fontSize: 12, cursor: disabled ? 'not-allowed' : 'pointer', marginBottom: 3,
                color: disabled ? 'var(--ink-muted)' : 'var(--ink-2)',
              }}>
                <input type="radio"
                  name={`rdisplay-${fact.id}`}
                  value={opt.value}
                  checked={isCurrent}
                  disabled={disabled}
                  onChange={() => store.updateFactLayout(fact.id, { readingDisplay: opt.value })}
                  style={{ width: 'auto', padding: 0, border: 'none', accentColor: 'var(--accent)', cursor: disabled ? 'not-allowed' : 'pointer' }}
                />
                {opt.label}
              </label>
            )
          })}
        </Row>
      )}
      {fact.arity > 2 && (() => {
        const defaultOrder = Array.from({ length: fact.arity }, (_, i) => i)
        const ro = fact.readingOrder || defaultOrder
        const readings = []
        if (fact.readingParts != null) {
          const n = fact.arity
          readings.push({ label: `(1, 2, ..., ${n}) — natural`, roleOrder: defaultOrder, has: true })
        }
        for (const alt of preferredReadings(fact.alternativeReadings || [])) {
          if (alt.parts?.some(p => p?.trim())) {
            readings.push({
              label: `(${alt.roleOrder.map(i => i + 1).join(', ')})`,
              roleOrder: alt.roleOrder,
              has: true,
            })
          }
        }
        if (readings.length === 0) return null
        const currentKey = JSON.stringify(ro)
        return (
          <Row>
            <Label>Shown Reading</Label>
            <select value={currentKey} style={{ width: '100%' }}
              onChange={e => store.updateFactLayout(fact.id, { readingOrder: e.target.value ? JSON.parse(e.target.value) : undefined })}>
              {readings.map((r, i) => (
                <option key={i} value={JSON.stringify(r.roleOrder)}>{r.label}</option>
              ))}
            </select>
          </Row>
        )
      })()}
      <Row>
        <Label>Orientation</Label>
        {['horizontal', 'vertical'].map(val => (
          <label key={val} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, marginBottom: 3, cursor: 'pointer', color: 'var(--ink-2)' }}>
            <input type="radio"
              name={`orient-${fact.id}`}
              value={val}
              checked={fact.orientation === val}
              onChange={() => {
                const patch = { orientation: val }
                if (val === 'vertical' && fact.nestedReading) patch.nestedReading = false
                store.updateFactLayout(fact.id, patch)
              }}
              style={{ width: 'auto', padding: 0, border: 'none', accentColor: 'var(--accent)', cursor: 'pointer' }}
            />
            {val.charAt(0).toUpperCase() + val.slice(1)}
          </label>
        ))}
      </Row>
      <Row>
        <Label>Reading Position</Label>
        {fact.objectified && (
          <Checkbox
            label="Nested Reading"
            checked={!!fact.nestedReading}
            disabled={fact.orientation === 'vertical'}
            onChange={v => {
              const patch = { nestedReading: v }
              if (!v && fact.readingAbove) { patch.readingAbove = false; patch.readingOffsetAbove = null; patch.readingOffsetBelow = null }
              store.updateFactLayout(fact.id, patch)
            }}
          />
        )}
      </Row>
      {(() => {
        const isVert = fact.orientation === 'vertical'
        const storedOff = fact.readingAbove ? fact.readingOffsetAbove : fact.readingOffsetBelow
        const posValue  = storedOff !== null ? 'free' : fact.readingAbove ? 'above' : 'below'

        // Horizontal non-nested objectified fact: "Above" requires Nested Reading to be
        // enabled, so show it greyed out. "Free" reflects a user-dragged position.
        if (fact.objectified && !isVert && !fact.nestedReading) {
          const horizValue = storedOff !== null ? 'free' : 'below'
          const horizOpts  = [
            { value: 'above', label: 'Above', disabled: true },
            { value: 'below', label: 'Below', disabled: false },
            { value: 'free',  label: 'Free',  disabled: true },
          ]
          return (
            <Row>
              {horizOpts.map(opt => (
                <label key={opt.value} style={{
                  display: 'flex', alignItems: 'center', gap: 6,
                  fontSize: 12, marginBottom: 3,
                  cursor: opt.disabled ? 'not-allowed' : 'pointer',
                  color: opt.disabled ? 'var(--ink-muted)' : 'var(--ink-2)',
                }}>
                  <input type="radio"
                    name={`rpos-${fact.id}`}
                    value={opt.value}
                    checked={horizValue === opt.value}
                    disabled={opt.disabled}
                    onChange={() => store.updateFactLayout(fact.id, {
                      readingAbove: false,
                      readingOffsetAbove: null,
                      readingOffsetBelow: null,
                    })}
                    style={{ width: 'auto', padding: 0, border: 'none', accentColor: 'var(--accent)', cursor: opt.disabled ? 'not-allowed' : 'pointer' }}
                  />
                  {opt.label}
                </label>
              ))}
            </Row>
          )
        }

        const opts = [
          { value: 'above', label: isVert ? 'Right' : 'Above' },
          { value: 'below', label: isVert ? 'Left'  : 'Below' },
          { value: 'free',  label: 'Free' },
        ]
        return (
          <Row>
            {opts.map(opt => (
              <label key={opt.value} style={{
                display: 'flex', alignItems: 'center', gap: 6,
                fontSize: 12, marginBottom: 3,
                cursor: opt.value === 'free' ? 'not-allowed' : 'pointer',
                color: 'var(--ink-2)',
              }}>
                <input type="radio"
                  name={`rpos-${fact.id}`}
                  value={opt.value}
                  checked={posValue === opt.value}
                  disabled={opt.value === 'free'}
                  onChange={() => store.updateFactLayout(fact.id, {
                    readingAbove: opt.value === 'above',
                    readingOffsetAbove: null,
                    readingOffsetBelow: null,
                  })}
                  style={{ width: 'auto', padding: 0, border: 'none', accentColor: 'var(--accent)', cursor: opt.value === 'free' ? 'not-allowed' : 'pointer' }}
                />
                {opt.label}
              </label>
            ))}
          </Row>
        )
      })()}
       <Row>
         <Label>Uniqueness Bar Position</Label>
       </Row>
       <Row>
         {(fact.orientation === 'vertical'
           ? [{ label: 'Right', val: false }, { label: 'Left', val: true }]
           : [{ label: 'Above', val: false }, { label: 'Below', val: true }]
         ).map(opt => (
           <label key={opt.label} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, marginBottom: 3, cursor: 'pointer', color: 'var(--ink-2)' }}>
             <input type="radio"
               name={`upos-${fact.id}`}
               value={String(opt.val)}
               checked={!!fact.uniquenessBelow === opt.val}
               onChange={() => store.updateFactLayout(fact.id, { uniquenessBelow: opt.val })}
               style={{ width: 'auto', padding: 0, border: 'none', accentColor: 'var(--accent)', cursor: 'pointer' }}
             />
             {opt.label}
           </label>
         ))}
       </Row>
     </Section>
  )
}

function getPermutations(arr) {
  if (arr.length <= 1) return [arr]
  const result = []
  for (let i = 0; i < arr.length; i++) {
    const rest = arr.slice(0, i).concat(arr.slice(i + 1))
    for (const perm of getPermutations(rest)) {
      result.push([arr[i], ...perm])
    }
  }
  return result
}

// ── Fact constraints subsection ───────────────────────────────────────────────
function FactConstraintsSubsection({ fact, store }) {
  return (
    <Section title="Constraints">
      <Label>Uniqueness</Label>
      {fact.uniqueness.length === 0 && (
        <div style={{ color: 'var(--ink-muted)', fontSize: 11, marginBottom: 8 }}>None defined</div>
      )}
      {fact.uniqueness.map((u, ui) => {
        const uKey = JSON.stringify([...u].sort())
        const isPreferred = (fact.preferredUniqueness || []).some(pu =>
          JSON.stringify([...pu].sort()) === uKey
        )
        const canBePreferred = u.length === fact.arity - 1
        return (
          <div key={ui}
            onClick={() => store.selectUniqueness(fact.id, ui)}
            style={{ display: 'flex', alignItems: 'center', gap: 5,
              fontSize: 12, color: 'var(--ink-2)', marginBottom: 4,
              cursor: 'pointer', padding: '3px 8px',
              background: 'var(--bg-raised)', border: '1px solid var(--border-soft)',
              borderRadius: 3 }}>
            <span style={{ flex: 1 }}>Roles: {[...u].sort((a, b) => a - b).map(i => i + 1).join(', ')}</span>
            {isPreferred && <span title="Preferred Identifier"
              style={{ color: 'var(--col-mandatory)', fontSize: 11, flexShrink: 0 }}>★</span>}
            <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--accent)', flexShrink: 0, lineHeight: 1 }}>→</span>
          </div>
        )
      })}
      {fact.arity > 1 && (
        <button onClick={() => store.addUniquenessBar(fact.id)}
          style={{ marginTop: 2, marginBottom: 10, padding: '4px 10px', fontSize: 11,
            background: 'var(--bg-raised)', border: '1px solid var(--border)',
            borderRadius: 3, color: 'var(--ink-2)', cursor: 'pointer' }}>
          + Uniqueness Constraint
        </button>
      )}

      {fact.objectified && fact.objectifiedRefMode && fact.objectifiedRefMode !== 'none' && (
        <Row>
          <Label>Value Range</Label>
          <RangeChip range={fact.valueRange}
            onClick={() => store.selectValueRange({ nestedFactId: fact.id })} />
        </Row>
      )}

      {fact.objectified && (
        <Row>
          <Label>Cardinality Range</Label>
          <RangeChip range={fact.cardinalityRange} format={formatCardinalityRange}
            onClick={() => store.selectCardinalityRange({ nestedFactId: fact.id })} />
        </Row>
      )}

      <Label>Frequency</Label>
      {(fact.internalFrequency || []).length === 0 && (
        <div style={{ color: 'var(--ink-muted)', fontSize: 11, marginBottom: 8 }}>None defined</div>
      )}
      {(fact.internalFrequency || []).map((ifItem) => {
        const rangeText = formatFrequencyRange(ifItem.range)
        return (
          <div key={ifItem.id}
            onClick={() => store.selectInternalFrequency(fact.id, ifItem.id)}
            style={{ display: 'flex', alignItems: 'center', gap: 5,
              fontSize: 12, color: 'var(--ink-2)', marginBottom: 4,
              cursor: 'pointer', padding: '3px 8px',
              background: 'var(--bg-raised)', border: '1px solid var(--border-soft)',
              borderRadius: 3 }}>
            <span style={{ flex: 1 }}>
              Roles: {[...ifItem.roles].sort((a, b) => a - b).map(i => i + 1).join(', ')}
              {rangeText && <span style={{ color: 'var(--ink-muted)', marginLeft: 6 }}>Freq: {rangeText}</span>}
            </span>
            <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--accent)', flexShrink: 0, lineHeight: 1 }}>→</span>
          </div>
        )
      })}
      {fact.arity > 1 && (
        <button onClick={() => store.addInternalFrequencyBar(fact.id)}
          style={{ marginTop: 2, marginBottom: 10, padding: '4px 10px', fontSize: 11,
            background: 'var(--bg-raised)', border: '1px solid var(--border)',
            borderRadius: 3, color: 'var(--ink-2)', cursor: 'pointer' }}>
          + Frequency Constraint
        </button>
      )}
    </Section>
  )
}

// ── Fact type inspector ───────────────────────────────────────────────────────
function FactInspector({ fact }) {
  const store = useOrmStoreIgnoring('pan', 'zoom')

  // Shared: arity + readings + display options
  const factTypeSection = (
    <div style={{ marginBottom: 18 }}>
      {!fact.objectified && <InspectorTitle>Fact Type ({fact.arity}-ary)</InspectorTitle>}
      {!fact.objectified && <ValidationErrorStrip elementId={fact.id} store={store}/>}
      {/* Arity control — hidden for nested entity types (rendered above Properties instead) */}
      {!fact.objectified && <Row>
        <Label>Arity</Label>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <button
            onClick={() => store.setFactArity(fact.id, fact.arity - 1)}
            disabled={fact.arity <= 1}
            title="Remove last role"
            style={{
              width: 28, height: 28, fontSize: 16, lineHeight: 1,
              background: 'var(--bg-raised)', border: '1px solid var(--border)',
              borderRadius: 4, cursor: fact.arity <= 1 ? 'not-allowed' : 'pointer',
              color: fact.arity <= 1 ? 'var(--ink-muted)' : 'var(--ink-2)',
              fontFamily: 'var(--font-mono)',
            }}>−</button>
          <span style={{
            minWidth: 32, textAlign: 'center', fontSize: 15, fontWeight: 600,
            color: 'var(--ink)', fontFamily: 'var(--font-mono)',
          }}>{fact.arity}</span>
          <button
            onClick={() => store.setFactArity(fact.id, fact.arity + 1)}
            title="Add a role"
            style={{
              width: 28, height: 28, fontSize: 16, lineHeight: 1,
              background: 'var(--bg-raised)', border: '1px solid var(--border)',
              borderRadius: 4, cursor: 'pointer',
              color: 'var(--ink-2)', fontFamily: 'var(--font-mono)',
            }}>+</button>
          <span style={{ fontSize: 10, color: 'var(--ink-muted)', marginLeft: 4 }}>
            {fact.arity === 1 ? 'unary' : fact.arity === 2 ? 'binary'
              : fact.arity === 3 ? 'ternary' : fact.arity === 4 ? 'quaternary'
              : `${fact.arity}-ary`}
          </span>
        </div>
        {fact.arity > fact.roles.length && (
          <div style={{ fontSize: 10, color: 'var(--danger)', marginTop: 4 }}>
            Roles trimmed — reassign object types as needed
          </div>
        )}
      </Row>}

      {/* Readings */}
      {(() => {
        const arity = fact.arity
        if (arity < 1) return null
        const allPerms = generatePermutations(arity)
        const readings = readingList(fact, arity, store.viewLanguage)
        return (
          <Section title="Readings">
            <ReadingRows readings={readings} fact={fact} store={store}
              isFallback={r => isFallbackReading(fact, r.roleOrder, r.parts)}
              onUpdate={(i, parts) => store.updateReading(fact.id, i, parts)}
              onRemove={i => store.removeReading(fact.id, i)}
              onPrefer={i => store.preferReading(fact.id, i)}/>
            <AddReadingRow fact={fact} store={store} available={allPerms}
              onAdd={(roleOrder, parts) => store.addReading(fact.id, roleOrder, parts)}/>
          </Section>
        )
      })()}

      <FactLexiconSection fact={fact} store={store} />

      {/* Roles */}
      <Section title="Roles">
        <CompactRoleList fact={fact} store={store} />
      </Section>

      {fact.objectified && (
        <Section title="Properties">
          <Checkbox label="Is personal"
            checked={!!fact.isPersonal}
            onChange={v => store.updateFact(fact.id, { isPersonal: v })}/>
          <Checkbox label="Is independent"
            checked={!!fact.isIndependent}
            onChange={v => store.updateFact(fact.id, { isIndependent: v })}/>
        </Section>
      )}
      {fact.objectified && (
        <TypeLexiconSection name={fact.objectifiedName || ''} lexicon={fact.lexicon}
          onChange={lexicon => store.updateFact(fact.id, { lexicon })}/>
      )}

      {!fact.objectified && <FactDerivationSection fact={fact} store={store}/>}

      <FactPresentationSubsection fact={fact} store={store} />
      <FactConstraintsSubsection fact={fact} store={store} />

      <DocumentationSection el={fact} onChange={patch => store.updateFact(fact.id, patch)}/>
      <PropertiesSection el={fact} kind="fact" onChange={patch => store.updateFact(fact.id, patch)}/>
      <GroupMembershipSection id={fact.id}/>

      <Section title="Usage">
        <DiagramList elementId={fact.id} kind="fact" />
      </Section>
      <DangerBtn onClick={() => store.deleteFact(fact.id)}>
        {fact.objectified ? 'Delete Nested Entity Type' : 'Delete Fact Type'}
      </DangerBtn>
    </div>
  )

  return (
    <>
      {fact.objectified ? (
        <>
          {/* Object-type identity */}
          <div style={{ marginBottom: 18 }}>
            <InspectorTitle>Nested Entity Type</InspectorTitle>
            <ValidationErrorStrip elementId={fact.id} store={store}/>
            <Row>
              <Label>Entity Name</Label>
              <TInput value={fact.objectifiedName || ''} placeholder="Name"
                onChange={v => store.updateFact(fact.id, { objectifiedName: v })}/>
            </Row>
            <Row>
              <Label>Reference Mode</Label>
              <TInput value={fact.objectifiedRefMode || ''} placeholder="id / name / none"
                onChange={v => store.setNestedRefModeLabel(fact.id, v)}/>
            </Row>
            {fact.objectifiedRefMode && fact.objectifiedRefMode !== 'none' && (
              <DatatypeField
                assignment={fact.datatypeAssignment}
                onSet={a => store.updateFact(fact.id, { datatypeAssignment: a })}
              />
            )}
            <RefModeExpandCollapseButtons factId={fact.id} occurrenceId={fact.occurrenceId} store={store}/>
            <Row>
              <Label>Arity</Label>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <button
                  onClick={() => store.setFactArity(fact.id, fact.arity - 1)}
                  disabled={fact.arity <= 1}
                  title="Remove last role"
                  style={{
                    width: 28, height: 28, fontSize: 16, lineHeight: 1,
                    background: 'var(--bg-raised)', border: '1px solid var(--border)',
                    borderRadius: 4, cursor: fact.arity <= 1 ? 'not-allowed' : 'pointer',
                    color: fact.arity <= 1 ? 'var(--ink-muted)' : 'var(--ink-2)',
                    fontFamily: 'var(--font-mono)',
                  }}>−</button>
                <span style={{
                  minWidth: 32, textAlign: 'center', fontSize: 15, fontWeight: 600,
                  color: 'var(--ink)', fontFamily: 'var(--font-mono)',
                }}>{fact.arity}</span>
                <button
                  onClick={() => store.setFactArity(fact.id, fact.arity + 1)}
                  title="Add a role"
                  style={{
                    width: 28, height: 28, fontSize: 16, lineHeight: 1,
                    background: 'var(--bg-raised)', border: '1px solid var(--border)',
                    borderRadius: 4, cursor: 'pointer',
                    color: 'var(--ink-2)', fontFamily: 'var(--font-mono)',
                  }}>+</button>
                <span style={{ fontSize: 10, color: 'var(--ink-muted)', marginLeft: 4 }}>
                  {fact.arity === 1 ? 'unary' : fact.arity === 2 ? 'binary'
                    : fact.arity === 3 ? 'ternary' : fact.arity === 4 ? 'quaternary'
                    : `${fact.arity}-ary`}
                </span>
              </div>
              {fact.arity > fact.roles.length && (
                <div style={{ fontSize: 10, color: 'var(--danger)', marginTop: 4 }}>
                  Roles trimmed — reassign object types as needed
                </div>
              )}
            </Row>
          </div>

          {/* Fact-type structure */}
          {factTypeSection}
        </>
      ) : factTypeSection}

    </>
  )
}

// ── Implicit link role inspector ──────────────────────────────────────────────
function ImplicitLinkRoleInspector({ parentFact, roleIndex, ilRoleIndex }) {
  const store = useOrmStoreIgnoring('pan', 'zoom')
  const ilRaw = parentFact.implicitLinks?.find(l => l.roleIndex === roleIndex)

  const ilKey = `${parentFact.id}:il:${roleIndex}`
  const ilPos = store.diagrams?.find(d => d.id === store.activeDiagramId)?.implicitLinkPositions?.[ilKey] ?? {}
  const il = ilRaw ? { ...ilRaw, ...ilPos } : null

  React.useEffect(() => {
    if (!il && parentFact.objectified) {
      store.updateImplicitLink(parentFact.id, roleIndex, { roleIndex, x: null, y: null, readingParts: ['', 'involves', ''], alternativeReadings: [{ roleOrder: [1, 0], parts: ['', 'is involved in', ''] }], readingDisplay: 'forward', orientation: 'horizontal', readingOffsetAbove: null, readingOffsetBelow: null, readingAbove: false, uniquenessBelow: false, roleNames: [null, null] })
    }
  }, [il, parentFact.id, parentFact.objectified, roleIndex, store])

  if (!il) return <div style={{ marginBottom: 18 }}><InspectorTitle>Role</InspectorTitle><div style={{ fontSize: 12, color: 'var(--ink-muted)' }}>No implicit link data available.</div></div>
  const otMap = Object.fromEntries(store.objectTypes.map(o => [o.id, o]))
  const nestedMap = Object.fromEntries(store.facts.filter(f => f.objectified).map(f => [f.id, f]))

  const srcIdx = ilRoleIndex

  const roleItems = [
    { objectTypeId: parentFact.id, roleName: (il.roleNames || [null, null])[0] },
    { objectTypeId: parentFact.roles[roleIndex]?.objectTypeId, roleName: (il.roleNames || [null, null])[1] },
  ]
  const role = roleItems[srcIdx]

  const ot = otMap[role.objectTypeId]
  const nf = !ot ? nestedMap[role.objectTypeId] : null
  const playerName = ot ? ot.name : nf ? nf.objectifiedName : '(unnamed)'

  // Constraints inherited from the parent fact (only for role 0 of the implicit link)
  const parentRoleIndex = srcIdx === 0 ? roleIndex : null
  const parentRole = parentRoleIndex != null ? parentFact.roles[parentRoleIndex] : null
  const parentUniqueness = parentFact.uniqueness || []
  const parentFrequency = parentFact.internalFrequency || []

  return (
    <div style={{ marginBottom: 18 }}>
      <InspectorTitle>Role {ilRoleIndex + 1}</InspectorTitle>
      <div style={{ marginBottom: 10 }}>
        <button
          onClick={() => store.selectImplicitLink(parentFact.id, roleIndex)}
          style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer',
            color: 'var(--accent)', fontSize: 11 }}>
          ← Implicit Link
        </button>
      </div>
      <Row>
        <Label>Object Type</Label>
        <div style={{ fontSize: 12, color: 'var(--ink)', padding: '4px 8px',
          background: 'var(--bg-raised)', border: '1px solid var(--border-soft)', borderRadius: 4 }}>
          {playerName}
          {nf && <span style={{ fontSize: 10, color: 'var(--ink-muted)', marginLeft: 3 }}>(nested)</span>}
        </div>
      </Row>
      <Row>
        <Label>Role Name</Label>
        <TInput value={role.roleName || ''} placeholder="optional"
          onChange={v => {
            const roleNames = [...(il.roleNames || [null, null])]
            roleNames[srcIdx] = v || null
            store.updateImplicitLink(parentFact.id, roleIndex, { roleNames })
          }}/>
      </Row>

      <Section title="Constraints">
        <Label>Participation</Label>
        <div style={{ fontSize: 12, color: 'var(--ink-2)', padding: '4px 8px',
          background: 'var(--bg-raised)', border: '1px solid var(--border-soft)', borderRadius: 4 }}>
          {srcIdx === 0 ? 'Mandatory (default)' : parentFact.roles[roleIndex]?.mandatory ? 'Mandatory (propagated)' : 'Optional'}
        </div>

        {parentRole && parentUniqueness.length > 0 && parentUniqueness.some(u => u.includes(parentRoleIndex)) && (
          <>
            <Label style={{ marginTop: 8 }}>Parent Fact Uniqueness</Label>
            {parentUniqueness.map((uRoles, ui) => {
              if (!uRoles.includes(parentRoleIndex)) return null
              const key = JSON.stringify([...uRoles].sort((a, b) => a - b))
              const isPreferred = (parentFact.preferredUniqueness || []).some(pu =>
                JSON.stringify([...pu].sort((a, b) => a - b)) === key
              )
              const canBePreferred = uRoles.length === parentFact.arity - 1
              let identifiesVt = false
              if (canBePreferred) {
                const covered = new Set(uRoles)
                const uncoveredRi = parentFact.roles.findIndex((_, ri) => !covered.has(ri))
                const uncoveredOtId = uncoveredRi >= 0 ? parentFact.roles[uncoveredRi]?.objectTypeId : null
                const uncoveredOt = uncoveredOtId ? store.objectTypes.find(o => o.id === uncoveredOtId) : null
                if (uncoveredOt?.kind === 'value') identifiesVt = true
              }
              const piDisabled = !canBePreferred || identifiesVt
              const formatRoles = (roles) => roles.map(r => `role ${r + 1}`).join(', ')
              return (
                <div key={ui} style={{ display: 'flex', alignItems: 'center', gap: 4, marginTop: 4 }}>
                  <span style={{ fontSize: 11, color: 'var(--ink-2)', flex: 1 }}>
                    {formatRoles(uRoles)}
                  </span>
                  <label title={identifiesVt ? 'A value type cannot have a preferred identifier' : undefined}
                    style={{ display: 'flex', alignItems: 'center', gap: 3, fontSize: 10,
                      color: piDisabled ? 'var(--ink-muted)' : 'var(--ink-muted)',
                      cursor: piDisabled ? 'not-allowed' : 'pointer',
                      opacity: piDisabled ? 0.5 : 1 }}>
                    <input type="checkbox"
                      checked={isPreferred}
                      disabled={piDisabled}
                      onChange={() => !piDisabled && store.togglePreferredUniqueness(parentFact.id, ui)}
                      style={{ accentColor: 'var(--accent)', cursor: piDisabled ? 'not-allowed' : 'pointer' }}
                    />
                    Preferred
                  </label>
                </div>
              )
            })}
          </>
        )}

        {parentRole && parentFrequency.length > 0 && parentFrequency.some(ifItem => ifItem.roles.includes(parentRoleIndex)) && (
          <>
            <Label style={{ marginTop: 8 }}>Parent Fact Frequency</Label>
            {parentFrequency.map(ifItem => {
              if (!ifItem.roles.includes(parentRoleIndex)) return null
              const range = ifItem.range
              const rangeText = range ? `${range.min === range.max ? range.min : `${range.min}..${range.max ?? '∞'}`}` : ''
              return (
                <div key={ifItem.id} style={{ fontSize: 11, color: 'var(--ink-2)', marginTop: 2 }}>
                  {rangeText || '(unbounded)'}
                </div>
              )
            })}
          </>
        )}
      </Section>
    </div>
  )
}

// ── Compact implicit link role list ──────────────────────────────────────────
function CompactImplicitLinkRoleList({ parentFact, roleIndex }) {
  const store = useOrmStoreIgnoring('pan', 'zoom')
  const otMap = Object.fromEntries(store.objectTypes.map(o => [o.id, o]))
  const nestedMap = Object.fromEntries(store.facts.filter(f => f.objectified).map(f => [f.id, f]))

  const il = parentFact.implicitLinks?.find(l => l.roleIndex === roleIndex)

  const roleItems = [
    { objectTypeId: parentFact.id, roleName: (il?.roleNames || [null, null])[0] },
    { objectTypeId: parentFact.roles[roleIndex]?.objectTypeId, roleName: (il?.roleNames || [null, null])[1] },
  ]

  return (
    <div>
      {[0, 1].map((ri) => {
        const srcIdx = ri
        const role = roleItems[srcIdx]
        const ot = otMap[role.objectTypeId]
        const nf = !ot ? nestedMap[role.objectTypeId] : null
        const player = ot ? ot.name : nf ? nf.objectifiedName : null
        return (
          <div
            key={ri}
            onClick={() => store.selectImplicitLinkRole(parentFact.id, roleIndex, ri)}
            style={{
              display: 'flex', alignItems: 'center', gap: 6,
              background: 'var(--bg-raised)',
              border: '1px solid var(--border-soft)',
              borderRadius: 4, padding: '5px 8px', marginBottom: 5,
              cursor: 'pointer', userSelect: 'none',
            }}
          >
            <span style={{ fontSize: 10, color: 'var(--ink-muted)', textTransform: 'uppercase',
              letterSpacing: '0.07em', flexShrink: 0, minWidth: 42 }}>
              Role {ri + 1}
            </span>
            <span style={{ fontSize: 12, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              color: player ? 'var(--ink)' : 'var(--ink-muted)',
              fontStyle: player ? 'normal' : 'italic' }}>
              {player ?? '—'}
              {nf && <span style={{ fontSize: 10, color: 'var(--ink-muted)', marginLeft: 3 }}>(nested)</span>}
            </span>
            {role.roleName && (
              <span style={{ fontSize: 10, color: 'var(--ink-muted)', flexShrink: 0,
                fontStyle: 'italic', maxWidth: 60, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {role.roleName}
              </span>
            )}
            {(srcIdx === 0 || parentFact.roles[roleIndex]?.mandatory) && (
              <span title="Mandatory" style={{ color: 'var(--col-constraint)', fontSize: 11, flexShrink: 0 }}>●</span>
            )}
          </div>
        )
      })}
    </div>
  )
}

// ── Implicit link inspector ───────────────────────────────────────────────────
function ImplicitLinkInspector({ parentFact, roleIndex }) {
  const store = useOrmStoreIgnoring('pan', 'zoom')
  const il = parentFact.implicitLinks?.find(l => l.roleIndex === roleIndex)

  const ilKey = `${parentFact.id}:il:${roleIndex}`
  const ilPos = store.diagrams?.find(d => d.id === store.activeDiagramId)?.implicitLinkPositions?.[ilKey] ?? {}
  const mergedIl = il ? { ...il, ...ilPos } : null

  // Auto-create missing implicit link entry on mount (e.g. from old files)
  React.useEffect(() => {
    if (!mergedIl && parentFact.objectified) {
      store.updateImplicitLink(parentFact.id, roleIndex, { roleIndex, x: null, y: null, readingParts: ['', 'involves', ''], alternativeReadings: [{ roleOrder: [1, 0], parts: ['', 'is involved in', ''] }], readingDisplay: 'forward', orientation: 'horizontal', readingOffsetAbove: null, readingOffsetBelow: null, readingAbove: false, uniquenessBelow: false, roleNames: [null, null] })
    }
  }, [mergedIl, parentFact.id, parentFact.objectified, roleIndex, store])

  if (!mergedIl) return <div style={{ marginBottom: 18 }}><InspectorTitle>Implicit Link</InspectorTitle><div style={{ fontSize: 12, color: 'var(--ink-muted)' }}>No implicit link data available.</div></div>
  const role = parentFact.roles[roleIndex]
  const otMap = Object.fromEntries(store.objectTypes.map(o => [o.id, o]))
  const ot = otMap[role.objectTypeId]
  const nestedName = parentFact.objectifiedName || '(unnamed)'
  const playerName = ot?.name ?? '?'

  // Auto-set readingDisplay when only one reading is available
  const ilDro = mergedIl.roleOrder || [0, 1]
  const ilReverseDro = [...ilDro].reverse()
  const ilHasForward = (JSON.stringify(ilDro) === '[0,1]' && mergedIl.readingParts && mergedIl.readingParts.some(p => p?.trim())) ||
    (JSON.stringify(ilDro) !== '[0,1]' && (mergedIl.alternativeReadings || []).some(r => JSON.stringify(r.roleOrder) === JSON.stringify(ilDro) && r.parts?.some(p => p?.trim()))) ||
    (mergedIl.alternativeReadings || []).some(r => JSON.stringify(r.roleOrder) === JSON.stringify(ilDro) && r.parts?.some(p => p?.trim()))
  const ilHasReverse = (JSON.stringify(ilReverseDro) === '[0,1]' && mergedIl.readingParts && mergedIl.readingParts.some(p => p?.trim())) ||
    (JSON.stringify(ilReverseDro) !== '[0,1]' && (mergedIl.alternativeReadings || []).some(r => JSON.stringify(r.roleOrder) === JSON.stringify(ilReverseDro) && r.parts?.some(p => p?.trim())))
  React.useEffect(() => {
    const current = mergedIl.readingDisplay || 'forward'
    if (ilHasForward && !ilHasReverse && current !== 'forward') {
      store.updateImplicitLink(parentFact.id, roleIndex, { readingDisplay: 'forward' })
    } else if (!ilHasForward && ilHasReverse && current !== 'reverse') {
      store.updateImplicitLink(parentFact.id, roleIndex, { readingDisplay: 'reverse' })
    }
  }, [ilHasForward, ilHasReverse, parentFact.id, roleIndex, mergedIl.readingDisplay, store])

  const synthFact = {
    id: parentFact.id,
    arity: 2,
    roles: [
      { objectTypeId: parentFact.id },
      { objectTypeId: role.objectTypeId },
    ],
  }

  const readings = readingList(mergedIl, 2, store.viewLanguage)

  return (
    <div style={{ marginBottom: 18 }}>
      <InspectorTitle>Implicit Link: {nestedName} ↔ {playerName}</InspectorTitle>
      <div style={{ marginBottom: 10 }}>
        <button onClick={() => store.select(parentFact.id, 'fact')}
          style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer',
            color: 'var(--accent)', fontSize: 11 }}>
          ← {parentFact.objectifiedName || 'Fact Type'}
        </button>
      </div>

      <Section title="Base role in parent fact">
        <BaseRoleChip parentFact={parentFact} roleIndex={roleIndex} />
      </Section>

      <Section title="Roles">
        <CompactImplicitLinkRoleList parentFact={parentFact} roleIndex={roleIndex} />
      </Section>

      <Section title="Readings">
        <ReadingRows readings={readings} fact={synthFact} store={store}
          isFallback={r => isFallbackReading(mergedIl, r.roleOrder, r.parts)}
          onUpdate={(i, parts) => store.updateReading(parentFact.id, i, parts, roleIndex)}
          onRemove={i => store.removeReading(parentFact.id, i, roleIndex)}
          onPrefer={i => store.preferReading(parentFact.id, i, roleIndex)}/>
        <AddReadingRow fact={{ ...synthFact, arity: 2 }} store={store} available={[[0, 1], [1, 0]]}
          onAdd={(roleOrder, parts) => store.addReading(parentFact.id, roleOrder, parts, roleIndex)}/>
      </Section>

      <Section title="Presentation">
        <Row>
          <Label>Shown Role Box Order</Label>
          <select value={JSON.stringify(mergedIl.roleOrder || [0, 1])} style={{ width: '100%' }}
            onChange={e => {
              const newOrder = JSON.parse(e.target.value)
              store.updateImplicitLink(parentFact.id, roleIndex, { roleOrder: newOrder, readingOffsetAbove: null, readingOffsetBelow: null })
            }}>
            <option value="[0,1]">(1, 2)</option>
            <option value="[1,0]">(2, 1)</option>
          </select>
        </Row>
        <Row>
          <Label>Shown Reading</Label>
          {[
            { value: 'forward', label: 'Forward only' },
            { value: 'both',    label: 'Forward / Reverse' },
            { value: 'reverse', label: '◂ Reverse only' },
          ].map(opt => {
            const disabled =
              (opt.value === 'forward' && !ilHasForward) ||
              (opt.value === 'both' && (!ilHasForward || !ilHasReverse)) ||
              (opt.value === 'reverse' && !ilHasReverse)
            const isCurrent = (mergedIl.readingDisplay || 'forward') === opt.value
            return (
              <label key={opt.value} style={{
                display: 'flex', alignItems: 'center', gap: 6,
                fontSize: 12, cursor: disabled ? 'not-allowed' : 'pointer', marginBottom: 3,
                color: disabled ? 'var(--ink-muted)' : 'var(--ink-2)',
              }}>
                <input type="radio"
                  name={`il-rdisplay-${parentFact.id}-${roleIndex}`}
                  value={opt.value}
                  checked={isCurrent}
                  disabled={disabled}
                  onChange={() => store.updateImplicitLink(parentFact.id, roleIndex, { readingDisplay: opt.value })}
                  style={{ width: 'auto', padding: 0, border: 'none', accentColor: 'var(--accent)', cursor: disabled ? 'not-allowed' : 'pointer' }}
                />
                {opt.label}
              </label>
            )
          })}
        </Row>
        <Row>
          <Label>Orientation</Label>
        </Row>
        <Row>
          {['horizontal', 'vertical'].map(val => (
            <label key={val} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, marginBottom: 3, cursor: 'pointer', color: 'var(--ink-2)' }}>
              <input type="radio"
                name={`il-orient-${parentFact.id}-${roleIndex}`}
                value={val}
                checked={mergedIl.orientation === val}
                onChange={() => store.updateImplicitLink(parentFact.id, roleIndex, { orientation: val, readingOffsetAbove: null, readingOffsetBelow: null })}
                style={{ width: 'auto', padding: 0, border: 'none', accentColor: 'var(--accent)', cursor: 'pointer' }}
              />
              {val.charAt(0).toUpperCase() + val.slice(1)}
            </label>
          ))}
        </Row>
        <Row>
          <Label>Reading Position</Label>
        </Row>
        {(() => {
          const isVert    = mergedIl.orientation === 'vertical'
          const storedOff = mergedIl.readingAbove ? mergedIl.readingOffsetAbove : mergedIl.readingOffsetBelow
          const posValue  = storedOff !== null && storedOff !== undefined ? 'free'
            : mergedIl.readingAbove ? 'above' : 'below'
          const opts = [
            { value: 'above', label: isVert ? 'Right' : 'Above' },
            { value: 'below', label: isVert ? 'Left'  : 'Below' },
            { value: 'free',  label: 'Free' },
          ]
          return (
            <Row>
              {opts.map(opt => (
                <label key={opt.value} style={{
                  display: 'flex', alignItems: 'center', gap: 6,
                  fontSize: 12, marginBottom: 3,
                  cursor: opt.value === 'free' ? 'not-allowed' : 'pointer',
                  color: 'var(--ink-2)',
                }}>
                  <input type="radio"
                    name={`il-rpos-${parentFact.id}-${roleIndex}`}
                    value={opt.value}
                    checked={posValue === opt.value}
                    disabled={opt.value === 'free'}
                    onChange={() => store.updateImplicitLink(parentFact.id, roleIndex, {
                      readingAbove: opt.value === 'above',
                      readingOffsetAbove: null,
                      readingOffsetBelow: null,
                    })}
                    style={{ width: 'auto', padding: 0, border: 'none', accentColor: 'var(--accent)',
                      cursor: opt.value === 'free' ? 'not-allowed' : 'pointer' }}
                  />
                  {opt.label}
                </label>
              ))}
            </Row>
          )
        })()}
        <Row>
          <Label>Uniqueness Bar Position</Label>
        </Row>
        <Row>
          {(mergedIl.orientation === 'vertical'
            ? [{ label: 'Right', val: false }, { label: 'Left', val: true }]
            : [{ label: 'Above', val: false }, { label: 'Below', val: true }]
          ).map(opt => (
            <label key={opt.label} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, marginBottom: 3, cursor: 'pointer', color: 'var(--ink-2)' }}>
              <input type="radio"
                name={`il-upos-${parentFact.id}-${roleIndex}`}
                value={String(opt.val)}
                checked={!!mergedIl.uniquenessBelow === opt.val}
                onChange={() => store.updateImplicitLink(parentFact.id, roleIndex, { uniquenessBelow: opt.val })}
                style={{ width: 'auto', padding: 0, border: 'none', accentColor: 'var(--accent)', cursor: 'pointer' }}
              />
              {opt.label}
            </label>
          ))}
        </Row>
      </Section>

      <Section title="Constraints">
        <Label>Uniqueness</Label>
        {(() => {
          const hasSolo = (parentFact.uniqueness || []).some(u => u.length === 1 && u[0] === roleIndex)
          const uBars = hasSolo ? [[0], [1]] : [[0]]
          const prefArr = il.preferredUniqueness || []

          return (
            <>
              {uBars.map((uRoles, ui) => {
                const key = JSON.stringify([...uRoles].sort())
                const isPreferred = prefArr.some(pu => JSON.stringify([...pu].sort()) === key)
                const label = uBars.length > 1 ? `Internal Uniqueness ${ui + 1}` : 'Internal Uniqueness'
                return (
                  <button key={ui} onClick={() => store.selectImplicitLinkUniqueness(parentFact.id, roleIndex, ui)}
                    style={{ width: '100%', padding: '6px 12px', fontSize: 12, background: 'var(--bg-raised)',
                      border: '1px solid var(--border-soft)', borderRadius: 4, cursor: 'pointer',
                      color: 'var(--ink-2)', textAlign: 'left', marginBottom: 6 }}>
                    {label}{isPreferred ? ' (Preferred)' : ''}
                  </button>
                )
              })}
            </>
          )
        })()}

        <Label style={{ marginTop: 8 }}>Frequency</Label>
        {(() => {
          const propagatedFreq = (parentFact.internalFrequency || [])
            .filter(ifc => ifc.roles.length === 1 && ifc.roles[0] === roleIndex)

          return (
            <>
              {propagatedFreq.map(ifc => {
                const rangeText = ifc.range ? `${ifc.range.min === ifc.range.max ? ifc.range.min : `${ifc.range.min}..${ifc.range.max ?? '∞'}`}` : ''
                return (
                  <button key={ifc.id} onClick={() => store.selectInternalFrequency(parentFact.id, `${parentFact.id}_il_${roleIndex}_if_${ifc.id}`)}
                    style={{ width: '100%', padding: '6px 12px', fontSize: 12, background: 'var(--bg-raised)',
                      border: '1px solid var(--border-soft)', borderRadius: 4, cursor: 'pointer',
                      color: 'var(--ink-2)', textAlign: 'left', marginBottom: 6 }}>
                    Internal Frequency{rangeText ? `: ${rangeText}` : ''}
                  </button>
                )
              })}
              {propagatedFreq.length === 0 && (
                <div style={{ fontSize: 11, color: 'var(--ink-muted)', fontStyle: 'italic' }}>None</div>
              )}
            </>
          )
        })()}
      </Section>

      <Section title="Usage">
        <DiagramList kind="implicitLink" factId={parentFact.id} roleIndex={roleIndex} />
      </Section>

      <div style={{ marginTop: 8 }}>
        <button onClick={() => store.hideImplicitLink(parentFact.id, roleIndex)}
          style={{ width: '100%', padding: '6px 12px', fontSize: 12, background: 'var(--bg-raised)',
            border: '1px solid var(--border-soft)', borderRadius: 4, cursor: 'pointer',
            color: 'var(--ink-muted)' }}>
          Hide implicit link
        </button>
      </div>
    </div>
  )
}

// ── Subtype inspector ─────────────────────────────────────────────────────────
function NoteInspector({ note }) {
  const store = useOrmStoreIgnoring('pan', 'zoom')

  const connectorLabel = (targetId) => {
    if (targetId?.includes('_il_')) {
      const [factId, riStr] = targetId.split('_il_')
      const f  = store.facts.find(f => f.id === factId)
      const ot = store.objectTypes.find(o => o.id === f?.roles[Number(riStr)]?.objectTypeId)
      return `${f?.objectifiedName || '(fact)'} ↔ ${ot?.name || '?'} (implied)`
    }
    const st = store.subtypes.find(s => s.id === targetId)
    if (st) {
      const sub = store.objectTypes.find(o => o.id === st.subId)?.name
                || store.facts.find(f => f.id === st.subId)?.objectifiedName || '?'
      const sup = store.objectTypes.find(o => o.id === st.superId)?.name
                || store.facts.find(f => f.id === st.superId)?.objectifiedName || '?'
      return `${sub} ⊂ ${sup}`
    }
    const ot = store.objectTypes.find(o => o.id === targetId)
    if (ot) return ot.name || '(entity)'
    const f  = store.facts.find(f => f.id === targetId)
    if (f) return f.objectifiedName || '(fact)'
    const c  = store.constraints.find(c => c.id === targetId)
    if (c) return c.constraintType || '(constraint)'
    return '(deleted)'
  }

  return (
    <div style={{ marginBottom: 18 }}>
      <InspectorTitle>Note</InspectorTitle>
      <Row>
        <Label>Text</Label>
        <textarea
          value={note.text ?? ''}
          onChange={e => store.updateNote(note.id, { text: e.target.value })}
          rows={6}
          placeholder="Enter note text…"
          style={{
            width: '100%', resize: 'vertical', boxSizing: 'border-box',
            fontSize: 12, fontFamily: 'inherit', lineHeight: 1.5,
            border: '1px solid var(--border)', borderRadius: 3,
            padding: '5px 7px', background: 'var(--bg-raised)',
            color: 'var(--ink-2)', outline: 'none',
          }}
        />
      </Row>
      <Section title="Size">
        <Row>
          <Label>Width</Label>
          <input type="number" min={80} max={800} step={10}
            value={note.w}
            onChange={e => { const v = Number(e.target.value); if (v >= 80) store.updateNote(note.id, { w: v }) }}
            onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur() }}
            style={{ width: '100%', fontSize: 12, padding: '3px 6px',
              border: '1px solid var(--border)', borderRadius: 3, background: 'var(--bg-raised)', color: 'var(--ink-2)' }}
          />
        </Row>
        <Row>
          <Label>Height</Label>
          <input type="number" min={40} max={600} step={10}
            value={note.h}
            onChange={e => { const v = Number(e.target.value); if (v >= 40) store.updateNote(note.id, { h: v }) }}
            onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur() }}
            style={{ width: '100%', fontSize: 12, padding: '3px 6px',
              border: '1px solid var(--border)', borderRadius: 3, background: 'var(--bg-raised)', color: 'var(--ink-2)' }}
          />
        </Row>
      </Section>

      {(note.connectors ?? []).length > 0 && (
        <Section title="Connections">
          {(note.connectors ?? []).map(conn => (
            <div key={conn.id} style={{
              display: 'flex', alignItems: 'center', gap: 6,
              marginBottom: 4, padding: '3px 0',
            }}>
              <span style={{ flexShrink: 0, lineHeight: 0, transform: 'scale(0.85)', transformOrigin: 'left center' }}>
                <NoteConnectorIcon />
              </span>
              <span style={{ flex: 1, fontSize: 11, color: 'var(--ink-2)',
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {connectorLabel(conn.targetId)}
              </span>
              <button
                onClick={() => store.removeNoteConnector(note.id, conn.id)}
                title="Remove connection"
                style={{
                  background: 'none', border: '1px solid #e0b0a8',
                  borderRadius: 3, cursor: 'pointer',
                  fontSize: 9, color: 'var(--danger)', padding: '1px 5px', flexShrink: 0,
                }}
                onMouseEnter={e => { e.currentTarget.style.background = 'var(--danger)'; e.currentTarget.style.color = '#fff' }}
                onMouseLeave={e => { e.currentTarget.style.background = 'none'; e.currentTarget.style.color = 'var(--danger)' }}
              >×</button>
            </div>
          ))}
        </Section>
      )}
      {(note.connectors ?? []).length === 0 && (
        <div style={{ fontSize: 10, color: 'var(--ink-muted)', fontStyle: 'italic', marginBottom: 10 }}>
          Use the note's context menu to add or remove subjects.
        </div>
      )}

      <PropertiesSection el={note} kind="note" onChange={patch => store.updateNote(note.id, patch)}/>
      <GroupMembershipSection id={note.id}/>

      <div style={{ marginTop: 8 }}>
        <DangerBtn onClick={() => store.deleteNote(note.id)}>Delete</DangerBtn>
      </div>
    </div>
  )
}

function SubtypeInspector({ st }) {
  const store = useOrmStoreIgnoring('pan', 'zoom')
  const playerName = (id) => {
    const ot = store.objectTypes.find(o => o.id === id)
    if (ot) return ot.name
    const nf = store.facts.find(f => f.id === id && f.objectified)
    if (nf) return nf.objectifiedName || '(unnamed)'
    return '?'
  }
  return (
    <div style={{ marginBottom: 18 }}>
      <InspectorTitle>Subtype Relationship</InspectorTitle>
      <ValidationErrorStrip elementId={st.id} store={store}/>
      <Row>
        <div style={{ fontSize: 12, color: 'var(--ink-2)', padding: '6px 8px',
          background: 'var(--bg-raised)', border: '1px solid var(--border-soft)', borderRadius: 4 }}>
          {playerName(st.subId)} <span style={{ color: 'var(--col-subtype)' }}>⊂</span> {playerName(st.superId)}
        </div>
      </Row>
      <Row>
        <Checkbox
          label="Inherits Preferred Identifier"
          checked={st.inheritsPreferredIdentifier !== false}
          onChange={v => store.updateSubtype(st.id, { inheritsPreferredIdentifier: v })}
        />
      </Row>
      <DocumentationSection el={st} onChange={patch => store.updateSubtype(st.id, patch)}/>
      <PropertiesSection el={st} kind="subtype" onChange={patch => store.updateSubtype(st.id, patch)}/>
      <GroupMembershipSection id={st.id}/>
      <DiagramList elementId={st.id} kind="subtype" subtypeEndpointIds={[st.subId, st.superId]} />
      <div style={{ marginTop: 8 }}>
        <DangerBtn onClick={() => store.deleteSubtype(st.id)}>Delete</DangerBtn>
      </div>
    </div>
  )
}

const EXTERNAL_CONSTRAINT_TITLES = {
  ring:        'Ring Constraint',
  exclusiveOr: 'Exclusive Or Constraint',
  exclusion:   'Exclusion Constraint',
  inclusiveOr: 'Inclusive Or Constraint',
  uniqueness:  'External Uniqueness Constraint',
  equality:    'Equality Constraint',
  subset:      'Subset Constraint',
  frequency:       'External Frequency Constraint',
  valueComparison: 'Value Comparison Constraint',
}

// ── Subtype-like Constraint inspector ─────────────────────────────────────────
function ExternalConstraintInspector({ c }) {
  const store      = useOrmStoreIgnoring('pan', 'zoom')
  const gc         = store.sequenceConstruction?.constraintId === c.id ? store.sequenceConstruction : null
  const subtypeMap = Object.fromEntries(store.subtypes.map(st => [st.id, st]))
  const otMap      = Object.fromEntries(store.objectTypes.map(o => [o.id, o]))
  const factMap    = Object.fromEntries(store.facts.map(f => [f.id, f]))
  // Add synthetic implied link facts so sequence member labels can resolve them
  store.facts.filter(f => f.objectified).forEach(f => {
    (f.implicitLinks || []).forEach(il => {
      const synth = makeImplicitLinkFact(f, il)
      factMap[synth.id] = synth
    })
  })
  const sequences  = c.sequences || []
  const posCount   = sequences[0]?.length ?? 0
  const [pressedHeader, setPressedHeader] = useState(null)
  const [pressedSequence, setPressedSequence] = useState(null)
  const [pressedCell, setPressedCell] = useState(null)
  const [pressedQueryIndex, setPressedQueryIndex] = useState(null)

  // Resolve a role-player name from either objectTypes or objectified facts
  const playerName = (playerId) => {
    if (!playerId) return '?'
    const ot = otMap[playerId]
    if (ot) return ot.name
    const nf = factMap[playerId]
    if (nf?.objectified) return nf.objectifiedName || '(unnamed)'
    return '?'
  }

  // Plain text for tooltip
  const memberLabelText = (m) => {
    if (!m) return '—'
    if (m.kind === 'subtype') {
      const st = subtypeMap[m.subtypeId]
      if (!st) return '?'
      return `${playerName(st.subId)} ⊂ ${playerName(st.superId)}`
    }
    const fact = factMap[m.factId]
    if (!fact) return '?'
    const n = fact.arity
    const parts = fact.readingParts || []
    const tokens = []
    for (let i = 0; i <= n; i++) {
      const text = (parts[i] || '').trim()
      if (text) tokens.push(text)
      if (i < n) tokens.push(playerName(fact.roles[i]?.objectTypeId))
    }
    const reading = tokens.length > 0 ? tokens.join(' ') : '??'
    return `${reading} (${m.roleIndex + 1})`
  }

  // JSX with object-type names highlighted in reading colour
  const memberLabelNode = (m) => {
    if (!m) return <span>—</span>
    if (m.kind === 'subtype') {
      const st = subtypeMap[m.subtypeId]
      if (!st) return <span>?</span>
      return (
        <span>
          <span style={{ color: '#7c4dbd', fontWeight: 600, background: '#f5efb8', borderRadius: 2 }}>{playerName(st.subId)}</span>
          {' ⊂ '}
          <span style={{ color: '#7c4dbd', fontWeight: 600 }}>{playerName(st.superId)}</span>
        </span>
      )
    }
    const fact = factMap[m.factId]
    if (!fact) return <span>?</span>
    const n = fact.arity
    const parts = fact.readingParts || []
    const tokens = []
    for (let i = 0; i <= n; i++) {
      const text = (parts[i] || '').trim()
      if (text) tokens.push({ kind: 'text', value: text })
      if (i < n) tokens.push({ kind: 'ot', roleIndex: i, value: playerName(fact.roles[i]?.objectTypeId) })
    }
    if (tokens.length === 0) {
      return <span>??</span>
    }
    return (
      <span>
        {tokens.map((tok, i) => (
          <React.Fragment key={i}>
            {i > 0 && ' '}
            {tok.kind === 'ot'
              ? <span style={{ color: '#7c4dbd', fontWeight: 600, background: tok.roleIndex === m.roleIndex ? '#f5efb8' : 'none', borderRadius: 2 }}>{tok.value}</span>
              : <span style={{ color: '#2a7a2a' }}>{tok.value}</span>
            }
          </React.Fragment>
        ))}
      </span>
    )
  }

  // Clear highlights on global mouse-up — registered once; reads store via ref.
  const storeRef = useRef(null)
  storeRef.current = store
  useEffect(() => {
    const up = () => {
      storeRef.current.clearConstraintHighlight()
      storeRef.current.clearQueryIndexHighlight()
      setPressedQueryIndex(null)
    }
    window.addEventListener('mouseup', up)
    return () => window.removeEventListener('mouseup', up)
  }, [])

  const highlight = (sequenceIndex, positionIndex) =>
    store.setConstraintHighlight({ constraintId: c.id, sequenceIndex, positionIndex })

  // Describe what the next pick is for
  const currentStep = gc?.steps[0]
  const currentSequenceLabel = currentStep
    ? currentStep.sequenceIndex >= sequences.length
      ? `new sequence`
      : `Sequence ${currentStep.sequenceIndex + 1}`
    : null
  const stepNum  = gc ? gc.collected.length + 1 : 0
  const stepTotal = gc ? gc.steps.length + gc.collected.length : 0

  const btnStyle = { padding: '4px 8px', fontSize: 11, background: 'var(--bg-raised)',
    border: '1px solid var(--border)', borderRadius: 4, cursor: 'pointer', color: 'var(--ink-2)' }

  return (
    <div style={{ marginBottom: 18 }}>
      <InspectorTitle>{EXTERNAL_CONSTRAINT_TITLES[c.constraintType] || 'Constraint'}</InspectorTitle>
      <ValidationErrorStrip elementId={c.id} store={store}/>

      {/* Is Preferred Identifier — only for uniqueness */}
      {c.constraintType === 'uniqueness' && (() => {
        const targetOt = c.targetObjectTypeId
          ? store.objectTypes.find(o => o.id === c.targetObjectTypeId) : null
        const identifiesVt = targetOt?.kind === 'value'
        const piCheck = canBeExternalUniquenessPI(c, store.facts)
        const piDisabled = identifiesVt || !piCheck.ok
        const piTitle = identifiesVt
          ? 'A value type cannot have a preferred identifier'
          : !piCheck.ok ? piCheck.reason : undefined
        return (
          <Row>
            <Label>Identification</Label>
            <Checkbox
              label="Is Preferred Identifier"
              checked={!!c.isPreferredIdentifier}
              disabled={piDisabled}
              title={piTitle}
              onChange={v => store.updateConstraint(c.id, v ? { isPreferredIdentifier: true, deontic: false } : { isPreferredIdentifier: false })}
            />
          </Row>
        )
      })()}

      {/* Outer join — only for external uniqueness (Halpin & Morgan 2024, sec. 10.1) */}
      {c.constraintType === 'uniqueness' && (() => {
        const why = whyNoOuterJoin(c, makeContext(store), { offerOnly: true })
        return (
          <Row>
            <Label>Join</Label>
            <Checkbox
              label="Outer join (no value counts as a value)"
              checked={!!c.outerJoin}
              disabled={!c.outerJoin && !!why}
              title={why ? `Not available: ${why}` : 'Objects that lack an optional part of the combination count as having the same "no value" there; drawn as an o through the bar'}
              onChange={v => store.updateConstraint(c.id, { outerJoin: v || undefined })}
            />
          </Row>
        )
      })()}

      <Row>
        <Label>Modality</Label>
        <DeonticCheckbox checked={!!c.deontic && !c.isPreferredIdentifier} disabled={!!c.isPreferredIdentifier}
          title={c.isPreferredIdentifier ? 'A preferred identifier is always alethic' : undefined}
          onChange={v => store.updateConstraint(c.id, { deontic: v })}/>
      </Row>

      {/* Frequency range — only for frequency */}
      {c.constraintType === 'frequency' && (
        <Row>
          <Label>Frequency Range</Label>
          <ValueRangeEditor
            range={c.frequency}
            onChange={vr => store.updateConstraint(c.id, { frequency: vr })}
            naturalNumbers
          />
        </Row>
      )}

      {/* Target Object Type — only for inclusiveOr / exclusiveOr / uniqueness / frequency */}
      {(c.constraintType === 'inclusiveOr' || c.constraintType === 'exclusiveOr' || c.constraintType === 'uniqueness' || c.constraintType === 'frequency') && (
        <Row>
          <Label>Target Object Type</Label>
          <select
            value={c.targetObjectTypeId ?? ''}
            onChange={e => store.updateConstraint(c.id, {
              targetObjectTypeId: e.target.value || null,
            })}
            style={{ width: '100%', fontSize: 12, padding: '3px 5px',
              background: 'var(--bg-raised)', border: '1px solid var(--border-soft)',
              borderRadius: 4, color: 'var(--ink-2)' }}>
            <option value="">— none —</option>
            {store.objectTypes.slice().sort((a, b) => a.name.localeCompare(b.name)).map(ot => (
              <option key={ot.id} value={ot.id}>{ot.name}</option>
            ))}
            {store.facts.filter(f => f.objectified && f.objectifiedName).slice()
              .sort((a, b) => (a.objectifiedName || '').localeCompare(b.objectifiedName || ''))
              .map(f => (
                <option key={f.id} value={f.id}>{f.objectifiedName} (nested)</option>
              ))}
          </select>
        </Row>
      )}

      {/* Operator — only for valueComparison */}
      {c.constraintType === 'valueComparison' && (
        <Row>
          <Label>Operator</Label>
          <select
            value={c.operator ?? '='}
            onChange={e => store.updateConstraint(c.id, { operator: e.target.value })}
            style={{ width: '100%', fontSize: 12, padding: '3px 5px',
              background: 'var(--bg-raised)', border: '1px solid var(--border-soft)',
              borderRadius: 4, color: 'var(--ink-2)' }}>
            {['=', '≠', '<', '≤', '>', '≥'].map(op => (
              <option key={op} value={op}>{op}</option>
            ))}
          </select>
        </Row>
      )}

      {/* Ring Properties — only for ring constraints */}
      {c.constraintType === 'ring' && (() => {
        const explicit = c.ringTypes || []
        const { active, implied, isEmpty } = computeRingImplied(explicit)
        const wouldEmpty = key =>
          !active.has(key) && computeRingImplied([...explicit, key]).isEmpty
        const SYM_W = 28, SYM_H = 20
        return (
          <Row>
            <Label>Ring Properties</Label>
            {isEmpty && (
              <div style={{ marginBottom: 8, padding: '5px 8px', borderRadius: 4,
                background: '#fdecea', border: '1px solid #f5c6cb',
                fontSize: 11, color: '#a94442' }}>
                ⚠ The selected properties imply an empty relation.
              </div>
            )}
            {RING_TYPES.map(({ key, label }) => {
              const isActive     = active.has(key)
              const isImplied    = implied.has(key)
              const impliesEmpty = wouldEmpty(key)
              const disabled     = isImplied || impliesEmpty
              const color = isActive ? 'var(--col-ring)' : 'var(--ink-muted)'
              return (
                <label key={key} style={{ display: 'flex', alignItems: 'center', gap: 7,
                  cursor: disabled ? 'default' : 'pointer',
                  color: disabled ? 'var(--ink-muted)' : isActive ? 'var(--ink)' : 'var(--ink-2)',
                  fontSize: 12, marginBottom: 5,
                  opacity: disabled ? 0.6 : 1 }}>
                  <input type="checkbox" checked={isActive} disabled={disabled}
                    onChange={e => {
                      const current = c.ringTypes || []
                      if (e.target.checked) {
                        const withKey = [...current, key]
                        const { implied } = computeRingImplied(withKey)
                        // If any newly implied property implies any of the explicit properties,
                        // replace those covered properties with the implied one
                        const promotedTo = [...implied].find(p => {
                          const pActive = computeRingImplied([p]).active
                          return withKey.some(e => pActive.has(e))
                        })
                        const newExplicit = promotedTo
                          ? [...withKey.filter(e => !computeRingImplied([promotedTo]).active.has(e)), promotedTo]
                          : withKey
                        store.updateConstraint(c.id, { ringTypes: minimizeExplicit(newExplicit) })
                      } else {
                        store.updateConstraint(c.id, { ringTypes: current.filter(t => t !== key) })
                      }
                    }}
                    style={{ width: 'auto', padding: 0, border: 'none', flexShrink: 0 }}/>
                  <svg width={SYM_W} height={SYM_H} style={{ flexShrink: 0, overflow: 'visible' }}>
                    <RingMiniSymbol type={key} cx={SYM_W / 2} cy={SYM_H / 2} color={color}/>
                  </svg>
                  {label}
                  {isImplied && (
                    <span style={{ fontSize: 10, color: 'var(--ink-muted)',
                      fontStyle: 'italic', marginLeft: 2 }}>(implied)</span>
                  )}
                  {impliesEmpty && (
                    <span style={{ fontSize: 10, color: '#a94442',
                      fontStyle: 'italic', marginLeft: 2 }}>(implies emptiness)</span>
                  )}
                </label>
              )
            })}
            <button
              onClick={() => store.updateConstraint(c.id, { ringTypes: [] })}
              style={{ marginTop: 4, background: 'transparent', border: '1px solid var(--border)',
                borderRadius: 3, padding: '4px 10px', fontSize: 11,
                color: 'var(--ink-2)', cursor: 'pointer' }}>
              Reset properties
            </button>
          </Row>
        )
      })()}

      {/* Construction banner */}
      {gc && (
        <div style={{ background: 'var(--accent)', color: '#fff', borderRadius: 4,
          padding: '7px 10px', marginBottom: 10, fontSize: 11 }}>
          <div style={{ fontWeight: 600, marginBottom: 3 }}>
            Select for {currentSequenceLabel} ({stepNum}/{stepTotal})
          </div>
          {gc.warning
            ? <div style={{ background: 'rgba(255,255,255,0.2)', borderRadius: 3,
                padding: '3px 6px', marginBottom: 3, fontWeight: 600 }}>
                ⚠ {gc.warning}
              </div>
            : <div style={{ opacity: 0.85 }}>Click a role box or subtype relationship on the canvas · Enter or click constraint to commit.</div>
          }
          <button onClick={() => store.abandonSequenceConstruction()}
            style={{ marginTop: 6, padding: '2px 8px', fontSize: 10, background: 'rgba(255,255,255,0.2)',
              border: '1px solid rgba(255,255,255,0.4)', borderRadius: 3, cursor: 'pointer', color: '#fff' }}>
            Cancel
          </button>
        </div>
      )}

      <label style={{ fontSize: 10, color: 'var(--ink-muted)', letterSpacing: '0.08em',
        textTransform: 'uppercase', marginBottom: 3, display: 'block' }}>Sequences</label>

      {/* Sequences table: rows = sequences, columns = positions */}
      {sequences.length > 0 && posCount > 0 && (
        <div style={{ marginBottom: 10, overflowX: 'auto' }}>
          {/* Header row: position numbers */}
          <div style={{ display: 'flex', gap: 4, marginBottom: 4, alignItems: 'center' }}>
            <div style={{ width: 28 }}/>
            {Array.from({ length: posCount }, (_, pi) => {
              const pressed = pressedHeader === pi
              return (
                <button key={pi}
                  onMouseDown={() => { setPressedHeader(pi); highlight(null, pi) }}
                  onMouseUp={() => setPressedHeader(null)}
                  onMouseLeave={() => setPressedHeader(null)}
                  style={{ flex: 1, minWidth: 0, fontSize: 10, color: 'var(--ink-2)',
                    letterSpacing: '0.07em', textAlign: 'center', cursor: 'default',
                    userSelect: 'none', border: '1px solid var(--border)', borderRadius: 3,
                    padding: '1px 0', background: 'var(--bg-raised)',
                    boxShadow: pressed
                      ? 'inset 1px 1px 2px rgba(0,0,0,0.25), inset -1px -1px 1px rgba(255,255,255,0.4)'
                      : 'inset -1px -1px 2px rgba(0,0,0,0.15), inset 1px 1px 1px rgba(255,255,255,0.7)',
                    transform: pressed ? 'translateY(1px)' : 'none' }}>
                  {pi + 1}
                </button>
              )
            })}
            <div style={{ width: 22 }}/>
          </div>
          {/* Sequence rows */}
          {sequences.map((g, gi) => {
            const spressed = pressedSequence === gi
            return (
              <div key={gi} style={{ display: 'flex', gap: 4, marginBottom: 3, alignItems: 'center' }}>
                <button
                  onMouseDown={() => { setPressedSequence(gi); highlight(gi, null) }}
                  onMouseUp={() => setPressedSequence(null)}
                  onMouseLeave={() => setPressedSequence(null)}
                  style={{ width: 28, fontSize: 10, color: 'var(--ink-2)',
                    letterSpacing: '0.07em', flexShrink: 0, cursor: 'default', userSelect: 'none',
                    border: '1px solid var(--border)', borderRadius: 3, padding: '1px 0',
                    background: 'var(--bg-raised)', textAlign: 'center',
                    boxShadow: spressed
                      ? 'inset 1px 1px 2px rgba(0,0,0,0.25), inset -1px -1px 1px rgba(255,255,255,0.4)'
                      : 'inset -1px -1px 2px rgba(0,0,0,0.15), inset 1px 1px 1px rgba(255,255,255,0.7)',
                    transform: spressed ? 'translateY(1px)' : 'none' }}>
                  S{gi + 1}
                </button>
                {Array.from({ length: posCount }, (_, pi) => {
                  const cellKey = `${gi}-${pi}`
                  const cpressed = pressedCell === cellKey
                  return (
                    <button key={pi}
                      onMouseDown={() => { setPressedCell(cellKey); highlight(gi, pi) }}
                      onMouseUp={() => setPressedCell(null)}
                      onMouseLeave={() => setPressedCell(null)}
                      style={{ flex: 1, minWidth: 0, fontSize: 11, color: 'var(--ink-2)',
                        background: 'var(--bg-raised)', border: '1px solid var(--border-soft)',
                        borderRadius: 3, padding: '2px 5px', overflow: 'hidden',
                        textOverflow: 'ellipsis', whiteSpace: 'nowrap', cursor: 'default',
                        textAlign: 'left',
                        boxShadow: cpressed
                          ? 'inset 1px 1px 2px rgba(0,0,0,0.25), inset -1px -1px 1px rgba(255,255,255,0.4)'
                          : 'inset -1px -1px 2px rgba(0,0,0,0.15), inset 1px 1px 1px rgba(255,255,255,0.7)',
                        transform: cpressed ? 'translateY(1px)' : 'none' }}>
                      {memberLabelNode(g[pi])}
                    </button>
                  )
                })}
                <button onClick={() => store.removeConstraintSequence(c.id, gi)}
                  title={`Remove Sequence ${gi + 1}`}
                  style={{ width: 22, padding: 0, fontSize: 11, background: 'var(--bg-raised)',
                    border: '1px solid #e0b0a8', borderRadius: 3,
                    cursor: 'pointer', flexShrink: 0, color: 'var(--danger)' }}
                  onMouseEnter={e => { e.currentTarget.style.background = 'var(--danger)'; e.currentTarget.style.color = '#fff'; e.currentTarget.style.borderColor = 'var(--danger)' }}
                  onMouseLeave={e => { e.currentTarget.style.background = 'var(--bg-raised)'; e.currentTarget.style.color = 'var(--danger)'; e.currentTarget.style.borderColor = '#e0b0a8' }}>
                  ×
                </button>
              </div>
            )
          })}
          {/* Footer row: position delete buttons */}
          <div style={{ display: 'flex', gap: 4, marginTop: 2, alignItems: 'center' }}>
            <div style={{ width: 28 }}/>
            {Array.from({ length: posCount }, (_, pi) => (
              <button key={pi}
                onClick={() => store.removeConstraintSequencePosition(c.id, pi)}
                title={`Remove position ${pi + 1} from all sequences`}
                style={{ flex: 1, minWidth: 0, padding: '1px 0', fontSize: 11,
                  background: 'var(--bg-raised)', border: '1px solid #e0b0a8',
                  borderRadius: 3, cursor: 'pointer', color: 'var(--danger)' }}
                onMouseEnter={e => { e.currentTarget.style.background = 'var(--danger)'; e.currentTarget.style.color = '#fff'; e.currentTarget.style.borderColor = 'var(--danger)' }}
                onMouseLeave={e => { e.currentTarget.style.background = 'var(--bg-raised)'; e.currentTarget.style.color = 'var(--danger)'; e.currentTarget.style.borderColor = '#e0b0a8' }}>
                ×
              </button>
            ))}
            <div style={{ width: 22 }}/>
          </div>
        </div>
      )}

      {sequences.length === 0 && !gc && (
        <div style={{ fontSize: 11, color: 'var(--ink-muted)', fontStyle: 'italic', marginBottom: 8 }}>
          No sequences yet.
        </div>
      )}

      {/* Action buttons */}
      {!gc && (
        <div style={{ display: 'flex', gap: 6, marginBottom: 10, flexWrap: 'wrap' }}>
          {sequences.length < constraintMaxSequences(c.constraintType) && (
            <button onClick={() => store.startSequenceConstruction(c.id, 'newSequence')} style={btnStyle}>
              + Add sequence
            </button>
          )}
          {sequences.length > 0 && !suppressRolePosition(c.constraintType) && (
            <button onClick={() => store.startSequenceConstruction(c.id, 'extend')} style={btnStyle}>
              + Add position
            </button>
          )}
          {c.constraintType === 'subset' && (
            <button
              disabled={sequences.length < 2}
              onClick={() => store.swapConstraintSequences(c.id)}
              style={{ ...btnStyle, opacity: sequences.length < 2 ? 0.45 : 1, cursor: sequences.length < 2 ? 'default' : 'pointer' }}>
              ⇅ Reverse direction
            </button>
          )}
        </div>
      )}

      {/* ── Query section ── */}
      {(c.constraintType === 'inclusiveOr' || c.constraintType === 'exclusiveOr' || c.constraintType === 'uniqueness' || c.constraintType === 'exclusion' || c.constraintType === 'equality' || c.constraintType === 'subset' || c.constraintType === 'ring' || c.constraintType === 'valueComparison' || c.constraintType === 'frequency') && sequences.length > 0 && (() => {
        const qd = store.queryEditDraft?.constraintId === c.id ? store.queryEditDraft : null
        const queries = c.queries || []
        const hasTarget = !!c.targetObjectTypeId
        const needsTarget = c.constraintType === 'uniqueness' || c.constraintType === 'inclusiveOr' || c.constraintType === 'exclusiveOr' || c.constraintType === 'frequency'

        if (qd) {
          // Editing banner
          const validation = store.getQueryEditValidation()
          const atomCount = qd.atoms.length
          const linkCount = qd.links.length
          return (
            <div style={{ marginBottom: 12 }}>
              <div style={{ background: 'var(--col-query-in)', color: '#fff', borderRadius: 4,
                padding: '7px 10px', marginBottom: 8, fontSize: 11 }}>
                <div style={{ fontWeight: 600, marginBottom: 3 }}>
                  Editing query for S{qd.sequenceIndex + 1}
                </div>
                <div style={{ opacity: 0.9, marginBottom: 4 }}>
                  Click an atom and an original (or two atoms) to link them. Output atoms are fixed.
                </div>
                <div style={{ opacity: 0.85, marginBottom: 6, fontSize: 10 }}>
                  {atomCount} atom{atomCount !== 1 ? 's' : ''}, {linkCount} link{linkCount !== 1 ? 's' : ''}
                  {qd.pendingClick ? ' — waiting for second click' : ''}
                </div>
                <div data-text-panel tabIndex={0} className="copyable" style={{ fontWeight: 600, marginBottom: 6,
                  color: validation.valid ? '#a7f3d0' : '#fca5a5' }}>
                  {validation.valid ? '✓ Pattern is valid' : `✗ ${validation.reason || 'Invalid pattern'}`}
                </div>
                <div style={{ display: 'flex', gap: 6 }}>
                  <button
                    disabled={!validation.valid}
                    onClick={() => store.commitQueryEdit()}
                    style={{ padding: '3px 10px', fontSize: 11,
                      background: validation.valid ? 'rgba(255,255,255,0.25)' : 'rgba(255,255,255,0.1)',
                      border: '1px solid rgba(255,255,255,0.4)', borderRadius: 3,
                      cursor: validation.valid ? 'pointer' : 'default', color: '#fff',
                      opacity: validation.valid ? 1 : 0.5 }}>
                    Done
                  </button>
                  <button onClick={() => store.cancelQueryEdit()}
                    style={{ padding: '3px 10px', fontSize: 11, background: 'rgba(255,255,255,0.15)',
                      border: '1px solid rgba(255,255,255,0.4)', borderRadius: 3,
                      cursor: 'pointer', color: '#fff' }}>
                    Cancel
                  </button>
                </div>
              </div>
            </div>
          )
        }

        return (
          <div style={{ marginBottom: 12 }}>
            <label style={{ fontSize: 10, color: 'var(--ink-muted)', letterSpacing: '0.08em',
              textTransform: 'uppercase', marginBottom: 5, display: 'block' }}>Queries</label>
            {needsTarget && !hasTarget && (
              <div style={{ fontSize: 11, color: 'var(--ink-muted)', fontStyle: 'italic', marginBottom: 6 }}>
                Set a target object type above to enable query editing.
              </div>
            )}
            {sequences.map((seq, gi) => {
              if (seq.length === 0) return null
              const q = queries[gi] || null
              const atomCount = q?.atoms?.length ?? 0
              const asFormula = isFormulaQuery(q)
              // A formula outside the graphical fragment can only be edited as a formula.
              const notDrawable = asFormula ? whyNotGraphical(q, seq, makeContext(store)) : null
              const statusText = asFormula
                ? 'formula'
                : q ? `${atomCount} atom${atomCount !== 1 ? 's' : ''}`
                : 'Not defined'
              const graphDisabled = (needsTarget && !hasTarget) || !!gc || !!notDrawable
              const qPressed = pressedQueryIndex === gi
              return (
                <div key={gi} style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 5 }}>
                  <span style={{ fontSize: 11, color: 'var(--ink-2)', minWidth: 24, flexShrink: 0 }}>S{gi + 1}</span>
                  <button
                    disabled={!q}
                    onMouseDown={() => {
                      if (!q) return
                      setPressedQueryIndex(gi)
                      store.setQueryIndexHighlight({ constraintId: c.id, queryIndex: gi })
                    }}
                    onMouseUp={() => { setPressedQueryIndex(null); store.clearQueryIndexHighlight() }}
                    onMouseLeave={() => { setPressedQueryIndex(null); store.clearQueryIndexHighlight() }}
                    style={{ fontSize: 11, flex: 1, textAlign: 'left',
                      cursor: q ? 'default' : 'not-allowed',
                      color: q ? 'var(--col-query-in)' : 'var(--ink-muted)',
                      fontStyle: q ? 'normal' : 'italic',
                      background: 'var(--bg-raised)',
                      border: '1px solid var(--border-soft)',
                      borderRadius: 3, padding: '2px 5px',
                      boxShadow: qPressed
                        ? 'inset 1px 1px 2px rgba(0,0,0,0.25), inset -1px -1px 1px rgba(255,255,255,0.4)'
                        : 'inset -1px -1px 2px rgba(0,0,0,0.15), inset 1px 1px 1px rgba(255,255,255,0.7)',
                      transform: qPressed ? 'translateY(1px)' : 'none',
                      opacity: q ? 1 : 0.55 }}>
                    {statusText}
                  </button>
                  <button
                    disabled={graphDisabled}
                    title={notDrawable ? `Can't be edited on the diagram: ${notDrawable}` : 'Edit the query as a join path on the diagram'}
                    onClick={() => store.startQueryEdit(c.id, gi)}
                    style={{ padding: '2px 8px', fontSize: 10, background: 'var(--bg-raised)',
                      border: '1px solid var(--border)', borderRadius: 3,
                      cursor: !graphDisabled ? 'pointer' : 'default',
                      color: 'var(--ink-2)', opacity: !graphDisabled ? 1 : 0.4 }}>
                    {q ? 'Edit' : 'Define'}
                  </button>
                  <button
                    disabled={!!gc}
                    title="Edit the query as a formula of the logic, in the rule editor"
                    onClick={() => store.openRuleEditor({ constraintId: c.id, sequenceIndex: gi })}
                    style={{ padding: '2px 8px', fontSize: 10, background: 'var(--bg-raised)',
                      border: '1px solid var(--border)', borderRadius: 3,
                      cursor: !gc ? 'pointer' : 'default',
                      color: 'var(--ink-2)', opacity: !gc ? 1 : 0.4 }}>
                    Text
                  </button>
                  {q && (
                    <button onClick={() => store.clearConstraintQuery(c.id, gi)}
                      title="Clear query"
                      style={{ padding: '2px 6px', fontSize: 10, background: 'var(--bg-raised)',
                        border: '1px solid #e0b0a8', borderRadius: 3,
                        cursor: 'pointer', color: 'var(--danger)' }}
                      onMouseEnter={e => { e.currentTarget.style.background = 'var(--danger)'; e.currentTarget.style.color = '#fff'; e.currentTarget.style.borderColor = 'var(--danger)' }}
                      onMouseLeave={e => { e.currentTarget.style.background = 'var(--bg-raised)'; e.currentTarget.style.color = 'var(--danger)'; e.currentTarget.style.borderColor = '#e0b0a8' }}>
                      ×
                    </button>
                  )}
                </div>
              )
            })}
          </div>
        )
      })()}

      <DocumentationSection el={c} onChange={patch => store.updateConstraint(c.id, patch)}/>
      <PropertiesSection el={c} kind="constraint" onChange={patch => store.updateConstraint(c.id, patch)}/>
      <GroupMembershipSection id={c.id}/>

      <Section title="Usage">
        <DiagramList elementId={c.id} kind="constraint" />
      </Section>
      <DangerBtn onClick={() => store.deleteConstraint(c.id)}>Delete Constraint</DangerBtn>
    </div>
  )
}

// ── Constraint inspector ──────────────────────────────────────────────────────
function ConstraintInspector({ c }) {
  const store = useOrmStoreIgnoring('pan', 'zoom')
  const factMap = Object.fromEntries(store.facts.map(f => [f.id, f]))

  return (
    <div style={{ marginBottom: 18 }}>
      <InspectorTitle>{c.constraintType.charAt(0).toUpperCase() + c.constraintType.slice(1)} Constraint</InspectorTitle>
      <ValidationErrorStrip elementId={c.id} store={store}/>

      {c.constraintType === 'frequency' && (
        <>
          <Row>
            <Label>Min frequency</Label>
            <input type="number" min={0} value={c.frequency.min} style={{ width: '100%' }}
              onChange={e => store.updateConstraint(c.id,
                { frequency: { ...c.frequency, min: +e.target.value } })}
              onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur() }}/>
          </Row>
          <Row>
            <Label>Max frequency (blank = unbounded)</Label>
            <input type="number" min={1} value={c.frequency.max ?? ''} style={{ width: '100%' }}
              placeholder="∞"
              onChange={e => store.updateConstraint(c.id,
                { frequency: { ...c.frequency, max: e.target.value === '' ? null : +e.target.value } })}
              onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur() }}/>
          </Row>
        </>
      )}

      <div style={{ fontSize: 10, color: 'var(--ink-muted)', marginBottom: 8,
        textTransform: 'uppercase', letterSpacing: '0.07em' }}>Role Sequences</div>
      {c.roleSequences.map((group, gi) => (
        <div key={gi} style={{ marginBottom: 8 }}>
          <div style={{ fontSize: 11, color: 'var(--ink-3)', marginBottom: 4 }}>
            Sequence {gi + 1} {gi === 0 && c.constraintType === 'subset' ? '(subset)' : ''}
            {gi === 1 && c.constraintType === 'subset' ? '(superset)' : ''}
          </div>
          {group.length === 0
            ? <div style={{ color: 'var(--ink-muted)', fontSize: 11, fontStyle: 'italic' }}>
                No roles assigned — use the Role Ref controls below
              </div>
            : group.map((ref, ri) => {
                const fact = factMap[ref.factId]
                return (
                  <div key={ri} style={{ fontSize: 11, color: 'var(--ink-2)', marginBottom: 2 }}>
                    {fact ? `${fact.reading || fact.id} · role ${ref.roleIndex + 1}` : `(unknown fact)`}
                  </div>
                )
              })
          }
          {/* Quick-add: pick fact + role */}
          <div style={{ display: 'flex', gap: 4, marginTop: 4 }}>
            <select id={`fact-sel-${c.id}-${gi}`} style={{ flex: 1, fontSize: 11 }}>
              <option value="">Fact…</option>
              {store.facts.map(f => <option key={f.id} value={f.id}>{getDisplayReading(f) || f.id}</option>)}
            </select>
            <select id={`role-sel-${c.id}-${gi}`} style={{ width: 60, fontSize: 11 }}>
              {[0,1,2].map(i => <option key={i} value={i}>{i+1}</option>)}
            </select>
            <button
              onClick={() => {
                const fSel = document.getElementById(`fact-sel-${c.id}-${gi}`)
                const rSel = document.getElementById(`role-sel-${c.id}-${gi}`)
                if (fSel.value) store.addRoleToConstraintSequence(c.id, gi, fSel.value, +rSel.value)
              }}
              style={{ padding: '2px 8px', fontSize: 11, background: 'var(--bg-raised)',
                border: '1px solid var(--border)', borderRadius: 3, cursor: 'pointer' }}>
              +
            </button>
          </div>
        </div>
      ))}

      <DocumentationSection el={c} onChange={patch => store.updateConstraint(c.id, patch)}/>
      <PropertiesSection el={c} kind="constraint" onChange={patch => store.updateConstraint(c.id, patch)}/>
      <GroupMembershipSection id={c.id}/>

      <Section title="Usage">
        <DiagramList elementId={c.id} kind="constraint" />
      </Section>
      <div style={{ marginTop: 8 }}>
        <DangerBtn onClick={() => store.deleteConstraint(c.id)}>Delete Constraint</DangerBtn>
      </div>
    </div>
  )
}

// ── Main inspector ────────────────────────────────────────────────────────────
export default function Inspector() {
  const store = useOrmStoreIgnoring('pan', 'zoom')
  const { selectedId, selectedKind, selectedRole, selectedImplicitLink, selectedImplicitLinkRole,
          selectedUniqueness, selectedMandatoryDot, selectedInternalFrequency,
          selectedValueRange, selectedCardinalityRange } = store

  const [width, setWidth] = useState(240)
  const [resizing, setResizing] = useState(false)
  const resizeRef = useRef(null)

  const onResizeMouseDown = useCallback((e) => {
    e.preventDefault()
    resizeRef.current = { startX: e.clientX, startWidth: width }
    setResizing(true)
    document.body.style.cursor = 'ew-resize'
  }, [width])

  useEffect(() => {
    const onMove = (e) => {
      if (!resizeRef.current) return
      const dx = resizeRef.current.startX - e.clientX   // drag left → wider
      setWidth(Math.max(180, resizeRef.current.startWidth + dx))
    }
    const onUp = () => {
      if (!resizeRef.current) return
      resizeRef.current = null
      setResizing(false)
      document.body.style.cursor = ''
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [])

  useEffect(() => {
    store.setInspectorWidth(width)
  }, [width])

  const ot  = store.objectTypes.find(o => o.id === selectedId)
  const activeDiag = store.diagrams.find(d => d.id === store.activeDiagramId)
  const note = selectedKind === 'note' ? (activeDiag?.notes ?? []).find(n => n.id === selectedId) : null
  const group = selectedKind === 'group' ? store.groups.find(g => g.id === selectedId) : null
  const rawFact = store.facts.find(f => f.id === selectedId)
  // Merge per-diagram occurrence overrides so the inspector sees the same values as the canvas
  const activeDiagOccMap = Object.fromEntries(
    (store.diagrams?.find(d => d.id === store.activeDiagramId)?.occurrences ?? []).map(o => [o.schemaElementId, o])
  )
  const mergeDiagramPos = (f) => {
    if (!f) return f
    const p = activeDiagOccMap[f.id]
    if (!p) return f
    const merged = { ...f }
    if (p.readingAbove        !== undefined) merged.readingAbove        = p.readingAbove
    if (p.readingOffsetAbove  !== undefined) merged.readingOffsetAbove  = p.readingOffsetAbove
    if (p.readingOffsetBelow  !== undefined) merged.readingOffsetBelow  = p.readingOffsetBelow
    if (p.uniquenessBelow     !== undefined) merged.uniquenessBelow     = p.uniquenessBelow
    if (p.nestedReading   !== undefined) merged.nestedReading   = p.nestedReading
    if (p.roleOrder       !== undefined) merged.roleOrder       = p.roleOrder
    if (p.readingOrder    !== undefined) merged.readingOrder    = p.readingOrder
    if (p.orientation     !== undefined) merged.orientation     = p.orientation
    if (p.readingDisplay  !== undefined) merged.readingDisplay  = p.readingDisplay
    return merged
  }
  const fact = mergeDiagramPos(rawFact)
  const st   = store.subtypes.find(s => s.id === selectedId)
  const con  = store.constraints.find(c => c.id === selectedId)

  // Role inspector takes priority over fact inspector when a role is selected
  const roleFact = selectedRole ? store.facts.find(f => f.id === selectedRole.factId) : null

  // Resolve internal constraint selections to the appropriate inspector content
  let internalConstraintContent = null
  if (!selectedId && !roleFact) {
    if (selectedUniqueness) {
      const f = store.facts.find(f => f.id === selectedUniqueness.factId)
      if (f) {
        if (selectedUniqueness.implied === true) {
          internalConstraintContent = <ImpliedUniquenessBarInspector fact={f} roleIndex={selectedUniqueness.impliedRoleIndex} />
        } else if (selectedUniqueness.roleIndex !== undefined) {
          // Implicit link uniqueness
          const il = f.implicitLinks?.find(il => il.roleIndex === selectedUniqueness.roleIndex)
          if (il) {
            const synth = makeImplicitLinkFact(f, il)
            internalConstraintContent = <UniquenessBarInspector fact={synth} uIndex={selectedUniqueness.uIndex} />
          }
        } else {
          internalConstraintContent = <FactInspector fact={f} />
        }
      }
    } else if (selectedMandatoryDot) {
      const factId = selectedMandatoryDot.factId
      const roleIndex = selectedMandatoryDot.roleIndex
      if (selectedMandatoryDot.implied === true) {
        const f = store.facts.find(f => f.id === factId)
        if (f) internalConstraintContent = <ImpliedMandatoryDotInspector fact={f} roleIndex={roleIndex} />
      } else if (factId.includes('_il_')) {
        const [parentFactId, ilRoleIdxStr] = factId.split('_il_')
        const parentFact = store.facts.find(f => f.id === parentFactId)
        if (parentFact) {
          internalConstraintContent = <ImplicitLinkRoleInspector parentFact={parentFact} roleIndex={Number(ilRoleIdxStr)} ilRoleIndex={roleIndex} />
        }
      } else {
        const f = store.facts.find(f => f.id === factId)
        if (f) internalConstraintContent = <RoleInspector fact={f} roleIndex={roleIndex} />
      }
    } else if (selectedInternalFrequency) {
      const f = store.facts.find(f => f.id === selectedInternalFrequency.factId)
      if (f) {
        const ifItem = (f.internalFrequency || []).find(x => x.id === selectedInternalFrequency.ifId)
        if (ifItem) internalConstraintContent = <InternalFrequencyInspector fact={f} ifItem={ifItem} />
      } else {
        // Check if it's an implicit link frequency constraint
        const factId = selectedInternalFrequency.factId
        if (factId.includes('_il_')) {
          const parts = factId.split('_il_')
          const parentFactId = parts[0]
          const roleIndex = Number(parts[1].split('_')[0])
          const parentFact = store.facts.find(f => f.id === parentFactId)
          if (parentFact) {
            const il = parentFact.implicitLinks?.find(l => l.roleIndex === roleIndex)
            if (il) {
              const synth = makeImplicitLinkFact(parentFact, il)
              const ifItem = (synth.internalFrequency || []).find(x => x.id === selectedInternalFrequency.ifId)
              if (ifItem) internalConstraintContent = <InternalFrequencyInspector fact={synth} ifItem={ifItem} />
            }
          }
        }
      }
    } else if (selectedValueRange) {
      internalConstraintContent = <ValueRangeConstraintInspector sel={selectedValueRange} />
    } else if (selectedCardinalityRange) {
      internalConstraintContent = <CardinalityRangeInspector sel={selectedCardinalityRange} />
    }
  }

  const counts = {
    entities: store.objectTypes.filter(o => o.kind === 'entity').length,
    values:   store.objectTypes.filter(o => o.kind === 'value').length,
    facts:    store.facts.length,
    subtypes: store.subtypes.length,
    constraints: store.constraints.length,
  }

  return (
    <div style={{ width, flexShrink: 0, display: 'flex', background: 'var(--bg-surface)' }}>
    {/* Resize handle — outside the scroller so it spans the full height */}
    <Splitter orientation="v" dragging={resizing} onMouseDown={onResizeMouseDown} />
    <div style={{ flex: 1, minWidth: 0, position: 'relative', overflowY: 'auto', padding: 14 }}>

      {note && <NoteInspector note={note} />}
      {group && <GroupInspector group={group} />}
      {ot   && <ObjectTypeInspector ot={ot} />}
      {selectedKind === 'implicitLink' && fact && selectedImplicitLinkRole
        ? <ImplicitLinkRoleInspector parentFact={fact} roleIndex={selectedImplicitLinkRole.roleIndex} ilRoleIndex={selectedImplicitLinkRole.ilRoleIndex} />
        : selectedKind === 'implicitLink' && fact && selectedImplicitLink != null
        ? <ImplicitLinkInspector parentFact={fact} roleIndex={selectedImplicitLink} />
        : selectedKind === 'implicitLink' && fact
        ? <div style={{ marginBottom: 18 }}><InspectorTitle>Implicit Link</InspectorTitle><div style={{ fontSize: 12, color: 'var(--ink-muted)' }}>No implicit link data available. Try showing the link from the role context menu first.</div></div>
        : roleFact
          ? <RoleInspector fact={roleFact} roleIndex={selectedRole.roleIndex} />
          : selectedUniqueness && fact
            ? <UniquenessBarInspector fact={fact} uIndex={selectedUniqueness.uIndex} />
            : fact && <FactInspector fact={fact} />}
      {st   && <SubtypeInspector st={st} />}
      {con  && (con.constraintType === 'ring' || con.constraintType === 'exclusiveOr' || con.constraintType === 'exclusion' || con.constraintType === 'inclusiveOr' || con.constraintType === 'uniqueness' || con.constraintType === 'equality' || con.constraintType === 'subset' || con.constraintType === 'frequency' || con.constraintType === 'valueComparison')
             ? <ExternalConstraintInspector c={con} />
             : con && <ConstraintInspector c={con} />}
      {internalConstraintContent}

      {store.multiSelectedIds.length > 0 && (
        <div style={{ marginBottom: 16 }}>
          <div style={{ fontSize: 10, color: 'var(--accent)', fontWeight: 700,
            letterSpacing: '0.1em', textTransform: 'uppercase',
            borderBottom: '1px solid var(--border-soft)', paddingBottom: 5, marginBottom: 10 }}>
            Selection
          </div>
          <div style={{ fontSize: 12, color: 'var(--ink-2)', marginBottom: 8 }}>
            {store.multiSelectedIds.length} elements selected
          </div>
          <div style={{ marginBottom: 8 }}>
            <GroupPicker memberIds={store.multiSelectedIds}/>
          </div>
          <div style={{ display: 'flex', gap: 6 }}>
            <button
              onClick={() => store.clearMultiSelection()}
              style={{ fontSize: 11, padding: '3px 8px' }}>
              Clear
            </button>
            <button
              onClick={() => store.deleteMultiSelection()}
              style={{ fontSize: 11, padding: '3px 8px', cursor: 'pointer',
                background: 'transparent', color: 'var(--danger)',
                border: '1px solid var(--danger)', borderRadius: 3 }}
              onMouseEnter={e => { e.currentTarget.style.background = 'var(--danger)'; e.currentTarget.style.color = '#fff' }}
              onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'var(--danger)' }}>
              Delete all
            </button>
          </div>
        </div>
      )}

      {!selectedId && store.multiSelectedIds.length === 0 && !internalConstraintContent && (
      <div style={{ marginTop: 8 }}>
          <div style={{ fontSize: 10, color: 'var(--accent)', fontWeight: 700,
            letterSpacing: '0.1em', textTransform: 'uppercase',
            borderBottom: '1px solid var(--border-soft)', paddingBottom: 5, marginBottom: 12 }}>
            Schema Settings
          </div>

          <div style={{ marginBottom: 16 }}>
            <label style={{ fontSize: 10, color: 'var(--ink-muted)', letterSpacing: '0.08em',
              textTransform: 'uppercase', display: 'block', marginBottom: 6 }}>
              Datatype profile
            </label>
            <select
              value={store.diagrams?.find(d => d.id === store.activeDiagramId)?.profileId ?? ''}
              onChange={e => store.setDiagramProfile(e.target.value || null)}
              style={{ width: '100%', fontSize: 12, padding: '3px 6px',
                border: '1px solid var(--border)', borderRadius: 3,
                background: 'var(--bg-raised)', color: 'var(--ink-2)' }}>
              <option value="">— none —</option>
              {PROFILES.map(p => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
            <div style={{ fontSize: 10, color: 'var(--ink-muted)', marginTop: 4 }}>
              Target platform for value type datatype assignments
            </div>
          </div>

          <PropertyDefinitionsEditor/>

          <div style={{ fontSize: 10, color: 'var(--accent)', fontWeight: 700,
            letterSpacing: '0.1em', textTransform: 'uppercase',
            borderBottom: '1px solid var(--border-soft)', paddingBottom: 5, marginBottom: 12 }}>
            Display Settings
          </div>

          <div style={{ marginBottom: 6 }}>
            <label style={{ fontSize: 10, color: 'var(--ink-muted)', letterSpacing: '0.08em',
              textTransform: 'uppercase', display: 'block', marginBottom: 6 }}>
              Mandatory dot position
            </label>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
              {[
                { value: 'role',   label: 'Role-box end', sub: 'dot near the fact type' },
                { value: 'object', label: 'Object-type end', sub: 'dot near the entity/value' },
              ].map(opt => (
                <label key={opt.value} style={{
                  display: 'flex', alignItems: 'flex-start', gap: 8,
                  cursor: 'pointer', padding: '7px 9px',
                  background: store.mandatoryDotPosition === opt.value
                    ? 'var(--bg-hover)' : 'var(--bg-raised)',
                  border: `1px solid ${store.mandatoryDotPosition === opt.value
                    ? 'var(--accent)' : 'var(--border-soft)'}`,
                  borderRadius: 4, transition: 'all 0.12s',
                }}>
                  <input type="radio"
                    name="mandatoryDotPosition"
                    value={opt.value}
                    checked={store.mandatoryDotPosition === opt.value}
                    onChange={() => store.setMandatoryDotPosition(opt.value)}
                    style={{ marginTop: 2, accentColor: 'var(--accent)' }}/>
                  <div>
                    <div style={{ fontSize: 12, color: 'var(--ink-2)', fontWeight: 500 }}>
                      {opt.label}
                    </div>
                    <div style={{ fontSize: 10, color: 'var(--ink-muted)', marginTop: 1 }}>
                      {opt.sub}
                    </div>
                  </div>
                </label>
              ))}
            </div>
          </div>

          <div style={{ marginBottom: 16 }}>
            <label style={{ fontSize: 10, color: 'var(--ink-muted)', letterSpacing: '0.08em',
              textTransform: 'uppercase', display: 'block', marginBottom: 6 }}>
              Sequence membership
            </label>
            <label style={{
              display: 'flex', alignItems: 'center', gap: 8,
              cursor: 'pointer', padding: '7px 9px',
              background: 'var(--bg-raised)',
              border: '1px solid var(--border-soft)',
              borderRadius: 4, marginBottom: 8,
            }}>
              <input type="checkbox"
                checked={!!store.showSequenceMembership}
                onChange={e => store.setShowSequenceMembership(e.target.checked)}
                style={{ accentColor: 'var(--accent)' }}/>
              <div>
                <div style={{ fontSize: 12, color: 'var(--ink-2)', fontWeight: 500 }}>
                  Show membership of role sequences
                </div>
                <div style={{ fontSize: 10, color: 'var(--ink-muted)', marginTop: 1 }}>
                  Indicate the position of roles in the role sequences of the selected constraint
                </div>
              </div>
            </label>
          </div>

          <div style={{ marginBottom: 16 }}>
            <label style={{ fontSize: 10, color: 'var(--ink-muted)', letterSpacing: '0.08em',
              textTransform: 'uppercase', display: 'block', marginBottom: 6 }}>
              Role names
            </label>
            <label style={{
              display: 'flex', alignItems: 'center', gap: 8,
              cursor: 'pointer', padding: '7px 9px',
              background: 'var(--bg-raised)',
              border: '1px solid var(--border-soft)',
              borderRadius: 4, marginBottom: 8,
            }}>
              <input type="checkbox"
                checked={!!store.showRoleNames}
                onChange={e => store.setShowRoleNames(e.target.checked)}
                style={{ accentColor: 'var(--accent)' }}/>
              <div>
                <div style={{ fontSize: 12, color: 'var(--ink-2)', fontWeight: 500 }}>
                  Show role names
                </div>
                <div style={{ fontSize: 10, color: 'var(--ink-muted)', marginTop: 1 }}>
                  Display [name] labels on connector edges
                </div>
              </div>
            </label>
          </div>


          <div style={{ marginBottom: 16 }}>
            <label style={{ fontSize: 10, color: 'var(--ink-muted)', letterSpacing: '0.08em',
              textTransform: 'uppercase', display: 'block', marginBottom: 6 }}>
              Constraint queries
            </label>
            <label style={{
              display: 'flex', alignItems: 'center', gap: 8,
              cursor: 'pointer', padding: '7px 9px',
              background: 'var(--bg-raised)',
              border: '1px solid var(--border-soft)',
              borderRadius: 4, marginBottom: 8,
            }}>
              <input type="checkbox"
                checked={!!store.showConstraintQueries}
                onChange={e => store.setShowConstraintQueries(e.target.checked)}
                style={{ accentColor: 'var(--accent)' }}/>
              <div>
                <div style={{ fontSize: 12, color: 'var(--ink-2)', fontWeight: 500 }}>
                  Highlight queries on selection
                </div>
                <div style={{ fontSize: 10, color: 'var(--ink-muted)', marginTop: 1 }}>
                  Highlight the query pattern of the selected constraint in the diagram
                </div>
              </div>
            </label>
          </div>

          <div style={{ marginBottom: 16 }}>
            <label style={{ fontSize: 10, color: 'var(--ink-muted)', letterSpacing: '0.08em',
              textTransform: 'uppercase', display: 'block', marginBottom: 6 }}>
              Reference mode
            </label>
            <label style={{
              display: 'flex', alignItems: 'center', gap: 8,
              cursor: 'pointer', padding: '7px 9px',
              background: 'var(--bg-raised)',
              border: '1px solid var(--border-soft)',
              borderRadius: 4,
            }}>
              <input type="checkbox"
                checked={!!store.showReferenceMode}
                onChange={e => store.setShowReferenceMode(e.target.checked)}
                style={{ accentColor: 'var(--accent)' }}/>
              <div>
                <div style={{ fontSize: 12, color: 'var(--ink-2)', fontWeight: 500 }}>
                  Show reference mode
                </div>
                <div style={{ fontSize: 10, color: 'var(--ink-muted)', marginTop: 1 }}>
                  Display (id), (name), etc. inside nodes
                </div>
              </div>
            </label>
          </div>

          {/* ── Validation ── */}
          <div style={{ fontSize: 10, color: 'var(--accent)', fontWeight: 700,
            letterSpacing: '0.1em', textTransform: 'uppercase',
            borderBottom: '1px solid var(--border-soft)', paddingBottom: 5, marginBottom: 12, marginTop: 8 }}>
            Validation
          </div>

          <div style={{ marginBottom: 12 }}>
            <label style={{ fontSize: 10, color: 'var(--ink-muted)', letterSpacing: '0.08em',
              textTransform: 'uppercase', display: 'block', marginBottom: 6 }}>
              Active checks
            </label>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
              {Object.entries(VALIDATION_CATEGORIES).map(([key, cat]) => (
                <label key={key} style={{
                  display: 'flex', alignItems: 'flex-start', gap: 8,
                  cursor: 'pointer', padding: '7px 9px',
                  background: 'var(--bg-raised)', border: '1px solid var(--border-soft)',
                  borderRadius: 4,
                }}>
                  <input type="checkbox"
                    checked={!!store.validationCategories[key]}
                    onChange={() => store.toggleValidationCategory(key)}
                    style={{ marginTop: 2, accentColor: 'var(--accent)' }}/>
                  <div>
                    <div style={{ fontSize: 12, color: 'var(--ink-2)', fontWeight: 500 }}>{cat.label}</div>
                    <div style={{ fontSize: 10, color: 'var(--ink-muted)', marginTop: 1 }}>{cat.description}</div>
                  </div>
                </label>
              ))}
            </div>
          </div>

          <div style={{ color: 'var(--ink-muted)', fontSize: 11, marginTop: 20,
            textAlign: 'center', lineHeight: 1.7 }}>
            <div style={{ fontSize: 22, marginBottom: 8, color: 'var(--border)' }}>◈</div>
            Select an element<br/>to inspect it
          </div>
        </div>
      )}

      {/* Summary footer */}
      <div style={{ position: 'sticky', bottom: 0, marginTop: 'auto',
        paddingTop: 10, borderTop: '1px solid var(--border-soft)',
        background: 'var(--bg-surface)', fontSize: 10, color: 'var(--ink-muted)',
        lineHeight: 1.8 }}>
        <div>{counts.entities} entities · {counts.values} values</div>
        <div>{counts.facts} facts · {counts.subtypes} subtypes</div>
        <div>{counts.constraints} constraints</div>
        {store.filePath && (
          <div style={{ marginTop: 2, fontSize: 10, overflow: 'hidden',
            textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={store.filePath}>
            {store.filePath.split(/[\\/]/).pop()}
            {store.isDirty ? ' *' : ' ✓'}
          </div>
        )}
      </div>
    </div>
    </div>
  )
}
