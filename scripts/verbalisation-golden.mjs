// Golden tests for the verbalisation engine: verbalises every formula of the
// sample model (the whole schema plus the implicit constraints) and compares
// the result with tests/verbalisation/sample.en.txt; then does the same for
// the constructs tests/verbalisation/extras.mjs adds to the sample, against
// tests/verbalisation/extras.en.txt; and both again in Dutch (*.nl.txt).
//
//   node scripts/verbalisation-golden.mjs            check, exit 1 on a difference
//   node scripts/verbalisation-golden.mjs --update   rewrite the expected files

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { formalise } from '../src/logic/constraintFormulas.js'
import { formulaToString } from '../src/logic/renderFormula.js'
import { verbalise } from '../src/verbalisation/engine.js'
import { englishLibrary } from '../src/verbalisation/languages/english.js'
import { dutchLibrary } from '../src/verbalisation/languages/dutch.js'
import { compileLanguage } from '../src/verbalisation/rules.js'
import { extend, isExtra } from '../tests/verbalisation/extras.mjs'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')

// The rules as the app loads them (languages/index.js, which uses Vite's ?raw import).
const load = (file, lib) => compileLanguage(fs.readFileSync(path.join(root, 'src/verbalisation/languages', file), 'utf8'), lib)
const languages = { en: load('english.vr', englishLibrary), nl: load('dutch.vr', dutchLibrary) }

const d = JSON.parse(fs.readFileSync(path.join(root, 'src/data/sample.ffbm'), 'utf8'))
const sample = {
  objectTypes: d.schema.objectTypes ?? [], facts: d.schema.factTypes ?? [],
  subtypes: d.schema.subtypes ?? [], constraints: d.schema.externalConstraints ?? [],
  diagrams: d.diagrams ?? [], activeDiagramId: d.activeDiagramId,
}

// The blocks for the entries whose key passes keep; notes (an entry without a
// formula, say a rule with an error) are listed when withNotes is set.
function verbaliseAll(state, language, keep, withNotes = false) {
  const { entries, implicit, ctx } = formalise(state, { wholeSchema: true })
  const all = [...entries.flat(), ...implicit.disjointness, ...implicit.participation, ...implicit.impliedLinks]
  const blocks = []
  for (const e of all) {
    if (!keep(e.key)) continue
    if (!e.formula) { if (e.note && withNotes) blocks.push(`# ${e.kind} · ${e.subject}\nNOTE: ${e.note}\n`); continue }
    let sentence
    try { sentence = verbalise(e.formula, ctx, language).text } catch (err) { sentence = `ERROR: ${err.message}` }
    blocks.push(`# ${e.kind}${e.subject ? ` · ${e.subject}` : ''}\n${formulaToString(e.formula, ctx)}\n${sentence}\n`)
  }
  return blocks
}

let failed = false
for (const [file, blocks] of [
  ['sample.en.txt', verbaliseAll(sample, languages.en, () => true)],
  ['extras.en.txt', verbaliseAll(extend(sample), languages.en, isExtra, true)],
  ['sample.nl.txt', verbaliseAll(sample, languages.nl, () => true)],
  ['extras.nl.txt', verbaliseAll(extend(sample), languages.nl, isExtra, true)],
]) {
  const expectedFile = path.join(root, 'tests/verbalisation', file)
  const actual = blocks.join('\n')
  if (process.argv.includes('--update')) {
    fs.writeFileSync(expectedFile, actual)
    console.log(`Wrote ${blocks.length} verbalisations to ${path.relative(root, expectedFile)}`)
    continue
  }
  const expected = fs.existsSync(expectedFile) ? fs.readFileSync(expectedFile, 'utf8') : ''
  if (expected === actual) {
    console.log(`All ${blocks.length} verbalisations in ${file} match.`)
  } else {
    const a = actual.split('\n'), e = expected.split('\n')
    const i = a.findIndex((line, k) => line !== e[k])
    console.error(`Verbalisations differ from ${path.relative(root, expectedFile)} at line ${i + 1}:`)
    console.error(`  expected: ${e[i] ?? '(end of file)'}`)
    console.error(`  actual:   ${a[i] ?? '(end of file)'}`)
    failed = true
  }
}
if (failed) {
  console.error('Run with --update to accept the new output.')
  process.exit(1)
}
