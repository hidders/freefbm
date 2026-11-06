// Harness for the ORM2 auto layout (src/layout/ormLayout.js).
//
//   node scripts/orm-layout-check.mjs [--shots DIR] [--only NAME] [--why] [case …]
//
// A case is a .ffbm or NORMA .orm file (each ORM2 diagram is laid out) or a
// PostgreSQL .sql script (its ORM2 schema is guessed first, as Guess ORM2 does).
// For each diagram it prints the layout score (src/layout/layoutScore.js) as it
// was, after our Auto layout, and with ELK's layered placement of the same core
// graph (the development-only benchmark, scripts/layout/elkPlace.js). With
// --shots, it saves a screenshot of each layout; with --why, it lists what
// overlaps, crosses or runs through a box after Auto layout.
import { createServer } from 'vite'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'

// Playwright is not a dependency of the project: use the one installed globally.
const { chromium } = createRequire(import.meta.url)('playwright')

const args = process.argv.slice(2)
let shots = null, only = null, why = false
const cases = []
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--shots') shots = args[++i]
  else if (args[i] === '--only') only = args[++i]
  else if (args[i] === '--why') why = true
  else cases.push(args[i])
}
if (!cases.length) {
  console.error('usage: node scripts/orm-layout-check.mjs [--shots DIR] [--only NAME] [--why] file.ffbm|file.orm|file.sql …')
  process.exit(1)
}
if (shots) fs.mkdirSync(shots, { recursive: true })

// elkjs is pre-bundled up front, else Vite finds it on first import and reloads the page.
const server = await createServer({ server: { port: 5199, strictPort: false }, logLevel: 'error', optimizeDeps: { include: ['elkjs/lib/elk.bundled.js'], entries: ['index.html', 'scripts/layout/elkPlace.js'] } })
await server.listen()
const url = server.resolvedUrls.local[0]
const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1800, height: 1100 }, deviceScaleFactor: 1 })
page.on('pageerror', e => console.error('page error:', e.message))
await page.goto(url)
await page.waitForSelector('.canvas-bg', { timeout: 60000 })

const fmt = (s) => s ? `${String(s.overlaps).padStart(4)} ${String(s.crossings).padStart(5)} ${String(s.throughBoxes).padStart(5)} ${String(s.length).padStart(7)} ${String(s.width).padStart(6)}×${String(s.height).padEnd(6)}${s.constraints ? ` ${String(s.cCrossings).padStart(5)} ${String(s.cThrough).padStart(5)} ${String(s.cLength).padStart(6)}` : ''}` : '   –'
console.log(`${'diagram'.padEnd(36)} ${'layout'.padEnd(8)} overl cross thru   length  size          c-cross c-thru c-len`)

for (const file of cases) {
  const content = fs.readFileSync(file, 'utf8')
  const kind = file.endsWith('.sql') ? 'sql' : (content.trimStart().replace(/^﻿/, '').startsWith('<') ? 'orm' : 'ffbm')
  const ids = await page.evaluate(async ({ content, kind, name }) => {
    const { useOrmStore } = await import('/src/store/ormStore.js')
    const s = () => useOrmStore.getState()
    if (kind === 'ffbm') s().loadModel(JSON.parse(content), null)
    else if (kind === 'orm') {
      const { openModelFile } = await import('/src/import/openModelFile.js')
      await openModelFile({ path: `${name}.orm`, content })
    } else {
      s().loadModel({ version: 2, schema: { objectTypes: [], factTypes: [], subtypes: [], externalConstraints: [] }, diagrams: [] }, null)
      const { schemaId } = s().importPostgresDdl(content, name)
      s().guessOrmFromRelational(schemaId)
    }
    const { isErdDiagram } = await import('/src/components/ErdView.jsx')
    const { mappingOfDiagram } = await import('/src/store/storeHelpers.js')
    return s().diagrams.filter(d => !mappingOfDiagram(s(), d) && !isErdDiagram({ ...s(), activeDiagramId: d.id }, d) && (d.occurrences?.length ?? 0) > 0)
      .map(d => ({ id: d.id, name: d.name, n: d.occurrences.length }))
  }, { content, kind, name: path.basename(file).replace(/\.\w+$/, '') })

  for (const d of ids) {
    const label = `${path.basename(file)}: ${d.name}`.slice(0, 36)
    if (only && !label.includes(only)) continue
    const shot = async (tag) => {
      if (!shots) return
      await page.evaluate(async (id) => {
        const { useOrmStore } = await import('/src/store/ormStore.js')
        const s = useOrmStore.getState()
        s.setActiveDiagram(id)
        const svg = document.querySelector('.canvas-bg')?.closest('svg')
        const r = svg?.getBoundingClientRect()
        s.fitToContent(r?.width || 1200, r?.height || 700)
      }, d.id)
      await page.waitForTimeout(300)
      const el = await page.$('.canvas-bg')
      const svg = await el.evaluateHandle(e => e.closest('svg'))
      const safe = `${path.basename(file)}-${d.name}`.replace(/[^\w.-]+/g, '_')
      await svg.asElement().screenshot({ path: path.join(shots, `${safe}-${tag}.png`) })
    }
    const res = await page.evaluate(async (id) => {
      const { useOrmStore } = await import('/src/store/ormStore.js')
      const { layoutScore } = await import('/src/layout/layoutScore.js')
      const { prepareLayout, placeCore, finishLayout } = await import('/src/layout/ormLayout.js')
      const { elkPlace } = await import('/scripts/layout/elkPlace.js')
      const s = () => useOrmStore.getState()
      s().setActiveDiagram(id)
      const original = s().diagrams.find(x => x.id === id)
      const before = layoutScore(s(), id)
      const t0 = performance.now()
      const plan = prepareLayout(s(), id)
      const ours = finishLayout(plan, placeCore(plan))
      const ms = Math.round(performance.now() - t0)
      const elkPlan = prepareLayout(s(), id)
      const elk = finishLayout(elkPlan, await elkPlace(elkPlan))
      return { before, ours, elk, ms, original, nodes: plan.nodes.length }
    }, d.id)
    const apply = async (r, details = false) => page.evaluate(async ({ id, r, details }) => {
      const { useOrmStore } = await import('/src/store/ormStore.js')
      const { layoutScore } = await import('/src/layout/layoutScore.js')
      useOrmStore.getState().applyDiagramLayout(id, r)
      return layoutScore(useOrmStore.getState(), id, { details })
    }, { id: d.id, r, details })
    await shot('0-before')
    const elkScore = await apply(res.elk)
    await shot('2-elk')
    const ourScore = await apply(res.ours, why)
    await shot('1-auto')
    console.log(`${label.padEnd(36)} ${'before'.padEnd(8)} ${fmt(res.before)}`)
    console.log(`${''.padEnd(36)} ${'auto'.padEnd(8)} ${fmt(ourScore)}  (${res.nodes} core nodes, ${res.ms} ms)`)
    console.log(`${''.padEnd(36)} ${'elk'.padEnd(8)} ${fmt(elkScore)}`)
    if (why) for (const w of ourScore.why) console.log(`    ${w}`)
  }
}

await browser.close()
await server.close()
