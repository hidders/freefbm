// Where the line from the shape's centre (cx, cy) towards (tx, ty) leaves its
// box. The box need not be centred there: an objectified fact type's frame
// reaches further on the side of its bars and reading than on the other.
export function rectBorderPoint(b, tx, ty) {
  const cx = b.cx ?? (b.left + b.right) / 2, cy = b.cy ?? (b.top + b.bottom) / 2
  const dx = tx - cx, dy = ty - cy
  if (dx === 0 && dy === 0) return { x: cx, y: cy }
  const tx_ = dx > 0 ? (b.right - cx) / dx : dx < 0 ? (b.left - cx) / dx : Infinity
  const ty_ = dy > 0 ? (b.bottom - cy) / dy : dy < 0 ? (b.top - cy) / dy : Infinity
  const t = Math.max(0, Math.min(tx_, ty_))
  return { x: cx + dx * t, y: cy + dy * t }
}
