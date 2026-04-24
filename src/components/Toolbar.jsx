import React, { useRef } from 'react'
import { useOrmStore } from '../store/ormStore'
import { triggerPdfExport } from '../utils/pdfExport'

const isElectron = typeof window !== 'undefined' && !!window.electronAPI
const isMac = typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform)

// Defined at module level so their identity is stable across Toolbar re-renders.
// Defining components inside a parent component causes React to unmount+remount
// them on every parent re-render, which breaks in-progress click events.
function Btn({ label, title, active, onClick, disabled = false }) {
  return (
    <button title={title} onClick={disabled ? undefined : onClick} style={{
      padding: '5px 11px', fontSize: 12,
      background: active ? 'var(--accent)' : 'var(--bg-raised)',
      color: active ? '#fff' : disabled ? 'var(--ink-muted)' : 'var(--ink-2)',
      border: `1px solid ${active ? 'var(--accent)' : 'var(--border)'}`,
      borderRadius: 4, fontFamily: 'var(--font-mono)',
      cursor: disabled ? 'not-allowed' : 'pointer',
      opacity: disabled ? 0.45 : 1,
      transition: 'all 0.12s', whiteSpace: 'nowrap',
    }}
    onMouseEnter={e => { if (!active && !disabled) e.currentTarget.style.borderColor = 'var(--border-dark)' }}
    onMouseLeave={e => { if (!active && !disabled) e.currentTarget.style.borderColor = 'var(--border)' }}
    >{label}</button>
  )
}

function Divider() {
  return <div style={{ width: 1, height: 20, background: 'var(--border-soft)', margin: '0 4px' }}/>
}

export default function Toolbar() {
  const storeRef = useRef(null)
  storeRef.current = useOrmStore()

  // Read from ref inside handlers so we always get current state.
  const store = () => storeRef.current

  const handleNew = () => {
    if (store().isDirty && !confirm('Discard unsaved changes?')) return
    store().newModel()
  }

  const handleOpen = async () => {
    if (!isElectron) return
    const result = await window.electronAPI.openFile()
    if (!result) return
    try { store().loadModel(result.content, result.path) }
    catch { alert('Failed to parse model file.') }
  }

  const handleSave = async () => {
    if (!isElectron) return
    try {
      const s = store()
      const content = s.serialize()
      const fp = await window.electronAPI.saveFile({ defaultPath: s.filePath || 'model.orm2', content })
      if (fp) { store().setFilePath(fp); store().markClean() }
    } catch (err) {
      alert(`Save failed: ${err.message}`)
    }
  }

  const handleExportPdf = () => triggerPdfExport(store())

  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 5,
      padding: '6px 14px',
      paddingLeft: isMac ? 80 : 14,
      flexShrink: 0,
      background: 'var(--bg-surface)',
      borderBottom: '1px solid var(--border-soft)',
      WebkitAppRegion: 'drag',
    }}>
      <span style={{ fontFamily: 'var(--font-display)', fontWeight: 600, fontSize: 24,
        marginRight: 8, letterSpacing: '0.02em',
        WebkitAppRegion: 'drag', userSelect: 'none',
        WebkitTextStroke: '1px #7c4dbd', WebkitTextFillColor: 'black' }}>
        Factum
      </span>

      <Divider/>

      <div style={{ display: 'flex', gap: 4, WebkitAppRegion: 'no-drag' }}>
        <Btn label="＋ New"   title="New Model"  onClick={handleNew}/>
        {isElectron && <Btn label="📂 Open" title="Open"   onClick={handleOpen}/>}
        {isElectron && <Btn label={`💾 Save${storeRef.current.isDirty ? ' *' : ''}`} title="Save" onClick={handleSave}/>}
        {isElectron && <Btn label="⎙ PDF" title="Export to PDF (⌘⇧E)" onClick={handleExportPdf}/>}
      </div>

      <div style={{ flex: 1 }}/>

      <div style={{ display: 'flex', gap: 4, alignItems: 'center', WebkitAppRegion: 'no-drag' }}>
        <Btn label="−" title="Zoom Out" onClick={() => store().zoomBy(-0.1)}/>
        <span style={{ fontSize: 11, color: 'var(--ink-muted)', minWidth: 38, textAlign: 'center' }}>
          {Math.round(storeRef.current.zoom * 100)}%
        </span>
        <Btn label="+" title="Zoom In" onClick={() => store().zoomBy(0.1)}/>
        <Btn label="⊡" title="Reset View" onClick={() => store().resetView()}/>
      </div>
    </div>
  )
}
