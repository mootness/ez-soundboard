const { autoUpdater } = require('electron-updater')
const { app, ipcMain } = require('electron')

let mainWindow = null

function isDev() {
  return !app.isPackaged
}

function initUpdater(win) {
  mainWindow = win

  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = true

  autoUpdater.on('checking-for-update', () => {
    sendStatus('checking')
  })

  autoUpdater.on('update-available', (info) => {
    sendStatus('available', { version: info.version })
  })

  autoUpdater.on('update-not-available', () => {
    sendStatus('not-available')
  })

  autoUpdater.on('download-progress', (progress) => {
    sendStatus('downloading', { percent: Math.round(progress.percent) })
  })

  autoUpdater.on('update-downloaded', () => {
    sendStatus('downloaded')
  })

  autoUpdater.on('error', (err) => {
    sendStatus('error', { message: err.message })
  })

  ipcMain.handle('updater:check', () => {
    checkForUpdates()
  })

  ipcMain.handle('updater:download', () => {
    autoUpdater.downloadUpdate()
  })

  ipcMain.handle('updater:install', () => {
    autoUpdater.quitAndInstall()
  })
}

function sendStatus(status, data = {}) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('updater:status', { status, ...data })
  }
}

function checkForUpdates() {
  if (isDev()) {
    sendStatus('checking')
    setTimeout(() => {
      sendStatus('not-available')
    }, 1000)
    return
  }
  autoUpdater.checkForUpdates()
}

module.exports = { initUpdater, checkForUpdates }
