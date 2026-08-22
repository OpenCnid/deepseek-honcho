import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  type FileHandle,
} from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, parse, resolve } from 'node:path'
import { ArtifactMemoryError } from './errors.ts'
import { artifactIdFromSha256, experimentId, projectKey, validateExperimentId } from './ids.ts'
import {
  assertCanonicalInside,
  assertInside,
  assertSafeAbsolutePath,
  pathsOverlap,
  rejectLinksInExistingPath,
} from './paths.ts'
import type {
  ArtifactAuthority,
  ArtifactFreshness,
  ArtifactIndexState,
  ArtifactRecordInput,
  ArtifactRecordResult,
  ArtifactResolveResult,
  ArtifactSearchHit,
  ArtifactStoreStatus,
  ExperimentCardV1,
} from './types.ts'
import { validateCard, validateRecordMetadata, type MetadataBounds } from './validation.ts'

export const ARTIFACT_PLUGIN_VERSION = '0.2.0'
export const ARTIFACT_SCHEMA_VERSION = 1
export const RLM_DEFAULT_MAX_VARIABLE_BYTES = 16 * 1024 * 1024

const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/u
const READ_CHUNK_BYTES = 1024 * 1024

export interface LocalArtifactStoreConfig extends MetadataBounds {
  readonly artifactRoot: string
  readonly rlmArtifactRoot: string
  readonly projectId: string
  readonly maxArtifactBytes: number
  readonly maxProjectBytes: number
  readonly maxCardsPerProject: number
  readonly localSearchMaxResults: number
  readonly localSearchTimeoutMs: number
  readonly integrityMode: 'cached' | 'always'
  readonly repositoryRoot?: string
  readonly profileRoot?: string
  readonly honchoStateRoot?: string
  readonly forbiddenRoots?: readonly string[]
}

export type LocalArtifactStoreInput = Pick<LocalArtifactStoreConfig, 'artifactRoot' | 'rlmArtifactRoot' | 'projectId'> &
  Partial<Omit<LocalArtifactStoreConfig, 'artifactRoot' | 'rlmArtifactRoot' | 'projectId'>>

export interface ArtifactStoreTestHooks {
  readonly beforeSourceRestat?: () => Promise<void>
  readonly onReadChunk?: (bytes: number) => void
}

export const ARTIFACT_STORE_DEFAULTS = Object.freeze({
  maxArtifactBytes: 1024 * 1024 * 1024,
  maxProjectBytes: 20 * 1024 * 1024 * 1024,
  maxCardsPerProject: 10_000,
  titleCharacters: 200,
  summaryCharacters: 2_000,
  sourceCharacters: 200,
  sourceVersionCharacters: 200,
  mediaTypeCharacters: 200,
  shapeCharacters: 500,
  maxTags: 20,
  tagCharacters: 80,
  maxColumns: 256,
  columnCharacters: 128,
  localSearchMaxResults: 20,
  localSearchTimeoutMs: 100,
  integrityMode: 'cached' as const,
})

interface ProjectLayout {
  readonly project: string
  readonly objects: string
  readonly cards: string
  readonly tmp: string
  readonly lock: string
}

interface VerificationCacheEntry {
  readonly verifiedAt: string
}

/** Dependency-free, project-scoped content-addressed store. */
export class LocalArtifactStore {
  readonly config: Readonly<LocalArtifactStoreConfig>
  readonly layout: Readonly<ProjectLayout>
  private readonly hooks: ArtifactStoreTestHooks
  private readonly cards = new Map<string, ExperimentCardV1>()
  private readonly verificationCache = new Map<string, VerificationCacheEntry>()
  private invalidCardCount = 0
  private operationTail: Promise<void> = Promise.resolve()
  private readonly ready: Promise<void>
  private stopped = false

  constructor(input: LocalArtifactStoreInput, hooks: ArtifactStoreTestHooks = {}) {
    this.config = resolveStoreConfig(input)
    this.hooks = hooks
    const project = resolve(this.config.artifactRoot, 'projects', projectKey(this.config.projectId))
    this.layout = Object.freeze({
      project,
      objects: resolve(project, 'objects'),
      cards: resolve(project, 'cards'),
      tmp: resolve(project, 'tmp'),
      lock: resolve(project, '.record.lock'),
    })
    for (const target of Object.values(this.layout)) assertInside(this.config.artifactRoot, target)
    this.ready = this.initialize()
  }

