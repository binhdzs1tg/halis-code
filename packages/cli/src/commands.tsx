import { Box, Text } from 'ink'
import { theme } from './theme.js'

export interface Command {
  name: string
  description: string
}

/**
 * One typed table drives the palette popup and the /help panel. Commands
 * with an arg hint show the shape right in the popup, like the sourced
 * CLIs do — nobody has to guess what `/title` wants.
 */
export const COMMANDS: Command[] = [
  { name: '/help', description: 'show every command' },
  { name: '/model', description: 'pick a model from the catalog, or /model provider/id#variant' },
  { name: '/models', description: 'search the model catalog' },
  { name: '/provider', description: 'switch provider preset (zai, deepseek, groq, …)' },
  { name: '/diff', description: 'git diff of the working tree' },
  { name: '/compact', description: 'compact the transcript now' },
  { name: '/resume', description: 'pick an earlier session to load' },
  { name: '/title', description: 'rename this session' },
  { name: '/export', description: 'write the transcript to a markdown file' },
  { name: '/usage', description: 'token totals and estimated cost' },
  { name: '/skills', description: 'list installed skills' },
  { name: '/yolo', description: 'toggle command approvals off (careful)' },
  { name: '/doctor', description: 'check config, key, catalog and endpoint' },
  { name: '/init', description: 'write an AGENTS.md for this repo' },
  { name: '/status', description: 'config, key and session info' },
  { name: '/mascot', description: 'say hi to the penguin' },
  { name: '/clear', description: 'drop the conversation context' },
  { name: '/exit', description: 'quit halis (or ctrl+c twice)' },
]

export function CommandPopup({
  filter,
  selected,
}: {
  filter: string
  selected: number
}) {
  const word = filter.slice(1).toLowerCase()
  const items = COMMANDS.filter((c) => c.name.slice(1).startsWith(word))
  if (items.length === 0) return null
  // A scrolling window that follows the selection — the popup always shows
  // eight rows, so selecting past the first screen must scroll, or Enter
  // would execute a command the user never saw highlighted.
  const windowStart = Math.max(0, Math.min(selected, items.length - 8))
  const shown = items.slice(windowStart, windowStart + 8)
  return (
    <Box borderStyle="round" borderColor={theme.border} flexDirection="column" paddingX={1}>
      {shown.map((cmd, i) => {
        const active = windowStart + i === selected
        return (
          <Text key={cmd.name}>
            <Text color={active ? theme.primary : theme.faint}>{active ? '❯ ' : '  '}</Text>
            <Text color={active ? theme.primary : theme.text} bold={active}>
              {cmd.name.padEnd(11)}
            </Text>
            <Text color={theme.dim}>{cmd.description}</Text>
          </Text>
        )
      })}
    </Box>
  )
}
