// Regression checks for role connectors that follow from positions
// (docs/nearest-role-connectors.md, "Required regression scenarios"). The
// rule itself (scenarios 1–5) is tested in tests/diagram/roleLinks.test.mjs;
// this script runs the rest against the real store, auto layout and NORMA
// import and export, in a browser page served by Vite.
//
//   node scripts/role-links-check.mjs [file.orm|file.ffbm …]
//
// Without files it uses the sample (src/data/sample.ffbm). Each file given is
// also taken through NORMA and back (scenario 14): export → import keeps
// every occurrence and every role connector, and a NORMA file's import keeps
// exactly NORMA's shapes. Exit code 1 when a check fails. Playwright is taken
// from NODE_PATH or a global install, as in the other check scripts.
import { createServer } from 'vite'
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const files = process.argv.slice(2)
const require = createRequire(path.join(process.cwd(), 'noop.js'))
let playwright
try { playwright = require('playwright') }
catch {
  const g = execFileSync('npm', ['root', '-g']).toString().trim()
  playwright = createRequire(path.join(g, 'noop.js'))('playwright')
}
const server = await createServer({ server: { port: 5196, strictPort: false }, logLevel: 'error' })
await server.listen()
const url = server.resolvedUrls.local[0]
let browser
try { browser = await playwright.chromium.launch() }
catch { browser = await playwright.chromium.launch({ channel: 'chrome' }) }
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } })
const pageErrors = []
page.on('pageerror', e => pageErrors.push(e.message))
page.on('dialog', d => d.accept())
await page.goto(url)
await page.waitForSelector('#root > *', { timeout: 60000 })

