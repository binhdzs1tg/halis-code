# Security Policy

## Reporting a vulnerability

Do not open a public issue for anything security-sensitive. Use GitHub's
private vulnerability reporting on this repository (Report a vulnerability
under the Security tab), which reaches the maintainer directly and keeps
the report private until a fix ships.

Please include what you can of: the affected surface, a minimal
reproduction, the platform you tested on, and the impact you see. A
one-line proof-of-concept beats a long essay.

You can expect an acknowledgement within 72 hours. Fixes are prioritized
by real-world impact — anything that lets a model-issued command escape
the approval flow or reach a private address from `web_fetch` jumps the
queue. We ask for reasonable disclosure patience in both directions: no
hard deadline on you, and in exchange, credit in the release notes when
the fix lands, if you want it.

## Supported versions

| version | status | notes |
| ------- | ------ | ----- |
| 0.2.x | supported | `main` — the terminal cli and the desktop app |
| < 0.2.0 | unsupported | upgrade; early builds predate this policy |

## Scope

In scope:

- The agent runtime: tool execution, command approvals, the risky-command
  heuristics, the repeat-call guard, background job handling.
- `web_fetch` and its private-address refusal (loopback, link-local,
  RFC 1918, and friends).
- Provider key storage in the desktop app (safeStorage-backed file) and
  environment handling in the terminal cli.
- The IPC boundary between the Electron main process and the renderer.
- The session and spill stores under `~/.halis`.

Out of scope:

- Provider-side outages or billing surprises — those belong to your
  provider.
- What a model *says*. The guardrails exist to keep the human in charge of
  what a model *does*; they cannot make the model wise.
- Social engineering of the human operator. If a command asks you to
  `sudo rm -rf /` and you approve it, the approval dialog did its job.
- Denial of service through pathologically large repositories.

For the design notes behind the guardrails — why approvals label
themselves, why the fetch tool refuses half the address space, why the
renderer never gets to call IPC directly — see
[docs/security.md](docs/security.md).
