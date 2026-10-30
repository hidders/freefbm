// The view language: the language in which the model's names and readings
// are shown and edited.
//
// The live fields (an object type's name, a nested fact type's
// objectifiedName, and readingParts and alternativeReadings of fact types and
// implied links) always hold the text in the view language; the model's
// other languages sit in each element's lexicon (see
// src/verbalisation/lexicon.js). Switching the view moves the live text into
// lexicon[from] and takes lexicon[to] out into the live fields. The file is
// always saved in the base language.
//
// Where the view language has no name or readings for an element, the live
// fields show the base language's text instead, and the element records it
// in _fb ({ name, readings: { [roleOrder]: parts } }), so the diagram can
// show it as a placeholder and switching away does not store it as a
// translation. Editing a name clears _fb.name; a reading counts as
// translated once its text differs from the fallback.

export const BASE_LANGUAGE = 'en'

const hasText = (parts) => Array.isArray(parts) && parts.some(p => p?.trim())
const keyOf = (order) => JSON.stringify(order)
const identity = (n) => Array.from({ length: n }, (_, i) => i)
const isEmpty = (o) => !o || !Object.keys(o).length

function liveReadings(el, n) {
  return [
    ...(hasText(el.readingParts) ? [{ roleOrder: identity(n), parts: el.readingParts }] : []),
    ...(el.alternativeReadings ?? []).filter(r => r.roleOrder?.length === n && hasText(r.parts)),
  ]
}

// Moves the live text of el (in language lang) into el.lexicon[lang].
function flatten(el, lang, { nameKey, n }) {
  const fb = el._fb ?? {}
  const lexicon = { ...(el.lexicon ?? {}) }
  const entry = { ...(lexicon[lang] ?? {}) }
  if (nameKey) {
    const name = el[nameKey]
    if (name?.trim() && (fb.name == null || name !== fb.name)) entry.name = name
  }
  if (n != null) {
    let readings = (entry.readings ?? []).map(r => {
      const { parts: _, ...rest } = r
      return rest
    })
    for (const r of liveReadings(el, n)) {
      const k = keyOf(r.roleOrder)
      if (fb.readings?.[k] && keyOf(fb.readings[k]) === keyOf(r.parts)) continue
      const i = readings.findIndex(x => keyOf(x.roleOrder) === k)
      if (i >= 0) readings[i] = { ...readings[i], parts: r.parts }
      else readings.push({ roleOrder: r.roleOrder, parts: r.parts })
    }
    readings = readings.filter(r => Object.keys(r).some(k => k !== 'roleOrder' && r[k] != null))
    if (readings.length) entry.readings = readings
    else delete entry.readings
  }
  if (isEmpty(entry)) delete lexicon[lang]
  else lexicon[lang] = entry
  const out = { ...el, lexicon: isEmpty(lexicon) ? undefined : lexicon }
  delete out._fb
  return out
}

// Takes language lang out of el.lexicon into the live fields, falling back
// to the base language's text (or, if the element has none, any text).
function lift(el, lang, { nameKey, n }, fallbackLangs) {
  const lexicon = { ...(el.lexicon ?? {}) }
  const entry = { ...(lexicon[lang] ?? {}) }
  const fb = {}
  const out = { ...el }
  if (nameKey) {
    const own = entry.name?.trim() ? entry.name : null
    delete entry.name
    if (own) out[nameKey] = own
    else {
      const other = fallbackLangs.map(l => lexicon[l]?.name).find(t => t?.trim())
      out[nameKey] = other ?? (nameKey === 'name' ? '' : out[nameKey])
      if (other) fb.name = other
    }
  }
  if (n != null) {
    const textOf = (l) => (lexicon[l]?.readings ?? []).filter(r => r.roleOrder?.length === n && hasText(r.parts))
    let readings = textOf(lang)
    entry.readings = (entry.readings ?? []).map(r => {
      const { parts: _, ...rest } = r
      return rest
    }).filter(r => Object.keys(r).some(k => k !== 'roleOrder' && r[k] != null))
    if (!entry.readings.length) delete entry.readings
    if (!readings.length) {
      const from = fallbackLangs.find(l => textOf(l).length)
      readings = from ? textOf(from) : []
      if (readings.length) fb.readings = Object.fromEntries(readings.map(r => [keyOf(r.roleOrder), r.parts]))
    }
    const idKey = keyOf(identity(n))
    const primary = readings.find(r => keyOf(r.roleOrder) === idKey)
    out.readingParts = primary ? [...primary.parts] : null
    out.alternativeReadings = readings.filter(r => r !== primary).map(r => ({ roleOrder: [...r.roleOrder], parts: [...r.parts] }))
  }
  if (isEmpty(entry)) delete lexicon[lang]
  else lexicon[lang] = entry
  out.lexicon = isEmpty(lexicon) ? undefined : lexicon
  if (!isEmpty(fb)) out._fb = fb
  else delete out._fb
  return out
}

function swapElement(el, from, to, shape) {
  if (from === to) return el
  return lift(flatten(el, from, shape), to, shape, [BASE_LANGUAGE, from])
}

const factShape = (f) => ({ nameKey: f.objectified ? 'objectifiedName' : null, n: f.arity ?? f.roles?.length ?? 0 })

// The model's object types and fact types with the live text moved from
// language from to language to.
export function swapLanguage({ objectTypes, facts }, from, to) {
  if (from === to) return { objectTypes, facts }
  return {
    objectTypes: objectTypes.map(o => swapElement(o, from, to, { nameKey: 'name' })),
    facts: facts.map(f => {
      const g = swapElement(f, from, to, factShape(f))
      if (!f.implicitLinks?.length) return g
      return { ...g, implicitLinks: f.implicitLinks.map(il => swapElement(il, from, to, { n: 2 })) }
    }),
  }
}

// The model's languages: the base language, the ones added explicitly, and
// every language some element has lexicon entries for, in LANGUAGES order.
export function modelLanguages(state, all) {
  const found = new Set([BASE_LANGUAGE, state.viewLanguage ?? BASE_LANGUAGE, ...(state.languages ?? [])])
  const scan = (el) => { for (const [lang, entry] of Object.entries(el?.lexicon ?? {})) if (!isEmpty(entry)) found.add(lang) }
  for (const o of state.objectTypes ?? []) scan(o)
  for (const f of state.facts ?? []) {
    scan(f)
    for (const il of f.implicitLinks ?? []) scan(il)
  }
  return all.filter(l => found.has(l.id))
}

// Whether the shown reading of el with this role order is the fallback text.
export function isFallbackReading(el, roleOrder, parts) {
  const fb = el?._fb?.readings?.[keyOf(roleOrder)]
  return !!fb && keyOf(fb) === keyOf(parts)
}
