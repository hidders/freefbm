// Schema mappings (workbench plan, step 7; docs/logic/schema-mappings.tex).
//
// A mapping relates a source and a target schema of the file by rules. A rule
// φ ⟺ ψ pairs a source pattern φ with a target pattern ψ; the two share only
// frontier variables ŷ, which carry data values (or NULL) between them. Its
// meaning is ∀ŷ [∃x̄ φ ↔ ∃z̄ ψ].
//
//   mapping: { id, name, sourceSchemaId, targetSchemaId, rules: [rule] }
//   rule:    { id, name, source: pattern, target: pattern }
//
// A pattern is stored in the rule-tree format of derivation rules
// (logic/derivationRule.js), restricted to ∃, ∧ and atoms, and extended for
// mappings:
//   { t: 'hole' }
//   { t: 'and', args: [P, …] }
//   { t: 'exists', v: { id, typeId }, body: P }
//   { t: 'fact', factId, args: [varId | null] }        args in roles[] order
//   { t: 'type', typeId, arg: varId | null }
//   { t: 'vcmp', op: '≈', left: { t: 'var', id }, right: { t: 'fv', y } }    x ≈ ŷ
//   { t: 'vcmp', op: '≈', left: { t: 'var', id }, right: { t: 'const', text } }
//   { t: 'rel', tableId, args: { [columnFactId]: arg } }
//        relational atom R(…) over a table of encoding B; a column without
//        an arg is _ (any value). arg:
//          { k: 'fv', y }      the column's value is ŷ
//          { k: 'opt', y }     ŷ?: the column's value, or NULL if it has none
//          { k: 'const', text }
//          { k: 'absent' }     −: the column has no value
//          { k: 'var', v }     the column's value, as a variable of the pattern
//   { t: 'opt', y, body: P }   [ŷ](…): an optional part, guarded by ŷ
//   { t: 'not', arg: P }       ¬(…), usually ¬∃…
//
// The checks work on the flat form of a pattern (treeToSide):
//   side: { vars: [{ id, typeId }], atoms: [atom] }
// with atoms fact, type, rel as above, { t: 'bind', v, y }, { t: 'const', v,
// text }, { t: 'opt', y, vars, atoms } and { t: 'not', vars, atoms }.
//
// Frontier variables are named by the user (y is the name without the hat).
// A relational atom abbreviates the encoding-B formula (Definition "relational
// atom"); expandSide spells it out, and the checks run on that.

import { uid } from '../store/storeHelpers.js'
import { relationalModel } from '../relational/relationalModel.js'
import { plainParts } from '../verbalisation/hyphenBinding.js'

export const mkMapping = (name, sourceSchemaId, targetSchemaId) =>
  ({ id: uid(), name, sourceSchemaId, targetSchemaId, rules: [] })
export const mkSide = () => ({ vars: [], atoms: [] })
export const mkRule = (name = '') => ({ id: uid(), name, source: { t: 'hole' }, target: { t: 'hole' } })
export const newVarId = () => `v${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`

export const SIDES = ['source', 'target']
export const sideSchemaId = (mapping, side) => (side === 'source' ? mapping.sourceSchemaId : mapping.targetSchemaId)

// ── Patterns as trees ───────────────────────────────────────────────────────

