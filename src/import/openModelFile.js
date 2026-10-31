// Opens a file picked in File › Open. A NORMA .orm file is imported as a new,
// unsaved model (Save asks for a .ffbm path); its import log is kept in the
// store for the import log panel. Anything else is a FreeFBM model.

import { importNorma } from './norma'
import { useOrmStore } from '../store/ormStore'

export function openModelFile({ path, content }) {
  const store = useOrmStore.getState()
  if (/\.orm$/i.test(path)) {
    const { data, log, pendingJoinIds } = importNorma(content)
    store.loadModel(data, null)
    // The queries FreeFBM builds when a constraint is drawn, for the sequences
    // that have none yet; not for join paths the importer could not translate.
    const pending = new Set(pendingJoinIds)
    for (const c of useOrmStore.getState().constraints) {
      if (pending.has(c.id)) continue
      if ((c.sequences ?? []).some((seq, i) => seq?.length && c.queries?.[i] == null)) useOrmStore.getState()._tryAutoGenerateQuery(c.id)
    }
    const source = path.split(/[\\/]/).pop()
    store.markDirty()
    store.setImportedFrom(path)
    store.setImportLog({ source, entries: log })
    return
  }
  store.loadModel(content, path)
}
