import React, { useRef, useState, useLayoutEffect } from 'react'

const FONT = "'Segoe UI', Helvetica, Arial, sans-serif"
const FOLD = 16  // dog-ear size

const textStyle = {
  fontSize: 11,
  fontFamily: FONT,
  lineHeight: '14px',
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
  overflow: 'hidden',
  height: '100%',
  boxSizing: 'border-box',
}

export default function NoteNode({ note, selected, onDragStart, onResizeStart, onDoubleClick, onContextMenu }) {
  const { id, x, y, w, h, text } = note
  const [truncated, setTruncated] = useState(null)
  const measRef = useRef(null)
  const measKey = useRef('')

  useLayoutEffect(() => {
    const key = `${text}|${w}|${h}`
    if (measKey.current === key) return
    measKey.current = key

    if (!text) { setTruncated(null); return }
    const m = measRef.current
    if (!m) return

    m.textContent = text
    if (m.scrollHeight <= m.clientHeight) { setTruncated(null); return }

    const ratio = m.clientHeight / m.scrollHeight
    const estimate = Math.floor(text.length * ratio * 0.92)
    const safe = Math.max(1, Math.min(estimate, text.length - 5))
    setTruncated(text.slice(0, safe) + ' [...]')
  }, [text, w, h])

  const lx = x - w / 2
  const ly = y - h / 2

  const borderColor = selected ? 'var(--accent)' : '#b8a040'
  const borderWidth = selected ? 1.5 : 1

  // Text area: full width minus left padding; a float:right placeholder
  // reserves only the fold triangle so text flows into the space below it.
  const textX = 7
  const textY = 5
  const textW = Math.max(1, w - textX)
  const textH = Math.max(1, h - 10)
  // How tall the fold triangle is inside the foreignObject coordinate space
  const foldReserveH = Math.max(0, FOLD - textY)

  return (
    <g
      className="selectable-group"
      transform={`translate(${lx},${ly})`}
      style={{ cursor: 'grab' }}
      onMouseDown={e => {
        if (e.button !== 0) return
        e.stopPropagation()
        onDragStart(id, 'note', e)
      }}
      onDoubleClick={e => {
        e.stopPropagation()
        onDoubleClick?.(id)
      }}
      onContextMenu={e => {
        e.preventDefault()
        e.stopPropagation()
        onContextMenu?.(note, e)
      }}
    >
      {/* Main body with dog-ear cut */}
      <path
        d={`M 0 0 L ${w - FOLD} 0 L ${w} ${FOLD} L ${w} ${h} L 0 ${h} Z`}
        fill="#fffde7"
        stroke={borderColor}
        strokeWidth={borderWidth}
      />
      {/* Dog-ear triangle */}
      <path
        d={`M ${w - FOLD} 0 L ${w - FOLD} ${FOLD} L ${w} ${FOLD} Z`}
        fill="#f0d060"
        stroke={borderColor}
        strokeWidth={borderWidth}
      />

      {/* Hover ring — styled by .selectable-group CSS rules */}
      <rect className="hover-ring" x={-3} y={-3} width={w + 6} height={h + 6} rx={4}/>

      {/* Text — foreignObject lets the browser handle word-wrapping as w/h change */}
      <foreignObject x={textX} y={textY} width={textW} height={textH}
        style={{ pointerEvents: 'none', overflow: 'hidden' }}>
        <div style={{ position: 'relative', width: '100%', height: '100%' }}>
          <div
            style={{
              ...textStyle,
              color: text ? '#333' : '#bbb',
              fontStyle: text ? 'normal' : 'italic',
            }}
          >
            {/* Float placeholder clears only the fold triangle; text flows into the
                full width below it automatically via normal CSS float behaviour. */}
            {foldReserveH > 0 && (
              <div style={{ float: 'right', width: FOLD, height: foldReserveH, pointerEvents: 'none' }}/>
            )}
            {truncated || text || 'Note…'}
          </div>
          {/* Hidden measurement — same font/width to match text wrapping exactly */}
          <div
            ref={measRef}
            style={{
              ...textStyle,
              position: 'absolute', left: 0, top: 0,
              visibility: 'hidden', pointerEvents: 'none',
            }}
          />
        </div>
      </foreignObject>

      {/* Resize handle — bottom-right corner */}
      <rect
        x={w - 12} y={h - 12} width={12} height={12}
        fill="transparent"
        style={{ cursor: 'nwse-resize' }}
        onMouseDown={e => {
          if (e.button !== 0) return
          e.stopPropagation()
          onResizeStart(id, e)
        }}
      />
      {selected && (
        <g style={{ pointerEvents: 'none' }}>
          <line x1={w - 9} y1={h - 2} x2={w - 2} y2={h - 9} stroke="var(--accent)" strokeWidth={1}/>
          <line x1={w - 6} y1={h - 2} x2={w - 2} y2={h - 6} stroke="var(--accent)" strokeWidth={1}/>
        </g>
      )}
    </g>
  )
}
