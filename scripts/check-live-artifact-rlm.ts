import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
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
import { Honcho } from '@honcho-ai/sdk'
import ArtifactMemory from '../packages/artifact-memory/src/index.ts'
import { projectExperimentCard } from '../packages/artifact-memory/src/projection.ts'
import type { ExperimentCardV1 } from '../packages/artifact-memory/src/types.ts'
import type { HonchoScope } from '../packages/honcho/src/index.ts'
import HonchoSdkMemory from '../packages/honcho-sdk/src/index.ts'
import * as memoryTools from '../packages/tool-memory/src/index.ts'

const PINNED_RLM_REVISION = '79b6b28e16c7305e8e791f2d8c9d2935e75ade60'
const RLM_VARIABLE_SNAPSHOT_CAP = 16 * 1024 * 1024
const SYNTHETIC_ARTIFACT_BYTES = RLM_VARIABLE_SNAPSHOT_CAP + 1_048_577
const RESOURCE_SOURCE = 'deepseek-honcho-live-artifact-rlm-check'
const execFileAsync = promisify(execFile)

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

interface LiveHandle {
  readonly ctx: Context
  readonly agent: Agent
  readonly provider: HonchoSdkMemory
  readonly scope: HonchoScope
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

// The pinned DSH release predates this forward-compatible RLM event helper.
const sessionPrototype = Session.prototype as Session & {
  appendIgnorable?: (type: string, data: unknown) => unknown
}
if (typeof sessionPrototype.appendIgnorable !== 'function') {
  sessionPrototype.appendIgnorable = function appendIgnorable(type: string, data: unknown): unknown {
    return (this.append as (eventType: string, eventData: unknown) => unknown)(type, data)
  }
}

async function main(): Promise<void> {
  requireOptIn()
  const apiKey = process.env.HONCHO_API_KEY ?? ''
  const baseURL = validateBaseUrl(process.env.HONCHO_BASE_URL ?? 'https://api.honcho.dev')
  const checkout = resolve(requiredEnvironment('DEEPSEEK_RLM_CHECKOUT'))
  await assertPinnedCheckout(checkout)

  const runId = `${new Date().toISOString().replace(/\D/gu, '').slice(0, 14)}_${randomBytes(5).toString('hex')}`
  const workspaceId = `dsh_artifact_live_${runId}`
  const userPeerId = `synthetic_human_${runId}`
  const assistantPeerId = `synthetic_assistant_${runId}`
  const projectId = `synthetic_project_${runId}`
  const originSessionId = `artifact_origin_${runId}`
  const laterSessionId = `artifact_later_${runId}`
  const root = await mkdtemp(join(tmpdir(), 'deepseek-honcho-live-artifact-'))
  assert.ok(resolve(root).startsWith(`${resolve(tmpdir())}${sep}`), 'unsafe live-check temporary root')
  const outputRoot = resolve('evaluation-results')
  const manifestPath = join(outputRoot, `live-artifact-${runId}-resource-manifest.json`)
  const reportPath = join(outputRoot, `live-artifact-${runId}.json`)
  const contexts: Context[] = []
  const started = performance.now()
  let backendStoredAt = ''

  await atomicJson(manifestPath, {
    schemaVersion: 1,
    source: RESOURCE_SOURCE,
    runId,
    createdAt: new Date().toISOString(),
    baseURL,
    workspaceId,
    userPeerId,
    assistantPeerId,
    projectId,
    dshSessionIds: [originSessionId, laterSessionId],
    synthetic: true,
    cleanupRequired: true,
    cleanupCompleted: false,
  })

  try {
    const client = new Honcho({ apiKey, baseURL, workspaceId, timeout: 10_000, maxRetries: 1 })
    const existing = await client.workspaces({ filters: { id: workspaceId }, page: 1, size: 10 })
    assert.equal(existing.items.includes(workspaceId), false, 'generated live workspace already exists')
    await client.setMetadata({
      source: RESOURCE_SOURCE,
      run_id: runId,
      synthetic: true,
      artifact_memory_version: '0.2.0',
    })

    const queryText = `synthetic longitudinal cohort retention ${runId}`
    const queryFingerprint = createHash('sha256').update(queryText).digest('hex')
    const first = await setup({
      root,
      checkout,
      baseURL,
      workspaceId,
      userPeerId,
      assistantPeerId,
      projectId,
      sessionId: originSessionId,
      stateName: 'honcho-origin',
    })
    contexts.push(first.ctx)

    const recordOutput = await ipython(
      first.ctx,
      first.agent,
      'live-artifact-record',
      `
from pathlib import Path
import json as _json
import os as _os

_exports = Path(_os.environ["RLM_SESSION_DIR"]) / "exports"
_exports.mkdir(parents=True, exist_ok=True)
print("KERNEL_HAS_HONCHO_KEY=" + str("HONCHO_API_KEY" in _os.environ).lower())
_source = _exports / "synthetic-live-oversized.bin"
_target_bytes = ${SYNTHETIC_ARTIFACT_BYTES}
with _source.open("wb") as _stream:
    _stream.write(b"ARTIFACT-LIVE-V02\\n")
    _remaining = _target_bytes - len(b"ARTIFACT-LIVE-V02\\n")
    _chunk = b"z" * (1024 * 1024)
    while _remaining:
        _part = _chunk[:min(len(_chunk), _remaining)]
        _stream.write(_part)
        _remaining -= len(_part)

_record = await dsh_tools.call("memory_artifact_record", {
    "source_path": str(_source),
    "title": "Synthetic oversized cohort aggregate",
    "summary": "Bounded aggregate generated by the pinned RLM kernel for longitudinal retention analysis.",
    "query_fingerprint": ${JSON.stringify(queryFingerprint)},
    "source": "synthetic-live-warehouse",
    "source_version": "live-snapshot-v1",
    "media_type": "application/octet-stream",
    "shape": "one deterministic synthetic binary result",
    "tags": ["synthetic", "oversized", "cohort", "retention"]
})
print("RECORD_OK=" + str(not _record["isError"]).lower())
print("RECORD_BYTES=" + str(_record["value"]["bytes"]))
del _record, _source, _exports, _target_bytes, _remaining, _chunk, _part, _stream
`.trim(),
    )
    assert.match(recordOutput.stdout, /KERNEL_HAS_HONCHO_KEY=false/u, 'Honcho credential reached the RLM kernel')
    assert.match(recordOutput.stdout, /RECORD_OK=true/u, 'RLM artifact record tool call failed')
    assert.match(
      recordOutput.stdout,
      new RegExp(`RECORD_BYTES=${SYNTHETIC_ARTIFACT_BYTES}`, 'u'),
      'recorded artifact size is incorrect',
    )

    const card = first.ctx.artifactMemory.store.cardsSnapshot()[0]
    assert.ok(card, 'local experiment card was not committed')
    assert.equal(card.artifact.bytes, SYNTHETIC_ARTIFACT_BYTES, 'local card recorded an incorrect artifact size')
    await drainProvider(first.provider, 60_000)

    const backendMessage = await waitForBackendMessage(client, first.scope, card, 60_000)
    backendStoredAt = backendMessage.createdAt
    const expectedProjection = projectExperimentCard(card, first.scope)
    assert.equal(backendMessage.peerId, assistantPeerId, 'backend card was not assistant-authored')
    assert.equal(backendMessage.sessionId, first.scope.honchoSessionId, 'backend card was stored in the wrong session')
    assert.equal(
      backendMessage.content,
      expectedProjection.message.content,
      'backend card content differs from projection',
    )
    for (const [key, value] of Object.entries(expectedProjection.message.metadata)) {
      assert.deepEqual(backendMessage.metadata[key], value, `backend metadata differs for ${key}`)
    }
    assert.equal(backendMessage.metadata.role, 'experiment-card', 'backend role is incorrect')
    assert.equal(backendMessage.metadata.human_peer_id, userPeerId, 'backend human scope is incorrect')
    assert.equal(backendMessage.metadata.project_id, projectId, 'backend project scope is incorrect')
    assert.equal(backendMessage.metadata.delivery_id, expectedProjection.deliveryId, 'backend delivery ID is incorrect')

    const backendEgress = JSON.stringify({
      peerId: backendMessage.peerId,
      content: backendMessage.content,
      metadata: backendMessage.metadata,
    })
    assert.equal(backendEgress.includes('ARTIFACT-LIVE-V02'), false, 'artifact bytes reached Honcho')
    assert.equal(backendEgress.includes('synthetic-live-oversized.bin'), false, 'artifact source path reached Honcho')
    assert.equal(backendEgress.includes(queryText), false, 'raw query text reached Honcho')
    assert.equal(backendEgress.includes(card.artifact.sha256), false, 'artifact integrity digest reached Honcho')
    assert.equal(/[A-Za-z]:[\\/]|RLM_SESSION_DIR|source_path/u.test(backendEgress), false, 'local path reached Honcho')

    const resolved = await first.ctx.artifactMemory.store.resolveArtifact(
      { projectId },
      card.experimentId,
      'live-snapshot-v1',
    )
    const exactBytes = await readFile(resolved.path)
    assert.equal(exactBytes.byteLength, SYNTHETIC_ARTIFACT_BYTES, 'local artifact bytes changed')
    assert.equal(
      createHash('sha256').update(exactBytes).digest('hex'),
      card.artifact.sha256,
      'local artifact SHA-256 changed',
    )

    await first.ctx.fiber.dispose()
    contexts.splice(contexts.indexOf(first.ctx), 1)

    const later = await setup({
      root,
      checkout,
      baseURL,
      workspaceId,
      userPeerId,
      assistantPeerId,
      projectId,
      sessionId: laterSessionId,
      stateName: 'honcho-later',
    })
    contexts.push(later.ctx)
    await later.ctx.artifactMemory.store.initializeReady()
    assert.equal(
      later.ctx.artifactMemory.store.cardsSnapshot().length,
      1,
      'later session did not recover the local card',
    )

    const semanticQuery = 'population study preserved across time'
    const semanticStarted = performance.now()
    await waitForSemanticCard(later.provider, later.scope, semanticQuery, card.experimentId, 240_000)
    const semanticLatencyMs = Math.round(performance.now() - semanticStarted)
    const searchOutput = await ipython(
      later.ctx,
      later.agent,
      'live-artifact-search',
      `
_search = await dsh_tools.call("memory_search", {"query": ${JSON.stringify(semanticQuery)}})
_hit = next((_item for _item in _search["value"]["items"] if _item.get("source_kind") == "honcho"), None)
print("HONCHO_SEMANTIC_HIT=" + str(_hit is not None).lower())
print("HONCHO_LOCAL_AVAILABLE=" + str(bool(_hit and _hit.get("local_available"))).lower())
del _search, _hit
`.trim(),
    )
    assert.match(searchOutput.stdout, /HONCHO_SEMANTIC_HIT=true/u, 'later RLM session did not receive a Honcho hit')
    assert.match(searchOutput.stdout, /HONCHO_LOCAL_AVAILABLE=true/u, 'Honcho hit did not bind to the local artifact')

    const resolveOutput = await ipython(
      later.ctx,
      later.agent,
      'live-artifact-resolve',
      `
import hashlib as _hashlib
_resolved = await dsh_tools.call("memory_artifact_resolve", {
    "experiment_id": ${JSON.stringify(card.experimentId)},
    "current_source_version": "live-snapshot-v1"
})
_meta = _resolved["value"]
with open(_meta["path"], "rb") as _stream:
    _slice = _stream.read(32)
    _digest = _hashlib.sha256(_slice)
    for _chunk in iter(lambda: _stream.read(1024 * 1024), b""):
        _digest.update(_chunk)
print("RESOLVE_FRESH=" + str(_meta["freshness"] == "fresh").lower())
print("RESOLVE_HASH_OK=" + str(_digest.hexdigest() == _meta["sha256"]).lower())
print("BOUNDED_SLICE_OK=" + str(_slice.startswith(b"ARTIFACT-LIVE-V02\\n")).lower())
del _resolved, _meta, _stream, _slice, _digest, _chunk
`.trim(),
    )
    assert.match(resolveOutput.stdout, /RESOLVE_FRESH=true/u, 'resolved artifact freshness is incorrect')
    assert.match(resolveOutput.stdout, /RESOLVE_HASH_OK=true/u, 'resolved artifact SHA-256 is incorrect')
    assert.match(resolveOutput.stdout, /BOUNDED_SLICE_OK=true/u, 'later RLM session did not load the bounded slice')
    assert.ok(resolveOutput.stdout.length < 1_000, 'RLM emitted an unbounded artifact result')

    await atomicJson(reportPath, {
      schemaVersion: 1,
      source: RESOURCE_SOURCE,
      runId,
      mode: 'live-hosted-honcho-real-pinned-rlm',
      completedAt: new Date().toISOString(),
      passed: true,
      containsArtifactContent: false,
      containsLocalPaths: false,
      containsCredentials: false,
      revisions: {
        deepseekRlm: PINNED_RLM_REVISION,
        honchoSdk: '2.3.0',
      },
      evidence: {
        realRlmKernel: true,
        dshToolRecord: true,
        backendMessageStored: true,
        backendStoredAt,
        exactProjectionMatch: true,
        assistantAuthored: true,
        correctProjectPeerAndSessionScope: true,
        artifactBytesEgressed: 0,
        localPathsEgressed: 0,
        rawQueriesEgressed: 0,
        backendProjectionBytes: Buffer.byteLength(backendEgress, 'utf8'),
        laterSessionSemanticHit: true,
        laterSessionLocalBinding: true,
        exactArtifactBytes: SYNTHETIC_ARTIFACT_BYTES,
        exactSha256Verified: true,
        sourceVersionFresh: true,
        boundedSliceLoaded: true,
        semanticLatencyMs,
        totalDurationMs: Math.round(performance.now() - started),
      },
      remoteResources: {
        synthetic: true,
        retainedForInspection: true,
        cleanupRequired: true,
        manifest: manifestPath.split(/[\\/]/u).at(-1),
      },
    })
    console.log('live artifact RLM check passed; content-free report and cleanup manifest written')
  } catch (error) {
    await atomicJson(reportPath, {
      schemaVersion: 1,
      source: RESOURCE_SOURCE,
      runId,
      mode: 'live-hosted-honcho-real-pinned-rlm',
      completedAt: new Date().toISOString(),
      passed: false,
      failureClass: safeErrorClass(error),
      containsArtifactContent: false,
      containsLocalPaths: false,
      containsCredentials: false,
      remoteResources: {
        synthetic: true,
        retainedForInspection: true,
        cleanupRequired: true,
        manifest: manifestPath.split(/[\\/]/u).at(-1),
      },
    })
    throw error
  } finally {
    for (const ctx of contexts.splice(0).reverse()) {
      try {
        await ctx.fiber.dispose()
      } catch {
        // Preserve the primary check result while still attempting all bounded disposal.
      }
    }
    await rm(resolve(root), { recursive: true, force: true })
  }
}

async function setup(input: {
  root: string
  checkout: string
  baseURL: string
  workspaceId: string
  userPeerId: string
  assistantPeerId: string
  projectId: string
  sessionId: string
  stateName: string
}): Promise<LiveHandle> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(HonchoSdkMemory, {
    apiKeyEnv: 'HONCHO_API_KEY',
    baseURL: input.baseURL,
    workspaceId: input.workspaceId,
    userPeerId: input.userPeerId,
    assistantPeerId: input.assistantPeerId,
    projectId: input.projectId,
    stateRoot: join(input.root, input.stateName),
    workspaceAutoCreate: false,
    timeoutMs: 10_000,
    maxRetries: 1,
    drainTimeoutMs: 5_000,
    pollMs: 100,
  })
  await ctx.plugin(ArtifactMemory, {
    enabled: true,
    artifactRoot: join(input.root, 'artifact-memory'),
    rlmArtifactRoot: join(input.root, 'rlm-artifacts'),
    projectId: input.projectId,
    assistantPeerId: input.assistantPeerId,
    recordTool: true,
    resolveTool: true,
    remoteIndexing: true,
    integrityMode: 'always',
    maxArtifactBytes: 32 * 1024 * 1024,
    maxProjectBytes: 64 * 1024 * 1024,
    reconciliationIntervalMs: 60_000,
  })
  await ctx.plugin(memoryTools, { timeoutMs: 10_000 })
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(SubagentRuntime)
  await ctx.plugin(spawnProvider, { providerName: 'rlm-spawn' })
  const agent = ctx.agentLoop.create(SessionId(input.sessionId), { provider: 'unused', model: 'unused' })
  const plugins = await loadPinnedPlugins(input.checkout)
  await ctx.plugin(plugins.rlm, {
    artifactRoot: join(input.root, 'rlm-artifacts'),
    managedRuntimeRoot: join(input.root, 'managed-runtime'),
    subagentProvider: 'rlm-spawn',
    adapters: { tools: true },
    snapshot: {
      policy: 'after-cell',
      maxBytes: 64 * 1024 * 1024,
      maxVariableBytes: RLM_VARIABLE_SNAPSHOT_CAP,
    },
  })
  await ctx.plugin(plugins.ipython)
  const provider = ctx.honcho as HonchoSdkMemory
  return { ctx, agent, provider, scope: provider.scopeForSession(input.sessionId, 'root') }
}

