import { runLiveEvaluation } from './live-evaluation.ts'

if (process.env.HONCHO_LIVE_TEST !== '1') {
  throw new Error('HONCHO_LIVE_TEST=1 is required for the opt-in live evaluation')
}
if (process.env.HONCHO_LIVE_PROVISION !== '1') {
  throw new Error('HONCHO_LIVE_PROVISION=1 is required to create isolated synthetic evaluation workspaces')
}

try {
  const outcome = await runLiveEvaluation({
    apiKey: process.env.HONCHO_API_KEY ?? '',
    baseURL: process.env.HONCHO_BASE_URL ?? 'https://api.honcho.dev',
    ...(process.env.HONCHO_LIVE_PROCESSING_TIMEOUT_MS === undefined
      ? {}
      : { processingTimeoutMs: Number(process.env.HONCHO_LIVE_PROCESSING_TIMEOUT_MS) }),
  })

  console.log(
    `live evaluation: ${outcome.passed} passed, ${outcome.failed} failed; content-free report and cleanup manifest written`,
  )
  if (outcome.failed > 0) process.exitCode = 1
} catch (error: unknown) {
  console.error(`live evaluation failed (${safeErrorClass(error)}); no remote error or content emitted`)
  process.exitCode = 1
}

function safeErrorClass(error: unknown): string {
  if (!(error instanceof Error)) return 'NON_ERROR'
  return /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(error.name) ? error.name : 'ERROR'
}
