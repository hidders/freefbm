import React from 'react'
import { TOKEN_STYLE } from './ConstraintsTab.jsx'

// Token styles of mapping patterns (mapping.js sideTokens): frontier
// variables ŷ stand out from the local variables.
export const MAPPING_TOKEN_STYLE = {
  ...TOKEN_STYLE,
  fv: { color: 'var(--formula-fn)', fontWeight: 700 },
  plain: { color: 'var(--ink-2)' },
}

// A pattern, or a whole rule φ ⟺ ψ, as coloured text that copies as it reads.
export function PatternText({ tokens, style }) {
  return (
    <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, lineHeight: 1.6, whiteSpace: 'pre-wrap', ...style }}>
      {tokens.map((t, i) => <span key={i} style={MAPPING_TOKEN_STYLE[t.kind]}>{t.text}</span>)}
    </span>
  )
}

export function IssueList({ issues, ok = 'No problems found.' }) {
  if (!issues.length) return <div style={{ fontSize: 12, color: 'var(--col-candidate)' }}>✓ {ok}</div>
  return issues.map((i, k) => (
    <div key={k} style={{ fontSize: 12, lineHeight: 1.5, color: i.severity === 'error' ? '#dc2626' : '#d97706' }}>
      {i.severity === 'error' ? '✕' : '!'} {i.text}
    </div>
  ))
}
