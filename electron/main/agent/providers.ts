import type { ModelEntry, ModelVariant, ProviderEntry } from '../../shared/models'
import { isUnsupported, resolveEndpoint, type Endpoint } from './endpoints'

export interface ProviderMessage {
  role: 'user' | 'assistant'
  content: string
}

export interface ProviderStreamRequest {
  provider: ProviderEntry
  model: ModelEntry
  variant: ModelVariant | null
  apiKey: string
  system: string
  messages: ProviderMessage[]
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

export async function streamChat(request: ProviderStreamRequest): Promise<void> {
  if (isUnsupported(request.provider.id)) {
    throw new ProviderError(
      'unsupported-provider',
      `${request.provider.name} needs signed or interactive authentication that is not supported yet.`
    )
  }
  try {
    if (request.provider.id === 'anthropic') {
      await streamAnthropic(request)
    } else {
      await streamOpenAiCompatible(request)
    }
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
  choices?: Array<{ delta?: { content?: string } }>
}

async function streamOpenAiCompatible(request: ProviderStreamRequest): Promise<void> {
  const endpoint = requireEndpoint(request.provider, request.model)
  const body: Record<string, unknown> = {
    model: request.model.id,
    messages: [{ role: 'system', content: request.system }, ...request.messages],
    stream: true
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

  for await (const event of readSse(response)) {
    if (event.data === '[DONE]') return
    let chunk: OpenAiChunk
    try {
      chunk = JSON.parse(event.data) as OpenAiChunk
    } catch {
      continue // keep-alive noise or a stray line
    }
    const content = chunk.choices?.[0]?.delta?.content
    if (content) request.onDelta(content)
  }
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
  delta?: { type?: string; text?: string }
  error?: { message?: string }
}

async function streamAnthropic(request: ProviderStreamRequest): Promise<void> {
  const endpoint = requireEndpoint(request.provider, request.model)
  const body: Record<string, unknown> = {
    model: request.model.id,
    max_tokens: request.model.limit.output,
    stream: true,
    system: request.system,
    messages: request.messages
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
    if (event.event === 'message_stop') return
    if (event.event === 'content_block_delta' && payload.delta?.type === 'text_delta') {
      const text = payload.delta.text
      if (text) request.onDelta(text)
    }
  }
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
