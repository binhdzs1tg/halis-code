import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { IpcChannel } from '../shared/ipc-channels'
import type { AppInfo, WorkspaceEntry, WorkspaceEntryKind } from '../shared/types'
import {
  createEntry,
  listDir,
  openWorkspaceByPath,
  readFileContent,
  renameEntry,
  resolveForDelete,
  searchWorkspace,
  writeFileContent
} from './workspace'
import * as modelsCatalog from './models-dev/catalog'
import * as keyStore from './keys/store'
import * as terminal from './terminal'
import { cancelRun, startRun } from './agent/run'

function senderWindow(event: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent): BrowserWindow | null {
  return BrowserWindow.fromWebContents(event.sender)
}

function emitChanged(
  event: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent,
  payload: { path: string; change: 'write' | 'create' | 'rename' | 'delete'; from?: string }
): void {
  const win = senderWindow(event)
  if (win && !win.isDestroyed()) {
    win.webContents.send(IpcChannel.WorkspaceChanged, payload)
  }
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

  ipcMain.handle(IpcChannel.FileWrite, (event, relPath: unknown, content: unknown): void => {
    if (typeof relPath !== 'string' || typeof content !== 'string') {
      throw new Error('file:write expects (path, content) strings')
    }
    writeFileContent(relPath, content)
    emitChanged(event, { path: relPath, change: 'write' })
  })

  ipcMain.handle(IpcChannel.FileCreate, (event, relPath: unknown, kind: unknown): void => {
    if (typeof relPath !== 'string' || (kind !== 'file' && kind !== 'directory')) {
      throw new Error('file:create expects (path, kind) with kind "file" | "directory"')
    }
    createEntry(relPath, kind as WorkspaceEntryKind)
    emitChanged(event, { path: relPath, change: 'create' })
  })

  ipcMain.handle(IpcChannel.FileRename, (event, from: unknown, to: unknown): void => {
    if (typeof from !== 'string' || typeof to !== 'string') {
      throw new Error('file:rename expects (from, to) strings')
    }
    renameEntry(from, to)
    emitChanged(event, { path: to, from, change: 'rename' })
  })

  ipcMain.handle(IpcChannel.FileDelete, async (event, relPath: unknown): Promise<void> => {
    if (typeof relPath !== 'string') {
      throw new Error('file:delete expects a path string')
    }
    const absolute = resolveForDelete(relPath)
    // Move to the OS trash so a slip of the hand is recoverable.
    const trashed = await shell.trashItem(absolute).catch(() => false)
    if (!trashed) {
      throw new Error(`Could not move "${relPath}" to the trash`)
    }
    emitChanged(event, { path: relPath, change: 'delete' })
  })

  ipcMain.handle(IpcChannel.WorkspaceSearch, (_event, query: unknown, options: unknown) => {
    if (typeof query !== 'string') {
      throw new Error('workspace:search expects a query string')
    }
    const opts = (typeof options === 'object' && options !== null ? options : {}) as {
      scope?: unknown
      caseSensitive?: unknown
    }
    return searchWorkspace(query, {
      scope: typeof opts.scope === 'string' ? opts.scope : undefined,
      caseSensitive: opts.caseSensitive === true
    })
  })

  ipcMain.handle(IpcChannel.TerminalRun, (event, command: unknown): string => {
    if (typeof command !== 'string' || command.trim().length === 0) {
      throw new Error('terminal:run expects a command string')
    }
    return terminal.run(command, senderWindow(event))
  })

  ipcMain.handle(IpcChannel.TerminalKill, () => {
    return terminal.kill()
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
