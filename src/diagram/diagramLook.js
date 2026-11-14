// How diagrams look: 'norma' (NORMA's colours, the default) or 'parchment'
// (FreeFBM's older colours). A setting of the user, kept in localStorage, not
// in the model file. index.css switches the colours on html[data-diagram-look].

const KEY = 'freefbm.diagramLook'
export const DIAGRAM_LOOKS = [
  { id: 'norma', label: 'NORMA', sub: 'White, dark blue object types, purple constraints, as NORMA draws them' },
  { id: 'parchment', label: 'Parchment', sub: 'FreeFBM\'s warm colours on a parchment background' },
]

export function readDiagramLook() {
  try { const v = localStorage.getItem(KEY); if (DIAGRAM_LOOKS.some(l => l.id === v)) return v } catch { /* no storage */ }
  return 'norma'
}

export function applyDiagramLook(look) {
  if (typeof document === 'undefined') return
  if (look === 'norma') delete document.documentElement.dataset.diagramLook
  else document.documentElement.dataset.diagramLook = look
}

export function saveDiagramLook(look) {
  try { localStorage.setItem(KEY, look) } catch { /* no storage */ }
  applyDiagramLook(look)
}
