import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import { HonchoMemoryError, type HonchoRecallItem, type HonchoScope } from '../../packages/honcho/src/index.ts'
import { HonchoSdkMemory, type HonchoRemote, type RemoteMessage } from '../../packages/honcho-sdk/src/index.ts'
import {
  ArtifactCardIndexer,
  LocalArtifactStore,
  type ArtifactAuthority,
} from '../../packages/artifact-memory/src/index.ts'

const roots: string[] = []
const contexts: Context[] = []

afterEach(async () => {
  for (const context of contexts.splice(0)) await context.fiber.dispose()
  for (const root of roots.splice(0)) {
    const absolute = resolve(root)
    if (!absolute.startsWith(`${resolve(tmpdir())}${sep}`)) throw new Error('unsafe temporary test path')
    await rm(absolute, { recursive: true, force: true })
  }
})

class UnavailableRemote implements HonchoRemote {
  async workspaceExists(): Promise<boolean> {
    return true
  }
  async peerExists(): Promise<boolean> {
    return true
  }
  async sessionExists(): Promise<boolean> {
    return true
  }
  async ensurePeer(): Promise<void> {}
  async ensureSession(): Promise<void> {}
  async findDelivery(): Promise<readonly RemoteMessage[]> {
    return []
  }
  async addMessages(): Promise<readonly RemoteMessage[]> {
    throw new HonchoMemoryError('TRANSIENT', 'synthetic remote outage')
  }
  async representation(): Promise<string> {
    return ''
  }
  async search(): Promise<readonly HonchoRecallItem[]> {
    return []
  }
}

describe('artifact cards through the durable SDK outbox', () => {
  it('admits one sanitized assistant card locally while the remote provider is unavailable', async () => {
    const root = await mkdtemp(join(tmpdir(), 'deepseek-honcho-artifact-outbox-'))
    roots.push(root)
    const projectId = 'synthetic_project'
    const sessionId = 'artifact-outbox-session'
    const exportsRoot = join(root, 'rlm', 'sessions', sessionId, 'exports')
    const source = join(exportsRoot, 'private-source.bin')
    await mkdir(exportsRoot, { recursive: true })
    await writeFile(source, 'ARTIFACT_BYTES_NEVER_EGRESS')
    const store = new LocalArtifactStore({
      artifactRoot: join(root, 'artifacts'),
      rlmArtifactRoot: join(root, 'rlm'),
      projectId,
    })
    const authority: ArtifactAuthority = { projectId, dshSessionId: sessionId, agentKind: 'root' }
    const recorded = await store.record(authority, {
      sourcePath: source,
      title: 'Synthetic private aggregate',
      summary: 'Aggregate result without source rows or local paths.',
      queryFingerprint: createHash('sha256').update('private SELECT marker').digest('hex'),
      source: 'synthetic-warehouse',
      sourceVersion: 'snapshot-v1',
    })
    const ctx = new Context()
    contexts.push(ctx)
    const provider = new HonchoSdkMemory(
      ctx,
      {
        workspaceId: 'synthetic_workspace',
        userPeerId: 'synthetic_human',
        assistantPeerId: 'synthetic_assistant',
        projectId,
        stateRoot: join(root, 'honcho-state'),
        pollMs: 60_000,
        drainTimeoutMs: 10,
      },
      new UnavailableRemote(),
    )
    const scope: HonchoScope = provider.scopeForSession(sessionId, 'root')
    const indexer = new ArtifactCardIndexer(store, provider, {
      enabled: true,
      reconciliationIntervalMs: 60_000,
    })
    const queued = await indexer.queueCard(recorded.card, scope)
    expect(queued).toMatchObject({ honchoQueued: true, indexState: 'queued' })
    const pending = await provider.outbox.listPending()
    expect(pending).toHaveLength(1)
    expect(pending[0]?.request.messages).toEqual([
      expect.objectContaining({ role: 'experiment-card', peerId: 'synthetic_assistant' }),
    ])
    expect(Object.keys(pending[0]?.request.messages[0]?.metadata ?? {}).sort()).toEqual(
      [
        'artifact_id',
        'artifact_schema_version',
        'content_classification',
        'delivery_id',
        'dsh_agent_kind',
        'dsh_session_id',
        'experiment_id',
        'human_peer_id',
        'message_fingerprint',
        'plugin_version',
        'project_id',
        'projection_revision',
        'query_fingerprint',
        'remote_card_schema_version',
        'role',
        'schema_version',
        'source',
        'source_label',
        'source_version',
        'summary',
        'title',
      ].sort(),
    )
    const outboxEgress = JSON.stringify(pending[0]?.request)
    expect(outboxEgress).toContain('content_classification')
    expect(outboxEgress).not.toMatch(
      /ARTIFACT_BYTES_NEVER_EGRESS|private-source\.bin|private SELECT marker|sourcePath|source_path|[A-Za-z]:[\\/]/,
    )
    expect(await store.resolveArtifact(authority, recorded.card.experimentId)).toMatchObject({
      card: { experimentId: recorded.card.experimentId },
    })
    await indexer.dispose()
    await store.dispose()
  })
})
