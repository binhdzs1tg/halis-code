import type { ChatMessage, StreamRequest, StreamResponse, ToolCall, ToolSpec } from './types.js'

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message)
    this.name = 'ProviderError'
  }
}

const RETRYABLE = new Set([429, 500, 502, 503, 504])
const RETRY_DELAYS = [800, 2000, 4500]

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
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

export async function streamChat(req: StreamRequest): Promise<StreamResponse> {
  const wire: WireMessage[] = [
    { role: 'system', content: req.system },
    ...req.messages.filter((m) => m.role !== 'system').map(toWire),
  ]
  const body: Record<string, unknown> = { model: req.model, stream: true, messages: wire }
  const tools: ToolSpec[] | undefined = req.tools && req.tools.length > 0 ? req.tools : undefined
  if (tools) {
    body.tools = tools.map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }))
  }

  let lastError: ProviderError | undefined
  for (let attempt = 0; attempt <= RETRY_DELAYS.length; attempt++) {
    if (attempt > 0) {
      await sleep(RETRY_DELAYS[attempt - 1] ?? 1000)
      if (req.signal.aborted) throw new DOMException('aborted', 'AbortError')
    }
    try {
      return await attemptOnce(req, body)
    } catch (err) {
      if (req.signal.aborted || !(err instanceof ProviderError) || err.status === undefined) throw err
      if (!RETRYABLE.has(err.status)) throw err
      lastError = err
    }
  }
  throw lastError ?? new ProviderError('request failed')
}

async function attemptOnce(req: StreamRequest, body: Record<string, unknown>): Promise<StreamResponse> {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (req.apiKey) headers.authorization = `Bearer ${req.apiKey}`

  let res: Response
  try {
    res = await fetch(`${req.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: req.signal,
    })
  } catch (err) {
    if (req.signal.aborted) throw new DOMException('aborted', 'AbortError')
    throw new ProviderError(`network error: ${String(err)}`)
  }

  if (!res.ok) {
    const text = (await res.text()).slice(0, 800)
    throw new ProviderError(`http ${res.status} ${res.statusText}${text ? `: ${text}` : ''}`, res.status)
  }
  if (!res.body) throw new ProviderError('empty response body', res.status)

  let text = ''
  const acc = new Map<number, { id: string; name: string; args: string }>()
  const decoder = new TextDecoder()
  let buffer = ''

  for await (const chunk of res.body) {
    buffer += decoder.decode(chunk as Uint8Array, { stream: true })
    let newlineAt = buffer.indexOf('\n')
    while (newlineAt !== -1) {
      const line = buffer.slice(0, newlineAt).trim()
      buffer = buffer.slice(newlineAt + 1)
      newlineAt = buffer.indexOf('\n')
      if (!line.startsWith('data:')) continue
      const payload = line.slice(5).trim()
      if (payload === '[DONE]') continue
      let parsed: WireChunk
      try {
        parsed = JSON.parse(payload) as WireChunk
      } catch {
        continue
      }
      const delta = parsed.choices?.[0]?.delta
      if (!delta) continue
      if (delta.content) {
        text += delta.content
        req.onDelta?.(delta.content)
      }
      for (const tc of delta.tool_calls ?? []) {
        const slot = acc.get(tc.index) ?? { id: '', name: '', args: '' }
        if (tc.id) slot.id = tc.id
        if (tc.function?.name) slot.name = tc.function.name
        if (tc.function?.arguments) slot.args += tc.function.arguments
        acc.set(tc.index, slot)
      }
    }
  }

  const toolCalls: ToolCall[] = [...acc.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, slot], i) => {
      let input: Record<string, unknown> = {}
      try {
        input = JSON.parse(slot.args || '{}') as Record<string, unknown>
      } catch {
        input = { _raw: slot.args }
      }
      return { id: slot.id || `call_${i}`, name: slot.name, input }
    })

  return { text, toolCalls }
}
