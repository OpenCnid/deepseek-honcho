import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import { HonchoMemoryError, honchoSessionId, type HonchoScope } from '@deepseek-honcho/dsh-honcho'
import { HonchoSdkMemory, type HonchoRemote, type RemoteMessage } from '../src/index.ts'

const roots: string[] = []
const contexts: Context[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

class CapturingRemote implements HonchoRemote {
  uploaded: readonly { metadata: Readonly<Record<string, unknown>> }[] = []
  representationFailure: Error | undefined
  searchFailure: Error | undefined

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
  async addMessages(
    sessionId: string,
    messages: readonly { content: string; metadata: Readonly<Record<string, unknown>> }[],
  ): Promise<readonly RemoteMessage[]> {
    this.uploaded = messages
    return messages.map((message, index) => ({
      id: `message-${index}`,
      sessionId,
      content: message.content,
      metadata: message.metadata,
    }))
  }
  async representation(): Promise<string> {
    if (this.representationFailure !== undefined) throw this.representationFailure
    return 'synthetic representation'
  }
  async search(): Promise<readonly { kind: 'message'; text: string }[]> {
    if (this.searchFailure !== undefined) throw this.searchFailure
    return [{ kind: 'message', text: 'synthetic project search' }]
  }
}

describe('SDK provider scope metadata', () => {
  it('stamps the host-controlled human and project scope on assistant-authored messages', async () => {
    const root = await mkdtemp(join(tmpdir(), 'deepseek-honcho-provider-'))
    roots.push(root)
    const ctx = new Context()
    contexts.push(ctx)
    const remote = new CapturingRemote()
    const provider = new HonchoSdkMemory(
      ctx,
      {
        workspaceId: 'ws',
        userPeerId: 'human',
        assistantPeerId: 'assistant',
        projectId: 'project',
        stateRoot: root,
        pollMs: 60_000,
      },
      remote,
    )
    const scope: HonchoScope = {
      workspaceId: 'ws',
      userPeerId: 'human',
      assistantPeerId: 'assistant',
      projectId: 'project',
      dshSessionId: 'root',
      honchoSessionId: honchoSessionId('root'),
      agentKind: 'root',
    }
    const deliveryId = createHash('sha256').update('provider-scope').digest('hex')
    await provider.record({
      deliveryId,
      scope,
      messages: [
        {
          role: 'assistant',
          peerId: 'assistant',
          content: 'synthetic project decision',
          createdAt: '2026-08-21T00:00:00.000Z',
          metadata: {},
        },
      ],
    })
    await provider.drainOnce()
    expect(remote.uploaded[0]?.metadata).toMatchObject({
      human_peer_id: 'human',
      project_id: 'project',
      role: 'assistant',
    })
  })

  it('returns a bounded partial result when one recall path is asynchronously unavailable', async () => {
    const root = await mkdtemp(join(tmpdir(), 'deepseek-honcho-provider-'))
    roots.push(root)
    const ctx = new Context()
    contexts.push(ctx)
    const remote = new CapturingRemote()
    remote.representationFailure = new HonchoMemoryError('TRANSIENT', 'synthetic derivation lag')
    const provider = new HonchoSdkMemory(
      ctx,
      {
        workspaceId: 'ws',
        userPeerId: 'human',
        assistantPeerId: 'assistant',
        projectId: 'project',
        stateRoot: root,
        pollMs: 60_000,
      },
      remote,
    )
    const scope: HonchoScope = {
      workspaceId: 'ws',
      userPeerId: 'human',
      assistantPeerId: 'assistant',
      projectId: 'project',
      dshSessionId: 'partial',
      honchoSessionId: honchoSessionId('partial'),
      agentKind: 'root',
    }
    const result = await provider.recall({
      scope,
      query: 'synthetic query',
      includeUserRepresentation: true,
      projectOnly: true,
      maxItems: 5,
      maxCharacters: 1_000,
      signal: new AbortController().signal,
    })
    expect(result.items.map((item) => item.text)).toEqual(['synthetic project search'])
    expect(provider.status().lastErrorCode).toBe('TRANSIENT')
    expect(provider.status().circuit).toBe('closed')
  })
})
