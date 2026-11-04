// Derived tables and derived columns of a relational schema (encoding B).
//
// A table rule defines rows of a table by a query over the schema, written as
// a mapping pattern (mapping/mapping.js) with $y for the values it gives:
//
//   T(k1: $k1, …, c1: $c1, c2: $c2?, …)  ⟺  φ($k1, …, $c1, $c2, …)
//
// The head is a table row of T whose columns take $y (or $y?, NULL when the
// optional part of φ that $y guards does not match); the body φ is a pattern
// over the same schema. Rows are keyed by the head's primary key columns: the
// key values φ gives make the rows, and the other values their columns.
//
//   kind 'table'    the rows of T are derived (T has no other rows when the
//                   rule is derived, more when it is semi-derived), and so are
//                   the non-key columns in the head
//   kind 'columns'  only the non-key columns in the head are derived, for the
//                   rows T has; the key columns say which row a value is for
//
// Rules are stored on the table's entity type:
//   ot.tableRules: [{ id, name, kind, mode: 'derived' | 'semiDerived',
//                     body: pattern tree, head: { [columnFactId]: { k: 'fv' | 'opt', y } } }]
//
// A rule compiles to the derivation rules FreeFBM already evaluates, so
// populations, validation and the Constraints tab see it as it is in the
// logic (compileTableRule):
//   - the table, for kind 'table': an entity type derived through its
//     reference scheme, with the key values as free variables ref:i;
//   - each non-key column: a derived fact type whose row role is selected and
//     identified by the key columns, and whose value role is the value φ
//     gives (the optional part $y guards is then required).
// Compiled rules carry tableRuleId, the rule they come from.

import { hole } from '../logic/derivationRule.js'
import { referenceParts } from '../logic/derivationRule.js'
import { roleVarId } from '../logic/factDerivation.js'
import { sideContext, checkRule, treeToSide, expandSide, frontierUse } from '../mapping/mapping.js'
import { mkValue, mkFact, mkUniqueness, withMandatoryId, mkConstraint, uid } from '../store/storeHelpers.js'

export const TABLE_RULE_KINDS = [
  { id: 'table', label: 'Rows of the table' },
  { id: 'columns', label: 'Columns of its rows' },
]

export const mkTableRule = (kind = 'table', name = '') =>
  ({ id: uid(), name, kind, mode: 'derived', body: hole(), head: {} })

export const tableRulesOf = (ot) => (Array.isArray(ot?.tableRules) ? ot.tableRules : [])

// The rule as a mapping of the table's schema onto itself (body ⟺ head), so
// the mapping checks and the mapping rule editor work on it.
export function tableRuleAsMapping(table, rule) {
  const mrule = { id: rule.id, name: rule.name ?? '', source: rule.body ?? hole(), target: { t: 'rel', tableId: table.id, args: rule.head ?? {} } }
  const mapping = { id: `table:${table.id}`, name: table.name, sourceSchemaId: table.schemaId, targetSchemaId: table.schemaId, rules: [mrule], tableRule: true }
  return { mapping, rule: mrule }
}

// The column facts a rule derives: its head's non-key columns.
export function derivedColumnIds(rule, rmTable) {
  const key = new Set((rmTable?.pk ?? []).map(c => c.fact.id))
  return Object.keys(rule.head ?? {}).filter(id => !key.has(id))
}

// The frontier variables of the body and how they are used.
export function bodyFrontier(rule) {
  return frontierUse(treeToSide(rule.body ?? hole()).side)
}

// ── Checks ──────────────────────────────────────────────────────────────────

