// The Italian library: the Romance library (romance.js) with Italian words
// and morphology, for the rules in italian.vr.

import { romanceLibrary, makeContract, pluraliseName } from './romance.js'

const VOWEL = /^[aeiouàèéìòù]/iu
// The words that take lo, uno, gli: s + consonant, z, gn, ps, x, y, pn.
const IMPURE = /^(s[^aeiouàèéìòù]|z|gn|ps|pn|x|y)/iu

const PREPOSITIONS = new Set(['a', 'di', 'da', 'in', 'con', 'su', 'per', 'tra', 'fra', 'del', 'della', 'dei', 'al', 'alla', 'nel', 'nella', 'sul', 'sulla'])

// Plural of a word: -o → -i, -a → -e (-ca → -che, -ga → -ghe), -e → -i,
// -io → -i; words ending in a consonant or a stressed vowel do not change.
function pluralWord(w) {
  if (/[^aeiou]$/i.test(w) || /[àèéìòù]$/i.test(w)) return w
  if (/io$/i.test(w)) return w.slice(0, -1)
  if (/(c|g)a$/i.test(w)) return `${w.slice(0, -1)}he`
  if (/a$/i.test(w)) return `${w.slice(0, -1)}e`
  return `${w.slice(0, -1)}i`
}

const IRREGULAR = {
  'è': 'sono', ha: 'hanno', può: 'possono', deve: 'devono', fa: 'fanno', va: 'vanno', sa: 'sanno',
  vuole: 'vogliono', vale: 'valgono', tiene: 'tengono', viene: 'vengono', contiene: 'contengono',
  appartiene: 'appartengono', ottiene: 'ottengono', diventa: 'diventano', dà: 'danno', sta: 'stanno',
}

// The plural of a verb in the third person singular of the present:
// insegna → insegnano, segue → seguono, finisce → finiscono.
export function pluralVerb(w) {
  const lower = w.toLowerCase()
  if (IRREGULAR[lower]) return IRREGULAR[lower]
  if (/a$/.test(lower)) return `${lower}no`
  if (/e$/.test(lower)) return `${lower.slice(0, -1)}ono`
  return null
}

// "in cui", "di cui", "a cui".
const relPrep = (prep) => (['a', 'di', 'da', 'in', 'con', 'su', 'per', 'tra', 'fra'].includes(prep) ? `${prep} cui` : null)

export const italianLibrary = romanceLibrary({
  id: 'it',
  label: 'Italiano',
  and: 'e',
  each: 'ogni',
  one: (g) => (g === 'f' ? 'una' : 'un'),
  some: (g) => (g === 'f' ? 'una' : 'un'),
  none: (g) => (g === 'f' ? 'nessuna' : 'nessun'),
  same: (g) => (g === 'f' ? 'la stessa' : 'lo stesso'),
  that: (g) => (g === 'f' ? 'quella' : 'quel'),
  reflexive: (g) => (g === 'f' ? 'se stessa' : 'se stesso'),
  suchThat: (g, plural) => (plural ? 'tali che' : 'tale che'),
  quant: { '≤': 'al massimo', '≥': 'almeno', '=': 'esattamente', '>': 'più di', '<': 'meno di' },
  range: ['da', 'a'],
  negation: 'non',
  negationAfter: null,
  noneBeforeVerb: true,
  relSubj: 'che',
  relObj: 'che',
  relPrep,
  prepositions: PREPOSITIONS,
  combination: ['combinazione di', 'combinazioni di'],
  isA: { verb: 'è', plural: 'sono' },
  valueOps: { '≈': 'è', '≉': 'è diverso da', '<': 'è minore di', '≤': 'è al massimo', '>': 'è maggiore di', '≥': 'è almeno' },
  predicates: { startsWith: 'inizia con', endsWith: 'finisce con', contains: 'contiene', matches: "corrisponde all'espressione regolare" },
  closure: { linked: 'è collegato a', plus: 'tramite uno o più passi, ciascuno da', star: 'tramite zero o più passi, ciascuno da', to: 'a' },
  directly: 'direttamente o indirettamente',
  orIs: 'o è',
  ite: ['se', 'allora', 'altrimenti'],
  aggregates: { count: 'il numero', sum: 'la somma', avg: 'la media', min: 'il valore minimo', max: 'il valore massimo' },
  of: 'di',
  allOf: (g) => (g === 'f' ? 'di tutte le' : 'di tutti i'),
  ofThe: (g) => (g === 'f' ? 'delle' : 'dei'),
  overAll: 'su tutte le',
  distinct: 'diversi',
  operations: {
    add: '{0} più {1}', sub: '{0} meno {1}', mul: '{0} per {1}', div: '{0} diviso {1}',
    idiv: 'il quoziente intero di {0} diviso {1}', mod: 'il resto di {0} diviso {1}',
    neg: 'meno {0}', abs: 'il valore assoluto di {0}',
    least: 'il minore tra {0} e {1}', greatest: 'il maggiore tra {0} e {1}',
    round: '{0} arrotondato a {1} decimali', roundInt: "{0} arrotondato all'intero",
    floor: '{0} arrotondato per difetto', ceiling: '{0} arrotondato per eccesso', truncate: '{0} troncato',
    power: '{0} elevato a {1}', sqrt: 'la radice quadrata di {0}',
    concat: '{0} seguito da {1}', length: 'la lunghezza di {0}',
    substring: 'la parte di {0} di lunghezza {2} dalla posizione {1}',
    upper: '{0} in maiuscolo', lower: '{0} in minuscolo', trim: '{0} senza spazi iniziali e finali',
    toText: '{0} come testo',
    year: "l'anno di {0}", month: 'il mese di {0}', day: 'il giorno del mese di {0}',
    hour: "l'ora di {0}", minute: 'il minuto di {0}', second: 'il secondo di {0}',
    dayOfWeek: 'il giorno della settimana di {0}', yearsBetween: 'il numero di anni interi da {0} a {1}',
    makeDate: 'la data con anno {0}, mese {1} e giorno {2}',
    dateOf: 'la data di {0}', timeOf: "l'ora del giorno di {0}",
    totalMonths: '{0} in mesi', totalDays: '{0} in giorni', totalSeconds: '{0} in secondi',
  },
  operationFallback: (label) => `${label} di`,
  pluralWord,
  pluralVerb,
  contract: makeContract([
    { word: 'e', next: /^[eè]/iu, to: 'ed' },
    { word: 'un', next: IMPURE, to: 'uno' },
    { word: 'una', next: VOWEL, to: "un'", glue: true },
    { word: 'nessun', next: IMPURE, to: 'nessuno' },
    { word: 'nessuna', next: VOWEL, to: "nessun'", glue: true },
    { word: 'quel', next: VOWEL, to: "quell'", glue: true },
    { word: 'quel', next: IMPURE, to: 'quello' },
    { word: 'quella', next: VOWEL, to: "quell'", glue: true },
    { word: 'dei', next: VOWEL, to: 'degli' },
    { word: 'dei', next: IMPURE, to: 'degli' },
    { word: 'i', next: VOWEL, to: 'gli' },
    { word: 'i', next: IMPURE, to: 'gli' },
    { word: 'il', next: VOWEL, to: "l'", glue: true },
    { word: 'il', next: IMPURE, to: 'lo' },
    { word: 'la', next: VOWEL, to: "l'", glue: true },
  ]),
})

export const pluralise = (name) => pluraliseName(name, pluralWord, PREPOSITIONS)
