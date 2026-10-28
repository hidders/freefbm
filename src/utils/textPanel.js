// Read-only text panels ([data-text-panel]: Constraints, validation
// messages) behave like a document: Cmd/Ctrl+A selects just the focused
// panel's text and Cmd/Ctrl+C does a native copy.

export const textPanelOf = (el) => el?.closest?.('[data-text-panel]') ?? null

// Handles Cmd/Ctrl+A and Cmd/Ctrl+C inside a focused text panel. Returns true
// when the key was one of these, so the caller leaves it alone.
export function handleTextPanelKey(e) {
  const panel = textPanelOf(document.activeElement)
  if (!panel || !(e.ctrlKey || e.metaKey)) return false
  if (e.key === 'a' || e.key === 'A') {
    e.preventDefault()
    const range = document.createRange()
    range.selectNodeContents(panel)
    const sel = window.getSelection()
    sel.removeAllRanges()
    sel.addRange(range)
    return true
  }
  return e.key === 'c' || e.key === 'C'  // native copy
}

// True while the user has text selected, so a click that ends a drag
// selection does not also act on the clicked message.
export const hasTextSelection = () => (window.getSelection()?.toString() ?? '') !== ''
