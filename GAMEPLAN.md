# DeepSeek Honcho integration game plan

Status: Proposed
Date: 2026-08-21

## 1. Recommendation

Start with Honcho through DSH's existing MCP client and a DSH-specific skill, but treat that as an instrumented experiment. If the experiment establishes useful cross-session recall, build the native Cordis plugin described in [`SPEC.md`](./SPEC.md).

The native plugin is justified by lifecycle reliability, not by a need for more Honcho API surface. Its job is to make the small memory loop dependable:

```text
recall before useful work -> respond -> record the completed exchange asynchronously
```

DSH must remain the only control plane. Honcho is a memory service used by DSH, not an agent loop, planner, source-code database, or replacement session store.

## 2. What each layer remembers

| Layer | Retention | Best use | Must not become |
| --- | --- | --- | --- |
| DSH session log | durable per DSH session | exact events, tool calls, control-plane history | global semantic memory |
| DeepSeek RLM | persistent within an agent session | variables, computation, recursive investigation | trusted cross-session truth or a sandbox |
| Honcho | cross-session and derived | user preferences, intent, recurring constraints, prior decisions, episodic recall | current-code authority or provenance ledger |
| Git/files/tests/CI | durable current artifacts | implementation truth and verification | personalized memory |

Large or effectively unbounded context does not remove the need for memory management. It changes the capacity limit, but not relevance, freshness, contradiction handling, identity isolation, evidence quality, or the cost of repeatedly reasoning over everything.

## 3. Identity model

The first experiment and native implementation must use the same deterministic mapping:

- **Honcho workspace:** supplied by the operator; one stable workspace for the engineering environment unless an isolation requirement says otherwise.
- **Human peer:** one stable configured ID for the same person across DSH sessions and tools. Do not derive it from a display name.
- **Assistant peer:** one stable configured DSH ID; Honcho observation of the assistant is configurable.
- **Honcho session:** `dsh_` plus a base32url SHA-256 digest of the exact DSH `SessionId`. Store the original DSH ID in Honcho metadata, not in the Honcho ID.
- **Project scope:** a stable configured `projectId` attached as metadata. Project recall must filter on it; global user preferences may come from the user representation.
- **Subagents/RLM children:** never impersonate the human peer. Automatic capture is root-agent-only by default.

This mapping provides continuity without merging different people, projects, or internal agent messages into one representation.

## 4. Phase 0 — freeze the experiment

Deliverables:

- pin the researched DSH and Honcho revisions;
- document hosted and self-hosted endpoint choices;
- create a dedicated test workspace and non-production peer IDs;
- define a small, non-sensitive evaluation corpus;
- record baseline behavior with no memory enabled.

Exit condition: we can reproduce the same DSH build and know exactly which memory data may leave the host.

## 5. Phase 1 — MCP vertical slice

Use `@deepseek-ai/dsh-mcp-client` with Streamable HTTP:

```yaml
- id: mcp-honcho
  name: '@deepseek-ai/dsh-mcp-client'
  config:
    serverName: honcho
    transport: streamable-http
    url: https://mcp.honcho.dev
    headers:
      Authorization: !!js '`Bearer ${process.env.HONCHO_API_KEY}`'
      X-Honcho-Workspace-ID: !!js process.env.HONCHO_WORKSPACE_ID
    failOnStartupError: true
    toolCallTimeoutMs: 60000
```

Add a project skill under `.dsh/skills/honcho-memory/SKILL.md` that is adapted to DSH's tool names (`mcp__honcho__<tool>`). The skill should:

1. resolve the stable human and assistant peers;
2. get or create the deterministic Honcho session;
3. recall a bounded representation or targeted search only when it helps;
4. clearly label recalled text as fallible data;
5. record the user message and final answer after the exchange;
6. never call destructive Honcho tools unless the user explicitly requests administration.

Why adaptation is required: the DSH MCP client bridges MCP tools, but does not project MCP prompts/resources as DSH skills. The remote server's full instructions therefore cannot be assumed to control the agent reliably.

The MCP phase intentionally exposes more tools and relies on model compliance. It is not the production security or reliability model.

