import React, { useEffect, useMemo, useRef, useState } from 'react'
import { formalise } from '../logic/constraintFormulas.js'
import { compileLanguage } from '../verbalisation/rules.js'
import { verbalise } from '../verbalisation/engine.js'
import { channel, readUserRules, writeUserRules, languageInfo, useLanguageChoice, LANGUAGES } from '../verbalisation/workbench.js'
import { Formula, SENTENCE_STYLE } from './ConstraintsTab.jsx'

// ── Verbalisation workbench ─────────────────────────────────────────────────
// A window of its own (#workbench) for editing a language's rules: the rule
// file on the left, and on the right every constraint of the open model with
// its sentence under the edited rules, the rules that built it, and, where
// the edit changes it, the sentence under the rules in use. Apply makes the
// edited rules the ones the Constraints tab uses.

const LINE_HEIGHT = 18

export default function Workbench() {
  const [model, setModel] = useState(null)
  const [langId, setLangId] = useLanguageChoice()
  const info = languageInfo(langId)
  const appliedOf = (id) => readUserRules(id) ?? languageInfo(id).rules
  const [applied, setApplied] = useState(() => appliedOf(langId))
  const [draft, setDraftText] = useState(applied)
  const [compiled, setCompiled] = useState(() => compile(applied, info))
  // Unapplied edits per language, kept while switching languages.
  const drafts = useRef({})
  const setDraft = (text) => { drafts.current[langId] = text; setDraftText(text) }
  const switchLanguage = (id) => {
    setLangId(id)
    const a = appliedOf(id)
    setApplied(a)
    setDraftText(drafts.current[id] ?? a)
  }
  const [search, setSearch] = useState('')
  const [changedOnly, setChangedOnly] = useState(false)
  const editor = useRef(null)

  useEffect(() => { document.title = 'Verbalisation Workbench' }, [])

  const appliedRef = useRef(null)
  appliedRef.current = () => appliedOf(langId)

  // Ask the main window for the model, and follow its changes and the rules
  // applied from elsewhere.
  useEffect(() => {
    const ch = channel()
    const off = ch.on(m => {
      if (m?.type === 'model') setModel(m.state)
      else if (m?.type === 'rules') setApplied(appliedRef.current())
    })
    ch.post({ type: 'hello' })
    const bye = () => ch.post({ type: 'bye' })
    window.addEventListener('beforeunload', bye)
    return () => { off(); bye(); window.removeEventListener('beforeunload', bye) }
  }, [])

  // Recompile shortly after typing stops.
  useEffect(() => {
    const t = setTimeout(() => setCompiled(compile(draft, info)), 150)
    return () => clearTimeout(t)
  }, [draft, info])

  const appliedLanguage = useMemo(() => compile(applied, info).language, [applied, info])

  const all = useMemo(() => {
    if (!model) return null
    const { entries, implicit, ctx } = formalise(model, { wholeSchema: true })
    return { ctx, entries: [...entries.flat(), ...implicit.disjointness, ...implicit.participation, ...implicit.impliedLinks]
      .filter(e => e.formula) }
  }, [model])

  const rows = useMemo(() => {
    if (!all) return []
    return all.entries.map(e => {
      const now = run(e.formula, all.ctx, compiled.language)
      const before = compiled.text === applied ? now : run(e.formula, all.ctx, appliedLanguage)
      return { e, now, before, changed: now.text !== before.text }
    })
  }, [all, compiled, applied, appliedLanguage])

  const q = search.trim().toLowerCase()
  const shown = rows.filter(r => (!changedOnly || r.changed) &&
    (!q || `${r.e.kind} ${r.e.subject ?? ''} ${r.now.text ?? ''} ${r.now.trace?.join(' ') ?? ''}`.toLowerCase().includes(q)))
  const changedCount = rows.filter(r => r.changed).length
  const isBuiltIn = applied === info.rules
  const fileName = info.file

  // Moves the editor to a line, selecting it.
  const goToLine = (line) => {
    const ta = editor.current
    if (!ta || !line) return
    const lines = ta.value.split('\n')
    const start = lines.slice(0, line - 1).reduce((n, l) => n + l.length + 1, 0)
    ta.focus()
    ta.setSelectionRange(start, start + (lines[line - 1]?.length ?? 0))
    ta.scrollTop = Math.max(0, (line - 4) * LINE_HEIGHT)
  }
  const ruleLine = (step) => {
    const [kind, name] = step.split(': ')
    return compiled.language?.rules[kind]?.find(r => r.name === name)?.line
  }

  const importRules = async () => {
    const api = window.electronAPI
    if (api?.openRules) {
      const f = await api.openRules()
      if (f) setDraft(f.content)
      return
    }
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.vr,text/plain'
    input.onchange = async () => { if (input.files[0]) setDraft(await input.files[0].text()) }
    input.click()
  }
  const exportRules = async () => {
    const api = window.electronAPI
    if (api?.saveRules) { await api.saveRules({ defaultPath: fileName, content: draft }); return }
    const a = document.createElement('a')
    a.href = URL.createObjectURL(new Blob([draft], { type: 'text/plain' }))
    a.download = fileName
    a.click()
    URL.revokeObjectURL(a.href)
  }

  const error = compiled.error
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', background: 'var(--bg-canvas)', color: 'var(--ink)' }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', padding: '8px 12px',
        borderBottom: '1px solid var(--border-soft)', background: 'var(--bg-surface)', fontSize: 12,
      }}>
        <select value={langId} onChange={e => switchLanguage(e.target.value)} title="The language whose rules you edit"
          style={{ fontSize: 12, fontWeight: 600 }}>
          {LANGUAGES.map(l => <option key={l.id} value={l.id}>{l.label}</option>)}
        </select>
        <strong style={{ fontSize: 13 }}>rules</strong>
        <span style={{ color: 'var(--ink-muted)' }}>
          {isBuiltIn ? 'In use: the built-in rules' : 'In use: your rules'}
          {draft !== applied && ' · edited, not applied yet'}
        </span>
        <span style={{ flex: 1 }} />
        <Button onClick={() => { writeUserRules(langId, draft); setApplied(draft) }}
          disabled={!!error || draft === applied} primary
          title="Use these rules in the Constraints tab">Apply</Button>
        <Button onClick={() => setDraft(applied)} disabled={draft === applied}
          title="Go back to the rules in use">Revert</Button>
        <Button onClick={() => setDraft(info.rules)} disabled={draft === info.rules}
          title="Load the built-in rules into the editor (Apply to use them again)">Built-in rules</Button>
        <Button onClick={importRules} title="Load rules from a .vr file">Import…</Button>
        <Button onClick={exportRules} title="Save these rules as a .vr file">Export…</Button>
      </div>

      <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
        <div style={{ flex: '1 1 50%', display: 'flex', flexDirection: 'column', minWidth: 0, borderRight: '1px solid var(--border-soft)' }}>
          <Editor value={draft} onChange={setDraft} errorLine={error?.line} textarea={editor} />
          <div style={{
            padding: '5px 12px', fontSize: 11, borderTop: '1px solid var(--border-soft)',
            background: error ? 'rgba(192,57,43,0.08)' : 'var(--bg-surface)',
            color: error ? 'var(--danger)' : 'var(--ink-3)',
          }}>
            {error
              ? <span style={{ cursor: error.line ? 'pointer' : 'default' }} onClick={() => goToLine(error.line)}>
                  {error.line ? `Line ${error.line}, column ${error.col}: ` : ''}{error.reason}
                </span>
              : `${ruleCount(compiled.language)} rules · no errors`}
          </div>
        </div>

        <div style={{ flex: '1 1 50%', display: 'flex', flexDirection: 'column', minWidth: 0 }}>
          <div style={{
            display: 'flex', alignItems: 'center', gap: 10, padding: '6px 12px', fontSize: 11,
            borderBottom: '1px solid var(--border-soft)', color: 'var(--ink-2)',
          }}>
            <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Filter by text or rule name"
              style={{ flex: 1, fontSize: 11, padding: '3px 6px', border: '1px solid var(--border-soft)', borderRadius: 4, background: 'var(--bg-text-panel)' }} />
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: 4, userSelect: 'none' }}>
              <input type="checkbox" checked={changedOnly} onChange={e => setChangedOnly(e.target.checked)} />
              Changed only
            </label>
            <span style={{ color: 'var(--ink-muted)' }}>
              {all ? `${shown.length} of ${rows.length} · ${changedCount} changed by your edit` : ''}
            </span>
          </div>
          <div className="text-panel" style={{ flex: 1, overflow: 'auto', padding: '8px 12px' }}>
            {!all && <div style={{ fontSize: 12, color: 'var(--ink-muted)', fontStyle: 'italic' }}>
              Waiting for the model from the main window…</div>}
            {all && shown.map(r => <Row key={r.e.key} r={r} ctx={all.ctx} onRule={(s) => goToLine(ruleLine(s))} />)}
            {all && !shown.length && <div style={{ fontSize: 12, color: 'var(--ink-muted)', fontStyle: 'italic' }}>
              {changedOnly ? 'Your edit changes no sentence.' : 'Nothing matches the filter.'}</div>}
          </div>
        </div>
      </div>
    </div>
  )
}

