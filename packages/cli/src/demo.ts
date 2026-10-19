import type { ToolCall } from '@halis/core'

export const DEMO_REPLIES = [
  'Demo mode — there is no api key yet. Drop one into ~/.halis/config.json or set $HALIS_API_KEY, then ask again and I will actually think.',
  'I would love to dig in, but the penguin is out of tokens until an api key shows up. /status shows exactly what is missing.',
  'This is the demo voice of Halis Code. Pick a model with /model or a provider with /provider and the real agent takes over from here.',
]

export function demoReply(counter: number): string {
  return DEMO_REPLIES[counter % DEMO_REPLIES.length] ?? DEMO_REPLIES[0] ?? ''
}

export function summarizeArgs(input: Record<string, unknown>): string {
  const first = Object.values(input)[0]
  if (typeof first === 'string') {
    const oneLine = first.replace(/\s+/g, ' ').trim()
    return oneLine.length > 64 ? `${oneLine.slice(0, 64)}…` : oneLine
  }
  const json = JSON.stringify(input)
  return json.length > 64 ? `${json.slice(0, 64)}…` : json
}

export function firstLine(text: string): string {
  return text.split('\n')[0] ?? ''
}

export type { ToolCall }
