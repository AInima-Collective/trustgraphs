#!/usr/bin/env node

'use strict'

const { spawnSync } = require('node:child_process')
const path = require('node:path')

const { loadTargetEnvironment } = require('./load-env.cjs')

const [, , target, command, ...args] = process.argv
if (!target || !command) {
  throw new Error(
    'Usage: node scripts/run-with-target-env.cjs <target> <command> [...args]'
  )
}

loadTargetEnvironment({ repositoryRoot: path.resolve(__dirname, '..'), target })

const child = spawnSync(command, args, {
  stdio: 'inherit',
  env: { ...process.env, TRUSTGRAPHS_TARGET_ENV_LOADED: '1' },
})
if (child.error) throw child.error
if (child.signal) {
  process.kill(process.pid, child.signal)
} else {
  process.exitCode = child.status ?? 1
}
