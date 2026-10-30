// The two drawn ends of a subtype link, for a constraint connector. A link is
// drawn once per pair of occurrences in subtypeEndpointOccs, so when one of its
// types is drawn twice there can be several; take the one whose midpoint is
// nearest (x, y), the constraint. `subtypes` and `objectTypes` are the visible
// ones from useDiagramElements (with subOccId/superOccId and occurrenceId).
// Returns { subOt, supOt } or null.
export function nearestSubtypeEnds(subtypeId, x, y, subtypes, objectTypes) {
  let best = null, bestD = Infinity
  for (const st of subtypes) {
    if (st.id !== subtypeId) continue
    const end = (occId, id) => (occId && objectTypes.find(o => o.occurrenceId === occId))
      || objectTypes.find(o => o.id === id)
    const subOt = end(st.subOccId, st.subId), supOt = end(st.superOccId, st.superId)
    if (!subOt || !supOt) continue
    const d = Math.hypot((subOt.x + supOt.x) / 2 - x, (subOt.y + supOt.y) / 2 - y)
    if (d < bestD) { bestD = d; best = { subOt, supOt } }
  }
  return best
}
