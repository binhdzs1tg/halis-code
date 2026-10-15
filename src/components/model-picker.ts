import { el, svg } from '../app/dom'
import { icons } from '../app/icons'
import { store } from '../app/store'
import type { ModelEntry, ModelSelection, ModelVariant, ProviderEntry } from '../../electron/shared/models'
import * as catalog from '../core/models/catalog'

interface ModelRow {
  kind: 'model'
  model: ModelEntry
  provider: ProviderEntry
}

interface VariantRow {
  kind: 'variant'
  base: ModelSelection
  variant: ModelVariant | null // null = Default
  label: string
}

interface HeaderRow {
  kind: 'header'
  label: string
}

type Row = ModelRow | VariantRow | HeaderRow

const FOOTER_HINTS = '↑↓ navigate · enter select · ctrl+f favorite · esc close'

/**
 * Full-screen overlay dialog to pick a chat model, ported from opencode's
 * model dialog: fuzzy search, provider-grouped rows, favorites and recents,
 * a "Free" badge, and a variant step for reasoning effort levels.
 */
export function openModelDialog(): void {
  if (document.querySelector('.model-overlay')) return

  let query = ''
  let highlighted = 0
  let rows: Row[] = []
  let variantBase: ModelSelection | null = null
  let autoHighlight = true

  const overlay = el('div', 'overlay model-overlay')
  const dialog = el('div', 'model-dialog')

  const title = el('div', 'dialog-title', 'Select model')

  const search = el('input', 'dialog-search') as HTMLInputElement
  search.type = 'text'
  search.placeholder = 'Search models…'
  search.spellcheck = false

  const list = el('div', 'model-list')
  const footer = el('div', 'model-footer', FOOTER_HINTS)

  dialog.append(title, search, list, footer)
  overlay.appendChild(dialog)
  document.body.appendChild(overlay)

  const close = (): void => {
    overlay.remove()
  }

  const finish = (selection: ModelSelection): void => {
    catalog.rememberSelection(selection)
    store.update({ selectedModel: selection })
    close()
  }

  function searchText(model: ModelEntry): string {
    return `${model.name} ${model.id} ${model.family ?? ''}`.toLowerCase()
  }

  function fuzzyScore(needle: string, haystack: string): number {
    if (!needle) return 0
    const index = haystack.indexOf(needle)
    if (index >= 0) return 1000 - index
    let cursor = 0
    let score = 0
    let streak = 0
    for (const char of needle) {
      const found = haystack.indexOf(char, cursor)
      if (found < 0) return -1
      streak = found === cursor ? streak + 1 : 0
      score += 10 + streak * 5 - Math.min(found - cursor, 10)
      cursor = found + 1
    }
    return score
  }

  function matches(model: ModelEntry): boolean {
    return !query || fuzzyScore(query.trim().toLowerCase(), searchText(model)) >= 0
  }

  function buildRows(): void {
    if (variantBase) {
      const found = catalog.findModel(variantBase)
      const next: Row[] = []
      if (found) {
        next.push({ kind: 'header', label: found.model.name })
        next.push({ kind: 'variant', base: variantBase, variant: null, label: 'Default' })
        for (const variant of found.model.variants) {
          next.push({ kind: 'variant', base: variantBase, variant, label: variant.label })
        }
      }
      rows = next
      return
    }

    const next: Row[] = []
    if (!query) {
      const favorites = collectMatches(catalog.loadPrefs().favorites)
      if (favorites.length > 0) {
        next.push({ kind: 'header', label: 'Favorites' })
        next.push(...favorites)
      }
      const recent = collectMatches(catalog.loadPrefs().recent)
      if (recent.length > 0) {
        next.push({ kind: 'header', label: 'Recent' })
        next.push(...recent)
      }
    }
    for (const provider of catalog.providers()) {
      const models = catalog.sortModels(provider.models.filter(matches))
      if (models.length === 0) continue
      next.push({ kind: 'header', label: provider.name })
      for (const model of models) {
        next.push({ kind: 'model', model, provider })
      }
    }
    rows = next
  }

  function collectMatches(selections: ModelSelection[]): ModelRow[] {
    const seen = new Set<string>()
    const out: ModelRow[] = []
    for (const selection of selections) {
      const key = catalog.keyOf(selection)
      if (seen.has(key)) continue
      const found = catalog.findModel(selection)
      if (!found || !matches(found.model)) continue
      seen.add(key)
      out.push({ kind: 'model', model: found.model, provider: found.provider })
    }
    return out
  }

  function rowSelection(row: Row): ModelSelection | null {
    switch (row.kind) {
      case 'model': {
        const variant = catalog.variantFor({ providerID: row.provider.id, modelID: row.model.id })
        return { providerID: row.provider.id, modelID: row.model.id, variant }
      }
      case 'variant': {
        return {
          providerID: row.base.providerID,
          modelID: row.base.modelID,
          variant: row.variant?.id
        }
      }
      default:
        return null
    }
  }

  function render(): void {
    buildRows()
    if (autoHighlight) {
      const index = rows.findIndex((row) => {
        if (row.kind === 'header') return false
        const selection = rowSelection(row)
        return selection ? matchesCurrent(selection) : false
      })
      if (index >= 0) highlighted = index
      autoHighlight = false
    }
    if (highlighted >= rows.length) highlighted = Math.max(0, rows.length - 1)

    search.style.display = variantBase ? 'none' : ''
    list.replaceChildren()
    if (rows.length === 0) {
      list.appendChild(
        el('div', 'model-empty', catalog.providers().length === 0 ? 'Loading models…' : 'No models match your search.')
      )
      return
    }

    rows.forEach((row, index) => {
      if (row.kind === 'header') {
        list.appendChild(el('div', 'model-group', row.label))
        return
      }
      const selection = rowSelection(row)
      if (!selection) return
      list.appendChild(renderRow(row, selection, index === highlighted, index))
    })

    const node = list.querySelector<HTMLElement>(`.model-row[data-index="${highlighted}"]`)
    node?.scrollIntoView({ block: 'nearest' })
  }

  function renderRow(row: Exclude<Row, HeaderRow>, selection: ModelSelection, active: boolean, index: number): HTMLElement {
    const node = el('div', `model-row${active ? ' active' : ''}`)
    node.dataset.index = String(index)

    if (row.kind === 'variant') {
      node.append(el('span', 'row-dot', '●'), el('span', 'row-name', row.label))
      if (matchesCurrent(selection)) node.classList.add('current')
      node.addEventListener('click', () => {
        highlighted = index
        activate()
      })
      return node
    }

    const { model } = row
    if (matchesCurrent(selection)) node.classList.add('current')

    const dot = el('span', 'row-dot', '●')
    const name = el('span', 'row-name', model.name)
    node.append(dot, name)

    if (model.variants.length > 0) {
      node.appendChild(el('span', 'row-meta', `${model.variants.length} reasoning`))
    }
    if (catalog.isFree(model)) {
      node.appendChild(el('span', 'row-free', 'Free'))
    }

    const favorite = el('button', `row-star${catalog.isFavorite(selection) ? ' faved' : ''}`) as HTMLButtonElement
    favorite.type = 'button'
    favorite.title = 'Toggle favorite (ctrl+f)'
    favorite.innerHTML = svg(catalog.isFavorite(selection) ? icons.starFilled : icons.star, 13).outerHTML
    favorite.addEventListener('click', (event) => {
      event.stopPropagation()
      toggleFavoriteOf(selection)
    })
    node.appendChild(favorite)

    node.addEventListener('click', () => {
      highlighted = index
      activate()
    })

    return node
  }

  function matchesCurrent(selection: ModelSelection): boolean {
    const current = store.get().selectedModel
    return Boolean(
      current &&
        current.providerID === selection.providerID &&
        current.modelID === selection.modelID &&
        (current.variant ?? undefined) === (selection.variant ?? undefined)
    )
  }

  function toggleFavoriteOf(selection: ModelSelection): void {
    catalog.toggleFavorite({ providerID: selection.providerID, modelID: selection.modelID })
    render()
  }

  function activate(): void {
    const row = rows[highlighted]
    if (!row || row.kind === 'header') return
    const selection = rowSelection(row)
    if (!selection) return

    if (row.kind === 'model') {
      if (row.model.variants.length > 0) {
        variantBase = { providerID: row.provider.id, modelID: row.model.id }
        title.textContent = `Select reasoning — ${row.model.name}`
        highlighted = 0
        autoHighlight = true
        render()
        return
      }
      finish(selection)
      return
    }

    finish({ ...selection, variant: selection.variant ?? undefined })
  }

  function moveHighlight(delta: number): void {
    jump(highlighted + delta, delta)
  }

  function jump(index: number, direction: number): void {
    if (rows.length === 0) return
    const clamped = Math.max(0, Math.min(rows.length - 1, index))
    highlighted = clamped
    if (rows[clamped].kind === 'header') {
      const next = clamped + (direction >= 0 ? 1 : -1)
      if (next >= 0 && next < rows.length) {
        jump(next, direction)
        return
      }
    }
    render()
  }

  search.addEventListener('input', () => {
    query = search.value
    highlighted = 0
    autoHighlight = false
    render()
  })

  dialog.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      if (variantBase) {
        variantBase = null
        title.textContent = 'Select model'
        highlighted = 0
        autoHighlight = true
        render()
      } else {
        close()
      }
      return
    }
    if (event.ctrlKey && event.key.toLowerCase() === 'f') {
      event.preventDefault()
      const selection = rowSelection(rows[highlighted])
      if (selection) toggleFavoriteOf(selection)
      return
    }
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault()
        moveHighlight(1)
        break
      case 'ArrowUp':
        event.preventDefault()
        moveHighlight(-1)
        break
      case 'PageDown':
        event.preventDefault()
        moveHighlight(8)
        break
      case 'PageUp':
        event.preventDefault()
        moveHighlight(-8)
        break
      case 'Home':
        event.preventDefault()
        jump(0, 1)
        break
      case 'End':
        event.preventDefault()
        jump(rows.length - 1, -1)
        break
      case 'Enter':
        event.preventDefault()
        activate()
        break
      default:
        break
    }
  })

  overlay.addEventListener('mousedown', (event) => {
    if (event.target === overlay) close()
  })

  render()
  search.focus()
  // If the dialog was opened before the catalog arrived, repaint once it does.
  void catalog.ensureCatalog().then(render)
}
