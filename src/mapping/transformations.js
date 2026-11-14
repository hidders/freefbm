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
import { entriesOf } from './accounting.js'
import { formulaToRule } from '../logic/formulaToRule.js'
import { uid, mkConstraint, mkEntity, mkValue, mkFact, mkUniqueness, mkSubtype, mkImplicitLink, withMandatoryId } from '../store/storeHelpers.js'
import { valueKindName } from '../utils/datatypeValues.js'
import { defaultFrequencyPos } from '../utils/frequencyPlacement.js'
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

// ── ORM2 transformations ────────────────────────────────────────────────────
// The same way as the relational ones that edit: the new version is edited
// directly and the identity mapping's rules are rewritten with it. Patterns
// on the ORM2 side are ∃ over typed variables, fact atoms (args: variable
// ids), type atoms and x ≈ $y / x ≈ 'c'.

// The tree with each fact or type atom replaced by fn(atom).
function mapAtoms(tree, fn) {
  if (!tree || typeof tree !== 'object') return tree
  if (Array.isArray(tree)) return tree.map(x => mapAtoms(x, fn))
  if (tree.t === 'fact' || tree.t === 'type') return fn(tree)
  const out = {}
  for (const [k, v] of Object.entries(tree)) out[k] = v && typeof v === 'object' && (Array.isArray(v) || v.t) ? mapAtoms(v, fn) : v
  return out
}
// Variables of type `from` get type `to` (or `to(varId)` decides).
function retype(tree, from, to) {
  if (!tree || typeof tree !== 'object') return tree
  if (Array.isArray(tree)) return tree.map(x => retype(x, from, to))
  const out = {}
  for (const [k, v] of Object.entries(tree)) out[k] = v && typeof v === 'object' ? retype(v, from, to) : v
  if (['exists', 'forall', 'count'].includes(tree.t) && tree.v?.typeId === from) out.v = { ...tree.v, typeId: typeof to === 'function' ? to(tree.v.id) : to }
  return out
}
const varsOf = (tree, out = new Map()) => {
  if (!tree || typeof tree !== 'object') return out
  if (Array.isArray(tree)) { tree.forEach(x => varsOf(x, out)); return out }
  if (['exists', 'forall', 'count'].includes(tree.t) && tree.v) out.set(tree.v.id, tree.v.typeId)
  for (const v of Object.values(tree)) if (v && typeof v === 'object') varsOf(v, out)
  return out
}
// The pattern with more atoms about its first variable of type typeId,
// conjoined under its ∃s.
function conjoin(tree, typeId, extra) {
  const chain = []
  let node = tree
  while (node?.t === 'exists') { chain.push(node.v); node = node.body }
  const v = chain.find(x => x.typeId === typeId)
  if (!v) return null
  const body = andOf([...(node.t === 'and' ? node.args : [node]), ...extra(v.id)])
  return chain.reduceRight((b, x) => ({ t: 'exists', v: x, body: b }), body)
}
const factAtomOf = (factId, args) => ({ t: 'fact', factId, args })
const constIs = (id, text) => ({ t: 'vcmp', op: '≈', left: { t: 'var', id }, right: { t: 'const', text: String(text) } })
// The identity rule of an entity type: the smallest rule whose patterns
// start with a variable of that type.
function typeRuleOf(m, typeId) {
  return m.rules.filter(r => [...varsOf(r.source).values()][0] === typeId)
    .sort((a, b) => JSON.stringify(a.source).length - JSON.stringify(b.source).length)[0] ?? null
}
const pascal = (s) => String(s ?? '').trim().split(/[^A-Za-z0-9]+/).filter(Boolean).map(w => w[0].toUpperCase() + w.slice(1)).join('')
const readingOf = (f) => (f.readingParts ?? []).filter(Boolean).join(' … ')

// A new fact type of schema S, drawn next to the given object type on the
// diagrams that show it.
function addFactType(api, S, { roles, readingParts, uniqueness = [], mandatory = [] }, nearTypeId) {
  const s = api.getState()
  const f = { ...mkFact(0, 0, roles.length), schemaId: S, readingParts }
  f.roles = f.roles.map((r, i) => withMandatoryId({ ...r, objectTypeId: roles[i], mandatory: mandatory.includes(i) }))
  f.uniqueness = uniqueness.map(u => mkUniqueness(u))
  api.setState({ facts: [...s.facts, f], isDirty: true })
  for (const d of api.getState().diagrams) {
    const occ = (d.occurrences ?? []).find(o => o.schemaElementId === nearTypeId)
    if (!occ || d.schemaId !== S) continue
    try { api.getState().addElementToDiagram(f.id, d.id) } catch { continue }
    const n = (placedFacts.get(occ.id) ?? 0) + 1
    placedFacts.set(occ.id, n)
    api.setState(st => ({ diagrams: st.diagrams.map(x => (x.id !== d.id ? x : { ...x, occurrences: x.occurrences.map(o => (o.schemaElementId === f.id ? { ...o, x: occ.x - 40, y: occ.y + 70 + 50 * n } : o)) })) }))
  }
  return f.id
}
const placedFacts = new Map()
// Internal frequency markers of a fact type next to its first occurrence.
function placeFrequencies(api, S, factId) {
  const st = api.getState(), g = st.facts.find(x => x.id === factId)
  if (!g?.internalFrequency?.length) return
  const occ = st.diagrams.filter(d => d.schemaId === S).flatMap(d => d.occurrences ?? []).find(o => o.schemaElementId === factId)
  const at = { ...g, ...(occ ? { x: occ.x, y: occ.y } : {}) }
  api.setState(s2 => ({ facts: s2.facts.map(x => (x.id !== factId ? x : { ...x, internalFrequency: x.internalFrequency.map(q => ({ ...q, ...defaultFrequencyPos(at, q.roles) })) })) }))
}
// A fact type's occurrences moved halfway between the given types' (on the
// diagrams of schema S that show all three).
function placeBetween(api, S, factId, a, b) {
  api.setState(st => ({ diagrams: st.diagrams.map(d => {
    if (d.schemaId !== S) return d
    const occ = (id) => (d.occurrences ?? []).find(o => o.schemaElementId === id)
    const fo = occ(factId), ao = occ(a), bo = occ(b)
    if (!fo || !ao || !bo) return d
    return { ...d, occurrences: d.occurrences.map(o => (o.id === fo.id ? { ...o, x: Math.round((ao.x + bo.x) / 2), y: Math.round((ao.y + bo.y) / 2) } : o)) }
  }) }))
}
function addRoleConstraint(api, S, type, a, b) {
  const c = { ...mkConstraint(type, 0, 0), schemaId: S, sequences: [[a], [b]].map(q => q.map(([factId, roleIndex]) => ({ kind: 'role', factId, roleIndex }))), queries: [null, null] }
  api.setState(s => ({ constraints: [...s.constraints, c] }))
  api.getState()._tryAutoGenerateQuery?.(c.id)
  return c.id
}
const isFinite2 = (vt, role) => {
  if (!vt) return null
  if (valueKindName(vt.datatypeAssignment) === 'boolean' || /^bool/i.test(vt.datatypeAssignment?.datatypeId ?? '')) return ['true', 'false']
  const r = role?.valueRange?.length ? role.valueRange : vt.valueRange ?? []
  return r.length === 2 && r.every(x => x.type === 'single') ? r.map(x => String(x.value)) : null
}
const identifiedTypes = (ctx) => new Set(ctx.objectTypes.filter(o => o.kind === 'entity').map(o => o.id))

// ── Unary fact type to a boolean ────────────────────────────────────────────
// "E smokes" becomes "E has Smokes" with Smokes ∈ {true, false}, mandatory
// and one per E: true for the E that smoked, false for the others.

