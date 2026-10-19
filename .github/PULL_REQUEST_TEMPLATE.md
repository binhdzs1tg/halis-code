## What changed

<!-- one paragraph, the "what" only — the "why" goes below -->

## Why

<!-- the problem this solves, or the behavior it fixes -->

## Checklist

- [ ] the smoke suite for the touched side passes (`npm run smoke -w @halis/core` / `-w @halis/desktop`)
- [ ] no hardcoded shell, signal or path assumptions crept in
- [ ] `packages/core` stayed free of Electron, Ink and React imports
- [ ] new or changed tool results stay within the output budget
- [ ] user-facing changes are reflected in the docs or the readme
