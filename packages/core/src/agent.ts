import { DEFAULT_COMPACT_AT, estimateTokens } from './config.js'
import { compactTranscript } from './compact.js'
import { RepeatGuard } from './guard.js'
import { fitToolOutput } from './spill.js'
import { streamChat } from './provider.js'
import type { AgentRunOptions, ToolCall, ToolResult } from './types.js'

/**
 * The tool loop: stream an assistant turn, run the requested tools, feed the
 * results back, repeat until the model answers without tools, the user aborts
 * or the turn budget runs out. Events drive the UI; the transcript array is
 * mutated in place so the caller keeps the full conversation.
 *
 * Guardrails that keep long sessions honest:
 * - usage events report the provider's token counts each turn;
 * - the transcript compacts itself once it crosses the token budget;
 * - identical repeat calls earn an escalating reminder, then a hard stop;
 * - declined calls are fed back instead of being silently skipped;
 * - oversized tool results spill to disk behind a readable preview;
 * - an abort or failure mid-batch still closes every pending tool call with
 *   a synthetic result, so the transcript never carries a dangling tool_use.
 */
export async function runAgent(opts: AgentRunOptions): Promise<void> {
  const { onEvent, signal } = opts
  const guard = new RepeatGuard()
  let turn = 0
  // Tool calls of the batch currently being executed, kept so the catch block
  // can close any that never got a result (a throwing tool must not leave a
  // tool_use without its tool result in the transcript).
  let pendingBatch: ToolCall[] = []

  const closePendingCalls = (): void => {
    for (const pending of pendingBatch) {
      if (opts.messages.some((m) => m.role === 'tool' && m.toolCallId === pending.id)) continue
      opts.messages.push({
        role: 'tool',
        toolCallId: pending.id,
        content: 'the run was interrupted before this call executed',
      })
    }
    pendingBatch = []
  }

  try {
    while (true) {
      turn++
      if (turn > opts.maxTurns) {
        onEvent({ type: 'notice', text: `stopped after ${opts.maxTurns} turns — send another message to continue` })
        onEvent({ type: 'done', reason: 'max-turns' })
        return
      }

      const compactAt = opts.compactAt ?? DEFAULT_COMPACT_AT
      if (compactAt > 0 && estimateTokens(opts.messages) > compactAt) {
        try {
          const replaced = await compactTranscript({
            messages: opts.messages,
            compactAt,
            provider: opts.provider,
            signal,
          })
          if (replaced > 0) {
            onEvent({
              type: 'notice',
              text: `compacted ${replaced} old messages into a summary to stay inside the context budget`,
            })
          }
        } catch (err) {
          onEvent({
            type: 'notice',
            text: `compaction skipped (${err instanceof Error ? err.message : String(err)}) — continuing with full history`,
          })
        }
      }

      const res = await streamChat({
        baseUrl: opts.provider.baseUrl,
        model: opts.provider.model,
        system: opts.system,
        messages: opts.messages,
        tools: opts.tools.map((t) => t.spec),
        signal,
        wantUsage: true,
        onDelta: (text) => onEvent({ type: 'text-delta', text }),
        ...(opts.provider.protocol ? { protocol: opts.provider.protocol } : {}),
        ...(opts.provider.providerId ? { providerId: opts.provider.providerId } : {}),
        ...(opts.provider.variant ? { variant: opts.provider.variant } : {}),
        ...(opts.provider.maxTokens !== undefined ? { maxTokens: opts.provider.maxTokens } : {}),
        ...(opts.provider.extraHeaders ? { extraHeaders: opts.provider.extraHeaders } : {}),
        ...(opts.provider.extraBody ? { extraBody: opts.provider.extraBody } : {}),
        ...(opts.provider.apiKey ? { apiKey: opts.provider.apiKey } : {}),
      })
      if (res.usage) onEvent({ type: 'usage', input: res.usage.input, output: res.usage.output })

      const assistant: typeof opts.messages[number] = {
        role: 'assistant',
        content: res.text,
        ...(res.toolCalls.length > 0 ? { toolCalls: res.toolCalls } : {}),
        ...(res.thinkingBlocks && res.thinkingBlocks.length > 0 ? { thinkingBlocks: res.thinkingBlocks } : {}),
      }
      opts.messages.push(assistant)

      if (res.toolCalls.length === 0) {
        onEvent({ type: 'done', reason: 'complete' })
        return
      }

      pendingBatch = res.toolCalls
      let stopped = false
      for (const call of res.toolCalls) {
        const started = Date.now()
        onEvent({ type: 'tool-start', call })

        let allowed = true
        try {
          if (opts.approve) allowed = await opts.approve(call)
        } catch (err) {
          allowed = false
          onEvent({ type: 'notice', text: `approval check failed (${err instanceof Error ? err.message : String(err)}) — the call was declined` })
        }
        let outcome: { output: string; ok: boolean }
        if (signal.aborted) {
          outcome = { output: 'the run was interrupted before this call executed', ok: false }
        } else if (!allowed) {
          outcome = { output: 'the user declined this call — continue without it or explain what you need', ok: false }
        } else {
          const tool = opts.tools.find((t) => t.spec.name === call.name)
          if (!tool) {
            outcome = { output: `error: unknown tool "${call.name}"`, ok: false }
          } else {
            try {
              outcome = await tool.run(call.input, {
                cwd: opts.cwd,
                signal,
                readFiles: opts.readFiles,
                ...(opts.setTodos ? { setTodos: opts.setTodos } : {}),
                ...(opts.askUser ? { askUser: opts.askUser } : {}),
              })
            } catch (err) {
              // A throwing tool is a failed call, not a failed run — report it
              // back so the transcript stays valid and the model can recover.
              outcome = {
                output: `error: ${err instanceof Error ? err.message : String(err)}`,
                ok: false,
              }
            }
          }
        }

        const reminder = guard.record(call.name, call.input)
        const result: ToolResult = {
          callId: call.id,
          name: call.name,
          output: fitToolOutput(call.name, call.id, reminder ? `${outcome.output}\n\n${reminder}` : outcome.output),
          ok: outcome.ok,
        }
        onEvent({ type: 'tool-end', call, result, ms: Date.now() - started })
        opts.messages.push({ role: 'tool', toolCallId: call.id, content: result.output })

        if (guard.exceeded()) {
          onEvent({
            type: 'notice',
            text: 'the same tool call kept repeating — ending the run here instead of burning more tokens',
          })
          // The rest of the batch never ran; close it before leaving so the
          // transcript never carries a tool_use without its result.
          closePendingCalls()
          onEvent({ type: 'done', reason: 'repeat' })
          return
        }
        if (signal.aborted) {
          stopped = true
          break
        }
      }

      if (stopped) {
        // Close every call that never ran, so the transcript never carries a
        // tool_use without its result — the next request would be invalid.
        closePendingCalls()
        onEvent({ type: 'done', reason: 'aborted' })
        return
      }
      pendingBatch = []
    }
  } catch (err) {
    closePendingCalls()
    if (signal.aborted || (err instanceof Error && err.name === 'AbortError')) {
      onEvent({ type: 'done', reason: 'aborted' })
      return
    }
    const message = err instanceof Error ? err.message : String(err)
    onEvent({ type: 'error', message })
    onEvent({ type: 'done', reason: 'error' })
  }
}
