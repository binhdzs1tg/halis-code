import { app, BrowserWindow, dialog, shell } from 'electron'
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
import * as sessions from './sessions'
import { cancelRun, startRun, compactNow } from './agent/run'
import { resolveApproval } from './agent/approval'
import { shellSettings, updateShellSettings } from './settings'
import fs from 'node:fs'

function senderWindow(event: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent): BrowserWindow | null {
  return BrowserWindow.fromWebContents(event.sender)
}

/**
 * Guard every channel against calls from foreign frames: only the main frame
 * of a window this process created may invoke shell APIs. Subframes, guest
 * pages and windows Electron created for other reasons are all rejected, the
 * same way DeepSeek Harness desktop validates its senders.
 */
function assertMainSender(event: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent): void {
  if (!senderWindow(event)) {
    throw new Error('ipc: sender is not an app window')
  }
  const frame = event.senderFrame
  if (frame && frame.parent !== null) {
    throw new Error('ipc: sender is not the main frame')
  }
}

/** `ipcMain.handle` with the main-frame sender check folded in. */
function handle<T>(channel: IpcChannel, fn: (event: Electron.IpcMainInvokeEvent, ...args: any[]) => T): void {
  handle(channel, (event, ...args) => {
    assertMainSender(event)
    return fn(event, ...args)
  })
}

