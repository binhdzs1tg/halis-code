// The Halis penguin, redrawn pixel by pixel. Each row is a line of palette
// keys; the palette itself carries the exact colors from the brand art.
export interface PixelGrid {
  readonly w: number
  readonly h: number
  readonly rows: readonly string[]
}

export const PALETTE = {
  k: [0, 0, 0],
  n: [1, 24, 83],
  b: [108, 163, 253],
  m: [60, 109, 213],
  p: [185, 209, 253],
  w: [254, 254, 254],
  o: [254, 176, 67],
  s: [0, 9, 55],
} as const

export type PaletteKey = keyof typeof PALETTE

export function paletteColor(key: string): readonly [number, number, number] {
  const table = PALETTE as Record<string, readonly [number, number, number]>
  return table[key] ?? PALETTE.k
}

export function hex(color: readonly number[]): string {
  const [r, g, b] = color
  return `#${((1 << 24) | ((r ?? 0) << 16) | ((g ?? 0) << 8) | (b ?? 0)).toString(16).slice(1)}`
}

export const MASCOT_MID: PixelGrid = {
  w: 27,
  h: 27,
  rows: [
    'kkkkkkkkkkkkkkkkkkkkkkkkkkk',
    'kkkkkkkkkkkknnnnkkkkkkkkkkk',
    'kkkkkkkkkkknbbbnkkkkkkkkkkk',
    'kkkkkkkkkknbbbbnnkkkkkkkkkk',
    'kkkkkkknnnbbbbnnnkkkkkkkkkk',
    'kkkkkknbbbbbbbbnnnkkkkkkkkk',
    'kkkkknbbbbbbbbbbbbnkkkkkkkk',
    'kkkknbbbbbbbbbbbbbbnkkkkkkk',
    'kkknbbwwwbbbbbbwwwbbnkkkkkk',
    'kkknbwwwwwbbbbwwwwwbnkkkkkk',
    'kknbbwwsswwbbbwwsswwbnkkkkk',
    'kknbwwsssswwwwssssswwnkkkkk',
    'kkbwwswwwswnnnswwwswwbkkkkk',
    'knwwwwwwwwwoonwwwwwwwwnkkkk',
    'knwwwwbwwwwnnwwwwbwwwwnkkkk',
    'kknnwwwwwwwwwwwwwwwwnnkkkkk',
    'kkknnnnwwwwwwwwwwwnnnknnnkk',
    'kknbbbnnwwwwwwwwwnnbbnbbbnk',
    'knbbbbbwwwwwwwwwwnbbbbnbnkk',
    'knbbmbnwwwwwwwwwwwnbbbnnkkk',
    'knbmmnpwwwwwwwwwwwnmmbnnkkk',
    'kknmmnppwwwwwwwwwppmmmnkkkk',
    'kkknnnpppwwwwwwpppnnnnkkkkk',
    'kkkkknnnppppppppnnnkkkkkkkk',
    'kkkkkkkoonnnnnnnonkkkkkkkkk',
    'kkkkkkkookkkkkkoookkkkkkkkk',
    'kkkkkkkkkkkkkkkkkkkkkkkkkkk',
  ],
}

