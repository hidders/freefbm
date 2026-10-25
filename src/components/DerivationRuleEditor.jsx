import React, { useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { useShallow } from 'zustand/react/shallow'
import { useOrmStore } from '../store/ormStore'
import { makeContext, readingText } from '../logic/constraintFormulas.js'
import {
  SUBJECT, hole, getAt, setAt, directSupertypes, typeGraph, allTypeOptions,
  ruleVariables, checkRule, derivationEntry, derivationHeading,
} from '../logic/derivationRule.js'
import { QGAP } from '../logic/renderFormula.js'
import { TOKEN_STYLE, Formula } from './FormalisationTab.jsx'

// ── Derivation rule editor ──────────────────────────────────────────────────
// A syntax-directed editor for the derivation rule of a derived or
// semi-derived subtype (see src/logic/derivationRule.js). The formula is shown
// with holes (□) for the parts not filled in yet; clicking a part selects it,
// and the panel below offers what can go there. Variables in atoms are picked
// from the variables in scope, and the types and fact types from the schema.

const ATOMIC = new Set(['fact', 'type', 'true', 'not', 'hole'])
const BINARY = new Set(['and', 'or', 'implies', 'iff'])
const QUANT = new Set(['forall', 'exists', 'count'])
const OP = { and: ' ∧ ', or: ' ∨ ', implies: ' → ', iff: ' ↔ ' }
const VALUE_OPS = ['≈', '≉', '<', '≤', '>', '≥']
const COUNT_OPS = ['≤', '≥', '=']

const newVarId = () => `v${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
const keyOf = (path) => path.join('.')
const samePath = (a, b) => keyOf(a) === keyOf(b)

export default function DerivationRuleEditor({ otId, onClose }) {
  const state = useOrmStore(useShallow(s => ({
    objectTypes: s.objectTypes, facts: s.facts, subtypes: s.subtypes, constraints: s.constraints,
  })))
  const updateObjectType = useOrmStore(s => s.updateObjectType)
  const ot = state.objectTypes.find(o => o.id === otId)
  const [draft, setDraft] = useState(() => ot?.derivationRule ?? hole())
  const [sel, setSel] = useState([])

  const ctx = useMemo(() => makeContext(state), [state])
  const graph = useMemo(() => typeGraph(state), [state])
  const supers = useMemo(() => directSupertypes(otId, state.subtypes), [otId, state.subtypes])
  const { nameOf } = useMemo(() => ruleVariables(draft, supers, ctx), [draft, supers, ctx])
  const issues = useMemo(() => checkRule(draft, otId, state, ctx), [draft, otId, state, ctx])
  const severityAt = useMemo(() => {
    const m = new Map()
    for (const i of issues) if (m.get(keyOf(i.path)) !== 'error') m.set(keyOf(i.path), i.severity)
    return m
  }, [issues])
  const errors = issues.filter(i => i.severity === 'error')
  const preview = useMemo(() => (ot && !errors.length
    ? derivationEntry({ ...ot, derivationRule: draft }, state, ctx) : null), [ot, draft, state, ctx, errors.length])

  if (!ot) return null
  const changed = JSON.stringify(draft) !== JSON.stringify(ot.derivationRule ?? hole())

  const replace = (path, node, nextSel = path) => { setDraft(d => setAt(d, path, node)); setSel(nextSel) }
  const save = () => { updateObjectType(otId, { derivationRule: draft }); onClose() }

  const onKeyDown = (e) => {
    // Keep the canvas shortcuts (delete, tools, arrows) out of the dialog.
    e.stopPropagation()
    if (e.key === 'Escape') { e.preventDefault(); onClose(); return }
    const typing = /^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName)
    if (!typing && (e.key === 'Delete' || e.key === 'Backspace')) {
      e.preventDefault()
      if (getAt(draft, sel)?.t !== 'hole') replace(sel, hole())
    }
  }

  // Scope at a path, for the variable pickers: the subject, then the
  // variable of every quantifier above it.
  const scopeAt = (path) => {
    const out = [{ id: SUBJECT, typeIds: supers }]
    let n = draft
    for (const k of path) {
      if (QUANT.has(n?.t) && k === 'body') out.push({ id: n.v.id, typeIds: [n.v.typeId] })
      n = n?.[k]
    }
    return out
  }

  // ── Formula view ──
  const varPicker = (path, value, scope, placeId, onChange) => (
    <VarSelect value={value} scope={scope} nameOf={nameOf} graph={graph} placeId={placeId}
      ctx={ctx} onChange={onChange} onFocus={() => setSel(path)} />
  )

  const render = (n, path, scope) => {
    const selected = samePath(path, sel)
    const sev = severityAt.get(keyOf(path))
    const wrapStyle = {
      borderRadius: 3, cursor: 'pointer', padding: '0 1px',
      background: selected ? 'var(--selection)' : undefined,
      outline: selected ? '1px solid var(--accent)' : undefined,
      textDecoration: sev && n.t !== 'hole' ? `underline wavy ${sev === 'error' ? 'var(--danger)' : '#d97706'}` : undefined,
      textUnderlineOffset: 3,
    }
    const click = (e) => { e.stopPropagation(); setSel(path) }
    const sub = (key, wrap) => {
      const p = [...path, ...(Array.isArray(key) ? key : [key])]
      const child = getAt(draft, p)
      const inner = render(child, p, scope)
      return wrap ? <>{'('}{inner}{')'}</> : inner
    }
    let body
    switch (n?.t) {
      case 'hole': case undefined:
        body = <span style={{ color: 'var(--danger)', fontWeight: 600 }} title="Not filled in yet">□</span>
        break
      case 'true':
        body = <span style={TOKEN_STYLE.op}>⊤</span>
        break
      case 'not':
        body = <><span style={TOKEN_STYLE.op}>¬</span>{sub('arg', !ATOMIC.has(n.arg?.t))}</>
        break
      case 'and': case 'or':
        body = n.args.map((a, i) => (
          <React.Fragment key={i}>
            {i > 0 && <span style={TOKEN_STYLE.op}>{OP[n.t]}</span>}
            {sub(['args', i], BINARY.has(a?.t) || (QUANT.has(a?.t) && i < n.args.length - 1))}
          </React.Fragment>
        ))
        break
      case 'implies': case 'iff':
        body = <>
          {sub('left', BINARY.has(n.left?.t) || QUANT.has(n.left?.t))}
          <span style={TOKEN_STYLE.op}>{OP[n.t]}</span>
          {sub('right', BINARY.has(n.right?.t))}
        </>
        break
      case 'forall': case 'exists': case 'count': {
        const inner = [...scope, { id: n.v.id, typeIds: [n.v.typeId] }]
        const p = [...path, 'body']
        const b = render(n.body, p, inner)
        const wrapBody = !(ATOMIC.has(n.body?.t) || QUANT.has(n.body?.t))
        body = <>
          <span style={TOKEN_STYLE.op}>{n.t === 'forall' ? '∀' : '∃'}</span>
          {n.t === 'count' && <sup style={{ ...TOKEN_STYLE.op, fontSize: '0.75em' }}>{n.op}{n.n}</sup>}
          <span style={TOKEN_STYLE.qgap}>{QGAP}</span>
          <span style={TOKEN_STYLE.var} title={`ranges over ${ctx.typeName(n.v.typeId)}`}>{nameOf.get(n.v.id)}</span>
          {' '}{wrapBody ? <>{'('}{b}{')'}</> : b}
        </>
        break
      }
      case 'fact': {
        const fact = ctx.factById.get(n.factId)
        const parts = fact?.readingParts ?? []
        const words = []
        fact?.roles.forEach((r, i) => {
          if (parts[i]?.trim()) words.push(<span key={`p${i}`} style={TOKEN_STYLE.reading}>{parts[i].trim()}</span>)
          words.push(<React.Fragment key={`v${i}`}>{varPicker(path, n.args[i], scope, r.objectTypeId,
            (id) => replace(path, { ...n, args: n.args.map((a, j) => (j === i ? id : a)) }))}</React.Fragment>)
        })
        const last = fact?.roles.length ?? 0
        if (parts[last]?.trim()) words.push(<span key="end" style={TOKEN_STYLE.reading}>{parts[last].trim()}</span>)
        body = <>{'('}{words.map((w, i) => <React.Fragment key={i}>{i > 0 && ' '}{w}</React.Fragment>)}{')'}</>
        break
      }
      case 'type':
        body = <>
          <span style={TOKEN_STYLE.type}>{ctx.typeName(n.typeId)}</span>{'('}
          {varPicker(path, n.arg, scope, null, (id) => replace(path, { ...n, arg: id }))}{')'}
        </>
        break
      case 'cmp':
        body = <>
          {varPicker(path, n.left, scope, null, (id) => replace(path, { ...n, left: id }))}
          <OpSelect value={n.op} ops={['=', '≠']} onChange={(op) => replace(path, { ...n, op })} />
          {varPicker(path, n.right, scope, null, (id) => replace(path, { ...n, right: id }))}
        </>
        break
      case 'vcmp':
        body = <>
          {varPicker(path, n.left, scope, null, (id) => replace(path, { ...n, left: id }))}
          <OpSelect value={n.op} ops={VALUE_OPS} onChange={(op) => replace(path, { ...n, op })} />
          {'const' in n.right
            ? <ConstInput value={n.right.const} onFocus={() => setSel(path)}
                onChange={(text) => replace(path, { ...n, right: { const: text } })} />
            : varPicker(path, n.right.var, scope, null, (id) => replace(path, { ...n, right: { var: id } }))}
        </>
        break
      default:
        body = '?'
    }
    return <span onClick={click} style={wrapStyle}>{body}</span>
  }

  const selNode = getAt(draft, sel)
  const selScope = scopeAt(sel)

  return createPortal(
    <div onKeyDown={onKeyDown} onMouseDown={e => e.stopPropagation()} style={{
      position: 'fixed', inset: 0, background: 'rgba(26,22,18,0.28)', zIndex: 1000,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
    }}>
      <div role="dialog" aria-label="Derivation rule" tabIndex={-1} style={{
        width: 'min(920px, 94vw)', maxHeight: '88vh', display: 'flex', flexDirection: 'column',
        background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius)',
        boxShadow: 'var(--shadow-lg)', overflow: 'hidden',
      }}>
        <div style={{ padding: '10px 14px', borderBottom: '1px solid var(--border-soft)' }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--ink)' }}>
            {ot.derivation === 'semiDerived' ? 'Semi-derivation rule' : 'Derivation rule'} of {ot.name || 'Unnamed'}
          </div>
          <div style={{ fontSize: 11, color: 'var(--ink-muted)', marginTop: 2 }}>
            {supers.length ? derivationHeading(ot, supers, ctx) : `${ot.name} has no supertype, so it cannot be derived.`}
          </div>
        </div>

        <div style={{ padding: 14, overflow: 'auto', flex: 1 }}>
          <div tabIndex={0} onClick={() => setSel([])} className="text-panel" style={{
            fontFamily: 'var(--font-mono)', fontSize: 13, lineHeight: 2, minHeight: 44, outline: 'none',
          }}>
            {render(draft, [], [{ id: SUBJECT, typeIds: supers }])}
          </div>

          <Palette node={selNode} path={sel} scope={selScope} draft={draft} state={state} ctx={ctx} supers={supers}
            graph={graph} replace={replace} />

          <div style={{ marginTop: 12 }}>
            {issues.length === 0
              ? <div style={{ fontSize: 12, color: 'var(--col-candidate)' }}>✓ This is a valid derivation rule.</div>
              : issues.map((i, k) => (
                <div key={k} onClick={() => setSel(i.path)} style={{
                  display: 'flex', gap: 6, fontSize: 12, cursor: 'pointer', marginBottom: 2,
                  color: i.severity === 'error' ? 'var(--danger)' : '#b45309',
                }}>
                  <span style={{ fontWeight: 700 }}>{i.severity === 'error' ? '✕' : '!'}</span>
                  <span>{i.message}</span>
                </div>
              ))}
          </div>

          {preview?.formula && (
            <div style={{ marginTop: 12 }}>
              <div style={{ fontSize: 10, color: 'var(--ink-muted)', letterSpacing: '0.04em', marginBottom: 2 }}>
                As shown in the Formalisation panel
              </div>
              <div className="text-panel"><Formula formula={preview.formula} ctx={ctx} /></div>
            </div>
          )}
        </div>

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', padding: '10px 14px',
          borderTop: '1px solid var(--border-soft)' }}>
          <span style={{ flex: 1, fontSize: 11, color: 'var(--ink-muted)', alignSelf: 'center' }}>
            Click a part to select it · Delete clears it · Esc cancels
          </span>
          <button onClick={onClose} style={btn()}>Cancel</button>
          <button onClick={save} disabled={!changed} style={btn(true, !changed)}>Save</button>
        </div>
      </div>
    </div>,
    document.body,
  )
}

// ── Palette: what can be done with the selected part ────────────────────────

function Palette({ node, path, scope, draft, state, ctx, supers, graph, replace }) {
  const types = useMemo(() => allTypeOptions(state), [state])
  const facts = useMemo(() => (state.facts ?? [])
    .map(f => ({ id: f.id, label: readingText(f, ctx) || 'Unnamed fact type' }))
    .sort((a, b) => a.label.localeCompare(b.label)), [state.facts, ctx])
  const [qType, setQType] = useState(() => supers[0] ?? types[0]?.id ?? '')
  const [qN, setQN] = useState(1)

  // The innermost variable in scope that fits a place for instances of placeId.
  const fitting = (placeId) => [...scope].reverse().find(v => graph.fit(v.typeIds, placeId) === 'ok')?.id ?? null
  const quant = (t, op) => {
    const v = { id: newVarId(), typeId: qType }
    return t === 'count' ? { t, op, n: Math.max(0, Number(qN) || 0), v, body: hole() } : { t, v, body: hole() }
  }
  const parent = path.length ? getAt(draft, path.slice(0, path[path.length - 2] === 'args' ? -2 : -1)) : null
  const parentPath = path.length ? path.slice(0, path[path.length - 2] === 'args' ? -2 : -1) : null

  const typeSelect = (value, onChange) => (
    <select value={value} onChange={e => onChange(e.target.value)} style={selectStyle}>
      {types.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
    </select>
  )
  const quantButtons = (onPick) => (
    <>
      {typeSelect(qType, setQType)}
      <button style={btn()} disabled={!qType} onClick={() => onPick(quant('forall'))}>∀</button>
      <button style={btn()} disabled={!qType} onClick={() => onPick(quant('exists'))}>∃</button>
      {COUNT_OPS.map(op => (
        <button key={op} style={btn()} disabled={!qType} onClick={() => onPick(quant('count', op))}>∃<sup>{op}{qN}</sup></button>
      ))}
      <input type="number" min={0} value={qN} onChange={e => setQN(e.target.value)} title="Bound of the counting quantifiers"
        style={{ width: 46, fontSize: 12 }} />
    </>
  )

  const rows = []
  if (!node || node.t === 'hole') {
    rows.push(['Connective', <>
      <button style={btn()} onClick={() => replace(path, { t: 'and', args: [hole(), hole()] }, [...path, 'args', 0])}>□ ∧ □</button>
      <button style={btn()} onClick={() => replace(path, { t: 'or', args: [hole(), hole()] }, [...path, 'args', 0])}>□ ∨ □</button>
      <button style={btn()} onClick={() => replace(path, { t: 'implies', left: hole(), right: hole() }, [...path, 'left'])}>□ → □</button>
      <button style={btn()} onClick={() => replace(path, { t: 'iff', left: hole(), right: hole() }, [...path, 'left'])}>□ ↔ □</button>
      <button style={btn()} onClick={() => replace(path, { t: 'not', arg: hole() }, [...path, 'arg'])}>¬ □</button>
      <button style={btn()} onClick={() => replace(path, { t: 'true' })}>⊤</button>
    </>])
    rows.push(['Quantifier', quantButtons((q) => replace(path, q, [...path, 'body']))])
    rows.push(['Fact type', (
      <select value="" style={{ ...selectStyle, maxWidth: 420 }} onChange={e => {
        const f = ctx.factById.get(e.target.value)
        if (f) replace(path, { t: 'fact', factId: f.id, args: f.roles.map(r => fitting(r.objectTypeId)) })
      }}>
        <option value="">Choose a fact type…</option>
        {facts.map(f => <option key={f.id} value={f.id}>{f.label}</option>)}
      </select>
    )])
    rows.push(['Other atoms', <>
      <select value="" style={selectStyle} onChange={e => {
        if (e.target.value) replace(path, { t: 'type', typeId: e.target.value, arg: [...scope].reverse()[0]?.id ?? null })
      }}>
        <option value="">Is a type…</option>
        {types.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
      </select>
      <button style={btn()} onClick={() => replace(path, { t: 'cmp', op: '=', left: null, right: null })}>□ = □</button>
      <button style={btn()} onClick={() => replace(path, { t: 'vcmp', op: '≈', left: null, right: { const: '' } })}>□ ≈ value</button>
      <button style={btn()} onClick={() => replace(path, { t: 'vcmp', op: '<', left: null, right: { var: null } })}>□ &lt; □ (values)</button>
    </>])
  } else {
    rows.push(['Wrap in', <>
      <button style={btn()} onClick={() => replace(path, { t: 'not', arg: node }, path)}>¬ …</button>
      <button style={btn()} onClick={() => replace(path, { t: 'and', args: [node, hole()] }, [...path, 'args', 1])}>… ∧ □</button>
      <button style={btn()} onClick={() => replace(path, { t: 'or', args: [node, hole()] }, [...path, 'args', 1])}>… ∨ □</button>
      <button style={btn()} onClick={() => replace(path, { t: 'implies', left: node, right: hole() }, [...path, 'right'])}>… → □</button>
      <button style={btn()} onClick={() => replace(path, { t: 'implies', left: hole(), right: node }, [...path, 'left'])}>□ → …</button>
    </>])
    rows.push(['Quantify', quantButtons((q) => replace(path, { ...q, body: node }, path))])
    if (node.t === 'forall' || node.t === 'exists' || node.t === 'count') {
      rows.push(['Variable', <>
        {typeSelect(node.v.typeId, (typeId) => replace(path, { ...node, v: { ...node.v, typeId } }))}
        <select value={node.t === 'count' ? `count${node.op}` : node.t} style={selectStyle} onChange={e => {
          const k = e.target.value
          if (k === 'forall' || k === 'exists') replace(path, { t: k, v: node.v, body: node.body })
          else replace(path, { t: 'count', op: k.slice(5), n: node.n ?? 1, v: node.v, body: node.body })
        }}>
          <option value="forall">∀ for all</option>
          <option value="exists">∃ there is</option>
          <option value="count≤">∃≤n at most n</option>
          <option value="count≥">∃≥n at least n</option>
          <option value="count=">∃=n exactly n</option>
        </select>
        {node.t === 'count' && (
          <input type="number" min={0} value={node.n} style={{ width: 46, fontSize: 12 }}
            onChange={e => replace(path, { ...node, n: Math.max(0, Math.floor(Number(e.target.value) || 0)) })} />
        )}
      </>])
    }
    if (node.t === 'and' || node.t === 'or') {
      rows.push(['Operands', <>
        <button style={btn()} onClick={() => replace(path, { ...node, args: [...node.args, hole()] }, [...path, 'args', node.args.length])}>Add operand</button>
        <button style={btn()} onClick={() => replace(path, { ...node, t: node.t === 'and' ? 'or' : 'and' })}>Make {node.t === 'and' ? '∨' : '∧'}</button>
      </>])
    }
    if (node.t === 'implies' || node.t === 'iff') {
      rows.push(['Connective', <>
        <button style={btn()} onClick={() => replace(path, { ...node, t: node.t === 'implies' ? 'iff' : 'implies' })}>Make {node.t === 'implies' ? '↔' : '→'}</button>
        <button style={btn()} onClick={() => replace(path, { ...node, left: node.right, right: node.left })}>Swap sides</button>
      </>])
    }
    if (node.t === 'fact') {
      rows.push(['Fact type', (
        <select value={node.factId} style={{ ...selectStyle, maxWidth: 420 }} onChange={e => {
          const f = ctx.factById.get(e.target.value)
          if (f) replace(path, { t: 'fact', factId: f.id, args: f.roles.map(r => fitting(r.objectTypeId)) })
        }}>
          {facts.map(f => <option key={f.id} value={f.id}>{f.label}</option>)}
        </select>
      )])
    }
    if (node.t === 'type') rows.push(['Type', typeSelect(node.typeId, (typeId) => replace(path, { ...node, typeId }))])
    if (node.t === 'vcmp') {
      rows.push(['Right side', 'const' in node.right
        ? <button style={btn()} onClick={() => replace(path, { ...node, right: { var: null } })}>Compare with a variable</button>
        : <button style={btn()} onClick={() => replace(path, { ...node, right: { const: '' } })}>Compare with a constant</button>])
    }
    rows.push(['Remove', <>
      <button style={btn()} onClick={() => replace(path, hole())}>Clear</button>
      {parent && (BINARY.has(parent.t) || QUANT.has(parent.t) || parent.t === 'not') && (
        <button style={btn()} title="Replace the enclosing formula by this part"
          onClick={() => replace(parentPath, node, parentPath)}>Lift out of {liftLabel(parent)}</button>
      )}
    </>])
  }

  return (
    <div style={{ marginTop: 12, padding: 10, background: 'var(--bg-raised)', borderRadius: 'var(--radius-sm)',
      border: '1px solid var(--border-soft)' }}>
      <div style={{ fontSize: 10, color: 'var(--accent)', fontWeight: 700, letterSpacing: '0.08em',
        textTransform: 'uppercase', marginBottom: 6 }}>
        {!node || node.t === 'hole' ? 'Fill in the selected □' : 'Selected part'}
      </div>
      {rows.map(([label, content]) => (
        <div key={label} style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', marginBottom: 5 }}>
          <span style={{ width: 84, fontSize: 11, color: 'var(--ink-3)' }}>{label}</span>
          {content}
        </div>
      ))}
    </div>
  )
}

const liftLabel = (n) => ({
  and: '∧', or: '∨', implies: '→', iff: '↔', not: '¬', forall: '∀', exists: '∃', count: '∃ⁿ',
}[n.t])

// ── Inline pickers ──────────────────────────────────────────────────────────

// A variable slot: the variables in scope, those from another type hierarchy
// disabled, and those that fit only partly marked.
function VarSelect({ value, scope, nameOf, graph, placeId, ctx, onChange, onFocus }) {
  const fits = (v) => (placeId ? graph.fit(v.typeIds, placeId) : 'ok')
  const known = scope.some(v => v.id === value)
  return (
    <select value={known ? value : ''} onChange={e => onChange(e.target.value || null)} onFocus={onFocus}
      onClick={e => e.stopPropagation()}
      title={placeId ? `A ${ctx.typeName(placeId)}` : 'A variable'}
      style={{
        ...TOKEN_STYLE.var, font: 'inherit', fontWeight: 600, appearance: 'none', WebkitAppearance: 'none',
        background: 'transparent', border: 'none', borderBottom: '1px dashed var(--formula-var)',
        padding: '0 1px', cursor: 'pointer', width: 'auto', fieldSizing: 'content',
        color: known ? 'var(--formula-var)' : 'var(--danger)',
      }}>
      <option value="">□</option>
      {scope.map(v => {
        const f = fits(v)
        return <option key={v.id} value={v.id} disabled={f === 'none'}>
          {nameOf.get(v.id)}{f === 'none' ? ' (other hierarchy)' : ''}
        </option>
      })}
    </select>
  )
}

function OpSelect({ value, ops, onChange }) {
  return (
    <select value={value} onChange={e => onChange(e.target.value)} onClick={e => e.stopPropagation()} style={{
      ...TOKEN_STYLE.op, font: 'inherit', appearance: 'none', WebkitAppearance: 'none', background: 'transparent',
      border: 'none', borderBottom: '1px dashed var(--formula-op)', padding: '0 4px', margin: '0 4px',
      cursor: 'pointer', width: 'auto', fieldSizing: 'content',
    }}>
      {ops.map(op => <option key={op} value={op}>{op}</option>)}
    </select>
  )
}

function ConstInput({ value, onChange, onFocus }) {
  return (
    <input value={value} onChange={e => onChange(e.target.value)} onFocus={onFocus}
      onClick={e => e.stopPropagation()} placeholder="value"
      style={{
        ...TOKEN_STYLE.const, font: 'inherit', background: 'transparent', border: 'none',
        borderBottom: '1px dashed var(--formula-const)', padding: '0 2px',
        width: `${Math.max(5, String(value).length + 1)}ch`,
      }} />
  )
}

const selectStyle = { fontSize: 12, width: 'auto', maxWidth: 220 }

function btn(primary = false, disabled = false) {
  return {
    fontSize: 12, padding: '2px 8px', borderRadius: 3, cursor: disabled ? 'default' : 'pointer',
    border: `1px solid ${primary ? 'var(--accent)' : 'var(--border)'}`,
    background: primary && !disabled ? 'var(--accent)' : 'var(--bg-surface)',
    color: primary && !disabled ? '#fff' : disabled ? 'var(--ink-muted)' : 'var(--ink-2)',
    opacity: disabled ? 0.6 : 1,
  }
}
