import React from 'react'
import { useOrmStore } from '../store/ormStore'
import { LogoMark } from './Logo'

// A faint logo in the middle of a diagram that shows nothing yet, with a hint
// on how to fill it. Not a click target, and gone once anything is on the
// diagram (an occurrence, a constraint or a note).
export default function EmptyDiagramMark() {
  const empty = useOrmStore(s => {
    const d = s.diagrams?.find(x => x.id === s.activeDiagramId) ?? s.diagrams?.[0]
    if (!d) return false
    return !(d.occurrences?.length) && !(d.constraintOccurrences?.length) && !(d.notes?.length)
      && !Object.keys(d.positions ?? {}).length
  })
  if (!empty) return null
  return (
    <div className="no-print" aria-hidden="true" style={{ position: 'absolute', inset: 0, pointerEvents: 'none',
      display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 14,
      color: 'var(--brand-navy)', fontFamily: 'var(--font-ui)', userSelect: 'none' }}>
      <LogoMark size={180} faint style={{ opacity: 0.09 }}/>
      <div style={{ fontSize: 12, color: 'var(--ink-muted)', opacity: 0.8, textAlign: 'center', lineHeight: 1.6, maxWidth: 260 }}>
        This diagram is empty.<br/>
        Add elements from the Browser or with the tools on the left.
      </div>
    </div>
  )
}
