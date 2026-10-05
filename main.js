const { app, BrowserWindow, ipcMain, dialog, shell, Tray, Menu, nativeImage, globalShortcut } = require('electron')
const path = require('path')
const fs = require('fs')
const { initUpdater, checkForUpdates } = require('./updater')

// When running as a portable exe (built with electron-builder portable target),
// PORTABLE_EXECUTABLE_DIR is set to the directory containing the exe.
// Store data next to the exe so the app is truly self-contained.
const DATA_DIR = process.env.PORTABLE_EXECUTABLE_DIR
  ? path.join(process.env.PORTABLE_EXECUTABLE_DIR, 'EZSoundboard-data')
  : app.getPath('userData')

const CONFIG_PATH = path.join(DATA_DIR, 'soundboard.json')

let mainWindow
let tray

function ensureDirectories() {
  fs.mkdirSync(DATA_DIR, { recursive: true })
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

  mainWindow.on('close', () => {
    app.isQuitting = true
    app.quit()
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

ipcMain.handle('shell:showInFolder', (_, filePath) => {
  if (filePath && fs.existsSync(filePath)) {
    shell.showItemInFolder(filePath)
  }
})

ipcMain.handle('shell:openExternal', (_, url) => {
  shell.openExternal(url)
})

// Windows re-sends a global hotkey while it's held (key auto-repeat), which would toggle the
// tile on and off. Electron gives no key-up event, so repeats are told apart by timing: they
// arrive in a fast stream (< HOTKEY_REPEAT_GAP apart) starting 250–1000 ms after the press.
const HOTKEY_REPEAT_GAP = 120
const HOTKEY_REPEAT_DELAY_MAX = 1100
const hotkeyTimings = new Map() // shortcut → { last, pending }

function onGlobalHotkey(shortcut) {
  const fire = () => {
    if (!mainWindow.isDestroyed()) mainWindow.webContents.send('hotkeys:triggered', shortcut)
  }
  const timing = hotkeyTimings.get(shortcut) ?? { last: 0, pending: null }
  hotkeyTimings.set(shortcut, timing)
  const now = Date.now()
  const gap = now - timing.last
  timing.last = now

  if (gap < HOTKEY_REPEAT_GAP) {
    // Part of a repeat stream, so a still-pending trigger just before it was the stream's start
    clearTimeout(timing.pending)
    timing.pending = null
  } else if (gap < HOTKEY_REPEAT_DELAY_MAX) {
    // A quick second press or the first auto-repeat — wait briefly to see if a stream follows
    timing.pending = setTimeout(() => { timing.pending = null; fire() }, HOTKEY_REPEAT_GAP)
  } else {
    fire()
  }
}

// Global hotkeys — tile shortcuts registered system-wide so they work while another app
// (e.g. a game) is focused. Returns the shortcuts that couldn't be registered, usually
// because another app already owns that key combo.
ipcMain.handle('hotkeys:set', (_, hotkeys) => {
  globalShortcut.unregisterAll()
  const failed = []
  for (const { shortcut, accelerator } of hotkeys) {
    try {
      const ok = globalShortcut.register(accelerator, () => onGlobalHotkey(shortcut))
      if (!ok) failed.push(shortcut)
    } catch (e) {
      console.error('Invalid accelerator:', accelerator, e)
      failed.push(shortcut)
    }
  }
  return failed
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
          label: 'Check for Updates…',
          click: () => checkForUpdates()
        },
        { type: 'separator' },
        {
          label: 'Discord & Audio Setup',
          click: () => mainWindow?.webContents.send('open-help-modal')
        },
        {
          label: 'Support on Ko-fi',
          click: () => shell.openExternal('https://ko-fi.com/mootness')
        }
      ]
    }
  ])
  Menu.setApplicationMenu(menu)
}

// Single instance — a second copy (e.g. launched again while hidden in the tray) couldn't
// register the global hotkeys and would race the first one writing the config file.
// Packaged builds only: `npm start` shares the installed app's data folder and should still
// launch while the installed app is running.
if (app.isPackaged && !app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
  })

  app.whenReady().then(() => {
    ensureDirectories()
    createWindow()
    createTray()
    createAppMenu()
    initUpdater(mainWindow)

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  app.isQuitting = true
})

app.on('will-quit', () => {
  globalShortcut.unregisterAll()
})
