export type ArtifactMemoryErrorCode =
  | 'INVALID_CONFIG'
  | 'INVALID_SCOPE'
  | 'INVALID_PATH'
  | 'UNSAFE_FILESYSTEM_ENTRY'
  | 'NOT_REGULAR_FILE'
  | 'FILE_MUTATED'
  | 'ARTIFACT_TOO_LARGE'
  | 'PROJECT_QUOTA_EXCEEDED'
  | 'CARD_QUOTA_EXCEEDED'
  | 'VALIDATION'
  | 'UNSUPPORTED_VERSION'
  | 'CARD_NOT_FOUND'
  | 'ARTIFACT_MISSING'
  | 'ARTIFACT_CORRUPT'
  | 'REMOTE_PROJECTION_EMPTY'
  | 'REMOTE_QUEUE_FAILED'
  | 'DISPOSED'

/** Stable artifact failure without paths or content in its message. */
export class ArtifactMemoryError extends HarnessError {
  constructor(
    override readonly code: ArtifactMemoryErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, code, options)
    this.name = 'ArtifactMemoryError'
  }
}
import { HarnessError } from '@deepseek-ai/dsh-llm'
