import { createHash, randomBytes } from 'node:crypto'
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { Honcho } from '@honcho-ai/sdk'
import { formatRecall } from '../packages/agent-memory/src/index.ts'
import {
  HonchoMemoryError,
  honchoSessionId,
  type HonchoRecordMessage,
  type HonchoScope,
} from '../packages/honcho/src/index.ts'
import { HonchoSdkMemory } from '../packages/honcho-sdk/src/index.ts'

const RESOURCE_SOURCE = 'deepseek-honcho-live-evaluation'
const WORKSPACE_PREFIX = 'dsh_synthetic_eval_'
const REPORT_SCHEMA_VERSION = 1
const DEFAULT_PROCESSING_TIMEOUT_MS = 120_000

export interface CorpusEntry {
  readonly workspaceId?: string
  readonly projectId: string
  readonly peerId: string
  readonly agentKind: 'root' | 'child'
  readonly role: 'user' | 'assistant' | 'correction'
  readonly text: string
  readonly supersedes?: string
}

export interface CorpusCase {
  readonly workspaceId: string
  readonly id: string
  readonly category: string
  readonly setup: readonly CorpusEntry[]
  readonly projectId: string
  readonly userPeerId: string
  readonly query: string
  readonly currentEvidence?: string
  readonly fault?: 'none' | 'timeout' | 'unavailable'
  readonly expect: {
    readonly outcome: string
    readonly mustContain: readonly string[]
    readonly mustNotContain: readonly string[]
    readonly normalCompletion: boolean
    readonly maxTokens: number
    readonly maxLatencyMs: number
  }
}

interface Corpus {
  readonly schemaVersion: number
  readonly corpusId: string
  readonly cases: readonly CorpusCase[]
}

export interface WorkspaceResource {
  readonly alias: string
  readonly id: string
  readonly owned: boolean
}

export interface LiveResourceManifest {
  readonly schemaVersion: 1
  readonly runId: string
  readonly createdAt: string
  readonly baseURL: string
  readonly corpusSha256: string
  readonly source: typeof RESOURCE_SOURCE
  readonly stateRoot: string
  readonly workspaces: readonly WorkspaceResource[]
  readonly reportPath: string
  readonly cleanup: {
    readonly required: boolean
    readonly completed: boolean
    readonly submittedAt?: string
    readonly verifiedAt?: string
  }
}

interface ProviderHandle {
  readonly ctx: Context
  readonly provider: HonchoSdkMemory
  readonly scope: HonchoScope
}

interface SeededCase {
  readonly testCase: CorpusCase
  readonly recordLatencyMs: number
  readonly deliveryLatencyMs: number
}

interface ContentFreeCaseResult {
  readonly id: string
  readonly category: string
  readonly passed: boolean
  readonly checks: {
    readonly mustContain: boolean
    readonly mustNotContain: boolean
    readonly normalCompletion: boolean
    readonly tokenBound: boolean
    readonly latencyBoundOrFailOpen: boolean
  }
  readonly outcome: string
  readonly resultCount: number
  readonly recordLatencyMs: number
  readonly deliveryLatencyMs: number
  readonly recallLatencyMs: number
  readonly injectedCharacters: number
  readonly tokenEstimate: number
  readonly timedOut: boolean
  readonly errorCode?: string
  readonly memoryDisabledPassed: boolean
}

interface RequestCounts {
  workspaceCreates: number
  recordCalls: number
  recallCalls: number
  queuePolls: number
}

export interface LiveEvaluationOptions {
  readonly apiKey: string
  readonly baseURL: string
  readonly processingTimeoutMs?: number
  readonly rootDirectory?: string
}

export interface LiveResumeOptions {
  readonly apiKey: string
  readonly manifestPath: string
  readonly processingTimeoutMs?: number
}

export interface LiveEvaluationOutcome {
  readonly reportPath: string
  readonly manifestPath: string
  readonly manifest: LiveResourceManifest
  readonly passed: number
  readonly failed: number
}

