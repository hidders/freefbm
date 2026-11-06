// Auto layout of an ORM2 diagram (the Auto layout button right of the
// diagram tabs). It may move everything; users tune the result by hand.
//
// Pipeline (see the Claude doc "Auto-layout for ORM2 diagrams"):
//   1. reduce   reference modes are collapsed (unless a constraint blocks it);
//               attribute fact types (an entity type and a value type that
//               plays nothing else) and unaries become satellites of their
//               entity type, each with its own occurrence of the value type
//   2. core     a graph of blocks (an entity type with its satellites), the
//               other value types and the other fact types as nodes
//   3. place    stress majorization of the core graph (subtypes below their
//               supertypes), then overlap removal and packing of components
//   4. orient   each fact type's orientation and role order (a binary may
//               always be reversed) to shorten its role connectors; the
//               uniqueness bars go on the side without connectors
//   5. constraints  external constraints on the free spot near what they
//               constrain with the shortest connectors that cross the fewest
//               lines and boxes; frequency markers next to their bars
//
// prepareLayout gives the core graph, placeCore positions it (or another
// placement, e.g. ELK in the benchmark), finishLayout builds the diagram.

import { computeOtSize } from '../components/ObjectTypeNode'
import { ROLE_W, ROLE_H, ROLE_GAP, nestedFactBounds, getDisplayReading } from '../components/FactTypeNode'
import { roleAnchor } from '../utils/geometry'
import { findRefMode, refModeCollapseBlockers } from '../utils/refMode'
import { mkOcc } from '../store/storeHelpers'
import { defaultFrequencyPos } from '../utils/frequencyPlacement'
import { formulaElements } from '../logic/formulaConstraint'
import { factBox } from './layoutScore'

const GAP = 56            // between core nodes
const SAT_GAP = 46        // entity box → satellite fact → its value type
const SAT_ROW = 48        // rows of satellites
const SAT_SPLIT = 14     // more satellites than this: a column on each side
const FACT_PAD = 22       // room around a core fact type (bars, reading)
const C_SIZE = 28         // an external constraint's box
const UNARY_READ = 6      // a satellite unary's reading beside it

const factLen = (n) => n * ROLE_W + (n - 1) * ROLE_GAP
// Width of a fact type's reading below it (14px text, about 7px a character, plus
// the reverse-reading arrow).
const readingW = (f) => (getDisplayReading({ ...f, arity: f.roles.length }) || '').length * 7 + 14

// ── 1 + 2: the core graph ────────────────────────────────────────────────────

