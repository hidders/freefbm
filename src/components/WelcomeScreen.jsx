import React from 'react'
import { useOrmStore } from '../store/ormStore'
import { EntityTypeIcon, FactTypeIcon } from './ToolPanel'

// Sample ORM2 model: a small employment/project schema.
// Snapshot taken from a saved model; preserves user-tuned layout (e.g. the
// vertical "has PersonName" and "sponsors" facts, the relocated Salary node).
const SAMPLE = {
  objectTypes: [
    { id: 'ot1', kind: 'entity', name: 'Person',     x: 160, y: 160 },
    { id: 'ot2', kind: 'entity', name: 'Company',    x: 500, y: 160, isIndependent: true },
    { id: 'ot3', kind: 'entity', name: 'Project',    x: 500, y: 360 },
    { id: 'ot4', kind: 'value',  name: 'PersonName', x: 160, y: 310 },
    { id: 'ot5', kind: 'value',  name: 'Salary',     x: 330, y: 80,
      datatypeAssignment: { profileId: 'abstract', datatypeId: 'integer', params: {} } },
    { id: 'ot6', kind: 'entity', name: 'Manager',    x: 160, y: 460, isIndependent: true },
    { id: 'rv1', kind: 'value',  name: 'PersonId',   x: 240, y: 160 },
    { id: 'rv2', kind: 'value',  name: 'CompanyName',x: 580, y: 160 },
    { id: 'rv3', kind: 'value',  name: 'ProjectId',  x: 580, y: 360 },
    { id: 'rv4', kind: 'value',  name: 'ManagerId',  x: 240, y: 460 },
  ],
  facts: [
    {
      id: 'rf1', kind: 'fact', x: 200, y: 160, arity: 2,
      readingParts: ['', 'has', ''],
      alternativeReadings: [{ roleOrder: [1, 0], parts: ['', 'refers to', ''] }],
      roles: [
        { id: 'rr1a', objectTypeId: 'ot1', roleName: '', mandatory: false, linkReadingParts: ['', '', ''], linkReadingReverseParts: null },
        { id: 'rr1b', objectTypeId: 'rv1', roleName: '', mandatory: false, linkReadingParts: ['', '', ''], linkReadingReverseParts: null },
      ],
      uniqueness: [[0], [1]], preferredUniqueness: [[1]],
      readingDisplay: 'forward', uniquenessBelow: false, readingAbove: false,
      internalFrequency: [], implicitLinks: [], shownReadingOrder: null, orientation: 'horizontal',
    },
    {
      id: 'rf2', kind: 'fact', x: 540, y: 160, arity: 2,
      readingParts: ['', 'has', ''],
      alternativeReadings: [{ roleOrder: [1, 0], parts: ['', 'refers to', ''] }],
      roles: [
        { id: 'rr2a', objectTypeId: 'ot2', roleName: '', mandatory: false, linkReadingParts: ['', '', ''], linkReadingReverseParts: null },
        { id: 'rr2b', objectTypeId: 'rv2', roleName: '', mandatory: false, linkReadingParts: ['', '', ''], linkReadingReverseParts: null },
      ],
      uniqueness: [[0], [1]], preferredUniqueness: [[1]],
      readingDisplay: 'forward', uniquenessBelow: false, readingAbove: false,
      internalFrequency: [], implicitLinks: [], shownReadingOrder: null, orientation: 'horizontal',
    },
    {
      id: 'rf3', kind: 'fact', x: 540, y: 360, arity: 2,
      readingParts: ['', 'has', ''],
      alternativeReadings: [{ roleOrder: [1, 0], parts: ['', 'refers to', ''] }],
      roles: [
        { id: 'rr3a', objectTypeId: 'ot3', roleName: '', mandatory: false, linkReadingParts: ['', '', ''], linkReadingReverseParts: null },
        { id: 'rr3b', objectTypeId: 'rv3', roleName: '', mandatory: false, linkReadingParts: ['', '', ''], linkReadingReverseParts: null },
      ],
      uniqueness: [[0], [1]], preferredUniqueness: [[1]],
      readingDisplay: 'forward', uniquenessBelow: false, readingAbove: false,
      internalFrequency: [], implicitLinks: [], shownReadingOrder: null, orientation: 'horizontal',
    },
    {
      id: 'rf4', kind: 'fact', x: 200, y: 460, arity: 2,
      readingParts: ['', 'has', ''],
      alternativeReadings: [{ roleOrder: [1, 0], parts: ['', 'refers to', ''] }],
      roles: [
        { id: 'rr4a', objectTypeId: 'ot6', roleName: '', mandatory: false, linkReadingParts: ['', '', ''], linkReadingReverseParts: null },
        { id: 'rr4b', objectTypeId: 'rv4', roleName: '', mandatory: false, linkReadingParts: ['', '', ''], linkReadingReverseParts: null },
      ],
      uniqueness: [[0], [1]], preferredUniqueness: [[1]],
      readingDisplay: 'forward', uniquenessBelow: false, readingAbove: false,
      internalFrequency: [], implicitLinks: [], shownReadingOrder: null, orientation: 'horizontal',
    },
    {
      id: 'f1', kind: 'fact', x: 330, y: 160, arity: 2,
      readingParts: ['', 'is employed by', ''],
      roles: [
        { id: 'r1a', objectTypeId: 'ot1', roleName: '', mandatory: true,  linkReadingParts: ['', '', ''], linkReadingReverseParts: null },
        { id: 'r1b', objectTypeId: 'ot2', roleName: '', mandatory: false, linkReadingParts: ['', '', ''], linkReadingReverseParts: null },
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
        { id: 'r2a', objectTypeId: 'ot1', roleName: '', mandatory: true,  linkReadingParts: ['', '', ''], linkReadingReverseParts: null },
        { id: 'r2b', objectTypeId: 'ot4', roleName: '', mandatory: false, linkReadingParts: ['', '', ''], linkReadingReverseParts: null },
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
        { id: 'r3a', objectTypeId: 'ot1', roleName: '', mandatory: false, linkReadingParts: ['', '', ''], linkReadingReverseParts: null },
        { id: 'r3b', objectTypeId: 'ot5', roleName: '', mandatory: false, linkReadingParts: ['', '', ''], linkReadingReverseParts: null },
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
        { id: 'r4a', objectTypeId: 'ot2', roleName: '', mandatory: false, linkReadingParts: ['', '', ''], linkReadingReverseParts: null },
        { id: 'r4b', objectTypeId: 'ot3', roleName: '', mandatory: true,  linkReadingParts: ['', '', ''], linkReadingReverseParts: null },
      ],
      uniqueness: [[1]],
      readingDisplay: 'forward', alternativeReadings: [], uniquenessBelow: false,
      readingAbove: false, readingOffset: null, internalFrequency: [], implicitLinks: [],
      preferredUniqueness: [], shownReadingOrder: null, orientation: 'horizontal',
    },
  ],
  subtypes: [
    // Manager has its own .id ref mode, so the subtype edge to Person does
    // NOT inherit Person's PI — instances are mapped explicitly via the
    // subtype-edge population.
    { id: 'st1', kind: 'subtype', subId: 'ot6', superId: 'ot1',
      exclusive: false, exhaustive: false, inheritsPreferredIdentifier: false },
  ],
  constraints: [
    {
      id: 'c1', kind: 'constraint', constraintType: 'ring', x: 130, y: 410,
      sequences: [[
        { kind: 'role', factId: 'f1', roleIndex: 0 },
        { kind: 'role', factId: 'f1', roleIndex: 1 },
      ]],
      ringTypes: ['irreflexive'],
      queries: [{
        copies: [
          { id: 'n1779876495448_2', kind: 'fact',       originalId: 'f1',  isOutput: false, seededRoles: [{ roleIndex: 0, seqPosition: 0 }], dx: 16, dy: 16 },
          { id: 'n1779876495448_3', kind: 'fact',       originalId: 'f1',  isOutput: false, seededRoles: [{ roleIndex: 1, seqPosition: 1 }], dx: 32, dy: 32 },
          { id: 'n1779876504508_4', kind: 'objectType', originalId: 'ot1', isOutput: false, dx: 16, dy: 16 },
          { id: 'n1779876509442_5', kind: 'objectType', originalId: 'ot2', isOutput: false, dx: 16, dy: 16 },
        ],
        links: [
          { copyId: 'n1779876495448_2', roleIndex: 0, variableId: 'n1779876504508_4' },
          { copyId: 'n1779876495448_3', roleIndex: 0, variableId: 'n1779876504508_4' },
          { copyId: 'n1779876495448_2', roleIndex: 1, variableId: 'n1779876509442_5' },
          { copyId: 'n1779876495448_3', roleIndex: 1, variableId: 'n1779876509442_5' },
        ],
      }],
    },
  ],
  diagrams: [
    {
      id: 'sample_main',
      name: 'Main',
      elementIds: ['ot1','ot2','ot3','ot4','ot5','ot6','rv1','rv2','rv3','rv4',
                   'rf1','rf2','rf3','rf4','f1','f2','f3','f4','c1'],
      positions: {
        ot1: { x: 160, y: 160 },
        ot2: { x: 500, y: 160 },
        ot3: { x: 500, y: 360 },
        ot4: { x:  90, y: 360 },
        ot5: { x: 450, y: 70  },
        ot6: { x: 260, y: 350 },
        rv1: { x: 240, y: 160 },
        rv2: { x: 580, y: 160 },
        rv3: { x: 580, y: 360 },
        rv4: { x: 240, y: 460 },
        rf1: { x: 200, y: 160 },
        rf2: { x: 540, y: 160 },
        rf3: { x: 540, y: 360 },
        rf4: { x: 200, y: 460 },
        f1:  { x: 330, y: 160 },
        f2:  { x: 110, y: 260, orientation: 'vertical' },
        f3:  { x: 330, y:  80 },
        f4:  { x: 500, y: 260, orientation: 'vertical' },
        c1:  { x: 360, y: 220 },
      },
      expandedRefModes: [],
      profileId: 'abstract',
    },
  ],
  activeDiagramId: 'sample_main',
  populations: {
    ot1: ['P001', 'P002', 'P003'],
    ot2: ['Acme', 'BigCo', 'Initech'],
    ot3: ['PRJ-1', 'PRJ-2'],
    ot4: ['Alice', 'Bob', 'Carol'],
    ot5: ['50000', '60000', '75000'],
    ot6: ['M001'],
    rv1: ['P001', 'P002', 'P003'],
    rv2: ['Acme', 'BigCo', 'Initech'],
    rv3: ['PRJ-1', 'PRJ-2'],
    rv4: ['M001'],
  },
  factPopulations: {
    f1: [['P001', 'Acme'], ['P002', 'BigCo'], ['P003', 'Acme']],
    f2: [['P001', 'Alice'], ['P002', 'Bob'], ['P003', 'Carol']],
    f3: [['P001', '50000'], ['P002', '75000'], ['P003', '60000']],
    f4: [['BigCo', 'PRJ-1'], ['Acme', 'PRJ-2']],
  },
  subtypeMappings: {
    // Manager M001 corresponds to Person P002 (i.e., Bob).
    st1: [['P002']],
  },
  nestedEntityMappings: {},
}

