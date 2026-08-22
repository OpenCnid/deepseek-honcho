# Prompt for a new Codex implementation task

Copy everything below into a new Codex task whose workspace is `D:\deepseek-harness-custom-plugins-setup\deepseek-honcho`.

---

Implement the v0.2 artifact-memory extension defined in `SPEC.md` in this workspace. The v0.1 DSH + Honcho integration is already implemented and verified; extend that working baseline rather than rebuilding it or starting from Milestone 0.

Start by reading `AGENTS.md`, `README.md`, `GAMEPLAN.md`, and `SPEC.md` completely. Treat `SPEC.md` as normative, especially sections 26–35 and Milestones 8–11. Inspect the repository and working-tree state, existing package boundaries, tests, provenance, and current verification scripts before editing. Preserve all user changes and update a milestone-based plan tied to the artifact acceptance criteria and Definition of Done.

## Repository and architecture decision

Implement this in the `deepseek-honcho` repository, not `deepseek-rlm`.

Use the existing DeepSeek RLM revision as the compute substrate and integration target:

- DeepSeek Harness: `99f6f02fecdb7dff40c3fbc9470f5907c29f74ca` (`dsh-v0.1.0-rc.7`)
- Honcho: `ddbb90e36f2d148c7982f6ed85b09d31cabf5944`
- `@honcho-ai/sdk`: exact version `2.3.0`
- DeepSeek RLM: `79b6b28e16c7305e8e791f2d8c9d2935e75ade60`

The expected first implementation requires no source change in `D:\deepseek-rlm`. You may inspect that checkout read-only to verify the pinned public filesystem and `dsh_tools.call()` seams. Do not edit it unless a failing real integration test proves the specified public boundary cannot work. If that happens, stop before modifying RLM, document the failing evidence, propose the smallest generic upstream-ready change, and revise `SPEC.md` only with user approval.

The component responsibilities are fixed:

- DSH owns sessions, project identity, policy, tool authorization, lifecycle, and logging.
- RLM owns the live Python kernel, exact computation, and deliberate slicing.
- The new artifact package owns immutable local result bytes, experiment cards, integrity, and exact resolution.
- Honcho owns semantic discovery of sanitized experiment cards and existing conversation memory; it never owns artifact bytes or local truth.

Do not create a second general memory system, transcript store, vector database, agent loop, or automatic capture of every Python variable.

## Implementation target

Add the optional package `@deepseek-honcho/dsh-artifact-memory` and compose it through the existing bundle only when explicitly configured. Keep the original five memory tools and existing behavior unchanged when the package is disabled.

Implement Milestones 8–11 in order:

1. Artifact/card contracts and the project-scoped local store.
2. Sanitized Honcho experiment-card indexing and pending-card reconciliation.
3. DSH-authorized record/resolve tools, hybrid search, and the real RLM bridge.
4. Evaluation, operator documentation, packaging, and release hardening.

## Non-negotiable behavior

- Store exact bytes only beneath the configured project-scoped artifact root using streamed SHA-256 content addressing and atomic publication.
- Accept ingest sources only beneath the dedicated `exports/` directory of the exact DSH-derived current RLM session. Files elsewhere in the session—including snapshots, manifests, runtime metadata, connection data, and harness state—must be ineligible. The model may not choose a session, project, peer, destination, or arbitrary source root.
- Implement Windows and POSIX-safe component containment and reject traversal, prefix collisions, symlinks, junctions/reparse points, non-regular files, file mutation during ingest, and detectable link escapes.
- Validate and atomically persist versioned experiment cards with deterministic artifact and experiment IDs, quotas, concurrency safety, crash recovery, and integrity verification.
- Commit the local object and card before attempting remote indexing. Local record/search/resolve must work while Honcho is down or processing asynchronously.
- Construct Honcho projections from an allowlist after redaction and bounds. Never send artifact bytes, local paths, raw SQL/Python/query text, parameters, row samples, credentials, or opaque metadata to Honcho.
- Attribute experiment cards to the configured assistant/project observation scope, never as human preferences.
- Reuse the existing durable Honcho outbox, deterministic delivery, retry, circuit breaker, HMR fencing, and bounded lifecycle. Reconcile pending cards idempotently after failure/restart.
- Expose `memory_artifact_record` and `memory_artifact_resolve` only when enabled. Do not expose delete, cleanup, purge, arbitrary-read, arbitrary-project/peer, shell, or raw-provider tools.
- Extend `memory_search` with immediate local exact/lexical experiment-card results plus bounded Honcho semantic results. Search concurrently where practical, merge deterministically, deduplicate by experiment ID, and fail open remotely.
- Resolve only a current-project local card, then validate containment, size, SHA-256, and optional source-version freshness before returning a path through the authorized DSH tool result.
- Treat stale artifacts as historical results with an explicit warning; fail closed for missing or corrupt bytes; never claim freshness when the source version is absent or `unknown`.
- Exclude artifact tool inputs, outputs, bytes, and resolved paths from automatic lifecycle capture.
- Keep all Honcho credentials in the DSH host. Never pass them to the model, RLM kernel, events, fixtures, logs, cards, or artifact store.
- Keep recalled cards bounded, source-labeled, and untrusted. Current files, datasets, tests, explicit corrections, and DSH policy remain authoritative.
- Do not add SQLite, FTS, embeddings, native binaries, or remote object storage for v0.2. Use filesystem cards for immediate exact/lexical discovery and Honcho for semantic discovery.
- Do not implement automatic garbage collection. Inspection, export, retention, deletion, and orphan cleanup are operator-only concerns and must remain outside the model tool surface.

