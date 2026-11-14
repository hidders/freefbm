// Checks the NORMA .orm export (src/export/norma.js; docs/norma-export.md, Tests).
//
//   node scripts/norma-export-check.mjs --norma DIR [--out DIR] [--list N] file.ffbm|file.orm …
//
// --norma is a copy of NORMA's sources, at least its .xsd files (the
// repository github.com/ormsolutions/NORMA; `--fetch DIR` downloads the
// schemas and sample models into DIR through the GitHub API with `gh`).
//
// For a FreeFBM model (.ffbm) it exports every ORM2 schema and checks
//   1. the file against NORMA's schemas (xmllint),
//   2. its references (unique, well-formed GUIDs; every ref names an element;
//      every role in its player's PlayedRoles; every shape's subject exists),
//   3. export → import: importing the file gives the same model, in what the
//      export covers so far (object types, fact types, readings, internal
//      uniqueness and mandatory roles, preferred identifiers, subtype links,
//      occurrences within a pixel).
// For a NORMA file (.orm) it imports, exports and checks 1 and 2, and
//   4. compares the export with the original: per kind of element how many
//      there are in each and how many keep their id, and for shapes of the
//      same element how far centres and sizes differ.
// --out keeps the exported files. Exit code 1 when a check fails.
//
// Runs FreeFBM's code in a browser page served by Vite, as the other check
// scripts do. Playwright is not a dependency of the project: it is taken
// from NODE_PATH or a global install, and uses its own Chromium or, when that
// is missing, the installed Google Chrome.
import { createServer } from 'vite'
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const args = process.argv.slice(2)
let normaDir = null, outDir = null, list = 5, fetchDir = null
const files = []
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--norma') normaDir = args[++i]
  else if (args[i] === '--out') outDir = args[++i]
  else if (args[i] === '--list') list = Number(args[++i])
  else if (args[i] === '--fetch') fetchDir = args[++i]
  else files.push(args[i])
}

// ── --fetch: NORMA's schemas and sample models through the GitHub API ─────
if (fetchDir) {
  const gh = (...a) => execFileSync('gh', ['api', ...a], { maxBuffer: 64 << 20 })
  const tree = JSON.parse(gh('repos/ormsolutions/NORMA/git/trees/main?recursive=1'))
  const want = tree.tree.filter(e => e.type === 'blob' && /\.(xsd|orm)$|^LICENSE|^README\.md$|CPL/.test(e.path))
  for (const e of want) {
    const dest = path.join(fetchDir, e.path)
    if (fs.existsSync(dest)) continue
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    fs.writeFileSync(dest, gh('-H', 'Accept: application/vnd.github.raw', `repos/ormsolutions/NORMA/contents/${e.path.split('/').map(encodeURIComponent).join('/')}?ref=main`))
  }
  console.log(`fetched ${want.length} files into ${fetchDir}`)
  if (!files.length) process.exit(0)
  normaDir ??= fetchDir
}
if (!files.length || !normaDir) {
  console.error('usage: node scripts/norma-export-check.mjs --norma DIR [--out DIR] [--list N] file.ffbm|file.orm …\n       node scripts/norma-export-check.mjs --fetch DIR')
  process.exit(1)
}

