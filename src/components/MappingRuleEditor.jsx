import React, { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useShallow } from 'zustand/react/shallow'
import { useOrmStore } from '../store/ormStore'
import {
  sideContext, sideTokens, checkRule, variableNames, readingName, typesMeet, newVarId, SIDES, sideSchemaId,
} from '../mapping/mapping.js'
import { plainParts } from '../verbalisation/hyphenBinding.js'
import { PatternText, IssueList, MAPPING_TOKEN_STYLE } from './MappingFormula.jsx'

// The open mapping rule editor, if any (store.mappingRuleEditor).
export function MappingRuleEditorPanel() {
  const target = useOrmStore(s => s.mappingRuleEditor)
  if (!target) return null
  return <MappingRuleEditor key={`${target.mappingId}:${target.ruleId}`} mappingId={target.mappingId} ruleId={target.ruleId} />
}

// Where the panel is and whether it is folded, kept between openings.
const PANEL_KEY = 'freefbm.mappingEditor.panel'
const loadPanel = () => { try { return JSON.parse(localStorage.getItem(PANEL_KEY)) ?? {} } catch { return {} } }
const savePanel = (p) => { try { localStorage.setItem(PANEL_KEY, JSON.stringify(p)) } catch { /* not kept */ } }
const clampX = (x, w) => Math.min(Math.max(0, x), Math.max(0, window.innerWidth - w))
const clampY = (y) => Math.min(Math.max(0, y), window.innerHeight - 44)

const input = {
  fontSize: 12, padding: '1px 4px', border: '1px solid var(--border)', borderRadius: 3,
  background: 'var(--bg-surface)', color: 'var(--ink)', fontFamily: 'var(--font-mono)',
}
const smallBtn = {
  fontSize: 11, lineHeight: 1, padding: '2px 6px', borderRadius: 3, cursor: 'pointer',
  border: '1px solid var(--border)', background: 'var(--bg-surface)', color: 'var(--ink-2)',
}
const xBtn = { ...smallBtn, border: 'none', background: 'none', color: 'var(--ink-muted)', padding: '0 4px', fontSize: 13 }
const label = { fontSize: 10, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--ink-muted)', margin: '10px 0 4px' }

// Every reference to a variable of a side cleared, and the variable removed.
function dropVar(side, id) {
  const fixAtoms = (atoms) => atoms.map(a => {
    if (a.t === 'fact') return { ...a, args: a.args.map(x => (x === id ? null : x)) }
    if (a.t === 'type') return a.arg === id ? { ...a, arg: null } : a
    if (a.t === 'bind' || a.t === 'const') return a.v === id ? { ...a, v: null } : a
    if (a.t === 'rel') {
      const args = {}
      for (const [k, v] of Object.entries(a.args ?? {})) args[k] = v?.k === 'var' && v.v === id ? { k: 'var', v: null } : v
      return { ...a, args }
    }
    if (a.t === 'opt' || a.t === 'not') return { ...a, vars: (a.vars ?? []).filter(v => v.id !== id), atoms: fixAtoms(a.atoms ?? []) }
    return a
  })
  return { vars: side.vars.filter(v => v.id !== id), atoms: fixAtoms(side.atoms) }
}

