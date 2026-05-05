import React from 'react'
import { useOrmStore } from '../store/ormStore'
import { EntityTypeIcon, FactTypeIcon } from './ToolPanel'

// Sample ORM2 model: a small employment/project schema
const SAMPLE = {
  objectTypes: [
    { id: 'ot1', kind: 'entity', name: 'Person',     x: 160, y: 160, refMode: 'id' },
    { id: 'ot2', kind: 'entity', name: 'Company',    x: 500, y: 160, refMode: 'name' },
    { id: 'ot3', kind: 'entity', name: 'Project',    x: 500, y: 360, refMode: 'id' },
    { id: 'ot4', kind: 'value',  name: 'PersonName', x: 160, y: 310, refMode: '' },
    { id: 'ot5', kind: 'value',  name: 'Salary',     x: 330, y: 80,  refMode: '' },
    { id: 'ot6', kind: 'entity', name: 'Manager',    x: 160, y: 460, refMode: 'id' },
  ],
  facts: [
    {
      id: 'f1', kind: 'fact', x: 330, y: 160, arity: 2,
      readingParts: ['', 'is employed by', ''],
      roles: [
        { id: 'r1a', objectTypeId: 'ot1', roleName: '', mandatory: true },
        { id: 'r1b', objectTypeId: 'ot2', roleName: '', mandatory: false },
      ],
      uniqueness: [[0, 1]],
      readingDisplay: 'forward', alternativeReadings: [], uniquenessBelow: false,
      readingAbove: false, readingOffset: null, internalFrequency: [], implicitLinks: [],
      preferredUniqueness: [], shownReadingOrder: null, orientation: 'horizontal',
    },
    {
      id: 'f2', kind: 'fact', x: 330, y: 310, arity: 2,
      readingParts: ['', 'has', ''],
      roles: [
        { id: 'r2a', objectTypeId: 'ot1', roleName: '', mandatory: true },
        { id: 'r2b', objectTypeId: 'ot4', roleName: '', mandatory: false },
      ],
      uniqueness: [[0]],
      readingDisplay: 'forward', alternativeReadings: [], uniquenessBelow: false,
      readingAbove: false, readingOffset: null, internalFrequency: [], implicitLinks: [],
      preferredUniqueness: [], shownReadingOrder: null, orientation: 'horizontal',
    },
    {
      id: 'f3', kind: 'fact', x: 330, y: 80, arity: 2,
      readingParts: ['', 'earns', ''],
      roles: [
        { id: 'r3a', objectTypeId: 'ot1', roleName: '', mandatory: false },
        { id: 'r3b', objectTypeId: 'ot5', roleName: '', mandatory: false },
      ],
      uniqueness: [[0]],
      readingDisplay: 'forward', alternativeReadings: [], uniquenessBelow: false,
      readingAbove: false, readingOffset: null, internalFrequency: [], implicitLinks: [],
      preferredUniqueness: [], shownReadingOrder: null, orientation: 'horizontal',
    },
    {
      id: 'f4', kind: 'fact', x: 500, y: 260, arity: 2,
      readingParts: ['', 'sponsors', ''],
      roles: [
        { id: 'r4a', objectTypeId: 'ot2', roleName: '', mandatory: false },
        { id: 'r4b', objectTypeId: 'ot3', roleName: '', mandatory: true },
      ],
      uniqueness: [[1]],
      readingDisplay: 'forward', alternativeReadings: [], uniquenessBelow: false,
      readingAbove: false, readingOffset: null, internalFrequency: [], implicitLinks: [],
      preferredUniqueness: [], shownReadingOrder: null, orientation: 'horizontal',
    },
  ],
  subtypes: [
    { id: 'st1', kind: 'subtype', subId: 'ot6', superId: 'ot1', exclusive: false, exhaustive: false },
  ],
  constraints: [
    {
      id: 'c1', kind: 'constraint', constraintType: 'ring',
      x: 130, y: 410,
      sequences: [[{ kind: 'role', factId: 'f1', roleIndex: 0 }], [{ kind: 'role', factId: 'f1', roleIndex: 1 }]],
      ringTypes: ['irreflexive'],
    },
  ],
}

