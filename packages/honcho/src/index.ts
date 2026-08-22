/**
 * Provider-neutral Honcho capability seam for DeepSeek Harness.
 *
 * The service is deliberately model-agnostic. DSH remains the only agent runtime,
 * policy authority, tool registry, and session source of truth.
 * @module @deepseek-honcho/dsh-honcho
 */

import { createHash } from 'node:crypto'
import { Context, Service } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'

export const HONCHO_CONTRACT_VERSION = 1
export const HONCHO_SCHEMA_VERSION = 'deepseek-honcho/v1'
export const HONCHO_PLUGIN_VERSION = '0.2.0'
export const HONCHO_ID_PATTERN = /^[A-Za-z0-9_-]{1,512}$/

export type HonchoAgentKind = 'root' | 'child'
export type HonchoRecordRole = 'user' | 'assistant' | 'memory-note' | 'correction' | 'experiment-card'
export type HonchoRecallKind = 'representation' | 'message' | 'conclusion' | 'summary'
export type HonchoCircuitState = 'closed' | 'open' | 'half-open'

export interface HonchoScope {
  readonly workspaceId: string
  readonly userPeerId: string
  readonly assistantPeerId?: string
  readonly honchoSessionId: string
  readonly dshSessionId: string
  readonly projectId: string
  readonly agentKind: HonchoAgentKind
}

export interface HonchoRecordMessage {
  readonly role: HonchoRecordRole
  readonly peerId: string
  readonly content: string
  readonly createdAt: string
  readonly metadata: Readonly<Record<string, unknown>>
}

export interface HonchoRecordRequest {
  readonly deliveryId: string
  readonly scope: HonchoScope
  readonly messages: readonly HonchoRecordMessage[]
  readonly signal?: AbortSignal
}

export interface HonchoRecallRequest {
  readonly scope: HonchoScope
  readonly query: string
  readonly includeUserRepresentation: boolean
  readonly projectOnly: boolean
  readonly maxItems: number
  readonly maxCharacters: number
  readonly signal: AbortSignal
}

export interface HonchoRecallItem {
  readonly kind: HonchoRecallKind
  readonly text: string
  readonly sourceId?: string
  readonly sessionId?: string
  readonly createdAt?: string
  readonly score?: number
  readonly experimentCard?: HonchoExperimentCardItem
}

/** Allowlisted remote experiment-card fields; opaque provider metadata never crosses the seam. */
export interface HonchoExperimentCardItem {
  readonly schemaVersion: 1
  readonly experimentId: string
  readonly artifactId: string
  readonly projectId: string
  readonly queryFingerprint: string
  readonly sourceVersion: string
  readonly source: string
  readonly title: string
  readonly summary: string
  readonly shape?: string
  readonly columns?: readonly string[]
  readonly tags?: readonly string[]
  readonly projectionRevision: number
}

export interface HonchoRecallResult {
  readonly items: readonly HonchoRecallItem[]
  readonly truncated: boolean
  readonly durationMs: number
}

export interface HonchoStatus {
  readonly configured: boolean
  readonly circuit: HonchoCircuitState
  readonly pendingDeliveries: number
  readonly oldestPendingAt?: string
  readonly lastSuccessAt?: string
  readonly lastErrorCode?: string
  readonly deliveredCount?: number
  readonly retriedCount?: number
  readonly deadLetterCount?: number
  readonly duplicateCount?: number
}

export type HonchoErrorCode =
  | 'INVALID_CONFIG'
  | 'INVALID_SCOPE'
  | 'NOT_CONFIGURED'
  | 'AUTH'
  | 'PERMISSION'
  | 'TIMEOUT'
  | 'TRANSIENT'
  | 'VALIDATION'
  | 'PARTIAL_DELIVERY'
  | 'CIRCUIT_OPEN'
  | 'DISPOSED'

/** Stable, content-free failure surfaced by providers and consumers. */
export class HonchoMemoryError extends Error {
  constructor(
    readonly code: HonchoErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'HonchoMemoryError'
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    honcho: HonchoMemory
  }
}

/** Provider-focused memory capability. Implementations live in separate packages. */
export abstract class HonchoMemory extends Service {
  constructor(ctx: Context) {
    super(ctx, 'honcho')
  }

  abstract resolveScope(agent: Agent): HonchoScope | undefined
  /** Reconstruct host-owned scope for a durable Consumer record after restart. */
  abstract scopeForSession(dshSessionId: string, agentKind: HonchoAgentKind): HonchoScope
  abstract ensureScope(scope: HonchoScope, signal?: AbortSignal): Promise<void>
  abstract record(request: HonchoRecordRequest): Promise<void>
  abstract recall(request: HonchoRecallRequest): Promise<HonchoRecallResult>
  abstract search(request: HonchoRecallRequest): Promise<HonchoRecallResult>
  abstract recordNote(request: HonchoRecordRequest): Promise<void>
  abstract status(scope?: HonchoScope): HonchoStatus
}

