import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { request as httpRequest } from 'node:http'
import { resolve } from 'node:path'
import test from 'node:test'
import { gzipSync } from 'node:zlib'

import {
  domainSeparator,
  equalBytes,
  headDomain,
  hexToBytes,
  toOwnedArrayBuffer,
  ZERO32,
  type AnchorMessage,
  type LiveNodeHead,
  type SignedAnchorBundle,
} from '@trustgraphs/eas-offchain-client'
import type { Address, Hex } from 'viem'

import { loadConfig } from '../src/config.ts'
import { RelayError } from '../src/errors.ts'
import { IpfsBlockStore } from '../src/ipfs.ts'
import { createRelayServer } from '../src/server.ts'
import { RelaySubmissionService } from '../src/service.ts'
import type {
  BlobStore,
  LaneState,
  RelayChain,
  RelayConfig,
} from '../src/types.ts'

type Manifest = {
  fixturePrivateKey: Hex
  owner: Address
  schemaUid: Hex
  easDomain: { version: string; chainId: string; verifyingContract: Address }
  headDomain: { verifyingContract: Address }
  positive: {
    anchorHistory: Array<{
      payloadHex: Hex
      cid: string
      dataCommitment: Hex
      authorization: {
        message: SignedAnchorBundle['message']
        signature: Hex
      }
    }>
  }
}

const fixture = async (): Promise<{
  manifest: Manifest
  bundle: SignedAnchorBundle
}> => {
  const path = resolve(
    __dirname,
    '../../../tests/fixtures/eas-offchain/v1/manifest.json'
  )
  const manifest = JSON.parse(await readFile(path, 'utf8')) as Manifest
  const first = manifest.positive.anchorHistory[0]!
  return {
    manifest,
    bundle: {
      protocol: 'TrustgraphsEasOffchainBundleV1',
      chainId: manifest.easDomain.chainId,
      registry: manifest.headDomain.verifyingContract,
      eas: {
        address: manifest.easDomain.verifyingContract,
        version: manifest.easDomain.version,
      },
      schemaUid: manifest.schemaUid,
      owner: manifest.owner,
      payloadHex: first.payloadHex,
      cid: first.cid,
      dataCommitment: first.dataCommitment,
      message: first.authorization.message,
      headSignature: first.authorization.signature,
    },
  }
}

class MemoryStore implements BlobStore {
  value?: Uint8Array

  constructor(
    readonly name: string,
    private readonly corrupt = false
  ) {}

  async putAndRead(_cid: string, bytes: Uint8Array): Promise<Uint8Array> {
    this.value = bytes.slice()
    if (!this.corrupt) return this.value.slice()
    const changed = this.value.slice()
    changed[0] = changed[0]! ^ 1
    return changed
  }
}

class FailingStore implements BlobStore {
  constructor(readonly name: string) {}

  async putAndRead(): Promise<Uint8Array> {
    throw new Error('storage target unavailable')
  }
}

type SharedState = {
  live: LiveNodeHead
  anchors: number
  initialLaneCalls: number
  releaseInitial?: () => void
  initialBarrier: Promise<void>
  relayerAttempts: string[]
}

const sharedState = (): SharedState => {
  let releaseInitial: (() => void) | undefined
  return {
    live: { count: 0n, head: ZERO32, dataCommitment: ZERO32 },
    anchors: 0,
    initialLaneCalls: 0,
    initialBarrier: new Promise((resolve) => {
      releaseInitial = resolve
    }),
    releaseInitial,
    relayerAttempts: [],
  }
}

class FakeChain implements RelayChain {
  constructor(
    private readonly shared: SharedState,
    private readonly config: RelayConfig,
    private readonly relayerKeyId: string,
    private readonly waitForRace = false,
    private readonly maximum = 200_000n,
    private readonly latestBlockTimestamp = 1_770_000_060n,
    private readonly reorgAfterReceipt = false
  ) {}

