# Implementation and verification status

This file records concrete local evidence against `SPEC.md`. It is not a replacement for the normative specification.

## Milestones

| Milestone                | State                                | Evidence                                                                                                                                                                                                     |
| ------------------------ | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 0 — bootstrap/provenance | Implemented; Windows verified        | Pinned workspace/lockfile, CI matrix, safe env, corpus/schema; `install`, build, tests, provenance and secret checks pass locally                                                                            |
| 1 — MCP experiment       | Implemented                          | Hosted/self-hosted DSH MCP profiles use `@deepseek-ai/dsh-mcp-client` and `mcp__honcho__*`; 12/12 content-free deterministic cases pass                                                                      |
| 2 — service/fake         | Implemented                          | `ctx.honcho`, stable types/errors, host identity resolution, deterministic IDs, SDK-free fake and unit tests                                                                                                 |
| 3 — SDK/outbox           | Implemented                          | Exact SDK v3 fake-HTTP test; restart, ambiguous success, partial delivery, concurrency/order, retry/circuit, shutdown, dead-letter and HMR fence tests                                                       |
| 4 — capture              | Implemented                          | Real pinned DSH AgentLoop tests prove one normalized root exchange, multi-turn/session correlation, child/error/injected exclusion, and asynchronous fail-open behavior                                      |
| 5 — recall               | Implemented                          | Real pinned DSH test proves first-step plugin provenance, untrusted formatting, no recapture, child exclusion, and outage completion                                                                         |
| 6 — tools/RLM            | Implemented                          | Exactly-five schema/admin-absence tests; DSH policy/result telemetry test for the nested `dsh_tools.call` shape; empty kernel environment assertion and RLM config example                                   |
| 7 — release hardening    | Implemented and hosted-live verified | Named-export bundle, native examples, five inspected tarballs, isolated install/import, security/operator docs, hosted evaluation/aggregate, verified fenced cleanup, Windows/Ubuntu CI and opt-in macOS job |

## Definition of Done audit

Locally proven: exact provenance/license notices; isolated native bundle install/import; default-off capture/recall; restart/deduplication; deterministic workspace/project/peer/correction/freshness corpus; no destructive model tools; DSH-only RLM tool dispatch contract; local format/lint/typecheck/unit/integration/e2e-skip/package/provenance/secret verification; egress/outbox/retention/non-sandbox documentation; Apache-2.0 selection; and an evidence-based README.

The 2026-08-21 hosted synthetic evaluation and cleanup are recorded in `docs/live-evaluation-2026-08-21.md`. The content-free aggregate proves every case observed passing, zero leakage, 100% protected-case coverage, normal completion and token bounds, clean timeout/fail-open behavior, improvement from a zero required-hit disabled baseline to a 100% best live attempt, operator-approved retention, and verified deletion. Its `promotionClaimed` value is therefore true.

One release operation remains before a first package release:

- run the opt-in macOS release-intent job before the first release;

Windows and Ubuntu CI passed on merged PR #3. The repository operator approved the hosted synthetic-evaluation policy, including Honcho's stated API-log and rolling encrypted-backup retention of up to 90 days. No release or publication has been attempted.

`evaluation-results/latest.json` keeps `promotionClaimed: false` because it is deterministic-local evidence only. The hosted multi-attempt aggregate is the sole artifact allowed to claim promotion after verified cleanup. Automatic recall remains opt-in; passing the evidence gate does not silently change configuration defaults.

## Compatibility result

No DSH patch was needed. At DeepSeek Harness `99f6f02fecdb7dff40c3fbc9470f5907c29f74ca`, the public Cordis Service API, committed `session/event`, durable root/child session header, `agent/pre-step` waterfall, plugin message provenance, MCP client, and ToolRuntime policy/telemetry seams were sufficient.
