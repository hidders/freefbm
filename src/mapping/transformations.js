// Named transformations (workbench decision Q9): presets of derive and fold.
//
// A transformation of a schema S writes the elements of the new version as
// derived elements of S (table rules, derivedTables.js), then refactors S
// (refactor.js: a clone S' and the identity mapping S → S') and folds the
// clone's derived elements into that mapping (fold.js), removing the columns
// they replace. S stays as it was; S', the mapping S → S' and the import log
// report say what changed, and the equivalence summary checks it.
//
// Each transformation is { id, label, profile, describe(params, ctx),
// options(ctx) → what the dialog offers, check(params, ctx) → [problem],
// derive(api, params, ctx) → { remove: [old fact id], post?(api, run) } }.
// derive uses store actions on S (api = the store's state with its actions);
// post runs after the fold on S' with run = { mapping, idMap, ctx: S' side
// context, report: [text] }.

import { sideContext } from './mapping.js'
import { uid, mkConstraint, mkEntity } from '../store/storeHelpers.js'
import { valueKindName } from '../utils/datatypeValues.js'
import { newColumn, withPrimaryKey, tableRulesOf } from '../relational/derivedTables.js'

const isBoolean = (c) => valueKindName(c?.vt?.datatypeAssignment) === 'boolean' || /^bool/i.test(c?.vt?.datatypeAssignment?.datatypeId ?? '')

const sameKeyTypes = (a, b) => a?.length && b?.length === a.length && a.every((c, i) => c.vt.id === b[i].vt.id)
const fkBetween = (ctx, from, to) => ctx.tables.find(t => t.id === from.id)?.fks?.find(fk =>
  fk.toTable.id === to.id && fk.from.length === from.pk?.length && fk.from.every((c, i) => c === from.pk[i]) && fk.to.every((c, i) => c === to.pk?.[i]))
const freeName = (taken, base) => { let n = base; for (let i = 2; taken.has(n); i++) n = `${base}_${i}`; taken.add(n); return n }

// A row of a table in a table rule's body: its key columns as $k (named
// after the columns), and the given columns as $y or $y? (nullable ones).
function rowAtom(t, cols, { keyNames = null, opt = true } = {}) {
  const args = {}
  t.pk.forEach((c, i) => { args[c.fact.id] = { k: 'fv', y: keyNames?.[i] ?? c.name } })
  for (const c of cols) args[c.fact.id] = { k: opt && !c.notNull ? 'opt' : 'fv', y: c.name }
  return { t: 'rel', tableId: t.id, args }
}

// ── Split a table vertically ────────────────────────────────────────────────
// T(k, a, b, c) becomes T(k, a) and N(k, b, c): N's rows are T's keys with
// the moved columns (N ⟺ T(k, b?, c?)), foreign keys both ways (Fold finds
// them kept), and the moved columns' own foreign keys move with them.
const split = {
  id: 'split',
  label: 'Split a table vertically',
  profile: 'relational',
  describe: (p, ctx) => {
    const t = ctx.tableById.get(p.tableId)
    const cols = t?.columns.filter(c => p.columnIds?.includes(c.fact.id)) ?? []
    return t ? `Move ${cols.map(c => c.name).join(', ') || '…'} of ${t.name} to a new table ${p.name || '…'} with the same key.` : 'Choose a table.'
  },
  check: (p, ctx) => {
    const t = ctx.tableById.get(p.tableId)
    if (!t) return ['Choose a table.']
    const out = []
    if (!t.pk?.length) out.push(`${t.name} has no primary key.`)
    const cols = t.columns.filter(c => p.columnIds?.includes(c.fact.id))
    if (!cols.length) out.push('Choose the columns to move.')
    if (cols.some(c => c.pk)) out.push('Key columns stay in both tables; choose other columns.')
    if (cols.length && cols.length === t.columns.filter(c => !c.pk).length) out.push('That would move every column: rename the table instead.')
    if (!p.name?.trim()) out.push('Give the new table a name.')
    else if (ctx.tables.some(x => x.name === p.name.trim())) out.push(`There is already a table ${p.name.trim()}.`)
    if (cols.some(c => c.fact.derivation)) out.push('A derived column can\'t be moved.')
    return out
  },
  derive(api, p, ctx) {
    const t = ctx.tableById.get(p.tableId)
    const cols = t.columns.filter(c => p.columnIds.includes(c.fact.id))
    const id = api.getState().addDerivedTable(ctx.schemaId, p.name.trim())
    const r = api.getState().objectTypes.find(o => o.id === id).tableRules[0].id
    api.getState().updateTableRule(id, r, { body: rowAtom(t, cols, { opt: !p.required }) })
    for (const c of t.pk) api.getState().addTableRuleColumn(id, r, c.name, { key: true })
    for (const c of cols) api.getState().addTableRuleColumn(id, r, c.name)
    return {
      remove: cols.map(c => c.fact.id),
      // The moved columns' foreign keys, now from the new table.
      post: (run) => carryForeignKeys(api, run, t, cols, id),
    }
  },
}

// Foreign keys whose columns all moved from table t to table newId (in the
// old version's ids): added in the new version between the twins.
function carryForeignKeys(api, run, t, cols, newId, nameOf = (c) => c.name) {
  const moved = new Set(cols.map(c => c.fact.id))
  const st = api.getState()
  const ctxNew = sideContext(st, run.mapping.targetSchemaId)
  const nt = ctxNew.tableById.get(run.idMap.get(newId) ?? newId)
  if (!nt) return
  for (const fk of t.fks ?? []) {
    if (!fk.from.every(c => moved.has(c.fact.id))) continue
    const from = fk.from.map(c => nt.columns.find(x => x.name === nameOf(c)))
    const to = fk.to.map(c => ({ f: ctxNew.factById.get(run.idMap.get(c.fact.id)), ri: c.v }))
    if (from.some(x => !x) || to.some(x => !x.f)) continue
    addFk(api, run.mapping.targetSchemaId, from.map(x => ({ factId: x.fact.id, roleIndex: x.v })), to.map(x => ({ factId: x.f.id, roleIndex: x.ri })))
    run.report.push(`Added FOREIGN KEY ${nt.name}(${from.map(x => x.name).join(', ')}) → ${fk.toTable.name}(${fk.to.map(x => x.name).join(', ')}), moved with its columns`)
  }
}

// ── Absorb a table into another ─────────────────────────────────────────────
// U(k, b, c), whose key is a foreign key to T(k, a)'s, goes into T: T(k, a,
// b?, c?). U's rows are T's rows with a value in a NOT NULL column of U (or
// all of T's rows, when T's key is also a foreign key to U's), so U goes.
const absorb = {
  id: 'absorb',
  label: 'Absorb a table into another',
  profile: 'relational',
  describe: (p, ctx) => {
    const u = ctx.tableById.get(p.fromId), t = ctx.tableById.get(p.intoId)
    return u && t ? `Move the columns of ${u.name} into ${t.name}, joined by key, and drop ${u.name}.` : 'Choose the two tables.'
  },
  // The tables U can go into: its key is a foreign key to theirs.
  targets: (ctx, fromId) => {
    const u = ctx.tableById.get(fromId)
    return u ? ctx.tables.filter(t => t.id !== u.id && sameKeyTypes(u.pk, t.pk) && fkBetween(ctx, u, t)) : []
  },
  check: (p, ctx) => {
    const u = ctx.tableById.get(p.fromId), t = ctx.tableById.get(p.intoId)
    if (!u) return ['Choose the table to absorb.']
    if (!t) return [`${u.name}'s key is not a foreign key to another table's key, so it can't be absorbed.`]
    const out = []
    if (!fkBetween(ctx, u, t)) out.push(`${u.name}'s key is not a foreign key to ${t.name}'s key.`)
    if (!u.columns.some(c => !c.pk)) out.push(`${u.name} has no columns besides its key.`)
    if (u.columns.some(c => !c.pk && c.fact.derivation)) out.push(`${u.name} has derived columns.`)
    const refs = ctx.tables.filter(x => x.id !== t.id && (x.fks ?? []).some(fk => fk.toTable.id === u.id))
    if (refs.length) out.push(`${refs.map(x => x.name).join(', ')} refer${refs.length === 1 ? 's' : ''} to ${u.name}, which would keep it as a table of keys.`)
    return out
  },
  derive(api, p, ctx) {
    const u = ctx.tableById.get(p.fromId), t = ctx.tableById.get(p.intoId)
    const cols = u.columns.filter(c => !c.pk)
    const taken = new Set(t.columns.map(c => c.name))
    const names = new Map(cols.map(c => [c.fact.id, taken.has(c.name) ? freeName(taken, `${u.name}_${c.name}`) : freeName(taken, c.name)]))
    const st = () => api.getState()
    const r = st().addTableRule(t.id, 'columns')
    const keyNames = t.pk.map(c => c.name)
    // T(k) ∧ [$c](U(k, c: $c)) for each column: a value only where U has one.
    const parts = [{ t: 'rel', tableId: t.id, args: Object.fromEntries(t.pk.map((c, i) => [c.fact.id, { k: 'fv', y: keyNames[i] }])) }]
    for (const c of cols) {
      const y = names.get(c.fact.id)
      parts.push({ t: 'opt', y, body: { t: 'rel', tableId: u.id, args: { ...Object.fromEntries(u.pk.map((k, i) => [k.fact.id, { k: 'fv', y: keyNames[i] }])), [c.fact.id]: { k: 'fv', y } } } })
    }
    st().updateTableRule(t.id, r, { body: { t: 'and', args: parts }, head: Object.fromEntries(t.pk.map((c, i) => [c.fact.id, { k: 'fv', y: keyNames[i] }])) })
    for (const c of cols) st().addTableRuleColumn(t.id, r, names.get(c.fact.id), { name: names.get(c.fact.id) })
    return {
      remove: cols.map(c => c.fact.id),
      post: (run) => { carryForeignKeys(api, run, u, cols, t.id, (c) => names.get(c.fact.id)); dropAbsorbed(api, run, u, t, cols, names) },
    }
  },
}

