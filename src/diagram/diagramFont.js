// The font diagrams are drawn in: Wine Tahoma, which has Tahoma's widths, so
// text is as wide as in NORMA (Tahoma 7 pt). DejaVu Sans, scaled to about the
// same widths, takes its place when Wine Tahoma is left out (see
// src/assets/fonts). Tahoma itself comes last, for builds without either.
//
// Text is drawn and measured without kerning or ligatures, as NORMA (GDI+)
// draws it; index.css turns them off for SVG text and measureDiagramText for
// the canvas it measures with.

export const DIAGRAM_FONT = "'Wine Tahoma', 'FreeFBM DejaVu Sans', Tahoma, sans-serif"

let ctx = null
// The width of text in the diagram font, in px. Outside a browser (scripts),
// an estimate from Tahoma's average width.
export function measureDiagramText(text, size, weight = 400) {
  const s = String(text ?? '')
  if (typeof document === 'undefined') return s.length * size * (weight >= 600 ? 0.6 : 0.52)
  if (!ctx) {
    ctx = document.createElement('canvas').getContext('2d')
    if ('fontKerning' in ctx) ctx.fontKerning = 'none'
    if ('textRendering' in ctx) ctx.textRendering = 'optimizeSpeed'   // no ligatures
  }
  ctx.font = `${weight} ${size}px ${DIAGRAM_FONT}`
  return ctx.measureText(s).width
}

// Resolves when the diagram fonts are loaded (or after `ms`, whichever comes
// first), so that text measured for shape sizes is measured in them.
export function diagramFontsReady(ms = 3000) {
  if (typeof document === 'undefined' || !document.fonts?.load) return Promise.resolve()
  const loads = ['400', '700'].flatMap(w => [
    document.fonts.load(`${w} 12px 'Wine Tahoma'`),
    document.fonts.load(`${w} 12px 'FreeFBM DejaVu Sans'`),
  ].map(p => p.catch(() => null)))
  return Promise.race([Promise.all(loads), new Promise(r => setTimeout(r, ms))])
}
