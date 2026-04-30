import React, { useCallback, useRef } from 'react'
import { useOrmStore } from '../store/ormStore'
import { useDiagramElements } from '../hooks/useDiagramElements'
import { roleCenter, nestedFactBounds, ROLE_H } from './FactTypeNode'
import { roleAnchor } from './RoleConnectors'
import { entityBounds, formatValueRange } from './ObjectTypeNode'
import { EXTERNAL_CONSTRAINT_TYPES } from '../constants.js'

const CONSTRAINT_R = 14        // radius of standard constraint circle
const EXTERNAL_CONSTRAINT_R = 8 // radius of external constraint circle (2× mandatory dot)

const FREQ_FONT_SIZE = 9
const FREQ_PAD_X     = 6   // horizontal padding inside stadium, each side

let _freqCanvas = null
function measureFreqText(text) {
  if (!_freqCanvas) _freqCanvas = document.createElement('canvas')
  const ctx = _freqCanvas.getContext('2d')
  ctx.font = `${FREQ_FONT_SIZE}px monospace`
  return ctx.measureText(text).width
}

function formatFrequencyRange(frequency) {
  if (!frequency || frequency.length === 0) return null
  if (frequency.length === 1) {
    const s = frequency[0]
    if (s.type === 'lower' && (s.lower ?? '') !== '') return `\u2265${s.lower}`
    if (s.type === 'upper' && (s.upper ?? '') !== '') return `\u2264${s.upper}`
  }
  const full = formatValueRange(frequency)
  return full ? full.slice(1, -1) : null
}

function freqStadiumW(label) {
  const minW = EXTERNAL_CONSTRAINT_R * 2   // never narrower than a circle
  if (!label) return minW
  return Math.max(minW, measureFreqText(label) + FREQ_PAD_X * 2)
}

const CONSTRAINT_SYMBOL = {
  equality:   '=',
  subset:     '⊆',
  ring:       '↺',
  frequency:  'F',
}