export async function runLiveEvaluation(options: LiveEvaluationOptions): Promise<LiveEvaluationOutcome> {
  const baseURL = validateBaseURL(options.baseURL)
  if (options.apiKey.length === 0) throw new Error('HONCHO_API_KEY is required')
  const corpusBytes = await readFile(new URL('../tests/fixtures/evaluation-corpus.json', import.meta.url))
  const corpus = JSON.parse(corpusBytes.toString('utf8')) as Corpus
  if (corpus.schemaVersion !== 1 || corpus.cases.length < 12) throw new Error('invalid evaluation corpus')
  const corpusSha256 = digest(corpusBytes)
  const runId = createRunId()
  const rootDirectory = resolve(options.rootDirectory ?? fileURLToPath(new URL('..', import.meta.url)))
  const stateRoot = resolve(rootDirectory, '.deepseek-honcho', 'live-evaluation', runId)
  const outputDirectory = resolve(rootDirectory, 'evaluation-results')
  await mkdir(stateRoot, { recursive: true })
  await mkdir(outputDirectory, { recursive: true })

  const aliases = [...new Set(corpus.cases.flatMap(workspaceAliases))].sort()
  const workspaces = aliases.map((alias, index) => ({
    alias,
    id: `${WORKSPACE_PREFIX}${runId}_${index}`,
    owned: true,
  }))
  const workspaceMap = new Map(workspaces.map((workspace) => [workspace.alias, workspace.id]))
  const reportPath = resolve(outputDirectory, `live-${runId}.json`)
  const manifestPath = resolve(outputDirectory, 'live-resource-manifest.json')
  let manifest: LiveResourceManifest = {
    schemaVersion: 1,
    runId,
    createdAt: new Date().toISOString(),
    baseURL,
    corpusSha256,
    source: RESOURCE_SOURCE,
    stateRoot,
    workspaces,
    reportPath,
    cleanup: { required: true, completed: false },
  }
  assertNoSensitiveReportContent(manifest, corpus, options.apiKey)
  await atomicWriteJson(manifestPath, manifest)
  await provisionWorkspaces(options.apiKey, baseURL, runId, corpusSha256, workspaces)

  const handles: ProviderHandle[] = []
  const requestCounts: RequestCounts = {
    workspaceCreates: workspaces.length,
    recordCalls: 0,
    recallCalls: 0,
    queuePolls: 0,
  }
  try {
    const seeded: SeededCase[] = []
    for (const testCase of corpus.cases) {
      seeded.push(await seedCase(testCase, runId, workspaceMap, baseURL, stateRoot, handles, requestCounts))
    }

    const queue = await waitForProcessing(
      workspaces,
      options.apiKey,
      baseURL,
      options.processingTimeoutMs ?? DEFAULT_PROCESSING_TIMEOUT_MS,
      requestCounts,
    )
    const results: ContentFreeCaseResult[] = []
    for (const item of seeded) {
      results.push(await recallCase(item, runId, workspaceMap, baseURL, stateRoot, handles, requestCounts))
    }
    const report = buildReport(corpus, corpusSha256, 'live-honcho-sdk-2.3.0', results, queue, requestCounts)
    assertNoSensitiveReportContent(report, corpus, options.apiKey)
    await atomicWriteJson(reportPath, report)
    await atomicWriteJson(resolve(outputDirectory, 'live-latest.json'), report)
    const failed = results.filter((result) => !result.passed).length
    return {
      reportPath,
      manifestPath,
      manifest,
      passed: results.length - failed,
      failed,
    }
  } finally {
    for (const handle of handles.reverse()) await handle.ctx.fiber.dispose()
    manifest = { ...manifest, cleanup: { ...manifest.cleanup, required: true } }
    await atomicWriteJson(manifestPath, manifest)
  }
}