export function prepareLayout(state, diagramId) {
  const diagram = state.diagrams.find(d => d.id === diagramId)
  if (!diagram) return null
  const otById = new Map(state.objectTypes.map(o => [o.id, o]))
  const factById = new Map(state.facts.map(f => [f.id, f]))
  const occs = diagram.occurrences ?? []
  const shown = new Set(occs.map(o => o.schemaElementId))
  const firstOcc = new Map()
  for (const o of occs) if (!o.refModeOwnerOccId && !firstOcc.has(o.schemaElementId)) firstOcc.set(o.schemaElementId, o)
  for (const o of occs) if (!firstOcc.has(o.schemaElementId)) firstOcc.set(o.schemaElementId, o)

  // Nodes that carry satellites: entity types and objectified fact types.
  const nodeIds = []
  for (const id of shown) {
    const ot = otById.get(id), f = factById.get(id)
    if (ot?.kind === 'entity' || f?.objectified) nodeIds.push(id)
  }
  const isNode = new Set(nodeIds)
  const entityOf = (id) => otById.get(id) ?? factById.get(id)

  // Reference modes: collapsed unless a constraint on the entity's own role blocks it.
  const refMode = new Map()        // entity id → { rm, collapsed }
  const collapsedFacts = new Map() // ref-mode fact id → entity id
  for (const id of nodeIds) {
    const ent = entityOf(id)
    if (ent.objectified && ent.objectifiedKind === 'value') continue
    const rm = findRefMode(ent, state.facts, state.objectTypes)
    if (!rm || !otById.has(rm.vtId)) continue
    const collapsed = refModeCollapseBlockers(ent, state.facts, state.objectTypes, state.constraints).length === 0
    refMode.set(id, { rm, collapsed })
    if (collapsed) collapsedFacts.set(rm.factId, id)
  }

  // Fact types to draw: shown, not a collapsed reference mode, all roles' players drawn
  // (a role without a player is fine).
  const facts = []
  for (const id of shown) {
    const f = factById.get(id)
    if (!f || collapsedFacts.has(id)) continue
    // An expanded ref-mode fact belongs to its entity even when it was hidden.
    facts.push(f)
  }
  for (const [id, { rm, collapsed }] of refMode) {
    if (!collapsed && !shown.has(rm.factId)) facts.push(factById.get(rm.factId))
  }
  const players = (f) => f.roles.map(r => r.objectTypeId ?? null)

  // Value types drawn: those shown with an occurrence of their own, and those a drawn fact uses.
  const usedVts = new Set()
  for (const f of facts) for (const p of players(f)) if (otById.get(p)?.kind === 'value') usedVts.add(p)
  const valueIds = new Set()
  for (const id of shown) {
    const ot = otById.get(id)
    if (ot?.kind !== 'value') continue
    const own = occs.some(o => o.schemaElementId === id && !o.refModeOwnerOccId)
    if (own || usedVts.has(id)) valueIds.add(id)
  }
  for (const v of usedVts) valueIds.add(v)

  // Shown subtype links between drawn types.
  const drawnType = (id) => isNode.has(id) || valueIds.has(id)
  const subtypeIds = new Set(diagram.subtypeOccurrences ?? [])
  const subtypes = state.subtypes.filter(st => subtypeIds.has(st.id) && drawnType(st.subId) && drawnType(st.superId))
  const inSubtype = new Set(subtypes.flatMap(st => [st.subId, st.superId]))

  // Satellites: unaries of an entity type, and binaries between an entity type and a
  // value type that plays only in such binaries.
  const vtFacts = new Map()
  for (const f of facts) for (const p of new Set(players(f))) if (valueIds.has(p)) (vtFacts.get(p) ?? vtFacts.set(p, []).get(p)).push(f)
  const isAttr = (f) => !f.objectified && f.roles.length === 2 && (() => {
    const [a, b] = players(f)
    return (isNode.has(a) && valueIds.has(b)) || (valueIds.has(a) && isNode.has(b))
  })()
  const leafVt = (v) => !inSubtype.has(v) && (vtFacts.get(v) ?? []).every(isAttr)
  const sats = new Map(nodeIds.map(id => [id, []]))   // node id → [{ fact, owner index, vt }]
  const satFact = new Set()
  for (const f of facts) {
    if (f.objectified) continue
    const ps = players(f)
    if (f.roles.length === 1 && isNode.has(ps[0])) {
      sats.get(ps[0]).push({ fact: f, ownerRole: 0, vt: null })
      satFact.add(f.id)
    } else if (f.roles.length === 2 && ps[0] === ps[1] && isNode.has(ps[0])) {
      // A ring fact type sits next to its one player.
      sats.get(ps[0]).push({ fact: f, ownerRole: 0, vt: null, ring: true })
      satFact.add(f.id)
    } else if (isAttr(f)) {
      const ownerRole = isNode.has(ps[0]) ? 0 : 1
      const vt = ps[1 - ownerRole]
      if (!leafVt(vt)) continue
      sats.get(ps[ownerRole]).push({ fact: f, ownerRole, vt })
      satFact.add(f.id)
    }
  }
  // A value type all of whose fact types are satellites is drawn once per satellite.
  const satVts = new Set([...valueIds].filter(v => (vtFacts.get(v) ?? []).length > 0 && vtFacts.get(v).every(f => satFact.has(f.id))))

  // Blocks: an entity type (or objectified fact type) with its satellites in rows to
  // the right (and to the left when there are many). Offsets relative to the entity.
  const sizeOf = (id) => {
    const ot = otById.get(id)
    if (ot) { const { w, h } = computeOtSize({ ...ot, occurrenceId: undefined }); return { w, h } }
    const f = factById.get(id)
    const b = nestedFactBounds({ ...f, x: 0, y: 0, orientation: 'horizontal', uniquenessBelow: false, nestedReading: false })
    return { w: b.right - b.left, h: b.bottom - b.top }
  }
  const nodes = []
  const blocks = new Map()
  for (const id of nodeIds) {
    const { w: ew, h: eh } = sizeOf(id)
    const list = sats.get(id)
    const first = list.length > SAT_SPLIT ? list.slice(0, Math.ceil(list.length / 2)) : list
    const second = list.length > SAT_SPLIT ? list.slice(first.length) : []
    // Rows for satellites on the right (side 1); mirrored when they go left (side -1).
    const rows = []
    let minX = -ew / 2, maxX = ew / 2
    // Gaps wide enough for the longest reading under a satellite fact type.
    // (A unary's reading goes beside it, on the far side.)
    const gap = Math.max(SAT_GAP, ...list.filter(s => s.fact.roles.length > 1).map(s => (readingW(s.fact) - factLen(s.fact.roles.length)) / 2 + 12))
    // Taller rows when value ranges add a line of text under a value type or role.
    const ranged = list.some(s => (s.vt && otById.get(s.vt)?.valueRange?.length) || s.fact.roles.some(r => r.valueRange?.length || r.cardinalityRange?.length))
    const rowH = ranged ? SAT_ROW + 14 : SAT_ROW
    const column = (items, side) => {
      const top = -((items.length - 1) * rowH) / 2
      items.forEach((s, i) => {
        const n = s.fact.roles.length
        const fx = side * (ew / 2 + gap + factLen(n) / 2)
        const vw = s.vt ? sizeOf(s.vt).w : 0
        const vx = s.vt ? fx + side * (factLen(n) / 2 + gap + vw / 2) : null
        const y = top + i * rowH
        rows.push({ ...s, side, fx, fy: y, vx, vy: y })
        const far = s.vt ? vx + side * vw / 2 : fx + side * (factLen(n) / 2 + (n === 1 ? UNARY_READ + readingW(s.fact) : 0))
        minX = Math.min(minX, far); maxX = Math.max(maxX, far)
      })
    }
    column(first, 1)
    column(second, -1)
    const span = Math.max(first.length, second.length)
    // Objectified fact types carry a name above their box.
    const h = Math.max(eh + (factById.get(id)?.objectified ? 24 : 0), span * rowH)
    // One column can also hang down (or up) from the entity's level, out of the way
    // of links that leave on its side: rows then shift by `hang`.
    const hang = !second.length && first.length > 1 ? ((first.length - 1) * rowH) / 2 : 0
    const top = Math.max(eh / 2, rowH / 2), bottom = 2 * hang + rowH / 2
    blocks.set(id, { rows, ew, eh, offX: (minX + maxX) / 2, hang })
    nodes.push({ id, kind: 'block', w: maxX - minX, h, offX: (minX + maxX) / 2, er: (ew + eh) / 4, hang, hungH: top + bottom, hungOff: (bottom - top) / 2 })
  }
  for (const v of valueIds) {
    if (satVts.has(v)) continue
    const { w, h } = sizeOf(v)
    nodes.push({ id: v, kind: 'value', w, h, offX: 0, er: (w + h) / 4 })
  }
  const coreFacts = facts.filter(f => !satFact.has(f.id) && !f.objectified)
  for (const f of coreFacts) {
    const s = factLen(f.roles.length) + FACT_PAD * 2
    const w = Math.max(s, readingW(f) + 16)
    nodes.push({ id: `f:${f.id}`, kind: 'fact', factId: f.id, w, h: s, offX: 0, er: (w + s) / 4 })
  }

  // Subtype hierarchies: each tree of subtype links (a subtype with several supertypes
  // hangs under its first) is laid out as a tidy tree, supertypes above, and takes part
  // in the placement as one node.
  const nodeById = new Map(nodes.map(n => [n.id, n]))
  const parent = new Map(), kids = new Map()
  const ancestor = (a, b) => { for (let x = a; x; x = parent.get(x)) if (x === b) return true; return false }
  for (const st of subtypes) {
    const c = st.subId, p = st.superId
    if (!nodeById.has(c) || !nodeById.has(p) || c === p || parent.has(c) || ancestor(p, c)) continue
    parent.set(c, p)
    ;(kids.get(p) ?? kids.set(p, []).get(p)).push(c)
  }
  const groupOf = new Map()       // member id → tree node id
  const trees = []
  for (const [root] of kids) {
    if (parent.has(root)) continue
    const rel = new Map()
    const box = layoutTree(root, kids, nodeById, rel)
    const id = `t:${root}`
    for (const m of rel.keys()) groupOf.set(m, id)
    trees.push({ id, root, rel })
    nodes.push({ id, kind: 'tree', w: box.w, h: box.h, offX: 0, er: Math.min(box.w, box.h) / 2 })
  }
  const memberById = new Map(nodes.map(n => [n.id, n]))
  for (let i = nodes.length - 1; i >= 0; i--) if (groupOf.has(nodes[i].id)) nodes.splice(i, 1)
  const grp = (id) => (id && groupOf.get(id)) || id

  // Edges: a fact type to each of its players; an objectified fact type's roles from
  // its block; subtype links (sub below super).
  const nodeOf = (typeId) => isNode.has(typeId) || (valueIds.has(typeId) && !satVts.has(typeId)) ? grp(typeId) : null
  // An edge ends at a member of a subtype tree, not at the tree's centre: `oa`/`ob`
  // are the ends' offsets from their nodes, `len` the length the edge wants.
  const relOf = new Map()
  for (const t of trees) for (const [m, r] of t.rel) relOf.set(m, r)
  const radOf = (id) => { const n = memberById.get(id); return n ? (n.er ?? (n.w + n.h) / 4) : 20 }
  const edges = []
  const seen = new Set()
  const addEdge = (ma, mb, kind) => {
    const a = ma && grp(ma), b = mb && grp(mb)
    if (!a || !b || a === b) return
    const k = ma < mb ? `${ma}|${mb}` : `${mb}|${ma}`
    if (seen.has(k)) return
    seen.add(k)
    const o = (m) => relOf.get(m) ?? { x: 0, y: 0 }
    edges.push({ a, b, kind, oa: o(ma), ob: o(mb), len: radOf(ma) + radOf(mb) + GAP })
  }
  const memberOf = (typeId) => nodeOf(typeId) ? typeId : null
  for (const f of coreFacts) for (const p of players(f)) addEdge(`f:${f.id}`, memberOf(p), 'role')
  for (const id of nodeIds) {
    const f = factById.get(id)
    if (f?.objectified) for (const p of players(f)) addEdge(id, memberOf(p), 'role')
  }
  for (const st of subtypes) addEdge(memberOf(st.subId), memberOf(st.superId), 'subtype')
  const below = subtypes.map(st => ({ sub: nodeOf(st.subId), sup: nodeOf(st.superId) })).filter(p => p.sub && p.sup && p.sub !== p.sup)

  return {
    diagram, state, otById, factById, firstOcc, refMode, collapsedFacts,
    facts, valueIds, satVts, subtypes, blocks, coreFacts, sizeOf,
    nodes, edges, below, trees,
  }
}