  async initializeReady(): Promise<void> {
    await this.ready
  }

  async dispose(): Promise<void> {
    this.stopped = true
    await this.operationTail.catch(() => {})
  }

  async record(
    authority: ArtifactAuthority,
    input: ArtifactRecordInput,
    signal: AbortSignal = new AbortController().signal,
  ): Promise<ArtifactRecordResult> {
    this.assertAuthority(authority)
    const metadata = validateRecordMetadata(input, this.config)
    const source = await this.authorizeSource(authority.dshSessionId, input.sourcePath)
    return this.withProjectLock(signal, async () => {
      this.assertActive()
      signal.throwIfAborted()
      const temporary = resolve(this.layout.tmp, `.ingest-${process.pid}-${randomUUID()}.tmp`)
      assertInside(this.layout.project, temporary)
      let published = false
      try {
        const streamed = await this.streamSource(source, temporary, signal)
        const artifactId = artifactIdFromSha256(streamed.sha256)
        const id = experimentId({
          projectId: this.config.projectId,
          artifactId,
          queryFingerprint: metadata.queryFingerprint,
          sourceVersion: metadata.sourceVersion,
        })
        const object = this.objectPath(artifactId)
        await mkdir(dirname(object), { recursive: true, mode: 0o700 })
        await rejectLinksInExistingPath(dirname(object))
        const existingCard = await this.readCardIfPresent(id)
        const objectExists = await exists(object)
        if (objectExists) await this.verifyExistingObject(object, streamed.sha256, streamed.bytes)
        const usage = await this.projectUsage()
        if (!objectExists && usage.objectBytes + streamed.bytes > this.config.maxProjectBytes) {
          throw new ArtifactMemoryError('PROJECT_QUOTA_EXCEEDED', 'project artifact byte quota would be exceeded')
        }
        if (existingCard === undefined && usage.cardCount >= this.config.maxCardsPerProject) {
          throw new ArtifactMemoryError('CARD_QUOTA_EXCEEDED', 'project experiment-card quota is reached')
        }
        signal.throwIfAborted()
        const deduplicated = objectExists || !(await publishExclusive(temporary, object))
        published = true
        if (deduplicated) await this.verifyExistingObject(object, streamed.sha256, streamed.bytes)
        const objectInfo = await stat(object)
        const now = new Date().toISOString()
        const artifactCreatedAt = existingCard?.artifact.createdAt ?? timestampFor(objectInfo)
        const descriptionChanged =
          existingCard !== undefined &&
          projectionFieldsChanged(existingCard, {
            title: metadata.title,
            summary: metadata.summary,
            source: metadata.source,
            sourceVersion: metadata.sourceVersion,
            ...(metadata.shape === undefined ? {} : { shape: metadata.shape }),
            ...(metadata.columns === undefined ? {} : { columns: metadata.columns }),
            ...(metadata.tags === undefined ? {} : { tags: metadata.tags }),
          })
        const card: ExperimentCardV1 = validateCard(
          {
            schemaVersion: 1,
            experimentId: id,
            artifact: {
              schemaVersion: 1,
              artifactId,
              sha256: streamed.sha256,
              bytes: streamed.bytes,
              mediaType: metadata.mediaType,
              createdAt: artifactCreatedAt,
            },
            title: metadata.title,
            summary: metadata.summary,
            queryFingerprint: metadata.queryFingerprint,
            source: metadata.source,
            sourceVersion: metadata.sourceVersion,
            ...(metadata.shape === undefined ? {} : { shape: metadata.shape }),
            ...(metadata.columns === undefined ? {} : { columns: metadata.columns }),
            ...(metadata.tags === undefined ? {} : { tags: metadata.tags }),
            projectId: this.config.projectId,
            originSessionId: existingCard?.originSessionId ?? authority.dshSessionId,
            originAgentKind: existingCard?.originAgentKind ?? authority.agentKind,
            ...((existingCard?.rootAgentId ?? authority.rootAgentId) === undefined
              ? {}
              : { rootAgentId: existingCard?.rootAgentId ?? authority.rootAgentId }),
            ...((existingCard?.toolCallId ?? authority.toolCallId) === undefined
              ? {}
              : { toolCallId: existingCard?.toolCallId ?? authority.toolCallId }),
            pluginVersion: ARTIFACT_PLUGIN_VERSION,
            createdAt: existingCard?.createdAt ?? now,
            updatedAt: now,
            index:
              existingCard === undefined
                ? { state: 'pending', projectionRevision: 1, attempts: 0 }
                : descriptionChanged
                  ? {
                      state: 'pending',
                      projectionRevision: existingCard.index.projectionRevision + 1,
                      attempts: 0,
                    }
                  : existingCard.index,
          },
          this.config.projectId,
          this.config,
        )
        await this.writeCard(card)
        this.cards.set(card.experimentId, card)
        return { card, deduplicated }
      } finally {
        if (!published) await rm(temporary, { force: true })
      }
    })
  }