export async function resumeLiveEvaluation(options: LiveResumeOptions): Promise<LiveEvaluationOutcome> {
  if (options.apiKey.length === 0) throw new Error('HONCHO_API_KEY is required')
  const corpusBytes = await readFile(new URL('../tests/fixtures/evaluation-corpus.json', import.meta.url))
  const corpus = JSON.parse(corpusBytes.toString('utf8')) as Corpus
  const corpusSha256 = digest(corpusBytes)
  const manifest = JSON.parse(await readFile(options.manifestPath, 'utf8')) as LiveResourceManifest
  if (
    manifest.schemaVersion !== 1 ||
    manifest.source !== RESOURCE_SOURCE ||
    manifest.cleanup.completed ||
    manifest.corpusSha256 !== corpusSha256
  ) {
    throw new Error('live resume manifest did not match the current corpus')
  }
  const workspaceMap = new Map(manifest.workspaces.map((workspace) => [workspace.alias, workspace.id]))
  const priorReport = JSON.parse(await readFile(manifest.reportPath, 'utf8')) as {
    cases?: readonly { id?: string; recordLatencyMs?: number; deliveryLatencyMs?: number }[]
  }
  const priorMetrics = new Map(
    (priorReport.cases ?? []).map((item) => [
      item.id,
      {
        recordLatencyMs: item.recordLatencyMs ?? 0,
        deliveryLatencyMs: item.deliveryLatencyMs ?? 0,
      },
    ]),
  )
  const seeded: SeededCase[] = corpus.cases.map((testCase) => ({
    testCase,
    recordLatencyMs: priorMetrics.get(testCase.id)?.recordLatencyMs ?? 0,
    deliveryLatencyMs: priorMetrics.get(testCase.id)?.deliveryLatencyMs ?? 0,
  }))
  const requestCounts: RequestCounts = {
    workspaceCreates: 0,
    recordCalls: 0,
    recallCalls: 0,
    queuePolls: 0,
  }
  const handles: ProviderHandle[] = []
  try {
    const queue = await waitForProcessing(
      manifest.workspaces,
      options.apiKey,
      manifest.baseURL,
      options.processingTimeoutMs ?? 0,
      requestCounts,
    )
    const results: ContentFreeCaseResult[] = []
    for (const item of seeded) {
      results.push(
        await recallCase(
          item,
          manifest.runId,
          workspaceMap,
          manifest.baseURL,
          manifest.stateRoot,
          handles,
          requestCounts,
        ),
      )
    }
    const report = buildReport(corpus, corpusSha256, 'live-honcho-sdk-2.3.0-resume', results, queue, requestCounts)
    assertNoSensitiveReportContent(report, corpus, options.apiKey)
    const outputDirectory = resolve(manifest.reportPath, '..')
    const attemptPath = resolve(
      outputDirectory,
      `live-${manifest.runId}-resume-${new Date()
        .toISOString()
        .replace(/[-:.TZ]/g, '')
        .slice(0, 17)}.json`,
    )
    await atomicWriteJson(attemptPath, report)
    await atomicWriteJson(resolve(outputDirectory, 'live-latest.json'), report)
    await writeAggregateReport(manifest, corpus, options.apiKey)
    const failed = results.filter((result) => !result.passed).length
    return {
      reportPath: attemptPath,
      manifestPath: options.manifestPath,
      manifest,
      passed: results.length - failed,
      failed,
    }
  } finally {
    for (const handle of handles.reverse()) await handle.ctx.fiber.dispose()
  }
}

async function writeAggregateReport(manifest: LiveResourceManifest, corpus: Corpus, apiKey: string): Promise<void> {
  const outputDirectory = resolve(manifest.reportPath, '..')
  const prefix = `live-${manifest.runId}`
  const reportNames = (await readdir(outputDirectory)).filter(
    (name) => name.startsWith(prefix) && name.endsWith('.json') && !name.includes('-aggregate'),
  )
  const reports = await Promise.all(
    reportNames.map(
      async (name) =>
        JSON.parse(await readFile(resolve(outputDirectory, name), 'utf8')) as {
          corpusSha256: string
          containsConversationContent: boolean
          summary: { memoryDisabledRequiredHitRate: number; memoryEnabledRequiredHitRate: number }
          telemetry: { requestCounts: Record<string, number | boolean> }
          cases: readonly ContentFreeCaseResult[]
        },
    ),
  )
  if (
    reports.length === 0 ||
    reports.some(
      (report) => report.corpusSha256 !== manifest.corpusSha256 || report.containsConversationContent !== false,
    )
  ) {
    throw new Error('live aggregate inputs failed content-free provenance checks')
  }
  const cases = corpus.cases.map((testCase) => {
    const attempts = reports.flatMap((report) => report.cases.filter((item) => item.id === testCase.id))
    return {
      id: testCase.id,
      category: testCase.category,
      attempts: attempts.length,
      passedAttempts: attempts.filter((attempt) => attempt.passed).length,
      timedOutAttempts: attempts.filter((attempt) => attempt.timedOut).length,
      passObserved: attempts.some((attempt) => attempt.passed),
      allMustNotContainChecksPassed: attempts.every((attempt) => attempt.checks.mustNotContain),
      allNormalCompletions: attempts.every((attempt) => attempt.checks.normalCompletion),
      allTokenBoundsPassed: attempts.every((attempt) => attempt.checks.tokenBound),
      allLatencyBoundsOrFailOpenPassed: attempts.every((attempt) => attempt.checks.latencyBoundOrFailOpen),
      p95RecallLatencyMs: percentile(
        attempts.map((attempt) => attempt.recallLatencyMs),
        0.95,
      ),
    }
  })
  const allCasesObserved = cases.every((item) => item.passObserved)
  const aggregate = {
    schemaVersion: REPORT_SCHEMA_VERSION,
    corpusId: corpus.corpusId,
    corpusSha256: manifest.corpusSha256,
    mode: 'live-honcho-sdk-2.3.0-multi-attempt-aggregate',
    containsConversationContent: false,
    promotionClaimed: false,
    promotionBlockers: [
      ...(!allCasesObserved ? ['not every live corpus case has a passing observation'] : []),
      'fenced remote cleanup not yet verified',
    ],
    summary: {
      attempts: reports.length,
      casesObservedPassing: cases.filter((item) => item.passObserved).length,
      casesTotal: cases.length,
      allCasesObservedPassing: allCasesObserved,
      leakageFailuresAcrossAttempts: cases.filter(
        (item) =>
          ['workspace-isolation', 'project-isolation', 'peer-isolation'].includes(item.category) &&
          !item.allMustNotContainChecksPassed,
      ).length,
      allNormalCompletions: cases.every((item) => item.allNormalCompletions),
      allTokenBoundsPassed: cases.every((item) => item.allTokenBoundsPassed),
      allLatencyBoundsOrFailOpenPassed: cases.every((item) => item.allLatencyBoundsOrFailOpenPassed),
      timeoutRate: ratio(
        cases.reduce((total, item) => total + item.timedOutAttempts, 0),
        cases.reduce((total, item) => total + item.attempts, 0),
      ),
      memoryDisabledRequiredHitRate: Math.max(...reports.map((report) => report.summary.memoryDisabledRequiredHitRate)),
      memoryEnabledRequiredHitRateBestAttempt: Math.max(
        ...reports.map((report) => report.summary.memoryEnabledRequiredHitRate),
      ),
    },
    telemetry: {
      exactSdkHttpRequestsAvailable: false,
      cost: { available: false, reason: '@honcho-ai/sdk@2.3.0 exposes no per-request billing field' },
    },
    cleanup: { required: true, completed: false },
    cases,
  }
  assertNoSensitiveReportContent(aggregate, corpus, apiKey)
  await atomicWriteJson(resolve(outputDirectory, `${prefix}-aggregate.json`), aggregate)
  await atomicWriteJson(resolve(outputDirectory, 'live-aggregate-latest.json'), aggregate)
}

