// Suggested mapping diagrams: the rules of a mapping split into groups that
// share elements, as a first partition the user reviews (SuggestDiagramsDialog).
//
// Each rule has two element sets, what a mapping diagram shows for it on
// either side (ruleWantedElements, plus the players of its fact types). Two
// rules attract when the sets overlap (weighted Jaccard similarity, the mean
// of the source and the target side). Clustering is in two levels, both by
// Louvain-style local moves with aggregation:
//   1. rules about the same thing (an entity type, a table): constant Potts
//      model, i.e. correlation clustering with threshold GAMMA1, where an
//      element weighs log(N / rules naming it) so hubs don't glue everything;
//   2. those groups into diagrams: modularity over plain Jaccard (shared hubs
//      and foreign-key rules now count), then a size pass: a group drawing
//      more than `cap` shapes is split again, and groups whose union stays
//      under the cap merge while they attract.
// Stability: the clustering is repeated with other seeds and resolutions;
// a rule whose group mates change in most runs is marked unsure, with the
// group it lands in most often otherwise.
//
// clusterRules(state, mapping, { ruleIds, cap, runs }) →
//   { groups: [{ id, name, ruleIds, shapes }], unsure: Map(ruleId → { score, alt }) }
// shapesOf(info, ruleIds) → how many shapes a diagram of those rules draws.

import { ruleWantedElements } from './diagramRules.js'
import { isRelationalFace } from '../relational/face.js'
import { isViewMapping } from '../store/storeHelpers.js'
import { singular } from '../relational/guessOrm.js'

const GAMMA1 = 0.2
const GAMMA2 = 1
const MERGE_GAMMA = +(globalThis.process?.env?.MG ?? 0.5)
export const DEFAULT_CAP = 50
const UNSURE = 0.5
const SMALL_RULES = 3
const SMALL_SHAPES = 12

// Per rule: the ids for similarity, and the shapes a diagram draws for it (a
// side drawn as ERD tables draws its tables only, their columns inside).
export function ruleInfo(state, mapping, rules) {
  const facts = new Map(state.facts.map(f => [f.id, f]))
  const types = new Map(state.objectTypes.map(o => [o.id, o]))
  const view = isViewMapping(state, mapping)
  const erd = {
    source: !view && isRelationalFace(state, mapping.sourceSchemaId),
    target: !view && isRelationalFace(state, mapping.targetSchemaId),
  }
  return rules.map(r => {
    const w = ruleWantedElements(state, mapping, [r])
    const sets = {}, shapes = new Set()
    for (const side of ['source', 'target']) {
      const ids = new Set(w[side])
      for (const id of w[side]) for (const ro of facts.get(id)?.roles ?? []) if (ro.objectTypeId) ids.add(ro.objectTypeId)
      sets[side] = [...ids]
      for (const id of ids) {
        if (erd[side]) { if (types.get(id)?.kind === 'entity') shapes.add(id) }
        else if (types.has(id) || facts.has(id)) shapes.add(id)
      }
    }
    // Level 2 leaves value types out: a ModifiedDate or Name column in every
    // table would otherwise tie unrelated tables together.
    const notValue = (id) => types.get(id)?.kind !== 'value'
    return { id: r.id, source: sets.source, target: sets.target, shapes: [...shapes],
      source2: sets.source.filter(notValue), target2: sets.target.filter(notValue) }
  })
}

export const shapesOf = (info, idxs) => new Set(idxs.flatMap(i => info[i].shapes)).size

// Similarity matrices: level 1 weighted by rarity, level 2 plain.
function similarities(info) {
  const N = info.length
  const df = new Map()
  for (const r of info) for (const id of new Set([...r.source, ...r.target])) df.set(id, (df.get(id) ?? 0) + 1)
  const idf = (id) => Math.log((N + 1) / df.get(id))
  const sets = info.map(r => ({ source: new Set(r.source), target: new Set(r.target) }))
  const sets2 = info.map(r => ({ source: new Set(r.source2), target: new Set(r.target2) }))
  const jac = (a, b, w) => {
    let inter = 0, uni = 0
    for (const x of a) { const v = w(x); uni += v; if (b.has(x)) inter += v }
    for (const x of b) if (!a.has(x)) uni += w(x)
    return uni ? inter / uni : 0
  }
  const one = () => 1
  const S1 = Array.from({ length: N }, () => new Float64Array(N))
  const S2 = Array.from({ length: N }, () => new Float64Array(N))
  for (let i = 0; i < N; i++) for (let j = i + 1; j < N; j++) {
    const a = sets[i], b = sets[j]
    // Rules with nothing in common on either side: zero, skip the work.
    let meet = false
    for (const x of a.source) if (b.source.has(x)) { meet = true; break }
    if (!meet) for (const x of a.target) if (b.target.has(x)) { meet = true; break }
    if (!meet) continue
    S1[i][j] = S1[j][i] = (jac(a.source, b.source, idf) + jac(a.target, b.target, idf)) / 2
    const a2 = sets2[i], b2 = sets2[j]
    S2[i][j] = S2[j][i] = (jac(a2.source, b2.source, one) + jac(a2.target, b2.target, one)) / 2
  }
  return { S1, S2 }
}

