import React, { useEffect, useRef, useState } from 'react'

const FONT = "'Segoe UI', Helvetica, Arial, sans-serif"

const ITEM_STYLE = {
  display: 'flex', alignItems: 'center', gap: 6,
  width: '100%', textAlign: 'left',
  padding: '6px 14px', margin: 0,
  background: 'none', border: 'none', cursor: 'pointer',
  fontSize: 13, fontFamily: FONT,
}

function MenuPanel({ left, top, items, zIndex, onClose, onSubmenuEnter, onSubmenuLeave, openSubmenuIdx, submenuAnchorEl }) {
  return (
    <div
      style={{
        position: 'fixed', left, top,
        background: 'var(--bg-surface)',
        border: '1px solid var(--border)',
        borderRadius: 6,
        boxShadow: '0 4px 16px rgba(0,0,0,0.15)',
        zIndex,
        minWidth: 170,
        padding: '4px 0',
        userSelect: 'none',
      }}
    >
      {items.map((item, i) =>
        item === '---'
          ? <div key={i} style={{ height: 1, background: 'var(--border-soft)', margin: '3px 0' }}/>
          : item.submenu
            ? (
              <button
                key={i}
                style={{
                  ...ITEM_STYLE,
                  color: 'var(--ink-2)',
                  background: openSubmenuIdx === i ? 'var(--bg-hover)' : 'none',
                }}
                onMouseEnter={e => onSubmenuEnter(i, e.currentTarget)}
                onMouseLeave={onSubmenuLeave}
              >
                {item.label}
                <span style={{ marginLeft: 'auto', fontSize: 10, color: 'var(--ink-muted)', flexShrink: 0 }}>▶</span>
              </button>
            )
            : (
              <button
                key={i}
                disabled={!!item.disabled}
                onClick={() => { if (!item.disabled) { item.action(); onClose() } }}
                style={{
                  ...ITEM_STYLE,
                  color: item.disabled ? 'var(--ink-muted)'
                       : item.danger   ? 'var(--danger)'
                       :                 'var(--ink-2)',
                  cursor: item.disabled ? 'default' : 'pointer',
                }}
                onMouseEnter={e => {
                  onSubmenuEnter(null, null)   // close any open submenu
                  if (!item.disabled) e.currentTarget.style.background = 'var(--bg-hover)'
                }}
                onMouseLeave={e => { e.currentTarget.style.background = 'none' }}
              >
                {'checked' in item && (
                  <span style={{ width: 18, textAlign: 'center', flexShrink: 0, fontSize: 18,
                    color: 'var(--accent)', WebkitTextStroke: '0.7px var(--accent)' }}>
                    {item.checked ? '☑' : '☐'}
                  </span>
                )}
                {item.label}
              </button>
            )
      )}
    </div>
  )
}

export default function ContextMenu({ x, y, items, onClose }) {
  const wrapRef = useRef(null)
  const closeTimerRef = useRef(null)
  const [openSubmenuIdx, setOpenSubmenuIdx] = useState(null)
  const [anchorEl, setAnchorEl] = useState(null)

  const vw = window.innerWidth
  const vh = window.innerHeight
  const estW = 180
  // Separators render at ~7px; regular items at ~26px; plus 8px panel padding
  const estH = items.reduce((h, item) => h + (item === '---' ? 7 : 26), 8)
  const left = x + estW > vw ? Math.max(0, vw - estW - 4) : x
  const top  = y + estH <= vh ? y
             : y - estH >= 0  ? y - estH
             : Math.max(0, vh - estH)

  useEffect(() => {
    const onMouseDown = (e) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) onClose()
    }
    const onKeyDown = (e) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('mousedown', onMouseDown)
    window.addEventListener('keydown',   onKeyDown)
    return () => {
      window.removeEventListener('mousedown', onMouseDown)
      window.removeEventListener('keydown',   onKeyDown)
      if (closeTimerRef.current) clearTimeout(closeTimerRef.current)
    }
  }, [onClose])

  const scheduleClose = () => {
    closeTimerRef.current = setTimeout(() => {
      setOpenSubmenuIdx(null)
      setAnchorEl(null)
    }, 150)
  }
  const cancelClose = () => {
    if (closeTimerRef.current) clearTimeout(closeTimerRef.current)
  }

  const handleSubmenuEnter = (idx, el) => {
    cancelClose()
    setOpenSubmenuIdx(idx)
    setAnchorEl(el)
  }

  // Compute submenu position
  let subLeft = 0, subTop = 0
  if (openSubmenuIdx !== null && anchorEl) {
    const subItems = items[openSubmenuIdx]?.submenu ?? []
    const rect = anchorEl.getBoundingClientRect()
    const subEstW = 180
    const subEstH = subItems.length * 30
    subLeft = rect.right + 2 + subEstW > vw ? rect.left - subEstW - 2 : rect.right + 2
    subTop  = rect.top + subEstH > vh ? Math.max(0, vh - subEstH - 4) : rect.top
  }

  return (
    // Zero-size wrapper — only purpose is to group both panels for the outside-click test
    <div ref={wrapRef} style={{ position: 'fixed', top: 0, left: 0, width: 0, height: 0 }}>
      <MenuPanel
        left={left} top={top} items={items} zIndex={10100}
        onClose={onClose}
        onSubmenuEnter={handleSubmenuEnter}
        onSubmenuLeave={scheduleClose}
        openSubmenuIdx={openSubmenuIdx}
      />
      {openSubmenuIdx !== null && items[openSubmenuIdx]?.submenu && (
        <div
          style={{
            position: 'fixed', left: subLeft, top: subTop,
            background: 'var(--bg-surface)',
            border: '1px solid var(--border)',
            borderRadius: 6,
            boxShadow: '0 4px 16px rgba(0,0,0,0.15)',
            zIndex: 10101,
            minWidth: 170,
            padding: '4px 0',
            userSelect: 'none',
          }}
          onMouseEnter={cancelClose}
          onMouseLeave={scheduleClose}
        >
          {items[openSubmenuIdx].submenu.map((subItem, j) =>
            subItem === '---'
              ? <div key={j} style={{ height: 1, background: 'var(--border-soft)', margin: '3px 0' }}/>
              : (
                <button key={j}
                  disabled={!!subItem.disabled}
                  onClick={() => { if (!subItem.disabled) { subItem.action(); onClose() } }}
                  style={{
                    ...ITEM_STYLE,
                    color: subItem.disabled ? 'var(--ink-muted)'
                         : subItem.danger   ? 'var(--danger)'
                         :                   'var(--ink-2)',
                    cursor: subItem.disabled ? 'default' : 'pointer',
                  }}
                  onMouseEnter={e => { if (!subItem.disabled) e.currentTarget.style.background = 'var(--bg-hover)' }}
                  onMouseLeave={e => { e.currentTarget.style.background = 'none' }}
                >
                  {subItem.label}
                </button>
              )
          )}
        </div>
      )}
    </div>
  )
}
