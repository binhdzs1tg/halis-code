import { contextBridge, ipcRenderer } from 'electron'
import { IpcChannel } from '../shared/ipc-channels'
import type { HalisApi } from '../shared/api'

const api: HalisApi = {
  getInfo: () => ipcRenderer.invoke(IpcChannel.AppInfo),

  minimize: () => ipcRenderer.send(IpcChannel.WindowMinimize),
  maximize: () => ipcRenderer.send(IpcChannel.WindowMaximize),
  close: () => ipcRenderer.send(IpcChannel.WindowClose),

  pickWorkspace: () => ipcRenderer.invoke(IpcChannel.WorkspacePick),
  openWorkspace: (absolutePath) => ipcRenderer.invoke(IpcChannel.WorkspaceOpen, absolutePath),
  readDir: (relPath) => ipcRenderer.invoke(IpcChannel.WorkspaceReadDir, relPath),
  readFile: (relPath) => ipcRenderer.invoke(IpcChannel.FileRead, relPath),

  getModels: () => ipcRenderer.invoke(IpcChannel.ModelsList),
  refreshModels: () => ipcRenderer.invoke(IpcChannel.ModelsRefresh),
  onModelsUpdated: (listener) => {
    const handler = (): void => listener()
    ipcRenderer.on(IpcChannel.ModelsUpdated, handler)
    return () => {
      ipcRenderer.off(IpcChannel.ModelsUpdated, handler)
    }
  },

  getKeyStatuses: () => ipcRenderer.invoke(IpcChannel.KeysStatus),
  setProviderKey: (providerId, value) => ipcRenderer.invoke(IpcChannel.KeysSet, providerId, value),
  removeProviderKey: (providerId) => ipcRenderer.invoke(IpcChannel.KeysRemove, providerId),
  onKeysChanged: (listener) => {
    const handler = (): void => listener()
    ipcRenderer.on(IpcChannel.KeysChanged, handler)
    return () => {
      ipcRenderer.off(IpcChannel.KeysChanged, handler)
    }
  }
}

contextBridge.exposeInMainWorld('halis', api)
