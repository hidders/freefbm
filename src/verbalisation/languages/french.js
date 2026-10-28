// The French library: the Romance library (romance.js) with French words and
// morphology, for the rules in french.vr.

import { romanceLibrary, makeContract, pluraliseName } from './romance.js'

const VOWEL = /^[aeiouyhàâäéèêëîïôöùûüœæ]/iu

const PREPOSITIONS = new Set(['à', 'de', 'dans', 'en', 'pour', 'par', 'sur', 'avec', 'chez', 'sans', 'sous', 'vers', 'entre', 'du', 'des', 'au', 'aux'])

// Plural of a word: -s, unchanged after s, x or z, -aux for -al and -ail
// (Journal → Journaux), -x after -au, -eu and -eau.
function pluralWord(w) {
  if (/[sxz]$/i.test(w)) return w
  if (/(au|eu|eau)$/i.test(w)) return `${w}x`
  if (/al$/i.test(w)) return w.replace(/al$/i, 'aux')
  return `${w}s`
}

const IRREGULAR = {
  est: 'sont', a: 'ont', peut: 'peuvent', doit: 'doivent', fait: 'font', va: 'vont', vaut: 'valent',
  suit: 'suivent', prend: 'prennent', dit: 'disent', voit: 'voient', sait: 'savent', veut: 'veulent',
  appartient: 'appartiennent', contient: 'contiennent', tient: 'tiennent', vient: 'viennent',
  obtient: 'obtiennent', détient: 'détiennent', devient: 'deviennent', comprend: 'comprennent',
}

// The plural of a verb in the third person singular of the present:
// enseigne → enseignent, finit → finissent; null when it is not a form the
// rules know.
export function pluralVerb(w) {
  const lower = w.toLowerCase()
  if (IRREGULAR[lower]) return IRREGULAR[lower]
  if (/e$/.test(lower)) return `${lower}nt`
  if (/it$/.test(lower)) return `${lower.slice(0, -1)}ssent`
  return null
}

// lequel, laquelle, lesquels, lesquelles after a preposition; à and de
// contract (auquel, duquel), and de is usually dont.
function relPrep(prep, g, plural) {
  const which = plural ? (g === 'f' ? 'lesquelles' : 'lesquels') : (g === 'f' ? 'laquelle' : 'lequel')
  if (prep === 'de') return 'dont'
  if (prep === 'à') return plural ? (g === 'f' ? 'auxquelles' : 'auxquels') : g === 'f' ? 'à laquelle' : 'auquel'
  if (['du', 'des', 'au', 'aux'].includes(prep)) return null
  return `${prep} ${which}`
}

export const frenchLibrary = romanceLibrary({
  id: 'fr',
  label: 'Français',
  and: 'et',
  each: 'chaque',
  one: (g) => (g === 'f' ? 'une' : 'un'),
  some: (g) => (g === 'f' ? 'une' : 'un'),
  none: (g) => (g === 'f' ? 'aucune' : 'aucun'),
  that: (g) => (g === 'f' ? 'cette' : 'ce'),
  reflexive: (g) => (g === 'f' ? 'elle-même' : 'lui-même'),
  suchThat: (g, plural) => (plural ? (g === 'f' ? 'telles que' : 'tels que') : (g === 'f' ? 'telle que' : 'tel que')),
  quant: { '≤': 'au plus', '≥': 'au moins', '=': 'exactement' },
  range: ['de', 'à'],
  negation: 'ne',
  negationAfter: 'pas',
  relSubj: 'qui',
  relObj: 'que',
  relPrep,
  prepositions: PREPOSITIONS,
  combination: ['combinaison de', 'combinaisons de'],
  isA: { verb: 'est', plural: 'sont des' },
  valueOps: { '≈': 'est', '≉': 'est différent de', '<': 'est inférieur à', '≤': 'est au plus', '>': 'est supérieur à', '≥': 'est au moins' },
  predicates: { startsWith: 'commence par', endsWith: 'se termine par', contains: 'contient', matches: "correspond à l'expression régulière" },
  closure: { linked: 'est relié à', plus: 'par une ou plusieurs étapes, chacune de', star: 'par zéro ou plusieurs étapes, chacune de', to: 'à' },
  directly: 'directement ou indirectement',
  orIs: 'ou est',
  ite: ['si', 'alors', 'sinon'],
  aggregates: { count: 'le nombre', sum: 'la somme', avg: 'la moyenne', min: 'la plus petite valeur', max: 'la plus grande valeur' },
  of: 'de',
  allOf: (g) => (g === 'f' ? 'de toutes les' : 'de tous les'),
  ofThe: () => 'des',
  overAll: 'sur toutes les',
  distinct: 'différents',
  operations: {
    add: '{0} plus {1}', sub: '{0} moins {1}', mul: '{0} fois {1}', div: '{0} divisé par {1}',
    idiv: 'le quotient entier de {0} par {1}', mod: 'le reste de {0} divisé par {1}',
    neg: 'moins {0}', abs: 'la valeur absolue de {0}',
    least: 'le plus petit de {0} et {1}', greatest: 'le plus grand de {0} et {1}',
    round: '{0} arrondi à {1} décimales', roundInt: "{0} arrondi à l'entier",
    floor: '{0} arrondi vers le bas', ceiling: '{0} arrondi vers le haut', truncate: '{0} tronqué',
    power: '{0} puissance {1}', sqrt: 'la racine carrée de {0}',
    concat: '{0} suivi de {1}', length: 'la longueur de {0}',
    substring: 'la partie de {0} de longueur {2} à partir de la position {1}',
    upper: '{0} en majuscules', lower: '{0} en minuscules', trim: '{0} sans espaces au début et à la fin',
    toText: '{0} en texte',
    year: "l'année de {0}", month: 'le mois de {0}', day: 'le jour du mois de {0}',
    hour: "l'heure de {0}", minute: 'la minute de {0}', second: 'la seconde de {0}',
    dayOfWeek: 'le jour de la semaine de {0}', yearsBetween: "le nombre d'années entières de {0} à {1}",
    makeDate: "la date de l'année {0}, du mois {1} et du jour {2}",
    dateOf: 'la date de {0}', timeOf: "l'heure du jour de {0}",
    totalMonths: '{0} en mois', totalDays: '{0} en jours', totalSeconds: '{0} en secondes',
  },
  operationFallback: (label) => `${label} de`,
  pluralWord,
  pluralVerb,
  contract: makeContract([
    ...['que', 'de', 'ne', 'le', 'la', 'se', 'jusque', 'lorsque', 'puisque'].map(word =>
      ({ word, next: VOWEL, to: `${word.slice(0, -1)}'`, glue: true })),
    { word: 'si', next: /^ils?$/i, to: "s'", glue: true },
    { word: 'ce', next: VOWEL, to: 'cet' },
    { word: 'de', nextWord: 'le', to: 'du' },
    { word: 'de', nextWord: 'les', to: 'des' },
    { word: 'à', nextWord: 'le', to: 'au' },
    { word: 'à', nextWord: 'les', to: 'aux' },
  ], { ':': ' :', ';': ' ;' }),
})

export const pluralise = (name) => pluraliseName(name, pluralWord, PREPOSITIONS)