export default function WelcomeScreen({ onClose }) {
  const store = useOrmStore()

  const handleDontShow = (e) => {
    if (e.target.checked) {
      localStorage.setItem('hideWelcome', 'true')
      onClose?.()
    } else {
      localStorage.removeItem('hideWelcome')
    }
  }

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
        position: 'relative',
      }}>
        {onClose && (
          <button onClick={onClose} style={{
            position: 'absolute', top: 10, right: 10,
            width: 24, height: 24, border: 'none', background: 'transparent',
            cursor: 'pointer', color: 'var(--ink-muted)', fontSize: 16, lineHeight: 1,
            borderRadius: 4, display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}
          onMouseEnter={e => { e.currentTarget.style.background = 'var(--bg-hover)'; e.currentTarget.style.color = 'var(--ink)' }}
          onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'var(--ink-muted)' }}
          title="Close">×</button>
        )}
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

        {onClose && (
          <div style={{ marginTop: 14, display: 'flex', alignItems: 'center', gap: 7 }}>
            <input type="checkbox" id="hide-welcome" style={{ cursor: 'pointer', margin: 0 }}
              onChange={handleDontShow} />
            <label htmlFor="hide-welcome" style={{
              fontSize: 11, color: 'var(--ink-muted)', cursor: 'pointer', userSelect: 'none',
            }}>Do not show this window at startup</label>
          </div>
        )}
      </div>
    </div>
  )
}
