import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { afterEach, describe, expect, it } from 'vitest'
import { ARTIFACT_TOOL_NAMES } from '../../artifact-memory/src/index.ts'
import { MEMORY_TOOL_NAMES } from '../../tool-memory/src/index.ts'
import * as bundle from '../src/index.ts'

const contexts: Context[] = []
const roots: string[] = []

function agent(id: string): Agent {
  return { id, session: { header: {} } } as unknown as Agent
}

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const root of roots.splice(0)) {
    if (!resolve(root).startsWith(resolve(tmpdir()))) throw new Error('unsafe temporary path')
    await rm(root, { recursive: true, force: true })
  }
})

describe('native bundle composition', () => {
  it('retains a Loader-visible schema and defaults automatic memory modes off', async () => {
    expect(bundle.Config).toBeDefined()
    expect('default' in bundle).toBe(false)
    const root = await mkdtemp(join(tmpdir(), 'deepseek-honcho-bundle-'))
    roots.push(root)
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    process.env.DEEPSEEK_HONCHO_SYNTHETIC_KEY = 'synthetic-not-a-real-key'
    try {
      await ctx.plugin(bundle, {
        provider: {
          apiKeyEnv: 'DEEPSEEK_HONCHO_SYNTHETIC_KEY',
          baseURL: 'http://127.0.0.1:9',
          workspaceId: 'ws',
          userPeerId: 'human',
          projectId: 'project',
          stateRoot: root,
          pollMs: 60_000,
        },
        tools: false,
      })
      expect(ctx.honcho.status()).toMatchObject({ configured: true, pendingDeliveries: 0 })
    } finally {
      delete process.env.DEEPSEEK_HONCHO_SYNTHETIC_KEY
    }
  })

  it('preserves exactly the original five tools when artifact memory is absent or disabled', async () => {
    for (const artifactMemory of [undefined, false] as const) {
      const root = await mkdtemp(join(tmpdir(), 'deepseek-honcho-bundle-disabled-'))
      roots.push(root)
      const ctx = new Context()
      contexts.push(ctx)
      await ctx.plugin(SystemPrompt)
      await ctx.plugin(ToolRuntime)
      process.env.DEEPSEEK_HONCHO_SYNTHETIC_KEY = 'synthetic-not-a-real-key'
      try {
        await ctx.plugin(bundle, {
          provider: {
            apiKeyEnv: 'DEEPSEEK_HONCHO_SYNTHETIC_KEY',
            baseURL: 'http://127.0.0.1:9',
            workspaceId: 'ws',
            userPeerId: 'human',
            projectId: 'project',
            stateRoot: join(root, 'honcho-state'),
            pollMs: 60_000,
          },
          ...(artifactMemory === undefined ? {} : { artifactMemory }),
        })
        expect(
          ctx.tools
            .schemas(agent(`disabled-${String(artifactMemory)}`))
            .map((tool) => tool.name)
            .sort(),
        ).toEqual([...MEMORY_TOOL_NAMES].sort())
        expect(ctx.get('artifactMemory')).toBeUndefined()
      } finally {
        delete process.env.DEEPSEEK_HONCHO_SYNTHETIC_KEY
      }
    }
  })

  it('composes the optional artifact service before search and exposes exactly seven tools when enabled', async () => {
    const root = await mkdtemp(join(tmpdir(), 'deepseek-honcho-bundle-enabled-'))
    roots.push(root)
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    process.env.DEEPSEEK_HONCHO_SYNTHETIC_KEY = 'synthetic-not-a-real-key'
    try {
      await ctx.plugin(bundle, {
        provider: {
          apiKeyEnv: 'DEEPSEEK_HONCHO_SYNTHETIC_KEY',
          baseURL: 'http://127.0.0.1:9',
          workspaceId: 'ws',
          userPeerId: 'human',
          assistantPeerId: 'assistant',
          projectId: 'project',
          stateRoot: join(root, 'honcho-state'),
          pollMs: 60_000,
        },
        artifactMemory: {
          enabled: true,
          artifactRoot: join(root, 'artifact-memory'),
          rlmArtifactRoot: join(root, 'rlm-artifacts'),
          recordTool: true,
          resolveTool: true,
          remoteIndexing: false,
        },
      })
      expect(ctx.get('artifactMemory')).toBeDefined()
      expect(
        ctx.tools
          .schemas(agent('enabled-session'))
          .map((tool) => tool.name)
          .sort(),
      ).toEqual([...MEMORY_TOOL_NAMES, ...ARTIFACT_TOOL_NAMES].sort())
    } finally {
      delete process.env.DEEPSEEK_HONCHO_SYNTHETIC_KEY
    }
  })
})