// ── NORMA's schemas, joined into one for xmllint ──────────────────────────
const xsdFiles = []
const walk = (d) => { for (const f of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, f.name); if (f.isDirectory()) walk(p); else if (f.name.endsWith('.xsd')) xsdFiles.push(p) } }
walk(normaDir)
const NEEDED = ['ORM2Core.xsd', 'ORM2Diagram.xsd', 'ORM2Root.xsd', 'DiagramDisplay.xsd', 'CustomProperties.xsd']
const imports = NEEDED.map(n => xsdFiles.find(f => path.basename(f) === n)).filter(Boolean).map(f => {
  const ns = /targetNamespace="([^"]+)"/.exec(fs.readFileSync(f, 'utf8'))?.[1]
  return ns && `<xs:import namespace="${ns}" schemaLocation="${path.resolve(f)}"/>`
}).filter(Boolean)
if (imports.length < 3) { console.error(`NORMA's schemas (${NEEDED.slice(0, 3).join(', ')}) not found under ${normaDir}`); process.exit(1) }
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'norma-export-'))
// NORMA's shape grouping extension (group colours) has no schema in NORMA's
// sources: a stub lets its group type and colours through.
const ormCore = xsdFiles.find(f => path.basename(f) === 'ORM2Core.xsd')
const diagramXsd = xsdFiles.find(f => path.basename(f) === 'ORM2Diagram.xsd')
fs.writeFileSync(path.join(tmp, 'shapeGroup.xsd'), `<?xml version="1.0"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:orm="http://schemas.neumont.edu/ORM/2006-04/ORMCore"
  targetNamespace="http://www.ormsolutions.com/NORMA/2009-01/ShapeGrouping" elementFormDefault="qualified">
  <xs:import namespace="http://schemas.neumont.edu/ORM/2006-04/ORMCore" schemaLocation="${path.resolve(ormCore)}"/>
  <xs:import namespace="http://schemas.neumont.edu/ORM/2006-04/ORMDiagram" schemaLocation="${path.resolve(diagramXsd)}"/>
  <xs:element name="ORMShapeColorGroupType" substitutionGroup="orm:GroupType">
    <xs:complexType><xs:complexContent><xs:extension base="orm:GroupTypeType">
      <xs:sequence><xs:any namespace="##other" processContents="lax" minOccurs="0" maxOccurs="unbounded"/></xs:sequence>
    </xs:extension></xs:complexContent></xs:complexType>
  </xs:element>
</xs:schema>
`)
imports.push(`<xs:import namespace="http://www.ormsolutions.com/NORMA/2009-01/ShapeGrouping" schemaLocation="${path.join(tmp, 'shapeGroup.xsd')}"/>`)
const schemaFile = path.join(tmp, 'norma.xsd')
fs.writeFileSync(schemaFile, `<?xml version="1.0"?>\n<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema">\n${imports.join('\n')}\n</xs:schema>\n`)
function validate(xmlFile) {
  try { execFileSync('xmllint', ['--noout', '--schema', schemaFile, xmlFile], { stdio: 'pipe' }); return [] }
  catch (e) { return String(e.stderr).split('\n').filter(l => l && !/fails to validate$/.test(l)).map(l => l.replace(xmlFile + ':', 'line ')) }
}

// ── the page ──────────────────────────────────────────────────────────────
const require = createRequire(path.join(process.cwd(), 'noop.js'))
let playwright
try { playwright = require('playwright') }
catch {
  const g = execFileSync('npm', ['root', '-g']).toString().trim()
  playwright = createRequire(path.join(g, 'noop.js'))('playwright')
}
const server = await createServer({ server: { port: 5197, strictPort: false }, logLevel: 'error' })
await server.listen()
const url = server.resolvedUrls.local[0]
let browser
try { browser = await playwright.chromium.launch() }
catch { browser = await playwright.chromium.launch({ channel: 'chrome' }) }
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } })
page.on('pageerror', e => console.error('page error:', e.message))
await page.goto(url)
await page.waitForSelector('.canvas-bg, .welcome, #root > *', { timeout: 60000 })

