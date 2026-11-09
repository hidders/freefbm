const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('electronAPI', {
  openFile:  ()     => ipcRenderer.invoke('dialog:openFile'),
  // { path, content } writes to path without asking; { defaultPath, content } asks.
  saveFile:  (opts) => ipcRenderer.invoke('dialog:saveFile', opts),
  exportPdf: (html) => ipcRenderer.invoke('dialog:exportPdf', html),
  openRules: ()     => ipcRenderer.invoke('dialog:openRules'),
  saveRules: (opts) => ipcRenderer.invoke('dialog:saveRules', opts),
  openSql:   ()     => ipcRenderer.invoke('dialog:openSql'),
  saveSql:   (opts) => ipcRenderer.invoke('dialog:saveSql', opts),

  // The open file and whether it has unsaved changes (title bar, close guard).
  setDocument: (doc) => ipcRenderer.send('window:document', doc),
  // Close (or reload) the window after the renderer saved on request.
  closeNow:    ()    => ipcRenderer.send('window:closeNow'),
  // Text editing in a focused field: undo, redo, cut, copy, paste, selectAll.
  nativeEdit:  (cmd) => ipcRenderer.send('window:nativeEdit', cmd),

  // The verbalisation workbench window and its messages to and from the
  // main window.
  workbench: {
    open: () => ipcRenderer.invoke('workbench:open'),
    post: (msg) => ipcRenderer.send('workbench:msg', msg),
    on: (cb) => {
      const h = (_, msg) => cb(msg)
      ipcRenderer.on('workbench:msg', h)
      return () => ipcRenderer.removeListener('workbench:msg', h)
    },
  },

  onMenuEvent: (channel, cb) => {
    const valid = [
      'menu:new', 'menu:open', 'menu:save', 'menu:saveAs',
      'menu:undo', 'menu:redo', 'menu:cut', 'menu:copy', 'menu:paste', 'menu:selectAll',
      'menu:removeFromDiagram', 'menu:deleteFromSchema',
      'menu:zoomIn', 'menu:zoomOut', 'menu:zoomReset',
      'menu:sidebarBrowser', 'menu:sidebarProblems', 'menu:shortcuts',
      'menu:exportPdf', 'menu:importSql', 'menu:exportSql', 'menu:loadSampleSql', 'menu:exportRowsSql',
      'app:saveThenClose',
    ]
    if (!valid.includes(channel)) return
    ipcRenderer.on(channel, cb)
    return () => ipcRenderer.removeListener(channel, cb)
  },
})
