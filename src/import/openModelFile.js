// Opens a file picked in File › Open or File › Import NORMA .orm…. A NORMA .orm file is imported as a new,
// unsaved model (Save asks for a .ffbm path); its import log is kept in the
// store for the import log panel. Anything else is a FreeFBM model.

import { importNorma } from './norma'
import { useOrmStore } from '../store/ormStore'

export function openModelFile({ path, content }) {
  const store = useOrmStore.getState()
  if (/\.orm$/i.test(path)) {
    const { data, log } = importNorma(content)
    store.loadModel(data, null)
    const source = path.split(/[\\/]/).pop()
    store.markDirty()
    store.setImportedFrom(path)
    store.setImportLog({ source, entries: log })
    return
  }
  store.loadModel(content, path)
}