// Problems with a table rule: [{ severity, text }].
export function checkTableRule(state, table, rule, ctx = sideContext(state, table.schemaId)) {
  const out = []
  const err = (text, severity = 'error') => out.push({ severity, text })
  const tb = ctx.tableById.get(table.id)
  if (!tb) { err(`${table.name} is not a table of a relational schema`); return out }
  const { mapping, rule: mrule } = tableRuleAsMapping(table, rule)
  for (const i of checkRule(mrule, mapping, state, { source: ctx, target: ctx })) {
    // The head's own key-safety is the primary key check below.
    if (i.side === 'target' && /row of .* is not determined/.test(i.text)) continue
    // A $y of the query that the row does not give is only matched (a
    // projection), which is fine while columns are being added.
    const onlyQuery = /occurs in the source pattern only/.test(i.text)
    const text = i.text.replace(/^Source: /, 'Query: ').replace(/^Target: /, 'Row: ')
      .replace('occurs in the source pattern only', 'is not in the row: add a column for it, or it is only matched').replace('occurs in the target pattern only', 'is not given by the query')
      .replace('the pattern is empty', 'no columns are given')
    out.push({ severity: onlyQuery ? 'warning' : i.severity, text })
  }
  const head = rule.head ?? {}
  const pk = tb.pk ?? []
  if (!pk.length) err(`${tb.name} has no primary key: give it one, so the rule can say which row a value is for`)
  for (const c of pk) if (!head[c.fact.id]) err(`the key column ${c.name} is not in the row`)
  const use = bodyFrontier(rule)
  for (const [fid, arg] of Object.entries(head)) {
    const col = tb.columns.find(c => c.fact.id === fid)
    if (!col) continue
    if (arg?.k !== 'fv' && arg?.k !== 'opt') { err(`${col.name}: a column of the row takes $y or $y?`); continue }
    const u = use.get(arg.y)
    if (pk.includes(col) && arg.k === 'opt') err(`${col.name} is a key column, so it can't be NULL ($${arg.y}?)`)
    else if (arg.k === 'fv' && u?.guards) err(`$${arg.y} is NULL when its optional part does not match: write $${arg.y}? in the row`)
    else if (arg.k === 'opt' && u && !u.guards && u.top) err(`$${arg.y} always has a value: $${arg.y} will do in the row`, 'warning')
    if (arg.k === 'opt' && col.notNull && !pk.includes(col)) err(`${col.name} is NOT NULL, but $${arg.y}? may be NULL`)
  }
  const derived = derivedColumnIds(rule, tb)
  if (rule.kind === 'columns' && !derived.length) err('the row gives no column besides the key', 'warning')
  // Each table and column is derived by one rule at most.
  const others = tableRulesOf(table).filter(r => r.id !== rule.id)
  if (rule.kind === 'table' && others.some(r => r.kind === 'table')) err(`${tb.name} has another rule for its rows`)
  for (const fid of derived) {
    const col = tb.columns.find(c => c.fact.id === fid)
    if (others.some(r => derivedColumnIds(r, tb).includes(fid))) err(`${col?.name ?? 'a column'} is derived by another rule of ${tb.name} too`)
    const f = ctx.factById.get(fid)
    if (f && (f.derivation === 'derived' || f.derivation === 'semiDerived') && f.tableRuleId !== rule.id && !others.some(r => r.id === f.tableRuleId))
      err(`${col?.name ?? 'a column'} has a derivation rule of its own`)
  }
  if (rule.kind === 'table' && (table.derivation === 'derived' || table.derivation === 'semiDerived') && table.tableRuleId !== rule.id && !others.some(r => r.id === table.tableRuleId))
    err(`${tb.name} has a derivation rule of its own`)
  if (!out.some(i => i.severity === 'error')) {
    const c = compileTableRule(state, table, rule, ctx)
    if (c.error) err(c.error)
  }
  return out
}

// Every table rule's problems: [{ table, rule, severity, text }].
export function tableRuleIssues(state) {
  const out = []
  const ctxs = new Map()
  for (const ot of state.objectTypes ?? []) {
    const rules = tableRulesOf(ot)
    if (!rules.length) continue
    if (!ctxs.has(ot.schemaId)) ctxs.set(ot.schemaId, sideContext(state, ot.schemaId))
    for (const r of rules) for (const i of checkTableRule(state, ot, r, ctxs.get(ot.schemaId))) out.push({ table: ot, rule: r, ...i })
  }
  return out
}