let failed = 0
const report = (name, results) => {
  console.log(name)
  for (const [label, ok, detail] of results) {
    if (!ok) failed++
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? `: ${detail}` : ''}`)
  }
}

// ── scenarios 6–13 on the sample ───────────────────────────────────────────
const sample = fs.readFileSync('src/data/sample.ffbm', 'utf8')
report('sample: diagram operations', await page.evaluate(scenarios, sample))

// ── scenario 14: NORMA and back ────────────────────────────────────────────
const inputs = files.length ? files : ['src/data/sample.ffbm']
for (const f of inputs) {
  const content = fs.readFileSync(f, 'utf8')
  report(`${path.basename(f)}: NORMA round trip`, await page.evaluate(normaRoundTrip, { name: path.basename(f), content, isOrm: /\.orm$/i.test(f) }))
}
if (pageErrors.length) { failed++; console.log('page errors:\n  ' + pageErrors.slice(0, 5).join('\n  ')) }
await browser.close()
await server.close()
console.log(failed ? `${failed} check(s) failed` : 'all checks passed')
process.exit(failed ? 1 : 0)

// Runs in the page.
async function scenarios(sampleText) {
  const { useOrmStore: S } = await import('/src/store/ormStore.js')
  const { occurrenceRoleLinks } = await import('/src/diagram/roleLinks.js')
  const { placeRevealed, placeOrmUnits } = await import('/src/layout/growPlacement.js')
  const { layoutOrmDiagram } = await import('/src/layout/ormLayout.js')
  const out = []
  const check = (label, ok, detail = '') => out.push([label, !!ok, ok ? '' : detail])
  const st = () => S.getState()
  const load = () => { st().loadModel(sampleText); st().setActiveDiagram('d_teaching') }
  const diag = (id = 'd_teaching') => st().diagrams.find(d => d.id === id)
  const ot = (name) => st().objectTypes.find(o => o.name === name)
  const occsOf = (elId, id) => (diag(id).occurrences ?? []).filter(o => o.schemaElementId === elId && !o.refModeOwnerOccId)
  const links = (id = 'd_teaching') => occurrenceRoleLinks(diag(id), st().facts, st().objectTypes)
  const shown = (id) => new Set(diag(id).occurrences.filter(o => !o.refModeOwnerOccId).map(o => o.schemaElementId))
  const move = (occId, x, y, id = 'd_teaching') => S.setState(s => ({ diagrams: s.diagrams.map(d => d.id !== id ? d : {
    ...d, occurrences: d.occurrences.map(o => o.id === occId ? { ...o, x, y } : o.refModeOwnerOccId === occId ? { ...o, x: o.x + x - d.occurrences.find(p => p.id === occId).x, y: o.y + y - d.occurrences.find(p => p.id === occId).y } : o) }) }))
  const factPlaying = (...names) => st().facts.find(f => !f.objectified && f.roles.length === names.length
    && names.every((n, i) => f.roles[i].objectTypeId === (ot(n)?.id ?? st().facts.find(x => x.objectifiedName === n)?.id)))

  const step = async (fn) => { try { await fn() } catch (e) { check('error', false, String(e.stack ?? e).split('\n').slice(0, 3).join(' | ')) } }
  // 6. copy/paste and cut/paste of a fact occurrence alone
  await step(async () => {
  load()
    const f = factPlaying('Student', 'Course') ?? st().facts.find(x => shown('d_teaching').has(x.id) && x.roles.length === 2)
    st().select(f.id, 'fact'); st().copySelection()
    const to = st().addDiagram('Paste'); st().setActiveDiagram(to); st().pasteClipboard()
    check('6. copy and paste of a fact type alone adds only it', diag(to).occurrences.map(o => o.schemaElementId).join() === f.id,
      diag(to).occurrences.map(o => o.schemaElementId).join())
    st().setActiveDiagram('d_teaching'); st().select(f.id, 'fact'); st().cutSelection()
    const left = shown('d_teaching')
    check('6. cut of a fact type takes only it off', !left.has(f.id) && f.roles.every(r => left.has(r.objectTypeId)))
    st().setActiveDiagram(to); st().pasteClipboard()
    check('6. pasting the cut fact type adds nothing else', diag(to).occurrences.length === 1)
  })
  // 7. copy/paste of a fact type and one of its two players
  await step(async () => {
  load()
    const f = st().facts.find(x => !x.objectified && x.roles.length === 2 && shown('d_teaching').has(x.id) && x.roles[0].objectTypeId !== x.roles[1].objectTypeId && ot(st().objectTypes.find(o => o.id === x.roles[0].objectTypeId)?.name))
    const p0 = f.roles[0].objectTypeId
    S.setState({ multiSelectedIds: [f.id, p0], selectedId: null }); st().copySelection()
    const to = st().addDiagram('Partial'); st().setActiveDiagram(to); st().pasteClipboard()
    const els = diag(to).occurrences.filter(o => !o.refModeOwnerOccId).map(o => o.schemaElementId).sort()
    check('7. a fact type and one player paste as just those two', els.join() === [f.id, p0].sort().join(), els.join())
    const fo = occsOf(f.id, to)[0]
    const L = links(to)
    if (!fo) check('7. the fact type is pasted', false, els.join())
    else check('7. the pasted player is connected, the other role is not', L.linkOf(fo, 0)?.schemaElementId === p0 && !L.linkOf(fo, 1))
  })
  // 8. role-player reassignment where the new player is absent on a diagram
  await step(async () => {
  load()
    const onTeaching = shown('d_teaching')
    const f = st().facts.find(x => !x.objectified && x.roles.length === 2 && onTeaching.has(x.id))
    const absent = st().objectTypes.find(o => o.schemaId === f.schemaId && o.kind === 'entity' && !onTeaching.has(o.id))
    const before = st().diagrams.map(d => occsOf(f.id, d.id).length).join()
    st().assignObjectTypeToRole(f.id, 0, absent.id)
    check('8. reassigning a role keeps every occurrence of its fact type', st().diagrams.map(d => occsOf(f.id, d.id).length).join() === before)
    check('8. the role is unconnected where the new player is absent', !links().linkOf(occsOf(f.id)[0], 0))
  })
  // 9. Add with players and Reveal player
  await step(async () => {
  load()
    const course = ot('Course')
    st().removeElementFromDiagram(course.id, 'd_teaching')
    const f = factPlaying('Course', 'CourseTitle') ?? st().facts.find(x => x.roles.some(r => r.objectTypeId === course.id) && shown('d_teaching').has(x.id))
    const fo = occsOf(f.id)[0], ri = f.roles.findIndex(r => r.objectTypeId === course.id)
    check('9. a removed player leaves its roles unconnected', !links().linkOf(fo, ri))
    const [added] = st().revealPlayers('d_teaching', fo.id, [ri], { place: placeRevealed })
    check('9. Reveal player connects the role to a new occurrence', added && links().linkOf(occsOf(f.id)[0], ri)?.id === added)
    const a = diag().occurrences.find(o => o.id === added)
    check('9. the revealed player is placed near the role', a && Math.hypot(a.x - fo.x, a.y - fo.y) < 400, a && `${Math.round(Math.hypot(a.x - fo.x, a.y - fo.y))} px away`)
    const g = st().facts.find(x => x.schemaId === f.schemaId && !x.objectified && x.roles.length === 2 && !shown('d_teaching').has(x.id)
      && x.roles.every(r => r.objectTypeId && !shown('d_teaching').has(r.objectTypeId)))
    if (g) {
      st().addWithPlayers(g.id, 'd_teaching', { place: placeRevealed, placeFact: placeOrmUnits })
      const go = diag().occurrences.find(o => o.schemaElementId === g.id)
      check('9. Add with players connects every role', go && g.roles.every((_, i) => links().linkOf(go, i)),
        `${g.id}: ${g.roles.map((_, i) => links().linkOf(go, i)?.schemaElementId ?? '-').join()}`)
    }
  })
  // 10. objectified fact types as role players
  await step(async () => {
  load()
    const f = st().facts.find(x => x.roles.some(r => st().facts.some(n => n.objectified && n.id === r.objectTypeId)) && shown('d_teaching').has(x.id))
    if (f) {
      const ri = f.roles.findIndex(r => st().facts.some(n => n.objectified && n.id === r.objectTypeId))
      const nid = f.roles[ri].objectTypeId
      const fo = occsOf(f.id)[0]
      check('10. a role played by an objectified fact type connects to its occurrence', links().linkOf(fo, ri)?.schemaElementId === nid)
      st().addExtraOccurrence(nid, 'd_teaching')
      const extra = occsOf(nid).at(-1)
      move(extra.id, fo.x + 30, fo.y + 120)
      check('10. a nearer occurrence of the objectified fact type takes the link', links().linkOf(occsOf(f.id)[0], ri)?.id === extra.id)
    } else check('10. the sample has a role played by an objectified fact type', false)
  })
  // 11. collapsed and expanded reference modes
  await step(async () => {
  load()
    const course = ot('Course')
    const { findRefMode } = await import('/src/utils/refMode.js')
    const rm = findRefMode(course, st().facts, st().objectTypes)
    const co = occsOf(course.id)[0]
    const hidden = diag().occurrences.find(o => o.schemaElementId === rm.factId && o.refModeOwnerOccId === co.id)
    check('11. a collapsed reference mode links by ownership', links().linkOf(hidden, 1 - rm.vtRoleIndex)?.id === co.id)
    st().addExtraOccurrence(rm.factId, 'd_teaching')
    const own = diag().occurrences.find(o => o.schemaElementId === rm.factId && !o.refModeOwnerOccId)
    move(own.id, co.x + 100, co.y)
    check('11. a reference mode fact type shown on its own takes no link from the collapsed entity', !links().linkOf(diag().occurrences.find(o => o.id === own.id), 1 - rm.vtRoleIndex))
    st().removeOccurrenceFromDiagram(own.id, 'd_teaching')
    st().expandRefMode(co.id, 'd_teaching')
    const ft = diag().occurrences.find(o => o.schemaElementId === rm.factId && o.refModeOwnerOccId === co.id)
    check('11. an expanded reference mode connects its fact type to the entity', ft && links().linkOf(ft, 1 - rm.vtRoleIndex)?.id === co.id)
  })
  // 12. constraints that select one of several fact occurrences
  await step(async () => {
  load()
    const co = (diag().constraintOccurrences ?? []).find(c => (c.roleOccurrenceRefs ?? []).length)
    if (co) {
      const before = JSON.stringify(co.roleOccurrenceRefs)
      const fid = st().constraints.find(c => c.id === co.schemaConstraintId)?.sequences?.flat().find(m => m.factId)?.factId
      if (fid) st().addExtraOccurrence(fid, 'd_teaching')
      const after = JSON.stringify(diag().constraintOccurrences.find(c => c.id === co.id).roleOccurrenceRefs)
      check('12. a constraint keeps the fact occurrence it selects when another is added', before === after, `${before} → ${after}`)
    } else {
      const c = (diag().constraintOccurrences ?? [])[0]
      const fid = st().constraints.find(x => x.id === c?.schemaConstraintId)?.sequences?.flat().find(m => m.factId)?.factId
      if (fid) st().addExtraOccurrence(fid, 'd_teaching')
      check('12. a constraint stays when its fact type gets a second occurrence', c && diag().constraintOccurrences.some(x => x.id === c.id))
    }
  })
  // 13. auto layout of a partial diagram
  await step(async () => {
  load()
    st().removeElementFromDiagram(ot('Course').id, 'd_teaching')
    st().removeElementFromDiagram(ot('Credits').id, 'd_teaching')
    const before = shown('d_teaching')
    st().applyDiagramLayout('d_teaching', layoutOrmDiagram(st(), 'd_teaching'))
    const after = shown('d_teaching')
    const added = [...after].filter(x => !before.has(x)), lost = [...before].filter(x => !after.has(x))
    check('13. auto layout of a partial diagram adds and drops no element', !added.length && !lost.length, `added ${added.join()} dropped ${lost.join()}`)
  })
  return out
}

// Runs in the page: export each ORM2 schema to NORMA and import it again;
// every visible occurrence and role connector comes back (within 2 px).
async function normaRoundTrip({ name, content, isOrm }) {
  const { useOrmStore: S } = await import('/src/store/ormStore.js')
  const { openModelFile } = await import('/src/import/openModelFile.js')
  const { importNorma } = await import('/src/import/norma.js')
  const { exportNorma, normaId } = await import('/src/export/norma.js')
  const { occurrenceRoleLinks } = await import('/src/diagram/roleLinks.js')
  const { diagramFontsReady } = await import('/src/diagram/diagramFont.js')
  await diagramFontsReady?.()
  const out = []
  const check = (label, ok, detail = '') => out.push([label, !!ok, ok ? '' : detail])
  openModelFile({ path: isOrm ? `${name}.orm` : `${name}.ffbm`, content: isOrm ? content : JSON.parse(content) })
  // A FreeFBM model gets a diagram with duplicate fact type and player
  // occurrences and an absent player: F twice, A twice, B not shown, laid out
  // so that the nearer F takes A's near occurrence and the other F's role is
  // left unconnected (NORMA's two-sided rule).
  if (!isOrm) {
    const st = S.getState()
    const f = st.facts.find(x => !x.objectified && x.roles.length === 2 && x.roles.every(r => st.objectTypes.some(o => o.id === r.objectTypeId && o.kind === 'entity'))
      && x.roles[0].objectTypeId !== x.roles[1].objectTypeId)
    if (f) {
      const id = st.addDiagram('Duplicates')
      st.addElementToDiagram(f.id, id, { withPlayers: false }); S.getState().addExtraOccurrence(f.id, id)
      S.getState().addElementToDiagram(f.roles[0].objectTypeId, id); S.getState().addExtraOccurrence(f.roles[0].objectTypeId, id)
      const at = { [f.id]: [[0, 0], [150, 0]], [f.roles[0].objectTypeId]: [[200, 120], [-450, 0]] }
      S.setState(s => ({ diagrams: s.diagrams.map(d => {
        if (d.id !== id) return d
        const seen = {}
        const pos = new Map()
        for (const o of d.occurrences) if (!o.refModeOwnerOccId && at[o.schemaElementId]) { const i = seen[o.schemaElementId] = (seen[o.schemaElementId] ?? -1) + 1; pos.set(o.id, at[o.schemaElementId][i]) }
        return { ...d, occurrences: d.occurrences.map(o => {
          const p = pos.get(o.id) ?? pos.get(o.refModeOwnerOccId)
          return p ? { ...o, x: p[0] + (pos.has(o.id) ? 0 : 80), y: p[1] } : o
        }) }
      }) }))
    }
  }
  const state = S.getState()
  // A NORMA file's import keeps exactly NORMA's object type and fact type shapes.
  if (isOrm) {
    const doc = new DOMParser().parseFromString(content.replace(/^﻿/, ''), 'application/xml')
    const kept = state.diagrams.reduce((n, d) => n + (d.occurrences ?? []).filter(o => o.normaShape).length, 0)
    const all = state.diagrams.reduce((n, d) => n + (d.occurrences ?? []).filter(o => !o.refModeOwnerOccId || o.normaShape).length, 0)
    check('14. the import adds no occurrence NORMA did not draw', all === kept, `${all - kept} occurrences without a NORMA shape`)
    const keptIds = new Set(state.diagrams.flatMap(d => (d.occurrences ?? []).map(o => o.normaShape?.id).filter(Boolean)))
    const lost = ['ObjectTypeShape', 'FactTypeShape'].flatMap(t => [...doc.getElementsByTagNameNS('*', t)])
      // a link fact type's shape becomes a shown link fact type, not an occurrence
      .filter(e => !keptIds.has(e.getAttribute('id')) && doc.querySelector(`[id="${[...e.children].find(c => c.localName === 'Subject')?.getAttribute('ref')}"]`)?.localName !== 'ImpliedFact')
      .map(e => { const ref = [...e.children].find(c => c.localName === 'Subject')?.getAttribute('ref'); const el = ref && doc.querySelector(`[id="${ref}"]`); return `${e.localName} of ${el?.localName} ${el?.getAttribute('Name') ?? el?.getAttribute('_Name') ?? ref}` })
    check('14. every NORMA object type and fact type shape is kept', !lost.length, lost.join('; '))
  }
  const schemas = (state.schemas?.length ? state.schemas : [{ id: null, name, profile: 'orm2' }]).filter(s => s.profile !== 'relational')
  for (const sch of schemas) {
    const { xml } = exportNorma(state, { schemaId: sch.id, name })
    const back = importNorma(xml).data
    const tuples = (st, ds, idOf) => {
      const t = []
      for (const d of ds) {
        if (d.mappingId) continue
        const L = occurrenceRoleLinks(d, st.facts, st.objectTypes)
        const expanded = new Set(d.expandedRefModeOccs ?? [])
        for (const o of d.occurrences ?? []) {
          if (o.refModeOwnerOccId && !expanded.has(o.refModeOwnerOccId)) continue
          const f = st.facts.find(x => x.id === o.schemaElementId)
          if (!f) continue
          f.roles.forEach((_, ri) => {
            const p = L.linkOf(o, ri)
            t.push({ d: d.name, f: idOf(f.id), fx: o.x, fy: o.y, ri, p: p ? idOf(p.schemaElementId) : null, px: p?.x, py: p?.y })
          })
        }
      }
      return t
    }
    const inS = (d) => !sch.id || (state.schemas?.length ?? 0) <= 1 || d.schemaId === sch.id
    const before = tuples(state, state.diagrams.filter(inS), normaId)
    const backState = { facts: back.schema.factTypes, objectTypes: back.schema.objectTypes }
    const after = tuples(backState, back.diagrams ?? [], (x) => x)
    const near = (a, b) => a.d === b.d && a.f === b.f && a.ri === b.ri && Math.abs(a.fx - b.fx) <= 2 && Math.abs(a.fy - b.fy) <= 2
    const missing = before.filter(a => !after.some(b => near(a, b)))
    const differ = before.filter(a => {
      const b = after.find(x => near(a, x))
      return b && (a.p !== b.p || (a.p && (Math.abs(a.px - b.px) > 2 || Math.abs(a.py - b.py) > 2)))
    })
    check(`14. ${sch.name}: every fact type occurrence comes back`, !missing.length, missing.length && `${missing.length} missing, e.g. ${JSON.stringify(missing[0])}`)
    check(`14. ${sch.name}: every role connector comes back (${before.length} roles, ${before.filter(a => !a.p).length} unconnected)`, !differ.length,
      differ.length && `${differ.length} differ, e.g. ${JSON.stringify(differ[0])} → ${JSON.stringify(after.find(x => near(differ[0], x)))}`)
  }
  return out
}
