// Formula constraints: a closed formula of the ORM2 logic, stored in the rule
// tree format of derivation rules (derivationRule.js) as constraint.rule, for
// constraints that have no graphical form. constraintType 'formula'; the
// constraint has no role sequences. It is drawn as a badge linked to the fact
// types its formula names.

import { checkFormula, formulaVariables, ruleFormula, upgradeRule, childPaths, getAt } from './derivationRule.js'

export const FORMULA = 'formula'
export const isFormulaConstraint = (c) => c?.constraintType === FORMULA

// Validation messages for the formula (rule: a draft, else the stored one).
export function checkFormulaConstraint(c, state, ctx, typing = { sorts: new Map(), params: new Map() }, rule = c.rule) {
  if (!rule) return [{ path: [], severity: 'error', message: 'There is no formula yet' }]
  const r = upgradeRule(rule)
  const { nameOf } = formulaVariables(r, [], ctx)
  return checkFormula(r, [], { nameOf }, state, ctx, typing).issues
}

// The Constraints tab entry: the formula itself, or a note when it is not
// complete yet.
export function formulaConstraintEntry(c, state, ctx, rule = c.rule) {
  const base = { key: c.id, elementId: c.id, kind: 'Formula constraint', subject: c.name || '' }
  const typing = { sorts: new Map(), params: new Map() }
  const errors = checkFormulaConstraint(c, state, ctx, typing, rule).filter(i => i.severity === 'error')
  if (errors.length) return { ...base, note: `No formula yet. ${errors[0].message}.` }
  const r = upgradeRule(rule)
  const { vars } = formulaVariables(r, [], ctx)
  return { ...base, formula: ruleFormula(r, vars, ctx, typing) }
}

// The fact types (implied links as their objectified fact type) and object
// types the formula names, for drawing its links and for scoping.
export function formulaElements(rule) {
  const facts = new Set(), types = new Set()
  const walk = (n) => {
    if (!n || typeof n !== 'object') return
    if (n.t === 'fact' && n.factId) facts.add(String(n.factId).split('_il_')[0])
    if (n.t === 'type' && n.typeId) types.add(n.typeId)
    for (const p of childPaths(n)) walk(getAt(n, p))
    if (n.v?.typeId) types.add(n.v.typeId)
    for (const v of [...(n.vars ?? [])]) if (v?.typeId) types.add(v.typeId)
  }
  walk(rule)
  return { facts, types }
}
