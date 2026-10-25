// Data values of objects, for the value atoms of the logic.

import { mkVar, exists, and, factAtom, constant } from './formula.js'
import { valueKindName } from '../utils/datatypeValues.js'
import { findRefMode, findInheritedPI } from '../utils/refMode.js'

// ── Data values ──────────────────────────────────────────────────────────────
//
// Value atoms compare the data values of objects. An instance of a value type
// is its value; an entity type with a reference mode,
// possibly inherited, has the value it is identified by, reached through the
// reference mode fact: ∃PersonNr (Person has PersonNr ∧ PersonNr ≈ 5).

// How to reach the data value of an instance of `typeId`:
//   { kindName, via? }   via = { factId, valueIndex, valueTypeId }
// or null when the type has no single value (no reference mode).
export function valueAccess(typeId, ctx) {
  const ot = ctx.otById.get(typeId)
  const f = ctx.factById.get(typeId)
  if (ot?.kind === 'value') return { kindName: valueKindName(ot.datatypeAssignment) }
  const entity = ot ?? f
  if (!entity) return null
  const { facts, objectTypes, subtypes, constraints } = ctx.schema
  let rm = findRefMode(entity, facts, objectTypes)
  if (!rm) {
    const inh = findInheritedPI(entity, facts, objectTypes, subtypes, constraints)
    if (inh?.kind === 'refMode') rm = inh.refMode
  }
  if (!rm) return null
  return { kindName: valueKindName(ctx.otById.get(rm.vtId)?.datatypeAssignment),
    via: { factId: rm.factId, valueIndex: rm.vtRoleIndex, valueTypeId: rm.vtId } }
}

// cond applied to the value variables of the given objects:
//   items = [{ x: Var, access }]   (access from valueAccess)
export function withValues(items, cond) {
  const vars = [], atoms = []
  const vs = items.map(({ x, access }) => {
    if (!access.via) return x
    const v = mkVar(access.via.valueTypeId)
    vars.push(v)
    atoms.push(factAtom(access.via.factId, access.via.valueIndex === 0 ? [v, x] : [x, v]))
    return v
  })
  return exists(vars, and(...atoms, cond(...vs)))
}

// Numbers and booleans are shown as they are; other constants are quoted.
const UNQUOTED_KINDS = new Set(['integer', 'decimal', 'float', 'boolean'])
const NUMBER_RE = /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/

// The constant for a literal under the datatype kind (null: not known).
export function valueConstant(raw, kindName) {
  const text = String(raw).trim()
  return constant(text, kindName ? !UNQUOTED_KINDS.has(kindName) : !NUMBER_RE.test(text))
}
