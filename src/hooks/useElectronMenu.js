import { useEffect, useRef } from 'react'
import { useOrmStore } from '../store/ormStore'
import { triggerPdfExport } from '../utils/pdfExport'

const isElectron = typeof window !== 'undefined' && !!window.electronAPI

export function useElectronMenu() {
  // Use a ref so IPC handlers always read current state without re-registering on every change.
  const storeRef = useRef(null)
  storeRef.current = useOrmStore()

  useEffect(() => {
    if (!isElectron) return
    const api = window.electronAPI
    const unsubs = []

    const on = (channel, handler) => {
      const unsub = api.onMenuEvent(channel, handler)
      if (unsub) unsubs.push(unsub)
    }

    on('menu:new', () => {
      const store = storeRef.current
      if (store.isDirty && !confirm('Discard unsaved changes?')) return
      store.newModel()
    })

    on('menu:open', async () => {
      const store = storeRef.current
      const result = await api.openFile()
      if (!result) return
      try { store.loadModel(result.content, result.path) }
      catch { alert('Failed to parse model file.') }
    })

    on('menu:save', async () => {
      const store = storeRef.current
      const content = store.serialize()
      const fp = await api.saveFile({ defaultPath: store.filePath || 'model.orm2', content })
      if (fp) { store.setFilePath(fp); store.markClean() }
    })

    on('menu:saveAs', async () => {
      const store = storeRef.current
      const content = store.serialize()
      const fp = await api.saveFile({ defaultPath: 'model.orm2', content })
      if (fp) { store.setFilePath(fp); store.markClean() }
    })

    on('menu:deleteSelected', () => {
      const { selectedId, selectedKind } = storeRef.current
      if (!selectedId) return
      const store = storeRef.current
      if (selectedKind === 'entity' || selectedKind === 'value') store.deleteObjectType(selectedId)
      else if (selectedKind === 'fact')       store.deleteFact(selectedId)
      else if (selectedKind === 'subtype')    store.deleteSubtype(selectedId)
      else if (selectedKind === 'constraint') store.deleteConstraint(selectedId)
    })

    on('menu:zoomIn',    () => storeRef.current.zoomBy(0.1))
    on('menu:zoomOut',   () => storeRef.current.zoomBy(-0.1))
    on('menu:zoomReset', () => storeRef.current.resetView())

    on('menu:exportPdf', () => triggerPdfExport(storeRef.current))

    return () => unsubs.forEach(u => u())
  }, []) // register once — storeRef.current always holds latest state
}
