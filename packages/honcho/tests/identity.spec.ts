import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { describe, expect, it } from 'vitest'
import { classifyAgent, honchoSessionId, resolveHostScope, validateHonchoId } from '../src/index.ts'

function agent(
  id: string,
  header: { origin?: 'subagent'; delegationDepth?: number; parentSession?: string } = {},
): Agent {
  return { id, session: { header } } as unknown as Agent
}

describe('identity and scope mapping', () => {
  it('hashes the exact DSH session deterministically with an ID-safe base32 digest', () => {
    expect(honchoSessionId('session/one')).toBe(honchoSessionId('session/one'))
    expect(honchoSessionId('session/one')).not.toBe(honchoSessionId('session/two'))
    expect(honchoSessionId('session/one')).toMatch(/^dsh_[a-z2-7]{52}$/)
  })

  it('classifies root, child, and ordinary forks only from durable public fields', () => {
    expect(classifyAgent(agent('root'))).toBe('root')
    expect(classifyAgent(agent('fork', { parentSession: 'root' }))).toBe('root')
    expect(classifyAgent(agent('child', { origin: 'subagent', delegationDepth: 1 }))).toBe('child')
  })

  it('keeps identity host-controlled and validates exact IDs', () => {
    const scope = resolveHostScope(agent('dsh exact id'), {
      workspaceId: 'workspace_1',
      userPeerId: 'human_1',
      assistantPeerId: 'assistant_1',
      projectId: 'project_1',
    })
    expect(scope).toMatchObject({ userPeerId: 'human_1', projectId: 'project_1', dshSessionId: 'dsh exact id' })
    expect(() => validateHonchoId('workspaceId', 'display name@example.test')).toThrow(/must match/)
    expect(() => validateHonchoId('workspaceId', '')).toThrow(/must match/)
  })

  it('registers an in-memory provider as ctx.honcho without an SDK', async () => {
    const { FakeHonchoMemory } = await import('../src/testkit.ts')
    const ctx = new Context()
    await ctx.plugin(FakeHonchoMemory, { workspaceId: 'ws', userPeerId: 'human', projectId: 'project' })
    expect(ctx.honcho.status()).toMatchObject({ configured: true, circuit: 'closed' })
    await ctx.fiber.dispose()
  })
})
