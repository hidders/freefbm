// Read-only entity-relationship view of a relational schema's diagram, in
// crow's foot notation (workbench step 6). The tables, columns and keys come
// from relationalModel (the same reading the DDL export uses); a diagram shows
// the tables whose entity type it shows. Box positions are kept per diagram in
// diagram.erdPositions (top-left corners); tables without one are laid out in
// columns by foreign key depth, and the foreign keys are drawn as lines routed
// around the boxes: by default straight lines that bend at box corners and
// leave a table at their column's row (src/relational/erdDirect.js), or, with
// diagram.erdLines 'orthogonal', right-angled lines (src/relational/erdRouting.js),
// each with its own point on the box sides. Selecting a line (or a column) highlights the
// foreign key and its columns. A click selects the table (header) or the column (row) for the
// Inspector; dragging a box moves it, as one undo step.

import React, { useMemo, useState, useRef, useEffect } from 'react'
import { createPortal } from 'react-dom'
import ContextMenu from './ContextMenu'
import { growItems } from '../hooks/useContextMenuHandlers'
import { useOrmStore } from '../store/ormStore'
import { relationalModel, isKey } from '../relational/relationalModel'
import { routeLines, assignPorts, SIDES } from '../relational/erdRouting'
import { assignRowPorts, routeDirect } from '../relational/erdDirect'
import { FONT, HEAD_H, ROW_H, PAD_X, columnType, columnMarks, erdLayout, mappingErdBoxes, erdTargetOf } from '../relational/erdBoxes'
import { relationalView, rmObjectOf } from '../relational/relationalView'
import { rmViolations } from '../relational/rmText'
import { BadgePopup, BADGE_SEV_COLOUR } from './BadgePopup'

export { isErdDiagram, erdLayout, mappingErdBoxes } from '../relational/erdBoxes'

// Crow's foot end marker at (x, y) on a box side; (dx, dy) is the direction
// the line leaves the box in. kind: 'one' (||), 'zeroOne' (o|), 'zeroMany' (o<).
function EndMarker({ x, y, side, kind, stroke }) {
  const { dx, dy } = SIDES[side]
  const px = -dy, py = dx                     // across the line
  const at = (t, s = 0) => [x + dx * t + px * s, y + dy * t + py * s]
  const bar = (t) => { const [x1, y1] = at(t, -6), [x2, y2] = at(t, 6); return <line x1={x1} y1={y1} x2={x2} y2={y2} stroke={stroke} strokeWidth={1.3}/> }
  const circle = (t) => { const [cx, cy] = at(t); return <circle cx={cx} cy={cy} r={3.8} fill="var(--bg-canvas)" stroke={stroke} strokeWidth={1.3}/> }
  if (kind === 'one') return <g>{bar(9)}{bar(14)}</g>
  if (kind === 'zeroOne') return <g>{bar(9)}{circle(19)}</g>
  const [ax, ay] = at(0, -7), [bx, by] = at(0, 7), [tx, ty] = at(12)
  return (
    <g>
      <path d={`M ${ax} ${ay} L ${tx} ${ty} L ${bx} ${by} M ${x} ${y} L ${tx} ${ty}`} fill="none" stroke={stroke} strokeWidth={1.3}/>
      {circle(18)}
    </g>
  )
}

function FkLine({ fk, route, selected, onDown }) {
  if (!route) return null
  const pts = route.points
  const d = pts.map(([x, y], i) => `${i ? 'L' : 'M'} ${x} ${y}`).join(' ')
  const [x1, y1] = pts[0], [x2, y2] = pts[pts.length - 1]
  const nullable = fk.from.some(c => !c.notNull)
  const many = !isKey(fk.fromTable, fk.from)
  const stroke = selected ? 'var(--accent)' : 'var(--ink-2)'
  return (
    <g onMouseDown={e => onDown(e, fk)} style={{ cursor: 'pointer' }}>
      {/* A wide invisible stroke makes the line easy to click. */}
      <path d={d} fill="none" stroke="transparent" strokeWidth={10}/>
      <path d={d} fill="none" stroke={stroke} strokeWidth={selected ? 2.4 : 1.3} strokeLinejoin="round"
        strokeDasharray={nullable ? '5 3' : undefined}/>
      <EndMarker x={x1} y={y1} side={route.s1} kind={many ? 'zeroMany' : 'zeroOne'} stroke={stroke}/>
      <EndMarker x={x2} y={y2} side={route.s2} kind={nullable ? 'zeroOne' : 'one'} stroke={stroke}/>
    </g>
  )
}