Exit condition: at least 20 scripted and 10 real engineering conversations have usable telemetry and no identity leakage.

## 6. Phase 2 — evaluation gate

Evaluate against a memory-disabled baseline and report both usefulness and failure modes.

### Required scenarios

1. **Cross-session preference:** remember a stable communication or engineering preference in a new DSH session.
2. **Project decision:** find a prior decision only inside the matching `projectId`.
3. **Correction:** a later explicit correction outranks an older statement and both remain auditable.
4. **Freshness:** an old memory about code cannot override the current repository or test result.
5. **Isolation:** a different human peer, workspace, or project receives no leaked memory.
6. **Sparse evidence:** the agent says it does not know instead of inventing a remembered fact.
7. **Outage:** DSH continues normally when Honcho is slow or unavailable.
8. **Prompt injection:** text stored in memory is treated as quoted data, not as authority.
9. **RLM boundary:** the IPython kernel can use memory only through DSH tools and never receives the Honcho key.
10. **Cost/latency:** measure added prompt tokens, calls, wall time, and Honcho reasoning cost.

### Promotion gates

Proceed to the native plugin only if:

- task/user preference accuracy improves materially over baseline;
- cross-identity leakage is zero in the test corpus;
- correction tests pass consistently;
- p95 first-step recall stays within the configured latency budget or fails open;
- injected memory stays within the token budget;
- manual inspection finds no secret/tool-output capture; and
- the team can explain every stored category and its retention/deletion path.

If Honcho is not useful enough, stop after the experiment. An integration should earn permanent lifecycle complexity.

## 7. Phase 3 — native DSH plugin

Build a composable Cordis capability seam with five packages:

- service definition (`ctx.honcho`);
- official Honcho SDK provider;
- root-agent lifecycle capture and recall consumer;
- minimal model-facing memory tools;
- installable DSH bundle.

The plugin will:

- listen to public `session/event` and `agent/pre-step` hooks;
- collect committed root-agent `user/message` and final textual `assistant/message` events;
- enqueue completed exchanges only after the corresponding successful `turn/end`;
- persist a host-side outbox before returning from the event handler;
- upload in the background with retry and duplicate detection;
- inject bounded global-user and project-scoped recall at most once per turn;
- log the injected context with plugin provenance;
- expose `memory_recall`, `memory_search`, `memory_record`, `memory_correct`, and `memory_status` instead of all Honcho administration tools; and
- fail open when remote memory is unavailable.

No host patch should be added unless implementation proves that the public DSH lifecycle contracts cannot satisfy a normative requirement. Any patch requires a minimal upstream-ready proposal and an explicit spec revision.

## 8. Phase 4 — hardening and rollout

- test hosted and self-hosted Honcho;
- add redaction, size limits, timeouts, retry/backoff, circuit breaking, and outbox recovery;
- add metrics without message contents or credentials;
- test HMR, process restart, concurrent sessions, RLM children, and cancellation;
- canary with capture-only mode before enabling automatic recall;
- add operator inspect/export/delete workflows outside the model tool surface;
- document data retention, consent, backup, and incident response;
- decide the repository/package license after reviewing the AGPL server boundary and Apache-2.0 SDK;
- publish only after the full acceptance suite passes.

## 9. Deliberate non-goals

- Storing source trees, build artifacts, raw tool output, or full DSH event logs in Honcho.
- Giving Honcho responsibility for current-code truth, task state, policy, secrets, or orchestration.
- Injecting a full user representation on every model step.
- Letting subagents automatically train the human peer representation.
- Exposing session/conclusion deletion to the model by default.

## 10. First implementation order

1. Repository and test harness bootstrap.
2. MCP experiment assets and evaluation runner.
3. `ctx.honcho` contract plus in-memory fake provider.
4. SDK provider and deterministic identity mapping.
5. durable outbox and completed-turn capture.
6. bounded first-step recall injection.
7. minimal memory tools.
8. bundle packaging and real DSH integration tests.
9. hosted/self-hosted canary and evaluation report.

The normative details and Definition of Done are in [`SPEC.md`](./SPEC.md).
