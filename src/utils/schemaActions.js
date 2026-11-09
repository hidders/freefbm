// The Schema menu (electron/main.cjs): what can be done with the active schema.
// Each action has a fixed id, which is the menu item's id; `schemaMenuState`
// says which are enabled (sent to the main process by useElectronMenu), and
// `runSchemaAction` runs one. The schema strip's + menu offers the same
// actions for every schema.

import { useOrmStore } from '../store/ormStore'
import { activeSchemaIdOf } from '../store/storeHelpers'

export const SCHEMA_ACTIONS = [
  'schema:newOrm2', 'schema:newRelational',
  'schema:generateTables', 'schema:guessOrm', 'schema:transform', 'schema:refactor', 'schema:derivedTable',
  'schema:delete',
]

const isDerived = (x) => x.derivation === 'derived' || x.derivation === 'semiDerived'

export function schemaMenuState(state) {
  const id = activeSchemaIdOf(state)
  const sc = (state.schemas ?? []).find(x => x.id === id)
  const relational = sc?.profile === 'relational'
  const refactorable = !!sc && ((state.objectTypes ?? []).some(o => o.schemaId === id && isDerived(o))
    || (state.facts ?? []).some(f => f.schemaId === id && isDerived(f)))
  return {
    'schema:newOrm2': true,
    'schema:newRelational': true,
    'schema:generateTables': !!sc && !relational,
    'schema:guessOrm': !!sc && relational,
    'schema:transform': !!sc,
    'schema:refactor': refactorable,
    'schema:derivedTable': !!sc && relational,
    'schema:delete': !!sc && (state.schemas?.length ?? 0) > 1,
  }
}

export function runSchemaAction(action) {
  const st = useOrmStore.getState()
  if (!schemaMenuState(st)[action]) return
  const id = activeSchemaIdOf(st)
  switch (action) {
    case 'schema:newOrm2':        return st.addSchema('Schema', 'orm2')
    case 'schema:newRelational':  return st.addSchema('Relational', 'relational')
    case 'schema:generateTables': return useOrmStore.setState({ generateRelationalDialog: { ormSchemaId: id } })
    case 'schema:guessOrm':       return useOrmStore.setState({ guessOrmDialog: { relSchemaId: id } })
    case 'schema:transform':      return useOrmStore.setState({ transformDialog: { schemaId: id } })
    case 'schema:refactor':       return st.refactorSchema(id)
    case 'schema:derivedTable':   return st.addDerivedTable(id)
    case 'schema:delete':         return confirmDeleteSchema(id)
  }
}

// Deletes a schema with its elements and the mappings to or from it, asking
// first when there is anything to lose (Undo brings it back).
export function confirmDeleteSchema(id) {
  const st = useOrmStore.getState()
  const sc = (st.schemas ?? []).find(x => x.id === id)
  if (!sc) return
  const owned = x => x.schemaId === id
  const size = ['objectTypes', 'facts', 'subtypes', 'constraints'].reduce((n, k) => n + (st[k] ?? []).filter(owned).length, 0)
  const ms = [...(st.mappings ?? []), ...(st.views ?? [])].filter(m => m.sourceSchemaId === id || m.targetSchemaId === id)
  if (size > 0 || ms.length) {
    const parts = [size ? `its ${size} element${size === 1 ? '' : 's'}` : null,
      ms.length ? `${ms.length === 1 ? 'the mapping' : `the ${ms.length} mappings`} ${ms.map(m => `“${m.name}”`).join(', ')}` : null].filter(Boolean)
    if (!window.confirm(`Delete schema “${sc.name}” with ${parts.join(' and ')}? Undo brings it back.`)) return
  }
  st.deleteSchema(id, { withContents: true })
}
