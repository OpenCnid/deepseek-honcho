import { lstat, realpath } from 'node:fs/promises'
import { isAbsolute, parse, posix, relative, resolve, sep, win32 } from 'node:path'
import { ArtifactMemoryError } from './errors.ts'

export type PathFlavor = 'posix' | 'win32'

/** Component-aware containment for native and cross-platform test vectors. */
export function pathContained(
  root: string,
  candidate: string,
  flavor: PathFlavor = process.platform === 'win32' ? 'win32' : 'posix',
): boolean {
  const api = flavor === 'win32' ? win32 : posix
  const rootPath = api.resolve(root)
  const candidatePath = api.resolve(candidate)
  const rel = api.relative(rootPath, candidatePath)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${api.sep}`) && !api.isAbsolute(rel))
}

export function pathsOverlap(left: string, right: string): boolean {
  return pathContained(left, right) || pathContained(right, left)
}

export function assertSafeAbsolutePath(label: string, value: string): string {
  if (value.length === 0 || value.includes('\0') || !isAbsolute(value)) {
    throw new ArtifactMemoryError('INVALID_PATH', `${label} must be a safe absolute path`)
  }
  if (process.platform === 'win32') {
    const normalized = value.replaceAll('/', '\\')
    if (normalized.startsWith('\\\\') || /^\\\\[?.]\\/.test(normalized)) {
      throw new ArtifactMemoryError('INVALID_PATH', `${label} must not be a device or network path`)
    }
    const root = win32.parse(normalized).root
    if (normalized.slice(root.length).includes(':')) {
      throw new ArtifactMemoryError('INVALID_PATH', `${label} must not contain an alternate data stream`)
    }
  }
  return resolve(value)
}

export function assertInside(root: string, candidate: string, message = 'path escaped its authorized root'): void {
  const rel = relative(root, candidate)
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new ArtifactMemoryError('INVALID_PATH', message)
  }
}

/** Reject any existing symlink or junction in a path before trusting realpath. */
export async function rejectLinksInExistingPath(target: string): Promise<void> {
  const absolute = resolve(target)
  const root = parse(absolute).root
  const parts = absolute.slice(root.length).split(sep).filter(Boolean)
  let cursor = root
  for (const part of parts) {
    cursor = resolve(cursor, part)
    try {
      const info = await lstat(cursor)
      if (info.isSymbolicLink()) {
        throw new ArtifactMemoryError('UNSAFE_FILESYSTEM_ENTRY', 'filesystem path contains a symlink or reparse point')
      }
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
  }
}

export async function assertCanonicalInside(root: string, candidate: string): Promise<void> {
  const [canonicalRoot, canonicalCandidate] = await Promise.all([realpath(root), realpath(candidate)])
  assertInside(canonicalRoot, canonicalCandidate, 'canonical path escaped its authorized root')
}