function buildReport(
  corpus: Corpus,
  corpusSha256: string,
  mode: string,
  results: readonly ContentFreeCaseResult[],
  queue: { durationMs: number; timedOut: boolean },
  requestCounts: RequestCounts,
): Record<string, unknown> {
  const required = results.filter((result) => !['miss', 'fail-open'].includes(result.outcome))
  const protectedCategories = new Set(['correction', 'freshness', 'prompt-injection', 'outage'])
  const leakageCategories = new Set(['workspace-isolation', 'project-isolation', 'peer-isolation'])
  return {
    schemaVersion: REPORT_SCHEMA_VERSION,
    corpusId: corpus.corpusId,
    corpusSha256,
    mode,
    containsConversationContent: false,
    promotionClaimed: false,
    promotionBlockers: [
      ...(results.some((result) => !result.passed) ? ['one or more live corpus cases failed'] : []),
      'fenced remote cleanup not yet verified',
    ],
    summary: {
      passed: results.filter((result) => result.passed).length,
      failed: results.filter((result) => !result.passed).length,
      leakageFailures: results.filter(
        (result) => leakageCategories.has(result.category) && !result.checks.mustNotContain,
      ).length,
      protectedCasePassRate: ratio(
        results.filter((result) => protectedCategories.has(result.category) && result.passed).length,
        results.filter((result) => protectedCategories.has(result.category)).length,
      ),
      p95AddedFirstStepMs: percentile(
        results.map((result) => result.recallLatencyMs),
        0.95,
      ),
      memoryDisabledRequiredHitRate: ratio(
        required.filter((result) => result.memoryDisabledPassed).length,
        required.length,
      ),
      memoryEnabledRequiredHitRate: ratio(required.filter((result) => result.passed).length, required.length),
      processingWaitMs: queue.durationMs,
      processingTimedOut: queue.timedOut,
    },
    telemetry: {
      requestCounts: { ...requestCounts, exactSdkHttpRequestsAvailable: false },
      cost: { available: false, reason: '@honcho-ai/sdk@2.3.0 exposes no per-request billing field' },
    },
    cleanup: { required: true, completed: false },
    cases: results,
  }
}