// A tidy tree: each subtree as wide as its children side by side (leaves wrap into
// rows), the supertype centred above. Sets rel: member id → its anchor (the entity
// type's centre) relative to the tree's box centre. Returns the box size.
const TREE_GAP_X = 28, TREE_GAP_Y = 64, TREE_ROW_W = 1100
function layoutTree(root, kids, nodeById, rel) {
  const place = new Map()   // id → box centre relative to the subtree's top-left
  const lay = (id) => {
    const n = nodeById.get(id)
    const cs = kids.get(id) ?? []
    if (!cs.length) { place.set(id, { x: n.w / 2, y: n.h / 2 }); return { w: n.w, h: n.h, members: [id] } }
    const subs = cs.map(c => ({ c, ...lay(c) }))
    // Rows of subtrees, wrapped at TREE_ROW_W.
    const rows = []
    let row = [], rw = 0
    for (const s of subs) {
      if (row.length && rw + TREE_GAP_X + s.w > TREE_ROW_W) { rows.push(row); row = []; rw = 0 }
      rw += (row.length ? TREE_GAP_X : 0) + s.w
      row.push(s)
    }
    rows.push(row)
    // Rows top-down; the links to a lower row pass through a gap left in the middle
    // of each row above it (rows are placed bottom-up, x relative to the supertype).
    const tops = []
    let y = n.h + TREE_GAP_Y
    for (const r of rows) { tops.push(y); y += Math.max(...r.map(s => s.h)) + TREE_GAP_Y * 0.6 }
    const py = n.h / 2
    const xs = rows.map(() => [])            // left edge of each subtree, by row
    const links = []                          // { x, y } of lower rows' roots
    for (let k = rows.length - 1; k >= 0; k--) {
      const r = rows[k], top = tops[k], bottom = top + Math.max(...r.map(s => s.h))
      // Where the links to lower rows cross this row's band.
      let a = Infinity, b = -Infinity
      for (const t of links) for (const yy of [top, bottom]) {
        if (yy > t.y) continue
        const x = (t.x * (yy - py)) / (t.y - py)
        a = Math.min(a, x); b = Math.max(b, x)
      }
      const widths = r.map(s => s.w)
      if (a > b) {
        // Nothing passes: centred.
        let x = -(widths.reduce((u, v) => u + v, 0) + TREE_GAP_X * (r.length - 1)) / 2
        for (const s of r) { xs[k].push(x); x += s.w + TREE_GAP_X }
      } else {
        // Split the row into a left and a right part around [a, b].
        const total = widths.reduce((u, v) => u + v, 0)
        let cut = 0, acc = 0
        while (cut < r.length && acc + widths[cut] / 2 < total / 2) acc += widths[cut++]
        let x = a - TREE_GAP_X
        for (let i = cut - 1; i >= 0; i--) { x -= r[i].w; xs[k][i] = x; x -= TREE_GAP_X }
        x = b + TREE_GAP_X
        for (let i = cut; i < r.length; i++) { xs[k][i] = x; x += r[i].w + TREE_GAP_X }
      }
      r.forEach((s, i) => { const p = place.get(s.c); links.push({ x: xs[k][i] + p.x, y: top + p.y }) })
    }
    let lo = -n.w / 2, hi = n.w / 2
    rows.forEach((r, k) => r.forEach((s, i) => { lo = Math.min(lo, xs[k][i]); hi = Math.max(hi, xs[k][i] + s.w) }))
    // Keep the supertype in the middle of the box.
    const half = Math.max(-lo, hi)
    const w = 2 * half
    const members = [id]
    rows.forEach((r, k) => r.forEach((s, i) => {
      for (const m of s.members) { const p = place.get(m); place.set(m, { x: p.x + xs[k][i] + half, y: p.y + tops[k] }) }
      members.push(...s.members)
    }))
    place.set(id, { x: w / 2, y: n.h / 2 })
    return { w, h: y - TREE_GAP_Y * 0.6, members }
  }
  const box = lay(root)
  for (const m of box.members) {
    const p = place.get(m), n = nodeById.get(m)
    rel.set(m, { x: p.x - box.w / 2 - (n.offX ?? 0), y: p.y - box.h / 2 })
  }
  return box
}

// ── 3: placement ─────────────────────────────────────────────────────────────

