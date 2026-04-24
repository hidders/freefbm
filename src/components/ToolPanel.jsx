import React, { useState } from 'react'
import { useOrmStore } from '../store/ormStore'

const COL_CONSTRAINT = '#7c4dbd'

const ALL_INTERNAL_CONSTRAINT_TYPES = [
  { key: 'internalUniqueness', label: 'Internal Uniqueness', tool: 'addInternalUniqueness' },
  { key: 'mandatoryRole',      label: 'Mandatory Role', tool: 'toggleMandatory' },
  { key: 'internalFrequency',  label: 'Internal Frequency' },
  { key: 'objectCardinality',  label: 'Object Cardinality' },
  { key: 'roleCardinality',    label: 'Role Cardinality' },
  { key: 'objectTypeValue',    label: 'Object Type Value' },
  { key: 'roleValue',          label: 'Role Value' },
]

const BASIC_INTERNAL_CONSTRAINT_TYPES = ALL_INTERNAL_CONSTRAINT_TYPES.slice(0, 2)

const ALL_CONSTRAINT_TYPES = [
  { key: 'uniqueness',        label: 'External Uniqueness',   short: null },
  { key: 'inclusiveOr',       label: 'Inclusive Or', short: null },
  { key: 'exclusion',         label: 'Exclusion',    short: null },
  { key: 'exclusiveOr',       label: 'Exclusive Or', short: null },
  { key: 'equality',          label: 'Equality',     short: null },
  { key: 'subset',            label: 'Subset',       short: null },
  { key: 'ring',              label: 'Ring',         short: null },
  { key: 'frequency',         label: 'External Frequency', short: null },
  { key: 'valueComparison',   label: 'Value Comparison', short: null },
]

const BASIC_CONSTRAINT_TYPES = ALL_CONSTRAINT_TYPES.slice(0, 4)

function SelectIcon({ active }) {
  const fill   = active ? '#fff' : 'var(--ink-2)'
  const stroke = active ? 'var(--accent)' : 'var(--bg-surface)'
  return (
    <svg width={18} height={18} style={{ display: 'block', flexShrink: 0 }}>
      <path d="M 4 2 L 4 14 L 7 11 L 9.5 16.5 L 11.5 15.5 L 9 10 L 13 10 Z"
        fill={fill} stroke={stroke} strokeWidth={0.75} strokeLinejoin="round"/>
    </svg>
  )
}

export function EntityTypeIcon({ active }) {
  return (
    <svg width={18} height={18} style={{ display: 'block', flexShrink: 0 }}>
      <rect x={0.6} y={3} width={16.8} height={12} rx={3.6}
        fill={active ? 'rgba(255,255,255,0.15)' : '#ffffff'} stroke={active ? '#fff' : 'var(--col-entity)'} strokeWidth={1.5} />
    </svg>
  )
}

function ValueTypeIcon({ active }) {
  return (
    <svg width={18} height={18} style={{ display: 'block', flexShrink: 0 }}>
      <rect x={0.6} y={3} width={16.8} height={12} rx={3.6}
        fill={active ? 'rgba(255,255,255,0.15)' : '#ffffff'} stroke={active ? '#fff' : 'var(--col-value)'} strokeWidth={1.5}
        strokeDasharray="3 2" />
    </svg>
  )
}

export function NestedFactTypeIcon({ active }) {
  const entityStroke = active ? '#fff' : 'var(--col-entity)'
  const factStroke   = active ? 'rgba(255,255,255,0.85)' : 'var(--col-fact)'
  const fill         = active ? 'rgba(255,255,255,0.15)' : '#ffffff'
  const ox = 0.6, oy = 1, ow = 16.8, oh = 16
  const ix1 = 3, ix2 = 9, ix3 = 15, iy1 = 5.5, iy2 = 12.5
  const sw = 1.5
  return (
    <svg width={18} height={18} style={{ display: 'block', flexShrink: 0 }}>
      <rect x={ox} y={oy} width={ow} height={oh} rx={3.6}
        fill={fill} stroke={entityStroke} strokeWidth={sw}/>
      <rect x={ix1} y={iy1} width={ix2 - ix1} height={iy2 - iy1} fill={fill} stroke="none"/>
      <rect x={ix2} y={iy1} width={ix3 - ix2} height={iy2 - iy1} fill={fill} stroke="none"/>
      <line x1={ix1} y1={iy1} x2={ix1} y2={iy2} stroke={factStroke} strokeWidth={sw}/>
      <line x1={ix1} y1={iy1} x2={ix3} y2={iy1} stroke={factStroke} strokeWidth={sw}/>
      <line x1={ix3} y1={iy1} x2={ix3} y2={iy2} stroke={factStroke} strokeWidth={sw}/>
      <line x1={ix1} y1={iy2} x2={ix3} y2={iy2} stroke={factStroke} strokeWidth={sw}/>
      <line x1={ix2} y1={iy1} x2={ix2} y2={iy2} stroke={factStroke} strokeWidth={sw}/>
    </svg>
  )
}

