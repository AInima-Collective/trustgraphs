import assert from 'node:assert/strict'

import { type Address, type Hex, decodeFunctionData, keccak256 } from 'viem'

import {
  compositionActivationPayload,
  compositionAdapterPayload,
  compositionCancellationPayload,
  compositionCreateArgs,
  compositionCreatePayload,
  compositionProposalPayload,
  compositionSourceAdapterFactoryAbi,
  trustComposeFactoryAbi,
  trustComposeParamsControllerAbi,
} from './contracts'
import { computeCompositionPreview } from './core'
import { compositionGoldenFixture } from './fixture'
import {
  type CompositionHistoryEvent,
  compositionDeploymentAvailability,
  initialCompositionWorkflow,
  reduceCompositionWorkflow,
  replayCompositionHistory,
  verifyLandedComposition,
} from './workflow'
import { ZERO_ADDRESS, ZERO_HASH } from '../pagerank/words'

const address = (byte: string) => `0x${byte.repeat(20)}` as Address
const word = (byte: string) => `0x${byte.repeat(32)}` as Hex
const config = compositionGoldenFixture()
config.sources.forEach((source, index) => {
  source.adapter = address(`0${index + 1}`)
})
const preview = computeCompositionPreview(config)
const fields = {
  name: 'Governed blend',
  metadataURI: 'ipfs://composition-policy',
  admin: address('ab'),
  epochLength: 1_200n,
  withDistributor: false,
  distributorToken: ZERO_ADDRESS as Address,
  salt: word('55'),
}

const createArgs = compositionCreateArgs(fields, config, preview)
assert.equal(createArgs.params.sourcePolicyRoot, ZERO_HASH)
assert.equal(createArgs.params.sourceCount, 0)
assert.equal(createArgs.params.policyManifestSha256, ZERO_HASH)
assert.equal(createArgs.params.accumulator, ZERO_ADDRESS)
assert.equal(createArgs.params.chainId, 0n)
assert.equal(createArgs.params.maxSourceAgeBlocks, 500_000n)
assert.deepEqual(
  createArgs.sourceAdapters,
  config.sources.map((row) => row.adapter)
)

const createPayload = compositionCreatePayload(fields, config, preview)
const decodedCreate = decodeFunctionData({
  abi: trustComposeFactoryAbi,
  data: createPayload,
})
assert.equal(decodedCreate.functionName, 'createInstance')
assert.equal(
  (decodedCreate.args![0] as any).policyManifest,
  preview.policyManifest
)

const proposalPayload = compositionProposalPayload(config, preview)
const decodedProposal = decodeFunctionData({
  abi: trustComposeParamsControllerAbi,
  data: proposalPayload,
})
assert.equal(decodedProposal.functionName, 'proposePolicy')
assert.equal(decodedProposal.args![0], preview.policyManifest)
assert.deepEqual(
  decodedProposal.args![1],
  config.sources.map((row) => row.adapter)
)

const adapterPayload = compositionAdapterPayload(config.sources[0]!)
const decodedAdapter = decodeFunctionData({
  abi: compositionSourceAdapterFactoryAbi,
  data: adapterPayload,
})
assert.equal(decodedAdapter.functionName, 'create')
assert.deepEqual(decodedAdapter.args, [
  config.sources[0]!.registry,
  config.sources[0]!.instanceId,
  config.sources[0]!.sourceId,
  config.sources[0]!.familyId,
  '0xf96f9891e6ddd310141c323b55c40e1ccf0fcb5560f755b3387240dee7f177a1',
  config.sources[0]!.deploymentProvenance,
])
assert.equal(
  decodeFunctionData({
    abi: trustComposeParamsControllerAbi,
    data: compositionCancellationPayload(),
  }).functionName,
  'cancelPolicy'
)
assert.equal(
  decodeFunctionData({
    abi: trustComposeParamsControllerAbi,
    data: compositionActivationPayload(
      2n,
      preview.policyManifest,
      config.sources.map((row) => row.adapter!)
    ),
  }).functionName,
  'activatePolicy'
)

