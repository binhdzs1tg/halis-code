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
  /** Anthropic thinking blocks from this assistant turn, replayed verbatim. */
  thinkingBlocks?: ProviderThinkingBlock[]
}

/** One thinking (or redacted_thinking) block, kept for the tool loop. */
export interface ProviderThinkingBlock {
  thinking: string
  signature: string
  /** Opaque payload when the model emitted a redacted_thinking block instead. */
  redactedData?: string
}

export interface ProviderStreamResult {
  /** Full assistant text; the same chunks were already delivered via onDelta. */
  text: string
  /** Tool calls requested by the model, empty for plain answers. */
  toolCalls: ProviderToolCall[]
  /** Thinking blocks to replay when this turn continues with tool results. */
  thinkingBlocks?: ProviderThinkingBlock[]
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
    readonly status?: number,
    /** Wait the server asked for via Retry-After, when it sent one. */
    readonly retryAfterMs?: number
  ) {
    super(message)
    this.name = 'ProviderError'
  }
}

/** Anthropic requires the thinking budget to stay below max_tokens. */
const ANTHROPIC_MIN_BUDGET = 1024

/** A provider that accepts the connection and then stalls must not park
 *  the run forever. Every stream carries an idle deadline, re-armed as
 *  data arrives; tripping it fails the attempt as a retryable network
 *  error, so the backoff layer decides what happens next. */
const STREAM_IDLE_MS = 120_000

function withIdleGuard(signal: AbortSignal): {
  signal: AbortSignal
  arm: () => void
  dispose: () => void
} {
  const controller = new AbortController()
  if (signal.aborted) {
    // Cancelled while the request was being prepared: fail immediately,
    // never start the real network call after Stop.
    controller.abort(signal.reason)
    return { signal: controller.signal, arm: () => undefined, dispose: () => undefined }
  }
  const onOuter = (): void => controller.abort(signal.reason)
  signal.addEventListener('abort', onOuter, { once: true })
  let timer: ReturnType<typeof setTimeout> | null = null
  const arm = (): void => {
    if (timer !== null) clearTimeout(timer)
    timer = setTimeout(() => {
      controller.abort(
        new ProviderError('network', `provider sent nothing for ${Math.round(STREAM_IDLE_MS / 1000)}s — connection stalled`)
      )
    }, STREAM_IDLE_MS)
  }
  const dispose = (): void => {
    signal.removeEventListener('abort', onOuter)
    if (timer !== null) clearTimeout(timer)
  }
  arm()
  return { signal: controller.signal, arm, dispose }
}

/**
 * Per-provider wire quirks, one table instead of scattered conditionals.
 * Fields stay optional;
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
    if (err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError')) {
      // AbortSignal.timeout() aborts with a DOMException named TimeoutError,
      // not AbortError — both mean the request was cut on purpose and must
      // not come back labeled as a retryable network fault.
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
  error?: { type?: string; code?: string | number; message?: string }
}

/**
 * Status for a mid-stream error event. Some are the provider's
 * deterministic verdict (bad request, context length) and must not burn
 * the retry budget; others are transient (overloaded, gateway hiccup) and
 * previously recovered through the backoff — keep that working.
 */
