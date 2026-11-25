const { autoUpdater } = require('electron-updater')
const { app, ipcMain } = require('electron')
const { spawn, execFile } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')

// Both live in userData, which is the same folder before and after an update
const LOG_PATH = path.join(app.getPath('userData'), 'updater.log')
const PENDING_PATH = path.join(app.getPath('userData'), 'update-pending.json')
const LOG_MAX_CHARS = 200000

// A download that finishes this fast is installed straight away — the user is still looking at
// the button they clicked. After a slower one they're asked first, so the app doesn't close
// under them while they're using it.
const QUICK_DOWNLOAD_MS = 20000

let mainWindow = null
// Only user-requested checks (and downloads) report "checking", "up to date" and errors;
// the automatic startup check stays quiet unless an update is available
let userRequested = false
let downloadStartedAt = 0 // non-zero while a download is in progress
let downloaded = null     // { file, version } once an update is ready to install
let installing = false
// 'on' | 'evaluation' | 'off' | 'unknown'. When it's on, Windows refuses to run an installer
// that isn't code-signed, with no "Run anyway", so a failed update gets its own explanation.
let smartAppControl = 'unknown'

function isDev() {
  return !app.isPackaged
}

// The value Windows Security's own Smart App Control page reflects: 0 off, 1 on, 2 evaluation
function parseSmartAppControl(regOutput) {
  const value = /VerifiedAndReputablePolicyState\s+REG_DWORD\s+0x([0-9a-f]+)/i.exec(regOutput || '')
  return value ? (['off', 'on', 'evaluation'][parseInt(value[1], 16)] ?? 'unknown') : 'unknown'
}

// Resolves once smartAppControl is set; never rejects
function readSmartAppControl() {
  return new Promise((resolve) => {
    const reg = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'reg.exe')
    const args = ['query', 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\CI\\Policy', '/v', 'VerifiedAndReputablePolicyState']
    execFile(reg, args, { windowsHide: true }, (err, stdout) => {
      smartAppControl = parseSmartAppControl(stdout)
      log('info', `Smart App Control: ${smartAppControl}`)
      resolve()
    })
  })
}

// The updater's messages used to go to a console nobody sees. They're kept in a file so a failed
// update on someone else's PC can be diagnosed (Help > Copy Diagnostic Info).
function log(level, ...parts) {
  const text = parts
    .map(p => (p instanceof Error ? `${p.message} [${p.code ?? 'no code'}]` : typeof p === 'string' ? p : JSON.stringify(p)))
    .join(' ')
  try {
    fs.appendFileSync(LOG_PATH, `${new Date().toISOString()} ${level} ${text.slice(0, 600)}\n`)
  } catch (e) {
    console.error('Failed to write updater log:', e)
  }
}

function startLog() {
  try {
    const text = fs.readFileSync(LOG_PATH, 'utf-8')
    if (text.length > LOG_MAX_CHARS) fs.writeFileSync(LOG_PATH, text.slice(-LOG_MAX_CHARS / 4))
  } catch {
    // no log yet
  }
  const relaunched = process.argv.includes('--updated') ? ' (reopened by the installer)' : ''
  log('info', `--- EZ Soundboard ${app.getVersion()} started${relaunched}`)
}

// Written just before the app closes to install an update and read on the next launch, so an
// update that never installed is reported instead of silently leaving the old version in place
function readPendingUpdate() {
  try {
    return JSON.parse(fs.readFileSync(PENDING_PATH, 'utf-8'))
  } catch {
    return null
  }
}

// Tells the user how the last update attempt ended. Returns true if it failed.
function reportLastUpdate() {
  const pending = readPendingUpdate()
  fs.rmSync(PENDING_PATH, { force: true })
  const current = app.getVersion()

  if (pending?.from === current) {
    log('error', `the update to ${pending.version} did not install; still on ${current}`)
    sendStatus('install-failed', { version: pending.version, smartAppControl: smartAppControl === 'on' })
    return true
  }
  // The installer passes --updated when it reopens the app, including after an update that
  // was started by an older version that left no record
  if (pending || process.argv.includes('--updated')) {
    sendStatus('updated', { version: current })
  }
  return false
}

