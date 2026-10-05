const { autoUpdater } = require('electron-updater')
const { app, ipcMain } = require('electron')

let mainWindow = null
// Only user-requested checks (and downloads) report "checking", "up to date" and errors;
// the automatic startup check stays quiet unless an update is available
let userRequested = false

function isDev() {
  return !app.isPackaged
}

function initUpdater(win) {
  mainWindow = win

  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = true

  autoUpdater.on('checking-for-update', () => {
    if (userRequested) sendStatus('checking')
  })

  autoUpdater.on('update-available', (info) => {
    sendStatus('available', { version: info.version })
  })

  autoUpdater.on('update-not-available', () => {
    if (userRequested) sendStatus('not-available')
  })

  autoUpdater.on('download-progress', (progress) => {
    sendStatus('downloading', { percent: Math.round(progress.percent) })
  })

  autoUpdater.on('update-downloaded', () => {
    sendStatus('downloaded')
  })

  autoUpdater.on('error', (err) => {
    if (userRequested) sendStatus('error', { message: err.message })
  })

  ipcMain.handle('updater:check', () => {
    checkForUpdates()
  })

  ipcMain.handle('updater:download', () => {
    userRequested = true
    // Failures arrive through the 'error' event
    autoUpdater.downloadUpdate().catch(() => {})
  })

  ipcMain.handle('updater:install', () => {
    autoUpdater.quitAndInstall()
  })

  // Check once the UI is ready to show the update bar
  if (!isDev()) {
    win.webContents.once('did-finish-load', () => checkForUpdates({ silent: true }))
  }
}

function sendStatus(status, data = {}) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('updater:status', { status, ...data })
  }
}

function checkForUpdates({ silent = false } = {}) {
  userRequested = !silent
  if (isDev()) {
    sendStatus('checking')
    setTimeout(() => {
      sendStatus('not-available')
    }, 1000)
    return
  }
  // Failures arrive through the 'error' event
  autoUpdater.checkForUpdates()?.catch(() => {})
}

module.exports = { initUpdater, checkForUpdates }