  async resolveArtifact(
    authority: Pick<ArtifactAuthority, 'projectId'>,
    id: string,
    currentSourceVersion?: string,
    signal: AbortSignal = new AbortController().signal,
  ): Promise<ArtifactResolveResult> {
    this.assertAuthority(authority)
    validateExperimentId(id)
    await this.ready
    this.assertActive()
    signal.throwIfAborted()
    const card = await this.readCard(id)
    const object = this.objectPath(card.artifact.artifactId)
    await rejectLinksInExistingPath(object)
    let info
    try {
      info = await lstat(object)
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new ArtifactMemoryError('ARTIFACT_MISSING', 'artifact bytes are missing')
      }
      throw error
    }
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) {
      throw new ArtifactMemoryError('ARTIFACT_CORRUPT', 'artifact object is not a safe regular file')
    }
    assertInside(this.layout.objects, object)
    await assertCanonicalInside(this.layout.objects, object)
    if (info.size !== card.artifact.bytes)
      throw new ArtifactMemoryError('ARTIFACT_CORRUPT', 'artifact size does not match its card')
    const cacheKey = `${card.artifact.artifactId}\0${info.dev}\0${info.ino}\0${info.size}\0${info.mtimeMs}\0${info.ctimeMs}`
    let verifiedAt =
      this.config.integrityMode === 'cached' ? this.verificationCache.get(cacheKey)?.verifiedAt : undefined
    if (verifiedAt === undefined) {
      const digest = await hashFile(object, signal)
      if (digest !== card.artifact.sha256)
        throw new ArtifactMemoryError('ARTIFACT_CORRUPT', 'artifact SHA-256 does not match its card')
      verifiedAt = new Date().toISOString()
      if (this.config.integrityMode === 'cached') {
        this.verificationCache.clear()
        this.verificationCache.set(cacheKey, { verifiedAt })
      }
    }
    const freshness = compareFreshness(card.sourceVersion, currentSourceVersion)
    return {
      path: await realpath(object),
      card,
      freshness,
      verifiedAt,
      ...(freshness === 'stale'
        ? { warning: 'Historical artifact: the recorded and current source versions differ.' }
        : freshness === 'unverifiable'
          ? { warning: 'Artifact freshness is unverifiable because a source version is absent or unknown.' }
          : {}),
    }
  }

  async search(
    authority: Pick<ArtifactAuthority, 'projectId'>,
    query: string,
    maximum = this.config.localSearchMaxResults,
    signal: AbortSignal = new AbortController().signal,
  ): Promise<readonly ArtifactSearchHit[]> {
    this.assertAuthority(authority)
    await this.ready
    this.assertActive()
    if (!Number.isSafeInteger(maximum) || maximum < 1)
      throw new ArtifactMemoryError('VALIDATION', 'search result bound is invalid')
    const normalized = normalizeSearch(query)
    if (normalized.length === 0) throw new ArtifactMemoryError('VALIDATION', 'artifact search query must not be empty')
    const started = Date.now()
    const candidates: Array<{ rank: number; card: ExperimentCardV1; match: ArtifactSearchHit['match'] }> = []
    for (const card of this.cards.values()) {
      signal.throwIfAborted()
      if (Date.now() - started >= this.config.localSearchTimeoutMs) break
      const match = matchCard(card, normalized)
      if (match !== undefined) candidates.push({ ...match, card })
    }
    candidates.sort(
      (left, right) =>
        left.rank - right.rank ||
        right.card.updatedAt.localeCompare(left.card.updatedAt) ||
        left.card.experimentId.localeCompare(right.card.experimentId),
    )
    const output: ArtifactSearchHit[] = []
    for (const candidate of candidates.slice(0, Math.min(maximum, this.config.localSearchMaxResults))) {
      const localAvailable = await this.objectLooksAvailable(candidate.card)
      output.push(cardHit(candidate.card, candidate.match, localAvailable))
    }
    return Object.freeze(output)
  }

  async card(id: string): Promise<ExperimentCardV1> {
    await this.ready
    return this.readCard(id)
  }

  async replaceCard(
    card: ExperimentCardV1,
    expectedIndex?: ExperimentCardV1['index'],
    signal: AbortSignal = new AbortController().signal,
  ): Promise<ExperimentCardV1> {
    await this.ready
    this.assertActive()
    const validated = validateCard(card, this.config.projectId, this.config)
    return this.withProjectLock(signal, async () => {
      const current = await this.readCard(validated.experimentId)
      if (
        expectedIndex !== undefined &&
        (current.index.projectionRevision !== expectedIndex.projectionRevision ||
          current.index.state !== expectedIndex.state ||
          current.index.attempts !== expectedIndex.attempts)
      ) {
        return current
      }
      await this.writeCard(validated)
      this.cards.set(validated.experimentId, validated)
      return validated
    })
  }

  cardsSnapshot(): readonly ExperimentCardV1[] {
    return Object.freeze([...this.cards.values()])
  }

  async status(): Promise<ArtifactStoreStatus> {
    await this.ready
    const usage = await this.projectUsage()
    const indexStates: Record<ArtifactIndexState, number> = {
      pending: 0,
      queued: 0,
      indexed: 0,
      failed: 0,
      disabled: 0,
    }
    for (const card of this.cards.values()) indexStates[card.index.state] += 1
    const tempCount = (await readdir(this.layout.tmp, { withFileTypes: true })).filter(
      (entry) => entry.isFile() && entry.name.startsWith('.ingest-') && entry.name.endsWith('.tmp'),
    ).length
    return {
      enabled: true,
      schemaVersion: 1,
      objectCount: usage.objectCount,
      objectBytes: usage.objectBytes,
      cardCount: usage.cardCount,
      invalidCardCount: this.invalidCardCount,
      tempCount,
      indexStates: Object.freeze(indexStates),
      integrityMode: this.config.integrityMode,
    }
  }

  private async initialize(): Promise<void> {
    for (const root of [this.config.artifactRoot, this.config.rlmArtifactRoot]) await rejectLinksInExistingPath(root)
    await narrowDirectory(this.config.artifactRoot)
    for (const path of [
      resolve(this.config.artifactRoot, 'projects'),
      this.layout.project,
      this.layout.objects,
      this.layout.cards,
      this.layout.tmp,
    ]) {
      await narrowDirectory(path)
    }
    await rejectLinksInExistingPath(this.layout.project)
    const canonicalArtifactRoot = await realpath(this.config.artifactRoot)
    const canonicalProject = await realpath(this.layout.project)
    assertInside(canonicalArtifactRoot, canonicalProject)
    await this.rebuildIndex()
  }

  private async rebuildIndex(): Promise<void> {
    this.cards.clear()
    this.invalidCardCount = 0
    for (const entry of await readdir(this.layout.cards, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue
      try {
        const card = validateCard(
          JSON.parse(await readFile(resolve(this.layout.cards, entry.name), 'utf8')),
          this.config.projectId,
          this.config,
        )
        if (`${card.experimentId}.json` !== entry.name)
          throw new ArtifactMemoryError('VALIDATION', 'card filename does not match experiment ID')
        this.cards.set(card.experimentId, card)
      } catch {
        this.invalidCardCount += 1
      }
    }
  }

  private assertAuthority(authority: Pick<ArtifactAuthority, 'projectId'>): void {
    if (authority.projectId !== this.config.projectId)
      throw new ArtifactMemoryError('INVALID_SCOPE', 'artifact project does not match host configuration')
  }

  private assertActive(): void {
    if (this.stopped) throw new ArtifactMemoryError('DISPOSED', 'artifact store is stopping')
  }

  private async authorizeSource(sessionId: string, sourcePath: string): Promise<string> {
    await this.ready
    this.assertActive()
    if (!SESSION_ID.test(sessionId))
      throw new ArtifactMemoryError('INVALID_SCOPE', 'DSH session ID cannot name an RLM session directory')
    const sessions = resolve(this.config.rlmArtifactRoot, 'sessions')
    const session = resolve(sessions, sessionId)
    if (dirname(session) !== sessions)
      throw new ArtifactMemoryError('INVALID_SCOPE', 'DSH session directory escaped the RLM root')
    const exportsRoot = resolve(session, 'exports')
    const source = assertSafeAbsolutePath('artifact source', sourcePath)
    assertInside(exportsRoot, source, 'artifact source is outside the exact caller-session exports directory')
    await rejectLinksInExistingPath(exportsRoot)
    await rejectLinksInExistingPath(source)
    let canonicalExports: string
    let canonicalSource: string
    try {
      ;[canonicalExports, canonicalSource] = await Promise.all([realpath(exportsRoot), realpath(source)])
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        throw new ArtifactMemoryError('INVALID_PATH', 'artifact source does not exist')
      throw error
    }
    assertInside(canonicalExports, canonicalSource, 'artifact source link target escaped caller-session exports')
    const info = await lstat(canonicalSource)
    if (!info.isFile() || info.isSymbolicLink())
      throw new ArtifactMemoryError('NOT_REGULAR_FILE', 'artifact source is not a regular file')
    if (info.nlink !== 1)
      throw new ArtifactMemoryError('UNSAFE_FILESYSTEM_ENTRY', 'artifact source has additional hard links')
    return canonicalSource
  }

  private async streamSource(
    source: string,
    temporary: string,
    signal: AbortSignal,
  ): Promise<{ sha256: string; bytes: number }> {
    const noFollow = typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0
    const sourceHandle = await open(source, constants.O_RDONLY | noFollow)
    const destination = await open(temporary, 'wx', 0o600)
    try {
      const before = await sourceHandle.stat()
      if (!before.isFile() || before.nlink !== 1)
        throw new ArtifactMemoryError('NOT_REGULAR_FILE', 'artifact source is not a safe regular file')
      const digest = createHash('sha256')
      const buffer = Buffer.allocUnsafe(READ_CHUNK_BYTES)
      let bytes = 0
      let position = 0
      while (true) {
        signal.throwIfAborted()
        const read = await sourceHandle.read(buffer, 0, buffer.length, position)
        if (read.bytesRead === 0) break
        this.hooks.onReadChunk?.(read.bytesRead)
        bytes += read.bytesRead
        if (bytes > this.config.maxArtifactBytes)
          throw new ArtifactMemoryError('ARTIFACT_TOO_LARGE', 'artifact exceeds the configured byte bound')
        const chunk = buffer.subarray(0, read.bytesRead)
        digest.update(chunk)
        await writeAll(destination, chunk, position)
        position += read.bytesRead
      }
      await destination.sync()
      await this.hooks.beforeSourceRestat?.()
      const after = await sourceHandle.stat()
      if (!sameFileSnapshot(before, after) || after.size !== bytes) {
        throw new ArtifactMemoryError('FILE_MUTATED', 'artifact source changed during ingest')
      }
      return { sha256: digest.digest('hex'), bytes }
    } finally {
      await Promise.allSettled([sourceHandle.close(), destination.close()])
    }
  }

  private objectPath(artifactId: string): string {
    const path = resolve(this.layout.objects, artifactId.slice(4, 6), artifactId)
    assertInside(this.layout.objects, path)
    return path
  }

  private cardPath(id: string): string {
    validateExperimentId(id)
    const path = resolve(this.layout.cards, `${id}.json`)
    assertInside(this.layout.cards, path)
    return path
  }

  private async readCard(id: string): Promise<ExperimentCardV1> {
    const path = this.cardPath(id)
    try {
      await rejectLinksInExistingPath(path)
      const card = validateCard(JSON.parse(await readFile(path, 'utf8')), this.config.projectId, this.config)
      this.cards.set(card.experimentId, card)
      return card
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        throw new ArtifactMemoryError('CARD_NOT_FOUND', 'experiment card was not found in the current project')
      if (error instanceof ArtifactMemoryError) throw error
      throw new ArtifactMemoryError('VALIDATION', 'experiment card is malformed', {
        cause: error,
      })
    }
  }

  private async readCardIfPresent(id: string): Promise<ExperimentCardV1 | undefined> {
    try {
      return await this.readCard(id)
    } catch (error: unknown) {
      if (error instanceof ArtifactMemoryError && error.code === 'CARD_NOT_FOUND') return undefined
      throw error
    }
  }

  private async writeCard(card: ExperimentCardV1): Promise<void> {
    const destination = this.cardPath(card.experimentId)
    const temporary = resolve(this.layout.tmp, `.card-${card.experimentId}-${process.pid}-${randomUUID()}.tmp`)
    assertInside(this.layout.project, temporary)
    const handle = await open(temporary, 'wx', 0o600)
    try {
      await handle.writeFile(`${JSON.stringify(card)}\n`, 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }
    try {
      await rename(temporary, destination)
      await syncDirectory(this.layout.cards)
    } catch (error: unknown) {
      await rm(temporary, { force: true })
      throw error
    }
  }

  private async verifyExistingObject(path: string, sha256: string, bytes: number): Promise<void> {
    await rejectLinksInExistingPath(path)
    const info = await lstat(path)
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size !== bytes) {
      throw new ArtifactMemoryError('ARTIFACT_CORRUPT', 'existing artifact object is invalid')
    }
    await assertCanonicalInside(this.layout.objects, path)
    if ((await hashFile(path)) !== sha256)
      throw new ArtifactMemoryError('ARTIFACT_CORRUPT', 'existing artifact object failed integrity verification')
  }

  private async projectUsage(): Promise<{ objectCount: number; objectBytes: number; cardCount: number }> {
    let objectCount = 0
    let objectBytes = 0
    for (const prefix of await readdir(this.layout.objects, { withFileTypes: true })) {
      if (!prefix.isDirectory()) continue
      const directory = resolve(this.layout.objects, prefix.name)
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (!entry.isFile()) continue
        const info = await lstat(resolve(directory, entry.name))
        if (info.isFile() && !info.isSymbolicLink()) {
          objectCount += 1
          objectBytes += info.size
        }
      }
    }
    const cardCount = (await readdir(this.layout.cards, { withFileTypes: true })).filter(
      (entry) => entry.isFile() && entry.name.endsWith('.json'),
    ).length
    return { objectCount, objectBytes, cardCount }
  }

  private async objectLooksAvailable(card: ExperimentCardV1): Promise<boolean> {
    try {
      const info = await lstat(this.objectPath(card.artifact.artifactId))
      return info.isFile() && !info.isSymbolicLink() && info.nlink === 1 && info.size === card.artifact.bytes
    } catch {
      return false
    }
  }

  private async withProjectLock<T>(signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
    const prior = this.operationTail
    let releaseLocal = (): void => {}
    const local = new Promise<void>((resolvePromise) => {
      releaseLocal = resolvePromise
    })
    this.operationTail = prior.catch(() => {}).then(() => local)
    await prior.catch(() => {})
    signal.throwIfAborted()
    const token = await acquireFileLock(this.layout.lock, signal)
    try {
      return await operation()
    } finally {
      await releaseFileLock(this.layout.lock, token)
      releaseLocal()
    }
  }
}