// Stress majorization (SMACOF) with ideal distances from shortest paths, each edge as
// long as its two nodes need; then overlap removal. Deterministic. Returns Map id →
// {x, y} of node centres.
export function placeCore(plan) {
  const { nodes, edges, below } = plan
  const idx = new Map(nodes.map((n, i) => [n.id, i]))
  const N = nodes.length
  const rad = nodes.map(n => n.er ?? (n.w + n.h) / 4)
  const adj = nodes.map(() => [])
  const links = nodes.map(() => [])   // [j, len, own offset, j's offset]
  for (const e of edges) {
    const a = idx.get(e.a), b = idx.get(e.b)
    if (a == null || b == null) continue
    const oa = e.oa ?? { x: 0, y: 0 }, ob = e.ob ?? { x: 0, y: 0 }
    const len = e.len ?? rad[a] + rad[b] + GAP
    const far = len + Math.hypot(oa.x, oa.y) + Math.hypot(ob.x, ob.y)
    adj[a].push([b, far]); adj[b].push([a, far])
    links[a].push([b, len, oa, ob]); links[b].push([a, len, ob, oa])
  }
  // Components
  const comp = new Array(N).fill(-1)
  const comps = []
  for (let i = 0; i < N; i++) {
    if (comp[i] >= 0) continue
    const list = [i]; comp[i] = comps.length
    for (let k = 0; k < list.length; k++) for (const [j] of adj[list[k]]) if (comp[j] < 0) { comp[j] = comps.length; list.push(j) }
    comps.push(list)
  }
  const pos = nodes.map(() => ({ x: 0, y: 0 }))
  const belowIdx = below.map(p => [idx.get(p.sub), idx.get(p.sup)]).filter(([a, b]) => a != null && b != null)
  for (const list of comps) stressComponent(list, adj, links, nodes, pos, belowIdx.filter(([a]) => comp[a] === comp[list[0]]))
  // Stress placed the entity types themselves; their satellites go to the side away
  // from their other links. From here on, positions are the centres of whole blocks.
  const side = nodes.map((n, i) => {
    if (!n.offX) return 1
    let dx = 0
    for (const [j] of adj[i]) dx += Math.sign(pos[j].x - pos[i].x)
    return dx > 0 ? -1 : 1
  })
  // A column that has links on its own side hangs away from them: down when they
  // go up, up when they go down.
  const hang = nodes.map((n, i) => {
    if (!n.hang) return 0
    let dy = 0, any = false
    for (const [j] of adj[i]) {
      if (Math.sign(pos[j].x - pos[i].x) !== side[i]) continue
      any = true
      dy += Math.sign(pos[j].y - pos[i].y)
    }
    return any ? (dy > 0 ? -1 : 1) : 0
  })
  const boxes = nodes.map((n, i) => hang[i] ? { ...n, h: n.hungH } : n)
  const offY = nodes.map((n, i) => hang[i] * (n.hungOff ?? 0))
  nodes.forEach((n, i) => { pos[i].x += side[i] * (n.offX ?? 0); pos[i].y += offY[i] })
  removeOverlaps(comps, boxes, pos)
  packComponents(comps, boxes, pos)
  return new Map(nodes.map((n, i) => [n.id, { x: Math.round(pos[i].x - side[i] * (n.offX ?? 0)), y: Math.round(pos[i].y - offY[i]), side: side[i], hang: hang[i] }]))
}

function dijkstra(src, adj, members) {
  const dist = new Map([[src, 0]])
  const done = new Set()
  // Small graphs: a simple O(V²) scan is fast enough and deterministic.
  for (;;) {
    let u = -1, best = Infinity
    for (const [k, d] of dist) if (!done.has(k) && d < best) { best = d; u = k }
    if (u < 0) break
    done.add(u)
    for (const [v, w] of adj[u]) {
      const nd = best + w
      if (nd < (dist.get(v) ?? Infinity)) dist.set(v, nd)
    }
  }
  return members.map(m => dist.get(m) ?? Infinity)
}

function stressComponent(list, adj, links, nodes, pos, belowIdx) {
  const n = list.length
  if (n === 1) { pos[list[0]] = { x: 0, y: 0 }; return }
  const D = list.map(s => dijkstra(s, adj, list))
  // Start from a two-pivot embedding: distances to the two farthest-apart nodes.
  let a = 0
  for (let i = 1; i < n; i++) if (D[0][i] > D[0][a]) a = i
  let b = 0
  for (let i = 1; i < n; i++) if (D[a][i] > D[a][b]) b = i
  const dab = D[a][b] || 1
  const X = new Float64Array(n), Y = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    X[i] = (D[a][i] ** 2 - D[b][i] ** 2 + dab ** 2) / (2 * dab)
    Y[i] = Math.sqrt(Math.max(0, D[a][i] ** 2 - X[i] ** 2))
    // Spread nodes with equal pivot distances apart (deterministically).
    Y[i] += (i % 7) * 13 - 39
    X[i] += (i % 5) * 11 - 22
  }
  const local = new Map(list.map((g, i) => [g, i]))
  const bel = belowIdx.map(([s, t]) => [local.get(s), local.get(t)])
  const iters = n > 300 ? 120 : 300
  for (let it = 0; it < iters; it++) {
    for (let i = 0; i < n; i++) {
      let sx = 0, sy = 0, sw = 0
      // Links pull the members they join (in a subtype tree, off its centre) to
      // their length.
      for (const [g, d, oi, oj] of links[list[i]]) {
        const j = local.get(g)
        if (j == null) continue
        const w = 1 / (d * d)
        const dx = X[i] + oi.x - X[j] - oj.x, dy = Y[i] + oi.y - Y[j] - oj.y
        const l = Math.hypot(dx, dy) || 1e-6
        sx += w * (X[j] + oj.x - oi.x + d * dx / l)
        sy += w * (Y[j] + oj.y - oi.y + d * dy / l)
        sw += w
      }
      for (let j = 0; j < n; j++) {
        if (i === j) continue
        const d = D[i][j]
        if (!isFinite(d) || d === 0) continue
        const w = 1 / (d * d)
        const dx = X[i] - X[j], dy = Y[i] - Y[j]
        const l = Math.hypot(dx, dy) || 1e-6
        sx += w * (X[j] + d * dx / l)
        sy += w * (Y[j] + d * dy / l)
        sw += w
      }
      if (sw > 0) { X[i] = sx / sw; Y[i] = sy / sw }
    }
    // Subtypes below their supertypes.
    for (const [s, t] of bel) {
      const need = (nodes[list[s]].h + nodes[list[t]].h) / 2 + GAP
      const gap = Y[s] - Y[t]
      if (gap < need) { const m = (need - gap) / 2; Y[s] += m; Y[t] -= m }
    }
  }
  // Prefer landscape: rotate the principal axis to horizontal unless subtypes fix the vertical.
  if (bel.length === 0) {
    let mx = 0, my = 0
    for (let i = 0; i < n; i++) { mx += X[i]; my += Y[i] }
    mx /= n; my /= n
    let sxx = 0, syy = 0, sxy = 0
    for (let i = 0; i < n; i++) { const dx = X[i] - mx, dy = Y[i] - my; sxx += dx * dx; syy += dy * dy; sxy += dx * dy }
    const th = 0.5 * Math.atan2(2 * sxy, sxx - syy)
    const c = Math.cos(-th), s = Math.sin(-th)
    for (let i = 0; i < n; i++) {
      const dx = X[i] - mx, dy = Y[i] - my
      X[i] = dx * c - dy * s; Y[i] = dx * s + dy * c
    }
  }
  for (let i = 0; i < n; i++) pos[list[i]] = { x: X[i], y: Y[i] }
}

// Pushes overlapping boxes apart (with a margin) along the axis of least overlap.
function removeOverlaps(comps, nodes, pos) {
  const M = 24
  for (const list of comps) {
    for (let it = 0; it < 200; it++) {
      let moved = false
      const order = [...list].sort((p, q) => (pos[p].x - nodes[p].w / 2) - (pos[q].x - nodes[q].w / 2))
      for (let a = 0; a < order.length; a++) {
        const i = order[a]
        const ri = pos[i].x + nodes[i].w / 2 + M
        for (let c = a + 1; c < order.length; c++) {
          const j = order[c]
          if (pos[j].x - nodes[j].w / 2 >= ri) break
          const ox = (nodes[i].w + nodes[j].w) / 2 + M - Math.abs(pos[i].x - pos[j].x)
          const oy = (nodes[i].h + nodes[j].h) / 2 + M - Math.abs(pos[i].y - pos[j].y)
          if (ox <= 0 || oy <= 0) continue
          moved = true
          if (ox * 0.7 < oy) {
            const s = pos[i].x < pos[j].x || (pos[i].x === pos[j].x && i < j) ? -1 : 1
            pos[i].x += s * ox / 2; pos[j].x -= s * ox / 2
          } else {
            const s = pos[i].y < pos[j].y || (pos[i].y === pos[j].y && i < j) ? -1 : 1
            pos[i].y += s * oy / 2; pos[j].y -= s * oy / 2
          }
        }
      }
      if (!moved) break
    }
  }
}

