// The schema browser's sections for a relational schema showing its tables
// (relational/face.js): tables, views and assertions from relationalView.js,
// each table unfolding into its columns, keys, foreign keys and CHECKs. A
// relational schema is not edited by hand, so rows have no delete button;
// tables (and views) can be added to the active diagram, where the ERD draws
// them.

import React from 'react'
import { useOrmStore } from '../store/ormStore'
import { Highlight } from '../utils/nameFilter.jsx'

const FONT = 'var(--font-ui)'

const ICON = { width: 14, height: 14, viewBox: '0 0 14 14', style: { display: 'block', flexShrink: 0 } }
export function TableIcon({ view = false }) {
  return (
    <svg {...ICON}>
      <rect x="1.5" y="2" width="11" height="10" rx="1" fill="none" stroke="var(--col-schema-relational)" strokeWidth="1.2"
        strokeDasharray={view ? '2 1.4' : undefined}/>
      <line x1="1.5" y1="5" x2="12.5" y2="5" stroke="var(--col-schema-relational)" strokeWidth="1.2"/>
      <line x1="1.5" y1="8.5" x2="12.5" y2="8.5" stroke="var(--col-schema-relational)" strokeWidth="0.8"/>
    </svg>
  )
}
function PartIcon({ kind }) {
  const text = { column: '·', primaryKey: 'PK', unique: 'U', foreignKey: 'FK', check: '✓', notNull: 'NN', assertion: '∀' }[kind] ?? '·'
  return (
    <span style={{ width: 18, flexShrink: 0, fontSize: 8, fontWeight: 700, color: 'var(--ink-3)', fontFamily: 'var(--font-mono)', textAlign: 'center' }}>
      {text}
    </span>
  )
}

function AddButton({ onAdd, disabled }) {
  return (
    <button
      onMouseDown={e => e.stopPropagation()}
      onClick={e => { e.stopPropagation(); if (!disabled) onAdd() }}
      title={disabled ? 'Already in this diagram' : 'Add to this diagram'}
      style={{ background: 'none', border: `1px solid ${disabled ? 'var(--border-soft)' : 'var(--border)'}`, borderRadius: 3,
        cursor: disabled ? 'default' : 'pointer', padding: '2px 4px', width: '100%', display: 'flex', alignItems: 'center',
        justifyContent: 'center', color: disabled ? 'var(--border)' : 'var(--ink-muted)', opacity: disabled ? 0.5 : 1 }}
    >
      <svg width="9" height="9" viewBox="0 0 9 9" style={{ display: 'block' }}>
        <rect x="3.5" y="0" width="2" height="9" rx="0.5" fill="currentColor"/>
        <rect x="0" y="3.5" width="9" height="2" rx="0.5" fill="currentColor"/>
      </svg>
    </button>
  )
}

function Row({ depth = 0, icon, label, detail, selected, onSelect, toggle, open, add, orphan, muted, onMenu }) {
  return (
    <div className="rm-browser-row" onClick={onSelect} onContextMenu={onMenu}
      style={{ display: 'flex', alignItems: 'center', padding: '3px 8px', paddingLeft: 8 + depth * 14,
        borderBottom: '1px solid var(--border-soft)', cursor: 'pointer',
        background: selected ? 'var(--bg-raised)' : orphan ? 'rgba(192,57,43,0.04)' : undefined }}
      onMouseEnter={e => { e.currentTarget.style.background = 'var(--bg-raised)' }}
      onMouseLeave={e => { e.currentTarget.style.background = selected ? 'var(--bg-raised)' : orphan ? 'rgba(192,57,43,0.04)' : '' }}
    >
      {depth === 0 && <div style={{ width: 22, flexShrink: 0, marginRight: 5 }}>{add}</div>}
      <span onClick={toggle ? (e) => { e.stopPropagation(); toggle() } : undefined}
        style={{ width: 10, flexShrink: 0, fontSize: 8, color: 'var(--ink-3)', cursor: toggle ? 'pointer' : 'default' }}>
        {toggle ? (open ? '▾' : '▸') : ''}
      </span>
      <span style={{ flexShrink: 0, marginRight: 5, lineHeight: 0 }}>{icon}</span>
      <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        fontSize: 11, fontFamily: FONT, color: muted ? 'var(--ink-3)' : undefined }}>
        {label}{detail && <span style={{ color: 'var(--ink-3)', marginLeft: 6 }}>{detail}</span>}
      </span>
      {orphan && <span title="On no diagram" style={{ fontSize: 8, color: 'var(--danger)', marginLeft: 4 }}>●</span>}
    </div>
  )
}

