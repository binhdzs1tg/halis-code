export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

export function svg(markup: string, size = 16): SVGSVGElement {
  const wrapper = document.createElement('span')
  wrapper.innerHTML = markup.replaceAll('%SIZE%', String(size))
  wrapper.style.lineHeight = '0'
  wrapper.style.display = 'inline-flex'
  const node = wrapper.firstElementChild
  if (node instanceof SVGSVGElement) {
    return node
  }
  throw new Error('Invalid svg markup')
}

export function clear(node: HTMLElement): void {
  while (node.firstChild) {
    node.removeChild(node.firstChild)
  }
}
