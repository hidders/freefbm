import React, { useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { useShallow } from 'zustand/react/shallow'
import { useOrmStore } from '../store/ormStore'
import { makeContext, readingText } from '../logic/constraintFormulas.js'
import {
  SUBJECT, hole, getAt, setAt, directSupertypes, typeGraph, allTypeOptions,
  ruleVariables, checkRule, derivationEntry, derivationHeading, upgradeRule, isTermSlot, atomFact,
} from '../logic/derivationRule.js'
import {
  factRuleParts, factRuleVariables, checkFactRule, factDerivationEntries, factLabel,
} from '../logic/factDerivation.js'
import { OPS, PREDS, AGGS, arity } from '../logic/dataOperators.js'
import { valueAccess } from '../logic/values.js'
import { QGAP } from '../logic/renderFormula.js'
import { TOKEN_STYLE, Formula } from './FormalisationTab.jsx'

// ── Derivation rule editor ──────────────────────────────────────────────────
// A syntax-directed editor for the derivation rule of a derived or
// semi-derived subtype (see src/logic/derivationRule.js), or of a fact type
// (otId or factId; see src/logic/factDerivation.js). For a fact type the
// roles' variables are marked selected or computed, extra variables can be
// added, and each computed role gets a term. The formula is shown
// with holes (□) for the parts not filled in yet; clicking a part selects it,
// and the panel below offers what can go there. Variables in atoms are picked
// from the variables in scope, and the types and fact types from the schema.
// Value comparisons and data predicates take data terms, built the same way
// from variables, constants, operators (src/logic/dataOperators.js),
// if-then-else and aggregates (Sum{t | v₁, … : φ}).

const ATOMIC = new Set(['fact', 'type', 'true', 'not', 'hole'])
const BINARY = new Set(['and', 'or', 'implies', 'iff'])
const QUANT = new Set(['forall', 'exists', 'count'])
const OP = { and: ' ∧ ', or: ' ∨ ', implies: ' → ', iff: ' ↔ ' }
const VALUE_OPS = ['≈', '≉', '<', '≤', '>', '≥']
const COUNT_OPS = ['≤', '≥', '=']

const newVarId = () => `v${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
const keyOf = (path) => path.join('.')
const samePath = (a, b) => keyOf(a) === keyOf(b)

// The rule of a fact type as the editor works on it.
const factDraft = (r) => ({ body: upgradeRule(r?.body) ?? hole(), extraVars: r?.extraVars ?? [], terms: r?.terms ?? {} })

export default function DerivationRuleEditor({ otId, factId, onClose }) {
  const state = useOrmStore(useShallow(s => ({
    objectTypes: s.objectTypes, facts: s.facts, subtypes: s.subtypes, constraints: s.constraints,
  })))
  const updateObjectType = useOrmStore(s => s.updateObjectType)
  const updateFact = useOrmStore(s => s.updateFact)
  const forFact = factId != null
  const ot = forFact ? null : state.objectTypes.find(o => o.id === otId)
  const fact = forFact ? state.facts.find(f => f.id === factId) : null
  const stored = forFact ? factDraft(fact?.derivationRule) : upgradeRule(ot?.derivationRule) ?? hole()
  const [draft, setDraft] = useState(stored)
  const [sel, setSel] = useState(forFact ? ['body'] : [])
  const [newVarType, setNewVarType] = useState('')

  const ctx = useMemo(() => makeContext(state), [state])
  const graph = useMemo(() => typeGraph(state), [state])
  const supers = useMemo(() => (forFact ? [] : directSupertypes(otId, state.subtypes)), [forFact, otId, state.subtypes])
  const parts = useMemo(() => (forFact && fact ? factRuleParts(fact, draft) : null), [forFact, fact, draft])
  // The free variables of the condition (and of the terms).
  const roots = useMemo(() => (forFact ? (parts ? [...parts.selected, ...parts.extra] : [])
    : [{ id: SUBJECT, typeIds: supers }]), [forFact, parts, supers])
  const { nameOf } = useMemo(() => (forFact ? (fact ? factRuleVariables(fact, ctx, draft) : { nameOf: new Map() })
    : ruleVariables(draft, supers, ctx)), [forFact, fact, draft, supers, ctx])
  const issues = useMemo(() => (forFact ? (fact ? checkFactRule(fact, state, ctx, undefined, draft) : [])
    : checkRule(draft, otId, state, ctx)), [forFact, fact, draft, otId, state, ctx])
  const severityAt = useMemo(() => {
    const m = new Map()
    for (const i of issues) if (m.get(keyOf(i.path)) !== 'error') m.set(keyOf(i.path), i.severity)
    return m
  }, [issues])
  const errors = issues.filter(i => i.severity === 'error')
  const preview = useMemo(() => {
    if (errors.length) return []
    if (forFact) return fact ? factDerivationEntries(fact, state, ctx, draft) : []
    return ot ? [derivationEntry({ ...ot, derivationRule: draft }, state, ctx)] : []
  }, [forFact, fact, ot, draft, state, ctx, errors.length])
  const types = useMemo(() => allTypeOptions(state), [state])

  if (forFact ? !fact : !ot) return null
  const changed = JSON.stringify(draft) !== JSON.stringify(stored)
  const semi = (forFact ? fact : ot).derivation === 'semiDerived'

  const replace = (path, node, nextSel = path) => { setDraft(d => setAt(d, path, node)); setSel(nextSel) }
  const save = () => {
    if (forFact) updateFact(factId, { derivationRule: draft })
    else updateObjectType(otId, { derivationRule: draft })
    onClose()
  }

  const onKeyDown = (e) => {
    // Keep the canvas shortcuts (delete, tools, arrows) out of the dialog.
    e.stopPropagation()
    if (e.key === 'Escape') { e.preventDefault(); onClose(); return }
    const typing = /^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName)
    if (!typing && (e.key === 'Delete' || e.key === 'Backspace')) {
      e.preventDefault()
      if (sel.length && getAt(draft, sel) && getAt(draft, sel).t !== 'hole') replace(sel, hole())
    }
  }

  // Scope at a path, for the variable pickers: the subject (or the free
  // variables of a fact type's rule), then the variables of every quantifier
  // and aggregate above it.
  const scopeAt = (path) => {
    const out = [...roots]
    let n = draft
    for (const k of path) {
      if (QUANT.has(n?.t) && k === 'body') out.push({ id: n.v.id, typeIds: [n.v.typeId] })
      if (n?.t === 'agg' && (k === 'cond' || k === 'term')) out.push(...aggScope(n))
      n = n?.[k]
    }
    return out
  }

  // ── Formula view ──
  const varPicker = (path, value, scope, placeId, onChange, valuesOnly = false) => (
    <VarSelect value={value} scope={scope} nameOf={nameOf} graph={graph} placeId={placeId}
      ctx={ctx} onChange={onChange} onFocus={() => setSel(path)} valuesOnly={valuesOnly} />
  )

  const render = (n, path, scope) => {
    const selected = samePath(path, sel)
    const sev = severityAt.get(keyOf(path))
    const wrapStyle = {
      borderRadius: 3, cursor: 'pointer', padding: '0 1px',
      background: selected ? 'var(--formula-sel-bg)' : undefined,
      outline: selected ? '1px solid var(--formula-sel)' : undefined,
      textDecoration: sev && n.t !== 'hole' ? `underline wavy ${sev === 'error' ? 'var(--danger)' : '#d97706'}` : undefined,
      textUnderlineOffset: 3,
    }
    const click = (e) => { e.stopPropagation(); setSel(path) }
    const sub = (key, wrap, inScope = scope) => {
      const p = [...path, ...(Array.isArray(key) ? key : [key])]
      const child = getAt(draft, p)
      const inner = render(child, p, inScope)
      return wrap ? <>{'('}{inner}{')'}</> : inner
    }
    let body
    switch (n?.t) {
      case 'hole': case undefined:
        body = <span style={{ color: 'var(--formula-hole)', fontWeight: 600 }} title="Not filled in yet">□</span>
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
        const fact = atomFact(ctx, n.factId)
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
          {sub('left')}
          <OpSelect value={n.op} ops={VALUE_OPS} onChange={(op) => replace(path, { ...n, op })} />
          {sub('right')}
        </>
        break
      case 'dpred': case 'op': {
        const def = (n.t === 'dpred' ? PREDS : OPS)[n.op]
        const fnTok = (text) => <span style={TOKEN_STYLE.fn}>{text}</span>
        if (def?.style === 'infix') {
          // Parentheses around an argument that binds less tightly.
          const arg = (i) => {
            const a = n.args[i]
            const ad = a?.t === 'op' ? OPS[a.op] : null
            const wrap = ad?.style === 'infix' && (ad.prec < def.prec || (ad.prec === def.prec && i === 1 && !(a.op === n.op && def.assoc)))
            return sub(['args', i], wrap)
          }
          body = <>{arg(0)}{fnTok(` ${def.symbol} `)}{arg(1)}</>
        } else if (def?.style === 'prefix') {
          body = <>{fnTok(def.symbol)}{sub(['args', 0], n.args[0]?.t === 'op' && OPS[n.args[0].op]?.style === 'infix')}</>
        } else {
          body = <>{fnTok(def?.symbol ?? n.op)}{'('}{n.args.map((_, i) => (
            <React.Fragment key={i}>{i > 0 && ', '}{sub(['args', i])}</React.Fragment>
          ))}{')'}</>
        }
        break
      }
      case 'var':
        body = varPicker(path, n.id, scope, null, (id) => replace(path, { t: 'var', id }), true)
        break
      case 'const':
        body = <ConstInput value={n.text} onFocus={() => setSel(path)}
          onChange={(text) => replace(path, { t: 'const', text })} />
        break
      case 'if':
        body = <>
          {'('}<span style={TOKEN_STYLE.op}>if</span>{' '}
          {sub('cond', !(ATOMIC.has(n.cond?.t) || n.cond?.t === 'vcmp'))}
          <span style={TOKEN_STYLE.op}> then </span>{sub('then')}
          <span style={TOKEN_STYLE.op}> else </span>{sub('else')}{')'}
        </>
        break
      case 'agg': {
        // Sum{t | v₁, v₂ : φ}, Count{v₁, v₂ : φ}
        const inner = [...scope, ...aggScope(n)]
        body = <>
          <span style={TOKEN_STYLE.fn}>{AGGS[n.fn]?.symbol ?? n.fn}</span>
          {n.distinct && <sub style={{ ...TOKEN_STYLE.fn, fontSize: '0.75em' }}>distinct</sub>}
          {'{'}
          {n.fn !== 'count' && <>{sub('term', false, inner)}{' | '}</>}
          {(n.vars ?? []).map((v, i) => (
            <React.Fragment key={v.id}>{i > 0 && ', '}
              <span style={TOKEN_STYLE.var} title={`ranges over ${ctx.typeName(v.typeId)}`}>{nameOf.get(v.id)}</span>
            </React.Fragment>
          ))}
          {' : '}{sub('cond', false, inner)}{'}'}
        </>
        break
      }
      default:
        body = '?'
    }
    return <span onClick={click} style={wrapStyle}>{body}</span>
  }

  const selNode = getAt(draft, sel)
  const selScope = scopeAt(sel)
  const termSelected = forFact && sel[0] === 'terms' ? (sel.length === 2 || isTermSlot(draft, sel)) : isTermSlot(draft, sel)

  // ── Variables of a fact type's rule ──
  const setComputed = (roleId, on) => setDraft(d => {
    const terms = { ...d.terms }
    if (on) terms[roleId] = hole()
    else delete terms[roleId]
    return { ...d, terms }
  })
  const addVar = () => {
    const typeId = newVarType || types[0]?.id
    if (!typeId) return
    setDraft(d => ({ ...d, extraVars: [...d.extraVars, { id: newVarId(), typeId }] }))
  }
  const factVariables = forFact && (
    <div style={{ marginBottom: 10 }}>
      <div style={sectionLabel}>Variables</div>
      {parts.roles.map((r, i) => (
        <div key={r.id} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, marginBottom: 3 }}>
          <span style={{ width: 52, color: 'var(--ink-3)', fontSize: 11 }}>Role {i + 1}</span>
          <span style={{ ...TOKEN_STYLE.var, fontFamily: 'var(--font-mono)', minWidth: 110 }}>{nameOf.get(r.id)}</span>
          {['selected', 'computed'].map(m => (
            <label key={m} style={{ display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer', color: 'var(--ink-2)' }}
              title={m === 'selected' ? 'Bound to an object of the current population' : 'The object whose value its term gives'}>
              <input type="radio" name={`role-${r.roleId}`} checked={(m === 'computed') === r.computed}
                onChange={() => setComputed(r.roleId, m === 'computed')}
                style={{ width: 'auto', padding: 0, border: 'none' }} />
              {m}
            </label>
          ))}
        </div>
      ))}
      {parts.extra.map((v, i) => {
        const sev = severityAt.get(keyOf(['extraVars', i]))
        return (
          <div key={v.id} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, marginBottom: 3 }}>
            <span style={{ width: 52, color: 'var(--ink-3)', fontSize: 11 }}>Extra</span>
            <span style={{ ...TOKEN_STYLE.var, fontFamily: 'var(--font-mono)', minWidth: 110,
              textDecoration: sev ? `underline wavy ${sev === 'error' ? 'var(--danger)' : '#d97706'}` : undefined }}>{nameOf.get(v.id)}</span>
            <select value={v.typeIds[0]} style={selectStyle} onChange={e => setDraft(d => ({
              ...d, extraVars: d.extraVars.map(x => (x.id === v.id ? { ...x, typeId: e.target.value } : x)) }))}>
              {types.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
            <button style={btn()} title="Remove this variable"
              onClick={() => setDraft(d => ({ ...d, extraVars: d.extraVars.filter(x => x.id !== v.id) }))}>Remove</button>
          </div>
        )
      })}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, marginTop: 4 }}>
        <span style={{ width: 52 }} />
        <select value={newVarType || types[0]?.id || ''} style={selectStyle} onChange={e => setNewVarType(e.target.value)}>
          {types.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
        </select>
        <button style={btn()} onClick={addVar}
          title="A variable of the condition that is not a role of the fact type">Add a variable</button>
      </div>
    </div>
  )

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
            {semi ? 'Semi-derivation rule' : 'Derivation rule'} of {forFact ? factLabel(fact, ctx) : ot.name || 'Unnamed'}
          </div>
          <div style={{ fontSize: 11, color: 'var(--ink-muted)', marginTop: 2 }}>
            {forFact
              ? semi
                ? 'Each combination for which the condition holds, with the values of the computed roles, must be a fact.'
                : 'The facts are exactly the combinations for which the condition holds, with the values of the computed roles.'
              : supers.length ? derivationHeading(ot, supers, ctx) : `${ot.name} has no supertype, so it cannot be derived.`}
          </div>
        </div>

        <div style={{ padding: 14, overflow: 'auto', flex: 1 }}>
          {factVariables}
          {forFact && <div style={sectionLabel}>Condition</div>}
          <div tabIndex={0} onClick={() => setSel(forFact ? ['body'] : [])} className="text-panel" style={{
            fontFamily: 'var(--font-mono)', fontSize: 13, lineHeight: 2, minHeight: 44, outline: 'none',
          }}>
            {forFact ? render(draft.body, ['body'], roots) : render(draft, [], roots)}
          </div>
          {forFact && parts.computed.length > 0 && <>
            <div style={{ ...sectionLabel, marginTop: 10 }}>Computed values</div>
            <div className="text-panel" style={{ fontFamily: 'var(--font-mono)', fontSize: 13, lineHeight: 2 }}>
              {parts.computed.map(c => (
                <div key={c.id}>
                  <span style={TOKEN_STYLE.var}>{nameOf.get(c.id)}</span>
                  <span style={TOKEN_STYLE.op}> ≈ </span>
                  {render(getAt(draft, ['terms', c.roleId]) ?? hole(), ['terms', c.roleId], roots)}
                </div>
              ))}
            </div>
          </>}

          {termSelected
            ? <TermPalette node={selNode} path={sel} scope={selScope} draft={draft} ctx={ctx} nameOf={nameOf}
                types={types} replace={replace} />
            : <Palette node={selNode} path={sel} scope={selScope} draft={draft} state={state} ctx={ctx}
                supers={forFact ? roots.map(r => r.typeIds[0]) : supers}
                graph={graph} replace={replace} />}

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

          {preview.some(e => e.formula) && (
            <div style={{ marginTop: 12 }}>
              <div style={{ fontSize: 10, color: 'var(--ink-muted)', letterSpacing: '0.04em', marginBottom: 2 }}>
                As shown in the Formalisation panel
              </div>
              {preview.filter(e => e.formula).map(e => (
                <div key={e.key} className="text-panel" style={{ marginBottom: 4 }}><Formula formula={e.formula} ctx={ctx} /></div>
              ))}
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
  // The fact types, and the implied links of the nested ones.
  const facts = useMemo(() => [...(state.facts ?? []), ...ctx.linkById.values()]
    .map(f => ({ id: f.id, roles: f.roles, label: readingText(f, ctx) || 'Unnamed fact type' }))
    .sort((a, b) => a.label.localeCompare(b.label)), [state.facts, ctx])
  // A fact type is relevant here when a variable in scope can fill one of its
  // roles: its type is the player, a subtype of it or a supertype of it.
  const relevant = useMemo(() => {
    const canFill = (v, placeId) => !placeId || graph.fit(v.typeIds, placeId) === 'ok'
      || v.typeIds.every(t => graph.up(placeId).has(t))
    return new Set(facts.filter(f => f.roles.some(r => scope.some(v => canFill(v, r.objectTypeId)))).map(f => f.id))
  }, [facts, scope, graph])
  const [showAll, setShowAll] = useState(false)
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

  // The fact type menu: by default only the relevant fact types (and the one
  // already chosen); with "show all" the others follow in their own group.
  // With no variables in scope at all, every fact type is listed.
  const filtering = scope.length > 0
  const factOptions = (current) => {
    const opt = (f) => <option key={f.id} value={f.id}>{f.label}</option>
    if (!filtering) return facts.map(opt)
    const near = facts.filter(f => relevant.has(f.id) || f.id === current)
    const rest = facts.filter(f => !relevant.has(f.id) && f.id !== current)
    if (!showAll || rest.length === 0) return near.map(opt)
    return <>
      <optgroup label="Using a variable in scope">{near.map(opt)}</optgroup>
      <optgroup label="Other fact types">{rest.map(opt)}</optgroup>
    </>
  }
  const hidden = filtering ? facts.filter(f => !relevant.has(f.id)).length : 0
  const showAllToggle = hidden > 0 && (
    <label title="Also list the fact types that no variable in scope can fill a role of"
      style={{ display: 'flex', alignItems: 'center', gap: 3, fontSize: 11, color: 'var(--ink-muted)', cursor: 'pointer' }}>
      <input type="checkbox" checked={showAll} onChange={e => setShowAll(e.target.checked)}
        style={{ width: 'auto', padding: 0, border: 'none', margin: 0 }} />
      show all{showAll ? '' : ` (${hidden} more)`}
    </label>
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
      <>
        <select value="" style={{ ...selectStyle, maxWidth: 420 }} onChange={e => {
          const f = atomFact(ctx, e.target.value)
          if (f) replace(path, { t: 'fact', factId: f.id, args: f.roles.map(r => fitting(r.objectTypeId)) })
        }}>
          <option value="">Choose a fact type…</option>
          {factOptions()}
        </select>
        {showAllToggle}
      </>
    )])
    rows.push(['Other atoms', <>
      <select value="" style={selectStyle} onChange={e => {
        if (e.target.value) replace(path, { t: 'type', typeId: e.target.value, arg: [...scope].reverse()[0]?.id ?? null })
      }}>
        <option value="">Is a type…</option>
        {types.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
      </select>
      <button style={btn()} onClick={() => replace(path, { t: 'cmp', op: '=', left: null, right: null })}>□ = □</button>
      <button style={btn()} title="Compare data values, which can be computed"
        onClick={() => replace(path, { t: 'vcmp', op: '≈', left: hole(), right: hole() }, [...path, 'left'])}>□ ≈ □ (values)</button>
      <select value="" style={selectStyle} onChange={e => {
        const op = e.target.value
        if (op) replace(path, { t: 'dpred', op, args: Array.from({ length: arity(PREDS[op]) }, hole) }, [...path, 'args', 0])
      }}>
        <option value="">Text test…</option>
        {Object.entries(PREDS).map(([id, d]) => <option key={id} value={id}>{d.symbol}(□, □): {d.label}</option>)}
      </select>
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
      rows.push(['Fact type', (<>
        <select value={node.factId} style={{ ...selectStyle, maxWidth: 420 }} onChange={e => {
          const f = atomFact(ctx, e.target.value)
          if (f) replace(path, { t: 'fact', factId: f.id, args: f.roles.map(r => fitting(r.objectTypeId)) })
        }}>
          {factOptions(node.factId)}
        </select>
        {showAllToggle}
      </>)])
    }
    if (node.t === 'type') rows.push(['Type', typeSelect(node.typeId, (typeId) => replace(path, { ...node, typeId }))])
    if (node.t === 'vcmp') {
      rows.push(['Sides', <button style={btn()} onClick={() => replace(path, { ...node, left: node.right, right: node.left })}>Swap sides</button>])
    }
    if (node.t === 'dpred') {
      rows.push(['Test', (
        <select value={node.op} style={selectStyle} onChange={e => replace(path, { ...node, op: e.target.value })}>
          {Object.entries(PREDS).map(([id, d]) => <option key={id} value={id}>{d.symbol}: {d.label}</option>)}
        </select>
      )])
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

// ── Term palette: what can go in, or be done with, a data term ─────────────

const OP_GROUPS = [...new Set(Object.values(OPS).map(d => d.group))]
const opPattern = (d, first = '□') => {
  const rest = Array.from({ length: arity(d) - 1 }, () => '□')
  if (d.style === 'infix') return `${first} ${d.symbol} ${rest[0]}`
  if (d.style === 'prefix') return `${d.symbol}${first}`
  return `${d.symbol}(${[first, ...rest].join(', ')})`
}

function OpMenu({ value = '', placeholder, first, onPick }) {
  return (
    <select value={value} style={{ ...selectStyle, maxWidth: 320 }} onChange={e => e.target.value && onPick(e.target.value)}>
      {placeholder && <option value="">{placeholder}</option>}
      {OP_GROUPS.map(g => (
        <optgroup key={g} label={g}>
          {Object.entries(OPS).filter(([, d]) => d.group === g).map(([id, d]) => (
            <option key={id} value={id}>{opPattern(d, first)}   {d.label}</option>
          ))}
        </optgroup>
      ))}
    </select>
  )
}

function TermPalette({ node, path, scope, draft, ctx, nameOf, types, replace }) {
  const [aggFn, setAggFn] = useState('sum')
  const [aggType, setAggType] = useState(() => types[0]?.id ?? '')
  const [newAggVarType, setNewAggVarType] = useState(() => types[0]?.id ?? '')
  const holes = (n) => Array.from({ length: n }, hole)
  const typeSelect = (value, onChange) => (
    <select value={value} onChange={e => onChange(e.target.value)} style={selectStyle}>
      {types.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
    </select>
  )
  const fnSelect = (value, onChange) => (
    <select value={value} onChange={e => onChange(e.target.value)} style={selectStyle}>
      {Object.entries(AGGS).map(([id, d]) => <option key={id} value={id}>{d.symbol}: {d.label}</option>)}
    </select>
  )
  const hasValue = (v) => v.typeIds.some(t => valueAccess(t, ctx))
  const last = path[path.length - 1]
  const parentPath = path.slice(0, typeof last === 'number' ? -2 : -1)
  const parent = getAt(draft, parentPath)
  // The fact type menu: by default only the relevant fact types (and the one
  // already chosen); with "show all" the others follow in their own group.
  // With no variables in scope at all, every fact type is listed.
  const filtering = scope.length > 0
  const factOptions = (current) => {
    const opt = (f) => <option key={f.id} value={f.id}>{f.label}</option>
    if (!filtering) return facts.map(opt)
    const near = facts.filter(f => relevant.has(f.id) || f.id === current)
    const rest = facts.filter(f => !relevant.has(f.id) && f.id !== current)
    if (!showAll || rest.length === 0) return near.map(opt)
    return <>
      <optgroup label="Using a variable in scope">{near.map(opt)}</optgroup>
      <optgroup label="Other fact types">{rest.map(opt)}</optgroup>
    </>
  }
  const hidden = filtering ? facts.filter(f => !relevant.has(f.id)).length : 0
  const showAllToggle = hidden > 0 && (
    <label title="Also list the fact types that no variable in scope can fill a role of"
      style={{ display: 'flex', alignItems: 'center', gap: 3, fontSize: 11, color: 'var(--ink-muted)', cursor: 'pointer' }}>
      <input type="checkbox" checked={showAll} onChange={e => setShowAll(e.target.checked)}
        style={{ width: 'auto', padding: 0, border: 'none', margin: 0 }} />
      show all{showAll ? '' : ` (${hidden} more)`}
    </label>
  )

  const rows = []
  if (!node || node.t === 'hole') {
    rows.push(['Value of', (
      <select value="" style={selectStyle} onChange={e => e.target.value && replace(path, { t: 'var', id: e.target.value })}>
        <option value="">Choose a variable…</option>
        {scope.map(v => (
          <option key={v.id} value={v.id} disabled={!hasValue(v)}>
            {nameOf.get(v.id)}{hasValue(v) ? '' : ' (no value: not a value type and no reference mode)'}
          </option>
        ))}
      </select>
    )])
    rows.push(['Constant', <button style={btn()} onClick={() => replace(path, { t: 'const', text: '' })}>Type a value</button>])
    rows.push(['Operator', <OpMenu placeholder="Choose an operator…" onPick={(op) =>
      replace(path, { t: 'op', op, args: holes(arity(OPS[op])) }, [...path, 'args', 0])} />])
    rows.push(['Condition', <button style={btn()}
      onClick={() => replace(path, { t: 'if', cond: hole(), then: hole(), else: hole() }, [...path, 'cond'])}>(if □ then □ else □)</button>])
    rows.push(['Aggregate', <>
      {fnSelect(aggFn, setAggFn)}
      <span style={{ fontSize: 11, color: 'var(--ink-3)' }}>over</span>
      {typeSelect(aggType, setAggType)}
      <button style={btn()} disabled={!aggType} title="A value computed from every binding of the variables for which the condition holds"
        onClick={() => {
          const v = { id: newVarId(), typeId: aggType }
          const count = aggFn === 'count'
          replace(path, { t: 'agg', fn: aggFn, distinct: false, vars: [v], cond: hole(), ...(count ? {} : { term: hole() }) },
            [...path, count ? 'cond' : 'term'])
        }}>
        {AGGS[aggFn].symbol}{aggFn === 'count' ? '{… : □}' : '{□ | … : □}'}
      </button>
    </>])
  } else {
    rows.push(['Wrap in', <>
      <OpMenu placeholder="An operator…" first="…" onPick={(op) => {
        const n = arity(OPS[op])
        replace(path, { t: 'op', op, args: [node, ...holes(n - 1)] }, n > 1 ? [...path, 'args', 1] : path)
      }} />
      <button style={btn()} onClick={() => replace(path, { t: 'if', cond: hole(), then: node, else: hole() }, [...path, 'cond'])}>(if □ then … else □)</button>
    </>])
    if (node.t === 'op') {
      rows.push(['Operator', <OpMenu value={node.op} onPick={(op) => {
        const n = arity(OPS[op])
        replace(path, { ...node, op, args: [...node.args.slice(0, n), ...holes(Math.max(0, n - node.args.length))] })
      }} />])
    }
    if (node.t === 'agg') {
      rows.push(['Aggregate', <>
        {fnSelect(node.fn, (fn) => {
          const { term, ...rest } = node
          replace(path, fn === 'count' ? { ...rest, fn, distinct: false } : { ...rest, fn, term: term ?? hole() })
        })}
        {node.fn !== 'count' && (
          <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12, color: 'var(--ink-2)', cursor: 'pointer' }}
            title="Count each value once">
            <input type="checkbox" checked={!!node.distinct} style={{ width: 'auto', padding: 0, border: 'none' }}
              onChange={e => replace(path, { ...node, distinct: e.target.checked })} />
            distinct values
          </label>
        )}
      </>])
      rows.push(['Variables', <>
        {node.vars.map((v, i) => (
          <span key={v.id} style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
            <span style={{ ...TOKEN_STYLE.var, fontFamily: 'var(--font-mono)', fontSize: 12 }}>{nameOf.get(v.id)}</span>
            {typeSelect(v.typeId, (typeId) => replace(path, { ...node, vars: node.vars.map((x, j) => (j === i ? { ...x, typeId } : x)) }))}
            {node.vars.length > 1 && (
              <button style={btn()} title="Remove this variable"
                onClick={() => replace(path, { ...node, vars: node.vars.filter((_, j) => j !== i) })}>×</button>
            )}
          </span>
        ))}
        {typeSelect(newAggVarType, setNewAggVarType)}
        <button style={btn()} disabled={!newAggVarType}
          onClick={() => replace(path, { ...node, vars: [...node.vars, { id: newVarId(), typeId: newAggVarType }] })}>Add a variable</button>
      </>])
    }
    if (node.t === 'if') {
      rows.push(['Branches', <button style={btn()} onClick={() => replace(path, { ...node, then: node.else, else: node.then })}>Swap then and else</button>])
    }
    rows.push(['Remove', <>
      <button style={btn()} onClick={() => replace(path, hole())}>Clear</button>
      {(parent?.t === 'op' || parent?.t === 'if') && (
        <button style={btn()} title="Replace the enclosing term by this part"
          onClick={() => replace(parentPath, node, parentPath)}>Lift out of {parent.t === 'if' ? 'if' : OPS[parent.op]?.symbol}</button>
      )}
    </>])
  }
  return (
    <div style={{ marginTop: 12, padding: 10, background: 'var(--bg-raised)', borderRadius: 'var(--radius-sm)',
      border: '1px solid var(--border-soft)' }}>
      <div style={{ fontSize: 10, color: 'var(--accent)', fontWeight: 700, letterSpacing: '0.08em',
        textTransform: 'uppercase', marginBottom: 6 }}>
        {!node || node.t === 'hole' ? 'Fill in the selected value □' : 'Selected value'}
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

// The variables an aggregate binds, as scope entries.
const aggScope = (n) => (n.vars ?? []).map(v => ({ id: v.id, typeIds: [v.typeId] }))

const liftLabel = (n) => ({
  and: '∧', or: '∨', implies: '→', iff: '↔', not: '¬', forall: '∀', exists: '∃', count: '∃ⁿ',
}[n.t])

// ── Inline pickers ──────────────────────────────────────────────────────────

// A variable slot: the variables in scope, those from another type hierarchy
// disabled, and those that fit only partly marked.
function VarSelect({ value, scope, nameOf, graph, placeId, ctx, onChange, onFocus, valuesOnly }) {
  const fits = (v) => (valuesOnly ? (v.typeIds.some(t => valueAccess(t, ctx)) ? 'ok' : 'novalue')
    : placeId ? graph.fit(v.typeIds, placeId) : 'ok')
  const known = scope.some(v => v.id === value)
  return (
    <select value={known ? value : ''} onChange={e => onChange(e.target.value || null)} onFocus={onFocus}
      onClick={e => e.stopPropagation()}
      title={placeId ? `A ${ctx.typeName(placeId)}` : 'A variable'}
      style={{
        ...TOKEN_STYLE.var, font: 'inherit', fontWeight: 600, appearance: 'none', WebkitAppearance: 'none',
        background: 'transparent', border: 'none', borderBottom: '1px dashed var(--formula-var)',
        padding: '0 1px', cursor: 'pointer', width: 'auto', fieldSizing: 'content',
        color: known ? 'var(--formula-var)' : 'var(--formula-hole)',
      }}>
      <option value="">□</option>
      {scope.map(v => {
        const f = fits(v)
        return <option key={v.id} value={v.id} disabled={f === 'none' || f === 'novalue'}>
          {nameOf.get(v.id)}{f === 'none' ? ' (other hierarchy)' : f === 'novalue' ? ' (no value)' : ''}
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
const sectionLabel = { fontSize: 10, color: 'var(--accent)', fontWeight: 700, letterSpacing: '0.08em',
  textTransform: 'uppercase', marginBottom: 4 }

function btn(primary = false, disabled = false) {
  return {
    fontSize: 12, padding: '2px 8px', borderRadius: 3, cursor: disabled ? 'default' : 'pointer',
    border: `1px solid ${primary ? 'var(--accent)' : 'var(--border)'}`,
    background: primary && !disabled ? 'var(--accent)' : 'var(--bg-surface)',
    color: primary && !disabled ? '#fff' : disabled ? 'var(--ink-muted)' : 'var(--ink-2)',
    opacity: disabled ? 0.6 : 1,
  }
}