// After absorbing U into T: U's twin goes when its rows can be told from T's
// (T's key a foreign key to U's, or a column of U that is NOT NULL), and the
// identity rule for U's rows reads them from T.
function dropAbsorbed(api, run, u, t, cols, names) {
  const st = api.getState()
  const ctxNew = sideContext(st, run.mapping.targetSchemaId)
  const nu = ctxNew.tableById.get(run.idMap.get(u.id)), nt = ctxNew.tableById.get(run.idMap.get(t.id))
  if (!nu || !nt) return
  if (nu.columns.some(c => !c.pk)) { run.report.push(`Kept ${nu.name}: some of its columns could not be moved`); return }
  if (ctxNew.tables.some(x => x.id !== nt.id && x.id !== nu.id && (x.fks ?? []).some(fk => fk.toTable.id === nu.id))) { run.report.push(`Kept ${nu.name} as a table of keys: other tables refer to it`); return }
  const both = !!fkBetween(ctxNew, nt, nu)
  const marker = cols.find(c => c.notNull)
  if (!both && !marker) { run.report.push(`Kept ${nu.name} as a table of keys: which rows of ${nt.name} it has can't be told from ${nt.name} (no column of it is NOT NULL)`); return }
  // The rule for U's rows: from T (all its rows), or none when the marker
  // column's rule gives them (a row of U for each value in it).
  const m = st.mappings.find(x => x.id === run.mapping.id)
  const isRowOf = (tree, tableId) => tree?.t === 'rel' && tree.tableId === tableId
  const markerCol = marker && nt.columns.find(c => c.name === names.get(marker.fact.id))
  const rules = m.rules.flatMap(r => {
    if (!isRowOf(r.target, nu.id)) return [r]
    if (!both) return []
    const args = {}
    nu.pk.forEach((c, i) => { const a = r.target.args?.[c.fact.id]; if (a) args[nt.pk[i].fact.id] = a })
    return [{ ...r, target: { t: 'rel', tableId: nt.id, args } }]
  })
  api.setState(s => ({ mappings: s.mappings.map(x => (x.id === m.id ? { ...x, rules } : x)) }))
  for (const f of st.facts.filter(x => x.roles.some(r => r.objectTypeId === nu.id))) api.getState().deleteFact(f.id)
  api.getState().deleteObjectType(nu.id)
  run.report.push(`Dropped ${nu.name}: its rows are the rows of ${nt.name}${both ? '' : ` with a value in ${markerCol?.name}`}`)
}

// ── Foreign key to cross table ──────────────────────────────────────────────
// T(k, f?) with f a foreign key to U becomes T(k) and X(k, f): X has a row
// for each row of T with a value in f (a split that keeps only those rows).
const fkToTable = {
  id: 'fkToTable',
  label: 'Foreign key → cross table',
  profile: 'relational',
  describe: (p, ctx) => {
    const t = ctx.tableById.get(p.tableId)
    const cols = t?.columns.filter(c => p.columnIds?.includes(c.fact.id)) ?? []
    return t ? `Move the foreign key ${t.name}(${cols.map(c => c.name).join(', ') || '…'}) to a cross table ${p.name || '…'}, with a row only where it has a value.` : 'Choose a foreign key.'
  },
  // The foreign keys that can move: not part of the table's key.
  optionLabel: 'Foreign key',
  none: 'The schema has no foreign key outside a primary key.',
  nameLabel: 'New table',
  options: (ctx) => ctx.tables.flatMap(t => (t.fks ?? []).filter(fk => fk.from.every(c => !c.pk)).map(fk => ({
    key: `${t.id}|${fk.from.map(c => c.fact.id).join(',')}`, params: { tableId: t.id, columnIds: fk.from.map(c => c.fact.id) },
    label: `${t.name}(${fk.from.map(c => c.name).join(', ')}) → ${fk.toTable.name}`, name: `${t.name}_${fk.toTable.name}` }))),
  check: (p, ctx) => split.check(p, ctx),
  derive: (api, p, ctx) => split.derive(api, { ...p, required: true }, ctx),
}

// ── Boolean column to table of keys ─────────────────────────────────────────
// T(k, b) with b a NOT NULL boolean becomes T(k) and B(k): B has the rows of
// T where b is true; b is false for the others.
const boolToTable = {
  id: 'boolToTable',
  label: 'Boolean column → table of keys',
  profile: 'relational',
  describe: (p, ctx) => {
    const t = ctx.tableById.get(p.tableId), c = t?.columns.find(x => x.fact.id === p.columnId)
    return t && c ? `Replace ${t.name}.${c.name} by a table ${p.name || '…'} of the keys of the rows where it is true.` : 'Choose a boolean column.'
  },
  optionLabel: 'Boolean column',
  none: 'The schema has no boolean column.',
  nameLabel: 'New table',
  options: (ctx) => ctx.tables.flatMap(t => t.columns.filter(c => !c.pk && isBoolean(c)).map(c => ({
    key: `${t.id}|${c.fact.id}`, params: { tableId: t.id, columnId: c.fact.id }, label: `${t.name}.${c.name}`, name: `${t.name}_${c.name}` }))),
  check: (p, ctx) => {
    const t = ctx.tableById.get(p.tableId), c = t?.columns.find(x => x.fact.id === p.columnId)
    if (!t || !c) return ['Choose a boolean column.']
    const out = []
    if (!isBoolean(c)) out.push(`${c.name} is not a boolean column.`)
    if (!c.notNull) out.push(`${c.name} may be NULL, which a table of keys can't tell from false.`)
    if (!t.pk?.length) out.push(`${t.name} has no primary key.`)
    if (!p.name?.trim()) out.push('Give the new table a name.')
    else if (ctx.tables.some(x => x.name === p.name.trim())) out.push(`There is already a table ${p.name.trim()}.`)
    return out
  },
  derive(api, p, ctx) {
    const t = ctx.tableById.get(p.tableId), c = t.columns.find(x => x.fact.id === p.columnId)
    const st = () => api.getState()
    const id = st().addDerivedTable(ctx.schemaId, p.name.trim())
    const r = st().objectTypes.find(o => o.id === id).tableRules[0].id
    const keyArgs = Object.fromEntries(t.pk.map(k => [k.fact.id, { k: 'fv', y: k.name }]))
    st().updateTableRule(id, r, { body: { t: 'rel', tableId: t.id, args: { ...keyArgs, [c.fact.id]: { k: 'const', text: 'true' } } } })
    for (const k of t.pk) st().addTableRuleColumn(id, r, k.name, { key: true })
    const bPk = sideContext(st(), ctx.schemaId).tableById.get(id).pk
    return {
      remove: [c.fact.id],
      // false: a row of T with no row in B.
      rules: (idMap) => [{ id: uid(), name: `${t.name}.${c.name} false`,
        source: { t: 'rel', tableId: t.id, args: { ...keyArgs, [c.fact.id]: { k: 'const', text: 'false' } } },
        target: { t: 'and', args: [
          { t: 'rel', tableId: idMap.get(t.id), args: Object.fromEntries(t.pk.map(k => [idMap.get(k.fact.id), { k: 'fv', y: k.name }])) },
          { t: 'not', arg: { t: 'rel', tableId: idMap.get(id), args: Object.fromEntries(bPk.map((k, i) => [idMap.get(k.fact.id), { k: 'fv', y: t.pk[i].name }])) } },
        ] } }],
    }
  },
}

