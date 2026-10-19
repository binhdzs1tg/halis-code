import { Box, Text, useInput } from 'ink'
import { useEffect, useState } from 'react'
import { listSessions, type SessionEntry } from '../sessions.js'
import { theme } from '../theme.js'

/**
 * The resume picker behind /resume: every stored session, newest first,
 * with its title, working directory and model. Enter loads it; esc backs
 * out. Rows show the cwd relative to home so the list stays readable.
 */
export function ResumePicker({ onPick, onClose }: { onPick: (entry: SessionEntry) => void; onClose: () => void }) {
  const [entries, setEntries] = useState<SessionEntry[] | null>(null)
  const [selected, setSelected] = useState(0)

  useEffect(() => {
    let alive = true
    listSessions().then((rows) => {
      if (alive) setEntries(rows)
    })
    return () => {
      alive = false
    }
  }, [])

  useInput((_input, key) => {
    if (!entries) return
    if (key.escape) return onClose()
    if (key.downArrow) return setSelected((s) => Math.min(entries.length - 1, s + 1))
    if (key.upArrow) return setSelected((s) => Math.max(0, s - 1))
    if (key.return) {
      const pick = entries[selected]
      if (pick) onPick(pick)
    }
  })

  if (!entries) {
    return (
      <Box borderStyle="round" borderColor={theme.border} paddingX={1}>
        <Text color={theme.dim}>looking for sessions…</Text>
      </Box>
    )
  }
  if (entries.length === 0) {
    return (
      <Box borderStyle="round" borderColor={theme.border} flexDirection="column" paddingX={1}>
        <Text color={theme.dim}>no sessions stored yet</Text>
        <Text color={theme.faint}>esc closes</Text>
      </Box>
    )
  }

  const top = Math.max(0, Math.min(selected - 8, entries.length - 14))
  const visible = entries.slice(top, top + 14)
  return (
    <Box borderStyle="round" borderColor={theme.primaryDim} flexDirection="column" paddingX={1}>
      <Text color={theme.primary} bold>
        resume a session
        <Text color={theme.faint}> — enter load · esc close</Text>
      </Text>
      {visible.map((entry, i) => {
        const index = top + i
        const active = index === selected
        const here = entry.cwd === process.cwd()
        return (
          <Text key={entry.file}>
            <Text color={active ? theme.primary : theme.faint}>{active ? '❯ ' : '  '}</Text>
            <Text color={active ? theme.primary : theme.text} bold={active}>
              {entry.title.slice(0, 46).padEnd(46)}
            </Text>
            <Text color={here ? theme.success : theme.dim}>
              {' '}
              {entry.cwd.replace(osHome(), '~')}
              {here ? ' · this folder' : ''}
            </Text>
            <Text color={theme.faint}> · {entry.model}</Text>
          </Text>
        )
      })}
      {entries.length > 14 ? <Text color={theme.faint}> {entries.length} sessions — arrows to scroll</Text> : null}
    </Box>
  )
}

function osHome(): string {
  return process.env.HOME ?? process.env.USERPROFILE ?? ''
}
