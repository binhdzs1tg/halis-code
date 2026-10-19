import { Box, Text } from 'ink'
import React from 'react'
import { theme } from '../theme.js'

function Inline({ text }: { text: string }) {
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g)
  return (
    <>
      {parts.map((part, i) => {
        if (part.length > 4 && part.startsWith('**') && part.endsWith('**')) {
          return (
            <Text key={i} bold color={theme.text}>
              {part.slice(2, -2)}
            </Text>
          )
        }
        if (part.length > 2 && part.startsWith('`') && part.endsWith('`')) {
          return (
            <Text key={i} color={theme.accent}>
              {part.slice(1, -1)}
            </Text>
          )
        }
        return <React.Fragment key={i}>{part}</React.Fragment>
      })}
    </>
  )
}

export function Markdown({ text }: { text: string }) {
  const nodes: React.ReactNode[] = []
  let fence: string[] | null = null

  const lines = text.split('\n')
  for (const line of lines) {
    if (line.trimStart().startsWith('```')) {
      if (fence === null) {
        fence = []
      } else {
        nodes.push(
          <Box key={nodes.length} borderStyle="round" borderColor={theme.border} paddingX={1} marginTop={0}>
            <Text color={theme.accent}>{fence.join('\n')}</Text>
          </Box>,
        )
        fence = null
      }
      continue
    }
    if (fence !== null) {
      fence.push(line)
      continue
    }
    if (/^#{1,6}\s/.test(line)) {
      nodes.push(
        <Text key={nodes.length} bold color={theme.primary}>
          {line.replace(/^#{1,6}\s+/, '')}
        </Text>,
      )
    } else if (/^\s*[-*]\s+/.test(line)) {
      nodes.push(
        <Text key={nodes.length}>
          <Text color={theme.primary}>  • </Text>
          <Inline text={line.replace(/^\s*[-*]\s+/, '')} />
        </Text>,
      )
    } else if (/^\s*\d+\.\s+/.test(line)) {
      const m = line.match(/^\s*(\d+)\.\s+(.*)$/)
      nodes.push(
        <Text key={nodes.length}>
          {'  '}
          <Text color={theme.primary}>{m?.[1]}. </Text>
          <Inline text={m?.[2] ?? ''} />
        </Text>,
      )
    } else if (line.trim() === '') {
      nodes.push(<Text key={nodes.length}> </Text>)
    } else {
      nodes.push(
        <Text key={nodes.length}>
          <Inline text={line} />
        </Text>,
      )
    }
  }
  if (fence !== null && fence.length > 0) {
    nodes.push(
      <Box key={nodes.length}>
        <Text color={theme.accent}>{fence.join('\n')}</Text>
      </Box>,
    )
  }
  return <Box flexDirection="column">{nodes}</Box>
}
