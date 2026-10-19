import { Box, Text, useInput } from 'ink'
import { useState } from 'react'
import type { AskRequest } from '@halis/core'
import { theme } from '../theme.js'

/**
 * The question card behind ask_user: the model's question, its suggested
 * answers when it offered any, and free text for everything else. Esc
 * skips — the model then decides on its own and says so.
 */
export function AskCard({ request, onAnswer }: { request: AskRequest; onAnswer: (text: string, cancelled: boolean) => void }) {
  const [selected, setSelected] = useState(0)
  const [typing, setTyping] = useState(false)
  const [value, setValue] = useState('')
  const choices = request.choices ?? []

  useInput((input, key) => {
    if (typing) {
      if (key.escape) return setTyping(false)
      if (key.return) return onAnswer(value.trim(), value.trim().length === 0)
      if (key.backspace || key.delete) return setValue((v) => v.slice(0, -1))
      if (input && input.length === 1 && input >= ' ') setValue((v) => v + input)
      return
    }
    if (key.escape) return onAnswer('', true)
    if (choices.length > 0) {
      if (key.upArrow) return setSelected((s) => Math.max(0, s - 1))
      if (key.downArrow) return setSelected((s) => Math.min(choices.length, s + 1))
      if (key.return) {
        if (selected === choices.length) return setTyping(true)
        const pick = choices[selected]
        if (pick) return onAnswer(pick, false)
        return
      }
      const number = Number(input)
      if (Number.isInteger(number) && number >= 1 && number <= choices.length) {
        return onAnswer(choices[number - 1] ?? '', false)
      }
      if (input === 'e') return setTyping(true)
    } else {
      if (key.return || input === 'e') return setTyping(true)
    }
  })

  return (
    <Box borderStyle="round" borderColor={theme.accent} flexDirection="column" paddingX={1}>
      <Text color={theme.accent} bold>
        halis asks
      </Text>
      <Text color={theme.text}>{request.question}</Text>
      {choices.map((choice, i) => (
        <Text key={choice} color={i === selected ? theme.primary : theme.dim}>
          {i === selected ? '❯ ' : '  '}
          {i + 1}. {choice}
        </Text>
      ))}
      <Text color={selected === choices.length && !typing ? theme.primary : theme.faint}>
        {choices.length > 0 ? '❯ ' : '  '}e — type your own answer
      </Text>
      {typing ? (
        <Box marginTop={0}>
          <Text color={theme.primary} bold>
            answer:{' '}
          </Text>
          <Text color={theme.text}>
            {value}
            <Text backgroundColor={theme.text}> </Text>
          </Text>
        </Box>
      ) : (
        <Text color={theme.faint}>enter confirm · esc skip</Text>
      )}
    </Box>
  )
}
