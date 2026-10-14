import type { ModelEntry, ModelVariant, ProviderEntry } from '../../shared/models'
import type { ToolSpec } from '../../shared/types'
import { isUnsupported, resolveEndpoint, type Endpoint } from './endpoints'

export interface ProviderToolCall {
  id: string
  name: string
  input: Record<string, unknown>
}

export interface ProviderToolResult {
  callId: string
  output: string
  ok: boolean
}

export interface ProviderMessage {
  role: 'user' | 'assistant'
  content: string
  /** Tool invocations made in this assistant turn. */
  toolCalls?: ProviderToolCall[]
  /** Tool results carried by the user turn that follows them. */
  toolResults?: ProviderToolResult[]
}

export interface ProviderStreamResult {
  /** Full assistant text; the same chunks were already delivered via onDelta. */
  text: string
  /** Tool calls requested by the model, empty for plain answers. */
  toolCalls: ProviderToolCall[]
}

export interface ProviderStreamRequest {
  provider: ProviderEntry
  model: ModelEntry
  variant: ModelVariant | null
  apiKey: string
  system: string
  messages: ProviderMessage[]
  /** Omit to run a plain, tool-less completion. */
  tools?: ToolSpec[]
  signal: AbortSignal
  onDelta: (text: string) => void
}

export type ProviderErrorCode = 'http' | 'network' | 'aborted' | 'unsupported-provider' | 'no-endpoint'

export class ProviderError extends Error {
  constructor(
    readonly code: ProviderErrorCode,
    message: string,
    readonly status?: number
  ) {
    super(message)
    this.name = 'ProviderError'
  }
}

/** Anthropic requires the thinking budget to stay below max_tokens. */
const ANTHROPIC_MIN_BUDGET = 1024

export async function streamChat(request: ProviderStreamRequest): Promise<ProviderStreamResult> {
  if (isUnsupported(request.provider.id)) {
    throw new ProviderError(
      'unsupported-provider',
      `${request.provider.name} needs signed or interactive authentication that is not supported yet.`
    )
  }
  try {
    if (request.provider.id === 'anthropic') {
      return await streamAnthropic(request)
    }
    return await streamOpenAiCompatible(request)
  } catch (err) {
    if (err instanceof ProviderError) throw err
    if (err instanceof Error && err.name === 'AbortError') {
      throw new ProviderError('aborted', 'cancelled')
    }
    throw new ProviderError('network', err instanceof Error ? err.message : String(err))
  }
}

/* ---------- OpenAI-compatible chat completions ---------- */

interface OpenAiChunk {
  choices?: Array<{
    delta?: {
      content?: string
      tool_calls?: Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string } }>
    }
  }>
}

/** Streams argument fragments for tool calls, indexed like the provider sends them. */
class ToolCallCollector {
  private slots = new Map<number, { id: string; name: string; args: string }>()

  add(index: number, id: string | undefined, name: string | undefined, args: string | undefined): void {
    const slot = this.slots.get(index) ?? { id: '', name: '', args: '' }
    if (id) slot.id = id
    if (name) slot.name = name
    if (args) slot.args += args
    this.slots.set(index, slot)
  }

  calls(): ProviderToolCall[] {
    return [...this.slots.entries()]
      .sort(([a], [b]) => a - b)
      .filter(([, slot]) => slot.name.length > 0)
      .map(([index, slot], position) => ({
        id: slot.id || `call-${index}`,
        name: slot.name,
        input: parseInput(slot.args, `call-${index}-${position}`)
      }))
  }
}

function parseInput(raw: string, fallbackId: string): Record<string, unknown> {
  if (raw.trim().length === 0) return {}
  try {
    const parsed = JSON.parse(raw)
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {}
  } catch {
    return { _malformed: true, _raw: raw, _note: `arguments failed to parse (id ${fallbackId})` }
  }
}

async function streamOpenAiCompatible(request: ProviderStreamRequest): Promise<ProviderStreamResult> {
  const endpoint = requireEndpoint(request.provider, request.model)
  const body: Record<string, unknown> = {
    model: request.model.id,
    messages: toOpenAiMessages(request),
    stream: true
  }
  if (request.tools?.length) {
    body.tools = request.tools.map((tool) => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters
      }
    }))
    body.tool_choice = 'auto'
  }
  // OpenAI's newer models reject the legacy max_tokens parameter.
  if (request.provider.id === 'openai') {
    body.max_completion_tokens = request.model.limit.output
  } else {
    body.max_tokens = request.model.limit.output
  }
  applyReasoning(body, request)

  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (endpoint.auth === 'api-key') {
    headers['api-key'] = request.apiKey
  } else {
    headers.authorization = `Bearer ${request.apiKey}`
  }
  Object.assign(headers, request.model.modeHeaders ?? {})
  Object.assign(body, request.model.modeBody ?? {})

  const response = await fetch(openAiUrl(request, endpoint), {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: request.signal
  })
  if (!response.ok) {
    await failResponse(response, request.provider)
  }

  let text = ''
  const collector = new ToolCallCollector()
  for await (const event of readSse(response)) {
    if (event.data === '[DONE]') break
    let chunk: OpenAiChunk
    try {
      chunk = JSON.parse(event.data) as OpenAiChunk
    } catch {
      continue // keep-alive noise or a stray line
    }
    const delta = chunk.choices?.[0]?.delta
    if (delta?.content) {
      text += delta.content
      request.onDelta(delta.content)
    }
    for (const part of delta?.tool_calls ?? []) {
      collector.add(part.index ?? 0, part.id, part.function?.name, part.function?.arguments)
    }
  }
  return { text, toolCalls: collector.calls() }
}

