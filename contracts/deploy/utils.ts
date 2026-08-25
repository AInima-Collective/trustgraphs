import { spawn } from 'child_process'
import fs from 'fs'
import path from 'path'

import { keccak_256 } from '@noble/hashes/sha3.js'
import chalk, { ChalkInstance } from 'chalk'
import dotenv, { DotenvParseOutput } from 'dotenv'
import { get } from 'lodash'
import { isAddress } from 'viem'

import { Network } from './types'

// Deployment helpers moved from `<repo>/deploy` to `<repo>/contracts/deploy`.
// Keep the root-owned environment files anchored to the repository rather than to the deployment
// source directory.
const REPOSITORY_ROOT = path.resolve(__dirname, '../..')

/**
 * Loads the environment variables from the .env file, creating from the
 * .env.example file if it doesn't exist.
 *
 * @returns The environment variables
 */
export const loadDotenv = (): DotenvParseOutput => {
  const envFile = path.join(REPOSITORY_ROOT, '.env')
  if (!fs.existsSync(envFile)) {
    const exampleEnvFile = path.join(REPOSITORY_ROOT, '.env.example')
    if (!fs.existsSync(exampleEnvFile)) {
      throw new Error(
        `Example environment file ${exampleEnvFile} does not exist.`
      )
    }
    fs.copyFileSync(exampleEnvFile, envFile)
  }

  const { error, parsed } = dotenv.config({ path: envFile, quiet: true })
  if (error) {
    throw new Error(`Error loading .env file: ${error.message}`)
  }
  if (!parsed) {
    throw new Error('No environment variables loaded from .env file')
  }

  return parsed
}

/**
 * Reads a file and returns the contents as a string.
 *
 * @param file - The file to read
 * @returns The contents of the file as a string
 */
export const readFile = (file: string): string => {
  const filePath = path.resolve(file)

  if (!fs.existsSync(filePath)) {
    throw new Error(`File ${filePath} does not exist`)
  }

  return fs.readFileSync(filePath, 'utf8')
}

/**
 * Reads a JSON file and returns the object. Throws an error if the file does
 * not exist.
 *
 * @param file - The file to read
 * @returns The JSON object
 */
export const readJson = <T = any>(file: string): T => JSON.parse(readFile(file))

/**
 * Reads a JSON file and returns the object. Returns undefined if the file does
 * not exist. Throws an error if the file exists but another error occurs.
 *
 * @param file - The file to read
 * @returns The JSON object or undefined if the file does not exist
 */
export const readJsonIfFileExists = <T = any>(file: string): T | undefined =>
  fs.existsSync(file) ? readJson<T>(file) : undefined

/**
 * Reads a JSON file and returns the value of a key from the object. The key is a JSON path.
 *
 * @param file - The file to read
 * @param keyPath - The JSON path to the key
 * @returns The value of the key
 */
export const readJsonKey = <T = any>(file: string, keyPath: string): T => {
  const json = readJson(file)
  return get(json, keyPath) as T
}

/**
 * Reads a JSON file (if it exists) and returns the value of a key from the
 * object. The key is a JSON path. Returns undefined if the file does not exist.
 *
 * @param file - The file to read
 * @param keyPath - The JSON path to the key
 * @returns The value of the key or undefined if the file does not exist
 */
export const readJsonKeyIfFileExists = <T = any>(
  file: string,
  keyPath: string
): T | undefined => {
  const json = readJsonIfFileExists(file)
  if (json) {
    return get(json, keyPath) as T
  }
  return undefined
}

/**
 * Strip credentials out of a command line before it is printed.
 *
 * Private keys are already safe here by construction: they are passed as the literal string
 * `"$FUNDED_KEY"` for the shell to expand, so what gets echoed is the variable name. Endpoint
 * URLs are not, because they are interpolated, and a provider URL usually carries an API key in
 * its path. That put a working credential into every deploy log, transcript and screenshot,
 * which is a slow leak rather than a loud one. Keep the host so the line still says which
 * provider and which network, and drop everything after it.
 */
