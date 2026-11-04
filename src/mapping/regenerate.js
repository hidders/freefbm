// Regenerating a generated schema in place (stock-take step 6, piece 3).
//
// Generate tables (rmap.js) and Guess ORM2 (guessOrm.js) keep their choices on
// the mapping they make (mapping.generator = { kind, sourceSchemaId, options,
// fingerprint }), so the schema can be made again from a changed source with
// the same choices. The fingerprint says whether the generated schema or the
// mapping's rules were changed by hand since (layout and populations don't
// count). In place means: the schema, the mapping and the generated diagram
// keep their ids, and elements that come back keep theirs (matched by kind,
// name, reading and players), so other mappings, diagrams and populations
// that name them still do, and diagram positions stay.

const LAYOUT = new Set(['x', 'y', 'readingOffsetAbove', 'readingOffsetBelow', 'orientation', 'readingDisplay', 'shownReadingOrder', 'readingAbove', 'uniquenessBelow'])

function hash(text) {
  let h = 5381
  for (let i = 0; i < text.length; i++) h = ((h * 33) ^ text.charCodeAt(i)) >>> 0
  return h.toString(36)
}

const noLayout = (x) => JSON.stringify(x, (k, v) => (LAYOUT.has(k) ? undefined : v))

// What a generated schema and its mapping's rules are, without layout.
export function schemaFingerprint(state, schemaId, mapping) {
  const of = (xs) => (xs ?? []).filter(x => x.schemaId === schemaId).map(noLayout).sort()
  return hash(JSON.stringify([of(state.objectTypes), of(state.facts), of(state.subtypes), of(state.constraints),
    (mapping?.rules ?? []).map(r => noLayout({ ...r, id: undefined }))]))
}

// Whether the schema a mapping generated, or the mapping, changed by hand.
export function handEdited(state, mapping) {
  const g = mapping?.generator
  if (!g?.fingerprint) return false
  return schemaFingerprint(state, mapping.targetSchemaId, mapping) !== g.fingerprint
}

// The generated schema a mapping made, if it is still there.
export const generatedSchemaOf = (state, mapping) => (mapping?.generator ? state.schemas.find(s => s.id === mapping.targetSchemaId) ?? null : null)

const otKey = (o) => `${o.kind}|${o.name}`
const factKey = (f, playerKey) => JSON.stringify([f.name ?? null, f.readingParts ?? null, f.objectifiedName ?? null, f.roles.map(r => playerKey(r.objectTypeId))])

// Ids of the new elements that stand for old ones: new id → old id (roles
// included, by position).
function matchIds(old, built) {
  const map = new Map()
  const oldTypes = new Map(old.objectTypes.map(o => [otKey(o), o]))
  for (const o of built.objectTypes) {
    const m = oldTypes.get(otKey(o))
    if (m && m.kind === o.kind) { map.set(o.id, m.id); oldTypes.delete(otKey(o)) }
  }
  // Players of old facts by their own key; of new ones by the matched key.
  const oldKey = new Map(old.objectTypes.map(o => [o.id, otKey(o)]))
  const newKey = new Map(built.objectTypes.map(o => [o.id, otKey(o)]))
  const oldFacts = new Map(old.facts.map(f => [factKey(f, id => oldKey.get(id) ?? id), f]))
  for (const f of built.facts) {
    const k = factKey(f, id => newKey.get(id) ?? id)
    const m = oldFacts.get(k)
    if (!m || m.roles.length !== f.roles.length) continue
    oldFacts.delete(k)
    map.set(f.id, m.id)
    f.roles.forEach((r, i) => { if (r.id && m.roles[i]?.id) map.set(r.id, m.roles[i].id) })
  }
  return map
}

// Renames ids in any JSON value (ids are unique tokens, so whole-string
// matches and the `role:<id>` and `<id>_il_<i>` forms are enough).
function renamer(map) {
  if (!map.size) return (x) => x
  const one = (s) => {
    if (map.has(s)) return map.get(s)
    let m
    if ((m = s.match(/^role:(.+)$/)) && map.has(m[1])) return `role:${map.get(m[1])}`
    if ((m = s.match(/^(.+)(_il_\d+)$/)) && map.has(m[1])) return map.get(m[1]) + m[2]
    if ((m = s.match(/^(.+)(:.*)$/)) && map.has(m[1])) return map.get(m[1]) + m[2]
    return s
  }
  const walk = (v) => {
    if (typeof v === 'string') return one(v)
    if (Array.isArray(v)) return v.map(walk)
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [one(k), walk(x)]))
    return v
  }
  return walk
}

