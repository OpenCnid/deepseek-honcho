import { fileURLToPath } from 'node:url'
import { resumeLiveEvaluation } from './live-evaluation.ts'

if (process.env.HONCHO_LIVE_TEST !== '1' || process.env.HONCHO_LIVE_RESUME !== '1') {
  throw new Error('HONCHO_LIVE_TEST=1 and HONCHO_LIVE_RESUME=1 are required for the opt-in live resume')
}

try {
  const outcome = await resumeLiveEvaluation({
    apiKey: process.env.HONCHO_API_KEY ?? '',
    manifestPath: fileURLToPath(new URL('../evaluation-results/live-resource-manifest.json', import.meta.url)),
  })
  console.log(
    `live resume: ${outcome.passed} passed, ${outcome.failed} failed; existing synthetic resources reused and no content emitted`,
  )
  if (outcome.failed > 0) process.exitCode = 1
} catch (error: unknown) {
  console.error(`live resume failed (${safeErrorClass(error)}); no remote error or content emitted`)
  process.exitCode = 1
}

function safeErrorClass(error: unknown): string {
  if (!(error instanceof Error)) return 'NON_ERROR'
  return /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(error.name) ? error.name : 'ERROR'
}
