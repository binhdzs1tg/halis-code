import type { ChatMessage, StreamRequest, StreamResponse, ToolCall, ToolSpec } from './types.js'

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    /** Wait the server asked for via Retry-After, when it sent one. */
    readonly retryAfterMs?: number,
  ) {
    super(message)
    this.name = 'ProviderError'
  }
}

const RETRYABLE = new Set([429, 500, 502, 503, 504])
const RETRY_DELAYS = [800, 2000, 4500]

/** A provider that accepts the connection and then stalls must not park
 *  the run forever. Every stream carries an idle deadline, re-armed as
 *  data arrives; tripping it fails the attempt as a retryable network
 *  error, so the backoff layer decides what happens next. */
const STREAM_IDLE_MS = 120_000

/** Anthropic requires the thinking budget to stay below max_tokens. */
const ANTHROPIC_MIN_BUDGET = 1024

/** Reasoning knobs the caller can attach to a request, derived from a
 *  catalog model variant. Shapes differ per wire protocol. */
export interface ProviderVariant {
  reasoningEffort?: string
  thinking?: boolean
  budgetTokens?: number
  body?: Record<string, unknown>
  headers?: Record<string, string>
}

/**
 * Per-provider wire quirks, one table instead of scattered conditionals.
 * Everything falls back to the generic OpenAI-compatible behavior.
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

const compat = (providerId: string | undefined): ProviderCompat =>
  providerId ? (PROVIDER_COMPAT[providerId] ?? {}) : {}

interface WireMessage {
  role: string
  content: string | null
  tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>
  tool_call_id?: string
}

function toWire(message: ChatMessage): WireMessage {
  if (message.role === 'assistant' && message.toolCalls && message.toolCalls.length > 0) {
    return {
      role: 'assistant',
      content: message.content || null,
      tool_calls: message.toolCalls.map((call) => ({
        id: call.id,
        type: 'function' as const,
        function: { name: call.name, arguments: JSON.stringify(call.input) },
      })),
    }
  }
  if (message.role === 'tool') {
    return {
      role: 'tool',
      content: message.content,
      tool_call_id: message.toolCallId ?? '',
    }
  }
  return { role: message.role, content: message.content }
}

interface DeltaToolCall {
  index: number
  id?: string
  function?: { name?: string; arguments?: string }
}

interface WireChunk {
  choices?: Array<{ delta?: { content?: string | null; tool_calls?: DeltaToolCall[] } }>
  /** Providers report mid-stream failures as a data event with no choices. */
  error?: { type?: string; code?: string | number; message?: string }
  usage?: { prompt_tokens?: number; completion_tokens?: number } | null
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

function withIdleGuard(signal: AbortSignal): {
  signal: AbortSignal
  arm: () => void
  dispose: () => void
} {
  const controller = new AbortController()
  if (signal.aborted) {
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
        new ProviderError(
          `provider sent nothing for ${Math.round(STREAM_IDLE_MS / 1000)}s — connection stalled`,
          503,
        ),
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

export async function streamChat(req: StreamRequest): Promise<StreamResponse> {
  const body: Record<string, unknown> =
    req.protocol === 'anthropic' ? anthropicBody(req) : openAiBody(req)

  let lastError: ProviderError | undefined
  for (let attempt = 0; attempt <= RETRY_DELAYS.length; attempt++) {
    if (attempt > 0) {
      const asked = lastError?.retryAfterMs
      await sleep(asked && asked > 0 ? Math.min(asked, 30_000) : (RETRY_DELAYS[attempt - 1] ?? 1000))
      if (req.signal.aborted) throw new DOMException('aborted', 'AbortError')
    }
    try {
      return await attemptOnce(req, body)
    } catch (err) {
      if (req.signal.aborted) throw new DOMException('aborted', 'AbortError')
      if (err instanceof Error && err.name === 'AbortError') throw err
      if (!(err instanceof ProviderError) || err.status === undefined) throw err
      if (err.status === 400 && body.stream_options !== undefined) {
        // Some providers reject the usage extension outright — drop it and go on
        delete body.stream_options
        continue
      }
      if (!RETRYABLE.has(err.status)) throw err
      lastError = err
    }
  }
  throw lastError ?? new ProviderError('request failed')
}

/** The OpenAI-compatible chat completions request body. */
function openAiBody(req: StreamRequest): Record<string, unknown> {
  const wire: WireMessage[] = [
    { role: 'system', content: req.system },
    ...req.messages.filter((m) => m.role !== 'system').map(toWire),
  ]
  const body: Record<string, unknown> = {
    model: req.model,
    stream: true,
    messages: wire,
    [compat(req.providerId).maxTokensField ?? 'max_tokens']: req.maxTokens ?? 32_768,
  }
  const tools: ToolSpec[] | undefined = req.tools && req.tools.length > 0 ? req.tools : undefined
  if (tools) {
    body.tools = tools.map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }))
    body.tool_choice = 'auto'
  }
  if (req.wantUsage) body.stream_options = { include_usage: true }
  applyReasoning(body, req)
  if (req.extraBody) Object.assign(body, req.extraBody)
  return body
}

