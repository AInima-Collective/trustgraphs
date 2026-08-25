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
const source = path.join(repoDir, 'config', `networks.${environment}.json`)
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
console.log(`indexer: using config/networks.${environment}.json`)
