import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import { IpcChannel } from '../shared/ipc-channels'
import type { AppInfo, WorkspaceEntry } from '../shared/types'
import {
  listDir,
  openWorkspaceByPath,
  readFileContent
} from './workspace'
import * as modelsCatalog from './models-dev/catalog'
import * as keyStore from './keys/store'
import { cancelRun, startRun } from './agent/run'

function senderWindow(event: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent): BrowserWindow | null {
  return BrowserWindow.fromWebContents(event.sender)
}

export function registerIpcHandlers(): void {
  ipcMain.handle(IpcChannel.AppInfo, (): AppInfo => ({
    name: 'halis-code',
    version: app.getVersion(),
    electron: process.versions.electron ?? 'unknown',
    platform: process.platform
  }))

  ipcMain.on(IpcChannel.WindowMinimize, (event) => {
    senderWindow(event)?.minimize()
  })

  ipcMain.on(IpcChannel.WindowMaximize, (event) => {
    const win = senderWindow(event)
    if (!win) return
    if (win.isMaximized()) {
      win.unmaximize()
    } else {
      win.maximize()
    }
  })

  ipcMain.on(IpcChannel.WindowClose, (event) => {
    senderWindow(event)?.close()
  })

  ipcMain.handle(IpcChannel.WorkspacePick, async (event): Promise<string | null> => {
    const win = senderWindow(event)
    const result = win
      ? await dialog.showOpenDialog(win, {
          title: 'Open workspace folder',
          properties: ['openDirectory']
        })
      : await dialog.showOpenDialog({ title: 'Open workspace folder', properties: ['openDirectory'] })
    if (result.canceled || result.filePaths.length === 0) {
      return null
    }
    return openWorkspaceByPath(result.filePaths[0])
  })

  ipcMain.handle(IpcChannel.WorkspaceOpen, (_event, absolutePath: string): string | null => {
    return openWorkspaceByPath(absolutePath)
  })

  ipcMain.handle(IpcChannel.WorkspaceReadDir, (_event, relPath: string): WorkspaceEntry[] => {
    return listDir(relPath)
  })

  ipcMain.handle(IpcChannel.FileRead, (_event, relPath: string): string => {
    return readFileContent(relPath)
  })

  ipcMain.handle(IpcChannel.ModelsList, () => {
    return modelsCatalog.list()
  })

  ipcMain.handle(IpcChannel.ModelsRefresh, () => {
    return modelsCatalog.refresh(true)
  })

  ipcMain.handle(IpcChannel.ChatSend, (event, request: unknown) => {
    return startRun(request, senderWindow(event))
  })

  ipcMain.handle(IpcChannel.ChatCancel, (_event, runId: unknown) => {
    if (typeof runId === 'string') {
      cancelRun(runId)
    }
  })

  ipcMain.handle(IpcChannel.KeysStatus, async () => {
    const { providers } = await modelsCatalog.list()
    return keyStore.statuses(providers)
  })

  ipcMain.handle(IpcChannel.KeysSet, async (_event, providerId: unknown, value: unknown) => {
    if (typeof providerId !== 'string' || typeof value !== 'string') {
      throw new Error('keys:set expects (providerId, value) strings')
    }
    await keyStore.set(providerId, value)
    const { providers } = await modelsCatalog.list()
    return keyStore.statuses(providers)
  })

  ipcMain.handle(IpcChannel.KeysRemove, async (_event, providerId: unknown) => {
    if (typeof providerId !== 'string') {
      throw new Error('keys:remove expects a providerId string')
    }
    await keyStore.remove(providerId)
    const { providers } = await modelsCatalog.list()
    return keyStore.statuses(providers)
  })
}