// The state with a generated schema replaced by a new build of it. built:
// { objectTypes, facts, subtypes, constraints, diagram }; mapping: the new
// mapping (its rules), which takes the old one's id and name; builtSchemaId:
// the schema id the build used, which becomes the old schema's. Returns the
// new state's parts (to set) and { kept, added, removed } counts.
export function replaceGenerated(state, oldMapping, built, mapping, builtSchemaId) {
  const schemaId = oldMapping.targetSchemaId
  const inS = (x) => x.schemaId === schemaId
  const old = {
    objectTypes: state.objectTypes.filter(inS), facts: state.facts.filter(inS),
    subtypes: (state.subtypes ?? []).filter(inS), constraints: state.constraints.filter(inS),
  }
  const map = matchIds(old, built)
  map.set(builtSchemaId, schemaId)
  const rn = renamer(map)
  const nb = {
    objectTypes: rn(built.objectTypes), facts: rn(built.facts), subtypes: rn(built.subtypes ?? []),
    constraints: rn(built.constraints), diagram: built.diagram ? rn(built.diagram) : null,
  }
  // Constraints and subtype links that come back unchanged keep their ids.
  const cKey = (c) => noLayout({ ...c, id: undefined, name: undefined, queries: undefined })
  const oldC = new Map(old.constraints.map(c => [cKey(c), c.id]))
  const cmap = new Map()
  for (const c of nb.constraints) { const id = oldC.get(cKey(c)); if (id) { cmap.set(c.id, id); oldC.delete(cKey(c)) } }
  const sKey = (s) => `${s.subId}|${s.superId}`
  const oldS = new Map(old.subtypes.map(s => [sKey(s), s.id]))
  for (const s of nb.subtypes) { const id = oldS.get(sKey(s)); if (id) cmap.set(s.id, id) }
  const rc = renamer(cmap)
  nb.constraints = rc(nb.constraints); nb.subtypes = rc(nb.subtypes); nb.diagram = nb.diagram ? rc(nb.diagram) : null
  const newMapping = rc(rn(mapping))

  const newIds = new Set([...nb.objectTypes, ...nb.facts, ...nb.subtypes, ...nb.constraints].map(x => x.id))
  const oldIds = [...old.objectTypes, ...old.facts, ...old.subtypes, ...old.constraints].map(x => x.id)
  const removed = new Set(oldIds.filter(id => !newIds.has(id)))
  const kept = oldIds.length - removed.size

  // The generated diagram: the new one's contents at the old positions.
  const home = state.diagrams.find(d => d.schemaId === schemaId && !d.mappingId)
  const at = new Map((home?.occurrences ?? []).map(o => [o.schemaElementId, o]))
  const cat = new Map((home?.constraintOccurrences ?? []).map(o => [o.schemaConstraintId, o]))
  let diagram = null
  if (home && nb.diagram) {
    // Elements placed before go where they were; new ones keep the layout's
    // place, moved by how far the old elements moved on average.
    const moved = (nb.diagram.occurrences ?? []).filter(o => at.has(o.schemaElementId))
    const dx = moved.length ? moved.reduce((a, o) => a + at.get(o.schemaElementId).x - o.x, 0) / moved.length : 0
    const dy = moved.length ? moved.reduce((a, o) => a + at.get(o.schemaElementId).y - o.y, 0) / moved.length : 0
    const place = (o, prev) => (prev ? { ...o, x: prev.x, y: prev.y } : { ...o, x: Math.round(o.x + dx), y: Math.round(o.y + dy) })
    diagram = {
      ...nb.diagram,
      id: home.id, name: home.name, notes: home.notes ?? [], notation: home.notation, erdLines: home.erdLines,
      erdPositions: home.erdPositions, profileId: home.profileId ?? nb.diagram.profileId,
      occurrences: (nb.diagram.occurrences ?? []).map(o => place(o, at.get(o.schemaElementId))),
      constraintOccurrences: (nb.diagram.constraintOccurrences ?? []).map(o => place(o, cat.get(o.schemaConstraintId))),
    }
  }
  const exists = new Set([...state.objectTypes, ...state.facts, ...(state.subtypes ?? []), ...state.constraints].map(x => x.id).filter(id => !removed.has(id)))
  for (const id of newIds) exists.add(id)
  // Other diagrams lose what is gone.
  const prune = (d) => {
    const occs = (d.occurrences ?? []).filter(o => exists.has(o.schemaElementId))
    const cOccs = (d.constraintOccurrences ?? []).filter(o => exists.has(o.schemaConstraintId))
    const subs = (d.subtypeOccurrences ?? []).filter(id => exists.has(id))
    if (occs.length === (d.occurrences ?? []).length && cOccs.length === (d.constraintOccurrences ?? []).length && subs.length === (d.subtypeOccurrences ?? []).length) return d
    const eps = Object.fromEntries(Object.entries(d.subtypeEndpointOccs ?? {}).filter(([id]) => exists.has(id)))
    return { ...d, occurrences: occs, constraintOccurrences: cOccs, subtypeOccurrences: subs, subtypeEndpointOccs: eps }
  }
  const drop = (pops) => Object.fromEntries(Object.entries(pops ?? {}).filter(([id]) => !removed.has(id)))
  const replace = (xs, fresh) => [...xs.filter(x => !inS(x)), ...fresh]
  return {
    parts: {
      objectTypes: replace(state.objectTypes, nb.objectTypes),
      facts: replace(state.facts, nb.facts),
      subtypes: replace(state.subtypes ?? [], nb.subtypes),
      constraints: replace(state.constraints, nb.constraints),
      diagrams: state.diagrams.map(d => (diagram && d.id === home.id ? diagram : prune(d))),
      populations: drop(state.populations), factPopulations: drop(state.factPopulations),
      mappings: state.mappings.map(m => (m.id === oldMapping.id ? { ...newMapping, id: oldMapping.id, name: oldMapping.name } : m)),
    },
    stats: { kept, added: newIds.size - [...newIds].filter(id => oldIds.includes(id)).length, removed: removed.size },
    homeId: home?.id ?? null,
    newDiagram: !home && nb.diagram ? nb.diagram : null,
  }
}
