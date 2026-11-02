// Layout and line routing for the ERD view (ErdView.jsx).
//
// layeredLayout(boxes, ids, edges, originY) places boxes ({w, h}) in columns by
//   foreign key depth: tables that reference nothing on the right, each table
//   to the left of the tables it references, ordered in its column by where
//   the tables it is joined to are. A tall column continues in a next column.
//
// assignPorts gives each foreign key its own point on the facing side of both
//   boxes, spread along that side.
// routeLines(boxes, ends) draws each foreign key as a line of horizontal and
//   vertical segments that keeps clear of the boxes: a shortest path, with a
//   cost per bend and per stretch used by (or running right next to) a line
//   routed before, over a grid of lanes beside the boxes. Lines leave and enter
//   a box square to its side, so the crow's foot markers sit on a straight
//   stretch.

export const LANE = 16          // clearance kept between lines and boxes, and lane spacing
export const LEAD = 2 * LANE    // straight stretch at both ends of a line
const BEND_COST = 30
const SHARED_COST = 4           // extra cost per unit along a stretch already used
const NEAR_COST = 0.4           // the same, counted for the lanes right next to a line
// The search overestimates the remaining length by this factor: much faster on
// large schemas, at the price of lines that are sometimes a little longer.
const GREED = 2
const WINDOW = 300             // how far a line may stray beyond its two ends

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
  const byDepth = []
  for (const id of ids) {
    if (isolated.includes(id)) continue
    ;(byDepth[depth.get(id)] ??= []).push(id)
  }
  // Referencing tables left, the tables they reference right of them (as
  // DBeaver does); tables without foreign keys last.
  const layers = byDepth.filter(Boolean).reverse()
  if (isolated.length) layers.push(isolated)

  const totalArea = ids.reduce((s, id) => s + (boxes.get(id).w + COL_GAP) * (boxes.get(id).h + ROW_GAP), 0)
  const maxH = Math.max(700, Math.sqrt(totalArea) * 0.9)
  const centreY = new Map()
  let x = 0
  for (const layer of layers) {
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

// Sides of a box: 'r', 'l', 'b', 't', with their outward direction (as in
// the router: 0 +x, 1 −x, 2 +y, 3 −y) and unit vector.
export const SIDES = {
  r: { dir: 0, dx: 1, dy: 0 }, l: { dir: 1, dx: -1, dy: 0 },
  b: { dir: 2, dx: 0, dy: 1 }, t: { dir: 3, dx: 0, dy: -1 },
}

// One attachment point per line end. links: [{ key, a, b }] (box ids, a the
// referencing table). Each end goes on the side of its box that faces the
// other box; the ends on one side are spread evenly along it, ordered by
// where the other box is, so lines leaving one side don't cross each other.
// top: how much of a box's top to keep free of side ports (its header).
// Returns [{ key, from: {box, side, x, y}, to: {box, side, x, y} }].
export function assignPorts(boxes, links, top = 0) {
  const cx = (b) => b.x + b.w / 2, cy = (b) => b.y + b.h / 2
  const sides = []   // [{ link, end: 'from'|'to', box, side, other }]
  for (const l of links) {
    const a = boxes.get(l.a), b = boxes.get(l.b)
    if (!a || !b) continue
    let sa, sb
    if (a === b) { sa = 'r'; sb = 'r' }
    else if (b.x >= a.x + a.w + 2 * LEAD) { sa = 'r'; sb = 'l' }
    else if (a.x >= b.x + b.w + 2 * LEAD) { sa = 'l'; sb = 'r' }
    else if (b.y >= a.y + a.h + 2 * LEAD) { sa = 'b'; sb = 't' }
    else if (a.y >= b.y + b.h + 2 * LEAD) { sa = 't'; sb = 'b' }
    else { sa = 'r'; sb = 'r' }
    sides.push({ link: l, end: 'from', box: a, id: l.a, side: sa, other: b })
    sides.push({ link: l, end: 'to', box: b, id: l.b, side: sb, other: a })
  }
  const groups = new Map()
  for (const e of sides) {
    const k = e.id + '|' + e.side
    if (!groups.has(k)) groups.set(k, [])
    groups.get(k).push(e)
  }
  const out = new Map(links.map(l => [l.key, { key: l.key }]))
  for (const list of groups.values()) {
    const { box, side } = list[0]
    const vertical = side === 'l' || side === 'r'
    // Order along the side by the other box's position; a self-reference's
    // two ends sit next to each other.
    list.sort((p, q) => (vertical ? cy(p.other) - cy(q.other) : cx(p.other) - cx(q.other))
      || (p.end === 'from' ? -1 : 1))
    const lo = vertical ? box.y + top : box.x, len = vertical ? box.h - top : box.w
    const step = Math.min(len / (list.length + 1), 3 * LANE)
    const start = lo + (len - step * (list.length - 1)) / 2
    list.forEach((e, i) => {
      const t = Math.round(start + i * step)
      const x = side === 'r' ? box.x + box.w : side === 'l' ? box.x : t
      const y = side === 'b' ? box.y + box.h : side === 't' ? box.y : t
      out.get(e.link.key)[e.end] = { box: e.id, side, x, y }
    })
  }
  return [...out.values()].filter(e => e.from && e.to)
}

// boxes: Map(id → {x, y, w, h}); ends from assignPorts.
// Returns Map(key → { points: [[x, y], ...], s1, s2 }) with the sides the line
//   leaves and enters by.
export function routeLines(boxes, ends) {
  const result = new Map()
  if (!ends.length) return result
  const all = [...boxes.values()]
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  const xsRaw = [], ysRaw = []
  for (const b of all) {
    // Several lanes beside each box, so lines can run side by side.
    for (let k = 1; k <= 4; k++) xsRaw.push(b.x - k * LANE, b.x + b.w + k * LANE)
    for (let k = 1; k <= 4; k++) ysRaw.push(b.y - k * LANE, b.y + b.h + k * LANE)
    xsRaw.push(b.x + b.w / 2)
    ysRaw.push(b.y + b.h / 2)
    minX = Math.min(minX, b.x); minY = Math.min(minY, b.y)
    maxX = Math.max(maxX, b.x + b.w); maxY = Math.max(maxY, b.y + b.h)
  }
  const lead = (p) => [p.x + SIDES[p.side].dx * LEAD, p.y + SIDES[p.side].dy * LEAD]
  for (const e of ends) for (const p of [e.from, e.to]) {
    const [lx, ly] = lead(p)
    xsRaw.push(lx); ysRaw.push(ly)
  }
  xsRaw.push(minX - 5 * LANE, maxX + 5 * LANE)
  ysRaw.push(minY - 5 * LANE, maxY + 5 * LANE)
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
  // How many lines use a step between two neighbouring nodes, and how many
  // run along a lane next to it: both make a line try another lane.
  const used = new Map()
  const stepKey = (n, m) => Math.min(n, m) * 2 + (Math.abs(n - m) === 1 ? 0 : 1)
  const mark = (n, m, w) => { const k = stepKey(n, m); used.set(k, (used.get(k) ?? 0) + w) }
  // Directions: 0 +x, 1 −x, 2 +y, 3 −y.
  const DX = [1, -1, 0, 0], DY = [0, 0, 1, -1]

  const dist = new Float64Array(N * 4).fill(Infinity)
  const prev = new Int32Array(N * 4)
  const closed = new Int32Array(N * 4)   // line number + 1 that expanded a state
  let touched = []
  let line = 0

  for (const e of ends) {
    line++
    const sn = node(...lead(e.from)), gn = node(...lead(e.to))
    if (sn < 0 || gn < 0 || blocked[sn] || blocked[gn]) { result.set(e.key, fallback(e)); continue }
    for (const s of touched) dist[s] = Infinity
    touched = []
    const heap = new Heap()
    const gi = gn % nx, gj = (gn / nx) | 0
    // The search stays within a window around both ends.
    const si = sn % nx, sj = (sn / nx) | 0
    const wx0 = Math.min(xs[si], xs[gi]) - WINDOW, wx1 = Math.max(xs[si], xs[gi]) + WINDOW
    const wy0 = Math.min(ys[sj], ys[gj]) - WINDOW, wy1 = Math.max(ys[sj], ys[gj]) + WINDOW
    const h = (n) => (Math.abs(xs[n % nx] - xs[gi]) + Math.abs(ys[(n / nx) | 0] - ys[gj])) * GREED
    const st0 = sn * 4 + SIDES[e.from.side].dir
    dist[st0] = 0; prev[st0] = -1; touched.push(st0)
    heap.push(h(sn), st0)
    // The last stretch runs into the box: arriving the other way would be a
    // U-turn, arriving across it is one more bend.
    const inward = SIDES[e.to.side].dir ^ 1
    let found = -1, best = Infinity
    while (heap.size && heap.k[0] < best) {
      const st = heap.pop()
      // Each state is expanded once (with an overestimating guide a state
      // could otherwise be reopened many times).
      if (closed[st] === line) continue
      closed[st] = line
      const n = st >> 2, d = st & 3
      if (n === gn && d !== (inward ^ 1)) {
        const total = dist[st] + (d === inward ? 0 : BEND_COST)
        if (total < best) { best = total; found = st }
      }
      const base = dist[st]
      const i = n % nx, j = (n / nx) | 0
      for (let nd = 0; nd < 4; nd++) {
        if ((d ^ 1) === nd) continue  // no reversing
        const ni = i + DX[nd], nj = j + DY[nd]
        if (ni < 0 || nj < 0 || ni >= nx || nj >= ny) continue
        const m = nj * nx + ni
        if (blocked[m] || xs[ni] < wx0 || xs[ni] > wx1 || ys[nj] < wy0 || ys[nj] > wy1) continue
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
    if (found < 0) { result.set(e.key, fallback(e)); continue }
    // Walk back, marking the steps as used and the lanes beside them as near.
    const path = []
    let st = found
    while (st >= 0) {
      const n = st >> 2
      path.push(n)
      const p = prev[st]
      if (p >= 0) {
        const pn = p >> 2
        mark(pn, n, 1)
        const off = Math.abs(n - pn) === 1 ? nx : 1   // the neighbouring lanes
        for (const o of [off, -off]) {
          const a = pn + o, b = n + o
          if (a >= 0 && b >= 0 && a < N && b < N) mark(a, b, NEAR_COST)
        }
      }
      st = p
    }
    path.reverse()
    const pts = [[e.from.x, e.from.y], ...path.map(n => [xs[n % nx], ys[(n / nx) | 0]]), [e.to.x, e.to.y]]
    result.set(e.key, { points: simplify(pts), s1: e.from.side, s2: e.to.side })
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

// When no clear path exists (e.g. overlapping boxes): out of both sides and
// joined by a straight line.
function fallback(e) {
  const a = SIDES[e.from.side], b = SIDES[e.to.side]
  const p1 = [e.from.x + a.dx * LEAD, e.from.y + a.dy * LEAD], p2 = [e.to.x + b.dx * LEAD, e.to.y + b.dy * LEAD]
  return { points: [[e.from.x, e.from.y], p1, p2, [e.to.x, e.to.y]], s1: e.from.side, s2: e.to.side }
}