function MappingRuleEditor({ mappingId, ruleId }) {
  const state = useOrmStore(useShallow(s => ({
    schemas: s.schemas, objectTypes: s.objectTypes, facts: s.facts, constraints: s.constraints,
    subtypes: s.subtypes, mappings: s.mappings ?? [],
  })))
  const close = useOrmStore(s => s.closeMappingRuleEditor)
  const update = useOrmStore(s => s.updateMappingRule)
  const mapping = state.mappings.find(m => m.id === mappingId)
  const rule = mapping?.rules.find(r => r.id === ruleId)
  const ctxs = useMemo(() => (mapping ? {
    source: sideContext(state, mapping.sourceSchemaId),
    target: sideContext(state, mapping.targetSchemaId),
  } : null), [state, mapping])
  const issues = useMemo(() => (rule ? checkRule(rule, mapping, state, ctxs) : []), [rule, mapping, state, ctxs])

  // ── Panel position, size and folding ──
  const [panel, setPanel] = useState(() => {
    const p = loadPanel()
    const w = Math.min(p.w ?? 1000, window.innerWidth - 16)
    return { w, h: p.h ?? null, folded: !!p.folded, x: clampX(p.x ?? (window.innerWidth - w) / 2, w), y: clampY(p.y ?? 70) }
  })
  useEffect(() => { savePanel(panel) }, [panel])
  const panelRef = useRef(null)
  const startDrag = (e) => {
    if (e.button !== 0 || e.target.closest('button, input, select')) return
    e.preventDefault()
    const sx = e.clientX - panel.x, sy = e.clientY - panel.y
    const move = (ev) => setPanel(p => ({ ...p, x: clampX(ev.clientX - sx, p.w), y: clampY(ev.clientY - sy) }))
    const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up) }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }
  const keepSize = () => {
    const el = panelRef.current
    if (!el || panel.folded) return
    const w = el.offsetWidth, h = el.offsetHeight
    if (w !== panel.w || h !== panel.h) setPanel(p => ({ ...p, w, h }))
  }
  // Keys typed here are not canvas shortcuts.
  const onKeyDown = (e) => {
    e.stopPropagation()
    if (e.key === 'Escape') close()
  }

  if (!mapping || !rule) return null
  const schemaName = (id) => state.schemas.find(s => s.id === id)?.name ?? '?'
  const setSide = (side, value) => update(mapping.id, rule.id, r => ({ ...r, [side]: value }))

  return createPortal(
    <div ref={panelRef} role="dialog" aria-label="Mapping rule" tabIndex={-1}
      onKeyDown={onKeyDown} onMouseDown={e => e.stopPropagation()} onMouseUp={keepSize} style={{
        position: 'fixed', left: panel.x, top: panel.y, zIndex: 1000,
        width: panel.w, height: panel.folded ? 'auto' : panel.h ?? 'auto',
        minWidth: 480, minHeight: panel.folded ? 0 : 200, maxWidth: '100vw', maxHeight: `calc(100vh - ${panel.y}px)`,
        resize: panel.folded ? 'none' : 'both', display: 'flex', flexDirection: 'column',
        background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius)',
        boxShadow: 'var(--shadow-lg)', overflow: 'hidden',
      }}>
      <div onMouseDown={startDrag} onDoubleClick={e => { if (!e.target.closest('button, input, select')) setPanel(p => ({ ...p, folded: !p.folded })) }}
        title="Drag to move · double-click to fold"
        style={{ padding: '10px 14px', borderBottom: panel.folded ? 'none' : '1px solid var(--border-soft)', cursor: 'move', userSelect: 'none', background: 'var(--bg-raised)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--ink)' }}>Mapping rule</div>
          <input aria-label="Rule name" value={rule.name} placeholder="name"
            onChange={e => update(mapping.id, rule.id, { name: e.target.value })} style={{ ...input, fontFamily: 'inherit', width: 160 }} />
          <div style={{ flex: 1, fontSize: 12, color: 'var(--ink-muted)' }}>of {mapping.name} ({schemaName(mapping.sourceSchemaId)} → {schemaName(mapping.targetSchemaId)})</div>
          <button style={smallBtn} title={panel.folded ? 'Unfold' : 'Fold to the title bar'}
            onClick={() => setPanel(p => ({ ...p, folded: !p.folded }))}>{panel.folded ? '▸' : '▾'}</button>
          <button style={smallBtn} title="Close (Esc); changes are kept" onClick={close}>×</button>
        </div>
        {!panel.folded && <div style={{ fontSize: 11, color: 'var(--ink-muted)', marginTop: 2 }}>
          For all values of the frontier variables ŷ: the source pattern matches if and only if the target pattern does. Every other variable is existential and should be determined by the ŷ and the keys.
        </div>}
      </div>
      {!panel.folded && <div style={{ padding: 14, overflow: 'auto', flex: 1 }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) auto minmax(0,1fr)', gap: 12 }}>
          {SIDES.map((side, i) => (
            <React.Fragment key={side}>
              {i === 1 && <div style={{ alignSelf: 'center', fontSize: 18, ...MAPPING_TOKEN_STYLE.op }}>⟺</div>}
              <SideEditor title={`${side === 'source' ? 'Source' : 'Target'} · ${schemaName(sideSchemaId(mapping, side))}`}
                pattern={rule[side]} ctx={ctxs[side]} onChange={v => setSide(side, v)} />
            </React.Fragment>
          ))}
        </div>
        <div style={label}>Rule</div>
        <div data-text-panel tabIndex={0} className="copyable" style={{ outline: 'none' }}>
          <PatternText tokens={sideTokens(rule.source, ctxs.source)} />
          <PatternText tokens={[{ text: '  ⟺  ', kind: 'op' }]} />
          <PatternText tokens={sideTokens(rule.target, ctxs.target)} />
        </div>
        <div style={label}>Checks</div>
        <div data-text-panel tabIndex={0} className="copyable" style={{ outline: 'none' }}>
          <IssueList issues={issues} ok="This rule is well formed and key-safe." />
        </div>
      </div>}
    </div>,
    document.body,
  )
}