function TableBox({ box, selectedId, highlighted, onHeaderDown, onRowDown, onMenu, tint = null, ruleHl = null }) {
  const { table: t, x, y, w, h } = box
  const sel = selectedId === t.id
  const hot = !!ruleHl?.typeIds?.includes(t.id)
  const head = 'var(--col-schema-relational)'
  return (
    <g style={{ fontFamily: FONT }} data-table={t.name} onContextMenu={onMenu ? (e => onMenu(e, t)) : undefined}>
      {tint && <rect x={x - 6} y={y - 6} width={w + 12} height={h + 12} rx={9} fill={`var(--map-${tint}-bg)`}
        stroke={`var(--map-${tint})`} strokeOpacity={0.35} strokeWidth={1} style={{ pointerEvents: 'none' }}/>}
      <rect x={x} y={y} width={w} height={h} rx={4} fill="var(--bg-text-panel)"
        stroke={sel || hot ? 'var(--accent)' : 'var(--border-dark)'} strokeWidth={sel || hot ? 2.2 : 1.2}
        filter={sel ? 'url(#selectGlow)' : undefined}/>
      <g onMouseDown={e => onHeaderDown(e, t)} style={{ cursor: 'move' }}>
        <path d={`M ${x} ${y + HEAD_H} L ${x} ${y + 4} Q ${x} ${y} ${x + 4} ${y} L ${x + w - 4} ${y} Q ${x + w} ${y} ${x + w} ${y + 4} L ${x + w} ${y + HEAD_H} Z`}
          fill={head}/>
        <text x={x + PAD_X} y={y + HEAD_H / 2 + 4.5} fontSize={13} fontWeight={700} fill="#fff"
          style={{ userSelect: 'none', pointerEvents: 'none' }}>{t.name}</text>
      </g>
      {t.columns.map((c, i) => {
        const ry = y + HEAD_H + 3 + i * ROW_H
        const csel = selectedId === c.fact.id || (!!c.vt && selectedId === c.vt.id)
        const hl = highlighted.has(c) || !!ruleHl?.factIds?.includes(c.fact.id)
        return (
          <g key={c.fact.id} onMouseDown={e => onRowDown(e, t, c)} style={{ cursor: 'pointer' }}>
            <rect x={x + 1} y={ry} width={w - 2} height={ROW_H} fill={hl ? 'rgba(180,83,9,0.28)' : csel ? 'var(--selection)' : 'transparent'}/>
            {i > 0 && t.columns[i - 1].pk && !c.pk && (
              <line x1={x + 1} y1={ry} x2={x + w - 1} y2={ry} stroke="var(--border-soft)" strokeWidth={1}/>
            )}
            <text x={x + PAD_X} y={ry + ROW_H / 2 + 3.5} fontSize={9} fontWeight={700}
              fill={c.pk ? 'var(--accent)' : 'var(--col-schema-relational)'} style={{ userSelect: 'none' }}>{columnMarks(c)}</text>
            <text x={x + PAD_X + box.markW} y={ry + ROW_H / 2 + 4} fontSize={12} fontWeight={c.notNull ? 600 : 400}
              fill="var(--ink)" textDecoration={c.pk ? 'underline' : undefined} style={{ userSelect: 'none' }}>{c.name}</text>
            <text x={x + w - PAD_X} y={ry + ROW_H / 2 + 4} fontSize={11} textAnchor="end"
              fill="var(--ink-3)" style={{ userSelect: 'none' }}>{columnType(c)}</text>
          </g>
        )
      })}
      {!t.columns.length && (
        <text x={x + PAD_X} y={y + HEAD_H + 3 + ROW_H / 2 + 4} fontSize={11} fontStyle="italic" fill="var(--ink-muted)">no columns</text>
      )}
    </g>
  )
}

// A validation badge at a corner of a table box.
function TableBadge({ x, y, colour, onEnter, onLeave }) {
  const R = 6
  return (
    <g style={{ cursor: 'help', pointerEvents: 'all' }} onMouseEnter={onEnter} onMouseLeave={onLeave}
       onMouseDown={e => e.stopPropagation()}>
      <circle cx={x} cy={y} r={R + 2} fill="transparent"/>
      <circle cx={x} cy={y} r={R} fill={colour}/>
      <text x={x} y={y} textAnchor="middle" dominantBaseline="middle"
        fontSize={7} fontWeight={700} fill="#fff" style={{ pointerEvents: 'none', fontFamily: FONT }}>!</text>
    </g>
  )
}

