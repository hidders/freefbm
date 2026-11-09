// The Mapping menu (electron/main.cjs): what can be done with the active
// mapping. The active mapping is the one the active diagram draws, else the
// one last chosen (Mapping › Choose, a mapping chip, the Mappings tab), else
// the first that has the active schema on one side. `mappingMenuState` gives
// the menu's labels and which items apply (sent to the main process by
// useElectronMenu, which rebuilds the menu when the labels change), and
// `runMappingAction` runs one. The Mappings tab's buttons call the same
// functions.

import { useOrmStore } from '../store/ormStore'
import { activeSchemaIdOf, mappingOfDiagram, isViewMapping } from '../store/storeHelpers'
import { runMapping, roundTrip } from '../mapping/runMapping.js'
import { runAccounting } from '../components/AccountingReport.jsx'
import { runEquivalence } from '../components/EquivalenceReport.jsx'

export const MAPPING_ACTIONS = [
  'mapping:diagram', 'mapping:suggest', 'mapping:addRule',
  'mapping:runForward', 'mapping:runBackward', 'mapping:roundTrip',
  'mapping:equivalence', 'mapping:accounting',
  'mapping:fold', 'mapping:lock',
  'mapping:showTab', 'mapping:delete',
]

export function activeMappingOf(state) {
  const ms = state.mappings ?? []
  if (!ms.length) return null
  const d = state.diagrams?.find(x => x.id === state.activeDiagramId)
  const shown = mappingOfDiagram(state, d)
  if (shown && !isViewMapping(state, shown)) return shown
  const chosen = ms.find(m => m.id === state.activeMappingId)
  if (chosen) return chosen
  const sid = activeSchemaIdOf(state)
  return ms.find(m => m.sourceSchemaId === sid || m.targetSchemaId === sid) ?? null
}

const schemaName = (state, id) => (state.schemas ?? []).find(s => s.id === id)?.name ?? '(deleted schema)'

export function mappingMenuState(state) {
  const m = activeMappingOf(state)
  const name = (id) => schemaName(state, id)
  const has = !!m
  return {
    // What the main process builds the menu from.
    activeId: m?.id ?? null,
    mappings: (state.mappings ?? []).map(x => ({ id: x.id, label: `${x.name} (${name(x.sourceSchemaId)} → ${name(x.targetSchemaId)})` })),
    labels: {
      'mapping:runForward':  m ? `Run ${name(m.sourceSchemaId)} → ${name(m.targetSchemaId)}` : 'Run forward',
      'mapping:runBackward': m ? `Run ${name(m.targetSchemaId)} → ${name(m.sourceSchemaId)}` : 'Run backward',
    },
    checked: { 'mapping:lock': !!m?.lock },
    enabled: {
      'mapping:diagram': has,
      'mapping:suggest': has && m.rules.length >= 2,
      'mapping:addRule': has && !!state.advancedMode,
      'mapping:runForward': has,
      'mapping:runBackward': has,
      'mapping:roundTrip': has,
      'mapping:equivalence': has,
      'mapping:accounting': has,
      'mapping:fold': has && !m.lock,
      'mapping:lock': has,
      'mapping:showTab': true,
      'mapping:delete': has,
    },
  }
}

// Shows the Mappings tab, where the results appear.
export function showMappingsTab() {
  const st = useOrmStore.getState()
  if (st.bottomPanelCollapsed) st.setBottomPanelCollapsed(false)
  st.setBottomPanelTab('mappings')
}

// A run (kind 'run', direction 'forward' | 'backward') or a round trip of
// mapping m, kept in store.mappingRuns for the Mappings tab.
export function runMappingNow(m, kind, direction = 'forward') {
  const full = useOrmStore.getState()
  const t0 = performance.now()
  let run
  try {
    const result = kind === 'run' ? runMapping(full, m, direction) : roundTrip(full, m, direction)
    run = { kind, direction, result, ms: Math.round(performance.now() - t0) }
  } catch (err) {
    run = { error: String(err?.message ?? err) }
  }
  full.setMappingRun(m.id, run)
  full.setActiveMapping(m.id)
}

// Deletes a mapping with its rules and diagrams, asking first when it has
// rules (Undo brings it back).
export function confirmDeleteMapping(id) {
  const st = useOrmStore.getState()
  const m = (st.mappings ?? []).find(x => x.id === id)
  if (!m) return
  const n = m.rules.length
  if (n && !window.confirm(`Delete mapping “${m.name}” with its ${n === 1 ? 'rule' : `${n} rules`}? Undo brings it back.`)) return
  st.deleteMapping(id)
}

export function runMappingAction(action, arg) {
  const st = useOrmStore.getState()
  if (action === 'mapping:choose') {
    if (!(st.mappings ?? []).some(m => m.id === arg)) return
    st.setActiveMapping(arg)
    // A mapping diagram of another mapping would keep overriding the choice.
    const d = st.diagrams.find(x => x.id === st.activeDiagramId)
    if (d?.mappingId && d.mappingId !== arg) {
      const m = st.mappings.find(x => x.id === arg)
      const back = st.diagrams.find(x => !x.mappingId && x.schemaId === m.sourceSchemaId)
      if (back) st.setActiveDiagram(back.id)
    }
    return
  }
  if (!mappingMenuState(st).enabled[action]) return
  const m = activeMappingOf(st)
  switch (action) {
    case 'mapping:diagram':     return st.openMappingDiagram(m.id)
    case 'mapping:suggest':     return useOrmStore.setState({ suggestDiagramsDialog: { mappingId: m.id } })
    case 'mapping:addRule':     showMappingsTab(); return st.addMappingRule(m.id)
    case 'mapping:runForward':  showMappingsTab(); return runMappingNow(m, 'run', 'forward')
    case 'mapping:runBackward': showMappingsTab(); return runMappingNow(m, 'run', 'backward')
    case 'mapping:roundTrip':   showMappingsTab(); return runMappingNow(m, 'roundTrip', 'forward')
    case 'mapping:equivalence': showMappingsTab(); return runEquivalence(m)
    case 'mapping:accounting':  showMappingsTab(); return runAccounting(m)
    case 'mapping:fold':        return useOrmStore.setState({ foldDialog: { mappingId: m.id } })
    case 'mapping:lock':        return st.lockMapping(m.id, !m.lock)
    case 'mapping:showTab':     return showMappingsTab()
    case 'mapping:delete':      return confirmDeleteMapping(m.id)
  }
}
