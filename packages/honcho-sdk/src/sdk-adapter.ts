import {
  AuthenticationError,
  BadRequestError,
  ConnectionError,
  Honcho,
  NotFoundError,
  PermissionDeniedError,
  RateLimitError,
  ServerError,
  TimeoutError,
  UnprocessableEntityError,
  type MessageInput,
} from '@honcho-ai/sdk'
import type { HonchoRecallItem, HonchoRecordMessage, HonchoScope } from '@deepseek-honcho/dsh-honcho'
import { HonchoMemoryError } from '@deepseek-honcho/dsh-honcho'

export interface RemoteMessage {
  readonly id: string
  readonly metadata: Readonly<Record<string, unknown>>
  readonly content?: string
  readonly sessionId?: string
  readonly createdAt?: string
}

/** Narrow host-only adapter used by the outbox worker and faked in tests. */
export interface HonchoRemote {
  workspaceExists(workspaceId: string): Promise<boolean>
  peerExists(peerId: string): Promise<boolean>
  sessionExists(sessionId: string): Promise<boolean>
  ensurePeer(peerId: string, metadata: Record<string, unknown>, observeMe: boolean): Promise<void>
  ensureSession(scope: HonchoScope, assistantObservation: boolean): Promise<void>
  findDelivery(sessionId: string, deliveryId: string): Promise<readonly RemoteMessage[]>
  addMessages(sessionId: string, messages: readonly HonchoRecordMessage[]): Promise<readonly RemoteMessage[]>
  representation(scope: HonchoScope, query: string, maxItems: number): Promise<string>
  search(scope: HonchoScope, query: string, maxItems: number): Promise<readonly HonchoRecallItem[]>
}

export interface SdkRemoteConfig {
  readonly apiKey: string
  readonly baseURL: string
  readonly workspaceId: string
  readonly timeoutMs: number
  readonly maxRetries: number
}

/** Exact @honcho-ai/sdk@2.3.0 adapter. No raw SDK object crosses this boundary. */
export class HonchoSdkRemote implements HonchoRemote {
  private readonly client: Honcho

  constructor(config: SdkRemoteConfig) {
    this.client = new Honcho({
      apiKey: config.apiKey,
      baseURL: config.baseURL,
      workspaceId: config.workspaceId,
      timeout: config.timeoutMs,
      maxRetries: config.maxRetries,
      defaultHeaders: { 'User-Agent': 'deepseek-honcho/0.1.0' },
    })
  }

  async workspaceExists(workspaceId: string): Promise<boolean> {
    const page = await this.client.workspaces({ filters: { id: workspaceId }, page: 1, size: 10 })
    return page.items.includes(workspaceId)
  }

  async peerExists(peerId: string): Promise<boolean> {
    const page = await this.client.peers({ filters: { id: peerId }, page: 1, size: 10 })
    return page.items.some((peer) => peer.id === peerId)
  }

  async sessionExists(sessionId: string): Promise<boolean> {
    const page = await this.client.sessions({ filters: { id: sessionId }, page: 1, size: 10 })
    return page.items.some((session) => session.id === sessionId)
  }

  async ensurePeer(peerId: string, metadata: Record<string, unknown>, observeMe: boolean): Promise<void> {
    await this.client.peer(peerId, { metadata, configuration: { observeMe } })
  }

  async ensureSession(scope: HonchoScope, assistantObservation: boolean): Promise<void> {
    const peers: [string, { observeMe: boolean; observeOthers: boolean }][] = [
      [scope.userPeerId, { observeMe: true, observeOthers: false }],
    ]
    if (scope.assistantPeerId !== undefined) {
      peers.push([scope.assistantPeerId, { observeMe: assistantObservation, observeOthers: true }])
    }
    await this.client.session(scope.honchoSessionId, {
      metadata: {
        source: 'deepseek-honcho',
        schema_version: 1,
        dsh_session_id: scope.dshSessionId,
        dsh_agent_kind: scope.agentKind,
        project_id: scope.projectId,
        plugin_version: '0.1.0',
      },
      peers,
    })
  }

  async findDelivery(sessionId: string, deliveryId: string): Promise<readonly RemoteMessage[]> {
    const session = await this.client.session(sessionId)
    const page = await session.messages({ filters: { metadata: { delivery_id: deliveryId } }, page: 1, size: 100 })
    return page.items.map((message) => ({
      id: message.id,
      metadata: message.metadata,
      content: message.content,
      sessionId: message.sessionId,
      createdAt: message.createdAt,
    }))
  }

  async addMessages(sessionId: string, messages: readonly HonchoRecordMessage[]): Promise<readonly RemoteMessage[]> {
    const session = await this.client.session(sessionId)
    const inputs: MessageInput[] = messages.map((message) => ({
      peerId: message.peerId,
      content: message.content,
      metadata: { ...message.metadata },
      createdAt: message.createdAt,
    }))
    const added = await session.addMessages(inputs)
    return added.map((message) => ({
      id: message.id,
      metadata: message.metadata,
      content: message.content,
      sessionId: message.sessionId,
      createdAt: message.createdAt,
    }))
  }

  async representation(scope: HonchoScope, query: string, maxItems: number): Promise<string> {
    const peer = await this.client.peer(scope.userPeerId)
    return peer.representation({ searchQuery: query, searchTopK: maxItems, maxConclusions: maxItems })
  }

  async search(scope: HonchoScope, query: string, maxItems: number): Promise<readonly HonchoRecallItem[]> {
    const messages = await this.client.search(query, {
      filters: { metadata: { project_id: scope.projectId, human_peer_id: scope.userPeerId } },
      limit: maxItems,
    })
    const superseded = new Set(
      messages
        .filter((message) => message.metadata.role === 'correction')
        .map((message) => message.metadata.supersedes)
        .filter((value): value is string => typeof value === 'string' && value.length > 0),
    )
    return messages
      .filter(
        (message) =>
          message.metadata.role === 'correction' || (!superseded.has(message.id) && !superseded.has(message.content)),
      )
      .map((message) => ({
        kind: 'message' as const,
        text: message.content,
        sourceId: message.id,
        sessionId: message.sessionId,
        createdAt: message.createdAt,
      }))
  }
}

export function classifySdkError(error: unknown): HonchoMemoryError {
  if (error instanceof HonchoMemoryError) return error
  if (error instanceof AuthenticationError) return new HonchoMemoryError('AUTH', 'Honcho authentication failed')
  if (error instanceof PermissionDeniedError) return new HonchoMemoryError('PERMISSION', 'Honcho permission denied')
  if (error instanceof TimeoutError) return new HonchoMemoryError('TIMEOUT', 'Honcho request timed out')
  if (error instanceof ConnectionError || error instanceof RateLimitError || error instanceof ServerError) {
    return new HonchoMemoryError('TRANSIENT', 'Honcho is temporarily unavailable')
  }
  if (error instanceof BadRequestError || error instanceof UnprocessableEntityError || error instanceof NotFoundError) {
    return new HonchoMemoryError('VALIDATION', 'Honcho rejected the scoped request')
  }
  return new HonchoMemoryError('TRANSIENT', 'Honcho request failed')
}
