/**
 * Exact @honcho-ai/sdk@2.3.0 provider, durable outbox, and delivery worker.
 * @module @deepseek-honcho/dsh-honcho-sdk
 */

import { isAbsolute } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import HonchoMemory, {
  HONCHO_PLUGIN_VERSION,
  HONCHO_SCHEMA_VERSION,
  HonchoMemoryError,
  type HonchoIdentityConfig,
  type HonchoRecallItem,
  type HonchoRecallRequest,
  type HonchoRecallResult,
  type HonchoRecordMessage,
  type HonchoRecordRequest,
  type HonchoScope,
  type HonchoStatus,
  honchoSessionId,
  resolveHostScope,
  validateIdentity,
} from '@deepseek-honcho/dsh-honcho'
import { AtomicFileOutbox } from './outbox.ts'
import { HonchoSdkRemote, classifySdkError, type HonchoRemote } from './sdk-adapter.ts'
import { DeliveryWorker, OutboxGenerationFence, messageFingerprint } from './worker.ts'

export { AtomicFileOutbox, OUTBOX_DOCUMENT_VERSION } from './outbox.ts'
export type { OutboxDocument, OutboxCounts } from './outbox.ts'
export { DeliveryWorker, OutboxGenerationFence, messageFingerprint, retryDelay } from './worker.ts'
export type { DeliveryWorkerConfig, DeliveryWorkerMetrics, DeliveryWorkerState } from './worker.ts'
export { HonchoSdkRemote, classifySdkError } from './sdk-adapter.ts'
export type { HonchoRemote, RemoteMessage, SdkRemoteConfig } from './sdk-adapter.ts'

export interface Config extends HonchoIdentityConfig {
  /** Name of the DSH host environment variable containing the key. The value itself is never configuration. */
  readonly apiKeyEnv?: string
  readonly baseURL?: string
  readonly timeoutMs?: number
  readonly maxRetries?: number
  readonly workspaceAutoCreate?: boolean
  readonly peerAutoCreate?: boolean
  readonly sessionAutoCreate?: boolean
  readonly assistantObservation?: boolean
  readonly stateRoot: string
  readonly concurrency?: number
  readonly drainTimeoutMs?: number
  readonly retryBaseMs?: number
  readonly retryMaxMs?: number
  readonly deadLetterAttempts?: number
  readonly circuitFailureThreshold?: number
  readonly circuitCooldownMs?: number
  readonly pollMs?: number
}

export const Config: z<Config> = z.object({
  apiKeyEnv: z.string().default('HONCHO_API_KEY'),
  baseURL: z.string().default('https://api.honcho.dev'),
  workspaceId: z.string().required(),
  userPeerId: z.string().required(),
  assistantPeerId: z.string(),
  projectId: z.string().required(),
  timeoutMs: z.number().step(1).min(1).default(10_000),
  maxRetries: z.number().step(1).min(0).default(2),
  workspaceAutoCreate: z.boolean().default(false),
  peerAutoCreate: z.boolean().default(true),
  sessionAutoCreate: z.boolean().default(true),
  assistantObservation: z.boolean().default(false),
  stateRoot: z.string().required(),
  concurrency: z.number().step(1).min(1).default(4),
  drainTimeoutMs: z.number().step(1).min(1).default(2_000),
  retryBaseMs: z.number().step(1).min(1).default(500),
  retryMaxMs: z.number().step(1).min(1).default(30_000),
  deadLetterAttempts: z.number().step(1).min(1).default(8),
  circuitFailureThreshold: z.number().step(1).min(1).default(3),
  circuitCooldownMs: z.number().step(1).min(1).default(30_000),
  pollMs: z.number().step(1).min(1).default(250),
})

interface ResolvedConfig extends Required<Omit<Config, 'assistantPeerId'>> {
  readonly assistantPeerId?: string
}

