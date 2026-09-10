import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import environmentLoader from '../../../scripts/load-env.cjs'
import {
  chainProfile,
  resolveDeploymentProfile,
} from './deployment-profile.mjs'

const thisFile = fileURLToPath(import.meta.url)
const defaultIndexerDir = path.dirname(path.dirname(thisFile))
const defaultRepoDir = path.dirname(path.dirname(defaultIndexerDir))

/**
 * Point `packages/indexer/networks.json` at the catalog for the selected target. The catalog file
 * is `config/networks.<target>.json` for every public chain and the generated
 * `config/networks.development.json` locally; the profile table owns that mapping, so a new chain
 * needs no change here. Idempotent: the link is replaced on every call.
 */
export function linkNetworks({
  target,
  repoDir = defaultRepoDir,
  indexerDir = defaultIndexerDir,
  allowDevelopmentTemplate = false,
} = {}) {
  const profile = chainProfile(target)
  const generatedSource = path.join(repoDir, profile.networksFile)
  const source =
    !profile.public &&
    allowDevelopmentTemplate &&
    !fs.existsSync(generatedSource)
      ? path.join(repoDir, 'config', 'networks.development.template.json')
      : generatedSource
  const destination = path.join(indexerDir, 'networks.json')

  if (!fs.existsSync(source)) {
    throw new Error(
      `Missing ${source}. Generate or deploy the ${profile.target} network catalog before starting the indexer.`
    )
  }

  try {
    fs.unlinkSync(destination)
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }

  fs.symlinkSync(path.relative(indexerDir, source), destination)
  return { source, destination }
}

const isMainModule =
  process.argv[1] !== undefined && path.resolve(process.argv[1]) === thisFile

if (isMainModule) {
  const { loadTargetEnvironment } = environmentLoader
  loadTargetEnvironment({
    repositoryRoot: defaultRepoDir,
    createBaseFrom: '.env.example',
  })
  const profile = resolveDeploymentProfile(process.env, defaultRepoDir)
  const { source } = linkNetworks({
    target: profile.target,
    allowDevelopmentTemplate: process.argv.includes(
      '--allow-development-template'
    ),
  })
  console.log(`indexer: using ${path.relative(defaultRepoDir, source)}`)
}
