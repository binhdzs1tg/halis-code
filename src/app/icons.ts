/**
 * Inline SVG icon set. Thin 16-box glyphs:
 * `stroke="currentColor"` with 1.2 weight and round joins, sized by the
 * caller through the `%SIZE%` placeholder.
 */

function icon(viewBox: string, body: string, strokeWidth = 1.2): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}" width="%SIZE%" height="%SIZE%" fill="none" stroke="currentColor" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`
}

const panelLeft = icon(
  '0 0 16 16',
  '<rect x="1.75" y="2.75" width="12.5" height="10.5" rx="2"/><path d="M6.25 2.75v10.5"/>'
)

const panelRight = icon(
  '0 0 16 16',
  '<rect x="1.75" y="2.75" width="12.5" height="10.5" rx="2"/><path d="M9.75 2.75v10.5"/>'
)

const newChat = icon(
  '0 0 16 16',
  '<path d="M8.5 2.75H4A1.75 1.75 0 0 0 2.25 4.5v7A1.75 1.75 0 0 0 4 13.25h7a1.75 1.75 0 0 0 1.75-1.75V7"/><path d="M11.1 2.14a1.2 1.2 0 0 1 1.7 1.7L8.6 8.04l-2.2.5.5-2.2z"/>'
)

const settings = icon(
  '0 0 16 16',
  '<circle cx="8" cy="8" r="2.1"/><path d="M8 1.6c.36 0 .71.03 1.06.1l.4 1.7c.4.14.77.33 1.1.57l1.66-.53c.5.55.9 1.18 1.17 1.87l-1.26 1.22c.03.22.05.44.05.67s-.02.45-.05.67l1.26 1.22a6.05 6.05 0 0 1-1.17 1.87l-1.66-.53c-.33.24-.7.43-1.1.57l-.4 1.7a6.1 6.1 0 0 1-2.12 0l-.4-1.7a4.9 4.9 0 0 1-1.1-.57l-1.66.53a6.05 6.05 0 0 1-1.17-1.87l1.26-1.22A4.66 4.66 0 0 1 2.82 8c0-.23.02-.45.05-.67L1.61 6.11c.27-.69.67-1.32 1.17-1.87l1.66.53c.33-.24.7-.43 1.1-.57l.4-1.7c.35-.07.7-.1 1.06-.1z"/>'
)

const search = icon(
  '0 0 16 16',
  '<circle cx="7" cy="7" r="4.25"/><path d="m13.4 13.4-3.24-3.24"/>'
)

const folder = icon(
  '0 0 16 16',
  '<path d="M1.75 4A1.75 1.75 0 0 1 3.5 2.25h2.1c.46 0 .9.18 1.22.5l.83.83h4.85A1.75 1.75 0 0 1 14.25 5.3v6.2A1.75 1.75 0 0 1 12.5 13.25h-9A1.75 1.75 0 0 1 1.75 11.5z"/>'
)

const folderOpen = icon(
  '0 0 16 16',
  '<path d="M1.75 11.5V4A1.75 1.75 0 0 1 3.5 2.25h2.1c.46 0 .9.18 1.22.5l.83.83h4.85A1.75 1.75 0 0 1 14.25 5.3v1.2"/><path d="M1.75 11.5 3.3 6.9a1.1 1.1 0 0 1 1.04-.75h9.4a.9.9 0 0 1 .85 1.19l-1.3 3.9a1.1 1.1 0 0 1-1.04.76H2.85a1.1 1.1 0 0 1-1.1-1.5z"/>'
)

const file = icon(
  '0 0 16 16',
  '<path d="M9 1.75H4.5A1.25 1.25 0 0 0 3.25 3v10A1.25 1.25 0 0 0 4.5 14.25h7A1.25 1.25 0 0 0 12.75 13V5.5z"/><path d="M9 1.75V5.5h3.75"/>'
)

const terminal = icon(
  '0 0 16 16',
  '<rect x="1.75" y="2.75" width="12.5" height="10.5" rx="2"/><path d="m4.5 6 2 2-2 2"/><path d="M8 10.25h3.5"/>'
)

const chevronDown = icon('0 0 16 16', '<path d="m3.8 6.2 4.2 4.2 4.2-4.2"/>')

const chevronRight = icon('0 0 16 16', '<path d="m6.2 3.8 4.2 4.2-4.2 4.2"/>')

const plus = icon('0 0 16 16', '<path d="M8 3v10M3 8h10"/>')

const close = icon('0 0 16 16', '<path d="m3.5 3.5 9 9m0-9-9 9"/>')

const minus = icon('0 0 16 16', '<path d="M3 8h10"/>')

const maximize = icon(
  '0 0 16 16',
  '<rect x="2.75" y="2.75" width="10.5" height="10.5" rx="1.5"/>'
)