// ── Editing the new version directly ────────────────────────────────────────
// Transformations that change keys can't be derived (no rule invents a
// surrogate), so they edit the new version (edit(api, params, ctx, run))
// and rewrite the identity mapping's rules to match.

const ctxOf = (api, schemaId) => sideContext(api.getState(), schemaId)
const colOf = (ctx, factId) => { for (const t of ctx.tables) for (const c of t.columns) if (c.fact.id === factId) return c; return undefined }
const roleSeq = (cols) => cols.map(c => ({ kind: 'role', factId: c.factId ?? c.fact.id, roleIndex: c.roleIndex ?? c.v }))

// A subset constraint (foreign key) between two lists of column roles.
function addFk(api, schemaId, from, to) {
  const c = { id: uid(), constraintType: 'subset', schemaId, x: 0, y: 0, sequences: [roleSeq(from), roleSeq(to)], queries: [null, null] }
  api.setState(s => ({ constraints: [...s.constraints, c] }))
  api.getState()._tryAutoGenerateQuery?.(c.id)
  return c.id
}

// A new column of a table (a value type of its own unless vtId is given).
function addColumnTo(api, schemaId, tableId, name, vtId, { notNull = false, generated = null, datatype = null } = {}) {
  const s = api.getState()
  const t = s.objectTypes.find(o => o.id === tableId)
  const occ = s.diagrams.find(d => d.schemaId === schemaId && !d.mappingId && (d.occurrences ?? []).some(o => o.schemaElementId === tableId))
    ?.occurrences.find(o => o.schemaElementId === tableId)
  const n = ctxOf(api, schemaId).tableById.get(tableId)?.columns.length ?? 0
  const at = { ...t, x: (occ?.x ?? t.x ?? 0) + 180, y: (occ?.y ?? t.y ?? 0) + 50 * n }
  const col = newColumn(s, at, name, vtId, { notNull })
  const fact = { ...col.fact, x: at.x, y: at.y }
  if (generated) fact.roles = fact.roles.map((r, i) => (i === 1 ? { ...r, sqlGenerated: generated } : r))
  let objectTypes = col.objectTypes
  if (datatype && !vtId) objectTypes = objectTypes.map(o => (o.id === fact.roles[1].objectTypeId ? { ...o, datatypeAssignment: { profileId: 'postgresql', datatypeId: datatype } } : o))
  api.setState({ objectTypes, facts: [...s.facts, fact], isDirty: true })
  const vtNew = !vtId || !s.facts.some(f => f.roles.some(r => r.objectTypeId === vtId))
  for (const d of api.getState().diagrams) {
    if (!(d.occurrences ?? []).some(o => o.schemaElementId === tableId)) continue
    // Below the table's other columns, its value type (when new) to the right.
    const st = api.getState()
    const before = st.diagrams.find(x => x.id === d.id)
    const tOcc = before.occurrences.find(o => o.schemaElementId === tableId)
    const cols = new Set(st.facts.filter(f => f.id !== fact.id && f.roles.some(r => r.objectTypeId === tableId)).map(f => f.id))
    const ys = before.occurrences.filter(o => cols.has(o.schemaElementId)).map(o => o.y)
    const y = ys.length ? Math.max(...ys) + 56 : tOcc.y
    const xs = before.occurrences.filter(o => cols.has(o.schemaElementId)).map(o => o.x)
    const x = xs.length ? Math.min(...xs) : tOcc.x + 170
    try { st.addElementToDiagram(fact.id, d.id) } catch { continue }
    const vt = fact.roles[1].objectTypeId
    api.setState(s2 => ({ diagrams: s2.diagrams.map(dd => (dd.id !== d.id ? dd : { ...dd, occurrences: dd.occurrences.map(o => (
      o.schemaElementId === fact.id ? { ...o, x, y } : vtNew && o.schemaElementId === vt ? { ...o, x: x + 160, y } : o)) })) }))
  }
  return fact.id
}

// Removes a column with the constraints over it, and its value type when
// nothing else plays it.
function dropColumn(api, factId) {
  const s = api.getState()
  const f = s.facts.find(x => x.id === factId)
  if (!f) return
  for (const c of s.constraints) if ((c.sequences ?? []).some(q => (q ?? []).some(m => m?.factId === factId))) s.deleteConstraint(c.id)
  api.getState().deleteFact(factId)
  for (const r of f.roles) {
    const ot = api.getState().objectTypes.find(o => o.id === r.objectTypeId)
    if (ot?.kind === 'value' && !api.getState().facts.some(x => x.roles.some(rr => rr.objectTypeId === ot.id))) api.getState().deleteObjectType(ot.id)
  }
}

function setPk(api, tableId, factIds) {
  const s = api.getState()
  const k = withPrimaryKey(s, s.objectTypes.find(o => o.id === tableId), factIds)
  api.setState({ facts: k.facts, constraints: k.constraints })
}

// A UNIQUE constraint over columns of one table.
function addUnique(api, schemaId, cols) {
  if (cols.length === 1) {
    const c = cols[0]
    api.setState(s => ({ facts: s.facts.map(f => (f.id !== c.fact.id || (f.uniqueness ?? []).some(u => u.roles?.length === 1 && u.roles[0] === c.v) ? f
      : { ...f, uniqueness: [...(f.uniqueness ?? []), { id: uid(), roles: [c.v] }] })) }))
    return
  }
  const t = cols[0].table.entity
  const u = { ...mkConstraint('uniqueness', (t.x ?? 0), (t.y ?? 0) - 40), schemaId, sequences: [roleSeq(cols)], queries: [null] }
  api.setState(s => ({ constraints: [...s.constraints, u] }))
}

// The tree with each table row atom replaced by fn(atom).
function mapRel(tree, fn) {
  if (!tree || typeof tree !== 'object') return tree
  if (Array.isArray(tree)) return tree.map(x => mapRel(x, fn))
  if (tree.t === 'rel') return fn(tree)
  const out = {}
  for (const [k, v] of Object.entries(tree)) out[k] = v && typeof v === 'object' && (Array.isArray(v) || v.t) ? mapRel(v, fn) : v
  return out
}
const andOf = (parts) => (parts.length === 1 ? parts[0] : { t: 'and', args: parts })
const existsOf = (vars, body) => vars.reduceRight((b, v) => ({ t: 'exists', v, body: b }), body)
function frontierNames(tree, out = new Set()) {
  if (!tree || typeof tree !== 'object') return out
  if (Array.isArray(tree)) { tree.forEach(x => frontierNames(x, out)); return out }
  if ((tree.k === 'fv' || tree.k === 'opt' || tree.t === 'fv') && tree.y) out.add(tree.y)
  for (const v of Object.values(tree)) if (v && typeof v === 'object') frontierNames(v, out)
  return out
}
function setRules(api, mappingId, fn) {
  api.setState(s => ({ mappings: s.mappings.map(m => (m.id === mappingId ? { ...m, rules: m.rules.map(fn) } : m)) }))
}

// The foreign keys to a table's key (all its columns, in any order), with
// the position in the key of each column.
const fksToKey = (ctx, t, key) => ctx.tables.flatMap(x => x.fks ?? []).filter(fk => fk.toTable.id === t.id && fk.to.length === key.length && fk.to.every(c => key.includes(c)))
  .map(fk => ({ fk, pos: fk.to.map(c => key.indexOf(c)) }))

// Problems with rewriting these foreign keys' columns.
function fkColumnProblems(ctx, refs, t) {
  const out = []
  for (const { fk } of refs) {
    const r = fk.fromTable
    for (const c of fk.from) {
      if (r.fks.some(x => x !== fk && x.from.includes(c))) out.push(`${r.name}.${c.name} is also in another foreign key.`)
      if (r.uniques.some(u => u.includes(c))) out.push(`${r.name}.${c.name} is in a UNIQUE constraint.`)
    }
    if (tableRulesOf(r.entity).length) out.push(`${r.name} has table rules.`)
  }
  if (tableRulesOf(t.entity).length) out.push(`${t.name} has table rules.`)
  return [...new Set(out)]
}
const pkProblem = (t) => (!t.pk?.length ? [`${t.name} has no primary key.`] : [])

