import { ArtifactMemoryError } from './errors.ts'
import { experimentId, validateArtifactId, validateExperimentId, validateSha256 } from './ids.ts'
import type { ArtifactIndexState, ArtifactRecordInput, ExperimentCardV1 } from './types.ts'

export interface MetadataBounds {
  readonly titleCharacters: number
  readonly summaryCharacters: number
  readonly sourceCharacters: number
  readonly sourceVersionCharacters: number
  readonly mediaTypeCharacters: number
  readonly shapeCharacters: number
  readonly maxTags: number
  readonly tagCharacters: number
  readonly maxColumns: number
  readonly columnCharacters: number
}

export interface ValidatedArtifactMetadata {
  readonly title: string
  readonly summary: string
  readonly queryFingerprint: string
  readonly source: string
  readonly sourceVersion: string
  readonly mediaType: string
  readonly shape?: string
  readonly columns?: readonly string[]
  readonly tags?: readonly string[]
}

const INDEX_STATES = new Set<ArtifactIndexState>(['pending', 'queued', 'indexed', 'failed', 'disabled'])

export function validateRecordMetadata(input: ArtifactRecordInput, bounds: MetadataBounds): ValidatedArtifactMetadata {
  const title = boundedText('title', input.title, bounds.titleCharacters)
  const summary = boundedText('summary', input.summary, bounds.summaryCharacters)
  const source = boundedText('source', input.source, bounds.sourceCharacters)
  const sourceVersion = boundedText('source version', input.sourceVersion, bounds.sourceVersionCharacters)
  const mediaType = boundedText('media type', input.mediaType ?? 'application/octet-stream', bounds.mediaTypeCharacters)
  validateSha256('query fingerprint', input.queryFingerprint)
  const shape = input.shape === undefined ? undefined : boundedText('shape', input.shape, bounds.shapeCharacters)
  const columns =
    input.columns === undefined
      ? undefined
      : boundedArray('columns', input.columns, bounds.maxColumns, bounds.columnCharacters)
  const tags =
    input.tags === undefined ? undefined : boundedArray('tags', input.tags, bounds.maxTags, bounds.tagCharacters)
  return Object.freeze({
    title,
    summary,
    queryFingerprint: input.queryFingerprint,
    source,
    sourceVersion,
    mediaType,
    ...(shape === undefined ? {} : { shape }),
    ...(columns === undefined ? {} : { columns }),
    ...(tags === undefined ? {} : { tags }),
  })
}

function boundedText(label: string, value: unknown, maximum: number): string {
  if (typeof value !== 'string') throw new ArtifactMemoryError('VALIDATION', `${label} must be a string`)
  const normalized = value.normalize('NFC').replace(/\r\n?/g, '\n').replaceAll('\0', '').trim()
  if (normalized.length === 0 || [...normalized].length > maximum) {
    throw new ArtifactMemoryError('VALIDATION', `${label} must contain 1 to ${maximum} characters`)
  }
  return normalized
}

function boundedArray(
  label: string,
  values: readonly string[],
  maximumItems: number,
  maximumCharacters: number,
): readonly string[] {
  if (!Array.isArray(values) || values.length > maximumItems) {
    throw new ArtifactMemoryError('VALIDATION', `${label} exceeds its item bound`)
  }
  return Object.freeze(values.map((value) => boundedText(label.slice(0, -1), value, maximumCharacters)))
}

