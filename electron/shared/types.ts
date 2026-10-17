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
  /** Latest todo snapshot the agent recorded during this message, for replay. */
  todos?: TodoItem[]
}

/* ---------- agent todo list ---------- */

/**
 * One entry in the agent's task list. Deliberately minimal — a short
 * imperative line and a three-state lifecycle; the whole list is replaced
 * on every write (last write wins).
 */
export interface TodoItem {
  content: string
  status: 'pending' | 'in_progress' | 'completed'
}

/** Whole-list snapshot pushed to the renderer after each `todo_write`. */
export interface TodoUpdatedEvent {
  runId: string
  todos: TodoItem[]
}

/* ---------- chat sessions ---------- */

/** Summary row of a saved chat session, for the history list. */
export interface ChatSessionMeta {
  id: string
  title: string
  updatedAt: number
  messageCount: number
}

/** One persisted conversation; `id` is null until the first save assigns it. */
export interface ChatSession {
  id: string | null
  title: string
  createdAt: number
  updatedAt: number
  workspaceRoot: string | null
  model: ModelSelection | null
  messages: ChatMessage[]
}

/** Request payload for `chat:compact` — compact the given conversation now. */
export interface CompactRequest {
  history: ChatMessage[]
  model: ModelSelection
}

/** Result of a manual compaction. */
export interface CompactResult {
  /** The framed checkpoint to splice into the conversation. */
  checkpoint: string
  /** Rough token estimate of the original span, for the confirmation note. */
  beforeTokens: number
  afterTokens: number
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
  /** HTTP status, set when the failure came from a provider response. */
  status?: number
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

/** One rendered line of a file diff hunk. */
export interface DiffLine {
  kind: 'add' | 'del' | 'ctx'
  text: string
}

/**
 * A hunk-level diff of a file the agent changed, computed in the main
 * process and persisted on the tool trace so replay shows the same card
 * the live run did — the way DeepSeek Harness stores diff meta on tool
 * results.
 */
export interface FileDiff {
  /** File path relative to the workspace root. */
  path: string
  /** create = the file did not exist before this call. */
  op: 'create' | 'update'
  lines: DiffLine[]
  added: number
  removed: number
}

/** What a tool did, kept on the message so the UI can replay it. */
export interface ToolTrace {
  name: string
  input: Record<string, unknown>
  output: string
  ok: boolean
  durationMs: number
  /** Hunk diffs for tools that changed file content. */
  diff?: FileDiff[]
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
  /** Hunk diffs for tools that changed file content. */
  diff?: FileDiff[]
}

export type ApprovalDecision = 'allowed-once' | 'rejected'

/** Pushed to the renderer when a tool call needs the user's say-so. */
export interface ApprovalRequestEvent {
  requestId: string
  runId: string
  callId: string
  toolName: string
  /** Human-readable reason the call was flagged. */
  reason: string
  /** The exact command line, when the flagged tool is run_command. */
  command?: string
}

/* ---------- background jobs ---------- */

/** Pushed when a background command settles; carries its tail for a glance. */
export interface JobNoticeEvent {
  jobId: string
  command: string
  status: 'completed' | 'failed' | 'killed'
  exitCode: number | null
  /** Last few characters of output, for a quick look. */
  output: string
  /** Full output file the model can page through with job_output. */
  outputFilePath: string
}

/* ---------- agent questions ---------- */

/** One selectable answer of an ask_user call. */
export interface UserQuestionOption {
  label: string
  /** One-line hint shown under the label. */
  description?: string
}

/** Pushed to the renderer while an ask_user tool call waits on the user. */
export interface UserQuestionRequestEvent {
  requestId: string
  runId: string
  callId: string
  question: string
  options: UserQuestionOption[]
  multiple: boolean
}

/** The user's answer: chosen labels plus any custom text; null when skipped. */
export type UserQuestionAnswers = string[] | null

/** Non-chat information the runtime pushes into the conversation. */
export interface ChatNoticeEvent {
  runId: string
  kind: 'compacted' | 'info'
  text: string
}

export type CommandApprovalMode = 'ask' | 'fullAccess'

export interface AgentSettings {
  /** Ask before the agent runs a flagged command, or run everything unchecked. */
  commandApproval: CommandApprovalMode
}

/** Pushed after the agent or the user changes a workspace file. */
export interface WorkspaceChangedEvent {
  path: string
  /** What produced the change; absent for agent-driven writes from older builds. */
  change?: 'write' | 'create' | 'rename' | 'delete'
  /** Previous path, only set for renames. */
  from?: string
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

/* ---------- workspace search ---------- */

export interface SearchHit {
  /** Path relative to the workspace root. */
  path: string
  /** 1-based line number of the match. */
  line: number
  /** The matching line, trimmed for display. */
  text: string
}

export interface SearchOptions {
  /** Folder to search in, relative to the root. Defaults to the whole workspace. */
  scope?: string
  caseSensitive?: boolean
}

export interface SearchResponse {
  hits: SearchHit[]
  /** True when the result list was cut off; narrow the query to see more. */
  truncated: boolean
}

/* ---------- terminal ---------- */

/** A chunk of output from a running terminal command. */
export interface TerminalDataEvent {
  id: string
  chunk: string
}

/** A terminal command finished; carries the shell cwd after builtins like cd. */
export interface TerminalExitEvent {
  id: string
  code: number | null
  cwd?: string
}
