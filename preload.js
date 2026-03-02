const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('api', {
  selectFolder: () => ipcRenderer.invoke('dialog:openFolder'),
  selectFile: () => ipcRenderer.invoke('dialog:openFile'),
  readConfig: () => ipcRenderer.invoke('config:read'),
  writeConfig: (config) => ipcRenderer.invoke('config:write', config),
  getDataPath: () => ipcRenderer.invoke('config:getDataPath'),
  deleteFile: (filePath) => ipcRenderer.invoke('tile:delete', filePath),
  showInFolder: (filePath) => ipcRenderer.invoke('shell:showInFolder', filePath),
  onOpenHelpModal: (cb) => ipcRenderer.on('open-help-modal', cb)
})
