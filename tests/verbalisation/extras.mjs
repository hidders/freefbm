// Additions to the sample model for the verbalisation golden tests: the
// constructs the sample does not use, namely cardinality ranges, derived and
// semi-derived subtypes and fact types, data terms and aggregates, deontic
// constraints and value ranges with open bounds.
// extend(state) returns a new state; the golden test verbalises only the
// entries these additions bring.

const integer = { profileId: 'abstract', datatypeId: 'integer', params: {} }
const valueType = (id, name) => ({ id, kind: 'value', name, x: 0, y: 0, datatypeAssignment: integer })
const entityType = (id, name) => ({ id, kind: 'entity', name, x: 0, y: 0, isPersonal: false })
const role = (id, objectTypeId, extra = {}) => ({ id, objectTypeId, roleName: '', mandatory: false, ...extra })
const fact = (id, readingParts, roles, extra = {}) => ({
  id, kind: 'fact', x: 0, y: 0, arity: roles.length, roles, readingParts, alternativeReadings: [],
  uniqueness: [], preferredUniqueness: [], internalFrequency: [], implicitLinks: [], ...extra,
})
const subtype = (id, subId, superId) => ({ id, kind: 'subtype', subId, superId, inheritsPreferredIdentifier: true })

const v = (id) => ({ t: 'var', id })
const c = (text) => ({ t: 'const', text })
const S = 'subject'