// Shelf packing of the components, largest first, into a landscape area.
function packComponents(comps, nodes, pos) {
  const boxes = comps.map(list => {
    let l = Infinity, t = Infinity, r = -Infinity, b = -Infinity
    for (const i of list) {
      l = Math.min(l, pos[i].x - nodes[i].w / 2); r = Math.max(r, pos[i].x + nodes[i].w / 2)
      t = Math.min(t, pos[i].y - nodes[i].h / 2); b = Math.max(b, pos[i].y + nodes[i].h / 2)
    }
    return { list, l, t, w: r - l, h: b - t }
  })
  const area = boxes.reduce((s, b) => s + (b.w + GAP) * (b.h + GAP), 0)
  const maxW = Math.max(boxes.reduce((m, b) => Math.max(m, b.w), 0), Math.sqrt(area) * 1.6)
  const order = boxes.map((b, i) => i).sort((p, q) => boxes[q].h - boxes[p].h || boxes[q].w - boxes[p].w || p - q)
  let x = 0, y = 0, rowH = 0
  for (const k of order) {
    const b = boxes[k]
    if (x > 0 && x + b.w > maxW) { y += rowH + GAP * 1.5; x = 0; rowH = 0 }
    const dx = 100 + x - b.l, dy = 100 + y - b.t
    for (const i of b.list) { pos[i].x += dx; pos[i].y += dy }
    x += b.w + GAP * 1.5
    rowH = Math.max(rowH, b.h)
  }
}

// ── 4 + 5: the diagram ───────────────────────────────────────────────────────

function rectBorder(c, w, h, tx, ty) {
  const dx = tx - c.x, dy = ty - c.y
  if (dx === 0 && dy === 0) return { x: c.x, y: c.y }
  const t = Math.abs(dx) * h / 2 > Math.abs(dy) * w / 2 ? (w / 2) / Math.abs(dx) : (h / 2) / Math.abs(dy)
  return { x: c.x + dx * t, y: c.y + dy * t }
}

const segCross = (p, q, r, s) => {
  const d = (a, b, c) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)
  const d1 = d(p, q, r), d2 = d(p, q, s), d3 = d(r, s, p), d4 = d(r, s, q)
  return ((d1 > 0) !== (d2 > 0)) && ((d3 > 0) !== (d4 > 0)) && d1 && d2 && d3 && d4
}

// Orientation, role order and bar side of a fact type given where its players are.
function orientFact(f, at, playerAt) {
  const n = f.roles.length
  const ident = Array.from({ length: n }, (_, i) => i)
  const orders = [ident]
  if (n === 2) orders.push([1, 0])
  let best = null
  for (const orientation of ['horizontal', 'vertical']) {
    for (const roleOrder of orders) {
      const g = { ...f, arity: n, x: at.x, y: at.y, orientation, roleOrder }
      let cost = orientation === 'vertical' ? 4 : 0   // horizontal reads best when it doesn't matter
      const segs = []
      const sides = []
      f.roles.forEach((r, ri) => {
        const p = playerAt(ri)
        if (!p) return
        const a = roleAnchor(g, ri, p.x, p.y)
        const e = rectBorder(p, p.w, p.h, a.x, a.y)
        cost += Math.hypot(a.x - e.x, a.y - e.y)
        // A connector that leaves the role box towards the fact type itself crosses it.
        const back = orientation === 'horizontal'
          ? (a.side === 'N' && e.y > a.y) || (a.side === 'S' && e.y < a.y)
          : (a.side === 'W' && e.x > a.x) || (a.side === 'E' && e.x < a.x)
        if (back) cost += 80
        segs.push([a, e]); sides.push(a.side)
      })
      for (let i = 0; i < segs.length; i++) for (let j = i + 1; j < segs.length; j++) if (segCross(...segs[i], ...segs[j])) cost += 120
      if (!best || cost < best.cost - 1e-6) best = { cost, orientation, roleOrder, sides }
    }
  }
  const count = (s) => best.sides.filter(x => x === s).length
  const uniquenessBelow = best.orientation === 'horizontal' ? count('N') > count('S') : count('E') > count('W')
  return { orientation: best.orientation, roleOrder: n > 1 ? best.roleOrder : undefined, uniquenessBelow }
}

const KEEP_FACT_FIELDS = ['readingDisplay', 'readingOrder', 'nestedReading', 'readingAbove']

