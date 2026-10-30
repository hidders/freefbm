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

// The verbalisation workbench: a second window of the same app (#workbench),
// which gets the model from the main window through workbench:msg.
let workbench = null
function openWorkbench() {
  if (workbench && !workbench.isDestroyed()) { workbench.focus(); return }
  workbench = new BrowserWindow({
    width: 1280, height: 820, minWidth: 800, minHeight: 500,
    title: 'Verbalisation Workbench',
    backgroundColor: '#f5f0e8',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })
  if (isDev) workbench.loadURL('http://localhost:5173/#workbench')
  else workbench.loadFile(path.join(app.getAppPath(), 'dist', 'index.html'), { hash: 'workbench' })
  workbench.on('closed', () => { workbench = null })
}

ipcMain.handle('workbench:open', () => { openWorkbench() })

// Relays messages between the main window and the workbench.
ipcMain.on('workbench:msg', (event, msg) => {
  for (const w of BrowserWindow.getAllWindows()) {
    if (w.webContents !== event.sender && !w.isDestroyed()) w.webContents.send('workbench:msg', msg)
  }
})

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
        { label: 'Verbalisation Workbench', accelerator: 'CmdOrCtrl+Shift+B', click: openWorkbench },
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
    // .orm2 and .json are the legacy extensions; they still open.
    // .orm is a NORMA model, imported as a new unsaved model.
    filters: [
      { name: 'FreeFBM or NORMA Model', extensions: ['ffbm', 'orm2', 'json', 'orm'] },
      { name: 'FreeFBM Model', extensions: ['ffbm', 'orm2', 'json'] },
      { name: 'NORMA Model', extensions: ['orm'] },
    ],
    properties: ['openFile'],
  })
  if (canceled || !filePaths.length) return null
  return { path: filePaths[0], content: fs.readFileSync(filePaths[0], 'utf-8') }
})

ipcMain.handle('dialog:saveFile', async (_, { defaultPath, content }) => {
  const { canceled, filePath } = await dialog.showSaveDialog({
    // Offer .ffbm even when the model was opened from a legacy .orm2/.json file
    defaultPath: (defaultPath || 'model.ffbm').replace(/\.(orm2|json|orm)$/i, '.ffbm'),
    filters: [{ name: 'FreeFBM Model', extensions: ['ffbm'] }],
  })
  if (canceled || !filePath) return null
  fs.writeFileSync(filePath, content, 'utf-8')
  return filePath
})

// Rule files (.vr) for the workbench.
const RULE_FILTERS = [{ name: 'Verbalisation Rules', extensions: ['vr'] }, { name: 'All Files', extensions: ['*'] }]

ipcMain.handle('dialog:openRules', async (event) => {
  const { canceled, filePaths } = await dialog.showOpenDialog(BrowserWindow.fromWebContents(event.sender), {
    filters: RULE_FILTERS, properties: ['openFile'],
  })
  if (canceled || !filePaths.length) return null
  return { path: filePaths[0], content: fs.readFileSync(filePaths[0], 'utf-8') }
})

ipcMain.handle('dialog:saveRules', async (event, { defaultPath, content }) => {
  const { canceled, filePath } = await dialog.showSaveDialog(BrowserWindow.fromWebContents(event.sender), {
    defaultPath: defaultPath || 'english.vr', filters: RULE_FILTERS,
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