async function loadPinnedPlugins(checkout: string): Promise<{
  readonly rlm: Parameters<Context['plugin']>[0]
  readonly ipython: Parameters<Context['plugin']>[0]
}> {
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

async function ipython(ctx: Context, agent: Agent, callId: string, code: string): Promise<RlmExecutionValue> {
  const result = (await ctx.tools.execute({
    callId: CallId(callId),
    name: 'ipython',
    arguments: { code },
    agent,
    signal: new AbortController().signal,
  })) as ToolResult
  assert.equal(result.isError, false, 'live RLM IPython call failed')
  assert.ok(result.value, 'live RLM IPython call returned no value')
  return result.value
}

async function drainProvider(provider: HonchoSdkMemory, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    await provider.drainOnce()
    const counts = await provider.outbox.counts()
    assert.equal(counts.deadLetter, 0, 'live artifact delivery entered dead-letter')
    if (counts.pending === 0) return
    await delay(100)
  }
  throw new Error('live artifact delivery drain timed out')
}

async function waitForBackendMessage(
  client: Honcho,
  scope: HonchoScope,
  card: ExperimentCardV1,
  timeoutMs: number,
): Promise<BackendMessage> {
  const deadline = Date.now() + timeoutMs
  const session = await client.session(scope.honchoSessionId)
  while (Date.now() < deadline) {
    const page = await session.messages({
      filters: { metadata: { experiment_id: card.experimentId } },
      page: 1,
      size: 10,
    })
    if (page.items.length === 1) return page.items[0] as BackendMessage
    assert.ok(page.items.length < 2, 'duplicate experiment-card messages reached Honcho')
    await delay(500)
  }
  throw new Error('live artifact card did not appear in Honcho')
}