// ── Natural key to surrogate key ────────────────────────────────────────────
// T(k, a) becomes T(id, k, a) with id GENERATED AS IDENTITY its key and k
// UNIQUE; a foreign key R(f) → T(k) becomes R(t_id) → T(id). In the rules,
// R'(…, f: $f) is R'(…, t_id: s) ∧ T'(id: s, k: $f), the surrogate s
// existential (a run invents it from k).
const toSurrogate = {
  id: 'toSurrogate',
  label: 'Natural key → surrogate key',
  profile: 'relational',
  optionLabel: 'Table',
  none: 'No table has a natural primary key.',
  nameLabel: 'Surrogate column',
  options: (ctx) => ctx.tables.filter(t => t.pk?.length && !(t.pk.length === 1 && t.pk[0].generated)).map(t => {
    const names = new Set(t.columns.map(c => c.name))
    return { key: t.id, params: { tableId: t.id }, label: `${t.name}(${t.pk.map(c => c.name).join(', ')})`,
      name: !names.has('id') ? 'id' : freeName(names, `${t.name}_id`) }
  }),
  describe: (p, ctx) => {
    const t = ctx.tableById.get(p.tableId)
    if (!t?.pk) return 'Choose a table.'
    const refs = fksToKey(ctx, t, t.pk)
    return `Give ${t.name} a generated key ${p.name || '…'}; ${t.pk.map(c => c.name).join(', ')} stay${t.pk.length === 1 ? 's' : ''} UNIQUE NOT NULL`
      + (refs.length ? `, and the foreign key${refs.length === 1 ? '' : 's'} ${refs.map(({ fk }) => `${fk.fromTable.name}(${fk.from.map(c => c.name).join(', ')})`).join(', ')} refer to ${p.name || '…'} instead.` : '.')
  },
  check: (p, ctx) => {
    const t = ctx.tableById.get(p.tableId)
    if (!t) return ['Choose a table.']
    const out = pkProblem(t)
    if (out.length) return out
    if (t.pk.length === 1 && t.pk[0].generated) out.push(`${t.name}'s key is already generated.`)
    const n = p.name?.trim()
    if (!n) out.push('Name the surrogate column.')
    else if (t.columns.some(c => c.name === n)) out.push(`${t.name} already has a column ${n}.`)
    const refs = fksToKey(ctx, t, t.pk)
    for (const { fk } of refs) if (fk.from.length > 1 && fk.from.some(c => !c.notNull)) out.push(`${fk.fromTable.name}(${fk.from.map(c => c.name).join(', ')}) may be partly NULL, which one surrogate can't say.`)
    out.push(...fkColumnProblems(ctx, refs, t))
    return out
  },
  edit(api, p, ctx, run) {
    const S = run.mapping.targetSchemaId, id = (x) => run.idMap.get(x)
    const t = ctx.tableById.get(p.tableId)
    const tId = id(t.id)
    const keyIds = t.pk.map(c => id(c.fact.id))
    const refs = fksToKey(ctx, t, t.pk)
    const sid = addColumnTo(api, S, tId, p.name.trim(), null, { notNull: true, generated: 'identity', datatype: 'integer' })
    const sidVt = api.getState().facts.find(f => f.id === sid).roles[1].objectTypeId
    const keyCols = keyIds.map(k => colOf(ctxOf(api, S), k))
    setPk(api, tId, [sid])
    if (keyCols.length > 1) addUnique(api, S, keyCols)
    run.report.push(`Added ${t.name}.${p.name.trim()} GENERATED BY DEFAULT AS IDENTITY as the primary key; ${t.pk.map(c => c.name).join(', ')} kept as UNIQUE NOT NULL`)
    const rewrites = []
    for (const { fk, pos } of refs) {
      const rId = id(fk.fromTable.id)
      const fromIds = fk.from.map(c => id(c.fact.id))
      const pkIds = (ctxOf(api, S).tableById.get(rId)?.pk ?? []).map(c => c.fact.id)
      for (const f of fromIds) dropColumn(api, f)
      const taken = new Set(ctxOf(api, S).tableById.get(rId).columns.map(c => c.name))
      const name = fk.from.length === 1 && !taken.has(fk.from[0].name) ? fk.from[0].name : freeName(taken, `${t.name}_${p.name.trim()}`)
      const nc = addColumnTo(api, S, rId, name, sidVt, { notNull: fk.from.every(c => c.notNull) })
      if (fromIds.some(f => pkIds.includes(f))) setPk(api, rId, [...new Set(pkIds.map(f => (fromIds.includes(f) ? nc : f)))])
      const c2 = ctxOf(api, S)
      addFk(api, S, [colOf(c2, nc)], [colOf(c2, sid)])
      rewrites.push({ tableId: rId, fromIds, pos, nc })
      run.report.push(`${fk.fromTable.name}(${fk.from.map(c => c.name).join(', ')}) → ${t.name} is now ${fk.fromTable.name}(${name}) → ${t.name}(${p.name.trim()})`)
    }
    // A foreign key of several columns: one rule for all of them (the
    // column rules each read one), so one surrogate stands for the row.
    for (const rw of rewrites) {
      if (rw.fromIds.length < 2) continue
      const fk = refs.find(x => id(x.fk.fromTable.id) === rw.tableId && x.fk.from.every(c => rw.fromIds.includes(id(c.fact.id)))).fk
      const r = fk.fromTable
      const m = api.getState().mappings.find(x => x.id === run.mapping.id)
      const isColRule = (rule) => rule.source?.t === 'rel' && rule.source.tableId === r.id && rule.target?.t === 'rel' && rule.target.tableId === rw.tableId
        && (() => { const own = Object.keys(rule.source.args).filter(f => !r.pk.some(k => k.fact.id === f)); return own.length === 1 && fk.from.some(c => c.fact.id === own[0]) })()
      const parts = m.rules.filter(isColRule)
      if (!parts.length) continue
      const first = parts[0]
      const keyArgs = Object.fromEntries(r.pk.map(k => [k.fact.id, first.source.args[k.fact.id]]))
      const names = new Set(Object.values(keyArgs).map(a => a?.y))
      const ys = fk.from.map(c => freeName(names, c.name))
      const source = { t: 'rel', tableId: r.id, args: { ...keyArgs, ...Object.fromEntries(fk.from.map((c, i) => [c.fact.id, { k: 'fv', y: ys[i] }])) } }
      const target = { t: 'rel', tableId: rw.tableId, args: { ...Object.fromEntries(r.pk.map(k => [id(k.fact.id), keyArgs[k.fact.id]])), ...Object.fromEntries(fk.from.map((c, i) => [id(c.fact.id), { k: 'fv', y: ys[i] }])) } }
      const merged = { id: uid(), name: `${r.name} refers to ${fk.toTable.name}`, source, target }
      const drop = new Set(parts.map(x => x.id))
      api.setState(st => ({ mappings: st.mappings.map(x => (x.id === m.id ? { ...x, rules: x.rules.flatMap(y => (y.id === first.id ? [merged] : drop.has(y.id) ? [] : [y])) } : x)) }))
    }
    let n = 0
    setRules(api, run.mapping.id, (rule) => {
      const target = mapRel(rule.target, (a) => {
        const vars = [], extra = []
        const args = { ...a.args }
        for (const rw of rewrites) {
          if (rw.tableId !== a.tableId || !rw.fromIds.some(f => args[f])) continue
          const v = { id: `sk${++n}`, typeId: sidVt }
          vars.push(v)
          const targs = { [sid]: { k: 'var', v: v.id } }
          rw.fromIds.forEach((f, i) => {
            if (!args[f]) return
            if (args[f].k === 'opt') throw new Error(`rule ${rule.name}: an optional foreign key column can't be rewritten yet`)
            targs[keyIds[rw.pos[i]]] = args[f]
            delete args[f]
          })
          args[rw.nc] = { k: 'var', v: v.id }
          extra.push({ t: 'rel', tableId: tId, args: targs })
        }
        return vars.length ? existsOf(vars, andOf([{ ...a, args }, ...extra])) : a
      })
      return target === rule.target ? rule : { ...rule, target }
    })
  },
}

