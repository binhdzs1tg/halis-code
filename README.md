# halis-code

Halis Code — a desktop coding agent, built with Electron and TypeScript.

> Current status: the agent chats with real models. Tools and editing arrive next.

## What works today

- Borderless desktop window with custom titlebar (Windows/Linux traffic lights handled, macOS native)
- Activity bar, sidebar with a live file explorer (open folder, lazy tree), status bar
- Editor area: open files in a read-only viewer with line numbers
- Streaming agent chat backed by real models, with markdown rendering, copy actions and a stop button
- Provider layer: Anthropic Messages plus any OpenAI-compatible endpoint, reasoning variants (effort / thinking / budget) included
- API key vault: per-provider keys encrypted with safeStorage, falling back to the provider's env vars
- Model picker with fuzzy search, favorites and recents on top of the models.dev catalog
- Terminal panel placeholder, keyboard shortcuts (`Ctrl+\``, `Ctrl+B`, `Ctrl+J`)
- Secure IPC bridge (context isolation + sandbox on), typed end to end

## What comes next

- [x] Model provider layer (pluggable providers, API key vault)
- [x] Streaming chat backed by a real model
- [ ] Agent harness (workspace tools, permissions, run loop)
- [ ] Code editor integration (Monaco)
- [ ] Terminal integration

## Stack

- Electron 44
- TypeScript 7.0.2 (native compiler)
- esbuild, no runtime dependencies

## Getting started

```bash
npm install
npm run dev
```

Other scripts:

```bash
npm run typecheck   # tsc over main + renderer configs
npm run build       # bundle main, preload, renderer -> dist/
npm run watch       # esbuild watch mode
```

## Layout

```
electron/
  main/       app entry, window, ipc handlers, workspace fs
  main/agent/ provider adapters + streaming run loop
  main/keys/  provider api key vault
  preload/    context bridge (window.halis)
  shared/     ipc channels, api contract, shared types
src/
  app/        store, dom helpers, icons
  components/ titlebar, sidebar, editor, chat, terminal, statusbar
  core/       agent gateway, key statuses, markdown, config services
scripts/      esbuild build/watch
```
