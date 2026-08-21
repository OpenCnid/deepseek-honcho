import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import {
  createUserMessage,
  LlmAdapter,
  type GenerateOptions,
  type Message,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { afterEach, describe, expect, it } from 'vitest'
import { FakeHonchoMemory } from '../../packages/honcho/src/testkit.ts'
import { HonchoMemoryError } from '../../packages/honcho/src/index.ts'
import * as agentMemory from '../../packages/agent-memory/src/index.ts'

const contexts: Context[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
})

function textOf(message: Message): string {
  return message.content.map((block) => (block.type === 'text' ? block.text : '')).join('\n')
}

class EchoAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  constructor(private readonly response = 'assistant reply') {
    super()
  }
  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: this.response }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: this.response } }
    yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

class FailedAdapter extends LlmAdapter {
  async *stream(): AsyncIterable<StreamChunk> {
    yield {
      type: 'finish',
      reason: { kind: 'error', failure: { message: 'synthetic provider failure', code: 'SYNTHETIC' } },
    }
  }
}

async function harness(options?: { failure?: Error; capture?: boolean; recall?: boolean }) {
  const ctx = new Context()
  contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(FakeHonchoMemory, {
    workspaceId: 'ws',
    userPeerId: 'human',
    assistantPeerId: 'assistant',
    projectId: 'project',
    recallItems: [
      { kind: 'representation', text: 'The synthetic user prefers concise answers.' },
      { kind: 'message', text: 'The synthetic project selected SQLite.', sourceId: 'memory-1' },
    ],
    ...(options?.failure === undefined ? {} : { failure: options.failure }),
  })
  await ctx.plugin(agentMemory, {
    capture: options?.capture === false ? 'off' : 'completed-root-turns',
    recall: options?.recall === false ? 'off' : 'first-root-step',
  })
  await ctx.plugin(AgentLoop, { agents: [] })
  const adapter = new EchoAdapter()
  ctx.llm.registerAdapter(['mock'], adapter)
  return { ctx, adapter, honcho: ctx.honcho as FakeHonchoMemory }
}

async function settle(): Promise<void> {
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 0))
}

describe('real pinned DSH lifecycle integration', () => {
  it('injects once with plugin provenance and captures exactly one normalized root exchange without recapturing recall', async () => {
    const { ctx, adapter, honcho } = await harness()
    const handle = await ctx.agents.create({
      sessionId: SessionId('root-session'),
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    handle.agent.followup(
      createUserMessage({ content: [{ type: 'text', text: 'human prompt' }], source: { kind: 'user' } }),
    )
    await handle.agent.whenIdle()
    await settle()

    expect(adapter.requests).toHaveLength(1)
    expect(adapter.requests[0]?.messages.map(textOf).join('\n')).toContain('untrusted recalled context')
    const injected = handle.agent.session.events.filter(
      (event) =>
        event.type === 'user/message' &&
        event.data.source.kind === 'plugin' &&
        event.data.source.plugin === 'deepseek-honcho',
    )
    expect(injected).toHaveLength(1)
    expect(injected[0]?.type === 'user/message' ? injected[0].data.source : undefined).toMatchObject({
      kind: 'plugin',
      plugin: 'deepseek-honcho',
      form: 'recall',
    })
    expect(honcho.records).toHaveLength(1)
    expect(honcho.records[0]?.messages.map((message) => [message.role, message.content])).toEqual([
      ['user', 'human prompt'],
      ['assistant', 'assistant reply'],
    ])
    expect(honcho.records[0]?.messages.some((message) => message.content.includes('untrusted recalled'))).toBe(false)
    expect(honcho.records[0]?.scope.honchoSessionId).toMatch(/^dsh_[a-z2-7]{52}$/)
    await handle.dispose()
  })

  it('does not automatically capture or recall for a durable child session', async () => {
    const { ctx, adapter, honcho } = await harness()
    const handle = await ctx.agents.create({
      sessionId: SessionId('child-session'),
      meta: { origin: 'subagent', delegationDepth: 1, parentSession: SessionId('root-session') },
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    handle.agent.followup(
      createUserMessage({ content: [{ type: 'text', text: 'parent instruction' }], source: { kind: 'user' } }),
    )
    await handle.agent.whenIdle()
    await settle()

    expect(adapter.requests[0]?.messages.map(textOf).join('\n')).not.toContain('Honcho memory')
    expect(honcho.records).toHaveLength(0)
    expect(honcho.recallRequests).toHaveLength(0)
    await handle.dispose()
  })

  it('fails open when Honcho is unavailable and still commits the assistant response', async () => {
    const { ctx, adapter } = await harness({
      failure: new HonchoMemoryError('TRANSIENT', 'synthetic outage'),
      capture: false,
    })
    const handle = await ctx.agents.create({
      sessionId: SessionId('outage-session'),
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    handle.agent.followup(
      createUserMessage({ content: [{ type: 'text', text: 'continue normally' }], source: { kind: 'user' } }),
    )
    await handle.agent.whenIdle()

    expect(adapter.requests).toHaveLength(1)
    expect(handle.agent.session.events).toContainEqual(
      expect.objectContaining({ type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } }),
    )
    expect(handle.agent.session.deriveMessages().map(textOf).join('\n')).toContain('assistant reply')
    expect(handle.agent.session.deriveMessages().map(textOf).join('\n')).not.toContain('memory error')
    await handle.dispose()
  })

  it('does not capture an errored root turn', async () => {
    const { ctx, honcho } = await harness({ recall: false })
    ctx.llm.registerAdapter(['failed'], new FailedAdapter())
    const handle = await ctx.agents.create({
      sessionId: SessionId('failed-session'),
      agentOptions: { provider: 'failed', model: 'failed' },
    })
    handle.agent.followup(
      createUserMessage({ content: [{ type: 'text', text: 'must not become memory' }], source: { kind: 'user' } }),
    )
    await handle.agent.whenIdle()
    await settle()
    expect(handle.agent.session.events.findLast((event) => event.type === 'turn/end')).toMatchObject({
      data: { reason: { kind: 'error' } },
    })
    expect(honcho.records).toHaveLength(0)
    await handle.dispose()
  })

  it('correlates multiple turns and sessions without crossing delivery identity', async () => {
    const { ctx, honcho } = await harness({ recall: false })
    const first = await ctx.agents.create({
      sessionId: SessionId('multi-session-a'),
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    for (const prompt of ['first prompt', 'second prompt']) {
      first.agent.followup(createUserMessage({ content: [{ type: 'text', text: prompt }], source: { kind: 'user' } }))
      await first.agent.whenIdle()
      await settle()
    }
    const second = await ctx.agents.create({
      sessionId: SessionId('multi-session-b'),
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    second.agent.followup(
      createUserMessage({ content: [{ type: 'text', text: 'third prompt' }], source: { kind: 'user' } }),
    )
    await second.agent.whenIdle()
    await settle()

    expect(honcho.records).toHaveLength(3)
    expect(new Set(honcho.records.map((record) => record.deliveryId)).size).toBe(3)
    expect(honcho.records.map((record) => record.scope.dshSessionId)).toEqual([
      'multi-session-a',
      'multi-session-a',
      'multi-session-b',
    ])
    await first.dispose()
    await second.dispose()
  })
})