  async lane(_nodeId: Hex): Promise<LaneState> {
    if (this.waitForRace && this.shared.live.count === 0n) {
      this.shared.initialLaneCalls += 1
      if (this.shared.initialLaneCalls === 2) this.shared.releaseInitial?.()
      await this.shared.initialBarrier
    }
    return {
      chainId: this.config.chainId,
      registry: this.config.registry,
      easAddress: this.config.easAddress,
      easVersion: this.config.easVersion,
      schemaUid: this.config.schemaUid,
      easDomainSeparator: domainSeparator({
        name: 'EAS Attestation',
        version: this.config.easVersion,
        chainId: this.config.chainId,
        verifyingContract: this.config.easAddress,
      }),
      headDomainSeparator: domainSeparator(
        headDomain(this.config.chainId, this.config.registry)
      ),
      maxTotalInputs: this.maximum,
      anchorCount: BigInt(this.shared.anchors),
      workCount: this.shared.live.count === 0n ? 0n : 5n,
      lane1LeafCount: 0n,
      latestBlockTimestamp: this.latestBlockTimestamp,
      live: { ...this.shared.live },
    }
  }

  async live(_nodeId: Hex): Promise<LiveNodeHead> {
    return { ...this.shared.live }
  }

  async simulate(
    _bundle: SignedAnchorBundle,
    message: AnchorMessage
  ): Promise<void> {
    if (this.shared.live.count !== 0n || message.previousHead !== ZERO32)
      throw new Error('simulation conflict')
  }

  async anchor(
    _bundle: SignedAnchorBundle,
    message: AnchorMessage
  ): Promise<void> {
    this.shared.relayerAttempts.push(this.relayerKeyId)
    await new Promise((resolve) => setImmediate(resolve))
    if (this.reorgAfterReceipt) return
    if (this.shared.live.count !== 0n) throw new Error('same-count race lost')
    this.shared.live = {
      count: message.count,
      head: message.head,
      dataCommitment: message.dataCommitment,
    }
    this.shared.anchors += 1
  }
}

const relayConfig = (manifest: Manifest): RelayConfig => ({
  chainId: BigInt(manifest.easDomain.chainId),
  registry: manifest.headDomain.verifyingContract,
  relayerAddress: manifest.owner,
  schemaUid: manifest.schemaUid,
  easAddress: manifest.easDomain.verifyingContract,
  easVersion: manifest.easDomain.version,
  allowedNodeIds: new Set(),
  storageQuorum: 2,
  maxBodyBytes: 2_300_000,
  maxPayloadBytes: 1_048_576,
  nodeRequestsPerMinute: 100,
})

const listen = async (
  server: ReturnType<typeof createRelayServer>
): Promise<number> => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string')
    throw new Error('missing test server port')
  return address.port
}

const close = (server: ReturnType<typeof createRelayServer>) =>
  new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve()))
  )

const chunkedPost = async (
  port: number,
  chunks: readonly string[],
  headers: Record<string, string> = {}
): Promise<{ status: number; body: Record<string, any> }> =>
  new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        host: '127.0.0.1',
        port,
        path: '/v1/anchors',
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'transfer-encoding': 'chunked',
          ...headers,
        },
      },
      (response) => {
        const body: Buffer[] = []
        response.on('data', (chunk) => body.push(Buffer.from(chunk)))
        response.on('end', () => {
          resolve({
            status: response.statusCode ?? 0,
            body: JSON.parse(Buffer.concat(body).toString('utf8')),
          })
        })
      }
    )
    request.on('error', reject)
    for (const chunk of chunks) request.write(chunk)
    request.end()
  })

test('runtime derives the public relay identity from the configured private key', async () => {
  const { manifest } = await fixture()
  const runtime = loadConfig({
    RPC_URL: 'https://rpc.example.invalid',
    CHAIN_ID: manifest.easDomain.chainId,
    REGISTRY_ADDRESS: manifest.headDomain.verifyingContract,
    EAS_ADDRESS: manifest.easDomain.verifyingContract,
    EAS_VERSION: manifest.easDomain.version,
    SCHEMA_UID: manifest.schemaUid,
    RELAYER_PRIVATE_KEY: manifest.fixturePrivateKey,
    IPFS_TARGETS_JSON: JSON.stringify([
      { name: 'primary', apiUrl: 'https://ipfs-a.example.invalid' },
      { name: 'secondary', apiUrl: 'https://ipfs-b.example.invalid' },
    ]),
  })
  assert.equal(runtime.relay.relayerAddress, manifest.owner)
})

