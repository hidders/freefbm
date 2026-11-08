// Import notes: what an import (NORMA .orm) adapted to FreeFBM's data model,
// kept on the element it is about so that the user can review it.
//
// An element (object type, fact type, subtype link or constraint) may carry
//   importNotes: [{ id, severity, text }]
// with severity
//   'changed'   the meaning changed or something was lost
//   'rewritten' written differently, with the same meaning
// They are saved in the file and shown as a badge on the canvas (Canvas.jsx
// ImportNoteBadges), in the Inspector (dismiss, show as a diagram note) and
// under Import in the Validation panel. Dismissing one removes it.

export const IMPORT_NOTE_KINDS = ['objectTypes', 'facts', 'subtypes', 'constraints']

export const IMPORT_NOTE_SEVERITY = {
  changed:   { label: 'Meaning changed', colour: '#7c3aed', icon: '✎' },
  rewritten: { label: 'Rewritten',       colour: '#64748b', icon: '✎' },
}

// The fill and text of a diagram note made from an import note.
export const IMPORT_NOTE_STYLE = {
  changed:   { fill: '#f3e8ff', outline: '#7c3aed', text: '#3b0764' },
  rewritten: { fill: '#f1f5f9', outline: '#64748b', text: '#1e293b' },
}

// Adds an import note to an element (an importer's helper). Returns the note.
export function addImportNote(el, severity, text) {
  if (!el) return null
  const notes = el.importNotes ??= []
  if (notes.some(n => n.text === text)) return null
  const note = { id: `imp${notes.length + 1}`, severity, text }
  notes.push(note)
  return note
}

// Every import note of the state: [{ element, kind, note }], kind being the
// state's collection ('objectTypes', 'facts', …).
export function allImportNotes(state) {
  const out = []
  for (const kind of IMPORT_NOTE_KINDS)
    for (const element of state[kind] ?? [])
      for (const note of element.importNotes ?? []) out.push({ element, kind, note })
  return out
}

// The element kind the store's navigation and selection use.
export function elementKindOf(element, kind) {
  if (kind === 'facts') return 'fact'
  if (kind === 'subtypes') return 'subtype'
  if (kind === 'constraints') return 'constraint'
  return element.kind
}

// A short name for the element an import note is on (Validation panel).
export function importNoteElementLabel(state, element, kind, factLabel) {
  const typeName = id => state.objectTypes?.find(o => o.id === id)?.name
    ?? state.facts?.find(f => f.id === id)?.objectifiedName ?? '?'
  if (kind === 'objectTypes') return element.name
  if (kind === 'facts') return factLabel?.(element) ?? element.name ?? 'fact type'
  if (kind === 'subtypes') return `${typeName(element.subId)} is a subtype of ${typeName(element.superId)}`
  const type = element.constraintType ?? 'constraint'
  return element.name ? `${element.name} (${type})` : type
}
