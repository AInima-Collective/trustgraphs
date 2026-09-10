import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

test('guest builds freeze every workspace and release mode refuses local or overridden builders', (t) => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'trustgraphs-builder-policy-')
  )
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const log = path.join(directory, 'commands.jsonl')
  fs.writeFileSync(
    path.join(directory, 'cargo'),
    `#!/usr/bin/env node
require('node:fs').appendFileSync(process.env.BUILD_POLICY_LOG, JSON.stringify({args:process.argv.slice(2),image:process.env.SP1_DOCKER_IMAGE})+'\\n')
`,
    { mode: 0o755 }
  )
  for (const command of ['cargo-prove', 'docker']) {
    fs.writeFileSync(path.join(directory, command), '#!/bin/sh\nexit 0\n', {
      mode: 0o755,
    })
  }
  const env = {
    ...process.env,
    PATH: `${directory}:${process.env.PATH}`,
    BUILD_POLICY_LOG: log,
    TRUSTGRAPH_GUEST_BUILD: 'docker',
    TRUSTGRAPHS_RELEASE_BUILD: '1',
    SP1_DOCKER_IMAGE: fs
      .readFileSync('zk/sp1-builder-image.txt', 'utf8')
      .trim(),
  }
  const run = (overrides: NodeJS.ProcessEnv = {}) =>
    spawnSync('sh', ['scripts/build-guests.sh'], {
      encoding: 'utf8',
      env: { ...env, ...overrides },
    })
  const result = run()
  assert.equal(result.status, 0, result.stderr)
  const calls = fs
    .readFileSync(log, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
  const builds = calls.filter((call) => call.args[0] === 'prove')
  const metadata = calls.filter((call) => call.args[0] === 'metadata')
  assert.equal(builds.length, 5)
  assert.equal(metadata.length, 5)
  assert.ok(metadata.every((call) => call.args.includes('--locked')))
  for (const call of builds) {
    assert.deepEqual(call.args.slice(0, 2), ['prove', 'build'])
    assert.ok(call.args.includes('--locked'))
    assert.ok(call.args.includes('--docker'))
    assert.equal(call.image, env.SP1_DOCKER_IMAGE)
  }
  assert.notEqual(run({ TRUSTGRAPH_GUEST_BUILD: 'local' }).status, 0)
  assert.notEqual(run({ SP1_DOCKER_IMAGE: 'untrusted:latest' }).status, 0)
  assert.notEqual(run({ TRUSTGRAPH_GUEST_BUILD: 'typo' }).status, 0)
  assert.equal(
    run({ TRUSTGRAPH_GUEST_BUILD: 'local', TRUSTGRAPHS_RELEASE_BUILD: '0' })
      .status,
    0
  )
})

