import React, { useEffect } from 'react'
import Toolbar from './components/Toolbar'
import ToolPanel from './components/ToolPanel'
import Canvas from './components/Canvas'
import Inspector from './components/Inspector'
import StatusBar from './components/StatusBar'
import WelcomeScreen from './components/WelcomeScreen'
import DiagramTabs from './components/DiagramTabs'
import SchemaBrowser from './components/SchemaBrowser'
import { ErrorBoundary } from './components/ErrorBoundary'
import { useElectronMenu } from './hooks/useElectronMenu'
import { useUndoRedo } from './hooks/useUndoRedo'
import { useOrmStore } from './store/ormStore'

function useKeyboardShortcuts() {
  const store = useOrmStore()

  useEffect(() => {
    const handler = (e) => {
      const tag = document.activeElement?.tagName
      const isTyping = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT'

      if (e.key === 'Escape') {
        store.abandonSequenceConstruction()
        store.clearLinkDraft()
        store.clearSelection()
        store.setTool('select')
        return
      }

      if (e.key === 'Enter' && store.sequenceConstruction) {
        const constraintId = store.sequenceConstruction.constraintId
        store.commitSequenceConstruction()
        store.select(constraintId, 'constraint')
        return
      }

      if (e.key === 'Enter' && store.uniquenessConstruction) {
        store.commitUniquenessConstruction()
        return
      }

      if (e.key === 'Enter' && store.frequencyConstruction?.stage === 2) {
        store.advanceFrequencyToRange()
        return
      }

      if (e.key === 'Enter' && store.frequencyConstruction?.stage === 3) {
        const factId = store.frequencyConstruction.factId
        store.commitFrequencyConstruction()
        store.select(factId, 'fact')
        return
      }

      if (isTyping) return

      if (e.key === 'Delete' || e.key === 'Backspace') {
        const s = useOrmStore.getState()

        if (s.selectedMandatoryDot) {
          const { factId, roleIndex } = s.selectedMandatoryDot
          s.removeMandatoryRole(factId, roleIndex)
          e.preventDefault()
          return
        }

        if (s.selectedInternalFrequency) {
          const { factId, ifId } = s.selectedInternalFrequency
          s.removeInternalFrequency(factId, ifId)
          e.preventDefault()
          return
        }

        if (s.selectedValueRange) {
          s.removeValueRange(s.selectedValueRange)
          e.preventDefault()
          return
        }

        if (s.selectedCardinalityRange) {
          s.removeCardinalityRange(s.selectedCardinalityRange)
          e.preventDefault()
          return
        }

        if (s.selectedKind === 'implicitLink') {
          e.preventDefault()
          const roleIndex = s.selectedImplicitLinkRole?.roleIndex ?? s.selectedImplicitLink
          if (roleIndex != null) {
            s.toggleImplicitLink(s.selectedId, roleIndex)
            return
          }
        }

        const { selectedId, selectedKind, selectedUniqueness, selectedImplicitLink, selectedImplicitLinkRole, uniquenessConstruction, multiSelectedIds, activeDiagramId } = store

        if (multiSelectedIds.length > 0) {
          const s0 = useOrmStore.getState()
          const hasConstraints = multiSelectedIds.some(id => s0.constraints.some(c => c.id === id))
          const hasSubtypes    = multiSelectedIds.some(id => s0.subtypes.some(st => st.id === id))
          if (hasConstraints || hasSubtypes) {
            store.deleteMultiSelection()
          } else {
            const idsToRemove = multiSelectedIds.filter(id =>
              s0.objectTypes.some(o => o.id === id) || s0.facts.some(f => f.id === id) || id.includes('_il_')
            )
            if (idsToRemove.length > 0) {
              store.removeMultiSelectionFromDiagram(activeDiagramId, idsToRemove)
            } else {
              store.clearSelection()
            }
          }
          return
        }

        if (uniquenessConstruction?.uIndex != null) {
          // Delete the constraint being edited and exit construction mode
          const fact = store.facts.find(f => f.id === uniquenessConstruction.factId)
          if (fact) store.toggleUniqueness(uniquenessConstruction.factId, fact.uniqueness[uniquenessConstruction.uIndex])
          store.clearSelection()
          return
        }

        if (selectedUniqueness) {
          const fact = store.facts.find(f => f.id === selectedUniqueness.factId)
          if (fact) {
            store.toggleUniqueness(selectedUniqueness.factId, fact.uniqueness[selectedUniqueness.uIndex])
            store.clearSelection()
          }
          return
        }
        if (!selectedId) return
        if (selectedKind === 'constraint') { store.deleteConstraint(selectedId); return }
        if (selectedKind === 'subtype') { store.deleteSubtype(selectedId); return }
        store.removeElementFromDiagram(selectedId, activeDiagramId)
        return
      }

      if ((e.ctrlKey || e.metaKey) && e.key === 'a') { e.preventDefault(); store.selectAll(); return }
      if ((e.ctrlKey || e.metaKey) && e.key === 'c') { e.preventDefault(); store.copySelection(); return }
      if ((e.ctrlKey || e.metaKey) && e.key === 'x') { e.preventDefault(); store.cutSelection();  return }
      if ((e.ctrlKey || e.metaKey) && e.key === 'v') { e.preventDefault(); store.pasteClipboard();    return }
      if ((e.ctrlKey || e.metaKey) && e.key === 'd') { e.preventDefault(); store.duplicateClipboard(); return }

      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        const ids = store.multiSelectedIds.length > 0
          ? store.multiSelectedIds
          : store.selectedId ? [store.selectedId] : []
        if (ids.length === 0) return
        e.preventDefault()
        const step = e.shiftKey ? 50 : 10
        const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0
        const dy = e.key === 'ArrowUp'   ? -step : e.key === 'ArrowDown'  ? step : 0
        const diagramPositions = useOrmStore.getState().diagrams
          ?.find(d => d.id === store.activeDiagramId)?.positions ?? {}
        for (const id of ids) {
          const dp = diagramPositions[id]
          const ot = store.objectTypes.find(o => o.id === id)
          if (ot) { const p = dp ?? ot; store.moveObjectType(id, p.x + dx, p.y + dy); continue }
          const f  = store.facts.find(f => f.id === id)
          if (f)  { const p = dp ?? f;  store.moveFact(id, p.x + dx, p.y + dy); continue }
          const c  = store.constraints.find(c => c.id === id)
          if (c)  { const p = dp ?? c;  store.moveConstraint(id, p.x + dx, p.y + dy) }
        }
        return
      }

      if (e.ctrlKey || e.metaKey || e.altKey) return

      if (e.key === 's' || e.key === 'S') { store.setTool('select'); return }
      if (e.key === 'e' || e.key === 'E') { store.setTool('addEntity'); return }
      if (e.key === 'v' || e.key === 'V') { store.setTool('addValue'); return }
      if (e.key === 'f' || e.key === 'F') { store.setTool('addFact2'); return }
      if (e.key === 'u' || e.key === 'U') { store.setTool('addSubtype'); return }
      if (e.key === 'a' || e.key === 'A') { store.setTool('assignRole'); return }
      if (e.key === 'm' || e.key === 'M') { store.setTool('toggleMandatory'); return }
      if (e.key === 'i' || e.key === 'I') { store.setTool('addInternalUniqueness'); return }
      if (e.key === 'q' || e.key === 'Q') { store.setTool('addInternalFrequency'); return }
      if (e.key === 'r' || e.key === 'R') { store.setTool('addConstraint:valueRange'); return }
      if (e.key === 'c' || e.key === 'C') { store.setTool('addConstraint:cardinality'); return }

      if ((e.ctrlKey || e.metaKey) && (e.key === '=' || e.key === '+')) {
        e.preventDefault(); store.zoomBy(0.1); return
      }
      if ((e.ctrlKey || e.metaKey) && e.key === '-') {
        e.preventDefault(); store.zoomBy(-0.1); return
      }
      if ((e.ctrlKey || e.metaKey) && e.key === '0') {
        e.preventDefault(); store.resetView(); return
      }
    }

    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [store])
}

export default function App() {
  const store = useOrmStore()

  useElectronMenu()
  useUndoRedo()
  useKeyboardShortcuts()

  const isEmpty = store.objectTypes.length === 0 && store.facts.length === 0

  return (
    <ErrorBoundary>
      <div style={{ display: 'flex', flexDirection: 'column',
        width: '100vw', height: '100vh', overflow: 'hidden',
        background: 'var(--bg-canvas)' }}>

        <div id="app-toolbar" className="no-print"><Toolbar /></div>

        <div id="app-diagram-tabs" className="no-print"><DiagramTabs /></div>

        <div style={{ display: 'flex', flex: 1, overflow: 'hidden', position: 'relative' }}>
          <div id="app-toolpanel" className="no-print" style={{ display: 'contents' }}><ToolPanel /></div>
          <Canvas />
          {isEmpty && <WelcomeScreen />}
          <SchemaBrowser />
          <div id="app-inspector" className="no-print" style={{ display: 'contents' }}><Inspector /></div>
        </div>

        <div id="app-statusbar" className="no-print"><StatusBar /></div>
      </div>
    </ErrorBoundary>
  )
}
