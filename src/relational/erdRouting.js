// Layout and line routing for the ERD view (ErdView.jsx).
//
// layeredLayout(boxes, edges, originY) places boxes ({id, w, h}) in columns by
//   foreign key depth: tables that reference nothing on the left, each table to
//   the right of the tables it references, ordered in its column by where those
//   tables are. A column that gets too tall continues in a next column.
//
// routeLines(boxes, ends, opts) draws each foreign key as a line of horizontal
//   and vertical segments that keeps clear of the boxes: a shortest path, with a
//   cost per bend and per stretch shared with a line routed before, over a grid
//   of lanes beside the boxes. Each line leaves and enters a box sideways at a
//   column's row, so the crow's foot markers sit on a straight stretch.

export const LANE = 14          // clearance kept between lines and boxes
export const LEAD = 2 * LANE    // straight stretch at both ends of a line
const BEND_COST = 30
const SHARED_COST = 1.5         // extra cost per unit along a stretch already used
// The search overestimates the remaining length by this factor: much faster on
// large schemas, at the price of lines that are sometimes a little longer.
const GREED = 1.6

const COL_GAP = 120, ROW_GAP = 48

// ── layout ──────────────────────────────────────────────────────────────────

// boxes: Map(id → {w, h}); edges: [[fromId, toId]] (from references to).
// Sets x, y on the boxes listed in ids.
export function layeredLayout(boxes, ids, edges, originY = 0) {
  const idSet = new Set(ids)
  const out = new Map(ids.map(id => [id, new Set()]))
  const inc = new Map(ids.map(id => [id, new Set()]))
  for (const [a, b] of edges) {
    if (a === b || !idSet.has(a) || !idSet.has(b)) continue
    out.get(a).add(b)
    inc.get(b).add(a)
  }
  // Depth: 0 for a table that references nothing, else one more than the
  // deepest table it references (edges closing a cycle are ignored).
  const depth = new Map()
  const onStack = new Set()
  const visit = (id) => {
    if (depth.has(id)) return depth.get(id)
    onStack.add(id)
    let d = 0
    for (const b of out.get(id)) if (!onStack.has(b)) d = Math.max(d, visit(b) + 1)
    onStack.delete(id)
    depth.set(id, d)
    return d
  }
  ids.forEach(visit)
  const isolated = ids.filter(id => !out.get(id).size && !inc.get(id).size)
  const layers = []
  for (const id of ids) {
    if (isolated.includes(id)) continue
    ;(layers[depth.get(id)] ??= []).push(id)
  }
  if (isolated.length) layers.push(isolated)

  const totalArea = ids.reduce((s, id) => s + (boxes.get(id).w + COL_GAP) * (boxes.get(id).h + ROW_GAP), 0)
  const maxH = Math.max(700, Math.sqrt(totalArea) * 0.9)
  const centreY = new Map()
  let x = 0
  for (const layer of layers.filter(Boolean)) {
    // Order by the mean height of the tables a table is joined to that are
    // already placed; tables with none keep their order, after the others.
    const key = (id) => {
      const ys = [...out.get(id), ...inc.get(id)].filter(n => centreY.has(n)).map(n => centreY.get(n))
      return ys.length ? ys.reduce((a, b) => a + b, 0) / ys.length : Infinity
    }
    const sorted = layer.map((id, i) => ({ id, k: key(id), i })).sort((a, b) => a.k - b.k || a.i - b.i)
    let y = originY, colW = 0
    for (const { id } of sorted) {
      const b = boxes.get(id)
      if (y > originY && y + b.h > originY + maxH) { x += colW + COL_GAP; y = originY; colW = 0 }
      b.x = x; b.y = y
      centreY.set(id, y + b.h / 2)
      y += b.h + ROW_GAP
      colW = Math.max(colW, b.w)
    }
    x += colW + COL_GAP
  }
}

// ── routing ─────────────────────────────────────────────────────────────────