// One pattern: its variables and atoms.
function SideEditor({ title, pattern, ctx, onChange }) {
  const names = useMemo(() => variableNames(pattern, ctx), [pattern, ctx])
  const env = { ctx, names, deleteVar: (id) => onChange(dropVar(pattern, id)) }
  return (
    <div style={{ minWidth: 0 }}>
      <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--ink)', marginBottom: 4 }}>{title}</div>
      <div style={{ padding: '6px 8px', background: 'var(--bg-raised)', borderRadius: 3, marginBottom: 6 }}>
        <PatternText tokens={sideTokens(pattern, ctx)} />
      </div>
      <PartEditor part={pattern} scope={[]} env={env} onPart={p => onChange({ ...pattern, ...p })} />
    </div>
  )
}

const typeOptions = (ctx) => [...ctx.objectTypes].sort((a, b) => (a.name ?? '').localeCompare(b.name ?? ''))

// A conjunction: the variables it introduces and its atoms. Used for the
// whole pattern and for optional and negated parts.
function PartEditor({ part, scope, env, onPart }) {
  const { ctx, names } = env
  const vars = part.vars ?? [], atoms = part.atoms ?? []
  const inScope = [...scope, ...vars]
  const setAtom = (i, atom, newVar = null) => onPart({
    vars: newVar ? [...vars, newVar] : vars,
    atoms: atoms.map((a, j) => (j === i ? atom : a)),
  })
  const addAtom = (t) => {
    const fresh = {
      rel: { t: 'rel', tableId: null, args: {} },
      fact: { t: 'fact', factId: null, args: [] },
      type: { t: 'type', typeId: null, arg: null },
      bind: { t: 'bind', v: null, y: '' },
      const: { t: 'const', v: null, text: '' },
      opt: { t: 'opt', y: '', vars: [], atoms: [] },
      not: { t: 'not', vars: [], atoms: [] },
    }[t]
    if (fresh) onPart({ vars, atoms: [...atoms, fresh] })
  }
  return (
    <div>
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 4, marginBottom: 4 }}>
        <span style={{ fontSize: 11, color: 'var(--ink-muted)' }}>∃</span>
        {vars.map(v => (
          <span key={v.id} style={{ display: 'inline-flex', alignItems: 'center', gap: 2, padding: '0 2px 0 6px',
            border: '1px solid var(--border-soft)', borderRadius: 10, fontSize: 12 }}>
            <span style={MAPPING_TOKEN_STYLE.var}>{names.get(v.id)}</span>
            {names.get(v.id) !== ctx.otById.get(v.typeId)?.name && <span style={{ color: 'var(--ink-muted)' }}>: {ctx.otById.get(v.typeId)?.name ?? '?'}</span>}
            <button style={xBtn} title="Remove this variable" onClick={() => env.deleteVar(v.id)}>×</button>
          </span>
        ))}
        <select aria-label="Add a variable" value="" style={{ ...input, fontFamily: 'inherit', color: 'var(--ink-muted)' }}
          onChange={e => { if (e.target.value) onPart({ vars: [...vars, { id: newVarId(), typeId: e.target.value }], atoms }) }}>
          <option value="">+ variable of type…</option>
          {typeOptions(ctx).map(o => <option key={o.id} value={o.id}>{o.name}</option>)}
        </select>
      </div>
      {atoms.map((a, i) => (
        <div key={i} style={{ display: 'flex', alignItems: 'flex-start', gap: 4, padding: '3px 0', borderTop: '1px dotted var(--border-soft)' }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <AtomEditor atom={a} inScope={inScope} env={env} onAtom={(x, nv) => setAtom(i, x, nv)} />
          </div>
          <button style={xBtn} title="Remove this atom" onClick={() => onPart({ vars, atoms: atoms.filter((_, j) => j !== i) })}>×</button>
        </div>
      ))}
      <select aria-label="Add an atom" value="" style={{ ...input, fontFamily: 'inherit', color: 'var(--ink-muted)', marginTop: 4 }}
        onChange={e => addAtom(e.target.value)}>
        <option value="">+ atom…</option>
        {ctx.relational && <option value="rel">Table row  R(…)</option>}
        <option value="fact">Fact  p(x, y)</option>
        <option value="type">Type  T(x)</option>
        <option value="bind">Frontier binding  x ≈ ŷ</option>
        <option value="const">Constant  x ≈ 'c'</option>
        <option value="opt">Optional part  [ŷ](…)</option>
        <option value="not">Negation  ¬∃(…)</option>
      </select>
    </div>
  )
}

