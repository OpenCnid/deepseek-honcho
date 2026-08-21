import { cleanupLiveEvaluation } from './live-evaluation.ts'
import { fileURLToPath } from 'node:url'

if (process.env.HONCHO_LIVE_CLEANUP !== '1') {
  throw new Error('HONCHO_LIVE_CLEANUP=1 is required for destructive synthetic workspace cleanup')
}

try {
  const completed = await cleanupLiveEvaluation({
    apiKey: process.env.HONCHO_API_KEY ?? '',
    manifestPath: fileURLToPath(new URL('../evaluation-results/live-resource-manifest.json', import.meta.url)),
  })

  console.log(
    `live cleanup: ${completed.workspaces.length} fenced synthetic workspaces submitted and absence verified; no content emitted`,
  )
} catch (error: unknown) {
  console.error(`live cleanup failed (${safeErrorClass(error)}); no remote error or content emitted`)
  process.exitCode = 1
}

function safeErrorClass(error: unknown): string {
  if (!(error instanceof Error)) return 'NON_ERROR'
  return /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(error.name) ? error.name : 'ERROR'
}
