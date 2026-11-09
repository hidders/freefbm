// File › New, Open and Save, shared by the toolbar and the application menu.
//
// Save writes to the file the model came from without asking, as long as it
// is a .ffbm file; a new model, a NORMA import or a legacy .orm2/.json file
// asks for a .ffbm path first (Save As always asks).

import { useOrmStore } from '../store/ormStore'
import { openModelFile } from '../import/openModelFile'

const api = () => (typeof window !== 'undefined' ? window.electronAPI : null)

// The model may be replaced: ask first when it has unsaved changes.
export function confirmDiscard(action = 'continue') {
  if (!useOrmStore.getState().isDirty) return true
  return window.confirm(`The model has unsaved changes. Discard them and ${action}?`)
}

export function newModel() {
  if (!confirmDiscard('start a new model')) return
  useOrmStore.getState().newModel()
}

export async function openModel() {
  if (!api()) return
  if (!confirmDiscard('open another file')) return
  const result = await api().openFile()
  if (!result) return
  try { openModelFile(result) }
  catch (err) { alert(`Failed to open model file.${err?.message ? `\n${err.message}` : ''}`) }
}

// Resolves to true when the model was written.
export async function saveModel({ saveAs = false } = {}) {
  if (!api()) return false
  const s = useOrmStore.getState()
  try {
    const content = s.serialize()
    const silent = !saveAs && s.filePath && /\.ffbm$/i.test(s.filePath)
    const fp = await api().saveFile(silent
      ? { path: s.filePath, content }
      : { defaultPath: s.filePath || s.importedFrom || 'model.ffbm', content })
    if (!fp) return false
    useOrmStore.getState().setFilePath(fp)
    useOrmStore.getState().markClean()
    return true
  } catch (err) {
    alert(`Save failed: ${err?.message ?? err}`)
    return false
  }
}

// The name shown in the toolbar and the window title.
export function fileLabel(state) {
  const p = state.filePath || state.importedFrom
  if (!p) return 'Untitled'
  const name = p.split(/[\\/]/).pop()
  return state.filePath ? name : name.replace(/\.[^.]+$/, '') + ' (imported)'
}
