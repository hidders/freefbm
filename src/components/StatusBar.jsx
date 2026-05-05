import React from 'react'
import { useOrmStore } from '../store/ormStore'

// ── Tier 1: Tool hints — workflow guidance while a tool is active ─────────────
const TOOL_HINTS = {
  select:             'Click to select · Drag to move · Shift+click to multi-select · Scroll to zoom · Drag canvas to pan',
  addEntity:          'Click canvas to place an Entity Type',
  addValue:           'Click canvas to place a Value Type',
  addFact2:           'Click canvas to place a Binary Fact Type',
  addNestedFact:      'Click canvas to place a Nested Entity Type',
  addNestedValueFact: 'Click canvas to place a Nested Value Type',
  assignRole:         'Click a role box to set the source role · Then click an object type to complete the assignment',
  toggleMandatory:    'Click a role box to toggle its mandatory constraint on/off',
  addInternalUniqueness: 'Click a fact type or role box to start · Click role boxes to build the uniqueness bar · Click the bar or press Enter to commit',
  addInternalFrequency:  'Click a fact type to select it · Click role boxes to include them · Click the constraint or press Enter to set the frequency range',
  addSubtype:         'Click the subtype object type, then the supertype object type to draw a subtype arrow',
  connectConstraint:  'Click an external constraint · Click role boxes or subtype relationships to build sequences · Click the constraint or press Enter to commit',
  addTargetConnector: 'Click an external constraint · Click an object type to set its target object type',
  'addConstraint:uniqueness':      'Click canvas to place an External Uniqueness constraint · Double-click the constraint to add a role sequence',
  'addConstraint:inclusiveOr':     'Click canvas to place an Inclusive Or constraint · Double-click the constraint to add a role sequence',
  'addConstraint:exclusion':       'Click canvas to place an Exclusion constraint · Double-click the constraint to add a role sequence',
  'addConstraint:exclusiveOr':     'Click canvas to place an Exclusive Or constraint · Double-click the constraint to add a role sequence',
  'addConstraint:equality':        'Click canvas to place an Equality constraint · Double-click the constraint to add a role sequence',
  'addConstraint:subset':          'Click canvas to place a Subset constraint · Double-click the constraint to add a role sequence',
  'addConstraint:ring':            'Click canvas to place a Ring constraint · Double-click the constraint to add a role sequence',
  'addConstraint:valueComparison': 'Click canvas to place a Value Comparison constraint · Double-click the constraint to add a role sequence',
  'addConstraint:frequency':       'Click canvas to place an External Frequency constraint · Double-click the constraint to add a role sequence',
  'addConstraint:valueRange':      'Click a role box or object type to set a value range',
  'addConstraint:cardinality':     'Click a role box or object type to set a cardinality range',
}

export default function StatusBar() {
  const store = useOrmStore()
  const isSel = store.tool === 'select'

  // ── Tier 3 (highest): construction-in-progress hints ─────────────────────
  const constructionHint = store.frequencyConstruction
    ? store.frequencyConstruction.stage === 2
      ? 'Click role boxes to include them in the frequency constraint · Click the constraint or press Enter to advance · Esc to cancel'
      : store.frequencyConstruction.stage === 3
        ? 'Set the frequency range in the popup · Press Enter to commit · Esc to cancel'
        : null
    : null

  // ── Tier 2: selection hints — affordances for the selected element ────────
  const factHint = isSel && store.selectedKind === 'fact'
    ? 'Click inside a role to select it · Double-click inside a role to start a connector · Click a uniqueness bar to select it · Right-click for more options'
    : null

  const otHint = isSel && (store.selectedKind === 'entity' || store.selectedKind === 'value')
    ? 'Double-click to rename · Right-click for more options'
    : null

  const roleHint = isSel && store.selectedRole
    ? 'Double-click to start a connector · Click inside role again to deselect · Click role border to select fact · Right-click for options'
    : null

  const subtypeHint = isSel && store.selectedKind === 'subtype'
    ? 'Right-click for options'
    : null

  const constraintHint = isSel && store.selectedKind === 'constraint'
    ? 'Double-click to add a role sequence · Right-click for more options'
    : null

  const uniquenessHint = isSel && store.selectedUniqueness
    ? 'Double-click to edit role selection · Click the bar or press Enter to commit · Right-click for options'
    : null

  const internalFrequencyHint = isSel && store.selectedInternalFrequency
    ? 'Double-click to edit role selection · Click the constraint or press Enter to commit · Right-click for options'
    : null

  const selectionHint = uniquenessHint || internalFrequencyHint || factHint || otHint
    || roleHint || subtypeHint || constraintHint

  // ── Tier 1: tool hint ─────────────────────────────────────────────────────
  const toolHint = TOOL_HINTS[store.tool]
    || (store.tool.startsWith('addConstraint:')
        ? `Click canvas to place a ${store.tool.split(':')[1]} external constraint`
        : '')

  const hint = constructionHint || selectionHint || toolHint

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
        <span style={{ fontSize: 11, color: 'var(--danger)' }}>● unsaved</span>
      )}
      <span style={{ fontSize: 11, color: 'var(--ink-muted)' }}>
        {store.objectTypes.length} types · {store.facts.length} facts · {store.constraints.length} constraints
      </span>
    </div>
  )
}
