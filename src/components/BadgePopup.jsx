// The popup of a validation badge on the canvas (ORM2 shapes in Canvas.jsx,
// tables in ErdView.jsx): the messages of the badge's element, by severity.

import React from 'react'
import { createPortal } from 'react-dom'

export const BADGE_SEV_COLOUR = { error: '#dc2626', warning: '#d97706', population: '#f5b400', changed: '#7c3aed', rewritten: '#64748b' }
export const BADGE_SEV_ICON   = { error: '✕', warning: '!', population: '!', changed: '✎', rewritten: '✎' }
const BADGE_POPUP_FONT = 'var(--font-ui)'
const POP_W = 260

// Returns { left, top|bottom, maxHeight } that keep the popup within the viewport.
export function popupPos(x, y, popW) {
  const MARGIN = 8, GAP = 16
  const left = Math.max(MARGIN, Math.min(x - popW / 2, window.innerWidth - popW - MARGIN))
  const spaceAbove = y - GAP
  const spaceBelow = window.innerHeight - y - GAP
  if (spaceAbove >= spaceBelow || spaceAbove >= 120) {
    return { left, bottom: window.innerHeight - y + GAP,
             maxHeight: Math.max(60, spaceAbove - MARGIN) }
  }
  return { left, top: y + GAP,
           maxHeight: Math.max(60, spaceBelow - MARGIN) }
}

// popup: { clientX, clientY, elementErrors: [{ id, severity, message, label? }] } or null.
export function BadgePopup({ popup }) {
  if (!popup) return null
  const pos = popupPos(popup.clientX, popup.clientY, POP_W)
  return createPortal(
    <div style={{
      position: 'fixed', ...pos, width: POP_W, maxHeight: pos.maxHeight,
      overflowY: 'auto',
      background: 'var(--bg-surface)',
      border: '1px solid var(--border)',
      borderRadius: 6,
      boxShadow: '0 4px 20px rgba(0,0,0,0.22)',
      padding: 8,
      zIndex: 10200,
      fontFamily: BADGE_POPUP_FONT,
      pointerEvents: 'none',
      userSelect: 'none',
      display: 'flex', flexDirection: 'column', gap: 4,
    }}>
      {popup.elementErrors.map(err => (
        <div key={err.id} style={{
          display: 'flex', alignItems: 'flex-start', gap: 6,
          padding: '5px 7px', borderRadius: 4,
          background: 'var(--bg-raised)',
          border: '1px solid var(--border-soft)',
          borderLeft: `3px solid ${BADGE_SEV_COLOUR[err.severity]}`,
        }}>
          <span style={{ color: BADGE_SEV_COLOUR[err.severity], fontWeight: 700, fontSize: 9, marginTop: 2, flexShrink: 0 }}>
            {BADGE_SEV_ICON[err.severity]}
          </span>
          <span style={{ fontSize: 11, color: 'var(--ink-2)', lineHeight: 1.4 }}>
            {err.label && <b style={{ fontWeight: 600 }}>{err.label}: </b>}{err.message}
          </span>
        </div>
      ))}
    </div>,
    document.body
  )
}