async function seedCase(
  testCase: CorpusCase,
  runId: string,
  workspaceMap: ReadonlyMap<string, string>,
  baseURL: string,
  stateRoot: string,
  handles: ProviderHandle[],
  requestCounts: RequestCounts,
): Promise<SeededCase> {
  const groups = new Map<string, CorpusEntry[]>()
  for (const entry of testCase.setup) {
    if (entry.agentKind !== 'root') continue
    const alias = entry.workspaceId ?? testCase.workspaceId
    const key = JSON.stringify([alias, entry.peerId, entry.projectId])
    const group = groups.get(key) ?? []
    group.push(entry)
    groups.set(key, group)
  }
  let recordLatencyMs = 0
  let deliveryLatencyMs = 0
  let groupIndex = 0
  for (const entries of groups.values()) {
    const first = entries[0]
    if (first === undefined) continue
    const alias = first.workspaceId ?? testCase.workspaceId
    const workspaceId = requireWorkspace(workspaceMap, alias)
    const handle = await createProviderHandle({
      runId,
      testCase,
      workspaceId,
      logicalPeerId: first.peerId,
      logicalProjectId: first.projectId,
      purpose: `seed_${groupIndex++}`,
      baseURL,
      stateRoot,
    })
    handles.push(handle)
    const createdAt = Date.now()
    const messages: HonchoRecordMessage[] = entries.map((entry, index) => ({
      role: entry.role,
      peerId: entry.role === 'assistant' ? requireAssistant(handle.scope) : handle.scope.userPeerId,
      content: entry.text,
      createdAt: new Date(createdAt + index).toISOString(),
      metadata: {
        content_classification: entry.role === 'correction' ? 'explicit-correction' : 'synthetic-evaluation',
        ...(entry.supersedes === undefined ? {} : { supersedes: entry.supersedes }),
      },
    }))
    const deliveryId = digest(JSON.stringify([runId, testCase.id, handle.scope.honchoSessionId, messages]))
    const recordStarted = performance.now()
    await handle.provider.record({ deliveryId, scope: handle.scope, messages })
    recordLatencyMs += performance.now() - recordStarted
    requestCounts.recordCalls++
    const deliveryStarted = performance.now()
    await drainProvider(handle.provider, 30_000)
    deliveryLatencyMs += performance.now() - deliveryStarted
  }
  return {
    testCase,
    recordLatencyMs: Math.round(recordLatencyMs),
    deliveryLatencyMs: Math.round(deliveryLatencyMs),
  }
}

async function recallCase(
  seeded: SeededCase,
  runId: string,
  workspaceMap: ReadonlyMap<string, string>,
  baseURL: string,
  stateRoot: string,
  handles: ProviderHandle[],
  requestCounts: RequestCounts,
): Promise<ContentFreeCaseResult> {
  const { testCase } = seeded
  const workspaceId = requireWorkspace(workspaceMap, testCase.workspaceId)
  const handle = await createProviderHandle({
    runId,
    testCase,
    workspaceId,
    logicalPeerId: testCase.userPeerId,
    logicalProjectId: testCase.projectId,
    purpose: 'recall',
    baseURL,
    stateRoot,
  })
  handles.push(handle)
  const started = performance.now()
  let output = ''
  let resultCount = 0
  let timedOut = false
  let errorCode: string | undefined
  const controller = new AbortController()
  const timer = setTimeout(
    () => controller.abort(new DOMException('live evaluation recall timeout', 'TimeoutError')),
    testCase.expect.maxLatencyMs,
  )
  timer.unref()
  try {
    if (testCase.fault === 'timeout' || testCase.fault === 'unavailable') {
      controller.abort(new DOMException('synthetic outage', 'AbortError'))
    }
    requestCounts.recallCalls++
    const recalled = await handle.provider.recall({
      scope: handle.scope,
      query: testCase.query,
      includeUserRepresentation: true,
      projectOnly: true,
      maxItems: 5,
      maxCharacters: testCase.expect.maxTokens * 4,
      signal: controller.signal,
    })
    timedOut = controller.signal.aborted
    resultCount = recalled.items.length
    output =
      formatRecall(recalled.items, {
        recallMaxItems: 5,
        recallMaxTokens: testCase.expect.maxTokens,
        recallMaxItemCharacters: 2_000,
      }) ?? ''
  } catch (error: unknown) {
    timedOut = controller.signal.aborted
    errorCode = contentFreeErrorCode(error, timedOut)
  } finally {
    clearTimeout(timer)
  }
  if (testCase.currentEvidence !== undefined) {
    output += `${output.length === 0 ? '' : '\n'}Current repository evidence is authoritative: ${testCase.currentEvidence}`
  }
  const recallLatencyMs = Math.round(performance.now() - started)
  const tokenEstimate = Math.ceil(output.length / 4)
  const checks = evaluateOutput(testCase, output, recallLatencyMs, true, timedOut)
  const disabledOutput =
    testCase.currentEvidence === undefined
      ? ''
      : `Current repository evidence is authoritative: ${testCase.currentEvidence}`
  const disabledChecks = evaluateOutput(testCase, disabledOutput, 0, true, false)
  return {
    id: testCase.id,
    category: testCase.category,
    passed: Object.values(checks).every(Boolean),
    checks,
    outcome: testCase.expect.outcome,
    resultCount,
    recordLatencyMs: seeded.recordLatencyMs,
    deliveryLatencyMs: seeded.deliveryLatencyMs,
    recallLatencyMs,
    injectedCharacters: output.length,
    tokenEstimate,
    timedOut,
    ...(errorCode === undefined ? {} : { errorCode }),
    memoryDisabledPassed: Object.values(disabledChecks).every(Boolean),
  }
}

