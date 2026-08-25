import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const frontendDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const repoDir = path.dirname(path.dirname(frontendDir))
const kind = process.argv[2]
const target =
  process.env.DEPLOY_TARGET ||
  (process.env.NODE_ENV === 'production' ? 'optimism' : 'local')
const suffix =
  target === 'sepolia'
    ? 'sepolia'
    : process.env.NODE_ENV === 'production'
      ? 'production'
      : 'development'

if (!['config', 'networks'].includes(kind)) {
  throw new Error('Usage: link-deployment-config.mjs <config|networks>')
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
