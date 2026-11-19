// Tests of the role link rule (src/diagram/roleLinks.js), NORMA's
// MultiShapeUtility.FindNearestShapeForElement. Run: npm run test:role-links
import test from 'node:test'
import assert from 'node:assert/strict'
import { nearestTo, nearestPairs, roleLinkIndex, factShapeCentre, normaBarLevels, playerLookup, occurrenceRoleLinks } from '../../src/diagram/roleLinks.js'
import { nearestShapePairs } from '../../src/diagram/normaShapeKeys.js'

// fact type F (role 0 played by A, role 1 by B) and its occurrences
const fact = (occurrenceId, x, y, extra = {}) => ({ id: 'F', occurrenceId, x, y, roles: [{ objectTypeId: 'A' }, { objectTypeId: 'B' }], ...extra })
const ot = (id, occurrenceId, x, y) => ({ id, occurrenceId, x, y })
const linkIds = (facts, players, opts = {}) => {
  const ix = roleLinkIndex({ facts, players, ...opts })
  return facts.map(f => f.roles.map((_, ri) => ix.linkOf(f, ri)?.occurrenceId ?? null))
}

test('one fact occurrence, one player occurrence each: linked', () => {
  assert.deepEqual(linkIds([fact('f1', 0, 0)], [ot('A', 'a1', -100, 0), ot('B', 'b1', 100, 0)]), [['a1', 'b1']])
})

test('a player that is not shown: no link', () => {
  assert.deepEqual(linkIds([fact('f1', 0, 0)], [ot('A', 'a1', -100, 0)]), [['a1', null]])
})

test('two fact occurrences and two player occurrences: each its nearest', () => {
  const facts = [fact('f1', 0, 0), fact('f2', 1000, 0)]
  const players = [ot('A', 'a1', 1100, 0), ot('A', 'a2', -100, 0), ot('B', 'b1', 100, 50), ot('B', 'b2', 900, 50)]
  assert.deepEqual(linkIds(facts, players), [['a2', 'b1'], ['a1', 'b2']])
})

test('two-sided: a nearer occurrence of the fact type takes the link, the other gets none', () => {
  // both fact occurrences are nearest to a1; f2 is nearer to it, so f1's role 0 is left without a link
  const facts = [fact('f1', 0, 0), fact('f2', 150, 0)]
  const players = [ot('A', 'a1', 200, 0), ot('A', 'a2', -400, 0), ot('B', 'b1', 0, 100), ot('B', 'b2', 150, 100)]
  assert.deepEqual(linkIds(facts, players), [[null, 'b1'], ['a1', 'b2']])
})

test('moving across the boundary changes the link, through geometry only', () => {
  const players = [ot('A', 'a1', -100, 0), ot('A', 'a2', 100, 0), ot('B', 'b1', 0, 300)]
  assert.equal(linkIds([fact('f1', -10, 0)], players)[0][0], 'a1')
  assert.equal(linkIds([fact('f1', 10, 0)], players)[0][0], 'a2')
})

test('a tie for the nearest player goes to the occurrence later in the list', () => {
  const players = [ot('A', 'a1', -100, 0), ot('A', 'a2', 100, 0), ot('B', 'b1', 0, 300)]
  assert.equal(linkIds([fact('f1', 0, 0)], players)[0][0], 'a2')
  assert.equal(linkIds([fact('f1', 0, 0)], [players[1], players[0], players[2]])[0][0], 'a1')
  // and it stays that way however often it is asked
  for (let i = 0; i < 5; i++) assert.equal(linkIds([fact('f1', 0, 0)], players)[0][0], 'a2')
})

test('two fact occurrences exactly as near to a player: both linked', () => {
  const facts = [fact('f1', -100, 0), fact('f2', 100, 0)]
  assert.deepEqual(linkIds(facts, [ot('A', 'a1', 0, 0)]).map(r => r[0]), ['a1', 'a1'])
})

