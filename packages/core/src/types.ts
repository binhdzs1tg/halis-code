export interface ToolProperty {
  type: 'string' | 'number' | 'boolean'
  description: string
  enum?: string[]
}

export interface ToolSchema {
  type: 'object'
  properties: Record<string, ToolProperty>
  required?: string[]
}

export interface ToolSpec {
  name: string
  description: string
  parameters: ToolSchema
}

export interface ToolCall {
  id: string
  name: string
  input: Record<string, unknown>
}

export interface ToolResult {
  callId: string
  name: string
  output: string
  ok: boolean
}

export interface ToolContext {
  cwd: string
  signal: AbortSignal
  /** Files read this session — edit and write refuse to touch unread files. */
  readFiles: Set<string>
}

export interface ToolOutcome {
  output: string
  ok: boolean
}

export interface Tool {
  spec: ToolSpec
  run(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutcome>
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  /** Tool invocations made in this assistant turn. */
  toolCalls?: ToolCall[]
  /** Tool message: which invocation this result belongs to. */
  toolCallId?: string
}

export type AgentEvent =
  | { type: 'text-delta'; text: string }
  | { type: 'tool-start'; call: ToolCall }
  | { type: 'tool-end'; call: ToolCall; result: ToolResult; ms: number }
  | { type: 'notice'; text: string }
  | { type: 'error'; message: string }
  | { type: 'done'; reason: 'complete' | 'aborted' | 'max-turns' | 'error' }

/** What the agent loop needs from the host process. */
export interface AgentRunOptions {
  system: string
  /** The live transcript; the loop appends to it in place. */
  messages: ChatMessage[]
  tools: Tool[]
  maxTurns: number
  signal: AbortSignal
  cwd: string
  provider: { baseUrl: string; apiKey?: string; model: string }
  /** Files read this session, owned by the caller and shared across turns. */
  readFiles: Set<string>
  onEvent: (event: AgentEvent) => void
  /** Return false to refuse a call; the model sees the refusal. */
  approve?: (call: ToolCall) => Promise<boolean>
}

export interface StreamRequest {
  baseUrl: string
  apiKey?: string
  model: string
  system: string
  messages: ChatMessage[]
  tools?: ToolSpec[]
  signal: AbortSignal
  onDelta?: (text: string) => void
}

export interface StreamResponse {
  text: string
  toolCalls: ToolCall[]
}