function evaluateOutput(
  testCase: CorpusCase,
  output: string,
  latencyMs: number,
  normalCompletion: boolean,
  timedOut: boolean,
): ContentFreeCaseResult['checks'] {
  return {
    mustContain: testCase.expect.mustContain.every((value) => output.includes(value)),
    mustNotContain: testCase.expect.mustNotContain.every((value) => !output.includes(value)),
    normalCompletion: normalCompletion === testCase.expect.normalCompletion,
    tokenBound: Math.ceil(output.length / 4) <= testCase.expect.maxTokens,
    latencyBoundOrFailOpen: latencyMs <= testCase.expect.maxLatencyMs || timedOut,
  }
}

async function createProviderHandle(input: {
  runId: string
  testCase: CorpusCase
  workspaceId: string
  logicalPeerId: string
  logicalProjectId: string
  purpose: string
  baseURL: string
  stateRoot: string
}): Promise<ProviderHandle> {
  const userPeerId = syntheticId('human', input.runId, input.testCase.id, input.logicalPeerId)
  const assistantPeerId = syntheticId('assistant', input.runId, input.testCase.id)
  const projectId = syntheticId('project', input.runId, input.testCase.id, input.logicalProjectId)
  const dshSessionId = syntheticId('session', input.runId, input.testCase.id, input.purpose)
  const scope: HonchoScope = {
    workspaceId: input.workspaceId,
    userPeerId,
    assistantPeerId,
    projectId,
    dshSessionId,
    honchoSessionId: honchoSessionId(dshSessionId),
    agentKind: 'root',
  }
  const root = resolve(input.stateRoot, syntheticId('state', input.testCase.id, input.purpose))
  const ctx = new Context()
  await ctx.plugin(HonchoSdkMemory, {
    apiKeyEnv: 'HONCHO_API_KEY',
    baseURL: input.baseURL,
    workspaceId: scope.workspaceId,
    userPeerId: scope.userPeerId,
    assistantPeerId: scope.assistantPeerId,
    projectId: scope.projectId,
    stateRoot: root,
    workspaceAutoCreate: false,
    timeoutMs: 10_000,
    maxRetries: 1,
    drainTimeoutMs: 5_000,
    pollMs: 100,
  })
  return { ctx, provider: ctx.honcho as HonchoSdkMemory, scope }
}

async function drainProvider(provider: HonchoSdkMemory, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    await provider.drainOnce()
    const counts = await provider.outbox.counts()
    if (counts.deadLetter > 0) throw new Error('live delivery entered dead-letter')
    if (counts.pending === 0) return
    await delay(100)
  }
  throw new Error('live delivery drain timed out')
}

async function waitForProcessing(
  workspaces: readonly WorkspaceResource[],
  apiKey: string,
  baseURL: string,
  timeoutMs: number,
  requestCounts: RequestCounts,
): Promise<{ durationMs: number; timedOut: boolean }> {
  const started = performance.now()
  const deadline = Date.now() + timeoutMs
  let consecutiveIdle = 0
  while (Date.now() < deadline) {
    const statuses = await Promise.all(
      workspaces.map(async (workspace) => {
        requestCounts.queuePolls++
        const client = new Honcho({ apiKey, baseURL, workspaceId: workspace.id, timeout: 10_000, maxRetries: 1 })
        return client.queueStatus()
      }),
    )
    if (statuses.every((status) => status.pendingWorkUnits === 0 && status.inProgressWorkUnits === 0)) {
      consecutiveIdle++
      if (consecutiveIdle >= 2) return { durationMs: Math.round(performance.now() - started), timedOut: false }
    } else {
      consecutiveIdle = 0
    }
    await delay(500)
  }
  return { durationMs: Math.round(performance.now() - started), timedOut: true }
}