function NestedValueTypeIcon({ active }) {
  const valueStroke  = active ? '#fff' : 'var(--col-value)'
  const factStroke   = active ? 'rgba(255,255,255,0.85)' : 'var(--col-fact)'
  const fill         = active ? 'rgba(255,255,255,0.15)' : '#ffffff'
  const ox = 0.6, oy = 1, ow = 16.8, oh = 16
  const ix1 = 3, ix2 = 9, ix3 = 15, iy1 = 5.5, iy2 = 12.5
  const sw = 1.5
  return (
    <svg width={18} height={18} style={{ display: 'block', flexShrink: 0 }}>
      <rect x={ox} y={oy} width={ow} height={oh} rx={3.6}
        fill={fill} stroke={valueStroke} strokeWidth={sw} strokeDasharray="5 3"/>
      <rect x={ix1} y={iy1} width={ix2 - ix1} height={iy2 - iy1} fill={fill} stroke="none"/>
      <rect x={ix2} y={iy1} width={ix3 - ix2} height={iy2 - iy1} fill={fill} stroke="none"/>
      <line x1={ix1} y1={iy1} x2={ix1} y2={iy2} stroke={factStroke} strokeWidth={sw}/>
      <line x1={ix1} y1={iy1} x2={ix3} y2={iy1} stroke={factStroke} strokeWidth={sw}/>
      <line x1={ix3} y1={iy1} x2={ix3} y2={iy2} stroke={factStroke} strokeWidth={sw}/>
      <line x1={ix1} y1={iy2} x2={ix3} y2={iy2} stroke={factStroke} strokeWidth={sw}/>
      <line x1={ix2} y1={iy1} x2={ix2} y2={iy2} stroke={factStroke} strokeWidth={sw}/>
    </svg>
  )
}

export function FactTypeIcon({ active }) {
  const stroke = active ? '#fff' : 'var(--col-fact)'
  const fill   = active ? 'rgba(255,255,255,0.15)' : '#ffffff'
  // Two role boxes sharing a centre divider. Drawn as filled rects plus explicit
  // lines so every edge (outer left, outer right, top, bottom, centre divider)
  // is exactly one stroke width — no double-stroke overlap at the join.
  const x1 = 1, x2 = 9, x3 = 17, y1 = 4.2, y2 = 13.8, sw = 1.5
  return (
    <svg width={18} height={18} style={{ display: 'block', flexShrink: 0 }}>
      <rect x={x1} y={y1} width={x2 - x1} height={y2 - y1} fill={fill} stroke="none" />
      <rect x={x2} y={y1} width={x3 - x2} height={y2 - y1} fill={fill} stroke="none" />
      {/* outer left */}  <line x1={x1} y1={y1} x2={x1} y2={y2} stroke={stroke} strokeWidth={sw} />
      {/* top */}         <line x1={x1} y1={y1} x2={x3} y2={y1} stroke={stroke} strokeWidth={sw} />
      {/* outer right */} <line x1={x3} y1={y1} x2={x3} y2={y2} stroke={stroke} strokeWidth={sw} />
      {/* bottom */}      <line x1={x1} y1={y2} x2={x3} y2={y2} stroke={stroke} strokeWidth={sw} />
      {/* divider */}     <line x1={x2} y1={y1} x2={x2} y2={y2} stroke={stroke} strokeWidth={sw} />
    </svg>
  )
}

function RoleIcon({ active }) {
  const colour = active ? '#fff' : 'var(--col-fact)'
  return (
    <svg width={18} height={18} style={{ display: 'block', flexShrink: 0 }}>
      <line x1={2} y1={9} x2={16} y2={9} stroke={colour} strokeWidth={1.5} strokeOpacity={active ? 1 : 0.75} />
    </svg>
  )
}

function SubtypeIcon({ active }) {
  const colour = active ? '#fff' : 'var(--col-subtype)'
  return (
    <svg width={18} height={18} style={{ display: 'block', flexShrink: 0 }}>
      <line x1={2} y1={9} x2={11} y2={9} stroke={colour} strokeWidth={2} />
      <path d="M 10 6 L 16 9 L 10 12 Z" fill={colour} />
    </svg>
  )
}


function ConstraintEdgeIcon({ active }) {
  const colour = active ? '#fff' : 'var(--col-constraint)'
  return (
    <svg width={18} height={18} style={{ display: 'block', flexShrink: 0 }}>
      <line x1={2} y1={9} x2={16} y2={9} stroke={colour} strokeWidth={1.2}
        strokeDasharray="4 2" opacity={0.75} />
    </svg>
  )
}

function TargetConnectorIcon({ active }) {
  const colour = active ? '#fff' : 'var(--col-constraint)'
  return (
    <svg width={18} height={18} style={{ display: 'block', flexShrink: 0 }}>
      <line x1={2} y1={9} x2={12} y2={9} stroke={colour} strokeWidth={1.5} strokeDasharray="3 2"/>
      <path d="M 11 6 L 16 9 L 11 12 Z" fill={colour}/>
    </svg>
  )
}