const defaults = {
  apiKeyEnv: 'HONCHO_API_KEY',
  baseURL: 'https://api.honcho.dev',
  timeoutMs: 10_000,
  maxRetries: 2,
  workspaceAutoCreate: false,
  peerAutoCreate: true,
  sessionAutoCreate: true,
  assistantObservation: false,
  concurrency: 4,
  drainTimeoutMs: 2_000,
  retryBaseMs: 500,
  retryMaxMs: 30_000,
  deadLetterAttempts: 8,
  circuitFailureThreshold: 3,
  circuitCooldownMs: 30_000,
  pollMs: 250,
} as const

/** Host-only Service Provider. `record()` resolves after local durability, never after remote upload. */
export class HonchoSdkMemory extends HonchoMemory {
  static Config = Config
  readonly config: Readonly<ResolvedConfig>
  readonly identity: Readonly<HonchoIdentityConfig>
  readonly outbox: AtomicFileOutbox
  private readonly remote: HonchoRemote
  private readonly worker: DeliveryWorker
  private readonly fence: OutboxGenerationFence
  private readonly ready: Promise<void>
  private readonly scopeReady = new Map<string, Promise<void>>()
  private workspaceReady: Promise<void> | undefined
  private stopped = false
  private pendingDeliveries = 0
  private oldestPendingAt: string | undefined
  private deadLetterCount = 0
  private recallCircuitUntil = 0
  private recallLastError: string | undefined

  constructor(ctx: Context, input: Config, testRemote?: HonchoRemote) {
    super(ctx)
    this.config = resolveConfig(input)
    this.identity = validateIdentity(this.config)
    this.outbox = new AtomicFileOutbox(this.config.stateRoot)
    const apiKey = process.env[this.config.apiKeyEnv]
    if (testRemote === undefined && (apiKey === undefined || apiKey.length === 0)) {
      throw new HonchoMemoryError(
        'INVALID_CONFIG',
        `required host environment variable ${this.config.apiKeyEnv} is empty`,
      )
    }
    this.remote =
      testRemote ??
      new HonchoSdkRemote({
        apiKey: apiKey ?? '',
        baseURL: this.config.baseURL,
        workspaceId: this.config.workspaceId,
        timeoutMs: this.config.timeoutMs,
        maxRetries: this.config.maxRetries,
      })
    this.fence = new OutboxGenerationFence(this.outbox.outboxRoot)
    this.worker = new DeliveryWorker(
      this.outbox,
      this.remote,
      {
        concurrency: this.config.concurrency,
        retryBaseMs: this.config.retryBaseMs,
        retryMaxMs: this.config.retryMaxMs,
        deadLetterAttempts: this.config.deadLetterAttempts,
        circuitFailureThreshold: this.config.circuitFailureThreshold,
        circuitCooldownMs: this.config.circuitCooldownMs,
        pollMs: this.config.pollMs,
      },
      async (document) => this.ensureScope(document.request.scope),
    )
    this.ready = this.initialize()
    ctx.effect(async () => {
      await this.ready
      return async () => this.disposeProvider()
    }, 'deepseek-honcho-sdk.lifecycle')
  }

  resolveScope(agent: Agent): HonchoScope | undefined {
    return resolveHostScope(agent, this.identity)
  }

  async ensureScope(scope: HonchoScope, signal?: AbortSignal): Promise<void> {
    await this.ready
    this.assertScope(scope)
    signal?.throwIfAborted()
    let operation = this.scopeReady.get(scope.honchoSessionId)
    if (operation === undefined) {
      operation = this.provisionScope(scope)
      this.scopeReady.set(scope.honchoSessionId, operation)
      void operation.catch(() => this.scopeReady.delete(scope.honchoSessionId))
    }
    await withAbort(operation, signal)
  }

  async record(request: HonchoRecordRequest): Promise<void> {
    if (this.stopped) throw new HonchoMemoryError('DISPOSED', 'Honcho provider is stopping')
    await this.ready
    const normalized = this.normalizeRequest(request)
    const added = await this.outbox.enqueue(normalized)
    if (added) {
      await this.refreshCounts()
      this.worker.wake()
    }
  }

