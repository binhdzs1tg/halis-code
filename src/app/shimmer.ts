import { el } from './dom'

/**
 * TextShimmer, ported from the DeepSeek Harness primitive: two stacked copies
 * of the text; a tinted copy sweeps under a 105° gradient mask while an
 * opposite-moving highlight keeps the glyphs aligned.
 */
export function mountShimmer(text: string): { root: HTMLElement; setText(text: string): void } {
  const root = el('span', 'text-shimmer')

  const content = el('span', 'shimmer-content')
  content.textContent = text

  const decoration = el('span', 'shimmer-decoration')
  const sweep = el('span', 'shimmer-sweep')
  const sweepText = el('span', 'shimmer-content')
  sweepText.textContent = text
  const highlight = el('span', 'shimmer-highlight')
  sweep.append(highlight, sweepText)
  decoration.appendChild(sweep)

  root.append(content, decoration)

  return {
    root,
    setText(next: string): void {
      content.textContent = next
      sweepText.textContent = next
    }
  }
}
