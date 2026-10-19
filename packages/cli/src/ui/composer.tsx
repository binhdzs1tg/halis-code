import { Box, Text, useInput } from 'ink'
import { useMemo, useState } from 'react'
import { COMMANDS, CommandPopup } from '../commands.js'
import { theme } from '../theme.js'

export type ComposerMode = 'input' | 'running' | 'approval'

interface ComposerProps {
  mode: ComposerMode
  placeholder?: string
  onSubmit: (value: string) => void
  onInterrupt: () => void
  onExit: () => void
}

export function Composer({ mode, placeholder, onSubmit, onInterrupt, onExit }: ComposerProps) {
  const [value, setValue] = useState('')
  const [cursor, setCursor] = useState(0)
  const [history, setHistory] = useState<string[]>([])
  const [browsing, setBrowsing] = useState(-1)
  const [selected, setSelected] = useState(0)

  const popupOpen = mode !== 'approval' && value.startsWith('/') && !value.includes(' ')
  const items = useMemo(() => {
    if (!popupOpen) return []
    const word = value.slice(1).toLowerCase()
    return COMMANDS.filter((c) => c.name.slice(1).startsWith(word))
  }, [popupOpen, value])
  const sel = Math.min(selected, Math.max(0, items.length - 1))

  const reset = () => {
    setValue('')
    setCursor(0)
    setBrowsing(-1)
    setSelected(0)
  }

  const submit = (text: string) => {
    setHistory((h) => (text && h[h.length - 1] !== text ? [...h, text] : h))
    reset()
    onSubmit(text)
  }

  useInput((input, key) => {
    if (input === 'c' && key.ctrl) {
      onExit()
      return
    }
    if (mode === 'approval') return
    if (mode === 'running') {
      if (key.escape) onInterrupt()
      return
    }

    if (key.escape) {
      if (value.length > 0) reset()
      return
    }

    if (key.upArrow) {
      if (popupOpen && items.length > 0) {
        setSelected(Math.max(0, sel - 1))
        return
      }
      if (history.length > 0) {
        const next = Math.min(browsing + 1, history.length - 1)
        const entry = history[history.length - 1 - next] ?? ''
        setBrowsing(next)
        setValue(entry)
        setCursor(entry.length)
      }
      return
    }
    if (key.downArrow) {
      if (popupOpen && items.length > 0) {
        setSelected(Math.min(items.length - 1, sel + 1))
        return
      }
      if (browsing >= 0) {
        const next = browsing - 1
        setBrowsing(next)
        const entry = next >= 0 ? (history[history.length - 1 - next] ?? '') : ''
        setValue(entry)
        setCursor(entry.length)
      }
      return
    }

    if (key.tab && popupOpen && items[sel]) {
      const pick = items[sel].name + ' '
      setValue(pick)
      setCursor(pick.length)
      setSelected(0)
      return
    }

    if (key.return) {
      if (popupOpen && items[sel]) {
        submit(items[sel].name)
        return
      }
      const text = value.trim()
      if (text.length > 0) submit(text)
      return
    }

    if (key.backspace) {
      if (cursor > 0) {
        setValue(value.slice(0, cursor - 1) + value.slice(cursor))
        setCursor(cursor - 1)
      }
      return
    }
    if (key.delete) {
      setValue(value.slice(0, cursor) + value.slice(cursor + 1))
      return
    }
    if (key.leftArrow) {
      setCursor(Math.max(0, cursor - 1))
      return
    }
    if (key.rightArrow) {
      setCursor(Math.min(value.length, cursor + 1))
      return
    }
    if (key.ctrl && input === 'a') {
      setCursor(0)
      return
    }
    if (key.ctrl && input === 'e') {
      setCursor(value.length)
      return
    }
    if (key.ctrl || key.meta) return

    const printable = typeof input === 'string' ? input.replace(/[\r\n]+/g, '') : ''
    if (printable.length > 0 && printable >= ' ') {
      setValue(value.slice(0, cursor) + printable + value.slice(cursor))
      setCursor(cursor + printable.length)
      setBrowsing(-1)
      setSelected(0)
    }
  })

  const before = value.slice(0, cursor)
  const at = value[cursor] ?? ' '
  const after = value.slice(cursor + 1)

  return (
    <Box flexDirection="column">
      {popupOpen && items.length > 0 ? <CommandPopup filter={value} selected={sel} /> : null}
      <Box borderStyle="round" borderColor={mode === 'running' ? theme.primaryDim : theme.border} paddingX={1}>
        <Text color={theme.primary} bold>❯ </Text>
        {value.length === 0 && mode === 'input' ? (
          <>
            <Text backgroundColor={theme.text}> </Text>
            <Text color={theme.faint}>{placeholder ?? "Try 'explain this repo' or /help"}</Text>
          </>
        ) : (
          <Text wrap="truncate-end">
            {before}
            <Text inverse color={theme.text}>
              {at}
            </Text>
            {after}
          </Text>
        )}
      </Box>
    </Box>
  )
}
