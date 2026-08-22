/** Portable immutable artifact reference. Local paths never enter this value. */
export interface ArtifactRefV1 {
  readonly schemaVersion: 1
  readonly artifactId: string
  readonly sha256: string
  readonly bytes: number
  readonly mediaType: string
  readonly createdAt: string
}

export type ArtifactIndexState = 'pending' | 'queued' | 'indexed' | 'failed' | 'disabled'

export interface ArtifactIndexStatusV1 {
  readonly state: ArtifactIndexState
  readonly projectionRevision: number
  readonly attempts: number
  readonly lastAttemptAt?: string
  readonly lastErrorCode?: string
}

/** Complete project-local experiment card. */
export interface ExperimentCardV1 {
  readonly schemaVersion: 1
  readonly experimentId: string
  readonly artifact: ArtifactRefV1
  readonly title: string
  readonly summary: string
  readonly queryFingerprint: string
  readonly source: string
  readonly sourceVersion: string
  readonly shape?: string
  readonly columns?: readonly string[]
  readonly tags?: readonly string[]
  readonly projectId: string
  readonly originSessionId: string
  readonly originAgentKind: 'root' | 'child'
  readonly rootAgentId?: string
  readonly toolCallId?: string
  readonly pluginVersion: string
  readonly createdAt: string
  readonly updatedAt: string
  readonly index: ArtifactIndexStatusV1
}

export interface ArtifactAuthority {
  readonly projectId: string
  readonly dshSessionId: string
  readonly agentKind: 'root' | 'child'
  readonly rootAgentId?: string
  readonly toolCallId?: string
}

export interface ArtifactRecordInput {
  readonly sourcePath: string
  readonly title: string
  readonly summary: string
  readonly queryFingerprint: string
  readonly source: string
  readonly sourceVersion: string
  readonly mediaType?: string
  readonly tags?: readonly string[]
  readonly shape?: string
  readonly columns?: readonly string[]
}

export interface ArtifactRecordResult {
  readonly card: ExperimentCardV1
  readonly deduplicated: boolean
}

export type ArtifactFreshness = 'fresh' | 'stale' | 'unverifiable' | 'not_checked'

export interface ArtifactResolveResult {
  readonly path: string
  readonly card: ExperimentCardV1
  readonly freshness: ArtifactFreshness
  readonly verifiedAt: string
  readonly warning?: string
}

export interface ArtifactSearchHit {
  readonly kind: 'experiment-card'
  readonly experimentId: string
  readonly artifactId: string
  readonly title: string
  readonly summary: string
  readonly queryFingerprint: string
  readonly source: string
  readonly sourceVersion: string
  readonly shape?: string
  readonly columns?: readonly string[]
  readonly tags?: readonly string[]
  readonly createdAt: string
  readonly updatedAt: string
  readonly indexState: ArtifactIndexState
  readonly localAvailable: boolean
  readonly match: 'experiment-id' | 'artifact-id' | 'query-fingerprint' | 'tag' | 'source-version' | 'lexical'
  readonly trust: 'untrusted-card'
  readonly sourceKind: 'local' | 'honcho'
}

export interface ArtifactStoreStatus {
  readonly enabled: true
  readonly schemaVersion: 1
  readonly objectCount: number
  readonly objectBytes: number
  readonly cardCount: number
  readonly invalidCardCount: number
  readonly tempCount: number
  readonly indexStates: Readonly<Record<ArtifactIndexState, number>>
  readonly integrityMode: 'cached' | 'always'
}