export function extend(state) {
  const objectTypes = state.objectTypes.map(o =>
    o.id === 'ot_Course' ? { ...o, cardinalityRange: [{ type: 'upper', upper: '100' }] }
    : o.id === 'ot_Professor' ? { ...o, cardinalityRange: [{ type: 'range', lower: '2', upper: '20' }] }
    : o.id === 'ot_Building' ? { ...o, cardinalityRange: [{ type: 'single', value: '3' }], cardinalityRangeDeontic: true }
    : o)
  const facts = state.facts.map(f =>
    f.id === 'f_enrols' ? { ...f, roles: f.roles.map((r, i) => i === 1 ? { ...r, cardinalityRange: [{ type: 'upper', upper: '50' }] } : r) }
    : f.id === 'f_coordinates' ? { ...f, roles: f.roles.map((r, i) => i === 0 ? { ...r, cardinalityRange: [{ type: 'lower', lower: '5' }], cardinalityRangeDeontic: true } : r) }
    : f)

  objectTypes.push(
    // Derived: Student is a TeachingAssistant iff Student assists in some Course.
    { ...entityType('ot_TA', 'TeachingAssistant'), derivation: 'derived',
      derivationRule: { t: 'exists', v: { id: 'c', typeId: 'ot_Course' }, body: { t: 'fact', factId: 'f_assists', args: [S, 'c'] } } },
    // Semi-derived, with a counting quantifier.
    { ...entityType('ot_Busy', 'BusyStudent'), derivation: 'semiDerived',
      derivationRule: { t: 'count', op: '≥', n: 4, v: { id: 'c', typeId: 'ot_Course' }, body: { t: 'fact', factId: 'f_enrols', args: [S, 'c'] } } },
    // Derived, with a value comparison.
    { ...entityType('ot_Heavy', 'HeavyCourse'), derivation: 'derived',
      derivationRule: { t: 'exists', v: { id: 'k', typeId: 'ot_Credits' }, body: { t: 'and', args: [
        { t: 'fact', factId: 'f_hasCredits', args: [S, 'k'] },
        { t: 'vcmp', op: '≥', left: v('k'), right: c('30') },
      ] } } },
    // Derived, with a negation and a universal quantifier.
    { ...entityType('ot_Free', 'FreeStudent'), derivation: 'derived',
      derivationRule: { t: 'not', arg: { t: 'exists', v: { id: 'c', typeId: 'ot_Course' }, body: { t: 'fact', factId: 'f_enrols', args: [S, 'c'] } } } },
    // Derived, with a data predicate and a data operator.
    { ...entityType('ot_Intro', 'IntroCourse'), derivation: 'derived',
      derivationRule: { t: 'exists', v: { id: 't', typeId: 'ot_CourseTitle' }, body: { t: 'and', args: [
        { t: 'fact', factId: 'f_hasTitle', args: [S, 't'] },
        { t: 'dpred', op: 'startsWith', args: [v('t'), c('Introduction')] },
      ] } } },
    { ...entityType('ot_LongTitle', 'LongTitleCourse'), derivation: 'semiDerived',
      derivationRule: { t: 'exists', v: { id: 't', typeId: 'ot_CourseTitle' }, body: { t: 'and', args: [
        { t: 'fact', factId: 'f_hasTitle', args: [S, 't'] },
        { t: 'vcmp', op: '>', left: { t: 'op', op: 'length', args: [v('t')] }, right: c('40') },
      ] } } },
    valueType('ot_TotalCredits', 'TotalCredits'),
    valueType('ot_EnrolmentCount', 'EnrolmentCount'),
    // Open bounds: (0..100] and more than 200.
    { ...valueType('ot_Score', 'Score'), valueRangeDeontic: true, valueRange: [
      { type: 'range', lower: '0', upper: '100', lowerOpen: true },
      { type: 'lower', lower: '200', lowerOpen: true },
    ] },
  )
  const subtypes = [...state.subtypes,
    subtype('st_TA', 'ot_TA', 'ot_Student'),
    subtype('st_Busy', 'ot_Busy', 'ot_Student'),
    subtype('st_Heavy', 'ot_Heavy', 'ot_Course'),
    subtype('st_Free', 'ot_Free', 'ot_Student'),
    subtype('st_Intro', 'ot_Intro', 'ot_Course'),
    subtype('st_LongTitle', 'ot_LongTitle', 'ot_Course'),
  ]

  facts.push(
    // Derived, no computed role: Student studies with Staff iff Student
    // enrols in some Course that Staff coordinates.
    fact('f_studiesWith', ['', 'studies with', ''], [role('sw0', 'ot_Student'), role('sw1', 'ot_Staff')], {
      derivation: 'derived',
      derivationRule: { extraVars: [], terms: {}, body: { t: 'exists', v: { id: 'c', typeId: 'ot_Course' }, body: { t: 'and', args: [
        { t: 'fact', factId: 'f_enrols', args: ['role:sw0', 'c'] },
        { t: 'fact', factId: 'f_coordinates', args: ['role:sw1', 'c'] },
      ] } } },
    }),
    // Derived, computed role with a sum.
    fact('f_totalCredits', ['', 'has', ''], [role('tc0', 'ot_Student'), role('tc1', 'ot_TotalCredits')], {
      uniqueness: [[0]], derivation: 'derived',
      derivationRule: { extraVars: [], body: { t: 'true' }, terms: {
        tc1: { t: 'agg', fn: 'sum', distinct: false, vars: [{ id: 'c', typeId: 'ot_Course' }, { id: 'k', typeId: 'ot_Credits' }],
          cond: { t: 'and', args: [
            { t: 'fact', factId: 'f_enrols', args: ['role:tc0', 'c'] },
            { t: 'fact', factId: 'f_hasCredits', args: ['c', 'k'] },
          ] },
          term: v('k') },
      } },
    }),
    // Derived, computed role with a count.
    fact('f_enrolmentCount', ['', 'has', ''], [role('ec0', 'ot_Course'), role('ec1', 'ot_EnrolmentCount')], {
      uniqueness: [[0]], derivation: 'derived',
      derivationRule: { extraVars: [], body: { t: 'true' }, terms: {
        ec1: { t: 'agg', fn: 'count', distinct: false, vars: [{ id: 's', typeId: 'ot_Student' }],
          cond: { t: 'fact', factId: 'f_enrols', args: ['s', 'role:ec0'] } },
      } },
    }),
    // Semi-derived, computed role with arithmetic and an extra variable.
    fact('f_creditLoad', ['', 'has credit load', ''], [role('cl0', 'ot_Student'), role('cl1', 'ot_TotalCredits')], {
      derivation: 'semiDerived',
      derivationRule: { extraVars: [{ id: 'c', typeId: 'ot_Course' }, { id: 'k', typeId: 'ot_Credits' }],
        body: { t: 'and', args: [
          { t: 'fact', factId: 'f_assists', args: ['role:cl0', 'c'] },
          { t: 'fact', factId: 'f_hasCredits', args: ['c', 'k'] },
        ] },
        terms: { cl1: { t: 'op', op: 'mul', args: [{ t: 'op', op: 'add', args: [v('k'), c('5')] }, c('2')] } } },
    }),
  )
  // Deontic constraints: internal uniqueness, mandatory role, frequency,
  // subset and ring.
  facts.push(
    fact('f_mentors', ['', 'mentors', ''], [role('m0', 'ot_Staff'), role('m1', 'ot_Student', { mandatory: true, mandatoryDeontic: true })], {
      uniqueness: [[1]], deonticUniqueness: [[1]],
      internalFrequency: [{ id: 'if_m', roles: [0], range: [{ type: 'upper', upper: '5' }], deontic: true }],
    }),
  )
  const constraints = [...state.constraints,
    { id: 'c_dSubset', kind: 'constraint', constraintType: 'subset', deontic: true, x: 0, y: 0,
      sequences: [[{ kind: 'role', factId: 'f_mentors', roleIndex: 1 }], [{ kind: 'role', factId: 'f_enrols', roleIndex: 0 }]] },
    { id: 'c_dRing', kind: 'constraint', constraintType: 'ring', deontic: true, x: 0, y: 0, ringTypes: ['irreflexive'],
      sequences: [[{ kind: 'role', factId: 'f_prereq', roleIndex: 0 }, { kind: 'role', factId: 'f_prereq', roleIndex: 1 }]] },
  ]
  return { ...state, objectTypes, facts, subtypes, constraints }
}

// The keys of the entries the additions bring.
export const isExtra = (key) => /^(ot_(Course|Professor|Building):card|f_enrols:card|f_coordinates:card|ot_(TA|Busy|Heavy|Free|Intro|LongTitle):derivation|f_(studiesWith|totalCredits|enrolmentCount|creditLoad):derivation|ot_Score:vr|f_mentors:(uc|mand|freq)|c_d(Subset|Ring))/.test(key)
