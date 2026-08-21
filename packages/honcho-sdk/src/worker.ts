import { open, readFile, rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { HonchoMemoryError, type HonchoCircuitState, type HonchoRecordMessage } from '@deepseek-honcho/dsh-honcho'
import type { HonchoRemote } from './sdk-adapter.ts'
import { classifySdkError } from './sdk-adapter.ts'
import type { AtomicFileOutbox, OutboxDocument } from './outbox.ts'

export interface DeliveryWorkerConfig {
  readonly concurrency: number
  readonly retryBaseMs: number
  readonly retryMaxMs: number
  readonly deadLetterAttempts: number
  readonly circuitFailureThreshold: number
  readonly circuitCooldownMs: number
  readonly pollMs: number
}

export interface DeliveryWorkerMetrics {
  delivered: number
  retried: number
  deadLetter: number
  duplicate: number
  partial: number
  circuitTransitions: number
}

export interface DeliveryWorkerState {
  circuit: HonchoCircuitState
  lastSuccessAt?: string
  lastErrorCode?: string
  metrics: Readonly<DeliveryWorkerMetrics>
}

/** Exclusive worker-generation ownership, including across HMR and processes. */
export class OutboxGenerationFence {
  private readonly path: string
  private readonly token = randomUUID()
  private held = false

  constructor(outboxRoot: string) {
    this.path = resolve(outboxRoot, 'worker.lock')
  }

  async acquire(): Promise<void> {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const handle = await open(this.path, 'wx', 0o600)
        try {
          await handle.writeFile(JSON.stringify({ version: 1, pid: process.pid, token: this.token }), 'utf8')
          await handle.sync()
        } finally {
          await handle.close()
        }
        this.held = true
        return
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        const owner = await this.readOwner()
        if (owner !== undefined && processAlive(owner.pid)) {
          throw new HonchoMemoryError('INVALID_CONFIG', 'another live generation owns the outbox worker')
        }
        await rm(this.path, { force: true })
      }
    }
    throw new HonchoMemoryError('INVALID_CONFIG', 'could not acquire outbox worker fence')
  }

  async release(): Promise<void> {
    if (!this.held) return
    const owner = await this.readOwner()
    if (owner?.token === this.token) await rm(this.path, { force: true })
    this.held = false
  }

  private async readOwner(): Promise<{ pid: number; token: string } | undefined> {
    try {
      const parsed = JSON.parse(await readFile(this.path, 'utf8')) as { pid?: unknown; token?: unknown }
      if (typeof parsed.pid === 'number' && typeof parsed.token === 'string')
        return { pid: parsed.pid, token: parsed.token }
      return undefined
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      return undefined
    }
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

export class DeliveryWorker {
  readonly metrics: DeliveryWorkerMetrics = {
    delivered: 0,
    retried: 0,
    deadLetter: 0,
    duplicate: 0,
    partial: 0,
    circuitTransitions: 0,
  }
  private circuit: HonchoCircuitState = 'closed'
  private circuitOpenedUntil = 0
  private consecutiveFailures = 0
  private lastSuccessAt: string | undefined
  private lastErrorCode: string | undefined
  private timer: NodeJS.Timeout | undefined
  private stopped = false
  private running: Promise<void> | undefined

  constructor(
    private readonly outbox: AtomicFileOutbox,
    private readonly remote: HonchoRemote,
    private readonly config: DeliveryWorkerConfig,
    private readonly ensureScope: (document: OutboxDocument) => Promise<void>,
    private readonly now: () => number = Date.now,
    private readonly random: () => number = Math.random,
  ) {}

  start(): void {
    if (this.stopped || this.timer !== undefined) return
    this.schedule(0)
  }

  wake(): void {
    if (this.stopped) return
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = undefined
    this.schedule(0)
  }

  async drainOnce(): Promise<number> {
    if (this.running !== undefined) {
      await this.running
      return 0
    }
    let processed = 0
    this.running = (async () => {
      const documents = await this.outbox.listPending()
      const heads = new Map<string, OutboxDocument>()
      for (const document of documents) {
        const sessionId = document.request.scope.honchoSessionId
        if (!heads.has(sessionId)) heads.set(sessionId, document)
      }
      const eligible = [...heads.values()].filter((document) => {
        const next = document.nextAttemptAt === undefined ? 0 : Date.parse(document.nextAttemptAt)
        return next <= this.now()
      })
      for (let offset = 0; offset < eligible.length; offset += this.config.concurrency) {
        const batch = eligible.slice(offset, offset + this.config.concurrency)
        await Promise.all(batch.map(async (document) => this.process(document)))
        processed += batch.length
      }
    })()
    try {
      await this.running
    } finally {
      this.running = undefined
    }
    return processed
  }

  async drainUntil(deadlineMs: number): Promise<void> {
    while (this.now() < deadlineMs) {
      const processed = await this.drainOnce()
      if (processed === 0) return
    }
  }

  async stop(drainTimeoutMs: number): Promise<boolean> {
    this.stopped = true
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = undefined
    const deadline = this.now() + drainTimeoutMs
    await Promise.race([this.drainUntil(deadline), boundedWait(drainTimeoutMs)])
    return this.running === undefined
  }

  async whenIdle(): Promise<void> {
    if (this.running !== undefined) await this.running
  }

  state(): DeliveryWorkerState {
    return {
      circuit: this.currentCircuit(),
      ...(this.lastSuccessAt === undefined ? {} : { lastSuccessAt: this.lastSuccessAt }),
      ...(this.lastErrorCode === undefined ? {} : { lastErrorCode: this.lastErrorCode }),
      metrics: { ...this.metrics },
    }
  }

  private schedule(delay: number): void {
    if (this.stopped) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      void this.drainOnce().finally(() => this.schedule(this.config.pollMs))
    }, delay)
    this.timer.unref()
  }

  private currentCircuit(): HonchoCircuitState {
    if (this.circuit === 'open' && this.now() >= this.circuitOpenedUntil) {
      this.circuit = 'half-open'
      this.metrics.circuitTransitions++
    }
    return this.circuit
  }

  private async process(document: OutboxDocument): Promise<void> {
    if (this.currentCircuit() === 'open') return
    let current = document
    try {
      await this.ensureScope(document)
      let messages = [...document.request.messages]
      if (document.ambiguous || document.attempts > 0) {
        const existing = await this.remote.findDelivery(
          document.request.scope.honchoSessionId,
          document.request.deliveryId,
        )
        const expected = new Map(
          messages.map((message) => [String(message.metadata.message_fingerprint ?? ''), message] as const),
        )
        const remoteFingerprints = existing.map((message) => message.metadata.message_fingerprint)
        if (remoteFingerprints.some((fingerprint) => typeof fingerprint !== 'string' || !expected.has(fingerprint))) {
          this.metrics.partial++
          await this.outbox.deadLetter(document, 'PARTIAL_DELIVERY')
          this.metrics.deadLetter++
          return
        }
        for (const fingerprint of remoteFingerprints) expected.delete(String(fingerprint))
        if (expected.size === 0 && existing.length === messages.length) {
          await this.outbox.acknowledge(document.request.deliveryId)
          this.metrics.duplicate++
          this.markSuccess()
          return
        }
        messages = [...expected.values()]
      }

      const attempted: OutboxDocument = {
        ...document,
        attempts: document.attempts + 1,
        ambiguous: true,
        nextAttemptAt: new Date(this.now()).toISOString(),
      }
      await this.outbox.update(attempted)
      current = attempted
      if (messages.length > 0) {
        await this.remote.addMessages(document.request.scope.honchoSessionId, messages)
      }
      await this.outbox.acknowledge(document.request.deliveryId)
      this.metrics.delivered++
      this.markSuccess()
    } catch (error: unknown) {
      await this.handleFailure(current, classifySdkError(error))
    }
  }

  private async handleFailure(document: OutboxDocument, failure: HonchoMemoryError): Promise<void> {
    this.lastErrorCode = failure.code
    if (failure.code === 'VALIDATION' || failure.code === 'INVALID_SCOPE' || failure.code === 'INVALID_CONFIG') {
      await this.outbox.deadLetter(document, failure.code)
      this.metrics.deadLetter++
      return
    }
    const attempts = document.ambiguous ? document.attempts : document.attempts + 1
    if (attempts >= this.config.deadLetterAttempts && failure.code !== 'AUTH' && failure.code !== 'PERMISSION') {
      await this.outbox.deadLetter({ ...document, attempts, ambiguous: true }, 'RETRY_EXHAUSTED')
      this.metrics.deadLetter++
      return
    }
    this.consecutiveFailures++
    if (
      failure.code === 'AUTH' ||
      failure.code === 'PERMISSION' ||
      this.consecutiveFailures >= this.config.circuitFailureThreshold
    ) {
      if (this.circuit !== 'open') this.metrics.circuitTransitions++
      this.circuit = 'open'
      this.circuitOpenedUntil = this.now() + this.config.circuitCooldownMs
    }
    const delay =
      failure.code === 'AUTH' || failure.code === 'PERMISSION'
        ? this.config.circuitCooldownMs
        : retryDelay(attempts, this.config.retryBaseMs, this.config.retryMaxMs, this.random())
    await this.outbox.update({
      ...document,
      attempts,
      ambiguous: document.ambiguous,
      nextAttemptAt: new Date(this.now() + delay).toISOString(),
    })
    this.metrics.retried++
  }

  private markSuccess(): void {
    this.consecutiveFailures = 0
    if (this.circuit !== 'closed') this.metrics.circuitTransitions++
    this.circuit = 'closed'
    this.lastErrorCode = undefined
    this.lastSuccessAt = new Date(this.now()).toISOString()
  }
}

async function boundedWait(timeoutMs: number): Promise<void> {
  await new Promise<void>((resolvePromise) => {
    const timer = setTimeout(resolvePromise, timeoutMs)
    timer.unref()
  })
}

export function retryDelay(attempt: number, baseMs: number, maxMs: number, random: number): number {
  const exponential = Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt - 1))
  const jitter = 0.5 + Math.min(1, Math.max(0, random))
  return Math.max(1, Math.round(exponential * jitter))
}

export function messageFingerprint(
  message: Pick<HonchoRecordMessage, 'role' | 'peerId' | 'content' | 'createdAt'>,
): string {
  const stable = JSON.stringify([message.role, message.peerId, message.content, message.createdAt])
  return createDigest(stable)
}

function createDigest(value: string): string {
  // Kept local to avoid persisting or logging the input value.
  return requireSha256(value)
}

import { createHash } from 'node:crypto'
function requireSha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}