class Heap {
  constructor() { this.k = []; this.v = [] }
  get size() { return this.k.length }
  push(key, val) {
    const k = this.k, v = this.v
    let i = k.length
    k.push(key); v.push(val)
    while (i > 0) {
      const p = (i - 1) >> 1
      if (k[p] <= key) break
      k[i] = k[p]; v[i] = v[p]; i = p
    }
    k[i] = key; v[i] = val
  }
  pop() {
    const k = this.k, v = this.v
    const top = v[0]
    const lk = k.pop(), lv = v.pop()
    if (k.length) {
      let i = 0
      const n = k.length
      for (;;) {
        let c = 2 * i + 1
        if (c >= n) break
        if (c + 1 < n && k[c + 1] < k[c]) c++
        if (k[c] >= lk) break
        k[i] = k[c]; v[i] = v[c]; i = c
      }
      k[i] = lk; v[i] = lv
    }
    return top
  }
}

const uniqSorted = (arr) => [...new Set(arr.map(n => Math.round(n * 2) / 2))].sort((a, b) => a - b)

// First index with arr[i] > v (strictly), and last index with arr[i] < v.
function above(arr, v) { let lo = 0, hi = arr.length; while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m] <= v) lo = m + 1; else hi = m } return lo }
function below(arr, v) { let lo = 0, hi = arr.length; while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m] < v) lo = m + 1; else hi = m } return lo - 1 }

