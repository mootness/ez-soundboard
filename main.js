const { app, BrowserWindow, ipcMain, dialog, shell, Tray, Menu, nativeImage, globalShortcut, clipboard, screen } = require('electron')
const path = require('path')
const fs = require('fs')
const { spawn, execFile } = require('child_process')
const { initUpdater, checkForUpdates, diagnosticInfo } = require('./updater')

// When running as a portable exe (built with electron-builder portable target),
// PORTABLE_EXECUTABLE_DIR is set to the directory containing the exe.
// Store data next to the exe so the app is truly self-contained.
const DATA_DIR = process.env.PORTABLE_EXECUTABLE_DIR
  ? path.join(process.env.PORTABLE_EXECUTABLE_DIR, 'EZSoundboard-data')
  : app.getPath('userData')

const CONFIG_PATH = path.join(DATA_DIR, 'soundboard.json')
// The board as it was the last time the app started with a readable file
const CONFIG_BACKUP_PATH = path.join(DATA_DIR, 'soundboard.backup.json')
// Settings the main process uses on its own (what the close button does), kept apart from the
// board file the renderer writes
const APP_SETTINGS_PATH = path.join(DATA_DIR, 'app-settings.json')
const ICON_PATH = path.join(__dirname, 'assets', 'icon.png')

// File types Chromium can play the sound of — video files play their audio track.
// Keep in sync with MEDIA_EXTS in renderer/app.js.
const MEDIA_EXTS = [
  'mp3', 'wav', 'ogg', 'oga', 'opus', 'flac', 'm4a', 'aac', 'weba', 'webm', 'mka',
  'mp4', 'm4v', 'mov', 'mkv', 'ogv', '3gp'
]

let mainWindow
let tray
// Something the user should be told once the window is up (e.g. the board was restored)
let startupNotice = null
// closeToTray: the close button hides the window to the tray instead of quitting.
// trayHintShown: the "still running" notification has been shown once.
let appSettings = { closeToTray: true, trayHintShown: false }

function ensureDirectories() {
  fs.mkdirSync(DATA_DIR, { recursive: true })
}

function readAppSettings() {
  try {
    appSettings = { ...appSettings, ...JSON.parse(fs.readFileSync(APP_SETTINGS_PATH, 'utf-8')) }
  } catch {
    // first run, or unreadable: keep the defaults
  }
}

function saveAppSettings() {
  try {
    fs.writeFileSync(APP_SETTINGS_PATH, JSON.stringify(appSettings, null, 2), 'utf-8')
  } catch (e) {
    console.error('Failed to save app settings:', e)
  }
}

function defaultConfig() {
  return {
    pages: [
      { id: 'page-1', name: 'Page 1', tiles: [] }
    ],
    settings: { masterVolume: 1.0 }
  }
}

// Reads the board. A damaged file (say the PC lost power mid-save) used to load as an empty
// board, and the first change then saved that empty board over it. Now the damaged file is set
// aside and the copy kept from the last good start is used instead.
function readConfig() {
  if (!fs.existsSync(CONFIG_PATH) && !fs.existsSync(CONFIG_BACKUP_PATH)) return defaultConfig() // first run

  try {
    const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'))
    try {
      fs.copyFileSync(CONFIG_PATH, CONFIG_BACKUP_PATH)
    } catch (e) {
      console.error('Failed to back up config:', e)
    }
    return config
  } catch (e) {
    console.error('Failed to read config:', e)
  }

  try {
    // Keep the unreadable file rather than delete it — it may still be recoverable by hand
    if (fs.existsSync(CONFIG_PATH)) {
      fs.renameSync(CONFIG_PATH, path.join(DATA_DIR, `soundboard.damaged-${Date.now()}.json`))
    }
  } catch (e) {
    console.error('Failed to set the damaged config aside:', e)
  }
  try {
    const config = JSON.parse(fs.readFileSync(CONFIG_BACKUP_PATH, 'utf-8'))
    writeConfig(config)
    startupNotice = 'Your soundboard file was missing or damaged — restored it from the last time the app started'
    return config
  } catch (e) {
    console.error('Failed to restore config from backup:', e)
  }
  startupNotice = 'Your soundboard file was damaged and could not be restored — starting with an empty board'
  return defaultConfig()
}

