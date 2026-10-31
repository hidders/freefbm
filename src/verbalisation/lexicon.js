// The model's per-language lexicon (see the spec, "Per-language readings").
//
// Object types and nested entity types may carry
//   lexicon: { [lang]: { name?, plural?, gender? } }
// where gender is the language's own word class ('de' or 'het' in Dutch, 'm'
// or 'f' in French, Italian and Spanish, 'mp', 'ma', 'mi', 'f' or 'n' in
// Polish), and in a language with cases (Polish)
//   forms: { gen, dat, acc, ins, loc, genPl, datPl, accPl, insPl, locPl }
// the name in the other cases (the nominative is name and plural).
// The language the element's own name and readings are in (the view
// language, ctx.liveLanguage, English by default; see
// src/store/viewLanguage.js) uses the element's own name; its lexicon entry
// only adds a plural ("Staff", not "Staffs"), a gender and case forms.
//
// Fact types may carry
//   lexicon: { [lang]: { readings: [{ roleOrder, parts, subParts?, pluralParts?, cases? }] } }
// with parts as in readingParts (parts[k] precedes the role roleOrder[k]),
// subParts the subordinate-clause word order (Dutch: "… Course volgt"),
// pluralParts the reading with a plural subject ("are prerequisites for"),
// and cases the grammatical case of each slot in reading order (Polish:
// ['nom', 'acc']).
// A role order may have several readings, the first of them preferred
// (src/store/readings.js). For the live language, entries add subParts,
// pluralParts or cases to the reading with the same roleOrder and the same
// position among the readings of that order; for other languages they are
// the language's readings, and without any the live readings are used.

import { occurrences, nthOfOrder } from '../store/readings.js'

const hasText = (parts) => Array.isArray(parts) && parts.some(p => p?.trim())

export function readingsFor(fact, langId, n = fact.roles?.length ?? 0, live = 'en') {
  const all = [
    ...(fact.readingParts != null ? [{ roleOrder: [...Array(n).keys()], parts: fact.readingParts }] : []),
    ...(fact.alternativeReadings ?? []),
  ].filter(r => r.roleOrder?.length === n)
  const own = (fact.lexicon?.[langId]?.readings ?? []).filter(r => r.roleOrder?.length === n)
  if (langId !== live && own.some(r => hasText(r.parts))) return own.filter(r => hasText(r.parts))
  const occ = occurrences(all)
  return all.map((r, i) => {
    if (!hasText(r.parts)) return null
    const extra = nthOfOrder(own, r.roleOrder, occ[i])
    return extra ? { ...r, subParts: extra.subParts, pluralParts: extra.pluralParts, cases: extra.cases } : r
  }).filter(Boolean)
}

// { name, plural, gender } of a type in a language; name falls back to the
// type's own name split into words (splitName), plural and gender to null.
export function typeLexicon(ctx, typeId, langId) {
  const el = ctx.otById.get(typeId) ?? ctx.factById.get(typeId)
  const lex = el?.lexicon?.[langId] ?? {}
  return {
    name: (langId !== (ctx.liveLanguage ?? 'en') && lex.name?.trim()) || splitName(ctx.typeName(typeId)),
    plural: lex.plural?.trim() || null,
    gender: lex.gender || null,
    forms: lex.forms ?? {},
  }
}

// Sentences show a combined name as separate words, keeping the capitals:
// "InstructionType" → "Instruction Type", "PersonNr" → "Person Nr",
// "HTTPRequest" → "HTTP Request", "Person_Name" → "Person Name". Digits stay
// attached ("Year2", but "Year2Start" → "Year2 Start"). Formulas keep the name as entered.
export function splitName(name) {
  return (name ?? '')
    .replace(/_+/g, ' ')
    .replace(/(\p{Ll})(\p{Lu})/gu, '$1 $2')
    .replace(/(\p{Lu}+)(\p{Lu}\p{Ll})/gu, '$1 $2')
    .replace(/(\d)(\p{Lu})/gu, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim()
}

export { hasText }
