import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

describe('Milestone 0 bootstrap', () => {
  it('pins the normative upstreams and synthetic corpus', async () => {
    const provenance = JSON.parse(
      await readFile(new URL('../../provenance/upstreams.json', import.meta.url), 'utf8'),
    ) as {
      upstreams: { name: string; revision: string; version?: string; copiedSource: boolean }[]
    }
    const corpus = JSON.parse(
      await readFile(new URL('../fixtures/evaluation-corpus.json', import.meta.url), 'utf8'),
    ) as {
      cases: { id: string }[]
    }
    expect(provenance.upstreams).toContainEqual(
      expect.objectContaining({ name: 'DeepSeek Harness', revision: '99f6f02fecdb7dff40c3fbc9470f5907c29f74ca' }),
    )
    expect(provenance.upstreams).toContainEqual(expect.objectContaining({ name: '@honcho-ai/sdk', version: '2.3.0' }))
    expect(provenance.upstreams.every((row) => !row.copiedSource)).toBe(true)
    expect(corpus.cases.map((entry) => entry.id)).toHaveLength(11)
  })
})
