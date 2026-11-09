import React, { useEffect, useRef, useState } from 'react'
import { useOrmStore, useOrmStoreIgnoring } from '../store/ormStore'
import SchemaBrowser from './SchemaBrowser'
import ValidationPanel, { visibleIssues } from './ValidationPanel'
import Splitter from './Splitter'

const FONT = 'var(--font-ui)'
const RAIL  = 26
const MIN_W = 180
const MAX_W = 640

const TABS = [
  { id: 'browser',  label: 'Browser',  key: '1', title: 'Schema browser' },
  { id: 'problems', label: 'Problems', key: '2', title: 'Validation problems' },
]

// The docked sidebar left of the canvas: the schema browser and the
// validation problems as two tabs (UI review, approved 2026-11-09). « folds it
// to a narrow rail; ⌘1 / ⌘2 (Ctrl on Windows and Linux) show or hide a tab.
// Open, tab and width are kept in localStorage (store.sidebar).
export default function Sidebar() {
  const store = useOrmStoreIgnoring('pan', 'zoom')
  const { open, tab, width } = store.sidebar
  const { errors } = visibleIssues(store)
  const errorN   = errors.filter(e => e.severity === 'error').length
  const warningN = errors.length - errorN

  // ⌘1 / ⌘2, and ⌘F, which shows the Browser tab and puts the cursor in
  // its filter box.
  useEffect(() => {
    const onKey = (e) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return
      if (e.key === 'f' || e.key === 'F') {
        e.preventDefault()
        useOrmStore.getState().showSidebarTab('browser', { toggle: false })
        requestAnimationFrame(() => requestAnimationFrame(() => {
          const input = document.querySelector('[data-browser-filter]')
          input?.focus(); input?.select()
        }))
        return
      }
      const t = TABS.find(t => t.key === e.key)
      if (!t) return
      e.preventDefault()
      useOrmStore.getState().showSidebarTab(t.id)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // Width by dragging the splitter on the right edge.
  const [dragW, setDragW] = useState(null)
  const dragRef = useRef(null)
  const onResizeMouseDown = (e) => {
    if (e.button !== 0) return
    e.preventDefault()
    dragRef.current = { startX: e.clientX, startW: width }
    setDragW(width)
    document.body.style.cursor = 'ew-resize'
    const onMove = (me) => {
      const d = dragRef.current
      if (d) setDragW(Math.max(MIN_W, Math.min(MAX_W, d.startW + me.clientX - d.startX)))
    }
    const onUp = (me) => {
      const d = dragRef.current
      dragRef.current = null
      document.body.style.cursor = ''
      setDragW(null)
      if (d) useOrmStore.getState().setSidebar({ width: Math.max(MIN_W, Math.min(MAX_W, d.startW + me.clientX - d.startX)) })
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  const count = (id) => id !== 'problems' || !errors.length ? null
    : <Count n={errors.length} colour={errorN ? 'var(--danger)' : '#d97706'}
        title={`${errorN} error${errorN !== 1 ? 's' : ''}, ${warningN} warning${warningN !== 1 ? 's' : ''}`} />

  if (!open) {
    return (
      <div className="no-print" style={{ width: RAIL, flexShrink: 0, display: 'flex', flexDirection: 'column',
        alignItems: 'center', gap: 4, paddingTop: 6, fontFamily: FONT, userSelect: 'none',
        background: 'var(--bg-raised)', borderRight: '1px solid var(--border)' }}>
        <button onClick={() => store.setSidebar({ open: true })} title="Show the sidebar"
          style={railBtn}>»</button>
        {TABS.map(t => (
          <button key={t.id} onClick={() => store.showSidebarTab(t.id)}
            title={`${t.title} (${modKey()}${t.key})`}
            style={{ ...railBtn, writingMode: 'vertical-rl', padding: '8px 0', fontSize: 11,
              display: 'flex', alignItems: 'center', gap: 5, color: 'var(--ink-2)' }}>
            {t.label}{count(t.id)}
          </button>
        ))}
      </div>
    )
  }

  return (
    <div className="no-print" style={{ width: dragW ?? width, flexShrink: 0, display: 'flex',
      background: 'var(--bg-surface)', borderRight: '1px solid var(--border)', fontFamily: FONT }}>
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
        <div role="tablist" style={{ display: 'flex', alignItems: 'stretch', height: 28, flexShrink: 0,
          background: 'var(--bg-raised)', borderBottom: '1px solid var(--border)', userSelect: 'none' }}>
          {TABS.map(t => {
            const on = tab === t.id
            return (
              <button key={t.id} role="tab" aria-selected={on}
                onClick={() => store.setSidebar({ tab: t.id })}
                title={`${t.title} (${modKey()}${t.key})`}
                style={{ border: 'none', cursor: 'pointer', fontFamily: FONT, fontSize: 12,
                  padding: '0 12px', display: 'flex', alignItems: 'center', gap: 6,
                  background: on ? 'var(--bg-surface)' : 'transparent',
                  color: on ? 'var(--ink-1)' : 'var(--ink-muted)', fontWeight: on ? 600 : 400,
                  borderBottom: on ? '2px solid var(--accent)' : '2px solid transparent', marginBottom: -1 }}>
                {t.label}{count(t.id)}
              </button>
            )
          })}
          <div style={{ flex: 1 }} />
          <button onClick={() => store.setSidebar({ open: false })} title="Hide the sidebar"
            style={{ ...railBtn, width: 26 }}>«</button>
        </div>
        <div style={{ flex: 1, minHeight: 0 }}>
          {tab === 'problems' ? <ValidationPanel /> : <SchemaBrowser />}
        </div>
      </div>
      <Splitter orientation="v" dragging={dragW != null} onMouseDown={onResizeMouseDown} />
    </div>
  )
}

function Count({ n, colour, title }) {
  return (
    <span title={title} style={{ background: colour, color: 'white', borderRadius: 8, fontSize: 10,
      fontWeight: 600, padding: '0 5px', lineHeight: '15px', minWidth: 15, textAlign: 'center' }}>{n}</span>
  )
}

const railBtn = {
  background: 'none', border: 'none', cursor: 'pointer', fontFamily: FONT,
  fontSize: 13, lineHeight: 1, color: 'var(--ink-muted)', padding: 0,
}

const modKey = () => (/Mac/.test(navigator.platform) ? '⌘' : 'Ctrl+')
