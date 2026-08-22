# Pinned RLM artifact-bridge blocker

Status: resolved by the user-approved minimal upstream-ready DeepSeek RLM change described below.

## Revisions exercised

- DeepSeek Harness: `99f6f02fecdb7dff40c3fbc9470f5907c29f74ca` (`dsh-v0.1.0-rc.7`)
- DeepSeek RLM: `79b6b28e16c7305e8e791f2d8c9d2935e75ade60`
- Cordis: `4.0.1`

## Reproduction

From this repository, with the pinned RLM checkout built and its managed test runtime installed:

```powershell
$env:DEEPSEEK_RLM_CHECKOUT = '<absolute path to the pinned deepseek-rlm checkout>'
corepack pnpm exec vitest run tests/integration/rlm-artifact-memory.spec.ts --reporter=verbose
```

The test starts the real pinned Jupyter kernel through DSH `ToolRuntime`, writes a synthetic file larger than the configured per-variable snapshot cap under the kernel-derived `exports/` directory, and invokes Python's public `await dsh_tools.call("memory_artifact_record", ...)` bridge. The call reaches RLM's `HostBridge.callTool()` but fails before the artifact tool executes:

```text
RuntimeError: cannot get property "tools" without inject
```

This is not an artifact-package validation failure. No local object or card is committed because nested DSH tool dispatch is never entered.

## Cause

At the pinned revision, `JupyterRlmRuntime` declares these Cordis dependencies:

```ts
static inject = ['agents', 'llm', 'subagents']
```

The provider accepts `adapters.tools: true` and checks `ctx.get('tools')` during construction. Its `HostBridge`, however, later dereferences `this.ctx.tools` in both `listTools()` and `callTool()`. Cordis 4.0.1 correctly rejects that undeclared property access in the provider fiber. The RLM package already declares `@deepseek-ai/dsh-tools` as an exact peer, and the real DSH `ToolRuntime` is mounted in the reproduction.

## Smallest generic upstream-ready change

Preserve the tools adapter as optional and use Cordis's existing optional-service lookup at the two dispatch sites:

1. In `HostBridge.listTools()`, obtain `const tools = this.ctx.get('tools')`, fail with a stable host error if absent, then call `tools.schemas(agent)`.
2. In `HostBridge.callTool()`, obtain the same live optional service, fail if absent, then call `tools.execute(...)`.
3. Add a provider-level integration test with `adapters.tools: true` that performs a nested `dsh_tools.call()` through the real `ipython` tool. Retain a disabled-adapter test.

This is preferable to making `tools` an unconditional static injection because the RLM configuration deliberately makes the adapter optional. It also behaves correctly if the optional ToolRuntime service is replaced or removed during HMR.

## Guardrails observed

- The configured pinned RLM checkout was initially inspected and executed read-only; the failure occurred before any RLM edit.
- The user then approved the proposed exception. `SPEC.md` sections 26 and 35.13 now limit the change to this evidenced seam.
- RLM `HostBridge.listTools()` and `HostBridge.callTool()` now resolve the live optional ToolRuntime with `ctx.get('tools')` and return `ADAPTER_UNAVAILABLE` when absent. No other production behavior changed.
- The RLM provider regression performs a real nested `dsh_tools.call()` through `ipython`; all three provider integration cases pass.
- The artifact integration test remains at `tests/integration/rlm-artifact-memory.spec.ts`, opt-in through `DEEPSEEK_RLM_CHECKOUT`, and passes unchanged after rebuilding the pinned checkout.

## Passing acceptance evidence

The repaired bridge test used a real pinned kernel to write and record 17,825,793 bytes, disposed the first host/kernel, loaded the durable object/card in a distinct later session, found the experiment by local fingerprint and semantic card, resolved it through `dsh_tools.call()`, verified `fresh` plus exact SHA-256, and printed only a 32-byte deliberate slice. Its remote projection assertions found no artifact filename, bytes, raw query, SHA-256, local path, or credential marker.
