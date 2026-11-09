// How sentences write object type names: NORMA's verbalisation option
// "Object type name display" (ObjectTypeNameVerbalizationStyle, ported from
// NORMA's Verbalization.cs NormalizeObjectTypeName and Utility.cs MatchNameParts).
//   asIs          the name as entered (NORMA's default)
//   separate      separate combined names, lower case: "InstructionType" → "instruction type"
//   combineUpper  combine names, lead with upper case: "instruction type" → "InstructionType"
//   combineLower  combine names, lead with lower case: "Instruction Type" → "instructionType"
// removeChars (NORMA's "Remove characters on separate", default ".:_") are
// dropped when a style other than asIs is used.
// A reference mode value type ("DiplomatName", "Family Name") is written as its
// two names, the entity type's and the reference mode's, as NORMA does.

export const NAME_STYLES = [
  { id: 'asIs', label: 'As is', sub: 'Names as entered' },
  { id: 'separate', label: 'Separate combined names', sub: 'InstructionType → instruction type' },
  { id: 'combineUpper', label: 'Combine names, lead with upper case', sub: 'instruction type → InstructionType' },
  { id: 'combineLower', label: 'Combine names, lead with lower case', sub: 'Instruction Type → instructionType' },
]
export const DEFAULT_REMOVE_CHARS = '.:_'

const isPS = c => /[\p{P}\p{S}]/u.test(c)
const isDigit = c => /\p{Nd}/u.test(c)
const isUpper = c => /\p{Lu}/u.test(c)
const isLower = c => /\p{Ll}/u.test(c)

// NORMA's SplitOnUpperAndNumberRegex: the parts of a name without spaces, each
// { text, kind: 'symbol' | 'numeric' | 'upper' (several capitals) | 'word' }.
export function nameParts(name) {
  const chars = [...name]
  const parts = []
  let i = 0
  while (i < chars.length) {
    const c = chars[i]
    let j = i + 1, kind = 'word'
    if (isPS(c)) kind = 'symbol'
    else if (isDigit(c)) {
      kind = 'numeric'
      while (j < chars.length && isDigit(chars[j])) j++
      // lower case letters after a number stay with it, unless a digit follows them
      let k = j
      while (k < chars.length && isLower(chars[k])) k++
      if (k > j && !(k < chars.length && isDigit(chars[k]))) j = k
    } else if (isUpper(c)) {
      if (j < chars.length && !isUpper(chars[j])) {
        while (j < chars.length && !isUpper(chars[j]) && !isDigit(chars[j]) && !isPS(chars[j])) j++
      } else {
        kind = 'upper'
        while (j < chars.length && isUpper(chars[j]) && !(j + 1 < chars.length && isLower(chars[j + 1]))) j++
      }
    } else {
      while (j < chars.length && !isUpper(chars[j]) && !isDigit(chars[j]) && !isPS(chars[j])) j++
    }
    parts.push({ text: chars.slice(i, j).join(''), kind })
    i = j
  }
  return parts
}

// NORMA's IsMultiPartName: a capital, symbol or punctuation after the first
// character, or a digit
function isMultiPart(name) {
  return /^\s*\S+?[\p{Lu}\p{P}\p{S}]/u.test(name) || /\p{Nd}/u.test(name)
}

const lowerFirst = s => s.replace(/^\p{Lu}/u, m => m.toLowerCase())
const upperFirst = s => s.replace(/^\p{Ll}/u, m => m.toUpperCase())

// Appends one name to st.out ({ out, spacePending, makeLower }).
function normalise(name, style, remove, st) {
  if (style === 'combineUpper' || style === 'combineLower') {
    if (name.includes(' ')) {
      for (const w of name.split(' ').filter(Boolean)) normalise(w, style, remove, st)
      return
    }
    for (const p of nameParts(name)) {
      if (p.kind === 'upper') { st.out += p.text; st.makeLower = false }
      else if (p.kind === 'symbol') { if (!remove?.includes(p.text)) st.out += p.text }
      else if (st.makeLower) { st.makeLower = false; st.out += lowerFirst(p.text) }
      else st.out += upperFirst(p.text)
    }
    return
  }
  // separate
  if (name.includes(' ')) {
    for (const w of name.split(' ').filter(Boolean)) normalise(w, style, remove, st)
    return
  }
  const space = () => { if (st.spacePending) st.out += ' ' }
  if (isMultiPart(name)) {
    for (const p of nameParts(name)) {
      if (p.kind === 'upper') { space(); st.out += p.text; st.spacePending = true }
      else if (p.kind === 'symbol') {
        if (!remove?.includes(p.text)) { st.out += p.text; st.spacePending = false }
      } else if (p.kind === 'numeric') { st.out += p.text; st.spacePending = true }
      else { space(); st.out += lowerFirst(p.text); st.spacePending = true }
    }
    return
  }
  space()
  st.out += lowerFirst(name)
  st.spacePending = true
}

// The name of an object type as sentences write it. names: the entity type's
// and reference mode's names when it is a reference mode value type
// ({ entity, mode }), else null.
export function styleName(name, style = 'asIs', removeChars = DEFAULT_REMOVE_CHARS, refMode = null) {
  if (!name || !style || style === 'asIs') return name
  const remove = removeChars || null
  const st = { out: '', spacePending: false, makeLower: style === 'combineLower' }
  if (refMode) {
    normalise(refMode.entity, style, remove, st)
    normalise(refMode.mode, style, remove, st)
  } else normalise(name, style, remove, st)
  return st.out
}