// ── Formula constraints through an ORM2 edit ────────────────────────────────
// (formulaToRule, logic/formulaToRule.js, gives a constraint's formula as a
// rule tree, so that it can be rewritten like the rules.)
// Element ids of the old version replaced by the new version's.
function renameIds(tree, idMap) {
  if (!tree || typeof tree !== 'object') return tree
  if (Array.isArray(tree)) return tree.map(x => renameIds(x, idMap))
  const out = {}
  for (const [k, v] of Object.entries(tree)) {
    if (k === 'typeId' && typeof v === 'string') out[k] = idMap.get(v) ?? v
    else if (k === 'factId' && typeof v === 'string') { const [f, il] = v.split('_il_'); out[k] = (idMap.get(f) ?? f) + (il != null ? `_il_${il}` : '') }
    else out[k] = renameIds(v, idMap)
  }
  return out
}
// The quantifiers of the given variables guarded: ∀v (g(v) → φ), ∃v (g(v) ∧ φ).
function guardVars(tree, vars, guard) {
  if (!tree || typeof tree !== 'object') return tree
  if (Array.isArray(tree)) return tree.map(x => guardVars(x, vars, guard))
  const out = {}
  for (const [k, v] of Object.entries(tree)) out[k] = v && typeof v === 'object' ? guardVars(v, vars, guard) : v
  if (!['forall', 'exists', 'count'].includes(tree.t) || !vars.has(tree.v?.id)) return out
  const g = guard(tree.v.id)
  out.body = tree.t !== 'forall' ? andOf([g, out.body])
    : out.body.t === 'implies' ? { ...out.body, left: andOf([g, out.body.left]) } : { t: 'implies', left: g, right: out.body }
  return out
}
// Formula constraints of the new version rewritten by rw.
function rewriteFormulas(api, S, rw) {
  api.setState(st => ({ constraints: st.constraints.map(c => (c.schemaId !== S || c.constraintType !== 'formula' || !c.rule ? c : { ...c, rule: rw(c.rule) })) }))
}
// The constraints `ids` of the old version, which the edit drops, added to
// the new version as formula constraints: their formulas with rw applied.
function carryFormulas(api, run, ids, rw) {
  if (!ids.length) return
  const keep = new Set(ids)
  for (const e of entriesOf(api.getState(), run.mapping.sourceSchemaId)) {
    if (e.possible || !keep.has(e.elementId) || !e.formula) continue
    const deontic = e.formula.t === 'obligatory'
    let rule
    try { rule = rw(renameIds(formulaToRule(deontic ? e.formula.arg : e.formula), run.idMap)) } catch (err) { run.report.push(`Not carried over: ${e.subject ?? e.kind} (${err.message})`); continue }
    api.getState().addCarriedConstraint(run.mapping.targetSchemaId, { rule, deontic,
      from: { mappingId: run.mapping.id, schemaId: run.mapping.sourceSchemaId, text: `${e.label ?? e.kind}${e.subject ? `: ${e.subject}` : ''}` } })
    run.report.push(`Added a formula constraint for ${e.label ?? e.kind}${e.subject ? `: ${e.subject}` : ''}`)
  }
}

// Formula constraints ∀x (∃ȳ F(…x…ȳ…) → U(x)) about the unary U turned back
// into subset constraints from F's role into U's.
function formulasToSubsets(api, S, u) {
  for (const c of api.getState().constraints.filter(x => x.schemaId === S && x.constraintType === 'formula' && !x.deontic)) {
    const r = c.rule
    if (r?.t !== 'forall' || r.body?.t !== 'implies') continue
    const x = r.v.id, right = r.body.right
    if (right?.t !== 'fact' || right.factId !== u || right.args[0] !== x) continue
    let left = r.body.left
    const own = []
    while (left?.t === 'exists') { own.push(left.v.id); left = left.body }
    if (left?.t !== 'fact' || left.factId.includes('_il_')) continue
    const args = left.args
    const at = args.indexOf(x)
    if (at < 0 || args.filter(a => a === x).length !== 1 || args.length !== own.length + 1 || !own.every(v => args.includes(v))) continue
    api.getState().deleteConstraint(c.id)
    addRoleConstraint(api, S, 'subset', [left.factId, at], [u, 0])
  }
}

// Constraints whose role sequences name a fact type.
const namingConstraints = (ctx, fid) => ctx.constraints.filter(c => (c.sequences ?? []).some(q => (q ?? []).some(m => m?.factId === fid))).map(c => c.id)
// "is a student" → IsStudent; "smokes" → Smokes.
const flagName = (reading) => pascal(reading.replace(/^(is|has)\s+(an?|the)\s+/i, '$1 ')) || 'Flag'
// IsStudent → "is student"; Smoker → "is smoker".
const unaryReading = (name) => {
  const w = name.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/_/g, ' ').toLowerCase().trim()
  return /^(is|has|can|does)\b/.test(w) ? w : `is ${w}`
}

const unaryToBoolean = {
  id: 'unaryToBoolean',
  label: 'Unary fact type → boolean',
  profile: 'orm2',
  optionLabel: 'Unary fact type',
  none: 'The schema has no unary fact type.',
  nameLabel: 'Value type',
  options: (ctx) => ctx.facts.filter(f => f.roles.length === 1 && !f.derivation && ctx.otById.get(f.roles[0].objectTypeId)?.kind === 'entity').map(f => ({
    key: f.id, params: { factId: f.id }, label: `${ctx.otById.get(f.roles[0].objectTypeId).name} ${readingOf(f)}`, name: flagName(readingOf(f)) })),
  describe: (p, ctx) => {
    const f = ctx.factById.get(p.factId), e = f && ctx.otById.get(f.roles[0].objectTypeId)
    return f ? `Replace "${e.name} ${readingOf(f)}" by "${e.name} has ${p.name || '…'}", true or false for every ${e.name}.` : 'Choose a unary fact type.'
  },
  check: (p, ctx) => {
    const f = ctx.factById.get(p.factId)
    if (!f || f.roles.length !== 1) return ['Choose a unary fact type.']
    const out = []
    if (f.objectified) out.push('The fact type is objectified.')
    if (f.derivation) out.push('The fact type is derived.')
    const n = p.name?.trim()
    if (!n) out.push('Name the value type.')
    else if (ctx.objectTypes.some(o => o.name === n && !(o.kind === 'value' && isFinite2(o)))) out.push(`There is already an object type ${n}.`)
    return out
  },
  edit(api, p, ctx, run) {
    const S = run.mapping.targetSchemaId, id = (x) => run.idMap.get(x)
    const f = ctx.factById.get(p.factId), e = ctx.otById.get(f.roles[0].objectTypeId)
    const uN = id(f.id), eN = id(e.id)
    const name = p.name.trim()
    let vt = api.getState().objectTypes.find(o => o.schemaId === S && o.kind === 'value' && o.name === name)
    if (!vt) {
      vt = { ...mkValue(0, 0), name, schemaId: S, valueRange: [{ type: 'single', value: 'true' }, { type: 'single', value: 'false' }] }
      api.setState(s => ({ objectTypes: [...s.objectTypes, vt] }))
    }
    const b = addFactType(api, S, { roles: [eN, vt.id], readingParts: ['', 'has', ''], uniqueness: [[0]], mandatory: [0] }, eN)
    const m = api.getState().mappings.find(x => x.id === run.mapping.id)
    const eRule = typeRuleOf(m, e.id)
    if (!eRule) throw new Error(`${e.name} has no identity rule`)
    let n = 0
    // U(x) is ∃v (x has v ∧ v ≈ true).
    const rw = (tree) => mapAtoms(tree, (a) => {
      if (a.t !== 'fact' || a.factId !== uN) return a
      const v = { id: `ub${++n}`, typeId: vt.id }
      return existsOf([v], andOf([factAtomOf(b, [a.args[0], v.id]), constIs(v.id, 'true')]))
    })
    setRules(api, run.mapping.id, (rule) => {
      const target = rw(rule.target)
      return target === rule.target ? rule : { ...rule, target }
    })
    rewriteFormulas(api, S, rw)
    carryFormulas(api, run, namingConstraints(ctx, f.id), rw)
    // false: an E that does not play the unary.
    const falseRule = { id: uid(), name: `${e.name} ${readingOf(f)}: false`,
      source: conjoin(eRule.source, e.id, (x) => [{ t: 'not', arg: factAtomOf(f.id, [x]) }]),
      target: conjoin(eRule.target, eN, (x) => { const v = { id: 'ubf', typeId: vt.id }; return [existsOf([v], andOf([factAtomOf(b, [x, v.id]), constIs(v.id, 'false')]))] }) }
    api.setState(s => ({ mappings: s.mappings.map(x => (x.id === run.mapping.id ? { ...x, rules: [...x.rules, falseRule] } : x)) }))
    dropColumn(api, uN)
    run.report.push(`Replaced ${e.name} ${readingOf(f)} by ${e.name} has ${name} (true or false, mandatory)`)
    return { carry: [f.id] }
  },
}

