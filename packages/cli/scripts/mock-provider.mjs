#!/usr/bin/env node
/**
 * A tiny OpenAI-compatible mock provider for working on the halis tui with
 * no api key and no network. It streams a scripted session: the agent looks
 * at the repo layout, reads package.json, writes a plan, then answers —
 * exactly the shapes the real provider sends, usage chunk included.
 *
 *   npm run mock -w @halis/cli
 *   HALIS_BASE_URL=http://localhost:8787/v1 HALIS_API_KEY=mock halis
 */
import http from 'node:http'

const PORT = Number(process.env.HALIS_MOCK_PORT ?? 8787)
const CHAR_DELAY = 45

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function wireText(body) {
  const last = body.messages?.[body.messages.length - 1]
  const rounds = body.messages?.filter((m) => m.role === 'tool').length ?? 0
  return { last, rounds }
}

/** The scripted session, one act per round of tool results. */
function act(rounds) {
  switch (rounds) {
    case 0:
      return {
        text: 'Let me scan the repo layout first.',
        calls: [{ id: 'mock_ls', name: 'ls', input: {} }],
      }
    case 1:
      return {
        text: 'Root looks tidy. Checking what the workspace declares.',
        calls: [{ id: 'mock_read', name: 'read', input: { file_path: 'package.json', limit: 14 } }],
      }
    case 2:
      return {
        text: 'One more look at the cli entry, then I will wrap up.',
        calls: [
          {
            id: 'mock_todo',
            name: 'todo_write',
            input: {
              todos: [
                { text: 'scan the repo layout', status: 'done' },
                { text: 'read package.json', status: 'done' },
                { text: 'summarize the project', status: 'in_progress' },
              ],
            },
          },
        ],
      }
    default:
      return {
        text: [
          '## What this repo is',
          '',
          '**Halis Code** is a coding agent with two faces: an Electron desktop app and this terminal ui, both driven by the same agent loop in `@halis/core`.',
          '',
          '- `packages/core` owns the loop: streaming provider client, file tools, guardrails',
          '- `packages/cli` renders it with ink — composer, command palette, tool cards',
          '- `apps/desktop` wraps the same ideas in a full editor',
          '',
          '```sh',
          'npm run build -w @halis/cli',
          'node packages/cli/bin/halis.js',
          '```',
          '',
          'That is the whole tour — ask me to dig into any piece of it.',
        ].join('\n'),
        calls: [],
      }
  }
}

function chunkify(reply, promptChars) {
  const chunks = []
  chunks.push({ choices: [{ index: 0, delta: { role: 'assistant', content: '' } }] })
  const words = reply.text.split(/(?<= )/)
  for (const word of words) chunks.push({ choices: [{ index: 0, delta: { content: word } }] })
  for (const call of reply.calls) {
    const args = JSON.stringify(call.input)
    const cut = Math.max(1, Math.floor(args.length / 3))
    chunks.push({
      choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: call.id, type: 'function', function: { name: call.name, arguments: args.slice(0, cut) } }] } }],
    })
    chunks.push({
      choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: args.slice(cut) } }] } }],
    })
  }
  chunks.push({
    choices: [],
    usage: {
      prompt_tokens: Math.max(24, Math.round(promptChars / 4)),
      completion_tokens: Math.round((reply.text.length + reply.calls.length * 40) / 4),
    },
  })
  return chunks
}

const server = http.createServer((req, res) => {
  if (req.method === 'GET') {
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end('halis mock provider — point HALIS_BASE_URL here and start the tui\n')
    return
  }
  let raw = ''
  let clientGone = false
  // An Esc abort tears the connection down mid-stream; without this the
  // next res.write on the dead socket throws an uncaught 'error' and takes
  // the whole mock server with it.
  res.on('error', () => {
    clientGone = true
  })
  req.on('data', (c) => (raw += c))
  req.on('end', async () => {
    let body = {}
    try {
      body = JSON.parse(raw)
    } catch {
      /* whatever the tui sends, be forgiving */
    }
    const { last, rounds } = wireText(body)
    console.log(`mock: ${req.url} · last=${last?.role} · tool rounds=${rounds}`)
    const reply = act(rounds)
    const promptChars = (body.messages ?? []).reduce((n, m) => n + (m.content?.length ?? 0), 0)
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
    for (const payload of chunkify(reply, promptChars)) {
      if (clientGone) return
      res.write(`data: ${JSON.stringify(payload)}\n\n`)
      await sleep(CHAR_DELAY)
    }
    if (clientGone) return
    res.write('data: [DONE]\n\n')
    res.end()
  })
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`mock provider listening on http://localhost:${PORT}/v1`)
  console.log('start the tui against it:')
  console.log(`  HALIS_BASE_URL=http://localhost:${PORT}/v1 HALIS_API_KEY=mock halis`)
})
