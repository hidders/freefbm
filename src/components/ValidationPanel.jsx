import React from 'react'
import { useOrmStore, useOrmStoreIgnoring } from '../store/ormStore'
import { VALIDATION_CATEGORIES } from '../utils/validation.js'
import { hasTextSelection } from '../utils/textPanel.js'
import { activeSchemaIdOf, factTypeLabel } from '../store/storeHelpers'
import { allImportNotes, elementKindOf, importNoteElementLabel, IMPORT_NOTE_SEVERITY } from '../utils/importNotes.js'
import { activeRelationalFace } from '../relational/face'
import { relationalView, rmObjectOf } from '../relational/relationalView'

const FONT   = "'Segoe UI', Helvetica, Arial, sans-serif"

const SEV_COLOUR = { error: '#dc2626', warning: '#d97706' }
const SEV_ICON   = { error: '✕', warning: '!' }


// The issues the Problems tab lists: those of the active schema (or of every
// schema when All schemas is on), leaving out elements no diagram shows.
export function visibleIssues(store) {
  const diagrams = store.diagrams || []
  const allSchemas = !!store.validationAllSchemas
  const isElementOrphaned = (e) => {
    if (e.elementKind === 'mappingRule') return false
    if (e.elementKind === 'subtype') {
      const st = (store.subtypes || []).find(s => s.id === e.elementId)
      if (!st) return false
      return !diagrams.some(d =>
        d.occurrences?.some(o => o.schemaElementId === st.subId) &&
        d.occurrences?.some(o => o.schemaElementId === st.superId))
    }
    // Check constraintOccurrences for constraint elements
    const isConstraint = (store.constraints || []).some(c => c.id === e.elementId)
    if (isConstraint) {
      return !diagrams.some(d => d.constraintOccurrences?.some(co => co.schemaConstraintId === e.elementId))
    }
    return !diagrams.some(d => d.occurrences?.some(o => o.schemaElementId === e.elementId))
  }
  // With several schemas the panel lists the active schema's issues, or all
  // of them (each then names its schema) when 'All schemas' is on.
  const schemas = store.schemas || []
  const multiSchema = schemas.length > 1
  const activeSchemaId = activeSchemaIdOf(store)
  const schemaOfElement = new Map()
  if (multiSchema) for (const k of ['objectTypes', 'facts', 'subtypes', 'constraints'])
    for (const x of (store[k] || [])) schemaOfElement.set(x.id, x.schemaId)
  // A mapping rule's issue belongs to both schemas of its mapping.
  // (Its message names its mapping, which says which schemas.)
  const schemaNameOf = (e) => (e.schemaIds ? null : schemas.find(x => x.id === schemaOfElement.get(e.elementId))?.name)
  const inScope = (e) => !multiSchema || allSchemas
    || (e.schemaIds ? e.schemaIds.includes(activeSchemaId)
      : !schemaOfElement.has(e.elementId) || schemaOfElement.get(e.elementId) === activeSchemaId)
  const errors = (store.validationErrors || []).filter(e => !isElementOrphaned(e) && inScope(e))
  const errorCount = errors.length
  const byCategory = {}
  for (const e of errors) {
    if (!byCategory[e.category]) byCategory[e.category] = []
    byCategory[e.category].push(e)
  }
  // What an import adapted (src/utils/importNotes.js), listed after the
  // issues so that notes on elements no diagram shows can be found too.
  const importNotes = allImportNotes(store).filter(({ element }) =>
    !multiSchema || allSchemas || !element.schemaId || element.schemaId === activeSchemaId)
  return { errors, errorCount, byCategory, importNotes, multiSchema, allSchemas, schemaNameOf }
}

