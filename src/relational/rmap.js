// Generating a relational schema from an ORM2 schema (workbench step 13), in
// the spirit of Halpin's Rmap, together with the mapping between them.
//
//   - Every entity type gets the columns of its reference scheme (a reference
//     mode's value, or the parts of a composite identifier, flattened through
//     entity types that are parts themselves): its natural key.
//   - A fact type with a uniqueness constraint on one role played by an entity
//     type is absorbed into that entity type's table: the other role becomes
//     columns (NOT NULL when the entity's role is mandatory, UNIQUE when the
//     other role is unique too, a foreign key when its player has a table).
//     Of a one-to-one fact type, the side with the mandatory role absorbs it.
//   - A unary fact type becomes a boolean column of its player's table.
//   - Any other fact type (many-to-many, n-ary, unique on a value role,
//     objectified) gets a table of its own, keyed by its first uniqueness
//     constraint.
//   - An entity type gets a table when something is absorbed into it, when it
//     is independent, when it is a supertype or subtype, or when it plays no
//     other role (so its instances are kept). A subtype's table has its
//     supertype's key as primary key and foreign key (as guessOrm.js reads
//     it back); facts of the subtype are absorbed into it.
//   - Surrogate keys (decision Q4): never, for composite identifiers only, or
//     always, overridable per entity type. A surrogate is an integer column
//     generated as identity; the natural key stays as UNIQUE NOT NULL, and
//     references go through the surrogate.
//
// The tables are written as PostgreSQL DDL and read back with ddlImport.js,
// so the relational schema is exactly what that DDL gives (and exports back).
// Each table row, absorbed fact type and fact table gets one mapping rule,
// ORM2 pattern ⟺ table row, joining over surrogates on the relational side.
//
// planRelational(state, ormSchemaId, options) → { tables, entities, log }
// generateRelational(state, ormSchemaId, options) →
//   { sql, built, mapping, plan, log }   (built: objectTypes, facts, constraints, diagram)

import { sideContext } from '../mapping/mapping.js'
import { schemeOf } from '../mapping/runMapping.js'
import { identifyingFactIds } from '../utils/refMode.js'
import { valueKindName } from '../utils/datatypeValues.js'
import { quoteIdent, typeSql, rangeSql } from './ddlExport.js'
import { importPostgresDdl } from './ddlImport.js'
import { relationalModel } from './relationalModel.js'
import { plainParts } from '../verbalisation/hyphenBinding.js'
import { uid } from '../store/storeHelpers.js'

export const SURROGATE_MODES = ['never', 'composite', 'always']

const snake = (s) => String(s ?? '').replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
  .replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '').toLowerCase()
const STOP = new Set(['has', 'have', 'is', 'are', 'was', 'were', 'a', 'an', 'the', 'of', 'be', 'being'])

// The words of a fact type's reading other than its players, without "has",
// "is" and the like: "Customer has support rep Employee" → support_rep.
function readingWords(f) {
  const parts = plainParts(f.readingParts ?? [], f.roles.length)
  return snake(parts.join(' ').split(/\s+/).filter(w => w && !STOP.has(w.toLowerCase())).join(' '))
}

// The SQL type of an ORM2 value type, from its datatype in any profile.
function sqlTypeOf(vt) {
  const a = vt?.datatypeAssignment
  if (a?.profileId === 'postgresql' || a?.profileId === 'sql2016') {
    const t = typeSql(a, null)
    if (t) return t
  }
  const p = a?.params ?? {}
  switch (valueKindName(a)) {
    case 'string': return p.length ? `varchar(${p.length})` : 'text'
    case 'integer': return 'integer'
    case 'decimal': return p.precision != null ? `numeric(${p.precision}${p.scale != null ? `, ${p.scale}` : ''})` : 'numeric'
    case 'float': return 'double precision'
    case 'boolean': case 'yesNo': return 'boolean'
    case 'date': return 'date'
    case 'datetime': return 'timestamp'
    case 'time': return 'time'
    case 'duration': case 'dayTimeDuration': case 'yearMonthDuration': return 'interval'
    case 'binary': case 'hexBinary': return 'bytea'
    default: return 'text'
  }
}

