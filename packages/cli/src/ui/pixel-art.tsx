import { Box, Text } from 'ink'
import { hex, paletteColor, type PixelGrid } from '../mascot-art.js'

interface Run {
  text: string
  fg: string
  bg: string
  block: boolean
}

function lineRuns(grid: PixelGrid, row: number): Run[] {
  const topRow = grid.rows[row * 2] ?? ''
  const bottomRow = grid.rows[row * 2 + 1] ?? ''
  const runs: Run[] = []
  for (let x = 0; x < grid.w; x++) {
    const top = hex(paletteColor(topRow[x] ?? 'k'))
    const bottom = hex(paletteColor(bottomRow[x] ?? 'k'))
    const block = top !== bottom
    const run: Run = {
      text: block ? '▀' : ' ',
      fg: block ? top : '',
      bg: bottom,
      block,
    }
    const last = runs[runs.length - 1]
    if (last && last.block === run.block && last.fg === run.fg && last.bg === run.bg) {
      last.text += run.text
    } else {
      runs.push(run)
    }
  }
  return runs
}

export function PixelArt({ grid }: { grid: PixelGrid }) {
  const lineCount = Math.ceil(grid.h / 2)
  const lines: Run[][] = []
  for (let r = 0; r < lineCount; r++) lines.push(lineRuns(grid, r))
  return (
    <Box flexDirection="column">
      {lines.map((runs, i) => (
        <Text key={i}>
          {runs.map((run, j) =>
            run.block ? (
              <Text key={j} color={run.fg} backgroundColor={run.bg}>
                {run.text}
              </Text>
            ) : (
              <Text key={j} backgroundColor={run.bg}>
                {run.text}
              </Text>
            ),
          )}
        </Text>
      ))}
    </Box>
  )
}
