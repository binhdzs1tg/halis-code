# Development

The working manual: what to run, when to run it, and how to extend the
parts that are worth extending. [CONTRIBUTING.md](../CONTRIBUTING.md)
covers the social side; this one covers the machine side.

## Prerequisites

Node 20 or newer — 22 LTS is what the ci matrix runs — and npm 11. A
TypeScript 7 toolchain comes with the install (pinned to 7.0.2 across
the workspaces; moving it is a decision, not a `npm update`). If you
only touch the terminal side, `ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm
install` skips the electron binary download.

## Everyday commands

From the repo root:

| command | what it does |
| ------- | ------------ |
| `npm run typecheck` | strict typecheck of every workspace |
| `npm run build` | core, then cli, then desktop, in that order |
| `npm run dev:cli` | watch mode for the terminal ui |
| `npm run dev:desktop` | build + launch the desktop app |
| `npm run cli` | run the tui from the checkout, no global install |
| `npm run lint:md` | markdownlint over every md file |
| `npm run smoke -w @halis/core` | the terminal-side loop, scripted provider |
| `npm run smoke -w @halis/desktop` | the desktop algorithms, plain node |

The two smoke suites are the release gate. Run the one that matches the
side you touched, before you push — the ci matrix will run it again on
macOS, Linux and Windows.

## The smoke suites

No framework, no config, no ceremony. Each suite is a single TypeScript
entry (`packages/core/scripts/smoke.ts`, `apps/desktop/scripts/smoke.ts`)
that esbuild bundles to `dist/smoke.cjs` and runs in plain Node. A case
is an assertion and a name:

```ts
assert(canonicalize({ a: 1, b: 2 }) === '{"a":1,"b":2}', 'the guard sorts keys before comparing')
```

Failures print the case name; the run exits non-zero. The suites
deliberately run in plain Node — no Electron, no Ink, no terminal —
which is why pure logic lives in files free of those imports.

When you add a case, keep it cross-platform: no quotes in spawned
commands (they meet `cmd.exe` on the windows runners), or branch on
`process.platform`. The suites pin platforms with injected values, so
you can test the Windows path from Linux.

## Adding a tool (terminal side)

1. Create `packages/core/src/tools/<name>.ts` exporting a `Tool` —
   `spec` (the json schema the model sees) and `run(input, ctx)` (the
   outcome the loop feeds back).
2. Register it in `packages/core/src/tools/index.ts`.
3. Write result messages that tell the model what to do next, not just
   what failed; oversized output goes through the spill store.
4. Add a smoke case against the mock provider if the tool is reachable
   in that loop.

The desktop side registers tools in
`apps/desktop/electron/main/agent/tools.ts` (plus `glob.ts`, `grep.ts`,
`patch.ts`, `web-fetch.ts`, `web-search.ts` for the bigger ones); the
same shape applies.

## The mock provider

`npm run mock -w halis-code` starts an OpenAI-compatible server on
`:8787` that scripts a full agent turn — tool calls included, decided
by the prompt you give it. Point the cli at it:

```sh
HALIS_HOME=$(mktemp -d) HALIS_BASE_URL=http://127.0.0.1:8787/v1 HALIS_API_KEY=mock \
  node packages/cli/bin/halis.js
```

The same flow is the ci `cli bundle` job: build, run the bundle against
the mock, assert the event stream ends in a `done` event. If you change
the bundle, the catalog staging, or any tool import, that job is the
one that catches it.

## Environment variables

| variable | what it overrides |
| -------- | ----------------- |
| `HALIS_API_KEY` | provider key when you don't want the provider-specific variable |
| `HALIS_BASE_URL` | the endpoint — for self-hosted, proxies and the mock |
| `HALIS_MODEL` | the default model, same spec the picker takes (`provider/model#variant`) |
| `HALIS_CONFIG` | path to the config file (`~/.halis/config.json` by default) |
| `HALIS_HOME` | where `~/.halis` goes — tests and ci point it at a temp dir |
| `HALIS_SHELL` | force a shell (posix-style `bash.exe` gets `-c`, pwsh gets `-Command`, else cmd rules) |
| `HALIS_PERMISSIONS` | `default` (ask per bash call), `auto` (only risky ones), `yolo` (never ask) |
| `HALIS_SESSIONS` | session store directory |
| `HALIS_SPILL_DIR` | oversized-tool-output store |
| `HALIS_JOBS_DIR` | background job store |
| `HALIS_MODELS_SNAPSHOT` | catalog snapshot path (source runs read the repo assets) |
| `HALIS_MODELS_CACHE` | catalog revalidation cache |

The desktop app reads the same ones where it makes sense (the
`HALIS_DEV_URL` override points it at a dev renderer), and keeps
provider keys in its own vault instead of the environment.

## Conventions worth repeating

The full list lives in [AGENTS.md](../AGENTS.md); the four that cause
the most rework when ignored:

- **TypeScript strict stays strict.** `noUnusedLocals`,
  `noUnusedParameters`, `exactOptionalPropertyTypes` are on. Do not
  loosen the options — spread optional fields conditionally instead of
  assigning `undefined`.
- **No shell assumptions.** Spawn through `resolveShell()`, kill
  through `killTree()`. A bare `child.kill()` leaves grandchildren
  alive on every platform.
- **`packages/core` stays importable by plain Node.** No Electron, no
  Ink, no React. The terminal ui owns presentation; the core owns the
  loop.
- **Comments explain why, not what.** The commit that needed the
  comment is usually gone in a month; the reason it was needed is not.