/** `ipcMain.on` with the same check, for the fire-and-forget window controls. */
function on(channel: IpcChannel, fn: (event: Electron.IpcMainEvent, ...args: any[]) => void): void {
  on(channel, (event, ...args) => {
    assertMainSender(event)
    fn(event, ...args)
  })
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
  handle(IpcChannel.AppInfo, (): AppInfo => ({
    name: 'halis-code',
    version: app.getVersion(),
    electron: process.versions.electron ?? 'unknown',
    platform: process.platform
  }))

  on(IpcChannel.WindowMinimize, (event) => {
    senderWindow(event)?.minimize()
  })

  on(IpcChannel.WindowMaximize, (event) => {
    const win = senderWindow(event)
    if (!win) return
    if (win.isMaximized()) {
      win.unmaximize()
    } else {
      win.maximize()
    }
  })

  on(IpcChannel.WindowClose, (event) => {
    senderWindow(event)?.close()
  })

  handle(IpcChannel.WorkspacePick, async (event): Promise<string | null> => {
    const win = senderWindow(event)
    const result = win
      ? await dialog.showOpenDialog(win, {
          title: 'Open workspace folder',
          properties: ['openDirectory']
        })
      : await dialog.showOpenDialog({ title: 'Open workspace folder', properties: ['openDirectory'] })
    if (result.canceled) return null
    const picked = result.filePaths[0]
    return picked ? openWorkspaceByPath(picked) : null
  })

  handle(IpcChannel.WorkspaceOpen, (_event, absolutePath: string): string | null => {
    return openWorkspaceByPath(absolutePath)
  })

  handle(IpcChannel.WorkspaceReadDir, (_event, relPath: string): WorkspaceEntry[] => {
    return listDir(relPath)
  })

  handle(IpcChannel.FileRead, (_event, relPath: string): string => {
    return readFileContent(relPath)
  })

  handle(IpcChannel.FileWrite, (event, relPath: unknown, content: unknown): void => {
    if (typeof relPath !== 'string' || typeof content !== 'string') {
      throw new Error('file:write expects (path, content) strings')
    }
    writeFileContent(relPath, content)
    emitChanged(event, { path: relPath, change: 'write' })
  })

  handle(IpcChannel.FileCreate, (event, relPath: unknown, kind: unknown): void => {
    if (typeof relPath !== 'string' || (kind !== 'file' && kind !== 'directory')) {
      throw new Error('file:create expects (path, kind) with kind "file" | "directory"')
    }
    createEntry(relPath, kind as WorkspaceEntryKind)
    emitChanged(event, { path: relPath, change: 'create' })
  })

  handle(IpcChannel.FileRename, (event, from: unknown, to: unknown): void => {
    if (typeof from !== 'string' || typeof to !== 'string') {
      throw new Error('file:rename expects (from, to) strings')
    }
    renameEntry(from, to)
    emitChanged(event, { path: to, from, change: 'rename' })
  })

  handle(IpcChannel.FileDelete, async (event, relPath: unknown): Promise<void> => {
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

  handle(IpcChannel.WorkspaceSearch, (_event, query: unknown, options: unknown) => {
    if (typeof query !== 'string') {
      throw new Error('workspace:search expects a query string')
    }
    const opts = (typeof options === 'object' && options !== null ? options : {}) as {
      scope?: unknown
      caseSensitive?: unknown
    }
    return searchWorkspace(query, {
      ...(typeof opts.scope === 'string' ? { scope: opts.scope } : {}),
      caseSensitive: opts.caseSensitive === true
    })
  })

  handle(IpcChannel.TerminalRun, (event, command: unknown): string => {
    if (typeof command !== 'string' || command.trim().length === 0) {
      throw new Error('terminal:run expects a command string')
    }
    return terminal.run(command, senderWindow(event))
  })

  handle(IpcChannel.TerminalKill, () => {
    return terminal.kill()
  })

  handle(IpcChannel.ModelsList, () => {
    return modelsCatalog.list()
  })

  handle(IpcChannel.ModelsRefresh, () => {
    return modelsCatalog.refresh(true)
  })

  handle(IpcChannel.ChatSend, (event, request: unknown) => {
    return startRun(request, senderWindow(event))
  })

  handle(IpcChannel.ChatCancel, (_event, runId: unknown) => {
    if (typeof runId === 'string') {
      cancelRun(runId)
    }
  })

  handle(IpcChannel.ChatCompact, async (_event, request: unknown) => {
    return await compactNow(request)
  })

  on(IpcChannel.ApprovalRespond, (_event, requestId: unknown, decision: unknown) => {
    resolveApproval(requestId, decision)
  })

  handle(IpcChannel.SettingsGet, () => {
    return { commandApproval: shellSettings().commandApproval }
  })

  handle(IpcChannel.SettingsSet, (_event, patch: unknown) => {
    if (typeof patch !== 'object' || patch === null) {
      throw new Error('settings:set expects an object')
    }
    const candidate = patch as { commandApproval?: unknown }
    if (candidate.commandApproval !== undefined && candidate.commandApproval !== 'ask' && candidate.commandApproval !== 'fullAccess') {
      throw new Error('settings:set: commandApproval must be "ask" or "fullAccess"')
    }
    const settingsPatch =
      candidate.commandApproval === undefined
        ? {}
        : { commandApproval: candidate.commandApproval as 'ask' | 'fullAccess' }
    return {
      commandApproval: updateShellSettings(settingsPatch).commandApproval
    }
  })

  handle(IpcChannel.ConversationExport, async (event, suggestedName: unknown, content: unknown) => {
    if (typeof suggestedName !== 'string' || typeof content !== 'string') {
      throw new Error('conversation:export expects (name, content) strings')
    }
    const win = senderWindow(event)
    const result = win
      ? await dialog.showSaveDialog(win, {
          title: 'Export conversation',
          defaultPath: suggestedName,
          filters: [{ name: 'Markdown', extensions: ['md'] }]
        })
      : await dialog.showSaveDialog({
          title: 'Export conversation',
          defaultPath: suggestedName,
          filters: [{ name: 'Markdown', extensions: ['md'] }]
        })
    if (result.canceled || !result.filePath) {
      return null
    }
    fs.writeFileSync(result.filePath, content, 'utf8')
    return result.filePath
  })

  handle(IpcChannel.KeysStatus, async () => {
    const { providers } = await modelsCatalog.list()
    return keyStore.statuses(providers)
  })

  handle(IpcChannel.KeysSet, async (_event, providerId: unknown, value: unknown) => {
    if (typeof providerId !== 'string' || typeof value !== 'string') {
      throw new Error('keys:set expects (providerId, value) strings')
    }
    await keyStore.set(providerId, value)
    const { providers } = await modelsCatalog.list()
    return keyStore.statuses(providers)
  })

  handle(IpcChannel.KeysRemove, async (_event, providerId: unknown) => {
    if (typeof providerId !== 'string') {
      throw new Error('keys:remove expects a providerId string')
    }
    await keyStore.remove(providerId)
    const { providers } = await modelsCatalog.list()
    return keyStore.statuses(providers)
  })

  handle(IpcChannel.SessionsList, () => {
    return sessions.listSessions()
  })

  handle(IpcChannel.SessionsLoad, (_event, id: unknown) => {
    return sessions.loadSession(id)
  })

  handle(IpcChannel.SessionsSave, (_event, session: unknown) => {
    return sessions.saveSession(session)
  })

  handle(IpcChannel.SessionsDelete, (_event, id: unknown) => {
    sessions.deleteSession(id)
  })
}