// ── ORM2 ring constraint mini-symbols ─────────────────────────────────────────
// Each symbol is drawn centered at (cx, cy) within a ~19×19 bounding box.
// Arch symbols: feet at cy+4, apex at cy-4 (radius 8).
// Triangle symbols: same vertical span.
export function RingMiniSymbol({ type, cx, cy, color, scale = 1 }) {
  const sw  = 1.4
  const hw  = 8 * scale
  const bot = cy + 4 * scale
  const top = cy - 4 * scale

  // Semicircle arch: feet at (cx±hw, bot), apex at (cx, top)
  const archD = `M ${cx - hw},${bot} A ${hw},${hw} 0 0,1 ${cx + hw},${bot}`

  // Filled arrowhead at right arch foot, pointing →
  const ArrR = () => <polygon
    points={`${cx+hw},${bot} ${cx+hw-5},${bot-3} ${cx+hw-5},${bot+3}`}
    fill={color}/>
  // Filled arrowhead at left arch foot, pointing ←
  const ArrL = () => <polygon
    points={`${cx-hw},${bot} ${cx-hw+5},${bot-3} ${cx-hw+5},${bot+3}`}
    fill={color}/>

  const Arch = () =>
    <path d={archD} fill="none" stroke={color} strokeWidth={sw} strokeLinecap="round"/>

  switch (type) {
    case 'irreflexive': {
      const cr = EXTERNAL_CONSTRAINT_R * scale
      const dashLen = 2.5
      return <g>
        <circle cx={cx} cy={cy} r={cr} fill="none" stroke={color} strokeWidth={sw}/>
        <circle cx={cx - cr} cy={cy} r={2.5} fill={color}/>
        <line x1={cx + cr - dashLen} y1={cy} x2={cx + cr + dashLen} y2={cy}
          stroke={color} strokeWidth={sw} strokeLinecap="round"/>
      </g>
    }

    case 'reflexive': {
      const cr = EXTERNAL_CONSTRAINT_R * scale
      return <g>
        <circle cx={cx} cy={cy} r={cr} fill="none" stroke={color} strokeWidth={sw}/>
        <circle cx={cx - cr} cy={cy} r={2.5} fill={color}/>
      </g>
    }

    case 'purely-reflexive': {
      const cr = EXTERNAL_CONSTRAINT_R * scale
      const halfLen = cr / 3
      return <g>
        <circle cx={cx} cy={cy} r={cr} fill="none" stroke={color} strokeWidth={sw}/>
        <circle cx={cx - cr} cy={cy} r={2.5} fill={color}/>
        <line x1={cx} y1={cy - halfLen} x2={cx} y2={cy + halfLen}
          stroke={color} strokeWidth={sw} strokeLinecap="round"/>
      </g>
    }

    case 'asymmetric': {
      const ry = EXTERNAL_CONSTRAINT_R * scale
      const rx = EXTERNAL_CONSTRAINT_R * scale * 1.2
      const dashLen = 2.5
      return <g>
        <ellipse cx={cx} cy={cy} rx={rx} ry={ry} fill="none" stroke={color} strokeWidth={sw}/>
        <circle cx={cx - rx} cy={cy} r={2.5} fill={color}/>
        <circle cx={cx + rx} cy={cy} r={2.5} fill={color}/>
        <line x1={cx} y1={cy + ry - dashLen} x2={cx} y2={cy + ry + dashLen}
          stroke={color} strokeWidth={sw} strokeLinecap="round"/>
      </g>
    }

    case 'symmetric': {
      const ry = EXTERNAL_CONSTRAINT_R * scale
      const rx = EXTERNAL_CONSTRAINT_R * scale * 1.2
      return <g>
        <ellipse cx={cx} cy={cy} rx={rx} ry={ry} fill="none" stroke={color} strokeWidth={sw}/>
        <circle cx={cx - rx} cy={cy} r={2.5} fill={color}/>
        <circle cx={cx + rx} cy={cy} r={2.5} fill={color}/>
      </g>
    }

    case 'antisymmetric': {
      const ry = EXTERNAL_CONSTRAINT_R * scale
      const rx = EXTERNAL_CONSTRAINT_R * scale * 1.2
      const dashLen = 2.5
      return <g>
        <ellipse cx={cx} cy={cy} rx={rx} ry={ry} fill="none" stroke={color} strokeWidth={sw}/>
        <circle cx={cx - rx} cy={cy} r={2.5} fill={color}/>
        <circle cx={cx + rx} cy={cy} r={2.5} fill="white" stroke={color} strokeWidth={sw}/>
        <line x1={cx} y1={cy + ry - dashLen} x2={cx} y2={cy + ry + dashLen}
          stroke={color} strokeWidth={sw} strokeLinecap="round"/>
      </g>
    }

    case 'transitive': {
      const cr = EXTERNAL_CONSTRAINT_R * scale
      const tx = [cx,              cx - cr * 0.866, cx + cr * 0.866]
      const ty = [cy - cr,         cy + cr * 0.5,   cy + cr * 0.5  ]
      return <g>
        <polygon points={tx.map((x, i) => `${x},${ty[i]}`).join(' ')}
          fill="none" stroke={color} strokeWidth={sw}
          strokeLinejoin="round" strokeLinecap="round"/>
        {tx.map((x, i) => <circle key={i} cx={x} cy={ty[i]} r={2.5} fill={color}/>)}
      </g>
    }

    case 'intransitive': {
      const cr = EXTERNAL_CONSTRAINT_R * scale
      const tx = [cx,              cx - cr * 0.866, cx + cr * 0.866]
      const ty = [cy - cr,         cy + cr * 0.5,   cy + cr * 0.5  ]
      const midY = cy + cr * 0.5
      const dashLen = 2.5
      return <g>
        <polygon points={tx.map((x, i) => `${x},${ty[i]}`).join(' ')}
          fill="none" stroke={color} strokeWidth={sw}
          strokeLinejoin="round" strokeLinecap="round"/>
        {tx.map((x, i) => <circle key={i} cx={x} cy={ty[i]} r={2.5} fill={color}/>)}
        <line x1={cx} y1={midY - dashLen} x2={cx} y2={midY + dashLen}
          stroke={color} strokeWidth={sw} strokeLinecap="round"/>
      </g>
    }

    case 'strongly-intransitive': {
      const cr = EXTERNAL_CONSTRAINT_R * scale
      const tx = [cx,              cx - cr * 0.866, cx + cr * 0.866]
      const ty = [cy - cr,         cy + cr * 0.5,   cy + cr * 0.5  ]
      const midY = cy + cr * 0.5
      const dashLen = 2.5
      const rmx = (tx[0] + tx[2]) / 2
      const rmy = (ty[0] + ty[2]) / 2
      return <g>
        <polygon points={tx.map((x, i) => `${x},${ty[i]}`).join(' ')}
          fill="none" stroke={color} strokeWidth={sw}
          strokeLinejoin="round" strokeLinecap="round"/>
        {tx.map((x, i) => <circle key={i} cx={x} cy={ty[i]} r={2.5} fill={color}/>)}
        <line x1={cx} y1={midY - dashLen} x2={cx} y2={midY + dashLen}
          stroke={color} strokeWidth={sw} strokeLinecap="round"/>
        <circle cx={rmx} cy={rmy} r={2.5} fill={color}/>
      </g>
    }

    case 'acyclic': {
      const cr = EXTERNAL_CONSTRAINT_R * scale
      const tx = [cx,              cx - cr * 0.866, cx + cr * 0.866]
      const ty = [cy - cr,         cy + cr * 0.5,   cy + cr * 0.5  ]
      const dashLen = 2.5
      return <g>
        <circle cx={cx} cy={cy} r={cr} fill="none" stroke={color} strokeWidth={sw}/>
        {tx.map((x, i) => <circle key={i} cx={x} cy={ty[i]} r={2.5} fill={color}/>)}
        <line x1={cx} y1={cy + cr - dashLen} x2={cx} y2={cy + cr + dashLen}
          stroke={color} strokeWidth={sw} strokeLinecap="round"/>
      </g>
    }

    case 'acyclic+intransitive': {
      // Acyclic circle + Intransitive triangle inscribed in the same circle, sharing the three dots
      const cr = EXTERNAL_CONSTRAINT_R * scale
      const dashLen = 2.5
      const tx = [cx,              cx - cr * 0.866, cx + cr * 0.866]
      const ty = [cy - cr,         cy + cr * 0.5,   cy + cr * 0.5  ]
      const midY = cy + cr * 0.5
      return <g>
        <circle cx={cx} cy={cy} r={cr} fill="none" stroke={color} strokeWidth={sw}/>
        <polygon points={tx.map((x, i) => `${x},${ty[i]}`).join(' ')}
          fill="none" stroke={color} strokeWidth={sw}
          strokeLinejoin="round" strokeLinecap="round"/>
        {tx.map((x, i) => <circle key={i} cx={x} cy={ty[i]} r={2.5} fill={color}/>)}
        <line x1={cx} y1={midY - dashLen} x2={cx} y2={midY + dashLen}
          stroke={color} strokeWidth={sw} strokeLinecap="round"/>
        <line x1={cx} y1={cy + cr - dashLen} x2={cx} y2={cy + cr + dashLen}
          stroke={color} strokeWidth={sw} strokeLinecap="round"/>
      </g>
    }

    case 'acyclic+strongly-intransitive': {
      // Acyclic circle + Strongly Intransitive triangle inscribed in the same circle, sharing the three dots
      const cr = EXTERNAL_CONSTRAINT_R * scale
      const dashLen = 2.5
      const tx = [cx,              cx - cr * 0.866, cx + cr * 0.866]
      const ty = [cy - cr,         cy + cr * 0.5,   cy + cr * 0.5  ]
      const midY = cy + cr * 0.5
      const rmx = (tx[0] + tx[2]) / 2
      const rmy = (ty[0] + ty[2]) / 2
      return <g>
        <circle cx={cx} cy={cy} r={cr} fill="none" stroke={color} strokeWidth={sw}/>
        <polygon points={tx.map((x, i) => `${x},${ty[i]}`).join(' ')}
          fill="none" stroke={color} strokeWidth={sw}
          strokeLinejoin="round" strokeLinecap="round"/>
        {tx.map((x, i) => <circle key={i} cx={x} cy={ty[i]} r={2.5} fill={color}/>)}
        <line x1={cx} y1={midY - dashLen} x2={cx} y2={midY + dashLen}
          stroke={color} strokeWidth={sw} strokeLinecap="round"/>
        <circle cx={rmx} cy={rmy} r={2.5} fill={color}/>
        <line x1={cx} y1={cy + cr - dashLen} x2={cx} y2={cy + cr + dashLen}
          stroke={color} strokeWidth={sw} strokeLinecap="round"/>
      </g>
    }

    case 'acyclic+transitive': {
      // Acyclic circle + Transitive triangle inscribed in the same circle, sharing the three dots
      const cr = EXTERNAL_CONSTRAINT_R * scale
      const dashLen = 2.5
      const tx = [cx,              cx - cr * 0.866, cx + cr * 0.866]
      const ty = [cy - cr,         cy + cr * 0.5,   cy + cr * 0.5  ]
      return <g>
        <circle cx={cx} cy={cy} r={cr} fill="none" stroke={color} strokeWidth={sw}/>
        <polygon points={tx.map((x, i) => `${x},${ty[i]}`).join(' ')}
          fill="none" stroke={color} strokeWidth={sw}
          strokeLinejoin="round" strokeLinecap="round"/>
        {tx.map((x, i) => <circle key={i} cx={x} cy={ty[i]} r={2.5} fill={color}/>)}
        <line x1={cx} y1={cy + cr - dashLen} x2={cx} y2={cy + cr + dashLen}
          stroke={color} strokeWidth={sw} strokeLinecap="round"/>
      </g>
    }

    case 'transitive+strongly-intransitive': {
      // Strongly Intransitive triangle (outer, slightly enlarged) + smaller Transitive triangle centred inside
      const cr = EXTERNAL_CONSTRAINT_R * scale * 1.5
      const ri = EXTERNAL_CONSTRAINT_R * scale / 2
      const dashLen = 2.5
      const tx  = [cx,              cx - cr * 0.866, cx + cr * 0.866]
      const ty  = [cy - cr,         cy + cr * 0.5,   cy + cr * 0.5  ]
      const tx2 = [cx,              cx - ri * 0.866, cx + ri * 0.866]
      const ty2 = [cy - ri,         cy + ri * 0.5,   cy + ri * 0.5  ]
      const midY = cy + cr * 0.5
      const rmx = (tx[0] + tx[2]) / 2
      const rmy = (ty[0] + ty[2]) / 2
      return <g>
        <polygon points={tx.map((x, i) => `${x},${ty[i]}`).join(' ')}
          fill="none" stroke={color} strokeWidth={sw}
          strokeLinejoin="round" strokeLinecap="round"/>
        {tx.map((x, i) => <circle key={i} cx={x} cy={ty[i]} r={2.5} fill={color}/>)}
        <line x1={cx} y1={midY - dashLen} x2={cx} y2={midY + dashLen}
          stroke={color} strokeWidth={sw} strokeLinecap="round"/>
        <circle cx={rmx} cy={rmy} r={2.5} fill={color}/>
        <polygon points={tx2.map((x, i) => `${x},${ty2[i]}`).join(' ')}
          fill="none" stroke={color} strokeWidth={sw}
          strokeLinejoin="round" strokeLinecap="round"/>
        {tx2.map((x, i) => <circle key={`i${i}`} cx={x} cy={ty2[i]} r={1.7} fill={color}/>)}
      </g>
    }

    case 'transitive+intransitive': {
      // Intransitive triangle (outer, slightly enlarged) + smaller Transitive triangle centred inside
      const cr = EXTERNAL_CONSTRAINT_R * scale * 1.35
      const ri = EXTERNAL_CONSTRAINT_R * scale / 2
      const dashLen = 2.5
      const tx  = [cx,              cx - cr * 0.866, cx + cr * 0.866]
      const ty  = [cy - cr,         cy + cr * 0.5,   cy + cr * 0.5  ]
      const tx2 = [cx,              cx - ri * 0.866, cx + ri * 0.866]
      const ty2 = [cy - ri,         cy + ri * 0.5,   cy + ri * 0.5  ]
      const midY = cy + cr * 0.5
      return <g>
        <polygon points={tx.map((x, i) => `${x},${ty[i]}`).join(' ')}
          fill="none" stroke={color} strokeWidth={sw}
          strokeLinejoin="round" strokeLinecap="round"/>
        {tx.map((x, i) => <circle key={i} cx={x} cy={ty[i]} r={2.5} fill={color}/>)}
        <line x1={cx} y1={midY - dashLen} x2={cx} y2={midY + dashLen}
          stroke={color} strokeWidth={sw} strokeLinecap="round"/>
        <polygon points={tx2.map((x, i) => `${x},${ty2[i]}`).join(' ')}
          fill="none" stroke={color} strokeWidth={sw}
          strokeLinejoin="round" strokeLinecap="round"/>
        {tx2.map((x, i) => <circle key={`i${i}`} cx={x} cy={ty2[i]} r={1.7} fill={color}/>)}
      </g>
    }

    case 'antisymmetric+intransitive': {
      // Antisymmetric ellipse (outer) + smaller Intransitive triangle centred inside
      const ry = EXTERNAL_CONSTRAINT_R * scale
      const rx = EXTERNAL_CONSTRAINT_R * scale * 1.2
      const ri = EXTERNAL_CONSTRAINT_R * scale / 2
      const dashLen = 2.5
      const tx = [cx,              cx - ri * 0.866, cx + ri * 0.866]
      const ty = [cy - ri,         cy + ri * 0.5,   cy + ri * 0.5  ]
      const midY = cy + ri * 0.5
      return <g>
        <ellipse cx={cx} cy={cy} rx={rx} ry={ry} fill="none" stroke={color} strokeWidth={sw}/>
        <circle cx={cx - rx} cy={cy} r={2.5} fill={color}/>
        <circle cx={cx + rx} cy={cy} r={2.5} fill="white" stroke={color} strokeWidth={sw}/>
        <line x1={cx} y1={cy + ry - dashLen} x2={cx} y2={cy + ry + dashLen}
          stroke={color} strokeWidth={sw} strokeLinecap="round"/>
        <polygon points={tx.map((x, i) => `${x},${ty[i]}`).join(' ')}
          fill="none" stroke={color} strokeWidth={sw}
          strokeLinejoin="round" strokeLinecap="round"/>
        {tx.map((x, i) => <circle key={i} cx={x} cy={ty[i]} r={1.7} fill={color}/>)}
        <line x1={cx} y1={midY - dashLen} x2={cx} y2={midY + dashLen}
          stroke={color} strokeWidth={sw} strokeLinecap="round"/>
      </g>
    }

    case 'antisymmetric+transitive': {
      // Antisymmetric ellipse (outer) + smaller Transitive triangle centred inside
      const ry = EXTERNAL_CONSTRAINT_R * scale
      const rx = EXTERNAL_CONSTRAINT_R * scale * 1.2
      const ri = EXTERNAL_CONSTRAINT_R * scale / 2
      const dashLen = 2.5
      const tx = [cx,              cx - ri * 0.866, cx + ri * 0.866]
      const ty = [cy - ri,         cy + ri * 0.5,   cy + ri * 0.5  ]
      return <g>
        <ellipse cx={cx} cy={cy} rx={rx} ry={ry} fill="none" stroke={color} strokeWidth={sw}/>
        <circle cx={cx - rx} cy={cy} r={2.5} fill={color}/>
        <circle cx={cx + rx} cy={cy} r={2.5} fill="white" stroke={color} strokeWidth={sw}/>
        <line x1={cx} y1={cy + ry - dashLen} x2={cx} y2={cy + ry + dashLen}
          stroke={color} strokeWidth={sw} strokeLinecap="round"/>
        <polygon points={tx.map((x, i) => `${x},${ty[i]}`).join(' ')}
          fill="none" stroke={color} strokeWidth={sw}
          strokeLinejoin="round" strokeLinecap="round"/>
        {tx.map((x, i) => <circle key={i} cx={x} cy={ty[i]} r={1.7} fill={color}/>)}
      </g>
    }

    case 'symmetric+transitive': {
      // Symmetric ellipse (outer) + smaller Transitive triangle centred inside
      const ry = EXTERNAL_CONSTRAINT_R * scale
      const rx = EXTERNAL_CONSTRAINT_R * scale * 1.2
      const ri = EXTERNAL_CONSTRAINT_R * scale / 2
      const tx = [cx,              cx - ri * 0.866, cx + ri * 0.866]
      const ty = [cy - ri,         cy + ri * 0.5,   cy + ri * 0.5  ]
      return <g>
        <ellipse cx={cx} cy={cy} rx={rx} ry={ry} fill="none" stroke={color} strokeWidth={sw}/>
        <circle cx={cx - rx} cy={cy} r={2.5} fill={color}/>
        <circle cx={cx + rx} cy={cy} r={2.5} fill={color}/>
        <polygon points={tx.map((x, i) => `${x},${ty[i]}`).join(' ')}
          fill="none" stroke={color} strokeWidth={sw}
          strokeLinejoin="round" strokeLinecap="round"/>
        {tx.map((x, i) => <circle key={i} cx={x} cy={ty[i]} r={1.7} fill={color}/>)}
      </g>
    }

    case 'symmetric+intransitive': {
      // Symmetric ellipse (outer) + smaller Intransitive triangle centred inside
      const ry = EXTERNAL_CONSTRAINT_R * scale
      const rx = EXTERNAL_CONSTRAINT_R * scale * 1.2
      const ri = EXTERNAL_CONSTRAINT_R * scale / 2
      const dashLen = 2.5
      const tx = [cx,              cx - ri * 0.866, cx + ri * 0.866]
      const ty = [cy - ri,         cy + ri * 0.5,   cy + ri * 0.5  ]
      const midY = cy + ri * 0.5
      return <g>
        <ellipse cx={cx} cy={cy} rx={rx} ry={ry} fill="none" stroke={color} strokeWidth={sw}/>
        <circle cx={cx - rx} cy={cy} r={2.5} fill={color}/>
        <circle cx={cx + rx} cy={cy} r={2.5} fill={color}/>
        <polygon points={tx.map((x, i) => `${x},${ty[i]}`).join(' ')}
          fill="none" stroke={color} strokeWidth={sw}
          strokeLinejoin="round" strokeLinecap="round"/>
        {tx.map((x, i) => <circle key={i} cx={x} cy={ty[i]} r={1.7} fill={color}/>)}
        <line x1={cx} y1={midY - dashLen} x2={cx} y2={midY + dashLen}
          stroke={color} strokeWidth={sw} strokeLinecap="round"/>
      </g>
    }

    case 'symmetric+antisymmetric': {
      // Antisymmetric ellipse (outer) + smaller Symmetric ellipse centred inside
      const ry = EXTERNAL_CONSTRAINT_R * scale
      const rx = EXTERNAL_CONSTRAINT_R * scale * 1.2
      const ry_i = EXTERNAL_CONSTRAINT_R * scale / 2
      const rx_i = ry_i * 1.2
      const dashLen = 2.5
      return <g>
        <ellipse cx={cx} cy={cy} rx={rx} ry={ry} fill="none" stroke={color} strokeWidth={sw}/>
        <circle cx={cx - rx} cy={cy} r={2.5} fill={color}/>
        <circle cx={cx + rx} cy={cy} r={2.5} fill="white" stroke={color} strokeWidth={sw}/>
        <line x1={cx} y1={cy + ry - dashLen} x2={cx} y2={cy + ry + dashLen}
          stroke={color} strokeWidth={sw} strokeLinecap="round"/>
        <ellipse cx={cx} cy={cy} rx={rx_i} ry={ry_i} fill="none" stroke={color} strokeWidth={sw}/>
        <circle cx={cx - rx_i} cy={cy} r={1.7} fill={color}/>
        <circle cx={cx + rx_i} cy={cy} r={1.7} fill={color}/>
      </g>
    }

    case 'asymmetric+intransitive': {
      // Asymmetric ellipse (outer) + smaller Intransitive triangle centred inside
      const ry = EXTERNAL_CONSTRAINT_R * scale
      const rx = EXTERNAL_CONSTRAINT_R * scale * 1.2
      const ri = EXTERNAL_CONSTRAINT_R * scale / 2
      const dashLen = 2.5
      const tx = [cx,              cx - ri * 0.866, cx + ri * 0.866]
      const ty = [cy - ri,         cy + ri * 0.5,   cy + ri * 0.5  ]
      const midY = cy + ri * 0.5
      return <g>
        <ellipse cx={cx} cy={cy} rx={rx} ry={ry} fill="none" stroke={color} strokeWidth={sw}/>
        <circle cx={cx - rx} cy={cy} r={2.5} fill={color}/>
        <circle cx={cx + rx} cy={cy} r={2.5} fill={color}/>
        <line x1={cx} y1={cy + ry - dashLen} x2={cx} y2={cy + ry + dashLen}
          stroke={color} strokeWidth={sw} strokeLinecap="round"/>
        <polygon points={tx.map((x, i) => `${x},${ty[i]}`).join(' ')}
          fill="none" stroke={color} strokeWidth={sw}
          strokeLinejoin="round" strokeLinecap="round"/>
        {tx.map((x, i) => <circle key={i} cx={x} cy={ty[i]} r={1.7} fill={color}/>)}
        <line x1={cx} y1={midY - dashLen} x2={cx} y2={midY + dashLen}
          stroke={color} strokeWidth={sw} strokeLinecap="round"/>
      </g>
    }

    case 'asymmetric+transitive': {
      // Asymmetric ellipse (outer) + smaller Transitive triangle centred inside
      const ry = EXTERNAL_CONSTRAINT_R * scale
      const rx = EXTERNAL_CONSTRAINT_R * scale * 1.2
      const ri = EXTERNAL_CONSTRAINT_R * scale / 2
      const dashLen = 2.5
      const tx = [cx,              cx - ri * 0.866, cx + ri * 0.866]
      const ty = [cy - ri,         cy + ri * 0.5,   cy + ri * 0.5  ]
      return <g>
        <ellipse cx={cx} cy={cy} rx={rx} ry={ry} fill="none" stroke={color} strokeWidth={sw}/>
        <circle cx={cx - rx} cy={cy} r={2.5} fill={color}/>
        <circle cx={cx + rx} cy={cy} r={2.5} fill={color}/>
        <line x1={cx} y1={cy + ry - dashLen} x2={cx} y2={cy + ry + dashLen}
          stroke={color} strokeWidth={sw} strokeLinecap="round"/>
        <polygon points={tx.map((x, i) => `${x},${ty[i]}`).join(' ')}
          fill="none" stroke={color} strokeWidth={sw}
          strokeLinejoin="round" strokeLinecap="round"/>
        {tx.map((x, i) => <circle key={i} cx={x} cy={ty[i]} r={1.7} fill={color}/>)}
      </g>
    }

    case 'reflexive+transitive': {
      // Reflexive circle (outer) + smaller Transitive triangle centred inside
      const cr = EXTERNAL_CONSTRAINT_R * scale
      const ri = cr / 2
      const tx = [cx,              cx - ri * 0.866, cx + ri * 0.866]
      const ty = [cy - ri,         cy + ri * 0.5,   cy + ri * 0.5  ]
      return <g>
        <circle cx={cx} cy={cy} r={cr} fill="none" stroke={color} strokeWidth={sw}/>
        <circle cx={cx - cr} cy={cy} r={2.5} fill={color}/>
        <polygon points={tx.map((x, i) => `${x},${ty[i]}`).join(' ')}
          fill="none" stroke={color} strokeWidth={sw}
          strokeLinejoin="round" strokeLinecap="round"/>
        {tx.map((x, i) => <circle key={i} cx={x} cy={ty[i]} r={1.7} fill={color}/>)}
      </g>
    }

    case 'irreflexive+transitive': {
      // Irreflexive circle (outer) + smaller Transitive triangle centred inside
      const cr = EXTERNAL_CONSTRAINT_R * scale
      const ri = cr / 2
      const dashLen = 2.5
      const tx = [cx,              cx - ri * 0.866, cx + ri * 0.866]
      const ty = [cy - ri,         cy + ri * 0.5,   cy + ri * 0.5  ]
      return <g>
        <circle cx={cx} cy={cy} r={cr} fill="none" stroke={color} strokeWidth={sw}/>
        <circle cx={cx - cr} cy={cy} r={2.5} fill={color}/>
        <line x1={cx + cr - dashLen} y1={cy} x2={cx + cr + dashLen} y2={cy}
          stroke={color} strokeWidth={sw} strokeLinecap="round"/>
        <polygon points={tx.map((x, i) => `${x},${ty[i]}`).join(' ')}
          fill="none" stroke={color} strokeWidth={sw}
          strokeLinejoin="round" strokeLinecap="round"/>
        {tx.map((x, i) => <circle key={i} cx={x} cy={ty[i]} r={1.7} fill={color}/>)}
      </g>
    }

    case 'antisymmetric+irreflexive': {
      // Antisymmetric ellipse (outer) + smaller Irreflexive circle nested inside,
      // sharing the left dot. Open right dot and bottom dash from Antisymmetric.
      const ry = EXTERNAL_CONSTRAINT_R * scale
      const rx = EXTERNAL_CONSTRAINT_R * scale * 1.2
      const ri = EXTERNAL_CONSTRAINT_R * scale / 2
      const icx = cx - rx + ri
      const dashLen = 2.5
      return <g>
        <ellipse cx={cx} cy={cy} rx={rx} ry={ry} fill="none" stroke={color} strokeWidth={sw}/>
        <circle cx={icx} cy={cy} r={ri} fill="none" stroke={color} strokeWidth={sw}/>
        <circle cx={cx - rx} cy={cy} r={2.5} fill={color}/>
        <circle cx={cx + rx} cy={cy} r={2.5} fill="white" stroke={color} strokeWidth={sw}/>
        <line x1={cx} y1={cy + ry - dashLen} x2={cx} y2={cy + ry + dashLen}
          stroke={color} strokeWidth={sw} strokeLinecap="round"/>
        <line x1={icx + ri - dashLen} y1={cy} x2={icx + ri + dashLen} y2={cy}
          stroke={color} strokeWidth={sw} strokeLinecap="round"/>
      </g>
    }

    case 'reflexive+antisymmetric+transitive': {
      // Larger Antisymmetric ellipse + inner Reflexive circle (left) + Transitive triangle (right)
      const ry  = EXTERNAL_CONSTRAINT_R * scale * 1.2
      const rx  = EXTERNAL_CONSTRAINT_R * scale * 1.44
      const ri  = EXTERNAL_CONSTRAINT_R * scale / 2
      const icx = cx - rx + ri
      const r_tri = EXTERNAL_CONSTRAINT_R * scale * 0.5
      const tcx   = cx + EXTERNAL_CONSTRAINT_R * scale * 0.35
      const dashLen = 2.5
      const tx = [tcx,          tcx - r_tri * 0.866, tcx + r_tri * 0.866]
      const ty = [cy - r_tri,   cy + r_tri * 0.5,    cy + r_tri * 0.5   ]
      return <g>
        <ellipse cx={cx} cy={cy} rx={rx} ry={ry} fill="none" stroke={color} strokeWidth={sw}/>
        <circle cx={icx} cy={cy} r={ri} fill="none" stroke={color} strokeWidth={sw}/>
        <circle cx={cx - rx} cy={cy} r={2.5} fill={color}/>
        <circle cx={cx + rx} cy={cy} r={2.5} fill="white" stroke={color} strokeWidth={sw}/>
        <line x1={cx} y1={cy + ry - dashLen} x2={cx} y2={cy + ry + dashLen}
          stroke={color} strokeWidth={sw} strokeLinecap="round"/>
        <polygon points={tx.map((x, i) => `${x},${ty[i]}`).join(' ')}
          fill="none" stroke={color} strokeWidth={sw}
          strokeLinejoin="round" strokeLinecap="round"/>
        {tx.map((x, i) => <circle key={i} cx={x} cy={ty[i]} r={1.7} fill={color}/>)}
      </g>
    }

    case 'reflexive+antisymmetric': {
      // Antisymmetric ellipse (outer) + smaller Reflexive circle nested inside,
      // sharing the left dot. Open right dot and bottom dash from Antisymmetric.
      const ry = EXTERNAL_CONSTRAINT_R * scale
      const rx = EXTERNAL_CONSTRAINT_R * scale * 1.2
      const ri = EXTERNAL_CONSTRAINT_R * scale / 2
      const icx = cx - rx + ri
      const dashLen = 2.5
      return <g>
        <ellipse cx={cx} cy={cy} rx={rx} ry={ry} fill="none" stroke={color} strokeWidth={sw}/>
        <circle cx={icx} cy={cy} r={ri} fill="none" stroke={color} strokeWidth={sw}/>
        <circle cx={cx - rx} cy={cy} r={2.5} fill={color}/>
        <circle cx={cx + rx} cy={cy} r={2.5} fill="white" stroke={color} strokeWidth={sw}/>
        <line x1={cx} y1={cy + ry - dashLen} x2={cx} y2={cy + ry + dashLen}
          stroke={color} strokeWidth={sw} strokeLinecap="round"/>
      </g>
    }

    case 'reflexive+symmetric': {
      // Symmetric ellipse (outer) + smaller Reflexive circle nested inside,
      // sharing the left dot position. No dash (Reflexive has none).
      const ry = EXTERNAL_CONSTRAINT_R * scale
      const rx = EXTERNAL_CONSTRAINT_R * scale * 1.2
      const ri = EXTERNAL_CONSTRAINT_R * scale / 2
      const icx = cx - rx + ri
      return <g>
        <ellipse cx={cx} cy={cy} rx={rx} ry={ry} fill="none" stroke={color} strokeWidth={sw}/>
        <circle cx={icx} cy={cy} r={ri} fill="none" stroke={color} strokeWidth={sw}/>
        <circle cx={cx - rx} cy={cy} r={2.5} fill={color}/>
        <circle cx={cx + rx} cy={cy} r={2.5} fill={color}/>
      </g>
    }

    case 'symmetric+irreflexive': {
      const ry = EXTERNAL_CONSTRAINT_R * scale
      const rx = EXTERNAL_CONSTRAINT_R * scale * 1.2
      const ri = EXTERNAL_CONSTRAINT_R * scale / 2
      const icx = cx - rx + ri
      const dashLen = 2.5
      return <g>
        <ellipse cx={cx} cy={cy} rx={rx} ry={ry} fill="none" stroke={color} strokeWidth={sw}/>
        <circle cx={icx} cy={cy} r={ri} fill="none" stroke={color} strokeWidth={sw}/>
        <circle cx={cx - rx} cy={cy} r={2.5} fill={color}/>
        <circle cx={cx + rx} cy={cy} r={2.5} fill={color}/>
        <line x1={icx + ri - dashLen} y1={cy} x2={icx + ri + dashLen} y2={cy}
          stroke={color} strokeWidth={sw} strokeLinecap="round"/>
      </g>
    }

    default:
      return null
  }
}

