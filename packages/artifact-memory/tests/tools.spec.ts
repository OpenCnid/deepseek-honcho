import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { CallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { afterEach, describe, expect, it } from 'vitest'
import { FakeHonchoMemory } from '../../honcho/src/testkit.ts'
import * as memoryTools from '../../tool-memory/src/index.ts'
import ArtifactMemory, { ARTIFACT_TOOL_NAMES, type ArtifactMemoryConfig } from '../src/index.ts'

const contexts: Context[] = []
const roots: string[] = []
const signal = new AbortController().signal

afterEach(async () => {
  for (const context of contexts.splice(0)) await context.fiber.dispose()
  for (const root of roots.splice(0)) {
    const absolute = resolve(root)
    if (!absolute.startsWith(`${resolve(tmpdir())}${sep}`)) throw new Error('unsafe temporary test path')
    await rm(absolute, { recursive: true, force: true })
  }
})

function agent(id: string): Agent {
  return { id, session: { header: {} } } as unknown as Agent
}

async function root(): Promise<{ root: string; rlmRoot: string; artifactRoot: string }> {
  const value = await mkdtemp(join(tmpdir(), 'deepseek-honcho-tools-'))
  roots.push(value)
  return { root: value, rlmRoot: join(value, 'rlm'), artifactRoot: join(value, 'artifacts') }
}

async function setup(
  rootsForTest: { rlmRoot: string; artifactRoot: string },
  recallItems: ConstructorParameters<typeof FakeHonchoMemory>[1]['recallItems'] = [],
  artifactOverrides: Partial<ArtifactMemoryConfig> = {},
): Promise<{ ctx: Context; honcho: FakeHonchoMemory }> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(FakeHonchoMemory, {
    workspaceId: 'synthetic_workspace',
    userPeerId: 'synthetic_human',
    assistantPeerId: 'synthetic_assistant',
    projectId: 'synthetic_project',
    recallItems,
  })
  await ctx.plugin(ArtifactMemory, {
    enabled: true,
    artifactRoot: rootsForTest.artifactRoot,
    rlmArtifactRoot: rootsForTest.rlmRoot,
    projectId: 'synthetic_project',
    assistantPeerId: 'synthetic_assistant',
    recordTool: true,
    resolveTool: true,
    remoteIndexing: true,
    reconciliationIntervalMs: 60_000,
    ...artifactOverrides,
  })
  await ctx.plugin(memoryTools)
  return { ctx, honcho: ctx.honcho as FakeHonchoMemory }
}

function recordArguments(path: string) {
  return {
    source_path: path,
    title: 'Synthetic cohort response',
    summary: 'Aggregate response result for the bounded synthetic cohort.',
    query_fingerprint: createHash('sha256').update('stable synthetic computation').digest('hex'),
    source: 'synthetic-warehouse',
    source_version: 'snapshot-v1',
    media_type: 'text/csv',
    shape: '3 rows x 2 columns',
    columns: ['cohort', 'response'],
    tags: ['cohort', 'response'],
  }
}

