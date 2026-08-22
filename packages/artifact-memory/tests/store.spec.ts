import { createHash } from 'node:crypto'
import { link, mkdir, mkdtemp, open, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, parse, resolve, sep } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ArtifactMemoryError,
  LocalArtifactStore,
  RLM_DEFAULT_MAX_VARIABLE_BYTES,
  artifactIdFromSha256,
  canonicalJson,
  experimentId,
  pathContained,
  projectKey,
  validateCard,
  type ArtifactAuthority,
  type ArtifactRecordInput,
  type LocalArtifactStoreInput,
} from '../src/index.ts'

const roots: string[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) {
    const absolute = resolve(root)
    if (!absolute.startsWith(`${resolve(tmpdir())}${sep}`)) throw new Error('unsafe temporary test path')
    await rm(absolute, { recursive: true, force: true })
  }
})

interface Harness {
  readonly root: string
  readonly rlmRoot: string
  readonly artifactRoot: string
  readonly sessionId: string
  readonly exportsRoot: string
  readonly authority: ArtifactAuthority
  readonly config: LocalArtifactStoreInput
}

async function harness(projectId = 'synthetic_project', sessionId = 'synthetic-session-1'): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), 'deepseek-honcho-artifacts-'))
  roots.push(root)
  const rlmRoot = join(root, 'rlm')
  const artifactRoot = join(root, 'memory')
  const exportsRoot = join(rlmRoot, 'sessions', sessionId, 'exports')
  await mkdir(exportsRoot, { recursive: true })
  return {
    root,
    rlmRoot,
    artifactRoot,
    sessionId,
    exportsRoot,
    authority: {
      projectId,
      dshSessionId: sessionId,
      agentKind: 'root',
      rootAgentId: sessionId,
      toolCallId: 'synthetic-tool-1',
    },
    config: {
      artifactRoot,
      rlmArtifactRoot: rlmRoot,
      projectId,
      repositoryRoot: process.cwd(),
    },
  }
}

function recordInput(sourcePath: string, suffix = ''): ArtifactRecordInput {
  return {
    sourcePath,
    title: `Synthetic cohort result${suffix}`,
    summary: 'Aggregate synthetic response counts for bounded artifact-memory verification.',
    queryFingerprint: createHash('sha256').update(`stable-query${suffix}`, 'utf8').digest('hex'),
    source: 'synthetic-warehouse',
    sourceVersion: 'snapshot-2026-08-21',
    mediaType: 'application/octet-stream',
    shape: '17825793 bytes',
    columns: ['cohort', 'response'],
    tags: ['cohort', 'synthetic'],
  }
}

async function writeRepeated(path: string, bytes: number): Promise<string> {
  await mkdir(dirname(path), { recursive: true })
  const handle = await open(path, 'wx')
  const chunk = Buffer.alloc(1024 * 1024, 0x5a)
  const digest = createHash('sha256')
  let remaining = bytes
  try {
    while (remaining > 0) {
      const next = chunk.subarray(0, Math.min(chunk.length, remaining))
      await handle.write(next)
      digest.update(next)
      remaining -= next.length
    }
  } finally {
    await handle.close()
  }
  return digest.digest('hex')
}

async function expectCode(operation: Promise<unknown>, code: ArtifactMemoryError['code']): Promise<void> {
  await expect(operation).rejects.toMatchObject({ name: 'ArtifactMemoryError', code })
}

