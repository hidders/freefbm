// Draggable divider between two panels. Drawn as a narrow strip with a
// centred row of grip dots so it reads as draggable before it is hovered;
// it turns accent-coloured on hover and while `dragging`.
export default function Splitter({ orientation, dragging, onMouseDown }) {
  return (
    <div
      className={`splitter splitter-${orientation}${dragging ? ' dragging' : ''}`}
      onMouseDown={onMouseDown}
      title="Drag to resize"
      role="separator"
      aria-orientation={orientation === 'v' ? 'vertical' : 'horizontal'}
    />
  )
}
