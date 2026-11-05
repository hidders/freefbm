import React, { useEffect, useMemo, useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useOrmStore } from '../store/ormStore'
import { useDiagramElements } from '../hooks/useDiagramElements'
import { mappingOfDiagram } from '../store/storeHelpers'
import { entityBounds } from './ObjectTypeNode'
import { factBounds } from './FactTypeNode'
import { mappingErdBoxes } from './ErdView'
import { ruleElements, checkRule, sideContext, sideTokens, tokensText, SIDES, sideSchemaId } from '../mapping/mapping.js'

// ── Mapping diagrams ────────────────────────────────────────────────────────
// A mapping diagram (diagram.mappingId, workbench step 7b) shows elements of
// a mapping's source and target schema on one canvas. Each element gets a
// tint of its side (MappingTints, drawn beneath the elements), and each rule
// φ ⟺ ψ is a node linked to the elements its two patterns name
// (MappingRules, drawn on top). Hovering a node highlights its elements;
// clicking it opens the rule in the mapping rule editor; dragging moves it.

const PAD = 6          // tint margin around an element
const NODE_H = 22
const STACK = NODE_H + 10

// The mapping the active diagram draws, if any.
function useActiveMapping() {
  return useOrmStore(s => mappingOfDiagram(s, s.diagrams.find(d => d.id === s.activeDiagramId)))
}

// Bounds of a shown object type or fact type occurrence.
const boundsOf = (el) => (el._bounds ?? (el.arity != null && el.roles ? factBounds(el) : entityBounds(el)))

// Tints each element by its side: source blue, target green.
export function MappingTints() {
  const mapping = useActiveMapping()
  const { objectTypes, facts } = useDiagramElements()
  if (!mapping || mapping.sourceSchemaId === mapping.targetSchemaId) return null
  const sideOf = (el) => (el.schemaId === mapping.targetSchemaId ? 'target' : 'source')
  const items = [
    ...objectTypes.map(o => ({ el: o, b: entityBounds(o) })),
    ...facts.filter(f => !f._implicit && !f.id?.includes('_il_')).map(f => ({ el: f, b: factBounds(f) })),
  ]
  return (
    <g className="mapping-tints" style={{ pointerEvents: 'none' }}>
      {items.map(({ el, b }) => {
        const side = sideOf(el)
        return (
          <rect key={`tint-${el.occurrenceId ?? el.id}`}
            data-side={side}
            x={b.left - PAD} y={b.top - PAD} width={b.right - b.left + 2 * PAD} height={b.bottom - b.top + 2 * PAD}
            rx={9} ry={9}
            fill={`var(--map-${side}-bg)`} stroke={`var(--map-${side})`} strokeOpacity={0.35} strokeWidth={1}
          />
        )
      })}
    </g>
  )
}

// The point where the segment from (px, py) to the centre of box b leaves b.
function edgePoint(b, px, py) {
  const cx = (b.left + b.right) / 2, cy = (b.top + b.bottom) / 2
  const dx = px - cx, dy = py - cy
  if (!dx && !dy) return { x: cx, y: cy }
  const hw = (b.right - b.left) / 2 + 3, hh = (b.bottom - b.top) / 2 + 3
  const t = Math.min(hw / Math.abs(dx || 1e-9), hh / Math.abs(dy || 1e-9))
  return t >= 1 ? { x: px, y: py } : { x: cx + dx * t, y: cy + dy * t }
}

const centroid = (pts) => (pts.length
  ? { x: pts.reduce((a, p) => a + p.x, 0) / pts.length, y: pts.reduce((a, p) => a + p.y, 0) / pts.length }
  : null)

