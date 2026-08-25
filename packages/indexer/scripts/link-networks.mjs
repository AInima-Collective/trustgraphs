import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import environmentLoader from '../../../scripts/load-env.cjs'
import { resolveDeploymentProfile } from './deployment-profile.mjs'

const indexerDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const repoDir = path.dirname(path.dirname(indexerDir))
const { loadTargetEnvironment } = environmentLoader

loadTargetEnvironment({
  repositoryRoot: repoDir,
  createBaseFrom: '.env.example',
})

const profile = resolveDeploymentProfile(process.env, repoDir)
const environment =
  profile.target === 'local'
    ? 'development'
    : profile.target === 'sepolia'
      ? 'sepolia'
      : 'production'
const generatedSource = path.join(
  repoDir,
  'config',
  `networks.${environment}.json`
)
const allowDevelopmentTemplate = process.argv.includes(
  '--allow-development-template'
)
const source =
  profile.target === 'local' &&
  allowDevelopmentTemplate &&
  !fs.existsSync(generatedSource)
    ? path.join(repoDir, 'config', 'networks.development.template.json')
    : generatedSource
const destination = path.join(indexerDir, 'networks.json')

if (!fs.existsSync(source)) {
  throw new Error(
    `Missing ${source}. Generate or deploy the ${environment} network catalog before starting the indexer.`
  )
}

try {
  fs.unlinkSync(destination)
} catch (error) {
  if (error.code !== 'ENOENT') throw error
}

fs.symlinkSync(path.relative(indexerDir, source), destination)
console.log(`indexer: using ${path.relative(repoDir, source)}`)
