import React, { useEffect } from 'react'
import Toolbar from './components/Toolbar'
import ToolPanel from './components/ToolPanel'
import Canvas from './components/Canvas'
import Inspector from './components/Inspector'
import StatusBar from './components/StatusBar'
import WelcomeScreen from './components/WelcomeScreen'
import DiagramTabs from './components/DiagramTabs'
import SchemaBrowser from './components/SchemaBrowser'
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
        const factId = store.uniquenessConstruction.factId
        store.commitUniquenessConstruction()
        store.select(factId, 'fact')
        return
      }

      if (isTyping) return

      if (e.key === 'Delete' || e.key === 'Backspace') {
        const { selectedId, selectedKind, selectedUniqueness, uniquenessConstruction, multiSelectedIds } = store
        if (multiSelectedIds.length > 0) { store.deleteMultiSelection(); return }
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
        if (selectedKind === 'entity' || selectedKind === 'value') store.deleteObjectType(selectedId)
        else if (selectedKind === 'fact')       store.deleteFact(selectedId)
        else if (selectedKind === 'subtype')    store.deleteSubtype(selectedId)
        else if (selectedKind === 'constraint') store.deleteConstraint(selectedId)
        return
      }

      if ((e.ctrlKey || e.metaKey) && e.key === 'a') { e.preventDefault(); store.selectAll(); return }
      if ((e.ctrlKey || e.metaKey) && e.key === 'c') { e.preventDefault(); store.copySelection(); return }
      if ((e.ctrlKey || e.metaKey) && e.key === 'x') { e.preventDefault(); store.cutSelection();  return }
      if ((e.ctrlKey || e.metaKey) && e.key === 'v') { e.preventDefault(); store.pasteClipboard(); return }

      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        const ids = store.multiSelectedIds.length > 0
          ? store.multiSelectedIds
          : store.selectedId ? [store.selectedId] : []
        if (ids.length === 0) return
        e.preventDefault()
        const step = e.shiftKey ? 50 : 10
        const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0
        const dy = e.key === 'ArrowUp'   ? -step : e.key === 'ArrowDown'  ? step : 0
        for (const id of ids) {
          const ot = store.objectTypes.find(o => o.id === id)
          if (ot) { store.moveObjectType(id, ot.x + dx, ot.y + dy); continue }
          const f  = store.facts.find(f => f.id === id)
          if (f)  { store.moveFact(id, f.x + dx, f.y + dy); continue }
          const c  = store.constraints.find(c => c.id === id)
          if (c)  { store.moveConstraint(id, c.x + dx, c.y + dy) }
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
  )
}
