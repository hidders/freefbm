import { mkSchema, mkDiagram, SCHEMA_PROFILES, activeSchemaIdOf } from '../storeHelpers'
import { importPostgresDdl } from '../../relational/ddlImport.js'
import { exportPostgresDdl } from '../../relational/ddlExport.js'
import { guessOrmSchema } from '../../relational/guessOrm.js'
import { generateRelational } from '../../relational/rmap.js'
import { runMapping, withRunApplied } from '../../mapping/runMapping.js'

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
    // Mappings to or from the schema go too, with their diagrams.
    const goneMappings = new Set((s.mappings ?? []).filter(m => m.sourceSchemaId === id || m.targetSchemaId === id).map(m => m.id))
    const dropped = d => owned(d) || goneMappings.has(d.mappingId)
    if (dropped(s.diagrams.find(d => d.id === s.activeDiagramId) ?? {})) {
      const target = s.diagrams.find(d => !dropped(d) && !d.mappingId)
      if (target) get().setActiveDiagram(target.id)
    }
    set(st => ({
      schemas: st.schemas.filter(x => x.id !== id), diagrams: st.diagrams.filter(d => !dropped(d)),
      mappings: (st.mappings ?? []).filter(m => !goneMappings.has(m.id)),
      isDirty: true,
    }))
    return true
  },

  // Reads PostgreSQL DDL into a new relational schema of this file, with one
  // diagram of its tables, as a single undo step. The import log lists what
  // was left out. Returns { schemaId, stats }.
  importPostgresDdl(sql, name = 'Relational') {
    const used = new Set(get().schemas.map(s => s.name))
    let unique = name
    for (let i = 2; used.has(unique); i++) unique = `${name} ${i}`
    const schema = mkSchema(unique, 'relational')
    const built = importPostgresDdl(sql, { schemaId: schema.id, diagramName: 'Tables' })
    set(s => ({ historyBatch: (s.historyBatch ?? 0) + 1 }))
    try {
      set(s => ({
        schemas: [...s.schemas, schema],
        objectTypes: [...s.objectTypes, ...built.objectTypes],
        facts: [...s.facts, ...built.facts],
        constraints: [...s.constraints, ...built.constraints],
        diagrams: [...s.diagrams, built.diagram],
        // The rows of INSERT statements, as sample population.
        populations: { ...s.populations, ...built.sample.populations },
        factPopulations: { ...s.factPopulations, ...built.sample.factPopulations },
        isDirty: true,
      }))
      get().setActiveDiagram(built.diagram.id)
      // The queries FreeFBM builds when a constraint is drawn.
      for (const c of built.constraints) get()._tryAutoGenerateQuery(c.id)
    } finally {
      set(s => ({ historyBatch: Math.max(0, (s.historyBatch ?? 1) - 1) }))
    }
    const st = built.stats
    get().setImportLog({ kind: 'ddl', source: `${name} (PostgreSQL DDL)`, entries: [
      { level: 'note', text: `Read ${st.tables} tables with ${st.columns} columns into schema ${unique}: ${st.valueTypes} value types, ${st.keys} keys, ${st.foreignKeys} foreign keys` },
      ...built.log,
      ...built.sample.log,
    ] })
    return { schemaId: schema.id, stats: st }
  },

  // Guesses an ORM2 schema from a relational one (workbench step 9): a new
  // ORM2 schema with one diagram, and the mapping from the relational schema
  // to it, as one undo step. surrogates: { tableId: 'keep' | 'drop' } overrides
  // the default per table. Returns { schemaId, mappingId, stats }.
  guessOrmFromRelational(relSchemaId, { surrogates = {} } = {}) {
    const st = get()
    const rel = st.schemas.find(x => x.id === relSchemaId)
    if (!rel) return null
    const used = new Set(st.schemas.map(x => x.name))
    let unique = `${rel.name} (ORM2)`
    for (let i = 2; used.has(unique); i++) unique = `${rel.name} (ORM2) ${i}`
    const schema = mkSchema(unique, 'orm2')
    const built = guessOrmSchema(st, relSchemaId, { schemaId: schema.id, surrogates, mappingName: `${rel.name} to ${unique}` })
    set(s => ({ historyBatch: (s.historyBatch ?? 0) + 1 }))
    try {
      set(s => ({
        schemas: [...s.schemas, schema],
        objectTypes: [...s.objectTypes, ...built.objectTypes],
        facts: [...s.facts, ...built.facts],
        subtypes: [...s.subtypes, ...built.subtypes],
        constraints: [...s.constraints, ...built.constraints],
        diagrams: [...s.diagrams, built.diagram],
        mappings: [...(s.mappings ?? []), built.mapping],
        isDirty: true,
      }))
      get().setActiveDiagram(built.diagram.id)
      for (const c of built.constraints) get()._tryAutoGenerateQuery(c.id)
    } finally {
      set(s => ({ historyBatch: Math.max(0, (s.historyBatch ?? 1) - 1) }))
    }
    const n = built.stats
    get().setImportLog({ kind: 'guess', source: `${rel.name} (guessed ORM2 schema)`, entries: [
      { level: 'note', text: `Schema ${unique}: ${n.entityTypes} entity types, ${n.valueTypes} value types, ${n.factTypes} fact types${n.subtypes ? `, ${n.subtypes} subtypes` : ''}; ${n.junctions} junction tables became fact types${n.dropped ? `; ${n.dropped} surrogate keys dropped` : ''}` },
      { level: 'note', text: `Mapping ${built.mapping.name}: ${n.rules} rules (Mappings tab: Run →, Round trip)` },
      ...built.log,
    ] })
    const svg = typeof document !== 'undefined' ? document.querySelector('.canvas-bg')?.closest('svg') : null
    const r = svg?.getBoundingClientRect()
    get().fitToContent?.(r?.width || 1200, r?.height || 700)
    return { schemaId: schema.id, mappingId: built.mapping.id, stats: n }
  },

  // Generates a relational schema from an ORM2 one (workbench step 13,
  // relational/rmap.js): a new relational schema with one diagram of its
  // tables, and the mapping from the ORM2 schema to it, as one undo step. The
  // ORM2 schema's population, if any, is carried over by running the mapping.
  // surrogates: 'never' | 'composite' | 'always'; overrides: { typeId: bool }.
  // Returns { schemaId, mappingId, sql }.
  generateRelationalFromOrm(ormSchemaId, { surrogates = 'never', overrides = {} } = {}) {
    const st = get()
    const orm = st.schemas.find(x => x.id === ormSchemaId)
    if (!orm) return null
    const used = new Set(st.schemas.map(x => x.name))
    let unique = `${orm.name} (SQL)`
    for (let i = 2; used.has(unique); i++) unique = `${orm.name} (SQL) ${i}`
    const schema = mkSchema(unique, 'relational')
    const g = generateRelational(st, ormSchemaId, { schemaId: schema.id, surrogates, overrides, mappingName: `${orm.name} to ${unique}`, schemaName: orm.name })
    const built = g.built
    if (built.diagram) built.diagram.profileId = built.diagram.profileId ?? RELATIONAL_DATATYPES
    let carried = null
    set(s => ({ historyBatch: (s.historyBatch ?? 0) + 1 }))
    try {
      set(s => ({
        schemas: [...s.schemas, schema],
        objectTypes: [...s.objectTypes, ...built.objectTypes],
        facts: [...s.facts, ...built.facts],
        constraints: [...s.constraints, ...built.constraints],
        diagrams: [...s.diagrams, built.diagram],
        mappings: [...(s.mappings ?? []), g.mapping],
        isDirty: true,
      }))
      get().setActiveDiagram(built.diagram.id)
      for (const c of built.constraints) get()._tryAutoGenerateQuery(c.id)
      // The sample population, carried over.
      const now = get()
      const ormIds = new Set([...now.objectTypes, ...now.facts].filter(x => x.schemaId === ormSchemaId).map(x => x.id))
      const hasPop = [...ormIds].some(id => now.populations?.[id]?.length || now.factPopulations?.[id]?.length)
      if (hasPop) {
        try {
          const run = runMapping(now, g.mapping, 'forward')
          set(s => ({ ...withRunApplied(s, run) }))
          const rows = built.objectTypes.filter(o => o.kind === 'entity').reduce((n, o) => n + (run.populations?.[o.id]?.length ?? 0), 0)
          carried = { rows, problems: run.log.filter(l => l.level !== 'note') }
        } catch (err) {
          carried = { rows: 0, problems: [{ level: 'warn', text: `The population was not carried over: ${err?.message ?? err}` }] }
        }
      }
    } finally {
      set(s => ({ historyBatch: Math.max(0, (s.historyBatch ?? 1) - 1) }))
    }
    const n = built.stats ?? {}
    get().setImportLog({ kind: 'generate', source: `${orm.name}`, entries: [
      { level: 'note', text: `Schema ${unique}: ${n.tables ?? '?'} tables with ${n.columns ?? '?'} columns, ${n.keys ?? 0} keys, ${n.foreignKeys ?? 0} foreign keys (File › Export PostgreSQL DDL… writes them)` },
      { level: 'note', text: `Mapping ${g.mapping.name}: ${g.mapping.rules.length} rules. Accounting in the Mappings tab lists the constraints the tables don't enforce` },
      ...(carried ? [{ level: 'note', text: `Carried the population over by running the mapping: ${carried.rows} rows` }, ...carried.problems.slice(0, 20).map(l => ({ level: 'warn', text: l.text }))] : []),
      ...g.log.filter(l => !/^\d+ tables:/.test(l.text)),
    ] })
    const svg = typeof document !== 'undefined' ? document.querySelector('.canvas-bg')?.closest('svg') : null
    const r = svg?.getBoundingClientRect()
    get().fitToContent?.(r?.width || 1200, r?.height || 700)
    return { schemaId: schema.id, mappingId: g.mapping.id, sql: g.sql }
  },

  // The active relational schema as PostgreSQL DDL: { sql, warnings }.
  exportPostgresDdl(schemaId = activeSchemaIdOf(get())) {
    return exportPostgresDdl(get(), schemaId)
  },

  // Activates the schema by switching to its first diagram.
  setActiveSchema(id) {
    const s = get()
    const cur = s.diagrams.find(d => d.id === s.activeDiagramId)
    if (activeSchemaIdOf(s) === id && !cur?.mappingId) return
    const target = s.diagrams.find(d => d.schemaId === id && !d.mappingId)
    if (target) get().setActiveDiagram(target.id)
  },
})