describe('DSH-authorized artifact tools', () => {
  it('registers two tools only when explicitly enabled and exposes no scope/admin/read fields', async () => {
    const paths = await root()
    const { ctx } = await setup(paths)
    const schemas = ctx.tools.schemas(agent('artifact-session'))
    expect(schemas.map((schema) => schema.name).sort()).toEqual(
      [...memoryTools.MEMORY_TOOL_NAMES, ...ARTIFACT_TOOL_NAMES].sort(),
    )
    const artifactSchemas = schemas.filter((schema) => ARTIFACT_TOOL_NAMES.includes(schema.name as never))
    const fields = artifactSchemas.flatMap((schema) => Object.keys(schema.parameters.properties))
    expect(fields).not.toEqual(
      expect.arrayContaining([
        'project_id',
        'session_id',
        'peer_id',
        'workspace_id',
        'destination_path',
        'source_root',
        'delivery_id',
        'metadata',
      ]),
    )
    expect(schemas.map((schema) => schema.name).join(' ')).not.toMatch(
      /delete|cleanup|purge|arbitrary|shell|provider|admin/i,
    )
  })

  it('records through DSH policy/telemetry and fails arbitrary-path ingest safely', async () => {
    const paths = await root()
    const sessionId = 'record-session'
    const exportsRoot = join(paths.rlmRoot, 'sessions', sessionId, 'exports')
    const source = join(exportsRoot, 'result.csv')
    await mkdir(exportsRoot, { recursive: true })
    await writeFile(source, 'cohort,response\nA,0.5\nB,0.7\n')
    const { ctx, honcho } = await setup(paths)
    const seen: string[] = []
    ctx.on('tools/pre-execute', async (exec, next) => {
      seen.push(`pre:${exec.name}`)
      return next()
    })
    ctx.on('tools/result', (exec) => {
      seen.push(`result:${exec.name}`)
    })
    const recorded = await ctx.tools.execute({
      callId: CallId('record-1'),
      name: 'memory_artifact_record',
      arguments: recordArguments(source),
      agent: agent(sessionId),
      signal,
    })
    expect(recorded.isError).toBe(false)
    expect(recorded.value).toMatchObject({
      local_saved: true,
      honcho_queued: true,
      index_state: 'queued',
      experiment_id: expect.stringMatching(/^exp_/),
      artifact_id: expect.stringMatching(/^art_/),
    })
    expect(seen).toEqual(['pre:memory_artifact_record', 'result:memory_artifact_record'])
    expect(honcho.records).toHaveLength(1)
    expect(JSON.stringify(honcho.records)).not.toContain(source)
    expect(JSON.stringify(honcho.records)).not.toContain('cohort,response')

    const outside = join(paths.root, 'outside.csv')
    await writeFile(outside, 'must not ingest')
    const rejected = await ctx.tools.execute({
      callId: CallId('record-rejected'),
      name: 'memory_artifact_record',
      arguments: recordArguments(outside),
      agent: agent(sessionId),
      signal,
    })
    expect(rejected).toMatchObject({
      isError: true,
      error: { info: { code: 'INVALID_PATH' } },
    })

    const unknown = await ctx.tools.execute({
      callId: CallId('record-unknown-field'),
      name: 'memory_artifact_record',
      arguments: {
        ...recordArguments(source),
        opaque_metadata: { raw_rows: ['must not be accepted'] },
      },
      agent: agent(sessionId),
      signal,
    })
    expect(unknown).toMatchObject({ isError: true })
    expect(JSON.stringify(unknown)).not.toContain('must not be accepted')
  })

  it('recovers in a later session, merges local and semantic hits, resolves exact bytes, and reports freshness', async () => {
    const paths = await root()
    const firstSession = 'first-rlm-session'
    const exportsRoot = join(paths.rlmRoot, 'sessions', firstSession, 'exports')
    const source = join(exportsRoot, 'result.csv')
    const content = 'cohort,response\nA,0.5\nB,0.7\nC,0.9\n'
    await mkdir(exportsRoot, { recursive: true })
    await writeFile(source, content)
    const first = await setup(paths)
    const recorded = await first.ctx.tools.execute({
      callId: CallId('record-first'),
      name: 'memory_artifact_record',
      arguments: recordArguments(source),
      agent: agent(firstSession),
      signal,
    })
    expect(recorded.isError).toBe(false)
    const value = recorded.value as { experiment_id: string; artifact_id: string }
    const card = await first.ctx.artifactMemory.store.card(value.experiment_id)
    const projection = first.honcho.records[0]?.messages[0]
    expect(projection).toBeDefined()
    await first.ctx.fiber.dispose()
    contexts.splice(contexts.indexOf(first.ctx), 1)

    const remoteCard = {
      schemaVersion: 1 as const,
      experimentId: card.experimentId,
      artifactId: card.artifact.artifactId,
      projectId: card.projectId,
      queryFingerprint: card.queryFingerprint,
      sourceVersion: card.sourceVersion,
      source: card.source,
      title: card.title,
      summary: card.summary,
      ...(card.shape === undefined ? {} : { shape: card.shape }),
      ...(card.columns === undefined ? {} : { columns: card.columns }),
      ...(card.tags === undefined ? {} : { tags: card.tags }),
      projectionRevision: card.index.projectionRevision,
    }
    const later = await setup(paths, [
      {
        kind: 'message',
        text: projection?.content ?? 'sanitized experiment card',
        sourceId: 'remote-card-1',
        experimentCard: remoteCard,
      },
    ])
    const laterAgent = agent('later-rlm-session')
    const semantic = await later.ctx.tools.execute({
      callId: CallId('search-semantic'),
      name: 'memory_search',
      arguments: { query: 'semantically related phrase not in local metadata' },
      agent: laterAgent,
      signal,
    })
    expect(semantic.isError).toBe(false)
    expect(semantic.value).toMatchObject({
      items: [
        {
          kind: 'experiment-card',
          experiment_id: card.experimentId,
          local_available: true,
          source_kind: 'honcho',
          trust: 'untrusted-card',
        },
      ],
    })
    const exact = await later.ctx.tools.execute({
      callId: CallId('search-exact'),
      name: 'memory_search',
      arguments: { query: card.queryFingerprint },
      agent: laterAgent,
      signal,
    })
    expect((exact.value as { items: unknown[] }).items).toHaveLength(1)
    expect(exact.value).toMatchObject({
      items: [{ experiment_id: card.experimentId, match: 'query-fingerprint', source_kind: 'local' }],
    })

    const resolved = await later.ctx.tools.execute({
      callId: CallId('resolve-later'),
      name: 'memory_artifact_resolve',
      arguments: { experiment_id: card.experimentId, current_source_version: 'snapshot-v2' },
      agent: laterAgent,
      signal,
    })
    expect(resolved.isError).toBe(false)
    expect(resolved.value).toMatchObject({
      experiment_id: card.experimentId,
      freshness: 'stale',
      warning: expect.stringContaining('Historical'),
    })
    const resolvedValue = resolved.value as { path: string; sha256: string }
    const bytes = await readFile(resolvedValue.path)
    expect(bytes.toString('utf8').split('\n').slice(0, 2)).toEqual(['cohort,response', 'A,0.5'])
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(resolvedValue.sha256)
  })

  it('fails remote search open to local hits and discards wrong-project semantic cards', async () => {
    const paths = await root()
    const sessionId = 'outage-session'
    const exportsRoot = join(paths.rlmRoot, 'sessions', sessionId, 'exports')
    const source = join(exportsRoot, 'result.csv')
    await mkdir(exportsRoot, { recursive: true })
    await writeFile(source, 'synthetic local result')
    const { ctx, honcho } = await setup(paths)
    const recorded = await ctx.tools.execute({
      callId: CallId('record-outage'),
      name: 'memory_artifact_record',
      arguments: recordArguments(source),
      agent: agent(sessionId),
      signal,
    })
    const id = (recorded.value as { experiment_id: string }).experiment_id
    honcho.setFailure(new Error('synthetic remote outage'))
    const local = await ctx.tools.execute({
      callId: CallId('search-outage'),
      name: 'memory_search',
      arguments: { query: id },
      agent: agent('later-outage-session'),
      signal,
    })
    expect(local.isError).toBe(false)
    expect(local.value).toMatchObject({
      items: [{ experiment_id: id, source_kind: 'local' }],
      truncated: true,
    })

    honcho.setFailure()
    const wrongProject = {
      schemaVersion: 1 as const,
      experimentId: id,
      artifactId: (recorded.value as { artifact_id: string }).artifact_id,
      projectId: 'wrong_project',
      queryFingerprint: 'a'.repeat(64),
      sourceVersion: 'v1',
      source: 'wrong',
      title: 'wrong project',
      summary: 'must be discarded',
      projectionRevision: 1,
    }
    const isolatedPaths = await root()
    const isolated = await setup(isolatedPaths, [
      { kind: 'message', text: 'wrong project remote card', experimentCard: wrongProject },
    ])
    const rejected = await isolated.ctx.tools.execute({
      callId: CallId('search-wrong-project'),
      name: 'memory_search',
      arguments: { query: 'semantic only' },
      agent: agent('wrong-project-check'),
      signal,
    })
    expect(rejected).toMatchObject({ isError: false, value: { items: [] } })
  })
})