// ── Boolean to a unary fact type ────────────────────────────────────────────
// "E has Flag" with two values, mandatory and one per E, becomes the unary
// "E <reading>": the E with the chosen value.
const booleanToUnary = {
  id: 'booleanToUnary',
  label: 'Boolean → unary fact type',
  profile: 'orm2',
  optionLabel: 'Fact type',
  none: 'No fact type gives each entity one of two values (a boolean or two values), mandatory.',
  nameLabel: 'Unary reading',
  fields: [{ key: 'value', label: 'For the value' }],
  options: (ctx) => ctx.facts.flatMap(f => {
    if (f.roles.length !== 2 || f.derivation || f.objectified) return []
    const i = f.roles.findIndex(r => ctx.otById.get(r.objectTypeId)?.kind === 'entity')
    const vi = 1 - i, vt = ctx.otById.get(f.roles[vi]?.objectTypeId)
    const vals = i >= 0 && vt?.kind === 'value' ? isFinite2(vt, f.roles[vi]) : null
    if (!vals || !f.roles[i].mandatory || !(f.uniqueness ?? []).some(u => u.roles?.length === 1 && u.roles[0] === i)) return []
    const e = ctx.otById.get(f.roles[i].objectTypeId)
    return [{ key: f.id, params: { factId: f.id, value: vals[0] }, label: `${e.name} ${readingOf(f)} ${vt.name} (${vals.join(', ')})`, name: unaryReading(vt.name) }]
  }),
  describe: (p, ctx) => {
    const f = ctx.factById.get(p.factId)
    if (!f) return 'Choose a fact type.'
    const i = f.roles.findIndex(r => ctx.otById.get(r.objectTypeId)?.kind === 'entity'), e = ctx.otById.get(f.roles[i].objectTypeId)
    return `Replace it by the unary "${e.name} ${p.name || '…'}", true for the ${e.name} with ${p.value ?? '…'}.`
  },
  check: (p, ctx) => {
    const f = ctx.factById.get(p.factId)
    if (!f) return ['Choose a fact type.']
    const i = f.roles.findIndex(r => ctx.otById.get(r.objectTypeId)?.kind === 'entity')
    const vals = isFinite2(ctx.otById.get(f.roles[1 - i]?.objectTypeId), f.roles[1 - i])
    const out = []
    if (!vals) out.push('The value type does not have exactly two values.')
    else if (!vals.includes(String(p.value))) out.push(`Choose one of ${vals.join(', ')}.`)
    if (!f.roles[i]?.mandatory) out.push('The entity\'s role is not mandatory, so a missing value could not be told from the other value.')
    if (!p.name?.trim()) out.push('Give the unary a reading.')
    return out
  },
  edit(api, p, ctx, run) {
    const S = run.mapping.targetSchemaId, id = (x) => run.idMap.get(x)
    const f = ctx.factById.get(p.factId)
    const i = f.roles.findIndex(r => ctx.otById.get(r.objectTypeId)?.kind === 'entity')
    const e = ctx.otById.get(f.roles[i].objectTypeId), vt = ctx.otById.get(f.roles[1 - i].objectTypeId)
    const vals = isFinite2(vt, f.roles[1 - i]), other = vals.find(v => v !== String(p.value))
    const eN = id(e.id), bN = id(f.id)
    const u = addFactType(api, S, { roles: [eN], readingParts: ['', p.name.trim()], uniqueness: [[0]] }, eN)
    const m = api.getState().mappings.find(x => x.id === run.mapping.id)
    const eRule = typeRuleOf(m, e.id)
    if (!eRule) throw new Error(`${e.name} has no identity rule`)
    const withValue = (x, val) => { const v = { id: 'bv', typeId: vt.id }; const args = [null, null]; args[i] = x; args[1 - i] = v.id; return [existsOf([v], andOf([factAtomOf(f.id, args), constIs(v.id, val)]))] }
    const rules = [
      { id: uid(), name: `${e.name} ${p.name.trim()}`, source: conjoin(eRule.source, e.id, (x) => withValue(x, p.value)), target: conjoin(eRule.target, eN, (x) => [factAtomOf(u, [x])]) },
      { id: uid(), name: `${e.name} ${readingOf(f)} ${other}`, source: conjoin(eRule.source, e.id, (x) => withValue(x, other)), target: conjoin(eRule.target, eN, (x) => [{ t: 'not', arg: factAtomOf(u, [x]) }]) },
    ]
    replaceRules(api, run, (r) => JSON.stringify(r.target).includes(`"${bN}"`), rules)
    // In formulas: ∃v (x has v ∧ v ≈ c) is U(x) or ¬U(x); any other x has v
    // is (U(x) ∧ v ≈ value) ∨ (¬U(x) ∧ v ≈ other).
    const vtN = id(vt.id)
    const isB = (a) => a?.t === 'fact' && a.factId === bN
    const conj = (x) => (x?.t === 'and' ? x.args : [x])
    const holds = (x, val) => (String(val) === String(p.value) ? factAtomOf(u, [x]) : { t: 'not', arg: factAtomOf(u, [x]) })
    const fold = (tree) => {
      if (!tree || typeof tree !== 'object') return tree
      if (Array.isArray(tree)) return tree.map(fold)
      const out = {}
      for (const [k, v] of Object.entries(tree)) out[k] = v && typeof v === 'object' ? fold(v) : v
      if (out.t !== 'exists') return out
      const v = out.v.id, parts = conj(out.body)
      const b = parts.find(a => isB(a) && a.args[1 - i] === v)
      const c = parts.find(a => a?.t === 'vcmp' && a.op === '≈' && a.left?.t === 'var' && a.left.id === v && a.right?.t === 'const')
      if (!b || !c) return out
      const rest = parts.filter(a => a !== b && a !== c)
      if (JSON.stringify(rest).match(new RegExp(`"(id|arg)":"${v}"|"${v}"[,\\]]`))) return out
      return andOf([...rest, holds(b.args[i], c.right.text)])
    }
    const rw = (tree) => mapAtoms(fold(tree), (a) => (!isB(a) ? a : { t: 'or', args: [
      andOf([factAtomOf(u, [a.args[i]]), { t: 'vcmp', op: '≈', left: { t: 'var', id: a.args[1 - i] }, right: { t: 'const', text: String(p.value) } }]),
      andOf([{ t: 'not', arg: factAtomOf(u, [a.args[i]]) }, { t: 'vcmp', op: '≈', left: { t: 'var', id: a.args[1 - i] }, right: { t: 'const', text: other } }]),
    ] }))
    rewriteFormulas(api, S, rw)
    carryFormulas(api, run, namingConstraints(ctx, f.id), rw)
    formulasToSubsets(api, S, u)
    const stillVt = JSON.stringify(api.getState().constraints.filter(c => c.schemaId === S && c.constraintType === 'formula').map(c => c.rule)).includes(`"${vtN}"`)
    dropColumn(api, bN)
    if (stillVt && !api.getState().objectTypes.some(o => o.id === vtN)) api.setState(st => ({ objectTypes: [...st.objectTypes, { ...vt, id: vtN, schemaId: S }] }))
    run.report.push(`Replaced ${e.name} ${readingOf(f)} ${vt.name} by the unary ${e.name} ${p.name.trim()} (${p.value}; ${other} when it does not hold)`)
    return { carry: [f.id] }
  },
}