// A small seeded generator, so a suggestion is the same each time.
function random(seed) {
  let s = seed >>> 0 || 1
  return () => { s = (Math.imul(s, 1103515245) + 12345) >>> 0; return s / 4294967296 }
}

// Louvain local moves + aggregation from the given groups (arrays of rule
// indices). method 'cpm': penalty γ·n_a·n_c; 'mod': γ·k_a·k_c / 2m.
function louvain(S, groups, gamma, method, rnd) {
  const N = S.length
  const deg = new Float64Array(N); let m2 = 0
  for (let i = 0; i < N; i++) { let d = 0; for (let j = 0; j < N; j++) d += S[i][j]; deg[i] = d; m2 += d }
  if (!m2) m2 = 1
  let nodes = groups.map(g => [...g])
  for (;;) {
    const n = nodes.length
    if (n < 2) return nodes
    const W = Array.from({ length: n }, () => new Float64Array(n))
    for (let a = 0; a < n; a++) for (let b = a + 1; b < n; b++) {
      let s = 0
      for (const i of nodes[a]) { const row = S[i]; for (const j of nodes[b]) s += row[j] }
      W[a][b] = W[b][a] = s
    }
    const size = nodes.map(x => x.length), k = nodes.map(x => x.reduce((t, i) => t + deg[i], 0))
    const comm = nodes.map((_, a) => a)
    const csize = new Map(size.map((v, a) => [a, v])), ck = new Map(k.map((v, a) => [a, v]))
    const pen = (a, c) => (method === 'cpm' ? gamma * size[a] * (csize.get(c) ?? 0) : gamma * k[a] * (ck.get(c) ?? 0) / m2)
    let fresh = n, moved = true, any = false, rounds = 0
    while (moved && rounds++ < 50) {
      moved = false
      const order = [...Array(n).keys()]
      for (let i = n - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [order[i], order[j]] = [order[j], order[i]] }
      for (const a of order) {
        const own = comm[a]
        csize.set(own, csize.get(own) - size[a]); ck.set(own, ck.get(own) - k[a])
        const links = new Map()
        for (let b = 0; b < n; b++) if (b !== a && W[a][b] > 0) links.set(comm[b], (links.get(comm[b]) ?? 0) + W[a][b])
        let best = own, bestGain = (links.get(own) ?? 0) - pen(a, own)
        for (const [c, l] of links) { const g = l - pen(a, c); if (g > bestGain + 1e-12) { best = c; bestGain = g } }
        if (bestGain < 0) best = fresh++
        csize.set(best, (csize.get(best) ?? 0) + size[a]); ck.set(best, (ck.get(best) ?? 0) + k[a])
        if (best !== own) { comm[a] = best; moved = true; any = true }
      }
    }
    if (!any) return nodes
    const merged = new Map()
    nodes.forEach((x, a) => { if (!merged.has(comm[a])) merged.set(comm[a], []); merged.get(comm[a]).push(...x) })
    nodes = [...merged.values()]
  }
}

// One clustering of the rules (indices into info).
function partition(info, S1, S2, cap, rnd, jitter = 1) {
  const all = info.map((_, i) => i)
  const level1 = louvain(S1, all.map(i => [i]), GAMMA1 * jitter, 'cpm', rnd)
  let groups = louvain(S2, level1, GAMMA2 * jitter, 'mod', rnd)
  // Split what is too big, at rising resolutions.
  const out = []
  const queue = [...groups]
  while (queue.length) {
    const g = queue.pop()
    if (g.length < 2 || shapesOf(info, g) <= cap) { out.push(g); continue }
    let gamma = GAMMA2, parts = [g]
    while (parts.length < 2 && gamma < 40) { gamma *= 1.6; parts = louvain(S2, g.map(i => [i]), gamma, 'mod', rnd) }
    if (parts.length < 2) {
      // Nothing splits it (one table with many columns): halves in rule order.
      const half = Math.ceil(g.length / 2)
      parts = [g.slice(0, half), g.slice(half)]
    }
    queue.push(...parts)
  }
  // Merge the pair attracting most while that raises modularity (at a lower
  // resolution, MERGE_GAMMA) and the union stays under the cap.
  groups = out
  const N = info.length
  const deg = new Float64Array(N); let m2 = 0
  for (let i = 0; i < N; i++) { let d = 0; for (let j = 0; j < N; j++) d += S2[i][j]; deg[i] = d; m2 += d }
  if (!m2) m2 = 1
  const kOf = (g) => g.reduce((t, i) => t + deg[i], 0)
  for (;;) {
    let best = null, bs = 0
    for (let x = 0; x < groups.length; x++) for (let y = x + 1; y < groups.length; y++) {
      let s = 0
      for (const i of groups[x]) { const row = S2[i]; for (const j of groups[y]) s += row[j] }
      if (!s) continue
      const gain = 2 * s - MERGE_GAMMA * jitter * 2 * kOf(groups[x]) * kOf(groups[y]) / m2
      if (gain > bs && shapesOf(info, [...groups[x], ...groups[y]]) <= cap) { bs = gain; best = [x, y] }
    }
    if (!best) break
    groups[best[0]] = [...groups[best[0]], ...groups[best[1]]]
    groups.splice(best[1], 1)
  }
  // A small group (a lookup table, say) joins the group it links to most.
  const small = (g) => g.length <= SMALL_RULES || shapesOf(info, g) <= SMALL_SHAPES
  for (let x = groups.length - 1; x >= 0; x--) {
    if (!small(groups[x])) continue
    let best = -1, bs = 0
    groups.forEach((h, y) => {
      if (y === x) return
      let s = 0
      for (const i of groups[x]) { const row = S2[i]; for (const j of h) s += row[j] }
      if (s > bs && shapesOf(info, [...groups[x], ...h]) <= cap) { bs = s; best = y }
    })
    if (best < 0) continue
    groups[best] = [...groups[best], ...groups[x]]
    groups.splice(x, 1)
  }
  return groups.map(g => g.sort((a, b) => a - b))
}