function writeConfig(config) {
  const json = JSON.stringify(config, null, 2)
  try {
    // Write beside the real file and swap it in, so a crash mid-save can't leave half a board
    const tempPath = CONFIG_PATH + '.tmp'
    fs.writeFileSync(tempPath, json, 'utf-8')
    fs.renameSync(tempPath, CONFIG_PATH)
    return true
  } catch (e) {
    console.error('Failed to save config with a swap, writing it directly:', e)
  }
  try {
    // The swap can be refused while something else (antivirus, a sync client) holds the file
    fs.writeFileSync(CONFIG_PATH, json, 'utf-8')
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
    // Small enough to fit Windows snap zones (halves, corners, thirds) even on a scaled
    // 1080p laptop screen — a larger minimum makes a snapped window overflow its zone
    minWidth: 480,
    minHeight: 320,
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

  // The close button leaves the app running in the tray, so hotkeys and the mic going to
  // Discord carry on. Anything that really quits (Quit, an update installing, Windows shutting
  // down) sets app.isQuitting first. Without a tray icon there'd be no way back, so it quits.
  mainWindow.on('close', (event) => {
    if (!app.isQuitting && appSettings.closeToTray && tray) {
      event.preventDefault()
      mainWindow.hide()
      showTrayHint()
      return
    }
    app.isQuitting = true
    app.quit()
  })
  mainWindow.on('session-end', () => {
    app.isQuitting = true
  })
}

function showWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}

function quitApp() {
  app.isQuitting = true
  app.quit()
}

function sendToWindow(channel, ...args) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, ...args)
}

// The app icon at `size` px on a 100% display, made at the real pixel size for the main
// display's scale. Windows is handed the image as it is, so a 16 px tray icon would be
// stretched (and blurry) at 150%.
function appIcon(size) {
  const image = nativeImage.createFromPath(ICON_PATH)
  if (image.isEmpty()) return image
  const pixels = Math.round(size * screen.getPrimaryDisplay().scaleFactor)
  return image.resize({ width: pixels, height: pixels, quality: 'best' })
}

function createTray() {
  const icon = appIcon(16)
  if (icon.isEmpty()) return // no icon to show, so no tray (and the close button quits)
  try {
    tray = new Tray(icon)
  } catch (e) {
    console.error('Failed to create the tray icon:', e)
    return
  }
  tray.setToolTip('EZ Soundboard')
  tray.setContextMenu(buildTrayMenu())
  tray.on('click', showWindow)
}

function buildTrayMenu() {
  return Menu.buildFromTemplate([
    { label: 'Open EZ Soundboard', click: showWindow },
    { label: 'Stop All Sounds', click: () => sendToWindow('stop-all') },
    { type: 'separator' },
    closeToTrayMenuItem(),
    { type: 'separator' },
    { label: 'Quit EZ Soundboard', click: quitApp }
  ])
}

// In both the tray menu and the Window menu
function closeToTrayMenuItem() {
  return {
    label: 'Close to Tray',
    type: 'checkbox',
    checked: appSettings.closeToTray,
    click: (item) => setCloseToTray(item.checked)
  }
}

function setCloseToTray(on) {
  appSettings.closeToTray = on
  saveAppSettings()
  // Rebuilt so both menus show the new setting
  tray?.setContextMenu(buildTrayMenu())
  createAppMenu()
}