test('two clean relay deployments with distinct relayer keys and stores converge on one result', async () => {
  const { manifest, bundle } = await fixture()
  const config = relayConfig(manifest)
  const shared = sharedState()
  const storesA = [new MemoryStore('a-primary'), new MemoryStore('a-secondary')]
  const storesB = [new MemoryStore('b-primary'), new MemoryStore('b-secondary')]
  const relayA = new RelaySubmissionService(
    config,
    new FakeChain(shared, config, 'key-a', true),
    storesA
  )
  const relayB = new RelaySubmissionService(
    config,
    new FakeChain(shared, config, 'key-b', true),
    storesB
  )
  const serverA = createRelayServer({
    service: relayA,
    maxBodyBytes: config.maxBodyBytes,
    allowedOrigins: new Set(),
  })
  const serverB = createRelayServer({
    service: relayB,
    maxBodyBytes: config.maxBodyBytes,
    allowedOrigins: new Set(),
  })
  const [portA, portB] = await Promise.all([listen(serverA), listen(serverB)])
  try {
    const responses = await Promise.all(
      [portA, portB].map((port) =>
        fetch(`http://127.0.0.1:${port}/v1/anchors`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(bundle),
        })
      )
    )
    assert.deepEqual(
      responses.map((response) => response.status),
      [200, 200]
    )
    const [resultA, resultB] = await Promise.all(
      responses.map((response) => response.json())
    )
    assert.deepEqual(resultA, resultB)
    assert.equal(shared.anchors, 1)
    assert.deepEqual(
      new Set(shared.relayerAttempts),
      new Set(['key-a', 'key-b'])
    )
    const expected = hexToBytes(bundle.payloadHex)
    for (const store of [...storesA, ...storesB]) {
      assert.ok(store.value)
      assert.equal(equalBytes(store.value, expected), true)
    }
    const metrics = (await (
      await fetch(`http://127.0.0.1:${portA}/metrics`)
    ).json()) as Record<string, unknown>
    assert.equal(metrics.storageQuorumRequired, 2)
    assert.equal(metrics.storageTargetCount, 2)
    assert.equal(metrics.storageExactSuccesses, 2)
    assert.equal(metrics.relayerLagEntries, '0')
    assert.equal(metrics.newestAnchorCount, '1')
    assert.equal(metrics.chainId, manifest.easDomain.chainId)
    assert.equal(metrics.registry, manifest.headDomain.verifyingContract)
    assert.equal(metrics.relayerAddress, manifest.owner)
    assert.equal(metrics.easAddress, manifest.easDomain.verifyingContract)
    assert.equal(metrics.easVersion, manifest.easDomain.version)
    assert.equal(metrics.schemaUid, manifest.schemaUid)
  } finally {
    await Promise.all([close(serverA), close(serverB)])
  }
})

test('same-count forks are visible reload conflicts and are never stored', async () => {
  const { manifest, bundle } = await fixture()
  const config = relayConfig(manifest)
  const shared = sharedState()
  shared.live = {
    count: 1n,
    head: `0x${'12'.repeat(32)}`,
    dataCommitment: `0x${'34'.repeat(32)}`,
  }
  const stores = [new MemoryStore('primary'), new MemoryStore('secondary')]
  const service = new RelaySubmissionService(
    config,
    new FakeChain(shared, config, 'key'),
    stores
  )
  await assert.rejects(
    service.submit(bundle),
    (error: unknown) =>
      error instanceof RelayError &&
      error.code === 'SAME_COUNT_FORK' &&
      error.action === 'reload' &&
      error.details?.canonical !== undefined
  )
  assert.equal(
    stores.every((store) => store.value === undefined),
    true
  )
})