// schemaId: in a mapping diagram, the relational side to draw (tinted as
// side `tint`); else the diagram's own schema.
export default function ErdView({ schemaId: sideSchemaId = null, tint = null }) {
  const objectTypes = useOrmStore(s => s.objectTypes)
  const facts       = useOrmStore(s => s.facts)
  const constraints = useOrmStore(s => s.constraints)
  const diagram     = useOrmStore(s => s.diagrams.find(d => d.id === s.activeDiagramId))
  const selectedId  = useOrmStore(s => s.selectedId)
  const ruleHl      = useOrmStore(s => (sideSchemaId ? s.ruleHighlight : null))
  const schemaId    = sideSchemaId ?? diagram?.schemaId

  const { model, boxes } = useMemo(() => {
    const st = { objectTypes, facts, constraints }
    if (sideSchemaId && diagram) return mappingErdBoxes(st, diagram, sideSchemaId)
    const model = relationalModel(st, schemaId)
    return { model, boxes: diagram ? erdLayout(model, diagram) : new Map() }
  }, [objectTypes, facts, constraints, schemaId, diagram, sideSchemaId])

  // While a box is dragged its offset is local; it is stored on mouse up.
  const [drag, setDrag] = useState(null)  // { id, dx, dy }
  const dragRef = useRef(null)
  useEffect(() => () => dragRef.current?.cleanup?.(), [])

  const startDrag = (e, t) => {
    if (e.button !== 0) return
    e.stopPropagation()
    e.preventDefault()
    const store = useOrmStore.getState()
    store.select(t.id, 'entity')
    const sx = e.clientX, sy = e.clientY
    const onMove = (ev) => {
      const z = useOrmStore.getState().zoom
      const dx = (ev.clientX - sx) / z, dy = (ev.clientY - sy) / z
      if (!dragRef.current.moved && Math.hypot(dx, dy) < 3 / z) return
      dragRef.current.moved = true
      dragRef.current.dx = dx; dragRef.current.dy = dy
      setDrag({ id: t.id, dx, dy })
    }
    const cleanup = () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    const onUp = () => {
      cleanup()
      const r = dragRef.current
      dragRef.current = null
      setDrag(null)
      if (!r?.moved) return
      // The first move fixes every shown table where it is drawn now, so the
      // grid doesn't reflow around the moved one.
      const positions = {}
      for (const [id, b] of boxes) positions[id] = { x: b.x, y: b.y }
      positions[t.id] = { x: Math.round(boxes.get(t.id).x + r.dx), y: Math.round(boxes.get(t.id).y + r.dy) }
      useOrmStore.getState().setErdPositions(diagram.id, positions)
    }
    dragRef.current = { moved: false, dx: 0, dy: 0, cleanup }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  // A table's menu: grow the diagram from it (NeighbourPicker.jsx).
  const [menu, setMenu] = useState(null)
  const openMenu = (e, t) => {
    e.preventDefault()
    e.stopPropagation()
    const store = useOrmStore.getState()
    store.select(t.id, 'entity')
    const items = growItems(store, t.id).filter(x => x !== '---')
    if (items.length) setMenu({ x: e.clientX, y: e.clientY, items })
  }

  const selectColumn = (e, t, c) => {
    if (e.button !== 0) return
    e.stopPropagation()
    useOrmStore.getState().select(c.fact.id, 'fact')
  }

  // Line ends at the column rows: the first column of the foreign key, and the
  // column it references.
  const rowY = (t, c) => HEAD_H + 3 + Math.max(0, t.columns.indexOf(c)) * ROW_H + ROW_H / 2
  const links = useMemo(() => model.fks.map(fk => ({
    key: fk.constraintId, a: fk.fromTable.id, b: fk.toTable.id,
    ya: rowY(fk.fromTable, fk.from[0]), yb: rowY(fk.toTable, fk.to[0]),
  })), [model])
  const orthogonal = diagram?.erdLines === 'orthogonal'
  const ports = (bx) => orthogonal ? assignPorts(bx, links, HEAD_H) : assignRowPorts(bx, links, HEAD_H)
  const routes = useMemo(() => orthogonal ? routeLines(boxes, ports(boxes)) : routeDirect(boxes, ports(boxes)),
    [links, boxes, orthogonal])

  const shown = drag
    ? new Map([...boxes].map(([id, b]) => [id, id === drag.id ? { ...b, x: b.x + drag.dx, y: b.y + drag.dy } : b]))
    : boxes
  // While dragging, ports are assigned afresh for all lines (they spread along
  // the sides), but only the lines whose ports moved are routed again.
  const dragRoutes = useMemo(() => {
    if (!drag) return null
    const ends = ports(shown)
    const isMoved = (e) => {
      const r = routes.get(e.key)
      if (!r) return true
      const [x1, y1] = r.points[0], [x2, y2] = r.points[r.points.length - 1]
      return x1 !== e.from.x || y1 !== e.from.y || x2 !== e.to.x || y2 !== e.to.y || r.s1 !== e.from.side || r.s2 !== e.to.side
    }
    const moved = ends.filter(isMoved)
    if (orthogonal) return routeLines(shown, moved)
    const movedKeys = new Set(moved.map(e => e.key))
    const fixed = new Map([...routes].filter(([k]) => !movedKeys.has(k)))
    return routeDirect(shown, moved, { context: ends, fixed })
  }, [drag, links, boxes, routes, orthogonal])

  // A selected foreign key (its subset constraint) is drawn in the accent
  // colour, with its columns in both tables; so are the foreign keys of a
  // selected column.
  const selectedFks = new Set(model.fks.filter(fk => fk.constraintId === selectedId
    || fk.from.some(c => c.fact.id === selectedId) || fk.to.some(c => c.fact.id === selectedId)))
  const highlighted = new Set()
  for (const fk of model.fks) if (fk.constraintId === selectedId) for (const c of [...fk.from, ...fk.to]) highlighted.add(c)

  // Validation badges, as on ORM2 shapes: the schema's issues (an error or
  // warning badge at the top right of the table they are about, see
  // erdTargetOf) and its sample rows' violations (top left).
  const validationErrors = useOrmStore(s => s.validationErrors)
  const populationIssues = useOrmStore(s => s.populationIssues)
  const badges = useMemo(() => {
    const out = new Map()   // tableId → { issues: [], rows: [] }
    if (!schemaId || (!validationErrors?.length && !populationIssues?.length)) return out
    const state = useOrmStore.getState()
    const view = relationalView(state, schemaId)
    const parts = [{ schemaId, model, boxes }]
    const at = (tableId) => { if (!out.has(tableId)) out.set(tableId, { issues: [], rows: [] }); return out.get(tableId) }
    for (const e of validationErrors ?? []) {
      const t = erdTargetOf(state, parts, e.elementId)
      if (!t) continue
      const obj = rmObjectOf(view, e.elementId)
      at(t.tableId).issues.push({ id: e.id, severity: e.severity === 'error' ? 'error' : 'warning', message: e.message,
        label: obj && obj.kind !== 'table' && obj.kind !== 'view' ? obj.label : null })
    }
    for (const [rmId, texts] of rmViolations(view, populationIssues ?? [])) {
      const obj = view.objects.get(rmId)
      const tbl = obj && (obj.kind === 'table' || obj.kind === 'view' ? obj : view.objects.get(obj.table))
      const entityId = tbl?.entityId ?? (tbl?.of ? view.objects.get(tbl.of)?.entityId : null)
      if (!entityId || !boxes.has(entityId)) continue
      texts.forEach((m, i) => at(entityId).rows.push({ id: `${rmId}-${i}`, severity: 'population', message: m, label: obj.kind === 'table' ? null : obj.label }))
    }
    return out
  }, [validationErrors, populationIssues, schemaId, model, boxes])
  const [popup, setPopup] = useState(null)

  const selectFk = (e, fk) => {
    if (e.button !== 0) return
    e.stopPropagation()
    useOrmStore.getState().select(fk.constraintId, 'constraint')
  }

  return (
    <g className={sideSchemaId ? 'mapping-erd' : 'erd-view'}>
      {[...model.fks].sort((p, q) => selectedFks.has(p) - selectedFks.has(q)).map(fk => (
        <FkLine key={fk.constraintId} fk={fk} selected={selectedFks.has(fk)} onDown={selectFk}
          route={dragRoutes?.get(fk.constraintId) ?? routes.get(fk.constraintId)}/>
      ))}
      {[...shown.values()].map(b => (
        <TableBox key={b.table.id} box={b} selectedId={selectedId} highlighted={highlighted} tint={tint} ruleHl={ruleHl}
          onHeaderDown={startDrag} onRowDown={selectColumn} onMenu={sideSchemaId ? null : openMenu}/>
      ))}
      {[...shown.values()].map(b => {
        const bd = badges.get(b.table.id)
        if (!bd) return null
        const show = (e, items) => { e.stopPropagation(); setPopup({ clientX: e.clientX, clientY: e.clientY, elementErrors: items }) }
        const sev = bd.issues.some(i => i.severity === 'error') ? 'error' : 'warning'
        return (
          <g key={`badge-${b.table.id}`}>
            {bd.issues.length > 0 && <TableBadge x={b.x + b.w - 1} y={b.y + 1} colour={BADGE_SEV_COLOUR[sev]}
              onEnter={e => show(e, bd.issues)} onLeave={() => setPopup(null)}/>}
            {bd.rows.length > 0 && <TableBadge x={b.x + 1} y={b.y + 1} colour={BADGE_SEV_COLOUR.population}
              onEnter={e => show(e, bd.rows)} onLeave={() => setPopup(null)}/>}
          </g>
        )
      })}
      <BadgePopup popup={popup}/>
      {menu && createPortal(<ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)}/>, document.body)}
    </g>
  )
}
