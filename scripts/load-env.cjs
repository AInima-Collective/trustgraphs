const fs = require('node:fs')
const path = require('node:path')

const dotenv = require('dotenv')

const TARGET_PATTERN = /^[a-z][a-z0-9-]*$/

const environmentEntries = (environment) =>
  Object.fromEntries(
    Object.entries(environment).filter((entry) => typeof entry[1] === 'string')
  )

const parseFile = (file, { required }) => {
  if (!fs.existsSync(file)) {
    if (required) throw new Error(`Missing environment file ${file}`)
    return {}
  }

  try {
    return dotenv.parse(fs.readFileSync(file))
  } catch (error) {
    throw new Error(`Could not load environment file ${file}: ${error.message}`)
  }
}

const normalizedTarget = (value) => {
  const target = value?.trim().toLowerCase() || 'local'
  if (!TARGET_PATTERN.test(target)) {
    throw new Error(`Invalid DEPLOY_TARGET for environment overlay: ${value}`)
  }
  return target
}

/**
 * Load the repository environment without turning the shared checkout into a global chain switch.
 *
 * Precedence, from highest to lowest, is the environment inherited by this process, the selected
 * public-chain overlay, caller-owned files such as the indexer's `.env.local`, then `.env`.
 * `.env` therefore remains safe local defaults while `DEPLOY_TARGET=sepolia` opts into secrets and
 * endpoints held in the ignored `.env.sepolia` file. A public target without its overlay fails
 * closed instead of quietly borrowing local or another chain's values. Hosted images can set
 * `TRUSTGRAPHS_ENV_FROM_PROCESS=1` to skip every file; their entry points remain responsible for
 * validating all required process variables.
 */
function loadTargetEnvironment({
  repositoryRoot,
  environment = process.env,
  higherPriorityFiles = [],
  target: requestedTarget,
  createBaseFrom,
  fromProcess = false,
} = {}) {
  if (!repositoryRoot) throw new Error('repositoryRoot is required')

  const inherited = environmentEntries(environment)
  const processOnly =
    fromProcess || inherited.TRUSTGRAPHS_ENV_FROM_PROCESS === '1'
  if (processOnly) {
    const target = normalizedTarget(requestedTarget ?? inherited.DEPLOY_TARGET)
    const resolved = { ...inherited, DEPLOY_TARGET: target }
    Object.assign(environment, resolved)
    return {
      environment: resolved,
      parsed: resolved,
      target,
      files: [],
    }
  }

  const baseFile = path.join(repositoryRoot, '.env')
  if (!fs.existsSync(baseFile) && createBaseFrom) {
    const exampleFile = path.resolve(repositoryRoot, createBaseFrom)
    if (!fs.existsSync(exampleFile)) {
      throw new Error(`Example environment file ${exampleFile} does not exist`)
    }
    fs.copyFileSync(exampleFile, baseFile)
  }

  const base = parseFile(baseFile, { required: true })
  const higherPriority = Object.assign(
    {},
    ...higherPriorityFiles.map((file) =>
      parseFile(path.resolve(file), { required: false })
    )
  )
  const target = normalizedTarget(
    requestedTarget ??
      inherited.DEPLOY_TARGET ??
      higherPriority.DEPLOY_TARGET ??
      base.DEPLOY_TARGET
  )
  const overlayFile =
    target === 'local' ? undefined : path.join(repositoryRoot, `.env.${target}`)
  const overlay = overlayFile ? parseFile(overlayFile, { required: true }) : {}
  const resolved = {
    ...base,
    ...higherPriority,
    ...overlay,
    ...inherited,
  }

  // Selection must agree with the file that was loaded. This catches a stale `.env.sepolia`
  // copied from another target without allowing the overlay to override an explicit CLI choice.
  if (
    overlay.DEPLOY_TARGET &&
    normalizedTarget(overlay.DEPLOY_TARGET) !== target
  ) {
    throw new Error(
      `${overlayFile} declares DEPLOY_TARGET=${overlay.DEPLOY_TARGET}, expected ${target}`
    )
  }
  resolved.DEPLOY_TARGET = target

  Object.assign(environment, resolved)
  return {
    environment: resolved,
    parsed: resolved,
    target,
    files: [
      baseFile,
      ...(overlayFile ? [overlayFile] : []),
      ...higherPriorityFiles,
    ],
  }
}

module.exports = { loadTargetEnvironment }
