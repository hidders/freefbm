import { useEffect, useRef } from 'react'
import { useOrmStore, useOrmStoreIgnoring } from '../store/ormStore'
import { triggerPdfExport } from '../utils/pdfExport'
import { openModelFile } from '../import/openModelFile'

const isElectron = typeof window !== 'undefined' && !!window.electronAPI

export function useElectronMenu() {
  // Use a ref so IPC handlers always read current state without re-registering on every change.
  const storeRef = useRef(null)
  storeRef.current = useOrmStoreIgnoring('pan', 'zoom')

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
      const result = await api.openFile()
      if (!result) return
      try { openModelFile(result) }
      catch (err) { alert(`Failed to open model file.${err?.message ? `\n${err.message}` : ''}`) }
    })

    on('menu:save', async () => {
      const store = storeRef.current
      const content = store.serialize()
      const fp = await api.saveFile({ defaultPath: store.filePath || store.importLog?.source || 'model.ffbm', content })
      if (fp) { store.setFilePath(fp); store.markClean() }
    })

    on('menu:saveAs', async () => {
      const store = storeRef.current
      const content = store.serialize()
      const fp = await api.saveFile({ defaultPath: 'model.ffbm', content })
      if (fp) { store.setFilePath(fp); store.markClean() }
    })

    on('menu:deleteSelected', () => storeRef.current.removeSelectedFromDiagram())

    on('menu:zoomIn',    () => storeRef.current.zoomBy(0.1))
    on('menu:zoomOut',   () => storeRef.current.zoomBy(-0.1))
    on('menu:zoomReset', () => storeRef.current.resetView())

    on('menu:exportPdf', () => triggerPdfExport(storeRef.current))

    return () => unsubs.forEach(u => u())
  }, []) // register once — storeRef.current always holds latest state
}
