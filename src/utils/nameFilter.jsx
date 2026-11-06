// The schema browser's name filter: case-insensitive, every word of the
// query must occur (as a substring, in any order) in one of an element's
// texts. "course term" finds "Course is offered in Term"; "instruction type"
// finds InstructionType, "person name" Person_Name.

import React from 'react'

export function makeNameFilter(query) {
  const words = (query ?? '').toLowerCase().split(/\s+/).filter(Boolean)
  if (!words.length) return null
  return {
    words,
    // texts: strings (falsy ones ignored)
    test(...texts) {
      const hay = texts.flat().filter(Boolean).join('\n').toLowerCase()
      return words.every(w => hay.includes(w))
    },
  }
}

// [start, end) ranges of the query's words in text, merged.
function matchRanges(text, words) {
  const low = text.toLowerCase()
  const ranges = []
  for (const w of words) {
    for (let i = low.indexOf(w); i !== -1; i = low.indexOf(w, i + w.length)) ranges.push([i, i + w.length])
  }
  ranges.sort((a, b) => a[0] - b[0])
  const merged = []
  for (const r of ranges) {
    const last = merged[merged.length - 1]
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1])
    else merged.push([...r])
  }
  return merged
}

const MARK = { background: 'var(--filter-match, rgba(250, 204, 21, 0.45))', color: 'inherit', borderRadius: 2, padding: 0 }

// text with the filter's words marked.
export function Highlight({ text, filter }) {
  const s = text == null ? '' : String(text)
  if (!filter || !s) return s
  const ranges = matchRanges(s, filter.words)
  if (!ranges.length) return s
  const out = []
  let at = 0
  ranges.forEach(([a, b], i) => {
    if (a > at) out.push(s.slice(at, a))
    out.push(<mark key={i} style={MARK}>{s.slice(a, b)}</mark>)
    at = b
  })
  if (at < s.length) out.push(s.slice(at))
  return <>{out}</>
}
