// Shared state between the main window and the verbalisation workbench.
//
// User rules: the rules applied in the workbench are kept in localStorage
// per language (both windows share it); without them the built-in rule file
// applies. useVerbalisation(id) gives the language to verbalise with, and
// useLanguageChoice() the language the workbench shows.
//
// Messages: in Electron through the main process (workbench:msg), in a plain
// browser through a BroadcastChannel. The workbench sends hello when it opens
// and bye when it closes, and rules when it applies new rules; the main
// window answers hello with the model and sends it again when it changes.

import { useEffect, useMemo, useState } from 'react'
import { compileLanguage } from './rules.js'
import { LANGUAGES } from './languages/index.js'
import { BASE_LANGUAGE, swapLanguage } from '../store/viewLanguage.js'

export { LANGUAGES }
export const languageInfo = (id) => LANGUAGES.find(l => l.id === id) ?? LANGUAGES[0]

const rulesKey = (id) => `freefbm.verbalisation.rules.${id}`

export function readUserRules(id) {
  try { return localStorage.getItem(rulesKey(id)) } catch { return null }
}

const listeners = new Set()
const notify = () => listeners.forEach(l => l())

// Stores a language's rules (null: back to the built-in ones) and tells the windows.
export function writeUserRules(id, text) {
  try {
    if (text == null || text === languageInfo(id).rules) localStorage.removeItem(rulesKey(id))
    else localStorage.setItem(rulesKey(id), text)
  } catch { /* storage unavailable */ }
  notify()
  channel().post({ type: 'rules', lang: id })
}

// Calls update when the stored rules may have changed, in this window or another.
function useRulesChanged(update) {
  useEffect(() => {
    const onStorage = (e) => { if (e.key?.startsWith('freefbm.verbalisation.rules.')) update() }
    listeners.add(update)
    window.addEventListener('storage', onStorage)
    const off = channel().on(m => { if (m?.type === 'rules') update() })
    return () => { listeners.delete(update); window.removeEventListener('storage', onStorage); off() }
  }, [update])
}

// The language to verbalise with: { language, custom, error }. User rules
// that no longer compile fall back to the built-in ones, with the error.
export function useVerbalisation(id) {
  const info = languageInfo(id)
  const [version, setVersion] = useState(0)
  const [update] = useState(() => () => setVersion(v => v + 1))
  useRulesChanged(update)
  const text = useMemo(() => readUserRules(info.id), [info.id, version])
  return useMemo(() => {
    if (!text) return { language: info.language, custom: false }
    try { return { language: compileLanguage(text, info.library), custom: true } }
    catch (err) { return { language: info.language, custom: true, error: err.message } }
  }, [text, info])
}

const CHOICE_KEY = 'freefbm.verbalisation.language'

// The chosen verbalisation language, remembered across sessions.
export function useLanguageChoice() {
  const read = () => { try { return languageInfo(localStorage.getItem(CHOICE_KEY)).id } catch { return 'en' } }
  const [id, setId] = useState(read)
  const choose = (v) => {
    setId(v)
    try { localStorage.setItem(CHOICE_KEY, v) } catch { /* storage unavailable */ }
  }
  return [id, choose]
}

let shared = null
export function channel() {
  if (shared) return shared
  const api = typeof window !== 'undefined' ? window.electronAPI?.workbench : null
  if (api) {
    shared = { post: (m) => api.post(m), on: (cb) => api.on(cb) }
  } else if (typeof BroadcastChannel !== 'undefined') {
    const bc = new BroadcastChannel('freefbm-workbench')
    shared = {
      post: (m) => bc.postMessage(m),
      on: (cb) => { const h = (e) => cb(e.data); bc.addEventListener('message', h); return () => bc.removeEventListener('message', h) },
    }
  } else {
    shared = { post: () => {}, on: () => () => {} }
  }
  return shared
}

export function openWorkbench() {
  const api = window.electronAPI?.workbench
  if (api) api.open()
  else window.open(`${window.location.pathname}#workbench`, 'freefbm-workbench', 'width=1280,height=820')
}

// The parts of the model the workbench verbalises, in the base language
// whatever the main window shows.
export const modelSnapshot = (s) => JSON.parse(JSON.stringify({
  ...swapLanguage(s, s.viewLanguage ?? BASE_LANGUAGE, BASE_LANGUAGE), subtypes: s.subtypes, constraints: s.constraints,
  diagrams: s.diagrams, activeDiagramId: s.activeDiagramId,
}))
