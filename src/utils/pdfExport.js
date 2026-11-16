import { entityBounds } from '../components/ObjectTypeNode'
import { factBounds, makeImplicitLinkFact } from '../components/FactTypeNode'
import { getDiagramElements } from '../hooks/useDiagramElements'

const PAD = 30

const escapeHtml = (t) => String(t).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])

function computeBounds(store) {
  const { objectTypes, facts, constraints } = getDiagramElements(store)
  // shown link fact types, drawn once per objectified fact type as on the canvas
  const linkFacts = facts
    .filter((f, i, list) => f.objectified && !f._implicit && list.findIndex(g => g.id === f.id) === i)
    .flatMap(f => (f.implicitLinks || [])
      .filter(il => store.isImplicitLinkShown(f.id, il.roleIndex))
      .map(il => makeImplicitLinkFact(f, il)))
  const all = [
    ...objectTypes.map(ot => {
      const b = entityBounds(ot)
      return { minX: b.left, minY: b.top, maxX: b.right, maxY: b.bottom }
    }),
    ...[...facts, ...linkFacts].map(f => {
      const b = factBounds(f)
      return { minX: b.left, minY: b.top, maxX: b.right, maxY: b.bottom }
    }),
    ...constraints.map(c => ({
      minX: c.x - 20, minY: c.y - 20, maxX: c.x + 20, maxY: c.y + 20,
    })),
    ...(store.diagrams?.find(d => d.id === store.activeDiagramId)?.notes ?? []).map(n => ({
      minX: n.x - n.w / 2, minY: n.y - n.h / 2, maxX: n.x + n.w / 2, maxY: n.y + n.h / 2,
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

// The page's stylesheet does not go into the PDF, so shapes styled only by
// CSS rules (the invisible hover rings, CSS-coloured fills) would fall back
// to SVG's default black fill. Copy each element's computed paint onto its
// clone instead.
const PAINT = ['fill', 'stroke', 'stroke-width', 'stroke-dasharray', 'stroke-linecap', 'stroke-linejoin',
  'opacity', 'fill-opacity', 'stroke-opacity', 'display', 'visibility',
  'font-family', 'font-size', 'font-weight', 'font-style']
function inlineComputedPaint(orig, clone) {
  const a = [orig, ...orig.querySelectorAll('*')]
  const b = [clone, ...clone.querySelectorAll('*')]
  if (a.length !== b.length) return
  for (let i = 0; i < a.length; i++) {
    if (!(a[i] instanceof SVGElement) || a[i] instanceof SVGForeignObjectElement) continue
    const cs = getComputedStyle(a[i])
    const style = PAINT.map(prop => {
      const v = cs.getPropertyValue(prop)
      return v ? `${prop}:${v}` : null
    }).filter(Boolean).join(';')
    b[i].setAttribute('style', [b[i].getAttribute('style'), style].filter(Boolean).join(';'))
  }
}

// A note's text is HTML in a foreignObject, which the PDF does not draw:
// write each line as the page laid it out as SVG text in its place.
function noteTextAsSvg(fo) {
  const shown = fo.firstElementChild?.firstElementChild
  const ctm = fo.getScreenCTM()
  if (!shown || !ctm) return null
  const cs = getComputedStyle(shown)
  if (cs.fontStyle === 'italic') return null   // the "Note…" placeholder of an empty note
  const inv = ctm.inverse()
  const local = (x, y) => new DOMPoint(x, y).matrixTransform(inv)
  const ctx = document.createElement('canvas').getContext('2d')
  ctx.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`
  const ascent = ctx.measureText('Hg').fontBoundingBoxAscent ?? parseFloat(cs.fontSize)
  const lines = []
  let cur = null
  const range = document.createRange()
  const walker = document.createTreeWalker(shown, NodeFilter.SHOW_TEXT)
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const t = node.textContent
    for (let i = 0; i < t.length; i++) {
      range.setStart(node, i); range.setEnd(node, i + 1)
      const r = range.getClientRects()[0]
      if (r && r.width >= 0 && !/\s/.test(t[i])) {
        const p = local(r.left, r.top)
        // zoomed, client pixels are larger than the diagram's: compare in its units
        if (!cur || p.y > cur.top + 1) { cur = { top: p.y, x: p.x, text: '' }; lines.push(cur) }
      }
      if (cur && t[i] !== '\n') cur.text += t[i]
    }
  }
  if (!lines.length) return null
  const ns = 'http://www.w3.org/2000/svg'
  const text = document.createElementNS(ns, 'text')
  text.setAttribute('style', `fill:${cs.color};font-family:${cs.fontFamily};font-size:${cs.fontSize};font-weight:${cs.fontWeight}`)
  text.setAttribute('xml:space', 'preserve')
  for (const l of lines) {
    const span = document.createElementNS(ns, 'tspan')
    span.setAttribute('x', l.x)
    span.setAttribute('y', l.top + ascent)
    span.textContent = l.text.trim()
    text.appendChild(span)
  }
  return text
}

export async function triggerPdfExport(store) {
  if (!window.electronAPI) return

  const svgEl = document.getElementById('orm2-canvas-svg')
  if (!svgEl) return

  // An ERD view's tables and lines have their own positions: take the bounds
  // from what is drawn.
  const erd = svgEl.querySelector('.erd-view')
  let bounds
  if (erd) {
    const b = erd.getBBox()
    if (!b.width && !b.height) return
    bounds = { minX: b.x - PAD, minY: b.y - PAD, maxX: b.x + b.width + PAD, maxY: b.y + b.height + PAD }
  } else bounds = computeBounds(store)
  // A mapping diagram's ERD tables (relational side) are drawn by ErdView.
  for (const g of svgEl.querySelectorAll('.mapping-erd')) {
    const b = g.getBBox()
    if (!b.width && !b.height) continue
    const e = { minX: b.x - PAD, minY: b.y - PAD, maxX: b.x + b.width + PAD, maxY: b.y + b.height + PAD }
    bounds = bounds ? { minX: Math.min(bounds.minX, e.minX), minY: Math.min(bounds.minY, e.minY), maxX: Math.max(bounds.maxX, e.maxX), maxY: Math.max(bounds.maxY, e.maxY) } : e
  }
  if (!bounds) return

  const { minX, minY, maxX, maxY } = bounds
  const vbW = maxX - minX
  const vbH = maxY - minY

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
  inlineComputedPaint(diagramGroup, groupClone)
  // Notes: their text as SVG text in place of the HTML
  const origNotes = [...diagramGroup.querySelectorAll('foreignObject.note-text')]
  const cloneNotes = [...groupClone.querySelectorAll('foreignObject.note-text')]
  origNotes.forEach((fo, i) => {
    const text = noteTextAsSvg(fo)
    if (text && cloneNotes[i]) cloneNotes[i].replaceWith(text)
  })
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
<title>${escapeHtml(store.diagrams?.find(d => d.id === store.activeDiagramId)?.name ?? 'Diagram')}</title>
<style>
  @page { margin: 10mm; }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { width: 100%; height: 100%; overflow: hidden; background: transparent; }
  /* The whole diagram on one page, scaled to fit either way. */
  svg { display: block; width: 100%; height: 100%; }
</style>
</head>
<body>${svgDoc}</body>
</html>`

  await window.electronAPI.exportPdf(html)
}
