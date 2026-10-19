export interface ToolProperty {
  type: 'string' | 'number' | 'boolean' | 'array'
  description: string
  enum?: string[]
  /** Array item shape, only meaningful when type is 'array'. */
  items?: ToolItemShape
}

export interface ToolItemShape {
  type: 'object' | 'string'
  properties?: Record<string, ToolProperty>
  required?: string[]
}

export interface ToolSchema {
  type: 'object'
  properties: Record<string, ToolProperty>
  required?: string[]
}

/** One row of the agent's visible plan. */
export interface TodoItem {
  text: string
  status: 'pending' | 'in_progress' | 'done'
}

/** A structured question the model wants answered before it continues. */
export interface AskRequest {
  question: string
  /** Suggested answers; free text stays allowed even when present. */
  choices?: string[]
  /** Many picks allowed — joined with commas into one answer. */
  multiple?: boolean
}

export interface AskAnswer {
  text: string
  cancelled: boolean
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
  /** Host callback that makes the plan visible; optional so hosts can ignore it. */
  setTodos?: (items: TodoItem[]) => void
  /** Host question card; absent in print mode, so ask_user declines. */
  askUser?: (question: AskRequest) => Promise<AskAnswer>
}

export interface ToolOutcome {
  output: string
  ok: boolean
}

export interface Tool {
  spec: ToolSpec
  run(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutcome>
}

/** One thinking (or redacted_thinking) block, kept for the tool loop. */
export interface ThinkingBlock {
  thinking: string
  signature: string
  /** Opaque payload when the model emitted a redacted_thinking block instead. */
  redactedData?: string
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  /** Tool invocations made in this assistant turn. */
  toolCalls?: ToolCall[]
  /** Tool message: which invocation this result belongs to. */
  toolCallId?: string
  /** Anthropic thinking blocks from this assistant turn, replayed verbatim. */
  thinkingBlocks?: ThinkingBlock[]
}

export type AgentEvent =
  | { type: 'text-delta'; text: string }
  | { type: 'tool-start'; call: ToolCall }
  | { type: 'tool-end'; call: ToolCall; result: ToolResult; ms: number }
  | { type: 'usage'; input: number; output: number }
  | { type: 'notice'; text: string }
  | { type: 'error'; message: string }
  | { type: 'done'; reason: 'complete' | 'aborted' | 'max-turns' | 'error' | 'repeat' }
  | { type: 'cost'; usd: number }
  | { type: 'title'; text: string }

/** What the agent loop needs from the host process. */
export interface AgentRunOptions {
  system: string
  /** The live transcript; the loop appends to it in place. */
  messages: ChatMessage[]
  tools: Tool[]
  maxTurns: number
  signal: AbortSignal
  cwd: string
  provider: {
    baseUrl: string
    apiKey?: string
    model: string
    /** Wire protocol the endpoint speaks; default openai. */
    protocol?: 'openai' | 'anthropic'
    /** Catalog provider id, for per-provider wire quirks and auth style. */
    providerId?: string
    /** Reasoning knobs derived from the catalog variant, when set. */
    variant?: import('./provider.js').ProviderVariant
    /** Output cap for the request. */
    maxTokens?: number
    extraHeaders?: Record<string, string>
    extraBody?: Record<string, unknown>
  }
  /** Files read this session, owned by the caller and shared across turns. */
  readFiles: Set<string>
  /** Transcript token estimate that triggers compaction; 0 disables, default DEFAULT_COMPACT_AT. */
  compactAt?: number
  onEvent: (event: AgentEvent) => void
  /** Return false to refuse a call; the model sees the refusal. */
  approve?: (call: ToolCall) => Promise<boolean>
  /** Host question card; absent in print mode, so ask_user declines. */
  askUser?: (question: AskRequest) => Promise<AskAnswer>
  /** Receives every todo_write payload so the host can render the plan. */
  setTodos?: (items: TodoItem[]) => void
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
  /** Ask the provider for token counts (stream_options.include_usage). */
  wantUsage?: boolean
  /** Wire protocol the endpoint speaks; default openai chat completions. */
  protocol?: 'openai' | 'anthropic'
  /** Catalog provider id, for per-provider wire quirks. */
  providerId?: string
  /** Reasoning knobs derived from the catalog variant, when set. */
  variant?: import('./provider.js').ProviderVariant
  /** Output cap for the request. */
  maxTokens?: number
  extraHeaders?: Record<string, string>
  extraBody?: Record<string, unknown>
}

export interface Usage {
  input: number
  output: number
}

export interface StreamResponse {
  text: string
  toolCalls: ToolCall[]
  /** Present when the provider reports usage. */
  usage?: Usage
  /** Anthropic thinking blocks to replay when this turn continues with tool results. */
  thinkingBlocks?: ThinkingBlock[]
}
