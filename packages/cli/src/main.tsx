import { render } from 'ink'
import {
  runAgent,
  buildSystemPrompt,
  defaultTools,
  loadCatalog,
  resolveConfig,
  resolveTarget,
  assessCommand,
  denialText,
  type ChatMessage,
} from '@halis/core'
import { App, variantFrom } from './app.js'
import { DEMO_REPLIES } from './demo.js'
import { loadLatestSession, listSessions } from './sessions.js'
import { VERSION } from './version.js'
import { MASCOT_FULL, renderAnsi } from './mascot-art.js'

const HELP = `  Halis Code ${VERSION} — the blue penguin for your terminal

  usage
    halis                          interactive session
    halis "prompt"                 start with a first prompt
    halis -p "prompt"              answer once and print it
    halis -p --json "prompt"       print one json line per event
    halis -c                       continue the last session in this folder
    halis -m provider/model        model for this session, e.g. -m anthropic/claude-sonnet-4-5#high
    halis --yolo "prompt"          run without command approvals
    halis sessions                 list stored sessions
    halis mascot                   show the penguin

  config   ~/.halis/config.json · HALIS_API_KEY · HALIS_BASE_URL · HALIS_MODEL
  models   the whole models.dev catalog ships in — /model opens the picker
  tui      /help lists the slash commands once you are in
`

/** One json line per agent event, for scripts that want the stream. */
function jsonEventLine(event: Record<string, unknown>): void {
  console.log(JSON.stringify(event))
}

async function printMode(
  prompt: string,
  modelOverride: string | undefined,
  asJson: boolean,
  yolo: boolean,
): Promise<void> {
  if (prompt.length === 0) {
    console.error('nothing to ask — usage: halis -p "your prompt"')
    process.exitCode = 1
    return
  }
  const cfg = resolveConfig()
  if (cfg.demo && !modelOverride) {
    console.log(`(demo mode — no api key)\n\n${DEMO_REPLIES[0]}`)
    return
  }
  // A bare model id rides the configured endpoint, same as interactive mode;
  // only a real spec (provider/model, optional #variant) goes catalog hunting.
  const specCandidate =
    (modelOverride && (modelOverride.includes('/') || modelOverride.includes('#')) ? modelOverride : null) ??
    cfg.spec ??
    (cfg.model.includes('/') || cfg.model.includes('#') ? cfg.model : null)
  const system = await buildSystemPrompt({ cwd: process.cwd() })
  const messages: ChatMessage[] = [{ role: 'user', content: prompt }]
  const controller = new AbortController()
  const onSigint = () => controller.abort()
  process.on('SIGINT', onSigint)
  let sawText = false

  let provider: Parameters<typeof runAgent>[0]['provider']
  if (specCandidate) {
    const catalog = await loadCatalog()
    const target = resolveTarget(catalog, specCandidate)
    if ('error' in target) {
      console.error(`error: ${target.error}`)
      process.exitCode = 1
      return
    }
    if (target.unsupported) {
      console.error(`error: ${target.provider.name} needs signed or interactive authentication that is not supported yet`)
      process.exitCode = 1
      return
    }
    if (target.needsKey && !target.apiKey) {
      console.error(`error: ${target.provider.name} needs an api key — set ${target.provider.env.join(' or ') || 'HALIS_API_KEY'}`)
      process.exitCode = 1
      return
    }
    provider = {
      baseUrl: target.baseUrl,
      model: target.model.id,
      protocol: target.protocol,
      providerId: target.provider.id,
      maxTokens: target.model.limit.output,
      ...(target.apiKey ? { apiKey: target.apiKey } : {}),
      // The config's variant applies here too, not just the catalog's —
      // a configured "high" must not vanish the moment -p shows up.
      ...(() => {
        const variant = target.variant ?? variantFrom(target.model, cfg.variant)
        return variant && Object.keys(variant).length > 0 ? { variant } : {}
      })(),
      ...(target.model.modeHeaders ? { extraHeaders: { ...target.model.modeHeaders } } : {}),
      ...(target.model.modeBody ? { extraBody: { ...target.model.modeBody } } : {}),
    }
  } else {
    provider = {
      baseUrl: cfg.baseUrl,
      model: modelOverride ?? cfg.model,
      ...(cfg.apiKey ? { apiKey: cfg.apiKey } : {}),
    }
  }

  const emit = (event: Record<string, unknown>): void => {
    if (asJson) jsonEventLine(event)
  }

  await runAgent({
    system,
    messages,
    tools: defaultTools(),
    maxTurns: cfg.maxTurns,
    signal: controller.signal,
    cwd: process.cwd(),
    provider,
    readFiles: new Set<string>(),
    compactAt: cfg.compactAt,
    // Print mode has no user on the line to ask, so it runs in the same
    // stance as auto mode: ordinary commands go, flagged ones are declined
    // with the reason. --yolo is the documented way to lift even that.
    approve: async (call) => {
      if (call.name !== 'bash') return true
      if (yolo) return true
      const command = typeof call.input.command === 'string' ? call.input.command : ''
      if (command.length === 0) return true
      const risky = assessCommand(command)
      if (!risky) return true
      const note = denialText(risky)
      if (!asJson) {
        process.stdout.write(`✗ blocked: ${command.replace(/\s+/g, ' ').slice(0, 80)} — ${risky}\n`)
      }
      emit({ type: 'notice', text: note })
      return false
    },
    onEvent: (ev) => {
      if (ev.type === 'text-delta') {
        sawText = true
        if (asJson) emit({ type: 'text', text: ev.text })
        else process.stdout.write(ev.text)
      } else if (ev.type === 'tool-start') {
        if (sawText && !asJson) {
          process.stdout.write('\n')
          sawText = false
        }
        const args = Object.values(ev.call.input)[0]
        const brief = typeof args === 'string' ? args.replace(/\s+/g, ' ').slice(0, 72) : ''
        if (!asJson) process.stdout.write(`⏺ ${ev.call.name}(${brief})\n`)
        emit({ type: 'tool-start', name: ev.call.name, input: ev.call.input })
      } else if (ev.type === 'tool-end') {
        const first = ev.result.output.split('\n')[0] ?? ''
        if (!asJson) process.stdout.write(`  ${ev.result.ok ? '' : '✗ '}${first.slice(0, 120)}\n`)
        emit({ type: 'tool-end', name: ev.call.name, ok: ev.result.ok, output: ev.result.output })
      } else if (ev.type === 'usage') {
        emit({ type: 'usage', input: ev.input, output: ev.output })
      } else if (ev.type === 'notice') {
        emit({ type: 'notice', text: ev.text })
      } else if (ev.type === 'error') {
        if (sawText && !asJson) {
          process.stdout.write('\n')
          sawText = false
        }
        if (!asJson) process.stdout.write(`✗ ${ev.message}\n`)
        emit({ type: 'error', message: ev.message })
        // Scripts and CI pipe halis -p; a provider failure must not look
        // like success to whatever reads the exit code.
        process.exitCode = 1
      } else if (ev.type === 'done') {
        emit({ type: 'done', reason: ev.reason })
      }
    },
  })
  process.off('SIGINT', onSigint)
}

