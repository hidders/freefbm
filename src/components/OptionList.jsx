import React, { useState, useEffect, useRef, useLayoutEffect } from 'react'
import { createPortal } from 'react-dom'

// The value list of a population cell (fact type populations, table records'
// foreign key columns), in place of the browser's datalist, which shows only
// what fits in the window. It is fixed to the window so the panel's scrolling
// does not clip it: below the cell, or above it when there is more room
// there, as high as the room allows (at most 320 px) and scrollable. The
// caller keeps the input focused (mousedown here is prevented), filters the
// options and moves the highlight `hi` with the arrow keys.
export default function OptionList({ anchor, options, current, hi, onPick }) {
  const ref = useRef(null)
  const [pos, setPos] = useState(null)
  useLayoutEffect(() => {
    if (!anchor) return
    const place = () => {
      const r = anchor.getBoundingClientRect()
      const below = window.innerHeight - r.bottom - 8, above = r.top - 8
      const down = below >= 160 || below >= above
      setPos({ left: r.left, width: Math.max(r.width, 120), ...(down ? { top: r.bottom + 2, maxHeight: below } : { bottom: window.innerHeight - r.top + 2, maxHeight: above }) })
    }
    place()
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    return () => { window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true) }
  }, [anchor])
  // Keep the highlighted (or current) value in view.
  useEffect(() => {
    const i = hi >= 0 ? hi : options.indexOf(current)
    ref.current?.children[i]?.scrollIntoView({ block: 'nearest' })
  }, [hi, pos, options, current])
  if (!pos) return null
  return createPortal(
    <div ref={ref} className="rg-options" onMouseDown={e => e.preventDefault()}
      style={{ position: 'fixed', zIndex: 1000, overflowY: 'auto', ...pos, maxHeight: Math.min(pos.maxHeight, 320),
        background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 3, boxShadow: '0 4px 12px rgba(0,0,0,0.18)',
        fontFamily: 'var(--font-mono)', fontSize: 12 }}>
      {options.map((o, i) => (
        <div key={o} onClick={() => onPick(o)}
          style={{ padding: '3px 8px', cursor: 'pointer', whiteSpace: 'nowrap',
            background: i === hi ? 'var(--selection)' : o === current ? 'var(--bg-raised)' : undefined,
            fontWeight: o === current ? 600 : undefined }}
          onMouseEnter={e => { if (i !== hi) e.currentTarget.style.background = 'var(--bg-raised)' }}
          onMouseLeave={e => { e.currentTarget.style.background = i === hi ? 'var(--selection)' : o === current ? 'var(--bg-raised)' : '' }}>{o}</div>
      ))}
    </div>, document.body)
}
