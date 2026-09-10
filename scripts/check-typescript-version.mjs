import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const nativeDependency = 'npm:typescript@7.0.2'
const compatibilityDependency = 'npm:@typescript/typescript6@6.0.2'
const compilerVersion = 'Version 7.0.2'
const workspaces = [
  ['root', '.'],
  ['frontend', 'packages/frontend'],
  ['indexer', 'packages/indexer'],
  ['EAS off-chain client', 'packages/eas-offchain-client'],
  ['EAS off-chain relay', 'packages/eas-offchain-relay'],
]

const errors = []

for (const [label, directory] of workspaces) {
  const manifestPath = join(repositoryRoot, directory, 'package.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  const dependencies = manifest.devDependencies ?? {}

  if (dependencies['@typescript/native'] !== nativeDependency) {
    errors.push(
      `${label}: expected @typescript/native=${nativeDependency}, found ${dependencies['@typescript/native'] ?? 'missing'}`
    )
  }
  if (dependencies.typescript !== compatibilityDependency) {
    errors.push(
      `${label}: expected typescript=${compatibilityDependency}, found ${dependencies.typescript ?? 'missing'}`
    )
  }

  const result = spawnSync(
    'pnpm',
    ['--dir', join(repositoryRoot, directory), 'exec', 'tsc', '--version'],
    { encoding: 'utf8' }
  )
  const actualVersion = result.stdout.trim()
  if (result.status !== 0) {
    errors.push(`${label}: failed to run TypeScript (${result.stderr.trim()})`)
  } else if (actualVersion !== compilerVersion) {
    errors.push(`${label}: expected ${compilerVersion}, found ${actualVersion}`)
  }
}

if (errors.length > 0) {
  console.error(['TypeScript workspace version drift:', ...errors].join('\n- '))
  process.exitCode = 1
} else {
  console.log(
    `TypeScript 7.0.2 is pinned and active in all ${workspaces.length} workspaces; TypeScript 6.0.2 supplies the temporary tooling API.`
  )
}