// A column's marks, as the ERD shows them.
const colDetail = (c) => [c.type ?? '', c.pk ? 'PK' : '', c.fk ? 'FK' : '', c.notNull && !c.pk ? 'NOT NULL' : '',
  c.derived === 'derived' ? 'derived' : c.derived === 'semiDerived' ? 'semi-derived' : ''].filter(Boolean).join(' ')

// The sections, in SchemaBrowser's format: [{ title, items, renderRow }].
// Under a name filter, a table is listed when its name matches or one of its
// parts does; in the latter case it shows open, with only the matching parts.
export function relationalSections({ view, diagram, diagrams, expanded, toggle, selectedRmId, showOrphans, filter, onMenu = null }) {
  const st = () => useOrmStore.getState()
  const inDiag = (id) => diagram?.occurrences?.some(o => o.schemaElementId === id) ?? false
  const orphan = (id) => !diagrams.some(d => !d.mappingId && d.occurrences?.some(o => o.schemaElementId === id))
  const byName = (a, b) => a.name.localeCompare(b.name)
  const select = (o) => st().selectRm(o)
  const parts = (t) => [...t.columns, ...t.keys.filter(k => !k.startsWith('nn:'))].map(id => view.objects.get(id)).filter(Boolean)

  const partName = (p) => p.kind === 'column' ? p.name : p.label
  const hit = (t) => !filter || filter.test(t.name)
  const hitParts = (t) => filter ? parts(t).filter(p => filter.test(partName(p))) : []
  const tableRow = (t) => {
    const byPart = !hit(t)
    const open = byPart || expanded.has(t.rmId)
    const shown = byPart ? hitParts(t) : parts(t)
    const of = t.of ? view.objects.get(t.of) : null
    return (
      <React.Fragment key={t.rmId}>
        <Row icon={<TableIcon view={t.kind === 'view'} />} label={<Highlight text={t.name} filter={filter} />}
          detail={of ? `stored part of view ${of.name}` : t.kind === 'view' ? (t.derived === 'rows' ? 'derived rows' : 'derived columns') : null}
          selected={selectedRmId === t.rmId} onSelect={() => select(t)} toggle={byPart ? undefined : () => toggle(t.rmId)} open={open}
          add={!of && diagram ? <AddButton disabled={inDiag(t.entityId)} onAdd={() => st().addElementToDiagram(t.entityId, diagram.id)} /> : null}
          orphan={!of && orphan(t.entityId)} onMenu={!of && onMenu ? (e => onMenu(e, t.entityId)) : undefined} />
        {open && shown.map(p => (
          <Row key={p.rmId} depth={1} icon={<PartIcon kind={p.kind} />}
            label={<Highlight text={partName(p)} filter={filter} />}
            detail={p.kind === 'column' ? colDetail(p) : p.kind === 'foreignKey' ? `→ ${view.objects.get(p.refTable)?.name ?? '?'}` : p.sql}
            selected={selectedRmId === p.rmId} onSelect={() => select(p)} />
        ))}
      </React.Fragment>
    )
  }
  const keep = (t) => !showOrphans || (!t.of && orphan(t.entityId))
  const tables = view.tables.filter(t => t.kind === 'table' && keep(t)).sort(byName)
  const views = view.tables.filter(t => t.kind === 'view' && keep(t)).sort(byName)
  const assertions = showOrphans ? [] : view.assertions
  const narrow = (items, match) => filter ? { total: items.length, items: items.filter(match) } : { items }
  const tableHit = (t) => hit(t) || hitParts(t).length > 0
  return [
    { title: 'Tables', ...narrow(tables, tableHit), renderRow: tableRow },
    { title: 'Views', ...narrow(views, tableHit), renderRow: tableRow },
    {
      title: 'Assertions', ...narrow(assertions, (a) => filter.test(a.label)),
      renderRow: (a) => (
        <Row key={a.rmId} icon={<PartIcon kind="assertion" />} label={<Highlight text={a.label} filter={filter} />}
          detail={a.query ? null : 'no SQL form'}
          selected={selectedRmId === a.rmId} onSelect={() => select(a)} />
      ),
    },
  ].filter(s => s.items.length)
}

// Tables not in any diagram of their schema.
export function relationalOrphanCount(view, diagrams) {
  return view.tables.filter(t => !t.of && !diagrams.some(d => !d.mappingId && d.occurrences?.some(o => o.schemaElementId === t.entityId))).length
}