export const redactSecrets = (line: string): string =>
  line.replace(
    /(https?:\/\/[^/\s"']+)([^\s"']*)/g,
    (_match, origin: string, rest: string) =>
      rest ? `${origin}/<redacted>` : origin
  )

/**
 * Executes a command and returns a promise that resolves when the command
 * completes (with the stdout) or rejects with the status code if the command
 * fails. Stdout and stderr are both logged to the console if log is true.
 *
 * @param cmd - The command to execute (string or string array)
 * @param log - Whether to log the command and its output to the console
 * @param env - The environment variables to set for the command
 * @param shell - Whether to spawn the command in a shell (auto-expand * into
 *                paths, environment variables, etc.) (default: false)
 * @returns A promise that resolves when the command completes or rejects if the
 * command fails. The stdout of the command is returned as a string.
 */
export const execFull = ({
  cmd,
  log = 'all',
  logColor = chalk.blueBright,
  env,
  shell = false,
}: {
  cmd: string[]
  log?: 'cmd' | 'all' | 'none'
  logColor?: ChalkInstance
  env?: Record<string, string>
  shell?: boolean
}): Promise<string> =>
  new Promise((resolve, reject) => {
    const command = cmd[0]
    const args = cmd.slice(1)

    if (log === 'cmd' || log === 'all') {
      console.log(chalk.gray(`$ ${redactSecrets(cmd.join(' '))}`))
    }

    const childProcess = spawn(command, args, {
      stdio: 'pipe',
      env: {
        ...process.env,
        ...env,
      },
      shell,
    })

    let stdout = ''
    childProcess.stdout.on('data', (data) => {
      const line = data.toString()
      stdout += line
      if (log === 'all') {
        process.stdout.write(logColor(line))
      }
    })

    let stderr = ''
    childProcess.stderr.on('data', (data) => {
      const line = data.toString()
      stderr += line
      if (log === 'all') {
        process.stdout.write(chalk.redBright(line))
      }
    })

    childProcess.on('close', (code) => {
      if (code === 0) {
        resolve(stdout)
      } else {
        reject(
          new Error(
            `Command \`${cmd.join(' ')}\` failed with code ${code}:\n${stdout}\n${stderr}`
          )
        )
      }
    })
  })

/**
 * Executes a command and returns a promise that resolves when the command
 * completes (with the stdout) or rejects with the status code if the command
 * fails. Stdout and stderr are both logged to the console.
 *
 * @param cmd - The command to execute (string or string array)
 * @returns A promise that resolves when the command completes or rejects if the
 * command fails. The stdout of the command is returned as a string.
 */
export const exec = (...cmd: string[]): Promise<string> =>
  execFull({ cmd, log: 'all' })

/**
 * Executes a command and returns a promise that resolves when the command
 * completes (with the stdout) or rejects with the status code if the command
 * fails.
 *
 * @param cmd - The command to execute (string or string array)
 * @returns A promise that resolves when the command completes or rejects if the
 * command fails. The stdout of the command is returned as a string.
 */
export const execSilently = (...cmd: string[]): Promise<string> =>
  execFull({ cmd, log: 'none' })

/**
 * Computes the keccak256 hash of a string and returns it as a hex string.
 *
 * @param str - The string to hash
 * @returns The keccak256 hash of the string as a hex string
 */
export const keccak256 = (str: string): string =>
  Buffer.from(keccak_256(new TextEncoder().encode(str))).toString('hex')

/**
 * Sleep for a number of seconds.
 */
export const sleep = (seconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, seconds * 1_000))

/**
 * Whether or not a network is completely configured.
 */
export const isNetworkComplete = (network: Network): boolean => {
  return (
    !!network.contracts.merkleSnapshot &&
    isAddress(network.contracts.merkleSnapshot) &&
    !!network.contracts.easIndexerResolver &&
    isAddress(network.contracts.easIndexerResolver) &&
    network.schemas.length > 0 &&
    network.schemas.every(
      (schema) => !!schema.uid && schema.uid.startsWith('0x')
    )
  )
}

/**
 * Whether or not a network's safe and zodiac signer sync is completely
 * configured (either it's disabled, or all the contracts are deployed).
 */
export const isNetworkSafeZodiacSignerSyncDisabledOrComplete = (
  network: Network
): boolean => {
  return (
    !network.safeZodiacSignerSync.enabled ||
    (!!network.contracts.safe?.factory &&
      isAddress(network.contracts.safe?.factory) &&
      !!network.contracts.safe?.singleton &&
      isAddress(network.contracts.safe?.singleton) &&
      !!network.contracts.safe?.proxy &&
      isAddress(network.contracts.safe?.proxy) &&
      !!network.contracts.safe?.signerSyncManager &&
      isAddress(network.contracts.safe?.signerSyncManager))
  )
}
