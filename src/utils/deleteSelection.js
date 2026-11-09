// What Delete does (decided 2026-11-09, see the UI review):
//
// - Delete and Backspace take the selection off the active diagram. Object
//   types, fact types, external constraints and subtype links stay in the
//   schema; undo puts them back.
// - A note belongs to its diagram, so it is deleted.
// - Internal constraints have no occurrence of their own (uniqueness bars,
//   mandatory dots, internal frequencies, value and cardinality ranges): Delete
//   removes them from their fact type.
// - Deleting from the schema is the menu item Delete from Schema…, which asks
//   first and lists what goes with it (DeleteFromSchemaDialog.jsx).

import { useOrmStore } from '../store/ormStore'
import { activeReadOnly } from '../relational/face'
import { CONSTRAINT_LABELS } from '../logic/constraintFormulas'
import { factLabel } from './neighbourhood'

// Delete / Backspace and Edit › Remove from Diagram. Returns false when there
// was nothing to remove.
export function removeSelectionFromDiagram() {
  const before = shownElementIds(useOrmStore.getState())
  const done = removeSelection()
  if (done) noteOrphans(before)
  return done
}

// The object types and fact types of the selection that some diagram shows.
function shownElementIds(s) {
  const ids = new Set(s.multiSelectedIds.length ? s.multiSelectedIds : s.selectedId ? [s.selectedId] : [])
  const shown = new Set(s.diagrams.flatMap(d => (d.occurrences ?? []).map(o => o.schemaElementId)))
  return [...ids].filter(id => shown.has(id) && (s.objectTypes.some(o => o.id === id) || s.facts.some(f => f.id === id)))
}

// Says so in the status bar when an element is now on no diagram.
function noteOrphans(before) {
  const s = useOrmStore.getState()
  const shown = new Set(s.diagrams.flatMap(d => (d.occurrences ?? []).map(o => o.schemaElementId)))
  const ids = before.filter(id => !shown.has(id))
  if (!ids.length || activeReadOnly(s)) return
  const text = ids.length === 1 ? `${nameOf(s, ids[0])} is now on no diagram` : `${ids.length} elements are now on no diagram`
  useOrmStore.setState({ orphanNotice: { at: Date.now(), ids, text } })
}

function removeSelection() {
  const s = useOrmStore.getState()

  // Internal constraints: removed from their fact type.
  if (s.selectedMandatoryDot) {
    if (s.selectedMandatoryDot.implied) return true   // implied: cannot be removed
    const { factId, roleIndex } = s.selectedMandatoryDot
    s.removeMandatoryRole(factId, roleIndex)
    return true
  }
  if (s.selectedInternalFrequency) {
    const { factId, ifId } = s.selectedInternalFrequency
    s.removeInternalFrequency(factId, ifId)
    return true
  }
  if (s.selectedValueRange) { s.removeValueRange(s.selectedValueRange); return true }
  if (s.selectedCardinalityRange) { s.removeCardinalityRange(s.selectedCardinalityRange); return true }

  // An implicit link of an objectified fact type is hidden on this diagram.
  if (s.selectedKind === 'implicitLink') {
    const roleIndex = s.selectedImplicitLinkRole?.roleIndex ?? s.selectedImplicitLink
    if (roleIndex != null) { s.toggleImplicitLink(s.selectedId, roleIndex); return true }
  }

  const { selectedId, selectedKind, selectedUniqueness, uniquenessConstruction, multiSelectedIds, activeDiagramId } = s

  if (multiSelectedIds.length > 0) {
    s.removeMultiSelectionFromDiagram(activeDiagramId)
    s.clearSelection()
    return true
  }

  if (uniquenessConstruction?.uIndex != null) {
    // The bar being edited: delete it and leave construction mode.
    const fact = s.facts.find(f => f.id === uniquenessConstruction.factId)
    const roles = fact?.uniqueness[uniquenessConstruction.uIndex]?.roles
    if (roles) s.toggleUniqueness(uniquenessConstruction.factId, roles)
    s.clearSelection()
    return true
  }
  if (selectedUniqueness) {
    if (selectedUniqueness.implied) return true
    const fact = s.facts.find(f => f.id === selectedUniqueness.factId)
    if (fact) {
      s.removeUniqueness(selectedUniqueness.factId, fact.uniqueness[selectedUniqueness.uIndex]?.roles)
      s.clearSelection()
    }
    return true
  }

  if (!selectedId) return false
  if (selectedKind === 'group') { s.deleteGroup(selectedId); return true }   // groups are not drawn
  if (selectedKind === 'note')  { s.deleteNote(selectedId); return true }
  s.removeSelectedFromDiagram()
  s.clearSelection()
  return true
}

// The ids Delete from Schema… would delete for the current selection.
export function schemaDeletionIds(state = useOrmStore.getState()) {
  const ids = state.multiSelectedIds.length ? state.multiSelectedIds : state.selectedId ? [state.selectedId] : []
  return ids.filter(id => !id.includes('_il_') && kindOf(state, id))
}

