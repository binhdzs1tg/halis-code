import type { HalisApi } from '../../electron/shared/api'

declare global {
  interface Window {
    halis: HalisApi
  }
}

export {}