// ── Compilation ─────────────────────────────────────────────────────────────

// A conjunction, flat: the evaluator binds variables from the fact atoms of
// one level of ∧ only.
const conj = (parts) => {
  const flat = parts.flatMap(p => (p.t === 'and' ? p.args : p.t === 'true' ? [] : [p]))
  return flat.length === 0 ? { t: 'true' } : flat.length === 1 ? flat[0] : { t: 'and', args: flat }
}
const valueEq = (a, b) => ({ t: 'vcmp', op: '≈', left: { t: 'var', id: a }, right: { t: 'var', id: b } })

// The derivation rules a table rule stands for:
//   { table: rule tree | null, columns: [{ factId, rule: { body, extraVars, terms } }] }
// or { error }.
export function compileTableRule(state, table, rule, ctx = sideContext(state, table.schemaId)) {
  const tb = ctx.tableById.get(table.id)
  if (!tb) return { error: `${table.name} is not a table` }
  const flat = treeToSide(rule.body ?? hole())
  if (flat.problems.length) return { error: flat.problems[0] }
  const ex = expandSide(flat.side, ctx)
  const head = rule.head ?? {}
  const pk = tb.pk ?? []
  if (!pk.length) return { error: `${tb.name} has no primary key` }
  const varType = new Map()
  const scanTypes = (vars, atoms) => {
    for (const v of vars ?? []) varType.set(v.id, v.typeId)
    for (const a of atoms ?? []) if (a.t === 'opt' || a.t === 'not') scanTypes(a.vars, a.atoms)
  }
  scanTypes(ex.vars, ex.atoms)
  // Where each $y is bound: at the top, and the optional part it guards.
  const topBinds = new Map(), guards = new Map()
  for (const a of ex.atoms) {
    if (a.t === 'bind' && a.v && a.y) { if (!topBinds.has(a.y)) topBinds.set(a.y, []); topBinds.get(a.y).push(a.v) }
    if (a.t === 'opt' && a.y) guards.set(a.y, a)
  }
  const keyArgs = pk.map(c => ({ col: c, y: head[c.fact.id]?.y }))
  for (const k of keyArgs) if (!k.y || !topBinds.has(k.y)) return { error: `the key column ${k.col.name} is not given by the query` }

  // One variable stands for each $y: a root of the compiled rule (a reference
  // value, a column's value) or the first variable bound to it, at the top
  // level first. Every other variable bound to $y is replaced by it when it
  // has the same type, else equated with it by value (≈), where it is bound.
  const unify = (roots, inline = null) => {
    const rep = new Map(roots), subst = new Map(), eqAt = new Map()
    const bindOne = (a) => {
      const r = rep.get(a.y)
      if (!r) { rep.set(a.y, { id: a.v, typeId: varType.get(a.v) }); return }
      if (r.id === a.v) return
      if (!subst.has(a.v) && varType.get(a.v) === r.typeId && ![...rep.values()].some(x => x.id === a.v)) subst.set(a.v, r.id)
      else eqAt.set(a, r.id)
    }
    const visit = (atoms, nested) => {
      for (const a of atoms ?? []) if (a.t === 'bind' && a.v && a.y) bindOne(a)
      for (const a of atoms ?? []) if (a.t === 'not' || (a.t === 'opt' && (a === inline || nested))) visit(a.atoms, true)
    }
    visit(ex.atoms, false)
    const s = (id) => (id && subst.has(id) ? subst.get(id) : id)
    return { rep, subst, eqAt, s }
  }

  // A part of the body as a rule tree, with u from unify. inline: the
  // optional part to make required (others always match, so they go);
  // quantify false gives { body, vars } with the part's free variables.
  const tree = (vars, atoms, u, { inline = null, quantify = true } = {}) => {
    const { s } = u
    const parts = [], extra = []
    for (const a of atoms ?? []) {
      switch (a.t) {
        case 'fact': parts.push({ t: 'fact', factId: a.factId, args: a.args.map(s) }); break
        case 'type': parts.push({ t: 'type', typeId: a.typeId, arg: s(a.arg) }); break
        case 'const': parts.push({ t: 'vcmp', op: '≈', left: { t: 'var', id: s(a.v) }, right: { t: 'const', text: a.text } }); break
        case 'bind': if (u.eqAt.has(a) && s(a.v) !== s(u.eqAt.get(a))) parts.push(valueEq(s(a.v), s(u.eqAt.get(a)))); break
        case 'not': parts.push({ t: 'not', arg: tree(a.vars, a.atoms, u) }); break
        case 'opt':
          if (a === inline) {
            const inner = tree(a.vars, a.atoms, u, { quantify: false })
            extra.push(...inner.vars)
            parts.push(inner.body)
          }
          break
        default: break
      }
    }
    const free = [...(vars ?? []).filter(v => !u.subst.has(v.id)), ...extra]
    const body = conj(parts)
    if (!quantify) return { body, vars: free }
    return [...free].reverse().reduce((b, v) => ({ t: 'exists', v: { id: v.id, typeId: v.typeId }, body: b }), body)
  }

  // The table: ∃z̄ φ with the key values as its free variables ref:i.
  let tableRule = null
  if (rule.kind === 'table') {
    const parts = referenceParts(table.id, state)
    if (!parts) return { error: `${tb.name} has no reference scheme for its key` }
    const roots = new Map()
    for (const p of parts) {
      const k = keyArgs.find(x => x.col.fact.id === p.factId)
      if (!k) return { error: `${tb.name}'s key is not its preferred identifier` }
      roots.set(k.y, { id: p.id, typeId: p.typeId })
    }
    tableRule = tree(ex.vars, ex.atoms, unify(roots))
  }

  // Each non-key column: the row (selected, identified by the key columns)
  // and the value, selected when the query's variable has the column's type,
  // else computed from it.
  const columns = []
  for (const fid of derivedColumnIds(rule, tb)) {
    const col = tb.columns.find(c => c.fact.id === fid)
    const arg = head[fid]
    if (!col || !arg?.y) continue
    const f = col.fact
    const rowVar = roleVarId(f.roles[col.t]), valVar = roleVarId(f.roles[col.v])
    const opt = guards.get(arg.y) ?? null
    const vs = opt ? opt.atoms.filter(a => a.t === 'bind' && a.y === arg.y && a.v).map(a => a.v) : topBinds.get(arg.y) ?? []
    if (!vs.length) return { error: `${col.name} is not given by the query` }
    const sameVal = vs.find(v => varType.get(v) === col.vt.id)
    const u = unify(sameVal ? new Map([[arg.y, { id: valVar, typeId: col.vt.id }]]) : new Map(), opt)
    // The row: a row of the table itself in the query, keyed by the key's
    // $y, is the row (the usual case for a derived column); else the key
    // columns pick it.
    const ident = []
    const alias = ex.vars.find(v => v.typeId === table.id && keyArgs.every(k => ex.atoms.some(a =>
      a.t === 'fact' && a.factId === k.col.fact.id && a.args[k.col.t] === v.id && topBinds.get(k.y).includes(a.args[k.col.v]))))
    if (alias) u.subst.set(alias.id, rowVar)
    else for (const k of keyArgs) {
      const kv = u.s(u.rep.get(k.y).id)
      const args = (val) => { const r = [null, null]; r[k.col.t] = rowVar; r[k.col.v] = val; return r }
      if (varType.get(kv) === k.col.vt.id) ident.push({ t: 'fact', factId: k.col.fact.id, args: args(kv) })
      else {
        const kc = `key:${k.col.fact.id}`
        ident.push({ t: 'exists', v: { id: kc, typeId: k.col.vt.id }, body: conj([{ t: 'fact', factId: k.col.fact.id, args: args(kc) }, valueEq(kc, kv)]) })
      }
    }
    const terms = sameVal ? {} : { [f.roles[col.v].id]: { t: 'var', id: u.s(u.rep.get(arg.y).id) } }
    const inner = tree(ex.vars, ex.atoms, u, { inline: opt, quantify: false })
    columns.push({ factId: fid, rule: { body: conj([...ident, inner.body]), extraVars: inner.vars.map(v => ({ id: v.id, typeId: v.typeId })), terms } })
  }
  return { table: tableRule, columns }
}

