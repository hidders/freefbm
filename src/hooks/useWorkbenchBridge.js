import { useEffect } from 'react'
import { useOrmStore } from '../store/ormStore'
import { channel, modelSnapshot } from '../verbalisation/workbench.js'

// Main window side of the verbalisation workbench: sends the model when the
// workbench says hello, and again (debounced) whenever the schema changes
// while the workbench is open.
export function useWorkbenchBridge() {
  useEffect(() => {
    const ch = channel()
    let open = false
    let timer = null
    const send = () => ch.post({ type: 'model', state: modelSnapshot(useOrmStore.getState()) })
    const off = ch.on(m => {
      if (m?.type === 'hello') { open = true; send() }
      else if (m?.type === 'bye') open = false
    })
    const KEYS = ['objectTypes', 'facts', 'subtypes', 'constraints', 'diagrams', 'activeDiagramId']
    const unsub = useOrmStore.subscribe((s, prev) => {
      if (!open || KEYS.every(k => s[k] === prev[k])) return
      clearTimeout(timer)
      timer = setTimeout(send, 300)
    })
    return () => { off(); unsub(); clearTimeout(timer) }
  }, [])
}