// The flat form of a pattern tree, and what keeps it from being one: parts not
// filled in, and nodes a pattern can't have.
export function treeToSide(tree) {
  const problems = []
  const walk = (n, vars, atoms) => {
    switch (n?.t) {
      case undefined: case 'hole': problems.push('a part is not filled in (□)'); return
      case 'true': return
      case 'and': for (const a of n.args ?? []) walk(a, vars, atoms); return
      case 'exists': if (n.v) vars.push(n.v); walk(n.body, vars, atoms); return
      case 'fact': atoms.push({ t: 'fact', factId: n.factId, args: n.args ?? [] }); return
      case 'type': atoms.push({ t: 'type', typeId: n.typeId, arg: n.arg ?? null }); return
      case 'rel': atoms.push(n); return
      case 'vcmp': {
        const v = n.left?.t === 'var' ? n.left.id ?? null : null
        if (n.op !== '≈' || (n.left && n.left.t !== 'var' && n.left.t !== 'hole')) problems.push('only x ≈ ŷ and x ≈ \'c\' compare values in a pattern')
        else if (n.right?.t === 'fv') atoms.push({ t: 'bind', v, y: n.right.y ?? '' })
        else if (n.right?.t === 'const') atoms.push({ t: 'const', v, text: n.right.text ?? '' })
        else problems.push('a value comparison needs ŷ or a constant on its right')
        return
      }
      case 'opt': { const p = part(n.body); atoms.push({ t: 'opt', y: n.y ?? '', ...p }); return }
      case 'not': { const p = part(n.arg); atoms.push({ t: 'not', ...p }); return }
      default: problems.push(`${n.t} is not allowed in a pattern`)
    }
  }
  const part = (n) => { const vars = [], atoms = []; walk(n, vars, atoms); return { vars, atoms } }
  return { side: part(tree), problems }
}

// A pattern in its flat form, whichever form it is given in.
export const asSide = (x) => (x && Array.isArray(x.atoms) ? x : treeToSide(x).side)
const isEmptyTree = (x) => !x || x.t === 'hole' || (Array.isArray(x.atoms) && !x.atoms.length)

// ── Context ──────────────────────────────────────────────────────────────────

// Lookups for one schema's side of a mapping.
export function sideContext(state, schemaId) {
  const inSchema = (x) => x.schemaId === schemaId
  const objectTypes = (state.objectTypes ?? []).filter(inSchema)
  const facts = (state.facts ?? []).filter(f => inSchema(f) && !f._implicit)
  const constraints = (state.constraints ?? []).filter(inSchema)
  const subtypes = (state.subtypes ?? []).filter(inSchema)
  const schema = state.schemas?.find(s => s.id === schemaId)
  const relational = schema?.profile === 'relational'
  const rm = relational ? relationalModel(state, schemaId) : null
  return {
    schemaId, schema, relational, objectTypes, facts, constraints, subtypes,
    otById: new Map(objectTypes.map(o => [o.id, o])),
    factById: new Map(facts.map(f => [f.id, f])),
    tableById: new Map((rm?.tables ?? []).map(t => [t.id, t])),
    tables: rm?.tables ?? [],
  }
}

// Whether a variable of type a may stand where type b is expected: the same
// type, or one a subtype (transitively) of the other.
export function typesMeet(a, b, ctx) {
  if (!a || !b || a === b) return true
  const ups = (id) => {
    const seen = new Set([id]), q = [id]
    while (q.length) { const c = q.shift(); for (const st of ctx.subtypes ?? []) if (st.subId === c && !seen.has(st.superId)) { seen.add(st.superId); q.push(st.superId) } }
    return seen
  }
  return ups(a).has(b) || ups(b).has(a)
}

// ── Expansion of relational atoms ────────────────────────────────────────────

