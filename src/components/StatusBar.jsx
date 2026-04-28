import React from 'react'
import { useOrmStore } from '../store/ormStore'

const HINTS = {
  select:          '↖ Click to select · Drag to move · Shift+click to multi-select · Scroll to zoom · Drag canvas to pan',
  addEntity:       '□ Click canvas to place an Entity Type',
  addValue:        '◯ Click canvas to place a Value Type',
  addFact2:        '▭▭ Click canvas to place a Binary Fact Type',
  addNestedFact:      '⬜▭▭ Click canvas to place a Nested Entity Type',
  addNestedValueFact: '⬜▭▭ Click canvas to place a Nested Value Type',
  assignRole:      '⇢ Click a role box, then an object type to assign it · Returns to Select when done',
  toggleMandatory:       '● Click a role box to toggle its mandatory constraint on/off',
  addInternalUniqueness: '▔ Click a fact type or role box to start · then click role boxes to build the uniqueness bar · Enter to commit',
  addInternalFrequency:  '≤n Click a fact type to select it · then click role boxes to include them · Enter to set the frequency range',
  'addConstraint:valueRange':  '{a,b} Click a role box or object type to set a value range',
  'addConstraint:cardinality': '#≤n Click a role box or object type to set a cardinality range',
  addSubtype:        '⊂ Click source entity, then target entity to draw a subtype arrow',
  connectConstraint:    '⊗ Click an external constraint, then role boxes or subtype relationships to build sequences · Enter to commit',
  addTargetConnector:   '⊷ Click an external constraint, then an object type to set its Target Object Name',
}

export default function StatusBar() {
  const store = useOrmStore()

  // When a fact type is selected and the select tool is active, show role hints
  const factSelected = store.tool === 'select' && store.selectedKind === 'fact'
  const factHint = factSelected
    ? '▭ Shift+click role to mark · Enter to commit uniqueness constraint · Click bar to edit it · Right-click role for options'
    : null

  const frequencyHint = store.frequencyConstruction
    ? store.frequencyConstruction.stage === 2
      ? '≤n Click role boxes to include them in the frequency constraint · Enter to set the range · Esc to cancel'
      : store.frequencyConstruction.stage === 3
        ? '≤n Set the frequency range in the popup · Enter to commit · Esc to cancel'
        : null
    : null

  const hint = frequencyHint
    || factHint
    || HINTS[store.tool]
    || (store.tool.startsWith('addConstraint:')
        ? `⊗ Click canvas to place a ${store.tool.split(':')[1]} external constraint`
        : '')

  return (
    <div style={{ height: 26, display: 'flex', alignItems: 'center',
      padding: '0 14px', gap: 16,
      background: 'var(--bg-surface)', borderTop: '1px solid var(--border-soft)',
      flexShrink: 0 }}>
      <span style={{ fontSize: 11, color: 'var(--ink-muted)', flex: 1 }}>{hint}</span>
      <span style={{ fontSize: 11, color: 'var(--ink-muted)' }}>
        {Math.round(store.zoom * 100)}%
      </span>
      {store.isDirty && (
        <span style={{ fontSize: 11, color: '#c0392b' }}>● unsaved</span>
      )}
      <span style={{ fontSize: 11, color: 'var(--ink-muted)' }}>
        {store.objectTypes.length} types · {store.facts.length} facts · {store.constraints.length} constraints
      </span>
    </div>
  )
}