function streamErrorStatus(error: { type?: string; code?: string | number; message?: string } | undefined): number {
  const kind = `${error?.type ?? ''} ${error?.code ?? ''} ${error?.message ?? ''}`
  if (/overloaded|timeout|rate.?limit|unavailable|bad.?gateway|service|temporar|try again/i.test(kind)) {
    return 503
  }
  return 400
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
    let parsed: unknown = JSON.parse(raw)
    // Double-encoded arguments — a JSON string holding JSON — unwrap once.
    if (typeof parsed === 'string' && parsed.trim().length > 0) {
      try {
        const inner: unknown = JSON.parse(parsed)
        if (typeof inner === 'object' && inner !== null) parsed = inner
      } catch {
        // genuinely a string; nothing to unwrap
      }
    }
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

  const guard = withIdleGuard(request.signal)
  try {
    const response = await fetch(openAiUrl(request, endpoint), {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: guard.signal
    })
    if (!response.ok) {
      await failResponse(response, request.provider)
    }

    let text = ''
    const collector = new ToolCallCollector()
    for await (const event of readSse(response)) {
      guard.arm()
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
        throw new ProviderError('http', chunk.error.message ?? 'stream error', streamErrorStatus(chunk.error))
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
  } finally {
    guard.dispose()
  }
}

/** Flatten the internal message shape into the OpenAI wire format. */
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
  content_block?: { type?: string; id?: string; name?: string; data?: string }
  delta?: { type?: string; text?: string; partial_json?: string; thinking?: string; signature?: string }
  error?: { type?: string; code?: string | number; message?: string }
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
    // Anthropic demands budget_tokens < max_tokens strictly. A tiny output
    // window cannot host a thinking budget at all — skip thinking instead
    // of sending a request the API is guaranteed to refuse.
    const ceiling = request.model.limit.output - 1
    if (ceiling >= ANTHROPIC_MIN_BUDGET) {
      const requested = variant?.budgetTokens ?? defaultBudget(request.model)
      body.thinking = {
        type: 'enabled',
        budget_tokens: Math.min(requested, ceiling)
      }
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

  const guard = withIdleGuard(request.signal)
  try {
    const response = await fetch(`${endpoint.base}/messages`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: guard.signal
    })
    if (!response.ok) {
      await failResponse(response, request.provider)
    }

    let text = ''
    const toolBlocks = new Map<number, { id: string; name: string; json: string; seeded: boolean }>()
    type ThinkingSlot = { kind: 'thinking'; thinking: string; signature: string } | { kind: 'redacted'; data: string }
    const thinkingSlots = new Map<number, ThinkingSlot>()
    for await (const event of readSse(response)) {
      guard.arm()
      let payload: AnthropicStreamEvent
      try {
        payload = JSON.parse(event.data) as AnthropicStreamEvent
      } catch {
        continue
      }
      if (event.event === 'error') {
        // Same treatment as the OpenAI path: deterministic provider errors
        // fail fast, transient ones keep the retry budget.
        throw new ProviderError('http', payload.error?.message ?? 'stream error', streamErrorStatus(payload.error))
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
    if (event.event === 'content_block_start' && payload.content_block?.type === 'thinking') {
      thinkingSlots.set(payload.index ?? 0, { kind: 'thinking', thinking: '', signature: '' })
    }
    if (event.event === 'content_block_start' && payload.content_block?.type === 'redacted_thinking') {
      thinkingSlots.set(payload.index ?? 0, {
        kind: 'redacted',
        data: payload.content_block.data ?? ''
      })
    }
    if (event.event === 'content_block_delta') {
      if (payload.delta?.type === 'text_delta' && payload.delta.text) {
        text += payload.delta.text
        request.onDelta(payload.delta.text)
      }
      if (payload.delta?.type === 'thinking_delta' && payload.delta.thinking) {
        const slot = thinkingSlots.get(payload.index ?? 0)
        if (slot && slot.kind === 'thinking') slot.thinking += payload.delta.thinking
      }
      if (payload.delta?.type === 'signature_delta' && payload.delta.signature) {
        const slot = thinkingSlots.get(payload.index ?? 0)
        if (slot && slot.kind === 'thinking') slot.signature += payload.delta.signature
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
  const thinkingBlocks: ProviderThinkingBlock[] = [...thinkingSlots.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, slot]) =>
      slot.kind === 'redacted'
        ? { thinking: '', signature: '', redactedData: slot.data }
        : { thinking: slot.thinking, signature: slot.signature }
    )
  return { text, toolCalls, ...(thinkingBlocks.length > 0 ? { thinkingBlocks } : {}) }
  } finally {
    guard.dispose()
  }
}

/** Flatten the internal message shape into Anthropic content blocks. */
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
      // Thinking blocks lead the turn: Anthropic requires them ahead of
      // text and tool_use whenever extended thinking is on.
      for (const block of message.thinkingBlocks ?? []) {
        if (block.redactedData !== undefined) {
          blocks.push({ type: 'redacted_thinking', data: block.redactedData })
        } else if (block.thinking || block.signature) {
          blocks.push({ type: 'thinking', thinking: block.thinking, signature: block.signature })
        }
      }
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
    const text = await readErrorBody(response)
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
  throw new ProviderError(
    'http',
    detail ? `${summary}: ${detail}` : summary,
    response.status,
    parseRetryAfter(response.headers.get('retry-after'))
  )
}

/** Seconds or an HTTP-date, the two spellings Retry-After allows. */
function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined
  const trimmed = value.trim()
  if (/^\d+$/.test(trimmed)) {
    return Number(trimmed) * 1000
  }
  const asDate = Date.parse(trimmed)
  return Number.isFinite(asDate) ? Math.max(0, asDate - Date.now()) : undefined
}

/** Error bodies are hostile input: cap the read so a broken or lying
 *  endpoint cannot stream gigabytes into the main process. */
const MAX_ERROR_BODY_BYTES = 64 * 1024

async function readErrorBody(response: Response): Promise<string> {
  const reader = response.body?.getReader()
  if (!reader) return ''
  try {
    const chunks: Uint8Array[] = []
    let total = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (value) {
        chunks.push(value)
        total += value.length
        if (total >= MAX_ERROR_BODY_BYTES) break
      }
    }
    const bytes = new Uint8Array(Math.min(total, MAX_ERROR_BODY_BYTES))
    let offset = 0
    for (const chunk of chunks) {
      if (offset >= bytes.length) break
      const slice = chunk.subarray(0, Math.min(chunk.length, bytes.length - offset))
      bytes.set(slice, offset)
      offset += slice.length
    }
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes)
  } finally {
    void reader.cancel().catch(() => undefined)
  }
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
    // Flush the decoder's multi-byte tail, then honor a final frame the
    // server left without its terminating newline — the last `data:` line
    // (often message_stop) would otherwise be silently dropped.
    buffer += decoder.decode()
    if (buffer.length > 0) {
      const line = buffer.replace(/\r$/, '')
      buffer = ''
      if (line === '') {
        const event = take()
        if (event) yield event
      } else if (line.startsWith('event:')) {
        eventName = line.slice(6).trim()
      } else if (line.startsWith('data:')) {
        dataLines.push(line.slice(5).replace(/^ /, ''))
      }
    }
    const tail = take()
    if (tail) yield tail
  } finally {
    void reader.cancel().catch(() => undefined)
  }
}
