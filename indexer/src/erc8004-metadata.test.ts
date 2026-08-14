import assert from 'node:assert/strict'
import test from 'node:test'

import {
  ERC8004_METADATA_LIMITS,
  fetchRegistrationDocument,
  isBlockedIp,
  resolvePublicHost,
} from './erc8004-metadata'

const registry = '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432'
const document = (agentRegistry = `eip155:10:${registry.toLowerCase()}`) => ({
  type: 'https://eips.ethereum.org/EIPS/eip-8004#registration-v1',
  name: 'Fixture\u0000 Agent',
  description: 'A local fixture',
  image: 'https://example.com/agent.png',
  services: [{ name: 'A2A', endpoint: 'did:example:fixture', version: '1' }],
  x402Support: false,
  active: true,
  registrations: [{ agentId: 7, agentRegistry }],
  supportedTrust: ['reputation'],
})

const dataUri = (value: unknown) =>
  `data:application/json;base64,${Buffer.from(JSON.stringify(value)).toString('base64')}`

test('private, loopback, link-local, mapped, and reserved addresses are blocked', () => {
  for (const address of [
    '127.0.0.1',
    '10.0.0.1',
    '169.254.169.254',
    '172.16.1.1',
    '192.168.1.1',
    '::1',
    '0:0:0:0:0:0:0:1',
    'fc00::1',
    'fe80::1',
    '::ffff:127.0.0.1',
    '::ffff:7f00:1',
  ]) {
    assert.equal(isBlockedIp(address), true, address)
  }
  assert.equal(isBlockedIp('1.1.1.1'), false)
  assert.equal(isBlockedIp('2606:4700:4700::1111'), false)
})

test('all DNS answers must be public, preventing mixed-answer and redirect SSRF', async () => {
  await assert.rejects(
    resolvePublicHost(new URL('https://example.test/file'), async () => [
      { address: '1.1.1.1', family: 4 },
      { address: '127.0.0.1', family: 4 },
    ]),
    /private, loopback/
  )
})

test('data registration validates backreference and sanitizes presentation strings', async () => {
  const result = await fetchRegistrationDocument({
    uri: dataUri(document()),
    chainId: 10,
    registry,
    agentId: 7n,
    checkEndpoints: false,
  })
  assert.equal(result.status, 'ok')
  assert.equal(result.mutable, false)
  assert.match(result.contentHash!, /^0x[0-9a-f]{64}$/)
  assert.equal(result.document?.name, 'Fixture  Agent')
  assert.equal(result.document?.registrations[0]?.agentId, '7')
})

test('mismatched registration backreferences are retained as invalid observations', async () => {
  const result = await fetchRegistrationDocument({
    uri: dataUri(
      document('eip155:1:0x0000000000000000000000000000000000000001')
    ),
    chainId: 10,
    registry,
    agentId: 7n,
    checkEndpoints: false,
  })
  assert.equal(result.status, 'invalid')
  assert.match(result.error!, /backreference/)
})

test('HTTP and oversized data URIs are refused before network access', async () => {
  const httpResult = await fetchRegistrationDocument({
    uri: 'http://127.0.0.1/agent.json',
    chainId: 10,
    registry,
    agentId: 7n,
    checkEndpoints: false,
  })
  assert.equal(httpResult.status, 'blocked')

  const traversingIpfs = await fetchRegistrationDocument({
    uri: 'ipfs://bafyfixture/%2e%2e/admin',
    chainId: 10,
    registry,
    agentId: 7n,
    checkEndpoints: false,
  })
  assert.equal(traversingIpfs.status, 'blocked')

  const oversized = `data:application/json;base64,${Buffer.alloc(
    ERC8004_METADATA_LIMITS.maxBytes + 1
  ).toString('base64')}`
  const oversizedResult = await fetchRegistrationDocument({
    uri: oversized,
    chainId: 10,
    registry,
    agentId: 7n,
    checkEndpoints: false,
  })
  assert.equal(oversizedResult.status, 'oversized')
})
