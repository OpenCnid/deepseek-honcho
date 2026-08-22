import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  HonchoMemoryError,
  honchoSessionId,
  type HonchoRecordRequest,
  type HonchoScope,
} from '@deepseek-honcho/dsh-honcho'
import {
  AtomicFileOutbox,
  DeliveryWorker,
  OutboxGenerationFence,
  messageFingerprint,
  retryDelay,
  type DeliveryWorkerConfig,
  type HonchoRemote,
  type RemoteMessage,
} from '../src/index.ts'

const temporaryRoots: string[] = []

afterEach(async () => {
  for (const root of temporaryRoots.splice(0)) {
    const safe = resolve(root)
    if (!safe.startsWith(resolve(tmpdir()))) throw new Error('refusing to remove a non-temporary test root')
    await rm(safe, { recursive: true, force: true })
  }
})

async function stateRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'deepseek-honcho-test-'))
  temporaryRoots.push(root)
  return root
}

function scope(session = 'dsh-session-1'): HonchoScope {
  return {
    workspaceId: 'ws',
    userPeerId: 'human',
    assistantPeerId: 'assistant',
    projectId: 'project',
    dshSessionId: session,
    honchoSessionId: honchoSessionId(session),
    agentKind: 'root',
  }
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function request(id: string, session = 'dsh-session-1', texts = ['hello']): HonchoRecordRequest {
  const deliveryId = digest(id)
  const target = scope(session)
  const createdAt = '2026-08-21T00:00:00.000Z'
  return {
    deliveryId,
    scope: target,
    messages: texts.map((content, index) => {
      const message = { role: 'user' as const, peerId: 'human', content, createdAt }
      return {
        ...message,
        metadata: {
          delivery_id: deliveryId,
          message_fingerprint: messageFingerprint(message),
          ordinal: index,
        },
      }
    }),
  }
}

class FakeRemote implements HonchoRemote {
  readonly stored = new Map<string, RemoteMessage[]>()
  readonly uploads: { sessionId: string; contents: string[] }[] = []
  addFailure: Error | undefined
  failAfterStore = false
  active = 0
  maximumActive = 0
  delay: (() => Promise<void>) | undefined

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
  async findDelivery(sessionId: string, deliveryId: string): Promise<readonly RemoteMessage[]> {
    return (this.stored.get(sessionId) ?? []).filter((message) => message.metadata.delivery_id === deliveryId)
  }
  async addMessages(
    sessionId: string,
    messages: readonly { content: string; metadata: Readonly<Record<string, unknown>> }[],
  ): Promise<readonly RemoteMessage[]> {
    this.active++
    this.maximumActive = Math.max(this.maximumActive, this.active)
    try {
      if (this.delay !== undefined) await this.delay()
      if (this.addFailure !== undefined && !this.failAfterStore) throw this.addFailure
      const prior = this.stored.get(sessionId) ?? []
      const added = messages.map((message, index) => ({
        id: `${sessionId}-${prior.length + index}`,
        metadata: message.metadata,
        content: message.content,
        sessionId,
      }))
      this.stored.set(sessionId, [...prior, ...added])
      this.uploads.push({ sessionId, contents: messages.map((message) => message.content) })
      if (this.addFailure !== undefined) throw this.addFailure
      return added
    } finally {
      this.active--
    }
  }
  async representation(): Promise<string> {
    return ''
  }
  async search(): Promise<[]> {
    return []
  }
}

const workerConfig: DeliveryWorkerConfig = {
  concurrency: 4,
  retryBaseMs: 10,
  retryMaxMs: 100,
  deadLetterAttempts: 3,
  circuitFailureThreshold: 3,
  circuitCooldownMs: 100,
  pollMs: 60_000,
}

describe('atomic file outbox', () => {
  it('persists a versioned document and recovers it after a new instance starts', async () => {
    const root = await stateRoot()
    const first = new AtomicFileOutbox(root)
    const item = request('atomic')
    expect(await first.enqueue(item)).toBe(true)
    expect(await first.enqueue(item)).toBe(false)
    const stored = JSON.parse(await readFile(join(root, 'outbox', 'pending', `${item.deliveryId}.json`), 'utf8')) as {
      version: number
    }
    expect(stored.version).toBe(1)
    const recovered = await new AtomicFileOutbox(root).listPending()
    expect(recovered).toHaveLength(1)
    expect(recovered[0]?.request.deliveryId).toBe(item.deliveryId)
  })

  it('admits one file when two generations concurrently enqueue the same delivery', async () => {
    const root = await stateRoot()
    const item = request('concurrent-admission')
    const outcomes = await Promise.all([
      new AtomicFileOutbox(root).enqueue(item),
      new AtomicFileOutbox(root).enqueue(item),
    ])
    expect(outcomes.sort()).toEqual([false, true])
    expect(await new AtomicFileOutbox(root).listPending()).toHaveLength(1)
  })

  it('persists monotonic admission order across same-millisecond writes and restart', async () => {
    const root = await stateRoot()
    const instant = new Date('2026-08-21T00:00:00.000Z')
    const first = new AtomicFileOutbox(root)
    await first.enqueue(request('order-z'), instant)
    await first.enqueue(request('order-a'), instant)
    const before = await first.listPending()
    expect(Date.parse(before[1]!.createdAt)).toBe(Date.parse(before[0]!.createdAt) + 1)
    const restarted = new AtomicFileOutbox(root)
    await restarted.enqueue(request('order-after-restart'), instant)
    const after = await restarted.listPending()
    expect(after.map((document) => Date.parse(document.createdAt))).toEqual([
      Date.parse(instant.toISOString()),
      Date.parse(instant.toISOString()) + 1,
      Date.parse(instant.toISOString()) + 2,
    ])
  })

  it('rejects relative roots and unsafe delivery names before touching disk', async () => {
    expect(() => new AtomicFileOutbox('relative')).toThrow(/absolute/)
    const outbox = new AtomicFileOutbox(await stateRoot())
    await expect(outbox.enqueue({ ...request('safe'), deliveryId: '../escape' })).rejects.toThrow(/SHA-256/)
  })

  it('rejects a symlink or Windows junction in the configured state path', async () => {
    const parent = await stateRoot()
    const target = await stateRoot()
    const linked = join(parent, 'linked-state')
    await symlink(target, linked, process.platform === 'win32' ? 'junction' : 'dir')
    await expect(new AtomicFileOutbox(linked).initialize()).rejects.toThrow(/symlink|reparse/)
  })
})

describe('retry schedule', () => {
  it('applies bounded exponential backoff and deterministic jitter', () => {
    expect(retryDelay(1, 100, 1_000, 0)).toBe(50)
    expect(retryDelay(2, 100, 1_000, 0.5)).toBe(200)
    expect(retryDelay(20, 100, 1_000, 1)).toBe(1_500)
  })
})

describe('delivery worker', () => {
  it('deduplicates a crash after remote success but before local acknowledgement', async () => {
    const outbox = new AtomicFileOutbox(await stateRoot())
    const item = request('ambiguous')
    await outbox.enqueue(item)
    const remote = new FakeRemote()
    remote.addFailure = new HonchoMemoryError('TRANSIENT', 'synthetic connection loss')
    remote.failAfterStore = true
    let now = Date.parse('2026-08-21T00:00:00.000Z')
    const worker = new DeliveryWorker(
      outbox,
      remote,
      workerConfig,
      async () => {},
      () => now,
      () => 0.5,
    )
    await worker.drainOnce()
    expect((await outbox.listPending())[0]).toMatchObject({ attempts: 1, ambiguous: true })
    remote.addFailure = undefined
    now += 100
    await worker.drainOnce()
    expect(await outbox.listPending()).toHaveLength(0)
    expect(remote.uploads).toHaveLength(1)
    expect(worker.metrics.duplicate).toBe(1)
  })

  it('uploads only missing fingerprints after a valid partial remote delivery', async () => {
    const outbox = new AtomicFileOutbox(await stateRoot())
    const item = request('partial', 'dsh-session-1', ['one', 'two'])
    await outbox.enqueue(item)
    const [document] = await outbox.listPending()
    if (document === undefined) throw new Error('missing fixture')
    await outbox.update({ ...document, attempts: 1, ambiguous: true })
    const remote = new FakeRemote()
    remote.stored.set(item.scope.honchoSessionId, [
      { id: 'existing', metadata: item.messages[0]?.metadata ?? {}, content: 'one' },
    ])
    const worker = new DeliveryWorker(outbox, remote, workerConfig, async () => {})
    await worker.drainOnce()
    expect(remote.uploads).toEqual([{ sessionId: item.scope.honchoSessionId, contents: ['two'] }])
    expect(await outbox.listPending()).toHaveLength(0)
  })

  it('dead-letters inconsistent partial delivery without persisting error content', async () => {
    const root = await stateRoot()
    const outbox = new AtomicFileOutbox(root)
    const item = request('inconsistent')
    await outbox.enqueue(item)
    const [document] = await outbox.listPending()
    if (document === undefined) throw new Error('missing fixture')
    await outbox.update({ ...document, attempts: 1, ambiguous: true })
    const remote = new FakeRemote()
    remote.stored.set(item.scope.honchoSessionId, [{ id: 'bad', metadata: { delivery_id: item.deliveryId } }])
    const worker = new DeliveryWorker(outbox, remote, workerConfig, async () => {})
    await worker.drainOnce()
    const dead = await readFile(join(root, 'outbox', 'dead-letter', `${item.deliveryId}.json`), 'utf8')
    expect(dead).toContain('PARTIAL_DELIVERY')
    expect(dead).not.toContain('synthetic connection')
  })

  it('opens the circuit on auth failure and avoids a hot retry loop', async () => {
    const outbox = new AtomicFileOutbox(await stateRoot())
    await outbox.enqueue(request('auth'))
    const remote = new FakeRemote()
    remote.addFailure = new HonchoMemoryError('AUTH', 'must never be persisted')
    const now = Date.parse('2026-08-21T00:00:00.000Z')
    const worker = new DeliveryWorker(
      outbox,
      remote,
      workerConfig,
      async () => {},
      () => now,
    )
    await worker.drainOnce()
    await worker.drainOnce()
    expect(worker.state().circuit).toBe('open')
    expect(remote.uploads).toHaveLength(0)
    expect((await outbox.listPending())[0]?.nextAttemptAt).toBe('2026-08-21T00:00:00.100Z')
  })

  it('runs different sessions concurrently while selecting only one head per session', async () => {
    const outbox = new AtomicFileOutbox(await stateRoot())
    await outbox.enqueue(request('a1', 'session-a'))
    await outbox.enqueue(request('a2', 'session-a'))
    await outbox.enqueue(request('b1', 'session-b'))
    const remote = new FakeRemote()
    let releaseRemote!: () => void
    const remoteGate = new Promise<void>((resolvePromise) => {
      releaseRemote = resolvePromise
    })
    remote.delay = async () => remoteGate
    const worker = new DeliveryWorker(outbox, remote, workerConfig, async () => {})
    const draining = worker.drainOnce()
    try {
      await expect.poll(() => remote.active).toBe(2)
    } finally {
      releaseRemote()
    }
    expect(await draining).toBe(2)
    expect(remote.maximumActive).toBe(2)
    expect(await outbox.listPending()).toHaveLength(1)
    await worker.drainOnce()
    expect(remote.uploads.filter((upload) => upload.sessionId === scope('session-a').honchoSessionId)).toHaveLength(2)
  })

  it('returns from bounded shutdown while an upload remains durable and in flight', async () => {
    const outbox = new AtomicFileOutbox(await stateRoot())
    await outbox.enqueue(request('bounded-shutdown'))
    const remote = new FakeRemote()
    let release = (): void => {}
    const gate = new Promise<void>((resolvePromise) => {
      release = resolvePromise
    })
    remote.delay = async () => gate
    const worker = new DeliveryWorker(outbox, remote, workerConfig, async () => {})
    const inFlight = worker.drainOnce()
    await expect.poll(() => remote.active).toBe(1)
    expect(await worker.stop(5)).toBe(false)
    expect(await outbox.listPending()).toHaveLength(1)
    release()
    await inFlight
    expect(await outbox.listPending()).toHaveLength(0)
  })

  it('dead-letters an exhausted transient delivery with a stable content-free code', async () => {
    const root = await stateRoot()
    const outbox = new AtomicFileOutbox(root)
    const item = request('retry-exhausted')
    await outbox.enqueue(item)
    const remote = new FakeRemote()
    remote.addFailure = new HonchoMemoryError('TRANSIENT', 'secret-shaped synthetic detail')
    let now = Date.parse('2026-08-21T00:00:00.000Z')
    const worker = new DeliveryWorker(
      outbox,
      remote,
      { ...workerConfig, deadLetterAttempts: 2 },
      async () => {},
      () => now,
      () => 0.5,
    )
    await worker.drainOnce()
    now += 10
    await worker.drainOnce()
    const dead = await readFile(join(root, 'outbox', 'dead-letter', `${item.deliveryId}.json`), 'utf8')
    expect(dead).toContain('RETRY_EXHAUSTED')
    expect(dead).not.toContain('secret-shaped synthetic detail')
  })
})

describe('HMR generation fence', () => {
  it('allows only one live worker and relinquishes ownership on disposal', async () => {
    const outbox = new AtomicFileOutbox(await stateRoot())
    await outbox.initialize()
    const first = new OutboxGenerationFence(outbox.outboxRoot)
    const second = new OutboxGenerationFence(outbox.outboxRoot)
    await first.acquire()
    await expect(second.acquire()).rejects.toThrow(/another live generation/)
    await first.release()
    await second.acquire()
    await second.release()
  })
})