function ExclusionConstraintIcon() {
  const cx = 9, cy = 9, r = 7.2, d = r * 0.707
  return (
    <svg width={18} height={18} style={{ display: 'block', flexShrink: 0 }}>
      <circle cx={cx} cy={cy} r={r} fill="#ffffff" stroke={COL_CONSTRAINT} strokeWidth={1.5}/>
      <line x1={cx - d} y1={cy - d} x2={cx + d} y2={cy + d}
        stroke={COL_CONSTRAINT} strokeWidth={1.5} strokeLinecap="round"/>
      <line x1={cx + d} y1={cy - d} x2={cx - d} y2={cy + d}
        stroke={COL_CONSTRAINT} strokeWidth={1.5} strokeLinecap="round"/>
    </svg>
  )
}

function ValueComparisonConstraintIcon() {
  const cx = 9, cy = 9, r = 7.2
  return (
    <svg width={18} height={18} style={{ display: 'block', flexShrink: 0 }}>
      <circle cx={cx} cy={cy} r={r} fill="#ffffff" stroke={COL_CONSTRAINT} strokeWidth={1.5}/>
      <circle cx={cx - r} cy={cy} r={2} fill={COL_CONSTRAINT}/>
      <circle cx={cx + r} cy={cy} r={2} fill={COL_CONSTRAINT}/>
      <text x={cx} y={cy} textAnchor="middle" dominantBaseline="central"
        fontSize={8} fill={COL_CONSTRAINT} fontFamily="var(--font-mono)" fontWeight={600}>
        ≤
      </text>
    </svg>
  )
}

function RingConstraintIcon() {
  const cx = 9, cy = 9, r = 7.2
  const rt = 6
  const tx  = cx,          ty  = cy - rt
  const blx = cx - rt * Math.sin(Math.PI / 3), bly = cy + rt * 0.5
  const brx = cx + rt * Math.sin(Math.PI / 3), bry = cy + rt * 0.5
  return (
    <svg width={18} height={18} style={{ display: 'block', flexShrink: 0 }}>
      <polygon points={`${tx},${ty} ${blx},${bly} ${brx},${bry}`}
        fill="none" stroke={COL_CONSTRAINT} strokeWidth={1.2} strokeLinejoin="round"/>
      <circle cx={tx}  cy={ty}  r={1.5} fill={COL_CONSTRAINT}/>
      <circle cx={blx} cy={bly} r={1.5} fill={COL_CONSTRAINT}/>
      <circle cx={brx} cy={bry} r={1.5} fill={COL_CONSTRAINT}/>
    </svg>
  )
}

function FrequencyConstraintIcon() {
  const cx = 9, cy = 9, r = 7.2
  return (
    <svg width={18} height={18} style={{ display: 'block', flexShrink: 0 }}>
      <circle cx={cx} cy={cy} r={r} fill="#ffffff" stroke={COL_CONSTRAINT} strokeWidth={1.5}/>
      <text x={cx} y={cy} textAnchor="middle" dominantBaseline="central"
        fontSize={8} fill={COL_CONSTRAINT} fontFamily="var(--font-mono)" fontWeight={600}>
        ≤3
      </text>
    </svg>
  )
}

function SubsetConstraintIcon() {
  const cx = 9, cy = 9, r = 7.2
  return (
    <svg width={18} height={18} style={{ display: 'block', flexShrink: 0 }}>
      <circle cx={cx} cy={cy} r={r} fill="#ffffff" stroke={COL_CONSTRAINT} strokeWidth={1.5}/>
      <text x={cx} y={cy} textAnchor="middle" dominantBaseline="central"
        fontSize={10} fill={COL_CONSTRAINT}>
        ⊆
      </text>
    </svg>
  )
}

function EqualityConstraintIcon() {
  const cx = 9, cy = 9, r = 7.2
  return (
    <svg width={18} height={18} style={{ display: 'block', flexShrink: 0 }}>
      <circle cx={cx} cy={cy} r={r} fill="#ffffff" stroke={COL_CONSTRAINT} strokeWidth={1.5}/>
      <line x1={cx - 3.5} y1={cy - 1.5} x2={cx + 3.5} y2={cy - 1.5}
        stroke={COL_CONSTRAINT} strokeWidth={1.5} strokeLinecap="round"/>
      <line x1={cx - 3.5} y1={cy + 1.5} x2={cx + 3.5} y2={cy + 1.5}
        stroke={COL_CONSTRAINT} strokeWidth={1.5} strokeLinecap="round"/>
    </svg>
  )
}

function InclusiveOrConstraintIcon() {
  const cx = 9, cy = 9, r = 7.2
  return (
    <svg width={18} height={18} style={{ display: 'block', flexShrink: 0 }}>
      <circle cx={cx} cy={cy} r={r} fill="#ffffff" stroke={COL_CONSTRAINT} strokeWidth={1.5}/>
      <circle cx={cx} cy={cy} r={2.5} fill={COL_CONSTRAINT}/>
    </svg>
  )
}