// The side with every relational atom spelt out in encoding B: a row variable
// of the table's type, and per column a fact atom with a binding. Atom
// objects that are not relational are kept as they are. Synthetic variables
// get ids from `fresh`; `origin` maps every new atom to the relational atom it
// came from.
export function expandSide(side, ctx) {
  side = asSide(side)
  let n = 0
  const origin = new Map()
  const expandList = (vars, atoms) => {
    const outVars = [...(vars ?? [])], outAtoms = []
    for (const a of atoms ?? []) {
      if (a.t === 'rel') {
        const table = ctx.tableById.get(a.tableId)
        const row = { id: `_row${++n}`, typeId: a.tableId, synthetic: true }
        outVars.push(row)
        const add = (x) => { origin.set(x, a); return x }
        outAtoms.push(add({ t: 'type', typeId: a.tableId, arg: row.id }))
        for (const col of table?.columns ?? []) {
          const arg = a.args?.[col.fact.id]
          if (!arg) continue
          const args = (val) => { const r = [null, null]; r[col.t] = row.id; r[col.v] = val; return r }
          if (arg.k === 'var') outAtoms.push(add({ t: 'fact', factId: col.fact.id, args: args(arg.v ?? null) }))
          else if (arg.k === 'fv' || arg.k === 'const') {
            const v = { id: `_col${++n}`, typeId: col.vt.id, synthetic: true }
            outVars.push(v)
            outAtoms.push(add({ t: 'fact', factId: col.fact.id, args: args(v.id) }))
            outAtoms.push(add(arg.k === 'fv' ? { t: 'bind', v: v.id, y: arg.y } : { t: 'const', v: v.id, text: arg.text }))
          } else if (arg.k === 'opt') {
            const v = { id: `_col${++n}`, typeId: col.vt.id, synthetic: true }
            outAtoms.push(add({ t: 'opt', y: arg.y, vars: [v], atoms: [
              add({ t: 'fact', factId: col.fact.id, args: args(v.id) }),
              add({ t: 'bind', v: v.id, y: arg.y }),
            ] }))
          } else if (arg.k === 'absent') {
            const v = { id: `_col${++n}`, typeId: col.vt.id, synthetic: true }
            outAtoms.push(add({ t: 'not', vars: [v], atoms: [add({ t: 'fact', factId: col.fact.id, args: args(v.id) })] }))
          }
        }
      } else if (a.t === 'opt' || a.t === 'not') {
        const inner = expandList(a.vars, a.atoms)
        const b = { ...a, vars: inner.vars, atoms: inner.atoms }
        origin.set(b, a)
        outAtoms.push(b)
      } else outAtoms.push(a)
    }
    return { vars: outVars, atoms: outAtoms }
  }
  return { ...expandList(side.vars, side.atoms), origin }
}

// ── Frontier variables ───────────────────────────────────────────────────────

// The frontier variables a side uses, with where: { name → { top, guards, inner } }
// top: bound at the top level; guards: guards an optional part; inner: bound
// inside optional or negated parts.
export function frontierUse(side) {
  side = asSide(side)
  const use = new Map()
  const get = (y) => { if (!use.has(y)) use.set(y, { top: 0, guards: 0, inner: 0, negated: 0 }); return use.get(y) }
  const walk = (atoms, where) => {
    for (const a of atoms ?? []) {
      if (a.t === 'bind' && a.y) get(a.y)[where]++
      if (a.t === 'rel') for (const arg of Object.values(a.args ?? {})) {
        if (arg?.k === 'fv' && arg.y) get(arg.y)[where]++
        if (arg?.k === 'opt' && arg.y) { get(arg.y).guards++ }
      }
      if (a.t === 'opt') { if (a.y) get(a.y).guards++; walk(a.atoms, 'inner') }
      if (a.t === 'not') walk(a.atoms, 'negated')
    }
  }
  walk(side.atoms, 'top')
  return use
}

// ── Checks ───────────────────────────────────────────────────────────────────

// The identifying uniqueness constraints of a side's schema as pattern keys
// (D2–D4): internal ones per fact type, and external ones as a set of
// (fact, determining role, entity role) triples over one entity variable.
function keysOf(ctx) {
  const internal = new Map()   // factId → [[roleIndex, …], …]
  for (const f of ctx.facts) {
    const ks = []
    for (const u of f.uniqueness ?? []) if (u.roles?.length) ks.push(u.roles)
    for (const u of f.preferredUniqueness ?? []) if (u?.length) ks.push(u)
    internal.set(f.id, ks)
  }
  const external = []
  for (const c of ctx.constraints) {
    if (c.constraintType !== 'uniqueness') continue
    const seq = (c.sequences?.[0] ?? []).filter(m => m?.kind === 'role' && ctx.factById.has(m.factId))
    if (!seq.length) continue
    const parts = []
    let ok = true
    for (const m of seq) {
      const f = ctx.factById.get(m.factId)
      if (f.roles.length !== 2) { ok = false; break }
      parts.push({ factId: f.id, keyRole: m.roleIndex, joinRole: 1 - m.roleIndex })
    }
    if (ok) external.push(parts)
  }
  return { internal, external }
}