async function listStoredSessions(): Promise<void> {
  const entries = await listSessions()
  if (entries.length === 0) {
    console.log('no sessions stored yet')
    return
  }
  const home = process.env.HOME ?? process.env.USERPROFILE ?? ''
  for (const entry of entries.slice(0, 25)) {
    console.log(`${entry.saved.slice(0, 16).replace('T', ' ')}  ${entry.title.slice(0, 46).padEnd(46)}  ${entry.cwd.replace(home, '~')}  ${entry.model}`)
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(HELP)
    return
  }
  if (argv.includes('--version') || argv.includes('-v')) {
    console.log(VERSION)
    return
  }
  if (argv[0] === 'mascot') {
    console.log(renderAnsi(MASCOT_FULL))
    console.log('\n  Pixel — the Halis penguin\n')
    return
  }
  if (argv[0] === 'sessions') {
    await listStoredSessions()
    return
  }

  let print = false
  let cont = false
  let asJson = false
  let yolo = false
  let modelOverride: string | undefined
  const words: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === undefined) break
    if (arg === '-p' || arg === '--print') print = true
    else if (arg === '-c' || arg === '--continue') cont = true
    else if (arg === '--json') asJson = true
    else if (arg === '--yolo') yolo = true
    else if (arg === '--auto' || arg === '--dangerously-skip-permissions') yolo = true
    else if (arg === '-m' || arg === '--model') {
      // The next token is only the value when it exists and is not itself a
      // flag — `-p -m --json "…"` used to eat --json as the model name.
      const next = argv[i + 1]
      if (next === undefined || next.startsWith('-')) {
        console.error('error: -m needs a model, e.g. -m anthropic/claude-sonnet-4-5')
        process.exitCode = 1
        return
      }
      i++
      modelOverride = next
    } else words.push(arg)
  }
  const prompt = words.join(' ').trim()

  if (print) {
    await printMode(prompt, modelOverride, asJson, yolo)
    return
  }
  if (!process.stdout.isTTY || !process.stdin.isTTY) {
    console.error('halis needs a terminal for the interactive ui — try: halis -p "your prompt"')
    process.exitCode = 1
    return
  }
  if (yolo) process.env.HALIS_PERMISSIONS = 'yolo'
  const session = cont ? await loadLatestSession(process.cwd()) : null
  render(
    <App
      initialPrompt={prompt.length > 0 ? prompt : undefined}
      modelOverride={modelOverride}
      initialSession={session ?? undefined}
      continueRequested={cont}
    />,
    { exitOnCtrlC: false },
  )
}

void main()
