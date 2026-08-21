import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

describe('Milestone 1 MCP experiment', () => {
  it('uses the pinned DSH MCP bridge and actual Honcho-qualified tool names', async () => {
    const profile = await readFile(new URL('../../examples/mcp/cordis.hosted.yml', import.meta.url), 'utf8')
    const skill = await readFile(new URL('../../skills/honcho-memory/SKILL.md', import.meta.url), 'utf8')
    expect(profile).toContain("name: '@deepseek-ai/dsh-mcp-client'")
    expect(profile).toContain('serverName: honcho')
    expect(profile).toContain('transport: streamable-http')
    expect(profile).not.toMatch(/Bearer\s+[A-Za-z0-9_-]{12,}/)
    for (const tool of [
      'mcp__honcho__get_representation',
      'mcp__honcho__search',
      'mcp__honcho__add_messages_to_session',
    ]) {
      expect(skill).toContain(tool)
    }
    expect(skill).toContain('Model compliance is not a delivery guarantee')
    expect(skill).toContain('do not poll')
  })
})
