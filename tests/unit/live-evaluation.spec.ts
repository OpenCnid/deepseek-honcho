import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  assertNoSensitiveReportContent,
  finalizeCompletedLiveReports,
  validateManifestForCleanup,
  type LiveResourceManifest,
} from '../../scripts/live-evaluation.ts'

const roots: string[] = []

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

const corpus = {
  schemaVersion: 1,
  corpusId: 'synthetic-test',
  cases: [
    {
      id: 'case-one',
      category: 'preference',
      workspaceId: 'ws_alpha',
      userPeerId: 'peer_alex',
      projectId: 'project_red',
      setup: [
        {
          projectId: 'project_red',
          peerId: 'peer_alex',
          agentKind: 'root' as const,
          role: 'user' as const,
          text: 'synthetic private evaluation sentence',
        },
      ],
      query: 'synthetic private evaluation query',
      expect: {
        outcome: 'hit',
        mustContain: [],
        mustNotContain: [],
        normalCompletion: true,
        maxTokens: 100,
        maxLatencyMs: 1_500,
      },
    },
  ],
}

function manifest(): LiveResourceManifest {
  return {
    schemaVersion: 1,
    runId: 'run_123',
    createdAt: '2026-08-21T00:00:00.000Z',
    baseURL: 'https://api.honcho.dev',
    corpusSha256: 'a'.repeat(64),
    source: 'deepseek-honcho-live-evaluation',
    stateRoot: 'D:\\repo\\.deepseek-honcho\\live-evaluation\\run_123',
    workspaces: [
      { alias: 'ws_alpha', id: 'dsh_synthetic_eval_run_123_0', owned: true },
      { alias: 'ws_other', id: 'dsh_synthetic_eval_run_123_1', owned: true },
    ],
    reportPath: 'D:\\repo\\evaluation-results\\live-run_123.json',
    cleanup: { required: true, completed: false },
  }
}

describe('live evaluation safety fences', () => {
  it('allows only owned, run-prefixed synthetic workspaces to be cleaned', () => {
    expect(() => validateManifestForCleanup(manifest())).not.toThrow()
    expect(() =>
      validateManifestForCleanup({
        ...manifest(),
        workspaces: [
          { alias: 'ws_alpha', id: 'production', owned: true },
          { alias: 'ws_other', id: 'dsh_synthetic_eval_run_123_1', owned: true },
        ],
      }),
    ).toThrow(/ownership fence/)
    expect(() => validateManifestForCleanup({ ...manifest(), cleanup: { required: true, completed: true } })).toThrow(
      /already-cleaned/,
    )
  })

  it('rejects API keys and synthetic conversation text from persisted reports', () => {
    const apiKey = 'hch-synthetic-unit-key'
    expect(() =>
      assertNoSensitiveReportContent({ cases: [{ id: 'case-one', passed: true }] }, corpus, apiKey),
    ).not.toThrow()
    expect(() => assertNoSensitiveReportContent({ leaked: apiKey }, corpus, apiKey)).toThrow(/content-free/)
    expect(() =>
      assertNoSensitiveReportContent({ leaked: 'synthetic private evaluation sentence' }, corpus, apiKey),
    ).toThrow(/content-free/)
  })

  it('claims promotion only for a blocker-free aggregate after verified cleanup', async () => {
    const root = await mkdtemp(join(tmpdir(), 'deepseek-honcho-live-report-'))
    roots.push(root)
    const reportPath = join(root, 'live-run_123.json')
    const aggregatePath = join(root, 'live-run_123-aggregate.json')
    const manifestPath = join(root, 'manifest.json')
    const cleanup = {
      required: true,
      completed: true,
      submittedAt: '2026-08-21T00:00:01.000Z',
      verifiedAt: '2026-08-21T00:00:02.000Z',
    }
    await writeFile(manifestPath, JSON.stringify({ ...manifest(), reportPath, cleanup }), 'utf8')
    await writeFile(
      aggregatePath,
      JSON.stringify({
        mode: 'live-honcho-sdk-2.3.0-multi-attempt-aggregate',
        promotionClaimed: false,
        promotionBlockers: ['fenced remote cleanup not yet verified'],
        summary: {
          allCasesObservedPassing: true,
          leakageFailuresAcrossAttempts: 0,
          allNormalCompletions: true,
          allTokenBoundsPassed: true,
          allLatencyBoundsOrFailOpenPassed: true,
          memoryDisabledRequiredHitRate: 0,
          memoryEnabledRequiredHitRateBestAttempt: 1,
        },
        cleanup: { required: true, completed: false },
      }),
      'utf8',
    )
    await finalizeCompletedLiveReports(manifestPath)
    const finalized = JSON.parse(await readFile(aggregatePath, 'utf8')) as {
      promotionClaimed: boolean
      promotionBlockers: unknown[]
      cleanup: { completed: boolean }
    }
    expect(finalized).toMatchObject({
      promotionClaimed: true,
      promotionBlockers: [],
      cleanup: { completed: true },
    })
  })
})
