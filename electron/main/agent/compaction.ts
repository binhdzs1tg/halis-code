/**
 * Context compaction: when the built request would run past the model's
 * context pressure point, condense the older span into a structured
 * checkpoint and keep a verbatim tail: summarise at 80% of the window,
 * keep the most recent ~16% verbatim.
 */
import type { ModelEntry, ModelVariant, ProviderEntry } from '../../shared/models'
import { streamChat, type ProviderMessage } from './providers'

/** Fraction of the context window that triggers compaction. */
const THRESHOLD_RATIO = 0.8

/** Fraction of the context window kept verbatim as the tail. */
const RETAIN_RATIO = 0.16

/** Fallback window for models that report no context size. */
const FALLBACK_CONTEXT = 32_000

/**
 * Rough token cost of the tool schemas sent with every request. The specs
 * are pure overhead the message estimate cannot see; ignoring them made the
 * trigger fire too late for small-context models.
 */
const TOOL_SPEC_TOKEN_ESTIMATE = 3_000

/** Tags wrapping the structured summary inside the landed checkpoint. */
const SUMMARY_OPEN_TAG = '<compacted-summary>'
const SUMMARY_CLOSE_TAG = '</compacted-summary>'

/**
 * The summarization directive, delivered as the final user message after the
 * replayed conversation. Keeping the conversation's own system prompt and
 * message prefix in front makes the auxiliary call a genuine prefix of the
 * routed request, so the provider's KV cache is reused instead of invalidated.
 */
const COMPACTION_INSTRUCTION = [
  'You are now acting as a compaction engine for this AI coding assistant. Condense the conversation ABOVE into a structured checkpoint that lets another model resume the work with no loss of essential context.',
  '',
  'Output EXACTLY the Markdown structure below: keep every section, in order. Use terse bullets, not prose paragraphs. Write "(none)" for an empty section — never drop a section.',
  '',
  '## Primary Request and Intent',
  "- [the user's original and evolving goals; quote verbatim where the exact wording matters]",
  '',
  '## Key Technical Concepts',
  '- [technologies, frameworks, patterns, and conventions in play]',
  '',
  '## Files and Code',
  '- [exact path: why it matters, key changes or snippets]',
  '',
  '## Errors and Fixes',
  '- [error: how it was resolved, plus any related user feedback]',
  '',
  '## Pending Jobs',
  '- [explicitly requested work not yet completed]',
  '',
  '## Current Work',
  '- [precisely what was in progress at this checkpoint]',
  '',
  '## Next Step',
  '- [the single next action, directly in line with the most recent request, or "(none)"]',
  '',
  '## Critical Context',
  '- [decisions and their rationale, constraints, user preferences, open questions, data needed to continue]',
  '',
  'Rules:',
  '- Write concise English engineering prose. Preserve exact file paths, commands, error strings, identifiers, numeric values, function signatures, and syntax fragments.',
  '- Capture user feedback and explicit instructions faithfully, especially corrections.',
  '- Do NOT mention this summarization request or that the context was compacted.',
  '- Output only the checkpoint text: do not call any tool or take any other action.',
  `- If the conversation already contains a ${SUMMARY_OPEN_TAG} block, it is a PRIOR checkpoint. Do not copy it forward verbatim: preserve still-true facts, drop stale ones, and merge newer information into a single consolidated summary under the same structure.`
].join('\n')

/** Framing that makes the replacement user message established context. */
const CHECKPOINT_PREAMBLE =
  'This is an automatically generated checkpoint condensing an earlier span of the conversation to free up context. Treat the captured context as established background and build on it without restating it. Continue the task directly from the messages that follow, without acknowledging this checkpoint.'

/* ---------- deterministic tool-result pruning ---------- */

/** Oversized tool results get head+tail kept and the middle pruned away. */
const PRUNE_THRESHOLD_CHARS = 8_192
const PRUNE_HEAD_CHARS = 4_096
const PRUNE_TAIL_CHARS = 1_024
const PRUNE_MARKER = '\n\n[... tool result middle pruned ...]\n\n'

/**
 * Prune oversized tool results from earlier steps before any model call —
 * the same trick as compaction-tool-result-pruner: a deterministic pass
 * often frees enough context to skip summarization entirely. The newest
 * message is always left intact.
 */
export function pruneToolResults(messages: ProviderMessage[]): boolean {
  let pruned = false
  for (let i = 0; i < messages.length - 1; i += 1) {
    const message = messages[i]
    if (!message?.toolResults) continue
    for (const result of message.toolResults) {
      if (result.output.length <= PRUNE_THRESHOLD_CHARS) continue
      result.output =
        result.output.slice(0, PRUNE_HEAD_CHARS) +
        PRUNE_MARKER +
        result.output.slice(-PRUNE_TAIL_CHARS)
      pruned = true
    }
  }
  return pruned
}

