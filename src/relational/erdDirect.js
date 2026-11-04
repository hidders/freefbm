// Straight-line routing for the ERD view (ErdView.jsx), the default line style.
//
// The ideas are those of DBeaver's "Shortest paths" router (itself built on
// Eclipse Draw2d's ShortestPathRouter), written afresh here:
//   - a foreign key line leaves its table at the row of its (first) column, and
//     arrives at the referenced table near the row of the referenced column;
//     ends that share a side are spread apart and ordered by where their other
//     end is (assignRowPorts);
//   - each end has a short straight stub square to the box side, so the crow's
//     foot marker sits on a straight stretch;
//   - between the stubs the line is a shortest path around the boxes, bending
//     only at (slightly enlarged) box corners, so it runs diagonally where it
//     can (routeDirect); crossing a line routed before costs extra, and
//     crossing another line's stub (where its crow's foot is) costs a lot;
//   - lines that bend at the same corner are moved apart, in the order that
//     crosses least, so they never touch there (separateCorners).

export const STUB = 36           // straight stretch at both ends of a line
const MARK_LEN = 23              // the part of it the crow's foot marker takes
const MIN_GAP = 48               // gap between boxes needed for lines between facing sides
const CLEAR = 12                 // clearance kept between lines and boxes
const SEP = 18                   // preferred distance between ends on one side
const MIN_SEP = 6                // ... and the least, on a crowded side
const CORNER_SEP = 7             // distance between lines bending at one corner
const CROSS_COST = 60            // cost of crossing a line routed before
const STUB_COST = 400            // cost of crossing another line's stub
const MARK = 3                   // passing this close to a marker
const NEAR_COST = 100            //   costs this much
const TURN_COST = 40             // cost of leaving a stub at a sharp angle
const BACK_COST = 150            // ... and extra when it turns back
const SHARE_COST = 40            // cost of bending at a corner another line bends at

const SIDES = {
  r: { dx: 1, dy: 0 }, l: { dx: -1, dy: 0 },
  b: { dx: 0, dy: 1 }, t: { dx: 0, dy: -1 },
}

// ── one-dimensional spreading ───────────────────────────────────────────────

// Places items in the given order along a line, each as near its wanted
// centre d as it can be (least squares), with `gap` between neighbours; each
// item has a size (0 for points). Within [lo, hi] when they fit, else the gap
// shrinks to `minGap` first. Returns the centres.
export function spread1D(items, gap, lo = -Infinity, hi = Infinity, minGap = gap) {
  const n = items.length
  if (!n) return []
  const total = (g) => items.reduce((s, it) => s + it.size, 0) + g * (n - 1)
  if (hi - lo < total(gap)) gap = Math.max(minGap, (hi - lo - total(0)) / Math.max(1, n - 1))
  // Offset of each item's centre from the first item's start.
  const off = []
  let acc = 0
  for (const it of items) { off.push(acc + it.size / 2); acc += it.size + gap }
  // Pool adjacent blocks that would overlap (each block placed at the mean of
  // what its items want).
  const blocks = []   // { i, j, sum, cnt, start }
  for (let k = 0; k < n; k++) {
    let b = { i: k, j: k, sum: items[k].d - off[k], cnt: 1 }
    b.start = b.sum / b.cnt
    while (blocks.length) {
      const p = blocks[blocks.length - 1]
      // Both blocks measure their start against item 0, so they overlap when
      // the later block's start is before the earlier's.
      if (p.start < b.start) break
      blocks.pop()
      b = { i: p.i, j: b.j, sum: p.sum + b.sum, cnt: p.cnt + b.cnt }
      b.start = b.sum / b.cnt
    }
    blocks.push(b)
  }
  const out = new Array(n)
  for (const b of blocks) for (let k = b.i; k <= b.j; k++) out[k] = b.start + off[k]
  // Into [lo, hi], keeping order and gaps (they fit, unless even minGap
  // doesn't, when the end at hi wins).
  for (let k = 0; k < n; k++) {
    const minC = lo + off[k]
    if (out[k] < minC) out[k] = minC
  }
  for (let k = n - 1; k >= 0; k--) {
    const maxC = hi - (acc - gap - off[k])
    if (out[k] > maxC) out[k] = maxC
  }
  return out
}

