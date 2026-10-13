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
  readFile: (relPath) => ipcRenderer.invoke(IpcChannel.FileRead, relPath)
}

contextBridge.exposeInMainWorld('halis', api)
