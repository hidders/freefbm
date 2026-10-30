import React from 'react'
import { useOrmStore } from '../store/ormStore'

// What a NORMA import did: counts, what was skipped or turned into a note,
// and what is left for later. Shown after File › Open of a .orm file until
// closed; the text is selectable and copyable.
export default function ImportLogPanel() {
  const log = useOrmStore(s => s.importLog)
  const close = () => useOrmStore.getState().setImportLog(null)
  if (!log?.entries?.length) return null
  return (
    <div style={{
      position: 'fixed', top: 64, right: 16, width: 420, maxHeight: '60vh', zIndex: 900,
      display: 'flex', flexDirection: 'column',
      background: 'var(--bg-surface)', border: '1px solid var(--border)',
      borderRadius: 'var(--radius)', boxShadow: 'var(--shadow-md)',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px',
        borderBottom: '1px solid var(--border-soft)' }}>
        <span style={{ fontWeight: 600, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          Imported from {log.source}
        </span>
        <button onClick={close} title="Close" style={{ border: 'none', background: 'none',
          cursor: 'pointer', color: 'var(--ink-3)', fontSize: 16, lineHeight: 1 }}>×</button>
      </div>
      <ul data-text-panel tabIndex={0} className="copyable" style={{ margin: 0, padding: '8px 12px 10px 28px',
        overflowY: 'auto', background: 'var(--bg-text-panel)', fontSize: 12, lineHeight: 1.45,
        color: 'var(--ink-2)', borderRadius: '0 0 var(--radius) var(--radius)' }}>
        {log.entries.map((e, i) => (
          <li key={i} style={{ marginBottom: 4, listStyle: e.level === 'warn' ? '"⚠  "' : 'disc' }}>
            {e.text}
          </li>
        ))}
      </ul>
      <div style={{ padding: '6px 10px', fontSize: 11, color: 'var(--ink-3)', borderTop: '1px solid var(--border-soft)' }}>
        This is a new, unsaved model. Save writes a .ffbm file; the .orm file is not changed.
      </div>
    </div>
  )
}
