const { contextBridge, ipcRenderer, webUtils } = require('electron')

contextBridge.exposeInMainWorld('api', {
  getPathForFile: (file) => webUtils.getPathForFile(file),
  selectFolder: () => ipcRenderer.invoke('dialog:openFolder'),
  selectFile: () => ipcRenderer.invoke('dialog:openFile'),
  readConfig: () => ipcRenderer.invoke('config:read'),
  writeConfig: (config) => ipcRenderer.invoke('config:write', config),
  getStartupNotice: () => ipcRenderer.invoke('config:startupNotice'),
  showInFolder: (filePath) => ipcRenderer.invoke('shell:showInFolder', filePath),
  onOpenHelpModal: (cb) => ipcRenderer.on('open-help-modal', cb),
  onShowInfo: (cb) => ipcRenderer.on('show-info', (_, message) => cb(message)),
  openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),
  statMedia: (filePath) => ipcRenderer.invoke('media:stat', filePath),
  readMedia: (filePath) => ipcRenderer.invoke('media:read', filePath),
  getCallDucking: () => ipcRenderer.invoke('system:callDucking'),
  openSoundSettings: () => ipcRenderer.invoke('system:openSoundSettings'),
  setGlobalHotkeys: (hotkeys) => ipcRenderer.invoke('hotkeys:set', hotkeys),
  onGlobalHotkey: (cb) => ipcRenderer.on('hotkeys:triggered', (_, shortcut) => cb(shortcut)),
  updaterCheck: () => ipcRenderer.invoke('updater:check'),
  updaterDownload: () => ipcRenderer.invoke('updater:download'),
  updaterInstall: () => ipcRenderer.invoke('updater:install'),
  onUpdaterStatus: (cb) => ipcRenderer.on('updater:status', (_, data) => cb(data))
})