// ── Subtype to a unary fact type ────────────────────────────────────────────
// Subtype S of E becomes the unary "E is a S"; S's roles go to E, each with
// a subset constraint into the unary (an equality when it was mandatory).
const subtypeToUnary = {
  id: 'subtypeToUnary',
  label: 'Subtype → unary fact type',
  profile: 'orm2',
  optionLabel: 'Subtype',
  none: 'The schema has no subtype with one supertype and no subtypes of its own.',
  nameLabel: 'Unary reading',
  options: (ctx) => ctx.subtypes.filter(st => okSubtype(ctx, st.subId)).map(st => {
    const s = ctx.otById.get(st.subId), e = ctx.otById.get(st.superId)
    return { key: st.id, params: { subtypeId: st.subId }, label: `${s.name} (of ${e.name})`, name: `is a ${s.name.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase()}` }
  }),
  describe: (p, ctx) => {
    const s = ctx.otById.get(p.subtypeId), st = ctx.subtypes.find(x => x.subId === p.subtypeId), e = st && ctx.otById.get(st.superId)
    return s && e ? `Replace the subtype ${s.name} by the unary "${e.name} ${p.name || '…'}"; ${s.name}'s roles go to ${e.name}, only for those it holds for.` : 'Choose a subtype.'
  },
  check: (p, ctx) => {
    const s = ctx.otById.get(p.subtypeId)
    if (!s) return ['Choose a subtype.']
    const out = []
    if (!okSubtype(ctx, s.id)) out.push(`${s.name} must have one supertype, no subtypes of its own, its supertype's identifier, and no derivation rule.`)
    if (!p.name?.trim()) out.push('Give the unary a reading.')
    return out
  },
  edit(api, p, ctx, run) {
    const S = run.mapping.targetSchemaId, id = (x) => run.idMap.get(x)
    const s = ctx.otById.get(p.subtypeId), st = ctx.subtypes.find(x => x.subId === s.id), e = ctx.otById.get(st.superId)
    const sN = id(s.id), eN = id(e.id), stN = id(st.id)
    const u = addFactType(api, S, { roles: [eN], readingParts: ['', p.name.trim()], uniqueness: [[0]] }, eN)
    // S's roles: to E, inside the unary.
    const moved = []
    for (const f of api.getState().facts.filter(x => x.schemaId === S && x.id !== u)) f.roles.forEach((r, i) => { if (r.objectTypeId === sN) moved.push({ f, i, mandatory: !!r.mandatory }) })
    api.setState(s2 => ({ facts: s2.facts.map(f => (moved.some(x => x.f.id === f.id) ? { ...f, roles: f.roles.map(r => (r.objectTypeId === sN ? withMandatoryId({ ...r, objectTypeId: eN, mandatory: false }) : r)) } : f)) }))
    for (const x of moved) addRoleConstraint(api, S, x.mandatory ? 'equality' : 'subset', [x.f.id, x.i], [u, 0])
    // Constraints over the subtype link (an inclusive- or exclusive-or of
    // subtypes) name the unary instead.
    swapMembers(api, S, (m) => m?.kind === 'subtype' && m.subtypeId === stN, { kind: 'role', factId: u, roleIndex: 0 })
    // The diagrams: the unary where S was drawn; S's occurrences give way to E's.
    api.setState(st2 => ({ diagrams: st2.diagrams.map(d => {
      const so = d.schemaId === S && (d.occurrences ?? []).find(o => o.schemaElementId === sN)
      return !so ? d : { ...d, occurrences: d.occurrences.map(o => (o.schemaElementId === u ? { ...o, x: so.x, y: so.y } : o)) }
    }) }))
    redirectOccurrences(api, S, sN, eN, stN)
    api.getState().deleteObjectType(sN)
    let n = 0
    rewriteFormulas(api, S, (tree) => {
      const was = new Set([...varsOf(tree)].filter(([, t]) => t === sN).map(([v]) => v))
      return guardVars(retype(mapAtoms(tree, (a) => (a.t === 'type' && a.typeId === sN ? factAtomOf(u, [a.arg]) : a)), sN, eN), was, (v) => factAtomOf(u, [v]))
    })
    setRules(api, run.mapping.id, (rule) => {
      let target = mapAtoms(rule.target, (a) => (a.t === 'type' && a.typeId === sN ? factAtomOf(u, [a.arg]) : a))
      // A variable that was an S is an E for which the unary holds.
      const was = [...varsOf(rule.target)].filter(([, t]) => t === sN).map(([v]) => v)
      target = retype(target, sN, eN)
      for (const v of was) if (!JSON.stringify(target).includes(`"factId":"${u}","args":["${v}"]`)) target = conjoin(target, eN, () => [factAtomOf(u, [v])]) ?? target
      return target === rule.target ? rule : { ...rule, target }
    })
    run.report.push(`Replaced the subtype ${s.name} by ${e.name} ${p.name.trim()}; ${moved.length} role${moved.length === 1 ? '' : 's'} of ${s.name} moved to ${e.name} with a subset or equality constraint into it`)
    // A moved fact type that now reads like another of E's.
    const sig = (g) => JSON.stringify([g.roles.map(r => r.objectTypeId), (g.readingParts ?? []).map(x => (x ?? '').trim())])
    const facts = api.getState().facts.filter(g => g.schemaId === S)
    for (const x of moved) {
      const g = facts.find(y => y.id === x.f.id)
      if (g && facts.some(y => y.id !== g.id && sig(y) === sig(g))) run.report.push(`${e.name} ${readingOf(g)} now reads like another fact type of ${e.name}; rename one of them`)
    }
    return { carry: [s.id, ...ctx.constraints.filter(c => (c.subtypeIds ?? []).includes(st.id)).map(c => c.id)] }
  },
}
// Members of constraint sequences that match `is` replaced by `by`.
function swapMembers(api, S, is, by, only = () => true) {
  const changed = []
  api.setState(st => ({ constraints: st.constraints.map(c => {
    if (c.schemaId !== S || !only(c) || !(c.sequences ?? []).some(q => (q ?? []).some(is))) return c
    changed.push(c.id)
    const sequences = c.sequences.map(q => (q ?? []).map(m => (is(m) ? (typeof by === 'function' ? by(m) : by) : m)))
    // Join paths name the old members: made again from the new ones.
    return { ...c, sequences, queries: (c.queries ?? sequences.map(() => null)).map((x, i) => ((c.sequences[i] ?? []).some(is) ? null : x)) }
  }) }))
  for (const id of changed) api.getState()._tryAutoGenerateQuery?.(id)
}
// A constraint whose sequences are single members: a unary's role and the
// subtype it becomes may stand for each other in it.
const swappable = (c) => !!c && (c.sequences ?? []).every(q => (q ?? []).length <= 1)
function okSubtype(ctx, sid) {
  const ups = ctx.subtypes.filter(x => x.subId === sid)
  const s = ctx.otById.get(sid)
  return ups.length === 1 && !ctx.subtypes.some(x => x.superId === sid) && !s?.derivation && ups[0].inheritsPreferredIdentifier !== false
    && ctx.otById.get(ups[0].superId)?.kind === 'entity'
}
// On every diagram of schema S, occurrences of `from` are replaced by one of
// `to` (the supertype end of the subtype link when drawn, else any, else a
// new one), and the roles drawn to them follow.
function redirectOccurrences(api, S, from, to, subtypeId) {
  for (const d of api.getState().diagrams.filter(x => x.schemaId === S)) {
    const occs = (d.occurrences ?? []).filter(o => o.schemaElementId === from)
    if (!occs.length) continue
    let target = d.subtypeEndpointOccs?.[subtypeId]?.[0]?.superOccId ?? d.occurrences.find(o => o.schemaElementId === to)?.id
    if (!target) {
      try { api.getState().addElementToDiagram(to, d.id) } catch { continue }
      target = api.getState().diagrams.find(x => x.id === d.id).occurrences.find(o => o.schemaElementId === to)?.id
    }
    const ids = new Set(occs.map(o => o.id))
    api.setState(st => ({ diagrams: st.diagrams.map(x => (x.id !== d.id ? x : { ...x, occurrences: x.occurrences.map(o => (o.roleOccurrenceMap
      ? { ...o, roleOccurrenceMap: Object.fromEntries(Object.entries(o.roleOccurrenceMap).map(([k, v]) => [k, ids.has(v) ? target : v])) } : o)) })) }))
  }
}