export function planRelational(state, ormSchemaId, { surrogates = 'never', overrides = {} } = {}) {
  const log = []
  const note = (text) => log.push({ level: 'note', text })
  const warn = (text) => log.push({ level: 'warn', text })
  const ctx = sideContext(state, ormSchemaId)
  const els = { objectTypes: ctx.objectTypes, facts: ctx.facts, subtypes: ctx.subtypes, constraints: ctx.constraints }
  const ident = identifyingFactIds(ctx.facts, ctx.objectTypes, ctx.constraints)
  const typeName = (id) => ctx.otById.get(id)?.name ?? ctx.factById.get(id)?.objectifiedName ?? '?'
  // Objectified fact types (without an identifier of their own) are entity
  // types here, identified by their role players; their table is their facts'.
  const nestedOf = (id) => (ctx.factById.get(id)?.objectified && !ctx.factById.get(id)._link ? ctx.factById.get(id) : null)
  const isEntity = (id) => ctx.otById.get(id)?.kind === 'entity' || !!nestedOf(id)
  const supersOf = (id) => ctx.subtypes.filter(s => s.subId === id).map(s => s.superId)
  const subsOf = (id) => ctx.subtypes.filter(s => s.superId === id).map(s => s.subId)

  // ── Natural keys: [{ name, vtId }] per type ──
  const keyMemo = new Map()
  const keyOf = (typeId, depth = 0) => {
    if (keyMemo.has(typeId)) return keyMemo.get(typeId)
    const t = ctx.otById.get(typeId) ?? nestedOf(typeId)
    let out = null
    if (t?.kind === 'value') out = [{ name: snake(t.name), vtId: t.id }]
    else if (t && depth < 6) {
      const sch = schemeOf(typeId, els)
      if (sch?.kind === 'refMode') {
        const rr = ctx.factById.get(sch.rm.factId)?.roles[sch.rm.vtRoleIndex]?.valueRange
        out = [{ name: snake(typeName(sch.rm.vtId)), vtId: sch.rm.vtId, roleRanges: rr?.length ? [rr] : [] }]
      }
      else if (sch?.kind === 'composite') {
        out = []
        for (const p of sch.parts) {
          const f = ctx.factById.get(p.factId)
          const player = f?.roles[p.roleIndex]?.objectTypeId
          const sub = player && keyOf(player, depth + 1)
          if (!sub) { out = null; break }
          const rn = snake(f.roles[p.roleIndex].roleName)
          const isVal = ctx.otById.get(player)?.kind === 'value'
          const rr = isVal ? f.roles[p.roleIndex].valueRange : null
          out.push(...sub.map(c => ({ ...c, name: rn && sub.length === 1 && isVal ? rn : c.name, roleRanges: [...(c.roleRanges ?? []), ...(rr?.length ? [rr] : [])] })))
        }
        if (out) {
          // Names unique within the key.
          const seen = new Map()
          out = out.map(c => { const n = (seen.get(c.name) ?? 0) + 1; seen.set(c.name, n); return n > 1 ? { ...c, name: `${c.name}_${n}` } : c })
        }
      }
    }
    keyMemo.set(typeId, out)
    return out
  }

  // ── Which fact types go where ──
  const absorbed = new Map()   // entity type id → [{ fact, own: role index, other: role index | null }]
  const factTables = []        // [fact]
  const nested = []            // objectified fact types: tables of their own, as entity types
  const skipped = []
  const absorb = (typeId, item) => { if (!absorbed.has(typeId)) absorbed.set(typeId, []); absorbed.get(typeId).push(item) }
  const simpleUc = (f, i) => (f.uniqueness ?? []).some(u => (u.roles ?? []).length === 1 && u.roles[0] === i)
    || (f.preferredUniqueness ?? []).some(u => u.length === 1 && u[0] === i)
  for (const f of ctx.facts) {
    if (ident.entity.has(f.id) || ident.nested.has(f.id) || f._implicit) continue
    if (f.derivation === 'derived') { note(`${factLabel(f, typeName)} is derived, so it is not stored`); continue }
    const players = f.roles.map(r => r.objectTypeId)
    const bad = players.find(p => !p || (!ctx.otById.has(p) && !nestedOf(p)) || !keyOf(p))
    if (bad !== undefined) {
      skipped.push(f)
      warn(`${factLabel(f, typeName)}: ${!bad || (!ctx.otById.has(bad) && !nestedOf(bad)) ? 'a role is played by nothing' : `${typeName(bad)} has no reference scheme`}; left out`)
      continue
    }
    if (f.objectified) { nested.push(f); continue }
    if (f.roles.length === 1) { absorb(players[0], { fact: f, own: 0, other: null }); continue }
    if (f.roles.length === 2 && !f.objectified) {
      const cands = [0, 1].filter(i => simpleUc(f, i) && isEntity(players[i]) && (ctx.otById.get(players[i]) ?? nestedOf(players[i]))?.derivation !== 'derived')
      if (cands.length) {
        // One-to-one: the side whose role is mandatory (the first if both or neither).
        const own = cands.length === 2 ? (f.roles[1].mandatory && !f.roles[0].mandatory ? 1 : 0) : cands[0]
        absorb(players[own], { fact: f, own, other: 1 - own })
        continue
      }
    }
    factTables.push(f)
  }

  // ── Which entity types get a table ──
  const inFactTables = new Set(factTables.flatMap(f => f.roles.map(r => r.objectTypeId)))
  const inAbsorbed = new Set([...absorbed.values()].flat().flatMap(a => a.fact.roles.map(r => r.objectTypeId)))
  const hasTable = new Set()
  for (const t of ctx.objectTypes) {
    if (t.kind !== 'entity' || !keyOf(t.id)) continue
    if (t.derivation === 'derived') { note(`${t.name} is derived, so it gets no table`); continue }
    if (absorbed.has(t.id) || t.isIndependent || supersOf(t.id).length || subsOf(t.id).length || (!inFactTables.has(t.id) && !inAbsorbed.has(t.id)))
      hasTable.add(t.id)
  }
  for (const f of nested) hasTable.add(f.id)
  for (const t of ctx.objectTypes) if (t.kind === 'entity' && !keyOf(t.id)) warn(`${t.name} has no reference scheme, so it gets no table`)
  // A supertype of a type with a table has one too.
  for (let changed = true; changed;) {
    changed = false
    for (const id of [...hasTable]) for (const s of supersOf(id)) if (!hasTable.has(s) && keyOf(s)) { hasTable.add(s); changed = true }
  }
  for (const t of ctx.objectTypes) {
    if (t.kind === 'entity' && keyOf(t.id) && t.derivation !== 'derived' && !hasTable.has(t.id))
      note(`${t.name} gets no table: its instances are kept only where they play a role; mark it independent to keep the others`)
  }

  // ── Table names ──
  const used = new Set()
  const tableName = (base) => { let n = base || 'table'; for (let i = 2; used.has(n); i++) n = `${base}_${i}`; used.add(n); return n }
  const entities = new Map()   // type id → { typeId, table, natural: [col], surrogate: col | null, root, superId }
  const rootOf = (id, seen = new Set()) => {
    const s = supersOf(id).find(x => hasTable.has(x))
    return s && !seen.has(s) ? rootOf(s, seen.add(id)) : id
  }
  for (const id of hasTable) entities.set(id, { typeId: id, table: tableName(snake(typeName(id))), root: rootOf(id), superId: supersOf(id).find(x => hasTable.has(x)) ?? null })
  // Surrogates: decided for root tables; subtypes share their root's key.
  for (const e of entities.values()) {
    const natural = keyOf(e.typeId)
    e.natural = natural
    if (e.root !== e.typeId) continue
    const want = !nestedOf(e.typeId) && (overrides[e.typeId] ?? (surrogates === 'always' || (surrogates === 'composite' && natural.length > 1)))
    if (want) {
      let n = `${e.table}_id`
      if (natural.some(c => c.name === n)) n = `${e.table}_sid`
      e.surrogate = { name: n, sql: 'integer', surrogateOf: e.typeId }
    } else e.surrogate = null
  }
  for (const e of entities.values()) if (e.root !== e.typeId) e.surrogate = entities.get(e.root).surrogate

  // The columns that refer to a player: its surrogate or its natural key.
  const refCols = (typeId) => {
    const e = entities.get(typeId)
    const root = e && entities.get(e.root)
    if (root?.surrogate) return [{ name: root.surrogate.name, sql: 'integer', leaf: null }]
    return keyOf(typeId).map((c, i) => ({ name: c.name, sql: sqlTypeOf(ctx.otById.get(c.vtId)), vtId: c.vtId, leaf: i }))
  }

  // ── Tables ──
  const tables = []
  const valueRangeOf = (vtId, role) => {
    const specs = [ctx.otById.get(vtId)?.valueRange, role?.valueRange].filter(s => Array.isArray(s) && s.length)
    return specs
  }
  for (const e of entities.values()) {
    const t = { name: e.table, kind: e.root === e.typeId ? 'entity' : 'subtype', typeId: e.typeId, columns: [], pk: [], uniques: [], fks: [], checks: [], parts: [] }
    e.tableObj = t
    const colNames = new Set()
    const addCol = (c) => {
      let n = c.name
      for (let i = 2; colNames.has(n); i++) n = `${c.name}_${i}`
      colNames.add(n)
      const col = { ...c, name: n }
      t.columns.push(col)
      return col
    }
    if (t.kind === 'entity') {
      if (e.surrogate) { const s = addCol({ ...e.surrogate, notNull: true, generated: 'identity' }); t.pk = [s.name] }
      const nat = e.natural.map((c, i) => addCol({ name: c.name, sql: sqlTypeOf(ctx.otById.get(c.vtId)), notNull: true, vtId: c.vtId, leaf: i, ranges: [...valueRangeOf(c.vtId), ...(c.roleRanges ?? [])] }))
      e.naturalCols = nat
      if (e.surrogate) t.uniques.push(nat.map(c => c.name)); else t.pk = nat.map(c => c.name)
      // An objectified fact type: keyed by its uniqueness constraint.
      const nf = nestedOf(e.typeId)
      if (nf) {
        const ranges = []
        let from = 0
        for (const r of nf.roles) { const n = keyOf(r.objectTypeId).length; ranges.push([from, from + n]); from += n }
        const uc = [...(nf.preferredUniqueness ?? []), ...(nf.uniqueness ?? []).map(u => u.roles ?? [])].filter(u => u.length).sort((a, b) => a.length - b.length)[0]
        if (uc && uc.length < nf.roles.length) {
          t.pk = uc.flatMap(i => nat.slice(...ranges[i]).map(c => c.name))
          t.uniques.push(nat.map(c => c.name))
        }
        if (!uc) warn(`${typeName(nf.id)} has no uniqueness constraint; its table is keyed by all its columns`)
      }
      // Parts of the identifier that are entity types with a table: foreign keys.
      const sch = schemeOf(e.typeId, els)
      if (sch?.kind === 'composite' && !e.surrogate) {
        let from = 0
        for (const p of sch.parts) {
          const player = ctx.factById.get(p.factId)?.roles[p.roleIndex]?.objectTypeId
          const n = keyOf(player).length
          if (entities.has(player) && !entities.get(entities.get(player).root).surrogate) t.fks.push({ cols: nat.slice(from, from + n).map(c => c.name), refTypeId: player })
          from += n
        }
      }
    } else {
      // A subtype: the root's key, as primary key and foreign key to the supertype.
      const root = entities.get(e.root)
      const cols = (root.surrogate ? [{ ...root.surrogate, generated: null }] : root.natural.map((c, i) => ({ name: c.name, sql: sqlTypeOf(ctx.otById.get(c.vtId)), vtId: c.vtId, leaf: i })))
        .map(c => addCol({ ...c, notNull: true }))
      e.keyCols = cols
      t.pk = cols.map(c => c.name)
      t.fks.push({ cols: t.pk, refTypeId: e.superId })
    }
    // Absorbed fact types.
    for (const a of absorbed.get(e.typeId) ?? []) {
      const f = a.fact
      if (a.other == null) {
        const c = addCol({ name: readingWords(f) || snake(f.readingParts?.join(' ')) || 'flag', sql: 'boolean', notNull: false })
        t.parts.push({ fact: f, own: 0, other: null, cols: [c] })
        continue
      }
      const role = f.roles[a.other], player = role.objectTypeId
      const words = snake(role.roleName) || readingWords(f)
      const refs = refCols(player)
      const isValue = ctx.otById.get(player)?.kind === 'value'
      const cols = refs.map(r => addCol({
        ...r,
        name: isValue ? (snake(role.roleName) || (words ? `${words}_${r.name}` : r.name)) : (words ? `${words}_${r.name}` : r.name),
        notNull: !!f.roles[a.own].mandatory,
        ranges: r.vtId ? valueRangeOf(r.vtId, role) : [],
      }))
      if (simpleUc(f, a.other)) t.uniques.push(cols.map(c => c.name))
      if (entities.has(player)) t.fks.push({ cols: cols.map(c => c.name), refTypeId: player })
      t.parts.push({ fact: f, own: a.own, other: a.other, cols })
    }
    tables.push(t)
  }
  for (const f of factTables) {
    const label = snake([...f.roles.map(r => typeName(r.objectTypeId)), readingWords(f)].join(' '))
    const t = { name: tableName(f.objectified && f.objectifiedName ? snake(f.objectifiedName) : snake(plainParts(f.readingParts ?? [], f.roles.length)
      .flatMap((w, i) => [w, i < f.roles.length ? typeName(f.roles[i].objectTypeId) : '']).join(' ')) || label),
      kind: 'fact', factId: f.id, columns: [], pk: [], uniques: [], fks: [], checks: [], roleCols: [] }
    const colNames = new Set()
    const players = f.roles.map(r => r.objectTypeId)
    f.roles.forEach((role, i) => {
      const twice = players.filter(p => p === role.objectTypeId).length > 1
      const prefix = snake(role.roleName) || (twice && i > 0 ? snake(f.readingParts?.[i] ?? '') : '')
      const cols = refCols(role.objectTypeId).map(r => {
        let n = prefix && prefix !== r.name ? `${prefix}_${r.name}` : r.name
        for (let k = 2; colNames.has(n); k++) n = `${r.name}_${k}`
        colNames.add(n)
        const c = { ...r, name: n, notNull: true, ranges: r.vtId ? valueRangeOf(r.vtId, role) : [] }
        t.columns.push(c)
        return c
      })
      t.roleCols.push(cols)
      if (entities.has(role.objectTypeId)) t.fks.push({ cols: cols.map(c => c.name), refTypeId: role.objectTypeId })
    })
    const ucs = [...(f.preferredUniqueness ?? []), ...(f.uniqueness ?? []).map(u => u.roles ?? [])].filter(u => u.length)
    const keyOfUc = (u) => [...new Set(u)].flatMap(i => t.roleCols[i].map(c => c.name))
    const seenUc = new Set()
    for (const u of ucs) {
      const k = keyOfUc(u)
      if (seenUc.has(k.join())) continue
      seenUc.add(k.join())
      if (!t.pk.length) t.pk = k; else t.uniques.push(k)
    }
    if (!t.pk.length) { t.pk = t.columns.map(c => c.name); warn(`${factLabel(f, typeName)} has no uniqueness constraint; its table is keyed by all its columns`) }
    tables.push(t)
  }
  // Foreign keys resolved to their table and columns.
  for (const t of tables) for (const fk of t.fks) {
    const e = entities.get(fk.refTypeId)
    const root = entities.get(e.root)
    fk.refTable = e.tableObj.name
    fk.refCols = root.surrogate ? [root.surrogate.name] : e.tableObj.kind === 'subtype' ? e.keyCols.map(c => c.name) : e.naturalCols.map(c => c.name)
  }
  note(`${tables.length} tables: ${tables.filter(t => t.kind === 'entity').length} for entity types, ${tables.filter(t => t.kind === 'subtype').length} for subtypes, ${tables.filter(t => t.kind === 'fact').length} for fact types`)
  const nSur = [...entities.values()].filter(e => e.root === e.typeId && e.surrogate).length
  if (nSur) note(`${nSur} surrogate key${nSur === 1 ? '' : 's'} (generated as identity); natural keys stay UNIQUE`)
  return { tables, entities, keyOf, refCols, ctx, els, log, skipped }
}