describe('artifact and experiment contracts', () => {
  it('uses canonical identity JSON, lower-case base32 IDs, and one-way project keys', () => {
    const sha256 = createHash('sha256').update('synthetic bytes', 'utf8').digest('hex')
    const artifactId = artifactIdFromSha256(sha256)
    expect(artifactId).toMatch(/^art_[a-z2-7]{52}$/)
    expect(canonicalJson({ z: 1, a: { y: 2, b: 3 } })).toBe('{"a":{"b":3,"y":2},"z":1}')
    expect(
      experimentId({
        projectId: 'project-a',
        artifactId,
        queryFingerprint: '1'.repeat(64),
        sourceVersion: 'v1',
      }),
    ).toBe(
      experimentId({
        sourceVersion: 'v1',
        queryFingerprint: '1'.repeat(64),
        artifactId,
        projectId: 'project-a',
      }),
    )
    expect(projectKey('project-a')).toMatch(/^[a-z2-7]{52}$/)
    expect(projectKey('project-a')).not.toContain('project')
  })

  it('rejects unknown schema versions and identity mismatches on durable reads', () => {
    expect(() => validateCard({ schemaVersion: 2 })).toThrowError(
      expect.objectContaining({ code: 'UNSUPPORTED_VERSION' }),
    )
  })
})