test('projected work and byte-exact storage quorum fail before anchoring', async () => {
  const { manifest, bundle } = await fixture()
  const config = relayConfig(manifest)
  const capacityState = sharedState()
  const capacityStores = [
    new MemoryStore('primary'),
    new MemoryStore('secondary'),
  ]
  const capacityService = new RelaySubmissionService(
    config,
    new FakeChain(capacityState, config, 'key', false, 4n),
    capacityStores
  )
  await assert.rejects(
    capacityService.submit(bundle),
    (error: unknown) =>
      error instanceof RelayError && error.code === 'PROJECTED_WORK'
  )
  assert.equal(capacityState.anchors, 0)
  assert.equal(
    capacityStores.every((store) => store.value === undefined),
    true
  )

  const storageState = sharedState()
  const storageService = new RelaySubmissionService(
    config,
    new FakeChain(storageState, config, 'key'),
    [new MemoryStore('primary'), new MemoryStore('corrupt', true)]
  )
  await assert.rejects(
    storageService.submit(bundle),
    (error: unknown) =>
      error instanceof RelayError && error.code === 'STORAGE_QUORUM'
  )
  assert.equal(storageState.anchors, 0)
})

test('one failed pin still succeeds with an exact independent quorum', async () => {
  const { manifest, bundle } = await fixture()
  const config = relayConfig(manifest)
  const state = sharedState()
  const stores = [
    new MemoryStore('primary'),
    new FailingStore('unavailable'),
    new MemoryStore('secondary'),
  ]
  const service = new RelaySubmissionService(
    config,
    new FakeChain(state, config, 'key'),
    stores
  )
  const result = await service.submit(bundle)
  assert.equal(result.status, 'anchored')
  assert.equal(state.anchors, 1)
  assert.equal(service.metrics().storageExactSuccesses, 2)
})

test('future signed time is rejected before storage or anchoring', async () => {
  const { manifest, bundle } = await fixture()
  const config = relayConfig(manifest)
  const state = sharedState()
  const stores = [new MemoryStore('primary'), new MemoryStore('secondary')]
  const service = new RelaySubmissionService(
    config,
    new FakeChain(state, config, 'key', false, 200_000n, 1_769_999_999n),
    stores
  )
  await assert.rejects(
    service.submit(bundle),
    (error: unknown) =>
      error instanceof Error &&
      error.name === 'EasOffchainError' &&
      'code' in error &&
      error.code === 'E0_FUTURE_TIME'
  )
  assert.equal(state.anchors, 0)
  assert.equal(
    stores.every((store) => store.value === undefined),
    true
  )
})

test('an RPC reorg after a receipt is retryable and never reported as anchored', async () => {
  const { manifest, bundle } = await fixture()
  const config = relayConfig(manifest)
  const state = sharedState()
  const stores = [new MemoryStore('primary'), new MemoryStore('secondary')]
  const service = new RelaySubmissionService(
    config,
    new FakeChain(state, config, 'key', false, 200_000n, 1_770_000_060n, true),
    stores
  )
  await assert.rejects(
    service.submit(bundle),
    (error: unknown) =>
      error instanceof RelayError &&
      error.code === 'ANCHOR_UNCONFIRMED' &&
      error.retryable &&
      error.action === 'retry'
  )
  assert.equal(state.anchors, 0)
  assert.equal(
    stores.every((store) => store.value !== undefined),
    true,
    'the recoverable exact bundle remains pinned for retry'
  )
})