// The variables of an expanded side that its keys determine, starting from
// `start` (Definition "determined" in schema-mappings.tex).
function determined(vars, atoms, ctx, keys, start = new Set()) {
  const D = new Set(start)
  const facts = atoms.filter(a => a.t === 'fact')
  for (const a of atoms) if ((a.t === 'bind' || a.t === 'const') && a.v) D.add(a.v)
  for (let changed = true; changed;) {
    changed = false
    const add = (v) => { if (v && !D.has(v)) { D.add(v); changed = true } }
    for (const a of facts) {
      // D3: a uniqueness constraint whose positions are all determined.
      for (const k of keys.internal.get(a.factId) ?? []) {
        if (k.every(i => a.args[i] && D.has(a.args[i]))) a.args.forEach(add)
      }
    }
    // D2/D4: an external uniqueness constraint whose key roles are determined
    // in atoms that share the variable at the other role.
    for (const parts of keys.external) {
      const cands = new Set(facts.filter(a => a.factId === parts[0].factId).map(a => a.args[parts[0].joinRole]).filter(Boolean))
      for (const e of cands) {
        if (D.has(e)) continue
        const all = parts.every(p => facts.some(a => a.factId === p.factId && a.args[p.joinRole] === e && a.args[p.keyRole] && D.has(a.args[p.keyRole])))
        if (all) add(e)
      }
    }
  }
  return D
}

