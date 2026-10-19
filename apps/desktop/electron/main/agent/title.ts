/**
 * Model-generated session titles: after the first exchange, one tool-less
 * completion condenses the
 * conversation into a few words. A failure here is silent — the derived
 * first-line title stays as the fallback.
 */
import type { ChatMessage, SessionTitleRequest, SessionTitleResult } from '../../shared/types'
import type { ModelSelection } from '../../shared/models'
import { streamChat } from './providers'
import { resolveModelTarget } from './run'

/** How much of each message the title call gets to see. */
const MAX_FIRST_MESSAGE_CHARS = 2_000
const MAX_LAST_REPLY_CHARS = 800

/** Titles longer than this are cut — a crumb, not a sentence. */
const MAX_TITLE_CHARS = 60

const TITLE_SYSTEM = [
  'You write short titles for coding chat sessions.',
  'Reply with the title only: 3 to 6 words, no surrounding quotes, no trailing punctuation,',
  'in the language of the conversation. Do not explain.'
].join(' ')

export async function generateSessionTitle(raw: unknown): Promise<SessionTitleResult> {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('session:title expects { history, model }')
  }
  const candidate = raw as Partial<SessionTitleRequest>
  if (!Array.isArray(candidate.history) || !isSelection(candidate.model)) {
    throw new Error('session:title expects { history, model }')
  }
  const history = candidate.history.filter(isChatMessage)
  const firstUser = history.find((message) => message.role === 'user')
  if (!firstUser) {
    throw new Error('session:title needs a user message to name the chat after')
  }
  const lastReply = [...history].reverse().find((message) => message.role === 'assistant')

  const target = await resolveModelTarget(candidate.model)
  if ('error' in target) {
    throw new Error(target.error.message)
  }

  const parts = [`<user_message>\n${clip(firstUser.content, MAX_FIRST_MESSAGE_CHARS)}\n</user_message>`]
  if (lastReply) {
    parts.push(`<assistant_reply>\n${clip(lastReply.content, MAX_LAST_REPLY_CHARS)}\n</assistant_reply>`)
  }
  const prompt = `Write a short title for this conversation.\n\n${parts.join('\n\n')}`

  const result = await streamChat({
    provider: target.provider,
    model: target.entry,
    variant: target.variant,
    apiKey: target.key.value,
    system: TITLE_SYSTEM,
    messages: [{ role: 'user', content: prompt }],
    // A title is a one-shot nicety: it must settle on its own instead of
    // parking the ipcMain.handle promise (and the renderer's await) forever.
    signal: AbortSignal.timeout(60_000),
    onDelta: () => undefined
  })
  const title = cleanTitle(result.text)
  if (!title) {
    throw new Error('The model returned an empty title.')
  }
  return { title }
}

/** First non-empty line, unquoted, unpunctuated, collapsed, capped. */
function cleanTitle(raw: string): string {
  const firstLine = raw
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.length > 0) ?? ''
  const stripped = firstLine
    .replace(/^["'\u2018\u2019\u201C\u201D]+|["'\u2018\u2019\u201C\u201D]+$/g, '')
    .replace(/[.!?:;]+$/g, '')
    .trim()
  const collapsed = stripped.replace(/\s+/g, ' ')
  if (collapsed.length <= MAX_TITLE_CHARS) return collapsed
  return `${collapsed.slice(0, MAX_TITLE_CHARS - 1).trimEnd()}\u2026`
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}\u2026` : text
}

function isChatMessage(value: unknown): value is ChatMessage {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Partial<ChatMessage>
  return (
    (candidate.role === 'user' || candidate.role === 'assistant' || candidate.role === 'system') &&
    typeof candidate.content === 'string'
  )
}

function isSelection(value: unknown): value is ModelSelection {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as ModelSelection).providerID === 'string' &&
    typeof (value as ModelSelection).modelID === 'string'
  )
}
