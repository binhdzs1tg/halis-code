# AGENTS.md

Instructions for coding agents (and humans) working on Halis Code.

## Layout

Monorepo, npm workspaces:

- `apps/desktop` — Electron desktop app. Agent runtime lives in
  `electron/main/agent/`, renderer in `src/`.
- `packages/core` — agent loop, file tools, provider client (`@halis/core`).
  Pure Node, no Electron imports.
- `packages/cli` — terminal UI (`@halis/cli`, bin `halis`), built with Ink
  and bundled by esbuild into `bin/halis.js`. Consumes `@halis/core`
  directly from source through tsconfig paths and an esbuild alias.

## Commands

From the repo root:

- `npm run typecheck` — strict typecheck of every workspace (TypeScript 7).
- `npm run build` — core, then cli, then desktop, in that order.
- `npm run dev:cli` — watch mode for the terminal ui.
- `npm run dev:desktop` — build and launch the desktop app.
- `npm run smoke -w @halis/desktop` — algorithm smoke tests (diff, guard,
  file refs, risk heuristics, glob matching, grep, html conversion, patch
  parsing, edit matching, tool input repair, spill, the read-before-edit
  gate, git info, background jobs, subagents, the mcp client). Run it after
  touching anything under `apps/desktop/electron/main/agent/`.

## Conventions

- TypeScript everywhere, strict, `noUnusedLocals`/`noUnusedParameters` on.
  Do not loosen the compiler options.
- The desktop main process never trusts the renderer: every `ipcMain`
  handler validates its inputs and only the main frame of an app window may
  call. Keep that discipline for new channels.
- Electron imports stay out of `electron/shared/` so the renderer can type
  against it. Pure logic (diff, guard, risk patterns) stays free of
  Electron imports so the smoke tests can run it in plain Node.
- `packages/core` stays free of Electron, Ink and React imports — the
  terminal ui owns presentation, the core owns the loop.
- Tool results are fed back into the model — keep them within the output
  budget and write messages that tell the model what to do next, not just
  what failed.
- Comments explain why, not what. Names of runtime-injected context blocks
  follow the `<system-reminder>` convention.
- The penguin is drawn from `packages/cli/src/mascot-art.ts`; keep the
  palette keys stable when regenerating the grids.