export const MASCOT_FULL: PixelGrid = {
  w: 53,
  h: 56,
  rows: [
    'kkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkk',
    'kkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkk',
    'kkkkkkkkkkkkkkkkkkkkkkkkknnnnnnkkkkkkkkkkkkkkkkkkkkkk',
    'kkkkkkkkkkkkkkkkkkkkkkkkknnnnnnkkkkkkkkkkkkkkkkkkkkkk',
    'kkkkkkkkkkkkkkkkkkkkkkknnbbbbnnkkkkkkkkkkkkkkkkkkkkkk',
    'kkkkkkkkkkkkkkkkkkkkkkknnbbbbnnkkkkkkkkkkkkkkkkkkkkkk',
    'kkkkkkkkkkkkkkkkkkkkknnbbbbbbnnnnkkkkkkkkkkkkkkkkkkkk',
    'kkkkkkkkkkkkkkkkkkkkknnbbbbbbnnnnkkkkkkkkkkkkkkkkkkkk',
    'kkkkkkkkkkkkkkknnnnnnbbbbbbnnbbnnkkkkkkkkkkkkkkkkkkkk',
    'kkkkkkkkkkkkkkknnnnnnbbbbbbnnbbnnkkkkkkkkkkkkkkkkkkkk',
    'kkkkkkkkkkkkkknbbbbbbbbbbbbbbnnnnnkkkkkkkkkkkkkkkkkkk',
    'kkkkkkkkkkkknnnbbbbbbbbbbbbbbnnnnnnnkkkkkkkkkkkkkkkkk',
    'kkkkkkkkkknnnbbbbbbbbbbbbbbbbbbbbbbbnnkkkkkkkkkkkkkkk',
    'kkkkkkkkkknnbbbbbbbbbbbbbbbbbbbbbbbbnnkkkkkkkkkkkkkkk',
    'kkkkkkkkkknnbbbbbbbbbbbbbbbbbbbbbbbbnnnkkkkkkkkkkkkkk',
    'kkkkkkkknnbbbbbbbbbbbbbbbbbbbbbbbbbbbbnnkkkkkkkkkkkkk',
    'kkkkkkkknnbbbbbbbbbbbbbbbbbbbbbbbbbbbbnnkkkkkkkkkkkkk',
    'kkkkkknnbbbbwwwwwwbbbbbbbbbbbbbwwwwwbbbbnnkkkkkkkkkkk',
    'kkkkkknnbbbbwwwwwwbbbbbbbbbbbbwwwwwwbbbbnnkkkkkkkkkkk',
    'kkkkkknnbbwwwwwwwwwbbbbbbbbbbwwwwwwwwwbbnnkkkkkkkkkkk',
    'kkkkkknnbbwwwwwwwwwwbbbbbbbbwwwwwwwwwwbbbnkkkkkkkkkkk',
    'kkkknnbbbwwwwsssswwwwbbbbbbwwwwsssswwwwbbbnnkkkkkkkkk',
    'kkkknnbbbwwwwsssswwwwbbbbbbwwwwsssswwwwwbbnnkkkkkkkkk',
    'kkkknnbbwwwwssssssswwwwwwwwwwsssssssswwwwbnnkkkkkkkkk',
    'kkkknnbbwwwssswwwssswwwwwwwwsssswwwssswwwbnnkkkkkkkkk',
    'kkkknbbwwwssswwwwssswwnnnnnwssswwwwssswwwbbnkkkkkkkkk',
    'kknnbbwwwwsswwwwwwsswnoooonnsswwwwwwsswwwwbbnnkkkkkkk',
    'kknnwwwwwwwwwwwwwwwwwnoooonnwwwwwwwwwwwwwwwwnnkkkkkkk',
    'kknnwwwwwbbwbbwwwwwwwnnoonnwwwwwwwbbwbbwwwwwnnkkkkkkk',
    'kknnwwwwwbbwbbwwwwwwwwnnnnwwwwwwwwbbwbbwwwwwnnkkkkkkk',
    'kkkknnwwwwwwwwwwwwwwwwwnnwwwwwwwwwwwwwwwwwnnkkkkkkkkk',
    'kkkknnnnwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwnnnnkkkkkkkkk',
    'kkkkkknnnwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwnnkkkkkkkkkkk',
    'kkkkkknnnnnnnwwwwwwwwwwwwwwwwwwwwwwwnnnnnnkknnnnnkkkk',
    'kkkkknnbbbbnnwwwwwwwwwwwwwwwwwwwwwwwnnbbbbnnnbbbbnnkk',
    'kkkkknnbbbbnnnnwwwwwwwwwwwwwwwwwwnnnnnbbbbnnnbbbbnnkk',
    'kkknnbbbbbbbbnnwwwwwwwwwwwwwwwwwwnnnbbbbbbbnbbbbbnnkk',
    'kkknnbbbbbbbbnnwwwwwwwwwwwwwwwwwwnnnbbbbbbbnnbbbbnnkk',
    'kknbbbbbbbbbbnwwwwwwwwwwwwwwwwwwwwwnbbbbbbbbnnbbnkkkk',
    'kknbbbbbmmbbnnwwwwwwwwwwwwwwwwwwwwwnnbbmbbbbnnnnnkkkk',
    'kknbbbmmmmbnnwwwwwwwwwwwwwwwwwwwwwwwnbbmmmbbnnnnkkkkk',
    'kknbbbmmmmbnnwwwwwwwwwwwwwwwwwwwwwwwnbmmmmbbnnnnkkkkk',
    'kkknnmmmmmnnppwwwwwwwwwwwwwwwwwwwwppnnmmmmmnnnkkkkkkk',
    'kkkknmmmmmnppppwwwwwwwwwwwwwwwwwwwpppnmmmmmnnnkkkkkkk',
    'kkkkknnmmnnpppppwwwwwwwwwwwwwwwwwppppnnnmmmnnkkkkkkkk',
    'kkkkknnnnnnnppppppwwwwwwwwwwwwpppppppnnnnnnnnkkkkkkkk',
    'kkkkkkkkkknnpppppppwwwwwwwwwwwppppppnnnnnnnnkkkkkkkkk',
    'kkkkkkkkkknnnnnppppppppppppppppppnnnnnkkkkkkkkkkkkkkk',
    'kkkkkkkkkkkknnnnnnpppppppppppppnnnnnkkkkkkkkkkkkkkkkk',
    'kkkkkkkkkkkkkknoonnnnnnnnnnnnnnnonnkkkkkkkkkkkkkkkkkk',
    'kkkkkkkkkkkkkkooonnnnnnnnnnnnnnooonkkkkkkkkkkkkkkkkkk',
    'kkkkkkkkkkkkkoooooonnkkkkkkknoooooookkkkkkkkkkkkkkkkk',
    'kkkkkkkkkkkkkkkookkkkkkkkkkkkkkoookkkkkkkkkkkkkkkkkkk',
    'kkkkkkkkkkkkkkkokkkkkkkkkkkkkkkkokkkkkkkkkkkkkkkkkkkk',
    'kkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkk',
    'kkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkk',
  ],
}