function resolveStoreConfig(input: LocalArtifactStoreInput): Readonly<LocalArtifactStoreConfig> {
  const artifactRoot = assertSafeAbsolutePath('artifact root', input.artifactRoot)
  const rlmArtifactRoot = assertSafeAbsolutePath('RLM artifact root', input.rlmArtifactRoot)
  for (const [label, path] of [
    ['artifact root', artifactRoot],
    ['RLM artifact root', rlmArtifactRoot],
  ] as const) {
    if (path === parse(path).root)
      throw new ArtifactMemoryError('INVALID_CONFIG', `${label} must not be a filesystem root`)
    if (path === resolve(homedir()))
      throw new ArtifactMemoryError('INVALID_CONFIG', `${label} must not be the home directory`)
  }
  if (pathsOverlap(artifactRoot, rlmArtifactRoot))
    throw new ArtifactMemoryError('INVALID_CONFIG', 'artifact and RLM roots must not overlap')
  const repositoryRoot = resolve(input.repositoryRoot ?? process.cwd())
  if (pathsOverlap(artifactRoot, repositoryRoot))
    throw new ArtifactMemoryError('INVALID_CONFIG', 'artifact root must not overlap the repository root')
  for (const dangerous of [input.profileRoot, input.honchoStateRoot, ...(input.forbiddenRoots ?? [])]) {
    if (dangerous === undefined) continue
    const absolute = assertSafeAbsolutePath('forbidden root', dangerous)
    if (pathsOverlap(artifactRoot, absolute) || pathsOverlap(rlmArtifactRoot, absolute)) {
      throw new ArtifactMemoryError('INVALID_CONFIG', 'artifact configuration overlaps a host-owned state root')
    }
  }
  if (input.projectId.length === 0) throw new ArtifactMemoryError('INVALID_CONFIG', 'project ID must not be empty')
  const config = { ...ARTIFACT_STORE_DEFAULTS, ...input, artifactRoot, rlmArtifactRoot }
  for (const key of [
    'maxArtifactBytes',
    'maxProjectBytes',
    'maxCardsPerProject',
    'titleCharacters',
    'summaryCharacters',
    'sourceCharacters',
    'sourceVersionCharacters',
    'mediaTypeCharacters',
    'shapeCharacters',
    'maxTags',
    'tagCharacters',
    'maxColumns',
    'columnCharacters',
    'localSearchMaxResults',
    'localSearchTimeoutMs',
  ] as const) {
    if (!Number.isSafeInteger(config[key]) || config[key] < 1)
      throw new ArtifactMemoryError('INVALID_CONFIG', `${key} must be a positive safe integer`)
  }
  if (config.maxArtifactBytes > config.maxProjectBytes)
    throw new ArtifactMemoryError('INVALID_CONFIG', 'one-artifact quota must not exceed the project byte quota')
  if (config.integrityMode !== 'cached' && config.integrityMode !== 'always')
    throw new ArtifactMemoryError('INVALID_CONFIG', 'integrity mode must be cached or always')
  return Object.freeze(config)
}

