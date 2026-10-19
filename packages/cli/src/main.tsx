import { render } from 'ink'
import { runAgent, buildSystemPrompt, defaultTools, resolveConfig, type ChatMessage } from '@halis/core'
import { App } from './app.js'
import { DEMO_REPLIES } from './demo.js'
import { MASCOT_FULL, renderAnsi } from './mascot-art.js'

const VERSION = '0.1.0'

const HELP = `  Halis Code ${VERSION} — the blue penguin for your terminal

  usage
    halis                    interactive session
    halis "prompt"           start with a first prompt
    halis -p "prompt"        answer once and print it
    halis mascot             show the penguin
    halis --model <id>       model for this session

  config   ~/.halis/config.json · HALIS_API_KEY · HALIS_BASE_URL · HALIS_MODEL
  tui      /help lists the slash commands once you are in
`

async function printMode(prompt: string, modelOverride?: string | undefined): Promise<void> {
  if (prompt.length === 0) {
    console.error('nothing to ask — usage: halis -p "your prompt"')
    process.exitCode = 1
    return
  }
  const cfg = resolveConfig()
  const model = modelOverride ?? cfg.model
  if (cfg.demo) {
    console.log(`(demo mode — no api key)\n\n${DEMO_REPLIES[0]}`)
    return
  }
  const system = await buildSystemPrompt({ cwd: process.cwd() })
  const messages: ChatMessage[] = [{ role: 'user', content: prompt }]
  const controller = new AbortController()
  const onSigint = () => controller.abort()
  process.on('SIGINT', onSigint)
  let sawText = false

  await runAgent({
    system,
    messages,
    tools: defaultTools(),
    maxTurns: cfg.maxTurns,
    signal: controller.signal,
    cwd: process.cwd(),
    provider: {
      baseUrl: cfg.baseUrl,
      model,
      ...(cfg.apiKey ? { apiKey: cfg.apiKey } : {}),
    },
    readFiles: new Set<string>(),
    onEvent: (ev) => {
      if (ev.type === 'text-delta') {
        sawText = true
        process.stdout.write(ev.text)
      } else if (ev.type === 'tool-start') {
        if (sawText) {
          process.stdout.write('\n')
          sawText = false
        }
        const args = Object.values(ev.call.input)[0]
        const brief = typeof args === 'string' ? args.replace(/\s+/g, ' ').slice(0, 72) : ''
        process.stdout.write(`⏺ ${ev.call.name}(${brief})\n`)
      } else if (ev.type === 'tool-end') {
        const first = ev.result.output.split('\n')[0] ?? ''
        process.stdout.write(`  ${ev.result.ok ? '' : '✗ '}${first.slice(0, 120)}\n`)
      } else if (ev.type === 'error') {
        if (sawText) {
          process.stdout.write('\n')
          sawText = false
        }
        process.stdout.write(`✗ ${ev.message}\n`)
      } else if (ev.type === 'done' && sawText) {
        process.stdout.write('\n')
      }
    },
  })
  process.off('SIGINT', onSigint)
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

  let print = false
  let modelOverride: string | undefined
  const words: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === undefined) break
    if (arg === '-p' || arg === '--print') print = true
    else if (arg === '--model') {
      i++
      modelOverride = argv[i]
    } else words.push(arg)
  }
  const prompt = words.join(' ').trim()

  if (print) {
    await printMode(prompt, modelOverride)
    return
  }
  if (!process.stdout.isTTY || !process.stdin.isTTY) {
    console.error('halis needs a terminal for the interactive ui — try: halis -p "your prompt"')
    process.exitCode = 1
    return
  }
  render(<App initialPrompt={prompt.length > 0 ? prompt : undefined} modelOverride={modelOverride} />, {
    exitOnCtrlC: false,
  })
}

void main()
