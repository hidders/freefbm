import { useEffect } from 'react'
import { useOrmStore } from '../store/ormStore'

// The arrow keys move a selected value range, cardinality range or internal
// frequency marker: App sets store.labelNudge = { dx, dy, n }, and the node
// that draws the selected label moves it by that much from where it is drawn
// (a label in its default place has no stored offset; only the node knows
// where it is). `handlerRef.current(state, dx, dy)` is set on every render.
export function useLabelNudge(handlerRef) {
  useEffect(() => useOrmStore.subscribe((s, prev) => {
    if (s.labelNudge && s.labelNudge !== prev.labelNudge) handlerRef.current?.(s, s.labelNudge.dx, s.labelNudge.dy)
  }), [handlerRef])
}

// Whether two value or cardinality range selections name the same range.
export function sameRangeDesc(a, b) {
  return !!a && !!b && a.otId === b.otId && a.factId === b.factId
    && a.roleIndex === b.roleIndex && a.nestedFactId === b.nestedFactId
}