function UniquenessConstraintIcon() {
  const cx = 9, cy = 9, r = 7.2
  return (
    <svg width={18} height={18} style={{ display: 'block', flexShrink: 0 }}>
      <circle cx={cx} cy={cy} r={r} fill="#ffffff" stroke={COL_CONSTRAINT} strokeWidth={1.5}/>
      <line x1={cx - r} y1={cy} x2={cx + r} y2={cy}
        stroke={COL_CONSTRAINT} strokeWidth={1.5} strokeLinecap="round"/>
    </svg>
  )
}

function SubtypeConstraintIcon() {
  const cx = 9, cy = 9, r = 7.2, d = r * 0.707
  return (
    <svg width={18} height={18} style={{ display: 'block', flexShrink: 0 }}>
      <circle cx={cx} cy={cy} r={r} fill="#ffffff" stroke={COL_CONSTRAINT} strokeWidth={1.5}/>
      <line x1={cx - d} y1={cy - d} x2={cx + d} y2={cy + d}
        stroke={COL_CONSTRAINT} strokeWidth={1.5} strokeLinecap="round"/>
      <line x1={cx + d} y1={cy - d} x2={cx - d} y2={cy + d}
        stroke={COL_CONSTRAINT} strokeWidth={1.5} strokeLinecap="round"/>
      <circle cx={cx} cy={cy} r={2.5} fill={COL_CONSTRAINT}/>
    </svg>
  )
}

function ToolBtn({ label, title, active, onClick }) {
  return (
    <button
      title={title}
      onClick={onClick}
      style={{
        width: '100%',
        padding: '5px 10px',
        fontSize: 12,
        textAlign: 'left',
        background: active ? 'var(--accent)' : 'transparent',
        color: active ? '#fff' : 'var(--ink-2)',
        border: `1px solid ${active ? 'var(--accent)' : 'transparent'}`,
        borderRadius: 4,
        fontFamily: 'var(--font-mono)',
        cursor: 'pointer',
        transition: 'all 0.12s',
        whiteSpace: 'nowrap',
      }}
      onMouseEnter={e => { if (!active) e.currentTarget.style.background = 'var(--bg-hover)' }}
      onMouseLeave={e => { if (!active) e.currentTarget.style.background = 'transparent' }}
    >
      {label}
    </button>
  )
}

function MandatoryRoleIcon() {
  return (
    <svg width={18} height={18} style={{ display: 'block', flexShrink: 0 }}>
      <circle cx={9} cy={9} r={4.5} fill={COL_CONSTRAINT}/>
    </svg>
  )
}

function InternalUniquenessIcon() {
  const x1 = 1, x2 = 9, x3 = 17, y1 = 6, y2 = 14
  return (
    <svg width={18} height={18} style={{ display: 'block', flexShrink: 0 }}>
      <rect x={x1} y={y1} width={x2-x1} height={y2-y1} fill="#e8e8e8" stroke="#aaa" strokeWidth={1.2}/>
      <rect x={x2} y={y1} width={x3-x2} height={y2-y1} fill="#e8e8e8" stroke="#aaa" strokeWidth={1.2}/>
      <line x1={x1} y1={4} x2={x3} y2={4} stroke={COL_CONSTRAINT} strokeWidth={2} strokeLinecap="round"/>
    </svg>
  )
}

function InternalFrequencyIcon() {
  const x1 = 1, x2 = 9, x3 = 17, y1 = 7, y2 = 15
  return (
    <svg width={18} height={18} style={{ display: 'block', flexShrink: 0 }}>
      <rect x={x1} y={y1} width={x2-x1} height={y2-y1} fill="#fff" stroke={COL_CONSTRAINT} strokeWidth={1.2}/>
      <rect x={x2} y={y1} width={x3-x2} height={y2-y1} fill="#fff" stroke={COL_CONSTRAINT} strokeWidth={1.2}/>
      <text x={9} y={5} textAnchor="middle" dominantBaseline="middle"
        fontSize={7} fill={COL_CONSTRAINT} fontFamily="var(--font-mono)" fontWeight={600}>≤n</text>
    </svg>
  )
}

function ObjectCardinalityIcon() {
  const cx = 9, cy = 9, r = 7.2
  return (
    <svg width={18} height={18} style={{ display: 'block', flexShrink: 0 }}>
      <rect x={1} y={3} width={16} height={12} rx={3}
        fill="#fff" stroke={COL_CONSTRAINT} strokeWidth={1.5}/>
      <text x={cx} y={cy} textAnchor="middle" dominantBaseline="central"
        fontSize={7} fill={COL_CONSTRAINT} fontFamily="var(--font-mono)" fontWeight={600}>1..n</text>
    </svg>
  )
}