function guestElfFixture() {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'trustgraphs-guest-elf-policy-')
  )
  const script = path.join(directory, 'scripts/guest-elf-dirs.sh')
  fs.mkdirSync(path.dirname(script), { recursive: true })
  fs.copyFileSync('scripts/guest-elf-dirs.sh', script)
  const binDirectory = path.join(directory, 'bin')
  fs.mkdirSync(binDirectory)
  fs.writeFileSync(
    path.join(binDirectory, 'cargo'),
    `#!/usr/bin/env node
const path = require('node:path')
const args = process.argv.slice(2)
if (args[0] !== 'locate-project' || !args.includes('--workspace')) process.exit(2)
const manifest = args[args.indexOf('--manifest-path') + 1]
if (manifest === process.env.ELF_FIXTURE_FAIL_MANIFEST) process.exit(1)
const workspace = manifest === 'zk/nostr-program/program/Cargo.toml'
  ? 'zk/nostr-program/Cargo.toml'
  : manifest
process.stdout.write(path.resolve(workspace) + '\\n')
`,
    { mode: 0o755 }
  )

  const guests = [
    {
      member: 'zk/program',
      workspace: 'zk/program',
      names: [
        'trustgraph-signer-program',
        'trustgraph-atproto-conformance',
        'trustgraph-hypercerts-program',
        'trustgraph-contributions-program',
      ],
    },
    {
      member: 'zk/trust-graph-program',
      workspace: 'zk/trust-graph-program',
      names: ['trust-graph-program'],
    },
    {
      member: 'zk/weighted-program',
      workspace: 'zk/weighted-program',
      names: ['trustgraph-weighted-program'],
    },
    {
      member: 'zk/composition-program',
      workspace: 'zk/composition-program',
      names: ['trustgraph-compose-program'],
    },
    {
      member: 'zk/nostr-program/program',
      workspace: 'zk/nostr-program',
      names: ['nostr-conformance', 'nostr-workspace'],
    },
  ]
  const expectedFiles: string[] = []
  const elf = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x00])
  for (const guest of guests) {
    const member = path.join(directory, guest.member)
    fs.mkdirSync(member, { recursive: true })
    fs.writeFileSync(
      path.join(member, 'Cargo.toml'),
      '[package]\nname = "fixture-package"\nversion = "0.0.0"\n' +
        guest.names
          .map((name) => `\n[[bin]]\nname = "${name}"\npath = "src/main.rs"\n`)
          .join('')
    )
    if (guest.workspace !== guest.member) {
      fs.writeFileSync(
        path.join(directory, guest.workspace, 'Cargo.toml'),
        '[workspace]\nmembers = ["program"]\n'
      )
    }
    const release = `${guest.workspace}/target/elf-compilation/docker/riscv64im-succinct-zkvm-elf/release`
    fs.mkdirSync(path.join(directory, release), { recursive: true })
    for (const name of guest.names) {
      const file = `${release}/${name}`
      expectedFiles.push(file)
      fs.writeFileSync(path.join(directory, file), elf)
    }
    fs.writeFileSync(path.join(directory, release, 'retired-guest'), elf)
  }

  return {
    directory,
    expectedFiles,
    finalFile: path.join(directory, expectedFiles[expectedFiles.length - 1]!),
    cleanup: () => fs.rmSync(directory, { recursive: true, force: true }),
    run: (args = ['--files'], overrides: NodeJS.ProcessEnv = {}) =>
      spawnSync('sh', [script, ...args], {
        cwd: directory,
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${binDirectory}:${process.env.PATH}`,
          TRUSTGRAPH_GUEST_BUILD: 'docker',
          TRUSTGRAPHS_RELEASE_BUILD: '1',
          ELF_FIXTURE_FAIL_MANIFEST: '',
          ...overrides,
        },
      }),
  }
}

test('guest ELF enumeration lists exactly nine declared targets and ignores stale files', (t) => {
  const fixture = guestElfFixture()
  t.after(fixture.cleanup)
  const result = fixture.run()
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stderr, '')
  assert.equal(fixture.expectedFiles.length, 9)
  assert.equal(result.stdout, [...fixture.expectedFiles].sort().join('\n') + '\n')
})

for (const invalid of ['missing', 'empty', 'non-ELF'] as const) {
  test(`guest ELF enumeration rejects the ${invalid} final target without partial stdout`, (t) => {
    const fixture = guestElfFixture()
    t.after(fixture.cleanup)
    if (invalid === 'missing') fs.unlinkSync(fixture.finalFile)
    else fs.writeFileSync(fixture.finalFile, invalid === 'empty' ? '' : 'not ELF')

    const result = fixture.run()
    assert.equal(result.status, 1)
    assert.equal(result.stdout, '')
    assert.match(
      result.stderr,
      invalid === 'non-ELF' ? /not an ELF:/ : /missing or empty guest ELF:/
    )
    assert.match(result.stderr, /nostr-workspace/)
  })
}

test('guest ELF enumeration fails workspace lookup without partial files or directories', (t) => {
  const fixture = guestElfFixture()
  t.after(fixture.cleanup)
  for (const args of [['--files'], []]) {
    const result = fixture.run(args, {
      ELF_FIXTURE_FAIL_MANIFEST: 'zk/nostr-program/program/Cargo.toml',
    })
    assert.equal(result.status, 1)
    assert.equal(result.stdout, '')
    assert.match(
      result.stderr,
      /cannot locate the workspace for zk\/nostr-program\/program/
    )
  }
})
