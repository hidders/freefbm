import React, { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useShallow } from 'zustand/react/shallow'
import { useOrmStore } from '../store/ormStore'
import { sideContext, sideTokens, checkRule, variableNames, readingName, newVarId, SIDES, sideSchemaId } from '../mapping/mapping.js'
import { getAt, setAt, hole, typeGraph } from '../logic/derivationRule.js'
import { QGAP } from '../logic/renderFormula.js'
import { plainParts } from '../verbalisation/hyphenBinding.js'
import { handleTextPanelKey } from '../utils/textPanel.js'
import { TOKEN_STYLE } from './ConstraintsTab.jsx'
import { VarSelect, ConstInput, btn, selectStyle, sectionLabel } from './DerivationRuleEditor.jsx'
import { PatternText, IssueList, MAPPING_TOKEN_STYLE } from './MappingFormula.jsx'
import { tableRulesOf, tableRuleAsMapping, checkTableRule, bodyFrontier, TABLE_RULE_KINDS } from '../relational/derivedTables.js'

// ── Mapping rule editor ─────────────────────────────────────────────────────
// The derivation rule editor's syntax-directed way of editing, for the two
// patterns of a mapping rule φ ⟺ ψ (mapping/mapping.js). A pattern is a rule
// tree restricted to ∃, ∧ and atoms, with table rows, x ≈ $y bindings, optional
// parts [$y](…) and negations ¬(…). Clicking a part selects it, and the panel
// below offers what can go there or what to wrap it in. Edits apply to the
// rule at once (and can be undone).

// The open mapping rule editor, if any (store.mappingRuleEditor).
export function MappingRuleEditorPanel() {
  const target = useOrmStore(s => s.mappingRuleEditor)
  const advanced = useOrmStore(s => s.advancedMode)
  if (!target) return null
  // A table's rule (derived tables and columns) is part of its schema, so it
  // opens in Basic mode too.
  if (target.tableId) return <TableRuleEditor key={`table:${target.tableId}:${target.ruleId}`} tableId={target.tableId} ruleId={target.ruleId} />
  if (!advanced) return null
  return <MappingRuleEditor key={`${target.mappingId}:${target.ruleId}`} mappingId={target.mappingId} ruleId={target.ruleId} />
}

function MappingRuleEditor({ mappingId, ruleId }) {
  const mapping = useOrmStore(s => s.mappings?.find(m => m.id === mappingId))
  const update = useOrmStore(s => s.updateMappingRule)
  const rule = mapping?.rules.find(r => r.id === ruleId)
  if (!mapping || !rule) return null
  return <RuleEditor mapping={mapping} rule={rule} onUpdate={(patch) => update(mapping.id, rule.id, patch)} />
}

// A table rule T(…) ⟺ φ, edited as a mapping rule of the table's schema onto
// itself: the query φ is the source side, the row the target side (only its
// columns can be chosen).
function TableRuleEditor({ tableId, ruleId }) {
  const table = useOrmStore(s => s.objectTypes.find(o => o.id === tableId))
  const updateTableRule = useOrmStore(s => s.updateTableRule)
  const rule = tableRulesOf(table).find(r => r.id === ruleId)
  const as = useMemo(() => (table && rule ? tableRuleAsMapping(table, rule) : null), [table, rule])
  if (!as) return null
  const onUpdate = (patch) => updateTableRule(tableId, ruleId, r => {
    if (typeof patch !== 'function') return { ...r, ...patch }
    const next = patch(tableRuleAsMapping(table, r).rule)
    const head = next.target?.t === 'rel' && next.target.tableId === tableId ? next.target.args ?? {} : r.head
    return { ...r, name: next.name ?? r.name, body: next.source, head }
  })
  return <RuleEditor mapping={as.mapping} rule={as.rule} onUpdate={onUpdate} table={table} tableRule={rule} />
}

const PANEL_KEY = 'freefbm.mappingEditor.panel'
const loadPanel = () => { try { return JSON.parse(localStorage.getItem(PANEL_KEY)) ?? {} } catch { return {} } }
const savePanel = (p) => { try { localStorage.setItem(PANEL_KEY, JSON.stringify(p)) } catch { /* not kept */ } }
const clampX = (x, w) => Math.min(Math.max(0, x), Math.max(0, window.innerWidth - w))
const clampY = (y) => Math.min(Math.max(0, y), window.innerHeight - 44)

// Rendered without parentheses as the body of ∃ or after ¬.
const ATOMIC = new Set(['fact', 'type', 'rel', 'hole', 'not', 'opt', 'exists'])
const keyOf = (sel) => (sel ? `${sel.side}:${sel.path.join('.')}` : '')