test('body limits reject declared and chunked bombs and compression before parsing', async () => {
  const { manifest } = await fixture()
  const config = relayConfig(manifest)
  const state = sharedState()
  const service = new RelaySubmissionService(
    config,
    new FakeChain(state, config, 'key'),
    [new MemoryStore('primary'), new MemoryStore('secondary')]
  )
  const server = createRelayServer({
    service,
    maxBodyBytes: 64,
    allowedOrigins: new Set(),
  })
  const port = await listen(server)
  try {
    const declared = await fetch(`http://127.0.0.1:${port}/v1/anchors`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ payload: 'x'.repeat(256) }),
    })
    assert.equal(declared.status, 413)
    assert.equal(((await declared.json()) as any).error.code, 'BODY_LIMIT')

    const chunked = await chunkedPost(port, [
      '{"payload":"',
      'x'.repeat(256),
      '"}',
    ])
    assert.equal(chunked.status, 413)
    assert.equal(chunked.body.error.code, 'BODY_LIMIT')

    const compressed = await chunkedPost(
      port,
      [gzipSync('{}').toString('binary')],
      {
        'content-encoding': 'gzip',
      }
    )
    assert.equal(compressed.status, 415)
    assert.equal(compressed.body.error.code, 'CONTENT_ENCODING')
    assert.equal(state.anchors, 0)
  } finally {
    await close(server)
  }
})

test('malformed JSON and per-node rate exhaustion return stable public errors', async () => {
  const { manifest, bundle } = await fixture()
  const config = { ...relayConfig(manifest), nodeRequestsPerMinute: 1 }
  const state = sharedState()
  const service = new RelaySubmissionService(
    config,
    new FakeChain(state, config, 'key'),
    [new MemoryStore('primary'), new MemoryStore('secondary')]
  )
  const server = createRelayServer({
    service,
    maxBodyBytes: config.maxBodyBytes,
    allowedOrigins: new Set(),
  })
  const port = await listen(server)
  try {
    const malformed = await fetch(`http://127.0.0.1:${port}/v1/anchors`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{',
    })
    assert.equal(malformed.status, 400)
    assert.equal(((await malformed.json()) as any).error.code, 'INVALID_JSON')

    const first = await fetch(`http://127.0.0.1:${port}/v1/anchors`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(bundle),
    })
    assert.equal(first.status, 200)
    const limited = await fetch(`http://127.0.0.1:${port}/v1/anchors`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(bundle),
    })
    assert.equal(limited.status, 429)
    const body = (await limited.json()) as any
    assert.equal(body.error.code, 'RATE_LIMITED')
    assert.equal(body.error.retryable, true)
    assert.equal(body.error.action, 'retry')
  } finally {
    await close(server)
  }
})

test('Kubo target uses a pinned raw block and performs byte-exact block/get readback', async () => {
  const { bundle } = await fixture()
  const bytes = hexToBytes(bundle.payloadHex)
  const calls: URL[] = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (
    input: string | URL | Request,
    init?: RequestInit
  ) => {
    const url = new URL(input instanceof Request ? input.url : input.toString())
    calls.push(url)
    assert.equal(
      new Headers(init?.headers).get('authorization'),
      'Bearer test-secret'
    )
    if (url.pathname.endsWith('/block/put')) {
      assert.equal(url.searchParams.get('cid-codec'), 'raw')
      assert.equal(url.searchParams.get('mhtype'), 'sha2-256')
      assert.equal(url.searchParams.get('mhlen'), '32')
      assert.equal(url.searchParams.get('pin'), 'true')
      const file = (init?.body as FormData).get('file')
      assert.ok(file instanceof Blob)
      assert.equal(
        equalBytes(new Uint8Array(await file.arrayBuffer()), bytes),
        true
      )
      return new Response(
        JSON.stringify({ Key: bundle.cid, Size: bytes.length }),
        { status: 200 }
      )
    }
    assert.equal(url.pathname.endsWith('/block/get'), true)
    assert.equal(url.searchParams.get('arg'), bundle.cid)
    return new Response(toOwnedArrayBuffer(bytes), {
      status: 200,
      headers: { 'content-type': 'application/vnd.ipld.raw' },
    })
  }) as typeof fetch
  try {
    const store = new IpfsBlockStore({
      name: 'kubo-test',
      apiUrl: 'https://ipfs.example.invalid',
      authHeader: 'Bearer test-secret',
    })
    assert.equal(
      equalBytes(await store.putAndRead(bundle.cid, bytes), bytes),
      true
    )
    assert.equal(calls.length, 2)
  } finally {
    globalThis.fetch = originalFetch
  }
})