test('a ring fact type sends both roles to the same occurrence', () => {
  const ring = { id: 'R', occurrenceId: 'r1', x: 0, y: 0, roles: [{ objectTypeId: 'A' }, { objectTypeId: 'A' }] }
  assert.deepEqual(linkIds([ring], [ot('A', 'a1', -100, 0), ot('A', 'a2', 300, 0)]), [['a1', 'a1']])
})

test('occurrences that take no link are skipped, and a farther one is used (NORMA\'s Defer)', () => {
  const players = [ot('A', 'a1', -50, 0), ot('A', 'a2', -400, 0)]
  const accepts = (p) => p.occurrenceId !== 'a1'
  assert.equal(linkIds([fact('f1', 0, 0)], players, { accepts })[0][0], 'a2')
})

test('factShapeCentre: the bars\' bands move the centre towards them, as NORMA\'s shape', () => {
  const f = { roles: [{}, {}], uniqueness: [{ roles: [0] }], x: 0, y: 0 }
  assert.equal(normaBarLevels(f), 1)
  const r = (c) => ({ x: Math.round(c.x * 1e6) / 1e6 + 0, y: Math.round(c.y * 1e6) / 1e6 + 0 })
  assert.deepEqual(r(factShapeCentre(f)), { x: 0, y: -7 })
  assert.deepEqual(r(factShapeCentre({ ...f, uniquenessBelow: true })), { x: 0, y: 7 })
  assert.deepEqual(r(factShapeCentre({ ...f, orientation: 'vertical' })), { x: 7, y: 0 })
  assert.deepEqual(r(factShapeCentre({ ...f, orientation: 'vertical', uniquenessBelow: true })), { x: -7, y: 0 })
  assert.deepEqual(r(factShapeCentre({ ...f, uniqueness: [] })), { x: 0, y: 0 })
  assert.deepEqual(r(factShapeCentre({ ...f, objectified: true, displayAsObjectType: true })), { x: 0, y: 0 })
  // a unary's bar is not drawn
  assert.equal(normaBarLevels({ roles: [{}], uniqueness: [{ roles: [0] }] }), 0)
})

test('the shape centre can decide between two players', () => {
  // equally far from the role boxes' middle; the bars above make the upper one nearer
  const f = { ...fact('f1', 0, 0), uniqueness: [{ roles: [0] }] }
  const players = [ot('A', 'up', 0, -100), ot('A', 'down', 0, 100)]
  assert.equal(linkIds([f], players, { centre: (o) => o.roles ? factShapeCentre(o) : o })[0][0], 'up')
})

test('playerLookup: the rule decides, stored links are ignored; objectified players', () => {
  const nested = { id: 'N', occurrenceId: 'n1', x: 400, y: 0, objectified: true, roles: [{ objectTypeId: 'A' }, { objectTypeId: 'A' }] }
  const f1 = { ...fact('f1', 0, 0), roles: [{ objectTypeId: 'A' }, { objectTypeId: 'N' }] }
  const ots = [ot('A', 'a1', -100, 0), ot('A', 'a2', 1000, 0)]
  let p = playerLookup(ots, [f1, nested])
  assert.equal(p.forRole(f1, 0).ot.occurrenceId, 'a1')
  assert.equal(p.forRole(f1, 1).nf.occurrenceId, 'n1')
  const old = { ...f1, roleOccurrenceMap: { 0: 'a2' }, unlinkedRoles: [1] }
  p = playerLookup(ots, [old, nested])
  assert.equal(p.forRole(old, 0).ot.occurrenceId, 'a1')
  assert.equal(p.forRole(old, 1).nf.occurrenceId, 'n1')
  assert.equal(p.nearest('A', 900, 0).ot.occurrenceId, 'a2')
})

