import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { once } from 'node:events'
import { afterEach, describe, expect, it } from 'vitest'
import { honchoSessionId, type HonchoScope } from '@deepseek-honcho/dsh-honcho'
import { HonchoSdkRemote } from '../src/sdk-adapter.ts'

interface Call {
  method: string
  path: string
  authorization?: string
  body: unknown
}

const servers: ReturnType<typeof createServer>[] = []

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolvePromise, rejectPromise) => {
          server.closeAllConnections()
          server.close((error) => (error === undefined ? resolvePromise() : rejectPromise(error)))
        }),
    ),
  )
})

async function bodyOf(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(Buffer.from(chunk))
  const text = Buffer.concat(chunks).toString('utf8')
  return text.length === 0 ? undefined : JSON.parse(text)
}

function json(response: ServerResponse, value: unknown): void {
  response.writeHead(200, { 'content-type': 'application/json' })
  response.end(JSON.stringify(value))
}

async function fakeApi(): Promise<{ baseURL: string; calls: Call[] }> {
  const calls: Call[] = []
  const createdAt = '2026-08-21T00:00:00.000Z'
  const server = createServer(async (request, response) => {
    const path = new URL(request.url ?? '/', 'http://localhost').pathname
    const body = await bodyOf(request)
    calls.push({
      method: request.method ?? '',
      path,
      ...(request.headers.authorization === undefined ? {} : { authorization: request.headers.authorization }),
      body,
    })
    if (path === '/v3/workspaces')
      return json(response, { id: 'ws', metadata: {}, configuration: {}, created_at: createdAt })
    if (path.endsWith('/workspaces/list'))
      return json(response, {
        items: [{ id: 'ws', metadata: {}, configuration: {}, created_at: createdAt }],
        page: 1,
        size: 10,
        total: 1,
        pages: 1,
      })
    if (path.endsWith('/peers/list'))
      return json(response, {
        items: [{ id: 'human', workspace_id: 'ws', metadata: {}, configuration: {}, created_at: createdAt }],
        page: 1,
        size: 10,
        total: 1,
        pages: 1,
      })
    if (path.endsWith('/sessions/list'))
      return json(response, {
        items: [
          {
            id: honchoSessionId('root'),
            workspace_id: 'ws',
            is_active: true,
            metadata: {},
            configuration: {},
            created_at: createdAt,
          },
        ],
        page: 1,
        size: 10,
        total: 1,
        pages: 1,
      })
    if (path.endsWith('/peers'))
      return json(response, { id: 'human', workspace_id: 'ws', metadata: {}, configuration: {}, created_at: createdAt })
    if (path.endsWith('/sessions'))
      return json(response, {
        id: honchoSessionId('root'),
        workspace_id: 'ws',
        is_active: true,
        metadata: {},
        configuration: {},
        created_at: createdAt,
      })
    if (path.endsWith('/messages/list')) return json(response, { items: [], page: 1, size: 100, total: 0, pages: 0 })
    if (path.endsWith('/messages'))
      return json(response, [
        {
          id: 'message-1',
          content: 'synthetic',
          peer_id: 'human',
          session_id: honchoSessionId('root'),
          workspace_id: 'ws',
          metadata: { delivery_id: 'delivery' },
          created_at: createdAt,
          token_count: 1,
        },
      ])
    if (path.endsWith('/representation')) return json(response, { representation: 'synthetic representation' })
    if (path.endsWith('/search'))
      return json(response, [
        {
          id: 'old-source',
          content: 'obsolete synthetic result',
          peer_id: 'human',
          session_id: honchoSessionId('root'),
          workspace_id: 'ws',
          metadata: { project_id: 'project', human_peer_id: 'human', role: 'user' },
          created_at: createdAt,
          token_count: 1,
        },
        {
          id: 'correction-source',
          content: 'corrected synthetic result',
          peer_id: 'human',
          session_id: honchoSessionId('root'),
          workspace_id: 'ws',
          metadata: {
            project_id: 'project',
            human_peer_id: 'human',
            role: 'correction',
            supersedes: 'old-source',
            content_classification: 'experiment-card',
            remote_card_schema_version: 1,
            experiment_id: 'exp_wrong_role',
            artifact_id: 'art_wrong_role',
            query_fingerprint: 'a'.repeat(64),
            source_version: 'v1',
            source_label: 'synthetic',
            title: 'wrong role card',
            summary: 'must remain an ordinary correction',
            projection_revision: 1,
          },
          created_at: createdAt,
          token_count: 1,
        },
        {
          id: 'assistant-source',
          content: 'assistant-authored project decision',
          peer_id: 'assistant',
          session_id: honchoSessionId('root'),
          workspace_id: 'ws',
          metadata: {
            project_id: 'project',
            human_peer_id: 'human',
            role: 'experiment-card',
            content_classification: 'experiment-card',
            remote_card_schema_version: 1,
            experiment_id: 'exp_synthetic',
            artifact_id: 'art_synthetic',
            query_fingerprint: 'b'.repeat(64),
            source_version: 'v1',
            source_label: 'synthetic',
            title: 'synthetic experiment',
            summary: 'bounded synthetic result',
            projection_revision: 1,
          },
          created_at: createdAt,
          token_count: 1,
        },
      ])
    response.writeHead(404).end()
  })
  servers.push(server)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('fake server did not bind')
  return { baseURL: `http://127.0.0.1:${address.port}`, calls }
}