// The variables bound above a path: those of every ∃ whose body it is in.
const scopeAt = (tree, path) => {
  const out = []
  let n = tree
  for (const k of path) {
    if (n?.t === 'exists' && k === 'body' && n.v) out.push({ id: n.v.id, typeIds: [n.v.typeId] })
    n = n?.[k]
  }
  return out
}

// Where a new variable for a slot at path is quantified: at the top of the
// innermost optional or negated part around it, or of the whole pattern.
const anchorOf = (tree, path) => {
  let anchor = [], n = tree
  path.forEach((k, i) => {
    if ((n?.t === 'opt' && k === 'body') || (n?.t === 'not' && k === 'arg')) anchor = path.slice(0, i + 1)
    n = n?.[k]
  })
  return anchor
}

const COL_KINDS = [
  { k: '', text: '_', title: 'any value' },
  { k: 'fv', text: '$y', title: 'the value is a frontier variable' },
  { k: 'opt', text: '$y?', title: 'the value, or NULL if the column has none' },
  { k: 'const', text: "'c'", title: 'a constant' },
  { k: 'absent', text: '−', title: 'the column has no value (NULL)' },
  { k: 'var', text: 'x', title: 'a variable of the pattern' },
]

function RuleEditor({ mapping, rule, onUpdate, table = null, tableRule = null }) {
  const state = useOrmStore(useShallow(s => ({
    schemas: s.schemas, objectTypes: s.objectTypes, facts: s.facts, constraints: s.constraints,
    subtypes: s.subtypes, mappings: s.mappings ?? [],
  })))
  const close = useOrmStore(s => s.closeMappingRuleEditor)
  const ctxs = useMemo(() => {
    if (!mapping) return null
    const source = sideContext(state, mapping.sourceSchemaId)
    return { source, target: mapping.targetSchemaId === mapping.sourceSchemaId ? source : sideContext(state, mapping.targetSchemaId) }
  }, [state, mapping.sourceSchemaId, mapping.targetSchemaId])
  const graphs = useMemo(() => (ctxs ? {
    source: typeGraph({ subtypes: ctxs.source.subtypes, constraints: ctxs.source.constraints }),
    target: typeGraph({ subtypes: ctxs.target.subtypes, constraints: ctxs.target.constraints }),
  } : null), [ctxs])
  const names = useMemo(() => (rule ? {
    source: variableNames(rule.source, ctxs.source), target: variableNames(rule.target, ctxs.target),
  } : null), [rule, ctxs])
  const issues = useMemo(() => (table ? checkTableRule(state, table, tableRule, ctxs.source)
    : rule ? checkRule(rule, mapping, state, ctxs) : []), [rule, mapping, state, ctxs, table, tableRule])
  const [sel, setSel] = useState({ side: 'source', path: [] })

  // ── Panel position, size and folding ──
  const [panel, setPanel] = useState(() => {
    const p = loadPanel()
    const w = Math.min(p.w ?? 820, window.innerWidth - 16)
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

  if (!mapping || !rule) return null
  const schemaName = (id) => state.schemas.find(s => s.id === id)?.name ?? '?'

  // Edits of one side's tree.
  const setTree = (side, fn) => onUpdate(r => ({ ...r, [side]: fn(r[side] ?? hole()) }))
  const replace = (side, path, node, nextPath = path) => { setTree(side, t => setAt(t, path, node)); setSel({ side, path: nextPath }) }

  const onKeyDown = (e) => {
    // Keep the canvas shortcuts out of the editor.
    e.stopPropagation()
    if (e.key === 'Escape') { e.preventDefault(); close(); return }
    if (handleTextPanelKey(e)) return
    const typing = /^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName)
    if (!typing && (e.key === 'Delete' || e.key === 'Backspace')) {
      e.preventDefault()
      const n = getAt(rule[sel.side], sel.path)
      if (n && n.t !== 'hole') replace(sel.side, sel.path, hole())
    }
  }

  // A variable slot of an atom at path. "+ new T" quantifies a new variable at
  // the top of the enclosing part and puts it in the slot (newOf builds the
  // atom with it).
  const varPicker = (side, path, value, scope, placeId, onChange, newOf) => {
    const ctx = ctxs[side]
    const onNew = placeId && newOf ? () => {
      const v = { id: newVarId(), typeId: placeId }
      const anchor = anchorOf(rule[side], path)
      const moved = [...anchor, 'body', ...path.slice(anchor.length)]
      setTree(side, t => {
        const wrapped = setAt(t, anchor, { t: 'exists', v, body: getAt(t, anchor) })
        return setAt(wrapped, moved, newOf(v.id))
      })
      setSel({ side, path: moved })
    } : null
    return (
      <VarSelect value={value} scope={scope} nameOf={names[side]} graph={graphs[side]} placeId={placeId}
        ctx={{ typeName: (id) => ctx.otById.get(id)?.name ?? '?' }} onChange={onChange}
        onFocus={() => setSel({ side, path })} onNew={onNew} />
    )
  }

  // A frontier variable's name, typed in place.
  const fvInput = (side, path, value, onChange, optional = false) => (
    <span style={{ whiteSpace: 'nowrap' }}>
      <span style={MAPPING_TOKEN_STYLE.fv}>$</span>
      <input aria-label="Frontier variable" value={value ?? ''} placeholder="name" onClick={e => e.stopPropagation()}
        onFocus={() => setSel({ side, path })} onChange={e => onChange(e.target.value.replace(/^\$+/, '').replace(/\s+/g, '_'))}
        style={{ ...MAPPING_TOKEN_STYLE.fv, font: 'inherit', fontWeight: 700, background: 'transparent', border: 'none',
          borderBottom: '1px dashed var(--formula-fn)', padding: '0 1px', width: `${String(value ?? '').length ? String(value).length + 0.5 : 4}ch` }} />
      {optional && <span style={MAPPING_TOKEN_STYLE.fv}>?</span>}
    </span>
  )

  // A table row's column argument, as shown in the formula.
  const colArg = (side, path, n, col, scope) => {
    const arg = n.args[col.fact.id]
    const setArg = (a) => replace(side, path, { ...n, args: { ...n.args, [col.fact.id]: a } })
    if (arg.k === 'fv' || arg.k === 'opt') return fvInput(side, path, arg.y, y => setArg({ ...arg, y }), arg.k === 'opt')
    if (arg.k === 'const') return <ConstInput value={arg.text ?? ''} onFocus={() => setSel({ side, path })} onChange={text => setArg({ ...arg, text })} />
    if (arg.k === 'absent') return <span style={TOKEN_STYLE.op}>−</span>
    if (arg.k === 'var') return varPicker(side, path, arg.v, scope, col.vt.id, (id) => setArg({ k: 'var', v: id }),
      (id) => ({ ...n, args: { ...n.args, [col.fact.id]: { k: 'var', v: id } } }))
    return '_'
  }

  // ── Formula view ──
  const render = (side, n, path, scope) => {
    const ctx = ctxs[side]
    const selected = keyOf(sel) === keyOf({ side, path })
    const wrapStyle = {
      borderRadius: 3, cursor: 'pointer', padding: '0 1px',
      background: selected ? 'var(--formula-sel-bg)' : undefined,
      outline: selected ? '1px solid var(--formula-sel)' : undefined,
    }
    const sub = (key, wrap, inScope = scope) => {
      const k = Array.isArray(key) ? key : [key]
      const inner = render(side, getAt(n, k), [...path, ...k], inScope)
      return wrap ? <>{'('}{inner}{')'}</> : inner
    }
    let body
    switch (n?.t) {
      case 'hole': case undefined:
        body = <span style={{ color: 'var(--formula-hole)', fontWeight: 600 }} title="Not filled in yet">□</span>
        break
      case 'and':
        body = n.args.map((a, i) => (
          <React.Fragment key={i}>
            {i > 0 && <span style={TOKEN_STYLE.op}> ∧ </span>}
            {sub(['args', i], a?.t === 'and' || (a?.t === 'exists' && i < n.args.length - 1))}
          </React.Fragment>
        ))
        break
      case 'exists': {
        const inner = [...scope, { id: n.v.id, typeIds: [n.v.typeId] }]
        body = <>
          <span style={TOKEN_STYLE.op}>∃</span><span style={TOKEN_STYLE.qgap}>{QGAP}</span>
          <span style={TOKEN_STYLE.var} title={`ranges over ${ctx.otById.get(n.v.typeId)?.name ?? '?'}`}>{names[side].get(n.v.id)}</span>
          {' '}{sub('body', !ATOMIC.has(n.body?.t), inner)}
        </>
        break
      }
      case 'fact': {
        const f = ctx.factById.get(n.factId)
        const parts = plainParts(f?.readingParts ?? [], f?.roles.length ?? 0)
        const words = []
        f?.roles.forEach((r, i) => {
          if (parts[i]?.trim()) words.push(<span key={`p${i}`} style={TOKEN_STYLE.reading}>{parts[i].trim()}</span>)
          const withArg = (id) => ({ ...n, args: n.args.map((a, j) => (j === i ? id : a)) })
          words.push(<React.Fragment key={`v${i}`}>{varPicker(side, path, n.args[i], scope, r.objectTypeId,
            (id) => replace(side, path, withArg(id)), withArg)}</React.Fragment>)
        })
        const last = f?.roles.length ?? 0
        if (parts[last]?.trim()) words.push(<span key="end" style={TOKEN_STYLE.reading}>{parts[last].trim()}</span>)
        body = f ? <>{'('}{words.map((w, i) => <React.Fragment key={i}>{i > 0 && ' '}{w}</React.Fragment>)}{')'}</>
          : <span style={{ color: 'var(--danger)' }}>(a deleted fact type)</span>
        break
      }
      case 'type':
        body = <>
          <span style={TOKEN_STYLE.type}>{ctx.otById.get(n.typeId)?.name ?? '?'}</span>{'('}
          {varPicker(side, path, n.arg, scope, n.typeId, (id) => replace(side, path, { ...n, arg: id }), (id) => ({ ...n, arg: id }))}{')'}
        </>
        break
      case 'vcmp':
        body = <>
          {varPicker(side, path, n.left?.id ?? null, scope, null, (id) => replace(side, path, { ...n, left: { t: 'var', id } }))}
          <span style={TOKEN_STYLE.op}> ≈ </span>
          {n.right?.t === 'fv'
            ? fvInput(side, path, n.right.y, y => replace(side, path, { ...n, right: { t: 'fv', y } }))
            : <ConstInput value={n.right?.text ?? ''} onFocus={() => setSel({ side, path })}
                onChange={text => replace(side, path, { ...n, right: { t: 'const', text } })} />}
        </>
        break
      case 'rel': {
        const tb = ctx.tableById.get(n.tableId)
        const cols = (tb?.columns ?? []).filter(c => n.args?.[c.fact.id])
        body = tb ? <>
          <span style={TOKEN_STYLE.type}>{tb.name}</span>{'('}
          {cols.map((c, i) => (
            <React.Fragment key={c.fact.id}>{i > 0 && ', '}
              <span style={TOKEN_STYLE.reading}>{c.name}: </span>{colArg(side, path, n, c, scope)}
            </React.Fragment>
          ))}
          {cols.length < tb.columns.length && <span style={{ color: 'var(--ink-muted)' }}>{cols.length ? ', …' : '…'}</span>}{')'}
        </> : <span style={{ color: 'var(--danger)' }}>(a deleted table)</span>
        break
      }
      case 'opt':
        body = <>
          <span style={MAPPING_TOKEN_STYLE.fv}>[</span>
          {fvInput(side, path, n.y, y => replace(side, path, { ...n, y }))}
          <span style={MAPPING_TOKEN_STYLE.fv}>]</span>
          {sub('body', true)}
        </>
        break
      case 'not':
        body = <><span style={TOKEN_STYLE.op}>¬</span>{sub('arg', !ATOMIC.has(n.arg?.t) || n.arg?.t === 'opt')}</>
        break
      case 'true':
        body = <span style={TOKEN_STYLE.op}>⊤</span>
        break
      default:
        body = <span style={{ color: 'var(--danger)' }}>{n.t}?</span>
    }
    const click = (e) => { e.stopPropagation(); setSel({ side, path }) }
    return <span onClick={click} style={wrapStyle}>{body}</span>
  }

  const selTree = rule[sel.side] ?? hole()
  const selNode = getAt(selTree, sel.path)

  return createPortal(
    <div ref={panelRef} role="dialog" aria-label="Mapping rule" tabIndex={-1}
      onKeyDown={onKeyDown} onMouseDown={e => e.stopPropagation()} onMouseUp={keepSize} style={{
        position: 'fixed', left: panel.x, top: panel.y, zIndex: 1000,
        width: panel.w, height: panel.folded ? 'auto' : panel.h ?? 'auto',
        minWidth: 420, minHeight: panel.folded ? 0 : 200, maxWidth: '100vw', maxHeight: `calc(100vh - ${panel.y}px)`,
        resize: panel.folded ? 'none' : 'both', display: 'flex', flexDirection: 'column',
        background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius)',
        boxShadow: 'var(--shadow-lg)', overflow: 'hidden',
      }}>
      <div onMouseDown={startDrag} onDoubleClick={e => { if (!e.target.closest('button, input, select')) setPanel(p => ({ ...p, folded: !p.folded })) }}
        title="Drag to move · double-click to fold"
        style={{ padding: '10px 14px', borderBottom: panel.folded ? 'none' : '1px solid var(--border-soft)', cursor: 'move', userSelect: 'none', background: 'var(--bg-raised)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--ink)' }}>{table ? (tableRule.kind === 'table' ? 'Derived table' : 'Derived columns') : 'Mapping rule'}</div>
          <input aria-label="Rule name" value={rule.name} placeholder="name"
            onChange={e => onUpdate({ name: e.target.value })} style={{ ...selectStyle, width: 150 }} />
          <div style={{ flex: 1, fontSize: 12, color: 'var(--ink-muted)' }}>{table
            ? <>of table {table.name} ({schemaName(table.schemaId)})</>
            : <>of {mapping.name} ({schemaName(mapping.sourceSchemaId)} → {schemaName(mapping.targetSchemaId)})</>}</div>
          <button style={btn()} title={panel.folded ? 'Unfold' : 'Fold to the title bar'}
            onClick={() => setPanel(p => ({ ...p, folded: !p.folded }))}>{panel.folded ? '▸' : '▾'}</button>
          <button style={btn()} title="Close (Esc); changes are kept" onClick={close}>×</button>
        </div>
        {!panel.folded && <div style={{ fontSize: 11, color: 'var(--ink-muted)', marginTop: 2 }}>
          {table ? (tableRule.kind === 'table'
            ? `The rows of ${table.name} are the key values the query gives; each other column of the row takes the value the query gives with them ($y? : NULL when its optional part does not match).`
            : `For each row of ${table.name}, the columns of the row take the values the query gives for its key ($y? : NULL when its optional part does not match).`)
            : 'For all values of the frontier variables $y: the source pattern matches if and only if the target pattern does. Every other variable should be determined by the $y and the keys.'}
        </div>}
      </div>
      {!panel.folded && <div style={{ padding: 14, overflow: 'auto', flex: 1 }}>
        {(table ? ['target', 'source'] : SIDES).map((side, i) => (
          <React.Fragment key={side}>
            {i === 1 && <div style={{ ...MAPPING_TOKEN_STYLE.op, fontSize: 18, margin: '4px 0' }}>{table && tableRule.mode === 'semiDerived' ? '⟸' : '⟺'}</div>}
            <div style={sectionLabel}>{table ? (side === 'target' ? `Row of ${table.name}` : 'Query') : `${side === 'source' ? 'Source' : 'Target'} · ${schemaName(sideSchemaId(mapping, side))}`}</div>
            <div tabIndex={0} onClick={() => setSel({ side, path: [] })} className="text-panel" style={{
              fontFamily: 'var(--font-mono)', fontSize: 13, lineHeight: 2, minHeight: 30, outline: 'none',
              padding: '2px 6px', borderRadius: 3, background: sel.side === side ? 'var(--bg-raised)' : undefined,
            }}>
              {render(side, rule[side] ?? hole(), [], [])}
            </div>
          </React.Fragment>
        ))}

        <Palette key={keyOf(sel)} side={sel.side} node={selNode} path={sel.path} tree={selTree}
          scope={scopeAt(selTree, sel.path)} ctx={ctxs[sel.side]} graph={graphs[sel.side]}
          headOnly={!!table && sel.side === 'target'} label={table ? (sel.side === 'target' ? 'Row' : 'Query') : null}
          replace={(path, node, next) => replace(sel.side, path, node, next)} />

        {table && <TableRuleControls table={table} rule={tableRule} ctx={ctxs.source} />}

        <div style={{ ...sectionLabel, marginTop: 12 }}>Checks</div>
        <div data-text-panel tabIndex={0} className="copyable" style={{ outline: 'none' }}>
          <IssueList issues={issues} ok={table ? 'This rule is well formed: the table and its columns are derived by it.' : 'This rule is well formed and key-safe.'} />
        </div>
        <div style={{ ...sectionLabel, marginTop: 12 }}>{table ? 'As a formula' : 'As listed in the Mappings tab'}</div>
        <div data-text-panel tabIndex={0} className="copyable" style={{ outline: 'none' }}>
          {table ? <>
            <PatternText tokens={sideTokens(rule.target, ctxs.target)} />
            <PatternText tokens={[{ text: tableRule.mode === 'semiDerived' ? '  ⟸  ' : '  ⟺  ', kind: 'op' }]} />
            <PatternText tokens={sideTokens(rule.source, ctxs.source)} />
          </> : <>
            <PatternText tokens={sideTokens(rule.source, ctxs.source)} />
            <PatternText tokens={[{ text: '  ⟺  ', kind: 'op' }]} />
            <PatternText tokens={sideTokens(rule.target, ctxs.target)} />
          </>}
        </div>
      </div>}
      {!panel.folded && <div style={{ padding: '6px 14px', borderTop: '1px solid var(--border-soft)', fontSize: 11, color: 'var(--ink-muted)' }}>
        Click a part to select it · Delete clears it · Esc closes · changes apply at once and can be undone
      </div>}
    </div>,
    document.body,
  )
}