// The Problems tab of the sidebar (Sidebar.jsx): validation issues and
// import notes; a click goes to the element.
export default function ValidationPanel() {
  const store = useOrmStoreIgnoring('pan', 'zoom')
  const { errorCount, byCategory, importNotes, multiSchema, allSchemas, schemaNameOf } = visibleIssues(store)
  const toggleAllSchemas = () => store.setValidationAllSchemas(!allSchemas)
  // A click that ends a text selection only selects; see utils/textPanel.js.
  // A relational schema showing its tables names each issue's table, column
  // or key first, and a click selects that object (RM schemas, step 4).
  const rmView = activeRelationalFace(store) ? relationalView(useOrmStore.getState(), activeSchemaIdOf(store)) : null
  const rmOf = (e) => (rmView && e.elementId ? rmObjectOf(rmView, e.elementId) : null)
  const navigate = (e) => {
    if (hasTextSelection()) return
    const rmObj = rmOf(e)
    if (rmObj) { store.navigateToElement(e.elementId, e.elementKind); useOrmStore.getState().selectRm(rmObj); return }
    // A mapping rule: the Mappings tab, with the rule open in the rule editor.
    if (e.elementKind === 'mappingRule') {
      const s = useOrmStore.getState()
      s.setBottomPanelCollapsed(false)
      s.setBottomPanelTab('mappings')
      s.openMappingRuleEditor(e.mappingId, e.elementId)
      return
    }
    store.navigateToElement(e.elementId, e.elementKind)
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, fontFamily: FONT, userSelect: 'none' }}>
        {multiSchema && (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 4, padding: '4px 8px',
            borderBottom: '1px solid var(--border-soft)', flexShrink: 0 }}>
            <button
              onClick={toggleAllSchemas}
              title={allSchemas ? 'Show only the issues of the active schema' : 'Show the issues of every schema in the file'}
              style={{
                border: '1px solid var(--border-soft)', borderRadius: 3, cursor: 'pointer',
                fontSize: 10, lineHeight: '15px', padding: '0 6px', fontFamily: FONT,
                background: allSchemas ? 'var(--ink-2)' : 'transparent',
                color: allSchemas ? 'var(--bg-surface)' : 'var(--ink-muted)',
              }}
            >All schemas</button>
          </div>
        )}
        {/* Body — focusable so the messages can be selected and copied (see App.jsx) */}
        <div data-text-panel tabIndex={0} className="copyable" style={{ flex: 1, overflowY: 'auto', padding: 8, display: 'flex', flexDirection: 'column', gap: 10 }}>
          {errorCount === 0 && importNotes.length === 0 ? (
            <div style={{ fontSize: 11, color: 'var(--ink-muted)', textAlign: 'center', marginTop: 12 }}>
              No problems
            </div>
          ) : (<>
            {Object.entries(byCategory).map(([cat, errs]) => (
              <div key={cat}>
                <div style={{
                  fontSize: 9, fontWeight: 700, letterSpacing: '0.08em',
                  textTransform: 'uppercase', color: 'var(--ink-muted)', marginBottom: 4,
                }}>
                  {VALIDATION_CATEGORIES[cat]?.label ?? cat}
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                  {errs.map(e => (
                    <div key={e.id} onClick={() => navigate(e)} style={{
                      display: 'flex', alignItems: 'flex-start', gap: 6,
                      padding: '5px 7px', borderRadius: 4,
                      background: 'var(--bg-raised)',
                      border: '1px solid var(--border-soft)',
                      borderLeft: `3px solid ${SEV_COLOUR[e.severity]}`,
                      cursor: 'pointer',
                    }}
                      onMouseEnter={ev => ev.currentTarget.style.background = 'var(--bg-hover)'}
                      onMouseLeave={ev => ev.currentTarget.style.background = 'var(--bg-raised)'}
                    >
                      <span style={{ color: SEV_COLOUR[e.severity], fontWeight: 700, fontSize: 9, marginTop: 2, flexShrink: 0 }}>
                        {SEV_ICON[e.severity]}
                      </span>
                      <span style={{ fontSize: 11, color: 'var(--ink-2)', lineHeight: 1.4 }}>{multiSchema && allSchemas && schemaNameOf(e) ? `${schemaNameOf(e)}: ` : ''}{rmOf(e) && <b style={{ fontWeight: 600 }}>{rmOf(e).label}: </b>}{e.message}</span>
                    </div>
                  ))}
                </div>
              </div>
            ))}
            {importNotes.length > 0 && (
              <div>
                <div style={{
                  fontSize: 9, fontWeight: 700, letterSpacing: '0.08em',
                  textTransform: 'uppercase', color: 'var(--ink-muted)', marginBottom: 4,
                }}>
                  Import ({importNotes.length})
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                  {importNotes.map(({ element, kind, note }) => {
                    const sev = IMPORT_NOTE_SEVERITY[note.severity] ?? IMPORT_NOTE_SEVERITY.changed
                    return (
                      <div key={`${element.id}:${note.id}`} title={sev.label}
                        onClick={() => { if (!hasTextSelection()) store.navigateToElement(element.id, elementKindOf(element, kind)) }}
                        style={{
                          display: 'flex', alignItems: 'flex-start', gap: 6,
                          padding: '5px 7px', borderRadius: 4,
                          background: 'var(--bg-raised)',
                          border: '1px solid var(--border-soft)',
                          borderLeft: `3px solid ${sev.colour}`,
                          cursor: 'pointer',
                        }}
                        onMouseEnter={ev => ev.currentTarget.style.background = 'var(--bg-hover)'}
                        onMouseLeave={ev => ev.currentTarget.style.background = 'var(--bg-raised)'}
                      >
                        <span style={{ color: sev.colour, fontWeight: 700, fontSize: 9, marginTop: 2, flexShrink: 0 }}>{sev.icon}</span>
                        <span style={{ fontSize: 11, color: 'var(--ink-2)', lineHeight: 1.4 }}>
                          <b style={{ fontWeight: 600 }}>{importNoteElementLabel(store, element, kind, f => factTypeLabel(f, store.objectTypes))}: </b>{note.text}
                        </span>
                      </div>
                    )
                  })}
                </div>
              </div>
            )}
          </>)}
        </div>
    </div>
  )
}