describe('project-scoped local artifact store', () => {
  it('rejects dangerous and overlapping startup roots before creating store state', async () => {
    const fixture = await harness()
    const filesystemRoot = parse(fixture.root).root
    expect(
      () =>
        new LocalArtifactStore({
          ...fixture.config,
          artifactRoot: filesystemRoot,
        }),
    ).toThrowError(expect.objectContaining({ code: 'INVALID_CONFIG' }))
    expect(
      () =>
        new LocalArtifactStore({
          ...fixture.config,
          artifactRoot: homedir(),
        }),
    ).toThrowError(expect.objectContaining({ code: 'INVALID_CONFIG' }))
    expect(
      () =>
        new LocalArtifactStore({
          ...fixture.config,
          artifactRoot: join(process.cwd(), 'unsafe-artifact-state'),
        }),
    ).toThrowError(expect.objectContaining({ code: 'INVALID_CONFIG' }))
    expect(
      () =>
        new LocalArtifactStore({
          ...fixture.config,
          artifactRoot: join(fixture.rlmRoot, 'artifact-state'),
        }),
    ).toThrowError(expect.objectContaining({ code: 'INVALID_CONFIG' }))
    expect(
      () =>
        new LocalArtifactStore({
          ...fixture.config,
          profileRoot: fixture.artifactRoot,
        }),
    ).toThrowError(expect.objectContaining({ code: 'INVALID_CONFIG' }))
    expect(
      () =>
        new LocalArtifactStore({
          ...fixture.config,
          honchoStateRoot: fixture.rlmRoot,
        }),
    ).toThrowError(expect.objectContaining({ code: 'INVALID_CONFIG' }))
  })

  it('streams an oversized synthetic result, survives restart, resolves exactly, and fails closed after corruption', async () => {
    const fixture = await harness()
    const source = join(fixture.exportsRoot, 'oversized.bin')
    const bytes = RLM_DEFAULT_MAX_VARIABLE_BYTES + 1_048_577
    const expectedDigest = await writeRepeated(source, bytes)
    let maximumChunk = 0
    const store = new LocalArtifactStore(fixture.config, {
      onReadChunk: (size) => {
        maximumChunk = Math.max(maximumChunk, size)
      },
    })
    const recorded = await store.record(fixture.authority, recordInput(source))
    expect(recorded.card.artifact).toMatchObject({ sha256: expectedDigest, bytes })
    expect(recorded.card.artifact.artifactId).toBe(artifactIdFromSha256(expectedDigest))
    expect(maximumChunk).toBeLessThanOrEqual(1024 * 1024)
    expect(recorded.card).not.toHaveProperty('path')
    expect(JSON.stringify(recorded.card)).not.toContain(fixture.root)
    expect((await store.status()).objectBytes).toBe(bytes)
    await store.dispose()

    const restarted = new LocalArtifactStore(fixture.config)
    await restarted.initializeReady()
    const hits = await restarted.search(fixture.authority, recorded.card.queryFingerprint)
    expect(hits).toHaveLength(1)
    expect(hits[0]).toMatchObject({
      experimentId: recorded.card.experimentId,
      match: 'query-fingerprint',
      localAvailable: true,
      sourceKind: 'local',
    })
    const resolved = await restarted.resolveArtifact(
      fixture.authority,
      recorded.card.experimentId,
      recorded.card.sourceVersion,
    )
    expect(resolved).toMatchObject({ freshness: 'fresh', verifiedAt: expect.any(String) })
    expect(
      createHash('sha256')
        .update(await readFile(resolved.path))
        .digest('hex'),
    ).toBe(expectedDigest)

    await writeFile(resolved.path, 'corrupt')
    await expectCode(restarted.resolveArtifact(fixture.authority, recorded.card.experimentId), 'ARTIFACT_CORRUPT')
  }, 30_000)

  it('converges concurrent identical records and isolates physical objects by project', async () => {
    const fixture = await harness('project-a')
    const source = join(fixture.exportsRoot, 'same.bin')
    await writeFile(source, 'same synthetic bytes')
    const store = new LocalArtifactStore(fixture.config)
    const competingStore = new LocalArtifactStore(fixture.config)
    const [first, second] = await Promise.all([
      store.record(fixture.authority, recordInput(source)),
      competingStore.record(fixture.authority, recordInput(source)),
    ])
    expect(first.card.experimentId).toBe(second.card.experimentId)
    expect([first.deduplicated, second.deduplicated].sort()).toEqual([false, true])
    expect(await store.status()).toMatchObject({ objectCount: 1, cardCount: 1 })

    const otherSession = 'synthetic-session-2'
    const otherExports = join(fixture.rlmRoot, 'sessions', otherSession, 'exports')
    const otherSource = join(otherExports, 'same.bin')
    await mkdir(otherExports, { recursive: true })
    await writeFile(otherSource, 'same synthetic bytes')
    const other = new LocalArtifactStore({ ...fixture.config, projectId: 'project-b' })
    const otherResult = await other.record(
      { projectId: 'project-b', dshSessionId: otherSession, agentKind: 'root' },
      recordInput(otherSource),
    )
    expect(otherResult.card.artifact.artifactId).toBe(first.card.artifact.artifactId)
    const firstPath = (await store.resolveArtifact(fixture.authority, first.card.experimentId)).path
    const secondPath = (await other.resolveArtifact({ projectId: 'project-b' }, otherResult.card.experimentId)).path
    expect(firstPath).not.toBe(secondPath)
    expect(firstPath).toContain(projectKey('project-a'))
    expect(secondPath).toContain(projectKey('project-b'))
    await expectCode(store.resolveArtifact({ projectId: 'project-b' }, first.card.experimentId), 'INVALID_SCOPE')
  })

  it('serializes concurrent different records so the project quota cannot grow without bound', async () => {
    const fixture = await harness()
    const firstSource = join(fixture.exportsRoot, 'quota-a.bin')
    const secondSource = join(fixture.exportsRoot, 'quota-b.bin')
    await writeFile(firstSource, '123456')
    await writeFile(secondSource, 'abcdef')
    const boundedConfig = {
      ...fixture.config,
      maxArtifactBytes: 6,
      maxProjectBytes: 10,
    }
    const store = new LocalArtifactStore(boundedConfig)
    const competingStore = new LocalArtifactStore(boundedConfig)
    const outcomes = await Promise.allSettled([
      store.record(fixture.authority, recordInput(firstSource, '-a')),
      competingStore.record(fixture.authority, recordInput(secondSource, '-b')),
    ])
    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1)
    expect(outcomes.filter((outcome) => outcome.status === 'rejected')).toEqual([
      expect.objectContaining({ reason: expect.objectContaining({ code: 'PROJECT_QUOTA_EXCEEDED' }) }),
    ])
    expect(await store.status()).toMatchObject({ objectCount: 1, objectBytes: 6, cardCount: 1 })
  })

  it('enforces artifact, project, and card quotas without automatic deletion', async () => {
    const fixture = await harness()
    const source = join(fixture.exportsRoot, 'quota.bin')
    await writeFile(source, '123456789')
    const tooSmall = new LocalArtifactStore({
      ...fixture.config,
      maxArtifactBytes: 8,
      maxProjectBytes: 16,
    })
    await expectCode(tooSmall.record(fixture.authority, recordInput(source)), 'ARTIFACT_TOO_LARGE')

    const cardLimited = new LocalArtifactStore({
      ...fixture.config,
      maxArtifactBytes: 20,
      maxProjectBytes: 20,
      maxCardsPerProject: 1,
    })
    await cardLimited.record(fixture.authority, recordInput(source, '-one'))
    await expectCode(cardLimited.record(fixture.authority, recordInput(source, '-two')), 'CARD_QUOTA_EXCEEDED')
    expect(await cardLimited.status()).toMatchObject({ objectCount: 1, cardCount: 1 })
  })

  it('enforces metadata bounds before ingesting bytes', async () => {
    const fixture = await harness()
    const source = join(fixture.exportsRoot, 'metadata.bin')
    await writeFile(source, 'metadata bytes')
    const store = new LocalArtifactStore({
      ...fixture.config,
      titleCharacters: 5,
      maxTags: 1,
      tagCharacters: 3,
    })
    await expectCode(store.record(fixture.authority, { ...recordInput(source), title: 'sixsix' }), 'VALIDATION')
    await expectCode(
      store.record(fixture.authority, { ...recordInput(source), title: 'short', tags: ['one', 'two'] }),
      'VALIDATION',
    )
    await expectCode(
      store.record(fixture.authority, { ...recordInput(source), title: 'short', tags: ['long'] }),
      'VALIDATION',
    )
    expect(await store.status()).toMatchObject({ objectCount: 0, cardCount: 0 })
  })

  it('supports every exact and lexical local match with deterministic recency, result, and time bounds', async () => {
    const fixture = await harness()
    const firstSource = join(fixture.exportsRoot, 'search-a.bin')
    const secondSource = join(fixture.exportsRoot, 'search-b.bin')
    await writeFile(firstSource, 'search bytes a')
    await writeFile(secondSource, 'search bytes b')
    const store = new LocalArtifactStore({ ...fixture.config, localSearchMaxResults: 2 })
    const first = await store.record(fixture.authority, {
      ...recordInput(firstSource, '-search-a'),
      title: 'Shared lexical result A',
      summary: 'Bounded aggregate alpha search card.',
      sourceVersion: 'source-version-a',
      tags: ['exact-tag-a'],
    })
    const second = await store.record(fixture.authority, {
      ...recordInput(secondSource, '-search-b'),
      title: 'Shared lexical result B',
      summary: 'Bounded aggregate beta search card.',
      sourceVersion: 'source-version-b',
      tags: ['exact-tag-b'],
    })
    await store.replaceCard({ ...second.card, updatedAt: '2099-01-01T00:00:00.000Z' })

    for (const [query, match] of [
      [first.card.experimentId, 'experiment-id'],
      [first.card.artifact.artifactId, 'artifact-id'],
      [first.card.queryFingerprint, 'query-fingerprint'],
      ['exact-tag-a', 'tag'],
      ['source-version-a', 'source-version'],
    ] as const) {
      await expect(store.search(fixture.authority, query)).resolves.toMatchObject([
        { experimentId: first.card.experimentId, match },
      ])
    }
    await expect(store.search(fixture.authority, 'shared lexical result', 1)).resolves.toMatchObject([
      { experimentId: second.card.experimentId, match: 'lexical' },
    ])

    const timeBounded = new LocalArtifactStore({
      ...fixture.config,
      localSearchMaxResults: 2,
      localSearchTimeoutMs: 1,
    })
    await timeBounded.initializeReady()
    const firstScanned = timeBounded.cardsSnapshot()[0]
    expect(firstScanned).toBeDefined()
    vi.spyOn(Date, 'now').mockReturnValueOnce(0).mockReturnValueOnce(0).mockReturnValue(2)
    await expect(timeBounded.search(fixture.authority, 'shared lexical result', 2)).resolves.toMatchObject([
      { experimentId: firstScanned!.experimentId, match: 'lexical' },
    ])
  })

  it('reports every freshness state and never claims unknown freshness', async () => {
    const fixture = await harness()
    const source = join(fixture.exportsRoot, 'freshness.bin')
    await writeFile(source, 'freshness bytes')
    const store = new LocalArtifactStore(fixture.config)
    const known = await store.record(fixture.authority, recordInput(source))
    await expect(store.resolveArtifact(fixture.authority, known.card.experimentId)).resolves.toMatchObject({
      freshness: 'not_checked',
    })
    await expect(
      store.resolveArtifact(fixture.authority, known.card.experimentId, known.card.sourceVersion),
    ).resolves.toMatchObject({ freshness: 'fresh' })
    await expect(
      store.resolveArtifact(fixture.authority, known.card.experimentId, 'new-snapshot'),
    ).resolves.toMatchObject({ freshness: 'stale', warning: expect.stringContaining('Historical') })

    const unknown = await store.record(fixture.authority, {
      ...recordInput(source, '-unknown'),
      sourceVersion: 'unknown',
    })
    await expect(
      store.resolveArtifact(fixture.authority, unknown.card.experimentId, 'new-snapshot'),
    ).resolves.toMatchObject({ freshness: 'unverifiable', warning: expect.stringContaining('unverifiable') })
  })

  it('fails closed for missing bytes and revalidates changed files in cached and always modes', async () => {
    for (const integrityMode of ['cached', 'always'] as const) {
      const fixture = await harness(`integrity-${integrityMode}`, `integrity-session-${integrityMode}`)
      const source = join(fixture.exportsRoot, 'integrity.bin')
      await writeFile(source, 'integrity-original')
      const store = new LocalArtifactStore({ ...fixture.config, integrityMode })
      const recorded = await store.record(fixture.authority, recordInput(source))
      const first = await store.resolveArtifact(fixture.authority, recorded.card.experimentId)
      const second = await store.resolveArtifact(fixture.authority, recorded.card.experimentId)
      if (integrityMode === 'cached') expect(second.verifiedAt).toBe(first.verifiedAt)
      await writeFile(first.path, 'integrity-tampered')
      await expectCode(store.resolveArtifact(fixture.authority, recorded.card.experimentId), 'ARTIFACT_CORRUPT')
      await rm(first.path)
      await expectCode(store.resolveArtifact(fixture.authority, recorded.card.experimentId), 'ARTIFACT_MISSING')
    }
  })

  it('ignores recognizable crash temporaries while preserving valid cards and objects', async () => {
    const fixture = await harness()
    const source = join(fixture.exportsRoot, 'restart.bin')
    await writeFile(source, 'restart bytes')
    const store = new LocalArtifactStore(fixture.config)
    const recorded = await store.record(fixture.authority, recordInput(source))
    await writeFile(join(store.layout.tmp, '.ingest-crash.tmp'), 'partial')
    await store.dispose()
    const restarted = new LocalArtifactStore(fixture.config)
    await restarted.initializeReady()
    expect(await restarted.status()).toMatchObject({ objectCount: 1, cardCount: 1, tempCount: 1 })
    await expect(restarted.resolveArtifact(fixture.authority, recorded.card.experimentId)).resolves.toMatchObject({
      card: { experimentId: recorded.card.experimentId },
    })
  })

  it('quarantines an unsupported durable card and fails closed when resolving it directly', async () => {
    const fixture = await harness()
    const source = join(fixture.exportsRoot, 'unsupported-card.bin')
    await writeFile(source, 'unsupported-card bytes')
    const store = new LocalArtifactStore(fixture.config)
    const recorded = await store.record(fixture.authority, recordInput(source))
    const cardPath = join(store.layout.cards, `${recorded.card.experimentId}.json`)
    await writeFile(cardPath, `${JSON.stringify({ ...recorded.card, schemaVersion: 2 })}\n`)
    await store.dispose()

    const restarted = new LocalArtifactStore(fixture.config)
    await restarted.initializeReady()
    expect(await restarted.status()).toMatchObject({ cardCount: 1, invalidCardCount: 1 })
    await expect(restarted.search(fixture.authority, recorded.card.queryFingerprint)).resolves.toEqual([])
    await expectCode(restarted.resolveArtifact(fixture.authority, recorded.card.experimentId), 'UNSUPPORTED_VERSION')
  })
})