// ── attachment points ───────────────────────────────────────────────────────

// links: [{ key, a, b, ya?, yb? }]: a the referencing table, b the referenced
// one, ya/yb the height of the column row (from the box top) a line end should
// be at when it is on a left or right side. top: how much of a box's top to
// keep free (its header).
// Returns [{ key, from: {box, side, x, y}, to: {box, side, x, y} }].
export function assignRowPorts(boxes, links, top = 0) {
  const ends = []
  for (const l of links) {
    const a = boxes.get(l.a), b = boxes.get(l.b)
    if (!a || !b) continue
    let sa, sb
    const hGap = (p, q) => q.x - (p.x + p.w)       // q right of p by this much
    const vGap = (p, q) => q.y - (p.y + p.h)
    // Each end's stub is at most half the gap between the boxes.
    let gap = Infinity
    if (a === b) { sa = 'r'; sb = 'r' }
    else if (hGap(a, b) >= MIN_GAP) { sa = 'r'; sb = 'l'; gap = hGap(a, b) }
    else if (hGap(b, a) >= MIN_GAP) { sa = 'l'; sb = 'r'; gap = hGap(b, a) }
    else if (vGap(a, b) >= MIN_GAP) { sa = 'b'; sb = 't'; gap = vGap(a, b) }
    else if (vGap(b, a) >= MIN_GAP) { sa = 't'; sb = 'b'; gap = vGap(b, a) }
    else {
      // Close together: both ends on the right, or both on the left when
      // that is the side with more room.
      sa = sb = (a.x + a.w / 2 + b.x + b.w / 2) / 2 < (Math.min(a.x, b.x) + Math.max(a.x + a.w, b.x + b.w)) / 2 ? 'l' : 'r'
    }
    const stub = Math.max(MIN_GAP / 2 - 2, Math.min(STUB, gap / 2 - 2))
    ends.push({ link: l, end: 'from', id: l.a, box: a, side: sa, row: l.ya, other: b, otherRow: l.yb, stub })
    ends.push({ link: l, end: 'to', id: l.b, box: b, side: sb, row: l.yb, other: a, otherRow: l.ya, stub })
  }
  const groups = new Map()
  for (const e of ends) {
    const k = e.id + '|' + e.side
    if (!groups.has(k)) groups.set(k, [])
    groups.get(k).push(e)
  }
  const out = new Map(links.map(l => [l.key, { key: l.key }]))
  for (const list of groups.values()) {
    const { box, side } = list[0]
    const vertical = side === 'l' || side === 'r'
    // Where the other end is, roughly: its row (or its box's middle) on the
    // side of its box nearest this one.
    const otherAt = (e) => {
      const o = e.other
      const oy = e.otherRow != null && o !== box ? o.y + e.otherRow : o.y + o.h / 2
      const ox = o.x + o.w < box.x ? o.x + o.w : o.x > box.x + box.w ? o.x : o.x + o.w / 2
      return [ox, oy]
    }
    for (const e of list) {
      const [ox, oy] = otherAt(e)
      e.want = vertical
        ? (e.row != null ? box.y + e.row : box.y + top + (box.h - top) / 2)
        : Math.min(box.x + box.w - 8, Math.max(box.x + 8, ox))
      // Ends wanting the same place are ordered by the direction of their
      // other end as seen from there, so lines leaving one side don't cross:
      // the slope of the line to it across the side.
      e.at = vertical
        ? (e.other === box ? 0 : (oy - e.want) / Math.max(20, Math.abs(ox - (side === 'r' ? box.x + box.w : box.x))))
        : (ox - (box.x + box.w / 2)) / Math.max(20, Math.abs(oy - (side === 'b' ? box.y + box.h : box.y)))
    }
    // A self-reference's two ends sit next to each other.
    list.sort((p, q) => (p.want - q.want) || (p.at - q.at) || (p.end === 'from' ? -1 : 1))
    const lo = vertical ? box.y + top + 3 : box.x + 6, hi = vertical ? box.y + box.h - 3 : box.x + box.w - 6
    const pos = spread1D(list.map(e => ({ d: e.want, size: 0 })), SEP, lo, hi, MIN_SEP)
    list.forEach((e, i) => {
      const t = Math.round(pos[i] * 2) / 2
      const x = side === 'r' ? box.x + box.w : side === 'l' ? box.x : t
      const y = side === 'b' ? box.y + box.h : side === 't' ? box.y : t
      out.get(e.link.key)[e.end] = { box: e.id, side, x, y, stub: e.stub }
    })
  }
  return [...out.values()].filter(e => e.from && e.to)
}

