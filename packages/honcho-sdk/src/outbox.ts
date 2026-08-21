import { randomUUID } from 'node:crypto'
import { chmod, link, lstat, mkdir, open, readdir, readFile, realpath, rename, rm, stat } from 'node:fs/promises'
import { dirname, isAbsolute, parse, relative, resolve, sep } from 'node:path'
import type { HonchoRecordRequest } from '@deepseek-honcho/dsh-honcho'
import { HonchoMemoryError } from '@deepseek-honcho/dsh-honcho'

export const OUTBOX_DOCUMENT_VERSION = 1
const DELIVERY_ID = /^[a-f0-9]{64}$/

export interface OutboxFailure {
  readonly code: string
  readonly at: string
}

export interface OutboxDocument {
  readonly version: typeof OUTBOX_DOCUMENT_VERSION
  readonly request: HonchoRecordRequest
  readonly createdAt: string
  readonly attempts: number
  readonly ambiguous: boolean
  readonly nextAttemptAt?: string
  readonly failure?: OutboxFailure
}

export interface OutboxCounts {
  readonly pending: number
  readonly oldestPendingAt?: string
  readonly deadLetter: number
}

function pathInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate)
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))
}

async function rejectLinks(target: string): Promise<void> {
  const absolute = resolve(target)
  const root = parse(absolute).root
  const pieces = absolute.slice(root.length).split(sep).filter(Boolean)
  let cursor = root
  for (const piece of pieces) {
    cursor = resolve(cursor, piece)
    try {
      const info = await lstat(cursor)
      if (info.isSymbolicLink())
        throw new HonchoMemoryError('INVALID_CONFIG', 'outbox path contains a symlink or reparse point')
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
  }
}

async function narrowDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 })
  try {
    await chmod(path, 0o700)
  } catch (error: unknown) {
    if (process.platform !== 'win32') throw error
  }
}

/** Cross-platform, dependency-free, one-document-per-delivery outbox. */
export class AtomicFileOutbox {
  readonly stateRoot: string
  readonly outboxRoot: string
  readonly pendingRoot: string
  readonly deadLetterRoot: string
  private initialized = false
  private lastAdmissionTime = 0

  constructor(stateRoot: string) {
    if (!isAbsolute(stateRoot)) throw new HonchoMemoryError('INVALID_CONFIG', 'outbox stateRoot must be absolute')
    const resolved = resolve(stateRoot)
    if (resolved === parse(resolved).root)
      throw new HonchoMemoryError('INVALID_CONFIG', 'outbox stateRoot must not be a filesystem root')
    this.stateRoot = resolved
    this.outboxRoot = resolve(resolved, 'outbox')
    this.pendingRoot = resolve(this.outboxRoot, 'pending')
    this.deadLetterRoot = resolve(this.outboxRoot, 'dead-letter')
    for (const target of [this.outboxRoot, this.pendingRoot, this.deadLetterRoot]) {
      if (!pathInside(this.stateRoot, target))
        throw new HonchoMemoryError('INVALID_CONFIG', 'outbox path escaped stateRoot')
    }
  }

