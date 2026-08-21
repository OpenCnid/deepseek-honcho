# Implementation and verification status

This file records concrete local evidence against `SPEC.md`. It is not a replacement for the normative specification.

## Milestones

| Milestone                | State                                      | Evidence                                                                                                                                                                    |
| ------------------------ | ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0 — bootstrap/provenance | Implemented; Windows verified              | Pinned workspace/lockfile, CI matrix, safe env, corpus/schema; `install`, build, tests, provenance and secret checks pass locally                                           |
| 1 — MCP experiment       | Implemented                                | Hosted/self-hosted DSH MCP profiles use `@deepseek-ai/dsh-mcp-client` and `mcp__honcho__*`; 11/11 content-free deterministic cases pass                                     |
| 2 — service/fake         | Implemented                                | `ctx.honcho`, stable types/errors, host identity resolution, deterministic IDs, SDK-free fake and unit tests                                                                |
| 3 — SDK/outbox           | Implemented                                | Exact SDK v3 fake-HTTP test; restart, ambiguous success, partial delivery, concurrency/order, retry/circuit, shutdown, dead-letter and HMR fence tests                      |
| 4 — capture              | Implemented                                | Real pinned DSH AgentLoop tests prove one normalized root exchange, multi-turn/session correlation, child/error/injected exclusion, and asynchronous fail-open behavior     |
| 5 — recall               | Implemented                                | Real pinned DSH test proves first-step plugin provenance, untrusted formatting, no recapture, child exclusion, and outage completion                                        |
| 6 — tools/RLM            | Implemented                                | Exactly-five schema/admin-absence tests; DSH policy/result telemetry test for the nested `dsh_tools.call` shape; empty kernel environment assertion and RLM config example  |
| 7 — release hardening    | Implemented locally; external gates remain | Named-export bundle, native examples, five inspected tarballs, isolated install/import, security/operator docs, opt-in live fixture, Windows/Ubuntu CI and opt-in macOS job |

## Definition of Done audit

Locally proven: exact provenance/license notices; isolated native bundle install/import; default-off capture/recall; restart/deduplication; deterministic identity/project/peer/correction/freshness corpus; no destructive model tools; DSH-only RLM tool dispatch contract; local format/lint/typecheck/unit/integration/e2e-skip/package/provenance/secret verification; egress/outbox/retention/non-sandbox documentation; Apache-2.0 selection; and an evidence-based README.

External evidence still required before a release claim:

- run the configured Ubuntu CI job (and macOS release-intent job before first release);
- run the opt-in hosted or self-hosted corpus/smoke with isolated synthetic identities;
- compare real Honcho recall against memory-disabled behavior and record actual p95 latency/token/cost without conversation content; and
- obtain operator approval for retention, export, deletion, and cleanup procedures.

Accordingly, `evaluation-results/latest.json` keeps `promotionClaimed: false` and this repository does not call the experiment production-ready.

## Compatibility result

No DSH patch was needed. At DeepSeek Harness `99f6f02fecdb7dff40c3fbc9470f5907c29f74ca`, the public Cordis Service API, committed `session/event`, durable root/child session header, `agent/pre-step` waterfall, plugin message provenance, MCP client, and ToolRuntime policy/telemetry seams were sufficient.
