/** In-memory provider for Consumer tests; never imports the Honcho SDK. */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import HonchoMemory, {
  type HonchoIdentityConfig,
  type HonchoAgentKind,
  type HonchoRecallItem,
  type HonchoRecallRequest,
  type HonchoRecallResult,
  type HonchoRecordRequest,
  type HonchoScope,
  type HonchoStatus,
  honchoSessionId,
  resolveHostScope,
  validateIdentity,
} from './index.ts'

export interface FakeHonchoOptions extends HonchoIdentityConfig {
  readonly recallItems?: readonly HonchoRecallItem[]
  readonly failure?: Error
}

export class FakeHonchoMemory extends HonchoMemory {
  readonly identity: Readonly<HonchoIdentityConfig>
  readonly records: HonchoRecordRequest[] = []
  readonly recallRequests: HonchoRecallRequest[] = []
  readonly searchRequests: HonchoRecallRequest[] = []
  readonly ensuredScopes: HonchoScope[] = []
  private readonly deliveries = new Set<string>()
  private readonly recallItems: readonly HonchoRecallItem[]
  private failure: Error | undefined

  constructor(ctx: Context, options: FakeHonchoOptions) {
    super(ctx)
    this.identity = validateIdentity(options)
    this.recallItems = options.recallItems ?? []
    this.failure = options.failure
  }

  setFailure(failure?: Error): void {
    this.failure = failure
  }

  resolveScope(agent: Agent): HonchoScope | undefined {
    return resolveHostScope(agent, this.identity)
  }

  scopeForSession(dshSessionId: string, agentKind: HonchoAgentKind): HonchoScope {
    return Object.freeze({
      ...this.identity,
      honchoSessionId: honchoSessionId(dshSessionId),
      dshSessionId,
      agentKind,
    })
  }

  async ensureScope(scope: HonchoScope, signal?: AbortSignal): Promise<void> {
    this.assertAvailable(signal)
    this.ensuredScopes.push(scope)
  }

  async record(request: HonchoRecordRequest): Promise<void> {
    this.assertAvailable(request.signal)
    if (this.deliveries.has(request.deliveryId)) return
    this.deliveries.add(request.deliveryId)
    this.records.push(request)
  }

  async recordNote(request: HonchoRecordRequest): Promise<void> {
    await this.record(request)
  }

  async recall(request: HonchoRecallRequest): Promise<HonchoRecallResult> {
    this.assertAvailable(request.signal)
    this.recallRequests.push(request)
    return this.result(request)
  }

  async search(request: HonchoRecallRequest): Promise<HonchoRecallResult> {
    this.assertAvailable(request.signal)
    this.searchRequests.push(request)
    return this.result(request)
  }

  status(): HonchoStatus {
    return { configured: true, circuit: this.failure === undefined ? 'closed' : 'open', pendingDeliveries: 0 }
  }

  private result(request: HonchoRecallRequest): HonchoRecallResult {
    let characters = 0
    let truncated = false
    const items: HonchoRecallItem[] = []
    for (const item of this.recallItems) {
      if (items.length >= request.maxItems) {
        truncated = true
        break
      }
      const remaining = request.maxCharacters - characters
      if (remaining <= 0) {
        truncated = true
        break
      }
      const text = item.text.slice(0, remaining)
      truncated ||= text.length < item.text.length
      items.push({ ...item, text })
      characters += text.length
    }
    return { items, truncated, durationMs: 0 }
  }

  private assertAvailable(signal?: AbortSignal): void {
    signal?.throwIfAborted()
    if (this.failure !== undefined) throw this.failure
  }
}

export default FakeHonchoMemory