// { text, language, error: { reason, line, col } | null }
function compile(text, info) {
  try { return { text, language: compileLanguage(text, info.library), error: null } }
  catch (err) { return { text, language: null, error: { reason: err.reason ?? err.message, line: err.line, col: err.col } } }
}

function run(formula, ctx, language) {
  if (!language) return { text: null, tokens: null, trace: [], error: 'The rules have an error' }
  try { return verbalise(formula, ctx, language) } catch (err) { return { text: null, tokens: null, trace: [], error: err.message } }
}

const ruleCount = (lang) => Object.values(lang?.rules ?? {}).reduce((n, rs) => n + rs.length, 0)

function Row({ r, ctx, onRule }) {
  const { e, now, before, changed } = r
  return (
    <div style={{
      marginBottom: 12, paddingLeft: 8,
      borderLeft: `3px solid ${changed ? 'var(--accent)' : 'transparent'}`,
    }}>
      <div style={{ fontSize: 10, color: 'var(--ink-muted)', letterSpacing: '0.04em', marginBottom: 2 }}>
        {e.kind}{e.subject ? ` · ${e.subject}` : ''}
      </div>
      <Tokens result={now} />
      {changed && (
        <div style={{ fontSize: 12, color: 'var(--ink-muted)', textDecoration: 'line-through', marginTop: 1 }}
          title="The sentence under the rules in use">{before.text ?? before.error}</div>
      )}
      <div style={{ opacity: 0.7, fontSize: 11, margin: '2px 0' }}><Formula formula={e.formula} ctx={ctx} /></div>
      <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--ink-3)' }}>
        {now.trace.map((s, i) => (
          <React.Fragment key={i}>
            {i > 0 && ' › '}
            <span onClick={() => onRule(s)} title="Show this rule" style={{ cursor: 'pointer', textDecoration: 'underline dotted' }}>{s}</span>
          </React.Fragment>
        ))}
      </div>
    </div>
  )
}

