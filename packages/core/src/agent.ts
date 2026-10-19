import { DEFAULT_COMPACT_AT, estimateTokens } from './config.js'
import { compactTranscript } from './compact.js'
import { RepeatGuard } from './guard.js'
import { streamChat } from './provider.js'
import type { AgentRunOptions, ToolResult } from './types.js'

/**
 * The tool loop: stream an assistant turn, run the requested tools, feed the
 * results back, repeat until the model answers without tools, the user aborts
 * or the turn budget runs out. Events drive the UI; the transcript array is
 * mutated in place so the caller keeps the full conversation.
 *
 * Guardrails that keep long sessions honest:
 * - usage events report the provider's token counts each turn;
 * - the transcript compacts itself once it crosses the token budget;
 * - identical repeat calls earn an escalating reminder next to their result;
 * - declined calls are fed back instead of being silently skipped.
 */
export async function runAgent(opts: AgentRunOptions): Promise<void> {
  const { onEvent, signal } = opts
  const guard = new RepeatGuard()
  let turn = 0

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
        ...(opts.provider.apiKey ? { apiKey: opts.provider.apiKey } : {}),
      })
      if (res.usage) onEvent({ type: 'usage', input: res.usage.input, output: res.usage.output })

      const assistant: typeof opts.messages[number] = {
        role: 'assistant',
        content: res.text,
        ...(res.toolCalls.length > 0 ? { toolCalls: res.toolCalls } : {}),
      }
      opts.messages.push(assistant)

      if (res.toolCalls.length === 0) {
        onEvent({ type: 'done', reason: 'complete' })
        return
      }

      for (const call of res.toolCalls) {
        const started = Date.now()
        onEvent({ type: 'tool-start', call })

        let allowed = true
        if (opts.approve) allowed = await opts.approve(call)
        let outcome: { output: string; ok: boolean }
        if (!allowed) {
          outcome = { output: 'the user declined this call — continue without it or explain what you need', ok: false }
        } else {
          const tool = opts.tools.find((t) => t.spec.name === call.name)
          outcome = tool
            ? await tool.run(call.input, {
                cwd: opts.cwd,
                signal,
                readFiles: opts.readFiles,
                ...(opts.setTodos ? { setTodos: opts.setTodos } : {}),
              })
            : { output: `error: unknown tool "${call.name}"`, ok: false }
        }

        const reminder = guard.record(call.name, call.input)
        const result: ToolResult = {
          callId: call.id,
          name: call.name,
          output: reminder ? `${outcome.output}\n\n${reminder}` : outcome.output,
          ok: outcome.ok,
        }
        onEvent({ type: 'tool-end', call, result, ms: Date.now() - started })
        opts.messages.push({ role: 'tool', toolCallId: call.id, content: result.output })
      }
    }
  } catch (err) {
    if (signal.aborted || (err instanceof Error && err.name === 'AbortError')) {
      onEvent({ type: 'done', reason: 'aborted' })
      return
    }
    const message = err instanceof Error ? err.message : String(err)
    onEvent({ type: 'error', message })
    onEvent({ type: 'done', reason: 'error' })
  }
}