const restore = icon(
  '0 0 16 16',
  '<rect x="2.25" y="5.25" width="8.5" height="8.5" rx="1.4"/><path d="M5.25 5.25V3.6c0-.75.6-1.35 1.35-1.35h5.8c.75 0 1.35.6 1.35 1.35v5.8c0 .75-.6 1.35-1.35 1.35h-1.65"/>'
)

const trash = icon(
  '0 0 16 16',
  '<path d="M2.75 4.25h10.5"/><path d="M5.75 4.25V3.1c0-.47.38-.85.85-.85h2.8c.47 0 .85.38.85.85v1.15"/><path d="M4.25 4.5 4.7 12.8a1.2 1.2 0 0 0 1.2 1.14h4.2a1.2 1.2 0 0 0 1.2-1.14l.45-8.3"/>'
)

const copy = icon(
  '0 0 16 16',
  '<rect x="5.75" y="5.75" width="8" height="8" rx="1.5"/><path d="M10.25 5.75V3.6c0-.47-.38-.85-.85-.85H3.6a.85.85 0 0 0-.85.85v5.8c0 .47.38.85.85.85h2.15"/>'
)

const check = icon('0 0 16 16', '<path d="m2.75 8.5 3.5 3.5 7-8"/>')

const arrowUp = icon('0 0 16 16', '<path d="M8 13V3M3.5 7.5 8 3l4.5 4.5"/>')

const stopFilled =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="%SIZE%" height="%SIZE%" fill="currentColor"><rect x="3.5" y="3.5" width="9" height="9" rx="2.5"/></svg>'

const star = icon(
  '0 0 16 16',
  '<path d="m8 1.9 1.9 3.85 4.25.62-3.07 3 .73 4.23L8 11.62l-3.8 2-.73-4.24-3.07-3 4.24-.6z"/>'
)

const starFilled =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="%SIZE%" height="%SIZE%" fill="currentColor"><path d="m8 1.9 1.9 3.85 4.25.62-3.07 3 .73 4.23L8 11.62l-3.8 2-.73-4.24-3.07-3 4.24-.6z"/></svg>'

const key = icon(
  '0 0 16 16',
  '<circle cx="10.5" cy="5.5" r="3.25"/><path d="m8.2 7.8-5.45 5.45"/><path d="m5 11 1.75 1.75M3.5 12.5l1.4 1.4"/>'
)

const refresh = icon(
  '0 0 16 16',
  '<path d="M13.25 8a5.25 5.25 0 1 1-1.54-3.71"/><path d="M13.25 1.9v2.9h-2.9"/>'
)

const filePlus = icon(
  '0 0 16 16',
  '<path d="M9 1.75H4.5A1.25 1.25 0 0 0 3.25 3v10A1.25 1.25 0 0 0 4.5 14.25h7A1.25 1.25 0 0 0 12.75 13V5.5z"/><path d="M9 1.75V5.5h3.75"/><path d="M8 8v4M6 10h4"/>'
)

const folderPlus = icon(
  '0 0 16 16',
  '<path d="M1.75 11.5V4A1.75 1.75 0 0 1 3.5 2.25h2.1c.46 0 .9.18 1.22.5l.83.83h4.85A1.75 1.75 0 0 1 14.25 5.3v6.2A1.75 1.75 0 0 1 12.5 13.25h-9a1.75 1.75 0 0 1-1.75-1.75z"/><path d="M8 6.4v4M6 8.4h4"/>'
)

const history = icon(
  '0 0 16 16',
  '<circle cx="8" cy="8" r="5.75"/><path d="M8 4.75V8l2.4 1.6"/>'
)

const circle = icon('0 0 16 16', '<circle cx="8" cy="8" r="5.25"/>')

const ellipsis = icon(
  '0 0 16 16',
  '<circle cx="3.4" cy="8" r="0.9" fill="currentColor" stroke="none"/><circle cx="8" cy="8" r="0.9" fill="currentColor" stroke="none"/><circle cx="12.6" cy="8" r="0.9" fill="currentColor" stroke="none"/>'
)

const todo = icon(
  '0 0 16 16',
  '<path d="M2.5 4.5h6M2.5 8h6M2.5 11.5h6"/><path d="m11 7 1.4 1.4 2-2.4" />'
)

export const icons = {
  panelLeft,
  panelRight,
  newChat,
  settings,
  search,
  folder,
  folderOpen,
  file,
  terminal,
  chevronDown,
  chevronRight,
  plus,
  close,
  minus,
  maximize,
  restore,
  trash,
  copy,
  check,
  arrowUp,
  stop: stopFilled,
  star,
  starFilled,
  key,
  refresh,
  filePlus,
  folderPlus,
  history,
  circle,
  ellipsis,
  todo
}

export type IconName = keyof typeof icons