// Shown once, the first time the window goes to the tray: otherwise closing it looks like
// quitting, and Windows 11 starts a new tray icon out hidden behind the ^ arrow
function showTrayHint() {
  if (appSettings.trayHintShown) return
  appSettings.trayHintShown = true
  saveAppSettings()
  tray.displayBalloon({
    title: 'EZ Soundboard is still running',
    content: "Global hotkeys and your mic keep working. Click its icon by the clock to open it again (look under ^ if you can't see it), or right-click the icon to quit.",
    icon: appIcon(32),
    noSound: true
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

  const files = fs.readdirSync(folderPath)
    .filter(f => MEDIA_EXTS.includes(path.extname(f).slice(1).toLowerCase()))
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
      { name: 'Audio & Video Files', extensions: MEDIA_EXTS }
    ],
    title: 'Select Audio or Video File'
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

// Handed over once: shown in the status bar in place of the usual "Ready" message
ipcMain.handle('config:startupNotice', () => {
  const notice = startupNotice
  startupNotice = null
  return notice
})

ipcMain.handle('shell:showInFolder', (_, filePath) => {
  if (filePath && fs.existsSync(filePath)) {
    shell.showItemInFolder(filePath)
  }
})

ipcMain.handle('shell:openExternal', (_, url) => {
  shell.openExternal(url)
})

// ── Auto-level support: the renderer measures a clip's loudness from its file bytes ──
const isMediaFile = (filePath) => typeof filePath === 'string' && MEDIA_EXTS.includes(path.extname(filePath).slice(1).toLowerCase())

// Size and modified time, so a changed file is measured again; null if missing
ipcMain.handle('media:stat', async (_, filePath) => {
  if (!isMediaFile(filePath)) return null
  try {
    const stat = await fs.promises.stat(filePath)
    return { size: stat.size, mtimeMs: stat.mtimeMs }
  } catch {
    return null
  }
})

// Video files can be large; past this, a clip plays unlevelled rather than being read whole
const MEDIA_READ_MAX_BYTES = 200 * 1024 * 1024
ipcMain.handle('media:read', async (_, filePath) => {
  if (!isMediaFile(filePath)) return { error: 'unsupported' }
  try {
    const { size } = await fs.promises.stat(filePath)
    if (size > MEDIA_READ_MAX_BYTES) return { error: 'too-large' }
    return { bytes: await fs.promises.readFile(filePath) }
  } catch {
    return { error: 'unreadable' }
  }
})

// ── Discord setup checks ──
// Windows' "When Windows detects communications activity" setting (Sound control panel →
// Communications): by default it turns other sounds down 80% during calls, which can include
// the soundboard. Resolves 'mute' | 'reduce80' | 'reduce50' | 'off', or 'unknown'.
ipcMain.handle('system:callDucking', () => new Promise((resolve) => {
  const reg = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'reg.exe')
  execFile(reg, ['query', 'HKCU\\Software\\Microsoft\\Multimedia\\Audio', '/v', 'UserDuckingPreference'], { windowsHide: true }, (err, stdout) => {
    const value = /UserDuckingPreference\s+REG_DWORD\s+0x([0-9a-f]+)/i.exec(stdout || '')
    // Missing means it was never changed: Windows' default, 80%
    if (!value) return resolve(err?.code === 1 ? 'reduce80' : 'unknown')
    resolve(['mute', 'reduce80', 'reduce50', 'off'][parseInt(value[1], 16)] ?? 'unknown')
  })
}))

// Opens the classic Sound control panel on its Communications tab
ipcMain.handle('system:openSoundSettings', () => {
  spawn(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'control.exe'), ['mmsys.cpl,,3'], { detached: true, stdio: 'ignore' }).unref()
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
        { role: 'close' },
        { type: 'separator' },
        closeToTrayMenuItem(),
        { label: 'Quit EZ Soundboard', click: quitApp }
      ]
    },
    {
      label: 'Help',
      submenu: [
        {
          label: 'Check for Updates…',
          click: () => checkForUpdates()
        },
        {
          // For support: the user pastes this wherever they're asking for help
          label: 'Copy Diagnostic Info',
          click: () => {
            clipboard.writeText(diagnosticInfo())
            mainWindow?.webContents.send('show-info', 'Diagnostic info copied — paste it into your message')
          }
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
  // e.g. opened from the Start menu while it's in the tray: bring the window back
  app.on('second-instance', showWindow)

  app.whenReady().then(() => {
    ensureDirectories()
    readAppSettings()
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
