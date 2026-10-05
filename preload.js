const { contextBridge, ipcRenderer, webUtils } = require('electron')

contextBridge.exposeInMainWorld('api', {
  getPathForFile: (file) => webUtils.getPathForFile(file),
  selectFolder: () => ipcRenderer.invoke('dialog:openFolder'),
  selectFile: () => ipcRenderer.invoke('dialog:openFile'),
  readConfig: () => ipcRenderer.invoke('config:read'),
  writeConfig: (config) => ipcRenderer.invoke('config:write', config),
  getDataPath: () => ipcRenderer.invoke('config:getDataPath'),
  deleteFile: (filePath) => ipcRenderer.invoke('tile:delete', filePath),
  showInFolder: (filePath) => ipcRenderer.invoke('shell:showInFolder', filePath),
  onOpenHelpModal: (cb) => ipcRenderer.on('open-help-modal', cb),
  openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),
  setGlobalHotkeys: (hotkeys) => ipcRenderer.invoke('hotkeys:set', hotkeys),
  onGlobalHotkey: (cb) => ipcRenderer.on('hotkeys:triggered', (_, shortcut) => cb(shortcut)),
  updaterCheck: () => ipcRenderer.invoke('updater:check'),
  updaterDownload: () => ipcRenderer.invoke('updater:download'),
  updaterInstall: () => ipcRenderer.invoke('updater:install'),
  onUpdaterStatus: (cb) => ipcRenderer.on('updater:status', (_, data) => cb(data))
})