// ── Objectified fact type to an entity type (flatten) ───────────────────────
// The objectified F(A1, …, An), nested as N, becomes the entity type N with
// the binaries "N involves Ai" (N's role mandatory and unique), N identified
// by the roles of F's preferred (else first) uniqueness constraint. F's other
// constraints move to the Ai roles of the binaries; those over several of
// F's roles at once become formula constraints.
const ilOf = (fid) => { const m = /^(.*)_il_(\d+)$/.exec(fid ?? ''); return m ? { factId: m[1], i: +m[2] } : null }
function keyUcOf(f) {
  const pref = f.objectifiedIdentifier ?? (f.preferredUniqueness ?? [])[0]
  const same = (a, b) => a.length === b.length && a.every(x => b.includes(x))
  return (pref && f.uniqueness.find(u => same(u.roles, pref))) ?? f.uniqueness?.[0] ?? null
}
const ownIdentifier = (ctx, typeId) => ctx.facts.some(g => (g.preferredUniqueness ?? []).length && g.roles.length === 2 && g.roles.some((r, i) => r.objectTypeId === typeId && (g.preferredUniqueness ?? []).some(u => u.length === 1 && u[0] === 1 - i)))
  || ctx.constraints.some(c => c.constraintType === 'uniqueness' && c.isPreferredIdentifier && c.targetObjectTypeId === typeId)
function flattenProblems(ctx, f) {
  const out = []
  if (!f?.objectified || f.objectifiedKind === 'value') return ['Choose an objectified fact type.']
  if (f.derivation || f.derivationRule) out.push('The fact type is derived.')
  if (!keyUcOf(f)) out.push('The fact type has no uniqueness constraint.')
  if (f.roles.some(r => !r.objectTypeId || r.objectTypeId === f.id)) out.push('A role has no player, or the nested type plays a role of its own fact type.')
  if (ownIdentifier(ctx, f.id)) out.push(`${f.objectifiedName} has an identifier of its own.`)
  if ((f.internalFrequency ?? []).some(q => q.roles.length > 1)) out.push('A frequency constraint spans several roles.')
  return out
}
const flatten = {
  id: 'flatten',
  label: 'Objectified fact type → entity type',
  profile: 'orm2',
  optionLabel: 'Objectified fact type',
  none: 'The schema has no objectified fact type that could become an entity type.',
  options: (ctx) => ctx.facts.filter(f => f.objectified && !flattenProblems(ctx, f).length).map(f => ({
    key: f.id, params: { factId: f.id }, label: `${f.objectifiedName} (${f.roles.map(r => ctx.otById.get(r.objectTypeId)?.name ?? ctx.factById.get(r.objectTypeId)?.objectifiedName).join(' ' + readingOf(f) + ' ')})` })),
  describe: (p, ctx) => {
    const f = ctx.factById.get(p.factId)
    if (!f) return 'Choose an objectified fact type.'
    const k = keyUcOf(f)
    const nm = (i) => ctx.otById.get(f.roles[i].objectTypeId)?.name ?? ctx.factById.get(f.roles[i].objectTypeId)?.objectifiedName
    return `Replace the objectified fact type ${f.objectifiedName} by an entity type with ${f.roles.length} fact types "${f.objectifiedName} involves …", identified by its ${k ? k.roles.map(nm).join(' and ') : '…'}.`
  },
  check: (p, ctx) => flattenProblems(ctx, ctx.factById.get(p.factId)),
  edit(api, p, ctx, run) {
    const S = run.mapping.targetSchemaId, id = (x) => run.idMap.get(x)
    const f = ctx.factById.get(p.factId), fN = id(f.id)
    const fNew = api.getState().facts.find(x => x.id === fN)
    const n = { ...mkEntity(0, 0), name: f.objectifiedName, schemaId: S, ...(fNew.isIndependent ? { isIndependent: true } : {}),
      ...(fNew.cardinalityRange ? { cardinalityRange: fNew.cardinalityRange } : {}),
      ...(fNew.lexicon ? { lexicon: Object.fromEntries(Object.entries(fNew.lexicon).map(([l, x]) => [l, Object.fromEntries(Object.entries(x).filter(([k]) => k !== 'readings'))])) } : {}) }
    api.setState(st => ({ objectTypes: [...st.objectTypes, n], isDirty: true }))
    // N where F is drawn.
    const occOf = new Map()   // diagram id → [F's occurrence id, N's]
    for (const d of api.getState().diagrams.filter(x => x.schemaId === S)) {
      const fo = (d.occurrences ?? []).find(o => o.schemaElementId === fN)
      if (!fo) continue
      try { api.getState().addElementToDiagram(n.id, d.id) } catch { continue }
      const no = api.getState().diagrams.find(x => x.id === d.id).occurrences.find(o => o.schemaElementId === n.id)
      occOf.set(d.id, [fo.id, no.id])
      api.setState(st => ({ diagrams: st.diagrams.map(x => (x.id !== d.id ? x : { ...x, occurrences: x.occurrences.map(o => (o.id === no.id ? { ...o, x: fo.x, y: fo.y } : o)) })) }))
    }
    // Roles played by N, subtype links of N: to the entity type.
    api.setState(st => ({
      facts: st.facts.map(g => (g.schemaId !== S || !g.roles.some(r => r.objectTypeId === fN) ? g : { ...g, roles: g.roles.map(r => (r.objectTypeId === fN ? { ...r, objectTypeId: n.id } : r)) })),
      subtypes: st.subtypes.map(x => (x.schemaId !== S ? x : { ...x, ...(x.superId === fN ? { superId: n.id } : {}), ...(x.subId === fN ? { subId: n.id } : {}) })),
      diagrams: st.diagrams.map(d => {
        const oo = occOf.get(d.id)
        return !oo ? d : { ...d, occurrences: d.occurrences.map(o => (o.roleOccurrenceMap && o.schemaElementId !== fN
          ? { ...o, roleOccurrenceMap: Object.fromEntries(Object.entries(o.roleOccurrenceMap).map(([k, v]) => [k, v === oo[0] ? oo[1] : v])) } : o)) }
      }),
    }))
    // The binaries.
    const key = keyUcOf(fNew)
    const L = fNew.roles.map((r, i) => {
      const il = fNew.implicitLinks?.[i]
      const single = (fNew.uniqueness ?? []).some(u => u.roles.length === 1 && u.roles[0] === i)
      const lid = addFactType(api, S, { roles: [n.id, r.objectTypeId], readingParts: il?.readingParts ?? ['', 'involves', ''], uniqueness: [[0], ...(single ? [[1]] : [])], mandatory: [0, ...(r.mandatory ? [1] : [])] }, n.id)
      const freq = (fNew.internalFrequency ?? []).filter(q => q.roles.length === 1 && q.roles[0] === i)
      api.setState(st => ({ facts: st.facts.map(g => (g.id !== lid ? g : {
        ...g, alternativeReadings: il?.alternativeReadings ?? [], ...(il?.lexicon ? { lexicon: il.lexicon } : {}),
        roles: g.roles.map((x, j) => (j === 1 ? { ...x, ...(r.valueRange ? { valueRange: r.valueRange } : {}), ...(r.roleName ? { roleName: r.roleName } : {}) } : x)),
        internalFrequency: freq.map(q => ({ ...q, id: uid(), roles: [1] })),
        ...(key?.roles.length === 1 && key.roles[0] === i ? { preferredUniqueness: [[1]] } : {}),
      })) }))
      placeBetween(api, S, lid, n.id, r.objectTypeId)
      placeFrequencies(api, S, lid)
      return lid
    })
    // Uniqueness over several roles: external, over the binaries' Ai roles.
    for (const u of fNew.uniqueness ?? []) {
      if (u.roles.length < 2) continue
      const c = { ...mkConstraint('uniqueness', 0, 0), schemaId: S, isPreferredIdentifier: u === key, targetObjectTypeId: n.id,
        sequences: [u.roles.map(i => ({ kind: 'role', factId: L[i], roleIndex: 1 }))], queries: [null] }
      api.setState(st => ({ constraints: [...st.constraints, c] }))
      api.getState()._tryAutoGenerateQuery?.(c.id)
    }
    // Constraints on F's roles: on the binaries' (one role at a time), else
    // carried as formulas.
    const names = (c) => (c.sequences ?? []).some(q => (q ?? []).some(m => m?.factId === fN || ilOf(m?.factId)?.factId === fN))
    const several = (c) => (c.sequences ?? []).some(q => (q ?? []).length > 1 && q.some(m => m?.factId === fN))
    const tgt = api.getState().constraints.filter(c => c.schemaId === S && names(c))
    const carried = tgt.filter(several)
    for (const c of carried) api.getState().deleteConstraint(c.id)
    swapMembers(api, S, (m) => m?.factId === fN || ilOf(m?.factId)?.factId === fN,
      (m) => (m.factId === fN ? { kind: 'role', factId: L[m.roleIndex], roleIndex: 1 } : { kind: 'role', factId: L[ilOf(m.factId).i], roleIndex: m.roleIndex }))
    // Rules and formulas: F(x̄) is ∃n (n involves x1 ∧ … ∧ n involves xn).
    let k = 0
    const rw = (tree) => retype(mapAtoms(tree, (a) => {
      if (a.t === 'type') return a.typeId === fN ? { ...a, typeId: n.id } : a
      if (a.factId === fN) { const v = { id: `fl${++k}`, typeId: n.id }; return existsOf([v], andOf(a.args.map((x, i) => factAtomOf(L[i], [v.id, x])))) }
      const il = ilOf(a.factId)
      return il?.factId === fN ? factAtomOf(L[il.i], a.args) : a
    }), fN, n.id)
    setRules(api, run.mapping.id, (rule) => { const target = rw(rule.target); return JSON.stringify(target) === JSON.stringify(rule.target) ? rule : { ...rule, target } })
    rewriteFormulas(api, S, rw)
    api.setState(st => ({
      facts: st.facts.map(g => (g.schemaId === S && g.derivationRule ? { ...g, derivationRule: rw(g.derivationRule) } : g)),
      objectTypes: st.objectTypes.map(o => (o.schemaId === S && o.derivationRule ? { ...o, derivationRule: rw(o.derivationRule) } : o)),
    }))
    carryFormulas(api, run, carried.map(c => [...run.idMap].find(([, v]) => v === c.id)?.[0]).filter(Boolean), rw)
    api.getState().deleteFact(fN)
    run.report.push(`Replaced the objectified fact type ${f.objectifiedName} by the entity type ${n.name} with ${L.length} fact types involving ${fNew.roles.map(r => api.getState().objectTypes.find(o => o.id === r.objectTypeId)?.name ?? '?').join(', ')}`)
    return { carry: [f.id] }
  },
}