function Tokens({ result }) {
  if (!result.tokens) {
    return <div style={{ fontSize: 12, color: 'var(--danger)', fontStyle: 'italic' }}>No verbalisation: {result.error}</div>
  }
  return (
    <div style={{ fontSize: 13, lineHeight: 1.5, whiteSpace: 'pre-wrap', userSelect: 'text' }}>
      {result.tokens.map((t, i) => (
        <React.Fragment key={i}>{t.space ? ' ' : ''}<span style={SENTENCE_STYLE[t.cls]}>{t.text}</span></React.Fragment>
      ))}
    </div>
  )
}

// A plain text editor with line numbers; Tab indents with two spaces.
function Editor({ value, onChange, errorLine, textarea }) {
  const gutter = useRef(null)
  const lines = value.split('\n').length
  const onKeyDown = (e) => {
    if (e.key !== 'Tab') return
    e.preventDefault()
    const ta = e.target
    const { selectionStart: a, selectionEnd: b } = ta
    const next = value.slice(0, a) + '  ' + value.slice(b)
    onChange(next)
    requestAnimationFrame(() => ta.setSelectionRange(a + 2, a + 2))
  }
  const font = { fontFamily: 'var(--font-mono)', fontSize: 12, lineHeight: `${LINE_HEIGHT}px` }
  return (
    <div style={{ flex: 1, display: 'flex', minHeight: 0, background: 'var(--bg-text-panel)' }}>
      <div ref={gutter} style={{
        ...font, overflow: 'hidden', padding: '8px 6px 8px 8px', textAlign: 'right', userSelect: 'none',
        color: 'var(--ink-muted)', background: 'var(--bg-surface)', borderRight: '1px solid var(--border-soft)', minWidth: 34,
      }}>
        {Array.from({ length: lines }, (_, i) => (
          <div key={i} style={i + 1 === errorLine ? { color: '#fff', background: 'var(--danger)', borderRadius: 2, padding: '0 2px' } : undefined}>{i + 1}</div>
        ))}
      </div>
      <textarea ref={textarea} value={value} spellCheck={false} wrap="off"
        onChange={e => onChange(e.target.value)} onKeyDown={onKeyDown}
        onScroll={e => { if (gutter.current) gutter.current.scrollTop = e.target.scrollTop }}
        style={{
          ...font, flex: 1, resize: 'none', border: 'none', outline: 'none', padding: 8,
          background: 'transparent', color: 'var(--ink)', whiteSpace: 'pre', overflow: 'auto', tabSize: 2,
        }} />
    </div>
  )
}

function Button({ children, onClick, disabled, primary, title }) {
  return (
    <button type="button" onClick={onClick} disabled={disabled} title={title} style={{
      fontSize: 11, padding: '3px 10px', borderRadius: 4, cursor: disabled ? 'default' : 'pointer',
      border: `1px solid ${primary && !disabled ? 'var(--accent)' : 'var(--border)'}`,
      background: primary && !disabled ? 'var(--accent)' : 'var(--bg-raised)',
      color: primary && !disabled ? '#fff' : disabled ? 'var(--ink-muted)' : 'var(--ink-2)',
      opacity: disabled ? 0.6 : 1,
    }}>{children}</button>
  )
}