// Problems with one rule of a mapping, as [{ severity: 'error' | 'warning',
// side: 'source' | 'target' | null, text }].
export function checkRule(rule, mapping, state, ctxs = null) {
  const issues = []
  const ctxOf = (side) => ctxs?.[side] ?? sideContext(state, sideSchemaId(mapping, side))
  const uses = {}
  for (const side of SIDES) {
    const ctx = ctxOf(side)
    const label = side === 'source' ? 'Source' : 'Target'
    const err = (text, severity = 'error') => issues.push({ severity, side, text: `${label}: ${text}` })
    if (isEmptyTree(rule[side])) { err('the pattern is empty', 'warning'); uses[side] = new Map(); continue }
    const flat = Array.isArray(rule[side].atoms) ? { side: rule[side], problems: [] } : treeToSide(rule[side])
    const pat = flat.side
    for (const p of new Set(flat.problems)) err(p)

    // Elements of the right schema, and atoms filled in.
    const varIds = new Set()
    const varType = new Map()
    const scanVars = (vars) => { for (const v of vars ?? []) { varIds.add(v.id); varType.set(v.id, v.typeId) } }
    const scan = (vars, atoms) => {
      scanVars(vars)
      for (const a of atoms ?? []) {
        if (a.t === 'fact') {
          const f = ctx.factById.get(a.factId)
          if (!f) err('a fact atom has no fact type of this schema')
          else if (a.args.some(x => !x)) err(`a variable is missing in ${readingName(f, ctx)}`)
          else f.roles.forEach((r, i) => {
            if (!typesMeet(varType.get(a.args[i]), r.objectTypeId, ctx)) err(`in ${readingName(f, ctx)}, role ${i + 1} is played by ${ctx.otById.get(r.objectTypeId)?.name ?? '?'}, not ${ctx.otById.get(varType.get(a.args[i]))?.name ?? '?'}`)
          })
        } else if (a.t === 'type') {
          if (!ctx.otById.has(a.typeId)) err('a type atom has no type of this schema')
          else if (!a.arg) err(`a variable is missing in ${ctx.otById.get(a.typeId).name}(…)`)
          else if (!typesMeet(varType.get(a.arg), a.typeId, ctx)) err(`${ctx.otById.get(varType.get(a.arg))?.name ?? '?'} and ${ctx.otById.get(a.typeId).name} have no common subtype or supertype`)
        } else if (a.t === 'bind') {
          if (!a.v || !a.y) err('a binding needs a variable and a frontier variable')
          else {
            // (P2): a value, or an entity with a simple reference scheme.
            const t = ctx.otById.get(varType.get(a.v))
            if (t?.kind === 'entity') err(`${t.name} is an entity type; bind its reference value, or a value type, to ŷ${a.y}`, 'warning')
          }
        } else if (a.t === 'const') {
          if (!a.v || !String(a.text ?? '').trim()) err('a constant needs a variable and a value')
        } else if (a.t === 'rel') {
          const tb = ctx.tableById.get(a.tableId)
          if (!tb) err('a relational atom has no table of this schema')
          else for (const [fid, arg] of Object.entries(a.args ?? {})) {
            const col = tb.columns.find(c => c.fact.id === fid)
            if (!col) err(`${tb.name} has no column for one of the arguments`)
            else if ((arg.k === 'fv' || arg.k === 'opt') && !arg.y) err(`${tb.name}.${col.name} needs a frontier variable name`)
            else if (arg.k === 'const' && !String(arg.text ?? '').trim()) err(`${tb.name}.${col.name} needs a constant`)
            else if (arg.k === 'var' && !arg.v) err(`${tb.name}.${col.name} needs a variable`)
            else if (arg.k === 'var' && !typesMeet(varType.get(arg.v), col.vt.id, ctx)) err(`${tb.name}.${col.name} holds ${col.vt.name}, not ${ctx.otById.get(varType.get(arg.v))?.name ?? '?'}`)
          }
        } else if (a.t === 'opt') {
          if (!a.y) err('an optional part needs a guard ŷ')
          scan(a.vars, a.atoms)
        } else if (a.t === 'not') scan(a.vars, a.atoms)
      }
    }
    scan(pat.vars, pat.atoms)

    // (P2) frontier variables: bound at the top level, or the guard of
    // exactly one optional part and not used outside it.
    const use = frontierUse(pat)
    uses[side] = use
    for (const [y, u] of use) {
      if (u.guards > 1) err(`ŷ${y} guards more than one optional part`)
      if (u.guards && u.top) err(`ŷ${y} guards an optional part, so it can't be bound outside it`)
      if (!u.guards && !u.top && u.inner) err(`ŷ${y} is bound only inside an optional part it does not guard`)
      if (!u.guards && !u.top && !u.inner && u.negated) err(`ŷ${y} is bound only inside a negation`)
    }

    // Key-safety: every local variable determined by the bindings and keys.
    const ex = expandSide(pat, ctx)
    const keys = keysOf(ctx)
    const D = determined(ex.vars, ex.atoms, ctx, keys)
    const names = variableNames(pat, ctx)
    const undetermined = ex.vars.filter(v => !D.has(v.id))
    const rowsOf = new Map()
    for (const v of undetermined) {
      if (v.synthetic && v.id.startsWith('_row')) {
        const t = ctx.otById.get(v.typeId)
        err(`the row of ${t?.name ?? 'a table'} is not determined: bind all columns of a key`, 'warning')
      } else if (!v.synthetic) err(`${names.get(v.id) ?? 'a variable'} is not determined by the frontier variables and the keys`, 'warning')
      rowsOf.set(v.id, true)
    }
    // Optional parts: their variables determined from the context and the guard.
    const walkOpt = (atoms, Dctx) => {
      for (const a of atoms) {
        if (a.t !== 'opt') continue
        const inner = determined(a.vars, [...ex.atoms.filter(x => x.t === 'fact'), ...a.atoms], ctx, keys, Dctx)
        for (const v of a.vars ?? []) if (!inner.has(v.id) && !v.synthetic) err(`${names.get(v.id) ?? 'a variable'} in the optional part [ŷ${a.y}] is not determined`, 'warning')
        walkOpt(a.atoms, inner)
      }
    }
    walkOpt(ex.atoms, D)
  }
  // Every frontier variable on both sides.
  const s = uses.source ?? new Map(), t = uses.target ?? new Map()
  for (const y of s.keys()) if (!t.has(y)) issues.push({ severity: 'error', side: 'target', text: `ŷ${y} occurs in the source pattern only` })
  for (const y of t.keys()) if (!s.has(y)) issues.push({ severity: 'error', side: 'source', text: `ŷ${y} occurs in the target pattern only` })
  return issues
}

// ── Names and text ───────────────────────────────────────────────────────────

