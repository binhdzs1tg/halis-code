const SVG_ATTRS =
  'xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="%SIZE%" height="%SIZE%" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"'

function icon(paths: string): string {
  return `<svg ${SVG_ATTRS}>${paths}</svg>`
}

export const icons = {
  logo: icon('<path d="M12 3.5l1.9 5.1 5.1 1.9-5.1 1.9L12 17.5l-1.9-5.1L5 10.5l5.1-1.9z" fill="currentColor" stroke="none"/><path d="M18.5 15.5l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8z" fill="currentColor" stroke="none"/>'),
  folder: icon('<path d="M3 7a2 2 0 0 1 2-2h4l2.2 2.2H19a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>'),
  file: icon('<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4"/>'),
  search: icon('<circle cx="11" cy="11" r="6.5"/><path d="M20 20l-3.8-3.8"/>'),
  sliders: icon('<path d="M4 7h9M17 7h3M4 12h3M11 12h9M4 17h11M19 17h1"/><circle cx="15" cy="7" r="1.8"/><circle cx="9" cy="12" r="1.8"/><circle cx="17" cy="17" r="1.8"/>'),
  chat: icon('<path d="M4 6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H9l-5 4z"/>'),
  chevron: icon('<path d="M9.5 6.5l6 5.5-6 5.5"/>'),
  chevronDown: icon('<path d="M6.5 9.5l5.5 6 5.5-6"/>'),
  close: icon('<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>'),
  minus: icon('<path d="M5.5 12h13"/>'),
  maximize: icon('<rect x="5.5" y="5.5" width="13" height="13" rx="1.5"/>'),
  restore: icon('<rect x="4.5" y="7.5" width="12" height="12" rx="1.5"/><path d="M8 4.5h11.5V16"/>'),
  terminal: icon('<rect x="3" y="4.5" width="18" height="15" rx="2"/><path d="M7 9.5l3 2.7-3 2.7M12.5 15H17"/>'),
  dot: icon('<circle cx="12" cy="12" r="4" fill="currentColor" stroke="none"/>')
}

export type IconName = keyof typeof icons
