// Shared state between the main window and the verbalisation workbench.
//
// User rules: the workbench's applied English rules are kept in localStorage
// (both windows share it); without them the built-in english.vr applies.
// useEnglish() gives the language to verbalise with.
//
// Messages: in Electron through the main process (workbench:msg), in a plain
// browser through a BroadcastChannel. The workbench sends hello when it opens
// and bye when it closes, and rules when it applies new rules; the main
// window answers hello with the model and sends it again when it changes.

import { useEffect, useMemo, useState } from 'react'
import { compileLanguage } from './rules.js'
import { english, englishRules, englishLibrary } from './languages/index.js'

const RULES_KEY = 'freefbm.verbalisation.rules.en'

export function readUserRules() {
  try { return localStorage.getItem(RULES_KEY) } catch { return null }
}

const listeners = new Set()
const notify = () => listeners.forEach(l => l())

// Stores the rules (null: back to the built-in ones) and tells the windows.
export function writeUserRules(text) {
  try {
    if (text == null || text === englishRules) localStorage.removeItem(RULES_KEY)
    else localStorage.setItem(RULES_KEY, text)
  } catch { /* storage unavailable */ }
  notify()
  channel().post({ type: 'rules' })
}

// The English language to use: { language, custom, error }. User rules that
// no longer compile fall back to the built-in ones, with the error.
export function useEnglish() {
  const [text, setText] = useState(readUserRules)
  useEffect(() => {
    const update = () => setText(readUserRules())
    const onStorage = (e) => { if (e.key === RULES_KEY) update() }
    listeners.add(update)
    window.addEventListener('storage', onStorage)
    const off = channel().on(m => { if (m?.type === 'rules') update() })
    return () => { listeners.delete(update); window.removeEventListener('storage', onStorage); off() }
  }, [])
  return useMemo(() => {
    if (!text) return { language: english, custom: false }
    try { return { language: compileLanguage(text, englishLibrary), custom: true } }
    catch (err) { return { language: english, custom: true, error: err.message } }
  }, [text])
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

// The parts of the model the workbench verbalises.
export const modelSnapshot = (s) => JSON.parse(JSON.stringify({
  objectTypes: s.objectTypes, facts: s.facts, subtypes: s.subtypes, constraints: s.constraints,
  diagrams: s.diagrams, activeDiagramId: s.activeDiagramId,
}))