const SUB = '₀₁₂₃₄₅₆₇₈₉'
const sub = (n) => String(n).split('').map(d => SUB[+d]).join('')

// Display names of a side's variables: the type's name, as in the
// Constraints tab's formulas, with a subscript when several share it.
export function variableNames(side, ctx) {
  side = asSide(side)
  const all = []
  const collect = (vars, atoms) => {
    for (const v of vars ?? []) all.push(v)
    for (const a of atoms ?? []) if (a.t === 'opt' || a.t === 'not') collect(a.vars, a.atoms)
  }
  collect(side.vars, side.atoms)
  const base = (v) => (ctx.otById.get(v.typeId)?.name ?? '').replace(/\s+/g, '') || 'x'
  const count = new Map()
  for (const v of all) count.set(base(v), (count.get(base(v)) ?? 0) + 1)
  const seen = new Map(), out = new Map()
  for (const v of all) {
    const b = base(v)
    const k = (seen.get(b) ?? 0) + 1
    seen.set(b, k)
    out.set(v.id, count.get(b) > 1 ? b + sub(k) : b)
  }
  return out
}

export function readingName(f, ctx) {
  const parts = plainParts(f.readingParts ?? [], f.roles.length)
  const words = []
  f.roles.forEach((r, i) => {
    if (parts[i]?.trim()) words.push(parts[i].trim())
    words.push(ctx.otById.get(r.objectTypeId)?.name ?? '?')
  })
  if (parts[f.roles.length]?.trim()) words.push(parts[f.roles.length].trim())
  return words.join(' ')
}

// A side as a list of tokens [{ text, kind }] (kind: 'var', 'fv', 'op',
// 'type', 'reading', 'const', 'plain'), the way ConstraintsTab colours them.
export function sideTokens(side, ctx) {
  side = asSide(side)
  const names = variableNames(side, ctx)
  const out = []
  const push = (text, kind = 'plain') => out.push({ text, kind })
  const vname = (id) => names.get(id) ?? '□'
  const atom = (a) => {
    if (a.t === 'fact') {
      const f = ctx.factById.get(a.factId)
      if (!f) { push('□', 'op'); return }
      const parts = plainParts(f.readingParts ?? [], f.roles.length)
      f.roles.forEach((r, i) => {
        if (parts[i]?.trim()) push(` ${parts[i].trim()} `, 'reading')
        push(vname(a.args[i]), 'var')
      })
      if (parts[f.roles.length]?.trim()) push(` ${parts[f.roles.length].trim()}`, 'reading')
    } else if (a.t === 'type') {
      push(ctx.otById.get(a.typeId)?.name ?? '□', 'type'); push('('); push(vname(a.arg), 'var'); push(')')
    } else if (a.t === 'bind') {
      push(vname(a.v), 'var'); push(' ≈ ', 'op'); push(`ŷ${a.y || '□'}`, 'fv')
    } else if (a.t === 'const') {
      push(vname(a.v), 'var'); push(' ≈ ', 'op'); push(`'${a.text ?? ''}'`, 'const')
    } else if (a.t === 'rel') {
      const tb = ctx.tableById.get(a.tableId)
      push(tb?.name ?? '□', 'type'); push('(')
      const cols = (tb?.columns ?? []).filter(c => a.args?.[c.fact.id])
      cols.forEach((c, i) => {
        if (i) push(', ')
        push(`${c.name}: `, 'reading')
        const arg = a.args[c.fact.id]
        if (arg.k === 'fv') push(`ŷ${arg.y || '□'}`, 'fv')
        else if (arg.k === 'opt') push(`ŷ${arg.y || '□'}?`, 'fv')
        else if (arg.k === 'const') push(`'${arg.text ?? ''}'`, 'const')
        else if (arg.k === 'absent') push('−', 'op')
        else if (arg.k === 'var') push(vname(arg.v), 'var')
      })
      if (cols.length < (tb?.columns.length ?? 0)) push(cols.length ? ', …' : '…')
      push(')')
    } else if (a.t === 'opt' || a.t === 'not') {
      if (a.t === 'opt') { push(`[ŷ${a.y || '□'}]`, 'fv'); push(' ') }
      else push('¬', 'op')
      if (a.vars?.length) { push('∃', 'op'); push(a.vars.map(v => vname(v.id)).join(', '), 'var'); push(' ') }
      push('(')
      list(a.atoms)
      push(')')
    }
  }
  const list = (atoms) => (atoms ?? []).forEach((a, i) => { if (i) push(' ∧ ', 'op'); atom(a) })
  const top = (side.vars ?? [])
  if (!side.atoms?.length) { push('⊤', 'op'); return out }
  if (top.length) { push('∃', 'op'); push(top.map(v => vname(v.id)).join(', '), 'var'); push(' (') }
  list(side.atoms)
  if (top.length) push(')')
  return out
}