// ── geometry ────────────────────────────────────────────────────────────────

// Whether segment p–q passes through the open inside of rectangle r.
function cutsRect(px, py, qx, qy, r) {
  const x0 = r.x + 0.01, x1 = r.x + r.w - 0.01, y0 = r.y + 0.01, y1 = r.y + r.h - 0.01
  if (Math.max(px, qx) <= x0 || Math.min(px, qx) >= x1 || Math.max(py, qy) <= y0 || Math.min(py, qy) >= y1) return false
  // Liang–Barsky clipping.
  let t0 = 0, t1 = 1
  const dx = qx - px, dy = qy - py
  const clip = (p, q) => {
    if (p === 0) return q > 0
    const t = q / p
    if (p < 0) { if (t > t1) return false; if (t > t0) t0 = t }
    else { if (t < t0) return false; if (t < t1) t1 = t }
    return true
  }
  if (!clip(-dx, px - x0) || !clip(dx, x1 - px) || !clip(-dy, py - y0) || !clip(dy, y1 - py)) return false
  return t1 - t0 > 1e-6
}

const inside = (x, y, r) => x > r.x + 0.01 && x < r.x + r.w - 0.01 && y > r.y + 0.01 && y < r.y + r.h - 0.01

// Whether segments a–b and c–d cross (touching at an end doesn't count).
function crosses(ax, ay, bx, by, cx, cy, dx, dy) {
  const d1 = (dx - cx) * (ay - cy) - (dy - cy) * (ax - cx)
  const d2 = (dx - cx) * (by - cy) - (dy - cy) * (bx - cx)
  const d3 = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax)
  const d4 = (bx - ax) * (dy - ay) - (by - ay) * (dx - ax)
  return ((d1 > 1e-9 && d2 < -1e-9) || (d1 < -1e-9 && d2 > 1e-9)) && ((d3 > 1e-9 && d4 < -1e-9) || (d3 < -1e-9 && d4 > 1e-9))
}

// Distance from point p to segment a–b, and between two segments that don't
// cross.
function pointSeg(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay, l = dx * dx + dy * dy
  const t = l ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l)) : 0
  return Math.hypot(px - ax - t * dx, py - ay - t * dy)
}
function segDist(ax, ay, bx, by, cx, cy, dx, dy) {
  return Math.min(pointSeg(ax, ay, cx, cy, dx, dy), pointSeg(bx, by, cx, cy, dx, dy),
    pointSeg(cx, cy, ax, ay, bx, by), pointSeg(dx, dy, ax, ay, bx, by))
}

