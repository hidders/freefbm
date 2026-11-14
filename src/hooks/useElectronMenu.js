import { useEffect, useRef } from 'react'
import { useOrmStore, useOrmStoreIgnoring } from '../store/ormStore'
import { triggerPdfExport } from '../utils/pdfExport'
import { newModel, openModel, saveModel } from '../utils/fileActions'
import { removeSelectionFromDiagram, openDeleteFromSchema, canDeleteFromSchema } from '../utils/deleteSelection'
import { undoRedo } from './useUndoRedo'
import { textPanelOf } from '../utils/textPanel'
import { isErdDiagram } from '../components/ErdView'
import { activeReadOnly } from '../relational/face'
import { activeSchemaIdOf } from '../store/storeHelpers'
import { exportNorma } from '../export/norma'
import { runSchemaAction, schemaMenuState } from '../utils/schemaActions'
import { runMappingAction, mappingMenuState } from '../utils/mappingActions'

const isElectron = typeof window !== 'undefined' && !!window.electronAPI

export function useElectronMenu() {
  // Use a ref so IPC handlers always read current state without re-registering on every change.
  const storeRef = useRef(null)
  storeRef.current = useOrmStoreIgnoring('pan', 'zoom')

  useEffect(() => {
    if (!isElectron) return
    const api = window.electronAPI
    const unsubs = []

    const on = (channel, handler) => {
      const unsub = api.onMenuEvent(channel, handler)
      if (unsub) unsubs.push(unsub)
    }

    on('menu:new', () => newModel())
    on('menu:open', () => openModel())
    on('menu:save', () => saveModel())
    on('menu:saveAs', () => saveModel({ saveAs: true }))

    // Edit: in a text field these are text editing; elsewhere they act on
    // the model, as their keys do (App.jsx, useUndoRedo.js).
    const typing = () => {
      const el = document.activeElement
      const tag = el?.tagName
      return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || !!el?.isContentEditable || !!textPanelOf(el)
    }
    const onErd = () => {
      const st = useOrmStore.getState()
      return isErdDiagram(st, st.diagrams?.find(d => d.id === st.activeDiagramId))
    }
    const edit = (cmd, modelAction) => on(`menu:${cmd}`, () => {
      if (typing()) { api.nativeEdit(cmd); return }
      modelAction()
    })
    edit('undo', () => undoRedo.undo())
    edit('redo', () => undoRedo.redo())
    edit('cut', () => { if (!onErd()) useOrmStore.getState().cutSelection() })
    edit('copy', () => { if (!onErd()) useOrmStore.getState().copySelection() })
    edit('paste', () => { if (!onErd()) useOrmStore.getState().pasteClipboard() })
    edit('selectAll', () => { if (!onErd()) useOrmStore.getState().selectAll() })
    on('menu:removeFromDiagram', () => { if (!typing()) removeSelectionFromDiagram() })
    on('menu:deleteFromSchema', () => {
      if (canDeleteFromSchema()) openDeleteFromSchema()
      else alert(activeReadOnly(useOrmStore.getState())
        ? 'A relational schema changes only through transformations (Transform…).'
        : 'Select the elements to delete first.')
    })

    on('menu:zoomIn',    () => storeRef.current.zoomBy(0.1))
    on('menu:zoomOut',   () => storeRef.current.zoomBy(-0.1))
    on('menu:zoomReset', () => storeRef.current.resetView())
    on('menu:sidebarBrowser',  () => useOrmStore.getState().showSidebarTab('browser'))
    on('menu:sidebarProblems', () => useOrmStore.getState().showSidebarTab('problems'))
    on('menu:shortcuts', () => useOrmStore.setState({ shortcutsDialog: true }))

    on('menu:exportPdf', () => triggerPdfExport(storeRef.current))

    // PostgreSQL DDL: imported as a new relational schema of this file, and
    // exported from the active schema when it is relational.
    on('menu:importSql', async () => {
      const result = await api.openSql()
      if (!result) return
      const name = result.path.split(/[\\/]/).pop().replace(/\.(sql|ddl|pgsql)$/i, '')
      try { useOrmStore.getState().importPostgresDdl(result.content, name) }
      catch (err) { alert(`Failed to read the DDL.${err?.message ? `\n${err.message}` : ''}`) }
    })

    // Sample rows (INSERT … VALUES, COPY … FROM stdin) of a SQL script, as
    // the population of the active relational schema.
    on('menu:loadSampleSql', async () => {
      const s = useOrmStore.getState()
      const schema = s.schemas.find(x => x.id === activeSchemaIdOf(s))
      if (schema?.profile !== 'relational') {
        alert('Load Sample Rows reads rows into a relational schema. Switch to a relational schema first.')
        return
      }
      const result = await api.openSql()
      if (!result) return
      try { useOrmStore.getState().loadSampleRows(schema.id, result.content, result.path.split(/[\\/]/).pop()) }
      catch (err) { alert(`Failed to read the rows.${err?.message ? `\n${err.message}` : ''}`) }
    })

    // File › Export NORMA .orm…: the active ORM2 schema as a NORMA file
    // (export/norma.js); what it left out is shown in the import log panel.
    on('menu:exportNorma', async () => {
      const s = useOrmStore.getState()
      const schema = s.schemas.find(x => x.id === activeSchemaIdOf(s))
      if (schema?.profile === 'relational') {
        alert('Export NORMA .orm writes an ORM2 schema. Switch to an ORM2 schema first.')
        return
      }
      const base = (s.filePath ?? s.importedFrom ?? '').split(/[\\/]/).pop().replace(/\.(ffbm|orm2|json|orm)$/i, '')
      const name = (s.schemas.length > 1 ? schema?.name : base) || schema?.name || 'Model'
      let result
      try { result = exportNorma(s, { schemaId: schema?.id ?? null, name }) }
      catch (err) { alert(`The export failed.${err?.message ? `\n${err.message}` : ''}`); return }
      const path = await api.saveOrm({ defaultPath: `${name.replace(/[^\p{L}\p{N}_ -]+/gu, '_')}.orm`, content: result.xml })
      if (path) s.setImportLog({ kind: 'export', source: path.split(/[\\/]/).pop(), entries: result.report })
    })

    on('menu:exportSql', async () => {
      const s = useOrmStore.getState()
      const schema = s.schemas.find(x => x.id === activeSchemaIdOf(s))
      if (schema?.profile !== 'relational') {
        alert('Export SQL DDL writes a relational schema. Switch to a relational schema first (or set this schema\'s kind to Relational in Schema settings).')
        return
      }
      // The dialog reports how each constraint is enforced before saving
      // (DdlExportDialog.jsx, relational/enforcement.js).
      useOrmStore.setState({ ddlExportDialog: { schemaId: schema.id } })
    })

    // The sample rows of the active relational schema as INSERT statements
    // (relational/populationSql.js).
    on('menu:exportRowsSql', async () => {
      const s = useOrmStore.getState()
      const schema = s.schemas.find(x => x.id === activeSchemaIdOf(s))
      if (schema?.profile !== 'relational') {
        alert('Export Sample Rows writes the rows of a relational schema. Switch to a relational schema first.')
        return
      }
      const { sql, notes } = s.populationSql(schema.id, { format: 'insert', header: `Rows of ${schema.name}, written by FreeFBM.` })
      const path = await api.saveSql({ defaultPath: `${schema.name.replace(/[^A-Za-z0-9_-]+/g, '_')}-rows.sql`, content: sql })
      if (path && notes.length) alert(notes.join('\n'))
    })

    // Schema and Mapping menus: actions on the active schema and mapping
    // (utils/schemaActions.js, utils/mappingActions.js); the main process
    // greys out those that don't apply and lists the mappings.
    on('menu:schema', (_e, action) => runSchemaAction(action))
    on('menu:mapping', (_e, action, arg) => runMappingAction(action, arg))
    let lastMenuState = '', lastRefs = []
    const syncMenu = (s) => {
      // Only what the menu state reads (dragging changes none of these).
      const refs = [s.schemas, s.objectTypes, s.facts, s.diagrams, s.activeDiagramId, s.mappings, s.activeMappingId, s.advancedMode]
      if (refs.every((r, i) => r === lastRefs[i])) return
      lastRefs = refs
      const { enabled: mappingEnabled, ...mapping } = mappingMenuState(s)
      const state = { enabled: { ...schemaMenuState(s), ...mappingEnabled }, mapping }
      const key = JSON.stringify(state)
      if (key === lastMenuState) return
      lastMenuState = key
      api.setMenuState?.(state)
    }
    syncMenu(useOrmStore.getState())
    unsubs.push(useOrmStore.subscribe(syncMenu))

    return () => unsubs.forEach(u => u())
  }, []) // register once — storeRef.current always holds latest state
}