export const tokensText = (tokens) => tokens.map(t => t.text).join('')

// ── Store maintenance ────────────────────────────────────────────────────────

// Mappings read from a file: well-formed objects only.
export function loadMappings(raw, schemaIds) {
  if (!Array.isArray(raw)) return []
  return raw.filter(m => m && typeof m === 'object' && schemaIds.has(m.sourceSchemaId) && schemaIds.has(m.targetSchemaId))
    .map(m => ({
      id: String(m.id ?? uid()), name: String(m.name ?? 'Mapping'),
      sourceSchemaId: m.sourceSchemaId, targetSchemaId: m.targetSchemaId,
      rules: (Array.isArray(m.rules) ? m.rules : []).filter(r => r && typeof r === 'object').map(r => ({
        id: String(r.id ?? uid()), name: String(r.name ?? ''),
        source: normPattern(r.source), target: normPattern(r.target),
      })),
    }))
}
const normPattern = (p) => (p && typeof p === 'object' && typeof p.t === 'string' ? p : { t: 'hole' })

// ── Elements of a rule ───────────────────────────────────────────────────────

// The schema elements a pattern names, for drawing a rule in a mapping
// diagram: { typeIds, factIds, tableIds, columnFactIds }. A table row names
// its table (an entity type of encoding B) and the column fact types it gives
// an argument; fact and type atoms name their fact type or type; varTypeIds
// are the types of its ∃ variables.
export function patternElements(tree) {
  const out = { typeIds: new Set(), factIds: new Set(), tableIds: new Set(), columnFactIds: new Set(), varTypeIds: new Set() }
  const walk = (n) => {
    if (!n || typeof n !== 'object') return
    switch (n.t) {
      case 'fact': if (n.factId) out.factIds.add(n.factId); return
      case 'type': if (n.typeId) out.typeIds.add(n.typeId); return
      case 'rel':
        if (n.tableId) out.tableIds.add(n.tableId)
        for (const [colId, arg] of Object.entries(n.args ?? {})) if (arg) out.columnFactIds.add(colId)
        return
      case 'and': for (const a of n.args ?? []) walk(a); return
      case 'exists': if (n.v?.typeId) out.varTypeIds.add(n.v.typeId); walk(n.body); return
      case 'opt': walk(n.body); return
      case 'not': walk(n.arg); return
      default:
        // A flat side (older form) lists its atoms.
        if (Array.isArray(n.atoms)) for (const a of n.atoms) walk(a)
    }
  }
  walk(tree)
  return {
    typeIds: [...out.typeIds], factIds: [...out.factIds],
    tableIds: [...out.tableIds], columnFactIds: [...out.columnFactIds],
    varTypeIds: [...out.varTypeIds],   // types of the ∃ variables, for highlighting
  }
}

// Both sides of a rule: { source, target } of patternElements.
export const ruleElements = (rule) => ({ source: patternElements(rule?.source), target: patternElements(rule?.target) })

// Every element id a rule names, on one side or both.
export function ruleElementIds(rule, sides = SIDES) {
  const ids = new Set()
  const els = ruleElements(rule)
  for (const side of sides) for (const k of ['typeIds', 'factIds', 'tableIds', 'columnFactIds']) for (const id of els[side][k]) ids.add(id)
  return [...ids]
}