  async recordNote(request: HonchoRecordRequest): Promise<void> {
    await this.record(request)
  }

  async recall(request: HonchoRecallRequest): Promise<HonchoRecallResult> {
    const started = Date.now()
    await this.prepareRead(request)
    try {
      const [representation, messages] = await Promise.all([
        request.includeUserRepresentation
          ? withAbort(this.remote.representation(request.scope, request.query, request.maxItems), request.signal)
          : Promise.resolve(''),
        withAbort(this.remote.search(request.scope, request.query, request.maxItems), request.signal),
      ])
      const items: HonchoRecallItem[] = [
        ...(representation.length === 0 ? [] : [{ kind: 'representation' as const, text: representation }]),
        ...messages,
      ]
      this.recallLastError = undefined
      return boundRecall(items, request.maxItems, request.maxCharacters, Date.now() - started)
    } catch (error: unknown) {
      this.noteReadFailure(error)
      throw classifySdkError(error)
    }
  }

  async search(request: HonchoRecallRequest): Promise<HonchoRecallResult> {
    const started = Date.now()
    await this.prepareRead(request)
    try {
      const items = await withAbort(this.remote.search(request.scope, request.query, request.maxItems), request.signal)
      this.recallLastError = undefined
      return boundRecall(items, request.maxItems, request.maxCharacters, Date.now() - started)
    } catch (error: unknown) {
      this.noteReadFailure(error)
      throw classifySdkError(error)
    }
  }

  status(): HonchoStatus {
    const worker = this.worker.state()
    const recallOpen = Date.now() < this.recallCircuitUntil
    void this.refreshCounts().catch(() => {})
    return {
      configured: true,
      circuit: recallOpen ? 'open' : worker.circuit,
      pendingDeliveries: this.pendingDeliveries,
      ...(this.oldestPendingAt === undefined ? {} : { oldestPendingAt: this.oldestPendingAt }),
      ...(worker.lastSuccessAt === undefined ? {} : { lastSuccessAt: worker.lastSuccessAt }),
      ...((this.recallLastError ?? worker.lastErrorCode) === undefined
        ? {}
        : { lastErrorCode: this.recallLastError ?? worker.lastErrorCode }),
      deliveredCount: worker.metrics.delivered,
      retriedCount: worker.metrics.retried,
      deadLetterCount: this.deadLetterCount,
      duplicateCount: worker.metrics.duplicate,
    }
  }

  /** Deterministic host/test drain; not model-facing. */
  async drainOnce(): Promise<number> {
    await this.ready
    const count = await this.worker.drainOnce()
    await this.refreshCounts()
    return count
  }

  private async initialize(): Promise<void> {
    await this.outbox.initialize()
    await this.fence.acquire()
    await this.refreshCounts()
    this.worker.start()
  }

  private async disposeProvider(): Promise<void> {
    if (this.stopped) return
    this.stopped = true
    const drained = await this.worker.stop(this.config.drainTimeoutMs)
    await this.refreshCounts()
    if (drained) await this.fence.release()
    else void this.worker.whenIdle().finally(() => this.fence.release())
  }

  private async provisionScope(scope: HonchoScope): Promise<void> {
    await this.ensureWorkspace()
    await this.ensurePeer(scope.userPeerId, 'user')
    if (scope.assistantPeerId !== undefined) await this.ensurePeer(scope.assistantPeerId, 'assistant')
    const exists = await this.remote.sessionExists(scope.honchoSessionId)
    if (!exists && !this.config.sessionAutoCreate) {
      throw new HonchoMemoryError('INVALID_SCOPE', 'configured Honcho session does not exist and auto-create is off')
    }
    await this.remote.ensureSession(scope, this.config.assistantObservation)
  }

  private async ensureWorkspace(): Promise<void> {
    this.workspaceReady ??= (async () => {
      const exists = await this.remote.workspaceExists(this.config.workspaceId)
      if (!exists && !this.config.workspaceAutoCreate) {
        throw new HonchoMemoryError(
          'INVALID_CONFIG',
          'configured Honcho workspace does not exist and auto-create is off',
        )
      }
    })()
    await this.workspaceReady
  }