function factLabel(f, typeName) {
  const parts = plainParts(f.readingParts ?? [], f.roles.length)
  return f.roles.map((r, i) => [parts[i], typeName(r.objectTypeId)].filter(x => x?.trim()).join(' ')).join(' ') + (parts[f.roles.length]?.trim() ? ` ${parts[f.roles.length].trim()}` : '')
}

// ── DDL ──────────────────────────────────────────────────────────────────────

export function planDdl(plan, schemaName = 'ORM2') {
  const q = quoteIdent
  const lines = [`-- PostgreSQL DDL generated by FreeFBM from ${schemaName}`, '']
  const fkLines = []
  for (const t of plan.tables) {
    const items = t.columns.map(c => {
      let s = `  ${q(c.name)} ${c.sql}${c.generated === 'identity' ? ' generated by default as identity' : ''}${c.notNull ? ' NOT NULL' : ''}`
      for (const specs of c.ranges ?? []) {
        const numeric = /^(integer|smallint|bigint|numeric|real|double precision)/.test(c.sql)
        const cond = rangeSql(q(c.name), specs, numeric)
        if (cond) s += ` CHECK (${cond})`
      }
      return s
    })
    if (t.pk.length) items.push(`  PRIMARY KEY (${t.pk.map(q).join(', ')})`)
    for (const u of t.uniques) items.push(`  UNIQUE (${u.map(q).join(', ')})`)
    lines.push(`CREATE TABLE ${q(t.name)} (`, items.join(',\n'), ');', '')
    for (const fk of t.fks) fkLines.push(`ALTER TABLE ${q(t.name)} ADD FOREIGN KEY (${fk.cols.map(q).join(', ')}) REFERENCES ${q(fk.refTable)} (${fk.refCols.map(q).join(', ')});`)
  }
  return [...lines, ...fkLines, ''].join('\n')
}