// ── Applying rules to the state ─────────────────────────────────────────────

// The objectTypes and facts with every table rule of table tableId compiled
// into derivation rules, and derivation rules of rules that are gone (or no
// longer cover an element) taken back.
export function compileTableRulesInto(state, tableId) {
  const table = (state.objectTypes ?? []).find(o => o.id === tableId)
  if (!table) return { objectTypes: state.objectTypes, facts: state.facts }
  const ctx = sideContext(state, table.schemaId)
  const tb = ctx.tableById.get(tableId)
  const rules = tableRulesOf(table)
  const ownCols = new Set((tb?.columns ?? []).map(c => c.fact.id))
  const factPatch = new Map()   // factId → patch
  let tablePatch = null
  for (const r of rules) {
    const c = compileTableRule(state, table, r, ctx)
    if (r.kind === 'table') tablePatch = { derivation: r.mode, derivationRule: c.error ? hole() : c.table, tableRuleId: r.id }
    const byId = new Map((c.columns ?? []).map(x => [x.factId, x.rule]))
    for (const fid of derivedColumnIds(r, tb)) {
      if (factPatch.has(fid)) continue
      factPatch.set(fid, { derivation: r.mode, derivationRule: byId.get(fid) ?? { body: hole(), extraVars: [], terms: {} }, tableRuleId: r.id })
    }
  }
  const undo = { derivation: 'none', derivationRule: null, tableRuleId: undefined }
  const objectTypes = state.objectTypes.map(o => {
    if (o.id !== tableId) return o
    if (tablePatch) return { ...o, ...tablePatch }
    return o.tableRuleId ? strip({ ...o, ...undo }) : o
  })
  const facts = state.facts.map(f => {
    if (factPatch.has(f.id)) return { ...f, ...factPatch.get(f.id) }
    // A column of this table a rule derived, whose rule is gone or no longer has it in its row.
    if (f.tableRuleId && ownCols.has(f.id)) return strip({ ...f, ...undo })
    return f
  })
  return { objectTypes, facts }
}
const strip = (x) => { delete x.tableRuleId; delete x.derivationRule; return x }