async function narrowDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 })
  try {
    await chmod(path, 0o700)
  } catch (error: unknown) {
    if (process.platform !== 'win32') throw error
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

async function publishExclusive(temporary: string, destination: string): Promise<boolean> {
  const { link } = await import('node:fs/promises')
  try {
    await link(temporary, destination)
    await rm(temporary, { force: true })
    await syncDirectory(dirname(destination))
    return true
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      await rm(temporary, { force: true })
      return false
    }
    throw error
  }
}

async function writeAll(handle: FileHandle, buffer: Buffer, position: number): Promise<void> {
  let offset = 0
  while (offset < buffer.length) {
    const written = await handle.write(buffer, offset, buffer.length - offset, position + offset)
    if (written.bytesWritten <= 0)
      throw new ArtifactMemoryError('FILE_MUTATED', 'artifact temporary write made no progress')
    offset += written.bytesWritten
  }
}

function sameFileSnapshot(
  left: Awaited<ReturnType<FileHandle['stat']>>,
  right: Awaited<ReturnType<FileHandle['stat']>>,
): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  )
}

async function hashFile(path: string, signal?: AbortSignal): Promise<string> {
  const noFollow = typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0
  const handle = await open(path, constants.O_RDONLY | noFollow)
  const digest = createHash('sha256')
  const buffer = Buffer.allocUnsafe(READ_CHUNK_BYTES)
  let position = 0
  try {
    while (true) {
      signal?.throwIfAborted()
      const read = await handle.read(buffer, 0, buffer.length, position)
      if (read.bytesRead === 0) break
      digest.update(buffer.subarray(0, read.bytesRead))
      position += read.bytesRead
    }
  } finally {
    await handle.close()
  }
  return digest.digest('hex')
}

