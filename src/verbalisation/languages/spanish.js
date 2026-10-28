// The Spanish library: the Romance library (romance.js) with Spanish words
// and morphology, for the rules in spanish.vr.

import { romanceLibrary, makeContract, pluraliseName } from './romance.js'

const PREPOSITIONS = new Set(['a', 'de', 'en', 'con', 'por', 'para', 'sobre', 'entre', 'desde', 'hasta', 'sin', 'del', 'al'])

const UNACCENT = { á: 'a', é: 'e', í: 'i', ó: 'o', ú: 'u' }

// Plural of a word: -s after an unstressed vowel, -es after a consonant
// (Inscripción → Inscripciones, the accent dropped), -z → -ces; words in
// -s or -x after an unstressed syllable do not change.
function pluralWord(w) {
  if (/[aeiouáéó]$/i.test(w)) return `${w}s`
  if (/[íú]$/i.test(w)) return `${w}es`
  if (/z$/i.test(w)) return `${w.slice(0, -1)}ces`
  if (/[^áéíóú][^aeiouáéíóú]*(es|is|us|x)$/i.test(w) && w.length > 4) return w
  if (/[áéíóú][nsl]$/i.test(w)) return w.replace(/[áéíóú]([nsl])$/i, (m, c) => UNACCENT[m[0].toLowerCase()] + c) + 'es'
  return `${w}es`
}

const IRREGULAR = { es: 'son', está: 'están', ha: 'han', va: 'van', da: 'dan', hay: 'hay' }

// The plural of a verb in the third person singular of the present:
// imparte → imparten, coordina → coordinan.
export function pluralVerb(w) {
  const lower = w.toLowerCase()
  if (IRREGULAR[lower]) return IRREGULAR[lower]
  if (/[ae]$/.test(lower)) return `${lower}n`
  return null
}

// "en el que", "en la que", "en los que", "en las que".
function relPrep(prep, g, plural) {
  if (['del', 'al'].includes(prep)) return null
  const art = plural ? (g === 'f' ? 'las' : 'los') : (g === 'f' ? 'la' : 'el')
  return `${prep} ${art} que`
}

export const spanishLibrary = romanceLibrary({
  id: 'es',
  label: 'Español',
  and: 'y',
  each: 'cada',
  one: (g) => (g === 'f' ? 'una' : 'un'),
  some: (g) => (g === 'f' ? 'una' : 'un'),
  none: (g) => (g === 'f' ? 'ninguna' : 'ningún'),
  that: (g) => (g === 'f' ? 'esa' : 'ese'),
  reflexive: (g) => (g === 'f' ? 'sí misma' : 'sí mismo'),
  suchThat: (g, plural) => (plural ? 'tales que' : 'tal que'),
  quant: { '≤': 'como máximo', '≥': 'al menos', '=': 'exactamente' },
  range: ['de', 'a'],
  negation: 'no',
  negationAfter: null,
  relSubj: 'que',
  relObj: 'que',
  relPrep,
  prepositions: PREPOSITIONS,
  combination: ['combinación de', 'combinaciones de'],
  isA: { verb: 'es', plural: 'son' },
  valueOps: { '≈': 'es', '≉': 'es distinto de', '<': 'es menor que', '≤': 'es como máximo', '>': 'es mayor que', '≥': 'es al menos' },
  predicates: { startsWith: 'empieza por', endsWith: 'termina en', contains: 'contiene', matches: 'coincide con la expresión regular' },
  closure: { linked: 'está unido a', plus: 'por uno o más pasos, cada uno de', star: 'por cero o más pasos, cada uno de', to: 'a' },
  directly: 'directa o indirectamente',
  orIs: 'o es',
  ite: ['si', 'entonces', 'si no'],
  aggregates: { count: 'el número', sum: 'la suma', avg: 'la media', min: 'el valor mínimo', max: 'el valor máximo' },
  of: 'de',
  allOf: (g) => (g === 'f' ? 'de todas las' : 'de todos los'),
  ofThe: (g) => (g === 'f' ? 'de las' : 'de los'),
  overAll: 'sobre todas las',
  distinct: 'distintos',
  operations: {
    add: '{0} más {1}', sub: '{0} menos {1}', mul: '{0} por {1}', div: '{0} dividido por {1}',
    idiv: 'el cociente entero de {0} entre {1}', mod: 'el resto de {0} dividido por {1}',
    neg: 'menos {0}', abs: 'el valor absoluto de {0}',
    least: 'el menor de {0} y {1}', greatest: 'el mayor de {0} y {1}',
    round: '{0} redondeado a {1} decimales', roundInt: '{0} redondeado al entero',
    floor: '{0} redondeado hacia abajo', ceiling: '{0} redondeado hacia arriba', truncate: '{0} truncado',
    power: '{0} elevado a {1}', sqrt: 'la raíz cuadrada de {0}',
    concat: '{0} seguido de {1}', length: 'la longitud de {0}',
    substring: 'la parte de {0} de longitud {2} desde la posición {1}',
    upper: '{0} en mayúsculas', lower: '{0} en minúsculas', trim: '{0} sin espacios al principio y al final',
    toText: '{0} como texto',
    year: 'el año de {0}', month: 'el mes de {0}', day: 'el día del mes de {0}',
    hour: 'la hora de {0}', minute: 'el minuto de {0}', second: 'el segundo de {0}',
    dayOfWeek: 'el día de la semana de {0}', yearsBetween: 'el número de años completos de {0} a {1}',
    makeDate: 'la fecha con año {0}, mes {1} y día {2}',
    dateOf: 'la fecha de {0}', timeOf: 'la hora del día de {0}',
    totalMonths: '{0} en meses', totalDays: '{0} en días', totalSeconds: '{0} en segundos',
  },
  operationFallback: (label) => `${label} de`,
  pluralWord,
  pluralVerb,
  contract: makeContract([
    { word: 'y', next: /^h?i(?![aeiouáéíóú])/iu, to: 'e' },
    { word: 'o', next: /^h?o/iu, to: 'u' },
    { word: 'de', nextWord: 'el', to: 'del' },
    { word: 'a', nextWord: 'el', to: 'al' },
  ]),
})

export const pluralise = (name) => pluraliseName(name, pluralWord, PREPOSITIONS)
