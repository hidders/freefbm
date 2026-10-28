// The built-in languages: rule files compiled against their libraries.

import { compileLanguage } from '../rules.js'
import { englishLibrary } from './english.js'
import { dutchLibrary } from './dutch.js'
import { frenchLibrary } from './french.js'
import { italianLibrary } from './italian.js'
import { spanishLibrary } from './spanish.js'
import { polishLibrary } from './polish.js'
import englishRules from './english.vr?raw'
import dutchRules from './dutch.vr?raw'
import frenchRules from './french.vr?raw'
import italianRules from './italian.vr?raw'
import spanishRules from './spanish.vr?raw'
import polishRules from './polish.vr?raw'

const entry = (id, label, file, rules, library) => ({ id, label, file, rules, library, language: compileLanguage(rules, library) })

// The built-in languages in menu order: { id, label, rules (source), file, library, language }.
export const LANGUAGES = [
  entry('en', 'English', 'english.vr', englishRules, englishLibrary),
  entry('nl', 'Nederlands', 'dutch.vr', dutchRules, dutchLibrary),
  entry('fr', 'Français', 'french.vr', frenchRules, frenchLibrary),
  entry('it', 'Italiano', 'italian.vr', italianRules, italianLibrary),
  entry('es', 'Español', 'spanish.vr', spanishRules, spanishLibrary),
  entry('pl', 'Polski', 'polish.vr', polishRules, polishLibrary),
]

export const english = LANGUAGES[0].language
export const dutch = LANGUAGES[1].language