function timestampFor(info: Awaited<ReturnType<typeof stat>>): string {
  const time = info.birthtimeMs > 0 ? info.birthtime : info.mtime
  return time.toISOString()
}

function compareFreshness(recorded: string, current?: string): ArtifactFreshness {
  if (current === undefined) return 'not_checked'
  if (recorded === 'unknown' || current === 'unknown' || current.length === 0) return 'unverifiable'
  return recorded === current ? 'fresh' : 'stale'
}

function normalizeSearch(value: string): string {
  return value.normalize('NFC').replace(/\r\n?/g, '\n').trim().toLocaleLowerCase('en-US')
}

function matchCard(
  card: ExperimentCardV1,
  query: string,
): { rank: number; match: ArtifactSearchHit['match'] } | undefined {
  if (card.experimentId.toLowerCase() === query) return { rank: 0, match: 'experiment-id' }
  if (card.artifact.artifactId.toLowerCase() === query) return { rank: 1, match: 'artifact-id' }
  if (card.queryFingerprint === query) return { rank: 2, match: 'query-fingerprint' }
  if (card.tags?.some((tag) => normalizeSearch(tag) === query)) return { rank: 3, match: 'tag' }
  if (normalizeSearch(card.sourceVersion) === query) return { rank: 4, match: 'source-version' }
  const haystack = [
    card.title,
    card.summary,
    card.source,
    card.sourceVersion,
    card.shape ?? '',
    ...(card.columns ?? []),
    ...(card.tags ?? []),
  ]
    .map(normalizeSearch)
    .join('\n')
  const terms = query.split(/\s+/u).filter(Boolean)
  if (terms.length > 0 && terms.every((term) => haystack.includes(term))) return { rank: 5, match: 'lexical' }
  return undefined
}

