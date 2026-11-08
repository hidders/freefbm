// Variants of the sample for scripts/population-coverage-check.mjs: each adds
// constraints of a kind or shape the sample lacks, or takes away what the
// editor normally adds (the queries of external constraints, as in older or
// imported files). apply(file) changes a copy of sample.ffbm (version 2
// format) and returns it.

const constraint = (id, constraintType, sequences, extra = {}) => ({
  id, kind: 'constraint', constraintType, x: 0, y: 0, sequences, queries: sequences.map(() => null),
  frequency: null, exhaustive: true, exclusive: false, subtypeIds: [], ...extra,
})
const role = (factId, roleIndex) => ({ kind: 'role', factId, roleIndex })
const factType = (id, players, reading, extra = {}) => ({
  id, kind: 'fact', x: 0, y: 0, arity: players.length,
  roles: players.map((objectTypeId, i) => ({ id: `${id}_r${i}`, objectTypeId, roleName: '', mandatory: false })),
  readingParts: ['', reading, ''], alternativeReadings: [], uniqueness: [{ id: `${id}_uc`, roles: [0] }],
  preferredUniqueness: [], internalFrequency: [], implicitLinks: [], ...extra,
})
// A query graph: fact atoms with the sequence positions they give, joined
// through object type atoms (links: [factAtom, roleIndex, typeAtom]).
const graph = (types, facts, links) => ({
  atoms: [
    ...types.map(([id, originalId, isOutput = false]) => ({ id, kind: 'objectType', originalId, isOutput })),
    ...facts.map(([id, originalId, seeded]) => ({ id, kind: 'fact', originalId, isOutput: false,
      seededRoles: seeded.map(([roleIndex, seqPosition]) => ({ roleIndex, seqPosition })) })),
  ],
  links: links.map(([atomId, roleIndex, variableId]) => ({ atomId, roleIndex, variableId })),
})

const OFFERING = 'n1792654764379_4'
const LINK_QUERIES = () => [graph([], [['a', 'f_coordinates', [[1, 0]]]], []), graph([], [['a', `${OFFERING}_il_0`, [[1, 0]]]], [])]
const sch = (file) => file.schema

