// Golden tests for the verbalisation engine: verbalises every formula of the
// sample model (the whole schema plus the implicit constraints) and compares
// the result with tests/verbalisation/sample.en.txt.
//
//   node scripts/verbalisation-golden.mjs            check, exit 1 on a difference
//   node scripts/verbalisation-golden.mjs --update   rewrite the expected file

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { formalise } from '../src/logic/constraintFormulas.js'
import { formulaToString } from '../src/logic/renderFormula.js'
import { verbalise } from '../src/verbalisation/engine.js'
import { english } from '../src/verbalisation/languages/english.js'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const expectedFile = path.join(root, 'tests/verbalisation/sample.en.txt')

const d = JSON.parse(fs.readFileSync(path.join(root, 'src/data/sample.ffbm'), 'utf8'))
const state = {
  objectTypes: d.schema.objectTypes ?? [], facts: d.schema.factTypes ?? [],
  subtypes: d.schema.subtypes ?? [], constraints: d.schema.externalConstraints ?? [],
  diagrams: d.diagrams ?? [], activeDiagramId: d.activeDiagramId,
}
const { entries, implicit, ctx } = formalise(state, { wholeSchema: true })
const all = [...entries.flat(), ...implicit.disjointness, ...implicit.participation, ...implicit.impliedLinks]

const blocks = []
for (const e of all) {
  if (!e.formula) continue
  let sentence
  try { sentence = verbalise(e.formula, ctx, english).text } catch (err) { sentence = `ERROR: ${err.message}` }
  blocks.push(`# ${e.kind}${e.subject ? ` · ${e.subject}` : ''}\n${formulaToString(e.formula, ctx)}\n${sentence}\n`)
}
const actual = blocks.join('\n')

if (process.argv.includes('--update')) {
  fs.writeFileSync(expectedFile, actual)
  console.log(`Wrote ${blocks.length} verbalisations to ${path.relative(root, expectedFile)}`)
} else {
  const expected = fs.existsSync(expectedFile) ? fs.readFileSync(expectedFile, 'utf8') : ''
  if (expected === actual) {
    console.log(`All ${blocks.length} verbalisations match.`)
  } else {
    const a = actual.split('\n'), e = expected.split('\n')
    const i = a.findIndex((line, k) => line !== e[k])
    console.error(`Verbalisations differ from ${path.relative(root, expectedFile)} at line ${i + 1}:`)
    console.error(`  expected: ${e[i] ?? '(end of file)'}`)
    console.error(`  actual:   ${a[i] ?? '(end of file)'}`)
    console.error('Run with --update to accept the new output.')
    process.exit(1)
  }
}