/** Flatten the harness message shape into the OpenAI wire format. */
function toOpenAiMessages(request: ProviderStreamRequest): unknown[] {
  const out: Array<Record<string, unknown>> = [{ role: 'system', content: request.system }]
  for (const message of request.messages) {
    if (message.role === 'assistant') {
      if (message.toolCalls?.length) {
        out.push({
          role: 'assistant',
          content: message.content,
          tool_calls: message.toolCalls.map((call) => ({
            id: call.id,
            type: 'function',
            function: { name: call.name, arguments: JSON.stringify(call.input) }
          }))
        })
      } else if (message.content) {
        out.push({ role: 'assistant', content: message.content })
      }
      continue
    }
    for (const result of message.toolResults ?? []) {
      out.push({ role: 'tool', tool_call_id: result.callId, content: result.output })
    }
    if (message.content) {
      out.push({ role: 'user', content: message.content })
    }
  }
  return out
}

function openAiUrl(request: ProviderStreamRequest, endpoint: Endpoint): string {
  if (request.provider.id !== 'azure') {
    return `${endpoint.base}/chat/completions`
  }
  const resource = process.env.AZURE_RESOURCE_NAME
  if (!resource) {
    throw new ProviderError(
      'unsupported-provider',
      'Azure needs the AZURE_RESOURCE_NAME env var to build its per-deployment endpoint.'
    )
  }
  return `https://${resource}.openai.azure.com/openai/deployments/${encodeURIComponent(
    request.model.id
  )}/chat/completions?api-version=2025-04-01-preview`
}

/** Map catalog reasoning variants onto the OpenAI-compatible body shape. */
function applyReasoning(body: Record<string, unknown>, request: ProviderStreamRequest): void {
  const variant = request.variant
  if (!variant) return
  if (variant.reasoningEffort) {
    body.reasoning_effort = variant.reasoningEffort
    return
  }
  if (variant.thinking) {
    if (request.provider.id === 'zai') {
      body.thinking = { type: 'enabled' }
    } else if (request.provider.id === 'openrouter') {
      body.reasoning = { enabled: true }
    }
  }
}

/* ---------- Anthropic messages ---------- */

interface AnthropicStreamEvent {
  type?: string
  index?: number
  content_block?: { type?: string; id?: string; name?: string }
  delta?: { type?: string; text?: string; partial_json?: string }
  error?: { message?: string }
}

async function streamAnthropic(request: ProviderStreamRequest): Promise<ProviderStreamResult> {
  const endpoint = requireEndpoint(request.provider, request.model)
  const body: Record<string, unknown> = {
    model: request.model.id,
    max_tokens: request.model.limit.output,
    stream: true,
    system: request.system,
    messages: toAnthropicMessages(request)
  }
  if (request.tools?.length) {
    body.tools = request.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.parameters
    }))
  }

  const variant = request.variant
  if (variant?.thinking || variant?.budgetTokens) {
    const requested = variant?.budgetTokens ?? defaultBudget(request.model)
    const ceiling = Math.max(ANTHROPIC_MIN_BUDGET, request.model.limit.output - 1)
    body.thinking = {
      type: 'enabled',
      budget_tokens: Math.min(requested, ceiling)
    }
  }
  Object.assign(body, request.model.modeBody ?? {})

  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-api-key': request.apiKey,
    'anthropic-version': '2023-06-01'
  }
  Object.assign(headers, request.model.modeHeaders ?? {})

  const response = await fetch(`${endpoint.base}/messages`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: request.signal
  })
  if (!response.ok) {
    await failResponse(response, request.provider)
  }

  let text = ''
  const toolBlocks = new Map<number, { id: string; name: string; json: string }>()
  for await (const event of readSse(response)) {
    let payload: AnthropicStreamEvent
    try {
      payload = JSON.parse(event.data) as AnthropicStreamEvent
    } catch {
      continue
    }
    if (event.event === 'error') {
      throw new ProviderError('http', payload.error?.message ?? 'stream error')
    }
    if (event.event === 'message_stop') break
    if (event.event === 'content_block_start' && payload.content_block?.type === 'tool_use') {
      toolBlocks.set(payload.index ?? 0, {
        id: payload.content_block.id ?? '',
        name: payload.content_block.name ?? '',
        json: ''
      })
    }
    if (event.event === 'content_block_delta') {
      if (payload.delta?.type === 'text_delta' && payload.delta.text) {
        text += payload.delta.text
        request.onDelta(payload.delta.text)
      }
      if (payload.delta?.type === 'input_json_delta' && payload.delta.partial_json) {
        const block = toolBlocks.get(payload.index ?? 0)
        if (block) block.json += payload.delta.partial_json
      }
    }
  }

  const toolCalls: ProviderToolCall[] = [...toolBlocks.entries()]
    .sort(([a], [b]) => a - b)
    .map(([index, block]) => ({
      id: block.id || `call-${index}`,
      name: block.name,
      input: parseInput(block.json, `call-${index}`)
    }))
    .filter((call) => call.name.length > 0)
  return { text, toolCalls }
}

