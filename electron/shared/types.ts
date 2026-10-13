import type { ModelSelection } from './models'

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

/* ---------- agent chat runs ---------- */

/** One user turn sent to the agent, exchanged over `chat:send`. */
export interface AgentTurnRequest {
  prompt: string
  history: ChatMessage[]
  model: ModelSelection
}

export interface ChatRunStarted {
  runId: string
}

/** A streamed text chunk for a run; the renderer accumulates them. */
export interface ChatDeltaEvent {
  runId: string
  text: string
}

export interface ChatDoneEvent {
  runId: string
  /** True when the user cancelled; whatever streamed so far is kept. */
  aborted: boolean
}

export type ChatErrorCode =
  | 'missing-key'
  | 'unsupported-provider'
  | 'no-endpoint'
  | 'invalid-model'
  | 'http'
  | 'network'
  | 'aborted'

export interface ChatErrorEvent {
  runId: string
  code: ChatErrorCode
  message: string
}

/* ---------- provider keys ---------- */

export type KeySource = 'user' | 'env'

export interface ProviderKeyStatus {
  source: KeySource
  /** Env var the key was read from, when source is `env`. */
  envVar?: string
}

/** Only providers with a resolvable key appear in the status map. */
export type ProviderKeyStatuses = Record<string, ProviderKeyStatus>
