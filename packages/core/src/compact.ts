import { estimateTokens } from './config.js'
import { streamChat } from './provider.js'
import type { ChatMessage } from './types.js'

/**
 * Transcript compaction: once the estimated token count crosses the
 * budget, the older part of the conversation is replaced by a single
 * model-written summary. The tail is kept verbatim so the current task
 * stays intact, and the cut point never splits a tool call from its
 * result — a dangling tool message would make the next request invalid.
 */

const SUMMARY_SYSTEM = [
  'You compress the transcript of a coding-agent session into a brief the agent can continue from.',
  'Write it as plain text with short sections: Task, Decisions, Files touched (exact paths),',
  'Commands run and their outcomes, Current state, Next steps.',
  'Keep every file path, command and error message exact. Under 400 words. No preamble.',
].join('\n')

/** Rough per-message cost in characters, used to size the verbatim tail. */
function messageChars(message: ChatMessage): number {
  return message.content.length + (message.toolCalls?.length ?? 0) * 64
}

/**
 * The highest index at or below `messages.length - minTail` where the kept
 * tail starts cleanly: not on a tool result, and not right after an
 * assistant message whose tool calls would be left unanswered. Returns 0
 * when no safe boundary exists.
 */
export function safeCut(messages: ChatMessage[], minTail: number): number {
  for (let i = Math.max(1, messages.length - minTail); i >= 1; i--) {
    const first = messages[i]
    if (!first || first.role === 'tool') continue
    const prev = messages[i - 1]
    if (prev && prev.role === 'assistant' && prev.toolCalls && prev.toolCalls.length > 0) continue
    return i
  }
  return 0
}

function renderForSummary(messages: ChatMessage[]): string {
  return messages
    .map((m) => {
      const calls = m.toolCalls?.map((c) => `tool_call ${c.name}(${JSON.stringify(c.input)})`).join('; ')
      const head = `[${m.role}] ${m.content}`
      return calls ? `${head}\n${calls}` : head
    })
    .join('\n\n')
}

export interface CompactOptions {
  messages: ChatMessage[]
  /** Token estimate that must be exceeded before anything happens. */
  compactAt: number
  provider: {
    baseUrl: string
    apiKey?: string
    model: string
    protocol?: 'openai' | 'anthropic'
    providerId?: string
    maxTokens?: number
  }
  signal: AbortSignal
}

/**
 * Compact `opts.messages` in place when it has outgrown the budget.
 * Returns the number of messages replaced (0 when no compaction ran).
 * Throws on provider failure — the caller decides how visible that is.
 */
export async function compactTranscript(opts: CompactOptions): Promise<number> {
  const { messages, compactAt, provider, signal } = opts
  if (compactAt <= 0) return 0
  if (estimateTokens(messages) <= compactAt) return 0

  const tailBudget = Math.max(500, Math.round(compactAt * 0.25))
  let tailStart = messages.length
  let tailChars = 0
  while (tailStart > 1 && tailChars < tailBudget * 4) {
    tailStart--
    tailChars += messageChars(messages[tailStart] as ChatMessage)
  }
  const cut = safeCut(messages, messages.length - tailStart)
  if (cut <= 0) return 0

  // Old tool results are the bulk of a long session and the summary does
  // not need their full text — bound them before the summarizer sees them,
  // so the summary call itself stays cheap (the deepseek harness trick).
  for (let i = 0; i < cut; i++) {
    const message = messages[i]
    if (message && message.role === 'tool' && message.content.length > PRUNE_AT) {
      messages[i] = { ...message, content: pruneToolText(message.content) }
    }
  }

  const summary = await summarize(messages.slice(0, cut), provider, signal)
  messages.splice(0, cut, {
    role: 'user',
    content:
      `<session-summary>\n${summary}\n</session-summary>\n\n` +
      'The messages above were replaced by this summary. The files on disk are unchanged — ' +
      're-read anything you need exactly, then continue the task.',
  })
  return cut
}

/** Old tool results beyond this size get the head/tail fold. */
const PRUNE_AT = 8_192

/** Keep the first and last stretch of a fat tool result; the middle goes. */
function pruneToolText(text: string): string {
  const head = text.slice(0, 4_096)
  const tail = text.slice(-1_024)
  return `${head}\n[… ${(text.length - 5_120).toLocaleString('en-US')} characters pruned for the summary …]\n${tail}`
}

async function summarize(
  prefix: ChatMessage[],
  provider: CompactOptions['provider'],
  signal: AbortSignal,
): Promise<string> {
  const transcript = renderForSummary(prefix)
  const res = await streamChat({
    baseUrl: provider.baseUrl,
    model: provider.model,
    system: SUMMARY_SYSTEM,
    messages: [{ role: 'user', content: transcript }],
    signal,
    ...(provider.protocol ? { protocol: provider.protocol } : {}),
    ...(provider.providerId ? { providerId: provider.providerId } : {}),
    ...(provider.maxTokens !== undefined ? { maxTokens: provider.maxTokens } : {}),
    ...(provider.apiKey ? { apiKey: provider.apiKey } : {}),
  })
  const text = res.text.trim()
  if (!text) throw new Error('compaction produced an empty summary')
  return text
}
