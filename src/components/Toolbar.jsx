import React, { useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useOrmStore, useOrmStoreIgnoring } from '../store/ormStore'
import { triggerPdfExport } from '../utils/pdfExport'
import { openModelFile } from '../import/openModelFile'
import { LANGUAGES } from '../verbalisation/languages/index.js'
import { BASE_LANGUAGE, modelLanguages } from '../store/viewLanguage.js'

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

const selectStyle = (highlight) => ({
  fontSize: 12, padding: '4px 6px', borderRadius: 4, fontFamily: 'var(--font-mono)', cursor: 'pointer',
  border: `1px solid ${highlight ? 'var(--accent)' : 'var(--border)'}`,
  background: highlight ? 'var(--accent)' : 'var(--bg-raised)',
  color: highlight ? '#fff' : 'var(--ink-2)',
})

// The language the model is shown in. A model in one language shows only a
// button to add another; with more, a menu switches between them. The
// switch stands out while the model is shown in another language than its
// own (the base language).
function LanguageSwitch() {
  const state = useOrmStore(useShallow(s => ({ objectTypes: s.objectTypes, facts: s.facts, languages: s.languages, viewLanguage: s.viewLanguage })))
  const setViewLanguage = useOrmStore(s => s.setViewLanguage)
  const addLanguage = useOrmStore(s => s.addLanguage)
  const [adding, setAdding] = useState(false)
  const langs = modelLanguages(state, LANGUAGES)
  const others = LANGUAGES.filter(l => !langs.includes(l))
  const label = (l) => l.id === BASE_LANGUAGE ? `${l.label} (model language)` : l.label

  if (adding) {
    return (
      <select autoFocus value="" style={selectStyle(false)} title="Add a language to show and edit the model in"
        onChange={e => { setAdding(false); if (e.target.value) addLanguage(e.target.value) }}
        onBlur={() => setAdding(false)}
        onKeyDown={e => { if (e.key === 'Escape') setAdding(false) }}>
        <option value="">Add language…</option>
        {others.map(l => <option key={l.id} value={l.id}>{l.label}</option>)}
      </select>
    )
  }
  if (langs.length < 2) {
    return others.length ? <Btn label="🌐" title="Add a language to show and edit the model in" onClick={() => setAdding(true)}/> : null
  }
  const away = state.viewLanguage !== BASE_LANGUAGE
  return (
    <select value={state.viewLanguage} style={selectStyle(away)}
      title={away ? `Shown in ${LANGUAGES.find(l => l.id === state.viewLanguage)?.label}; the model's own language is ${LANGUAGES.find(l => l.id === BASE_LANGUAGE)?.label}`
        : 'Language the names, readings and sentences are shown in'}
      onChange={e => e.target.value === '+' ? setAdding(true) : setViewLanguage(e.target.value)}>
      {langs.map(l => <option key={l.id} value={l.id}>🌐 {label(l)}</option>)}
      {others.length > 0 && <option value="+">Add language…</option>}
    </select>
  )
}

export default function Toolbar() {
  const storeRef = useRef(null)
  storeRef.current = useOrmStoreIgnoring('pan')

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
    try { openModelFile(result) }
    catch (err) { alert(`Failed to open model file.${err?.message ? `\n${err.message}` : ''}`) }
  }

  const handleSave = async () => {
    if (!isElectron) return
    try {
      const s = store()
      const content = s.serialize()
      const fp = await window.electronAPI.saveFile({ defaultPath: s.filePath || s.importLog?.source || 'model.ffbm', content })
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
        color: 'var(--accent)' }}>
        FreeFBM
      </span>

      <Divider/>

      <div style={{ display: 'flex', gap: 4, WebkitAppRegion: 'no-drag' }}>
        <Btn label="＋ New"   title="New Model"  onClick={handleNew}/>
        {isElectron && <Btn label="📂 Open" title="Open"   onClick={handleOpen}/>}
        {isElectron && <Btn label={`💾 Save${storeRef.current.isDirty ? ' *' : ''}`} title="Save" onClick={handleSave}/>}
        {isElectron && <Btn label="⎙ PDF" title="Export to PDF (⌘⇧E)" onClick={handleExportPdf}/>}
      </div>

      <div style={{ flex: 1 }}/>

      <div style={{ display: 'flex', alignItems: 'center', WebkitAppRegion: 'no-drag', marginRight: 8 }}>
        <LanguageSwitch/>
      </div>

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