// Starts the downloaded installer and closes the app only once it is really running.
// electron-updater's own quitAndInstall() quits regardless: when Windows refuses to start the
// installer (antivirus, a security policy) it either gives up or retries through a UAC prompt,
// and the user is left with a closed app and no explanation.
function installUpdate() {
  if (installing || !downloaded) return
  installing = true
  const { file, version } = downloaded
  sendStatus('installing', { version })

  const failed = (err) => {
    installing = false
    fs.rmSync(PENDING_PATH, { force: true })
    log('error', `could not start the installer ${file}:`, err)
    sendStatus('install-failed', { version, reason: err.code || err.message, smartAppControl: smartAppControl === 'on' })
  }

  try {
    fs.writeFileSync(PENDING_PATH, JSON.stringify({ version, from: app.getVersion() }))
    // --updated: keep shortcuts as they are and don't ask to close the app;
    // --force-run: reopen the app when the install is done
    const installer = spawn(file, ['--updated', '--force-run'], { detached: true, stdio: 'ignore' })
    installer.once('error', failed)
    installer.once('spawn', () => {
      installer.unref()
      log('info', `installer started (pid ${installer.pid}); closing ${app.getVersion()} to install ${version}`)
      app.quit()
    })
  } catch (err) {
    failed(err) // Windows can refuse outright, e.g. EPERM when running the file is blocked
  }
}

function initUpdater(win) {
  mainWindow = win
  startLog()
  const smartAppControlRead = readSmartAppControl()

  autoUpdater.logger = {
    info: (message) => log('info', message),
    warn: (message) => log('warn', message),
    error: (message) => log('error', message)
  }
  autoUpdater.autoDownload = false
  // Installing happens only through installUpdate(), never behind the user's back on quit
  autoUpdater.autoInstallOnAppQuit = false
  autoUpdater.disableWebInstaller = true // only the full installer is published

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

  autoUpdater.on('update-downloaded', (info) => {
    const tookMs = Date.now() - downloadStartedAt
    downloadStartedAt = 0
    downloaded = { file: info.downloadedFile, version: info.version }
    if (tookMs < QUICK_DOWNLOAD_MS) installUpdate()
    else sendStatus('downloaded', { version: info.version })
  })

  autoUpdater.on('error', (err) => {
    if (downloadStartedAt) {
      downloadStartedAt = 0
      sendStatus('download-failed', { message: err.message })
    } else if (userRequested) {
      sendStatus('error', { message: err.message })
    }
  })

  ipcMain.handle('updater:check', () => {
    checkForUpdates()
  })

  ipcMain.handle('updater:download', () => {
    if (downloadStartedAt) return
    userRequested = true
    downloadStartedAt = Date.now()
    // Failures arrive through the 'error' event
    autoUpdater.downloadUpdate().catch(() => {})
  })

  ipcMain.handle('updater:install', () => {
    installUpdate()
  })

  if (!isDev()) {
    // Once the UI can show the update bar: say how the last update went, then look for a new one
    win.webContents.once('did-finish-load', async () => {
      await smartAppControlRead // the report's wording depends on it
      const lastUpdateFailed = reportLastUpdate()
      // After a failed install, leave its message (and manual download link) on screen instead
      // of replacing it at once with the same "update available" offer
      if (!lastUpdateFailed) checkForUpdates({ silent: true })
    })
  }
}

function sendStatus(status, data = {}) {
  if (status !== 'downloading') log('info', `shown to user: ${status}`, data)
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

// What someone helping with a problem needs to see, without the Windows user name in it
function diagnosticInfo() {
  let recentLog = '(nothing logged yet)'
  try {
    recentLog = fs.readFileSync(LOG_PATH, 'utf-8').trim().split('\n').slice(-60).join('\n')
  } catch {
    // no log yet
  }
  const info = [
    `EZ Soundboard ${app.getVersion()} (Electron ${process.versions.electron}, ${process.arch})`,
    `Windows ${os.release()}`,
    `Smart App Control: ${smartAppControl}`,
    `Installed in: ${path.dirname(app.getPath('exe'))}`,
    '',
    'Update log:',
    recentLog
  ].join('\n')
  return info.split(os.homedir()).join('%USERPROFILE%')
}

module.exports = { initUpdater, checkForUpdates, diagnosticInfo }
