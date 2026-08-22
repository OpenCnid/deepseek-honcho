import { randomUUID } from 'node:crypto'
import { open, readFile, rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import { HonchoMemoryError, type HonchoMemory, type HonchoScope } from '@deepseek-honcho/dsh-honcho'
import { ArtifactMemoryError } from './errors.ts'
import { projectExperimentCard, REMOTE_PROJECTION_DEFAULTS, type RemoteProjectionConfig } from './projection.ts'
import type { LocalArtifactStore } from './store.ts'
import type { ExperimentCardV1 } from './types.ts'

export interface ArtifactIndexerConfig extends RemoteProjectionConfig {
  readonly enabled: boolean
  readonly reconciliationIntervalMs: number
  readonly reconciliationBatchSize: number
  readonly reconciliationConcurrency: number
}

export type ArtifactIndexerInput = Partial<ArtifactIndexerConfig>

export interface ArtifactQueueResult {
  readonly honchoQueued: boolean
  readonly indexState: ExperimentCardV1['index']['state']
  readonly warningCode?: string
}

export const ARTIFACT_INDEXER_DEFAULTS: Readonly<ArtifactIndexerConfig> = Object.freeze({
  enabled: true,
  ...REMOTE_PROJECTION_DEFAULTS,
  reconciliationIntervalMs: 30_000,
  reconciliationBatchSize: 50,
  reconciliationConcurrency: 2,
})

/** Reuses the provider-neutral Honcho durable record path for sanitized cards. */
export class ArtifactCardIndexer {
  readonly config: Readonly<ArtifactIndexerConfig>
  private readonly fencePath: string
  private readonly fenceToken = randomUUID()
  private fenceHeld = false
  private active = true
  private timer: NodeJS.Timeout | undefined
  private running: Promise<number> | undefined
  private readonly controller = new AbortController()

  constructor(
    private readonly store: LocalArtifactStore,
    private readonly honcho: HonchoMemory,
    input: ArtifactIndexerInput = {},
  ) {
    this.config = resolveIndexerConfig(input)
    this.fencePath = resolve(store.layout.project, '.reconciler.lock')
  }

  async start(): Promise<void> {
    await this.store.initializeReady()
    if (!this.config.enabled || !this.active) return
    await this.reconcile()
    if (!this.active) return
    this.timer = setInterval(() => void this.reconcile(), this.config.reconciliationIntervalMs)
    this.timer.unref()
  }

  async dispose(): Promise<void> {
    if (!this.active) return
    this.active = false
    this.controller.abort(new ArtifactMemoryError('DISPOSED', 'artifact indexer is stopping'))
    if (this.timer !== undefined) clearInterval(this.timer)
    this.timer = undefined
    await this.running?.catch(() => {})
    if (this.fenceHeld) await releaseFence(this.fencePath, this.fenceToken)
    this.fenceHeld = false
  }

  async queueCard(
    card: ExperimentCardV1,
    scope?: HonchoScope,
    signal: AbortSignal = this.controller.signal,
  ): Promise<ArtifactQueueResult> {
    if (!this.config.enabled) {
      const disabled = await this.updateState(card, 'disabled', undefined, false)
      return { honchoQueued: false, indexState: disabled.index.state }
    }
    if (card.index.state === 'queued' || card.index.state === 'indexed') {
      return { honchoQueued: true, indexState: card.index.state }
    }
    const authoritativeScope = scope ?? this.honcho.scopeForSession(card.originSessionId, card.originAgentKind)
    this.assertScope(card, authoritativeScope)
    let projection
    try {
      projection = projectExperimentCard(card, authoritativeScope, this.config)
    } catch (error: unknown) {
      const code = safeErrorCode(error)
      const failed = await this.updateState(card, 'failed', code, true)
      return { honchoQueued: false, indexState: failed.index.state, warningCode: code }
    }
    try {
      signal.throwIfAborted()
      await this.honcho.recordNote({
        deliveryId: projection.deliveryId,
        scope: authoritativeScope,
        messages: [projection.message],
        signal,
      })
      if (!this.active) return { honchoQueued: false, indexState: card.index.state, warningCode: 'DISPOSED' }
      const queued = await this.updateState(card, 'queued', undefined, true)
      return { honchoQueued: true, indexState: queued.index.state }
    } catch (error: unknown) {
      const code = safeErrorCode(error)
      if (!this.active) return { honchoQueued: false, indexState: card.index.state, warningCode: 'DISPOSED' }
      const pending = await this.updateState(card, 'pending', code, true)
      return { honchoQueued: false, indexState: pending.index.state, warningCode: code }
    }
  }

  async reconcile(): Promise<number> {
    if (!this.active || !this.config.enabled) return 0
    if (this.running !== undefined) return this.running
    this.running = this.runReconciliation().finally(() => {
      this.running = undefined
    })
    return this.running
  }

  private async runReconciliation(): Promise<number> {
    if (!(await this.ensureFence())) return 0
    const eligible = this.store
      .cardsSnapshot()
      .filter((card) => card.index.state === 'pending' || card.index.state === 'failed')
      .sort(
        (left, right) =>
          left.updatedAt.localeCompare(right.updatedAt) || left.experimentId.localeCompare(right.experimentId),
      )
      .slice(0, this.config.reconciliationBatchSize)
    let processed = 0
    for (let offset = 0; offset < eligible.length; offset += this.config.reconciliationConcurrency) {
      if (!this.active || this.controller.signal.aborted) break
      const batch = eligible.slice(offset, offset + this.config.reconciliationConcurrency)
      await Promise.all(
        batch.map(async (card) => {
          await this.queueCard(card, undefined, this.controller.signal)
          processed += 1
        }),
      )
    }
    return processed
  }

  private async updateState(
    card: ExperimentCardV1,
    state: ExperimentCardV1['index']['state'],
    errorCode: string | undefined,
    countAttempt: boolean,
  ): Promise<ExperimentCardV1> {
    const current = await this.store.card(card.experimentId)
    if (current.index.projectionRevision !== card.index.projectionRevision || !this.active) return current
    const now = new Date().toISOString()
    const updated: ExperimentCardV1 = {
      ...current,
      updatedAt: now,
      index: {
        state,
        projectionRevision: current.index.projectionRevision,
        attempts: current.index.attempts + (countAttempt ? 1 : 0),
        ...(countAttempt ? { lastAttemptAt: now } : {}),
        ...(errorCode === undefined ? {} : { lastErrorCode: errorCode.slice(0, 80) }),
      },
    }
    return this.store.replaceCard(updated, current.index)
  }

  private assertScope(card: ExperimentCardV1, scope: HonchoScope): void {
    if (
      scope.projectId !== this.store.config.projectId ||
      scope.projectId !== card.projectId ||
      scope.dshSessionId !== card.originSessionId ||
      scope.agentKind !== card.originAgentKind ||
      scope.assistantPeerId === undefined
    ) {
      throw new ArtifactMemoryError('INVALID_SCOPE', 'Honcho scope does not match the local experiment card')
    }
  }

  private async ensureFence(): Promise<boolean> {
    if (this.fenceHeld) return true
    try {
      const handle = await open(this.fencePath, 'wx', 0o600)
      try {
        await handle.writeFile(JSON.stringify({ version: 1, pid: process.pid, token: this.fenceToken }), 'utf8')
        await handle.sync()
      } finally {
        await handle.close()
      }
      this.fenceHeld = true
      return true
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      const owner = await readFence(this.fencePath)
      if (owner !== undefined && processAlive(owner.pid)) return false
      await rm(this.fencePath, { force: true })
      return this.ensureFence()
    }
  }
}

function resolveIndexerConfig(input: ArtifactIndexerInput): Readonly<ArtifactIndexerConfig> {
  const config = { ...ARTIFACT_INDEXER_DEFAULTS, ...input }
  for (const key of [
    'maxCharacters',
    'maxBytes',
    'maxFieldCharacters',
    'reconciliationIntervalMs',
    'reconciliationBatchSize',
    'reconciliationConcurrency',
  ] as const) {
    if (!Number.isSafeInteger(config[key]) || config[key] < 1) {
      throw new ArtifactMemoryError('INVALID_CONFIG', `${key} must be a positive safe integer`)
    }
  }
  if (config.reconciliationConcurrency > config.reconciliationBatchSize) {
    throw new ArtifactMemoryError('INVALID_CONFIG', 'reconciliation concurrency must not exceed its batch size')
  }
  return Object.freeze(config)
}

function safeErrorCode(error: unknown): string {
  if (error instanceof ArtifactMemoryError || error instanceof HonchoMemoryError) return error.code
  if (error instanceof DOMException && error.name === 'AbortError') return 'ABORTED'
  return 'REMOTE_QUEUE_FAILED'
}

async function readFence(path: string): Promise<{ pid: number; token: string } | undefined> {
  try {
    const value = JSON.parse(await readFile(path, 'utf8')) as { pid?: unknown; token?: unknown }
    return typeof value.pid === 'number' && typeof value.token === 'string'
      ? { pid: value.pid, token: value.token }
      : undefined
  } catch {
    return undefined
  }
}

async function releaseFence(path: string, token: string): Promise<void> {
  const owner = await readFence(path)
  if (owner?.token === token) await rm(path, { force: true })
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error: unknown) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}
