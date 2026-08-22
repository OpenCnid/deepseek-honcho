import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { CallId } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import * as spawnProvider from '@deepseek-ai/dsh-subagent-spawn-in-process'
import { afterEach, describe, expect, it } from 'vitest'
import ArtifactMemory from '../../packages/artifact-memory/src/index.ts'
import { FakeHonchoMemory } from '../../packages/honcho/src/testkit.ts'
import type { HonchoRecallItem } from '../../packages/honcho/src/index.ts'
import * as memoryTools from '../../packages/tool-memory/src/index.ts'

const PINNED_RLM_REVISION = '79b6b28e16c7305e8e791f2d8c9d2935e75ade60'
const RLM_VARIABLE_SNAPSHOT_CAP = 16 * 1024 * 1024
const SYNTHETIC_ARTIFACT_BYTES = RLM_VARIABLE_SNAPSHOT_CAP + 1_048_577
const execFileAsync = promisify(execFile)
const checkoutInput = process.env.DEEPSEEK_RLM_CHECKOUT
const checkout = checkoutInput === undefined ? undefined : resolve(checkoutInput)
const describePinnedRlm = checkout === undefined ? describe.skip : describe
const contexts: Context[] = []
const roots: string[] = []

interface RlmExecutionValue {
  readonly stdout: string
  readonly stderr: string
  readonly result?: string
}

interface ToolResult {
  readonly isError: boolean
  readonly value?: RlmExecutionValue
  readonly error?: unknown
}

if (typeof Promise.withResolvers !== 'function') {
  Promise.withResolvers = function withResolvers<T>(): PromiseWithResolvers<T> {
    let resolvePromise!: (value: T | PromiseLike<T>) => void
    let rejectPromise!: (reason?: unknown) => void
    const promise = new Promise<T>((resolveValue, rejectValue) => {
      resolvePromise = resolveValue
      rejectPromise = rejectValue
    })
    return { promise, resolve: resolvePromise, reject: rejectPromise }
  }
}

// The pinned DSH release predates this forward-compatible RLM event helper. The
// pinned RLM integration suite uses the same public append() fallback.
const sessionPrototype = Session.prototype as Session & {
  appendIgnorable?: (type: string, data: unknown) => unknown
}
if (typeof sessionPrototype.appendIgnorable !== 'function') {
  sessionPrototype.appendIgnorable = function appendIgnorable(type: string, data: unknown): unknown {
    return (this.append as (eventType: string, eventData: unknown) => unknown)(type, data)
  }
}

afterEach(async () => {
  for (const context of contexts.splice(0)) await context.fiber.dispose()
  for (const root of roots.splice(0)) {
    const absolute = resolve(root)
    if (!absolute.startsWith(`${resolve(tmpdir())}${sep}`)) throw new Error('unsafe temporary test path')
    await rm(absolute, { recursive: true, force: true })
  }
})

async function loadPinnedPlugins(): Promise<{
  readonly rlm: Parameters<Context['plugin']>[0]
  readonly ipython: Parameters<Context['plugin']>[0]
}> {
  if (checkout === undefined) throw new Error('DEEPSEEK_RLM_CHECKOUT is required')
  const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: checkout })
  expect(stdout.trim()).toBe(PINNED_RLM_REVISION)
  const rlmModule: unknown = await import(
    pathToFileURL(join(checkout, 'packages', 'rlm-jupyter', 'lib', 'index.js')).href
  )
  const ipythonModule: unknown = await import(
    pathToFileURL(join(checkout, 'packages', 'tool-ipython', 'lib', 'index.js')).href
  )
  if (
    typeof rlmModule !== 'object' ||
    rlmModule === null ||
    !('default' in rlmModule) ||
    typeof ipythonModule !== 'object' ||
    ipythonModule === null
  ) {
    throw new Error('pinned RLM packages did not expose their documented plugins')
  }
  return {
    rlm: rlmModule.default as Parameters<Context['plugin']>[0],
    ipython: ipythonModule as Parameters<Context['plugin']>[0],
  }
}

