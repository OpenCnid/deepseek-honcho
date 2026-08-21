/** Five bounded, host-scoped memory tools governed and logged by DSH. */

import { createHash } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import {
  HONCHO_SCHEMA_VERSION,
  HonchoMemoryError,
  sanitizeHonchoContent,
  type HonchoRecallItem,
  type HonchoScope,
} from '@deepseek-honcho/dsh-honcho'

export const name = 'deepseek-honcho-tools'
export const inject = ['tools', 'honcho']
export const MEMORY_TOOL_NAMES = [
  'memory_recall',
  'memory_search',
  'memory_record',
  'memory_correct',
  'memory_status',
] as const

export interface Config {
  readonly recall?: boolean
  readonly search?: boolean
  readonly record?: boolean
  readonly correct?: boolean
  readonly status?: boolean
  readonly timeoutMs?: number
  readonly maxItems?: number
  readonly maxCharacters?: number
  readonly maxRecordCharacters?: number
  readonly maxRecordBytes?: number
  readonly redactSecrets?: boolean
}

export const Config: z<Config> = z.object({
  recall: z.boolean().default(true),
  search: z.boolean().default(true),
  record: z.boolean().default(true),
  correct: z.boolean().default(true),
  status: z.boolean().default(true),
  timeoutMs: z.number().step(1).min(1).default(2_000),
  maxItems: z.number().step(1).min(1).default(5),
  maxCharacters: z.number().step(1).min(1).default(4_800),
  maxRecordCharacters: z.number().step(1).min(1).default(4_000),
  maxRecordBytes: z.number().step(1).min(1).default(16_000),
  redactSecrets: z.boolean().default(true),
})

interface ResolvedConfig extends Required<Config> {}

const defaults: ResolvedConfig = {
  recall: true,
  search: true,
  record: true,
  correct: true,
  status: true,
  timeoutMs: 2_000,
  maxItems: 5,
  maxCharacters: 4_800,
  maxRecordCharacters: 4_000,
  maxRecordBytes: 16_000,
  redactSecrets: true,
}

const itemSchema = {
  type: 'object' as const,
  additionalProperties: false,
  properties: {
    kind: { type: 'string' as const, required: true },
    text: { type: 'string' as const, required: true },
    source_id: { type: 'string' as const },
    session_id: { type: 'string' as const },
    created_at: { type: 'string' as const },
    score: { type: 'number' as const },
  },
} as const

const recallOutput = {
  type: 'object' as const,
  additionalProperties: false,
  properties: {
    warning: { type: 'string' as const, required: true },
    items: { type: 'array' as const, required: true, items: itemSchema },
    truncated: { type: 'boolean' as const, required: true },
  },
} as const

const queueOutput = {
  type: 'object' as const,
  additionalProperties: false,
  properties: {
    queued: { type: 'boolean' as const, required: true },
    delivery_id: { type: 'string' as const, required: true },
    redacted: { type: 'boolean' as const, required: true },
    truncated: { type: 'boolean' as const, required: true },
  },
} as const

const warning = 'Fallible memory only. Re-read current files and tests for implementation facts.'