  private async ensurePeer(peerId: string, kind: 'user' | 'assistant'): Promise<void> {
    const exists = await this.remote.peerExists(peerId)
    if (!exists && !this.config.peerAutoCreate) {
      throw new HonchoMemoryError('INVALID_SCOPE', 'configured Honcho peer does not exist and auto-create is off')
    }
    await this.remote.ensurePeer(
      peerId,
      {
        source: 'deepseek-honcho',
        schema_version: HONCHO_SCHEMA_VERSION,
        peer_kind: kind,
        plugin_version: HONCHO_PLUGIN_VERSION,
      },
      kind === 'user',
    )
  }

  private normalizeRequest(request: HonchoRecordRequest): HonchoRecordRequest {
    this.assertScope(request.scope)
    if (!/^[a-f0-9]{64}$/.test(request.deliveryId)) {
      throw new HonchoMemoryError('VALIDATION', 'deliveryId must be a lowercase SHA-256 digest')
    }
    if (request.messages.length === 0) throw new HonchoMemoryError('VALIDATION', 'a delivery must contain messages')
    const messages = request.messages.map((message) => this.normalizeMessage(request, message))
    return { deliveryId: request.deliveryId, scope: request.scope, messages }
  }

  private normalizeMessage(request: HonchoRecordRequest, message: HonchoRecordMessage): HonchoRecordMessage {
    if (message.content.length === 0 || !Number.isFinite(Date.parse(message.createdAt))) {
      throw new HonchoMemoryError('VALIDATION', 'message content and createdAt must be valid')
    }
    const expectedPeer =
      message.role === 'assistant' ||
      (request.scope.agentKind === 'child' && (message.role === 'memory-note' || message.role === 'correction'))
        ? request.scope.assistantPeerId
        : request.scope.userPeerId
    if (expectedPeer === undefined || message.peerId !== expectedPeer) {
      throw new HonchoMemoryError('INVALID_SCOPE', 'message sender is not the host-configured peer for its role')
    }
    if (request.scope.agentKind === 'child' && message.role === 'user') {
      throw new HonchoMemoryError('INVALID_SCOPE', 'child instructions cannot be authored by the configured human peer')
    }
    for (const key of Object.keys(message.metadata)) {
      if (/api.?key|authorization|credential|secret/i.test(key)) {
        throw new HonchoMemoryError('VALIDATION', 'message metadata contains a forbidden credential-shaped key')
      }
    }
    const fingerprint = messageFingerprint(message)
    return {
      ...message,
      metadata: {
        ...message.metadata,
        source: 'deepseek-honcho',
        schema_version: HONCHO_SCHEMA_VERSION,
        delivery_id: request.deliveryId,
        message_fingerprint: fingerprint,
        dsh_session_id: request.scope.dshSessionId,
        dsh_agent_kind: request.scope.agentKind,
        project_id: request.scope.projectId,
        role: message.role,
        plugin_version: HONCHO_PLUGIN_VERSION,
      },
    }
  }

  private assertScope(scope: HonchoScope): void {
    if (
      scope.workspaceId !== this.identity.workspaceId ||
      scope.userPeerId !== this.identity.userPeerId ||
      scope.assistantPeerId !== this.identity.assistantPeerId ||
      scope.projectId !== this.identity.projectId ||
      scope.honchoSessionId !== honchoSessionId(scope.dshSessionId)
    ) {
      throw new HonchoMemoryError('INVALID_SCOPE', 'scope does not match host-controlled identity')
    }
  }

  private async prepareRead(request: HonchoRecallRequest): Promise<void> {
    await this.ready
    this.assertScope(request.scope)
    request.signal.throwIfAborted()
    if (request.maxItems < 1 || request.maxCharacters < 1 || request.query.length === 0) {
      throw new HonchoMemoryError('VALIDATION', 'recall query and positive bounds are required')
    }
    if (Date.now() < this.recallCircuitUntil)
      throw new HonchoMemoryError('CIRCUIT_OPEN', 'Honcho recall circuit is open')
    await this.ensureScope(request.scope, request.signal)
  }