// A variable slot: the variables in scope that fit the type, or a new one.
function VarPick({ value, typeId, inScope, env, onPick }) {
  const { ctx, names } = env
  const fits = inScope.filter(v => !typeId || typesMeet(v.typeId, typeId, ctx))
  const typeName = typeId ? ctx.otById.get(typeId)?.name : null
  return (
    <select aria-label={typeName ? `Variable of ${typeName}` : 'Variable'} value={value ?? ''}
      onChange={e => {
        const val = e.target.value
        if (val === '__new') { const nv = { id: newVarId(), typeId }; onPick(nv.id, nv) } else onPick(val || null)
      }}
      style={{ ...input, ...MAPPING_TOKEN_STYLE.var, borderColor: value ? 'var(--border)' : 'var(--formula-hole, var(--border))' }}>
      <option value="">□</option>
      {fits.map(v => <option key={v.id} value={v.id}>{names.get(v.id)}{typeId && v.typeId !== typeId ? ` (${ctx.otById.get(v.typeId)?.name})` : ''}</option>)}
      {typeId && <option value="__new">+ new {typeName}</option>}
    </select>
  )
}

function FvInput({ value, onChange, optional }) {
  return (
    <span style={{ whiteSpace: 'nowrap' }}>
      <span style={MAPPING_TOKEN_STYLE.fv}>ŷ</span>
      <input aria-label="Frontier variable" value={value ?? ''} placeholder="name" size={Math.max(4, (value ?? '').length + 1)}
        onChange={e => onChange(e.target.value.replace(/\s+/g, '_'))} style={{ ...input, ...MAPPING_TOKEN_STYLE.fv }} />
      {optional && <span style={MAPPING_TOKEN_STYLE.fv}>?</span>}
    </span>
  )
}

