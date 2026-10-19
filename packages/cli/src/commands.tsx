import { Box, Text } from 'ink'
import { theme } from './theme.js'

export interface Command {
  name: string
  description: string
}

export const COMMANDS: Command[] = [
  { name: '/help', description: 'show every command' },
  { name: '/model', description: 'show or switch the model' },
  { name: '/provider', description: 'switch provider preset (zai, deepseek, groq, …)' },
  { name: '/mascot', description: 'say hi to the penguin' },
  { name: '/init', description: 'write an AGENTS.md for this repo' },
  { name: '/status', description: 'config, key and session info' },
  { name: '/clear', description: 'drop the conversation context' },
  { name: '/exit', description: 'quit halis (or ctrl+c)' },
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
  const shown = items.slice(0, 8)
  return (
    <Box borderStyle="round" borderColor={theme.border} flexDirection="column" paddingX={1}>
      {shown.map((cmd, i) => {
        const active = i === selected
        return (
          <Text key={cmd.name}>
            <Text color={active ? theme.primary : theme.faint}>{active ? '❯ ' : '  '}</Text>
            <Text color={active ? theme.primary : theme.text} bold={active}>
              {cmd.name.padEnd(10)}
            </Text>
            <Text color={theme.dim}>{cmd.description}</Text>
          </Text>
        )
      })}
    </Box>
  )
}