function kindOf(state, id) {
  if (state.objectTypes.some(o => o.id === id)) return 'objectType'
  if (state.facts.some(f => f.id === id)) return 'fact'
  if (state.constraints.some(c => c.id === id)) return 'constraint'
  if (state.subtypes.some(st => st.id === id)) return 'subtype'
  return null
}

export function canDeleteFromSchema(state = useOrmStore.getState(), ids = schemaDeletionIds(state)) {
  return ids.length > 0 && !activeReadOnly(state)
}

// Opens the confirmation (Edit › Delete from Schema…, context menus).
export function openDeleteFromSchema(ids = schemaDeletionIds()) {
  const s = useOrmStore.getState()
  if (!canDeleteFromSchema(s, ids)) return
  useOrmStore.setState({ deleteFromSchemaDialog: { ids: [...new Set(ids)] } })
}

const nameOf = (state, id) => {
  const o = state.objectTypes.find(x => x.id === id)
  if (o) return o.name || '(unnamed)'
  const f = state.facts.find(x => x.id === id)
  return f ? f.objectifiedName || f.name || '(unnamed)' : '?'
}

// What deleting the ids does: the elements themselves and what goes with them.
export function deletionSummary(state, ids) {
  const idSet = new Set(ids)
  const ots = state.objectTypes.filter(o => idSet.has(o.id))
  const facts = state.facts.filter(f => idSet.has(f.id))
  const constraints = state.constraints.filter(c => idSet.has(c.id))
  const subtypes = state.subtypes.filter(st => idSet.has(st.id))
  const otIds = new Set(ots.map(o => o.id))
  const factIds = new Set(facts.map(f => f.id))

  const elements = [
    ...ots.map(o => `${o.kind === 'value' ? 'Value type' : 'Entity type'} ${o.name || '(unnamed)'}`),
    ...facts.map(f => `${f.objectified ? 'Objectified fact type' : 'Fact type'} ${f.objectifiedName || factLabel(state, f)}`),
    ...constraints.map(c => `${CONSTRAINT_LABELS[c.constraintType] ?? 'Constraint'}${c.name ? ` ${c.name}` : ''}`),
    ...subtypes.map(st => `Subtype link ${nameOf(state, st.subId)} → ${nameOf(state, st.superId)}`),
  ]

  const consequences = []
  const orphaned = state.facts.filter(f => !factIds.has(f.id) && f.roles.some(r => otIds.has(r.objectTypeId)))
  if (orphaned.length) consequences.push(`${orphaned.length} fact type${orphaned.length > 1 ? 's' : ''} lose${orphaned.length > 1 ? '' : 's'} a role player (${orphaned.slice(0, 4).map(f => factLabel(state, f)).join('; ')}${orphaned.length > 4 ? '; …' : ''})`)
  const links = state.subtypes.filter(st => !idSet.has(st.id) && (otIds.has(st.subId) || otIds.has(st.superId)))
  if (links.length) consequences.push(`${links.length} subtype link${links.length > 1 ? 's go' : ' goes'} with ${links.length > 1 ? 'them' : 'it'}`)
  const goneSubtypes = new Set([...subtypes.map(st => st.id), ...links.map(st => st.id)])
  const touched = state.constraints.filter(c => !idSet.has(c.id) && (
    (c.roleSequences ?? []).some(g => g.some(r => factIds.has(r.factId))) ||
    (c.sequences ?? []).some(g => g.some(m => (m.kind === 'role' && factIds.has(m.factId)) || (m.kind === 'subtype' && goneSubtypes.has(m.subtypeId)))) ||
    (c.subtypeIds ?? []).some(id => goneSubtypes.has(id))))
  if (touched.length) consequences.push(`${touched.length} other constraint${touched.length > 1 ? 's lose' : ' loses'} the roles or subtype links ${touched.length > 1 ? 'they name' : 'it names'}`)
  const diagrams = state.diagrams.filter(d => (d.occurrences ?? []).some(o => idSet.has(o.schemaElementId)) ||
    (d.constraintOccurrences ?? []).some(o => idSet.has(o.schemaConstraintId)))
  if (diagrams.length) consequences.push(`Taken off ${diagrams.length === 1 ? `the diagram ${diagrams[0].name}` : `${diagrams.length} diagrams`}`)
  return { elements, consequences }
}

// Deletes the ids from the schema as one undo step.
export function deleteFromSchema(ids) {
  const store = useOrmStore
  const st = store.getState()
  const by = (k) => ids.filter(id => kindOf(st, id) === k)
  store.setState(s => ({ historyBatch: (s.historyBatch ?? 0) + 1 }))
  try {
    for (const id of by('constraint')) store.getState().deleteConstraint(id)
    for (const id of by('subtype')) store.getState().deleteSubtype(id)
    for (const id of by('fact')) store.getState().deleteFact(id)
    for (const id of by('objectType')) store.getState().deleteObjectType(id)
    store.getState().clearSelection()
  } finally {
    store.setState(s => ({ historyBatch: Math.max(0, (s.historyBatch ?? 1) - 1) }))
  }
}
