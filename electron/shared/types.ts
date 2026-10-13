export interface AppInfo {
  name: string
  version: string
  electron: string
  platform: string
}

export type WorkspaceEntryKind = 'file' | 'directory'

export interface WorkspaceEntry {
  name: string
  /** Path relative to the workspace root, '' for the root itself. */
  path: string
  kind: WorkspaceEntryKind
}

export type ChatRole = 'user' | 'assistant' | 'system'

export interface ChatMessage {
  id: string
  role: ChatRole
  content: string
  createdAt: number
}

export interface WorkspaceState {
  root: string | null
}
