const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('electronAPI', {
  openFile:  ()     => ipcRenderer.invoke('dialog:openFile'),
  saveFile:  (opts) => ipcRenderer.invoke('dialog:saveFile', opts),
  exportPdf: (html) => ipcRenderer.invoke('dialog:exportPdf', html),
  openRules: ()     => ipcRenderer.invoke('dialog:openRules'),
  saveRules: (opts) => ipcRenderer.invoke('dialog:saveRules', opts),

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
      'menu:deleteSelected', 'menu:zoomIn', 'menu:zoomOut', 'menu:zoomReset',
      'menu:exportPdf',
    ]
    if (!valid.includes(channel)) return
    ipcRenderer.on(channel, cb)
    return () => ipcRenderer.removeListener(channel, cb)
  },
})
