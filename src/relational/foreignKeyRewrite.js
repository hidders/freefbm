// Assertions that are foreign keys (constraint enforcement, stage 1).
//
// A constraint carried to a relational schema as a formula (Generate's "Keep
// every constraint", a carried translation, a subset with join paths) is often
// a foreign key in disguise: ∀x̄ (L → ∃r T(r, x̄)) where L reads one row s of a
// table S with x̄ in some of its columns, and the columns of T that r reads x̄
// from are a key of T. Every SQL DBMS enforces that as
//
//   FOREIGN KEY S (cols x̄ is read from) REFERENCES T (cols of r)
//
// as long as L says no more than "s is a row of S with those columns filled
// in". L may say more when the tables imply it:
//
//   - another column of s read into a variable used nowhere else, when the
//     column is NOT NULL (a nullable one would make L narrower);
//   - a guard row g of another table whose columns hold some of x̄ (∃ staff
//     (staff has person_nr)), when a chain of foreign keys from s gives such
//     a row (s → offering → course);
//   - a type atom of a row's own table, and x ≈ y between variables.
//
// The columns of r must hold a key of T; when they are more than a key, a
// UNIQUE on them makes them one (addUnique).
//
// asForeignKey(formula, model) → { fromTable, from: [col], toTable, to: [col],
//   existing: fk | null, addUnique } | null, with model from relationalModel;
//   existing is the foreign key of the model that already says the same.

import { isKey } from './relationalModel.js'

const isVar = (x) => x && typeof x === 'object' && !x.t

export function asForeignKey(formula, model) {
  let f = formula
  if (!f || f.t === 'obligatory') return null
  const tableById = new Map(model.tables.map(t => [t.id, t]))
  const univ = []
  while (f.t === 'forall') { univ.push(...f.vars); f = f.body }
  if (f.t !== 'implies') return null

  // Conjuncts, with ∃ taken out (its variables are then existential in L,
  // and stay existential in R).
  const flat = (g, vars, out) => {
    if (!g) return out
    if (g.t === 'and') { g.args.forEach(a => flat(a, vars, out)); return out }
    if (g.t === 'exists') { vars.push(...g.vars); return flat(g.body, vars, out) }
    if (g.t === 'true') return out
    out.push(g)
    return out
  }
  const lVars = [...univ], rVars = []
  const left = flat(f.left, lVars, []), right = flat(f.right, rVars, [])

  // x ≈ y between variables: one variable.
  const parent = new Map()
  const rep = (v) => { let x = v; while (parent.has(x)) x = parent.get(x); return x }
  const merge = (list) => list.filter(a => {
    if (a.t === 'vcmp' && a.op === '≈' && isVar(a.left) && isVar(a.right)) {
      const x = rep(a.left), y = rep(a.right)
      if (x !== y) parent.set(x, y)
      return false
    }
    return true
  })
  const lAtoms = merge(left), rAtoms = merge(right)

  // An atom as { row, col, value }: a column read from a row variable.
  const asCol = (a) => {
    if (a.t !== 'fact') return null
    const col = model.columnByFact.get(a.factId)
    if (!col || !isVar(a.args[col.t]) || !isVar(a.args[col.v])) return null
    const row = rep(a.args[col.t])
    if (tableById.get(row.typeId) !== col.table) return null
    return { row, col, value: rep(a.args[col.v]) }
  }
  const isTypeOf = (a, row) => a.t === 'type' && isVar(a.arg) && rep(a.arg) === row && a.typeId === row.typeId

  // R: one row r of T, each column read into a variable of L.
  const rRows = [...new Set(rVars.map(rep).filter(v => tableById.has(v.typeId)))]
  if (rRows.length !== 1) return null
  const r = rRows[0], T = tableById.get(r.typeId)
  const target = new Map()               // variable → column of T
  for (const a of rAtoms) {
    if (isTypeOf(a, r)) continue
    const c = asCol(a)
    if (!c || c.row !== r || target.has(c.value)) return null
    if (rVars.map(rep).includes(c.value)) return null   // a column that only has to be filled in
    target.set(c.value, c.col)
  }
  if (!target.size) return null
  if (rVars.some(v => rep(v) !== r && !target.has(rep(v)) && !lVars.map(rep).includes(rep(v)))) return null

  // L: the atoms by row variable.
  const reads = new Map()                // row → [{ col, value }]
  const uses = new Map()                 // variable → number of atoms using it
  const rowTypes = new Set()
  for (const a of lAtoms) {
    if (a.t === 'type' && isVar(a.arg) && rep(a.arg).typeId === a.typeId && tableById.has(a.typeId)) { rowTypes.add(rep(a.arg)); continue }
    const c = asCol(a)
    if (!c) return null
    if (!reads.has(c.row)) reads.set(c.row, [])
    reads.get(c.row).push(c)
    uses.set(c.value, (uses.get(c.value) ?? 0) + 1)
  }
  for (const v of rowTypes) if (!reads.has(v)) return null

  for (const [s, cols] of reads) {
    const S = tableById.get(s.typeId)
    const from = new Map()               // variable of x̄ → column of S
    let ok = true
    for (const { col, value } of cols) {
      if (target.has(value)) {
        if (from.has(value)) { ok = false; break }   // two columns that must be equal
        from.set(value, col)
      } else if (uses.get(value) !== 1 || !(col.notNull || col.pk)) { ok = false; break }
    }
    if (!ok || from.size !== target.size) continue
    // Rows the foreign keys of S give (a few steps), as column → variable.
    const known = [{ table: S, cols: new Map(cols.map(c => [c.col.fact.id, c.value])) }]
    for (let i = 0; i < known.length && known.length < 40; i++) {
      const k = known[i]
      for (const fk of model.fks.filter(x => x.fromTable === k.table)) {
        if (!fk.from.every(c => k.cols.has(c.fact.id))) continue
        const cols2 = new Map(fk.to.map((c, j) => [c.fact.id, k.cols.get(fk.from[j].fact.id)]))
        if (!known.some(x => x.table === fk.toTable && [...cols2].every(([id, v]) => x.cols.get(id) === v))) known.push({ table: fk.toTable, cols: cols2 })
      }
    }
    // Every other row of L must be one of those.
    const guarded = [...reads].every(([g, gCols]) => g === s
      || known.some(k => k.table.id === g.typeId && gCols.every(c => k.cols.get(c.col.fact.id) === c.value)))
    if (!guarded) continue
    const xs = [...target.keys()]
    const fromCols = xs.map(x => from.get(x)), toCols = xs.map(x => target.get(x))
    // PostgreSQL (and SQL) wants the referenced columns to be a key; columns
    // that hold a key are one once a UNIQUE says so (it adds nothing else).
    const key = isKey(T, toCols)
    if (!key && ![T.pk, ...T.uniques].some(k => k?.length && k.every(c => toCols.includes(c)))) return null
    const pair = (a, b) => `${a.fact.id}>${b.fact.id}`
    const pairs = new Set(fromCols.map((c, i) => pair(c, toCols[i])))
    const existing = model.fks.find(fk => fk.fromTable === S && fk.toTable === T && fk.from.length === pairs.size
      && fk.from.every((c, i) => pairs.has(pair(c, fk.to[i])))) ?? null
    return { fromTable: S, from: fromCols, toTable: T, to: toCols, existing, addUnique: !key }
  }
  return null
}
