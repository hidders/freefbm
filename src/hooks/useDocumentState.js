import { useEffect } from 'react'
import { useOrmStore } from '../store/ormStore'
import { fileLabel, saveModel } from '../utils/fileActions'

// Keeps the window title (and on macOS the title bar's document icon and
// edited dot) in step with the open file, and guards unsaved changes: closing,
// quitting or reloading the window asks first (electron/main.cjs shows the
// Save / Don't Save / Cancel question when the page refuses to unload).
export function useDocumentState() {
  useEffect(() => {
    const api = window.electronAPI
    let last = null
    const sync = (s) => {
      const key = `${s.filePath}|${s.importedFrom}|${s.isDirty}`
      if (key === last) return
      last = key
      const label = fileLabel(s)
      document.title = `${label}${s.isDirty ? ' •' : ''} — FreeFBM`
      api?.setDocument?.({ path: s.filePath ?? null, dirty: !!s.isDirty, title: document.title })
    }
    sync(useOrmStore.getState())
    const unsub = useOrmStore.subscribe(sync)

    const beforeUnload = (e) => {
      if (!useOrmStore.getState().isDirty) return
      e.preventDefault()
      e.returnValue = ''
    }
    window.addEventListener('beforeunload', beforeUnload)

    // The main process asks to save before it closes or reloads the window.
    const off = api?.onMenuEvent?.('app:saveThenClose', async () => {
      if (await saveModel()) api.closeNow()
    })

    return () => { unsub(); window.removeEventListener('beforeunload', beforeUnload); off?.() }
  }, [])
}