/** Plain-text rendering with truecolor escapes, for non-interactive output. */
export function renderAnsi(grid: PixelGrid): string {
  const lines: string[] = []
  for (let r = 0; r < Math.ceil(grid.h / 2); r++) {
    const topRow = grid.rows[r * 2] ?? ''
    const bottomRow = grid.rows[r * 2 + 1] ?? ''
    let line = ''
    let fg = ''
    let bg = ''
    for (let x = 0; x < grid.w; x++) {
      const top = hex(paletteColor(topRow[x] ?? 'k'))
      const bottom = hex(paletteColor(bottomRow[x] ?? 'k'))
      const nextFg = top === bottom ? '' : top
      const nextBg = bottom
      if (nextFg !== fg || nextBg !== bg) {
        line += `\x1b[0m`
        line += nextFg ? `\x1b[38;2;${rgb(top)}m` : ''
        line += `\x1b[48;2;${rgb(nextBg)}m`
        fg = nextFg
        bg = nextBg
      }
      line += top === bottom ? ' ' : '▀'
    }
    lines.push(line + '\x1b[0m')
  }
  return lines.join('\n')
}

function rgb(hexColor: string): string {
  const n = parseInt(hexColor.slice(1), 16)
  return `${n >> 16};${(n >> 8) & 255};${n & 255}`
}