test('occurrenceRoleLinks: stored occurrences, and a collapsed reference mode by ownership', () => {
  const objectTypes = [{ id: 'A', kind: 'entity', name: 'A' }, { id: 'V', kind: 'value', name: 'A_id' }, { id: 'B', kind: 'entity', name: 'B' }]
  const facts = [
    { id: 'RM', roles: [{ objectTypeId: 'A' }, { objectTypeId: 'V' }], uniqueness: [{ roles: [0] }, { roles: [1] }], preferredUniqueness: [[1]] },
    { id: 'F', roles: [{ objectTypeId: 'A' }, { objectTypeId: 'B' }], uniqueness: [{ roles: [0, 1] }] },
  ]
  const diag = { expandedRefModeOccs: ['a2'], occurrences: [
    { id: 'a1', schemaElementId: 'A', x: 0, y: 0 },
    { id: 'v1', schemaElementId: 'V', x: 160, y: 0, refModeOwnerOccId: 'a1' },
    { id: 'rm1', schemaElementId: 'RM', x: 80, y: 0, refModeOwnerOccId: 'a1' },
    { id: 'a2', schemaElementId: 'A', x: 0, y: 500 },
    { id: 'v2', schemaElementId: 'V', x: 160, y: 500, refModeOwnerOccId: 'a2' },
    { id: 'rm2', schemaElementId: 'RM', x: 80, y: 500, refModeOwnerOccId: 'a2' },
    { id: 'b1', schemaElementId: 'B', x: 300, y: 100 },
    { id: 'f1', schemaElementId: 'F', x: 150, y: 100 },
  ] }
  const links = occurrenceRoleLinks(diag, facts, objectTypes)
  const occ = (id) => diag.occurrences.find(o => o.id === id)
  // hidden (a1 collapsed): by ownership
  assert.equal(links.linkOf(occ('rm1'), 0).id, 'a1')
  assert.equal(links.linkOf(occ('rm1'), 1).id, 'v1')
  // shown (a2 expanded): by the rule
  assert.equal(links.linkOf(occ('rm2'), 0).id, 'a2')
  assert.equal(links.linkOf(occ('rm2'), 1).id, 'v2')
  assert.equal(links.linkOf(occ('f1'), 0).id, 'a1')
  assert.equal(links.linkOf(occ('f1'), 1).id, 'b1')
  assert.deepEqual(links.linkedFrom('v2').map(o => o.id), ['rm2'])
})

test('playerLookup: a collapsed reference mode takes no link from its fact type', () => {
  const ref = { id: 'RM', occurrenceId: 'rm1', x: 0, y: 0, roles: [{ objectTypeId: 'A' }, { objectTypeId: 'V' }] }
  const ots = [ot('A', 'a1', -50, 0), ot('A', 'a2', -300, 0), ot('V', 'v1', 100, 0)]
  const p = playerLookup(ots, [ref], { collapsedRefFacts: { RM: { entityId: 'A' } }, expandedOccs: new Set(['a2']) })
  assert.equal(p.forRole(ref, 0).ot.occurrenceId, 'a2')
})

test('nearestPairs is what the NORMA import uses for role and subtype links', () => {
  assert.equal(nearestShapePairs, nearestPairs)
  assert.equal(nearestTo({ x: 0, y: 0 }, []), null)
})

test('cost per role: only that fact type\'s and player\'s occurrences are compared', () => {
  // 2,000 fact types and object types on one diagram: building and asking every link stays fast
  const facts = [], players = []
  for (let i = 0; i < 2000; i++) {
    facts.push({ id: `F${i}`, occurrenceId: `f${i}`, x: i * 10, y: 0, roles: [{ objectTypeId: `A${i}` }, { objectTypeId: `A${(i + 1) % 2000}` }] })
    players.push(ot(`A${i}`, `a${i}`, i * 10, 100))
  }
  const t = performance.now()
  const ix = roleLinkIndex({ facts, players })
  for (const f of facts) { ix.linkOf(f, 0); ix.linkOf(f, 1) }
  assert.ok(performance.now() - t < 200, 'took too long')
})