export function finishLayout(plan, placed) {
  // Members of a subtype tree sit where the tree's layout put them.
  const centres = new Map(placed)
  for (const t of plan.trees ?? []) {
    const c = placed.get(t.id)
    if (!c) continue
    for (const [m, r] of t.rel) centres.set(m, { x: c.x + r.x, y: c.y + r.y, side: 1 })
  }
  const { diagram, state, otById, factById, firstOcc, refMode, collapsedFacts, facts, valueIds, satVts, subtypes, blocks, coreFacts, sizeOf } = plan
  const out = []                 // new occurrences
  const newId = new Map()        // element id → its (first) new occurrence id
  const at = new Map()           // new occurrence id → { x, y, w, h }
  const reuse = (elId) => {
    const o = firstOcc.get(elId)
    return o && !out.some(p => p.id === o.id) ? o.id : null
  }
  const keepFrom = (elId) => {
    const o = firstOcc.get(elId)
    const kept = {}
    if (o) for (const k of KEEP_FACT_FIELDS) if (o[k] !== undefined) kept[k] = o[k]
    return kept
  }
  const emit = (elId, x, y, extra = {}, size = null) => {
    const id = reuse(elId) ?? mkOcc(elId, 0, 0).id
    const occ = { id, schemaElementId: elId, x: Math.round(x), y: Math.round(y), ...extra }
    out.push(occ)
    if (!newId.has(elId)) newId.set(elId, id)
    if (size) at.set(id, { x: occ.x, y: occ.y, w: size.w, h: size.h })
    return occ
  }

  // Entity types and objectified fact types with their satellites.
  const nodeOccId = new Map()
  const satFacts = []            // [{ occ, fact }] to set roleOccurrenceMap after
  for (const [id, blk] of blocks) {
    const c = centres.get(id)
    const ex = c.x, ey = c.y, flip = c.side ?? 1, drop = (c.hang ?? 0) * blk.hang
    const f = factById.get(id)
    const extra = f?.objectified ? { ...keepFrom(id), orientation: 'horizontal', roleOrder: undefined } : {}
    const occ = emit(id, ex, ey, extra, { w: blk.ew, h: blk.eh })
    nodeOccId.set(id, occ.id)
    for (const row of blk.rows) {
      const n = row.fact.roles.length
      const map = { [row.ownerRole]: occ.id }
      const side = row.side * flip
      if (row.vt) {
        const vo = emit(row.vt, ex + flip * row.vx, ey + drop + row.vy, {}, sizeOf(row.vt))
        map[1 - row.ownerRole] = vo.id
      } else if (row.ring) map[1] = occ.id
      // The entity's role faces the entity.
      const roleOrder = n === 2 ? (side > 0 ? [row.ownerRole, 1 - row.ownerRole] : [1 - row.ownerRole, row.ownerRole]) : undefined
      // A unary's reading beside it, away from the entity.
      const beside = n === 1 ? { readingAbove: false, readingOffsetBelow: { dx: side * (factLen(1) / 2 + UNARY_READ + readingW(row.fact) / 2), dy: 0 } } : {}
      const fo = emit(row.fact.id, ex + flip * row.fx, ey + drop + row.fy, { ...keepFrom(row.fact.id), orientation: 'horizontal', ...(roleOrder ? { roleOrder } : {}), uniquenessBelow: false, ...beside, roleOccurrenceMap: map })
      satFacts.push({ occ: fo, fact: row.fact })
    }
  }
  // Other value types.
  for (const v of valueIds) {
    if (satVts.has(v)) continue
    const c = centres.get(v)
    emit(v, c.x, c.y, {}, sizeOf(v))
  }
  // Core fact types.
  const typeAt = (typeId) => {
    const id = newId.get(typeId)
    return id ? at.get(id) : null
  }
  for (const f of coreFacts) {
    const c = centres.get(`f:${f.id}`)
    const o = orientFact(f, c, (ri) => typeAt(f.roles[ri].objectTypeId))
    const map = {}
    f.roles.forEach((r, ri) => { const id = newId.get(r.objectTypeId); if (id) map[ri] = id })
    const extra = { ...keepFrom(f.id), orientation: o.orientation, uniquenessBelow: o.uniquenessBelow, roleOccurrenceMap: map }
    if (o.roleOrder) extra.roleOrder = o.roleOrder
    emit(f.id, c.x, c.y, extra)
  }
  // Objectified fact types: their roles' players.
  for (const [id] of blocks) {
    const f = factById.get(id)
    if (!f?.objectified) continue
    const occ = out.find(o => o.id === nodeOccId.get(id))
    const map = {}
    f.roles.forEach((r, ri) => { const pid = newId.get(r.objectTypeId); if (pid) map[ri] = pid })
    occ.roleOccurrenceMap = map
    // Bars away from the players' side.
    const above = f.roles.filter(r => { const p = typeAt(r.objectTypeId); return p && p.y < occ.y }).length
    occ.uniquenessBelow = above > f.roles.length / 2
  }

  // Reference modes: hidden owned occurrences when collapsed; owned visible ones when not.
  const expandedRefModeOccs = []
  for (const [id, { rm, collapsed }] of refMode) {
    const ownerOcc = nodeOccId.get(id)
    if (!ownerOcc) continue
    const ownerAt = at.get(ownerOcc)
    if (collapsed) {
      const vt = mkOcc(rm.vtId, ownerAt.x + 160, ownerAt.y, { refModeOwnerOccId: ownerOcc })
      const old = (diagram.occurrences ?? []).find(o => o.schemaElementId === rm.factId && o.refModeOwnerOccId === firstOcc.get(id)?.id)
        ?? (diagram.occurrences ?? []).find(o => o.schemaElementId === rm.factId)
      const ft = {
        ...mkOcc(rm.factId, ownerAt.x + 80, ownerAt.y, { refModeOwnerOccId: ownerOcc }),
        ...(old && !out.some(p => p.id === old.id) ? { id: old.id } : {}),
        roleOccurrenceMap: { [String(1 - rm.vtRoleIndex)]: ownerOcc, [String(rm.vtRoleIndex)]: vt.id },
      }
      out.push(vt, ft)
      if (!newId.has(rm.factId)) newId.set(rm.factId, ft.id)
    } else {
      expandedRefModeOccs.push(ownerOcc)
      const ft = out.find(o => o.schemaElementId === rm.factId)
      if (ft) {
        ft.refModeOwnerOccId = ownerOcc
        const vtOcc = out.find(o => o.id === ft.roleOccurrenceMap?.[String(rm.vtRoleIndex)])
        if (vtOcc && satVts.has(rm.vtId)) vtOcc.refModeOwnerOccId = ownerOcc
      }
    }
  }

  // Old occurrence ids → new ones (constraint and note references).
  const remap = new Map()
  for (const o of diagram.occurrences ?? []) {
    if (out.some(p => p.id === o.id)) remap.set(o.id, o.id)
    else if (newId.has(o.schemaElementId)) remap.set(o.id, newId.get(o.schemaElementId))
  }

  // Subtype links between the drawn occurrences.
  const subtypeEndpointOccs = {}
  for (const st of subtypes) {
    const s = newId.get(st.subId), p = newId.get(st.superId)
    if (s && p) subtypeEndpointOccs[st.id] = [{ subOccId: s, superOccId: p }]
  }

  // Positions used for constraint placement.
  const factOccOf = new Map()
  for (const o of out) if (factById.has(o.schemaElementId) && !o.refModeOwnerOccId && !factOccOf.has(o.schemaElementId)) factOccOf.set(o.schemaElementId, o)
  const drawnFact = (fid) => {
    const o = factOccOf.get(fid)
    if (!o) return null
    const f = factById.get(fid)
    return { ...f, arity: f.roles.length, x: o.x, y: o.y, orientation: o.orientation, roleOrder: o.roleOrder, uniquenessBelow: o.uniquenessBelow }
  }
  const roleCentre = (fid, ri) => {
    if (collapsedFacts.has(fid)) { const p = typeAt(collapsedFacts.get(fid)); return p && { x: p.x, y: p.y } }
    const base = String(fid).split('_il_')[0]
    const f = drawnFact(base)
    if (!f) return null
    if (base !== fid) return { x: f.x, y: f.y }
    const n = f.arity, order = f.roleOrder ?? Array.from({ length: n }, (_, i) => i)
    const k = order.indexOf(ri)
    const off = -factLen(n) / 2 + k * (ROLE_W + ROLE_GAP) + ROLE_W / 2
    return f.orientation === 'vertical' ? { x: f.x, y: f.y + off } : { x: f.x + off, y: f.y }
  }
  // A constraint's members as drawn: a role's connector ends at the side of the
  // role box facing the constraint, a subtype member at the link's midpoint.
  // `own` is the occurrence the connector ends at (its own lines don't count).
  const occOfFact = (fid) => factOccOf.get(fid)
  const membersOf = (c) => {
    const ms = []
    const members = [...(c.sequences ?? []).flat(), ...(c.roleSequences ?? []).flat().map(r => ({ kind: 'role', ...r }))]
    for (const m of members) {
      if (m?.kind === 'role') {
        if (collapsedFacts.has(m.factId)) {
          const id = newId.get(collapsedFacts.get(m.factId)), p = id && at.get(id)
          if (p) ms.push({ own: id, at: (x, y) => rectBorder(p, p.w, p.h, x, y), c: p })
          continue
        }
        const base = String(m.factId).split('_il_')[0]
        const f = drawnFact(base), o = occOfFact(base)
        if (!f) continue
        if (base !== m.factId) { ms.push({ own: o.id, at: () => ({ x: f.x, y: f.y }), c: { x: f.x, y: f.y } }); continue }
        ms.push({ own: o.id, at: (x, y) => roleAnchor(f, m.roleIndex, x, y), c: roleCentre(base, m.roleIndex) })
      } else if (m?.kind === 'subtype') {
        const st = state.subtypes.find(s => s.id === m.subtypeId)
        const a = st && typeAt(st.subId), b = st && typeAt(st.superId)
        if (a && b) { const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }; ms.push({ own: null, at: () => mid, c: mid }) }
      }
    }
    if (c.constraintType === 'formula' && c.rule) {
      const { facts: fs, types } = formulaElements(c.rule)
      for (const fid of fs) { const f = drawnFact(fid); if (f) { const pt = { x: f.x, y: f.y }; ms.push({ own: occOfFact(fid).id, at: () => pt, c: pt }) } }
      for (const t of types) { const id = newId.get(t), p = id && at.get(id); if (p) ms.push({ own: id, at: (x, y) => rectBorder(p, p.w, p.h, x, y), c: p }) }
    }
    if (!ms.length && c.targetObjectTypeId) { const id = newId.get(c.targetObjectTypeId), p = id && at.get(id); if (p) ms.push({ own: id, at: (x, y) => rectBorder(p, p.w, p.h, x, y), c: p }) }
    return ms
  }

  // Obstacles: every type and fact type box.
  const obstacles = []
  for (const o of out) {
    if (o.refModeOwnerOccId && !expandedRefModeOccs.includes(o.refModeOwnerOccId)) continue
    const a = at.get(o.id)
    if (a) {
      const label = factById.get(o.schemaElementId)?.objectified ? 24 : 0   // the name above the box
      obstacles.push({ key: o.id, l: a.x - a.w / 2, r: a.x + a.w / 2, t: a.y - a.h / 2 - label, b: a.y + a.h / 2 })
      continue
    }
    const f = factById.get(o.schemaElementId)
    if (f) {
      const b = factBox({ ...f, ...o, arity: f.roles.length, id: f.id })
      obstacles.push({ key: o.id, l: b.l, r: b.r, t: b.t, b: b.b })
    }
  }
  // Lines already drawn: role connectors and subtype links.
  const lines = []
  for (const o of out) {
    const f = factById.get(o.schemaElementId)
    if (!f || !o.roleOccurrenceMap) continue
    if (o.refModeOwnerOccId && !expandedRefModeOccs.includes(o.refModeOwnerOccId)) continue
    const g = { ...f, arity: f.roles.length, x: o.x, y: o.y, orientation: o.orientation, roleOrder: o.roleOrder }
    for (const [ri, pid] of Object.entries(o.roleOccurrenceMap)) {
      const p = at.get(pid)
      if (!p || pid === o.id) continue
      const a = roleAnchor(g, Number(ri), p.x, p.y)
      lines.push({ p: a, q: rectBorder(p, p.w, p.h, a.x, a.y), own: [o.id, pid] })
    }
  }
  for (const [, eps] of Object.entries(subtypeEndpointOccs)) for (const { subOccId, superOccId } of eps) {
    const a = at.get(subOccId), b = at.get(superOccId)
    if (a && b) lines.push({ p: rectBorder(a, a.w, a.h, b.x, b.y), q: rectBorder(b, b.w, b.h, a.x, a.y), own: [subOccId, superOccId] })
  }
  const hitsBox = (p, q, b) => {
    const l = b.l + 2, r = b.r - 2, t = b.t + 2, bt = b.b - 2
    if (Math.max(p.x, q.x) < l || Math.min(p.x, q.x) > r || Math.max(p.y, q.y) < t || Math.min(p.y, q.y) > bt) return false
    const inside = (z) => z.x > l && z.x < r && z.y > t && z.y < bt
    if (inside(p) || inside(q)) return true
    const c = [{ x: l, y: t }, { x: r, y: t }, { x: r, y: bt }, { x: l, y: bt }]
    return [0, 1, 2, 3].some(i => segCross(p, q, c[i], c[(i + 1) % 4]))
  }
  const distToSeg = (z, p, q) => {
    const dx = q.x - p.x, dy = q.y - p.y, L = dx * dx + dy * dy
    const t = L ? Math.max(0, Math.min(1, ((z.x - p.x) * dx + (z.y - p.y) * dy) / L)) : 0
    return Math.hypot(z.x - p.x - t * dx, z.y - p.y - t * dy)
  }
  const free = (x, y, w, h, skip, obs = obstacles) => {
    const l = x - w / 2 - 6, r = x + w / 2 + 6, t = y - h / 2 - 6, b = y + h / 2 + 6
    return !obs.some(o => o !== skip && o.l < r && o.r > l && o.t < b && o.b > t)
  }
  // The cost of a constraint at (x, y): the length of its connectors, plus
  // penalties for each one that crosses a line or runs through a box, and for
  // sitting on a line. Placed constraints' connectors count as lines. `near` holds
  // the lines and boxes in the area searched.
  const W_CROSS = 320, W_THROUGH = 480, W_ON_LINE = 160
  const constraintCost = (x, y, ms, near) => {
    const z = { x, y }
    let cost = 0
    for (const m of ms) {
      const q = m.at(x, y)
      cost += Math.hypot(q.x - x, q.y - y)
      for (const ln of near.lines) if (!ln.own.includes(m.own) && segCross(z, q, ln.p, ln.q)) cost += W_CROSS
      for (const ln of near.others) if (!(m.own && ln.own.includes(m.own)) && segCross(z, q, ln.p, ln.q)) cost += W_CROSS
      for (const b of near.obs) if (b.key !== m.own && !b.self && hitsBox(z, q, b)) cost += W_THROUGH
    }
    for (const ln of near.lines) if (distToSeg(z, ln.p, ln.q) < C_SIZE / 2 + 2) cost += W_ON_LINE
    for (const ln of near.others) if (distToSeg(z, ln.p, ln.q) < C_SIZE / 2 + 2) cost += W_ON_LINE
    return cost
  }
  // The area searched: the members' bounds, widened.
  const areaOf = (ms) => {
    const xs = ms.map(m => m.c.x), ys = ms.map(m => m.c.y)
    return { l: Math.min(...xs) - 140, r: Math.max(...xs) + 140, t: Math.min(...ys) - 140, b: Math.max(...ys) + 140 }
  }
  const nearOf = (a, others) => {
    const inA = (p, q) => Math.max(p.x, q.x) >= a.l - 20 && Math.min(p.x, q.x) <= a.r + 20 && Math.max(p.y, q.y) >= a.t - 20 && Math.min(p.y, q.y) <= a.b + 20
    return {
      lines: lines.filter(ln => inA(ln.p, ln.q)),
      others: others.filter(ln => inA(ln.p, ln.q)),
      obs: obstacles.filter(o => o.r >= a.l - 20 && o.l <= a.r + 20 && o.b >= a.t - 20 && o.t <= a.b + 20),
    }
  }
  // Candidates: a grid over the area.
  const candidates = (ms, a) => {
    const step = Math.max(14, Math.sqrt((a.r - a.l) * (a.b - a.t) / 1600))
    const pts = []
    for (let x = a.l; x <= a.r; x += step) for (let y = a.t; y <= a.b; y += step) pts.push({ x, y })
    const xs = ms.map(m => m.c.x), ys = ms.map(m => m.c.y)
    pts.push({ x: (Math.min(...xs) + Math.max(...xs)) / 2, y: (Math.min(...ys) + Math.max(...ys)) / 2 })
    return pts
  }
  // The best free spot, and the cost of `keep` (where the constraint is now) if given.
  const placeConstraint = (ms, others, skip, keep = null) => {
    const a = areaOf(ms)
    if (keep) { a.l = Math.min(a.l, keep.x); a.r = Math.max(a.r, keep.x); a.t = Math.min(a.t, keep.y); a.b = Math.max(a.b, keep.y) }
    const near = nearOf(a, others)
    let best = null
    for (const p of candidates(ms, a)) {
      if (!free(p.x, p.y, C_SIZE, C_SIZE, skip, near.obs)) continue
      const cost = constraintCost(p.x, p.y, ms, near)
      if (!best || cost < best.cost) best = { ...p, cost }
    }
    if (keep && best && constraintCost(keep.x, keep.y, ms, near) <= best.cost + 1) return null
    if (!best) {   // nowhere free near: spiral out from the centre
      const xs = ms.map(m => m.c.x), ys = ms.map(m => m.c.y)
      const cx = (Math.min(...xs) + Math.max(...xs)) / 2, cy = (Math.min(...ys) + Math.max(...ys)) / 2
      for (let rr = 16; rr <= 900 && !best; rr += 16) {
        const steps = Math.max(8, Math.round(rr / 6))
        for (let k = 0; k < steps && !best; k++) {
          const th = -Math.PI / 2 + (2 * Math.PI * k) / steps
          const x = cx + rr * Math.cos(th), y = cy + rr * Math.sin(th)
          if (free(x, y, C_SIZE, C_SIZE, skip)) best = { x, y }
        }
      }
      if (keep) return null
    }
    return best ?? { x: ms[0].c.x, y: ms[0].c.y }
  }

  const constraintById = new Map(state.constraints.map(c => [c.id, c]))
  const remapRefs = (refs) => {
    if (!refs || Array.isArray(refs)) return refs ?? {}
    return Object.fromEntries(Object.entries(refs).map(([k, v]) => [k, remap.get(v) ?? v]).filter(([, v]) => out.some(o => o.id === v)))
  }
  const seenC = new Set()
  // Most-connected constraints first: they have the fewest good spots.
  const coccs = (diagram.constraintOccurrences ?? [])
    .filter(co => constraintById.has(co.schemaConstraintId) && !seenC.has(co.schemaConstraintId) && seenC.add(co.schemaConstraintId))
    .map(co => ({ co, ms: membersOf(constraintById.get(co.schemaConstraintId)), x: co.x, y: co.y, box: null, lines: [] }))
    .sort((p, q) => q.ms.length - p.ms.length)
  const cLines = []
  const setAt = (e, x, y) => {
    e.x = Math.round(x); e.y = Math.round(y)
    if (!e.box) { e.box = { self: true }; obstacles.push(e.box) }
    Object.assign(e.box, { l: e.x - C_SIZE / 2, r: e.x + C_SIZE / 2, t: e.y - C_SIZE / 2, b: e.y + C_SIZE / 2 })
    for (const ln of e.lines) cLines.splice(cLines.indexOf(ln), 1)
    e.lines = e.ms.map(m => ({ p: { x: e.x, y: e.y }, q: m.at(e.x, e.y), own: [m.own].filter(Boolean) }))
    cLines.push(...e.lines)
  }
  for (const e of coccs) {
    if (!e.ms.length) { setAt(e, e.x, e.y); continue }
    const p = placeConstraint(e.ms, cLines, null)
    setAt(e, p.x, p.y)
  }
  // Then each again, knowing where all the others are.
  for (let pass = 0; pass < 2; pass++) for (const e of coccs) {
    if (!e.ms.length) continue
    const own = new Set(e.lines)
    const p = placeConstraint(e.ms, cLines.filter(ln => !own.has(ln)), e.box, { x: e.x, y: e.y })
    if (p) setAt(e, p.x, p.y)
  }
  const constraintOccurrences = coccs.map(({ co, x, y }) => ({ ...co, x, y, roleOccurrenceRefs: remapRefs(co.roleOccurrenceRefs), queryOccurrenceRefs: remapRefs(co.queryOccurrenceRefs) }))

  // Internal frequency markers next to their fact type's bars.
  const internalFrequency = {}
  for (const f of facts) {
    if (!f.internalFrequency?.length) continue
    const d = drawnFact(f.id)
    if (!d) continue
    internalFrequency[f.id] = f.internalFrequency.map(m => ({ ...m, ...defaultFrequencyPos(d, m.roles ?? []) }))
  }

  // Notes keep their place relative to the first element they are linked to.
  const oldAt = new Map()
  for (const o of diagram.occurrences ?? []) { if (!oldAt.has(o.schemaElementId)) oldAt.set(o.schemaElementId, o); oldAt.set(o.id, o) }
  const newAt = (key) => {
    const occId = remap.get(key) ?? newId.get(key)
    return occId ? out.find(o => o.id === occId) : null
  }
  let maxX = -Infinity, minY = Infinity
  for (const o of obstacles) { maxX = Math.max(maxX, o.r); minY = Math.min(minY, o.t) }
  let noteY = isFinite(minY) ? minY : 100
  const notes = (diagram.notes ?? []).map(n => {
    for (const c of n.connectors ?? []) {
      const before = oldAt.get(c.targetId), after = newAt(c.targetId)
      if (before && after) return { ...n, x: Math.round(n.x + after.x - before.x), y: Math.round(n.y + after.y - before.y) }
    }
    const placed = { ...n, x: Math.round((isFinite(maxX) ? maxX : 100) + 80), y: Math.round(noteY) }
    noteY += (n.height ?? 80) + 30
    return placed
  })

  const next = {
    ...diagram,
    occurrences: out,
    constraintOccurrences,
    subtypeOccurrences: subtypes.map(st => st.id).concat((diagram.subtypeOccurrences ?? []).filter(id => !subtypes.some(st => st.id === id))),
    subtypeEndpointOccs,
    expandedRefModeOccs,
    expandedRefModes: [],
    implicitLinkPositions: {},
    notes,
  }
  return { diagram: next, internalFrequency }
}

/** The whole pipeline with the built-in placement. */
export function layoutOrmDiagram(state, diagramId) {
  const plan = prepareLayout(state, diagramId)
  if (!plan) return null
  return finishLayout(plan, placeCore(plan))
}