// A name from the entity types (or tables) the group's rules name most.
function groupName(state, mapping, info, g) {
  const types = new Map(state.objectTypes.map(o => [o.id, o]))
  const count = new Map()
  for (const i of g) {
    for (const side of ['target', 'source']) {
      for (const id of new Set(info[i][side])) {
        const t = types.get(id)
        if (t?.kind !== 'entity') continue
        // The target side names first; the source side counts a little less.
        count.set(id, (count.get(id) ?? 0) + (side === 'target' ? 1 : 0.9))
      }
    }
  }
  const top = [...count].sort((a, b) => b[1] - a[1])
  if (!top.length) return 'Rules'
  const names = [], seen = new Set()
  for (const [id, n] of top) {
    const name = types.get(id).name
    const key = singular(name.toLowerCase().replace(/[^a-z0-9]/g, ''))
    if (seen.has(key)) continue
    if (names.length && n < top[0][1] / 3) break
    seen.add(key); names.push(name)
    if (names.length === 3) break
  }
  return names.join(', ')
}

export function clusterRules(state, mapping, { ruleIds = null, cap = DEFAULT_CAP, runs = 8 } = {}) {
  const rules = mapping.rules.filter(r => !ruleIds || ruleIds.includes(r.id))
  if (!rules.length) return { groups: [], unsure: new Map() }
  const info = ruleInfo(state, mapping, rules)
  const { S1, S2 } = similarities(info)
  const main = partition(info, S1, S2, cap, random(1))
  // Stability: how often each rule shares a group with its mates.
  const N = info.length
  const co = Array.from({ length: N }, () => new Float32Array(N))
  for (let r = 0; r < runs; r++) {
    const jitter = runs > 1 ? 0.8 + 0.45 * r / (runs - 1) : 1
    for (const g of partition(info, S1, S2, cap, random(101 + r), jitter)) for (const i of g) for (const j of g) co[i][j] += 1 / runs
  }
  const groupOf = new Array(N)
  main.forEach((g, k) => g.forEach(i => { groupOf[i] = k }))
  const unsure = new Map()
  const stability = new Float64Array(N).fill(1)
  for (let i = 0; i < N; i++) {
    const mates = main[groupOf[i]].filter(j => j !== i)
    if (!mates.length || runs < 2) continue
    const score = mates.reduce((t, j) => t + co[i][j], 0) / mates.length
    stability[i] = score
    if (score >= UNSURE) continue
    let alt = null, as = score
    main.forEach((g, k) => {
      if (k === groupOf[i]) return
      const s = g.reduce((t, j) => t + co[i][j], 0) / g.length
      if (s > as) { as = s; alt = k }
    })
    // Unsure only when another group holds it more often than its own.
    if (alt != null) unsure.set(info[i].id, { score, alt })
  }
  const groups = main.map((g, k) => ({
    id: `g${k}`, name: groupName(state, mapping, info, g), ruleIds: g.map(i => info[i].id), shapes: shapesOf(info, g),
    stability: g.reduce((t, i) => t + stability[i], 0) / g.length,
  }))
  // Biggest first; unsure.alt as group ids.
  const order = groups.map((g, k) => k).sort((a, b) => groups[b].ruleIds.length - groups[a].ruleIds.length)
  for (const u of unsure.values()) u.alt = u.alt == null ? null : groups[u.alt].id
  return { groups: order.map(k => groups[k]), unsure, info }
}
