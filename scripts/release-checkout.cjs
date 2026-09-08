// Shared by preflight and the public deployment entrypoint. No network or environment loading.
const { execFileSync } = require('node:child_process')
const path = require('node:path')

const RELEASE_INPUTS = [
  'contracts',
  'crates',
  'zk',
  'scripts',
  'config',
  'lib',
  '.github',
  'foundry.toml',
  'remappings.txt',
  'Cargo.toml',
  'Cargo.lock',
  'rust-toolchain',
  'rust-toolchain.toml',
  '.cargo',
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'patches',
  'taskfile',
  'Taskfile.yml',
]

function assertReleaseCheckout(commit, root = path.resolve(__dirname, '..')) {
  if (typeof commit !== 'string' || !/^[a-f0-9]{40}$/i.test(commit)) {
    throw new Error('DEPLOYMENT_COMMIT must be the exact 40-hex release commit')
  }
  const git = (...args) =>
    execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' })
  const head = git('rev-parse', 'HEAD').trim()
  if (head !== commit.toLowerCase()) {
    throw new Error(
      `Release checkout mismatch: HEAD is ${head}, DEPLOYMENT_COMMIT is ${commit}`
    )
  }
  const dirty = git(
    'status',
    '--porcelain=v1',
    '-z',
    '--untracked-files=all',
    '--',
    ...RELEASE_INPUTS
  )
  if (dirty) {
    throw new Error(
      `Release build inputs differ from ${head}: ${dirty.split('\0').filter(Boolean).join(', ')}`
    )
  }
  return head
}

module.exports = { assertReleaseCheckout }

if (require.main === module) {
  try {
    console.log(assertReleaseCheckout(process.env.DEPLOYMENT_COMMIT))
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