// ── Surrogate key to natural key ────────────────────────────────────────────
// T(id, k, a) with k UNIQUE NOT NULL becomes T(k, a); a foreign key
// R(t_id) → T(id) becomes R(t_k) → T(k). In the rules the old side joins to
// T for k: R(…, t_id: $s) becomes R(…, t_id: s) ∧ T(id: s, k: $k).
const toNatural = {
  id: 'toNatural',
  label: 'Surrogate key → natural key',
  profile: 'relational',
  optionLabel: 'Table and key',
  none: 'No table with a one-column primary key has another key (UNIQUE, NOT NULL).',
  options: (ctx) => ctx.tables.filter(t => t.pk?.length === 1).flatMap(t => t.uniques.filter(u => u.every(c => c.notNull) && !u.includes(t.pk[0])).map(u => ({
    key: `${t.id}|${u.map(c => c.fact.id).join(',')}`, params: { tableId: t.id, keyIds: u.map(c => c.fact.id) },
    label: `${t.name}: ${t.pk[0].name} → ${u.map(c => c.name).join(', ')}` }))),
  describe: (p, ctx) => {
    const t = ctx.tableById.get(p.tableId)
    const key = (p.keyIds ?? []).map(f => colOf(ctx, f)).filter(Boolean)
    if (!t?.pk || !key.length) return 'Choose a table and its natural key.'
    const refs = fksToKey(ctx, t, t.pk)
    return `Make ${key.map(c => c.name).join(', ')} the primary key of ${t.name} and drop ${t.pk[0].name}`
      + (refs.length ? `; the foreign key${refs.length === 1 ? '' : 's'} ${refs.map(({ fk }) => `${fk.fromTable.name}(${fk.from[0].name})`).join(', ')} refer to ${key.map(c => c.name).join(', ')} instead.` : '.')
  },
  check: (p, ctx) => {
    const t = ctx.tableById.get(p.tableId)
    if (!t) return ['Choose a table.']
    const out = pkProblem(t)
    if (out.length) return out
    if (t.pk.length !== 1) return [`${t.name}'s key has more than one column.`]
    const key = (p.keyIds ?? []).map(f => colOf(ctx, f))
    if (!key.length || key.some(c => !c || c.table !== t)) return ['Choose the natural key.']
    if (key.some(c => !c.notNull)) out.push('The natural key may be NULL.')
    if (!t.uniques.some(u => u.length === key.length && u.every(c => key.includes(c)))) out.push(`${key.map(c => c.name).join(', ')} is not UNIQUE.`)
    const s = t.pk[0]
    if (t.fks.some(fk => fk.from.includes(s))) out.push(`${t.name}.${s.name} is a foreign key, so it is not a surrogate.`)
    if (t.fks.some(fk => fk.toTable === t && key.some(c => fk.to.includes(c)))) out.push(`${t.name} refers to its own natural key.`)
    out.push(...fkColumnProblems(ctx, fksToKey(ctx, t, t.pk), t))
    return out
  },
  edit(api, p, ctx, run) {
    const S = run.mapping.targetSchemaId, id = (x) => run.idMap.get(x)
    const t = ctx.tableById.get(p.tableId)
    const s = t.pk[0], key = p.keyIds.map(f => colOf(ctx, f))
    const tId = id(t.id), sId = id(s.fact.id), keyIds = key.map(c => id(c.fact.id))
    const refs = fksToKey(ctx, t, t.pk)
    // The UNIQUE that becomes the key.
    if (key.length > 1) {
      const same = (c) => c.constraintType === 'uniqueness' && !c.isPreferredIdentifier && c.sequences?.[0]?.length === key.length && c.sequences[0].every(m => keyIds.includes(m?.factId))
      for (const c of api.getState().constraints.filter(c => c.schemaId === S && same(c))) api.getState().deleteConstraint(c.id)
    }
    setPk(api, tId, keyIds)
    const rewrites = []
    for (const { fk } of refs) {
      const c = fk.from[0], r = fk.fromTable
      const rId = id(r.id), fromId = id(c.fact.id)
      const pkIds = (ctxOf(api, S).tableById.get(rId)?.pk ?? []).map(x => x.fact.id)
      dropColumn(api, fromId)
      const taken = new Set(ctxOf(api, S).tableById.get(rId).columns.map(x => x.name))
      const prefix = c.name === s.name ? t.name : c.name.endsWith(`_${s.name}`) ? c.name.slice(0, -(s.name.length + 1)) : c.name.replace(/_id$/i, '') || c.name
      const ncs = key.map((k, i) => addColumnTo(api, S, rId, freeName(taken, k.name.startsWith(`${prefix}_`) ? k.name : `${prefix}_${k.name}`), id(k.vt.id) ?? k.vt.id, { notNull: c.notNull }))
      if (pkIds.includes(fromId)) setPk(api, rId, pkIds.flatMap(f => (f === fromId ? ncs : [f])))
      const c2 = ctxOf(api, S)
      addFk(api, S, ncs.map(x => colOf(c2, x)), keyIds.map(x => colOf(c2, x)))
      rewrites.push({ tableId: rId, fromId, ncs })
      run.report.push(`${r.name}(${c.name}) → ${t.name} is now ${r.name}(${ncs.map(x => colOf(c2, x).name).join(', ')}) → ${t.name}(${key.map(k => k.name).join(', ')})`)
    }
    dropColumn(api, sId)
    run.report.push(`Dropped ${t.name}.${s.name}; ${key.map(k => k.name).join(', ')} is the primary key`)
    // The rules: the new side names k where it named the surrogate; the old
    // side joins to T for it, and keeps the surrogate as a variable.
    const ctxOld = ctx
    let n = 0
    setRules(api, run.mapping.id, (rule) => {
      const names = frontierNames([rule.source, rule.target])
      const fresh = (base) => { let y = base; for (let i = 2; names.has(y); i++) y = `${base}${i}`; names.add(y); return y }
      const keyOf = new Map()   // surrogate's frontier name → [key frontier names]
      const need = (arg, i) => {
        if (arg?.k !== 'fv') throw new Error(`rule ${rule.name}: ${s.name} is not given by a variable`)
        if (!keyOf.has(arg.y)) keyOf.set(arg.y, key.map(() => null))
        const ks = keyOf.get(arg.y)
        if (!ks[i]) ks[i] = fresh(key[i].name)
        return ks[i]
      }
      // A row of T that names its key too: those names.
      mapRel(rule.target, (a) => {
        if (a.tableId === tId && a.args[sId]?.k === 'fv') keyIds.forEach((k, i) => {
          if (a.args[k]?.k !== 'fv') return
          if (!keyOf.has(a.args[sId].y)) keyOf.set(a.args[sId].y, key.map(() => null))
          keyOf.get(a.args[sId].y)[i] ??= a.args[k].y
        })
        return a
      })
      let changed = false
      const target = mapRel(rule.target, (a) => {
        const args = { ...a.args }
        if (a.tableId === tId && args[sId]) {
          const arg = args[sId]
          delete args[sId]
          keyIds.forEach((k, i) => { if (!args[k]) args[k] = { k: 'fv', y: need(arg, i) } })
          changed = true
        }
        for (const rw of rewrites) {
          if (rw.tableId !== a.tableId || !args[rw.fromId]) continue
          const arg = args[rw.fromId]
          delete args[rw.fromId]
          rw.ncs.forEach((nc, i) => { args[nc] = { k: 'fv', y: need(arg, i) } })
          changed = true
        }
        return { ...a, args }
      })
      if (!changed) return rule
      // The old side: T's row for each surrogate gives its key.
      let source = rule.source
      const extra = []
      for (const [y, ks] of keyOf) {
        let merged = false
        source = mapRel(source, (a) => {
          if (merged || a.tableId !== t.id || a.args[s.fact.id]?.k !== 'fv' || a.args[s.fact.id].y !== y) return a
          if (key.some((k, i) => a.args[k.fact.id] && a.args[k.fact.id].y !== ks[i])) return a
          merged = true
          return { ...a, args: { ...a.args, ...Object.fromEntries(key.map((k, i) => [k.fact.id, { k: 'fv', y: ks[i] }])) } }
        })
        if (!merged) extra.push({ t: 'rel', tableId: t.id, args: { [s.fact.id]: { k: 'fv', y }, ...Object.fromEntries(key.map((k, i) => [k.fact.id, { k: 'fv', y: ks[i] }])) } })
      }
      if (extra.length) source = andOf([source, ...extra])
      // Values the new side no longer has: variables of the old side.
      const kept = frontierNames(target)
      const vars = new Map()
      source = mapRel(source, (a) => {
        const args = { ...a.args }
        for (const [f, arg] of Object.entries(args)) {
          if (arg?.k !== 'fv' || kept.has(arg.y)) continue
          if (!vars.has(arg.y)) vars.set(arg.y, { id: `ns${++n}`, typeId: colOf(ctxOld, f)?.vt.id })
          args[f] = { k: 'var', v: vars.get(arg.y).id }
        }
        return { ...a, args }
      })
      const left = [...frontierNames(source)].filter(y => !kept.has(y))
      if (left.length) throw new Error(`rule ${rule.name}: $${left[0]} is used outside a table row`)
      return { ...rule, source: existsOf([...vars.values()], source), target }
    })
    dropDuplicateRules(api, run)
  },
}

