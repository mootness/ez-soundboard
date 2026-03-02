const { app, BrowserWindow, ipcMain, dialog, shell, Tray, Menu, nativeImage } = require('electron')
const path = require('path')
const fs = require('fs')

// When running as a portable exe (built with electron-builder portable target),
// PORTABLE_EXECUTABLE_DIR is set to the directory containing the exe.
// Store data next to the exe so the app is truly self-contained.
const DATA_DIR = process.env.PORTABLE_EXECUTABLE_DIR
  ? path.join(process.env.PORTABLE_EXECUTABLE_DIR, 'EZSoundboard-data')
  : app.getPath('userData')

const CONFIG_PATH    = path.join(DATA_DIR, 'soundboard.json')
const SOUNDBOARD_DIR = path.join(DATA_DIR, 'soundboard')

let mainWindow
let tray

function ensureDirectories() {
  fs.mkdirSync(SOUNDBOARD_DIR, { recursive: true })
}

function defaultConfig() {
  return {
    pages: [
      { id: 'page-1', name: 'Page 1', tiles: [] }
    ],
    settings: { masterVolume: 1.0 }
  }
}

function readConfig() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const raw = fs.readFileSync(CONFIG_PATH, 'utf-8')
      return JSON.parse(raw)
    }
  } catch (e) {
    console.error('Failed to read config:', e)
  }
  return defaultConfig()
}

function writeConfig(config) {
  try {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf-8')
    return true
  } catch (e) {
    console.error('Failed to write config:', e)
    return false
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1000,
    height: 720,
    minWidth: 800,
    minHeight: 600,
    title: 'EZ Soundboard',
    backgroundColor: '#1a1a2e',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: false
    },
    icon: path.join(__dirname, 'assets', 'icon.png')
  })

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'))

  mainWindow.on('close', (e) => {
    if (!app.isQuitting) {
      e.preventDefault()
      mainWindow.hide()
    }
  })
}

function createTray() {
  // Use a simple fallback if no icon exists
  let trayIcon
  const iconPath = path.join(__dirname, 'assets', 'icon.png')
  if (fs.existsSync(iconPath)) {
    trayIcon = nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 })
  } else {
    trayIcon = nativeImage.createEmpty()
  }

  tray = new Tray(trayIcon)
  tray.setToolTip('EZ Soundboard')

  const contextMenu = Menu.buildFromTemplate([
    { label: 'Show', click: () => mainWindow.show() },
    { type: 'separator' },
    {
      label: 'Quit', click: () => {
        app.isQuitting = true
        app.quit()
      }
    }
  ])
  tray.setContextMenu(contextMenu)
  tray.on('click', () => {
    mainWindow.isVisible() ? mainWindow.hide() : mainWindow.show()
  })
}

// IPC Handlers

ipcMain.handle('dialog:openFolder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
    title: 'Select Audio Folder'
  })
  if (result.canceled || result.filePaths.length === 0) return null
  const folderPath = result.filePaths[0]

  const AUDIO_EXTS = ['.mp3', '.wav', '.ogg', '.flac', '.m4a', '.aac', '.opus', '.webm']
  const files = fs.readdirSync(folderPath)
    .filter(f => AUDIO_EXTS.includes(path.extname(f).toLowerCase()))
    .map(f => ({
      name: path.basename(f, path.extname(f)),
      file: path.join(folderPath, f)
    }))

  return { folderPath, files }
})

ipcMain.handle('dialog:openFile', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    filters: [
      { name: 'Audio Files', extensions: ['mp3', 'wav', 'ogg', 'flac', 'm4a', 'aac', 'opus', 'webm'] }
    ],
    title: 'Select Audio File'
  })
  if (result.canceled || result.filePaths.length === 0) return null
  const filePath = result.filePaths[0]
  return {
    name: path.basename(filePath, path.extname(filePath)),
    file: filePath
  }
})

ipcMain.handle('config:read', () => readConfig())

ipcMain.handle('config:write', (_, config) => writeConfig(config))

ipcMain.handle('config:getDataPath', () => ({
  configPath: CONFIG_PATH,
  soundboardDir: SOUNDBOARD_DIR
}))

ipcMain.handle('tile:delete', (_, filePath) => {
  try {
    if (filePath && fs.existsSync(filePath)) {
      // Only delete if file is inside the soundboard dir
      if (filePath.startsWith(SOUNDBOARD_DIR)) {
        fs.unlinkSync(filePath)
      }
    }
    return true
  } catch (e) {
    console.error('Failed to delete file:', e)
    return false
  }
})

ipcMain.handle('shell:showInFolder', (_, filePath) => {
  if (filePath && fs.existsSync(filePath)) {
    shell.showItemInFolder(filePath)
  }
})

function createAppMenu() {
  const menu = Menu.buildFromTemplate([
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' }
      ]
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'close' }
      ]
    },
    {
      label: 'Help',
      submenu: [
        {
          label: 'Discord & Audio Setup',
          click: () => mainWindow?.webContents.send('open-help-modal')
        }
      ]
    }
  ])
  Menu.setApplicationMenu(menu)
}

app.whenReady().then(() => {
  ensureDirectories()
  createWindow()
  createTray()
  createAppMenu()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  app.isQuitting = true
})
