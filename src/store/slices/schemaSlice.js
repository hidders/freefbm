import { mkSchema, mkDiagram, SCHEMA_PROFILES, activeSchemaIdOf } from '../storeHelpers'

// Several schemas in one file (workbench plan, step 2). The schemas are listed
// in `schemas`; elements and diagrams point to theirs with `schemaId`. The
// active schema is the schema of the active diagram, so switching schema means
// switching to one of its diagrams.
// The datatype profile a relational schema's diagrams start with.
const RELATIONAL_DATATYPES = 'postgresql'

export const createSchemaSlice = (set, get) => ({

  // Adds a schema with one empty diagram and makes it active. Returns its id.
  addSchema(name = 'Schema', profile = 'orm2') {
    const used = new Set(get().schemas.map(s => s.name))
    let unique = name
    for (let i = 2; used.has(unique); i++) unique = `${name} ${i}`
    const schema = mkSchema(unique, SCHEMA_PROFILES.includes(profile) ? profile : 'orm2')
    const d = mkDiagram('Main', schema.id)
    if (schema.profile === 'relational') d.profileId = RELATIONAL_DATATYPES
    set(s => ({ schemas: [...s.schemas, schema], diagrams: [...s.diagrams, d], isDirty: true }))
    get().setActiveDiagram(d.id)
    return schema.id
  },

  renameSchema(id, name) {
    const trimmed = (name ?? '').trim()
    if (!trimmed) return
    set(s => ({ schemas: s.schemas.map(x => x.id === id ? { ...x, name: trimmed } : x), isDirty: true }))
  },

  setSchemaProfile(id, profile) {
    if (!SCHEMA_PROFILES.includes(profile)) return
    // A schema made relational gets PostgreSQL datatypes on its diagrams that
    // have no datatype profile yet.
    set(s => ({
      schemas: s.schemas.map(x => x.id === id ? { ...x, profile } : x),
      diagrams: profile !== 'relational' ? s.diagrams : s.diagrams.map(d =>
        d.schemaId === id && !d.profileId ? { ...d, profileId: RELATIONAL_DATATYPES } : d),
      isDirty: true,
    }))
  },

  // Removes a schema that holds no elements, with its diagrams. Returns false
  // (and changes nothing) for the last schema or one that still has elements:
  // deleting a schema's contents is left to the ordinary delete commands.
  deleteSchema(id) {
    const s = get()
    if (s.schemas.length <= 1 || !s.schemas.some(x => x.id === id)) return false
    const owned = x => x.schemaId === id
    if (s.objectTypes.some(owned) || s.facts.some(owned) || s.subtypes.some(owned) || s.constraints.some(owned)) return false
    // Leave the schema first if it is active, so the active diagram never dangles.
    if (activeSchemaIdOf(s) === id) {
      const target = s.diagrams.find(d => !owned(d))
      if (target) get().setActiveDiagram(target.id)
    }
    set(st => ({ schemas: st.schemas.filter(x => x.id !== id), diagrams: st.diagrams.filter(d => !owned(d)), isDirty: true }))
    return true
  },

  // Activates the schema by switching to its first diagram.
  setActiveSchema(id) {
    const s = get()
    if (activeSchemaIdOf(s) === id) return
    const target = s.diagrams.find(d => d.schemaId === id)
    if (target) get().setActiveDiagram(target.id)
  },
})
