import type { AgentTurnRequest, ChatErrorCode, ChatToolEvent, TodoUpdatedEvent } from '../../../electron/shared/types'

export type AgentErrorCode = ChatErrorCode | 'busy' | 'bridge'

export class AgentError extends Error {
  constructor(
    readonly code: AgentErrorCode,
    message: string,
    /** Text that had already streamed in when the run failed. */
    readonly partial: string
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

  get running(): boolean {
    return this.activeRunId !== null
  }

  async run(request: AgentTurnRequest, handlers?: AgentStreamHandlers): Promise<string> {
    if (this.activeRunId) {
      throw new AgentError('busy', 'The agent is already answering — stop it first', '')
    }

    let runId: string
    try {
      const started = await window.halis.sendChat(request)
      runId = started.runId
    } catch (err) {
      throw new AgentError('bridge', err instanceof Error ? err.message : String(err), '')
    }
    this.activeRunId = runId

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
      const offDone = window.halis.onChatDone((event) => {
        if (event.runId !== runId) return
        cleanup()
        resolve(text)
      })
      const offError = window.halis.onChatError((event) => {
        if (event.runId !== runId) return
        cleanup()
        reject(new AgentError(event.code, event.message, text))
      })
      const cleanup = (): void => {
        this.activeRunId = null
        offDelta()
        offTool()
        offTodo()
        offDone()
        offError()
      }
    })
  }

  cancel(): void {
    if (this.activeRunId) {
      window.halis.cancelChat(this.activeRunId)
    }
  }
}

export const agentService = new AgentService()