// ── Entity type to an objectified fact type (objectify) ─────────────────────
// The reverse of flatten: an entity type N identified by an external
// uniqueness constraint over the far roles of binaries "N involves Ai"
// (N's role mandatory and unique) becomes the objectified fact type
// F(A1, …, An) nested as N; the binaries are F's implied links.
function objectifyPlan(ctx, typeId) {
  const n = ctx.otById.get(typeId)
  if (!n || n.kind !== 'entity' || n.derivationRule) return null
  const pi = ctx.constraints.find(c => c.constraintType === 'uniqueness' && c.isPreferredIdentifier && c.targetObjectTypeId === typeId && c.sequences?.length === 1)
  const members = pi?.sequences[0] ?? []
  if (members.length < 2) return null
  const parts = members.map(m => {
    const f = ctx.factById.get(m?.factId)
    if (!f || f.roles.length !== 2 || f.derivationRule || f.objectified) return null
    const ni = 1 - m.roleIndex
    const r = f.roles[ni]
    if (r.objectTypeId !== typeId || !r.mandatory || !(f.uniqueness ?? []).some(u => u.roles.length === 1 && u.roles[0] === ni)) return null
    if (f.roles[m.roleIndex].objectTypeId === typeId) return null
    return { f, ni, ai: m.roleIndex }
  })
  if (parts.some(x => !x) || new Set(parts.map(x => x.f.id)).size !== parts.length) return null
  return { n, pi, parts }
}
const objectify = {
  id: 'objectify',
  label: 'Entity type → objectified fact type',
  profile: 'orm2',
  optionLabel: 'Entity type',
  none: 'No entity type is identified by fact types "… involves …" with its role mandatory and unique.',
  nameLabel: 'Reading (… for each role)',
  options: (ctx) => ctx.objectTypes.filter(o => o.kind === 'entity').map(o => objectifyPlan(ctx, o.id)).filter(Boolean).map(pl => ({
    key: pl.n.id, params: { typeId: pl.n.id }, label: `${pl.n.name} (${pl.parts.map(x => ctx.otById.get(x.f.roles[x.ai].objectTypeId)?.name ?? ctx.factById.get(x.f.roles[x.ai].objectTypeId)?.objectifiedName).join(', ')})`,
    name: pl.parts.length === 2 ? '… with …' : pl.parts.map(() => '…').join(' with ') })),
  describe: (p, ctx) => {
    const pl = objectifyPlan(ctx, p.typeId)
    return pl ? `Replace ${pl.n.name} and its ${pl.parts.length} identifying fact types by the objectified fact type "${p.name || '…'}", nested as ${pl.n.name}.` : 'Choose an entity type.'
  },
  check: (p, ctx) => {
    const pl = objectifyPlan(ctx, p.typeId)
    if (!pl) return ['Choose an entity type identified by fact types "… involves …" with its role mandatory and unique.']
    const out = []
    if ((p.name ?? '').split('…').length !== pl.parts.length + 1) out.push(`Write the reading with ${pl.parts.length} … (one for each role).`)
    if (ctx.subtypes.some(st => st.subId === pl.n.id)) out.push(`${pl.n.name} is a subtype.`)
    return out
  },
  edit(api, p, ctx, run) {
    const S = run.mapping.targetSchemaId, id = (x) => run.idMap.get(x)
    const pl = objectifyPlan(ctx, p.typeId)
    const nN = id(pl.n.id), nNew = api.getState().objectTypes.find(o => o.id === nN)
    const Ls = pl.parts.map(x => ({ ...x, id: id(x.f.id), g: api.getState().facts.find(g => g.id === id(x.f.id)) }))
    const k = Ls.length
    // F, with the binaries' far roles.
    const f = { ...mkFact(0, 0, k), schemaId: S }
    f.readingParts = p.name.split('…').map(x => x.trim())
    f.roles = f.roles.map((r, j) => {
      const a = Ls[j].g.roles[Ls[j].ai]
      return withMandatoryId({ ...r, objectTypeId: a.objectTypeId, mandatory: !!a.mandatory, linkReadingParts: ['', 'involves', ''],
        ...(a.valueRange ? { valueRange: a.valueRange } : {}), ...(a.roleName ? { roleName: a.roleName } : {}) })
    })
    const all = Array.from({ length: k }, (_, j) => j)
    f.uniqueness = [mkUniqueness(all)]
    Ls.forEach((x, j) => { if ((x.g.uniqueness ?? []).some(u => u.roles.length === 1 && u.roles[0] === x.ai)) f.uniqueness.push(mkUniqueness([j])) })
    f.internalFrequency = Ls.flatMap((x, j) => (x.g.internalFrequency ?? []).filter(q => q.roles.length === 1 && q.roles[0] === x.ai).map(q => ({ ...q, id: uid(), roles: [j] })))
    f.objectified = true; f.objectifiedKind = 'entity'; f.objectifiedName = nNew.name; f.nestedReading = false
    if (nNew.isIndependent) f.isIndependent = true
    if (nNew.cardinalityRange) f.cardinalityRange = nNew.cardinalityRange
    if (nNew.lexicon) f.lexicon = nNew.lexicon
    f.implicitLinks = Ls.map((x, j) => ({ ...mkImplicitLink(j), ...(x.ni === 0 && x.g.readingParts ? { readingParts: x.g.readingParts, alternativeReadings: x.g.alternativeReadings ?? [] } : {}), ...(x.g.lexicon ? { lexicon: x.g.lexicon } : {}) }))
    api.setState(st => ({ facts: [...st.facts, f], isDirty: true }))
    // Other external uniqueness constraints over the far roles: internal.
    const far = (m) => Ls.findIndex(x => x.id === m?.factId && x.ai === m.roleIndex)
    for (const c of api.getState().constraints.filter(c => c.schemaId === S && c.constraintType === 'uniqueness' && c.sequences?.length === 1 && c.sequences[0].length > 1)) {
      const js = c.sequences[0].map(far)
      if (js.some(j => j < 0)) continue
      if (js.length < k && !f.uniqueness.some(u => u.roles.length === js.length && js.every(j => u.roles.includes(j)))) f.uniqueness.push(mkUniqueness(js))
      api.getState().deleteConstraint(c.id)
    }
    api.setState(st => ({ facts: st.facts.map(g => (g.id === f.id ? { ...g, uniqueness: f.uniqueness } : g)) }))
    // Where N is drawn: F.
    const occOf = new Map()
    for (const d of api.getState().diagrams.filter(x => x.schemaId === S)) {
      const no = (d.occurrences ?? []).find(o => o.schemaElementId === nN)
      if (!no) continue
      try { api.getState().addElementToDiagram(f.id, d.id) } catch { continue }
      const fo = api.getState().diagrams.find(x => x.id === d.id).occurrences.find(o => o.schemaElementId === f.id)
      occOf.set(d.id, [no.id, fo.id])
      api.setState(st => ({ diagrams: st.diagrams.map(x => (x.id !== d.id ? x : { ...x, occurrences: x.occurrences.map(o => (o.id === fo.id ? { ...o, x: no.x, y: no.y + 40 } : o)) })) }))
    }
    placeFrequencies(api, S, f.id)
    const Lids = new Set(Ls.map(x => x.id))
    api.setState(st => ({
      facts: st.facts.map(g => (g.schemaId !== S || Lids.has(g.id) || !g.roles.some(r => r.objectTypeId === nN) ? g : { ...g, roles: g.roles.map(r => (r.objectTypeId === nN ? { ...r, objectTypeId: f.id } : r)) })),
      subtypes: st.subtypes.map(x => (x.schemaId !== S || x.superId !== nN ? x : { ...x, superId: f.id })),
      diagrams: st.diagrams.map(d => {
        const oo = occOf.get(d.id)
        return !oo ? d : { ...d, occurrences: d.occurrences.map(o => (o.roleOccurrenceMap && !Lids.has(o.schemaElementId)
          ? { ...o, roleOccurrenceMap: Object.fromEntries(Object.entries(o.roleOccurrenceMap).map(([kk, v]) => [kk, v === oo[0] ? oo[1] : v])) } : o)) }
      }),
    }))
    // Constraints on the binaries: on F's roles and implied links, one
    // role at a time; else carried as formulas.
    const onL = (m) => Lids.has(m?.factId)
    const names = (c) => (c.sequences ?? []).some(q => (q ?? []).some(onL))
    const several = (c) => (c.sequences ?? []).some(q => (q ?? []).length > 1 && q.some(onL))
    const carried = api.getState().constraints.filter(c => c.schemaId === S && names(c) && several(c))
    for (const c of carried) api.getState().deleteConstraint(c.id)
    swapMembers(api, S, onL, (m) => {
      const j = Ls.findIndex(x => x.id === m.factId), x = Ls[j]
      return m.roleIndex === x.ai ? { kind: 'role', factId: f.id, roleIndex: j } : { kind: 'role', factId: `${f.id}_il_${j}`, roleIndex: 0 }
    })
    // Rules and formulas: N involves Ai is F's implied link; ∃n with every
    // implied link of n and nothing else is F(…).
    const conj = (x) => (x?.t === 'and' ? x.args : [x])
    const uses = (tree, v) => JSON.stringify(tree ?? null).match(new RegExp(`"(id|arg)":"${v}"|"${v}"[,\\]]`))
    const fold = (tree) => {
      if (!tree || typeof tree !== 'object') return tree
      if (Array.isArray(tree)) return tree.map(fold)
      const out = {}
      for (const [kk, v] of Object.entries(tree)) out[kk] = v && typeof v === 'object' ? fold(v) : v
      if (out.t !== 'exists' || out.v?.typeId !== f.id) return out
      const v = out.v.id, chain = []
      let node = out.body
      while (node?.t === 'exists') { chain.push(node.v); node = node.body }
      const parts = conj(node)
      const links = Ls.map((_, j) => parts.find(a => a?.t === 'fact' && a.factId === `${f.id}_il_${j}` && a.args[0] === v))
      if (links.some(a => !a)) return out
      const rest = parts.filter(a => !links.includes(a))
      if (uses(rest, v)) return out
      return existsOf(chain, andOf([...rest, factAtomOf(f.id, links.map(a => a.args[1]))]))
    }
    const rw = (tree) => fold(retype(mapAtoms(tree, (a) => {
      if (a.t === 'type') return a.typeId === nN ? { ...a, typeId: f.id } : a
      const j = Ls.findIndex(x => x.id === a.factId)
      if (j < 0) return a
      const x = Ls[j]
      return factAtomOf(`${f.id}_il_${j}`, [a.args[x.ni], a.args[x.ai]])
    }), nN, f.id))
    setRules(api, run.mapping.id, (rule) => { const target = rw(rule.target); return JSON.stringify(target) === JSON.stringify(rule.target) ? rule : { ...rule, target } })
    rewriteFormulas(api, S, rw)
    api.setState(st => ({
      facts: st.facts.map(g => (g.schemaId === S && g.derivationRule ? { ...g, derivationRule: rw(g.derivationRule) } : g)),
      objectTypes: st.objectTypes.map(o => (o.schemaId === S && o.derivationRule ? { ...o, derivationRule: rw(o.derivationRule) } : o)),
    }))
    carryFormulas(api, run, carried.map(c => [...run.idMap].find(([, v]) => v === c.id)?.[0]).filter(Boolean), rw)
    for (const x of Ls) api.getState().deleteFact(x.id)
    api.getState().deleteConstraint(id(pl.pi.id))
    api.getState().deleteObjectType(nN)
    run.report.push(`Replaced ${pl.n.name} and its identifying fact types by the objectified fact type ${f.roles.map((r, j) => [f.readingParts[j], api.getState().objectTypes.find(o => o.id === r.objectTypeId)?.name ?? '?'].filter(Boolean).join(' ')).join(' ')}${f.readingParts[k] ? ' ' + f.readingParts[k] : ''}, nested as ${pl.n.name}`)
    return { carry: [pl.n.id, ...pl.parts.map(x => x.f.id)] }
  },
}

