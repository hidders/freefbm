// Custom properties, as NORMA's extension properties: the model declares
// property definitions once (name, category, type, default, which kinds of
// element they apply to) and each element stores values in `properties`,
// keyed by definition id. Values are strings; a missing value means the
// definition's default.

import { uid } from '../store/storeHelpers'

export const PROPERTY_TYPES = [
  { id: 'string',  label: 'Text' },
  { id: 'number',  label: 'Number' },
  { id: 'boolean', label: 'Yes/no' },
  { id: 'date',    label: 'Date' },
  { id: 'enum',    label: 'List of choices' },
]

export const PROPERTY_KINDS = [
  { id: 'entity',     label: 'Entity types' },
  { id: 'value',      label: 'Value types' },
  { id: 'fact',       label: 'Fact types' },
  { id: 'role',       label: 'Roles' },
  { id: 'subtype',    label: 'Subtypes' },
  { id: 'constraint', label: 'Constraints' },
  { id: 'group',      label: 'Groups' },
  { id: 'note',       label: 'Notes' },
]
const ALL_KINDS = PROPERTY_KINDS.map(k => k.id)

export const mkPropertyDefinition = (name = 'Property') => ({
  id: uid(), name, category: '', description: '', type: 'string',
  options: [], default: '', appliesTo: [...ALL_KINDS],
})

export const definitionsFor = (defs, kind) =>
  (defs ?? []).filter(d => (d.appliesTo ?? ALL_KINDS).includes(kind))

// Whether a stored value fits its definition's type.
export function validPropertyValue(def, v) {
  if (v == null || v === '') return true
  switch (def.type) {
    case 'number':  return v.trim() !== '' && Number.isFinite(Number(v))
    case 'boolean': return v === 'true' || v === 'false'
    case 'date':    return /^\d{4}-\d{2}-\d{2}$/.test(v) && !isNaN(Date.parse(v))
    case 'enum':    return (def.options ?? []).includes(v)
    default:        return true
  }
}

// properties with defId set to value; an empty value removes it.
export function withProperty(properties, defId, value) {
  const next = { ...(properties ?? {}) }
  if (value == null || value === '') delete next[defId]
  else next[defId] = value
  return Object.keys(next).length ? next : undefined
}

const dropKey = (el, defId) => {
  if (!el.properties || !(defId in el.properties)) return el
  const { [defId]: _, ...rest } = el.properties
  return { ...el, properties: Object.keys(rest).length ? rest : undefined }
}

// The model without any values for the definition defId.
export function dropPropertyValues(state, defId) {
  return {
    objectTypes: state.objectTypes.map(o => dropKey(o, defId)),
    facts: state.facts.map(f => {
      const roles = f.roles.map(r => dropKey(r, defId))
      const g = dropKey(f, defId)
      return roles.some((r, i) => r !== f.roles[i]) ? { ...g, roles } : g
    }),
    subtypes: state.subtypes.map(s => dropKey(s, defId)),
    constraints: state.constraints.map(c => dropKey(c, defId)),
    groups: state.groups.map(g => dropKey(g, defId)),
    diagrams: state.diagrams.map(d => d.notes?.some(n => n.properties?.[defId] != null)
      ? { ...d, notes: d.notes.map(n => dropKey(n, defId)) } : d),
  }
}

export function loadPropertyDefinitions(raw) {
  if (!Array.isArray(raw)) return []
  const types = new Set(PROPERTY_TYPES.map(t => t.id))
  return raw.filter(d => d && typeof d.id === 'string').map(d => ({
    id: d.id,
    name: typeof d.name === 'string' ? d.name : '',
    category: typeof d.category === 'string' ? d.category : '',
    description: typeof d.description === 'string' ? d.description : '',
    type: types.has(d.type) ? d.type : 'string',
    options: Array.isArray(d.options) ? d.options.filter(o => typeof o === 'string') : [],
    default: typeof d.default === 'string' ? d.default : '',
    appliesTo: Array.isArray(d.appliesTo) ? d.appliesTo.filter(k => ALL_KINDS.includes(k)) : [...ALL_KINDS],
  }))
}
