import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import { IpcChannel } from '../shared/ipc-channels'
import type { AppInfo, WorkspaceEntry } from '../shared/types'
import {
  listDir,
  openWorkspaceByPath,
  readFileContent
} from './workspace'

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
}