// The rules of the active mapping diagram as nodes with connectors.
export function MappingRules() {
  const mapping = useActiveMapping()
  const { objectTypes, facts, diagram, collapsedRefFacts, erdSchemaIds } = useDiagramElements()
  const state = useOrmStore(useShallow(s => ({
    schemas: s.schemas, objectTypes: s.objectTypes, facts: s.facts, constraints: s.constraints, subtypes: s.subtypes,
    editing: s.mappingRuleEditor,
  })))
  const [hoverId, setHoverId] = useState(null)
  const [drag, setDrag] = useState(null)   // { ruleId, x, y }
  const setByUs = useRef(false)

  const ctxs = useMemo(() => (mapping ? {
    source: sideContext(state, mapping.sourceSchemaId),
    target: sideContext(state, mapping.targetSchemaId),
  } : null), [state, mapping])

  // A relational side drawn as ERD tables: its table boxes, as link ends.
  const erdKey = (erdSchemaIds ?? []).join()
  const erd = useMemo(() => {
    const out = {}
    if (!mapping || !diagram) return out
    for (const side of SIDES) {
      const sid = sideSchemaId(mapping, side)
      if (!(erdSchemaIds ?? []).includes(sid)) continue
      const { model, boxes } = mappingErdBoxes(state, diagram, sid)
      const end = new Map([...boxes].map(([id, b]) => [id, { id, x: b.x + b.w / 2, y: b.y + b.h / 2, _bounds: { left: b.x, right: b.x + b.w, top: b.y, bottom: b.y + b.h } }]))
      out[side] = { end, tableOfColumn: (fid) => model.columnByFact.get(fid)?.table.id ?? null }
    }
    return out
  }, [mapping, diagram, state, erdKey])   // eslint-disable-line react-hooks/exhaustive-deps

  // Per rule: its elements, the shown occurrences they link to, and checks.
  const rules = useMemo(() => {
    if (!mapping || !ctxs) return []
    const otsById = new Map(), factsById = new Map()
    for (const o of objectTypes) { if (!otsById.has(o.id)) otsById.set(o.id, []); otsById.get(o.id).push(o) }
    for (const f of facts) { if (f._implicit) continue; if (!factsById.has(f.id)) factsById.set(f.id, []); factsById.get(f.id).push(f) }
    return mapping.rules.map((r, k) => {
      const els = ruleElements(r)
      const ends = {}
      const namedErd = {}
      for (const side of SIDES) {
        const e = els[side]
        const groups = []
        if (erd[side]) {
          // Tables: of table rows, type atoms and the columns fact atoms name.
          const tables = new Set([...e.typeIds, ...e.tableIds, ...e.factIds.map(erd[side].tableOfColumn)].filter(Boolean))
          const real = [...tables].filter(id => state.objectTypes.some(o => o.id === id && o.kind === 'entity'))
          namedErd[side] = real.length
          for (const id of real) if (erd[side].end.has(id)) groups.push([erd[side].end.get(id)])
          ends[side] = groups
          continue
        }
        for (const id of [...new Set([...e.typeIds, ...e.tableIds])]) {
          const occs = [...(otsById.get(id) ?? []), ...(factsById.get(id) ?? []).filter(f => f.objectified)]
          if (occs.length) groups.push(occs)
        }
        for (const id of e.factIds) {
          const occs = factsById.get(id) ?? (collapsedRefFacts?.[id]?.owner ? [collapsedRefFacts[id].owner] : [])
          if (occs.length) groups.push(occs)
        }
        ends[side] = groups
      }
      const issues = checkRule(r, mapping, state, ctxs)
      const formula = SIDES.map(side => tokensText(sideTokens(r[side], ctxs[side]))).join('  ⟺  ')
      const highlight = {
        typeIds: SIDES.flatMap(side => [...els[side].typeIds, ...els[side].tableIds, ...els[side].varTypeIds]),
        factIds: [...els.source.factIds, ...els.source.columnFactIds, ...els.target.factIds, ...els.target.columnFactIds],
      }
      const named = SIDES.reduce((n, side) => n + (side in namedErd ? namedErd[side] : els[side].typeIds.length + els[side].tableIds.length + els[side].factIds.length), 0)
      const linked = ends.source.length + ends.target.length
      return { r, k, ends, issues, formula, highlight, missing: Math.max(0, named - linked) }
    })
  }, [mapping, ctxs, objectTypes, facts, collapsedRefFacts, state, erd])

  // Node positions: stored, or between the two sides' elements; default
  // positions that would overlap are stacked downwards.
  const placed = useMemo(() => {
    const stored = diagram?.mappingRulePositions ?? {}
    const taken = []
    return rules.map(info => {
      const pos = stored[info.r.id]
      if (pos) return { ...info, x: pos.x, y: pos.y, stored: true }
      const c = {}
      for (const side of SIDES) c[side] = centroid(info.ends[side].map(g => ({ x: g[0].x, y: g[0].y })))
      let p = c.source && c.target ? { x: (c.source.x + c.target.x) / 2, y: (c.source.y + c.target.y) / 2 }
        : c.source ? { x: c.source.x + 160, y: c.source.y }
        : c.target ? { x: c.target.x - 160, y: c.target.y }
        : { x: 0, y: -60 }
      while (taken.some(t => Math.abs(t.x - p.x) < 90 && Math.abs(t.y - p.y) < STACK)) p = { x: p.x, y: p.y + STACK }
      taken.push(p)
      return { ...info, x: p.x, y: p.y, stored: false }
    })
  }, [rules, diagram?.mappingRulePositions])

  // The hovered rule's elements are highlighted; else the rule open in the editor.
  const editingRule = mapping && state.editing?.mappingId === mapping.id ? state.editing.ruleId : null
  const hlRule = placed.find(p => p.r.id === hoverId) ?? placed.find(p => p.r.id === editingRule)
  const hlKey = hlRule ? JSON.stringify(hlRule.highlight) : ''
  useEffect(() => {
    const st = useOrmStore.getState()
    if (hlRule) { setByUs.current = true; st.setRuleHighlight(hlRule.highlight) }
    else if (setByUs.current) { setByUs.current = false; st.setRuleHighlight(null) }
  }, [hlKey])   // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => { if (setByUs.current) useOrmStore.getState().setRuleHighlight(null) }, [])

  if (!mapping) return null

  const startDrag = (e, info) => {
    if (e.button !== 0) return
    e.stopPropagation(); e.preventDefault()
    const zoom = useOrmStore.getState().zoom || 1
    const sx = e.clientX, sy = e.clientY
    let moved = false, last = { x: info.x, y: info.y }
    const onMove = (me) => {
      const dx = (me.clientX - sx) / zoom, dy = (me.clientY - sy) / zoom
      if (!moved && Math.hypot(me.clientX - sx, me.clientY - sy) < 3) return
      moved = true
      last = { x: info.x + dx, y: info.y + dy }
      setDrag({ ruleId: info.r.id, ...last })
    }
    const onUp = () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      setDrag(null)
      const st = useOrmStore.getState()
      if (moved) st.setMappingRulePosition(diagram.id, info.r.id, last)
      else st.openMappingRuleEditor(mapping.id, info.r.id)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  return (
    <g className="mapping-rules">
      {placed.map(info => {
        const x = drag?.ruleId === info.r.id ? drag.x : info.x
        const y = drag?.ruleId === info.r.id ? drag.y : info.y
        const label = info.r.name || `Rule ${info.k + 1}`
        const w = Math.max(58, 26 + label.length * 6.6)
        const errors = info.issues.filter(i => i.severity === 'error').length
        const warnings = info.issues.length - errors
        const open = editingRule === info.r.id
        const hot = hoverId === info.r.id || open
        const border = errors ? 'var(--danger)' : warnings ? '#d97706' : 'var(--map-rule)'
        const lines = []
        for (const side of SIDES) {
          for (const occs of info.ends[side]) {
            // The occurrence nearest to the node.
            let best = occs[0], bd = Infinity
            for (const o of occs) { const d = (o.x - x) ** 2 + (o.y - y) ** 2; if (d < bd) { bd = d; best = o } }
            const b = boundsOf(best)
            const to = edgePoint(b, x, y)
            const from = edgePoint({ left: x - w / 2, right: x + w / 2, top: y - NODE_H / 2, bottom: y + NODE_H / 2 }, to.x, to.y)
            lines.push(
              <line key={`${side}-${best.occurrenceId ?? best.id}`} data-side={side}
                x1={from.x} y1={from.y} x2={to.x} y2={to.y}
                stroke={`var(--map-${side})`} strokeWidth={hot ? 2 : 1.3} strokeOpacity={hot ? 0.95 : 0.7}
                strokeDasharray="5 3" strokeLinecap="round" />)
          }
        }
        const tip = [`${label}: ${info.formula}`,
          ...info.issues.map(i => `${i.severity === 'error' ? 'Error' : 'Warning'}: ${i.text}`),
          ...(info.missing ? [`${info.missing} element${info.missing === 1 ? '' : 's'} of this rule not shown here (Add rule elements)`] : []),
          'Click to edit, drag to move.'].join('\n')
        return (
          <g key={info.r.id} className="mapping-rule" data-rule-id={info.r.id}>
            <g style={{ pointerEvents: 'none' }}>{lines}</g>
            <g transform={`translate(${x},${y})`}
              style={{ cursor: drag?.ruleId === info.r.id ? 'grabbing' : 'pointer', pointerEvents: 'all' }}
              onMouseDown={e => startDrag(e, info)}
              onMouseEnter={() => setHoverId(info.r.id)}
              onMouseLeave={() => setHoverId(h => (h === info.r.id ? null : h))}
              onDoubleClick={e => { e.stopPropagation(); if (info.stored) useOrmStore.getState().setMappingRulePosition(diagram.id, info.r.id, null) }}
            >
              <title>{tip}{info.stored ? '\nDouble-click to put it back between its elements.' : ''}</title>
              <rect x={-w / 2} y={-NODE_H / 2} width={w} height={NODE_H} rx={NODE_H / 2} ry={NODE_H / 2}
                fill="#fffdf8" stroke={open ? 'var(--accent)' : border} strokeWidth={open ? 2.2 : hot ? 1.8 : 1.3}
                style={{ filter: hot ? 'drop-shadow(0 1px 2px rgba(0,0,0,0.25))' : 'none' }} />
              <text x={-w / 2 + 10} y={0.5} dominantBaseline="middle" fontSize={12} fill="var(--map-rule)"
                fontFamily="'Segoe UI', Helvetica, Arial, sans-serif" style={{ userSelect: 'none' }}>
                <tspan fill="var(--map-source)" fontWeight={700}>⟺</tspan>
                <tspan dx={5}>{label}</tspan>
              </text>
              {(errors > 0 || warnings > 0 || info.missing > 0) && (
                <circle cx={w / 2 - 3} cy={-NODE_H / 2 + 3} r={4.5}
                  fill={errors ? 'var(--danger)' : warnings ? '#d97706' : 'var(--ink-muted)'} stroke="#fff" strokeWidth={1} />
              )}
            </g>
          </g>
        )
      })}
    </g>
  )
}

// Constraint accounting badges (AccountingReport.jsx), on the left (the
// validation badges are at the top right): on each shown fact type or object type with a constraint that a mapping loses (red !) or
// could not decide (grey ?), from the accounting results of the mappings.
export function AccountingBadges() {
  const accounting = useOrmStore(s => s.mappingAccounting)
  const constraints = useOrmStore(s => s.constraints)
  const { objectTypes, facts, collapsedRefFacts } = useDiagramElements()
  const marks = useMemo(() => {
    const m = new Map()   // element id → { lost: [text], unknown: [text] }
    for (const acc of Object.values(accounting ?? {})) {
      for (const side of SIDES) for (const x of acc.result?.sides?.[side] ?? []) {
        if (x.status !== 'lost' && x.status !== 'unknown') continue
        const c = constraints.find(k => k.id === x.entry.elementId)
        const ids = c ? [...new Set((c.sequences ?? []).flat().map(mm => mm?.factId).filter(Boolean))].slice(0, 1) : [x.entry.elementId]
        for (const id of ids) {
          const owner = collapsedRefFacts?.[id]?.owner?.id ?? id
          if (!m.has(owner)) m.set(owner, { lost: [], unknown: [] })
          m.get(owner)[x.status].push(x.label ?? `${x.entry.kind}${x.entry.subject ? ` · ${x.entry.subject}` : ''}`)
        }
      }
    }
    return m
  }, [accounting, constraints, collapsedRefFacts])
  if (!marks.size) return null
  const items = [
    // Just left of a fact type's first role box; at an object type's corner.
    ...facts.filter(f => !f._implicit && marks.has(f.id)).map(f => ({ el: f, at: { x: factBounds(f).left - 8, y: f.y - 11 } })),
    ...objectTypes.filter(o => marks.has(o.id)).map(o => { const b = entityBounds(o); return { el: o, at: { x: b.left - 2, y: b.top - 2 } } }),
  ]
  return (
    <g className="accounting-badges">
      {items.map(({ el, at }) => {
        const mk = marks.get(el.id)
        const lost = mk.lost.length > 0
        const title = [
          ...mk.lost.map(t => `Lost: ${t}`), ...mk.unknown.map(t => `Unknown: ${t}`),
        ].join('\n') + '\n(Constraint accounting in the Mappings tab)'
        return (
          <g key={`acc-${el.occurrenceId ?? el.id}`} data-status={lost ? 'lost' : 'unknown'} transform={`translate(${at.x},${at.y})`} style={{ cursor: 'help', pointerEvents: 'all' }}>
            <title>{title}</title>
            <circle r={7} fill={lost ? '#dc2626' : 'var(--bg-surface)'} stroke={lost ? '#dc2626' : 'var(--ink-muted)'} strokeWidth={1.2} />
            <text textAnchor="middle" dy="0.35em" fontSize={10} fontWeight={700} fill={lost ? '#fff' : 'var(--ink-muted)'} style={{ userSelect: 'none' }}>{lost ? '!' : '?'}</text>
          </g>
        )
      })}
    </g>
  )
}
