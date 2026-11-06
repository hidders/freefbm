import React, { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useOrmStore } from '../store/ormStore'
import { neighbourUnits, GROUPS, GROUP_ORDER } from '../utils/neighbourhood.js'
import { erdPartsOfDiagram, erdTargetOf } from '../relational/erdBoxes.js'
import { placeOrmUnits, placeErdUnits } from '../layout/growPlacement.js'

// Add neighbours…: the neighbourhood of an element (an object type or table)
// in its schema, grouped, each unit with a checkbox; attributes and dependants
// are ticked to start with. Type to filter, arrow keys move, Space ticks,
// Enter adds the ticked units (store.addNeighbours), Esc closes. It sits
// beside the element on the canvas and follows it when the view pans.

const FONT = "'Segoe UI', Helvetica, Arial, sans-serif"
const W = 360

export default function NeighbourPicker() {
  const picker = useOrmStore(s => s.neighbourPicker)
  const activeDiagramId = useOrmStore(s => s.activeDiagramId)
  if (!picker || picker.diagramId !== activeDiagramId) return null
  return <Picker key={`${picker.diagramId}:${picker.elementId}:${picker.occurrenceId}`} picker={picker} />
}

function Picker({ picker }) {
  const objectTypes = useOrmStore(s => s.objectTypes)
  const facts = useOrmStore(s => s.facts)
  const subtypes = useOrmStore(s => s.subtypes)
  const constraints = useOrmStore(s => s.constraints)
  const diagrams = useOrmStore(s => s.diagrams)
  const schemas = useOrmStore(s => s.schemas)
  const pan = useOrmStore(s => s.pan)
  const zoom = useOrmStore(s => s.zoom)
  const diagram = diagrams.find(d => d.id === picker.diagramId)
  const units = useMemo(() => {
    const st = { objectTypes, facts, subtypes, constraints, diagrams, schemas }
    return neighbourUnits(st, diagram, picker.elementId)
  }, [objectTypes, facts, subtypes, constraints, diagrams, schemas, diagram, picker.elementId])

  const [ticked, setTicked] = useState(() => new Set(units.filter(u => u.defaultOn && !u.shown).map(u => u.key)))
  const [query, setQuery] = useState('')
  const [cursor, setCursor] = useState(0)
  const [oneMore, setOneMore] = useState(false)
  const inputRef = useRef(null)
  const listRef = useRef(null)
  useEffect(() => { inputRef.current?.focus() }, [])

  const close = () => useOrmStore.getState().closeNeighbourPicker()
  const q = query.trim().toLowerCase()
  const visible = units.filter(u => !q || u.label.toLowerCase().includes(q))
  const groups = GROUP_ORDER.map(g => ({ g, items: visible.filter(u => u.group === g) })).filter(x => x.items.length)
  const flat = groups.flatMap(x => x.items)
  const addable = (u) => !u.shown
  const chosen = units.filter(u => ticked.has(u.key) && addable(u))

  const toggle = (u) => {
    if (!addable(u)) return
    setTicked(t => { const n = new Set(t); n.has(u.key) ? n.delete(u.key) : n.add(u.key); return n })
  }
  const setAll = (list, on) => setTicked(t => {
    const n = new Set(t)
    for (const u of list) if (addable(u)) on ? n.add(u.key) : n.delete(u.key)
    return n
  })
  const add = () => {
    if (!chosen.length) return
    const s = useOrmStore.getState()
    s.addNeighbours(picker.diagramId, picker.elementId, picker.occurrenceId, chosen, { oneMoreStep: oneMore, place: { orm: placeOrmUnits, erd: placeErdUnits } })
    close()
  }
  const onKey = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); close() }
    else if (e.key === 'Enter') { e.preventDefault(); add() }
    else if (e.key === 'ArrowDown') { e.preventDefault(); setCursor(c => Math.min(flat.length - 1, c + 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setCursor(c => Math.max(0, c - 1)) }
    else if (e.key === ' ' && (e.target !== inputRef.current || !query || e.ctrlKey)) {
      // Space ticks the row under the cursor (in the filter box only once it is empty).
      e.preventDefault()
      if (flat[cursor]) toggle(flat[cursor])
    }
    e.stopPropagation()
  }
  useEffect(() => { setCursor(c => Math.min(c, Math.max(0, flat.length - 1))) }, [flat.length])
  useEffect(() => { listRef.current?.querySelector(`[data-i="${cursor}"]`)?.scrollIntoView({ block: 'nearest' }) }, [cursor])

  // Beside the anchor, in window coordinates.
  const pos = (() => {
    const svg = document.getElementById('orm2-canvas-svg')
    const r = svg?.getBoundingClientRect() ?? { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight }
    let wx = 0, wy = 0, ww = 80, wh = 40
    const st = useOrmStore.getState()
    const parts = erdPartsOfDiagram(st, diagram)
    const at = parts.length ? erdTargetOf(st, parts, picker.elementId) : null
    if (at) { wx = at.x + at.w / 2; wy = at.y + at.h / 2; ww = at.w; wh = at.h }
    else {
      const occ = (diagram?.occurrences ?? []).find(o => o.id === picker.occurrenceId)
        ?? (diagram?.occurrences ?? []).find(o => o.schemaElementId === picker.elementId)
      if (occ) { wx = occ.x; wy = occ.y }
    }
    const sx = r.left + pan.x + wx * zoom, sy = r.top + pan.y + wy * zoom
    let left = sx + (ww / 2) * zoom + 16
    if (left + W > window.innerWidth - 8) left = Math.max(8, sx - (ww / 2) * zoom - 16 - W)
    const top = Math.max(r.top + 8, Math.min(sy - (wh / 2) * zoom, window.innerHeight - 200))
    return { left, top, maxHeight: Math.max(200, window.innerHeight - top - 16) }
  })()

  const name = (() => {
    const ot = objectTypes.find(o => o.id === picker.elementId)
    if (ot) return ot.name
    const f = facts.find(x => x.id === picker.elementId)
    return f?.objectifiedName || f?.name || ''
  })()
  const onNoDiagram = units.filter(u => addable(u) && u.otherDiagrams === 0)

  let i = -1
  return createPortal(
    <div onKeyDown={onKey} onMouseDown={e => e.stopPropagation()}
      style={{ position: 'fixed', left: pos.left, top: pos.top, width: W, maxHeight: Math.min(pos.maxHeight, 560), zIndex: 900,
        display: 'flex', flexDirection: 'column', background: 'var(--bg-surface)', border: '1px solid var(--border)',
        borderRadius: 6, boxShadow: '0 6px 20px rgba(0,0,0,0.18)', fontFamily: FONT, fontSize: 12, color: 'var(--ink)' }}>
      <div style={{ display: 'flex', alignItems: 'center', padding: '7px 10px 4px', gap: 6 }}>
        <span style={{ fontWeight: 600, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          Neighbours of {name}
        </span>
        <button onClick={close} title="Close (Esc)" style={linkBtn}>✕</button>
      </div>
      <div style={{ padding: '0 10px 6px' }}>
        <input ref={inputRef} value={query} placeholder="Filter…" onChange={e => { setQuery(e.target.value); setCursor(0) }}
          style={{ width: '100%', boxSizing: 'border-box', padding: '4px 6px', fontSize: 12, fontFamily: FONT,
            border: '1px solid var(--border)', borderRadius: 3, background: 'var(--bg-canvas)', color: 'var(--ink)' }} />
        <div style={{ display: 'flex', gap: 10, marginTop: 5, color: 'var(--ink-muted)', fontSize: 11 }}>
          <button style={linkBtn} onClick={() => setTicked(new Set(units.filter(u => u.defaultOn && addable(u)).map(u => u.key)))}>Defaults</button>
          <button style={linkBtn} onClick={() => setAll(visible, true)}>All</button>
          <button style={linkBtn} onClick={() => setAll(units, false)}>None</button>
          <button style={linkBtn} disabled={!onNoDiagram.length} title="Only those on no other diagram"
            onClick={() => setTicked(new Set(onNoDiagram.map(u => u.key)))}>On no diagram ({onNoDiagram.length})</button>
        </div>
      </div>
      <div ref={listRef} style={{ overflowY: 'auto', borderTop: '1px solid var(--border-soft)', borderBottom: '1px solid var(--border-soft)', flex: 1, minHeight: 40 }}>
        {!units.length && <div style={{ padding: 10, color: 'var(--ink-muted)' }}>It has no neighbours in its schema.</div>}
        {!!units.length && !visible.length && <div style={{ padding: 10, color: 'var(--ink-muted)' }}>Nothing matches.</div>}
        {groups.map(({ g, items }) => {
          const open = items.filter(addable)
          const on = open.filter(u => ticked.has(u.key)).length
          return (
            <div key={g}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '5px 10px 2px', fontSize: 11, fontWeight: 600,
                color: 'var(--ink-muted)', textTransform: 'uppercase', letterSpacing: 0.3, cursor: open.length ? 'pointer' : 'default' }}>
                <input type="checkbox" disabled={!open.length} checked={!!open.length && on === open.length}
                  ref={el => { if (el) el.indeterminate = on > 0 && on < open.length }}
                  onChange={() => setAll(open, on < open.length)} />
                {GROUPS[g]} <span style={{ fontWeight: 400 }}>({items.length})</span>
              </label>
              {items.map(u => {
                i++
                const idx = i
                return (
                  <label key={u.key} data-i={idx} onMouseEnter={() => setCursor(idx)}
                    title={u.shown ? 'On this diagram already' : undefined}
                    style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '2px 10px 2px 22px', cursor: u.shown ? 'default' : 'pointer',
                      background: idx === cursor ? 'var(--bg-raised)' : undefined, opacity: u.shown ? 0.45 : 1 }}>
                    <input type="checkbox" disabled={u.shown} checked={u.shown || ticked.has(u.key)} onChange={() => toggle(u)} />
                    <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{u.label}</span>
                    {u.hub && <Badge title="Leads to an element with many neighbours of its own">hub</Badge>}
                    {u.shown ? <Badge>shown</Badge>
                      : u.otherDiagrams > 0 && <Badge title={`Shown on ${u.otherDiagrams} other diagram${u.otherDiagrams > 1 ? 's' : ''}`}>on {u.otherDiagrams}</Badge>}
                  </label>
                )
              })}
            </div>
          )
        })}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 10px' }}>
        <label style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 5, fontSize: 11, color: 'var(--ink-muted)', cursor: 'pointer' }}
          title="Also add the pre-ticked neighbours (attributes, dependants) of what is added">
          <input type="checkbox" checked={oneMore} onChange={e => setOneMore(e.target.checked)} /> One more step
        </label>
        <button onClick={add} disabled={!chosen.length}
          style={{ padding: '4px 12px', fontSize: 12, fontFamily: FONT, borderRadius: 4, cursor: chosen.length ? 'pointer' : 'default',
            border: '1px solid var(--accent, #1e3a8a)', background: chosen.length ? 'var(--accent, #1e3a8a)' : 'none',
            color: chosen.length ? 'white' : 'var(--ink-muted)' }}>
          Add {chosen.length || ''}
        </button>
      </div>
    </div>,
    document.body,
  )
}

const linkBtn = { background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: 'var(--ink-muted)', fontSize: 11, fontFamily: FONT }

function Badge({ children, title }) {
  return (
    <span title={title} style={{ fontSize: 9, color: 'var(--ink-muted)', border: '1px solid var(--border)', borderRadius: 3,
      padding: '0 3px', lineHeight: '13px', flexShrink: 0 }}>{children}</span>
  )
}