function cardHit(
  card: ExperimentCardV1,
  match: ArtifactSearchHit['match'],
  localAvailable: boolean,
): ArtifactSearchHit {
  return Object.freeze({
    kind: 'experiment-card',
    experimentId: card.experimentId,
    artifactId: card.artifact.artifactId,
    title: card.title,
    summary: card.summary,
    queryFingerprint: card.queryFingerprint,
    source: card.source,
    sourceVersion: card.sourceVersion,
    ...(card.shape === undefined ? {} : { shape: card.shape }),
    ...(card.columns === undefined ? {} : { columns: card.columns }),
    ...(card.tags === undefined ? {} : { tags: card.tags }),
    createdAt: card.createdAt,
    updatedAt: card.updatedAt,
    indexState: card.index.state,
    localAvailable,
    match,
    trust: 'untrusted-card',
    sourceKind: 'local',
  })
}

function projectionFieldsChanged(
  card: ExperimentCardV1,
  candidate: {
    readonly title: string
    readonly summary: string
    readonly source: string
    readonly sourceVersion: string
    readonly shape?: string
    readonly columns?: readonly string[]
    readonly tags?: readonly string[]
  },
): boolean {
  return (
    card.title !== candidate.title ||
    card.summary !== candidate.summary ||
    card.source !== candidate.source ||
    card.sourceVersion !== candidate.sourceVersion ||
    card.shape !== candidate.shape ||
    JSON.stringify(card.columns) !== JSON.stringify(candidate.columns) ||
    JSON.stringify(card.tags) !== JSON.stringify(candidate.tags)
  )
}

