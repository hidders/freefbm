const { app, BrowserWindow, ipcMain, dialog, Menu } = require('electron')
const path = require('path')
const fs = require('fs')

const isDev = !app.isPackaged

function createWindow() {
  const win = new BrowserWindow({
    width: 1440, height: 900, minWidth: 960, minHeight: 640,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    backgroundColor: '#0d0f0e',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: false,
    },
  })

  if (isDev) {
    win.loadURL('http://localhost:5173')
    win.webContents.openDevTools()
  } else {
    win.loadFile(path.join(app.getAppPath(), 'dist', 'index.html'))
  }

  buildMenu(win)
  return win
}

function buildMenu(win) {
  const isMac = process.platform === 'darwin'
  const send = (ch) => () => win.webContents.send(ch)
  const template = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    {
      label: 'File',
      submenu: [
        { label: 'New Model', accelerator: 'CmdOrCtrl+N',       click: send('menu:new') },
        { label: 'Open…',     accelerator: 'CmdOrCtrl+O',       click: send('menu:open') },
        { type: 'separator' },
        { label: 'Save',      accelerator: 'CmdOrCtrl+S',       click: send('menu:save') },
        { label: 'Save As…',  accelerator: 'CmdOrCtrl+Shift+S', click: send('menu:saveAs') },
        { type: 'separator' },
        { label: 'Export to PDF…', accelerator: 'CmdOrCtrl+Shift+E', click: send('menu:exportPdf') },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' }, { role: 'redo' }, { type: 'separator' },
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' },
        { type: 'separator' },
        { label: 'Delete Selected', accelerator: 'Delete', click: send('menu:deleteSelected') },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' }, { type: 'separator' },
        { label: 'Zoom In',    accelerator: 'CmdOrCtrl+=', click: send('menu:zoomIn') },
        { label: 'Zoom Out',   accelerator: 'CmdOrCtrl+-', click: send('menu:zoomOut') },
        { label: 'Reset Zoom', accelerator: 'CmdOrCtrl+0', click: send('menu:zoomReset') },
        { type: 'separator' },
        { role: 'toggleDevTools' }, { role: 'togglefullscreen' },
      ],
    },
    { role: 'windowMenu' },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

ipcMain.handle('dialog:exportPdf', async (event, htmlContent) => {
  const win = BrowserWindow.fromWebContents(event.sender)
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    defaultPath: 'diagram.pdf',
    filters: [{ name: 'PDF Document', extensions: ['pdf'] }],
  })
  if (canceled || !filePath) return false

  // Render the self-contained SVG HTML in a hidden window and print to PDF
  const pdfWin = new BrowserWindow({
    show: false,
    webPreferences: { contextIsolation: true },
  })
  await pdfWin.loadURL(
    'data:text/html;charset=utf-8,' + encodeURIComponent(htmlContent)
  )
  const pdfBuffer = await pdfWin.webContents.printToPDF({
    printBackground: false,
    pageSize: 'A4',
    landscape: true,
  })
  pdfWin.close()
  fs.writeFileSync(filePath, pdfBuffer)
  return true
})

ipcMain.handle('dialog:openFile', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog({
    filters: [{ name: 'ORM2 Model', extensions: ['orm2', 'json'] }],
    properties: ['openFile'],
  })
  if (canceled || !filePaths.length) return null
  return { path: filePaths[0], content: fs.readFileSync(filePaths[0], 'utf-8') }
})

ipcMain.handle('dialog:saveFile', async (_, { defaultPath, content }) => {
  const { canceled, filePath } = await dialog.showSaveDialog({
    defaultPath: defaultPath || 'model.orm2',
    filters: [{ name: 'ORM2 Model', extensions: ['orm2', 'json'] }],
  })
  if (canceled || !filePath) return null
  fs.writeFileSync(filePath, content, 'utf-8')
  return filePath
})

app.whenReady().then(() => {
  createWindow()
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow() })
})
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