function RoleCardinalityIcon() {
  const x1 = 1, x2 = 9, x3 = 17, y1 = 5, y2 = 13
  return (
    <svg width={18} height={18} style={{ display: 'block', flexShrink: 0 }}>
      <rect x={x1} y={y1} width={x2-x1} height={y2-y1} fill="#fff" stroke={COL_CONSTRAINT} strokeWidth={1.2}/>
      <rect x={x2} y={y1} width={x3-x2} height={y2-y1} fill="#fff" stroke={COL_CONSTRAINT} strokeWidth={1.2}/>
      <text x={9} y={15.5} textAnchor="middle" dominantBaseline="middle"
        fontSize={6.5} fill={COL_CONSTRAINT} fontFamily="var(--font-mono)" fontWeight={600}>1..n</text>
    </svg>
  )
}

function ObjectTypeValueIcon() {
  return (
    <svg width={18} height={18} style={{ display: 'block', flexShrink: 0 }}>
      <rect x={1} y={3} width={16} height={12} rx={3}
        fill="#fff" stroke={COL_CONSTRAINT} strokeWidth={1.5} strokeDasharray="3 2"/>
      <text x={9} y={9.5} textAnchor="middle" dominantBaseline="central"
        fontSize={7} fill={COL_CONSTRAINT} fontFamily="var(--font-mono)" fontWeight={600}>= v</text>
    </svg>
  )
}

function RoleValueIcon() {
  const x1 = 1, x2 = 9, x3 = 17, y1 = 5, y2 = 13
  return (
    <svg width={18} height={18} style={{ display: 'block', flexShrink: 0 }}>
      <rect x={x1} y={y1} width={x2-x1} height={y2-y1} fill="#fff" stroke={COL_CONSTRAINT} strokeWidth={1.2}/>
      <rect x={x2} y={y1} width={x3-x2} height={y2-y1} fill="#fff" stroke={COL_CONSTRAINT} strokeWidth={1.2}/>
      <text x={9} y={15.5} textAnchor="middle" dominantBaseline="middle"
        fontSize={6.5} fill={COL_CONSTRAINT} fontFamily="var(--font-mono)" fontWeight={600}>= v</text>
    </svg>
  )
}

function InternalConstraintBtn({ ct, active, onClick }) {
  const iconMap = {
    mandatoryRole:      <MandatoryRoleIcon />,
    internalUniqueness: <InternalUniquenessIcon />,
    internalFrequency:  <InternalFrequencyIcon />,
    objectCardinality:  <ObjectCardinalityIcon />,
    roleCardinality:    <RoleCardinalityIcon />,
    objectTypeValue:    <ObjectTypeValueIcon />,
    roleValue:          <RoleValueIcon />,
  }
  return (
    <button
      title={ct.label}
      onClick={onClick}
      style={{
        width: '100%',
        padding: '4px 10px',
        fontSize: 12,
        textAlign: 'left',
        display: 'flex',
        alignItems: 'center',
        gap: 7,
        background: active ? 'var(--accent)' : 'transparent',
        color: active ? '#fff' : 'var(--ink-2)',
        border: `1px solid ${active ? 'var(--accent)' : 'transparent'}`,
        borderRadius: 4,
        fontFamily: 'var(--font-mono)',
        cursor: 'pointer',
        transition: 'all 0.12s',
        whiteSpace: 'nowrap',
      }}
      onMouseEnter={e => { if (!active) e.currentTarget.style.background = 'var(--bg-hover)' }}
      onMouseLeave={e => { if (!active) e.currentTarget.style.background = 'transparent' }}
    >
      {iconMap[ct.key]}
      {ct.label}
    </button>
  )
}

function ConstraintBtn({ ct, active, onClick }) {
  return (
    <button
      title={`Add ${ct.label} Constraint`}
      onClick={onClick}
      style={{
        width: '100%',
        padding: '4px 10px',
        fontSize: 12,
        textAlign: 'left',
        display: 'flex',
        alignItems: 'center',
        gap: 7,
        background: active ? 'var(--accent)' : 'transparent',
        color: active ? '#fff' : 'var(--ink-2)',
        border: `1px solid ${active ? 'var(--accent)' : 'transparent'}`,
        borderRadius: 4,
        fontFamily: 'var(--font-mono)',
        cursor: 'pointer',
        transition: 'all 0.12s',
        whiteSpace: 'nowrap',
      }}
      onMouseEnter={e => { if (!active) e.currentTarget.style.background = 'var(--bg-hover)' }}
      onMouseLeave={e => { if (!active) e.currentTarget.style.background = 'transparent' }}
    >
      {ct.short !== null
        ? <span style={{ width: 18, textAlign: 'center', fontSize: ct.shortSize ?? 13, color: active ? '#fff' : COL_CONSTRAINT, flexShrink: 0 }}>{ct.short}</span>
        : ct.key === 'uniqueness'
          ? <UniquenessConstraintIcon />
          : ct.key === 'exclusion'
            ? <ExclusionConstraintIcon />
            : ct.key === 'ring'
            ? <RingConstraintIcon />
            : ct.key === 'frequency'
            ? <FrequencyConstraintIcon />
            : ct.key === 'subset'
            ? <SubsetConstraintIcon />
            : ct.key === 'equality'
            ? <EqualityConstraintIcon />
            : ct.key === 'inclusiveOr'
              ? <InclusiveOrConstraintIcon />
              : ct.key === 'valueComparison'
                ? <ValueComparisonConstraintIcon />
                : <SubtypeConstraintIcon />}
      {ct.label}
    </button>
  )
}

