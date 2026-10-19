import { Text } from 'ink'
import { useEffect, useState } from 'react'
import { theme } from '../theme.js'

const FRAMES = ['✻', '✽', '✶', '✳', '✦', '✧']

export function Spinner({ label }: { label: string }) {
  const [frame, setFrame] = useState(0)
  useEffect(() => {
    const timer = setInterval(() => setFrame((f) => (f + 1) % FRAMES.length), 110)
    return () => clearInterval(timer)
  }, [])
  return (
    <Text>
      <Text color={theme.primary} bold>
        {FRAMES[frame]}
      </Text>{' '}
      <Text color={theme.dim}>{label}</Text> <Text color={theme.faint}>(esc to interrupt)</Text>
    </Text>
  )
}
