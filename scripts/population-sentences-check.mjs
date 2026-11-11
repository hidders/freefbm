// Prints the population sentences of every object type and fact type of a
// model (the sample by default):
//   node scripts/population-sentences-check.mjs [file.ffbm] [--lang nl]
import { createServer } from 'vite'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const li = args.indexOf('--lang')
const lang = li >= 0 ? args.splice(li, 2)[1] : 'en'
const file = args[0] ?? path.join(root, 'src/data/sample.ffbm')

globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} }
const server = await createServer({ root, logLevel: 'error', server: { middlewareMode: true }, appType: 'custom', optimizeDeps: { noDiscovery: true, include: [] } })
const load = (p) => server.ssrLoadModule(p)
const { useOrmStore } = await load('/src/store/ormStore.js')
const { scopeToSchema } = await load('/src/store/storeHelpers.js')
const { makeContext } = await load('/src/logic/constraintFormulas.js')
const { populationSentences } = await load('/src/verbalisation/population.js')
const { LANGUAGES } = await load('/src/verbalisation/languages/index.js')

useOrmStore.getState().loadModel(JSON.parse(fs.readFileSync(file, 'utf8')), null)
const s = scopeToSchema(useOrmStore.getState())
const ctx = makeContext(s)
const language = LANGUAGES.find(l => l.id === lang).language
for (const el of [...s.objectTypes, ...s.facts]) {
  const r = populationSentences(s, ctx, language, el.id, s.populationIssues ?? [])
  if (!r.rows.length && !r.error) continue
  console.log(`\n── ${el.name || el.objectifiedName || el.id}${r.identified ? ` (identifies ${ctx.typeName(r.identified)})` : ''}`)
  for (const k of r.keyLines) console.log(`   [${k.text}]`)
  for (const row of r.rows) console.log(`   ${row.text}${row.derived ? '  (derived)' : ''}${row.problems.length ? `  ⚠ ${row.problems.join('; ')}` : ''}`)
  if (r.error) console.log(`   error: ${r.error}`)
}
await server.close()
