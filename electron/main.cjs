const { app, BrowserWindow, ipcMain, dialog, Menu, shell } = require('electron')
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
  guardUnsaved(win)
  return win
}

// Unsaved changes: the page refuses to unload while the model is dirty
// (hooks/useDocumentState.js), and the question is asked here. Save asks the
// page to save; once it has, it calls window:closeNow and the close (or
// reload, or quit) goes ahead.
let quitting = false
app.on('before-quit', () => { quitting = true })

function guardUnsaved(win) {
  win.__pending = null   // 'reload' while a reload is waiting on the question
  win.webContents.on('did-finish-load', () => { win.__pending = null })
  win.webContents.on('will-prevent-unload', (event) => {
    const reload = win.__pending === 'reload'
    const choice = dialog.showMessageBoxSync(win, {
      type: 'warning',
      buttons: ['Save…', "Don't Save", 'Cancel'],
      defaultId: 0, cancelId: 2,
      message: 'Do you want to save the changes to this model?',
      detail: reload ? 'Your changes are lost if the window reloads without saving.'
                     : 'Your changes are lost if you close without saving.',
    })
    if (choice === 1) { event.preventDefault(); return }   // unload anyway
    // Save or Cancel: the window stays for now. After a save the page calls
    // window:closeNow, which finishes what was asked (close, quit or reload).
    win.__quitAfterSave = quitting
    quitting = false
    if (choice === 0) win.webContents.send('app:saveThenClose')
    else win.__pending = null
  })
}

ipcMain.on('window:closeNow', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender)
  if (!win) return
  if (win.__pending === 'reload') { win.__pending = null; win.webContents.reload(); return }
  const quit = win.__quitAfterSave
  win.__quitAfterSave = false
  win.close()
  if (quit) app.quit()
})

ipcMain.on('window:document', (event, { path: filePath, dirty, title }) => {
  const win = BrowserWindow.fromWebContents(event.sender)
  if (!win) return
  if (title) win.setTitle(title)
  if (process.platform === 'darwin') {
    win.setRepresentedFilename(filePath || '')
    win.setDocumentEdited(!!dirty)
  }
})