// ── Mapping rules ────────────────────────────────────────────────────────────

const and = (parts) => (parts.length === 1 ? parts[0] : { t: 'and', args: parts })
const exists = (vars, body) => vars.reduceRight((b, v) => ({ t: 'exists', v, body: b }), body)
const bindAtom = (id, y) => ({ t: 'vcmp', op: '≈', left: { t: 'var', id }, right: { t: 'fv', y } })

// A rule's patterns are built in a scope that hands out variable ids.
function scope() {
  let n = 0
  const vars = [], atoms = []
  return { vars, atoms, mk: (typeId) => { const v = { id: `r${++n}`, typeId }; vars.push(v); return v.id } }
}

// ORM2 atoms identifying variable id of typeId by frontier names (one per
// leaf of its natural key).
function identify(sc, plan, id, typeId, names) {
  const { ctx, els } = plan
  const t = ctx.otById.get(typeId)
  if (t?.kind === 'value') { sc.atoms.push(bindAtom(id, names[0])); return }
  const sch = schemeOf(typeId, els)
  const parts = sch?.kind === 'refMode'
    ? [{ factId: sch.rm.factId, entityRoleIndex: 1 - sch.rm.vtRoleIndex, roleIndex: sch.rm.vtRoleIndex }]
    : sch?.parts ?? []
  let from = 0
  for (const p of parts) {
    const f = ctx.factById.get(p.factId)
    const player = f.roles[p.roleIndex].objectTypeId
    const n = plan.keyOf(player).length
    const w = sc.mk(player)
    const args = f.roles.map(() => null)
    args[p.entityRoleIndex] = id
    args[p.roleIndex] = w
    sc.atoms.push({ t: 'fact', factId: f.id, args })
    identify(sc, plan, w, player, names.slice(from, from + n))
    from += n
  }
}

