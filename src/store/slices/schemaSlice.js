import { mkSchema, mkDiagram, SCHEMA_PROFILES, activeSchemaIdOf } from '../storeHelpers'
import { importPostgresDdl, samplePopulation } from '../../relational/ddlImport.js'
import { parseDdl } from '../../relational/ddlParse.js'
import { exportPostgresDdl } from '../../relational/ddlExport.js'
import { guessOrmSchema } from '../../relational/guessOrm.js'
import { generateRelational } from '../../relational/rmap.js'
import { runMapping, withRunApplied } from '../../mapping/runMapping.js'
import { carryLost } from './mappingSlice.js'

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

  // A relational schema's logical view: its ORM2 form in every panel and
  // diagram instead of tables (Advanced mode only; relational/face.js). A view
  // setting for this session: not saved, not undone.
  setSchemaLogicalView(id, on) {
    set(s => {
      const { [id]: _, ...rest } = s.logicalViews ?? {}
      return { logicalViews: on ? { ...rest, [id]: true } : rest }
    })
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

  // Removes a schema with its diagrams, and the mappings to or from it with
  // theirs. Without withContents only an empty schema goes; with it, its
  // elements, their sample population and group memberships go too. One undo
  // step. Returns false (and changes nothing) for the last schema.
  deleteSchema(id, { withContents = false } = {}) {
    const s = get()
    if (s.schemas.length <= 1 || !s.schemas.some(x => x.id === id)) return false
    const owned = x => x.schemaId === id
    if (!withContents && (s.objectTypes.some(owned) || s.facts.some(owned) || s.subtypes.some(owned) || s.constraints.some(owned))) return false
    const goneMappings = new Set([...(s.mappings ?? []), ...(s.views ?? [])].filter(m => m.sourceSchemaId === id || m.targetSchemaId === id).map(m => m.id))
    const dropped = d => owned(d) || goneMappings.has(d.mappingId)
    // Everything a group or a population may name.
    const gone = new Set()
    for (const o of s.objectTypes.filter(owned)) gone.add(o.id)
    for (const f of s.facts.filter(owned)) {
      gone.add(f.id)
      for (const r of f.roles ?? []) gone.add(r.id)
      for (const u of f.uniqueness ?? []) if (u?.id) gone.add(u.id)
      for (const r of f.roles ?? []) if (r.mandatoryId) gone.add(r.mandatoryId)
    }
    for (const x of [...s.subtypes.filter(owned), ...s.constraints.filter(owned)]) gone.add(x.id)
    for (const d of s.diagrams.filter(dropped)) for (const n of d.notes ?? []) gone.add(n.id)
    const keep = (obj) => Object.fromEntries(Object.entries(obj ?? {}).filter(([k]) => !gone.has(k)))
    set(st => ({ historyBatch: (st.historyBatch ?? 0) + 1 }))
    try {
      // Leave the schema first if it is active, so the active diagram never dangles.
      if (dropped(s.diagrams.find(d => d.id === s.activeDiagramId) ?? {})) {
        const target = s.diagrams.find(d => !dropped(d) && !d.mappingId)
        if (target) get().setActiveDiagram(target.id)
      }
      set(st => ({
        schemas: st.schemas.filter(x => x.id !== id), diagrams: st.diagrams.filter(d => !dropped(d)),
        mappings: (st.mappings ?? []).filter(m => !goneMappings.has(m.id)),
        views: (st.views ?? []).filter(v => v.sourceSchemaId !== id && v.targetSchemaId !== id),
        ...(gone.size ? {
          objectTypes: st.objectTypes.filter(x => !owned(x)), facts: st.facts.filter(x => !owned(x)),
          subtypes: st.subtypes.filter(x => !owned(x)), constraints: st.constraints.filter(x => !owned(x)),
          groups: (st.groups ?? []).map(g => ({ ...g, members: (g.members ?? []).filter(m => !gone.has(m)) })),
          populations: keep(st.populations), factPopulations: keep(st.factPopulations),
          subtypeMappings: keep(st.subtypeMappings), nestedEntityMappings: keep(st.nestedEntityMappings),
          selectedId: gone.has(st.selectedId) ? null : st.selectedId,
        } : {}),
        mappingAccounting: Object.fromEntries(Object.entries(st.mappingAccounting ?? {}).filter(([k]) => !goneMappings.has(k))),
        mappingEquivalence: Object.fromEntries(Object.entries(st.mappingEquivalence ?? {}).filter(([k]) => !goneMappings.has(k))),
        mappingRuleEditor: goneMappings.has(st.mappingRuleEditor?.mappingId) ? null : st.mappingRuleEditor,
        isDirty: true,
      }))
    } finally {
      set(st => ({ historyBatch: Math.max(0, (st.historyBatch ?? 1) - 1) }))
    }
    return true
  },

  // Reads PostgreSQL DDL into a new relational schema of this file, with one
  // diagram of its tables (and one per SQL schema when the script has several
  // namespaces), as a single undo step. The import log lists what
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
        diagrams: [...s.diagrams, ...built.diagrams],
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
      { level: 'note', text: `Read ${st.tables} tables with ${st.columns} columns into schema ${unique}: ${st.valueTypes} value types, ${st.keys} keys, ${st.foreignKeys} foreign keys${st.comparisons ? `, ${st.comparisons} value comparison${st.comparisons === 1 ? '' : 's'}` : ''}${st.checks ? `, ${st.checks} CHECK constraint${st.checks === 1 ? '' : 's'} as formula constraints` : ''}` },
      ...built.log,
      ...built.sample.log,
    ] })
    return { schemaId: schema.id, stats: st }
  },

  // The rows of a SQL script's INSERT statements and COPY blocks as the
  // population of a relational schema (replacing the population it had), as
  // one undo step. Returns { rows }.
  loadSampleRows(schemaId, sql, name = 'SQL script') {
    const st = get()
    const inSchema = (x) => x.schemaId === schemaId
    const built = { objectTypes: st.objectTypes.filter(inSchema), facts: st.facts.filter(inSchema), constraints: st.constraints.filter(inSchema) }
    const parsed = parseDdl(sql)
    const sample = samplePopulation(parsed, built)
    const ids = new Set([...built.objectTypes, ...built.facts].map(x => x.id))
    const keep = (pops) => Object.fromEntries(Object.entries(pops ?? {}).filter(([k]) => !ids.has(k)))
    set(s => ({
      populations: { ...keep(s.populations), ...sample.populations },
      factPopulations: { ...keep(s.factPopulations), ...sample.factPopulations },
      isDirty: true,
    }))
    const schema = st.schemas.find(x => x.id === schemaId)
    get().setImportLog({ kind: 'ddl', source: `${name} (sample rows)`, entries: [
      ...(sample.rows ? [] : [{ level: 'warn', text: `No rows of ${schema?.name ?? 'the schema'}'s tables in ${name} (INSERT … VALUES or COPY … FROM stdin)` }]),
      ...sample.log,
    ] })
    return { rows: sample.rows }
  },

  // Guesses an ORM2 schema from a relational one (workbench step 9): a new
  // ORM2 schema with one diagram, and the mapping from the relational schema
  // to it, as one undo step. surrogates: { tableId: 'keep' | 'drop' } overrides
  // the default per table. With diagrams, each diagram of the relational
  // schema gets a twin in the new one (carrySchemaDiagrams), laid out by
  // layout. Returns { schemaId, mappingId, stats }.
  guessOrmFromRelational(relSchemaId, { surrogates = {}, diagrams = true, layout = null } = {}) {
    const st = get()
    const rel = st.schemas.find(x => x.id === relSchemaId)
    if (!rel) return null
    const used = new Set(st.schemas.map(x => x.name))
    let unique = `${rel.name} (ORM2)`
    for (let i = 2; used.has(unique); i++) unique = `${rel.name} (ORM2) ${i}`
    const schema = mkSchema(unique, 'orm2')
    const built = guessOrmSchema(st, relSchemaId, { schemaId: schema.id, surrogates, mappingName: `${rel.name} to ${unique}` })
    let carried = []
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
      if (diagrams) carried = get().carrySchemaDiagrams(built.mapping.id, relSchemaId, built.diagram.id, { layout })
    } finally {
      set(s => ({ historyBatch: Math.max(0, (s.historyBatch ?? 1) - 1) }))
    }
    const n = built.stats
    get().setImportLog({ kind: 'guess', source: `${rel.name} (guessed ORM2 schema)`, entries: [
      { level: 'note', text: `Schema ${unique}: ${n.entityTypes} entity types, ${n.valueTypes} value types, ${n.factTypes} fact types${n.subtypes ? `, ${n.subtypes} subtypes` : ''}; ${n.junctions} junction tables became fact types${n.flags ? `; ${n.flags} boolean columns became unary fact types` : ''}${n.dropped ? `; ${n.dropped} surrogate keys dropped` : ''}` },
      { level: 'note', text: `Mapping ${built.mapping.name}: ${n.rules} rules (Mappings tab: Run →, Round trip)` },
      ...(carried.length ? [{ level: 'note', text: `Diagrams of ${rel.name} carried over: ${carried.length} (${carried.map(id => get().diagrams.find(d => d.id === id)?.name).join(', ')})` }] : []),
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
  // With diagrams, each diagram of the ORM2 schema gets a twin in the new one
  // (carrySchemaDiagrams), laid out by layout. With assertions, each ORM2
  // constraint the tables don't keep (constraint accounting) is added to the
  // new schema as its translation (a CHECK, a graphical constraint over
  // columns, or an assertion), so the two schemas say the same; what
  // PostgreSQL can't enforce of that is reported when the DDL is exported.
  // Returns { schemaId, mappingId, sql }.
  generateRelationalFromOrm(ormSchemaId, { surrogates = 'never', overrides = {}, diagrams = true, layout = null, assertions = true } = {}) {
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
    let carried = null, twins = [], added = []
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
      if (assertions) {
        try { added = carryLost(get, get().mappings.find(m => m.id === g.mapping.id), ormSchemaId, null, { to: unique }) }
        catch (err) { added = [`Constraints the tables don't keep were not added: ${err?.message ?? err}`] }
      }
      if (diagrams) twins = get().carrySchemaDiagrams(g.mapping.id, ormSchemaId, built.diagram.id, { layout })
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
      { level: 'note', text: `Mapping ${g.mapping.name}: ${g.mapping.rules.length} rules. Accounting in the Mappings tab lists the constraints the tables don't keep` },
      ...added.map(text => ({ level: /^Added/.test(text) ? 'note' : 'warn', text })),
      ...(twins.length ? [{ level: 'note', text: `Diagrams of ${orm.name} carried over: ${twins.length} (${twins.map(id => get().diagrams.find(d => d.id === id)?.name).join(', ')})` }] : []),
      ...(carried ? [{ level: 'note', text: `Carried the population over by running the mapping: ${carried.rows} rows` }, ...carried.problems.slice(0, 20).map(l => ({ level: 'warn', text: l.text }))] : []),
      ...g.log.filter(l => !/^\d+ tables:/.test(l.text)),
    ] })
    const svg = typeof document !== 'undefined' ? document.querySelector('.canvas-bg')?.closest('svg') : null
    const r = svg?.getBoundingClientRect()
    get().fitToContent?.(r?.width || 1200, r?.height || 700)
    return { schemaId: schema.id, mappingId: g.mapping.id, sql: g.sql }
  },

  // The active relational schema as PostgreSQL DDL: { sql, warnings }.
  exportPostgresDdl(schemaId = activeSchemaIdOf(get()), options = {}) {
    return exportPostgresDdl(get(), schemaId, options)
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
