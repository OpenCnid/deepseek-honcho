import type { Context } from '@deepseek-ai/cordis'
import { Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { HonchoExperimentCardItem, HonchoRecallItem, HonchoScope } from '@deepseek-honcho/dsh-honcho'
import { ArtifactMemoryError } from './errors.ts'
import { ARTIFACT_INDEXER_DEFAULTS, ArtifactCardIndexer, type ArtifactIndexerInput } from './indexer.ts'
import { validateArtifactId, validateExperimentId, validateSha256 } from './ids.ts'
import { ARTIFACT_STORE_DEFAULTS, LocalArtifactStore, type LocalArtifactStoreInput } from './store.ts'
import type {
  ArtifactAuthority,
  ArtifactRecordInput,
  ArtifactResolveResult,
  ArtifactSearchHit,
  ArtifactStoreStatus,
  ExperimentCardV1,
} from './types.ts'

export const ARTIFACT_SERVICE_KEY = 'artifactMemory'
export const ARTIFACT_TOOL_NAMES = ['memory_artifact_record', 'memory_artifact_resolve'] as const

export interface Config
  extends Omit<LocalArtifactStoreInput, 'projectId' | 'artifactRoot' | 'rlmArtifactRoot' | 'forbiddenRoots'>,
    ArtifactIndexerInput {
  readonly enabled?: boolean
  readonly artifactRoot: string
  readonly rlmArtifactRoot: string
  readonly projectId?: string
  readonly assistantPeerId?: string
  readonly recordTool?: boolean
  readonly resolveTool?: boolean
  readonly remoteIndexing?: boolean
  readonly retentionPolicy?: 'operator-only'
  readonly forbiddenRoots?: string[]
}

export const Config: z<Config> = z.object({
  enabled: z.boolean().default(false),
  artifactRoot: z.string().required(),
  rlmArtifactRoot: z.string().required(),
  projectId: z.string(),
  assistantPeerId: z.string(),
  recordTool: z.boolean().default(false),
  resolveTool: z.boolean().default(false),
  remoteIndexing: z.boolean().default(false),
  maxArtifactBytes: z.number().step(1).min(1).default(ARTIFACT_STORE_DEFAULTS.maxArtifactBytes),
  maxProjectBytes: z.number().step(1).min(1).default(ARTIFACT_STORE_DEFAULTS.maxProjectBytes),
  maxCardsPerProject: z.number().step(1).min(1).default(ARTIFACT_STORE_DEFAULTS.maxCardsPerProject),
  titleCharacters: z.number().step(1).min(1).default(ARTIFACT_STORE_DEFAULTS.titleCharacters),
  summaryCharacters: z.number().step(1).min(1).default(ARTIFACT_STORE_DEFAULTS.summaryCharacters),
  sourceCharacters: z.number().step(1).min(1).default(ARTIFACT_STORE_DEFAULTS.sourceCharacters),
  sourceVersionCharacters: z.number().step(1).min(1).default(ARTIFACT_STORE_DEFAULTS.sourceVersionCharacters),
  mediaTypeCharacters: z.number().step(1).min(1).default(ARTIFACT_STORE_DEFAULTS.mediaTypeCharacters),
  shapeCharacters: z.number().step(1).min(1).default(ARTIFACT_STORE_DEFAULTS.shapeCharacters),
  maxTags: z.number().step(1).min(1).default(ARTIFACT_STORE_DEFAULTS.maxTags),
  tagCharacters: z.number().step(1).min(1).default(ARTIFACT_STORE_DEFAULTS.tagCharacters),
  maxColumns: z.number().step(1).min(1).default(ARTIFACT_STORE_DEFAULTS.maxColumns),
  columnCharacters: z.number().step(1).min(1).default(ARTIFACT_STORE_DEFAULTS.columnCharacters),
  localSearchMaxResults: z.number().step(1).min(1).default(ARTIFACT_STORE_DEFAULTS.localSearchMaxResults),
  localSearchTimeoutMs: z.number().step(1).min(1).default(ARTIFACT_STORE_DEFAULTS.localSearchTimeoutMs),
  integrityMode: z.union([z.const('cached'), z.const('always')]).default('cached'),
  repositoryRoot: z.string(),
  profileRoot: z.string(),
  honchoStateRoot: z.string(),
  forbiddenRoots: z.array(z.string()),
  redactSecrets: z.boolean().default(ARTIFACT_INDEXER_DEFAULTS.redactSecrets),
  maxCharacters: z.number().step(1).min(1).default(ARTIFACT_INDEXER_DEFAULTS.maxCharacters),
  maxBytes: z.number().step(1).min(1).default(ARTIFACT_INDEXER_DEFAULTS.maxBytes),
  maxFieldCharacters: z.number().step(1).min(1).default(ARTIFACT_INDEXER_DEFAULTS.maxFieldCharacters),
  reconciliationIntervalMs: z.number().step(1).min(1).default(ARTIFACT_INDEXER_DEFAULTS.reconciliationIntervalMs),
  reconciliationBatchSize: z.number().step(1).min(1).default(ARTIFACT_INDEXER_DEFAULTS.reconciliationBatchSize),
  reconciliationConcurrency: z.number().step(1).min(1).default(ARTIFACT_INDEXER_DEFAULTS.reconciliationConcurrency),
  retentionPolicy: z.const('operator-only').default('operator-only'),
})

interface ResolvedConfig
  extends Required<
    Omit<
      Config,
      'projectId' | 'assistantPeerId' | 'repositoryRoot' | 'profileRoot' | 'honchoStateRoot' | 'forbiddenRoots'
    >
  > {
  readonly projectId: string
  readonly assistantPeerId?: string
  readonly repositoryRoot?: string
  readonly profileRoot?: string
  readonly honchoStateRoot?: string
  readonly forbiddenRoots?: readonly string[]
}

const recordOutput = {
  type: 'object' as const,
  additionalProperties: false,
  properties: {
    experiment_id: { type: 'string' as const, required: true },
    artifact_id: { type: 'string' as const, required: true },
    sha256: { type: 'string' as const, required: true },
    bytes: { type: 'integer' as const, required: true },
    local_saved: { type: 'boolean' as const, required: true },
    deduplicated: { type: 'boolean' as const, required: true },
    honcho_queued: { type: 'boolean' as const, required: true },
    index_state: { type: 'string' as const, required: true },
    warning_code: { type: 'string' as const },
  },
} as const

const resolveOutput = {
  type: 'object' as const,
  additionalProperties: false,
  properties: {
    path: { type: 'string' as const, required: true },
    experiment_id: { type: 'string' as const, required: true },
    artifact_id: { type: 'string' as const, required: true },
    sha256: { type: 'string' as const, required: true },
    bytes: { type: 'integer' as const, required: true },
    media_type: { type: 'string' as const, required: true },
    title: { type: 'string' as const, required: true },
    summary: { type: 'string' as const, required: true },
    source: { type: 'string' as const, required: true },
    source_version: { type: 'string' as const, required: true },
    freshness: { type: 'string' as const, required: true },
    verified_at: { type: 'string' as const, required: true },
    warning: { type: 'string' as const },
  },
} as const

declare module '@deepseek-ai/cordis' {
  interface Context {
    artifactMemory: ArtifactMemory
  }
}

/** Optional artifact Service Provider and its two DSH-governed tools. */
export class ArtifactMemory extends Service {
  static inject = ['honcho', 'tools']
  static Config = Config
  readonly config: Readonly<ResolvedConfig>
  readonly store: LocalArtifactStore
  readonly indexer: ArtifactCardIndexer
  private readonly ready: Promise<void>

  constructor(ctx: Context, input: Config) {
    super(ctx, ARTIFACT_SERVICE_KEY)
    this.config = resolveConfig(input)
    this.store = new LocalArtifactStore(this.config)
    this.indexer = new ArtifactCardIndexer(this.store, ctx.honcho, {
      enabled: this.config.remoteIndexing,
      redactSecrets: this.config.redactSecrets,
      maxCharacters: this.config.maxCharacters,
      maxBytes: this.config.maxBytes,
      maxFieldCharacters: this.config.maxFieldCharacters,
      reconciliationIntervalMs: this.config.reconciliationIntervalMs,
      reconciliationBatchSize: this.config.reconciliationBatchSize,
      reconciliationConcurrency: this.config.reconciliationConcurrency,
    })
    this.ready = this.start()
    if (this.config.enabled && this.config.recordTool) this.registerRecordTool(ctx)
    if (this.config.enabled && this.config.resolveTool) this.registerResolveTool(ctx)
    ctx.effect(async () => {
      await this.ready
      return async () => {
        await this.indexer.dispose()
        await this.store.dispose()
      }
    }, 'deepseek-honcho-artifact-memory.lifecycle')
  }

  async localSearch(
    scope: HonchoScope,
    query: string,
    maximum: number,
    signal: AbortSignal,
  ): Promise<readonly ArtifactSearchHit[]> {
    await this.ready
    this.assertScope(scope)
    return this.store.search({ projectId: scope.projectId }, query, maximum, signal)
  }

  mergeRemote(
    scope: HonchoScope,
    local: readonly ArtifactSearchHit[],
    remote: readonly HonchoRecallItem[],
    maximum: number,
  ): readonly ArtifactSearchHit[] {
    this.assertScope(scope)
    const merged = new Map<string, ArtifactSearchHit>()
    for (const hit of local) merged.set(hit.experimentId, hit)
    const knownCards = new Map(this.store.cardsSnapshot().map((card) => [card.experimentId, card] as const))
    for (const item of remote) {
      const card = item.experimentCard
      if (card === undefined || card.projectId !== scope.projectId || merged.has(card.experimentId)) continue
      const hit = remoteHit(card, item.createdAt, knownCards.get(card.experimentId))
      if (hit !== undefined) merged.set(hit.experimentId, hit)
    }
    return Object.freeze([...merged.values()].slice(0, maximum))
  }

  async recordFromTool(
    exec: ToolRunContext,
    input: ArtifactRecordInput,
  ): Promise<{
    experiment_id: string
    artifact_id: string
    sha256: string
    bytes: number
    local_saved: true
    deduplicated: boolean
    honcho_queued: boolean
    index_state: string
    warning_code?: string
  }> {
    await this.ready
    const scope = this.scopeFromExecution(exec)
    const authority = authorityFrom(exec, scope)
    const recorded = await this.store.record(authority, input, exec.signal)
    const queued = await this.indexer.queueCard(recorded.card, scope, exec.signal)
    return {
      experiment_id: recorded.card.experimentId,
      artifact_id: recorded.card.artifact.artifactId,
      sha256: recorded.card.artifact.sha256,
      bytes: recorded.card.artifact.bytes,
      local_saved: true,
      deduplicated: recorded.deduplicated,
      honcho_queued: queued.honchoQueued,
      index_state: queued.indexState,
      ...(queued.warningCode === undefined ? {} : { warning_code: queued.warningCode }),
    }
  }

  async resolveFromTool(
    exec: ToolRunContext,
    id: string,
    currentSourceVersion?: string,
  ): Promise<ReturnType<typeof renderResolve>> {
    await this.ready
    const scope = this.scopeFromExecution(exec)
    const resolved = await this.store.resolveArtifact(
      { projectId: scope.projectId },
      id,
      currentSourceVersion,
      exec.signal,
    )
    return renderResolve(resolved)
  }

  async status(): Promise<ArtifactStoreStatus> {
    return this.store.status()
  }

  private async start(): Promise<void> {
    await this.store.initializeReady()
    if (this.config.enabled) await this.indexer.start()
  }

  private scopeFromExecution(exec: ToolRunContext): HonchoScope {
    if (exec.agent === undefined) throw new ArtifactMemoryError('INVALID_SCOPE', 'artifact tools require a DSH agent')
    const scope = this.ctx.honcho.resolveScope(exec.agent)
    if (scope === undefined) throw new ArtifactMemoryError('INVALID_SCOPE', 'DSH agent scope could not be classified')
    this.assertScope(scope)
    return scope
  }

  private assertScope(scope: HonchoScope): void {
    if (scope.projectId !== this.config.projectId)
      throw new ArtifactMemoryError('INVALID_SCOPE', 'artifact scope does not match the configured project')
    if (this.config.remoteIndexing && scope.assistantPeerId !== this.config.assistantPeerId) {
      throw new ArtifactMemoryError('INVALID_SCOPE', 'artifact indexing assistant does not match host configuration')
    }
  }

  private registerRecordTool(ctx: Context): void {
    const definition = defineTool({
      name: 'memory_artifact_record',
      description:
        'Record one intentional file from this exact RLM session exports directory as immutable project-local bytes plus an untrusted experiment card. DSH derives session/project scope; current files and datasets remain authoritative.',
      parameters: {
        source_path: {
          type: 'string',
          required: true,
          description: 'Absolute file beneath this exact RLM session exports directory.',
        },
        title: {
          type: 'string',
          required: true,
          description: 'Bounded semantic experiment title; no paths, query text, rows, or secrets.',
        },
        summary: {
          type: 'string',
          required: true,
          description: 'Bounded aggregate description; no raw query/code, parameters, samples, paths, or secrets.',
        },
        query_fingerprint: {
          type: 'string',
          required: true,
          description: 'Lowercase SHA-256 of the stable local computation identity.',
        },
        source: {
          type: 'string',
          required: true,
          description: 'Bounded source label, not a connection string or path.',
        },
        source_version: {
          type: 'string',
          required: true,
          description: 'Immutable source version or literal unknown.',
        },
        media_type: { type: 'string', description: 'IANA media type; defaults to application/octet-stream.' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Bounded semantic tags.' },
        shape: { type: 'string', description: 'Bounded aggregate shape description without samples.' },
        columns: { type: 'array', items: { type: 'string' }, description: 'Bounded column names only.' },
      },
      output: {
        schema: recordOutput,
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      isConcurrencySafe: () => true,
      execute: async (args, exec) => {
        rejectUnknownToolArguments(
          args,
          [
            'source_path',
            'title',
            'summary',
            'query_fingerprint',
            'source',
            'source_version',
            'media_type',
            'tags',
            'shape',
            'columns',
          ],
          'memory_artifact_record',
        )
        return this.recordFromTool(exec, {
          sourcePath: args.source_path,
          title: args.title,
          summary: args.summary,
          queryFingerprint: args.query_fingerprint,
          source: args.source,
          sourceVersion: args.source_version,
          ...(args.media_type === undefined ? {} : { mediaType: args.media_type }),
          ...(args.tags === undefined ? {} : { tags: args.tags }),
          ...(args.shape === undefined ? {} : { shape: args.shape }),
          ...(args.columns === undefined ? {} : { columns: args.columns }),
        })
      },
    })
    ctx.tools.register({
      ...definition,
      parameters: { ...definition.parameters, additionalProperties: false },
    })
  }

  private registerResolveTool(ctx: Context): void {
    const definition = defineTool({
      name: 'memory_artifact_resolve',
      description:
        'Resolve only a current-project local experiment card after containment, size, and SHA-256 verification. Stale results are historical and carry a warning; re-check current source evidence.',
      parameters: {
        experiment_id: {
          type: 'string',
          required: true,
          description: 'Opaque exp_ experiment identifier from memory_search.',
        },
        current_source_version: {
          type: 'string',
          description: 'Current immutable source version for freshness comparison.',
        },
      },
      output: {
        schema: resolveOutput,
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      isConcurrencySafe: () => true,
      execute: async (args, exec) => {
        rejectUnknownToolArguments(args, ['experiment_id', 'current_source_version'], 'memory_artifact_resolve')
        return this.resolveFromTool(exec, args.experiment_id, args.current_source_version)
      },
    })
    ctx.tools.register({
      ...definition,
      parameters: { ...definition.parameters, additionalProperties: false },
    })
  }
}

function rejectUnknownToolArguments(
  value: Readonly<Record<string, unknown>>,
  allowed: readonly string[],
  tool: string,
): void {
  const names = new Set(allowed)
  const unknown = Object.keys(value).find((key) => !names.has(key))
  if (unknown !== undefined) throw new ArtifactMemoryError('VALIDATION', `${tool} has an unknown argument`)
}

function resolveConfig(input: Config): Readonly<ResolvedConfig> {
  const config = {
    ...ARTIFACT_STORE_DEFAULTS,
    ...ARTIFACT_INDEXER_DEFAULTS,
    ...input,
    enabled: input.enabled ?? false,
    recordTool: input.recordTool ?? false,
    resolveTool: input.resolveTool ?? false,
    remoteIndexing: input.remoteIndexing ?? false,
    retentionPolicy: input.retentionPolicy ?? ('operator-only' as const),
  }
  if (config.enabled && !config.recordTool && !config.resolveTool) {
    throw new ArtifactMemoryError(
      'INVALID_CONFIG',
      'enabled artifact memory requires explicit artifact tool enablement',
    )
  }
  if (config.remoteIndexing && config.assistantPeerId === undefined) {
    throw new ArtifactMemoryError('INVALID_CONFIG', 'remote artifact indexing requires an assistant peer ID')
  }
  if (config.retentionPolicy !== 'operator-only')
    throw new ArtifactMemoryError('INVALID_CONFIG', 'artifact retention policy must be operator-only')
  if (config.projectId === undefined || config.projectId.length === 0) {
    throw new ArtifactMemoryError('INVALID_CONFIG', 'artifact memory requires a host project ID')
  }
  return Object.freeze(config) as Readonly<ResolvedConfig>
}

function authorityFrom(exec: ToolRunContext, scope: HonchoScope): ArtifactAuthority {
  return Object.freeze({
    projectId: scope.projectId,
    dshSessionId: scope.dshSessionId,
    agentKind: scope.agentKind,
    ...(scope.agentKind === 'root' && exec.agent !== undefined ? { rootAgentId: String(exec.agent.id) } : {}),
    toolCallId: String(exec.callId),
  })
}

function remoteHit(
  card: HonchoExperimentCardItem,
  createdAt?: string,
  local?: ExperimentCardV1,
): ArtifactSearchHit | undefined {
  try {
    validateExperimentId(card.experimentId)
    validateArtifactId(card.artifactId)
    validateSha256('query fingerprint', card.queryFingerprint)
    if (local !== undefined) {
      if (
        local.projectId !== card.projectId ||
        local.artifact.artifactId !== card.artifactId ||
        local.queryFingerprint !== card.queryFingerprint
      ) {
        return undefined
      }
      return Object.freeze({
        kind: 'experiment-card',
        experimentId: local.experimentId,
        artifactId: local.artifact.artifactId,
        title: local.title,
        summary: local.summary,
        queryFingerprint: local.queryFingerprint,
        source: local.source,
        sourceVersion: local.sourceVersion,
        ...(local.shape === undefined ? {} : { shape: local.shape }),
        ...(local.columns === undefined ? {} : { columns: local.columns }),
        ...(local.tags === undefined ? {} : { tags: local.tags }),
        createdAt: local.createdAt,
        updatedAt: local.updatedAt,
        indexState: local.index.state,
        localAvailable: true,
        match: 'lexical',
        trust: 'untrusted-card',
        sourceKind: 'honcho',
      })
    }
    return Object.freeze({
      kind: 'experiment-card',
      experimentId: card.experimentId,
      artifactId: card.artifactId,
      title: card.title,
      summary: card.summary,
      queryFingerprint: card.queryFingerprint,
      source: card.source,
      sourceVersion: card.sourceVersion,
      ...(card.shape === undefined ? {} : { shape: card.shape }),
      ...(card.columns === undefined ? {} : { columns: card.columns }),
      ...(card.tags === undefined ? {} : { tags: card.tags }),
      createdAt: createdAt ?? '',
      updatedAt: createdAt ?? '',
      indexState: 'indexed',
      localAvailable: false,
      match: 'lexical',
      trust: 'untrusted-card',
      sourceKind: 'honcho',
    })
  } catch {
    return undefined
  }
}

function renderResolve(resolved: ArtifactResolveResult): {
  path: string
  experiment_id: string
  artifact_id: string
  sha256: string
  bytes: number
  media_type: string
  title: string
  summary: string
  source: string
  source_version: string
  freshness: string
  verified_at: string
  warning?: string
} {
  return {
    path: resolved.path,
    experiment_id: resolved.card.experimentId,
    artifact_id: resolved.card.artifact.artifactId,
    sha256: resolved.card.artifact.sha256,
    bytes: resolved.card.artifact.bytes,
    media_type: resolved.card.artifact.mediaType,
    title: resolved.card.title,
    summary: resolved.card.summary,
    source: resolved.card.source,
    source_version: resolved.card.sourceVersion,
    freshness: resolved.freshness,
    verified_at: resolved.verifiedAt,
    ...(resolved.warning === undefined ? {} : { warning: resolved.warning }),
  }
}

export default ArtifactMemory
