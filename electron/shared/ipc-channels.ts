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
  ModelsUpdated: 'models:updated'
} as const

export type IpcChannel = (typeof IpcChannel)[keyof typeof IpcChannel]