/** Rough token estimate; ~4 characters per token is close enough for pressure math. */
export function estimateTokens(messages: readonly ProviderMessage[]): number {
  let chars = 0
  for (const message of messages) {
    chars += message.content.length
    for (const call of message.toolCalls ?? []) chars += JSON.stringify(call.input).length + 40
    for (const result of message.toolResults ?? []) chars += result.output.length + 24
    // Thinking blocks are replayed verbatim on every Anthropic request;
    // leaving them out would read the pressure far too low for thinking
    // models and delay compaction until the API refuses the request.
    for (const block of message.thinkingBlocks ?? []) {
      chars += block.thinking.length + block.signature.length + (block.redactedData?.length ?? 0)
    }
  }
  return Math.ceil(chars / 4)
}

function hasToolResults(message: ProviderMessage): boolean {
  return (message.toolResults?.length ?? 0) > 0
}

function hasToolCalls(message: ProviderMessage): boolean {
  return (message.toolCalls?.length ?? 0) > 0
}

/**
 * Split at a safe boundary: the tail never starts on tool results whose tool
 * calls were left behind, and the head never ends on tool calls whose results
 * are missing — both would read as a broken exchange to the provider.
 */
function splitForCompaction(
  messages: readonly ProviderMessage[],
  retainTokens: number
): { head: ProviderMessage[]; tail: ProviderMessage[] } {
  let start = messages.length
  let acc = 0
  while (start > 0) {
    const previous = messages[start - 1]
    if (!previous) break
    const cost = estimateTokens([previous])
    if (start < messages.length && acc + cost > retainTokens) break
    acc += cost
    start -= 1
  }
  // Walking back past tool results must stop at the first message: going
  // below zero would silently produce head=all-but-last, tail=[last].
  while (start > 0 && start < messages.length) {
    const candidate = messages[start]
    if (!candidate || !hasToolResults(candidate)) break
    start -= 1
  }
  while (start > 0) {
    const candidate = messages[start - 1]
    if (!candidate || !hasToolCalls(candidate)) break
    start -= 1
  }
  return { head: messages.slice(0, start), tail: messages.slice(start) }
}

export interface CompactionRequest {
  provider: ProviderEntry
  model: ModelEntry
  variant: ModelVariant | null
  apiKey: string
  /** The conversation's own system prompt, reused so the prefix stays warm. */
  system: string
  messages: ProviderMessage[]
  signal: AbortSignal
  /** Compact even when the estimate is under the pressure point. */
  force?: boolean
}

export interface CompactionOutcome {
  messages: ProviderMessage[]
  /** The framed checkpoint text on its own, for UI surfaces like /compact. */
  checkpoint: string
}

/**
 * Compact the request messages when they pass the model's pressure point.
 * Returns the replacement list plus the framed checkpoint, or null when
 * compaction was not needed or could not be produced — callers then proceed
 * with the original messages.
 */
export async function compactMessages(request: CompactionRequest): Promise<CompactionOutcome | null> {
  const context = request.model.limit.context || FALLBACK_CONTEXT
  const threshold = Math.floor(context * THRESHOLD_RATIO)
  const retain = Math.floor(context * RETAIN_RATIO)

  // The request also carries the system prompt and the tool schemas; counting
  // both keeps the trigger honest about the real payload size.
  const systemTokens = Math.ceil(request.system.length / 4) + TOOL_SPEC_TOKEN_ESTIMATE
  if (!request.force && estimateTokens(request.messages) + systemTokens < threshold) {
    return null
  }

  const { head, tail } = splitForCompaction(request.messages, retain)
  if (head.length === 0 || tail.length === 0) {
    return null
  }

  // The directive rides on the last head message when it is already a user
  // turn (Anthropic insists on alternating roles); otherwise it is appended.
  const instruction: ProviderMessage = { role: 'user', content: COMPACTION_INSTRUCTION }
  const last = head[head.length - 1]
  if (!last) return null
  const replay = [...head]
  if (last.role === 'user') {
    replay[replay.length - 1] = { ...last, content: `${last.content}\n\n${COMPACTION_INSTRUCTION}` }
  } else {
    replay.push(instruction)
  }

  let summary = ''
  try {
    const result = await streamChat({
      provider: request.provider,
      model: request.model,
      variant: request.variant,
      apiKey: request.apiKey,
      system: request.system,
      messages: replay,
      signal: request.signal,
      onDelta: (text) => {
        summary += text
      }
    })
    summary = result.text
  } catch {
    // Best effort: an unusable summary must never break the actual turn.
    return null
  }

  summary = summary.trim()
  if (!summary || request.signal.aborted) {
    return null
  }

  // Shrink validation from compaction-basic: a checkpoint that is not
  // actually smaller than the span it replaces is a failed compaction.
  const checkpoint = `${CHECKPOINT_PREAMBLE}\n\n${SUMMARY_OPEN_TAG}\n${summary}\n${SUMMARY_CLOSE_TAG}`
  if (estimateTokens([{ role: 'user', content: checkpoint }]) >= estimateTokens(head)) {
    return null
  }

  const compacted: ProviderMessage[] = []
  const first = tail[0]
  if (!first) return null
  if (first.role === 'user') {
    compacted.push({ ...first, content: `${checkpoint}\n\n${first.content}` })
    compacted.push(...tail.slice(1))
  } else {
    compacted.push({ role: 'user', content: checkpoint })
    compacted.push(...tail)
  }
  return { messages: compacted, checkpoint }
}