  private noteReadFailure(error: unknown): void {
    const classified = classifySdkError(error)
    this.recallLastError = classified.code
    this.recallCircuitUntil = Date.now() + this.config.circuitCooldownMs
  }

  private async refreshCounts(): Promise<void> {
    const counts = await this.outbox.counts()
    this.pendingDeliveries = counts.pending
    this.oldestPendingAt = counts.oldestPendingAt
    this.deadLetterCount = counts.deadLetter
  }
}

function resolveConfig(input: Config): ResolvedConfig {
  const config = { ...defaults, ...input }
  validateIdentity(config)
  if (!/^[A-Z_][A-Z0-9_]*$/.test(config.apiKeyEnv)) {
    throw new HonchoMemoryError('INVALID_CONFIG', 'apiKeyEnv must be an uppercase environment variable name')
  }
  let url: URL
  try {
    url = new URL(config.baseURL)
  } catch (error: unknown) {
    throw new HonchoMemoryError('INVALID_CONFIG', 'baseURL must be an absolute HTTP(S) URL', { cause: error })
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new HonchoMemoryError('INVALID_CONFIG', 'baseURL must use HTTP or HTTPS')
  }
  if (!isAbsolute(config.stateRoot)) throw new HonchoMemoryError('INVALID_CONFIG', 'stateRoot must be absolute')
  for (const key of [
    'timeoutMs',
    'maxRetries',
    'concurrency',
    'drainTimeoutMs',
    'retryBaseMs',
    'retryMaxMs',
    'deadLetterAttempts',
    'circuitFailureThreshold',
    'circuitCooldownMs',
    'pollMs',
  ] as const) {
    const value = config[key]
    if (!Number.isSafeInteger(value) || value < (key === 'maxRetries' ? 0 : 1)) {
      throw new HonchoMemoryError('INVALID_CONFIG', `${key} must be a positive safe integer`)
    }
  }
  if (config.retryBaseMs > config.retryMaxMs) {
    throw new HonchoMemoryError('INVALID_CONFIG', 'retryBaseMs must not exceed retryMaxMs')
  }
  return Object.freeze(config)
}

async function withAbort<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal === undefined) return operation
  signal.throwIfAborted()
  return new Promise<T>((resolvePromise, rejectPromise) => {
    const abort = (): void => rejectPromise(signal.reason)
    signal.addEventListener('abort', abort, { once: true })
    void operation.then(resolvePromise, rejectPromise).finally(() => signal.removeEventListener('abort', abort))
  })
}

function boundRecall(
  candidates: readonly HonchoRecallItem[],
  maxItems: number,
  maxCharacters: number,
  durationMs: number,
): HonchoRecallResult {
  const sorted = [...candidates].sort((left, right) => {
    const kind = kindRank(left.kind) - kindRank(right.kind)
    if (kind !== 0) return kind
    const score = (right.score ?? -1) - (left.score ?? -1)
    if (score !== 0) return score
    return (
      (left.createdAt ?? '').localeCompare(right.createdAt ?? '') ||
      (left.sourceId ?? '').localeCompare(right.sourceId ?? '')
    )
  })
  const items: HonchoRecallItem[] = []
  let characters = 0
  let truncated = false
  for (const candidate of sorted) {
    if (items.length >= maxItems || characters >= maxCharacters) {
      truncated = true
      break
    }
    const remaining = maxCharacters - characters
    const text = candidate.text.slice(0, remaining)
    truncated ||= text.length < candidate.text.length
    if (text.length > 0) items.push({ ...candidate, text })
    characters += text.length
  }
  return { items, truncated, durationMs }
}

function kindRank(kind: HonchoRecallItem['kind']): number {
  return kind === 'representation' ? 0 : kind === 'message' ? 1 : kind === 'conclusion' ? 2 : 3
}

export default HonchoSdkMemory