describe('@honcho-ai/sdk@2.3.0 exact adapter calls', () => {
  it('uses v3 scoped endpoints, metadata filters, project filters, and host-only authorization', async () => {
    const api = await fakeApi()
    const remote = new HonchoSdkRemote({
      apiKey: 'synthetic-sdk-key',
      baseURL: api.baseURL,
      workspaceId: 'ws',
      timeoutMs: 2_000,
      maxRetries: 0,
    })
    const scope: HonchoScope = {
      workspaceId: 'ws',
      userPeerId: 'human',
      assistantPeerId: 'assistant',
      projectId: 'project',
      dshSessionId: 'root',
      honchoSessionId: honchoSessionId('root'),
      agentKind: 'root',
    }
    expect(await remote.workspaceExists('ws')).toBe(true)
    expect(await remote.peerExists('human')).toBe(true)
    expect(await remote.sessionExists(scope.honchoSessionId)).toBe(true)
    await remote.ensurePeer('human', { source: 'deepseek-honcho' }, true)
    await remote.ensureSession(scope, false)
    await remote.findDelivery(scope.honchoSessionId, 'delivery')
    await remote.addMessages(scope.honchoSessionId, [
      {
        role: 'user',
        peerId: 'human',
        content: 'synthetic',
        createdAt: '2026-08-21T00:00:00.000Z',
        metadata: { delivery_id: 'delivery' },
      },
    ])
    expect(await remote.representation(scope, 'preference', 5)).toBe('synthetic representation')
    const search = await remote.search(scope, 'decision', 5)
    expect(search.map((item) => item.text)).toEqual([
      'corrected synthetic result',
      'assistant-authored project decision',
    ])
    expect(search[0]?.experimentCard).toBeUndefined()
    expect(search[1]?.experimentCard).toMatchObject({
      experimentId: 'exp_synthetic',
      artifactId: 'art_synthetic',
      projectId: 'project',
    })

    expect(api.calls.every((call) => call.authorization === 'Bearer synthetic-sdk-key')).toBe(true)
    expect(api.calls).toContainEqual(
      expect.objectContaining({
        path: `/v3/workspaces/ws/sessions/${scope.honchoSessionId}/messages/list`,
        body: { filters: { metadata: { delivery_id: 'delivery' } } },
      }),
    )
    expect(api.calls).toContainEqual(
      expect.objectContaining({
        path: '/v3/workspaces/ws/search',
        body: {
          query: 'decision',
          filters: { metadata: { project_id: 'project', human_peer_id: 'human' } },
          limit: 5,
        },
      }),
    )
    const sessionCreate = api.calls.find((call) => call.path === '/v3/workspaces/ws/sessions')
    expect(sessionCreate?.body).toMatchObject({
      metadata: { project_id: 'project', dsh_agent_kind: 'root' },
      peers: {
        human: { observe_me: true, observe_others: false },
        assistant: { observe_me: false, observe_others: true },
      },
    })
  })
})