function AtomEditor({ atom: a, inScope, env, onAtom }) {
  const { ctx } = env
  const op = (t) => <span style={MAPPING_TOKEN_STYLE.op}>{t}</span>
  const row = { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 4, fontSize: 12 }

  if (a.t === 'fact') {
    const f = ctx.factById.get(a.factId)
    const parts = f ? plainParts(f.readingParts ?? [], f.roles.length) : []
    const facts = [...ctx.facts].sort((x, y) => readingName(x, ctx).localeCompare(readingName(y, ctx)))
    return (
      <div style={row}>
        <select aria-label="Fact type" value={a.factId ?? ''} style={{ ...input, fontFamily: 'inherit', maxWidth: 220 }}
          onChange={e => {
            const nf = ctx.factById.get(e.target.value)
            onAtom({ ...a, factId: nf?.id ?? null, args: nf ? nf.roles.map(() => null) : [] })
          }}>
          <option value="">fact type…</option>
          {facts.map(x => <option key={x.id} value={x.id}>{readingName(x, ctx)}</option>)}
        </select>
        {f && f.roles.map((r, i) => (
          <React.Fragment key={i}>
            {parts[i]?.trim() && <span style={MAPPING_TOKEN_STYLE.reading}>{parts[i].trim()}</span>}
            <VarPick value={a.args[i]} typeId={r.objectTypeId} inScope={inScope} env={env}
              onPick={(id, nv) => onAtom({ ...a, args: a.args.map((x, j) => (j === i ? id : x)) }, nv)} />
          </React.Fragment>
        ))}
        {f && parts[f.roles.length]?.trim() && <span style={MAPPING_TOKEN_STYLE.reading}>{parts[f.roles.length].trim()}</span>}
      </div>
    )
  }
  if (a.t === 'type') {
    return (
      <div style={row}>
        <select aria-label="Type" value={a.typeId ?? ''} style={{ ...input, fontFamily: 'inherit', ...MAPPING_TOKEN_STYLE.type }}
          onChange={e => onAtom({ ...a, typeId: e.target.value || null })}>
          <option value="">type…</option>
          {typeOptions(ctx).map(o => <option key={o.id} value={o.id}>{o.name}</option>)}
        </select>
        {op('(')}
        <VarPick value={a.arg} typeId={a.typeId} inScope={inScope} env={env} onPick={(id, nv) => onAtom({ ...a, arg: id }, nv)} />
        {op(')')}
      </div>
    )
  }
  if (a.t === 'bind' || a.t === 'const') {
    return (
      <div style={row}>
        <VarPick value={a.v} typeId={null} inScope={inScope} env={env} onPick={(id) => onAtom({ ...a, v: id })} />
        {op('≈')}
        {a.t === 'bind'
          ? <FvInput value={a.y} onChange={y => onAtom({ ...a, y })} />
          : <input aria-label="Constant" value={a.text ?? ''} placeholder="value" onChange={e => onAtom({ ...a, text: e.target.value })}
              style={{ ...input, ...MAPPING_TOKEN_STYLE.const }} />}
      </div>
    )
  }
  if (a.t === 'rel') return <RelEditor atom={a} inScope={inScope} env={env} onAtom={onAtom} />
  if (a.t === 'opt' || a.t === 'not') {
    return (
      <div>
        <div style={row}>
          {a.t === 'opt'
            ? <>{op('[')}<FvInput value={a.y} onChange={y => onAtom({ ...a, y })} />{op(']')}
                <span style={{ color: 'var(--ink-muted)' }}>optional: ŷ{a.y || '□'} is the value found here, or NULL when nothing matches</span></>
            : <>{op('¬∃')}<span style={{ color: 'var(--ink-muted)' }}>no match for:</span></>}
        </div>
        <div style={{ marginLeft: 12, paddingLeft: 8, borderLeft: '2px solid var(--border-soft)' }}>
          <PartEditor part={a} scope={inScope} env={env} onPart={p => onAtom({ ...a, ...p })} />
        </div>
      </div>
    )
  }
  return <span style={{ color: 'var(--ink-muted)' }}>unknown atom</span>
}

