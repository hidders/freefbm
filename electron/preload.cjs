const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('electronAPI', {
  openFile:  ()     => ipcRenderer.invoke('dialog:openFile'),
  saveFile:  (opts) => ipcRenderer.invoke('dialog:saveFile', opts),
  exportPdf: (html) => ipcRenderer.invoke('dialog:exportPdf', html),

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
