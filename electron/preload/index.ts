import { contextBridge, ipcRenderer } from 'electron'
import { IpcChannel } from '../shared/ipc-channels'
import type {
  ApprovalDecision,
  ApprovalRequestEvent,
  ChatDeltaEvent,
  ChatDoneEvent,
  ChatErrorEvent,
  ChatNoticeEvent,
  ChatToolEvent,
  JobNoticeEvent,
  TerminalDataEvent,
  TerminalExitEvent,
  TodoUpdatedEvent,
  UserQuestionAnswers,
  UserQuestionRequestEvent,
  WorkspaceChangedEvent
} from '../shared/types'
import type { HalisApi } from '../shared/api'

const api: HalisApi = {
  getInfo: () => ipcRenderer.invoke(IpcChannel.AppInfo),

  minimize: () => ipcRenderer.send(IpcChannel.WindowMinimize),
  maximize: () => ipcRenderer.send(IpcChannel.WindowMaximize),
  close: () => ipcRenderer.send(IpcChannel.WindowClose),
  onWindowState: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, maximized: boolean): void =>
      listener(maximized)
    ipcRenderer.on(IpcChannel.WindowState, handler)
    return () => {
      ipcRenderer.off(IpcChannel.WindowState, handler)
    }
  },

  pickWorkspace: () => ipcRenderer.invoke(IpcChannel.WorkspacePick),
  openWorkspace: (absolutePath) => ipcRenderer.invoke(IpcChannel.WorkspaceOpen, absolutePath),
  readDir: (relPath) => ipcRenderer.invoke(IpcChannel.WorkspaceReadDir, relPath),
  readFile: (relPath) => ipcRenderer.invoke(IpcChannel.FileRead, relPath),
  writeFile: (relPath, content) => ipcRenderer.invoke(IpcChannel.FileWrite, relPath, content),
  createEntry: (relPath, kind) => ipcRenderer.invoke(IpcChannel.FileCreate, relPath, kind),
  renameEntry: (from, to) => ipcRenderer.invoke(IpcChannel.FileRename, from, to),
  deleteEntry: (relPath) => ipcRenderer.invoke(IpcChannel.FileDelete, relPath),
  searchWorkspace: (query, options) =>
    ipcRenderer.invoke(IpcChannel.WorkspaceSearch, query, options ?? {}),

  runTerminalCommand: (command) => ipcRenderer.invoke(IpcChannel.TerminalRun, command),
  killTerminalCommand: () => ipcRenderer.invoke(IpcChannel.TerminalKill),
  onTerminalData: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: TerminalDataEvent): void =>
      listener(payload)
    ipcRenderer.on(IpcChannel.TerminalData, handler)
    return () => {
      ipcRenderer.off(IpcChannel.TerminalData, handler)
    }
  },
  onTerminalExit: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: TerminalExitEvent): void =>
      listener(payload)
    ipcRenderer.on(IpcChannel.TerminalExit, handler)
    return () => {
      ipcRenderer.off(IpcChannel.TerminalExit, handler)
    }
  },

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

  listSessions: () => ipcRenderer.invoke(IpcChannel.SessionsList),
  loadSession: (id) => ipcRenderer.invoke(IpcChannel.SessionsLoad, id),
  saveSession: (session) => ipcRenderer.invoke(IpcChannel.SessionsSave, session),
  generateSessionTitle: (request) => ipcRenderer.invoke(IpcChannel.SessionTitle, request),
  deleteSession: (id) => ipcRenderer.invoke(IpcChannel.SessionsDelete, id),
  onKeysChanged: (listener) => {
    const handler = (): void => listener()
    ipcRenderer.on(IpcChannel.KeysChanged, handler)
    return () => {
      ipcRenderer.off(IpcChannel.KeysChanged, handler)
    }
  },

  sendChat: (request) => ipcRenderer.invoke(IpcChannel.ChatSend, request),
  cancelChat: (runId) => {
    void ipcRenderer.invoke(IpcChannel.ChatCancel, runId)
  },
  compactConversation: (request) => ipcRenderer.invoke(IpcChannel.ChatCompact, request),
  onChatDelta: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: ChatDeltaEvent): void => listener(payload)
    ipcRenderer.on(IpcChannel.ChatDelta, handler)
    return () => {
      ipcRenderer.off(IpcChannel.ChatDelta, handler)
    }
  },
  onChatDone: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: ChatDoneEvent): void => listener(payload)
    ipcRenderer.on(IpcChannel.ChatDone, handler)
    return () => {
      ipcRenderer.off(IpcChannel.ChatDone, handler)
    }
  },
  onChatError: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: ChatErrorEvent): void => listener(payload)
    ipcRenderer.on(IpcChannel.ChatError, handler)
    return () => {
      ipcRenderer.off(IpcChannel.ChatError, handler)
    }
  },
  onChatTool: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: ChatToolEvent): void => listener(payload)
    ipcRenderer.on(IpcChannel.ChatTool, handler)
    return () => {
      ipcRenderer.off(IpcChannel.ChatTool, handler)
    }
  },
  onChatTodo: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: TodoUpdatedEvent): void => listener(payload)
    ipcRenderer.on(IpcChannel.ChatTodo, handler)
    return () => {
      ipcRenderer.off(IpcChannel.ChatTodo, handler)
    }
  },
  onChatNotice: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: ChatNoticeEvent): void => listener(payload)
    ipcRenderer.on(IpcChannel.ChatNotice, handler)
    return () => {
      ipcRenderer.off(IpcChannel.ChatNotice, handler)
    }
  },
  onJobNotice: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: JobNoticeEvent): void => listener(payload)
    ipcRenderer.on(IpcChannel.JobNotice, handler)
    return () => {
      ipcRenderer.off(IpcChannel.JobNotice, handler)
    }
  },
  onApprovalRequest: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: ApprovalRequestEvent): void =>
      listener(payload)
    ipcRenderer.on(IpcChannel.ApprovalRequest, handler)
    return () => {
      ipcRenderer.off(IpcChannel.ApprovalRequest, handler)
    }
  },
  respondApproval: (requestId, decision: ApprovalDecision) => {
    ipcRenderer.send(IpcChannel.ApprovalRespond, requestId, decision)
  },
  onUserQuestion: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: UserQuestionRequestEvent): void =>
      listener(payload)
    ipcRenderer.on(IpcChannel.UserQuestionRequest, handler)
    return () => {
      ipcRenderer.off(IpcChannel.UserQuestionRequest, handler)
    }
  },
  respondUserQuestion: (requestId, answers: UserQuestionAnswers) => {
    ipcRenderer.send(IpcChannel.UserQuestionRespond, requestId, answers)
  },
  getAgentSettings: () => ipcRenderer.invoke(IpcChannel.SettingsGet),
  setAgentSettings: (patch) => ipcRenderer.invoke(IpcChannel.SettingsSet, patch),
  exportConversation: (suggestedName, content) =>
    ipcRenderer.invoke(IpcChannel.ConversationExport, suggestedName, content),
  onWorkspaceChanged: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: WorkspaceChangedEvent): void => listener(payload)
    ipcRenderer.on(IpcChannel.WorkspaceChanged, handler)
    return () => {
      ipcRenderer.off(IpcChannel.WorkspaceChanged, handler)
    }
  },

  onMenuCommand: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, command: string): void =>
      listener(command as Parameters<typeof listener>[0])
    ipcRenderer.on(IpcChannel.MenuCommand, handler)
    return () => {
      ipcRenderer.off(IpcChannel.MenuCommand, handler)
    }
  }
}

contextBridge.exposeInMainWorld('halis', api)