const ARG_KINDS = [
  { k: '', text: '_', title: 'any value' },
  { k: 'fv', text: 'ŷ', title: 'the value is a frontier variable' },
  { k: 'opt', text: 'ŷ?', title: 'the value, or NULL if the column has none' },
  { k: 'const', text: "'c'", title: 'a constant' },
  { k: 'absent', text: '−', title: 'the column has no value (NULL)' },
  { k: 'var', text: 'x', title: 'a variable of the pattern' },
]

// A table row R(col: arg, …): one line per column.
function RelEditor({ atom: a, inScope, env, onAtom }) {
  const { ctx } = env
  const table = ctx.tableById.get(a.tableId)
  const setArg = (fid, arg, nv) => {
    const args = { ...(a.args ?? {}) }
    if (arg) args[fid] = arg; else delete args[fid]
    onAtom({ ...a, args }, nv)
  }
  const tables = [...ctx.tables].sort((x, y) => x.name.localeCompare(y.name))
  return (
    <div>
      <select aria-label="Table" value={a.tableId ?? ''} style={{ ...input, fontFamily: 'inherit', ...MAPPING_TOKEN_STYLE.type }}
        onChange={e => onAtom({ ...a, tableId: e.target.value || null, args: {} })}>
        <option value="">table…</option>
        {tables.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
      </select>
      {table && <div style={{ display: 'grid', gridTemplateColumns: 'auto auto 1fr', gap: '2px 6px', alignItems: 'center', marginTop: 3, marginLeft: 12 }}>
        {table.columns.map(col => {
          const arg = a.args?.[col.fact.id]
          return (
            <React.Fragment key={col.fact.id}>
              <span style={{ ...MAPPING_TOKEN_STYLE.reading, fontFamily: 'var(--font-mono)', fontSize: 12, ...(col.pk && { fontWeight: 700, textDecoration: 'underline' }) }}
                title={`${col.vt.name}${col.pk ? ', primary key' : ''}${col.notNull ? ', not null' : ''}`}>
                {col.name}
              </span>
              <select aria-label={`${col.name} argument`} value={arg?.k ?? ''} style={{ ...input, width: 52 }}
                onChange={e => {
                  const k = e.target.value
                  if (!k) setArg(col.fact.id, null)
                  else if (k === 'fv' || k === 'opt') setArg(col.fact.id, { k, y: arg?.y ?? col.name.toLowerCase() })
                  else if (k === 'const') setArg(col.fact.id, { k, text: '' })
                  else if (k === 'var') setArg(col.fact.id, { k, v: null })
                  else setArg(col.fact.id, { k })
                }}>
                {ARG_KINDS.map(o => <option key={o.k} value={o.k} title={o.title}>{o.text}</option>)}
              </select>
              <span>
                {(arg?.k === 'fv' || arg?.k === 'opt') && <FvInput value={arg.y} optional={arg.k === 'opt'} onChange={y => setArg(col.fact.id, { ...arg, y })} />}
                {arg?.k === 'const' && <input aria-label="Constant" value={arg.text ?? ''} placeholder="value"
                  onChange={e => setArg(col.fact.id, { ...arg, text: e.target.value })} style={{ ...input, ...MAPPING_TOKEN_STYLE.const }} />}
                {arg?.k === 'var' && <VarPick value={arg.v} typeId={col.vt.id} inScope={inScope} env={env}
                  onPick={(id, nv) => setArg(col.fact.id, { ...arg, v: id }, nv)} />}
              </span>
            </React.Fragment>
          )
        })}
      </div>}
    </div>
  )
}