export function validateCard(value: unknown, expectedProjectId?: string, bounds?: MetadataBounds): ExperimentCardV1 {
  if (!isRecord(value)) throw new ArtifactMemoryError('VALIDATION', 'experiment card must be an object')
  if (value.schemaVersion !== 1)
    throw new ArtifactMemoryError('UNSUPPORTED_VERSION', 'experiment card schema version is unsupported')
  const allowed = new Set([
    'schemaVersion',
    'experimentId',
    'artifact',
    'title',
    'summary',
    'queryFingerprint',
    'source',
    'sourceVersion',
    'shape',
    'columns',
    'tags',
    'projectId',
    'originSessionId',
    'originAgentKind',
    'rootAgentId',
    'toolCallId',
    'pluginVersion',
    'createdAt',
    'updatedAt',
    'index',
  ])
  rejectUnknown(value, allowed, 'experiment card')
  if (!isRecord(value.artifact) || !isRecord(value.index)) {
    throw new ArtifactMemoryError('VALIDATION', 'experiment card nested values are invalid')
  }
  rejectUnknown(
    value.artifact,
    new Set(['schemaVersion', 'artifactId', 'sha256', 'bytes', 'mediaType', 'createdAt']),
    'artifact reference',
  )
  rejectUnknown(
    value.index,
    new Set(['state', 'projectionRevision', 'attempts', 'lastAttemptAt', 'lastErrorCode']),
    'index status',
  )
  if (value.artifact.schemaVersion !== 1)
    throw new ArtifactMemoryError('UNSUPPORTED_VERSION', 'artifact reference version is unsupported')
  const projectId = requiredString(value.projectId, 'project ID')
  if (expectedProjectId !== undefined && projectId !== expectedProjectId) {
    throw new ArtifactMemoryError('INVALID_SCOPE', 'experiment card belongs to another project')
  }
  const artifactId = validateArtifactId(requiredString(value.artifact.artifactId, 'artifact ID'))
  const sha256 = validateSha256('artifact SHA-256', requiredString(value.artifact.sha256, 'artifact SHA-256'))
  if (artifactId !== `art_${base32FromHex(sha256)}`)
    throw new ArtifactMemoryError('VALIDATION', 'artifact ID does not match SHA-256')
  const queryFingerprint = validateSha256(
    'query fingerprint',
    requiredString(value.queryFingerprint, 'query fingerprint'),
  )
  const sourceVersion = requiredString(value.sourceVersion, 'source version')
  const title = requiredString(value.title, 'title')
  const summary = requiredString(value.summary, 'summary')
  const source = requiredString(value.source, 'source')
  const mediaType = requiredString(value.artifact.mediaType, 'media type')
  const shape = optionalString(value.shape, 'shape')
  const columns = optionalStringArray(value.columns, 'columns')
  const tags = optionalStringArray(value.tags, 'tags')
  if (bounds !== undefined) {
    const checked = validateRecordMetadata(
      {
        sourcePath: '',
        title,
        summary,
        queryFingerprint,
        source,
        sourceVersion,
        mediaType,
        ...(shape === undefined ? {} : { shape }),
        ...(columns === undefined ? {} : { columns }),
        ...(tags === undefined ? {} : { tags }),
      },
      bounds,
    )
    if (
      checked.title !== title ||
      checked.summary !== summary ||
      checked.source !== source ||
      checked.sourceVersion !== sourceVersion ||
      checked.mediaType !== mediaType ||
      checked.shape !== shape ||
      JSON.stringify(checked.columns) !== JSON.stringify(columns) ||
      JSON.stringify(checked.tags) !== JSON.stringify(tags)
    ) {
      throw new ArtifactMemoryError('VALIDATION', 'experiment card metadata is not normalized')
    }
  }
  const expectedExperimentId = experimentId({ projectId, artifactId, queryFingerprint, sourceVersion })
  if (validateExperimentId(requiredString(value.experimentId, 'experiment ID')) !== expectedExperimentId) {
    throw new ArtifactMemoryError('VALIDATION', 'experiment ID does not match its identity fields')
  }
  const bytes = safeInteger(value.artifact.bytes, 'artifact bytes', 0)
  const state = requiredString(value.index.state, 'index state') as ArtifactIndexState
  if (!INDEX_STATES.has(state)) throw new ArtifactMemoryError('VALIDATION', 'index state is invalid')
  const card = {
    schemaVersion: 1,
    experimentId: expectedExperimentId,
    artifact: {
      schemaVersion: 1,
      artifactId,
      sha256,
      bytes,
      mediaType,
      createdAt: isoDate(value.artifact.createdAt, 'artifact created time'),
    },
    title,
    summary,
    queryFingerprint,
    source,
    sourceVersion,
    ...(shape === undefined ? {} : { shape }),
    ...(columns === undefined ? {} : { columns }),
    ...(tags === undefined ? {} : { tags }),
    projectId,
    originSessionId: requiredString(value.originSessionId, 'origin session ID'),
    originAgentKind: agentKind(value.originAgentKind),
    ...(optionalString(value.rootAgentId, 'root agent ID') === undefined
      ? {}
      : { rootAgentId: optionalString(value.rootAgentId, 'root agent ID')! }),
    ...(optionalString(value.toolCallId, 'tool call ID') === undefined
      ? {}
      : { toolCallId: optionalString(value.toolCallId, 'tool call ID')! }),
    pluginVersion: requiredString(value.pluginVersion, 'plugin version'),
    createdAt: isoDate(value.createdAt, 'created time'),
    updatedAt: isoDate(value.updatedAt, 'updated time'),
    index: {
      state,
      projectionRevision: safeInteger(value.index.projectionRevision, 'projection revision', 1),
      attempts: safeInteger(value.index.attempts, 'index attempts', 0),
      ...(optionalIsoDate(value.index.lastAttemptAt, 'last attempt time') === undefined
        ? {}
        : { lastAttemptAt: optionalIsoDate(value.index.lastAttemptAt, 'last attempt time')! }),
      ...(optionalString(value.index.lastErrorCode, 'last error code') === undefined
        ? {}
        : { lastErrorCode: optionalString(value.index.lastErrorCode, 'last error code')! }),
    },
  } satisfies ExperimentCardV1
  return deepFreeze(card)
}

function base32FromHex(value: string): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz234567'
  let bits = 0
  let accumulator = 0
  let output = ''
  for (const byte of Buffer.from(value, 'hex')) {
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function rejectUnknown(value: Record<string, unknown>, allowed: ReadonlySet<string>, label: string): void {
  if (Object.keys(value).some((key) => !allowed.has(key)))
    throw new ArtifactMemoryError('VALIDATION', `${label} has unknown fields`)
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0)
    throw new ArtifactMemoryError('VALIDATION', `${label} is invalid`)
  return value
}

function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined
  return requiredString(value, label)
}

function optionalStringArray(value: unknown, label: string): readonly string[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || item.length === 0)) {
    throw new ArtifactMemoryError('VALIDATION', `${label} is invalid`)
  }
  return Object.freeze([...value]) as readonly string[]
}

function safeInteger(value: unknown, label: string, minimum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum)
    throw new ArtifactMemoryError('VALIDATION', `${label} is invalid`)
  return value as number
}

function isoDate(value: unknown, label: string): string {
  const text = requiredString(value, label)
  if (!Number.isFinite(Date.parse(text))) throw new ArtifactMemoryError('VALIDATION', `${label} is invalid`)
  return text
}

function optionalIsoDate(value: unknown, label: string): string | undefined {
  return value === undefined ? undefined : isoDate(value, label)
}

function agentKind(value: unknown): 'root' | 'child' {
  if (value !== 'root' && value !== 'child') throw new ArtifactMemoryError('VALIDATION', 'origin agent kind is invalid')
  return value
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value
  for (const member of Object.values(value)) deepFreeze(member)
  return Object.freeze(value)
}
