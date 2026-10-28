// The model's per-language lexicon (see the spec, "Per-language readings").
//
// Object types and nested entity types may carry
//   lexicon: { [lang]: { name?, plural?, gender? } }
// where gender is the language's own word class ('de' or 'het' in Dutch).
// English uses the element's own name; its lexicon entry only adds a plural
// ("Staff", not "Staffs").
//
// Fact types may carry
//   lexicon: { [lang]: { readings: [{ roleOrder, parts, subParts?, pluralParts? }] } }
// with parts as in readingParts (parts[k] precedes the role roleOrder[k]),
// subParts the subordinate-clause word order (Dutch: "… Course volgt"), and
// pluralParts the reading with a plural subject ("are prerequisites for").
// For English, entries add subParts or pluralParts to the reading with the
// same roleOrder; for other languages they are the language's readings, and
// without any the English readings are used.

const hasText = (parts) => Array.isArray(parts) && parts.some(p => p?.trim())
const sameOrder = (a, b) => a.length === b.length && a.every((x, i) => x === b[i])

export function readingsFor(fact, langId, n = fact.roles?.length ?? 0) {
  const english = [
    { roleOrder: [...Array(n).keys()], parts: fact.readingParts ?? [] },
    ...(fact.alternativeReadings ?? []),
  ].filter(r => r.roleOrder?.length === n && hasText(r.parts))
  const own = (fact.lexicon?.[langId]?.readings ?? []).filter(r => r.roleOrder?.length === n)
  if (langId !== 'en' && own.some(r => hasText(r.parts))) return own.filter(r => hasText(r.parts))
  return english.map(r => {
    const extra = own.find(o => sameOrder(o.roleOrder, r.roleOrder))
    return extra ? { ...r, subParts: extra.subParts, pluralParts: extra.pluralParts } : r
  })
}

// { name, plural, gender } of a type in a language; name falls back to the
// type's own name, plural and gender to null.
export function typeLexicon(ctx, typeId, langId) {
  const el = ctx.otById.get(typeId) ?? ctx.factById.get(typeId)
  const lex = el?.lexicon?.[langId] ?? {}
  return {
    name: (langId !== 'en' && lex.name?.trim()) || ctx.typeName(typeId),
    plural: lex.plural?.trim() || null,
    gender: lex.gender || null,
  }
}

export { hasText }
