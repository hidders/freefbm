// Buttons shared by the population editors (fact types in BottomPanel.jsx,
// table records in RecordGrid.jsx).

// Delete-button styling — matches the Inspector's red-on-pink "×" buttons.
export const removeBtnStyle = {
  flex: '0 0 auto', width: 22, height: 22, padding: 0,
  fontSize: 11, lineHeight: '20px',
  background: 'var(--bg-raised)', color: 'var(--danger)',
  border: '1px solid #e0b0a8', borderRadius: 3, cursor: 'pointer', flexShrink: 0,
}
export const removeBtnHandlers = {
  onMouseEnter: e => {
    e.currentTarget.style.background = 'var(--danger)'
    e.currentTarget.style.color = '#fff'
    e.currentTarget.style.borderColor = 'var(--danger)'
  },
  onMouseLeave: e => {
    e.currentTarget.style.background = 'var(--bg-raised)'
    e.currentTarget.style.color = 'var(--danger)'
    e.currentTarget.style.borderColor = '#e0b0a8'
  },
}
export const addBtnStyle = {
  fontSize: 11, padding: '4px 10px',
  background: 'var(--bg-raised)', color: 'var(--ink-2)',
  border: '1px solid var(--border-soft)', borderRadius: 3, cursor: 'pointer',
}
// A population cell with an issue (yellow, as in fact type populations).
export const issueCellStyle = { borderColor: '#f5b400', boxShadow: 'inset 0 0 0 1px #f5b400', background: '#fff8e0' }
