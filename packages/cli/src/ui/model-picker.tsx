import { Box, Text, useInput } from 'ink'
import { useEffect, useMemo, useState } from 'react'
import {
  loadCatalog,
  pickerProviders,
  searchCatalog,
  describeEndpoint,
  favoriteModels,
  type ModelEntry,
  type ModelVariant,
  type ProviderEntry,
} from '@halis/core'
import { theme } from '../theme.js'

interface Row {
  kind: 'provider' | 'model' | 'variant' | 'info'
  label: string
  detail: string
  pick?: () => void
}

function formatRow(model: ModelEntry): string {
  const ctx = model.limit.context > 0 ? `${Math.round(model.limit.context / 1000)}k` : '?'
  const price =
    model.cost.input > 0 || model.cost.output > 0
      ? `$${trimNum(model.cost.input)}/$${trimNum(model.cost.output)} per M`
      : 'free'
  const reasoning = model.reasoning ? ' · reasoning' : ''
  return `ctx ${ctx} · ${price}${reasoning}`
}

function trimNum(n: number): string {
  if (n === 0) return '0'
  if (n < 0.01) return n.toExponential(0)
  if (n < 1) return n.toFixed(2)
  return n.toFixed(1)
}

/**
 * The catalog picker behind /model. Type to search the whole models.dev
 * catalog; with an empty query the favorite providers and their flagship
 * models come first. Enter on a model with reasoning variants drops into
 * a second list so the variant rides along in the saved spec.
 */
export function ModelPicker({ onPick, onClose }: { onPick: (spec: string) => void; onClose: () => void }) {
  const [providers, setProviders] = useState<ProviderEntry[] | null>(null)
  const [failed, setFailed] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState(0)
  const [variantsOf, setVariantsOf] = useState<{ model: ModelEntry; spec: string } | null>(null)

  useEffect(() => {
    let alive = true
    loadCatalog()
      .then((catalog) => {
        if (alive) setProviders(pickerProviders(catalog))
      })
      .catch((err) => {
        if (alive) setFailed(err instanceof Error ? err.message : String(err))
      })
    return () => {
      alive = false
    }
  }, [])

  const rows: Row[] = useMemo(() => {
    if (!providers) return []
    if (variantsOf) {
      const { model, spec } = variantsOf
      const rows: Row[] = [
        {
          kind: 'variant',
          label: 'default',
          detail: `${spec} — no reasoning knobs`,
          pick: () => onPick(spec),
        },
        ...model.variants.map((variant: ModelVariant) => ({
          kind: 'variant' as const,
          label: variant.id,
          detail: variantDetail(variant),
          pick: () => onPick(`${spec}#${variant.id}`),
        })),
      ]
      return rows
    }
    if (query.trim().length > 0) {
      // Search across everything; keep it to one flat, scannable list.
      const catalog = { providers, updatedAt: 0, source: 'snapshot' as const }
      const hits = searchCatalog(catalog, query, 24)
      return hits.map((hit) => ({
        kind: 'model' as const,
        label: `${hit.provider.id}/${hit.model.id}`,
        detail: formatRow(hit.model),
        pick: () => choose(hit.provider, hit.model),
      }))
    }
    const rows: Row[] = []
    for (const provider of providers.slice(0, 12)) {
      rows.push({
        kind: 'provider',
        label: `${provider.id} — ${provider.name}`,
        detail: describeEndpoint(provider),
      })
      for (const model of favoriteModels(provider)) {
        rows.push({
          kind: 'model',
          label: `${provider.id}/${model.id}`,
          detail: formatRow(model),
          pick: () => choose(provider, model),
        })
      }
    }
    return rows
    // choose() is stable enough inside the memo — it closes over onPick only.
    function choose(provider: ProviderEntry, model: ModelEntry): void {
      const spec = `${provider.id}/${model.id}`
      if (model.variants.length > 0) setVariantsOf({ model, spec })
      else onPick(spec)
    }
  }, [providers, query, variantsOf, onPick])

  useInput((input, key) => {
    if (key.escape) {
      if (variantsOf) {
        setVariantsOf(null)
        return
      }
      onClose()
      return
    }
    if (key.downArrow) return setSelected((s) => Math.min(rows.length - 1, s + 1))
    if (key.upArrow) return setSelected((s) => Math.max(0, s - 1))
    if (key.return) {
      const row = rows[selected]
      if (row?.pick) row.pick()
      return
    }
    if (key.backspace || key.delete) {
      setQuery((q) => q.slice(0, -1))
      setSelected(0)
      return
    }
    if (input && input.length === 1 && input >= ' ') {
      setQuery((q) => q + input)
      setSelected(0)
    }
  })

  if (failed) {
    return (
      <Box borderStyle="round" borderColor={theme.error} flexDirection="column" paddingX={1}>
        <Text color={theme.error}>catalog unavailable: {failed}</Text>
        <Text color={theme.faint}>esc closes — /model &lt;id&gt; and presets still work</Text>
      </Box>
    )
  }
  if (!providers) {
    return (
      <Box borderStyle="round" borderColor={theme.border} paddingX={1}>
        <Text color={theme.dim}>loading the model catalog…</Text>
      </Box>
    )
  }

  const visible = rows.slice(Math.max(0, selected - 10), Math.max(14, selected + 4))
  return (
    <Box borderStyle="round" borderColor={theme.primaryDim} flexDirection="column" paddingX={1}>
      <Text color={theme.primary} bold>
        {variantsOf ? `variants of ${variantsOf.spec}` : 'pick a model'}
        <Text color={theme.faint}> — type to search {providers.length}+ providers · enter select · esc {variantsOf ? 'back' : 'close'}</Text>
      </Text>
      {query && !variantsOf ? (
        <Text color={theme.dim}> search: {query}</Text>
      ) : null}
      {visible.map((row, i) => {
        const index = Math.max(0, selected - 10) + i
        const active = index === selected
        const color = row.kind === 'provider' ? theme.accent : theme.text
        return (
          <Box key={`${row.kind}-${row.label}-${index}`} paddingLeft={row.kind === 'provider' ? 0 : 2}>
            <Text>
              <Text color={active ? theme.primary : theme.faint}>{active ? '❯ ' : '  '}</Text>
              <Text color={active ? theme.primary : color} bold={active}>
                {row.label}
              </Text>
              {row.detail ? <Text color={theme.dim}> {row.detail}</Text> : null}
            </Text>
          </Box>
        )
      })}
      {rows.length === 0 ? <Text color={theme.dim}> nothing matches “{query}”</Text> : null}
    </Box>
  )
}

function variantDetail(variant: ModelVariant): string {
  if (variant.budgetTokens) return `thinking budget ~${variant.budgetTokens} tokens`
  if (variant.reasoningEffort) return `reasoning effort: ${variant.reasoningEffort}`
  if (variant.thinking !== undefined) return `thinking ${variant.thinking ? 'on' : 'off'}`
  return ''
}
