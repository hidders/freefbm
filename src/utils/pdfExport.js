import { entityBounds } from '../components/ObjectTypeNode'
import { factBounds }   from '../components/FactTypeNode'
import { getDiagramElements } from '../hooks/useDiagramElements'

const PAD = 30

function computeBounds(store) {
  const { objectTypes, facts, constraints } = getDiagramElements(store)
  const all = [
    ...objectTypes.map(ot => {
      const b = entityBounds(ot)
      return { minX: b.left, minY: b.top, maxX: b.right, maxY: b.bottom }
    }),
    ...facts.map(f => {
      const b = factBounds(f)
      return { minX: b.left, minY: b.top, maxX: b.right, maxY: b.bottom }
    }),
    ...constraints.map(c => ({
      minX: c.x - 20, minY: c.y - 20, maxX: c.x + 20, maxY: c.y + 20,
    })),
  ]
  if (!all.length) return null
  return {
    minX: Math.min(...all.map(b => b.minX)) - PAD,
    minY: Math.min(...all.map(b => b.minY)) - PAD,
    maxX: Math.max(...all.map(b => b.maxX)) + PAD,
    maxY: Math.max(...all.map(b => b.maxY)) + PAD,
  }
}

// Replace var(--foo) and var(--foo, fallback) with computed values
function resolveCssVars(str, cssStyle) {
  return str.replace(/var\(([^),]+)(?:,[^)]+)?\)/g, (match, varName) => {
    const val = cssStyle.getPropertyValue(varName.trim()).trim()
    return val || match
  })
}

export async function triggerPdfExport(store) {
  if (!window.electronAPI) return

  const bounds = computeBounds(store)
  if (!bounds) return

  const { minX, minY, maxX, maxY } = bounds
  const vbW = maxX - minX
  const vbH = maxY - minY

  const svgEl = document.getElementById('orm2-canvas-svg')
  if (!svgEl) return

  const serializer = new XMLSerializer()
  const cssStyle   = getComputedStyle(document.documentElement)

  // ── defs (markers, filters) — strip grid patterns ──────────────────────────
  let defsStr = ''
  const defsEl = svgEl.querySelector('defs')
  if (defsEl) {
    const defsClone = defsEl.cloneNode(true)
    defsClone.querySelectorAll('pattern').forEach(p => p.remove())
    defsStr = resolveCssVars(serializer.serializeToString(defsClone), cssStyle)
  }

  // ── diagram group — remove pan/zoom transform ───────────────────────────────
  const diagramGroup = svgEl.querySelector('g[transform]')
  if (!diagramGroup) return
  const groupClone = diagramGroup.cloneNode(true)
  groupClone.removeAttribute('transform')
  // Remove inline text-editing inputs (foreignObject)
  groupClone.querySelectorAll('foreignObject').forEach(el => el.remove())
  const groupStr = resolveCssVars(serializer.serializeToString(groupClone), cssStyle)

  // ── assemble standalone SVG ─────────────────────────────────────────────────
  const svgDoc = [
    `<svg xmlns="http://www.w3.org/2000/svg"`,
    `     viewBox="${minX} ${minY} ${vbW} ${vbH}"`,
    `     width="${vbW}" height="${vbH}">`,
    defsStr,
    groupStr,
    `</svg>`,
  ].join('\n')

  const html = `<!DOCTYPE html>
<html>
<head>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { background: transparent; }
  svg { display: block; width: 100%; height: auto; }
</style>
</head>
<body>${svgDoc}</body>
</html>`

  await window.electronAPI.exportPdf(html)
}
