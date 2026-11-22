import React, { useEffect, useRef } from 'react'
import { useOrmStore } from '../store/ormStore'
import { LogoMark, Wordmark } from './Logo'
import { version } from '../../package.json'

// Help › About FreeFBM (on macOS FreeFBM › About FreeFBM): store.aboutDialog.
export default function AboutDialog() {
  const open = useOrmStore(s => !!s.aboutDialog)
  if (!open) return null
  return <Dialog />
}

function Dialog() {
  const close = () => useOrmStore.setState({ aboutDialog: false })
  const ref = useRef(null)
  useEffect(() => { ref.current?.focus() }, [])
  const api = window.electronAPI
  return (
    <div onMouseDown={e => { if (e.target === e.currentTarget) close() }}
      onKeyDown={e => { e.stopPropagation(); if (e.key === 'Escape' || e.key === 'Enter') { e.preventDefault(); close() } }}
      style={{ position: 'fixed', inset: 0, zIndex: 1000, background: 'rgba(0,0,0,0.25)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: 'var(--font-ui)' }}>
      <div ref={ref} tabIndex={-1} role="dialog" aria-label="About FreeFBM"
        style={{ width: 380, maxWidth: 'calc(100vw - 32px)', outline: 'none', textAlign: 'center',
          background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius)',
          boxShadow: 'var(--shadow-lg)', padding: '26px 24px 18px' }}>
        <LogoMark size={96} title="FreeFBM logo" style={{ margin: '0 auto 10px' }}/>
        <Wordmark size={34}/>
        <div style={{ fontSize: 12, color: 'var(--ink-2)', marginTop: 8 }}>Version {version}</div>
        <div style={{ fontSize: 12, color: 'var(--ink-muted)', lineHeight: 1.6, margin: '12px 0 4px' }}>
          Fact-based modelling: ORM2 schemas, tables, and the mappings between them.
        </div>
        <div style={{ fontSize: 12, color: 'var(--ink-muted)', lineHeight: 1.6 }}>
          Free and open source under the MIT licence. © 2026 hidders.
        </div>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'center', marginTop: 16 }}>
          {api?.openGitHub && <button className="ui-btn" onClick={() => api.openGitHub()}>FreeFBM on GitHub</button>}
          <button className="ui-btn" onClick={close} title="Close (Esc)">Close</button>
        </div>
      </div>
    </div>
  )
}