// Runs in the page. Opens the file, exports each ORM2 schema, checks
// references, and runs the round trip or the comparison.
async function runInPage({ name, content, isOrm }) {
  const { useOrmStore } = await import('/src/store/ormStore.js')
  const { openModelFile } = await import('/src/import/openModelFile.js')
  const { importNorma } = await import('/src/import/norma.js')
  const { exportNorma, normaId } = await import('/src/export/norma.js')
  const { diagramFontsReady } = await import('/src/diagram/diagramFont.js')
  await diagramFontsReady?.()
  openModelFile({ path: isOrm ? `${name}.orm` : `${name}.ffbm`, content: isOrm ? content : JSON.parse(content) })
  const state = useOrmStore.getState()
  const schemas = (state.schemas?.length ? state.schemas : [{ id: null, name, profile: 'orm2' }]).filter(s => s.profile !== 'relational')
  const results = []
  for (const sch of schemas) {
    const { xml, report } = exportNorma(state, { schemaId: sch.id, name: schemas.length > 1 ? sch.name : name })
    const doc = new DOMParser().parseFromString(xml, 'application/xml')
    const refProblems = checkRefs(doc)
    const r = { schema: sch.name, xml, report, refProblems }
    if (isOrm) r.comparison = compareOrm(new DOMParser().parseFromString(content.replace(/^﻿/, ''), 'application/xml'), doc)
    // export → import, also for an imported NORMA file (its FreeFBM model)
    r.roundTrip = roundTrip(state, sch.id, importNorma(xml).data)
    results.push(r)
  }
  return results

  function checkRefs(doc) {
    const out = []
    const ids = new Map()
    for (const e of doc.getElementsByTagName('*')) {
      const id = e.getAttribute('id')
      if (id == null) continue
      if (!/^_[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/i.test(id)) out.push(`id ${id} is not a GUID`)
      if (ids.has(id)) out.push(`id ${id} is used twice (${ids.get(id).localName}, ${e.localName})`)
      ids.set(id, e)
    }
    for (const e of doc.getElementsByTagName('*')) {
      const ref = e.getAttribute('ref')
      if (ref != null && !ids.has(ref)) out.push(`${e.parentElement?.localName}/${e.localName} refers to missing ${ref}`)
    }
    // a path walks roles (and supertype meta roles), never role proxies:
    // NORMA refuses to load the file otherwise ("Role player must be of type Role")
    for (const pr of doc.getElementsByTagNameNS('*', 'PathedRole')) {
      const target = ids.get(pr.getAttribute('ref'))
      if (pr.getAttribute('id') && target && !['Role', 'SupertypeMetaRole'].includes(target.localName)) out.push(`a pathed role walks a ${target.localName} (${pr.getAttribute('ref')})`)
    }
    // every role is in its player's PlayedRoles
    for (const fr of doc.getElementsByTagNameNS('*', 'FactRoles')) for (const role of fr.children) {
      const player = [...role.children].find(c => c.localName === 'RolePlayer')?.getAttribute('ref')
      if (!player) continue
      const pl = ids.get(player)
      const played = [...(pl?.children ?? [])].find(c => c.localName === 'PlayedRoles')
      if (![...(played?.children ?? [])].some(c => c.getAttribute('ref') === role.getAttribute('id'))) out.push(`role ${role.getAttribute('id')} is not in the PlayedRoles of ${pl?.getAttribute('Name') ?? player}`)
    }
    return out
  }

  // The original model against the re-imported one, by the ids the export
  // gives (an element keeps its NORMA GUID).
  function roundTrip(st, schemaId, data) {
    const diffs = []
    const inS = (x) => !schemaId || (st.schemas?.length ?? 0) <= 1 || x.schemaId === schemaId
    const back = data.schema
    const otB = new Map(back.objectTypes.map(o => [o.id, o]))
    const fB = new Map(back.factTypes.map(f => [f.id, f]))
    const nid = (id) => normaId(id)
    const objectified = new Set(st.facts.filter(f => f.objectified).map(f => f.id))
    for (const ot of st.objectTypes.filter(inS)) {
      const b = otB.get(nid(ot.id))
      if (!b) { diffs.push(`object type ${ot.name} is missing`); continue }
      if (b.name !== ot.name) diffs.push(`object type ${ot.name} is called ${b.name}`)
      if (b.kind !== ot.kind) diffs.push(`object type ${ot.name} is ${b.kind}`)
      if (!!b.isIndependent !== !!ot.isIndependent) diffs.push(`object type ${ot.name}: independent ${!!b.isIndependent}`)
      const a = ot.datatypeAssignment
      if (a?.profileId === 'norma' && b.datatypeAssignment?.datatypeId !== a.datatypeId) diffs.push(`object type ${ot.name}: data type ${b.datatypeAssignment?.datatypeId}`)
    }
    const key = (rs) => [...rs].sort((x, y) => x - y).join(',')
    const extImplied = new Map()
    for (const c of (st.constraints ?? []).filter(inS)) {
      if (c.constraintType !== 'uniqueness' || !c.isPreferredIdentifier || !c.targetObjectTypeId) continue
      for (const m of c.sequences?.[0] ?? []) {
        const f = m.kind === 'role' && st.facts.find(x => x.id === m.factId)
        if (f && f.roles.length === 2 && f.roles[1 - m.roleIndex].objectTypeId === c.targetObjectTypeId) extImplied.set(f.id, new Set([...(extImplied.get(f.id) ?? []), 1 - m.roleIndex]))
      }
    }
    const readings = (f) => new Set([
      ...(f.readingParts ? [`${f.roles.map((_, i) => i)}:${f.readingParts.map(p => p.trim()).join('|')}`] : []),
      ...(f.alternativeReadings ?? []).map(r => `${r.roleOrder}:${r.parts.map(p => p.trim()).join('|')}`)])
    for (const f of st.facts.filter(inS)) {
      const b = fB.get(nid(f.id))
      const what = `fact type ${f.id}`
      if (!b) { diffs.push(`${what} is missing`); continue }
      if (b.roles.length !== f.roles.length) { diffs.push(`${what} has ${b.roles.length} roles`); continue }
      if (!!b.objectified !== !!f.objectified) diffs.push(`${what}: objectified ${!!b.objectified}`)
      if (f.objectified && (b.objectifiedName ?? '') !== (f.objectifiedName ?? '')) diffs.push(`${what}: objectified as ${b.objectifiedName}`)
      f.roles.forEach((r, i) => {
        const p = nid(r.objectTypeId)
        if ((b.roles[i].objectTypeId ?? null) !== p) diffs.push(`${what}: role ${i + 1} is played by ${b.roles[i].objectTypeId}`)
        if ((b.roles[i].roleName ?? '') !== (r.roleName ?? '')) diffs.push(`${what}: role ${i + 1} is named ${b.roles[i].roleName}`)
      })
      const ra = readings(f), rb = readings(b)
      for (const x of ra) if (!rb.has(x)) diffs.push(`${what}: reading ${x} is missing`)
      for (const x of rb) if (!ra.has(x)) diffs.push(`${what}: reading ${x} was added`)
      const ua = new Set((f.uniqueness ?? []).map(u => key(u.roles))), ub = new Set((b.uniqueness ?? []).map(u => key(u.roles)))
      // the export adds what preferred identifiers imply
      for (const pu of f.preferredUniqueness ?? []) f.roles.forEach((_, ri) => { if (!pu.includes(ri)) ua.add(String(ri)) })
      for (const ri of extImplied.get(f.id) ?? []) ua.add(String(ri))
      for (const x of ua) if (!ub.has(x)) diffs.push(`${what}: uniqueness over roles ${x} is missing`)
      for (const x of ub) if (!ua.has(x)) diffs.push(`${what}: uniqueness over roles ${x} was added`)
      const pa = new Set((f.preferredUniqueness ?? []).map(key)), pb = new Set((b.preferredUniqueness ?? []).map(key))
      for (const x of pa) if (!pb.has(x)) diffs.push(`${what}: preferred identifier over roles ${x} is missing`)
      const implied = new Set((f.preferredUniqueness ?? []).flatMap(pu => f.roles.map((_, ri) => ri).filter(ri => !pu.includes(ri))))
      for (const ri of extImplied.get(f.id) ?? []) implied.add(ri)
      f.roles.forEach((r, i) => {
        const want = !!r.mandatory || implied.has(i)
        if (!!b.roles[i].mandatory !== want) diffs.push(`${what}: role ${i + 1} mandatory ${!!b.roles[i].mandatory}`)
      })
    }
    // ranges
    const rk = (rs) => JSON.stringify((rs ?? []).map(r => ({ ...r, value: r.value ?? undefined })))
    // count ranges: "at most u" is 1..u in NORMA
    const ck = (rs) => rk((rs ?? []).map(r => r.type === 'upper' ? { type: 'range', lower: '1', upper: r.upper } : r))
    for (const ot of st.objectTypes.filter(inS)) {
      const b = otB.get(nid(ot.id))
      if (!b) continue
      if (ot.kind === 'value' && rk(ot.valueRange) !== rk(b.valueRange)) diffs.push(`object type ${ot.name}: value range ${rk(b.valueRange)}`)
      if (ck(ot.cardinalityRange) !== ck(b.cardinalityRange)) diffs.push(`object type ${ot.name}: cardinality ${rk(b.cardinalityRange)}`)
    }
    for (const f of st.facts.filter(inS)) {
      const b = fB.get(nid(f.id))
      if (!b) continue
      f.roles.forEach((r, i) => { if (r.valueRange?.length && rk(r.valueRange) !== rk(b.roles[i]?.valueRange)) diffs.push(`fact type ${f.id}: role ${i + 1} value range ${rk(b.roles[i]?.valueRange)}`) })
      const ifs = (x) => (x.internalFrequency ?? []).map(q => `${key(q.roles)}:${ck(q.range)}${q.deontic ? 'd' : ''}`).sort().join(' ')
      if (ifs(f) !== ifs(b)) diffs.push(`fact type ${f.id}: internal frequency ${ifs(b)}`)
    }
    // external constraints
    const mem = (m) => m.kind === 'subtype' ? `st:${nid(m.subtypeId)}` : `${/_il_/.test(m.factId) ? nid(m.factId.split('_il_')[0]) + '_il_' + m.factId.split('_il_')[1] : nid(m.factId)}/${m.roleIndex}`
    const memB = (m) => m.kind === 'subtype' ? `st:${m.subtypeId}` : `${m.factId}/${m.roleIndex}`
    const cB = new Map((back.externalConstraints ?? []).map(c => [c.id, c]))
    for (const c of (st.constraints ?? []).filter(inS)) {
      const b = cB.get(nid(c.id))
      const what = `constraint ${c.name || c.id} (${c.constraintType})`
      if (!b) { diffs.push(`${what} is missing`); continue }
      if (b.constraintType !== c.constraintType) diffs.push(`${what} came back as ${b.constraintType}`)
      const sa = JSON.stringify(c.sequences.map(sq => sq.map(mem))), sb = JSON.stringify(b.sequences.map(sq => sq.map(memB)))
      if (sa !== sb) diffs.push(`${what}: sequences ${sb} instead of ${sa}`)
      if (!!c.deontic !== !!b.deontic) diffs.push(`${what}: deontic ${!!b.deontic}`)
      if (c.constraintType === 'ring' && [...c.ringTypes].sort().join() !== [...(b.ringTypes ?? [])].sort().join()) diffs.push(`${what}: ring ${b.ringTypes}`)
      if (c.constraintType === 'frequency' && ck(c.frequency) !== ck(b.frequency)) diffs.push(`${what}: frequency ${rk(b.frequency)}`)
      if (c.constraintType === 'valueComparison' && c.operator !== b.operator) diffs.push(`${what}: operator ${b.operator}`)
      if (c.constraintType === 'uniqueness' && !!c.isPreferredIdentifier !== !!b.isPreferredIdentifier) diffs.push(`${what}: preferred identifier ${!!b.isPreferredIdentifier}`)
    }
    // derivation (as informal rules), definitions, custom properties
    for (const x of [...st.objectTypes.filter(inS), ...st.facts.filter(inS)]) {
      const b = otB.get(nid(x.id)) ?? fB.get(nid(x.id))
      if (!b) continue
      const isSub = st.subtypes.some(s => s.subId === x.id)
      if ((x.roles || isSub) && !!x.derivation !== !!b.derivation) diffs.push(`${x.name ?? x.id}: derived ${!!b.derivation}`)
      if ((x.definition ?? '') !== (b.definition ?? '')) diffs.push(`${x.name ?? x.id}: definition “${b.definition ?? ''}”`)
      for (const [k, v] of Object.entries(x.properties ?? {})) if (v !== '' && v != null && String(b.properties?.[nid(k) ] ?? b.properties?.[normaId(k, 'property-definition')] ?? '') !== String(v)) diffs.push(`${x.name ?? x.id}: property ${k} is ${b.properties?.[normaId(k, 'property-definition')]}`)
    }
    // groups by name, with their number of members
    for (const g of st.groups ?? []) {
      const b = (back.groups ?? []).find(x => x.name === g.name)
      if (!b) diffs.push(`group ${g.name} is missing`)
      else if (Object.keys(g.colors ?? {}).sort().join() !== Object.keys(b.colors ?? {}).sort().join()) diffs.push(`group ${g.name}: colours ${Object.keys(b.colors ?? {})}`)
    }
    const stB = new Set(back.subtypes.map(s => `${s.subId}<${s.superId}`))
    for (const s of st.subtypes.filter(inS)) if (!stB.has(`${nid(s.subId)}<${nid(s.superId)}`)) diffs.push(`subtype link ${s.id} is missing`)
    // occurrences: each one (but collapsed reference modes) at the same place
    let occs = 0, moved = 0
    const worst = []
    for (const d of st.diagrams.filter(inS)) {
      const db = data.diagrams?.find(x => x.name === d.name && !x._used)
      if (!db) { diffs.push(`diagram ${d.name} is missing`); continue }
      db._used = true
      const expanded = new Set(d.expandedRefModeOccs ?? [])
      // notes come back with their text; FreeFBM's own notes stay out
      const texts = (ns) => (ns ?? []).filter(n => !n.importNote && !/^FreeFBM:/.test(n.text ?? '')).map(n => (n.text ?? '').trim()).sort().join(' | ')
      if (texts(d.notes) !== texts(db.notes)) diffs.push(`diagram ${d.name}: notes “${texts(db.notes)}” instead of “${texts(d.notes)}”`)
      for (const o of d.occurrences) {
        if (o.refModeOwnerOccId && !expanded.has(o.refModeOwnerOccId)) continue
        const el = st.objectTypes.find(x => x.id === o.schemaElementId) ?? st.facts.find(x => x.id === o.schemaElementId)
        if (!el) continue
        const cands = db.occurrences.filter(x => x.schemaElementId === nid(o.schemaElementId) && !x.refModeOwnerOccId === !o.refModeOwnerOccId)
        const best = cands.map(x => ({ x, d: Math.hypot(x.x - o.x, x.y - o.y) })).sort((p, q) => p.d - q.d)[0]
        occs++
        if (!best) { diffs.push(`diagram ${d.name}: ${el.name ?? el.id} is not drawn`); continue }
        if (expanded.has(o.id) !== (db.expandedRefModeOccs ?? []).includes(best.x.id)) diffs.push(`diagram ${d.name}: ${el.name ?? el.id} reference mode ${expanded.has(o.id) ? 'collapsed' : 'expanded'}`)
        if (best.d > 1.01) { moved++; worst.push({ what: `${d.name}: ${el.name ?? el.id}`, d: best.d }) }
        // moved labels come back within 6 px: the importer keeps a label that
        // reaches up to 6 px into its shape beside it, at no gap (normaLabels.js)
        const near = (a, b) => !a || (!a.dx && !a.dy && !b) || (b && Math.abs(a.dx - b.dx) <= 6 && Math.abs(a.dy - b.dy) <= 6)
        const lab = (k, a, b) => { if (!near(a, b)) diffs.push(`diagram ${d.name}: ${el.name ?? el.id} ${k} at ${b ? `${b.dx},${b.dy}` : 'default'} instead of ${a.dx},${a.dy}`) }
        if (el.roles) {
          const ra = o.readingAbove ?? el.readingAbove
          lab('reading', ra ? (o.readingOffsetAbove ?? el.readingOffsetAbove) : (o.readingOffsetBelow ?? el.readingOffsetBelow), ra ? best.x.readingOffsetAbove : best.x.readingOffsetBelow)
          el.roles.forEach((r, ri) => {
            if (r.roleName) lab(`role name ${ri + 1}`, o.roleNameOffsets?.[ri], best.x.roleNameOffsets?.[ri])
            if (r.valueRange?.length) lab(`value range ${ri + 1}`, o.valueRangeOffsets?.[ri], best.x.valueRangeOffsets?.[ri])
          })
          if (el.objectified) lab('name', o.nameOffset, best.x.nameOffset)
          if ((o.roleNamesShown === false) !== (best.x.roleNamesShown === false)) diffs.push(`diagram ${d.name}: ${el.id} role names ${best.x.roleNamesShown === false ? 'hidden' : 'shown'}`)
        } else if (el.kind === 'value' && el.valueRange?.length) lab('value range', o.valueRangeOffset ?? el.valueRangeOffset, best.x.valueRangeOffset)
        if (el.roles) {
          const ro = (o.roleOrder ?? el.roleOrder ?? []).join(), rb = (best.x.roleOrder ?? []).join()
          const ident = el.roles.map((_, i) => i).join()
          if ((ro || ident) !== (rb || ident)) diffs.push(`diagram ${d.name}: ${el.id} shows its roles in order ${rb || ident}`)
          if ((o.orientation ?? el.orientation ?? 'horizontal') !== (best.x.orientation ?? 'horizontal')) diffs.push(`diagram ${d.name}: ${el.id} is ${best.x.orientation ?? 'horizontal'}`)
        }
      }
    }
    worst.sort((p, q) => q.d - p.d)
    if (moved) diffs.push(`${moved} of ${occs} occurrences moved by more than a pixel, most ${worst.slice(0, 3).map(w => `${w.what} ${w.d.toFixed(1)} px`).join(', ')}`)
    // derivation rules that come back as formal rules (not only informal ones)
    const rules = { orig: 0, back: 0 }
    for (const x of [...st.facts.filter(inS), ...st.objectTypes.filter(inS)]) {
      if (!x.derivation || !x.derivationRule) continue
      rules.orig++
      if ((fB.get(nid(x.id)) ?? otB.get(nid(x.id)))?.derivationRule) rules.back++
    }
    return { diffs, occs, rules }
  }

  // The original NORMA file against the export.
  function compareOrm(a, b) {
    const KINDS = ['EntityType', 'ValueType', 'ObjectifiedType', 'Fact', 'SubtypeFact', 'ImpliedFact', 'ReadingOrder', 'Reading',
      'UniquenessConstraint', 'MandatoryConstraint', 'ObjectTypeShape', 'FactTypeShape', 'ReadingShape', 'ModelNote', 'ExternalConstraintShape']
    const defs = (doc, k) => [...doc.getElementsByTagNameNS('*', k)].filter(e => e.getAttribute('id') && !e.getAttribute('ref')
      && !(k.endsWith('Constraint') && e.getAttribute('IsImplied') === 'true'))
    const rows = KINDS.map(k => {
      const A = defs(a, k), B = defs(b, k)
      const idsB = new Set(B.map(e => e.getAttribute('id').toUpperCase()))
      return { kind: k, original: A.length, exported: B.length, sameId: A.filter(e => idsB.has(e.getAttribute('id').toUpperCase())).length }
    }).filter(r => r.original || r.exported)
    // shapes of the same subject, in order of appearance per diagram
    const shapes = (doc) => {
      const out = new Map()
      for (const d of doc.getElementsByTagNameNS('*', 'ORMDiagram')) {
        const shapesEl = [...d.children].find(c => c.localName === 'Shapes')
        for (const s of shapesEl?.children ?? []) {
          if (!/^(ObjectType|FactType)Shape$/.test(s.localName)) continue
          const subj = [...s.children].find(c => c.localName === 'Subject')?.getAttribute('ref')?.toUpperCase()
          const b = (s.getAttribute('AbsoluteBounds') ?? '').split(',').map(Number)
          const k = `${d.getAttribute('Name')}|${s.localName}|${subj}`
          out.set(k, [...(out.get(k) ?? []), { x: b[0], y: b[1], w: b[2], h: b[3] }])
        }
      }
      return out
    }
    const sa = shapes(a), sb = shapes(b)
    const geo = { ObjectTypeShape: [], FactTypeShape: [] }
    for (const [k, list] of sa) {
      const other = sb.get(k) ?? []
      list.forEach((r, i) => {
        const o = other[i]
        if (!o) return
        const kind = k.split('|')[1]
        const px = 200
        geo[kind].push({ label: k, centre: Math.hypot((o.x + o.w / 2) - (r.x + r.w / 2), (o.y + o.h / 2) - (r.y + r.h / 2)) * px,
          dw: (o.w - r.w) * px, dh: (o.h - r.h) * px })
      })
    }
    const summary = Object.fromEntries(Object.entries(geo).map(([k, v]) => [k, {
      n: v.length, centre: v.length ? v.reduce((s, x) => s + x.centre, 0) / v.length : 0,
      dw: v.length ? v.reduce((s, x) => s + Math.abs(x.dw), 0) / v.length : 0,
      dh: v.length ? v.reduce((s, x) => s + Math.abs(x.dh), 0) / v.length : 0,
      worst: v.sort((p, q) => q.centre - p.centre).slice(0, 10),
    }]))
    return { rows, geometry: summary }
  }
}

// ── run ───────────────────────────────────────────────────────────────────
if (outDir) fs.mkdirSync(outDir, { recursive: true })
let failed = 0
for (const file of files) {
  const name = path.basename(file).replace(/\.(ffbm|orm2?|json)$/i, '')
  const isOrm = /\.orm$/i.test(file)
  const content = fs.readFileSync(file, 'utf8')
  console.log(`\n== ${file}`)
  let results
  try { results = await page.evaluate(runInPage, { name, content, isOrm }) }
  catch (e) { console.log(`   FAILED to run: ${e.message.split('\n')[0]}`); failed++; continue }
  await page.reload(); await page.waitForSelector('.canvas-bg, .welcome, #root > *', { timeout: 60000 })
  for (const r of results) {
    const label = results.length > 1 ? `  [${r.schema}]` : ''
    const out = path.join(outDir ?? tmp, `${name}${results.length > 1 ? '.' + r.schema.replace(/[^\w-]+/g, '_') : ''}.export.orm`)
    fs.writeFileSync(out, r.xml)
    const xsd = validate(out)
    const fail = (what, items) => {
      if (!items.length) { console.log(`   ✓ ${what}`); return }
      failed++
      console.log(`   ✗ ${what}: ${items.length}`)
      for (const x of items.slice(0, list)) console.log(`       ${x}`)
      if (items.length > list) console.log(`       … ${items.length - list} more`)
    }
    if (label) console.log(label)
    fail('schema validation (xmllint)', xsd)
    fail('references', r.refProblems)
    if (r.roundTrip) fail(`export → import (${r.roundTrip.occs} occurrences)`, r.roundTrip.diffs)
    if (r.roundTrip?.rules?.orig) console.log(`   · derivation rules: ${r.roundTrip.rules.back} of ${r.roundTrip.rules.orig} come back as formal rules (the others as informal ones)`)
    if (r.comparison) {
      console.log('   import → export, compared with the original (definitions, kept ids):')
      for (const row of r.comparison.rows) console.log(`       ${row.kind.padEnd(22)} ${String(row.original).padStart(5)} → ${String(row.exported).padStart(5)}   same id ${row.sameId}`)
      for (const [k, g] of Object.entries(r.comparison.geometry)) {
        if (!g.n) continue
        console.log(`       ${k}: ${g.n} paired, mean centre offset ${g.centre.toFixed(1)} px, mean |Δw| ${g.dw.toFixed(1)} px, |Δh| ${g.dh.toFixed(1)} px`)
        for (const w of g.worst.slice(0, list)) if (w.centre > 1) console.log(`         ${w.label.split('|')[0]} ${w.label.split('|')[2]}: centre ${w.centre.toFixed(1)} px, Δw ${w.dw.toFixed(1)}, Δh ${w.dh.toFixed(1)}`)
      }
    }
    for (const x of r.report) console.log(`   ${x.level === 'warn' ? '!' : '·'} ${x.text}`)
    if (outDir) console.log(`   → ${out}`)
  }
}
await browser.close()
await server.close()
fs.rmSync(tmp, { recursive: true, force: true })
console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed')
process.exit(failed ? 1 : 0)