// Segments kept in a coarse grid of buckets, for counting crossings quickly.
class SegIndex {
  constructor(cell = 160) { this.cell = cell; this.map = new Map(); this.n = 0 }
  _keys(ax, ay, bx, by, f) {
    const c = this.cell
    const i0 = Math.floor(Math.min(ax, bx) / c), i1 = Math.floor(Math.max(ax, bx) / c)
    const j0 = Math.floor(Math.min(ay, by) / c), j1 = Math.floor(Math.max(ay, by) / c)
    for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) f(i + ',' + j)
  }
  add(seg) {
    seg.id = this.n++
    this._keys(seg[0], seg[1], seg[2], seg[3], k => { if (!this.map.has(k)) this.map.set(k, []); this.map.get(k).push(seg) })
  }
  // Total weight of the segments a–b crosses (each counted once), leaving out
  // those of line `own`; stubs on the sides in `near` (where the line's own
  // ends are) count only when crossed.
  cost(ax, ay, bx, by, own, near) {
    let sum = 0
    const seen = new Set()
    this._keys(ax, ay, bx, by, k => {
      const list = this.map.get(k)
      if (!list) return
      for (const s of list) {
        if (s.line === own || seen.has(s.id)) continue
        seen.add(s.id)
        const f = s.fat && !near?.has(s.side) ? s.fat : 0
        if (Math.max(ax, bx) < Math.min(s[0], s[2]) - f || Math.min(ax, bx) > Math.max(s[0], s[2]) + f
          || Math.max(ay, by) < Math.min(s[1], s[3]) - f || Math.min(ay, by) > Math.max(s[1], s[3]) + f) continue
        if (crosses(ax, ay, bx, by, s[0], s[1], s[2], s[3])) sum += s.w
        else if (f && segDist(ax, ay, bx, by, s[0], s[1], s[2], s[3]) < f) sum += NEAR_COST
      }
    })
    return sum
  }
}

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

// ── routing ─────────────────────────────────────────────────────────────────

