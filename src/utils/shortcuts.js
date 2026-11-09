// The keyboard shortcuts, for Help › Keyboard Shortcuts (ShortcutsDialog.jsx)
// and the welcome screen. Keys are written for the platform: ⌘ on macOS,
// Ctrl elsewhere. Keep this list in step with the handlers in App.jsx,
// useUndoRedo.js, Sidebar.jsx, Canvas.jsx and the menus in electron/main.cjs.

export const isMac = typeof navigator !== 'undefined' && /Mac/.test(navigator.platform)

const MOD   = isMac ? '⌘' : 'Ctrl'
const SHIFT = isMac ? '⇧' : 'Shift'
// Shift with the modifier: ⇧⌘ on macOS, Ctrl+Shift elsewhere.
const MOD_SHIFT = isMac ? [SHIFT, MOD] : [MOD, SHIFT]

export const SHORTCUT_GROUPS = [
  { title: 'Tools', items: [
    [['S'], 'Select'],
    [['E'], 'Entity type'],
    [['V'], 'Value type'],
    [['F'], 'Fact type'],
    [['A'], 'Role connector'],
    [['U'], 'Subtype link'],
    [['N'], 'Note'],
    [['M'], 'Mandatory role'],
    [['I'], 'Internal uniqueness'],
    [['Q'], 'Internal frequency'],
    [['R'], 'Value range'],
    [['C'], 'Cardinality range'],
  ] },
  { title: 'Editing', items: [
    [[MOD, 'Z'], 'Undo'],
    [isMac ? [...MOD_SHIFT, 'Z'] : [MOD, 'Y'], 'Redo'],
    [[MOD, 'X'], 'Cut'],
    [[MOD, 'C'], 'Copy'],
    [[MOD, 'V'], 'Paste'],
    [[MOD, 'D'], 'Duplicate'],
    [[MOD, 'A'], 'Select all'],
    [[isMac ? '⌫' : 'Del'], 'Remove from diagram'],
    [['Enter'], 'Finish a constraint being built'],
    [['Esc'], 'Cancel, or clear the selection'],
    [['↑↓←→'], 'Move the selection 10 px'],
    [[SHIFT, '↑↓←→'], 'Move the selection 50 px'],
    [[SHIFT, 'click'], 'Add to or take from the selection'],
  ] },
  { title: 'File', items: [
    [[MOD, 'N'], 'New model'],
    [[MOD, 'O'], 'Open…'],
    [[MOD, 'S'], 'Save'],
    [[...MOD_SHIFT, 'S'], 'Save as…'],
    [[...MOD_SHIFT, 'E'], 'Export to PDF…'],
  ] },
  { title: 'View', items: [
    [[MOD, '='], 'Zoom in'],
    [[MOD, '−'], 'Zoom out'],
    [[MOD, '0'], 'Reset zoom'],
    [['Space', 'drag'], 'Pan'],
    [['hold', SHIFT], 'Snap to grid on or off while dragging'],
    [[MOD, '1'], 'Show or hide the Browser'],
    [[MOD, '2'], 'Show or hide the Problems'],
    [[MOD, 'F'], 'Filter the Browser by name'],
    [[...MOD_SHIFT, 'B'], 'Verbalisation workbench'],
    [['?'], 'This list'],
    [[MOD, '/'], 'This list, from any field (Help menu)'],
  ] },
]