// Rules that say the same as an earlier one (the same patterns up to the
// names of their variables): left out.
function dropDuplicateRules(api, run) {
  const norm = (rule) => {
    const ids = new Map()
    return JSON.stringify([rule.source, rule.target], (k, v) => {
      if ((k === 'v' || k === 'id') && typeof v === 'string') { if (!ids.has(v)) ids.set(v, `v${ids.size}`); return ids.get(v) }
      return v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map(x => [x, v[x]])) : v
    })
  }
  const seen = new Map(), dropped = []
  const m = api.getState().mappings.find(x => x.id === run.mapping.id)
  const rules = m.rules.filter(r => {
    const k = norm(r)
    if (seen.has(k)) { dropped.push(`${r.name} (the same as ${seen.get(k)})`); return false }
    seen.set(k, r.name)
    return true
  })
  if (!dropped.length) return
  api.setState(s => ({ mappings: s.mappings.map(x => (x.id === m.id ? { ...x, rules } : x)) }))
  run.report.push(`Left out the rules ${dropped.join(', ')}`)
}

// ── Shared: new tables, and rules over them ─────────────────────────────────

// Where the new tables made next to a table go (a row below the diagram).
const placed = new WeakMap()

// A new table of schema S next to table `near` on the diagrams that show it.
function addTable(api, S, name, near) {
  const s = api.getState()
  const used = new Set(s.objectTypes.filter(o => o.schemaId === S).map(o => o.name))
  const e = { ...mkEntity((near?.x ?? 0) + 40, (near?.y ?? 0) + 40), name: freeName(used, name), schemaId: S }
  api.setState(st => ({ objectTypes: [...st.objectTypes, e], isDirty: true }))
  for (const d of api.getState().diagrams) {
    const occ = (d.occurrences ?? []).find(o => o.schemaElementId === near?.id)
    if (!occ) continue
    // Below everything on the diagram, side by side with the other new ones.
    const bottom = Math.max(...d.occurrences.map(o => o.y)) + 140
    const left = Math.min(...d.occurrences.map(o => o.x))
    const at = placed.get(near) ?? { n: 0, y: bottom }
    placed.set(near, at)
    try { api.getState().addElementToDiagram(e.id, d.id) } catch { continue }
    api.setState(st => ({ diagrams: st.diagrams.map(x => (x.id !== d.id ? x : { ...x, occurrences: x.occurrences.map(o => (o.schemaElementId === e.id ? { ...o, x: left + 420 * at.n, y: at.y } : o)) })) }))
  }
  if (placed.has(near)) placed.get(near).n++
  return e.id
}

// A copy of column c (of the new version) in table tableId: the same value
// type, NOT NULL, generation and value range.
function copyColumn(api, S, tableId, c, { name = c.name, notNull = c.notNull } = {}) {
  const f = addColumnTo(api, S, tableId, name, c.vt.id, { notNull, generated: c.generated })
  const vr = c.fact.roles[c.v].valueRange
  if (vr?.length) api.setState(st => ({ facts: st.facts.map(x => (x.id === f ? { ...x, roles: x.roles.map((r, i) => (i === 1 ? { ...r, valueRange: vr } : r)) } : x)) }))
  return f
}

// Drops a table of the new version with its columns.
function dropTable(api, S, tableId) {
  const t = ctxOf(api, S).tableById.get(tableId)
  for (const c of t?.columns ?? []) dropColumn(api, c.fact.id)
  for (const c of api.getState().constraints.filter(c => c.targetObjectTypeId === tableId)) api.getState().deleteConstraint(c.id)
  api.getState().deleteObjectType(tableId)
}

const exclusionOf = (api, S, seqs) => {
  const c = { id: uid(), constraintType: 'exclusion', schemaId: S, x: 0, y: 0, sequences: seqs.map(roleSeq), queries: seqs.map(() => null) }
  api.setState(s => ({ constraints: [...s.constraints, c] }))
  api.getState()._tryAutoGenerateQuery?.(c.id)
}
const slug = (v) => String(v).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'v'
const listValues = (c) => {
  if (isBoolean(c)) return ['true', 'false']
  const r = c?.fact.roles[c.v].valueRange?.length ? c.fact.roles[c.v].valueRange : c?.vt.valueRange ?? []
  return r.length && r.every(x => x.type === 'single') ? r.map(x => String(x.value)) : null
}
const referrers = (ctx, t) => ctx.tables.filter(x => x.id !== t.id && (x.fks ?? []).some(fk => fk.toTable.id === t.id))
const keyArgsOf = (t, names, map = (id) => id) => Object.fromEntries(t.pk.map((c, i) => [map(c.fact.id), { k: 'fv', y: names[i] }]))
const constArg = (v) => ({ k: 'const', text: String(v) })
function replaceRules(api, run, drop, add) {
  api.setState(s => ({ mappings: s.mappings.map(m => (m.id !== run.mapping.id ? m : { ...m, rules: [...m.rules.filter(r => !drop(r)), ...add] })) }))
}
const mentions = (tree, tableIds) => { let hit = false; mapRel(tree, a => { if (tableIds.has(a.tableId)) hit = true; return a }); return hit }

// ── Horizontal partitioning ─────────────────────────────────────────────────
// T(k, d, a) with d one of v1 … vn becomes T_v1(k, a), …, T_vn(k, a): the
// rows of T with d = vi, keys exclusive across the parts.
const partition = {
  id: 'partition',
  label: 'Partition a table by a column',
  profile: 'relational',
  optionLabel: 'Column',
  none: 'No table has a NOT NULL column with a list of values (a CHECK … IN, an enum or a boolean).',
  options: (ctx) => ctx.tables.flatMap(t => t.columns.filter(c => !c.pk && c.notNull && listValues(c)?.length > 1).map(c => ({
    key: `${t.id}|${c.fact.id}`, params: { tableId: t.id, columnId: c.fact.id }, label: `${t.name}.${c.name} (${listValues(c).join(', ')})` }))),
  describe: (p, ctx) => {
    const t = ctx.tableById.get(p.tableId), c = t?.columns.find(x => x.fact.id === p.columnId)
    return t && c ? `Replace ${t.name} by ${listValues(c)?.map(v => `${t.name}_${slug(v)}`).join(', ')}, one per value of ${c.name}, each with the other columns of ${t.name}.` : 'Choose a column.'
  },
  check: (p, ctx) => {
    const t = ctx.tableById.get(p.tableId), c = t?.columns.find(x => x.fact.id === p.columnId)
    if (!t || !c) return ['Choose a column.']
    const out = pkProblem(t)
    if (!c.notNull) out.push(`${c.name} may be NULL.`)
    if (!(listValues(c)?.length > 1)) out.push(`${c.name} has no list of values.`)
    const refs = referrers(ctx, t)
    if (refs.length) out.push(`${refs.map(x => x.name).join(', ')} refer${refs.length === 1 ? 's' : ''} to ${t.name}, which would then be in several tables.`)
    if (tableRulesOf(t.entity).length) out.push(`${t.name} has table rules.`)
    return out
  },
  edit(api, p, ctx, run) {
    const S = run.mapping.targetSchemaId, id = (x) => run.idMap.get(x)
    const t = ctx.tableById.get(p.tableId), d = t.columns.find(x => x.fact.id === p.columnId)
    const tN = ctxOf(api, S).tableById.get(id(t.id))
    const colN = (c) => tN.columns.find(x => x.fact.id === id(c.fact.id))
    const rest = t.columns.filter(c => c !== d)
    const keyNames = t.pk.map(c => c.name)
    const parts = [], rules = []
    for (const v of listValues(d)) {
      const pid = addTable(api, S, `${t.name}_${slug(v)}`, tN.entity)
      const cols = new Map(rest.map(c => [c.fact.id, copyColumn(api, S, pid, colN(c))]))
      setPk(api, pid, t.pk.map(c => cols.get(c.fact.id)))
      const c2 = ctxOf(api, S)
      const pt = c2.tableById.get(pid)
      for (const u of t.uniques) if (!u.includes(d)) addUnique(api, S, u.map(c => colOf(c2, cols.get(c.fact.id))))
      for (const fk of t.fks) if (!fk.from.includes(d)) addFk(api, S, fk.from.map(c => colOf(c2, cols.get(c.fact.id))), fk.to.map(c => colOf(c2, id(c.fact.id))))
      parts.push(pt)
      // T(k, d: v) ⟺ T_v(k), and T(k, d: v, a: $a) ⟺ T_v(k, a: $a).
      const own = { [d.fact.id]: constArg(v) }
      rules.push({ id: uid(), name: pt.name, source: { t: 'rel', tableId: t.id, args: { ...keyArgsOf(t, keyNames), ...own } }, target: { t: 'rel', tableId: pid, args: keyArgsOf(t, keyNames, (f) => cols.get(f)) } })
      for (const c of rest) {
        if (c.pk) continue
        const y = freeName(new Set(keyNames), c.name)
        rules.push({ id: uid(), name: `${pt.name} has ${c.name}`,
          source: { t: 'rel', tableId: t.id, args: { ...keyArgsOf(t, keyNames), ...own, [c.fact.id]: { k: 'fv', y } } },
          target: { t: 'rel', tableId: pid, args: { ...keyArgsOf(t, keyNames, (f) => cols.get(f)), [cols.get(c.fact.id)]: { k: 'fv', y } } } })
      }
      run.report.push(`Added ${pt.name}: the rows of ${t.name} with ${d.name} = ${v}`)
    }
    exclusionOf(api, S, parts.map(pt => pt.pk))
    if (t.uniques.some(u => !u.includes(d))) run.report.push(`The UNIQUE constraints of ${t.name} now hold in each part, not across them`)
    dropTable(api, S, tN.id)
    replaceRules(api, run, (r) => mentions(r.target, new Set([tN.id])), rules)
    run.report.push(`Dropped ${t.name}; the keys of its parts are exclusive`)
    return { carry: [...t.columns.map(c => c.fact.id), ...ctx.constraints.filter(c => c.constraintType === 'uniqueness' && c.sequences?.[0]?.some(m => t.columns.some(x => x.fact.id === m?.factId))).map(c => c.id)] }
  },
}

