import { Box, Text } from 'ink'
import { MASCOT_MID } from '../mascot-art.js'
import { theme } from '../theme.js'
import type { ResolvedConfig } from '@halis/core'
import { PixelArt } from './pixel-art.js'

export function Splash({ cfg, cwd }: { cfg: ResolvedConfig; cwd: string }) {
  return (
    <Box borderStyle="round" borderColor={theme.border} flexDirection="row" columnGap={2} paddingX={1}>
      <Box flexDirection="column" justifyContent="center" rowGap={1} flexGrow={1}>
        <Text color={theme.primary} bold>
          ✻ Welcome to Halis Code! <Text color={theme.dim}>v0.1.0</Text>
        </Text>
        <Text color={theme.text}>cwd: {cwd}</Text>
        <Text color={theme.text}>
          model: <Text bold>{cfg.model}</Text> <Text color={theme.dim}>@ {cfg.label}</Text>
          {cfg.demo ? <Text color={theme.warn}> · demo mode, no api key yet</Text> : null}
        </Text>
        <Text color={theme.dim}>/help commands · /mascot meet the penguin · ctrl+c exit</Text>
      </Box>
      <PixelArt grid={MASCOT_MID} />
    </Box>
  )
}