export default function WelcomeScreen() {
  const store = useOrmStore()

  const ShortcutRow = ({ keys, label }) => (
    <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 5 }}>
      <div style={{ display: 'flex', gap: 3 }}>
        {keys.map(k => (
          <kbd key={k} style={{
            padding: '2px 7px', fontSize: 10,
            background: 'var(--bg-deep)', color: 'var(--ink-2)',
            border: '1px solid var(--border)', borderRadius: 3,
            fontFamily: 'var(--font-mono)',
          }}>{k}</kbd>
        ))}
      </div>
      <span style={{ fontSize: 11, color: 'var(--ink-muted)' }}>{label}</span>
    </div>
  )

  const ActionBtn = ({ icon, label, sub, onClick }) => (
    <button onClick={onClick} style={{
      display: 'flex', flexDirection: 'column', alignItems: 'flex-start',
      padding: '12px 14px', gap: 3,
      background: 'var(--bg-raised)', border: '1px solid var(--border-soft)',
      borderRadius: 6, cursor: 'pointer', textAlign: 'left', width: '100%',
      transition: 'all 0.15s',
    }}
    onMouseEnter={e => { e.currentTarget.style.borderColor='var(--accent)'; e.currentTarget.style.background='var(--bg-hover)' }}
    onMouseLeave={e => { e.currentTarget.style.borderColor='var(--border-soft)'; e.currentTarget.style.background='var(--bg-raised)' }}>
      {typeof icon === 'string'
        ? <span style={{ fontSize: 18 }}>{icon}</span>
        : <span style={{ display: 'flex' }}>{icon}</span>}
      <span style={{ fontSize: 12, color: 'var(--ink)', fontWeight: 600,
        fontFamily: 'var(--font-mono)' }}>{label}</span>
      {sub && <span style={{ fontSize: 10, color: 'var(--ink-muted)' }}>{sub}</span>}
    </button>
  )

  return (
    <div style={{ position: 'absolute', inset: 0, display: 'flex',
      alignItems: 'center', justifyContent: 'center', pointerEvents: 'none' }}>
      <div style={{
        pointerEvents: 'all', width: 560,
        background: 'var(--bg-surface)',
        border: '1px solid var(--border)',
        borderRadius: 10, padding: '28px 32px',
        boxShadow: 'var(--shadow-lg)',
      }}>
        <div style={{ marginBottom: 22 }}>
          <div style={{ fontFamily: 'var(--font-display)', fontSize: 26, fontWeight: 600,
            color: 'var(--col-entity)', letterSpacing: '0.01em', fontStyle: 'italic',
            marginBottom: 5 }}>
            FreeFBM
          </div>
          <div style={{ fontSize: 12, color: 'var(--ink-muted)', lineHeight: 1.6 }}>
            Object-Role Modelling 2 — fact-oriented conceptual data modelling
          </div>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8, marginBottom: 22 }}>
          <ActionBtn icon="✦" label="Load sample" sub="Employment schema"
            onClick={() => store.loadModel(SAMPLE)} />
          <ActionBtn icon={<EntityTypeIcon active={false} />} label="Add Entity Type" sub="Press E"
            onClick={() => store.setTool('addEntity')} />
          <ActionBtn icon={<FactTypeIcon active={false} />} label="Add Fact Type" sub="Press F"
            onClick={() => store.setTool('addFact2')} />
        </div>

        <div style={{ height: 1, background: 'var(--border-soft)', margin: '0 0 18px' }}/>

        <div style={{ fontSize: 10, color: 'var(--accent)', textTransform: 'uppercase',
          letterSpacing: '0.1em', marginBottom: 10, fontWeight: 700 }}>
          Keyboard Shortcuts
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0 20px' }}>
          <ShortcutRow keys={['E']}             label="Add entity type" />
          <ShortcutRow keys={['V']}             label="Add value type" />
          <ShortcutRow keys={['F']}             label="Add fact type" />
          <ShortcutRow keys={['U']}             label="Draw subtype arrow" />
          <ShortcutRow keys={['A']}             label="Role connector" />
          <ShortcutRow keys={['S']}             label="Select tool" />
          <ShortcutRow keys={['M']}             label="Mandatory role" />
          <ShortcutRow keys={['I']}             label="Internal uniqueness" />
          <ShortcutRow keys={['Q']}             label="Internal frequency" />
          <ShortcutRow keys={['R']}             label="Value range" />
          <ShortcutRow keys={['C']}             label="Cardinality" />
          <ShortcutRow keys={['Del']}           label="Delete selected" />
          <ShortcutRow keys={['Esc']}           label="Cancel / deselect" />
          <ShortcutRow keys={['Ctrl','Z']}      label="Undo" />
          <ShortcutRow keys={['Ctrl','Y']}      label="Redo" />
          <ShortcutRow keys={['Ctrl','A']}      label="Select all" />
          <ShortcutRow keys={['Ctrl','C']}      label="Copy selection" />
          <ShortcutRow keys={['Ctrl','X']}      label="Cut selection" />
          <ShortcutRow keys={['Ctrl','V']}      label="Paste" />
          <ShortcutRow keys={['Ctrl','D']}      label="Duplicate selection" />
          <ShortcutRow keys={['↑↓←→']}         label="Move selected (10 px)" />
          <ShortcutRow keys={['Shift','↑↓←→']} label="Move selected (50 px)" />
          <ShortcutRow keys={['Shift','click']} label="Multi-select / deselect" />
          <ShortcutRow keys={['Enter']}         label="Commit multi-step construction" />
        </div>

        <div style={{ marginTop: 16, padding: '10px 12px', background: 'var(--bg-raised)',
          border: '1px solid var(--border-soft)', borderRadius: 5,
          fontSize: 11, color: 'var(--ink-3)', lineHeight: 1.6 }}>
          <strong style={{ color: 'var(--ink-2)' }}>Connectors:</strong> Use the{' '}
          <strong style={{ color: 'var(--ink-2)' }}>Connectors</strong> section in the tool panel to link elements.{' '}
          <strong style={{ color: 'var(--ink-2)' }}>Role</strong> (or{' '}
          <kbd style={{ padding: '1px 5px', background:'var(--bg-deep)',
            border:'1px solid var(--border)', borderRadius:3 }}>A</kbd>
          ) — click a role box, then an object type.{' '}
          <strong style={{ color: 'var(--ink-2)' }}>Subtype</strong> (or{' '}
          <kbd style={{ padding: '1px 5px', background:'var(--bg-deep)',
            border:'1px solid var(--border)', borderRadius:3 }}>U</kbd>
          ) — click the subtype entity, then the supertype.{' '}
          <strong style={{ color: 'var(--ink-2)' }}>Constraint</strong> — click an external constraint, then role boxes or subtype relationships to build groups.
        </div>
      </div>
    </div>
  )
}