describe('ingest containment and filesystem safety', () => {
  it('uses component semantics for Windows and POSIX traversal and prefix collisions', () => {
    expect(pathContained('/state/session/exports', '/state/session/exports/result.bin', 'posix')).toBe(true)
    expect(pathContained('/state/session/exports', '/state/session/exports-evil/result.bin', 'posix')).toBe(false)
    expect(pathContained('/state/session/exports', '/state/session/exports/../snapshot.bin', 'posix')).toBe(false)
    expect(pathContained('C:\\state\\exports', 'C:\\state\\exports\\result.bin', 'win32')).toBe(true)
    expect(pathContained('C:\\state\\exports', 'C:\\state\\exports-evil\\result.bin', 'win32')).toBe(false)
    expect(pathContained('C:\\state\\exports', 'C:\\state\\exports\\..\\snapshot.bin', 'win32')).toBe(false)
    expect(pathContained('C:\\state\\exports', 'D:\\state\\exports\\result.bin', 'win32')).toBe(false)
  })

  it('rejects arbitrary session files, prefix collisions, directories, and detectable hard-link escapes', async () => {
    const fixture = await harness()
    const store = new LocalArtifactStore(fixture.config)
    const internal = join(fixture.rlmRoot, 'sessions', fixture.sessionId, 'snapshot.dill')
    await writeFile(internal, 'snapshot must be ineligible')
    await expectCode(store.record(fixture.authority, recordInput(internal)), 'INVALID_PATH')

    const prefix = `${fixture.exportsRoot}-evil`
    await mkdir(prefix, { recursive: true })
    const prefixFile = join(prefix, 'result.bin')
    await writeFile(prefixFile, 'prefix collision')
    await expectCode(store.record(fixture.authority, recordInput(prefixFile)), 'INVALID_PATH')
    await expectCode(store.record(fixture.authority, recordInput(fixture.exportsRoot)), 'NOT_REGULAR_FILE')

    const outside = join(fixture.root, 'outside.bin')
    const hardlink = join(fixture.exportsRoot, 'hardlink.bin')
    await writeFile(outside, 'linked bytes')
    await link(outside, hardlink)
    await expectCode(store.record(fixture.authority, recordInput(hardlink)), 'UNSAFE_FILESYSTEM_ENTRY')
  })

  it('rejects a symlink or junction when the platform permits creating one', async () => {
    const fixture = await harness()
    const store = new LocalArtifactStore(fixture.config)
    const outside = join(fixture.root, 'outside-link.bin')
    const linked = join(fixture.exportsRoot, 'linked.bin')
    await writeFile(outside, 'link target')
    try {
      await symlink(outside, linked, 'file')
    } catch (error: unknown) {
      if (!['EPERM', 'EACCES', 'UNKNOWN'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error
      return
    }
    await expectCode(store.record(fixture.authority, recordInput(linked)), 'UNSAFE_FILESYSTEM_ENTRY')
  })

  it('detects mutation between streaming and commit', async () => {
    const fixture = await harness()
    const source = join(fixture.exportsRoot, 'mutable.bin')
    await writeFile(source, 'original bytes')
    const store = new LocalArtifactStore(fixture.config, {
      beforeSourceRestat: async () => {
        await writeFile(source, 'changed bytes with another length')
      },
    })
    await expectCode(store.record(fixture.authority, recordInput(source)), 'FILE_MUTATED')
    expect(await store.status()).toMatchObject({ objectCount: 0, cardCount: 0 })
  })
})
