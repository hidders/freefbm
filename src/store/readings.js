// A fact type's (or implied link's) readings as one list.
//
// As in NORMA, a role order may have several readings; the first of each
// order is its preferred reading, the one the diagram shows. The element
// keeps them as
//   readingParts          the primary reading: the preferred reading of the
//                         roles in their own order (roles[] order)
//   alternativeReadings   [{ roleOrder, parts }] the other readings, in
//                         order of preference within each role order
// so the list is [primary, ...alternativeReadings], and index i below
// refers to it. A reading's forms in the view language (subParts,
// pluralParts, cases; see src/verbalisation/lexicon.js) sit in
// lexicon[lang].readings, matched by role order and position among the
// readings of that order, so they move along when readings are reordered or
// removed.

const keyOf = (order) => JSON.stringify(order)
const identity = (n) => Array.from({ length: n }, (_, i) => i)

// For each item of a list of { roleOrder }, its position among the items
// with the same role order.
export function occurrences(list) {
  const seen = new Map()
  return list.map(r => {
    const k = keyOf(r.roleOrder)
    const i = seen.get(k) ?? 0
    seen.set(k, i + 1)
    return i
  })
}

// The entry of list with this role order and occurrence, or undefined.
export function nthOfOrder(list, roleOrder, nth) {
  const k = keyOf(roleOrder)
  return list.filter(r => keyOf(r.roleOrder) === k)[nth]
}

// Drops entries of a lexicon readings list that hold only a roleOrder, except
// where a later entry of the same order still needs it as a placeholder.
export function pruneEntries(list) {
  const has = (r) => Object.keys(r).some(k => k !== 'roleOrder' && r[k] != null)
  return list.filter((r, i) => has(r) || list.slice(i + 1).some(o => keyOf(o.roleOrder) === keyOf(r.roleOrder) && has(o)))
}

// The element's readings: [{ roleOrder, parts, primary, forms }], forms the
// lexicon entry of language lang matched to it (or null).
export function readingList(el, n, lang) {
  const list = [
    ...(el.readingParts != null ? [{ roleOrder: identity(n), parts: el.readingParts, primary: true }] : []),
    ...(el.alternativeReadings ?? []).map(r => ({ roleOrder: r.roleOrder, parts: r.parts, primary: false })),
  ]
  const lex = el.lexicon?.[lang]?.readings ?? []
  const occ = occurrences(list)
  return list.map((r, i) => ({ ...r, forms: (lang && nthOfOrder(lex, r.roleOrder, occ[i])) || null }))
}

// The patch that stores list (as from readingList, possibly edited) on the
// element: the first reading in roles[] order becomes the primary reading,
// and the forms in language lang follow their readings.
export function readingsPatch(el, n, list, lang) {
  const id = keyOf(identity(n))
  const pi = list.findIndex(r => keyOf(r.roleOrder) === id)
  const patch = {
    readingParts: pi >= 0 ? [...list[pi].parts] : null,
    alternativeReadings: list.filter((_, i) => i !== pi).map(r => ({ roleOrder: [...r.roleOrder], parts: [...r.parts] })),
  }
  if (!lang) return patch
  const old = el.lexicon?.[lang]?.readings ?? []
  if (!old.length && !list.some(r => r.forms)) return patch
  // The new order of the readings, primary first, as stored.
  const stored = pi >= 0 ? [list[pi], ...list.filter((_, i) => i !== pi)] : list
  const formsOf = (r) => {
    const { roleOrder: _, parts: __, ...rest } = r.forms ?? {}
    return rest
  }
  // Forms of role orders that no longer have a reading go.
  const entries = stored.map(r => ({ roleOrder: [...r.roleOrder], ...formsOf(r) }))
  const readings = pruneEntries(entries)
  const lexicon = { ...(el.lexicon ?? {}) }
  const entry = { ...(lexicon[lang] ?? {}) }
  if (readings.length) entry.readings = readings
  else delete entry.readings
  if (Object.keys(entry).length) lexicon[lang] = entry
  else delete lexicon[lang]
  patch.lexicon = Object.keys(lexicon).length ? lexicon : undefined
  return patch
}

// List edits, each returning a new list.
export const editReadings = {
  setParts: (list, i, parts) => list.map((r, j) => (j === i ? { ...r, parts } : r)),
  add: (list, roleOrder, parts) => [...list, { roleOrder, parts, primary: false, forms: null }],
  remove: (list, i) => list.filter((_, j) => j !== i),
  // Moves reading i in front of the other readings of its role order.
  prefer: (list, i) => {
    const k = keyOf(list[i].roleOrder)
    const first = list.findIndex(r => keyOf(r.roleOrder) === k)
    if (first === i) return list
    const out = list.filter((_, j) => j !== i)
    out.splice(first, 0, list[i])
    return out
  },
  // Sets the parts of the preferred reading of a role order, adding a
  // reading if the order has none.
  setPreferred: (list, roleOrder, parts) => {
    const i = list.findIndex(r => keyOf(r.roleOrder) === keyOf(roleOrder))
    return i >= 0 ? editReadings.setParts(list, i, parts) : editReadings.add(list, roleOrder, parts)
  },
}

// The preferred reading of each role order, in list order.
export function preferredReadings(list) {
  const seen = new Set()
  return list.filter(r => {
    const k = keyOf(r.roleOrder)
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
}