// Relational side: args for the columns that refer to a player, given the
// frontier names of its natural key; a surrogate is joined through its
// table's row with the natural key.
function refArgs(rsc, plan, rel, typeId, cols, names) {
  const e = plan.entities.get(typeId)
  const root = e && plan.entities.get(e.root)
  if (!root?.surrogate) return Object.fromEntries(cols.map((c, i) => [rel.col(c.table, c.name), { k: 'fv', y: names[i] }]))
  const rootCol = rel.colObj(root.tableObj.name, root.surrogate.name)
  const s = rsc.mk(rootCol.vt.id)
  rsc.atoms.push({ t: 'rel', tableId: rel.table(root.tableObj.name), args: {
    [rootCol.fact.id]: { k: 'var', v: s },
    ...Object.fromEntries(root.naturalCols.map((c, i) => [rel.col(root.tableObj.name, c.name), { k: 'fv', y: names[i] }])),
  } })
  return { [rel.col(cols[0].table, cols[0].name)]: { k: 'var', v: s } }
}

function buildRules(plan, rel) {
  const rules = []
  const typeName = (id) => plan.ctx.otById.get(id)?.name ?? plan.ctx.factById.get(id)?.objectifiedName ?? '?'
  const push = (name, osc, oMain, rsc, rMain) => rules.push({
    id: uid(), name,
    source: exists(osc.vars, and([...(oMain ? [oMain] : []), ...osc.atoms])),
    target: exists(rsc.vars, and([rMain, ...rsc.atoms])),
  })
  // The frontier names of a table row's key (the root's natural columns),
  // and the row's arguments for them.
  const rowKey = (e, rsc) => {
    const t = e.tableObj
    const root = plan.entities.get(e.root)
    const ys = root.naturalCols.map(c => c.name)
    if (t.kind === 'entity') return { names: ys, args: Object.fromEntries(e.naturalCols.map((c, i) => [rel.col(t.name, c.name), { k: 'fv', y: ys[i] }])) }
    if (!root.surrogate) return { names: ys, args: Object.fromEntries(e.keyCols.map((c, i) => [rel.col(t.name, c.name), { k: 'fv', y: ys[i] }])) }
    return { names: ys, args: refArgs(rsc, plan, rel, e.root, [{ table: t.name, name: e.keyCols[0].name }], ys) }
  }
  // The frontier names for a player referred to by columns: the columns'
  // names, or for a surrogate, names after the column for its natural key.
  const refNames = (player, cols) => {
    const e = plan.entities.get(player)
    if (!(e && plan.entities.get(e.root).surrogate)) return cols.map(c => c.name)
    const key = plan.keyOf(player)
    const base = cols[0].name.replace(/_(s?id)$/, '')
    return key.map(c => (key.length === 1 ? cols[0].name : `${base}_${c.name}`))
  }
  for (const e of plan.entities.values()) {
    const t = e.tableObj
    // The table's rows: the instances of the entity type.
    {
      const osc = scope(), rsc = scope()
      const k = rowKey(e, rsc)
      const x = osc.mk(e.typeId)
      identify(osc, plan, x, e.typeId, k.names)
      let typeAtom = t.kind === 'subtype' ? { t: 'type', typeId: e.typeId, arg: x } : null
      // An objectified fact type's row is also a fact of it: its players are
      // the ones the implied links name.
      const nf = plan.ctx.factById.get(e.typeId)
      if (nf?.objectified && !nf._link) {
        const args = nf.roles.map((_, i) => osc.atoms.find(a => a.t === 'fact' && a.factId === `${nf.id}_il_${i}` && a.args[0] === x)?.args[1] ?? null)
        if (args.every(Boolean)) typeAtom = { t: 'fact', factId: nf.id, args }
      }
      push(typeName(e.typeId), osc, typeAtom, rsc, { t: 'rel', tableId: rel.table(t.name), args: k.args })
    }
    // Absorbed fact types.
    for (const p of t.parts) {
      const osc = scope(), rsc = scope()
      const k = rowKey(e, rsc)
      const f = p.fact
      const args = f.roles.map(() => null)
      const x = osc.mk(f.roles[p.own].objectTypeId)
      args[p.own] = x
      identify(osc, plan, x, f.roles[p.own].objectTypeId, k.names)
      const relArgs = { ...k.args }
      if (p.other == null) {
        relArgs[rel.col(t.name, p.cols[0].name)] = { k: 'const', text: 'true' }
      } else {
        const player = f.roles[p.other].objectTypeId
        const ys = refNames(player, p.cols)
        const y = osc.mk(player)
        args[p.other] = y
        identify(osc, plan, y, player, ys)
        Object.assign(relArgs, refArgs(rsc, plan, rel, player, p.cols.map(c => ({ table: t.name, name: c.name })), ys))
      }
      push(factLabel(f, typeName), osc, { t: 'fact', factId: f.id, args }, rsc, { t: 'rel', tableId: rel.table(t.name), args: relArgs })
    }
  }
  // Fact tables.
  for (const t of plan.tables.filter(x => x.kind === 'fact')) {
    const f = plan.ctx.factById.get(t.factId)
    const osc = scope(), rsc = scope()
    const args = [], relArgs = {}
    f.roles.forEach((r, i) => {
      const cols = t.roleCols[i]
      const ys = refNames(r.objectTypeId, cols)
      const x = osc.mk(r.objectTypeId)
      args.push(x)
      identify(osc, plan, x, r.objectTypeId, ys)
      Object.assign(relArgs, refArgs(rsc, plan, rel, r.objectTypeId, cols.map(c => ({ table: t.name, name: c.name })), ys))
    })
    push(factLabel(f, typeName), osc, { t: 'fact', factId: f.id, args }, rsc, { t: 'rel', tableId: rel.table(t.name), args: relArgs })
  }
  return rules
}

export function generateRelational(state, ormSchemaId, { schemaId = null, surrogates = 'never', overrides = {}, mappingName = null, schemaName = 'ORM2' } = {}) {
  const plan = planRelational(state, ormSchemaId, { surrogates, overrides })
  const sql = planDdl(plan, schemaName)
  const built = importPostgresDdl(sql, { schemaId, diagramName: 'Tables' })
  const rm = relationalModel({ objectTypes: built.objectTypes, facts: built.facts, constraints: built.constraints }, null)
  const byName = new Map(rm.tables.map(t => [t.name, t]))
  const rel = {
    table: (name) => byName.get(name)?.id,
    colObj: (table, col) => byName.get(table)?.columns.find(c => c.name === col),
    col: (table, col) => byName.get(table)?.columns.find(c => c.name === col)?.fact.id,
  }
  const rules = buildRules(plan, rel)
  const mapping = { id: uid(), name: mappingName ?? 'ORM2 to tables', sourceSchemaId: ormSchemaId, targetSchemaId: schemaId, rules }
  const log = [...plan.log, ...built.log.filter(l => l.level === 'warn')]
  return { sql, built, mapping, plan, log }
}