/** Flatten the harness message shape into Anthropic content blocks. */
function toAnthropicMessages(request: ProviderStreamRequest): unknown[] {
  const out: Array<Record<string, unknown>> = []
  for (const message of request.messages) {
    if (message.role === 'assistant') {
      const blocks: Array<Record<string, unknown>> = []
      if (message.content) blocks.push({ type: 'text', text: message.content })
      for (const call of message.toolCalls ?? []) {
        blocks.push({ type: 'tool_use', id: call.id, name: call.name, input: call.input })
      }
      if (blocks.length) out.push({ role: 'assistant', content: blocks })
      continue
    }
    const blocks: Array<Record<string, unknown>> = []
    for (const result of message.toolResults ?? []) {
      blocks.push({
        type: 'tool_result',
        tool_use_id: result.callId,
        content: result.output,
        is_error: !result.ok
      })
    }
    if (message.content) blocks.push({ type: 'text', text: message.content })
    if (blocks.length) out.push({ role: 'user', content: blocks })
  }
  return out
}

/** Somewhere between the model floor and a quarter of its output window. */
function defaultBudget(model: ModelEntry): number {
  return Math.min(16_000, Math.max(ANTHROPIC_MIN_BUDGET, Math.floor(model.limit.output / 4)))
}

/* ---------- shared plumbing ---------- */

function requireEndpoint(provider: ProviderEntry, model: ModelEntry): Endpoint {
  const endpoint = resolveEndpoint(provider, model)
  if (!endpoint) {
    throw new ProviderError('no-endpoint', `No API endpoint is known for ${provider.name}.`)
  }
  return endpoint
}

async function failResponse(response: Response, provider: ProviderEntry): Promise<never> {
  let detail = ''
  try {
    const text = await response.text()
    try {
      const parsed = JSON.parse(text) as { error?: { message?: string } | string }
      if (typeof parsed.error === 'string') {
        detail = parsed.error
      } else {
        detail = parsed.error?.message ?? ''
      }
    } catch {
      detail = text.trim().slice(0, 300)
    }
  } catch {
    // body already consumed; the status summary is enough
  }
  const summary = httpSummary(response.status, provider)
  throw new ProviderError('http', detail ? `${summary}: ${detail}` : summary, response.status)
}

function httpSummary(status: number, provider: ProviderEntry): string {
  if (status === 401 || status === 403) {
    return `${provider.name} rejected the API key — check that it is valid and can use this model`
  }
  if (status === 404) return 'Model or endpoint not found'
  if (status === 429) return 'Rate limited by the provider'
  if (status >= 500) return `${provider.name} server error`
  return `HTTP ${status} from ${provider.name}`
}

interface SseEvent {
  event: string
  data: string
}

/** Incremental server-sent-events reader over a fetch body stream. */
async function* readSse(response: Response): AsyncGenerator<SseEvent> {
  const body = response.body
  if (!body) {
    throw new ProviderError('network', 'response has no body to stream')
  }
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let eventName = ''
  let dataLines: string[] = []

  const take = (): SseEvent | null => {
    if (dataLines.length === 0 && !eventName) return null
    const event: SseEvent = { event: eventName || 'message', data: dataLines.join('\n') }
    eventName = ''
    dataLines = []
    return event
  }

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let newline = buffer.indexOf('\n')
      while (newline >= 0) {
        const line = buffer.slice(0, newline).replace(/\r$/, '')
        buffer = buffer.slice(newline + 1)
        if (line === '') {
          const event = take()
          if (event) yield event
        } else if (line.startsWith('event:')) {
          eventName = line.slice(6).trim()
        } else if (line.startsWith('data:')) {
          dataLines.push(line.slice(5).trimStart())
        }
        newline = buffer.indexOf('\n')
      }
    }
    const tail = take()
    if (tail) yield tail
  } finally {
    void reader.cancel().catch(() => undefined)
  }
}
