/**
 * Smoke tests for the core agent loop; run with `npm run smoke -w @halis/core`.
 * Everything talks to throwaway localhost http servers — no network, no keys.
 */
import assert from 'node:assert/strict'
import http from 'node:http'
import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import { RepeatGuard } from '../src/guard.js'
import { safeCut } from '../src/compact.js'
import { streamChat } from '../src/provider.js'
import { runAgent, defaultTools } from '../src/index.js'
import { htmlToText, webFetchTool } from '../src/tools/web-fetch.js'
import { todoTool } from '../src/tools/todo.js'
import type { ChatMessage, ToolCall } from '../src/types.js'

let passed = 0
const failures: string[] = []

async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn()
    passed++
    console.log(`  ok ${name}`)
  } catch (err) {
    failures.push(name)
    console.error(`  FAIL ${name}\n${err instanceof Error ? err.stack : err}`)
  }
}

/** A scripted OpenAI-style endpoint. The handler sees each parsed request body. */
interface ScriptedReply {
  status?: number
  chunks: Array<Record<string, unknown>>
}

async function makeServer(handler: (body: Record<string, unknown>, n: number) => ScriptedReply): Promise<{
  url: string
  close: () => Promise<void>
  requests: Array<Record<string, unknown>>
}>
{
  const requests: Array<Record<string, unknown>> = []
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (chunk: Buffer) => (body += chunk.toString()))
    req.on('end', () => {
      let parsed: Record<string, unknown> = {}
      try {
        parsed = JSON.parse(body) as Record<string, unknown>
      } catch {
        /* ignore */
      }
      requests.push(parsed)
      const reply = handler(parsed, requests.length)
      res.writeHead(reply.status ?? 200, { 'content-type': 'text/event-stream' })
      for (const chunk of reply.chunks) {
        res.write(`data: ${JSON.stringify(chunk)}\n\n`)
      }
      res.write('data: [DONE]\n\n')
      res.end()
    })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}/v1`,
    requests,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  }
}

function textChunk(text: string): Record<string, unknown> {
  return { choices: [{ delta: { content: text } }] }
}

function callChunk(index: number, id: string | undefined, name: string | undefined, args: string): Record<string, unknown> {
  return { choices: [{ delta: { tool_calls: [{ index, id, function: { name, arguments: args } }] } }] }
}

const NO_SIGNAL = new AbortController().signal

async function main(): Promise<void> {
  console.log('core smoke:')

  await test('repeat guard stays quiet, then nudges at three identical calls', () => {
    const guard = new RepeatGuard()
    assert.equal(guard.record('grep', { pattern: 'x' }), null)
    assert.equal(guard.record('grep', { pattern: 'x' }), null)
    const first = guard.record('grep', { pattern: 'x' })
    assert.ok(first?.includes('repeating the exact same tool call'))
    assert.equal(guard.record('grep', { pattern: 'x' }), null, 'each level reminds once')
    const second = guard.record('grep', { pattern: 'x' })
    assert.ok(second?.includes('5 times in a row'))
    const other = guard.record('grep', { pattern: 'different' })
    assert.equal(other, null, 'new arguments start a fresh chain')
  })

  await test('repeat guard treats reordered keys as the same call', () => {
    const guard = new RepeatGuard()
    guard.record('ls', { path: 'src', all: true })
    guard.record('ls', { all: true, path: 'src' })
    const nudge = guard.record('ls', { all: true, path: 'src' })
    assert.ok(nudge?.includes('repeating'))
  })

  await test('safeCut never strands a tool result or unanswered calls', () => {
    const calls: ToolCall[] = [{ id: 'a', name: 'ls', input: {} }]
    const messages: ChatMessage[] = [
      { role: 'user', content: 'go' },
      { role: 'assistant', content: '', toolCalls: calls },
      { role: 'tool', toolCallId: 'a', content: 'files' },
      { role: 'assistant', content: 'did it' },
      { role: 'user', content: 'more' },
      { role: 'assistant', content: '', toolCalls: calls },
      { role: 'tool', toolCallId: 'a', content: 'files 2' },
      { role: 'assistant', content: 'done' },
    ]
    const cut = safeCut(messages, 4)
    const tail = messages.slice(cut)
    assert.notEqual(tail[0]?.role, 'tool')
    assert.ok(cut > 0 && cut < messages.length)
    const before = messages[cut - 1]
    assert.ok(!(before?.role === 'assistant' && before.toolCalls && before.toolCalls.length > 0))
  })

  await test('streamChat reassembles text, split tool args and usage', async () => {
    const server = await makeServer(() => ({
      chunks: [
        { choices: [{ delta: { role: 'assistant' } }] },
        textChunk('Hello '),
        textChunk('world'),
        callChunk(0, 'call_1', 'read', '{"file_'),
        callChunk(0, undefined, undefined, 'path":"a.ts"}'),
        { choices: [], usage: { prompt_tokens: 41, completion_tokens: 7 } },
      ],
    }))
    try {
      const res = await streamChat({
        baseUrl: server.url,
        model: 'test-model',
        system: 's',
        messages: [{ role: 'user', content: 'hi' }],
        signal: NO_SIGNAL,
        wantUsage: true,
      })
      assert.equal(res.text, 'Hello world')
      assert.equal(res.toolCalls.length, 1)
      assert.deepEqual(res.toolCalls[0]?.input, { file_path: 'a.ts' })
      assert.equal(res.toolCalls[0]?.name, 'read')
      assert.deepEqual(res.usage, { input: 41, output: 7 })
    } finally {
      await server.close()
    }
  })

  await test('streamChat drops stream_options after a 400 and succeeds', async () => {
    let sawOptions = 0
    const server = await makeServer((body) => {
      if (body.stream_options !== undefined) {
        sawOptions++
        return { status: 400, chunks: [] }
      }
      return { chunks: [textChunk('ok')] }
    })
    try {
      const res = await streamChat({
        baseUrl: server.url,
        model: 'test-model',
        system: 's',
        messages: [{ role: 'user', content: 'hi' }],
        signal: NO_SIGNAL,
        wantUsage: true,
      })
      assert.equal(res.text, 'ok')
      assert.equal(sawOptions, 1, 'the 400 must strip stream_options before the next attempt')
    } finally {
      await server.close()
    }
  })

  await test('runAgent runs the loop: tools, results, usage, done', async () => {
    const server = await makeServer((body) => {
      const messages = body.messages as ChatMessage[]
      const last = messages[messages.length - 1]
      if (last?.role === 'user') {
        return {
          chunks: [
            textChunk('checking the layout'),
            callChunk(0, 'call_a', 'ls', '{}'),
            { choices: [], usage: { prompt_tokens: 30, completion_tokens: 9 } },
          ],
        }
      }
      return { chunks: [textChunk('the repo has one package.json'), { choices: [], usage: { prompt_tokens: 60, completion_tokens: 12 } }] }
    })
    const events: string[] = []
    const messages: ChatMessage[] = [{ role: 'user', content: 'what is in here?' }]
    try {
      await runAgent({
        system: 'test system',
        messages,
        tools: defaultTools(),
        maxTurns: 5,
        signal: NO_SIGNAL,
        cwd: process.cwd(),
        readFiles: new Set<string>(),
        compactAt: 0,
        provider: { baseUrl: server.url, model: 'test-model' },
        onEvent: (ev) => events.push(ev.type),
      })
      assert.equal(events.filter((e) => e === 'usage').length, 2)
      assert.equal(messages.length, 4, 'user, assistant with call, tool result, final assistant')
      assert.equal(messages[1]?.toolCalls?.length, 1)
      assert.equal(messages[2]?.role, 'tool')
      assert.ok(messages[3]?.content.includes('package.json'))
    } finally {
      await server.close()
    }
  })

  await test('runAgent feeds declined calls back and the guard nudges at three', async () => {
    const server = await makeServer(() => ({
      chunks: [callChunk(0, 'call_x', 'ls', '{}')],
    }))
    let reminderSeen = ''
    try {
      await runAgent({
        system: 's',
        messages: [{ role: 'user', content: 'loop me' }],
        tools: defaultTools(),
        maxTurns: 3,
        signal: NO_SIGNAL,
        cwd: process.cwd(),
        readFiles: new Set<string>(),
        compactAt: 0,
        provider: { baseUrl: server.url, model: 'test-model' },
        approve: () => Promise.resolve(false),
        onEvent: (ev) => {
          if (ev.type === 'tool-end' && ev.result.output.includes('repeating the exact same tool call')) {
            reminderSeen = ev.result.output
          }
        },
      })
      assert.ok(reminderSeen, 'the third identical declined call must carry the guard reminder')
    } finally {
      await server.close()
    }
  })

  await test('runAgent compacts a transcript that crosses the budget', async () => {
    const filler = 'x'.repeat(12000) // ~3000 estimated tokens
    const server = await makeServer((body) => {
      const specs = body.tools as Array<unknown> | undefined
      const messages = body.messages as ChatMessage[]
      if (!specs || specs.length === 0) {
        const transcript = messages.filter((m) => m.role !== 'system')
        assert.equal(transcript.length, 1, 'the summary request carries only the transcript')
        return {
          chunks: [textChunk('Task: pad the context. State: nothing done yet.'), { choices: [], usage: { prompt_tokens: 900, completion_tokens: 20 } }],
        }
      }
      return { chunks: [textChunk('all done'), { choices: [], usage: { prompt_tokens: 120, completion_tokens: 4 } }] }
    })
    const notices: string[] = []
    const messages: ChatMessage[] = [
      { role: 'user', content: filler },
      { role: 'assistant', content: 'ok, go ahead' },
    ]
    try {
      await runAgent({
        system: 's',
        messages,
        tools: defaultTools(),
        maxTurns: 4,
        signal: NO_SIGNAL,
        cwd: process.cwd(),
        readFiles: new Set<string>(),
        compactAt: 800,
        provider: { baseUrl: server.url, model: 'test-model' },
        onEvent: (ev) => {
          if (ev.type === 'notice') notices.push(ev.text)
        },
      })
      assert.ok(messages[0]?.content.includes('<session-summary>'), 'the prefix must be replaced by the summary')
      assert.equal(messages[0]?.role, 'user')
      assert.equal(messages[messages.length - 1]?.content, 'all done')
      assert.ok(notices.some((n) => n.startsWith('compacted ')))
    } finally {
      await server.close()
    }
  })

  await test('todo_write validates rows and reaches the host', async () => {
    let received: Array<{ text: string; status: string }> | null = null
    const ctx = (items: Array<{ text: string; status: string }>) => {
      received = items
    }
    const good = await todoTool.run(
      {
        todos: [
          { text: 'read the config', status: 'done' },
          { text: 'rewrite the loop', status: 'in_progress' },
          { text: 'run smoke', status: 'pending' },
        ],
      },
      { cwd: process.cwd(), signal: NO_SIGNAL, readFiles: new Set<string>(), setTodos: ctx },
    )
    assert.equal(good.ok, true)
    assert.ok(good.output.includes('[~] rewrite the loop'))
    assert.equal(received?.length, 3)
    assert.equal(received?.[1]?.status, 'in_progress')
    const bad = await todoTool.run(
      { todos: [{ text: 'x', status: 'whenever' }] },
      { cwd: process.cwd(), signal: NO_SIGNAL, readFiles: new Set<string>() },
    )
    assert.equal(bad.ok, false)
  })

  await test('web_fetch refuses private addresses and converts html', async () => {
    const loopback = await webFetchTool.run(
      { url: 'http://127.0.0.1:9999/secret' },
      { cwd: process.cwd(), signal: NO_SIGNAL, readFiles: new Set<string>() },
    )
    assert.equal(loopback.ok, false)
    assert.ok(loopback.output.includes('private address'))

    const html = [
      '<html><head><title>Page</title><style>body{}</style></head>',
      '<body><!-- hi --><h1>Title</h1><p>First &amp; second</p><script>evil()</script>',
      '<ul><li>one</li><li>two</li></ul></body></html>',
    ].join('\n')
    const text = htmlToText(html)
    assert.ok(text.startsWith('Page'))
    assert.ok(text.includes('First & second'))
    assert.ok(text.includes('one'))
    assert.ok(!text.includes('evil()'))
    assert.ok(!text.includes('<p>'))

    const entities = htmlToText('a &lt; b &copy; &#65;&#x42;')
    assert.equal(entities, 'a < b © AB')
  })

  console.log(failures.length === 0 ? `\nall ${passed} tests passed` : `\n${failures.length} failed, ${passed} passed`)
  if (failures.length > 0) process.exitCode = 1
}

void main()
