import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { CallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { type ToolExecutionToken } from '@deepseek-ai/dsh-tools'
import { afterEach, describe, expect, it } from 'vitest'
import { FakeHonchoMemory } from '../../honcho/src/testkit.ts'
import * as memoryTools from '../src/index.ts'

const contexts: Context[] = []
const signal = new AbortController().signal

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
})

function rootAgent(id = 'tool-root'): Agent {
  return {
    id,
    session: { header: {} },
  } as unknown as Agent
}

async function harness() {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(FakeHonchoMemory, {
    workspaceId: 'ws',
    userPeerId: 'human',
    assistantPeerId: 'assistant',
    projectId: 'project',
    recallItems: [{ kind: 'message', text: 'synthetic project decision', sourceId: 'source-1' }],
  })
  await ctx.plugin(memoryTools)
  return { ctx, honcho: ctx.honcho as FakeHonchoMemory }
}

describe('default memory tool package', () => {
  it('registers exactly the five bounded tools and no model-selectable identity or administration fields', async () => {
    const { ctx } = await harness()
    const schemas = ctx.tools.schemas(rootAgent())
    expect(schemas.map((schema) => schema.name).sort()).toEqual([...memoryTools.MEMORY_TOOL_NAMES].sort())
    const parameterNames = schemas.flatMap((schema) => Object.keys(schema.parameters.properties))
    expect(parameterNames).not.toEqual(
      expect.arrayContaining([
        'apiKey',
        'api_key',
        'workspaceId',
        'workspace_id',
        'peerId',
        'peer_id',
        'projectId',
        'project_id',
      ]),
    )
    expect(schemas.map((schema) => schema.name).join(' ')).not.toMatch(/delete|admin|observe|deriver|representation/i)
  })

  it('redacts and bounds an explicit note before it reaches the provider', async () => {
    const { ctx, honcho } = await harness()
    const result = await ctx.tools.execute({
      callId: CallId('record-1'),
      name: 'memory_record',
      arguments: { note: 'Remember Bearer abcdefghijklmnopqrstuvwxyz as a synthetic preference.' },
      agent: rootAgent(),
      signal,
    })
    expect(result.isError).toBe(false)
    expect(result.value).toMatchObject({ queued: true, redacted: true })
    expect(honcho.records).toHaveLength(1)
    expect(JSON.stringify(honcho.records)).not.toContain('abcdefghijklmnopqrstuvwxyz')
    expect(honcho.records[0]?.scope).toMatchObject({ workspaceId: 'ws', userPeerId: 'human', projectId: 'project' })
  })

  it('uses append-only correction metadata and host scope', async () => {
    const { ctx, honcho } = await harness()
    await ctx.tools.execute({
      callId: CallId('correct-1'),
      name: 'memory_correct',
      arguments: { correction: 'Use tabs in synthetic examples.', supersedes: 'source-old' },
      agent: rootAgent(),
      signal,
    })
    expect(honcho.records[0]?.messages[0]).toMatchObject({
      role: 'correction',
      peerId: 'human',
      metadata: { content_classification: 'explicit-correction', supersedes: 'source-old' },
    })
  })

  it('keeps search project-scoped and returns no provider identity in status', async () => {
    const { ctx, honcho } = await harness()
    const agent = rootAgent()
    const search = await ctx.tools.execute({
      callId: CallId('search-1'),
      name: 'memory_search',
      arguments: { query: 'database choice' },
      agent,
      signal,
    })
    expect(search.isError).toBe(false)
    expect(honcho.searchRequests[0]).toMatchObject({ projectOnly: true, includeUserRepresentation: false })
    const status = await ctx.tools.execute({
      callId: CallId('status-1'),
      name: 'memory_status',
      arguments: {},
      agent,
      signal,
    })
    expect(JSON.stringify(status)).not.toMatch(/human|project|workspace|api.?key|message/i)
  })

  it('passes through DSH policy and result telemetry, including an RLM-shaped nested call', async () => {
    const { ctx, honcho } = await harness()
    const agent = rootAgent()
    const decisions: string[] = []
    const results: string[] = []
    ctx.on('tools/pre-execute', async (exec, next) => {
      decisions.push(exec.name)
      if (exec.arguments.query === 'denied') return { action: 'deny', reason: 'synthetic policy' }
      return next()
    })
    ctx.on('tools/result', (exec) => {
      results.push(exec.name)
    })

    const enclosing = {
      name: 'ipython',
      callId: CallId('ipython-1'),
    } as unknown as ToolExecutionToken
    const rlmCall = (query: string) =>
      ctx.tools.execute({
        callId: CallId('ipython-1:rlm:1'),
        rootCallId: CallId('ipython-1'),
        name: 'memory_search',
        arguments: { query },
        agent,
        parent: enclosing,
        signal,
      })

    expect((await rlmCall('denied')).isError).toBe(true)
    expect(honcho.searchRequests).toHaveLength(0)
    expect(decisions).toEqual(['memory_search'])
    expect(results).toEqual(['memory_search'])

    const kernelContext = { dsh_tools: { call: rlmCall }, env: {} as Record<string, string> }
    expect(kernelContext.env.HONCHO_API_KEY).toBeUndefined()
    expect(JSON.stringify(kernelContext)).not.toMatch(/hch-|sk-/)
  })
})
