import React, { useState, useRef, useCallback, useLayoutEffect, useEffect } from 'react'
import { useOrmStore } from '../store/ormStore'
import { getDisplayReading } from './FactTypeNode'
import { RingMiniSymbol } from './ConstraintNodes'
import { formatValueRange, formatCardinalityRange, formatFrequencyRange } from './ObjectTypeNode'
import { PROFILES, PROFILE_MAP, getDatatypeById } from '../data/datatypeProfiles'

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

// ── Diagrams-containing list ─────────────────────────────────────────────────
// Shows which diagrams contain the given element, in tab order.
// subtypeEndpointIds: [subId, superId] — for subtypes both endpoints must be in the diagram.
function DiagramList({ elementId, kind, subtypeEndpointIds }) {
  const store = useOrmStore()
  const { diagrams } = store
  const containing = diagrams.filter(d => {
    if (subtypeEndpointIds) {
      const [a, b] = subtypeEndpointIds
      return d.elementIds === null ||
        ((d.elementIds ?? []).includes(a) && (d.elementIds ?? []).includes(b))
    }
    return d.elementIds === null || (d.elementIds ?? []).includes(elementId)
  })
  const handleClick = (d) => {
    store.setActiveDiagram(d.id)
    store.select(elementId, kind)
  }
  return (
    <Row>
      <Label>Appears in</Label>
      {containing.length === 0 ? (
        <span style={{ fontSize: 11, color: '#c0392b', fontStyle: 'italic' }}>
          not in any diagram (orphaned)
        </span>
      ) : (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
          {containing.map(d => (
            <span key={d.id} onClick={() => handleClick(d)}
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
  )
}

function TInput({ value, onChange, placeholder }) {
  return <input value={value ?? ''} onChange={e => onChange(e.target.value)}
    placeholder={placeholder} style={{ width: '100%' }} />
}

function Checkbox({ label, checked, onChange, disabled = false }) {
  return (
    <label style={{ display: 'flex', alignItems: 'center', gap: 7,
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

function DangerBtn({ onClick, children }) {
  return (
    <button onClick={onClick} style={{ background: 'transparent', color: '#c0392b',
      border: '1px solid #c0392b', borderRadius: 3, padding: '4px 10px', fontSize: 11 }}>
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

export function ValueRangeEditor({ range, onChange, naturalNumbers = false, positiveIntegers = false }) {
  const specs = range || []
  const [dragIdx, setDragIdx] = useState(null)
  const [overIdx, setOverIdx] = useState(null)

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
    commit(specs.map((s, j) => j === i ? base : s))
  }

  const handleDrop = (targetIdx) => {
    if (dragIdx === null || dragIdx === targetIdx) return
    const next = [...specs]
    const [moved] = next.splice(dragIdx, 1)
    next.splice(targetIdx, 0, moved)
    commit(next)
    setDragIdx(null)
    setOverIdx(null)
  }

  const inputStyle = { fontSize: 11, padding: '2px 4px', flex: 1, minWidth: 0 }
  const sepStyle = { fontSize: 11, color: 'var(--ink-muted)', flexShrink: 0, padding: '0 2px' }
  const numProps = positiveIntegers ? { type: 'number', min: 1, step: 1 }
    : naturalNumbers ? { type: 'number', min: 0, step: 1 } : {}

  return (
    <div>
      {specs.map((spec, i) => (
        <div key={i}
          draggable
          onDragStart={() => setDragIdx(i)}
          onDragOver={e => { e.preventDefault(); setOverIdx(i) }}
          onDragLeave={() => setOverIdx(null)}
          onDrop={() => handleDrop(i)}
          onDragEnd={() => { setDragIdx(null); setOverIdx(null) }}
          style={{
            display: 'flex', gap: 3, marginBottom: 4, alignItems: 'center',
            opacity: dragIdx === i ? 0.4 : 1,
            outline: overIdx === i && dragIdx !== i ? '1px dashed var(--accent)' : 'none',
            borderRadius: 3,
          }}>
          <span style={{ cursor: 'grab', color: 'var(--ink-muted)', fontSize: 11,
            flexShrink: 0, paddingRight: 1, userSelect: 'none' }}>⠿</span>
          <select value={spec.type} onChange={e => changeType(i, e.target.value)}
            style={{ fontSize: 11, flexShrink: 0 }}>
            {VR_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
          </select>

          {spec.type === 'single' && (
            <input {...numProps} value={spec.value ?? ''} placeholder="value"
              onChange={e => updateSpec(i, { value: e.target.value })}
              style={inputStyle}/>
          )}
          {(spec.type === 'lower' || spec.type === 'range') && (
            <input {...numProps} value={spec.lower ?? ''} placeholder="lower"
              onChange={e => updateSpec(i, { lower: e.target.value })}
              style={inputStyle}/>
          )}
          {(spec.type === 'lower' || spec.type === 'upper' || spec.type === 'range') && (
            <span style={sepStyle}>..</span>
          )}
          {(spec.type === 'upper' || spec.type === 'range') && (
            <input {...numProps} value={spec.upper ?? ''} placeholder="upper"
              onChange={e => updateSpec(i, { upper: e.target.value })}
              style={inputStyle}/>
          )}

          <button onClick={() => removeSpec(i)}
            style={{ background: 'none', border: 'none', color: '#c0392b',
              cursor: 'pointer', fontSize: 13, padding: '0 2px', flexShrink: 0 }}>
            ✕
          </button>
        </div>
      ))}
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
  const store = useOrmStore()
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
          <span style={{ fontSize: 11, color: '#c0392b' }}>
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
            fontSize: 11, color: '#c0392b',
            background: '#fdf0ee', border: '1px solid #e8b4ae',
            borderRadius: 3, padding: '5px 8px', marginBottom: 4,
          }}>
            &ldquo;{assignment.datatypeId}&rdquo; is from profile &ldquo;{PROFILE_MAP[assignment.profileId]?.name ?? assignment.profileId}&rdquo;,
            current profile is &ldquo;{profile?.name ?? profileId}&rdquo;.
          </div>
          <button
            onClick={() => onSet(null)}
            style={{ fontSize: 11, padding: '3px 8px', color: '#c0392b',
              background: 'transparent', border: '1px solid #c0392b', borderRadius: 3, cursor: 'pointer' }}>
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
  const store = useOrmStore()
  return (
    <div style={{ marginBottom: 18 }}>
      <InspectorTitle>{ot.kind === 'entity' ? 'Entity Type' : 'Value Type'}</InspectorTitle>
      <Row>
        <Label>Name</Label>
        <TInput value={ot.name} onChange={v => store.updateObjectType(ot.id, { name: v })}/>
      </Row>
      {ot.kind === 'entity' && (
        <Row>
          <Label>Reference Mode</Label>
          <TInput value={ot.refMode || ''} placeholder="id / name / none"
            onChange={v => store.updateObjectType(ot.id, { refMode: v })}/>
        </Row>
      )}
      {(ot.kind === 'value' || (ot.kind === 'entity' && ot.refMode && ot.refMode !== 'none')) && (
        <DatatypeField
          assignment={ot.datatypeAssignment}
          onSet={a => store.setValueTypeDatatype(ot.id, a)}
        />
      )}

      <Section title="Constraints">
        {(ot.kind === 'value' || (ot.kind === 'entity' && ot.refMode && ot.refMode !== 'none')) && (
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

      <Section title="Usage">
        <DiagramList elementId={ot.id} kind={ot.kind} />
      </Section>

      <DangerBtn onClick={() => store.deleteObjectType(ot.id)}>
        Delete {ot.kind === 'entity' ? 'Entity' : 'Value'} Type
      </DangerBtn>
    </div>
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
      <span style={{ fontSize: 10, color: 'var(--accent)', flexShrink: 0 }}>→</span>
    </div>
  )
}

// ── Shared role constraints section (used in RoleList and RoleInspector) ─────
function RoleConstraintsSection({ role, onChange, onNavigateValueRange, onNavigateCardinalityRange }) {
  return (
    <Section title="Constraints">
      <Label>Participation</Label>
      <Checkbox label="Mandatory" checked={role.mandatory}
        onChange={v => onChange({ mandatory: v })} />
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

// ── Draggable role list ───────────────────────────────────────────────────────
function RoleList({ fact, store }) {
  // dragIndex: which role card is being dragged
  // overIndex: which slot the ghost is currently hovering
  const [dragIndex, setDragIndex] = useState(null)
  const [overIndex, setOverIndex] = useState(null)
  const listRef = useRef(null)

  const handleDragStart = useCallback((e, ri) => {
    // Use the HTML drag-and-drop API; set drag image to the card itself
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/plain', String(ri))
    setDragIndex(ri)
  }, [])

  const handleDragOver = useCallback((e, ri) => {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    setOverIndex(ri)
  }, [])

  const handleDrop = useCallback((e, ri) => {
    e.preventDefault()
    const from = dragIndex
    if (from !== null && from !== ri) {
      store.reorderRoles(fact.id, from, ri)
    }
    setDragIndex(null)
    setOverIndex(null)
  }, [dragIndex, fact.id, store])

  const handleDragEnd = useCallback(() => {
    setDragIndex(null)
    setOverIndex(null)
  }, [])

  return (
    <div ref={listRef}>
      {fact.roles.map((role, ri) => {
        const isDragging = dragIndex === ri
        const isOver     = overIndex === ri && dragIndex !== ri
        return (
          <div
            key={role.id}
            draggable
            onDragStart={e => handleDragStart(e, ri)}
            onDragOver={e  => handleDragOver(e, ri)}
            onDrop={e      => handleDrop(e, ri)}
            onDragEnd={handleDragEnd}
            style={{
              background: 'var(--bg-raised)',
              border: `1px solid ${isOver ? 'var(--accent)' : 'var(--border-soft)'}`,
              borderRadius: 4,
              padding: 8,
              marginBottom: 8,
              opacity: isDragging ? 0.35 : 1,
              boxShadow: isOver ? '0 0 0 2px var(--selection)' : 'none',
              transition: 'border-color 0.1s, box-shadow 0.1s, opacity 0.1s',
              cursor: 'grab',
            }}
          >
            {/* Header row: drag handle + role label */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
              <span
                title="Drag to reorder"
                style={{
                  fontSize: 13, color: 'var(--ink-muted)', lineHeight: 1,
                  cursor: 'grab', userSelect: 'none', flexShrink: 0,
                }}>⠿</span>
              <span style={{ fontSize: 10, color: 'var(--ink-muted)',
                textTransform: 'uppercase', letterSpacing: '0.07em', flex: 1 }}>
                Role {ri + 1}
              </span>
            </div>

            <Row>
              <Label>Object Type</Label>
              <select value={role.objectTypeId || ''} style={{ width: '100%' }}
                onChange={e => store.assignObjectTypeToRole(fact.id, ri, e.target.value || null)}
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
                onChange={v => store.updateRole(fact.id, ri, { roleName: v })}/>
            </Row>
            <RoleConstraintsSection
              role={role}
              onChange={patch => store.updateRole(fact.id, ri, patch)}
            />
          </div>
        )
      })}
    </div>
  )
}

// ── Compact role list (fact inspector — drag to reorder, click to inspect) ────
function CompactRoleList({ fact, store }) {
  const [dragIndex, setDragIndex] = useState(null)
  const [overIndex, setOverIndex] = useState(null)
  const otMap     = Object.fromEntries(store.objectTypes.map(o => [o.id, o]))
  const nestedMap = Object.fromEntries(store.facts.filter(f => f.objectified).map(f => [f.id, f]))

  const handleDragStart = useCallback((e, ri) => {
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/plain', String(ri))
    setDragIndex(ri)
  }, [])

  const handleDragOver = useCallback((e, ri) => {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    setOverIndex(ri)
  }, [])

  const handleDrop = useCallback((e, ri) => {
    e.preventDefault()
    if (dragIndex !== null && dragIndex !== ri) store.reorderRoles(fact.id, dragIndex, ri)
    setDragIndex(null)
    setOverIndex(null)
  }, [dragIndex, fact.id, store])

  const handleDragEnd = useCallback(() => {
    setDragIndex(null)
    setOverIndex(null)
  }, [])

  return (
    <div>
      {fact.roles.map((role, ri) => {
        const ot       = otMap[role.objectTypeId]
        const nf       = !ot ? nestedMap[role.objectTypeId] : null
        const player   = ot ? ot.name : nf ? nf.objectifiedName : null
        const isDragging = dragIndex === ri
        const isOver     = overIndex === ri && dragIndex !== ri
        return (
          <div
            key={role.id}
            draggable
            onDragStart={e => handleDragStart(e, ri)}
            onDragOver={e  => handleDragOver(e, ri)}
            onDrop={e      => handleDrop(e, ri)}
            onDragEnd={handleDragEnd}
            onClick={() => store.selectRole(fact.id, ri)}
            style={{
              display: 'flex', alignItems: 'center', gap: 6,
              background: 'var(--bg-raised)',
              border: `1px solid ${isOver ? 'var(--accent)' : 'var(--border-soft)'}`,
              borderRadius: 4, padding: '5px 8px', marginBottom: 5,
              opacity: isDragging ? 0.35 : 1,
              boxShadow: isOver ? '0 0 0 2px var(--selection)' : 'none',
              cursor: 'grab', userSelect: 'none',
            }}
          >
            <span style={{ fontSize: 13, color: 'var(--ink-muted)', lineHeight: 1, flexShrink: 0 }}>⠿</span>
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
          </div>
        )
      })}
    </div>
  )
}

// ── Role inspector ────────────────────────────────────────────────────────────
function RoleInspector({ fact, roleIndex }) {
  const store = useOrmStore()
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
      <Label>Usage</Label>
      <DangerBtn onClick={() => { store.deleteRole(fact.id, roleIndex); store.select(fact.id, 'fact') }}>
        Delete Role
      </DangerBtn>
    </div>
  )
}

// ── Internal Uniqueness Bar inspector ────────────────────────────────────────
function UniquenessBarInspector({ fact, uIndex }) {
  const store = useOrmStore()
  const u = fact.uniqueness[uIndex]
  if (!u) return null

  const otMap      = Object.fromEntries(store.objectTypes.map(o => [o.id, o]))
  const nestedMap  = Object.fromEntries(store.facts.filter(f => f.objectified).map(f => [f.id, f]))
  const sortedKey  = JSON.stringify([...u].sort())
  const isPreferred = fact.preferredUniqueness != null &&
    JSON.stringify([...fact.preferredUniqueness].sort()) === sortedKey
  const reading = getDisplayReading(fact) || null

  const toggleRole = (ri) => {
    const next = u.includes(ri) ? u.filter(i => i !== ri) : [...u, ri]
    if (next.length === 0) return   // must cover at least one role
    store.updateUniquenessRoles(fact.id, uIndex, next)
  }

  return (
    <div style={{ marginBottom: 18 }}>
      <InspectorTitle>Internal Uniqueness</InspectorTitle>
      <div style={{ marginBottom: 10 }}>
        <button onClick={() => store.select(fact.id, 'fact')}
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
              disabled={isLast}
              onChange={() => toggleRole(ri)}
            />
          )
        })}
      </Row>
      <Row>
        <Checkbox
          label="Preferred Identifier"
          checked={isPreferred}
          onChange={() => store.setPreferredUniqueness(fact.id, u)}
        />
      </Row>
      <div style={{ marginTop: 8 }}>
        <DangerBtn onClick={() => { store.toggleUniqueness(fact.id, u); store.select(fact.id, 'fact') }}>
          Delete
        </DangerBtn>
      </div>
    </div>
  )
}

// ── Internal Frequency Constraint inspector ───────────────────────────────────
function InternalFrequencyInspector({ fact, ifItem }) {
  const store   = useOrmStore()
  const otMap   = Object.fromEntries(store.objectTypes.map(o => [o.id, o]))
  const nestedMap = Object.fromEntries(store.facts.filter(f => f.objectified).map(f => [f.id, f]))
  const reading = getDisplayReading(fact) || null

  const toggleRole = (ri) => {
    const next = ifItem.roles.includes(ri)
      ? ifItem.roles.filter(i => i !== ri)
      : [...ifItem.roles, ri]
    if (next.length === 0) return   // must cover at least one role
    store.updateInternalFrequency(fact.id, ifItem.id, { roles: next })
  }

  return (
    <div style={{ marginBottom: 18 }}>
      <InspectorTitle>Frequency Range</InspectorTitle>
      <div style={{ marginBottom: 10 }}>
        <button onClick={() => store.select(fact.id, 'fact')}
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
              disabled={isLast}
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
      <div style={{ marginTop: 8 }}>
        <Label>Usage</Label>
        <DangerBtn onClick={() => { store.removeInternalFrequency(fact.id, ifItem.id); store.select(fact.id, 'fact') }}>
          Delete Frequency Range
        </DangerBtn>
      </div>
    </div>
  )
}

// ── Shared helper: resolve a value/cardinality range selection to display info ─
function useRangeSelectionInfo(sel) {
  const store = useOrmStore()
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
    return {
      label: `Role ${sel.roleIndex + 1} of ${reading}`,
      backLabel: `Role ${sel.roleIndex + 1}`,
      onBack: () => store.selectRole(f.id, sel.roleIndex),
      valueRange:      role.valueRange,
      cardinalityRange: role.cardinalityRange,
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
        />
      </Row>
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
function ReadingEditor({ fact, store, parts, roleOrder, onUpdatePart }) {
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
                color: 'var(--ink-2)', fontSize: 12, fontFamily: FONT,
                padding: '0 4px', margin: 0, boxSizing: 'border-box',
              }}
            />
          </span>
          {i < n && (() => {
            const oid = fact.roles[roleOrder[i]]?.objectTypeId
            const ot  = otMap[oid]
            const nf  = nestedMap[oid]
            const name  = ot?.name ?? nf?.objectifiedName ?? '?'
            const isValue = ot?.kind === 'value' || nf?.objectifiedKind === 'value'
            const color = isValue ? 'var(--col-value)' : 'var(--col-entity)'
            return (
              <span style={{
                color, fontSize: 12, fontFamily: FONT, fontWeight: 700,
                userSelect: 'none', whiteSpace: 'nowrap',
                paddingLeft: '0.35em', paddingRight: '0.35em',
              }}>
                {name}
              </span>
            )
          })()}
        </React.Fragment>
      ))}
    </div>
  )
}

// ── Fact presentation subsection ─────────────────────────────────────────────
function FactPresentationSubsection({ fact, store }) {
  return (
    <Section title="Presentation">
      {fact.arity === 2 && (
        <Row>
          <Label>Reading display</Label>
          {[
            { value: 'forward', label: 'Forward only' },
            { value: 'both',    label: 'Forward / Reverse' },
            { value: 'reverse', label: '◂  Reverse only' },
          ].map(opt => (
            <label key={opt.value} style={{
              display: 'flex', alignItems: 'center', gap: 6,
              fontSize: 12, color: 'var(--ink-2)', cursor: 'pointer', marginBottom: 3,
            }}>
              <input type="radio"
                name={`rdisplay-${fact.id}`}
                value={opt.value}
                checked={(fact.readingDisplay || 'forward') === opt.value}
                onChange={() => store.updateFact(fact.id, { readingDisplay: opt.value })}
                style={{ width: 'auto', padding: 0, border: 'none', accentColor: 'var(--accent)' }}
              />
              {opt.label}
            </label>
          ))}
        </Row>
      )}
      <Row>
        <Label>Spatial Ordering</Label>
        {fact.objectified && (
          <Checkbox
            label="Nested Reading"
            checked={!!fact.nestedReading}
            disabled={fact.orientation === 'vertical'}
            onChange={v => {
              const patch = { nestedReading: v }
              if (!v && fact.readingAbove) { patch.readingAbove = false; patch.readingOffset = null }
              store.updateFact(fact.id, patch)
            }}
          />
        )}
        <Checkbox
          label="Vertical"
          checked={fact.orientation === 'vertical'}
          onChange={v => {
            const patch = { orientation: v ? 'vertical' : 'horizontal', readingOffset: null }
            if (v && fact.nestedReading) patch.nestedReading = false
            store.updateFact(fact.id, patch)
          }}
        />
      </Row>
      <Row>
        <Checkbox
          label={fact.orientation === 'vertical' ? 'Reading right' : 'Reading above'}
          checked={!!fact.readingAbove}
          disabled={fact.objectified && fact.orientation !== 'vertical' && !fact.nestedReading}
          onChange={v => store.updateFact(fact.id, { readingAbove: v, readingOffset: null })}
        />
        <Checkbox
          label="Uniqueness below"
          checked={!!fact.uniquenessBelow}
          onChange={v => store.updateFactLayout(fact.id, { uniquenessBelow: v })}
        />
      </Row>
    </Section>
  )
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
        const isPreferred = fact.preferredUniqueness != null &&
          JSON.stringify([...fact.preferredUniqueness].sort()) === JSON.stringify([...u].sort())
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
            <span style={{ fontSize: 10, color: 'var(--accent)', flexShrink: 0 }}>→</span>
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

      {fact.objectified && fact.objectifiedKind === 'value' && (
        <Row>
          <Label>Value Range</Label>
          <RangeChip range={fact.valueRange}
            onClick={() => store.selectValueRange({ nestedFactId: fact.id })} />
        </Row>
      )}

      {fact.objectified && fact.objectifiedKind === 'entity' && fact.objectifiedRefMode && fact.objectifiedRefMode !== 'none' && (
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
            <span style={{ fontSize: 10, color: 'var(--accent)', flexShrink: 0 }}>→</span>
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
  const store = useOrmStore()
  const [selectedPerm, setSelectedPerm] = useState('')

  // Shared: arity + readings + display options
  const factTypeSection = (
    <div style={{ marginBottom: 18 }}>
      {!fact.objectified && <InspectorTitle>Fact Type ({fact.arity}-ary)</InspectorTitle>}
      {/* Arity control */}
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
          <div style={{ fontSize: 10, color: '#c0392b', marginTop: 4 }}>
            Roles trimmed — reassign object types as needed
          </div>
        )}
      </Row>

      {/* Primary reading */}
      {(() => {
        const defaultOrder = Array.from({ length: fact.arity }, (_, i) => i)
        const parts = fact.readingParts || Array(fact.arity + 1).fill('')
        return (
          <Row>
            <Label>Reading</Label>
            <ReadingEditor
              fact={fact} store={store}
              parts={parts}
              roleOrder={defaultOrder}
              onUpdatePart={(i, val) => {
                const newParts = [...parts]
                newParts[i] = val
                store.updateFact(fact.id, { readingParts: newParts })
              }}
            />
          </Row>
        )
      })()}

      {/* Alternative readings */}
      {(fact.alternativeReadings || []).map(alt => {
        const orderKey = JSON.stringify(alt.roleOrder)
        const label = '(' + alt.roleOrder.map(i => i + 1).join(', ') + ')'
        return (
          <Row key={orderKey}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 3 }}>
              <Label>Reading {label}</Label>
              <button onClick={() => store.removeAlternativeReading(fact.id, alt.roleOrder)}
                style={{ background: 'none', color: '#c0392b', border: 'none', cursor: 'pointer', fontSize: 12, padding: 0 }}>✕</button>
            </div>
            <ReadingEditor
              fact={fact} store={store}
              parts={alt.parts}
              roleOrder={alt.roleOrder}
              onUpdatePart={(i, val) => {
                const newParts = [...alt.parts]
                newParts[i] = val
                store.updateAlternativeReading(fact.id, alt.roleOrder, newParts)
              }}
            />
          </Row>
        )
      })}

      {/* Add alternative reading */}
      {fact.arity >= 2 && (() => {
        const allPerms = generatePermutations(fact.arity)
        const defaultKey = JSON.stringify(Array.from({ length: fact.arity }, (_, i) => i))
        const usedKeys = new Set([
          defaultKey,
          ...(fact.alternativeReadings || []).map(r => JSON.stringify(r.roleOrder)),
        ])
        const available = allPerms.filter(p => !usedKeys.has(JSON.stringify(p)))
        if (available.length === 0) return null
        const effectiveSel = available.some(p => JSON.stringify(p) === selectedPerm)
          ? selectedPerm
          : JSON.stringify(available[0])
        return (
          <div style={{ display: 'flex', gap: 4, marginBottom: 8 }}>
            <select value={effectiveSel} onChange={e => setSelectedPerm(e.target.value)}
              style={{ flex: 1, fontSize: 11 }}>
              {available.map(p => {
                const key = JSON.stringify(p)
                return <option key={key} value={key}>({p.map(i => i + 1).join(', ')})</option>
              })}
            </select>
            <button
              onClick={() => {
                const roleOrder = JSON.parse(effectiveSel)
                store.updateAlternativeReading(fact.id, roleOrder, Array(fact.arity + 1).fill(''))
                setSelectedPerm('')
              }}
              style={{ padding: '2px 8px', fontSize: 11, background: 'var(--bg-raised)',
                border: '1px solid var(--border)', borderRadius: 3, cursor: 'pointer' }}>
              + Add reading
            </button>
          </div>
        )
      })()}

      {/* Roles */}
      <Row>
        <Label>Roles</Label>
        <CompactRoleList fact={fact} store={store} />
      </Row>

      <FactPresentationSubsection fact={fact} store={store} />
      <FactConstraintsSubsection fact={fact} store={store} />

      <Section title="Usage">
        <DiagramList elementId={fact.id} kind="fact" />
      </Section>
      <DangerBtn onClick={() => store.deleteFact(fact.id)}>
        {fact.objectified
          ? (fact.objectifiedKind === 'value' ? 'Delete Nested Value Type' : 'Delete Nested Entity Type')
          : 'Delete Fact Type'}
      </DangerBtn>
    </div>
  )

  return (
    <>
      {fact.objectified ? (
        <>
          {/* Object-type identity */}
          <div style={{ marginBottom: 18 }}>
            <InspectorTitle>Nested {fact.objectifiedKind === 'value' ? 'Value' : 'Entity'} Type</InspectorTitle>
            <Row>
              <Label>{fact.objectifiedKind === 'value' ? 'Value Name' : 'Entity Name'}</Label>
              <TInput value={fact.objectifiedName || ''} placeholder="Name"
                onChange={v => store.updateFact(fact.id, { objectifiedName: v })}/>
            </Row>
            {fact.objectifiedKind === 'value' && (
              <DatatypeField
                assignment={fact.datatypeAssignment}
                onSet={a => store.updateFact(fact.id, { datatypeAssignment: a })}
              />
            )}
            {fact.objectifiedKind !== 'value' && (
              <Row>
                <Label>Reference Mode</Label>
                <TInput value={fact.objectifiedRefMode || ''} placeholder="id / name / none"
                  onChange={v => store.updateFact(fact.id, { objectifiedRefMode: v })}/>
              </Row>
            )}
            {fact.objectifiedKind !== 'value' && fact.objectifiedRefMode && fact.objectifiedRefMode !== 'none' && (
              <DatatypeField
                assignment={fact.datatypeAssignment}
                onSet={a => store.updateFact(fact.id, { datatypeAssignment: a })}
              />
            )}
          </div>

          {/* Fact-type structure */}
          {factTypeSection}
        </>
      ) : factTypeSection}

    </>
  )
}

// ── Subtype inspector ─────────────────────────────────────────────────────────
function SubtypeInspector({ st }) {
  const store = useOrmStore()
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
  const store      = useOrmStore()
  const gc         = store.sequenceConstruction?.constraintId === c.id ? store.sequenceConstruction : null
  const subtypeMap = Object.fromEntries(store.subtypes.map(st => [st.id, st]))
  const otMap      = Object.fromEntries(store.objectTypes.map(o => [o.id, o]))
  const factMap    = Object.fromEntries(store.facts.map(f => [f.id, f]))
  const sequences  = c.sequences || []
  const posCount   = sequences[0]?.length ?? 0
  const [pressedHeader, setPressedHeader] = useState(null)
  const [pressedSequence, setPressedSequence] = useState(null)
  const [pressedCell, setPressedCell] = useState(null)

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

  // Clear highlight on global mouse-up — registered once; reads store via ref.
  const storeRef = useRef(null)
  storeRef.current = store
  useEffect(() => {
    const up = () => storeRef.current.clearConstraintHighlight()
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

      {/* Is Preferred Identifier — only for uniqueness */}
      {c.constraintType === 'uniqueness' && (
        <Row>
          <Label>Identification</Label>
          <Checkbox
            label="Is Preferred Identifier"
            checked={!!c.isPreferredIdentifier}
            onChange={v => store.updateConstraint(c.id, { isPreferredIdentifier: v })}
          />
        </Row>
      )}

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

      {/* Target Object Type — only for inclusiveOr / exclusiveOr / uniqueness / frequency / valueComparison */}
      {(c.constraintType === 'inclusiveOr' || c.constraintType === 'exclusiveOr' || c.constraintType === 'uniqueness' || c.constraintType === 'frequency' || c.constraintType === 'valueComparison') && (
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
            : <div style={{ opacity: 0.85 }}>Click a role box or subtype relationship on the canvas · Enter to commit.</div>
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
                    cursor: 'pointer', flexShrink: 0, color: '#c0392b' }}>
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
                  background: 'var(--bg-raised)', border: '1px solid var(--border)',
                  borderRadius: 3, cursor: 'pointer', color: '#c0392b' }}>
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
          {!(c.constraintType === 'ring' && sequences.length >= 1) && (
            <button onClick={() => store.startSequenceConstruction(c.id, 'newSequence')} style={btnStyle}>
              + Add sequence
            </button>
          )}
          {sequences.length > 0 && c.constraintType !== 'inclusiveOr' && c.constraintType !== 'exclusiveOr' && c.constraintType !== 'ring' && (
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

      <Section title="Usage">
        <DiagramList elementId={c.id} kind="constraint" />
      </Section>
      <DangerBtn onClick={() => store.deleteConstraint(c.id)}>Delete Constraint</DangerBtn>
    </div>
  )
}

// ── Constraint inspector ──────────────────────────────────────────────────────
function ConstraintInspector({ c }) {
  const store = useOrmStore()
  const factMap = Object.fromEntries(store.facts.map(f => [f.id, f]))

  return (
    <div style={{ marginBottom: 18 }}>
      <InspectorTitle>{c.constraintType.charAt(0).toUpperCase() + c.constraintType.slice(1)} Constraint</InspectorTitle>

      {c.constraintType === 'frequency' && (
        <>
          <Row>
            <Label>Min frequency</Label>
            <input type="number" min={0} value={c.frequency.min} style={{ width: '100%' }}
              onChange={e => store.updateConstraint(c.id,
                { frequency: { ...c.frequency, min: +e.target.value } })}/>
          </Row>
          <Row>
            <Label>Max frequency (blank = unbounded)</Label>
            <input type="number" min={1} value={c.frequency.max ?? ''} style={{ width: '100%' }}
              placeholder="∞"
              onChange={e => store.updateConstraint(c.id,
                { frequency: { ...c.frequency, max: e.target.value === '' ? null : +e.target.value } })}/>
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
  const store = useOrmStore()
  const { selectedId, selectedKind, selectedRole,
          selectedUniqueness, selectedMandatoryDot, selectedInternalFrequency,
          selectedValueRange, selectedCardinalityRange } = store

  const [width, setWidth] = useState(240)
  const resizeRef = useRef(null)

  const onResizeMouseDown = useCallback((e) => {
    e.preventDefault()
    resizeRef.current = { startX: e.clientX, startWidth: width }
  }, [width])

  useEffect(() => {
    const onMove = (e) => {
      if (!resizeRef.current) return
      const dx = resizeRef.current.startX - e.clientX   // drag left → wider
      setWidth(Math.max(180, resizeRef.current.startWidth + dx))
    }
    const onUp = () => { resizeRef.current = null }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [])

  const ot  = store.objectTypes.find(o => o.id === selectedId)
  const rawFact = store.facts.find(f => f.id === selectedId)
  // Merge per-diagram position overrides so the inspector sees the same values as the canvas
  const activeDiagramPos = store.diagrams?.find(d => d.id === store.activeDiagramId)?.positions ?? {}
  const mergeDiagramPos = (f) => {
    if (!f) return f
    const p = activeDiagramPos[f.id]
    if (!p) return f
    const merged = { ...f }
    if (p.readingAbove    !== undefined) merged.readingAbove    = p.readingAbove
    if (p.readingOffset   !== undefined) merged.readingOffset   = p.readingOffset
    if (p.uniquenessBelow !== undefined) merged.uniquenessBelow = p.uniquenessBelow
    if (p.nestedReading   !== undefined) merged.nestedReading   = p.nestedReading
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
      if (f) internalConstraintContent = <FactInspector fact={f} />
    } else if (selectedMandatoryDot) {
      const f = store.facts.find(f => f.id === selectedMandatoryDot.factId)
      if (f) internalConstraintContent = <RoleInspector fact={f} roleIndex={selectedMandatoryDot.roleIndex} />
    } else if (selectedInternalFrequency) {
      const f = store.facts.find(f => f.id === selectedInternalFrequency.factId)
      const ifItem = f ? (f.internalFrequency || []).find(x => x.id === selectedInternalFrequency.ifId) : null
      if (f && ifItem) internalConstraintContent = <InternalFrequencyInspector fact={f} ifItem={ifItem} />
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
    <div style={{ width, flexShrink: 0, position: 'relative', background: 'var(--bg-surface)',
      borderLeft: '1px solid var(--border-soft)', overflowY: 'auto', padding: 14 }}>

      {/* Resize handle */}
      <div
        onMouseDown={onResizeMouseDown}
        style={{
          position: 'absolute', left: 0, top: 0, bottom: 0, width: 5,
          cursor: 'ew-resize', zIndex: 10,
        }}
      />

      {ot   && <ObjectTypeInspector ot={ot} />}
      {roleFact
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
          <div style={{ display: 'flex', gap: 6 }}>
            <button
              onClick={() => store.clearMultiSelection()}
              style={{ fontSize: 11, padding: '3px 8px' }}>
              Clear
            </button>
            <button
              onClick={() => store.deleteMultiSelection()}
              style={{ fontSize: 11, padding: '3px 8px',
                background: 'transparent', color: '#c0392b',
                border: '1px solid #c0392b', borderRadius: 3 }}>
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
            Diagram
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
              Target connectors
            </label>
            <label style={{
              display: 'flex', alignItems: 'center', gap: 8,
              cursor: 'pointer', padding: '7px 9px',
              background: 'var(--bg-raised)',
              border: '1px solid var(--border-soft)',
              borderRadius: 4, marginBottom: 8,
            }}>
              <input type="checkbox"
                checked={!!store.showTargetConnectors}
                onChange={e => store.setShowTargetConnectors(e.target.checked)}
                style={{ accentColor: 'var(--accent)' }}/>
              <div>
                <div style={{ fontSize: 12, color: 'var(--ink-2)', fontWeight: 500 }}>
                  Show target connectors
                </div>
                <div style={{ fontSize: 10, color: 'var(--ink-muted)', marginTop: 1 }}>
                  Arrow from constraint to its Target Object Name
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
  )
}
