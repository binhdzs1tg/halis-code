import { Box, Text } from 'ink'
import type { ResolvedConfig, ToolCall } from '@halis/core'
import { MASCOT_FULL } from '../mascot-art.js'
import { theme } from '../theme.js'
import { COMMANDS } from '../commands.js'
import { PixelArt } from './pixel-art.js'
import { Markdown } from './markdown.js'
import { Splash } from './splash.js'

export type HistoryItem =
  | { id: number; kind: 'splash' }
  | { id: number; kind: 'user'; text: string }
  | { id: number; kind: 'assistant'; text: string }
  | { id: number; kind: 'tool'; call: ToolCall; output: string; ok: boolean; ms: number }
  | { id: number; kind: 'info'; text: string }
  | { id: number; kind: 'error'; text: string }
  | { id: number; kind: 'status'; text: string }
  | { id: number; kind: 'mascot' }
  | { id: number; kind: 'help' }

function ToolCard({ item }: { item: Extract<HistoryItem, { kind: 'tool' }> }) {
  const { call, output, ok, ms } = item
  let body = output
  if (call.name === 'bash' && body.startsWith('exit 0\n')) body = body.slice(7)
  const lines = body.split('\n')
  const shown = lines.slice(0, 6)
  const more = lines.length - shown.length

  return (
    <Box flexDirection="column">
      <Text>
        <Text color={ok ? theme.dim : theme.error} bold>
          ⏺
        </Text>{' '}
        <Text color={theme.text} bold>
          {call.name}
        </Text>
        <Text color={theme.accent}>({summarizeArgsInline(call)})</Text>{' '}
        <Text color={theme.faint}>({ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`})</Text>
      </Text>
      {shown.map((line, i) => (
        <Text key={i} color={ok ? theme.dim : theme.error} wrap="truncate-end">
          {'  '}
          {line === '' ? ' ' : line}
        </Text>
      ))}
      {more > 0 ? <Text color={theme.faint}>  … +{more} more lines</Text> : null}
    </Box>
  )
}

function summarizeArgsInline(call: ToolCall): string {
  if (typeof call.input.file_path === 'string') return call.input.file_path
  if (typeof call.input.command === 'string') {
    const one = call.input.command.replace(/\s+/g, ' ')
    return one.length > 72 ? `${one.slice(0, 72)}…` : one
  }
  if (typeof call.input.pattern === 'string') return call.input.pattern
  const json = JSON.stringify(call.input)
  return json.length > 72 ? `${json.slice(0, 72)}…` : json
}

function HelpPanel() {
  return (
    <Box borderStyle="round" borderColor={theme.border} paddingX={1} flexDirection="column">
      {COMMANDS.map((cmd) => (
        <Text key={cmd.name}>
          <Text color={theme.primary} bold>
            {cmd.name.padEnd(11)}
          </Text>
          <Text color={theme.dim}>{cmd.description}</Text>
        </Text>
      ))}
      <Text color={theme.faint}>keys  esc interrupt · ctrl+c quit · up/down history · tab complete</Text>
    </Box>
  )
}

export function HistoryRow({ item, cfg, cwd }: { item: HistoryItem; cfg: ResolvedConfig; cwd: string }) {
  switch (item.kind) {
    case 'splash':
      return <Splash cfg={cfg} cwd={cwd} />
    case 'user':
      return (
        <Text>
          <Text color={theme.primary} bold>
            ❯{' '}
          </Text>
          <Text color={theme.text}>{item.text}</Text>
        </Text>
      )
    case 'assistant':
      return (
        <Box>
          <Text color={theme.primary} bold>
            ⏺{' '}
          </Text>
          <Box flexDirection="column">
            <Markdown text={item.text} />
          </Box>
        </Box>
      )
    case 'tool':
      return <ToolCard item={item} />
    case 'info':
      return <Text color={theme.dim}>{item.text}</Text>
    case 'error':
      return (
        <Text color={theme.error}>
          <Text bold>✗ </Text>
          {item.text}
        </Text>
      )
    case 'status':
      return (
        <Box borderStyle="round" borderColor={theme.border} paddingX={1} flexDirection="column">
          <Text color={theme.dim}>{item.text}</Text>
        </Box>
      )
    case 'mascot':
      return (
        <Box flexDirection="column">
          <PixelArt grid={MASCOT_FULL} />
          <Text color={theme.dim}>
            Pixel — the Halis penguin. Drawn pixel by pixel, colored exactly like the brand art.
          </Text>
        </Box>
      )
    case 'help':
      return <HelpPanel />
  }
}
