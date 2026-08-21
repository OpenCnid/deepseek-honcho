import { readFile } from 'node:fs/promises'

interface Upstream {
  name: string
  revision: string
  version?: string
  copiedSource: boolean
}

const expected = new Map([
  ['DeepSeek Harness', '99f6f02fecdb7dff40c3fbc9470f5907c29f74ca'],
  ['Honcho', 'ddbb90e36f2d148c7982f6ed85b09d31cabf5944'],
  ['@honcho-ai/sdk', 'ddbb90e36f2d148c7982f6ed85b09d31cabf5944'],
])
const document = JSON.parse(await readFile(new URL('../provenance/upstreams.json', import.meta.url), 'utf8')) as {
  schemaVersion: number
  upstreams: Upstream[]
}
if (document.schemaVersion !== 1) throw new Error('unsupported provenance schema')
for (const [name, revision] of expected) {
  const row = document.upstreams.find((candidate) => candidate.name === name)
  if (row?.revision !== revision) throw new Error(`provenance mismatch for ${name}`)
}
const sdk = document.upstreams.find((row) => row.name === '@honcho-ai/sdk')
if (sdk?.version !== '2.3.0') throw new Error('SDK must remain pinned to 2.3.0')
if (document.upstreams.some((row) => row.copiedSource))
  throw new Error('copied upstream source requires a renewed license review')
console.log('provenance: pinned revisions, SDK version, and no-copy boundary verified')