// boxes: Map(id → {x, y, w, h}).
// ends: [{ key, from: {box, y}, to: {box, y} }] where box is an id and y the
//   height of the row the line attaches to.
// Returns Map(key → { points: [[x, y], ...], d1, d2 }) where d1/d2 are +1 when
//   the line leaves the box to the right, -1 to the left.
export function routeLines(boxes, ends) {
  const result = new Map()
  if (!ends.length) return result
  const all = [...boxes.values()]
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  const xsRaw = [], ysRaw = []
  for (const b of all) {
    // Several lanes beside each box, so lines can run side by side.
    for (let k = 1; k <= 4; k++) xsRaw.push(b.x - k * LANE, b.x + b.w + k * LANE)
    for (let k = 1; k <= 3; k++) ysRaw.push(b.y - k * LANE, b.y + b.h + k * LANE)
    xsRaw.push(b.x + b.w / 2)
    ysRaw.push(b.y + b.h / 2)
    minX = Math.min(minX, b.x); minY = Math.min(minY, b.y)
    maxX = Math.max(maxX, b.x + b.w); maxY = Math.max(maxY, b.y + b.h)
  }
  for (const e of ends) ysRaw.push(e.from.y, e.to.y)
  xsRaw.push(minX - 3 * LANE, maxX + 3 * LANE)
  ysRaw.push(minY - 3 * LANE, maxY + 3 * LANE)
  const xs = uniqSorted(xsRaw), ys = uniqSorted(ysRaw)
  const nx = xs.length, ny = ys.length, N = nx * ny

  // Grid points inside a box (with its clearance) are blocked. Each box's
  // centre lines are lanes too, so no step between neighbours jumps a box.
  const blocked = new Uint8Array(N)
  for (const b of all) {
    const i0 = above(xs, b.x - LANE), i1 = below(xs, b.x + b.w + LANE)
    const j0 = above(ys, b.y - LANE), j1 = below(ys, b.y + b.h + LANE)
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) blocked[j * nx + i] = 1
  }
  const ix = new Map(xs.map((v, i) => [v, i])), iy = new Map(ys.map((v, i) => [v, i]))
  const node = (x, y) => {
    const i = ix.get(Math.round(x * 2) / 2), j = iy.get(Math.round(y * 2) / 2)
    return i == null || j == null ? -1 : j * nx + i
  }
  // How many lines already use the step between two neighbouring nodes.
  const used = new Map()
  const stepKey = (n, m) => Math.min(n, m) * 2 + (Math.abs(n - m) === 1 ? 0 : 1)
  // Directions: 0 +x, 1 −x, 2 +y, 3 −y.
  const DX = [1, -1, 0, 0], DY = [0, 0, 1, -1]

  const dist = new Float64Array(N * 4).fill(Infinity)
  const prev = new Int32Array(N * 4)
  let touched = []

  for (const e of ends) {
    const a = boxes.get(e.from.box), b = boxes.get(e.to.box)
    if (!a || !b) continue
    // Ports: the lead point beside each side of the box, at the row's height.
    const ports = (box, y) => [
      { side: 1, n: node(box.x + box.w + LEAD, y), x: box.x + box.w, lx: box.x + box.w + LEAD },
      { side: -1, n: node(box.x - LEAD, y), x: box.x, lx: box.x - LEAD },
    ].filter(p => p.n >= 0 && !blocked[p.n])
    const starts = ports(a, e.from.y), goals = ports(b, e.to.y)
    if (!starts.length || !goals.length) { result.set(e.key, fallback(a, e.from.y, b, e.to.y)); continue }

    for (const s of touched) dist[s] = Infinity
    touched = []
    const heap = new Heap()
    const goalSet = new Map(goals.map(g => [g.n, g]))
    const gx = goals.map(g => g.n % nx), gy = goals.map(g => (g.n / nx) | 0)
    const h = (n) => {
      const i = n % nx, j = (n / nx) | 0
      let best = Infinity
      for (let k = 0; k < gx.length; k++) best = Math.min(best, Math.abs(xs[i] - xs[gx[k]]) + Math.abs(ys[j] - ys[gy[k]]))
      return best * GREED
    }
    for (const s of starts) {
      const st = s.n * 4 + (s.side === 1 ? 0 : 1)
      dist[st] = 0; prev[st] = -1; touched.push(st)
      heap.push(h(s.n), st)
    }
    let found = -1, best = Infinity
    while (heap.size && heap.k[0] < best) {
      const st = heap.pop()
      const n = st >> 2, d = st & 3
      const g = goalSet.get(n)
      if (g) {
        // The last stretch runs into the box: arriving the other way would be
        // a U-turn, arriving vertically is one more bend.
        const inward = g.side === 1 ? 1 : 0
        if (d !== 1 - inward) {
          const total = dist[st] + (d === inward ? 0 : BEND_COST)
          if (total < best) { best = total; found = st }
        }
      }
      const base = dist[st]
      const i = n % nx, j = (n / nx) | 0
      for (let nd = 0; nd < 4; nd++) {
        if ((d ^ 1) === nd && (d >> 1) === (nd >> 1)) continue  // no reversing
        const ni = i + DX[nd], nj = j + DY[nd]
        if (ni < 0 || nj < 0 || ni >= nx || nj >= ny) continue
        const m = nj * nx + ni
        if (blocked[m]) continue
        const len = Math.abs(xs[ni] - xs[i]) + Math.abs(ys[nj] - ys[j])
        const share = used.get(stepKey(n, m)) ?? 0
        const cost = base + len + (nd !== d ? BEND_COST : 0) + share * len * SHARED_COST
        const ms = m * 4 + nd
        if (cost < dist[ms]) {
          if (dist[ms] === Infinity) touched.push(ms)
          dist[ms] = cost; prev[ms] = st
          heap.push(cost + h(m), ms)
        }
      }
    }
    if (found < 0) { result.set(e.key, fallback(a, e.from.y, b, e.to.y)); continue }
    // Walk back, marking the steps as used.
    const path = []
    let st = found
    while (st >= 0) {
      const n = st >> 2
      path.push(n)
      const p = prev[st]
      if (p >= 0) {
        const k = stepKey(p >> 2, n)
        used.set(k, (used.get(k) ?? 0) + 1)
      }
      st = p
    }
    path.reverse()
    const s = starts.find(p => p.n === path[0]) ?? starts[0]
    const g = goalSet.get(path[path.length - 1])
    const pts = [[s.x, e.from.y], ...path.map(n => [xs[n % nx], ys[(n / nx) | 0]]), [g.x, e.to.y]]
    result.set(e.key, { points: simplify(pts), d1: s.side, d2: g.side })
  }
  return result
}

// Drops points in the middle of a straight stretch.
function simplify(pts) {
  const out = [pts[0]]
  for (let k = 1; k < pts.length - 1; k++) {
    const [ax, ay] = out[out.length - 1], [bx, by] = pts[k], [cx, cy] = pts[k + 1]
    if ((ax === bx && bx === cx) || (ay === by && by === cy)) continue
    out.push(pts[k])
  }
  out.push(pts[pts.length - 1])
  return out
}

// When no clear path exists (e.g. overlapping boxes): side to side with one
// vertical stretch in the middle.
function fallback(a, y1, b, y2) {
  const right = b.x + b.w / 2 >= a.x + a.w / 2
  const x1 = right ? a.x + a.w : a.x, x2 = right ? b.x : b.x + b.w
  const mx = (x1 + x2) / 2
  return { points: [[x1, y1], [mx, y1], [mx, y2], [x2, y2]], d1: right ? 1 : -1, d2: right ? -1 : 1 }
}