const EDIT_COMMANDS = new Set(['undo', 'redo', 'cut', 'copy', 'paste', 'selectAll'])
ipcMain.on('window:nativeEdit', (event, cmd) => {
  if (EDIT_COMMANDS.has(cmd)) event.sender[cmd]()
})

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
        { label: 'Import SQL DDL (PostgreSQL, Oracle or SQL Server)…', click: send('menu:importSql') },
        { label: 'Export SQL DDL…', click: send('menu:exportSql') },
        { label: 'Load Sample Rows from SQL…', click: send('menu:loadSampleSql') },
        { label: 'Export Sample Rows as SQL…', click: send('menu:exportRowsSql') },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' },
      ],
    },
    {
      label: 'Edit',
      // The model's own undo, clipboard and selection; in a text field the
      // page passes them on as text editing (window:nativeEdit). The page
      // handles these keys itself, so the accelerators are only shown on
      // Windows and Linux (on macOS a key the page handled never reaches the menu).
      submenu: [
        { label: 'Undo',       accelerator: 'CmdOrCtrl+Z',       registerAccelerator: false, click: send('menu:undo') },
        { label: 'Redo',       accelerator: isMac ? 'Cmd+Shift+Z' : 'Ctrl+Y', registerAccelerator: false, click: send('menu:redo') },
        { type: 'separator' },
        { label: 'Cut',        accelerator: 'CmdOrCtrl+X',       registerAccelerator: false, click: send('menu:cut') },
        { label: 'Copy',       accelerator: 'CmdOrCtrl+C',       registerAccelerator: false, click: send('menu:copy') },
        { label: 'Paste',      accelerator: 'CmdOrCtrl+V',       registerAccelerator: false, click: send('menu:paste') },
        { label: 'Select All', accelerator: 'CmdOrCtrl+A',       registerAccelerator: false, click: send('menu:selectAll') },
        { type: 'separator' },
        // No accelerator on macOS: Backspace must keep deleting text in fields.
        { label: 'Remove from Diagram', ...(isMac ? {} : { accelerator: 'Delete', registerAccelerator: false }), click: send('menu:removeFromDiagram') },
        { label: 'Delete from Schema…', click: send('menu:deleteFromSchema') },
      ],
    },
    {
      label: 'View',
      submenu: [
        // Reloading drops the model; only offered while developing, and the
        // unsaved-changes question still applies.
        ...(isDev ? [{ label: 'Reload', accelerator: 'CmdOrCtrl+R', click: () => { win.__pending = 'reload'; win.webContents.reload() } }, { type: 'separator' }] : []),
        { label: 'Zoom In',    accelerator: 'CmdOrCtrl+=', click: send('menu:zoomIn') },
        { label: 'Zoom Out',   accelerator: 'CmdOrCtrl+-', click: send('menu:zoomOut') },
        { label: 'Reset Zoom', accelerator: 'CmdOrCtrl+0', click: send('menu:zoomReset') },
        { type: 'separator' },
        // The sidebar's tabs; the page handles the keys (Sidebar.jsx).
        { label: 'Browser',  accelerator: 'CmdOrCtrl+1', registerAccelerator: false, click: send('menu:sidebarBrowser') },
        { label: 'Problems', accelerator: 'CmdOrCtrl+2', registerAccelerator: false, click: send('menu:sidebarProblems') },
        { type: 'separator' },
        { label: 'Verbalisation Workbench', accelerator: 'CmdOrCtrl+Shift+B', click: openWorkbench },
        { type: 'separator' },
        { role: 'toggleDevTools' }, { role: 'togglefullscreen' },
      ],
    },
    { role: 'windowMenu' },
    {
      role: 'help',
      submenu: [
        { label: 'Keyboard Shortcuts', accelerator: 'CmdOrCtrl+/', click: send('menu:shortcuts') },
        { type: 'separator' },
        { label: 'FreeFBM on GitHub', click: () => shell.openExternal('https://github.com/hidders/freefbm') },
      ],
    },
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

ipcMain.handle('dialog:saveFile', async (event, { path: knownPath, defaultPath, content }) => {
  // Save to the file the model came from: no question.
  if (knownPath && /\.ffbm$/i.test(knownPath)) {
    fs.writeFileSync(knownPath, content, 'utf-8')
    return knownPath
  }
  const { canceled, filePath } = await dialog.showSaveDialog(BrowserWindow.fromWebContents(event.sender), {
    // Offer .ffbm even when the model was opened from a legacy .orm2/.json file
    defaultPath: (defaultPath || 'model.ffbm').replace(/\.(orm2|json|orm)$/i, '.ffbm'),
    filters: [{ name: 'FreeFBM Model', extensions: ['ffbm'] }],
  })
  if (canceled || !filePath) return null
  fs.writeFileSync(filePath, content, 'utf-8')
  return filePath
})

// SQL scripts: PostgreSQL DDL read into, or written from, a relational schema.
const SQL_FILTERS = [{ name: 'SQL Script', extensions: ['sql', 'ddl', 'pgsql'] }, { name: 'All Files', extensions: ['*'] }]

ipcMain.handle('dialog:openSql', async (event) => {
  const { canceled, filePaths } = await dialog.showOpenDialog(BrowserWindow.fromWebContents(event.sender), {
    filters: SQL_FILTERS, properties: ['openFile'],
  })
  if (canceled || !filePaths.length) return null
  return { path: filePaths[0], content: fs.readFileSync(filePaths[0], 'utf-8') }
})

ipcMain.handle('dialog:saveSql', async (event, { defaultPath, content }) => {
  const { canceled, filePath } = await dialog.showSaveDialog(BrowserWindow.fromWebContents(event.sender), {
    defaultPath: defaultPath || 'schema.sql', filters: SQL_FILTERS,
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
