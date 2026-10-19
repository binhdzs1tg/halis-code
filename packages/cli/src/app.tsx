import { Box, Static, Text, useApp } from 'ink'
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  buildSystemPrompt,
  defaultTools,
  estimateTokens,
  fileExists,
  PRESETS,
  resolveConfig,
  runAgent,
  saveConfig,
  type AgentEvent,
  type ChatMessage,
  type ResolvedConfig,
  type TodoItem,
  type ToolCall,
} from '@halis/core'
import os from 'node:os'
import path from 'node:path'
import { writeFile } from 'node:fs/promises'
import { demoReply } from './demo.js'
import { theme } from './theme.js'
import { saveSession, type SessionSnapshot } from './sessions.js'
import { VERSION } from './version.js'
import { ApprovalCard, type ApprovalChoice } from './ui/approval.js'
import { Composer } from './ui/composer.js'
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

function statusText(cfg: ResolvedConfig, cwd: string): string {
  const home = os.homedir()
  return [
    `version    ${VERSION}`,
    `provider   ${cfg.provider} (${cfg.label})`,
    `baseUrl    ${cfg.baseUrl}`,
    `model      ${cfg.model}`,
    `api key    ${cfg.apiKey ? 'set' : 'not set'}${cfg.keyEnv ? ` (${cfg.keyEnv})` : ''}`,
    `max turns  ${cfg.maxTurns}`,
    `compact    ${cfg.compactAt === 0 ? 'off' : `at ~${cfg.compactAt} tok`}`,
    `cwd        ${cwd.replace(home, '~')}`,
    `mode       ${cfg.demo ? 'demo — no api key' : 'live'}`,
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
    return modelOverride ? { ...base, model: modelOverride } : base
  })
  const [history, setHistory] = useState<HistoryItem[]>([])
  const [live, setLive] = useState<{ text: string; tool: string | null } | null>(null)
  const [queue, setQueue] = useState<string[]>([])
  const [pending, setPending] = useState<{ call: ToolCall; resolve: (choice: ApprovalChoice) => void } | null>(null)
  const [systemReady, setSystemReady] = useState(false)
  const [usage, setUsage] = useState({ input: 0, output: 0 })

  const cfgRef = useRef(cfg)
  cfgRef.current = cfg
  const usageRef = useRef(usage)
  usageRef.current = usage
  const messagesRef = useRef<ChatMessage[]>([])
  const readFilesRef = useRef<Set<string>>(new Set())
  const abortRef = useRef<AbortController | null>(null)
  const liveTextRef = useRef('')
  const deltaBufRef = useRef('')
  const idRef = useRef(0)
  const runningRef = useRef(false)
  const bashApprovedRef = useRef(false)
  const demoIdxRef = useRef(0)
  const queueRef = useRef<string[]>([])
  const systemRef = useRef<string | null>(null)
  const sendRef = useRef<(text: string) => Promise<void>>(async () => {})

  const push = useCallback((item: DistributiveOmit<HistoryItem, 'id'>) => {
    setHistory((h) => [...h, { ...item, id: idRef.current++ } as HistoryItem])
  }, [])

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
    const timer = setInterval(() => {
      if (deltaBufRef.current.length === 0) return
      const chunk = deltaBufRef.current
      deltaBufRef.current = ''
      liveTextRef.current += chunk
      setLive((l) => (l ? { ...l, text: l.text + chunk } : l))
    }, 50)
    return () => clearInterval(timer)
  }, [])

  const persist = useCallback(() => {
    if (cfgRef.current.demo) return
    if (messagesRef.current.length === 0) return
    void saveSession({
      cwd,
      provider: cfgRef.current.provider,
      model: cfgRef.current.model,
      usage: usageRef.current,
      messages: messagesRef.current,
    })
  }, [cwd])

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
    const next = queueRef.current.shift()
    setQueue([...queueRef.current])
    if (next) setTimeout(() => void sendRef.current(next), 30)
  }, [flushLive, persist])

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
        case 'done':
          finalize()
          break
      }
    },
    [finalize, flushLive, push],
  )

  const approveCall = useCallback((call: ToolCall): Promise<boolean> => {
    if (call.name !== 'bash' || bashApprovedRef.current) return Promise.resolve(true)
    return new Promise((resolve) => {
      setPending({
        call,
        resolve: (choice) => {
          if (choice === 'always') bashApprovedRef.current = true
          setPending(null)
          resolve(choice !== 'no')
        },
      })
    })
  }, [])

  const send = useCallback(
    async (text: string) => {
      runningRef.current = true
      push({ kind: 'user', text })
      messagesRef.current.push({ role: 'user', content: text })

      if (cfgRef.current.demo) {
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
      await runAgent({
        system: systemRef.current,
        messages: messagesRef.current,
        tools: defaultTools(),
        maxTurns: cfgRef.current.maxTurns,
        signal: controller.signal,
        cwd,
        compactAt: cfgRef.current.compactAt,
        provider: {
          baseUrl: cfgRef.current.baseUrl,
          model: cfgRef.current.model,
          ...(cfgRef.current.apiKey ? { apiKey: cfgRef.current.apiKey } : {}),
        },
        readFiles: readFilesRef.current,
        onEvent: handleEvent,
        approve: approveCall,
        setTodos: (items: TodoItem[]) => push({ kind: 'todos', items }),
      })
    },
    [approveCall, cwd, finalize, handleEvent, push],
  )

  sendRef.current = send

  const sentInitialRef = useRef(false)
  useEffect(() => {
    if (initialPrompt && systemReady && !sentInitialRef.current) {
      sentInitialRef.current = true
      void send(initialPrompt)
    }
  }, [initialPrompt, systemReady, send])

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
          messagesRef.current = []
          readFilesRef.current = new Set()
          setUsage({ input: 0, output: 0 })
          push({ kind: 'info', text: 'context cleared — the penguin forgot everything above' })
          break
        case '/model': {
          if (arg.length > 0) {
            await saveConfig({ model: arg })
            setCfg((c) => ({ ...c, model: arg }))
            push({ kind: 'info', text: `model set to ${arg}` })
          } else {
            push({
              kind: 'info',
              text: `model: ${cfgRef.current.model} @ ${cfgRef.current.label}\nswitch with /model <id> · presets with /provider <name>`,
            })
          }
          break
        }
        case '/provider': {
          const preset = PRESETS[arg]
          if (!preset) {
            push({
              kind: 'info',
              text: `providers: ${Object.keys(PRESETS).join(', ')}\ncurrent: ${cfgRef.current.provider}`,
            })
          } else {
            await saveConfig({ provider: arg, model: preset.model })
            setCfg(resolveConfig())
            push({ kind: 'info', text: `provider set to ${arg} (${preset.label}), model ${preset.model}` })
          }
          break
        }
        case '/status':
          push({ kind: 'status', text: statusText(cfgRef.current, cwd) })
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
    [cwd, exit, push],
  )

  const handleSubmit = useCallback(
    (value: string) => {
      if (runningRef.current) {
        queueRef.current.push(value)
        setQueue([...queueRef.current])
        return
      }
      if (value.startsWith('/')) void executeCommand(value)
      else void send(value)
    },
    [executeCommand, send],
  )

  const interrupt = useCallback(() => {
    abortRef.current?.abort()
  }, [])

  const onCtrlC = useCallback(() => {
    if (runningRef.current) {
      abortRef.current?.abort()
      return
    }
    exit()
  }, [exit])

  const running = live !== null
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
        {pending ? <ApprovalCard call={pending.call} onChoice={(c) => pending.resolve(c)} /> : null}
        {running && live ? (
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
        <Composer
          mode={pending ? 'approval' : running ? 'running' : 'input'}
          onSubmit={handleSubmit}
          onInterrupt={interrupt}
          onExit={onCtrlC}
        />
        <Box justifyContent="space-between" paddingX={1}>
          <Text color={theme.faint}>
            {running ? 'esc to interrupt · ctrl+c to cancel' : '/help commands · ctrl+c quit'}
          </Text>
          <Text color={theme.faint}>
            {cfg.demo ? 'demo · ' : ''}
            {cfg.model} · {tokenLabel}
          </Text>
        </Box>
      </Box>
    </>
  )
}