/** Reject values Honcho cannot safely use as stable identifiers. */
export function validateHonchoId(label: string, value: string): string {
  if (!HONCHO_ID_PATTERN.test(value)) {
    throw new HonchoMemoryError('INVALID_CONFIG', `${label} must match [A-Za-z0-9_-]{1,512}`)
  }
  return value
}

/** RFC 4648 base32 without padding, lower-case to remain Honcho-ID safe. */
function base32Url(bytes: Uint8Array): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz234567'
  let bits = 0
  let accumulator = 0
  let output = ''
  for (const byte of bytes) {
    accumulator = (accumulator << 8) | byte
    bits += 8
    while (bits >= 5) {
      bits -= 5
      output += alphabet[(accumulator >>> bits) & 31]
    }
  }
  if (bits > 0) output += alphabet[(accumulator << (5 - bits)) & 31]
  return output
}

/** Map the exact DSH SessionId without leaking it in the remote resource name. */
export function honchoSessionId(dshSessionId: string): string {
  if (dshSessionId.length === 0) throw new HonchoMemoryError('INVALID_SCOPE', 'DSH session id must not be empty')
  const digest = createHash('sha256').update(dshSessionId, 'utf8').digest()
  return `dsh_${base32Url(digest)}`
}

/** Classify only from DSH's durable public session header; never infer from names. */
export function classifyAgent(agent: Agent): HonchoAgentKind | undefined {
  const { origin, delegationDepth } = agent.session.header
  if (origin === 'subagent' || (delegationDepth !== undefined && delegationDepth > 0)) return 'child'
  if (origin === undefined && (delegationDepth === undefined || delegationDepth === 0)) return 'root'
  return undefined
}

export interface HonchoIdentityConfig {
  readonly workspaceId: string
  readonly userPeerId: string
  readonly assistantPeerId?: string
  readonly projectId: string
}

/** Validate host-controlled identity exactly; display names are never converted. */
export function validateIdentity(config: HonchoIdentityConfig): Readonly<HonchoIdentityConfig> {
  return Object.freeze({
    workspaceId: validateHonchoId('workspaceId', config.workspaceId),
    userPeerId: validateHonchoId('userPeerId', config.userPeerId),
    ...(config.assistantPeerId === undefined
      ? {}
      : { assistantPeerId: validateHonchoId('assistantPeerId', config.assistantPeerId) }),
    projectId: validateHonchoId('projectId', config.projectId),
  })
}

export interface HonchoContentPolicy {
  readonly redactSecrets: boolean
  readonly maxCharacters: number
  readonly maxBytes: number
}

/** Shared deterministic pre-outbox text path used by automatic capture and explicit tools. */
export function sanitizeHonchoContent(
  input: string,
  policy: HonchoContentPolicy,
  remainingCharacters = Number.MAX_SAFE_INTEGER,
  remainingBytes = Number.MAX_SAFE_INTEGER,
): { text: string; redacted: number; truncated: boolean } {
  let text = input.normalize('NFC').replace(/\r\n?/g, '\n').replaceAll('\0', '').trim()
  let redacted = 0
  if (policy.redactSecrets) {
    const patterns: readonly [RegExp, string][] = [
      [
        /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g,
        '[REDACTED_PRIVATE_KEY]',
      ],
      [/\bBearer\s+[A-Za-z0-9._~+/-]{8,}=*/gi, 'Bearer [REDACTED]'],
      [/\b(sk|hch)-[A-Za-z0-9_-]{12,}\b/g, '[REDACTED_API_KEY]'],
      [/\b(api[_-]?key|access[_-]?token|secret)\s*[:=]\s*['"]?[A-Za-z0-9._~+/-]{8,}['"]?/gi, '[REDACTED_SECRET]'],
    ]
    for (const [pattern, replacement] of patterns) {
      text = text.replace(pattern, () => {
        redacted++
        return replacement
      })
    }
  }
  const characterLimit = Math.min(policy.maxCharacters, remainingCharacters)
  const byteLimit = Math.min(policy.maxBytes, remainingBytes)
  const original = text
  text = text.slice(0, Math.max(0, characterLimit))
  while (Buffer.byteLength(text, 'utf8') > byteLimit) text = text.slice(0, -1)
  return { text: text.trim(), redacted, truncated: text.length < original.length }
}

/** Resolve the only scope Consumers may use for an agent. */
export function resolveHostScope(agent: Agent, identity: HonchoIdentityConfig): HonchoScope | undefined {
  const agentKind = classifyAgent(agent)
  if (agentKind === undefined) return undefined
  const validated = validateIdentity(identity)
  const dshSessionId = String(agent.id)
  return Object.freeze({
    ...validated,
    honchoSessionId: honchoSessionId(dshSessionId),
    dshSessionId,
    agentKind,
  })
}

export default HonchoMemory