// ── Unary fact type to a subtype ────────────────────────────────────────────
// The unary "E is a S" becomes the subtype S of E; roles of E with a subset
// (or equality) constraint into the unary become roles of S (mandatory for
// an equality).
const unaryToSubtype = {
  id: 'unaryToSubtype',
  label: 'Unary fact type → subtype',
  profile: 'orm2',
  optionLabel: 'Unary fact type',
  none: 'The schema has no unary fact type.',
  nameLabel: 'Subtype',
  options: (ctx) => ctx.facts.filter(f => f.roles.length === 1 && !f.derivation && !f.objectified && ctx.otById.get(f.roles[0].objectTypeId)?.kind === 'entity').map(f => ({
    key: f.id, params: { factId: f.id }, label: `${ctx.otById.get(f.roles[0].objectTypeId).name} ${readingOf(f)}`, name: pascal(readingOf(f).replace(/^(is|are)\s+(an?\s+)?/i, '')) || 'Subtype' })),
  describe: (p, ctx) => {
    const f = ctx.factById.get(p.factId), e = f && ctx.otById.get(f.roles[0].objectTypeId)
    if (!f) return 'Choose a unary fact type.'
    const inside = rolesInside(ctx, f)
    return `Replace "${e.name} ${readingOf(f)}" by the subtype ${p.name || '…'} of ${e.name}${inside.length ? `; ${inside.map(x => readingOf(x.f)).join(', ')} become${inside.length === 1 ? 's' : ''} ${p.name || '…'}'s` : ''}.`
  },
  check: (p, ctx) => {
    const f = ctx.factById.get(p.factId)
    if (!f || f.roles.length !== 1) return ['Choose a unary fact type.']
    const n = p.name?.trim()
    const out = []
    if (!n) out.push('Name the subtype.')
    else if (ctx.objectTypes.some(o => o.name === n)) out.push(`There is already an object type ${n}.`)
    return out
  },
  edit(api, p, ctx, run) {
    const S = run.mapping.targetSchemaId, id = (x) => run.idMap.get(x)
    const f = ctx.factById.get(p.factId), e = ctx.otById.get(f.roles[0].objectTypeId)
    const uN = id(f.id), eN = id(e.id)
    const inside = rolesInside(ctx, f)
    const s = { ...mkEntity(0, 0), name: p.name.trim(), schemaId: S }
    const st = { ...mkSubtype(s.id, eN), schemaId: S }
    api.setState(x => ({ objectTypes: [...x.objectTypes, s], subtypes: [...x.subtypes, st], isDirty: true }))
    for (const d of api.getState().diagrams.filter(x => x.schemaId === S && (x.occurrences ?? []).some(o => o.schemaElementId === eN))) {
      const eo = d.occurrences.find(o => o.schemaElementId === eN)
      try { api.getState().addElementToDiagram(st.id, d.id) } catch { continue }
      api.setState(x => ({ diagrams: x.diagrams.map(dd => (dd.id !== d.id ? dd : { ...dd, occurrences: dd.occurrences.map(o => (o.schemaElementId === s.id ? { ...o, x: eo.x, y: eo.y + 140 } : o)) })) }))
    }
    // The roles inside the unary: to S.
    const movedFacts = new Map(inside.map(x => [id(x.f.id), x]))
    for (const x of inside) api.getState().deleteConstraint(id(x.c.id))
    swapMembers(api, S, (m) => m?.kind === 'role' && m.factId === uN, { kind: 'subtype', subtypeId: st.id }, swappable)
    api.setState(x => ({ facts: x.facts.map(g => {
      const mv = movedFacts.get(g.id)
      return mv ? { ...g, roles: g.roles.map((r, i) => (i === mv.i ? withMandatoryId({ ...r, objectTypeId: s.id, mandatory: r.mandatory || mv.c.constraintType === 'equality' }) : r)) } : g
    }) }))
    for (const d of api.getState().diagrams.filter(x => x.schemaId === S)) {
      const so = d.occurrences?.find(o => o.schemaElementId === s.id)
      if (!so) continue
      api.setState(x => ({ diagrams: x.diagrams.map(dd => (dd.id !== d.id ? dd : { ...dd, occurrences: dd.occurrences.map(o => {
        const mv = movedFacts.get(o.schemaElementId)
        return mv && o.roleOccurrenceMap ? { ...o, roleOccurrenceMap: { ...o.roleOccurrenceMap, [mv.i]: so.id } } : o
      }) })) }))
    }
    // The rules: the unary is the subtype's type atom; a variable at a moved
    // role is an S.
    const rw = (tree) => {
      const at = new Set()
      mapAtoms(tree, (a) => { const mv = a.t === 'fact' && movedFacts.get(a.factId); if (mv) at.add(a.args[mv.i]); return a })
      let out = mapAtoms(tree, (a) => (a.t === 'fact' && a.factId === uN ? { t: 'type', typeId: s.id, arg: a.args[0] } : a))
      if (at.size) out = retype(out, eN, (v) => (at.has(v) ? s.id : eN))
      return out
    }
    setRules(api, run.mapping.id, (rule) => {
      const target = rw(rule.target)
      return JSON.stringify(target) === JSON.stringify(rule.target) ? rule : { ...rule, target }
    })
    rewriteFormulas(api, S, rw)
    const handled = new Set([...inside.map(x => x.c.id)])
    carryFormulas(api, run, namingConstraints(ctx, f.id).filter(c => !handled.has(c) && !swappable(ctx.constraints.find(x => x.id === c))), rw)
    dropColumn(api, uN)
    run.report.push(`Replaced ${e.name} ${readingOf(f)} by the subtype ${s.name}${inside.length ? `; ${inside.map(x => readingOf(x.f)).join(', ')} moved to it` : ''}`)
    return { carry: [f.id] }
  },
}
// The roles of a unary's player with a subset or equality constraint into
// it: { f, i, c }.
function rolesInside(ctx, u) {
  const out = []
  for (const c of ctx.constraints) {
    if (!['subset', 'equality'].includes(c.constraintType) || c.sequences?.length !== 2) continue
    const [a, b] = c.sequences
    if (a?.length !== 1 || b?.length !== 1) continue
    const pick = (x, y) => (y[0]?.factId === u.id && x[0]?.factId !== u.id ? x[0] : null)
    const m = pick(a, b) ?? (c.constraintType === 'equality' ? pick(b, a) : null)
    const f = m && ctx.factById.get(m.factId)
    if (f && f.roles[m.roleIndex]?.objectTypeId === u.roles[0].objectTypeId && !out.some(x => x.f.id === f.id)) out.push({ f, i: m.roleIndex, c })
  }
  return out
}

export const TRANSFORMATIONS = [split, absorb, fkToTable, boolToTable, toSurrogate, toNatural, partition, merge, toTypeColumn, toSubtypeTables, unaryToBoolean, booleanToUnary, subtypeToUnary, unaryToSubtype, flatten, objectify]
export const transformationById = (id) => TRANSFORMATIONS.find(x => x.id === id)