// ── Merge tables (horizontal) ───────────────────────────────────────────────
// T_1(k, a), …, T_n(k, a) with the same columns become T(k, d, a) with d
// the name of the table a row came from (part of the key unless the keys
// are exclusive).
const sig = (t) => JSON.stringify([t.pk?.map(c => c.name), t.columns.map(c => [c.name, c.vt.id]).sort()])
const mergeGroups = (ctx) => {
  const g = new Map()
  for (const t of ctx.tables) { if (!t.pk?.length) continue; const k = sig(t); if (!g.has(k)) g.set(k, []); g.get(k).push(t) }
  return [...g.values()].filter(x => x.length > 1)
}
const merge = {
  id: 'merge',
  label: 'Merge tables with the same columns',
  profile: 'relational',
  optionLabel: 'Tables',
  none: 'No two tables have the same columns and key.',
  nameLabel: 'New table',
  fields: [{ key: 'column', label: 'Type column' }],
  options: (ctx) => mergeGroups(ctx).map(ts => ({ key: ts.map(t => t.id).join(','), params: { tableIds: ts.map(t => t.id), column: 'kind' },
    label: ts.map(t => t.name).join(', '), name: commonPrefix(ts.map(t => t.name)) || `${ts[0].name}_all` })),
  describe: (p, ctx) => {
    const ts = (p.tableIds ?? []).map(x => ctx.tableById.get(x)).filter(Boolean)
    return ts.length ? `Replace ${ts.map(t => t.name).join(', ')} by one table ${p.name || '…'} with a column ${p.column || '…'} (${ts.map(mergeValues(ts)).join(', ')}) saying which of them a row was in.` : 'Choose the tables.'
  },
  check: (p, ctx) => {
    const ts = (p.tableIds ?? []).map(x => ctx.tableById.get(x))
    if (ts.length < 2 || ts.some(t => !t)) return ['Choose the tables.']
    const out = []
    if (new Set(ts.map(sig)).size > 1) out.push('The tables have different columns or keys.')
    if (ts.some(t => t.columns.some(c => c.name === p.column))) out.push(`A table already has a column ${p.column}.`)
    const n = p.name?.trim()
    if (!n) out.push('Give the new table a name.')
    else if (ctx.tables.some(x => x.name === n && !ts.includes(x))) out.push(`There is already a table ${n}.`)
    for (const t of ts) {
      const refs = referrers(ctx, t).filter(x => !ts.includes(x))
      if (refs.length) out.push(`${refs.map(x => x.name).join(', ')} refer${refs.length === 1 ? 's' : ''} to ${t.name}.`)
      if (tableRulesOf(t.entity).length) out.push(`${t.name} has table rules.`)
    }
    return out
  },
  edit(api, p, ctx, run) {
    const S = run.mapping.targetSchemaId, id = (x) => run.idMap.get(x)
    const ts = p.tableIds.map(x => ctx.tableById.get(x))
    const c0 = ctxOf(api, S)
    const tsN = ts.map(t => c0.tableById.get(id(t.id)))
    const first = tsN[0]
    // Exclusive keys: an exclusion constraint over the tables' keys.
    const keyRoles = (t) => new Set(t.pk.map(c => c.fact.id))
    const exclusive = ctx.constraints.some(c => c.constraintType === 'exclusion' && c.sequences?.length === ts.length
      && ts.every(t => c.sequences.some(q => q.length === t.pk.length && q.every(m => keyRoles(t).has(m?.factId)))))
    const mid = addTable(api, S, p.name.trim(), first.entity)
    const cols = new Map(first.columns.map(c => [c.name, copyColumn(api, S, mid, c, { notNull: tsN.every(t => t.columns.find(x => x.name === c.name)?.notNull) })]))
    const dName = p.column.trim()
    const dId = addColumnTo(api, S, mid, dName, null, { notNull: true, datatype: 'text' })
    const valueOf = mergeValues(ts)
    api.setState(st => ({ facts: st.facts.map(x => (x.id === dId ? { ...x, roles: x.roles.map((r, i) => (i === 1 ? { ...r, valueRange: ts.map(t => ({ type: 'single', value: valueOf(t) })) } : r)) } : x)) }))
    setPk(api, mid, [...first.pk.map(c => cols.get(c.name)), ...(exclusive ? [] : [dId])])
    const c2 = ctxOf(api, S)
    // Foreign keys every part has: once.
    for (const fk of first.fks) {
      const same = (t) => t.fks.some(x => x.toTable.id === fk.toTable.id && x.from.map(c => c.name).join() === fk.from.map(c => c.name).join() && x.to.every((c, i) => c === fk.to[i]))
      if (tsN.every(same)) addFk(api, S, fk.from.map(c => colOf(c2, cols.get(c.name))), fk.to)
      else run.report.push(`Not carried: the foreign key ${first.name}(${fk.from.map(c => c.name).join(', ')}), which not every table has`)
    }
    // The rules: a row of T_i is a row of T with d = T_i.
    const byId = new Map(tsN.map((t, i) => [t.id, ts[i]]))
    setRules(api, run.mapping.id, (rule) => {
      let changed = false
      const target = mapRel(rule.target, (a) => {
        const t = byId.get(a.tableId)
        if (!t) return a
        changed = true
        const tn = tsN[ts.indexOf(t)]
        const args = { [dId]: constArg(valueOf(t)) }
        for (const [f, arg] of Object.entries(a.args)) { const c = tn.columns.find(x => x.fact.id === f); if (c) args[cols.get(c.name)] = arg }
        return { t: 'rel', tableId: mid, args }
      })
      return changed ? { ...rule, target } : rule
    })
    for (const t of tsN) dropTable(api, S, t.id)
    run.report.push(`Merged ${ts.map(t => t.name).join(', ')} into ${p.name.trim()}; ${dName} says which table a row was in${exclusive ? '' : ` and is part of the key (no exclusion constraint says the keys are disjoint)`}`)
  },
}
// The type column's value for each table: its name without the common prefix.
function mergeValues(ts) {
  const pre = commonPrefix(ts.map(t => t.name))
  const vals = ts.map(t => (pre && t.name.length > pre.length + 1 ? t.name.slice(pre.length).replace(/^_+/, '') : t.name))
  const ok = new Set(vals).size === vals.length
  return (t) => (ok ? vals[ts.indexOf(t)] : t.name)
}
function commonPrefix(names) {
  let p = names[0] ?? ''
  for (const n of names) while (!n.startsWith(p)) p = p.slice(0, -1)
  return p.replace(/_+$/, '')
}