// The table rules with the elements in `ids` (made ordinary, e.g. by Fold)
// taken out: their columns leave the rows, a table whose rows are no longer
// derived keeps the rule only for columns still derived, and a rule left
// with nothing to derive goes. Returns { objectTypes, tableIds } (the tables
// whose rules changed, to recompile).
export function withoutRuleElements(state, ids) {
  const set = new Set(ids)
  const tableIds = []
  const objectTypes = state.objectTypes.map(o => {
    const rules = tableRulesOf(o)
    if (!rules.length) return o
    const tb = sideContext(state, o.schemaId).tableById.get(o.id)
    const key = new Set((tb?.pk ?? []).map(c => c.fact.id))
    let changed = false
    const next = []
    for (const r of rules) {
      const head = Object.fromEntries(Object.entries(r.head ?? {}).filter(([fid]) => key.has(fid) || !set.has(fid)))
      let kind = r.kind
      if (kind === 'table' && set.has(o.id)) kind = 'columns'
      const nonKey = Object.keys(head).filter(fid => !key.has(fid))
      if (kind !== r.kind || Object.keys(head).length !== Object.keys(r.head ?? {}).length) changed = true
      if (kind === 'columns' && !nonKey.length) { changed = true; continue }
      next.push(kind === r.kind && head === r.head ? r : { ...r, kind, head })
    }
    if (!changed) return o
    tableIds.push(o.id)
    return { ...o, tableRules: next }
  })
  return { objectTypes, tableIds }
}