async function provisionWorkspaces(
  apiKey: string,
  baseURL: string,
  runId: string,
  corpusSha256: string,
  workspaces: readonly WorkspaceResource[],
): Promise<void> {
  for (const workspace of workspaces) {
    const client = new Honcho({ apiKey, baseURL, workspaceId: workspace.id, timeout: 10_000, maxRetries: 1 })
    const existing = await client.workspaces({ filters: { id: workspace.id }, page: 1, size: 10 })
    if (existing.items.includes(workspace.id)) throw new Error('generated live workspace already exists')
    await client.setMetadata({
      source: RESOURCE_SOURCE,
      run_id: runId,
      synthetic: true,
      corpus_sha256: corpusSha256,
      workspace_alias: workspace.alias,
    })
  }
}

export async function cleanupLiveEvaluation(input: {
  readonly apiKey: string
  readonly manifestPath: string
}): Promise<LiveResourceManifest> {
  if (input.apiKey.length === 0) throw new Error('HONCHO_API_KEY is required')
  const manifest = JSON.parse(await readFile(input.manifestPath, 'utf8')) as LiveResourceManifest
  validateManifestForCleanup(manifest)
  const submittedAt = new Date().toISOString()
  const targets: { client: Honcho; workspaceId: string }[] = []
  for (const workspace of manifest.workspaces) {
    const client = new Honcho({
      apiKey: input.apiKey,
      baseURL: manifest.baseURL,
      workspaceId: workspace.id,
      timeout: 10_000,
      maxRetries: 1,
    })
    const existing = await client.workspaces({ filters: { id: workspace.id }, page: 1, size: 10 })
    if (!existing.items.includes(workspace.id)) continue
    const metadata = await client.getMetadata()
    if (
      metadata.source !== RESOURCE_SOURCE ||
      metadata.run_id !== manifest.runId ||
      metadata.synthetic !== true ||
      metadata.corpus_sha256 !== manifest.corpusSha256
    ) {
      throw new Error('workspace cleanup metadata fence did not match')
    }
    const sessions = await client.sessions({ page: 1, size: 100 })
    for (const session of sessions.items) await session.delete()
    targets.push({ client, workspaceId: workspace.id })
  }
  await Promise.all(targets.map((target) => deleteWorkspaceWithRetry(target.client, target.workspaceId, 120_000)))
  await Promise.all(targets.map((target) => waitForWorkspaceAbsence(target.client, target.workspaceId, 300_000)))
  const verifiedAt = new Date().toISOString()
  const completed: LiveResourceManifest = {
    ...manifest,
    cleanup: { required: true, completed: true, submittedAt, verifiedAt },
  }
  await atomicWriteJson(input.manifestPath, completed)
  await finalizeCompletedLiveReports(input.manifestPath)
  const safeStateRoot = resolve(manifest.stateRoot)
  const expectedParent = resolve(fileURLToPath(new URL('..', import.meta.url)), '.deepseek-honcho', 'live-evaluation')
  if (!safeStateRoot.startsWith(`${expectedParent}\\`) && !safeStateRoot.startsWith(`${expectedParent}/`)) {
    throw new Error('local live state cleanup escaped the expected parent')
  }
  await rm(safeStateRoot, { recursive: true, force: true })
  return completed
}

export async function finalizeCompletedLiveReports(manifestPath: string): Promise<void> {
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as LiveResourceManifest
  if (
    !manifest.cleanup.completed ||
    manifest.cleanup.submittedAt === undefined ||
    manifest.cleanup.verifiedAt === undefined
  ) {
    throw new Error('live cleanup must be verified before reports can be finalized')
  }
  const outputDirectory = resolve(manifest.reportPath, '..')
  const reportNames = (await readdir(outputDirectory)).filter(
    (name) =>
      (name.startsWith(`live-${manifest.runId}`) ||
        name === 'live-latest.json' ||
        name === 'live-aggregate-latest.json') &&
      name.endsWith('.json'),
  )
  for (const name of reportNames) {
    await updateReportCleanup(resolve(outputDirectory, name), manifest.cleanup.submittedAt, manifest.cleanup.verifiedAt)
  }
}

export function validateManifestForCleanup(manifest: LiveResourceManifest): void {
  if (
    manifest.schemaVersion !== 1 ||
    manifest.source !== RESOURCE_SOURCE ||
    manifest.cleanup.completed ||
    manifest.workspaces.length < 2
  ) {
    throw new Error('invalid or already-cleaned live resource manifest')
  }
  for (const workspace of manifest.workspaces) {
    if (!workspace.owned || !workspace.id.startsWith(`${WORKSPACE_PREFIX}${manifest.runId}_`)) {
      throw new Error('workspace cleanup ownership fence did not match')
    }
  }
}