const CONSTRAINT_COLOR = {
  exclusion:        'var(--col-constraint)',
  inclusiveOr:      'var(--col-constraint)',
  exclusiveOr:      'var(--col-constraint)',
  uniqueness:       'var(--col-constraint)',
  equality:         'var(--col-excl)',
  subset:           'var(--col-excl)',
  ring:             'var(--col-ring)',
  frequency:        'var(--col-freq)',
  valueComparison:  'var(--col-constraint)',
}

const HIGHLIGHT_ARC_COLOR = '#e67e22'   // orange — used when table row/col/cell is pressed

function borderPoint(ot, tx, ty) {
  const b = entityBounds(ot)
  const cx = b.cx, cy = b.cy
  const dx = tx - cx, dy = ty - cy
  if (dx === 0 && dy === 0) return { x: cx, y: cy }
  const hw = (b.right - b.left) / 2, hh = (b.bottom - b.top) / 2
  const t = Math.abs(dx) * hh > Math.abs(dy) * hw
    ? hw / Math.abs(dx)
    : hh / Math.abs(dy)
  return { x: cx + dx * t, y: cy + dy * t }
}

export default function ConstraintNodes({ onDragStart, mousePos, onContextMenu }) {
  const store = useOrmStore()
  const { objectTypes, facts, constraints: visibleConstraints, subtypes } = useDiagramElements()
  const factMap    = Object.fromEntries(facts.map(f => [f.id, f]))
  const subtypeMap = Object.fromEntries(subtypes.map(st => [st.id, st]))
  const otMap      = Object.fromEntries(objectTypes.map(o => [o.id, o]))
  const nestedMap  = Object.fromEntries(facts.filter(f => f.objectified).map(f => [f.id, f]))
  const mouseDownRef = useRef(null)  // tracks { id, x, y } for click-vs-drag detection

  // Returns true when every member across all groups resolves to the same object type,
  // meaning the target object type connector would be redundant.
  function allSequenceMembersSameOt(c) {
    const members = (c.sequences || []).flat()
    if (members.length === 0) return false
    const getId = m => {
      if (m.kind === 'role')    return factMap[m.factId]?.roles[m.roleIndex]?.objectTypeId ?? null
      if (m.kind === 'subtype') return subtypeMap[m.subtypeId]?.superId ?? null
      return null
    }
    const ids = members.map(getId)
    if (ids.some(id => !id)) return false
    return ids.every(id => id === ids[0])
  }

  // If two consecutive roles in the same fact, returns the point on the shared edge
  // (top/bottom for horizontal facts, left/right for vertical) closest to (cx, cy); else null.
  function consecutiveRoleMidpoint(factId0, ri0, factId1, ri1, cx, cy) {
    if (factId0 !== factId1) return null
    if (Math.abs(ri0 - ri1) !== 1) return null
    const fact = factMap[factId0]
    if (!fact) return null
    const rc0 = roleCenter(fact, ri0)
    const rc1 = roleCenter(fact, ri1)
    const midX = (rc0.x + rc1.x) / 2
    const midY = (rc0.y + rc1.y) / 2
    if (fact.orientation === 'vertical') {
      // Shared horizontal edge — pick left or right endpoint
      const lx = fact.x - ROLE_H / 2, rx = fact.x + ROLE_H / 2
      return (lx - cx) ** 2 < (rx - cx) ** 2
        ? { x: lx, y: midY }
        : { x: rx, y: midY }
    } else {
      // Shared vertical edge — pick top or bottom endpoint
      const ty = fact.y - ROLE_H / 2, by = fact.y + ROLE_H / 2
      return (ty - cy) ** 2 < (by - cy) ** 2
        ? { x: midX, y: ty }
        : { x: midX, y: by }
    }
  }

  // Geometry helper: line from constraint centre to a member (role or subtype midpoint)
  function memberArcLine(member, key, cx, cy, r0, color, selected, markerEnd) {
    const sw = selected ? 2.2 : 1.2
    const op = selected ? 1   : 0.75
    if (member.kind === 'role') {
      const fact = factMap[member.factId]
      if (!fact) return null
      const anchor = roleAnchor(fact, member.roleIndex, cx, cy)
      const dx = anchor.x - cx, dy = anchor.y - cy
      const len = Math.sqrt(dx * dx + dy * dy) || 1
      return (
        <line key={key}
          x1={cx + dx / len * r0} y1={cy + dy / len * r0}
          x2={anchor.x} y2={anchor.y}
          stroke={color} strokeWidth={sw} strokeDasharray="4 2" opacity={op}
          markerEnd={markerEnd}/>
      )
    } else {
      const st = subtypeMap[member.subtypeId]
      if (!st) return null
      const subOt = otMap[st.subId], supOt = otMap[st.superId]
      if (!subOt || !supOt) return null
      const from = borderPoint(subOt, supOt.x, supOt.y)
      const to   = borderPoint(supOt, subOt.x, subOt.y)
      const midX = (from.x + to.x) / 2, midY = (from.y + to.y) / 2
      const dx = midX - cx, dy = midY - cy
      const len = Math.sqrt(dx * dx + dy * dy) || 1
      return (
        <line key={key}
          x1={cx + dx / len * r0} y1={cy + dy / len * r0}
          x2={midX} y2={midY}
          stroke={color} strokeWidth={sw} strokeDasharray="4 2" opacity={op}
          markerEnd={markerEnd}/>
      )
    }
  }

  const isConnectTool      = store.tool === 'connectConstraint'
  const isTargetTool       = store.tool === 'addTargetConnector'
  const targetDraftActive  = isTargetTool && store.linkDraft?.type === 'targetConnector'
  const TARGET_TYPES       = new Set(['inclusiveOr', 'exclusiveOr', 'uniqueness', 'frequency', 'valueComparison'])

  return (
    <g>
      {visibleConstraints.map(c => {
        const isSelected  = store.selectedId === c.id || store.multiSelectedIds.includes(c.id)
        const isCandidate = (isConnectTool && !isSelected)
          || (isTargetTool && !targetDraftActive && TARGET_TYPES.has(c.constraintType) && !isSelected)
        const color = CONSTRAINT_COLOR[c.constraintType] || 'var(--ink-3)'
        const symbol = CONSTRAINT_SYMBOL[c.constraintType] || '?'

        // Draw arcs from constraint node — unified groups for subtype-like, roleGroups for others
        const r0 = (EXTERNAL_CONSTRAINT_TYPES.has(c.constraintType) && c.constraintType !== 'ring') ? EXTERNAL_CONSTRAINT_R : CONSTRAINT_R

        const h = store.constraintHighlight
        const isArcHighlighted = (gi, pi) => {
          if (!h || h.constraintId !== c.id) return false
          const gMatch = h.sequenceIndex == null || h.sequenceIndex === gi
          const pMatch = h.positionIndex == null || h.positionIndex === pi
          return gMatch && pMatch
        }

        const arcs = EXTERNAL_CONSTRAINT_TYPES.has(c.constraintType)
          ? (c.sequences || []).flatMap((seq, gi) => {
              // Two consecutive roles in the same fact → single arc to the midpoint
              if (seq.length === 2 && seq[0].kind === 'role' && seq[1].kind === 'role') {
                const mid = consecutiveRoleMidpoint(seq[0].factId, seq[0].roleIndex, seq[1].factId, seq[1].roleIndex, c.x, c.y)
                if (mid) {
                  const lit = isArcHighlighted(gi, 0) || isArcHighlighted(gi, 1)
                  const markerEnd = c.constraintType === 'subset' && gi === 1 ? 'url(#arrowSubsetSolid)' : undefined
                  const sw = lit ? 2.2 : 1.2, op = lit ? 1 : 0.75
                  const dx = mid.x - c.x, dy = mid.y - c.y
                  const len = Math.sqrt(dx * dx + dy * dy) || 1
                  return [<line key={`${c.id}-g${gi}-mid`}
                    x1={c.x + dx / len * r0} y1={c.y + dy / len * r0}
                    x2={mid.x} y2={mid.y}
                    stroke={lit ? HIGHLIGHT_ARC_COLOR : color}
                    strokeWidth={sw} strokeDasharray="4 2" opacity={op}
                    markerEnd={markerEnd}/>]
                }
              }
              return seq.map((member, mi) => {
                const lit = isArcHighlighted(gi, mi)
                const markerEnd = c.constraintType === 'subset' && gi === 1 ? 'url(#arrowSubsetSolid)' : undefined
                return memberArcLine(member, `${c.id}-g${gi}-m${mi}`, c.x, c.y, r0,
                  lit ? HIGHLIGHT_ARC_COLOR : color, lit, markerEnd)
              }).filter(Boolean)
            })
          : (c.roleSequences || []).flatMap((seq, gi) => {
              // Two consecutive roles in the same fact → single arc to the midpoint
              if (seq.length === 2) {
                const mid = consecutiveRoleMidpoint(seq[0].factId, seq[0].roleIndex, seq[1].factId, seq[1].roleIndex, c.x, c.y)
                if (mid) {
                  const dx = mid.x - c.x, dy = mid.y - c.y
                  const len = Math.sqrt(dx * dx + dy * dy) || 1
                  return [<line key={`${c.id}-g${gi}-mid`}
                    x1={c.x + dx / len * r0} y1={c.y + dy / len * r0}
                    x2={mid.x} y2={mid.y}
                    stroke={color} strokeWidth={1.2}
                    strokeDasharray={gi === 1 ? '4 2' : 'none'} opacity={0.75}
                    markerEnd={c.constraintType === 'subset' && gi === 0 ? 'url(#arrowSubset)' : undefined}/>]
                }
              }
              return seq.map((ref, ri) => {
                const fact = factMap[ref.factId]
                if (!fact) return null
                const rc = roleCenter(fact, ref.roleIndex)
                const dx = rc.x - c.x, dy = rc.y - c.y
                const len = Math.sqrt(dx * dx + dy * dy) || 1
                const key = `${c.id}-g${gi}-r${ri}`
                return (
                  <line key={key}
                    x1={c.x + dx / len * r0} y1={c.y + dy / len * r0}
                    x2={rc.x} y2={rc.y}
                    stroke={color} strokeWidth={1.2}
                    strokeDasharray={gi === 1 ? '4 2' : 'none'} opacity={0.75}
                    markerEnd={c.constraintType === 'subset' && gi === 0 ? 'url(#arrowSubset)' : undefined}/>
                )
              }).filter(Boolean)
            })

        // Arcs for members already collected in the current sequence construction session
        const gc = store.sequenceConstruction?.constraintId === c.id ? store.sequenceConstruction : null
        const constructionArcs = gc
          ? gc.collected.map(({ member }, i) =>
              memberArcLine(member, `${c.id}-gc-${i}`, c.x, c.y, r0, color, true)
            ).filter(Boolean)
          : []

        const subtypeArcs = []  // now handled inside arcs above

        return (
          <g key={c.id}
            className="selectable-group"
            onMouseDown={(e) => {
              e.stopPropagation()
              if (e.button !== 0 || e.detail >= 2) return  // skip second click of double-click
              if (store.tool === 'addConstraint:valueRange') { store.setTool('select'); return }
              if (isConnectTool) {
                store.select(c.id, 'constraint')
                store.startSequenceConstruction(c.id, 'newSequence')
                return
              }
              if (store.tool === 'addTargetConnector') {
                const draft = store.linkDraft
                if (draft?.type === 'targetConnector' && draft?.constraintId === c.id) {
                  store.clearLinkDraft()
                } else if (!targetDraftActive && TARGET_TYPES.has(c.constraintType)) {
                  store.select(c.id, 'constraint')
                  store.setLinkDraft({ type: 'targetConnector', constraintId: c.id })
                }
                return
              }
              if (store.tool === 'assignRole' || store.tool === 'addSubtype' || store.tool === 'toggleMandatory' || store.tool === 'addInternalUniqueness') { store.setTool('select'); return }
              if (e.shiftKey) {
                store.shiftSelect(c.id)
                return
              }
              if (isSelected && EXTERNAL_CONSTRAINT_TYPES.has(c.constraintType) && !store.sequenceConstruction) {
                // Track for deselect-on-click / drag
                mouseDownRef.current = { id: c.id, x: e.clientX, y: e.clientY }
                onDragStart(c.id, 'constraint', e)
                return
              }
              mouseDownRef.current = null
              store.select(c.id, 'constraint')
              onDragStart(c.id, 'constraint', e)
            }}
            onMouseUp={(e) => {
              const down = mouseDownRef.current
              if (down?.id === c.id) {
                const dist = Math.hypot(e.clientX - down.x, e.clientY - down.y)
                if (dist < 5) store.clearSelection()   // single click on selected → deselect
                mouseDownRef.current = null
              }
            }}
            onDoubleClick={(e) => {
              e.stopPropagation()
              if (!EXTERNAL_CONSTRAINT_TYPES.has(c.constraintType)) return
              if (store.sequenceConstruction) return
              store.select(c.id, 'constraint')
              store.startSequenceConstruction(c.id, 'newSequence')
            }}
            onContextMenu={(e) => onContextMenu(c, e)}
            style={{ cursor: (isConnectTool || (isTargetTool && !targetDraftActive && TARGET_TYPES.has(c.constraintType))) ? 'cell' : 'grab' }}
            filter={isSelected ? 'url(#selectGlow)' : undefined}
          >
            {arcs}
            {subtypeArcs}
            {constructionArcs.length > 0 && (
              <g filter="url(#selectGlow)">{constructionArcs}</g>
            )}

            {/* Draft line to mouse during group construction */}
            {gc && mousePos && (() => {
              const dx = mousePos.x - c.x, dy = mousePos.y - c.y
              const len = Math.sqrt(dx * dx + dy * dy) || 1
              return (
                <line
                  x1={c.x + dx / len * r0} y1={c.y + dy / len * r0}
                  x2={mousePos.x} y2={mousePos.y}
                  stroke={color} strokeWidth={1.2}
                  strokeDasharray="4 2" opacity={0.5}
                  style={{ pointerEvents: 'none' }}/>
              )
            })()}

            {/* Target object type connector */}
            {store.showTargetConnectors && c.targetObjectTypeId && (otMap[c.targetObjectTypeId] || nestedMap[c.targetObjectTypeId]) && (() => {
              const ot = otMap[c.targetObjectTypeId]
              const nf = !ot ? nestedMap[c.targetObjectTypeId] : null
              const bp = ot
                ? borderPoint(ot, c.x, c.y)
                : (() => {
                    const b = nestedFactBounds(nf)
                    const cx2 = (b.left + b.right) / 2, cy2 = (b.top + b.bottom) / 2
                    const dx2 = c.x - cx2, dy2 = c.y - cy2
                    if (dx2 === 0 && dy2 === 0) return { x: cx2, y: cy2 }
                    const hw = (b.right - b.left) / 2, hh = (b.bottom - b.top) / 2
                    const t = Math.abs(dx2) * hh > Math.abs(dy2) * hw ? hw / Math.abs(dx2) : hh / Math.abs(dy2)
                    return { x: cx2 + dx2 * t, y: cy2 + dy2 * t }
                  })()
              const dx = bp.x - c.x, dy = bp.y - c.y
              const len = Math.sqrt(dx * dx + dy * dy) || 1
              return (
                <line
                  x1={c.x + dx / len * r0} y1={c.y + dy / len * r0}
                  x2={bp.x} y2={bp.y}
                  stroke={color} strokeWidth={1.2}
                  strokeDasharray="1 3" strokeLinecap="round" opacity={0.75}
                  markerEnd="url(#arrowConstraintTarget)"
                  style={{ pointerEvents: 'none' }}/>
              )
            })()}

            {/* Constraint circle — omitted for ring with exactly 1 property / combined symbol, and for frequency (uses stadium) */}
            {c.constraintType !== 'frequency' && !(c.constraintType === 'ring' && (() => {
              const rt = c.ringTypes || []
              return rt.length === 1 ||
                (rt.length === 3 && rt.includes('reflexive') && rt.includes('antisymmetric') && rt.includes('transitive')) ||
                (rt.length === 2 && rt.includes('reflexive')   && rt.includes('symmetric')) ||
                (rt.length === 2 && rt.includes('reflexive')   && rt.includes('antisymmetric')) ||
                (rt.length === 2 && rt.includes('reflexive')   && rt.includes('transitive')) ||
                (rt.length === 2 && rt.includes('asymmetric')  && rt.includes('transitive')) ||
                (rt.length === 2 && rt.includes('asymmetric')  && rt.includes('intransitive')) ||
                (rt.length === 2 && rt.includes('symmetric')   && rt.includes('antisymmetric')) ||
                (rt.length === 2 && rt.includes('symmetric')     && rt.includes('transitive')) ||
                (rt.length === 2 && rt.includes('symmetric')     && rt.includes('intransitive')) ||
                (rt.length === 2 && rt.includes('antisymmetric') && rt.includes('transitive')) ||
                (rt.length === 2 && rt.includes('antisymmetric') && rt.includes('intransitive')) ||
                (rt.length === 2 && rt.includes('transitive') && rt.includes('intransitive')) ||
                (rt.length === 2 && rt.includes('transitive') && rt.includes('strongly-intransitive')) ||
                (rt.length === 2 && rt.includes('transitive')          && rt.includes('acyclic')) ||
                (rt.length === 2 && rt.includes('intransitive')         && rt.includes('acyclic')) ||
                (rt.length === 2 && rt.includes('strongly-intransitive') && rt.includes('acyclic')) ||
                (rt.length === 2 && rt.includes('irreflexive') && rt.includes('symmetric')) ||
                (rt.length === 2 && rt.includes('irreflexive') && rt.includes('antisymmetric')) ||
                (rt.length === 2 && rt.includes('irreflexive') && rt.includes('transitive'))
            })()) && (() => {
              const ringEmpty = c.constraintType === 'ring' && !(c.ringTypes || []).length
              return (
                <circle cx={c.x} cy={c.y}
                  r={c.constraintType === 'ring' ? CONSTRAINT_R : EXTERNAL_CONSTRAINT_TYPES.has(c.constraintType) ? EXTERNAL_CONSTRAINT_R : CONSTRAINT_R}
                  fill={isCandidate ? 'var(--fill-candidate)' : ringEmpty ? 'transparent' : '#ffffff'}
                  stroke={isCandidate ? 'var(--col-candidate)' : color}
                  strokeWidth={isSelected ? 2 : isCandidate ? 2 : 1.5}
                  strokeDasharray={c.constraintType === 'ring' ? '3 2' : 'none'}
                />
              )
            })()}

            {/* Symbol — text for standard types (never shown for ring constraints) */}
            {!EXTERNAL_CONSTRAINT_TYPES.has(c.constraintType) && c.constraintType !== 'ring' && (
              <text x={c.x} y={c.y}
                textAnchor="middle" dominantBaseline="central"
                fontSize={c.constraintType === 'ring' ? 14 : 11}
                fill={color}
                fontFamily="var(--font-mono)"
                fontWeight={600}
                style={{ pointerEvents: 'none' }}
              >
                {symbol}
              </text>
            )}

            {/* Subtype-like constraints — graphical symbols (not frequency, which uses a stadium) */}
            {EXTERNAL_CONSTRAINT_TYPES.has(c.constraintType) && c.constraintType !== 'frequency' && (() => {
              const d = EXTERNAL_CONSTRAINT_R * 0.707
              return (
                <g style={{ pointerEvents: 'none' }}>
                  {/* Cross — Exclusion and Exclusive Or */}
                  {(c.constraintType === 'exclusiveOr' || c.constraintType === 'exclusion') && (
                    <>
                      <line x1={c.x - d} y1={c.y - d} x2={c.x + d} y2={c.y + d}
                        stroke={isCandidate ? 'var(--col-candidate)' : color} strokeWidth={2} strokeLinecap="round"/>
                      <line x1={c.x + d} y1={c.y - d} x2={c.x - d} y2={c.y + d}
                        stroke={isCandidate ? 'var(--col-candidate)' : color} strokeWidth={2} strokeLinecap="round"/>
                    </>
                  )}
                  {/* Dot — Inclusive Or and Exclusive Or */}
                  {(c.constraintType === 'exclusiveOr' || c.constraintType === 'inclusiveOr') && (
                    <circle cx={c.x} cy={c.y} r={3.5} fill={isCandidate ? 'var(--col-candidate)' : color}/>
                  )}
                  {/* Symbol — Equality and Subset */}
                  {(c.constraintType === 'equality' || c.constraintType === 'subset') && (
                    <text x={c.x} y={c.y} textAnchor="middle" dominantBaseline="central"
                      fontSize={11} fill={isCandidate ? 'var(--col-candidate)' : color}
                      fontFamily="var(--font-mono)" fontWeight={600}
                      style={{ pointerEvents: 'none' }}>
                      {c.constraintType === 'equality' ? '=' : '⊆'}
                    </text>
                  )}
                  {/* Symbol + dots — Value Comparison */}
                  {c.constraintType === 'valueComparison' && (
                    <>
                      <circle cx={c.x - EXTERNAL_CONSTRAINT_R} cy={c.y} r={2}
                        fill={isCandidate ? 'var(--col-candidate)' : color}/>
                      <circle cx={c.x + EXTERNAL_CONSTRAINT_R} cy={c.y} r={2}
                        fill={isCandidate ? 'var(--col-candidate)' : color}/>
                      <text x={c.x} y={c.y} textAnchor="middle" dominantBaseline="central"
                        fontSize={11} fill={isCandidate ? 'var(--col-candidate)' : color}
                        fontFamily="var(--font-mono)" fontWeight={600}
                        style={{ pointerEvents: 'none' }}>
                        {c.operator ?? '='}
                      </text>
                    </>
                  )}
                  {/* Horizontal diameter line(s) — External Uniqueness */}
                  {c.constraintType === 'uniqueness' && (c.isPreferredIdentifier ? (
                    <>
                      <line x1={c.x - EXTERNAL_CONSTRAINT_R} y1={c.y - 1.5} x2={c.x + EXTERNAL_CONSTRAINT_R} y2={c.y - 1.5}
                        stroke={isCandidate ? 'var(--col-candidate)' : color} strokeWidth={1.5} strokeLinecap="round"/>
                      <line x1={c.x - EXTERNAL_CONSTRAINT_R} y1={c.y + 1.5} x2={c.x + EXTERNAL_CONSTRAINT_R} y2={c.y + 1.5}
                        stroke={isCandidate ? 'var(--col-candidate)' : color} strokeWidth={1.5} strokeLinecap="round"/>
                    </>
                  ) : (
                    <line x1={c.x - EXTERNAL_CONSTRAINT_R} y1={c.y} x2={c.x + EXTERNAL_CONSTRAINT_R} y2={c.y}
                      stroke={isCandidate ? 'var(--col-candidate)' : color} strokeWidth={2} strokeLinecap="round"/>
                  ))}
                </g>
              )
            })()}

            {/* Frequency stadium — rounded rect sized to fit the range label */}
            {c.constraintType === 'frequency' && (() => {
              const lbl = formatFrequencyRange(c.frequency) ?? ''
              const sw  = freqStadiumW(lbl)
              const sh  = EXTERNAL_CONSTRAINT_R   // half-height
              const strokeColor = isCandidate ? 'var(--col-candidate)' : color
              return (
                <g>
                  <rect
                    x={c.x - sw / 2} y={c.y - sh}
                    width={sw} height={sh * 2}
                    rx={sh}
                    fill={isCandidate ? 'var(--fill-candidate)' : '#ffffff'}
                    stroke={strokeColor}
                    strokeWidth={isSelected ? 2 : isCandidate ? 2 : 1.5}
                  />
                  <text x={c.x} y={c.y}
                    textAnchor="middle" dominantBaseline="central"
                    fontSize={FREQ_FONT_SIZE} fill={strokeColor}
                    fontFamily="'Segoe UI', Helvetica, Arial, sans-serif"
                    style={{ pointerEvents: 'none' }}
                  >
                    {lbl || 'F'}
                  </text>
                </g>
              )
            })()}

            {/* Ring type icons — ORM2 graphical symbols for each active property */}
            {c.constraintType === 'ring' && (() => {
              const types = c.ringTypes || (c.ringType ? [c.ringType] : [])
              if (!types.length) return null

              // Single property or special combined symbol: centred at constraint position, no circle
              const isCombined =
                (types.length === 3 && types.includes('reflexive') && types.includes('antisymmetric') && types.includes('transitive')) ||
                (types.length === 2 && types.includes('reflexive')   && types.includes('symmetric')) ||
                (types.length === 2 && types.includes('reflexive')   && types.includes('antisymmetric')) ||
                (types.length === 2 && types.includes('reflexive')   && types.includes('transitive')) ||
                (types.length === 2 && types.includes('asymmetric')  && types.includes('transitive')) ||
                (types.length === 2 && types.includes('asymmetric')  && types.includes('intransitive')) ||
                (types.length === 2 && types.includes('symmetric')   && types.includes('antisymmetric')) ||
                (types.length === 2 && types.includes('symmetric')     && types.includes('transitive')) ||
                (types.length === 2 && types.includes('symmetric')     && types.includes('intransitive')) ||
                (types.length === 2 && types.includes('antisymmetric') && types.includes('transitive')) ||
                (types.length === 2 && types.includes('antisymmetric') && types.includes('intransitive')) ||
                (types.length === 2 && types.includes('transitive') && types.includes('intransitive')) ||
                (types.length === 2 && types.includes('transitive') && types.includes('strongly-intransitive')) ||
                (types.length === 2 && types.includes('transitive')           && types.includes('acyclic')) ||
                (types.length === 2 && types.includes('intransitive')          && types.includes('acyclic')) ||
                (types.length === 2 && types.includes('strongly-intransitive') && types.includes('acyclic')) ||
                (types.length === 2 && types.includes('irreflexive') && types.includes('symmetric')) ||
                (types.length === 2 && types.includes('irreflexive') && types.includes('antisymmetric')) ||
                (types.length === 2 && types.includes('irreflexive') && types.includes('transitive'))
              const combinedType =
                (types.includes('reflexive') && types.includes('antisymmetric') && types.includes('transitive')) ? 'reflexive+antisymmetric+transitive' :
                (types.includes('reflexive')  && types.includes('symmetric'))     ? 'reflexive+symmetric'      :
                (types.includes('reflexive')  && types.includes('antisymmetric')) ? 'reflexive+antisymmetric'  :
                (types.includes('reflexive')  && types.includes('transitive'))    ? 'reflexive+transitive'     :
                (types.includes('asymmetric') && types.includes('transitive'))    ? 'asymmetric+transitive'    :
                (types.includes('asymmetric') && types.includes('intransitive'))  ? 'asymmetric+intransitive'  :
                (types.includes('symmetric')  && types.includes('antisymmetric')) ? 'symmetric+antisymmetric'  :
                (types.includes('symmetric')     && types.includes('transitive'))    ? 'symmetric+transitive'     :
                (types.includes('symmetric')     && types.includes('intransitive'))  ? 'symmetric+intransitive'   :
                (types.includes('antisymmetric') && types.includes('transitive'))    ? 'antisymmetric+transitive'   :
                (types.includes('antisymmetric') && types.includes('intransitive'))  ? 'antisymmetric+intransitive'  :
                (types.includes('transitive')           && types.includes('acyclic')) ? 'acyclic+transitive'            :
                (types.includes('intransitive')          && types.includes('acyclic')) ? 'acyclic+intransitive'          :
                (types.includes('strongly-intransitive') && types.includes('acyclic')) ? 'acyclic+strongly-intransitive' :
                (types.includes('transitive') && types.includes('strongly-intransitive')) ? 'transitive+strongly-intransitive' :
                (types.includes('transitive') && types.includes('intransitive'))          ? 'transitive+intransitive'          :
                (types.includes('irreflexive') && types.includes('symmetric'))    ? 'symmetric+irreflexive'    :
                (types.includes('irreflexive') && types.includes('antisymmetric'))? 'antisymmetric+irreflexive':
                                                                                    'irreflexive+transitive'
              if (types.length === 1 || isCombined) {
                const symType = isCombined ? combinedType : types[0]
                return (
                  <g>
                    <rect x={c.x - CONSTRAINT_R} y={c.y - CONSTRAINT_R}
                      width={CONSTRAINT_R * 2} height={CONSTRAINT_R * 2}
                      fill="transparent"/>
                    <RingMiniSymbol type={symType} cx={c.x} cy={c.y} color={color} scale={1.2}/>
                  </g>
                )
              }

              // Multiple properties: layout below the dashed circle
              const COLS = 5, CELL_W = 22, CELL_H = 20
              const baseY = c.y + CONSTRAINT_R + 5
              return (
                <g style={{ pointerEvents: 'none' }}>
                  {types.map((type, i) => {
                    const col = i % COLS
                    const row = Math.floor(i / COLS)
                    const countInRow = Math.min(types.length - row * COLS, COLS)
                    const sx = c.x - (countInRow * CELL_W) / 2 + col * CELL_W + CELL_W / 2
                    const sy = baseY + row * CELL_H + CELL_H / 2
                    return <RingMiniSymbol key={type} type={type} cx={sx} cy={sy} color={color} scale={1.2}/>
                  })}
                </g>
              )
            })()}
            {/* Hover ring — expanded 3–4px outward so it shows as a halo around the element */}
            {c.constraintType === 'frequency' ? (() => {
              const lbl_ = formatFrequencyRange(c.frequency) ?? ''
              const sw_  = freqStadiumW(lbl_)
              const sh_  = EXTERNAL_CONSTRAINT_R
              return <rect className="hover-ring" x={c.x - sw_/2 - 3} y={c.y - sh_ - 3} width={sw_ + 6} height={sh_*2 + 6} rx={sh_ + 3}/>
            })() : (
              <circle className="hover-ring" cx={c.x} cy={c.y}
                r={(EXTERNAL_CONSTRAINT_TYPES.has(c.constraintType) && c.constraintType !== 'ring' ? EXTERNAL_CONSTRAINT_R : CONSTRAINT_R) + 4}/>
            )}
          </g>
        )
      })}

      {/* Target connector draft line */}
      {store.tool === 'addTargetConnector' && store.linkDraft?.type === 'targetConnector' && (() => {
        const c = visibleConstraints.find(x => x.id === store.linkDraft.constraintId)
        if (!c) return null
        return (
          <line
            x1={c.x} y1={c.y}
            x2={mousePos.x} y2={mousePos.y}
            stroke="var(--col-constraint)" strokeWidth={1.2}
            strokeDasharray="4 2" opacity={0.6}
            style={{ pointerEvents: 'none' }}/>
        )
      })()}
    </g>
  )
}