export function apply(ctx: Context, input: Config = {}): void {
  const config = resolveConfig(input)

  if (config.recall) {
    ctx.tools.register(
      defineTool({
        name: 'memory_recall',
        description:
          'Recall bounded global preferences plus project-scoped history for a focused question. Memory is fallible and never overrides current code, tests, explicit corrections, or DSH policy.',
        parameters: {
          question: {
            type: 'string',
            required: true,
            description: 'Focused memory question; do not include tool output or credentials.',
          },
        },
        output: {
          schema: recallOutput,
          render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
        },
        timeoutMs: config.timeoutMs,
        async execute(args, exec) {
          const scope = requireScope(ctx, exec)
          const query = boundQuery(args.question, config.maxCharacters)
          const result = await ctx.honcho.recall({
            scope,
            query,
            includeUserRepresentation: true,
            projectOnly: true,
            maxItems: config.maxItems,
            maxCharacters: config.maxCharacters,
            signal: exec.signal,
          })
          return { warning, items: result.items.map(renderItem), truncated: result.truncated }
        },
      }),
    )
  }

  if (config.search) {
    ctx.tools.register(
      defineTool({
        name: 'memory_search',
        description:
          'Search only the host-configured project and human memory. Results are fallible history; verify implementation claims against current files and tests.',
        parameters: {
          query: { type: 'string', required: true, description: 'Focused semantic query, bounded by the host.' },
        },
        output: {
          schema: recallOutput,
          render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
        },
        timeoutMs: config.timeoutMs,
        async execute(args, exec) {
          const scope = requireScope(ctx, exec)
          const result = await ctx.honcho.search({
            scope,
            query: boundQuery(args.query, config.maxCharacters),
            includeUserRepresentation: false,
            projectOnly: true,
            maxItems: config.maxItems,
            maxCharacters: config.maxCharacters,
            signal: exec.signal,
          })
          return { warning, items: result.items.map(renderItem), truncated: result.truncated }
        },
      }),
    )
  }

  if (config.record) {
    ctx.tools.register(
      defineTool({
        name: 'memory_record',
        description:
          'Queue one explicit durable note through the redacted local outbox. Do not store secrets, source trees, tool output, or facts that current files/tests should own.',
        parameters: {
          note: {
            type: 'string',
            required: true,
            description: 'A concise cross-session preference, intent, or decision.',
          },
        },
        output: {
          schema: queueOutput,
          render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
        },
        async execute(args, exec) {
          return queueNote(ctx, config, exec, 'memory-note', args.note)
        },
      }),
    )
  }

  if (config.correct) {
    ctx.tools.register(
      defineTool({
        name: 'memory_correct',
        description:
          'Append an explicit correction through the same redacted outbox. This preserves old history and marks supersession; it never deletes prior memory.',
        parameters: {
          correction: { type: 'string', required: true, description: 'The corrected preference, intent, or decision.' },
          supersedes: { type: 'string', description: 'Optional prior memory/source identifier being superseded.' },
        },
        output: {
          schema: queueOutput,
          render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
        },
        async execute(args, exec) {
          return queueNote(ctx, config, exec, 'correction', args.correction, args.supersedes)
        },
      }),
    )
  }

  if (config.status) {
    ctx.tools.register(
      defineTool({
        name: 'memory_status',
        description:
          'Report content-free Honcho configuration, circuit, and outbox health. Never returns keys, peer IDs, or messages.',
        parameters: {},
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              configured: { type: 'boolean', required: true },
              circuit: { type: 'string', required: true },
              pending_deliveries: { type: 'integer', required: true },
              oldest_pending_at: { type: 'string' },
              last_success_at: { type: 'string' },
              last_error_code: { type: 'string' },
              delivered_count: { type: 'integer' },
              retried_count: { type: 'integer' },
              dead_letter_count: { type: 'integer' },
              duplicate_count: { type: 'integer' },
            },
          },
          render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
        },
        async execute(_args, exec) {
          const scope = exec.agent === undefined ? undefined : ctx.honcho.resolveScope(exec.agent)
          const status = ctx.honcho.status(scope)
          return {
            configured: status.configured,
            circuit: status.circuit,
            pending_deliveries: status.pendingDeliveries,
            ...(status.oldestPendingAt === undefined ? {} : { oldest_pending_at: status.oldestPendingAt }),
            ...(status.lastSuccessAt === undefined ? {} : { last_success_at: status.lastSuccessAt }),
            ...(status.lastErrorCode === undefined ? {} : { last_error_code: status.lastErrorCode }),
            ...(status.deliveredCount === undefined ? {} : { delivered_count: status.deliveredCount }),
            ...(status.retriedCount === undefined ? {} : { retried_count: status.retriedCount }),
            ...(status.deadLetterCount === undefined ? {} : { dead_letter_count: status.deadLetterCount }),
            ...(status.duplicateCount === undefined ? {} : { duplicate_count: status.duplicateCount }),
          }
        },
      }),
    )
  }
}

