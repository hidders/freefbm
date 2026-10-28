// The built-in languages: rule files compiled against their libraries.

import { compileLanguage } from '../rules.js'
import { englishLibrary } from './english.js'
import englishRules from './english.vr?raw'

export const english = compileLanguage(englishRules, englishLibrary)
export { englishRules, englishLibrary }
