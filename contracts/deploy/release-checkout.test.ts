import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { assertReleaseCheckout } from '../../scripts/release-checkout.cjs'

test('public deployment requires the exact commit and unchanged build inputs', (t) => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'trustgraphs-release-checkout-')
  )
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim()
  git('init', '-q')
  git('config', 'user.name', 'Release test')
  git('config', 'user.email', 'test@example.invalid')
  fs.mkdirSync(path.join(root, 'contracts'))
  const input = path.join(root, 'contracts', 'Contract.sol')
  fs.writeFileSync(input, 'contract Contract {}\n')
  git('add', '.')
  git('commit', '-qm', 'fixture')
  const commit = git('rev-parse', 'HEAD')
  assert.equal(assertReleaseCheckout(commit, root), commit)
  assert.throws(
    () => assertReleaseCheckout('aa'.repeat(20), root),
    /checkout mismatch/
  )
  assert.throws(() => assertReleaseCheckout('not a commit', root), /40-hex/)
  fs.writeFileSync(input, 'contract Changed {}\n')
  assert.throws(
    () => assertReleaseCheckout(commit, root),
    /build inputs differ/
  )
  git('add', '.')
  assert.throws(
    () => assertReleaseCheckout(commit, root),
    /build inputs differ/
  )
  git('reset', '--hard', 'HEAD')
  fs.writeFileSync(
    path.join(root, 'contracts', 'Injected.sol'),
    'contract Injected {}\n'
  )
  assert.throws(() => assertReleaseCheckout(commit, root), /Injected.sol/)
  fs.unlinkSync(path.join(root, 'contracts', 'Injected.sol'))
  fs.mkdirSync(path.join(root, 'deployments'))
  fs.writeFileSync(path.join(root, 'deployments', 'receipt.json'), '{}')
  assert.equal(
    assertReleaseCheckout(commit, root),
    commit,
    'deployment outputs are not build inputs'
  )
})
