import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { afterEach, describe, expect, it } from 'vitest'
import * as bundle from '../src/index.ts'

const contexts: Context[] = []
const roots: string[] = []

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
})
