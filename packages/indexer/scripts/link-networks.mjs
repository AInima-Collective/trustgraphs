import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import dotenv from 'dotenv'

const indexerDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const repoDir = path.dirname(path.dirname(indexerDir))

dotenv.config({ path: path.join(repoDir, '.env'), quiet: true })

const deployment = process.env.DEPLOY_ENV?.trim().toUpperCase()
if (deployment !== 'DEV' && deployment !== 'PROD') {
  throw new Error(
    'DEPLOY_ENV must be DEV or PROD before linking indexer networks'
  )
}

const environment = deployment === 'PROD' ? 'production' : 'development'
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
