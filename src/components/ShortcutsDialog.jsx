import React, { useEffect, useRef } from 'react'
import { useOrmStore } from '../store/ormStore'
import { SHORTCUT_GROUPS } from '../utils/shortcuts'

// Help › Keyboard Shortcuts, or ? on the canvas (store.shortcutsDialog).
export default function ShortcutsDialog() {
  const open = useOrmStore(s => !!s.shortcutsDialog)
  if (!open) return null
  return <Dialog />
}

function Dialog() {
  const close = () => useOrmStore.setState({ shortcutsDialog: false })
  const ref = useRef(null)
  useEffect(() => { ref.current?.focus() }, [])
  return (
    <div onMouseDown={e => { if (e.target === e.currentTarget) close() }}
      onKeyDown={e => { e.stopPropagation(); if (e.key === 'Escape' || e.key === '?') { e.preventDefault(); close() } }}
      style={{ position: 'fixed', inset: 0, zIndex: 1000, background: 'rgba(0,0,0,0.25)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: 'var(--font-ui)' }}>
      <div ref={ref} tabIndex={-1} role="dialog" aria-labelledby="shortcuts-title"
        style={{ width: 720, maxWidth: 'calc(100vw - 32px)', maxHeight: '85vh', overflowY: 'auto', outline: 'none',
          background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius)',
          boxShadow: 'var(--shadow-lg)', padding: '14px 18px 18px' }}>
        <div style={{ display: 'flex', alignItems: 'center', marginBottom: 10 }}>
          <div id="shortcuts-title" style={{ fontWeight: 600, fontSize: 14, color: 'var(--ink)', flex: 1 }}>Keyboard shortcuts</div>
          <button onClick={close} title="Close (Esc)" className="ui-btn">Close</button>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: '6px 28px' }}>
          {SHORTCUT_GROUPS.map(g => (
            <div key={g.title}>
              <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase',
                color: 'var(--accent)', margin: '8px 0 4px' }}>{g.title}</div>
              {g.items.map(([keys, label]) => <ShortcutRow key={label} keys={keys} label={label} />)}
            </div>
          ))}
        </div>
        <div style={{ marginTop: 12, fontSize: 11, color: 'var(--ink-muted)' }}>
          Single-letter tool keys work when no text field has the focus.
        </div>
      </div>
    </div>
  )
}

export function ShortcutRow({ keys, label }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '3px 0', borderBottom: '1px solid var(--border-soft)' }}>
      <span style={{ display: 'flex', gap: 3, minWidth: 92, flexShrink: 0 }}>
        {keys.map((k, i) => <Kbd key={i}>{k}</Kbd>)}
      </span>
      <span style={{ fontSize: 12, color: 'var(--ink-2)' }}>{label}</span>
    </div>
  )
}

export function Kbd({ children }) {
  return (
    <kbd style={{ fontFamily: 'var(--font-ui)', fontSize: 11, padding: '1px 6px', minWidth: 12, textAlign: 'center',
      background: 'var(--bg-raised)', border: '1px solid var(--border)', borderBottomWidth: 2, borderRadius: 4,
      color: 'var(--ink-2)' }}>{children}</kbd>
  )
}