// ── Subtype tables to a type column ─────────────────────────────────────────
// U_1(k, b), …, U_n(k, c), each keyed by a foreign key to T(k, a), go into
// T(k, a, kind?, b?, c?): kind = U_i for the rows of U_i (NULL for rows in
// none of them).
const subtypeTables = (ctx, t) => ctx.tables.filter(u => u.id !== t.id && sameKeyTypes(u.pk, t.pk) && fkBetween(ctx, u, t))
const toTypeColumn = {
  id: 'toTypeColumn',
  label: 'Subtype tables → type column',
  profile: 'relational',
  optionLabel: 'Table',
  none: 'No table has subtype tables (tables whose key is a foreign key to its key).',
  nameLabel: 'Type column',
  options: (ctx) => ctx.tables.filter(t => t.pk?.length && subtypeTables(ctx, t).length).map(t => ({ key: t.id, params: { tableId: t.id },
    label: `${t.name}: ${subtypeTables(ctx, t).map(u => u.name).join(', ')}`, name: freeName(new Set(t.columns.map(c => c.name)), 'kind') })),
  describe: (p, ctx) => {
    const t = ctx.tableById.get(p.tableId)
    const us = t ? subtypeTables(ctx, t) : []
    return t ? `Move ${us.map(u => u.name).join(', ')} into ${t.name}, with a column ${p.name || '…'} saying which of them a row is in.` : 'Choose a table.'
  },
  check: (p, ctx) => {
    const t = ctx.tableById.get(p.tableId)
    if (!t) return ['Choose a table.']
    const us = subtypeTables(ctx, t)
    const out = []
    if (!us.length) out.push(`${t.name} has no subtype tables.`)
    const n = p.name?.trim()
    if (!n) out.push('Name the type column.')
    else if (t.columns.some(c => c.name === n)) out.push(`${t.name} already has a column ${n}.`)
    for (const u of us) {
      const refs = referrers(ctx, u).filter(x => x.id !== t.id)
      if (refs.length) out.push(`${refs.map(x => x.name).join(', ')} refer${refs.length === 1 ? 's' : ''} to ${u.name}.`)
      if (u.fks.some(fk => fk.toTable.id !== t.id && fk.from.some(c => c.pk))) out.push(`${u.name}'s key is also a foreign key to ${u.fks.find(fk => fk.toTable.id !== t.id).toTable.name}.`)
      if (tableRulesOf(u.entity).length) out.push(`${u.name} has table rules.`)
    }
    if (tableRulesOf(t.entity).length) out.push(`${t.name} has table rules.`)
    return out
  },
  edit(api, p, ctx, run) {
    const S = run.mapping.targetSchemaId, id = (x) => run.idMap.get(x)
    const t = ctx.tableById.get(p.tableId), us = subtypeTables(ctx, t)
    const tN = ctxOf(api, S).tableById.get(id(t.id))
    const usN = us.map(u => ctxOf(api, S).tableById.get(id(u.id)))
    const dName = p.name.trim()
    const dId = addColumnTo(api, S, tN.id, dName, null, { datatype: 'text' })
    api.setState(st => ({ facts: st.facts.map(x => (x.id === dId ? { ...x, roles: x.roles.map((r, i) => (i === 1 ? { ...r, valueRange: us.map(u => ({ type: 'single', value: u.name })) } : r)) } : x)) }))
    const taken = new Set([...tN.columns.map(c => c.name), dName])
    const colMap = new Map()   // column of U_i' → column of T'
    usN.forEach((u, i) => {
      u.pk.forEach((c, j) => colMap.set(c.fact.id, tN.pk[j].fact.id))
      for (const c of u.columns) {
        if (c.pk) continue
        const name = taken.has(c.name) ? freeName(taken, `${u.name}_${c.name}`) : freeName(taken, c.name)
        colMap.set(c.fact.id, copyColumn(api, S, tN.id, c, { name, notNull: false }))
      }
      const c2 = ctxOf(api, S)
      for (const fk of u.fks) if (!fk.from.some(c => c.pk)) addFk(api, S, fk.from.map(c => colOf(c2, colMap.get(c.fact.id))), fk.to)
      for (const q of u.uniques) if (!q.some(c => c.pk)) addUnique(api, S, q.map(c => colOf(c2, colMap.get(c.fact.id))))
      run.report.push(`Moved ${u.name} into ${tN.name}: its rows are those with ${dName} = ${us[i].name}`)
    })
    // The rules: a row of U_i is a row of T with kind = U_i.
    const byId = new Map(usN.map((u, i) => [u.id, us[i]]))
    setRules(api, run.mapping.id, (rule) => {
      let changed = false
      const target = mapRel(rule.target, (a) => {
        const u = byId.get(a.tableId)
        if (!u) return a
        changed = true
        const args = { [dId]: constArg(u.name) }
        for (const [f, arg] of Object.entries(a.args)) if (colMap.has(f)) args[colMap.get(f)] = arg
        return { t: 'rel', tableId: tN.id, args }
      })
      return changed ? { ...rule, target } : rule
    })
    for (const u of usN) dropTable(api, S, u.id)
    run.report.push(`A row in several of ${us.map(u => u.name).join(', ')} can't be written with one ${dName}: the equivalence check says so unless an exclusion constraint rules it out`)
    return { carry: us.flatMap(u => u.columns.filter(c => !c.pk).map(c => c.fact.id)) }
  },
}

// ── Type column to subtype tables ───────────────────────────────────────────
// T(k, kind?, a) with kind one of v1 … vn becomes T(k, a) and tables of
// keys T_v1(k), …, T_vn(k), each with a foreign key to T: the rows of T with
// that kind.
const toSubtypeTables = {
  id: 'toSubtypeTables',
  label: 'Type column → subtype tables',
  profile: 'relational',
  optionLabel: 'Type column',
  none: 'No table has a column with a list of values (a CHECK … IN or an enum).',
  options: (ctx) => ctx.tables.flatMap(t => t.columns.filter(c => !c.pk && !isBoolean(c) && listValues(c)?.length).map(c => ({
    key: `${t.id}|${c.fact.id}`, params: { tableId: t.id, columnId: c.fact.id }, label: `${t.name}.${c.name} (${listValues(c).join(', ')})` }))),
  describe: (p, ctx) => {
    const t = ctx.tableById.get(p.tableId), c = t?.columns.find(x => x.fact.id === p.columnId)
    return t && c ? `Replace ${t.name}.${c.name} by tables of keys ${listValues(c).map(v => slug(v)).join(', ')}, one per value, each with a foreign key to ${t.name}.` : 'Choose a column.'
  },
  check: (p, ctx) => {
    const t = ctx.tableById.get(p.tableId), c = t?.columns.find(x => x.fact.id === p.columnId)
    if (!t || !c) return ['Choose a column.']
    const out = pkProblem(t)
    if (!listValues(c)?.length) out.push(`${c.name} has no list of values.`)
    if (t.fks.some(fk => fk.from.includes(c)) || t.uniques.some(u => u.includes(c))) out.push(`${c.name} is in a foreign key or UNIQUE constraint.`)
    const used = new Set(ctx.tables.map(x => x.name))
    for (const v of listValues(c) ?? []) if (used.has(slug(v))) out.push(`There is already a table ${slug(v)}.`)
    if (tableRulesOf(t.entity).length) out.push(`${t.name} has table rules.`)
    return out
  },
  edit(api, p, ctx, run) {
    const S = run.mapping.targetSchemaId, id = (x) => run.idMap.get(x)
    const t = ctx.tableById.get(p.tableId), d = t.columns.find(x => x.fact.id === p.columnId)
    const tN = ctxOf(api, S).tableById.get(id(t.id))
    const keyNames = t.pk.map(c => c.name)
    const parts = [], rules = []
    for (const v of listValues(d)) {
      const uid2 = addTable(api, S, slug(v), tN.entity)
      const ks = tN.pk.map(c => copyColumn(api, S, uid2, c, { notNull: true }))
      setPk(api, uid2, ks)
      const c2 = ctxOf(api, S)
      const u = c2.tableById.get(uid2)
      addFk(api, S, u.pk, c2.tableById.get(tN.id).pk)
      parts.push(u)
      rules.push({ id: uid(), name: u.name, source: { t: 'rel', tableId: t.id, args: { ...keyArgsOf(t, keyNames), [d.fact.id]: constArg(v) } },
        target: { t: 'rel', tableId: uid2, args: Object.fromEntries(ks.map((f, i) => [f, { k: 'fv', y: keyNames[i] }])) } })
      run.report.push(`Added ${u.name}: the keys of the rows of ${t.name} with ${d.name} = ${v}`)
    }
    if (parts.length > 1) exclusionOf(api, S, parts.map(u => u.pk))
    const dN = id(d.fact.id)
    replaceRules(api, run, (r) => { let hit = false; mapRel(r.target, a => { if (a.args?.[dN]) hit = true; return a }); return hit }, rules)
    dropColumn(api, dN)
    run.report.push(`Dropped ${t.name}.${d.name}; the tables of keys say it, and their keys are exclusive`)
  },
}

export const TRANSFORMATIONS = [split, absorb, fkToTable, boolToTable, toSurrogate, toNatural, partition, merge, toTypeColumn, toSubtypeTables]
export const transformationById = (id) => TRANSFORMATIONS.find(x => x.id === id)
