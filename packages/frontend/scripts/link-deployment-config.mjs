import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import environmentLoader from '../../../scripts/load-env.cjs'

const frontendDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const repoDir = path.dirname(path.dirname(frontendDir))
const kind = process.argv[2]
const { loadTargetEnvironment } = environmentLoader
const { target } = loadTargetEnvironment({
  repositoryRoot: repoDir,
  target: process.env.DEPLOY_TARGET,
  higherPriorityFiles: [path.join(frontendDir, '.env.local')],
  createBaseFrom: '.env.example',
  requireTargetOverlay: false,
  fromProcess: process.env.VERCEL === '1',
})
const suffix = target === 'sepolia' ? 'sepolia' : 'development'

if (!['config', 'networks'].includes(kind)) {
  throw new Error('Usage: link-deployment-config.mjs <config|networks>')
}
if (!['local', 'sepolia'].includes(target)) {
  throw new Error('DEPLOY_TARGET must be local or sepolia for the frontend')
}

const generatedSource =
  kind === 'config'
    ? path.join(frontendDir, `config.${suffix}.json`)
    : path.join(repoDir, 'config', `networks.${suffix}.json`)
const allowTypecheckTemplate = process.argv.includes(
  '--allow-typecheck-template'
)
const source =
  target === 'local' &&
  suffix === 'development' &&
  allowTypecheckTemplate &&
  !fs.existsSync(generatedSource)
    ? kind === 'config'
      ? path.join(frontendDir, 'config.typecheck.json')
      : path.join(repoDir, 'config', 'networks.development.template.json')
    : generatedSource
const destination = path.join(frontendDir, `${kind}.json`)
if (!fs.existsSync(source)) {
  throw new Error(
    `Missing ${source}; generate the ${target} frontend configuration first`
  )
}
try {
  fs.unlinkSync(destination)
} catch (error) {
  if (error.code !== 'ENOENT') throw error
}
fs.symlinkSync(path.relative(frontendDir, source), destination)
console.log(`frontend: ${kind}.json -> ${path.relative(frontendDir, source)}`)
