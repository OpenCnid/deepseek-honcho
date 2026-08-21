import { readdir, readFile } from 'node:fs/promises'
import { extname, relative } from 'node:path'

const root = new URL('..', import.meta.url)
const ignored = new Set(['.git', 'node_modules', 'lib', 'coverage', 'artifacts', 'evaluation-results'])
const textExtensions = new Set([
  '',
  '.ts',
  '.js',
  '.mjs',
  '.cjs',
  '.json',
  '.md',
  '.yaml',
  '.yml',
  '.toml',
  '.env',
  '.example',
])
const forbidden: readonly [string, RegExp][] = [
  ['private key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ['live Honcho key', /(?:hch|honcho)_[A-Za-z0-9]{24,}/i],
  ['authorization bearer value', /authorization\s*[:=]\s*bearer\s+[A-Za-z0-9._-]{12,}/i],
]
const violations: string[] = []

async function walk(directory: URL): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (ignored.has(entry.name)) continue
    const location = new URL(`${entry.name}${entry.isDirectory() ? '/' : ''}`, directory)
    if (entry.isDirectory()) await walk(location)
    else if (textExtensions.has(extname(entry.name)) || entry.name === '.env.example') {
      const text = await readFile(location, 'utf8')
      for (const [label, pattern] of forbidden) {
        if (pattern.test(text)) violations.push(`${relative(root.pathname, location.pathname)}: ${label}`)
      }
    }
  }
}

await walk(root)
if (violations.length > 0) throw new Error(`secret scan failed:\n${violations.join('\n')}`)
console.log('secrets: no private keys, live Honcho keys, or bearer values found')