// boxes: Map(id → {x, y, w, h}); ends from assignRowPorts. `context`, when
// given, is the full list of ends: their stubs are avoided too (used while
// dragging, when only some lines are routed again), and `fixed` maps keys of
// lines not routed again to their routes, whose segments count as crossings.
// Returns Map(key → { points: [[x, y], ...], s1, s2 }).
export function routeDirect(boxes, ends, { context = ends, fixed = null } = {}) {
  const result = new Map()
  if (!ends.length) return result
  const rects = [...boxes.values()].map(b => ({ x: b.x - CLEAR, y: b.y - CLEAR, w: b.w + 2 * CLEAR, h: b.h + 2 * CLEAR }))
  // Corners of the enlarged boxes that are not inside another one; u is the
  // outward direction (lines bending there are moved apart along it).
  const nodes = []
  rects.forEach((r, ri) => {
    for (const [sx, sy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
      const x = r.x + sx * r.w, y = r.y + sy * r.h
      if (rects.some((o, oi) => oi !== ri && inside(x, y, o))) continue
      nodes.push({ x, y, ux: sx ? Math.SQRT1_2 : -Math.SQRT1_2, uy: sy ? Math.SQRT1_2 : -Math.SQRT1_2 })
    }
  })
  const visible = (ax, ay, bx, by, skip) => {
    for (let i = 0; i < rects.length; i++) if (!skip?.has(i) && cutsRect(ax, ay, bx, by, rects[i])) return false
    return true
  }
  // Which corners see each other (the same for every line).
  const V = nodes.length
  const adj = Array.from({ length: V }, () => [])
  for (let i = 0; i < V; i++) for (let j = i + 1; j < V; j++) {
    const a = nodes[i], b = nodes[j]
    if (visible(a.x, a.y, b.x, b.y)) {
      const d = Math.hypot(a.x - b.x, a.y - b.y)
      adj[i].push(j, d); adj[j].push(i, d)
    }
  }

  const stubEnd = (p) => [p.x + SIDES[p.side].dx * (p.stub ?? STUB), p.y + SIDES[p.side].dy * (p.stub ?? STUB)]
  const index = new SegIndex()
  // Every line's stubs: crossing the part where its crow's foot is costs
  // STUB_COST, passing within MARK of it NEAR_COST; the rest of it is like
  // any other line.
  for (const e of context) for (const p of [e.from, e.to]) {
    const [sx, sy] = stubEnd(p)
    const { dx, dy } = SIDES[p.side]
    const ml = Math.min(MARK_LEN, p.stub ?? STUB)
    const mx = p.x + dx * ml, my = p.y + dy * ml
    const seg = [p.x, p.y, mx, my]; seg.line = e.key; seg.w = STUB_COST; seg.fat = MARK; seg.side = p.box + '|' + p.side
    index.add(seg)
    if (ml < (p.stub ?? STUB)) {
      const rest = [mx, my, sx, sy]; rest.line = e.key; rest.w = CROSS_COST
      index.add(rest)
    }
  }
  const addLine = (key, pts) => {
    for (let k = 1; k < pts.length - 2; k++) {
      const seg = [pts[k][0], pts[k][1], pts[k + 1][0], pts[k + 1][1]]; seg.line = key; seg.w = CROSS_COST
      index.add(seg)
    }
  }
  if (fixed) for (const [key, r] of fixed) addLine(key, r.points)

  // Shorter lines first: the long ones then go round them.
  const order = [...ends].sort((p, q) =>
    Math.hypot(p.from.x - p.to.x, p.from.y - p.to.y) - Math.hypot(q.from.x - q.to.x, q.from.y - q.to.y))
  // How many lines bend at each corner so far.
  const used = new Float64Array(V)
  if (fixed) for (const r of fixed.values()) for (const [x, y] of r.points) {
    const n = nodes.findIndex(c => Math.abs(c.x - x) < 0.5 && Math.abs(c.y - y) < 0.5)
    if (n >= 0) used[n]++
  }
  const routed = []
  for (const e of order) {
    const [sx, sy] = stubEnd(e.from), [gx, gy] = stubEnd(e.to)
    // Enlarged boxes the stub ends are in (boxes close together) don't block
    // the first and last stretch.
    const skipS = new Set(), skipG = new Set()
    rects.forEach((r, i) => { if (inside(sx, sy, r)) skipS.add(i); if (inside(gx, gy, r)) skipG.add(i) })
    const skipBoth = new Set([...skipS, ...skipG])
    const f = SIDES[e.from.side], t = SIDES[e.to.side]
    const near = new Set([e.from.box + '|' + e.from.side, e.to.box + '|' + e.to.side])
    // Leaving a stub (or arriving at one) at a sharp angle costs extra.
    const turn = (dx, dy, ux, uy) => {
      const len = Math.hypot(dx, dy)
      if (!len) return 0
      const cos = (dx * ux + dy * uy) / len
      return TURN_COST * (1 - cos) / 2 + (cos < 0 ? BACK_COST : 0)
    }
    const S = V, G = V + 1
    const px = (n) => n === S ? sx : n === G ? gx : nodes[n].x
    const py = (n) => n === S ? sy : n === G ? gy : nodes[n].y
    const dist = new Float64Array(V + 2).fill(Infinity)
    const prev = new Int32Array(V + 2).fill(-1)
    const done = new Uint8Array(V + 2)
    const h = (n) => Math.hypot(px(n) - gx, py(n) - gy)
    const heap = new Heap()
    dist[S] = 0
    heap.push(h(S), S)
    const toGoal = new Map()
    const seesGoal = (n) => {
      if (!toGoal.has(n)) toGoal.set(n, visible(px(n), py(n), gx, gy, n === S ? skipBoth : skipG))
      return toGoal.get(n)
    }
    const relax = (n, m, len, extra) => {
      const c = dist[n] + len + extra + index.cost(px(n), py(n), px(m), py(m), e.key, near) + (m < V ? used[m] * SHARE_COST : 0)
      if (c < dist[m]) { dist[m] = c; prev[m] = n; heap.push(c + h(m), m) }
    }
    while (heap.size) {
      const n = heap.pop()
      if (done[n]) continue
      done[n] = 1
      if (n === G) break
      const x = px(n), y = py(n)
      if (seesGoal(n)) {
        const extra = turn(gx - x, gy - y, -t.dx, -t.dy) + (n === S ? turn(gx - x, gy - y, f.dx, f.dy) : 0)
        relax(n, G, Math.hypot(gx - x, gy - y), extra)
      }
      if (n === S) {
        for (let m = 0; m < V; m++) {
          const c = nodes[m]
          if (!visible(sx, sy, c.x, c.y, skipS)) continue
          relax(S, m, Math.hypot(c.x - sx, c.y - sy), turn(c.x - sx, c.y - sy, f.dx, f.dy))
        }
      } else {
        const list = adj[n]
        for (let k = 0; k < list.length; k += 2) if (!done[list[k]]) relax(n, list[k], list[k + 1], 0)
      }
    }
    let pts
    if (dist[G] === Infinity) {
      pts = [[e.from.x, e.from.y], [sx, sy], [gx, gy], [e.to.x, e.to.y]]
    } else {
      const path = []
      for (let n = G; n >= 0; n = prev[n]) path.push(n)
      path.reverse()
      pts = [[e.from.x, e.from.y], ...path.map(n => [px(n), py(n)]), [e.to.x, e.to.y]]
    }
    const r = { key: e.key, points: pts, corners: [], s1: e.from.side, s2: e.to.side }
    // Corners the line bends at (by node), for moving lines apart.
    if (dist[G] !== Infinity) {
      const path = []
      for (let n = G; n >= 0; n = prev[n]) path.push(n)
      path.reverse()
      path.forEach((n, i) => { if (n < V) { r.corners.push({ node: n, at: i + 1 }); used[n]++ } })
    }
    addLine(e.key, pts)
    routed.push(r)
  }
  separateCorners(routed, nodes)
  for (const r of routed) result.set(r.key, { points: dropStraight(r.points), s1: r.s1, s2: r.s2 })
  return result
}

// Lines bending at one corner are moved out along its diagonal, one
// CORNER_SEP further each, in the order that makes the fewest of their
// stretches next to the corner cross.
function separateCorners(routed, nodes) {
  const at = new Map()   // node → [{ r, at }]
  for (const r of routed) for (const c of r.corners) {
    if (!at.has(c.node)) at.set(c.node, [])
    at.get(c.node).push({ r, at: c.at })
  }
  for (const [n, list] of at) {
    if (list.length < 2) continue
    const node = nodes[n]
    const ux = node.ux, uy = node.uy
    const place = (perm) => perm.map((u, k) => [node.x + ux * CORNER_SEP * k, node.y + uy * CORNER_SEP * k])
    const crossings = (perm) => {
      const p = place(perm)
      const segs = []
      perm.forEach((u, k) => {
        const pts = u.r.points
        const a = pts[u.at - 1], b = pts[u.at + 1]
        segs.push([a[0], a[1], p[k][0], p[k][1]], [p[k][0], p[k][1], b[0], b[1]])
      })
      let c = 0
      for (let i = 0; i < segs.length; i++) for (let j = i + 1; j < segs.length; j++) {
        if ((i >> 1) === (j >> 1)) continue
        const s = segs[i], t = segs[j]
        if (crosses(s[0], s[1], s[2], s[3], t[0], t[1], t[2], t[3])) c++
      }
      return c
    }
    let best = list
    if (list.length <= 6) {
      let bestC = Infinity
      const permute = (arr, k) => {
        if (k === arr.length) {
          const c = crossings(arr)
          if (c < bestC) { bestC = c; best = [...arr] }
          return
        }
        for (let i = k; i < arr.length; i++) {
          [arr[k], arr[i]] = [arr[i], arr[k]]
          permute(arr, k + 1)
          ;[arr[k], arr[i]] = [arr[i], arr[k]]
          if (bestC === 0) return
        }
      }
      permute([...list], 0)
    } else {
      // Many lines: by the direction they bend towards.
      const ang = (u) => {
        const pts = u.r.points, a = pts[u.at - 1], b = pts[u.at + 1]
        const vx = a[0] + b[0] - 2 * node.x, vy = a[1] + b[1] - 2 * node.y
        return Math.atan2(vy * ux - vx * uy, vx * ux + vy * uy)
      }
      best = [...list].sort((p, q) => ang(p) - ang(q))
    }
    const p = place(best)
    best.forEach((u, k) => { u.r.points[u.at] = p[k] })
  }
}

// Drops points in the middle of a straight stretch.
function dropStraight(pts) {
  const out = [pts[0]]
  for (let k = 1; k < pts.length - 1; k++) {
    const [ax, ay] = out[out.length - 1], [bx, by] = pts[k], [cx, cy] = pts[k + 1]
    const cross = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax)
    if (Math.abs(cross) < 0.5 && (bx - ax) * (cx - bx) + (by - ay) * (cy - by) >= 0) continue
    out.push(pts[k])
  }
  out.push(pts[pts.length - 1])
  return out
}
