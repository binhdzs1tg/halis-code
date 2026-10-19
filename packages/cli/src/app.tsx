import { Box, Static, Text, useApp } from 'ink'
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  assessCommand,
  buildSystemPrompt,
  compactTranscript,
  defaultTools,
  estimateTokens,
  fileExists,
  loadCatalog,
  maskKey,
  PRESETS,
  resolveConfig,
  resolveTarget,
  runAgent,
  saveConfig,
  setJobSink,
  shellLabel,
  spawnShellCommand,
  killTree,
  streamChat,
  withTaskTool,
  listSkills,
  type AgentEvent,
  type AskRequest,
  type ChatMessage,
  type ModelEntry,
  type ProviderVariant,
  type ResolvedConfig,
  type TodoItem,
  type ToolCall,
} from '@halis/core'
import { writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { demoReply } from './demo.js'
import { theme } from './theme.js'
import {
  loadSessionFile,
  saveSession,
  transcriptToMarkdown,
  type SessionEntry,
  type SessionSnapshot,
} from './sessions.js'
import { VERSION } from './version.js'
import { ApprovalCard, type ApprovalChoice } from './ui/approval.js'
import { AskCard } from './ui/ask-card.js'
import { Composer } from './ui/composer.js'
import { ModelPicker } from './ui/model-picker.js'
import { ResumePicker } from './ui/resume-picker.js'
import { HistoryRow, type HistoryItem } from './ui/messages.js'
import { Markdown } from './ui/markdown.js'
import { Spinner } from './ui/spinner.js'

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never

const AGENTS_TEMPLATE = `# AGENTS.md

Instructions for coding agents working in this repository.

## Build and test

- (list the commands an agent should run: build, test, lint)

## Conventions

- (describe code style, folder layout, anything an agent must respect)
`

type Permissions = 'default' | 'auto' | 'yolo'

/** The provider bundle one run rides on, resolved from the catalog or a preset. */
interface RunTarget {
  provider: {
    baseUrl: string
    apiKey?: string
    model: string
    protocol?: 'openai' | 'anthropic'
    providerId?: string
    variant?: ProviderVariant
    maxTokens?: number
    extraHeaders?: Record<string, string>
    extraBody?: Record<string, unknown>
  }
  entry: ModelEntry | null
  spec: string | null
  label: string
  demo: boolean
}

const TITLE_SYSTEM =
  'You write short titles for coding chat sessions. Reply with the title only: 3 to 6 words, ' +
  'no surrounding quotes, no trailing punctuation, in the language of the conversation. Do not explain.'

function statusText(cfg: ResolvedConfig, target: RunTarget | null, cwd: string): string {
  const home = os.homedir()
  return [
    `version    ${VERSION}`,
    `provider   ${cfg.provider} (${cfg.label})`,
    `baseUrl    ${target?.provider.baseUrl ?? cfg.baseUrl}`,
    `model      ${target?.label ?? cfg.model}`,
    `api key    ${cfg.apiKey ? `set (${maskKey(cfg.apiKey)})` : 'not set'}${cfg.keyEnv ? ` (${cfg.keyEnv})` : ''}`,
    `approvals  ${cfg.permissions === 'yolo' ? 'off — every command runs' : cfg.permissions}`,
    `max turns  ${cfg.maxTurns}`,
    `compact    ${cfg.compactAt === 0 ? 'off' : `at ~${cfg.compactAt} tok`}`,
    `cwd        ${cwd.replace(home, '~')}`,
    `mode       ${target?.demo ? 'demo — no api key' : 'live'}`,
  ].join('\n')
}

function tail(text: string): string {
  if (text.length <= 1400) return text
  return `…${text.slice(-1400)}`
}

/** 941 → '941', 12 300 → '12.3k', 4 210 000 → '4.2M' */
export function fmtCount(n: number): string {
  if (n < 1000) return String(n)
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`
  return `${(n / 1_000_000).toFixed(1)}M`
}

/** Approval "always" sticks for the command's leading words, so `npm run`
 *  approved once covers every later `npm run …` this session. */
function commandPrefix(command: string): string {
  const words = command.trim().split(/\s+/)
  return words.length > 1 ? words.slice(0, 2).join(' ') : (words[0] ?? command)
}

function variantFrom(entry: ModelEntry, cfgVariant: string | undefined): ProviderVariant | undefined {
  if (!cfgVariant) return undefined
  const variant = entry.variants.find((v) => v.id === cfgVariant)
  if (!variant) return undefined
  return {
    ...(variant.reasoningEffort ? { reasoningEffort: variant.reasoningEffort } : {}),
    ...(variant.thinking !== undefined ? { thinking: variant.thinking } : {}),
    ...(variant.budgetTokens ? { budgetTokens: variant.budgetTokens } : {}),
    ...(variant.body ? { body: variant.body } : {}),
    ...(variant.headers ? { headers: variant.headers } : {}),
  }
}

/** Resolve the run target from the config: catalog spec first, presets second. */
async function computeTarget(cfg: ResolvedConfig): Promise<RunTarget> {
  const specCandidate = cfg.spec ?? (cfg.model.includes('/') || cfg.model.includes('#') ? cfg.model : null)
  if (specCandidate) {
    const catalog = await loadCatalog()
    const target = resolveTarget(catalog, specCandidate)
    if ('error' in target) throw new Error(target.error)
    if (target.unsupported) {
      throw new Error(`${target.provider.name} needs signed or interactive authentication that is not supported yet`)
    }
    if (target.needsKey && !target.apiKey) {
      throw new Error(
        `${target.provider.name} needs an api key — set ${target.provider.env.join(' or ') || 'HALIS_API_KEY'}`,
      )
    }
    const variant = target.variant
      ? {
          ...(target.variant.reasoningEffort ? { reasoningEffort: target.variant.reasoningEffort } : {}),
          ...(target.variant.thinking !== undefined ? { thinking: target.variant.thinking } : {}),
          ...(target.variant.budgetTokens ? { budgetTokens: target.variant.budgetTokens } : {}),
          ...(target.variant.body ? { body: target.variant.body } : {}),
          ...(target.variant.headers ? { headers: target.variant.headers } : {}),
        }
      : variantFrom(target.model, cfg.variant)
    return {
      provider: {
        baseUrl: target.baseUrl,
        model: target.model.id,
        protocol: target.protocol,
        providerId: target.provider.id,
        maxTokens: target.model.limit.output,
        ...(target.apiKey ? { apiKey: target.apiKey } : {}),
        ...(variant && Object.keys(variant).length > 0 ? { variant } : {}),
        ...(target.model.modeHeaders ? { extraHeaders: { ...target.model.modeHeaders } } : {}),
        ...(target.model.modeBody ? { extraBody: { ...target.model.modeBody } } : {}),
      },
      entry: target.model,
      spec: specCandidate,
      label: specCandidate,
      demo: false,
    }
  }
  return {
    provider: {
      baseUrl: cfg.baseUrl,
      model: cfg.model,
      ...(cfg.apiKey ? { apiKey: cfg.apiKey } : {}),
    },
    entry: null,
    spec: null,
    label: `${cfg.provider}/${cfg.model}`,
    demo: cfg.demo,
  }
}

export function App({
  initialPrompt,
  modelOverride,
  initialSession,
  continueRequested,
}: {
  initialPrompt?: string | undefined
  modelOverride?: string | undefined
  initialSession?: SessionSnapshot | undefined
  continueRequested?: boolean | undefined
}) {
  const { exit } = useApp()
  const cwd = process.cwd()
  const [cfg, setCfg] = useState<ResolvedConfig>(() => {
    const base = resolveConfig()
    if (modelOverride && (modelOverride.includes('/') || modelOverride.includes('#'))) {
      return { ...base, model: modelOverride, spec: modelOverride }
    }
    if (modelOverride) return { ...base, model: modelOverride }
    return base
  })
  const [history, setHistory] = useState<HistoryItem[]>([])
  const [live, setLive] = useState<{ text: string; tool: string | null } | null>(null)
  const [queue, setQueue] = useState<string[]>([])
  const [pending, setPending] = useState<{ call: ToolCall; resolve: (choice: ApprovalChoice) => void } | null>(null)
  const [pendingAsk, setPendingAsk] = useState<{ request: AskRequest; resolve: (answer: { text: string; cancelled: boolean }) => void } | null>(null)
  const [overlay, setOverlay] = useState<null | 'model' | 'resume'>(null)
  const [systemReady, setSystemReady] = useState(false)
  const [usage, setUsage] = useState({ input: 0, output: 0 })
  const [permissions, setPermissions] = useState<Permissions>(cfg.permissions)
  const [title, setTitle] = useState<string | null>(initialSession?.title ?? null)
  const [target, setTarget] = useState<RunTarget | null>(null)

  const cfgRef = useRef(cfg)
  cfgRef.current = cfg
  const usageRef = useRef(usage)
  usageRef.current = usage
  const permissionsRef = useRef(permissions)
  permissionsRef.current = permissions
  const targetRef = useRef<RunTarget | null>(null)
  const messagesRef = useRef<ChatMessage[]>([])
  const readFilesRef = useRef<Set<string>>(new Set())
  const abortRef = useRef<AbortController | null>(null)
  const liveTextRef = useRef('')
  const deltaBufRef = useRef('')
  const idRef = useRef(0)
  const runningRef = useRef(false)
  const approvedPrefixesRef = useRef<Set<string>>(new Set())
  const demoIdxRef = useRef(0)
  const queueRef = useRef<string[]>([])
  const systemRef = useRef<string | null>(null)
  const titleRef = useRef<string | null>(title)
  const ctrlCArmedRef = useRef(0)
  const sendRef = useRef<(text: string) => Promise<void>>(async () => {})

  const push = useCallback((item: DistributiveOmit<HistoryItem, 'id'>) => {
    setHistory((h) => [...h, { ...item, id: idRef.current++ } as HistoryItem])
  }, [])

  // Background job completion notices land as plain info rows — no polling,
  // no lost dev servers.
  useEffect(() => {
    setJobSink((job) => {
      push({
        kind: 'info',
        text: `background job ${job.id} ${job.status}${job.exitCode !== null ? ` (exit ${job.exitCode})` : ''} — job_output ${job.id} reads it`,
      })
    })
    return () => setJobSink(null)
  }, [push])

  const refreshTarget = useCallback(async () => {
    try {
      const next = await computeTarget(cfgRef.current)
      targetRef.current = next
      setTarget(next)
    } catch (err) {
      targetRef.current = null
      setTarget(null)
      push({ kind: 'error', text: err instanceof Error ? err.message : String(err) })
    }
  }, [push])

  useEffect(() => {
    push({ kind: 'splash' })
    if (initialSession) {
      messagesRef.current = initialSession.messages
      setUsage(initialSession.usage)
      push({
        kind: 'info',
        text: `picked the session back up — ${initialSession.messages.length} messages are back in context (last saved ${initialSession.saved.slice(0, 16).replace('T', ' ')})`,
      })
    } else if (continueRequested) {
      push({ kind: 'info', text: 'no earlier session for this directory — starting fresh' })
    }
    void buildSystemPrompt({ cwd }).then((system) => {
      systemRef.current = system
      setSystemReady(true)
    })
  }, [cwd, push, initialSession, continueRequested])

  useEffect(() => {
    void refreshTarget()
  }, [refreshTarget])

  useEffect(() => {
    const timer = setInterval(() => {
      if (deltaBufRef.current.length === 0) return
      const chunk = deltaBufRef.current
      deltaBufRef.current = ''
      liveTextRef.current += chunk
      setLive((l) => (l ? { ...l, text: l.text + chunk } : l))
    }, 50)
    return () => clearInterval(timer)
  }, [])

  const persist = useCallback(
    () => {
      if (cfgRef.current.demo && !targetRef.current?.spec) return
      if (messagesRef.current.length === 0) return
      void saveSession({
        cwd,
        provider: targetRef.current?.provider.providerId ?? cfgRef.current.provider,
        model: targetRef.current?.label ?? cfgRef.current.model,
        ...(titleRef.current ? { title: titleRef.current } : {}),
        usage: usageRef.current,
        messages: messagesRef.current,
      })
    },
    [cwd],
  )

  const autoTitle = useCallback(async () => {
    const current = targetRef.current
    if (!current || current.demo) return
    const firstUser = messagesRef.current.find((m) => m.role === 'user')
    const lastReply = [...messagesRef.current].reverse().find((m) => m.role === 'assistant' && m.content)
    if (!firstUser) return
    try {
      const res = await streamChat({
        baseUrl: current.provider.baseUrl,
        model: current.provider.model,
        system: TITLE_SYSTEM,
        messages: [
          {
            role: 'user',
            content:
              `<user_message>\n${firstUser.content.slice(0, 2000)}\n</user_message>` +
              (lastReply ? `\n\n<assistant_reply>\n${lastReply.content.slice(0, 800)}\n</assistant_reply>` : ''),
          },
        ],
        signal: AbortSignal.timeout(30_000),
        ...(current.provider.protocol ? { protocol: current.provider.protocol } : {}),
        ...(current.provider.providerId ? { providerId: current.provider.providerId } : {}),
        ...(current.provider.apiKey ? { apiKey: current.provider.apiKey } : {}),
      })
      const first = res.text.split('\n').map((l) => l.trim()).find((l) => l.length > 0) ?? ''
      const clean = first.replace(/^["'“”‘’]+|["'“”‘’]+$/g, '').replace(/[.!?:;]+$/g, '').replace(/\s+/g, ' ').trim()
      if (clean.length === 0) return
      const short = clean.length <= 60 ? clean : `${clean.slice(0, 59).trimEnd()}…`
      titleRef.current = short
      setTitle(short)
      persist()
    } catch {
      // a title is a nicety; silence is the right failure
    }
  }, [persist])

  const flushLive = useCallback(() => {
    liveTextRef.current += deltaBufRef.current
    deltaBufRef.current = ''
    const text = liveTextRef.current.trim()
    liveTextRef.current = ''
    if (text.length > 0) push({ kind: 'assistant', text })
  }, [push])

  const finalize = useCallback(() => {
    flushLive()
    setLive(null)
    runningRef.current = false
    persist()
    if (!titleRef.current && messagesRef.current.length >= 2) void autoTitle()
    const next = queueRef.current.shift()
    setQueue([...queueRef.current])
    if (next) setTimeout(() => void sendRef.current(next), 30)
  }, [flushLive, persist, autoTitle])

  const handleEvent = useCallback(
    (ev: AgentEvent) => {
      switch (ev.type) {
        case 'text-delta':
          deltaBufRef.current += ev.text
          break
        case 'tool-start':
          // what the model said before reaching for a tool becomes its own row
          flushLive()
          setLive({ text: '', tool: ev.call.name })
          break
        case 'tool-end':
          push({ kind: 'tool', call: ev.call, output: ev.result.output, ok: ev.result.ok, ms: ev.ms })
          setLive((l) => (l ? { ...l, tool: null } : l))
          break
        case 'usage':
          setUsage((u) => ({ input: u.input + ev.input, output: u.output + ev.output }))
          break
        case 'notice':
          push({ kind: 'info', text: ev.text })
          break
        case 'error':
          flushLive()
          push({ kind: 'error', text: ev.message })
          break
        case 'cost':
        case 'title':
          break
        case 'done':
          finalize()
          break
      }
    },
    [finalize, flushLive, push],
  )

  const approveCall = useCallback(
    (call: ToolCall): Promise<boolean> => {
      if (call.name !== 'bash') return Promise.resolve(true)
      const command = typeof call.input.command === 'string' ? call.input.command : ''
      const mode = permissionsRef.current
      if (mode === 'yolo') return Promise.resolve(true)
      if (approvedPrefixesRef.current.has(commandPrefix(command))) return Promise.resolve(true)
      const risky = command.length > 0 ? assessCommand(command) : null
      if (mode === 'auto' && !risky) return Promise.resolve(true)
      return new Promise((resolve) => {
        setPending({
          call,
          resolve: (choice) => {
            if (choice === 'always') approvedPrefixesRef.current.add(commandPrefix(command))
            setPending(null)
            resolve(choice !== 'no')
          },
        })
      })
    },
    [],
  )

  const askUser = useCallback(
    (request: AskRequest): Promise<{ text: string; cancelled: boolean }> => {
      return new Promise((resolve) => {
        setPendingAsk({
          request,
          resolve: (answer) => {
            setPendingAsk(null)
            resolve(answer)
          },
        })
      })
    },
    [],
  )

  const send = useCallback(
    async (text: string) => {
      runningRef.current = true
      push({ kind: 'user', text })
      messagesRef.current.push({ role: 'user', content: text })

      const current = targetRef.current
      if (!current || current.demo) {
        setLive({ text: '', tool: null })
        await new Promise((r) => setTimeout(r, 400))
        const reply = demoReply(demoIdxRef.current++)
        liveTextRef.current = reply
        setLive({ text: reply, tool: null })
        setTimeout(finalize, 500)
        return
      }

      const controller = new AbortController()
      abortRef.current = controller
      setLive({ text: '', tool: null })
      if (!systemRef.current) systemRef.current = await buildSystemPrompt({ cwd })
      const baseTools = defaultTools()
      await runAgent({
        system: systemRef.current,
        messages: messagesRef.current,
        tools: withTaskTool(baseTools, {
          provider: current.provider,
          tools: baseTools,
          readFiles: readFilesRef.current,
          cwd,
          approve: approveCall,
        }),
        maxTurns: cfgRef.current.maxTurns,
        signal: controller.signal,
        cwd,
        compactAt: cfgRef.current.compactAt,
        provider: current.provider,
        readFiles: readFilesRef.current,
        onEvent: handleEvent,
        approve: approveCall,
        askUser,
        setTodos: (items: TodoItem[]) => push({ kind: 'todos', items }),
      })
    },
    [approveCall, askUser, cwd, finalize, handleEvent, push],
  )

  sendRef.current = send

  const sentInitialRef = useRef(false)
  useEffect(() => {
    if (initialPrompt && systemReady && !sentInitialRef.current && targetRef.current) {
      sentInitialRef.current = true
      void send(initialPrompt)
    }
  }, [initialPrompt, systemReady, send, target])

  const runLocalShell = useCallback(
    async (command: string) => {
      runningRef.current = true
      const shell = `!${shellLabel()}`
      push({ kind: 'tool', call: { id: 'local', name: shell, input: { command } }, output: '', ok: true, ms: 0 })
      setLive({ text: '', tool: shell })
      const started = Date.now()
      const output = await new Promise<string>((resolve) => {
        const child = spawnShellCommand(command, {
          cwd,
          env: { ...process.env, NO_COLOR: '1', TERM: 'dumb', PAGER: 'cat' },
          stdio: ['ignore', 'pipe', 'pipe'],
        })
        let out = ''
        const timer = setTimeout(() => {
          killTree(child)
        }, 120_000)
        child.stdout?.on('data', (chunk: Buffer) => {
          out += chunk.toString()
          if (out.length > 60_000) out = out.slice(0, 60_000)
        })
        child.stderr?.on('data', (chunk: Buffer) => {
          out += chunk.toString()
          if (out.length > 60_000) out = out.slice(0, 60_000)
        })
        child.on('error', (err) => {
          clearTimeout(timer)
          resolve(`${out}\nerror: ${err.message}`)
        })
        child.on('close', (code) => {
          clearTimeout(timer)
          resolve(`exit ${code ?? '?'}\n${out || '(no output)'}`)
        })
      })
      push({
        kind: 'tool',
        call: { id: 'local', name: shell, input: { command } },
        output: output.replace(/^exit \d+\n/, ''),
        ok: output.startsWith('exit 0'),
        ms: Date.now() - started,
      })
      flushLive()
      setLive(null)
      runningRef.current = false
    },
    [cwd, flushLive, push],
  )

  const applyModelSpec = useCallback(
    async (spec: string) => {
      try {
        const catalog = await loadCatalog()
        const resolved = resolveTarget(catalog, spec)
        if ('error' in resolved) {
          push({ kind: 'error', text: resolved.error })
          return
        }
        await saveConfig({ model: spec })
        setCfg((c) => ({ ...c, model: spec, spec }))
        push({ kind: 'info', text: `model set to ${spec} — ${resolved.provider.name}, ${resolved.baseUrl}` })
        await refreshTarget()
      } catch (err) {
        push({ kind: 'error', text: `catalog unavailable (${err instanceof Error ? err.message : String(err)}) — set HALIS_BASE_URL to keep the preset path` })
      }
    },
    [push, refreshTarget],
  )

  const loadEntry = useCallback(
    async (entry: SessionEntry) => {
      const snapshot = await loadSessionFile(entry.file)
      setOverlay(null)
      if (!snapshot) {
        push({ kind: 'error', text: 'that session file is unreadable' })
        return
      }
      messagesRef.current = snapshot.messages
      readFilesRef.current = new Set()
      setUsage(snapshot.usage)
      if (snapshot.title) {
        titleRef.current = snapshot.title
        setTitle(snapshot.title)
      }
      if (snapshot.model) {
        const spec = snapshot.model.includes('/') || snapshot.model.includes('#') ? snapshot.model : null
        if (spec) {
          await saveConfig({ model: spec })
          setCfg((c) => ({ ...c, model: spec, spec }))
        }
      }
      push({
        kind: 'info',
        text: `loaded “${entry.title}” — ${snapshot.messages.length} messages back in context`,
      })
    },
    [push],
  )

  const runDiff = useCallback(async () => {
    await runLocalShell('git --no-pager diff --stat && git --no-pager diff | head -c 6000')
  }, [runLocalShell])

  const runCompact = useCallback(async () => {
    const current = targetRef.current
    if (!current || current.demo) {
      push({ kind: 'info', text: 'nothing to compact in demo mode' })
      return
    }
    const estimated = estimateTokens(messagesRef.current)
    if (estimated < 2000) {
      push({ kind: 'info', text: `the transcript is only ~${fmtCount(estimated)} tokens — nothing worth compacting` })
      return
    }
    try {
      const replaced = await compactTranscript({
        messages: messagesRef.current,
        compactAt: Math.max(1, estimated - 1),
        provider: current.provider,
        signal: new AbortController().signal,
      })
      push({
        kind: 'info',
        text: replaced > 0 ? `compacted ${replaced} messages into a summary — now ~${fmtCount(estimateTokens(messagesRef.current))} tokens` : 'no safe cut point found — try again after the next exchange',
      })
      persist()
    } catch (err) {
      push({ kind: 'error', text: `compaction failed: ${err instanceof Error ? err.message : String(err)}` })
    }
  }, [persist, push])

  const runExport = useCallback(async () => {
    if (messagesRef.current.length === 0) {
      push({ kind: 'info', text: 'nothing to export yet' })
      return
    }
    const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '')
    const file = path.join(cwd, `halis-session-${stamp}.md`)
    try {
      await writeFile(file, transcriptToMarkdown({
        cwd,
        model: targetRef.current?.label ?? cfgRef.current.model,
        saved: new Date().toISOString(),
        messages: messagesRef.current,
      }), 'utf8')
      push({ kind: 'info', text: `transcript written to ${file}` })
    } catch (err) {
      push({ kind: 'error', text: `export failed: ${err instanceof Error ? err.message : String(err)}` })
    }
  }, [cwd, push])

  const runDoctor = useCallback(async () => {
    const lines: string[] = [`halis ${VERSION}`, `node ${process.version}`, `cwd ${cwd.replace(os.homedir(), '~')}`]
    const current = targetRef.current
    if (current) {
      lines.push(`model ${current.label}`, `endpoint ${current.provider.baseUrl} (${current.provider.protocol})`)
      try {
        const res = await fetch(current.provider.baseUrl.replace(/\/+$/, '') + '/models', {
          method: 'GET',
          signal: AbortSignal.timeout(4000),
        })
        lines.push(`endpoint probe http ${res.status} ${res.ok ? '(reachable)' : '(answered, maybe fine for chat)'}`)
      } catch {
        lines.push('endpoint probe failed — the base url may be wrong, or the network is down')
      }
    } else {
      lines.push('model target not resolved — fix the error above this line')
    }
    lines.push(`api key ${cfgRef.current.apiKey ? `set (${maskKey(cfgRef.current.apiKey)})` : 'not set'}`)
    try {
      const catalog = await loadCatalog()
      lines.push(`catalog ${catalog.providers.length} providers (${catalog.source}, ${new Date(catalog.updatedAt).toISOString().slice(0, 10)})`)
    } catch (err) {
      lines.push(`catalog failed: ${err instanceof Error ? err.message : String(err)}`)
    }
    lines.push(`sessions ${path.join(process.env.HALIS_HOME ?? path.join(os.homedir(), '.halis'), 'sessions')}`)
    push({ kind: 'status', text: lines.join('\n') })
  }, [cwd, push])

  const executeCommand = useCallback(
    async (raw: string) => {
      const cmd = raw.trim().split(/\s+/)[0] ?? ''
      const arg = raw.slice(cmd.length).trim()
      switch (cmd) {
        case '/help':
          push({ kind: 'help' })
          break
        case '/mascot':
          push({ kind: 'mascot' })
          break
        case '/clear':
        case '/new':
          messagesRef.current = []
          readFilesRef.current = new Set()
          setUsage({ input: 0, output: 0 })
          titleRef.current = null
          setTitle(null)
          push({ kind: 'info', text: 'context cleared — the penguin forgot everything above' })
          break
        case '/model': {
          if (arg.length > 0) await applyModelSpec(arg)
          else setOverlay('model')
          break
        }
        case '/models':
          setOverlay('model')
          break
        case '/provider': {
          const preset = PRESETS[arg]
          if (!preset) {
            push({
              kind: 'info',
              text: `presets: ${Object.keys(PRESETS).join(', ')}\ncurrent: ${cfgRef.current.provider}\nthe full catalog lives behind /model — try /model deepseek/deepseek-chat`,
            })
          } else {
            await saveConfig({ provider: arg, model: preset.model })
            setCfg(resolveConfig())
            push({ kind: 'info', text: `provider set to ${arg} (${preset.label}), model ${preset.model}` })
            await refreshTarget()
          }
          break
        }
        case '/diff':
          await runDiff()
          break
        case '/compact':
          await runCompact()
          break
        case '/resume':
          setOverlay('resume')
          break
        case '/title': {
          if (arg.length > 0) {
            titleRef.current = arg
            setTitle(arg)
            persist()
            push({ kind: 'info', text: `session renamed to “${arg}”` })
          } else {
            push({ kind: 'info', text: `session title: ${titleRef.current ?? '(none yet)'} — /title <name> renames it` })
          }
          break
        }
        case '/export':
          await runExport()
          break
        case '/usage': {
          const entry = targetRef.current?.entry
          const cost =
            entry && (entry.cost.input > 0 || entry.cost.output > 0)
              ? (usageRef.current.input / 1_000_000) * entry.cost.input +
                (usageRef.current.output / 1_000_000) * entry.cost.output
              : 0
          const turns = messagesRef.current.filter((m) => m.role === 'assistant').length
          push({
            kind: 'status',
            text: [
              `input     ${fmtCount(usageRef.current.input)} tok`,
              `output    ${fmtCount(usageRef.current.output)} tok`,
              entry ? `rates     $${entry.cost.input}/M in · $${entry.cost.output}/M out` : 'rates     unknown for this preset — pick a catalog model with /model',
              cost > 0 ? `cost      ~$${cost.toFixed(4)} this session` : 'cost      free or unknown',
              `turns     ${turns}`,
              `context   ~${fmtCount(estimateTokens(messagesRef.current))} tok now in the transcript`,
            ].join('\n'),
          })
          break
        }
        case '/skills': {
          const skills = listSkills(cwd)
          push({
            kind: 'status',
            text:
              skills.length === 0
                ? 'no skills installed — drop a .halis/skills/<name>/SKILL.md here or in ~/.halis/skills/'
                : ['skills the model can load:', ...skills.map((s) => `  ${s.name.padEnd(20)} ${s.description}`)].join('\n'),
          })
          break
        }
        case '/yolo': {
          const nextMode: Permissions = permissionsRef.current === 'yolo' ? 'default' : 'yolo'
          setPermissions(nextMode)
          approvedPrefixesRef.current.clear()
          await saveConfig({ permissions: nextMode })
          push({
            kind: 'info',
            text:
              nextMode === 'yolo'
                ? 'approvals off — every command runs without asking. /yolo again to turn them back on.'
                : 'approvals back on — bash asks again.',
          })
          break
        }
        case '/doctor':
          await runDoctor()
          break
        case '/status':
          push({ kind: 'status', text: statusText(cfgRef.current, targetRef.current, cwd) })
          break
        case '/init': {
          const file = path.join(cwd, 'AGENTS.md')
          if (await fileExists(file)) {
            push({ kind: 'info', text: 'AGENTS.md already exists here' })
          } else {
            await writeFile(file, AGENTS_TEMPLATE, 'utf8')
            systemRef.current = null
            setSystemReady(false)
            void buildSystemPrompt({ cwd }).then((system) => {
              systemRef.current = system
              setSystemReady(true)
            })
            push({ kind: 'info', text: 'created AGENTS.md — list build/test commands there and I will follow them' })
          }
          break
        }
        case '/exit':
        case '/quit':
          exit()
          break
        default:
          push({ kind: 'error', text: `unknown command ${cmd} — /help lists them all` })
      }
    },
    [applyModelSpec, cwd, exit, persist, push, refreshTarget, runCompact, runDiff, runDoctor, runExport],
  )

  const handleSubmit = useCallback(
    (value: string) => {
      if (value.startsWith('!') && value.trim().length > 1) {
        void runLocalShell(value.trim().slice(1).trim())
        return
      }
      if (runningRef.current) {
        queueRef.current.push(value)
        setQueue([...queueRef.current])
        return
      }
      if (value.startsWith('/')) void executeCommand(value)
      else void send(value)
    },
    [executeCommand, runLocalShell, send],
  )

  const interrupt = useCallback(() => {
    abortRef.current?.abort()
  }, [])

  const onCtrlC = useCallback(() => {
    if (runningRef.current) {
      abortRef.current?.abort()
      return
    }
    if (Date.now() - ctrlCArmedRef.current < 2000) {
      exit()
      return
    }
    ctrlCArmedRef.current = Date.now()
    push({ kind: 'info', text: 'press ctrl+c again to quit' })
  }, [exit, push])

  const running = live !== null
  const entry = target?.entry
  const contextPct = entry && entry.limit.context > 0 ? Math.min(100, Math.round((estimateTokens(messagesRef.current) / entry.limit.context) * 100)) : null
  const sessionCost =
    entry && (entry.cost.input > 0 || entry.cost.output > 0)
      ? (usage.input / 1_000_000) * entry.cost.input + (usage.output / 1_000_000) * entry.cost.output
      : 0
  const tokenLabel =
    usage.input + usage.output > 0
      ? `${fmtCount(usage.input)} in · ${fmtCount(usage.output)} out`
      : `~${fmtCount(estimateTokens(messagesRef.current))} tok`

  return (
    <>
      <Static items={history}>
        {(item) => (
          <Box key={item.id} flexDirection="column">
            <HistoryRow item={item} cfg={cfg} cwd={cwd} />
          </Box>
        )}
      </Static>
      <Box flexDirection="column">
        {overlay === 'model' ? (
          <ModelPicker
            onPick={(spec) => {
              setOverlay(null)
              void applyModelSpec(spec)
            }}
            onClose={() => setOverlay(null)}
          />
        ) : null}
        {overlay === 'resume' ? (
          <ResumePicker
            onPick={(entry2) => void loadEntry(entry2)}
            onClose={() => setOverlay(null)}
          />
        ) : null}
        {pending ? <ApprovalCard call={pending.call} onChoice={(c) => pending.resolve(c)} /> : null}
        {pendingAsk ? <AskCard request={pendingAsk.request} onAnswer={(text, cancelled) => pendingAsk.resolve({ text, cancelled })} /> : null}
        {!overlay && running && live ? (
          <Box flexDirection="column">
            {live.text.length > 0 ? (
              <Box paddingLeft={2}>
                <Markdown text={tail(live.text)} />
              </Box>
            ) : null}
            <Spinner label={live.tool ? `Running ${live.tool}…` : 'Thinking…'} />
          </Box>
        ) : null}
        {queue.map((q, i) => (
          <Text key={i} color={theme.faint}>
            {'  queued '}
            {q}
          </Text>
        ))}
        {!overlay ? (
          <>
            <Composer
              mode={pending || pendingAsk ? 'approval' : running ? 'running' : 'input'}
              onSubmit={handleSubmit}
              onInterrupt={interrupt}
              onExit={onCtrlC}
            />
            <Box justifyContent="space-between" paddingX={1}>
              <Text color={theme.faint}>
                {running ? 'esc to interrupt · ctrl+c to cancel' : '/help commands · ! shell · ctrl+c twice quits'}
              </Text>
              <Text color={theme.faint}>
                {target?.demo ? 'demo · ' : ''}
                {title ? `“${title}” · ` : ''}
                {target?.label ?? cfg.model}
                {contextPct !== null ? ` · ctx ${contextPct}%` : ''}
                {sessionCost > 0 ? ` · $${sessionCost.toFixed(4)}` : ''}
                {` · ${tokenLabel}`}
              </Text>
            </Box>
          </>
        ) : null}
      </Box>
    </>
  )
}
