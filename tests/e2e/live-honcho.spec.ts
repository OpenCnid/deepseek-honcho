import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterAll, describe, expect, it } from 'vitest'
import { honchoSessionId, type HonchoScope } from '../../packages/honcho/src/index.ts'
import { HonchoSdkMemory } from '../../packages/honcho-sdk/src/index.ts'

const enabled = process.env.HONCHO_LIVE_TEST === '1'
const roots: string[] = []
const contexts: Context[] = []

afterAll(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const root of roots.splice(0)) {
    if (!resolve(root).startsWith(resolve(tmpdir()))) throw new Error('unsafe live-test state root')
    await rm(root, { recursive: true, force: true })
  }
})

describe.skipIf(!enabled)('opt-in live Honcho smoke', () => {
  it('uses isolated synthetic identities and queues without exposing the key', async () => {
    const workspaceId = process.env.HONCHO_LIVE_WORKSPACE_ID
    if (workspaceId === undefined) throw new Error('HONCHO_LIVE_WORKSPACE_ID is required for the opt-in live test')
    const suffix = `${Date.now()}_${process.pid}`
    const root = await mkdtemp(join(tmpdir(), 'deepseek-honcho-live-'))
    roots.push(root)
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(HonchoSdkMemory, {
      apiKeyEnv: 'HONCHO_API_KEY',
      baseURL: process.env.HONCHO_BASE_URL ?? 'https://api.honcho.dev',
      workspaceId,
      userPeerId: `synthetic_human_${suffix}`,
      projectId: `synthetic_project_${suffix}`,
      stateRoot: root,
      workspaceAutoCreate: false,
    })
    const scope: HonchoScope = {
      workspaceId,
      userPeerId: `synthetic_human_${suffix}`,
      projectId: `synthetic_project_${suffix}`,
      dshSessionId: `synthetic_session_${suffix}`,
      honchoSessionId: honchoSessionId(`synthetic_session_${suffix}`),
      agentKind: 'root',
    }
    await ctx.honcho.ensureScope(scope)
    const deliveryId = 'a'.repeat(64)
    await ctx.honcho.record({
      deliveryId,
      scope,
      messages: [
        {
          role: 'user',
          peerId: scope.userPeerId,
          content: 'Synthetic live smoke memory.',
          createdAt: new Date().toISOString(),
          metadata: { delivery_id: deliveryId, project_id: scope.projectId },
        },
      ],
    })
    expect(ctx.honcho.status(scope).configured).toBe(true)
    expect(JSON.stringify(ctx.honcho.status(scope))).not.toContain(process.env.HONCHO_API_KEY)
  }, 30_000)
})