async function setup(
  root: string,
  rlmCheckout: string,
  recallItems: readonly HonchoRecallItem[] = [],
): Promise<{ ctx: Context; agent: Agent; honcho: FakeHonchoMemory }> {
  const ctx = new Context()
  contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(FakeHonchoMemory, {
    workspaceId: 'synthetic_workspace',
    userPeerId: 'synthetic_human',
    assistantPeerId: 'synthetic_assistant',
    projectId: 'synthetic_project',
    recallItems,
  })
  await ctx.plugin(ArtifactMemory, {
    enabled: true,
    artifactRoot: join(root, 'artifact-memory'),
    rlmArtifactRoot: join(root, 'rlm-artifacts'),
    projectId: 'synthetic_project',
    assistantPeerId: 'synthetic_assistant',
    recordTool: true,
    resolveTool: true,
    remoteIndexing: true,
    integrityMode: 'always',
    maxArtifactBytes: 32 * 1024 * 1024,
    maxProjectBytes: 64 * 1024 * 1024,
    reconciliationIntervalMs: 60_000,
  })
  await ctx.plugin(memoryTools)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(SubagentRuntime)
  await ctx.plugin(spawnProvider, { providerName: 'rlm-spawn' })
  const sessionId = recallItems.length === 0 ? 'artifact-origin-session' : 'artifact-later-session'
  const agent = ctx.agentLoop.create(SessionId(sessionId), { provider: 'unused', model: 'unused' })
  const plugins = await loadPinnedPlugins()
  await ctx.plugin(plugins.rlm, {
    artifactRoot: join(root, 'rlm-artifacts'),
    managedRuntimeRoot: join(rlmCheckout, '.dsh-rlm', 'test-runtime'),
    subagentProvider: 'rlm-spawn',
    adapters: { tools: true },
    snapshot: {
      policy: 'after-cell',
      maxBytes: 64 * 1024 * 1024,
      maxVariableBytes: RLM_VARIABLE_SNAPSHOT_CAP,
    },
  })
  await ctx.plugin(plugins.ipython)
  return { ctx, agent, honcho: ctx.honcho as FakeHonchoMemory }
}

async function ipython(ctx: Context, agent: Agent, callId: string, code: string): Promise<RlmExecutionValue> {
  const result = (await ctx.tools.execute({
    callId: CallId(callId),
    name: 'ipython',
    arguments: { code },
    agent,
    signal: new AbortController().signal,
  })) as ToolResult
  expect(result.isError, JSON.stringify(result.error)).toBe(false)
  expect(result.value).toBeDefined()
  return result.value as RlmExecutionValue
}