function GroupLabel({ children }) {
  return (
    <span style={{
      fontSize: 10,
      fontFamily: 'var(--font-mono)',
      color: 'var(--ink-muted)',
      textTransform: 'uppercase',
      letterSpacing: '0.08em',
      padding: '0 10px',
      marginTop: 2,
      display: 'block',
    }}>
      {children}
    </span>
  )
}

function Divider() {
  return <div style={{ height: 1, background: 'var(--border-soft)', margin: '4px 0' }} />
}

export default function ToolPanel() {
  const store = useOrmStore()
  const tool = store.sequenceConstruction ? 'connectConstraint' : store.tool
  const [advanced, setAdvanced] = useState(false)

  const INTERNAL_CONSTRAINT_TYPES = advanced ? ALL_INTERNAL_CONSTRAINT_TYPES : BASIC_INTERNAL_CONSTRAINT_TYPES
  const CONSTRAINT_TYPES = advanced ? ALL_CONSTRAINT_TYPES : BASIC_CONSTRAINT_TYPES

  return (
    <div style={{
      width: 195,
      flexShrink: 0,
      display: 'flex',
      flexDirection: 'column',
      gap: 1,
      padding: '6px 6px',
      background: 'var(--bg-surface)',
      borderRight: '1px solid var(--border-soft)',
      overflowY: 'auto',
    }}>
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 6,
        padding: '2px 4px 5px',
        marginBottom: 2,
      }}>
        <span style={{ fontSize: 10, color: advanced ? 'var(--ink-muted)' : 'var(--ink-2)', fontFamily: 'var(--font-mono)', userSelect: 'none' }}>
          Basic
        </span>
        <div
          title={advanced ? 'Switch to Basic mode' : 'Switch to Advanced mode'}
          onClick={() => setAdvanced(a => !a)}
          style={{
            position: 'relative',
            width: 34,
            height: 18,
            borderRadius: 9,
            background: advanced ? 'var(--accent)' : 'var(--border)',
            cursor: 'pointer',
            transition: 'background 0.2s',
            flexShrink: 0,
          }}
        >
          <div style={{
            position: 'absolute',
            top: 2,
            left: advanced ? 16 : 2,
            width: 14,
            height: 14,
            borderRadius: '50%',
            background: '#fff',
            boxShadow: '0 1px 3px rgba(0,0,0,0.25)',
            transition: 'left 0.2s',
          }}/>
        </div>
        <span style={{ fontSize: 10, color: advanced ? 'var(--ink-2)' : 'var(--ink-muted)', fontFamily: 'var(--font-mono)', userSelect: 'none' }}>
          Advanced
        </span>
      </div>

      <button
        title="Select (S)"
        onClick={() => store.setTool('select')}
        style={{
          width: '100%',
          padding: '4px 10px',
          fontSize: 12,
          textAlign: 'left',
          display: 'flex',
          alignItems: 'center',
          gap: 7,
          background: tool === 'select' ? 'var(--accent)' : 'transparent',
          color: tool === 'select' ? '#fff' : 'var(--ink-2)',
          border: `1px solid ${tool === 'select' ? 'var(--accent)' : 'transparent'}`,
          borderRadius: 4,
          fontFamily: 'var(--font-mono)',
          cursor: 'pointer',
          transition: 'all 0.12s',
          whiteSpace: 'nowrap',
        }}
        onMouseEnter={e => { if (tool !== 'select') e.currentTarget.style.background = 'var(--bg-hover)' }}
        onMouseLeave={e => { if (tool !== 'select') e.currentTarget.style.background = 'transparent' }}
      >
        <SelectIcon active={tool === 'select'} />
        Select
      </button>

      <Divider />
      <GroupLabel>Types</GroupLabel>

      <button
        title="Add Entity Type (E)"
        onClick={() => store.setTool('addEntity')}
        style={{
          width: '100%',
          padding: '4px 10px',
          fontSize: 12,
          textAlign: 'left',
          display: 'flex',
          alignItems: 'center',
          gap: 7,
          background: tool === 'addEntity' ? 'var(--accent)' : 'transparent',
          color: tool === 'addEntity' ? '#fff' : 'var(--ink-2)',
          border: `1px solid ${tool === 'addEntity' ? 'var(--accent)' : 'transparent'}`,
          borderRadius: 4,
          fontFamily: 'var(--font-mono)',
          cursor: 'pointer',
          transition: 'all 0.12s',
          whiteSpace: 'nowrap',
        }}
        onMouseEnter={e => { if (tool !== 'addEntity') e.currentTarget.style.background = 'var(--bg-hover)' }}
        onMouseLeave={e => { if (tool !== 'addEntity') e.currentTarget.style.background = 'transparent' }}
      >
        <EntityTypeIcon active={tool === 'addEntity'} />
        Entity Type
      </button>
      <button
        title="Add Value Type (V)"
        onClick={() => store.setTool('addValue')}
        style={{
          width: '100%',
          padding: '4px 10px',
          fontSize: 12,
          textAlign: 'left',
          display: 'flex',
          alignItems: 'center',
          gap: 7,
          background: tool === 'addValue' ? 'var(--accent)' : 'transparent',
          color: tool === 'addValue' ? '#fff' : 'var(--ink-2)',
          border: `1px solid ${tool === 'addValue' ? 'var(--accent)' : 'transparent'}`,
          borderRadius: 4,
          fontFamily: 'var(--font-mono)',
          cursor: 'pointer',
          transition: 'all 0.12s',
          whiteSpace: 'nowrap',
        }}
        onMouseEnter={e => { if (tool !== 'addValue') e.currentTarget.style.background = 'var(--bg-hover)' }}
        onMouseLeave={e => { if (tool !== 'addValue') e.currentTarget.style.background = 'transparent' }}
      >
        <ValueTypeIcon active={tool === 'addValue'} />
        Value Type
      </button>
      <button
        title="Add Fact Type (F)"
        onClick={() => store.setTool('addFact2')}
        style={{
          width: '100%',
          padding: '4px 10px',
          fontSize: 12,
          textAlign: 'left',
          display: 'flex',
          alignItems: 'center',
          gap: 7,
          background: tool === 'addFact2' ? 'var(--accent)' : 'transparent',
          color: tool === 'addFact2' ? '#fff' : 'var(--ink-2)',
          border: `1px solid ${tool === 'addFact2' ? 'var(--accent)' : 'transparent'}`,
          borderRadius: 4,
          fontFamily: 'var(--font-mono)',
          cursor: 'pointer',
          transition: 'all 0.12s',
          whiteSpace: 'nowrap',
        }}
        onMouseEnter={e => { if (tool !== 'addFact2') e.currentTarget.style.background = 'var(--bg-hover)' }}
        onMouseLeave={e => { if (tool !== 'addFact2') e.currentTarget.style.background = 'transparent' }}
      >
        <FactTypeIcon active={tool === 'addFact2'} />
        Fact Type
      </button>
      {advanced && <button
        title="Add Nested Entity Type"
        onClick={() => store.setTool('addNestedFact')}
        style={{
          width: '100%',
          padding: '4px 10px',
          fontSize: 12,
          textAlign: 'left',
          display: 'flex',
          alignItems: 'center',
          gap: 7,
          background: tool === 'addNestedFact' ? 'var(--accent)' : 'transparent',
          color: tool === 'addNestedFact' ? '#fff' : 'var(--ink-2)',
          border: `1px solid ${tool === 'addNestedFact' ? 'var(--accent)' : 'transparent'}`,
          borderRadius: 4,
          fontFamily: 'var(--font-mono)',
          cursor: 'pointer',
          transition: 'all 0.12s',
          whiteSpace: 'nowrap',
        }}
        onMouseEnter={e => { if (tool !== 'addNestedFact') e.currentTarget.style.background = 'var(--bg-hover)' }}
        onMouseLeave={e => { if (tool !== 'addNestedFact') e.currentTarget.style.background = 'transparent' }}
      >
        <NestedFactTypeIcon active={tool === 'addNestedFact'} />
        Nested Entity Type
      </button>}
      {advanced && <button
        title="Add Nested Value Type"
        onClick={() => store.setTool('addNestedValueFact')}
        style={{
          width: '100%',
          padding: '4px 10px',
          fontSize: 12,
          textAlign: 'left',
          display: 'flex',
          alignItems: 'center',
          gap: 7,
          background: tool === 'addNestedValueFact' ? 'var(--accent)' : 'transparent',
          color: tool === 'addNestedValueFact' ? '#fff' : 'var(--ink-2)',
          border: `1px solid ${tool === 'addNestedValueFact' ? 'var(--accent)' : 'transparent'}`,
          borderRadius: 4,
          fontFamily: 'var(--font-mono)',
          cursor: 'pointer',
          transition: 'all 0.12s',
          whiteSpace: 'nowrap',
        }}
        onMouseEnter={e => { if (tool !== 'addNestedValueFact') e.currentTarget.style.background = 'var(--bg-hover)' }}
        onMouseLeave={e => { if (tool !== 'addNestedValueFact') e.currentTarget.style.background = 'transparent' }}
      >
        <NestedValueTypeIcon active={tool === 'addNestedValueFact'} />
        Nested Value Type
      </button>}

      <Divider />
      <GroupLabel>Connectors</GroupLabel>

      <button
        title="Assign Object Type to Role (A)"
        onClick={() => { store.clearSelection(); store.setTool('assignRole') }}
        style={{
          width: '100%',
          padding: '4px 10px',
          fontSize: 12,
          textAlign: 'left',
          display: 'flex',
          alignItems: 'center',
          gap: 7,
          background: tool === 'assignRole' ? 'var(--accent)' : 'transparent',
          color: tool === 'assignRole' ? '#fff' : 'var(--ink-2)',
          border: `1px solid ${tool === 'assignRole' ? 'var(--accent)' : 'transparent'}`,
          borderRadius: 4,
          fontFamily: 'var(--font-mono)',
          cursor: 'pointer',
          transition: 'all 0.12s',
          whiteSpace: 'nowrap',
        }}
        onMouseEnter={e => { if (tool !== 'assignRole') e.currentTarget.style.background = 'var(--bg-hover)' }}
        onMouseLeave={e => { if (tool !== 'assignRole') e.currentTarget.style.background = 'transparent' }}
      >
        <RoleIcon active={tool === 'assignRole'} />
        Role
      </button>
      <button
        title="Draw Subtype Link (U)"
        onClick={() => { store.clearSelection(); store.setTool('addSubtype') }}
        style={{
          width: '100%',
          padding: '4px 10px',
          fontSize: 12,
          textAlign: 'left',
          display: 'flex',
          alignItems: 'center',
          gap: 7,
          background: tool === 'addSubtype' ? 'var(--accent)' : 'transparent',
          color: tool === 'addSubtype' ? '#fff' : 'var(--ink-2)',
          border: `1px solid ${tool === 'addSubtype' ? 'var(--accent)' : 'transparent'}`,
          borderRadius: 4,
          fontFamily: 'var(--font-mono)',
          cursor: 'pointer',
          transition: 'all 0.12s',
          whiteSpace: 'nowrap',
        }}
        onMouseEnter={e => { if (tool !== 'addSubtype') e.currentTarget.style.background = 'var(--bg-hover)' }}
        onMouseLeave={e => { if (tool !== 'addSubtype') e.currentTarget.style.background = 'transparent' }}
      >
        <SubtypeIcon active={tool === 'addSubtype'} />
        Subtype
      </button>
      <button
        title="Connect Constraint to Role / Object Type"
        onClick={() => { store.clearSelection(); store.setTool('connectConstraint') }}
        style={{
          width: '100%',
          padding: '4px 10px',
          fontSize: 12,
          textAlign: 'left',
          display: 'flex',
          alignItems: 'center',
          gap: 7,
          background: tool === 'connectConstraint' ? 'var(--accent)' : 'transparent',
          color: tool === 'connectConstraint' ? '#fff' : 'var(--ink-2)',
          border: `1px solid ${tool === 'connectConstraint' ? 'var(--accent)' : 'transparent'}`,
          borderRadius: 4,
          fontFamily: 'var(--font-mono)',
          cursor: 'pointer',
          transition: 'all 0.12s',
          whiteSpace: 'nowrap',
        }}
        onMouseEnter={e => { if (tool !== 'connectConstraint') e.currentTarget.style.background = 'var(--bg-hover)' }}
        onMouseLeave={e => { if (tool !== 'connectConstraint') e.currentTarget.style.background = 'transparent' }}
      >
        <ConstraintEdgeIcon active={tool === 'connectConstraint'} />
        Constraint
      </button>

      {advanced && <button
        title="Set Target Object Type for Constraint"
        onClick={() => { store.clearSelection(); store.setTool('addTargetConnector') }}
        style={{
          width: '100%',
          padding: '4px 10px',
          fontSize: 12,
          textAlign: 'left',
          display: 'flex',
          alignItems: 'center',
          gap: 7,
          background: tool === 'addTargetConnector' ? 'var(--accent)' : 'transparent',
          color: tool === 'addTargetConnector' ? '#fff' : 'var(--ink-2)',
          border: `1px solid ${tool === 'addTargetConnector' ? 'var(--accent)' : 'transparent'}`,
          borderRadius: 4,
          fontFamily: 'var(--font-mono)',
          cursor: 'pointer',
          transition: 'all 0.12s',
          whiteSpace: 'nowrap',
        }}
        onMouseEnter={e => { if (tool !== 'addTargetConnector') e.currentTarget.style.background = 'var(--bg-hover)' }}
        onMouseLeave={e => { if (tool !== 'addTargetConnector') e.currentTarget.style.background = 'transparent' }}
      >
        <TargetConnectorIcon active={tool === 'addTargetConnector'} />
        Target
      </button>}

      <Divider />
      <GroupLabel>Internal Constraints</GroupLabel>

      {INTERNAL_CONSTRAINT_TYPES.map(ct => (
        <InternalConstraintBtn
          key={ct.key}
          ct={ct}
          active={tool === (ct.tool ?? `addConstraint:${ct.key}`)}
          onClick={() => store.setTool(ct.tool ?? `addConstraint:${ct.key}`)}
        />
      ))}

      <Divider />
      <GroupLabel>External Constraints</GroupLabel>

      {CONSTRAINT_TYPES.map(ct => (
        <ConstraintBtn
          key={ct.key}
          ct={ct}
          active={tool === `addConstraint:${ct.key}`}
          onClick={() => store.setTool(`addConstraint:${ct.key}`)}
        />
      ))}

    </div>
  )
}
