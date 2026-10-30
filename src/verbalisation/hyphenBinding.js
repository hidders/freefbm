// Hyphen binding in readings, as in NORMA (VerbalizationHyphenBinder).
//
// A reading's text may bind words to a role player, so that verbalisation
// puts the quantifier in front of them: with the reading
// "… has first- given …" for Person and Name, "each Person has at most one
// first given Name", not "… has first given at most one Name".
//   - A word ending in a hyphen (first-) binds itself and the words after it,
//     up to the role player, to that role player (left binding).
//   - A word starting with a hyphen (-principal) binds the words from the role
//     player up to and including itself (right binding): "… a … -principal"
//     gives "au plus un Nom principal".
//   - A doubled hyphen keeps one hyphen and joins the words without a space:
//     "ex-- …" gives "ex-Partner", "… --in-law" gives "Parent-in-law".
// The hyphens are only markers: the diagram shows the reading as typed,
// verbalisation and the formulas show it without them.
//
// parts are a reading's parts as in readingParts (parts[k] precedes slot k,
// parts[n] follows the last slot). A left binding of slot k sits at the end
// of parts[k], a right binding at the start of parts[k + 1].

const isLeft = (w) => /\S-$/.test(w)
const isRight = (w) => /^-\S/.test(w)
const words = (s) => (s?.trim() ? s.trim().split(/\s+/) : [])

// Splits a reading into the text around the slots and the words bound to
// each slot: { parts, bound } where parts are the remaining parts and
// bound[k] is null or { pre, preGlue, post, postGlue } (pre/post the bound
// words, '' if none; a glue flag means no space between them and the role
// player). bound is null when the reading binds nothing.
export function hyphenBind(parts, n) {
  const rest = Array.from({ length: n + 1 }, (_, k) => parts?.[k] ?? '')
  const bound = Array.from({ length: n }, () => null)
  let any = false
  const slot = (k) => (bound[k] ??= { pre: '', preGlue: false, post: '', postGlue: false })
  for (let k = 0; k <= n; k++) {
    let ws = words(rest[k])
    if (!ws.some(w => isLeft(w) || isRight(w))) continue
    if (k > 0) {
      const j = ws.findIndex(isRight)
      if (j >= 0) {
        const last = ws[j].slice(1)
        const glue = last.startsWith('-') && last.length > 1
        const before = ws.slice(0, j)
        const b = slot(k - 1)
        if (before.length) {
          b.post = glue ? [...before.slice(0, -1), before[before.length - 1] + last].join(' ') : [...before, last].join(' ')
        } else {
          b.post = last
          b.postGlue = glue
        }
        ws = ws.slice(j + 1)
        any = true
      }
    }
    if (k < n) {
      const i = ws.findIndex(isLeft)
      if (i >= 0) {
        const first = ws[i].slice(0, -1)
        const glue = first.endsWith('-') && first.length > 1
        const after = ws.slice(i + 1)
        const b = slot(k)
        if (after.length) {
          b.pre = glue ? [first + after[0], ...after.slice(1)].join(' ') : [first, ...after].join(' ')
        } else {
          b.pre = first
          b.preGlue = glue
        }
        ws = ws.slice(0, i)
        any = true
      }
    }
    rest[k] = ws.join(' ')
  }
  return { parts: rest, bound: any ? bound : null }
}

// Whether the reading binds words to the role player in slot k (any slot if
// k is left out).
export function isHyphenBound(parts, n, k) {
  const { bound } = hyphenBind(parts, n)
  if (!bound) return false
  return k === undefined ? bound.some(Boolean) : !!bound[k]
}

// The reading's parts with the binding hyphens taken out, for showing a
// reading as plain text (formula atoms): "has first- given" → "has first
// given", "ex--" → "ex-", "--in-law" → "-in-law".
export function plainParts(parts, n) {
  const { parts: rest, bound } = hyphenBind(parts, n)
  if (!bound) return parts
  return rest.map((p, k) => {
    const post = (k > 0 && bound[k - 1]?.post) || ''
    const pre = (k < n && bound[k]?.pre) || ''
    return [post, p, pre].filter(s => s.trim()).join(' ')
  })
}