describePinnedRlm('real pinned DSH + RLM artifact bridge', () => {
  it('records oversized exact bytes, survives restart, searches locally and semantically, resolves, and loads only a bounded slice', async () => {
    if (checkout === undefined) throw new Error('DEEPSEEK_RLM_CHECKOUT is required')
    const root = resolve(
      await import('node:fs/promises').then(({ mkdtemp }) => mkdtemp(join(tmpdir(), 'dsh-rlm-artifact-'))),
    )
    roots.push(root)
    const queryFingerprint = createHash('sha256').update('synthetic oversized result v1').digest('hex')
    const first = await setup(root, checkout)
    const recordOutput = await ipython(
      first.ctx,
      first.agent,
      'ipython-record-artifact',
      `
from pathlib import Path
import json as _json
import os as _os

_exports = Path(_os.environ["RLM_SESSION_DIR"]) / "exports"
_exports.mkdir(parents=True, exist_ok=True)
print("KERNEL_HAS_HONCHO_KEY=" + str("HONCHO_API_KEY" in _os.environ).lower())
_source = _exports / "synthetic-oversized.bin"
_target_bytes = ${SYNTHETIC_ARTIFACT_BYTES}
with _source.open("wb") as _stream:
    _stream.write(b"ARTIFACT-V02\\n")
    _remaining = _target_bytes - len(b"ARTIFACT-V02\\n")
    _chunk = b"x" * (1024 * 1024)
    while _remaining:
        _part = _chunk[:min(len(_chunk), _remaining)]
        _stream.write(_part)
        _remaining -= len(_part)

_record = await dsh_tools.call("memory_artifact_record", {
    "source_path": str(_source),
    "title": "Synthetic oversized cohort aggregate",
    "summary": "Bounded aggregate result generated by the pinned RLM kernel.",
    "query_fingerprint": ${JSON.stringify(queryFingerprint)},
    "source": "synthetic-warehouse",
    "source_version": "snapshot-v1",
    "media_type": "application/octet-stream",
    "shape": "one deterministic binary result",
    "tags": ["synthetic", "oversized", "cohort"]
})
print("ARTIFACT_RECORD=" + _json.dumps({
    "is_error": _record["isError"],
    "experiment_id": _record["value"]["experiment_id"],
    "artifact_id": _record["value"]["artifact_id"],
    "bytes": _record["value"]["bytes"],
    "sha256": _record["value"]["sha256"]
}, sort_keys=True))
del _record, _source, _exports, _target_bytes, _remaining, _chunk, _part, _stream
`.trim(),
    )
    expect(recordOutput.stdout).toContain('ARTIFACT_RECORD=')
    expect(recordOutput.stdout).toContain('KERNEL_HAS_HONCHO_KEY=false')
    expect(recordOutput.stdout).toContain(`"bytes": ${SYNTHETIC_ARTIFACT_BYTES}`)
    const card = first.ctx.artifactMemory.store.cardsSnapshot()[0]
    expect(card).toBeDefined()
    expect(card?.artifact.bytes).toBe(SYNTHETIC_ARTIFACT_BYTES)
    const projection = first.honcho.records[0]
    expect(projection?.messages).toHaveLength(1)
    expect(projection?.messages[0]).toMatchObject({ role: 'experiment-card', peerId: 'synthetic_assistant' })
    const remoteEgress = JSON.stringify(projection)
    expect(remoteEgress).not.toContain('synthetic-oversized.bin')
    expect(remoteEgress).not.toContain('ARTIFACT-V02')
    expect(remoteEgress).not.toContain(card?.artifact.sha256)
    expect(remoteEgress).not.toMatch(/[A-Za-z]:[\\/]|RLM_SESSION_DIR|source_path/)
    const exactBytes = await readFile(
      await first.ctx.artifactMemory.store
        .resolveArtifact({ projectId: 'synthetic_project' }, card?.experimentId ?? '', 'snapshot-v1')
        .then((result) => result.path),
    )
    expect(exactBytes.byteLength).toBe(SYNTHETIC_ARTIFACT_BYTES)
    expect(createHash('sha256').update(exactBytes).digest('hex')).toBe(card?.artifact.sha256)

    await first.ctx.fiber.dispose()
    contexts.splice(contexts.indexOf(first.ctx), 1)
    const remoteCard = {
      schemaVersion: 1 as const,
      experimentId: card?.experimentId ?? '',
      artifactId: card?.artifact.artifactId ?? '',
      projectId: card?.projectId ?? '',
      queryFingerprint,
      sourceVersion: card?.sourceVersion ?? '',
      source: card?.source ?? '',
      title: card?.title ?? '',
      summary: card?.summary ?? '',
      ...(card?.shape === undefined ? {} : { shape: card.shape }),
      ...(card?.columns === undefined ? {} : { columns: card.columns }),
      ...(card?.tags === undefined ? {} : { tags: card.tags }),
      projectionRevision: card?.index.projectionRevision ?? 1,
    }
    const later = await setup(root, checkout, [
      {
        kind: 'message',
        text: projection?.messages[0]?.content ?? 'sanitized experiment card',
        sourceId: 'synthetic-semantic-card',
        experimentCard: remoteCard,
      },
    ])
    await later.ctx.artifactMemory.store.initializeReady()
    expect(later.ctx.artifactMemory.store.cardsSnapshot()).toHaveLength(1)
    const searchOutput = await ipython(
      later.ctx,
      later.agent,
      'ipython-search-artifact',
      `
import json as _json
_local = await dsh_tools.call("memory_search", {"query": ${JSON.stringify(queryFingerprint)}})
_semantic = await dsh_tools.call("memory_search", {"query": "related cohort behavior discovered later"})
print("LOCAL_SEARCH=" + _json.dumps(_local["value"]["items"][0], sort_keys=True))
print("SEMANTIC_SEARCH=" + _json.dumps(_semantic["value"]["items"][0], sort_keys=True))
del _local, _semantic
`.trim(),
    )
    expect(searchOutput.stdout).toContain('"source_kind": "local"')
    expect(searchOutput.stdout).toContain('"match": "query-fingerprint"')
    expect(searchOutput.stdout).toContain('"source_kind": "honcho"')
    expect(searchOutput.stdout).toContain('"local_available": true')

    const resolveOutput = await ipython(
      later.ctx,
      later.agent,
      'ipython-resolve-artifact',
      `
import hashlib as _hashlib
import json as _json
_resolved = await dsh_tools.call("memory_artifact_resolve", {
    "experiment_id": ${JSON.stringify(card?.experimentId ?? '')},
    "current_source_version": "snapshot-v1"
})
_meta = _resolved["value"]
with open(_meta["path"], "rb") as _stream:
    _slice = _stream.read(32)
    _digest = _hashlib.sha256(_slice)
    for _chunk in iter(lambda: _stream.read(1024 * 1024), b""):
        _digest.update(_chunk)
print("RESOLVE_META=" + _json.dumps({
    "freshness": _meta["freshness"],
    "bytes": _meta["bytes"],
    "sha256_matches": _digest.hexdigest() == _meta["sha256"]
}, sort_keys=True))
print("BOUNDED_SLICE=" + repr(_slice))
del _resolved, _meta, _stream, _slice, _digest, _chunk
`.trim(),
    )
    expect(resolveOutput.stdout).toContain('"freshness": "fresh"')
    expect(resolveOutput.stdout).toContain('"sha256_matches": true')
    expect(resolveOutput.stdout).toContain("BOUNDED_SLICE=b'ARTIFACT-V02\\n")
    expect(resolveOutput.stdout).not.toContain('synthetic-oversized.bin')
    expect(resolveOutput.stdout.length).toBeLessThan(1_000)
  }, 180_000)
})
