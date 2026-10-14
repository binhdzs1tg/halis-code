export const IpcChannel = {
  AppInfo: 'app:info',
  WindowMinimize: 'window:minimize',
  WindowMaximize: 'window:maximize',
  WindowClose: 'window:close',
  WorkspacePick: 'workspace:pick',
  WorkspaceOpen: 'workspace:open',
  WorkspaceReadDir: 'workspace:read-dir',
  FileRead: 'file:read',
  ModelsList: 'models:list',
  ModelsRefresh: 'models:refresh',
  ModelsUpdated: 'models:updated',
  ChatSend: 'chat:send',
  ChatCancel: 'chat:cancel',
  ChatDelta: 'chat:delta',
  ChatDone: 'chat:done',
  ChatError: 'chat:error',
  ChatTool: 'chat:tool',
  WorkspaceChanged: 'workspace:changed',
  KeysStatus: 'keys:status',
  KeysSet: 'keys:set',
  KeysRemove: 'keys:remove',
  KeysChanged: 'keys:changed'
} as const

export type IpcChannel = (typeof IpcChannel)[keyof typeof IpcChannel]
