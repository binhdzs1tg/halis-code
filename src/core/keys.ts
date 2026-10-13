import type { ProviderKeyStatus, ProviderKeyStatuses } from '../../electron/shared/types'

let statuses: ProviderKeyStatuses = {}
let pending: Promise<ProviderKeyStatuses> | null = null

/** Re-fetch which providers currently have a key; coalesces concurrent calls. */
export function refreshKeyStatuses(): Promise<ProviderKeyStatuses> {
  if (!pending) {
    pending = window.halis
      .getKeyStatuses()
      .then((next) => {
        statuses = next
        return next
      })
      .finally(() => {
        pending = null
      })
  }
  return pending
}

export function keyStatusOf(providerId: string | null | undefined): ProviderKeyStatus | null {
  if (!providerId) return null
  return statuses[providerId] ?? null
}
