// Tools that operate by selecting existing elements rather than creating new ones.
// When one of these tools is active:
//   - canvas default cursor is crosshair
//   - selectable elements show pointer
//   - non-selectable elements show not-allowed
//   - panning and element dragging are disabled
export const SELECTION_MODE_TOOLS = new Set([
  'assignRole',
  'addSubtype',
  'connectConstraint',

  'toggleMandatory',
  'addInternalUniqueness',
  'addInternalFrequency',
  'addConstraint:valueRange',
  'addConstraint:cardinality',
])

export function isSelectionMode(tool) {
  return SELECTION_MODE_TOOLS.has(tool)
}

// Sequence construction (triggered by double-clicking a constraint) follows the
// same cursor/interaction rules as selection-mode tools.
export function isElementSelecting(tool, sequenceConstruction) {
  return SELECTION_MODE_TOOLS.has(tool) || !!sequenceConstruction
}