let workflow = initialCompositionWorkflow()
workflow = reduceCompositionWorkflow(workflow, { type: 'preview', preview })
workflow = reduceCompositionWorkflow(workflow, {
  type: 'simulate',
  payload: createPayload,
  preview,
})
const simulatedHash = workflow.simulatedPayloadHash
workflow = reduceCompositionWorkflow(workflow, { type: 'wallet-rejected' })
assert.equal(workflow.phase, 'simulated')
assert.equal(workflow.simulatedPayloadHash, simulatedHash)
workflow = reduceCompositionWorkflow(workflow, {
  type: 'submit',
  txHash: word('71'),
  payload: createPayload,
})
workflow = reduceCompositionWorkflow(workflow, {
  type: 'confirm',
  blockHash: word('72'),
})
assert.equal(workflow.phase, 'confirmed')
workflow = reduceCompositionWorkflow(workflow, { type: 'reorg' })
assert.equal(workflow.phase, 'previewed')
assert.equal(workflow.simulatedPayloadHash, null)
assert.match(workflow.notice!, /reorg/)
workflow = reduceCompositionWorkflow(workflow, {
  type: 'edit',
  reason: 'source checkpoint refreshed',
})
assert.equal(workflow.phase, 'editing')
assert.equal(workflow.anchor, null)

assert.deepEqual(compositionDeploymentAvailability({ apiAvailable: false }), {
  mode: 'offline',
  canPreview: false,
  canSign: false,
  message:
    'Composition indexing is not deployed yet. Existing network creation remains unchanged.',
})
assert.equal(
  compositionDeploymentAvailability({ apiAvailable: true }).mode,
  'read-only'
)
assert.equal(
  compositionDeploymentAvailability({
    apiAvailable: true,
    factory: address('fa'),
  }).mode,
  'ready'
)

const oldHash = word('10')
const newHash = word('11')
const events: CompositionHistoryEvent[] = [
  {
    id: 'create:1',
    kind: 'create',
    version: 1n,
    blockNumber: 10n,
    blockHash: oldHash,
    transactionIndex: 0,
    logIndex: 0,
  },
  {
    id: 'proposal:2',
    kind: 'propose',
    version: 2n,
    blockNumber: 11n,
    blockHash: newHash,
    transactionIndex: 0,
    logIndex: 0,
  },
  {
    id: 'checkpoint:1',
    kind: 'checkpoint',
    version: 1n,
    blockNumber: 11n,
    blockHash: newHash,
    transactionIndex: 1,
    logIndex: 0,
  },
]
let history = replayCompositionHistory(
  events,
  new Map([
    [10n, oldHash],
    [11n, newHash],
  ])
)
assert.equal(history.versions.get(1n), 'active')
assert.equal(history.versions.get(2n), 'pending') // timelock has not elapsed/activated
assert.deepEqual(history.checkpoints, [{ id: 'checkpoint:1', version: 1n }])

events.push({
  id: 'activate:2',
  kind: 'activate',
  version: 2n,
  blockNumber: 12n,
  blockHash: word('12'),
  transactionIndex: 0,
  logIndex: 0,
})
history = replayCompositionHistory(
  events,
  new Map([
    [10n, oldHash],
    [11n, newHash],
    [12n, word('12')],
  ])
)
assert.equal(history.versions.get(1n), 'superseded')
assert.equal(history.versions.get(2n), 'active')
const reorged = replayCompositionHistory(
  events,
  new Map([
    [10n, oldHash],
    [11n, word('99')],
    [12n, word('12')],
  ])
)
assert.equal(reorged.versions.has(2n), true)
assert.equal(reorged.checkpoints.length, 0)

const landed = verifyLandedComposition(preview, {
  policyManifestSha256: preview.policyManifestSha256,
  captureManifestSha256: preview.captureManifestSha256,
  outputRoot: preview.outputRoot,
  outputBlobSha256: preview.outputBlobSha256,
  outputCid: preview.outputCid,
})
assert.equal(landed.byteIdentical, true)
assert.equal(landed.mismatches.length, 0)
assert.equal(keccak256(createPayload), simulatedHash)

console.log(
  'composition creation/rotation calldata, rejection, delay, refresh, reorg, history, and landed parity: ok'
)
