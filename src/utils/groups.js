// Element groups, as NORMA's: a named set of schema elements with its own
// definition and note. A group carries no logic. It can colour its members on
// the diagram, with NORMA's colour roles, each optional: outline, fill and
// text of a shape, the role boxes of a fact type (graphics), readings, role
// names and the text of a note without a fill (floating), constraints
// (constraint, deontic) and the lines from roles to their players
// (connector). When an element is in several colouring groups, the group with
// the highest priority sets each colour, and on a tie the group listed first.
//
// Members are element ids: object types, fact types, single roles (role.id),
// subtypes, external constraints, notes, and the internal constraints of a
// fact type: uniqueness (uniqueness[i].id), frequency (internalFrequency[i].id)
// and simple mandatory (role.mandatoryId).

import { uid } from '../store/storeHelpers'

export const COLOR_CHANNELS = ['outline', 'fill', 'text', 'graphics', 'floating', 'constraint', 'deontic', 'connector']

export const mkGroup = (name = 'Group') => ({
  id: uid(), name, definition: '', note: '', priority: 0, colors: {}, members: [],
})

// id → { outline?, fill?, text? }, cached per groups array.
const styleCache = new WeakMap()
export function groupStyles(groups) {
  if (!groups?.length) return EMPTY_MAP
  let map = styleCache.get(groups)
  if (map) return map
  map = new Map()
  const ranked = groups
    .map((g, i) => ({ g, i }))
    .filter(({ g }) => COLOR_CHANNELS.some(ch => g.colors?.[ch]))
    .sort((a, b) => (b.g.priority ?? 0) - (a.g.priority ?? 0) || a.i - b.i)
  for (const { g } of ranked) {
    for (const id of g.members) {
      const st = map.get(id) ?? {}
      for (const ch of COLOR_CHANNELS) if (g.colors[ch] && st[ch] == null) st[ch] = g.colors[ch]
      map.set(id, st)
    }
  }
  styleCache.set(groups, map)
  return map
}
const EMPTY_MAP = new Map()

export const groupStyle = (groups, id) => groupStyles(groups).get(id)

// What a member id stands for, with a label for lists. null when the element
// no longer exists.
export function describeMember(id, state) {
  const ot = state.objectTypes.find(o => o.id === id)
  if (ot) return { kind: ot.kind === 'value' ? 'value' : 'entity', label: ot.name || '(unnamed)' }
  const f = state.facts.find(x => x.id === id)
  if (f) return { kind: 'fact', label: factLabel(f, state) }
  for (const fact of state.facts) {
    const ui = (fact.uniqueness ?? []).findIndex(u => u.id === id)
    if (ui >= 0) return { kind: 'uniqueness', factId: fact.id, uIndex: ui,
      label: `Uniqueness on ${roleNumbers(fact.uniqueness[ui].roles)} in ${factLabel(fact, state)}` }
    const fq = (fact.internalFrequency ?? []).find(x => x.id === id)
    if (fq) return { kind: 'frequency', factId: fact.id, ifId: id,
      label: `Frequency on ${roleNumbers(fq.roles)} in ${factLabel(fact, state)}` }
    const mi = fact.roles.findIndex(r => r.mandatory && r.mandatoryId === id)
    if (mi >= 0) return { kind: 'mandatory', factId: fact.id, roleIndex: mi,
      label: `Mandatory role ${mi + 1} in ${factLabel(fact, state)}` }
    const ri = fact.roles.findIndex(r => r.id === id)
    if (ri < 0) continue
    const r = fact.roles[ri]
    const player = state.objectTypes.find(o => o.id === r.objectTypeId)?.name
      ?? state.facts.find(x => x.id === r.objectTypeId)?.objectifiedName
    const name = r.roleName ? `[${r.roleName}]` : `role ${ri + 1}`
    return { kind: 'role', factId: fact.id, roleIndex: ri,
      label: `${name}${player ? ` of ${player}` : ''} in ${factLabel(fact, state)}` }
  }
  const st = state.subtypes.find(s => s.id === id)
  if (st) {
    const nm = x => state.objectTypes.find(o => o.id === x)?.name ?? state.facts.find(f => f.id === x)?.objectifiedName ?? '?'
    return { kind: 'subtype', label: `${nm(st.subId)} ⊂ ${nm(st.superId)}` }
  }
  const c = state.constraints.find(x => x.id === id)
  if (c) return { kind: 'constraint', label: c.constraintType }
  for (const d of state.diagrams) {
    const n = (d.notes ?? []).find(x => x.id === id)
    if (n) return { kind: 'note', diagramId: d.id,
      label: `Note: ${(n.text || '').split('\n')[0].slice(0, 40) || '(empty)'}` }
  }
  return null
}

const roleNumbers = rs => (rs.length === 1 ? 'role ' : 'roles ') + [...rs].sort((a, b) => a - b).map(i => i + 1).join(', ')

function factLabel(f, state) {
  if (f.objectifiedName) return `“${f.objectifiedName}”`
  const parts = f.readingParts ?? []
  const names = f.roles.map(r => state.objectTypes.find(o => o.id === r.objectTypeId)?.name
    ?? state.facts.find(x => x.id === r.objectTypeId)?.objectifiedName ?? '?')
  if (!parts.some(p => p?.trim())) return names.join(' / ')
  let s = ''
  for (let i = 0; i <= names.length; i++) {
    if (parts[i]?.trim()) s += ` ${parts[i].trim()}`
    if (i < names.length) s += ` ${names[i]}`
  }
  return s.trim()
}

// The ids that can be group members.
export function memberIdSet(state) {
  const ids = new Set()
  for (const o of state.objectTypes) ids.add(o.id)
  for (const f of state.facts) {
    ids.add(f.id)
    for (const r of f.roles) { ids.add(r.id); if (r.mandatory && r.mandatoryId) ids.add(r.mandatoryId) }
    for (const u of f.uniqueness ?? []) ids.add(u.id)
    for (const x of f.internalFrequency ?? []) ids.add(x.id)
  }
  for (const s of state.subtypes) ids.add(s.id)
  for (const c of state.constraints) ids.add(c.id)
  for (const d of state.diagrams) for (const n of d.notes ?? []) ids.add(n.id)
  return ids
}

// Drops members whose element is gone; returns the same array when nothing changed.
export function pruneGroups(groups, state) {
  if (!groups?.length) return groups ?? []
  const ids = memberIdSet(state)
  let changed = false
  const out = groups.map(g => {
    const members = g.members.filter(id => ids.has(id))
    if (members.length === g.members.length) return g
    changed = true
    return { ...g, members }
  })
  return changed ? out : groups
}

export function loadGroups(raw) {
  if (!Array.isArray(raw)) return []
  return raw.filter(g => g && typeof g.id === 'string').map(g => ({
    id: g.id,
    name: typeof g.name === 'string' ? g.name : '',
    definition: typeof g.definition === 'string' ? g.definition : '',
    note: typeof g.note === 'string' ? g.note : '',
    priority: Number.isFinite(g.priority) ? g.priority : 0,
    colors: Object.fromEntries(COLOR_CHANNELS
      .filter(ch => typeof g.colors?.[ch] === 'string' && g.colors[ch])
      .map(ch => [ch, g.colors[ch]])),
    members: Array.isArray(g.members) ? [...new Set(g.members.filter(m => typeof m === 'string'))] : [],
  }))
}
