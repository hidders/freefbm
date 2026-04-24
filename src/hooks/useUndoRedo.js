import { useEffect, useRef, useCallback } from 'react'
import { useOrmStore } from '../store/ormStore'

const MAX_HISTORY = 60

function snapshot(state) {
  return JSON.stringify({
    objectTypes:  state.objectTypes,
    facts:         state.facts,
    subtypes:      state.subtypes,
    constraints:   state.constraints,
  })
}

export function useUndoRedo() {
  const past      = useRef([])
  const future    = useRef([])
  const restoring = useRef(false)
  const lastSnap  = useRef(snapshot(useOrmStore.getState()))

  useEffect(() => {
    const unsub = useOrmStore.subscribe((state, prev) => {
      if (restoring.current) return
      if (
        state.objectTypes  === prev.objectTypes  &&
        state.facts         === prev.facts         &&
        state.subtypes      === prev.subtypes      &&
        state.constraints   === prev.constraints
      ) return
      const snap = snapshot(state)
      if (snap === lastSnap.current) return
      past.current = [...past.current, lastSnap.current].slice(-MAX_HISTORY)
      future.current = []
      lastSnap.current = snap
    })
    return unsub
  }, [])

  const undo = useCallback(() => {
    if (!past.current.length) return
    const prev = past.current[past.current.length - 1]
    past.current = past.current.slice(0, -1)
    future.current = [lastSnap.current, ...future.current]
    lastSnap.current = prev
    restoring.current = true
    useOrmStore.setState(JSON.parse(prev))
    restoring.current = false
  }, [])

  const redo = useCallback(() => {
    if (!future.current.length) return
    const next = future.current[0]
    future.current = future.current.slice(1)
    past.current = [...past.current, lastSnap.current]
    lastSnap.current = next
    restoring.current = true
    useOrmStore.setState(JSON.parse(next))
    restoring.current = false
  }, [])

  useEffect(() => {
    const handler = (e) => {
      const tag = document.activeElement?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key === 'z') {
        e.preventDefault(); undo()
      }
      if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || (e.shiftKey && e.key === 'z'))) {
        e.preventDefault(); redo()
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [undo, redo])

  return {
    undo, redo,
    canUndo: past.current.length > 0,
    canRedo: future.current.length > 0,
  }
}
