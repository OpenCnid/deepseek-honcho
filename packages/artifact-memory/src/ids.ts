import { createHash } from 'node:crypto'
import { ArtifactMemoryError } from './errors.ts'

const SHA256 = /^[a-f0-9]{64}$/
const ARTIFACT_ID = /^art_[a-z2-7]{52}$/
const EXPERIMENT_ID = /^exp_[a-z2-7]{52}$/

/** Lower-case RFC 4648 base32 without padding. */
export function base32Url(bytes: Uint8Array): string {
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

/** Canonical JSON with recursively sorted object keys and no unsupported values. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value))
}

function canonicalValue(value: unknown): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value))
      throw new ArtifactMemoryError('VALIDATION', 'canonical JSON contains a non-finite number')
    return value
  }
  if (Array.isArray(value)) return value.map(canonicalValue)
  if (typeof value === 'object') {
    const output: Record<string, unknown> = {}
    for (const key of Object.keys(value).sort()) {
      const member = (value as Record<string, unknown>)[key]
      if (member === undefined) continue
      output[key] = canonicalValue(member)
    }
    return output
  }
  throw new ArtifactMemoryError('VALIDATION', 'canonical JSON contains an unsupported value')
}

export function artifactIdFromSha256(sha256: string): string {
  validateSha256('artifact SHA-256', sha256)
  return `art_${base32Url(Buffer.from(sha256, 'hex'))}`
}

export function experimentId(input: {
  readonly projectId: string
  readonly artifactId: string
  readonly queryFingerprint: string
  readonly sourceVersion: string
}): string {
  validateArtifactId(input.artifactId)
  validateSha256('query fingerprint', input.queryFingerprint)
  const identity = canonicalJson({
    artifactId: input.artifactId,
    projectId: input.projectId,
    queryFingerprint: input.queryFingerprint,
    schemaVersion: 1,
    sourceVersion: input.sourceVersion,
  })
  return `exp_${base32Url(createHash('sha256').update(identity, 'utf8').digest())}`
}

export function projectKey(projectId: string): string {
  if (projectId.length === 0) throw new ArtifactMemoryError('INVALID_CONFIG', 'project ID must not be empty')
  return base32Url(createHash('sha256').update(projectId, 'utf8').digest())
}

export function validateSha256(label: string, value: string): string {
  if (!SHA256.test(value)) throw new ArtifactMemoryError('VALIDATION', `${label} must be a lowercase SHA-256 digest`)
  return value
}

export function validateArtifactId(value: string): string {
  if (!ARTIFACT_ID.test(value)) throw new ArtifactMemoryError('VALIDATION', 'artifact ID is invalid')
  return value
}

export function validateExperimentId(value: string): string {
  if (!EXPERIMENT_ID.test(value)) throw new ArtifactMemoryError('VALIDATION', 'experiment ID is invalid')
  return value
}