async function acquireFileLock(path: string, signal: AbortSignal): Promise<string> {
  const token = randomUUID()
  while (true) {
    signal.throwIfAborted()
    try {
      const handle = await open(path, 'wx', 0o600)
      try {
        await handle.writeFile(JSON.stringify({ version: 1, pid: process.pid, token }), 'utf8')
        await handle.sync()
      } finally {
        await handle.close()
      }
      return token
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      const owner = await readLock(path)
      if (owner === undefined || !processAlive(owner.pid)) {
        await rm(path, { force: true })
        continue
      }
      await abortableDelay(20, signal)
    }
  }
}

async function releaseFileLock(path: string, token: string): Promise<void> {
  const owner = await readLock(path)
  if (owner?.token === token) await rm(path, { force: true })
}

async function readLock(path: string): Promise<{ pid: number; token: string } | undefined> {
  try {
    const value = JSON.parse(await readFile(path, 'utf8')) as { pid?: unknown; token?: unknown }
    return typeof value.pid === 'number' && typeof value.token === 'string'
      ? { pid: value.pid, token: value.token }
      : undefined
  } catch {
    return undefined
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error: unknown) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

async function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const timer = setTimeout(done, milliseconds)
    const abort = (): void => {
      clearTimeout(timer)
      signal.removeEventListener('abort', abort)
      rejectPromise(signal.reason)
    }
    function done(): void {
      signal.removeEventListener('abort', abort)
      resolvePromise()
    }
    signal.addEventListener('abort', abort, { once: true })
  })
}

async function syncDirectory(path: string): Promise<void> {
  try {
    const handle = await open(path, 'r')
    try {
      await handle.sync()
    } finally {
      await handle.close()
    }
  } catch (error: unknown) {
    if (process.platform !== 'win32') throw error
  }
}
