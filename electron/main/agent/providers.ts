import type { ModelEntry, ModelVariant, ProviderEntry } from '../../shared/models'
import { modelProtocol } from '../../shared/models'
import { AZURE_API_VERSION, isUnsupported, resolveEndpoint, type Endpoint, type EndpointResolution } from './endpoints'

import type { ToolSpec } from '../../shared/types'

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

/**
 * Per-provider wire quirks, one table instead of scattered conditionals —
 * the DeepSeek Harness `compat` profile pattern. Fields stay optional;
 * everything falls back to the generic OpenAI-compatible behavior.
 */
interface ProviderCompat {
  /** Field name carrying the output cap on chat completions. */
  maxTokensField?: 'max_tokens' | 'max_completion_tokens'
  /** Body shape a reasoning toggle maps to. */
  thinkingFormat?: 'zai' | 'openrouter'
}

const PROVIDER_COMPAT: Record<string, ProviderCompat> = {
  openai: { maxTokensField: 'max_completion_tokens' },
  zai: { thinkingFormat: 'zai' },
  openrouter: { thinkingFormat: 'openrouter' }
}

const compat = (providerId: string): ProviderCompat => PROVIDER_COMPAT[providerId] ?? {}

export async function streamChat(request: ProviderStreamRequest): Promise<ProviderStreamResult> {
  if (isUnsupported(request.provider.id)) {
    throw new ProviderError(
      'unsupported-provider',
      `${request.provider.name} needs signed or interactive authentication that is not supported yet.`
    )
  }
  try {
    if (modelProtocol(request.provider, request.model) === 'anthropic-messages') {
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
  /** Providers report mid-stream failures as a data event with no choices. */
  error?: { message?: string }
}

/** Streams argument fragments for tool calls, indexed like the provider sends them. */
class ToolCallCollector {
  private slots = new Map<number, { id: string; name: string; args: string }>()
  /** Slot a fragment without an explicit index belongs to. */
  private lastAuto: number | null = null
  private autoCounter = 0

  add(index: number | undefined, id: string | undefined, name: string | undefined, args: string | undefined): void {
    let slotIndex = index
    if (slotIndex === undefined) {
      // Providers that omit the index: a known id joins its own slot, a new
      // id opens one, and a bare continuation extends the current slot.
      if (id) {
        for (const [key, slot] of this.slots) {
          if (slot.id === id) {
            slotIndex = key
            break
          }
        }
        if (slotIndex === undefined) {
          const current = this.lastAuto === null ? undefined : this.slots.get(this.lastAuto)
          if (this.lastAuto === null || (current !== undefined && current.id !== '' && current.id !== id)) {
            slotIndex = this.autoCounter
            this.autoCounter += 1
          } else {
            slotIndex = this.lastAuto
          }
        }
      } else {
        if (this.lastAuto === null) {
          slotIndex = this.autoCounter
          this.autoCounter += 1
        } else {
          slotIndex = this.lastAuto
        }
      }
    }
    slotIndex = slotIndex ?? 0
    const slot = this.slots.get(slotIndex) ?? { id: '', name: '', args: '' }
    if (id) slot.id = id
    if (name) slot.name = name
    if (args) slot.args += args
    this.slots.set(slotIndex, slot)
    this.lastAuto = slotIndex
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
  // The output cap field is a per-provider quirk: OpenAI's newer models
  // reject the legacy max_tokens parameter.
  body[compat(request.provider.id).maxTokensField ?? 'max_tokens'] = request.model.limit.output
  applyReasoning(body, request)

  const headers: Record<string, string> = { 'content-type': 'application/json' }
  // Keyless providers (local servers) get no auth header at all.
  if (endpoint.auth === 'api-key') {
    if (request.apiKey) headers['api-key'] = request.apiKey
  } else if (request.apiKey) {
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
    if (chunk.error) {
      // A mid-stream failure ends the answer here; throwing (rather than
      // ending silently) lets the retry/backoff layer decide whether the
      // turn can restart, and surfaces the reason when it cannot.
      throw new ProviderError('http', chunk.error.message ?? 'stream error')
    }
    const delta = chunk.choices?.[0]?.delta
    if (delta?.content) {
      text += delta.content
      request.onDelta(delta.content)
    }
    for (const part of delta?.tool_calls ?? []) {
      collector.add(part.index, part.id, part.function?.name, part.function?.arguments)
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
  // Azure routes through a per-deployment path on the resource root.
  return `${endpoint.base}/deployments/${encodeURIComponent(
    request.model.id
  )}/chat/completions?api-version=${AZURE_API_VERSION}`
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
    switch (compat(request.provider.id).thinkingFormat) {
      case 'zai':
        body.thinking = { type: 'enabled' }
        break
      case 'openrouter':
        body.reasoning = { enabled: true }
        break
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
    'anthropic-version': '2023-06-01'
  }
  if (request.apiKey) {
    headers['x-api-key'] = request.apiKey
    // Anthropic-compatible gateways (MiniMax, Tinker, ...) authenticate with
    // a Bearer token instead of x-api-key; both carry the same key.
    if (request.provider.id !== 'anthropic') {
      headers.authorization = `Bearer ${request.apiKey}`
    }
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
  const toolBlocks = new Map<number, { id: string; name: string; json: string; seeded: boolean }>()
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
      // Gateways may inline the full input instead of streaming json deltas.
      const seed = (payload.content_block as { input?: unknown }).input
      const initial =
        seed && typeof seed === 'object' && Object.keys(seed as object).length > 0
          ? JSON.stringify(seed)
          : ''
      toolBlocks.set(payload.index ?? 0, {
        id: payload.content_block.id ?? '',
        name: payload.content_block.name ?? '',
        json: initial,
        seeded: initial !== ''
      })
    }
    if (event.event === 'content_block_delta') {
      if (payload.delta?.type === 'text_delta' && payload.delta.text) {
        text += payload.delta.text
        request.onDelta(payload.delta.text)
      }
      if (payload.delta?.type === 'input_json_delta' && payload.delta.partial_json) {
        const block = toolBlocks.get(payload.index ?? 0)
        if (block) {
          // Deltas supersede an inlined input: mixing the two would weld a
          // full JSON document onto its own fragments and break the parse.
          if (block.seeded) {
            block.json = ''
            block.seeded = false
          }
          block.json += payload.delta.partial_json
        }
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
  // Anthropic rejects consecutive same-role messages, so blocks merge into
  // the previous turn when the flattening produces two in a row (time notes,
  // wrap-up nudges, queued tool results after text).
  const push = (role: 'user' | 'assistant', blocks: Array<Record<string, unknown>>): void => {
    const last = out[out.length - 1]
    if (last && last.role === role) {
      last.content = [...(last.content as Array<Record<string, unknown>>), ...blocks]
      return
    }
    out.push({ role, content: blocks })
  }
  for (const message of request.messages) {
    if (message.role === 'assistant') {
      const blocks: Array<Record<string, unknown>> = []
      if (message.content) blocks.push({ type: 'text', text: message.content })
      for (const call of message.toolCalls ?? []) {
        blocks.push({ type: 'tool_use', id: call.id, name: call.name, input: call.input })
      }
      if (blocks.length) push('assistant', blocks)
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
    if (blocks.length) push('user', blocks)
  }
  return out
}

/** Somewhere between the model floor and a quarter of its output window. */
function defaultBudget(model: ModelEntry): number {
  return Math.min(16_000, Math.max(ANTHROPIC_MIN_BUDGET, Math.floor(model.limit.output / 4)))
}

/* ---------- shared plumbing ---------- */

function requireEndpoint(provider: ProviderEntry, model: ModelEntry): Endpoint {
  const resolution: EndpointResolution = resolveEndpoint(provider, model)
  if (resolution.kind === 'ok') return resolution.endpoint
  if (resolution.kind === 'missing-env') {
    throw new ProviderError(
      'no-endpoint',
      `${provider.name} needs the ${resolution.variable} environment variable to build its endpoint.`
    )
  }
  throw new ProviderError('no-endpoint', `No API endpoint is known for ${provider.name}.`)
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
          // SSE strips one leading space, no more — payloads can start with whitespace.
          dataLines.push(line.slice(5).replace(/^ /, ''))
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
