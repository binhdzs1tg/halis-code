import { Box, Text, useInput } from 'ink'
import { useState } from 'react'
import type { ToolCall } from '@halis/core'
import { assessCommand } from '@halis/core'
import { theme } from '../theme.js'

const OPTIONS = ['Yes', 'Yes, and stop asking for commands like this', 'No'] as const
export type ApprovalChoice = 'yes' | 'always' | 'no'

/**
 * The bash approval card, now risk-aware: destructive commands say why
 * they are being asked about (the risky heuristics from the desktop app),
 * and "always" sticks for the command's leading words — `npm run build`
 * stops asking for every `npm run …`, not just the exact string.
 */
export function ApprovalCard({ call, onChoice }: { call: ToolCall; onChoice: (choice: ApprovalChoice) => void }) {
  const [selected, setSelected] = useState(0)
  const command = typeof call.input.command === 'string' ? call.input.command : JSON.stringify(call.input)
  const shown = command.length > 200 ? `${command.slice(0, 200)}…` : command
  const reason = typeof call.input.command === 'string' ? assessCommand(command) : null

  useInput((input, key) => {
    if (input === '1' || input === 'y') return onChoice('yes')
    if (input === '2') return onChoice('always')
    if (input === '3' || input === 'n' || key.escape) return onChoice('no')
    if (input === 'c' && key.ctrl) return onChoice('no')
    if (key.upArrow) return setSelected((s) => Math.max(0, s - 1))
    if (key.downArrow) return setSelected((s) => Math.min(OPTIONS.length - 1, s + 1))
    if (key.return) {
      const pick = OPTIONS[selected]
      return onChoice(pick === 'Yes' ? 'yes' : pick === 'No' ? 'no' : 'always')
    }
  })

  return (
    <Box borderStyle="round" borderColor={theme.warn} paddingX={1} flexDirection="column">
      <Text color={theme.warn} bold>
        Run this command?
      </Text>
      <Text color={theme.text}>$ {shown}</Text>
      {reason ? <Text color={theme.warn}> flagged because {reason}</Text> : null}
      {OPTIONS.map((opt, i) => (
        <Text key={opt} color={i === selected ? theme.primary : theme.dim}>
          {i === selected ? '❯ ' : '  '}
          {i + 1}. {opt}
        </Text>
      ))}
      <Text color={theme.faint}>enter confirm · esc decline</Text>
    </Box>
  )
}