## Development method

Use existing repository patterns rather than parallel abstractions. Keep service definitions/provider consumers separable and provider-neutral. The artifact package may consume the abstract Honcho service and expose an optional local-search service to the current memory tool package; it must not import the concrete SDK unless the existing architecture proves that unavoidable.

Before relying on an upstream API, inspect its exact pinned type, implementation, test, and license. Do not infer behavior from names. Record provenance for adapted source. Use exact dependency versions and reproducible lockfiles. Avoid new dependencies when the standard library or existing workspace utilities suffice.

For every milestone:

1. implement the smallest complete end-to-end behavior that proves the milestone;
2. add focused unit tests plus the required real pinned DSH/RLM integration tests;
3. update examples, configuration, README, security/privacy/data-egress documentation, provenance, and evaluation artifacts to match verified behavior;
4. run the relevant formatting, lint, typecheck, unit, integration, package, secret, and provenance checks and fix failures before advancing; and
5. update the working plan with concrete evidence.

Use synthetic artifact content only. Live Honcho tests must remain opt-in, isolated, non-destructive, and independent of personal memory. Do not commit, push, publish, open a PR, perform destructive cleanup, or change live external data unless the user explicitly authorizes it.

## Required verification

Implement every test and evaluation case in sections 34–35. In particular, prove with a real pinned DSH + RLM path that:

1. a Python kernel writes a synthetic result larger than the RLM per-variable snapshot cap beneath its current session `exports/` directory;
2. it records the result only through `dsh_tools.call("memory_artifact_record", ...)`;
3. the object and local card survive process restart while Honcho receives only a sanitized card;
4. a distinct later DSH/RLM session finds the experiment both locally and semantically;
5. it resolves the exact project-scoped bytes through `dsh_tools.call("memory_artifact_resolve", ...)`;
6. integrity and source-version freshness are correctly reported; and
7. Python loads the artifact and prints only a deliberate bounded slice.

Also prove disabled-mode compatibility, project/peer isolation, arbitrary-path rejection, Windows/POSIX containment, concurrency, quota behavior, corruption/missing failures, Honcho outage and reconciliation, ambiguous delivery success, HMR/restart behavior, prompt-injection handling, lifecycle-capture exclusion, and zero artifact-byte/path/raw-query egress to Honcho.

Run the broadest safe repository verification before concluding, including the existing aggregate verification command. Inspect the final diff and packed package contents for secrets, absolute developer paths, accidental generated files, and unrelated edits.

## Final handoff

The final response must state:

- what was implemented in each milestone and package;
- whether any DSH or RLM source change was needed, with evidence;
- exact upstream revisions, dependency versions, provenance, and license boundaries;
- commands run and their results;
- concrete evidence for every acceptance criterion reached;
- every remaining unmet criterion and the next exact change needed;
- security, privacy, trust, data-egress, artifact-root, outbox, retention, and non-sandbox limitations;
- measured evaluation results and Honcho egress evidence; and
- paths to configuration/examples, package artifacts, evaluation output, and primary tests.

Begin now by reading the repository instructions and complete specification, inspecting the existing verified v0.1 implementation, and then implement Milestone 8. Do not reimplement Milestones 0–7.

---
