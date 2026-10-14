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
  /** Tool calls the assistant made during this message, for display only. */
  tools?: ToolTrace[]
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

/* ---------- agent tools ---------- */

/** A tool the model may call, with a JSON schema describing its input. */
export interface ToolSpec {
  name: string
  description: string
  parameters: Record<string, unknown>
}

/** One tool invocation requested by the model. */
export interface ToolCall {
  id: string
  name: string
  input: Record<string, unknown>
}

/** What a tool did, kept on the message so the UI can replay it. */
export interface ToolTrace {
  name: string
  input: Record<string, unknown>
  output: string
  ok: boolean
  durationMs: number
}

/** Tool lifecycle pushed to the renderer while a run is in flight. */
export interface ChatToolEvent {
  runId: string
  callId: string
  name: string
  phase: 'start' | 'end'
  input?: Record<string, unknown>
  output?: string
  ok?: boolean
  durationMs?: number
}

/** Pushed after the agent creates or modifies a workspace file. */
export interface WorkspaceChangedEvent {
  path: string
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