// A new column of a table for $y: a fact type from the table to valueTypeId
// (or a new value type named after the column), as in DDL import. Returns
// { facts, objectTypes, fact }.
export function newColumn(state, table, name, valueTypeId, { notNull = false } = {}) {
  const objectTypes = [...state.objectTypes]
  let vt = valueTypeId ? objectTypes.find(o => o.id === valueTypeId && o.kind === 'value' && o.schemaId === table.schemaId) : null
  if (!vt) {
    const used = new Set(objectTypes.filter(o => o.schemaId === table.schemaId).map(o => o.name))
    let vname = name
    for (let i = 2; used.has(vname); i++) vname = `${table.name}_${name}${i > 2 ? i - 1 : ''}`
    vt = { ...mkValue(table.x ?? 0, (table.y ?? 0) + 80), name: vname, schemaId: table.schemaId, datatypeAssignment: { profileId: 'postgresql', datatypeId: 'text' } }
    objectTypes.push(vt)
  }
  const f = { ...mkFact(table.x ?? 0, table.y ?? 0, 2), schemaId: table.schemaId }
  f.readingParts = name === vt.name ? ['', 'has', ''] : ['', `has ${name} as`, '']
  f.roles = [
    withMandatoryId({ ...f.roles[0], objectTypeId: table.id, mandatory: !!notNull }),
    { ...f.roles[1], objectTypeId: vt.id, roleName: name === vt.name ? '' : name },
  ]
  f.uniqueness = [mkUniqueness([0])]
  return { objectTypes, facts: [...state.facts, f], fact: f }
}

// The facts and constraints with the table's primary key set to the given
// column facts (in order): one column gives a preferred uniqueness on its
// value role, several a preferred external uniqueness constraint over them.
// Key columns are NOT NULL.
export function withPrimaryKey(state, table, columnFactIds) {
  const ctx = sideContext(state, table.schemaId)
  const tb = ctx.tableById.get(table.id)
  const cols = (tb?.columns ?? [])
  const isCol = new Set(cols.map(c => c.fact.id))
  const colOf = new Map(cols.map(c => [c.fact.id, c]))
  const keys = columnFactIds.filter(id => isCol.has(id))
  let constraints = (state.constraints ?? []).filter(c => !(c.constraintType === 'uniqueness' && c.isPreferredIdentifier && c.targetObjectTypeId === table.id))
  const facts = state.facts.map(f => {
    if (!isCol.has(f.id)) return f
    const col = colOf.get(f.id)
    let { uniqueness = [], preferredUniqueness = [] } = f
    preferredUniqueness = preferredUniqueness.filter(u => !(u.length === 1 && u[0] === col.v))
    const single = keys.length === 1 && keys[0] === f.id
    if (single) {
      if (!uniqueness.some(u => u.roles?.length === 1 && u.roles[0] === col.v)) uniqueness = [...uniqueness, mkUniqueness([col.v])]
      preferredUniqueness = [...preferredUniqueness, [col.v]]
    }
    const roles = keys.includes(f.id) ? f.roles.map((r, i) => (i === col.t ? withMandatoryId({ ...r, mandatory: true }) : r)) : f.roles
    return { ...f, uniqueness, preferredUniqueness, roles }
  })
  if (keys.length > 1) {
    constraints = [...constraints, { ...mkConstraint('uniqueness', table.x ?? 0, (table.y ?? 0) - 40), schemaId: table.schemaId,
      isPreferredIdentifier: true, targetObjectTypeId: table.id,
      sequences: [keys.map(id => ({ kind: 'role', factId: id, roleIndex: colOf.get(id).v }))], queries: [null] }]
  }
  return { facts, constraints }
}
