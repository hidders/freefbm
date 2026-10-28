// The built-in languages: rule files compiled against their libraries.

import { compileLanguage } from '../rules.js'
import { englishLibrary } from './english.js'
import { dutchLibrary } from './dutch.js'
import englishRules from './english.vr?raw'
import dutchRules from './dutch.vr?raw'

export const english = compileLanguage(englishRules, englishLibrary)
export const dutch = compileLanguage(dutchRules, dutchLibrary)

// The built-in languages in menu order: { id, label, rules (source), file, library, language }.
export const LANGUAGES = [
  { id: 'en', label: 'English', file: 'english.vr', rules: englishRules, library: englishLibrary, language: english },
  { id: 'nl', label: 'Nederlands', file: 'dutch.vr', rules: dutchRules, library: dutchLibrary, language: dutch },
]

export { englishRules, englishLibrary, dutchRules, dutchLibrary }
