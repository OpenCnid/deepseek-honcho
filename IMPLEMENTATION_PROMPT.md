# Prompt for a separate Codex implementation task

Copy everything below into a new Codex task whose workspace is the `deepseek-honcho` repository.

---
Implement the project defined by `SPEC.md` in this workspace. Treat `SPEC.md` as normative and produce working code, tests, examples, and packaging—not another architecture proposal.

Start by reading `AGENTS.md`, `README.md`, `GAMEPLAN.md`, and `SPEC.md` completely. Inspect the repository state and create a milestone-based plan tied directly to the acceptance criteria and Definition of Done in the spec. Preserve any existing user changes.

The central architectural rule is that DeepSeek Harness (DSH) remains the only agent runtime/control plane. Honcho is a fallible cross-session memory service. Git, current files, tests, CI, and DSH's session events remain authoritative. Do not create a second agent loop, move policy or model credentials into Honcho, or let recalled memory override current repository evidence.

Use these exact research baselines unless `SPEC.md` has been intentionally revised:

- DeepSeek Harness: `99f6f02fecdb7dff40c3fbc9470f5907c29f74ca` (`dsh-v0.1.0-rc.7`)
- Honcho: `ddbb90e36f2d148c7982f6ed85b09d31cabf5944`
- `@honcho-ai/sdk`: exact version `2.3.0` initially

Clone or inspect upstream repositories in temporary/read-only locations. Read any upstream `AGENTS.md` files and the exact types, tests, README contracts, package manifests, and licenses at the pinned revisions before coding. Do not infer DSH APIs from method or event names. Record provenance for every dependency and any adapted source.

Implement the spec milestones in order, beginning with Milestone 0 and then the MCP vertical experiment. Continue into the native service seam and implementation as far as the environment safely allows; do not stop after scaffolding while a safe next milestone remains.

Non-negotiable requirements:

- Keep the Service Definition, SDK Service Provider, lifecycle Consumer, tool Consumer, and bundle composable.
- Use the existing DSH MCP client for the Stage A experiment and adapt the Honcho memory skill to actual `mcp__honcho__*` tool names.
- Automatically capture only completed root-agent exchanges by default.
- Exclude system/developer prompts, injected context, tool arguments/results, hidden reasoning, partial streams, attachments, and child/subagent chatter.
- Redact and bound content before writing it to the durable local outbox.
- Never block a user-visible turn on a Honcho write.
- Implement the versioned atomic-file outbox, deterministic delivery IDs, retry/backoff, circuit breaker, metadata-filter duplicate defense, bounded shutdown drain, HMR fencing, and dead-letter behavior from the spec.
- Inject recall only at the first root-agent step by default, through the public DSH pre-step mechanism, with plugin provenance.
- Label recalled material as untrusted and subordinate it to current files, tests, explicit corrections, and DSH policy.
- Fail open on Honcho timeout, outage, auth failure after valid startup, or asynchronous processing lag.
- Keep workspace/human/project identity host-controlled. Model tools must not select arbitrary human peers.
- Expose only `memory_recall`, `memory_search`, `memory_record`, `memory_correct`, and `memory_status` in the default tool package.
- Do not expose destructive Honcho administration operations to the model.
- Keep Honcho credentials in the DSH host. Never pass them to model context, events, logs, fixtures, or a DeepSeek RLM kernel.
- Make RLM call memory only through the DSH tool bridge and prove the call remains governed/logged by DSH.
- Do not copy Honcho AGPL server/MCP source. Use the Apache-2.0 SDK dependency unless the user explicitly authorizes a reviewed license change.
- Add no DSH patch unless a failing compatibility test proves a normative public seam is missing. If that occurs, document it, propose the smallest generic upstream-ready seam, and update `SPEC.md` before implementing the patch.
- Use `apply_patch` for manual edits. Use exact dependency versions and reproducible lockfiles.
- Do not commit, push, publish packages, open a PR, use real personal memory, or perform destructive live-Honcho cleanup unless the user explicitly authorizes it.

For every milestone:

1. implement the smallest end-to-end behavior that proves the milestone;
2. add focused unit tests and the required real DSH integration tests;
3. run formatting, lint, typecheck, unit, integration, package, provenance, and secret checks relevant to the work;
4. fix failures before advancing;
5. keep the README, examples, security/privacy boundary, package names, and provenance synchronized with verified behavior; and
6. update the working plan with concrete evidence.

The implementation must include a deterministic synthetic evaluation corpus for preference recall, project isolation, peer isolation, explicit correction, freshness against current code, sparse evidence, stored prompt injection, subagent exclusion, outage/fail-open, and long-history token/latency bounds. Live Honcho tests must be opt-in and use isolated synthetic workspaces and peers; CI must not need a personal API key.

Before concluding, run the broadest safe verification supported by the environment. Inspect the final diff and package contents for secrets and accidental unrelated changes.

The final handoff must state:

- what was implemented by milestone and package;
- exact upstream revisions, dependency versions, provenance, and license boundaries;
- commands run and their results;
- concrete evidence for each acceptance criterion reached;
- every remaining unmet criterion and the next exact change needed;
- security, privacy, trust, data-egress, outbox, and non-sandbox limitations;
- whether any DSH patch was needed and why; and
- paths to MCP/native examples, bundle artifacts, evaluation output, and primary tests.

Begin now by reading all repository instructions and the full specification, then implement Milestone 0.

---