export const VARIANTS = [
  {
    name: 'cardinality ranges',
    apply(file) {
      const ot = (id) => sch(file).objectTypes.find(o => o.id === id)
      const fact = (id) => sch(file).factTypes.find(f => f.id === id)
      ot('ot_Course').cardinalityRange = [{ type: 'range', lower: '3', upper: '5' }]
      ot('ot_Lecturer').cardinalityRange = [{ type: 'single', value: '2' }]
      fact(OFFERING).cardinalityRange = [{ type: 'upper', upper: '8' }]
      fact('f_coordinates').roles[0].cardinalityRange = [{ type: 'upper', upper: '2' }]
      fact('f_hasPhone').roles[0].cardinalityRange = [{ type: 'lower', lower: '3' }]
      return file
    },
  },
  {
    name: 'more external constraints',
    apply(file) {
      const s = sch(file)
      // Course has maximum Credits, compared with its Credits.
      s.factTypes.push(factType('f_maxCredits', ['ot_Course', 'ot_Credits'], 'has maximum'))
      file.factPopulations.f_maxCredits = [['DB1', '15'], ['DB2', '30'], ['LOG1', '15'], ['KR3', '30']]
      s.externalConstraints.push(
        constraint('c_vcCredits', 'valueComparison', [[role('f_hasCredits', 1), role('f_maxCredits', 1)]], {
          operator: '≤',
          queries: [graph([['v', 'ot_Course']], [['a', 'f_hasCredits', [[1, 0]]], ['b', 'f_maxCredits', [[1, 1]]]], [['a', 0, 'v'], ['b', 0, 'v']])],
        }),
        // At most two rooms with one number across buildings: a frequency
        // over roles of two fact types.
        constraint('c_freqRoom', 'frequency', [[role('f_roomInBuilding', 1), role('f_roomHasNr', 1)]], {
          frequency: [{ type: 'upper', upper: '1' }], targetObjectTypeId: 'ot_Room',
          queries: [graph([['v', 'ot_Room', true]], [['a', 'f_roomInBuilding', [[1, 0]]], ['b', 'f_roomHasNr', [[1, 1]]]], [['a', 0, 'v'], ['b', 0, 'v']])],
        }),
        // At most two courses of one staff member with the same credits.
        constraint('c_freqCoord', 'frequency', [[role('f_hasCredits', 1), role('f_coordinates', 0)]], {
          frequency: [{ type: 'upper', upper: '2' }], targetObjectTypeId: 'ot_Course',
          queries: [graph([['v', 'ot_Course', true]], [['a', 'f_hasCredits', [[1, 0]]], ['b', 'f_coordinates', [[0, 1]]]], [['a', 0, 'v'], ['b', 1, 'v']])],
        }),
        // Every staff member coordinates a course or is qualified for a course
        // that is a prerequisite: a join path in the second sequence.
        constraint('c_orJoin', 'inclusiveOr', [[role('f_coordinates', 0)], [role('f_qualified', 0)]], {
          targetObjectTypeId: 'ot_Staff',
          queries: [graph([], [['a', 'f_coordinates', [[0, 0]]]], []),
            graph([['v', 'ot_Course']], [['a', 'f_qualified', [[0, 0]]], ['b', 'f_prereq', []]], [['a', 1, 'v'], ['b', 0, 'v']])],
        }),
        constraint('c_xorJoin', 'exclusiveOr', [[role('f_coordinates', 0)], [role('f_qualified', 0)]], {
          targetObjectTypeId: 'ot_Staff',
          queries: [graph([], [['a', 'f_coordinates', [[0, 0]]]], []),
            graph([['v', 'ot_Course']], [['a', 'f_qualified', [[0, 0]]], ['b', 'f_prereq', []]], [['a', 1, 'v'], ['b', 0, 'v']])],
        }),
        // Every course is coordinated or offered: a role of an implied link.
        constraint('c_orLink', 'inclusiveOr', [[role('f_coordinates', 1)], [role(`${OFFERING}_il_0`, 1)]], { targetObjectTypeId: 'ot_Course', queries: LINK_QUERIES() }),
        constraint('c_xorLink', 'exclusiveOr', [[role('f_coordinates', 1)], [role(`${OFFERING}_il_0`, 1)]], { targetObjectTypeId: 'ot_Course', queries: LINK_QUERIES() }),
        // The same without queries: no formula yet, and not checked.
        constraint('c_orLinkBare', 'inclusiveOr', [[role('f_coordinates', 1)], [role(`${OFFERING}_il_0`, 1)]], { targetObjectTypeId: 'ot_Course' }),
      )
      return file
    },
  },
  {
    name: 'ring kinds and deontic constraints',
    apply(file) {
      const s = sch(file)
      const ring = s.externalConstraints.find(c => c.id === 'c_prereqRing')
      for (const rt of ['irreflexive', 'reflexive', 'purely-reflexive', 'asymmetric', 'symmetric', 'antisymmetric',
        'transitive', 'intransitive', 'strongly-intransitive', 'acyclic'])
        s.externalConstraints.push({ ...JSON.parse(JSON.stringify(ring)), id: `c_ring_${rt}`, ringTypes: [rt] })
      // Deontic versions of a few constraints, and frequencies that break.
      const fact = (id) => s.factTypes.find(f => f.id === id)
      fact('f_enrols').internalFrequency[0].range = [{ type: 'range', lower: '2', upper: '2' }]
      fact('f_enrols').internalFrequency[0].deontic = true
      fact('f_hasPhone').roles[0].mandatory = true
      fact('f_hasPhone').roles[0].mandatoryDeontic = true
      fact('f_hasCredits').roles[0].cardinalityRange = [{ type: 'upper', upper: '3' }]
      fact('f_hasCredits').roles[0].cardinalityRangeDeontic = true
      s.objectTypes.find(o => o.id === 'ot_Professor').cardinalityRange = [{ type: 'single', value: '1' }]
      s.objectTypes.find(o => o.id === 'ot_Professor').cardinalityRangeDeontic = true
      fact('f_hasTitle').deonticUniqueness = [[1]]
      s.externalConstraints.find(c => c.id === 'c_notBoth').deontic = true
      s.externalConstraints.find(c => c.id === 'c_emailOrPhone').deontic = true
      s.objectTypes.find(o => o.id === 'ot_Grade').valueRangeDeontic = true
      return file
    },
  },
  {
    name: 'no queries',
    // Older and imported files: external constraints over roles of several
    // fact types without the query the editor makes.
    apply(file) {
      const s = sch(file)
      VARIANTS[1].apply(file)
      for (const c of s.externalConstraints) c.queries = (c.sequences ?? []).map(() => null)
      return file
    },
  },
]