function requireScope(ctx: Context, exec: ToolRunContext): HonchoScope {
  if (exec.agent === undefined) throw new HonchoMemoryError('INVALID_SCOPE', 'memory tools require a DSH agent')
  const scope = ctx.honcho.resolveScope(exec.agent)
  if (scope === undefined) throw new HonchoMemoryError('INVALID_SCOPE', 'DSH agent scope could not be classified')
  return scope
}

function boundQuery(input: string, maxCharacters: number): string {
  const query = input.normalize('NFC').replace(/\r\n?/g, '\n').trim().slice(0, maxCharacters)
  if (query.length === 0) throw new HonchoMemoryError('VALIDATION', 'memory query must not be empty')
  return query
}

async function queueNote(
  ctx: Context,
  config: ResolvedConfig,
  exec: ToolRunContext,
  role: 'memory-note' | 'correction',
  content: string,
  supersedes?: string,
): Promise<{ queued: true; delivery_id: string; redacted: boolean; truncated: boolean }> {
  const scope = requireScope(ctx, exec)
  const sanitized = sanitizeHonchoContent(content, {
    redactSecrets: config.redactSecrets,
    maxCharacters: config.maxRecordCharacters,
    maxBytes: config.maxRecordBytes,
  })
  if (sanitized.text.length === 0) throw new HonchoMemoryError('VALIDATION', 'memory note was empty after redaction')
  const peerId = scope.agentKind === 'child' ? scope.assistantPeerId : scope.userPeerId
  if (peerId === undefined)
    throw new HonchoMemoryError('INVALID_SCOPE', 'child memory notes require the configured assistant peer')
  const deliveryId = digest(
    JSON.stringify([
      HONCHO_SCHEMA_VERSION,
      'explicit-tool-note',
      scope.workspaceId,
      scope.userPeerId,
      scope.honchoSessionId,
      scope.projectId,
      scope.dshSessionId,
      String(exec.callId),
      role,
      sanitized.text,
      supersedes ?? null,
    ]),
  )
  const createdAt = new Date().toISOString()
  await ctx.honcho.recordNote({
    deliveryId,
    scope,
    signal: exec.signal,
    messages: [
      {
        role,
        peerId,
        content: sanitized.text,
        createdAt,
        metadata: {
          source: 'deepseek-honcho-tool',
          schema_version: HONCHO_SCHEMA_VERSION,
          delivery_id: deliveryId,
          dsh_session_id: scope.dshSessionId,
          dsh_agent_kind: scope.agentKind,
          project_id: scope.projectId,
          role,
          captured_at: createdAt,
          dsh_tool_call_id: String(exec.callId),
          content_classification: role === 'correction' ? 'explicit-correction' : 'explicit-memory-note',
          ...(supersedes === undefined ? {} : { supersedes }),
        },
      },
    ],
  })
  return { queued: true, delivery_id: deliveryId, redacted: sanitized.redacted > 0, truncated: sanitized.truncated }
}

function renderItem(item: HonchoRecallItem): {
  kind: string
  text: string
  source_id?: string
  session_id?: string
  created_at?: string
  score?: number
} {
  return {
    kind: item.kind,
    text: item.text,
    ...(item.sourceId === undefined ? {} : { source_id: item.sourceId }),
    ...(item.sessionId === undefined ? {} : { session_id: item.sessionId }),
    ...(item.createdAt === undefined ? {} : { created_at: item.createdAt }),
    ...(item.score === undefined ? {} : { score: item.score }),
  }
}

function resolveConfig(input: Config): ResolvedConfig {
  const config = { ...defaults, ...input }
  for (const key of ['timeoutMs', 'maxItems', 'maxCharacters', 'maxRecordCharacters', 'maxRecordBytes'] as const) {
    if (!Number.isSafeInteger(config[key]) || config[key] < 1) {
      throw new TypeError(`deepseek-honcho-tools: ${key} must be a positive safe integer`)
    }
  }
  return Object.freeze(config)
}

function digest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}