interface BackendMessage {
  readonly content: string
  readonly peerId: string
  readonly sessionId: string
  readonly metadata: Record<string, unknown>
  readonly createdAt: string
}

async function waitForSemanticCard(
  provider: HonchoSdkMemory,
  scope: HonchoScope,
  query: string,
  experimentId: string,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 12_000)
    try {
      const result = await provider.recall({
        scope,
        query,
        maxItems: 5,
        maxCharacters: 4_800,
        includeUserRepresentation: false,
        signal: controller.signal,
      })
      if (result.items.some((item) => item.experimentCard?.experimentId === experimentId)) return
    } catch {
      // Honcho processing and search are asynchronous; retry within the explicit bound.
    } finally {
      clearTimeout(timer)
    }
    await delay(2_000)
  }
  throw new Error('live Honcho semantic processing timed out')
}

async function assertPinnedCheckout(checkout: string): Promise<void> {
  const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: checkout })
  assert.equal(stdout.trim(), PINNED_RLM_REVISION, 'live check did not use the pinned RLM revision')
  await Promise.all([
    readFile(join(checkout, 'packages', 'rlm-jupyter', 'lib', 'index.js')),
    readFile(join(checkout, 'packages', 'tool-ipython', 'lib', 'index.js')),
  ])
}

function requireOptIn(): void {
  if (process.env.HONCHO_LIVE_TEST !== '1' || process.env.HONCHO_LIVE_ARTIFACT_RLM !== '1') {
    throw new Error('HONCHO_LIVE_TEST=1 and HONCHO_LIVE_ARTIFACT_RLM=1 are required')
  }
  requiredEnvironment('HONCHO_API_KEY')
}

function requiredEnvironment(name: string): string {
  const value = process.env[name]
  if (value === undefined || value.trim().length === 0) throw new Error(`${name} is required`)
  return value
}

function validateBaseUrl(value: string): string {
  const url = new URL(value)
  if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.username.length > 0 || url.password.length > 0) {
    throw new Error('HONCHO_BASE_URL must be HTTP(S) without credentials')
  }
  return url.toString().replace(/\/$/u, '')
}

async function atomicJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' })
  await rename(temporary, path)
}

function safeErrorClass(error: unknown): string {
  return error instanceof Error && /^[A-Za-z0-9_.-]{1,100}$/u.test(error.name) ? error.name : 'Error'
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds))
}

main().catch((error: unknown) => {
  console.error(`live artifact RLM check failed (${safeErrorClass(error)}); no remote content or identifiers emitted`)
  process.exitCode = 1
})
