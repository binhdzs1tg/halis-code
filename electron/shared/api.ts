import type {
  AgentSettings,
  AgentTurnRequest,
  AppInfo,
  ApprovalDecision,
  ApprovalRequestEvent,
  ChatDeltaEvent,
  ChatDoneEvent,
  ChatErrorEvent,
  ChatNoticeEvent,
  ChatRunStarted,
  ChatSession,
  ChatSessionMeta,
  ChatToolEvent,
  CompactRequest,
  CompactResult,
  ProviderKeyStatuses,
  SearchOptions,
  SearchResponse,
  TerminalDataEvent,
  TerminalExitEvent,
  TodoUpdatedEvent,
  WorkspaceChangedEvent,
  WorkspaceEntry,
  WorkspaceEntryKind
} from './types'
import type { ModelCatalog } from './models'

/**
 * Contract of the `window.halis` bridge exposed by the preload script.
 * Kept in shared/ so the renderer can type it without importing electron.
 */
export interface HalisApi {
  getInfo(): Promise<AppInfo>
  minimize(): void
  maximize(): void
  close(): void
  /** Fired when the window enters or leaves the maximized/fullscreen state. */
  onWindowState(listener: (maximized: boolean) => void): () => void

  pickWorkspace(): Promise<string | null>
  openWorkspace(absolutePath: string): Promise<string | null>
  readDir(relPath: string): Promise<WorkspaceEntry[]>
  readFile(relPath: string): Promise<string>
  writeFile(relPath: string, content: string): Promise<void>
  createEntry(relPath: string, kind: WorkspaceEntryKind): Promise<void>
  renameEntry(from: string, to: string): Promise<void>
  /** Move a workspace entry to the OS trash. */
  deleteEntry(relPath: string): Promise<void>
  /** Plain-text search across the workspace; runs in the main process. */
  searchWorkspace(query: string, options?: SearchOptions): Promise<SearchResponse>

  /** Spawn one command line; output arrives through onTerminalData/Exit. */
  runTerminalCommand(command: string): Promise<string>
  /** Abort the running command; false when the terminal is idle. */
  killTerminalCommand(): Promise<boolean>
  onTerminalData(listener: (event: TerminalDataEvent) => void): () => void
  onTerminalExit(listener: (event: TerminalExitEvent) => void): () => void

  /** Full models.dev catalog (providers + models), normalized. */
  getModels(): Promise<ModelCatalog>
  /** Re-fetch the catalog from upstream immediately. */
  refreshModels(): Promise<ModelCatalog>
  /** Fired on the renderer whenever the catalog changes in the main process. */
  onModelsUpdated(listener: () => void): () => void

  /** Start an agent run; text arrives through `onChatDelta` until done/error. */
  sendChat(request: AgentTurnRequest): Promise<ChatRunStarted>
  cancelChat(runId: string): void
  /** Fold a conversation into a checkpoint right now and return it. */
  compactConversation(request: CompactRequest): Promise<CompactResult>
  onChatDelta(listener: (event: ChatDeltaEvent) => void): () => void
  onChatDone(listener: (event: ChatDoneEvent) => void): () => void
  onChatError(listener: (event: ChatErrorEvent) => void): () => void
  /** Tool calls the agent makes while a run is in flight. */
  onChatTool(listener: (event: ChatToolEvent) => void): () => void
  /** Whole-list todo snapshots the agent publishes while a run is in flight. */
  onChatTodo(listener: (event: TodoUpdatedEvent) => void): () => void
  /** Runtime information like automatic compaction, pushed mid-conversation. */
  onChatNotice(listener: (event: ChatNoticeEvent) => void): () => void
  /** A tool call is waiting for the user's say-so. */
  onApprovalRequest(listener: (event: ApprovalRequestEvent) => void): () => void
  /** Answer a pending approval; 'allowed-once' or 'rejected', one shot. */
  respondApproval(requestId: string, decision: ApprovalDecision): void
  /** Fired when the agent creates or modifies a workspace file. */
  onWorkspaceChanged(listener: (event: WorkspaceChangedEvent) => void): () => void

  /** Agent-facing settings, currently the command approval mode. */
  getAgentSettings(): Promise<AgentSettings>
  setAgentSettings(patch: Partial<AgentSettings>): Promise<AgentSettings>
  /** Save a conversation as Markdown through a native save dialog. */
  exportConversation(suggestedName: string, content: string): Promise<string | null>

  /** Providers that currently have a key, either from the vault or the env. */
  getKeyStatuses(): Promise<ProviderKeyStatuses>
  setProviderKey(providerId: string, value: string): Promise<ProviderKeyStatuses>
  removeProviderKey(providerId: string): Promise<ProviderKeyStatuses>

  /** Saved chat sessions, newest first. */
  listSessions(): Promise<ChatSessionMeta[]>
  /** Load one full conversation. */
  loadSession(id: string): Promise<ChatSession>
  /** Persist a conversation; assigns its id on the first save. */
  saveSession(session: ChatSession): Promise<ChatSessionMeta>
  /** Delete one saved conversation. */
  deleteSession(id: string): Promise<void>
  /** Fired whenever a vault key is added or removed. */
  onKeysChanged(listener: () => void): () => void

  /** Commands pushed by the native application menu. */
  onMenuCommand(
    listener: (command: 'open-workspace' | 'toggle-sidebar' | 'toggle-terminal' | 'toggle-chat') => void
  ): () => void
}
