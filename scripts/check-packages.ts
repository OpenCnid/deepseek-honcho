import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const packageDirs = ['honcho', 'honcho-sdk', 'agent-memory', 'tool-memory', 'bundle']
const expectedNames = new Set([
  '@deepseek-honcho/dsh-honcho',
  '@deepseek-honcho/dsh-honcho-sdk',
  '@deepseek-honcho/dsh-agent-memory',
  '@deepseek-honcho/dsh-tool-memory',
  '@deepseek-honcho/dsh-honcho-bundle',
])
const pnpmCli = process.env.npm_execpath
if (pnpmCli === undefined) throw new Error('check:packages must run through pinned pnpm')

interface PackResult {
  name: string
  filename: string
  files: { path: string }[]
}

function pnpm(args: string[], cwd = workspaceRoot): string {
  const result = spawnSync(process.execPath, [pnpmCli, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, CI: '1' },
  })
  if (result.status !== 0) {
    throw new Error(`pnpm ${args.join(' ')} failed\n${result.stdout}\n${result.stderr}`)
  }
  return result.stdout.trim()
}

const temporaryRoot = await mkdtemp(join(tmpdir(), 'deepseek-honcho-package-check-'))
if (!resolve(temporaryRoot).startsWith(`${resolve(tmpdir())}${sep}`)) {
  throw new Error('unsafe temporary package-check path')
}
try {
  const archives = new Map<string, string>()
  for (const directory of packageDirs) {
    const packageRoot = join(workspaceRoot, 'packages', directory)
    const manifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8')) as {
      name: string
      license: string
      type: string
      files: string[]
      dependencies?: Record<string, string>
    }
    if (!expectedNames.delete(manifest.name)) throw new Error(`unexpected package name: ${manifest.name}`)
    if (manifest.license !== 'Apache-2.0' || manifest.type !== 'module')
      throw new Error(`unsafe package metadata: ${manifest.name}`)
    if (!manifest.files.some((entry) => entry.startsWith('lib/')))
      throw new Error(`missing artifact allowlist: ${manifest.name}`)
    if (manifest.name === '@deepseek-honcho/dsh-honcho-sdk' && manifest.dependencies?.['@honcho-ai/sdk'] !== '2.3.0') {
      throw new Error('SDK provider dependency is not exactly 2.3.0')
    }
    const packed = JSON.parse(
      pnpm(['--dir', packageRoot, 'pack', '--pack-destination', temporaryRoot, '--json']),
    ) as PackResult
    if (packed.name !== manifest.name) throw new Error(`packed name mismatch: ${manifest.name}`)
    for (const file of packed.files) {
      if (
        file.path !== 'LICENSE' &&
        file.path !== 'README.md' &&
        file.path !== 'package.json' &&
        !/^lib\/.+\.(?:js|d\.ts)$/.test(file.path)
      ) {
        throw new Error(`unexpected packed file in ${manifest.name}: ${file.path}`)
      }
    }
    for (const required of ['LICENSE', 'README.md', 'package.json', 'lib/index.js', 'lib/index.d.ts']) {
      if (!packed.files.some((file) => file.path === required)) {
        throw new Error(`missing packed file in ${manifest.name}: ${required}`)
      }
    }
    archives.set(manifest.name, packed.filename)
  }
  if (expectedNames.size > 0) throw new Error(`missing packages: ${[...expectedNames].join(', ')}`)

  const dependencies = Object.fromEntries([...archives].map(([name, filename]) => [name, pathToFileURL(filename).href]))
  Object.assign(dependencies, {
    '@deepseek-ai/cordis': '4.0.1',
    '@deepseek-ai/schemastery': '3.18.1',
    '@deepseek-ai/dsh-agent': '0.1.0-rc.7',
    '@deepseek-ai/dsh-llm': '0.1.0-rc.7',
    '@deepseek-ai/dsh-session': '0.1.0-rc.7',
    '@deepseek-ai/dsh-system-prompt': '0.1.0-rc.7',
    '@deepseek-ai/dsh-tools': '0.1.0-rc.7',
  })
  await writeFile(
    join(temporaryRoot, 'package.json'),
    `${JSON.stringify(
      {
        name: 'deepseek-honcho-isolated-check',
        private: true,
        type: 'module',
        dependencies,
      },
      null,
      2,
    )}\n`,
  )
  await writeFile(
    join(temporaryRoot, 'pnpm-workspace.yaml'),
    [
      'packages: []',
      'overrides:',
      ...[...archives].map(
        ([name, filename]) => `  ${JSON.stringify(name)}: ${JSON.stringify(pathToFileURL(filename).href)}`,
      ),
      '',
    ].join('\n'),
  )
  const replacements = Object.fromEntries([...archives].map(([name, filename]) => [name, pathToFileURL(filename).href]))
  const pnpmfile = join(temporaryRoot, '.pnpmfile.cjs')
  await writeFile(
    pnpmfile,
    [
      `'use strict'`,
      `const replacements = ${JSON.stringify(replacements)}`,
      `module.exports = { hooks: { readPackage(pkg) {`,
      `  for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies']) {`,
      `    if (pkg[field] === undefined) continue`,
      `    for (const [name, value] of Object.entries(replacements)) {`,
      `      if (pkg[field][name] !== undefined) pkg[field][name] = value`,
      `    }`,
      `  }`,
      `  return pkg`,
      `} } }`,
      '',
    ].join('\n'),
  )
  pnpm(
    [`--config.pnpmfile=${pnpmfile}`, 'install', '--prefer-offline', '--ignore-scripts', '--frozen-lockfile=false'],
    temporaryRoot,
  )
  const smoke = [
    "const bundle = await import('@deepseek-honcho/dsh-honcho-bundle')",
    "const seam = await import('@deepseek-honcho/dsh-honcho')",
    "if (bundle.name !== 'deepseek-honcho' || bundle.Config === undefined) throw new Error('bundle import failed')",
    "if (typeof seam.honchoSessionId !== 'function') throw new Error('service import failed')",
    "console.log('isolated package imports passed')",
  ].join(';')
  const result = spawnSync(process.execPath, ['--input-type=module', '--eval', smoke], {
    cwd: temporaryRoot,
    encoding: 'utf8',
  })
  if (result.status !== 0) throw new Error(`isolated import failed\n${result.stdout}\n${result.stderr}`)
  if (!result.stdout.includes('isolated package imports passed')) throw new Error('isolated import emitted no proof')
  console.log('packages: five tarballs inspected and imported in an isolated install')
} finally {
  await rm(temporaryRoot, { recursive: true, force: true })
}
