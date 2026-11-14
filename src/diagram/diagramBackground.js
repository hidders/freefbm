// The diagram's background: 'parchment' (the default) or 'white' (as in
// NORMA). The shapes are drawn in NORMA's colours on both. A setting of the
// user, kept in localStorage, not in the model file; index.css switches the
// background on html[data-diagram-background].

const KEY = 'freefbm.diagramBackground'
export const DIAGRAM_BACKGROUNDS = [
  { id: 'parchment', label: 'Parchment', sub: 'A warm background, easy on the eyes' },
  { id: 'white', label: 'White', sub: 'As in NORMA' },
]

export function readDiagramBackground() {
  try { const v = localStorage.getItem(KEY); if (DIAGRAM_BACKGROUNDS.some(b => b.id === v)) return v } catch { /* no storage */ }
  return 'parchment'
}

export function applyDiagramBackground(bg) {
  if (typeof document === 'undefined') return
  if (bg === 'parchment') delete document.documentElement.dataset.diagramBackground
  else document.documentElement.dataset.diagramBackground = bg
}

export function saveDiagramBackground(bg) {
  try { localStorage.setItem(KEY, bg) } catch { /* no storage */ }
  applyDiagramBackground(bg)
}
