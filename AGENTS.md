# Repository instructions

This repository specifies and will implement Honcho memory for DeepSeek Harness. Read `README.md`, `GAMEPLAN.md`, and `SPEC.md` completely before changing production code. `SPEC.md` is normative; if implementation requires a different contract, update the spec and explain the decision instead of silently diverging.

## Architecture invariants

- DeepSeek Harness remains the sole agent runtime and control plane.
- Honcho is fallible cross-session context, never source-code truth, policy, or evidence-grade provenance.
- Use only public DSH lifecycle, tool, session, and plugin contracts. Do not guess APIs from names.
- Root-agent exchanges are the only default automatic capture source. System prompts, tool arguments/results, internal reasoning, injected memory, partial streams, and subagent chatter are excluded.
- Remote writes are asynchronous and go through a durable host-side outbox.
- Recall is bounded, first-step-only by default, source-labeled, untrusted, and fail-open.
- Keep API keys in host configuration. Never include them in events, logs, prompts, test fixtures, RLM kernel environments, or committed files.
- Do not expose Honcho destructive administration methods as ordinary model tools.
- Prefer the official `@honcho-ai/sdk` dependency. Do not copy AGPL server/MCP source without an explicit licensing decision and preserved notices.

## Pinned research baselines

- DSH: `99f6f02fecdb7dff40c3fbc9470f5907c29f74ca` (`dsh-v0.1.0-rc.7`)
- Honcho: `ddbb90e36f2d148c7982f6ed85b09d31cabf5944`
- Honcho TypeScript SDK observed at that revision: `2.3.0`

Before using an upstream checkout, read its own `AGENTS.md` and inspect the exact source contract at the pinned revision. Upgrades require refreshed provenance and compatibility tests.

## Implementation discipline

- Use a pnpm workspace, TypeScript strict mode, exact dependency versions, and reproducible lockfiles.
- Use `apply_patch` for manual file edits.
- Preserve unrelated user changes in a dirty worktree.
- Add focused unit tests and real DSH integration tests for lifecycle behavior.
- Test on Windows and Linux at minimum; the intended release matrix also includes macOS.
- Run formatting, lint, typecheck, unit, integration, package, and secret-scan checks before handoff.
- Never use real personal memory in automated tests. Use an isolated workspace, synthetic peers, and synthetic content.
- Do not commit, push, publish packages, or open/merge a PR unless the user explicitly asks for it.

## Documentation

Keep the README, configuration examples, security boundary, provenance pins, and package names synchronized with working behavior. Do not claim that the plugin is implemented or production-ready until the relevant acceptance criteria in `SPEC.md` pass.
