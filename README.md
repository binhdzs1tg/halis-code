# halis-code

Halis Code — a desktop coding agent, built with Electron and TypeScript.

> Current status: project skeleton. The app shell runs, but the agent itself is not wired up yet.

## What works today

- Borderless desktop window with custom titlebar (Windows/Linux traffic lights handled, macOS native)
- Activity bar, sidebar with a live file explorer (open folder, lazy tree), status bar
- Editor area: open files in a read-only viewer with line numbers
- Agent chat panel with local message flow and status indicator
- Terminal panel placeholder, keyboard shortcuts (`Ctrl+\``, `Ctrl+B`, `Ctrl+J`)
- Secure IPC bridge (context isolation + sandbox on), typed end to end

## What comes next

- [ ] Model provider layer (pluggable providers, API key vault)
- [ ] Agent harness (workspace tools, permissions, run loop)
- [ ] Streaming chat backed by a real model
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
  preload/    context bridge (window.halis)
  shared/     ipc channels, api contract, shared types
src/
  app/        store, dom helpers, icons
  components/ titlebar, sidebar, editor, chat, terminal, statusbar
  core/       agent + config services (stubs for now)
scripts/      esbuild build/watch
```
