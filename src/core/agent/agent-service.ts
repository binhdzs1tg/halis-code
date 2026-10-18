import type {
  AgentTurnRequest,
  ApprovalDecision,
  ApprovalRequestEvent,
  ChatErrorCode,
  ChatNoticeEvent,
  ChatToolEvent,
  CompactRequest,
  CompactResult,
  TodoUpdatedEvent,
  UserQuestionAnswers,
  UserQuestionRequestEvent
} from '../../../electron/shared/types'

export type AgentErrorCode = ChatErrorCode | 'busy' | 'bridge'

export class AgentError extends Error {
  constructor(
    readonly code: AgentErrorCode,
    message: string,
    /** Text that had already streamed in when the run failed. */
    readonly partial: string,
    /** HTTP status, present when a provider response failed. */
    readonly status?: number
  ) {
    super(message)
    this.name = 'AgentError'
  }
}

export interface AgentStreamHandlers {
  onDelta(chunk: string): void
  /** Tool calls as the agent makes them; `start` when invoked, `end` with the result. */
  onTool?(event: ChatToolEvent): void
  /** Whole-list todo snapshots as the agent rewrites its plan. */
  onTodo?(event: TodoUpdatedEvent): void
  /** Runtime information like automatic compaction. */
  onNotice?(event: ChatNoticeEvent): void
  /** A flagged command is waiting for the user's say-so. */
  onApproval?(event: ApprovalRequestEvent): void
  /** An ask_user call is waiting for the user's answer. */
  onQuestion?(event: UserQuestionRequestEvent): void
}

/**
 * Renderer-side gateway to the agent runtime in the main process.
 *
 * `run` resolves with the full reply once the stream completes and rejects
 * with an `AgentError` (carrying any partial text) when it fails. Cancelling
 * resolves normally with whatever had streamed so far.
 */
export class AgentService {
  private activeRunId: string | null = null
  /** Set synchronously before the sendChat await closes the race window. */
  private starting = false
  /** A cancel clicked while `starting` — fires the moment a run id exists. */
  private cancelPending = false

  get running(): boolean {
    return this.activeRunId !== null || this.starting
  }

  async run(request: AgentTurnRequest, handlers?: AgentStreamHandlers): Promise<string> {
    if (this.activeRunId || this.starting) {
      throw new AgentError('busy', 'The agent is already answering — stop it first', '')
    }
    this.cancelPending = false
    this.starting = true
    let runId: string
    try {
      const started = await window.halis.sendChat(request)
      runId = started.runId
    } catch (err) {
      throw new AgentError('bridge', err instanceof Error ? err.message : String(err), '')
    } finally {
      this.starting = false
    }
    this.activeRunId = runId
    // Stop was pressed during the sendChat roundtrip: the run starts dead.
    if (this.cancelPending) {
      this.cancelPending = false
      window.halis.cancelChat(runId)
    }

    return await new Promise<string>((resolve, reject) => {
      let text = ''
      const offDelta = window.halis.onChatDelta((event) => {
        if (event.runId !== runId) return
        text += event.text
        handlers?.onDelta(event.text)
      })
      const offTool = window.halis.onChatTool((event) => {
        if (event.runId !== runId) return
        handlers?.onTool?.(event)
      })
      const offTodo = window.halis.onChatTodo((event) => {
        if (event.runId !== runId) return
        handlers?.onTodo?.(event)
      })
      const offNotice = window.halis.onChatNotice((event) => {
        if (event.runId !== runId) return
        handlers?.onNotice?.(event)
      })
      const offApproval = window.halis.onApprovalRequest((event) => {
        if (event.runId !== runId) return
        handlers?.onApproval?.(event)
      })
      const offQuestion = window.halis.onUserQuestion((event) => {
        if (event.runId !== runId) return
        handlers?.onQuestion?.(event)
      })
      const offDone = window.halis.onChatDone((event) => {
        if (event.runId !== runId) return
        cleanup()
        resolve(text)
      })
      const offError = window.halis.onChatError((event) => {
        if (event.runId !== runId) return
        cleanup()
        reject(new AgentError(event.code, event.message, text, event.status))
      })
      const cleanup = (): void => {
        this.activeRunId = null
        offDelta()
        offTool()
        offTodo()
        offNotice()
        offApproval()
        offQuestion()
        offDone()
        offError()
      }
    })
  }

  cancel(): void {
    if (this.activeRunId) {
      window.halis.cancelChat(this.activeRunId)
    } else if (this.starting) {
      // No run id exists yet; remember the stop so it lands as soon as one does.
      this.cancelPending = true
    }
  }

  /** Answer a pending approval exactly once. */
  respondApproval(requestId: string, decision: ApprovalDecision): void {
    window.halis.respondApproval(requestId, decision)
  }

  /** Answer a pending question once: the chosen labels, or null to skip. */
  respondQuestion(requestId: string, answers: UserQuestionAnswers): void {
    window.halis.respondUserQuestion(requestId, answers)
  }

  /** Fold the given conversation into a checkpoint right now. */
  async compact(request: CompactRequest): Promise<CompactResult> {
    return await window.halis.compactConversation(request)
  }
}

export const agentService = new AgentService()
