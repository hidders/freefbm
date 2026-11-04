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
import { uid } from '../store/storeHelpers.js'
import { valueKindName } from '../utils/datatypeValues.js'

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
    const c = { id: uid(), constraintType: 'subset', schemaId: run.mapping.targetSchemaId, x: 0, y: 0,
      sequences: [from.map(x => ({ kind: 'role', factId: x.fact.id, roleIndex: x.v })), to.map(x => ({ kind: 'role', factId: x.f.id, roleIndex: x.ri }))],
      queries: [null, null] }
    api.setState(s => ({ constraints: [...s.constraints, c] }))
    st._tryAutoGenerateQuery?.(c.id)
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
  options: (ctx) => ctx.tables.flatMap(t => (t.fks ?? []).filter(fk => fk.from.every(c => !c.pk)).map(fk => ({ tableId: t.id, columnIds: fk.from.map(c => c.fact.id), label: `${t.name}(${fk.from.map(c => c.name).join(', ')}) → ${fk.toTable.name}`, name: `${t.name}_${fk.toTable.name}` }))),
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
  options: (ctx) => ctx.tables.flatMap(t => t.columns.filter(c => !c.pk && isBoolean(c)).map(c => ({ tableId: t.id, columnId: c.fact.id, label: `${t.name}.${c.name}`, name: `${t.name}_${c.name}` }))),
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

export const TRANSFORMATIONS = [split, absorb, fkToTable, boolToTable]
export const transformationById = (id) => TRANSFORMATIONS.find(x => x.id === id)