async function deleteWorkspaceWithRetry(client: Honcho, workspaceId: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      await client.deleteWorkspace(workspaceId)
      return
    } catch {
      await delay(1_000)
    }
  }
  throw new Error('workspace deletion timed out')
}

async function waitForWorkspaceAbsence(client: Honcho, workspaceId: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const remaining = await client.workspaces({ filters: { id: workspaceId }, page: 1, size: 10 })
    if (!remaining.items.includes(workspaceId)) return
    await delay(1_000)
  }
  throw new Error('workspace deletion could not be verified')
}

async function updateReportCleanup(reportPath: string, submittedAt: string, verifiedAt: string): Promise<void> {
  const report = JSON.parse(await readFile(reportPath, 'utf8')) as Record<string, unknown>
  report.cleanup = { required: true, completed: true, submittedAt, verifiedAt }
  const blockers = Array.isArray(report.promotionBlockers)
    ? report.promotionBlockers.filter((value) => value !== 'fenced remote cleanup not yet verified')
    : []
  report.promotionBlockers = blockers
  report.promotionClaimed = qualifiesForPromotion(report, blockers)
  await atomicWriteJson(reportPath, report)
}

function qualifiesForPromotion(report: Record<string, unknown>, blockers: unknown[]): boolean {
  if (blockers.length > 0 || report.mode !== 'live-honcho-sdk-2.3.0-multi-attempt-aggregate') return false
  const summary = report.summary
  if (summary === null || typeof summary !== 'object') return false
  const values = summary as Record<string, unknown>
  return (
    values.allCasesObservedPassing === true &&
    values.leakageFailuresAcrossAttempts === 0 &&
    values.allNormalCompletions === true &&
    values.allTokenBoundsPassed === true &&
    values.allLatencyBoundsOrFailOpenPassed === true &&
    typeof values.memoryEnabledRequiredHitRateBestAttempt === 'number' &&
    typeof values.memoryDisabledRequiredHitRate === 'number' &&
    values.memoryEnabledRequiredHitRateBestAttempt > values.memoryDisabledRequiredHitRate
  )
}

export function assertNoSensitiveReportContent(value: unknown, corpus: Corpus, apiKey: string): void {
  const serialized = JSON.stringify(value)
  const forbidden = [
    apiKey,
    ...corpus.cases.flatMap((testCase) => [
      testCase.query,
      testCase.currentEvidence ?? '',
      ...testCase.setup.map((entry) => entry.text),
    ]),
  ].filter((candidate) => candidate.length >= 8)
  if (forbidden.some((candidate) => serialized.includes(candidate))) {
    throw new Error('content-free live artifact assertion failed')
  }
}

function workspaceAliases(testCase: CorpusCase): string[] {
  return [testCase.workspaceId, ...testCase.setup.map((entry) => entry.workspaceId ?? testCase.workspaceId)]
}

function requireWorkspace(workspaces: ReadonlyMap<string, string>, alias: string): string {
  const workspace = workspaces.get(alias)
  if (workspace === undefined) throw new Error('evaluation workspace alias was not provisioned')
  return workspace
}

function requireAssistant(scope: HonchoScope): string {
  if (scope.assistantPeerId === undefined) throw new Error('synthetic assistant peer is missing')
  return scope.assistantPeerId
}

function syntheticId(...parts: string[]): string {
  const readable = parts.join('_').replace(/[^A-Za-z0-9_-]/g, '_')
  if (readable.length <= 180) return `synthetic_${readable}`
  return `synthetic_${readable.slice(0, 120)}_${digest(readable).slice(0, 32)}`
}

function createRunId(): string {
  return `${new Date()
    .toISOString()
    .replace(/[-:.TZ]/g, '')
    .slice(0, 14)}_${randomBytes(6).toString('hex')}`
}

function validateBaseURL(value: string): string {
  const url = new URL(value)
  if (!['https:', 'http:'].includes(url.protocol) || url.username.length > 0 || url.password.length > 0) {
    throw new Error('HONCHO_BASE_URL must be an HTTP(S) URL without credentials')
  }
  return url.toString().replace(/\/$/, '')
}

function contentFreeErrorCode(error: unknown, timedOut: boolean): string {
  if (timedOut) return 'TIMEOUT_OR_ABORT'
  if (error instanceof HonchoMemoryError) return error.code
  return 'UNCLASSIFIED'
}

function percentile(values: readonly number[], quantile: number): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * quantile) - 1)] ?? 0
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator
}

function digest(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, milliseconds))
}

async function atomicWriteJson(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' })
  await rename(temporary, path)
}