// ── Palette: what can go in, or be done with, the selected part ────────────

function Palette({ side, node, path, tree, scope, ctx, graph, replace, headOnly = false, label = null }) {
  const types = useMemo(() => [...ctx.objectTypes].sort((a, b) => (a.name ?? '').localeCompare(b.name ?? '')), [ctx])
  const facts = useMemo(() => ctx.facts.map(f => ({ id: f.id, label: readingName(f, ctx) }))
    .sort((a, b) => a.label.localeCompare(b.label)), [ctx])
  const tables = useMemo(() => [...ctx.tables].sort((a, b) => a.name.localeCompare(b.name)), [ctx])
  const [qType, setQType] = useState(() => types[0]?.id ?? '')

  // The innermost variable in scope that fits a place for instances of placeId.
  const fitting = (placeId) => [...scope].reverse().find(v => graph.fit(v.typeIds, placeId) === 'ok')?.id ?? null
  const factAtom = (id) => {
    const f = ctx.factById.get(id)
    return f ? { t: 'fact', factId: f.id, args: f.roles.map(r => fitting(r.objectTypeId)) } : null
  }
  const parentPath = path.length ? path.slice(0, path[path.length - 2] === 'args' ? -2 : -1) : null
  const parent = parentPath ? getAt(tree, parentPath) : null
  const lastVar = [...scope].reverse()[0]?.id ?? null

  const typeSelect = (value, onChange, placeholder) => (
    <select value={value} onChange={e => e.target.value && onChange(e.target.value)} style={selectStyle}>
      {placeholder && <option value="">{placeholder}</option>}
      {types.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
    </select>
  )
  const factSelect = (value, onPick) => (
    <select value={value} style={{ ...selectStyle, maxWidth: 380 }} onChange={e => { const a = factAtom(e.target.value); if (a) onPick(a) }}>
      {!value && <option value="">Choose a fact type…</option>}
      {facts.map(f => <option key={f.id} value={f.id}>{f.label}</option>)}
    </select>
  )
  const tableSelect = (value, onPick) => (
    <select value={value} style={selectStyle} onChange={e => e.target.value && onPick(e.target.value)}>
      {!value && <option value="">Choose a table…</option>}
      {tables.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
    </select>
  )
  const exists = (body) => ({ t: 'exists', v: { id: newVarId(), typeId: qType }, body })

  const rows = []
  const kinds = headOnly ? COL_KINDS.filter(o => ['', 'fv', 'opt'].includes(o.k)) : COL_KINDS
  if (headOnly) {
    // The row of a table rule: only which columns it gives, and how.
    node = getAt(tree, [])
    path = []
  }
  if (headOnly && node?.t !== 'rel') {
    rows.push(['Row', <span style={{ color: 'var(--ink-muted)', fontSize: 12 }}>The row is not a row of the table.</span>])
  } else if (!headOnly && (!node || node.t === 'hole')) {
    rows.push(['Connective', <>
      <button style={btn()} onClick={() => replace(path, { t: 'and', args: [hole(), hole()] }, [...path, 'args', 0])}>□ ∧ □</button>
      <button style={btn()} title="An optional part: $y is its value, or NULL when it does not match"
        onClick={() => replace(path, { t: 'opt', y: '', body: hole() }, [...path, 'body'])}>[$y](□)</button>
      <button style={btn()} title="No match for the part" onClick={() => replace(path, { t: 'not', arg: hole() }, [...path, 'arg'])}>¬ □</button>
    </>])
    rows.push(['Quantifier', <>
      {typeSelect(qType, setQType)}
      <button style={btn()} disabled={!qType} onClick={() => replace(path, exists(hole()), [...path, 'body'])}>∃</button>
    </>])
    if (ctx.relational) rows.push(['Table row', tableSelect('', (tableId) => replace(path, { t: 'rel', tableId, args: {} }))])
    rows.push(['Fact type', factSelect('', (a) => replace(path, a))])
    rows.push(['Type', typeSelect('', (typeId) => replace(path, { t: 'type', typeId, arg: fitting(typeId) }), 'Is a type…')])
    rows.push(['Value', <>
      <button style={btn()} title="The variable's value is the frontier variable $y"
        onClick={() => replace(path, { t: 'vcmp', op: '≈', left: { t: 'var', id: lastVar }, right: { t: 'fv', y: '' } })}>□ ≈ $y</button>
      <button style={btn()} title="The variable's value is a constant"
        onClick={() => replace(path, { t: 'vcmp', op: '≈', left: { t: 'var', id: lastVar }, right: { t: 'const', text: '' } })}>□ ≈ 'c'</button>
    </>])
  } else {
    if (!headOnly) rows.push(['Wrap in', <>
      <button style={btn()} onClick={() => replace(path, { t: 'and', args: [node, hole()] }, [...path, 'args', 1])}>… ∧ □</button>
      <button style={btn()} title="Make this part optional: $y is its value, or NULL when it does not match"
        onClick={() => replace(path, { t: 'opt', y: '', body: node }, path)}>[$y](…)</button>
      <button style={btn()} onClick={() => replace(path, { t: 'not', arg: node }, path)}>¬ …</button>
      {typeSelect(qType, setQType)}
      <button style={btn()} disabled={!qType} onClick={() => replace(path, exists(node), path)}>∃ …</button>
    </>])
    if (!headOnly && node.t === 'and') rows.push(['Operands',
      <button style={btn()} onClick={() => replace(path, { ...node, args: [...node.args, hole()] }, [...path, 'args', node.args.length])}>Add operand</button>])
    if (node.t === 'exists') rows.push(['Variable', typeSelect(node.v.typeId, (typeId) => replace(path, { ...node, v: { ...node.v, typeId } }))])
    if (node.t === 'fact') rows.push(['Fact type', factSelect(node.factId, (a) => replace(path, a))])
    if (node.t === 'type') rows.push(['Type', typeSelect(node.typeId, (typeId) => replace(path, { ...node, typeId }))])
    if (node.t === 'vcmp') rows.push(['Value', (
      <select value={node.right?.t === 'fv' ? 'fv' : 'const'} style={selectStyle}
        onChange={e => replace(path, { ...node, right: e.target.value === 'fv' ? { t: 'fv', y: '' } : { t: 'const', text: '' } })}>
        <option value="fv">a frontier variable $y</option>
        <option value="const">a constant</option>
      </select>
    )])
    if (node.t === 'rel') {
      const tb = ctx.tableById.get(node.tableId)
      if (!headOnly) rows.push(['Table', tableSelect(node.tableId, (tableId) => replace(path, { t: 'rel', tableId, args: {} }))])
      if (tb) rows.push(['Columns', (
        <div style={{ display: 'grid', gridTemplateColumns: 'auto auto 1fr', gap: '2px 8px', alignItems: 'center', fontSize: 12 }}>
          {tb.columns.map(col => {
            const arg = node.args?.[col.fact.id]
            const setArg = (a) => {
              const args = { ...node.args }
              if (a) args[col.fact.id] = a; else delete args[col.fact.id]
              replace(path, { ...node, args })
            }
            return (
              <React.Fragment key={col.fact.id}>
                <span style={{ fontFamily: 'var(--font-mono)', ...TOKEN_STYLE.reading, ...(col.pk && { fontWeight: 700, textDecoration: 'underline' }) }}
                  title={`${col.vt.name}${col.pk ? ', primary key' : ''}${col.notNull ? ', not null' : ''}`}>{col.name}</span>
                <select aria-label={`${col.name} argument`} value={arg?.k ?? ''} style={{ ...selectStyle, width: 56 }}
                  onChange={e => {
                    const k = e.target.value
                    if (!k) setArg(null)
                    else if (k === 'fv' || k === 'opt') setArg({ k, y: arg?.y ?? col.name.toLowerCase() })
                    else if (k === 'const') setArg({ k, text: '' })
                    else if (k === 'var') setArg({ k, v: fitting(col.vt.id) })
                    else setArg({ k })
                  }}>
                  {kinds.map(o => <option key={o.k} value={o.k} title={o.title}>{o.text}</option>)}
                </select>
                <span style={{ color: 'var(--ink-muted)' }}>{headOnly && !arg ? (col.pk ? 'key column: give it $y' : 'not given by this rule') : COL_KINDS.find(o => o.k === (arg?.k ?? ''))?.title}</span>
              </React.Fragment>
            )
          })}
        </div>
      )])
    }
    if (!headOnly) rows.push(['Remove', <>
      <button style={btn()} onClick={() => replace(path, hole())}>Clear</button>
      {parent && ['and', 'exists', 'not', 'opt'].includes(parent.t) && (
        <button style={btn()} title="Replace the enclosing part by this part"
          onClick={() => replace(parentPath, node, parentPath)}>Lift out of {{ and: '∧', exists: '∃', not: '¬', opt: '[$y]' }[parent.t]}</button>
      )}
    </>])
  }

  return (
    <div style={{ marginTop: 12, padding: 10, background: 'var(--bg-raised)', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-soft)' }}>
      <div style={{ fontSize: 10, color: 'var(--accent)', fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: 6 }}>
        {label ?? (side === 'source' ? 'Source' : 'Target')}: {headOnly ? 'its columns' : !node || node.t === 'hole' ? 'fill in the selected □' : 'selected part'}
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

// ── Table rules: mode, and columns for the query's $y ───────────────────────

function TableRuleControls({ table, rule, ctx }) {
  const updateTableRule = useOrmStore(s => s.updateTableRule)
  const addColumn = useOrmStore(s => s.addTableRuleColumn)
  const [names, setNames] = useState({})
  const tb = ctx.tableById.get(table.id)
  const inRow = new Set(Object.values(rule.head ?? {}).map(a => a?.y).filter(Boolean))
  const free = [...bodyFrontier(rule).keys()].filter(y => y && !inRow.has(y))
  const pk = tb?.pk ?? []
  const used = new Set((tb?.columns ?? []).map(c => c.name))
  const nameOf = (y) => names[y] ?? y
  return (
    <div style={{ marginTop: 12, padding: 10, background: 'var(--bg-raised)', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-soft)' }}>
      <div style={{ fontSize: 10, color: 'var(--accent)', fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: 6 }}>
        {TABLE_RULE_KINDS.find(k => k.id === rule.kind)?.label ?? 'Rule'}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', marginBottom: 5 }}>
        <span style={{ width: 84, fontSize: 11, color: 'var(--ink-3)' }}>Mode</span>
        <select value={rule.mode} style={{ ...selectStyle, width: 'auto', maxWidth: '100%' }} onChange={e => updateTableRule(table.id, rule.id, { mode: e.target.value })}>
          <option value="derived">Derived: exactly what the query gives (⟺)</option>
          <option value="semiDerived">Semi-derived: what the query gives, and stored values (⟸)</option>
        </select>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', marginBottom: 5 }}>
        <span style={{ width: 84, fontSize: 11, color: 'var(--ink-3)' }}>Key</span>
        <span style={{ fontSize: 12, color: pk.length ? 'var(--ink-2)' : '#dc2626' }}>
          {pk.length ? pk.map(c => c.name).join(', ') : `${table.name} has no primary key yet${rule.kind === 'table' ? ': add a key column below' : ''}`}
        </span>
      </div>
      {free.length > 0 && <div style={{ display: 'flex', alignItems: 'flex-start', gap: 6, flexWrap: 'wrap' }}>
        <span style={{ width: 84, fontSize: 11, color: 'var(--ink-3)', paddingTop: 4 }}>New column</span>
        <div style={{ display: 'grid', gridTemplateColumns: 'auto auto auto auto', gap: '3px 8px', alignItems: 'center', fontSize: 12 }}>
          {free.map(y => (
            <React.Fragment key={y}>
              <span style={MAPPING_TOKEN_STYLE.fv}>${y}</span>
              <input aria-label={`Name of the column for $${y}`} value={nameOf(y)} onChange={e => setNames(n => ({ ...n, [y]: e.target.value.trim() }))}
                style={{ ...selectStyle, width: 130, borderColor: used.has(nameOf(y)) ? '#dc2626' : undefined }} title={used.has(nameOf(y)) ? 'The table has a column of this name' : 'The column name'} />
              <button style={btn()} disabled={!nameOf(y) || used.has(nameOf(y))} title={`Add a column ${nameOf(y)} to ${table.name} and give it $${y} in the row`}
                onClick={() => addColumn(table.id, rule.id, y, { name: nameOf(y) })}>Add column</button>
              {rule.kind === 'table'
                ? <button style={btn()} disabled={!nameOf(y) || used.has(nameOf(y))} title="Add it as a column of the primary key"
                    onClick={() => addColumn(table.id, rule.id, y, { name: nameOf(y), key: true })}>Add key column</button>
                : <span />}
            </React.Fragment>
          ))}
        </div>
      </div>}
    </div>
  )
}