  async initialize(): Promise<void> {
    if (this.initialized) return
    await rejectLinks(this.stateRoot)
    await narrowDirectory(this.stateRoot)
    await rejectLinks(this.stateRoot)
    await narrowDirectory(this.outboxRoot)
    await narrowDirectory(this.pendingRoot)
    await narrowDirectory(this.deadLetterRoot)
    const canonicalRoot = await realpath(this.stateRoot)
    for (const target of [this.outboxRoot, this.pendingRoot, this.deadLetterRoot]) {
      const canonical = await realpath(target)
      if (!pathInside(canonicalRoot, canonical))
        throw new HonchoMemoryError('INVALID_CONFIG', 'outbox canonical path escaped stateRoot')
    }
    for (const entry of await readdir(this.pendingRoot, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue
      try {
        const parsed = JSON.parse(await readFile(resolve(this.pendingRoot, entry.name), 'utf8')) as {
          createdAt?: unknown
        }
        if (typeof parsed.createdAt === 'string') {
          const value = Date.parse(parsed.createdAt)
          if (Number.isFinite(value)) this.lastAdmissionTime = Math.max(this.lastAdmissionTime, value)
        }
      } catch {
        // Invalid documents are quarantined by listPending(); do not trust them for ordering.
      }
    }
    this.initialized = true
  }

  async enqueue(request: HonchoRecordRequest, now = new Date()): Promise<boolean> {
    await this.initialize()
    this.assertDeliveryId(request.deliveryId)
    const destination = this.pendingPath(request.deliveryId)
    try {
      await stat(destination)
      return false
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    const admissionTime = Math.max(now.getTime(), this.lastAdmissionTime + 1)
    this.lastAdmissionTime = admissionTime
    const document: OutboxDocument = {
      version: OUTBOX_DOCUMENT_VERSION,
      request: cloneJson(request),
      createdAt: new Date(admissionTime).toISOString(),
      attempts: 0,
      ambiguous: false,
    }
    return this.atomicWrite(destination, document, true)
  }

  async listPending(): Promise<OutboxDocument[]> {
    await this.initialize()
    const entries = (await readdir(this.pendingRoot, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .sort((left, right) => left.name.localeCompare(right.name))
    const documents: OutboxDocument[] = []
    for (const entry of entries) {
      const id = entry.name.slice(0, -5)
      if (!DELIVERY_ID.test(id)) continue
      try {
        const parsed = JSON.parse(await readFile(resolve(this.pendingRoot, entry.name), 'utf8')) as unknown
        documents.push(validateDocument(parsed, id))
      } catch {
        await this.quarantineInvalid(id)
      }
    }
    return documents.sort(
      (left, right) =>
        left.createdAt.localeCompare(right.createdAt) ||
        left.request.deliveryId.localeCompare(right.request.deliveryId),
    )
  }

  async update(document: OutboxDocument): Promise<void> {
    await this.initialize()
    this.assertDeliveryId(document.request.deliveryId)
    await this.atomicWrite(this.pendingPath(document.request.deliveryId), document, false)
  }

  async acknowledge(deliveryId: string): Promise<void> {
    await this.initialize()
    this.assertDeliveryId(deliveryId)
    await rm(this.pendingPath(deliveryId), { force: true })
  }

  async deadLetter(document: OutboxDocument, code: string, now = new Date()): Promise<void> {
    await this.initialize()
    this.assertDeliveryId(document.request.deliveryId)
    const failed: OutboxDocument = { ...document, failure: { code, at: now.toISOString() } }
    const deadPath = this.deadPath(document.request.deliveryId)
    await this.atomicWrite(deadPath, failed, false)
    await rm(this.pendingPath(document.request.deliveryId), { force: true })
  }

  async counts(): Promise<OutboxCounts> {
    const pending = await this.listPending()
    const deadLetter = (await readdir(this.deadLetterRoot, { withFileTypes: true })).filter(
      (entry) => entry.isFile() && entry.name.endsWith('.json'),
    ).length
    return {
      pending: pending.length,
      ...(pending[0] === undefined ? {} : { oldestPendingAt: pending[0].createdAt }),
      deadLetter,
    }
  }

  private pendingPath(deliveryId: string): string {
    return this.safeChild(this.pendingRoot, `${deliveryId}.json`)
  }

  private deadPath(deliveryId: string): string {
    return this.safeChild(this.deadLetterRoot, `${deliveryId}.json`)
  }

  private safeChild(root: string, name: string): string {
    const candidate = resolve(root, name)
    if (!pathInside(root, candidate)) throw new HonchoMemoryError('INVALID_CONFIG', 'unsafe outbox path')
    return candidate
  }

  private assertDeliveryId(deliveryId: string): void {
    if (!DELIVERY_ID.test(deliveryId))
      throw new HonchoMemoryError('VALIDATION', 'deliveryId must be a lowercase SHA-256 digest')
  }

  private async atomicWrite(destination: string, document: OutboxDocument, exclusive: boolean): Promise<boolean> {
    const serialized = `${JSON.stringify(document)}\n`
    const temporary = resolve(
      dirname(destination),
      `.${document.request.deliveryId}.${process.pid}.${randomUUID()}.tmp`,
    )
    const handle = await open(temporary, 'wx', 0o600)
    try {
      await handle.writeFile(serialized, 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }
    try {
      if (exclusive) {
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
      } else {
        await rename(temporary, destination)
        await syncDirectory(dirname(destination))
        return true
      }
    } catch (error: unknown) {
      await rm(temporary, { force: true })
      throw error
    }
  }

  private async quarantineInvalid(deliveryId: string): Promise<void> {
    const source = this.pendingPath(deliveryId)
    const destination = this.safeChild(this.deadLetterRoot, `${deliveryId}.invalid.json`)
    try {
      await rename(source, destination)
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
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

function cloneJson<T>(value: T): T {
  const serialized = JSON.stringify(value)
  if (serialized === undefined) throw new HonchoMemoryError('VALIDATION', 'outbox request is not JSON serializable')
  return JSON.parse(serialized) as T
}

function validateDocument(value: unknown, expectedId: string): OutboxDocument {
  if (typeof value !== 'object' || value === null) throw new Error('not an object')
  const row = value as Partial<OutboxDocument>
  if (
    row.version !== OUTBOX_DOCUMENT_VERSION ||
    typeof row.createdAt !== 'string' ||
    !Number.isSafeInteger(row.attempts) ||
    (row.attempts ?? -1) < 0 ||
    typeof row.ambiguous !== 'boolean' ||
    typeof row.request !== 'object' ||
    row.request === null ||
    row.request.deliveryId !== expectedId
  ) {
    throw new Error('invalid outbox document')
  }
  return row as OutboxDocument
}
