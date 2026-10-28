// Golden tests for the verbalisation engine: verbalises every formula of the
// sample model (the whole schema plus the implicit constraints) and compares
// the result with tests/verbalisation/sample.en.txt; then does the same for
// the constructs tests/verbalisation/extras.mjs adds to the sample, against
// tests/verbalisation/extras.en.txt; and both again in the other languages
// (*.nl.txt, *.fr.txt, …).
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
import { frenchLibrary } from '../src/verbalisation/languages/french.js'
import { italianLibrary } from '../src/verbalisation/languages/italian.js'
import { spanishLibrary } from '../src/verbalisation/languages/spanish.js'
import { polishLibrary } from '../src/verbalisation/languages/polish.js'
import { compileLanguage } from '../src/verbalisation/rules.js'
import { extend, isExtra } from '../tests/verbalisation/extras.mjs'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')

// The rules as the app loads them (languages/index.js, which uses Vite's ?raw import).
const load = (file, lib) => compileLanguage(fs.readFileSync(path.join(root, 'src/verbalisation/languages', file), 'utf8'), lib)
const languages = {
  en: load('english.vr', englishLibrary), nl: load('dutch.vr', dutchLibrary), fr: load('french.vr', frenchLibrary),
  it: load('italian.vr', italianLibrary), es: load('spanish.vr', spanishLibrary), pl: load('polish.vr', polishLibrary),
}

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
const only = process.argv.find(a => a.startsWith('--lang='))?.slice(7)
for (const [file, blocks] of Object.entries(languages).filter(([id]) => !only || id === only).flatMap(([id, language]) => [
  [`sample.${id}.txt`, verbaliseAll(sample, language, () => true)],
  [`extras.${id}.txt`, verbaliseAll(extend(sample), language, isExtra, true)],
])) {
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
