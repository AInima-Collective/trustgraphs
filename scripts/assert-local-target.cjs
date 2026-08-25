#!/usr/bin/env node

const path = require('node:path')

const { loadTargetEnvironment } = require('./load-env.cjs')

const repositoryRoot = path.resolve(__dirname, '..')
const { environment, target } = loadTargetEnvironment({ repositoryRoot })
const stage = environment.DEPLOY_STAGE?.trim().toLowerCase() || 'development'

if (target !== 'local' || stage !== 'development') {
  throw new Error(
    `Local demo tasks require development/local, resolved ${stage}/${target}. ` +
      'Unset the public DEPLOY_TARGET (and DEPLOY_STAGE) before running the demo.'
  )
}
