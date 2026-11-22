import React from 'react'

// The FreeFBM logo (docs/logo/): a speech bubble that is an objectified fact
// type, two role boxes under one uniqueness bar. The same paths as
// docs/logo/logo.svg, drawn inline so they take the brand tokens of index.css.
const BUBBLE = 'M24,22 H76 Q88,22 88,34 V54 Q88,66 76,66 H44 L26,84 L30,66 H24 Q12,66 12,54 V34 Q12,22 24,22 Z'

// size: height in px. faint: one colour (for the empty-diagram mark).
export function LogoMark({ size = 24, faint = false, title, style }) {
  const navy = faint ? 'currentColor' : 'var(--brand-navy)'
  const bar = faint ? 'currentColor' : 'var(--brand-purple)'
  return (
    <svg viewBox="6 9 88 88" width={size} height={size} style={{ display: 'block', flexShrink: 0, ...style }}
      role={title ? 'img' : undefined} aria-label={title} aria-hidden={title ? undefined : true}>
      <path d={BUBBLE} fill={faint ? 'none' : '#fff'} stroke={navy} strokeWidth="3.5" strokeLinejoin="round"/>
      <rect x="26" y="38" width="24" height="18" fill={faint ? 'none' : '#fff'} stroke={navy} strokeWidth="3"/>
      <rect x="50" y="38" width="24" height="18" fill={faint ? 'none' : '#fff'} stroke={navy} strokeWidth="3"/>
      <line x1="28" y1="31.5" x2="72" y2="31.5" stroke={bar} strokeWidth="3.5" strokeLinecap="round"/>
    </svg>
  )
}

// The name as the logo writes it: Fraunces bold, "Free" purple, "FBM" navy.
export function Wordmark({ size = 24, style }) {
  return (
    <span style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: size,
      letterSpacing: '-0.01em', lineHeight: 1, whiteSpace: 'nowrap', userSelect: 'none', ...style }}>
      <span style={{ color: 'var(--brand-purple)' }}>Free</span>
      <span style={{ color: 'var(--brand-navy)' }}>FBM</span>
    </span>
  )
}