/** Map reasoning variants onto the OpenAI-compatible body shape. */
function applyReasoning(body: Record<string, unknown>, req: StreamRequest): void {
  const variant = req.variant
  if (!variant) return
  if (variant.reasoningEffort) {
    body.reasoning_effort = variant.reasoningEffort
    // No early return — a variant may carry both an effort level and body
    // overrides, and dropping the body silently changed the wire request.
  }
  if (variant.thinking) {
    switch (compat(req.providerId).thinkingFormat) {
      case 'zai':
        body.thinking = { type: 'enabled' }
        break
      case 'openrouter':
        body.reasoning = { enabled: true }
        break
    }
  }
  if (variant.body) Object.assign(body, variant.body)
}

async function attemptOnce(req: StreamRequest, body: Record<string, unknown>): Promise<StreamResponse> {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (req.protocol === 'anthropic') {
    headers['anthropic-version'] = '2023-06-01'
    if (req.apiKey) {
      headers['x-api-key'] = req.apiKey
      // Anthropic-compatible gateways authenticate with a Bearer token
      // instead of x-api-key; both carry the same key.
      if (req.providerId !== 'anthropic') headers.authorization = `Bearer ${req.apiKey}`
    }
  } else if (req.apiKey) {
    headers.authorization = `Bearer ${req.apiKey}`
  }
  if (req.variant?.headers) Object.assign(headers, req.variant.headers)
  if (req.extraHeaders) Object.assign(headers, req.extraHeaders)

  const path = req.protocol === 'anthropic' ? '/messages' : '/chat/completions'
  let res: Response
  const guard = withIdleGuard(req.signal)
  try {
    res = await fetch(`${req.baseUrl.replace(/\/+$/, '')}${path}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: guard.signal,
    })
    if (!res.ok) throw await failResponse(res)

    return req.protocol === 'anthropic' ? await readAnthropic(res, req, guard.arm) : await readOpenAi(res, req, guard.arm)
  } catch (err) {
    if (req.signal.aborted) throw new DOMException('aborted', 'AbortError')
    if (err instanceof Error && err.name === 'AbortError') {
      // A stalled stream aborts through the same controller; surface the
      // underlying reason instead of a bare AbortError when it was ours.
      if (signalReason(err) instanceof ProviderError) throw signalReason(err)
      throw new DOMException('aborted', 'AbortError')
    }
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'TypeError')) {
      throw new ProviderError(`network error: ${err.message}`)
    }
    throw err
  } finally {
    guard.dispose()
  }
}

function signalReason(err: Error): unknown {
  return (err as { reason?: unknown }).reason
}

async function failResponse(res: Response): Promise<ProviderError> {
  let detail = ''
  try {
    const text = (await res.text()).slice(0, 800)
    try {
      const parsed = JSON.parse(text) as { error?: { message?: string } | string }
      detail = typeof parsed.error === 'string' ? parsed.error : (parsed.error?.message ?? '')
    } catch {
      detail = text.trim()
    }
  } catch {
    // body already consumed; the status summary is enough
  }
  const message = `http ${res.status} ${res.statusText}${detail ? `: ${detail}` : ''}`
  return new ProviderError(message, res.status, parseRetryAfter(res.headers.get('retry-after')))
}

/** Seconds or an HTTP-date, the two spellings Retry-After allows. */
function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined
  const trimmed = value.trim()
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000
  const asDate = Date.parse(trimmed)
  return Number.isFinite(asDate) ? Math.max(0, asDate - Date.now()) : undefined
}

interface SseEvent {
  event: string
  data: string
}

/** Incremental server-sent-events reader over a fetch body stream. */
async function* readSse(response: Response): AsyncGenerator<SseEvent> {
  const body = response.body
  if (!body) throw new ProviderError('response has no body to stream', response.status)
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
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let newlineAt = buffer.indexOf('\n')
      while (newlineAt !== -1) {
        const line = buffer.slice(0, newlineAt).replace(/\r$/, '')
        buffer = buffer.slice(newlineAt + 1)
        newlineAt = buffer.indexOf('\n')
        if (line === '') {
          // Blank line = event terminator per the SSE spec; this is the
          // only point where a complete event may be handed on.
          const event = take()
          if (event) yield event
        } else if (line.startsWith('event:')) {
          eventName = line.slice(6).trim()
        } else if (line.startsWith('data:')) {
          dataLines.push(line.slice(5).trimStart())
        }
      }
    }
    const tail = take()
    if (tail) yield tail
  } finally {
    void reader.cancel().catch(() => undefined)
  }
}

/** Status for a mid-stream error event: deterministic ones fail fast,
 *  transient ones keep the retry budget. */
function streamErrorStatus(error: { type?: string; code?: string | number; message?: string } | undefined): number {
  const kind = `${error?.type ?? ''} ${error?.code ?? ''} ${error?.message ?? ''}`
  if (/overloaded|timeout|rate.?limit|unavailable|bad.?gateway|service|temporar|try again/i.test(kind)) {
    return 503
  }
  return 400
}

/** Arguments fragments → tool calls, tolerating index-less providers and
 *  double-encoded argument strings. */
class ToolCallCollector {
  private slots = new Map<number, { id: string; name: string; args: string }>()
  private lastAuto: number | null = null
  private autoCounter = 0

  add(index: number | undefined, id: string | undefined, name: string | undefined, args: string | undefined): void {
    let slotIndex = index
    if (slotIndex === undefined) {
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

  calls(): ToolCall[] {
    return [...this.slots.entries()]
      .sort(([a], [b]) => a - b)
      .filter(([, slot]) => slot.name.length > 0)
      .map(([index, slot], position) => ({
        id: slot.id || `call-${index}`,
        name: slot.name,
        input: parseInput(slot.args, `call-${index}-${position}`),
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

async function readOpenAi(
  res: Response,
  req: StreamRequest,
  arm: () => void,
): Promise<StreamResponse> {
  let text = ''
  const collector = new ToolCallCollector()
  let usage: { input: number; output: number } | undefined

  for await (const event of readSse(res)) {
    arm()
    if (event.data === '[DONE]') break
    let chunk: WireChunk
    try {
      chunk = JSON.parse(event.data) as WireChunk
    } catch {
      continue // keep-alive noise or a stray line
    }
    if (chunk.error) {
      throw new ProviderError(
        chunk.error.message ?? 'stream error',
        streamErrorStatus(chunk.error),
      )
    }
    if (chunk.usage && (chunk.usage.prompt_tokens !== undefined || chunk.usage.completion_tokens !== undefined)) {
      usage = {
        input: chunk.usage.prompt_tokens ?? 0,
        output: chunk.usage.completion_tokens ?? 0,
      }
    }
    const delta = chunk.choices?.[0]?.delta
    if (!delta) continue
    if (delta.content) {
      text += delta.content
      req.onDelta?.(delta.content)
    }
    for (const tc of delta.tool_calls ?? []) {
      collector.add(tc.index, tc.id, tc.function?.name, tc.function?.arguments)
    }
  }

  const toolCalls = collector.calls()
  return { text, toolCalls, ...(usage ? { usage } : {}) }
}

/* ---------- Anthropic messages ---------- */

interface AnthropicStreamEvent {
  type?: string
  index?: number
  content_block?: { type?: string; id?: string; name?: string; data?: string; input?: unknown }
  delta?: { type?: string; text?: string; partial_json?: string; thinking?: string; signature?: string }
  error?: { type?: string; code?: string | number; message?: string }
  message?: { usage?: { input_tokens?: number; output_tokens?: number } }
  usage?: { output_tokens?: number }
}

/** The Anthropic /messages request body, built from the flat chat transcript. */
function anthropicBody(req: StreamRequest): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: req.model,
    max_tokens: req.maxTokens ?? 32_768,
    stream: true,
    system: req.system,
    messages: toAnthropicMessages(req),
  }
  if (req.tools && req.tools.length > 0) {
    body.tools = req.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.parameters,
    }))
  }
  const variant = req.variant
  if (variant?.thinking || variant?.budgetTokens) {
    // Anthropic demands budget_tokens < max_tokens strictly. A tiny output
    // window cannot host a thinking budget at all — skip thinking instead
    // of sending a request the API is guaranteed to refuse.
    const ceiling = (req.maxTokens ?? 32_768) - 1
    if (ceiling >= ANTHROPIC_MIN_BUDGET) {
      const requested = variant.budgetTokens ?? defaultBudget(req.maxTokens ?? 32_768)
      body.thinking = { type: 'enabled', budget_tokens: Math.min(requested, ceiling) }
    }
  }
  if (variant?.body) Object.assign(body, variant.body)
  if (req.extraBody) Object.assign(body, req.extraBody)
  return body
}

/** Somewhere between the model floor and a quarter of its output window. */
function defaultBudget(maxTokens: number): number {
  return Math.min(16_000, Math.max(ANTHROPIC_MIN_BUDGET, Math.floor(maxTokens / 4)))
}

/** Flatten the chat transcript into Anthropic content blocks. Tool results
 *  ride in user turns; consecutive same-role turns merge, because Anthropic
 *  rejects two user (or two assistant) messages back to back. */
function toAnthropicMessages(req: StreamRequest): unknown[] {
  const out: Array<Record<string, unknown>> = []
  const push = (role: 'user' | 'assistant', blocks: Array<Record<string, unknown>>): void => {
    const last = out[out.length - 1]
    if (last && last.role === role) {
      last.content = [...(last.content as Array<Record<string, unknown>>), ...blocks]
      return
    }
    out.push({ role, content: blocks })
  }
  for (const message of req.messages) {
    if (message.role === 'system') continue
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
    if (message.role === 'tool') {
      blocks.push({
        type: 'tool_result',
        tool_use_id: message.toolCallId ?? '',
        content: message.content,
      })
    } else if (message.content) {
      blocks.push({ type: 'text', text: message.content })
    }
    if (blocks.length) push('user', blocks)
  }
  return out
}

async function readAnthropic(
  res: Response,
  req: StreamRequest,
  arm: () => void,
): Promise<StreamResponse> {
  let text = ''
  let inputTokens = 0
  let outputTokens = 0
  const toolBlocks = new Map<number, { id: string; name: string; json: string; seeded: boolean }>()
  type ThinkingSlot = { kind: 'thinking'; thinking: string; signature: string } | { kind: 'redacted'; data: string }
  const thinkingSlots = new Map<number, ThinkingSlot>()

  for await (const event of readSse(res)) {
    arm()
    let payload: AnthropicStreamEvent
    try {
      payload = JSON.parse(event.data) as AnthropicStreamEvent
    } catch {
      continue
    }
    // Gateways that re-emit bare `data:` frames lose the SSE event name —
    // the payload's own type field carries the same signal, so fall back
    // to it instead of dropping every frame on the floor.
    const type = event.event === 'message' ? (payload.type ?? 'message') : event.event
    // A failure frame must read as an error wherever it appears, the same
    // way the OpenAI reader checks chunk.error on every chunk.
    if (type === 'error' || payload.error) {
      throw new ProviderError(payload.error?.message ?? 'stream error', streamErrorStatus(payload.error))
    }
    if (type === 'message_start' && payload.message?.usage?.input_tokens) {
      inputTokens = payload.message.usage.input_tokens
    }
    if (type === 'message_delta' && payload.usage?.output_tokens) {
      outputTokens = payload.usage.output_tokens
    }
    if (type === 'message_stop') break
    if (type === 'content_block_start' && payload.content_block?.type === 'tool_use') {
      // Gateways may inline the full input instead of streaming json deltas.
      const seed = payload.content_block.input
      const initial =
        seed && typeof seed === 'object' && Object.keys(seed as object).length > 0 ? JSON.stringify(seed) : ''
      toolBlocks.set(payload.index ?? 0, {
        id: payload.content_block.id ?? '',
        name: payload.content_block.name ?? '',
        json: initial,
        seeded: initial !== '',
      })
    }
    if (type === 'content_block_start' && payload.content_block?.type === 'thinking') {
      thinkingSlots.set(payload.index ?? 0, { kind: 'thinking', thinking: '', signature: '' })
    }
    if (type === 'content_block_start' && payload.content_block?.type === 'redacted_thinking') {
      thinkingSlots.set(payload.index ?? 0, { kind: 'redacted', data: payload.content_block.data ?? '' })
    }
    if (type === 'content_block_delta') {
      const delta = payload.delta ?? {}
      if (delta.type === 'text_delta' && delta.text) {
        text += delta.text
        req.onDelta?.(delta.text)
      }
      if (delta.type === 'thinking_delta' && delta.thinking) {
        const slot = thinkingSlots.get(payload.index ?? 0)
        if (slot && slot.kind === 'thinking') slot.thinking += delta.thinking
      }
      if (delta.type === 'signature_delta' && delta.signature) {
        const slot = thinkingSlots.get(payload.index ?? 0)
        if (slot && slot.kind === 'thinking') slot.signature += delta.signature
      }
      if (delta.type === 'input_json_delta' && delta.partial_json) {
        const block = toolBlocks.get(payload.index ?? 0)
        if (block) {
          // Deltas supersede an inlined input: mixing the two would weld a
          // full JSON document onto its own fragments and break the parse.
          if (block.seeded) {
            block.json = ''
            block.seeded = false
          }
          block.json += delta.partial_json
        }
      }
    }
  }

  const toolCalls: ToolCall[] = [...toolBlocks.entries()]
    .sort(([a], [b]) => a - b)
    .map(([index, block]) => ({
      id: block.id || `call-${index}`,
      name: block.name,
      input: parseInput(block.json, `call-${index}`),
    }))
    .filter((call) => call.name.length > 0)

  const thinkingBlocks = [...thinkingSlots.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, slot]) =>
      slot.kind === 'redacted'
        ? { thinking: '', signature: '', redactedData: slot.data }
        : { thinking: slot.thinking, signature: slot.signature },
    )

  const usage =
    inputTokens > 0 || outputTokens > 0 ? { input: inputTokens, output: outputTokens } : undefined
  return {
    text,
    toolCalls,
    ...(thinkingBlocks.length > 0 ? { thinkingBlocks } : {}),
    ...(usage ? { usage } : {}),
  }
}
