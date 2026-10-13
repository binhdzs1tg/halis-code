import type { ChatMessage } from '../../../electron/shared/types'
import type { ModelSelection } from '../../../electron/shared/models'

export interface AgentRequest {
  prompt: string
  history: ChatMessage[]
  /** Model picked in the chat composer, e.g. anthropic/claude-sonnet-4-5. */
  model?: ModelSelection
}

export interface AgentResponse {
  message: string
}

export class AgentNotReadyError extends Error {
  constructor() {
    super('Agent runtime is not wired to a model yet')
    this.name = 'AgentNotReadyError'
  }
}

/**
 * Skeleton agent gateway.
 *
 * This intentionally does nothing useful yet. Later phases will add:
 * - model provider layer (pluggable providers, API key vault)
 * - tool harness (workspace tools, permissions, sandboxing)
 * - streaming responses
 */
export class AgentService {
  async run(_request: AgentRequest): Promise<AgentResponse> {
    throw new AgentNotReadyError()
  }
}

export const agentService = new AgentService()
