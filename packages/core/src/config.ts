import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ChatMessage } from './types.js'

export interface Preset {
  label: string
  baseUrl: string
  keyEnv: string | null
  model: string
}

export const PRESETS: Record<string, Preset> = {
  zai: { label: 'Z.ai', baseUrl: 'https://api.z.ai/api/paas/v4', keyEnv: 'ZAI_API_KEY', model: 'glm-4.7-flash' },
  deepseek: { label: 'DeepSeek', baseUrl: 'https://api.deepseek.com', keyEnv: 'DEEPSEEK_API_KEY', model: 'deepseek-chat' },
  moonshot: { label: 'Moonshot', baseUrl: 'https://api.moonshot.ai/v1', keyEnv: 'MOONSHOT_API_KEY', model: 'kimi-k2' },
  groq: { label: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', keyEnv: 'GROQ_API_KEY', model: 'llama-3.3-70b-versatile' },
  openai: { label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', keyEnv: 'OPENAI_API_KEY', model: 'gpt-4o' },
  openrouter: { label: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', keyEnv: 'OPENROUTER_API_KEY', model: 'openrouter/auto' },
  ollama: { label: 'Ollama', baseUrl: 'http://localhost:11434/v1', keyEnv: null, model: 'qwen3-coder' },
}

export const DEFAULT_PRESET = 'zai'
export const DEFAULT_MAX_TURNS = 16
/** Transcript token estimate that triggers compaction when the host does not set one. */
export const DEFAULT_COMPACT_AT = 30_000

export interface ConfigFile {
  provider?: string
  baseUrl?: string
  model?: string
  variant?: string
  maxTurns?: number
  compactAt?: number
  /** 'default' asks per bash call, 'auto' only for risky ones, 'yolo' never asks. */
  permissions?: 'default' | 'auto' | 'yolo'
}

export interface ResolvedConfig {
  provider: string
  label: string
  baseUrl: string
  apiKey?: string
  model: string
  variant?: string
  maxTurns: number
  compactAt: number
  demo: boolean
  keyEnv: string | null
  permissions: 'default' | 'auto' | 'yolo'
  /** provider/model when the model field carries one. */
  spec?: string
}

export function configPath(): string {
  return process.env.HALIS_CONFIG ?? path.join(process.env.HALIS_HOME ?? os.homedir(), '.halis', 'config.json')
}

export function loadConfigFile(): ConfigFile {
  try {
    return JSON.parse(readFileSync(configPath(), 'utf8')) as ConfigFile
  } catch {
    return {}
  }
}

export function resolveConfig(): ResolvedConfig {
  const file = loadConfigFile()
  const provider = envOr('HALIS_PROVIDER', file.provider ?? DEFAULT_PRESET)
  const preset = PRESETS[provider] ?? PRESETS[DEFAULT_PRESET]
  if (!preset) throw new Error(`unknown provider preset: ${provider}`)
  const baseUrl = envOr('HALIS_BASE_URL', file.baseUrl ?? preset.baseUrl)
  const rawModel = envOr('HALIS_MODEL', file.model ?? preset.model)
  // A spec like provider/model#variant rides along; the catalog resolver in
  // @halis/core turns it into a real endpoint when the cli loads its catalog.
  const spec = rawModel.includes('/') || rawModel.includes('#') ? rawModel : undefined
  const model = rawModel
  const variant = file.variant ? envOr('HALIS_VARIANT', file.variant) : undefined
  const keyEnv = preset.keyEnv ?? 'HALIS_API_KEY'

  let apiKey = process.env.HALIS_API_KEY?.trim() || undefined
  if (!apiKey && keyEnv && provider !== DEFAULT_PRESET) apiKey = process.env[keyEnv]?.trim() || undefined
  if (!apiKey && keyEnv) apiKey = process.env[keyEnv]?.trim() || undefined

  const demo = !apiKey && provider !== 'ollama' && !baseUrl.includes('localhost') && !baseUrl.includes('127.0.0.1')
  const compactAt = file.compactAt ?? DEFAULT_COMPACT_AT
  const permissionsRaw = process.env.HALIS_PERMISSIONS?.trim() || file.permissions || 'default'
  const permissions: ResolvedConfig['permissions'] =
    permissionsRaw === 'yolo' || permissionsRaw === 'auto' ? permissionsRaw : 'default'
  return {
    provider,
    label: preset.label,
    baseUrl,
    ...(apiKey ? { apiKey } : {}),
    model,
    ...(variant ? { variant } : {}),
    ...(spec ? { spec } : {}),
    maxTurns: file.maxTurns ?? DEFAULT_MAX_TURNS,
    compactAt,
    demo,
    keyEnv,
    permissions,
  }
}

export async function saveConfig(patch: ConfigFile): Promise<void> {
  const file = configPath()
  let current: ConfigFile = {}
  try {
    current = JSON.parse(await readFile(file, 'utf8')) as ConfigFile
  } catch {
    /* first write */
  }
  const next = { ...current, ...patch }
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
}

function envOr(name: string, fallback: string): string {
  const value = process.env[name]?.trim()
  return value && value.length > 0 ? value : fallback
}

export function maskKey(apiKey?: string): string {
  if (!apiKey) return 'not set'
  if (apiKey.length <= 8) return '***'
  return `${apiKey.slice(0, 4)}…${apiKey.slice(-4)}`
}

export function estimateTokens(messages: ChatMessage[]): number {
  let chars = 0
  for (const m of messages) chars += m.content.length + (m.toolCalls?.length ?? 0) * 64
  return Math.round(chars / 4)
}
